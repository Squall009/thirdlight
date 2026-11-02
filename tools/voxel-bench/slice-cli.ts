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
 * `--phase assembly` (per renderer): the assembly proof in stages through
 * runtime set/dig commands — the banister grown into a wall, the wall
 * behind the beam cut across a chunk face, both undone, the banister dug
 * and rebuilt cell by cell, a pit dug under a dropped capsule — with a
 * screenshot, the cells' classes and outputs, the chunks derived again,
 * a staleness check against a fresh derive and physics probes per stage.
 * `--phase fly` (per renderer): frames at the cap while the focus travels
 * 160 m and back, with the chunk bodies' add/remove churn it causes.
 * `--phase shader` (per renderer): the surface shader's blend at a chunk
 * corner off the scene — four ground materials painted in quadrants
 * around the corner, a wet band across it, the blend distance short and
 * long — each a screenshot with the meshes built and grids uploaded
 * counted (a material or wetness paint builds none); frames and GPU time
 * (timestamps where the device has them) at the cap with the blend and
 * with one flat colour; then every paint undone.
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
const OUT = arg('out', join(homedir(), '.cache', 'thirdlight-phase45', 'acceptance', PHASE === 'assembly' || PHASE === 'fly' ? '45.7b' : '45.7a'));
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

async function openPage(renderer: 'webgpu' | 'webgl2', extra = ''): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const browser = await launchGpuBrowser({ vsync: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.addInitScript((t: string) => localStorage.setItem('thirdlight.token', t), TOKEN);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 300));
  });
  await page.goto(`${ORIGIN}/voxel-world.html?project=${PROJECT}&world=${WORLD}&at=${AT.join(',')}&renderer=${renderer}${extra}`);
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

/** The assembly proof's stages on one renderer (see the header). */
async function assembly(renderer: 'webgpu' | 'webgl2'): Promise<Record<string, unknown>> {
  const { page, errors, close } = await openPage(renderer);
  const [ox, oy, oz] = AT;
  const centre = AT.map((v) => v >> 5) as Cell;
  const stages: Array<Record<string, unknown>> = [];
  const probeCells: Record<string, Cell> = { rail: [ox - 3, oy + 2, oz + 7], post: [ox - 4, oy + 1, oz + 7], gap: [ox - 3, oy + 1, oz + 7], beam: [ox - 4, oy + 5, oz - 1], beamNext: [ox - 5, oy + 5, oz - 1], wall: [ox - 4, oy + 5, oz] };
  const timber = { material: 11, role: 3, wetness: 0, shape: 15 };
  const stone = { material: 10, role: 3, wetness: 0, shape: 15 };
  const grown: number[] = [];
  const banister: number[] = [];
  for (let x = -4; x < 4; x++) {
    if ((x & 1) !== 0) grown.push(ox + x, oy + 1, oz + 7);
    else banister.push(ox + x, oy + 1, oz + 7);
    grown.push(ox + x, oy + 3, oz + 7);
    banister.push(ox + x, oy + 2, oz + 7);
  }
  const behindBeam = [ox - 4, oy + 5, oz, ox + 3, oy + 5, oz];
  const front = (): Promise<unknown> => hook(page, 'look', ox, oy + 2, oz + 5, 0.55, 0.32, 9);
  const back = (): Promise<unknown> => hook(page, 'look', ox, oy + 5, oz - 1, 2.6, 0.3, 9);
  /** Physics probes of a stage: capsules dropped on the rail, the wall top, the beam and the pad; balls rolled at post height between two posts and at a post. */
  const probes = async (): Promise<Record<string, unknown>> => ({
    dropRail: await hook(page, 'drop', [ox - 2.5, oy + 7, oz + 7.5], 0.1, 0.1),
    dropWallTop: await hook(page, 'drop', [ox - 4.5, oy + 12, oz + 0.5], 0.2, 0.2),
    dropBeam: await hook(page, 'drop', [ox - 4.5, oy + 10, oz - 0.5], 0.1, 0.1),
    dropPad: await hook(page, 'drop', [ox + 9.5, oy + 4, oz + 10.5], 0.15, 0.15),
    sweepGap: await hook(page, 'sweep', [ox - 2.5, oy + 1.5, oz + 12], [0, 0, -1], 0.15, 20),
    sweepPost: await hook(page, 'sweep', [ox - 3.5, oy + 1.5, oz + 12], [0, 0, -1], 0.15, 20),
  });
  const stage = async (name: string, command: unknown, view: () => Promise<unknown>, op: 'edit' | 'dab' | 'undo' = 'edit'): Promise<void> => {
    await hook(page, 'clearMarkers');
    const answer = op === 'undo' ? await hook<Record<string, unknown>>(page, 'undo') : command === null ? null : op === 'edit' ? await hook<Record<string, unknown>>(page, 'edit', command) : await hook<Record<string, unknown>>(page, 'dab', ...(command as [Cell, 'dig']));
    await hook(page, 'settle');
    const cells: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(probeCells)) cells[k] = await hook(page, 'cellAt', ...c);
    const stale = await hook(page, 'staleAgainstFresh', ...centre, 2);
    const hashes = await hook<Record<string, number | null>>(page, 'windowHashes', ...centre, 2);
    const physics = await probes();
    await view();
    await hook(page, 'settle');
    const file = await shot(page, `${String(stages.length).padStart(2, '0')}-${name}-${renderer}.png`);
    stages.push({ name, answer, cells, stale, hashes, physics, shot: file });
    console.log(JSON.stringify({ renderer, stage: name, ok: answer === null ? true : answer['ok'], rederived: (answer?.['rederived'] as unknown[] | undefined)?.length, stale: (stale as { stale: unknown[] }).stale.length }));
  };
  try {
    const files0 = await hook<Record<string, string>>(page, 'files');
    await stage('start', null, front);
    await stage('banister-grown', { v: 2, grid: 0, kind: 'set', cells: grown, voxel: timber }, front);
    await stage('beam-cut', { v: 2, grid: 0, kind: 'dig', cells: behindBeam }, back);
    await stage('beam-restored', { v: 2, grid: 0, kind: 'set', cells: behindBeam, voxel: stone }, back);
    await stage('banister-shrunk', { v: 2, grid: 0, kind: 'dig', cells: grown }, front);
    await stage('banister-dug', { v: 2, grid: 0, kind: 'dig', cells: banister }, front);
    await stage('banister-rebuilt', { v: 2, grid: 0, kind: 'set', cells: banister, voxel: timber }, front);
    const filesRebuilt = await hook<Record<string, string>>(page, 'files');
    await stage('pit', [[ox + 9, oy - 1, oz + 10], 'dig'], () => hook(page, 'look', ox + 9, oy, oz + 10, 0.5, 0.7, 8), 'dab');
    await stage('pit-undone', null, () => hook(page, 'look', ox + 9, oy, oz + 10, 0.5, 0.7, 8), 'undo');
    const h = (i: number): unknown => JSON.stringify(stages[i]!['hashes']);
    const same = { restoredEqualsGrown: h(3) === h(1), shrunkEqualsStart: h(4) === h(0), rebuiltEqualsStart: h(6) === h(0), filesRebuiltEqualsStart: JSON.stringify(filesRebuilt) === JSON.stringify(files0) };
    console.log(JSON.stringify({ renderer, same }));
    const state = await hook<Record<string, unknown>>(page, 'state');
    return { renderer, stages, same, collision: state['collision'], errors };
  } finally {
    await close();
  }
}

