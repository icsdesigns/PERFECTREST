/**
 * Ejecuta las comprobaciones del proyecto sin necesidad de un framework de
 * tests: compila cada suite con esbuild a un bundle temporal dentro de
 * node_modules y la corre con Node.
 *
 *   npm run check
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'node_modules/.perfectrest');
mkdirSync(outDir, { recursive: true });

const suites = [
  { name: 'dominio', entry: 'scripts/selfcheck.ts' },
  { name: 'noches', entry: 'scripts/nightsim.ts' },
  { name: 'precision', entry: 'scripts/precisioncheck.ts' },
  { name: 'render', entry: 'scripts/rendercheck.tsx' },
];

let failed = false;

for (const suite of suites) {
  const outfile = resolve(outDir, `${suite.name}.mjs`);
  await build({
    entryPoints: [resolve(root, suite.entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    // Los estilos no aportan nada fuera del navegador.
    loader: { '.css': 'empty' },
    // React debe resolverse desde node_modules, no duplicarse en el bundle.
    external: ['react', 'react-dom'],
    outfile,
    logLevel: 'error',
  });

  const res = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  if (res.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
