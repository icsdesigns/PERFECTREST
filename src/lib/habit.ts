import { goalForDate } from './schedule';
import { DAY, HOUR, MINUTE } from './time';
import { parseNote } from './noteTimes';
import type { ScheduleSettings, SleepSession } from './types';

/**
 * Lo que la app sabe de ti sin que se lo cuentes: a qué hora sueles acostarte
 * y levantarte, y cuánto se adelanta de media la señal del móvil a tu sueño
 * real. Son los dos números que más pesan al juzgar si un hueco es una noche
 * o una tarde de inactividad, y los dos salen de las sesiones ya registradas.
 */

export interface SleepHabit {
  /** Hora habitual de acostarse, minutos desde medianoche. */
  startMin: number;
  /** Hora habitual de levantarse, minutos desde medianoche. */
  endMin: number;
  /** Cuántas noches respaldan estos números; 0 si salen del horario. */
  n: number;
  /**
   * Cuánto varía tu hora de acostarte de una noche a otra (desviación típica
   * circular, en minutos). Sólo con hábito aprendido.
   */
  spreadMin?: number;
}

/** Noches mínimas para fiarse del hábito aprendido en vez del horario. */
const MIN_HABIT_NIGHTS = 4;
/** Noches con hora real conocida mínimas para aprender la latencia. */
const MIN_LATENCY_SAMPLES = 4;
/** Una noche tiene que parecerlo para enseñar el hábito. */
const MIN_NIGHT_MS = 4.5 * HOUR;
const MAX_NIGHT_MS = 12.5 * HOUR;
/** Latencia de sueño creíble: más allá no es conciliar el sueño, es seguir despierto. */
const MAX_LATENCY_MIN = 90;

const minutesOfDay = (ts: number) => {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
};

