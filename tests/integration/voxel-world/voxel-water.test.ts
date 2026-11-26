/**
 * Water bodies through the commands, against a real backend over HTTP with
 * a project and its voxel world on disk (a pit dug in flat ground): a body
 * made fills the pit to its level (one step with the scene edit, undo and
 * redo exact); a bank dug back inside its reach is followed in the same
 * stroke, locally, the water's cells feeding the liquid part alone, one
 * undo taking back the dig and the water together; a structure built in the
 * water is written first and the water after it, round its walls and in at
 * its door; a level changed fills again; a trench past the reach drains the
 * body and flags the leak (nothing written past the bound, the world's
 * route reporting where), and closing it fills it again and clears the
 * flag; a deleted body takes its water with it (undo brings it back); and
 * an export ships the liquid voxels without the record.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createTestBackend, testTempBase } from '@thirdlight/backend/testing';
import type { Backend } from '@thirdlight/backend/services';
import { chunkGrid, createWorldStore, DERIVED_PART, SHAPE_FULL, valueMaterial, valueOf, valueRole, valueShape, VOXEL_ROLE, type VoxelRecord, type VoxelStoreCandidate } from '@thirdlight/voxel';
import { hexToBytes } from '@thirdlight/shared';
import { RegionWorld, readVoxelWorldManifest, writeVoxelWorld } from '@thirdlight/workspace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flatGround } from '../../../tools/voxel-bench/scenes';
import { commandEnvelope } from '../../support/commands';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const ORIGIN = 'http://127.0.0.1:8521';
const TOKEN = 'water-token';
const ADMIN = 'water-admin-token';
const PROJECT = 'lakes';
const WORLD = 'vale';
const WORLD_ID = '1f2e3d4c5b6a79889786a5b4c3d2e1f0';
const WATER = 5;
const ROCK = 1;
const grid = chunkGrid(32);
/** The pit: cells x, z in [-20, 20), y in [-6, 0) dug out of ground 12 cells deep; its floor is row -7. */
const PIT = 20;
/** The body: its seed in the pit, its surface at -1 m (rows -6 … -3 full), its reach 15 m (30 cells: the pit's corners are inside). */
const BODY = { world: WORLD, level: -1, material: WATER, reach: 15 };
const SEED = [0.25, -1.75, 0.25];
const MAT = { wall: 10, floor: 14, roof: 13, foundation: 6, stair: 14 };
const HOUSE = { world: WORLD, footprint: [{ id: 'main', points: [[0, 0], [16, 0], [16, 12], [0, 12]] }], storeys: 1, storeyHeight: 6, foundationDepth: 2, roof: { shape: 'flat', overhang: 0, axis: 'x' }, materials: MAT, openings: [{ id: 'door', polygon: 'main', edge: 0, storey: 0, at: 6, width: 2, height: 4, sill: 0 }], stairs: [] };

let backend: Backend;
let teardown: () => Promise<void>;
let root = '';
let worldDir = '';
let exportRoot = '';

