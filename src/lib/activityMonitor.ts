import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { HOUR, MINUTE, formatDuration, inWindow, parseTime } from './time';
import { minuteDiff, type SleepHabit } from './habit';
import { gatherEvidence, type GapEvidence, type RawEvent } from './rawEvents';
import { activeSensors } from './sensors';
import { loadRaw, saveRaw } from './storage';
import {
  clearGaps,
  isBackgroundAvailable,
  readGaps,
  readNativeEvents,
  readRawEvents,
  type NativeGap,
} from './backgroundMonitor';
import { discardReason, logEvent, pushEvents } from './triggerLog';
import {
  TRIGGERS,
  TRIGGER_BY_ID,
  TRIGGER_SHORT,
  sortTriggers,
  triggerEnabled,
} from './triggers';
import { goalForDate } from './schedule';
import type {
  Confidence,
  MonitorSettings,
  ScheduleSettings,
  SleepSession,
  TriggerId,
} from './types';

/**
 * Módulo 3 — Detección del sueño por inactividad del dispositivo.
 *
 * La idea de fondo no cambia: mientras el usuario está despierto usa el móvil
 * cada cierto tiempo, y mientras duerme no. Lo que cambia es de dónde sale esa
 * señal. Hay varios disparadores, cada uno activable por separado:
 *
 *   screen    apagar la pantalla → desbloquear      (servicio nativo)
 *   charger   enchufar el cargador → desenchufarlo  (servicio nativo)
 *   appOpen   hueco entre dos aperturas de la app   (siempre)
 *   schedule  la meta del horario, a falta de todo  (siempre)
 *
 * Los tres primeros producen huecos que se evalúan igual; cuando dos caen
 * sobre la misma noche se fusionan en una única propuesta y la coincidencia
 * eleva la confianza. El cuarto sólo entra si la noche no dejó ninguna señal.
 *
 * Toda sesión se propone con un nivel de confianza y queda editable: ninguna
 * de estas señales mide el sueño, sólo el uso del dispositivo.
 */

const HEARTBEAT_KEY = 'perfectrest.heartbeat';
/** Última noche propuesta a partir del horario, para no repetirla. */
const SCHEDULE_MARK_KEY = 'perfectrest.scheduleProposal';
/** Cada cuánto se refresca el latido mientras la app está visible. */
const HEARTBEAT_INTERVAL = 30_000;

export interface DetectionResult {
  session: SleepSession;
  /** Duración del hueco de inactividad detectado, en ms. */
  gapMs: number;
  /** Puntuación 0-1 de lo noche que parece; de ella sale la confianza. */
  score?: number;
  /** Lo que dijeron los sensores de este hueco, si había alguno activo. */
  evidence?: GapEvidence;
  /** El inicio se dedujo de tu hábito, no se midió: nunca pasa de confianza baja. */
  inferred?: boolean;
}

/**
 * Lo que la evaluación sabe además del hueco mismo. Todo es opcional: sin
 * contexto la detección se comporta como antes, con un hábito genérico.
 */
export interface DetectionContext {
  /** A qué hora sueles acostarte y levantarte. */
  habit?: SleepHabit | null;
  /** Registro bruto del servicio, para cruzarlo con los huecos (sensores). */
  events?: RawEvent[];
  /** Noches ya registradas o a la espera de confirmar: ya tienen su noche principal. */
  known?: KnownNight[];
}

/**
 * Una noche que ya existe. Sin `rank` es firme (la registró o confirmó el
 * usuario) y ningún hueco del mismo día la desplaza; con `rank` es una
 * propuesta sin revisar, y una candidata claramente mejor sí puede ponerse
 * delante —la tarde quieta que se propuso anoche no debe tapar la noche de
 * verdad que llega por la mañana.
 */
export interface KnownNight {
  start: number;
  end: number;
  rank?: number;
}

/** Peso de una propuesta sin revisar, en la misma escala que usa la elección de noche. */
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0.8, medium: 0.55, low: 0.3 };

/** Convierte las sesiones del store en las noches que la evaluación ya da por existentes. */
export function knownNights(sessions: SleepSession[], pending: SleepSession[] = []): KnownNight[] {
  const rank = (s: SleepSession) =>
    CONFIDENCE_RANK[s.confidence] + Math.min(s.end - s.start, 10 * HOUR) / (40 * HOUR);
  return [
    ...sessions.map((s) => ({
      start: s.start,
      end: s.end,
      rank: s.confirmed && s.source === 'auto' && !s.note ? rank(s) : undefined,
    })),
    ...pending.map((s) => ({ start: s.start, end: s.end, rank: rank(s) })),
  ];
}

/** Contexto de un solo hueco: lo que `evaluateGap` necesita de fuera. */
export interface GapContext {
  habit?: SleepHabit | null;
  evidence?: GapEvidence | null;
  /** Bordes tal como los midió el dispositivo, si se han recortado antes. */
  detected?: { start: number; end: number };
  /** El inicio se ha deducido de tu hábito, no medido: nunca pasa de confianza baja. */
  inferred?: boolean;
  /**
   * No exigir que el hueco toque la ventana nocturna. Lo usa `evaluateGaps`,
   * que lo juzga después de fusionar y dejando pasar las siestas con indicios.
   */
  lenient?: boolean;
}

/**
 * Techo absoluto de lo que puede ser una noche.
 *
 * Es distinto de `maxGapMinutes`, que marca lo dudoso: entre ese ajuste y este
 * techo la sesión se propone con confianza baja, para que el usuario la
 * corrija. Por encima ya no se propone nada, porque no hay nada que corregir.
 * Trece horas ya son más de lo que duerme casi nadie, así que un hueco mayor
 * no habla del sueño sino de la medida: el móvil sin tocar todo un día, la
 * tarde entera sin usarlo antes de acostarse, o una señal de vuelta que se
 * perdió y dejó el hueco abierto. Con datos reales los huecos de entre 13 y 18
 * horas eran siempre eso —una tarde despierto más una noche—, y proponerlos
 * metía en el historial horas de sueño que nadie había dormido.
 */
export const MAX_PLAUSIBLE_SLEEP_MS = 13 * HOUR;

