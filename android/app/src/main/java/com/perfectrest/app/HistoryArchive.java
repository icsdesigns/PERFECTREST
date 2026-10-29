package com.perfectrest.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.RandomAccessFile;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * Archivo histórico permanente, en el almacenamiento privado de la app
 * ({@code filesDir/history}). Nada lo poda ni lo caduca: sólo lo borra el
 * usuario con «Borrar archivo histórico».
 *
 * Qué contiene:
 *  - {@code events-AAAA-MM.jsonl}: el registro bruto ({@link RawEventLog}) tal
 *    como va saliendo del anillo de 3000 entradas, una línea JSON por evento,
 *    particionado por mes (hora local) y con el ruido reducido (ver
 *    {@link EventFilter}). Al cambiar de mes el fichero del mes anterior se
 *    comprime a {@code events-AAAA-MM.pN.jsonl.gz}.
 *  - {@code readings-AAAA-MM.jsonl}: lecturas agregadas de todos los sensores
 *    ({@link SensorSampler}), con el mismo particionado.
 *  - {@code sessions/<id>.json}: la última versión de cada noche con su
 *    contexto, que la app web ya no conserva más allá de 120 noches.
 *  - {@code inventory.json}: el inventario de sensores del móvil.
 *  - {@code state.json}: contadores y estado del filtro (no son datos).
 *
 * Robustez: los eventos se añaden en tandas con una sola escritura seguida de
 * {@code fsync}; si el proceso muere a mitad, la última línea queda truncada y
 * se recorta antes de la siguiente tanda (nunca se corrompe una línea
 * anterior). El estado y las sesiones se escriben en un fichero temporal que
 * se renombra (atómico). La compresión mensual renombra primero el fichero a
 * {@code .closing}, de modo que un corte en cualquier punto se reanuda sin
 * duplicar ni perder nada. Sin hilos propios, sin alarmas, sin wakelocks: sólo
 * trabaja cuando {@link RawEventLog} ya vuelca sus tandas.
 *
 * La lógica de ficheros no depende de Android y se prueba con JUnit
 * ({@code HistoryArchiveTest}).
 */
final class HistoryArchive {

    static final String PREF_KEEP = "keepHistory";
    static final String DIR = "history";

    /**
     * Un evento sólo se archiva cuando lleva este tiempo en el anillo: los pasos
     * (1 min), la luz (10 s) y el movimiento se funden con la entrada anterior y
     * archivarlos antes congelaría un valor a medias.
     */
    static final long SETTLE_MS = 3 * 60_000L;
    /** Holgura al reconocer lo ya considerado cuando el anillo ya no contiene el último evento archivado. */
    private static final long SLACK_MS = 2_000L;
    /** Cuánto del final de un fichero se lee para reconocer eventos repetidos. */
    private static final int TAIL_BYTES = 96 * 1024;

    /** Niveles de luz (lux) del servicio: mismos umbrales que {@code SensorWatcher}. */
    static final float LUX_DARK = 5f;
    static final float LUX_BRIGHT = 50f;

    private final File root;
    private final TimeZone zone;

    HistoryArchive(File root, TimeZone zone) {
        this.root = root;
        this.zone = zone;
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        new File(root, "sessions").mkdirs();
    }

    private static final Map<String, HistoryArchive> INSTANCES = new HashMap<>();

    static HistoryArchive forContext(Context context) {
        File dir = new File(context.getFilesDir(), DIR);
        synchronized (INSTANCES) {
            HistoryArchive a = INSTANCES.get(dir.getPath());
            if (a == null) {
                a = new HistoryArchive(dir, TimeZone.getDefault());
                INSTANCES.put(dir.getPath(), a);
            }
            return a;
        }
    }

    /** ¿Conservar el histórico? Activado por defecto. */
    static boolean enabled(Context context) {
        return context.getSharedPreferences(SleepMonitorService.PREFS, Context.MODE_PRIVATE)
            .getBoolean(PREF_KEEP, true);
    }

    // --- Filtro de ruido ---------------------------------------------------------

