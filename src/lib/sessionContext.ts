import { DAY, MINUTE, formatDuration } from './time';
import { TRIGGER_SHORT } from './triggers';
import { SENSOR_BY_ID } from './sensors';
import {
  LIGHT_BRIGHT,
  LIGHT_DARK,
  LIGHT_DIM,
  POSTURE_FLAT_DOWN,
  POSTURE_FLAT_UP,
  POSTURE_CARRIED,
  POSTURE_TILTED,
  type RawEvent,
  type RawKind,
} from './rawEvents';
import type { DetectionResult } from './activityMonitor';
import type { SleepHabit } from './habit';
import type {
  ContextAlgo,
  ContextDevice,
  SensorId,
  SessionContext,
  SleepSession,
  StateSummary,
  TriggerEvent,
} from './types';

/**
 * Contexto del dispositivo de cada noche.
 *
 * Para perfeccionar la detección hace falta saber qué hacía el móvil cuando se
 * acertó o se falló una noche: ¿estaba cargando?, ¿en modo avión?, ¿sonó la
 * alarma?, ¿cuántas veces se encendió la pantalla? Esto resume el registro
 * bruto del servicio en una instantánea pequeña por sesión, con el tramo
 * [inicio − 30 min, fin + 30 min] y el estado al inicio y al final.
 *
 * Reglas de privacidad, que este módulo cumple por construcción: sólo
 * agregados (conteos, mínimos, máximos, porcentajes) y alguna lista corta de
 * duraciones; nada de ubicación, SSID, nombres de dispositivos Bluetooth,
 * contenido de notificaciones, nombres de apps ni identificadores. Todo se
 * calcula y se guarda en el móvil.
 *
 * Es código puro: recibe el registro bruto y devuelve el resumen, así que se
 * prueba sin dispositivo (`scripts/precisioncheck.ts`).
 */

export const CONTEXT_VERSION = 1;
/** Margen alrededor de la sesión que también se resume. */
export const CONTEXT_PAD_MS = 30 * MINUTE;
/** Cuántos contextos se conservan (los de las noches más recientes). */
export const MAX_CONTEXTS = 120;
/** Un contexto más viejo que esto se suelta aunque quepa. */
export const MAX_CONTEXT_AGE_MS = 365 * DAY;
/** Tope de tamaño de un contexto serializado; por encima se descarta al cargar. */
export const MAX_CONTEXT_BYTES = 8_000;
/** Hasta cuándo hay registro bruto del que recalcular una noche. */
export const RAW_REACH_MS = 3 * DAY;

const MAX_USES = 20;
const MAX_TIMELINE = 40;
/** Un audio sin su evento de parada se da por sonando este rato (igual que en `rawEvents.ts`). */
const AUDIO_HOLD_MS = 15 * MINUTE;
/** El registro empieza como mucho esto después del tramo para darlo por completo. */
const COVERAGE_SLACK_MS = 10 * MINUTE;

// --- Lectura del registro bruto ----------------------------------------------

type ByKind = Map<RawKind, RawEvent[]>;

function groupByKind(events: RawEvent[]): ByKind {
  const map: ByKind = new Map();
  for (const e of events) {
    const list = map.get(e.kind);
    if (list) list.push(e);
    else map.set(e.kind, [e]);
  }
  for (const list of map.values()) list.sort((a, b) => a.at - b.at);
  return map;
}

/** Último valor anotado hasta `t` (incluido); null si no hay ninguno. */
function valueAt(list: RawEvent[] | undefined, t: number): number | null {
  if (!list) return null;
  let value: number | null = null;
  for (const e of list) {
    if (e.at > t) break;
    value = e.v ?? 0;
  }
  return value;
}

/**
 * Resume una serie de estados: valor al inicio y al final de la sesión,
 * cuántas veces cambió en el tramo y, para los discretos, qué porcentaje del
 * tramo pasó con cada valor. El valor se mantiene hasta el evento siguiente.
 * Sólo cuenta el tiempo en que el valor se conoce.
 */
