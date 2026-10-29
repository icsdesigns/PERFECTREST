package com.perfectrest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.TimeZone;
import java.util.zip.GZIPInputStream;

/**
 * Archivo histórico permanente: partición mensual, deduplicación, recuperación
 * de una línea truncada, compresión, filtro de ruido, sesiones y exportación.
 * Sin dispositivo: la lógica de ficheros no depende de Android.
 */
public class HistoryArchiveTest {

    private static final long DAY = 24L * 3_600_000L;
    /** 2026-09-30 12:00 UTC. */
    private static final long SEP30 = 1_790_769_600_000L;
    private static final long OCT1 = SEP30 + DAY;

    private File dir;
    private HistoryArchive archive;

    @Before
    public void setUp() throws Exception {
        dir = Files.createTempDirectory("hist").toFile();
        archive = new HistoryArchive(dir, TimeZone.getTimeZone("UTC"));
    }

    @After
    public void tearDown() {
        delete(dir);
    }

    private static void delete(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) delete(k);
        f.delete();
    }

    private static JSONObject ev(long at, String kind, Long v) throws Exception {
        JSONObject o = new JSONObject().put("at", at).put("kind", kind);
        if (v != null) o.put("v", v.longValue());
        return o;
    }

    private static JSONArray ring(JSONObject... events) {
        JSONArray a = new JSONArray();
        for (JSONObject e : events) a.put(e);
        return a;
    }

    private static List<String> lines(File f) throws Exception {
        List<String> out = new ArrayList<>();
        if (!f.exists()) return out;
        for (String l : new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).split("\n")) {
            if (!l.isEmpty()) out.add(l);
        }
        return out;
    }

    private static String gunzip(File f) throws Exception {
        try (InputStream in = new GZIPInputStream(new java.io.FileInputStream(f))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int r;
            while ((r = in.read(b)) > 0) out.write(b, 0, r);
            return out.toString("UTF-8");
        }
    }

    @Test
    public void particionaPorMesYComprimeElMesCerrado() throws Exception {
        archive.archiveEvents(ring(ev(SEP30, "screen-off", null), ev(SEP30 + 1000, "plug", null)), SEP30 + 10 * 60_000L, false);
        assertEquals(2, lines(new File(dir, "events-2026-09.jsonl")).size());
        assertFalse(new File(dir, "events-2026-10.jsonl").exists());

        // Pasado el cambio de mes: el evento de octubre abre otro fichero y septiembre se comprime.
        JSONArray r = ring(ev(SEP30, "screen-off", null), ev(SEP30 + 1000, "plug", null), ev(OCT1 + 5000, "screen-on", null));
        archive.archiveEvents(r, OCT1 + 20 * 60_000L, false);
        assertEquals(1, lines(new File(dir, "events-2026-10.jsonl")).size());
        assertFalse(new File(dir, "events-2026-09.jsonl").exists());
        File gz = new File(dir, "events-2026-09.p1.jsonl.gz");
        assertTrue(gz.exists());
        String text = gunzip(gz);
        assertTrue(text.contains("\"screen-off\"") && text.contains("\"plug\""));
        // Ninguna línea se pierde al comprimir.
        assertEquals(2, text.trim().split("\n").length);
    }

    @Test
    public void noDuplicaAlRepetirNiAlReiniciar() throws Exception {
        JSONArray r = ring(ev(SEP30, "screen-off", null), ev(SEP30 + 1000, "steps", 12L));
        long now = SEP30 + 10 * 60_000L;
        assertEquals(2, archive.archiveEvents(r, now, false));
        assertEquals(0, archive.archiveEvents(r, now + 1000, false));
        // Proceso nuevo: sin memoria, con el mismo anillo (migración repetida).
        HistoryArchive again = new HistoryArchive(dir, TimeZone.getTimeZone("UTC"));
        assertEquals(0, again.archiveEvents(r, now + 2000, false));
        // Y con el estado perdido, la cola del fichero evita duplicados.
        new File(dir, "state.json").delete();
        HistoryArchive lost = new HistoryArchive(dir, TimeZone.getTimeZone("UTC"));
        assertEquals(0, lost.archiveEvents(r, now + 3000, false));
        assertEquals(2, lines(new File(dir, "events-2026-09.jsonl")).size());
    }

    @Test
    public void migracionVuelcaElAnilloEntero() throws Exception {
        JSONArray r = new JSONArray();
        for (int i = 0; i < 500; i++) r.put(ev(SEP30 + i * 1000L, i % 2 == 0 ? "screen-off" : "screen-on", null));
        assertEquals(500, archive.archiveEvents(r, SEP30 + 3_600_000L, false));
        assertEquals(0, archive.archiveEvents(r, SEP30 + 3_600_001L, true));
        assertEquals(500, lines(new File(dir, "events-2026-09.jsonl")).size());
    }

    @Test
    public void losEventosRecientesEsperanAAsentarse() throws Exception {
        JSONArray r = ring(ev(SEP30, "steps", 5L));
        assertEquals(0, archive.archiveEvents(r, SEP30 + 60_000L, false));
        // Se funde con el siguiente paso mientras sigue en el anillo.
        r.getJSONObject(0).put("v", 9L);
        assertEquals(1, archive.archiveEvents(r, SEP30 + HistoryArchive.SETTLE_MS + 1, false));
        assertTrue(lines(new File(dir, "events-2026-09.jsonl")).get(0).contains("\"v\":9"));
    }

    @Test
    public void recuperaUnaLineaTruncada() throws Exception {
        archive.archiveEvents(ring(ev(SEP30, "screen-off", null)), SEP30 + 10 * 60_000L, false);
        File f = new File(dir, "events-2026-09.jsonl");
        // El proceso murió a mitad de la siguiente tanda.
        try (FileOutputStream out = new FileOutputStream(f, true)) {
            out.write("{\"at\":17907".getBytes(StandardCharsets.UTF_8));
        }
        long dropped = HistoryArchive.recoverTail(f);
        assertEquals("{\"at\":17907".length(), dropped);
        assertEquals(1, lines(f).size());

        // Y la propia tanda siguiente la recorta sola, sin tocar lo anterior.
        try (FileOutputStream out = new FileOutputStream(f, true)) {
            out.write("{\"at\":1".getBytes(StandardCharsets.UTF_8));
        }
        HistoryArchive again = new HistoryArchive(dir, TimeZone.getTimeZone("UTC"));
        again.archiveEvents(ring(ev(SEP30, "screen-off", null), ev(SEP30 + 5000, "plug", null)), SEP30 + 20 * 60_000L, false);
        List<String> l = lines(f);
        assertEquals(2, l.size());
        for (String line : l) new JSONObject(line); // todas válidas
        assertTrue(l.get(1).contains("plug"));
    }

    @Test
    public void unFicheroSinSaltoDeLineaSeVaciaSiNoHayNingunaLineaCompleta() throws Exception {
        File f = new File(dir, "x.jsonl");
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write("{\"at\":1".getBytes(StandardCharsets.UTF_8));
        }
        HistoryArchive.recoverTail(f);
        assertEquals(0, f.length());
    }

    @Test
    public void reanudaUnaCompresionInterrumpida() throws Exception {
        archive.archiveEvents(ring(ev(SEP30, "screen-off", null)), SEP30 + 10 * 60_000L, false);
        // Corte justo tras renombrar el fichero a «.closing», antes de comprimir.
        File open = new File(dir, "events-2026-09.jsonl");
        assertTrue(open.renameTo(new File(dir, "events-2026-09.p1.closing")));
        new File(dir, "events-2026-09.p1.jsonl.gz.tmp").createNewFile();
        new HistoryArchive(dir, TimeZone.getTimeZone("UTC")).info();
        assertTrue(new File(dir, "events-2026-09.p1.jsonl.gz").exists());
        assertFalse(new File(dir, "events-2026-09.p1.closing").exists());
        assertFalse(new File(dir, "events-2026-09.p1.jsonl.gz.tmp").exists());
        assertTrue(gunzip(new File(dir, "events-2026-09.p1.jsonl.gz")).contains("screen-off"));
    }

    @Test
    public void unEventoTardioDeUnMesCerradoVaAOtraParte() throws Exception {
        archive.archiveEvents(ring(ev(SEP30, "screen-off", null)), SEP30 + 10 * 60_000L, false);
        archive.archiveEvents(ring(ev(SEP30, "screen-off", null), ev(OCT1 + 1000, "plug", null)), OCT1 + HistoryArchive.SETTLE_MS * 2, false);
        // Llega uno de septiembre con retraso.
        archive.archiveEvents(ring(ev(SEP30, "screen-off", null), ev(OCT1 + 1000, "plug", null), ev(SEP30 + 500, "unplug", null)),
            OCT1 + 10 * 60_000L, true);
        assertTrue(new File(dir, "events-2026-09.p1.jsonl.gz").exists());
        assertTrue(new File(dir, "events-2026-09.p2.jsonl.gz").exists());
        assertTrue(gunzip(new File(dir, "events-2026-09.p2.jsonl.gz")).contains("unplug"));
    }

    @Test
    public void filtroDeLuzSoloConPantallaApagadaYEnCambioDeNivel() throws Exception {
        long t = SEP30;
        JSONArray r = ring(
            ev(t, "screen-on", null),
            ev(t + 1000, "light", 2L),        // pantalla encendida: se retiene
            ev(t + 1000, "lux", 400L),
            ev(t + 60_000, "screen-off", null), // al apagarse se anota el nivel vigente
            ev(t + 120_000, "light", 0L),     // cambio con la pantalla apagada: sí
            ev(t + 120_000, "lux", 1L),
            ev(t + 180_000, "light", 0L),     // mismo nivel: no
            ev(t + 240_000, "alarm", 1000L),
            ev(t + 300_000, "alarm", 1000L),  // mismo valor: no
            ev(t + 360_000, "alarm", 2000L),
            ev(t + 400_000, "alarm", 0L));
        archive.archiveEvents(r, t + DAY / 4, false);
        String all = String.join("\n", lines(new File(dir, "events-2026-09.jsonl")));
        // Niveles anotados: 2 (al apagarse, con la hora del apagado) y 0.
        assertEquals(2, count(all, "\"kind\":\"light\""));
        assertTrue(all.contains("\"at\":" + (t + 60_000) + ",\"kind\":\"light\",\"v\":2")
            || all.contains("\"kind\":\"light\",\"v\":2,\"at\":" + (t + 60_000)));
        assertEquals(2, count(all, "\"kind\":\"lux\""));
        assertEquals(3, count(all, "\"kind\":\"alarm\""));
        assertEquals(1, count(all, "\"kind\":\"screen-on\""));
    }

    @Test
    public void laLuzConLaPantallaEncendidaNoSeArchiva() throws Exception {
        long t = SEP30;
        JSONArray r = ring(ev(t, "screen-on", null), ev(t + 1000, "light", 1L), ev(t + 2000, "light", 2L));
        archive.archiveEvents(r, t + DAY / 4, false);
        assertEquals(1, lines(new File(dir, "events-2026-09.jsonl")).size());
    }

    private static int count(String text, String needle) {
        int n = 0;
        for (int i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) n++;
        return n;
    }

    @Test
    public void elFiltroSobreviveAUnReinicio() throws Exception {
        long t = SEP30;
        archive.archiveEvents(ring(ev(t, "screen-off", null), ev(t + 1000, "light", 0L)), t + DAY / 4, false);
        HistoryArchive again = new HistoryArchive(dir, TimeZone.getTimeZone("UTC"));
        JSONArray r = ring(ev(t, "screen-off", null), ev(t + 1000, "light", 0L), ev(t + 2_000_000, "light", 0L), ev(t + 2_100_000, "light", 1L));
        again.archiveEvents(r, t + 3 * 3_600_000L, false);
        assertEquals(3, lines(new File(dir, "events-2026-09.jsonl")).size());
    }

    @Test
    public void borrarElArchivoNoLoRecuperaDelAnillo() throws Exception {
        JSONArray r = ring(ev(SEP30, "screen-off", null), ev(SEP30 + 1000, "plug", null));
        archive.archiveEvents(r, SEP30 + DAY / 4, false);
        archive.clear(SEP30 + DAY / 4);
        assertEquals(0, archive.info().getLong("events"));
        assertEquals(0, archive.archiveEvents(r, SEP30 + DAY / 3, false));
        // Lo nuevo sí se archiva.
        r.put(ev(SEP30 + DAY / 2, "screen-on", null));
        assertEquals(1, archive.archiveEvents(r, SEP30 + DAY, false));
    }

    @Test
    public void infoSoloUsaMetadatos() throws Exception {
        archive.archiveEvents(ring(ev(SEP30, "screen-off", null), ev(SEP30 + 9000, "plug", null)), SEP30 + DAY / 4, false);
        JSONObject info = archive.info();
        assertEquals(2, info.getLong("events"));
        assertEquals(SEP30, info.getLong("from"));
        assertEquals(SEP30 + 9000, info.getLong("to"));
        assertTrue(info.getLong("bytes") > 0);
    }

    @Test
    public void laSesionConservaElContextoQueLaAppPodo() throws Exception {
        archive.putSession("{\"id\":\"s1\",\"start\":10,\"end\":20,\"context\":{\"v\":1,\"night\":true}}");
        // La app podó el contexto de su estado: la copia lo conserva.
        assertTrue(archive.putSession("{\"id\":\"s1\",\"start\":10,\"end\":20,\"note\":\"x\"}"));
        String saved = new String(Files.readAllBytes(new File(dir, "sessions/s1.json").toPath()), StandardCharsets.UTF_8);
        JSONObject o = new JSONObject(saved);
        assertTrue(o.has("context"));
        assertEquals("x", o.getString("note"));
        // Igual que la anterior: no se reescribe.
        assertFalse(archive.putSession("{\"id\":\"s1\",\"start\":10,\"end\":20,\"note\":\"x\"}"));
        // Borrar contextos sí los quita del archivo.
        archive.stripSessionContexts();
        assertFalse(new JSONObject(new String(Files.readAllBytes(new File(dir, "sessions/s1.json").toPath()),
            StandardCharsets.UTF_8)).has("context"));
        archive.removeSession("s1");
        assertFalse(new File(dir, "sessions/s1.json").exists());
    }

    @Test
    public void exportaUnJsonValidoEnFlujoYSinGzip() throws Exception {
        archive.archiveEvents(ring(ev(SEP30, "screen-off", null), ev(OCT1 + 1000, "plug", null)), OCT1 + DAY, false);
        archive.appendReading(new JSONObject("{\"at\":" + (OCT1 + 2000) + ",\"kind\":\"sensors\",\"s\":{\"light\":{\"n\":3}}}"), OCT1 + DAY);
        archive.putSession("{\"id\":\"a\",\"start\":200,\"end\":300,\"context\":{\"x\":1}}");
        archive.putSession("{\"id\":\"b\",\"start\":100,\"end\":150}");
        archive.putInventory(new JSONArray("[{\"name\":\"acc\",\"type\":\"accelerometer\"}]"));
        List<JSONObject> extra = new ArrayList<>();
        extra.add(ev(OCT1 + 3000, "unlock", null));

        for (boolean gzip : new boolean[] {false, true}) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            // La app trae «a» ya sin contexto (podado) y una noche que el archivo no tiene.
            JSONObject totals = archive.writeExport(out, gzip, "{\"meta\":{\"format\":1}}",
                "[{\"id\":\"a\",\"start\":200,\"end\":300},{\"id\":\"c\",\"start\":50,\"end\":60}]", extra);
            String text = gzip
                ? gunzipBytes(out.toByteArray())
                : new String(out.toByteArray(), StandardCharsets.UTF_8);
            JSONObject doc = new JSONObject(text);
            assertEquals(1, doc.getJSONObject("meta").getInt("format"));
            JSONArray s = doc.getJSONArray("sessions");
            assertEquals(3, s.length());
            assertEquals("c", s.getJSONObject(0).getString("id")); // ordenadas por inicio
            assertEquals("b", s.getJSONObject(1).getString("id"));
            assertTrue(s.getJSONObject(2).has("context")); // recuperado del archivo
            assertEquals(3, doc.getJSONArray("rawEvents").length());
            assertEquals(1, doc.getJSONArray("sensorReadings").length());
            assertEquals(1, doc.getJSONArray("sensorInventory").length());
            assertEquals(3, totals.getInt("sessions"));
            assertEquals(3, totals.getInt("rawEvents"));
        }
    }

    private static String gunzipBytes(byte[] b) throws Exception {
        try (InputStream in = new GZIPInputStream(new java.io.ByteArrayInputStream(b))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int r;
            while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
            return out.toString("UTF-8");
        }
    }

    @Test
    public void laExportacionSaltaLineasRotas() throws Exception {
        archive.archiveEvents(ring(ev(SEP30, "screen-off", null)), SEP30 + DAY / 4, false);
        try (FileOutputStream out = new FileOutputStream(new File(dir, "events-2026-09.jsonl"), true)) {
            out.write("{\"at\":1".getBytes(StandardCharsets.UTF_8));
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        archive.writeExport(out, false, "{}", "[]", new ArrayList<JSONObject>());
        JSONObject doc = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        assertEquals(1, doc.getJSONArray("rawEvents").length());
    }

    @Test
    public void mesesEnOrdenYParteAntesQueElAbierto() throws Exception {
        for (String n : new String[] {"events-2026-10.jsonl", "events-2026-09.p2.jsonl.gz", "events-2026-09.p1.jsonl.gz", "events-2026-09.jsonl"}) {
            new File(dir, n).createNewFile();
        }
        List<File> f = archive.familyFiles("events");
        assertEquals("events-2026-09.p1.jsonl.gz", f.get(0).getName());
        assertEquals("events-2026-09.p2.jsonl.gz", f.get(1).getName());
        assertEquals("events-2026-09.jsonl", f.get(2).getName());
        assertEquals("events-2026-10.jsonl", f.get(3).getName());
    }
}
