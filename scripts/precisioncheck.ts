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
  refineEdges,
} from '../src/lib/activityMonitor';
import type { NativeGap } from '../src/lib/backgroundMonitor';
import { learnHabit, learnLatency, circularMean, circularSpread, minuteDiff } from '../src/lib/habit';
import { parseNote } from '../src/lib/noteTimes';
import { LIGHT_BRIGHT, LIGHT_DARK, gatherEvidence, type RawEvent } from '../src/lib/rawEvents';
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
  const refined = refineEdges(moved, 15, { habit });
  assert('con hábito aprendido, un inicio muy anterior a tu hora se adelanta hasta ella',
    clock(refined.start) === '23:10', clock(refined.start));
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
    clock(refineEdges(moved, 15, { habit: { ...habit, spreadMin: 50 } }).start) === '22:40',
    clock(refineEdges(moved, 15, { habit: { ...habit, spreadMin: 50 } }).start));
  assert('y el margen nunca pasa de una hora',
    clock(refineEdges(moved, 15, { habit: { ...habit, spreadMin: 300 } }).start) === '22:30');
  assert('la dispersión circular de 23:40 y 00:20 es de unos 20 min',
    Math.abs(circularSpread([23 * 60 + 40, 20]) - 20) < 1, circularSpread([23 * 60 + 40, 20]));
  assert('el hábito no acerca el inicio si deja una noche de menos de 3h',
    refineEdges({ ...moved, end: moved.start + 4 * HOUR }, 15, { habit }).start === moved.start + 15 * MINUTE);
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
  assert('y sin micro-despertares la noche empieza a tu hora de acostarte, con confianza baja',
    inferred.results.length === 1 &&
      clock(inferred.results[0].session.start) === '23:40' &&
      inferred.results[0].session.confidence === 'low',
    inferred.results.map((r) => `${clock(r.session.start)} ${r.session.confidence}`));
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
