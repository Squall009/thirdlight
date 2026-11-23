/**
 * Splines that write voxels, through the commands, against a real backend
 * over HTTP with a project and its voxel world on disk (flat ground, a hill
 * and a lake in a pit): a road made writes its course and its record of
 * what it replaced (TLVO, beside the region files); a point moved gives the
 * ground back cell for cell where the road no longer runs and writes the
 * new course, equal to the same road written fresh on the ground; one undo
 * and one redo are exact (every file of the world folder); a hand dig on
 * the road is kept by the fit rule when the road widens; a cell painted
 * since is left alone and reported when the road moves off it; a river
 * into the lake joins it at its level and the body follows in the same
 * step, and keeps the river when its level changes; a road through the
 * lake's bank makes the body follow; deleting the spline puts everything
 * back; an export ships the voxels without the section or the record.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createTestBackend, testTempBase } from '@thirdlight/backend/testing';
import type { Backend } from '@thirdlight/backend/services';
import { sceneVoxelSplines, splineVoxelDefinition } from '@thirdlight/project-model';
import { chunkGrid, createWorldStore, emptyWorldRecord, rewriteInWorld, SPLINE_WRITER, valueMaterial, valueOf, valueRole, VOXEL_ROLE, type VoxelRecord, type VoxelStoreCandidate } from '@thirdlight/voxel';
import { hexToBytes } from '@thirdlight/shared';
import { RegionWorld, readVoxelWorldManifest, writeVoxelWorld } from '@thirdlight/workspace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flatGround } from '../../../tools/voxel-bench/scenes';
import { commandEnvelope } from '../../support/commands';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const ORIGIN = 'http://127.0.0.1:8521';
const TOKEN = 'splines-token';
const ADMIN = 'splines-admin-token';
const PROJECT = 'roads';
const WORLD = 'dale';
const WORLD_ID = '2a3b4c5d6e7f80918273645546372819';
const ROCK = 1;
const ROAD = 7;
const PAINT = 9;
const WATER = 5;
const grid = chunkGrid(32);
const air: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

/** The ground: flat at 0 m over x [-64, 64) m, z [-32, 32) m, a hill rising to 4 m over x 20-40 m, a pit dug 3 m deep for the lake. */
function ground(): VoxelStoreCandidate {
  const s = createWorldStore(grid);
  flatGround(s as never, -128, 128, -64, 64, 12, 0);
  const rock: VoxelRecord = { material: ROCK, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 };
  for (let x = 40; x < 80; x++) for (let z = -64; z < 64; z++) for (let y = 0; y < Math.round(8 * Math.sin(((x - 40) / 40) * Math.PI)); y++) s.setVoxel(x, y, z, rock);
  for (let x = -80; x < -40; x++) for (let z = -20; z < 20; z++) for (let y = -6; y < 0; y++) s.setVoxel(x, y, z, air);
  return s;
}

