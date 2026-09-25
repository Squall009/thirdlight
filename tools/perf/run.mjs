#!/usr/bin/env node
/**
 * Phase 21.1: run the performance harness.
 *
 *   npm run build                       # the harness drives dist/ (backend, editor, preview)
 *   node tools/perf/run.mjs [options]   # see tools/perf/cli.ts for the options
 *
 * Bundles tools/perf/cli.ts (TypeScript) into dist/perf/cli.mjs with esbuild
 * (third-party packages stay imports from node_modules) and runs it. The
 * report goes to ~/.cache/thirdlight-perf/reports/ (latest.json too). Not part
 * of `npm test` or the default Playwright run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
const r = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
