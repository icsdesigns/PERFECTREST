import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { RawEvent } from './rawEvents';
import type { SleepSession } from './types';

export type ExportFormat = 'csv' | 'json';

const pad = (n: number) => String(n).padStart(2, '0');

function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Entrecomilla un campo CSV si lleva separadores, comillas o saltos de línea. */
function csvField(v: string | number | undefined): string {
  const s = v === undefined ? '' : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = [
  'fecha', 'inicio', 'fin', 'horas', 'origen', 'confianza', 'confirmada', 'calidad', 'nota',
];

/** Una fila por noche, de la más antigua a la más reciente. */
export function sessionsToCsv(sessions: SleepSession[]): string {
  const rows = [...sessions]
    .sort((a, b) => a.start - b.start)
    .map((s) =>
      [
        localDate(s.end),
        `${localDate(s.start)} ${localTime(s.start)}`,
        `${localDate(s.end)} ${localTime(s.end)}`,
        ((s.end - s.start) / 3_600_000).toFixed(2),
        s.source,
        s.confidence,
        s.confirmed ? 'sí' : 'no',
        s.quality,
        s.note,
      ]
        .map(csvField)
        .join(','),
    );
  // BOM para que Excel abra bien los acentos.
  return '﻿' + [HEADER.join(','), ...rows].join('\r\n') + '\r\n';
}

export function sessionsToJson(sessions: SleepSession[]): string {
  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  return JSON.stringify(sorted, null, 2);
}

/** Una fila por evento, de más antiguo a más reciente: instante local, instante en ms, tipo y valor. */
const RAW_HEADER = ['fecha', 'hora', 'instante_ms', 'tipo', 'valor'];

export function rawEventsToCsv(events: RawEvent[]): string {
  const rows = [...events]
    .sort((a, b) => a.at - b.at)
    .map((e) =>
      [
        localDate(e.at),
        `${localTime(e.at)}:${pad(new Date(e.at).getSeconds())}`,
        e.at,
        e.kind,
        e.v,
      ]
        .map(csvField)
        .join(','),
    );
  return '\ufeff' + [RAW_HEADER.join(','), ...rows].join('\r\n') + '\r\n';
}

export function rawEventsToJson(events: RawEvent[]): string {
  return JSON.stringify([...events].sort((a, b) => a.at - b.at), null, 2);
}

/**
 * Entrega un archivo al usuario. En Android el WebView no descarga blobs, así
 * que se escribe en caché y se abre la hoja de compartir; en el navegador es
 * una descarga normal.
 */
async function deliver(
  name: string,
  content: string,
  format: ExportFormat,
  title: string,
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({
      path: name,
      data: content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({ title, files: [uri], dialogTitle: title });
    return;
  }

  const type = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportSessions(sessions: SleepSession[], format: ExportFormat): Promise<void> {
  const content = format === 'csv' ? sessionsToCsv(sessions) : sessionsToJson(sessions);
  await deliver(`perfectrest-sueno-${localDate(Date.now())}.${format}`, content, format, 'Registros de sueño');
}

/**
 * Exporta el registro bruto del servicio (pantalla, cargador y sensores) junto
 * al historial. Sirve para afinar los umbrales con noches reales: sin ver los
 * eventos que produjeron una detección no hay forma de saber por qué falló.
 */
export async function exportRawEvents(events: RawEvent[], format: ExportFormat): Promise<void> {
  const content = format === 'csv' ? rawEventsToCsv(events) : rawEventsToJson(events);
  await deliver(
    `perfectrest-registro-bruto-${localDate(Date.now())}.${format}`,
    content,
    format,
    'Registro bruto de eventos',
  );
}
