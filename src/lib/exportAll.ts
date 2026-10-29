import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import {
  backgroundStatus,
  exportAllNative,
  isBackgroundAvailable,
  readArchiveInfo,
  readDeviceSnapshot,
  readNativeEvents,
  type ArchiveInfo,
  type DeviceSnapshot,
  type ExportTotals,
  type MonitorStatus,
} from './backgroundMonitor';
import { learnHabit, learnLatency, type SleepHabit } from './habit';
import type { RawEvent } from './rawEvents';
import { readLog } from './triggerLog';
import { APP_VERSION } from './updater';
import type {
  AppState,
  MonitorSettings,
  SleepSession,
  TriggerEvent,
} from './types';

/**
 * Exportación única.
 *
 * Un solo archivo con todo lo que la app sabe del móvil y de tus noches, para
 * poder enviarlo de una vez. Los botones antiguos (historial CSV/JSON, registro
 * bruto) siguen existiendo en «Exportar avanzado» (`exportSessions.ts`).
 *
 * ## Esquema (versión 1)
 *
 * Un único objeto JSON. Las claves van siempre en este orden, y las tres
 * últimas listas son las grandes (en el APK las escribe el servicio nativo en
 * flujo, línea a línea, sin cargar el histórico en memoria):
 *
 * ```
 * {
 *   "meta":     { format: "perfectrest-export", version: 1, app, appVersion,
 *                 exportedAt (ms), exportedAtIso, timezone, tzOffsetMin, locale,
 *                 device { model, manufacturer, android, sdk },
 *                 range { from, to },            // ms, de lo más antiguo a lo más nuevo
 *                 archive { enabled, events, readings, bytes, from, to } | null,
 *                 notes: [...] },                // avisos de lo que no pudo incluirse
 *   "settings": { enabled, minGapMinutes, maxGapMinutes, nightStart, nightEnd, autoConfirm,
 *                 wakeSummary, background, triggers{}, sensors{}, saveContext,
 *                 keepHistory, allSensors },
 *   "habit":    { startMin, endMin, n, spreadMin?, latencyMin } | null,
 *   "device":   { info, state, sensors, permissions, service },   // instantánea de ahora
 *   "pendingSessions": [ ...propuestas sin confirmar... ],
 *   "triggerLog": [ ...registro de la detección y del algoritmo (últimos 200)... ],
 *   "sensorInventory": [ ...getSensorList(TYPE_ALL), sin ids únicos... ],
 *   "sessions": [ ...todas las noches, por inicio, con nota, detectedStart/End,
 *                 inferred y contexto completo; también las que la app ya podó... ],
 *   "rawEvents": [ {at, kind, v?} ... ],            // TODO el registro bruto archivado
 *   "sensorReadings": [ {at, kind:"sensors", ms, s:{<sensor>:{n,mean[],min[],max[],sd[]}}} ... ],
 *   "totals":   { sessions, rawEvents, sensorReadings, sensorsInInventory }
 * }
 * ```
 *
 * El tamaño de `rawEvents` y `sensorReadings` es el del archivo histórico; si
 * la estimación supera ~6 MB el archivo se entrega comprimido (`.json.gz`).
 * Los tipos de `rawEvents` están en `rawEvents.ts`. Nunca hay ubicación, SSID,
 * nombres de dispositivos, apps ni notificaciones.
 */

export const EXPORT_FORMAT = 'perfectrest-export';
export const EXPORT_FORMAT_VERSION = 1;

/** Ajustes del monitor que se exportan (sin `contextSince`, que es un detalle interno). */
export function exportSettings(m: MonitorSettings): Record<string, unknown> {
  return {
    enabled: m.enabled,
    minGapMinutes: m.minGapMinutes,
    maxGapMinutes: m.maxGapMinutes,
    nightStart: m.nightStart,
    nightEnd: m.nightEnd,
    autoConfirm: m.autoConfirm,
    wakeSummary: m.wakeSummary,
    background: m.background,
    triggers: m.triggers,
    sensors: m.sensors,
    saveContext: m.saveContext,
    keepHistory: m.keepHistory,
    allSensors: m.allSensors,
  };
}

export interface ExportInput {
  now: number;
  state: Pick<AppState, 'sessions' | 'pendingSessions' | 'monitor' | 'schedule'>;
  snapshot: DeviceSnapshot | null;
  status: MonitorStatus | null;
  archive: { enabled: boolean; info: ArchiveInfo } | null;
  triggerLog: TriggerEvent[];
  locale?: string;
  tz?: string;
}

export interface ExportHead {
  meta: Record<string, unknown>;
  settings: Record<string, unknown>;
  habit: (SleepHabit & { latencyMin: number | null }) | null;
  device: Record<string, unknown>;
  pendingSessions: SleepSession[];
  triggerLog: TriggerEvent[];
}

