/**
 * A chunk's ground cover from the voxel source, on one made world held in a
 * real chunk store: a rolling meadow with a road, a pond, a dry-grass
 * variant, a hill with a wet cave and a two-storey house. The cover job is
 * run from the store's chunks as a worker is sent them: its points stand
 * only where their species grows, a cave's floor and an upper storey get
 * their own answer, neighbouring chunks agree with one bake over them all,
 * an edit elsewhere leaves a chunk's bytes alone, props are kept clear, and
 * a real worker gives the bytes this thread gives. A browser build of a
 * worker that serves the job passes the export scan.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chunkGrid,
  createDenseChunk,
  createWorldStore,
  localIndex,
  propClearances,
  recordValue,
  SHAPE_FULL,
  surfaceFieldsCells,
  surfaceFieldsInputOf,
  valueMaterial,
  valueRole,
  valueShape,
  valueWetness,
  VOXEL_ROLE,
  WorkerPool,
  type PaletteStore,
  type PropShape,
  type SurfaceCells,
} from '@thirdlight/voxel';
import { coverPointAt, VOXEL_COVER_JOB, voxelCoverOfCells, voxelCoverPoints, voxelCoverTable, type CoverPoint, type DressingDef, type VoxelCoverInput, type VoxelCoverOutput, type VoxelCoverSet } from '@thirdlight/project-model';

import { scanExportFiles } from '../../packages/exporter/src/scan';
import { bundleWorker, nodePoolWorker, REPO } from './stream-node';
import { BOARDS, CAVE, cell, CLOVER_SPECIES, DRESSINGS, DRY, E, FLOWER_SPECIES, GRASS, GRASS_SPECIES, grid, HIGH, HILL, HOUSE, M, material, MATERIALS, OAK_SPECIES, PAVED, PLASTER, POND, R, REED_SPECIES, ROAD, ROADS, SIDE, STONE, TABLE, THISTLE_SPECIES, TILES, WATER, wholeBox, world, writeChunk } from './dressing-world';


const inputOf = (store: PaletteStore, cx: number, cz: number, extra: Partial<VoxelCoverInput> = {}): VoxelCoverInput => ({ fields: surfaceFieldsInputOf(store, cx, cz, 0, 1).input, table: TABLE, ...extra });
const cover = (store: PaletteStore, cx: number, cz: number, extra: Partial<VoxelCoverInput> = {}): VoxelCoverOutput => voxelCoverPoints(inputOf(store, cx, cz, extra));
const setOf = (out: VoxelCoverOutput, dressing: string, species: number): VoxelCoverSet | undefined => out.sets.find((s) => s.dressing === dressing && s.species === species);
const pointsOf = (set: VoxelCoverSet | undefined): CoverPoint[] => (set === undefined ? [] : Array.from({ length: set.points.count }, (_, i) => coverPointAt(set.points, i)));
const sameBytes = (a: ArrayBufferView, b: ArrayBufferView): boolean => a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** Two answers the same, byte for byte: the same species in the same order, the same rule, the same point bytes. */
function expectSame(a: VoxelCoverOutput, b: VoxelCoverOutput, what: string): void {
  expect(a.sets.map((s) => [s.dressing, s.species, JSON.stringify(s.rule), s.points.count, s.points.x0, s.points.z0, s.points.w, s.points.d, s.points.low, s.points.high]), what).toEqual(b.sets.map((s) => [s.dressing, s.species, JSON.stringify(s.rule), s.points.count, s.points.x0, s.points.z0, s.points.w, s.points.d, s.points.low, s.points.high]));
  a.sets.forEach((s, i) => expect(sameBytes(s.points.data, b.sets[i]!.points.data), `${what}: ${s.dressing} ${s.species}`).toBe(true));
}