const base = (): string => `http://127.0.0.1:${backend.portAuthoring}`;
const rid = (): string => `req-${randomBytes(16).toString('hex')}`;
const post = async (body: Record<string, unknown>, token = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${base()}/api/v1/projects/${PROJECT}/commands`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const query = async (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => (await post({ op, projectId: PROJECT, args })).json;
const revision = async (): Promise<number> => (await query('queryProject'))['revision'] as number;
const cmd = async (op: string, args: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => post(commandEnvelope(op, PROJECT, await revision(), args, null));
const stroke = async (command: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => post({ op: 'editVoxels', projectId: PROJECT, requestId: rid(), args: { world: WORLD, command } });
const lineStep = async (op: 'undo' | 'redo'): Promise<{ status: number; json: Record<string, unknown> }> => post(commandEnvelope(op, PROJECT, await revision(), {}, null));
const dig = (min: number[], max: number[]): Promise<{ status: number; json: Record<string, unknown> }> => stroke({ v: 2, grid: 0, kind: 'fill', min, max, mode: 'dig' });
const add = (min: number[], max: number[]): Promise<{ status: number; json: Record<string, unknown> }> => stroke({ v: 2, grid: 0, kind: 'fill', min, max, mode: 'add', voxel: { material: ROCK, role: VOXEL_ROLE.terrain, wetness: 0 } });
const info = async (): Promise<{ bodies: Array<{ entityId: string; status: string; cells: number; leaks: Array<{ at: number[]; kind: string }> }> }> => {
  const r = await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return (await r.json()) as never;
};

interface WaterAnswer {
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  parts: number;
  chunks: number[][];
  bodies: Array<{ entityId: string; status: string; cells: number; via: string; why?: string; written: number; leaks: Array<{ at: number[]; kind: string; cells: number }> }>;
  ms: number;
}

/** Every file of the world folder (but the manifest, whose revision moves) by path and hash, and the manifest's lists. */
function folderState(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== 'world.json') out[relative(worldDir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(worldDir);
  const m = readVoxelWorldManifest(worldDir);
  out['world.json:lists'] = JSON.stringify({ regions: m.regions, grids: m.grids });
  return out;
}

/** The world grid as its files on disk hold it. */
async function onDisk(): Promise<VoxelStoreCandidate> {
  const m = readVoxelWorldManifest(worldDir);
  const { world } = await RegionWorld.open(join(worldDir, 'grid-0'), { grid, worldId: hexToBytes(WORLD_ID), layout: 'stacked', footprint: 512, gridId: 0 }, m.regions);
  return world.store;
}

/** The liquid cells of the world on disk round the pit: "x,y,z" → its value. */
async function liquid(): Promise<Map<string, number>> {
  const s = await onDisk();
  const r: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const out = new Map<string, number>();
  for (let x = -48; x < 48; x++) for (let z = -48; z < 48; z++) for (let y = -12; y < 2; y++) {
    const v = valueOf(s.voxelAt(x, y, z, r));
    if (valueRole(v) === VOXEL_ROLE.liquid) out.set(`${x},${y},${z}`, v);
  }
  return out;
}

const rows = (cells: Map<string, number>): number[] => [...new Set([...cells.keys()].map((k) => Number(k.split(',')[1])))].sort((a, b) => a - b);

beforeAll(async () => {
  root = mkdtempSync(join(testTempBase(), 'tl-voxel-water-'));
  exportRoot = join(root, 'exports');
  const tb = await createTestBackend({ dataRoot: join(root, 'data'), authoringOrigin: ORIGIN, previewOrigin: 'http://127.0.0.1:8522', authoringOrigins: [ORIGIN], tokens: [{ token: TOKEN, scope: `authoring:${PROJECT}` }, { token: ADMIN, scope: 'admin' }], exportRoot, engineRoot: REPO });
  backend = tb.backend;
  teardown = tb.teardown;
  expect(backend._test.service.createProject(PROJECT, 'Lakes').ok).toBe(true);
  worldDir = join(backend._test.service.projectDir(PROJECT)!, 'voxels', WORLD);
  const s = createWorldStore(grid);
  flatGround(s, -48, 48, -48, 48, 12, 0);
  const air: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  for (let x = -PIT; x < PIT; x++) for (let z = -PIT; z < PIT; z++) for (let y = -6; y < 0; y++) s.setVoxel(x, y, z, air);
  writeVoxelWorld(worldDir, { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, s);
  const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Vale', components: { voxelWorld: { world: WORLD } } });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
}, 60_000);

afterAll(async () => {
  await teardown();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe('water bodies through the commands', () => {
  let lake = '';

  it('makes a body: the pit filled to its level as one step with the scene edit, undo and redo exact', async () => {
    const before = folderState();
    const t0 = performance.now();
    const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Lake', transform: { position: SEED }, components: { waterBody: BODY } });
    const ms = performance.now() - t0;
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    lake = made.json['createdId'] as string;
    const voxels = made.json['voxels'] as Array<{ op: string; parts: number; water: WaterAnswer }>;
    expect(voxels.map((v) => v.op)).toEqual(['writeWater']);
    expect(voxels[0]!.parts).toBe(DERIVED_PART.liquid);
    expect(voxels[0]!.water.bodies).toEqual([expect.objectContaining({ entityId: lake, status: 'filled', cells: 40 * 40 * 4, via: 'whole' })]);
    console.info(`[water] create a body over a 20 m pit: command ${ms.toFixed(1)} ms, water ${voxels[0]!.water.ms.toFixed(1)} ms`);
    const cells = await liquid();
    expect(cells.size).toBe(6400);
    expect(rows(cells)).toEqual([-6, -5, -4, -3]);
    expect([...cells.values()].every((v) => valueMaterial(v) === WATER && valueShape(v) === SHAPE_FULL)).toBe(true);
    const after = folderState();
    expect((await lineStep('undo')).status).toBe(200);
    expect(folderState()).toEqual(before);
    expect((await query('queryEntity', { entityId: lake }))['entity']).toBeUndefined();
    expect((await lineStep('redo')).status).toBe(200);
    expect(folderState()).toEqual(after);
    expect((await info()).bodies).toEqual([expect.objectContaining({ entityId: lake, status: 'filled', cells: 6400 })]);
  });

  it('a flood stroke beside a body: a drain inside its reach is written again by the body in the same stroke; a flood of fog follows no later edit, the lake does', async () => {
    const before = folderState();
    // Air to the lake's level from a seed in it: the drain empties it, and the body, following the stroke, fills it again.
    const drained = await stroke({ v: 3, grid: 0, kind: 'flood', seed: [0, -4, 0], level: -2, value: { material: 0, role: 0 }, reach: 30 });
    expect(drained.status, JSON.stringify(drained.json)).toBe(200);
    expect((drained.json['water'] as WaterAnswer).bodies).toEqual([expect.objectContaining({ entityId: lake, status: 'filled', via: 'whole', cells: 6400, written: 6400 })]);
    expect((await liquid()).size).toBe(6400);
    expect((await lineStep('undo')).status).toBe(200);
    expect(folderState()).toEqual(before);
    // Fog over the water to the ground's top: two rows of the pit, the gas part alone; the lake under it is not written.
    const fog = await stroke({ v: 3, grid: 0, kind: 'flood', seed: [0, -2, 0], level: 0, value: { material: 9, role: VOXEL_ROLE.gas }, reach: 30 });
    expect(fog.status, JSON.stringify(fog.json)).toBe(200);
    expect(fog.json).toMatchObject({ cells: 40 * 40 * 2, parts: DERIVED_PART.gas });
    expect((fog.json['water'] as WaterAnswer).bodies).toEqual([expect.objectContaining({ entityId: lake, status: 'filled', written: 0 })]);
    const gasCells = async (): Promise<Set<string>> => {
      const st = await onDisk();
      const r: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
      const out = new Set<string>();
      for (let x = -48; x < 48; x++) for (let z = -48; z < 48; z++) for (let y = -12; y < 2; y++) if (valueRole(valueOf(st.voxelAt(x, y, z, r))) === VOXEL_ROLE.gas) out.add(`${x},${y},${z}`);
      return out;
    };
    const fogged = await gasCells();
    expect(fogged.size).toBe(3200);
    // The east bank dug back: the lake's shore follows into the dug cells; the fog stays where it was flooded.
    expect((await dig([PIT, -6, -4], [PIT + 3, -1, 3])).status).toBe(200);
    expect((await liquid()).has(`${PIT + 3},-3,0`)).toBe(true);
    expect(await gasCells()).toEqual(fogged);
    expect((await lineStep('undo')).status).toBe(200);
    expect((await lineStep('undo')).status).toBe(200);
    expect(folderState()).toEqual(before);
  });

  it('follows a bank dug back in the same stroke, locally: the shore moves, the water feeds the liquid part alone, one undo takes both back', async () => {
    const before = folderState();
    const t0 = performance.now();
    // The east bank, 2 m back and 4 m wide, from the pit's floor to the ground's top.
    const r = await dig([PIT, -6, -4], [PIT + 3, -1, 3]);
    const ms = performance.now() - t0;
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const water = r.json['water'] as WaterAnswer;
    expect(water.bodies).toEqual([expect.objectContaining({ entityId: lake, status: 'filled', via: 'local', cells: 6400 + 4 * 8 * 4, written: 4 * 8 * 4 })]);
    expect(water.parts).toBe(DERIVED_PART.liquid);
    expect(r.json['parts'] as number & DERIVED_PART.mesh).toBeTruthy();
    expect(water.box).toEqual({ minX: PIT, minY: -6, minZ: -4, maxX: PIT + 3, maxY: -3, maxZ: 3 });
    console.info(`[water] dig a bank back inside the reach: stroke ${ms.toFixed(1)} ms (apply ${(r.json['ms'] as { apply: number }).apply.toFixed(1)}, water ${water.ms.toFixed(1)}), ${water.bodies[0]!.written} cells written`);
    const cells = await liquid();
    expect(cells.has(`${PIT + 3},-3,0`)).toBe(true);
    expect(cells.has(`${PIT + 3},-2,0`)).toBe(false);
    const dug = folderState();
    // One undo: the bank and the water back as they were; one redo: both again.
    expect((await lineStep('undo')).status).toBe(200);
    expect(folderState()).toEqual(before);
    const redo = await lineStep('redo');
    expect(redo.status).toBe(200);
    expect((redo.json['voxels'] as { water?: WaterAnswer }).water?.parts).toBe(DERIVED_PART.liquid);
    expect(folderState()).toEqual(dug);
  });

  it('writes a structure built in the water first and the water after it: round its walls and in at its door', async () => {
    const before = folderState();
    const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Boathouse', transform: { position: [-8, -3, -8] }, components: { voxelStructure: HOUSE } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const voxels = made.json['voxels'] as Array<{ op: string; water?: WaterAnswer }>;
    expect(voxels.map((v) => v.op)).toEqual(['writeStructures', 'writeWater']);
    expect(voxels[1]!.water!.bodies[0]!.status).toBe('filled');
    const cells = await liquid();
    // A wall cell of the house (its south wall, grid row z = 0, at world z = -16) holds no water; its door and the room inside hold it.
    const wall = `-14,-4,-16`;
    expect(cells.has('-10,-4,-16')).toBe(true);
    expect(cells.has(wall)).toBe(false);
    expect(cells.has('-10,-4,-12')).toBe(true);
    expect(cells.has('-20,-4,-16')).toBe(true);
    expect((await lineStep('undo')).status).toBe(200);
    expect(folderState()).toEqual(before);
    expect((await lineStep('redo')).status).toBe(200);
  });

  it('fills again to a changed level', async () => {
    const r = await cmd('setComponent', { entityId: lake, component: 'waterBody', value: { ...BODY, level: -0.75 } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const cells = await liquid();
    expect(rows(cells)).toEqual([-6, -5, -4, -3, -2]);
    const top = [...cells].filter(([k]) => k.split(',')[1] === '-2').map(([, v]) => valueShape(v));
    expect(new Set(top)).toEqual(new Set([Math.round(0.5 * SHAPE_FULL)]));
    expect((await cmd('setComponent', { entityId: lake, component: 'waterBody', value: BODY })).status).toBe(200);
  });

  it('flags a breach at the reach and spills nothing; closing it fills the body again and clears the flag', async () => {
    const before = await liquid();
    // A trench from the dug bank out past the reach (30 cells from the seed).
    const r = await dig([PIT + 4, -6, 0], [PIT + 16, -4, 0]);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const water = r.json['water'] as WaterAnswer;
    expect(water.bodies[0]).toMatchObject({ entityId: lake, status: 'breached', via: 'whole', why: 'breach', cells: 0 });
    expect(water.bodies[0]!.leaks.length).toBeGreaterThan(0);
    expect(water.bodies[0]!.leaks.every((l) => l.kind === 'reach' && l.at[0] > 14)).toBe(true);
    expect((await liquid()).size).toBe(0);
    const flagged = (await info()).bodies.find((b) => b.entityId === lake)!;
    expect(flagged.status).toBe('breached');
    expect(flagged.leaks[0]!.at[0]).toBeGreaterThan(14);
    // Closed where the trench leaves the bank: the body is whole again, as before the trench.
    const shut = await add([PIT + 4, -6, 0], [PIT + 4, -4, 0]);
    expect(shut.status, JSON.stringify(shut.json)).toBe(200);
    expect((shut.json['water'] as WaterAnswer).bodies[0]).toMatchObject({ status: 'filled', leaks: [] });
    expect([...(await liquid()).keys()].sort()).toEqual([...before.keys()].sort());
    expect((await info()).bodies.find((b) => b.entityId === lake)!.status).toBe('filled');
  });

  it('takes its water with it when deleted; undo brings it back', async () => {
    const before = folderState();
    const r = await cmd('deleteEntity', { entityId: lake });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await liquid()).size).toBe(0);
    expect((await lineStep('undo')).status).toBe(200);
    expect(folderState()).toEqual(before);
  });

  it('exports the liquid voxels, never the record', async () => {
    const r = await fetch(`${base()}/api/v1/admin/projects/${PROJECT}/export`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
    const json = (await r.json()) as { outputDir?: string };
    expect(r.status, JSON.stringify(json)).toBe(200);
    const out = join(exportRoot, String(json.outputDir));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const all = files(out);
    // The catalog and the content files (the engine's own code names the component, as it names every one).
    const data = [join(out, 'manifest.json'), ...files(join(out, 'content'))];
    expect(data.filter((f) => readFileSync(f).includes('"waterBody"')).map((f) => relative(out, f)), 'no water body record in the export').toEqual([]);
    // Every region file of the world (holding the lake) ships byte for byte.
    const m = readVoxelWorldManifest(worldDir);
    const shipped = new Set(all.map((f) => f.split('/').pop()));
    for (const name of m.regions) expect(shipped.has(createHash('sha256').update(readFileSync(join(worldDir, 'grid-0', name))).digest('hex')), name).toBe(true);
    expect((await liquid()).size, "the lake is in the files that shipped").toBeGreaterThan(6000);
    rmSync(out, { recursive: true, force: true });
  });
});

