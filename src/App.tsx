import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { HomeScreen } from './screens/HomeScreen';
import { GoalsScreen } from './screens/GoalsScreen';
import { CyclesScreen } from './screens/CyclesScreen';
import { StatsScreen } from './screens/StatsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SessionSheet } from './components/SessionSheet';
import { UpdateBanner } from './components/UpdateBanner';
import { Pill } from './components/ui';
import { useAppUpdate } from './state/update';
import { requestPermission } from './lib/notifications';
import { requestBatteryExemption } from './lib/backgroundMonitor';
import { formatClock, formatDuration, relativeDayLabel } from './lib/time';
import { habitualStart, learnHabit } from './lib/habit';
import { useStore } from './state/store';
import './App.css';

type Tab = 'home' | 'goals' | 'cycles' | 'stats' | 'settings';

/** Iconos de trazo: heredan el color de la pestaña y se ven nítidos a cualquier tamaño. */
const ICON_PATHS: Record<Tab, string> = {
  home: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  goals: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 3.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z',
  cycles: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
  stats: 'M5 20V11M12 20V4M19 20v-6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-2a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V19a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H5a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5V5a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5h0a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1H19a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
};

function Icon({ name }: { name: Tab }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Inicio' },
  { id: 'goals', label: 'Metas' },
  { id: 'cycles', label: 'Ciclos' },
  { id: 'stats', label: 'Datos' },
];

const TITLES: Record<Tab, { title: string; sub: string }> = {
  home: { title: 'PerfectRest', sub: 'Tu descanso de un vistazo' },
  goals: { title: 'Metas de sueño', sub: 'Define cuánto quieres dormir y cuándo' },
  cycles: { title: 'Ciclos de sueño', sub: 'La hora exacta para despertar descansado' },
  stats: { title: 'Tus datos', sub: 'Historial y tendencias de descanso' },
  settings: { title: 'Ajustes', sub: 'Permisos, detección y apariencia' },
};

export default function App() {
  const { state, patch, saveSession, dispatch } = useStore();
  const [tab, setTab] = useState<Tab>('home');
  const update = useAppUpdate();

  // Barra de estado transparente e integrada con el tema.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void StatusBar.setStyle({ style: state.theme === 'dark' ? Style.Dark : Style.Light }).catch(
      () => {},
    );
  }, [state.theme]);

  if (!state.onboarded) {
    return <Onboarding onDone={() => patch({ onboarded: true })} />;
  }

  // Sólo se enseña la primera de la cola: dos avisos a la vez no se leen, y
  // al resolverla aparece la siguiente.
  const pending = state.pendingSessions[0] ?? null;
  const head = TITLES[tab];
  // «¿Desde las 23:40, como sueles?» sólo para propuestas de inicio dudoso y
  // con un hábito aprendido; nunca se aplica sin que el usuario lo toque.
  const habitAt =
    pending?.inferred && !pending.nap
      ? habitualStart(pending, learnHabit(state.sessions, state.schedule))
      : null;

  return (
    <div className="app">
      <header className="appbar">
        <div>
          <h1 className="appbar__title">{head.title}</h1>
          <p className="appbar__sub">{head.sub}</p>
        </div>
        <div className="appbar__actions">
          <button
            type="button"
            className="iconbtn"
            aria-pressed={tab === 'settings'}
            aria-label="Ajustes"
            onClick={() => setTab(tab === 'settings' ? 'home' : 'settings')}
          >
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <main className="screen" key={tab}>
        {/* La actualización va antes que nada: es lo único que puede dejar de
            funcionar si se pospone indefinidamente. En Ajustes no aparece
            porque allí ya hay una tarjeta dedicada, con más detalle. */}
        {update.available && tab !== 'settings' && <UpdateBanner update={update} />}

        {pending && tab !== 'settings' && (
          <PendingBanner
            onConfirm={() => saveSession({ ...pending, confirmed: true })}
            onEdit={() => setTab('stats')}
            onDismiss={() => dispatch({ type: 'dismissPending' })}
            start={pending.start}
            end={pending.end}
            confidence={pending.confidence}
            inferred={!!pending.inferred}
            habitAt={habitAt}
            habitApplied={!!pending.habitStart}
            onUseHabit={() => habitAt !== null && dispatch({ type: 'applyHabitStart', id: pending.id, start: habitAt })}
          />
        )}

        {tab === 'home' && <HomeScreen onGoTo={(t) => setTab(t as Tab)} />}
        {tab === 'goals' && <GoalsScreen />}
        {tab === 'cycles' && <CyclesScreen />}
        {tab === 'stats' && <StatsScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </main>

      <nav className="tabbar" aria-label="Navegación principal">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tab"
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            <span className="tab__icon" aria-hidden="true">
              <Icon name={t.id} />
              {t.id === 'stats' && pending && <span className="tab__dot" />}
            </span>
            {t.label}
          </button>
        ))}
      </nav>

      {/* La confirmación detallada usa la misma hoja que la edición manual. */}
      {pending && tab === 'stats' && (
        <SessionSheet
          session={pending}
          habitualStart={habitAt}
          onSave={saveSession}
          onClose={() => dispatch({ type: 'dismissPending' })}
        />
      )}
    </div>
  );
}

