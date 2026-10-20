/**
 * Comprobaciones de la precisión de la detección: lo que se añadió para que el
 * inicio, el final y la confianza de una noche se parezcan a lo que de verdad
 * pasó, no sólo a lo que midió el móvil.
 *
 *   hábito y latencia  aprendidos de las noches corregidas
 *   una noche por día  la tarde y la mañana de después no son sueño
 *   micro-despertares  recortan el hueco por ambos extremos
 *   sensores           pasos, luz, audio y alarma afinan los bordes
 *
 *   npm run check
 */
import {
  MAX_PLAUSIBLE_SLEEP_MS,
  evaluateGap,
  evaluateGaps,
  proposeFromSchedule,
  refineEdges,
  supersedesPending,
} from '../src/lib/activityMonitor';
import type { NativeGap } from '../src/lib/backgroundMonitor';
import { learnHabit, learnLatency, circularMean, circularSpread, minuteDiff } from '../src/lib/habit';
import { parseNote } from '../src/lib/noteTimes';
import {
  LIGHT_BRIGHT,
  LIGHT_DARK,
  NO_EVIDENCE,
  POSTURE_CARRIED,
  POSTURE_FLAT_DOWN,
  POSTURE_FLAT_UP,
  POSTURE_TILTED,
  gatherEvidence,
  lastSustainedUse,
  quietEvidence,
  type GapEvidence,
  type RawEvent,
} from '../src/lib/rawEvents';
import { DEFAULT_SENSORS, activeSensors } from '../src/lib/sensors';
import { DEFAULT_GOALS } from '../src/lib/schedule';
import { DEFAULT_TRIGGERS } from '../src/lib/triggers';
import { rawEventsToCsv, rawEventsToJson } from '../src/lib/exportSessions';
import { HOUR, MINUTE, formatDuration } from '../src/lib/time';
import type { MonitorSettings, ScheduleSettings, SleepSession } from '../src/lib/types';

let failures = 0;
function assert(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

const at = (iso: string) => new Date(iso).getTime();
const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 5);

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
const gap = (from: string, to: string, extra: Partial<NativeGap> = {}): NativeGap => ({
  start: at(from),
  end: at(to),
  startTrigger: 'screen',
  endTrigger: 'screen',
  ...extra,
});

const flat: ScheduleSettings = { mode: 'uniform', goals: { ...DEFAULT_GOALS } };

// --- Comentarios con la hora real ------------------------------------------

console.log('\n--- Precisión: lo que cuenta el comentario ---');
{
  const base = { start: at('2026-09-18T22:07:00'), end: at('2026-09-19T07:30:00') };
  const p = (note: string) => parseNote({ ...base, note });

  const a = p('Empecé a dormir a las 00:10');
  assert('«empecé a dormir a las 00:10» da la hora de acostarse',
    a.start !== null && clock(a.start) === '00:10' && a.start > base.start, a.start && clock(a.start));
  const b = p('Me acosté casi a las 1:00');
  assert('«casi a las 1:00» es la una de la madrugada', b.start !== null && clock(b.start) === '01:00');
  const c = p('Me acosté sobre las 12:30');
  assert('«12:30» tras las diez de la noche es medianoche y media',
    c.start !== null && clock(c.start) === '00:30', c.start && clock(c.start));
  const d = p('Me acoste a la 1:30');
  assert('«a la 1:30» también se entiende', d.start !== null && clock(d.start) === '01:30');
  const e = p('Me acoste sobre 00:20');
  assert('sin «las»: «sobre 00:20»', e.start !== null && clock(e.start) === '00:20');
  assert('«Correcto» acepta la sesión', p('Correcto').accepted && p('Correcto').start === null);
  assert('«Me fui a dormir unos minutos antes» no inventa una hora',
    p('Me fui a dormir unos minutos antes, pero es un margen aceptable').start === null);
  const f = p('Esto es falso, tan solo ha estado inactivo. Es inviable dormir solo ese tiempo');
  assert('«esto es falso» marca que no hubo sueño', f.notSleep && f.start === null);
  const g = p('No dormí nada\nMe acoste a la 1:30');
  assert('«no dormí nada» antes de una hora de acostarse no anula la noche',
    !g.notSleep && g.start !== null);
  const h = parseNote({ ...base, end: at('2026-09-19T10:42:00'),
    note: 'Me levanté sobre las 8:00. A las 6:19 desbloqueé el móvil momentáneamente' });
  assert('«me levanté sobre las 8:00» da el final, no el 6:19',
    h.end !== null && clock(h.end) === '08:00', h.end && clock(h.end));
  const i = p('No he dormido aun en este periodo\nEs correcto');
  assert('«no he dormido… es correcto» se contradice: no se usa a favor ni en contra',
    !i.accepted && !i.notSleep && i.start === null);
  assert('una sesión sin comentario no da nada', parseNote(base).start === null && !parseNote(base).accepted);
  assert('«es un margen aceptable» da la sesión por buena',
    p('Me fui a dormir unos minutos antes, pero es un margen aceptable').accepted);
  assert('«no es aceptable» no', !p('Esto no es aceptable').accepted);
  assert('ni «inaceptable»', !p('Un error inaceptable').accepted);
}

// --- Hábito y latencia ------------------------------------------------------

console.log('\n--- Precisión: hábito y latencia aprendidos ---');
{
  assert('la media circular de 23:50 y 00:10 es medianoche',
    Math.abs(minuteDiff(circularMean([23 * 60 + 50, 10]), 0)) < 1);

  const habitFromSchedule = learnHabit([], flat, at('2026-09-20T12:00:00'));
  assert('sin historial el hábito sale del horario', habitFromSchedule.n === 0);

  const night = (
    day: number,
    startH: number,
    startM: number,
    extra: Partial<SleepSession> = {},
    lead = 90 * MINUTE,
  ): SleepSession => {
    const start = at(`2026-09-${String(day).padStart(2, '0')}T00:00:00`) + startH * HOUR + startM * MINUTE;
    return {
      id: `auto-${start - lead}`,
      start: start - 15 * MINUTE,
      end: start + 8 * HOUR,
      source: 'auto',
      confidence: 'medium',
      confirmed: true,
      triggers: ['screen'],
      detectedStart: start - lead,
      ...extra,
    };
  };
  // Cuatro noches con la hora real escrita: se acuesta sobre las 00:30.
  const taught = [10, 11, 12, 13].map((d) =>
    night(d, 0, 30, { note: 'Me acosté sobre las 00:30' }, 3 * HOUR),
  );
  const habit = learnHabit(taught, flat);
  assert('con cuatro noches corregidas el hábito sale de ellas',
    habit.n === 4 && Math.abs(minuteDiff(habit.startMin, 30)) <= 2, habit);
  const untouched = [10, 11, 12, 13].map((d) => night(d, 21, 30));
  assert('las detecciones sin revisar no enseñan el hábito (su inicio es lo que se corrige)',
    learnHabit(untouched, flat).n === 0);

  assert('con pocas noches corregidas no se aprende la latencia', learnLatency(taught.slice(0, 3)) === null);
  const near = [10, 11, 12, 13].map((d) =>
    night(d, 0, 30, { note: 'Me acosté sobre las 00:30' }, 15 * MINUTE),
  );
  const lat = learnLatency(near);
  assert('la latencia es la mediana entre el inicio medido y el real', lat !== null && Math.abs(lat - 15) < 1, lat);
  assert('un desfase de horas no es latencia de dormirse: se ignora', learnLatency(taught) === null);

  // Las noches aceptadas tal cual también enseñan: si se dieron por buenas con
  // 15 min de latencia, la latencia es ésa. Sin ellas sólo enseñaban las noches
  // que salieron mal y la latencia aprendida se inflaba.
  const accepted = [10, 11, 12].map((d) => night(d, 1, 0, { note: 'Correcto' }, 30 * MINUTE));
  const corrected = night(14, 0, 30, { note: 'Me acosté sobre las 00:30' }, 45 * MINUTE);
  const mixedLat = learnLatency([...accepted, corrected]);
  assert('las noches aceptadas cuentan para la latencia',
    mixedLat !== null && Math.abs(mixedLat - 15) < 1, mixedLat);
  assert('pero «no he dormido… es correcto» no',
    learnLatency([...accepted, night(15, 1, 0, { note: 'No he dormido aún\nEs correcto' }, 30 * MINUTE)]) === null);
}