export function summarizeState(
  list: RawEvent[] | undefined,
  from: number,
  to: number,
  start: number,
  end: number,
  discrete: boolean,
): StateSummary | undefined {
  if (!list || !list.length || to <= from) return undefined;

  let cur = valueAt(list, from);
  let t = from;
  let changes = 0;
  let seen = cur !== null;
  const dur = new Map<number, number>();
  let min = cur ?? Infinity;
  let max = cur ?? -Infinity;

  for (const e of list) {
    if (e.at <= from || e.at > to) continue;
    const v = e.v ?? 0;
    if (cur !== null) {
      dur.set(cur, (dur.get(cur) ?? 0) + (e.at - t));
      if (v !== cur) changes++;
    }
    cur = v;
    t = e.at;
    seen = true;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  if (!seen) return undefined;
  if (cur !== null) dur.set(cur, (dur.get(cur) ?? 0) + (to - t));

  const out: StateSummary = {
    start: valueAt(list, start),
    end: valueAt(list, end),
    changes,
  };
  if (!discrete) {
    out.min = min;
    out.max = max;
  } else {
    const known = [...dur.values()].reduce((a, b) => a + b, 0);
    if (known > 0) {
      const pct: Record<string, number> = {};
      for (const [value, ms] of dur) {
        const p = Math.round((100 * ms) / known);
        if (p > 0) pct[String(value)] = p;
      }
      out.pct = pct;
    }
  }
  return out;
}

// --- Pantalla ------------------------------------------------------------------

/** Un desbloqueo anotado un poco antes del encendido sigue siendo de ese encendido. */
const UNLOCK_SLACK_MS = 5_000;

function summarizeScreen(
  by: ByKind,
  from: number,
  to: number,
  start: number,
  end: number,
): SessionContext['screen'] | undefined {
  const ons = by.get('screen-on') ?? [];
  const offs = by.get('screen-off') ?? [];
  const unlockList = by.get('unlock') ?? [];
  if (!ons.length && !offs.length && !unlockList.length) return undefined;

  const state = [...ons.map((e) => ({ at: e.at, on: true })), ...offs.map((e) => ({ at: e.at, on: false }))].sort(
    (a, b) => a.at - b.at,
  );
  const stateAt = (t: number): boolean | null => {
    let v: boolean | null = null;
    for (const s of state) {
      if (s.at > t) break;
      v = s.on;
    }
    return v;
  };

  // Tramos de pantalla encendida dentro del tramo analizado. Un encendido ya
  // en curso al empezar el tramo no cuenta como encendido nuevo.
  const stints: Array<{ on: number; off: number; fresh: boolean }> = [];
  let openAt: number | null = stateAt(from) ? from : null;
  let openFresh = false;
  for (const s of state) {
    if (s.at <= from || s.at > to) continue;
    if (s.on) {
      if (openAt === null) {
        openAt = s.at;
        openFresh = true;
      }
    } else if (openAt !== null) {
      stints.push({ on: openAt, off: s.at, fresh: openFresh });
      openAt = null;
      openFresh = false;
    }
  }
  if (openAt !== null) stints.push({ on: openAt, off: to, fresh: openFresh });

  const unlocks = unlockList.filter((e) => e.at >= from && e.at <= to).map((e) => e.at);
  const unlocked = (s: { on: number; off: number }) =>
    unlocks.some((u) => u >= s.on - UNLOCK_SLACK_MS && u <= s.off);

  const fresh = stints.filter((s) => s.fresh);
  const used = stints.filter(unlocked);
  const useMs = used.map((s) => s.off - s.on);

  return {
    ons: fresh.length,
    unlocks: unlocks.length,
    glances: fresh.filter((s) => !unlocked(s)).length,
    nightUnlocks: unlocks.filter((u) => u >= start && u <= end).length,
    nightOns: fresh.filter((s) => s.on >= start && s.on <= end).length,
    useSec: Math.round(useMs.reduce((a, b) => a + b, 0) / 1000),
    usesSec: useMs.slice(0, MAX_USES).map((ms) => Math.round(ms / 1000)),
    longestSec: Math.round(Math.max(0, ...useMs) / 1000),
    onAtStart: stateAt(start),
    onAtEnd: stateAt(end),
  };
}

// --- Audio, luz y demás sensores --------------------------------------

function summarizeAudio(
  by: ByKind,
  from: number,
  to: number,
): NonNullable<NonNullable<SessionContext['sensors']>['audio']> | undefined {
  const list = by.get('audio');
  if (!list || !list.length) return undefined;
  let playingMs = 0;
  let starts = 0;
  let playing: number | null = (valueAt(list, from) ?? 0) > 0 ? from : null;
  let lastOn = playing ?? from;
  const close = (t: number) => {
    if (playing === null) return;
    playingMs += Math.max(0, Math.min(t, lastOn + AUDIO_HOLD_MS, to) - playing);
    playing = null;
  };
  for (const e of list) {
    if (e.at <= from || e.at > to) continue;
    if ((e.v ?? 0) > 0) {
      if (playing === null) {
        playing = e.at;
        starts++;
      }
      lastOn = e.at;
    } else close(e.at);
  }
  close(to);
  return { playingPct: Math.round((100 * playingMs) / Math.max(1, to - from)), starts };
}

function summarizeSensors(
  by: ByKind,
  from: number,
  to: number,
  start: number,
  end: number,
  on: SensorId[],
): NonNullable<SessionContext['sensors']> {
  const out: NonNullable<SessionContext['sensors']> = { on };
  const has = (id: SensorId) => on.includes(id);
  const inRange = (e: RawEvent) => e.at >= from && e.at <= to;

  if (has('steps')) {
    out.steps = {
      steps: (by.get('steps') ?? []).filter(inRange).reduce((a, e) => a + (e.v ?? 0), 0),
      motions: (by.get('motion') ?? []).filter(inRange).length,
    };
  }
  if (has('light')) {
    const light = summarizeState(by.get('light'), from, to, start, end, true);
    if (light) {
      const lux = (by.get('lux') ?? []).filter(inRange).map((e) => e.v ?? 0);
      out.light = {
        pct: {
          dark: light.pct?.[String(LIGHT_DARK)] ?? 0,
          dim: light.pct?.[String(LIGHT_DIM)] ?? 0,
          bright: light.pct?.[String(LIGHT_BRIGHT)] ?? 0,
        },
        ...(lux.length ? { luxMin: Math.min(...lux), luxMax: Math.max(...lux) } : {}),
        changes: light.changes,
      };
    }
  }
  if (has('posture')) {
    const readings = (by.get('posture') ?? []).filter(inRange);
    if (readings.length) {
      const count = (...vals: number[]) => readings.filter((e) => vals.includes(e.v ?? -1)).length;
      out.posture = {
        readings: readings.length,
        flatPct: Math.round((100 * count(POSTURE_FLAT_UP, POSTURE_FLAT_DOWN)) / readings.length),
        carried: count(POSTURE_CARRIED),
        tilted: count(POSTURE_TILTED),
      };
    }
  }
  // El audio se consulta sin escuchar nada: se resume siempre que el servicio
  // lo haya anotado, esté o no activo como sensor.
  const audio = summarizeAudio(by, from, to);
  if (audio) out.audio = audio;
  return out;
}

// --- Línea de tiempo ---------------------------------------------------------

/** Eventos que merece la pena recordar uno a uno; el resto sólo cuenta en los agregados. */
const NOTABLE: ReadonlySet<RawKind> = new Set<RawKind>([
  'unlock', 'plug', 'unplug', 'chg-type',
]);

function timeline(events: RawEvent[], from: number, to: number, start: number): SessionContext['timeline'] {
  return events
    .filter((e) => NOTABLE.has(e.kind) && e.at >= from && e.at <= to)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_TIMELINE)
    .map((e) => {
      const minutes = Math.round((e.at - start) / MINUTE);
      return e.v === undefined
        ? ([minutes, e.kind] as [number, string])
        : ([minutes, e.kind, e.v] as [number, string, number]);
    });
}

