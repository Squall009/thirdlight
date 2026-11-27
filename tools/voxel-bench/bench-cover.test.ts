/**
 * The bench cover on the town's own ground (the generated town, shifted as the 8 km world holds it): its strokes
 * are commands the format takes and its dressings records the model takes; with them the cover job grows grass on
 * the empty lots and none on the road, flowers along the road's verge, pebbles on its shoulder, reeds in the pond's
 * raised shallows and none in its open middle, and nothing inside a house; its cameras stand in clear air and are
 * in the picture list; placing and taking out go through the commands in the order the undo needs. One line says
 * what the cover job costs a chunk column of the town.
 */
import { applyEdit, canonicalEditCommand, chunkGrid, createWorldStore, surfaceFieldsInputOf, VOXEL_ROLE, VOXEL_SIZE_M, type PaletteStore } from '@thirdlight/voxel';
import { canonicalDressings, coverPointAt, validateDressings, voxelCoverPoints, voxelCoverTable, type CoverPoint, type VoxelCoverOutput } from '@thirdlight/project-model';
import { describe, expect, it } from 'vitest';

import { BENCH_COVER_FOLDER, BENCH_COVER_MODELS, BENCH_MEADOW_DRESSING, BENCH_ROAD_DRESSING, benchCoverDressings, coverRoadStroke, coverShelfStroke, placeBenchCover } from './bench-cover';
import { FAR_TOWN_SHIFT_CELLS } from './far-world';
import { BENCH_COVER, LIGHT_CHECK_CAMERAS } from './lighting-cameras';
import { PICTURE_RUNS, PICTURES } from './picture-list';
import { LOT, lotOf, TOWN_SEED, townWorld } from './town';
import { loadAreaCached } from './world-cache';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const M = VOXEL_SIZE_M;
const SHIFT = FAR_TOWN_SHIFT_CELLS / grid.edge;
const MODELS = { grass: 'm-grass', flower: 'm-flower', reed: 'm-reed', pebble: 'm-pebble' };
const DRESSINGS = benchCoverDressings(MODELS);
const material = (materialId: string, id: number, dressing?: string): Record<string, unknown> => ({ materialId, name: materialId, shader: 'standard', params: {}, textures: {}, voxel: { id, use: 'terrain', ...(dressing !== undefined ? { dressing } : {}) } });
const TABLE = voxelCoverTable({ materials: [material('voxel-grass', MAT.grass, BENCH_MEADOW_DRESSING), material('voxel-gravel', MAT.gravel, BENCH_ROAD_DRESSING), material('voxel-soil', MAT.soil)] as never, dressings: DRESSINGS });

/** The town's chunks over chunk columns [cx0, cx1] × [cz0, cz1] of the 8 km world's frame (the town's middle at its origin), with the bench's strokes. */
function town(cx0: number, cz0: number, cx1: number, cz1: number): PaletteStore {
  const read = createWorldStore(grid);
  const e = grid.edge;
  loadAreaCached(townWorld().grids[0]!, read, (cx0 + SHIFT) * e, (cz0 + SHIFT) * e, (cx1 + SHIFT + 1) * e, (cz1 + SHIFT + 1) * e);
  const s = createWorldStore(grid);
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) for (let cy = -4; cy <= 1; cy++) {
    const p = read.chunkPayload(cx + SHIFT, cy, cz + SHIFT, true);
    if (p.form !== 'air') s.adoptPayload(cx, cy, cz, p);
  }
  return s;
}

const cover = (s: PaletteStore, cx: number, cz: number): VoxelCoverOutput => voxelCoverPoints({ fields: surfaceFieldsInputOf(s, cx, cz, -1, 1).input, table: TABLE });
const points = (out: VoxelCoverOutput, dressing: string, species: number): CoverPoint[] => {
  const set = out.sets.find((x) => x.dressing === dressing && x.species === species);
  return set === undefined ? [] : Array.from({ length: set.points.count }, (_, i) => coverPointAt(set.points, i));
};