    /**
     * Reduce el ruido antes de archivar sin perder lo útil:
     *  - {@code light}/{@code lux}: sólo con la pantalla apagada y sólo si cambia
     *    el nivel (oscuro/tenue/claro). Un cambio de nivel con la pantalla
     *    encendida no se pierde: al apagarse se anota el nivel vigente, con la
     *    hora del apagado.
     *  - {@code alarm}: sólo si cambia el valor.
     * El resto (pantalla, cargador, sensores, contexto) pasa tal cual.
     */
    static final class EventFilter {
        int screenOn = -1;
        long light = -1;
        long lightLevelOfLux = -1;
        long alarm = Long.MIN_VALUE;
        /** Último nivel de luz descartado por estar la pantalla encendida (-1 si ninguno). */
        long pendingLight = -1;
        long pendingLux = -1;

        static int luxLevel(long lux) {
            return lux < LUX_DARK ? 0 : lux < LUX_BRIGHT ? 1 : 2;
        }

        /** Decide qué se archiva de este evento; devuelve cero, una o dos líneas (la 2.ª, la luz pendiente). */
        List<JSONObject> apply(JSONObject e) throws JSONException {
            List<JSONObject> out = new ArrayList<>(2);
            String kind = e.optString("kind");
            long at = e.optLong("at");
            boolean hasV = e.has("v");
            long v = e.optLong("v");
            switch (kind) {
                case "screen-on":
                    screenOn = 1;
                    out.add(e);
                    break;
                case "screen-off":
                    screenOn = 0;
                    out.add(e);
                    if (pendingLight >= 0 && pendingLight != light) {
                        light = pendingLight;
                        out.add(new JSONObject().put("at", at).put("kind", "light").put("v", light));
                    }
                    if (pendingLux >= 0 && luxLevel(pendingLux) != lightLevelOfLux) {
                        lightLevelOfLux = luxLevel(pendingLux);
                        out.add(new JSONObject().put("at", at).put("kind", "lux").put("v", pendingLux));
                    }
                    pendingLight = -1;
                    pendingLux = -1;
                    break;
                case "light":
                    if (!hasV) break;
                    if (screenOn == 1) {
                        pendingLight = v;
                    } else if (v != light) {
                        light = v;
                        pendingLight = -1;
                        out.add(e);
                    }
                    break;
                case "lux":
                    if (!hasV) break;
                    if (screenOn == 1) {
                        pendingLux = v;
                    } else if (luxLevel(v) != lightLevelOfLux) {
                        lightLevelOfLux = luxLevel(v);
                        pendingLux = -1;
                        out.add(e);
                    }
                    break;
                case "alarm":
                    if (!hasV || v != alarm) {
                        alarm = hasV ? v : Long.MIN_VALUE;
                        out.add(e);
                    }
                    break;
                default:
                    out.add(e);
            }
            return out;
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject().put("screenOn", screenOn).put("light", light)
                .put("luxLevel", lightLevelOfLux).put("alarm", alarm)
                .put("pendingLight", pendingLight).put("pendingLux", pendingLux);
        }

        static EventFilter fromJson(JSONObject j) {
            EventFilter f = new EventFilter();
            if (j == null) return f;
            f.screenOn = j.optInt("screenOn", -1);
            f.light = j.optLong("light", -1);
            f.lightLevelOfLux = j.optLong("luxLevel", -1);
            f.alarm = j.optLong("alarm", Long.MIN_VALUE);
            f.pendingLight = j.optLong("pendingLight", -1);
            f.pendingLux = j.optLong("pendingLux", -1);
            return f;
        }
    }

    // --- Estado ------------------------------------------------------------------

    /** Contadores y cursor; se guarda aparte de los datos. */
    private static final class State {
        long seenAt = 0;
        long cursorAt = -1;
        String cursorKind = "";
        long count = 0;
        long firstAt = 0;
        long lastAt = 0;
        long readings = 0;
        long readingsFirstAt = 0;
        long readingsLastAt = 0;
        /** Lo anterior a este instante lo borró el usuario: no vuelve a archivarse desde el anillo. */
        long floorAt = 0;
        EventFilter filter = new EventFilter();
    }

