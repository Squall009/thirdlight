#!/usr/bin/env node
/**
 * Packet 14 — build ts-probe.ts with the repo's PINNED esbuild under the exact
 * pinned option set of export.md §5.3 (every other option at esbuild 0.28.2
 * default; no defines/banners/loaders/aliases/externals). The candidate package
 * is resolved from the DISPOSABLE prefix via nodePaths (env EVAL_PREFIX), never
 * from the repo lockfile (plan-review BR-1).
 *
 * Usage: node build-iife.mjs <outDir>
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const require = createRequire(join(repoRoot, 'package.json')); // repo-pinned esbuild
const esbuild = require('esbuild');
const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node build-iife.mjs <outDir>');
  process.exit(2);
}
const prefix = process.env.EVAL_PREFIX ?? '/tmp/tl-m2-eval-14';
mkdirSync(outDir, { recursive: true });

if (esbuild.version !== '0.28.2') {
  console.error(`FATAL: repo esbuild is ${esbuild.version}, pinned 0.28.2 (dependencies.md §7)`);
  process.exit(1);
}

const t0 = process.hrtime.bigint();
const result = await esbuild.build({
  entryPoints: [join(here, 'ts-probe.ts')],
  // --- exact pinned option set (export.md §5.3); all others at default ---
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
  // --- evaluation-only resolution (not a build-config change) ---
  nodePaths: [join(prefix, 'rapier2d-compat/node_modules')],
  outfile: join(outDir, 'probe-iife.js'),
  metafile: true,
});
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const meta = result.metafile;
const modCount = Object.keys(meta?.inputs ?? {}).length;
console.log(
  JSON.stringify({
    esbuildVersion: esbuild.version,
    flags: { bundle: true, platform: 'browser', format: 'iife', treeShaking: false, sourcemap: false, minify: false },
    buildMs: Number(ms.toFixed(1)),
    outputBytes: (meta?.outputs ?? [])[0]?.bytes,
    inputModules: modCount,
    topLevelAwaitRejected: 'n/a — build succeeded, which under format:iife means no top-level await reached the output (esbuild rejects it at build time)',
  }, null, 2),
);
