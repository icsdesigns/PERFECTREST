/** Modelo de dominio de PerfectRest. */

/** Índice de día ISO: 1 = lunes … 7 = domingo. */
export type DayIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Cómo se personaliza la meta de sueño (Módulo 1). */
export type ScheduleMode =
  /** Un único objetivo para los siete días. */
  | 'uniform'
  /** Un objetivo para L-V y otro para S-D. */
  | 'weekday-weekend'
  /** Un objetivo distinto por cada día. */
  | 'per-day';

/** Meta de un día concreto. Las horas son "HH:MM" en hora local. */
export interface DayGoal {
  /** Hora a la que el usuario quiere despertarse. */
  wakeTime: string;
  /** Horas de sueño objetivo (decimal: 7.5 = 7h 30m). */
  targetHours: number;
}

export interface ScheduleSettings {
  mode: ScheduleMode;
  /** Meta por día ISO. Siempre están los 7; el modo decide cuáles se editan. */
  goals: Record<DayIndex, DayGoal>;
}

export interface CycleSettings {
  /** Duración de un ciclo de sueño en minutos (típico 90, rango 70-120). */
  cycleMinutes: number;
  /** Latencia: minutos que se tarda en dormir desde que uno se acuesta. */
  latencyMinutes: number;
}

export interface ReminderSettings {
  enabled: boolean;
  /** Minutos antes de la hora de acostarse para el aviso de preparación. */
  windDownMinutes: number;
  /** Margen de tolerancia (± minutos) sobre la hora ideal de acostarse. */
  toleranceMinutes: number;
  /** Aviso extra si a la hora límite el usuario sigue activo. */
  nagIfLate: boolean;
  /** Alarma/recordatorio a la hora de despertar. */
  wakeAlarm: boolean;
}

/**
 * Señales a partir de las que se puede deducir una noche de sueño. Cada una se
 * activa por separado desde Ajustes, y cuando varias coinciden sobre el mismo
 * hueco la sesión se propone con más confianza.
 */
export type TriggerId =
  /** Pantalla apagada → desbloqueo del dispositivo. La medida más directa. */
  | 'screen'
  /** Móvil puesto a cargar → desenchufado. Útil para quien carga de noche. */
  | 'charger'
  /** Hueco entre dos aperturas de PerfectRest. Funciona sin servicio nativo. */
  | 'appOpen'
  /** Android entra en reposo profundo (Doze) y sale de él. */
  | 'idle'
  /** «No molestar» se activa y se desactiva, a mano o por el modo descanso. */
  | 'dnd'
  /** Sin ninguna otra señal, se propone la meta del horario como estimación. */
  | 'schedule';

/**
 * Sensores baratos que afinan la detección. A diferencia de los disparadores,
 * no abren ni cierran huecos: aportan indicios (¿había actividad real antes de
 * la quietud larga?, ¿se despertó alguien a esa hora?) que ajustan los bordes
 * de la noche y alimentan la confianza. Todos son opcionales y nativos, y
 * ninguno usa el micrófono.
 */
export type SensorId =
  /** Pasos (o, sin permiso, movimiento significativo): actividad física real. */
  | 'steps'
  /** Luz ambiental: apagar la luz es la marca más clara de irse a dormir. */
  | 'light'
  /** Proximidad: móvil en el bolsillo o boca abajo, o cogido de nuevo. */
  | 'proximity'
  /** Próxima alarma del reloj: cuándo se espera despertar. */
  | 'alarm'
  /** Audio sonando con la pantalla apagada: aún no se ha dormido. */
  | 'audio'
  /** Postura del móvil (gravedad): plano y quieto sobre una superficie, o en bolsillo/mano. */
  | 'posture';

