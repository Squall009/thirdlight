#!/usr/bin/env node
/**
 * Phase 17.2: (re)capture the WebGL reference images of the shader parity
 * test — every case of `harness.ts` drawn by the legacy WebGLRenderer on
 * SwiftShader — into `refs/<case>.png`.
 *
 *   node tests/e2e/shader-parity/capture.mjs
 *
 * Only re-capture when the legacy shading itself changes on purpose (the
 * references are what the node materials must match); commit the PNGs.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..', '..', '..');
const run = spawnSync('npx', ['playwright', 'test', 'tests/e2e/shader-parity.e2e.ts', '--project=default'], {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env, TL_CAPTURE_SHADER_REFS: '1' },
});
process.exit(run.status ?? 1);
