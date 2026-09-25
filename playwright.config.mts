/**
 * Browser end-to-end tests: the real backend bundle (dist/) + the real editor
 * in Chromium. Run `npm run build` first, then `npm run test:e2e`.
 *
 * Chromium: Playwright's own download (`npx playwright install chromium`).
 * On hosts without the system libraries Chromium needs, point
 * TL_BROWSER_LIBS at an extracted library tree (see tests/e2e/browser-env.mjs).
 *
 * Projects (phase 17.1, docs/plan-phase-17.md §6):
 *  - `default` — every spec, WebGL 2 on SwiftShader (no WebGPU adapter:
 *    `auto`, the default since phase 17.4, takes the WebGL 2 backend here, so
 *    the whole suite covers the fallback).
 *  - `webgpu` — the renderer-sensitive specs again with headless WebGPU
 *    (Dawn's SwiftShader adapter through Vulkan): renderer, shader parity
 *    (17.2), environment parity (17.3) and the materials/textures/lightmaps
 *    and environment/lights/sky-texture/level-look and (17.4) shadows specs, which force the
 *    WebGPU backend there (`?renderer=webgpu`). Slower; run it as its own
 *    step: `npx playwright test --project=webgpu`.
 */
import { defineConfig } from '@playwright/test';

import { browserLaunchEnv } from './tests/e2e/browser-env.mjs';

/** WebGL 2 through ANGLE on SwiftShader (this server has no GPU). */
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
/** Headless WebGPU (17.0 spike): without the Vulkan pair the device dies at first use. */
const WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader'];

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  workers: 1,
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
      ],
      use: { launchOptions: { env: browserLaunchEnv(), args: [...GL_ARGS, ...WEBGPU_ARGS] } },
    },
  ],
});
