import { useId, useState, type ReactNode } from 'react';
import './ui.css';

export function Card({
  title,
  sub,
  action,
  children,
  accent,
  flush,
  className = '',
  collapsible,
  defaultOpen = false,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  accent?: boolean;
  flush?: boolean;
  className?: string;
  /** Cabecera pulsable que pliega y despliega el contenido. */
  collapsible?: boolean;
  /** Sólo con `collapsible`: si arranca desplegada. Por defecto, plegada. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  if (collapsible) {
    return (
      <section
        className={`card card--collapsible ${open ? 'is-open' : ''} ${accent ? 'card--accent' : ''} ${className}`}
      >
        <button
          type="button"
          className="card__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="card__toggle-text">
            {title && <h2 className="card__title">{title}</h2>}
            {sub && <span className="card__sub">{sub}</span>}
          </span>
          {action}
          <span className="card__chevron" aria-hidden="true" />
        </button>
        {/* `hidden` y no desmontar: conserva el estado y los sondeos de los hijos. */}
        <div id={bodyId} className="card__body" hidden={!open}>
          {children}
        </div>
      </section>
    );
  }

  return (
    <section
      className={`card ${accent ? 'card--accent' : ''} ${flush ? 'card--flush' : ''} ${className}`}
    >
      {(title || action) && (
        <header className="card__head">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {sub && <p className="card__sub">{sub}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="seg__item"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button type="button" className="toggle" aria-pressed={checked} onClick={() => onChange(!checked)}>
      <span>
        <span className="toggle__label">{label}</span>
        {hint && <span className="toggle__hint" style={{ display: 'block' }}>{hint}</span>}
      </span>
      <span className="toggle__switch" aria-hidden="true" />
    </button>
  );
}

export function Stepper({
  value,
  min,
  max,
  step,
  onChange,
  format,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  label?: string;
}) {
  // Se redondea a la rejilla del paso para que sumar 0.25 siete veces no
  // arrastre error de coma flotante en el valor mostrado.
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper__btn"
        onClick={() => onChange(clamp(value - step))}
        disabled={value <= min}
        aria-label="Reducir"
      >
        −
      </button>
      <span className="stepper__value">{format(value)}</span>
      <button
        type="button"
        className="stepper__btn"
        onClick={() => onChange(clamp(value + step))}
        disabled={value >= max}
        aria-label="Aumentar"
      >
        +
      </button>
    </div>
  );
}

export function TimeField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <input
      type="time"
      className="timefield"
      value={value}
      aria-label={label}
      onChange={(e) => e.target.value && onChange(e.target.value)}
    />
  );
}

/** Desplegable con el mismo aspecto que el campo de hora, para filas de ajustes. */
export function SelectField<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <select
      className="selectfield"
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export type PillTone = 'primary' | 'mint' | 'amber' | 'rose' | 'muted';

export function Pill({ tone = 'muted', children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

export function Row({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="row">
      <div>
        <div className="row__label">{label}</div>
        {hint && <div className="row__hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function Empty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <div className="empty__title">{title}</div>
      <p className="empty__text">{text}</p>
    </div>
  );
}

export function Metric({
  value,
  label,
  note,
  tone,
}: {
  value: ReactNode;
  label: string;
  note?: ReactNode;
  tone?: PillTone;
}) {
  const color =
    tone === 'mint' ? 'var(--mint)'
    : tone === 'amber' ? 'var(--amber)'
    : tone === 'rose' ? 'var(--rose)'
    : tone === 'primary' ? 'var(--primary-soft)'
    : 'var(--text)';
  return (
    <div>
      <div className="metric__value" style={{ color }}>{value}</div>
      <div className="metric__label">{label}</div>
      {note && <div className="metric__note" style={{ color: 'var(--text-faint)' }}>{note}</div>}
    </div>
  );
}

export function Bar({ pct, tone }: { pct: number; tone?: string }) {
  return (
    <div className="bar">
      <div
        className="bar__fill"
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          ...(tone ? { background: tone } : null),
        }}
      />
    </div>
  );
}
