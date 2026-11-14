/**
 * A project's voxel world in the real page against the real backend, on
 * WebGPU (WebGL 2's voxel page is webgl2-smoke.e2e.ts's): the voxel world page streams the world's region
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
 * falls into it, with the simulation in its worker; each edit's way from
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
 * The stone is a material record with a voxel use (its kit the test kit),
 * beside a mesh-only material: the voxel world page's picker lists only the
 * stone; in the Scene view the stone's colour and tile set through the
 * Inspector rewrite the world's material table (no chunk derived or meshed
 * again) and change the picture, its badges show in the project window and
 * `f:` filters by them; the export ships the stone though only the world's
 * cells name it.
 *
 * Everything is derived per section (the page's default section edge) and
 * drawn per storage chunk (the sections joined): a blast dug at a chunk
 * corner, locally (a game's runtime edit) and as a command, swaps every
 * section's collider and every chunk's draw it rebuilt in one frame (no
 * frame shows part of it), and reads see the dug cells in the same task as
 * the edit.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { glbBytes, pngBytes } from '@thirdlight/shared';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { decodePng, changedPixels } from './png';
import { expect, test, type Page } from './pw';
import { exportedContent, serveDir, startBackend, type E2EBackend } from './backend';
import { consoleErrors } from './console-errors';
import { editorUrlFor, expectRendererBackend, exportQueryFor } from './renderer-variants';
import { chooseItem, closeMenu, inspector, menuItem } from './ui';
import { writeSliceWorld } from '../../tools/voxel-bench/slice-world';
import { MAT } from '../../tools/voxel-bench/world-kit';
import { placeholderPng, placeholderSet } from '../../tools/voxel-bench/texture-sets';
import { DEFAULT_QUALITY_LEVELS } from '@thirdlight/project-model';
import { canonicalEditCommand, chunkGrid, cubeRotationIndex, dependentChunks, editBounds, jobRadius, kitTestScene, WORLD_RULES, sectionGrid, VOXEL_ROLE, VOXEL_SIZE_M, type SectionEdge } from '@thirdlight/voxel';
import { mustCommand } from '../support/commands';

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
  // The stone's material record: a voxel material bound to the test kit (so the binding, and every picture, is as
  // the kit's own list made it); and a material for meshes only, which voxel tools never list.
  await playCmd('setMaterial', { material: STONE_MATERIAL });
  await playCmd('setMaterial', { material: { materialId: 'mat-crate-paint', name: 'Crate paint', shader: 'standard', params: { color: '#a07040' }, textures: {} } });
});

/**
 * The test kit's id: end boards up the stone wall's free ends from a GLB (clear of the rows the tests paint and
 * dig, so their pictures compare the surface). It binds stone and the two materials the wall is painted with below
 * (brick, plank), so those paints stay within one kit (shader data only); every other material draws plain voxel
 * faces.
 */
const STONE_KIT = 'stone-test';

/** The stone's material record as set up (no colour or tile of its own: it draws its stand-in look). */
const STONE_MATERIAL = { materialId: 'mat-stone-voxel', name: 'Stone (voxel)', shader: 'standard', params: {}, textures: {}, voxel: { id: MAT.stone, use: 'construction', kit: STONE_KIT } };
/** The test kit's record as set up, and its one mesh (the Scene view test fills another slot with it and sets the kit back). */
let stoneKit: { slots: Record<string, unknown> } & Record<string, unknown>;
let stoneMesh: { assetId: string; digest: string };

/**
 * A voxel kit for the stone material with one authored piece, an outside vertical edge's board (the free ends'
 * corners): a GLB (a 0.1 × 0.5 × 0.6 m box standing proud of the end face, 12 triangles, its one material the kit's
 * sheet: a 16² magenta-and-white PNG inside the file, 1 texture of 16², no LODs) written into the project and
 * imported as every model is (its image extracted into a KTX2 texture asset), named by its version's digest. The free ends' top corners draw the same
 * board through an alias (the vertical edge's mesh turned a quarter about z onto the top), clear of the painted rows.
 */
async function addStoneKit(): Promise<void> {
  const box = new THREE.BoxGeometry(0.1, VOXEL_SIZE_M, 0.6).translate(VOXEL_SIZE_M / 2 + 0.02, 0, 0);
  const parts = [box.getAttribute('position'), box.getAttribute('normal'), box.getAttribute('uv')].map((a) => new Uint8Array((a.array as Float32Array).slice().buffer));
  const index = new Uint8Array(Uint16Array.from(box.index!.array as ArrayLike<number>).buffer);
  // The kit's sheet: magenta with a white line every fourth row (nothing else in the scene is magenta).
  const SHEET = 16;
  const rows = new Uint8Array(SHEET * (SHEET * 3 + 1));
  for (let y = 0; y < SHEET; y++) for (let x = 0; x < SHEET; x++) rows.set(y % 4 === 0 ? [255, 255, 255] : [230, 30, 230], y * (SHEET * 3 + 1) + 1 + x * 3);
  const sheet = pngBytes({ width: SHEET, height: SHEET, bitDepth: 8, colorType: 2, idat: new Uint8Array(deflateSync(rows)) });
  const pad = (b: Uint8Array): Uint8Array => (b.length % 4 === 0 ? b : new Uint8Array([...b, ...new Uint8Array(4 - (b.length % 4))]));
  const chunks = [...parts, index, sheet].map(pad);
  const bin = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  const views = chunks.map((b, i) => {
    bin.set(b, at);
    const v = { buffer: 0, byteOffset: at, byteLength: i === 4 ? sheet.length : b.length, ...(i < 4 ? { target: i < 3 ? 34962 : 34963 } : {}) };
    at += b.length;
    return v;
  });
  box.computeBoundingBox();
  const n = box.getAttribute('position').count;
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'End board', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'stone-sheet', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } }],
    images: [{ name: 'stone-sheet', mimeType: 'image/png', bufferView: 4 }],
    samplers: [{ magFilter: 9728, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    textures: [{ sampler: 0, source: 0 }],
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
  // The model and the texture its image was extracted into.
  const listed = (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 100, offset: 0, includeVersions: true } })) as unknown as { assets: { assetId: string; textures?: Record<string, string>; versions?: { sourcePath?: string; sourceDigest?: string }[] }[] };
  // The model's version is the file with its image extracted (a stand-in left inside): the kit names that version's digest.
  const model = listed.assets.find((a) => a.assetId === 'stone-end');
  if (model === undefined) throw new Error(`the kit's GLB is not among the assets: ${JSON.stringify(listed.assets.map((a) => [a.assetId, a.versions]))}`);
  const assetId = model.assetId;
  const digest = model.versions![0]!.sourceDigest!;
  console.log(`[voxel kit] ${STONE_KIT}: end board GLB ${glb.length} bytes, ${box.index!.count / 3} triangles, sheet ${SHEET}² PNG ${sheet.length} bytes inside (extracted: ${JSON.stringify(model.textures ?? {})}, imported ${imported.change.added.length})`);
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

/**
 * The assembly proof, on a page `open` left at the scene's view (WebGPU): runtime set/dig turn a banister into a wall
 * and a beam into a stub across chunk faces; every consumer, collision included, follows; round trips. It leaves the
 * world as the generator wrote it but for one dug pad cell, and the page at the same view; its one refused command
 * (409) is in `errors`.
 */
async function assemblyProof(page: Page, errors: string[]): Promise<void> {
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
  await open(page, 'webgpu', '&bands=1');
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
}

