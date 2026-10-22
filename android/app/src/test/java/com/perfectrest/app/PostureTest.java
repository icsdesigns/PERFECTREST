package com.perfectrest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Random;

import org.junit.Test;

/**
 * Pruebas de la lógica pura del sensor de postura y de la reanudación de
 * huecos, sin dispositivo: la clasificación recibe ráfagas inventadas del
 * acelerómetro. Los umbrales son los de {@link SensorWatcher}; si se
 * recalibran con datos reales, estas ráfagas deben seguir cayendo del mismo lado.
 */
public class PostureTest {

    /** Gravedad inclinada {@code tiltDeg} respecto a la horizontal, con ruido gaussiano por eje. */
    private static int burst(double tiltDeg, boolean faceDown, double sd, int n, double g) {
        Random r = new Random(42);
        double t = Math.toRadians(tiltDeg);
        double gz = g * Math.cos(t) * (faceDown ? -1 : 1);
        double gx = g * Math.sin(t);
        float[] x = new float[n];
        float[] y = new float[n];
        float[] z = new float[n];
        for (int i = 0; i < n; i++) {
            x[i] = (float) (gx + r.nextGaussian() * sd);
            y[i] = (float) (r.nextGaussian() * sd);
            z[i] = (float) (gz + r.nextGaussian() * sd);
        }
        return SensorWatcher.classifyPosture(x, y, z, n);
    }

    @Test
    public void planoYQuietoEnMesaOCama() {
        assertEquals(SensorWatcher.POSTURE_FLAT_UP, burst(2, false, 0.02, 40, 9.81));
        assertEquals(SensorWatcher.POSTURE_FLAT_DOWN, burst(3, true, 0.02, 40, 9.81));
        // Un colchón blando: 10° y algo de temblor siguen siendo plano.
        assertEquals(SensorWatcher.POSTURE_FLAT_UP, burst(10, false, 0.15, 40, 9.81));
    }

    @Test
    public void inclinadoQuietoNoEsBolsillo() {
        assertEquals(SensorWatcher.POSTURE_TILTED, burst(45, false, 0.03, 40, 9.81));
    }

    @Test
    public void inclinadoConVaivenEsBolsilloOMano() {
        assertEquals(SensorWatcher.POSTURE_CARRIED, burst(60, false, 1.2, 40, 9.81));
        assertEquals(SensorWatcher.POSTURE_CARRIED, burst(40, false, 0.3, 40, 9.81));
        // Plano pero agitado: se acaba de coger de la mesa.
        assertEquals(SensorWatcher.POSTURE_CARRIED, burst(5, false, 1.5, 40, 9.81));
    }

    @Test
    public void lecturasInservibles() {
        assertEquals(SensorWatcher.POSTURE_INVALID, burst(2, false, 0.02, 5, 9.81));
        assertEquals(SensorWatcher.POSTURE_INVALID, burst(2, false, 0.02, 40, 0.5));
        assertEquals(SensorWatcher.POSTURE_INVALID, burst(2, false, 0.02, 40, 30));
    }

    @Test
    public void valoresCoincidenConLaCapaWeb() {
        // src/lib/rawEvents.ts: POSTURE_FLAT_UP/DOWN/CARRIED/TILTED = 0/1/2/3.
        assertEquals(0, SensorWatcher.POSTURE_FLAT_UP);
        assertEquals(1, SensorWatcher.POSTURE_FLAT_DOWN);
        assertEquals(2, SensorWatcher.POSTURE_CARRIED);
        assertEquals(3, SensorWatcher.POSTURE_TILTED);
    }

    @Test
    public void elVigilanteSoloAceleraDeNocheConLaPostura() {
        assertEquals(10 * 60_000L, SleepMonitorService.watchdogIntervalMs(true, true));
        // De día no hay lecturas que hacer: no se despierta el móvil de más.
        assertEquals(15 * 60_000L, SleepMonitorService.watchdogIntervalMs(true, false));
        assertEquals(15 * 60_000L, SleepMonitorService.watchdogIntervalMs(false, true));
        // Por encima de los nueve minutos entre alarmas en reposo de Android.
        assertTrue(SleepMonitorService.watchdogIntervalMs(true, true) > 9 * 60_000L);
    }

    @Test
    public void ventanaNocturnaQueCruzaMedianoche() {
        int start = 21 * 60 + 30;
        int end = 11 * 60;
        assertTrue(SleepMonitorService.inNightWindow(start, end, 23 * 60));
        assertTrue(SleepMonitorService.inNightWindow(start, end, 3 * 60));
        assertFalse(SleepMonitorService.inNightWindow(start, end, 15 * 60));
        // Ventana que no cruza medianoche (quien duerme de día).
        assertTrue(SleepMonitorService.inNightWindow(8 * 60, 16 * 60, 12 * 60));
        assertFalse(SleepMonitorService.inNightWindow(8 * 60, 16 * 60, 23 * 60));
    }

    @Test
    public void laLecturaTrasApagarLaPantallaEsperaASoltarElMovil() {
        // Ni tan corta que pille el móvil aún en la mano, ni tanto que se la
        // salte el espaciado mínimo entre lecturas.
        assertTrue(SensorWatcher.POSTURE_SETTLE_MS >= 30_000L);
        assertTrue(SensorWatcher.POSTURE_SETTLE_MS < 4 * 60_000L);
    }

    @Test
    public void unVistazoReanudaElHuecoPeroUnUsoSostenidoNo() {
        assertTrue(SleepMonitorService.canResume("screen", 40_000L));
        assertTrue(SleepMonitorService.canResume("screen", 299_000L));
        // Doce minutos de móvil en la mano: lo anterior no es sueño.
        assertFalse(SleepMonitorService.canResume("screen", 12 * 60_000L));
        // Los demás disparadores no miden uso y conservan el margen largo.
        assertTrue(SleepMonitorService.canResume("idle", 14 * 60_000L));
        assertFalse(SleepMonitorService.canResume("idle", 16 * 60_000L));
        assertTrue(SleepMonitorService.canResume("charger", 10 * 60_000L));
    }
}