// --- Elección de la noche del día ------------------------------------------

console.log('\n--- Precisión: una noche principal por día ---');
{
  const sep = evaluateGaps(
    [
      gap('2026-09-22T23:04:00', '2026-09-23T06:09:00'),
      // La mañana de después de despertar, sin tocar el móvil: no es sueño.
      gap('2026-09-23T06:30:00', '2026-09-23T09:50:00'),
    ],
    MON,
  );
  assert('la mañana tras despertar no se propone como segunda sesión',
    sep.results.length === 1 && clock(sep.results[0].session.start) === '23:04',
    sep.results.map((r) => `${clock(r.session.start)}→${clock(r.session.end)}`));
  assert('y queda anotada como descartada',
    sep.rejected.length === 1, sep.rejected.map((r) => r.reason));

  // Desvelo de 40 min con el móvil a las tres: la noche queda en dos huecos y
  // el segundo, que empieza de madrugada, ya no se pierde.
  const desvelo = evaluateGaps(
    [gap('2026-09-18T23:30:00', '2026-09-19T03:00:00'), gap('2026-09-19T03:40:00', '2026-09-19T08:00:00')],
    MON,
  );
  assert('un desvelo de madrugada no parte la noche ni pierde la segunda mitad',
    desvelo.results.length === 1 &&
      clock(desvelo.results[0].session.start) === '23:30' &&
      clock(desvelo.results[0].session.end) === '08:00',
    desvelo.results.map((r) => `${clock(r.session.start)}→${clock(r.session.end)}`));
  const tardeAntes = evaluateGaps(
    [gap('2026-09-18T19:40:00', '2026-09-18T23:20:00'), gap('2026-09-19T00:10:00', '2026-09-19T08:00:00')],
    MON,
  );
  assert('pero la tarde quieta de antes de acostarse no se une a la noche',
    tardeAntes.results.length === 1 && clock(tardeAntes.results[0].session.start) === '00:10',
    tardeAntes.results.map((r) => `${clock(r.session.start)}→${clock(r.session.end)}`));

  const tarde = evaluateGaps([gap('2026-09-23T16:21:00', '2026-09-23T19:37:00')], MON);
  assert('una tarde quieta de 3h fuera de tu hora de acostarte se descarta',
    tarde.results.length === 0 && tarde.rejected.length === 1, tarde.rejected[0]?.reason);
  const tardeNoche = evaluateGaps([gap('2026-09-24T18:43:00', '2026-09-24T21:55:00')], MON);
  assert('y si roza la ventana nocturna, lo para el patrón de tu hora de acostarte',
    tardeNoche.results.length === 0 && tardeNoche.rejected[0]?.reason === 'out-of-pattern',
    tardeNoche.rejected[0]?.reason);

  // Con el hábito todavía sin aprender (del horario: 23:00), una tarde quieta
  // que acaba justo al irse a la cama empieza «cerca» de esa hora, pero no
  // cubre nada de la noche: como el falso positivo «20:43 → 23:41» de los datos.
  const sinHabito = { startMin: 23 * 60, endMin: 7 * 60, n: 0 };
  const tardeHastaLaCama = evaluateGaps([gap('2026-09-24T20:35:00', '2026-09-24T23:41:00')], MON, {
    habit: sinHabito,
  });
  assert('una tarde quieta que termina al acostarte no es una noche',
    tardeHastaLaCama.results.length === 0 && tardeHastaLaCama.rejected[0]?.reason === 'out-of-pattern',
    tardeHastaLaCama.rejected[0]?.reason);
  const nocheCorta = evaluateGaps([gap('2026-09-25T00:40:00', '2026-09-25T04:50:00')], MON, {
    habit: sinHabito,
  });
  assert('pero una noche corta que sí cubre la madrugada se propone', nocheCorta.results.length === 1);

  const tardeYnoche = evaluateGaps(
    [gap('2026-09-24T17:41:00', '2026-09-24T21:21:00'), gap('2026-09-24T22:29:00', '2026-09-25T07:36:00')],
    MON,
  );
  assert('la tarde despierto antes de la noche tampoco',
    tardeYnoche.results.length === 1 && clock(tardeYnoche.results[0].session.start) === '22:29');

  const better = evaluateGaps([gap('2026-09-25T23:30:00', '2026-09-26T07:30:00')], MON, {
    known: [{ start: at('2026-09-25T20:30:00'), end: at('2026-09-25T23:20:00'), rank: 0.35 }],
  });
  assert('una propuesta sin revisar de la tarde no tapa la noche de verdad que llega después',
    better.results.length === 1);
  const firm = evaluateGaps([gap('2026-09-25T23:30:00', '2026-09-26T07:30:00')], MON, {
    known: [{ start: at('2026-09-25T20:30:00'), end: at('2026-09-26T07:00:00') }],
  });
  assert('pero una noche firme del mismo día sí', firm.results.length === 0);

  // Y en la cola: la tarde que se propuso al irse a la cama deja su sitio a la
  // noche que llega por la mañana, en vez de quedarse la primera esperando.
  const auto = (from: string, to: string, extra: Partial<SleepSession> = {}): SleepSession => ({
    id: `auto-${at(from)}`, start: at(from), end: at(to), source: 'auto', confidence: 'medium',
    confirmed: false, ...extra,
  });
  const tardePendiente = auto('2026-09-25T20:30:00', '2026-09-25T23:20:00', { confidence: 'low' });
  const nocheNueva = auto('2026-09-25T23:45:00', '2026-09-26T07:30:00', { confidence: 'high' });
  assert('la noche de verdad sustituye en la cola a la tarde sin revisar',
    supersedesPending(nocheNueva, tardePendiente));
  assert('pero no a una siesta', !supersedesPending(nocheNueva, { ...tardePendiente, nap: true }));
  assert('ni a la noche de otro día',
    !supersedesPending(nocheNueva, auto('2026-09-24T23:00:00', '2026-09-25T07:00:00', { confidence: 'low' })));
  assert('ni la tarde a la noche', !supersedesPending(tardePendiente, nocheNueva));

  const withKnown = evaluateGaps([gap('2026-09-26T13:00:00', '2026-09-26T17:30:00')], MON, {
    known: [{ start: at('2026-09-25T23:00:00'), end: at('2026-09-26T07:00:00') }],
  });
  assert('con la noche ya registrada, un hueco de la tarde no entra', withKnown.results.length === 0);

  // Una siesta con indicios propios (el cargador la corrobora) sí se propone.
  const nap = evaluateGaps(
    [
      gap('2026-09-27T23:00:00', '2026-09-28T07:00:00'),
      gap('2026-09-28T14:00:00', '2026-09-28T18:30:00', { startTrigger: 'charger', endTrigger: 'charger' }),
      gap('2026-09-28T14:20:00', '2026-09-28T18:20:00'),
    ],
    { ...MON, triggers: { ...DEFAULT_TRIGGERS, charger: true } },
    { habit: { startMin: 23 * 60, endMin: 7 * 60, n: 6 } },
  );
  // Las 14:00 caen fuera del patrón de un hueco corto, pero este dura 4h30.
  const napSession = nap.results.find((r) => r.session.nap);
  assert('una siesta con el cargador como indicio se propone, marcada como siesta',
    nap.results.length === 2 && !!napSession && napSession.session.confidence !== 'high',
    nap.results.map((r) => `${clock(r.session.start)} nap=${r.session.nap}`));

  const fixed = evaluateGaps(
    [gap('2026-09-19T22:00:00', '2026-09-20T10:30:00')],
    { ...MON, maxGapMinutes: 12 * 60 },
  );
  assert('el techo es de 13h', MAX_PLAUSIBLE_SLEEP_MS === 13 * HOUR);
  assert('12h30 pasa por dudosa, no se descarta', fixed.results.length === 1 && fixed.results[0].session.confidence === 'low');
}

