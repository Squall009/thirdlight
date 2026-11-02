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
 * Files changed behind the backend are read again by the open page when
 * the backend refuses the next command for it.
 *
 * Surfaces are shaded from the chunks' shader data: a material paint and a
 * wetness paint of the wall (across a chunk face) change the picture with
 * no mesh rebuilt and no chunk derived again but for its shader data.
 *
 * Everything is derived per section (the page's default section edge) and
 * drawn per storage chunk (the sections joined): a blast dug at a chunk
 * corner, locally (a game's runtime edit) and as a command, swaps every
 * section's collider and every chunk's draw it rebuilt in one frame (no
 * frame shows part of it), and reads see the dug cells in the same task as
 * the edit.
 */
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodePng, changedPixels } from './png';
import { expect, test, type Page } from './pw';
import { startBackend, type E2EBackend } from './backend';
import { consoleErrors } from './console-errors';
import { writeSliceWorld } from '../../tools/voxel-bench/slice-world';
import { MAT } from '../../tools/voxel-bench/world-kit';
import { canonicalEditCommand, chunkGrid, dependentChunks, editBounds, jobRadius, PLACEHOLDER_RULES, sectionGrid, VOXEL_ROLE, type SectionEdge } from '@thirdlight/voxel';

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
  section = (await hook<{ section: SectionEdge }>(page, 'state')).section;
}

