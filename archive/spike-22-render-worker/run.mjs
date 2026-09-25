#!/usr/bin/env node
// SPIKE 22.2 (archived): bundle run.ts (like tools/perf/run.mjs does for the
// harness) into dist/perf/spike222.mjs and run it. Needs `npm run build`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import * as esbuild from 'esbuild';

const REPO = resolve(import.meta.dirname, '..', '..');
if (!existsSync(join(REPO, 'dist', 'backend', 'backend.mjs'))) {
  console.error('spike222: dist/ is missing: run `npm run build` first');
  process.exit(2);
}
const out = join(REPO, 'dist', 'perf', 'spike222.mjs');
mkdirSync(dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [join(import.meta.dirname, 'run.ts')],
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