// --- Construcción ----------------------------------------------------------------

export interface ContextInput {
  start: number;
  end: number;
  /** Registro bruto del servicio, en cualquier orden. */
  events: RawEvent[];
  /** Instante de la recogida (para no mirar más allá del presente). */
  now: number;
  /** Sensores de detección que el usuario tiene activos. */
  sensorsOn: SensorId[];
  device?: ContextDevice;
  algo?: ContextAlgo;
  /** Registro de eventos del servicio (arranques, muertes, errores). */
  nativeLog?: TriggerEvent[];
  /** Contexto previo: se conserva su traza del algoritmo si no llega una nueva. */
  previous?: SessionContext;
}

/** Resume una noche. Sin eventos devuelve igualmente un contexto, marcado como parcial. */
export function buildContext(input: ContextInput): SessionContext {
  const { start, end, events, now, sensorsOn } = input;
  const from = start - CONTEXT_PAD_MS;
  const to = Math.min(end + CONTEXT_PAD_MS, now);

  const by = groupByKind(events);
  const earliest = events.length ? Math.min(...events.map((e) => e.at)) : Infinity;
  const ctx: SessionContext = {
    v: CONTEXT_VERSION,
    collected: now,
    from,
    to,
    span: { start, end },
  };
  if (earliest > from + COVERAGE_SLACK_MS) ctx.partial = true;

  const device = input.device;
  if (device) ctx.device = device;
  const algo = input.algo ?? input.previous?.algo;
  if (algo) ctx.algo = algo;

  if (to > from) {
    const screen = summarizeScreen(by, from, to, start, end);
    if (screen) ctx.screen = screen;

    // Enchufado: lo que diga el tipo de carga; si no hay, los eventos de enchufar y desenchufar.
    const chg = by.get('chg-type');
    const plugEvents = [
      ...(by.get('plug') ?? []).map((e) => ({ at: e.at, kind: 'plug' as RawKind, v: 1 })),
      ...(by.get('unplug') ?? []).map((e) => ({ at: e.at, kind: 'unplug' as RawKind, v: 0 })),
    ].sort((a, b) => a.at - b.at);
    const chargeType = summarizeState(chg, from, to, start, end, true);
    let chargingPct: number | null = null;
    if (chg && chg.length) {
      if (chargeType?.pct) chargingPct = 100 - (chargeType.pct['0'] ?? 0);
    } else {
      const plugSeries = summarizeState(plugEvents, from, to, start, end, true);
      if (plugSeries?.pct) chargingPct = plugSeries.pct['1'] ?? 0;
    }
    const plugs = (by.get('plug') ?? []).filter((e) => e.at >= from && e.at <= to).length;
    const unplugs = (by.get('unplug') ?? []).filter((e) => e.at >= from && e.at <= to).length;
    if (chargeType || plugs || unplugs || plugEvents.length) {
      ctx.power = {
        plugs,
        unplugs,
        chargingPct,
        ...(chargeType ? { chargeType } : {}),
      };
    }


    ctx.sensors = summarizeSensors(by, from, to, start, end, sensorsOn);
    if (input.nativeLog) {
      const inRange = input.nativeLog.filter((e) => e.at >= from && e.at <= to);
      ctx.service = {
        restarts: inRange.filter((e) => e.kind === 'service' && /detenido por el sistema/.test(e.detail ?? '')).length,
        errors: inRange.filter((e) => e.kind === 'error').length,
      };
    }
    const tl = timeline(events, from, to, start);
    if (tl && tl.length) ctx.timeline = tl;
  }
  return ctx;
}