function PendingBanner({
  start,
  end,
  confidence,
  inferred,
  habitAt,
  habitApplied,
  onUseHabit,
  onConfirm,
  onEdit,
  onDismiss,
}: {
  start: number;
  end: number;
  confidence: 'high' | 'medium' | 'low';
  /** El inicio no está medido: se dice, para que no se confirme a ciegas. */
  inferred: boolean;
  /** Tu hora habitual de acostarte puesta en esta noche, si procede ofrecerla. */
  habitAt: number | null;
  /** El inicio ya es tu hora habitual, aplicada por ti. */
  habitApplied: boolean;
  onUseHabit: () => void;
  onConfirm: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}) {
  const tone = confidence === 'high' ? 'mint' : confidence === 'medium' ? 'amber' : 'rose';
  const label = confidence === 'high' ? 'detección fiable' : confidence === 'medium' ? 'estimación' : 'poco fiable';

  return (
    <div className="pending">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sp-3)' }}>
        <span className="eyebrow">Sueño detectado</span>
        <Pill tone={tone}>{label}</Pill>
      </div>
      <p style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: 'var(--sp-3)' }}>
        {relativeDayLabel(end)}: {formatDuration(end - start)}
      </p>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: 4 }}>
        De {formatClock(start)} a {formatClock(end)}. ¿Es correcto?
      </p>
      {inferred && (
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: 4 }}>
          La hora de dormirte no está medida: el móvil no sabe si dormías o
          estabas despierto sin tocarlo. Ajústala si no es así.
        </p>
      )}
      {habitApplied && (
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: 4 }}>
          El inicio es tu hora habitual, puesta por ti. Ajústala si esa noche fue distinta.
        </p>
      )}
      {habitAt !== null && (
        <button
          className="btn btn--ghost btn--full"
          style={{ marginTop: 'var(--sp-3)' }}
          onClick={onUseHabit}
        >
          ¿Desde las {formatClock(habitAt)}, como sueles?
        </button>
      )}
      <div className="pending__actions">
        <button className="btn btn--ghost" onClick={onDismiss}>No dormí</button>
        <button className="btn btn--ghost" onClick={onEdit}>Ajustar</button>
        <button className="btn btn--primary" onClick={onConfirm}>Confirmar</button>
      </div>
    </div>
  );
}

function Onboarding({ onDone }: { onDone: () => void }) {
  const [asking, setAsking] = useState(false);

  const start = async () => {
    setAsking(true);
    // Se piden aquí, con el contexto fresco de para qué sirven. La exención de
    // batería no es opcional en la práctica: sin ella Android para el servicio
    // de madrugada y la detección no llega viva a la mañana. Dejarla escondida
    // en Ajustes significaba que casi nadie la concedía y la app parecía no
    // detectar nada.
    await requestPermission().catch(() => {});
    await requestBatteryExemption().catch(() => {});
    onDone();
  };

  return (
    <div className="onboard">
      <div className="onboard__logo">🌙</div>
      <div>
        <h1 className="onboard__title">Duerme mejor,<br />despierta a la hora justa</h1>
        <p className="onboard__text" style={{ marginTop: 'var(--sp-3)' }}>
          PerfectRest calcula tus horarios a partir de los ciclos de sueño y te acompaña para que
          los cumplas.
        </p>
      </div>

      <div className="onboard__list">
        <div className="onboard__item">
          <span className="onboard__icon">🎯</span>
          <div>
            <div className="onboard__itemTitle">Tu meta, a tu medida</div>
            <div className="onboard__itemText">
              Las mismas horas toda la semana, un horario distinto para el fin de semana o uno por
              cada día.
            </div>
          </div>
        </div>
        <div className="onboard__item">
          <span className="onboard__icon">🌀</span>
          <div>
            <div className="onboard__itemTitle">Despertares al final de ciclo</div>
            <div className="onboard__itemText">
              Calculamos la hora de acostarte para que la alarma te encuentre en sueño ligero, no
              en mitad del profundo.
            </div>
          </div>
        </div>
        <div className="onboard__item">
          <span className="onboard__icon">📊</span>
          <div>
            <div className="onboard__itemTitle">Registro sin esfuerzo</div>
            <div className="onboard__itemText">
              Detectamos cuánto duermes a partir del tiempo que el móvil pasa sin usarse, y al
              despertar te avisamos con la estimación para que la confirmes de un toque.
            </div>
          </div>
        </div>
      </div>

      <button className="btn btn--primary btn--full" onClick={() => void start()} disabled={asking}>
        {asking ? 'Un momento…' : 'Empezar'}
      </button>
      <p style={{ fontSize: '0.72rem', color: 'var(--text-faint)', textAlign: 'center', lineHeight: 1.6 }}>
        Te pediremos permiso de notificaciones y que excluyas la app del ahorro de batería: sin eso
        Android detiene la detección de madrugada. Tus datos no salen del dispositivo.
      </p>
    </div>
  );
}
