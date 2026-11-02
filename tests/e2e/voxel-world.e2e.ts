/**
 * A project's voxel world in the real page against the real backend, on
 * WebGPU and on WebGL 2: the voxel world page streams the world's region
 * files by range, derives and draws them (ground, walls, and the beam,
 * rail and post pieces the assembly rules resolve), sends a brush dab as a
 * command, and shows the change once the backend has written it (pixels
 * read with png.ts); a reload, and a restarted backend, show the same
 * world from the region files.
 *
 * The world is the slice's test world (tools/voxel-bench/slice-world.ts),
 * a small hilly square with the wall-beam-banister scene, written into the
 * project's folder before the page opens it.
 *
 * The assembly proof drives the same page with plain set/dig commands (a
 * game's runtime build, no structure data): the banister grown upward
 * becomes a wall and back, a wall cell taken from behind the beam across a
 * chunk face turns the beam in the next chunk, and every consumer (render,
 * collision, navigation, light) follows; the chunks derived again are
 * exactly those within the rules' reach of the edit, none is stale against
 * a fresh derive, the result survives a reload from the files, and the
 * banister rebuilt cell by cell derives (and saves) as the generator wrote
 * it. Bodies dropped and swept against the page's physics rest on the
 * ground, the wall, the rail, pass between the posts, and fall into a pit.
 */
import { decodePng, changedPixels } from './png';
import { expect, test, type Page } from './pw';
import { startBackend, type E2EBackend } from './backend';
import { consoleErrors } from './console-errors';
import { writeSliceWorld } from '../../tools/voxel-bench/slice-world';
import { MAT } from '../../tools/voxel-bench/world-kit';
import { canonicalEditCommand, chunkGrid, dependentChunks, editBounds, jobRadius, PLACEHOLDER_RULES, VOXEL_CATEGORY } from '@thirdlight/voxel';

type Cell = [number, number, number];
let be: E2EBackend;
let scene: Cell;

test.beforeAll(async () => {
  be = await startBackend('e2e-voxel');
  // 128 m square: enough ground around the scene for the ring, quick to write.
  scene = [...writeSliceWorld(be.projectDir, 'slice', 256).scene] as Cell;
});
test.afterAll(async () => {
  await be?.stop();
});

const hook = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { __tlVoxelWorld: Record<string, (...x: unknown[]) => unknown> }).__tlVoxelWorld[f as string]!(...(a as unknown[])) as T, [fn, args] as const);

async function open(page: Page, renderer: 'webgpu' | 'webgl2'): Promise<void> {
  await page.goto(`${be.origin}/voxel-world.html?project=${be.projectId}&world=slice&at=${scene.join(',')}&renderer=${renderer}&hud=0#token=${be.token}`);
  await page.waitForFunction(() => {
    const h = (window as unknown as { __tlVoxelWorld?: { ready?: boolean; failed?: string } }).__tlVoxelWorld;
    return h !== undefined && (h.ready === true || h.failed !== undefined);
  }, undefined, { timeout: 120_000 });
  expect(await page.evaluate(() => (window as unknown as { __tlVoxelWorld: { failed?: string } }).__tlVoxelWorld.failed ?? null)).toBeNull();
  expect(await page.evaluate(() => (window as unknown as { __tlVoxelWorld: { backend: string } }).__tlVoxelWorld.backend)).toBe(renderer);
  await hook(page, 'look', scene[0], scene[1] + 3, scene[2] + 2, -0.75, 0.42, 16);
  await hook(page, 'settle');
}

interface CellReport {
  voxel: { material: number; category: number };
  resolved: string;
  outputs: { renderSolid: boolean; baseFaces: number; piece: { family: number; section: number } | null; collision: string; navBlocks: boolean; standable: boolean; light: number } | null;
}
interface EditAnswer {
  ok: boolean;
  code?: string;
  rederived: string[];
}
interface Drop {
  feet: Cell;
  grounded: boolean;
}

const grid = chunkGrid(32);
const chunkName = (c: Cell): string => c.map((v) => v >> 5).join(',');

