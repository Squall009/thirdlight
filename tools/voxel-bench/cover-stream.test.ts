/**
 * Ground cover as a world streams, on the made world of dressing-world.ts:
 * the real cover stream and the real draw batcher over a chunk store, the
 * cover job in a real worker. Every drawn chunk column gets its cover after
 * its draw; an edit makes again only what its feeds reach and sends only
 * what changed; a road takes the grass and grows its verge; a dig, a pool
 * and a dressing change are followed; fog changes nothing; a prop is kept
 * clear and followed when it moves; a column's cover goes with its chunks.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_DERIVED_PARTS,
  buildApron,
  ChunkCoverStream,
  ChunkDrawBatcher,
  COVER_FED_BY,
  DERIVED_PART,
  deriveSectionsWithApron,
  DirtyTracker,
  jobRadius,
  joinSectionsForDraw,
  PLACEHOLDER_RULES,
  SHAPE_FULL,
  surfaceFieldsInputOf,
  valueMaterial,
  valueRole,
  valueShape,
  valueWetness,
  VoxelOverlay,
  WorkerPool,
  type ChunkCoverWire,
  type ChunkDrawBatch,
  type JoinedDraw,
  type PaletteStore,
  type StreamEvent,
} from '@thirdlight/voxel';
import { coverPointAt, voxelCoverPoints, voxelCoverTable, type CoverPoint, type VoxelCoverSet, type VoxelCoverTable } from '@thirdlight/project-model';

import { cell, DRESSINGS, FLOWER_SPECIES, GRASS, GRASS_SPECIES, grid, M, MATERIALS, R, REED_SPECIES, ROAD, TABLE, WATER, world } from './dressing-world';
import { bundleWorker, nodePoolWorker, REPO } from './stream-node';

const SECTION = 16;
const RADIUS = jobRadius(PLACEHOLDER_RULES);
const MIST = 31;

let workerFile = '';
let pool: WorkerPool;

beforeAll(async () => {
  workerFile = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `cover-stream-worker-${process.pid}.mjs`));
  pool = new WorkerPool({ size: 2, create: () => nodePoolWorker(workerFile), timeoutMs: 30_000, maxQueued: 64 });
}, 120_000);

afterAll(() => {
  pool?.close();
  if (workerFile !== '') rmSync(workerFile, { force: true });
});

const tick = (): Promise<void> => new Promise((ok) => setTimeout(ok, 2));
const key = (cx: number, cz: number): string => `${cx},${cz}`;
const pointsOf = (set: VoxelCoverSet | undefined): CoverPoint[] => (set === undefined ? [] : Array.from({ length: set.points.count }, (_, i) => coverPointAt(set.points, i)));
const sameBytes = (a: Float32Array, b: Float32Array): boolean => a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** The made world streamed: every chunk loaded and drawn through the real batcher, its cover made by the real stream in the pool. */
function rig(table: VoxelCoverTable = TABLE): {
  store: PaletteStore;
  cover: ChunkCoverStream;
  batches: ChunkDrawBatch[];
  /** What each column holds where the world is drawn, as the batches left it. */
  held: Map<string, readonly VoxelCoverSet[]>;
  joins: { count: number };
  emit(e: StreamEvent): void;
  settle(): Promise<void>;
  /** The cover wires of the batches since `from`. */
  wires(from: number): ChunkCoverWire[];
  resident: Set<string>;
} {
  const store = world();
  const listeners: Array<(e: StreamEvent) => void> = [];
  const resident = new Set<string>();
  const joins = { count: 0 };
  const joined = (cx: number, cy: number, cz: number, cells: Uint16Array): JoinedDraw => {
    joins.count++;
    const n = grid.edge / SECTION;
    const ids = Array.from({ length: n * n * n }, (_, i) => i);
    const results = deriveSectionsWithApron(grid, PLACEHOLDER_RULES, buildApron(store, cx, cy, cz, RADIUS), (out) => store.exportChunk(cx, cy, cz, out), SECTION, ids);
    return joinSectionsForDraw(grid.edge, SECTION, results.map((r) => r.assembly), cells);
  };
  const batches: ChunkDrawBatch[] = [];
  const held = new Map<string, readonly VoxelCoverSet[]>();
  let flush: () => void = () => {};
  // The batcher's hooks name the stream, which is made with the batcher's `cover`.
  let cover: ChunkCoverStream | null = null;
  const batcher = new ChunkDrawBatcher(
    'w',
    { grid, on: (l) => void listeners.push(l), joinedChunk: (cx, cy, cz, _t, cells) => joined(cx, cy, cz, cells), setPart: () => true },
    SECTION,
    (b) => {
      batches.push(b);
      for (const c of b.cover ?? []) {
        if (c.sets === undefined) held.delete(key(c.cx, c.cz));
        else held.set(key(c.cx, c.cz), c.sets as unknown as VoxelCoverSet[]);
      }
    },
    { schedule: (f) => (flush = f), inPlace: true, cover: { drawn: (cx, cy, cz, parts) => cover?.drawn(cx, cy, cz, parts), removed: (cx, cy, cz) => cover?.removed(cx, cy, cz) } },
  );
  const made = new ChunkCoverStream({
    stream: { grid, gridId: 0, tracker: new DirtyTracker(), on: (l) => void listeners.push(l as (e: StreamEvent) => void), isResident: (cx, cy, cz) => resident.has(`${cx},${cy},${cz}`), store, overlay: new VoxelOverlay(store, 'runtime') },
    pool,
    send: (w) => batcher.cover(w),
  });
  cover = made;
  made.setTable(table);
  const emit = (e: StreamEvent): void => {
    if (e.type === 'loaded') resident.add(`${e.cx},${e.cy},${e.cz}`);
    if (e.type === 'unloaded') resident.delete(`${e.cx},${e.cy},${e.cz}`);
    listeners.forEach((l) => l(e));
    flush();
  };
  const settle = async (): Promise<void> => {
    await tick();
    for (let i = 0; i < 20_000 && !made.settled; i++) await tick();
    expect(made.settled).toBe(true);
    flush();
  };
  for (let cx = 0; cx < 4; cx++) for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 4; cz++) emit({ type: 'loaded', cx, cy, cz });
  for (let cx = 0; cx < 4; cx++) for (let cy = 0; cy < 2; cy++) for (let cz = 0; cz < 4; cz++) emit({ type: 'chunk', cx, cy, cz, shaderOnly: false, reliefOnly: false, parts: ALL_DERIVED_PARTS });
  return { store, cover: made, batches, held, joins, emit, settle, wires: (from) => batches.slice(from).flatMap((b) => b.cover ?? []), resident };
}

