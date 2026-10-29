import { archiveSessionsNative } from './backgroundMonitor';
import type { SleepSession } from './types';

/**
 * Archivo histórico permanente (lado web).
 *
 * El archivo vive en el servicio nativo (`HistoryArchive.java`, en el
 * almacenamiento privado de la app) y aquí sólo hay tres cosas:
 *
 *  - qué se estima que ocupa (para explicarlo en Ajustes y en el README);
 *  - qué noches hay que copiarle y cuándo, sin releerlas todas cada vez;
 *  - formato de tamaños y fechas para mostrar sus metadatos.
 *
 * La interfaz nunca lee el histórico: sólo ve tamaño y rango, que el servicio
 * saca de los metadatos de los ficheros.
 *
 * Las noches se copian al archivo en cuanto se guardan o se les calcula el
 * contexto, antes de que `pruneContexts` pueda soltar el de las más antiguas
 * del estado en memoria. Lo que el estado olvida, el archivo lo conserva: una
 * copia sin contexto no pisa el contexto ya archivado (lo hace el servicio).
 */

/**
 * Estimación de crecimiento, por mes, con el uso de referencia que describe el
 * README. Son órdenes de magnitud, no mediciones: Ajustes muestra el tamaño
 * real.
 *
 *  - eventos: ~1 800 al día en bruto (3 000 entradas ≈ 40 h) → ~54 000 al mes;
 *    el filtro de luz y alarma retira alrededor de una cuarta parte → ~40 000
 *    líneas de ~40 B → ~1,6 MB sin comprimir, ~0,26 MB una vez cerrado el mes
 *    (gzip, medido sobre una muestra sintética).
 *  - lecturas de sensores: ~50 ventanas por noche × ~1,4 KB (12 sensores) →
 *    ~2,2 MB sin comprimir, ~0,55 MB comprimido (con números aleatorios, que
 *    comprimen peor que los reales: es una cota alta).
 *  - noches con contexto: ~2 KB cada una → ~60 KB al mes.
 */
export const ARCHIVE_ESTIMATE_MB_PER_MONTH = {
  /** Mes en curso, sin comprimir. */
  openMonth: 3.8,
  /** Mes ya cerrado (gzip). */
  closedMonth: 0.8,
} as const;

/** Estimación para `months` meses de uso: el mes abierto más los cerrados. */
export function estimateArchiveMb(months: number): number {
  if (months <= 0) return 0;
  const closed = Math.max(0, months - 1);
  return ARCHIVE_ESTIMATE_MB_PER_MONTH.openMonth + closed * ARCHIVE_ESTIMATE_MB_PER_MONTH.closedMonth;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Rango de fechas del archivo como «12 ene 2026 – 3 mar 2026»; null si está vacío. */
export function formatArchiveRange(from: number, to: number): string | null {
  if (!from || !to) return null;
  const f = (ms: number) =>
    new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  const a = f(from);
  const b = f(to);
  return a === b ? a : `${a} – ${b}`;
}

/**
 * Huella de una noche para saber si cambió desde la última copia. Incluye el
 * contexto: que se añada (o se pode) cambia la huella y dispara una copia.
 */
export function sessionSignature(s: SleepSession): string {
  return JSON.stringify(s);
}

/**
 * Qué noches hay que copiar al archivo: las que no se han copiado o han
 * cambiado desde entonces. Es pura para poder probarla: devuelve la lista y
 * las huellas que quedarán registradas si la copia sale bien.
 */
export function planSessionArchive(
  sessions: SleepSession[],
  archived: ReadonlyMap<string, string>,
): { toArchive: SleepSession[]; signatures: Map<string, string> } {
  const toArchive: SleepSession[] = [];
  const signatures = new Map<string, string>();
  for (const s of sessions) {
    const sig = sessionSignature(s);
    signatures.set(s.id, sig);
    if (archived.get(s.id) !== sig) toArchive.push(s);
  }
  return { toArchive, signatures };
}

/** Noches por llamada al servicio: el puente de Capacitor no es el sitio para megabytes. */
const ARCHIVE_CHUNK = 20;

/**
 * Copia al archivo las noches que cambiaron. Devuelve las huellas de lo que
 * quedó archivado (las de las noches que no se pudieron copiar no se anotan,
 * y se reintentan en el siguiente cambio).
 */
export async function syncSessions(
  sessions: SleepSession[],
  archived: Map<string, string>,
  archive: (chunk: SleepSession[]) => Promise<number | null> = async (chunk) =>
    archiveSessionsNative(chunk),
): Promise<Map<string, string>> {
  const { toArchive, signatures } = planSessionArchive(sessions, archived);
  const done = new Map(archived);
  for (let i = 0; i < toArchive.length; i += ARCHIVE_CHUNK) {
    const chunk = toArchive.slice(i, i + ARCHIVE_CHUNK);
    try {
      const written = await archive(chunk);
      if (written === null) return done;
    } catch {
      return done;
    }
    for (const s of chunk) done.set(s.id, signatures.get(s.id) as string);
  }
  return done;
}
