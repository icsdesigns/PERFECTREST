import {
  backgroundStatus,
  isBackgroundAvailable,
  readDeviceSnapshot,
  readNativeEvents,
  readRawEvents,
} from './backgroundMonitor';
import { buildContext, buildDevice } from './sessionContext';
import { APP_VERSION } from './updater';
import type { SensorId, SessionContext, SleepSession } from './types';

/**
 * Recoge el contexto de varias noches de una vez.
 *
 * Lee el registro bruto, el registro del servicio y la instantánea del
 * dispositivo una sola vez y resume cada sesión con ellos. Es la parte
 * asíncrona de `sessionContext.ts`, que es pura: aquí viven las llamadas al
 * plugin, y por eso se queda fuera de las pruebas sin dispositivo.
 *
 * Degrada sin quejarse: en el navegador no hay servicio y el contexto sólo
 * lleva la zona horaria, el idioma y la traza del algoritmo; con un plugin
 * antiguo que no conoce `getDeviceSnapshot` falta el modelo del móvil y poco más.
 */
export async function collectContexts(
  sessions: SleepSession[],
  options: { sensorsOn: SensorId[]; now?: number },
): Promise<Record<string, SessionContext>> {
  const now = options.now ?? Date.now();
  const out: Record<string, SessionContext> = {};
  if (!sessions.length) return out;

  const [events, nativeLog, snapshot, status] = await Promise.all([
    readRawEvents(),
    readNativeEvents(),
    readDeviceSnapshot(),
    backgroundStatus(),
  ]);
  const native = isBackgroundAvailable();

  let locale: string | undefined;
  let tz: string | undefined;
  try {
    locale = navigator.language;
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* sin Intl ni navigator: se quedan sin idioma ni zona */
  }

  for (const s of sessions) {
    out[s.id] = buildContext({
      start: s.start,
      end: s.end,
      events,
      now,
      sensorsOn: options.sensorsOn,
      device: buildDevice({
        start: s.start,
        appVersion: APP_VERSION,
        snapshot,
        locale,
        tz,
        status: native
          ? {
              batteryExempt: status.batteryExempt,
              exactAlarms: status.exactAlarms,
              notifications: status.notifications,
            }
          : null,
      }),
      nativeLog: native ? nativeLog : undefined,
      previous: s.context,
    });
  }
  return out;
}
