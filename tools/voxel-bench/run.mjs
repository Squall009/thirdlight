#!/usr/bin/env node
/**
 * Run the voxel storage harness.
 *
 *   node tools/voxel-bench/run.mjs [options]   # options: tools/voxel-bench/cli.ts
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
const out = join(REPO, 'dist', 'voxel-bench', 'cli.mjs');
mkdirSync(dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [join(REPO, 'tools', 'voxel-bench', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  logLevel: 'warning',
});
const cap = memoryCap();
const r = spawnSync(process.execPath, [out, ...args.filter((a) => a !== NO_MEMORY_CAP_FLAG)], {
  stdio: 'inherit',
  env: { ...process.env, TL_VOXEL_BENCH_CAP: cap === null ? '' : String(cap.max) },
});
process.exit(r.status ?? 1);