{
  // WebGPU only: WebGL 2's voxel page is webgl2-smoke.e2e.ts's. The assembly proof runs first on the same page load.
  const renderer = 'webgpu';
  test('assembly proof (runtime set/dig turn a banister into a wall and a beam into a stub across chunk faces; every consumer, collision included, follows; round trips), then streams, draws and edits the voxel world through commands; the edit is in the files after a backend restart and a reload; fine far bricks', async ({ page }) => {
    // Fine far bricks build over frames on the GPU after the rest (~30 s of the page's own frames under the gate's load).
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 960, height: 540 });
    const errors = consoleErrors(page);
    // Construction drawn with the band test texture (the pictures below compare with each other, a reload's too).
    await open(page, renderer, '&bands=1');
    await assemblyProof(page, errors);
    const state = await hook<{ drawn: number; triangles: number; pieces: number; counters: { damaged: number } }>(page, 'state');
    expect(state.drawn).toBeGreaterThan(20);
    // The material picker lists the project's voxel materials only (not the mesh-only one); shift-click adds the stone.
    const picker = await hook<{ entries: { id: number; materialId: string }[]; picked: number; options: string[] }>(page, 'materials');
    expect(picker.entries.map((m) => [m.id, m.materialId])).toEqual([[MAT.stone, 'mat-stone-voxel']]);
    expect([picker.picked, picker.options]).toEqual([MAT.stone, ['Stone (voxel) · 10 · construction']]);
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
    // The board wears the kit's sheet: its GLB's material, the image drawn from the texture asset the import made.
    expect(Object.values(kitState.kits.meshes)).toEqual([expect.stringMatching(/^ready, sheet \S+/)]);
    expect(kitState.kitPieces).toBeGreaterThan(5);
    // And the screen shows it: the boards at the free end in the sheet's magenta (the debug texture and the stand-in
    // colours have none).
    const sheetPx = hueCount(await shot(page), 'magenta');
    console.log(`[voxel kit] ${renderer}: sheet pixels on the boards ${sheetPx}`);
    expect(sheetPx).toBeGreaterThan(40);
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

    // A click digs at the cell under the pointer (the page's picker): seen straight on, the wall's rows at the middle of
    // the page; one of the cells there that was stone is air after the click, and the undo brings them back.
    await hook(page, 'look', ox, oy + 4, oz + 1, 0, 0, 4);
    await hook(page, 'settle');
    const row = [-1, 0, 1].map((dz): Cell => [ox, oy + 4, oz + dz]);
    const solid = async (): Promise<boolean[]> => Promise.all(row.map(async (c) => (await hook<{ material: number }>(page, 'voxelAt', ...c)).material !== 0));
    const wasSolid = await solid();
    expect(wasSolid.some((v) => v)).toBe(true);
    const viewport = page.viewportSize()!;
    // The picker reads the meshes drawn: two frames after the look.
    await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
    await expect.poll(async () => (await solid()).some((v, i) => wasSolid[i] && !v), { message: 'a click digs the wall under the pointer' }).toBe(true);
    expect((await hook<EditAnswer>(page, 'undo')).ok).toBe(true);
    expect(await solid()).toEqual(wasSolid);
    await hook(page, 'look', ox, oy + 3, oz + 2, -0.75, 0.42, 16);
    await hook(page, 'settle');

    // A row of the wall the edits above left whole.
    const cell: Cell = [scene[0], scene[1] + 4, scene[2]];
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
    // A run that finds the wall brick (a run before it in the same files left it so, wet) paints it back to light stone: plank's
    // stand-in swatch is as dark as wet brick, so brick → plank there would measure a colour coincidence, not the paint.
    const material = was === MAT.brick ? MAT.stone : MAT.brick;
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

    // A restarted backend and a reload (the assembly proof reloaded the page alone and compared every derived hash):
    // the same picture as before, from the region files (the view and the world are the same).
    await be.restart();
    await page.reload();
    await open(page, renderer, '&bands=1');
    expect((await hook<{ material: number }>(page, 'voxelAt', ...cell)).material).toBe(0);
    expect(changedPixels(shown, await shot(page))).toBeLessThan(200);

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
    // The far field: the backend built the world's far cache on the first read, and its nodes draw under the near
    // field, as ray-marched bricks by default (no triangles).
    await hook(page, 'settleFar');
    const far = (await hook<{ far: { problem: string | null; draw: string; drawnNodes: number; draws: number; bricks: number; triangles: number } | null }>(page, 'state')).far;
    expect(far, 'the far field').not.toBeNull();
    expect(far!.problem).toBeNull();
    expect(far!.drawnNodes).toBeGreaterThan(0);
    expect([far!.draw, far!.triangles]).toEqual(['bricks', 0]);
    expect(far!.bricks).toBeGreaterThan(0);
    // Background pixels below the horizon everywhere across the picture (it sits at 0.55–0.57 of the height at the left edge).
    const skyBelow = (p: Awaited<ReturnType<typeof shot>>): number => {
      let n = 0;
      for (let y = Math.floor(p.height * 0.62); y < p.height; y++) for (let x = 0; x < p.width; x++) {
        const [r, g, b] = p.pixel(x, y);
        if (Math.abs(r - 0x9f) <= 8 && Math.abs(g - 0xc4) <= 8 && Math.abs(b - 0xe8) <= 8) n++;
      }
      return n;
    };
    expect(skyBelow(await shot(page)), 'background pixels below the horizon').toBe(0);
    // The far field switched to its mesh fallback at run time: the same nodes made again as meshes, swapped in, and
    // still no background below the horizon.
    await hook(page, 'setFar', { mode: 'mesh' });
    await hook(page, 'settleFar');
    const meshes = (await hook<{ far: { problem: string | null; draw: string; bricks: number; triangles: number } }>(page, 'state')).far;
    expect(meshes.problem).toBeNull();
    expect([meshes.draw, meshes.bricks]).toEqual(['mesh', 0]);
    expect(meshes.triangles).toBeGreaterThan(0);
    expect(skyBelow(await shot(page)), 'background pixels below the horizon (meshes)').toBe(0);
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
    await fineBricks(page, yaw, ox, oy, oz, skyBelow);
    // The assembly proof's refused command (its HTTP 409) is the one console error.
    expect(errors).toHaveLength(1);
  });
}

/** Mean colour step between neighbouring pixels (x and y) where `mask` holds: how much detail a surface shows. */
function detailIn(img: ReturnType<typeof decodePng>, mask: (x: number, y: number) => boolean): { detail: number; pixels: number } {
  let sum = 0;
  let n = 0;
  for (let y = 0; y + 1 < img.height; y++) for (let x = 0; x + 1 < img.width; x++) {
    if (!mask(x, y) || !mask(x + 1, y) || !mask(x, y + 1)) continue;
    const p = img.pixel(x, y);
    const r = img.pixel(x + 1, y);
    const d = img.pixel(x, y + 1);
    for (let c = 0; c < 3; c++) sum += Math.abs(p[c]! - r[c]!) + Math.abs(p[c]! - d[c]!);
    n++;
  }
  return { detail: n === 0 ? 0 : sum / n, pixels: n };
}

/**
 * Fine far bricks textured as the near surface draws its own: the ground's material given a texture set (a record
 * change on the backend, read again by the page) reaches the fine bricks with no rebuild (their samples hold look
 * words; the colours and sets are read when shaded), their pixels gain the set's detail, and with texturing off (a
 * comparison at run time, no new program) the same pixels lose it again. `shown` and `nearOnly`: the view with and
 * without the far draws (the far pixels are where they differ); `built` the fine builds so far.
 */
async function fineTextured(page: Page, shown: ReturnType<typeof decodePng>, nearOnly: ReturnType<typeof decodePng>, built: number): Promise<void> {
  const far = (x: number, y: number): boolean => {
    const a = shown.pixel(x, y);
    const b = nearOnly.pixel(x, y);
    return Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) > 60;
  };
  await groundRelief(true);
  try {
    await hook(page, 'readMaterials');
    type Textures = { textures: { current: boolean; layers: number } };
    await expect.poll(async () => { const t = (await hook<Textures>(page, 'state')).textures; return t.current && t.layers > 0; }, { timeout: 30_000, message: 'the ground\'s texture set drawn' }).toBe(true);
    await hook(page, 'settle');
    const textured = await shot(page);
    const st = await hook<FineState>(page, 'state');
    expect(st.far.fineBuild!.built, 'the record reached the fine bricks with no rebuild').toBe(built);
    await hook(page, 'setFar', { fineTextured: false });
    const plain = await shot(page);
    await hook(page, 'setFar', { fineTextured: true });
    const t = detailIn(textured, far);
    const f = detailIn(plain, far);
    console.log(`fine textured: far pixels ${t.pixels}, detail textured ${t.detail.toFixed(2)} vs palette ${f.detail.toFixed(2)}, fade ${JSON.stringify(st.far.fineBuild!.fadeM)} (${st.far.fineBuild!.texture})`);
    expect(t.pixels, 'far pixels compared').toBeGreaterThan(2000);
    // Detail, not a colour step: a set's mips keep its mean, the palette's colour (measured 14.0 vs 1.9 a pixel step;
    // pixels apart by 20 or more: about a hundred).
    expect(t.detail, 'the fine bricks show the set\'s detail').toBeGreaterThan(1.5 * f.detail);
  } finally {
    await groundRelief(false);
    await hook(page, 'readMaterials');
  }
}

/** What the page reports of its fine far bricks (`state().far`). */
interface FineState {
  levels: number[];
  far: {
    problem: string | null;
    drawnNodes: number;
    fine: { on: boolean; made: number; edits: number; drawn: number[] };
    fineBuild: { built: number; bricks: number; pending: number; held: number; drawn: number[]; checks: Array<{ node: string; sameBricks: boolean; bricks: number; roofs: number; samples: number; distanceDiffer: number; distanceMax: number; boundsDiffer: number; lookDiffer: number; occlusionDiffer: number; occlusionMax: number }>; texture: string | null; fadeM: [number, number] | null } | null;
  };
}

/**
 * Fine far bricks (WebGPU): levels 0–1 past the detail ring built on the GPU from the streamed chunks, the near field
 * drawing its level-0 ring only; the GPU build against the CPU build of the same blocks; the band past the detail ring
 * is theirs (hidden, the sky shows there); a dig there shows; off, the near field's levels come back.
 */
