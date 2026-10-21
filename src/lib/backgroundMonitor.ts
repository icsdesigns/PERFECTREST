import { Capacitor, registerPlugin } from '@capacitor/core';
import { cleanRawEvents, type RawEvent } from './rawEvents';
import { NO_SENSORS, type SensorStatus } from './sensors';
import type { SensorId, TriggerEvent, TriggerId } from './types';

/**
 * Acceso al servicio nativo de monitorización en segundo plano.
 *
 * En el APK, un servicio en primer plano escucha los eventos del dispositivo
 * mientras la app está cerrada —apagado de pantalla, desbloqueo, conexión y
 * desconexión del cargador— y va acumulando los huecos de inactividad, cada
 * uno etiquetado con el disparador que lo abrió y el que lo cerró.
 *
 * En el navegador el plugin no existe: todas las funciones degradan a un
 * comportamiento neutro y sólo queda la detección al reabrir la app.
 */

export interface NativeGap {
  start: number;
  end: number;
  /** Disparador que marcó el inicio de la inactividad. */
  startTrigger: TriggerId;
  /** Disparador que la cerró. */
  endTrigger: TriggerId;
  /**
   * Micro-despertares: desbloqueos de segundos dentro de la noche que el
   * servicio no tomó por el final porque el uso no llegó a ser sostenido.
   */
  wakes?: number[];
}

/**
 * Comentario escrito con el botón «Comentar» del aviso al despertar. Llega
 * atado al intervalo del hueco, porque cuando se escribe la sesión aún no
 * existe: se adjunta a la que se solape con él.
 */
export interface NativeNote {
  id: number;
  start: number;
  end: number;
  note: string;
  /** Cuándo se escribió (epoch ms). */
  at: number;
}

/**
 * Estado de todo lo que la detección necesita para funcionar.
 *
 * Va junto a propósito: ninguno de estos permisos falla con un error visible.
 * Sin ellos la app simplemente no detecta nada, que desde fuera es idéntico a
 * una noche sin señal, y el usuario no tiene forma de distinguir una cosa de
 * la otra. Ésta es esa forma.
 */
export interface MonitorStatus {
  running: boolean;
  enabled: boolean;
  /**
   * false cuando Android sigue aplicando optimización de batería a la app.
   * Es la causa más común de que el servicio deje de recibir eventos por la
   * noche, así que la UI lo expone y ofrece pedir la exención.
   */
  batteryExempt: boolean;
  /**
   * Permiso de notificaciones concedido **y** notificaciones de la app
   * habilitadas. Sin él no hay servicio en primer plano visible ni aviso al
   * despertar.
   */
  notifications: boolean;
  /**
   * Alarmas exactas permitidas. Sin ellas la alarma de vigilancia se degrada a
   * inexacta, Doze la agrupa y el servicio puede pasar la noche sin rearmarse.
   */
  exactAlarms: boolean;
  /** Último uso real del dispositivo detectado por el servicio (epoch ms). */
  lastUsedAt: number;
  /** Cuándo entró el servicio en primer plano por última vez. */
  startedAt: number;
  /** Último latido del servicio: prueba de que sigue escuchando eventos. */
  aliveAt: number;
  /** Último hueco de inactividad encolado. */
  lastGapAt: number;
  /** Por qué no pudo hacer su trabajo, cuando lo hay. */
  lastError: string | null;
}

/**
 * Lo que el servicio sabe del móvil ahora mismo. Todos los campos son
 * opcionales: el servicio omite lo que no puede leer. Sin identificadores,
 * ubicación ni nombres de redes o dispositivos.
 */
export interface DeviceSnapshot {
  device?: {
    model?: string;
    manufacturer?: string;
    sdk?: number;
    release?: string;
    locale?: string;
    tz?: string;
    tzOffsetMin?: number;
    app?: string;
  };
  state?: Record<string, number | boolean | undefined>;
  sensors?: Partial<SensorStatus>;
}

