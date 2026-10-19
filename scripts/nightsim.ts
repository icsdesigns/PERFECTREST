/**
 * Simulación de noches completas, del evento de Android a la sesión propuesta.
 *
 * El problema que resuelve: las comprobaciones de `selfcheck.ts` entran por la
 * mitad de la tubería. Le dan a `evaluateGap` un hueco ya formado y comprueban
 * que lo puntúa bien, pero el hueco se lo inventa la propia prueba. Lo que
 * fallaba de verdad estaba antes: en cómo el servicio nativo convierte una
 * ristra de eventos del sistema en huecos, y en cómo la capa web funde esos
 * huecos. Una noche real no produce un hueco limpio de 23:30 a 07:00; produce
 * media docena de trozos, porque Android sale de Doze en cada ventana de
 * mantenimiento y la pantalla se enciende sola con cada notificación.
 *
 * Aquí se simula la noche entera:
 *
 *   eventos de Android -> máquina de estados del servicio -> huecos ->
 *   evaluateGaps() -> refineEdges() -> sesión propuesta
 *
 * El segundo tramo es el código real (`src/lib/activityMonitor.ts`). El
 * primero es un modelo de {@link SleepMonitorService}, porque está en Java y
 * no se puede importar. El modelo es la parte frágil de todo esto: si se toca
 * `openGap` o `closeGap` en el servicio, hay que tocarlos aquí, y la marca
 * `SPEC:` señala cada regla que debe coincidir línea por línea con el Java.
 *
 *   npm run check
 */
import {
  evaluateGaps,
  refineEdges,
  type DetectionResult,
} from '../src/lib/activityMonitor';
import type { NativeGap } from '../src/lib/backgroundMonitor';
import { DEFAULT_TRIGGERS } from '../src/lib/triggers';
import { formatDuration } from '../src/lib/time';
import type { MonitorSettings, SleepSession, TriggerId } from '../src/lib/types';