/** Todo menos las listas grandes: es lo que se pasa al servicio para que escriba el resto. */
export function buildExportHead(input: ExportInput): ExportHead {
  const { now, state, snapshot, status, archive } = input;
  const sessions = state.sessions;

  const times: number[] = [];
  for (const s of sessions) times.push(s.start, s.end);
  if (archive?.info.from) times.push(archive.info.from);
  if (archive?.info.to) times.push(archive.info.to);
  if (archive?.info.readingsFrom) times.push(archive.info.readingsFrom);
  if (archive?.info.readingsTo) times.push(archive.info.readingsTo);

  const d = snapshot?.device ?? {};
  const habit = learnHabit(sessions, state.schedule, now);
  const notes: string[] = [];
  if (!isBackgroundAvailable()) {
    notes.push('Sin servicio nativo (navegador): no hay registro bruto, lecturas ni inventario de sensores.');
  } else if (!archive?.enabled) {
    notes.push('«Conservar histórico» está apagado: el registro bruto sólo llega hasta lo que guarda el anillo reciente.');
  }

  return {
    meta: {
      format: EXPORT_FORMAT,
      version: EXPORT_FORMAT_VERSION,
      app: 'PerfectRest',
      appVersion: APP_VERSION,
      exportedAt: now,
      exportedAtIso: new Date(now).toISOString(),
      timezone: d.tz ?? input.tz ?? null,
      tzOffsetMin: -new Date(now).getTimezoneOffset(),
      locale: d.locale ?? input.locale ?? null,
      device: {
        model: d.model ?? null,
        manufacturer: d.manufacturer ?? null,
        android: d.release ?? null,
        sdk: d.sdk ?? null,
      },
      range: times.length ? { from: Math.min(...times), to: Math.max(...times) } : null,
      archive: archive
        ? {
            enabled: archive.enabled,
            events: archive.info.events,
            readings: archive.info.readings,
            bytes: archive.info.bytes,
            from: archive.info.from || null,
            to: archive.info.to || null,
          }
        : null,
      notes,
    },
    settings: exportSettings(state.monitor),
    habit: { ...habit, latencyMin: learnLatency(sessions) },
    device: {
      info: snapshot?.device ?? null,
      state: snapshot?.state ?? null,
      sensors: snapshot?.sensors ?? null,
      sensorsNeverRead: snapshot?.sensorsExcluded ?? null,
      permissions: snapshot?.permissions ?? null,
      service: status
        ? {
            running: status.running,
            batteryExempt: status.batteryExempt,
            notifications: status.notifications,
            exactAlarms: status.exactAlarms,
            startedAt: status.startedAt || null,
            lastError: status.lastError,
          }
        : null,
    },
    pendingSessions: state.pendingSessions,
    triggerLog: input.triggerLog,
  };
}

/**
 * El documento completo en memoria. Sólo para el navegador, sin archivo
 * histórico (las listas grandes vienen vacías o del anillo); en el APK nunca
 * se construye: lo escribe el servicio en flujo.
 */
export function buildExportDocument(
  head: ExportHead,
  sessions: SleepSession[],
  rawEvents: RawEvent[],
  inventory: Array<Record<string, unknown>> = [],
  readings: unknown[] = [],
): Record<string, unknown> {
  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  const events = [...rawEvents].sort((a, b) => a.at - b.at);
  const totals: ExportTotals = {
    sessions: sorted.length,
    rawEvents: events.length,
    sensorReadings: readings.length,
    sensorsInInventory: inventory.length,
  };
  return {
    ...head,
    sensorInventory: inventory,
    sessions: sorted,
    rawEvents: events,
    sensorReadings: readings,
    totals,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface ExportResult {
  name: string;
  bytes: number;
  gzip: boolean;
  totals: ExportTotals;
}

/**
 * Genera y entrega el archivo único. En el APK lo escribe el servicio en la
 * caché (en flujo, sin cargar el histórico en memoria) y se comparte con la
 * misma hoja de compartir que el resto de exportaciones; en el navegador se
 * construye en memoria y se descarga.
 */
export async function exportEverything(state: AppState, now: number = Date.now()): Promise<ExportResult> {
  const [snapshot, status, archive, triggerLog] = await Promise.all([
    readDeviceSnapshot(),
    backgroundStatus(),
    readArchiveInfo(),
    mergedTriggerLog(),
  ]);
  let locale: string | undefined;
  let tz: string | undefined;
  try {
    locale = navigator.language;
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* sin Intl: el servicio aporta lo suyo */
  }
  const head = buildExportHead({
    now,
    state,
    snapshot,
    status: isBackgroundAvailable() ? status : null,
    archive,
    triggerLog,
    locale,
    tz,
  });
  const base = `perfectrest-todo-${stamp(now)}`;

  if (isBackgroundAvailable()) {
    const out = await exportAllNative({
      name: `${base}.json`,
      head: JSON.stringify(head),
      sessions: JSON.stringify(state.sessions),
    });
    if (!out) throw new Error('El servicio nativo no está disponible');
    // El archivo está en la caché de la app; `Filesystem.getUri` da su ruta para compartirlo.
    const { uri } = await Filesystem.getUri({ path: out.name, directory: Directory.Cache });
    await Share.share({ title: 'Exportación completa de PerfectRest', files: [uri], dialogTitle: 'Exportación completa' });
    return out;
  }

  // Navegador: sin servicio no hay registro bruto ni lecturas que incluir.
  const doc = buildExportDocument(head, state.sessions, []);
  const json = JSON.stringify(doc, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { name: `${base}.json`, bytes: json.length, gzip: false, totals: doc.totals as ExportTotals };
}

/** Registro de la detección: el guardado en la app más lo que el servicio tenga y la app aún no. */
async function mergedTriggerLog(): Promise<TriggerEvent[]> {
  const [stored, native] = await Promise.all([readLog(), readNativeEvents()]);
  const seen = new Set(stored.map((e) => `${e.at}|${e.trigger ?? '-'}|${e.kind}|${e.detail ?? ''}`));
  const extra = native.filter((e) => !seen.has(`${e.at}|${e.trigger ?? '-'}|${e.kind}|${e.detail ?? ''}`));
  return [...stored, ...extra].sort((a, b) => a.at - b.at);
}