// --- Datos del aparato -------------------------------------------------------------

export interface DeviceInput {
  /** Inicio de la sesión: de él sale el desfase horario (cambia con el horario de verano). */
  start: number;
  /** Versión de la app según la compilación web. */
  appVersion: string;
  /** Lo que respondió el servicio nativo; null en el navegador o con un plugin antiguo. */
  snapshot?: {
    device?: Record<string, unknown>;
    sensors?: Record<string, { available?: boolean } | undefined>;
  } | null;
  /** Idioma y zona de la capa web, por si el servicio no las da. */
  locale?: string;
  tz?: string;
  /** Estado del servicio: exención de batería, alarmas exactas y notificaciones. */
  status?: { batteryExempt: boolean; exactAlarms: boolean; notifications: boolean } | null;
}

const text = (x: unknown, max = 64): string | undefined =>
  typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : undefined;
const int = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : undefined;

/**
 * Datos estáticos del móvil y de la app. Copia sólo campos conocidos y de la
 * forma esperada, así que lo que devuelva un plugin raro no entra tal cual.
 * Nunca lleva identificadores ni nombres (ni de red, ni de Bluetooth).
 */
export function buildDevice(input: DeviceInput): ContextDevice {
  const d = input.snapshot?.device ?? {};
  const out: ContextDevice = {
    app: text(d.app) ?? input.appVersion,
    // El desfase de la zona en el momento de dormirse, no el de ahora.
    tzOffsetMin: -new Date(input.start).getTimezoneOffset(),
  };
  const model = text(d.model);
  if (model) out.model = model;
  const manufacturer = text(d.manufacturer);
  if (manufacturer) out.manufacturer = manufacturer;
  const sdk = int(d.sdk);
  if (sdk !== undefined) out.sdk = sdk;
  const release = text(d.release, 16);
  if (release) out.release = release;
  const locale = text(d.locale, 24) ?? text(input.locale, 24);
  if (locale) out.locale = locale;
  const tz = text(d.tz, 48) ?? text(input.tz, 48);
  if (tz) out.tz = tz;

  const sensors = input.snapshot?.sensors;
  if (sensors) {
    const has: Record<string, boolean> = {};
    for (const [id, v] of Object.entries(sensors)) {
      if (v && typeof v.available === 'boolean') has[id] = v.available;
    }
    if (Object.keys(has).length) out.hasSensors = has;
  }
  if (input.status) {
    out.batteryExempt = input.status.batteryExempt;
    out.exactAlarms = input.status.exactAlarms;
    out.notifications = input.status.notifications;
  }
  return out;
}