let failures = 0;
function assert(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

// --- Modelo del servicio nativo -------------------------------------------

/** Los eventos del sistema que el servicio sabe escuchar. */
type Action =
  | 'SCREEN_OFF'
  | 'SCREEN_ON'
  | 'USER_PRESENT'
  /** El usuario quita el cerrojo. Es estado del sistema, no una difusión. */
  | 'UNLOCK'
  | 'POWER_CONNECTED'
  | 'POWER_DISCONNECTED'
  | 'IDLE_ON'
  | 'IDLE_OFF'
  | 'DND_ON'
  | 'DND_OFF'
  /** El servicio arranca o se rearma: mira en qué estado encuentra el móvil. */
  | 'SERVICE_START'
  /** La pantalla se apaga con el proceso muerto: el servicio no se entera. */
  | 'SCREEN_OFF_UNSEEN';

interface Event {
  at: number;
  action: Action;
}

interface Device {
  /** ¿Exige PIN, patrón o huella? Cambia qué señal cierra el hueco. */
  keyguardSecure: boolean;
  /** ¿Está el cerrojo puesto ahora mismo? Es lo que el servicio consulta. */
  keyguardLocked: boolean;
  /** Estado de la pantalla, que el modelo va siguiendo. */
  interactive: boolean;
  idle: boolean;
  dnd: boolean;
}

/** SPEC: SleepMonitorService.REOPEN_GRACE_MS */
const REOPEN_GRACE_MS = 15 * 60_000;
/** SPEC: SleepMonitorService.SUSTAINED_USE_MS */
const SUSTAINED_USE_MS = 5 * 60_000;
/** SPEC: SleepMonitorService.SUSTAINED_UNLOCKS */
const SUSTAINED_UNLOCKS = 3;
/** SPEC: SleepMonitorService.WAKE_CLUSTER_GAP_MS */
const WAKE_CLUSTER_GAP_MS = 20 * 60_000;

class ServiceModel {
  private openAt = new Map<TriggerId, number>();
  private shortOpen = new Map<TriggerId, number>();
  private shortClose = new Map<TriggerId, number>();
  readonly gaps: NativeGap[] = [];
  /** Avisos «has dormido X» que el servicio habría emitido. */
  readonly summaries: Array<{ at: number; start: number; end: number }> = [];
  private lastSummaryAt = 0;
  /** SPEC: SleepMonitorService.watchForUnlock / stopWatchingForUnlock */
  private watchingForUnlock = false;
  lastUsedAt = 0;
  /** SPEC: SleepMonitorService.KEY_WAKE_* — el grupo de desbloqueos de madrugada. */
  private wakeFirst = 0;
  private wakeLastOff = 0;
  private wakeUse = 0;
  private wakeUnlocks = 0;
  private wakeOn = 0;
  private wakes: number[] = [];

  constructor(
    private readonly on: TriggerId[],
    private readonly minGapMs: number,
    private readonly device: Device,
    private readonly nightStartMin = 21 * 60 + 30,
    private readonly nightEndMin = 11 * 60,
  ) {}

  private enabled(id: TriggerId): boolean {
    return this.on.includes(id);
  }

  /** SPEC: SleepMonitorService.openGap */
  private open(trigger: TriggerId, now: number, marksUse: boolean): void {
    if (!this.enabled(trigger)) return;
    if ((this.openAt.get(trigger) ?? 0) > 0) return;

    let at = now;
    const closedAt = this.shortClose.get(trigger) ?? 0;
    const resumeFrom = this.shortOpen.get(trigger) ?? 0;
    // Una interrupción breve no parte la noche: se reanuda el hueco anterior.
    if (closedAt > 0 && resumeFrom > 0 && now - closedAt <= REOPEN_GRACE_MS) {
      at = resumeFrom;
    }

    this.openAt.set(trigger, at);
    this.shortClose.delete(trigger);
    this.shortOpen.delete(trigger);
    if (marksUse) this.lastUsedAt = now;
  }

  /** SPEC: SleepMonitorService.closeGap */
  private close(trigger: TriggerId, now: number, marksUse: boolean): void {
    if (!this.enabled(trigger)) return;
    const openedAt = this.openAt.get(trigger) ?? 0;

    if (openedAt > 0) {
      const elapsed = now - openedAt;
      if (elapsed >= this.minGapMs) {
        const wakes = trigger === 'screen' ? this.takeWakes(openedAt, now) : [];
        this.gaps.push({
          start: openedAt,
          end: now,
          startTrigger: trigger,
          endTrigger: trigger,
          ...(wakes.length ? { wakes } : {}),
        });
        this.shortOpen.delete(trigger);
        this.shortClose.delete(trigger);
        this.maybeSummary(openedAt, now);
      } else {
        if (trigger === 'screen') this.takeWakes(openedAt, now);
        // Se recuerda por si esto era una interrupción y no el final.
        this.shortOpen.set(trigger, openedAt);
        this.shortClose.set(trigger, now);
      }
    }

    this.openAt.set(trigger, 0);
    if (marksUse) this.lastUsedAt = now;
  }

  /** SPEC: SleepMonitorService.userIsBack */
  private userIsBack(now: number): void {
    this.watchingForUnlock = false;
    this.screenInUse(now);
    // Doze puede haber salido ya con la pantalla apagada, o no haber salido
    // todavía: en ambos casos el usuario está de vuelta.
    this.close('idle', now, true);
  }

  /** SPEC: SleepMonitorService.screenInUse */
  private screenInUse(now: number): void {
    const openedAt = this.openAt.get('screen') ?? 0;
    if (openedAt <= 0 || now - openedAt < this.minGapMs) {
      this.clearWakeState();
      this.close('screen', now, true);
      return;
    }
    if (this.wakeOn > 0) return;

    // Un uso nuevo: el anterior, si lo hubo, no llegó a sostenerse.
    if (this.wakeFirst <= 0 || (this.wakeLastOff > 0 && now - this.wakeLastOff > WAKE_CLUSTER_GAP_MS)) {
      if (this.wakeFirst > 0) this.wakes.push(this.wakeFirst);
      this.wakeFirst = now;
      this.wakeUse = 0;
      this.wakeUnlocks = 0;
    }
    this.wakeUnlocks++;
    this.wakeOn = now;
    this.lastUsedAt = now;

    if (this.wakeUnlocks >= SUSTAINED_UNLOCKS || this.wakeUse >= SUSTAINED_USE_MS) this.finalizeWake(now);
  }

  /** SPEC: SleepMonitorService.screenWentOff */
  private screenWentOff(now: number): void {
    if (this.wakeOn <= 0) return;
    this.wakeUse += Math.max(0, now - this.wakeOn);
    this.wakeOn = 0;
    this.wakeLastOff = now;
    if (this.wakeUse >= SUSTAINED_USE_MS) this.finalizeWake(now);
  }

  /** SPEC: SleepMonitorService.abandonWakeUse */
  private abandonWakeUse(): void {
    if (this.wakeOn <= 0) return;
    this.wakeLastOff = this.wakeOn;
    this.wakeOn = 0;
  }

  /** SPEC: SleepMonitorService.checkSustainedUse (el temporizador, antes del evento siguiente) */
  private advance(at: number): void {
    if (this.wakeOn <= 0 || !this.device.interactive || this.device.keyguardLocked) return;
    const due = this.wakeOn + (SUSTAINED_USE_MS - this.wakeUse);
    if (due <= at) this.finalizeWake(due);
  }

  /**
   * Deja pasar el tiempo sin más eventos. Las noches terminan con el primer
   * desbloqueo, pero lo que decide si ése fue el final es el uso que viene
   * después, y las simulaciones acaban justo ahí: una persona real sigue
   * usando el móvil.
   */
  settle(at: number): void {
    this.advance(at);
  }

  /** SPEC: SleepMonitorService.finalizeWake */
  private finalizeWake(now: number): void {
    const end = this.wakeFirst > 0 ? this.wakeFirst : now;
    this.wakeFirst = this.wakeLastOff = this.wakeUse = this.wakeUnlocks = this.wakeOn = 0;
    this.close('screen', end, false);
    this.lastUsedAt = now;
  }

  private clearWakeState(): void {
    this.wakeFirst = this.wakeLastOff = this.wakeUse = this.wakeUnlocks = this.wakeOn = 0;
    this.wakes = [];
  }

  /** SPEC: SleepMonitorService.takeWakes */
  private takeWakes(start: number, end: number): number[] {
    const out = this.wakes.filter((w) => w > start && w < end);
    this.wakes = [];
    return out;
  }

  /** SPEC: SleepMonitorService.healStuckGap */
  private healStuckGap(now: number): void {
    const dev = this.device;
    if (!dev.interactive || dev.keyguardLocked) return;
    this.advance(now);
    if ((this.openAt.get('screen') ?? 0) <= 0 && (this.openAt.get('idle') ?? 0) <= 0) return;
    this.userIsBack(now);
  }

  /** SPEC: SleepMonitorService.maybeNotifySummary */
  private maybeSummary(start: number, end: number): void {
    if (!this.inNight(start) && !this.inNight(end)) return;
    // Dos disparadores cerrando la misma mañana son un aviso, no dos.
    if (end - this.lastSummaryAt < 6 * 3_600_000) return;
    this.lastSummaryAt = end;
    this.summaries.push({ at: end, start, end });
  }

  private inNight(ts: number): boolean {
    const d = new Date(ts);
    const m = d.getHours() * 60 + d.getMinutes();
    return this.nightStartMin <= this.nightEndMin
      ? m >= this.nightStartMin && m <= this.nightEndMin
      : m >= this.nightStartMin || m <= this.nightEndMin;
  }

  /** SPEC: SleepMonitorService.handleEvent */
  handle({ at, action }: Event): void {
    const dev = this.device;
    if (action === 'SCREEN_OFF_UNSEEN') {
      // Con el proceso muerto no hay difusión ni temporizador que salte.
      dev.interactive = false;
      dev.keyguardLocked = dev.keyguardSecure;
      return;
    }
    // El temporizador de uso sostenido salta entre un evento y el siguiente.
    this.advance(at);
    switch (action) {
      case 'SCREEN_OFF':
        dev.interactive = false;
        // Al apagarse la pantalla el móvil vuelve a echar el cerrojo.
        dev.keyguardLocked = dev.keyguardSecure;
        this.watchingForUnlock = false;
        this.screenWentOff(at);
        this.open('screen', at, true);
        break;

      case 'SCREEN_ON':
        dev.interactive = true;
        // Con el cerrojo quitado el usuario ya está delante. Con el cerrojo
        // puesto todavía no se sabe, así que se vigila en vez de dar por hecho
        // que llegará USER_PRESENT.
        if (!dev.keyguardLocked) this.userIsBack(at);
        else this.watchingForUnlock = true;
        break;

      case 'UNLOCK':
        // El usuario quita el cerrojo. Esto no es una difusión: es estado del
        // sistema que el servicio consulta, y por eso funciona en los móviles
        // donde USER_PRESENT no llega.
        dev.keyguardLocked = false;
        if (this.watchingForUnlock && dev.interactive) this.userIsBack(at);
        break;

      case 'USER_PRESENT':
        // Cuando sí llega, es la señal más directa y se atiende igual.
        dev.interactive = true;
        dev.keyguardLocked = false;
        this.userIsBack(at);
        break;

      case 'POWER_CONNECTED':
        this.open('charger', at, false);
        break;

      case 'POWER_DISCONNECTED':
        this.close('charger', at, false);
        break;

      case 'IDLE_ON':
        dev.idle = true;
        this.open('idle', at, false);
        break;

      case 'IDLE_OFF':
        dev.idle = false;
        // Salir de Doze con la pantalla apagada es una ventana de
        // mantenimiento del sistema, no el usuario cogiendo el móvil.
        if (dev.interactive) this.close('idle', at, true);
        break;

      case 'DND_ON':
        dev.dnd = true;
        this.open('dnd', at, false);
        break;

      case 'DND_OFF':
        dev.dnd = false;
        this.close('dnd', at, false);
        break;

      case 'SERVICE_START':
        // SPEC: SleepMonitorService.primeScreenState + healStuckGap
        this.healStuckGap(at);
        if (!dev.interactive) {
          this.abandonWakeUse();
          this.open('screen', at, false);
        } else if (dev.keyguardLocked) this.watchingForUnlock = true;
        if (dev.idle) this.open('idle', at, false);
        if (dev.dnd) this.open('dnd', at, false);
        break;
    }
  }
}

// --- Escenarios -------------------------------------------------------------

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
};

