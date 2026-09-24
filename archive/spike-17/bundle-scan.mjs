// SPIKE 17.0 (throwaway): bundle-size impact of three/webgpu on the export and
// the export scan patterns (packages/exporter/src/scan.ts) over reference
// bundles built with the export's pinned esbuild options.
//   node archive/spike-17/bundle-scan.mjs [bundle.js ...]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { build } from 'esbuild';

import { PINNED_OPTIONS } from './build-variant.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
/** scan.ts needles and the §5.4.1 recorded counts for the pinned three (-1: strict 0, no exception). */
const NEEDLES = { 'fetch(': 3, 'process.': 3, http: 3, 'https://': 23, 'file://': 0, XMLHttpRequest: 3, WebSocket: 0, '__dirname': 0, '/api/v1/': 0, 'node:': 0, '/mcp': 0 };
const needleText = (n) => (n === 'http' ? 'http://' : n);

function count(h, n) {
  let c = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) c++;
  return c;
}
function contexts(h, n, max = 12) {
  const out = [];
  for (let i = h.indexOf(n); i !== -1 && out.length < max; i = h.indexOf(n, i + n.length)) out.push(h.slice(Math.max(0, i - 50), i + 60).replace(/\s+/g, ' '));
  return out;
}

const ENTRIES = {
  'three (today: reference full core)': "import * as THREE from 'three'; globalThis.T = THREE;",
  'three/webgpu': "import * as THREE from 'three/webgpu'; globalThis.T = THREE;",
  'three/webgpu + three/tsl': "import * as THREE from 'three/webgpu'; import * as TSL from 'three/tsl'; globalThis.T = [THREE, TSL];",
  'three + three/webgpu + three/tsl (transition)': "import * as A from 'three'; import * as THREE from 'three/webgpu'; import * as TSL from 'three/tsl'; globalThis.T = [A, THREE, TSL];",
  'three/webgpu + tsl + node post (bloom, smaa, fxaa, gtao, dof)':
    "import * as THREE from 'three/webgpu'; import * as TSL from 'three/tsl'; import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'; import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js'; import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js'; import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js'; import { dof } from 'three/examples/jsm/tsl/display/DepthOfFieldNode.js'; import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js'; globalThis.T = [THREE, TSL, bloom, smaa, fxaa, ao, dof, SkyMesh];",
};

async function bundle(src, minify = false) {
  const r = await build({ ...PINNED_OPTIONS, minify, stdin: { contents: src, resolveDir: REPO, loader: 'js' }, write: false, logLevel: 'error' });
  return r.outputFiles[0].text;
}

function scanRow(text) {
  const row = {};
  for (const [n, want] of Object.entries(NEEDLES)) {
    const c = count(text, needleText(n));
    row[needleText(n)] = c === want ? c : `${c} (record ${want})`;
  }
  return row;
}

const kb = (n) => `${(n / 1024).toFixed(0)} KiB`;
for (const [name, src] of Object.entries(ENTRIES)) {
  const text = await bundle(src);
  const min = await bundle(src, true);
  console.log(`\n## ${name}\n  pinned (unminified): ${kb(text.length)}  gzip ${kb(gzipSync(text).length)}  | minified ${kb(min.length)} gzip ${kb(gzipSync(min).length)}`);
  const row = scanRow(text);
  console.log('  scan counts:', JSON.stringify(row));
  for (const [n, want] of Object.entries(NEEDLES)) {
    const t = needleText(n);
    if (count(text, t) !== want) for (const c of contexts(text, t)) console.log(`    ${t}: …${c}…`);
  }
}
for (const f of process.argv.slice(2)) {
  const text = readFileSync(f, 'utf8');
  console.log(`\n## ${f}\n  ${kb(text.length)} gzip ${kb(gzipSync(text).length)}`);
  console.log('  scan counts:', JSON.stringify(scanRow(text)));
}
