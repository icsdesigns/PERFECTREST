/**
 * Auditoría de maquetación en un navegador real.
 *
 * Carga la app a varios anchos de móvil, recorre todas las pantallas y busca
 * los defectos que no se ven leyendo el CSS: desbordamientos horizontales,
 * cajas que se salen de su contenedor, textos que se solapan, contenido tapado
 * por la barra fija y valores de espaciado fuera de la escala del tema.
 *
 *   node scripts/layoutcheck.mjs [url]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5178/';

const CHROME_CANDIDATES = [
  '/opt/pw-browsers/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No se encontró Chrome ni Edge para ejecutar la auditoría.');
  process.exit(1);
}

/**
 * Recortes de pantalla que se simulan.
 *
 * Un navegador no tiene notch, así que `env(safe-area-inset-*)` siempre vale
 * cero y una maquetación que sólo se rompe con un recorte delante pasaba la
 * auditoría en verde. El CSS lee esos valores a través de `--safe-*`
 * (ver theme.css), y aquí se les da otro valor para auditar la app como si
 * estuviera en un móvil con notch y barra de gestos.
 */
const INSETS = [
  { name: 'sin recorte', top: 0, right: 0, bottom: 0, left: 0 },
  // Valores de un Galaxy S24+ / iPhone moderno en vertical.
  { name: 'con notch', top: 54, right: 0, bottom: 34, left: 0 },
];

/** Anchos representativos: móvil pequeño, medio, grande y tablet estrecha. */
const WIDTHS = [320, 360, 390, 430, 520];
const TABS = [
  ['home', 'Inicio'],
  ['goals', 'Metas'],
  ['cycles', 'Ciclos'],
  ['stats', 'Datos'],
  ['settings', 'Ajustes'],
];

/** Escala de espaciado del tema: cualquier otro valor es una desviación. */
const SCALE = [0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 96];

/** Estado sembrado para que todas las pantallas tengan contenido real. */
function seedState() {
  const DAY = 86400000;
  const now = Date.now();
  const sessions = [];
  for (let i = 1; i <= 12; i++) {
    const end = new Date(now - i * DAY);
    end.setHours(7 + (i % 3 === 0 ? 1 : 0), (i * 7) % 60, 0, 0);
    const hours = 6.5 + ((i * 37) % 200) / 100;
    sessions.push({
      id: `seed-${i}`,
      start: end.getTime() - hours * 3600000,
      end: end.getTime(),
      source: i % 3 === 0 ? 'auto' : 'manual',
      confidence: i % 4 === 0 ? 'medium' : 'high',
      confirmed: i % 3 !== 0,
      quality: (i % 5) + 1,
    });
  }
  return {
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
    reminders: {
      enabled: true,
      windDownMinutes: 30,
      toleranceMinutes: 15,
      nagIfLate: true,
      wakeAlarm: true,
    },
    monitor: {
      enabled: true,
      minGapMinutes: 180,
      maxGapMinutes: 780,
      nightStart: '21:30',
      nightEnd: '11:00',
      autoConfirm: false,
      background: true,
    },
    sessions,
    theme: 'dark',
    lastActiveAt: now - 3600000,
    pendingSessions: [],
    onboarded: true,
  };
}