// --- Confianza combinada ----------------------------------------------------

console.log('\n--- Precisión: confianza por evidencias ---');
{
  const habit = { startMin: 23 * 60 + 30, endMin: 7 * 60 + 30, n: 8 };
  const ideal = evaluateGap(at('2026-09-18T23:30:00'), at('2026-09-19T07:30:00'), MON, ['screen', 'charger'], { habit })!;
  const earlyStart = evaluateGap(at('2026-09-18T20:30:00'), at('2026-09-19T07:30:00'), MON, ['screen'], { habit })!;
  const strange = evaluateGap(at('2026-09-18T21:40:00'), at('2026-09-19T12:00:00'), MON, ['screen'], { habit });
  assert('la noche de siempre con dos señales es de confianza alta', ideal.session.confidence === 'high', ideal.score);
  assert('empezar tres horas antes de tu hora de acostarte baja la puntuación',
    (earlyStart.score ?? 1) < (ideal.score ?? 0) && earlyStart.session.confidence !== 'high',
    [earlyStart.score, earlyStart.session.confidence]);
  assert('y un hueco suelto de 13h30 pasa del techo y no se propone', strange === null);

  const moved: SleepSession = { ...earlyStart.session };
  // Móvil plano y quieto toda la noche: ahora sí hay evidencia de quietud.
  const QUIET: GapEvidence = { ...NO_EVIDENCE, flat: 1, moves: 0, sensors: ['posture'] };
  const refined = refineEdges(moved, 15, { habit, evidence: QUIET });
  assert('con hábito aprendido y evidencia de quietud, un inicio muy anterior a tu hora se adelanta hasta ella',
    clock(refined.start) === '23:10', clock(refined.start));
  const unverified = refineEdges(moved, 15, { habit });
  assert('sin evidencia de quietud el hábito no mueve el inicio: queda en el último uso más la latencia',
    unverified.start === moved.start + 15 * MINUTE, clock(unverified.start));
  assert('y la sesión queda dudosa: confianza baja y marcada como inferida',
    unverified.confidence === 'low' && unverified.inferred === true, [unverified.confidence, unverified.inferred]);
  assert('un inicio sólo algo anterior a tu hora no se marca dudoso',
    refineEdges(ideal.session, 15, { habit }).inferred === undefined);
  // 21:40 + 15 min queda 95 min antes de las 23:30 (dudoso); con tu latencia
  // aprendida de 30 min, 80 (no). Detección y refinado deben decir lo mismo.
  const borderline = (latencyMinutes?: number) =>
    evaluateGap(at('2026-09-18T21:40:00'), at('2026-09-19T07:30:00'), MON, ['screen'], { habit, latencyMinutes })!;
  assert('con la latencia por defecto, 95 min antes de tu hora es dudoso', borderline().inferred === true);
  const withLatency = borderline(30);
  assert('con tu latencia aprendida ya no lo es, ni al detectar ni al refinar',
    !withLatency.inferred &&
      !refineEdges(withLatency.session, 15, { habit, learnedLatencyMinutes: 30 }).inferred,
    [withLatency.inferred, withLatency.session.confidence]);
  assert('la oscuridad sin pasos también cuenta como quietud',
    clock(refineEdges(moved, 15, { habit, evidence: { ...NO_EVIDENCE, dark: 0.95, moves: 0, sensors: ['light', 'steps'] } }).start) === '23:10');
  assert('pero con pasos en medio no hay quietud y el hábito no mueve nada',
    refineEdges(moved, 15, { habit, evidence: { ...QUIET, moves: 2 } }).start === moved.start + 15 * MINUTE);
  assert('sin hábito aprendido no se mueve más que la latencia',
    refineEdges(moved, 15, { habit: { ...habit, n: 2 } }).start === moved.start + 15 * MINUTE);
  assert('un inicio ya cercano a tu hora sólo suma la latencia',
    refineEdges(ideal.session, 15, { habit }).start === ideal.session.start + 15 * MINUTE);
  assert('la latencia personal sustituye a la de ajustes',
    refineEdges(ideal.session, 15, { learnedLatencyMinutes: 25 }).start === ideal.session.start + 25 * MINUTE);
  // Quien varía mucho de hora no se lleva hasta su media: el margen es lo que
  // suele variar (aquí 50 min), y una noche en que se acostó pronto de verdad
  // queda más cerca de lo medido.
  assert('con un hábito muy variable, el inicio se adelanta menos',
    clock(refineEdges(moved, 15, { habit: { ...habit, spreadMin: 50 }, evidence: QUIET }).start) === '22:40',
    clock(refineEdges(moved, 15, { habit: { ...habit, spreadMin: 50 }, evidence: QUIET }).start));
  assert('y el margen nunca pasa de una hora',
    clock(refineEdges(moved, 15, { habit: { ...habit, spreadMin: 300 }, evidence: QUIET }).start) === '22:30');
  assert('la dispersión circular de 23:40 y 00:20 es de unos 20 min',
    Math.abs(circularSpread([23 * 60 + 40, 20]) - 20) < 1, circularSpread([23 * 60 + 40, 20]));
  assert('el hábito no acerca el inicio si deja una noche de menos de 3h',
    refineEdges({ ...moved, end: moved.start + 4 * HOUR }, 15, { habit, evidence: QUIET }).start === moved.start + 15 * MINUTE);
}

