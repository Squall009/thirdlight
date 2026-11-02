/**
 * The thin slice on a running backend (`node tools/voxel-bench/run.mjs
 * slice …`): the voxel world page in headless Chrome on the host's GPU at
 * the display's 60 Hz cap, on WebGPU and on WebGL 2, against the backend's
 * range route and voxel commands (staging: `tools/staging.sh start`).
 *
 * `--phase measure` (per renderer): the cold fill, a screenshot, frames at
 * the cap while the camera orbits the scene, brush dabs sent as commands
 * (each timed from the command sent to its meshes swapped and drawn), an
 * undo, a screenshot after; then the voxels under every dab and the derived
 * hashes around the scene are written down.
 * `--phase reload` (after restarting the backend): a fresh page per
 * renderer reads the world again, a screenshot, and every probe from the
 * measure phase is compared with what the region files now give.
 *
 *   --origin URL        the backend (default http://127.0.0.1:4180, staging)
 *   --token-file FILE   its owner token (default ~/thirdlight-staging-p45/owner-token)
 *   --project ID        (default voxel-slice)   --world NAME (default slice)
 *   --at X,Y,Z          the scene's origin cell (the slice-world tool prints it)
 *   --phase measure|reload   --seconds S (frames, default 30)   --renderers webgpu,webgl2
 *   --viewport WxH      (default 1280x720)   --out DIR (default ~/.cache/thirdlight-phase45/acceptance/45.7a)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { launchGpuBrowser, parseViewport } from '../perf/frame-run';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const ORIGIN = arg('origin', 'http://127.0.0.1:4180');
const TOKEN = readFileSync(arg('token-file', join(homedir(), 'thirdlight-staging-p45', 'owner-token')), 'utf8').trim();
const PROJECT = arg('project', 'voxel-slice');
const WORLD = arg('world', 'slice');
const AT = arg('at', '0,64,0').split(',').map(Number) as [number, number, number];
const PHASE = arg('phase', 'measure');
const SECONDS = Number(arg('seconds', '30'));
const RENDERERS = arg('renderers', 'webgpu,webgl2').split(',') as Array<'webgpu' | 'webgl2'>;
const VIEWPORT = parseViewport(arg('viewport', '1280x720'));
const OUT = arg('out', join(homedir(), '.cache', 'thirdlight-phase45', 'acceptance', '45.7a'));
const MISSED_MS = 25;

type Cell = [number, number, number];
interface Hook {
  ready?: boolean;
  failed?: string;
}

const q = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(2));
};

/** The dabs a renderer's run sends: into the wall across the chunk corner, and ground dug or built up beside the scene. */
function dabsFor(renderer: 'webgpu' | 'webgl2'): Array<{ cell: Cell; mode: 'dig' | 'add' }> {
  const [x, y, z] = AT;
  const row = renderer === 'webgpu' ? 5 : 2;
  const side = renderer === 'webgpu' ? 1 : -1;
  return [
    ...[-4, -1, 2].map((dx) => ({ cell: [x + dx, y + row, z] as Cell, mode: 'dig' as const })),
    ...[0, 4, 8].map((dz) => ({ cell: [x + side * 9, y - 1, z + 2 + dz] as Cell, mode: 'dig' as const })),
    ...[0, 4].map((dz) => ({ cell: [x - side * 9, y + 1, z - 6 + dz] as Cell, mode: 'add' as const })),
  ];
}

async function openPage(renderer: 'webgpu' | 'webgl2'): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const browser = await launchGpuBrowser({ vsync: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.addInitScript((t: string) => localStorage.setItem('thirdlight.token', t), TOKEN);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 300));
  });
  await page.goto(`${ORIGIN}/voxel-world.html?project=${PROJECT}&world=${WORLD}&at=${AT.join(',')}&renderer=${renderer}`);
  await page.waitForFunction(() => {
    const h = (window as unknown as { __tlVoxelWorld?: Hook }).__tlVoxelWorld;
    return h !== undefined && (h.ready === true || h.failed !== undefined);
  }, undefined, { timeout: 180_000 });
  const failed = await page.evaluate(() => (window as unknown as { __tlVoxelWorld: Hook }).__tlVoxelWorld.failed ?? null);
  if (failed !== null) throw new Error(`page: ${failed}`);
  return { page, errors, close: () => browser.close() };
}

const hook = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { __tlVoxelWorld: Record<string, (...x: unknown[]) => unknown> }).__tlVoxelWorld[f as string]!(...(a as unknown[])) as T, [fn, args] as const);

async function shot(page: Page, name: string): Promise<string> {
  // Two frames after the last change, so what is shown is drawn.
  await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
  const file = join(OUT, name);
  await page.screenshot({ path: file });
  return file;
}

/** The camera on the scene: from the front-left, a little above. */
async function lookAtScene(page: Page): Promise<void> {
  await hook(page, 'look', AT[0], AT[1] + 3, AT[2] + 2, -0.75, 0.42, 16);
  await hook(page, 'settle');
}

function sceneChunks(): Cell[] {
  const out: Cell[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) out.push([(AT[0] >> 5) + dx, (AT[1] >> 5) + dy, (AT[2] >> 5) + dz]);
  return out;
}

