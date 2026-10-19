import { cycleComposition } from '../lib/cycles';
import { HOUR, formatClock, formatDuration, relativeDayLabel } from '../lib/time';
import type { NightRecord } from '../lib/stats';
import './viz.css';

const PHASE_COLOR: Record<string, string> = {
  ligero: 'var(--primary)',
  profundo: 'var(--primary-soft)',
  rem: 'var(--mint)',
};

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number) {
  const start = polar(cx, cy, r, to);
  const end = polar(cx, cy, r, from);
  const large = to - from <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 0 ${end.x} ${end.y}`;
}

/**
 * Anillo de la noche: cada ciclo es un segmento, subdividido por fases.
 * El arco cubre 360° repartidos entre acostarse y despertar, de modo que la
 * proporción visual de cada ciclo es fiel a su duración.
 */
export function CycleRing({
  cycles,
  bedtime,
  wakeTime,
  sleepMs,
  latencyMs,
}: {
  cycles: number;
  bedtime: Date;
  wakeTime: Date;
  sleepMs: number;
  latencyMs: number;
}) {
  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const r = 96;
  const stroke = 20;

  const totalMs = sleepMs + latencyMs;
  const gapDeg = 1.6;

  // La latencia ocupa su parte proporcional al principio del anillo.
  const latencyDeg = (latencyMs / totalMs) * 360;
  const cycleDeg = ((sleepMs / totalMs) * 360) / cycles;

  const segments: { from: number; to: number; color: string; op: number }[] = [];
  segments.push({ from: 0, to: latencyDeg, color: 'var(--border)', op: 1 });

  for (let i = 0; i < cycles; i++) {
    const base = latencyDeg + i * cycleDeg;
    let cursor = base;
    for (const slice of cycleComposition(i, cycles)) {
      const span = slice.share * (cycleDeg - gapDeg);
      segments.push({
        from: cursor,
        to: cursor + span,
        color: PHASE_COLOR[slice.phase],
        op: slice.phase === 'profundo' ? 0.95 : 0.85,
      });
      cursor += span;
    }
  }

  // La costura del anillo: donde se junta acostarse con despertar. En un
  // anillo de 360° los dos extremos son el mismo punto, así que se marca una
  // vez. Antes había dos círculos, uno por extremo, y además de caer
  // exactamente uno encima del otro se dibujaban en la esquina del SVG:
  // `polar` devuelve {x, y} y `<circle>` necesita {cx, cy}, de modo que el
  // spread ponía atributos que el círculo ignora y cx/cy caían a cero.
  const seam = polar(cx, cy, r, 0);

  return (
    <div className="arc-wrap">
      {/* Fuera del SVG a propósito: dentro caía sobre el trazo del anillo, que
          empieza a 14px del borde del viewBox, y agrandar el viewBox habría
          descentrado la cifra del medio, que se posiciona sobre la caja. */}
      <div className="arc__range">
        {formatClock(bedtime)} → {formatClock(wakeTime)}
      </div>
      <div className="arc__ring">
        <svg className="arc" viewBox={`0 0 ${size} ${size}`} role="img"
          aria-label={`${cycles} ciclos de sueño, de ${formatClock(bedtime)} a ${formatClock(wakeTime)}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
          {segments.map((s, i) => (
            <path
              key={i}
              d={arcPath(cx, cy, r, s.from, s.to)}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeLinecap="butt"
              opacity={s.op}
            />
          ))}
          <circle
            cx={seam.x}
            cy={seam.y}
            r={5}
            fill="var(--bg)"
            stroke="var(--amber)"
            strokeWidth={2.5}
          />
        </svg>
        <div className="arc__center">
          <div className="arc__big">{formatDuration(sleepMs)}</div>
          <div className="arc__small">{cycles} ciclos completos</div>
        </div>
      </div>
    </div>
  );
}