export interface MonitorSettings {
  enabled: boolean;
  /** Inactividad mínima (minutos) para considerarla una sesión de sueño. */
  minGapMinutes: number;
  /** Inactividad máxima creíble; por encima se marca como dudosa. */
  maxGapMinutes: number;
  /** Ventana nocturna en la que se espera dormir: "HH:MM". */
  nightStart: string;
  nightEnd: string;
  /** Registrar sesiones automáticamente sin pedir confirmación. */
  autoConfirm: boolean;
  /**
   * Avisar con la estimación en cuanto se cierra la noche, para validarla sin
   * tener que abrir la app. Lo dispara el servicio nativo, no la web: al
   * despertar nadie abre PerfectRest, y esperar a que lo haga era lo que dejaba
   * la propuesta enterrada durante días.
   */
  wakeSummary: boolean;
  /**
   * Mantener la detección activa con la app cerrada (sólo en el APK).
   * Requiere un servicio en primer plano con notificación permanente.
   */
  background: boolean;
  /** Qué disparadores están activos. Catálogo en `lib/triggers.ts`. */
  triggers: Record<TriggerId, boolean>;
  /** Qué sensores opcionales están activos. Catálogo en `lib/sensors.ts`. */
  sensors: Record<SensorId, boolean>;
  /**
   * Guardar con cada noche un resumen del estado del dispositivo (pantalla,
   * batería, red, sensores…) para analizarla después. Todo es local y agregado:
   * ver `SessionContext`. Activado por defecto.
   */
  saveContext: boolean;
  /**
   * Sólo se recoge contexto de las noches que acaban después de este instante.
   * Se actualiza al borrar los contextos guardados o al reactivar el ajuste,
   * para que lo borrado no vuelva a calcularse con el registro bruto.
   */
  contextSince: number;
  /**
   * Conservar sin caducidad el registro bruto, las lecturas de sensores y las
   * noches con su contexto en el archivo histórico del móvil (ver
   * `lib/historyArchive.ts`). Todo local. Activado por defecto.
   */
  keepHistory: boolean;
  /**
   * Registrar todos los sensores disponibles: agregados ligeros de cada
   * sensor no sensible en las ventanas cortas de la postura. Necesita
   * `keepHistory`. Activado por defecto.
   */
  allSensors: boolean;
}

/**
 * Qué le ha pasado a un disparador.
 *
 * El registro existe porque la detección falla en silencio: sin permisos, o
 * con el servicio muerto, «no se detectó nada» y «no dormiste» son
 * indistinguibles desde fuera. Cada evento deja constancia de qué señal llegó,
 * cuándo, y qué se hizo con ella.
 */
export type TriggerEventKind =
  /** El disparador marcó el principio de un hueco de inactividad. */
  | 'open'
  /** Lo cerró: el usuario ha vuelto al dispositivo. */
  | 'close'
  /** El hueco superó el umbral y se encoló como candidato. */
  | 'gap'
  /** El hueco se descartó, y por qué. */
  | 'discard'
  /** Se propuso una sesión de sueño a partir de uno o varios huecos. */
  | 'detect'
  /** Arranque, parada o rearme del servicio. */
  | 'service'
  /** Algo impidió al disparador hacer su trabajo. */
  | 'error';

/** Una línea del registro de detección. */
export interface TriggerEvent {
  /** Cuándo ocurrió (epoch ms). */
  at: number;
  /** Disparador implicado; null en los eventos del propio servicio. */
  trigger: TriggerId | null;
  kind: TriggerEventKind;
  /** Detalle legible: duración, motivo del descarte, mensaje del error… */
  detail?: string;
  /** true si lo anotó el servicio nativo; false si la capa web. */
  native?: boolean;
}

/** Grado de confianza de una sesión detectada automáticamente. */
export type Confidence = 'high' | 'medium' | 'low';

export type SessionSource = 'auto' | 'manual' | 'edited';

export interface SleepSession {
  id: string;
  /** Instante de inicio del sueño (epoch ms). */
  start: number;
  /** Instante de despertar (epoch ms). */
  end: number;
  source: SessionSource;
  confidence: Confidence;
  /** false mientras el usuario no la haya validado. */
  confirmed: boolean;
  /** Señales que produjeron la detección, de más a menos directa. */
  triggers?: TriggerId[];
  /**
   * Los bordes del hueco tal como los midió el dispositivo, antes de cualquier
   * corrección. Sirven para aprender cuánto se adelanta la señal a tu sueño
   * real cuando editas la hora.
   */
  detectedStart?: number;
  detectedEnd?: number;
  /** Siesta aceptada por tener indicios propios; el resto de huecos de un día no se proponen. */
  nap?: boolean;
  /**
   * El inicio no está respaldado por una medida: se dedujo de tu hábito o del
   * horario, o es el último uso del móvil muy por delante de tu hora de
   * acostarte sin que ningún sensor confirme la quietud. Va siempre con
   * confianza baja, no se guarda sola con «guardar sin preguntar» y cede ante
   * cualquier otra propuesta de la misma noche.
   */
  inferred?: boolean;
  /**
   * El inicio es la hora habitual que el usuario aplicó con un toque («¿desde
   * las 23:40, como sueles?»), no una medida ni una hora que escribiera. Cuenta
   * como revisada por él, pero no enseña el hábito: aprender de una hora que
   * salió del propio hábito lo reforzaría a sí mismo.
   */
  habitStart?: boolean;
  /** Valoración subjetiva del descanso, 1-5. */
  quality?: number;
  note?: string;
  /**
   * Contexto del dispositivo durante la noche, para analizarla después. Todo
   * agregado y local: ver `lib/sessionContext.ts`. Opcional, y ausente en las
   * sesiones anteriores a la función o si el usuario la apagó.
   */
  context?: SessionContext;
}

