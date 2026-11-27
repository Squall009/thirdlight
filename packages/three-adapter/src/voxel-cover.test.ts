/**
 * Ground cover on voxel worlds where it is drawn: the cover a batch brings
 * goes through the point-set cover path block layers take (the real cover
 * view: its point atlas, its rows of the culled-instance table, the same
 * expansion of a point into a copy), a column's new set replaces its old
 * one alone, a column let go frees its points at once, the tier's memory
 * entry thins every set evenly, the frame arbiter's slice bounds what a
 * frame hands over, and a world closed lets everything go.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { COVER_POINT_FLOATS, COVER_POINT_STEPS, INTERACTOR_DEFAULTS, memoryBudgetBytes, MEMORY_BUDGET_BY_TIER, VOXEL_COVER_BUDGET_BYTES_BY_TIER, VOXEL_COVER_POINT_BYTES, type CoverPointSet, type ScatterRule } from '@thirdlight/project-model';
import { FRAME_SLICE_DEFAULTS, frameArbiter, residentBytes } from '@thirdlight/shared';
import { chunkGrid, type ChunkCoverWire, type ChunkDrawBatch } from '@thirdlight/voxel';

import { INSTANCE_CULLER_KEY } from './attribute-instancing';
import type { CopyRowsSource } from './copy-rows';
import { COPY_ROW_KEY, rowsPlacement, type CopyRowDraw } from './copy-rows-draw';
import { COPY_ROW_FLOATS } from './copy-rows-rule';
import { COVER_DRAW_KEY } from './cover-gpu';
import { writeCoverPointRow } from './cover-rows';
import { CoverView } from './cover-view';
import { CullView } from './view-cull';
import type { ModelInstance } from './visual';
import { VOXEL_COVER_SOURCE, VoxelCover, type PointCoverPath } from './voxel-cover';
import type { VoxelGridRenderer } from './voxel-surface';
import { VoxelWorldDraws } from './voxel-world-draws';

const EDGE = 32;
const SIDE = 16;
const GRASS = { id: 's0', asset: { assetId: 'tuft' }, density: 4, scale: [0.8, 1.2], cover: true } as unknown as ScatterRule;
const REED = { id: 's2', asset: { assetId: 'reed' }, density: 2, spacing: 0.4, cover: true } as unknown as ScatterRule;

/** `n` points over chunk column (cx, cz), 16 m a side, sorted by threshold as a bake gives them. */
function pointSet(n: number, cx: number, cz: number, y = 4.5): CoverPointSet {
  const data = new Float32Array(n * COVER_POINT_FLOATS);
  for (let i = 0; i < n; i += 1) {
    const t = Math.floor((i * 255) / Math.max(1, n - 1));
    data.set([((i * 977) % COVER_POINT_STEPS) + ((i * 1499) % COVER_POINT_STEPS) * COVER_POINT_STEPS, y, t + ((i * 37) % 256) * 256 + ((i * 91) % 256) * 65536, 127 + 127 * 256], i * COVER_POINT_FLOATS);
  }
  return { x0: cx * SIDE, z0: cz * SIDE, w: SIDE, d: SIDE, low: y, high: y, count: n, data };
}

const set = (dressing: string, species: number, rule: ScatterRule, points: CoverPointSet): ChunkCoverWire['sets'] => [{ dressing, species, rule, points }] as unknown as ChunkCoverWire['sets'];
const wire = (cx: number, cz: number, ...sets: NonNullable<ChunkCoverWire['sets']>[]): ChunkCoverWire => ({ cx, cz, ...(sets.length > 0 ? { sets: sets.flat() } : {}) });

function view(x: number, z: number): CullView {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  cam.position.set(x, 6, z);
  cam.lookAt(x + 10, 4, z);
  cam.updateMatrixWorld();
  const v = new CullView();
  v.set(cam);
  return v;
}

function tuft(): ModelInstance {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5), new MeshStandardNodeMaterial()));
  return { glbRoot: root } as unknown as ModelInstance;
}

/** The scene's culled-instance table as a rule's rows see it: what it took and let go. */
function fakeTable(): { host: Record<string, unknown>; taken: CopyRowsSource[]; forgotten: CopyRowsSource[] } {
  const taken: CopyRowsSource[] = [];
  const forgotten: CopyRowsSource[] = [];
  const host = { adoptCopies: (src: CopyRowsSource) => (taken.push(src), true), forgetCopies: (src: CopyRowsSource) => void forgotten.push(src), copySets: { rowOf: () => ({}) }, copyBuffers: () => ({}), drawCopies: () => undefined };
  return { host, taken, forgotten };
}

