package com.perfectrest.app;

import android.hardware.Sensor;
import android.hardware.SensorManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;
import java.util.Locale;

/**
 * Inventario y lecturas agregadas de los sensores del móvil.
 *
 * <b>Inventario</b> ({@link #inventory}): todo lo que devuelve
 * {@code getSensorList(TYPE_ALL)} —nombre, fabricante, tipo, rango,
 * resolución, consumo, retardo mínimo y máximo, modo de reporte, FIFO, si
 * despierta el procesador y si es dinámico—. Sin identificadores únicos del
 * dispositivo (no se lee {@code getId()}).
 *
 * <b>Lecturas</b> ({@link Agg}): cada ventana corta de muestreo (la misma de
 * la postura, ~2,5 s) deja por sensor un agregado —n, media, mínimo, máximo y
 * desviación por eje— y no la serie cruda.
 *
 * <b>Qué se muestrea</b> ({@link #SAMPLED}) y qué no ({@link #EXCLUDED}): sólo
 * sensores que no piden un permiso peligroso. Quedan fuera el ritmo cardíaco
 * y el latido (permiso BODY_SENSORS) y los sensores de disparo único
 * (movimiento significativo, estacionario, movimiento), que no se pueden
 * leer en una ventana: aparecen en el inventario y el movimiento significativo
 * ya genera su propio evento en el registro bruto. Los pasos exigen el
 * permiso «Actividad física» y sólo se leen si ya está concedido.
 */
final class SensorCatalog {

    private SensorCatalog() {}

    /** Tipos que se muestrean en cada ventana: clave del export y tipo de Android. */
    static final String[] SAMPLED_KEYS = {
        "accelerometer", "gravity", "linear_acceleration", "gyroscope", "magnetic_field",
        "pressure", "ambient_temperature", "relative_humidity", "light", "proximity",
        "rotation_vector", "game_rotation_vector", "geomagnetic_rotation_vector", "orientation",
        "step_counter", "step_detector", "device_orientation", "hinge_angle", "low_latency_offbody_detect",
    };
    static final int[] SAMPLED_TYPES = {
        Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_GRAVITY, Sensor.TYPE_LINEAR_ACCELERATION,
        Sensor.TYPE_GYROSCOPE, Sensor.TYPE_MAGNETIC_FIELD, Sensor.TYPE_PRESSURE,
        Sensor.TYPE_AMBIENT_TEMPERATURE, Sensor.TYPE_RELATIVE_HUMIDITY, Sensor.TYPE_LIGHT,
        Sensor.TYPE_PROXIMITY, Sensor.TYPE_ROTATION_VECTOR, Sensor.TYPE_GAME_ROTATION_VECTOR,
        Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR, Sensor.TYPE_ORIENTATION, Sensor.TYPE_STEP_COUNTER,
        Sensor.TYPE_STEP_DETECTOR, 27 /* TYPE_DEVICE_ORIENTATION */, 36 /* TYPE_HINGE_ANGLE */,
        34 /* TYPE_LOW_LATENCY_OFFBODY_DETECT */,
    };

    /** Tipos que nunca se leen, con el motivo (se documenta en el README y va en el export). */
    static final String[][] EXCLUDED = {
        {"heart_rate", "pide el permiso peligroso BODY_SENSORS"},
        {"heart_beat", "pide el permiso peligroso BODY_SENSORS"},
        {"significant_motion", "disparo único: no se puede leer en una ventana (ya genera el evento «motion»)"},
        {"stationary_detect", "disparo único: no se puede leer en una ventana"},
        {"motion_detect", "disparo único: no se puede leer en una ventana"},
        {"uncalibrated", "las variantes sin calibrar duplican a las calibradas"},
    };

    /** Pasos: se leen sólo con el permiso de actividad física ya concedido. */
    static boolean needsActivityPermission(int type) {
        return type == Sensor.TYPE_STEP_COUNTER || type == Sensor.TYPE_STEP_DETECTOR;
    }

    /** Nombre estable de un tipo: el sufijo de {@code android.sensor.*}, o {@code type_N} si no lo trae. */
    static String keyOf(Sensor s) {
        String t = null;
        try {
            t = s.getStringType();
        } catch (RuntimeException ignored) {
            // Sensor mal implementado: se cae al número.
        }
        return keyOfString(t, s.getType());
    }

    static String keyOfString(String stringType, int type) {
        if (stringType != null && !stringType.isEmpty()) {
            String prefix = "android.sensor.";
            return stringType.startsWith(prefix) ? stringType.substring(prefix.length()) : stringType;
        }
        return "type_" + type;
    }