/** Se ejecuta dentro de la página: recoge todos los defectos de una pantalla. */
function auditPage(scale) {
  const problems = [];
  const spacingUsage = {};

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  /** ¿El elemento o alguno de sus ancestros está fuera del flujo normal? */
  const positioned = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).position !== 'static') return true;
    }
    return false;
  };

  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
    const txt = (el.textContent || '').trim().slice(0, 34).replace(/\s+/g, ' ');
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`;
  };

  // 1. Scroll horizontal de la página: nunca debe existir en móvil.
  const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (docOverflow > 1) {
    problems.push({ kind: 'scroll-horizontal', detail: `la página desborda ${docOverflow}px` });
  }

  const all = [...document.querySelectorAll('body *')].filter(visible);

  // 2. Elementos que se salen del viewport por los lados.
  const vw = document.documentElement.clientWidth;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1) {
      // Los contenedores con scroll propio pueden ser más anchos por diseño.
      let inScroller = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') { inScroller = true; break; }
      }
      if (!inScroller) {
        problems.push({
          kind: 'fuera-de-viewport',
          detail: `${describe(el)} ocupa ${Math.round(r.left)}…${Math.round(r.right)} en ${vw}px`,
        });
      }
    }
  }

  // 3. Contenido desbordando su propio contenedor (texto que se escapa).
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") continue;
    // En SVG clientWidth/scrollWidth no describen el contenido: se omiten.
    if (el.ownerSVGElement || el.tagName === "svg") continue;
    if (el.scrollWidth - el.clientWidth > 1 && el.clientWidth > 0) {
      problems.push({
        kind: 'desborda-contenedor',
        detail: `${describe(el)} contenido ${el.scrollWidth}px en ${el.clientWidth}px`,
      });
    }
  }

  // 4. Solapamiento entre hermanos con texto propio.
  const leafText = all.filter(
    (el) => el.children.length === 0 && (el.textContent || '').trim().length > 0,
  );
  for (let i = 0; i < leafText.length; i++) {
    for (let j = i + 1; j < leafText.length; j++) {
      const a = leafText[i];
      const b = leafText[j];
      if (a.contains(b) || b.contains(a)) continue;
      // Sólo interesan elementos en el flujo normal. Lo que está posicionado
      // —o cuelga de algo posicionado, como la barra fija o una hoja modal—
      // se superpone a propósito y no es un defecto.
      if (positioned(a) || positioned(b)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 2 && oy > 2) {
        problems.push({
          kind: 'solapamiento',
          detail: `${describe(a)} × ${describe(b)} (${Math.round(ox)}×${Math.round(oy)}px)`,
        });
      }
    }
  }

  // 5. Contenido tapado por la barra de navegación fija.
  const tabbar = document.querySelector('.tabbar');
  if (tabbar) {
    const tb = tabbar.getBoundingClientRect();
    const screen = document.querySelector('.screen');
    if (screen) {
      const last = [...screen.querySelectorAll('*')]
        .filter(visible)
        .reduce((acc, el) => Math.max(acc, el.getBoundingClientRect().bottom), 0);
      const docBottom = document.documentElement.scrollHeight;
      // Con la página al final, el último contenido debe quedar por encima.
      if (Math.abs(window.scrollY + window.innerHeight - docBottom) < 4 && last > tb.top + 1) {
        problems.push({
          kind: 'tapado-por-tabbar',
          detail: `el contenido llega a ${Math.round(last)}px y la barra empieza en ${Math.round(tb.top)}px`,
        });
      }
    }
  }

  // 6. Zona segura superior: el recorte del móvil y la barra de estado.
  //
  // Desde Android 15 la app se dibuja bajo la barra de estado por obligación.
  // Dos cosas tienen que cumplirse: que haya una franja que la tape —si no, el
  // texto que se desplaza se lee encima del reloj— y que arriba del todo nada
  // del contenido caiga dentro del recorte.
  const safeTop = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--safe-top'),
  ) || 0;
  if (safeTop > 0) {
    const layer = document.querySelector('.onboard') ?? document.querySelector('.app');
    const band = layer ? parseFloat(getComputedStyle(layer, '::before').height) || 0 : 0;
    if (band + 0.5 < safeTop) {
      problems.push({
        kind: 'zona-segura-superior',
        detail: `la franja de la barra de estado mide ${Math.round(band)}px y el recorte ${Math.round(safeTop)}px`,
      });
    }
    if (window.scrollY < 4) {
      for (const el of all) {
        if (el.children.length > 0) continue;
        if (el.closest('.tabbar')) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > 0 && r.top < safeTop - 0.5) {
          problems.push({
            kind: 'zona-segura-superior',
            detail: `${describe(el)} empieza en ${Math.round(r.top)}px, dentro del recorte de ${Math.round(safeTop)}px`,
          });
        }
      }
    }
  }

  // 7. Objetivos táctiles demasiado pequeños.
  for (const el of all) {
    if (!['BUTTON', 'A', 'INPUT'].includes(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 32 || r.width < 32) {
      problems.push({
        kind: 'zona-tactil-pequena',
        detail: `${describe(el)} mide ${Math.round(r.width)}×${Math.round(r.height)}px`,
      });
    }
  }

  // 8. Espaciados fuera de la escala del tema.
  //
  // El relleno que absorbe una zona segura lleva sumado un valor que decide el
  // móvil, no el tema, así que se descuenta antes de juzgarlo: lo que tiene
  // que estar en la escala es lo que puso el diseño.
  const rootCS = getComputedStyle(document.documentElement);
  const inset = (name) => parseFloat(rootCS.getPropertyValue(name)) || 0;
  const SAFE_BY_PROP = {
    paddingTop: inset('--safe-top'),
    paddingRight: inset('--safe-right'),
    paddingBottom: inset('--safe-bottom'),
    paddingLeft: inset('--safe-left'),
  };

  for (const el of all) {
    const cs = getComputedStyle(el);
    for (const prop of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'gap', 'rowGap', 'columnGap', 'marginTop', 'marginBottom']) {
      const raw = cs[prop];
      if (!raw || raw === 'normal' || raw === 'auto') continue;
      const v = Math.round(parseFloat(raw) * 100) / 100;
      if (!Number.isFinite(v) || v === 0) continue;
      spacingUsage[v] = (spacingUsage[v] || 0) + 1;
      const safe = SAFE_BY_PROP[prop] ?? 0;
      const net = Math.round((v - safe) * 100) / 100;
      if (!scale.includes(v) && !(safe > 0 && scale.includes(net))) {
        problems.push({
          kind: 'espaciado-fuera-de-escala',
          detail: `${describe(el)} ${prop}: ${v}px`,
        });
      }
    }
  }

  return { problems, spacingUsage };
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none'],
});

const seeded = seedState();
let total = 0;
const byKind = {};
const spacingAll = {};

/**
 * Estados que no aparecen en el recorrido normal pero se muestran a pantalla
 * completa: hay que auditarlos igual.
 */
const VARIANTS = [
  { name: 'oscuro', state: seeded },
  { name: 'claro', state: { ...seeded, theme: 'light' } },
  { name: 'onboarding', state: { ...seeded, onboarded: false }, skipTabs: true },
  {
    // Dos propuestas en cola: se enseña la primera y el punto del icono de
    // «Datos» avisa de que hay algo que confirmar. Van dos y no una porque la
    // cola es lo que evita perder noches cuando se acumulan.
    name: 'sesión pendiente',
    state: {
      ...seeded,
      pendingSessions: [
        {
          id: 'pend-1',
          start: Date.now() - 33 * 3600000,
          end: Date.now() - 25 * 3600000,
          source: 'auto',
          confidence: 'high',
          confirmed: false,
          triggers: ['screen'],
        },
        {
          id: 'pend-2',
          start: Date.now() - 9 * 3600000,
          end: Date.now() - 3600000,
          source: 'auto',
          confidence: 'medium',
          confirmed: false,
          triggers: ['screen', 'idle'],
        },
      ],
    },
  },
  {
    // Propuesta de inicio dudoso con hábito aprendido: el aviso ofrece «¿Desde
    // las HH:MM, como sueles?» y la hoja trae el contexto del dispositivo, que
    // se despliega para auditarlo con sus filas más largas.
    name: 'dudosa con contexto',
    state: { ...seeded, pendingSessions: [doubtfulWithContext()] },
  },
];

/** Una propuesta dudosa de anoche (hasta las 07:10) con un contexto lleno. */
function doubtfulWithContext() {
  const end = new Date();
  if (end.getHours() * 60 + end.getMinutes() < 7 * 60 + 10) end.setDate(end.getDate() - 1);
  end.setHours(7, 10, 0, 0);
  const e = end.getTime();
  const s = e - 4.6 * 3600000;
  const state = (start, finish, pct) => ({ start, end: finish, changes: 2, pct });
  return {
    id: 'pend-dudosa',
    start: s,
    end: e,
    source: 'auto',
    confidence: 'low',
    confirmed: false,
    inferred: true,
    triggers: ['screen', 'idle'],
    context: {
      v: 1,
      collected: e + 3600000,
      from: s - 1800000,
      to: e + 1800000,
      span: { start: s, end: e },
      device: {
        model: 'SM-S928B Galaxy S24 Ultra', manufacturer: 'samsung', sdk: 36, release: '16', app: '1.4.0',
        locale: 'es-ES', tz: 'America/Argentina/Buenos_Aires', tzOffsetMin: -180,
        batteryExempt: false, exactAlarms: true, notifications: true,
      },
      screen: {
        ons: 14, unlocks: 9, glances: 5, nightUnlocks: 4, nightOns: 7, useSec: 3725, longestSec: 1525,
        usesSec: [1525, 125, 175, 61, 3, 59, 600, 1200, 45, 90, 12, 300, 15, 2, 999, 3599, 61, 62, 63, 64],
        onAtStart: false, onAtEnd: true,
      },
      power: {
        plugs: 2, unplugs: 2, chargingPct: 87,
        chargeType: state(2, 0, { 0: 13, 2: 87 }),
        battery: { start: 23, end: 100, min: 18, max: 100, changes: 9 },
        tempC: { min: 24.5, max: 38.9 },
      },
      system: {
        doze: state(0, 1, { 0: 40, 1: 60 }),
        dnd: state(1, 2, { 1: 30, 2: 70 }),
        airplane: state(0, 0, { 0: 100 }),
        powerSave: state(0, 1, { 0: 80, 1: 20 }),
        ringer: state(2, 1, { 1: 70, 2: 30 }),
        net: state(1, 4, { 0: 10, 1: 60, 2: 20, 4: 10 }),
        bt: { start: 0, end: 2, min: 0, max: 2, changes: 2 },
        bright: { start: 100, end: 4, min: 4, max: 100, changes: 3 },
        orient: state(1, 2, { 1: 50, 2: 50 }),
      },
      sensors: {
        on: ['steps', 'light', 'proximity', 'posture'],
        steps: { steps: 12345, motions: 7 },
        light: { pct: { dark: 80, dim: 15, bright: 5 }, luxMin: 0, luxMax: 31250, changes: 5 },
        proximity: { coveredPct: 35, changes: 12 },
        posture: { readings: 28, flatPct: 75, carried: 3, tilted: 4 },
        audio: { playingPct: 12, starts: 2 },
        alarm: { at: e - 600000, deltaMin: -10, status: 'cancelled', setAtStart: true },
      },
      service: { restarts: 1, errors: 0 },
      algo: {
        triggers: ['screen', 'idle'], confidence: 'low', inferred: true, score: 0.42, gapMin: 640,
        startShiftMin: 155, endShiftMin: -5, latencyMin: 15, latencySource: 'settings',
        habit: { startMin: 1410, endMin: 435, n: 8 },
        discards: [{ reason: 'out-of-pattern', startMin: 300, endMin: 480 }, { reason: 'secondary', startMin: 600, endMin: 700 }],
      },
      partial: true,
    },
  };
}

for (const variant of VARIANTS) {
for (const inset of INSETS) {
for (const width of WIDTHS) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 800, deviceScaleFactor: 2, isMobile: true });
  await page.evaluateOnNewDocument((state) => {
    localStorage.setItem('perfectrest.state.v1', JSON.stringify(state));
  }, variant.state);
  await page.goto(URL, { waitUntil: 'networkidle0' });
  // Después de cargar, para ganar a la hoja del tema por orden de aparición.
  if (inset.top || inset.bottom || inset.left || inset.right) {
    await page.addStyleTag({
      content: `:root{--safe-top:${inset.top}px;--safe-right:${inset.right}px;--safe-bottom:${inset.bottom}px;--safe-left:${inset.left}px}`,
    });
  }
  await new Promise((r) => setTimeout(r, 350));

  // El onboarding ocupa toda la pantalla: se audita tal cual, sin pestañas.
  if (variant.skipTabs) {
    const { problems, spacingUsage } = await page.evaluate(auditPage, SCALE);
    for (const [k, v] of Object.entries(spacingUsage)) spacingAll[k] = (spacingAll[k] || 0) + v;
    for (const p of problems) {
      const key = `${p.kind}|${p.detail}`;
      byKind[p.kind] ??= new Map();
      const prev = byKind[p.kind].get(key);
      if (prev) prev.widths.add(width);
      else byKind[p.kind].set(key, { detail: p.detail, widths: new Set([width]), tab: `${variant.name}·${inset.name}` });
      total++;
    }
    await page.close();
    continue;
  }

  for (const [tab, label] of TABS) {
    await page.evaluate((t) => {
      const byLabel = [...document.querySelectorAll('.tab')].find(
        (b) => b.textContent.trim().endsWith(t),
      );
      if (byLabel) byLabel.click();
      else document.querySelector('.iconbtn')?.click();
    }, label);
    await new Promise((r) => setTimeout(r, 260));
    // Las secciones plegables (contexto de la noche) se auditan desplegadas.
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));

    // Se audita arriba del todo y con la página desplazada al final, que es
    // donde aparecen los problemas con la barra fija.
    for (const position of ['top', 'bottom']) {
      if (position === 'bottom') {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await new Promise((r) => setTimeout(r, 220));
      }
      const { problems, spacingUsage } = await page.evaluate(auditPage, SCALE);
      for (const [k, v] of Object.entries(spacingUsage)) spacingAll[k] = (spacingAll[k] || 0) + v;

      // Se agrupan por tipo y detalle para no repetir el mismo defecto en
      // cada ancho y posición.
      for (const p of problems) {
        const key = `${p.kind}|${p.detail}`;
        byKind[p.kind] ??= new Map();
        const prev = byKind[p.kind].get(key);
        if (prev) prev.widths.add(width);
        else byKind[p.kind].set(key, { detail: p.detail, widths: new Set([width]), tab: `${variant.name}·${inset.name}/${label}` });
        total++;
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    // La hoja de edición se abre sobre el historial y tapa la pantalla: se
    // audita como un estado más.
    if (label === 'Datos') {
      const opened = await page.evaluate(() => {
        const first = document.querySelector('.session');
        if (!first) return false;
        first.click();
        return true;
      });
      if (opened) {
        await new Promise((r) => setTimeout(r, 300));
        await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
        const { problems } = await page.evaluate(auditPage, SCALE);
        for (const pr of problems) {
          const key = `${pr.kind}|${pr.detail}`;
          byKind[pr.kind] ??= new Map();
          const prev = byKind[pr.kind].get(key);
          if (prev) prev.widths.add(width);
          else byKind[pr.kind].set(key, { detail: pr.detail, widths: new Set([width]), tab: `${variant.name}·${inset.name}/hoja` });
          total++;
        }
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.close();
}
}
}

await browser.close();

console.log('\n=== Auditoría de maquetación ===');
console.log(`Anchos probados: ${WIDTHS.join(', ')}px · pantallas: ${TABS.length} · recortes: ${INSETS.map((i) => i.name).join(', ')}\n`);

const ORDER = [
  'scroll-horizontal',
  'fuera-de-viewport',
  'desborda-contenedor',
  'solapamiento',
  'tapado-por-tabbar',
  'zona-segura-superior',
  'zona-tactil-pequena',
  'espaciado-fuera-de-escala',
];

let distinct = 0;
for (const kind of ORDER) {
  const map = byKind[kind];
  if (!map || map.size === 0) continue;
  console.log(`\n## ${kind} (${map.size})`);
  for (const { detail, widths, tab } of [...map.values()].slice(0, 14)) {
    console.log(`   [${tab}] ${detail}  @${[...widths].join('/')}px`);
    distinct++;
  }
  if (map.size > 14) console.log(`   … y ${map.size - 14} más`);
}

console.log('\n## espaciados usados (px → veces)');
console.log(
  '   ' +
    Object.entries(spacingAll)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([v, n]) => `${v}:${n}`)
      .join('  '),
);

console.log(
  distinct === 0
    ? '\nMAQUETACIÓN OK — sin defectos\n'
    : `\n${distinct} defectos distintos (${total} incidencias)\n`,
);
process.exit(distinct === 0 ? 0 : 1);
