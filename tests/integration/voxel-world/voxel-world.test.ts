/**
 * A project's voxel world against a real backend over HTTP, with real
 * region files on disk: the world's manifest and region files read by byte
 * range (auth, origin, tags, 206/200/412/416), voxel edit and undo commands
 * on the command route (applied by the workspace, region files replaced,
 * revision moved, request ids answered once, refusals, a stroke over the
 * memory budget of one edit refused at once), files changed behind the
 * running backend's back (a git checkout) read again without a restart,
 * a released project's worlds read again, the backend restarted over the
 * same data root finding the edit in the files, a region file the
 * manifest lists but that is gone reported as damaged (never air) while an
 * unlisted region reads as air, a scene object's voxelWorld component set,
 * patched and refused through setComponent and kept across a restart, and
 * MCP's tl_command sending the same voxel ops as the editor page (the same
 * answer, the same files) while the project's editor learns of every change
 * over its WebSocket feed, a voxel kit made, refused, undone and deleted as a
 * project content item over HTTP and MCP (its own file, kept across a
 * restart), a broken voxel kit's check rows in the project's Problems (HTTP
 * and MCP), the kit test scene written as one command (each label's cell
 * deriving as its case from the files, no_change again, one undo), and an
 * export shipping the worlds its scenes name
 * (each listed region file whole, by digest) and the voxel kits (their block,
 * their pieces' model) or refusing a damaged world.
 *
 * Chunks are read back the way a browser does: a region chunk source whose
 * byte source sends Range requests to the route, decoded into a store, and
 * compared with the same commands applied to a copy in this process.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestBackend, testTempBase } from '@thirdlight/backend/testing';
import type { Backend } from '@thirdlight/backend/services';
import {
  ALL_DERIVED_PARTS,
  applyEdit,
  canonicalEditCommand,
  chunkGrid,
  createDenseChunk,
  createWorldStore,
  DERIVED_PART,
  editBounds,
  exportOrAir,
  kitTestScene,
  materialSwap,
  parseRegionFileName,
  RegionChunkSource,
  sameDenseChunk,
  type ChunkCoord,
  shippedChunkSource,
  type RegionChunkRead,
  type PaletteStore,
  type ShippedVoxelWorld,
  WORLD_RULES,
} from '@thirdlight/voxel';
import { readRuntimeContentSync, type VoxelKit, type VoxelKitMesh } from '@thirdlight/project-model';
import { glbBytes } from '@thirdlight/shared';
import { importRead, writeVoxelWorld } from '@thirdlight/workspace';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BackendClient } from '../../../packages/mcp-adapter/src/backend-client';
import { createMcpServer } from '../../../packages/mcp-adapter/src/server';
import { caseAndSectionAt } from '../../../tools/voxel-bench/case-probe';
import { flatGround, placeWallBeamBanister } from '../../../tools/voxel-bench/scenes';

const ORIGIN = 'http://127.0.0.1:8501';
const TOKEN = 'voxel-authoring-token';
const ADMIN = 'voxel-admin-token';
const PROJECT = 'vox';
const WORLD = 'w';
/** A second world, edited only by the editor-feed test (the tests above count the first one's revisions). */
const FEED_WORLD = 'feed';
/** A third world, written only by the kit test scene test. */
const SCENE_WORLD = 'kit-scene';
const grid = chunkGrid(32);
const WORLD_ID = '00112233445566778899aabbccddeeff';
const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

let root = '';
let dataRoot = '';
let backend: Backend;
let close: () => Promise<void>;
/** The world as written, and the same world with every applied command (this process's oracle). */
let original: PaletteStore;
let expected: PaletteStore;

const base = (): string => `http://127.0.0.1:${backend.portAuthoring}`;
const auth = { authorization: `Bearer ${TOKEN}` };
const rid = (n: number): string => `req-${n.toString(16).padStart(32, '0')}`;

/** One triangle as a GLB of one node: the pieces' model a voxel kit names (real bytes through the real import). */
function pieceGlb(size = 0.5): Uint8Array {
  const positions = new Float32Array([0, 0, 0, size, 0, 0, 0, size, 0]);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Beam_Body', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [size, size, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    buffers: [{ byteLength: positions.byteLength }],
  };
  return glbBytes(JSON.stringify(json), new Uint8Array(positions.buffer));
}

/** The kit the content-item test makes (its model is imported there); the export test checks what ships of it. */
const KIT_MODEL = { assetId: '' };
function logKit(assetId: string, digest: string): VoxelKit {
  return {
    kitFormat: 1,
    voxelKitId: 'log',
    name: 'Log',
    version: 1,
    materialType: 'wood',
    materials: [3],
    joinProfiles: { square: { outline: [[4, 4], [12, 4], [12, 12], [4, 12]] } },
    cases: {
      'wall-banister': { gameData: { break: { hits: 1 } } },
      beam: { sections: { body: { variants: [{ high: { assetId, digest, node: 'Beam_Body' }, weight: 1 }], ends: { start: 'square', end: 'square' } } } },
    },
    gameData: { sound: { hit: 'wood-knock' }, physics: { density: 0.6 }, tags: ['flammable', 2, null] },
  };
}

/** The model rows an export's catalog ships (one version an asset). */
function shippedModels(outputDir: string): Map<string, { version: number; sourceDigest: string }> {
  const out = join(root, 'exports', outputDir);
  const content = readRuntimeContentSync(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), (path) => {
    try {
      return new Uint8Array(readFileSync(join(out, path)));
    } catch {
      return null;
    }
  }) as unknown as { dependencies?: Array<{ assetId: string; version: number; sourceDigest: string }> };
  return new Map((content.dependencies ?? []).map((e) => [e.assetId, e]));
}

/**
 * A kit mesh's model imported again: the file is the asset, so its new version replaces the one the mesh's digest
 * names, and a build ships the current version for the kit alone and with a scene placing the model (one version an
 * asset: the kit never moves the scene's reference).
 * The scene object is deleted again after.
 */
