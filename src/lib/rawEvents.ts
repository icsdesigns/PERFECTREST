import { HOUR, MINUTE } from './time';
import type { SensorId } from './types';

/**
 * Registro bruto del servicio nativo.
 *
 * Distinto del registro de la detección (`triggerLog.ts`), que es prosa para
 * que una persona entienda qué pasó: éste es la materia prima, un evento por
 * línea con su instante y, a veces, un valor. Existe por dos razones. La
 * primera, que los sensores producen indicios que sólo cobran sentido al
 * cruzarlos con un hueco concreto (¿hubo pasos entre las 02:00 y las 07:00?),
 * y eso no se puede decidir al llegar el evento. La segunda, que afinar los
 * umbrales con datos reales exige poder verlos: se exporta tal cual junto al
 * historial de sueño.
 */

export type RawKind =
  | 'screen-off'
  | 'screen-on'
  /** El usuario quitó el cerrojo. */
  | 'unlock'
  | 'plug'
  | 'unplug'
  | 'idle-on'
  | 'idle-off'
  | 'dnd-on'
  | 'dnd-off'
  /** Pasos andados desde el evento anterior (v = cuántos). */
  | 'steps'
  /** Movimiento significativo, cuando no hay contador de pasos. */
  | 'motion'
  /** Cambio de nivel de luz (v: 0 oscuro, 1 tenue, 2 claro). */
  | 'light'
  /** Proximidad (v: 1 tapado, 0 libre). */
  | 'proximity'
  /** Audio sonando (v: 1) o no (v: 0). */
  | 'audio'
  /** Próxima alarma del reloj (v = instante en que sonará; 0 si no hay). */
  | 'alarm';

export interface RawEvent {
  at: number;
  kind: RawKind;
  v?: number;
}

/** Niveles de luz que registra el servicio. */
export const LIGHT_DARK = 0;
export const LIGHT_DIM = 1;
export const LIGHT_BRIGHT = 2;

/** Qué sensor produce cada tipo de evento (los de pantalla, cargador… no tienen). */
export const SENSOR_OF_KIND: Partial<Record<RawKind, SensorId>> = {
  steps: 'steps',
  motion: 'steps',
  light: 'light',
  proximity: 'proximity',
  audio: 'audio',
  alarm: 'alarm',
};

/** Normaliza lo que devuelve el plugin: descarta basura y ordena por hora. */
export function cleanRawEvents(raw: unknown): RawEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: RawEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { at, kind, v } = item as { at?: unknown; kind?: unknown; v?: unknown };
    if (typeof at !== 'number' || !Number.isFinite(at) || typeof kind !== 'string') continue;
    out.push({ at, kind: kind as RawKind, ...(typeof v === 'number' ? { v } : {}) });
  }
  return out.sort((a, b) => a.at - b.at);
}

// --- Indicios de un hueco ---------------------------------------------------

/**
 * Lo que los sensores dicen de un hueco concreto. Todos los campos son
 * opcionales a propósito: sin sensor activo, o sin eventos en el tramo, no hay
 * indicio, y «no hay indicio» no es lo mismo que «indicio en contra».
 */
export interface GapEvidence {
  /**
   * Último momento de actividad real antes de la quietud larga: el último paseo,
   * la última luz encendida, el último audio. Es el mejor candidato a «me fui a
   * dormir», y suele ser muy posterior al último uso del móvil.
   */
  activityAt: number | null;
  /** Primer despertar real dentro del hueco: pasos o movimiento sostenidos, o la alarma. */
  wakeAt: number | null;
  /** Fracción (0-1) del sueño estimado con luz apagada; null sin datos de luz. */
  dark: number | null;
  /** Episodios de actividad sostenida *dentro* de la noche (levantarse a andar). */
  moves: number | null;
  /** Hora de la alarma que sonó cerca del final, si la hubo. */
  alarmAt: number | null;
  /** ¿Hay alarma programada y cae cerca del final de la noche? null sin datos de alarma. */
  alarmMatch: boolean | null;
  /** Sensores que han aportado datos a este hueco. */
  sensors: SensorId[];
}

export const NO_EVIDENCE: GapEvidence = {
  activityAt: null,
  wakeAt: null,
  dark: null,
  moves: null,
  alarmAt: null,
  alarmMatch: null,
  sensors: [],
};