interface SleepMonitorPlugin {
  start(options: {
    minGapMinutes: number;
    /** Disparadores nativos activos; el servicio ignora el resto de eventos. */
    triggers: TriggerId[];
    /** Avisar con la estimación al cerrarse la noche. */
    wakeSummary: boolean;
    /** Ventana nocturna en minutos desde medianoche, para filtrar ese aviso. */
    nightStartMinutes: number;
    nightEndMinutes: number;
    /** Sensores opcionales activos; el servicio sólo registra los de la lista. */
    sensors?: SensorId[];
    /** Muestrear el estado del dispositivo para el contexto de cada noche. */
    deviceContext?: boolean;
  }): Promise<{ running: boolean }>;
  stop(): Promise<{ running: boolean }>;
  isRunning(): Promise<MonitorStatus>;
  diagnostics(): Promise<MonitorStatus>;
  getGaps(): Promise<{ gaps: NativeGap[]; lastUsedAt: number; screenOffAt: number }>;
  /** Borra los huecos ya procesados; `until` evita perder los recién llegados. */
  clearGaps(options: { until: number }): Promise<void>;
  /** Comentarios del aviso al despertar que aún no tienen sesión. */
  getNotes(): Promise<{ notes: NativeNote[] }>;
  removeNotes(options: { ids: number[] }): Promise<void>;
  /** Publica el aviso al despertar nativo, con su botón «Comentar». */
  notifySummary(options: { start: number; end: number }): Promise<void>;
  /** Registro bruto (pantalla, cargador, sensores), para cruzarlo con los huecos y exportarlo. */
  getRawEvents(): Promise<{ events: RawEvent[] }>;
  clearRawEvents(): Promise<void>;
  /** Datos estáticos del móvil y estado de ahora mismo, para el contexto de la noche. */
  getDeviceSnapshot(): Promise<DeviceSnapshot>;
  /** Qué sensores tiene el móvil y cuáles puede usar con los permisos actuales. */
  sensorStatus(): Promise<{ sensors: SensorStatus }>;
  /** Pide el permiso «Actividad física» (pasos). Devuelve si quedó concedido. */
  requestSensorPermission(): Promise<{ granted: boolean }>;
  /** Registro de eventos del servicio, para el diagnóstico de Ajustes. */
  getEvents(): Promise<{ events: TriggerEvent[] }>;
  clearEvents(): Promise<void>;
  /** Inyecta un hueco de prueba que recorre la tubería real de detección. */
  simulateGap(options: { trigger: TriggerId; minutesAgo: number }): Promise<{
    start: number;
    end: number;
  }>;
  /** Abre el diálogo del sistema para eximir a la app del ahorro de batería. */
  requestBatteryExemption(): Promise<{ requested: boolean }>;
  /** Abre la pantalla de «alarmas y recordatorios» del sistema. */
  requestExactAlarms(): Promise<{ requested: boolean }>;
  /** Ficha de la app en ajustes: la única salida a un permiso denegado para siempre. */
  openAppSettings(): Promise<{ opened: boolean }>;
  openNotificationSettings(): Promise<{ opened: boolean }>;
}

const SleepMonitor = registerPlugin<SleepMonitorPlugin>('SleepMonitor');

const IDLE_STATUS: MonitorStatus = {
  running: false,
  enabled: false,
  batteryExempt: false,
  notifications: false,
  exactAlarms: false,
  lastUsedAt: 0,
  startedAt: 0,
  aliveAt: 0,
  lastGapAt: 0,
  lastError: null,
};

/** ¿Hay servicio nativo disponible en esta plataforma? */
export function isBackgroundAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('SleepMonitor');
}

export interface BackgroundOptions {
  minGapMinutes: number;
  triggers: TriggerId[];
  /** Avisar con la estimación al cerrarse la noche (Módulo 3). */
  wakeSummary: boolean;
  /** Ventana nocturna en minutos desde medianoche. */
  nightStartMinutes: number;
  nightEndMinutes: number;
  /** Sensores opcionales activos (fase 2); vacío si no hay ninguno. */
  sensors?: SensorId[];
  /** Muestrear el estado del dispositivo para el contexto de cada noche (por defecto sí). */
  deviceContext?: boolean;
}

