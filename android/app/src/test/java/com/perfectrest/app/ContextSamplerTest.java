package com.perfectrest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Pruebas de la lógica pura del muestreo de contexto y de la fusión de eventos
 * del registro bruto, sin dispositivo. Los códigos tienen que coincidir con los
 * de {@code src/lib/rawEvents.ts}.
 */
public class ContextSamplerTest {

    @Test
    public void soloSeAnotaLoQueCambiaOCaducaLaUltimaLectura() {
        long now = 10_000_000L;
        // Nunca anotado: se anota.
        assertTrue(ContextSampler.shouldLog(null, 1, now, 0));
        // Mismo valor y reciente: no.
        assertFalse(ContextSampler.shouldLog(new long[] {1, now - 60_000L}, 1, now, 0));
        // Otro valor: sí.
        assertTrue(ContextSampler.shouldLog(new long[] {1, now - 60_000L}, 2, now, 0));
        // Mismo valor pero pasada la lectura de refresco: sí, para poder reconstruir la noche.
        assertTrue(ContextSampler.shouldLog(
            new long[] {1, now - ContextSampler.REFRESH_MS - 1}, 1, now, 0));
        // Continuos: la batería no se anota por 1 punto, sí por 5.
        assertFalse(ContextSampler.shouldLog(new long[] {80, now - 60_000L}, 79, now, 4));
        assertTrue(ContextSampler.shouldLog(new long[] {80, now - 60_000L}, 75, now, 4));
        // Tolerancia negativa: se anota siempre (al enchufar o desenchufar).
        assertTrue(ContextSampler.shouldLog(new long[] {80, now - 60_000L}, 80, now, -1));
    }

    @Test
    public void tipoDeCargaDesdeElSistema() {
        assertEquals(ContextSampler.CHARGE_NONE, ContextSampler.chargeCode(0));
        assertEquals(ContextSampler.CHARGE_AC, ContextSampler.chargeCode(1));
        assertEquals(ContextSampler.CHARGE_USB, ContextSampler.chargeCode(2));
        assertEquals(ContextSampler.CHARGE_WIRELESS, ContextSampler.chargeCode(4));
        assertEquals(ContextSampler.CHARGE_DOCK, ContextSampler.chargeCode(8));
        // Pared y USB a la vez: manda la pared.
        assertEquals(ContextSampler.CHARGE_AC, ContextSampler.chargeCode(3));
    }

    @Test
    public void bateriaYBrilloEnPorcentaje() {
        assertEquals(50, ContextSampler.batteryPct(50, 100));
        assertEquals(100, ContextSampler.batteryPct(255, 255));
        assertEquals(-1, ContextSampler.batteryPct(-1, 100));
        assertEquals(-1, ContextSampler.batteryPct(50, 0));
        assertEquals(0, ContextSampler.brightnessPct(0));
        assertEquals(100, ContextSampler.brightnessPct(255));
        assertEquals(-1, ContextSampler.brightnessPct(-1));
        // Algunos móviles pasan de 255: se acota.
        assertEquals(100, ContextSampler.brightnessPct(400));
    }

    @Test
    public void redPorPrioridadSinNombresDeRed() {
        assertEquals(ContextSampler.NET_WIFI, ContextSampler.netCode(true, true, false));
        assertEquals(ContextSampler.NET_CELLULAR, ContextSampler.netCode(false, true, false));
        assertEquals(ContextSampler.NET_ETHERNET, ContextSampler.netCode(false, false, true));
        assertEquals(ContextSampler.NET_OTHER, ContextSampler.netCode(false, false, false));
    }

    @Test
    public void bluetoothSoloCuentaAudio() {
        // Auricular: aparece como música (8) y como llamadas (7): es uno.
        assertEquals(1, ContextSampler.countBluetoothAudio(new int[] {2, 8, 7}));
        // Dos salidas de música.
        assertEquals(2, ContextSampler.countBluetoothAudio(new int[] {8, 26}));
        // Sólo llamadas.
        assertEquals(1, ContextSampler.countBluetoothAudio(new int[] {7}));
        // Altavoz del móvil y cable: ninguno.
        assertEquals(0, ContextSampler.countBluetoothAudio(new int[] {2, 3}));
        assertEquals(0, ContextSampler.countBluetoothAudio(new int[] {}));
    }

    @Test
    public void losCodigosCoincidenConLaCapaWeb() {
        // src/lib/rawEvents.ts: CHARGE_* y NET_*.
        assertEquals(0, ContextSampler.CHARGE_NONE);
        assertEquals(1, ContextSampler.CHARGE_AC);
        assertEquals(2, ContextSampler.CHARGE_USB);
        assertEquals(3, ContextSampler.CHARGE_WIRELESS);
        assertEquals(4, ContextSampler.CHARGE_DOCK);
        assertEquals(0, ContextSampler.NET_NONE);
        assertEquals(1, ContextSampler.NET_WIFI);
        assertEquals(2, ContextSampler.NET_CELLULAR);
        assertEquals(3, ContextSampler.NET_ETHERNET);
        assertEquals(4, ContextSampler.NET_OTHER);
    }

    @Test
    public void elMuestreoNoGastaBateriaNiMolestaConLasPantallasSeguidas() {
        // Un encendido de pantalla por notificación no dispara una lectura completa cada vez.
        assertTrue(ContextSampler.MIN_SPACING_MS >= 2 * 60_000L);
        // Y la lectura de refresco es de horas, no de minutos.
        assertTrue(ContextSampler.REFRESH_MS >= 3 * 60 * 60_000L);
    }

    private static JSONArray log(Object... kindAtValue) throws JSONException {
        JSONArray a = new JSONArray();
        for (int i = 0; i < kindAtValue.length; i += 3) {
            a.put(new JSONObject()
                .put("kind", kindAtValue[i])
                .put("at", (Long) kindAtValue[i + 1])
                .put("v", (Long) kindAtValue[i + 2]));
        }
        return a;
    }

    @Test
    public void lasEntradasDelMismoTipoSeFundenAunqueHayaOtrasEntreMedias() throws JSONException {
        // Pasos, luego una lectura de batería intercalada, luego otra vez pasos.
        JSONArray events = log("steps", 1_000L, 5L, "batt", 2_000L, 80L);
        JSONObject steps = RawEventLog.recent(events, "steps", 30_000L, 60_000L);
        assertNotNull(steps);
        assertSame(events.getJSONObject(0), steps);
        // Fuera de la ventana de fusión: entrada nueva.
        assertNull(RawEventLog.recent(events, "steps", 100_000L, 60_000L));
        // Otro tipo que no está.
        assertNull(RawEventLog.recent(events, "light", 3_000L, 60_000L));
        // Se queda con la más reciente del tipo, no con una vieja.
        JSONArray two = log("steps", 1_000L, 5L, "steps", 90_000L, 7L);
        assertSame(two.getJSONObject(1), RawEventLog.recent(two, "steps", 100_000L, 60_000L));
    }

    @Test
    public void laFusionSoloMiraUnasPocasEntradasHaciaAtras() throws JSONException {
        JSONArray many = new JSONArray();
        many.put(new JSONObject().put("kind", "steps").put("at", 1_000L).put("v", 1L));
        for (int i = 0; i < 20; i++) {
            many.put(new JSONObject().put("kind", "batt").put("at", 2_000L + i).put("v", 50L));
        }
        assertNull(RawEventLog.recent(many, "steps", 3_000L, 60_000L));
    }
}
