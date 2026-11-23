import type { MonitorSettings, TriggerId } from './types';

/**
 * Catálogo de disparadores de la detección automática (Módulo 3).
 *
 * Cada disparador es una señal independiente de que el usuario ha dejado de
 * usar el dispositivo y ha vuelto a él. Se activan por separado desde Ajustes
 * porque no todos encajan con todo el mundo: quien no carga el móvil de noche
 * no quiere la señal del cargador.
 *
 * `native` marca los que dependen del servicio en segundo plano del APK: en el
 * navegador se muestran como no disponibles y nunca se evalúan.
 *
 * Tener varios activos no es redundancia: cada uno se rompe por su lado. La
 * pantalla no sirve a quien duerme sin bloqueo y el cargador no sirve a quien
 * no carga de noche. Lo que uno pierde, otro lo cubre, y cuando dos
 * coinciden sobre la misma noche la propuesta sube de confianza.
 */

export interface TriggerSpec {
  id: TriggerId;
  label: string;
  hint: string;
  /** Requiere el servicio nativo (APK); en el navegador no está disponible. */
  native: boolean;
  /** Valor por defecto en una instalación nueva. */
  defaultOn: boolean;
  /**
   * Cómo de directa es la señal respecto al sueño real. Se usa para ordenar
   * los disparadores de una detección y para puntuar la confianza.
   */
  directness: number;
}

export const TRIGGERS: TriggerSpec[] = [
  {
    id: 'screen',
    label: 'Bloqueo y desbloqueo del móvil',
    hint: 'Mide el tiempo real entre que apagas la pantalla y vuelves a desbloquear. Es la señal más fiable.',
    native: true,
    defaultOn: true,
    directness: 3,
  },
  {
    id: 'charger',
    label: 'Poner el móvil a cargar',
    hint: 'Enchufarlo de noche marca el inicio y desenchufarlo por la mañana el final. Útil si duermes con el móvil cargando.',
    native: true,
    defaultOn: false,
    directness: 2,
  },
  {
    id: 'appOpen',
    label: 'Apertura de la app',
    hint: 'El hueco entre dos veces que abres PerfectRest. Es lo único que funciona en el navegador, y el respaldo si Android para el servicio.',
    native: false,
    defaultOn: true,
    directness: 1,
  },
];

export const TRIGGER_BY_ID: Record<TriggerId, TriggerSpec> = Object.fromEntries(
  TRIGGERS.map((t) => [t.id, t]),
) as Record<TriggerId, TriggerSpec>;

export const DEFAULT_TRIGGERS: Record<TriggerId, boolean> = Object.fromEntries(
  TRIGGERS.map((t) => [t.id, t.defaultOn]),
) as Record<TriggerId, boolean>;

/**
 * ¿Está este disparador activo? Comprueba también el interruptor general del
 * monitor, para que apagarlo silencie todos los disparadores de una vez.
 */
export function triggerEnabled(settings: MonitorSettings, id: TriggerId): boolean {
  if (!settings.enabled) return false;
  // Un disparador retirado (de un hueco o una sesión antiguos) ya no está activo.
  const spec = TRIGGER_BY_ID[id];
  if (!spec) return false;
  return settings.triggers?.[id] ?? spec.defaultOn;
}

/** Ordena por lo directa que es la señal: primero la más fiable. */
export function sortTriggers(ids: TriggerId[]): TriggerId[] {
  return [...new Set(ids)].filter((id) => id in TRIGGER_BY_ID).sort(
    (a, b) => TRIGGER_BY_ID[b].directness - TRIGGER_BY_ID[a].directness,
  );
}

/** Etiqueta corta para mostrar el origen de una sesión detectada. */
export const TRIGGER_SHORT: Record<TriggerId, string> = {
  screen: 'pantalla',
  charger: 'cargador',
  appOpen: 'app',
};

/** "pantalla + cargador" para la ficha de la sesión. */
export function describeTriggers(ids: TriggerId[] | undefined): string | null {
  if (!ids || !ids.length) return null;
  const known = sortTriggers(ids);
  return known.length ? known.map((id) => TRIGGER_SHORT[id]).join(' + ') : null;
}
