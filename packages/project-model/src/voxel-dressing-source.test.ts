/**
 * The voxel source of the rule scatter core on made boxes of cells: the
 * surface it gives the core (every floor of a column in turn, its height
 * and normal, whether a species grows), the share of a species kept where
 * its conditions hold in part, and the copies' sizes, turns and lean as the
 * ground-cover path decodes them.
 */
import { describe, expect, it } from 'vitest';
import { dressingRule, recordValue, SHAPE_FULL, VOXEL_ROLE, type SurfaceCells } from '@thirdlight/voxel';

import { coverPointAt, coverPointCopy, type CoverPoint } from './cover-points';
import type { DressingSpecies } from './dressing';
import { scatterRuleSeed, type ScatterRect } from './scatter';
import { voxelCoverOfCells, voxelScatterSurface, voxelSurfaceReader, type VoxelCoverOutput, type VoxelCoverTable } from './voxel-dressing-source';

const R = VOXEL_ROLE;
const GRASS = 3;
const ROAD = 6;
const STONE = 5;
const M = 0.5;

/** A box of cells whose lowest cell is the grid's (ox, 0, oz). */
function box(sx: number, sy: number, sz: number, cell: (x: number, y: number, z: number) => number, ox = 0, oz = 0): SurfaceCells {
  const values = new Uint32Array(sx * sy * sz);
  for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) values[(x * sz + z) * sy + y] = cell(x, y, z);
  return { sx, sy, sz, ox, oy: 0, oz, cellM: M, values, built: null };
}
const ground = (material: number, shape = SHAPE_FULL): number => recordValue(material, R.terrain, shape, 0);

/** Ground of `material(x, z)` filled to `height(x, z)` cells (a fraction: the top cell's fill). */
function terrain(sx: number, sy: number, sz: number, height: (x: number, z: number) => number, material: (x: number, z: number) => number = () => GRASS): SurfaceCells {
  return box(sx, sy, sz, (x, y, z) => {
    const h = height(x, z);
    const whole = Math.floor(h + 1e-9);
    if (y < whole) return ground(material(x, z));
    const part = Math.round((h - whole) * SHAPE_FULL);
    return y === whole && part > 0 ? ground(material(x, z), part) : 0;
  });
}

const table = (species: DressingSpecies[], materials: number[] = [GRASS]): VoxelCoverTable => ({ dressings: [{ dressingId: 'd', species }], materials: materials.map((m) => [m, 0] as const) });
const pointsOf = (out: VoxelCoverOutput, species: number): CoverPoint[] => {
  const set = out.sets.find((s) => s.species === species);
  return set === undefined ? [] : Array.from({ length: set.points.count }, (_, i) => coverPointAt(set.points, i));
};
/** The middle 16 m of a 32 m box: every candidate has the box round it. */
const MIDDLE: ScatterRect = [8, 8, 24, 24];

