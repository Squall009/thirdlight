/**
 * The overrides' fit rule (absorbed, kept, misfit) on the building
 * generator, in the cases a designer meets. Each test states what the
 * approved rule does today, cell by cell; where a designer would call the
 * result wrong, the test says so and the plan's results carry the case.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid } from '../coords';
import { createDenseChunk } from '../dense-chunk';
import { canonicalEditCommand } from '../edit-command';
import { applyEdit } from '../edit-apply';
import { createWorldStore } from '../palette-store';
import { valueRole, VOXEL_ROLE, type VoxelRecord } from '../record';
import type { VoxelStoreCandidate } from '../store';
import type { StructureOverrides } from '../structure-overrides';
import { BUILDING_GENERATOR, canonicalStructureDefinition } from './building';
import type { StructureDefinition } from './definition';
import { boxChunks } from './generator';
import { captureOverrides, regenerateStructure, type RegenerateReport } from './regenerate';

const grid = chunkGrid(32);
const GRID_ID = 3;
const MAT = { wall: 10, floor: 14, roof: 13, foundation: 6, stair: 14 };
const R = VOXEL_ROLE;
type Pt = [number, number];
const rect = (id: string, x0: number, z0: number, x1: number, z1: number): { id: string; points: Pt[] } => ({ id, points: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] });

/** A 16 × 12-cell (8 × 6 m) two-storey house, gable along x, overhang 1: top of the walls at row 11, the roof from row 12. */
function house(over: Record<string, unknown> = {}): StructureDefinition {
  return canonicalStructureDefinition({ footprint: [rect('main', 0, 0, 16, 12)], storeys: 2, storeyHeight: 6, foundationDepth: 2, roof: { shape: 'gable', overhang: 1, axis: 'x' }, materials: MAT, openings: [], stairs: [], generator: 1, ...over });
}

function built(d: StructureDefinition): VoxelStoreCandidate {
  const s = createWorldStore(grid);
  const out = createDenseChunk(grid);
  for (const c of boxChunks(grid, BUILDING_GENERATOR.box(d))) if (BUILDING_GENERATOR.chunk(d, grid, c.cx, c.cy, c.cz, out)) s.importChunk(c.cx, c.cy, c.cz, out);
  return s;
}

/** A designer's session on one structure: hand edits captured as they are made, then definition changes regenerated. */
class Session {
  readonly store: VoxelStoreCandidate;
  overrides: StructureOverrides = { grid, gridId: GRID_ID, chunks: new Map() };
  constructor(public def: StructureDefinition) {
    this.store = built(def);
  }
  edit(cmd: Record<string, unknown>): void {
    const out = applyEdit({ store: (id) => (id === GRID_ID ? this.store : undefined) }, canonicalEditCommand({ v: 2, grid: GRID_ID, ...cmd }));
    this.overrides = captureOverrides(BUILDING_GENERATOR, this.def, this.store, this.overrides, out.chunks);
  }
  change(over: Record<string, unknown>): RegenerateReport<StructureDefinition> {
    const next = house({ ...this.def, ...over });
    const r = regenerateStructure(BUILDING_GENERATOR, this.store, GRID_ID, this.overrides, next, this.def);
    this.def = r.definition;
    this.overrides = r.overrides;
    return r;
  }
  role(x: number, y: number, z: number): number {
    const v = this.store.voxelAt(x, y, z, scratch);
    return v.material === 0 ? -1 : v.role;
  }
  material(x: number, y: number, z: number): number {
    return this.store.voxelAt(x, y, z, scratch).material;
  }
}
const scratch: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

const dig = (cells: number[]): Record<string, unknown> => ({ kind: 'dig', cells });
const put = (cells: number[], material: number, role: number): Record<string, unknown> => ({ kind: 'set', cells, voxel: { material, role, shape: 15, wetness: 0 } });
const paint = (min: number[], max: number[], material: number, role: number): Record<string, unknown> => ({ kind: 'fill', min, max, mode: 'paint', voxel: { material, role, wetness: 0 } });
const counts = (r: RegenerateReport<StructureDefinition>): [number, number, number] => [r.kept, r.absorbed, r.misfits.length];

