/**
 * The Basic Kit's starter dressings (Meadow, Shore, Gravel), read from the
 * pack as a project receives them: valid and canonical in format 1, cover
 * only, naming the kit's own plants and no voxel material id (a kit cannot
 * know a project's ids: a species grows on whatever material names its
 * dressing), and growing what their names say on made ground through the
 * real cover source.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalDressing, coverPointAt, dressingModels, validateDressing, voxelCoverOfCells, voxelCoverTable, type DressingDef, type MaterialDef } from '@thirdlight/project-model';
import { DRESSING_CONDITIONS, recordValue, SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M, type SurfaceCells } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PACK = JSON.parse(readFileSync(join(REPO, 'packs', 'basic-kit', 'pack.json'), 'utf8')) as { assets: { assetId: string; kind: string }[]; commands: { op: string; args: Record<string, unknown> }[] };
const DRESSINGS = PACK.commands.filter((c) => c.op === 'setDressing').map((c) => c.args['dressing'] as DressingDef);
const PLANTS = ['basic-grass', 'basic-flower', 'basic-reed', 'basic-pebbles'];

const GRASS = 3;
const SAND = 4;
const GRAVEL = 6;
const ROAD = 9;
const material = (id: number, name: string, dressing?: string): MaterialDef => ({ materialId: name, name, shader: 'standard', params: {}, textures: {}, voxel: { id, use: 'terrain', ...(dressing !== undefined ? { dressing } : {}) } });
const TABLE = voxelCoverTable({ materials: [material(GRASS, 'grass', 'basic-meadow'), material(SAND, 'sand', 'basic-shore'), material(GRAVEL, 'gravel', 'basic-gravel'), material(ROAD, 'road')], dressings: DRESSINGS });

/** 32 m of ground, 4 rows deep (its top at 2 m), each column's material and water depth (cells) from `at`. */
function ground(at: (x: number, z: number) => { material: number; water?: number }): SurfaceCells {
  const side = 64;
  const sy = 12;
  const values = new Uint32Array(side * sy * side);
  for (let x = 0; x < side; x++) for (let z = 0; z < side; z++) {
    const c = at(x, z);
    const top = 4 - (c.water ?? 0);
    for (let y = 0; y < sy; y++) values[(x * side + z) * sy + y] = y < top ? recordValue(c.material, VOXEL_ROLE.terrain, SHAPE_FULL, 0) : y < 4 ? recordValue(900, VOXEL_ROLE.liquid, SHAPE_FULL, 0) : 0;
  }
  return { sx: side, sy, sz: side, ox: 0, oy: 0, oz: 0, cellM: VOXEL_SIZE_M, values };
}

/** Every point grown on `cells` over its middle 16 m, as the model it places and the cell column it stands in. */
function grown(cells: SurfaceCells): { dressing: string; model: string; x: number; z: number }[] {
  const out: { dressing: string; model: string; x: number; z: number }[] = [];
  for (const set of voxelCoverOfCells(cells, [8, 8, 24, 24], TABLE).sets) {
    const model = DRESSINGS.find((d) => d.dressingId === set.dressing)!.species[set.species]!.model;
    for (let i = 0; i < set.points.count; i++) {
      const p = coverPointAt(set.points, i);
      out.push({ dressing: set.dressing, model, x: Math.floor(p.x / VOXEL_SIZE_M), z: Math.floor(p.z / VOXEL_SIZE_M) });
    }
  }
  return out;
}
const count = (list: { model: string }[], model: string): number => list.filter((p) => p.model === model).length;