    private State state;

    private State state() {
        if (state == null) {
            state = new State();
            try {
                File f = new File(root, "state.json");
                if (f.exists()) {
                    JSONObject j = new JSONObject(new String(readAll(f), StandardCharsets.UTF_8));
                    state.seenAt = j.optLong("seenAt");
                    state.cursorAt = j.optLong("cursorAt", -1);
                    state.cursorKind = j.optString("cursorKind");
                    state.count = j.optLong("count");
                    state.firstAt = j.optLong("firstAt");
                    state.lastAt = j.optLong("lastAt");
                    state.readings = j.optLong("readings");
                    state.readingsFirstAt = j.optLong("readingsFirstAt");
                    state.readingsLastAt = j.optLong("readingsLastAt");
                    state.floorAt = j.optLong("floorAt");
                    state.filter = EventFilter.fromJson(j.optJSONObject("filter"));
                }
            } catch (IOException | JSONException e) {
                // Estado ilegible: se parte de cero; el dedupe por la cola del fichero evita duplicados.
                state = new State();
            }
            recover();
        }
        return state;
    }

    private void saveState() throws IOException {
        State s = state();
        try {
            JSONObject j = new JSONObject()
                .put("v", 1).put("seenAt", s.seenAt).put("cursorAt", s.cursorAt)
                .put("cursorKind", s.cursorKind).put("count", s.count)
                .put("firstAt", s.firstAt).put("lastAt", s.lastAt)
                .put("readings", s.readings).put("readingsFirstAt", s.readingsFirstAt)
                .put("readingsLastAt", s.readingsLastAt).put("floorAt", s.floorAt).put("filter", s.filter.toJson());
            writeAtomic(new File(root, "state.json"), j.toString().getBytes(StandardCharsets.UTF_8));
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    // --- Particionado --------------------------------------------------------------

    /** {@code AAAA-MM} de un instante, en la zona del archivo. */
    String monthKey(long at) {
        Calendar c = Calendar.getInstance(zone, Locale.ROOT);
        c.setTimeInMillis(at);
        return String.format(Locale.ROOT, "%04d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1);
    }

    private File openFile(String family, String month) {
        return new File(root, family + "-" + month + ".jsonl");
    }

    // --- Archivado de eventos ----------------------------------------------------------

    /**
     * Pasa al archivo lo que haya de nuevo en el anillo. Sólo los eventos con más
     * de {@link #SETTLE_MS} de antigüedad salvo con {@code all}. Devuelve cuántas
     * líneas se añadieron. Idempotente: llamarlo dos veces seguidas no duplica.
     */
    synchronized int archiveEvents(JSONArray ring, long now, boolean all) throws IOException {
        State s = state();
        int n = ring.length();
        int from = 0;
        boolean found = false;
        if (s.cursorAt >= 0) {
            for (int i = n - 1; i >= 0; i--) {
                JSONObject e = ring.optJSONObject(i);
                if (e != null && e.optLong("at") == s.cursorAt && s.cursorKind.equals(e.optString("kind"))) {
                    from = i + 1;
                    found = true;
                    break;
                }
            }
        }
        long cutoff = all ? Long.MAX_VALUE : now - SETTLE_MS;
        Map<String, Set<String>> tails = new HashMap<>();
        Map<String, StringBuilder> batches = new HashMap<>();
        Map<String, long[]> spans = new HashMap<>();
        long newCursorAt = s.cursorAt;
        String newCursorKind = s.cursorKind;
        long seen = s.seenAt;
        EventFilter filter = s.filter;
        long added = 0;
        long first = s.firstAt;
        long last = s.lastAt;
        // Si el último archivado ya no está en el anillo (se llenó, o se borró),
        // lo anterior a lo ya visto no se vuelve a considerar.
        boolean skipOld = !found && s.seenAt > 0;
        // El filtro es estado mutable: se trabaja sobre una copia por si falla la escritura.
        EventFilter work;
        try {
            work = EventFilter.fromJson(filter.toJson());
        } catch (JSONException e) {
            throw new IOException(e);
        }

        for (int i = from; i < n; i++) {
            JSONObject e = ring.optJSONObject(i);
            if (e == null || !e.has("at") || !e.has("kind")) continue;
            long at = e.optLong("at");
            if (at > cutoff) break;
            String kind = e.optString("kind");
            newCursorAt = at;
            newCursorKind = kind;
            if (at <= s.floorAt) continue;
            if (skipOld && at < s.seenAt - SLACK_MS) continue;
            if (at > seen) seen = at;
            String month = monthKey(at);
            Set<String> keys = tails.get(month);
            if (keys == null) {
                keys = tailKeys(openFile("events", month));
                tails.put(month, keys);
            }
            if (!keys.add(at + "|" + kind)) continue;
            List<JSONObject> lines;
            try {
                lines = work.apply(e);
            } catch (JSONException ex) {
                continue;
            }
            for (JSONObject line : lines) {
                long lat = line.optLong("at");
                String lm = monthKey(lat);
                StringBuilder sb = batches.get(lm);
                if (sb == null) {
                    sb = new StringBuilder();
                    batches.put(lm, sb);
                }
                sb.append(line.toString()).append('\n');
                added++;
                if (first == 0 || lat < first) first = lat;
                if (lat > last) last = lat;
            }
        }

        List<String> months = new ArrayList<>(batches.keySet());
        Collections.sort(months);
        for (String m : months) appendLines(openFile("events", m), batches.get(m).toString());

        boolean moved = newCursorAt != s.cursorAt || !newCursorKind.equals(s.cursorKind)
            || seen != s.seenAt;
        s.filter = work;
        s.cursorAt = newCursorAt;
        s.cursorKind = newCursorKind;
        s.seenAt = seen;
        s.count += added;
        s.firstAt = first;
        s.lastAt = last;
        if (added > 0 || moved) saveState();
        compactOldMonths(now);
        return (int) added;
    }

    /** Añade una lectura agregada de sensores al fichero del mes. */
    synchronized void appendReading(JSONObject reading, long now) throws IOException {
        long at = reading.optLong("at", now);
        appendLines(openFile("readings", monthKey(at)), reading.toString() + "\n");
        State s = state();
        s.readings++;
        if (s.readingsFirstAt == 0 || at < s.readingsFirstAt) s.readingsFirstAt = at;
        if (at > s.readingsLastAt) s.readingsLastAt = at;
        saveState();
        compactOldMonths(now);
    }

    /** Escribe líneas completas al final de un fichero en una sola escritura y las sincroniza. */
    private void appendLines(File f, String text) throws IOException {
        if (text.isEmpty()) return;
        recoverTail(f);
        try (FileOutputStream out = new FileOutputStream(f, true)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        }
    }

    /**
     * Si el proceso murió a mitad de una escritura, la última línea no acaba en
     * salto de línea: se recorta hasta el último salto. Lo anterior no se toca.
     * Devuelve cuántos bytes se descartaron.
     */
    static long recoverTail(File f) throws IOException {
        if (!f.exists() || f.length() == 0) return 0;
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            long len = raf.length();
            raf.seek(len - 1);
            if (raf.read() == '\n') return 0;
            long pos = len - 1;
            byte[] buf = new byte[4096];
            while (pos > 0) {
                long start = Math.max(0, pos - buf.length);
                int size = (int) (pos - start);
                raf.seek(start);
                raf.readFully(buf, 0, size);
                for (int i = size - 1; i >= 0; i--) {
                    if (buf[i] == '\n') {
                        long keep = start + i + 1;
                        raf.setLength(keep);
                        raf.getFD().sync();
                        return len - keep;
                    }
                }
                pos = start;
            }
            raf.setLength(0);
            raf.getFD().sync();
            return len;
        }
    }

    /** Claves {@code at|tipo} de las últimas líneas de un fichero, para no duplicar tras un corte. */
    static Set<String> tailKeys(File f) {
        Set<String> keys = new HashSet<>();
        if (!f.exists()) return keys;
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long len = raf.length();
            long start = Math.max(0, len - TAIL_BYTES);
            raf.seek(start);
            byte[] buf = new byte[(int) (len - start)];
            raf.readFully(buf);
            String text = new String(buf, StandardCharsets.UTF_8);
            int skip = start > 0 ? text.indexOf('\n') + 1 : 0;
            for (String line : text.substring(Math.max(0, skip)).split("\n")) {
                if (line.isEmpty() || line.charAt(0) != '{') continue;
                try {
                    JSONObject e = new JSONObject(line);
                    keys.add(e.optLong("at") + "|" + e.optString("kind"));
                } catch (JSONException ignored) {
                    // Línea rota: no cuenta.
                }
            }
        } catch (IOException ignored) {
            // Sin cola legible no hay dedupe, pero tampoco se pierde nada.
        }
        return keys;
    }

    // --- Compresión mensual -----------------------------------------------------------------

    /** Comprime los ficheros de meses anteriores al actual. */
    private void compactOldMonths(long now) throws IOException {
        String current = monthKey(now);
        File[] files = root.listFiles();
        if (files == null) return;
        for (File f : files) {
            String name = f.getName();
            String month = monthOfOpenFile(name);
            if (month != null && month.compareTo(current) < 0 && f.length() > 0) closeMonth(f, month);
        }
    }

    /** {@code AAAA-MM} de {@code events-AAAA-MM.jsonl}/{@code readings-AAAA-MM.jsonl}; null si no lo es. */
    static String monthOfOpenFile(String name) {
        if (!name.endsWith(".jsonl")) return null;
        String stem = name.substring(0, name.length() - 6);
        int dash = stem.indexOf('-');
        if (dash < 0) return null;
        String month = stem.substring(dash + 1);
        return month.matches("\\d{4}-\\d{2}") ? month : null;
    }

    private void closeMonth(File open, String month) throws IOException {
        String family = open.getName().substring(0, open.getName().indexOf('-'));
        int part = 1;
        while (new File(root, family + "-" + month + ".p" + part + ".jsonl.gz").exists()
            || new File(root, family + "-" + month + ".p" + part + ".closing").exists()) {
            part++;
        }
        File closing = new File(root, family + "-" + month + ".p" + part + ".closing");
        recoverTail(open);
        if (!open.renameTo(closing)) return;
        finishClosing(closing);
    }

    /** Termina una compresión: el destino sale del nombre, así que repetirla es inocuo. */
    private void finishClosing(File closing) throws IOException {
        String name = closing.getName();
        File gz = new File(root, name.substring(0, name.length() - ".closing".length()) + ".jsonl.gz");
        if (!gz.exists()) {
            File tmp = new File(root, gz.getName() + ".tmp");
            try (InputStream in = new FileInputStream(closing);
                 FileOutputStream fos = new FileOutputStream(tmp);
                 GZIPOutputStream out = new GZIPOutputStream(fos)) {
                byte[] buf = new byte[16 * 1024];
                int r;
                while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
                out.finish();
                out.flush();
                fos.getFD().sync();
            }
            if (!tmp.renameTo(gz)) throw new IOException("rename " + gz);
        }
        //noinspection ResultOfMethodCallIgnored
        closing.delete();
    }

    /** Al abrir: borra temporales y termina compresiones interrumpidas. */
    private void recover() {
        File[] files = root.listFiles();
        if (files == null) return;
        for (File f : files) {
            String n = f.getName();
            try {
                if (n.endsWith(".tmp")) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                } else if (n.endsWith(".closing")) {
                    finishClosing(f);
                }
            } catch (IOException ignored) {
                // Se reintenta en la siguiente apertura.
            }
        }
        File[] sess = new File(root, "sessions").listFiles();
        if (sess != null) {
            for (File f : sess) {
                //noinspection ResultOfMethodCallIgnored
                if (f.getName().endsWith(".tmp")) f.delete();
            }
        }
    }

