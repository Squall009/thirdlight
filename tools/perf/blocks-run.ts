/**
 * The blocks measurement (`node tools/perf/run.mjs blocks …`): where block
 * meshing hitches, on the blocks class (blocks.ts), both renderers, the host's
 * GPU, 1920×1080 at DPR 1, uncapped. Each window reports the page's frame
 * intervals (requestAnimationFrame: a long main-thread task shows as a long
 * frame) — worst, p95, mean, and the frames over 33 and 50 ms:
 *
 * - export, load: from the first drawn frame for `--load-ms` (the layer meshed, the kit model arriving);
 * - export, grid writes: a script writing a cell every other step, after the load settled;
 * - Scene view, block type change: the soil's colour changed through a command (the whole layer meshed again);
 * - Scene view, kit model arrival: the kit type switched to a file not loaded yet (meshed without it, then with it);
 * - Scene view, material rules change: the layer's rules set (every chunk painted again as it is meshed).
 *
 *   --renderers webgpu,webgl2    (default both)
 *   --no-export / --no-scene-view
 *   --query 'a=b'                add to the pages' query
 *   --load-ms N --record-ms N    (defaults 12000 / 6000)
 *   --vsync                      draw at the display's rate (a player's browser) instead of uncapped
 *   --shots DIR                  screenshot each export after its load window (pixels before/after a change)
 *   --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/blocks-<time>.json (latest-blocks.json too).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Browser, Page } from '@playwright/test';

import { PERF_ROOT, REPO, startPerfBackend, type PerfBackend } from './backend';
import { buildBlocks, changeBlocksRules, changeBlocksType, setBlocksStream, switchBlocksKit, BLOCKS_VERSION, type BlocksBuild } from './blocks';
import { FRAME_VIEWPORT, launchGpuBrowser, serveStatic, uncappedUrl, type FrameRenderer } from './frame-run';
import { installFrameProbe } from './frame-probe';
import { installPerfInstrumentation } from './instrument';
import { summarize } from './stats';

export interface HitchWindow {
  frames: number;
  worst: number;
  p95: number;
  mean: number;
  over33: number;
  over50: number;
  /** Block chunk meshes (geometries) drawn during the window that were not there at its start: chunks meshed again. */
  newChunkMeshes?: number;
}

export interface BlocksReport {
  reportVersion: 1;
  startedAt: string;
  commit: string;
  version: number;
  query: string;
  export: Partial<Record<FrameRenderer, { load: HitchWindow; gridWrites: HitchWindow }>>;
  sceneView: Partial<Record<FrameRenderer, { typeChange: HitchWindow; kitArrival: HitchWindow; rulesChange: HitchWindow }>>;
  errors: string[];
}

/** Records every animation frame's time from the page's start. */
function installFrameClock(): void {
  const w = window as unknown as { __tlRaf: number[] };
  w.__tlRaf = [];
  const loop = (t: number): void => {
    w.__tlRaf.push(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

const rafTimes = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as { __tlRaf: number[] }).__tlRaf.slice());
const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.now());

/** The frame intervals that end inside [from, to] (page time, ms). */
function hitches(times: readonly number[], from: number, to: number): HitchWindow {
  const iv: number[] = [];
  for (let i = 1; i < times.length; i++) if (times[i]! > from && times[i]! <= to) iv.push(times[i]! - times[i - 1]!);
  const s = summarize(iv);
  return { frames: s.n, worst: s.max, p95: s.p95, mean: s.mean, over33: iv.filter((v) => v > 33.3).length, over50: iv.filter((v) => v > 50).length };
}

const line = (what: string, h: HitchWindow): string => `${what}: worst ${h.worst} ms, p95 ${h.p95} ms, mean ${h.mean} ms, ${h.over33} frames > 33 ms, ${h.over50} > 50 ms (${h.frames} frames)${h.newChunkMeshes !== undefined ? `, ${h.newChunkMeshes} chunk meshes made` : ''}`;

/** The geometry ids of the block chunk meshes drawn last frame (the frame probe's scenes). */
const chunkGeometries = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const P = (window as unknown as { __tlProbe?: { lastScenes: Map<unknown, unknown> } }).__tlProbe;
    const out: string[] = [];
    type O = { name?: string; isMesh?: boolean; geometry?: { uuid: string }; children: O[] };
    const walk = (o: O): void => {
      if (o.isMesh === true && typeof o.name === 'string' && o.name.startsWith('block:') && o.geometry !== undefined) out.push(o.geometry.uuid);
      for (const c of o.children) walk(c);
    };
    for (const sc of P?.lastScenes.keys() ?? []) walk(sc as O);
    return out;
  });

/** Sample the chunk meshes over `ms`: how many appeared that were not drawn before. */
async function sampleRebuilds(page: Page, ms: number): Promise<number> {
  const seen = new Set(await chunkGeometries(page));
  let fresh = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    for (const g of await chunkGeometries(page)) {
      if (seen.has(g)) continue;
      seen.add(g);
      fresh += 1;
    }
  }
  return fresh;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function exportWindows(browser: Browser, url: string, loadMs: number, recordMs: number, stream: boolean, errors: string[], shot?: string): Promise<HitchWindow> {
  const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
  await context.addInitScript(installPerfInstrumentation);
  await context.addInitScript(installFrameClock);
  await context.addInitScript(installFrameProbe, { timestamps: false });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`console ${m.type()}: ${m.text()}`.slice(0, 300));
  });
  try {
    await page.goto(uncappedUrl(url));
    const first = await page.waitForFunction(() => (window as unknown as { __tlPerf?: { firstDrawAt: number | null } }).__tlPerf?.firstDrawAt ?? null, null, { timeout: 180_000 }).then((h) => h.jsonValue() as Promise<number>);
    if (!stream) {
      const end = first + loadMs;
      while ((await pageNow(page)) < end) await sleep(250);
      const h = hitches(await rafTimes(page), first, end);
      if (shot !== undefined) await page.screenshot({ path: shot });
      return h;
    }
    // The stream writes from the start: measured once the load has settled.
    await sleep(loadMs);
    const from = await pageNow(page);
    const fresh = await sampleRebuilds(page, recordMs);
    return { ...hitches(await rafTimes(page), from, from + recordMs), newChunkMeshes: fresh };
  } finally {
    await context.close();
  }
}