/** The cover of column (cx, cz) made in this thread from the store as it is (what a job answers for chunk rows 0 and 1). */
function fresh(store: PaletteStore, cx: number, cz: number, table: VoxelCoverTable = TABLE, clear?: Float32Array): VoxelCoverSet[] {
  return voxelCoverPoints({ fields: surfaceFieldsInputOf(store, cx, cz, -1, 1).input, rows: [0, 1], table, ...(clear !== undefined ? { clear } : {}) }).sets;
}

function expectSame(a: readonly VoxelCoverSet[] | undefined, b: readonly VoxelCoverSet[], what: string): void {
  const got = a ?? [];
  expect(got.map((s) => [s.dressing, s.species, s.points.count]), what).toEqual(b.map((s) => [s.dressing, s.species, s.points.count]));
  got.forEach((s, i) => expect(sameBytes(s.points.data, b[i]!.points.data), `${what}: ${s.dressing} ${s.species}`).toBe(true));
}

/** The row of a column's highest cell that is a body (ground or built). */
function topRow(store: PaletteStore, x: number, z: number): number {
  const v = { material: 0, role: 0, shape: 0, wetness: 0 };
  for (let y = 2 * grid.edge - 1; y >= 0; y--) {
    store.voxelAt(x, y, z, v);
    if (v.material !== 0 && v.role !== R.liquid && v.role !== R.gas) return y;
  }
  return -1;
}

/** Whether a point (metres) lies over the square of columns [x0, x1) × [z0, z1), grown by `pad` metres. */
const inSquare = (p: CoverPoint, x0: number, x1: number, z0: number, z1: number, pad = 0): boolean => p.x > x0 * M - pad && p.x < x1 * M + pad && p.z > z0 * M - pad && p.z < z1 * M + pad;
const species = (sets: readonly VoxelCoverSet[] | undefined, dressing: string, index: number): CoverPoint[] => pointsOf((sets ?? []).find((s) => s.dressing === dressing && s.species === index));