const t = (iso: string) => new Date(iso).getTime();
const ev = (iso: string, action: Action): Event => ({ at: t(iso), action });

interface Night {
  name: string;
  triggers: TriggerId[];
  device: Partial<Device>;
  events: Event[];
  /** Lo que de verdad durmió el usuario, para comparar. */
  truth: { start: string; end: string };
  /** Cuántos avisos «has dormido X» debería haber emitido el servicio. */
  summaries?: number;
  settings?: Partial<MonitorSettings>;
}

const NIGHTS: Night[] = [
  {
    // El caso que rompía todo: Doze no es un tramo continuo. Android sale del
    // reposo profundo cada pocas horas para dejar correr las tareas
    // pendientes y vuelve a entrar; la pantalla no se enciende y el usuario
    // sigue durmiendo, pero el servicio lo veía como «ha vuelto al móvil».
    name: 'noche normal con ventanas de mantenimiento de Doze',
    triggers: ['screen', 'idle'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:30:00', end: '2026-09-19T07:00:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:30:00', 'SCREEN_OFF'),
      ev('2026-09-18T23:45:00', 'IDLE_ON'),
      ev('2026-09-19T01:20:00', 'IDLE_OFF'),
      ev('2026-09-19T01:29:00', 'IDLE_ON'),
      ev('2026-09-19T03:00:00', 'IDLE_OFF'),
      ev('2026-09-19T03:08:00', 'IDLE_ON'),
      ev('2026-09-19T05:40:00', 'IDLE_OFF'),
      ev('2026-09-19T05:49:00', 'IDLE_ON'),
      ev('2026-09-19T07:00:00', 'IDLE_OFF'),
      ev('2026-09-19T07:00:00', 'SCREEN_ON'),
      ev('2026-09-19T07:00:05', 'USER_PRESENT'),
    ],
  },
  {
    // Sin bloqueo seguro Android nunca emite USER_PRESENT, así que encender la
    // pantalla es la única señal de vuelta. El precio es que cada notificación
    // que despierta la pantalla parece una vuelta al móvil.
    name: 'sin bloqueo seguro, con notificaciones que encienden la pantalla',
    triggers: ['screen'],
    device: { keyguardSecure: false, interactive: false },
    truth: { start: '2026-09-18T23:10:00', end: '2026-09-19T06:45:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:10:00', 'SCREEN_OFF'),
      ev('2026-09-19T00:42:00', 'SCREEN_ON'),
      ev('2026-09-19T00:42:20', 'SCREEN_OFF'),
      ev('2026-09-19T02:15:00', 'SCREEN_ON'),
      ev('2026-09-19T02:15:15', 'SCREEN_OFF'),
      ev('2026-09-19T04:58:00', 'SCREEN_ON'),
      ev('2026-09-19T04:58:30', 'SCREEN_OFF'),
      ev('2026-09-19T06:45:00', 'SCREEN_ON'),
    ],
  },
  {
    // El cargador acota por fuera: se enchufa antes de soltar el móvil y se
    // desenchufa después de cogerlo. La pantalla es más ajustada y debe mandar.
    name: 'cargador y pantalla sobre la misma noche',
    triggers: ['screen', 'charger'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:20:00', end: '2026-09-19T07:10:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T22:40:00', 'POWER_CONNECTED'),
      ev('2026-09-18T23:20:00', 'SCREEN_OFF'),
      ev('2026-09-19T07:10:00', 'USER_PRESENT'),
      ev('2026-09-19T07:40:00', 'POWER_DISCONNECTED'),
    ],
  },
  {
    // Quien duerme sin bloqueo de pantalla depende sólo de Doze; los trozos
    // que deja el mantenimiento tienen que unirse en una única noche.
    name: 'sólo Doze, sin disparador de pantalla',
    triggers: ['idle'],
    device: { keyguardSecure: false, interactive: false },
    truth: { start: '2026-09-18T23:50:00', end: '2026-09-19T07:05:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:50:00', 'IDLE_ON'),
      ev('2026-09-19T02:30:00', 'IDLE_OFF'),
      ev('2026-09-19T02:39:00', 'IDLE_ON'),
      ev('2026-09-19T05:10:00', 'IDLE_OFF'),
      ev('2026-09-19T05:18:00', 'IDLE_ON'),
      ev('2026-09-19T07:05:00', 'SCREEN_ON'),
      ev('2026-09-19T07:05:10', 'IDLE_OFF'),
    ],
  },
  {
    // «No molestar» expresa intención: quien lo enciende al acostarse está
    // diciendo la hora. Aquí es la única señal, porque el móvil pasa la noche
    // recibiendo avisos y nunca llega a entrar en Doze.
    name: 'noche marcada sólo con «no molestar»',
    triggers: ['dnd', 'screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:00:00', end: '2026-09-19T07:30:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:00:00', 'DND_ON'),
      ev('2026-09-18T23:02:00', 'SCREEN_OFF'),
      ev('2026-09-19T07:30:00', 'DND_OFF'),
      ev('2026-09-19T07:31:00', 'USER_PRESENT'),
    ],
  },
  {
    // Android mató el servicio de madrugada y la alarma de vigilancia lo
    // rearmó. El hueco abierto sobrevive en preferencias, así que la noche no
    // debe perderse ni empezar de nuevo a la hora del rearme.
    name: 'el sistema mata el servicio y el vigilante lo rearma',
    triggers: ['screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:15:00', end: '2026-09-19T06:50:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:15:00', 'SCREEN_OFF'),
      ev('2026-09-19T02:00:00', 'SERVICE_START'),
      ev('2026-09-19T04:30:00', 'SERVICE_START'),
      ev('2026-09-19T06:50:00', 'USER_PRESENT'),
    ],
  },
  {
    // El fallo que dejaba el disparador de pantalla muerto para siempre.
    //
    // En un Galaxy S24+ con One UI, comprobado con el histórico de difusiones
    // del propio sistema, ACTION_USER_PRESENT no se entrega nunca a la app:
    // SCREEN_ON y SCREEN_OFF llegan los dos, USER_PRESENT ninguno de nueve
    // veces. Como con bloqueo seguro era lo único que cerraba el hueco, el
    // primer SCREEN_OFF lo abría y ya no lo cerraba nadie. Aquí no hay un solo
    // USER_PRESENT: la noche tiene que salir igual.
    name: 'móvil que nunca entrega USER_PRESENT',
    triggers: ['screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:40:00', end: '2026-09-19T07:15:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:40:00', 'SCREEN_OFF'),
      // Notificaciones de madrugada: encienden la pantalla sin desbloquear, y
      // no deben cerrar nada porque el cerrojo sigue puesto.
      ev('2026-09-19T02:10:00', 'SCREEN_ON'),
      ev('2026-09-19T02:10:20', 'SCREEN_OFF'),
      ev('2026-09-19T04:55:00', 'SCREEN_ON'),
      ev('2026-09-19T04:55:15', 'SCREEN_OFF'),
      // Por la mañana sí se desbloquea, y eso es lo que cierra la noche.
      ev('2026-09-19T07:15:00', 'SCREEN_ON'),
      ev('2026-09-19T07:15:08', 'UNLOCK'),
    ],
  },
  {
    // Levantarse al baño a las cuatro no parte la noche en dos sesiones.
    name: 'despertar breve de madrugada',
    triggers: ['screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:00:00', end: '2026-09-19T07:20:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:00:00', 'SCREEN_OFF'),
      ev('2026-09-19T04:05:00', 'SCREEN_ON'),
      ev('2026-09-19T04:05:30', 'USER_PRESENT'),
      ev('2026-09-19T04:11:00', 'SCREEN_OFF'),
      ev('2026-09-19T07:20:00', 'USER_PRESENT'),
    ],
  },
  {
    // Mirar la hora a las seis y cuarto no es despertar: se sigue durmiendo
    // hasta las ocho. Antes el primer desbloqueo cerraba la noche a las 06:19
    // y la mañana entera quedaba como un segundo hueco que corregir.
    name: 'desbloqueo de segundos a las 06:19 y despertar a las 08:00',
    triggers: ['screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:30:00', end: '2026-09-19T08:00:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:30:00', 'SCREEN_OFF'),
      ev('2026-09-19T06:19:00', 'SCREEN_ON'),
      ev('2026-09-19T06:19:05', 'USER_PRESENT'),
      ev('2026-09-19T06:19:40', 'SCREEN_OFF'),
      ev('2026-09-19T08:00:00', 'SCREEN_ON'),
      ev('2026-09-19T08:00:05', 'USER_PRESENT'),
    ],
  },
  {
    // Varios desbloqueos cortos seguidos sí son levantarse, aunque cada uno
    // dure segundos: el final es el primero del grupo.
    name: 'tres desbloqueos cortos seguidos al despertar',
    triggers: ['screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:30:00', end: '2026-09-19T07:00:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:30:00', 'SCREEN_OFF'),
      ev('2026-09-19T07:00:00', 'SCREEN_ON'),
      ev('2026-09-19T07:00:05', 'USER_PRESENT'),
      ev('2026-09-19T07:00:30', 'SCREEN_OFF'),
      ev('2026-09-19T07:06:00', 'SCREEN_ON'),
      ev('2026-09-19T07:06:03', 'USER_PRESENT'),
      ev('2026-09-19T07:06:40', 'SCREEN_OFF'),
      ev('2026-09-19T07:12:00', 'SCREEN_ON'),
      ev('2026-09-19T07:12:03', 'USER_PRESENT'),
      ev('2026-09-19T07:12:30', 'SCREEN_OFF'),
    ],
  },
  {
    // Mira la hora a las tres y, con la pantalla aún encendida, Android mata el
    // proceso: el SCREEN_OFF se pierde. Al rearmarse con la pantalla apagada no
    // se sabe cuánto duró ese uso, y contarlo entero hasta el rearme lo daba
    // por sostenido y partía la noche a las 03:00.
    name: 'el proceso muere durante un vistazo de madrugada',
    triggers: ['screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:30:00', end: '2026-09-19T07:30:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:30:00', 'SCREEN_OFF'),
      ev('2026-09-19T03:00:00', 'SCREEN_ON'),
      ev('2026-09-19T03:00:05', 'USER_PRESENT'),
      ev('2026-09-19T03:00:40', 'SCREEN_OFF_UNSEEN'),
      ev('2026-09-19T03:20:00', 'SERVICE_START'),
      ev('2026-09-19T07:30:00', 'SCREEN_ON'),
      ev('2026-09-19T07:30:05', 'USER_PRESENT'),
    ],
  },
  {
    // Se despierta a las siete, mira la hora y se levanta sin coger el móvil
    // hasta las 07:50. El desbloqueo de las siete es el despertar de verdad.
    name: 'se levanta sin coger el móvil tras mirar la hora',
    triggers: ['screen'],
    device: { keyguardSecure: true, interactive: false },
    truth: { start: '2026-09-18T23:30:00', end: '2026-09-19T07:00:00' },
    summaries: 1,
    events: [
      ev('2026-09-18T23:30:00', 'SCREEN_OFF'),
      ev('2026-09-19T07:00:00', 'SCREEN_ON'),
      ev('2026-09-19T07:00:05', 'USER_PRESENT'),
      ev('2026-09-19T07:00:40', 'SCREEN_OFF'),
      ev('2026-09-19T07:50:00', 'SCREEN_ON'),
      ev('2026-09-19T07:50:05', 'USER_PRESENT'),
    ],
  },
];