export async function startBackground(options: BackgroundOptions): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  // Sin ningún disparador nativo activo el servicio no tendría nada que
  // escuchar: mejor pararlo que mantener viva una notificación permanente.
  if (!options.triggers.length) {
    await stopBackground();
    return false;
  }
  try {
    const { running } = await SleepMonitor.start(options);
    return running;
  } catch {
    return false;
  }
}

export async function stopBackground(): Promise<void> {
  if (!isBackgroundAvailable()) return;
  try {
    await SleepMonitor.stop();
  } catch {
    /* el servicio ya no estaba activo */
  }
}

export async function backgroundStatus(): Promise<MonitorStatus> {
  if (!isBackgroundAvailable()) return IDLE_STATUS;
  try {
    return { ...IDLE_STATUS, ...(await SleepMonitor.diagnostics()) };
  } catch {
    // Una versión anterior del plugin no conoce `diagnostics`; el estado
    // reducido de `isRunning` sigue siendo mejor que nada.
    try {
      return { ...IDLE_STATUS, ...(await SleepMonitor.isRunning()) };
    } catch {
      return IDLE_STATUS;
    }
  }
}

/** Pide al sistema eximir la app del ahorro de batería. */
export async function requestBatteryExemption(): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    const { requested } = await SleepMonitor.requestBatteryExemption();
    return requested;
  } catch {
    return false;
  }
}

/** Abre la pantalla de «alarmas y recordatorios» del sistema (Android 12+). */
export async function requestExactAlarms(): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    const { requested } = await SleepMonitor.requestExactAlarms();
    return requested;
  } catch {
    return false;
  }
}

/**
 * Abre la ficha de la app en los ajustes del sistema.
 *
 * Es la única salida cuando un permiso está denegado de forma permanente: a
 * partir de la segunda negativa Android ya no muestra el diálogo, así que el
 * botón «conceder permiso» dejaba de hacer nada sin decirlo.
 */
export async function openAppSettings(): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    const { opened } = await SleepMonitor.openAppSettings();
    return opened;
  } catch {
    return false;
  }
}

/** Ajustes de notificaciones de la app, para reactivar un canal silenciado. */
export async function openNotificationSettings(): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    const { opened } = await SleepMonitor.openNotificationSettings();
    return opened;
  } catch {
    return false;
  }
}

/**
 * Lee los huecos registrados mientras la app estaba cerrada.
 * No los borra: eso lo hace `clearGaps` una vez procesados, de modo que un
 * cierre inesperado a mitad no pierda una noche.
 */
export async function readGaps(): Promise<{
  gaps: NativeGap[];
  lastUsedAt: number;
  screenOffAt: number;
}> {
  if (!isBackgroundAvailable()) return { gaps: [], lastUsedAt: 0, screenOffAt: 0 };
  try {
    const res = await SleepMonitor.getGaps();
    return {
      gaps: res.gaps ?? [],
      lastUsedAt: res.lastUsedAt ?? 0,
      screenOffAt: res.screenOffAt ?? 0,
    };
  } catch {
    return { gaps: [], lastUsedAt: 0, screenOffAt: 0 };
  }
}

/**
 * Descarta los huecos cerrados hasta `until`. Se pasa la marca del último
 * hueco leído en vez de vaciar la cola entera, porque entre la lectura y el
 * borrado el servicio puede haber encolado uno nuevo.
 */
export async function clearGaps(until: number): Promise<void> {
  if (!isBackgroundAvailable()) return;
  try {
    await SleepMonitor.clearGaps({ until });
  } catch {
    /* sin servicio no hay nada que limpiar */
  }
}

