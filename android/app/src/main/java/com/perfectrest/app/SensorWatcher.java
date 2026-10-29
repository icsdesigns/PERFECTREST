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
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
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
 *   posture    postura del móvil con el acelerómetro, en lecturas puntuales: con
 *              la pantalla apagada y de noche, en cada rearme del vigilante
 *              (cada diez minutos con este sensor) y unos segundos después de
 *              apagarse la pantalla, se escucha el acelerómetro
 *              unos dos segundos y se anota si el móvil está plano y quieto
 *              (sobre la mesa o la cama, boca arriba o abajo), inclinado y
 *              quieto (un soporte), o en el bolsillo o la mano (inclinado y con
 *              vaivén). Entre lecturas no hay nada registrado, y durante la
 *              lectura sólo un wakelock de unos segundos que se suelta solo.
 */
final class SensorWatcher {

    static final String STEPS = "steps";
    static final String LIGHT = "light";
    static final String PROXIMITY = "proximity";
    static final String ALARM = "alarm";
    static final String AUDIO = "audio";
    static final String POSTURE = "posture";

    /** Posturas anotadas en el registro bruto; los mismos valores que {@code POSTURE_*} en rawEvents.ts. */
    static final int POSTURE_FLAT_UP = 0;
    static final int POSTURE_FLAT_DOWN = 1;
    static final int POSTURE_CARRIED = 2;
    static final int POSTURE_TILTED = 3;
    /** La lectura no sirve (el móvil cae, o el sensor entrega basura). */
    static final int POSTURE_INVALID = -1;

    /** Cuánto se escucha el acelerómetro en cada lectura. */
    private static final long POSTURE_WINDOW_MS = 2_500L;
    /** Tope de muestras por lectura (con SENSOR_DELAY_UI salen unas 40). */
    private static final int POSTURE_MAX_SAMPLES = 96;
    /** Por debajo de esto la lectura no es fiable. */
    private static final int POSTURE_MIN_SAMPLES = 8;
    /** Dos lecturas más cerca que esto se funden en una: un SCREEN_OFF y el vigilante no suman dos. */
    private static final long POSTURE_MIN_SPACING_MS = 4 * 60_000L;
    /** El wakelock de la lectura se suelta solo aunque algo falle. */
    private static final long POSTURE_WAKELOCK_MS = 6_000L;
    /**
     * Espera tras apagarse la pantalla antes de leer: en ese instante el móvil
     * casi siempre sigue en la mano camino de la mesilla, y la lectura saldría
     * «en bolsillo o mano» cada vez que se mira la hora de madrugada.
     */
    static final long POSTURE_SETTLE_MS = 45_000L;
    /**
     * Umbrales sin calibrar con datos reales: ver «Limitaciones» en el README.
     * Inclinación máxima respecto a la horizontal para dar el móvil por plano.
     */
    static final float POSTURE_FLAT_MAX_TILT_DEG = 15f;
    /** Plano: el vaivén (desviación típica de la aceleración, m/s²) que aún se da por mesa o cama. */
    static final float POSTURE_FLAT_MAX_SD = 0.35f;
    /** Inclinado: por encima de este vaivén se lleva encima. */
    static final float POSTURE_TILTED_MAX_SD = 0.12f;

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

    private final Handler postureHandler = new Handler(Looper.getMainLooper());
    private SensorEventListener postureListener;
    private PowerManager.WakeLock postureLock;
    private long lastPostureAt = 0L;
    private final float[] posX = new float[POSTURE_MAX_SAMPLES];
    private final float[] posY = new float[POSTURE_MAX_SAMPLES];
    private final float[] posZ = new float[POSTURE_MAX_SAMPLES];
    private int posN = 0;
    /** Lectura aplazada tras apagarse la pantalla (ver {@link #POSTURE_SETTLE_MS}). */
    private final Runnable settledReading = () -> {
        if (windowWanted()) samplePosture(System.currentTimeMillis());
    };
    /** Cierre de la lectura en curso cuando se agota su ventana. */
    private final Runnable readingTimeout = () -> endPostureReading(true);