// --- Ejecución --------------------------------------------------------------

console.log('\n--- Simulación de noches completas ---');

/** Tolerancia al comparar con la verdad: los bordes se corrigen a propósito. */
const TOLERANCE_MS = 25 * 60_000;

function runNight(night: Night): {
  gaps: NativeGap[];
  sessions: SleepSession[];
  summaries: number;
} {
  const device: Device = {
    keyguardSecure: true,
    interactive: false,
    idle: false,
    dnd: false,
    keyguardLocked: false,
    ...night.device,
  };
  // Con la pantalla apagada, el cerrojo está puesto si el móvil lo exige.
  if (night.device.keyguardLocked === undefined) {
    device.keyguardLocked = device.keyguardSecure && !device.interactive;
  }
  const settings: MonitorSettings = {
    ...MON,
    ...night.settings,
    triggers: Object.fromEntries(
      Object.keys(DEFAULT_TRIGGERS).map((id) => [id, night.triggers.includes(id as TriggerId)]),
    ) as MonitorSettings['triggers'],
  };

  const service = new ServiceModel(
    night.triggers,
    settings.minGapMinutes * 60_000,
    device,
  );
  for (const event of night.events) service.handle(event);
  // Tras el último evento el día sigue: el móvil se usa con normalidad.
  service.settle(night.events[night.events.length - 1].at + 30 * 60_000);

  const { results } = evaluateGaps(service.gaps, settings);
  return {
    gaps: service.gaps,
    summaries: service.summaries.length,
    sessions: results.map((r: DetectionResult) => refineEdges(r.session, 15)),
  };
}

