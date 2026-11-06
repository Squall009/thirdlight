/**
 * A project's voxel world in the real page against the real backend, on
 * WebGPU and on WebGL 2: the voxel world page streams the world's region
 * files by range, derives and draws them (ground, walls, and the kit pieces
 * on the stone's edges), sends a brush dab as a
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
 * chunk face turns the beam in the next chunk (beams and banisters are plain
 * voxels for every consumer: render, collision, navigation, light); the chunks derived again are
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
 * no mesh rebuilt and no chunk derived again but for its shader data. The
 * page runs with the band test texture (`?bands=1`): construction maps it
 * from the build grid in metres, so the wall seen straight on shows its
 * thick bands on the same screen rows either side of a chunk face.
 *
 * Play streams the same world, written 8 km out on x and z, with the
 * simulation: a project with a `voxelWorld` object, a player character
 * standing on the world's ground and a script that digs a pit under it when
 * the test asks (a debug command, after the "before" picture) once the
 * ground is resident. The pixels change where the pit opens, the character
 * falls into it, on both renderers, with the simulation in its worker
 * (WebGPU) and in the page (WebGL 2, `?threads=off`); each edit's way from
 * the script to the screen is read from the play page's hook. The script
 * then wets the ground beside the pit and saves the world (`ctx.voxels.save`,
 * its text kept in the game's own save slot); the game restarts (the world
 * reads its files again, the pit gone) and the script restores the slot's
 * voxel save: the pit is back (pixels, and the character falls in again),
 * the wetness is not (not a saved field by default).
 *
 * Two decals mark the stone wall in Play (8 km out): a red projected one,
 * blended into the wall's own material, and a blue clipped one, cut from
 * the wall's chunk surface; each fills its spot on the screen (pixels where
 * the camera sees the wall), and the play's diagnostics count both.
 *
 * The same project exported (the debug console on) and served statically
 * with the backend stopped: the world's region files ship whole as content
 * files and stream from there, in the simulation's worker, with the voxel
 * workers it starts; the world draws with both wall marks (pixels), the
 * character stands on it, and a dig typed into the debug console opens the
 * pit (pixels) and drops it in.
 *
 * Detail pieces come from the project's voxel kits and stand only where
 * faces meet: a test kit gives the stone wall's free ends' vertical edges a
 * board from a GLB imported into the project and their top corners the same
 * board through a rotated slot mesh (the wall's flat faces get none); every
 * other material draws plain voxel faces. The page, Play, the Scene view
 * and the export (its GLB from the shipped content) all draw kit pieces; in
 * the Scene view a slot filled through the command route draws without a
 * reload, and goes again when the kit is set back.
 *
 * Everything is derived per section (the page's default section edge) and
 * drawn per storage chunk (the sections joined): a blast dug at a chunk
 * corner, locally (a game's runtime edit) and as a command, swaps every
 * section's collider and every chunk's draw it rebuilt in one frame (no
 * frame shows part of it), and reads see the dug cells in the same task as
 * the edit.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { glbBytes } from '@thirdlight/shared';
import { dirname, join } from 'node:path';
import { decodePng, changedPixels } from './png';
import { expect, test, type Page } from './pw';
import { exportedContent, serveDir, startBackend, type E2EBackend } from './backend';
import { consoleErrors } from './console-errors';
import { editorUrlFor, expectRendererBackend, exportQueryFor } from './renderer-variants';
import { writeSliceWorld } from '../../tools/voxel-bench/slice-world';
import { MAT } from '../../tools/voxel-bench/world-kit';
import { canonicalEditCommand, chunkGrid, cubeRotationIndex, dependentChunks, editBounds, jobRadius, kitTestScene, WORLD_RULES, sectionGrid, VOXEL_ROLE, VOXEL_SIZE_M, type SectionEdge } from '@thirdlight/voxel';

type Cell = [number, number, number];
let be: E2EBackend;
let scene: Cell;
/** The same world 8 km out on x and z (512 chunks), for Play: a world far from the origin. */
const FAR_CHUNKS = 512;
let farScene: Cell;

test.beforeAll(async () => {
  be = await startBackend('e2e-voxel');
  // 128 m square: enough ground around the scene for the ring, quick to write.
  scene = [...writeSliceWorld(be.projectDir, 'slice', 256).scene] as Cell;
  farScene = [...writeSliceWorld(be.projectDir, 'far', 256, { x: FAR_CHUNKS, z: FAR_CHUNKS }).scene] as Cell;
  await addStoneKit();
});

/**
 * The test kit's id: end boards up the stone wall's free ends from a GLB (clear of the rows the tests paint and
 * dig, so their pictures compare the surface). It binds stone and the two materials the wall is painted with below
 * (brick, plank), so those paints stay within one kit (shader data only); every other material draws plain voxel
 * faces.
 */
const STONE_KIT = 'stone-test';
/** The test kit's record as set up, and its one mesh (the Scene view test fills another slot with it and sets the kit back). */
let stoneKit: { slots: Record<string, unknown> } & Record<string, unknown>;
let stoneMesh: { assetId: string; digest: string };

/**
 * A voxel kit for the stone material with one authored piece, an outside vertical edge's board (the free ends'
 * corners): a GLB (a 0.1 × 0.5 × 0.6 m box standing proud of the end face, 12 triangles, no texture) written into the
 * project and imported as every model is, named by its version's digest. The free ends' top corners draw the same
 * board through an alias (the vertical edge's mesh turned a quarter about z onto the top), clear of the painted rows.
 */
