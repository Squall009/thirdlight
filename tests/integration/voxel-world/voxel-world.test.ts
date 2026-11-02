/**
 * A project's voxel world against a real backend over HTTP, with real
 * region files on disk: the world's manifest and region files read by byte
 * range (auth, origin, tags, 206/200/412/416), voxel edit and undo commands
 * on the command route (applied by the workspace, region files replaced,
 * revision moved, request ids answered once, refusals), and a second
 * backend over the same data root finding the edit in the files, and a
 * region file the manifest lists but that is gone reported as damaged
 * (never air) while an unlisted region reads as air.
 *
 * Chunks are read back the way a browser does: a region chunk source whose
 * byte source sends Range requests to the route, decoded into a store, and
 * compared with the same commands applied to a copy in this process.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestBackend, testTempBase } from '@thirdlight/backend/testing';
import type { Backend } from '@thirdlight/backend/services';
import {
  applyEdit,
  canonicalEditCommand,
  chunkGrid,
  createDenseChunk,
  createWorldStore,
  editBounds,
  exportOrAir,
  parseRegionFileName,
  RegionChunkSource,
  sameDenseChunk,
  type ChunkCoord,
  type RegionChunkRead,
  type PaletteStore,
} from '@thirdlight/voxel';
import { importRead, writeVoxelWorld } from '@thirdlight/workspace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flatGround, placeWallBeamBanister } from '../../../tools/voxel-bench/scenes';

const ORIGIN = 'http://127.0.0.1:8501';
const TOKEN = 'voxel-authoring-token';
const ADMIN = 'voxel-admin-token';
const PROJECT = 'vox';
const WORLD = 'w';
const grid = chunkGrid(32);
const WORLD_ID = '00112233445566778899aabbccddeeff';

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

function sceneStore(): PaletteStore {
  const s = createWorldStore(grid);
  flatGround(s, -48, 48, -48, 48, 6, -3);
  placeWallBeamBanister(s);
  return s;
}

async function start(): Promise<void> {
  const tb = await createTestBackend({ dataRoot, authoringOrigin: ORIGIN, previewOrigin: 'http://127.0.0.1:8502', authoringOrigins: [ORIGIN], tokens: [{ token: TOKEN, scope: `authoring:${PROJECT}` }, { token: ADMIN, scope: 'admin' }] });
  backend = tb.backend;
  // The data root outlives a backend here (the restart reads it again): close only the server.
  close = () => tb.backend.close();
}

beforeAll(async () => {
  root = mkdtempSync(join(testTempBase(), 'tl-voxel-world-'));
  dataRoot = join(root, 'data');
  await start();
  expect(backend._test.service.createProject(PROJECT, 'Voxel world').ok).toBe(true);
  const dir = backend._test.service.projectDir(PROJECT)!;
  original = sceneStore();
  expected = sceneStore();
  writeVoxelWorld(join(dir, 'voxels', WORLD), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, original);
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
async function readRaw(chunks: readonly ChunkCoord[]): Promise<RegionChunkRead[]> {
  const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { worldId: string }; files: Array<{ name: string }> };
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
              const r = await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}/regions/${name}`, { headers: { ...auth, range: `bytes=${offset}-${offset + length - 1}` } });
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
async function readChunks(chunks: readonly ChunkCoord[]): Promise<PaletteStore> {
  const store = createWorldStore(grid);
  for (const r of await readRaw(chunks)) {
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
const DIG = { v: 1, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [0, 4, 0], mode: 'dig', smooth: false };

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

  it('a second backend over the same data root finds the edit in the region files and the revision in the manifest', async () => {
    await close();
    await start();
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { manifest: { revision: number } };
    expect(info.manifest.revision).toBe(3);
    expectSame(await readChunks(SCENE_CHUNKS), expected, SCENE_CHUNKS);
    // Undo history is the process's: none after a restart.
    expect(((await command({ op: 'undoVoxels', projectId: PROJECT, args: { world: WORLD } })).json.error as { code: string }).code).toBe('nothing_to_undo');
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
    const into = await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { v: 1, grid: 0, kind: 'set', cells: [inLost.cx * 32, inLost.cy * 32, inLost.cz * 32], voxel: { material: 3, category: 2, orientation: 0, shape: 255 } } } });
    expect(into.status).toBe(409);
    expect((into.json.error as { code: string }).code).toBe('chunk_not_loaded');
    const elsewhere = await command({ op: 'editVoxels', projectId: PROJECT, args: { world: WORLD, command: { v: 1, grid: 0, kind: 'set', cells: [0, 12, 0], voxel: { material: 3, category: 2, orientation: 0, shape: 255 } } } });
    expect(elsewhere.status, JSON.stringify(elsewhere.json)).toBe(200);
    expect((JSON.parse(readFileSync(join(worldDir, 'world.json'), 'utf8')) as { regions: string[] }).regions).toEqual(manifest.regions);
  }, 60_000);
});