    private float lastStepCount = -1f;
    private int lastLightLevel = -1;
    private int lastProximity = -1;
    private long lastMotionAt = 0L;
    private boolean audioWasActive = false;
    private long lastAudioLoggedAt = 0L;
    private long lastAlarmAt = -1L;
    /**
     * Con el contexto del dispositivo activo también se anotan la próxima alarma
     * y el audio sonando aunque no sean sensores de detección (son consultas, no
     * escuchas), y los lux de la luz.
     */
    private boolean contextExtras = false;
    /**
     * «Registrar todos los sensores disponibles»: en cada ventana corta de la
     * postura se leen también los demás sensores no sensibles y se archiva un
     * agregado por sensor (ver {@link SensorCatalog}). Necesita el archivo
     * histórico activo, que es donde se guardan las lecturas.
     */
    private boolean allSensors = false;
    /** Sensores extra abiertos durante la ventana en curso, y lo que van acumulando. */
    private SensorEventListener extraListener;
    private final java.util.Map<String, SensorCatalog.Agg> extraAggs = new java.util.LinkedHashMap<>();
    /** Por debajo de este nivel de batería (sin cargar) las ventanas sólo leen la postura. */
    private static final int ALL_SENSORS_MIN_BATTERY = 15;

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
        for (String id : new String[] {STEPS, LIGHT, PROXIMITY, ALARM, AUDIO, POSTURE}) {
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

    /** Activa o apaga las consultas extra del contexto del dispositivo (ver {@link #contextExtras}). */
    void setContextExtras(boolean on) {
        contextExtras = on;
    }

    /** Activa o apaga la lectura de todos los sensores en las ventanas de muestreo. */
    void setAllSensors(boolean on) {
        allSensors = on;
    }

    /** ¿Hay que abrir ventana de muestreo? Por la postura o por los demás sensores. */
    private boolean windowWanted() {
        return active.contains(POSTURE) || (allSensors && HistoryArchive.enabled(context));
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
                case POSTURE:
                    // Tampoco hay escucha permanente: el acelerómetro sólo se
                    // abre unos segundos en cada lectura. Aquí basta con que exista.
                    if (sensors == null || sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) == null) {
                        return false;
                    }
                    SleepMonitorService.logEvent(context, null, "service", "postura del móvil activa");
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
            case POSTURE:
                postureHandler.removeCallbacks(settledReading);
                endPostureReading(false);
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
        long at = eventTimeMs(event.timestamp);
        RawEventLog.addMerged(context, at, "light", level, LIGHT_MERGE_MS, true);
        // Los lux del cambio de nivel, para el contexto de la noche: el nivel
        // dice si se apagó la luz y esto, cuánta había.
        if (contextExtras) {
            RawEventLog.addMerged(context, at, "lux", Math.round(lux), LIGHT_MERGE_MS, true);
        }
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
        sample(false);
    }

