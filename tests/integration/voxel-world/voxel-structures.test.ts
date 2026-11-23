/**
 * Structures through the commands, against a real backend over HTTP with a
 * project and its voxel world on disk: a structure object made (its grid
 * given and its definition anchored by the backend, one region file, the
 * manifest's grids sorted, no overrides yet), a definition change
 * regenerated (the voxels equal the generator's fresh output), undo and
 * redo exact (the world folder's bytes equal) across a mix of scene edits
 * and voxel strokes on the project's one line, a hand edit on the grid kept
 * as overrides (`overrides.tlvo` written with the stroke, kept by a
 * regenerate where it fits, misfits answered and listed again), a material
 * swap that changes material ids only, a duplicate holding equal voxels and
 * overrides in a new grid and independent after, a delete whose files come
 * back with its undo, a move that rewrites no region file, a tilt refused,
 * `no_change`, a missing listed grid file reported, files changed on disk
 * by someone else refused (`world_changed`), regenerate-all (with a
 * generator one version on) as one undo step, and MCP's tl_command sending
 * the same ops.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTestBackend, testTempBase } from '@thirdlight/backend/testing';
import type { Backend } from '@thirdlight/backend/services';
import { anchoredDefinition, boxChunks, BUILDING_GENERATOR, chunkGrid, chunkOfKey, createDenseChunk, createWorldStore, decodeOverrides, denseValue, exportOrAir, PLANE_BIT, SHAPE_FULL, VOXEL_ROLE, type StructureDefinition, type StructureGenerator, type VoxelStoreCandidate } from '@thirdlight/voxel';
import { hexToBytes } from '@thirdlight/shared';
import { FAR_REBUILT_FOLDER, farCacheDir, RegionWorld, readVoxelWorldManifest, writeVoxelWorld, type VoxelWorlds } from '@thirdlight/workspace';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendClient } from '../../../packages/mcp-adapter/src/backend-client';
import { createMcpServer } from '../../../packages/mcp-adapter/src/server';
import { flatGround } from '../../../tools/voxel-bench/scenes';
import { commandEnvelope } from '../../support/commands';

const ORIGIN = 'http://127.0.0.1:8511';
const TOKEN = 'structure-token';
const PROJECT = 'houses';
const WORLD = 'town';
const WORLD_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const grid = chunkGrid(32);
const MAT = { wall: 10, floor: 14, roof: 13, foundation: 6, stair: 14 };
type Pt = [number, number];
const rect = (id: string, x0: number, z0: number, x1: number, z1: number): { id: string; points: Pt[] } => ({ id, points: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] });
/** The small house of the structure core's measurements: 8 × 6 m, two storeys, a door and a stair, a gable roof. */
const SMALL = { world: WORLD, footprint: [rect('main', 0, 0, 16, 12)], storeys: 2, storeyHeight: 6, foundationDepth: 2, roof: { shape: 'gable', overhang: 1, axis: 'x' }, materials: MAT, openings: [{ id: 'door', polygon: 'main', edge: 0, storey: 0, at: 6, width: 2, height: 4, sill: 0 }], stairs: [{ id: 's', polygon: 'main', from: 0, at: [1, 2], facing: '+z' }] };
const yawQ = (deg: number): [number, number, number, number] => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];

let root = '';
let backend: Backend;
let teardown: () => Promise<void>;
let worldDir = '';

const base = (): string => `http://127.0.0.1:${backend.portAuthoring}`;
const auth = { authorization: `Bearer ${TOKEN}` };
const rid = (): string => `req-${randomBytes(16).toString('hex')}`;