/** The surface cell a point stands on: its row from its height, its column from its place (a place is stored in steps of 4 mm, so a point on a column's line may read either side). */
function surfaceCells(p: CoverPoint): number[] {
  const row = Math.ceil(p.y / M - 1e-6) - 1;
  const out: number[] = [];
  for (const dx of [-0.005, 0, 0.005]) for (const dz of [-0.005, 0, 0.005]) out.push(cell(Math.floor((p.x + dx) / M), row, Math.floor((p.z + dz) / M)));
  return out;
}
const onMaterial = (p: CoverPoint, id: number): boolean => surfaceCells(p).some((v) => valueMaterial(v) === id);

let store: PaletteStore;
let workerFile = '';
let pool: WorkerPool;
let jobId = 0;

beforeAll(async () => {
  store = world();
  workerFile = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `dressing-cover-worker-${process.pid}.mjs`));
  pool = new WorkerPool({ size: 1, create: () => nodePoolWorker(workerFile), timeoutMs: 30_000, maxQueued: 64 });
}, 120_000);

afterAll(() => {
  pool?.close();
  if (workerFile !== '') rmSync(workerFile, { force: true });
});

describe('ground cover from the voxel source: who grows where', () => {
  it('resolves each voxel material to its dressing through its instance chain', () => {
    expect(TABLE.dressings.map((d) => d.dressingId)).toEqual(['cave', 'dust', 'meadow', 'meadow-sparse']);
    expect(TABLE.materials).toEqual([[GRASS, 2], [DRY, 3], [STONE, 0], [BOARDS, 1]]);
  });

  it('stands every point on a surface of a material that names its species\' dressing: grass on the meadow, none on the road, the variant\'s sparser grass on the dry meadow', () => {
    // Chunk (2, 0) holds a road strip and the pond; chunk (0, 3) the dry meadow.
    const out = cover(store, 2, 0);
    const grass = pointsOf(setOf(out, 'meadow', GRASS_SPECIES));
    expect(grass.length).toBeGreaterThan(300);
    for (const p of grass) {
      expect(onMaterial(p, GRASS), `${p.x},${p.y},${p.z}`).toBe(true);
      // Never in the road's columns, with a step of slack at their edges.
      expect(ROADS.some(([a, b]) => p.x > a * M + 0.01 && p.x < b * M - 0.01)).toBe(false);
    }
    const dry = cover(store, 0, 3);
    expect(dry.sets.map((s) => s.dressing)).toEqual(['meadow-sparse']);
    const sparse = pointsOf(setOf(dry, 'meadow-sparse', 0));
    for (const p of sparse) expect(onMaterial(p, DRY)).toBe(true);
    // The variant grows a quarter of the density over a whole chunk of open ground: 256 against 1,024 candidates.
    expect(sparse.length).toBe(256);
    const meadow = pointsOf(setOf(cover(store, 0, 0), 'meadow', GRASS_SPECIES));
    expect(meadow.length).toBeGreaterThan(900);
    expect(sparse.length * 3).toBeLessThan(meadow.length);
  });

  it('grows reeds only in the pond\'s shallows and no grass under its water', () => {
    const out = cover(store, 2, 0);
    const reeds = pointsOf(setOf(out, 'meadow', REED_SPECIES));
    expect(reeds.length).toBeGreaterThan(10);
    for (const p of reeds) {
      const d = Math.hypot(p.x / M - POND.x, p.z / M - POND.z);
      // Depth 0.05–0.5 m: the bed at most a cell under the level, which is the bowl's last tenth and the flooded
      // ring round it (a column of slack).
      expect(d, `${p.x},${p.z}`).toBeGreaterThan(POND.r * 0.9 - 1.5);
      expect(d).toBeLessThan(POND.shore + 1);
      expect(p.y).toBeLessThan(POND.level * M);
    }
    // A spacing of 0.4 m between reeds.
    let nearest = Infinity;
    for (let i = 0; i < reeds.length; i++) for (let k = i + 1; k < reeds.length; k++) nearest = Math.min(nearest, Math.hypot(reeds[i]!.x - reeds[k]!.x, reeds[i]!.y - reeds[k]!.y, reeds[i]!.z - reeds[k]!.z));
    expect(nearest).toBeGreaterThan(0.4 - 0.012);
    // Some stand in the bowl and some on the flooded ring.
    expect(reeds.some((p) => Math.hypot(p.x / M - POND.x, p.z / M - POND.z) < POND.r)).toBe(true);
    expect(reeds.some((p) => Math.hypot(p.x / M - POND.x, p.z / M - POND.z) > POND.r + 1)).toBe(true);
    for (const p of pointsOf(setOf(out, 'meadow', GRASS_SPECIES))) expect(Math.hypot(p.x / M - POND.x, p.z / M - POND.z)).toBeGreaterThan(POND.shore - 1.5);
  });

  it('grows flowers along the road\'s verge and nowhere out in the open, thistles only far from it, clover in patches', () => {
    const flowers = pointsOf(setOf(cover(store, 2, 0), 'meadow', FLOWER_SPECIES));
    expect(flowers.length).toBeGreaterThan(8);
    // The road is the chunk's only other material: a flower's column centre is within 1.5 m of a strip's nearest
    // column centre, so the flower itself within 2 m of a strip's edge. The pond's bed is grass too.
    const toRoad = (p: CoverPoint): number => Math.min(...ROADS.flatMap(([a, b]) => [Math.abs(p.x - a * M), Math.abs(p.x - b * M)]));
    for (const p of flowers) expect(toRoad(p), `${p.x},${p.z}`).toBeLessThan(2.01);
    expect(flowers.some((p) => p.x < ROADS[1]![0] * M) && flowers.some((p) => p.x > ROADS[1]![1] * M)).toBe(true);
    // The thistle is the other way round: nowhere within 7.8 m of a strip.
    const thistles = pointsOf(setOf(cover(store, 0, 0), 'meadow', THISTLE_SPECIES));
    expect(thistles.length).toBeGreaterThan(15);
    // (Column centre to column centre: a plant may stand a quarter metre off its column's centre, a strip's edge another.)
    for (const p of thistles) expect(toRoad(p)).toBeGreaterThan(7.8 - 0.51);
    // Clover in soft-edged patches: some of the open meadow's candidates, not all of them and not none.
    const clover = pointsOf(setOf(cover(store, 0, 0), 'meadow', CLOVER_SPECIES));
    expect(clover.length).toBeGreaterThan(60);
    expect(clover.length).toBeLessThan(512 - 60);
  });

  it('gives a cave\'s floor and the hill over it each their own answer: moss on the wet floor only, lichen on the open top only', () => {
    // Chunk (0, 1) and (0, 2) hold the hill (the second only the cave's last two rows of columns); the cave's wet half is x under 24 cells.
    for (const [cx, cz, least] of [[0, 1, 40], [0, 2, 5]] as const) {
      const out = cover(store, cx, cz);
      const moss = pointsOf(setOf(out, 'cave', 0));
      const lichen = pointsOf(setOf(out, 'cave', 1));
      expect(moss.length, `moss ${cx},${cz}`).toBeGreaterThan(least);
      expect(lichen.length, `lichen ${cx},${cz}`).toBeGreaterThan(40);
      for (const p of moss) {
        expect(p.y).toBe((CAVE.floor + 1) * M);
        expect(p.x / M >= CAVE.x0 - 0.01 && p.x / M <= CAVE.wetTo + 0.01 && p.z / M >= CAVE.z0 - 0.01 && p.z / M <= CAVE.z1 + 0.01, `${p.x},${p.z}`).toBe(true);
      }
      for (const p of lichen) expect(p.y).toBe(HILL.top * M);
      // Over the wet floor both stand in one column: two surfaces, two answers.
      expect(lichen.some((p) => p.x / M > CAVE.x0 && p.x / M < CAVE.wetTo && p.z / M > CAVE.z0 && p.z / M < CAVE.z1)).toBe(true);
    }
  });

  it('gives an upper storey its own answer and grows no grass inside the house: dust on the boards under the roof, nothing on the ground floor or the roof', () => {
    // The house stands in chunks (3, 1) and (3, 2).
    for (const cz of [1, 2]) {
      const out = cover(store, 3, cz);
      const dust = pointsOf(setOf(out, 'dust', 0));
      // The boards between the walls: 10 m² in the first chunk, 38 m² in the second, at two a square metre.
      expect(dust.length).toBeGreaterThan(cz === 1 ? 10 : 50);
      for (const p of dust) {
        expect(p.y).toBe((HOUSE.storey + 1) * M);
        expect(onMaterial(p, BOARDS)).toBe(true);
      }
      const inside = (p: CoverPoint): boolean => p.x / M > HOUSE.x0 + 0.02 && p.x / M < HOUSE.x1 - 0.02 && p.z / M > HOUSE.z0 + 0.02 && p.z / M < HOUSE.z1 - 0.02;
      const grass = pointsOf(setOf(out, 'meadow', GRASS_SPECIES));
      expect(grass.length).toBeGreaterThan(200);
      // The ground floor under the storey is grass ground with no sky: none grows; nothing stands on the roof's tiles.
      expect(grass.filter(inside)).toEqual([]);
      for (const s of out.sets) for (const p of pointsOf(s)) expect(p.y).toBeLessThan(HOUSE.roof * M);
    }
  });

  it('skips the large class: the oak is in the table as data and no chunk grows it', () => {
    expect(TABLE.dressings[2]!.species[OAK_SPECIES]).toMatchObject({ model: 'oak', class: 'large' });
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) {
      const out = cover(store, cx, cz);
      expect(setOf(out, 'meadow', OAK_SPECIES), `${cx},${cz}`).toBeUndefined();
      expect(out.sets.some((s) => s.rule.asset.assetId === 'oak')).toBe(false);
    }
  });

  it('keeps clear of a hand-placed prop: no point in its box across the ground, and the same chunk without the prop grows there', () => {
    // A cart 3 m by 2 m standing on the open meadow of chunk (0, 0), its box from the ground up.
    const cart: PropShape = { inside: () => true, min: [-1.5, 0, -1], max: [1.5, 1.6, 1], position: [8, 4.2, 8], yaw: [1, 0], scale: 1 };
    const inBox = (p: CoverPoint): boolean => p.x > 6.5 && p.x < 9.5 && p.z > 7 && p.z < 9;
    const open = pointsOf(setOf(cover(store, 0, 0), 'meadow', GRASS_SPECIES));
    const cleared = pointsOf(setOf(cover(store, 0, 0, { clear: propClearances([cart]) }), 'meadow', GRASS_SPECIES));
    expect(open.filter(inBox).length).toBeGreaterThan(15);
    expect(cleared.filter(inBox)).toEqual([]);
    expect(cleared.length).toBe(open.length - open.filter(inBox).length);
    // The same prop hung 6 m over the meadow clears nothing under it.
    const hung = pointsOf(setOf(cover(store, 0, 0, { clear: propClearances([{ ...cart, position: [8, 12, 8] }]) }), 'meadow', GRASS_SPECIES));
    expect(hung.length).toBe(open.length);
  });
});