describe('the voxel scatter surface', () => {
  it('answers every floor of a column from the top down, each at its own height, and null past the box', () => {
    // A hill of stone with a hollow: three surfaces in the middle columns (the top, a ledge's floor, the cave's floor).
    const cells = box(8, 24, 8, (x, y, z) => {
      const inner = x >= 2 && x < 6 && z >= 2 && z < 6;
      if (y < 4) return ground(STONE);
      if (y < 9) return inner ? 0 : ground(STONE);
      if (y === 9) return ground(STONE, 6);
      if (y < 14) return inner ? 0 : ground(STONE);
      return y < 20 ? ground(STONE) : 0;
    });
    const surface = voxelScatterSurface(voxelSurfaceReader(cells), { rule: dressingRule(undefined), seed: 1, grows: () => true });
    const at = surface.at(1.6, 1.7)!;
    expect([at.x, at.y, at.z]).toEqual([1.6, 10, 1.7]);
    expect(at.layer(0)).toBe(1);
    const ledge = surface.under!(1.6, 1.7, 10)!;
    expect(ledge.y).toBeCloseTo((9 + 6 / 15) * M, 9);
    const floor = surface.under!(1.6, 1.7, ledge.y)!;
    expect(floor.y).toBe(2);
    expect(surface.under!(1.6, 1.7, 2)).toBeNull();
    // Outside the hollow the column has one surface.
    expect(surface.at(0.2, 0.2)!.y).toBe(10);
    expect(surface.under!(0.2, 0.2, 10)).toBeNull();
    expect(surface.at(-0.1, 1)).toBeNull();
    expect(surface.at(1, 4.01)).toBeNull();
  });

  it('says through the core\'s layer share whether the species grows there: not on another material, not where its conditions fail', () => {
    const cells = terrain(16, 12, 16, () => 4, (x) => (x < 8 ? GRASS : ROAD));
    const reader = voxelSurfaceReader(cells);
    const grass = voxelScatterSurface(reader, { rule: dressingRule({ sky: true }), seed: 1, grows: (m) => m === GRASS });
    expect(grass.at(2, 2)!.layer(0)).toBe(1);
    expect(grass.at(6, 2)!.layer(0)).toBe(0);
    // The ground is still answered where nothing grows (its floor counts in the column), level and at its height.
    const off = grass.at(6, 2)!;
    expect([off.y, off.ny]).toEqual([2, 1]);
    const never = voxelScatterSurface(reader, { rule: dressingRule({ sky: false }), seed: 1, grows: (m) => m === GRASS });
    expect(never.at(2, 2)!.layer(0)).toBe(0);
    // Only layer 0 carries the answer.
    expect(grass.at(2, 2)!.layer(1)).toBe(0);
  });

  it('gives the ground\'s normal with the slope the fields read', () => {
    // Rising a cell a column along x: 45 degrees.
    const cells = terrain(16, 24, 8, (x) => 2 + x);
    const g = voxelScatterSurface(voxelSurfaceReader(cells), { rule: dressingRule(undefined), seed: 1, grows: () => true }).at(4.2, 2.2)!;
    expect(g.slope).toBeCloseTo(45, 6);
    expect(g.nx).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(g.ny).toBeCloseTo(Math.SQRT1_2, 9);
    expect(g.nz).toBeCloseTo(0, 9);
  });
});

