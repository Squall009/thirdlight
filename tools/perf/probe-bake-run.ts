/**
 * The probe bake measured (`node tools/perf/run.mjs probe-bake …`): a class
 * built through a private backend, opened in the editor on the host's GPU
 * (WebGPU, 1920×1080), its probes baked with the Lighting window's "Bake
 * probes" button. Reports the bake's time (the editor's own count and the
 * click to the record), the probes, tiles, moved and filled probes, the GPU
 * bytes of the tiles and the bytes of their files, and the page's JS heap
 * before and after.
 *
 *   --class village|blocks       (default village; blocks bakes its block-layer ground, marked static here)
 *   --spacing M --bounces N      the bake's settings (default: the editor's, 2 m and 2)
 *   --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/probe-bake-<class>-<time>.json.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERF_ROOT, startPerfBackend } from './backend';
import { buildBlocks } from './blocks';
import { FRAME_VIEWPORT, launchGpuBrowser } from './frame-run';
import { buildVillage } from './village';

export async function runProbeBakeCli(argv: readonly string[]): Promise<void> {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cls = get('class') ?? 'village';
  if (cls !== 'village' && cls !== 'blocks') throw new Error(`probe-bake: unknown class ${cls}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `probe-bake-${cls}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const log = (s: string): void => console.log(`probe-bake: ${s}`);
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  const report: Record<string, unknown> = { class: cls, startedAt: new Date().toISOString() };
  try {
    const projectId = cls;
    if (cls === 'village') await buildVillage(be, projectId, undefined, log);
    else {
      const b = await buildBlocks(be, projectId, log);
      await be.project(projectId).command('updateEntity', { entityId: b.layerId, static: true });
    }
    const browser = await launchGpuBrowser();
    try {
      const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on('pageerror', (e) => log(`pageerror: ${e.message.slice(0, 300)}`));
      await page.goto(`${be.origin}/?project=${projectId}&renderer=webgpu#token=${be.token}`);
      await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 180_000 });
      // Settled: the view stopped drawing for a few seconds (models, textures and the environment in).
      let last = '';
      let same = 0;
      for (let t = 0; t < 120 && same < 3; t++) {
        const now = await page.evaluate(() => document.querySelector('canvas.tl-viewport')?.getAttribute('data-frames') ?? '');
        same = now === last && now !== '' ? same + 1 : 0;
        last = now;
        await new Promise((r) => setTimeout(r, 1000));
      }
      await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'Lighting', exact: true }).click();
      const heap = (): Promise<number> => page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
      const spacing = get('spacing');
      const bounces = get('bounces');
      if (spacing !== undefined || bounces !== undefined) {
        await page.getByRole('button', { name: /settings/ }).click();
        if (spacing !== undefined) await page.getByRole('spinbutton', { name: 'probe spacing' }).fill(spacing);
        if (bounces !== undefined) await page.getByRole('spinbutton', { name: 'probe bounces' }).fill(bounces);
      }
      const heapBefore = await heap();
      const t0 = Date.now();
      await page.getByRole('button', { name: 'Bake probes' }).click();
      const status = page.getByRole('status');
      await status.filter({ hasText: /Baked|failed/ }).waitFor({ timeout: 3_600_000 });
      const clickToRecordMs = Date.now() - t0;
      const message = (await status.textContent()) ?? '';
      const heapAfter = await heap();
      const config = await be.project(projectId).query('queryGameConfig');
      const bake = Object.values((config['lighting'] ?? {}) as Record<string, { probes?: Record<string, unknown> }>)[0];
      const probes = bake?.probes;
      Object.assign(report, { message, clickToRecordMs, heapBefore, heapAfter, probes: probes === undefined ? null : { ...probes, grids: (probes['grids'] as unknown[]).length } });
      log(message);
      log(`click to record ${(clickToRecordMs / 1000).toFixed(1)} s; JS heap ${(heapBefore / 1048576).toFixed(0)} → ${(heapAfter / 1048576).toFixed(0)} MB`);
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await be.stop();
    if (!argv.includes('--keep')) rmSync(runDir, { recursive: true, force: true });
  }
  const out = get('out') ?? join(PERF_ROOT, 'reports', `probe-bake-${cls}-${stamp}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  log(`report ${out}`);
}
