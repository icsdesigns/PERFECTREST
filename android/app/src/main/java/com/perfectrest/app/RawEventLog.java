package com.perfectrest.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Registro bruto del servicio: un evento por línea, sin prosa.
 *
 * Es distinto del registro de eventos de {@link SleepMonitorService#logEvent},
 * que es texto para que una persona entienda qué pasó. Éste es la materia
 * prima con la que la capa web cruza cada hueco con los sensores —¿hubo pasos
 * entre las 02:00 y las 07:00?, ¿cuándo se apagó la luz?— y lo que se exporta
 * para afinar los umbrales con datos reales. Cada entrada es
 * {@code {"at": epoch_ms, "kind": "...", "v": número opcional}}; los tipos
 * están documentados en {@code src/lib/rawEvents.ts}.
 *
 * Los sensores producen muchos eventos y reescribir el JSON entero en cada uno
 * costaría batería, así que se guarda en memoria y se vuelca a las
 * preferencias en tandas: de inmediato con los eventos de pantalla y cargador
 * (pocos, y los que no se pueden perder si el proceso muere) y como mucho cada
 * cinco minutos con los de sensores. El proceso del servicio y el del plugin
 * son el mismo, así que ambos ven la misma copia.
 */
final class RawEventLog {

    static final String KEY_RAW = "rawEvents";
    /** Tope del registro: unos días de pantalla y sensores sin crecer sin fin. */
    private static final int MAX_EVENTS = 2000;
    /** Cada cuánto se vuelcan a disco los eventos de sensores. */
    private static final long FLUSH_EVERY_MS = 5 * 60_000L;

    private static final Object LOCK = new Object();
    private static JSONArray cache;
    private static boolean dirty;
    private static long lastFlushAt;

    private RawEventLog() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(SleepMonitorService.PREFS, Context.MODE_PRIVATE);
    }

    /** Carga la copia de memoria la primera vez. Hay que llamarlo con el cerrojo cogido. */
    private static JSONArray load(Context context) {
        if (cache == null) {
            try {
                cache = new JSONArray(prefs(context).getString(KEY_RAW, "[]"));
            } catch (JSONException e) {
                cache = new JSONArray();
            }
        }
        return cache;
    }

    /** Anota un evento ahora, sin valor. Vuelca de inmediato: son los de pantalla y cargador. */
    static void add(Context context, String kind) {
        add(context, System.currentTimeMillis(), kind, null, true);
    }

    /** Anota un evento de sensor, con su valor: se vuelca en tandas. */
    static void addSensor(Context context, long at, String kind, long value) {
        add(context, at, kind, value, false);
    }

    /**
     * Anota un evento salvo que el anterior sea del mismo tipo y esté a menos de
     * {@code withinMs}: varias señales de la misma acción (SCREEN_ON y
     * USER_PRESENT al desbloquear) son un único hecho.
     */
    static void addDistinct(Context context, String kind, long withinMs) {
        long now = System.currentTimeMillis();
        synchronized (LOCK) {
            JSONArray events = load(context);
            JSONObject last = events.optJSONObject(events.length() - 1);
            if (last != null && kind.equals(last.optString("kind"))
                && now - last.optLong("at") < withinMs) {
                return;
            }
        }
        add(context, now, kind, null, true);
    }

    /**
     * Anota un evento fundiéndolo con el anterior si es del mismo tipo y está a
     * menos de {@code withinMs}: los pasos llegan en ráfagas de eventos y un
     * minuto de paseo es una sola entrada con la suma. Con {@code replace}, en
     * vez de sumar se queda el último valor (la luz: sólo importa el nivel final).
     */
    static void addMerged(
        Context context, long at, String kind, long value, long withinMs, boolean replace
    ) {
        synchronized (LOCK) {
            JSONArray events = load(context);
            JSONObject last = events.optJSONObject(events.length() - 1);
            if (last != null && kind.equals(last.optString("kind"))
                && Math.abs(at - last.optLong("at")) < withinMs) {
                try {
                    last.put("v", replace ? value : last.optLong("v") + value);
                    dirty = true;
                    maybeFlush(context, false);
                    return;
                } catch (JSONException ignored) {
                    // Se anota como entrada nueva.
                }
            }
        }
        add(context, at, kind, value, false);
    }

    private static void add(Context context, long at, String kind, Long value, boolean flushNow) {
        synchronized (LOCK) {
            JSONArray events = load(context);
            try {
                JSONObject event = new JSONObject();
                event.put("at", at);
                event.put("kind", kind);
                if (value != null) event.put("v", value.longValue());
                events.put(event);
            } catch (JSONException e) {
                return;
            }
            while (events.length() > MAX_EVENTS) {
                events.remove(0);
            }
            dirty = true;
            maybeFlush(context, flushNow);
        }
    }

    /** Vuelca a las preferencias si toca. Con el cerrojo cogido. */
    private static void maybeFlush(Context context, boolean force) {
        long now = System.currentTimeMillis();
        if (!dirty) return;
        if (!force && now - lastFlushAt < FLUSH_EVERY_MS) return;
        prefs(context).edit().putString(KEY_RAW, cache.toString()).apply();
        lastFlushAt = now;
        dirty = false;
    }

    /** Vuelca lo pendiente. Al parar el servicio, para no perder la última tanda. */
    static void flush(Context context) {
        synchronized (LOCK) {
            maybeFlush(context, true);
        }
    }

    /** Copia del registro tal como está ahora, con lo pendiente incluido. */
    static JSONArray read(Context context) {
        synchronized (LOCK) {
            try {
                return new JSONArray(load(context).toString());
            } catch (JSONException e) {
                return new JSONArray();
            }
        }
    }

    static void clear(Context context) {
        synchronized (LOCK) {
            cache = new JSONArray();
            dirty = false;
            prefs(context).edit().putString(KEY_RAW, "[]").apply();
        }
    }
}