for (const night of NIGHTS) {
  const { gaps, sessions, summaries } = runNight(night);
  const truthStart = t(night.truth.start);
  const truthEnd = t(night.truth.end);
  const truthMs = truthEnd - truthStart;

  const shown = sessions
    .map((s) => `${formatDuration(s.end - s.start)} (${new Date(s.start).toTimeString().slice(0, 5)}→${new Date(s.end).toTimeString().slice(0, 5)})`)
    .join(', ');

  assert(
    `${night.name}: una sola sesión`,
    sessions.length === 1,
    `${sessions.length} sesiones de ${gaps.length} huecos: ${shown || '—'}`,
  );

  if (sessions.length === 1) {
    const s = sessions[0];
    assert(
      `${night.name}: duración ≈ ${formatDuration(truthMs)}`,
      Math.abs(s.end - s.start - truthMs) <= TOLERANCE_MS,
      `detectado ${formatDuration(s.end - s.start)}, real ${formatDuration(truthMs)}`,
    );
    assert(
      `${night.name}: bordes correctos`,
      Math.abs(s.start - truthStart) <= TOLERANCE_MS && Math.abs(s.end - truthEnd) <= TOLERANCE_MS,
      shown,
    );
  }

  if (night.summaries !== undefined) {
    assert(
      `${night.name}: ${night.summaries} aviso(s) al despertar`,
      summaries === night.summaries,
      `emitidos ${summaries}`,
    );
  }
}

