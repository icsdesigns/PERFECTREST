import type { MonitorSettings, SensorId } from './types';

/**
 * Catálogo de sensores opcionales de la detección (Módulo 3, fase 2).
 *
 * Los disparadores miden *cuándo se usa el móvil*; los sensores miden *qué
 * pasa alrededor de él* mientras no se usa. Eso es lo que falta para afinar
 * los bordes de la noche: el último uso del móvil suele ser una o dos horas
 * anterior a dormirse de verdad (se apaga la pantalla y se sigue despierto),
 * y la primera vez que se vuelve a coger puede ser muy posterior a levantarse.
 *
 * Todos son nativos, de muestreo muy ligero y desactivados por defecto: el
 * usuario decide cuáles activa. Cada uno se degrada con elegancia si el móvil
 * no tiene el sensor o falta el permiso (ver `SensorAvailability`). Ninguno
 * usa el micrófono: «audio» sólo pregunta al sistema si hay algo sonando.
 */

export interface SensorSpec {
  id: SensorId;
  label: string;
  hint: string;
  /** Pide un permiso en tiempo de ejecución (sólo «steps», en Android 10+). */
  needsPermission: boolean;
}

export const SENSORS: SensorSpec[] = [
  {
    id: 'steps',
    label: 'Pasos y movimiento',
    hint: 'Detecta que te levantas o sigues andando por casa: ajusta cuándo empiezas a dormir y cuándo despiertas. Pide el permiso «Actividad física»; sin él usa sólo el movimiento significativo, menos fino.',
    needsPermission: true,
  },
  {
    id: 'light',
    label: 'Luz ambiente',
    hint: 'Apagar la luz de la habitación es la señal más clara de que te vas a dormir. Sólo anota si hay luz u oscuridad, nunca imágenes.',
    needsPermission: false,
  },
  {
    id: 'proximity',
    label: 'Proximidad',
    hint: 'Sabe si el móvil está tapado (bolsillo, mesilla boca abajo) y cuándo lo vuelves a coger, aunque no lo desbloquees.',
    needsPermission: false,
  },
  {
    id: 'alarm',
    label: 'Próxima alarma',
    hint: 'Lee la hora de tu próxima alarma del reloj para saber a qué hora esperas despertar. Si coincide con el final de la noche, la propuesta sube de confianza.',
    needsPermission: false,
  },
  {
    id: 'audio',
    label: 'Audio sonando',
    hint: 'Si hay música, un pódcast o un vídeo sonando con la pantalla apagada, aún no te has dormido. No usa el micrófono: sólo pregunta al sistema si algo suena.',
    needsPermission: false,
  },
];

export const SENSOR_BY_ID: Record<SensorId, SensorSpec> = Object.fromEntries(
  SENSORS.map((s) => [s.id, s]),
) as Record<SensorId, SensorSpec>;

/** Todos apagados en una instalación nueva: son opt-in. */
export const DEFAULT_SENSORS: Record<SensorId, boolean> = Object.fromEntries(
  SENSORS.map((s) => [s.id, false]),
) as Record<SensorId, boolean>;

/** ¿Está este sensor activo? Respeta el interruptor general del monitor. */
export function sensorEnabled(settings: MonitorSettings, id: SensorId): boolean {
  if (!settings.enabled) return false;
  return settings.sensors?.[id] ?? false;
}

/** Los sensores que el usuario tiene activos ahora mismo. */
export function activeSensors(settings: MonitorSettings): SensorId[] {
  return SENSORS.filter((s) => sensorEnabled(settings, s.id)).map((s) => s.id);
}

/**
 * Qué puede hacer cada sensor en este móvil. «steps» tiene dos modos porque
 * el contador de pasos exige permiso y el movimiento significativo no.
 */
export interface SensorAvailability {
  /** El móvil tiene el sensor (o, para alarma y audio, la API). */
  available: boolean;
  /** Falta un permiso para que funcione del todo. */
  needsPermission?: boolean;
  /** Cómo está funcionando ahora mismo, cuando hay más de un modo. */
  mode?: 'steps' | 'motion' | 'none';
}

export type SensorStatus = Record<SensorId, SensorAvailability>;

export const NO_SENSORS: SensorStatus = {
  steps: { available: false, mode: 'none' },
  light: { available: false },
  proximity: { available: false },
  alarm: { available: false },
  audio: { available: false },
};
