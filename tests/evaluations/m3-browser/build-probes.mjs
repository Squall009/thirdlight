#!/usr/bin/env node
/**
 * Packet 38 — build the browser probes.
 *
 * Bundles the two probe entries with the repository's pinned esbuild (no new
 * dependency) into `tests/evaluations/m3-browser/.build/`, copies the committed
 * fixture GLB the engine probe loads, and writes the static pages. The pages are
 * byte-identical apart from the CSP the runner serves them with.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUILD_DIR = join(HERE, '.build');
const REPO_ROOT = join(HERE, '..', '..', '..');

const page = (script, title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="./probe.css">
</head>
<body>
<div id="hud">${title}</div>
<script src="./${script}"></script>
</body>
</html>
`;

export async function buildProbes() {
  mkdirSync(BUILD_DIR, { recursive: true });
  for (const name of ['capability', 'engine']) {
    await build({
      entryPoints: [join(HERE, 'probes', `${name}.ts`)],
      outfile: join(BUILD_DIR, `${name}.js`),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      logLevel: 'warning',
      absWorkingDir: REPO_ROOT,
      nodePaths: [join(REPO_ROOT, 'node_modules')],
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  }
  copyFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'assets', 'tiny-v2.glb'), join(BUILD_DIR, 'tiny-v2.glb'));
  // The production preview CSP is `style-src 'self'`, so the stylesheet must be
  // an external file: an inline <style> is blocked in the real browser.
  writeFileSync(
    join(BUILD_DIR, 'probe.css'),
    'html,body{margin:0;background:#0b1016;color:#e8eef6;font:14px/1.4 system-ui,sans-serif}' +
      '#hud{position:fixed;left:8px;top:8px;padding:6px 10px;background:#000;border:1px solid #2a3a4a;border-radius:4px}' +
      'canvas{display:block}\n',
  );
  writeFileSync(join(BUILD_DIR, 'capability.html'), page('capability.js', 'capability probe'));
  writeFileSync(join(BUILD_DIR, 'engine.html'), page('engine.js', 'engine probe (production CSP)'));
  writeFileSync(join(BUILD_DIR, 'engine-nocsp.html'), page('engine.js', 'engine probe (no CSP)'));
  writeFileSync(join(BUILD_DIR, 'engine-csp-wasm.html'), page('engine.js', 'engine probe (CSP + wasm-unsafe-eval)'));
  return BUILD_DIR;
}

if (process.argv[1]?.endsWith('build-probes.mjs')) {
  const dir = await buildProbes();
  console.log(`built probes into ${dir}`);
}