/** A square of the wet meadow of chunk column (2, 1), clear of the road strips, the hill and the house. */
const PATCH = { x0: 82, x1: 90, z0: 44, z1: 52 };
const PATCH_COLUMN = [2, 1] as const;

describe('ground cover as a voxel world streams', () => {
  it('gives every drawn column its cover from a real worker, after its draw: points on the surface, each species on the material that names its dressing', { timeout: 120_000 }, async () => {
    const r = rig();
    // The chunks' draws left before any cover: a mesh never waits for cover.
    expect(r.batches.length).toBeGreaterThan(0);
    expect(r.batches.every((b) => b.cover === undefined)).toBe(true);
    const drawn = r.batches.flatMap((b) => b.chunks).filter((c) => c.kind === 'draw').length;
    expect(drawn).toBeGreaterThan(16);
    await r.settle();
    const stats = r.cover.stats();
    expect(stats.columns).toBe(16);
    expect(stats.covered).toBe(16);
    expect(stats.points).toBeGreaterThan(5000);
    expect(stats.jobs).toBeGreaterThanOrEqual(16);
    expect(stats.live + stats.waiting).toBe(0);
    let grass = 0;
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) {
      const sets = r.held.get(key(cx, cz));
      // The bytes this thread gives for the same cells: one arithmetic, page and worker.
      expectSame(sets, fresh(r.store, cx, cz), `column ${cx},${cz}`);
      for (const p of species(sets, 'meadow', GRASS_SPECIES)) {
        grass++;
        const row = Math.ceil(p.y / M - 1e-6) - 1;
        const cells = [-0.005, 0.005].flatMap((dx) => [-0.005, 0.005].map((dz) => cell(Math.floor((p.x + dx) / M), row, Math.floor((p.z + dz) / M))));
        // On grass, at the height its cell's fill gives, with nothing solid over it.
        const on = cells.find((v) => valueMaterial(v) === GRASS && Math.abs((row + valueShape(v) / SHAPE_FULL) * M - p.y) < 1e-4);
        expect(on, `grass at ${p.x},${p.y},${p.z}`).toBeDefined();
        expect(p.x >= cx * 16 && p.x <= (cx + 1) * 16 && p.z >= cz * 16 && p.z <= (cz + 1) * 16).toBe(true);
      }
    }
    expect(grass).toBeGreaterThan(3000);
    process.stderr.write(`voxel cover stream bench: ${stats.jobs} cover jobs of the made world in a worker, ${(stats.workerMs / stats.jobs).toFixed(1)} ms a chunk column (${stats.points} points held)\n`);
    r.cover.close();
  });

  it('a road painted across a meadow: its grass goes, flowers grow at its verge, and only the columns the change feeds are made again', { timeout: 120_000 }, async () => {
    const r = rig();
    await r.settle();
    const before = new Map(r.held);
    const jobs = r.cover.stats().jobs;
    const from = r.batches.length;
    const joins = r.joins.count;
    const { x0, x1, z0, z1 } = PATCH;
    expect(species(before.get(key(...PATCH_COLUMN)), 'meadow', GRASS_SPECIES).filter((p) => inSquare(p, x0, x1, z0, z1, -0.02)).length).toBeGreaterThan(20);
    // Far from any other material no flower stands at the square's far side.
    const verge = (p: CoverPoint): boolean => inSquare(p, x1, x1 + 3, z0, z1, -0.02);
    expect(species(before.get(key(...PATCH_COLUMN)), 'meadow', FLOWER_SPECIES).filter(verge)).toEqual([]);
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) {
      const y = topRow(r.store, x, z);
      const v = cell(x, y, z);
      r.store.setVoxel(x, y, z, { material: ROAD, role: valueRole(v), shape: valueShape(v), wetness: valueWetness(v) });
    }
    // A material change feeds the shader data alone: the chunk's surfaces stand.
    r.emit({ type: 'chunk', cx: 2, cy: 0, cz: 1, shaderOnly: true, reliefOnly: false, parts: DERIVED_PART.shader | DERIVED_PART.liquid | DERIVED_PART.gas });
    await r.settle();
    const after = r.held.get(key(...PATCH_COLUMN));
    expect(species(after, 'meadow', GRASS_SPECIES).filter((p) => inSquare(p, x0, x1, z0, z1, -0.02))).toEqual([]);
    expect(species(after, 'meadow', FLOWER_SPECIES).filter(verge).length).toBeGreaterThan(0);
    // Made again: the column and the eight round it, no other; sent: only those whose plants changed.
    expect(r.cover.stats().jobs - jobs).toBe(9);
    const sent = r.wires(from).map((w) => key(w.cx, w.cz));
    expect(sent).toContain(key(...PATCH_COLUMN));
    for (const k of sent) {
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      expect(Math.abs(cx - 2) <= 1 && Math.abs(cz - 1) <= 1, k).toBe(true);
    }
    expect(sent.length).toBeLessThan(9);
    expect(r.cover.stats().same).toBeGreaterThan(0);
    // Every column is what one pass over the edited world gives: the untouched ones byte for byte what they were.
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) {
      expectSame(r.held.get(key(cx, cz)), fresh(r.store, cx, cz), `after the road ${cx},${cz}`);
      if (!sent.includes(key(cx, cz))) expect(r.held.get(key(cx, cz))).toBe(before.get(key(cx, cz)));
    }
    // The paint drew no chunk again but the one painted (its shader data): no other join.
    expect(r.joins.count - joins).toBe(1);
    r.cover.close();
  });

  it('follows a dig to the new ground, grows reeds when water stands in it, and makes nothing again for fog', { timeout: 120_000 }, async () => {
    const r = rig();
    await r.settle();
    const { x0, x1, z0, z1 } = PATCH;
    const floor = new Map<string, number>();
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) {
      const y = topRow(r.store, x, z);
      const v = cell(x, y, z);
      // Two cells down: the pit's floor is whole ground of the same material.
      for (const d of [0, 1]) r.store.setVoxel(x, y - d, z, { material: 0, role: 0, shape: 0, wetness: 0 });
      r.store.setVoxel(x, y - 2, z, { material: valueMaterial(v), role: R.terrain, shape: SHAPE_FULL, wetness: 0 });
      floor.set(`${x},${z}`, y - 2);
    }
    r.emit({ type: 'chunk', cx: 2, cy: 0, cz: 1, shaderOnly: false, reliefOnly: false, parts: ALL_DERIVED_PARTS });
    await r.settle();
    const inPit = (p: CoverPoint): boolean => inSquare(p, x0, x1, z0, z1, -0.02);
    const dug = species(r.held.get(key(...PATCH_COLUMN)), 'meadow', GRASS_SPECIES).filter(inPit);
    expect(dug.length).toBeGreaterThan(20);
    // No plant left in the air: each stands on the pit's floor.
    for (const p of dug) expect(p.y).toBeCloseTo((floor.get(`${Math.floor(p.x / M)},${Math.floor(p.z / M)}`)! + 1) * M, 4);
    expectSame(r.held.get(key(...PATCH_COLUMN)), fresh(r.store, ...PATCH_COLUMN), 'after the dig');
    expect(species(r.held.get(key(...PATCH_COLUMN)), 'meadow', REED_SPECIES).filter(inPit)).toEqual([]);

    // Water 0.3 m deep in the pit: a change between air and liquid feeds the liquid part alone.
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) r.store.setVoxel(x, floor.get(`${x},${z}`)! + 1, z, { material: WATER, role: R.liquid, shape: 9, wetness: 0 });
    let jobs = r.cover.stats().jobs;
    r.emit({ type: 'chunk', cx: 2, cy: 0, cz: 1, shaderOnly: true, reliefOnly: false, parts: DERIVED_PART.liquid });
    await r.settle();
    expect(r.cover.stats().jobs - jobs).toBe(9);
    expect(species(r.held.get(key(...PATCH_COLUMN)), 'meadow', REED_SPECIES).filter(inPit).length).toBeGreaterThan(5);
    expect(species(r.held.get(key(...PATCH_COLUMN)), 'meadow', GRASS_SPECIES).filter(inPit)).toEqual([]);
    expectSame(r.held.get(key(...PATCH_COLUMN)), fresh(r.store, ...PATCH_COLUMN), 'after the water');

    // Fog over the meadow of another chunk: no rule reads gas, so nothing is asked and nothing is sent.
    expect(COVER_FED_BY & DERIVED_PART.gas).toBe(0);
    for (let x = 8; x < 20; x++) for (let z = 8; z < 20; z++) r.store.setVoxel(x, topRow(r.store, x, z) + 2, z, { material: MIST, role: R.gas, shape: 12, wetness: 0 });
    jobs = r.cover.stats().jobs;
    const from = r.batches.length;
    r.emit({ type: 'chunk', cx: 0, cy: 0, cz: 0, shaderOnly: true, reliefOnly: false, parts: DERIVED_PART.gas });
    await r.settle();
    expect(r.cover.stats().jobs).toBe(jobs);
    expect(r.wires(from)).toEqual([]);
    expect(r.batches.slice(from).flatMap((b) => b.chunks).map((c) => c.kind)).toEqual(['gas']);
    r.cover.close();
  });

  it('a dressing change makes the cover again with no chunk drawn again; no dressing lets every column go', { timeout: 120_000 }, async () => {
    const r = rig();
    await r.settle();
    const jobs = r.cover.stats().jobs;
    const joins = r.joins.count;
    let from = r.batches.length;
    const grassBefore = species(r.held.get(key(0, 0)), 'meadow', GRASS_SPECIES).length;
    // The meadow's grass at a quarter of its density.
    const sparse = DRESSINGS.map((d) => (d.dressingId !== 'meadow' ? d : { ...d, species: d.species.map((s, i) => (i === GRASS_SPECIES ? { ...s, density: 1 } : s)) }));
    const table = voxelCoverTable({ materials: MATERIALS as never, dressings: sparse });
    r.cover.setTable(table);
    await r.settle();
    expect(r.cover.stats().jobs - jobs).toBe(16);
    expect(r.joins.count).toBe(joins);
    expect(r.batches.slice(from).flatMap((b) => b.chunks)).toEqual([]);
    const grassAfter = species(r.held.get(key(0, 0)), 'meadow', GRASS_SPECIES).length;
    expect(grassAfter).toBeGreaterThan(0);
    expect(grassAfter).toBeLessThan(grassBefore / 2);
    // The species' rule travels with its points: what draws them reads the new density's rule.
    expect((r.held.get(key(0, 0))!.find((s) => s.dressing === 'meadow' && s.species === GRASS_SPECIES)!.rule as { density: number }).density).toBe(1);
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) expectSame(r.held.get(key(cx, cz)), fresh(r.store, cx, cz, table), `sparse ${cx},${cz}`);
    // The same table again asks nothing.
    r.cover.setTable(voxelCoverTable({ materials: MATERIALS as never, dressings: sparse }));
    await r.settle();
    expect(r.cover.stats().jobs - jobs).toBe(16);
    // Nothing grows: every column lets its cover go, with no job.
    from = r.batches.length;
    r.cover.setTable(null);
    await r.settle();
    expect(r.cover.stats().jobs - jobs).toBe(16);
    expect(r.held.size).toBe(0);
    expect(r.wires(from).length).toBe(16);
    expect(r.cover.stats().points).toBe(0);
    r.cover.close();
  });

  it('keeps clear of a prop, and makes the columns near its old and new place again when it moves', { timeout: 120_000 }, async () => {
    const r = rig();
    await r.settle();
    // A cart on the meadow of column (0, 0), then moved onto column (1, 0)'s.
    const at = (x0: number, z0: number): Float32Array => new Float32Array([x0, 3, z0, x0 + 3, 8, z0 + 2]);
    const under = (b: Float32Array) => (p: CoverPoint): boolean => p.x >= b[0]! && p.x <= b[3]! && p.z >= b[2]! && p.z <= b[5]!;
    const first = at(5, 5);
    const second = at(18, 6);
    expect(species(r.held.get(key(0, 0)), 'meadow', GRASS_SPECIES).filter(under(first)).length).toBeGreaterThan(10);
    let jobs = r.cover.stats().jobs;
    r.cover.setClear(first);
    await r.settle();
    // The columns within a species' largest spacing of the box: (0, 0) alone holds it 5 m from its borders… and those 8 m off.
    const near = r.cover.stats().jobs - jobs;
    expect(near).toBeGreaterThanOrEqual(1);
    expect(near).toBeLessThanOrEqual(4);
    expect(species(r.held.get(key(0, 0)), 'meadow', GRASS_SPECIES).filter(under(first))).toEqual([]);
    expectSame(r.held.get(key(0, 0)), fresh(r.store, 0, 0, TABLE, first), 'with the cart');
    jobs = r.cover.stats().jobs;
    r.cover.setClear(second);
    await r.settle();
    expect(r.cover.stats().jobs - jobs).toBeLessThanOrEqual(6);
    expect(species(r.held.get(key(0, 0)), 'meadow', GRASS_SPECIES).filter(under(first)).length).toBeGreaterThan(10);
    expect(species(r.held.get(key(1, 0)), 'meadow', GRASS_SPECIES).filter(under(second))).toEqual([]);
    for (const [cx, cz] of [[0, 0], [1, 0]] as const) expectSame(r.held.get(key(cx, cz)), fresh(r.store, cx, cz, TABLE, second), `cart moved ${cx},${cz}`);
    // The same boxes again ask nothing.
    jobs = r.cover.stats().jobs;
    r.cover.setClear(second.slice());
    await r.settle();
    expect(r.cover.stats().jobs).toBe(jobs);
    r.cover.close();
  });

  it('lets a column\'s cover go in the batch that removes its last chunk, keeps the rows still drawn, and asks nothing once closed', { timeout: 120_000 }, async () => {
    const r = rig();
    await r.settle();
    // The hill's column: its top chunk goes first (its top face's lichen with it), the ground chunk stays drawn.
    const hill = [0, 1] as const;
    const upper = (p: CoverPoint): boolean => Math.ceil(p.y / M - 1e-6) - 1 >= grid.edge;
    const all = (r.held.get(key(...hill)) ?? []).flatMap((s) => pointsOf(s));
    expect(all.filter(upper).length).toBe(0);
    // The house's upper storey is in the upper chunks: dust on its boards.
    const house = [3, 2] as const;
    const dust = (): CoverPoint[] => (r.held.get(key(...house)) ?? []).flatMap((s) => pointsOf(s)).filter(upper);
    expect(dust().length).toBeGreaterThan(0);
    r.emit({ type: 'unloaded', cx: 3, cy: 1, cz: 2 });
    await r.settle();
    expect(dust()).toEqual([]);
    expect(r.held.get(key(...house))!.length).toBeGreaterThan(0);
    // The last chunk of the column: its cover goes in the same batch as the chunk's draw.
    const from = r.batches.length;
    r.emit({ type: 'unloaded', cx: 3, cy: 0, cz: 2 });
    const batch = r.batches[from]!;
    expect(batch.chunks.map((c) => [c.kind, c.cx, c.cy, c.cz])).toEqual([['remove', 3, 0, 2]]);
    expect(batch.cover).toEqual([{ cx: 3, cz: 2 }]);
    expect(r.held.has(key(...house))).toBe(false);
    await r.settle();
    expect(r.cover.stats().columns).toBe(15);
    // Closed with jobs out: they are given up, and their answers are not sent.
    const jobs = r.cover.stats().jobs;
    r.cover.setTable(voxelCoverTable({ materials: MATERIALS as never, dressings: DRESSINGS.slice(0, 3) }));
    await tick();
    expect(r.cover.stats().live).toBeGreaterThan(0);
    const sentBefore = r.batches.length;
    r.cover.close();
    expect(r.cover.stats().live).toBe(0);
    expect(r.cover.stats().columns).toBe(0);
    for (let i = 0; i < 40; i++) await tick();
    expect(r.batches.length).toBe(sentBefore);
    expect(r.cover.stats().jobs).toBe(jobs);
    // Nothing more is asked of a closed stream.
    r.cover.drawn(0, 0, 0, ALL_DERIVED_PARTS);
    r.cover.setTable(TABLE);
    await tick();
    expect(r.cover.stats().live).toBe(0);
  });
});