describe('the fit rule on the building generator', () => {
  it('a hole cut in a wall, then the house widened: a hole in a wall that stays is kept; one in the wall that moved is absorbed without a report and the new wall is whole', () => {
    const s = new Session(house());
    s.edit(dig([0, 8, 5, 0, 8, 6, 0, 9, 5, 0, 9, 6]));
    s.edit(dig([15, 8, 5, 15, 8, 6, 15, 9, 5, 15, 9, 6]));
    const r = s.change({ footprint: [rect('main', 0, 0, 20, 12)] });
    // The west wall did not move: its hole is kept. The east wall moved from x = 15 to x = 19: the old hole's cells
    // are now inside the room, where the generator makes air, so the rule calls them absorbed (dropped, no report).
    expect(counts(r)).toEqual([4, 4, 0]);
    expect([s.role(0, 8, 5), s.role(15, 8, 5), s.role(19, 8, 5), s.role(19, 9, 6)]).toEqual([-1, -1, R.wall, R.wall]);
    expect(s.overrides.chunks.size).toBe(1);
  });

  it('a wall cell painted another material, then a material swap: kept, the cell stays painted; swapped to its own paint it is absorbed, and swapping back loses the paint', () => {
    const s = new Session(house());
    s.edit(paint([0, 3, 4], [0, 3, 4], 15, R.wall));
    const swap = s.change({ materials: { ...MAT, wall: 12 } });
    expect(counts(swap)).toEqual([1, 0, 0]);
    expect([s.material(0, 3, 4), s.material(0, 3, 5)]).toEqual([15, 12]);
    // The whole wall swapped to the paint's material: the generator now makes the painted voxel, so it is absorbed.
    const same = s.change({ materials: { ...MAT, wall: 15 } });
    expect(counts(same)).toEqual([0, 1, 0]);
    // Back to stone: the cell the designer painted goes stone with the rest; the paint is gone.
    const back = s.change({ materials: { ...MAT, wall: 10 } });
    expect(counts(back)).toEqual([0, 0, 0]);
    expect(s.material(0, 3, 4)).toBe(10);
  });

  it('a shelf added inside, then a storey added: a shelf in a room that stays a room is kept; one where the new floor goes is a misfit, reported and not written', () => {
    const s = new Session(house());
    // A shelf on the upper storey (row 9) and one in the attic at row 12, where a third storey's floor will lie.
    s.edit(put([5, 9, 1, 6, 9, 1, 7, 9, 1], 11, R.wall));
    s.edit(put([5, 12, 3, 6, 12, 3], 11, R.wall));
    const r = s.change({ storeys: 3 });
    expect(counts(r)).toEqual([3, 0, 2]);
    expect(r.misfits.map((m) => [m.x, m.y, m.z, valueRole(m.generated)])).toEqual([[5, 12, 3, R.floor], [6, 12, 3, R.floor]]);
    expect([s.role(5, 9, 1), s.material(5, 9, 1), s.role(5, 12, 3), s.material(5, 12, 3)]).toEqual([R.wall, 11, R.floor, MAT.floor]);
  });

  it('a window hand-cut, then the same opening added to the definition: absorbed when it was painted as an opening; a dug hole is a misfit (open air against the opening cell)', () => {
    const window = { id: 'w', polygon: 'main', edge: 2, storey: 1, at: 5, width: 2, height: 2, sill: 1 };
    // Edge 2 runs from (16, 12) to (0, 12): its cells 5 and 6 are x = 10 and 9 of the z = 11 wall; storey 1, sill 1: rows 8 and 9.
    const painted = new Session(house());
    painted.edit(paint([9, 8, 11], [10, 9, 11], MAT.wall, R.opening));
    expect(counts(painted.change({ openings: [window] }))).toEqual([0, 4, 0]);
    expect(painted.overrides.chunks.size).toBe(0);
    const dug = new Session(house());
    dug.edit(dig([9, 8, 11, 10, 8, 11, 9, 9, 11, 10, 9, 11]));
    const r = dug.change({ openings: [window] });
    expect(counts(r)).toEqual([0, 0, 4]);
    expect(r.misfits.every((m) => m.value === 0 && valueRole(m.generated) === R.opening && valueRole(m.base) === R.wall)).toBe(true);
    // The cells come out as the generated opening: open either way, but the report lists four misfits.
    expect(dug.role(9, 8, 11)).toBe(R.opening);
  });

  it('the roof changed from gable to hip under a hand-built chimney: the chimney keeps its cells in the air but loses the cell where the old roof was, and the new roof runs through it', () => {
    const s = new Session(house());
    // At (2, z 6) the gable's roof is at row 12 + 6 = 18; a hip puts it at 12 + 3 = 15.
    const cells: number[] = [];
    for (let y = 12; y <= 20; y++) cells.push(2, y, 6);
    s.edit(put(cells, 16, R.wall));
    const r = s.change({ roof: { shape: 'hip', overhang: 1, axis: 'x' } });
    expect(counts(r)).toEqual([7, 0, 2]);
    expect(r.misfits.map((m) => [m.y, m.base === 0 ? 'air' : valueRole(m.base), m.generated === 0 ? 'air' : valueRole(m.generated)])).toEqual([[15, 'air', R.roof], [18, R.roof, 'air']]);
    const column = [];
    for (let y = 12; y <= 20; y++) column.push(s.role(2, y, 6));
    expect(column).toEqual([R.wall, R.wall, R.wall, R.roof, R.wall, R.wall, -1, R.wall, R.wall]);
  });

  it('overrides on cells that leave the generator\'s box: a post added outside is kept; a hole in the wall that went is absorbed; a painted cell of it is a misfit', () => {
    const s = new Session(house());
    s.edit(put([20, 1, 5, 20, 2, 5], 11, R.pillar));
    s.edit(dig([15, 3, 4]));
    s.edit(paint([15, 3, 7], [15, 3, 7], 15, R.wall));
    const r = s.change({ footprint: [rect('main', 0, 0, 12, 12)] });
    expect(counts(r)).toEqual([2, 1, 1]);
    expect(r.misfits.map((m) => [m.x, m.y, m.z])).toEqual([[15, 3, 7]]);
    expect([s.role(20, 1, 5), s.role(15, 3, 4), s.role(15, 3, 7), s.role(11, 3, 7)]).toEqual([R.pillar, -1, -1, R.wall]);
    // The undo of the regenerate brings the misfit back with the old shape.
    expect(r.undo.length).toBeGreaterThan(0);
  });
});