async function measure(renderer: 'webgpu' | 'webgl2'): Promise<Record<string, unknown>> {
  const { page, errors, close } = await openPage(renderer);
  try {
    const coldMs = await page.evaluate(() => (window as unknown as { __tlVoxelWorld: { coldMs: number } }).__tlVoxelWorld.coldMs);
    await lookAtScene(page);
    const before = await shot(page, `before-${renderer}.png`);
    const fr = await hook<{ intervals: number[]; renderMs: { p50: number; p95: number } }>(page, 'frames', SECONDS, 0.15);
    await lookAtScene(page);
    const edits: Array<Record<string, unknown>> = [];
    for (const d of dabsFor(renderer)) edits.push({ ...d, ...(await hook<Record<string, unknown>>(page, 'dab', d.cell, d.mode)) });
    // One more dab, undone: the undo is timed the same way.
    const extra: Cell = [AT[0] + 3, AT[1] + 1, AT[2] + 7];
    edits.push({ cell: extra, mode: 'dig', ...(await hook<Record<string, unknown>>(page, 'dab', extra, 'dig')) });
    edits.push({ cell: extra, mode: 'undo', ...(await hook<Record<string, unknown>>(page, 'undo')) });
    const after = await shot(page, `after-${renderer}.png`);
    // Frames again with the edits in (and nothing in flight).
    const fr2 = await hook<{ intervals: number[]; renderMs: { p50: number; p95: number } }>(page, 'frames', Math.min(10, SECONDS), 0.15);
    const state = await hook<Record<string, unknown>>(page, 'state');
    return { renderer, coldMs: Math.round(coldMs), frames: summary(fr), framesAfter: summary(fr2), edits, state, screenshots: [before, after], errors };
  } finally {
    await close();
  }
}

function summary(fr: { intervals: number[]; renderMs: { p50: number; p95: number } }): Record<string, unknown> {
  const xs = fr.intervals.slice(1);
  return { n: xs.length, p50: q(xs, 0.5), p95: q(xs, 0.95), max: q(xs, 1), missed: xs.filter((x) => x > MISSED_MS).length, renderMs: fr.renderMs };
}

async function probes(renderer: 'webgpu' | 'webgl2', cells: Cell[]): Promise<{ voxels: unknown[]; derived: Array<number | null>; shot: string; errors: string[] }> {
  const { page, errors, close } = await openPage(renderer);
  try {
    await lookAtScene(page);
    const voxels: unknown[] = [];
    for (const c of cells) voxels.push(await hook(page, 'voxelAt', ...c));
    const derived: Array<number | null> = [];
    for (const c of sceneChunks()) derived.push(await hook<number | null>(page, 'derivedHash', ...c));
    return { voxels, derived, shot: await shot(page, `${PHASE === 'reload' ? 'reload' : 'probe'}-${renderer}.png`), errors };
  } finally {
    await close();
  }
}

mkdirSync(OUT, { recursive: true });
const host = { uptimeH: Number((uptime() / 3600).toFixed(1)), load: loadavg().map((l) => Number(l.toFixed(2))), at: new Date().toISOString() };
const probeCells = (['webgpu', 'webgl2'] as const).flatMap((r) => dabsFor(r).map((d) => d.cell)).concat([[AT[0] + 3, AT[1] + 1, AT[2] + 7]]);
if (PHASE === 'measure') {
  const runs = [];
  for (const r of RENDERERS) {
    const run = await measure(r);
    runs.push(run);
    console.log(JSON.stringify({ renderer: r, coldMs: run['coldMs'], frames: run['frames'], edits: (run['edits'] as Array<Record<string, unknown>>).map((e) => ({ ok: e['ok'], code: e['code'], visibleMs: e['visibleMs'] && Math.round(e['visibleMs'] as number), answerMs: e['answerMs'] && Math.round(e['answerMs'] as number) })) }));
  }
  // What the region files hold now, as a fresh page reads them: the reload phase must find the same.
  const truth = await probes(RENDERERS[0]!, probeCells);
  writeFileSync(join(OUT, 'measure.json'), JSON.stringify({ host, at: AT, runs, truth }, null, 2));
  console.log(`measure: ${join(OUT, 'measure.json')}`);
} else {
  const measured = existsSync(join(OUT, 'measure.json')) ? (JSON.parse(readFileSync(join(OUT, 'measure.json'), 'utf8')) as { truth: { voxels: unknown[]; derived: unknown[] } }) : null;
  const out = [];
  for (const r of RENDERERS) {
    const p = await probes(r, probeCells);
    const same = measured === null ? null : { voxels: JSON.stringify(p.voxels) === JSON.stringify(measured.truth.voxels), derived: JSON.stringify(p.derived) === JSON.stringify(measured.truth.derived) };
    out.push({ renderer: r, same, ...p });
    console.log(JSON.stringify({ renderer: r, same, errors: p.errors.length }));
  }
  writeFileSync(join(OUT, 'reload.json'), JSON.stringify({ host, at: AT, out }, null, 2));
  console.log(`reload: ${join(OUT, 'reload.json')}`);
}
