import { DAY, HOUR, MINUTE } from './time';
import { TRIGGER_SHORT } from './triggers';
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

const round1 = (n: number) => Math.round(n * 10) / 10;

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

// --- Alarma, audio, luz y demás sensores --------------------------------------

function summarizeAlarm(
  by: ByKind,
  to: number,
  start: number,
  end: number,
  now: number,
): NonNullable<NonNullable<SessionContext['sensors']>['alarm']> | undefined {
  const alarms = (by.get('alarm') ?? []).filter((e) => e.at <= to);
  if (!alarms.length) return undefined;

  const atStart = valueAt(alarms, start);
  const setAtStart = atStart === null ? null : atStart > 0;

  // La alarma de esta mañana: la programada más cercana al despertar.
  const times = [...new Set(alarms.map((e) => e.v ?? 0).filter((v) => v > 0))].filter(
    (t) => t >= end - 5 * HOUR && t <= end + 30 * MINUTE,
  );
  if (!times.length) return { at: null, status: 'none', setAtStart };
  const target = times.reduce((best, t) => (Math.abs(t - end) <= Math.abs(best - end) ? t : best));

  const base = { at: target, deltaMin: Math.round((target - end) / MINUTE), setAtStart };
  if (target > now) return { ...base, status: 'pending' };

  // ¿Se canceló o cambió antes de sonar? Un cambio posterior a la hora es
  // simplemente la siguiente alarma que toma el relevo.
  const firstSet = alarms.findIndex((e) => e.v === target);
  const changed = alarms.slice(firstSet + 1).some((e) => e.at < target - MINUTE && e.v !== target);
  if (changed) return { ...base, status: 'cancelled' };

  const screen = (by.get('screen-on') ?? []).some(
    (e) => e.at >= target - 2 * MINUTE && e.at <= target + 15 * MINUTE,
  );
  return { ...base, status: screen ? 'rang' : 'no-screen' };
}

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
  now: number,
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
  if (has('proximity')) {
    const prox = summarizeState(by.get('proximity'), from, to, start, end, true);
    if (prox) out.proximity = { coveredPct: prox.pct?.['1'] ?? 0, changes: prox.changes };
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
  // La alarma y el audio se consultan sin escuchar nada: se resumen siempre
  // que el servicio los haya anotado, estén o no activos como sensor.
  const audio = summarizeAudio(by, from, to);
  if (audio) out.audio = audio;
  const alarm = summarizeAlarm(by, to, start, end, now);
  if (alarm) out.alarm = alarm;
  return out;
}

// --- Línea de tiempo ---------------------------------------------------------

/** Eventos que merece la pena recordar uno a uno; el resto sólo cuenta en los agregados. */
const NOTABLE: ReadonlySet<RawKind> = new Set<RawKind>([
  'unlock', 'plug', 'unplug', 'airplane', 'dnd-mode', 'dnd-on', 'dnd-off', 'ringer',
  'powersave', 'doze', 'idle-on', 'idle-off', 'alarm', 'bt', 'net', 'chg-type',
]);