async function addStoneKit(): Promise<void> {
  const box = new THREE.BoxGeometry(0.1, VOXEL_SIZE_M, 0.6).translate(VOXEL_SIZE_M / 2 + 0.02, 0, 0);
  const parts = [box.getAttribute('position'), box.getAttribute('normal'), box.getAttribute('uv')].map((a) => new Uint8Array((a.array as Float32Array).slice().buffer));
  const index = new Uint8Array(Uint16Array.from(box.index!.array as ArrayLike<number>).buffer);
  const bin = new Uint8Array([...parts, index].reduce((n, b) => n + b.length, 0));
  let at = 0;
  const views = [...parts, index].map((b, i) => {
    bin.set(b, at);
    const v = { buffer: 0, byteOffset: at, byteLength: b.length, target: i < 3 ? 34962 : 34963 };
    at += b.length;
    return v;
  });
  box.computeBoundingBox();
  const n = box.getAttribute('position').count;
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'End board', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min: box.boundingBox!.min.toArray(), max: box.boundingBox!.max.toArray() },
      { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: n, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: box.index!.count, type: 'SCALAR' },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  const glb = glbBytes(JSON.stringify(json), bin);
  mkdirSync(join(be.projectDir, 'assets', 'kits'), { recursive: true });
  writeFileSync(join(be.projectDir, 'assets', 'kits', 'stone-end.glb'), glb);
  const imported = (await playCmd('importAssets', { folder: 'assets/kits' })) as { change: { added: { assetId: string }[] } };
  const assetId = imported.change.added[0]!.assetId;
  const digest = createHash('sha256').update(glb).digest('hex');
  console.log(`[voxel kit] ${STONE_KIT}: end board GLB ${glb.length} bytes, ${box.index!.count / 3} triangles, no texture`);
  stoneMesh = { assetId, digest };
  stoneKit = { kitFormat: 1, voxelKitId: STONE_KIT, name: 'Stone (test)', version: 1, materialType: 'stone', materials: [MAT.stone, MAT.plank, MAT.brick], slots: { 'edge-out-vertical': { meshes: [{ mesh: { assetId, digest } }] }, 'corner-out-top': { meshes: [{ mesh: { assetId, digest }, rotation: cubeRotationIndex([0, -1, 0, 1, 0, 0, 0, 0, 1]) }] } } };
  await playCmd('setVoxelKit', { kit: stoneKit });
}
test.afterAll(async () => {
  await be?.stop();
});

const hook = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { __tlVoxelWorld: Record<string, (...x: unknown[]) => unknown> }).__tlVoxelWorld[f as string]!(...(a as unknown[])) as T, [fn, args] as const);