async function kitMeshAfterReimport(assetId: string, pinned: string, send: (op: string, args: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>, exportNow: () => Promise<{ status: number; json: Record<string, unknown> }>): Promise<void> {
  const dir = backend._test.service.projectDir(PROJECT)!;
  const newer = pieceGlb(0.25);
  writeFileSync(join(dir, 'assets', 'kits', 'log-pieces.glb'), newer);
  // A changed file is imported again (the editor's "check files").
  const checked = await fetch(`${base()}/api/v1/projects/${PROJECT}/content/files/check`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
  expect(checked.status, await checked.clone().text()).toBe(200);
  const currentDigest = createHash('sha256').update(newer).digest('hex');
  const record = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/content/assets/${assetId}`, { headers: auth })).json()) as { asset: { currentVersion: number }; versions: Array<{ version: number; sourceDigest: string }> };
  expect(record.versions.map((v) => v.sourceDigest)).toEqual([currentDigest]);
  for (const scene of [false, true]) {
    const placed = scene ? await send('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Kit model in the scene', model: { asset: { assetId } } }) : null;
    if (placed !== null) expect(placed.status, JSON.stringify(placed.json)).toBe(200);
    const done = await exportNow();
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(shippedModels(String(done.json['outputDir'])).get(assetId), scene ? 'with a scene' : 'kit alone').toMatchObject({ version: record.asset.currentVersion, sourceDigest: currentDigest });
    const outDir = join(root, 'exports', String(done.json['outputDir']));
    expect(readFileSync(join(outDir, 'content', 'sha256', currentDigest)).equals(newer)).toBe(true);
    expect(existsSync(join(outDir, 'content', 'sha256', pinned))).toBe(false);
    if (placed !== null) expect((await send('deleteEntity', { entityId: placed.json['createdId'] as string })).status).toBe(200);
  }
}

function sceneStore(): PaletteStore {
  const s = createWorldStore(grid);
  flatGround(s, -48, 48, -48, 48, 6, -3);
  placeWallBeamBanister(s);
  return s;
}

async function start(): Promise<void> {
  // Exports of the project bundle the engine of this repository (its frozen copy, `npm run build`).
  const tb = await createTestBackend({ dataRoot, exportRoot: join(root, 'exports'), engineRoot: REPO, authoringOrigin: ORIGIN, previewOrigin: 'http://127.0.0.1:8502', authoringOrigins: [ORIGIN], tokens: [{ token: TOKEN, scope: `authoring:${PROJECT}` }, { token: ADMIN, scope: 'admin' }] });
  backend = tb.backend;
  // The data root outlives a backend here (the restart reads it again): close only the server.
  close = () => tb.backend.close();
}

beforeAll(async () => {
  root = mkdtempSync(join(testTempBase(), 'tl-voxel-world-'));
  dataRoot = join(root, 'data');
  mkdirSync(join(root, 'exports'));
  await start();
  expect(backend._test.service.createProject(PROJECT, 'Voxel world').ok).toBe(true);
  const dir = backend._test.service.projectDir(PROJECT)!;
  original = sceneStore();
  expected = sceneStore();
  writeVoxelWorld(join(dir, 'voxels', WORLD), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, original);
  writeVoxelWorld(join(dir, 'voxels', FEED_WORLD), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, sceneStore());
}, 60_000);

afterAll(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

const command = async (body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${base()}/api/v1/projects/${PROJECT}/commands`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

/** What the range route gives for these chunks, as the browser's chunk source reads them (only the files the world lists). */
async function readRaw(chunks: readonly ChunkCoord[], world = WORLD): Promise<RegionChunkRead[]> {
  const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${world}`, { headers: auth })).json()) as { manifest: { worldId: string }; files: Array<{ name: string }> };
  const names = new Set(info.files.map((f) => f.name));
  const source = new RegionChunkSource({
    worldId: Uint8Array.from(info.manifest.worldId.match(/../g)!, (h) => parseInt(h, 16)),
    gridId: 0,
    grid,
    layout: 'stacked',
    footprint: 512,
    maxOpen: 8,
    open: (name) =>
      names.has(name)
        ? {
            read: async (offset, length) => {
              const r = await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${world}/regions/${name}`, { headers: { ...auth, range: `bytes=${offset}-${offset + length - 1}` } });
              if (r.status === 416) return new Uint8Array(0);
              if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
              return new Uint8Array(await r.arrayBuffer());
            },
          }
        : null,
  });
  return source.read(chunks);
}

/** Chunks read through the range route into a store. */
async function readChunks(chunks: readonly ChunkCoord[], world = WORLD): Promise<PaletteStore> {
  const store = createWorldStore(grid);
  for (const r of await readRaw(chunks, world)) {
    if (r.kind === 'damaged') throw new Error(r.reason);
    importRead(store, r);
  }
  return store;
}

function expectSame(a: PaletteStore, b: PaletteStore, chunks: readonly ChunkCoord[]): void {
  const x = createDenseChunk(grid);
  const y = createDenseChunk(grid);
  for (const c of chunks) expect(sameDenseChunk(exportOrAir(a, c.cx, c.cy, c.cz, x), exportOrAir(b, c.cx, c.cy, c.cz, y)), `chunk ${c.cx},${c.cy},${c.cz}`).toBe(true);
}

const SCENE_CHUNKS: ChunkCoord[] = [-1, 0].flatMap((cx) => [-1, 0].flatMap((cy) => [-1, 0].map((cz) => ({ cx, cy, cz }))));
/** A 2-cell dig in the wall at a chunk corner (x 0, z 0): four chunk columns. */
const DIG = { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [0, 4, 0], mode: 'dig', smooth: false };