describe('the bench cover', () => {
  it('stands on lots of the town that hold nothing in the world grid, and at a pond', () => {
    for (const [i, j] of [[2, 6], [3, 6], [3, 5]] as const) {
      const lot = lotOf(i, j, TOWN_SEED);
      expect([lot.yaw !== 0, lot.pond, lot.fence], `lot ${i},${j}`).toEqual([true, false, false]);
    }
    expect(lotOf(6, 4, TOWN_SEED).pond).toBe(true);
    // The road lies inside lots (2, 6) and (3, 6); the pond's middle is lot (6, 4)'s.
    const x0 = (2 * LOT - FAR_TOWN_SHIFT_CELLS) * M;
    const z0 = (6 * LOT - FAR_TOWN_SHIFT_CELLS) * M;
    const r = BENCH_COVER.road;
    expect(r.x0 >= x0 + 1 && r.x1 <= x0 + 40 - 1 && r.z0 >= z0 + 1 && r.z1 <= z0 + 20 - 1).toBe(true);
    expect([BENCH_COVER.pond.x, BENCH_COVER.pond.z]).toEqual([(6 * LOT - FAR_TOWN_SHIFT_CELLS + LOT / 2 - 0.5) * M, (4 * LOT - FAR_TOWN_SHIFT_CELLS + LOT / 2 - 0.5) * M]);
  });

  it('names dressings the model takes, and models of the triangle counts it says', () => {
    const errors: unknown[] = [];
    validateDressings(DRESSINGS, '/dressings', errors as never);
    expect(errors).toEqual([]);
    expect(canonicalDressings(DRESSINGS)).toEqual(DRESSINGS);
    for (const [name, m] of Object.entries(BENCH_COVER_MODELS)) {
      const glb = m.glb();
      const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as { meshes: { primitives: { indices: number }[] }[]; accessors: { count: number }[] };
      expect(json.meshes.length, name).toBe(1);
      expect(json.accessors[json.meshes[0]!.primitives[0]!.indices]!.count / 3, name).toBe(m.triangles);
      expect(glb.length, name).toBeLessThan(8192);
    }
  });

  it('grows a meadow with a road through it: no grass on the gravel, flowers at its verge alone, pebbles on its shoulder, nothing inside a house', () => {
    const s = town(-7, -3, -2, 1);
    const road = canonicalEditCommand(coverRoadStroke() as never);
    const painted = applyEdit({ store: () => s }, road);
    const r = BENCH_COVER.road;
    expect(painted.cells).toBe(((r.x1 - r.x0) / M) * ((r.z1 - r.z0) / M));
    // The paint keeps the ground: its cells are gravel ground, as full as they were.
    const v = { material: 0, role: 0, shape: 0, wetness: 0 };
    expect({ ...s.voxelAt(-140, -1, 0, v) }).toEqual({ material: MAT.gravel, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 });
    // Chunk column (-5, 0) holds the road's middle: x -80 … -64 m, z 0 … 16 m; (-5, -1) its other half.
    const onRoad = (p: CoverPoint): boolean => p.x > r.x0 && p.x < r.x1 && p.z > r.z0 + 0.01 && p.z < r.z1 - 0.01;
    let grass = 0;
    let flowers = 0;
    let pebbles = 0;
    for (const cz of [-1, 0]) {
      const out = cover(s, -5, cz);
      const g = points(out, BENCH_MEADOW_DRESSING, 0);
      grass += g.length;
      expect(g.filter(onRoad)).toEqual([]);
      for (const p of g) expect(p.y).toBeCloseTo(0, 5);
      const f = points(out, BENCH_MEADOW_DRESSING, 1);
      flowers += f.length;
      // Within 1.5 m of the road's edge (the lots hold no other material), never on it.
      for (const p of f) expect(p.z > r.z0 - 1.6 && p.z < r.z1 + 1.6 && !onRoad(p), `${p.x},${p.z}`).toBe(true);
      const pb = points(out, BENCH_ROAD_DRESSING, 0);
      pebbles += pb.length;
      for (const p of pb) expect(onRoad(p) && (p.z < r.z0 + 0.8 || p.z > r.z1 - 0.8), `${p.x},${p.z}`).toBe(true);
      expect(points(out, BENCH_MEADOW_DRESSING, 2)).toEqual([]);
    }
    // About six clumps a square metre over the two columns' meadow (512 m² less the road's 32).
    expect(grass / 480).toBeGreaterThan(5);
    expect(grass / 480).toBeLessThan(6.5);
    expect(flowers).toBeGreaterThan(40);
    expect(pebbles).toBeGreaterThan(60);
    // A house of the world grid (lot (4, 6), east of the empty lots): no plant on its floor or under its roof.
    const lot = lotOf(4, 6, TOWN_SEED);
    expect(lot.house !== null && lot.yaw === 0).toBe(true);
    const hx0 = (4 * LOT - FAR_TOWN_SHIFT_CELLS + 6) * M;
    const hz0 = (6 * LOT - FAR_TOWN_SHIFT_CELLS + 8) * M;
    const inHouse = (p: CoverPoint): boolean => p.x > hx0 + 0.5 && p.x < hx0 + lot.house!.w * M - 0.5 && p.z > hz0 + 0.5 && p.z < hz0 + lot.house!.d * M - 0.5;
    let beside = 0;
    for (const [cx, cz] of [[-3, -1], [-3, 0], [-2, -1], [-2, 0]] as const) {
      const all = cover(s, cx, cz).sets.flatMap((x) => Array.from({ length: x.points.count }, (_, i) => coverPointAt(x.points, i)));
      expect(all.filter(inHouse), `house in ${cx},${cz}`).toEqual([]);
      beside += all.length;
    }
    expect(beside).toBeGreaterThan(1000);
  });

  it('raises a shelf under the pond\'s rim: reeds stand in its shallow water, none in the open middle or on dry ground, no grass under water', () => {
    const s = town(-2, -4, 1, -1);
    const p = BENCH_COVER.pond;
    const before = cover(s, 0, -3);
    // The pond as generated is as deep at its rim as in its middle: no shallows, no reeds.
    expect([0, -1].flatMap((cx) => [-3, -2].flatMap((cz) => points(cover(s, cx, cz), BENCH_MEADOW_DRESSING, 2)))).toEqual([]);
    const shelf = applyEdit({ store: () => s }, canonicalEditCommand(coverShelfStroke() as never));
    expect(shelf.cells).toBeGreaterThan(200);
    const reeds: CoverPoint[] = [];
    const grass: CoverPoint[] = [];
    for (const cx of [-1, 0]) for (const cz of [-3, -2]) {
      const out = cover(s, cx, cz);
      reeds.push(...points(out, BENCH_MEADOW_DRESSING, 2));
      grass.push(...points(out, BENCH_MEADOW_DRESSING, 0));
    }
    const off = (q: CoverPoint): number => Math.hypot(q.x - p.x, q.z - p.z) / M;
    expect(reeds.length).toBeGreaterThan(60);
    for (const q of reeds) {
      // On the shelf (its top a cell under the water's top row), inside the rim and outside the open middle.
      expect(off(q) > p.open - 1 && off(q) < p.radius + 1, `reed ${off(q)}`).toBe(true);
      expect(q.y).toBeCloseTo(-0.5, 5);
    }
    expect(grass.filter((q) => off(q) < p.radius - 0.5)).toEqual([]);
    expect(grass.filter((q) => off(q) > p.radius + 2.5 && off(q) < p.radius + 8).length).toBeGreaterThan(100);
    expect(points(before, BENCH_MEADOW_DRESSING, 0).length).toBeGreaterThan(0);
  });

  it('puts its cameras in clear air over what they show, in a picture run of their own', () => {
    const s = town(-7, -3, -2, 1);
    const pond = town(-2, -4, 1, -1);
    const v = { material: 0, role: 0, shape: 0, wetness: 0 };
    for (const [name, store] of [['cover-meadow', s], ['cover-reeds', pond]] as const) {
      const cam = LIGHT_CHECK_CAMERAS.find((c) => c.name === name)!;
      expect(cam, name).toBeDefined();
      const [x, y, z] = cam.eye.map((m) => Math.floor(m / M)) as [number, number, number];
      for (let dy = -1; dy <= 1; dy++) expect(store.voxelAt(x, y + dy, z, v).material, `${name} eye`).toBe(0);
      expect(y * M).toBeGreaterThan(1.5);
    }
    const ids = PICTURES.filter((q) => q.kind === 'world' && q.run === 'cover').map((q) => [q.id, q.kind === 'world' ? q.camera : '']);
    expect(ids).toEqual([['L25', 'cover-meadow'], ['L26', 'cover-reeds']]);
    expect(PICTURE_RUNS.cover).toEqual([]);
  });

  it('is placed through the commands and taken out in the order the undo needs: strokes first, then the materials, the dressings, the models', async () => {
    const dir = `${process.env['TMPDIR'] ?? '.'}/bench-cover-test-${process.pid}`;
    const { mkdirSync, writeFileSync, rmSync, existsSync } = await import('node:fs');
    mkdirSync(`${dir}/assets/materials`, { recursive: true });
    for (const [id, vid] of [['voxel-grass', MAT.grass], ['voxel-gravel', MAT.gravel]] as const) writeFileSync(`${dir}/assets/materials/${id}.material.json`, JSON.stringify({ data: material(id, vid) }));
    const calls: string[] = [];
    let imported = false;
    const api = {
      projectDir: dir,
      command: (op: string, args: Record<string, unknown>) => {
        const m = args['material'] as { materialId: string; voxel: { dressing?: string } } | undefined;
        calls.push(op === 'setMaterial' ? `setMaterial ${m!.materialId} ${m!.voxel.dressing ?? '-'}` : op === 'setDressing' ? `setDressing ${(args['dressing'] as { dressingId: string }).dressingId}` : op === 'deleteDressing' ? `deleteDressing ${String(args['dressingId'])}` : op === 'deleteAsset' ? `deleteAsset ${String(args['assetId'])}` : op);
        if (op === 'importAssets') imported = existsSync(`${dir}/${BENCH_COVER_FOLDER}/${BENCH_COVER_MODELS.reed.file}`);
        return Promise.resolve();
      },
      raw: (op: string, args: Record<string, unknown>) => {
        calls.push(op === 'editVoxels' ? `stroke ${String((args['command'] as { kind: string }).kind)}` : op);
        // The shelf is there already (a run before left it): only the road is this run's to undo.
        if (op === 'editVoxels' && (args['command'] as { kind: string }).kind === 'set') return Promise.resolve({ ok: false, error: { code: 'no_change' } });
        return Promise.resolve(op === 'undo' ? { ok: true, voxels: { ok: true, cells: 5 } } : { ok: true, cells: 5, parts: 16 });
      },
      assets: () => Promise.resolve(Object.entries(BENCH_COVER_MODELS).map(([name, m]) => ({ assetId: `a-${name}`, sourcePath: `${BENCH_COVER_FOLDER}/${m.file}` }))),
    };
    const placed = await placeBenchCover(api, 'far', () => undefined);
    expect(imported).toBe(true);
    expect(calls).toEqual(['importAssets', `setDressing ${BENCH_MEADOW_DRESSING}`, `setDressing ${BENCH_ROAD_DRESSING}`, `setMaterial voxel-grass ${BENCH_MEADOW_DRESSING}`, `setMaterial voxel-gravel ${BENCH_ROAD_DRESSING}`, 'stroke fill', 'stroke set']);
    expect((placed.facts['models'] as Record<string, { assetId: string }>)['reed']!.assetId).toBe('a-reed');
    calls.length = 0;
    await placed.undo();
    expect(calls).toEqual(['undo', 'setMaterial voxel-grass -', 'setMaterial voxel-gravel -', `deleteDressing ${BENCH_MEADOW_DRESSING}`, `deleteDressing ${BENCH_ROAD_DRESSING}`, 'deleteAsset a-grass', 'deleteAsset a-flower', 'deleteAsset a-reed', 'deleteAsset a-pebble']);
    expect(existsSync(`${dir}/${BENCH_COVER_FOLDER}`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports what the cover job costs a chunk column of the town (a line, never a bound)', () => {
    const s = town(-7, -3, -2, 1);
    applyEdit({ store: () => s }, canonicalEditCommand(coverRoadStroke() as never));
    const ms: number[] = [];
    let n = 0;
    for (let round = 0; round < 2; round++) for (const [cx, cz] of [[-5, 0], [-5, -1], [-4, -1], [-3, 0]] as const) {
      const t0 = performance.now();
      const out = cover(s, cx, cz);
      ms.push(performance.now() - t0);
      n = out.sets.reduce((k, x) => k + x.points.count, 0);
      expect(n).toBeGreaterThan(0);
    }
    ms.sort((a, b) => a - b);
    process.stderr.write(`voxel cover bench: the bench meadow on the town, a chunk column in this thread: ms p50 ${ms[ms.length >> 1]!.toFixed(1)} min ${ms[0]!.toFixed(1)} max ${ms[ms.length - 1]!.toFixed(1)} (${n} points in the last)\n`);
  });
});
