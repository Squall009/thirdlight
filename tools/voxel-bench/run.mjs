#!/usr/bin/env node
/**
 * Run the voxel storage harness.
 *
 *   node tools/voxel-bench/run.mjs [options]          # the storage harness; options: tools/voxel-bench/cli.ts
 *   node tools/voxel-bench/run.mjs decode [options]   # the browser decode bench; options: tools/voxel-bench/decode-cli.ts
 *   node tools/voxel-bench/run.mjs costs              # apron and rebuild costs per chunk edge (costs-cli.ts)
 *   node tools/voxel-bench/run.mjs region [options]   # region file sizes, write amplification, range reads, repo growth (region-cli.ts)
 *   node tools/voxel-bench/run.mjs edits [options]    # edit apply, undo bytes, saves and dirty rewrites (edits-cli.ts)
 *
 * Refuses to start outside a memory-capped cgroup (tools/perf/memory-cap.mjs):
 * the test worlds are generated chunk by chunk, but a dense window of a
 * world still takes hundreds of MB. Bundles cli.ts with esbuild into
 * dist/voxel-bench/cli.mjs and runs it. Not part of `npm test`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { CAPPED_COMMAND, NO_MEMORY_CAP_FLAG, memoryCap, refusal } from '../perf/memory-cap.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const uncapped = args.includes(NO_MEMORY_CAP_FLAG);
const why = uncapped ? null : refusal();
if (why !== null) {
  console.error(`voxel-bench: not started: ${why}. Start it in a capped scope:\n  ${CAPPED_COMMAND.replace('tools/perf/run.mjs', 'tools/voxel-bench/run.mjs')}\nor pass ${NO_MEMORY_CAP_FLAG} on a host where nothing else runs.`);
  process.exit(2);
}
const mode = ['decode', 'costs', 'region', 'edits'].includes(args[0]) ? args[0] : null;
const entry = mode === null ? 'cli' : `${mode}-cli`;
const rest = (mode === null ? args : args.slice(1)).filter((a) => a !== NO_MEMORY_CAP_FLAG);
const out = join(REPO, 'dist', 'voxel-bench', `${entry}.mjs`);
mkdirSync(dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [join(REPO, 'tools', 'voxel-bench', `${entry}.ts`)],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  // The decode bench drives a browser and builds the worker itself: those stay node_modules imports.
  external: ['@playwright/test', 'playwright-core', 'esbuild'],
  logLevel: 'warning',
});
const cap = memoryCap();
// --expose-gc: the access benchmark settles the heap before and after loading a window to measure what it holds.
const r = spawnSync(process.execPath, ['--expose-gc', out, ...rest], {
  stdio: 'inherit',
  env: { ...process.env, TL_VOXEL_BENCH_CAP: cap === null ? '' : String(cap.max), TL_VOXEL_BENCH_REPO: REPO },
});
process.exit(r.status ?? 1);