/** Un indicio de actividad: un tramo en el que seguro hay alguien despierto. */
interface Span {
  from: number;
  to: number;
  /** Cuántos eventos lo componen (un solo paso no es un paseo). */
  weight: number;
  /** Viene de la luz: vale para saber cuándo se apagó, no para saber cuándo se despertó. */
  light: boolean;
}

/** Eventos separados por menos de esto pertenecen al mismo episodio. */
const EPISODE_JOIN_MS = 10 * MINUTE;
/** Cada evento puntual cubre este tiempo (un minuto de pasos, un cambio de proximidad). */
const POINT_SPAN_MS = 60_000;
/** Un episodio dura al menos esto, o suma suficientes eventos, para contar. */
const EPISODE_MIN_MS = 8 * MINUTE;
const EPISODE_MIN_WEIGHT = 6;
/** Lo que se da por sonando a un audio detectado sin su evento de parada. */
const AUDIO_HOLD_MS = 15 * MINUTE;
/** Un sueño nocturno no cabe en menos de esto: sirve para no cortar el hueco por el principio. */
const MIN_SLEEP_MS = 4 * HOUR;

/**
 * Convierte los eventos del tramo en episodios de actividad.
 *
 * Un episodio sólo cuenta si es *sostenido*: ir al baño a las tres de la
 * madrugada son veinte pasos y una luz encendida un par de minutos, y no
 * rompe la noche; levantarse son diez minutos de pasos seguidos.
 */
function episodes(events: RawEvent[], from: number, to: number, enabled: SensorId[]): Span[] {
  const spans: Span[] = [];
  const has = (id: SensorId) => enabled.includes(id);

  let bright: number | null = null;
  let audioOn: number | null = null;
  const closeBright = (at: number) => {
    if (bright !== null) spans.push({ from: bright, to: at, weight: 1, light: true });
    bright = null;
  };
  // La luz ya estaba encendida cuando empezó el hueco: el episodio arranca ahí.
  if (has('light')) {
    const prior = [...events].reverse().find((e) => e.kind === 'light' && e.at < from);
    if (prior && (prior.v ?? 0) >= LIGHT_BRIGHT) bright = from;
  }

  for (const e of events) {
    if (e.at < from || e.at > to) continue;
    switch (e.kind) {
      case 'steps':
        if (has('steps') && (e.v ?? 1) > 0)
          spans.push({ from: e.at, to: e.at + POINT_SPAN_MS, weight: 1, light: false });
        break;
      case 'motion':
        if (has('steps'))
          spans.push({ from: e.at, to: e.at + POINT_SPAN_MS, weight: 2, light: false });
        break;
      case 'proximity':
        if (has('proximity'))
          spans.push({ from: e.at, to: e.at + POINT_SPAN_MS / 2, weight: 1, light: false });
        break;
      case 'light':
        if (!has('light')) break;
        if ((e.v ?? 0) >= LIGHT_BRIGHT) bright ??= e.at;
        else closeBright(e.at);
        break;
      case 'audio':
        if (!has('audio')) break;
        if ((e.v ?? 0) > 0) audioOn ??= e.at;
        else if (audioOn !== null) {
          spans.push({ from: audioOn, to: e.at, weight: EPISODE_MIN_WEIGHT, light: false });
          audioOn = null;
        }
        break;
    }
  }
  if (audioOn !== null)
    spans.push({ from: audioOn, to: Math.min(to, audioOn + AUDIO_HOLD_MS), weight: EPISODE_MIN_WEIGHT, light: false });
  // Una luz clara sin su apagado dura hasta el final del tramo mirado.
  if (bright !== null) spans.push({ from: bright, to, weight: 1, light: true });

  return spans.sort((a, b) => a.from - b.from);
}

interface Episode {
  from: number;
  to: number;
  weight: number;
  lightOnly: boolean;
}

function joinEpisodes(spans: Span[]): Episode[] {
  const out: Episode[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.from - last.to <= EPISODE_JOIN_MS) {
      last.to = Math.max(last.to, s.to);
      last.weight += s.weight;
      last.lightOnly = last.lightOnly && s.light;
    } else {
      out.push({ from: s.from, to: s.to, weight: s.weight, lightOnly: s.light });
    }
  }
  return out;
}

const sustained = (ep: Episode) => ep.to - ep.from >= EPISODE_MIN_MS || ep.weight >= EPISODE_MIN_WEIGHT;