/** The chunks a command can change results in: within the rules' radius + reach of the cells it can change. */
function dependents(command: unknown): string[] {
  return dependentChunks(grid, editBounds(grid, canonicalEditCommand(command)), jobRadius(PLACEHOLDER_RULES))
    .map((c) => `${c.cx},${c.cy},${c.cz}`)
    .sort();
}

const cellAt = (page: Page, c: Cell): Promise<CellReport> => hook<CellReport>(page, 'cellAt', ...c);

async function shot(page: Page): Promise<ReturnType<typeof decodePng>> {
  await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
  return decodePng(await page.screenshot());
}

test('assembly proof: runtime set/dig turn a banister into a wall and a beam into a stub across chunk faces; every consumer, collision included, follows; round trips', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 960, height: 540 });
  const errors = consoleErrors(page);
  await open(page, 'webgpu');
  const [ox, oy, oz] = scene;
  const centre = scene.map((v) => v >> 5) as Cell;
  const hashes = (): Promise<Record<string, number | null>> => hook(page, 'windowHashes', ...centre, 2);
  const noneStale = async (): Promise<void> => {
    const r = await hook<{ checked: number; stale: string[] }>(page, 'staleAgainstFresh', ...centre, 2);
    expect(r.checked).toBeGreaterThan(20);
    expect(r.stale).toEqual([]);
  };
  const send = async (command: unknown): Promise<EditAnswer> => {
    const a = await hook<EditAnswer>(page, 'edit', command);
    expect(a.ok, a.code).toBe(true);
    // Derived again: exactly the chunks within the radius of the cells it can change.
    expect(a.rederived).toEqual(dependents(command));
    await noneStale();
    return a;
  };
  const rail: Cell = [ox - 3, oy + 2, oz + 7];
  const post: Cell = [ox - 4, oy + 1, oz + 7];
  const gap: Cell = [ox - 3, oy + 1, oz + 7];
  const beam: Cell = [ox - 4, oy + 5, oz - 1];
  const behindBeam: Cell[] = [[ox - 4, oy + 5, oz], [ox + 3, oy + 5, oz]];
  const timber = { material: MAT.timber, category: VOXEL_CATEGORY.construction, orientation: 0, shape: 255 };
  const sweepGap = (): Promise<{ centre: Cell } | null> => hook(page, 'sweep', [ox - 2.5, oy + 1.5, oz + 12], [0, 0, -1], 0.15, 20);
  const dropOnRail = (): Promise<Drop> => hook(page, 'drop', [ox - 2.5, oy + 7, oz + 7.5], 0.1, 0.1);

  const h0 = await hashes();
  const files0 = await hook<Record<string, string>>(page, 'files');
  await noneStale();
  expect((await hook<{ collision: { bodies: number } }>(page, 'state')).collision.bodies).toBeGreaterThan(20);

  // As the generator wrote it: an open banister (rail on posts), a beam one out from the wall, the wall.
  expect(await cellAt(page, rail)).toMatchObject({ resolved: 'rail', outputs: { renderSolid: false, baseFaces: 0, collision: 'partial', navBlocks: true, standable: false, light: 51 } });
  expect((await cellAt(page, post)).resolved).toBe('post');
  expect(await cellAt(page, gap)).toMatchObject({ resolved: 'empty', outputs: { collision: 'none', navBlocks: false, light: 0 } });
  expect(await cellAt(page, beam)).toMatchObject({ resolved: 'beam', outputs: { renderSolid: false, collision: 'partial', light: 128 } });
  expect(await cellAt(page, behindBeam[0]!)).toMatchObject({ resolved: 'wall', outputs: { renderSolid: true, collision: 'full', light: 255 } });
  // Physics: a ball rolled at post height passes between two posts and under the rail to the wall; a capsule rests on the rail,
  // another on the ground of the pad.
  expect((await sweepGap())!.centre[2]).toBeCloseTo(oz + 1.3, 1);
  expect(await dropOnRail()).toMatchObject({ grounded: true });
  expect((await dropOnRail()).feet[1]).toBeCloseTo(oy + 3, 1);
  expect((await hook<Drop>(page, 'drop', [ox + 9.5, oy + 4, oz + 10.5], 0.15, 0.15)).feet[1]).toBeCloseTo(oy, 0);

  // Grow the banister upward (the gaps between the posts and a row over the rail; across the x chunk face): a wall.
  const grownCells: number[] = [];
  for (let x = -4; x < 4; x++) {
    if ((x & 1) !== 0) grownCells.push(ox + x, oy + 1, oz + 7);
    grownCells.push(ox + x, oy + 3, oz + 7);
  }
  const grow = { v: 1, grid: 0, kind: 'set', cells: grownCells, voxel: timber };
  await send(grow);
  expect(await cellAt(page, rail)).toMatchObject({ resolved: 'wall', outputs: { renderSolid: true, piece: null, baseFaces: 2, collision: 'full', navBlocks: true, light: 255 } });
  expect((await cellAt(page, gap)).resolved).toBe('wall');
  expect((await cellAt(page, [ox - 3, oy + 4, oz + 7])).outputs?.standable).toBe(true);
  expect((await sweepGap())!.centre[2]).toBeCloseTo(oz + 8.3, 1);
  expect((await dropOnRail()).feet[1]).toBeCloseTo(oy + 4, 1);
  const h1 = await hashes();
  expect(h1).not.toEqual(h0);

  // Stored intent survives the save and the codec: a fresh page from the files derives the same, the cells are construction.
  await page.reload();
  await open(page, 'webgpu');
  expect(await hashes()).toEqual(h1);
  expect((await cellAt(page, gap)).voxel).toMatchObject({ material: MAT.timber, category: VOXEL_CATEGORY.construction });

  // Take the wall cells behind the beam (chunk z of the wall) on both sides of the x chunk face: the beam cells in front
  // (the next chunk in z, where nothing was edited) become wall stubs, their neighbours end the beam's run.
  const cut = { v: 1, grid: 0, kind: 'dig', cells: behindBeam.flat() };
  const cutAnswer = await send(cut);
  expect(cutAnswer.rederived).toContain(chunkName(beam));
  expect(chunkName(beam)).not.toBe(chunkName(behindBeam[0]!));
  expect(await cellAt(page, beam)).toMatchObject({ resolved: 'wall', outputs: { collision: 'full', light: 255, piece: null } });
  expect((await cellAt(page, [ox - 5, oy + 5, oz - 1])).outputs?.piece?.section).not.toBe(2);
  await send({ v: 1, grid: 0, kind: 'set', cells: behindBeam.flat(), voxel: { material: MAT.stone, category: VOXEL_CATEGORY.construction, orientation: 0, shape: 255 } });
  expect((await cellAt(page, beam)).resolved).toBe('beam');
  expect(await hashes()).toEqual(h1);

  // Take the growth away again: the banister is back, every derived result as the generator's voxels gave.
  await send({ v: 1, grid: 0, kind: 'dig', cells: grownCells });
  expect((await cellAt(page, rail)).resolved).toBe('rail');
  expect(await hashes()).toEqual(h0);

  // Runtime input with no structure data: dig the generator's banister, then build it again cell by cell.
  const banister: number[] = [];
  for (let x = -4; x < 4; x++) {
    if ((x & 1) === 0) banister.push(ox + x, oy + 1, oz + 7);
    banister.push(ox + x, oy + 2, oz + 7);
  }
  await send({ v: 1, grid: 0, kind: 'dig', cells: banister });
  expect((await cellAt(page, rail)).resolved).toBe('empty');
  await send({ v: 1, grid: 0, kind: 'set', cells: banister, voxel: timber });
  expect(await hashes()).toEqual(h0);
  // The same voxels give the same region file bytes too (canonical files).
  expect(await hook<Record<string, string>>(page, 'files')).toEqual(files0);

  // Dig a pit after the bodies were built: a capsule dropped there falls into it; undo fills it again.
  const pit: Cell = [ox + 9, oy - 1, oz + 10];
  const before = await hook<Drop>(page, 'drop', [ox + 9.5, oy + 4, oz + 10.5], 0.15, 0.15);
  const pitDig = await hook<EditAnswer>(page, 'dab', pit, 'dig');
  expect(pitDig.ok).toBe(true);
  const pitCommand = { v: 1, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: pit, mode: 'dig', smooth: false };
  expect(pitDig.rederived).toEqual(dependents(pitCommand));
  const after = await hook<Drop>(page, 'drop', [ox + 9.5, oy + 4, oz + 10.5], 0.15, 0.15);
  expect(after.grounded).toBe(true);
  expect(after.feet[1]).toBeLessThan(before.feet[1] - 1);
  // The undo answer names the box of the edit it takes back: the same chunks are derived again, not every neighbour.
  const undone = await hook<EditAnswer>(page, 'undo');
  expect(undone.ok).toBe(true);
  expect(undone.rederived).toEqual(dependents(pitCommand));
  await noneStale();
  expect((await hook<Drop>(page, 'drop', [ox + 9.5, oy + 4, oz + 10.5], 0.15, 0.15)).feet[1]).toBeCloseTo(before.feet[1], 1);
  expect(errors).toEqual([]);
});