// --- Micro-despertares ------------------------------------------------------

console.log('\n--- Precisión: micro-despertares ---');
{
  const habit = { startMin: 0, endMin: 8 * 60, n: 8 };
  // Soltó el móvil a las 21:30, miró la hora a las 00:20 y ya no lo cogió más.
  const trimmed = evaluateGaps(
    [gap('2026-09-21T21:30:00', '2026-09-22T09:00:00', { wakes: [at('2026-09-22T00:20:00')] })],
    MON,
    { habit },
  );
  assert('la última mirada al móvil junto a tu hora de acostarte es el inicio',
    trimmed.results.length === 1 && clock(trimmed.results[0].session.start) === '00:20',
    trimmed.results.map((r) => clock(r.session.start)));
  assert('conservando el inicio medido para aprender de él',
    trimmed.results[0]?.session.detectedStart === at('2026-09-21T21:30:00'));

  const bathroom = evaluateGaps(
    [gap('2026-09-21T23:50:00', '2026-09-22T08:00:00', { wakes: [at('2026-09-22T03:10:00')] })],
    MON,
    { habit },
  );
  assert('un micro-despertar de madrugada no parte una noche que ya empieza a su hora',
    bathroom.results.length === 1 && clock(bathroom.results[0].session.start) === '23:50');

  // Se levantó a las 7:00, miró la hora, y no cogió el móvil de verdad hasta las 7:50.
  const woke = evaluateGaps(
    [gap('2026-09-21T23:30:00', '2026-09-22T07:50:00', { wakes: [at('2026-09-22T03:05:00'), at('2026-09-22T07:02:00')] })],
    MON,
    { habit },
  );
  assert('un desbloqueo breve justo antes del uso sostenido es el despertar',
    woke.results.length === 1 && clock(woke.results[0].session.end) === '07:02',
    woke.results.map((r) => clock(r.session.end)));

  const afternoonThenNight = evaluateGaps(
    [gap('2026-09-21T17:00:00', '2026-09-22T09:00:00', { wakes: [at('2026-09-21T23:55:00')] })],
    MON,
    { habit },
  );
  assert('un hueco de 16h se parte por el micro-despertar que deja una noche creíble',
    afternoonThenNight.results.length === 1 && clock(afternoonThenNight.results[0].session.start) === '23:55',
    afternoonThenNight.results.map((r) => formatDuration(r.gapMs)));
  const inferred = evaluateGaps([gap('2026-09-21T17:00:00', '2026-09-22T09:00:00')], MON, { habit });
  assert('y sin micro-despertares la noche empieza a tu hora de acostarte, dudosa: confianza baja e inferida',
    inferred.results.length === 1 &&
      clock(inferred.results[0].session.start) === '23:40' &&
      inferred.results[0].session.confidence === 'low' &&
      inferred.results[0].session.inferred === true &&
      inferred.results[0].inferred === true,
    inferred.results.map((r) => `${clock(r.session.start)} ${r.session.confidence}`));
  // Que el cargador coincida no convierte en medido un inicio deducido.
  const inferredPlusCharger = evaluateGaps(
    [
      gap('2026-09-21T17:00:00', '2026-09-22T09:00:00'),
      gap('2026-09-21T23:50:00', '2026-09-22T08:50:00', { startTrigger: 'charger', endTrigger: 'charger' }),
    ],
    { ...MON, triggers: { ...DEFAULT_TRIGGERS, charger: true } },
    { habit },
  );
  assert('un inicio deducido sigue en confianza baja aunque otra señal coincida',
    inferredPlusCharger.results.length === 1 && inferredPlusCharger.results[0].session.confidence === 'low',
    inferredPlusCharger.results.map((r) => `${clock(r.session.start)} ${r.session.confidence}`));
  assert('pero si tu hora de acostarte no cae dentro del hueco no hay noche que deducir',
    evaluateGaps([gap('2026-09-21T06:00:00', '2026-09-21T21:30:00')], MON, { habit }).rejected[0]?.reason === 'too-long');
}

// --- Sensores ---------------------------------------------------------------

