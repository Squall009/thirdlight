#!/usr/bin/env node
/**
 * Run the performance harness.
 *
 *   npm run build                       # the harness drives dist/ (backend, editor, preview)
 *   node tools/perf/run.mjs [options]   # see tools/perf/cli.ts for the options
 *
 *   node tools/perf/run.mjs --help      # the options (a command's own: run.mjs <command> --help)
 *
 * Refuses to start outside a memory-capped cgroup (tools/perf/memory-cap.mjs).
 * Bundles tools/perf/cli.ts (TypeScript) into dist/perf/cli.mjs with esbuild
 * (third-party packages stay imports from node_modules) and runs it. The
 * report goes to ~/.cache/thirdlight-perf/reports/ (latest.json too). Not part
 * of `npm test` or the default Playwright run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { CAPPED_COMMAND, NO_MEMORY_CAP_FLAG, refusal } from './memory-cap.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = join(REPO, 'tools', 'perf');

/** A source file's leading doc comment, without its `*` margins. */
function docComment(file) {
  const m = /\/\*\*([\s\S]*?)\*\//.exec(readFileSync(file, 'utf8'));
  return m === null ? '' : m[1].split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim();
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  // The options live in the comments of cli.ts and of each sub-command's module (cli.ts names it).
  const usage = docComment(join(HERE, 'cli.ts'));
  const sub = args[0] !== undefined && !args[0].startsWith('-') ? args[0] : null;
  const file = sub === null ? null : new RegExp(`^\\s*${sub} \\[[^\\]]*\\].*\\((tools/perf/[\\w-]+\\.ts)`, 'm').exec(usage)?.[1];
  console.log(file != null ? `node tools/perf/run.mjs ${sub} [options]\n\n${docComment(join(REPO, file))}` : `node tools/perf/run.mjs [command] [options]   (--help after a command: its options)\n\n${usage}\n\n  ${NO_MEMORY_CAP_FLAG}   start without a memory-capped cgroup (see tools/perf/memory-cap.mjs)`);
  process.exit(0);
}
const uncapped = args.includes(NO_MEMORY_CAP_FLAG);
const why = uncapped ? null : refusal();
if (why !== null) {
  console.error(`perf: not started: ${why}. A run starts a backend and a browser; start it in a capped scope:\n  ${CAPPED_COMMAND}\nor pass ${NO_MEMORY_CAP_FLAG} on a host where nothing else runs.`);
  process.exit(2);
}
if (!existsSync(join(REPO, 'dist', 'backend', 'backend.mjs'))) {
  console.error('perf: dist/ is missing: run `npm run build` first');
  process.exit(2);
}
const out = join(REPO, 'dist', 'perf', 'cli.mjs');
mkdirSync(dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [join(REPO, 'tools', 'perf', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  logLevel: 'warning',
  plugins: [
    {
      name: 'external-packages',
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@thirdlight/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});
const r = spawnSync(process.execPath, [out, ...args.filter((a) => a !== NO_MEMORY_CAP_FLAG)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
