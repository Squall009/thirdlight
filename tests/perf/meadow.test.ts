/**
 * The meadow perf class without a browser: its stand-in clump has the
 * triangle budget a game's grass clump has per level and the foliage
 * material's wind weights, its terrain and paint are the same every time and
 * fit the height range, its cover rule is a valid rule, the camera looks
 * across the field, and the sweep's load and proposed budget read the rows
 * as the log says.
 */
import { describe, expect, it } from 'vitest';

import { validateScatterRules, type ModelErrorV2 } from '@thirdlight/project-model';

import { MEADOW_SIDE, MEADOW_SPEC, meadowCamera, meadowCoverRule, meadowHeights, meadowPaint, meadowSamples, meadowTerrainRaw, proposeSweepBudget, SWEEP_CONFIGS, sweepLoad, yawPitchQuat, type SweepRow } from '../../tools/perf/meadow';
import { bladeClump, CLUMP_LEVELS, clumpKitGlb } from '../../tools/perf/village-assets';

describe('the meadow class', () => {
  it('has a stand-in clump of about 60, 20 and 6 triangles, rooted at y = 0, wind weights rising to the tip', () => {
    const tris = CLUMP_LEVELS.map((l) => bladeClump(1, l.blades, l.segments).idx.length / 3);
    expect(tris).toEqual([60, 21, 6]);
    const m = bladeClump(1, 12, 3, 0.8);
    let minY = Infinity;
    for (let k = 0; k < m.pos.length / 3; k += 1) {
      const y = m.pos[k * 3 + 1]!;
      minY = Math.min(minY, y);
      // COLOR_0 R (the bend weight) is 0 at the root and grows with height.
      if (y === 0) expect(m.color[k * 4]).toBe(0);
      expect(Math.hypot(m.nrm[k * 3]!, m.nrm[k * 3 + 1]!, m.nrm[k * 3 + 2]!)).toBeCloseTo(1, 5);
    }
    expect(minY).toBe(0);
    expect(m.height).toBeGreaterThan(0.4);
    expect(m.height).toBeLessThanOrEqual(0.8);
    // Every index names a vertex; no triangle is degenerate.
    const n = m.pos.length / 3;
    for (let t = 0; t < m.idx.length; t += 3) {
      const [a, b, c] = [m.idx[t]!, m.idx[t + 1]!, m.idx[t + 2]!];
      expect(Math.max(a, b, c)).toBeLessThan(n);
      expect(new Set([a, b, c]).size).toBe(3);
    }
    // The kit is a GLB with its three levels.
    const glb = clumpKitGlb(1);
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as { nodes: { name: string }[] };
    expect(json.nodes.map((x) => x.name)).toEqual(['clump_LOD0', 'clump_LOD1', 'clump_LOD2']);
  });

  it('is 1 km square, the same every time, its heights within the range and its rule valid', () => {
    expect(MEADOW_SIDE).toBe(1024);
    const h = meadowHeights();
    expect(h.length).toBe(meadowSamples() ** 2);
    const [lo, hi] = MEADOW_SPEC.terrain.heightRange;
    let min = Infinity;
    let max = -Infinity;
    for (const v of h) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThan(lo);
    expect(max).toBeLessThan(hi);
    expect(meadowTerrainRaw(h).length).toBe(h.length * 2);
    expect(JSON.stringify(meadowPaint())).toBe(JSON.stringify(meadowPaint()));
    for (const d of meadowPaint()) {
      expect(d.layer).toBeGreaterThanOrEqual(1);
      expect(d.layer).toBeLessThanOrEqual(3);
      expect(Math.max(Math.abs(d.at[0]), Math.abs(d.at[1]))).toBeLessThan(MEADOW_SIDE / 2);
    }
    const errors: ModelErrorV2[] = [];
    validateScatterRules([meadowCoverRule()], '/scatter', errors, false);
    expect(errors).toEqual([]);
  });

  it('looks from a corner across the field, a little down', () => {
    const c = meadowCamera();
    // three's view (-z) turned by the rotation points towards +x, -z and slightly down.
    const [x, y, z, w] = c.rotation;
    const fwd = [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
    expect(fwd[0]).toBeGreaterThan(0.6);
    expect(fwd[2]).toBeLessThan(-0.6);
    expect(fwd[1]).toBeLessThan(0);
    expect(fwd[1]).toBeGreaterThan(-0.2);
    expect(yawPitchQuat(0, 0)).toEqual([0, 0, 0, 1]);
  });

  it('sweeps from no grass up, and proposes the densest config that held the cap within the grass GPU time', () => {
    expect(SWEEP_CONFIGS[0]!.id).toBe('none');
    expect(new Set(SWEEP_CONFIGS.map((c) => c.id)).size).toBe(SWEEP_CONFIGS.length);
    for (const c of SWEEP_CONFIGS) for (let i = 1; i < c.rings.length; i += 1) expect(c.rings[i]!.radius).toBeGreaterThan(c.rings[i - 1]!.radius);
    // 8 a m² within 30 m: π·900·8 clumps of 60 triangles.
    const near8 = sweepLoad(SWEEP_CONFIGS.find((c) => c.id === 'near8')!, CLUMP_LEVELS);
    expect(near8.clumps).toBe(Math.round(Math.PI * 900 * 8));
    expect(near8.triangles).toBe(Math.round(Math.PI * 900 * 8 * 60));
    const row = (id: string, clumps: number, tris: number, missed = 0): SweepRow => ({ id, clumps, byRenderer: { webgpu: { p95: 16.8, missed, gpuMs: 9, tris }, webgl2: { p95: 16.7, missed: 0, gpuMs: null, tris } } });
    const rows = [row('none', 0, 100), row('a', 1000, 300), row('b', 5000, 900), row('c', 9000, 2000, 5), row('d', 20000, 2500)];
    // c missed the cap at 2,000k: half of it is 1,000k, so b (900k), not d (held, but heavier than the one that broke).
    expect(proposeSweepBudget(rows, 2)).toEqual({ id: 'b', clumps: 5000, tris: 900, brokeAt: { id: 'c', tris: 2000 } });
    expect(proposeSweepBudget(rows.filter((r) => r.id !== 'c'), 2)).toEqual({ id: 'd', clumps: 20000, tris: 2500, brokeAt: null });
    // One missed refresh in a window is the host's noise, not a miss.
    expect(proposeSweepBudget([row('none', 0, 1), row('z', 10, 50, 1)], 2)?.id).toBe('z');
    expect(proposeSweepBudget([row('none', 0, 1), row('x', 10, 50, 3), row('y', 5, 40, 2)], 2)).toBeNull();
  });
});
