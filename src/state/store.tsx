import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_GOALS } from '../lib/schedule';
import { loadJSON, saveJSON } from '../lib/storage';
import {
  activeNativeTriggers,
  knownNights,
  proposeFromSchedule,
  readScheduleMark,
  refineEdges,
  supersedesPending,
  startMonitor,
  writeScheduleMark,
  type DetectionResult,
} from '../lib/activityMonitor';
import { learnHabit, learnLatency, withHabitStart } from '../lib/habit';
import {
  buildAlgo,
  contextFromAlgo,
  migrateSession,
  needsContext,
  pruneContexts,
  stripContexts,
} from '../lib/sessionContext';
import { collectContexts } from '../lib/contextCollector';
import { planSessionArchive, syncSessions } from '../lib/historyArchive';
import { DEFAULT_TRIGGERS } from '../lib/triggers';
import { DEFAULT_SENSORS, activeSensors } from '../lib/sensors';
import { logEvent } from '../lib/triggerLog';
import { ensureChannel, rescheduleAll, scheduleForegroundReminders } from '../lib/notifications';
import {
  archiveSessionsNative,
  isBackgroundAvailable,
  readNotes,
  removeArchivedSession,
  setHistoryOptions,
  stripArchivedContexts,
  removeNotes,
  startBackground,
  stopBackground,
} from '../lib/backgroundMonitor';
import { parseTime } from '../lib/time';
import type { AppState, SessionContext, SleepSession } from '../lib/types';

const STORAGE_KEY = 'perfectrest.state.v1';

export const initialState: AppState = {
  schedule: { mode: 'weekday-weekend', goals: DEFAULT_GOALS },
  cycles: { cycleMinutes: 90, latencyMinutes: 15 },
  reminders: {
    enabled: true,
    windDownMinutes: 30,
    toleranceMinutes: 15,
    nagIfLate: true,
    wakeAlarm: false,
  },
  monitor: {
    enabled: true,
    minGapMinutes: 180,
    maxGapMinutes: 780,
    nightStart: '21:30',
    nightEnd: '11:00',
    autoConfirm: false,
    background: true,
    wakeSummary: true,
    triggers: DEFAULT_TRIGGERS,
    sensors: DEFAULT_SENSORS,
    saveContext: true,
    contextSince: 0,
    keepHistory: true,
    allSensors: true,
  },
  sessions: [],
  theme: 'dark',
  lastActiveAt: null,
  lastDeviceUseAt: null,
  pendingSessions: [],
  onboarded: false,
};

/** Tiempo que un comentario del aviso espera a su noche antes de soltarse. */
const NOTE_TTL_MS = 7 * 24 * 3_600_000;

type Action =
  | { type: 'hydrate'; state: AppState }
  | { type: 'patch'; patch: Partial<AppState> }
  | { type: 'upsertSession'; session: SleepSession }
  | { type: 'removeSession'; id: string }
  | { type: 'proposeSession'; session: SleepSession }
  | { type: 'dismissPending' }
  | { type: 'addNote'; id: string; note: string }
  /** Contextos recién recogidos, por id de sesión. */
  | { type: 'setContexts'; contexts: Record<string, SessionContext> }
  /** Borra todos los contextos guardados; `at` es desde cuándo vuelve a recogerse. */
  | { type: 'clearContexts'; at: number }
  /** Pone la hora habitual como inicio de una propuesta, a petición del usuario. */
  | { type: 'applyHabitStart'; id: string; start: number }
  | { type: 'reset' };

/**
 * Suma un comentario al que ya tuviera la sesión en vez de pisarlo. Si ya lo
 * contiene no hace nada: el mismo comentario puede releerse del servicio
 * antes de que se borre de su lista.
 */
function appendNote(session: SleepSession, note: string): SleepSession {
  if (!session.note) return { ...session, note };
  if (session.note.includes(note)) return session;
  return { ...session, note: `${session.note}\n${note}` };
}

