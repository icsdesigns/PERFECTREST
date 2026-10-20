/**
 * Banco de pruebas con noches reales etiquetadas.
 *
 * Todo lo demás de `npm run check` prueba que la detección hace lo que se
 * diseñó; esto prueba que lo diseñado se parece a la realidad. Parte de un
 * historial real en el que el usuario ha ido escribiendo en el comentario la
 * hora a la que se acostó (o «correcto», o «no he dormido») y mide, noche a
 * noche, cuánto se equivoca la detección:
 *
 *   - error del inicio y del final respecto a lo que cuenta el comentario;
 *   - falsos positivos: sesiones que el usuario dice que no fueron sueño, y las
 *     cortas de tarde o de mañana que nadie ha etiquetado pero que no pueden
 *     serlo;
 *   - noches verdaderas que la detección nueva se habría tragado.
 *
 * El historial sólo guarda la sesión ya refinada, pero el id conserva el inicio
 * medido y el final se corrigió 5 min, así que el hueco bruto del dispositivo
 * se reconstruye exacto y se hace pasar de nuevo por la tubería actual
 * (`evaluateGaps` + `refineEdges`) contra la «antes» (la sesión tal como se
 * guardó con la tubería vieja).
 *
 * La detección nueva aprende de las noches anteriores: en el modo «en línea»
 * sólo de las que ya habían pasado (lo que vería un usuario real), y en el de
 * «una menos» de todas las demás, que es la estimación estable cuando ya hay
 * historial.
 *
 *   npm run check                                   con el fixture del repositorio
 *   PERFECTREST_LABELED=/ruta/historial.json npm run check   con tus propios datos
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Las horas del historial son hora de pared de quien lo escribió.
process.env.TZ ||= 'Europe/Madrid';

import { evaluateGaps, knownNights, refineEdges } from '../src/lib/activityMonitor';
import type { NativeGap } from '../src/lib/backgroundMonitor';
import { detectedStartOf, learnHabit, learnLatency } from '../src/lib/habit';
import { parseNote } from '../src/lib/noteTimes';
import { DEFAULT_GOALS } from '../src/lib/schedule';
import { DEFAULT_SENSORS } from '../src/lib/sensors';
import { HOUR, MINUTE } from '../src/lib/time';
import { DEFAULT_TRIGGERS } from '../src/lib/triggers';
import type { MonitorSettings, ScheduleSettings, SleepSession } from '../src/lib/types';

let failures = 0;
function assert(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

// La suite se compila a un paquete temporal dentro de node_modules, así que el
// fixture se busca desde la raíz del proyecto (donde se lanza `npm run check`).
const external = process.env.PERFECTREST_LABELED;
const path = external ?? resolve(process.cwd(), 'scripts/fixtures/sueno-etiquetado.json');
const usingFixture = !external;

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
  sensors: { ...DEFAULT_SENSORS },
};
const SCHEDULE: ScheduleSettings = { mode: 'uniform', goals: { ...DEFAULT_GOALS } };
const LATENCY = 15;
/** Cuánto se recortó el final al guardar la sesión con la tubería vieja. */
const OLD_END_BIAS = 5 * MINUTE;

console.log(`\n--- Banco de pruebas con noches reales (${usingFixture ? 'fixture' : path}) ---`);
if (!existsSync(path)) {
  console.log(`  FAIL no existe ${path}`);
  process.exit(1);
}
const history: SleepSession[] = (JSON.parse(readFileSync(path, 'utf8')) as SleepSession[])
  .map((s) => ({ ...s, confirmed: true, detectedStart: detectedStartOf(s) ?? s.start }))
  .sort((a, b) => a.start - b.start);

// --- Verdad de cada noche, según el comentario ------------------------------

interface Truth {
  /** Hora real de acostarse, si se conoce (o si el usuario aceptó la detectada). */
  start: number | null;
  end: number | null;
  /** El usuario dice que ahí no hubo sueño. */
  falsePositive: boolean;
  labeled: boolean;
}

function truthOf(s: SleepSession): Truth {
  const t = parseNote(s);
  const accepted = t.accepted && !t.notSleep;
  return {
    start: t.start ?? (accepted ? s.start : null),
    end: t.end,
    falsePositive: t.notSleep,
    labeled: t.start !== null || t.end !== null || accepted || t.notSleep,
  };
}

const truths = history.map(truthOf);
const labeled = truths.filter((t) => t.labeled).length;
console.log(`  ${history.length} sesiones, ${labeled} con comentario útil`);