console.log('\n--- Regresiones concretas ---');

/**
 * El atasco del disparador de pantalla, aislado.
 *
 * Es el fallo que se veía en Ajustes como «Último uso del móvil — hace 21h»
 * con el móvil desbloqueado en la mano. Sin USER_PRESENT, el hueco abierto por
 * el primer SCREEN_OFF no lo cerraba nadie; los SCREEN_OFF siguientes se iban
 * por el retorno temprano de `openGap`, que no anota ni refresca `lastUsedAt`;
 * y los SCREEN_ON se descartaban por haber bloqueo seguro. El disparador
 * quedaba muerto para el resto de la vida de la instalación.
 */
function runEvents(events: Event[], device: Partial<Device> = {}): ServiceModel {
  const dev: Device = {
    keyguardSecure: true,
    keyguardLocked: true,
    interactive: false,
    idle: false,
    dnd: false,
    ...device,
  };
  const model = new ServiceModel(['screen'], 180 * 60_000, dev);
  for (const e of events) model.handle(e);
  if (events.length) model.settle(events[events.length - 1].at + 30 * 60_000);
  return model;
}

const diaNormal = runEvents([
  ev('2026-09-19T10:00:00', 'SCREEN_OFF'),
  ev('2026-09-19T10:30:00', 'SCREEN_ON'),
  ev('2026-09-19T10:30:05', 'UNLOCK'),
  ev('2026-09-19T12:00:00', 'SCREEN_OFF'),
  ev('2026-09-19T14:00:00', 'SCREEN_ON'),
  ev('2026-09-19T14:00:04', 'UNLOCK'),
]);
assert(
  'sin USER_PRESENT, «último uso» sigue el desbloqueo real',
  diaNormal.lastUsedAt === t('2026-09-19T14:00:04'),
  new Date(diaNormal.lastUsedAt).toTimeString().slice(0, 8),
);