async function fineBricks(page: Page, yaw: number, ox: number, oy: number, oz: number, skyBelow: (p: Awaited<ReturnType<typeof shot>>) => number): Promise<void> {
  await hook(page, 'setFar', { mode: 'bricks' });
  await hook(page, 'settleFar');
  // Every node this small world builds is checked (up to the 64 checks the page keeps): which nodes are built first
  // depends on the host's load, and a check of the first few compared different blocks run to run.
  await hook(page, 'checkFine', 64);
  await hook(page, 'setFar', { fine: true });
  const built = async (): Promise<FineState> => {
    await hook(page, 'settle');
    await hook(page, 'settleFar');
    // The page builds what the far field sent over the next frames; settled when nothing waits there either.
    let st = await hook<FineState>(page, 'state');
    for (let i = 0; i < 1200 && !(st.far.fineBuild !== null && st.far.fineBuild.pending === 0 && st.far.fineBuild.held === 0); i++) {
      await page.waitForTimeout(100);
      st = await hook<FineState>(page, 'state');
    }
    expect(st.far.fineBuild, JSON.stringify({ levels: st.levels, fine: st.far.fine, build: st.far.fineBuild })).toMatchObject({ pending: 0, held: 0 });
    return st;
  };
  const on = await built();
  expect(on.far.problem).toBeNull();
  expect(on.far.fine.on).toBe(true);
  expect(on.levels.slice(1).every((n) => n === 0), `near levels drawn ${on.levels.join(', ')}`).toBe(true);
  expect(on.levels[0]).toBeGreaterThan(0);
  const b = on.far.fineBuild!;
  expect(b.drawn[0]! + b.drawn[1]!, 'fine nodes drawn').toBeGreaterThan(0);
  expect(b.bricks).toBeGreaterThan(0);
  // The GPU build against the CPU build of the same blocks: the same bricks stored, every distance byte within one
  // (32-bit rounding at the ties part-full fills make), looks and occlusion as the design says.
  expect(b.checks.length).toBeGreaterThan(0);
  const sum = (k: 'samples' | 'distanceDiffer' | 'lookDiffer' | 'occlusionDiffer' | 'boundsDiffer' | 'bricks'): number => b.checks.reduce((n, c) => n + c[k], 0);
  console.log(`fine check (${b.built} built): ${JSON.stringify(b.checks)}`);
  expect(b.checks.length, 'every node built checked').toBe(Math.min(b.built, 64));
  for (const c of b.checks) {
    expect(c.sameBricks, c.node).toBe(true);
    expect(c.distanceMax, c.node).toBeLessThanOrEqual(1);
  }
  expect(sum('distanceDiffer') / sum('samples'), 'distance bytes off by one').toBeLessThan(0.02);
  // One rule for a sample with no shown cell in reach (the nearest look in its brick): the looks agree (0 of ~490,000
  // samples measured; a distance byte a rounding apart can still move which cells show).
  expect(sum('lookDiffer') / sum('samples'), 'looks apart').toBeLessThan(0.005);
  expect(Math.max(...b.checks.map((c) => c.occlusionMax)), 'occlusion').toBeLessThanOrEqual(3);
  // Past the detail ring the fine bricks draw (in this small world nearly every far node drawn is a fine one): ground
  // below the horizon everywhere, and their pixels gone with the far draws hidden.
  expect(b.drawn[0]! + b.drawn[1]!, `fine of ${on.far.drawnNodes} far nodes drawn`).toBeGreaterThan(0.9 * on.far.drawnNodes);
  const shown = await shot(page);
  expect(skyBelow(shown), 'background below the horizon with fine bricks').toBe(0);
  await hook(page, 'showFar', false);
  const nearOnly = await shot(page);
  expect(changedPixels(shown, nearOnly), 'pixels the fine bricks draw').toBeGreaterThan(2000);
  await hook(page, 'showFar', true);
  await fineTextured(page, shown, nearOnly, b.built);
  // A dig past the detail ring, where fine bricks draw it: the camera 120 m out from the focus, the dig 54 m out on its
  // way (past the near field's level-0 ring and the chunks it stands in for, in view below the focus); the nodes over
  // it are built again and it shows.
  await hook(page, 'look', ox, oy, oz, yaw, 0.3, 120);
  await built();
  const px = Math.round(ox + (Math.sin(yaw) * 54) / 0.5);
  const pz = Math.round(oz + (Math.cos(yaw) * 54) / 0.5);
  const top = await hook<number | null>(page, 'surfaceAt', px, pz, oy + 40, oy - 40);
  expect(top, 'ground 54 m out').not.toBeNull();
  const pit: [number, number, number] = [px, top! - 1, pz];
  expect(await hook<number | null>(page, 'levelAt', ...pit), 'not drawn by the near field').toBeNull();
  // The far field's own solid there (the GPU's bricks read back): ground before, air after.
  const under = [px, top! - 3, pz] as const;
  expect(await hook<{ level: number; inside: boolean } | null>(page, 'farSolidAt', ...under)).toMatchObject({ inside: true });
  const before = await shot(page);
  expect((await hook<{ ok: boolean }>(page, 'blast', pit, 3, 'local')).ok).toBe(true);
  const dug = await built();
  expect(dug.far.fine.edits).toBeGreaterThan(on.far.fine.edits);
  expect(dug.far.fineBuild!.built).toBeGreaterThan(b.built);
  const solid = await hook<{ level: number; inside: boolean } | null>(page, 'farSolidAt', ...under);
  expect(solid, 'a fine node over the dig').toMatchObject({ inside: false });
  expect(solid!.level).toBeLessThan(2);
  expect(changedPixels(before, await shot(page)), 'a dig drawn by fine bricks').toBeGreaterThan(300);
  // A sloped roof past the detail ring (a 45° gable of roof cells, one a column, laid at run time beside the pit): the
  // nodes over it are built again, their GPU builds checked against the CPU build (the roof mesher's planes in both),
  // and the far solid there is the roof's slab, not the stair: a point above a stair cell and under the plane is inside.
  const [gx, gz] = [px + 12, pz - 4];
  const gy = (await hook<number | null>(page, 'surfaceAt', gx + 4, gz + 4, oy + 40, oy - 40))! + 6;
  const roof: number[] = [];
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) roof.push(gx + x, gy + Math.min(z + 1, 8 - z), gz + z);
  expect(await hook<number | null>(page, 'levelAt', gx, gy + 1, gz), 'the roof is not drawn by the near field').toBeNull();
  await hook(page, 'checkFine', 64);
  await hook(page, 'localEdit', { v: 2, grid: 0, kind: 'set', cells: roof, voxel: { material: MAT.stone, role: VOXEL_ROLE.roof, wetness: 0, shape: 15 } });
  const roofed = await built();
  const roofChecks = roofed.far.fineBuild!.checks.filter((c) => c.roofs > 0);
  console.log(`fine roof checks: ${JSON.stringify(roofChecks)}`);
  expect(roofChecks.length, 'fine builds over the roof checked').toBeGreaterThan(0);
  for (const c of roofChecks) {
    expect(c.sameBricks, c.node).toBe(true);
    expect(c.distanceMax, c.node).toBeLessThanOrEqual(1);
    expect(c.lookDiffer / c.samples, c.node).toBeLessThan(0.005);
  }
  // Row 1 of the gable: its stair cell spans gy + 2 … gy + 3, its plane rises from gy + 3 to gy + 4 across the row.
  expect(await hook<{ level: number; inside: boolean } | null>(page, 'farSolidAt', gx + 4.5, gy + 3.5, gz + 1.9), 'under the roof plane, over its stair').toMatchObject({ inside: true });
  expect(await hook<{ level: number; inside: boolean } | null>(page, 'farSolidAt', gx + 4.5, gy + 4.6, gz + 1.5), 'over the roof plane').toMatchObject({ inside: false });
  // Off, at the first view again: the near field's levels 1 and 2 come back, the far field's level 2 past them.
  await hook(page, 'look', ox, oy + 3, oz + 2, yaw, 0.18, 30);
  await hook(page, 'setFar', { fine: false });
  await hook(page, 'settle');
  await hook(page, 'settleFar');
  const off = await hook<FineState>(page, 'state');
  expect(off.far.fine.on).toBe(false);
  expect(off.levels[1], 'level 1 drawn again').toBeGreaterThan(0);
  expect(skyBelow(await shot(page)), 'background below the horizon with fine bricks off').toBe(0);
}

// ---- Play: the world runs with the simulation ----------------------------------------------------------------

/** `sameIsFine`: an edit that changes nothing (`no_change`, e.g. after a test that stopped before undoing it) is done. */
async function playCmd(op: string, args: Record<string, unknown>, sameIsFine = false): Promise<Record<string, unknown>> {
  return mustCommand(be, op, args, { clientId: 'e2e-voxel-play', noChangeIsDone: sameIsFine });
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
/** The play world's object (made with the play project). */
let playWorld: string | null = null;

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
function hueCount(img: ReturnType<typeof decodePng>, hue: 'red' | 'blue' | 'magenta'): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    // Magenta: the test kit's sheet (red and blue alike, little green).
    if (hue === 'magenta' ? r > 90 && b > 90 && Math.abs(r - b) < 0.35 * Math.max(r, b) && g < 0.45 * Math.min(r, b) : hue === 'red' ? r > 100 && r >= 2.2 * g && r >= 2.2 * b : b > 100 && b >= 1.6 * g && b >= 2.5 * r) n += 1;
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
  const world = String((await playCmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'World', transform: { position: at }, components: { voxelWorld: { world: 'far', blendMetres: PLAY_BLEND_M, quality: { low: FAR_TEST_RINGS } } } }))['createdId']);
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
  playWorld = world;
  return (standAt = at);
}

/** The Play world's material blend (its `voxelWorld` object's, not the engine's default): Play and the export draw with it. */
const PLAY_BLEND_M = 0.2;

/** The ground's texture set (its albedo and normal map assets, imported once). */
let groundSet: { albedo: string; normal: string } | null = null;

/**
 * The pad's grass as a voxel material with a texture set whose normal map carries heights (the placeholder grass set,
 * 256²) at the deepest height depth, so relief near the camera moves visibly (Play and the export draw it at the
 * high tier). No tier displaces by default, so the project's levels are the engine's with relief asked for at high
 * (`voxelRelief`, 4 steps a cell); `false` deletes the record and the levels again, so the Scene view's test sees
 * the stone alone at the engine's levels.
 */
