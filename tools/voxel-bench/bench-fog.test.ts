/**
 * The bench fog on flat ground as the town's lot has it: the hollow's dig and the fill are commands the format
 * takes, the fill stays in the hollow (no leak), thins toward its top, and the two fog cameras stand where their
 * pictures need them (one over the lot in clear air, one inside the bank); the drain takes the fill back; placing
 * and taking out go through the commands in the order the undo needs.
 */
import { applyEdit, canonicalEditCommand, chunkGrid, createWorldStore, DERIVED_PART, VOXEL_ROLE, VOXEL_SIZE_M, type PaletteStore } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { BENCH_FOG_MATERIAL, fogFloodCommand, fogHollowStroke, placeBenchFog } from './bench-fog';
import { FOG_HOLLOW, LIGHT_CHECK_CAMERAS } from './lighting-cameras';
import { PICTURES } from './picture-list';
import { LOT, lotOf, TOWN_SEED } from './town';
import { FAR_TOWN_SHIFT_CELLS } from './far-world';

const grid = chunkGrid(32);
const MIST = BENCH_FOG_MATERIAL.voxel.id;

/** The lot's ground: grass to the surface at y 0, 8 m deep, over the lot and a margin round it (cells). */
function lotGround(): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = -64; x < -8; x++) for (let z = -24; z < 32; z++) for (let y = -16; y < 0; y++) s.setVoxel(x, y, z, { material: 2, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 });
  return s;
}

const cellAt = (s: PaletteStore, m: readonly number[]): { material: number; role: number; shape: number } => {
  const v = { material: 0, role: 0, shape: 0, wetness: 0 };
  s.voxelAt(Math.floor(m[0]! / VOXEL_SIZE_M), Math.floor(m[1]! / VOXEL_SIZE_M), Math.floor(m[2]! / VOXEL_SIZE_M), v);
  return { material: v.material, role: v.role, shape: v.shape };
};