export function PhaseLegend() {
  return (
    <div className="legend">
      {[
        ['Sueño ligero', PHASE_COLOR.ligero],
        ['Profundo', PHASE_COLOR.profundo],
        ['REM', PHASE_COLOR.rem],
        ['Conciliar el sueño', 'var(--border)'],
      ].map(([label, color]) => (
        <span key={label} className="legend__item">
          <span className="legend__dot" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * Barras de duración por noche con la línea de meta superpuesta.
 * El eje Y siempre arranca en 0 para que la comparación de alturas sea honesta.
 */
export function DurationChart({ nights }: { nights: NightRecord[] }) {
  const padL = 26;
  // Hasta dos semanas la gráfica se ajusta al ancho disponible; con más noches
  // mantiene un ancho por barra y se desplaza.
  const wide = nights.length > 14;
  const w = wide ? nights.length * 30 + padL : 300;
  const h = 168;
  const padB = 22;
  const padT = 8;

  const maxTarget = Math.max(...nights.map((n) => n.targetMs), 0);
  const maxDur = Math.max(...nights.map((n) => n.durationMs), 0);
  const maxMs = Math.max(maxTarget, maxDur, 8 * HOUR) * 1.1;
  const y = (ms: number) => padT + (1 - ms / maxMs) * (h - padT - padB);
  const plotW = w - padL;
  const bw = Math.min(26, (plotW / nights.length) * 0.6);

  return (
    <div className="chart-scroll">
      <svg className="chart" viewBox={`0 0 ${w} ${h}`} style={wide ? { minWidth: w } : undefined} role="img"
        aria-label="Duración del sueño por noche">
        {[2, 4, 6, 8, 10].map((hrs) =>
          hrs * HOUR <= maxMs ? (
            <g key={hrs}>
              <line x1={padL} x2={w} y1={y(hrs * HOUR)} y2={y(hrs * HOUR)} className="chart__grid" />
              <text x={0} y={y(hrs * HOUR) + 3} className="chart__axis">{hrs}h</text>
            </g>
          ) : null,
        )}

        {nights.map((n, i) => {
          const cx = padL + ((i + 0.5) / nights.length) * plotW;
          const hit = n.durationMs + 30 * 60_000 >= n.targetMs;
          const color = !n.session ? 'var(--surface-2)' : hit ? 'var(--mint)' : 'var(--primary)';
          const top = n.session ? y(n.durationMs) : y(0) - 3;
          return (
            <g key={n.key}>
              <line
                x1={cx - bw / 2 - 3}
                x2={cx + bw / 2 + 3}
                y1={y(n.targetMs)}
                y2={y(n.targetMs)}
                className="chart__goal"
              />
              <rect
                className="chart__bar"
                x={cx - bw / 2}
                y={top}
                width={bw}
                height={Math.max(3, y(0) - top)}
                rx={5}
                fill={color}
                opacity={n.session ? 0.92 : 1}
              >
                <title>
                  {relativeDayLabel(n.dayStart)}:{' '}
                  {n.session ? formatDuration(n.durationMs) : 'sin registro'}
                </title>
              </rect>
              <text x={cx} y={h - 6} textAnchor="middle" className="chart__axis">
                {new Date(n.dayStart).toLocaleDateString('es-ES', { weekday: 'narrow' })}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Franjas horizontales de acostarse→despertar. Deja ver de un vistazo si los
 * horarios se mantienen alineados o si bailan de un día a otro.
 */
export function ScheduleChart({ nights }: { nights: NightRecord[] }) {
  const withData = nights.filter((n) => n.session);
  if (!withData.length) return null;

  const w = 320;
  const rowH = 22;
  const h = withData.length * rowH + 24;
  // Eje: de las 18:00 a las 14:00 del día siguiente (20 h de ventana).
  const AXIS_START = 18 * 60;
  const AXIS_SPAN = 20 * 60;

  const toX = (ts: number) => {
    const d = new Date(ts);
    let m = d.getHours() * 60 + d.getMinutes();
    if (m < AXIS_START) m += 1440;
    return ((m - AXIS_START) / AXIS_SPAN) * w;
  };

  return (
    <div className="chart-scroll">
      <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Horarios de sueño por noche">
        {[18, 21, 24, 27, 30, 33].map((hr) => {
          const x = ((hr * 60 - AXIS_START) / AXIS_SPAN) * w;
          // Las etiquetas de los extremos se alinean hacia dentro para que no
          // queden cortadas por el borde del lienzo.
          const anchor = x <= 0 ? 'start' : x >= w ? 'end' : 'middle';
          return (
            <g key={hr}>
              <line x1={x} x2={x} y1={14} y2={h - 10} className="chart__grid" />
              <text x={x} y={9} textAnchor={anchor} className="chart__axis">
                {String(hr % 24).padStart(2, '0')}
              </text>
            </g>
          );
        })}
        {withData.map((n, i) => {
          const yTop = 18 + i * rowH;
          const x1 = toX(n.session!.start);
          const x2 = toX(n.session!.end);
          return (
            <g key={n.key}>
              <rect
                x={Math.min(x1, x2)}
                y={yTop}
                width={Math.max(4, Math.abs(x2 - x1))}
                height={12}
                rx={6}
                fill="var(--primary)"
                opacity={0.85}
              >
                <title>
                  {relativeDayLabel(n.dayStart)}: {formatClock(n.session!.start)} –{' '}
                  {formatClock(n.session!.end)}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