const ROAD_VOXELS = { kind: 'road', material: ROAD, bed: { material: ROCK, depth: 1 }, shoulder: { width: 2, slope: 1 }, clear: 3 };
const roadPoints = (mid: number[]): Array<{ at: number[] }> => [{ at: [-10, 0, -10] }, { at: mid }, { at: [34, 0, 10] }];
/** The lake in the pit: seed at x -30 m, level -1 m, reach 15 m. */
const LAKE = { world: WORLD, level: -1, material: WATER, reach: 15 };

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
const info = async (): Promise<{ splines: Array<{ entityId: string; written: number; recordBytes: number; lastWrite?: Record<string, unknown> }>; bodies: Array<{ entityId: string; status: string; cells: number }> }> => {
  const r = await fetch(`${base()}/api/v1/projects/${PROJECT}/voxels/${WORLD}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return (await r.json()) as never;
};

interface SplineAnswer {
  entityId: string;
  cells: number;
  putBack: number;
  written: number;
  recordBytes: number;
  kept: number;
  absorbed: number;
  leftAlone: Array<{ x: number; y: number; z: number; at: number[] }>;
  misfits: Array<{ x: number; y: number; z: number }>;
}
type Voxels = Array<{ op: string; splines?: SplineAnswer[]; water?: { bodies: Array<{ entityId: string; cells: number; via: string }> }; ms: { apply: number; save: number } }>;

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

async function onDisk(): Promise<VoxelStoreCandidate> {
  const m = readVoxelWorldManifest(worldDir);
  const { world } = await RegionWorld.open(join(worldDir, 'grid-0'), { grid, worldId: hexToBytes(WORLD_ID), layout: 'stacked', footprint: 512, gridId: 0 }, m.regions);
  return world.store;
}

const r0: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
const at = (s: VoxelStoreCandidate, x: number, y: number, z: number): number => valueOf(s.voxelAt(x, y, z, r0));

/** Cells where two stores differ over the test's ground (x, z cells within it, y -16 … 16). */
function differences(a: VoxelStoreCandidate, b: VoxelStoreCandidate): string[] {
  const out: string[] = [];
  for (let x = -128; x < 128; x++) for (let z = -64; z < 64; z++) for (let y = -16; y < 16; y++) if (at(a, x, y, z) !== at(b, x, y, z)) out.push(`${x},${y},${z}: ${at(a, x, y, z)} / ${at(b, x, y, z)}`);
  return out;
}

/** The ground with splines `ids` written fresh in order, by the package's writer (what the backend must hold). */
async function fresh(...ids: string[]): Promise<VoxelStoreCandidate> {
  const s = ground();
  const entities = [{ id: 'world', components: { voxelWorld: { world: WORLD } } }];
  for (const id of ids) entities.push((await query('queryEntity', { entityId: id }))['entity'] as never);
  for (const sp of sceneVoxelSplines([{ entities }])) rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(grid), splineVoxelDefinition(sp, []));
  return s;
}

const recordPath = (id: string): string => join(worldDir, 'structures', `${id}.tlvo`);

beforeAll(async () => {
  root = mkdtempSync(join(testTempBase(), 'tl-voxel-splines-'));
  exportRoot = join(root, 'exports');
  const tb = await createTestBackend({ dataRoot: join(root, 'data'), authoringOrigin: ORIGIN, previewOrigin: 'http://127.0.0.1:8522', authoringOrigins: [ORIGIN], tokens: [{ token: TOKEN, scope: `authoring:${PROJECT}` }, { token: ADMIN, scope: 'admin' }], exportRoot, engineRoot: REPO });
  backend = tb.backend;
  teardown = tb.teardown;
  expect(backend._test.service.createProject(PROJECT, 'Roads').ok).toBe(true);
  worldDir = join(backend._test.service.projectDir(PROJECT)!, 'voxels', WORLD);
  writeVoxelWorld(worldDir, { worldId: WORLD_ID, edge: 32, layout: 'stacked', footprint: 512 }, ground() as never);
  const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Dale', components: { voxelWorld: { world: WORLD } } });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
}, 60_000);

afterAll(async () => {
  await teardown();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe('splines that write voxels, through the commands', () => {
  let road = '';
  let river = '';
  let lake = '';

  it('makes a road: its course written and its record beside the region files, equal to the writer fresh', async () => {
    const t0 = performance.now();
    const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Road', transform: { position: [0, 0, 0] }, components: { spline: { points: roadPoints([12, 0, 0]), width: 6, voxels: ROAD_VOXELS } } });
    const ms = performance.now() - t0;
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    road = made.json['createdId'] as string;
    const voxels = made.json['voxels'] as Voxels;
    expect(voxels.map((v) => v.op)).toEqual(['writeSplines']);
    const rep = voxels[0]!.splines![0]!;
    expect(rep).toMatchObject({ entityId: road, putBack: 0, leftAlone: [], misfits: [] });
    expect(rep.written).toBeGreaterThan(1000);
    // The record: 20 bytes of header and checksum, 10 a chunk, 10 a cell.
    expect(statSync(recordPath(road)).size).toBe(rep.recordBytes);
    console.info(`[splines] make a 46 m road 6 m wide: command ${ms.toFixed(1)} ms (apply ${voxels[0]!.ms.apply.toFixed(1)}, save ${voxels[0]!.ms.save.toFixed(1)}), ${rep.cells} cells, record ${rep.recordBytes} B for ${rep.written} cells`);
    const disk = await onDisk();
    expect(differences(disk, await fresh(road))).toEqual([]);
    // The surface on its centre line, the bed under it.
    expect(valueMaterial(at(disk, 0, -1, -10))).toBe(ROAD);
    expect(valueMaterial(at(disk, 0, -2, -10))).toBe(ROCK);
    expect((await info()).splines).toEqual([expect.objectContaining({ entityId: road, written: rep.written, recordBytes: rep.recordBytes })]);
  });

  it('moves a point: the ground back where the road left, the new course written, one undo and one redo exact', async () => {
    const before = folderState();
    const t0 = performance.now();
    const r = await cmd('setComponent', { entityId: road, component: 'spline', value: { points: roadPoints([12, 0, -14]), width: 6, voxels: ROAD_VOXELS } });
    const ms = performance.now() - t0;
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const rep = (r.json['voxels'] as Voxels)[0]!.splines![0]!;
    expect(rep.putBack).toBeGreaterThan(100);
    console.info(`[splines] move the middle point 14 m: command ${ms.toFixed(1)} ms, ${rep.cells} cells changed, ${rep.putBack} put back, record ${rep.recordBytes} B`);
    const disk = await onDisk();
    expect(differences(disk, await fresh(road))).toEqual([]);
    // Where the old course ran (x 12 m, z 0 m) the ground is back; the new one runs at z -14 m.
    expect(valueMaterial(at(disk, 24, -1, 0))).not.toBe(ROAD);
    expect(valueMaterial(at(disk, 24, -1, -28))).toBe(ROAD);
    const after = folderState();
    expect((await lineStep('undo')).status).toBe(200);
    expect(folderState()).toEqual(before);
    expect((await lineStep('redo')).status).toBe(200);
    expect(folderState()).toEqual(after);
  });

  it('keeps a hand dig on the road by the fit rule when the road widens', async () => {
    const dug = await stroke({ v: 2, grid: 0, kind: 'fill', min: [-18, -1, -20], max: [-18, -1, -20], mode: 'dig' });
    expect(dug.status, JSON.stringify(dug.json)).toBe(200);
    const r = await cmd('setComponent', { entityId: road, component: 'spline', value: { points: roadPoints([12, 0, -14]), width: 7, voxels: ROAD_VOXELS } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const rep = (r.json['voxels'] as Voxels)[0]!.splines![0]!;
    expect(rep.kept).toBe(1);
    expect(rep.misfits).toEqual([]);
    expect(at(await onDisk(), -18, -1, -20)).toBe(0);
  });

  it('leaves a cell painted since alone, and reports it, when the road moves off it', async () => {
    const painted = await stroke({ v: 2, grid: 0, kind: 'fill', min: [-14, -1, -20], max: [-14, -1, -20], mode: 'paint', voxel: { material: PAINT, role: VOXEL_ROLE.terrain, wetness: 0 } });
    expect(painted.status, JSON.stringify(painted.json)).toBe(200);
    const r = await cmd('setComponent', { entityId: road, component: 'spline', value: { points: [{ at: [-10, 0, 10] }, { at: [12, 0, 14] }, { at: [34, 0, 10] }], width: 6, voxels: ROAD_VOXELS } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const rep = (r.json['voxels'] as Voxels)[0]!.splines![0]!;
    expect(rep.leftAlone).toEqual(expect.arrayContaining([expect.objectContaining({ x: -14, y: -1, z: -20, at: [-6.75, -0.25, -9.75] }), expect.objectContaining({ x: -18, y: -1, z: -20 })]));
    const disk = await onDisk();
    expect(valueMaterial(at(disk, -14, -1, -20))).toBe(PAINT);
    expect(at(disk, -18, -1, -20)).toBe(0);
    // The road's other old cells are ground again.
    expect(valueMaterial(at(disk, -10, -1, -20))).not.toBe(ROAD);
    expect((await info()).splines[0]!.lastWrite).toMatchObject({ entityId: road });
  });

  it('runs a river into the lake: it joins the lake at its level, the body follows in the same step and keeps it when its level changes', async () => {
    const pond = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Lake', transform: { position: [-30, -1.75, 0.25] }, components: { waterBody: LAKE } });
    expect(pond.status, JSON.stringify(pond.json)).toBe(200);
    lake = pond.json['createdId'] as string;
    const held = (await info()).bodies.find((b) => b.entityId === lake)!.cells;
    const t0 = performance.now();
    const made = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'River', transform: { position: [0, 0, 0] }, components: { spline: { points: [{ at: [-4, -0.25, 4] }, { at: [-26, -0.75, 4] }], width: 3, voxels: { kind: 'river', material: WATER, bed: { material: ROCK, depth: 1.5 } } } } });
    const ms = performance.now() - t0;
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    river = made.json['createdId'] as string;
    const voxels = made.json['voxels'] as Voxels;
    // The river's mouth is written as the lake's liquid at its level: the lake follows it and takes it as its own, with nothing to write.
    expect(voxels.map((v) => v.op)).toEqual(['writeSplines']);
    const body = (await info()).bodies.find((b) => b.entityId === lake)!;
    console.info(`[splines] a 22 m river into the lake: command ${ms.toFixed(1)} ms, river ${voxels[0]!.splines![0]!.cells} cells, lake ${held} → ${body.cells} cells`);
    expect(body).toMatchObject({ status: 'filled' });
    expect(body.cells).toBeGreaterThan(held);
    const disk = await onDisk();
    // At the river's mouth (x -24 m) under the lake's level (row -3), the lake's liquid; above it (row -2) the river's.
    expect(valueRole(at(disk, -48, -3, 8))).toBe(VOXEL_ROLE.liquid);
    expect(valueRole(at(disk, -48, -2, 8))).toBe(VOXEL_ROLE.liquid);
    // The lake made higher, then back: one step each, the river's cells over the old level kept (not cleared with the lake's).
    const up = await cmd('setComponent', { entityId: lake, component: 'waterBody', value: { ...LAKE, level: -0.75 } });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect((up.json['voxels'] as Voxels).map((v) => v.op)).toEqual(['writeSplines', 'writeWater']);
    const down = await cmd('setComponent', { entityId: lake, component: 'waterBody', value: LAKE });
    expect(down.status, JSON.stringify(down.json)).toBe(200);
    const back = await onDisk();
    for (const x of [-12, -20, -30, -44]) expect(valueRole(at(back, x, -2, 8)), `river at ${x}`).toBe(VOXEL_ROLE.liquid);
  });

  it('cuts a road through the lake\'s bank: the lake follows in the same step', async () => {
    const r = await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Ford', transform: { position: [0, 0, 0] }, components: { spline: { points: [{ at: [-30, -1.5, -13] }, { at: [-30, -1.5, -6] }], width: 4, voxels: { kind: 'road', material: ROAD, clear: 2 } } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const voxels = r.json['voxels'] as Voxels;
    expect(voxels.map((v) => v.op)).toEqual(['writeSplines', 'writeWater']);
    expect(voxels[1]!.water!.bodies.find((b) => b.entityId === lake)).toMatchObject({ status: 'filled', via: 'local' });
    // The road's clear air under the lake's level, cut into the bank, holds the lake's water now.
    const disk = await onDisk();
    expect(valueRole(at(disk, -60, -3, -22))).toBe(VOXEL_ROLE.liquid);
    const del = await cmd('deleteEntity', { entityId: r.json['createdId'] as string });
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    expect(valueRole(at(await onDisk(), -60, -3, -22))).toBe(VOXEL_ROLE.terrain);
  });

  it('puts everything back when the spline is deleted, its record gone; undo brings both back', async () => {
    const before = folderState();
    const r = await cmd('deleteEntity', { entityId: road });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(existsSync(recordPath(road))).toBe(false);
    const disk = await onDisk();
    // The painted and dug cells were left alone when it moved off them; everything else of the road is ground again.
    for (let x = 0; x < 80; x++) for (let z = 0; z < 40; z++) expect(valueMaterial(at(disk, x, -1, z)), `${x},${z}`).not.toBe(ROAD);
    expect((await lineStep('undo')).status).toBe(200);
    expect(folderState()).toEqual(before);
    expect(existsSync(recordPath(road))).toBe(true);
  });

  it('exports the voxels, never the voxels section or the record', async () => {
    const r = await fetch(`${base()}/api/v1/admin/projects/${PROJECT}/export`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
    const json = (await r.json()) as { outputDir?: string };
    expect(r.status, JSON.stringify(json)).toBe(200);
    const out = join(exportRoot, String(json.outputDir));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const all = files(out);
    const data = [join(out, 'manifest.json'), ...files(join(out, 'content'))];
    expect(data.filter((f) => readFileSync(f).includes('"voxels":{"kind"')).map((f) => relative(out, f)), 'no spline voxels section in the export').toEqual([]);
    const record = readFileSync(recordPath(road));
    const recordDigest = createHash('sha256').update(record).digest('hex');
    expect(all.some((f) => f.endsWith(recordDigest) || f.endsWith('.tlvo')), 'no record in the export').toBe(false);
    const m = readVoxelWorldManifest(worldDir);
    const shipped = new Set(all.map((f) => f.split('/').pop()));
    for (const name of m.regions) expect(shipped.has(createHash('sha256').update(readFileSync(join(worldDir, 'grid-0', name))).digest('hex')), name).toBe(true);
    void river;
    rmSync(out, { recursive: true, force: true });
  });
});
