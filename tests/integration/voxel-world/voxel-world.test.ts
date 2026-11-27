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
 * and MCP), a material's physics, game data and voxel use and a physical
 * profile through the same command path (refusals, a restart), the kit test scene written as one command (each label's cell
 * deriving as its case from the files, no_change again, one undo), and an
 * export shipping the worlds its scenes name
 * (each listed region file whole, by digest) and the voxel kits (their block,
 * their pieces' model, each with the material ids it binds), the materials
 * with their parts and resolved physics, the voxel surfaces' texture arrays
 * (assembled from the voxel materials' surface sets, the same bytes the
 * editor's route answers, the height in the albedo array's A, an opaque
 * albedo given its brightness, the normal array's A unused), or refusing
 * a damaged world; and the strokes of command version 3 (a flood with
 * liquid, a fading gas and a drain, a leak refused with its places, smooth,
 * flatten, a paint that keeps each cell's role), each against the oracle
 * and taken back and applied again on the project's one undo line; the
 * editor's voxel brush tool driven against the route (its drags, then its
 * fog brush and its fills: fog never written over ground or water, a
 * breached fill refused and marked).
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
  readValue,
  recordValue,
  RegionChunkSource,
  sameDenseChunk,
  SHAPE_FULL,
  isGasRole,
  isMediumRole,
  valueOf,
  valueRole,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  type BrushEdit,
  type ChunkCoord,
  shippedChunkSource,
  type RegionChunkRead,
  type PaletteStore,
  type ShippedVoxelWorld,
  WORLD_RULES,
} from '@thirdlight/voxel';
import { coverPointAt, readKtx2Layout, readRuntimeContentSync, textureSlotSetKey, voxelCoverOfCells, voxelCoverTable, voxelSurfaceTextures, type DressingDef, type MaterialDef, type MaterialVoxel, type VoxelKit, type VoxelKitMesh } from '@thirdlight/project-model';
import { glbBytes, hexToBytes } from '@thirdlight/shared';
import { importRead, RegionWorld, writeVoxelWorld } from '@thirdlight/workspace';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { brushStore, resetBrushStores } from '../../../packages/editor/src/session/brush';
import { materialWithDressing, noiseWith, rangeWith, withCondition, withSpecies, withSpeciesAdded, withSpeciesMoved, withSpeciesRemoved } from '../../../packages/editor/src/session/dressing-edits';
import { STARTER_GROUNDS, starterGround } from '../../../packages/editor/src/session/world-mode';
import { FOG_BRUSH, FOG_BRUSH_BOUNDS, surfaceHeightCells, VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS } from '../../../packages/editor/src/session/voxel-brush';
import { VoxelBrushTool, type VoxelBrushArm } from '../../../packages/editor/src/viewport/voxel-brush-tool';
import { BackendClient } from '../../../packages/mcp-adapter/src/backend-client';
import { createMcpServer } from '../../../packages/mcp-adapter/src/server';
import { caseAt } from '../../../tools/voxel-bench/case-probe';
import { flatGround, placeWallBeamBanister } from '../../../tools/voxel-bench/scenes';
import { placeholderLook, placeholderPng, placeholderSet } from '../../../tools/voxel-bench/texture-sets';
import { transcodeKtx2Levels } from '../../../tools/voxel-bench/three-basis';

/** Every derived part there is (a geometry change feeds them all, the gas part too, which no derive builds yet). */
const EVERY_PART = Object.values(DERIVED_PART).reduce((m, bit) => m | bit, 0);

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
    slots: {
      // One mesh filling two slots, the second turned under; the default weight given.
      'edge-out-top': { meshes: [{ mesh: { assetId, digest, node: 'Beam_Body' }, weight: 1 }] },
      'edge-out-bottom': { meshes: [{ mesh: { assetId, digest, node: 'Beam_Body' }, rotation: 5 }], gameData: { break: { hits: 1 } } },
    },
    gameData: { sound: { hit: 'wood-knock' }, physics: { density: 0.6 }, tags: ['flammable', 2, null] },
  };
}

/** A material with the material model's parts (its voxel id is one the log kit's test list does not name). */
const OAK_MATERIAL = {
  materialId: 'oak',
  name: 'Oak',
  shader: 'standard',
  params: {},
  textures: {},
  physical: { profile: 'oak-wood', friction: 0.55 },
  gameData: { break: { hits: 3 } },
  voxel: { id: 12, use: 'construction', kit: 'log', tileMetres: 4, heightDepth: 0.03 },
};

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

