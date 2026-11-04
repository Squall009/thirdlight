/**
 * The kit test scene through the real derive: every (case, role) pair of
 * the draft catalogue gets an exhibit, the scene written into a busy world
 * (across chunk faces) gives each labelled cell exactly its case and the
 * labelled run section, and a kit with a piece for every case and section
 * draws, at each label that shows a piece, the piece of that case and
 * section.
 */
import {
  applyEdit,
  buildPieceTable,
  CaseCatalogue,
  chunkGrid,
  createWorldStore,
  deriveFromStore,
  DRAFT_CASE_CATALOGUE,
  INSTANCE_BYTES,
  KIT_PIECE_BASE,
  KIT_RULES,
  KIT_TEST_SCENE_PITCH,
  kitPieceList,
  kitTestExhibits,
  kitTestScene,
  RUN_SECTION_IDS,
  tablePiece,
  VOXEL_ROLE,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { caseAndSectionAt } from './case-probe';
import { putVoxel, randomAssemblyWorld } from './scenes';
import { fullTestKit } from './test-kits';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const E = grid.edge;
const ORIGIN = [-23, 17, -9] as const;
const caseIndex = (id: string): number => DRAFT_CASE_CATALOGUE.cases.findIndex((c) => c.id === id);

describe('the kit test scene', () => {
  it('has an exhibit for every (case, role) pair of the catalogue, each a window the matcher resolves to its case', () => {
    const { exhibits, unreached } = kitTestExhibits(DRAFT_CASE_CATALOGUE);
    expect(unreached).toEqual([]);
    const pairs = DRAFT_CASE_CATALOGUE.cases.flatMap((c) => [...new Set(c.roles)].map((r) => `${c.id}/${r}`));
    expect(exhibits.map((e) => `${e.caseId}/${e.role}`)).toEqual(pairs);
    const cat = new CaseCatalogue(DRAFT_CASE_CATALOGUE);
    for (const e of exhibits) for (const [dx, dy, dz] of e.cells) expect(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))).toBeLessThanOrEqual(2);
    expect(cat.cases.length).toBe(45);
    // The same catalogue gives the same scene.
    expect(JSON.stringify(kitTestScene(KIT_RULES, { origin: ORIGIN, material: MAT.timber }))).toBe(JSON.stringify(kitTestScene(KIT_RULES, { origin: ORIGIN, material: MAT.timber })));
  });

  it('written into a busy world across chunk faces, gives every labelled cell its case and section; a full kit draws the labelled case and section there', () => {
    const scene = kitTestScene(KIT_RULES, { origin: ORIGIN, material: MAT.timber });
    expect(scene.unreached).toEqual([]);
    const roles = new Set(DRAFT_CASE_CATALOGUE.cases.flatMap((c) => c.roles));
    expect(scene.labels.length).toBe(DRAFT_CASE_CATALOGUE.cases.reduce((a, c) => a + new Set(c.roles).size, 0));
    // A grid: one row a role, columns a pitch apart, every centre inside the box with three cells of it around.
    for (const l of scene.labels) {
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
    expect(spans.size).toBeGreaterThan(2);
    for (const l of scene.labels) expect({ at: l.cell, ...caseAndSectionAt(store, ...(l.cell as [number, number, number])) }).toEqual({ at: l.cell, caseId: l.caseId, section: l.section });
    // The derive with a kit bound to the scene's material: the instance at a label is that case's piece, that section's.
    const kit = fullTestKit('all', [MAT.timber], 1);
    const { table } = buildPieceTable([kit], KIT_RULES);
    const list = kitPieceList(kit, DRAFT_CASE_CATALOGUE).pieces;
    const memo = new Map<string, Map<number, number>>();
    let drawn = 0;
    for (const l of scene.labels) {
      const [x, y, z] = l.cell as [number, number, number];
      const key = `${x >> grid.shift},${y >> grid.shift},${z >> grid.shift}`;
      let inst = memo.get(key);
      if (inst === undefined) {
        const d = deriveFromStore(store, x >> grid.shift, y >> grid.shift, z >> grid.shift, KIT_RULES, undefined, table);
        inst = new Map();
        const b = d.instances.data;
        for (let k = 0; k < d.instances.count; k++) {
          const o = k * INSTANCE_BYTES;
          inst.set((b[o]! * E + b[o + 2]!) * E + b[o + 1]!, b[o + 4]! | (b[o + 5]! << 8));
        }
        memo.set(key, inst);
      }
      const piece = inst.get(((x & grid.mask) * E + (z & grid.mask)) * E + (y & grid.mask));
      if (piece === undefined) continue;
      drawn++;
      // The kit's piece for the label's case and section, by the table's fallback order (`enclosed` has none: its role's fallback).
      const want = tablePiece(table, MAT.timber, caseIndex(l.caseId), RUN_SECTION_IDS.indexOf(l.section ?? 'single'));
      expect({ at: l.cell, piece: list[piece - KIT_PIECE_BASE] }).toEqual({ at: l.cell, piece: list[want - KIT_PIECE_BASE] });
      if (l.caseId !== 'enclosed') expect([list[piece - KIT_PIECE_BASE]!.caseId, list[piece - KIT_PIECE_BASE]!.sectionId]).toEqual([l.caseId, l.section ?? 'single']);
    }
    // Every case but those drawing no piece of their own (enclosed, openings' gaps) shows its piece.
    expect(drawn).toBeGreaterThan(scene.labels.length - 15);
  });

  it('refuses a rule set without a catalogue and a material outside the voxel\'s 12 bits', () => {
    expect(() => kitTestScene({ ...KIT_RULES, catalogue: undefined }, { origin: ORIGIN, material: 3 })).toThrow(/no case catalogue/);
    expect(() => kitTestScene(KIT_RULES, { origin: ORIGIN, material: 0 })).toThrow(/material 0/);
    expect(() => kitTestScene(KIT_RULES, { origin: ORIGIN, material: 4096 })).toThrow(/material 4096/);
  });
});