async function open(page: Page, renderer: 'webgpu' | 'webgl2', query = ''): Promise<void> {
  await page.goto(`${be.origin}/voxel-world.html?project=${be.projectId}&world=slice&at=${scene.join(',')}&renderer=${renderer}&hud=0${query}#token=${be.token}`);
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
  outputs: { renderSolid: boolean; baseFaces: number; piece: { piece: number; replacesBase: boolean } | null; collision: string; navBlocks: boolean; standable: boolean; light: number } | null;
  /** A kit piece's kit, case and run section (null: none, or an engine default piece). */
  kitPiece: { kit: string; caseId: string; mesh: number; rotation: number } | null;
  /** Every kit piece the cell owns (one an edge or corner), its turns and placement. */
  kitPieces: { kit: string | null; caseId: string | null; mesh: number | null; rotation: number | null; turns: number; place: number }[];
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
  return dependentChunks(sectionGrid(section), editBounds(grid, canonicalEditCommand(command)), jobRadius(WORLD_RULES))
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

  // As the generator wrote it: a banister (rail on posts), a beam one out from the wall, the wall; the rail, posts and
  // beam are plain voxels for every consumer (beams and banisters are not part of the voxel world), no piece in their place.
  const plain = { renderSolid: true, collision: 'full', navBlocks: true, light: 255 };
  expect(await cellAt(page, rail)).toMatchObject({ resolved: 'rail', outputs: { ...plain, standable: false } });
  expect((await cellAt(page, rail)).outputs?.baseFaces).toBeGreaterThan(0);
  expect((await cellAt(page, post)).resolved).toBe('post');
  expect(await cellAt(page, gap)).toMatchObject({ resolved: 'empty', outputs: { collision: 'none', navBlocks: false, light: 0 } });
  expect(await cellAt(page, beam)).toMatchObject({ resolved: 'beam', outputs: plain });
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
  // A whole wall for every consumer; its piece, if any, a kit's edge piece added to the kept body (never one replacing it).
  const stub = await cellAt(page, beam);
  expect(stub).toMatchObject({ resolved: 'wall', outputs: { collision: 'full', light: 255 } });
  expect(stub.outputs?.piece?.replacesBase ?? false).toBe(false);
  expect(stub.outputs?.piece === null || stub.kitPiece?.kit === STONE_KIT).toBe(true);
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
    // Construction drawn with the band test texture (the pictures below compare with each other, a reload's too).
    await open(page, renderer, '&bands=1');
    const state = await hook<{ drawn: number; triangles: number; pieces: number; counters: { damaged: number } }>(page, 'state');
    expect(state.drawn).toBeGreaterThan(20);
    expect(state.triangles).toBeGreaterThan(1000);
    // The stone wall's kit pieces (its free end's vertical edges and top corners).
    expect(state.pieces).toBeGreaterThan(5);
    expect(state.counters.damaged).toBe(0);
    // Collision on this renderer's page too: a capsule rests on the wall's top, a ball passes between the posts to the wall.
    const [ox, oy, oz] = scene;
    expect((await hook<Drop>(page, 'drop', [ox - 4.5, oy + 12, oz + 0.5], 0.2, 0.2)).feet[1]).toBeCloseTo(oy + 8, 1);
    expect((await hook<{ centre: Cell } | null>(page, 'sweep', [ox - 2.5, oy + 1.5, oz + 12], [0, 0, -1], 0.15, 20))!.centre[2]).toBeCloseTo(oz + 1.3, 1);
    // The probes' markers out of the pictures compared below.
    await hook(page, 'clearMarkers');

    // Construction maps its texture from the build grid in metres: the wall's +z face, drawn by the chunks either side
    // of the x chunk face and seen straight on, shows the band texture's thick lines (red at 0 m, blue at 2 m of the
    // 4 m tile) on the same screen rows left and right of the face.
    await hook(page, 'look', ox, oy + 5, oz + 1, 0, 0, 4);
    await hook(page, 'settle');
    const straight = await shot(page);
    /** The thick bands down a pixel column: each run of red or blue rows, its colour and middle row. */
    const thickBands = (x: number): Array<{ colour: string; mid: number }> => {
      const out: Array<{ colour: string; from: number; to: number }> = [];
      for (let y = 0; y < straight.height; y++) {
        const [r, g, b] = straight.pixel(x, y);
        const colour = r > 80 && r > 2 * g && r > 2 * b ? 'red' : b > 80 && b > 2 * r && b > 2 * g ? 'blue' : null;
        if (colour === null) continue;
        const last = out[out.length - 1];
        if (last !== undefined && last.colour === colour && last.to === y - 1) last.to = y;
        else out.push({ colour, from: y, to: y });
      }
      return out.map((b) => ({ colour: b.colour, mid: (b.from + b.to) / 2 }));
    };
    const leftBands = thickBands(Math.round(straight.width * 0.3));
    const rightBands = thickBands(Math.round(straight.width * 0.7));
    expect(leftBands.length, 'thick bands left of the chunk face').toBeGreaterThan(0);
    expect(rightBands.map((b) => b.colour), 'the same bands right of it').toEqual(leftBands.map((b) => b.colour));
    rightBands.forEach((b, k) => expect(Math.abs(b.mid - leftBands[k]!.mid), `band ${k} (${b.colour}) rows`).toBeLessThanOrEqual(1));
    await hook(page, 'look', ox, oy + 3, oz + 2, -0.75, 0.42, 16);
    await hook(page, 'settle');

    // Kit pieces: the stone wall's free end's vertical edges draw the test kit's GLB board (read from the backend,
    // parsed by the page's loader), its flat faces nothing; a material without a kit (timber) none: plain voxel edges.
    // A cell in the middle of the wall owns no piece.
    const kitState = await hook<{ kitPieces: number; kits: { ids: string[]; meshes: Record<string, string> } }>(page, 'state');
    expect(kitState.kits.ids).toEqual([STONE_KIT]);
    expect(Object.values(kitState.kits.meshes)).toEqual(['ready']);
    expect(kitState.kitPieces).toBeGreaterThan(5);
    const freeEnd = await cellAt(page, [ox + 5, oy + 2, oz]);
    expect(freeEnd.kitPieces.map((p) => `${p.kit} ${p.caseId} ${p.turns}`).sort()).toEqual([`${STONE_KIT} edge-out-vertical 0`, `${STONE_KIT} edge-out-vertical 3`]);
    expect((await cellAt(page, [ox, oy + 3, oz])).kitPieces).toEqual([]);
    // The free end's top corners, front and back, draw the board turned by their slot's rotation (its top edges: an
    // empty slot, none drawn); the wall's top cell in the middle has its top edges only, an empty slot: nothing.
    const topEnd = (await cellAt(page, [ox + 5, oy + 7, oz])).kitPieces.map((p) => `${p.kit} ${p.caseId}`).sort();
    expect(topEnd).toEqual([`${STONE_KIT} corner-out-top`, `${STONE_KIT} corner-out-top`, `${STONE_KIT} edge-out-vertical`, `${STONE_KIT} edge-out-vertical`]);
    expect((await cellAt(page, [ox, oy + 6, oz])).kitPieces).toEqual([]);
    // The banister grown into a wall (its gaps and a row over the rail): timber has no kit, so no piece before or after,
    // the picture changes with the voxels; dug back, the banister is as before.
    const railCell: Cell = [ox - 3, oy + 2, oz + 7];
    expect((await cellAt(page, railCell)).outputs?.piece ?? null).toBeNull();
    const grown: number[] = [];
    for (let x = -4; x < 4; x++) grown.push(...((x & 1) !== 0 ? [ox + x, oy + 1, oz + 7] : []), ox + x, oy + 3, oz + 7);
    const banisterShot = await shot(page);
    expect((await hook<EditAnswer>(page, 'edit', { v: 2, grid: 0, kind: 'set', cells: grown, voxel: { material: MAT.timber, role: VOXEL_ROLE.wall, wetness: 0, shape: 15 } })).ok).toBe(true);
    expect((await cellAt(page, railCell)).outputs?.piece ?? null).toBeNull();
    expect((await cellAt(page, [ox - 3, oy + 3, oz + 7])).kitPieces).toEqual([]);
    expect(changedPixels(banisterShot, await shot(page)), 'banister → wall').toBeGreaterThan(300);
    expect((await hook<EditAnswer>(page, 'edit', { v: 2, grid: 0, kind: 'dig', cells: grown })).ok).toBe(true);
    expect((await cellAt(page, railCell)).resolved).toBe('rail');

    // The kit test scene (writeKitTestScene, the page's ?kitScene): written beside the scene in stone (the test kit's
    // material), every slot's sampler cell labelled on the screen; the filled slot (vertical edges) draws the kit's
    // board there, an empty slot (top edges) nothing; one undo takes it away.
    if (renderer === 'webgpu') {
      const at: Cell = [ox - 52, oy, oz + 16];
      const labels = kitTestScene(WORLD_RULES, { origin: at, material: MAT.stone }).labels;
      expect((await hook<EditAnswer>(page, 'writeKitScene', at, MAT.stone)).ok).toBe(true);
      const top = labels.find((l) => l.caseId === 'edge-out-vertical')!;
      await hook(page, 'look', ...top.cell, -0.6, 0.45, 8);
      await hook(page, 'settle');
      await page.waitForFunction(() => ((window as unknown as { __tlVoxelWorld: { labelsShown(): number } }).__tlVoxelWorld.labelsShown()) > 3);
      expect((await cellAt(page, [...top.cell] as Cell)).kitPieces.map((p) => `${p.kit} ${p.caseId}`)).toContain(`${STONE_KIT} edge-out-vertical`);
      const edgeTop = labels.find((l) => l.caseId === 'edge-out-top')!;
      expect((await cellAt(page, [...edgeTop.cell] as Cell)).kitPieces.map((p) => p.caseId)).not.toContain('edge-out-top');
      expect((await hook<EditAnswer>(page, 'undo')).ok).toBe(true);
      expect((await cellAt(page, [...top.cell] as Cell)).outputs?.piece ?? null).toBeNull();
      await hook(page, 'clearKitScene');
      // Back to the view the page opened with: the pictures below compare against a reload's.
      await hook(page, 'look', ox, oy + 3, oz + 2, -0.75, 0.42, 16);
      await hook(page, 'settle');
    }

    // A 2 m blast at the scene's chunk corner in x and z (the pad's ground under the wall's foot), first as a game's
    // runtime edit in the page: the dug cells read as air in the same task as the edit, before anything is rebuilt;
    // every storage chunk holding the sections it rebuilt has its one body and its one draw (the sections joined)
    // replaced in one frame (one swap).
    interface Blast { ok: boolean; code?: string; frames: number; readAtOnce?: { material: number }; swap: { sections: number; chunks: Cell[] }; replacedBodies: number; replacedChunks: number; replacedFrames: number[]; replacedSwaps: number[] }
    const spot: Cell = [ox, oy - 1, oz];
    const atomic = (b: Blast, what: string): void => {
      expect(b.ok, `${what}: ${b.code}`).toBe(true);
      expect(b.swap.sections, what).toBeGreaterThan(1);
      // At a chunk corner in x and z: at least four chunks' draws, never more than the sections (a corner's sections
      // may each lie in a chunk of their own).
      expect(b.swap.chunks.length, what).toBeGreaterThanOrEqual(4);
      expect(b.swap.chunks.length, what).toBeLessThanOrEqual(b.swap.sections);
      expect(b.replacedChunks, what).toBe(b.swap.chunks.length);
      expect(b.replacedBodies, what).toBe(b.swap.chunks.length);
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
    await open(page, renderer, '&bands=1');
    expect((await hook<{ material: number }>(page, 'voxelAt', ...cell)).material).toBe(0);
    const again = await shot(page);
    // The same picture as before the reload, from the region files (the view and the world are the same).
    expect(changedPixels(shown, again)).toBeLessThan(200);

    // Detail levels in this small world: level 0 within 4 m, level 1 within 24 m, level 2 past it (the change is
    // one swap). Every level is drawn, with seams between them, and a grazing view across the level boundaries
    // shows ground everywhere below the horizon: no background through a crack.
    await hook(page, 'setLevels', [4, 24]);
    const yaw = -0.75;
    await hook(page, 'look', ox, oy + 3, oz + 2, yaw, 0.18, 30);
    await hook(page, 'settle');
    const lv = await hook<{ levels: number[]; seams: number; seamTriangles: number }>(page, 'state');
    expect(lv.levels[0], 'level 0 drawn').toBeGreaterThan(0);
    expect(lv.levels[1], 'level 1 drawn').toBeGreaterThan(0);
    expect(lv.seams).toBeGreaterThan(0);
    expect(lv.seamTriangles).toBeGreaterThan(0);
    const grazing = await shot(page);
    let sky = 0;
    // Below the horizon everywhere across the picture (it sits at 0.55–0.57 of the height at the left edge).
    for (let y = Math.floor(grazing.height * 0.62); y < grazing.height; y++) for (let x = 0; x < grazing.width; x++) {
      const [r, g, b] = grazing.pixel(x, y);
      if (Math.abs(r - 0x9f) <= 8 && Math.abs(g - 0xc4) <= 8 && Math.abs(b - 0xe8) <= 8) sky++;
    }
    expect(sky, 'background pixels below the horizon').toBe(0);
    // A runtime dig in the level-1 ring (on the line from the target to the camera, in view) shows: the node over
    // it is derived again and its draw replaced, still at level 1.
    let pit: Cell | null = null;
    for (let t = 8; t < 50 && pit === null; t++) {
      const x = Math.round(ox + (Math.sin(yaw) * t) / 0.5);
      const z = Math.round(oz + 2 + (Math.cos(yaw) * t) / 0.5);
      const top = await hook<number | null>(page, 'surfaceAt', x, z, oy + 40, oy - 40);
      if (top !== null && (await hook<number | null>(page, 'levelAt', x, top - 1, z)) === 1 && (await hook<number | null>(page, 'levelAt', x + 12, top - 1, z + 12)) === 1) pit = [x, top - 1, z];
    }
    expect(pit, 'a ground cell drawn at level 1').not.toBeNull();
    // In the grazing view: between the camera and the target (the focus stays at the target).
    const levelBefore = await shot(page);
    expect((await hook<Blast>(page, 'blast', pit, 2.5, 'local')).ok).toBe(true);
    await hook(page, 'settle');
    expect(await hook<number | null>(page, 'levelAt', ...pit!)).toBe(1);
    expect(changedPixels(levelBefore, await shot(page)), 'a dig at level 1').toBeGreaterThan(300);
    await hook(page, 'reread');
    expect(errors).toEqual([]);
  });
}

