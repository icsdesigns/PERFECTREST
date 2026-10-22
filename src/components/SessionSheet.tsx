import { useState } from 'react';
import { Pill } from './ui';
import { describeTriggers } from '../lib/triggers';
import { describeContext } from '../lib/sessionContext';
import { formatClock, formatDuration } from '../lib/time';
import type { SleepSession } from '../lib/types';

/** Convierte un epoch a los valores que necesita <input type="datetime-local">. */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

const QUALITY_FACES = ['😴', '🙁', '😐', '🙂', '🤩'];

/** Hoja inferior para crear o corregir una sesión de sueño. */
export function SessionSheet({
  session,
  habitualStart = null,
  onSave,
  onDelete,
  onClose,
}: {
  session: SleepSession;
  /**
   * Tu hora habitual de acostarte puesta en esta noche, para ofrecerla como
   * inicio cuando el inicio no está medido. Sólo se aplica si el usuario toca
   * el botón.
   */
  habitualStart?: number | null;
  onSave: (s: SleepSession) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const [start, setStart] = useState(session.start);
  const [end, setEnd] = useState(session.end);
  const [quality, setQuality] = useState(session.quality);
  const [note, setNote] = useState(session.note ?? '');
  // ¿El inicio es la hora habitual aplicada con el botón? Editar la hora a mano lo deshace.
  const [habitApplied, setHabitApplied] = useState(!!session.habitStart);

  const duration = end - start;
  const invalid = duration <= 0;
  const origin = session.source === 'auto' ? describeTriggers(session.triggers) : null;

  const save = () => {
    if (invalid) return;
    onSave({
      ...session,
      start,
      end,
      quality,
      note: note.trim() || undefined,
      confirmed: true,
      source: session.source === 'auto' ? 'edited' : session.source,
      // Revisada por ti: el inicio ya no es una deducción.
      inferred: undefined,
      habitStart: habitApplied ? true : undefined,
    });
    onClose();
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Editar sesión de sueño"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet__panel">
        <div className="sheet__grab" />
        <h2 className="sheet__title">
          {session.source === 'auto' ? 'Confirma esta noche' : 'Editar registro'}
        </h2>

        <div className="row">
          <div>
            <div className="row__label">Me dormí</div>
          </div>
          <input
            type="datetime-local"
            className="timefield"
            value={toLocalInput(start)}
            aria-label="Inicio del sueño"
            onChange={(e) => {
              if (!e.target.value) return;
              setStart(new Date(e.target.value).getTime());
              setHabitApplied(false);
            }}
          />
        </div>

        <div className="row">
          <div>
            <div className="row__label">Me desperté</div>
          </div>
          <input
            type="datetime-local"
            className="timefield"
            value={toLocalInput(end)}
            aria-label="Fin del sueño"
            onChange={(e) => e.target.value && setEnd(new Date(e.target.value).getTime())}
          />
        </div>

        {origin && (
          <div className="row">
            <div>
              <div className="row__label">Detectado por</div>
              <div className="row__hint">Señales que marcaron el principio y el final</div>
            </div>
            <Pill tone="muted">{origin}</Pill>
          </div>
        )}

        {session.inferred && (
          <div className="row">
            <div>
              <div className="row__label">Inicio sin medir</div>
              <div className="row__hint">
                El móvil no sabe si a esa hora dormías o estabas despierto sin
                tocarlo. Ajusta la hora de dormirte si no es así.
              </div>
            </div>
          </div>
        )}

        {habitualStart !== null && !habitApplied && (
          <button
            type="button"
            className="btn btn--ghost btn--full"
            style={{ marginTop: 'var(--sp-2)' }}
            onClick={() => {
              setStart(habitualStart);
              setHabitApplied(true);
            }}
          >
            ¿Desde las {formatClock(habitualStart)}, como sueles?
          </button>
        )}
        {habitApplied && (
          <p className="row__hint" style={{ marginTop: 'var(--sp-2)' }}>
            El inicio es tu hora habitual, puesta por ti. Cámbiala si esa noche fue distinta.
          </p>
        )}

        <div className="row">
          <div className="row__label">Total dormido</div>
          {invalid ? (
            <Pill tone="rose">El despertar debe ir después</Pill>
          ) : (
            <Pill tone="primary">{formatDuration(duration)}</Pill>
          )}
        </div>

        <div style={{ marginTop: 'var(--sp-4)' }}>
          <div className="row__label" style={{ marginBottom: 'var(--sp-3)' }}>
            ¿Cómo descansaste?
          </div>
          <div className="quality">
            {QUALITY_FACES.map((face, i) => (
              <button
                key={face}
                type="button"
                className="quality__btn"
                aria-pressed={quality === i + 1}
                aria-label={`Calidad ${i + 1} de 5`}
                onClick={() => setQuality(quality === i + 1 ? undefined : i + 1)}
              >
                {face}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 'var(--sp-4)' }}>
          <label className="row__label" htmlFor="session-note" style={{ display: 'block', marginBottom: 'var(--sp-3)' }}>
            Comentario
          </label>
          <textarea
            id="session-note"
            className="timefield"
            rows={3}
            value={note}
            placeholder="Me desperté a las cuatro, cené tarde…"
            onChange={(e) => setNote(e.target.value)}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontWeight: 400 }}
          />
        </div>

        <ContextDetails session={session} />

        <div className="pending__actions">
          <button className="btn btn--ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn--primary" onClick={save} disabled={invalid}>Guardar</button>
        </div>

        {onDelete && (
          <button
            className="btn btn--danger btn--full"
            style={{ marginTop: 'var(--sp-3)' }}
            onClick={() => {
              onDelete(session.id);
              onClose();
            }}
          >
            Eliminar registro
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Contexto del dispositivo de la noche, plegado: es material para analizar la
 * detección, no para leer cada mañana. Sin contexto (sesiones anteriores a la
 * función, o con el ajuste apagado) no se muestra nada.
 */
function ContextDetails({ session }: { session: SleepSession }) {
  const sections = describeContext(session.context);
  if (!sections.length) return null;
  return (
    <details className="ctx">
      <summary className="ctx__summary">Contexto del dispositivo</summary>
      <p className="row__hint">
        Lo que hizo el móvil entre media hora antes de dormirte y media hora después de despertar.
        Se calcula y se guarda sólo en este dispositivo: sin ubicación, nombres de redes ni de
        aparatos, ni contenido de notificaciones.
      </p>
      {sections.map((section) => (
        <div key={section.title} className="ctx__section">
          <div className="ctx__title">{section.title}</div>
          {section.rows.map((row) => (
            <div key={row.label} className="ctx__row">
              <span className="ctx__label">{row.label}</span>
              <span className="ctx__value">{row.value}</span>
            </div>
          ))}
        </div>
      ))}
    </details>
  );
}