describe('voxel world routes', () => {
  it('serves the manifest and region files to a token for the project, by range, with tags', async () => {
    expect((await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`)).status).toBe(401);
    expect((await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: { ...auth, origin: 'http://elsewhere.example' } })).status).toBe(403);
    const r = await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth });
    expect(r.status).toBe(200);
    const info = (await r.json()) as { manifest: { revision: number; layout: string; regions: string[] }; files: Array<{ name: string; etag: string }> };
    expect(info.manifest).toMatchObject({ format: 2, revision: 0, layout: 'stacked', edge: 32, footprint: 512, worldId: WORLD_ID });
    expect(info.files.length).toBeGreaterThan(0);
    // The manifest lists exactly the region files the world has.
    expect(info.manifest.regions).toEqual(info.files.map((f) => f.name));
    expect((await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/nope`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/Bad%20Name`, { headers: auth })).status).toBe(400);

    const f = info.files[0]!;
    const url = `${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}/regions/${f.name}`;
    const disk = new Uint8Array(readFileSync(join(backend._test.service.projectDir(PROJECT)!, 'voxels', WORLD, 'grid-0', f.name)));
    const part = await fetch(url, { headers: { ...auth, range: 'bytes=0-63' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-63/${disk.length}`);
    expect(part.headers.get('etag')).toBe(`"${f.etag}"`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(disk.subarray(0, 64));
    const tail = await fetch(url, { headers: { ...auth, range: 'bytes=-10' } });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(disk.subarray(disk.length - 10));
    const whole = await fetch(url, { headers: auth });
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(disk);
    const past = await fetch(url, { headers: { ...auth, range: `bytes=${disk.length}-` } });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${disk.length}`);
    expect((await fetch(url, { headers: { ...auth, range: 'bytes=0-9', 'if-match': '"0000"' } })).status).toBe(412);
    expect((await fetch(url, { headers: { ...auth, range: 'bytes=0-9', 'if-match': `"${f.etag}"` } })).status).toBe(206);
    expect((await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}/regions/r.9.9.9.vxr`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}/regions/..%2Fworld.json`, { headers: auth })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers: auth })).status).toBe(405);
    // What the range route serves decodes to the world as written.
    expectSame(await readChunks(SCENE_CHUNKS), original, SCENE_CHUNKS);
  });

  it('applies an edit command to the region files: revision moves, changed chunks named, a resent request answered once', async () => {
    const before = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { files: Array<{ name: string; etag: string }> };
    const r = await command({ op: 'editVoxels', projectId: PROJECT, requestId: rid(1), args: { world: WORLD, command: DIG } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ ok: true, op: 'editVoxels', revision: 1, duplicated: false, undoable: 1 });
    const out = applyEdit({ store: () => expected }, canonicalEditCommand(DIG));
    expect(r.json.cells).toBe(out.cells);
    const chunks = (r.json.chunks as Array<[number, number, number]>).map(([cx, cy, cz]) => ({ cx, cy, cz }));
    expect(chunks).toEqual(out.chunks.map((u) => ({ cx: u.cx, cy: u.cy, cz: u.cz })));
    expect(chunks.length).toBe(4);
    // The cells the stroke could change: what a client derives again from.
    expect(r.json.box).toEqual(editBounds(grid, canonicalEditCommand(DIG)));
    // Every rewritten file has a new tag; the info lists it.
    const after = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { revision: number }; files: Array<{ name: string; etag: string }> };
    expect(after.manifest.revision).toBe(1);
    for (const f of r.json.files as Array<{ name: string; etag: string }>) {
      expect(before.files.find((b) => b.name === f.name)?.etag).not.toBe(f.etag);
      expect(after.files.find((a) => a.name === f.name)?.etag).toBe(f.etag);
    }
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);

    // The same request again: the first answer, nothing applied twice.
    const again = await command({ op: 'editVoxels', projectId: PROJECT, requestId: rid(1), args: { world: WORLD, command: DIG } });
    expect(again.json).toMatchObject({ ok: true, revision: 1, duplicated: true });
    // The same stroke as a new request changes nothing now.
    const same = await command({ op: 'editVoxels', projectId: PROJECT, requestId: rid(2), args: { world: WORLD, command: DIG } });
    expect(same.status).toBe(400);
    expect((same.json.error as { code: string }).code).toBe('no_change');
  });

  it('refuses bad commands before writing, and a browser-origin command without the project session', async () => {
    const bad = await command({ op: 'editVoxels', projectId: PROJECT, requestId: rid(3), args: { world: WORLD, command: { ...DIG, size: [-1, 2, 2] } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatchObject({ code: 'invalid_args', path: '/args/command/size/0' });
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: 'nope', command: DIG } })).status).toBe(404);
    expect((await command({ op: 'editVoxels', projectId: PROJECT, requestId: 'req-x', args: { world: WORLD, command: DIG } })).status).toBe(400);
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: DIG, extra: 1 } })).status).toBe(400);
    const far = await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { ...DIG, points: [0, 9000, 0] } } });
    expect(far.status).toBe(400);
    expect((far.json.error as { code: string }).code).toBe('outside_world');
    // A stroke whose worst-case undo would pass the budget of one edit is refused before a cell is visited:
    // the whole world filled, a sphere 2 km across. Each would otherwise hold the backend for minutes and run it out of memory.
    for (const huge of [
      { v: 2, grid: 0, kind: 'fill', min: [-32768, -8192, -32768], max: [32767, 8191, 32767], mode: 'place', voxel: { material: 3, role: 3, wetness: 0 } },
      { ...DIG, size: [2000, 2000, 2000] },
    ]) {
      const t0 = performance.now();
      const r = await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: huge } });
      const ms = performance.now() - t0;
      expect(r.status).toBe(400);
      expect(r.json.error).toMatchObject({ code: 'over_budget' });
      expect((r.json.error as { message: string }).message).toMatch(/more than 341 chunks of 32³ cells .* over the 64\.0 MiB undo budget of one edit/);
      // A refusal answers like any other; 2 s leaves room for a loaded gate host.
      expect(ms).toBeLessThan(2000);
    }
    const browser = await command({ op: 'editVoxels', projectId: PROJECT, origin: { kind: 'browser' }, args: { world: WORLD, command: DIG } });
    expect(browser.status).toBe(403);
    expect((browser.json.error as { code: string }).code).toBe('session_required');
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { revision: number } };
    expect(info.manifest.revision).toBe(1);
  });

  it('undoes the newest edit as a new revision; nothing left to undo is refused', async () => {
    const r = await command({ op: 'undoVoxels', projectId: PROJECT, requestId: rid(4), args: { world: WORLD } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // It names the cells and chunks the edit changed: the same ones go back.
    expect(r.json).toMatchObject({ ok: true, op: 'undoVoxels', revision: 2, undoable: 0, cells: applyEdit({ store: () => sceneStore() }, canonicalEditCommand(DIG)).cells });
    expect((r.json.chunks as unknown[]).length).toBe(4);
    // And the box of the edit it takes back, so a client re-derives only what that edit could change.
    expect(r.json.box).toEqual(editBounds(grid, canonicalEditCommand(DIG)));
    expectSame(await readChunks(SCENE_CHUNKS), original, SCENE_CHUNKS);
    const none = await command({ op: 'undoVoxels', projectId: PROJECT, args: { world: WORLD } });
    expect(none.status).toBe(400);
    expect((none.json.error as { code: string }).code).toBe('nothing_to_undo');
    // Edit again so the restart below has something to find; the oracle is the original world with that one dig.
    expected = sceneStore();
    applyEdit({ store: () => expected }, canonicalEditCommand(DIG));
    expect((await command({ op: 'editVoxels', projectId: PROJECT, requestId: rid(5), args: { world: WORLD, command: DIG } })).json).toMatchObject({ ok: true, revision: 3 });
  });

  it('reads the world again when its files change behind the running backend (a git checkout): one edit refused, then edits work, no restart', async () => {
    const worldDir = join(backend._test.service.projectDir(PROJECT)!, 'voxels', WORLD);
    const snapshot = (): Map<string, Buffer> => new Map([['world.json', readFileSync(join(worldDir, 'world.json'))], ...(JSON.parse(readFileSync(join(worldDir, 'world.json'), 'utf8')) as { regions: string[] }).regions.map((n): [string, Buffer] => [`grid-0/${n}`, readFileSync(join(worldDir, 'grid-0', n))])]);
    // The world now (revision 3, one dig) is the commit checked out again below; then one more edit moves it on.
    const committed = snapshot();
    const SET = { v: 2, grid: 0, kind: 'set', cells: [0, 12, 0, 1, 12, 0], voxel: { material: 3, role: 3, wetness: 0, shape: 15 } };
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: SET } })).json).toMatchObject({ ok: true, revision: 4, undoable: 2 });
    // A region file alone changed back (the manifest the same bytes): the info serves the file's new tag.
    const [name, bytes] = [...committed].find(([n, b]) => n.startsWith('grid-0/') && !b.equals(readFileSync(join(worldDir, n))))!;
    writeFileSync(join(worldDir, name), bytes);
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { revision: number }; files: Array<{ name: string; etag: string }> };
    expect(info.manifest.revision).toBe(4);
    expect(info.files.find((f) => `grid-0/${f.name}` === name)?.etag).toBe(createHash('sha256').update(bytes).digest('hex'));
    // The whole commit checked out (manifest included); the next edit meets it: refused once, the world read again.
    for (const [n, b] of committed) writeFileSync(join(worldDir, n), b);
    const met = await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: SET } });
    expect(met.status).toBe(409);
    expect(met.json.error).toMatchObject({ code: 'world_changed' });
    expect((met.json.error as { message: string }).message).toMatch(/changed on disk outside this backend .*reloaded at revision 3, undo history cleared/);
    // What the routes serve now is the checked-out commit: the original world with the one dig.
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
    expect(((await command({ op: 'undoVoxels', projectId: PROJECT, args: { world: WORLD } })).json.error as { code: string }).code).toBe('nothing_to_undo');
    // The edit sent again applies on it.
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: SET } })).json).toMatchObject({ ok: true, revision: 4, undoable: 1 });
    applyEdit({ store: () => expected }, canonicalEditCommand(SET));
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
    // Every answer names the derived parts its change makes stale: a geometry change all of them, a change of only
    // wetness or only material the shader data alone (and their undos the same). The material changes ride along
    // (from << 12 | to), turned round by an undo: what tells a client whether a paint moves cells to another kit.
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { ...SET, cells: [0, 13, 0] } } })).json).toMatchObject({ ok: true, parts: ALL_DERIVED_PARTS });
    const WET = { v: 2, grid: 0, kind: 'fill', min: [0, 12, 0], max: [1, 12, 0], mode: 'paint', voxel: { material: 3, role: 3, wetness: 6 } };
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: WET } })).json).toMatchObject({ ok: true, cells: 2, parts: DERIVED_PART.shader, materialSwaps: [] });
    const MATERIAL = { ...WET, voxel: { ...WET.voxel, material: 4 } };
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: MATERIAL } })).json).toMatchObject({ ok: true, cells: 2, parts: DERIVED_PART.shader, materialSwaps: [materialSwap(3, 4)] });
    expect((await command({ op: 'undoVoxels', projectId: PROJECT, args: { world: WORLD } })).json).toMatchObject({ ok: true, parts: DERIVED_PART.shader, materialSwaps: [materialSwap(4, 3)] });
    expect((await command({ op: 'undoVoxels', projectId: PROJECT, args: { world: WORLD } })).json).toMatchObject({ ok: true, parts: DERIVED_PART.shader, materialSwaps: [] });
    expect((await command({ op: 'undoVoxels', projectId: PROJECT, args: { world: WORLD } })).json).toMatchObject({ ok: true, parts: ALL_DERIVED_PARTS });
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
  });

  it('forgets a released project\'s open worlds: their undo history goes and the folder is read again on next use', async () => {
    // The edit above can be undone until the project is released.
    expect(((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: DIG } })).json.error as { code: string }).code).toBe('no_change');
    const released = await fetch(`${base()}/api/v1/admin/projects/${PROJECT}/release`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
    expect(released.status, await released.clone().text()).toBe(200);
    expect(((await command({ op: 'undoVoxels', projectId: PROJECT, args: { world: WORLD } })).json.error as { code: string }).code).toBe('nothing_to_undo');
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
  });

  it('a restarted backend (the same data root) finds the edit in the region files and the revision in the manifest', async () => {
    const revision = ((await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { revision: number } }).manifest.revision;
    await close();
    await start();
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { revision: number } };
    expect(info.manifest.revision).toBe(revision);
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
    // Undo history is the process's: none after a restart.
    expect(((await command({ op: 'undoVoxels', projectId: PROJECT, args: { world: WORLD } })).json.error as { code: string }).code).toBe('nothing_to_undo');
  }, 60_000);

  it('a scene object names the world with a voxelWorld component: set, patched and refused through setComponent, kept on disk and read again', async () => {
    type Read = { status: number; json: Record<string, unknown> };
    const query = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => (await command({ op, projectId: PROJECT, args })).json;
    const revision = async (): Promise<number> => (await query('queryProject', {}))['revision'] as number;
    const send = async (op: string, args: Record<string, unknown>): Promise<Read> => command({ op, projectId: PROJECT, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}`, args });
    const made = await send('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'World' });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const entityId = made.json['createdId'] as string;
    const read = async (): Promise<unknown> => ((await query('queryEntity', { entityId }))['entity'] as { components: Record<string, unknown> }).components['voxelWorld'];
    // Fields in any order; the canonical value holds every one, in order, and nothing the sender did not set.
    const set = await send('setComponent', { entityId, component: 'voxelWorld', value: { savedFields: ['wetness', 'material'], sectionEdge: 32, collision: { height: 20, radius: 40 }, ring: { unloadRadius: 150, loadRadius: 120 }, world: WORLD } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const full = { world: WORLD, ring: { loadRadius: 120, unloadRadius: 150 }, collision: { radius: 40, height: 20 }, sectionEdge: 32, savedFields: ['material', 'wetness'] };
    expect(JSON.stringify(await read())).toBe(JSON.stringify(full));
    // Bad values are refused and change nothing.
    for (const value of [{ sectionEdge: 12 }, { world: 'Bad Name' }, { savedFields: ['colour'] }, { ring: { loadRadius: 0 } }, { climate: 1 }]) {
      const r = await send('setComponent', { entityId, component: 'voxelWorld', value });
      expect(r.status, JSON.stringify(value)).toBe(400);
    }
    expect(JSON.stringify(await read())).toBe(JSON.stringify(full));
    // A field set to null goes back to the engine default (absent), the rest stay.
    expect((await send('setComponent', { entityId, component: 'voxelWorld', value: { sectionEdge: null, collision: null } })).status).toBe(200);
    const patched = { world: WORLD, ring: { loadRadius: 120, unloadRadius: 150 }, savedFields: ['material', 'wetness'] };
    expect(JSON.stringify(await read())).toBe(JSON.stringify(patched));
    // On disk in the scene file, and the same after a restart reads the project again from its files.
    const sceneFile = JSON.parse(readFileSync(join(backend._test.service.projectDir(PROJECT)!, 'scenes', 'scene-main.json'), 'utf8')) as { scene: { entities: Array<{ id: string; components: Record<string, unknown> }> } };
    expect(sceneFile.scene.entities.find((e) => e.id === entityId)!.components['voxelWorld']).toEqual(patched);
    await close();
    await start();
    expect(JSON.stringify(await read())).toBe(JSON.stringify(patched));
  }, 60_000);

  it('a region the manifest lists but that is gone is damaged, never air; a region it does not list is air', async () => {
    const worldDir = join(backend._test.service.projectDir(PROJECT)!, 'voxels', WORLD);
    const manifest = JSON.parse(readFileSync(join(worldDir, 'world.json'), 'utf8')) as { regions: string[] };
    // A listed region other than the one edited below: its loss must not pass as empty ground.
    const lost = manifest.regions.find((n) => n !== 'r.0.0.0.vxr')!;
    expect(lost).toBeDefined();
    const at = parseRegionFileName('stacked', lost)!;
    const inLost: ChunkCoord = { cx: at.rx * 16 + 3, cy: at.ry * 16, cz: at.rz * 16 + 3 };
    const unlisted: ChunkCoord = { cx: 400, cy: 0, cz: 400 };
    expect((await readRaw([inLost]))[0]!.kind).not.toBe('damaged');
    await close();
    rmSync(join(worldDir, 'grid-0', lost));
    // A stray file the manifest does not list is not part of the world: never read.
    writeFileSync(join(worldDir, 'grid-0', 'r.25.0.25.vxr'), readFileSync(join(worldDir, 'grid-0', manifest.regions.find((n) => n !== lost)!)));
    await start();
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { regions: string[] }; files: Array<{ name: string; etag: string | null }> };
    expect(info.manifest.regions).toEqual(manifest.regions);
    expect(info.files.find((f) => f.name === lost)?.etag).toBeNull();
    const route = await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}/regions/${lost}`, { headers: { ...auth, range: 'bytes=0-63' } });
    expect(route.status).toBe(409);
    expect(((await route.json()) as { error: { code: string } }).error.code).toBe('region_damaged');
    expect((await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}/regions/r.25.0.25.vxr`, { headers: auth })).status).toBe(404);
    const [lostRead, unlistedRead, strayRead] = await readRaw([inLost, unlisted, { cx: 25 * 16, cy: 0, cz: 25 * 16 }]);
    expect(lostRead!.kind).toBe('damaged');
    expect(lostRead!.kind === 'damaged' && lostRead!.reason).toMatch(/HTTP 409/);
    expect(unlistedRead!.kind).toBe('air');
    expect(strayRead!.kind).toBe('air');
    // Edits into the lost region are refused before any write; the rest of the world still edits and still lists it.
    const into = await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { v: 2, grid: 0, kind: 'set', cells: [inLost.cx * 32, inLost.cy * 32, inLost.cz * 32], voxel: { material: 3, role: 3, wetness: 0, shape: 15 } } } });
    expect(into.status).toBe(409);
    expect((into.json.error as { code: string }).code).toBe('chunk_not_loaded');
    const elsewhere = await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { v: 2, grid: 0, kind: 'set', cells: [2, 12, 0], voxel: { material: 3, role: 3, wetness: 0, shape: 15 } } } });
    expect(elsewhere.status, JSON.stringify(elsewhere.json)).toBe(200);
    expect((JSON.parse(readFileSync(join(worldDir, 'world.json'), 'utf8')) as { regions: string[] }).regions).toEqual(manifest.regions);
  }, 60_000);

  it('MCP sends the voxel ops through tl_command as the editor page does (the same answer, the same files); the editor\'s feed tells of every change', async () => {
    // The project's editor: a registered authoring session and its WebSocket.
    const sessionId = `sess-${randomBytes(16).toString('hex')}`;
    const est = await fetch(`${base()}/api/v1/sessions`, { method: 'POST', headers: { ...auth, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: PROJECT, sessionId, clientInfo: { kind: 'browser', label: 'voxel-feed' } }) });
    expect(est.status, await est.clone().text()).toBe(200);
    const { wsToken } = (await est.json()) as { wsToken: string };
    const ws = new WebSocket(`${base().replace('http', 'ws')}/api/v1/ws?sessionId=${sessionId}&wsToken=${wsToken}`, { headers: { Origin: ORIGIN } });
    const feed: Array<Record<string, unknown>> = [];
    ws.on('message', (data: Uint8Array) => feed.push(JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const changes = (): Array<Record<string, unknown>> => feed.filter((e) => e.type === 'voxelsChanged');
    const nthChange = async (n: number): Promise<Record<string, unknown>> => {
      for (let t0 = performance.now(); changes().length < n && performance.now() - t0 < 5000; ) await new Promise((r) => setTimeout(r, 10));
      expect(changes().length, JSON.stringify(feed)).toBeGreaterThanOrEqual(n);
      return changes()[n - 1]!;
    };
    /** What the feed must carry of an answer: everything a view reads again by. */
    const asFeed = (a: Record<string, unknown>, origin: unknown): Record<string, unknown> => ({ type: 'voxelsChanged', op: a.op, world: FEED_WORLD, revision: a.revision, chunks: a.chunks, box: a.box, parts: a.parts, materialSwaps: a.materialSwaps, files: a.files, requestId: a.requestId, origin });

    // MCP: the real adapter (tool schema, envelope, origin) over an in-memory transport, against this backend.
    const server = createMcpServer({ client: new BackendClient({ authoringOrigin: base(), token: TOKEN }), projectId: PROJECT, clientId: 'voxel-mcp' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'voxel-mcp-test', version: '0.1.0' });
    await mcp.connect(clientTransport);
    const tool = async (args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
      const res = (await mcp.callTool({ name: 'tl_command', arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      const text = res.content[0]!.text;
      return { isError: res.isError === true, body: (text.startsWith('{') ? JSON.parse(text) : { text }) as Record<string, unknown> };
    };
    try {
      const { tools } = await mcp.listTools();
      const opEnum = ((tools.find((t) => t.name === 'tl_command')!.inputSchema as { properties: { op: { enum: string[] } } }).properties.op.enum);
      expect(opEnum).toEqual(expect.arrayContaining(['editVoxels', 'undoVoxels', 'createEntity']));

      // The page's edit, sent as the page sends it, then taken back: the world as written again.
      const page = await command({ op: 'editVoxels', projectId: PROJECT, requestId: rid(100), args: { world: FEED_WORLD, command: DIG } });
      expect(page.status, JSON.stringify(page.json)).toBe(200);
      expect(page.json).toMatchObject({ ok: true, revision: 1 });
      expect(await nthChange(1)).toEqual(asFeed(page.json, null));
      const pageUndo = await command({ op: 'undoVoxels', projectId: PROJECT, requestId: rid(101), args: { world: FEED_WORLD } });
      expect(pageUndo.json).toMatchObject({ ok: true, revision: 2, undoable: 0 });
      expect(await nthChange(2)).toEqual(asFeed(pageUndo.json, null));
      expectSame(await readChunks(SCENE_CHUNKS, FEED_WORLD), sceneStore(), SCENE_CHUNKS);

      // The same stroke through tl_command (no expectedRevision: a world keeps its own): the page's answer, the same file bytes.
      const viaMcp = await tool({ op: 'editVoxels', args: { world: FEED_WORLD, command: DIG } });
      expect(viaMcp.isError, JSON.stringify(viaMcp.body)).toBe(false);
      expect(viaMcp.body).toMatchObject({ ok: true, op: 'editVoxels', revision: 3, undoable: 1, duplicated: false });
      for (const k of ['cells', 'chunks', 'box', 'parts', 'materialSwaps', 'files']) expect(viaMcp.body[k], k).toEqual(page.json[k]);
      const oracle = sceneStore();
      applyEdit({ store: () => oracle }, canonicalEditCommand(DIG));
      expectSame(await readChunks(SCENE_CHUNKS, FEED_WORLD), oracle, SCENE_CHUNKS);
      // The editor learns of it, named as MCP's.
      expect(await nthChange(3)).toEqual(asFeed(viaMcp.body, { kind: 'mcp', clientId: 'voxel-mcp' }));

      // A request id sent again answers the first answer and tells nobody twice; undo through MCP takes the stroke back.
      const again = await tool({ op: 'editVoxels', requestId: viaMcp.body.requestId, args: { world: FEED_WORLD, command: DIG } });
      expect(again.body).toMatchObject({ ok: true, revision: 3, duplicated: true });
      const undo = await tool({ op: 'undoVoxels', args: { world: FEED_WORLD } });
      expect(undo.body).toMatchObject({ ok: true, op: 'undoVoxels', revision: 4, undoable: 0, cells: page.json.cells });
      expect(await nthChange(4)).toEqual(asFeed(undo.body, { kind: 'mcp', clientId: 'voxel-mcp' }));
      expect(changes().map((e) => e.revision)).toEqual([1, 2, 3, 4]);
      expectSame(await readChunks(SCENE_CHUNKS, FEED_WORLD), sceneStore(), SCENE_CHUNKS);

      // Refusals come back as the backend's, and send nothing to the feed.
      const none = await tool({ op: 'undoVoxels', args: { world: FEED_WORLD } });
      expect(none.isError).toBe(true);
      expect(JSON.stringify(none.body)).toContain('nothing_to_undo');
      const badOrigin = await command({ op: 'editVoxels', projectId: PROJECT, origin: { kind: 'robot', clientId: 'x' }, args: { world: FEED_WORLD, command: DIG } });
      expect(badOrigin.status).toBe(400);
      expect(badOrigin.json.error).toMatchObject({ code: 'invalid_request', path: '/origin/kind' });
      // The page's own session sends as a browser now that it is registered: the feed names it.
      const browser = await command({ op: 'editVoxels', projectId: PROJECT, requestId: rid(102), origin: { kind: 'browser', clientId: sessionId }, args: { world: FEED_WORLD, command: DIG } });
      expect(browser.json).toMatchObject({ ok: true, revision: 5 });
      expect(await nthChange(5)).toEqual(asFeed(browser.json, { kind: 'browser', clientId: sessionId }));
      expect(changes().length).toBe(5);
    } finally {
      await mcp.close();
      await server.close();
      ws.close();
    }
  });

  it('a voxel kit is a project content item: set, replaced, refused and deleted over HTTP and through MCP, one undo each, its own file on disk, read back after a restart', async () => {
    const query = async (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await command({ op, projectId: PROJECT, args })).json;
    const send = async (op: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => command({ op, projectId: PROJECT, expectedRevision: (await query('queryProject'))['revision'] as number, requestId: `req-${randomBytes(16).toString('hex')}`, args });
    const kits = async (): Promise<Array<Record<string, unknown>>> => (await query('queryGameConfig'))['voxelKits'] as Array<Record<string, unknown>>;
    // The pieces' model: a GLB imported as every model is (its version's source digest is what a kit's mesh names).
    const dir = backend._test.service.projectDir(PROJECT)!;
    mkdirSync(join(dir, 'assets', 'kits'), { recursive: true });
    const glb = pieceGlb();
    writeFileSync(join(dir, 'assets', 'kits', 'log-pieces.glb'), glb);
    const imported = await send('importAssets', { folder: 'assets/kits' });
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);
    const captured = backend._test.service.readCapturedV3(PROJECT);
    if (!captured.ok) throw new Error(captured.error.code);
    const model = (captured.read.content as { assets: Array<{ assetId: string; kind: string; versions: Array<{ sourceDigest: string }> }> }).assets.find((a) => a.kind === 'model')!;
    const digest = model.versions[0]!.sourceDigest;
    expect(digest).toBe(createHash('sha256').update(glb).digest('hex'));
    KIT_MODEL.assetId = model.assetId;
    const kit = logKit(model.assetId, digest);

    // Created over HTTP; read back in canonical form (cases by id, the default weight left out, game data as given).
    const made = await send('setVoxelKit', { kit });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(made.json['change']).toMatchObject({ type: 'setVoxelKit', voxelKitId: 'log', previous: null });
    const stored = (await kits())[0]!;
    expect(Object.keys(stored)).toEqual(['kitFormat', 'voxelKitId', 'name', 'version', 'materialType', 'materials', 'cases', 'joinProfiles', 'gameData']);
    expect(Object.keys(stored['cases'] as object)).toEqual(['beam', 'wall-banister']);
    expect(stored['gameData']).toEqual(kit.gameData);
    // Its own file in the game folder (the resource kind's folder), holding the record.
    const file = join(dir, 'assets', 'voxel-kits', 'log.voxelkit.json');
    expect(JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))).toContain('"voxelKitId":"log"');
    console.log(`[voxel kit] ${Object.keys(stored['cases'] as object).length} cases: file ${statSync(file).size} bytes, record ${JSON.stringify(stored).length} bytes compact`);
    // A newer format and an unknown field are refused and change nothing.
    for (const bad of [{ ...kit, kitFormat: 2 }, { ...kit, pieces: {} }]) {
      const r = await send('setVoxelKit', { kit: bad });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
    }
    expect((await kits())[0]).toEqual(stored);

    // MCP's tl_command sends the same op (its op list has both); undo takes the replacement back in one step.
    const server = createMcpServer({ client: new BackendClient({ authoringOrigin: base(), token: TOKEN }), projectId: PROJECT, clientId: 'voxel-kit-mcp' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'voxel-kit-mcp-test', version: '0.1.0' });
    await mcp.connect(clientTransport);
    try {
      const { tools } = await mcp.listTools();
      const opEnum = (tools.find((t) => t.name === 'tl_command')!.inputSchema as { properties: { op: { enum: string[] } } }).properties.op.enum;
      expect(opEnum).toEqual(expect.arrayContaining(['setVoxelKit', 'deleteVoxelKit']));
      const res = (await mcp.callTool({ name: 'tl_command', arguments: { op: 'setVoxelKit', expectedRevision: (await query('queryProject'))['revision'], args: { kit: { ...kit, version: 2 } } } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError === true, res.content[0]!.text).toBe(false);
      expect((await kits())[0]!['version']).toBe(2);
      const game = (await mcp.callTool({ name: 'tl_content_query', arguments: { target: 'game' } })) as { content: Array<{ text: string }> };
      expect((JSON.parse(game.content[0]!.text) as { voxelKits: Array<{ version: number }> }).voxelKits[0]!.version).toBe(2);
    } finally {
      await mcp.close();
      await server.close();
    }
    expect((await send('undo', {})).status).toBe(200);
    expect((await kits())[0]).toEqual(stored);

    // Deleted (its file goes), undone (it comes back); kept across a restart that reads the project from its files.
    expect((await send('deleteVoxelKit', { voxelKitId: 'log' })).status).toBe(200);
    expect(await kits()).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect((await send('undo', {})).status).toBe(200);
    expect(existsSync(file)).toBe(true);
    await close();
    await start();
    expect(await kits()).toEqual([stored]);
  }, 60_000);

  it("the voxel kit check puts a broken kit's rows in the project's Problems (the HTTP log and MCP's tl_diagnostics); a kit that passes adds none", async () => {
    expect(KIT_MODEL.assetId).not.toBe('');
    const query = async (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await command({ op, projectId: PROJECT, args })).json;
    const send = async (op: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => command({ op, projectId: PROJECT, expectedRevision: (await query('queryProject'))['revision'] as number, requestId: `req-${randomBytes(16).toString('hex')}`, args });
    const problems = async (): Promise<string[]> => ((await (await fetch(`${base()}/api/v1/projects/${PROJECT}/problems`, { headers: auth })).json()) as { problems: Array<{ code: string; message: string }> }).problems.filter((p) => p.code === 'voxel_kit_check').map((p) => p.message);
    const captured = backend._test.service.readCapturedV3(PROJECT);
    if (!captured.ok) throw new Error(captured.error.code);
    const digest = (captured.read.content as { assets: Array<{ assetId: string; versions: Array<{ sourceDigest: string }> }> }).assets.find((a) => a.assetId === KIT_MODEL.assetId)!.versions[0]!.sourceDigest;
    // A kit whose one beam piece is the imported triangle (on its cell, a readable model): no error or warning but the cases it lacks.
    const one = (high: VoxelKitMesh) => ({ sections: { body: { variants: [{ high }] } } });
    const broken: VoxelKit = {
      kitFormat: 1,
      voxelKitId: 'broken',
      name: 'Broken',
      version: 1,
      materialType: 'stone',
      cases: {
        gazebo: one({ assetId: KIT_MODEL.assetId, digest }),
        beam: one({ assetId: KIT_MODEL.assetId, digest: 'f'.repeat(64), node: 'No_Such_Node' }),
        'edge-out-top': one({ assetId: 'no-such-model', digest }),
      },
    };
    const before = (await problems()).length;
    expect((await send('setVoxelKit', { kit: broken })).status).toBe(200);
    let lines: string[] = [];
    for (let i = 0; i < 100 && lines.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      lines = (await problems()).slice(before).filter((l) => l.includes('(broken)'));
    }
    expect(lines.find((l) => l.includes('error: Names cases or sections the catalogue does not have'))).toMatch(/case gazebo/);
    expect(lines.find((l) => l.includes('meshes cannot be drawn'))).toMatch(/^Voxel kit "Broken" \(broken\) error: .*no such model: edge-out-top\/body \(no-such-model\).*no such node: beam\/body/);
    expect(lines.find((l) => l.includes('name a file version the model does not have'))).toMatch(/warning/);
    expect(lines.find((l) => l.includes('required rows'))).toMatch(/warning: \d+ required rows: Required case edge-out-vertical has no piece/);
    // MCP reads the same log.
    const server = createMcpServer({ client: new BackendClient({ authoringOrigin: base(), token: TOKEN }), projectId: PROJECT, clientId: 'voxel-kit-check-mcp' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'voxel-kit-check-test', version: '0.1.0' });
    await mcp.connect(clientTransport);
    try {
      const diag = (await mcp.callTool({ name: 'tl_diagnostics', arguments: {} })) as { content: Array<{ text: string }> };
      expect(diag.content.map((c) => c.text).join('\n')).toMatch(/Voxel kit \\"Broken\\" \(broken\) error: 2 meshes cannot be drawn/);
    } finally {
      await mcp.close();
    }
    // Mended (the beam on the file's own digest and node, the unknown and missing pieces gone): only the cases it lacks remain warnings.
    const mended: VoxelKit = { ...broken, version: 2, cases: { beam: one({ assetId: KIT_MODEL.assetId, digest, node: 'Beam_Body' }) } };
    const mark = (await problems()).length;
    expect((await send('setVoxelKit', { kit: mended })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const after = (await problems()).slice(mark).filter((l) => l.includes('(broken)'));
    expect(after.filter((l) => / error/.test(l.split(':')[0]!))).toEqual([]);
    expect(after.some((l) => l.includes('required rows'))).toBe(true);
    expect((await send('deleteVoxelKit', { voxelKitId: 'broken' })).status).toBe(200);
  }, 60_000);

  it('writes the kit test scene into a world as one command: every labelled cell derives as its case and section from the files, the same scene again is no_change, one undo takes it back', async () => {
    const dir = backend._test.service.projectDir(PROJECT)!;
    writeVoxelWorld(join(dir, 'voxels', SCENE_WORLD), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, sceneStore());
    const args = { world: SCENE_WORLD, origin: [-40, -5, -30], material: 11 };
    expect(((await command({ op: 'writeKitTestScene', projectId: PROJECT, args: { ...args, material: 0 } })).json.error as { code: string }).code).toBe('invalid_args');
    expect(((await command({ op: 'writeKitTestScene', projectId: PROJECT, args: { ...args, origin: [0, 0.5, 0] } })).json.error as { code: string }).code).toBe('invalid_args');
    expect(((await command({ op: 'writeKitTestScene', projectId: PROJECT, args: { ...args, kit: 'log' } })).json.error as { code: string }).code).toBe('invalid_request');
    const r = await command({ op: 'writeKitTestScene', projectId: PROJECT, requestId: rid(300), args });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    const scene = r.json.scene as { min: number[]; max: number[]; labels: Array<{ cell: [number, number, number]; roleName: string; caseId: string; section: string | null }> };
    const want = kitTestScene(WORLD_RULES, { origin: args.origin as [number, number, number], material: 11 });
    expect(scene).toEqual(JSON.parse(JSON.stringify({ min: want.min, max: want.max, labels: want.labels })));
    expect(r.json).toMatchObject({ ok: true, op: 'writeKitTestScene', revision: 1, undoable: 1, box: { minX: -40, minY: -5, minZ: -30, maxX: want.max[0], maxY: want.max[1], maxZ: want.max[2] } });
    // The world read back through the range route, as a browser reads it: each label's cell gets its case and section.
    const chunks = (r.json.chunks as Array<[number, number, number]>).map(([cx, cy, cz]) => ({ cx, cy, cz }));
    expect(new Set(chunks.map((c) => `${c.cx},${c.cy},${c.cz}`)).size).toBe(chunks.length);
    const around: ChunkCoord[] = [];
    for (let cx = (want.min[0]! >> 5) - 1; cx <= (want.max[0]! >> 5) + 1; cx++) for (let cy = (want.min[1]! >> 5) - 1; cy <= (want.max[1]! >> 5) + 1; cy++) for (let cz = (want.min[2]! >> 5) - 1; cz <= (want.max[2]! >> 5) + 1; cz++) around.push({ cx, cy, cz });
    const store = await readChunks(around, SCENE_WORLD);
    // The window cases (beams and banisters) read back as their case and section; the sampler's pass cases (edges,
    // roof edges, debris) are the derive's pieces, not a window case, and are checked through the derive in vitest.
    const windowCases = new Set(WORLD_RULES.catalogue!.rules.map((x) => x.case));
    const windows = scene.labels.filter((l) => windowCases.has(l.caseId));
    const got = windows.map((l) => ({ cell: l.cell, ...caseAndSectionAt(store, ...l.cell) }));
    expect(got).toEqual(windows.map((l) => ({ cell: l.cell, caseId: l.caseId, section: l.section })));
    // Every case of the catalogue is labelled: one exhibit a window case and role, one sampler cell a pass case.
    expect(new Set(scene.labels.map((l) => l.caseId))).toEqual(new Set(WORLD_RULES.catalogue!.cases.map((c) => c.id)));
    expect(((await command({ op: 'writeKitTestScene', projectId: PROJECT, args })).json.error as { code: string }).code).toBe('no_change');
    const undone = await command({ op: 'undoVoxels', projectId: PROJECT, args: { world: SCENE_WORLD } });
    expect(undone.json).toMatchObject({ ok: true, revision: 2, undoable: 0, cells: r.json.cells });
    expectSame(await readChunks(around, SCENE_WORLD), sceneStore(), around);
  }, 60_000);

  it("an export ships the worlds its scenes name: each listed region file whole as a content file, listed in the catalog with its digest, the voxel worker beside the game's scripts; a world with a damaged region refuses the export", async () => {
    const query = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => (await command({ op, projectId: PROJECT, args })).json;
    const send = async (op: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => command({ op, projectId: PROJECT, expectedRevision: (await query('queryProject', {}))['revision'] as number, requestId: `req-${randomBytes(16).toString('hex')}`, args });
    const exportNow = async (): Promise<{ status: number; json: Record<string, unknown> }> => {
      const r = await fetch(`${base()}/api/v1/admin/projects/${PROJECT}/export`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    const made = await send('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Feed world', components: { voxelWorld: { world: FEED_WORLD } } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    // The scene's other world object names the world a test above left with a listed region gone: no export ships holes.
    const refused = await exportNow();
    expect(refused.status, JSON.stringify(refused.json)).toBe(400);
    expect(refused.json['error']).toMatchObject({ code: 'export_scene_invalid', reason: 'voxel_world' });
    expect(String((refused.json['error'] as { message: string }).message)).toMatch(new RegExp(`voxel world ${WORLD}: .*region_damaged`));
    const listed = (await query('queryEntities', { limit: 16_384 })) as { entities: Array<{ id: string; components: Record<string, unknown> }> };
    for (const e of listed.entities) if ((e.components['voxelWorld'] as { world?: string } | undefined)?.world === WORLD) expect((await send('deleteEntity', { entityId: e.id })).status).toBe(200);

    const ok = await exportNow();
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const out = join(root, 'exports', String(ok.json['outputDir']));
    const files = Object.keys(ok.json['files'] as Record<string, number>);
    for (const f of ['js/main.js', 'js/sim-worker.js', 'js/voxel-worker.js']) expect(files).toContain(f);
    // The catalog lists the world as the backend holds it: the manifest's fields, and every listed file with its digest.
    const content = readRuntimeContentSync(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), (path) => {
      try {
        return new Uint8Array(readFileSync(join(out, path)));
      } catch {
        return null;
      }
    }) as unknown as { voxelWorlds?: ShippedVoxelWorld[] };
    // The voxel kit ships whole in its own catalog block (game data as authored); its pieces' model ships as every model does.
    const shippedKits = (content as unknown as { voxelKits?: Array<Record<string, unknown>> }).voxelKits;
    expect(shippedKits?.map((k) => k['voxelKitId'])).toEqual(['log']);
    expect(shippedKits![0]!['gameData']).toEqual(logKit(KIT_MODEL.assetId, 'x').gameData);
    const kitMesh = (shippedKits![0]!['cases'] as Record<string, { sections: Record<string, { variants: Array<{ high: { digest: string } }> }> }>)['beam']!.sections['body']!.variants[0]!.high;
    expect(readFileSync(join(out, 'content', 'sha256', kitMesh.digest)).equals(pieceGlb())).toBe(true);
    expect(((content as unknown as { dependencies?: Array<{ assetId: string }> }).dependencies ?? []).map((e) => e.assetId)).toContain(KIT_MODEL.assetId);
    await kitMeshAfterReimport(KIT_MODEL.assetId, kitMesh.digest, send, exportNow);
    const worldDir = join(backend._test.service.projectDir(PROJECT)!, 'voxels', FEED_WORLD);
    const manifest = JSON.parse(readFileSync(join(worldDir, 'world.json'), 'utf8')) as { worldId: string; regions: string[]; revision: number };
    expect(content.voxelWorlds?.length).toBe(1);
    const shipped = content.voxelWorlds![0]!;
    expect({ ...shipped, files: undefined }).toEqual({ world: FEED_WORLD, worldId: manifest.worldId, edge: 32, layout: 'stacked', footprint: 512, revision: manifest.revision, files: undefined });
    expect(shipped.files.map((f) => f.name)).toEqual(manifest.regions);
    let regionBytes = 0;
    for (const f of shipped.files) {
      const source = readFileSync(join(worldDir, 'grid-0', f.name));
      expect(f.digest).toBe(createHash('sha256').update(source).digest('hex'));
      expect(f.byteLength).toBe(source.length);
      // Whole, byte for byte, at its content path (listed in the export's files).
      expect(readFileSync(join(out, 'content', 'sha256', f.digest)).equals(source)).toBe(true);
      expect(files).toContain(`content/sha256/${f.digest}`);
      regionBytes += f.byteLength;
    }
    // The voxel worker is the engine's code alone: no backend, no origins, no tokens, no Node module.
    const worker = readFileSync(join(out, 'js', 'voxel-worker.js'), 'utf8');
    for (const needle of [ORIGIN, 'http://127.0.0.1:8502', TOKEN, ADMIN, '/api/v1/', '/mcp', 'WebSocket']) expect(worker.includes(needle), needle).toBe(false);
    expect(worker.match(/["'`]node:/g) ?? []).toEqual([]);
    // Read back from the export as the game reads it (whole files, checked by digest): the same chunks as the backend's range route.
    const source = shippedChunkSource(shipped, async (f) => {
      const b = new Uint8Array(readFileSync(join(out, 'content', 'sha256', f.digest)));
      if (createHash('sha256').update(b).digest('hex') !== f.digest) throw new Error('digest');
      return b;
    });
    const chunks: ChunkCoord[] = [];
    for (let cx = -2; cx < 2; cx++) for (let cy = -2; cy < 2; cy++) for (let cz = -2; cz < 2; cz++) chunks.push({ cx, cy, cz });
    const [fromExport, fromRoute] = [await source.read(chunks), await readRaw(chunks, FEED_WORLD)];
    expect(fromExport.filter((r) => r.kind === 'stored').length).toBeGreaterThan(0);
    expect(fromExport.map((r) => (r.kind === 'stored' ? `${r.kind}:${createHash('sha256').update(r.bytes).digest('hex')}` : r.kind))).toEqual(fromRoute.map((r) => (r.kind === 'stored' ? `${r.kind}:${createHash('sha256').update(r.bytes).digest('hex')}` : r.kind)));
    const total = readdirSync(join(out, 'js')).reduce((n, f) => n + statSync(join(out, 'js', f)).size, 0);
    console.log(`[voxel export] ${shipped.files.length} region files, ${regionBytes} bytes; js/ ${total} bytes (voxel worker ${worker.length})`);
  }, 120_000);
});
