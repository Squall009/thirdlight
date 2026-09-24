/**
 * SPIKE 17.0 (throwaway): Playwright config for the WebGPURenderer spike.
 * Not part of the e2e suite (its testDir is tests/e2e). Run after `npm run build`:
 *   npx playwright test -c archive/spike-17/spike.config.mts
 * Extra flags over the e2e launch: `--enable-unsafe-webgpu` (navigator.gpu
 * returns Dawn's SwiftShader adapter) and `--enable-features=Vulkan
 * --use-vulkan=swiftshader` (without them the adapter exists but the device
 * dies at first use: "Instance dropped in popErrorScope").
 */
import { defineConfig } from '@playwright/test';

import { browserLaunchEnv } from '../../tests/e2e/browser-env.mjs';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spike.ts',
  workers: 1,
  timeout: 1_800_000,
  reporter: [['list']],
  outputDir: `${process.env['HOME']}/.cache/thirdlight-spike17/test-results`,
  use: {
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      env: browserLaunchEnv(),
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader'],
    },
  },
});