/** Frames at the cap while the focus travels 160 m along x and back (12 m/s), and the chunk-body churn of it. */
async function fly(renderer: 'webgpu' | 'webgl2'): Promise<Record<string, unknown>> {
  const { page, errors, close } = await openPage(renderer);
  try {
    await lookAtScene(page);
    const before = await hook<{ collision: { adds: number; removes: number } }>(page, 'state');
    await page.evaluate(() => {
      const w = window as unknown as { __tlVoxelWorld: { frames: (s: number, y: number) => Promise<unknown> }; __fly?: Promise<unknown> };
      w.__fly = w.__tlVoxelWorld.frames(27, 0);
    });
    const t0 = Date.now();
    const total = 320 / 12;
    for (;;) {
      const t = (Date.now() - t0) / 1000;
      if (t > total) break;
      const along = t < total / 2 ? t * 12 : 320 - t * 12;
      await hook(page, 'look', AT[0] + along * 2, AT[1] + 3, AT[2] + 2, -0.75, 0.42, 16);
      await new Promise((ok) => setTimeout(ok, 50));
    }
    const fr = (await page.evaluate(() => (window as unknown as { __fly: Promise<unknown> }).__fly)) as { intervals: number[]; renderMs: { p50: number; p95: number } };
    const state = await hook<{ collision: { adds: number; removes: number } }>(page, 'state');
    return { renderer, frames: summary(fr), collisionBefore: before.collision, collision: state.collision, state, errors };
  } finally {
    await close();
  }
}

interface SurfaceState {
  surface: { meshBuilds: number; shaderSets: number; regions: number; gridGpuBytes: number; gridUploads: number; uploadMs: { p50: number; p95: number; n: number } };
  swaps: number;
}