describe('ground cover from the voxel source: the same points whoever asks', () => {
  it('is deterministic: the same chunk twice, and the same world built again, give the same bytes', () => {
    const again = world();
    const ms: string[] = [];
    for (const [cx, cz] of [[0, 1], [2, 0], [3, 2]] as const) {
      const t0 = performance.now();
      const a = cover(store, cx, cz);
      ms.push(`(${cx}, ${cz}) ${(performance.now() - t0).toFixed(1)} ms for ${a.sets.reduce((n, s) => n + s.points.count, 0)} points of ${a.sets.length} species`);
      expect(a.sets.length).toBeGreaterThan(0);
      expectSame(cover(store, cx, cz), a, `twice ${cx},${cz}`);
      expectSame(cover(again, cx, cz), a, `again ${cx},${cz}`);
    }
    // Reported, never asserted (this host's load decides it): a chunk column's cover in this thread, its first run.
    process.stderr.write(`voxel cover bench: a chunk column of the made world, nine cover species in the table: ${ms.join('; ')}\n`);
  });

  it('agrees across chunk borders with one bake over them all, whatever order the chunks are made in', () => {
    const box = wholeBox();
    /** The chunks one by one, forwards and backwards, against a single bake over their rectangle from the whole world. */
    const agree = (order: [number, number][], rect: [number, number, number, number], must: number[]): void => {
      const forwards = order.map(([cx, cz]) => cover(store, cx, cz));
      const backwards = [...order].reverse().map(([cx, cz]) => cover(store, cx, cz)).reverse();
      forwards.forEach((o, i) => expectSame(backwards[i]!, o, `order ${order[i]!.join(',')}`));
      const whole = voxelCoverOfCells(box, rect, TABLE);
      const kinds = new Set(forwards.flatMap((o) => o.sets.map((s) => `${s.dressing}/${s.species}`)));
      expect([...kinds].sort()).toEqual(whole.sets.map((s) => `${s.dressing}/${s.species}`).sort());
      expect([...kinds]).toEqual(expect.arrayContaining(must.map((s) => `meadow/${s}`)));
      for (const w of whole.sets) {
        const joined = forwards.flatMap((o) => pointsOf(setOf(o, w.dressing, w.species)));
        const one = pointsOf(w);
        expect(joined.length, `${w.dressing}/${w.species}`).toBe(one.length);
        // Each point of the one bake has its twin among the chunks' (places are stored in steps of 4 and 8 mm).
        const cellOf = (p: CoverPoint): string => `${Math.round(p.x * 10)},${Math.round(p.z * 10)}`;
        const byCell = new Map<string, CoverPoint[]>();
        for (const p of joined) byCell.set(cellOf(p), [...(byCell.get(cellOf(p)) ?? []), p]);
        let unmatched = 0;
        for (const p of one) {
          let found = false;
          for (let dx = -1; dx <= 1 && !found; dx++) for (let dz = -1; dz <= 1 && !found; dz++) {
            found = (byCell.get(`${Math.round(p.x * 10) + dx},${Math.round(p.z * 10) + dz}`) ?? []).some((q) => Math.abs(q.x - p.x) < 0.012 && Math.abs(q.z - p.z) < 0.012 && q.y === p.y && q.threshold === p.threshold && q.yaw === p.yaw && q.scale === p.scale);
          }
          if (!found) unmatched++;
        }
        expect(unmatched, `${w.dressing}/${w.species}`).toBe(0);
      }
    };
    // The four middle chunks: the road's verge, the hill, the clover's soft patches (a share's pick must not depend on the chunk).
    agree([[1, 1], [1, 2], [2, 1], [2, 2]], [16, 16, 48, 48], [GRASS_SPECIES, FLOWER_SPECIES, CLOVER_SPECIES]);
    // The first two chunks of the first row: the thistle's border.
    agree([[0, 0], [1, 0]], [0, 0, 32, 16], [THISTLE_SPECIES]);
    // Why a chunk's cover reads the whole columns beside it. A thistle 3 m from its neighbours: the candidates
    // within that spacing past chunk (0, 0)'s border are 6 m to 7.5 m from the road's first strip, too near to
    // grow. Judged from a box that ends at the fields' own reach, before the strip, they are kept and outrank
    // neighbours inside the chunk: other points. The job's answer is the whole world's.
    const lone: VoxelCoverInput['table'] = { dressings: [{ dressingId: 'meadow', species: [{ model: 'thistle', class: 'cover', density: 1, spacing: 3, seed: 4, conditions: { sky: true, waterDepth: { max: 0 }, materialEdge: { min: 7.8 } } }] }], materials: [[GRASS, 0]] };
    const fields = surfaceFieldsInputOf(store, 0, 0, 0, 1).input;
    const places = (o: VoxelCoverOutput): string[] => pointsOf(o.sets[0]).map((p) => `${p.x},${p.y},${p.z}`).sort();
    const right = places(voxelCoverPoints({ fields, table: lone }));
    expect(right.length).toBeGreaterThan(8);
    expect(places(voxelCoverOfCells(box, [0, 0, 16, 16], lone))).toEqual(right);
    const short = places(voxelCoverOfCells(surfaceFieldsCells(fields, (b) => b), [0, 0, 16, 16], lone));
    expect(short).not.toEqual(right);
  });

  it('gives each point to the chunk that holds its surface\'s cell: the rows of a column part its points, a top face on the border staying with the cells under it', () => {
    for (const [cx, cz] of [[0, 1], [3, 2]] as const) {
      const all = cover(store, cx, cz);
      const low = cover(store, cx, cz, { rows: [0, 0] });
      const high = cover(store, cx, cz, { rows: [1, 1] });
      for (const s of all.sets) {
        const a = pointsOf(setOf(low, s.dressing, s.species));
        const b = pointsOf(setOf(high, s.dressing, s.species));
        expect(a.length + b.length, `${s.dressing}/${s.species}`).toBe(s.points.count);
        for (const p of a) expect(Math.ceil(p.y / M) - 1).toBeLessThan(E);
        for (const p of b) expect(Math.ceil(p.y / M) - 1).toBeGreaterThanOrEqual(E);
      }
    }
    // The hill: its top cells are row 31, the lower chunk's last, and their top face is at 16 m, the border itself.
    // The lichen on it is the lower chunk's, with the cave's moss; the upper chunk of that column grows nothing.
    const hill = cover(store, 0, 1);
    const lichen = pointsOf(setOf(hill, 'cave', 1));
    expect(lichen.length).toBeGreaterThan(40);
    for (const p of lichen) expect(p.y).toBe(E * M);
    expectSame(cover(store, 0, 1, { rows: [0, 0] }), hill, 'the hill, lower rows');
    expect(cover(store, 0, 1, { rows: [1, 1] }).sets).toEqual([]);
    // The house: the storey's boards are in the upper chunk, the meadow round it in the lower.
    const house = cover(store, 3, 2);
    const up = cover(store, 3, 2, { rows: [1, 1] });
    expect(up.sets.map((s) => s.dressing)).toEqual(['dust']);
    expect(pointsOf(setOf(up, 'dust', 0)).length).toBe(pointsOf(setOf(house, 'dust', 0)).length);
    expect(setOf(cover(store, 3, 2, { rows: [0, 0] }), 'dust', 0)).toBeUndefined();
    // A kept set keeps its order (by threshold) and its bounds are its own points'.
    const dust = setOf(up, 'dust', 0)!;
    expect([dust.points.low, dust.points.high]).toEqual([(HOUSE.storey + 1) * M, (HOUSE.storey + 1) * M]);
    const kept = pointsOf(dust);
    for (let i = 1; i < kept.length; i++) expect(kept[i]!.threshold).toBeGreaterThanOrEqual(kept[i - 1]!.threshold);
  });

  it('leaves untouched chunks byte for byte after an edit elsewhere, and regrows only the edited ground', () => {
    const edited = world();
    for (const cy of [0, 1]) writeChunk(edited, 3, cy, 3, true);
    // Chunks whose reach does not hold the repaved square, one of them its diagonal neighbour.
    for (const [cx, cz] of [[0, 0], [1, 1], [2, 2], [3, 1], [1, 3]] as const) expectSame(cover(edited, cx, cz), cover(store, cx, cz), `untouched ${cx},${cz}`);
    const before = pointsOf(setOf(cover(store, 3, 3), 'meadow-sparse', 0));
    const after = pointsOf(setOf(cover(edited, 3, 3), 'meadow-sparse', 0));
    const inSquare = (p: CoverPoint): boolean => p.x / M > PAVED.x0 + 0.02 && p.x / M < PAVED.x1 - 0.02 && p.z / M > PAVED.z0 + 0.02 && p.z / M < PAVED.z1 - 0.02;
    expect(before.filter(inSquare).length).toBeGreaterThan(8);
    expect(after.filter(inSquare)).toEqual([]);
    // Outside the square every plant is where it was, with the threshold, turn and size it had.
    const key = (p: CoverPoint): string => [p.x, p.y, p.z, p.threshold, p.yaw, p.scale].join(',');
    const kept = new Set(after.map(key));
    for (const p of before) if (!(p.x / M >= PAVED.x0 - 0.02 && p.x / M <= PAVED.x1 + 0.02 && p.z / M >= PAVED.z0 - 0.02 && p.z / M <= PAVED.z1 + 0.02)) expect(kept.has(key(p)), key(p)).toBe(true);
    expect(after.length).toBeLessThan(before.length);
  });
});

