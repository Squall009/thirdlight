/**
 * The kit test scene through the real derive with the world's catalogue:
 * every (case, role) pair a window rule reaches (beams and banisters) gets
 * an exhibit, and every case the passes give (edges, corners, roof edges,
 * debris) a label from the fixed sampler, so no case of the catalogue is
 * unreached. Written into a busy world (across chunk faces), each window
 * label's cell gets exactly its case and run section, and a kit with a piece
 * for every case draws, at every label, that case's piece.
 */
import {
  applyEdit,
  buildPieceTable,
  CaseCatalogue,
  chunkGrid,
  createWorldStore,
  deriveFromStore,
  INSTANCE_BYTES,
  KIT_PIECE_BASE,
  KIT_TEST_SCENE_PITCH,
  kitPieceList,
  kitTestExhibits,
  kitTestScene,
  RUN_SECTION_IDS,
  tablePiece,
  VOXEL_ROLE,
  WORLD_RULES,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { caseAndSectionAt } from './case-probe';
import { putVoxel, randomAssemblyWorld } from './scenes';
import { fullTestKit } from './test-kits';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const E = grid.edge;
const ORIGIN = [-23, 17, -9] as const;
const RULES = WORLD_RULES;
const CAT = RULES.catalogue!;
const caseIndex = (id: string): number => CAT.cases.findIndex((c) => c.id === id);
/** The cases some window rule names (the rest come from the edge, roof and debris passes). */
const WINDOW_CASES = new Set(CAT.rules.map((r) => r.case));

describe('the kit test scene', () => {
  it('has an exhibit for every (case, role) pair a window rule reaches, each a window the matcher resolves to its case, and a sampler label for every pass case: no case unreached', () => {
    const { exhibits, unreached } = kitTestExhibits(CAT);
    const pairs = (keep: (id: string) => boolean): string[] => CAT.cases.filter((c) => keep(c.id)).flatMap((c) => [...new Set(c.roles)].map((r) => `${c.id}/${r}`));
    expect(unreached.map((u) => `${u.caseId}/${u.role}`)).toEqual(pairs((id) => !WINDOW_CASES.has(id)));
    expect(exhibits.map((e) => `${e.caseId}/${e.role}`)).toEqual(pairs((id) => WINDOW_CASES.has(id)));
    const scene = kitTestScene(RULES, { origin: ORIGIN, material: MAT.timber });
    expect(scene.unreached).toEqual([]);
    expect(new Set(scene.labels.map((l) => l.caseId))).toEqual(new Set(CAT.cases.map((c) => c.id)));
    // Each pass case labelled once, in the sampler's column (past the window grid's rows).
    const pass = scene.labels.filter((l) => !WINDOW_CASES.has(l.caseId));
    expect(pass.length).toBe(CAT.cases.length - WINDOW_CASES.size);
    const gridEnd = Math.max(...scene.labels.filter((l) => WINDOW_CASES.has(l.caseId)).map((l) => l.cell[2]!)) + (KIT_TEST_SCENE_PITCH >> 1);
    for (const l of pass) expect(l.cell[2]).toBeGreaterThan(gridEnd);
    const cat = new CaseCatalogue(CAT);
    for (const e of exhibits) for (const [dx, dy, dz] of e.cells) expect(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))).toBeLessThanOrEqual(2);
    expect(cat.cases.length).toBe(21);
    // The same catalogue gives the same scene.
    expect(JSON.stringify(kitTestScene(RULES, { origin: ORIGIN, material: MAT.timber }))).toBe(JSON.stringify(kitTestScene(RULES, { origin: ORIGIN, material: MAT.timber })));
  });

  it('written into a busy world across chunk faces, gives every labelled cell its case and section; a full kit draws the labelled case and section there', () => {
    const scene = kitTestScene(RULES, { origin: ORIGIN, material: MAT.timber });
    expect(scene.unreached).toEqual([]);
    const roles = new Set(CAT.cases.filter((c) => WINDOW_CASES.has(c.id)).flatMap((c) => c.roles));
    const windows = scene.labels.filter((l) => WINDOW_CASES.has(l.caseId));
    expect(windows.length).toBe(CAT.cases.filter((c) => WINDOW_CASES.has(c.id)).reduce((a, c) => a + new Set(c.roles).size, 0));
    // A grid: one row a role, columns a pitch apart, every centre inside the box with three cells of it around.
    for (const l of windows) {
      expect(roles.has(l.role)).toBe(true);
      for (let k = 0; k < 3; k++) {
        expect(l.cell[k]! - 3).toBeGreaterThanOrEqual(scene.min[k]!);
        expect(l.cell[k]! + 3).toBeLessThanOrEqual(scene.max[k]!);
        expect((l.cell[k]! - ORIGIN[k]! - (KIT_TEST_SCENE_PITCH >> 1)) % KIT_TEST_SCENE_PITCH).toBe(0);
      }
    }
    const store = createWorldStore(grid);
    // The world around and inside the box is full of construction and ground before the scene empties its box.
    randomAssemblyWorld(store, 5, 128);
    for (let x = scene.min[0] - 4; x <= scene.max[0] + 4; x++) for (let z = scene.min[2] - 4; z <= scene.max[2] + 4; z++) for (let y = scene.min[1] - 4; y < scene.min[1]; y++) putVoxel(store, x, y, z, MAT.rock, VOXEL_ROLE.terrain);
    for (const cmd of scene.commands) applyEdit({ store: () => store }, cmd);
    const spans = new Set(scene.labels.map((l) => l.cell.map((v) => v >> grid.shift).join(',')));
    // The five beam and banister exhibits still straddle a chunk face.
    expect(spans.size).toBeGreaterThan(1);
    for (const l of windows) expect({ at: l.cell, ...caseAndSectionAt(store, ...(l.cell as [number, number, number])) }).toEqual({ at: l.cell, caseId: l.caseId, section: l.section });
    for (const l of scene.labels) for (let k = 0; k < 3; k++) expect(l.cell[k]! >= scene.min[k]! && l.cell[k]! <= scene.max[k]!, `${l.caseId} in the box`).toBe(true);
    // The derive with a kit bound to the scene's material: the instance at a label is that case's piece, that section's.
    const kit = fullTestKit('all', [MAT.timber], 1);
    const { table } = buildPieceTable([kit], RULES);
    const list = kitPieceList(kit, CAT).pieces;
    const memo = new Map<string, Map<number, number[]>>();
    let drawn = 0;
    for (const l of scene.labels) {
      const [x, y, z] = l.cell as [number, number, number];
      const key = `${x >> grid.shift},${y >> grid.shift},${z >> grid.shift}`;
      let inst = memo.get(key);
      if (inst === undefined) {
        const d = deriveFromStore(store, x >> grid.shift, y >> grid.shift, z >> grid.shift, RULES, undefined, table);
        inst = new Map();
        const b = d.instances.data;
        for (let k = 0; k < d.instances.count; k++) {
          const o = k * INSTANCE_BYTES;
          const cell = (b[o]! * E + b[o + 2]!) * E + b[o + 1]!;
          inst.set(cell, [...(inst.get(cell) ?? []), b[o + 4]! | (b[o + 5]! << 8)]);
        }
        memo.set(key, inst);
      }
      const here = inst.get(((x & grid.mask) * E + (z & grid.mask)) * E + (y & grid.mask)) ?? [];
      if (!WINDOW_CASES.has(l.caseId)) {
        // A sampler label: its cell owns a piece of that case (beside its other edges').
        expect(here.map((q) => list[q - KIT_PIECE_BASE]!.caseId), `${l.caseId} at ${l.cell.join(',')}`).toContain(l.caseId);
        drawn++;
        continue;
      }
      // A beam's or banister's cell owns its one piece (it replaces the cell's faces, so no edge piece goes round it).
      if (here.length === 0) continue;
      expect(here.length, `one piece at ${l.cell.join(',')}`).toBe(1);
      const piece = here[0]!;
      drawn++;
      // The kit's piece for the label's case and section, by the table's fallback order (`enclosed` has none: its role's fallback).
      const want = tablePiece(table, MAT.timber, caseIndex(l.caseId), RUN_SECTION_IDS.indexOf(l.section ?? 'single'));
      expect({ at: l.cell, piece: list[piece - KIT_PIECE_BASE] }).toEqual({ at: l.cell, piece: list[want - KIT_PIECE_BASE] });
      if (l.caseId !== 'enclosed') expect([list[piece - KIT_PIECE_BASE]!.caseId, list[piece - KIT_PIECE_BASE]!.sectionId]).toEqual([l.caseId, l.section ?? 'single']);
    }
    // Every labelled case shows its piece: beams, rails and posts, and every sampler case.
    expect(drawn).toBe(scene.labels.length);
  });

  it('refuses a rule set without a catalogue and a material outside the voxel\'s 12 bits', () => {
    expect(() => kitTestScene({ ...RULES, catalogue: undefined }, { origin: ORIGIN, material: 3 })).toThrow(/no case catalogue/);
    expect(() => kitTestScene(RULES, { origin: ORIGIN, material: 0 })).toThrow(/material 0/);
    expect(() => kitTestScene(RULES, { origin: ORIGIN, material: 4096 })).toThrow(/material 4096/);
  });
});
