package com.perfectrest.app;

import android.Manifest;
import android.app.ActivityManager;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.TextUtils;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Puente entre la capa web y {@link SleepMonitorService}.
 *
 * La web decide qué hacer con los datos; este plugin sólo arranca y para el
 * servicio, le dice qué disparadores debe escuchar y entrega los huecos de
 * inactividad registrados mientras la app estaba cerrada.
 *
 * La otra mitad de su trabajo es el diagnóstico. Los disparadores del
 * dispositivo dependen de tres permisos que Android concede fuera de la app y
 * puede retirar sin avisar —notificaciones, alarmas exactas y exención de
 * batería—, y sin ellos la detección no falla con un error: simplemente no
 * detecta nada, que es indistinguible de una noche sin señal. Por eso
 * {@link #diagnostics} los expone todos y hay un método para abrir la pantalla
 * de ajustes de cada uno.
 */
@CapacitorPlugin(
    name = "SleepMonitor",
    permissions = {
        // Sólo para el contador de pasos (Android 10+). Sin él se usa el
        // movimiento significativo, que no pide nada.
        @Permission(strings = {Manifest.permission.ACTIVITY_RECOGNITION}, alias = "activity")
    }
)
public class SleepMonitorPlugin extends Plugin {

    /** Margen antes de dar por muerto un servicio que no da señales de vida. */
    private static final long ALIVE_WINDOW_MS = 45 * 60_000L;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(SleepMonitorService.PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void start(PluginCall call) {
        int minGap = call.getInt("minGapMinutes", 180);

        // Sin lista de disparadores se asume el de pantalla, que es el
        // comportamiento histórico del servicio.
        String triggers = SleepMonitorService.TRIGGER_SCREEN;
        JSArray raw = call.getArray("triggers");
        if (raw != null) {
            List<String> ids = new ArrayList<>();
            for (int i = 0; i < raw.length(); i++) {
                String id = raw.optString(i, null);
                if (id != null && !id.isEmpty()) ids.add(id);
            }
            // String.join es de API 26 y el mínimo soportado es menor.
            if (!ids.isEmpty()) triggers = TextUtils.join(",", ids);
        }

        // Sensores opcionales (fase 2): lista vacía o ausente = ninguno.
        String sensors = "";
        JSArray rawSensors = call.getArray("sensors");
        if (rawSensors != null) {
            List<String> ids = new ArrayList<>();
            for (int i = 0; i < rawSensors.length(); i++) {
                String id = rawSensors.optString(i, null);
                if (id != null && !id.isEmpty()) ids.add(id);
            }
            sensors = TextUtils.join(",", ids);
        }

        prefs().edit()
            .putInt(SleepMonitorService.KEY_MIN_GAP, minGap)
            .putString(SleepMonitorService.KEY_TRIGGERS, triggers)
            .putString(SleepMonitorService.KEY_SENSORS, sensors)
            // El aviso del despertar lo dispara el servicio, no la web: para
            // eso tiene que conocer el ajuste y la ventana nocturna.
            .putBoolean(SleepMonitorService.KEY_SUMMARY, call.getBoolean("wakeSummary", false))
            .putInt(SleepMonitorService.KEY_NIGHT_START, call.getInt("nightStartMinutes", 21 * 60 + 30))
            .putInt(SleepMonitorService.KEY_NIGHT_END, call.getInt("nightEndMinutes", 11 * 60))
            .apply();

        Intent intent = new Intent(getContext(), SleepMonitorService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
        } catch (Exception e) {
            prefs().edit()
                .putString(SleepMonitorService.KEY_LAST_ERROR,
                    "Android rechazó arrancar el servicio: " + e.getClass().getSimpleName())
                .apply();
            call.reject("No se pudo iniciar el servicio: " + e.getMessage());
            return;
        }

        // No se responde `true` a ciegas. El servicio puede haber sido
        // rechazado al entrar en primer plano, y devolver «en marcha» cuando no
        // lo está es lo que hacía que Ajustes mintiera durante semanas.
        JSObject ret = new JSObject();
        ret.put("running", serviceRunning());
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // El flag va antes de parar: el servicio consulta al morir si debe
        // rearmarse, y con esto sabe que la parada es deliberada.
        prefs().edit().putBoolean(SleepMonitorService.KEY_ENABLED, false).apply();
        SleepMonitorService.cancelWatchdog(getContext());
        getContext().stopService(new Intent(getContext(), SleepMonitorService.class));

        JSObject ret = new JSObject();
        ret.put("running", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        call.resolve(status());
    }

    /**
     * Estado completo de todo lo que la detección necesita para funcionar.
     *
     * Se devuelve junto porque el usuario no vive los permisos por separado:
     * lo que quiere saber es si esta noche se va a registrar o no, y eso
     * depende de los cuatro a la vez.
     */
    @PluginMethod
    public void diagnostics(PluginCall call) {
        call.resolve(status());
    }

    private JSObject status() {
        SharedPreferences p = prefs();
        long aliveAt = p.getLong(SleepMonitorService.KEY_ALIVE_AT, 0L);

        JSObject ret = new JSObject();
        ret.put("running", serviceRunning());
        ret.put("enabled", p.getBoolean(SleepMonitorService.KEY_ENABLED, false));
        ret.put("batteryExempt", batteryExempt());
        ret.put("notifications", notificationsGranted());
        ret.put("exactAlarms", exactAlarmsAllowed());
        ret.put("lastUsedAt", p.getLong(SleepMonitorService.KEY_LAST_USED, 0L));
        ret.put("startedAt", p.getLong(SleepMonitorService.KEY_STARTED_AT, 0L));
        ret.put("aliveAt", aliveAt);
        ret.put("lastGapAt", p.getLong(SleepMonitorService.KEY_LAST_GAP_AT, 0L));
        ret.put("lastError", p.getString(SleepMonitorService.KEY_LAST_ERROR, null));
        return ret;
    }

    /**
     * Devuelve los huecos de inactividad acumulados. No los borra: la web los
     * descarta explícitamente con {@link #clearGaps} una vez procesados, para
     * que un cierre inesperado no pierda una noche.
     */
    @PluginMethod
    public void getGaps(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("gaps", new JSONArray(prefs().getString(SleepMonitorService.KEY_GAPS, "[]")));
        } catch (JSONException e) {
            ret.put("gaps", new JSONArray());
        }
        ret.put("lastUsedAt", prefs().getLong(SleepMonitorService.KEY_LAST_USED, 0L));
        ret.put("screenOffAt", prefs().getLong(SleepMonitorService.KEY_SCREEN_OFF_AT, 0L));
        call.resolve(ret);
    }

    /**
     * Descarta los huecos ya procesados. Se conserva todo lo que termine
     * después de `until`: entre que la web lee la cola y la limpia, el servicio
     * puede haber encolado un hueco nuevo que no debe perderse.
     */
    @PluginMethod
    public void clearGaps(PluginCall call) {
        long until = call.getLong("until", 0L);
        JSONArray kept = new JSONArray();

        try {
            JSONArray current = new JSONArray(prefs().getString(SleepMonitorService.KEY_GAPS, "[]"));
            for (int i = 0; i < current.length(); i++) {
                JSONObject gap = current.optJSONObject(i);
                if (gap != null && gap.optLong("end", 0L) > until) {
                    kept.put(gap);
                }
            }
        } catch (JSONException e) {
            // Cola corrupta: se vacía, que es lo que haría de todas formas.
        }

        prefs().edit().putString(SleepMonitorService.KEY_GAPS, kept.toString()).apply();
        call.resolve();
    }

    /**
     * Comentarios escritos desde el aviso al despertar, a la espera de que la
     * web los adjunte a su sesión. Como los huecos, no se borran al leerlos:
     * lo hace `removeNotes` con los que ya encontraron su noche.
     */
    @PluginMethod
    public void getNotes(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("notes", new JSONArray(prefs().getString(SleepMonitorService.KEY_NOTES, "[]")));
        } catch (JSONException e) {
            ret.put("notes", new JSONArray());
        }
        call.resolve(ret);
    }

    /** Descarta los comentarios indicados por id, ya adjuntados o caducados. */
    @PluginMethod
    public void removeNotes(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        Set<Long> drop = new HashSet<>();
        for (int i = 0; i < ids.length(); i++) {
            drop.add(ids.optLong(i));
        }

        JSONArray kept = new JSONArray();
        try {
            JSONArray current = new JSONArray(prefs().getString(SleepMonitorService.KEY_NOTES, "[]"));
            for (int i = 0; i < current.length(); i++) {
                JSONObject note = current.optJSONObject(i);
                if (note != null && !drop.contains(note.optLong("id"))) kept.put(note);
            }
        } catch (JSONException e) {
            // Lista corrupta: se vacía.
        }

        prefs().edit().putString(SleepMonitorService.KEY_NOTES, kept.toString()).apply();
        call.resolve();
    }

    /**
     * Publica el aviso al despertar tal cual lo emite el servicio, con su
     * botón «Comentar». Es la prueba de Ajustes: la versión que montaba la web
     * no podía llevar la respuesta en línea que atiende el receptor nativo.
     */
    @PluginMethod
    public void notifySummary(PluginCall call) {
        long start = call.getLong("start", 0L);
        long end = call.getLong("end", 0L);
        if (end <= start) {
            call.reject("Intervalo no válido");
            return;
        }
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null || !SleepMonitorService.canPostNotifications(getContext())) {
            call.reject("Sin permiso de notificaciones");
            return;
        }
        try {
            manager.notify(
                SleepMonitorService.SUMMARY_NOTIFICATION_ID,
                SleepMonitorService.buildSummary(getContext(), start, end, null)
            );
            call.resolve();
        } catch (SecurityException e) {
            call.reject("Sin permiso de notificaciones");
        }
    }

    /**
     * Registro de eventos del servicio: cada señal recibida, cada hueco
     * encolado y cada descarte con su motivo.
     *
     * Es lo que convierte «la app no detecta nada» en una pregunta con
     * respuesta. Sin él, un servicio que Android mató a las dos de la mañana y
     * una noche en la que de verdad no llegó ninguna señal producen el mismo
     * resultado visible: nada.
     */
    @PluginMethod
    public void getEvents(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("events", new JSONArray(prefs().getString(SleepMonitorService.KEY_EVENTS, "[]")));
        } catch (JSONException e) {
            ret.put("events", new JSONArray());
        }
        call.resolve(ret);
    }

    /**
     * Registro bruto: pantalla, cargador y sensores, un evento por línea. La web
     * lo cruza con cada hueco y lo exporta tal cual. Como el de eventos, no se
     * borra al leerlo.
     */
    @PluginMethod
    public void getRawEvents(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("events", RawEventLog.read(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void clearRawEvents(PluginCall call) {
        RawEventLog.clear(getContext());
        call.resolve();
    }

    /**
     * Qué sensores tiene el móvil y cómo funcionaría cada uno con los permisos
     * actuales, para que Ajustes lo explique en vez de dejar un interruptor que
     * no hace nada.
     */
    @PluginMethod
    public void sensorStatus(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("sensors", SensorWatcher.describe(getContext()));
        } catch (JSONException e) {
            call.reject("No se pudo leer el estado de los sensores");
            return;
        }
        call.resolve(ret);
    }

    /**
     * Pide el permiso «Actividad física», que sólo necesita el contador de
     * pasos. Antes de Android 10 no existe y se da por concedido; denegado, la
     * app sigue funcionando con el movimiento significativo.
     */
    @PluginMethod
    public void requestSensorPermission(PluginCall call) {
        if (SensorWatcher.activityPermissionGranted(getContext())) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("activity", call, "activityPermissionResult");
    }

    @PermissionCallback
    private void activityPermissionResult(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("activity") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    /** Vacía el registro. Los huecos pendientes no se tocan. */
    @PluginMethod
    public void clearEvents(PluginCall call) {
        prefs().edit().putString(SleepMonitorService.KEY_EVENTS, "[]").apply();
        call.resolve();
    }

    /**
     * Inyecta un hueco de prueba, como si el disparador indicado lo hubiera
     * abierto hace `minutesAgo` minutos y lo acabara de cerrar.
     *
     * Existe porque la alternativa para comprobar un disparador era esperar
     * una noche entera por intento, y con cuatro disparadores y un umbral de
     * tres horas eso no es comprobar nada. El hueco recorre exactamente el
     * mismo camino que uno real —cola, evaluación en la capa web, propuesta de
     * sesión— así que lo que se prueba es la tubería completa, no una maqueta.
     *
     * No simula el evento de Android: eso no se puede hacer desde la app, y
     * fingirlo escondería justo el fallo que importa (que el evento no llegue).
     */
    @PluginMethod
    public void simulateGap(PluginCall call) {
        String trigger = call.getString("trigger", SleepMonitorService.TRIGGER_SCREEN);
        int minutesAgo = call.getInt("minutesAgo", 480);

        boolean known = false;
        for (String id : SleepMonitorService.NATIVE_TRIGGERS) {
            if (id.equals(trigger)) known = true;
        }
        if (!known) {
            call.reject("Disparador desconocido: " + trigger);
            return;
        }

        long end = System.currentTimeMillis();
        long start = end - minutesAgo * 60_000L;
        SleepMonitorService.logEvent(getContext(), trigger, "service",
            "prueba manual desde Ajustes");
        SleepMonitorService.enqueueGap(getContext(), start, end, trigger, trigger);

        JSObject ret = new JSObject();
        ret.put("start", start);
        ret.put("end", end);
        call.resolve(ret);
    }

    /**
     * Abre el diálogo del sistema para eximir la app del ahorro de batería.
     * Es la diferencia entre que el servicio sobreviva la noche o que Android
     * lo pare a las pocas horas y no se detecte nada.
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        JSObject ret = new JSObject();

        if (batteryExempt()) {
            ret.put("requested", false);
            call.resolve(ret);
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:" + getContext().getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            ret.put("requested", true);
        } catch (Exception e) {
            // Algunas ROMs no exponen el diálogo directo; queda la pantalla
            // general de optimización de batería.
            try {
                getContext().startActivity(
                    new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                );
                ret.put("requested", true);
            } catch (Exception inner) {
                ret.put("requested", false);
            }
        }

        call.resolve(ret);
    }

    /**
     * Pantalla de «alarmas y recordatorios». Sin ese permiso la alarma de
     * vigilancia se degrada a inexacta, Doze la agrupa y el servicio puede
     * pasar la noche entera sin rearmarse.
     */
    @PluginMethod
    public void requestExactAlarms(PluginCall call) {
        JSObject ret = new JSObject();

        if (exactAlarmsAllowed() || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            ret.put("requested", false);
            call.resolve(ret);
            return;
        }

        try {
            getContext().startActivity(
                new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            );
            ret.put("requested", true);
        } catch (Exception e) {
            ret.put("requested", false);
        }

        call.resolve(ret);
    }

    /**
     * Ficha de la app en los ajustes del sistema.
     *
     * Es la única salida cuando un permiso está denegado de forma permanente:
     * a partir de la segunda negativa Android ya no muestra el diálogo, así que
     * el botón «conceder» de la app no hacía absolutamente nada y parecía roto.
     */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            getContext().startActivity(
                new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            );
            ret.put("opened", true);
        } catch (Exception e) {
            ret.put("opened", false);
        }
        call.resolve(ret);
    }

    /** Ajustes de notificaciones de la app, para reactivar un canal silenciado. */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + getContext().getPackageName()));
            }
            getContext().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            ret.put("opened", true);
        } catch (Exception e) {
            ret.put("opened", false);
        }
        call.resolve(ret);
    }

    // --- Estado de los permisos ---

    private boolean batteryExempt() {
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    /**
     * No basta con el permiso: el usuario puede tenerlo concedido y haber
     * desactivado las notificaciones de la app entera desde los ajustes, lo que
     * silencia igualmente el resumen del despertar.
     */
    private boolean notificationsGranted() {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(getContext(), "android.permission.POST_NOTIFICATIONS")
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean exactAlarmsAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager alarms = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        return alarms != null && alarms.canScheduleExactAlarms();
    }

    /**
     * ¿Sigue vivo el servicio?
     *
     * `getRunningServices` informa del proceso, no de que el servicio siga
     * escuchando: tras una muerte silenciosa puede seguir apareciendo. El
     * latido que el servicio refresca en cada arranque y en cada evento es la
     * señal fiable, y sólo se acepta si es reciente —el vigilante lo toca cada
     * 15 minutos, así que 45 sin noticias significa que algo lo paró.
     */
    @SuppressWarnings("deprecation")
    private boolean serviceRunning() {
        long aliveAt = prefs().getLong(SleepMonitorService.KEY_ALIVE_AT, 0L);
        if (aliveAt > 0 && System.currentTimeMillis() - aliveAt > ALIVE_WINDOW_MS) return false;

        ActivityManager manager = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) return false;
        // getRunningServices sigue informando de los servicios de la propia
        // app, que es lo único que se consulta aquí.
        for (ActivityManager.RunningServiceInfo info : manager.getRunningServices(Integer.MAX_VALUE)) {
            if (SleepMonitorService.class.getName().equals(info.service.getClassName())) {
                return true;
            }
        }
        return false;
    }
}