/**
 * Lo que `refineEdges` le quita al hueco (latencia al inicio, 5 min al final).
 * El techo se mide sobre la noche ya refinada, no sobre el hueco crudo: un
 * hueco de 13h20 es una noche de 13h una vez corregida.
 */
const REFINE_MARGIN_MS = 30 * MINUTE;

/** Una noche dura al menos esto; por debajo es una siesta larga o una tarde quieta. */
export const SHORT_NIGHT_MS = 4.5 * HOUR;

/** Hábito de reserva cuando no hay historial ni horario a mano. */
const DEFAULT_HABIT: SleepHabit = { startMin: 23 * 60 + 30, endMin: 7 * 60 + 30, n: 0 };

/** Un hueco corto sólo es una noche si empieza a esta distancia de tu hora de acostarte. */
const SHORT_NIGHT_START_TOLERANCE_MIN = 210;
/** Un hueco corto que no llega a esto pasada tu hora de acostarte es la tarde, no la noche. */
const SHORT_NIGHT_END_AFTER_BEDTIME_MIN = 90;

/** Disparadores que dependen del servicio nativo. */
export const NATIVE_TRIGGERS: TriggerId[] = TRIGGERS.filter((t) => t.native).map((t) => t.id);

/** Los disparadores nativos que el usuario tiene activos ahora mismo. */
export function activeNativeTriggers(settings: MonitorSettings): TriggerId[] {
  return NATIVE_TRIGGERS.filter((id) => triggerEnabled(settings, id));
}

const minutesOfDay = (ts: number) => {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
};

/** Por qué una evaluación terminó sin propuesta. */
type Reject = 'implausible' | 'too-long';

/**
 * Evalúa un hueco de inactividad y decide si merece proponerse como sueño.
 * Devuelve null cuando el hueco no cumple los criterios.
 */
export function evaluateGap(
  lastActive: number,
  now: number,
  settings: MonitorSettings,
  triggers: TriggerId[] = ['appOpen'],
  ctx: GapContext = {},
): DetectionResult | null {
  const out = assessGap(lastActive, now, settings, triggers, ctx);
  if (!('result' in out)) return null;
  // Un hueco suelto se juzga entero; los que vienen de la cola nativa se
  // juzgan después de fusionarlos (ver `evaluateGaps`).
  const { start, end } = out.result.session;
  return outOfPattern(start, end, ctx.habit ?? DEFAULT_HABIT) ? null : out.result;
}

/**
 * Un hueco corto sólo es una noche si empieza cuando tú te acuestas. Los de la
 * tarde o los de la mañana tras despertar (08:00-11:00) son el móvil quieto,
 * no sueño: con datos reales eran casi todos los falsos positivos. Se mira
 * sobre la noche ya fusionada, no sobre cada trozo: el rabo de una noche que
 * un desbloqueo partió en dos también es corto y empieza de madrugada.
 */
function outOfPattern(start: number, end: number, habit: SleepHabit): boolean {
  if (end - start >= SHORT_NIGHT_MS) return false;
  if (Math.abs(minuteDiff(minutesOfDay(start), habit.startMin)) > SHORT_NIGHT_START_TOLERANCE_MIN) return true;
  // La tarde quieta que termina cuando tú te acuestas (20:40 → 23:40 con
  // costumbre de las 23:00) empieza «cerca» de tu hora, pero no ha dormido nada
  // de tu noche: se coge el móvil justo para irse a la cama. Era el falso
  // positivo que quedaba mientras el hábito aún no se ha aprendido.
  return minuteDiff(minutesOfDay(end), habit.startMin) < SHORT_NIGHT_END_AFTER_BEDTIME_MIN;
}

/** ¿Toca el tramo la ventana nocturna, o la atraviesa entera? */
function fitsNight(start: number, end: number, settings: MonitorSettings): boolean {
  const nightStart = parseTime(settings.nightStart);
  const nightEnd = parseTime(settings.nightEnd);
  return (
    inWindow(minutesOfDay(start), nightStart, nightEnd) ||
    inWindow(minutesOfDay(end), nightStart, nightEnd) ||
    end - start >= 6 * HOUR
  );
}

function assessGap(
  lastActive: number,
  now: number,
  settings: MonitorSettings,
  triggers: TriggerId[],
  ctx: GapContext,
): { result: DetectionResult } | { reject: Reject } {
  const gapMs = now - lastActive;
  if (gapMs < settings.minGapMinutes * MINUTE) return { reject: 'implausible' };

  const startDate = new Date(lastActive);
  const endDate = new Date(now);
  const startMin = startDate.getHours() * 60 + startDate.getMinutes();
  const endMin = endDate.getHours() * 60 + endDate.getMinutes();

  const nightStart = parseTime(settings.nightStart);
  const nightEnd = parseTime(settings.nightEnd);

  // El sueño empieza en la ventana nocturna, termina en ella, o la atraviesa
  // entera (quien se acuesta antes de la ventana y despierta después).
  const startsAtNight = inWindow(startMin, nightStart, nightEnd);
  const endsAtNight = inWindow(endMin, nightStart, nightEnd);
  const spansNight = gapMs >= 6 * HOUR;

  if (!ctx.lenient && !startsAtNight && !endsAtNight && !spansNight) return { reject: 'implausible' };
  // Por encima del techo no hay noche dudosa que corregir, hay una medición
  // que falló: el móvil pasó el día en un cajón, o una señal de vuelta se
  // perdió y el hueco siguió abierto. `maxGapMinutes` no basta para pararlo
  // —sólo baja la confianza— y con «guardar sin preguntar» activo eso mete
  // horas de «sueño» en el historial sin que nadie las vea. Hay que
  // descartarlo aquí: ninguna corrección posterior salva un dato así.
  if (gapMs > MAX_PLAUSIBLE_SLEEP_MS + REFINE_MARGIN_MS) return { reject: 'too-long' };

  const habit = ctx.habit ?? DEFAULT_HABIT;

  const { score, confidence } = scoreGap({
    gapMs,
    startMin,
    endMin,
    startsAtNight,
    endsAtNight,
    settings,
    triggers,
    habit,
    evidence: ctx.evidence ?? null,
  });

  // Los sensores pueden mover los bordes: el último momento de actividad real
  // es mejor inicio que el último uso del móvil, y el primer despertar real
  // mejor final que el primer desbloqueo. Sólo si queda una noche creíble.
  let start = lastActive;
  let end = now;
  const ev = ctx.evidence;
  if (ev) {
    if (ev.activityAt !== null && ev.activityAt > start) start = ev.activityAt;
    if (ev.wakeAt !== null && ev.wakeAt < end) end = ev.wakeAt;
    if (end - start < settings.minGapMinutes * MINUTE) {
      start = lastActive;
      end = now;
    }
  }

  return {
    result: {
      gapMs,
      score,
      evidence: ev ?? undefined,
      ...(ctx.inferred ? { inferred: true } : {}),
      session: {
        id: `auto-${lastActive}`,
        start,
        end,
        source: 'auto',
        confidence: ctx.inferred ? 'low' : confidence,
        confirmed: false,
        triggers: sortTriggers(triggers),
        detectedStart: ctx.detected?.start ?? lastActive,
        detectedEnd: ctx.detected?.end ?? now,
      },
    },
  };
}

