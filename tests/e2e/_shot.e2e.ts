import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
import { test } from '@playwright/test';
import { startBackend } from './backend';
test('screenshot play', async ({ page }) => {
  const be = await startBackend();
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(be.editorUrl);
  await page.waitForTimeout(1500);
  await page.getByText('+ box').click();
  await page.waitForTimeout(800);
  await page.getByTitle('Start an isolated play preview').click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: '/tmp/tl-shots/play.png' });
  for (const f of page.frames()) {
    logs.push('frame ' + f.url());
    try { logs.push((await f.evaluate(() => document.documentElement.outerHTML)).slice(0, 3000)); } catch (e) { logs.push('eval failed ' + e); }
  }
  require('node:fs').writeFileSync('/tmp/tl-shots/play.log', logs.join('\n'));
  await be.stop();
});
