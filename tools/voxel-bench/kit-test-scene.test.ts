/**
 * The kit test scene through the real derive with the world's catalogue:
 * the edge catalogue has no window rules, so no exhibit grid, and every case
 * (edges, corners, roof edges, damage: every slot) gets a label from the
 * fixed sampler, so no case is unreached. Written into a busy world, a kit
 * filling every slot draws, at every label, that slot's piece.
 */
import { applyEdit, buildPieceTable, chunkGrid, createWorldStore, deriveFromStore, INSTANCE_BYTES, kitPieceList, kitTestExhibits, kitTestScene, VOXEL_ROLE, WORLD_RULES } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { caseAt } from './case-probe';
import { putVoxel, randomAssemblyWorld } from './scenes';
import { fullTestKit } from './test-kits';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const E = grid.edge;
const ORIGIN = [-23, 17, -9] as const;
const RULES = WORLD_RULES;
const CAT = RULES.catalogue!;

describe('the kit test scene', () => {
  it('has no window exhibit (the catalogue has no window rules) and a sampler label for every case: no case unreached', () => {
    const { exhibits, unreached } = kitTestExhibits(CAT);
    expect(exhibits).toEqual([]);
    expect(unreached.map((u) => `${u.caseId}/${u.role}`)).toEqual(CAT.cases.flatMap((c) => [...new Set(c.roles)].map((r) => `${c.id}/${r}`)));
    const scene = kitTestScene(RULES, { origin: ORIGIN, material: MAT.timber });
    expect(scene.unreached).toEqual([]);
    expect(CAT.cases.length).toBe(17);
    // Each case labelled once.
    expect(scene.labels.map((l) => l.caseId).sort()).toEqual(CAT.cases.map((c) => c.id).sort());
    // The same catalogue gives the same scene.
    expect(JSON.stringify(kitTestScene(RULES, { origin: ORIGIN, material: MAT.timber }))).toBe(JSON.stringify(scene));
  });

  it('written into a busy world, labels cells in its box with no window case; a kit filling every slot draws the labelled slot\'s piece at every label', () => {
    const scene = kitTestScene(RULES, { origin: ORIGIN, material: MAT.timber });
    const store = createWorldStore(grid);
    // The world around and inside the box is full of construction and ground before the scene empties its box.
    randomAssemblyWorld(store, 5, 128);
    for (let x = scene.min[0] - 4; x <= scene.max[0] + 4; x++) for (let z = scene.min[2] - 4; z <= scene.max[2] + 4; z++) for (let y = scene.min[1] - 4; y < scene.min[1]; y++) putVoxel(store, x, y, z, MAT.rock, VOXEL_ROLE.terrain);
    for (const cmd of scene.commands) applyEdit({ store: () => store }, cmd);
    for (const l of scene.labels) {
      for (let k = 0; k < 3; k++) expect(l.cell[k]! >= scene.min[k]! && l.cell[k]! <= scene.max[k]!, `${l.caseId} in the box`).toBe(true);
      expect(caseAt(store, ...(l.cell as [number, number, number])).caseId).toBeNull();
    }
    // The derive with a kit bound to the scene's material: a label's cell owns a piece of its slot (beside its other edges').
    const kit = fullTestKit('all', [MAT.timber], 1);
    const { table } = buildPieceTable([kit], RULES, 0);
    const list = kitPieceList(kit, CAT).pieces;
    const memo = new Map<string, Map<number, number[]>>();
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
      expect(here.map((q) => list[q]!.caseId), `${l.caseId} at ${l.cell.join(',')}`).toContain(l.caseId);
    }
  });

  it('refuses a rule set without a catalogue and a material outside the voxel\'s 12 bits', () => {
    expect(() => kitTestScene({ ...RULES, catalogue: undefined }, { origin: ORIGIN, material: 3 })).toThrow(/no case catalogue/);
    expect(() => kitTestScene(RULES, { origin: ORIGIN, material: 0 })).toThrow(/material 0/);
    expect(() => kitTestScene(RULES, { origin: ORIGIN, material: 4096 })).toThrow(/material 4096/);
  });
});
