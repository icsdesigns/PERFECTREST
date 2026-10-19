/**
 * Captura cada pantalla de la app a tamaño de móvil, para revisarlas de un
 * vistazo. Las imágenes van a `screenshots/`.
 *
 *   node scripts/screenshots.mjs [url] [ancho]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5178/';
const WIDTH = Number(process.argv[3] ?? 390);
const OUT = 'screenshots';

const executablePath = [
  '/opt/pw-browsers/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

mkdirSync(OUT, { recursive: true });

const now = Date.now();
const sessions = Array.from({ length: 12 }, (_, k) => {
  const i = k + 1;
  const end = new Date(now - i * 86400000);
  end.setHours(7 + (i % 3 === 0 ? 1 : 0), (i * 7) % 60, 0, 0);
  const hours = 6.5 + ((i * 37) % 200) / 100;
  return {
    id: `seed-${i}`,
    start: end.getTime() - hours * 3600000,
    end: end.getTime(),
    source: i % 3 === 0 ? 'auto' : 'manual',
    confidence: i % 4 === 0 ? 'medium' : 'high',
    confirmed: i % 3 !== 0,
    quality: (i % 5) + 1,
  };
});

const state = {
  schedule: {
    mode: 'weekday-weekend',
    goals: {
      1: { wakeTime: '07:00', targetHours: 8 },
      2: { wakeTime: '07:00', targetHours: 8 },
      3: { wakeTime: '07:00', targetHours: 8 },
      4: { wakeTime: '07:00', targetHours: 8 },
      5: { wakeTime: '07:00', targetHours: 8 },
      6: { wakeTime: '09:30', targetHours: 8.75 },
      7: { wakeTime: '09:30', targetHours: 8.75 },
    },
  },
  cycles: { cycleMinutes: 90, latencyMinutes: 15 },
  reminders: { enabled: true, windDownMinutes: 30, toleranceMinutes: 15, nagIfLate: true, wakeAlarm: true },
  monitor: { enabled: true, minGapMinutes: 180, maxGapMinutes: 780, nightStart: '21:30', nightEnd: '11:00', autoConfirm: false, background: true },
  sessions,
  theme: 'dark',
  lastActiveAt: now - 3600000,
  pendingSessions: [],
  onboarded: true,
};

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none'],
});

const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: 844, deviceScaleFactor: 2, isMobile: true });
await page.evaluateOnNewDocument((s) => {
  localStorage.setItem('perfectrest.state.v1', JSON.stringify(s));
}, state);
await page.goto(URL, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));

for (const label of ['Inicio', 'Metas', 'Ciclos', 'Datos', 'Ajustes']) {
  await page.evaluate((t) => {
    const tab = [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim().endsWith(t));
    if (tab) tab.click();
    else document.querySelector('.iconbtn')?.click();
  }, label);
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${OUT}/${label.toLowerCase()}.png`, fullPage: true });
  console.log(`${OUT}/${label.toLowerCase()}.png`);
}

// El onboarding necesita el estado sin inicializar.
const fresh = await browser.newPage();
await fresh.setViewport({ width: WIDTH, height: 844, deviceScaleFactor: 2, isMobile: true });
await fresh.evaluateOnNewDocument((s) => {
  localStorage.setItem('perfectrest.state.v1', JSON.stringify({ ...s, onboarded: false }));
}, state);
await fresh.goto(URL, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 500));
await fresh.screenshot({ path: `${OUT}/onboarding.png`, fullPage: true });
console.log(`${OUT}/onboarding.png`);

await browser.close();