// --- Traza del algoritmo ---------------------------------------------------------

export interface AlgoInput {
  /** La detección tal como salió de la evaluación. */
  result: DetectionResult;
  /** La sesión ya refinada, que es la que se propone. */
  refined: SleepSession;
  /** Hábito aprendido en ese momento. */
  habit?: SleepHabit | null;
  /** Latencia que se sumó al inicio y de dónde salió. */
  latencyMin?: number;
  latencySource?: 'learned' | 'settings';
  /** Sensores de detección activos. */
  sensors: SensorId[];
}

/** Cómo llegó el algoritmo a esta propuesta: lo que se guarda para perfeccionarlo. */
export function buildAlgo(input: AlgoInput): ContextAlgo {
  const { result, refined, habit } = input;
  const ev = result.evidence;
  const startRef = refined.detectedStart ?? refined.start;
  const endRef = refined.detectedEnd ?? refined.end;
  const out: ContextAlgo = {
    triggers: refined.triggers ?? [],
    confidence: refined.confidence,
    inferred: !!refined.inferred,
    sensors: input.sensors,
  };
  if (refined.nap) out.nap = true;
  if (result.score !== undefined) out.score = Math.round(result.score * 100) / 100;
  if (result.gapMs > 0) out.gapMin = Math.round(result.gapMs / MINUTE);
  out.startShiftMin = Math.round((refined.start - startRef) / MINUTE);
  out.endShiftMin = Math.round((refined.end - endRef) / MINUTE);
  if (input.latencyMin !== undefined) {
    out.latencyMin = Math.round(input.latencyMin * 10) / 10;
    if (input.latencySource) out.latencySource = input.latencySource;
  }
  if (habit) {
    out.habit = {
      startMin: Math.round(habit.startMin),
      endMin: Math.round(habit.endMin),
      n: habit.n,
      ...(habit.spreadMin !== undefined ? { spreadMin: Math.round(habit.spreadMin) } : {}),
    };
  }
  if (ev && ev.sensors.length) {
    out.evidence = {
      activityAt: ev.activityAt,
      wakeAt: ev.wakeAt,
      dark: ev.dark === null ? null : Math.round(ev.dark * 100) / 100,
      moves: ev.moves,
      flat: ev.flat === null ? null : Math.round(ev.flat * 100) / 100,
      litFlat: ev.litFlat === null ? null : Math.round(ev.litFlat * 100) / 100,
    };
  }
  if (result.discards?.length) {
    out.discards = result.discards.map((d) => ({
      reason: d.reason,
      startMin: Math.round((d.start - refined.start) / MINUTE),
      endMin: Math.round((d.end - refined.start) / MINUTE),
    }));
  }
  return out;
}

/** Contexto mínimo de una propuesta: sólo cómo se llegó a ella, antes de recoger nada del dispositivo. */
export function contextFromAlgo(algo: ContextAlgo): SessionContext {
  return { v: CONTEXT_VERSION, algo };
}

// --- Cuándo recoger, migrar y limpiar -------------------------------------------

/**
 * ¿Hay que (re)calcular el contexto de esta sesión?
 *
 *  - Si no tiene la parte del dispositivo.
 *  - Si se recogió con el tramo aún sin terminar (a la hora de despertar, con
 *    la media hora posterior por llegar) y ya ha pasado.
 *  - Si se corrigieron el inicio o el final y el registro bruto aún alcanza.
 *
 * Nunca para noches que acabaron antes de `since` (el usuario borró los
 * contextos o reactivó el ajuste) ni para las que el registro ya no cubre.
 */