// --- La tubería nueva sobre los huecos brutos --------------------------------

type Mode = 'online' | 'leave-one-out';

interface Outcome {
  session: SleepSession | null;
  reason?: string;
}

function replay(mode: Mode): Outcome[] {
  const outcomes: Outcome[] = [];
  const known: SleepSession[] = [];

  history.forEach((s, i) => {
    const gap: NativeGap = {
      start: s.detectedStart ?? s.start,
      end: s.end + OLD_END_BIAS,
      startTrigger: s.triggers?.[0] ?? 'screen',
      endTrigger: s.triggers?.[0] ?? 'screen',
    };
    // Lo que se sabía de las demás noches al llegar ésta.
    const learnFrom =
      mode === 'online' ? history.slice(0, i) : history.filter((_, j) => j !== i);
    const habit = learnHabit(learnFrom, SCHEDULE, s.end);
    const { results, rejected } = evaluateGaps([gap], MON, { habit, known: knownNights([], known) });
    const mine = results[0];
    if (!mine) {
      outcomes.push({ session: null, reason: rejected[0]?.reason });
      return;
    }
    const refined = refineEdges(mine.session, LATENCY, {
      learnedLatencyMinutes: learnLatency(learnFrom),
      habit,
      evidence: mine.evidence,
    });
    known.push(refined);
    outcomes.push({ session: refined });
  });
  return outcomes;
}

// --- Métricas -----------------------------------------------------------------

const min = (ms: number) => Math.round(Math.abs(ms) / MINUTE);
const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface Metrics {
  startErrors: number[];
  endErrors: number[];
  falsePositives: number;
  falsePositivesTotal: number;
  /** Sesiones cortas (<4,5 h) sin etiqueta: según el diagnóstico, casi seguro no son sueño. */
  suspect: number;
  suspectTotal: number;
  missed: number;
  missedTotal: number;
  highConfidenceWrong: number;
  /** Inicio de las propuestas que no van marcadas como dudosas (`inferred`). */
  firmStartErrors: number[];
  /** Propuestas marcadas como dudosas: inicio deducido o sin evidencia que lo respalde. */
  doubtful: number;
  /** Inicios equivocados por más de una hora que NO van marcados como dudosos. */
  wrongButFirm: number;
}

function measure(sessions: Array<SleepSession | null>): Metrics {
  const m: Metrics = {
    startErrors: [],
    endErrors: [],
    falsePositives: 0,
    falsePositivesTotal: 0,
    suspect: 0,
    suspectTotal: 0,
    missed: 0,
    missedTotal: 0,
    highConfidenceWrong: 0,
    firmStartErrors: [],
    doubtful: 0,
    wrongButFirm: 0,
  };
  history.forEach((orig, i) => {
    const t = truths[i];
    const s = sessions[i];
    if (t.falsePositive) {
      m.falsePositivesTotal++;
      if (s) m.falsePositives++;
      return;
    }
    const isNight = t.start !== null || t.end !== null;
    if (isNight) {
      m.missedTotal++;
      if (!s) {
        m.missed++;
        return;
      }
      if (t.start !== null) {
        const err = min(s.start - t.start);
        m.startErrors.push(err);
        if (s.confidence === 'high' && err > 60) m.highConfidenceWrong++;
        if (s.inferred) m.doubtful++;
        else {
          m.firmStartErrors.push(err);
          if (err > 60) m.wrongButFirm++;
        }
      }
      if (t.end !== null) m.endErrors.push(min(s.end - t.end));
    } else if (!t.labeled && orig.end - orig.start < 4.5 * HOUR) {
      m.suspectTotal++;
      if (s) m.suspect++;
    }
  });
  return m;
}

function report(name: string, m: Metrics) {
  const over60 = m.startErrors.filter((e) => e > 60).length;
  console.log(
    `  ${name.padEnd(22)}` +
      ` inicio: error medio ${Math.round(mean(m.startErrors))} min, mediana ${median(m.startErrors)}, >60 min en ${over60}/${m.startErrors.length}` +
      ` | final: medio ${Math.round(mean(m.endErrors))} min (${m.endErrors.length})` +
      ` | falsos positivos ${m.falsePositives}/${m.falsePositivesTotal}` +
      ` | cortas sospechosas ${m.suspect}/${m.suspectTotal}` +
      ` | noches perdidas ${m.missed}/${m.missedTotal}`,
  );
  console.log(
    `  ${''.padEnd(22)}` +
      ` de ellas dudosas (inicio inferido): ${m.doubtful}/${m.startErrors.length}` +
      ` | inicio de las no dudosas: error medio ${Math.round(mean(m.firmStartErrors))} min (${m.firmStartErrors.length})` +
      ` | >60 min sin marcar como dudosas: ${m.wrongButFirm}`,
  );
}