/** Escalón: el valor del primer tramo cuyo límite no se supera; `rest` si ninguno. */
function tier(value: number, steps: Array<[number, number]>, rest: number): number {
  for (const [limit, v] of steps) if (value <= limit) return v;
  return rest;
}

interface ScoreInput {
  gapMs: number;
  startMin: number;
  endMin: number;
  startsAtNight: boolean;
  endsAtNight: boolean;
  settings: MonitorSettings;
  triggers: TriggerId[];
  habit: SleepHabit;
  evidence: GapEvidence | null;
}

/**
 * Puntúa lo noche que parece un hueco combinando varias evidencias, cada una
 * con su peso, en vez de mirar sólo la duración y la hora:
 *
 *   duración      cuánto se parece a una noche (6-10 h lo más; 4,5 y 12 aún caben)
 *   hora habitual a qué distancia de tu hora de acostarte y de levantarte cae
 *   disparadores  dos señales independientes valen mucho más que una
 *   quietud       (sensores) sin pasos ni audio entre medias
 *   oscuridad     (sensores) luz apagada durante el sueño
 *   alarma        (sensores) la alarma programada cae junto al final
 *
 * Las evidencias que faltan no puntúan ni a favor ni en contra: se promedia
 * sólo sobre las que hay, para que quien no active sensores no salga
 * penalizado por ellos.
 */
function scoreGap(input: ScoreInput): { score: number; confidence: Confidence } {
  const { gapMs, settings, triggers, habit, evidence } = input;
  const hours = gapMs / HOUR;
  const tooLong = gapMs > settings.maxGapMinutes * MINUTE;

  const parts: Array<[weight: number, value: number]> = [];

  // Duración.
  parts.push([
    2,
    hours >= 6 && hours <= 10
      ? 1
      : hours >= 5 && hours <= 11
        ? 0.8
        : hours >= SHORT_NIGHT_MS / HOUR && hours <= 12
          ? 0.5
          : hours >= 3.5 && hours <= 13
            ? 0.2
            : 0,
  ]);

  // Hora habitual: con un hábito aprendido pesa el doble que con el del horario.
  const learned = habit.n >= 4 ? 1 : 0.5;
  const startDiff = Math.abs(minuteDiff(input.startMin, habit.startMin));
  const endDiff = Math.abs(minuteDiff(input.endMin, habit.endMin));
  parts.push([2 * learned, tier(startDiff, [[60, 1], [120, 0.8], [180, 0.55], [270, 0.3]], 0.05)]);
  parts.push([1 * learned, tier(endDiff, [[60, 1], [150, 0.65], [240, 0.3]], 0.05)]);
  // La ventana nocturna configurada sigue contando, poco: es la forma de que
  // el ajuste del usuario siga teniendo efecto.
  parts.push([
    0.5,
    (input.startsAtNight ? 0.5 : 0) + (input.endsAtNight ? 0.5 : 0),
  ]);

  // Acuerdo entre disparadores: sólo cuentan los que miden el dispositivo.
  const independent = new Set(triggers.filter((id) => id !== 'appOpen' && id !== 'schedule'));
  parts.push([1.5, independent.size >= 3 ? 1 : independent.size === 2 ? 0.9 : independent.size === 1 ? 0.4 : 0.2]);

  if (evidence) {
    if (evidence.moves !== null) parts.push([1, evidence.moves === 0 ? 1 : evidence.moves === 1 ? 0.6 : 0.2]);
    if (evidence.dark !== null) parts.push([1.5, evidence.dark]);
    if (evidence.alarmMatch !== null) parts.push([evidence.alarmMatch ? 1.5 : 0.5, evidence.alarmMatch ? 1 : 0.4]);
  }

  const totalWeight = parts.reduce((sum, [w]) => sum + w, 0);
  const score = parts.reduce((sum, [w, v]) => sum + w * v, 0) / totalWeight;

  let confidence: Confidence = score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low';
  // Un hueco por encima de lo dudoso, o demasiado corto para una noche, nunca
  // sube de baja por mucho que otras evidencias coincidan.
  if (tooLong || hours < 3.5) confidence = 'low';
  // Un inicio a más de cuatro horas y media de tu hora de acostarte es casi
  // seguro la tarde despierto: se propone, pero nunca como segura.
  else if (startDiff > 270 && confidence === 'high') confidence = 'medium';
  return { score, confidence };
}

