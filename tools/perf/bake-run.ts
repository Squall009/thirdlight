/**
 * "Bake lighting" measured (`node tools/perf/run.mjs bake …`): a class built
 * through a private backend, opened in the editor on the host's GPU (WebGPU,
 * 1920×1080), its lighting baked with the Lighting window's "Bake lighting"
 * button. Reports the bake's time (the editor's own count of the run to
 * settled, and the click to the record), the saved tiles, pages, probes and
 * files' bytes, and the page's JS heap before and after. The look scenes
 * (look-run.ts) bake the same way.
 *
 *   --class village|blocks       (default village; blocks bakes its block-layer ground, marked static here)
 *   --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/bake-<class>-<time>.json.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERF_ROOT, startPerfBackend } from './backend';
import { buildBlocks } from './blocks';
import { FRAME_VIEWPORT, launchGpuBrowser } from './frame-run';
import { buildVillage } from './village';

/**
 * Bake a built project's lighting in the editor on the host's GPU (WebGPU,
 * 1920×1080) with the Lighting window's "Bake lighting" button; the village
 * measurement's `--bake` uses it too.
 */
export async function bakeLightingInEditor(be: Awaited<ReturnType<typeof startPerfBackend>>, projectId: string, log: (s: string) => void): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
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
    const status = page.getByRole('status');
    const heapBefore = await heap();
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Bake lighting' }).click();
    await status.filter({ hasText: /Baked lighting|failed/ }).waitFor({ timeout: 3_600_000 });
    const clickToRecordMs = Date.now() - t0;
    const message = (await status.textContent()) ?? '';
    const heapAfter = await heap();
    const config = await be.project(projectId).query('queryGameConfig');
    const bake = Object.values((config['lighting'] ?? {}) as Record<string, { surface?: Record<string, unknown> }>)[0];
    Object.assign(report, { message, clickToRecordMs, heapBefore, heapAfter, surface: bake?.surface ?? null });
    log(message);
    log(`click to record ${(clickToRecordMs / 1000).toFixed(1)} s; JS heap ${(heapBefore / 1048576).toFixed(0)} → ${(heapAfter / 1048576).toFixed(0)} MB`);
    await context.close();
  } finally {
    await browser.close();
  }
  return report;
}

export async function runBakeCli(argv: readonly string[]): Promise<void> {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cls = get('class') ?? 'village';
  if (cls !== 'village' && cls !== 'blocks') throw new Error(`bake: unknown class ${cls}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `bake-${cls}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const log = (s: string): void => console.log(`bake: ${s}`);
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  const report: Record<string, unknown> = { class: cls, startedAt: new Date().toISOString() };
  try {
    const projectId = cls;
    if (cls === 'village') await buildVillage(be, projectId, undefined, log);
    else {
      const b = await buildBlocks(be, projectId, log);
      await be.project(projectId).command('updateEntity', { entityId: b.layerId, static: true });
    }
    Object.assign(report, await bakeLightingInEditor(be, projectId, log));
  } finally {
    await be.stop();
    if (!argv.includes('--keep')) rmSync(runDir, { recursive: true, force: true });
  }
  const out = get('out') ?? join(PERF_ROOT, 'reports', `bake-${cls}-${stamp}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  log(`report ${out}`);
}