const before = measure(history);
const onlineRun = replay('online');
const online = measure(onlineRun.map((o) => o.session));
const loo = replay('leave-one-out');
const looM = measure(loo.map((o) => o.session));

console.log('');
report('antes (guardado)', before);
report('después (en línea)', online);
report('después (una menos)', looM);

if (process.env.PERFECTREST_VERBOSE) {
  console.log('\n  noche a noche (hora de acostarse: medida / real / antes / después, una menos / en línea):');
  const hm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
  history.forEach((s, i) => {
    const t = truths[i];
    if (t.start === null) return;
    const a = loo[i].session;
    const o = onlineRun[i].session;
    console.log(
      `    medida ${hm(s.detectedStart ?? s.start)}  real ${hm(t.start)}  antes ${hm(s.start)} (${min(s.start - t.start)} min)  después ${a ? `${hm(a.start)} (${min(a.start - t.start)} min, ${a.confidence})` : 'descartada'}  en línea ${o ? `${min(o.start - t.start)} min` : 'descartada'}`,
    );
  });
}

if (process.env.PERFECTREST_VERBOSE) {
  history.forEach((s, i) => {
    if (truths[i].start !== null && !onlineRun[i].session) {
      console.log(`  (en línea) noche etiquetada descartada: ${new Date(s.start).toString().slice(0, 21)} ${onlineRun[i].reason}`);
    }
  });
}

// Lo descartado sin etiqueta, para que el dueño lo revise a ojo.
const dropped = history
  .map((s, i) => ({ s, o: loo[i], t: truths[i] }))
  .filter(({ o, t }) => !o.session && !t.falsePositive);
if (dropped.length) {
  console.log('\n  descartadas por la detección nueva (revisar a ojo):');
  for (const { s, o, t } of dropped) {
    const f = (ts: number) => new Date(ts).toLocaleString('es-ES', { weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    console.log(
      `    ${f(s.start)} → ${f(s.end)}  ${((s.end - s.start) / HOUR).toFixed(1)} h  ${o.reason}${t.labeled ? '  (CON etiqueta de noche)' : ''}`,
    );
  }
}

// --- Condiciones --------------------------------------------------------------

console.log('');
if (usingFixture) {
  assert(
    'el inicio mejora: el error medio baja a menos de la mitad',
    mean(looM.startErrors) < mean(before.startErrors) / 2,
    [Math.round(mean(looM.startErrors)), Math.round(mean(before.startErrors))],
  );
  assert(
    'ninguna noche etiquetada como sueño se pierde',
    looM.missed === 0 && online.missed === 0,
    [looM.missed, online.missed],
  );
  assert(
    'los falsos positivos etiquetados desaparecen, también en línea (sin hábito aprendido aún)',
    looM.falsePositives === 0 && online.falsePositives === 0 && before.falsePositives > 0,
    [looM.falsePositives, online.falsePositives, before.falsePositives],
  );
  assert(
    'las sesiones cortas sospechosas se reducen al menos a un tercio',
    looM.suspect <= before.suspect / 3,
    [looM.suspect, before.suspect],
  );
  assert(
    'con el hábito ya aprendido, ningún inicio equivocado por más de una hora se da por bueno: va marcado como dudoso',
    looM.wrongButFirm === 0,
    looM.wrongButFirm,
  );
  assert(
    'las propuestas no dudosas tienen el inicio a menos de 20 min de media, también en línea',
    mean(looM.firmStartErrors) < 20 && mean(online.firmStartErrors) < 20,
    [Math.round(mean(looM.firmStartErrors)), Math.round(mean(online.firmStartErrors))],
  );
  assert(
    'ya no hay noches de confianza alta con un inicio 60 min equivocado',
    looM.highConfidenceWrong === 0,
    looM.highConfidenceWrong,
  );
  assert(
    'ninguna sesión resultante pasa del techo de 13 h (más lo que refina)',
    loo.every((o) => !o.session || o.session.end - o.session.start <= 13.5 * HOUR),
  );
}

console.log(failures ? `\n${failures} comprobación(es) fallidas` : '\nTodo correcto');
process.exit(failures ? 1 : 0);
