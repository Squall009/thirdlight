/**
 * Damage stages from integrity: the engine's split, a kit's own ranges,
 * counts and fewer stages, what is refused, and the stages riding in the
 * piece table's bytes (a worker's copy reads them back).
 */
import { describe, expect, it } from 'vitest';
import { DAMAGE_STAGE, DAMAGE_STAGES, integrityCoverage, resolveDamageStages } from './damage-stages';
import { EDGE_RULES } from './kit-rules';
import { buildPieceTable, cellDamageStages, crackStrengthOf, damageStageOf, readPieceTable } from './piece-table';
import { SHAPE_FULL, valueOf, VOXEL_ROLE } from './record';

const wall = (material: number, shape: number): number => valueOf({ material, role: VOXEL_ROLE.wall, shape, wetness: 0 });
const S = DAMAGE_STAGE;

describe('damage stages', () => {
  it("the engine's split: 15 intact, 11-14 cracks, 6-10 a hole with 6 pieces a face, 1-5 with 3; cracks stronger as integrity drops", () => {
    expect([...DAMAGE_STAGES.stage]).toEqual([0, S.few, S.few, S.few, S.few, S.few, S.many, S.many, S.many, S.many, S.many, S.crack, S.crack, S.crack, S.crack, 0]);
    expect([...DAMAGE_STAGES.pieces]).toEqual([0, 0, 6, 3]);
    const crack = [14, 13, 12, 11].map((v) => DAMAGE_STAGES.crack[v]!);
    expect(crack).toEqual([64, 128, 191, 255]);
    for (let v = 0; v <= 10; v++) expect(DAMAGE_STAGES.crack[v]).toBe(0);
    expect(DAMAGE_STAGES.crack[SHAPE_FULL]).toBe(0);
  });

  it('a kit moves the ranges, sets the counts and leaves stages out; an integrity in no stage draws intact', () => {
    const { stages, problems } = resolveDamageStages({ stage1: { min: 13, max: 14 }, stage2: { min: 3, max: 12, pieces: 9 }, stage3: null });
    expect(problems).toEqual([]);
    expect([...stages.stage]).toEqual([0, 0, 0, S.many, S.many, S.many, S.many, S.many, S.many, S.many, S.many, S.many, S.many, S.crack, S.crack, 0]);
    expect([...stages.pieces]).toEqual([0, 0, 9, 0]);
    expect([stages.crack[14], stages.crack[13]]).toEqual([128, 255]);
    // One stage only: stage 3 over 1-14, stages 1 and 2 left out; its count the default.
    const one = resolveDamageStages({ stage1: null, stage2: null, stage3: { min: 1, max: 14 } }).stages;
    expect(new Set(one.stage.subarray(1, 15))).toEqual(new Set([S.few]));
    expect(one.pieces[3]).toBe(3);
    // Absent stages are the engine's.
    expect([...resolveDamageStages({ stage2: { min: 6, max: 10, pieces: 2 } }).stages.stage]).toEqual([...DAMAGE_STAGES.stage]);
  });

  it('reports a malformed or overlapping kit and draws the engine stages for it (never throws)', () => {
    for (const bad of [{ stage1: { min: 0, max: 14 } }, { stage1: { min: 12, max: 15 } }, { stage1: { min: 13, max: 12 } }, { stage1: { min: 11, max: 14, pieces: 2 } }, { stage2: { min: 6, max: 10, pieces: 17 } }, { stage1: { min: 9, max: 14 } }]) {
      const r = resolveDamageStages(bad);
      expect(r.problems.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
    expect(resolveDamageStages({ stage1: { min: 9, max: 14 } }).stages).toBe(DAMAGE_STAGES);
  });

  it("light coverage follows integrity: integrity / 15 of a whole cell", () => {
    expect([0, 1, 5, 8, 14, 15].map(integrityCoverage)).toEqual([0, 17, 85, 136, 238, 255]);
  });

  it('rides in the piece table: per kit, the hole\'s and the face\'s material each by its kit, the engine\'s for no kit and no table', () => {
    const kits = [
      { voxelKitId: 'a', materials: [3], slots: {}, damage: { stage1: null, stage2: { min: 1, max: 14, pieces: 2 }, stage3: null } },
      { voxelKitId: 'b', materials: [4], slots: {} },
    ];
    const { table, problems } = buildPieceTable(kits, EDGE_RULES, 7);
    expect(problems).toEqual([]);
    const copy = readPieceTable(table.bytes);
    for (const t of [table, copy]) {
      expect(damageStageOf(t, wall(3, 12))).toBe(S.many);
      expect(crackStrengthOf(t, wall(3, 12))).toBe(0);
      expect(cellDamageStages(t, wall(3, 12)).pieces[2]).toBe(2);
      expect(damageStageOf(t, wall(4, 12))).toBe(S.crack);
      expect(crackStrengthOf(t, wall(4, 12))).toBe(191);
      expect(damageStageOf(t, wall(9, 3))).toBe(S.few);
      expect(damageStageOf(t, wall(3, SHAPE_FULL))).toBe(0);
      // Terrain has no damage: its shape is its fill.
      expect(damageStageOf(t, valueOf({ material: 3, role: VOXEL_ROLE.terrain, shape: 7, wetness: 0 }))).toBe(0);
    }
    expect(damageStageOf(null, wall(3, 8))).toBe(S.many);
    // The stages decide the kit's hash (its materials derive again when they change); another kit's is untouched.
    const other = buildPieceTable([{ ...kits[0]!, damage: { stage3: null } }, kits[1]!], EDGE_RULES, 7).table;
    expect(other.kits[0]!.hash).not.toBe(table.kits[0]!.hash);
    expect(other.kits[1]!.hash).toBe(table.kits[1]!.hash);
    // A table whose stage bytes were damaged is refused.
    const broken = table.bytes.slice();
    const at = broken.findIndex((_, i) => i > 20 && broken[i] === 14 && broken[i + 1] === 0);
    broken[at] = 15;
    expect(() => readPieceTable(broken)).toThrow(RangeError);
  });
});
