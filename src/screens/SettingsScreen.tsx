import { useCallback, useEffect, useState } from 'react';
import { Card, Pill, Segmented, SelectField, Stepper, TimeField, Toggle } from '../components/ui';
import {
  currentPermission,
  notifyNow,
  notifySleepSummary,
  requestPermission,
  type PermissionState,
} from '../lib/notifications';
import {
  backgroundStatus,
  clearNativeEvents,
  isBackgroundAvailable,
  openAppSettings,
  openNotificationSettings,
  readNativeEvents,
  requestBatteryExemption,
  requestExactAlarms,
  simulateGap,
  type MonitorStatus,
} from '../lib/backgroundMonitor';
import {
  clearLog,
  describeEvent,
  eventTone,
  pushEvents,
  summarizeLog,
} from '../lib/triggerLog';
import { TRIGGERS, TRIGGER_SHORT, triggerEnabled } from '../lib/triggers';
import { HOUR, formatDuration, relativeDayLabel } from '../lib/time';
import { exportSessions, type ExportFormat } from '../lib/exportSessions';
import { useStore } from '../state/store';
import { useAppUpdate } from '../state/update';
import { UpdateBanner } from '../components/UpdateBanner';
import { APP_VERSION } from '../lib/updater';
import type { TriggerEvent, TriggerId } from '../lib/types';