    /** Un sensor del inventario. Sólo hardware, ningún identificador del dispositivo. */
    static JSONObject describe(Sensor s) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("name", s.getName());
        o.put("vendor", s.getVendor());
        o.put("type", keyOf(s));
        o.put("typeId", s.getType());
        o.put("version", s.getVersion());
        o.put("maxRange", finite(s.getMaximumRange()));
        o.put("resolution", finite(s.getResolution()));
        o.put("powerMa", finite(s.getPower()));
        o.put("minDelayUs", s.getMinDelay());
        o.put("maxDelayUs", s.getMaxDelay());
        o.put("fifoMax", s.getFifoMaxEventCount());
        o.put("fifoReserved", s.getFifoReservedEventCount());
        o.put("reportingMode", reportingMode(s.getReportingMode()));
        o.put("wakeUp", s.isWakeUpSensor());
        o.put("dynamic", s.isDynamicSensor());
        o.put("sampled", isSampled(s));
        return o;
    }

    static boolean isSampled(Sensor s) {
        for (int t : SAMPLED_TYPES) if (t == s.getType()) return true;
        return false;
    }

    static String reportingMode(int mode) {
        switch (mode) {
            case Sensor.REPORTING_MODE_CONTINUOUS: return "continuous";
            case Sensor.REPORTING_MODE_ON_CHANGE: return "on_change";
            case Sensor.REPORTING_MODE_ONE_SHOT: return "one_shot";
            case Sensor.REPORTING_MODE_SPECIAL_TRIGGER: return "special_trigger";
            default: return "unknown";
        }
    }

    /** JSON no admite NaN ni infinitos. */
    static double finite(float v) {
        return Float.isNaN(v) || Float.isInfinite(v) ? 0.0 : round3(v);
    }

    static double round3(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }

    /** Inventario completo; vacío si el móvil no da lista. */
    static JSONArray inventory(SensorManager manager) {
        JSONArray out = new JSONArray();
        if (manager == null) return out;
        List<Sensor> list;
        try {
            list = manager.getSensorList(Sensor.TYPE_ALL);
        } catch (RuntimeException e) {
            return out;
        }
        if (list == null) return out;
        for (Sensor s : list) {
            try {
                out.put(describe(s));
            } catch (JSONException | RuntimeException ignored) {
                // Un sensor ilegible no impide inventariar el resto.
            }
        }
        return out;
    }

    /** Las exclusiones como JSON, para el esquema del export. */
    static JSONArray excluded() {
        JSONArray out = new JSONArray();
        for (String[] e : EXCLUDED) {
            try {
                out.put(new JSONObject().put("type", e[0]).put("reason", e[1]));
            } catch (JSONException ignored) {
                // No ocurre con cadenas.
            }
        }
        return out;
    }

    /**
     * Agregado de una ventana de lecturas de un sensor: n, media, mínimo,
     * máximo y desviación típica por componente (hasta {@link #MAX_AXES}).
     * Acumula con Welford, sin guardar las muestras.
     */
    static final class Agg {
        static final int MAX_AXES = 4;
        int n;
        int axes;
        final double[] mean = new double[MAX_AXES];
        final double[] m2 = new double[MAX_AXES];
        final double[] min = new double[MAX_AXES];
        final double[] max = new double[MAX_AXES];

        void add(float[] values, int length) {
            if (values == null || length <= 0) return;
            int a = Math.min(length, MAX_AXES);
            if (n == 0) axes = a;
            else a = Math.min(a, axes);
            for (int i = 0; i < a; i++) {
                double v = values[i];
                if (Double.isNaN(v) || Double.isInfinite(v)) return;
            }
            n++;
            for (int i = 0; i < a; i++) {
                double v = values[i];
                if (n == 1) {
                    min[i] = v;
                    max[i] = v;
                } else {
                    if (v < min[i]) min[i] = v;
                    if (v > max[i]) max[i] = v;
                }
                double d = v - mean[i];
                mean[i] += d / n;
                m2[i] += d * (v - mean[i]);
            }
        }

        double sd(int i) {
            return n > 1 ? Math.sqrt(m2[i] / n) : 0.0;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject().put("n", n);
            JSONArray mm = new JSONArray(), lo = new JSONArray(), hi = new JSONArray(), sdv = new JSONArray();
            for (int i = 0; i < axes; i++) {
                mm.put(round3(mean[i]));
                lo.put(round3(min[i]));
                hi.put(round3(max[i]));
                sdv.put(round3(sd(i)));
            }
            return o.put("mean", mm).put("min", lo).put("max", hi).put("sd", sdv);
        }
    }

    /** Resumen legible para los registros: {@code accelerometer:41}. */
    static String summary(JSONObject sensors) {
        StringBuilder sb = new StringBuilder();
        java.util.Iterator<String> it = sensors.keys();
        while (it.hasNext()) {
            String k = it.next();
            if (sb.length() > 0) sb.append(',');
            sb.append(String.format(Locale.ROOT, "%s:%d", k, sensors.optJSONObject(k) == null ? 0
                : sensors.optJSONObject(k).optInt("n")));
        }
        return sb.toString();
    }
}