/** The real cover view with a scene that has a table; `frames` runs its frames at an eye. */
function stage(): { cover: CoverView; scene: THREE.Scene; table: ReturnType<typeof fakeTable>; frames(x: number, z: number, n: number): void; templates: string[] } {
  const scene = new THREE.Scene();
  const table = fakeTable();
  scene.userData[INSTANCE_CULLER_KEY] = table.host;
  const templates: string[] = [];
  const model = tuft();
  const cover = new CoverView({ template: (assetId) => (templates.push(assetId), model), place: (r, on) => void (on ? scene.add(r) : r.removeFromParent()), tile: () => undefined, surface: () => null });
  const frames = (x: number, z: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      cover.update(view(x, z));
      // A ring's first draw offers the scene it draws in: its table takes the rule from the next frame on.
      for (const m of cover.meshes()) (m.onBeforeRender as unknown as (r: unknown, s: THREE.Scene, c: THREE.Camera) => void)(null, scene, new THREE.PerspectiveCamera());
    }
  };
  return { cover, scene, table, frames, templates };
}

/** The rows a table source holds now that are a copy of some size. */
function liveRows(src: CopyRowsSource): Float32Array[] {
  const target = new Float32Array(src.count * COPY_ROW_FLOATS);
  src.writeCopies(target, 0);
  const out: Float32Array[] = [];
  for (let i = 0; i < src.count; i++) if (target[i * COPY_ROW_FLOATS + 12] !== 0) out.push(target.slice(i * COPY_ROW_FLOATS, (i + 1) * COPY_ROW_FLOATS));
  return out;
}

afterEach(() => frameArbiter.install(FRAME_SLICE_DEFAULTS));

