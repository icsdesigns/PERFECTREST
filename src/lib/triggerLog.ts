import { loadJSON, saveJSON } from './storage';
import { formatClock, formatDuration } from './time';
import { TRIGGER_SHORT } from './triggers';
import type { TriggerEvent, TriggerEventKind, TriggerId } from './types';

/**
 * Registro de la detección.
 *
 * El problema que resuelve: los disparadores no fallan con un error. Si el
 * servicio no arrancó, si Android lo mató de madrugada, si el permiso de
 * alarmas exactas se retiró o si simplemente esa noche no llegó ningún evento,
 * el resultado es siempre el mismo —ninguna sesión propuesta— y desde fuera no
 * hay manera de distinguir un caso de otro. Antes de esto, «la app no detecta
 * nada» era un callejón sin salida: no había dónde mirar.
 *
 * Aquí queda constancia de cada señal recibida, de cada hueco encolado y de
 * cada descarte con su motivo. Dos fuentes escriben en él:
 *
 *   - el servicio nativo, que anota lo que ocurre con la app cerrada y lo
 *     entrega al abrirla (los eventos vienen marcados con `native: true`);
 *   - la capa web, que anota lo que decide con esos huecos.
 *
 * Se guardan juntos y ordenados por hora, porque lo que se quiere leer es la
 * historia completa de una noche, no dos listas que hay que cruzar a mano.
 */

const LOG_KEY = 'perfectrest.triggerLog';

/** Tope del registro. Cubre varios días y no crece sin fin. */
export const MAX_LOG = 200;

/**
 * Clave de identidad de un evento. El registro nativo no se vacía al leerse
 * —para que un cierre inesperado no pierda la noche— así que los mismos
 * eventos llegan varias veces y hay que reconocerlos.
 */
function keyOf(e: TriggerEvent): string {
  return `${e.at}|${e.trigger ?? '-'}|${e.kind}|${e.detail ?? ''}`;
}

/**
 * Funde eventos nuevos en el registro: descarta los repetidos, ordena de más
 * reciente a más antiguo y recorta al tope.
 *
 * Es una función pura a propósito: es la parte con lógica de verdad y así se
 * puede comprobar sin tocar el almacenamiento ni el dispositivo.
 */
export function appendEvents(
  log: TriggerEvent[],
  incoming: TriggerEvent[],
  max: number = MAX_LOG,
): TriggerEvent[] {
  if (!incoming.length) return log;

  const seen = new Set(log.map(keyOf));
  const merged = [...log];
  for (const event of incoming) {
    const key = keyOf(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }

  // Empates por milisegundo: el evento nativo va primero, porque describe la
  // señal del dispositivo y el de la web la decisión que se tomó con ella.
  merged.sort((a, b) => b.at - a.at || Number(b.native ?? false) - Number(a.native ?? false));
  return merged.slice(0, max);
}

export async function readLog(): Promise<TriggerEvent[]> {
  return loadJSON<TriggerEvent[]>(LOG_KEY, []);
}

export async function writeLog(log: TriggerEvent[]): Promise<void> {
  await saveJSON(LOG_KEY, log);
}

/**
 * Añade eventos al registro persistido y devuelve el resultado.
 *
 * El registro nativo no se vacía al leerse, así que Ajustes lo vuelca entero
 * cada pocos segundos y casi siempre sin novedades. Por eso sólo se escribe
 * cuando algo ha cambiado de verdad: si no, la pantalla de diagnóstico
 * reescribiría el almacenamiento en bucle mientras está abierta.
 */
export async function pushEvents(incoming: TriggerEvent[]): Promise<TriggerEvent[]> {
  const current = await readLog();
  if (!incoming.length) return current;

  const merged = appendEvents(current, incoming);
  if (merged.length === current.length && merged.every((e, i) => keyOf(e) === keyOf(current[i]))) {
    return current;
  }

  await writeLog(merged);
  return merged;
}

/** Atajo para un único evento de la capa web. */
export async function logEvent(
  trigger: TriggerId | null,
  kind: TriggerEventKind,
  detail?: string,
  at: number = Date.now(),
): Promise<void> {
  await pushEvents([{ at, trigger, kind, detail, native: false }]);
}

export async function clearLog(): Promise<void> {
  await writeLog([]);
}

/** Etiqueta corta de cada tipo de evento, para la lista de Ajustes. */
export const EVENT_LABEL: Record<TriggerEventKind, string> = {
  open: 'empieza la inactividad',
  close: 'vuelves al móvil',
  gap: 'hueco registrado',
  discard: 'descartado',
  detect: 'sesión propuesta',
  service: 'servicio',
  error: 'fallo',
};

/** Tono del indicador: verde lo que avanza, ámbar lo que se descarta, rojo el fallo. */
export function eventTone(kind: TriggerEventKind): 'mint' | 'amber' | 'rose' | 'primary' | 'muted' {
  switch (kind) {
    case 'detect':
      return 'mint';
    case 'gap':
      return 'primary';
    case 'discard':
      return 'amber';
    case 'error':
      return 'rose';
    default:
      return 'muted';
  }
}

/** Una línea legible: «07:10 · pantalla · vuelves al móvil — tras 7h 50m». */
export function describeEvent(e: TriggerEvent): string {
  const who = e.trigger ? (TRIGGER_SHORT[e.trigger] ?? e.trigger) : 'servicio';
  const what = EVENT_LABEL[e.kind];
  const base = `${formatClock(e.at)} · ${who} · ${what}`;
  return e.detail ? `${base} — ${e.detail}` : base;
}

/**
 * Resumen del registro para responder de un vistazo a «¿esto funciona?».
 *
 * Interesa sobre todo `lastSignalAt`: si hace días que no llega ninguna señal
 * del dispositivo, el problema no es que no se duerma, es que el servicio no
 * está escuchando.
 */
export interface LogSummary {
  total: number;
  /** Última señal real del dispositivo (open/close), sea del disparador que sea. */
  lastSignalAt: number | null;
  /** Cuántos disparadores distintos han dado señales de vida. */
  activeTriggers: TriggerId[];
  /** Último fallo anotado, si lo hay. */
  lastError: TriggerEvent | null;
  gaps: number;
  detections: number;
}

export function summarizeLog(log: TriggerEvent[]): LogSummary {
  const signals = log.filter((e) => e.kind === 'open' || e.kind === 'close');
  const triggers = new Set<TriggerId>();
  for (const e of signals) if (e.trigger) triggers.add(e.trigger);

  return {
    total: log.length,
    lastSignalAt: signals.length ? Math.max(...signals.map((e) => e.at)) : null,
    activeTriggers: [...triggers],
    lastError: log.find((e) => e.kind === 'error') ?? null,
    gaps: log.filter((e) => e.kind === 'gap').length,
    detections: log.filter((e) => e.kind === 'detect').length,
  };
}

/** Texto del descarte de un hueco, para que el motivo quede por escrito. */
export function discardReason(gapMs: number, reason: string): string {
  return `${formatDuration(gapMs)} · ${reason}`;
}