/** The project's one undo (or redo) as the editor sends it, against the project's revision now; `voxels` is a stroke step's world answer. */
const step = async (op: 'undo' | 'redo' = 'undo', requestId = `req-${randomBytes(16).toString('hex')}`): Promise<{ status: number; json: Record<string, unknown>; voxels: Record<string, unknown> | undefined; code: string | undefined }> => {
  const revision = (await command({ op: 'queryProject', projectId: PROJECT, args: {} })).json['revision'] as number;
  const r = await command({ op, projectId: PROJECT, expectedRevision: revision, requestId, args: {} });
  return { ...r, voxels: r.json['voxels'] as Record<string, unknown> | undefined, code: (r.json['error'] as { code?: string } | undefined)?.code };
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
    expect(info.manifest).toMatchObject({ format: 3, grids: [], revision: 0, layout: 'stacked', edge: 32, footprint: 512, worldId: WORLD_ID });
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
      // Refused before any cell is visited: one that was not would hold the backend past the test's timeout.
      const r = await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: huge } });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatchObject({ code: 'over_budget' });
      expect((r.json.error as { message: string }).message).toMatch(/more than 341 chunks of 32³ cells .* over the 64\.0 MiB undo budget of one edit/);
    }
    const browser = await command({ op: 'editVoxels', projectId: PROJECT, origin: { kind: 'browser' }, args: { world: WORLD, command: DIG } });
    expect(browser.status).toBe(403);
    expect((browser.json.error as { code: string }).code).toBe('session_required');
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { revision: number } };
    expect(info.manifest.revision).toBe(1);
  });

  it("the project's one undo takes the newest stroke back as a new revision and its redo writes the stroke's voxels again; nothing left is refused", async () => {
    const r = await step('undo', rid(4));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // A stroke's step: the project's revision as it was, the world's answer under voxels.
    expect(r.json).toMatchObject({ ok: true, op: 'undo', revision: (await command({ op: 'queryProject', projectId: PROJECT, args: {} })).json['revision'], duplicated: false });
    // It names the cells and chunks the edit changed: the same ones go back.
    expect(r.voxels).toMatchObject({ ok: true, op: 'undo', revision: 2, undoable: 0, redoable: 1, cells: applyEdit({ store: () => sceneStore() }, canonicalEditCommand(DIG)).cells });
    expect((r.voxels!.chunks as unknown[]).length).toBe(4);
    // And the box of the edit it takes back, so a client re-derives only what that edit could change.
    expect(r.voxels!.box).toEqual(editBounds(grid, canonicalEditCommand(DIG)));
    expectSame(await readChunks(SCENE_CHUNKS), original, SCENE_CHUNKS);
    // The same request id again answers the first answer: nothing else is undone.
    expect((await step('undo', rid(4))).json).toMatchObject({ ok: true, duplicated: true });
    const none = await step('undo');
    expect(none.status).toBe(503);
    expect(none.code).toBe('history_empty');
    // The redo writes back exactly the voxels the undo took: the dug world, as the oracle digs it.
    expected = sceneStore();
    applyEdit({ store: () => expected }, canonicalEditCommand(DIG));
    const redo = await step('redo');
    expect(redo.voxels).toMatchObject({ ok: true, op: 'redo', revision: 3, undoable: 1, redoable: 0, cells: r.voxels!.cells, chunks: r.voxels!.chunks, box: r.voxels!.box });
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
    expect((await step('redo')).code).toBe('history_empty');
    // A stale world revision on a stroke is refused with the world's, the way a project command is.
    const stale = await command({ op: 'editVoxels', projectId: PROJECT, expectedRevision: 2, args: { world: WORLD, command: DIG } });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatchObject({ code: 'revision_conflict', expectedRevision: 2, currentRevision: 3 });
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
    // The strokes the line held are gone with the history the world dropped: skipped and named, nothing else undone.
    const skipped = await step('undo');
    expect(skipped.code).toBe('history_empty');
    expect((skipped.json['skipped'] as Array<{ world: string }>).map((k) => k.world)).toEqual([WORLD, WORLD]);
    // The edit sent again applies on it.
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: SET } })).json).toMatchObject({ ok: true, revision: 4, undoable: 1 });
    applyEdit({ store: () => expected }, canonicalEditCommand(SET));
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
    // Every answer names the derived parts its change makes stale: a geometry change all of them, a change of only
    // wetness or only material the shader data alone (and their undos the same). The material changes ride along
    // (from << 12 | to), turned round by an undo: what tells a client whether a paint moves cells to another kit.
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { ...SET, cells: [0, 13, 0] } } })).json).toMatchObject({ ok: true, parts: EVERY_PART });
    const WET = { v: 2, grid: 0, kind: 'fill', min: [0, 12, 0], max: [1, 12, 0], mode: 'paint', voxel: { material: 3, role: 3, wetness: 6 } };
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: WET } })).json).toMatchObject({ ok: true, cells: 2, parts: DERIVED_PART.shader, materialSwaps: [] });
    const MATERIAL = { ...WET, voxel: { ...WET.voxel, material: 4 } };
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: MATERIAL } })).json).toMatchObject({ ok: true, cells: 2, parts: DERIVED_PART.shader, materialSwaps: [materialSwap(3, 4)] });
    expect((await step()).voxels).toMatchObject({ ok: true, parts: DERIVED_PART.shader, materialSwaps: [materialSwap(4, 3)] });
    expect((await step()).voxels).toMatchObject({ ok: true, parts: DERIVED_PART.shader, materialSwaps: [] });
    expect((await step()).voxels).toMatchObject({ ok: true, parts: EVERY_PART });
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
    // A change only between air and gas (role 10, its shape a density), or of a gas's density or material, feeds the
    // gas part alone, and so do their undos.
    const MIST = { v: 2, grid: 0, kind: 'set', cells: [0, 14, 0, 1, 14, 0], voxel: { material: 6, role: 10, wetness: 0, shape: 9 } };
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: MIST } })).json).toMatchObject({ ok: true, cells: 2, parts: DERIVED_PART.gas });
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { ...MIST, voxel: { ...MIST.voxel, material: 7, shape: 3 } } } })).json).toMatchObject({ ok: true, cells: 2, parts: DERIVED_PART.gas, materialSwaps: [materialSwap(6, 7)] });
    expect((await step()).voxels).toMatchObject({ ok: true, parts: DERIVED_PART.gas });
    expect((await step()).voxels).toMatchObject({ ok: true, parts: DERIVED_PART.gas });
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
    // A change only between air and liquid, or of a liquid's fill or material, feeds the liquid part alone (every other
    // part reads liquid as air), and so do their undos; liquid written into a built cell feeds every part.
    const WATER = { v: 2, grid: 0, kind: 'set', cells: [0, 14, 0, 1, 14, 0], voxel: { material: 3, role: 2, wetness: 0, shape: 15 } };
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: WATER } })).json).toMatchObject({ ok: true, cells: 2, parts: DERIVED_PART.liquid });
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { ...WATER, voxel: { ...WATER.voxel, material: 4, shape: 6 } } } })).json).toMatchObject({ ok: true, cells: 2, parts: DERIVED_PART.liquid, materialSwaps: [materialSwap(3, 4)] });
    expect((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { ...WATER, cells: [0, 12, 0] } } })).json).toMatchObject({ ok: true, cells: 1, parts: EVERY_PART });
    expect((await step()).voxels).toMatchObject({ ok: true, parts: EVERY_PART });
    expect((await step()).voxels).toMatchObject({ ok: true, parts: DERIVED_PART.liquid });
    expect((await step()).voxels).toMatchObject({ ok: true, parts: DERIVED_PART.liquid });
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
  });

  it('forgets a released project\'s open worlds: their undo history goes and the folder is read again on next use', async () => {
    // The edit above can be undone until the project is released.
    expect(((await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: DIG } })).json.error as { code: string }).code).toBe('no_change');
    const released = await fetch(`${base()}/api/v1/admin/projects/${PROJECT}/release`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
    expect(released.status, await released.clone().text()).toBe(200);
    const after = await step('undo');
    expect(after.voxels).toBeUndefined();
    // Every stroke the line held of the world (the one still applied and the three undone above) is named.
    expect((after.json['skipped'] as Array<{ world: string }>).map((k) => k.world)).toEqual([WORLD, WORLD, WORLD, WORLD]);
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
    const none = await step('undo');
    expect(none.code).toBe('history_empty');
    expect(none.json['skipped']).toBeUndefined();
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
    // Two structure grids listed: grid 4's file written (its own folder), grid 6's listed but gone: damaged as the world grid's.
    const house = createWorldStore(grid);
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) house.setVoxel(x, y, 0, { material: 3, role: 3, shape: 15, wetness: 0 });
    const gridFiles = RegionWorld.create(join(worldDir, 'grid-4'), { grid, worldId: hexToBytes(WORLD_ID), layout: 'stacked', footprint: 512, gridId: 4 }, house).listedRegions();
    const listedGrids = [{ id: 4, regions: gridFiles }, { id: 6, regions: ['r.0.0.0.vxr'] }];
    writeFileSync(join(worldDir, 'world.json'), `${JSON.stringify({ ...manifest, grids: listedGrids }, null, 2)}\n`);
    await start();
    const gridUrl = (id: number, file: string): string => `${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}/grids/${id}/regions/${file}`;
    const own = await fetch(gridUrl(4, gridFiles[0]!), { headers: auth });
    expect(own.status).toBe(200);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(new Uint8Array(readFileSync(join(worldDir, 'grid-4', gridFiles[0]!))));
    const gone = await fetch(gridUrl(6, 'r.0.0.0.vxr'), { headers: auth });
    expect([gone.status, ((await gone.json()) as { error: { code: string } }).error.code]).toEqual([409, 'region_damaged']);
    expect((await fetch(gridUrl(5, 'r.0.0.0.vxr'), { headers: auth })).status).toBe(404);
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { regions: string[] }; files: Array<{ name: string; etag: string | null }>; grids: Array<{ id: number; files: Array<{ name: string; etag: string | null }> }> };
    expect(info.manifest.regions).toEqual(manifest.regions);
    expect(info.grids.map((g) => [g.id, g.files.map((f) => f.etag !== null)])).toEqual([[4, [true]], [6, [false]]]);
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
    // An edit of the world grid keeps the structure grids listed.
    expect(JSON.parse(readFileSync(join(worldDir, 'world.json'), 'utf8')) as { regions: string[] }).toMatchObject({ regions: manifest.regions, grids: listedGrids });
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
      expect(opEnum).toEqual(expect.arrayContaining(['editVoxels', 'writeKitTestScene', 'undo', 'redo', 'createEntity']));
      expect(opEnum).not.toContain('undoVoxels');

      // The page's edit, sent as the page sends it, then taken back: the world as written again.
      const page = await command({ op: 'editVoxels', projectId: PROJECT, requestId: rid(100), args: { world: FEED_WORLD, command: DIG } });
      expect(page.status, JSON.stringify(page.json)).toBe(200);
      expect(page.json).toMatchObject({ ok: true, revision: 1 });
      expect(await nthChange(1)).toEqual(asFeed(page.json, null));
      const pageUndo = await step('undo', rid(101));
      expect(pageUndo.voxels).toMatchObject({ ok: true, op: 'undo', world: FEED_WORLD, revision: 2, undoable: 0 });
      expect(await nthChange(2)).toEqual(asFeed(pageUndo.voxels!, null));
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
      const projectRevision = async (): Promise<number> => (await command({ op: 'queryProject', projectId: PROJECT, args: {} })).json['revision'] as number;
      const undo = await tool({ op: 'undo', expectedRevision: await projectRevision() });
      expect(undo.body).toMatchObject({ ok: true, op: 'undo', revision: await projectRevision(), voxels: { ok: true, op: 'undo', revision: 4, undoable: 0, redoable: 1, cells: page.json.cells } });
      const undone = undo.body.voxels as Record<string, unknown>;
      expect(await nthChange(4)).toEqual(asFeed(undone, { kind: 'mcp', clientId: 'voxel-mcp' }));
      expectSame(await readChunks(SCENE_CHUNKS, FEED_WORLD), sceneStore(), SCENE_CHUNKS);
      // Redo through MCP: the stroke's voxels again; undone once more.
      const redo = await tool({ op: 'redo', expectedRevision: await projectRevision() });
      expect(redo.body).toMatchObject({ ok: true, op: 'redo', voxels: { ok: true, op: 'redo', revision: 5, undoable: 1, redoable: 0, cells: page.json.cells } });
      expectSame(await readChunks(SCENE_CHUNKS, FEED_WORLD), oracle, SCENE_CHUNKS);
      expect((await tool({ op: 'undo', expectedRevision: await projectRevision() })).body).toMatchObject({ ok: true, voxels: { revision: 6 } });
      expect(await nthChange(6)).toMatchObject({ op: 'undo', revision: 6 });
      expect(changes().map((e) => e.revision)).toEqual([1, 2, 3, 4, 5, 6]);
      expectSame(await readChunks(SCENE_CHUNKS, FEED_WORLD), sceneStore(), SCENE_CHUNKS);

      // Refusals come back as the backend's, and send nothing to the feed: an undo against a revision the project has moved past.
      const none = await tool({ op: 'undo', expectedRevision: (await projectRevision()) + 1 });
      expect(none.isError).toBe(true);
      expect(JSON.stringify(none.body)).toContain('revision_conflict');
      const badOrigin = await command({ op: 'editVoxels', projectId: PROJECT, origin: { kind: 'robot', clientId: 'x' }, args: { world: FEED_WORLD, command: DIG } });
      expect(badOrigin.status).toBe(400);
      expect(badOrigin.json.error).toMatchObject({ code: 'invalid_request', path: '/origin/kind' });
      // The page's own session sends as a browser now that it is registered: the feed names it.
      const browser = await command({ op: 'editVoxels', projectId: PROJECT, requestId: rid(102), origin: { kind: 'browser', clientId: sessionId }, args: { world: FEED_WORLD, command: DIG } });
      expect(browser.json).toMatchObject({ ok: true, revision: 7 });
      expect(await nthChange(7)).toEqual(asFeed(browser.json, { kind: 'browser', clientId: sessionId }));
      expect(changes().length).toBe(7);
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

    // Created over HTTP; read back in canonical form (slots by id, the default weight left out, game data as given).
    const made = await send('setVoxelKit', { kit });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(made.json['change']).toMatchObject({ type: 'setVoxelKit', voxelKitId: 'log', previous: null });
    const stored = (await kits())[0]!;
    expect(Object.keys(stored)).toEqual(['kitFormat', 'voxelKitId', 'name', 'version', 'materialType', 'materials', 'slots', 'gameData']);
    expect(Object.keys(stored['slots'] as object)).toEqual(['edge-out-bottom', 'edge-out-top']);
    expect((stored['slots'] as Record<string, { meshes: Record<string, unknown>[] }>)['edge-out-top']!.meshes[0]).toEqual({ mesh: { assetId: model.assetId, digest, node: 'Beam_Body' } });
    expect(stored['gameData']).toEqual(kit.gameData);
    // Its own file in the game folder (the resource kind's folder), holding the record.
    const file = join(dir, 'assets', 'voxel-kits', 'log.voxelkit.json');
    expect(JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))).toContain('"voxelKitId":"log"');
    console.log(`[voxel kit] ${Object.keys(stored['slots'] as object).length} slots: file ${statSync(file).size} bytes, record ${JSON.stringify(stored).length} bytes compact`);
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
    // A kit with a slot the catalogue lacks, a mesh of no model and one naming a node and a version the model lacks.
    const one = (mesh: VoxelKitMesh) => ({ meshes: [{ mesh }] });
    const broken: VoxelKit = {
      kitFormat: 1,
      voxelKitId: 'broken',
      name: 'Broken',
      version: 1,
      materialType: 'stone',
      slots: {
        gazebo: one({ assetId: KIT_MODEL.assetId, digest }),
        'edge-out-vertical': one({ assetId: KIT_MODEL.assetId, digest: 'f'.repeat(64), node: 'No_Such_Node' }),
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
    expect(lines.find((l) => l.includes('error: 1 slots the catalogue does not have'))).toMatch(/gazebo: never drawn/);
    expect(lines.find((l) => l.includes('meshes cannot be drawn'))).toMatch(/^Voxel kit "Broken" \(broken\) error: .*no such model: edge-out-top \(no-such-model\).*no such node: edge-out-vertical/);
    expect(lines.find((l) => l.includes('name a file version the model does not have'))).toMatch(/warning/);
    // Every slot is optional: the 15 empty ones are no problem.
    expect(lines.some((l) => /required|empty|slots filled/.test(l))).toBe(false);
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
    // Mended (one slot on the file's own digest and node, the unknown and missing pieces gone): no problem left.
    const mended: VoxelKit = { ...broken, version: 2, slots: { 'edge-out-top': one({ assetId: KIT_MODEL.assetId, digest, node: 'Beam_Body' }) } };
    const mark = (await problems()).length;
    expect((await send('setVoxelKit', { kit: mended })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const after = (await problems()).slice(mark).filter((l) => l.includes('(broken)'));
    expect(after).toEqual([]);
    expect((await send('deleteVoxelKit', { voxelKitId: 'broken' })).status).toBe(200);
  }, 60_000);

  it('writes the kit test scene into a world as one command: every slot labelled, no labelled cell derives a window case from the files, the same scene again is no_change, one undo takes it back', async () => {
    const dir = backend._test.service.projectDir(PROJECT)!;
    writeVoxelWorld(join(dir, 'voxels', SCENE_WORLD), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, sceneStore());
    const args = { world: SCENE_WORLD, origin: [-40, -5, -30], material: 11 };
    expect(((await command({ op: 'writeKitTestScene', projectId: PROJECT, args: { ...args, material: 0 } })).json.error as { code: string }).code).toBe('invalid_args');
    expect(((await command({ op: 'writeKitTestScene', projectId: PROJECT, args: { ...args, origin: [0, 0.5, 0] } })).json.error as { code: string }).code).toBe('invalid_args');
    expect(((await command({ op: 'writeKitTestScene', projectId: PROJECT, args: { ...args, kit: 'log' } })).json.error as { code: string }).code).toBe('invalid_request');
    const r = await command({ op: 'writeKitTestScene', projectId: PROJECT, requestId: rid(300), args });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    const scene = r.json.scene as { min: number[]; max: number[]; labels: Array<{ cell: [number, number, number]; roleName: string; caseId: string }> };
    const want = kitTestScene(WORLD_RULES, { origin: args.origin as [number, number, number], material: 11 });
    expect(scene).toEqual(JSON.parse(JSON.stringify({ min: want.min, max: want.max, labels: want.labels })));
    expect(r.json).toMatchObject({ ok: true, op: 'writeKitTestScene', revision: 1, undoable: 1, box: { minX: -40, minY: -5, minZ: -30, maxX: want.max[0], maxY: want.max[1], maxZ: want.max[2] } });
    // The world read back through the range route, as a browser reads it.
    const chunks = (r.json.chunks as Array<[number, number, number]>).map(([cx, cy, cz]) => ({ cx, cy, cz }));
    expect(new Set(chunks.map((c) => `${c.cx},${c.cy},${c.cz}`)).size).toBe(chunks.length);
    const around: ChunkCoord[] = [];
    for (let cx = (want.min[0]! >> 5) - 1; cx <= (want.max[0]! >> 5) + 1; cx++) for (let cy = (want.min[1]! >> 5) - 1; cy <= (want.max[1]! >> 5) + 1; cy++) for (let cz = (want.min[2]! >> 5) - 1; cz <= (want.max[2]! >> 5) + 1; cz++) around.push({ cx, cy, cz });
    const store = await readChunks(around, SCENE_WORLD);
    // The catalogue has no window rules: no labelled cell reads back a window case; the sampler's cases (edges, roof
    // edges, damage) are the derive's pieces, checked through the derive in vitest.
    expect(WORLD_RULES.catalogue!.rules).toEqual([]);
    for (const l of scene.labels) expect({ cell: l.cell, ...caseAt(store, ...l.cell) }).toEqual({ cell: l.cell, caseId: null });
    // Every case of the catalogue (every slot) is labelled: one sampler cell each.
    expect(new Set(scene.labels.map((l) => l.caseId))).toEqual(new Set(WORLD_RULES.catalogue!.cases.map((c) => c.id)));
    expect(((await command({ op: 'writeKitTestScene', projectId: PROJECT, args })).json.error as { code: string }).code).toBe('no_change');
    const undone = await step('undo');
    expect(undone.voxels).toMatchObject({ ok: true, world: SCENE_WORLD, revision: 2, undoable: 0, cells: r.json.cells });
    expectSame(await readChunks(around, SCENE_WORLD), sceneStore(), around);
  }, 60_000);

  it("a material's physics, game data and voxel use through the one command path (HTTP and MCP's tl_command): canonical, one undo, kept on disk across a restart; voxel_id_taken, kit_missing and a missing profile refused; a project profile its own command", async () => {
    const query = async (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await command({ op, projectId: PROJECT, args })).json;
    const send = async (op: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => command({ op, projectId: PROJECT, expectedRevision: (await query('queryProject'))['revision'] as number, requestId: `req-${randomBytes(16).toString('hex')}`, args });
    const game = async (): Promise<{ materials: Array<Record<string, unknown>>; materialProfiles: Array<Record<string, unknown>> }> => (await query('queryGameConfig', { omit: ['dialogues'] })) as never;
    const profile = await send('setMaterialProfile', { profile: { profileId: 'oak-wood', name: 'Oak wood', density: 720, gameData: { footstep: 'creak', break: { hits: 1 } } } });
    expect(profile.status, JSON.stringify(profile.json)).toBe(200);
    expect(profile.json['change']).toMatchObject({ type: 'setMaterialProfile', profileId: 'oak-wood', previous: null });
    const made = await send('setMaterial', { material: OAK_MATERIAL });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const stored = (await game()).materials.find((m) => m['materialId'] === 'oak')!;
    expect(Object.keys(stored)).toEqual(['materialId', 'name', 'shader', 'params', 'textures', 'physical', 'gameData', 'voxel']);
    expect(stored['voxel']).toEqual({ id: 12, use: 'construction', kit: 'log', tileMetres: 4, heightDepth: 0.03 });
    expect((await game()).materialProfiles).toEqual([{ profileId: 'oak-wood', name: 'Oak wood', density: 720, gameData: { break: { hits: 1 }, footstep: 'creak' } }]);
    // Refused, nothing changed: an id another material has, a kit the project lacks, a profile it lacks, a kit a material names deleted.
    const codeOf = (r: { json: Record<string, unknown> }): string => { const e = r.json['error'] as { code: string; details?: Array<{ code: string }> }; return e.details?.[0]?.code ?? e.code; };
    expect(codeOf(await send('setMaterial', { material: { ...OAK_MATERIAL, materialId: 'pine', name: 'Pine' } }))).toBe('voxel_id_taken');
    expect(codeOf(await send('setMaterial', { material: { ...OAK_MATERIAL, materialId: 'pine', name: 'Pine', voxel: { id: 13, use: 'construction', kit: 'brick' } } }))).toBe('kit_missing');
    expect(codeOf(await send('setMaterial', { material: { ...OAK_MATERIAL, materialId: 'pine', name: 'Pine', voxel: { id: 13, use: 'terrain' }, physical: { profile: 'bamboo' } } }))).toBe('reference_missing');
    expect(codeOf(await send('deleteVoxelKit', { voxelKitId: 'log' }))).toBe('kit_missing');
    expect(codeOf(await send('deleteMaterialProfile', { profileId: 'oak-wood' }))).toBe('reference_missing');
    // MCP sends the same op: a voxel variant (an instance with its own id) of the same record; undo takes it back in one step.
    const server = createMcpServer({ client: new BackendClient({ authoringOrigin: base(), token: TOKEN }), projectId: PROJECT, clientId: 'voxel-material-mcp' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'voxel-material-mcp-test', version: '0.1.0' });
    await mcp.connect(clientTransport);
    try {
      const { tools } = await mcp.listTools();
      const opEnum = (tools.find((t) => t.name === 'tl_command')!.inputSchema as { properties: { op: { enum: string[] } } }).properties.op.enum;
      expect(opEnum).toEqual(expect.arrayContaining(['setMaterialProfile', 'deleteMaterialProfile']));
      const variant = { materialId: 'oak-dark', name: 'Dark oak', shader: 'standard', params: {}, textures: {}, instanceOf: 'oak', voxel: { id: 13 }, gameData: { stain: 'dark' } };
      const res = (await mcp.callTool({ name: 'tl_command', arguments: { op: 'setMaterial', expectedRevision: (await query('queryProject'))['revision'], args: { material: variant } } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError === true, res.content[0]!.text).toBe(false);
      const g = (await mcp.callTool({ name: 'tl_content_query', arguments: { target: 'game' } })) as { content: Array<{ text: string }> };
      expect((JSON.parse(g.content[0]!.text) as { materials: Array<{ materialId: string; voxel?: unknown }> }).materials.find((m) => m.materialId === 'oak-dark')!.voxel).toEqual({ id: 13 });
    } finally {
      await mcp.close();
      await server.close();
    }
    expect((await send('undo', {})).status).toBe(200);
    expect((await game()).materials.some((m) => m['materialId'] === 'oak-dark')).toBe(false);
    // An object wears it too: one record serves a mesh and voxels (the export test reads what ships).
    const box = await send('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Oak box', components: { materials: { '*': 'oak' } } });
    expect(box.status, JSON.stringify(box.json)).toBe(200);
    // The material's own file keeps the parts; a restart reads them back.
    await close();
    await start();
    expect((await game()).materials.find((m) => m['materialId'] === 'oak')).toEqual(stored);
    expect((await game()).materialProfiles.map((p) => p['profileId'])).toEqual(['oak-wood']);
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

    // Texture sets for the clay's surfaces: placeholder images (256², PNG: a level past the mip tail, so the arrays
    // stream) imported as every texture is. The timber's albedo is written opaque: an albedo without a height.
    const texDir = join(backend._test.service.projectDir(PROJECT)!, 'assets', 'voxel-textures');
    mkdirSync(texDir, { recursive: true });
    const opaqueTimber = placeholderSet('timber', 256).albedo.slice();
    for (let i = 3; i < opaqueTimber.length; i += 4) opaqueTimber[i] = 255;
    for (const set of ['stone', 'timber'] as const) {
      const maps = placeholderSet(set, 256);
      for (const map of ['albedo', 'normal'] as const) writeFileSync(join(texDir, `${set}-${map}.png`), placeholderPng(set === 'timber' && map === 'albedo' ? opaqueTimber : maps[map], 256));
    }
    expect((await send('importAssets', { folder: 'assets/voxel-textures' })).status).toBe(200);
    const texAssets = ((await query('queryAssets', { limit: 100 })) as { assets: Array<{ assetId: string; sourcePath?: string }> }).assets;
    const tex = (name: string): string => texAssets.find((a) => a.sourcePath === `assets/voxel-textures/${name}.png`)!.assetId;
    const clayVoxel: MaterialVoxel = { id: 14, use: 'terrain', surfaces: { wall: { albedo: tex('stone-albedo'), normal: tex('stone-normal') }, floor: { albedo: tex('timber-albedo') } } };
    // A voxel material nothing but the world's cells name ships (any id may be in the files or painted at run time);
    // a mesh material nothing names does not.
    for (const material of [{ materialId: 'clay', name: 'Clay', shader: 'standard', params: { color: '#a0603a' }, textures: {}, voxel: clayVoxel }, { materialId: 'unworn', name: 'Unworn', shader: 'standard', params: {}, textures: {} }]) {
      const set = await send('setMaterial', { material });
      expect(set.status, JSON.stringify(set.json)).toBe(200);
    }
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
    // It ships with the ids it binds: the oak record's 12 and its own list's 3 (no material record names 3).
    expect(shippedKits![0]!['materials']).toEqual([3, 12]);
    // The oak material ships with its parts, its physics resolved against its profile (the profile's game data under its own).
    const shippedOak = ((content as unknown as { materials?: Array<Record<string, unknown>> }).materials ?? []).find((m) => m['materialId'] === 'oak')!;
    expect(shippedOak['voxel']).toEqual(OAK_MATERIAL.voxel);
    expect(shippedOak['physical']).toEqual({ profile: 'oak-wood', density: 720, friction: 0.55, restitution: 0 });
    expect(shippedOak['gameData']).toEqual({ footstep: 'creak', break: { hits: 3 } });
    const shippedIds = ((content as unknown as { materials?: Array<Record<string, unknown>> }).materials ?? []).map((m) => m['materialId']);
    expect(shippedIds).toContain('clay');
    expect(shippedIds).not.toContain('unworn');
    // The voxel surfaces' texture arrays: assembled by the backend from every voxel material's sets (the oak's has
    // none), shipped as textures the game reads without the backend, named by map in their own block, needed
    // project-wide; a map no set names (ORM) has no array. Two layers: the stone wall, the timber floor. Each ships cut
    // into its mip parts (the head with the tail to 128², then 256²), as a streamed texture asset ships, never whole.
    const voxelTextures = (content as unknown as { voxelTextures?: Record<string, string> }).voxelTextures!;
    expect(Object.keys(voxelTextures).sort()).toEqual(['albedo', 'normal']);
    const shippedDeps = ((content as unknown as { dependencies?: Array<{ assetId: string; path: string }> }).dependencies ?? []);
    const sets = voxelSurfaceTextures([{ shader: 'standard', voxel: clayVoxel }])!;
    for (const [map, id] of Object.entries(voxelTextures)) {
      const row = shippedDeps.find((e) => e.assetId === id) as { path: string; mipParts?: Array<{ path: string; offset: number; levels: number[] }> } | undefined;
      expect(row, map).toBeDefined();
      expect(row!.mipParts?.map((p) => p.levels), map).toEqual([[1, 2, 3, 4, 5, 6, 7, 8], [0]]);
      expect(existsSync(join(out, row!.path)), `${map}: the whole file is not shipped beside its parts`).toBe(false);
      const bytes = new Uint8Array(Buffer.concat(row!.mipParts!.map((p) => readFileSync(join(out, p.path)))));
      const layout = readKtx2Layout(bytes);
      expect(layout.ok && layout.layout.layers, map).toBe(2);
      expect(layout.ok && layout.layout.width, map).toBe(256);
      // The editor's views draw the very array: the backend's route answers the same bytes for the same slot list.
      const set = sets.sets[map as 'albedo' | 'normal']!;
      const viewed = await fetch(`${base()}/api/v1/projects/${PROJECT}/content/textures/slots`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ layers: set.layers, mode: set.mode, ...(set.height === true ? { height: true } : {}) }) });
      expect(viewed.status, `${map}: ${textureSlotSetKey(set)}`).toBe(200);
      expect(Buffer.from(await viewed.arrayBuffer()).equals(Buffer.from(bytes)), map).toBe(true);
      const top = (await transcodeKtx2Levels(bytes)).levels[0]!;
      const alphas = (layer: number): number[] => Array.from({ length: 256 * 256 }, (_, i) => top.data[(layer * 256 * 256 + i) * 4 + 3]!);
      if (map === 'normal') {
        // The normal map carries no height: its A is opaque in the stone wall's layer and the floor's flat normal.
        expect(sets.sets.normal!.height).toBeUndefined();
        for (const layer of [0, 1]) expect(Math.min(...alphas(layer)), `normal layer ${layer}`).toBe(255);
        continue;
      }
      // The height lives in the albedo's A (texture layout v1 as amended, the layered surfaces' convention), kept
      // through the import and the assembly and read back by three's transcoder: the stone wall's layer holds the
      // stone's height; the timber floor's albedo has none (opaque), so the assembly gave it one from its brightness.
      expect(sets.sets.albedo.height).toBe(true);
      const source = placeholderSet('stone', 256).albedo;
      const wall = alphas(0);
      let err = 0;
      let spread = 0;
      for (let i = 0; i < 256 * 256; i++) {
        err += Math.abs(wall[i]! - source[i * 4 + 3]!);
        spread = Math.max(spread, Math.abs(source[i * 4 + 3]! - source[3]!));
      }
      expect(spread, 'the stone has a height range').toBeGreaterThan(60);
      // A colour array this small is ETC1S (the colour arrays' encoding within the encoder's limit, the layered
      // surfaces' height arrays' too; an authored 4096² set encodes in UASTC stripes), coarser in A than the UASTC
      // normal array that held the height before: the bound is what the blend needs, under 1 mm at the stone's
      // depth (a tenth of the height blend's 1 cm contrast).
      expect(err / (256 * 256), 'mean height error (/255)').toBeLessThan((255 * 0.001) / placeholderLook('stone').depthMetres);
      const floor = alphas(1);
      expect(Math.max(...floor) - Math.min(...floor), 'the opaque timber albedo got a brightness height').toBeGreaterThan(60);
    }
    expect([...sets.layers]).toEqual([[14, [0, 1, 0]]]);
    const kitMesh = (shippedKits![0]!['slots'] as Record<string, { meshes: Array<{ mesh: { digest: string } }> }>)['edge-out-top']!.meshes[0]!.mesh;
    expect(readFileSync(join(out, 'content', 'sha256', kitMesh.digest)).equals(pieceGlb())).toBe(true);
    expect(((content as unknown as { dependencies?: Array<{ assetId: string }> }).dependencies ?? []).map((e) => e.assetId)).toContain(KIT_MODEL.assetId);
    await kitMeshAfterReimport(KIT_MODEL.assetId, kitMesh.digest, send, exportNow);
    const worldDir = join(backend._test.service.projectDir(PROJECT)!, 'voxels', FEED_WORLD);
    const manifest = JSON.parse(readFileSync(join(worldDir, 'world.json'), 'utf8')) as { worldId: string; regions: string[]; revision: number };
    expect(content.voxelWorlds?.length).toBe(1);
    const shipped = content.voxelWorlds![0]!;
    expect({ ...shipped, files: undefined, far: undefined }).toEqual({ world: FEED_WORLD, worldId: manifest.worldId, edge: 32, layout: 'stacked', footprint: 512, revision: manifest.revision, files: undefined, far: undefined });
    expect(shipped.files.map((f) => f.name)).toEqual(manifest.regions);
    // Its far cache ships beside it, built by the export (the world had none) at the world's revision, each file whole.
    const farDir = join(backend._test.service.projectDir(PROJECT)!, 'cache', 'voxel-far', FEED_WORLD);
    const farManifest = JSON.parse(readFileSync(join(farDir, 'far.json'), 'utf8')) as { revision: number; minLevel: number; maxLevel: number; levels: Array<{ level: number; regions: string[] }>; bricks: { levels: Array<{ level: number; regions: string[] }> } };
    expect(farManifest.revision).toBe(manifest.revision);
    // The nodes (L<level>/) and their baked bricks (B<level>/), a bricks file beside each nodes file.
    expect(shipped.far?.files.map((f) => f.name)).toEqual([...farManifest.levels.flatMap((l) => l.regions.map((r) => `L${l.level}/${r}`)), ...farManifest.bricks.levels.flatMap((l) => l.regions.map((r) => `B${l.level}/${r}`))].sort());
    expect(farManifest.bricks.levels.map((l) => l.regions)).toEqual(farManifest.levels.map((l) => l.regions));
    expect([shipped.far!.minLevel, shipped.far!.maxLevel]).toEqual([farManifest.minLevel, farManifest.maxLevel]);
    for (const f of shipped.far!.files) expect(readFileSync(join(out, 'content', 'sha256', f.digest)).equals(readFileSync(join(farDir, f.name)))).toBe(true);
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

  it('the strokes of command version 3 over the command route: a flood (liquid, a fading gas, a drain), a leak refused with its places, smooth, flatten and a paint that keeps roles, each the oracle\'s voxels, all on the one undo line', async () => {
    const STROKES = 'strokes';
    const ROCK = recordValue(7, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
    // A basin (inside [1, 10]², walls 6 high) on rock, a cliff beside it (x 20 … 36: 4 high, then 8), a wall on the cliff's foot.
    const made = (): PaletteStore => {
      const st = createWorldStore(grid);
      const r = { material: 0, role: 0, shape: 0, wetness: 0 };
      for (let x = -24; x <= 40; x++) for (let z = -24; z <= 36; z++) for (let y = -4; y <= 9; y++) {
        const inside = x >= 1 && x <= 10 && z >= 1 && z <= 10;
        const rim = x >= 0 && x <= 11 && z >= 0 && z <= 11;
        let v = y <= 0 ? ROCK : !inside && rim && y <= 6 ? ROCK : 0;
        if (x >= 20 && z >= 0 && z <= 16 && y >= 1 && y < (x < 28 ? 4 : 8)) v = ROCK;
        if (x === 22 && z === 8 && y >= 4 && y <= 6) v = recordValue(5, VOXEL_ROLE.wall, SHAPE_FULL, 0);
        if (v !== 0) st.setVoxel(x, y, z, readValue(v, r));
      }
      return st;
    };
    const first = made();
    const oracle = made();
    writeVoxelWorld(join(backend._test.service.projectDir(PROJECT)!, 'voxels', STROKES), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, made());
    const CHUNKS: ChunkCoord[] = [-1, 0, 1].flatMap((cx) => [-1, 0].flatMap((cy) => [-1, 0, 1].map((cz) => ({ cx, cy, cz }))));
    const send = (cmd: Record<string, unknown>) => command({ op: 'editVoxels', projectId: PROJECT, args: { world: STROKES, command: cmd } });
    const flood = { v: 3, grid: 0, kind: 'flood', seed: [5, 2, 5], level: 3.5, reach: 16 };
    const LIQUID = { material: 40, role: VOXEL_ROLE.liquid };
    const GAS = { material: 50, role: VOXEL_ROLE.gas };
    const brush = { v: 3, grid: 0, kind: 'brush', shape: 'sphere', size: [5, 5, 5], points: [28, 6, 8], smooth: true };
    const strokes: Array<{ cmd: Record<string, unknown>; parts?: number; cells?: number }> = [
      { cmd: { ...flood, value: LIQUID }, parts: DERIVED_PART.liquid, cells: 300 },
      // Fog on the water, fading over 1 m under its level: the gas part alone.
      { cmd: { ...flood, seed: [5, 5, 5], level: 6, value: GAS, fade: 1 }, parts: DERIVED_PART.gas },
      { cmd: { ...flood, level: 6, value: { material: 0, role: 0 } }, parts: DERIVED_PART.liquid | DERIVED_PART.gas },
      { cmd: { ...flood, level: 4, value: GAS }, parts: DERIVED_PART.gas, cells: 300 },
      { cmd: { ...brush, points: [5, 3, 5], mode: 'smooth', voxel: { ...GAS, wetness: 0 } }, parts: DERIVED_PART.gas },
      { cmd: { ...brush, mode: 'smooth' }, parts: EVERY_PART },
      { cmd: { ...brush, shape: 'cylinder', size: [4, 5, 4], points: [32, 6, 8], mode: 'flatten', height: 5.5, smooth: false }, parts: EVERY_PART },
      { cmd: { v: 3, grid: 0, kind: 'fill', min: [20, 3, 6], max: [24, 6, 10], mode: 'paint', voxel: { material: 9, wetness: 2 } }, parts: DERIVED_PART.shader },
    ];
    const states: PaletteStore[] = [];
    let revision = 0;
    for (const { cmd, parts, cells } of strokes) {
      const out = applyEdit({ store: () => oracle }, canonicalEditCommand(cmd));
      expect(out.cells, JSON.stringify(cmd)).toBeGreaterThan(0);
      const r = await send(cmd);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json).toMatchObject({ ok: true, op: 'editVoxels', revision: ++revision, cells: out.cells, parts: out.parts, box: editBounds(grid, canonicalEditCommand(cmd)) });
      if (parts !== undefined) expect(r.json.parts, JSON.stringify(cmd)).toBe(parts);
      if (cells !== undefined) expect(r.json.cells).toBe(cells);
      expectSame(await readChunks(CHUNKS, STROKES), oracle, CHUNKS);
      const kept = createWorldStore(grid);
      const d = createDenseChunk(grid);
      for (const c of CHUNKS) kept.importChunk(c.cx, c.cy, c.cz, exportOrAir(oracle, c.cx, c.cy, c.cz, d));
      states.push(kept);
    }
    // The paint kept the wall a wall and the ground ground.
    const rec = { material: 0, role: 0, shape: 0, wetness: 0 };
    expect(oracle.voxelAt(22, 5, 8, rec)).toMatchObject({ material: 9, role: VOXEL_ROLE.wall, wetness: 2 });
    expect({ ...oracle.voxelAt(21, 3, 8, rec) }).toMatchObject({ material: 9, role: VOXEL_ROLE.terrain, wetness: 2 });

    // A leak: the basin's wall opened, a flood is refused, names where, and writes nothing.
    const hole = { v: 3, grid: 0, kind: 'set', cells: [11, 1, 5, 11, 2, 5], voxel: { material: 0, role: 0, shape: 0, wetness: 0 } };
    applyEdit({ store: () => oracle }, canonicalEditCommand(hole));
    expect((await send(hole)).status).toBe(200);
    revision++;
    const leak = await send({ ...flood, value: LIQUID, level: 2.5 });
    expect(leak.status, JSON.stringify(leak.json)).toBe(400);
    const error = leak.json.error as { code: string; message: string; leaks: Array<{ at: [number, number, number]; kind: string; cells: number }> };
    expect(error.code).toBe('flood_leaks');
    expect(error.message).toMatch(/leaks in \d+ places?: past its reach near cell/);
    expect(error.leaks.length).toBeGreaterThan(0);
    for (const l of error.leaks) {
      // Metres in the scene (a cell is half a metre): just past 8 m from the seed's column, in the rows under the level.
      expect(l.kind).toBe('reach');
      const d = Math.hypot(l.at[0] - 2.75, l.at[2] - 2.75);
      expect(d).toBeGreaterThan(6);
      expect(d).toBeLessThan(9.25);
      expect(l.at[1]).toBeGreaterThan(0.5);
      expect(l.at[1]).toBeLessThan(1.5);
    }
    const blocked = await send({ ...flood, value: LIQUID, seed: [5, 0, 5] });
    expect(blocked.status).toBe(400);
    expect((blocked.json.error as { code: string }).code).toBe('flood_blocked');
    // A body role is no flood value; a version 2 command knows no flood.
    expect((await send({ ...flood, value: { material: 7, role: VOXEL_ROLE.terrain } })).json.error).toMatchObject({ code: 'invalid_args', path: '/args/command/value/role' });
    expect((await send({ ...flood, v: 2, value: LIQUID })).json.error).toMatchObject({ code: 'invalid_args', path: '/args/command/kind' });
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${STROKES}`, { headers: auth })).json()) as { manifest: { revision: number } };
    expect(info.manifest.revision).toBe(revision);
    expectSame(await readChunks(CHUNKS, STROKES), oracle, CHUNKS);

    // The one undo line: the hole, then every stroke back in order, each the bytes before it; then all again.
    expect((await step('undo')).voxels).toMatchObject({ ok: true, op: 'undo' });
    for (let i = strokes.length - 1; i >= 0; i--) {
      const u = await step('undo');
      expect(u.status, JSON.stringify(u.json)).toBe(200);
      expect(u.voxels).toMatchObject({ ok: true, op: 'undo', box: editBounds(grid, canonicalEditCommand(strokes[i]!.cmd)) });
      if (strokes[i]!.parts !== undefined) expect(u.voxels!.parts).toBe(strokes[i]!.parts);
      expectSame(await readChunks(CHUNKS, STROKES), i === 0 ? first : states[i - 1]!, CHUNKS);
    }
    for (let i = 0; i < strokes.length; i++) {
      expect((await step('redo')).voxels).toMatchObject({ ok: true, op: 'redo' });
      expectSame(await readChunks(CHUNKS, STROKES), states[i]!, CHUNKS);
    }
  }, 120_000);

  it('the voxel brush tool\'s drags over the command route: add, smooth, flatten, a role-less paint and a masked paint each one command the backend applies as the oracle does, and one undo step each', async () => {
    const BRUSHED = 'brushed';
    const ROCK = recordValue(7, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
    // Rock with its top at cell 1 (y ≤ 0), and one wall block standing on it.
    const made = (): PaletteStore => {
      const st = createWorldStore(grid);
      const r = { material: 0, role: 0, shape: 0, wetness: 0 };
      for (let x = -8; x <= 56; x++) for (let z = -8; z <= 40; z++) for (let y = -6; y <= 0; y++) st.setVoxel(x, y, z, readValue(ROCK, r));
      st.setVoxel(30, 1, 16, readValue(recordValue(5, VOXEL_ROLE.wall, SHAPE_FULL, 0), r));
      return st;
    };
    const first = made();
    const oracle = made();
    writeVoxelWorld(join(backend._test.service.projectDir(PROJECT)!, 'voxels', BRUSHED), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, made());
    const CHUNKS: ChunkCoord[] = [-1, 0, 1].flatMap((cx) => [-1, 0].flatMap((cy) => [-1, 0, 1].map((cz) => ({ cx, cy, cz }))));
    const rec = { material: 0, role: 0, shape: 0, wetness: 0 };
    const at = (x: number, y: number, z: number): number => valueOf(oracle.voxelAt(x, y, z, rec));
    /** The top of a column as the oracle holds it now: its highest cell that is not air. */
    const top = (x: number, z: number): number => {
      for (let y = 24; y >= -6; y--) if (at(x, y, z) !== 0) return y;
      return -7;
    };
    const height = (x: number, z: number): number => surfaceHeightCells([x, top(x, z), z], at(x, top(x, z), z));

    // The tool as the Scene view holds it: a camera over the ground, a pick that answers from the voxels as they are.
    const RECT = { left: 0, top: 0, width: 800, height: 600, x: 0, y: 0, right: 800, bottom: 600 };
    const camera = new THREE.PerspectiveCamera(50, RECT.width / RECT.height, 0.1, 500);
    camera.position.set(12, 40, 30);
    camera.lookAt(12, 0, 8);
    camera.updateMatrixWorld();
    const answers: Array<{ status: number; json: Record<string, unknown> }> = [];
    const sent: Record<string, unknown>[] = [];
    let pending: Promise<void> = Promise.resolve();
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
    resetBrushStores();
    const store = brushStore('http', 'voxel', VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS, null);
    const canvas = { getBoundingClientRect: () => RECT, setAttribute: () => undefined, removeAttribute: () => undefined, parentElement: null } as unknown as HTMLCanvasElement;
    const tool = new VoxelBrushTool(
      {
        overlay: new THREE.Group(),
        camera,
        canvas: () => canvas,
        requestRender: () => undefined,
        pick: (x, y) => {
          const r = new THREE.Raycaster();
          r.setFromCamera(new THREE.Vector2((x / RECT.width) * 2 - 1, -(y / RECT.height) * 2 + 1), camera);
          const p = r.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
          if (p === null) return Promise.resolve(null);
          const cx = Math.floor(p.x / VOXEL_SIZE_M);
          const cz = Math.floor(p.z / VOXEL_SIZE_M);
          return Promise.resolve({ world: BRUSHED, grid: 0, t: 1, cell: [cx, top(cx, cz), cz] as const, normal: [0, 1, 0] as const, record: at(cx, top(cx, cz), cz) });
        },
        place: () => null,
      },
      {
        stroke: (world, cmd) => {
          sent.push(cmd);
          pending = command({ op: 'editVoxels', projectId: PROJECT, args: { world, command: cmd } }).then((r) => void answers.push(r));
          return pending;
        },
        refused: (m) => {
          throw new Error(m);
        },
        readout: () => undefined,
      },
    );
    const ev = (xm: number, zm: number): PointerEvent => {
      const p = new THREE.Vector3(xm, 0, zm).project(camera);
      return { clientX: ((p.x + 1) / 2) * RECT.width, clientY: ((1 - p.y) / 2) * RECT.height, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1 } as unknown as PointerEvent;
    };
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    /** A drag over the ground along x (metres) at z, a move every 0.5 m; the command's answer awaited, the oracle moved by the same command. */
    const drag = async (arm: Partial<VoxelBrushArm>, x0: number, x1: number, zm: number): Promise<{ cmd: BrushEdit; cells: number }> => {
      tool.arm({ kind: 'dig', navigate: false, world: BRUSHED, grid: 0, entityId: null, store, uses: ['size', 'spacing'], shape: 'sphere', soft: true, voxel: null, ...arm });
      tool.pointerMove(ev(x0, zm));
      await tick();
      expect(tool.pointerDown(ev(x0, zm))).toBe('capture');
      for (let x = x0 + 0.5; x <= x1; x += 0.5) {
        tool.pointerMove(ev(x, zm));
        await tick();
      }
      const before = sent.length;
      tool.pointerUp(ev(x1, zm));
      expect(sent.length).toBe(before + 1);
      await pending;
      const cmd = canonicalEditCommand(sent.at(-1)) as BrushEdit;
      const out = applyEdit({ store: () => oracle }, cmd);
      const r = answers.at(-1)!;
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json).toMatchObject({ ok: true, op: 'editVoxels', cells: out.cells, parts: out.parts });
      expect(out.cells, JSON.stringify(cmd).slice(0, 200)).toBeGreaterThan(0);
      expectSame(await readChunks(CHUNKS, BRUSHED), oracle, CHUNKS);
      return { cmd, cells: out.cells };
    };
    try {
      // Add: a ridge of the picked ground over the stroke, higher than the flat rock beside it.
      const add = await drag({ kind: 'add', voxel: { material: 12, role: VOXEL_ROLE.terrain, wetness: 0 } }, 6, 14, 8);
      expect(add.cmd).toMatchObject({ v: 3, mode: 'add', smooth: true, voxel: { material: 12, role: VOXEL_ROLE.terrain } });
      expect(add.cmd.points.length / 3).toBeLessThan(17);
      expect(height(20, 16)).toBeGreaterThan(4);
      expect(height(20, 30)).toBe(1);
      const ridge = height(20, 16);
      // Smooth along the ridge's foot: the step from the ridge's flank to the rock beside it gets lower.
      const stepAt = (): number => Math.max(...[9, 10, 11, 12, 13].map((z) => Math.abs(height(20, z) - height(20, z - 1))));
      const steep = stepAt();
      const smooth = await drag({ kind: 'smooth' }, 6, 14, 5.75);
      expect(smooth.cmd.mode).toBe('smooth');
      expect(smooth.cmd.voxel).toBeUndefined();
      expect(stepAt()).toBeLessThan(steep);
      // Flatten from the flat rock onto the ridge's end: the plane is the rock's top where the stroke began, and the ridge under the stroke comes down to it.
      store.set({ size: 6 });
      const flat = await drag({ kind: 'flatten', soft: false, shape: 'cylinder' }, 2, 8, 8);
      expect(flat.cmd).toMatchObject({ mode: 'flatten', height: 1, smooth: false });
      expect(ridge).toBeGreaterThan(4);
      for (const x of [10, 12, 14]) expect(height(x, 16)).toBe(1);
      expect(height(26, 16)).toBeGreaterThan(4);
      // Paint: the material and the wetness; the wall block stays a wall, the rock ground.
      store.set({ size: 4 });
      const paint = await drag({ kind: 'paint', uses: ['size', 'spacing', 'mask'], voxel: { material: 9, wetness: 3 } }, 14, 16, 8);
      expect(paint.cmd.voxel).toEqual({ material: 9, wetness: 3 });
      expect(readValue(at(30, 1, 16), { ...rec })).toMatchObject({ material: 9, role: VOXEL_ROLE.wall, wetness: 3 });
      expect(readValue(at(30, 0, 16), { ...rec })).toMatchObject({ material: 9, role: VOXEL_ROLE.terrain, wetness: 3 });
      // Through the noise mask: some of the columns under the brush take the material, not all.
      store.set({ mask: { on: true, scale: 1.5 } });
      const masked = await drag({ kind: 'paint', uses: ['size', 'spacing', 'mask'], voxel: { material: 11, wetness: 0 } }, 4, 8, 14);
      expect(masked.cmd).toMatchObject({ shape: 'box', size: [0.5, 4.5, 0.5] });
      let took = 0;
      let left = 0;
      for (let x = 6; x <= 18; x++) for (let z = 26; z <= 30; z++) {
        if (readValue(at(x, 0, z), { ...rec }).material === 11) took++;
        else left++;
      }
      expect(took).toBeGreaterThan(0);
      expect(left).toBeGreaterThan(0);

      // Each stroke was one step of the project's undo line: five undos give the first voxels back.
      for (let i = 0; i < 5; i++) expect((await step('undo')).voxels, `undo ${i}`).toMatchObject({ ok: true, op: 'undo' });
      expectSame(await readChunks(CHUNKS, BRUSHED), first, CHUNKS);
    } finally {
      tool.dispose();
      vi.unstubAllGlobals();
    }
  }, 120_000);

  it('the fill tools and the fog brush over the command route: fog painted, erased and smoothed leaves ground, a wall and water byte for byte, a fog fill and a drain are one flood each, a breached fill is refused with its places marked, and five undos give the first voxels back', async () => {
    const FOGGED = 'fogged';
    const ROCK = recordValue(7, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
    const WALL = recordValue(5, VOXEL_ROLE.wall, SHAPE_FULL, 0);
    const WATER = recordValue(30, VOXEL_ROLE.liquid, SHAPE_FULL, 0);
    const inPond = (x: number, y: number, z: number): boolean => x >= 34 && x <= 40 && z >= 10 && z <= 16 && y >= -1 && y <= 0;
    const inBasin = (x: number, y: number, z: number): boolean => x >= 4 && x <= 12 && z >= 24 && z <= 32 && y >= -3 && y <= 0;
    // Rock with its top at cell 1 (y ≤ 0); a pond two cells deep, a wall block on the rock, a basin four cells deep.
    const made = (): PaletteStore => {
      const st = createWorldStore(grid);
      const r = { material: 0, role: 0, shape: 0, wetness: 0 };
      for (let x = -8; x <= 56; x++) for (let z = -8; z <= 40; z++) for (let y = -6; y <= 0; y++) {
        if (inBasin(x, y, z)) continue;
        st.setVoxel(x, y, z, readValue(inPond(x, y, z) ? WATER : ROCK, r));
      }
      st.setVoxel(30, 1, 13, readValue(WALL, r));
      return st;
    };
    const first = made();
    const oracle = made();
    writeVoxelWorld(join(backend._test.service.projectDir(PROJECT)!, 'voxels', FOGGED), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, made());
    const CHUNKS: ChunkCoord[] = [-1, 0, 1].flatMap((cx) => [-1, 0].flatMap((cy) => [-1, 0, 1].map((cz) => ({ cx, cy, cz }))));
    const rec = { material: 0, role: 0, shape: 0, wetness: 0 };
    const at = (x: number, y: number, z: number): number => valueOf(oracle.voxelAt(x, y, z, rec));
    /** The highest cell of a column the view's pick stops on: a body (fog and water are passed). */
    const top = (x: number, z: number): number => {
      for (let y = 24; y >= -6; y--) {
        const v = at(x, y, z);
        if (v !== 0 && !isMediumRole(valueRole(v))) return y;
      }
      return -7;
    };
    /** Every cell of the made box by what it holds: how many are ground or wall, water, gas. */
    const census = (st: PaletteStore): { body: number; water: number; gas: number; hash: string } => {
      let body = 0;
      let water = 0;
      let gas = 0;
      const h = createHash('sha256');
      for (let x = -8; x <= 56; x++) for (let z = -8; z <= 40; z++) for (let y = -6; y <= 12; y++) {
        const v = valueOf(st.voxelAt(x, y, z, rec));
        if (v === 0) continue;
        const role = valueRole(v);
        if (isGasRole(role)) gas++;
        else {
          // What is not gas, where it is and what it is: ground, the wall and the water.
          h.update(`${x},${y},${z}:${v};`);
          if (isMediumRole(role)) water++;
          else body++;
        }
      }
      return { body, water, gas, hash: h.digest('hex') };
    };
    const before = census(first);
    expect(before).toMatchObject({ water: 7 * 7 * 2, gas: 0 });

    const RECT = { left: 0, top: 0, width: 800, height: 600, x: 0, y: 0, right: 800, bottom: 600 };
    const camera = new THREE.PerspectiveCamera(50, RECT.width / RECT.height, 0.1, 500);
    camera.position.set(12, 40, 30);
    camera.lookAt(12, 0, 8);
    camera.updateMatrixWorld();
    const overlay = new THREE.Group();
    const answers: Array<{ status: number; json: Record<string, unknown> }> = [];
    const sent: Record<string, unknown>[] = [];
    const refusals: string[] = [];
    let pending: Promise<unknown> = Promise.resolve();
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
    resetBrushStores();
    const store = brushStore('http', 'fog', FOG_BRUSH, FOG_BRUSH_BOUNDS, null);
    const attrs = new Map<string, string>();
    const canvas = { getBoundingClientRect: () => RECT, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: () => undefined, parentElement: null } as unknown as HTMLCanvasElement;
    const run = (cmd: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
      sent.push(cmd);
      const p = command({ op: 'editVoxels', projectId: PROJECT, args: { world: FOGGED, command: cmd } }).then((r) => {
        answers.push(r);
        return r;
      });
      pending = p;
      return p;
    };
    const tool = new VoxelBrushTool(
      {
        overlay,
        camera,
        canvas: () => canvas,
        requestRender: () => undefined,
        pick: (x, y) => {
          const r = new THREE.Raycaster();
          r.setFromCamera(new THREE.Vector2((x / RECT.width) * 2 - 1, -(y / RECT.height) * 2 + 1), camera);
          const p = r.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
          if (p === null) return Promise.resolve(null);
          const cx = Math.floor(p.x / VOXEL_SIZE_M);
          const cz = Math.floor(p.z / VOXEL_SIZE_M);
          return Promise.resolve({ world: FOGGED, grid: 0, t: 1, cell: [cx, top(cx, cz), cz] as const, normal: [0, 1, 0] as const, record: at(cx, top(cx, cz), cz) });
        },
        place: () => null,
        // The view's cells, as its worker would answer them: the voxels as they are.
        cells: (_w, box) => {
          const out = new Uint32Array((box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1));
          let i = 0;
          for (let x = box.min[0]; x <= box.max[0]; x++) for (let z = box.min[2]; z <= box.max[2]; z++) for (let y = box.min[1]; y <= box.max[1]; y++) out[i++] = at(x, y, z);
          return Promise.resolve(out);
        },
      },
      {
        stroke: async (_world, cmd) => void (await run(cmd)),
        refused: (m) => void refusals.push(m),
        readout: () => undefined,
        send: async (op, args) => {
          expect(op).toBe('editVoxels');
          const r = await run(args['command'] as Record<string, unknown>);
          const e = r.json.error as { code: string; message: string; leaks?: Array<{ at: [number, number, number]; kind: 'reach' | 'world'; cells: number }> } | undefined;
          return r.status === 200 ? { ok: true } : { ok: false, code: e!.code, message: e!.message, ...(e!.leaks !== undefined ? { leaks: e!.leaks } : {}) };
        },
      },
    );
    const ev = (xm: number, zm: number, upPx = 0): PointerEvent => {
      const p = new THREE.Vector3(xm, 0, zm).project(camera);
      return { clientX: ((p.x + 1) / 2) * RECT.width, clientY: ((1 - p.y) / 2) * RECT.height - upPx, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1 } as unknown as PointerEvent;
    };
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const armed = { navigate: false, world: FOGGED, grid: 0, entityId: null, store, shape: 'sphere', soft: false } as const;
    const GAS = { material: 50, role: VOXEL_ROLE.gas, wetness: 0 };
    /** The last command answered 200 with what the same command does to the oracle, the files equal to it. */
    const applied = async (parts: number): Promise<{ cmd: ReturnType<typeof canonicalEditCommand>; cells: number }> => {
      for (let i = 0; i < 4; i++) await tick();
      await pending;
      await tick();
      const cmd = canonicalEditCommand(sent.at(-1));
      const out = applyEdit({ store: () => oracle }, cmd);
      const r = answers.at(-1)!;
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json).toMatchObject({ ok: true, op: 'editVoxels', cells: out.cells, parts });
      expect(out.cells).toBeGreaterThan(0);
      expectSame(await readChunks(CHUNKS, FOGGED), oracle, CHUNKS);
      return { cmd, cells: out.cells };
    };
    /** A brush drag over the ground along x (metres) at z, a move every 0.5 m. */
    const drag = async (arm: Partial<VoxelBrushArm>, x0: number, x1: number, zm: number): Promise<void> => {
      tool.arm({ ...armed, kind: 'fog', uses: ['size', 'spacing', 'invert'], voxel: GAS, ...arm });
      tool.pointerMove(ev(x0, zm));
      await tick();
      expect(tool.pointerDown(ev(x0, zm))).toBe('capture');
      for (let x = x0 + 0.5; x <= x1; x += 0.5) {
        tool.pointerMove(ev(x, zm));
        await tick();
      }
      tool.pointerUp(ev(x1, zm));
    };
    /** A fill's click on the ground at (x, z) metres, with no drag: the level is the set depth over the point. */
    const fill = async (kind: 'fog' | 'drain', depthM: number, xm: number, zm: number): Promise<void> => {
      tool.arm({ ...armed, kind: 'fog', uses: [], voxel: null, fill: { kind, material: kind === 'fog' ? 50 : null, depthM, reachM: 8, fadeM: 0, sceneId: null } });
      tool.pointerMove(ev(xm, zm));
      await tick();
      expect(tool.pointerDown(ev(xm, zm))).toBe('capture');
      tool.pointerUp(ev(xm, zm));
    };
    try {
      // Fog painted from the rock, past the wall block, onto the pond: a set of the open cells, the gas part alone.
      store.set({ size: 3 });
      await drag({ density: 6 }, 13.25, 19.25, 6.75);
      const paint = await applied(DERIVED_PART.gas);
      expect(paint.cmd).toMatchObject({ kind: 'set', voxel: { material: 50, role: VOXEL_ROLE.gas, wetness: 0, shape: 6 } });
      const painted = census(oracle);
      expect(painted.gas).toBe(paint.cells);
      // Ground, the wall and the water: every cell where and what it was.
      expect({ ...painted, gas: 0 }).toEqual(before);
      expect(readValue(at(30, 1, 13), { ...rec })).toMatchObject({ material: 5, role: VOXEL_ROLE.wall });
      // Fog stands over the pond and beside the wall.
      expect(valueRole(at(36, 1, 13))).toBe(VOXEL_ROLE.gas);
      expect(valueRole(at(29, 1, 13))).toBe(VOXEL_ROLE.gas);

      // Erase over the first metres of it: a dig of gas cells alone.
      await drag({ kind: 'fog-erase' }, 13.25, 15.25, 6.75);
      const erase = await applied(DERIVED_PART.gas);
      expect(erase.cmd.kind).toBe('dig');
      const erased = census(oracle);
      expect(erased.gas).toBe(painted.gas - erase.cells);
      expect(erased.gas).toBeGreaterThan(0);
      expect({ ...erased, gas: 0 }).toEqual(before);
      // An eraser dragged over bare rock and the pond with no fog left there sends nothing.
      const n = sent.length;
      await drag({ kind: 'fog-erase' }, 2.25, 4.25, 2.25);
      for (let i = 0; i < 4; i++) await tick();
      expect(sent.length).toBe(n);
      expect(refusals.at(-1)).toBe('No fog under the brush.');

      // Smooth the bank's end: the brush's smooth with the gas, the gas part alone.
      await drag({ kind: 'fog-smooth', soft: true, uses: ['size', 'spacing'] }, 17.25, 19.25, 6.75);
      const smooth = await applied(DERIVED_PART.gas);
      expect(smooth.cmd).toMatchObject({ kind: 'brush', mode: 'smooth', voxel: GAS });
      expect({ ...census(oracle), gas: 0 }).toEqual(before);

      // A fog fill in the basin, to the rock's top: one flood, its three rows of nine by nine cells under the level.
      const revisionOf = async (): Promise<number> => ((await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${FOGGED}`, { headers: auth })).json()) as { manifest: { revision: number } }).manifest.revision;
      await fill('fog', 1.5, 4.25, 14.25);
      const flooded = await applied(DERIVED_PART.gas);
      expect(flooded.cmd).toMatchObject({ kind: 'flood', seed: [8, -3, 28], level: 0, value: { material: 50, role: VOXEL_ROLE.gas }, reach: 16 });
      expect(flooded.cells).toBe(9 * 9 * 3);

      // The same click to a level over the rock: the fog would spread over open ground, past its reach. Refused, marked, nothing written.
      const revision = await revisionOf();
      await fill('fog', 2.5, 4.25, 14.25);
      for (let i = 0; i < 4; i++) await tick();
      await pending;
      await tick();
      const leak = answers.at(-1)!;
      expect(leak.status, JSON.stringify(leak.json)).toBe(400);
      const leaks = (leak.json.error as { code: string; leaks: Array<{ at: [number, number, number] }> }).leaks;
      expect((leak.json.error as { code: string }).code).toBe('flood_leaks');
      expect(leaks.length).toBeGreaterThan(0);
      tool.frame();
      const mark = JSON.parse(attrs.get('data-voxel-brush')!) as { fill: { leaks: number[][]; last: Record<string, unknown> } };
      expect(mark.fill.leaks).toEqual(leaks.map((l) => l.at));
      expect(mark.fill.last).toMatchObject({ fill: 'fog', ok: false, error: 'flood_leaks', leaks: leaks.length });
      expect((overlay.getObjectByName('flood-leaks-marks') as THREE.LineSegments).userData['marks']).toBe(leaks.length);
      expect(refusals.at(-1)).toMatch(/^The fog leaks past its reach at \d+ places?, first at \(/);
      expect(await revisionOf()).toBe(revision);
      expectSame(await readChunks(CHUNKS, FOGGED), oracle, CHUNKS);

      // Drain the basin: the same flood with air; its fog is gone, the marks with it.
      await fill('drain', 1.5, 4.25, 14.25);
      const drained = await applied(DERIVED_PART.gas);
      expect(drained.cmd).toMatchObject({ kind: 'flood', value: { material: 0, role: 0 } });
      expect(drained.cells).toBe(9 * 9 * 3);
      expect(overlay.getObjectByName('flood-leaks-marks')).toBeUndefined();
      expect({ ...census(oracle), gas: 0 }).toEqual(before);

      // Five steps on the project's undo line (paint, erase, smooth, fill, drain): back to the first voxels.
      for (let i = 0; i < 5; i++) expect((await step('undo')).voxels, `undo ${i}`).toMatchObject({ ok: true, op: 'undo' });
      expectSame(await readChunks(CHUNKS, FOGGED), first, CHUNKS);
    } finally {
      tool.dispose();
      vi.unstubAllGlobals();
    }
  }, 120_000);

  it("a dressing is its own file and a material names it: made, edited, refused, set on a material and overridden by an instance over HTTP and through MCP, one undo each, read back after a restart, shipped by an export with its species' model", async () => {
    expect(KIT_MODEL.assetId).not.toBe('');
    const query = async (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await command({ op, projectId: PROJECT, args })).json;
    const send = async (op: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => command({ op, projectId: PROJECT, expectedRevision: (await query('queryProject'))['revision'] as number, requestId: `req-${randomBytes(16).toString('hex')}`, args });
    const game = async (): Promise<{ dressings: Array<Record<string, unknown>>; materials: Array<Record<string, unknown>> }> => (await query('queryGameConfig', { omit: ['dialogues'] })) as never;
    const codeOf = (r: { json: Record<string, unknown> }): string => { const e = r.json['error'] as { code: string; details?: Array<{ code: string }> }; return e.details?.[0]?.code ?? e.code; };
    const dir = backend._test.service.projectDir(PROJECT)!;
    const fileOf = (id: string): string => join(dir, 'assets', 'dressings', `${id}.dressing.json`);
    const onDisk = (id: string): Record<string, unknown> => JSON.parse(readFileSync(fileOf(id), 'utf8')) as Record<string, unknown>;
    // Every field of format 1, a cover species and a large one; the model is the project's own (the kit's pieces).
    const meadow = {
      dressingFormat: 1,
      dressingId: 'meadow',
      name: 'Meadow',
      species: [
        { model: KIT_MODEL.assetId, class: 'cover', density: 6, spacing: 0.25, scale: [0.8, 1.3], yaw: 180, align: 0.5, seed: 7, conditions: { material: [21, 22], role: ['terrain'], slope: { max: 35, fade: 10 }, height: { min: -4, max: 120 }, sky: true, wetness: { max: 5 }, waterDepth: { max: 0 }, materialEdge: { min: 0.5 }, construction: { min: 1, fade: 0.5 }, noise: { min: 0.4, scale: 12, fade: 0.1, seed: 5 } } },
        { model: KIT_MODEL.assetId, class: 'large', density: 0.01, spacing: 9, conditions: { sky: true } },
      ],
    };
    const made = await send('setDressing', { dressing: meadow });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(made.json['change']).toMatchObject({ type: 'setDressing', dressingId: 'meadow', previous: null });
    const stored = (await game()).dressings[0]!;
    expect(stored).toEqual(meadow);
    expect(JSON.stringify(stored)).toBe(JSON.stringify(meadow));
    // Its own file in the game folder (the resource kind's folder), holding the record whole.
    expect(onDisk('meadow')).toMatchObject({ tlresource: 1, kind: 'dressing', id: 'meadow' });
    expect(onDisk('meadow')['data']).toEqual(meadow);
    // Refused, nothing changed: a newer format, a field and a condition the format lacks, a cover species spaced past its reach.
    const cover = meadow.species[0]!;
    for (const bad of [{ ...meadow, dressingFormat: 2 }, { ...meadow, exceptions: [] }, { ...meadow, species: [{ ...cover, conditions: { cavity: { min: 1 } } }] }, { ...meadow, species: [{ ...cover, spacing: 20 }] }]) {
      const r = await send('setDressing', { dressing: bad });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
    }
    expect((await game()).dressings).toEqual([stored]);
    // Edited (the same command), then undone: the record and its file follow.
    const denser = { ...meadow, species: [{ ...cover, density: 9 }, meadow.species[1]!] };
    const edited = await send('setDressing', { dressing: denser });
    expect(edited.json['change']).toMatchObject({ type: 'setDressing', dressingId: 'meadow', previous: stored });
    expect(((onDisk('meadow')['data'] as { species: Array<{ density: number }> }).species[0]!).density).toBe(9);
    expect((await send('undo', {})).status).toBe(200);
    expect((await game()).dressings).toEqual([stored]);
    expect(onDisk('meadow')['data']).toEqual(meadow);

    // A material names it; one it does not have is refused; a variant names another (a sparser meadow).
    const grass = { materialId: 'grass', name: 'Grass', shader: 'standard', params: {}, textures: {}, voxel: { id: 21, use: 'terrain', dressing: 'meadow' } };
    expect(codeOf(await send('setMaterial', { material: { ...grass, voxel: { ...grass.voxel, dressing: 'heath' } } }))).toBe('dressing_missing');
    expect((await send('setMaterial', { material: grass })).status).toBe(200);
    expect((await game()).materials.find((m) => m['materialId'] === 'grass')!['voxel']).toEqual({ id: 21, use: 'terrain', dressing: 'meadow' });
    const sparse = { dressingFormat: 1, dressingId: 'meadow-sparse', name: 'Sparse meadow', species: [{ model: KIT_MODEL.assetId, class: 'cover', density: 1.5 }] };
    expect((await send('setDressing', { dressing: sparse })).status).toBe(200);
    const dry = { materialId: 'grass-dry', name: 'Dry grass', shader: 'standard', params: {}, textures: {}, instanceOf: 'grass', voxel: { id: 22, dressing: 'meadow-sparse' } };
    expect((await send('setMaterial', { material: dry })).status).toBe(200);
    expect((await game()).materials.find((m) => m['materialId'] === 'grass-dry')!['voxel']).toEqual({ id: 22, dressing: 'meadow-sparse' });
    // A dressing a material names is not deleted from under it (the base's, and the variant's).
    expect(codeOf(await send('deleteDressing', { dressingId: 'meadow' }))).toBe('dressing_missing');
    expect(codeOf(await send('deleteDressing', { dressingId: 'meadow-sparse' }))).toBe('dressing_missing');
    expect(codeOf(await send('deleteDressing', { dressingId: 'heath' }))).toBe('reference_missing');
    // The variant's override is one undo step: taken back, the variant is gone and its dressing can be deleted; redone, not.
    expect((await send('undo', {})).status).toBe(200);
    expect((await game()).materials.some((m) => m['materialId'] === 'grass-dry')).toBe(false);
    expect((await send('redo', {})).status).toBe(200);
    expect((await game()).materials.find((m) => m['materialId'] === 'grass-dry')!['voxel']).toEqual({ id: 22, dressing: 'meadow-sparse' });

    // MCP's tl_command sends the same ops; a dressing nothing names is deleted (its file goes) and comes back by undo.
    const server = createMcpServer({ client: new BackendClient({ authoringOrigin: base(), token: TOKEN }), projectId: PROJECT, clientId: 'dressing-mcp' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'dressing-mcp-test', version: '0.1.0' });
    await mcp.connect(clientTransport);
    try {
      const { tools } = await mcp.listTools();
      const opEnum = (tools.find((t) => t.name === 'tl_command')!.inputSchema as { properties: { op: { enum: string[] } } }).properties.op.enum;
      expect(opEnum).toEqual(expect.arrayContaining(['setDressing', 'deleteDressing']));
      const spare = { dressingFormat: 1, dressingId: 'spare', name: 'Spare', species: [] };
      const res = (await mcp.callTool({ name: 'tl_command', arguments: { op: 'setDressing', expectedRevision: (await query('queryProject'))['revision'], args: { dressing: spare } } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError === true, res.content[0]!.text).toBe(false);
      const g = (await mcp.callTool({ name: 'tl_content_query', arguments: { target: 'game' } })) as { content: Array<{ text: string }> };
      expect((JSON.parse(g.content[0]!.text) as { dressings: Array<{ dressingId: string }> }).dressings.map((d) => d.dressingId)).toEqual(['meadow', 'meadow-sparse', 'spare']);
    } finally {
      await mcp.close();
      await server.close();
    }
    expect(existsSync(fileOf('spare'))).toBe(true);
    expect((await send('deleteDressing', { dressingId: 'spare' })).status).toBe(200);
    expect(existsSync(fileOf('spare'))).toBe(false);
    expect((await send('undo', {})).status).toBe(200);
    expect(existsSync(fileOf('spare'))).toBe(true);

    // A restart reads the project from its files: the dressings and the materials' fields as they were.
    await close();
    await start();
    expect((await game()).dressings.map((d) => d['dressingId'])).toEqual(['meadow', 'meadow-sparse', 'spare']);
    expect((await game()).dressings[0]).toEqual(stored);
    expect((await game()).materials.find((m) => m['materialId'] === 'grass-dry')!['voxel']).toEqual({ id: 22, dressing: 'meadow-sparse' });

    // An export (its bundle scanned as every export's is) ships the dressings its voxel materials name, the variant's
    // too, and not the one nothing names; the variant ships with its chain folded in; the species' model is an asset
    // of the build that the project-wide blocks need.
    const r = await fetch(`${base()}/api/v1/admin/projects/${PROJECT}/export`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
    const exported = (await r.json()) as Record<string, unknown>;
    expect(r.status, JSON.stringify(exported).slice(0, 600)).toBe(200);
    const out = join(root, 'exports', String(exported['outputDir']));
    const content = readRuntimeContentSync(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), (path) => {
      try {
        return new Uint8Array(readFileSync(join(out, path)));
      } catch {
        return null;
      }
    }) as unknown as { dressings?: Array<Record<string, unknown>>; materials?: Array<Record<string, unknown>>; dependencies?: Array<{ assetId: string }> };
    expect(content.dressings).toEqual([meadow, sparse]);
    expect(content.materials!.find((m) => m['materialId'] === 'grass-dry')!['voxel']).toEqual({ id: 22, use: 'terrain', dressing: 'meadow-sparse' });
    expect(content.dependencies!.map((d) => d.assetId)).toContain(KIT_MODEL.assetId);
  }, 120_000);

  it("the Basic Kit's starter cover in a project: the kit added, a grass ground made the way the world mode makes it, its Meadow growing on that material's cells, the Dressing card's edits as commands, and an export shipping the dressing with its plants", async () => {
    const query = async (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await command({ op, projectId: PROJECT, args })).json;
    const send = async (op: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => command({ op, projectId: PROJECT, expectedRevision: (await query('queryProject'))['revision'] as number, requestId: `req-${randomBytes(16).toString('hex')}`, args });
    const game = async (): Promise<{ dressings: DressingDef[]; materials: MaterialDef[] }> => (await query('queryGameConfig', { omit: ['dialogues'] })) as never;
    const codeOf = (r: { json: Record<string, unknown> }): string | undefined => (r.json['error'] as { code?: string } | undefined)?.code ?? (r.json['code'] as string | undefined);
    const PLANTS = ['basic-flower', 'basic-grass', 'basic-pebbles', 'basic-reed'];

    // The kit, as Create → Basic Kit adds it.
    const added = await fetch(`${base()}/api/v1/projects/${PROJECT}/packs/basic-kit`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
    expect(added.status, JSON.stringify(await added.clone().json()).slice(0, 600)).toBe(200);
    const before = await game();
    expect(before.dressings.map((d) => d.dressingId)).toEqual(expect.arrayContaining(['basic-gravel', 'basic-meadow', 'basic-shore']));
    // It brought no voxel material: nothing names its dressings yet, so nothing grows.
    expect(voxelCoverTable(before).dressings.map((d) => d.dressingId).filter((id) => id.startsWith('basic-'))).toEqual([]);

    // "Make a grass material": the world mode's starter ground, with the project's next free voxel id.
    const taken = new Set(before.materials.flatMap((m) => (m.voxel !== undefined ? [m.voxel.id] : [])));
    let free = 1;
    while (taken.has(free)) free++;
    const grass = starterGround(STARTER_GROUNDS[0], 'starter-grass', free, before.dressings) as unknown as MaterialDef;
    expect((await send('setMaterial', { material: grass })).status).toBe(200);
    const now = await game();
    expect(now.materials.find((m) => m.materialId === 'starter-grass')!.voxel).toEqual({ id: free, use: 'terrain', dressing: 'basic-meadow' });
    const table = voxelCoverTable(now);
    const meadowAt = table.dressings.findIndex((d) => d.dressingId === 'basic-meadow');
    expect(meadowAt).toBeGreaterThanOrEqual(0);
    expect(table.materials).toContainEqual([free, meadowAt]);

    // Ground of that material, 24 m a side, a pond one cell deep in a corner: the Meadow's grass on the dry part, its
    // reeds in the water and nowhere else. No species names a material id: each grows on the material naming the dressing.
    const side = 48;
    const ground = recordValue(free, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
    const water = recordValue(900, VOXEL_ROLE.liquid, SHAPE_FULL, 0);
    const pond = (x: number, z: number): boolean => x >= 30 && x < 42 && z >= 30 && z < 42;
    const values = new Uint32Array(side * 8 * side);
    for (let x = 0; x < side; x++) for (let z = 0; z < side; z++) for (let y = 0; y < 8; y++) values[(x * side + z) * 8 + y] = y < 3 ? ground : y === 3 ? (pond(x, z) ? water : ground) : 0;
    const cells = { sx: side, sy: 8, sz: side, ox: 0, oy: 0, oz: 0, cellM: VOXEL_SIZE_M, values };
    const grown = voxelCoverOfCells(cells, [4, 4, 20, 20], table);
    const meadow = grown.sets.filter((x) => x.dressing === 'basic-meadow');
    const stored = now.dressings.find((d) => d.dressingId === 'basic-meadow')!;
    const modelsGrown = new Map(meadow.map((x) => [stored.species[x.species]!.model, 0]));
    for (const set of meadow) {
      const model = stored.species[set.species]!.model;
      modelsGrown.set(model, modelsGrown.get(model)! + set.points.count);
      for (let i = 0; i < set.points.count; i++) {
        const at = coverPointAt(set.points, i);
        const px = Math.floor(at.x / VOXEL_SIZE_M);
        const pz = Math.floor(at.z / VOXEL_SIZE_M);
        expect(pond(px, pz), `${model} at cell ${px}, ${pz}`).toBe(model === 'basic-reed');
      }
    }
    expect(modelsGrown.get('basic-grass')!).toBeGreaterThan(1000);
    expect(modelsGrown.get('basic-reed')!).toBeGreaterThan(3);
    // A ground of another material grows none of it.
    const other = new Uint32Array(values.map((v) => (v === ground ? recordValue(901, VOXEL_ROLE.terrain, SHAPE_FULL, 0) : v)));
    expect(voxelCoverOfCells({ ...cells, values: other }, [4, 4, 20, 20], table).sets.filter((x) => x.dressing === 'basic-meadow')).toEqual([]);

    // The Dressing card's edits, each one `setDressing` of the whole record and one undo step.
    const read = async (): Promise<DressingDef> => (await game()).dressings.find((d) => d.dressingId === 'basic-meadow')!;
    const edits: [what: string, next: (d: DressingDef) => DressingDef, check: (d: DressingDef) => void][] = [
      ['density', (d) => withSpecies(d, 0, { density: 3 }), (d) => expect(d.species[0]!.density).toBe(3)],
      ['a condition', (d) => withCondition(d, 0, 'slope', rangeWith(d.species[0]!.conditions?.slope, { max: 25 })), (d) => expect(d.species[0]!.conditions!.slope).toEqual({ max: 25, fade: 10 })],
      ['noise', (d) => withCondition(d, 0, 'noise', noiseWith(undefined, { min: 0.4, fade: 0.1 })), (d) => expect(d.species[0]!.conditions!.noise).toEqual({ min: 0.4, fade: 0.1, scale: 8 })],
      ['a species added', (d) => withSpeciesAdded(d, 'basic-pebbles'), (d) => expect(d.species.map((s) => s.model)).toEqual(['basic-grass', 'basic-flower', 'basic-flower', 'basic-reed', 'basic-pebbles'])],
      ['reordered', (d) => withSpeciesMoved(d, 4, 0)!, (d) => expect(d.species.map((s) => s.model)).toEqual(['basic-pebbles', 'basic-grass', 'basic-flower', 'basic-flower', 'basic-reed'])],
      ['removed', (d) => withSpeciesRemoved(d, 0), (d) => expect(d.species.map((s) => s.model)).toEqual(['basic-grass', 'basic-flower', 'basic-flower', 'basic-reed'])],
      ['large', (d) => withSpecies(d, 3, { class: 'large' }), (d) => expect(d.species[3]!.class).toBe('large')],
    ];
    for (const [what, next, check] of edits) {
      const r = await send('setDressing', { dressing: next(await read()) });
      expect(r.status, `${what}: ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
      check(await read());
    }
    // Seven edits, seven undo steps back to the kit's record.
    for (let i = 0; i < edits.length; i++) expect((await step()).status).toBe(200);
    expect(await read()).toEqual(stored);
    // An edit that changes nothing is refused, not stored as a step.
    expect(codeOf(await send('setDressing', { dressing: stored }))).toBe('no_change');

    // A variant with a dressing of its own (the card's pick on an instance), and cleared again: it grows its parent's.
    const dry: MaterialDef = { materialId: 'starter-grass-dry', name: 'Dry grass', shader: 'standard', params: {}, textures: {}, instanceOf: 'starter-grass', voxel: { id: free + 400 } };
    expect((await send('setMaterial', { material: dry })).status).toBe(200);
    expect(voxelCoverTable(await game()).materials).toContainEqual([free + 400, voxelCoverTable(await game()).dressings.findIndex((d) => d.dressingId === 'basic-meadow')]);
    expect((await send('setMaterial', { material: materialWithDressing(dry, 'basic-gravel') })).status).toBe(200);
    const variant = voxelCoverTable(await game());
    expect(variant.materials).toContainEqual([free + 400, variant.dressings.findIndex((d) => d.dressingId === 'basic-gravel')]);
    expect((await send('setMaterial', { material: materialWithDressing(materialWithDressing(dry, 'basic-gravel'), undefined) })).status).toBe(200);
    expect((await game()).materials.find((m) => m.materialId === 'starter-grass-dry')!.voxel).toEqual({ id: free + 400 });

    // An export ships the Meadow (named by the grass), not Shore or Gravel (named by nothing), and the Meadow's plants
    // with the material they wear. (A build ships a voxel material when the project holds a voxel world, whose cells
    // may be of it: the tests above made this project's worlds.)
    const r = await fetch(`${base()}/api/v1/admin/projects/${PROJECT}/export`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
    const exported = (await r.json()) as Record<string, unknown>;
    expect(r.status, JSON.stringify(exported).slice(0, 600)).toBe(200);
    const out = join(root, 'exports', String(exported['outputDir']));
    const content = readRuntimeContentSync(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), (path) => {
      try {
        return new Uint8Array(readFileSync(join(out, path)));
      } catch {
        return null;
      }
    }) as unknown as { dressings?: DressingDef[]; materials?: MaterialDef[]; assets?: Array<{ assetId: string; materials?: Record<string, string> }>; dependencies?: Array<{ assetId: string }> };
    const shipped = content.dressings!.map((d) => d.dressingId).filter((id) => id.startsWith('basic-'));
    expect(shipped).toEqual(['basic-meadow']);
    expect(content.dressings!.find((d) => d.dressingId === 'basic-meadow')).toEqual(stored);
    const deps = content.dependencies!.map((d) => d.assetId);
    for (const id of ['basic-grass', 'basic-flower', 'basic-reed']) expect(deps, id).toContain(id);
    expect(deps).not.toContain('basic-pebbles');
    expect(PLANTS.length).toBe(4);
    expect(content.materials!.map((m) => m.materialId)).toContain('basic-cover');
  }, 120_000);
});