/**
 * Fusiona las detecciones que describen una misma noche.
 *
 * Dos disparadores distintos sobre la misma noche son un único sueño, y un
 * mismo disparador puede además partir la noche en trozos: Android sale de
 * Doze en cada ventana de mantenimiento, y una pantalla que se enciende sola
 * cierra y reabre el hueco. Por eso el agrupado no exige solape estricto, sino
 * que salva también las interrupciones cortas (`BRIDGE_MS`, lo mismo que
 * aguanta el servicio antes de dar por cerrado un hueco). Eran 45 minutos,
 * pero con el final de la noche en el primer uso sostenido, 45 minutos de
 * margen se tragaban el rato de después de levantarse y la mañana sin tocar el
 * móvil acababa pegada a la noche, como si se hubiera dormido hasta las 10.
 *
 * De cada grupo se toma el borde de la **señal más directa** que contenga.
 * Antes se tomaba la intersección de todas, y eso resultaba ser justo lo
 * contrario de lo que conviene: bastaba un fragmento de tres horas de Doze
 * para recortar una noche de siete y media a ese fragmento, y el resto de la
 * noche reaparecía como una segunda sesión inventada. Con el criterio de
 * directividad la pantalla —que mide el bloqueo real— manda sobre el cargador
 * y sobre Doze, que acotan por fuera o llegan a trozos, y los trozos de la
 * señal ganadora se unen en un solo tramo.
 */
const BRIDGE_MS = 15 * MINUTE;

/** Lo directa que es la señal más directa de una detección. */
function directnessOf(triggers: TriggerId[] | undefined): number {
  if (!triggers?.length) return 0;
  return Math.max(...triggers.map((id) => TRIGGER_BY_ID[id].directness));
}

export function mergeDetections(
  results: DetectionResult[],
  settings: MonitorSettings,
  habit?: SleepHabit | null,
): DetectionResult[] {
  const sorted = [...results].sort((a, b) => a.session.start - b.session.start);
  const clusters: DetectionResult[][] = [];
  let reach = -Infinity;

  for (const result of sorted) {
    const current = clusters[clusters.length - 1];
    if (!current || result.session.start > reach + BRIDGE_MS) {
      clusters.push([result]);
      reach = result.session.end;
    } else {
      current.push(result);
      reach = Math.max(reach, result.session.end);
    }
  }

  return clusters.map((cluster) => fuseCluster(cluster, settings, habit));
}

function fuseCluster(
  cluster: DetectionResult[],
  settings: MonitorSettings,
  habit?: SleepHabit | null,
): DetectionResult {
  if (cluster.length === 1) return cluster[0];

  const best = Math.max(...cluster.map((r) => directnessOf(r.session.triggers)));
  const lead = cluster.filter((r) => directnessOf(r.session.triggers) === best);
  const start = Math.min(...lead.map((r) => r.session.start));
  const end = Math.max(...lead.map((r) => r.session.end));
  const triggers = sortTriggers(cluster.flatMap((r) => r.session.triggers ?? []));
  const detectedStart = Math.min(...lead.map((r) => r.session.detectedStart ?? r.session.start));
  const detectedEnd = Math.max(...lead.map((r) => r.session.detectedEnd ?? r.session.end));

  // Se reevalúa desde cero para que la confianza mire el tramo definitivo y
  // los disparadores que lo respaldan, no los de un trozo suelto. Los bordes
  // del líder ya vienen ajustados por los sensores: se reevalúa sin volver a
  // aplicarlos, pero conservando su evidencia para la confianza.
  const evidence = lead.find((r) => r.evidence)?.evidence ?? null;
  const fused = assessGap(start, end, settings, triggers, {
    habit,
    evidence: evidence && { ...evidence, activityAt: null, wakeAt: null },
    detected: { start: detectedStart, end: detectedEnd },
    // Un inicio deducido del hábito sigue siéndolo aunque otra señal coincida.
    inferred: lead.some((r) => r.inferred),
  });
  // Se devuelve la evidencia completa: dice si el inicio lo fijó un sensor.
  if ('result' in fused) return { ...fused.result, evidence: evidence ?? undefined };

  // Si el tramo resultante ya no fuera plausible se conserva el trozo más
  // largo, que es la mejor aproximación disponible, en vez de perder la noche.
  const longest = cluster.reduce((x, y) =>
    y.session.end - y.session.start > x.session.end - x.session.start ? y : x,
  );
  return { ...longest, session: { ...longest.session, triggers } };
}

/** Opciones con las que `refineEdges` afina los bordes más allá de la latencia fija. */
export interface RefineOptions {
  /** Latencia personal aprendida de tus noches corregidas (minutos). */
  learnedLatencyMinutes?: number | null;
  /**
   * Tu hábito, si ya es de fiar. El inicio medido se adelanta tanto a dormirse
   * (se suelta el móvil, y se sigue despierto una hora o dos) que, cuando cae
   * mucho antes de tu hora de acostarte, esa hora es mejor estimación.
   */
  habit?: SleepHabit | null;
}

/**
 * Cuánto antes de tu hora habitual puede caer el inicio sin que se corrija, y
 * hasta dónde se adelanta cuando se corrige: tu hora habitual menos lo que
 * suele variar de una noche a otra. Quien se acuesta siempre a la misma hora
 * queda a 20 min de ella; quien varía mucho, hasta una hora antes. Así una
 * noche en que te acostaste pronto de verdad no se lleva hasta la media,
 * que es lo que pasaba con un margen fijo (23:30 real quedaba en 00:38).
 */
const HABIT_START_SLACK_MIN_MS = 20 * MINUTE;
const HABIT_START_SLACK_MAX_MS = 60 * MINUTE;

function habitSlackMs(habit: SleepHabit): number {
  const spread = (habit.spreadMin ?? 0) * MINUTE;
  return Math.min(HABIT_START_SLACK_MAX_MS, Math.max(HABIT_START_SLACK_MIN_MS, spread));
}
/** A cuánto tiempo hacia atrás del hábito se busca si el inicio medido es «demasiado pronto». */
const HABIT_REACH_MS = 9 * HOUR;

/**
 * Ajusta los bordes de la sesión: la inactividad empieza un poco antes de
 * dormirse de verdad (primero se suelta el móvil, luego se concilia el sueño)
 * y termina un poco después de despertar (nadie coge el móvil al instante).
 * Corregir ambos extremos acerca la estimación al sueño real en lugar de
 * medir simplemente el tiempo sin pantalla.
 *
 * Con un hábito aprendido, el inicio nunca se queda mucho antes de tu hora de
 * acostarte: quien suelta el móvil a las 21:30 y se duerme a las 00:30 no
 * durmió tres horas más. Con la latencia personal aprendida, el desfase fijo
 * de ajustes se sustituye por el tuyo.
 */