export function SettingsScreen() {
  const { state, patch, dispatch } = useStore();
  const { monitor, theme } = state;
  const [permission, setPermission] = useState<PermissionState>('prompt');
  const [confirmReset, setConfirmReset] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [service, setService] = useState<MonitorStatus>({
    running: false,
    enabled: false,
    batteryExempt: false,
    notifications: false,
    exactAlarms: false,
    lastUsedAt: 0,
    startedAt: 0,
    aliveAt: 0,
    lastGapAt: 0,
    lastError: null,
  });
  const backgroundReady = isBackgroundAvailable();

  const doExport = (format: ExportFormat) => {
    setExportError(false);
    exportSessions(state.sessions, format).catch((e) => {
      // Cerrar la hoja de compartir sin elegir destino no es un error.
      if (!/cancel/i.test(String(e?.message ?? e))) setExportError(true);
    });
  };

  const refresh = () => {
    void currentPermission().then(setPermission);
    if (backgroundReady) void backgroundStatus().then(setService);
  };

  useEffect(() => {
    void currentPermission().then(setPermission);
  }, []);

  // El estado real del servicio puede diferir del ajuste si Android lo mató.
  useEffect(() => {
    if (!backgroundReady) return;
    void backgroundStatus().then(setService);
    const id = window.setInterval(() => void backgroundStatus().then(setService), 5000);
    return () => window.clearInterval(id);
  }, [backgroundReady, monitor.background, monitor.triggers]);

  // Los permisos se conceden en pantallas del sistema, fuera de la app, y nada
  // avisa de que han cambiado: al volver al primer plano hay que releerlos o el
  // diagnóstico seguiría pidiendo algo ya concedido.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundReady]);

  const setTrigger = (id: TriggerId, on: boolean) =>
    patch({ monitor: { ...monitor, triggers: { ...monitor.triggers, [id]: on } } });

  // El uso del dispositivo lo aporta el servicio nativo; el latido de la app
  // es el respaldo cuando no lo hay. Son medidas distintas y se etiquetan
  // como tales: confundirlas es lo que hacía parecer que sólo se detectaba
  // la apertura de la app.
  const deviceUseAt = Math.max(service.lastUsedAt, state.lastDeviceUseAt ?? 0) || null;
  const sinceDeviceUse = deviceUseAt ? Date.now() - deviceUseAt : null;
  const sinceBeat = state.lastActiveAt ? Date.now() - state.lastActiveAt : null;

  return (
    <>
      <Card title="Apariencia">
        <Segmented
          value={theme}
          label="Tema"
          options={[
            { value: 'dark' as const, label: 'Oscuro' },
            { value: 'light' as const, label: 'Claro' },
          ]}
          onChange={(v) => patch({ theme: v })}
        />
        <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 'var(--sp-3)', lineHeight: 1.55 }}>
          El tema oscuro reduce la luz azul al consultar la app de noche, justo cuando más conviene
          no espabilarse.
        </p>
      </Card>

      <PermissionsCard
        permission={permission}
        service={service}
        backgroundReady={backgroundReady}
        onRefresh={refresh}
        onSetPermission={setPermission}
      />

      <Card
        title="Detección automática del sueño"
        sub="Se deduce del tiempo que el dispositivo pasa sin usarse. Elige abajo qué señales quieres que la disparen."
        action={<Pill tone={monitor.enabled ? 'mint' : 'muted'}>{monitor.enabled ? 'Activa' : 'Apagada'}</Pill>}
      >
        <Toggle
          checked={monitor.enabled}
          onChange={(v) => patch({ monitor: { ...monitor, enabled: v } })}
          label="Detectar mis noches"
          hint="Interruptor general: apagarlo silencia todos los disparadores de abajo"
        />

        {monitor.enabled && (
          <>
            <div className="row">
              <div>
                <div className="row__label">Inactividad mínima</div>
                <div className="row__hint">Por debajo de este hueco se considera una siesta o un descuido</div>
              </div>
              <Stepper
                value={monitor.minGapMinutes}
                min={60}
                max={360}
                step={30}
                label="Inactividad mínima"
                onChange={(v) => patch({ monitor: { ...monitor, minGapMinutes: v } })}
                format={(v) => `${(v / 60).toFixed(v % 60 ? 1 : 0)} h`}
              />
            </div>

            <div className="row">
              <div>
                <div className="row__label">Ventana nocturna</div>
                <div className="row__hint">Franja en la que es plausible que estés durmiendo</div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', minWidth: 0 }}>
                <TimeField
                  value={monitor.nightStart}
                  label="Inicio de la ventana nocturna"
                  onChange={(v) => patch({ monitor: { ...monitor, nightStart: v } })}
                />
                <span style={{ color: 'var(--text-faint)' }}>–</span>
                <TimeField
                  value={monitor.nightEnd}
                  label="Fin de la ventana nocturna"
                  onChange={(v) => patch({ monitor: { ...monitor, nightEnd: v } })}
                />
              </div>
            </div>

            <Toggle
              checked={monitor.background}
              onChange={(v) => patch({ monitor: { ...monitor, background: v } })}
              label="Seguir detectando con la app cerrada"
              hint={
                backgroundReady
                  ? 'Necesario para los disparadores del dispositivo. Android obliga a mostrar una notificación permanente mientras está activo.'
                  : 'Disponible solo en la app instalada. En el navegador la detección ocurre al volver a abrirla.'
              }
            />

            <Toggle
              checked={monitor.wakeSummary}
              onChange={(v) => patch({ monitor: { ...monitor, wakeSummary: v } })}
              label="Avisarme con la estimación al despertar"
              hint={
                backgroundReady
                  ? 'En cuanto se cierre la noche recibirás una notificación con lo que has dormido, para confirmarlo de un toque sin abrir la app.'
                  : 'Disponible solo en la app instalada: el aviso lo emite el servicio, que es lo único despierto a esa hora.'
              }
            />

            {monitor.wakeSummary && (
              <div className="pending__actions">
                <button
                  className="btn btn--ghost"
                  onClick={() =>
                    void notifySleepSummary(Date.now() - 7.5 * HOUR, Date.now())
                  }
                  disabled={permission !== 'granted'}
                >
                  Ver cómo queda el aviso
                </button>
              </div>
            )}

            <Toggle
              checked={monitor.autoConfirm}
              onChange={(v) => patch({ monitor: { ...monitor, autoConfirm: v } })}
              label="Guardar sin preguntar"
              hint="Registra las sesiones detectadas directamente; podrás corregirlas en el historial"
            />

            <div className="row">
              <div>
                <div className="row__label">Último uso del móvil</div>
                <div className="row__hint">
                  Lo que de verdad mide la detección: cuándo desbloqueaste el dispositivo, lo
                  abrieras o no en PerfectRest
                </div>
              </div>
              <Pill tone={sinceDeviceUse === null ? 'muted' : 'primary'}>
                {sinceDeviceUse === null
                  ? backgroundReady
                    ? 'sin datos'
                    : 'no disponible'
                  : `hace ${formatDuration(sinceDeviceUse)}`}
              </Pill>
            </div>

            <div className="row">
              <div>
                <div className="row__label">Última apertura de la app</div>
                <div className="row__hint">
                  El respaldo cuando no hay servicio: el hueco entre dos aperturas
                </div>
              </div>
              <Pill tone="muted">
                {sinceBeat === null ? 'sin datos' : `hace ${formatDuration(sinceBeat)}`}
              </Pill>
            </div>
          </>
        )}
      </Card>

      {monitor.enabled && (
        <Card
          title="Disparadores"
          sub="Qué señales pueden marcar el principio y el final de una noche. Cuando dos coinciden sobre el mismo hueco, la sesión se propone con más confianza."
        >
          {TRIGGERS.map((trigger) => {
            const available = !trigger.native || backgroundReady;
            const on = triggerEnabled(monitor, trigger.id);
            return (
              <div key={trigger.id} style={{ opacity: available ? 1 : 0.55 }}>
                <Toggle
                  checked={available && on}
                  onChange={(v) => available && setTrigger(trigger.id, v)}
                  label={trigger.label}
                  hint={
                    available
                      ? trigger.hint
                      : `${trigger.hint} Requiere la app instalada.`
                  }
                />
              </div>
            );
          })}

          {backgroundReady && !monitor.background && (
            <p style={{ fontSize: '0.76rem', color: 'var(--amber)', lineHeight: 1.55 }}>
              Con «seguir detectando con la app cerrada» apagado, los disparadores del
              dispositivo no se evalúan aunque estén activos aquí.
            </p>
          )}
        </Card>
      )}

      {monitor.enabled && <TriggerLogCard backgroundReady={backgroundReady} />}

      <UpdateCard />

      <Card title="Tus datos" sub="Todo se guarda solo en este dispositivo. No hay cuenta ni servidor.">
        <div className="row">
          <div>
            <div className="row__label">Noches registradas</div>
          </div>
          <Pill tone="primary">{state.sessions.length}</Pill>
        </div>
        <div className="pending__actions" style={{ marginTop: 'var(--sp-3)' }}>
          <button
            className="btn btn--ghost"
            disabled={state.sessions.length === 0}
            onClick={() => doExport('csv')}
          >
            Exportar CSV
          </button>
          <button
            className="btn btn--ghost"
            disabled={state.sessions.length === 0}
            onClick={() => doExport('json')}
          >
            Exportar JSON
          </button>
        </div>
        {exportError && (
          <p style={{ fontSize: '0.76rem', color: 'var(--amber)', marginTop: 'var(--sp-2)' }}>
            No se pudo exportar. Inténtalo de nuevo.
          </p>
        )}
        {confirmReset ? (
          <div className="pending__actions">
            <button className="btn btn--ghost" onClick={() => setConfirmReset(false)}>
              Cancelar
            </button>
            <button
              className="btn btn--danger"
              onClick={() => {
                dispatch({ type: 'reset' });
                setConfirmReset(false);
              }}
            >
              Sí, borrar todo
            </button>
          </div>
        ) : (
          <button
            className="btn btn--ghost btn--full"
            style={{ marginTop: 'var(--sp-3)' }}
            onClick={() => setConfirmReset(true)}
          >
            Restablecer la aplicación
          </button>
        )}
      </Card>

      <p style={{ fontSize: '0.72rem', color: 'var(--text-faint)', textAlign: 'center', lineHeight: 1.6 }}>
        PerfectRest · Las estimaciones de ciclos son orientativas y no sustituyen el criterio
        médico. Si el insomnio persiste, consulta con un profesional.
      </p>
    </>
  );
}