console.log('\n--- Precisión: sensores ---');
{
  const on = (...ids: Array<keyof typeof DEFAULT_SENSORS>) => ({
    ...MON,
    sensors: { ...DEFAULT_SENSORS, ...Object.fromEntries(ids.map((i) => [i, true])) },
  });
  const habit = { startMin: 0, endMin: 8 * 60, n: 8 };
  const ev = (iso: string, kind: RawEvent['kind'], v?: number): RawEvent => ({ at: at(iso), kind, v });

  // Luz encendida hasta las 00:15, pasos por casa hasta las 00:20; el móvil
  // llevaba apagado desde las 22:10.
  const night: RawEvent[] = [
    ev('2026-09-21T22:10:00', 'light', LIGHT_BRIGHT),
    ev('2026-09-21T23:00:00', 'steps', 30),
    ev('2026-09-21T23:20:00', 'steps', 40),
    ev('2026-09-21T23:40:00', 'steps', 25),
    ev('2026-09-22T00:15:00', 'light', LIGHT_DARK),
    // Un paseo corto al baño a las 03:00: no rompe la noche.
    ev('2026-09-22T03:00:00', 'steps', 18),
    ev('2026-09-22T03:01:00', 'steps', 12),
    // Despierta de verdad a las 07:35 (pasos seguidos) y coge el móvil a las 09:10.
    ev('2026-09-22T07:35:00', 'steps', 40),
    ev('2026-09-22T07:40:00', 'steps', 60),
    ev('2026-09-22T07:50:00', 'steps', 80),
  ];
  const sensors = ['steps', 'light'] as const;
  const evid = gatherEvidence(night, at('2026-09-21T22:10:00'), at('2026-09-22T09:10:00'), [...sensors]);
  assert('la última actividad real es lo que va antes de la quietud, no el último uso del móvil',
    evid.activityAt !== null && clock(evid.activityAt) === '00:15', evid.activityAt && clock(evid.activityAt));
  assert('el primer despertar sostenido se detecta',
    evid.wakeAt !== null && clock(evid.wakeAt) === '07:35', evid.wakeAt && clock(evid.wakeAt));
  assert('ir al baño no cuenta como levantarse', evid.moves === 0, evid.moves);
  assert('y la noche estuvo a oscuras', (evid.dark ?? 0) > 0.95, evid.dark);

  const r = evaluateGaps([gap('2026-09-21T22:10:00', '2026-09-22T09:10:00')], on('steps', 'light'), { habit, events: night });
  assert('con sensores el inicio es la última actividad y el final el primer despertar',
    r.results.length === 1 &&
      clock(r.results[0].session.start) === '00:15' &&
      clock(r.results[0].session.end) === '07:35',
    r.results.map((x) => `${clock(x.session.start)}→${clock(x.session.end)}`));
  // Con el cargador también activo, la fusión conserva los bordes de los sensores
  // y avisa de que el inicio lo fijó un sensor (el hábito no debe pisarlo).
  const both = evaluateGaps(
    [
      gap('2026-09-21T22:10:00', '2026-09-22T09:10:00'),
      gap('2026-09-21T21:50:00', '2026-09-22T09:30:00', { startTrigger: 'charger', endTrigger: 'charger' }),
    ],
    { ...on('steps', 'light'), triggers: { ...DEFAULT_TRIGGERS, charger: true } },
    { habit, events: night },
  );
  assert('la fusión de dos disparadores conserva los bordes de los sensores',
    both.results.length === 1 &&
      clock(both.results[0].session.start) === '00:15' &&
      both.results[0].evidence?.activityAt != null,
    both.results.map((x) => `${clock(x.session.start)} ${x.evidence?.activityAt}`));
  const plain = evaluateGaps([gap('2026-09-21T22:10:00', '2026-09-22T09:10:00')], MON, { habit, events: night });
  assert('con los sensores apagados la misma noche conserva los bordes del móvil',
    plain.results.length === 1 && clock(plain.results[0].session.start) === '22:10');
  assert('sin sensores activos no se consulta el registro', activeSensors(MON).length === 0);
  assert('con sensores y quietud total la confianza no baja respecto a sin ellos',
    (r.results[0].score ?? 0) >= (plain.results[0].score ?? 1) - 0.0001, [r.results[0].score, plain.results[0].score]);

  // Audio sonando hasta las 00:40 con la pantalla apagada: aún despierto.
  const audio: RawEvent[] = [
    ev('2026-09-21T22:30:00', 'audio', 1),
    ev('2026-09-21T22:45:00', 'audio', 1),
    ev('2026-09-21T23:00:00', 'audio', 1),
    ev('2026-09-21T23:15:00', 'audio', 1),
    ev('2026-09-21T23:30:00', 'audio', 1),
    ev('2026-09-21T23:45:00', 'audio', 1),
    ev('2026-09-22T00:00:00', 'audio', 1),
    ev('2026-09-22T00:15:00', 'audio', 1),
    ev('2026-09-22T00:30:00', 'audio', 1),
    ev('2026-09-22T00:45:00', 'audio', 0),
  ];
  const ea = gatherEvidence(audio, at('2026-09-21T22:30:00'), at('2026-09-22T08:30:00'), ['audio']);
  assert('el audio sonando retrasa el inicio hasta que se para',
    ea.activityAt !== null && clock(ea.activityAt) >= '00:30' && clock(ea.activityAt) <= '00:45',
    ea.activityAt && clock(ea.activityAt));

  // La alarma de las 07:00 sonó (pantalla encendida) y el móvil no se desbloqueó hasta las 10:40.
  const alarm: RawEvent[] = [
    ev('2026-09-21T23:55:00', 'alarm', at('2026-09-22T07:00:00')),
    ev('2026-09-22T07:00:02', 'screen-on'),
  ];
  const al = gatherEvidence(alarm, at('2026-09-21T23:50:00'), at('2026-09-22T10:40:00'), ['alarm']);
  assert('una alarma que sonó con la pantalla encendida marca el despertar',
    al.alarmAt === at('2026-09-22T07:00:00') && al.wakeAt === al.alarmAt, al);
  const alOk = gatherEvidence(alarm, at('2026-09-21T23:50:00'), at('2026-09-22T07:20:00'), ['alarm']);
  assert('y una alarma junto al final corrobora la noche', alOk.alarmMatch === true);
  const noAlarm = gatherEvidence([ev('2026-09-21T12:00:00', 'alarm', 0)], at('2026-09-21T23:50:00'), at('2026-09-22T07:20:00'), ['alarm']);
  assert('sin alarma programada no hay indicio (ni a favor)', noAlarm.alarmMatch === false && noAlarm.alarmAt === null);

  // Una siesta a oscuras y quieta, sin cargador, con sensores: tiene indicios propios.
  const darkNap: RawEvent[] = [ev('2026-09-23T13:30:00', 'light', LIGHT_DARK), ev('2026-09-23T13:40:00', 'proximity', 1)];
  const two = evaluateGaps(
    [gap('2026-09-22T23:30:00', '2026-09-23T07:30:00'), gap('2026-09-23T14:00:00', '2026-09-23T18:40:00')],
    on('light', 'proximity'),
    { habit, events: darkNap },
  );
  assert('una siesta a oscuras y quieta se acepta como siesta',
    two.results.length === 2 && !!two.results[1].session.nap,
    two.results.map((x) => `${clock(x.session.start)} ${x.session.nap}`));
}

// --- Postura del móvil ------------------------------------------------------

