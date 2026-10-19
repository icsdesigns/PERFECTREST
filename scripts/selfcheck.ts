import { bedtimesForWake, bestOption, wakeTimesForBedtime } from '../src/lib/cycles';
import { applyGoal, normalizeForMode, upcomingNight, DEFAULT_GOALS } from '../src/lib/schedule';
import { buildNights, summarize } from '../src/lib/stats';
import { circularMeanMinutes, formatDuration, formatTime, inWindow } from '../src/lib/time';
import {
  evaluateGap,
  mergeDetections,
  proposeFromSchedule,
  refineEdges,
  type DetectionResult,
} from '../src/lib/activityMonitor';
import {
  DEFAULT_TRIGGERS,
  TRIGGERS,
  TRIGGER_BY_ID,
  describeTriggers,
  triggerEnabled,
} from '../src/lib/triggers';
import {
  appendEvents,
  describeEvent,
  discardReason,
  eventTone,
  summarizeLog,
} from '../src/lib/triggerLog';
import { parseTag, readRelease } from '../src/lib/updater';
import type {
  MonitorSettings,
  ScheduleSettings,
  SleepSession,
  TriggerEvent,
  TriggerEventKind,
  TriggerId,
} from '../src/lib/types';

let failures = 0;
function assert(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

console.log('\n--- Módulo 2: ciclos ---');
const wake = new Date('2026-08-19T07:00:00');
const cyc = { cycleMinutes: 90, latencyMinutes: 15 };
const opts = bedtimesForWake(wake, cyc, 8);
const five = opts.find((o) => o.cycles === 5)!;
assert('5 ciclos = 7h30 de sueño', five.sleepMs === 7.5 * 3600000, five.sleepMs);
assert('bedtime 5 ciclos = 23:15', five.bedtime.getHours() === 23 && five.bedtime.getMinutes() === 15,
  five.bedtime.toString());
assert('recomendado para meta 8h son 5 ciclos', bestOption(opts).cycles === 5, bestOption(opts).cycles);
assert('recomendado para meta 6h son 4 ciclos', bestOption(bedtimesForWake(wake, cyc, 6)).cycles === 4);
assert('recomendado para meta 9h son 6 ciclos', bestOption(bedtimesForWake(wake, cyc, 9)).cycles === 6);

const bed = new Date('2026-08-19T23:00:00');
const back = wakeTimesForBedtime(bed, cyc, 8);
const back5 = back.find((o) => o.cycles === 5)!;
assert('inverso: 5 ciclos desde 23:00 -> 06:45',
  back5.wakeTime.getHours() === 6 && back5.wakeTime.getMinutes() === 45, back5.wakeTime.toString());
assert('ida y vuelta son coherentes',
  Math.abs(wakeTimesForBedtime(five.bedtime, cyc, 8).find((o) => o.cycles === 5)!.wakeTime.getTime()
    - wake.getTime()) < 1000);

console.log('\n--- Módulo 1: metas ---');
let sched: ScheduleSettings = { mode: 'weekday-weekend', goals: { ...DEFAULT_GOALS } };
sched = applyGoal(sched, 1, { wakeTime: '06:30' });
assert('weekday-weekend propaga a L-V', sched.goals[5].wakeTime === '06:30');
assert('weekday-weekend no toca el finde', sched.goals[6].wakeTime === '09:00');
sched = applyGoal(sched, 6, { targetHours: 9 });
assert('finde se edita aparte', sched.goals[7].targetHours === 9 && sched.goals[1].targetHours === 8);

const perDay = { ...sched, mode: 'per-day' as const };
const back2 = applyGoal(perDay, 3, { wakeTime: '08:00' });
assert('per-day solo toca su día', back2.goals[3].wakeTime === '08:00' && back2.goals[2].wakeTime === '06:30');

const uni = normalizeForMode(sched, 'uniform');
assert('uniform iguala los 7 días', new Set(Object.values(uni.goals).map((g) => g.wakeTime)).size === 1);

const nightAt = upcomingNight(sched, new Date('2026-08-19T14:00:00'));
assert('tras la hora de despertar, la próxima noche es mañana',
  nightAt.wakeAt.getDate() === 20, nightAt.wakeAt.toString());
const nightEarly = upcomingNight(sched, new Date('2026-08-19T03:00:00'));
assert('de madrugada, la meta es la de hoy',
  nightEarly.wakeAt.getDate() === 19, nightEarly.wakeAt.toString());

console.log('\n--- Utilidades de tiempo ---');
assert('ventana que cruza medianoche contiene 23:00', inWindow(23 * 60, 21.5 * 60, 11 * 60));
assert('ventana que cruza medianoche contiene 03:00', inWindow(3 * 60, 21.5 * 60, 11 * 60));
assert('ventana que cruza medianoche excluye 15:00', !inWindow(15 * 60, 21.5 * 60, 11 * 60));
const cm = circularMeanMinutes([23 * 60 + 50, 10]);
assert('media circular de 23:50 y 00:10 es 00:00', cm !== null && (cm < 2 || cm > 1438), cm);
assert('formatDuration 7h30', formatDuration(7.5 * 3600000) === '7h 30m');
assert('formatTime envuelve', formatTime(1500) === '01:00', formatTime(1500));
// Las medias circulares devuelven decimales: deben salir como hora limpia.
assert('formatTime redondea decimales', formatTime(15.947576) === '00:16', formatTime(15.947576));
assert('formatTime redondea al alza sin pasarse de 59',
  formatTime(59.7) === '01:00', formatTime(59.7));

console.log('\n--- Módulo 3: estadísticas ---');
const now = new Date('2026-08-19T12:00:00').getTime();
const mk = (dayOffset: number, bedH: number, bedM: number, hours: number): SleepSession => {
  const end = new Date('2026-08-19T00:00:00');
  end.setDate(end.getDate() - dayOffset);
  end.setHours(bedH, bedM, 0, 0);
  const endTs = end.getTime() + hours * 3600000;
  return { id: `s${dayOffset}`, start: end.getTime(), end: endTs, source: 'manual', confidence: 'high', confirmed: true };
};
const sessions = [mk(1, 23, 0, 8), mk(2, 23, 15, 7.5), mk(3, 22, 45, 8.25), mk(4, 23, 5, 6)];
const nights = buildNights(sessions, sched, 7, now);
assert('7 noches construidas', nights.length === 7);
const sum = summarize(nights);
assert('4 noches con datos', sum.recorded === 4, sum.recorded);
assert('media ~7h26', sum.avgDurationMs !== null && Math.abs(sum.avgDurationMs - 7.4375 * 3600000) < 60000,
  sum.avgDurationMs && formatDuration(sum.avgDurationMs));
// Estas noches duran cosas distintas (8, 7.5, 8.25 y 6 h), así que aunque uno
// se acueste siempre sobre las 23:00 los despertares bailan de 05:05 a 07:00.
// La consistencia debe reflejar esa irregularidad, no premiarla.
assert('consistencia media con despertares dispares',
  (sum.consistency ?? 0) > 40 && (sum.consistency ?? 0) < 65, sum.consistency);
assert('hay deuda por la noche de 6h', sum.debtMs > 1.5 * 3600000, formatDuration(sum.debtMs));

// Mismo horario clavado todas las noches: la consistencia debe dispararse.
// Se usa una meta uniforme de 8 h para que el fin de semana no introduzca un
// déficit ajeno a lo que se está midiendo aquí.
const flat = normalizeForMode(
  { mode: 'uniform', goals: { ...DEFAULT_GOALS } },
  'uniform',
) as ScheduleSettings;
const regular = [mk(1, 23, 0, 8), mk(2, 23, 5, 8), mk(3, 22, 55, 8), mk(4, 23, 0, 8)];
const sumRegular = summarize(buildNights(regular, flat, 7, now));
assert('consistencia alta con horarios clavados', (sumRegular.consistency ?? 0) > 90, sumRegular.consistency);
assert('sin deuda cumpliendo la meta', sumRegular.debtMs === 0, formatDuration(sumRegular.debtMs));
assert('racha de 4 noches', sumRegular.streak === 4, sumRegular.streak);

// Horarios caóticos: acostarse a las 21:00, 02:00, 23:30 y 01:00.
const chaotic = [mk(1, 21, 0, 8), mk(2, 2, 0, 8), mk(3, 23, 30, 8), mk(4, 1, 0, 8)];
const sumChaotic = summarize(buildNights(chaotic, sched, 7, now));
assert('consistencia baja con horarios caóticos', (sumChaotic.consistency ?? 100) < 30, sumChaotic.consistency);
assert('hora media de acostarse cerca de las 23:00',
  sum.avgBedMinutes !== null && Math.abs(sum.avgBedMinutes - 23 * 60) < 20, sum.avgBedMinutes && formatTime(sum.avgBedMinutes));

const empty = summarize(buildNights([], sched, 7, now));
assert('sin datos no rompe', empty.recorded === 0 && empty.avgDurationMs === null && empty.consistency === null);

console.log('\n--- Módulo 3: detección por inactividad ---');
const mon: MonitorSettings = {
  enabled: true,
  minGapMinutes: 180,
  maxGapMinutes: 780,
  nightStart: '21:30',
  nightEnd: '11:00',
  autoConfirm: false,
  background: true,
  triggers: { ...DEFAULT_TRIGGERS },
};
const at = (iso: string) => new Date(iso).getTime();

const nightGap = evaluateGap(at('2026-08-18T23:20:00'), at('2026-08-19T07:10:00'), mon);
assert('hueco nocturno de 7h50 se detecta', nightGap !== null);
assert('y con confianza alta', nightGap?.session.confidence === 'high', nightGap?.session.confidence);

assert('hueco corto de 2h se descarta',
  evaluateGap(at('2026-08-19T01:00:00'), at('2026-08-19T03:00:00'), mon) === null);

assert('siesta de 4h por la tarde se descarta',
  evaluateGap(at('2026-08-19T14:00:00'), at('2026-08-19T18:00:00'), mon) === null);

// Pasadas 13h no es una noche sino una tarde despierto más la noche (o un móvil
// olvidado): no hay nada que corregir y se descarta.
const marathon = evaluateGap(at('2026-08-18T22:00:00'), at('2026-08-19T16:00:00'), mon);
assert('hueco de 18h se descarta por pasar del techo', marathon === null, marathon?.session.confidence);
const doubtful = evaluateGap(at('2026-08-18T22:00:00'), at('2026-08-19T10:30:00'), mon);
assert('hueco de 12h30 se detecta pero es dudoso',
  doubtful !== null && doubtful.session.confidence === 'low', doubtful?.session.confidence);

const dawn = evaluateGap(at('2026-08-19T02:30:00'), at('2026-08-19T09:00:00'), mon);
assert('trasnochar no es dudoso', dawn !== null && dawn.session.confidence !== 'low', dawn?.session.confidence);

const refined = refineEdges(nightGap!.session, 15);
assert('refineEdges retrasa el inicio 15 min', refined.start === nightGap!.session.start + 15 * 60000);
assert('refineEdges adelanta el fin 5 min', refined.end === nightGap!.session.end - 5 * 60000);
const tiny = { ...nightGap!.session, end: nightGap!.session.start + 70 * 60000 };
assert('refineEdges no invierte sesiones cortas', refineEdges(tiny, 15).end > refineEdges(tiny, 15).start);

console.log('\n--- Módulo 3: disparadores ---');

assert('el interruptor general silencia los disparadores',
  triggerEnabled({ ...mon, enabled: false }, 'screen') === false);
assert('un disparador apagado no se evalúa',
  triggerEnabled({ ...mon, triggers: { ...DEFAULT_TRIGGERS, charger: false } }, 'charger') === false);
assert('un disparador ausente cae en su valor por defecto',
  triggerEnabled({ ...mon, triggers: {} as never }, 'screen') === true);

// El cargador acota por fuera (se enchufa antes y se desenchufa después) y la
// pantalla mide el bloqueo real: la fusión debe quedarse con el borde de la
// pantalla, que es la señal más directa de las dos.
const byCharger = evaluateGap(at('2026-08-18T22:40:00'), at('2026-08-19T07:40:00'), mon, ['charger'])!;
const byScreen = evaluateGap(at('2026-08-18T23:20:00'), at('2026-08-19T07:10:00'), mon, ['screen'])!;
const [fused, ...rest] = mergeDetections([byCharger, byScreen], mon);
assert('dos disparadores sobre la misma noche dan una sola sesión', rest.length === 0);
assert('la fusión se queda con el borde de la señal más directa',
  fused.session.start === byScreen.session.start && fused.session.end === byScreen.session.end,
  [fused.session.start, fused.session.end]);

// Un mismo disparador puede dejar la noche en trozos —Doze sale a su ventana
// de mantenimiento y vuelve a entrar—, y esos trozos son una noche, no varias.
const trozo1 = evaluateGap(at('2026-08-18T23:45:00'), at('2026-08-19T03:00:00'), mon, ['idle'])!;
const trozo2 = evaluateGap(at('2026-08-19T03:10:00'), at('2026-08-19T07:00:00'), mon, ['idle'])!;
const unida = mergeDetections([trozo1, trozo2], mon);
assert('dos trozos del mismo disparador se unen en una noche', unida.length === 1, unida.length);
assert('y la noche abarca de principio a fin',
  unida[0]?.session.start === trozo1.session.start && unida[0]?.session.end === trozo2.session.end);

// Pero el puente sólo salva interrupciones cortas: dos noches distintas
// siguen siendo dos.
const anoche = evaluateGap(at('2026-08-17T23:30:00'), at('2026-08-18T07:00:00'), mon, ['screen'])!;
const hoy = evaluateGap(at('2026-08-18T23:30:00'), at('2026-08-19T07:00:00'), mon, ['screen'])!;
assert('dos noches consecutivas no se funden', mergeDetections([anoche, hoy], mon).length === 2);
assert('y conserva ambos orígenes',
  describeTriggers(fused.session.triggers) === 'pantalla + cargador',
  describeTriggers(fused.session.triggers));

const evening = evaluateGap(at('2026-08-18T19:30:00'), at('2026-08-19T00:30:00'), mon, ['screen'])!;
assert('un hueco que sólo toca la noche por un extremo es de confianza media',
  evening.session.confidence === 'medium', evening.session.confidence);
const corroborated = evaluateGap(at('2026-08-18T19:30:00'), at('2026-08-19T00:30:00'), mon,
  ['screen', 'charger'])!;
assert('pero sube a alta si dos disparadores coinciden',
  corroborated.session.confidence === 'high', corroborated.session.confidence);

const noches: SleepSession[] = [];
const flatSchedule: ScheduleSettings = { mode: 'uniform', goals: { ...DEFAULT_GOALS } };
const morning = at('2026-08-19T10:00:00'); // meta de despertar: 07:00

assert('sin el disparador de horario no se propone nada',
  proposeFromSchedule(flatSchedule, mon, noches, null, morning) === null);

const withSchedule: MonitorSettings = {
  ...mon,
  triggers: { ...DEFAULT_TRIGGERS, schedule: true },
};
const fromGoal = proposeFromSchedule(flatSchedule, withSchedule, noches, null, morning);
assert('el horario propone la noche que acaba de terminar', fromGoal !== null);
assert('con la duración de la meta',
  fromGoal !== null && fromGoal.result.session.end - fromGoal.result.session.start === 8 * 3_600_000,
  fromGoal && formatDuration(fromGoal.result.session.end - fromGoal.result.session.start));
assert('y siempre con confianza baja', fromGoal?.result.session.confidence === 'low');
assert('no se repite la misma noche dos veces',
  proposeFromSchedule(flatSchedule, withSchedule, noches, fromGoal!.key, morning) === null);
assert('ni pisa una noche ya registrada',
  proposeFromSchedule(flatSchedule, withSchedule, [fromGoal!.result.session], null, morning) === null);
assert('ni se adelanta a la noche en curso',
  proposeFromSchedule(flatSchedule, withSchedule, noches, null, at('2026-08-19T07:30:00')) === null);

const goalSession = refineEdges(fromGoal!.result.session, 15);
assert('refineEdges no descuenta latencia a la propuesta del horario',
  goalSession.start === fromGoal!.result.session.start);

const mixed: DetectionResult[] = [byScreen, evaluateGap(at('2026-08-20T00:10:00'), at('2026-08-20T08:00:00'), mon, ['screen'])!];
assert('noches distintas no se fusionan', mergeDetections(mixed, mon).length === 2);

console.log('\n--- Módulo 3: disparadores nuevos (reposo y no molestar) ---');

// Los dos nuevos existen en el catálogo, dependen del servicio nativo y sólo
// el de reposo viene encendido: «No molestar» no lo usa todo el mundo, y
// encenderlo por defecto a quien no lo usa sólo produciría silencio.
assert('el catálogo incluye reposo y no molestar',
  TRIGGER_BY_ID.idle !== undefined && TRIGGER_BY_ID.dnd !== undefined);
assert('ambos dependen del servicio nativo',
  TRIGGER_BY_ID.idle.native && TRIGGER_BY_ID.dnd.native);
assert('el reposo viene activo y no molestar no',
  DEFAULT_TRIGGERS.idle === true && DEFAULT_TRIGGERS.dnd === false);
assert('los cuatro nativos son los que el servicio sabe escuchar',
  TRIGGERS.filter((t) => t.native).map((t) => t.id).join(',') === 'screen,charger,idle,dnd',
  TRIGGERS.filter((t) => t.native).map((t) => t.id));

const withIdle: MonitorSettings = {
  ...mon,
  triggers: { ...DEFAULT_TRIGGERS, idle: true, dnd: true },
};
assert('el reposo se evalúa cuando está activo', triggerEnabled(withIdle, 'idle'));
assert('y el interruptor general también lo silencia',
  triggerEnabled({ ...withIdle, enabled: false }, 'idle') === false);

// Doze llega tarde y se va pronto: el sistema tarda en dar el móvil por
// quieto y sale de reposo en cuanto se toca, y además se interrumpe en cada
// ventana de mantenimiento. Por eso no debe recortar a la pantalla, que mide
// el bloqueo real: la fusión se queda con el borde de la señal más directa.
const byIdle = evaluateGap(at('2026-08-18T23:55:00'), at('2026-08-19T07:05:00'), withIdle, ['idle'])!;
assert('un hueco medido por Doze se detecta igual', byIdle !== null);
const idlePlusScreen = mergeDetections([byScreen, byIdle], withIdle);
assert('pantalla y reposo sobre la misma noche dan una sola sesión',
  idlePlusScreen.length === 1, idlePlusScreen.length);
assert('la pantalla manda sobre el reposo por ser más directa',
  idlePlusScreen[0].session.start === byScreen.session.start
    && idlePlusScreen[0].session.end === byScreen.session.end,
  [idlePlusScreen[0].session.start, idlePlusScreen[0].session.end]);
assert('y la noche no se encoge al fundirse',
  idlePlusScreen[0].session.end - idlePlusScreen[0].session.start
    >= Math.max(byScreen.gapMs, byIdle.gapMs));
assert('con los dos orígenes anotados',
  describeTriggers(idlePlusScreen[0].session.triggers) === 'pantalla + reposo',
  describeTriggers(idlePlusScreen[0].session.triggers));

// «No molestar» de 23:00 a 07:00 toca la noche por los dos extremos.
const byDnd = evaluateGap(at('2026-08-18T23:00:00'), at('2026-08-19T07:00:00'), withIdle, ['dnd'])!;
assert('no molestar toda la noche es confianza alta',
  byDnd.session.confidence === 'high', byDnd.session.confidence);

// Una tarde entera con el móvil en reposo no es sueño: la ventana nocturna es
// lo que impide que un disparador nuevo empiece a inventar siestas.
assert('el reposo de una tarde no se propone',
  evaluateGap(at('2026-08-19T13:00:00'), at('2026-08-19T17:30:00'), withIdle, ['idle']) === null);

console.log('\n--- Módulo 3: registro de detección ---');

const ev = (at: number, trigger: TriggerId | null, kind: TriggerEventKind, detail?: string,
  native = true): TriggerEvent => ({ at, trigger, kind, detail, native });

const t0 = at('2026-08-18T23:20:00');
const t1 = at('2026-08-19T07:10:00');

const base = appendEvents([], [
  ev(t0, 'screen', 'open'),
  ev(t1, 'screen', 'close'),
]);
assert('el registro guarda los eventos que se le dan', base.length === 2);
assert('y los ordena del más reciente al más antiguo', base[0].at === t1, base[0].at);

// El registro nativo no se vacía al leerse, así que los mismos eventos vuelven
// en cada apertura de la app. Sin deduplicar, una noche llenaría el registro
// entero con la misma línea repetida.
const again = appendEvents(base, [ev(t0, 'screen', 'open'), ev(t1, 'screen', 'close')]);
assert('releer el registro nativo no duplica nada', again.length === 2, again.length);

const mixedLog = appendEvents(again, [
  ev(t1, 'screen', 'gap', '7h 50m'),
  ev(t1, 'screen', 'detect', '7h 30m · confianza high', false),
]);
assert('se mezclan eventos del servicio y de la app', mixedLog.length === 4);
// Los tres eventos de las 07:10 comparten instante. Sin desempate, la
// propuesta podía aparecer por encima de la señal que la produjo y el
// registro se leía al revés de como ocurrió.
assert('con el mismo instante, lo que midió el móvil va antes que lo que decidió la app',
  mixedLog.findIndex((e) => e.kind === 'detect')
    > mixedLog.findIndex((e) => e.kind === 'gap'),
  mixedLog.map((e) => `${e.kind}:${e.native}`));

// Un evento distinto en el mismo milisegundo no es un duplicado.
assert('un detalle distinto cuenta como evento nuevo',
  appendEvents(base, [ev(t0, 'screen', 'open', 'tras rearme')]).length === 3);
assert('un disparador distinto también',
  appendEvents(base, [ev(t0, 'idle', 'open')]).length === 3);

// El tope evita que un servicio que rearranca en bucle llene el disco.
const many = Array.from({ length: 50 }, (_, i) => ev(t0 + i * 1000, null, 'service', `n${i}`));
const capped = appendEvents([], many, 20);
assert('el registro se recorta al tope', capped.length === 20, capped.length);
assert('y conserva los más recientes', capped[0].detail === 'n49', capped[0].detail);

const summary = summarizeLog(mixedLog);
assert('el resumen cuenta el total', summary.total === 4, summary.total);
assert('la última señal es la del cierre, no la de la propuesta',
  summary.lastSignalAt === t1, summary.lastSignalAt);
assert('lista los disparadores que han dado señales',
  summary.activeTriggers.join(',') === 'screen', summary.activeTriggers);
assert('cuenta huecos y detecciones por separado',
  summary.gaps === 1 && summary.detections === 1);
assert('sin fallos anotados no inventa ninguno', summary.lastError === null);

// Un registro lleno de eventos del servicio pero sin una sola señal es
// exactamente el caso que había que poder ver: el servicio arranca, se rearma,
// y aun así nadie está escuchando el dispositivo.
const silent = summarizeLog(appendEvents([], [
  ev(t0, null, 'service', 'en primer plano'),
  ev(t0 + 60_000, null, 'error', 'sin permiso de alarmas exactas'),
]));
assert('un servicio que arranca sin recibir señales se nota',
  silent.lastSignalAt === null && silent.activeTriggers.length === 0);
assert('y el fallo queda a mano', silent.lastError?.kind === 'error');

assert('cada línea se lee sola',
  describeEvent(ev(t1, 'screen', 'close', 'tras 7h 50m')).endsWith(
    'pantalla · vuelves al móvil — tras 7h 50m'),
  describeEvent(ev(t1, 'screen', 'close', 'tras 7h 50m')));
assert('los eventos sin disparador se atribuyen al servicio',
  describeEvent(ev(t1, null, 'service', 'en primer plano')).includes('servicio · servicio'));
assert('el descarte deja por escrito la duración y el motivo',
  discardReason(2.5 * 3600000, 'por debajo del mínimo') === '2h 30m · por debajo del mínimo',
  discardReason(2.5 * 3600000, 'por debajo del mínimo'));
assert('lo que avanza y lo que se rompe se distinguen de un vistazo',
  eventTone('detect') === 'mint' && eventTone('discard') === 'amber' && eventTone('error') === 'rose');

console.log('\n--- Autoactualización ---');

assert('la etiqueta de release da nombre y número de compilación',
  parseTag('v0.1.0-b23')?.versionName === '0.1.0' && parseTag('v0.1.0-b23')?.versionCode === 23);
assert('acepta versiones con sufijo', parseTag('v1.2.0-rc1-b7')?.versionName === '1.2.0-rc1');
assert('rechaza una etiqueta publicada a mano', parseTag('v0.1.0') === null);
assert('rechaza un número de compilación inválido', parseTag('v0.1.0-b0') === null);
assert('rechaza basura', parseTag('release-final') === null);

const release = readRelease({
  tag_name: 'v0.2.0-b31',
  assets: [
    { name: 'notas.txt', browser_download_url: 'https://x/notas.txt' },
    { name: 'PerfectRest-v0.2.0-b31.apk', browser_download_url: 'https://x/app.apk' },
  ],
});
assert('de la respuesta de la API se saca la APK y la versión',
  release?.versionCode === 31 && release?.apkUrl === 'https://x/app.apk');
assert('una release sin APK no es una actualización',
  readRelease({ tag_name: 'v0.2.0-b31', assets: [] }) === null);
assert('un borrador se ignora',
  readRelease({ tag_name: 'v0.2.0-b31', draft: true, assets: [
    { name: 'a.apk', browser_download_url: 'https://x/a.apk' }] }) === null);

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
