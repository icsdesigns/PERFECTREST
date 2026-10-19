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
  | 'audio';

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
  /** Valoración subjetiva del descanso, 1-5. */
  quality?: number;
  note?: string;
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