/** The surface shader at a chunk corner off the scene (see the header). */
async function shader(renderer: 'webgpu' | 'webgl2'): Promise<Record<string, unknown>> {
  const corner: Cell = [AT[0] - 64, 0, AT[2] - 64];
  const out: Record<string, unknown> = { renderer, corner };
  {
    const { page, errors, close } = await openPage(renderer, '&gpuTime=1&hud=0');
    try {
      // The ground's height at the corner: the first solid cell from above.
      let h = AT[1] + 40;
      await hook(page, 'look', corner[0], AT[1], corner[2], 0.6, 1.1, 14);
      await hook(page, 'settle');
      while (h > AT[1] - 60 && (await hook<{ material: number }>(page, 'voxelAt', corner[0], h, corner[2])).material === 0) h--;
      corner[1] = h;
      const view = (): Promise<unknown> => hook(page, 'look', corner[0], h, corner[2], 0.6, 1.1, 12);
      await view();
      await hook(page, 'settle');
      const steps: Array<Record<string, unknown>> = [];
      const step = async (name: string, commands: unknown[]): Promise<void> => {
        const before = await hook<SurfaceState>(page, 'state');
        const answers: Array<Record<string, unknown>> = [];
        for (const c of commands) answers.push(await hook<Record<string, unknown>>(page, 'edit', c));
        await hook(page, 'settle');
        await view();
        const after = await hook<SurfaceState>(page, 'state');
        steps.push({ name, answers: answers.map((a) => ({ ok: a['ok'], code: a['code'], cells: a['cells'], chunks: a['chunks'], visibleMs: a['visibleMs'], rederived: a['rederived'] })), meshBuilds: after.surface.meshBuilds - before.surface.meshBuilds, derivedSwaps: after.swaps - before.swaps, shaderSets: after.surface.shaderSets - before.surface.shaderSets, gridUploads: after.surface.gridUploads - before.surface.gridUploads, shot: await shot(page, `shader-${name}-${renderer}.png`) });
      };
      const paint = (x0: number, z0: number, x1: number, z1: number, material: number, wetness: number): unknown => ({ v: 2, grid: 0, kind: 'fill', min: [x0, h - 8, z0], max: [x1, h + 8, z1], mode: 'paint', voxel: { material, role: 1, wetness } });
      const [x, , z] = corner;
      await step('before', []);
      // Four materials in the quadrants around the chunk corner (x and z faces both), roles kept: a material-only change.
      await step('quadrants', [paint(x - 12, z - 12, x - 1, z - 1, 3, 0), paint(x, z - 12, x + 11, z - 1, 4, 0), paint(x - 12, z, x - 1, z + 11, 10, 0), paint(x, z, x + 11, z + 11, 2, 0)]);
      // A wet band across the corner along x: wetness only.
      await step('wet', [paint(x - 12, z - 3, x + 11, z + 2, 3, 7), paint(x, z - 3, x + 11, z - 1, 4, 7), paint(x - 12, z, x - 1, z + 2, 10, 7), paint(x, z, x + 11, z + 2, 2, 7)]);
      await hook(page, 'setBlend', 0.05);
      await step('blend-0.05m', []);
      await hook(page, 'setBlend', 0.25);
      await step('blend-0.25m', []);
      await hook(page, 'setBlend', 0.5);
      await step('blend-0.5m', []);
      await hook(page, 'setBlend', 0.25);
      out['steps'] = steps;
      // The scene's wall, beam and banister (construction, projected the same way), then frames at the cap
      // orbiting it with the blend, and the GPU time of those frames.
      await lookAtScene(page);
      out['sceneShot'] = await shot(page, `shader-scene-${renderer}.png`);
      await hook(page, 'gpuTime');
      const fr = await hook<{ intervals: number[]; renderMs: { p50: number; p95: number } }>(page, 'frames', SECONDS, 0.15);
      out['blend'] = { frames: summary(fr), gpu: await hook(page, 'gpuTime') };
      out['state'] = await hook(page, 'state');
      for (let k = 0; k < 8; k++) await hook(page, 'undo');
      await hook(page, 'settle');
      out['errors'] = errors;
    } finally {
      await close();
    }
  }
  {
    const { page, errors, close } = await openPage(renderer, '&gpuTime=1&hud=0&shading=flat');
    try {
      await lookAtScene(page);
      await hook(page, 'gpuTime');
      const fr = await hook<{ intervals: number[]; renderMs: { p50: number; p95: number } }>(page, 'frames', SECONDS, 0.15);
      out['flat'] = { frames: summary(fr), gpu: await hook(page, 'gpuTime'), errors };
    } finally {
      await close();
    }
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
const host = { uptimeH: Number((uptime() / 3600).toFixed(1)), load: loadavg().map((l) => Number(l.toFixed(2))), at: new Date().toISOString() };
const probeCells = (['webgpu', 'webgl2'] as const).flatMap((r) => dabsFor(r).map((d) => d.cell)).concat([[AT[0] + 3, AT[1] + 1, AT[2] + 7]]);
if (PHASE === 'assembly' || PHASE === 'fly' || PHASE === 'shader') {
  const runs = [];
  for (const r of RENDERERS) runs.push(PHASE === 'assembly' ? await assembly(r) : PHASE === 'fly' ? await fly(r) : await shader(r));
  writeFileSync(join(OUT, `${PHASE}.json`), JSON.stringify({ host, at: AT, runs }, null, 2));
  console.log(`${PHASE}: ${join(OUT, `${PHASE}.json`)}`);
} else if (PHASE === 'measure') {
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