export function refineEdges(
  session: SleepSession,
  latencyMinutes: number,
  options: RefineOptions = {},
): SleepSession {
  // Una propuesta calcada del horario ya está expresada en tiempo de sueño:
  // corregirle los bordes descontaría la latencia dos veces.
  if (session.triggers?.length === 1 && session.triggers[0] === 'schedule') return session;

  const learned = options.learnedLatencyMinutes;
  const startBias = (learned != null ? learned : latencyMinutes) * MINUTE; // tarda en dormirse
  const endBias = 5 * MINUTE; // tarda en coger el móvil
  let start = session.start + startBias;
  const end = session.end - endBias;

  const habit = options.habit;
  if (habit && habit.n >= 4) {
    const early = minuteDiff(habit.startMin - 0, minutesOfDay(start));
    // `early` > 0: el hábito cae después del inicio estimado. Si es por menos
    // de la holgura el inicio vale; si es por mucho, se adelanta hasta el hábito.
    const slack = habitSlackMs(habit);
    if (early * MINUTE > slack && early * MINUTE <= HABIT_REACH_MS) {
      const moved = start + early * MINUTE - slack;
      // Si lo que queda ya no parece una noche, el hábito se equivoca de día.
      if (end - moved >= 3 * HOUR) start = moved;
    }
  }

  if (end - start < 60 * MINUTE) return session;
  return { ...session, start, end };
}

/** Por qué un hueco del servicio no llegó a proponerse. */
export interface RejectedGap {
  gap: NativeGap;
  reason: 'trigger-off' | 'implausible' | 'too-long' | 'out-of-pattern' | 'secondary';
  /** El disparador culpable: el apagado, o el que cerró el hueco. */
  trigger: TriggerId | null;
}

/** Despertar breve (desbloqueo corto) que sigue contando como parte del mismo sueño. */
const LATE_WAKE_PULL_MS = 75 * MINUTE;
/** Una noche no cabe en menos de esto: un recorte nunca deja menos. */
const MIN_TAIL_MS = 4 * HOUR;
/** Cuánto antes de tu hora de acostarte puede empezar un hueco sin sospecha. */
const EARLY_START_SUSPECT_MIN = 90;
/** Margen alrededor de tu hora de acostarte donde un micro-despertar es «me fui a dormir». */
const BEDTIME_WAKE_REACH_MIN = 150;

/**
 * Recorta los bordes de un hueco con lo que dicen sus micro-despertares
 * (desbloqueos cortos que el servicio no tomó por el final de la noche).
 *
 * Por el principio: el último uso del móvil antes de dormir suele ser una
 * mirada breve a la hora o a la alarma, no el momento en que se soltó el
 * móvil para el resto de la tarde. Si el hueco arranca mucho antes de tu hora
 * de acostarte y hay un micro-despertar alrededor de ella con noche suficiente
 * por detrás, ahí empieza el sueño. Lo mismo, a la fuerza, con los huecos que
 * pasan del techo: el que deja un tramo creíble más cerca de tu hora.
 *
 * Por el final: un desbloqueo de segundos en la hora y cuarto anterior al uso
 * sostenido (`LATE_WAKE_PULL_MS`, encadenando los que haya) es casi siempre
 * alguien que ya estaba despierto —mirar la hora, parar la alarma— y se
 * levantó sin coger el móvil. Despertar es lo primero de esa cadena. Es una
 * apuesta sin calibrar: quien mira la hora a las 06:50 y vuelve a dormirse
 * hasta las 08:00 pierde esa hora; el registro bruto exportado es lo que
 * permitirá ajustarla con noches reales.
 */
function trimGap(
  gap: NativeGap,
  habit: SleepHabit,
): { start: number; end: number; inferred: boolean } {
  let { start, end } = gap;
  const wakes = (gap.wakes ?? []).filter((w) => w > start && w < end).sort((a, b) => a - b);
  if (!wakes.length) return overlongByHabit(start, end, habit);

  // Final: se retrocede por la cadena de micro-despertares pegados al uso.
  let pulled = end;
  for (let i = wakes.length - 1; i >= 0; i--) {
    if (pulled - wakes[i] <= LATE_WAKE_PULL_MS) pulled = wakes[i];
    else break;
  }
  if (pulled - start >= MIN_TAIL_MS) end = pulled;

  // Inicio.
  const towardsHabit = (ts: number) => Math.abs(minuteDiff(minutesOfDay(ts), habit.startMin));
  const candidates = wakes.filter((w) => end - w >= MIN_TAIL_MS && end - w <= MAX_PLAUSIBLE_SLEEP_MS);
  if (end - start > MAX_PLAUSIBLE_SLEEP_MS + REFINE_MARGIN_MS) {
    // Obligado: el hueco entero no cabe en una noche.
    if (candidates.length) {
      start = candidates.reduce((best, w) => (towardsHabit(w) <= towardsHabit(best) ? w : best));
    } else {
      return overlongByHabit(start, end, habit);
    }
  } else if (minuteDiff(minutesOfDay(start), habit.startMin) < -EARLY_START_SUSPECT_MIN) {
    const near = candidates.filter((w) => towardsHabit(w) <= BEDTIME_WAKE_REACH_MIN);
    if (near.length) start = near[near.length - 1];
  }
  return { start, end, inferred: false };
}

/**
 * Un hueco que pasa del techo y no tiene micro-despertares con que partirlo.
 *
 * Con datos reales casi todos eran una tarde sin tocar el móvil seguida de una
 * noche de verdad (se acostaba a la una y el móvil llevaba quieto desde las
 * ocho). Descartarlos perdía noches reales; proponerlos enteros metía horas de
 * sueño que nadie durmió. Lo que queda es empezar la noche a tu hora de
 * acostarte, siempre que esa hora caiga dentro del hueco y deje una noche
 * creíble, y proponerla con confianza baja para que la corrijas. Si la hora de
 * acostarte no cae dentro, el hueco es el móvil olvidado y no hay noche.
 */