/**
 * Resumen de un parámetro que cambia con el tiempo (nivel de batería, tipo de
 * red, modo del timbre…) en el tramo analizado. Los valores son los códigos del
 * registro bruto; `lib/sessionContext.ts` los traduce al mostrarlos.
 */
export interface StateSummary {
  /** Valor al inicio de la sesión (null si no se conoce). */
  start: number | null;
  /** Valor al final de la sesión (null si no se conoce). */
  end: number | null;
  min?: number;
  max?: number;
  /** Cuántas veces cambió dentro del tramo. */
  changes: number;
  /** Porcentaje del tramo (0-100) con cada valor, sólo para los discretos. */
  pct?: Record<string, number>;
}

/** Datos estáticos del móvil y de la app. Ni identificadores ni nombres. */
export interface ContextDevice {
  model?: string;
  manufacturer?: string;
  /** Build.VERSION.SDK_INT. */
  sdk?: number;
  /** Versión de Android legible («14»). */
  release?: string;
  app: string;
  /** Idioma del sistema, p. ej. «es-ES». */
  locale?: string;
  tz?: string;
  /** Desfase respecto a UTC al inicio de la sesión, en minutos. */
  tzOffsetMin: number;
  /** Qué sensores tiene el móvil (no si están activos). */
  hasSensors?: Record<string, boolean>;
  /** Exención de batería / alarmas exactas / notificaciones, que condicionan la fiabilidad. */
  batteryExempt?: boolean;
  exactAlarms?: boolean;
  notifications?: boolean;
}

/** Cómo llegó el algoritmo a proponer la noche: disparadores, confianza y razones. */
export interface ContextAlgo {
  triggers: TriggerId[];
  confidence: Confidence;
  inferred: boolean;
  nap?: boolean;
  /** Puntuación 0-1 de lo noche que parecía el hueco. */
  score?: number;
  /** Duración del hueco medido, en minutos. */
  gapMin?: number;
  /** Cuánto movió `refineEdges` el inicio y el final respecto a lo medido (min). */
  startShiftMin?: number;
  endShiftMin?: number;
  /** Latencia que se sumó al inicio y de dónde salió. */
  latencyMin?: number;
  latencySource?: 'learned' | 'settings';
  /** Hábito aprendido en ese momento (minutos desde medianoche). */
  habit?: { startMin: number; endMin: number; n: number; spreadMin?: number };
  /** Sensores activos cuando se propuso. */
  sensors?: SensorId[];
  /** Lo que dijeron los sensores del hueco. */
  evidence?: {
    activityAt: number | null;
    wakeAt: number | null;
    dark: number | null;
    moves: number | null;
    flat: number | null;
    alarmMatch: boolean | null;
  };
  /** Huecos de la misma noche que se descartaron y por qué. */
  discards?: Array<{ reason: string; startMin: number; endMin: number }>;
}

/**
 * Instantánea de la noche: lo que el móvil y sus sensores hicieron entre media
 * hora antes de dormirse y media hora después de despertar. Son agregados
 * (conteos, mínimos, máximos, porcentajes), nunca series ni nada identificable:
 * sin ubicación, sin SSID ni nombres de dispositivos Bluetooth, sin contenido
 * de notificaciones ni nombres de apps. Se calcula y se guarda en el móvil.
 */