interface CellReport {
  voxel: { material: number; role: number };
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
/** The page's derive section edge (what it reports): derived results, windows and rebuild lists are per section. */
let section: SectionEdge = 32;
const sectionName = (c: Cell): string => c.map((v) => Math.floor(v / section)).join(',');

/** The sections a command can change results in: within the rules' radius + reach of the cells it can change. */
function dependents(command: unknown): string[] {
  return dependentChunks(sectionGrid(section), editBounds(grid, canonicalEditCommand(command)), jobRadius(PLACEHOLDER_RULES))
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
  const centre = scene.map((v) => Math.floor(v / section)) as Cell;
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
  const timber = { material: MAT.timber, role: VOXEL_ROLE.wall, wetness: 0, shape: 15 };
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
  const grow = { v: 2, grid: 0, kind: 'set', cells: grownCells, voxel: timber };
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
  expect((await cellAt(page, gap)).voxel).toMatchObject({ material: MAT.timber, role: VOXEL_ROLE.wall });

  // Take the wall cells behind the beam (chunk z of the wall) on both sides of the x chunk face: the beam cells in front
  // (the next chunk in z, where nothing was edited) become wall stubs, their neighbours end the beam's run.
  const cut = { v: 2, grid: 0, kind: 'dig', cells: behindBeam.flat() };
  const cutAnswer = await send(cut);
  expect(cutAnswer.rederived).toContain(sectionName(beam));
  expect(sectionName(beam)).not.toBe(sectionName(behindBeam[0]!));
  expect(await cellAt(page, beam)).toMatchObject({ resolved: 'wall', outputs: { collision: 'full', light: 255, piece: null } });
  expect((await cellAt(page, [ox - 5, oy + 5, oz - 1])).outputs?.piece?.section).not.toBe(2);
  await send({ v: 2, grid: 0, kind: 'set', cells: behindBeam.flat(), voxel: { material: MAT.stone, role: VOXEL_ROLE.wall, wetness: 0, shape: 15 } });
  expect((await cellAt(page, beam)).resolved).toBe('beam');
  expect(await hashes()).toEqual(h1);

  // Take the growth away again: the banister is back, every derived result as the generator's voxels gave.
  await send({ v: 2, grid: 0, kind: 'dig', cells: grownCells });
  expect((await cellAt(page, rail)).resolved).toBe('rail');
  expect(await hashes()).toEqual(h0);

  // Runtime input with no structure data: dig the generator's banister, then build it again cell by cell.
  const banister: number[] = [];
  for (let x = -4; x < 4; x++) {
    if ((x & 1) === 0) banister.push(ox + x, oy + 1, oz + 7);
    banister.push(ox + x, oy + 2, oz + 7);
  }
  await send({ v: 2, grid: 0, kind: 'dig', cells: banister });
  expect((await cellAt(page, rail)).resolved).toBe('empty');
  await send({ v: 2, grid: 0, kind: 'set', cells: banister, voxel: timber });
  expect(await hashes()).toEqual(h0);
  // The same voxels give the same region file bytes too (canonical files).
  expect(await hook<Record<string, string>>(page, 'files')).toEqual(files0);

  // Dig a pit after the bodies were built: a capsule dropped there falls into it; undo fills it again.
  const pit: Cell = [ox + 9, oy - 1, oz + 10];
  const before = await hook<Drop>(page, 'drop', [ox + 9.5, oy + 4, oz + 10.5], 0.15, 0.15);
  const pitDig = await hook<EditAnswer>(page, 'dab', pit, 'dig');
  expect(pitDig.ok).toBe(true);
  const pitCommand = { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: pit, mode: 'dig', smooth: false };
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

  // Files changed behind the backend (the generator's world written over an edited one, as a checkout would): the next
  // command is refused world_changed and the page reads the world again without a reload, so the edit the checkout took
  // away is gone from the page too; sent again, the command applies on the checked-out world.
  const dug: Cell = [ox + 6, oy - 1, oz + 4];
  expect((await hook<EditAnswer>(page, 'dab', dug, 'dig')).ok).toBe(true);
  expect((await hook<{ material: number }>(page, 'voxelAt', ...dug)).material).toBe(0);
  // The generator's world is written beside it and copied over its files (the writer refuses a folder that holds a world).
  const checkedOut = writeSliceWorld(be.projectDir, 'checkout', 256).dir;
  cpSync(checkedOut, join(dirname(checkedOut), 'slice'), { recursive: true });
  const other: Cell = [ox - 9, oy - 1, oz + 4];
  expect(await hook<EditAnswer>(page, 'dab', other, 'dig')).toMatchObject({ ok: false, code: 'world_changed' });
  await hook(page, 'settle');
  expect((await hook<{ material: number }>(page, 'voxelAt', ...dug)).material).not.toBe(0);
  expect(await hook<Record<string, string>>(page, 'files')).toEqual(files0);
  expect(await hashes()).toEqual(h0);
  await noneStale();
  expect((await hook<EditAnswer>(page, 'dab', other, 'dig')).ok).toBe(true);
  // The refused command's HTTP 409 is the one console error.
  expect(errors.filter((e) => !/status of 409/.test(e))).toEqual([]);
  expect(errors).toHaveLength(1);
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

    // A 2 m blast at the scene's chunk corner in x and z (the pad's ground under the wall's foot), first as a game's
    // runtime edit in the page: the dug cells read as air in the same task as the edit, before anything is rebuilt;
    // every section it rebuilt has its body, and every storage chunk holding them its one draw (the sections joined),
    // replaced in one frame (one swap).
    interface Blast { ok: boolean; code?: string; frames: number; readAtOnce?: { material: number }; swap: { sections: number; chunks: Cell[] }; replacedSections: number; replacedChunks: number; replacedFrames: number[]; replacedSwaps: number[] }
    const spot: Cell = [ox, oy - 1, oz];
    const atomic = (b: Blast, what: string): void => {
      expect(b.ok, `${what}: ${b.code}`).toBe(true);
      expect(b.swap.sections, what).toBeGreaterThan(1);
      expect(b.replacedSections, what).toBe(b.swap.sections);
      // At a chunk corner in x and z: at least four chunks' draws, never more than the sections (a corner's sections
      // may each lie in a chunk of their own).
      expect(b.swap.chunks.length, what).toBeGreaterThanOrEqual(4);
      expect(b.swap.chunks.length, what).toBeLessThanOrEqual(b.swap.sections);
      expect(b.replacedChunks, what).toBe(b.swap.chunks.length);
      expect(b.replacedFrames, what).toHaveLength(1);
      expect(b.replacedSwaps, what).toHaveLength(1);
      expect(b.frames, what).toBeGreaterThanOrEqual(1);
    };
    const local = await hook<Blast>(page, 'blast', spot, 2, 'local');
    atomic(local, 'local');
    expect(local.readAtOnce).toEqual({ material: 0 });
    expect(local.swap.sections).toBe(dependents({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [4, 4, 4], points: spot, mode: 'dig', smooth: false }).length);
    // The local edit is not saved: the page reads the files again and the ground is back.
    await hook(page, 'reread');
    expect((await hook<{ material: number }>(page, 'voxelAt', ...spot)).material).not.toBe(0);
    // The same blast as a command: written by the backend, swapped in one frame too, then undone.
    atomic(await hook<Blast>(page, 'blast', spot, 2, 'command'), 'command');
    expect((await hook<{ material: number }>(page, 'voxelAt', ...spot)).material).toBe(0);
    expect((await hook<EditAnswer>(page, 'undo')).ok).toBe(true);
    expect((await hook<{ material: number }>(page, 'voxelAt', ...spot)).material).not.toBe(0);

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

    // A material paint, then a wetness paint, of the wall's upper rows across the x chunk face: roles and shapes
    // kept, so only the shader data is derived again (the changed chunks and those whose border reaches the cells)
    // and its grids uploaded; no mesh is built, and the picture changes.
    const wallCell: Cell = [ox - 4, oy + 6, oz];
    const was = (await hook<{ material: number }>(page, 'voxelAt', ...wallCell)).material;
    const material = was === MAT.brick ? MAT.plank : MAT.brick;
    const wall = (m: number, wetness: number): unknown => ({ v: 2, grid: 0, kind: 'fill', min: [ox - 4, oy + 5, oz], max: [ox + 3, oy + 7, oz], mode: 'paint', voxel: { material: m, role: VOXEL_ROLE.wall, wetness } });
    type Surface = { swaps: number; surface: { meshBuilds: number; gridUploads: number } };
    let shown = after;
    for (const [what, command] of [['material', wall(material, 0)], ['wetness', wall(material, 7)]] as const) {
      const s0 = await hook<Surface>(page, 'state');
      const answer = await hook<EditAnswer & { cells: number }>(page, 'edit', command);
      expect(answer.ok, `${what}: ${answer.code}`).toBe(true);
      expect(answer.cells, what).toBeGreaterThan(0);
      expect(answer.rederived.length, what).toBeGreaterThan(0);
      expect(answer.rederived.every((c) => c.endsWith(':shader')), `${what}: ${answer.rederived.join(' ')}`).toBe(true);
      const s1 = await hook<Surface>(page, 'state');
      expect(s1.surface.meshBuilds - s0.surface.meshBuilds, what).toBe(0);
      expect(s1.swaps - s0.swaps, what).toBe(0);
      expect(s1.surface.gridUploads - s0.surface.gridUploads, what).toBeGreaterThan(0);
      const painted = await shot(page);
      expect(changedPixels(shown, painted), what).toBeGreaterThan(300);
      shown = painted;
    }
    expect(await hook<{ material: number; wetness: number }>(page, 'voxelAt', ...wallCell)).toMatchObject({ material, wetness: 7 });

    if (renderer === 'webgl2') await be.restart();
    await page.reload();
    await open(page, renderer);
    expect((await hook<{ material: number }>(page, 'voxelAt', ...cell)).material).toBe(0);
    const again = await shot(page);
    // The same picture as before the reload, from the region files (the view and the world are the same).
    expect(changedPixels(shown, again)).toBeLessThan(200);
    expect(errors).toEqual([]);
  });
}
