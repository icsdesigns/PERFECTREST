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
  startMonitor,
  writeScheduleMark,
  type DetectionResult,
} from '../lib/activityMonitor';
import { learnHabit, learnLatency } from '../lib/habit';
import { DEFAULT_TRIGGERS } from '../lib/triggers';
import { DEFAULT_SENSORS, activeSensors } from '../lib/sensors';
import { logEvent } from '../lib/triggerLog';
import { ensureChannel, rescheduleAll, scheduleForegroundReminders } from '../lib/notifications';
import {
  isBackgroundAvailable,
  readNotes,
  removeNotes,
  startBackground,
  stopBackground,
} from '../lib/backgroundMonitor';
import { parseTime } from '../lib/time';
import type { AppState, SleepSession } from '../lib/types';

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

function reducer(state: AppState, action: Action): AppState {
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

      if (state.monitor.autoConfirm) {
        return {
          ...state,
          sessions: [...state.sessions, { ...action.session, confirmed: true }].sort(
            (a, b) => b.end - a.end,
          ),
        };
      }
      return {
        ...state,
        pendingSessions: [...state.pendingSessions, action.session].sort(
          (a, b) => a.end - b.end,
        ),
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

    case 'reset':
      return { ...initialState, onboarded: true };

    default:
      return state;
  }
}

interface StoreValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** false hasta que se ha leído el estado persistido. */
  ready: boolean;
  patch: (patch: Partial<AppState>) => void;
  saveSession: (session: SleepSession) => void;
  deleteSession: (id: string) => void;
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
            sessions: stored.sessions ?? [],
            // Las propuestas sí sobreviven al cierre de la app. No se pueden
            // recalcular: la cola del servicio se vacía en cuanto se lee, así
            // que una noche propuesta y no confirmada antes de cerrar la app
            // desaparecía para siempre —y desde fuera se veía igual que si la
            // detección no hubiera funcionado. Sólo se sueltan las que entre
            // medias hayan quedado cubiertas por una sesión ya guardada.
            pendingSessions: (stored.pendingSessions ?? []).filter(
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
  useEffect(() => {
    if (!ready) return;
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
      const { cycles, sessions } = stateRef.current;
      const habit = habitNow();
      const refined = refineEdges(result.session, cycles.latencyMinutes, {
        learnedLatencyMinutes: learnLatency(sessions),
        // Si un sensor ya dijo cuándo se apagó la luz o se paró la actividad,
        // eso manda sobre lo que se espera de ti.
        habit: result.evidence?.activityAt != null ? null : habit,
      });
      dispatch({ type: 'proposeSession', session: refined });
    };

    const handle = startMonitor(() => stateRef.current.monitor, {
      onDetect: propose,
      getContext: () => ({
        habit: habitNow(),
        known: knownNights(stateRef.current.sessions, stateRef.current.pendingSessions),
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
  const deleteSession = useCallback((id: string) => dispatch({ type: 'removeSession', id }), []);

  const value = useMemo<StoreValue>(
    () => ({ state, dispatch, ready, patch, saveSession, deleteSession }),
    [state, ready, patch, saveSession, deleteSession],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore debe usarse dentro de <StoreProvider>');
  return ctx;
}
