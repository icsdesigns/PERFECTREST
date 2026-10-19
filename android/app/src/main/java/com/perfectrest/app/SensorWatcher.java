package com.perfectrest.app;

import android.Manifest;
import android.app.AlarmManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.TriggerEvent;
import android.hardware.TriggerEventListener;
import android.media.AudioManager;
import android.os.Build;
import android.os.SystemClock;

import androidx.core.content.ContextCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Sensores baratos que afinan la detección del sueño (fase 2).
 *
 * Los disparadores de {@link SleepMonitorService} miden cuándo se usa el
 * móvil; esto mide qué pasa alrededor de él mientras no se usa. Cada sensor
 * deja sus eventos en el registro bruto ({@link RawEventLog}) y la capa web los
 * cruza con cada hueco para saber cuándo hubo actividad real antes de la
 * quietud larga y cuándo hubo un despertar real. El servicio no decide nada.
 *
 * Todos son opcionales, se activan por separado desde Ajustes y se degradan sin
 * hacer ruido: sin el sensor o sin el permiso, simplemente no registran nada y
 * {@link #describe} lo cuenta a la app. Ninguno usa el micrófono.
 *
 * Muestreo muy ligero y sin wakelocks:
 *
 *   steps      contador de pasos con latencia de entrega de diez minutos: el
 *              sensor acumula en su propio búfer y no despierta el procesador.
 *              Sin permiso «Actividad física» (Android 10+) o sin contador, cae
 *              al movimiento significativo, que no pide permiso.
 *   light      sensor de luz, por cambio, en tres niveles (oscuro, tenue, claro)
 *              y con la misma entrega diferida. Sólo se anotan los cambios de nivel.
 *   proximity  sensor de proximidad, por cambio, en su variante que no despierta
 *              al procesador (si el móvil sólo tiene la que despierta, se omite).
 *   alarm      la próxima alarma del reloj, consultada al apagarse la pantalla y
 *              con cada rearme del vigilante; no hay nada que escuchar.
 *   audio      si suena algo, consultado en esos mismos momentos.
 */
final class SensorWatcher {

    static final String STEPS = "steps";
    static final String LIGHT = "light";
    static final String PROXIMITY = "proximity";
    static final String ALARM = "alarm";
    static final String AUDIO = "audio";

    /** Los sensores muestreados son los que entregan lotes: el búfer del chip hace el trabajo. */
    private static final int BATCH_LATENCY_US = 10 * 60 * 1_000_000;
    /** Entradas de pasos del mismo minuto se funden en una. */
    private static final long STEPS_MERGE_MS = 60_000L;
    /** El nivel de luz sólo conserva el último valor de cada diez segundos. */
    private static final long LIGHT_MERGE_MS = 10_000L;
    /** Dos avisos de movimiento significativo seguidos son un único paseo. */
    private static final long MOTION_MERGE_MS = 2 * 60_000L;
    /** Una muestra de audio repetida no se anota otra vez hasta pasado este tiempo. */
    private static final long AUDIO_REPEAT_MS = 60_000L;

    /** Niveles de luz: por debajo de 5 lux es oscuro, por encima de 50 es claro. */
    private static final float LUX_DARK = 5f;
    private static final float LUX_BRIGHT = 50f;

    private final Context context;
    private final SensorManager sensors;
    private final Set<String> active = new HashSet<>();

    private SensorEventListener stepListener;
    private SensorEventListener lightListener;
    private SensorEventListener proximityListener;
    private TriggerEventListener motionListener;
    private Sensor motionSensor;

    private float lastStepCount = -1f;
    private int lastLightLevel = -1;
    private int lastProximity = -1;
    private long lastMotionAt = 0L;
    private boolean audioWasActive = false;
    private long lastAudioLoggedAt = 0L;
    private long lastAlarmAt = -1L;

    SensorWatcher(Context context) {
        this.context = context.getApplicationContext();
        this.sensors = (SensorManager) this.context.getSystemService(Context.SENSOR_SERVICE);
    }

    /**
     * Deja registrados exactamente los sensores pedidos: da de alta los que
     * faltan y de baja los que sobran. Es idempotente, porque el servicio lo
     * llama en cada rearme.
     */
    void apply(Set<String> wanted) {
        for (String id : new String[] {STEPS, LIGHT, PROXIMITY, ALARM, AUDIO}) {
            boolean want = wanted.contains(id);
            boolean have = active.contains(id);
            if (want && !have) {
                if (start(id)) active.add(id);
            } else if (!want && have) {
                stop(id);
                active.remove(id);
            }
        }
        // Los pasos pueden haberse quedado en movimiento significativo por falta
        // de permiso: si ya está concedido, se pasa al contador.
        if (active.contains(STEPS) && stepListener == null && stepPermission()
            && sensors != null && sensors.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null) {
            stop(STEPS);
            if (!start(STEPS)) active.remove(STEPS);
        }
    }

    void stopAll() {
        for (String id : new HashSet<>(active)) stop(id);
        active.clear();
    }

    private boolean start(String id) {
        try {
            switch (id) {
                case STEPS: return startSteps();
                case LIGHT: return startLight();
                case PROXIMITY: return startProximity();
                case ALARM:
                case AUDIO:
                    // Sin escucha: se consultan en `sample`.
                    return true;
                default: return false;
            }
        } catch (SecurityException e) {
            SleepMonitorService.logEvent(context, null, "error",
                "Sensor «" + id + "» sin permiso: " + e.getMessage());
            return false;
        } catch (RuntimeException e) {
            SleepMonitorService.logEvent(context, null, "error",
                "Sensor «" + id + "» no disponible (" + e.getClass().getSimpleName() + ")");
            return false;
        }
    }

    private void stop(String id) {
        if (sensors == null) return;
        switch (id) {
            case STEPS:
                if (stepListener != null) sensors.unregisterListener(stepListener);
                stepListener = null;
                if (motionListener != null && motionSensor != null) {
                    sensors.cancelTriggerSensor(motionListener, motionSensor);
                }
                motionListener = null;
                lastStepCount = -1f;
                break;
            case LIGHT:
                if (lightListener != null) sensors.unregisterListener(lightListener);
                lightListener = null;
                lastLightLevel = -1;
                break;
            case PROXIMITY:
                if (proximityListener != null) sensors.unregisterListener(proximityListener);
                proximityListener = null;
                lastProximity = -1;
                break;
            default:
                break;
        }
    }

    // --- Pasos y movimiento ---

    private boolean stepPermission() {
        // Antes de Android 10 el contador de pasos no pide permiso.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean startSteps() {
        if (sensors == null) return false;
        Sensor counter = sensors.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        if (counter != null && stepPermission()) {
            stepListener = new SensorEventListener() {
                @Override
                public void onSensorChanged(SensorEvent event) {
                    onSteps(event);
                }

                @Override
                public void onAccuracyChanged(Sensor sensor, int accuracy) {}
            };
            if (sensors.registerListener(
                stepListener, counter, SensorManager.SENSOR_DELAY_NORMAL, BATCH_LATENCY_US)) {
                SleepMonitorService.logEvent(context, null, "service", "sensor de pasos activo");
                return true;
            }
            stepListener = null;
        }
        // Sin contador o sin permiso: el movimiento significativo no necesita ninguno.
        return startMotion(counter != null ? "pasos sin permiso" : "sin contador de pasos");
    }

    private boolean startMotion(String why) {
        motionSensor = sensors.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION);
        if (motionSensor == null) {
            SleepMonitorService.logEvent(context, null, "error",
                "Sin sensor de pasos ni de movimiento significativo (" + why + ")");
            return false;
        }
        motionListener = new TriggerEventListener() {
            @Override
            public void onTrigger(TriggerEvent event) {
                long now = System.currentTimeMillis();
                if (now - lastMotionAt >= MOTION_MERGE_MS) {
                    RawEventLog.addSensor(context, now, "motion", 1L);
                    lastMotionAt = now;
                }
                // Es de un solo disparo: hay que volver a armarlo.
                if (motionListener == this && sensors != null) {
                    sensors.requestTriggerSensor(this, motionSensor);
                }
            }
        };
        boolean ok = sensors.requestTriggerSensor(motionListener, motionSensor);
        if (ok) {
            SleepMonitorService.logEvent(context, null, "service",
                "movimiento significativo activo (" + why + ")");
        } else {
            motionListener = null;
        }
        return ok;
    }

    private void onSteps(SensorEvent event) {
        if (event.values == null || event.values.length == 0) return;
        float total = event.values[0];
        long at = eventTimeMs(event.timestamp);
        // El contador acumula desde el arranque del móvil: sólo el aumento es andar.
        if (lastStepCount >= 0f && total > lastStepCount) {
            RawEventLog.addMerged(context, at, "steps", (long) (total - lastStepCount),
                STEPS_MERGE_MS, false);
        }
        lastStepCount = total;
    }

    // --- Luz ---

    private boolean startLight() {
        if (sensors == null) return false;
        Sensor light = sensors.getDefaultSensor(Sensor.TYPE_LIGHT);
        if (light == null) return false;
        lightListener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                onLight(event);
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        boolean ok = sensors.registerListener(
            lightListener, light, SensorManager.SENSOR_DELAY_NORMAL, BATCH_LATENCY_US);
        if (!ok) lightListener = null;
        return ok;
    }

    private void onLight(SensorEvent event) {
        if (event.values == null || event.values.length == 0) return;
        float lux = event.values[0];
        int level = lux < LUX_DARK ? 0 : lux < LUX_BRIGHT ? 1 : 2;
        // Sólo cuentan los cambios de nivel: el sensor repite lecturas.
        if (level == lastLightLevel) return;
        lastLightLevel = level;
        RawEventLog.addMerged(context, eventTimeMs(event.timestamp), "light", level,
            LIGHT_MERGE_MS, true);
    }

    // --- Proximidad ---

    private boolean startProximity() {
        if (sensors == null) return false;
        // La variante por defecto suele ser de las que despiertan el procesador
        // en cada cambio; se pide expresamente la que no, y si no existe se omite
        // antes que gastar batería en un sensor que sólo da un dato accesorio.
        Sensor proximity = sensors.getDefaultSensor(Sensor.TYPE_PROXIMITY, false);
        if (proximity == null) return false;
        final float far = proximity.getMaximumRange();
        proximityListener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                if (event.values == null || event.values.length == 0) return;
                int near = event.values[0] < Math.min(far, 5f) ? 1 : 0;
                if (near == lastProximity) return;
                lastProximity = near;
                RawEventLog.addSensor(context, eventTimeMs(event.timestamp), "proximity", near);
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        boolean ok = sensors.registerListener(
            proximityListener, proximity, SensorManager.SENSOR_DELAY_NORMAL, BATCH_LATENCY_US);
        if (!ok) proximityListener = null;
        return ok;
    }

    // --- Alarma y audio: se consultan, no se escuchan ---

    /**
     * Consulta la próxima alarma y si suena algo. Se llama al apagarse la
     * pantalla y con cada rearme del vigilante (cada quince minutos): no hay
     * ningún temporizador propio ni wakelock, sólo aprovecha momentos en que el
     * servicio ya está despierto.
     */
    void sample() {
        long now = System.currentTimeMillis();

        if (active.contains(ALARM)) {
            AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarms != null) {
                AlarmManager.AlarmClockInfo next = alarms.getNextAlarmClock();
                long at = next == null ? 0L : next.getTriggerTime();
                if (at != lastAlarmAt) {
                    lastAlarmAt = at;
                    RawEventLog.addSensor(context, now, "alarm", at);
                }
            }
        }

        if (active.contains(AUDIO)) {
            AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            boolean playing = audio != null && audio.isMusicActive();
            if (playing) {
                // Mientras suene se repite cada muestra: la capa web da por sonando
                // cada una un cuarto de hora, y esa es la forma de cubrir una hora.
                if (now - lastAudioLoggedAt >= AUDIO_REPEAT_MS) {
                    RawEventLog.addSensor(context, now, "audio", 1L);
                    lastAudioLoggedAt = now;
                }
            } else if (audioWasActive) {
                RawEventLog.addSensor(context, now, "audio", 0L);
            }
            audioWasActive = playing;
        }
    }

    /** Los sensores marcan sus eventos con el reloj de arranque; la web usa la hora de pared. */
    private static long eventTimeMs(long sensorNanos) {
        long now = System.currentTimeMillis();
        long ageMs = (SystemClock.elapsedRealtimeNanos() - sensorNanos) / 1_000_000L;
        // Un reloj de sensor distinto del de arranque daría edades absurdas.
        if (ageMs < 0L || ageMs > 24L * 60L * 60_000L) return now;
        return now - ageMs;
    }

    // --- Qué hay en este móvil ---

    /**
     * Qué sensores tiene el móvil y cómo funcionaría cada uno, para que Ajustes
     * lo cuente en vez de dejar un interruptor que no hace nada.
     */
    static JSONObject describe(Context context) throws JSONException {
        SensorManager manager = (SensorManager) context.getSystemService(Context.SENSOR_SERVICE);
        boolean counter = manager != null && manager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null;
        boolean motion = manager != null
            && manager.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION) != null;
        boolean permission = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION)
                == PackageManager.PERMISSION_GRANTED;

        JSONObject steps = new JSONObject();
        steps.put("available", counter || motion);
        steps.put("needsPermission", counter && !permission);
        steps.put("mode", counter && permission ? "steps" : motion ? "motion" : "none");

        JSONObject out = new JSONObject();
        out.put(STEPS, steps);
        out.put(LIGHT, new JSONObject().put("available",
            manager != null && manager.getDefaultSensor(Sensor.TYPE_LIGHT) != null));
        out.put(PROXIMITY, new JSONObject().put("available",
            manager != null && manager.getDefaultSensor(Sensor.TYPE_PROXIMITY, false) != null));
        out.put(ALARM, new JSONObject().put("available",
            context.getSystemService(Context.ALARM_SERVICE) != null));
        out.put(AUDIO, new JSONObject().put("available",
            context.getSystemService(Context.AUDIO_SERVICE) != null));
        return out;
    }

    /** ¿Está concedido el permiso de actividad física (o no hace falta)? */
    static boolean activityPermissionGranted(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION)
                == PackageManager.PERMISSION_GRANTED;
    }
}