    /**
     * Como {@link #sample()}; con {@code screenJustOff} la lectura de postura se
     * aplaza {@link #POSTURE_SETTLE_MS} para que el móvil llegue a soltarse. El
     * aplazamiento no retiene el procesador: si se duerme antes, la lectura se
     * hace en cuanto despierte (o la toma el vigilante) y vuelve a comprobar que
     * la pantalla sigue apagada y que es de noche.
     */
    void sample(boolean screenJustOff) {
        long now = System.currentTimeMillis();

        if (active.contains(ALARM) || contextExtras) {
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

        if (active.contains(AUDIO) || contextExtras) {
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

        if (windowWanted()) {
            if (screenJustOff) {
                postureHandler.removeCallbacks(settledReading);
                postureHandler.postDelayed(settledReading, POSTURE_SETTLE_MS);
            } else {
                samplePosture(now);
            }
        }
    }

    // --- Postura: lecturas puntuales del acelerómetro ---

    /**
     * Una lectura de postura, si toca: de noche, con la pantalla apagada y sin
     * otra reciente. Es asíncrona —los eventos del sensor llegan por el bucle
     * principal— y por eso no bloquea nada: abre el acelerómetro, lo escucha
     * {@link #POSTURE_WINDOW_MS} y lo cierra.
     */
    private void samplePosture(long now) {
        if (sensors == null || postureListener != null || extraListener != null) return;
        if (now - lastPostureAt < POSTURE_MIN_SPACING_MS) return;
        // Con la pantalla encendida el móvil está en uso, no en reposo.
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (power == null || power.isInteractive()) return;
        // Sólo importa la noche: fuera de ella las lecturas llenarían el registro bruto.
        if (!SleepMonitorService.inNightWindow(context, now)) return;

        Sensor accel = active.contains(POSTURE) || allSensors
            ? sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) : null;
        boolean extras = allSensors && HistoryArchive.enabled(context) && batteryAllows();
        if (accel == null && !extras) return;

        // Sin esto el procesador puede dormirse a mitad de lectura. Se suelta
        // solo: no hay ningún wakelock que alguien tenga que acordarse de liberar.
        try {
            postureLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PerfectRest:postura");
            postureLock.setReferenceCounted(false);
            postureLock.acquire(POSTURE_WAKELOCK_MS);
        } catch (RuntimeException e) {
            postureLock = null;
        }

        posN = 0;
        lastPostureAt = now;
        postureListener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                if (event.values == null || event.values.length < 3 || posN >= POSTURE_MAX_SAMPLES) return;
                posX[posN] = event.values[0];
                posY[posN] = event.values[1];
                posZ[posN] = event.values[2];
                posN++;
                if (posN >= POSTURE_MAX_SAMPLES) endPostureReading(true);
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        boolean ok = false;
        if (accel != null) {
            try {
                ok = sensors.registerListener(postureListener, accel, SensorManager.SENSOR_DELAY_UI);
            } catch (RuntimeException e) {
                ok = false;
            }
        }
        if (!ok) postureListener = null;
        boolean extraOk = extras && startExtras();
        if (!ok && !extraOk) {
            releasePostureLock();
            return;
        }
        if (!ok) {
            // Sin acelerómetro la ventana sigue por los demás sensores.
            postureListener = null;
        }
        postureHandler.postDelayed(readingTimeout, POSTURE_WINDOW_MS);
    }

    /** ¿Hay batería para leer más sensores? Cargando, siempre. */
    private boolean batteryAllows() {
        try {
            android.content.Intent b = context.registerReceiver(null,
                new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
            if (b == null) return true;
            int level = b.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1);
            int scale = b.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100);
            int plugged = b.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0);
            return plugged != 0 || level < 0 || scale <= 0 || level * 100 / scale >= ALL_SENSORS_MIN_BATTERY;
        } catch (RuntimeException e) {
            return true;
        }
    }

    /**
     * Abre, para esta ventana, el resto de sensores no sensibles que tenga el
     * móvil (ver {@link SensorCatalog#SAMPLED_TYPES}). Cada tipo que falte se
     * ignora. Devuelve si quedó alguno abierto.
     */
    private boolean startExtras() {
        extraAggs.clear();
        extraListener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                String key = SensorCatalog.keyOf(event.sensor);
                SensorCatalog.Agg agg = extraAggs.get(key);
                if (agg == null) {
                    agg = new SensorCatalog.Agg();
                    extraAggs.put(key, agg);
                }
                // El paso suelto no trae valor: cuenta como una muestra de 1.
                agg.add(event.values, event.values == null ? 0 : event.values.length);
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        boolean any = false;
        boolean stepsOk = activityPermissionGranted(context);
        for (int type : SensorCatalog.SAMPLED_TYPES) {
            if (type == Sensor.TYPE_ACCELEROMETER) continue; // ya lo lee la postura
            if (SensorCatalog.needsActivityPermission(type) && !stepsOk) continue;
            try {
                Sensor s = sensors.getDefaultSensor(type);
                if (s == null) continue;
                // Los disparos únicos y los especiales no se pueden leer así.
                int mode = s.getReportingMode();
                if (mode == Sensor.REPORTING_MODE_ONE_SHOT) continue;
                if (sensors.registerListener(extraListener, s, SensorManager.SENSOR_DELAY_NORMAL)) any = true;
            } catch (RuntimeException ignored) {
                // Este sensor falla; los demás siguen.
            }
        }
        if (!any) extraListener = null;
        return any;
    }

    /** Cierra los sensores extra y archiva un agregado por sensor. */
    private void endExtras(boolean record, long now, SensorCatalog.Agg accel) {
        if (extraListener != null) {
            if (sensors != null) sensors.unregisterListener(extraListener);
            extraListener = null;
        }
        if (record) {
            try {
                if (accel != null && accel.n > 0) extraAggs.put("accelerometer", accel);
                if (!extraAggs.isEmpty()) {
                    org.json.JSONObject s = new org.json.JSONObject();
                    for (java.util.Map.Entry<String, SensorCatalog.Agg> e : extraAggs.entrySet()) {
                        if (e.getValue().n > 0) s.put(e.getKey(), e.getValue().toJson());
                    }
                    if (s.length() > 0 && HistoryArchive.enabled(context)) {
                        org.json.JSONObject reading = new org.json.JSONObject()
                            .put("at", now).put("kind", "sensors").put("ms", POSTURE_WINDOW_MS).put("s", s);
                        HistoryArchive.forContext(context).appendReading(reading, now);
                    }
                }
            } catch (org.json.JSONException | java.io.IOException | RuntimeException ignored) {
                // Un fallo al archivar no debe tumbar el servicio.
            }
        }
        extraAggs.clear();
    }

    /** Cierra la lectura en curso; con {@code record}, clasifica y anota lo recogido. */
    private void endPostureReading(boolean record) {
        postureHandler.removeCallbacks(readingTimeout);
        SensorCatalog.Agg accel = null;
        if (postureListener != null) {
            if (sensors != null) sensors.unregisterListener(postureListener);
            postureListener = null;
            if (record) {
                if (allSensors) {
                    accel = new SensorCatalog.Agg();
                    float[] v = new float[3];
                    for (int i = 0; i < posN; i++) {
                        v[0] = posX[i];
                        v[1] = posY[i];
                        v[2] = posZ[i];
                        accel.add(v, 3);
                    }
                }
                if (active.contains(POSTURE)) {
                    int posture = classifyPosture(posX, posY, posZ, posN);
                    if (posture != POSTURE_INVALID) {
                        RawEventLog.addSensor(context, System.currentTimeMillis(), "posture", posture);
                    }
                }
            }
        }
        if (extraListener != null || !extraAggs.isEmpty()) {
            endExtras(record, System.currentTimeMillis(), accel);
        }
        posN = 0;
        releasePostureLock();
    }

    private void releasePostureLock() {
        if (postureLock != null && postureLock.isHeld()) {
            try {
                postureLock.release();
            } catch (RuntimeException ignored) {
                // Ya se había soltado por tiempo.
            }
        }
        postureLock = null;
    }

    /**
     * Postura a partir de una ráfaga del acelerómetro, en m/s².
     *
     * La media da la gravedad: con el móvil quieto es el vector hacia abajo, y
     * su ángulo con el eje Z de la pantalla dice cuánto está inclinado (y el
     * signo de Z, si la pantalla mira arriba o abajo). La desviación típica
     * dice cuánto se mueve. Es una función pura, sin sensores, para poder
     * probarla con ráfagas inventadas.
     *
     *   plano (≤ 15° de la horizontal)   y casi sin vaivén  → plano, arriba o abajo
     *   inclinado y casi sin vaivén                         → inclinado quieto (soporte, mano firme)
     *   con vaivén (plano: mucho; inclinado: poco)          → en bolsillo o mano
     */
    static int classifyPosture(float[] x, float[] y, float[] z, int n) {
        if (n < POSTURE_MIN_SAMPLES) return POSTURE_INVALID;
        double mx = 0, my = 0, mz = 0;
        for (int i = 0; i < n; i++) {
            mx += x[i];
            my += y[i];
            mz += z[i];
        }
        mx /= n;
        my /= n;
        mz /= n;
        double mag = Math.sqrt(mx * mx + my * my + mz * mz);
        // Una media lejos de 9,8 m/s² es caída libre o un sensor roto, no una postura.
        if (mag < 6.0 || mag > 14.0) return POSTURE_INVALID;

        double var = 0;
        for (int i = 0; i < n; i++) {
            double dx = x[i] - mx, dy = y[i] - my, dz = z[i] - mz;
            var += dx * dx + dy * dy + dz * dz;
        }
        double sd = Math.sqrt(var / n);
        double tilt = Math.toDegrees(Math.acos(Math.min(1.0, Math.abs(mz) / mag)));

        if (tilt <= POSTURE_FLAT_MAX_TILT_DEG) {
            if (sd > POSTURE_FLAT_MAX_SD) return POSTURE_CARRIED;
            return mz > 0 ? POSTURE_FLAT_UP : POSTURE_FLAT_DOWN;
        }
        return sd > POSTURE_TILTED_MAX_SD ? POSTURE_CARRIED : POSTURE_TILTED;
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
        out.put(POSTURE, new JSONObject().put("available",
            manager != null && manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null));
        return out;
    }

    /** ¿Está concedido el permiso de actividad física (o no hace falta)? */
    static boolean activityPermissionGranted(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION)
                == PackageManager.PERMISSION_GRANTED;
    }
}