async function groundRelief(on: boolean): Promise<void> {
  if (!on) {
    await playCmd('deleteMaterial', { materialId: 'mat-grass-voxel' });
    await playCmd('setEnvironment', { environment: {} }, true);
    return;
  }
  await playCmd('setEnvironment', { environment: { qualityLevels: DEFAULT_QUALITY_LEVELS.map((l) => (l.id === 'high' ? { ...l, voxelRelief: 4 } : { ...l })) } }, true);
  if (groundSet === null) {
    const texDir = join(be.projectDir, 'assets', 'voxel-textures');
    mkdirSync(texDir, { recursive: true });
    const maps = placeholderSet('grass', 256);
    for (const map of ['albedo', 'normal'] as const) writeFileSync(join(texDir, `grass-${map}.png`), placeholderPng(maps[map], 256));
    await playCmd('importAssets', { folder: 'assets/voxel-textures' });
    const listed = (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 100, offset: 0 } })) as unknown as { assets: { assetId: string; sourcePath?: string }[] };
    const id = (map: string): string => listed.assets.find((a) => a.sourcePath === `assets/voxel-textures/grass-${map}.png`)!.assetId;
    groundSet = { albedo: id('albedo'), normal: id('normal') };
  }
  await playCmd('setMaterial', { material: { materialId: 'mat-grass-voxel', name: 'Grass (voxel)', shader: 'standard', params: {}, textures: {}, voxel: { id: MAT.grass, use: 'terrain', heightDepth: 0.25, surfaces: { wall: groundSet } } } });
}

interface PlayObservation { state?: string; stepIndex?: number; counters?: Record<string, number>; player?: { x: number; y: number; z: number } }
/** The page's frame profile as the e2e reads it (game-host page-profile.ts `ProfileReport`, the fields checked). */
interface ProfileFrameE2e { thread: string; frame: number; tick?: number; start: number; ms: number; byCategory: Record<string, number>; spans: Array<{ name: string; category: string; start: number; ms: number; selfMs: number; depth: number; lane?: number }>; dropped: number }
interface ProfileE2e {
  threads: { page: ProfileFrameE2e[]; sim: ProfileFrameE2e[]; jobs: ProfileFrameE2e[] };
  counters: { frames: Array<{ frame: number; drawCalls: number; triangles: number; heapBytes: number | null }>; stats: { drawCalls: number; triangles: number; quality: string } | null; queues: { workers: number; queued: number; inFlight: number } | null; voxels: { chunks: number } | null; memory?: { tier: string; rows: Array<{ id: string; resident: number | null; budget: number }> } };
  gpu: { timestamps: boolean; shares: unknown; room: string };
  budget: { tier: string; hz: number; intervalMs: number; rows: Array<{ thread: string; category: string; budgetMs: number; meanMs: number; worstMs: number; use: number | null }> };
  slices: Array<{ id: string; msNow: number | null }>;
  spikes: unknown[];
  cost: { pageSpansPerFrame: number; nsPerSpan: number };
}

/**
 * The editor's Profiler tab over a running Play (the 8 km world, the simulation in its worker, the high tier): the
 * timeline has bars in the page's, the simulation's and the job workers' lanes; a frame picked on it lists spans the
 * page's profile names; the Budget view is the tier's table; a capture saved from the tab is a version 1 file of the
 * same tier, and opened again it shows as a file. Pictures at 1280 × 720 and 1920 × 1080.
 */
async function profilerPanel(page: Page, pr: ProfileE2e, readProfile: () => Promise<ProfileE2e>): Promise<void> {
  await page.locator('.tl-dock--bottom > [role=tablist] [role=tab]', { hasText: 'Profiler' }).click();
  const panel = page.locator('.tl-prof');
  const timeline = panel.getByTestId('profiler-timeline');
  const bars = async (lane: string): Promise<number> => Number(await timeline.getAttribute(`data-${lane}-bars`));
  await expect.poll(() => bars('page'), { timeout: 15_000, message: 'the page lane has bars' }).toBeGreaterThan(30);
  await expect.poll(() => bars('sim'), { timeout: 10_000, message: 'the simulation lane has bars' }).toBeGreaterThan(10);
  expect(await bars('jobs')).toBeGreaterThan(0);
  await expect(panel.getByTestId('profiler-where')).toHaveText('Play running');
  // Pause, then pick a frame a few columns from the newest: the breakdown is that frame's.
  await panel.getByRole('button', { name: 'Pause' }).click();
  await expect(panel).toHaveAttribute('data-paused', 'true');
  const box = (await timeline.boundingBox())!;
  await timeline.click({ position: { x: box.width - 30, y: 24 } });
  const columns = Number(await timeline.getAttribute('data-columns'));
  const selected = Number(await timeline.getAttribute('data-selected'));
  expect(selected, 'a frame a few columns before the newest').toBeLessThan(columns - 1);
  expect(selected).toBeGreaterThan(columns - 12);
  const fresh = await readProfile();
  const known = new Set([pr, fresh].flatMap((r) => [...r.threads.page, ...r.threads.sim, ...r.threads.jobs].flatMap((f) => f.spans.map((x) => x.name))));
  const shown = await panel.getByTestId('profiler-breakdown').locator('tr[data-span-name]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-span-name')!));
  expect(shown).toContain('render frame');
  expect(shown.filter((n) => !known.has(n) && !/^tick \d+$/.test(n)), 'span names the profile does not have').toEqual([]);
  await page.screenshot({ path: test.info().outputPath('profiler-frame-1280.png') });
  // The tier's budget table: the high tier (60 Hz), the page's render row at its share of the frame.
  await panel.getByRole('tab', { name: 'Budget' }).click();
  const budget = panel.getByTestId('profiler-budget');
  await expect(budget).toHaveAttribute('data-tier', 'high');
  await expect(budget.locator('tr[data-thread="page"][data-category="render"] td').nth(1)).toHaveText((0.25 * (1000 / 60)).toFixed(2));
  expect(await budget.locator('tbody tr').count()).toBeGreaterThanOrEqual(pr.budget.rows.filter((r) => r.budgetMs > 0 && r.thread !== 'jobs').length);
  await page.screenshot({ path: test.info().outputPath('profiler-budget-1280.png') });
  // A capture file: version 1, the tier's header, the threads' frames.
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Save capture' }).click();
  const file = test.info().outputPath('capture.json');
  await (await download).saveAs(file);
  const capture = JSON.parse(readFileSync(file, 'utf8')) as { version: number; kind: string; header: { tier: string; source: string; renderer: string | null; build: string | null }; report: ProfileE2e };
  expect([capture.version, capture.kind, capture.header.tier, capture.header.source, capture.header.renderer]).toEqual([1, 'thirdlight-frame-profile', 'high', 'editor', 'webgpu']);
  expect(capture.header.build).toMatch(/^[0-9a-f]{64}$/);
  expect(capture.report.threads.page.length).toBeGreaterThan(30);
  expect(capture.report.threads.sim.length).toBeGreaterThan(10);
  // Opened again: the same views, marked as a file.
  await panel.getByTestId('profiler-open').setInputFiles(file);
  await expect(panel).toHaveAttribute('data-mode', 'file');
  await expect(panel.getByTestId('profiler-where')).toContainText('File capture.json');
  expect(Number(await timeline.getAttribute('data-columns'))).toBe(capture.report.threads.page.length);
  await panel.getByRole('tab', { name: 'Spikes' }).click();
  if (capture.report.spikes.length > 0) {
    await panel.getByTestId('profiler-spikes').getByRole('button', { name: 'Open' }).first().click();
    await expect(panel.getByTestId('profiler-breakdown').locator('tr[data-span-name]').first()).toBeVisible();
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await panel.getByRole('tab', { name: 'Frame' }).click();
  await page.screenshot({ path: test.info().outputPath('profiler-file-1920.png') });
  await panel.getByRole('tab', { name: 'Counters' }).click();
  await expect(panel.getByTestId('profiler-counters')).toContainText('draw calls');
  // The Memory table (the capture's): every budget of the tier's table, the voxel streamer's own count posted from
  // the simulation worker, the far field's GPU bytes counted, the page's sum.
  const memory = panel.getByTestId('profiler-memory');
  await expect(memory).toHaveAttribute('data-tier', 'high');
  expect(await memory.locator('tbody tr[data-id]').count()).toBe(capture.report.counters.memory!.rows.length);
  expect(Number(await memory.locator('tr[data-id="voxelStream"]').getAttribute('data-resident')), 'voxel streaming resident').toBeGreaterThan(0);
  expect(await memory.locator('tr[data-id="farGpu"]').getAttribute('data-resident'), 'far field GPU bytes counted').not.toBe('');
  expect(Number(await memory.locator('tr[data-total="page"]').getAttribute('data-resident'))).toBeGreaterThan(0);
  await memory.scrollIntoViewIfNeeded();
  await memory.screenshot({ path: test.info().outputPath('profiler-memory-1920.png') });
  await page.screenshot({ path: test.info().outputPath('profiler-counters-1920.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await panel.getByRole('button', { name: 'Back to live' }).click();
  await panel.getByRole('button', { name: 'Resume' }).click();
  await expect(panel).toHaveAttribute('data-mode', 'live');
  await page.locator('.tl-dock--bottom > [role=tablist] [role=tab]', { hasText: 'Project' }).click();
}

/** Own ms by category, summed over frames. */
const categorySum = (frames: readonly ProfileFrameE2e[]): number => frames.reduce((n, f) => n + Object.values(f.byCategory).reduce((m, v) => m + v, 0), 0);

interface VoxelPlayHook { kits(): Record<string, string>; stats(): { worlds: Record<string, { chunks: number; triangles: number; kitInstances: number; blendM: number; relief: { n: number; radiusM: number; displace: boolean; vertices: number } | null; far: { nodes: number; bricks: number; triangles: number; draws: number } }>; batches: number; replaced: number; waiting: number }; edits(): Array<{ swapMs: number; hopMs: number; applyMs: number; visibleMs: number; frames: number; chunks: number; sections: number }>; setRelief(s: { displace: boolean }): void; showFar(on: boolean): void; checkFarFeedback(): void }

/**
 * The play world's distances at the low tier: a load ring well inside the 128 m world, so the pit camera's upper
 * frame looks past the near field at ground only the far field draws (the other tiers load the whole world).
 */
const FAR_TEST_RINGS = { ring: { loadRadius: 40, unloadRadius: 48 }, collision: { radius: 32 } };

/** Whether no background pixel (black) lies within 2 pixels of (x, y). */
/** The background behind every draw: black where no sky draws, else the sky (bright, blue at least as strong as red and green). */
function background(r: number, g: number, b: number): boolean {
  return r + g + b < 30 || (r + g + b > 450 && b >= r && b >= g);
}

function nearInside(p: ReturnType<typeof decodePng>, x: number, y: number): boolean {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const u = Math.min(p.width - 1, Math.max(0, x + dx)), v = Math.min(p.height - 1, Math.max(0, y + dy));
    const [r, g, b] = p.pixel(u, v);
    if (background(r, g, b)) return false;
  }
  return true;
}

/**
 * The far field in a game page (Play or an export) once its world streams at {@link FAR_TEST_RINGS}: drawn as
 * ray-marched bricks (no triangles), and pixels past the near field that show the background with the far draws
 * hidden and ground (not the background, not sky-blue) with them shown, while every pixel the near field draws stays
 * as it was (the far field is behind it, its edge ring too). Returns the pixels past the near field.
 */
async function farBeyondNear(frame: { evaluate<R>(fn: () => R | Promise<R>): Promise<R> }, shot: (name: string) => Promise<ReturnType<typeof decodePng>>, label: string): Promise<number> {
  const far = () => frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: VoxelPlayHook }).__tlVoxelPlay?.stats().worlds['far']?.far ?? { nodes: 0, bricks: 0, triangles: -1, draws: 0 });
  await expect.poll(async () => (await far()).bricks, { timeout: 30_000, message: 'far bricks drawn' }).toBeGreaterThan(0);
  expect((await far()).triangles, 'bricks draw no triangles').toBe(0);
  const show = (on: boolean) => frame.evaluate(`window.__tlVoxelPlay.showFar(${on})`);
  let n = 0;
  let covered = 0;
  // The near field may still be dropping its outer chunks: poll until the far field's ground shows past it.
  await expect.poll(async () => {
    // The camera's auto exposure follows the picture's brightness (until it settles every pixel shifts): it opens up
    // in about 3 s once the far draws are hidden (the frame darker), turns down in about 1 s once they show.
    const settled = (ms: number) => frame.evaluate(`new Promise((ok) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(ok)), ${ms}))`);
    await show(false);
    await settled(3000);
    const near = await shot(`${label}-far-hidden`);
    await show(true);
    await settled(1200);
    const both = await shot(`${label}-far-shown`);
    n = 0;
    covered = 0;
    for (let y = 0; y < both.height; y++) for (let x = 0; x < both.width; x++) {
      const [r0, g0, b0] = near.pixel(x, y);
      const [r, g, b] = both.pixel(x, y);
      const moved = Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0);
      // The background (the sky, which follows the camera however far out it is) with the far draws hidden, ground
      // with them shown.
      if (background(r0, g0, b0) && moved > 60 && r + g + b > 60 && b < Math.max(r, g) + 16) n++;
      // The near field's own pixel drawn over by the far field (away from its silhouette, whose edge pixels blend
      // with what is behind them).
      else if (!background(r0, g0, b0) && moved > 48 && nearInside(near, x, y)) covered++;
    }
    // A pair taken while the exposure still moved is taken again.
    return covered < 200 ? n : -covered;
  }, { timeout: 45_000, message: `${label}: far ground past the near field, no near-field pixel drawn over (negative: those drawn over)` }).toBeGreaterThan(2000);
  // On WebGPU the visibility pass's feedback: rounds read back naming nodes seen, the GPU's reduction of a round equal
  // region for region to the CPU's of the same target.
  type Feedback = { sent: number; nodes: number; check: { hits: number; cpuHits: number; differ: number } | null } | null;
  const feedback = () => frame.evaluate(() => (window as unknown as { __tlVoxelPlay: { stats(): { worlds: Record<string, { far: { pass: string; feedback: unknown } }> } } }).__tlVoxelPlay.stats().worlds['far']?.far ?? null) as Promise<{ pass: string; feedback: Feedback } | null>;
  if ((await feedback())?.pass === 'visibility') {
    await expect.poll(async () => (await feedback())?.feedback?.nodes ?? 0, { timeout: 10_000, message: `${label}: far nodes seen in a feedback round` }).toBeGreaterThan(0);
    await frame.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.checkFarFeedback());
    await expect.poll(async () => (await feedback())?.feedback?.check?.hits ?? 0, { timeout: 10_000, message: `${label}: a feedback round checked` }).toBeGreaterThan(0);
    const check = (await feedback())!.feedback!.check!;
    expect(check.cpuHits, `${label}: the CPU's reduction of the same target`).toBe(check.hits);
    expect(check.differ, `${label}: regions the GPU and the CPU counted apart`).toBe(0);
  }
  return n;
}

