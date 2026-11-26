/**
 * Browser end-to-end tests: the real backend bundle (dist/) + the real editor
 * in Chromium. Run `npm run build` first, then `npm run test:e2e`.
 *
 * Chromium: Playwright's own download (`npx playwright install chromium`).
 * On hosts without the system libraries Chromium needs, point
 * TL_BROWSER_LIBS at an extracted library tree (see tests/e2e/browser-env.mjs).
 *
 * GPU: where the render node is usable (see `gpuAvailable` in
 * tests/e2e/browser-env.mjs) the browser runs on the host's GPU and every
 * spec runs once, in `default`, on the product's own renderer (`auto` →
 * WebGPU). WebGL 2 is not checked: no spec is written for it.
 *
 * Without a GPU (or with TL_E2E_SOFTWARE=1) everything falls back to
 * SwiftShader: `default` has no WebGPU adapter (`auto` takes WebGL 2), and
 * the `webgpu` project runs the renderer-sensitive specs (WEBGPU_SPECS) again
 * on headless WebGPU (Dawn's SwiftShader adapter), as its own step:
 * `npx playwright test --project=webgpu`.
 */
import { defineConfig } from '@playwright/test';

import { browserLaunchEnv, GPU_ARGS, gpuAvailable, SOFTWARE_GL_ARGS, SOFTWARE_WEBGPU_ARGS } from './tests/e2e/browser-env.mjs';

const GPU = gpuAvailable();
/** The default project's flags: the GPU when usable, else WebGL 2 on SwiftShader. */
const GL_ARGS = GPU ? GPU_ARGS : SOFTWARE_GL_ARGS;
/** The webgpu project's extra flags (it exists only without a GPU). */
const WEBGPU_ARGS = SOFTWARE_WEBGPU_ARGS;

/** The renderer-sensitive specs the `webgpu` project runs again on a host without a GPU. */
const WEBGPU_SPECS = [
  '**/renderer.e2e.ts',
  '**/textures.e2e.ts',
  '**/shadows.e2e.ts',
  // Standard materials share one texture object across model files on WebGPU too.
  '**/shared-textures.e2e.ts',
  // The editor window's one preview pane: on its own canvas and on the lent Scene view, on WebGPU.
  '**/preview-pane.e2e.ts',
  // Phase 21.3: instancing, render on demand and MSAA by quality on WebGPU.
  '**/rendering.e2e.ts',
  // Phase 23.0: a 3D project's Play and export (the 3D physics backend) on WebGPU too.
  '**/physics-3d.e2e.ts',
  // Each scene's look in the Scene view, and the active scene's blend in Play and the export, on WebGPU.
  '**/scene-environment.e2e.ts',
  // Phase 25.2: Play screenshots read back from WebGPU, image textures included.
  '**/screenshot.e2e.ts',
  // Phase 25.8: scene lights on load and unload, 12 point lights, spot cookies on WebGPU.
  '**/scene-lights.e2e.ts',
  // Mip streaming of large KTX2 textures under the texture budget (Play, the export's files) on WebGPU.
  '**/texture-streaming.e2e.ts',
];
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  // TL_E2E_WORKERS (default 1): tests run in parallel files when > 1 — each test starts its own
  // backend and data root; on SwiftShader (no GPU) rendering is CPU-bound, so more workers than
  // ~cores/3 slows every test.
  workers: Number(process.env['TL_E2E_WORKERS'] ?? 1),
  timeout: 60_000,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    viewport: { width: 1920, height: 1080 },
    screenshot: 'only-on-failure',
    // The trace keeps the action log, screencast and sources of a failed test; DOM snapshots
    // at every action and poll made each passing run ~20% slower, so they are off here. The
    // gate's rerun of failed tests turns them on (`--trace=retain-on-failure`).
    trace: { mode: 'retain-on-failure', snapshots: false, screenshots: true, sources: true },
  },
  projects: [
    {
      name: 'default',
      use: { launchOptions: { env: browserLaunchEnv(), args: GL_ARGS } },
    },
    // On a GPU `default` already draws with WebGPU: the project would only repeat it.
    ...(GPU ? [] : [{
      name: 'webgpu',
      testMatch: WEBGPU_SPECS,
      use: { launchOptions: { env: browserLaunchEnv(), args: [...GL_ARGS, ...WEBGPU_ARGS] } },
    }]),
  ],
});