// ---- Play: the world runs with the simulation ----------------------------------------------------------------

async function playCmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-voxel-play' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
async function projectApi(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function publishScript(behaviorId: string, source: string, entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stageId = String((await projectApi('content/stages')).json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, { method: 'PUT', headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await playCmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await playCmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const revision = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  const published = await projectApi('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await playCmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

/** Where the character stands (metres): the slice's flat pad, beside the wall scene. */
let standAt: [number, number, number] | null = null;

/** The Play camera (metres, as `playProject` places it): over the pad, 35° down. */
const PLAY_PITCH = (35 * Math.PI) / 180;
const playCamera = (at: readonly number[]): { position: number[]; rotation: number[] } => ({ position: [at[0]!, at[1]! + 5, at[2]! + 7], rotation: [-Math.sin(PLAY_PITCH / 2), 0, 0, Math.cos(PLAY_PITCH / 2)] });
/** The decal marks on the far world's stone wall (metres: its front face, above the banister). */
const DECAL_SIDE = 1.2;
const wallMarks = (): { projected: number[]; clipped: number[] } => {
  const [ox, oy, oz] = farScene;
  return { projected: [ox / 2 - 1.5, oy / 2 + 2.75, oz / 2 + 0.5], clipped: [ox / 2 + 1.5, oy / 2 + 2.75, oz / 2 + 0.5] };
};

/**
 * Pixels of the frame in a mark's hue. Lit and tone-mapped, the red mark reads about (181, 70, 66) and the blue one
 * (57, 107, 210); nothing else in the scene comes near: the stand-in stone is grey, the ground green, the sky black
 * and the brick banister a brown-red at 1.65 × (132, 80, 75).
 */
function hueCount(img: ReturnType<typeof decodePng>, hue: 'red' | 'blue'): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (hue === 'red' ? r > 100 && r >= 2.2 * g && r >= 2.2 * b : b > 100 && b >= 1.6 * g && b >= 2.5 * r) n += 1;
  }
  return n;
}

/**
 * The play project: the slice world 8 km out as a `voxelWorld`, a camera looking at the pad, a character on it, and
 * a script that digs once the test asks (a debug command) after the pit's ground is resident; on further commands it
 * wets the ground beside the pit, saves the world into the game's save slot 1, and restores it from there.
 */
async function playProject(): Promise<[number, number, number]> {
  if (standAt !== null) return standAt;
  const [ox, oy, oz] = farScene;
  const at: [number, number, number] = [(ox + 9.5) / 2, oy / 2, (oz + 10.5) / 2];
  const world = String((await playCmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'World', transform: { position: at }, components: { voxelWorld: { world: 'far' } } }))['createdId']);
  await playCmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Pit camera', transform: playCamera(at), components: { virtualCamera: { rig: 'fixed', priority: 30, blend: 'cut', fovY: 60, near: 0.1, far: 300 } } });
  // A projected and a clipped decal on the wall's front face (facing +z: a decal projects along its −z), plain colours.
  await playCmd('setMaterial', { material: { materialId: 'mark-red', name: 'Red mark', shader: 'decal', params: { color: '#e01010' }, textures: {} } });
  await playCmd('setMaterial', { material: { materialId: 'mark-blue', name: 'Blue mark', shader: 'decal', params: { color: '#1030e0' }, textures: {} } });
  const marks = wallMarks();
  for (const [mode, material] of [['projected', 'mark-red'], ['clipped', 'mark-blue']] as const) {
    await playCmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: `Wall mark (${mode})`, transform: { position: marks[mode] }, components: { decal: { size: [DECAL_SIDE, DECAL_SIDE, 0.6], mode, material } } });
  }
  const player = String((await playCmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Player', transform: { position: [at[0], at[1] + 1.5, at[2]] } }))['createdId']);
  await playCmd('setComponent', { entityId: player, component: 'controller', value: {} });
  // One save slot for the game's own save document (the voxel save rides in it as text).
  await playCmd('setSaveSchema', { schema: { version: 1, slots: 1, legacyWorld: false } });
  const pit = `{ center: [${at[0]}, ${at[1] - 0.25}, ${at[2]}], radius: 1.75 }`;
  const wetAt = `[${at[0] - 2.75}, ${at[1] - 0.25}, ${at[2]}]`;
  await publishScript('digger', [
    'export default {',
    '  prepare() { return {}; },',
    '  instantiate() { return { wait: -1, at: -1, dug: false }; },',
    '  step(state: any, ctx: any) {',
    "    if (ctx.phase !== 'intent') return;",
    '    const v = ctx.voxels;',
    `    const pit = ${pit};`,
    '    if (state.wait < 0) state.wait = v.whenResident(pit);',
    "    for (const w of v.waits) if (w.wait === state.wait && w.resident && state.at < 0) { state.at = ctx.stepIndex; ctx.game.add('resident', 1); }",
    "    for (const c of v.changes) ctx.game.add('changes', 1);",
    "    for (const _ of ctx.debug.command('dig')) if (!state.dug) { const r = v.dig(pit); state.dug = r.ok; ctx.game.add(r.ok ? 'dug' : 'refused', 1); }",
    `    const wetAt = ${wetAt};`,
    "    for (const _ of ctx.debug.command('wet')) { const r = v.paint({ center: wetAt, radius: 1.5 }, { wetness: 7 }); ctx.game.add(r.ok ? 'wet' : 'refused', 1); ctx.game.add('wetness', v.get(...wetAt)?.wetness ?? -1); }",
    "    for (const _ of ctx.debug.command('save')) state.save = v.save();",
    "    for (const a of v.saves) if (a.save === state.save) ctx.game.add(a.ok && ctx.saves.write({ voxels: a.text }) && ctx.saves.save(1) ? 'saving' : 'saveFailed', 1);",
    "    for (const _ of ctx.debug.command('restore')) ctx.game.add(ctx.saves.load(1) ? 'loading' : 'loadFailed', 1);",
    "    for (const r of ctx.saves.results()) if (r.op === 'save') ctx.game.add(r.ok ? 'saved' : 'saveFailed', 1); else if (r.op === 'load' && r.ok) {",
    "      const doc = ctx.saves.read();",
    "      const r2 = v.restore(doc.voxels, 'save');",
    "      ctx.game.add(r2.ok ? 'restored' : 'restoreRefused', 1);",
    "      if (v.get(...pit.center)?.material === 0) ctx.game.add('holeKept', 1);",
    "      if (v.get(...wetAt)?.wetness === 0) ctx.game.add('dry', 1);",
    '    }',
    '  },',
    '  dispose() {},',
    '};',
    '',
  ].join('\n'), world);
  return (standAt = at);
}

interface PlayObservation { state?: string; stepIndex?: number; counters?: Record<string, number>; player?: { x: number; y: number; z: number } }
interface VoxelPlayHook { kits(): Record<string, string>; stats(): { worlds: Record<string, { chunks: number; triangles: number; kitInstances: number }>; batches: number; replaced: number; waiting: number }; edits(): Array<{ swapMs: number; hopMs: number; applyMs: number; visibleMs: number; frames: number; chunks: number; sections: number }> }

for (const renderer of ['webgpu', 'webgl2'] as const) {
  // WebGPU plays with the simulation in its worker, WebGL 2 in the page: both ways the world reaches the draws.
  const threads = renderer === 'webgpu' ? 'worker' : 'single';
  test(`Play: a world 8 km out streams with the simulation (${threads}), a script digs a pit, the pixels change and the character falls in; a voxel save in the game's slot brings the pit back after a restart, not the wetness (${renderer})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    const at = await playProject();
    const errors = consoleErrors(page);
    const url = editorUrlFor(be.editorUrl, renderer);
    await page.goto(threads === 'single' ? url.replace('#', '&threads=off#') : url);
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const answer = (await (await started).json()) as { playSessionId: string; playContent: { path: string } };
    const psid = String(answer.playSessionId);
    const frame = page.frameLocator('iframe.tl-app__preview-frame');
    const canvas = frame.locator('canvas').first();
    await expectRendererBackend(canvas, renderer);
    // The play's locator serves the world its scenes name, not the project's other worlds.
    const preview = new URL((await page.locator('iframe.tl-app__preview-frame').getAttribute('src'))!, be.origin).origin;
    const voxelStatus = async (world: string): Promise<number> => (await fetch(`${preview}${answer.playContent.path}voxels/${world}`)).status;
    expect([await voxelStatus('far'), await voxelStatus('slice')]).toEqual([200, 404]);
    const observe = async (): Promise<PlayObservation> => (await projectApi(`play/${psid}/observe`)).json as PlayObservation;
    const drawn = (): Promise<ReturnType<VoxelPlayHook['stats']>> => canvas.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.stats());
    await expect.poll(async () => (await observe()).counters?.['resident'] ?? 0, { timeout: 60_000, message: 'the pit is resident' }).toBe(1);
    // The world is drawn round the camera and the character stands on its ground (it waited over unloaded ground).
    await expect.poll(async () => (await drawn()).worlds['far']?.chunks ?? 0, { timeout: 30_000 }).toBeGreaterThan(20);
    // Kit pieces drawn: the stone kit's GLB read from the build's content and parsed on the page, the default kit's elsewhere.
    await expect.poll(async () => Object.values(await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.kits())), { timeout: 20_000 }).toEqual(['ready']);
    expect((await drawn()).worlds['far']!.kitInstances).toBeGreaterThan(5);
    // It waits over ground not streamed in yet and then lands on it (its origin stands above its feet).
    await expect.poll(async () => { const y = (await observe()).player?.y ?? -1e9; return y > at[1] && y < at[1] + 1.2; }, { timeout: 20_000, message: 'the character stands on the pad' }).toBe(true);
    const standing = (await observe()).player!;
    // Both wall marks: the clipped one cut from the wall's chunk once it streamed in, the projected one in the wall's draws.
    type DecalDiag = { renderer?: { clippedDecals?: { drawn: number; pending: number; triangles: number; workerMs: { mean: number; max: number } }; projectedDecals?: { drawn: number; receiverDraws: number } } };
    const decalDiag = async (): Promise<DecalDiag['renderer']> => ((await projectApi(`play/${psid}/diagnostics`)).json as { diagnostics?: DecalDiag }).diagnostics?.renderer;
    let lastDiag: unknown = null;
    await expect.poll(async () => { const r = await decalDiag(); lastDiag = r; return [r?.clippedDecals?.drawn ?? 0, r?.clippedDecals?.pending ?? -1, r?.projectedDecals?.drawn ?? 0, (r?.projectedDecals?.receiverDraws ?? 0) > 0]; }, { timeout: 20_000, message: 'both wall marks are drawn' }).toEqual([1, 0, 1, true]).catch((e: unknown) => {
      console.log(`[voxel-play] decals (failed): ${JSON.stringify(lastDiag)}`);
      throw e;
    });
    const before = decodePng(await page.locator('iframe.tl-app__preview-frame').screenshot({ path: test.info().outputPath('before.png') }));
    const clips = (await decalDiag())?.clippedDecals;
    const marks = [hueCount(before, 'red'), hueCount(before, 'blue')];
    console.log(`[voxel-play] ${renderer} wall marks: projected red ${marks[0]} px, clipped blue ${marks[1]} px; clipped ${clips?.triangles} triangles, cut on a worker ${clips?.workerMs.mean.toFixed(2)} ms (worst ${clips?.workerMs.max.toFixed(2)})`);
    expect(marks[0], 'the projected mark on the wall').toBeGreaterThan(200);
    expect(marks[1], 'the clipped mark on the wall').toBeGreaterThan(200);
    const dig = await projectApi(`play/${psid}/control`, { command: 'debugCommand', name: 'dig' });
    expect(dig.status, JSON.stringify(dig.json)).toBe(200);
    await expect.poll(async () => (await observe()).counters?.['dug'] ?? 0, { timeout: 30_000 }).toBe(1);
    expect((await observe()).counters?.['refused'] ?? 0).toBe(0);
    await expect.poll(async () => (await observe()).counters?.['changes'] ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    // The character falls into the pit (its collider went with the swap that drew the hole).
    await expect.poll(async () => standing.y - ((await observe()).player?.y ?? standing.y), { timeout: 10_000, message: 'the character falls into the pit' }).toBeGreaterThan(1);
    const after = decodePng(await page.locator('iframe.tl-app__preview-frame').screenshot({ path: test.info().outputPath('after.png') }));
    expect(changedPixels(before, after)).toBeGreaterThan(500);
    const edits = await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.edits());
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const pipeline = ((await projectApi(`play/${psid}/diagnostics`)).json as { diagnostics?: { simulation?: { pipeline?: { workerRoundTripMs: { avg: number; max: number } } | null } } }).diagnostics?.simulation?.pipeline ?? null;
    console.log(`[voxel-play] ${renderer} ${threads}: edit→screen ${JSON.stringify(edits)}; sim round trip ${JSON.stringify(pipeline?.workerRoundTripMs ?? null)}; drawn ${JSON.stringify(await drawn())}`);

    // Wet the ground beside the pit, save the world into the game's slot, restart, restore: the pit is back, dry.
    const control = async (body: Record<string, unknown>): Promise<void> => {
      const r = await projectApi(`play/${psid}/control`, body);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    };
    const counter = async (name: string): Promise<number> => (await observe()).counters?.[name] ?? 0;
    await control({ command: 'debugCommand', name: 'wet' });
    await expect.poll(() => counter('wet'), { timeout: 10_000 }).toBe(1);
    expect(await counter('wetness')).toBe(7);
    await control({ command: 'debugCommand', name: 'save' });
    await expect.poll(() => counter('saved'), { timeout: 20_000, message: 'the voxel save is in the slot' }).toBe(1);
    expect(await counter('saveFailed')).toBe(0);
    await control({ command: 'replay' });
    // The new run: the world reads its files again (the pit filled), and the character stands on the pad again.
    await expect.poll(() => counter('resident'), { timeout: 30_000, message: 'the new run sees the pit resident' }).toBe(1);
    expect(await counter('dug')).toBe(0);
    await expect.poll(async () => { const y = (await observe()).player?.y ?? -1e9; return y > at[1] && y < at[1] + 1.2; }, { timeout: 20_000, message: 'the character stands on the pad again' }).toBe(true);
    const again = (await observe()).player!;
    const restarted = decodePng(await page.locator('iframe.tl-app__preview-frame').screenshot({ path: test.info().outputPath('restarted.png') }));
    expect(changedPixels(after, restarted)).toBeGreaterThan(500);
    await control({ command: 'debugCommand', name: 'restore' });
    await expect.poll(() => counter('restored'), { timeout: 20_000, message: 'the voxel save is restored' }).toBe(1);
    expect(await counter('holeKept')).toBe(1);
    expect(await counter('dry')).toBe(1);
    await expect.poll(async () => again.y - ((await observe()).player?.y ?? again.y), { timeout: 10_000, message: 'the character falls into the restored pit' }).toBeGreaterThan(1);
    const restored = decodePng(await page.locator('iframe.tl-app__preview-frame').screenshot({ path: test.info().outputPath('restored.png') }));
    expect(changedPixels(restarted, restored)).toBeGreaterThan(500);
    expect((await observe()).state).toBe('running');
    expect(errors).toEqual([]);
  });
}

// ---- The editor's Scene view draws the world ----------------------------------------------------------------

/**
 * The Scene view's picture once it is still (no frame asked for, none drawn while it was taken), saved under `name`.
 * What streams in on its own is waited for by the caller first.
 */
async function sceneViewStill(page: Page, name: string): Promise<ReturnType<typeof decodePng>> {
  const view = page.locator('canvas.tl-viewport');
  const quiet = async (): Promise<string | null> => ((await view.getAttribute('data-frame-wanted')) === '0' ? await view.getAttribute('data-frames') : null);
  let png: Buffer | null = null;
  await expect.poll(async () => {
    const before = await quiet();
    if (before === null) return false;
    const shot = await view.screenshot();
    if ((await quiet()) !== before) return false;
    png = shot;
    return true;
  }, { timeout: 30_000, intervals: [50] }).toBe(true);
  writeFileSync(test.info().outputPath(`${name}.png`), png!);
  return decodePng(png!);
}

interface SceneViewVoxels { worlds: Record<string, { chunks: number; triangles: number; meshBuilds: number; kitInstances: number }>; replaced: number; states: Record<string, { revision: number; settled: boolean; resident: number }>; problems: Record<string, string> }

test("Scene view: a voxelWorld object's world streams round the editor camera and draws; an edit and a kit slot filled through the command route show without a reload", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors = consoleErrors(page);
  const [ox, oy, oz] = scene;
  // The object stands at the scene's centre (metres: cells × 0.5); the world's cell 0 is the world origin.
  const id = String((await playCmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Slice world', transform: { position: [ox / 2, oy / 2, oz / 2] } }))['createdId']);
  await page.goto(editorUrlFor(be.editorUrl, 'webgpu'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  const voxels = async (): Promise<SceneViewVoxels | null> => JSON.parse((await view.getAttribute('data-voxels')) ?? 'null') as SceneViewVoxels | null;
  // Orbit the object (F): the world will stream round that point.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await page.keyboard.press('f');
  const bare = await sceneViewStill(page, 'scene-view-bare');

  // The object names the world: it streams in and draws, with no reload.
  await page.evaluate(() => ((window as unknown as { __notReloaded: boolean }).__notReloaded = true));
  await playCmd('setComponent', { entityId: id, component: 'voxelWorld', value: { world: 'slice' } });
  await expect.poll(async () => { const v = await voxels(); return v?.states['slice']?.settled === true && (v.worlds['slice']?.chunks ?? 0) > 20; }, { timeout: 60_000, message: 'the world is streamed and drawn in the Scene view' }).toBe(true);
  const world = await sceneViewStill(page, 'scene-view-world');
  expect(changedPixels(bare, world)).toBeGreaterThan(20_000);
  const drawn = (await voxels())!;
  expect(drawn.problems).toEqual({});
  expect(drawn.worlds['slice']!.kitInstances, 'kit pieces drawn').toBeGreaterThan(5);

  // A 3 m pit dug through the command route (as MCP sends it): the view reads the changed chunks again and shows it.
  const before = drawn.states['slice']!.revision;
  const dig = await be.command({ op: 'editVoxels', projectId: be.projectId, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-voxel-scene-view' }, args: { world: 'slice', command: { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [6, 6, 6], points: [ox, oy, oz], mode: 'dig', smooth: false } } });
  expect(dig['ok'], JSON.stringify(dig)).toBe(true);
  expect(Number(dig['revision'])).toBe(before + 1);
  await expect.poll(async () => { const v = await voxels(); return v?.states['slice']?.revision === before + 1 && v.states['slice']!.settled && v.replaced > drawn.replaced; }, { timeout: 30_000, message: 'the edit is read again and drawn' }).toBe(true);
  const dug = await sceneViewStill(page, 'scene-view-dug');
  expect(changedPixels(world, dug)).toBeGreaterThan(500);
  expect(await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded)).toBe(true);

  // A kit slot filled through the command route (as MCP sends it): the view takes the new piece table, the chunks whose
  // pieces it changes derive again, and the slot's pieces (the stone walls' top edges) draw without a reload; set back, they go.
  const kitCmd = async (kit: Record<string, unknown>): Promise<void> => {
    const r = await be.command({ op: 'setVoxelKit', projectId: be.projectId, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-voxel-scene-view' }, args: { kit } });
    expect(r['ok'], JSON.stringify(r)).toBe(true);
  };
  const pieces = async (): Promise<number> => (await voxels())?.worlds['slice']?.kitInstances ?? 0;
  const plain = await pieces();
  await kitCmd({ ...stoneKit, slots: { ...stoneKit.slots, 'edge-out-top': { meshes: [{ mesh: stoneMesh }] } } });
  await expect.poll(pieces, { timeout: 30_000, message: 'the filled slot draws in the Scene view' }).toBeGreaterThan(plain);
  const slotted = await sceneViewStill(page, 'scene-view-kit-slot');
  expect(changedPixels(dug, slotted)).toBeGreaterThan(100);
  await kitCmd(stoneKit);
  await expect.poll(pieces, { timeout: 30_000, message: 'the emptied slot draws nothing again' }).toBe(plain);
  expect(changedPixels(dug, await sceneViewStill(page, 'scene-view-kit-back'))).toBeLessThan(50);
  expect(await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded)).toBe(true);

  // The renderer's CPU ms a frame while the view orbits (60 frames), with the world and, once its object goes, without.
  const orbit = async (): Promise<string | null> => {
    const box = (await view.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.15);
    await page.mouse.down();
    for (let i = 1; i <= 61; i++) {
      await page.mouse.move(box.x + box.width * 0.2 + i * 4, box.y + box.height * 0.15);
      await page.evaluate(() => new Promise((ok) => requestAnimationFrame(ok)));
    }
    await page.mouse.up();
    return view.getAttribute('data-render-ms');
  };
  const withWorld = await orbit();
  // The object goes: so does the world's draw (and the project is as the other tests left it; Play's world, 8 km out
  // and all air round this view, may still stream).
  await playCmd('deleteEntity', { entityId: id });
  await expect.poll(async () => { const v = await voxels(); return v === null || (v.worlds['slice'] === undefined && v.states['slice'] === undefined); }, { timeout: 10_000 }).toBe(true);
  const without = await orbit();
  console.log(`[voxel-scene-view] render() CPU ms p50 p95 (orbit, 30 frames): with the world ${withWorld}, without ${without}; drawn ${JSON.stringify(drawn.worlds)}`);
  expect(errors).toEqual([]);
});

// ---- The export plays the world with no backend ------------------------------------------------------------------
// This test halts the file's one backend (an export is checked with the backend stopped): it stays the file's last test.

test('Export: the Play project exported and served statically with the backend stopped streams its world from the shipped region files, draws it and its wall marks, stands the character on it, and a console dig opens the pit', async ({ page }) => {
  test.setTimeout(180_000);
  const at = await playProject();
  // The debug console takes the dig (the test's way to drive the script, as Play's debug command).
  await playCmd('setSettings', { settings: { debug_console: 1 } });
  const exported = await be.admin(`projects/${be.projectId}/export`);
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
  const out = join(be.exportRoot, String(exported.json.outputDir));
  // The catalog lists the world and its region files, each shipped whole at its content path.
  const shipped = (exportedContent(out) as unknown as { voxelWorlds?: Array<{ world: string; files: Array<{ name: string; digest: string; byteLength: number }> }> }).voxelWorlds ?? [];
  expect(shipped.map((w) => w.world)).toEqual(['far']);
  const regionPaths = new Set(shipped[0]!.files.map((f) => `content/sha256/${f.digest}`));
  const regionBytes = shipped[0]!.files.reduce((n, f) => n + f.byteLength, 0);
  // The far world is the slice's 128 m square (256 cells of 0.5 m).
  const km2 = (256 * 0.5 / 1000) ** 2;
  console.log(`[voxel-export] far: ${shipped[0]!.files.length} region files, ${regionBytes} bytes = ${(regionBytes / km2 / 1e6).toFixed(2)} MB a km² (world ${km2} km²); voxel worker ${String((exported.json.files as Record<string, number>)['js/voxel-worker.js'])} bytes`);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const game = await page.context().newPage();
  await game.setViewportSize({ width: 1280, height: 720 });
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  game.on('console', (m) => void (m.type() === 'error' && errors.push(m.text())));
  // Every request stays inside the export's folder; the region files are read once each (whole).
  const requests: string[] = [];
  page.context().on('request', (r) => requests.push(r.url()));
  try {
    const t0 = Date.now();
    await game.goto(`${site.url}${exportQueryFor('webgpu')}`);
    const canvas = game.locator('canvas#game');
    await expectRendererBackend(canvas, 'webgpu');
    type Obs = { state?: string; counters?: Record<string, number>; player?: { x: number; y: number; z: number } } | null;
    const observe = (): Promise<Obs> => game.evaluate(() => (window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Promise<Obs>;
    const drawn = (): Promise<number> => game.evaluate(() => (window as unknown as { __tlVoxelPlay?: { stats(): { worlds: Record<string, { chunks: number }> } } }).__tlVoxelPlay?.stats().worlds['far']?.chunks ?? 0);
    await expect.poll(async () => (await observe())?.counters?.['resident'] ?? 0, { timeout: 60_000, message: 'the pit is resident in the export' }).toBe(1);
    const residentMs = Date.now() - t0;
    // The cold fill: until the drawn chunks stop growing for a second.
    let chunks = 0;
    let grewAt = Date.now();
    await expect.poll(async () => {
      const n = await drawn();
      if (n !== chunks) [chunks, grewAt] = [n, Date.now()];
      return chunks > 20 && Date.now() - grewAt > 1000;
    }, { timeout: 60_000, intervals: [100], message: 'the world is drawn round the camera' }).toBe(true);
    const fillMs = grewAt - t0;
    await expect.poll(async () => { const y = (await observe())?.player?.y ?? -1e9; return y > at[1] && y < at[1] + 1.2; }, { timeout: 20_000, message: 'the character stands on the pad' }).toBe(true);
    // The kit's GLB came with the build's content files (the backend is stopped) and draws; the default kit's pieces too.
    const play = (): Promise<{ kits: Record<string, string>; kitInstances: number }> => game.evaluate(() => { const h = (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay; return { kits: h.kits(), kitInstances: h.stats().worlds['far']?.kitInstances ?? 0 }; });
    await expect.poll(async () => Object.values((await play()).kits), { timeout: 20_000 }).toEqual(['ready']);
    expect((await play()).kitInstances).toBeGreaterThan(5);
    const threading = await game.evaluate(() => (window as unknown as { __thirdlightThreading?: { mode: string } }).__thirdlightThreading?.mode ?? null);
    console.log(`[voxel-export] cold fill (page load → drawn chunks steady): ${fillMs} ms, ${chunks} chunks; pit resident at ${residentMs} ms; simulation ${String(threading)}`);
    const standing = (await observe())!.player!;
    // Both wall marks in the export too: the decal materials from the build, the clipped one cut from the wall's chunk.
    let marks = [0, 0];
    await expect.poll(async () => {
      const img = decodePng(await canvas.screenshot());
      marks = [hueCount(img, 'red'), hueCount(img, 'blue')];
      return marks.every((m) => m > 200);
    }, { timeout: 20_000, message: 'both wall marks are drawn in the export' }).toBe(true);
    console.log(`[voxel-export] wall marks: projected red ${marks[0]} px, clipped blue ${marks[1]} px`);
    const before = decodePng(await canvas.screenshot({ path: test.info().outputPath('export-before.png') }));
    await canvas.click();
    await game.keyboard.press('Backquote');
    await game.getByLabel('debug console command').fill('dig');
    await game.getByLabel('debug console command').press('Enter');
    await expect(game.locator('.tl-console')).toContainText(/ran dig/);
    await game.keyboard.press('Backquote');
    await expect.poll(async () => (await observe())?.counters?.['dug'] ?? 0, { timeout: 30_000 }).toBe(1);
    expect((await observe())?.counters?.['refused'] ?? 0).toBe(0);
    await expect.poll(async () => standing.y - ((await observe())?.player?.y ?? standing.y), { timeout: 10_000, message: 'the character falls into the pit' }).toBeGreaterThan(1);
    const after = decodePng(await canvas.screenshot({ path: test.info().outputPath('export-after.png') }));
    expect(changedPixels(before, after)).toBeGreaterThan(500);
    const edits = await game.evaluate(() => (window as unknown as { __tlVoxelPlay?: { edits(): unknown[] } }).__tlVoxelPlay?.edits() ?? null);
    console.log(`[voxel-export] edit→screen ${JSON.stringify(edits)}`);
    const outside = requests.filter((u) => !u.startsWith(site.url) && !u.startsWith('about:') && !u.startsWith('data:') && !u.startsWith('blob:'));
    expect(outside).toEqual([]);
    const regionReads = requests.filter((u) => regionPaths.has(u.slice(site.url.length)));
    console.log(`[voxel-export] requests ${requests.length}, region file reads ${regionReads.length} of ${regionPaths.size} files`);
    expect(regionReads.length).toBeGreaterThan(0);
    expect(new Set(regionReads).size).toBe(regionReads.length);
    expect((await observe())?.state).toBe('running');
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