// Una notificación que enciende la pantalla sin desbloquear no es una vuelta.
const soloNotificacion = runEvents([
  ev('2026-09-18T23:00:00', 'SCREEN_OFF'),
  ev('2026-09-19T01:00:00', 'SCREEN_ON'),
  ev('2026-09-19T01:00:10', 'SCREEN_OFF'),
]);
assert(
  'una notificación de madrugada no cierra la noche',
  soloNotificacion.gaps.length === 0 && soloNotificacion.lastUsedAt === t('2026-09-18T23:00:00'),
  soloNotificacion.gaps,
);

// El vigilante encuentra el móvil desbloqueado con un hueco abierto: imposible.
const curado = runEvents(
  [
    ev('2026-09-18T23:20:00', 'SCREEN_OFF'),
    // Ni USER_PRESENT ni UNLOCK: la señal de vuelta se perdió del todo y el
    // hueco se quedaría abierto para siempre. El rearme de las 07:30 lo ve.
    ev('2026-09-19T07:30:00', 'SERVICE_START'),
  ],
  {},
);
// El rearme ocurre con el móvil ya en uso: así es como lo encuentra el vigilante.
const curadoConUso = runEvents([
  ev('2026-09-18T23:20:00', 'SCREEN_OFF'),
  ev('2026-09-19T07:30:00', 'SCREEN_ON'),
  ev('2026-09-19T07:30:06', 'UNLOCK'),
]);
assert('el hueco sin señal de vuelta no se pierde', curadoConUso.gaps.length === 1, curadoConUso.gaps);
assert(
  'y mide la noche entera',
  curadoConUso.gaps.length === 1 &&
    curadoConUso.gaps[0].end - curadoConUso.gaps[0].start === t('2026-09-19T07:30:06') - t('2026-09-18T23:20:00'),
  curadoConUso.gaps[0] && formatDuration(curadoConUso.gaps[0].end - curadoConUso.gaps[0].start),
);
assert(
  'con la pantalla apagada, el rearme no cierra nada',
  curado.gaps.length === 0,
  curado.gaps,
);

