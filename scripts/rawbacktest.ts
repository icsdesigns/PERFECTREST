/**
 * Banco de pruebas con el registro bruto de un export de la app.
 *
 * `backtest.ts` sólo ve las sesiones guardadas. Este además pasa el registro
 * bruto (pantalla, luz, postura, pasos...) por `evaluateGaps` y mide la
 * propuesta contra la verdad que dejó el usuario en el comentario, para
 * poder ajustar los umbrales de los sensores con noches reales.
 *
 *   PERFECTREST_EXPORT=/ruta/export.json node node_modules/.perfectrest/rawbacktest.mjs
 *
 * Verdad de cada noche (mismo criterio que escribió el usuario):
 *   - comentario con hora («me acosté a las 00:00») → inicio real;
 *   - «no he dormido» → ahí no hubo sueño;
 *   - «correcto» o sin comentario desde el 15/11 → la propuesta es buena;
 *   - con PERFECTREST_NO_NAPS=1, toda siesta es un falso positivo (el usuario
 *     confirmó que no durmió ninguna en todo el registro del 24/11/2026).
 */
import { existsSync, readFileSync } from 'node:fs';

process.env.TZ ||= 'Europe/Madrid';

import { evaluateGaps, knownNights, refineEdges } from '../src/lib/activityMonitor';
import type { NativeGap } from '../src/lib/backgroundMonitor';
import { learnHabit, learnLatency } from '../src/lib/habit';
import { parseNote } from '../src/lib/noteTimes';
import type { RawEvent } from '../src/lib/rawEvents';
import { DEFAULT_GOALS } from '../src/lib/schedule';
import { HOUR, MINUTE } from '../src/lib/time';
import { DEFAULT_TRIGGERS } from '../src/lib/triggers';
import type { MonitorSettings, ScheduleSettings, SleepSession } from '../src/lib/types';

const path = process.env.PERFECTREST_EXPORT;
if (!path || !existsSync(path)) {
  console.log('\n--- Banco con registro bruto: sin PERFECTREST_EXPORT, se omite ---');
  process.exit(0);
}
const data = JSON.parse(readFileSync(path, 'utf8')) as {
  sessions: SleepSession[];
  rawEvents: RawEvent[];
  settings: Partial<MonitorSettings>;
};
const events = [...data.rawEvents].sort((a, b) => a.at - b.at);
const history = data.sessions
  .map((s) => ({ ...s, confirmed: true }))
  .sort((a, b) => a.start - b.start);
const firstRaw = events[0]?.at ?? 0;
/** Desde esta fecha el usuario dejó dicho que sin comentario = correcto. */
const SILENT_OK_FROM = Date.parse('2026-11-15T00:00:00+01:00');

const MON: MonitorSettings = {
  enabled: true,
  minGapMinutes: 180,
  maxGapMinutes: 780,
  nightStart: '21:30',
  nightEnd: '11:00',
  autoConfirm: false,
  background: true,
  wakeSummary: true,
  triggers: { ...DEFAULT_TRIGGERS },
  sensors: { ...(data.settings?.sensors as MonitorSettings['sensors']) },
  saveContext: true,
  contextSince: 0,
};
const SCHEDULE: ScheduleSettings = { mode: 'uniform', goals: { ...DEFAULT_GOALS } };

const fmt = (ms: number) =>
  new Date(ms).toLocaleString('es-ES', { weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const mins = (ms: number) => Math.round(ms / MINUTE);

let bad = 0;
let nights = 0;
let startErrSum = 0;
let startErrN = 0;
const verbose = !!process.env.PERFECTREST_VERBOSE;

history.forEach((s, i) => {
  if (s.end < firstRaw || !s.detectedStart || !s.detectedEnd) return;
  const t = parseNote(s);
  const silentOk = !s.note && s.end >= SILENT_OK_FROM;
  const falsePositive = t.notSleep || (!!s.nap && !!process.env.PERFECTREST_NO_NAPS);
  const truthStart = t.start ?? (t.accepted || silentOk ? s.start : null);
  if (truthStart === null && !falsePositive) return;
  nights++;

  const wakes = events
    .filter((e) => e.kind === 'unlock' && e.at > s.detectedStart! && e.at < s.detectedEnd!)
    .map((e) => e.at);
  const gap: NativeGap = {
    start: s.detectedStart,
    end: s.detectedEnd,
    startTrigger: s.triggers?.[0] ?? 'screen',
    endTrigger: s.triggers?.[0] ?? 'screen',
    wakes,
  };
  const before = history.slice(0, i);
  const habit = learnHabit(before, SCHEDULE, s.end);
  const learned = learnLatency(before);
  const { results, rejected } = evaluateGaps([gap], MON, {
    habit,
    events,
    known: knownNights([], []),
    latencyMinutes: learned ?? 15,
  });
  const r = results[0];
  const label = `${fmt(s.start)} → ${fmt(s.end)}`;
  if (!r) {
    const ok = falsePositive;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}  descartada (${rejected[0]?.reason}) ${falsePositive ? '' : '← noche real perdida'}`);
    return;
  }
  const refined = refineEdges(r.session, 15, { learnedLatencyMinutes: learned, habit, evidence: r.evidence });
  if (falsePositive) {
    bad++;
    console.log(`  FAIL ${label}  propuesta ${fmt(refined.start)} (${refined.confidence}${refined.inferred ? ', dudosa' : ''}) pero el usuario dice que no durmió`);
    return;
  }
  const err = Math.abs(refined.start - truthStart!);
  startErrSum += err;
  startErrN++;
  const flagged = refined.inferred || refined.confidence === 'low';
  const wrongFirm = err > 60 * MINUTE && !flagged;
  if (wrongFirm) bad++;
  if (verbose || err > 30 * MINUTE)
    console.log(
      `  ${wrongFirm ? 'FAIL' : 'ok  '} ${label}  inicio ${fmt(refined.start)} vs real ${fmt(truthStart!)} (${mins(err)} min) · final ${fmt(refined.end)} ( ${refined.confidence}${refined.inferred ? ', dudosa' : ''})`,
    );
});
console.log(
  `\n  noches con verdad: ${nights} · error medio de inicio ${startErrN ? Math.round(startErrSum / startErrN / MINUTE) : 0} min · fallos: ${bad}`,
);
void HOUR;
if (bad && process.env.PERFECTREST_STRICT) process.exit(1);