describe('ground cover from the voxel source: page and worker alike', () => {
  it('gives the same bytes from a real worker as from the same job in this thread: the cave\'s, the pond\'s and the house\'s chunks, a row range and a prop', { timeout: 120_000 }, async () => {
    const cart: PropShape = { inside: () => true, min: [-1.5, 0, -1], max: [1.5, 1.6, 1], position: [8, 4.2, 8], yaw: [1, 0], scale: 1 };
    const cases: Array<[number, number, Partial<VoxelCoverInput>]> = [[0, 1, {}], [2, 0, {}], [3, 2, {}], [3, 2, { rows: [1, 1] }], [0, 0, { clear: propClearances([cart]) }]];
    for (const [cx, cz, extra] of cases) {
      const here = cover(store, cx, cz, extra);
      expect(here.sets.length, `${cx},${cz}`).toBeGreaterThan(0);
      // Sent as a pool job: the chunks' payloads handed over, the table and the boxes as plain data.
      const { input: fields, transfer } = surfaceFieldsInputOf(store, cx, cz, 0, 1);
      const input: VoxelCoverInput = { fields, table: TABLE, ...extra };
      const o = await pool.submit<VoxelCoverOutput>({ id: ++jobId, kind: VOXEL_COVER_JOB, lane: 'edit', distance: 0, input, transfer });
      expect(o.status, `${cx},${cz}`).toBe('done');
      if (o.status !== 'done') continue;
      expectSame(o.output, here, `worker ${cx},${cz} ${JSON.stringify(Object.keys(extra))}`);
    }
  });

  it('a browser build of a worker that serves the cover job holds no Node built-in and passes the export scan', async () => {
    const built = await esbuild.build({
      stdin: { contents: "import { serveJobs } from '@thirdlight/voxel';\nimport { voxelCoverJobHandlers } from '@thirdlight/project-model';\nserveJobs(self, voxelCoverJobHandlers({ decompress: (b) => b }));\n", resolveDir: join(REPO, 'tools', 'voxel-bench'), loader: 'ts' },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      minify: true,
      write: false,
      logLevel: 'warning',
    });
    const bytes = built.outputFiles[0]!.contents;
    const scan = scanExportFiles([{ name: 'voxel-cover-worker.js', bytes }], { authoringOrigin: '', previewOrigin: '', tokenValues: [] }, 'js/main.js', { version: '', integrity: null }, null);
    expect(scan.hits).toEqual([]);
    expect(scan.ok).toBe(true);
    process.stderr.write(`voxel cover bench: a worker serving the cover job alone is ${bytes.length} bytes minified\n`);
  });
});
