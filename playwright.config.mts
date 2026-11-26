/**
 * The boot check, the one browser test (tests/e2e/boot.e2e.ts): the real
 * backend bundle (dist/) and the real editor in Chromium. `tools/gate.sh check`
 * runs it after `npm run build`; alone: `npx playwright test --project=default`.
 *
 * Chromium: Playwright's own download (`npx playwright install chromium`).
 * On hosts without the system libraries Chromium needs, point
 * TL_BROWSER_LIBS at an extracted library tree (see tests/e2e/browser-env.mjs).
 *
 * The browser draws on the host's GPU where the render node is usable
 * (`gpuAvailable` in tests/e2e/browser-env.mjs), the product's own renderer
 * (`auto` → WebGPU). Without one (or with TL_E2E_SOFTWARE=1) it draws on
 * SwiftShader with its WebGPU adapter: WebGL 2 is not checked.
 */
import { defineConfig } from '@playwright/test';

import { browserLaunchEnv, GPU_ARGS, gpuAvailable, SOFTWARE_GL_ARGS, SOFTWARE_WEBGPU_ARGS } from './tests/e2e/browser-env.mjs';

const ARGS = gpuAvailable() ? GPU_ARGS : [...SOFTWARE_GL_ARGS, ...SOFTWARE_WEBGPU_ARGS];

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  // One backend for the file: its tests run in order (the export test stops the backend last).
  workers: Number(process.env['TL_E2E_WORKERS'] ?? 1),
  timeout: 60_000,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    viewport: { width: 1920, height: 1080 },
    screenshot: 'only-on-failure',
    // The trace keeps the action log, screencast and sources of a failed test (no DOM snapshots: they slow every run).
    trace: { mode: 'retain-on-failure', snapshots: false, screenshots: true, sources: true },
  },
  projects: [{ name: 'default', use: { launchOptions: { env: browserLaunchEnv(), args: ARGS } } }],
});
