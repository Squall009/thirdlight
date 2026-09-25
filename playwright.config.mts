/**
 * Browser end-to-end tests: the real backend bundle (dist/) + the real editor
 * in Chromium. Run `npm run build` first, then `npm run test:e2e`.
 *
 * Chromium: Playwright's own download (`npx playwright install chromium`).
 * On hosts without the system libraries Chromium needs, point
 * TL_BROWSER_LIBS at an extracted library tree (see tests/e2e/browser-env.mjs).
 *
 * Projects (phase 17.1, docs/plan-phase-17.md §6):
 *  - `default` — every spec, WebGL 2 on SwiftShader (no WebGPU: `auto` takes
 *    the WebGL 2 backend here, so the suite covers the fallback).
 *  - `webgpu` — the renderer spec again with headless WebGPU (Dawn's
 *    SwiftShader adapter through Vulkan). Slower; run it as its own step:
 *    `npx playwright test --project=webgpu`.
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
      testMatch: '**/renderer.e2e.ts',
      use: { launchOptions: { env: browserLaunchEnv(), args: [...GL_ARGS, ...WEBGPU_ARGS] } },
    },
  ],
});