for (const renderer of ['webgpu', 'webgl2'] as const) {
  test(`streams, draws and edits the voxel world through commands; the edit is in the files after a reload (${renderer})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 960, height: 540 });
    const errors = consoleErrors(page);
    await open(page, renderer);
    const state = await hook<{ drawn: number; triangles: number; pieces: number; counters: { damaged: number } }>(page, 'state');
    expect(state.drawn).toBeGreaterThan(20);
    expect(state.triangles).toBeGreaterThan(1000);
    // The beam and the banister's rail and posts are drawn as pieces, not as wall.
    expect(state.pieces).toBeGreaterThan(5);
    expect(state.counters.damaged).toBe(0);
    // Collision on this renderer's page too: a capsule rests on the wall's top, a ball passes between the posts to the wall.
    const [ox, oy, oz] = scene;
    expect((await hook<Drop>(page, 'drop', [ox - 4.5, oy + 12, oz + 0.5], 0.2, 0.2)).feet[1]).toBeCloseTo(oy + 8, 1);
    expect((await hook<{ centre: Cell } | null>(page, 'sweep', [ox - 2.5, oy + 1.5, oz + 12], [0, 0, -1], 0.15, 20))!.centre[2]).toBeCloseTo(oz + 1.3, 1);
    // The probes' markers out of the pictures compared below.
    await hook(page, 'clearMarkers');

    // Each renderer digs its own row of the wall (the other test's dig may already be in the files).
    const cell: Cell = [scene[0], scene[1] + (renderer === 'webgpu' ? 4 : 1), scene[2]];
    expect((await hook<{ material: number }>(page, 'voxelAt', ...cell)).material).not.toBe(0);
    const before = await shot(page);
    const timing = await hook<{ ok: boolean; code?: string; chunks: number; visibleMs: number }>(page, 'dab', cell, 'dig');
    expect(timing.ok, timing.code).toBe(true);
    // At a chunk corner in x and z: the dab changed more than one chunk.
    expect(timing.chunks).toBeGreaterThan(1);
    expect((await hook<{ material: number }>(page, 'voxelAt', ...cell)).material).toBe(0);
    const after = await shot(page);
    // A hole through the wall shows ground or sky where stone was.
    expect(changedPixels(before, after)).toBeGreaterThan(200);

    if (renderer === 'webgl2') await be.restart();
    await page.reload();
    await open(page, renderer);
    expect((await hook<{ material: number }>(page, 'voxelAt', ...cell)).material).toBe(0);
    const again = await shot(page);
    // The same picture as before the reload, from the region files (the view and the world are the same).
    expect(changedPixels(after, again)).toBeLessThan(200);
    expect(errors).toEqual([]);
  });
}