/** Media circular de horas del día (23:50 y 00:10 dan 00:00, no 12:00). */
export function circularMean(minutes: number[]): number {
  let x = 0;
  let y = 0;
  for (const m of minutes) {
    const a = (m / 1440) * 2 * Math.PI;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  const angle = Math.atan2(y, x);
  return (((angle / (2 * Math.PI)) * 1440) % 1440 + 1440) % 1440;
}

/** Desviación típica circular de horas del día, en minutos (0 si todas coinciden). */
export function circularSpread(minutes: number[]): number {
  if (!minutes.length) return 0;
  let x = 0;
  let y = 0;
  for (const m of minutes) {
    const a = (m / 1440) * 2 * Math.PI;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  const r = Math.min(1, Math.hypot(x, y) / minutes.length);
  if (r <= 0) return 720;
  return (Math.sqrt(-2 * Math.log(r)) * 1440) / (2 * Math.PI);
}

/** Diferencia con signo entre dos horas del día, en minutos, en (-720, 720]. */
export function minuteDiff(a: number, b: number): number {
  let d = (a - b) % 1440;
  if (d > 720) d -= 1440;
  if (d <= -720) d += 1440;
  return d;
}

/**
 * La hora real de acostarse de una sesión, cuando la hay: la que el usuario
 * escribió en el comentario o, si editó el inicio, la editada. Las sesiones
 * detectadas y sin tocar no cuentan: su inicio es justo lo que se quiere
 * medir.
 */
export function knownStart(s: SleepSession): number | null {
  const truth = parseNote(s);
  if (truth.start !== null) return truth.start;
  // La hora habitual que el usuario aplicó con un toque salió del propio
  // hábito: aprender de ella lo reforzaría a sí mismo sin aportar nada nuevo.
  if (s.habitStart) return null;
  if (s.source === 'edited' || s.source === 'manual') return s.start;
  return null;
}

/** Una noche tiene que dejar al menos esto de sueño para ofrecer la hora habitual como inicio. */
const HABIT_OFFER_MIN_MS = 3 * HOUR;
/** Por debajo de esta diferencia con el inicio actual, ofrecer la hora habitual no cambia nada. */
const HABIT_OFFER_MIN_SHIFT_MS = 10 * MINUTE;

/**
 * La hora habitual de acostarte puesta en la noche de esta sesión, para el
 * botón «¿Desde las 23:40, como sueles?» de las propuestas de inicio dudoso.
 *
 * Es la ocurrencia de esa hora del día más cercana al inicio propuesto que deja
 * entre tres y trece horas de sueño hasta el despertar. Sólo hay oferta con un
 * hábito *aprendido* de tus noches (`n > 0`), no con la meta del horario, y
 * sólo si cambia el inicio de verdad. Nunca se aplica sola: es el usuario quien
 * la toca.
 */
export function habitualStart(
  session: Pick<SleepSession, 'start' | 'end'>,
  habit: SleepHabit | null | undefined,
): number | null {
  if (!habit || habit.n <= 0) return null;
  const minutes = Math.round(habit.startMin) % 1440;
  const end = new Date(session.end);
  let best: number | null = null;
  for (const back of [0, 1, 2]) {
    const c = new Date(end);
    c.setDate(end.getDate() - back);
    c.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    const t = c.getTime();
    const sleep = session.end - t;
    if (sleep < HABIT_OFFER_MIN_MS || sleep > MAX_NIGHT_MS + 30 * MINUTE) continue;
    if (best === null || Math.abs(t - session.start) < Math.abs(best - session.start)) best = t;
  }
  if (best === null || Math.abs(best - session.start) < HABIT_OFFER_MIN_SHIFT_MS) return null;
  return best;
}

/** Inicio medido por el dispositivo; para sesiones viejas, el que recuerda el id. */
export function detectedStartOf(s: SleepSession): number | null {
  if (s.detectedStart !== undefined) return s.detectedStart;
  const m = /^auto-(\d{10,})$/.exec(s.id);
  return m ? Number(m[1]) : null;
}

/**
 * Hábito de sueño: de las noches registradas si hay suficientes, del horario
 * objetivo si no. Se alimenta de sesiones manuales, editadas, con hora real en
 * el comentario o aceptadas («es correcto») — nunca del inicio crudo de una
 * detección sin revisar, que es justo el que se quiere corregir.
 */
export function learnHabit(
  sessions: SleepSession[],
  schedule: ScheduleSettings,
  now: number = Date.now(),
): SleepHabit {
  const starts: number[] = [];
  const ends: number[] = [];

  for (const s of sessions) {
    const len = s.end - s.start;
    if (len < MIN_NIGHT_MS || len > MAX_NIGHT_MS) continue;
    const truth = parseNote(s);
    if (truth.notSleep) continue;
    const start = knownStart(s) ?? (truth.accepted ? s.start : null);
    if (start === null) continue;
    starts.push(minutesOfDay(start));
    ends.push(minutesOfDay(truth.end ?? s.end));
  }

  if (starts.length >= MIN_HABIT_NIGHTS) {
    return {
      startMin: circularMean(starts),
      endMin: circularMean(ends),
      n: starts.length,
      spreadMin: circularSpread(starts),
    };
  }

  // Sin historial: lo que dice el horario para mañana (hora de despertar menos horas objetivo).
  const goal = goalForDate(schedule, new Date(now + DAY));
  const [h, m] = goal.wakeTime.split(':').map(Number);
  const endMin = (h || 0) * 60 + (m || 0);
  const startMin = (((endMin - Math.round(goal.targetHours * 60)) % 1440) + 1440) % 1440;
  return { startMin, endMin, n: 0 };
}

/**
 * Cuánto se adelanta el último uso del móvil a dormirse de verdad, en minutos.
 * Es la mediana de (hora real de acostarse − inicio medido) en las noches que
 * el usuario ha corregido; `null` si todavía son pocas. La mediana, no la
 * media: una noche de tertulia hasta las tres no debe mover la estimación de
 * las demás.
 */
export function learnLatency(sessions: SleepSession[]): number | null {
  const samples: number[] = [];
  for (const s of sessions) {
    // Una sesión aceptada tal cual («correcto») también es una medida: dice que
    // el inicio corregido era el bueno. Sin ella sólo enseñaban las noches que
    // salieron mal, y la latencia aprendida se inflaba justo con los errores.
    const truth = parseNote(s);
    const real = knownStart(s) ?? (truth.accepted && !truth.notSleep ? s.start : null);
    const detected = detectedStartOf(s);
    if (real === null || detected === null) continue;
    const delta = (real - detected) / MINUTE;
    // Sólo cuenta lo que tarda uno en dormirse. Un desfase de horas es el rato
    // que se pasó despierto sin tocar el móvil, y de eso se ocupa el hábito.
    if (delta < 0 || delta > MAX_LATENCY_MIN) continue;
    samples.push(delta);
  }
  if (samples.length < MIN_LATENCY_SAMPLES) return null;
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return samples.length % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;
}