/**
 * Cruza los eventos con un hueco y extrae lo que dicen de él.
 *
 *  - **activityAt**: fin del último episodio sostenido en la primera parte del
 *    hueco (la que deja al menos cuatro horas de sueño por detrás). Incluye la
 *    luz clara, porque la luz que se apaga es precisamente la señal de acostarse.
 *  - **wakeAt**: inicio del primer episodio sostenido, sin contar la luz, que
 *    sale sola con el amanecer, después de al menos cuatro horas de sueño; o la
 *    alarma, si sonó y la pantalla se encendió a esa hora.
 *  - **moves**: episodios sostenidos entre ambos extremos.
 *  - **dark**: parte del tiempo dormido con luz apagada.
 */
export function gatherEvidence(
  events: RawEvent[],
  start: number,
  end: number,
  enabled: SensorId[],
): GapEvidence {
  if (!enabled.length || !events.length || end <= start) return NO_EVIDENCE;

  const used = new Set<SensorId>();
  const inGap = events.filter((e) => e.at >= start - HOUR && e.at <= end);
  for (const e of inGap) {
    const sensor = SENSOR_OF_KIND[e.kind];
    if (sensor && enabled.includes(sensor)) used.add(sensor);
  }

  const eps = joinEpisodes(episodes(inGap, start, end, enabled)).filter(sustained);

  // Última actividad real, en la primera parte.
  const head = eps.filter((ep) => ep.to <= end - MIN_SLEEP_MS);
  const activityAt = head.length ? Math.max(start, head[head.length - 1].to) : null;
  const sleepFrom = activityAt ?? start;

  // Primer despertar real, en la última parte.
  const tail = eps.filter((ep) => !ep.lightOnly && ep.from >= sleepFrom + MIN_SLEEP_MS && ep.from <= end - 20 * MINUTE);
  let wakeAt: number | null = tail.length ? tail[0].from : null;

  // La alarma: la última programada antes de la noche. Si sonó dentro del
  // hueco y la pantalla se encendió entonces, ahí se despertó (aunque no
  // desbloqueara el móvil hasta mucho después).
  let alarmAt: number | null = null;
  let alarmMatch: boolean | null = null;
  if (enabled.includes('alarm')) {
    const alarms = events.filter((e) => e.kind === 'alarm' && e.at <= end && (e.v ?? 0) > 0);
    if (alarms.length) {
      used.add('alarm');
      // Cualquier alarma anotada durante o antes de la noche que caiga cerca del final.
      const times = [...new Set(alarms.map((e) => e.v as number))];
      const near = times.filter((t) => t >= end - 5 * HOUR && t <= end + 30 * MINUTE);
      alarmMatch = near.some((t) => Math.abs(end - t) <= HOUR);
      const rang = near
        .filter((t) => t > sleepFrom + MIN_SLEEP_MS && t < end - 20 * MINUTE)
        .filter((t) =>
          events.some(
            (e) => e.kind === 'screen-on' && e.at >= t - 2 * MINUTE && e.at <= t + 15 * MINUTE,
          ),
        );
      if (rang.length) {
        alarmAt = Math.min(...rang);
        wakeAt = wakeAt === null ? alarmAt : Math.min(wakeAt, alarmAt);
      }
    } else {
      alarmMatch = false;
    }
  }

  // Quietud interior.
  const wakeBound = wakeAt ?? end;
  const moves = used.has('steps') || used.has('proximity') || used.has('audio')
    ? eps.filter((ep) => !ep.lightOnly && ep.from > sleepFrom && ep.from < wakeBound).length
    : null;

  // Oscuridad: el nivel de luz se mantiene hasta el evento siguiente.
  let dark: number | null = null;
  if (enabled.includes('light')) {
    const lights = events.filter((e) => e.kind === 'light' && e.at <= wakeBound);
    if (lights.length) {
      let t = sleepFrom;
      let level = LIGHT_BRIGHT;
      for (const e of lights) if (e.at <= sleepFrom) level = e.v ?? level;
      let darkMs = 0;
      for (const e of lights.filter((x) => x.at > sleepFrom)) {
        if (level === LIGHT_DARK) darkMs += e.at - t;
        t = e.at;
        level = e.v ?? level;
      }
      if (level === LIGHT_DARK) darkMs += wakeBound - t;
      dark = wakeBound > sleepFrom ? Math.min(1, darkMs / (wakeBound - sleepFrom)) : null;
    }
  }

  return {
    activityAt,
    wakeAt,
    dark,
    moves,
    alarmAt,
    alarmMatch,
    sensors: [...used],
  };
}