function overlongByHabit(
  start: number,
  end: number,
  habit: SleepHabit,
): { start: number; end: number; inferred: boolean } {
  if (end - start <= MAX_PLAUSIBLE_SLEEP_MS + REFINE_MARGIN_MS) return { start, end, inferred: false };
  const first = new Date(start);
  first.setHours(Math.floor(habit.startMin / 60), habit.startMin % 60, 0, 0);
  for (let d = 0; d < 2; d++) {
    const cand = first.getTime() + d * 24 * HOUR - habitSlackMs(habit);
    if (cand < start) continue;
    const tail = end - cand;
    if (tail >= MIN_TAIL_MS && tail <= MAX_PLAUSIBLE_SLEEP_MS) return { start: cand, end, inferred: true };
  }
  return { start, end, inferred: false };
}

/**
 * Convierte los huecos del servicio en sesiones candidatas.
 *
 * Es pura a propósito, separada de la lectura de la cola nativa: es la parte
 * con lógica de verdad —filtrado por disparador, plausibilidad, recorte,
 * fusión y elección de la noche principal— y así la simulación de una noche
 * completa puede recorrerla tal cual, en vez de comprobar una maqueta parecida.
 */
export function evaluateGaps(
  gaps: NativeGap[],
  settings: MonitorSettings,
  ctx: DetectionContext = {},
): { results: DetectionResult[]; rejected: RejectedGap[] } {
  const raw: DetectionResult[] = [];
  const rejected: RejectedGap[] = [];
  const habit = ctx.habit ?? DEFAULT_HABIT;
  const sensors = activeSensors(settings);
  const owner = new Map<string, NativeGap>();

  for (const gap of gaps) {
    // Un hueco puede haberse registrado con un disparador que el usuario ha
    // apagado desde entonces; en ese caso se descarta sin proponerlo.
    const triggers = [gap.startTrigger, gap.endTrigger].filter(Boolean);
    const off = triggers.find((id) => !triggerEnabled(settings, id));
    if (off) {
      rejected.push({ gap, reason: 'trigger-off', trigger: off });
      continue;
    }

    const { start, end, inferred } = trimGap(gap, habit);
    // Los sensores miran el tramo ya recortado: si no, la tarde despierta
    // entraría en las cuentas de quietud y oscuridad de la noche.
    const evidence = ctx.events?.length ? gatherEvidence(ctx.events, start, end, sensors) : null;
    const out = assessGap(start, end, settings, triggers, {
      habit,
      evidence: evidence && evidence.sensors.length ? evidence : null,
      detected: { start: gap.start, end: gap.end },
      lenient: true,
      inferred,
    });
    if ('result' in out) {
      raw.push(out.result);
      owner.set(out.result.session.id, gap);
    } else {
      rejected.push({ gap, reason: out.reject, trigger: gap.endTrigger });
    }
  }

  // La ventana nocturna y la hora de acostarse se juzgan sobre la noche ya
  // fusionada, no sobre cada trozo: el rabo de una noche partida por un
  // desbloqueo también es corto y empieza de madrugada. Lo que no encaja sólo
  // sobrevive si trae indicios propios de siesta.
  const fused = mergeDetections(raw, settings, habit);
  const merged: DetectionResult[] = [];
  for (const r of fused) {
    const { start, end } = r.session;
    const reason = !fitsNight(start, end, settings)
      ? 'implausible'
      : outOfPattern(start, end, habit)
        ? 'out-of-pattern'
        : null;
    if (!reason) merged.push(r);
    else if (napEvidence(r)) merged.push(asNap(r));
    else {
      const gap = owner.get(r.session.id) ?? gapOf(r);
      rejected.push({ gap, reason, trigger: gap.endTrigger });
    }
  }
  const { kept, dropped } = pickMainNights(merged, ctx.known ?? []);
  for (const r of dropped) {
    const gap = owner.get(r.session.id) ?? gapOf(r);
    rejected.push({ gap, reason: 'secondary', trigger: gap.endTrigger });
  }
  return { results: kept, rejected };
}

/** Cuánto tiene que superar una candidata a la propuesta sin revisar que ya ocupa su noche. */
const BETTER_NIGHT_MARGIN = 0.1;

/** El hueco crudo que dio lugar a una detección, para anotar su descarte. */
function gapOf(r: DetectionResult): NativeGap {
  const trigger = r.session.triggers?.[0] ?? 'screen';
  return {
    start: r.session.detectedStart ?? r.session.start,
    end: r.session.detectedEnd ?? r.session.end,
    startTrigger: trigger,
    endTrigger: trigger,
  };
}