async function sceneViewWindows(browser: Browser, be: PerfBackend, b: BlocksBuild, renderer: FrameRenderer, query: string, recordMs: number, errors: string[]): Promise<{ typeChange: HitchWindow; kitArrival: HitchWindow; rulesChange: HitchWindow }> {
  const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
  await context.addInitScript(installFrameClock);
  await context.addInitScript(installFrameProbe, { timestamps: false });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
  const settled = async (): Promise<void> => {
    const t0 = Date.now();
    let last = '';
    let same = 0;
    while (Date.now() - t0 < 120_000 && same < 3) {
      const now = await page.evaluate(() => document.querySelector('canvas.tl-viewport')?.getAttribute('data-frames') ?? '');
      same = now === last && now !== '' ? same + 1 : 0;
      last = now;
      await sleep(1000);
    }
  };
  try {
    await page.goto(uncappedUrl(`${be.origin}/?project=${b.projectId}&renderer=${renderer}${query}#token=${be.token}`));
    await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 180_000 });
    await settled();
    const windowAround = async (act: () => Promise<void>): Promise<HitchWindow> => {
      const from = await pageNow(page);
      const [, fresh] = await Promise.all([act(), sampleRebuilds(page, recordMs)]);
      const to = await pageNow(page);
      return { ...hitches(await rafTimes(page), from, to), newChunkMeshes: fresh };
    };
    const typeChange = await windowAround(() => changeBlocksType(be, b, Date.now() % 97));
    await settled();
    const kitArrival = await windowAround(() => switchBlocksKit(be, b, true));
    await settled();
    // Back to the first kit for the next renderer (loaded: no arrival then).
    await switchBlocksKit(be, b, false);
    await settled();
    const rulesChange = await windowAround(() => changeBlocksRules(be, b, renderer === 'webgpu' ? 1 : 2));
    await settled();
    return { typeChange, kitArrival, rulesChange };
  } finally {
    await context.close();
  }
}

export async function runBlocksCli(argv: readonly string[]): Promise<void> {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const log = (s: string): void => console.log(s);
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  const query = get('query') !== undefined ? `&${get('query')}` : '';
  const loadMs = Number(get('load-ms') ?? 12000);
  const recordMs = Number(get('record-ms') ?? 6000);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `blocks-${stamp}`);
  const reportsDir = join(PERF_ROOT, 'reports');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const report: BlocksReport = { reportVersion: 1, startedAt, commit, version: BLOCKS_VERSION, query, export: {}, sceneView: {}, errors: [] };

  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  const exportDirs: { load: string | null; stream: string | null } = { load: null, stream: null };
  try {
    const b = await buildBlocks(be, 'blocks', log);
    log(`blocks: built in ${b.ms} ms`);
    if (!has('no-scene-view')) {
      const browser = await launchGpuBrowser({ vsync: has('vsync') });
      try {
        for (const r of renderers) {
          const res = await sceneViewWindows(browser, be, b, r, query, recordMs, report.errors);
          report.sceneView[r] = res;
          log(line(`scene view ${r}, block type change`, res.typeChange));
          log(line(`scene view ${r}, kit model arrival`, res.kitArrival));
          log(line(`scene view ${r}, material rules change`, res.rulesChange));
        }
      } finally {
        await browser.close();
      }
    }
    if (!has('no-export')) {
      const exportOnce = async (): Promise<string> => {
        const res = await be.post(`/api/v1/admin/projects/${b.projectId}/export`, {});
        if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
        return join(be.exportRoot, String(res.json['outputDir']));
      };
      exportDirs.load = await exportOnce();
      await setBlocksStream(be, b, true);
      exportDirs.stream = await exportOnce();
    }
  } finally {
    await be.stop();
  }

  if (exportDirs.load !== null && exportDirs.stream !== null) {
    const browser = await launchGpuBrowser({ vsync: has('vsync') });
    try {
      const load = await serveStatic(exportDirs.load);
      const stream = await serveStatic(exportDirs.stream);
      try {
        for (const r of renderers) {
          const shots = get('shots');
          if (shots !== undefined) mkdirSync(shots, { recursive: true });
          const l = await exportWindows(browser, `${load.url}?renderer=${r}${query}`, loadMs, recordMs, false, report.errors, shots === undefined ? undefined : join(shots, `export-${r}.png`));
          const g = await exportWindows(browser, `${stream.url}?renderer=${r}${query}`, loadMs, recordMs, true, report.errors);
          report.export[r] = { load: l, gridWrites: g };
          log(line(`export ${r}, load`, l));
          log(line(`export ${r}, grid writes`, g));
        }
      } finally {
        await load.close();
        await stream.close();
      }
    } finally {
      await browser.close();
    }
  }

  const out = get('out') ?? join(reportsDir, `blocks-${stamp}.json`);
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  copyFileSync(out, join(reportsDir, 'latest-blocks.json'));
  log(`blocks: report ${out}${has('keep') ? `, run folder ${runDir}` : ''}`);
  if (!has('keep')) rmSync(runDir, { recursive: true, force: true });
  for (const e of report.errors.slice(0, 5)) log(`blocks: error: ${e}`);
}