export function needsContext(s: SleepSession, now: number, since: number): boolean {
  if (s.end <= since) return false;
  if (now - s.end > RAW_REACH_MS) return false;
  const c = s.context;
  if (!c || c.collected === undefined || !c.span) return true;
  const finished = c.to !== undefined && c.to >= c.span.end + CONTEXT_PAD_MS;
  if (!finished && now >= s.end + CONTEXT_PAD_MS) return true;
  return c.span.start !== s.start || c.span.end !== s.end;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** Descarta un contexto guardado que no tenga la forma esperada o sea desmesurado. */
export function sanitizeContext(raw: unknown): SessionContext | undefined {
  if (!isRecord(raw) || typeof raw.v !== 'number' || !Number.isFinite(raw.v)) return undefined;
  try {
    if (JSON.stringify(raw).length > MAX_CONTEXT_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return raw as unknown as SessionContext;
}

/**
 * Política de limpieza: sólo se conservan los contextos de las
 * `MAX_CONTEXTS` noches más recientes y de menos de un año. Las sesiones en sí
 * no se tocan. Devuelve el mismo array si no hay nada que soltar.
 */
export function pruneContexts(sessions: SleepSession[], now: number = Date.now()): SleepSession[] {
  const withContext = sessions.filter((s) => s.context).sort((a, b) => b.end - a.end);
  const keep = new Set(
    withContext.filter((s, i) => i < MAX_CONTEXTS && now - s.end <= MAX_CONTEXT_AGE_MS).map((s) => s.id),
  );
  if (keep.size === withContext.length) return sessions;
  return sessions.map((s) => {
    if (!s.context || keep.has(s.id)) return s;
    const { context: _dropped, ...rest } = s;
    return rest;
  });
}

/** Una sesión leída del almacenamiento: contexto saneado y sin campos desconocidos rotos. */
export function migrateSession(s: SleepSession): SleepSession {
  if (s.context === undefined) return s;
  const context = sanitizeContext(s.context);
  if (context) return context === s.context ? s : { ...s, context };
  const { context: _bad, ...rest } = s;
  return rest;
}

/** Quita el contexto a todas las sesiones. */
export function stripContexts(sessions: SleepSession[]): SleepSession[] {
  return sessions.map((s) => {
    if (!s.context) return s;
    const { context: _dropped, ...rest } = s;
    return rest;
  });
}

// --- Exportación a CSV -------------------------------------------------------------

type Cell = string | number | undefined;

const join = (xs: Array<string | number> | undefined) => (xs && xs.length ? xs.join('|') : undefined);
const num = (n: number | null | undefined): number | undefined => (n === null || n === undefined ? undefined : n);
const flag = (b: boolean | null | undefined): number | undefined => (b === null || b === undefined ? undefined : b ? 1 : 0);

/** Columnas del CSV de sesiones para el contexto, en orden fijo. */
export const CONTEXT_COLUMNS = [
  'ctx_parcial', 'ctx_modelo', 'ctx_android', 'ctx_app', 'ctx_zona', 'ctx_desfase_min', 'ctx_idioma',
  'pantalla_encendidos', 'pantalla_desbloqueos', 'pantalla_vistazos', 'pantalla_micro_despertares',
  'pantalla_uso_s', 'pantalla_uso_max_s', 'pantalla_usos_s', 'pantalla_encendida_inicio', 'pantalla_encendida_fin',
  'carga_pct', 'enchufes', 'desenchufes', 'carga_tipo_inicio', 'carga_tipo_fin',
  'luz_oscuro_pct', 'lux_min', 'lux_max', 'pasos', 'movimientos',
  'postura_lecturas', 'postura_plano_pct', 'audio_pct',
  'servicio_reinicios', 'servicio_errores',
  'algo_disparadores', 'algo_confianza', 'algo_inferida', 'algo_puntuacion', 'algo_hueco_min',
  'algo_latencia_min', 'algo_latencia_origen', 'algo_habito_inicio_min', 'algo_habito_noches', 'algo_descartes',
] as const;

export type ContextColumn = (typeof CONTEXT_COLUMNS)[number];

/** Aplana un contexto en una fila: los agregados útiles, no el JSON entero (ése va en el JSON). */
export function flattenContext(ctx: SessionContext | undefined): Partial<Record<ContextColumn, Cell>> {
  if (!ctx) return {};
  const d = ctx.device;
  const scr = ctx.screen;
  const pow = ctx.power;
  const sen = ctx.sensors;
  const a = ctx.algo;
  return {
    ctx_parcial: flag(ctx.partial ?? false),
    ctx_modelo: d?.model,
    ctx_android: d?.sdk,
    ctx_app: d?.app,
    ctx_zona: d?.tz,
    ctx_desfase_min: d?.tzOffsetMin,
    ctx_idioma: d?.locale,
    pantalla_encendidos: scr?.ons,
    pantalla_desbloqueos: scr?.unlocks,
    pantalla_vistazos: scr?.glances,
    pantalla_micro_despertares: scr?.nightUnlocks,
    pantalla_uso_s: scr?.useSec,
    pantalla_uso_max_s: scr?.longestSec,
    pantalla_usos_s: join(scr?.usesSec),
    pantalla_encendida_inicio: flag(scr?.onAtStart),
    pantalla_encendida_fin: flag(scr?.onAtEnd),
    carga_pct: num(pow?.chargingPct),
    enchufes: pow?.plugs,
    desenchufes: pow?.unplugs,
    carga_tipo_inicio: num(pow?.chargeType?.start),
    carga_tipo_fin: num(pow?.chargeType?.end),
    luz_oscuro_pct: sen?.light?.pct.dark,
    lux_min: sen?.light?.luxMin,
    lux_max: sen?.light?.luxMax,
    pasos: sen?.steps?.steps,
    movimientos: sen?.steps?.motions,
    postura_lecturas: sen?.posture?.readings,
    postura_plano_pct: sen?.posture?.flatPct,
    audio_pct: sen?.audio?.playingPct,
    servicio_reinicios: ctx.service?.restarts,
    servicio_errores: ctx.service?.errors,
    algo_disparadores: join(a?.triggers),
    algo_confianza: a?.confidence,
    algo_inferida: flag(a?.inferred),
    algo_puntuacion: a?.score,
    algo_hueco_min: a?.gapMin,
    algo_latencia_min: a?.latencyMin,
    algo_latencia_origen: a?.latencySource,
    algo_habito_inicio_min: a?.habit ? Math.round(a.habit.startMin) : undefined,
    algo_habito_noches: a?.habit?.n,
    algo_descartes: join(a?.discards?.map((x) => x.reason)),
  };
}

// --- Texto para la hoja de sesión -------------------------------------------------

export interface ContextSection {
  title: string;
  rows: Array<{ label: string; value: string }>;
}

const CHARGE_TEXT: Record<number, string> = {
  0: 'sin cargar',
  1: 'cargador de pared',
  2: 'USB',
  3: 'inalámbrica',
  4: 'base',
};
const CONFIDENCE_TEXT = { high: 'alta', medium: 'media', low: 'baja' } as const;
/** Motivos de descarte de un hueco, en corto (los largos están en `activityMonitor.ts`). */
const DISCARD_TEXT: Record<string, string> = {
  'trigger-off': 'disparador apagado',
  implausible: 'fuera de la ventana nocturna o corto',
  'too-long': 'demasiado largo para una noche',
  'out-of-pattern': 'hueco corto fuera de tu hora',
  secondary: 'ya había una noche principal',
};
/** Minutos con signo: «+15 min», «−5 min», «0 min». */
const signedMin = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n))} min`;
/** «UTC+2», «UTC−3:30»; undefined si el desfase no es un número. */
function utc(offset: unknown): string | undefined {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return undefined;
  const a = Math.abs(Math.round(offset));
  return `UTC${offset >= 0 ? '+' : '−'}${Math.floor(a / 60)}${a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''}`;
}

function hm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
/**
 * Duración legible: «45 s», «2 min 5 s», «1 h 2 min». Con espacios que no
 * parten, para que una lista larga de usos no corte «5» de su «s» a 320 px.
 */
function secs(s: number): string {
  const nb = '\u00a0';
  if (s < 60) return `${s}${nb}s`;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}${nb}h${nb}${m}${nb}min` : `${h}${nb}h`;
  }
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}${nb}min${nb}${r}${nb}s` : `${m}${nb}min`;
}
const yesNo = (b: boolean | null | undefined) => (b === null || b === undefined ? undefined : b ? 'sí' : 'no');
const pct = (n: number | undefined | null) => (n === undefined || n === null ? undefined : `${n} %`);

/** «de X a Y» con el texto de cada código; «X» si no cambió; undefined si no se conoce. */
function fromTo(s: StateSummary | undefined, text: (v: number) => string): string | undefined {
  if (!s) return undefined;
  const a = s.start === null ? undefined : text(s.start);
  const b = s.end === null ? undefined : text(s.end);
  if (a && b) return a === b ? a : `${a} → ${b}`;
  return a ?? b;
}


/**
 * El contexto en frases para la hoja de sesión. Defensivo a propósito: lo
 * guardado puede venir de otra versión de la app, y un campo que falta o tiene
 * otra forma sólo debe dejar una fila sin mostrar, nunca romper la hoja.
 */
export function describeContext(ctx: SessionContext | undefined): ContextSection[] {
  if (!ctx) return [];
  try {
    const sections: ContextSection[] = [];
    const add = (title: string, rows: Array<[string, string | undefined]>) => {
      const kept = rows.filter((r): r is [string, string] => r[1] !== undefined && r[1] !== '');
      if (kept.length) sections.push({ title, rows: kept.map(([label, value]) => ({ label, value })) });
    };

    const d = ctx.device;
    add('Aparato', [
      ['Modelo', d?.model ? [d.manufacturer, d.model].filter(Boolean).join(' ') : undefined],
      ['Android', d?.release ? `${d.release}${d.sdk ? ` (API ${d.sdk})` : ''}` : d?.sdk ? `API ${d.sdk}` : undefined],
      ['Versión de la app', d?.app],
      ['Zona horaria', d?.tz ? (utc(d.tzOffsetMin) ? `${d.tz} (${utc(d.tzOffsetMin)})` : d.tz) : undefined],
      ['Idioma', d?.locale],
      ['Exención de batería', yesNo(d?.batteryExempt)],
      ['Alarmas exactas', yesNo(d?.exactAlarms)],
    ]);

    const s = ctx.screen;
    add('Pantalla', [
      ['Encendidos', s ? String(s.ons) : undefined],
      ['Desbloqueos', s ? String(s.unlocks) : undefined],
      ['Encendidos sin desbloquear', s ? String(s.glances) : undefined],
      ['Micro-despertares durante la noche', s ? `${s.nightUnlocks} desbloqueos, ${s.nightOns} encendidos` : undefined],
      ['Uso total', s && s.useSec ? secs(s.useSec) : s ? '0 s' : undefined],
      ['Cada uso', s && s.usesSec.length ? s.usesSec.map(secs).join(', ') : undefined],
      ['Encendida al dormirte / al despertar', s ? `${yesNo(s.onAtStart) ?? '?'} / ${yesNo(s.onAtEnd) ?? '?'}` : undefined],
    ]);

    const p = ctx.power;
    add('Carga', [
      ['Tiempo enchufado', pct(p?.chargingPct)],
      ['Enchufado / desenchufado', p ? `${p.plugs} / ${p.unplugs}` : undefined],
      ['Tipo de carga', fromTo(p?.chargeType, (v) => CHARGE_TEXT[v] ?? `código ${v}`)],
    ]);

    const n = ctx.sensors;
    add('Sensores', [
      ['Activos para detectar', n ? (n.on.length ? n.on.map((id) => SENSOR_BY_ID[id]?.label ?? id).join(', ') : 'ninguno') : undefined],
      ['Pasos / movimiento', n?.steps ? `${n.steps.steps} pasos, ${n.steps.motions} avisos de movimiento` : undefined],
      ['Luz', n?.light ? `oscuro ${n.light.pct.dark} %, tenue ${n.light.pct.dim} %, claro ${n.light.pct.bright} %${n.light.luxMax !== undefined ? ` (${n.light.luxMin}–${n.light.luxMax} lux)` : ''}` : undefined],
      ['Postura del móvil', n?.posture ? `${n.posture.readings} lecturas, plano ${n.posture.flatPct} %` : undefined],
      ['Audio sonando', n?.audio ? `${n.audio.playingPct} % del tiempo` : undefined],
    ]);

    add('Servicio', [
      ['Reinicios por el sistema', ctx.service ? String(ctx.service.restarts) : undefined],
      ['Errores', ctx.service ? String(ctx.service.errors) : undefined],
    ]);

    const a = ctx.algo;
    add('Cómo se detectó', [
      ['Señales', a?.triggers?.length ? a.triggers.map((id) => TRIGGER_SHORT[id] ?? id).join(' + ') : undefined],
      ['Confianza', a ? `${CONFIDENCE_TEXT[a.confidence] ?? a.confidence}${a.score !== undefined ? ` (${Math.round(a.score * 100)} %)` : ''}` : undefined],
      ['Inicio sin medir', yesNo(a?.inferred)],
      ['Hueco medido', a?.gapMin !== undefined ? formatDuration(a.gapMin * MINUTE) : undefined],
      ['Ajuste del inicio / del final', a && (a.startShiftMin !== undefined || a.endShiftMin !== undefined) ? `${signedMin(a.startShiftMin ?? 0)} / ${signedMin(a.endShiftMin ?? 0)}` : undefined],
      ['Latencia sumada', a?.latencyMin !== undefined ? `${Math.round(a.latencyMin)} min (${a.latencySource === 'learned' ? 'aprendida' : 'de ajustes'})` : undefined],
      ['Hábito en ese momento', a?.habit ? `${hm(a.habit.startMin)} – ${hm(a.habit.endMin)}${a.habit.n ? ` (${a.habit.n} noches)` : ' (del horario)'}` : undefined],
      ['Huecos descartados esa noche', a?.discards?.length ? a.discards.map((x) => DISCARD_TEXT[x.reason] ?? x.reason).join('; ') : undefined],
    ]);

    if (ctx.partial) {
      sections.push({
        title: 'Aviso',
        rows: [{ label: 'Datos incompletos', value: 'el registro del servicio no cubría todo el tramo' }],
      });
    }
    return sections;
  } catch {
    return [];
  }
}