/** Noche a la que pertenece un tramo: el día que empieza al mediodía anterior a su punto medio. */
function nightKey(start: number, end: number): string {
  const d = new Date((start + end) / 2 - 12 * HOUR);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Una noche principal por día.
 *
 * Con las señales del móvil, un mismo día deja varios huecos largos: la noche,
 * pero también la tarde sin tocar el móvil y la mañana tras levantarse. De
 * ellos sólo uno puede ser la noche; los demás sólo se proponen como siesta si
 * traen indicios propios (otra señal independiente —cargador, «no molestar»—
 * o, con sensores, oscuridad y quietud totales). Sin indicios no son sueño, y
 * proponerlos «con confianza baja» sólo llenaba la cola de cosas que corregir.
 *
 * La noche principal es la de mayor puntuación (a igualdad, la más larga), y
 * las noches ya registradas o pendientes cuentan como principales.
 */
function pickMainNights(
  results: DetectionResult[],
  known: KnownNight[],
): { kept: DetectionResult[]; dropped: DetectionResult[] } {
  const groups = new Map<string, DetectionResult[]>();
  for (const r of results) {
    const key = nightKey(r.session.start, r.session.end);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  // Lo mejor que ya hay en cada noche; una firme (sin `rank`) no se supera nunca.
  const held = new Map<string, number>();
  for (const k of known) {
    const key = nightKey(k.start, k.end);
    held.set(key, Math.max(held.get(key) ?? -Infinity, k.rank ?? Infinity));
  }
  const rank = (r: DetectionResult) => (r.score ?? 0.5) + Math.min(r.gapMs, 10 * HOUR) / (40 * HOUR);

  const kept: DetectionResult[] = [];
  const dropped: DetectionResult[] = [];
  for (const [key, group] of groups) {
    const ordered = [...group].filter((r) => !r.session.nap).concat(group.filter((r) => r.session.nap)).sort((a, b) => rank(b) - rank(a));
    const holds = held.get(key);
    ordered.forEach((r, i) => {
      if (r.session.nap) kept.push(r); // ya viene con sus indicios
      else if (i === 0 && (holds === undefined || rank(r) > holds + BETTER_NIGHT_MARGIN)) kept.push(r);
      else if (napEvidence(r)) kept.push(asNap(r));
      else dropped.push(r);
    });
  }
  return { kept: kept.sort((a, b) => a.session.start - b.session.start), dropped };
}

/**
 * ¿Trae el hueco indicios propios de ser sueño, más allá de que el móvil
 * estuviera quieto? Dos señales independientes que lo midan (pantalla más
 * cargador o «no molestar»; Doze es sólo la pantalla vista desde otro lado), o
 * con sensores, oscuridad y quietud totales.
 */
function napEvidence(r: DetectionResult): boolean {
  const triggers = new Set(r.session.triggers ?? []);
  const independent = (['screen', 'charger', 'dnd'] as TriggerId[]).filter((id) => triggers.has(id));
  if (independent.length >= 2) return true;
  const ev = r.evidence;
  return !!ev && ev.dark !== null && ev.dark >= 0.8 && (ev.moves ?? 0) === 0 && ev.sensors.length > 0;
}

/** La misma detección, marcada como siesta y sin pasar de confianza media. */
function asNap(r: DetectionResult): DetectionResult {
  return {
    ...r,
    session: {
      ...r.session,
      nap: true,
      confidence: r.session.confidence === 'high' ? 'medium' : r.session.confidence,
    },
  };
}

/** Lo que se escribe en el registro por cada motivo de descarte. */
const REJECT_TEXT: Record<RejectedGap['reason'], string> = {
  'trigger-off': 'el disparador está apagado',
  implausible: 'fuera de la ventana nocturna o demasiado corto',
  'too-long': 'más largo que una noche posible: probablemente una tarde despierto más la noche',
  'out-of-pattern': 'hueco corto fuera de tu hora de acostarte: móvil quieto, no sueño',
  secondary: 'ya hay una noche principal ese día y este hueco no trae indicios de siesta',
};

/**
 * Procesa los huecos que el servicio nativo registró con la app cerrada.
 *
 * Estos huecos son mejores que los deducidos por la propia app: miden el
 * tiempo real entre que el dispositivo deja de usarse y el usuario vuelve a
 * él, en vez del tiempo entre dos aperturas de PerfectRest. Aun así pasan por
 * el mismo filtro de plausibilidad, y sólo se descartan de la cola nativa
 * cuando ya se han entregado.
 */
export async function collectNativeGaps(
  settings: MonitorSettings,
  ctx: DetectionContext = {},
): Promise<DetectionResult[]> {
  if (!isBackgroundAvailable()) return [];

  const { gaps } = await readGaps();
  if (!gaps.length) return [];

  // El registro bruto sólo hace falta si hay sensores que cruzar con el hueco.
  const events =
    ctx.events ?? (activeSensors(settings).length ? await readRawEvents() : undefined);

  const processedUntil = gaps.reduce((max, gap) => Math.max(max, gap.end), 0);
  const { results, rejected } = evaluateGaps(gaps, settings, { ...ctx, events });

  for (const item of rejected) {
    if (item.reason === 'trigger-off' && item.trigger) {
      await logEvent(
        item.trigger,
        'discard',
        `el disparador «${TRIGGER_SHORT[item.trigger]}» se apagó después de registrar el hueco`,
        item.gap.end,
      );
    } else {
      // Sin esta línea, un hueco que el servicio sí midió pero que la
      // evaluación rechaza —por caer fuera de la ventana nocturna, casi
      // siempre— desaparecía sin dejar rastro, y parecía que el disparador no
      // había llegado a dispararse.
      await logEvent(
        item.trigger,
        'discard',
        discardReason(item.gap.end - item.gap.start, REJECT_TEXT[item.reason]),
        item.gap.end,
      );
    }
  }

  // Sólo se borra hasta el último hueco leído: si el servicio encoló uno nuevo
  // entre la lectura y el borrado, sobrevive hasta la vuelta siguiente.
  await clearGaps(processedUntil);
  return results;
}

/**
 * Disparador de horario: cuando una noche no ha dejado ninguna otra señal, se
 * propone la sesión que marcaría la meta del usuario, siempre con confianza
 * baja y a la espera de que la corrija. Es el último recurso, pensado para
 * quien duerme sin bloqueo de pantalla y pasa días sin abrir la app.
 *
 * Devuelve null si el disparador está apagado, si la noche todavía no ha
 * terminado, si ya hay algo registrado en esa franja o si ya se propuso antes.
 */
export function proposeFromSchedule(
  schedule: ScheduleSettings,
  settings: MonitorSettings,
  sessions: SleepSession[],
  lastProposalKey: string | null,
  now: number = Date.now(),
): { result: DetectionResult; key: string } | null {
  if (!triggerEnabled(settings, 'schedule')) return null;

  // La noche que acaba de terminar es la de la última hora de despertar ya
  // pasada: si la de hoy aún no ha llegado, se retrocede a la de ayer.
  const wake = new Date(now);
  const todayMins = parseTime(goalForDate(schedule, wake).wakeTime);
  wake.setHours(Math.floor(todayMins / 60), todayMins % 60, 0, 0);
  if (wake.getTime() > now) {
    const yesterday = new Date(now - 24 * HOUR);
    const mins = parseTime(goalForDate(schedule, yesterday).wakeTime);
    wake.setTime(yesterday.getTime());
    wake.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  }

  const wakeAt = wake.getTime();
  // Se dejan pasar un par de horas desde la hora de despertar: si el usuario
  // abre la app justo después, otra señal aún puede llegar y siempre es mejor.
  if (now - wakeAt < 2 * HOUR || now - wakeAt > 36 * HOUR) return null;

  const goal = goalForDate(schedule, wake);
  const start = wakeAt - goal.targetHours * HOUR;
  const key = wake.toDateString();
  if (lastProposalKey === key) return null;

  // Si algo cubre ya esa noche —detectado o registrado a mano— no hay nada que
  // proponer: el horario sólo rellena las noches sin datos.
  if (sessions.some((s) => start < s.end && s.start < wakeAt)) return null;

  return {
    key,
    result: {
      gapMs: wakeAt - start,
      session: {
        id: `schedule-${wakeAt}`,
        start,
        end: wakeAt,
        source: 'auto',
        confidence: 'low',
        confirmed: false,
        triggers: ['schedule'],
      },
    },
  };
}

/** Persiste el latido de actividad. */
export async function beat(now: number = Date.now()): Promise<void> {
  await saveRaw(HEARTBEAT_KEY, String(now));
}

/** Lee el último latido registrado. */
export async function readLastBeat(): Promise<number | null> {
  const raw = await loadRaw(HEARTBEAT_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Última noche propuesta por horario, para no repetirla en cada apertura. */
export async function readScheduleMark(): Promise<string | null> {
  return loadRaw(SCHEDULE_MARK_KEY);
}

export async function writeScheduleMark(key: string): Promise<void> {
  await saveRaw(SCHEDULE_MARK_KEY, key);
}

/** Anota en el registro la sesión que se acaba de proponer. */
async function logDetection(result: DetectionResult): Promise<void> {
  const ids = result.session.triggers ?? [];
  await logEvent(
    ids[0] ?? null,
    'detect',
    `${formatDuration(result.session.end - result.session.start)} · confianza ${
      result.session.confidence
    }${ids.length > 1 ? ` · ${ids.map((id) => TRIGGER_SHORT[id]).join(' + ')}` : ''}`,
    result.session.end,
  );
}

export interface MonitorHandle {
  stop: () => void;
  /** Fuerza una comprobación inmediata (p. ej. tras cambiar los ajustes). */
  check: () => Promise<void>;
}

export interface MonitorCallbacks {
  /** Cada sesión candidata nueva. */
  onDetect: (result: DetectionResult) => void;
  /** Último latido de la app, para que la UI lo refleje. */
  onBeat?: (ts: number) => void;
  /**
   * Último uso real del dispositivo según el servicio nativo. Es distinto del
   * latido: marca cuándo se usó el móvil, no cuándo se abrió la app.
   */
  onDeviceUse?: (ts: number) => void;
  /**
   * Una comprobación que no ha detectado nada. Es el punto donde el store
   * decide si aplicar el disparador de horario, que necesita datos que este
   * módulo no tiene (las metas y las sesiones ya registradas).
   */
  onQuiet?: (now: number) => void;
  /**
   * Contexto de la evaluación: tu hábito y las noches que ya hay. Lo tiene el
   * store, que es quien conoce las sesiones; este módulo no.
   */
  getContext?: () => DetectionContext;
}

/**
 * Arranca el monitor. Escucha el ciclo de vida de la app para saber cuándo
 * volver a evaluar; el trabajo real de vigilar el dispositivo lo hace el
 * servicio nativo, que sigue vivo con la app cerrada.
 */
export function startMonitor(
  getSettings: () => MonitorSettings,
  callbacks: MonitorCallbacks,
): MonitorHandle {
  let stopped = false;
  const listeners: Array<() => void> = [];
  const { onDetect, onBeat, onDeviceUse, onQuiet, getContext } = callbacks;

  const check = async () => {
    if (stopped) return;
    const settings = getSettings();
    const now = Date.now();
    const last = await readLastBeat();
    let detected = 0;

    // El registro del servicio se importa siempre, aunque la detección esté
    // apagada: si el usuario la desactivó sin querer, el registro es lo que se
    // lo enseña. Se funde con el de la web para leer una única historia.
    await pushEvents(await readNativeEvents());

    if (settings.enabled) {
      // Lo registrado en segundo plano tiene prioridad: es una medida directa
      // del uso del dispositivo, no una deducción a partir de la app.
      const native = activeNativeTriggers(settings).length
        ? await collectNativeGaps(settings, getContext?.() ?? {})
        : [];
      for (const result of native) {
        if (!stopped) {
          onDetect(result);
          await logDetection(result);
        }
      }
      detected += native.length;

      // El hueco entre aperturas de la app sólo se usa cuando el servicio
      // nativo no aportó nada, para no proponer la misma noche dos veces.
      if (!native.length && last !== null && triggerEnabled(settings, 'appOpen')) {
        const result = evaluateGap(last, now, settings, ['appOpen'], {
          habit: getContext?.().habit,
        });
        if (result) {
          onDetect(result);
          await logDetection(result);
          detected += 1;
        } else if (now - last >= settings.minGapMinutes * MINUTE) {
          // Sólo interesa anotar el hueco que llegó a ser largo y aun así se
          // rechazó. Los huecos de minutos entre dos aperturas normales
          // llenarían el registro sin decir nada.
          await logEvent(
            'appOpen',
            'discard',
            discardReason(now - last, 'fuera de la ventana nocturna'),
            now,
          );
        }
      }

      if (isBackgroundAvailable()) {
        const { lastUsedAt } = await readGaps();
        if (lastUsedAt > 0) onDeviceUse?.(lastUsedAt);
      }
    }

    await beat(now);
    onBeat?.(now);
    if (detected === 0 && settings.enabled && !stopped) onQuiet?.(now);
  };

  // Un latido periódico no evalúa huecos: sólo mantiene fresca la marca
  // mientras la app está delante del usuario.
  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    await beat(now);
    onBeat?.(now);
  };

  // Al volver del segundo plano es cuando el hueco resulta informativo.
  if (Capacitor.isNativePlatform()) {
    void App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void check();
      else void beat();
    }).then((h) => listeners.push(() => void h.remove()));
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') void check();
    else void beat();
  };
  document.addEventListener('visibilitychange', onVisibility);
  listeners.push(() => document.removeEventListener('visibilitychange', onVisibility));

  window.addEventListener('focus', onVisibility);
  listeners.push(() => window.removeEventListener('focus', onVisibility));

  const timer = window.setInterval(() => void tick(), HEARTBEAT_INTERVAL);
  void check();

  return {
    stop: () => {
      stopped = true;
      window.clearInterval(timer);
      listeners.forEach((off) => off());
    },
    check,
  };
}