/**
 * Relief at the high tier, by pixels: once the ring's relief meshes are drawn and stand still, the frame with them
 * moved by the grass's heights differs from the same meshes drawn flat (the hook's switch). Returns the pixels changed.
 */
async function reliefMoves(frame: { evaluate<R>(fn: () => R | Promise<R>): Promise<R> }, shot: (name: string) => Promise<ReturnType<typeof decodePng>>, label: string): Promise<number> {
  const relief = (): Promise<{ n: number; radiusM: number; vertices: number } | null> => frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: VoxelPlayHook }).__tlVoxelPlay?.stats().worlds['far']?.relief ?? null);
  await expect.poll(async () => { const r = await relief(); return r !== null && r.n === 4 && r.vertices > 0; }, { timeout: 30_000, message: `${label}: relief meshes drawn at the high tier` }).toBe(true);
  // The ground's texture set drawn (its normal map carries the heights).
  await expect.poll(() => frame.evaluate(() => (window as unknown as { __tlVoxelPlay: { stats(): { worlds: Record<string, { textureLayers: number }> } } }).__tlVoxelPlay.stats().worlds['far']?.textureLayers ?? 0), { timeout: 30_000, message: `${label}: the texture arrays drawn` }).toBeGreaterThan(0);
  let last = -1;
  await expect.poll(async () => { const v = (await relief())!.vertices; const still = v === last; last = v; return still; }, { timeout: 30_000, intervals: [1000], message: `${label}: the relief ring settles` }).toBe(true);
  const frames = (): Promise<void> => frame.evaluate(() => new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  await frames();
  const moved = await shot(`${label}-relief-moved`);
  await frame.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.setRelief({ displace: false }));
  await frames();
  const flat = await shot(`${label}-relief-flat`);
  await frame.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.setRelief({ displace: true }));
  // The ground's texture moves with its vertices: a broad shift of a few levels a pixel (a dig's 60-level bar would miss it).
  const changed = changedPixels(moved, flat, () => true, 20);
  const arrays = await frame.evaluate(() => { const w = (window as unknown as { __tlVoxelPlay: { stats(): { worlds: Record<string, { textureLayers: number; textured: boolean; textureTops: unknown }> } } }).__tlVoxelPlay.stats().worlds['far']; return w === undefined ? null : { layers: w.textureLayers, textured: w.textured, tops: w.textureTops }; });
  console.log(`[voxel-relief] ${label}: ${JSON.stringify(await relief())}; arrays ${JSON.stringify(arrays)}; moved vs flat ${changed} px`);
  return changed;
}