describe('a chunk\'s cover from a box of cells', () => {
  const flat = terrain(64, 12, 64, () => 4);

  it('places a species at its density, sized, turned and leaned within its ranges, every point on the ground', () => {
    const grass: DressingSpecies = { model: 'grass', class: 'cover', density: 4, scale: [0.6, 1.4], yaw: 90, align: 1 };
    const out = voxelCoverOfCells(flat, MIDDLE, table([grass]));
    expect(out.sets.map((s) => [s.dressing, s.species])).toEqual([['d', 0]]);
    const set = out.sets[0]!;
    // The core is handed the species as a plain ground cover rule: no condition of the source's own shows in it.
    expect(set.rule).toEqual({ id: 's0', asset: { assetId: 'grass' }, density: 4, scale: [0.6, 1.4], yaw: 90, align: 1, cover: true });
    // 16 m × 16 m at 4 a square metre, a candidate a grid cell: 1,024 of them, each kept.
    expect(set.points.count).toBe(1024);
    expect([set.points.x0, set.points.z0, set.points.w, set.points.d, set.points.low, set.points.high]).toEqual([8, 8, 16, 16, 2, 2]);
    const pts = pointsOf(out, 0);
    for (const p of pts) {
      expect(p.x >= 8 && p.x <= 24 && p.z >= 8 && p.z <= 24 && p.y === 2).toBe(true);
      const copy = coverPointCopy(p, set.rule);
      expect(copy.scale >= 0.6 && copy.scale <= 1.4).toBe(true);
      expect(p.normal[1]).toBeGreaterThan(0.999);
      // A quarter turn at most about up: the rotation's angle is under 90 degrees.
      expect(2 * Math.acos(Math.min(1, Math.abs(copy.rotation[3])))).toBeLessThanOrEqual(Math.PI / 2 + 1e-6);
    }
    // Sizes and turns spread over their ranges.
    const scales = pts.map((p) => coverPointCopy(p, set.rule).scale);
    expect(Math.min(...scales)).toBeLessThan(0.7);
    expect(Math.max(...scales)).toBeGreaterThan(1.3);
    // Sorted by threshold: a draw that thins reads a prefix.
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.threshold).toBeGreaterThanOrEqual(pts[i - 1]!.threshold);
  });

  it('holds a species\' spacing between its points, and an align of 1 leans a copy to a slope\'s normal', () => {
    const spaced: DressingSpecies = { model: 'flower', class: 'cover', density: 4, spacing: 1.5 };
    const pts = pointsOf(voxelCoverOfCells(flat, MIDDLE, table([spaced])), 0);
    expect(pts.length).toBeGreaterThan(20);
    expect(pts.length).toBeLessThan(1024 / 4);
    let nearest = Infinity;
    for (let i = 0; i < pts.length; i++) for (let k = i + 1; k < pts.length; k++) nearest = Math.min(nearest, Math.hypot(pts[i]!.x - pts[k]!.x, pts[i]!.z - pts[k]!.z));
    // Places are stored in steps of 16 m / 4,095.
    expect(nearest).toBeGreaterThan(1.5 - 0.01);
    const slope = terrain(64, 80, 64, (x) => 2 + x);
    const leaned = pointsOf(voxelCoverOfCells(slope, MIDDLE, table([{ model: 'fern', class: 'cover', density: 1, align: 1 }])), 0);
    expect(leaned.length).toBeGreaterThan(200);
    for (const p of leaned) {
      expect(p.normal[0]).toBeCloseTo(-Math.SQRT1_2, 1);
      expect(p.normal[1]).toBeCloseTo(Math.SQRT1_2, 1);
    }
  });

  it('keeps the share of candidates the conditions give, each picked by its own point: the kept ones are a subset of the full set', () => {
    // Flat ground at 2 m; a height range ending 1 m under it with a 2 m fade holds half everywhere.
    const full: DressingSpecies = { model: 'grass', class: 'cover', density: 4, seed: 9 };
    const half: DressingSpecies = { ...full, conditions: { height: { max: 1, fade: 2 } } };
    expect(dressingRule(half.conditions).conditions.height).toEqual({ max: 1, fade: 2 });
    const all = pointsOf(voxelCoverOfCells(flat, MIDDLE, table([full])), 0);
    const kept = pointsOf(voxelCoverOfCells(flat, MIDDLE, table([half])), 0);
    expect(all.length).toBe(1024);
    // Half of 1,024 picks: within six standard deviations (16) of 512.
    expect(kept.length).toBeGreaterThan(512 - 96);
    expect(kept.length).toBeLessThan(512 + 96);
    const key = (p: CoverPoint): string => `${p.x.toFixed(4)},${p.z.toFixed(4)}`;
    const places = new Set(all.map(key));
    for (const p of kept) expect(places.has(key(p))).toBe(true);
    // The same pick again; another seed picks other candidates.
    expect(pointsOf(voxelCoverOfCells(flat, MIDDLE, table([half])), 0).map(key)).toEqual(kept.map(key));
    expect(scatterRuleSeed({ id: 's0', seed: 9 })).not.toBe(scatterRuleSeed({ id: 's0', seed: 10 }));
    // A share of none grows nothing, and no set is made for it.
    expect(voxelCoverOfCells(flat, MIDDLE, table([{ ...full, conditions: { height: { max: -5 } } }])).sets).toEqual([]);
  });

  it('never places the large class: the entry is skipped where it stands in the list, and the same entry as cover is placed', () => {
    const tree: DressingSpecies = { model: 'oak', class: 'large', density: 0.05, spacing: 6 };
    const grass: DressingSpecies = { model: 'grass', class: 'cover', density: 2 };
    const out = voxelCoverOfCells(flat, MIDDLE, table([tree, grass, { ...tree, model: 'boulder' }]));
    // Only the cover entry, under its own place in the list (1), so its plants do not move when the large class is placed too.
    expect(out.sets.map((s) => [s.species, s.rule.asset.assetId, s.rule.id])).toEqual([[1, 'grass', 's1']]);
    expect(voxelCoverOfCells(flat, MIDDLE, table([tree])).sets).toEqual([]);
    const asCover = voxelCoverOfCells(flat, MIDDLE, table([{ ...tree, class: 'cover' }]));
    expect(asCover.sets.length).toBe(1);
    expect(asCover.sets[0]!.points.count).toBeGreaterThan(0);
  });

  it('grows nothing for a table with no dressing or no material, and nothing on a material that names none', () => {
    const grass: DressingSpecies = { model: 'grass', class: 'cover', density: 2 };
    expect(voxelCoverOfCells(flat, MIDDLE, { dressings: [], materials: [] }).sets).toEqual([]);
    expect(voxelCoverOfCells(flat, MIDDLE, table([grass], [])).sets).toEqual([]);
    expect(voxelCoverOfCells(flat, MIDDLE, table([grass], [ROAD])).sets).toEqual([]);
  });
});