function timeline(events: RawEvent[], from: number, to: number, start: number): SessionContext['timeline'] {
  return events
    .filter((e) => NOTABLE.has(e.kind) && e.at >= from && e.at <= to)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_TIMELINE)
    .map((e) => {
      const minutes = Math.round((e.at - start) / MINUTE);
      return e.kind === 'alarm' || e.v === undefined
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
    const battery = summarizeState(by.get('batt'), from, to, start, end, false);
    const temps = (by.get('batt-temp') ?? []).filter((e) => e.at >= from && e.at <= to);
    const tempBefore = valueAt(by.get('batt-temp'), from);
    const tempVals = [...temps.map((e) => e.v ?? 0), ...(tempBefore !== null ? [tempBefore] : [])];
    const plugs = (by.get('plug') ?? []).filter((e) => e.at >= from && e.at <= to).length;
    const unplugs = (by.get('unplug') ?? []).filter((e) => e.at >= from && e.at <= to).length;
    if (chargeType || battery || tempVals.length || plugs || unplugs || plugEvents.length) {
      ctx.power = {
        plugs,
        unplugs,
        chargingPct,
        ...(chargeType ? { chargeType } : {}),
        ...(battery ? { battery } : {}),
        ...(tempVals.length
          ? { tempC: { min: round1(Math.min(...tempVals) / 10), max: round1(Math.max(...tempVals) / 10) } }
          : {}),
      };
    }

    // Reposo profundo: el muestreo y los eventos del disparador cuentan igual.
    const dozeList = [
      ...(by.get('doze') ?? []),
      ...(by.get('idle-on') ?? []).map((e) => ({ at: e.at, kind: 'doze' as RawKind, v: 1 })),
      ...(by.get('idle-off') ?? []).map((e) => ({ at: e.at, kind: 'doze' as RawKind, v: 0 })),
    ].sort((a, b) => a.at - b.at);

    const system: NonNullable<SessionContext['system']> = {};
    const put = <K extends keyof NonNullable<SessionContext['system']>>(
      key: K,
      list: RawEvent[] | undefined,
      discrete: boolean,
    ) => {
      const s = summarizeState(list, from, to, start, end, discrete);
      if (s) system[key] = s;
    };
    put('doze', dozeList, true);
    put('dnd', by.get('dnd-mode'), true);
    put('airplane', by.get('airplane'), true);
    put('powerSave', by.get('powersave'), true);
    put('ringer', by.get('ringer'), true);
    put('net', by.get('net'), true);
    put('bt', by.get('bt'), false);
    put('bright', by.get('bright'), false);
    put('orient', by.get('orient'), true);
    if (Object.keys(system).length) ctx.system = system;

    ctx.sensors = summarizeSensors(by, from, to, start, end, now, sensorsOn);
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
      alarmMatch: ev.alarmMatch,
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

const pctOf = (s: StateSummary | undefined, key: string) => s?.pct?.[key];
const join = (xs: Array<string | number> | undefined) => (xs && xs.length ? xs.join('|') : undefined);
const num = (n: number | null | undefined): number | undefined => (n === null || n === undefined ? undefined : n);
const flag = (b: boolean | null | undefined): number | undefined => (b === null || b === undefined ? undefined : b ? 1 : 0);

/** Columnas del CSV de sesiones para el contexto, en orden fijo. */
export const CONTEXT_COLUMNS = [
  'ctx_parcial', 'ctx_modelo', 'ctx_android', 'ctx_app', 'ctx_zona', 'ctx_desfase_min', 'ctx_idioma',
  'pantalla_encendidos', 'pantalla_desbloqueos', 'pantalla_vistazos', 'pantalla_micro_despertares',
  'pantalla_uso_s', 'pantalla_uso_max_s', 'pantalla_usos_s', 'pantalla_encendida_inicio', 'pantalla_encendida_fin',
  'bateria_inicio', 'bateria_fin', 'bateria_min', 'bateria_max', 'bateria_temp_max_c',
  'carga_pct', 'enchufes', 'desenchufes', 'carga_tipo_inicio', 'carga_tipo_fin',
  'doze_pct', 'dnd_pct', 'dnd_modo_inicio', 'avion_pct', 'ahorro_pct',
  'timbre_inicio', 'timbre_fin', 'red_inicio', 'red_fin', 'red_sin_conexion_pct', 'bt_audio_max',
  'brillo_inicio', 'brillo_fin',
  'luz_oscuro_pct', 'lux_min', 'lux_max', 'pasos', 'movimientos', 'proximidad_tapado_pct',
  'postura_lecturas', 'postura_plano_pct', 'audio_pct', 'alarma_estado', 'alarma_hora', 'alarma_desfase_min',
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
  const sys = ctx.system;
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
    bateria_inicio: num(pow?.battery?.start),
    bateria_fin: num(pow?.battery?.end),
    bateria_min: pow?.battery?.min,
    bateria_max: pow?.battery?.max,
    bateria_temp_max_c: pow?.tempC?.max,
    carga_pct: num(pow?.chargingPct),
    enchufes: pow?.plugs,
    desenchufes: pow?.unplugs,
    carga_tipo_inicio: num(pow?.chargeType?.start),
    carga_tipo_fin: num(pow?.chargeType?.end),
    doze_pct: sys?.doze ? (pctOf(sys.doze, '1') ?? 0) : undefined,
    dnd_pct: sys?.dnd ? 100 - (pctOf(sys.dnd, '1') ?? 0) : undefined,
    dnd_modo_inicio: num(sys?.dnd?.start),
    avion_pct: sys?.airplane ? (pctOf(sys.airplane, '1') ?? 0) : undefined,
    ahorro_pct: sys?.powerSave ? (pctOf(sys.powerSave, '1') ?? 0) : undefined,
    timbre_inicio: num(sys?.ringer?.start),
    timbre_fin: num(sys?.ringer?.end),
    red_inicio: num(sys?.net?.start),
    red_fin: num(sys?.net?.end),
    red_sin_conexion_pct: sys?.net ? (pctOf(sys.net, '0') ?? 0) : undefined,
    bt_audio_max: sys?.bt?.max,
    brillo_inicio: num(sys?.bright?.start),
    brillo_fin: num(sys?.bright?.end),
    luz_oscuro_pct: sen?.light?.pct.dark,
    lux_min: sen?.light?.luxMin,
    lux_max: sen?.light?.luxMax,
    pasos: sen?.steps?.steps,
    movimientos: sen?.steps?.motions,
    proximidad_tapado_pct: num(sen?.proximity?.coveredPct),
    postura_lecturas: sen?.posture?.readings,
    postura_plano_pct: sen?.posture?.flatPct,
    audio_pct: sen?.audio?.playingPct,
    alarma_estado: sen?.alarm?.status,
    alarma_hora: sen?.alarm?.at ? new Date(sen.alarm.at).toISOString() : undefined,
    alarma_desfase_min: sen?.alarm?.deltaMin,
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

const NET_TEXT: Record<number, string> = {
  0: 'sin conexión',
  1: 'Wi-Fi',
  2: 'datos móviles',
  3: 'Ethernet',
  4: 'otra red (VPN o Bluetooth)',
};
const RINGER_TEXT: Record<number, string> = { 0: 'silencio', 1: 'vibrar', 2: 'normal' };
const CHARGE_TEXT: Record<number, string> = {
  0: 'sin cargar',
  1: 'cargador de pared',
  2: 'USB',
  3: 'inalámbrica',
  4: 'base',
};
const DND_TEXT: Record<number, string> = {
  1: 'desactivado',
  2: 'sólo prioritarias',
  3: 'silencio total',
  4: 'sólo alarmas',
};
const ALARM_TEXT: Record<string, string> = {
  rang: 'sonó (la pantalla se encendió a esa hora)',
  cancelled: 'se canceló o cambió antes de sonar',
  'no-screen': 'sin actividad de pantalla a esa hora',
  pending: 'aún no había llegado su hora',
  none: 'sin alarma cerca del despertar',
};
const CONFIDENCE_TEXT = { high: 'alta', medium: 'media', low: 'baja' } as const;

function hm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function secs(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
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

/** Reparto del tramo por valor, «Wi-Fi 90 %, sin conexión 10 %». */
function shares(s: StateSummary | undefined, text: (v: number) => string): string | undefined {
  if (!s?.pct) return undefined;
  const parts = Object.entries(s.pct)
    .sort((x, y) => y[1] - x[1])
    .map(([k, p]) => `${text(Number(k))} ${p} %`);
  return parts.length ? parts.join(', ') : undefined;
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
      ['Zona horaria', d?.tz ? `${d.tz} (UTC${d.tzOffsetMin >= 0 ? '+' : '−'}${Math.floor(Math.abs(d.tzOffsetMin) / 60)}${Math.abs(d.tzOffsetMin) % 60 ? ':' + String(Math.abs(d.tzOffsetMin) % 60).padStart(2, '0') : ''})` : undefined],
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
    add('Batería y carga', [
      ['Batería', p?.battery ? `${p.battery.start ?? '?'} % → ${p.battery.end ?? '?'} % (de ${p.battery.min ?? '?'} a ${p.battery.max ?? '?'} %)` : undefined],
      ['Temperatura de la batería', p?.tempC ? `${p.tempC.min} a ${p.tempC.max} °C` : undefined],
      ['Tiempo enchufado', pct(p?.chargingPct)],
      ['Enchufado / desenchufado', p ? `${p.plugs} / ${p.unplugs}` : undefined],
      ['Tipo de carga', fromTo(p?.chargeType, (v) => CHARGE_TEXT[v] ?? `código ${v}`)],
    ]);

    const y = ctx.system;
    add('Sistema', [
      ['Reposo profundo (Doze)', y?.doze ? `${pctOf(y.doze, '1') ?? 0} % del tiempo` : undefined],
      ['No molestar', fromTo(y?.dnd, (v) => DND_TEXT[v] ?? `código ${v}`)],
      ['Modo avión', y?.airplane ? `${pctOf(y.airplane, '1') ?? 0} % del tiempo` : undefined],
      ['Ahorro de energía', y?.powerSave ? `${pctOf(y.powerSave, '1') ?? 0} % del tiempo` : undefined],
      ['Timbre', fromTo(y?.ringer, (v) => RINGER_TEXT[v] ?? `código ${v}`)],
      ['Red', shares(y?.net, (v) => NET_TEXT[v] ?? `código ${v}`)],
      ['Bluetooth de audio conectado', y?.bt ? `hasta ${y.bt.max ?? 0}` : undefined],
      ['Brillo de la pantalla', y?.bright ? `${y.bright.start ?? '?'} % → ${y.bright.end ?? '?'} %` : undefined],
      ['Orientación', fromTo(y?.orient, (v) => (v === 2 ? 'horizontal' : 'vertical'))],
    ]);

    const n = ctx.sensors;
    add('Sensores', [
      ['Activos para detectar', n ? (n.on.length ? n.on.join(', ') : 'ninguno') : undefined],
      ['Pasos / movimiento', n?.steps ? `${n.steps.steps} pasos, ${n.steps.motions} avisos de movimiento` : undefined],
      ['Luz', n?.light ? `oscuro ${n.light.pct.dark} %, tenue ${n.light.pct.dim} %, claro ${n.light.pct.bright} %${n.light.luxMax !== undefined ? ` (${n.light.luxMin}–${n.light.luxMax} lux)` : ''}` : undefined],
      ['Proximidad', n?.proximity ? `tapado ${n.proximity.coveredPct ?? '?'} %, ${n.proximity.changes} cambios` : undefined],
      ['Postura del móvil', n?.posture ? `${n.posture.readings} lecturas, plano ${n.posture.flatPct} %` : undefined],
      ['Audio sonando', n?.audio ? `${n.audio.playingPct} % del tiempo` : undefined],
    ]);

    const al = n?.alarm;
    add('Alarma', [
      ['Alarma programada al dormirte', yesNo(al?.setAtStart)],
      ['Alarma del despertar', al?.at ? `${clock(al.at)}${al.deltaMin !== undefined ? ` (${al.deltaMin >= 0 ? '+' : '−'}${Math.abs(al.deltaMin)} min respecto a tu despertar)` : ''}` : undefined],
      ['Qué pasó', al ? ALARM_TEXT[al.status] : undefined],
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
      ['Hueco medido', a?.gapMin !== undefined ? secs(Math.round(a.gapMin * 60)) : undefined],
      ['Ajuste del inicio / del final', a && (a.startShiftMin !== undefined || a.endShiftMin !== undefined) ? `${a.startShiftMin ?? 0} / ${a.endShiftMin ?? 0} min` : undefined],
      ['Latencia sumada', a?.latencyMin !== undefined ? `${Math.round(a.latencyMin)} min (${a.latencySource === 'learned' ? 'aprendida' : 'de ajustes'})` : undefined],
      ['Hábito en ese momento', a?.habit ? `${hm(a.habit.startMin)} – ${hm(a.habit.endMin)}${a.habit.n ? ` (${a.habit.n} noches)` : ' (del horario)'}` : undefined],
      ['Huecos descartados esa noche', a?.discards?.length ? a.discards.map((x) => x.reason).join(', ') : undefined],
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
