package com.perfectrest.app;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * Muestreo ligero del estado del dispositivo para el contexto de cada noche.
 *
 * Los disparadores y los sensores dicen cuándo se usa el móvil y qué pasa a su
 * alrededor; esto anota el resto de parámetros del sistema que ayudan a
 * entender por qué una noche salió como salió: batería y carga, red, modo
 * avión, timbre, ahorro de energía, «no molestar», Doze, Bluetooth de audio,
 * brillo y orientación. Los eventos van al registro bruto ({@link
 * RawEventLog}) y la capa web los resume por noche (`sessionContext.ts`).
 *
 * Es barato por construcción:
 *
 *  - No hay temporizador, escucha ni wakelock propios. Se muestrea sólo en
 *    momentos en que el servicio ya está despierto (cada rearme del vigilante,
 *    al apagar y encender la pantalla, al enchufar o desenchufar) y como mucho
 *    una vez cada {@link #MIN_SPACING_MS}.
 *  - La batería se lee de la difusión pegajosa, sin registrar ningún receptor.
 *  - Sólo se anota lo que cambia, más una lectura de refresco cada
 *    {@link #REFRESH_MS} para que el valor de una noche se pueda reconstruir
 *    aunque el registro haya rotado.
 *  - Cada lectura va en su propio try/catch: un parámetro que falte o un
 *    permiso que no esté sólo deja ese parámetro sin anotar.
 *
 * Privacidad: nada de ubicación, SSID, nombres ni direcciones de dispositivos
 * Bluetooth, contenido de notificaciones, nombres de apps ni identificadores.
 * De la red sólo el tipo y si hay conexión; de Bluetooth sólo cuántos
 * dispositivos de audio hay conectados. Se apaga con el ajuste «Guardar
 * contexto del dispositivo con cada noche». Los códigos de los valores son los
 * de `src/lib/rawEvents.ts`.
 */
final class ContextSampler {

    /** Preferencia (en {@link SleepMonitorService#PREFS}) con el interruptor del ajuste. */
    static final String KEY_CONTEXT = "deviceContext";

    static final int CHARGE_NONE = 0;
    static final int CHARGE_AC = 1;
    static final int CHARGE_USB = 2;
    static final int CHARGE_WIRELESS = 3;
    static final int CHARGE_DOCK = 4;

    static final int NET_NONE = 0;
    static final int NET_WIFI = 1;
    static final int NET_CELLULAR = 2;
    static final int NET_ETHERNET = 3;
    static final int NET_OTHER = 4;

    /** Dos muestreos no forzados más juntos que esto se funden en uno. */
    static final long MIN_SPACING_MS = 3 * 60_000L;
    /** Un valor sin cambios se vuelve a anotar pasado este tiempo (lectura de refresco). */
    static final long REFRESH_MS = 6 * 60 * 60_000L;

    /** Cambios mínimos para anotar un valor continuo: batería 5 puntos, temperatura 2 °C, brillo 10 puntos. */
    private static final long TOL_BATTERY = 4;
    private static final long TOL_TEMP = 19;
    private static final long TOL_BRIGHT = 9;

    private static final Object LOCK = new Object();
    /** Última lectura anotada de cada tipo: {valor, instante}. */
    private static final Map<String, long[]> LAST = new HashMap<>();
    private static long lastSampleAt = 0L;

    private ContextSampler() {}

    /** ¿Está activo el ajuste de guardar el contexto? Sin él el servicio no muestrea nada de esto. */
    static boolean enabled(Context context) {
        return context.getSharedPreferences(SleepMonitorService.PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_CONTEXT, true);
    }

    // --- Lógica pura (se prueba con JUnit, sin dispositivo) ---

    /**
     * ¿Hay que anotar esta lectura? Sí si nunca se anotó, si el valor cambió más
     * que {@code tolerance} o si la última anotación es más vieja que
     * {@link #REFRESH_MS}.
     */
    static boolean shouldLog(long[] last, long value, long now, long tolerance) {
        if (last == null) return true;
        if (Math.abs(value - last[0]) > tolerance) return true;
        return now - last[1] >= REFRESH_MS;
    }

    /** Tipo de carga a partir de {@code BatteryManager.EXTRA_PLUGGED}. */
    static int chargeCode(int plugged) {
        if ((plugged & BatteryManager.BATTERY_PLUGGED_AC) != 0) return CHARGE_AC;
        if ((plugged & BatteryManager.BATTERY_PLUGGED_USB) != 0) return CHARGE_USB;
        if ((plugged & BatteryManager.BATTERY_PLUGGED_WIRELESS) != 0) return CHARGE_WIRELESS;
        if (plugged != 0) return CHARGE_DOCK;
        return CHARGE_NONE;
    }

    /** Nivel de batería en porcentaje; -1 si el sistema no lo da. */
    static int batteryPct(int level, int scale) {
        if (level < 0 || scale <= 0) return -1;
        return Math.min(100, Math.round(level * 100f / scale));
    }

    /** Brillo en porcentaje a partir del valor del sistema (0-255); -1 si no se conoce. */
    static int brightnessPct(int raw) {
        if (raw < 0) return -1;
        return Math.min(100, Math.round(raw * 100f / 255f));
    }

    /** Código de red por prioridad: Wi-Fi, datos móviles, Ethernet y, si no, otra (VPN, Bluetooth…). */
    static int netCode(boolean wifi, boolean cellular, boolean ethernet) {
        if (wifi) return NET_WIFI;
        if (cellular) return NET_CELLULAR;
        if (ethernet) return NET_ETHERNET;
        return NET_OTHER;
    }

    /**
     * Dispositivos Bluetooth de audio conectados, a partir de los tipos de las
     * salidas de audio. Un mismo auricular suele aparecer como A2DP (música) y
     * como SCO (llamadas): se cuentan los de música y las variantes BLE, y los
     * SCO sólo si no hay otros. Los números son los de {@code AudioDeviceInfo}
     * (A2DP 8, SCO 7, BLE headset 26, speaker 27, broadcast 30), escritos aquí para
     * que la función no dependa de la versión de Android.
     */
    static int countBluetoothAudio(int[] types) {
        int music = 0;
        int sco = 0;
        for (int t : types) {
            if (t == 8 || t == 26 || t == 27 || t == 30) music++;
            else if (t == 7) sco++;
        }
        return music > 0 ? music : sco;
    }

    // --- Lecturas del sistema ---

    private static Intent batteryIntent(Context context) {
        // Con receptor nulo no se registra nada: sólo se lee el último valor.
        return context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    }

    private static int network(Context context) {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return -1;
        Network active = cm.getActiveNetwork();
        if (active == null) return NET_NONE;
        NetworkCapabilities caps = cm.getNetworkCapabilities(active);
        if (caps == null) return NET_NONE;
        return netCode(
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
    }

    private static int bluetoothAudio(Context context) {
        AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (audio == null) return -1;
        AudioDeviceInfo[] outs = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        int[] types = new int[outs.length];
        for (int i = 0; i < outs.length; i++) types[i] = outs[i].getType();
        return countBluetoothAudio(types);
    }

    private static int brightness(Context context) {
        return brightnessPct(Settings.System.getInt(
            context.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, -1));
    }

    private static int orientation(Context context) {
        int o = context.getResources().getConfiguration().orientation;
        // 1 vertical, 2 horizontal; lo demás (indefinido, cuadrada) no dice nada.
        return o == 1 || o == 2 ? o : -1;
    }

    /** Anota {@code kind} si toca. Con el cerrojo cogido por quien llama. */
    private static boolean log(Context context, String kind, long value, long now, long tolerance) {
        if (value < 0) return false;
        long[] last = LAST.get(kind);
        if (!shouldLog(last, value, now, tolerance)) return false;
        LAST.put(kind, new long[] {value, now});
        RawEventLog.addSensor(context, now, kind, value);
        return true;
    }

    /**
     * Lee el estado del dispositivo y anota en el registro bruto lo que haya
     * cambiado. Sin {@code force}, un muestreo muy cercano al anterior no hace
     * nada. No hace nada si el ajuste está apagado.
     */
    static void sample(Context context, boolean force) {
        if (!enabled(context)) return;
        long now = System.currentTimeMillis();
        synchronized (LOCK) {
            if (!force && now - lastSampleAt < MIN_SPACING_MS) return;
            lastSampleAt = now;

            boolean chargeChanged = false;
            try {
                Intent battery = batteryIntent(context);
                if (battery != null) {
                    int plugged = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                    long[] before = LAST.get("chg-type");
                    int code = chargeCode(plugged);
                    chargeChanged = before == null || before[0] != code;
                    log(context, "chg-type", code, now, 0);
                    int pct = batteryPct(
                        battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
                        battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1));
                    // Al enchufar o desenchufar se anota el nivel aunque no haya cambiado 5 puntos.
                    log(context, "batt", pct, now, chargeChanged ? -1 : TOL_BATTERY);
                    int temp = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);
                    if (temp > 0) log(context, "batt-temp", temp, now, TOL_TEMP);
                }
            } catch (RuntimeException ignored) {
                // Sin batería legible, esa parte del contexto queda vacía.
            }

            try {
                log(context, "net", network(context), now, 0);
            } catch (RuntimeException ignored) {
                // Falta ACCESS_NETWORK_STATE o el sistema no responde.
            }
            try {
                log(context, "airplane", Settings.Global.getInt(
                    context.getContentResolver(), Settings.Global.AIRPLANE_MODE_ON, 0), now, 0);
            } catch (RuntimeException ignored) {
                // Ajuste no disponible.
            }
            try {
                AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
                if (audio != null) log(context, "ringer", audio.getRingerMode(), now, 0);
            } catch (RuntimeException ignored) {
                // Sin timbre legible.
            }
            try {
                PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (power != null) {
                    log(context, "powersave", power.isPowerSaveMode() ? 1 : 0, now, 0);
                    log(context, "doze", power.isDeviceIdleMode() ? 1 : 0, now, 0);
                }
            } catch (RuntimeException ignored) {
                // Sin estado de energía.
            }
            try {
                NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    int filter = nm.getCurrentInterruptionFilter();
                    if (filter > 0) log(context, "dnd-mode", filter, now, 0);
                }
            } catch (RuntimeException ignored) {
                // Sin filtro de interrupciones legible.
            }
            try {
                log(context, "bt", bluetoothAudio(context), now, 0);
            } catch (RuntimeException ignored) {
                // Sin salidas de audio.
            }
            try {
                log(context, "bright", brightness(context), now, TOL_BRIGHT);
            } catch (RuntimeException ignored) {
                // Ajuste no disponible.
            }
            try {
                log(context, "orient", orientation(context), now, 0);
            } catch (RuntimeException ignored) {
                // Sin configuración legible.
            }
        }
    }

    // --- Instantánea para la hoja de sesión ---

    private static int sysInt(Context context, boolean global, String name, int fallback) {
        try {
            return global
                ? Settings.Global.getInt(context.getContentResolver(), name, fallback)
                : Settings.System.getInt(context.getContentResolver(), name, fallback);
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    /**
     * Datos estáticos del móvil y de la app, más el estado de ahora mismo.
     * Cada campo se omite si no se puede leer: la capa web trata cualquiera de
     * ellos como ausente. Sin identificadores: ni IMEI, ni número de serie, ni
     * identificador de Android, ni nombre del dispositivo.
     */
    static JSONObject snapshot(Context context) throws JSONException {
        JSONObject device = new JSONObject();
        device.put("model", Build.MODEL);
        device.put("manufacturer", Build.MANUFACTURER);
        device.put("sdk", Build.VERSION.SDK_INT);
        device.put("release", Build.VERSION.RELEASE);
        device.put("locale", Locale.getDefault().toLanguageTag());
        device.put("tz", TimeZone.getDefault().getID());
        device.put("tzOffsetMin", TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000);
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            device.put("app", info.versionName);
        } catch (Exception ignored) {
            // La versión de la app la completa la capa web.
        }

        JSONObject state = new JSONObject();
        try {
            PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (power != null) {
                state.put("interactive", power.isInteractive());
                state.put("powerSave", power.isPowerSaveMode());
                state.put("doze", power.isDeviceIdleMode());
            }
        } catch (RuntimeException ignored) {
            // Sin estado de energía.
        }
        try {
            Intent battery = batteryIntent(context);
            if (battery != null) {
                state.put("charge", chargeCode(battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)));
                state.put("battery", batteryPct(
                    battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
                    battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1)));
                int temp = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);
                if (temp > 0) state.put("batteryTempC", temp / 10.0);
            }
        } catch (RuntimeException ignored) {
            // Sin batería legible.
        }
        try {
            int net = network(context);
            if (net >= 0) state.put("net", net);
        } catch (RuntimeException ignored) {
            // Sin permiso o sin servicio de red.
        }
        try {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) state.put("dnd", nm.getCurrentInterruptionFilter());
        } catch (RuntimeException ignored) {
            // Sin filtro de interrupciones legible.
        }
        try {
            AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (audio != null) {
                state.put("ringer", audio.getRingerMode());
                state.put("music", audio.isMusicActive());
                state.put("btAudio", bluetoothAudio(context));
            }
        } catch (RuntimeException ignored) {
            // Sin audio.
        }
        try {
            AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarms != null) {
                AlarmManager.AlarmClockInfo next = alarms.getNextAlarmClock();
                state.put("nextAlarm", next == null ? 0L : next.getTriggerTime());
            }
        } catch (RuntimeException ignored) {
            // Sin alarma legible.
        }
        state.put("airplane", sysInt(context, true, Settings.Global.AIRPLANE_MODE_ON, 0) != 0);
        // «bluetooth_on» es un ajuste global legible sin permisos; no dice con qué se empareja.
        state.put("bluetoothOn", sysInt(context, true, "bluetooth_on", 0) != 0);
        int bright = sysInt(context, false, Settings.System.SCREEN_BRIGHTNESS, -1);
        if (bright >= 0) state.put("brightness", brightnessPct(bright));
        state.put("brightnessAuto",
            sysInt(context, false, Settings.System.SCREEN_BRIGHTNESS_MODE, 0) == 1);
        try {
            int o = orientation(context);
            if (o > 0) state.put("orientation", o);
        } catch (RuntimeException ignored) {
            // Sin configuración legible.
        }

        JSONObject out = new JSONObject();
        out.put("device", device);
        out.put("state", state);
        return out;
    }
}
