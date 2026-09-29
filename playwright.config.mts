/**
 * Browser end-to-end tests: the real backend bundle (dist/) + the real editor
 * in Chromium. Run `npm run build` first, then `npm run test:e2e`.
 *
 * Chromium: Playwright's own download (`npx playwright install chromium`).
 * On hosts without the system libraries Chromium needs, point
 * TL_BROWSER_LIBS at an extracted library tree (see tests/e2e/browser-env.mjs).
 *
 * GPU (2026-09-27): where the render node is usable (see `gpuAvailable` in
 * tests/e2e/browser-env.mjs) every project runs on the host's GPU — WebGL 2
 * through ANGLE on Vulkan and a real WebGPU adapter — so `default` runs the
 * product's own default renderer (`auto` → WebGPU). Without a GPU (or with
 * TL_E2E_SOFTWARE=1) everything falls back to SwiftShader as before.
 *
 * Projects (phase 17.1, docs/plan-phase-17.md §6):
 *  - `default` — every spec. On a GPU: `auto` takes WebGPU; the forced
 *    `webgl2` variants run only with TL_E2E_ALL_VARIANTS=1 (the gate's
 *    `--both-renderers`). On SwiftShader (no WebGPU adapter): `auto` takes
 *    the WebGL 2 backend, so the whole suite covers the fallback.
 *  - `webgpu` — the renderer-sensitive specs again with headless WebGPU
 *    (Dawn's SwiftShader adapter through Vulkan): renderer, shader parity
 *    (17.2), environment parity (17.3) and the materials/textures/lightmaps
 *    and environment/lights/sky-texture/level-look and (17.4) shadows specs, which force the
 *    WebGPU backend there (`?renderer=webgpu`). Slower; run it as its own
 *    step: `npx playwright test --project=webgpu`.
 */
import { defineConfig } from '@playwright/test';

import { browserLaunchEnv, GPU_ARGS, gpuAvailable, SOFTWARE_GL_ARGS, SOFTWARE_WEBGPU_ARGS } from './tests/e2e/browser-env.mjs';

const GPU = gpuAvailable();
/** The default project's flags: the GPU when usable, else WebGL 2 on SwiftShader. */
const GL_ARGS = GPU ? GPU_ARGS : SOFTWARE_GL_ARGS;
/** The webgpu project's extra flags (none on a GPU: GPU_ARGS already give WebGPU). */
const WEBGPU_ARGS = GPU ? [] : SOFTWARE_WEBGPU_ARGS;

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
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'default',
      use: { launchOptions: { env: browserLaunchEnv(), args: GL_ARGS } },
    },
    {
      name: 'webgpu',
      testMatch: [
        '**/renderer.e2e.ts',
        // Phase 23.4: a virtual camera's far plane and the depth precision setting on WebGPU.
        '**/camera-depth.e2e.ts',
        '**/shader-parity.e2e.ts',
        '**/env-parity.e2e.ts',
        '**/materials.e2e.ts',
        '**/textures.e2e.ts',
        '**/lightmaps.e2e.ts',
        '**/environment.e2e.ts',
        '**/lights.e2e.ts',
        '**/sky-texture.e2e.ts',
        '**/level-look.e2e.ts',
        '**/shadows.e2e.ts',
        // Phase 18.3: material graphs on WebGPU.
        '**/material-graph-render.e2e.ts',
        '**/material-graph-play.e2e.ts',
        '**/material-preview.e2e.ts',
        // Phase 20.2: effects on the WebGPU compute executor.
        '**/effects-gpu.e2e.ts',
        '**/effects-runtime.e2e.ts',
        // Phase 20.3: the Effect tab's preview on the WebGPU compute executor.
        '**/effect-editor.e2e.ts',
        // Phase 22.1: thumbnails from a WebGPU canvas snapshot (the other editor-worker tests skip here).
        '**/editor-workers.e2e.ts',
        // Phase 21.3: instancing, render on demand and MSAA by quality on WebGPU.
        '**/rendering.e2e.ts',
        // Phase 21.5: leak tests of the renderer-specific paths (previews, backend swap, Play) on WebGPU.
        '**/memory.e2e.ts',
        // Phase 23.0: a 3D project's Play and export (the 3D physics backend) on WebGPU too.
        '**/physics-3d.e2e.ts',
        // Phase 23.15: Custom-lit graph materials (preview, Scene view, Play, export) on WebGPU.
        '**/material-custom-lit.e2e.ts',
        // Phase 23.12: material parameters set per object by scripts (the per-object data texture) on WebGPU.
        '**/material-runtime.e2e.ts',
        // Phase 23.18: environment preset blends (sky, fog, lights in place) on WebGPU.
        '**/environment-presets.e2e.ts',
        // Phase 25.3: a new blend t every step drops no steps; re-bakes only when the sky changes, on WebGPU.
        '**/environment-blend-cost.e2e.ts',
        // Phase 24.4h: per-object look overrides (emissive, tint) on WebGPU.
        '**/look-override.e2e.ts',
        // Phase 25.2: Play screenshots read back from WebGPU, image textures included.
        '**/screenshot.e2e.ts',
        // Phase 25.8: scene lights on load and unload, 12 point lights, spot cookies on WebGPU.
        '**/scene-lights.e2e.ts',
        // Phase 25.10: a light and an object's active written by a script in Play, on WebGPU.
        '**/entity-access.e2e.ts',
      ],
      use: { launchOptions: { env: browserLaunchEnv(), args: [...GL_ARGS, ...WEBGPU_ARGS] } },
    },
  ],
});