    // --- Ficheros pequeños, atómicos -----------------------------------------------------------

    static void writeAtomic(File target, byte[] data) throws IOException {
        File tmp = new File(target.getParentFile(), target.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.flush();
            out.getFD().sync();
        }
        if (!tmp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            if (!tmp.renameTo(target)) throw new IOException("rename " + target);
        }
    }

    static byte[] readAll(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int r;
            while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
            return out.toByteArray();
        }
    }

    /** Guarda el inventario de sensores (cambia sólo con una actualización del sistema). */
    synchronized void putInventory(JSONArray inventory) throws IOException {
        File f = new File(root, "inventory.json");
        byte[] data = inventory.toString().getBytes(StandardCharsets.UTF_8);
        if (f.exists() && Arrays.equals(readAll(f), data)) return;
        writeAtomic(f, data);
    }

    // --- Sesiones -------------------------------------------------------------------------------

    static String safeId(String id) {
        return id.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private File sessionFile(String id) {
        return new File(new File(root, "sessions"), safeId(id) + ".json");
    }

    /**
     * Guarda la última versión de una noche. Si la nueva no trae contexto (porque
     * la app lo podó de su estado en memoria) se conserva el que ya había.
     * Devuelve false si no hizo falta escribir nada.
     */
    synchronized boolean putSession(String json) throws IOException {
        try {
            JSONObject s = new JSONObject(json);
            String id = s.optString("id");
            if (id.isEmpty()) return false;
            File f = sessionFile(id);
            if (!s.has("context") && f.exists()) {
                JSONObject old = new JSONObject(new String(readAll(f), StandardCharsets.UTF_8));
                if (old.has("context")) s.put("context", old.get("context"));
            }
            byte[] data = s.toString().getBytes(StandardCharsets.UTF_8);
            if (f.exists() && Arrays.equals(readAll(f), data)) return false;
            writeAtomic(f, data);
            return true;
        } catch (JSONException e) {
            return false;
        }
    }

    synchronized void removeSession(String id) {
        //noinspection ResultOfMethodCallIgnored
        sessionFile(id).delete();
    }

    /** «Borrar contextos guardados»: quita el contexto también de las copias del archivo. */
    synchronized void stripSessionContexts() throws IOException {
        File[] files = new File(root, "sessions").listFiles();
        if (files == null) return;
        for (File f : files) {
            if (!f.getName().endsWith(".json")) continue;
            try {
                JSONObject s = new JSONObject(new String(readAll(f), StandardCharsets.UTF_8));
                if (s.has("context")) {
                    s.remove("context");
                    writeAtomic(f, s.toString().getBytes(StandardCharsets.UTF_8));
                }
            } catch (JSONException ignored) {
                // Copia ilegible: se deja como está.
            }
        }
    }

    // --- Metadatos (sin leer datos) --------------------------------------------------------------

    /** Tamaño y rango del archivo a partir de metadatos: no lee ningún evento. */
    synchronized JSONObject info() throws JSONException {
        State s = state();
        long bytes = 0;
        int files = 0;
        File[] list = root.listFiles();
        if (list != null) {
            for (File f : list) {
                if (f.isFile() && !f.getName().endsWith(".tmp")) {
                    bytes += f.length();
                    files++;
                }
            }
        }
        long sessionBytes = 0;
        int sessions = 0;
        File[] sess = new File(root, "sessions").listFiles();
        if (sess != null) {
            for (File f : sess) {
                if (f.getName().endsWith(".json")) {
                    sessionBytes += f.length();
                    sessions++;
                }
            }
        }
        return new JSONObject()
            .put("bytes", bytes + sessionBytes)
            .put("files", files + sessions)
            .put("events", s.count)
            .put("from", s.firstAt)
            .put("to", s.lastAt)
            .put("readings", s.readings)
            .put("readingsFrom", s.readingsFirstAt)
            .put("readingsTo", s.readingsLastAt)
            .put("sessions", sessions);
    }

    /** Borra todo el archivo. Sólo lo llama «Borrar archivo histórico». */
    synchronized void clear(long now) {
        deleteTree(root);
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        //noinspection ResultOfMethodCallIgnored
        new File(root, "sessions").mkdirs();
        state = new State();
        state.floorAt = now;
        try {
            saveState();
        } catch (IOException ignored) {
            // Sin esta marca el anillo volvería a volcarse: se reintenta en la siguiente tanda.
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    // --- Lectura en flujo (exportación) ---------------------------------------------------------------

    /** Ficheros de una familia en orden cronológico: meses, y dentro de cada mes los comprimidos antes que el abierto. */
    List<File> familyFiles(String family) {
        List<File> out = new ArrayList<>();
        File[] files = root.listFiles();
        if (files == null) return out;
        for (File f : files) {
            String n = f.getName();
            if (n.startsWith(family + "-") && (n.endsWith(".jsonl") || n.endsWith(".jsonl.gz"))) out.add(f);
        }
        Collections.sort(out, new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                return sortKey(a.getName()).compareTo(sortKey(b.getName()));
            }
        });
        return out;
    }

    /** {@code AAAA-MM} + número de parte con ceros; el abierto lleva 999 para ir al final del mes. */
    private static String sortKey(String name) {
        String stem = name.substring(name.indexOf('-') + 1);
        String month = stem.substring(0, 7);
        int part = 999;
        int p = stem.indexOf(".p");
        if (p > 0) {
            try {
                part = Integer.parseInt(stem.substring(p + 2, stem.indexOf('.', p + 2)));
            } catch (RuntimeException ignored) {
                part = 998;
            }
        }
        return month + String.format(Locale.ROOT, ".%03d", part);
    }

    /**
     * Copia las líneas de una familia al escritor, separadas por comas, sin cargar
     * nada en memoria. Del fichero abierto sólo se lee lo que había al empezar.
     * Devuelve cuántas líneas escribió. Las líneas que no son un objeto JSON
     * completo (restos de un corte) se saltan.
     */
    long streamFamily(String family, Writer w, boolean[] first) throws IOException {
        List<File> files;
        Map<File, Long> limits = new HashMap<>();
        synchronized (this) {
            files = familyFiles(family);
            for (File f : files) limits.put(f, f.length());
        }
        long n = 0;
        for (File f : files) {
            if (!f.exists()) continue;
            long limit = limits.get(f);
            try (InputStream raw = new LimitedInput(new FileInputStream(f), limit);
                 InputStream in = f.getName().endsWith(".gz") ? new GZIPInputStream(raw) : raw;
                 BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    if (line.length() < 2 || line.charAt(0) != '{' || line.charAt(line.length() - 1) != '}') continue;
                    if (!first[0]) w.write(",\n");
                    first[0] = false;
                    w.write(line);
                    n++;
                }
            }
        }
        return n;
    }

    /** Lee como mucho {@code limit} bytes: el fichero abierto sigue creciendo mientras se exporta. */
    private static final class LimitedInput extends InputStream {
        private final InputStream in;
        private long left;

        LimitedInput(InputStream in, long limit) {
            this.in = in;
            this.left = limit;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = in.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int r = in.read(b, off, (int) Math.min(len, left));
            if (r > 0) left -= r;
            return r;
        }

        @Override
        public void close() throws IOException {
            in.close();
        }
    }

    /** Eventos del anillo que el archivo aún no tiene (con el archivado apagado, o los recientes). */
    synchronized List<JSONObject> unarchived(JSONArray ring) {
        State s = state();
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; i < ring.length(); i++) {
            JSONObject e = ring.optJSONObject(i);
            if (e != null && e.optLong("at") > s.seenAt) out.add(e);
        }
        return out;
    }

    /**
     * Escribe la exportación única en flujo.
     *
     * @param head        objeto JSON con meta, ajustes, hábito, dispositivo y registro de disparadores
     * @param stateSessions las noches que la app tiene ahora (array JSON); se unen por id con las del archivo
     * @param ringExtra   eventos del anillo que no están en el archivo
     */
    JSONObject writeExport(
        OutputStream rawOut, boolean gzip, String head, String stateSessions, List<JSONObject> ringExtra
    ) throws IOException, JSONException {
        OutputStream os = gzip ? new GZIPOutputStream(rawOut) : rawOut;
        Writer w = new BufferedWriter(new OutputStreamWriter(os, StandardCharsets.UTF_8), 32 * 1024);
        String h = head.trim();
        if (!h.endsWith("}")) throw new IOException("head");
        String body = h.substring(0, h.length() - 1);
        w.write(body);
        // Con una cabecera vacía («{}») no hay nada previo a lo que añadir una coma.
        boolean empty = body.trim().equals("{");

        JSONArray inv = new JSONArray();
        File invFile = new File(root, "inventory.json");
        if (invFile.exists()) {
            try {
                inv = new JSONArray(new String(readAll(invFile), StandardCharsets.UTF_8));
            } catch (JSONException ignored) {
                // Inventario ilegible: se exporta vacío.
            }
        }
        w.write((empty ? "\n" : ",\n") + "\"sensorInventory\":");
        w.write(inv.toString());

        int sessions = writeSessions(w, stateSessions);

        w.write(",\n\"rawEvents\":[\n");
        boolean[] first = {true};
        long events = streamFamily("events", w, first);
        for (JSONObject e : ringExtra) {
            if (!first[0]) w.write(",\n");
            first[0] = false;
            w.write(e.toString());
            events++;
        }
        w.write("\n]");

        w.write(",\n\"sensorReadings\":[\n");
        first[0] = true;
        long readings = streamFamily("readings", w, first);
        w.write("\n]");

        JSONObject totals = new JSONObject().put("sessions", sessions).put("rawEvents", events)
            .put("sensorReadings", readings).put("sensorsInInventory", inv.length());
        w.write(",\n\"totals\":");
        w.write(totals.toString());
        w.write("\n}\n");
        w.flush();
        if (os instanceof GZIPOutputStream) ((GZIPOutputStream) os).finish();
        os.flush();
        return totals;
    }

    /** Une las noches de la app con las del archivo por id y las escribe ordenadas por inicio, de una en una. */
    private int writeSessions(Writer w, String stateSessions) throws IOException {
        Map<String, JSONObject> live = new HashMap<>();
        try {
            JSONArray arr = new JSONArray(stateSessions == null || stateSessions.isEmpty() ? "[]" : stateSessions);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && o.has("id")) live.put(safeId(o.optString("id")), o);
            }
        } catch (JSONException ignored) {
            // Sin sesiones de la app: sólo las del archivo.
        }
        // Pasada 1: id y inicio de cada noche (las del archivo se parsean una a una).
        final Map<String, Long> starts = new HashMap<>();
        Map<String, File> archived = new HashMap<>();
        File[] files;
        synchronized (this) {
            files = new File(root, "sessions").listFiles();
        }
        if (files != null) {
            for (File f : files) {
                if (!f.getName().endsWith(".json")) continue;
                try {
                    JSONObject s = new JSONObject(new String(readAll(f), StandardCharsets.UTF_8));
                    String key = safeId(s.optString("id"));
                    archived.put(key, f);
                    starts.put(key, s.optLong("start"));
                } catch (IOException | JSONException ignored) {
                    // Copia ilegible: se omite.
                }
            }
        }
        for (Map.Entry<String, JSONObject> e : live.entrySet()) starts.put(e.getKey(), e.getValue().optLong("start"));
        List<String> order = new ArrayList<>(starts.keySet());
        Collections.sort(order, new Comparator<String>() {
            @Override
            public int compare(String a, String b) {
                int c = Long.compare(starts.get(a), starts.get(b));
                return c != 0 ? c : a.compareTo(b);
            }
        });
        // Pasada 2: emitir.
        w.write(",\n\"sessions\":[\n");
        boolean first = true;
        int n = 0;
        for (String key : order) {
            JSONObject s = live.get(key);
            File f = archived.get(key);
            try {
                if (f != null) {
                    JSONObject old = new JSONObject(new String(readAll(f), StandardCharsets.UTF_8));
                    if (s == null) s = old;
                    else if (!s.has("context") && old.has("context")) s.put("context", old.get("context"));
                }
                if (s == null) continue;
            } catch (IOException | JSONException ex) {
                if (s == null) continue;
            }
            if (!first) w.write(",\n");
            first = false;
            w.write(s.toString());
            n++;
        }
        w.write("\n]");
        return n;
    }
}
