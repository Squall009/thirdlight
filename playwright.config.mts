/**
 * Browser end-to-end tests: the real backend bundle (dist/) + the real editor
 * in Chromium. Run `npm run build` first, then `npm run test:e2e`.
 *
 * Chromium: Playwright's own download (`npx playwright install chromium`).
 * On hosts without the system libraries Chromium needs, point
 * TL_BROWSER_LIBS at an extracted library tree (see tests/e2e/browser-env.mjs).
 */
import { defineConfig } from '@playwright/test';

import { browserLaunchEnv } from './tests/e2e/browser-env.mjs';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    viewport: { width: 1920, height: 1080 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      env: browserLaunchEnv(),
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
});
