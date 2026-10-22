import { useMemo, useState } from 'react';
import { Card, Empty, Metric, Pill, Segmented } from '../components/ui';
import { DurationChart, ScheduleChart } from '../components/viz';
import { SessionSheet } from '../components/SessionSheet';
import { habitualStart, learnHabit } from '../lib/habit';
import { buildNights, insight, summarize, usableSessions } from '../lib/stats';
import {
  HOUR,
  formatClock,
  formatDuration,
  formatTime,
  relativeDayLabel,
} from '../lib/time';
import type { SleepSession } from '../lib/types';
import { useStore } from '../state/store';

const RANGE_OPTIONS = [
  { value: '7', label: '7 días' },
  { value: '14', label: '14 días' },
  { value: '30', label: '30 días' },
];

const CONFIDENCE_LABEL = {
  high: { tone: 'mint', text: 'fiable' },
  medium: { tone: 'amber', text: 'estimada' },
  low: { tone: 'rose', text: 'dudosa' },
} as const;

/** Módulo 3 — Registro monitorizado y estadísticas. */
export function StatsScreen() {
  const { state, saveSession, deleteSession } = useStore();
  const [range, setRange] = useState('7');
  const [editing, setEditing] = useState<SleepSession | null>(null);

  const days = Number(range);
  const nights = useMemo(
    () => buildNights(state.sessions, state.schedule, days),
    [state.sessions, state.schedule, days],
  );
  const summary = useMemo(() => summarize(nights), [nights]);
  const tip = insight(summary);

  const history = useMemo(
    () => usableSessions(state.sessions).slice().reverse().slice(0, 30),
    [state.sessions],
  );

  const addManual = () => {
    // Se propone la noche pasada como plantilla: es lo que uno suele registrar.
    const now = new Date();
    const end = new Date(now);
    end.setHours(7, 0, 0, 0);
    if (end.getTime() > now.getTime()) end.setDate(end.getDate() - 1);
    const start = new Date(end.getTime() - 8 * HOUR);
    setEditing({
      id: `man-${Date.now()}`,
      start: start.getTime(),
      end: end.getTime(),
      source: 'manual',
      confidence: 'high',
      confirmed: true,
    });
  };

  const toneFor = (tone: string) =>
    tone === 'good' ? 'mint' : tone === 'warn' ? 'amber' : tone === 'bad' ? 'rose' : 'muted';

  return (
    <>
      <Card
        title="Periodo"
        action={
          <button className="btn btn--ghost" style={{ padding: 'var(--sp-2) var(--sp-3)' }} onClick={addManual}>
            + Añadir noche
          </button>
        }
      >
        <Segmented value={range} options={RANGE_OPTIONS} onChange={setRange} label="Periodo" />
      </Card>

      {summary.recorded === 0 ? (
        <Card>
          <Empty
            icon="🌙"
            title="Sin noches registradas todavía"
            text="La app detecta el sueño a partir del tiempo que pasas sin usar el móvil. Tras la primera noche con la app instalada verás aquí tus datos, y siempre puedes añadir noches a mano."
          />
        </Card>
      ) : (
        <>
          <div className="grid-2">
            <Card>
              <Metric
                value={summary.avgDurationMs ? formatDuration(summary.avgDurationMs) : '—'}
                label="Duración media"
                tone={
                  summary.avgDurationMs && summary.avgDurationMs >= summary.avgTargetMs - 30 * 60_000
                    ? 'mint'
                    : 'amber'
                }
                note={`meta ${formatDuration(summary.avgTargetMs)}`}
              />
            </Card>
            <Card>
              <Metric
                value={summary.goalHitRate !== null ? `${summary.goalHitRate}%` : '—'}
                label="Metas cumplidas"
                tone={
                  summary.goalHitRate !== null && summary.goalHitRate >= 70 ? 'mint' : 'amber'
                }
                note={`${summary.recorded} de ${days} noches`}
              />
            </Card>
            <Card>
              <Metric
                value={summary.avgBedMinutes !== null ? formatTime(summary.avgBedMinutes) : '—'}
                label="Te acuestas sobre las"
                tone="primary"
              />
            </Card>
            <Card>
              <Metric
                value={summary.avgWakeMinutes !== null ? formatTime(summary.avgWakeMinutes) : '—'}
                label="Te despiertas sobre las"
                tone="amber"
              />
            </Card>
          </div>

          <Card
            title="Duración por noche"
            sub="La línea discontinua es tu meta de ese día"
            action={
              summary.debtMs > HOUR ? (
                <Pill tone="rose">−{formatDuration(summary.debtMs)} de deuda</Pill>
              ) : (
                <Pill tone="mint">sin deuda</Pill>
              )
            }
          >
            <DurationChart nights={nights} />
          </Card>

          <Card
            title="Regularidad de horarios"
            sub="Cada franja es una noche, de la hora de dormir a la de despertar"
            action={
              summary.consistency !== null ? (
                <Pill tone={summary.consistency >= 70 ? 'mint' : 'amber'}>
                  {summary.consistency}% constante
                </Pill>
              ) : null
            }
          >
            <ScheduleChart nights={nights} />
          </Card>

          <Card title="Lectura de tus datos">
            <p style={{ fontSize: '0.85rem', lineHeight: 1.65, color: 'var(--text-muted)' }}>
              {tip.text}
            </p>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-4)', flexWrap: 'wrap' }}>
              <Pill tone={toneFor(tip.tone)}>racha de {summary.streak} noches</Pill>
              {summary.avgQuality !== null && (
                <Pill tone="muted">descanso percibido {summary.avgQuality.toFixed(1)}/5</Pill>
              )}
            </div>
          </Card>
        </>
      )}

      <Card title="Historial" sub="Toca cualquier noche para corregirla">
        {history.length === 0 ? (
          <Empty icon="📋" title="Historial vacío" text="Aún no hay noches guardadas." />
        ) : (
          history.map((s) => {
            const dur = s.end - s.start;
            const conf = CONFIDENCE_LABEL[s.confidence];
            return (
              <button key={s.id} type="button" className="session" onClick={() => setEditing(s)}>
                <span className="session__day">{relativeDayLabel(s.end)}</span>
                <span className="session__dur">{formatDuration(dur)}</span>
                <span className="session__meta">
                  <span className="session__times">
                    {formatClock(s.start)}–{formatClock(s.end)}
                  </span>
                  <span className="session__track">
                    <span
                      className="session__fill"
                      style={{
                        left: 0,
                        width: `${Math.min(100, (dur / (10 * HOUR)) * 100)}%`,
                        background: s.confirmed ? 'var(--primary)' : 'var(--amber)',
                      }}
                    />
                  </span>
                  {s.source === 'auto' && <Pill tone={conf.tone}>{conf.text}</Pill>}
                </span>
              </button>
            );
          })
        )}
      </Card>

      {editing && (
        <SessionSheet
          session={editing}
          habitualStart={
            editing.inferred && !editing.nap
              ? habitualStart(editing, learnHabit(state.sessions, state.schedule))
              : null
          }
          onSave={saveSession}
          onDelete={state.sessions.some((s) => s.id === editing.id) ? deleteSession : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
