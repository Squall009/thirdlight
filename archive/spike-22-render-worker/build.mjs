// SPIKE 22.2 (archived; not part of the build or the tests): make a render-worker
// variant of an existing Thirdlight export.
//
//   node archive/spike-22-render-worker/build.mjs <exportDir> <outDir>
//
// Copies the export to <outDir> and replaces js/main.js (page.ts: the export
// bootstrap with `?render=worker|main`), js/sim-worker.js (sim-worker.ts: the
// simulation worker teeing its frames to the render worker) and adds
// js/render-worker.js (render-worker.ts), each built from the current engine
// source with the export's pinned esbuild option set and the three → three/webgpu
// alias. The export dir is only read. Needs the workspace node_modules.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { build } from 'esbuild';

const HERE = import.meta.dirname;
/** export.md §5.3 (as packages/exporter/src/export-bundle.ts). */
const PINNED_OPTIONS = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
  define: { 'import.meta.url': 'location.href' },
};
const THREE_WEBGPU_ONLY_PLUGIN = {
  name: 'thirdlight-three-webgpu-only',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, (a) => b.resolve('three/webgpu', { kind: a.kind, resolveDir: a.resolveDir }));
  },
};

export async function buildBundles(outJsDir) {
  mkdirSync(outJsDir, { recursive: true });
  for (const [entry, out] of [
    ['page.ts', 'main.js'],
    ['sim-worker.ts', 'sim-worker.js'],
    ['render-worker.ts', 'render-worker.js'],
  ]) {
    const r = await build({ ...PINNED_OPTIONS, entryPoints: [join(HERE, entry)], write: false, plugins: [THREE_WEBGPU_ONLY_PLUGIN], logLevel: 'warning' });
    writeFileSync(join(outJsDir, out), r.outputFiles[0].contents);
  }
}

export async function buildVariant(exportDir, outDir) {
  if (!existsSync(join(exportDir, 'manifest.json'))) throw new Error(`not an export: ${exportDir}`);
  rmSync(outDir, { recursive: true, force: true });
  cpSync(exportDir, outDir, { recursive: true });
  await buildBundles(join(outDir, 'js'));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(HERE, 'build.mjs')) {
  const [exportDir, outDir] = process.argv.slice(2);
  if (exportDir === undefined || outDir === undefined) {
    console.error('usage: node archive/spike-22-render-worker/build.mjs <exportDir> <outDir>');
    process.exit(2);
  }
  await buildVariant(resolve(exportDir), resolve(outDir));
  console.log(`spike 22.2: render-worker variant -> ${outDir}`);
}