console.log('\n--- Precisión: postura del móvil ---');
{
  const on = (...ids: Array<keyof typeof DEFAULT_SENSORS>) => ({
    ...MON,
    sensors: { ...DEFAULT_SENSORS, ...Object.fromEntries(ids.map((i) => [i, true])) },
  });
  const habit = { startMin: 0, endMin: 8 * 60, n: 8 };
  /** Una lectura cada 10 min entre dos instantes, todas con la misma postura. */
  const readings = (from: string, to: string, v: number): RawEvent[] => {
    const out: RawEvent[] = [];
    for (let t = at(from); t <= at(to); t += 10 * MINUTE) out.push({ at: t, kind: 'posture', v });
    return out;
  };

  // En el bolsillo o la mano hasta las 23:50; luego plano toda la noche.
  const night: RawEvent[] = [
    ...readings('2026-09-21T22:10:00', '2026-09-21T23:50:00', POSTURE_CARRIED),
    ...readings('2026-09-22T00:00:00', '2026-09-22T08:50:00', POSTURE_FLAT_UP),
  ];
  const from = at('2026-09-21T22:10:00');
  const to = at('2026-09-22T09:10:00');
  const ev = gatherEvidence(night, from, to, ['posture']);
  assert('el inicio se fija en el último momento con el móvil en el bolsillo o la mano',
    ev.activityAt !== null && clock(ev.activityAt) === '23:55', ev.activityAt && clock(ev.activityAt));
  assert('plano toda la noche: el 100 % de las lecturas', ev.flat === 1, ev.flat);
  assert('y sin episodios de movimiento dentro de la noche', ev.moves === 0, ev.moves);
  assert('el sensor consta como usado', ev.sensors.length === 1 && ev.sensors[0] === 'posture');
  assert('plano y quieto es evidencia de quietud', quietEvidence(ev));

  const flatDown = gatherEvidence(readings('2026-09-22T00:00:00', '2026-09-22T08:50:00', POSTURE_FLAT_DOWN), from, to, ['posture']);
  assert('boca abajo también es plano y quieto', flatDown.flat === 1 && quietEvidence(flatDown), flatDown.flat);
  const tilted = gatherEvidence(readings('2026-09-22T00:00:00', '2026-09-22T08:50:00', POSTURE_TILTED), from, to, ['posture']);
  assert('inclinado y quieto (un soporte) no es evidencia ni a favor ni en contra',
    tilted.flat === 0 && !quietEvidence(tilted) && tilted.moves === 0, [tilted.flat, tilted.moves]);

  // Una sola lectura de movimiento a las 03:00 (ir al baño, un golpe en la mesa)
  // no parte la noche; dos seguidas a las 06:30 sí son levantarse.
  const bathroom = [
    ...night,
    { at: at('2026-09-22T03:00:00'), kind: 'posture', v: POSTURE_CARRIED } as RawEvent,
  ];
  const evBath = gatherEvidence(bathroom, from, to, ['posture']);
  assert('una lectura suelta en el bolsillo de madrugada no rompe la noche',
    evBath.moves === 0 && evBath.wakeAt === null && quietEvidence(evBath), [evBath.moves, evBath.wakeAt]);
  const upEarly = [
    ...night,
    { at: at('2026-09-22T06:30:00'), kind: 'posture', v: POSTURE_CARRIED } as RawEvent,
    { at: at('2026-09-22T06:40:00'), kind: 'posture', v: POSTURE_CARRIED } as RawEvent,
  ];
  const evUp = gatherEvidence(upEarly, from, to, ['posture']);
  assert('dos lecturas seguidas en el bolsillo o la mano son un despertar',
    evUp.wakeAt !== null && clock(evUp.wakeAt) === '06:30', evUp.wakeAt && clock(evUp.wakeAt));
  assert('y la noche termina ahí: lo anterior fue quieto', evUp.moves === 0 && quietEvidence(evUp), [evUp.moves, evUp.flat]);

  // Con el sensor apagado en ajustes, las lecturas del registro se ignoran.
  const off = gatherEvidence(night, from, to, ['steps']);
  assert('con el sensor apagado las lecturas no cuentan', off.flat === null && off.activityAt === null && off.sensors.length === 0);
  // Degradación: activo pero sin lecturas (móvil sin acelerómetro, servicio sin datos).
  const none = gatherEvidence([{ at: at('2026-09-22T01:00:00'), kind: 'screen-off' }], from, to, ['posture']);
  assert('activo pero sin lecturas no hay indicio, ni a favor ni en contra', none.flat === null && !quietEvidence(none));

  // En la tubería: la postura fija el inicio y sube la confianza.
  const withPosture = evaluateGaps([gap('2026-09-21T22:10:00', '2026-09-22T09:10:00')], on('posture'), { habit, events: night });
  const without = evaluateGaps([gap('2026-09-21T22:10:00', '2026-09-22T09:10:00')], MON, { habit, events: night });
  assert('con el sensor activo el inicio es la última lectura en el bolsillo o la mano',
    withPosture.results.length === 1 && clock(withPosture.results[0].session.start) === '23:55',
    withPosture.results.map((r) => clock(r.session.start)));
  assert('con el sensor apagado se queda el último uso del móvil',
    without.results.length === 1 && clock(without.results[0].session.start) === '22:10');
  assert('plano y quieto sube la puntuación respecto a la misma noche sin él',
    (withPosture.results[0].score ?? 0) > (without.results[0].score ?? 1),
    [withPosture.results[0].score, without.results[0].score]);
  // Un rato con el móvil en la mano a las 02:00 es seguir despierto: el inicio
  // se fija al final de ese rato, no en el primer paseo con él de la noche.
  const restless = evaluateGaps(
    [gap('2026-09-21T22:10:00', '2026-09-22T09:10:00')],
    on('posture'),
    {
      habit,
      events: [
        ...readings('2026-09-21T22:10:00', '2026-09-21T23:50:00', POSTURE_CARRIED),
        ...readings('2026-09-22T00:00:00', '2026-09-22T01:30:00', POSTURE_FLAT_UP),
        ...readings('2026-09-22T01:40:00', '2026-09-22T02:10:00', POSTURE_CARRIED),
        ...readings('2026-09-22T02:20:00', '2026-09-22T08:50:00', POSTURE_FLAT_UP),
      ],
    },
  );
  assert('un rato con el móvil en la mano a las 02:00 mueve el inicio a cuando lo soltó',
    restless.results.length === 1 && clock(restless.results[0].session.start) === '02:15',
    restless.results.map((r) => clock(r.session.start)));
}

// --- No deducir el sueño por la hora ---------------------------------------

