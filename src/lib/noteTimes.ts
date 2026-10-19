import { HOUR, MINUTE } from './time';
import type { SleepSession } from './types';

/**
 * Lo que el usuario cuenta de una noche en el comentario.
 *
 * Quien corrige la detección no suele editar la sesión: escribe «me acosté
 * sobre las 00:30» en la nota. Esa frase es la mejor medida real de cuándo
 * empezó el sueño que tiene la app, y tirarla era tirar justo el dato que
 * enseña a la detección cuánto se adelanta. Aquí se extrae lo que se pueda; lo
 * que no se entienda se ignora, nunca se inventa.
 */

export interface NoteTruth {
  /** Hora real de acostarse, si el comentario la da. */
  start: number | null;
  /** Hora real de levantarse, si la da. */
  end: number | null;
  /** «Es correcto», «tal cual»: los bordes de la sesión valen. */
  accepted: boolean;
  /** «No he dormido», «es falso»: ahí no hubo sueño. */
  notSleep: boolean;
}

const NO_TRUTH: NoteTruth = { start: null, end: null, accepted: false, notSleep: false };

/** «00:10», «1:00», «a las 12:30», «sobre 00:20», «a la 1:30». */
const CLOCK = /(?:\b(?:a|sobre|casi|hacia)\s+)?(?:las?\s+)?(\d{1,2})(?:[:.h](\d{2}))?/gi;

/** Primera hora del texto como [h, m], o null. Exige minutos o «las» delante. */
function clockIn(text: string): [number, number] | null {
  CLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLOCK.exec(text))) {
    const h = Number(m[1]);
    const min = m[2] === undefined ? 0 : Number(m[2]);
    const explicit = m[2] !== undefined || /\blas?\s+\d/i.test(m[0]);
    if (explicit && h <= 24 && min < 60) return [h % 24, min];
  }
  return null;
}

/**
 * Instante, a partir de `after`, en que el reloj marca `h:m`. Si la hora se
 * puede leer en formato de 12 horas («12:30» queriendo decir las 00:30) se
 * elige la que llega antes.
 */
function nextClock(after: number, h: number, m: number): number {
  const options = h <= 12 ? [h % 12, (h % 12) + 12] : [h];
  let best = Infinity;
  for (const hh of options) {
    const d = new Date(after);
    d.setHours(hh, m, 0, 0);
    while (d.getTime() < after) d.setDate(d.getDate() + 1);
    best = Math.min(best, d.getTime());
  }
  return best;
}

/**
 * Interpreta el comentario de una sesión. `rawStart` es el inicio medido por el
 * dispositivo: la hora de acostarse se busca a partir de una hora antes.
 */
export function parseNote(session: Pick<SleepSession, 'start' | 'end' | 'note' | 'detectedStart'>): NoteTruth {
  const note = session.note?.trim();
  if (!note) return NO_TRUTH;
  // Una frase por entrada: «Me levanté a las 8:00. A las 6:19 miré el móvil»
  // son dos hechos distintos y no deben leerse como uno.
  const lines = note.split(/\n+|(?<=[.!?])\s+/);
  const out: NoteTruth = { start: null, end: null, accepted: false, notSleep: false };
  const from = (session.detectedStart ?? session.start) - HOUR;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/\b(no (he )?dormido|no dorm[ií]|esto es falso|\bfalso\b)/.test(lower)) out.notSleep = true;
    if (/\bcorrect[oa]\b|\btal cual\b/.test(lower) && !/incorrect/.test(lower)) out.accepted = true;

    const hit = clockIn(line);
    if (!hit) continue;
    if (/(acost|dormir|dorm[ií]|me tumb|a la cama)/.test(lower) && !/despert|levant/.test(lower)) {
      const at = nextClock(from, hit[0], hit[1]);
      if (at < session.end - HOUR) out.start = at;
    } else if (/(levant|desperté|desperte|me desper)/.test(lower)) {
      // «Me levanté sobre las 8:00»: la hora de levantarse cae antes del final detectado.
      let at = nextClock(session.end - 14 * HOUR, hit[0], hit[1]);
      if (at > session.end + 30 * MINUTE) at -= 24 * HOUR;
      if (at > session.start) out.end = at;
    }
  }
  // «No he dormido» junto a una hora de acostarse habla del rato anterior a
  // ella, no de que la noche no existiera.
  const contradictory = out.accepted && out.notSleep && out.start === null && out.end === null;
  if (out.start !== null || out.end !== null || out.accepted) out.notSleep = false;
  // «No he dormido… Es correcto» se contradice (¿correcta la sesión, o correcto
  // que aún no durmió?): sin más datos no se puede usar ni a favor ni en contra.
  if (contradictory) out.accepted = false;
  return out;
}