describe('the bench fog', () => {
  it('stands in a lot of the town that holds nothing: no house in the world grid, no pond, no fence', () => {
    const lot = lotOf(5, 6, TOWN_SEED);
    expect([lot.yaw !== 0, lot.pond, lot.fence]).toEqual([true, false, false]);
    // The hollow's balls lie inside that lot, half a metre or more from its edges.
    const [x0, z0] = [(5 * LOT - FAR_TOWN_SHIFT_CELLS) * VOXEL_SIZE_M, (6 * LOT - FAR_TOWN_SHIFT_CELLS) * VOXEL_SIZE_M];
    const r = Math.sqrt((FOG_HOLLOW.diameter / 2) ** 2 - Math.min(...FOG_HOLLOW.dabs.map((d) => d[1])) ** 2);
    for (const [x, , z] of FOG_HOLLOW.dabs) {
      expect(x - r).toBeGreaterThanOrEqual(x0 + 0.5);
      expect(x + r).toBeLessThanOrEqual(x0 + 20 - 0.5);
      expect(z - r).toBeGreaterThanOrEqual(z0 + 0.5);
      expect(z + r).toBeLessThanOrEqual(z0 + 20 - 0.5);
    }
  });

  it('digs the hollow and fills it with one flood that stays in it, thinning to its top; a drain takes the fill back', () => {
    const s = lotGround();
    const dig = canonicalEditCommand(fogHollowStroke());
    const dug = applyEdit({ store: () => s }, dig);
    expect(dug.cells).toBeGreaterThan(2000);
    const before = new Map<string, number>();
    const mark = (into: Map<string, number>): void => {
      const v = { material: 0, role: 0, shape: 0, wetness: 0 };
      for (let x = -64; x < -8; x++) for (let z = -24; z < 32; z++) for (let y = -16; y < 8; y++) if (s.voxelAt(x, y, z, v).material !== 0) into.set(`${x},${y},${z}`, v.material * 1000 + v.role * 16 + v.shape);
    };
    mark(before);
    const flood = canonicalEditCommand(fogFloodCommand() as never);
    const filled = applyEdit({ store: () => s }, flood);
    expect(filled.parts).toBe(DERIVED_PART.gas);
    expect(filled.cells).toBeGreaterThan(1500);
    // Full density at the floor, thinner toward the level, air over it and over the lot's ground.
    const [sx, , sz] = FOG_HOLLOW.seed;
    expect(cellAt(s, FOG_HOLLOW.seed)).toEqual({ material: MIST, role: VOXEL_ROLE.gas, shape: 15 });
    const top = cellAt(s, [sx, FOG_HOLLOW.level - 0.25, sz]);
    expect(top.role).toBe(VOXEL_ROLE.gas);
    expect(top.shape).toBeLessThan(6);
    expect(cellAt(s, [sx, FOG_HOLLOW.level + 0.25, sz]).material).toBe(0);
    expect(cellAt(s, [sx, 0.25, sz]).material).toBe(0);
    // The drain: the same seed and level with air; the hollow is as it was dug.
    const drained = applyEdit({ store: () => s }, canonicalEditCommand(fogFloodCommand(true) as never));
    expect(drained.cells).toBe(filled.cells);
    const after = new Map<string, number>();
    mark(after);
    expect(after).toEqual(before);
  });

  it('puts the fog cameras where their pictures need them: one in clear air over the lot, one inside the bank; both in the picture list', () => {
    const s = lotGround();
    applyEdit({ store: () => s }, canonicalEditCommand(fogHollowStroke()));
    applyEdit({ store: () => s }, canonicalEditCommand(fogFloodCommand() as never));
    const bank = LIGHT_CHECK_CAMERAS.find((c) => c.name === 'fog-bank')!;
    const inside = LIGHT_CHECK_CAMERAS.find((c) => c.name === 'fog-inside')!;
    expect(bank.eye[1]).toBeGreaterThan(2);
    expect(cellAt(s, inside.eye).role).toBe(VOXEL_ROLE.gas);
    // The inside camera has fog over it (to the level) and open hollow under it.
    expect(FOG_HOLLOW.level - inside.eye[1]).toBeGreaterThan(2);
    expect(cellAt(s, [inside.eye[0], inside.eye[1] - 1, inside.eye[2]]).role).toBe(VOXEL_ROLE.gas);
    // The outside camera looks at the hollow: its view axis passes within 3 m of the hollow's middle at the fog's level.
    const dir = [-Math.sin(bank.yaw) * Math.cos(bank.pitch), -Math.sin(bank.pitch), -Math.cos(bank.yaw) * Math.cos(bank.pitch)];
    const t = (FOG_HOLLOW.level - bank.eye[1]) / dir[1]!;
    expect(Math.hypot(bank.eye[0] + dir[0]! * t - -18.5, bank.eye[2] + dir[2]! * t - 1)).toBeLessThan(3);
    expect(PICTURES.filter((p) => p.kind === 'world' && (p.camera === 'fog-bank' || p.camera === 'fog-inside')).map((p) => p.id)).toEqual(['L23', 'L24']);
  });

  it('places it through the commands (material, dig, flood) and takes out only the strokes it wrote, by the project\'s undo, then the material', async () => {
    const calls: string[] = [];
    const answers: Record<string, Record<string, unknown>[]> = { editVoxels: [{ ok: true, cells: 10, parts: 127 }, { ok: true, cells: 5, parts: 64 }], undo: [{ ok: true, voxels: { ok: true, cells: 5 } }, { ok: true, voxels: { ok: true, cells: 10 } }] };
    const api = (a: typeof answers) => ({
      command: async (op: string, args: Record<string, unknown>): Promise<void> => void calls.push(`${op}:${String((args['material'] as { materialId?: string } | undefined)?.materialId ?? args['materialId'] ?? '')}`),
      raw: async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        calls.push(`${op}:${String((args['command'] as { kind?: string } | undefined)?.kind ?? '')}`);
        return a[op]!.shift()!;
      },
    });
    const placed = await placeBenchFog(api(answers), 'far', () => undefined);
    expect(placed.facts['flood']).toEqual({ cells: 5, parts: 64 });
    await placed.undo();
    expect(calls).toEqual(['setMaterial:bench-mist', 'editVoxels:brush', 'editVoxels:flood', 'undo:', 'undo:', 'deleteMaterial:bench-mist']);
    // A hollow left by a run that did not finish: only the flood is this run's, so only one step is undone.
    calls.length = 0;
    const left = await placeBenchFog(api({ editVoxels: [{ ok: false, error: { code: 'no_change' } }, { ok: true, cells: 5, parts: 64 }], undo: [{ ok: true, voxels: { ok: true, cells: 5 } }] }), 'far', () => undefined);
    await left.undo();
    expect(calls.filter((c) => c.startsWith('undo'))).toEqual(['undo:']);
    // A leak is not swallowed.
    await expect(placeBenchFog(api({ editVoxels: [{ ok: true, cells: 1 }, { ok: false, error: { code: 'flood_leaks' } }], undo: [] }), 'far', () => undefined)).rejects.toThrow(/flood/);
  });
});