{
  // WebGPU only, the simulation in its worker (the product's way; sim-worker.e2e.ts runs a game with it in the page).
  const renderer = 'webgpu';
  test("Play: a world 8 km out streams with the simulation in its worker at a tier switched at run time, a script digs a pit, the pixels change and the character falls in; a voxel save in the game's slot brings the pit back after a restart, not the wetness", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    const at = await playProject();
    await groundRelief(true);
    const errors = consoleErrors(page);
    const url = editorUrlFor(be.editorUrl, renderer);
    await page.goto(url);
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
    // The high tier, switched at run time before the world streams in: the world streams, collides and draws at the
    // new tier (a body is let go only on a column whose sections all derived).
    const q = await projectApi(`play/${psid}/control`, { command: 'setQuality', level: 'high' });
    expect(q.status, JSON.stringify(q.json)).toBe(200);
    const drawn = (): Promise<ReturnType<VoxelPlayHook['stats']>> => canvas.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.stats());
    await expect.poll(async () => (await observe()).counters?.['resident'] ?? 0, { timeout: 60_000, message: 'the pit is resident' }).toBe(1);
    // The world is drawn round the camera and the character stands on its ground (it waited over unloaded ground).
    await expect.poll(async () => (await drawn()).worlds['far']?.chunks ?? 0, { timeout: 30_000 }).toBeGreaterThan(20);
    // Drawn at its object's blend distance.
    expect((await drawn()).worlds['far']?.blendM).toBe(PLAY_BLEND_M);
    // Kit pieces drawn: the stone kit's GLB read from the build's content and parsed on the page, the default kit's elsewhere.
    await expect.poll(async () => Object.values(await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.kits())), { timeout: 20_000 }).toEqual([expect.stringMatching(/^ready, sheet \S+/)]);
    // The pieces come with their chunks' draws, which may land after the kit's meshes.
    await expect.poll(async () => (await drawn()).worlds['far']?.kitInstances ?? 0, { timeout: 20_000 }).toBeGreaterThan(5);
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
    // The frame profile, read once on the page while the world streams: spans of the page, of the simulation worker
    // (posted with its ticks) and of the voxel job workers; its counters are the frame stats'; its budget the tier's.
    const readProfile = (): Promise<ProfileE2e> => canvas.evaluate(() => (window as unknown as { __tlProfiler: { read(): ProfileE2e } }).__tlProfiler.read());
    let prof: ProfileE2e | null = null;
    await expect.poll(async () => { prof = await readProfile(); return prof.threads.jobs.length > 0 && prof.threads.sim.length >= 30 && prof.counters.stats !== null; }, { timeout: 20_000, message: 'the profile has every thread' }).toBe(true);
    const pr = prof!;
    writeFileSync(test.info().outputPath('profile.json'), JSON.stringify(pr));
    const names = (frames: readonly ProfileFrameE2e[]): Set<string> => new Set(frames.flatMap((f) => f.spans.map((x) => x.name)));
    for (const n of ['render frame', 'scene sync', 'draw submit']) expect(names(pr.threads.page).has(n), `page span ${n}`).toBe(true);
    for (const n of ['step', 'voxel streaming', 'scripts']) expect(names(pr.threads.sim).has(n), `simulation span ${n}`).toBe(true);
    expect([...names(pr.threads.jobs)].every((n) => n.startsWith('job '))).toBe(true);
    expect(pr.threads.jobs.flatMap((f) => f.spans).every((x) => (x.lane ?? -1) >= 0 && (x.lane ?? 0) < (pr.counters.queues?.workers ?? 0))).toBe(true);
    // The worker's frames come one a tick, in order; the page's are its frames, each from its own start.
    const ticks = pr.threads.sim.map((f) => f.tick ?? -1);
    expect(ticks.every((t, i) => i === 0 || t > ticks[i - 1]!)).toBe(true);
    // Plausible sums: a thread's own time over its frames is busy time, at most the wall time those frames cover.
    const wall = (frames: readonly ProfileFrameE2e[]): number => frames.at(-1)!.start + frames.at(-1)!.ms - frames[0]!.start;
    const pageBusy = categorySum(pr.threads.page) / wall(pr.threads.page);
    const simBusy = categorySum(pr.threads.sim) / wall(pr.threads.sim);
    expect(pageBusy).toBeGreaterThan(0);
    expect(pageBusy).toBeLessThanOrEqual(1);
    expect(simBusy).toBeGreaterThan(0);
    expect(simBusy).toBeLessThanOrEqual(1);
    // The counters: the stats' last frame is one of the profile's frames (one count of draws and triangles).
    const st = pr.counters.stats!;
    expect(pr.counters.frames.some((c) => c.drawCalls === st.drawCalls && c.triangles === st.triangles), `stats ${st.drawCalls} draws / ${st.triangles} tris among the frames`).toBe(true);
    expect(pr.counters.voxels?.chunks ?? 0).toBeGreaterThan(20);
    // The resident-bytes report: the streamer's bytes in the simulation worker, at the tier's budget.
    expect(pr.counters.memory?.tier).toBe('high');
    expect(pr.counters.memory?.rows.find((r) => r.id === 'voxelStream')?.resident ?? 0).toBeGreaterThan(0);
    // The tier switched to at run time is the budget's: high, planned at 60 Hz.
    expect(st.quality).toBe('high');
    expect([pr.budget.tier, pr.budget.hz]).toEqual(['high', 60]);
    expect(pr.budget.rows.find((r) => r.thread === 'page' && r.category === 'render')?.budgetMs).toBeCloseTo(0.25 * (1000 / 60), 3);
    expect(pr.gpu.room).toBe('headroom meter');
    const perThread = (frames: readonly ProfileFrameE2e[]): string => (frames.length === 0 ? '-' : `${(categorySum(frames) / frames.length).toFixed(2)} ms/frame over ${frames.length}`);
    console.log(`[voxel-play] ${renderer} profile: page ${perThread(pr.threads.page)} (busy ${(pageBusy * 100).toFixed(1)} %), sim ${perThread(pr.threads.sim)} (busy ${(simBusy * 100).toFixed(1)} %), jobs ${perThread(pr.threads.jobs)}; ${pr.cost.pageSpansPerFrame.toFixed(1)} page spans a frame at ${pr.cost.nsPerSpan.toFixed(0)} ns; spikes ${pr.spikes.length}; rows ${JSON.stringify(pr.budget.rows.filter((r) => r.meanMs > 0).map((r) => `${r.thread}/${r.category} ${r.meanMs.toFixed(2)}/${r.budgetMs.toFixed(1)}`))}`);
    await profilerPanel(page, pr, readProfile);
    // The character falls into the pit (its collider went with the swap that drew the hole).
    await expect.poll(async () => standing.y - ((await observe()).player?.y ?? standing.y), { timeout: 10_000, message: 'the character falls into the pit' }).toBeGreaterThan(1);
    const after = decodePng(await page.locator('iframe.tl-app__preview-frame').screenshot({ path: test.info().outputPath('after.png') }));
    expect(changedPixels(before, after)).toBeGreaterThan(500);
    const edits = await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.edits());
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const pipeline = ((await projectApi(`play/${psid}/diagnostics`)).json as { diagnostics?: { simulation?: { pipeline?: { workerRoundTripMs: { avg: number; max: number } } | null } } }).diagnostics?.simulation?.pipeline ?? null;
    console.log(`[voxel-play] ${renderer} worker: edit→screen ${JSON.stringify(edits)}; sim round trip ${JSON.stringify(pipeline?.workerRoundTripMs ?? null)}; drawn ${JSON.stringify(await drawn())}`);

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
    // The relief ring of the high tier is read in the export below (it plays the same way).
    // The far field at the low tier (the world's own short load ring there): ray-marched bricks draw the ground past
    // the near field.
    await control({ command: 'setQuality', level: 'low' });
    const playShot = async (name: string): Promise<ReturnType<typeof decodePng>> => decodePng(await page.locator('iframe.tl-app__preview-frame').screenshot({ path: test.info().outputPath(`${name}.png`) }));
    console.log(`[voxel-play] ${renderer} far bricks: ${await farBeyondNear(canvas, playShot, `play-${renderer}`)} px of ground past the near field`);
    expect((await observe()).state).toBe('running');
    expect(errors).toEqual([]);

    // The world baked to 0.5 m (its object's bake level, one command): the bake starts with the command, the voxel
    // world's Inspector section shows it through to done, and a new Play draws baked fine bricks past the detail ring
    // with nothing built on the GPU, reading its voxels only to the detail ring's reach (a load ring of 100 m set, a
    // detail ring of a few metres; the chunks held fall where the world reaches past the reach: stream-levels.test.ts).
    await page.getByTitle('Stop the play preview').click();
    await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
    const bakeT0 = Date.now();
    await playCmd('setComponent', { entityId: playWorld!, component: 'voxelWorld', value: { world: 'far', blendMetres: PLAY_BLEND_M, bakeLevel: 0.5, quality: { low: { ring: { loadRadius: 100, unloadRadius: 108 }, levels: { level0: 4, level1: 8 }, collision: { radius: 2 } } } } });
    await page.locator(`.tl-hierarchy__list li[data-entity-id="${playWorld!}"]`).click();
    const bake = inspector(page).locator('[data-fine-bake]');
    const seen = new Set<string>();
    await expect.poll(async () => { const v = await bake.getAttribute('data-fine-bake').catch(() => null); if (v !== null) seen.add(`${v} ${await bake.getAttribute('data-fine-done').catch(() => '')}`); return v; }, { timeout: 120_000, intervals: [200], message: 'the fine bake shown done in the Inspector' }).toBe('baked');
    const done = (await bake.getAttribute('data-fine-done'))!;
    console.log(`[voxel-play] ${renderer} fine bake: ${Date.now() - bakeT0} ms, Inspector states ${JSON.stringify([...seen])}`);
    expect(done).toMatch(/^1:(\d+)\/\1 0:(\d+)\/\2$/);
    // The world's fine build is its own choice in the same section (off by default, left unset): picked there it is
    // the object's value, as a command; off again is the default once more.
    const fineBuild = inspector(page).getByLabel('voxelWorld fineBuild', { exact: true });
    await expect(fineBuild).toHaveValue('off');
    const worldValue = async (): Promise<Record<string, unknown>> => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: playWorld! } }))['entity'] as { components: { voxelWorld: Record<string, unknown> } }).components.voxelWorld;
    await fineBuild.selectOption('compute');
    await expect.poll(async () => (await worldValue())['fineBuild'], { timeout: 10_000, message: 'the Inspector sets the fine build' }).toBe('compute');
    await fineBuild.selectOption('off');
    await expect.poll(async () => (await worldValue())['fineBuild'] ?? 'off', { timeout: 10_000 }).toBe('off');
    const started2 = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid2 = String(((await (await started2).json()) as { playSessionId: string }).playSessionId);
    await expect.poll(async () => ((await projectApi(`play/${psid2}/observe`)).json as PlayObservation).state, { timeout: 60_000 }).toBe('running');
    const q2 = await projectApi(`play/${psid2}/control`, { command: 'setQuality', level: 'low' });
    expect(q2.status, JSON.stringify(q2.json)).toBe(200);
    type Host = { resident: number; readRing?: { setM: number; nowM: number; reachM: number | null }; far?: { fine?: { on: boolean; bakeLevel: number | null; made: number; baked: number; drawn: number[] } } };
    const host = async (): Promise<Host | null> => ((((await projectApi(`play/${psid2}/diagnostics`)).json as { diagnostics?: { runtime?: { voxelWorlds?: Host[] & Array<{ world: string }> } } }).diagnostics?.runtime?.voxelWorlds ?? []).find((w) => (w as unknown as { world: string }).world === 'far') ?? null) as Host | null;
    type Page2 = { worlds: Record<string, { far: { fine: { built: number } | null; fineBaked: { drawn: number[]; read: number } } }> };
    const pageFar = async (): Promise<Page2['worlds'][string]['far'] | null> => (await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay?: { stats(): unknown } }).__tlVoxelPlay?.stats() ?? null) as Page2 | null)?.worlds['far']?.far ?? null;
    await expect.poll(async () => (await host())?.readRing?.setM ?? 0, { timeout: 30_000, message: 'the low tier\'s ring in use' }).toBe(100);
    await expect.poll(async () => (await pageFar())?.fineBaked.drawn[0] ?? 0, { timeout: 60_000, message: 'baked level-0 bricks drawn' }).toBeGreaterThan(0);
    const f = (await pageFar())!;
    const h = (await host())!;
    console.log(`[voxel-play] ${renderer} baked: page ${JSON.stringify(f.fineBaked)} built ${JSON.stringify(f.fine)}; host resident ${h.resident} read ring ${JSON.stringify(h.readRing)} fine ${JSON.stringify(h.far?.fine)}`);
    expect(f.fineBaked.read).toBeGreaterThan(0);
    expect(f.fine, 'no fine node built on the GPU').toBeNull();
    expect(h.far?.fine?.made, 'no fine block read from the chunks').toBe(0);
    expect(h.far?.fine?.bakeLevel).toBe(0);
    expect(h.far?.fine?.baked).toBeGreaterThan(0);
    // The voxels are read only to the detail ring's reach, inside the load ring the object sets.
    expect(h.readRing?.setM).toBe(100);
    expect(h.readRing?.reachM).not.toBeNull();
    expect(h.readRing!.reachM!).toBeLessThan(100);
    expect(h.readRing?.nowM).toBe(h.readRing?.reachM);
    expect(errors).toEqual([]);
    await page.getByTitle('Stop the play preview').click();
    // Back to 2 m (the cache keeps the baked levels; a scene asking 2 m neither reads nor ships them).
    await playCmd('setComponent', { entityId: playWorld!, component: 'voxelWorld', value: { bakeLevel: null, quality: { low: FAR_TEST_RINGS } } });
    await groundRelief(false);
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

