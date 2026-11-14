import { describe, expect, it } from 'vitest';

import { MEMORY_BUDGET_BY_TIER } from '@thirdlight/runtime';
import { MEMORY_BUDGET_IDS } from '@thirdlight/shared';
import { memoryReport } from './page-memory';

const MIB = 2 ** 20;

describe('the resident-bytes report', () => {
  it("gives every budget of the tier's table a row: the threads' readings added up, the adapter's own counts and budgets, null where nothing counts", () => {
    const diagnostics = {
      textures: { residentBytes: 100 * MIB, budgetBytes: 256 * MIB },
      streaming: { residentBytes: 10 * MIB, budgetBytes: 768 * MIB },
      probes: { textureBytes: 4 * MIB, budgetBytes: 128 * MIB },
      surfaceCache: { usedBytes: 40 * MIB, budgetBytes: 32 * MIB },
    };
    const m = memoryReport('low', [{ voxelStream: 300 * MIB }, { voxelStream: 84 * MIB, physics: 8 * MIB }], diagnostics, 96 * MIB);
    expect(m.tier).toBe('low');
    expect(m.rows.map((r) => r.id)).toEqual([...MEMORY_BUDGET_IDS]);
    const row = Object.fromEntries(m.rows.map((r) => [r.id, r]));
    expect([row.voxelStream!.resident, row.voxelStream!.budget, row.voxelStream!.use]).toEqual([384 * MIB, 768 * MIB, 0.5]);
    expect(row.physics!.resident).toBe(8 * MIB);
    expect(row.farGpu!.resident).toBe(96 * MIB);
    // The project's own texture budget (256), not the table's default (512).
    expect([row.textures!.resident, row.textures!.budget]).toEqual([100 * MIB, 256 * MIB]);
    expect(row.worldStream!.resident).toBe(10 * MIB);
    expect(row.probes!.resident).toBe(4 * MIB);
    expect(row.surfaceCache!.use).toBe(1.25);
    for (const id of ['farSelection', 'sceneObjects', 'undo'] as const) expect([row[id]!.resident, row[id]!.use]).toEqual([null, null]);
    expect(m.page).toEqual({ resident: 392 * MIB, budget: (768 + 512 + 48 + 32) * MIB, target: MEMORY_BUDGET_BY_TIER.low.target!.page });
    expect(m.gpu).toEqual({ resident: (96 + 100 + 10 + 40 + 4) * MIB, budget: (384 + 256 + 768 + 32 + 128) * MIB, target: MEMORY_BUDGET_BY_TIER.low.target!.gpu });
    // JSON-safe (the capture file holds it).
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it("without readings or diagnostics every row reads null against the table's own budget; a tier without a target says so", () => {
    const m = memoryReport('high', [], undefined, null);
    expect(m.rows.every((r) => r.resident === null && r.use === null)).toBe(true);
    expect(m.rows.map((r) => r.budget)).toEqual(MEMORY_BUDGET_BY_TIER.high.entries.map((e) => e.bytes));
    expect([m.page.resident, m.page.target, m.gpu.target]).toEqual([0, null, null]);
  });
});
