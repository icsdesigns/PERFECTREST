/**
 * Prueba de humo de la interfaz: renderiza cada pantalla fuera del navegador
 * para detectar errores de render (hooks mal usados, accesos a undefined,
 * datos que no existen todavía) sin necesidad de abrir la app a mano.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { StoreProvider } from '../src/state/store';
import { UpdateProvider } from '../src/state/update';
import App from '../src/App';
import { HomeScreen } from '../src/screens/HomeScreen';
import { GoalsScreen } from '../src/screens/GoalsScreen';
import { CyclesScreen } from '../src/screens/CyclesScreen';
import { StatsScreen } from '../src/screens/StatsScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { SessionSheet } from '../src/components/SessionSheet';
import type { SleepSession } from '../src/lib/types';

let failures = 0;

function check(name: string, node: React.ReactElement, mustContain: string[] = []) {
  try {
    const html = renderToStaticMarkup(node);
    const missing = mustContain.filter((t) => !html.includes(t));
    if (missing.length) {
      failures++;
      console.log(`  FAIL ${name} — falta en el HTML: ${missing.join(', ')}`);
    } else {
      console.log(`  ok   ${name} (${html.length} caracteres)`);
    }
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

const wrap = (node: React.ReactElement) => (
  <StoreProvider>
    <UpdateProvider>{node}</UpdateProvider>
  </StoreProvider>
);

console.log('\n--- Render de pantallas ---');
check('App (onboarding en el primer arranque)', wrap(<App />), [
  'Duerme mejor',
  'Empezar',
]);
// El encabezado cambia según la hora a la que se ejecute la prueba ("Acuéstate
// hoy a las" antes de la hora ideal, "Tu hora era a las" después), así que se
// comprueban textos que no dependen del reloj.
check('Inicio', wrap(<HomeScreen onGoTo={() => {}} />), [
  'Despertarás a las',
  'Consistencia',
  'Media de 7 días',
]);
check('Metas', wrap(<GoalsScreen />), ['Toda la semana', 'Horas objetivo', 'Avisos']);
check('Ciclos', wrap(<CyclesScreen />), ['ciclos', 'Duración del ciclo']);
check('Datos (sin sesiones)', wrap(<StatsScreen />), ['Sin noches registradas', 'Añadir noche']);
check('Ajustes', wrap(<SettingsScreen />), [
  'Apariencia',
  'Detección automática',
  // El registro es lo primero que hay que mirar cuando no se detecta nada: si
  // desaparece de Ajustes, el diagnóstico vuelve a ser un callejón sin salida.
  'Registro de detección',
  'Probar un disparador',
  'Reposo profundo del sistema',
  'Modo «No molestar»',
]);

const demo: SleepSession = {
  id: 'demo',
  start: new Date('2026-08-18T23:10:00').getTime(),
  end: new Date('2026-08-19T07:05:00').getTime(),
  source: 'auto',
  confidence: 'high',
  confirmed: false,
};
check('Hoja de sesión', <SessionSheet session={demo} onSave={() => {}} onClose={() => {}} />, [
  'Confirma esta noche',
  '7h 55m',
]);
check('Hoja de sesión con inicio inferido',
  <SessionSheet session={{ ...demo, confidence: 'low', inferred: true }} onSave={() => {}} onClose={() => {}} />,
  ['Inicio sin medir']);

console.log(failures === 0 ? '\nRENDER OK\n' : `\n${failures} FALLOS DE RENDER\n`);
process.exit(failures === 0 ? 0 : 1);
