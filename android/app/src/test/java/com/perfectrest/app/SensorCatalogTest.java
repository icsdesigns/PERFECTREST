package com.perfectrest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** Agregados y nombres del inventario de sensores, sin dispositivo. */
public class SensorCatalogTest {

    @Test
    public void agregaMediaMinimoMaximoYDesviacion() throws Exception {
        SensorCatalog.Agg a = new SensorCatalog.Agg();
        a.add(new float[] {1f, 10f, 0f}, 3);
        a.add(new float[] {3f, 10f, 0f}, 3);
        a.add(new float[] {5f, 10f, 0f}, 3);
        JSONObject j = a.toJson();
        assertEquals(3, j.getInt("n"));
        assertEquals(3.0, j.getJSONArray("mean").getDouble(0), 1e-9);
        assertEquals(1.0, j.getJSONArray("min").getDouble(0), 1e-9);
        assertEquals(5.0, j.getJSONArray("max").getDouble(0), 1e-9);
        assertEquals(Math.sqrt(8.0 / 3.0), j.getJSONArray("sd").getDouble(0), 1e-3);
        assertEquals(0.0, j.getJSONArray("sd").getDouble(1), 1e-9);
        assertEquals(3, j.getJSONArray("mean").length());
    }

    @Test
    public void ignoraLecturasNoFinitasYRecortaLosEjes() throws Exception {
        SensorCatalog.Agg a = new SensorCatalog.Agg();
        a.add(new float[] {Float.NaN, 1f}, 2);
        a.add(new float[] {1f, 2f, 3f, 4f, 5f, 6f}, 6);
        assertEquals(1, a.n);
        assertEquals(SensorCatalog.Agg.MAX_AXES, a.toJson().getJSONArray("mean").length());
        a.add(null, 0);
        assertEquals(1, a.n);
    }

    @Test
    public void nombreEstableDelTipo() {
        assertEquals("accelerometer", SensorCatalog.keyOfString("android.sensor.accelerometer", 1));
        assertEquals("type_99", SensorCatalog.keyOfString(null, 99));
        assertEquals("com.vendor.thing", SensorCatalog.keyOfString("com.vendor.thing", 100000));
    }

    @Test
    public void elRitmoCardiacoNuncaSeMuestrea() {
        for (String[] e : SensorCatalog.EXCLUDED) assertFalse(e[1].isEmpty());
        for (String k : SensorCatalog.SAMPLED_KEYS) {
            assertFalse(k.contains("heart"));
        }
        assertEquals(SensorCatalog.SAMPLED_KEYS.length, SensorCatalog.SAMPLED_TYPES.length);
        assertTrue(SensorCatalog.needsActivityPermission(19));
        assertFalse(SensorCatalog.needsActivityPermission(1));
    }

    @Test
    public void modosDeReporte() {
        assertEquals("continuous", SensorCatalog.reportingMode(0));
        assertEquals("on_change", SensorCatalog.reportingMode(1));
        assertEquals("one_shot", SensorCatalog.reportingMode(2));
        assertEquals("special_trigger", SensorCatalog.reportingMode(3));
        assertEquals(0.0, SensorCatalog.finite(Float.NaN), 0);
    }
}