const post = async (body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${base()}/api/v1/projects/${PROJECT}/commands`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const query = async (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await post({ op, projectId: PROJECT, args })).json;
const revision = async (): Promise<number> => (await query('queryProject'))['revision'] as number;
const cmd = async (op: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => post(commandEnvelope(op, PROJECT, await revision(), args, null));
const stroke = async (command: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => post({ op: 'editVoxels', projectId: PROJECT, requestId: rid(), args: { world: WORLD, command } });
const lineStep = async (op: 'undo' | 'redo'): Promise<{ status: number; json: Record<string, unknown> }> => post(commandEnvelope(op, PROJECT, await revision(), {}, null));
const entity = async (id: string): Promise<Record<string, unknown> | undefined> => ((await query('queryEntity', { entityId: id }))['entity'] as { components?: Record<string, unknown> } | undefined)?.components;
const structureOf = async (id: string): Promise<Record<string, unknown>> => (await entity(id))!['voxelStructure'] as Record<string, unknown>;

/** Every file of the world folder (but the manifest, whose revision moves) by its path, with its hash; and the manifest's lists. */
function folderState(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name !== 'world.json') out[relative(worldDir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(worldDir);
  const m = readVoxelWorldManifest(worldDir);
  out['world.json:lists'] = JSON.stringify({ regions: m.regions, grids: m.grids });
  return out;
}

/** A structure grid as its files on disk hold it (every listed file opened whole). */
async function gridOnDisk(id: number): Promise<VoxelStoreCandidate> {
  const m = readVoxelWorldManifest(worldDir);
  const listed = m.grids.find((g) => g.id === id)?.regions ?? [];
  const { world } = await RegionWorld.open(join(worldDir, `grid-${id}`), { grid, worldId: hexToBytes(WORLD_ID), layout: 'stacked', footprint: 512, gridId: id }, listed);
  return world.store;
}

function fresh(def: StructureDefinition): VoxelStoreCandidate {
  const s = createWorldStore(grid);
  const out = createDenseChunk(grid);
  for (const c of boxChunks(grid, BUILDING_GENERATOR.box(def))) if (BUILDING_GENERATOR.chunk(def, grid, c.cx, c.cy, c.cz, out)) s.importChunk(c.cx, c.cy, c.cz, out);
  return s;
}

/** The cells where two stores differ (value pairs), over every chunk either holds. */
function differences(a: VoxelStoreCandidate, b: VoxelStoreCandidate): Array<{ x: number; y: number; z: number; a: number; b: number }> {
  const out: Array<{ x: number; y: number; z: number; a: number; b: number }> = [];
  const ca = createDenseChunk(grid);
  const cb = createDenseChunk(grid);
  for (const k of new Set([...a.chunkKeys(), ...b.chunkKeys()])) {
    const { cx, cy, cz } = chunkOfKey(grid, k);
    exportOrAir(a, cx, cy, cz, ca);
    exportOrAir(b, cx, cy, cz, cb);
    for (let i = 0; i < grid.cellsPerChunk; i++) {
      const p = denseValue(ca, i);
      const q = denseValue(cb, i);
      if (p !== q) out.push({ x: cx * 32 + (i >>> 10), y: cy * 32 + (i & 31), z: cz * 32 + ((i >>> 5) & 31), a: p, b: q });
    }
  }
  return out;
}

const definitionOf = (c: Record<string, unknown>): StructureDefinition => {
  const { world: _w, grid: _g, ...def } = c;
  return BUILDING_GENERATOR.canonical(def);
};

const worlds = (): VoxelWorlds => (backend._test as unknown as { voxelWorlds: VoxelWorlds }).voxelWorlds;

beforeAll(async () => {
  root = mkdtempSync(join(testTempBase(), 'tl-voxel-structures-'));
  const tb = await createTestBackend({ dataRoot: join(root, 'data'), authoringOrigin: ORIGIN, previewOrigin: 'http://127.0.0.1:8512', authoringOrigins: [ORIGIN], tokens: [{ token: TOKEN, scope: `authoring:${PROJECT}` }] });
  backend = tb.backend;
  teardown = tb.teardown;
  expect(backend._test.service.createProject(PROJECT, 'Houses').ok).toBe(true);
  worldDir = join(backend._test.service.projectDir(PROJECT)!, 'voxels', WORLD);
  const s = createWorldStore(grid);
  flatGround(s, -48, 48, -48, 48, 6, -3);
  writeVoxelWorld(worldDir, { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, s);
  const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Town', components: { voxelWorld: { world: WORLD } } });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
}, 60_000);

afterAll(async () => {
  await teardown();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe('structures through the commands', () => {
  let house = '';

  it('makes a structure: the next grid, its definition anchored, its voxels in one region file, the manifest listing it', async () => {
    // Refused before anything is applied: an opening off its wall, a structure without its world in the scene.
    const bad = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Bad', components: { voxelStructure: { ...SMALL, openings: [{ ...SMALL.openings[0], at: 40 }] } } });
    expect(bad.status).toBe(400);
    expect((bad.json['error'] as { code: string; path: string }).code).toBe('invalid_structure');
    expect((bad.json['error'] as { path: string }).path).toMatch(/^\/args\/components\/voxelStructure\/openings\/0/);
    const nowhere = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Lost', components: { voxelStructure: { ...SMALL, world: 'nowhere' } } });
    expect((nowhere.json['error'] as { code: string }).code).toBe('world_not_found');
    // A world of the project that no voxelWorld object of the scene names.
    writeVoxelWorld(join(worldDir, '..', 'other'), { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, createWorldStore(grid));
    const elsewhere = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Lost', components: { voxelStructure: { ...SMALL, world: 'other' } } });
    expect(elsewhere.status, JSON.stringify(elsewhere.json)).toBe(400);
    expect((elsewhere.json['error'] as { code: string }).code).toBe('reference_missing');
    expect(((await query('queryEntities'))['entities'] as Array<{ name?: string }>).some((e) => e.name === 'Lost')).toBe(false);
    expect(readVoxelWorldManifest(worldDir).grids).toEqual([]);

    const t0 = performance.now();
    const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'House', transform: { position: [4, 3, 6], rotation: yawQ(30) }, components: { voxelStructure: SMALL } });
    const ms = performance.now() - t0;
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    house = made.json['createdId'] as string;
    const voxels = made.json['voxels'] as Array<{ world: string; structures: Array<{ grid: number; kind: string; cells: number }>; ms: { apply: number; save: number } }>;
    expect(voxels).toHaveLength(1);
    expect(voxels[0]!.structures).toEqual([expect.objectContaining({ grid: 1, kind: 'write' })]);
    console.info(`[structures] create small house: command ${ms.toFixed(1)} ms, voxels apply ${voxels[0]!.ms.apply.toFixed(1)} ms, staged write ${voxels[0]!.ms.save.toFixed(1)} ms`);
    const stored = await structureOf(house);
    const { world: _world, ...smallDef } = SMALL;
    const anchored = anchoredDefinition(BUILDING_GENERATOR.canonical({ ...smallDef, generator: 1 }));
    expect(stored).toEqual({ world: WORLD, grid: 1, ...anchored });
    expect(BUILDING_GENERATOR.box(anchored)).toMatchObject({ minX: 0, minZ: 0 });
    const m = readVoxelWorldManifest(worldDir);
    expect(m.grids).toHaveLength(1);
    expect(m.grids[0]!.id).toBe(1);
    // One region file a region the house's box spans: its storeys in one, its foundation (rows below the ground
    // floor's, y < 0) in the one below it in this stacked world (a column world holds both in one).
    const b = BUILDING_GENERATOR.box(anchored);
    expect(b.minY).toBeLessThan(0);
    expect(m.grids[0]!.regions).toEqual(['r.0.-1.0.vxr', 'r.0.0.0.vxr']);
    const bytes = m.grids[0]!.regions.map((r) => statSync(join(worldDir, 'grid-1', r)).size);
    console.info(`[structures] small house at rest: ${bytes.join(' + ')} bytes in ${bytes.length} region files`);
    expect(existsSync(join(worldDir, 'grid-1', 'overrides.tlvo'))).toBe(false);
    expect(differences(await gridOnDisk(1), fresh(anchored))).toEqual([]);
  });

  it('regenerates a changed definition (one step with the scene edit: undo and redo give the folder back byte for byte)', async () => {
    const before = folderState();
    const t0 = performance.now();
    const r = await cmd('setComponent', { entityId: house, component: 'voxelStructure', value: { storeys: 3 } });
    const ms = performance.now() - t0;
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    console.info(`[structures] regenerate small house + storey: command ${ms.toFixed(1)} ms, staged write ${((r.json['voxels'] as Array<{ ms: { save: number } }>)[0]!.ms.save).toFixed(1)} ms`);
    const c = await structureOf(house);
    expect(c['storeys']).toBe(3);
    expect(differences(await gridOnDisk(1), fresh(definitionOf(c)))).toEqual([]);
    const after = folderState();
    expect(after).not.toEqual(before);
    const t1 = performance.now();
    const u = await lineStep('undo');
    console.info(`[structures] undo of that regenerate: ${(performance.now() - t1).toFixed(1)} ms`);
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect((await structureOf(house))['storeys']).toBe(2);
    expect(folderState()).toEqual(before);
    expect((await lineStep('redo')).status).toBe(200);
    expect((await structureOf(house))['storeys']).toBe(3);
    expect(folderState()).toEqual(after);
    // Nothing changes: refused, nothing applied.
    const same = await cmd('setComponent', { entityId: house, component: 'voxelStructure', value: { storeys: 3 } });
    expect((same.json['error'] as { code: string }).code).toBe('no_change');
    expect(folderState()).toEqual(after);
  });

  it('keeps one line across scene edits, world strokes and structure steps', async () => {
    const s0 = folderState();
    const dig = { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [-20, -2, -20], mode: 'dig', smooth: false };
    expect((await stroke(dig)).status).toBe(200);
    const s1 = folderState();
    expect((await cmd('updateEntity', { entityId: house, name: 'Big house' })).status).toBe(200);
    expect((await cmd('setComponent', { entityId: house, component: 'voxelStructure', value: { roof: { shape: 'hip', overhang: 1, axis: 'x' } } })).status).toBe(200);
    const s3 = folderState();
    for (const want of [s1, s1, s0]) {
      expect((await lineStep('undo')).status).toBe(200);
      expect(folderState()).toEqual(want);
    }
    for (const want of [s1, s1, s3]) {
      expect((await lineStep('redo')).status).toBe(200);
      expect(folderState()).toEqual(want);
    }
    expect((await structureOf(house))['roof']).toEqual({ shape: 'hip', overhang: 1, axis: 'x' });
  });

  it('keeps a hand edit on the grid as overrides, through a regenerate where it fits; misfits answered and listed again', async () => {
    // A hole through the front wall at the ground floor (the grid's own cells).
    const c = await structureOf(house);
    const wallX = 1 + 10;
    const dug = await stroke({ v: 2, grid: 1, kind: 'dig', cells: [wallX, 2, 1, wallX, 3, 1] });
    expect(dug.status, JSON.stringify(dug.json)).toBe(200);
    expect(dug.json['chunks']).toEqual([]);
    expect((dug.json['grids'] as Array<{ grid: number }>)[0]!.grid).toBe(1);
    const ovPath = join(worldDir, 'grid-1', 'overrides.tlvo');
    expect(existsSync(ovPath)).toBe(true);
    expect(decodeOverrides(grid, new Uint8Array(readFileSync(ovPath))).chunks.size).toBeGreaterThan(0);
    // A storey more: the hole stays (kept), a shelf where the new floor's slab goes is a misfit.
    const shelfY = 3 * 6;
    expect((await stroke({ v: 2, grid: 1, kind: 'set', cells: [6, shelfY, 6], voxel: { material: 3, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 } })).status).toBe(200);
    const r = await cmd('setComponent', { entityId: house, component: 'voxelStructure', value: { storeys: 4 } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const rep = (r.json['voxels'] as Array<{ structures: Array<{ kept: number; misfits: Array<{ x: number; y: number; z: number; at: number[] | null }> }> }>)[0]!.structures[0]!;
    expect(rep.kept).toBeGreaterThanOrEqual(2);
    expect(rep.misfits.map((m) => [m.x, m.y, m.z])).toContainEqual([6, shelfY, 6]);
    expect(rep.misfits[0]!.at).toHaveLength(3);
    const store = await gridOnDisk(1);
    expect(differences(store, fresh(definitionOf(await structureOf(house)))).filter((d) => d.x === wallX && d.z === 1).map((d) => [d.y, d.a])).toEqual([[2, 0], [3, 0]]);
    // Listed again from the backend's memory (never stored).
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { grids: Array<{ id: number; place?: { gridId: number }; lastRegenerate?: { misfits: unknown[] }; overrides: number }> };
    expect(info.grids[0]!.place?.gridId).toBe(1);
    expect(info.grids[0]!.lastRegenerate?.misfits.length).toBe(rep.misfits.length);
    // The hand edits the grid keeps, counted in cells (the structure mode's "hand edits kept"): the overrides file's.
    let kept = 0;
    for (const ch of decodeOverrides(grid, new Uint8Array(readFileSync(ovPath))).chunks.values()) kept += ch.value.count;
    expect(kept).toBeGreaterThanOrEqual(2);
    expect(info.grids[0]!.overrides).toBe(kept);
    void c;
  });

  it('swaps a material: material ids only', async () => {
    const before = await gridOnDisk(1);
    const r = await cmd('setComponent', { entityId: house, component: 'voxelStructure', value: { materials: { ...MAT, wall: 11 } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const rep = (r.json['voxels'] as Array<{ structures: Array<{ fields: number; materialSwaps: number[] }> }>)[0]!.structures[0]!;
    expect(rep.fields).toBe(PLANE_BIT.material);
    expect(rep.materialSwaps.length).toBeGreaterThan(0);
    for (const d of differences(before, await gridOnDisk(1))) expect((d.a & ~0xfff) >>> 0).toBe((d.b & ~0xfff) >>> 0);
  });

  let copy = '';
  it('duplicates a structure: a new grid with equal voxels and overrides, independent after', async () => {
    const value = (await query('queryEntity', { entityId: house }))['entity'] as Record<string, unknown>;
    const r = await cmd('pasteEntities', { entities: [{ id: house, components: value['components'] }], offset: [0.5, 0, 0], sceneId: 'scene-main' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    copy = r.json['createdId'] as string;
    expect((await structureOf(copy))['grid']).toBe(2);
    expect(readVoxelWorldManifest(worldDir).grids.map((g) => g.id)).toEqual([1, 2]);
    expect(differences(await gridOnDisk(1), await gridOnDisk(2))).toEqual([]);
    const ov = (id: number) => decodeOverrides(grid, new Uint8Array(readFileSync(join(worldDir, `grid-${id}`, 'overrides.tlvo'))));
    expect([...ov(2).chunks.values()].map((c) => [c.cx, c.cy, c.cz, [...c.value.values]])).toEqual([...ov(1).chunks.values()].map((c) => [c.cx, c.cy, c.cz, [...c.value.values]]));
    expect(ov(2).gridId).toBe(2);
    const g1 = folderState();
    expect((await cmd('setComponent', { entityId: copy, component: 'voxelStructure', value: { storeys: 2 } })).status).toBe(200);
    const g1after = folderState();
    for (const k of Object.keys(g1)) if (k.startsWith('grid-1/')) expect(g1after[k]).toBe(g1[k]);
  });

  it('moves and turns a structure without rewriting a voxel; refuses a tilt', async () => {
    const m = readVoxelWorldManifest(worldDir);
    const files = m.grids.flatMap((g) => g.regions.map((r) => join(worldDir, `grid-${g.id}`, r)));
    const stamps = files.map((f) => statSync(f).mtimeNs ?? statSync(f).mtimeMs);
    const moved = await cmd('setTransform', { entityId: house, transform: { position: [10, 3, -2], rotation: yawQ(45) } });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(moved.json['voxels']).toBeUndefined();
    expect(files.map((f) => statSync(f).mtimeNs ?? statSync(f).mtimeMs)).toEqual(stamps);
    expect(readVoxelWorldManifest(worldDir).revision).toBe(m.revision);
    const tilt = await cmd('setTransform', { entityId: house, transform: { rotation: [Math.sin(0.1), 0, 0, Math.cos(0.1)] } });
    expect(tilt.status).toBe(400);
    expect(JSON.stringify(tilt.json)).toMatch(/vertical axis only/);
  });

  it('deletes a structure: its files go, and its undo brings them back', async () => {
    const before = folderState();
    const d = await cmd('deleteEntity', { entityId: copy });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(readVoxelWorldManifest(worldDir).grids.map((g) => g.id)).toEqual([1]);
    expect(readdirSync(join(worldDir, 'grid-2'))).toEqual([]);
    expect((await lineStep('undo')).status).toBe(200);
    expect(await entity(copy)).toBeDefined();
    expect(folderState()).toEqual(before);
    expect((await lineStep('redo')).status).toBe(200);
    expect(readVoxelWorldManifest(worldDir).grids.map((g) => g.id)).toEqual([1]);
    // A new structure never takes the deleted one's grid while an undo can bring it back.
    const again = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Shed', components: { voxelStructure: { ...SMALL, footprint: [rect('main', 0, 0, 8, 8)], openings: [], stairs: [], storeys: 1 } } });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect((await structureOf(again.json['createdId'] as string))['grid']).toBe(3);
    expect((await cmd('deleteEntity', { entityId: again.json['createdId'] as string })).status).toBe(200);
  });

  it('refuses a command meeting grid files someone else changed; reports a listed grid file that is gone', async () => {
    const m = readVoxelWorldManifest(worldDir);
    const file = join(worldDir, 'grid-1', m.grids[0]!.regions[0]!);
    const bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([bytes[bytes.length - 1]! ^ 1])]));
    const r = await cmd('setComponent', { entityId: house, component: 'voxelStructure', value: { storeys: 2 } });
    expect(r.status).toBe(409);
    expect((r.json['error'] as { code: string }).code).toBe('world_changed');
    // The scene edit was taken back with it.
    expect((await structureOf(house))['storeys']).toBe(4);
    rmSync(file);
    const info = (await (await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).json()) as { grids: Array<{ files: Array<{ etag: string | null }> }> };
    expect(info.grids[0]!.files[0]!.etag).toBeNull();
    const damaged = await cmd('setComponent', { entityId: house, component: 'voxelStructure', value: { storeys: 2 } });
    expect((damaged.json['error'] as { code: string }).code).toBe('region_damaged');
    writeFileSync(file, bytes);
    // The backend reads the world again at its next read (the file is someone else's change again).
    expect((await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: auth })).status).toBe(200);
  });

  it('regenerates every structure an older generator wrote as one step (regenerate-all)', async () => {
    const none = await post({ op: 'regenerateStructures', projectId: PROJECT, expectedRevision: await revision(), requestId: rid(), args: {} });
    expect((none.json['error'] as { code: string }).code).toBe('no_change');
    const w = worlds();
    const was = w.generator;
    // A generator one version on (the same voxels): every structure is now an older one's.
    const next: StructureGenerator<StructureDefinition> = { ...BUILDING_GENERATOR, version: 2, canonical: (input) => BUILDING_GENERATOR.canonical({ ...(input as Record<string, unknown>), generator: 1 }) };
    (w as unknown as { generator: StructureGenerator<StructureDefinition> }).generator = { ...next, canonical: (input) => ({ ...next.canonical(input), generator: (input as { generator: number }).generator }) };
    try {
      const before = folderState();
      const all = await post({ op: 'regenerateStructures', projectId: PROJECT, expectedRevision: await revision(), requestId: rid(), args: {} });
      expect(all.status, JSON.stringify(all.json)).toBe(200);
      expect((await structureOf(house))['generator']).toBe(2);
      expect((await lineStep('undo')).status).toBe(200);
      expect((await structureOf(house))['generator']).toBe(1);
      expect(folderState()).toEqual(before);
    } finally {
      (w as unknown as { generator: StructureGenerator<StructureDefinition> }).generator = was;
    }
  });

  it('sends the same ops through MCP tl_command; tl_inspect shows the structure', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ client: new BackendClient({ authoringOrigin: base(), token: TOKEN }), projectId: PROJECT, clientId: 'structures-test' });
    await server.connect(st);
    const client = new Client({ name: 'structures-test', version: '1' });
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
    const r = await call('tl_command', { op: 'setComponent', expectedRevision: await revision(), args: { entityId: house, component: 'voxelStructure', value: { storeys: 3 } } });
    expect(r['ok'], JSON.stringify(r)).toBe(true);
    expect((r['voxels'] as unknown[]).length).toBe(1);
    const seen = await call('tl_inspect', { target: 'entity', entityId: house });
    expect(JSON.stringify(seen)).toContain('"voxelStructure"');
    await client.close();
  });
});

describe('the far field after structure commands', () => {
  const farUrl = (): string => `${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}/far`;
  /** The far info once the cache is current (a read builds what commands left first; a whole build is waited for). */
  const farInfo = async (): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 600; i++) {
      const r = await fetch(farUrl(), { headers: auth });
      if (r.status === 200) return (await r.json()) as Record<string, unknown>;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error('the far cache never became current');
  };
  /** Every far cache file by path, with its hash (the store of rebuilt contents aside: it holds what was ever built). */
  const farState = (): Record<string, string> => {
    const dir = farCacheDir(backend._test.service.projectDir(PROJECT)!, WORLD);
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== FAR_REBUILT_FOLDER) walk(p);
        } else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    };
    walk(dir);
    return out;
  };

  it('answers each command before its far rebuild, builds a drag of moves once, and ends equal to a whole build after undo and redo', async () => {
    await farInfo();
    const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Far house', transform: { position: [-20, 3, 14], rotation: yawQ(30) }, components: { voxelStructure: SMALL } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = made.json['createdId'] as string;
    // Answered with its chunks gathered, not built.
    const far = made.json['far'] as Array<{ world: string; far: { queued?: number } }>;
    expect(far[0]?.far.queued).toBeGreaterThan(0);
    const first = (await farInfo())['follow'] as { commands: number; chunks: number; result: { nodes?: number } };
    // A structure made is its stroke and its place: one rebuild.
    expect(first.commands).toBeGreaterThanOrEqual(1);
    expect(first.result.nodes).toBeGreaterThan(0);
    // Ten moves as a drag sends them: each answered with the far changes gathered, one rebuild of where it ends.
    for (let i = 1; i <= 10; i++) {
      const m = await cmd('setTransform', { entityId: id, transform: { position: [-20 + i * 1.5, 3, 14], rotation: yawQ(30 + i * 3) } });
      expect(m.status, JSON.stringify(m.json)).toBe(200);
      expect((m.json['far'] as Array<{ far: { queued?: number } }>)[0]?.far.queued).toBeGreaterThan(0);
    }
    // Gathered, not one rebuild a move (ten in one where the moves come under FAR_FOLLOW_SETTLE_MS apart: vitest
    // voxel-far-follow.test.ts holds that to the count; here a loaded host may split them).
    const drag = (await farInfo())['follow'] as { commands: number; result: { nodes?: number } };
    expect(drag.commands).toBeGreaterThan(1);
    expect(drag.result.nodes).toBeGreaterThan(0);
    // Undo the last move and redo it, then undo it again: the far field follows each.
    expect((await lineStep('undo')).status).toBe(200);
    expect((await lineStep('redo')).status).toBe(200);
    expect((await lineStep('undo')).status).toBe(200);
    await farInfo();
    const followed = farState();
    // The same cache built whole from the world and the structures where they stand now.
    rmSync(farCacheDir(backend._test.service.projectDir(PROJECT)!, WORLD), { recursive: true, force: true });
    await farInfo();
    const whole = farState();
    expect(whole).toEqual(followed);
  }, 120_000);
});