describe('voxel ground cover through the point-set cover path', () => {
  it('is rows of the culled-instance table, a point a row, written by the block layers\' own expansion and drawn by their row draws', () => {
    const s = stage();
    const a = pointSet(300, 0, 0);
    const b = pointSet(120, 1, 0);
    const reeds = pointSet(40, 1, 0, 4);
    s.cover.voxels.receive('town', EDGE, [wire(0, 0, set('meadow', 0, GRASS, a)), wire(1, 0, set('meadow', 0, GRASS, b), set('meadow', 2, REED, reeds))]);
    // A point source of the path a species: the path asks for the models the dressing names.
    const grassId = `${VOXEL_COVER_SOURCE}town|meadow|0`;
    const reedId = `${VOXEL_COVER_SOURCE}town|meadow|2`;
    expect(s.cover.ids().sort()).toEqual([grassId, reedId].sort());
    s.frames(-6, 8, 4);
    expect(s.templates).toEqual(expect.arrayContaining(['tuft', 'reed']));
    const g = s.cover.diagnostics().gpu!;
    expect(g.pointSets).toBe(3);
    expect(g.points).toBe(460);
    expect(g.pointsPending).toBe(0);
    // The table took both species; their rows are the points, each the copy `writeCoverPointRow` makes of it.
    expect(g.rowRules).toBe(2);
    expect(s.table.taken.length).toBe(2);
    const rows = s.table.taken.map((src) => liveRows(src));
    expect(rows.map((r) => r.length).sort((x, y) => x - y)).toEqual([40, 420]);
    const grassRows = rows.find((r) => r.length === 420)!;
    const want = new Float32Array(COPY_ROW_FLOATS);
    const has = (row: Float32Array): boolean => grassRows.some((r) => r.every((v, k) => v === row[k]));
    for (const [points, n] of [[a, 300], [b, 120]] as const) for (const i of [0, 1, n - 1]) {
      writeCoverPointRow(points, i, { ...GRASS, id: grassId }, want, 0);
      expect(has(want), `point ${i}`).toBe(true);
    }
    // In the grid's own metres: the world grid's cell 0 lies at the world's origin.
    for (const r of grassRows) expect(r[0]! >= 0 && r[0]! <= 32 && r[2]! >= 0 && r[2]! <= 16 && r[1] === 4.5).toBe(true);
    // The draws are the path's row draws: placed, bent by the interaction field and moved by the wind as any cover's.
    const meshes = s.cover.meshes();
    expect(meshes.length).toBe(2);
    for (const m of meshes) {
      expect(m.userData[COVER_DRAW_KEY]).toBe(rowsPlacement);
      expect((m.userData[COPY_ROW_KEY] as CopyRowDraw).bend).toBe(INTERACTOR_DEFAULTS.ruleBend);
      expect(m.receiveShadow).toBe(true);
    }
    expect(s.cover.diagnostics().voxels).toEqual(expect.objectContaining({ worlds: 1, species: 2, sets: 3, points: 460, share: 1, pending: 0 }));
    s.cover.dispose();
  });

  it('replaces a column\'s set alone, lets a column go at once, and a species with its last column', () => {
    const s = stage();
    const grassId = `${VOXEL_COVER_SOURCE}town|meadow|0`;
    s.cover.voxels.receive('town', EDGE, [wire(0, 0, set('meadow', 0, GRASS, pointSet(300, 0, 0))), wire(1, 0, set('meadow', 0, GRASS, pointSet(120, 1, 0)))]);
    s.frames(-6, 8, 4);
    const src = (): CopyRowsSource => s.table.taken[s.table.taken.length - 1]!;
    expect(liveRows(src()).length).toBe(420);
    // The ground of column (1, 0) changed: its set is made again, the other column's rows are not written.
    const version = src().copiesVersion;
    s.cover.voxels.receive('town', EDGE, [wire(1, 0, set('meadow', 0, GRASS, pointSet(80, 1, 0)))]);
    // Its old points stay drawn until the new set is handed over.
    expect(s.cover.diagnostics().gpu!.points).toBe(420);
    s.frames(-6, 8, 2);
    expect(s.cover.diagnostics().gpu!.points).toBe(380);
    const target = new Float32Array(src().count * COPY_ROW_FLOATS);
    const ranges = src().writeCopies(target, 0, version)!;
    let written = 0;
    for (let i = 0; i < ranges.length; i += 2) written += ranges[i + 1]! - ranges[i]!;
    // One block of 256 places held the 120 points and holds the 80.
    expect(written).toBe(256);
    expect(s.table.taken.length).toBe(1);
    // The column's chunks are no longer drawn: its points go now, not when the path forgets them.
    s.cover.voxels.receive('town', EDGE, [wire(1, 0)]);
    expect(s.cover.diagnostics().gpu!.points).toBe(300);
    expect(liveRows(src()).length).toBe(300);
    expect(s.cover.ids()).toEqual([grassId]);
    // The species' last column: the source goes, its rows are forgotten by the table.
    s.cover.voxels.receive('town', EDGE, [wire(0, 0)]);
    expect(s.cover.ids()).toEqual([]);
    expect(s.table.forgotten).toContain(s.table.taken[0]);
    expect(s.cover.voxels.stats()).toEqual(expect.objectContaining({ worlds: 0, species: 0, sets: 0, points: 0 }));
    // A species' rule that reads differently (its dressing was edited) is drawn by the new rule.
    s.cover.voxels.receive('town', EDGE, [wire(0, 0, set('meadow', 0, GRASS, pointSet(50, 0, 0)))]);
    s.frames(-6, 8, 3);
    const taken = s.table.taken.length;
    s.cover.voxels.receive('town', EDGE, [wire(0, 0, set('meadow', 0, { ...GRASS, scale: [2, 3] } as ScatterRule, pointSet(50, 0, 0)))]);
    s.frames(-6, 8, 3);
    expect(s.table.taken.length).toBe(taken + 1);
    expect(liveRows(src()).every((r) => r[8]! >= 2 && r[8]! <= 3)).toBe(true);
    s.cover.dispose();
  });

  it('lets everything go when its world closes, and with the cover view', () => {
    const s = stage();
    const resident = (): number => residentBytes.read()['voxelCover'] ?? 0;
    const base = resident();
    s.cover.voxels.receive('town', EDGE, [wire(0, 0, set('meadow', 0, GRASS, pointSet(300, 0, 0)))]);
    s.cover.voxels.receive('yard', EDGE, [wire(0, 0, set('meadow', 0, GRASS, pointSet(100, 0, 0)))]);
    s.frames(-6, 8, 4);
    expect(resident() - base).toBe(400 * VOXEL_COVER_POINT_BYTES);
    expect(s.cover.diagnostics().gpu!.points).toBe(400);
    s.cover.voxels.close('town');
    expect(s.cover.ids()).toEqual([`${VOXEL_COVER_SOURCE}yard|meadow|0`]);
    expect(resident() - base).toBe(100 * VOXEL_COVER_POINT_BYTES);
    expect(s.table.forgotten.length).toBe(1);
    // The view goes (the adapter is disposed): the other world's rows, sets and the memory reading with it.
    s.cover.dispose();
    expect(s.table.forgotten.length).toBe(2);
    expect(s.cover.voxels.stats().points).toBe(0);
    expect(resident()).toBe(base);
    expect(s.scene.children).toEqual([]);
  });

  it('keeps to the tier\'s memory entry by thinning every set evenly, and to the frame arbiter\'s slice', () => {
    // The entry is the table's, read by its id.
    expect(memoryBudgetBytes({ lighting: 'low' }, 'voxelCover')).toBe(VOXEL_COVER_BUDGET_BYTES_BY_TIER.low);
    expect(MEMORY_BUDGET_BY_TIER.low.entries.find((e) => e.id === 'voxelCover')).toEqual(expect.objectContaining({ side: 'page', bytes: 32 * 2 ** 20, from: 'VOXEL_COVER_BUDGET_BYTES_BY_TIER' }));
    const asked: string[] = [];
    const path: PointCoverPath = { setPoints: () => undefined, invalidatePoints: (id, rect) => void asked.push(`${id}:${rect === null ? 'all' : 'one'}`), dropPoints: () => undefined, remove: () => undefined };
    const cover = new VoxelCover(path);
    cover.receive('town', EDGE, [wire(0, 0, set('meadow', 0, GRASS, pointSet(800, 0, 0))), wire(1, 0, set('meadow', 0, GRASS, pointSet(800, 1, 0)))]);
    const id = `${VOXEL_COVER_SOURCE}town|meadow|0`;
    const got: (CoverPointSet | null)[] = [];
    const take = (): CoverPointSet | null => {
      cover.ask(id, 0, 0, (p) => got.push(p));
      cover.frame();
      return got.pop()!;
    };
    expect(take()!.count).toBe(800);
    // A budget of half the points held: each set hands over the half with the lowest thresholds, and is asked again.
    asked.length = 0;
    cover.setBudget(800 * VOXEL_COVER_POINT_BYTES);
    expect(cover.stats().share).toBe(0.5);
    expect(asked).toEqual([`${id}:all`]);
    const half = take()!;
    expect(half.count).toBe(400);
    expect(half.data).toEqual(pointSet(800, 0, 0).data.subarray(0, 400 * COVER_POINT_FLOATS));
    // Room again: whole sets.
    cover.setBudget(Infinity);
    expect(take()!.count).toBe(800);
    // A slice of no time hands over one set a frame; the rest wait for the next frames.
    frameArbiter.install({ ...FRAME_SLICE_DEFAULTS, voxelCover: { ...FRAME_SLICE_DEFAULTS.voxelCover, ms: 0 } });
    for (let i = 0; i < 5; i++) cover.ask(id, i % 2, 0, (p) => got.push(p));
    cover.frame();
    expect([got.length, cover.stats().pending]).toEqual([1, 4]);
    cover.frame();
    expect([got.length, cover.stats().pending]).toEqual([2, 3]);
    frameArbiter.install({ ...FRAME_SLICE_DEFAULTS, voxelCover: { ...FRAME_SLICE_DEFAULTS.voxelCover, ms: 1000 } });
    cover.frame();
    expect([got.length, cover.stats().pending]).toEqual([5, 0]);
    // A set asked of a column that holds none answers none.
    cover.ask(id, 7, 7, (p) => got.push(p));
    cover.frame();
    expect(got.pop()).toBeNull();
    cover.dispose();
  });

  it('reaches the path from a world\'s draw batches: after the batch\'s chunks, with the drawn level\'s budget, gone with the world', () => {
    const calls: unknown[][] = [];
    const sink = { receive: (...a: unknown[]) => void calls.push(['receive', ...a]), close: (...a: unknown[]) => void calls.push(['close', ...a]), setBudget: (...a: unknown[]) => void calls.push(['budget', ...a]) };
    const renderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined } as VoxelGridRenderer;
    const scene = new THREE.Scene();
    const draws = new VoxelWorldDraws({ scene: () => scene, renderer: () => renderer, report: () => undefined, cover: () => sink });
    const cover = [wire(0, 0, set('meadow', 0, GRASS, pointSet(10, 0, 0)))];
    const batch = (extra: Partial<ChunkDrawBatch>): ChunkDrawBatch => ({ world: 'town', edge: chunkGrid(32).edge, chunks: [], swaps: [], sentAt: 0, joinMs: 0, ...extra });
    draws.receive(batch({ cover }));
    expect(calls.filter((c) => c[0] === 'receive')).toEqual([['receive', 'town', 32, cover]]);
    // A structure grid's batches carry none: its cover is not the world grid's.
    draws.receive(batch({ world: 'town|grid:7', place: { world: 'town', grid: 7, position: [0, 0, 0], yawRad: 0 }, cover }));
    expect(calls.filter((c) => c[0] === 'receive').length).toBe(1);
    draws.receive(batch({ closed: true }));
    expect(calls.filter((c) => c[0] === 'close')).toEqual([['close', 'town']]);
    draws.dispose();
  });
});