console.log('\n--- Precisión: el reloj no inventa sueño ---');
{
  const on = (...ids: Array<keyof typeof DEFAULT_SENSORS>) => ({
    ...MON,
    sensors: { ...DEFAULT_SENSORS, ...Object.fromEntries(ids.map((i) => [i, true])) },
  });
  const habit = { startMin: 0, endMin: 8 * 60, n: 8 };
  const readings = (from: string, to: string, v: number): RawEvent[] => {
    const out: RawEvent[] = [];
    for (let t = at(from); t <= at(to); t += 10 * MINUTE) out.push({ at: t, kind: 'posture', v });
    return out;
  };

  // Un hueco largo sin nada con que partirlo: la noche a la hora habitual es
  // sólo un marcador, y lo dice.
  const longGap = gap('2026-09-21T17:00:00', '2026-09-22T09:00:00');
  const bare = evaluateGaps([longGap], MON, { habit });
  const r0 = bare.results[0];
  assert('sin evidencia, el inicio por hábito sale inferido y de confianza baja',
    bare.results.length === 1 && r0.inferred === true && r0.session.inferred === true && r0.session.confidence === 'low');
  assert('y nunca antes del último uso real del móvil', r0.session.start >= longGap.start);

  // Con un hábito firme (muchas noches, poca variación) y una noche que encaja
  // con él en duración y en la hora de levantarse, la noche inferida es una
  // estimación razonable: media, nunca alta, y sigue marcada como inferida.
  const firmHabit = { ...habit, spreadMin: 30 };
  const fitting = gap('2026-09-21T17:00:00', '2026-09-22T08:30:00');
  const firmFit = evaluateGaps([fitting], MON, { habit: firmHabit }).results[0];
  assert('con un hábito firme y una noche que encaja, la inferida sube a confianza media',
    !!firmFit && firmFit.inferred === true && firmFit.session.inferred === true && firmFit.session.confidence === 'medium',
    firmFit && [clock(firmFit.session.start), firmFit.session.confidence]);
  const loose = evaluateGaps([fitting], MON, { habit: { ...habit, spreadMin: 90 } }).results[0];
  assert('con un hábito que varía mucho se queda en baja', loose?.session.confidence === 'low', loose?.session.confidence);
  const lateWake = evaluateGaps([gap('2026-09-21T17:00:00', '2026-09-22T11:20:00')], MON, { habit: firmHabit }).results[0];
  assert('y si la mañana no encaja con tu hora de levantarte, también',
    !lateWake || lateWake.session.confidence === 'low', lateWake?.session.confidence);
  const earlyFirm = evaluateGaps([gap('2026-09-21T21:40:00', '2026-09-22T08:00:00')], MON, { habit: firmHabit }).results[0];
  assert('un inicio medido muy anterior a tu hora no sube aunque el hábito sea firme',
    earlyFirm?.inferred === true && earlyFirm.session.confidence === 'low', earlyFirm?.session.confidence);
  assert('ni la refinada de una inferida media pasa a alta',
    refineEdges(firmFit.session, 15, { habit: firmHabit }).confidence === 'medium');

  // Con el móvil plano toda la noche desde la hora habitual, la quietud sostiene la hora.
  const flatNight = readings('2026-09-21T23:40:00', '2026-09-22T08:50:00', POSTURE_FLAT_UP);
  const backed = evaluateGaps([longGap], on('posture'), { habit, events: flatNight });
  assert('con el móvil plano y quieto, la hora habitual deja de ser una deducción',
    backed.results.length === 1 && !backed.results[0].inferred && !backed.results[0].session.inferred &&
      clock(backed.results[0].session.start) === '23:40',
    backed.results.map((r) => `${clock(r.session.start)} ${r.inferred}`));
  assert('y la confianza ya no está limitada a baja', backed.results[0].session.confidence !== 'low',
    backed.results[0].session.confidence);

  // Si los sensores vieron la última actividad, ese es el inicio medido y el reloj sobra.
  const walked: RawEvent[] = [
    ...readings('2026-09-21T17:00:00', '2026-09-21T22:30:00', POSTURE_CARRIED),
    ...readings('2026-09-21T22:40:00', '2026-09-22T08:50:00', POSTURE_FLAT_UP),
  ];
  const measured = evaluateGaps([longGap], on('posture'), { habit, events: walked });
  assert('la última actividad vista por el sensor manda sobre la hora habitual',
    measured.results.length === 1 && clock(measured.results[0].session.start) === '22:35' && !measured.results[0].inferred,
    measured.results.map((r) => `${clock(r.session.start)} ${r.inferred}`));

  // Un inicio muy anterior a tu hora, sin evidencia: dudoso, no corregido por reloj.
  const early = evaluateGaps([gap('2026-09-21T21:40:00', '2026-09-22T08:30:00')], MON, { habit });
  assert('un último uso del móvil muy anterior a tu hora, sin evidencia, se propone dudoso',
    early.results.length === 1 && early.results[0].inferred === true && early.results[0].session.confidence === 'low' &&
      clock(early.results[0].session.start) === '21:40',
    early.results.map((r) => `${clock(r.session.start)} ${r.session.confidence}`));
  const earlyQuiet = evaluateGaps(
    [gap('2026-09-21T21:40:00', '2026-09-22T08:30:00')],
    on('posture'),
    { habit, events: readings('2026-09-21T21:50:00', '2026-09-22T08:20:00', POSTURE_FLAT_UP) },
  );
  assert('con el móvil plano y quieto desde entonces no hay nada dudoso: se durmió pronto',
    earlyQuiet.results.length === 1 && !earlyQuiet.results[0].inferred, earlyQuiet.results.map((r) => r.inferred));

  // El inicio de una sesión nunca retrocede, con o sin hábito, con o sin evidencia.
  const base: SleepSession = {
    id: 'auto-x', start: at('2026-09-21T20:30:00'), end: at('2026-09-22T07:30:00'),
    source: 'auto', confidence: 'medium', confirmed: false,
  };
  const never = [undefined, habit, { ...habit, spreadMin: 90 }].every((h) =>
    [null, { ...NO_EVIDENCE, flat: 1, moves: 0 } as GapEvidence].every(
      (e) => refineEdges(base, 15, { habit: h, evidence: e }).start >= base.start,
    ));
  assert('refineEdges nunca adelanta el inicio antes del último uso del móvil', never);

  // Dos propuestas de la misma noche: la deducida no desplaza a la medida.
  const firm = { start: at('2026-09-21T23:50:00'), end: at('2026-09-22T07:30:00'), rank: 0.8 };
  const against = evaluateGaps([longGap], MON, { habit, known: [firm] });
  assert('una noche deducida no tapa a una medida que ya espera en la cola',
    against.results.length === 0 && against.rejected[0]?.reason === 'secondary', against.rejected.map((r) => r.reason));
  const incomingLow = evaluateGaps(
    [gap('2026-09-21T23:00:00', '2026-09-22T07:30:00')],
    MON,
    { habit, known: [{ start: r0.session.start, end: r0.session.end, rank: 0.3 + 8 / 40 - 0.5 }] },
  );
  assert('y cualquier noche medida desplaza a la deducida que esperaba', incomingLow.results.length === 1);
  const pendingInferred: SleepSession = { ...r0.session, id: 'pending' };
  const incomingSolid: SleepSession = {
    id: 'auto-new', start: at('2026-09-21T23:10:00'), end: at('2026-09-22T07:00:00'),
    source: 'auto', confidence: 'low', confirmed: false,
  };
  assert('una propuesta medida, aunque sea baja, sustituye a la inferida de su noche en la cola',
    supersedesPending(incomingSolid, pendingInferred));
  assert('pero una inferida no sustituye a otra medida de confianza baja',
    !supersedesPending(pendingInferred, incomingSolid));

  // El disparador de horario sigue siendo el último recurso: baja e inferida.
  const sched = proposeFromSchedule(
    flat,
    { ...MON, triggers: { ...DEFAULT_TRIGGERS, schedule: true } },
    [],
    null,
    at('2026-09-22T12:00:00'),
  );
  assert('la propuesta del horario es de confianza baja y se marca inferida',
    !!sched && sched.result.session.confidence === 'low' && sched.result.session.inferred === true && sched.result.inferred === true);
}

// --- Uso sostenido del móvil dentro de un hueco -----------------------------

