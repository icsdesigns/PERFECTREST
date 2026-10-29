package com.perfectrest.app;

import android.app.AlarmManager;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Monitorización del uso del dispositivo en segundo plano.
 *
 * Android sólo entrega ACTION_SCREEN_OFF, ACTION_USER_PRESENT y los eventos de
 * carga a receptores registrados en código, no en el manifiesto, y sólo
 * mientras un componente de la app siga vivo. Por eso hace falta un servicio
 * en primer plano: es la única forma de seguir escuchando esos eventos
 * mientras el usuario duerme y la app está cerrada.
 *
 * De esas difusiones no se puede fiar uno por igual. SCREEN_ON y SCREEN_OFF
 * llegan siempre; USER_PRESENT hay dispositivos donde no llega nunca, y el
 * disparador de pantalla dependía sólo de él para cerrar el hueco. Por eso el
 * regreso del usuario se decide consultando el cerrojo —estado del sistema,
 * que siempre se puede preguntar— y no esperando una señal que puede no venir.
 * Ver {@link #watchForUnlock()}.
 *
 * Se registran cuatro disparadores independientes, cada uno activable desde
 * los ajustes de la app:
 *
 *   screen   SCREEN_OFF            -> se quita el cerrojo      (lo suelta / vuelve)
 *   charger  POWER_CONNECTED       -> POWER_DISCONNECTED      (lo enchufa / lo suelta)
 *   idle     entra en Doze         -> sale de Doze            (el sistema lo da por quieto)
 *   dnd      «No molestar» activo  -> «No molestar» apagado   (se va a dormir)
 *
 * Van por separado porque cada uno se rompe por su lado: la pantalla no dice
 * nada de quien duerme sin bloqueo seguro, el cargador no sirve a quien no
 * carga de noche, Doze no llega si el móvil recibe notificaciones toda la
 * madrugada y «No molestar» sólo existe si el usuario lo usa. Lo que uno
 * pierde, otro lo cubre; y cuando dos coinciden sobre la misma noche, la capa
 * web propone la sesión con más confianza.
 *
 * El hueco entre los dos extremos es tiempo real sin usar el móvil, mucho más
 * preciso que deducirlo de cuándo se abre la app. Cuando supera el umbral
 * configurado se encola, etiquetado con el disparador que lo abrió y el que lo
 * cerró, para que la capa web lo evalúe como posible sesión de sueño. El
 * servicio no decide nada, sólo mide.
 *
 * Todo lo que ocurre —cada señal recibida, cada hueco encolado y cada descarte
 * con su motivo— queda además en un registro circular que la app muestra en
 * Ajustes. Sin él, «no se detectó nada» y «el servicio llevaba semanas muerto»
 * se ven exactamente igual desde fuera.
 *
 * Mantenerse vivo es la otra mitad del trabajo: START_STICKY no cubre que el
 * usuario deslice la app fuera de recientes ni que el sistema mate el proceso
 * de madrugada, así que el servicio se rearma con una alarma exacta periódica.
 * Sin eso, la detección se apagaba silenciosamente y sólo volvía a haber datos
 * al abrir la app, que es justo lo que se quería evitar.
 *
 * El final de la noche es el primer **uso sostenido**, no el primer desbloqueo.
 * Mirar la hora a las seis de la mañana, o parar una alarma, son desbloqueos de
 * segundos tras los cuales se sigue durmiendo, y tomarlos por el final partía
 * la noche y inflaba la mañana. Un desbloqueo sólo cierra el hueco si el uso
 * se sostiene (pantalla en uso {@link #SUSTAINED_USE_MS} o varios desbloqueos
 * seguidos); los demás quedan anotados como micro-despertares dentro del hueco,
 * y la capa web decide qué hacer con ellos. Ver {@link #screenInUse(long)}.
 *
 * Junto a los disparadores, un {@link SensorWatcher} opcional registra pasos,
 * luz, proximidad, alarma, audio y postura del móvil en el registro bruto ({@link RawEventLog}),
 * que la capa web cruza con cada hueco para afinar los bordes de la noche.
 *
 * Todo lo que puede fallar por un permiso que falta —entrar en primer plano,
 * programar la alarma exacta, publicar una notificación— queda anotado en
 * {@link #KEY_LAST_ERROR} en vez de morir en silencio: es lo único que
 * distingue «anoche no dejaste señal» de «el servicio llevaba semanas sin
 * arrancar».
 */
public class SleepMonitorService extends Service {

    public static final String PREFS = "perfectrest.monitor";
    public static final String KEY_LAST_USED = "lastUsedAt";
    public static final String KEY_GAPS = "pendingGaps";
    public static final String KEY_ENABLED = "serviceEnabled";
    public static final String KEY_MIN_GAP = "minGapMinutes";
    /** Disparadores activos, separados por comas: "screen,charger". */
    public static final String KEY_TRIGGERS = "triggers";
    /** Registro circular de eventos, en JSON, que la app lee y muestra. */
    public static final String KEY_EVENTS = "triggerEvents";

    /** Instante en que el servicio entró en primer plano por última vez. */
    public static final String KEY_STARTED_AT = "startedAt";
    /**
     * Latido del servicio: se refresca al arrancar y con cada evento recibido.
     * Es lo que permite saber si sigue vivo de verdad, sin depender de
     * getRunningServices, que informa de un proceso que puede llevar horas sin
     * recibir nada.
     */
    public static final String KEY_ALIVE_AT = "aliveAt";
    /** Última razón por la que el servicio no pudo hacer su trabajo. */
    public static final String KEY_LAST_ERROR = "lastError";
    /** Instante del último hueco encolado, para el diagnóstico de Ajustes. */
    public static final String KEY_LAST_GAP_AT = "lastGapAt";

    /** Sensores opcionales activos, separados por comas: "steps,light". */
    public static final String KEY_SENSORS = "sensors";
    /** «Registrar todos los sensores disponibles» (por defecto sí). */
    public static final String KEY_ALL_SENSORS = "allSensors";

    /**
     * Estado del uso de pantalla con un hueco largo abierto: el primer
     * desbloqueo del grupo (el candidato a final), la última vez que se apagó la
     * pantalla, cuánto se ha usado en total, cuántos desbloqueos, desde cuándo
     * está en uso ahora (0 si apagada) y los micro-despertares ya descartados.
     */
    public static final String KEY_WAKE_FIRST = "wakeFirstAt";
    public static final String KEY_WAKE_LAST_OFF = "wakeLastOffAt";
    public static final String KEY_WAKE_USE = "wakeUseMs";
    public static final String KEY_WAKE_UNLOCKS = "wakeUnlocks";
    public static final String KEY_WAKE_ON = "wakeOnSince";
    public static final String KEY_WAKES = "wakes";

    /** Aviso con la estimación del sueño al despertar (Módulo 3). */
    public static final String KEY_SUMMARY = "wakeSummary";
    /** Ventana nocturna en minutos desde medianoche, para filtrar ese aviso. */
    public static final String KEY_NIGHT_START = "nightStartMin";
    public static final String KEY_NIGHT_END = "nightEndMin";

    public static final String TRIGGER_SCREEN = "screen";
    public static final String TRIGGER_CHARGER = "charger";
    public static final String TRIGGER_IDLE = "idle";
    public static final String TRIGGER_DND = "dnd";

    /** Los cuatro disparadores que este servicio sabe escuchar. */
    public static final String[] NATIVE_TRIGGERS = {
        TRIGGER_SCREEN, TRIGGER_CHARGER, TRIGGER_IDLE, TRIGGER_DND
    };

    /**
     * Instante en que cada disparador abrió su hueco, uno por disparador.
     *
     * Antes había una clave por señal (`screenOffAt`, `pluggedAt`), lo que
     * obligaba a duplicar el par abrir/cerrar cada vez que se añadía una
     * nueva. Con la clave derivada del identificador, añadir un disparador es
     * añadir su acción al filtro y nada más.
     */
    public static String openKey(String trigger) {
        return "openAt." + trigger;
    }

    /**
     * Instante en que cada disparador cerró un hueco por debajo del mínimo, y
     * el instante en que ese hueco se había abierto.
     *
     * Existen para poder deshacer un cierre que resultó no serlo. Una pantalla
     * que se enciende con una notificación, o un Doze que sale a su ventana de
     * mantenimiento, cerraban el hueco de la noche a las dos de la mañana y lo
     * reabrían a los pocos segundos: la noche entera se descartaba en trozos de
     * hora y media y no quedaba nada que proponer. Si la interrupción dura
     * menos de {@link #REOPEN_GRACE_MS} (con la pantalla, menos de un uso
     * sostenido: ver {@link #canResume}), el hueco se reanuda desde donde
     * estaba en vez de empezar de cero.
     */
    public static String shortOpenKey(String trigger) {
        return "shortOpenAt." + trigger;
    }

    public static String shortCloseKey(String trigger) {
        return "shortCloseAt." + trigger;
    }

    /**
     * ¿Fue breve la interrupción, para reanudar el hueco en vez de abrir otro?
     *
     * Con la pantalla, `elapsed` es lo que estuvo encendida: desde el
     * desbloqueo que cerró el hueco hasta que se apagó otra vez. Un vistazo o
     * una notificación (segundos) no parten la noche, pero un uso sostenido
     * ({@link #SUSTAINED_USE_MS}, lo mismo que el servicio da por el final de
     * una noche) sí: lo anterior no es sueño, y reanudar desde el borde viejo
     * ponía el inicio antes del último uso real del móvil. Los demás
     * disparadores no miden uso y conservan el margen largo.
     */
    static boolean canResume(String trigger, long elapsedMs) {
        long grace = TRIGGER_SCREEN.equals(trigger) ? SUSTAINED_USE_MS : REOPEN_GRACE_MS;
        return elapsedMs <= grace;
    }

    /** Instante del último aviso «has dormido X», para no repetirlo. */
    public static final String KEY_LAST_SUMMARY_AT = "lastSummaryAt";

    /**
     * Comentarios escritos desde el aviso «has dormido X», en JSON. Esperan
     * aquí a que la capa web los adjunte a la sesión: cuando el usuario
     * contesta, la noche sólo existe como hueco en la cola, todavía no como
     * sesión.
     */
    public static final String KEY_NOTES = "sessionNotes";

    /** Acción del botón «Comentar» del aviso, que atiende {@link SessionNoteReceiver}. */
    public static final String ACTION_ADD_NOTE = "com.perfectrest.app.ADD_SESSION_NOTE";
    public static final String EXTRA_START = "start";
    public static final String EXTRA_END = "end";
    /** Clave del texto escrito en la respuesta en línea. */
    public static final String REMOTE_INPUT_NOTE = "note";

    /** Alias histórico: el hueco abierto por la pantalla, que el plugin expone. */
    public static final String KEY_SCREEN_OFF_AT = "openAt." + TRIGGER_SCREEN;

    /** Acción con la que la alarma de vigilancia vuelve a levantar el servicio. */
    public static final String ACTION_RESTART = "com.perfectrest.app.RESTART_MONITOR";

    private static final String CHANNEL_ID = "perfectrest-monitor";
    /** Canal del resumen al despertar: éste sí debe verse y avisar. */
    public static final String SUMMARY_CHANNEL_ID = "perfectrest-summary";
    private static final int NOTIFICATION_ID = 4711;
    static final int SUMMARY_NOTIFICATION_ID = 4712;
    /** Tope de comentarios en espera: los que nunca encuentren su noche caducan. */
    private static final int MAX_NOTES = 30;
    /** Tope de huecos guardados: si la app no se abre en semanas, no crece sin fin. */
    private static final int MAX_GAPS = 60;
    /** Tope del registro de eventos. Cubre varios días sin crecer sin fin. */
    private static final int MAX_EVENTS = 200;
    /**
     * Uso de pantalla a partir del cual un desbloqueo deja de ser un
     * micro-despertar y pasa a ser el final de la noche. Mirar la hora o parar
     * una alarma son segundos; leer o contestar mensajes son minutos.
     */
    private static final long SUSTAINED_USE_MS = 5 * 60_000L;
    /** Desbloqueos seguidos que, aun siendo breves, también cuentan como despertar. */
    private static final int SUSTAINED_UNLOCKS = 3;
    /** Dos desbloqueos separados por más de esto pertenecen a usos distintos. */
    private static final long WAKE_CLUSTER_GAP_MS = 20 * 60_000L;
    /** Tope de micro-despertares guardados por hueco. */
    private static final int MAX_WAKES = 24;
    /** Cada cuánto comprueba la alarma que el servicio sigue vivo. */
    private static final long WATCHDOG_INTERVAL_MS = 15 * 60_000L;
    /**
     * Cuánto puede durar una interrupción sin partir la noche en dos.
     *
     * Cubre lo que de verdad interrumpe un sueño sin terminarlo: una ventana
     * de mantenimiento de Doze (minutos), una notificación que enciende la
     * pantalla (segundos) o una ida al baño. Pasado ese margen se da por
     * terminado el hueco, que es lo que debe ocurrir con un despertar real.
     */
    private static final long REOPEN_GRACE_MS = 15 * 60_000L;
    /**
     * Ventana en la que no se repite el aviso del despertar. Dos disparadores
     * que cierran la misma mañana describen una noche, no dos.
     */
    private static final long SUMMARY_DEDUPE_MS = 6 * 60 * 60_000L;

    /** ¿Ha llegado el servicio a entrar en primer plano en esta vida? */
    private boolean foregrounded = false;

    private BroadcastReceiver receiver;
    /** Cambios raros del sistema (modo avión, timbre, ahorro de energía, cargador) para el contexto de la noche. */
    private BroadcastReceiver contextReceiver;
    private SensorWatcher sensorWatcher;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        createSummaryChannel();
        startInForeground();
        registerDeviceReceiver();
        registerContextReceiver();
        applySensors();
        primeScreenState();
        ContextSampler.sample(this, true);
        scheduleWatchdog(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        prefs().edit()
            .putBoolean(KEY_ENABLED, true)
            .putLong(KEY_ALIVE_AT, System.currentTimeMillis())
            .apply();
        // Los ajustes pueden haber cambiado entre dos arranques (el usuario
        // activa o desactiva un disparador), así que se vuelve a registrar.
        registerDeviceReceiver();
        registerContextReceiver();
        applySensors();
        // Cada rearme es también una oportunidad de darse cuenta de que la
        // señal de vuelta se perdió y el hueco lleva horas sin poder cerrarse.
        healStuckGap(System.currentTimeMillis());
        // El vigilante pasa cada quince minutos (diez de noche con el sensor de postura):
        // es un momento barato para preguntar por la alarma y el audio, y para
        // una lectura de postura, sin ningún temporizador propio.
        if (sensorWatcher != null) sensorWatcher.sample();
        // Pasa al archivo histórico lo que ya se asentó en el registro bruto.
        RawEventLog.archivePending(this);
        // Y de anotar el resto de parámetros del sistema que cambiaron desde la última vez.
        ContextSampler.sample(this, true);
        scheduleWatchdog(this);
        // START_STICKY: si el sistema mata el servicio por memoria, lo recrea.
        return START_STICKY;
    }

    /**
     * El usuario ha deslizado la app fuera de recientes. En la mayoría de ROMs
     * eso mata el proceso entero, servicio incluido: se programa el rearranque
     * inmediato para no perder la noche.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (prefs().getBoolean(KEY_ENABLED, false)) {
            scheduleRestart(this, 2_000L);
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        unregisterDeviceReceiver();
        unregisterContextReceiver();
        stopWatchingForUnlock();
        wakeWatch.removeCallbacksAndMessages(null);
        if (sensorWatcher != null) sensorWatcher.stopAll();
        RawEventLog.flush(this);
        // Si el servicio muere sin que el usuario lo haya apagado, la alarma
        // pendiente lo devolverá a la vida en el próximo ciclo. Que se anote
        // es la única forma de ver después cuántas veces lo mató el sistema
        // durante la noche, que es la causa más común de no detectar nada.
        if (prefs().getBoolean(KEY_ENABLED, false)) {
            // Si el servicio ni siquiera llegó a primer plano, reintentar cada
            // cinco segundos es un bucle que no arregla nada y se come la
            // batería: lo que falta es un permiso, y eso no cambia en cinco
            // segundos. Se espacia el reintento al ritmo del vigilante.
            long delay = foregrounded ? 5_000L : WATCHDOG_INTERVAL_MS;
            logEvent(this, null, "service",
                "detenido por el sistema; se rearma en " + formatDuration(delay));
            scheduleRestart(this, delay);
        } else {
            logEvent(this, null, "service", "detenido por el usuario");
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean triggerOn(String id) {
        String raw = prefs().getString(KEY_TRIGGERS, TRIGGER_SCREEN);
        for (String part : raw.split(",")) {
            if (part.trim().equals(id)) return true;
        }
        return false;
    }

    /** Sensores opcionales que el usuario tiene activos. */
    private Set<String> wantedSensors() {
        Set<String> out = new HashSet<>();
        String raw = prefs().getString(KEY_SENSORS, "");
        for (String part : raw.split(",")) {
            String id = part.trim();
            if (!id.isEmpty()) out.add(id);
        }
        return out;
    }

    private void applySensors() {
        if (sensorWatcher == null) {
            sensorWatcher = new SensorWatcher(this);
            // El inventario de sensores va al archivo histórico una vez por arranque del proceso.
            if (HistoryArchive.enabled(this)) {
                try {
                    HistoryArchive.forContext(this).putInventory(SensorCatalog.inventory(
                        (android.hardware.SensorManager) getSystemService(SENSOR_SERVICE)));
                } catch (java.io.IOException | RuntimeException ignored) {
                    // Sin inventario archivado el export lo vuelve a pedir al sistema.
                }
            }
        }
        sensorWatcher.setContextExtras(ContextSampler.enabled(this));
        sensorWatcher.setAllSensors(prefs().getBoolean(KEY_ALL_SENSORS, true));
        sensorWatcher.apply(wantedSensors());
    }

    /** Deja constancia de un fallo para que Ajustes pueda explicarlo. */
    private void recordError(String message) {
        prefs().edit().putString(KEY_LAST_ERROR, message).apply();
        logEvent(this, null, "error", message);
    }

    private void clearError() {
        prefs().edit().remove(KEY_LAST_ERROR).apply();
    }

    // --- Registro de eventos ---

    /**
     * Anota un evento en el registro circular.
     *
     * Es estático y toma el contexto porque también lo usan el receptor de
     * arranque y el plugin: el rearranque fallido tras una actualización es
     * justo el caso que hay que poder leer después, y ahí el servicio no
     * existe todavía.
     *
     * Escribe siempre, aunque el disparador esté apagado o falte un permiso:
     * el registro debe poder explicar por qué no pasó nada, y para eso tiene
     * que anotar precisamente lo que no pasó.
     */
    static void logEvent(Context context, String trigger, String kind, String detail) {
        SharedPreferences p =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        JSONArray events;
        try {
            events = new JSONArray(p.getString(KEY_EVENTS, "[]"));
        } catch (JSONException e) {
            events = new JSONArray();
        }

        try {
            JSONObject event = new JSONObject();
            event.put("at", System.currentTimeMillis());
            // JSONObject.put(String, null) borra la clave, que es justo lo que
            // se quiere: la web lee el disparador ausente como `null`.
            event.put("trigger", trigger);
            event.put("kind", kind);
            if (detail != null) event.put("detail", detail);
            event.put("native", true);
            events.put(event);
        } catch (JSONException e) {
            return;
        }

        while (events.length() > MAX_EVENTS) {
            events.remove(0);
        }
        p.edit().putString(KEY_EVENTS, events.toString()).apply();
    }

    // --- Ciclo de vida en primer plano ---

    private void startInForeground() {
        long now = System.currentTimeMillis();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14 exige declarar el tipo al entrar en primer plano, no
                // sólo en el manifiesto.
                startForeground(
                    NOTIFICATION_ID,
                    buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                );
            } else {
                startForeground(NOTIFICATION_ID, buildNotification());
            }
            foregrounded = true;
            prefs().edit()
                .putLong(KEY_STARTED_AT, now)
                .putLong(KEY_ALIVE_AT, now)
                .apply();
            clearError();
            logEvent(this, null, "service", "en primer plano");
        } catch (Exception e) {
            // En Android 12+ arrancar un servicio en primer plano desde segundo
            // plano está prohibido salvo exención. Sin exención de batería y sin
            // alarma exacta esto es exactamente lo que pasa de madrugada: el
            // servicio no vuelve y la noche se pierde entera. Antes moría en
            // silencio y la UI seguía diciendo «en marcha».
            recordError("No se pudo entrar en primer plano ("
                + e.getClass().getSimpleName()
                + "). Casi siempre es la optimización de batería.");
            stopSelf();
        }
    }

    /**
     * Alarma de vigilancia. Se usa una alarma exacta porque las inexactas se
     * agrupan y pueden retrasarse horas en Doze, justo durante el sueño, y
     * porque disparar una exacta concede a la app una ventana temporal en la
     * que sí puede arrancar un servicio en primer plano desde segundo plano.
     */
    static void scheduleWatchdog(Context context) {
        scheduleRestart(context, watchdogIntervalMs(context));
    }

    /**
     * Con el sensor de postura el vigilante pasa cada diez minutos en vez de
     * cada quince: es la cadencia de las lecturas, y dos seguidas en el bolsillo
     * o la mano son lo que cuenta como un rato despierto. Sigue por encima de
     * los nueve minutos que Android deja entre dos alarmas en reposo.
     *
     * Sólo de noche: fuera de la ventana nocturna no se toma ninguna lectura,
     * y despertar el móvil cada diez minutos todo el día gastaba batería para
     * nada. Se mira también la próxima pasada, para no llegar tarde a la
     * primera lectura de la noche.
     */
    static long watchdogIntervalMs(Context context) {
        String sensors = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SENSORS, "");
        boolean posture = false;
        for (String part : sensors.split(",")) {
            if (part.trim().equals(SensorWatcher.POSTURE)) posture = true;
        }
        long now = System.currentTimeMillis();
        boolean night = inNightWindow(context, now) || inNightWindow(context, now + WATCHDOG_INTERVAL_MS);
        return watchdogIntervalMs(posture, night);
    }

    /** Lógica pura de {@link #watchdogIntervalMs(Context)}, para probarla sin dispositivo. */
    static long watchdogIntervalMs(boolean postureActive, boolean nightSoon) {
        return postureActive && nightSoon ? POSTURE_WATCHDOG_INTERVAL_MS : WATCHDOG_INTERVAL_MS;
    }

    /** Intervalo del vigilante con el sensor de postura activo. */
    private static final long POSTURE_WATCHDOG_INTERVAL_MS = 10 * 60_000L;

    static void scheduleRestart(Context context, long delayMs) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;

        Intent intent = new Intent(context, BootReceiver.class).setAction(ACTION_RESTART);
        PendingIntent pending = PendingIntent.getBroadcast(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        long at = System.currentTimeMillis() + delayMs;
        try {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } catch (SecurityException e) {
            // Sin permiso de alarmas exactas se degrada a una inexacta: menos
            // puntual, pero sigue rearmando el servicio. Con Doze de por medio
            // puede retrasarse horas, así que la UI tiene que poder decirlo.
            alarms.set(AlarmManager.RTC_WAKEUP, at, pending);
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_LAST_ERROR,
                    "Sin permiso de alarmas exactas: el servicio puede tardar horas en rearmarse.")
                .apply();
        }
    }

    static void cancelWatchdog(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        Intent intent = new Intent(context, BootReceiver.class).setAction(ACTION_RESTART);
        PendingIntent pending = PendingIntent.getBroadcast(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        alarms.cancel(pending);
    }

    // --- Escucha de eventos del dispositivo ---

    private void unregisterDeviceReceiver() {
        if (receiver == null) return;
        try {
            unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
            // Ya estaba dado de baja.
        }
        receiver = null;
    }

    private void registerDeviceReceiver() {
        unregisterDeviceReceiver();

        IntentFilter filter = new IntentFilter();
        boolean any = false;

        if (triggerOn(TRIGGER_SCREEN)) {
            filter.addAction(Intent.ACTION_SCREEN_OFF);
            filter.addAction(Intent.ACTION_SCREEN_ON);
            filter.addAction(Intent.ACTION_USER_PRESENT);
            any = true;
        }
        if (triggerOn(TRIGGER_CHARGER)) {
            filter.addAction(Intent.ACTION_POWER_CONNECTED);
            filter.addAction(Intent.ACTION_POWER_DISCONNECTED);
            any = true;
        }
        if (triggerOn(TRIGGER_IDLE)) {
            filter.addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED);
            any = true;
        }
        if (triggerOn(TRIGGER_DND)) {
            filter.addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED);
            any = true;
        }
        if (!any) {
            recordError("Ningún disparador del dispositivo está activo: el servicio no escucha nada.");
            return;
        }

        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                handleEvent(intent.getAction(), System.currentTimeMillis());
            }
        };

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Exportado a propósito. Todas las acciones del filtro son
            // difusiones protegidas: sólo el sistema puede emitirlas, así que
            // no abre ninguna puerta a otras apps. Marcarlas como no exportadas
            // es lo que en algunos dispositivos deja fuera a USER_PRESENT, que
            // —a diferencia de SCREEN_ON y SCREEN_OFF— no se envía sólo a
            // receptores registrados en código.
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(receiver, filter);
        }

        logEvent(this, null, "service", "escuchando: " + prefs().getString(KEY_TRIGGERS, TRIGGER_SCREEN));
    }

    private void unregisterContextReceiver() {
        if (contextReceiver == null) return;
        try {
            unregisterReceiver(contextReceiver);
        } catch (IllegalArgumentException ignored) {
            // Ya estaba dado de baja.
        }
        contextReceiver = null;
    }

    /**
     * Receptor del contexto del dispositivo. Son difusiones raras (el usuario
     * activa el modo avión, cambia el timbre o el ahorro de energía, enchufa el
     * cargador) y todas protegidas: sólo las emite el sistema. Escucharlas no
     * cuesta nada y permite anotar el cambio a su hora en vez de a la del
     * siguiente rearme. No se registra nada si el usuario apagó el ajuste.
     */
    private void registerContextReceiver() {
        unregisterContextReceiver();
        if (!ContextSampler.enabled(this)) return;

        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_AIRPLANE_MODE_CHANGED);
        filter.addAction(AudioManager.RINGER_MODE_CHANGED_ACTION);
        filter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        filter.addAction(Intent.ACTION_POWER_CONNECTED);
        filter.addAction(Intent.ACTION_POWER_DISCONNECTED);

        contextReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                ContextSampler.sample(context, true);
            }
        };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(contextReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(contextReceiver, filter);
        }
    }

    private void handleEvent(String action, long now) {
        if (action == null) return;

        // Cualquier evento recibido demuestra que el servicio sigue escuchando.
        prefs().edit().putLong(KEY_ALIVE_AT, now).apply();

        switch (action) {
            case Intent.ACTION_SCREEN_OFF:
                // Momento en que el uso termina: candidato a inicio del hueco.
                RawEventLog.add(this, "screen-off");
                stopWatchingForUnlock();
                // Antes de abrir: si el uso que acaba de terminar era sostenido,
                // cierra el hueco de la noche y éste es el principio de otro.
                screenWentOff(now);
                openGap(TRIGGER_SCREEN, now, true);
                if (sensorWatcher != null) sensorWatcher.sample(true);
                ContextSampler.sample(this, false);
                break;

            case Intent.ACTION_USER_PRESENT:
                // Desbloqueo real: la señal más fiable de que el usuario ha
                // vuelto al dispositivo. Ya no es la única, porque hay móviles
                // donde no llega nunca: ver `watchForUnlock`.
                userIsBack(now);
                break;

            case Intent.ACTION_SCREEN_ON:
                RawEventLog.add(this, "screen-on");
                // Sin bloqueo el usuario ya está delante: encender es volver.
                // Con bloqueo todavía no se sabe —la pantalla puede haberse
                // encendido sola por una notificación— así que se vigila el
                // cerrojo unos minutos en vez de esperar a USER_PRESENT.
                if (!keyguardLocked()) userIsBack(now);
                else watchForUnlock();
                ContextSampler.sample(this, false);
                break;

            case Intent.ACTION_POWER_CONNECTED:
                RawEventLog.add(this, "plug");
                // No toca `lastUsedAt`: enchufar el móvil no implica usarlo, y
                // confundirlo con uso real falsearía el hueco de la pantalla.
                openGap(TRIGGER_CHARGER, now, false);
                break;

            case Intent.ACTION_POWER_DISCONNECTED:
                RawEventLog.add(this, "unplug");
                closeGap(TRIGGER_CHARGER, now, false);
                break;

            case PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED:
                // Doze: el sistema da el móvil por quieto tras un rato sin
                // pantalla ni movimiento, y sale de golpe en cuanto se toca.
                // Es más tardío que SCREEN_OFF —Android tarda en decidirlo—
                // pero llega aunque no haya bloqueo de pantalla, que es
                // exactamente el hueco que deja el disparador de pantalla.
                if (deviceIdle()) {
                    RawEventLog.add(this, "idle-on");
                    openGap(TRIGGER_IDLE, now, false);
                } else if (interactive()) {
                    RawEventLog.add(this, "idle-off");
                    closeGap(TRIGGER_IDLE, now, true);
                } else {
                    // Android sale de Doze cada pocas horas para dejar correr
                    // las tareas pendientes y vuelve a entrar en cuanto
                    // termina. La pantalla sigue apagada y el usuario sigue
                    // durmiendo, así que esto no es una vuelta al móvil: era
                    // lo que partía la noche en trozos de dos o tres horas.
                    logEvent(this, TRIGGER_IDLE, "discard",
                        "salida de Doze con la pantalla apagada: ventana de mantenimiento");
                }
                break;

            case NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED:
                // «No molestar» activo: la única señal de las cuatro que
                // expresa intención y no consecuencia. Quien lo enciende al
                // acostarse está diciendo la hora a la que se acuesta.
                if (dndActive()) {
                    RawEventLog.add(this, "dnd-on");
                    openGap(TRIGGER_DND, now, false);
                } else {
                    RawEventLog.add(this, "dnd-off");
                    closeGap(TRIGGER_DND, now, false);
                }
                break;

            default:
                break;
        }
    }

    /**
     * Marca el principio de un hueco para un disparador.
     *
     * Si ya había uno abierto no se pisa: el primer borde es el bueno. Una
     * pantalla que se enciende y se apaga sola de madrugada no debe reiniciar
     * el reloj de la noche.
     */
    private void openGap(String trigger, long now, boolean marksUse) {
        String key = openKey(trigger);
        // No se anota: con bloqueo seguro, una pantalla que se enciende y se
        // apaga sola por cada notificación repetiría esta línea decenas de
        // veces en una noche y expulsaría del registro lo que sí importa.
        if (prefs().getLong(key, 0L) > 0) return;

        // Si el hueco anterior de este disparador se cerró hace un momento y
        // era demasiado corto, no era el final de la noche sino una
        // interrupción: se reanuda desde donde estaba. Sin esto, una noche
        // entera se descartaba en trozos y no llegaba a proponerse nada.
        long at = now;
        long closedAt = prefs().getLong(shortCloseKey(trigger), 0L);
        long resumeFrom = prefs().getLong(shortOpenKey(trigger), 0L);
        boolean resumed = closedAt > 0 && resumeFrom > 0
            && canResume(trigger, now - closedAt);
        if (resumed) at = resumeFrom;

        SharedPreferences.Editor edit = prefs().edit()
            .putLong(key, at)
            .remove(shortOpenKey(trigger))
            .remove(shortCloseKey(trigger));
        if (marksUse) edit.putLong(KEY_LAST_USED, now);
        edit.apply();

        if (resumed) {
            logEvent(this, trigger, "open", "se reanuda el hueco de las " + clock(at)
                + ": la interrupción duró " + formatDuration(now - closedAt));
        } else {
            logEvent(this, trigger, "open", null);
        }
    }

    /**
     * Cierra el hueco de un disparador. Si superó el umbral se encola; si no,
     * se descarta dejando dicho por qué, que es la mitad del valor del
     * registro: un hueco de 40 minutos descartado demuestra que la señal
     * llega, y que lo que falla es el umbral o la hora, no la escucha.
     *
     * `marksUse` distingue las señales que implican que el usuario ha cogido
     * el móvil (desbloquear, salir de Doze) de las que no (desenchufar el
     * cargable, apagar «No molestar» desde otro sitio).
     */
    private void closeGap(String trigger, long now, boolean marksUse) {
        String key = openKey(trigger);
        long openedAt = prefs().getLong(key, 0L);

        // Sin hueco abierto no hay nada que contar, y anotarlo repetiría una
        // línea por cada desbloqueo: con el bloqueo por deslizamiento,
        // SCREEN_ON ya cerró el hueco cuando llega USER_PRESENT.
        SharedPreferences.Editor edit = prefs().edit().putLong(key, 0L);

        if (openedAt > 0) {
            long elapsed = now - openedAt;
            logEvent(this, trigger, "close", "tras " + formatDuration(elapsed));
            if (elapsed >= minGapMs()) {
                // Los micro-despertares sólo existen para el hueco de pantalla.
                long[] wakes = TRIGGER_SCREEN.equals(trigger)
                    ? takeWakes(openedAt, now) : new long[0];
                enqueueGap(openedAt, now, trigger, trigger, wakes);
                edit.remove(shortOpenKey(trigger)).remove(shortCloseKey(trigger));
            } else {
                if (TRIGGER_SCREEN.equals(trigger)) takeWakes(openedAt, now);
                logEvent(this, trigger, "discard",
                    formatDuration(elapsed) + " · por debajo del mínimo de "
                        + formatDuration(minGapMs()));
                // Todavía puede ser una interrupción y no el final: se guarda
                // el borde para poder reanudarlo si el hueco vuelve a abrirse
                // enseguida. Lo mira `openGap`.
                edit.putLong(shortOpenKey(trigger), openedAt)
                    .putLong(shortCloseKey(trigger), now);
            }
        }

        if (marksUse) edit.putLong(KEY_LAST_USED, now);
        edit.apply();
    }

    /**
     * El usuario ha vuelto al móvil: se cierran los huecos que eso termina.
     *
     * Va junto porque las dos señales describen el mismo hecho desde ángulos
     * distintos, y Doze puede haber salido ya con la pantalla apagada o no
     * haber salido todavía. En ambos casos el usuario está delante.
     */
    private void userIsBack(long now) {
        stopWatchingForUnlock();
        RawEventLog.addDistinct(this, "unlock", 3_000L);
        screenInUse(now);
        closeGap(TRIGGER_IDLE, now, true);
    }

    /**
     * El usuario está delante del móvil. Decide si esto es el final de la noche.
     *
     * Sin un hueco de pantalla abierto y ya largo no hay noche en juego y el
     * desbloqueo cierra el hueco como siempre. Con uno, el primer desbloqueo
     * sólo es un candidato: se empieza a contar cuánto se usa el móvil, y el
     * hueco se cierra —con el final en ese primer desbloqueo— cuando el uso se
     * sostiene ({@link #SUSTAINED_USE_MS} de pantalla, o
     * {@link #SUSTAINED_UNLOCKS} desbloqueos en un mismo rato). Si el móvil se
     * apaga antes, era un micro-despertar: queda anotado dentro del hueco.
     *
     * Es idempotente durante el mismo uso: SCREEN_ON sin cerrojo, USER_PRESENT
     * y la vigilancia del cerrojo llegan todos por el mismo desbloqueo.
     */
    private void screenInUse(long now) {
        SharedPreferences p = prefs();
        long openedAt = p.getLong(openKey(TRIGGER_SCREEN), 0L);

        if (openedAt <= 0 || now - openedAt < minGapMs()) {
            clearWakeState();
            closeGap(TRIGGER_SCREEN, now, true);
            return;
        }
        if (p.getLong(KEY_WAKE_ON, 0L) > 0) return;

        long first = p.getLong(KEY_WAKE_FIRST, 0L);
        long lastOff = p.getLong(KEY_WAKE_LAST_OFF, 0L);
        long use = p.getLong(KEY_WAKE_USE, 0L);
        int unlocks = p.getInt(KEY_WAKE_UNLOCKS, 0);

        // Un uso nuevo: el anterior, si lo hubo, no llegó a sostenerse.
        if (first <= 0 || (lastOff > 0 && now - lastOff > WAKE_CLUSTER_GAP_MS)) {
            if (first > 0) addWake(first);
            first = now;
            use = 0L;
            unlocks = 0;
        }
        unlocks++;

        p.edit()
            .putLong(KEY_WAKE_FIRST, first)
            .putLong(KEY_WAKE_USE, use)
            .putInt(KEY_WAKE_UNLOCKS, unlocks)
            .putLong(KEY_WAKE_ON, now)
            .putLong(KEY_LAST_USED, now)
            .apply();
        logEvent(this, TRIGGER_SCREEN, "open", "desbloqueo " + unlocks + " tras "
            + formatDuration(now - openedAt) + " de noche: se espera a ver si el uso se sostiene");

        if (unlocks >= SUSTAINED_UNLOCKS || use >= SUSTAINED_USE_MS) {
            finalizeWake(now);
        } else {
            wakeWatch.removeCallbacksAndMessages(null);
            wakeWatch.postDelayed(this::checkSustainedUse, Math.max(1_000L, SUSTAINED_USE_MS - use));
        }
    }

    /**
     * La pantalla se apaga. Si estaba en uso dentro de un posible despertar, se
     * suma el rato y se decide: sostenido, cierra la noche; si no, micro-despertar.
     */
    private void screenWentOff(long now) {
        SharedPreferences p = prefs();
        long onSince = p.getLong(KEY_WAKE_ON, 0L);
        if (onSince <= 0) return;

        long use = p.getLong(KEY_WAKE_USE, 0L) + Math.max(0L, now - onSince);
        p.edit()
            .putLong(KEY_WAKE_USE, use)
            .putLong(KEY_WAKE_ON, 0L)
            .putLong(KEY_WAKE_LAST_OFF, now)
            .apply();
        wakeWatch.removeCallbacksAndMessages(null);

        if (use >= SUSTAINED_USE_MS) {
            finalizeWake(now);
        } else {
            logEvent(this, TRIGGER_SCREEN, "discard", "uso de " + formatDuration(use)
                + " de madrugada: micro-despertar, no cierra la noche");
        }
    }

    /**
     * El proceso murió con un uso de madrugada en marcha y vuelve con la
     * pantalla apagada: el SCREEN_OFF se perdió y no se sabe cuándo llegó. Contar
     * todo el rato hasta ahora como uso daría por sostenido un vistazo de
     * segundos y partiría la noche en ese desbloqueo, así que se da por apagada
     * en el mismo instante en que se encendió: queda como micro-despertar, y si
     * en realidad fue el despertar, el desbloqueo siguiente cierra la noche y la
     * capa web retrocede el final hasta él (ver `trimGap`).
     */
    private void abandonWakeUse() {
        SharedPreferences p = prefs();
        long onSince = p.getLong(KEY_WAKE_ON, 0L);
        if (onSince <= 0) return;
        p.edit()
            .putLong(KEY_WAKE_ON, 0L)
            .putLong(KEY_WAKE_LAST_OFF, onSince)
            .apply();
        wakeWatch.removeCallbacksAndMessages(null);
        logEvent(this, TRIGGER_SCREEN, "discard",
            "el servicio se reinició con un uso de madrugada a medias: se toma por micro-despertar");
    }

    /** Comprobación diferida: el móvil sigue en uso y ya se ha sostenido lo bastante. */
    private void checkSustainedUse() {
        SharedPreferences p = prefs();
        long onSince = p.getLong(KEY_WAKE_ON, 0L);
        if (onSince <= 0) return;
        if (!interactive() || keyguardLocked()) return;

        long now = System.currentTimeMillis();
        long use = p.getLong(KEY_WAKE_USE, 0L) + Math.max(0L, now - onSince);
        if (use >= SUSTAINED_USE_MS) {
            finalizeWake(now);
        } else {
            wakeWatch.postDelayed(this::checkSustainedUse, SUSTAINED_USE_MS - use);
        }
    }

    /**
     * El uso se ha sostenido: la noche terminó en el primer desbloqueo del
     * grupo, no ahora. Se cierra el hueco con ese instante y se anota el uso
     * real del móvil con la hora de ahora.
     */
    private void finalizeWake(long now) {
        long first = prefs().getLong(KEY_WAKE_FIRST, 0L);
        wakeWatch.removeCallbacksAndMessages(null);
        long end = first > 0 ? first : now;
        // Se limpia el grupo antes de cerrar: `closeGap` lee los micro-despertares
        // pero no el estado del grupo, y así un cierre fallido no se queda a medias.
        clearWakeCluster();
        closeGap(TRIGGER_SCREEN, end, false);
        prefs().edit().putLong(KEY_LAST_USED, now).apply();
    }

    private void clearWakeCluster() {
        prefs().edit()
            .remove(KEY_WAKE_FIRST)
            .remove(KEY_WAKE_LAST_OFF)
            .remove(KEY_WAKE_USE)
            .remove(KEY_WAKE_UNLOCKS)
            .remove(KEY_WAKE_ON)
            .apply();
    }

    /** Borra el grupo y los micro-despertares: ya no hay noche abierta que los explique. */
    private void clearWakeState() {
        clearWakeCluster();
        prefs().edit().remove(KEY_WAKES).apply();
        wakeWatch.removeCallbacksAndMessages(null);
    }

    /** Anota un micro-despertar dentro del hueco abierto. */
    private void addWake(long at) {
        String raw = prefs().getString(KEY_WAKES, "");
        String[] parts = raw.isEmpty() ? new String[0] : raw.split(",");
        StringBuilder out = new StringBuilder();
        int from = Math.max(0, parts.length - (MAX_WAKES - 1));
        for (int i = from; i < parts.length; i++) out.append(parts[i]).append(',');
        out.append(at);
        prefs().edit().putString(KEY_WAKES, out.toString()).apply();
    }

    /** Lee y borra los micro-despertares que caen dentro del hueco que se cierra. */
    private long[] takeWakes(long start, long end) {
        String raw = prefs().getString(KEY_WAKES, "");
        prefs().edit().remove(KEY_WAKES).apply();
        if (raw.isEmpty()) return new long[0];
        String[] parts = raw.split(",");
        long[] tmp = new long[parts.length];
        int n = 0;
        for (String part : parts) {
            try {
                long at = Long.parseLong(part.trim());
                if (at > start && at < end) tmp[n++] = at;
            } catch (NumberFormatException ignored) {
                // Entrada corrupta: se ignora.
            }
        }
        long[] out = new long[n];
        System.arraycopy(tmp, 0, out, 0, n);
        return out;
    }

    /**
     * Vigila si el usuario quita el cerrojo, en vez de esperar a USER_PRESENT.
     *
     * Este es el arreglo del fallo que dejaba el disparador de pantalla muerto
     * para siempre. Hay dispositivos —un Galaxy S24+ con One UI, comprobado con
     * el histórico de difusiones del propio sistema— donde
     * {@link Intent#ACTION_USER_PRESENT} no se entrega nunca a la app, mientras
     * que SCREEN_ON y SCREEN_OFF llegan siempre. Como con bloqueo seguro
     * USER_PRESENT era lo único que cerraba el hueco, el primer bloqueo de
     * pantalla lo abría y ya no lo cerraba nadie: `openAt.screen` se quedaba
     * clavado, los SCREEN_OFF siguientes se iban por el retorno temprano de
     * {@link #openGap} y «Último uso del móvil» se congelaba durante días.
     *
     * Preguntar por el cerrojo no depende de que llegue ninguna difusión: es
     * estado del sistema, se consulta y ya está. Se mira varias veces y
     * espaciando, porque entre que la pantalla se enciende y el usuario mete el
     * PIN o pone el dedo pasan segundos, y porque una pantalla encendida por
     * una notificación no debe contar como vuelta: si el cerrojo sigue puesto
     * cuando se agota la vigilancia, no ha vuelto nadie.
     */
    private static final long[] UNLOCK_WATCH_DELAYS_MS = {
        1_000L, 3_000L, 6_000L, 12_000L, 25_000L, 50_000L, 100_000L, 180_000L
    };

    private final Handler unlockWatch = new Handler(Looper.getMainLooper());
    /** Comprobación diferida de que un uso de pantalla de madrugada se sostiene. */
    private final Handler wakeWatch = new Handler(Looper.getMainLooper());

    private void watchForUnlock() {
        stopWatchingForUnlock();
        for (long delay : UNLOCK_WATCH_DELAYS_MS) {
            unlockWatch.postDelayed(() -> {
                // La pantalla puede haberse vuelto a apagar entre medias: el
                // SCREEN_OFF cancela la vigilancia, pero una comprobación ya
                // encolada podría colarse igualmente.
                if (!interactive() || keyguardLocked()) return;
                userIsBack(System.currentTimeMillis());
            }, delay);
        }
    }

    private void stopWatchingForUnlock() {
        unlockWatch.removeCallbacksAndMessages(null);
    }

    /**
     * Cierra un hueco que no puede estar abierto.
     *
     * Con el móvil encendido y desbloqueado delante del usuario, un hueco de
     * pantalla abierto es una contradicción: significa que la señal de vuelta
     * se perdió. Lo comprueba el vigilante cada quince minutos, así que aunque
     * fallen a la vez USER_PRESENT y la vigilancia del cerrojo, lo peor que
     * pasa es que el borde se redondee a un cuarto de hora —en vez de que la
     * detección se quede muerta hasta la siguiente reinstalación.
     */
    private void healStuckGap(long now) {
        if (!interactive() || keyguardLocked()) return;
        // Un uso de madrugada que ya se sostuvo y cuyo temporizador se perdió con
        // el proceso: se resuelve aquí en vez de dejar el hueco abierto.
        checkSustainedUse();
        if (prefs().getLong(openKey(TRIGGER_SCREEN), 0L) <= 0
            && prefs().getLong(openKey(TRIGGER_IDLE), 0L) <= 0) return;

        logEvent(this, TRIGGER_SCREEN, "close",
            "el móvil está desbloqueado con un hueco abierto: se cierra sin esperar a la señal");
        userIsBack(now);
    }

    /** ¿Está la pantalla encendida? Distingue al usuario del propio sistema. */
    private boolean interactive() {
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return power != null && power.isInteractive();
    }

    /** ¿Está el sistema en reposo profundo ahora mismo? */
    private boolean deviceIdle() {
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return power != null && power.isDeviceIdleMode();
    }

    /** ¿Hay algún filtro de interrupciones activo («No molestar», prioridad, alarmas)? */
    private boolean dndActive() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return false;
        int filter = manager.getCurrentInterruptionFilter();
        return filter != NotificationManager.INTERRUPTION_FILTER_ALL
            && filter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN;
    }

    private long minGapMs() {
        return prefs().getInt(KEY_MIN_GAP, 180) * 60_000L;
    }

    /**
     * Si el servicio arranca con la pantalla ya apagada —tras un reinicio de
     * madrugada, o al rearmarlo la alarma de vigilancia— no habrá llegado el
     * SCREEN_OFF correspondiente. Se da por empezado el hueco en ese momento:
     * subestima la inactividad, pero no la pierde entera.
     */
    private void primeScreenState() {
        long now = System.currentTimeMillis();
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);

        if (triggerOn(TRIGGER_SCREEN) && power != null && !interactive()) {
            // Si el proceso murió con la pantalla en uso, el SCREEN_OFF se perdió.
            abandonWakeUse();
            openGap(TRIGGER_SCREEN, now, false);
        } else if (triggerOn(TRIGGER_SCREEN) && keyguardLocked()) {
            // Pantalla encendida y cerrojo puesto al arrancar: el usuario aún
            // no ha vuelto, y el desbloqueo que viene puede no llegar como
            // difusión. Se vigila igual que tras un SCREEN_ON.
            watchForUnlock();
        }
        // Mismo razonamiento para los otros dos disparadores de estado: Doze y
        // «No molestar» son condiciones continuas, no instantes, así que al
        // arrancar hay que mirar en cuál está el sistema en vez de esperar un
        // cambio que ya ocurrió.
        if (triggerOn(TRIGGER_IDLE) && deviceIdle()) {
            openGap(TRIGGER_IDLE, now, false);
        }
        if (triggerOn(TRIGGER_DND) && dndActive()) {
            openGap(TRIGGER_DND, now, false);
        }
    }

    /**
     * ¿Está el cerrojo puesto ahora mismo?
     *
     * Es la pregunta que sustituye a esperar USER_PRESENT, y sustituye también
     * a la que se hacía antes —`isKeyguardSecure()`, si el móvil exige PIN o
     * huella—, que describía la configuración del aparato en vez del momento.
     * Lo que hace falta saber no es si hay cerrojo, sino si está puesto: con la
     * pantalla encendida y el cerrojo quitado el usuario está delante, venga o
     * no la difusión del sistema. Y a diferencia de una difusión, esto siempre
     * se puede preguntar.
     */
    private boolean keyguardLocked() {
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    /** Añade un hueco de inactividad a la cola que consumirá la capa web. */
    private void enqueueGap(
        long start, long end, String startTrigger, String endTrigger, long[] wakes
    ) {
        enqueueGap(this, start, end, startTrigger, endTrigger, wakes);
        maybeNotifySummary(start, end);
    }

    /**
     * Encola un hueco. Es estático para que el plugin pueda inyectar uno de
     * prueba sin el servicio delante: probar los disparadores esperando una
     * noche entera por intento no es probarlos.
     */
    static void enqueueGap(
        Context context, long start, long end, String startTrigger, String endTrigger
    ) {
        enqueueGap(context, start, end, startTrigger, endTrigger, new long[0]);
    }

    static void enqueueGap(
        Context context, long start, long end, String startTrigger, String endTrigger, long[] wakes
    ) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray gaps;
        try {
            gaps = new JSONArray(p.getString(KEY_GAPS, "[]"));
        } catch (JSONException e) {
            gaps = new JSONArray();
        }

        try {
            JSONObject gap = new JSONObject();
            gap.put("start", start);
            gap.put("end", end);
            gap.put("startTrigger", startTrigger);
            gap.put("endTrigger", endTrigger);
            if (wakes != null && wakes.length > 0) {
                JSONArray list = new JSONArray();
                for (long wake : wakes) list.put(wake);
                gap.put("wakes", list);
            }
            gaps.put(gap);
        } catch (JSONException e) {
            return;
        }

        // Se conservan los más recientes.
        while (gaps.length() > MAX_GAPS) {
            gaps.remove(0);
        }
        p.edit()
            .putString(KEY_GAPS, gaps.toString())
            .putLong(KEY_LAST_GAP_AT, end)
            .apply();

        logEvent(context, endTrigger, "gap", formatDuration(end - start)
            + " · de " + clock(start) + " a " + clock(end)
            + (wakes != null && wakes.length > 0 ? " · " + wakes.length + " micro-despertar(es)" : ""));
    }

    // --- Aviso con la estimación del sueño al despertar ---

    /**
     * Avisa con la estimación en cuanto se cierra el hueco.
     *
     * El momento es el punto: la propuesta ya existía antes, pero esperaba a
     * que el usuario abriera la app, que es justo lo que uno no hace al
     * despertarse. Con el aviso, la validación llega mientras la noche todavía
     * se recuerda.
     *
     * El filtro es deliberadamente laxo —umbral mínimo, ya aplicado por quien
     * llama, y un extremo dentro de la ventana nocturna—: la evaluación fina
     * (confianza, fusión de disparadores, corrección de bordes) la hace la capa
     * web al abrirse, y duplicarla aquí sólo garantizaría que las dos acaben
     * desincronizadas. La cifra del aviso es el hueco bruto; la que se guarda,
     * la refinada.
     */
    private void maybeNotifySummary(long start, long end) {
        if (!prefs().getBoolean(KEY_SUMMARY, false)) return;
        if (!inNightWindow(start) && !inNightWindow(end)) return;
        // Una misma noche cierra tantos huecos como disparadores activos haya:
        // la pantalla al desbloquear, el cargador al desenchufar, «no
        // molestar» al apagarse. Sin esto llegaban dos o tres avisos seguidos
        // diciendo duraciones distintas de la misma noche.
        long lastSummaryAt = prefs().getLong(KEY_LAST_SUMMARY_AT, 0L);
        if (lastSummaryAt > 0 && end - lastSummaryAt < SUMMARY_DEDUPE_MS) {
            logEvent(this, null, "discard",
                "aviso omitido: ya se avisó de esta noche a las " + clock(lastSummaryAt));
            return;
        }
        if (!canPostNotifications(this)) {
            recordError("Sin permiso de notificaciones: no se pudo avisar de la noche detectada.");
            return;
        }

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        try {
            manager.notify(SUMMARY_NOTIFICATION_ID, buildSummary(this, start, end, null));
            prefs().edit().putLong(KEY_LAST_SUMMARY_AT, end).apply();
        } catch (SecurityException e) {
            recordError("Sin permiso de notificaciones: no se pudo avisar de la noche detectada.");
        }
    }

    /**
     * El aviso «has dormido X». Es estático porque lo reconstruyen también el
     * receptor del comentario —para confirmar que se guardó— y el plugin, para
     * la prueba de Ajustes.
     *
     * Con `savedNote` nulo lleva el botón «Comentar», con respuesta en línea:
     * lo que uno quiere anotar de la noche (me desperté a las cuatro, cené
     * tarde) se recuerda al despertar y se olvida en cuanto empieza el día,
     * así que pedirlo después, dentro de la app, era perderlo. Con un
     * comentario ya guardado, el aviso lo muestra y deja de ofrecer el botón.
     */
    static Notification buildSummary(Context context, long start, long end, String savedNote) {
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        PendingIntent pending = PendingIntent.getActivity(
            context, 1, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String range = "De " + clock(start) + " a " + clock(end) + ".";
        String body = savedNote == null
            ? range + " Toca para confirmarlo o corregirlo."
            : range + " Comentario guardado: «" + savedNote + "».";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, SUMMARY_CHANNEL_ID)
            .setContentTitle("Has dormido " + formatDuration(end - start))
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(R.drawable.ic_stat_icon)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(pending);

        if (savedNote == null) {
            builder.addAction(commentAction(context, start, end));
        } else {
            // Al rehacer el aviso tras la respuesta no debe volver a sonar.
            builder.setOnlyAlertOnce(true);
        }
        return builder.build();
    }

    /** Botón «Comentar» con el campo de texto que Android abre en el propio aviso. */
    private static NotificationCompat.Action commentAction(Context context, long start, long end) {
        Intent intent = new Intent(context, SessionNoteReceiver.class);
        intent.setAction(ACTION_ADD_NOTE);
        intent.putExtra(EXTRA_START, start);
        intent.putExtra(EXTRA_END, end);

        // La respuesta en línea exige un PendingIntent mutable: el sistema
        // escribe el texto en él. Es explícito, así que nadie más puede
        // rellenarlo.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        PendingIntent reply = PendingIntent.getBroadcast(context, 2, intent, flags);

        RemoteInput input = new RemoteInput.Builder(REMOTE_INPUT_NOTE)
            .setLabel("Comentario sobre la noche")
            .build();

        return new NotificationCompat.Action.Builder(R.drawable.ic_stat_icon, "Comentar", reply)
            .addRemoteInput(input)
            .setAllowGeneratedReplies(false)
            .build();
    }

    /**
     * Guarda un comentario a la espera de su sesión. Lo identifica el
     * intervalo del hueco: la capa web lo adjunta a la sesión que se solape
     * con él, que puede tener los bordes algo corregidos.
     */
    static void addNote(Context context, long start, long end, String text) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray notes;
        try {
            notes = new JSONArray(p.getString(KEY_NOTES, "[]"));
        } catch (JSONException e) {
            notes = new JSONArray();
        }

        long now = System.currentTimeMillis();
        try {
            JSONObject note = new JSONObject();
            note.put("id", now);
            note.put("start", start);
            note.put("end", end);
            note.put("note", text);
            note.put("at", now);
            notes.put(note);
        } catch (JSONException e) {
            return;
        }

        while (notes.length() > MAX_NOTES) {
            notes.remove(0);
        }
        p.edit().putString(KEY_NOTES, notes.toString()).apply();
        logEvent(context, null, "service", "comentario añadido desde el aviso a la noche de "
            + clock(start) + " a " + clock(end));
    }

    private boolean inNightWindow(long ts) {
        return inNightWindow(this, ts);
    }

    /** ¿Cae este instante dentro de la ventana nocturna configurada? */
    static boolean inNightWindow(Context context, long ts) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int startMin = p.getInt(KEY_NIGHT_START, 21 * 60 + 30);
        int endMin = p.getInt(KEY_NIGHT_END, 11 * 60);

        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(ts);
        int m = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        return inNightWindow(startMin, endMin, m);
    }

    /** Lógica pura de la ventana nocturna, en minutos del día. */
    static boolean inNightWindow(int startMin, int endMin, int minuteOfDay) {
        int m = minuteOfDay;
        // La ventana cruza medianoche cuando el fin es menor que el inicio.
        return startMin <= endMin ? (m >= startMin && m <= endMin) : (m >= startMin || m <= endMin);
    }

    /** Mismo formato que `formatDuration` en la capa web: "7h 20m", "7h", "45m". */
    static String formatDuration(long ms) {
        long total = Math.max(0L, Math.round(ms / 60_000.0));
        long h = total / 60;
        long m = total % 60;
        if (h == 0) return m + "m";
        if (m == 0) return h + "h";
        return h + "h " + m + "m";
    }

    static String clock(long ts) {
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(ts);
        return String.format(Locale.getDefault(), "%02d:%02d",
            cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE));
    }

    static boolean canPostNotifications(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(context, "android.permission.POST_NOTIFICATIONS")
            == PackageManager.PERMISSION_GRANTED;
    }

    // --- Canales ---

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Monitorización del sueño",
            // Mínima: la notificación es obligatoria para el servicio, pero no
            // debe sonar, vibrar ni aparecer en la pantalla de bloqueo.
            NotificationManager.IMPORTANCE_MIN
        );
        channel.setDescription("Mantiene activa la detección del sueño mientras duermes");
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        manager.createNotificationChannel(channel);
    }

    /**
     * Canal aparte para el resumen del despertar. Va separado a propósito: el
     * de la monitorización está silenciado por definición, y el usuario debe
     * poder silenciar uno sin perder el otro.
     */
    private void createSummaryChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
            SUMMARY_CHANNEL_ID,
            "Resumen al despertar",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("La estimación de lo que has dormido, para que la valides");
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        PendingIntent pending = PendingIntent.getActivity(
            this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("PerfectRest")
            .setContentText("Detectando tu descanso")
            .setSmallIcon(R.drawable.ic_stat_icon)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pending)
            .build();
    }
}