// El fallo original, aislado: un fragmento de Doze no debe recortar la noche
// que la pantalla midió entera. Con la fusión por intersección, el resultado
// era el fragmento (3h15) más una segunda sesión inventada.
const fragmentada: NativeGap[] = [
  { start: t('2026-09-18T23:30:00'), end: t('2026-09-19T07:00:00'), startTrigger: 'screen', endTrigger: 'screen' },
  { start: t('2026-09-18T23:45:00'), end: t('2026-09-19T03:00:00'), startTrigger: 'idle', endTrigger: 'idle' },
  { start: t('2026-09-19T03:08:00'), end: t('2026-09-19T07:00:00'), startTrigger: 'idle', endTrigger: 'idle' },
];
const { results: fus } = evaluateGaps(fragmentada, MON);
assert('un fragmento de Doze no recorta la noche de la pantalla', fus.length === 1, fus.length);
assert(
  'y la noche conserva sus 7h30',
  fus.length === 1 && fus[0].session.end - fus[0].session.start === 7.5 * 3_600_000,
  fus.length === 1 && formatDuration(fus[0].session.end - fus[0].session.start),
);
assert(
  'con los dos disparadores como origen',
  fus.length === 1 && new Set(fus[0].session.triggers).size === 2,
  fus.length === 1 && fus[0].session.triggers,
);

// Un hueco imposible no es una noche dudosa: no se propone en absoluto.
// Salió del propio arreglo del disparador de pantalla: al liberarse un hueco
// que llevaba 21 horas clavado, se guardó como una noche de 21h 7m y la media
// de siete días pasó a decir «264% de la meta».
const huecoImposible: NativeGap[] = [
  { start: t('2026-09-19T00:33:00'), end: t('2026-09-19T22:00:00'), startTrigger: 'screen', endTrigger: 'screen' },
];
assert(
  'un hueco de 21h no llega a proponerse',
  evaluateGaps(huecoImposible, MON).results.length === 0,
  evaluateGaps(huecoImposible, MON).results.map((r) => formatDuration(r.gapMs)),
);
// Pero la franja dudosa sigue proponiéndose, que es para lo que está: 12h30
// pasa del máximo creíble que el usuario fija (aquí 12h) y no llega al techo
// de 13h, así que se propone con confianza baja para que la corrija en vez de
// descartarla.
const largaPeroPosible: NativeGap[] = [
  { start: t('2026-09-18T22:00:00'), end: t('2026-09-19T10:30:00'), startTrigger: 'screen', endTrigger: 'screen' },
];
const dudosa = evaluateGaps(largaPeroPosible, { ...MON, maxGapMinutes: 12 * 60 }).results;
assert('una noche larga pero creíble sí se propone', dudosa.length === 1, dudosa.length);
assert(
  'y se marca como dudosa para que se corrija',
  dudosa.length === 1 && dudosa[0].session.confidence === 'low',
  dudosa[0]?.session.confidence,
);

// Dos noches distintas siguen siendo dos: el agrupado salva interrupciones
// cortas, no días enteros.
const dosNoches: NativeGap[] = [
  { start: t('2026-09-17T23:30:00'), end: t('2026-09-18T07:00:00'), startTrigger: 'screen', endTrigger: 'screen' },
  { start: t('2026-09-18T23:30:00'), end: t('2026-09-19T07:00:00'), startTrigger: 'screen', endTrigger: 'screen' },
];
assert('dos noches separadas no se funden', evaluateGaps(dosNoches, MON).results.length === 2);

// Un disparador apagado después de registrar el hueco no propone nada.
const soloCargador: NativeGap[] = [
  { start: t('2026-09-18T23:30:00'), end: t('2026-09-19T07:00:00'), startTrigger: 'charger', endTrigger: 'charger' },
];
const apagado = evaluateGaps(soloCargador, { ...MON, triggers: { ...DEFAULT_TRIGGERS, charger: false } });
assert('un hueco de un disparador apagado se descarta', apagado.results.length === 0);
assert('y queda anotado el motivo', apagado.rejected[0]?.reason === 'trigger-off');

console.log(failures ? `\n${failures} comprobación(es) fallidas` : '\nTodo correcto');
process.exit(failures ? 1 : 0);