/** Exportado sólo para las pruebas sin navegador (`scripts/rendercheck.tsx`). */
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'hydrate':
      return action.state;

    case 'patch':
      return { ...state, ...action.patch };

    case 'upsertSession': {
      const rest = state.sessions.filter((s) => s.id !== action.session.id);
      return {
        ...state,
        sessions: [...rest, action.session].sort((a, b) => b.end - a.end),
        pendingSessions: state.pendingSessions.filter((s) => s.id !== action.session.id),
      };
    }

    case 'removeSession':
      return {
        ...state,
        sessions: state.sessions.filter((s) => s.id !== action.id),
        pendingSessions: state.pendingSessions.filter((s) => s.id !== action.id),
      };

    case 'proposeSession': {
      // Se ignora si ya existe una sesión que solape con la propuesta: el
      // usuario puede haber registrado esa noche a mano.
      const overlaps = state.sessions.some(
        (s) => action.session.start < s.end && s.start < action.session.end,
      );
      // También se ignora si ya está en la cola o si solapa con algo que ya
      // espera confirmación: el mismo hueco puede volver a leerse del servicio
      // antes de que se limpie la cola nativa.
      const alreadyPending = state.pendingSessions.some(
        (s) =>
          s.id === action.session.id ||
          (action.session.start < s.end && s.start < action.session.end),
      );
      if (overlaps || alreadyPending) return state;

      // La tarde quieta que se propuso anoche sobra si llega la noche de verdad.
      const queue = state.pendingSessions.filter((s) => !supersedesPending(action.session, s));

      // Una propuesta de inicio deducido nunca se guarda sola: se queda en la
      // cola para que la corrijas.
      if (state.monitor.autoConfirm && !action.session.inferred) {
        return {
          ...state,
          pendingSessions: queue,
          sessions: [...state.sessions, { ...action.session, confirmed: true }].sort(
            (a, b) => b.end - a.end,
          ),
        };
      }
      return {
        ...state,
        pendingSessions: [...queue, action.session].sort((a, b) => a.end - b.end),
      };
    }

    case 'dismissPending':
      // Descarta sólo la que el usuario está viendo, que es la primera de la
      // cola: detrás puede haber otra noche esperando su turno.
      return { ...state, pendingSessions: state.pendingSessions.slice(1) };

    case 'addNote':
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.id === action.id ? appendNote(s, action.note) : s)),
        pendingSessions: state.pendingSessions.map((s) =>
          s.id === action.id ? appendNote(s, action.note) : s,
        ),
      };

    case 'setContexts': {
      // La recogida es asíncrona: si mientras tanto se apagó el ajuste o se
      // borraron los contextos, lo que llega ya no se guarda.
      const { saveContext, contextSince } = state.monitor;
      if (!saveContext) return state;
      // Si entre medias se corrigió la sesión, el contexto es de otro tramo: se espera al siguiente pase.
      const apply = (s: SleepSession): SleepSession => {
        const c = action.contexts[s.id];
        return c && s.end > contextSince && c.span?.start === s.start && c.span?.end === s.end
          ? { ...s, context: c }
          : s;
      };
      return {
        ...state,
        sessions: pruneContexts(state.sessions.map(apply)),
        pendingSessions: state.pendingSessions.map(apply),
      };
    }

    case 'clearContexts':
      return {
        ...state,
        monitor: { ...state.monitor, contextSince: action.at },
        sessions: stripContexts(state.sessions),
        pendingSessions: stripContexts(state.pendingSessions),
      };

    case 'applyHabitStart': {
      // Tocarla la revisa: deja de ser una deducción. Sigue sin confirmar y
      // editable, y no enseña el hábito (`habitStart`).
      const apply = (s: SleepSession): SleepSession =>
        s.id === action.id ? withHabitStart(s, action.start) : s;
      return { ...state, pendingSessions: state.pendingSessions.map(apply) };
    }

    case 'reset':
      return { ...initialState, onboarded: true };

    default:
      return state;
  }
}