/** Lee los comentarios escritos desde el aviso al despertar. */
export async function readNotes(): Promise<NativeNote[]> {
  if (!isBackgroundAvailable()) return [];
  try {
    const { notes } = await SleepMonitor.getNotes();
    return notes ?? [];
  } catch {
    // Una versión anterior del plugin no conoce `getNotes`.
    return [];
  }
}

/** Descarta los comentarios ya adjuntados a su sesión, o caducados. */
export async function removeNotes(ids: number[]): Promise<void> {
  if (!isBackgroundAvailable() || !ids.length) return;
  try {
    await SleepMonitor.removeNotes({ ids });
  } catch {
    /* sin servicio no hay nada que limpiar */
  }
}

/**
 * Publica el aviso al despertar desde el lado nativo. Devuelve false si no
 * puede, para que quien llama recurra al aviso web, que no lleva el botón.
 */
export async function notifyNativeSummary(start: number, end: number): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    await SleepMonitor.notifySummary({ start, end });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lee el registro de eventos del servicio.
 *
 * No se borra al leerlo, a diferencia de los huecos: el registro es para
 * mirarlo, y vaciarlo en cada apertura dejaría al usuario sin ver la noche
 * anterior justo cuando va a preguntarse por qué no se detectó.
 */
export async function readNativeEvents(): Promise<TriggerEvent[]> {
  if (!isBackgroundAvailable()) return [];
  try {
    const { events } = await SleepMonitor.getEvents();
    return (events ?? []).map((e) => ({ ...e, native: true }));
  } catch {
    // Una versión anterior del plugin no conoce `getEvents`.
    return [];
  }
}

export async function clearNativeEvents(): Promise<void> {
  if (!isBackgroundAvailable()) return;
  try {
    await SleepMonitor.clearEvents();
  } catch {
    /* sin servicio no hay registro que limpiar */
  }
}

/**
 * Encola un hueco de prueba para un disparador concreto.
 *
 * Devuelve false si no hay servicio nativo: en el navegador no hay cola donde
 * inyectarlo, y fingir que sí la hay daría por buena una prueba que no ha
 * comprobado nada.
 */
export async function simulateGap(trigger: TriggerId, minutesAgo: number): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    await SleepMonitor.simulateGap({ trigger, minutesAgo });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lee el registro bruto del servicio: pantalla, cargador y sensores, un evento
 * por línea. Se usa para cruzarlo con los huecos y para exportarlo.
 */
export async function readRawEvents(): Promise<RawEvent[]> {
  if (!isBackgroundAvailable()) return [];
  try {
    const { events } = await SleepMonitor.getRawEvents();
    return cleanRawEvents(events);
  } catch {
    // Una versión anterior del plugin no conoce `getRawEvents`.
    return [];
  }
}

export async function clearRawEvents(): Promise<void> {
  if (!isBackgroundAvailable()) return;
  try {
    await SleepMonitor.clearRawEvents();
  } catch {
    /* sin servicio no hay registro que limpiar */
  }
}

/**
 * Instantánea del dispositivo para el contexto de una noche; null sin servicio
 * nativo o con una versión anterior del plugin que no la conoce.
 */
export async function readDeviceSnapshot(): Promise<DeviceSnapshot | null> {
  if (!isBackgroundAvailable()) return null;
  try {
    return await SleepMonitor.getDeviceSnapshot();
  } catch {
    return null;
  }
}

/** Qué sensores tiene este móvil. Sin servicio nativo, ninguno. */
export async function readSensorStatus(): Promise<SensorStatus> {
  if (!isBackgroundAvailable()) return NO_SENSORS;
  try {
    const { sensors } = await SleepMonitor.sensorStatus();
    return { ...NO_SENSORS, ...sensors };
  } catch {
    return NO_SENSORS;
  }
}

/** Pide el permiso de actividad física. false si se deniega o no hace falta pedirlo. */
export async function requestSensorPermission(): Promise<boolean> {
  if (!isBackgroundAvailable()) return false;
  try {
    const { granted } = await SleepMonitor.requestSensorPermission();
    return granted;
  } catch {
    return false;
  }
}