interface SceneViewVoxels { worlds: Record<string, { chunks: number; triangles: number; meshBuilds: number; kitInstances: number; tableUploads: number; tableMs: number }>; replaced: number; states: Record<string, { revision: number; settled: boolean; resident: number }>; problems: Record<string, string> }

test("Scene view: a voxelWorld object's world streams round the editor camera and draws; an edit and a kit slot filled through the command route show without a reload; one undo steps scene edits and the stroke in order", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors = consoleErrors(page);
  const [ox, oy, oz] = scene;
  // The object stands at the scene's centre (metres: cells × 0.5); the world's cell 0 is the world origin.
  const id = String((await playCmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Slice world', transform: { position: [ox / 2, oy / 2, oz / 2] } }))['createdId']);
  // An object the editor moves for the one undo, far out of the view (its selection draws nothing there).
  const marker = String((await playCmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Undo marker', transform: { position: [500, 0, 0] } }))['createdId']);
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

  // One undo for scene and voxels: the editor moves the marker (the Inspector), a 3 m pit is dug through the command
  // route (as MCP sends it: the editor has no voxel brush yet), the editor moves the marker again; Ctrl+Z three times
  // takes back the move, the pit (the view reads the chunks again and draws the ground as it was) and the first move;
  // Ctrl+Shift+Z three times does them again in order; a new edit after an undo leaves nothing to redo.
  const markerRow = page.locator(`.tl-hierarchy__list li[data-entity-id="${marker}"]`);
  await markerRow.click();
  const posX = page.locator('.tl-inspector').getByLabel('position x', { exact: true });
  const moveMarker = async (x: number): Promise<void> => {
    await posX.fill(String(x));
    await posX.press('Enter');
    await expect.poll(async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: marker } })) as { entity: { components: { transform: { position: number[] } } } }).entity.components.transform.position[0]).toBe(x);
    // Out of the field, so the keys are the editor's (not the field's own text undo).
    await markerRow.click();
  };
  const revisionOf = async (): Promise<number> => (await voxels())?.states['slice']?.revision ?? -1;
  const before = drawn.states['slice']!.revision;
  /** The Scene view has read the world at `revision` again and drawn it. */
  const drawnAt = async (revision: number, replaced: number, message: string): Promise<void> => {
    await expect.poll(async () => { const v = await voxels(); return v?.states['slice']?.revision === revision && v.states['slice']!.settled && v.replaced > replaced; }, { timeout: 30_000, message }).toBe(true);
  };
  await moveMarker(501);
  const clean = await sceneViewStill(page, 'scene-view-before-dig');
  // A 3 m pit dug through the command route (as MCP sends it): the view reads the changed chunks again and shows it.
  const dig = await be.command({ op: 'editVoxels', projectId: be.projectId, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-voxel-scene-view' }, args: { world: 'slice', command: { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [6, 6, 6], points: [ox, oy, oz], mode: 'dig', smooth: false } } });
  expect(dig['ok'], JSON.stringify(dig)).toBe(true);
  expect(Number(dig['revision'])).toBe(before + 1);
  await drawnAt(before + 1, drawn.replaced, 'the edit is read again and drawn');
  const pit = await sceneViewStill(page, 'scene-view-dug');
  expect(changedPixels(clean, pit)).toBeGreaterThan(500);
  expect(await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded)).toBe(true);
  await moveMarker(502);
  const redoEnabled = async (): Promise<boolean> => (await menuItem(page, 'Edit', 'Redo')).isEnabled().finally(() => closeMenu(page));

  await page.keyboard.press('Control+z');
  await expect(posX).toHaveValue('501');
  expect(await revisionOf()).toBe(before + 1);
  let replaced = (await voxels())!.replaced;
  await page.keyboard.press('Control+z');
  await drawnAt(before + 2, replaced, 'the undone stroke is read again and drawn');
  const undone = await sceneViewStill(page, 'scene-view-undone');
  expect(changedPixels(clean, undone), 'the ground as before the dig').toBeLessThan(50);
  await expect(posX).toHaveValue('501');
  await page.keyboard.press('Control+z');
  await expect(posX).toHaveValue('500');
  expect(await revisionOf()).toBe(before + 2);

  await page.keyboard.press('Control+Shift+z');
  await expect(posX).toHaveValue('501');
  replaced = (await voxels())!.replaced;
  await page.keyboard.press('Control+Shift+z');
  await drawnAt(before + 3, replaced, 'the redone stroke is read again and drawn');
  const dug = await sceneViewStill(page, 'scene-view-redone');
  expect(changedPixels(pit, dug), 'the pit as dug').toBeLessThan(50);
  await page.keyboard.press('Control+Shift+z');
  await expect(posX).toHaveValue('502');
  expect(await redoEnabled()).toBe(false);
  // Undo once (the move), then a new move: nothing is left to redo.
  await page.keyboard.press('Control+z');
  await expect(posX).toHaveValue('501');
  await expect.poll(redoEnabled, { message: 'Redo enabled after an undo' }).toBe(true);
  await moveMarker(503);
  await expect.poll(redoEnabled, { message: 'a new edit ends the redo' }).toBe(false);
  expect(await revisionOf()).toBe(before + 3);

  // A kit slot filled through the command route (as MCP sends it): the view takes the new piece table, the chunks whose
  // pieces it changes derive again, and the slot's pieces (the stone walls' top edges) draw without a reload; set back, they go.
  const kitCmd = async (kit: Record<string, unknown>): Promise<void> => void (await playCmd('setVoxelKit', { kit }));
  const pieces = async (): Promise<number> => (await voxels())?.worlds['slice']?.kitInstances ?? 0;
  const plain = await pieces();
  await kitCmd({ ...stoneKit, slots: { ...stoneKit.slots, 'edge-out-top': { meshes: [{ mesh: stoneMesh }] } } });
  await expect.poll(pieces, { timeout: 30_000, message: 'the filled slot draws in the Scene view' }).toBeGreaterThan(plain);
  const slotted = await sceneViewStill(page, 'scene-view-kit-slot');
  expect(changedPixels(dug, slotted)).toBeGreaterThan(100);
  await kitCmd(stoneKit);
  await expect.poll(pieces, { timeout: 30_000, message: 'the emptied slot draws nothing again' }).toBe(plain);
  const kitBack = await sceneViewStill(page, 'scene-view-kit-back');
  expect(changedPixels(dug, kitBack)).toBeLessThan(50);
  expect(await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded)).toBe(true);

  // The stone's material record drawn: its colour and tile set through the Inspector rewrite the world's material table
  // and the walls turn blue, with no chunk derived, meshed or replaced again; the project window shows its badges and
  // filters by them; set back through the command route (as MCP sends it), the table follows again.
  const table = async (): Promise<{ uploads: number; meshBuilds: number; replaced: number }> => { const v = (await voxels())!; return { uploads: v.worlds['slice']!.tableUploads, meshBuilds: v.worlds['slice']!.meshBuilds, replaced: v.replaced }; };
  const looks0 = await table();
  await chooseItem(page, 'material', 'Stone (voxel)');
  const ins = inspector(page);
  await expect(ins.locator('[aria-label="voxel use"] [data-badge]')).toHaveText(['mesh', 'voxel', 'kit']);
  const colour = ins.getByLabel('color', { exact: true });
  await colour.fill('#1030e0');
  await colour.blur();
  await expect.poll(async () => (await table()).uploads, { timeout: 15_000, message: 'the colour rewrites the table' }).toBe(looks0.uploads + 1);
  const tile = ins.getByLabel('voxel tile metres');
  await tile.fill('1');
  await tile.press('Enter');
  await expect.poll(async () => (await table()).uploads, { timeout: 15_000, message: 'the tile rewrites the table' }).toBe(looks0.uploads + 2);
  expect(await table()).toMatchObject({ meshBuilds: looks0.meshBuilds, replaced: looks0.replaced });
  const recoloured = await sceneViewStill(page, 'scene-view-stone-record');
  const blue = [hueCount(kitBack, 'blue'), hueCount(recoloured, 'blue')];
  expect(blue[1] - blue[0], `blue pixels ${blue.join(' → ')}`).toBeGreaterThan(2000);
  const panel = page.locator('.tl-assets');
  await expect(panel.locator('li[data-item-id="mat-stone-voxel"] [data-badge]')).toHaveText(['mesh', 'voxel', 'kit']);
  const search = panel.getByLabel('search the project');
  const listed = (): Promise<string[]> => panel.locator('li.tl-project__item').evaluateAll((els) => els.map((e) => e.getAttribute('data-item-id') ?? ''));
  await search.fill('f:voxel');
  await expect.poll(listed, { timeout: 10_000 }).toEqual(['mat-stone-voxel']);
  await search.fill('f:mesh paint');
  await expect.poll(listed, { timeout: 10_000 }).toEqual(['mat-crate-paint']);
  await search.fill('');
  await playCmd('setMaterial', { material: STONE_MATERIAL });
  await expect.poll(async () => (await table()).uploads, { timeout: 15_000, message: 'the record set back rewrites the table' }).toBe(looks0.uploads + 3);
  expect(await table()).toMatchObject({ meshBuilds: looks0.meshBuilds, replaced: looks0.replaced });
  expect(Math.abs(hueCount(await sceneViewStill(page, 'scene-view-stone-back'), 'blue') - blue[0])).toBeLessThan(200);
  console.log(`[voxel-scene-view] material table: ${JSON.stringify(await table())}, last upload ${(await voxels())!.worlds['slice']!.tableMs.toFixed(2)} ms; blue pixels ${blue.join(' → ')}`);

  // The object goes: so does the world's draw (and the project is as the other tests left it; Play's world, 8 km out
  // and all air round this view, may still stream).
  await playCmd('deleteEntity', { entityId: id });
  await playCmd('deleteEntity', { entityId: marker });
  await expect.poll(async () => { const v = await voxels(); return v === null || (v.worlds['slice'] === undefined && v.states['slice'] === undefined); }, { timeout: 10_000 }).toBe(true);
  console.log(`[voxel-scene-view] drawn ${JSON.stringify(drawn.worlds)}`);
  expect(errors).toEqual([]);
});