describe("the Basic Kit's starter dressings", () => {
  it("are three: valid, canonical, cover only, naming the kit's plants and no voxel material id", () => {
    expect(DRESSINGS.map((d) => [d.dressingId, d.name])).toEqual([['basic-meadow', 'Meadow'], ['basic-shore', 'Shore'], ['basic-gravel', 'Gravel']]);
    for (const d of DRESSINGS) {
      const errors: unknown[] = [];
      validateDressing(d, '/dressing', errors as never);
      expect(errors, d.dressingId).toEqual([]);
      expect(canonicalDressing(d), d.dressingId).toEqual(d);
      for (const model of dressingModels(d)) expect(PLANTS as readonly string[], d.dressingId).toContain(model);
      for (const s of d.species) {
        expect(s.class).toBe('cover');
        // A kit cannot know a project's voxel ids: a species grows on whatever material names its dressing.
        expect(s.conditions?.material, `${d.dressingId} ${s.model}`).toBeUndefined();
        for (const k of Object.keys(s.conditions ?? {})) expect(DRESSING_CONDITIONS as readonly string[]).toContain(k);
      }
    }
    const meadow = DRESSINGS[0]!;
    // Grass and flowers on dry ground under open sky; the flower twice (patches, and a verge); reeds in the shallows only.
    expect(meadow.species.map((s) => s.model)).toEqual(['basic-grass', 'basic-flower', 'basic-flower', 'basic-reed']);
    expect(meadow.species[0]!.conditions).toMatchObject({ sky: true, waterDepth: { max: 0 } });
    expect(meadow.species[1]!.conditions!.noise).toBeDefined();
    expect(meadow.species[2]!.conditions!.materialEdge).toBeDefined();
    for (const d of DRESSINGS) for (const s of d.species) if (s.model === 'basic-reed') expect(s.conditions!.waterDepth, d.dressingId).toEqual({ min: 0.05, max: 0.7 });
  });

  it('Meadow: grass over dry open ground, flowers in patches and at a path\'s verge, reeds in shallow water only', () => {
    // A meadow with a road strip (x 30–33) and a pond one cell deep (x 40–47, z 20–40).
    const pond = (x: number, z: number): boolean => x >= 40 && x < 48 && z >= 20 && z < 40;
    const road = (x: number): boolean => x >= 30 && x < 34;
    const pts = grown(ground((x, z) => (road(x) ? { material: ROAD } : { material: GRASS, ...(pond(x, z) ? { water: 1 } : {}) })));
    expect(new Set(pts.map((p) => p.dressing))).toEqual(new Set(['basic-meadow']));
    // 16 m × 16 m less the road and the pond, at 7 a square metre.
    expect(count(pts, 'basic-grass')).toBeGreaterThan(1000);
    expect(count(pts, 'basic-flower')).toBeGreaterThan(20);
    expect(count(pts, 'basic-reed')).toBeGreaterThan(20);
    expect(count(pts, 'basic-pebbles')).toBe(0);
    for (const p of pts) {
      expect(road(p.x), `${p.model} on the road`).toBe(false);
      expect(pond(p.x, p.z), `${p.model} at ${p.x}, ${p.z}`).toBe(p.model === 'basic-reed');
    }
    // Flowers stand thicker within 1.5 m of the road than out in the field (the verge entry adds to the patches).
    const flowers = pts.filter((p) => p.model === 'basic-flower' && !pond(p.x, p.z));
    const near = flowers.filter((p) => p.x >= 27 && p.x < 37).length / (2 * 3 * 32);
    const far = flowers.filter((p) => p.x < 24).length / (8 * 32);
    expect(near).toBeGreaterThan(far * 1.5);
    // Out in the field they are in patches: some 4 m squares hold several, some none.
    const squares = new Map<string, number>();
    for (let x = 16; x < 24; x += 8) for (let z = 16; z < 48; z += 8) squares.set(`${x},${z}`, 0);
    for (const p of flowers) {
      const k = `${Math.floor(p.x / 8) * 8},${Math.floor(p.z / 8) * 8}`;
      if (squares.has(k)) squares.set(k, squares.get(k)! + 1);
    }
    expect(Math.max(...squares.values())).toBeGreaterThan(2);
  });

  it('Shore: reeds in the shallows and none in deep water, pebbles at the waterline, thin grass on the dry bank', () => {
    // A bank falling away along x: dry to x = 31, one cell (0.5 m) deep to 39, two cells deep beyond.
    const depth = (x: number): number => (x < 32 ? 0 : x < 40 ? 1 : 2);
    const pts = grown(ground((x) => ({ material: SAND, water: depth(x) })));
    expect(new Set(pts.map((p) => p.dressing))).toEqual(new Set(['basic-shore']));
    expect(count(pts, 'basic-reed')).toBeGreaterThan(40);
    for (const p of pts) {
      if (p.model === 'basic-reed') expect(depth(p.x), `a reed at depth ${depth(p.x)}`).toBe(1);
      if (p.model === 'basic-grass' || p.model === 'basic-pebbles') expect(depth(p.x), p.model).toBe(0);
    }
    expect(count(pts, 'basic-pebbles')).toBeGreaterThan(5);
    expect(count(pts, 'basic-grass')).toBeGreaterThan(5);
    // Far thinner than a meadow's.
    expect(count(pts, 'basic-grass')).toBeLessThan(16 * 16 * 1.5);
  });

  it('Gravel: pebbles in patches, grass only at its edge', () => {
    // A gravel yard (x 16–47) in a meadow.
    const yard = (x: number): boolean => x >= 16 && x < 48;
    const pts = grown(ground((x) => ({ material: yard(x) ? GRAVEL : GRASS }))).filter((p) => p.dressing === 'basic-gravel');
    expect(count(pts, 'basic-pebbles')).toBeGreaterThan(100);
    expect(count(pts, 'basic-pebbles')).toBeLessThan(16 * 16 * 3);
    const tufts = pts.filter((p) => p.model === 'basic-grass');
    expect(tufts.length).toBeGreaterThan(5);
    // Within a metre (two cells) of the yard's edge, never out in its middle.
    for (const p of tufts) expect(Math.min(p.x - 16, 47 - p.x), `a tuft at x ${p.x}`).toBeLessThanOrEqual(2);
    for (const p of pts) expect(yard(p.x)).toBe(true);
  });
});