/** ¿Sólo cambiaron las marcas del latido de la app? Esas no merecen reescribir el estado entero. */
function onlyHeartbeatChanged(prev: AppState, next: AppState): boolean {
  for (const key of Object.keys(next) as Array<keyof AppState>) {
    if (key === 'lastActiveAt' || key === 'lastDeviceUseAt') continue;
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

interface StoreValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** false hasta que se ha leído el estado persistido. */
  ready: boolean;
  patch: (patch: Partial<AppState>) => void;
  saveSession: (session: SleepSession) => void;
  deleteSession: (id: string) => void;
  /** Borra los contextos guardados de todas las noches. */
  clearContexts: () => void;
  /** Activa o apaga el guardado del contexto con cada noche. */
  setSaveContext: (on: boolean) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // `ready` es estado, no ref: los efectos que dependen de él (arrancar el
  // servicio, programar avisos) deben volver a ejecutarse en cuanto la
  // hidratación termina. Con un ref se evaluaban una sola vez, cuando aún
  // valía false, y no llegaban a hacer nada.
  const [ready, setReady] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // --- Hidratación inicial ---
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadJSON<Partial<AppState> | null>(STORAGE_KEY, null);
      if (cancelled) return;
      if (stored) {
        // Antes de podar nada: lo que el estado en memoria está a punto de
        // olvidar (el contexto de las noches más antiguas) queda en el archivo.
        // El servicio ignora lo que ya tiene idéntico, así que repetirlo es barato.
        if (stored.monitor?.keepHistory !== false && stored.sessions?.length) {
          void syncSessions(stored.sessions, new Map(), async (chunk) => archiveSessionsNative(chunk));
        }
        // Merge superficial por sección: así los ajustes nuevos de una versión
        // posterior conservan su valor por defecto en estados antiguos.
        dispatch({
          type: 'hydrate',
          state: {
            ...initialState,
            ...stored,
            schedule: { ...initialState.schedule, ...stored.schedule },
            cycles: { ...initialState.cycles, ...stored.cycles },
            reminders: { ...initialState.reminders, ...stored.reminders },
            monitor: {
              ...initialState.monitor,
              ...stored.monitor,
              // Los disparadores se mezclan aparte: uno nuevo en una versión
              // posterior debe estrenarse con su valor por defecto en vez de
              // desaparecer bajo el objeto guardado.
              triggers: { ...DEFAULT_TRIGGERS, ...stored.monitor?.triggers },
              sensors: { ...DEFAULT_SENSORS, ...stored.monitor?.sensors },
            },
            // Un contexto con otra forma o desmesurado se suelta; las sesiones
            // anteriores a la función, sin contexto, quedan como estaban.
            sessions: pruneContexts((stored.sessions ?? []).map(migrateSession)),
            // Las propuestas sí sobreviven al cierre de la app. No se pueden
            // recalcular: la cola del servicio se vacía en cuanto se lee, así
            // que una noche propuesta y no confirmada antes de cerrar la app
            // desaparecía para siempre —y desde fuera se veía igual que si la
            // detección no hubiera funcionado. Sólo se sueltan las que entre
            // medias hayan quedado cubiertas por una sesión ya guardada.
            pendingSessions: (stored.pendingSessions ?? []).map(migrateSession).filter(
              (pending) =>
                !(stored.sessions ?? []).some(
                  (s) => pending.start < s.end && s.start < pending.end,
                ),
            ),
          },
        });
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Persistencia ---
  // El latido de la app cambia el estado cada pocos segundos; reescribir todo
  // el historial (ahora con el contexto de cada noche) por eso sería un gasto
  // inútil. Esas marcas se guardan con el siguiente cambio de verdad, y el
  // latido que importa vive aparte (`beat`).
  const lastSaved = useRef<AppState | null>(null);
  useEffect(() => {
    if (!ready) return;
    const prev = lastSaved.current;
    lastSaved.current = state;
    if (prev && onlyHeartbeatChanged(prev, state)) return;
    void saveJSON(STORAGE_KEY, state);
  }, [state, ready]);

  // --- Tema ---
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme);
  }, [state.theme]);

  // --- Monitor de inactividad (Módulo 3) ---
  // Espera a la hidratación: arrancar antes evaluaría el primer hueco con los
  // ajustes por defecto en vez de con los del usuario.
  useEffect(() => {
    if (!ready) return;
    void ensureChannel();

    // Lo que la detección sabe de ti: a qué hora te acuestas y cuánto tardas
    // en dormirte, aprendido de las noches que has corregido o aceptado.
    const habitNow = () => learnHabit(stateRef.current.sessions, stateRef.current.schedule);

    const propose = (result: DetectionResult) => {
      const { cycles, sessions, monitor } = stateRef.current;
      const habit = habitNow();
      const learnedLatency = learnLatency(sessions);
      const refined = refineEdges(result.session, cycles.latencyMinutes, {
        learnedLatencyMinutes: learnedLatency,
        // Si un sensor ya dijo cuándo se apagó la luz o se paró la actividad,
        // eso manda sobre lo que se espera de ti.
        habit: result.evidence?.activityAt != null ? null : habit,
        // La hora habitual sólo mueve el inicio si hay evidencia de quietud.
        evidence: result.evidence,
      });
      // La traza del algoritmo se guarda ahora, que es cuando se sabe por qué
      // se propone esto; el resto del contexto (batería, red, pantalla…) lo
      // recoge el efecto de más abajo con el registro bruto.
      const session =
        monitor.saveContext && refined.end > monitor.contextSince
          ? {
              ...refined,
              context: contextFromAlgo(
                buildAlgo({
                  result,
                  refined,
                  habit,
                  latencyMin: learnedLatency ?? cycles.latencyMinutes,
                  latencySource: learnedLatency !== null ? 'learned' : 'settings',
                  sensors: activeSensors(monitor),
                }),
              ),
            }
          : refined;
      dispatch({ type: 'proposeSession', session });
    };

    const handle = startMonitor(() => stateRef.current.monitor, {
      onDetect: propose,
      getContext: () => ({
        habit: habitNow(),
        known: knownNights(stateRef.current.sessions, stateRef.current.pendingSessions),
        // La misma latencia que sumará `refineEdges`: con otra, la detección y
        // el refinado no se pondrían de acuerdo sobre qué inicio es dudoso.
        latencyMinutes: learnLatency(stateRef.current.sessions) ?? stateRef.current.cycles.latencyMinutes,
      }),
      onBeat: (ts) => dispatch({ type: 'patch', patch: { lastActiveAt: ts } }),
      onDeviceUse: (ts) => dispatch({ type: 'patch', patch: { lastDeviceUseAt: ts } }),
      // Ninguna señal esta vez: es el turno del disparador de horario, que
      // necesita las metas y el historial y por eso se resuelve aquí.
      onQuiet: (now) => {
        void (async () => {
          const { schedule, monitor, sessions, pendingSessions } = stateRef.current;
          if (pendingSessions.length) return;
          const proposal = proposeFromSchedule(
            schedule,
            monitor,
            sessions,
            await readScheduleMark(),
            now,
          );
          if (!proposal) return;
          // Se marca antes de proponer: si el usuario la descarta, no debe
          // reaparecer en la siguiente apertura del mismo día.
          await writeScheduleMark(proposal.key);
          await logEvent(
            'schedule',
            'detect',
            'ninguna otra señal esa noche: se propone la meta del horario',
            proposal.result.session.end,
          );
          propose(proposal.result);
        })();
      },
    });

    return () => handle.stop();
  }, [ready]);

  // --- Servicio en segundo plano (Módulo 3) ---
  // Sigue al ajuste del usuario: mientras esté activo, la detección continúa
  // con la app cerrada; al desactivarlo, el servicio y su notificación
  // permanente desaparecen.
  useEffect(() => {
    if (!ready) return;
    const { enabled, background, minGapMinutes, wakeSummary } = state.monitor;
    // Al servicio se le pasan los disparadores nativos activos: si el usuario
    // apaga el del cargador, deja de escuchar ese evento en vez de filtrarlo
    // después. Sin ninguno activo, `startBackground` para el servicio.
    const triggers = activeNativeTriggers(state.monitor);
    if (enabled && background) {
      // El aviso al despertar lo emite el servicio, que es el único que sigue
      // vivo a esa hora, así que necesita el ajuste y la ventana nocturna.
      void startBackground({
        minGapMinutes,
        triggers,
        wakeSummary,
        nightStartMinutes: parseTime(state.monitor.nightStart),
        nightEndMinutes: parseTime(state.monitor.nightEnd),
        sensors: activeSensors(state.monitor),
        // Si está apagado, el servicio no muestrea nada del contexto.
        deviceContext: state.monitor.saveContext,
        keepHistory: state.monitor.keepHistory,
        allSensors: state.monitor.allSensors,
      }).then((running) => {
        // Que el servicio no arranque es silencioso y es la causa número uno
        // de no detectar nada: aquí es donde deja de serlo.
        if (!running && isBackgroundAvailable()) {
          void logEvent(null, 'error', 'Android no dejó arrancar el servicio de detección');
        }
      });
    } else {
      void stopBackground();
    }
    // Depende del objeto entero en vez de campo a campo: volver a arrancar el
    // servicio es idempotente y así ningún ajuste nuevo se queda sin propagar.
  }, [ready, state.monitor]);

  // --- Comentarios desde el aviso al despertar ---
  // Se escriben cuando la noche sólo es un hueco en la cola del servicio, así
  // que esperan allí hasta que haya una sesión (propuesta o guardada) que se
  // solape con su intervalo. Se reintenta cada vez que cambian las sesiones o
  // la app vuelve a primer plano; los que no encuentran noche en una semana
  // —un hueco que la evaluación descartó— se sueltan.
  const applyingNotes = useRef(false);
  useEffect(() => {
    if (!ready || applyingNotes.current) return;
    applyingNotes.current = true;
    void (async () => {
      try {
        const notes = await readNotes();
        if (!notes.length) return;
        const { sessions, pendingSessions } = stateRef.current;
        const candidates = [...pendingSessions, ...sessions];
        const done: number[] = [];
        for (const n of notes) {
          const target = candidates.find((s) => n.start < s.end && s.start < n.end);
          if (target) {
            dispatch({ type: 'addNote', id: target.id, note: n.note });
            done.push(n.id);
          } else if (Date.now() - n.at > NOTE_TTL_MS) {
            done.push(n.id);
          }
        }
        await removeNotes(done);
      } finally {
        applyingNotes.current = false;
      }
    })();
  }, [ready, state.sessions, state.pendingSessions, state.lastActiveAt]);

  // --- Contexto del dispositivo de cada noche ---
  // Resume el registro bruto de la noche de cada sesión que aún no lo tiene (o
  // cuyo tramo ha cambiado) en un contexto pequeño y agregado. Se hace aquí, y
  // no al proponerla, porque también hay que cubrir las sesiones manuales y
  // las guardadas solas, y porque media hora después del despertar el tramo ya
  // está completo. Cada pase mira como mucho ocho sesiones, una vez cada una.
  const collectingContext = useRef(false);
  const triedContext = useRef(new Set<string>());
  useEffect(() => {
    if (!ready || collectingContext.current) return;
    const { monitor, sessions, pendingSessions } = state;
    if (!monitor.saveContext) return;
    const now = Date.now();
    const key = (s: SleepSession) =>
      `${s.id}:${s.start}:${s.end}:${s.context?.collected ? 'c' : 'n'}`;
    const batch = [...pendingSessions, ...sessions]
      .filter((s) => needsContext(s, now, monitor.contextSince) && !triedContext.current.has(key(s)))
      .slice(0, 8);
    if (!batch.length) return;
    batch.forEach((s) => triedContext.current.add(key(s)));

    collectingContext.current = true;
    void collectContexts(batch, { sensorsOn: activeSensors(monitor), now })
      .then((contexts) => {
        collectingContext.current = false;
        dispatch({ type: 'setContexts', contexts });
      })
      .catch(() => {
        // Sin contexto no se pierde nada: la sesión vale igual. Se olvida el
        // intento para reintentarlo en el siguiente cambio de estado.
        batch.forEach((s) => triedContext.current.delete(key(s)));
        collectingContext.current = false;
      });
  }, [ready, state]);

  // --- Archivo histórico permanente ---
  // Cada noche guardada (y cada vez que cambia: nota, calidad, contexto) se
  // copia al archivo nativo. Se guarda la huella de lo ya copiado para no
  // reenviar el historial entero en cada cambio; si el interruptor se apaga y
  // vuelve a encenderse, se empieza de cero.
  const archivedSigs = useRef(new Map<string, string>());
  const syncingArchive = useRef(false);
  const [archiveTick, setArchiveTick] = useState(0);
  const { keepHistory, allSensors } = state.monitor;
  useEffect(() => {
    if (!ready) return;
    archivedSigs.current = new Map();
    void setHistoryOptions(keepHistory, allSensors);
  }, [ready, keepHistory, allSensors]);
  useEffect(() => {
    if (!ready || !keepHistory || syncingArchive.current || !isBackgroundAvailable()) return;
    if (!planSessionArchive(state.sessions, archivedSigs.current).toArchive.length) return;
    syncingArchive.current = true;
    void syncSessions(state.sessions, archivedSigs.current)
      .then((done) => {
        const progressed = done.size > archivedSigs.current.size ||
          [...done].some(([id, sig]) => archivedSigs.current.get(id) !== sig);
        archivedSigs.current = done;
        syncingArchive.current = false;
        // Si mientras tanto cambió algo, este mismo efecto lo recoge. Sin
        // avance (el servicio falla) no se reintenta en bucle: espera al siguiente cambio.
        if (progressed) setArchiveTick((t) => t + 1);
      })
      .catch(() => {
        syncingArchive.current = false;
      });
  }, [ready, keepHistory, state.sessions, archiveTick]);

  // --- Reprogramación de avisos (Módulo 1) ---
  useEffect(() => {
    if (!ready) return;
    void rescheduleAll(state.schedule, state.cycles, state.reminders);
    return scheduleForegroundReminders(state.schedule, state.cycles, state.reminders);
  }, [ready, state.schedule, state.cycles, state.reminders]);

  const patch = useCallback((p: Partial<AppState>) => dispatch({ type: 'patch', patch: p }), []);
  const saveSession = useCallback(
    (session: SleepSession) => dispatch({ type: 'upsertSession', session }),
    [],
  );
  const deleteSession = useCallback((id: string) => {
    dispatch({ type: 'removeSession', id });
    // Borrar una noche es borrarla también del archivo.
    void removeArchivedSession(id);
  }, []);
  const clearContexts = useCallback(() => {
    dispatch({ type: 'clearContexts', at: Date.now() });
    void stripArchivedContexts();
  }, []);
  const setSaveContext = useCallback((on: boolean) => {
    const { monitor } = stateRef.current;
    // Al reactivarlo sólo se recogen las noches que acaben a partir de ahora:
    // las de mientras estuvo apagado no vuelven a calcularse.
    dispatch({
      type: 'patch',
      patch: { monitor: { ...monitor, saveContext: on, contextSince: on ? Date.now() : monitor.contextSince } },
    });
  }, []);

  const value = useMemo<StoreValue>(
    () => ({ state, dispatch, ready, patch, saveSession, deleteSession, clearContexts, setSaveContext }),
    [state, ready, patch, saveSession, deleteSession, clearContexts, setSaveContext],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore debe usarse dentro de <StoreProvider>');
  return ctx;
}