// ---- The export plays the world with no backend ------------------------------------------------------------------
// This test halts the file's one backend (an export is checked with the backend stopped): it stays the file's last test.

test('Export: the Play project exported and served statically with the backend stopped streams its world from the shipped region files, draws it and its wall marks, stands the character on it, and a console dig opens the pit', async ({ page }) => {
  test.setTimeout(180_000);
  const at = await playProject();
  await groundRelief(true);
  // The debug console takes the dig (the test's way to drive the script, as Play's debug command).
  await playCmd('setSettings', { settings: { debug_console: 1 } });
  const exported = await be.admin(`projects/${be.projectId}/export`);
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
  const out = join(be.exportRoot, String(exported.json.outputDir));
  // The catalog lists the world and its region files, each shipped whole at its content path.
  const shipped = (exportedContent(out) as unknown as { voxelWorlds?: Array<{ world: string; files: Array<{ name: string; digest: string; byteLength: number }> }> }).voxelWorlds ?? [];
  expect(shipped.map((w) => w.world)).toEqual(['far']);
  // Its far cache ships beside it (the far field's nodes, level by level).
  const farFiles = (shipped[0] as { far?: { files: Array<{ name: string; digest: string }> } }).far?.files ?? [];
  expect(farFiles.length).toBeGreaterThan(0);
  // Nodes (L<level>/) and their bricks baked beside them (B<level>/), which the far field decodes instead of building.
  expect(farFiles.every((f) => /^[LB]\d+\//.test(f.name) && existsSync(join(out, 'content', 'sha256', f.digest)))).toBe(true);
  const bakedPaths = new Set(farFiles.filter((f) => f.name.startsWith('B')).map((f) => `content/sha256/${f.digest}`));
  expect(bakedPaths.size).toBeGreaterThan(0);
  // The stone's record ships though only the world's cells name it; the mesh-only material nothing wears does not.
  const shippedMaterials = ((exportedContent(out) as unknown as { materials?: Array<{ materialId: string; voxel?: unknown }> }).materials ?? []);
  expect(shippedMaterials.find((m) => m.materialId === 'mat-stone-voxel')?.voxel).toEqual(STONE_MATERIAL.voxel);
  expect(shippedMaterials.some((m) => m.materialId === 'mat-crate-paint')).toBe(false);
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
    // At the high tier (its URL's level), so the relief ring draws too.
    await game.goto(`${site.url}${exportQueryFor('webgpu')}&quality=high`);
    const canvas = game.locator('canvas#game');
    await expectRendererBackend(canvas, 'webgpu');
    type Obs = { state?: string; counters?: Record<string, number>; player?: { x: number; y: number; z: number } } | null;
    const observe = (): Promise<Obs> => game.evaluate(() => (window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Promise<Obs>;
    const drawn = (): Promise<number> => game.evaluate(() => (window as unknown as { __tlVoxelPlay?: { stats(): { worlds: Record<string, { chunks: number }> } } }).__tlVoxelPlay?.stats().worlds['far']?.chunks ?? 0);
    await expect.poll(async () => (await observe())?.counters?.['resident'] ?? 0, { timeout: 60_000, message: 'the pit is resident in the export' }).toBe(1);
    const residentMs = Date.now() - t0;
    // The world is drawn round the camera (the checks below wait for what they read: the wall's marks, the relief).
    await expect.poll(drawn, { timeout: 60_000, intervals: [100], message: 'the world is drawn round the camera' }).toBeGreaterThan(20);
    const [fillMs, chunks] = [Date.now() - t0, await drawn()];
    // The shipped scene's world draws at its object's blend distance.
    expect(await game.evaluate(() => (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay.stats().worlds['far']?.blendM)).toBe(PLAY_BLEND_M);
    await expect.poll(async () => { const y = (await observe())?.player?.y ?? -1e9; return y > at[1] && y < at[1] + 1.2; }, { timeout: 20_000, message: 'the character stands on the pad' }).toBe(true);
    // The kit's GLB came with the build's content files (the backend is stopped) and draws; the default kit's pieces too.
    const play = (): Promise<{ kits: Record<string, string>; kitInstances: number }> => game.evaluate(() => { const h = (window as unknown as { __tlVoxelPlay: VoxelPlayHook }).__tlVoxelPlay; return { kits: h.kits(), kitInstances: h.stats().worlds['far']?.kitInstances ?? 0 }; });
    // The sheet's texture asset shipped with the model and draws (a missing one would leave the file's stand-in, no asset).
    await expect.poll(async () => Object.values((await play()).kits), { timeout: 20_000 }).toEqual([expect.stringMatching(/^ready, sheet \S+/)]);
    expect((await play()).kitInstances).toBeGreaterThan(5);
    const threading = await game.evaluate(() => (window as unknown as { __thirdlightThreading?: { mode: string } }).__thirdlightThreading?.mode ?? null);
    console.log(`[voxel-export] drawn (page load → over 20 chunks): ${fillMs} ms, ${chunks} chunks; pit resident at ${residentMs} ms; simulation ${String(threading)}`);
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
    // Relief drawn moved by the shipped grass set's heights.
    expect(await reliefMoves(game, async (name) => decodePng(await canvas.screenshot({ path: test.info().outputPath(`${name}.png`) })), 'export')).toBeGreaterThan(2000);
    // The far field from the shipped far cache, the export opened again at the low tier with the simulation in the
    // page (`threads=off`, the fallback where a worker cannot start): the world streams there too, the character stands
    // on it again, and bricks draw past the near field.
    await game.goto(`${site.url}${exportQueryFor('webgpu')}&quality=low&threads=off`);
    await expectRendererBackend(canvas, 'webgpu');
    expect(await game.evaluate(() => (window as unknown as { __thirdlightThreading?: { mode: string } }).__thirdlightThreading?.mode ?? null)).toBe('single');
    await expect.poll(async () => (await observe())?.counters?.['resident'] ?? 0, { timeout: 60_000, message: 'the pit is resident with the simulation in the page' }).toBe(1);
    await expect.poll(drawn, { timeout: 60_000, intervals: [100], message: 'the world is drawn with the simulation in the page' }).toBeGreaterThan(20);
    await expect.poll(async () => { const y = (await observe())?.player?.y ?? -1e9; return y > at[1] && y < at[1] + 1.2; }, { timeout: 20_000, message: 'the character stands on the pad with the simulation in the page' }).toBe(true);
    console.log(`[voxel-export] far bricks: ${await farBeyondNear(game, async (name) => decodePng(await canvas.screenshot({ path: test.info().outputPath(`${name}.png`) })), 'export')} px of ground past the near field`);
    // Drawn from the baked bricks the export ships.
    expect(requests.filter((u) => bakedPaths.has(u.slice(site.url.length))).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