/**
 * Registro de la detección.
 *
 * Responde a la única pregunta que el usuario se hace cuando la app no
 * propone nada: ¿está llegando alguna señal? Hasta ahora no había forma de
 * saberlo —los disparadores no fallan, simplemente no producen nada— y el
 * diagnóstico se quedaba en los permisos, que pueden estar todos concedidos y
 * aun así no llegar un solo evento.
 *
 * Cada línea es una señal recibida, un hueco encolado o un descarte con su
 * motivo, del servicio nativo y de la propia app mezclados en orden. El botón
 * de prueba inyecta un hueco real por el disparador elegido: recorre la misma
 * tubería que uno de verdad, así que si la prueba acaba en «sesión propuesta»
 * lo que falla es la señal del sistema, no la app.
 */
function TriggerLogCard({ backgroundReady }: { backgroundReady: boolean }) {
  const [log, setLog] = useState<TriggerEvent[]>([]);
  const [probe, setProbe] = useState<TriggerId>('screen');
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLog(await pushEvents(await readNativeEvents()));
  }, []);

  useEffect(() => {
    void reload();
    // Con la app abierta el servicio sigue anotando: el registro tiene que
    // refrescarse solo o el usuario vería una foto fija mientras prueba.
    const id = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(id);
  }, [reload]);

  const summary = summarizeLog(log);
  const sinceSignal = summary.lastSignalAt ? Date.now() - summary.lastSignalAt : null;

  const runProbe = async () => {
    const ok = await simulateGap(probe, 480);
    setNotice(
      ok
        ? 'Hueco de 8 h inyectado. Debería aparecer abajo y proponerse como sesión en unos segundos.'
        : 'La prueba necesita la app instalada: en el navegador no hay servicio donde inyectar el hueco.',
    );
    await reload();
  };

  return (
    <Card
      title="Registro de detección"
      sub="Qué señales han llegado y qué se ha hecho con cada una. Es donde mirar cuando no se detecta nada."
      action={
        <Pill tone={summary.lastSignalAt ? 'mint' : 'amber'}>
          {summary.total ? `${summary.total} eventos` : 'vacío'}
        </Pill>
      }
    >
      <div className="row">
        <div>
          <div className="row__label">Última señal del dispositivo</div>
          <div className="row__hint">
            Si hace días que no llega ninguna, el problema no es que no duermas: es que nadie
            está escuchando.
          </div>
        </div>
        <Pill tone={sinceSignal === null ? 'amber' : 'primary'}>
          {sinceSignal === null ? 'ninguna' : `hace ${formatDuration(sinceSignal)}`}
        </Pill>
      </div>

      <div className="row">
        <div>
          <div className="row__label">Disparadores con señales</div>
          <div className="row__hint">
            Los que han dado alguna señal de vida, no los que están activados
          </div>
        </div>
        <Pill tone={summary.activeTriggers.length ? 'mint' : 'muted'}>
          {summary.activeTriggers.length
            ? summary.activeTriggers.map((id) => TRIGGER_SHORT[id]).join(', ')
            : 'ninguno'}
        </Pill>
      </div>

      <div className="row">
        <div>
          <div className="row__label">Huecos y sesiones</div>
          <div className="row__hint">Cuántos huecos se han registrado y cuántos han llegado a propuesta</div>
        </div>
        <Pill tone="muted">
          {summary.gaps} / {summary.detections}
        </Pill>
      </div>

      <div className="row">
        <div>
          <div className="row__label">Probar un disparador</div>
          <div className="row__hint">
            Inyecta un hueco de 8 h como si esa señal lo hubiera medido. Comprueba la app entera
            sin esperar a la noche.
          </div>
        </div>
        <SelectField
          value={probe}
          label="Disparador a probar"
          onChange={setProbe}
          options={TRIGGERS.filter((t) => t.native).map((t) => ({
            value: t.id,
            label: TRIGGER_SHORT[t.id],
          }))}
        />
      </div>

      <div className="pending__actions">
        <button className="btn btn--ghost" onClick={() => void runProbe()} disabled={!backgroundReady}>
          Lanzar prueba
        </button>
        <button
          className="btn btn--ghost"
          onClick={() =>
            void (async () => {
              await clearLog();
              await clearNativeEvents();
              setNotice(null);
              await reload();
            })()
          }
        >
          Vaciar registro
        </button>
      </div>

      {notice && (
        <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>{notice}</p>
      )}

      {!backgroundReady && (
        <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
          En el navegador sólo se registra el disparador de apertura de la app. Los del
          dispositivo necesitan la app instalada.
        </p>
      )}

      {log.length === 0 ? (
        <p style={{ fontSize: '0.76rem', color: 'var(--text-faint)', lineHeight: 1.55 }}>
          Todavía no hay nada. Con la detección activa deberían aparecer señales en cuanto
          bloquees el móvil un rato.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 'var(--sp-3) 0 0',
            padding: 0,
            display: 'grid',
            gap: 'var(--sp-2)',
            maxHeight: '18rem',
            overflowY: 'auto',
          }}
        >
          {log.slice(0, 40).map((event, i) => (
            <li
              key={`${event.at}-${event.kind}-${i}`}
              style={{
                display: 'flex',
                gap: 'var(--sp-2)',
                alignItems: 'baseline',
                fontSize: '0.74rem',
                lineHeight: 1.5,
                color: 'var(--text-muted)',
              }}
            >
              <Pill tone={eventTone(event.kind)}>{event.native ? 'móvil' : 'app'}</Pill>
              <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
                {relativeDayLabel(event.at)} · {describeEvent(event)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Diagnóstico de permisos.
 *
 * Los disparadores del dispositivo dependen de tres cosas que Android concede
 * fuera de la app —notificaciones, alarmas exactas y exención de batería— y que
 * puede retirar sin avisar. Ninguna falla con un error: sin ellas la detección
 * simplemente no registra nada, que desde fuera es idéntico a una noche sin
 * señal. Ésta es la pantalla donde se distingue una cosa de la otra, y por eso
 * cada línea lleva su propio atajo a los ajustes del sistema en vez de un
 * consejo genérico.
 */
function PermissionsCard({
  permission,
  service,
  backgroundReady,
  onRefresh,
  onSetPermission,
}: {
  permission: PermissionState;
  service: MonitorStatus;
  backgroundReady: boolean;
  onRefresh: () => void;
  onSetPermission: (p: PermissionState) => void;
}) {
  // El permiso puede estar concedido y las notificaciones de la app apagadas
  // desde los ajustes del sistema: para el usuario el resultado es el mismo.
  const notificationsOk =
    permission === 'granted' && (!backgroundReady || service.notifications);

  const checks: {
    key: string;
    label: string;
    hint: string;
    ok: boolean;
    action?: { label: string; run: () => void };
  }[] = [
    {
      key: 'notifications',
      label: 'Notificaciones',
      hint: 'Los recordatorios de acostarte, el aviso al despertar y la notificación que mantiene vivo el servicio.',
      ok: notificationsOk,
      action:
        permission === 'prompt'
          ? { label: 'Conceder', run: () => void requestPermission().then(onSetPermission) }
          : permission === 'unsupported'
            ? undefined
            : {
                // Tras la segunda negativa Android ya no muestra el diálogo, así
                // que volver a pedirlo desde aquí no haría absolutamente nada.
                label: notificationsOk ? 'Ajustar' : 'Abrir ajustes',
                run: () => void openNotificationSettings(),
              },
    },
  ];

  if (backgroundReady) {
    checks.push(
      {
        key: 'battery',
        label: 'Sin optimización de batería',
        hint: 'Con la optimización activa, Android para el servicio de madrugada y la noche entera se pierde. Es la causa más común de que no se detecte nada.',
        ok: service.batteryExempt,
        action: service.batteryExempt
          ? undefined
          : { label: 'Desactivar', run: () => void requestBatteryExemption() },
      },
      {
        key: 'alarms',
        label: 'Alarmas exactas',
        hint: 'El servicio se rearma con una alarma cada 15 minutos. Sin permiso se degrada a inexacta y Doze puede retrasarla horas, justo mientras duermes.',
        ok: service.exactAlarms,
        action: service.exactAlarms
          ? undefined
          : { label: 'Permitir', run: () => void requestExactAlarms() },
      },
      {
        key: 'service',
        label: 'Servicio en marcha',
        hint: service.aliveAt
          ? `Última señal de vida hace ${formatDuration(Date.now() - service.aliveAt)}.`
          : 'Todavía no ha dado señales de vida. Abre y cierra la app una vez.',
        ok: service.running,
      },
    );
  }

  const failing = checks.filter((c) => !c.ok).length;

  return (
    <Card
      title="Permisos y estado de la detección"
      sub="Todo lo que la detección necesita del sistema. Si algo falta, no falla con un error: simplemente deja de registrar noches."
      action={
        <Pill tone={failing ? 'amber' : 'mint'}>
          {failing ? `${failing} pendiente${failing > 1 ? 's' : ''}` : 'todo listo'}
        </Pill>
      }
    >
      {checks.map((check) => (
        <div className="row" key={check.key}>
          <div>
            <div className="row__label">
              {check.ok ? '✓' : '!'} {check.label}
            </div>
            <div className="row__hint">{check.hint}</div>
          </div>
          {check.action ? (
            <button
              className={check.ok ? 'btn btn--ghost' : 'btn btn--primary'}
              onClick={() => {
                check.action?.run();
                // La pantalla del sistema es otra actividad: el estado nuevo se
                // relee al volver, pero un refresco aquí cubre los diálogos que
                // se resuelven sin salir de la app.
                window.setTimeout(onRefresh, 500);
              }}
            >
              {check.action.label}
            </button>
          ) : (
            <Pill tone={check.ok ? 'mint' : 'rose'}>{check.ok ? 'ok' : 'falta'}</Pill>
          )}
        </div>
      ))}

      {service.lastError && (
        <p style={{ fontSize: '0.78rem', color: 'var(--amber)', lineHeight: 1.55, marginTop: 'var(--sp-3)' }}>
          Último problema del servicio: {service.lastError}
        </p>
      )}

      {backgroundReady && service.lastGapAt > 0 && (
        <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 'var(--sp-3)' }}>
          Última noche detectada hace {formatDuration(Date.now() - service.lastGapAt)}.
        </p>
      )}

      <div className="pending__actions">
        <button
          className="btn btn--ghost"
          onClick={() => void notifyNow('PerfectRest', 'Así se verán tus recordatorios.')}
          disabled={permission !== 'granted'}
        >
          Probar aviso
        </button>
        <button className="btn btn--ghost" onClick={onRefresh}>
          Volver a comprobar
        </button>
        {backgroundReady && (
          <button className="btn btn--ghost" onClick={() => void openAppSettings()}>
            Ajustes del sistema
          </button>
        )}
      </div>
    </Card>
  );
}

/**
 * Comprobación manual de actualizaciones.
 *
 * No es un adorno. La comprobación automática del arranque calla sus errores a
 * propósito —sin cobertura la app no debe molestar—, y el precio de ese diseño
 * es que un fallo real se ve exactamente igual que «no hay novedades». Ésta es
 * la única forma de distinguir «estás al día» de «el canal está roto», y dice
 * el error exacto cuando lo hay.
 */
function UpdateCard() {
  const update = useAppUpdate();

  if (!update.supported) {
    return (
      <Card title="Versión" sub="La actualización automática solo funciona en la app instalada.">
        <div className="row">
          <div className="row__label">Versión instalada</div>
          <Pill tone="muted">{update.installed || APP_VERSION}</Pill>
        </div>
      </Card>
    );
  }

  const status =
    update.phase === 'checking'
      ? { tone: 'muted' as const, text: 'comprobando…' }
      : update.phase === 'error'
        ? { tone: 'rose' as const, text: 'error' }
        : update.available
          ? { tone: 'primary' as const, text: 'hay versión nueva' }
          : update.phase === 'uptodate'
            ? { tone: 'mint' as const, text: 'al día' }
            : { tone: 'muted' as const, text: 'sin comprobar' };

  return (
    <Card
      title="Actualizaciones"
      sub="Se publican como releases de GitHub y se comprueban al abrir la app."
      action={<Pill tone={status.tone}>{status.text}</Pill>}
    >
      <div className="row">
        <div className="row__label">Versión instalada</div>
        <Pill tone="muted">{update.installed || APP_VERSION}</Pill>
      </div>

      {update.release && (
        <div className="row">
          <div className="row__label">Última publicada</div>
          <Pill tone={update.available ? 'primary' : 'muted'}>{update.release.versionName}</Pill>
        </div>
      )}

      {update.error && (
        <p style={{ fontSize: '0.78rem', color: 'var(--rose)', lineHeight: 1.55 }}>
          {update.error}
        </p>
      )}

      <div className="pending__actions">
        <button
          className="btn btn--ghost btn--full"
          onClick={() => void update.check(true)}
          disabled={update.phase === 'checking' || update.phase === 'downloading'}
        >
          {update.phase === 'checking' ? 'Comprobando…' : 'Buscar actualizaciones'}
        </button>
      </div>

      {update.available && <UpdateBanner update={update} />}
    </Card>
  );
}