export interface SessionContext {
  /** Versión del formato, para poder cambiarlo sin romper lo guardado. */
  v: number;
  /** Cuándo se recogió la parte del dispositivo (epoch ms); ausente si sólo hay traza. */
  collected?: number;
  /** Tramo analizado (epoch ms) y el inicio y fin de la sesión que se usaron. */
  from?: number;
  to?: number;
  span?: { start: number; end: number };
  /** El registro bruto no cubría todo el tramo: faltan datos. */
  partial?: boolean;
  device?: ContextDevice;
  algo?: ContextAlgo;
  screen?: {
    ons: number;
    unlocks: number;
    /** Encendidos sin desbloqueo: notificaciones o el gesto de levantar el móvil. */
    glances: number;
    /** Micro-despertares: desbloqueos entre el inicio y el final de la sesión. */
    nightUnlocks: number;
    nightOns: number;
    /** Tiempo total de uso con la pantalla desbloqueada, en segundos. */
    useSec: number;
    /** Duración de cada uso, en segundos (los 20 primeros). */
    usesSec: number[];
    longestSec: number;
    /** ¿Estaba la pantalla encendida al inicio / al final de la sesión? */
    onAtStart: boolean | null;
    onAtEnd: boolean | null;
  };
  power?: {
    plugs: number;
    unplugs: number;
    /** Porcentaje del tramo enchufado. */
    chargingPct: number | null;
    /** 0 sin carga, 1 pared, 2 USB, 3 inalámbrica, 4 base. */
    chargeType?: StateSummary;
    battery?: StateSummary;
    /** Temperatura de la batería, °C. */
    tempC?: { min: number; max: number };
  };
  system?: {
    doze?: StateSummary;
    dnd?: StateSummary;
    airplane?: StateSummary;
    powerSave?: StateSummary;
    ringer?: StateSummary;
    net?: StateSummary;
    /** Dispositivos Bluetooth de audio conectados. */
    bt?: StateSummary;
    bright?: StateSummary;
    orient?: StateSummary;
  };
  sensors?: {
    /** Sensores de detección que el usuario tenía activos. */
    on: SensorId[];
    steps?: { steps: number; motions: number };
    light?: { pct: Record<string, number>; luxMin?: number; luxMax?: number; changes: number };
    proximity?: { coveredPct: number | null; changes: number };
    posture?: { readings: number; flatPct: number; carried: number; tilted: number };
    audio?: { playingPct: number; starts: number };
    alarm?: {
      /** Alarma que cae cerca del final de la noche (epoch ms), si la hay. */
      at: number | null;
      /** Minutos entre el despertar y la alarma (negativo: sonó antes). */
      deltaMin?: number;
      status: 'rang' | 'cancelled' | 'no-screen' | 'pending' | 'none';
      /** ¿Había alguna alarma programada al empezar la sesión? */
      setAtStart: boolean | null;
    };
  };
  /** Salud del servicio durante el tramo. */
  service?: { restarts: number; errors: number };
  /** Eventos destacados (minutos desde el inicio de la sesión, tipo, valor); como mucho 40. */
  timeline?: Array<[number, string, number?]>;
}

export interface AppState {
  schedule: ScheduleSettings;
  cycles: CycleSettings;
  reminders: ReminderSettings;
  monitor: MonitorSettings;
  sessions: SleepSession[];
  theme: 'dark' | 'light';
  /** Marca temporal del último latido de actividad registrado. */
  lastActiveAt: number | null;
  /**
   * Último uso real del dispositivo según el servicio nativo. A diferencia de
   * `lastActiveAt`, no depende de que la app se abra.
   */
  lastDeviceUseAt: number | null;
  /**
   * Sesiones detectadas a la espera de que el usuario las confirme o las
   * descarte, de la más antigua a la más reciente.
   *
   * Es una cola y no una sola sesión porque una vuelta del monitor puede
   * proponer varias noches de golpe: quien pasa un fin de semana sin abrir la
   * app vuelve con tres. Con un único hueco, las dos primeras se perdían sin
   * dejar rastro —la tercera sobrescribía a las anteriores antes de que
   * nadie las viera— y el historial quedaba con agujeros que el usuario no
   * podía ni explicar ni recuperar.
   */
  pendingSessions: SleepSession[];
  onboarded: boolean;
}