console.log('\n--- Precisión: el uso sostenido corta el hueco ---');
{
  const habit = { startMin: 0, endMin: 8 * 60, n: 8 };
  const e = (iso: string, kind: RawEvent['kind']): RawEvent => ({ at: at(iso), kind });
  const from = at('2026-09-21T21:00:00');
  const to = at('2026-09-22T07:30:00');

  const long: RawEvent[] = [e('2026-09-21T21:30:00', 'screen-on'), e('2026-09-21T21:30:02', 'unlock'), e('2026-09-21T22:10:00', 'screen-off')];
  const used = lastSustainedUse(long, from, to);
  assert('40 minutos de pantalla son un uso sostenido que termina al apagarse', used !== null && clock(used) === '22:10', used && clock(used));
  assert('un vistazo de dos minutos no lo es',
    lastSustainedUse([e('2026-09-22T03:00:00', 'screen-on'), e('2026-09-22T03:02:00', 'screen-off')], from, to) === null);
  assert('varios vistazos seguidos suman uso: 6 minutos en total sí lo son',
    lastSustainedUse([
      e('2026-09-22T03:00:00', 'screen-on'), e('2026-09-22T03:00:03', 'unlock'), e('2026-09-22T03:03:00', 'screen-off'),
      e('2026-09-22T03:10:00', 'screen-on'), e('2026-09-22T03:10:03', 'unlock'), e('2026-09-22T03:13:00', 'screen-off'),
    ], from, to) === at('2026-09-22T03:13:00'));
  // Un chat ruidoso: cuarenta notificaciones que encienden la pantalla ocho
  // segundos, cada quince minutos, sin que nadie desbloquee. No es uso.
  const chatty: RawEvent[] = [];
  for (let t = at('2026-09-21T23:00:00'), i = 0; i < 40; i++, t += 15 * MINUTE) {
    chatty.push({ at: t, kind: 'screen-on' }, { at: t + 8_000, kind: 'screen-off' });
  }
  assert('las pantallas que enciende una notificación, sin desbloquear, no suman uso',
    lastSustainedUse(chatty, from, at('2026-09-22T09:30:00')) === null);
  const chattyNight = evaluateGaps(
    [gap('2026-09-21T23:00:00', '2026-09-22T07:30:00', { startTrigger: 'charger', endTrigger: 'charger' })],
    { ...MON, triggers: { ...DEFAULT_TRIGGERS, charger: true } },
    { habit, events: chatty },
  );
  assert('y la noche del cargador con un chat ruidoso no se pierde',
    chattyNight.results.length === 1 && clock(chattyNight.results[0].session.start) === '23:00',
    chattyNight.results.map((r) => clock(r.session.start)));
  assert('tres desbloqueos en un rato son sostenido aunque sean de segundos',
    lastSustainedUse([
      e('2026-09-22T03:00:00', 'screen-on'), e('2026-09-22T03:00:01', 'unlock'), e('2026-09-22T03:00:20', 'screen-off'),
      e('2026-09-22T03:05:00', 'screen-on'), e('2026-09-22T03:05:01', 'unlock'), e('2026-09-22T03:05:20', 'screen-off'),
      e('2026-09-22T03:10:00', 'screen-on'), e('2026-09-22T03:10:01', 'unlock'), e('2026-09-22T03:10:20', 'screen-off'),
    ], from, to) === at('2026-09-22T03:10:20'));
  assert('el último de varios usos sostenidos manda',
    lastSustainedUse([...long, e('2026-09-21T23:00:00', 'screen-on'), e('2026-09-21T23:00:04', 'unlock'), e('2026-09-21T23:20:00', 'screen-off')], from, to) === at('2026-09-21T23:20:00'));

  // Un hueco del cargador abarca un rato de móvil en la mano: la noche empieza después.
  const charger = { ...MON, triggers: { ...DEFAULT_TRIGGERS, charger: true } };
  const cg = gap('2026-09-21T21:00:00', '2026-09-22T07:30:00', { startTrigger: 'charger', endTrigger: 'charger' });
  const cut = evaluateGaps([cg], charger, { habit, events: long });
  assert('el inicio de un hueco del cargador no va antes del último uso sostenido del móvil',
    cut.results.length === 1 && clock(cut.results[0].session.start) === '22:10',
    cut.results.map((r) => clock(r.session.start)));
  const glance = evaluateGaps([cg], charger, {
    habit, events: [e('2026-09-21T22:00:00', 'screen-on'), e('2026-09-21T22:01:00', 'screen-off')],
  });
  assert('un vistazo breve no mueve el inicio', glance.results.length === 1 && clock(glance.results[0].session.start) === '21:00');
  // Si lo que queda tras el uso ya no es una noche, todo el hueco se descarta como sueño.
  const tail = evaluateGaps([gap('2026-09-21T19:00:00', '2026-09-22T00:30:00', { startTrigger: 'charger', endTrigger: 'charger' })], charger, {
    habit,
    events: [e('2026-09-21T19:10:00', 'screen-on'), e('2026-09-21T19:10:02', 'unlock'), e('2026-09-21T22:30:00', 'screen-off')],
  });
  assert('y si tras el uso no queda una noche, el hueco entero deja de ser sueño',
    tail.results.length === 0 && tail.rejected.length === 1, tail.rejected.map((r) => r.reason));

  // Tarde sin tocar el móvil + 12 min de uso + noche: dos ciclos, cada uno con su inicio.
  const afternoon = gap('2026-09-21T14:30:00', '2026-09-21T22:30:00');
  const nightGap = gap('2026-09-21T22:42:00', '2026-09-22T07:00:00');
  const two = evaluateGaps([afternoon, nightGap], MON, { habit });
  const night = two.results.find((r) => r.session.end === nightGap.end);
  assert('tras un uso sostenido la noche abre un ciclo nuevo con su propio inicio, sin pegarse a la tarde',
    !!night && night.session.detectedStart === nightGap.start && night.session.start >= nightGap.start &&
      !night.inferred && night.session.end - night.session.start < 9 * HOUR,
    two.results.map((r) => `${clock(r.session.start)}→${clock(r.session.end)} ${r.inferred}`));
  assert('la tarde no se funde con la noche ni la bloquea',
    two.results.every((r) => r.session.start >= afternoon.start) && two.results.length >= 1);
}

// --- Exportación del registro bruto -----------------------------------------

console.log('\n--- Precisión: exportación del registro bruto ---');
{
  const events: RawEvent[] = [
    { at: at('2026-09-22T07:35:10'), kind: 'steps', v: 40 },
    { at: at('2026-09-21T23:00:00'), kind: 'screen-off' },
  ];
  const csv = rawEventsToCsv(events).replace('\ufeff', '').split('\r\n');
  assert('el CSV lleva cabecera y una fila por evento, ordenadas por hora',
    csv[0] === 'fecha,hora,instante_ms,tipo,valor' && csv[1].includes('screen-off') && csv[2].includes('steps,40'),
    csv);
  assert('la hora local lleva segundos', csv[2].startsWith('2026-09-22,07:35:10,'), csv[2]);
  const json = JSON.parse(rawEventsToJson(events)) as RawEvent[];
  assert('el JSON conserva los eventos tal cual y ordenados',
    json.length === 2 && json[0].kind === 'screen-off' && json[1].v === 40);
}

console.log(failures ? `\n${failures} comprobación(es) fallidas` : '\nTodo correcto');
process.exit(failures ? 1 : 0);
