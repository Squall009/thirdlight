/**
 * Open regions on the generated town (the world rules' derive in this process, 16³ sections, a box of 6 × 3 × 6
 * chunks): every house standing whole in the box in the world grid is one enclosed region of its rooms (its storeys
 * joined by the stair holes, its attic under the roof), its doors and windows portals to the street; the street is
 * under the sky. The houses are counted from the generator's own lots, not from the labels.
 */
import { describe, expect, it } from 'vitest';
import { OpenRegionStitch, type RegionStreamerView } from '@thirdlight/voxel';

import { walkWorld, WALK_GRID } from './walk-world';
import { townWorld } from './worlds';

describe('open regions on the town', () => {
  const world = townWorld({ footprint: 512 });
  // World chunks 5 … 10 on x and z (the box's −3 … 2 moved by 8), y −1 … 1.
  const w = walkWorld(world, [-3, -1, -3], [2, 1, 2], [8, 0, 8]);
  const view: RegionStreamerView = { grid: WALK_GRID, sections: { edge: 16, shift: 4, mask: 15, cellsPerChunk: 4096, chunkMinXZ: 0, chunkMinY: 0, chunkSpanXZ: 0, chunkSpanY: 0 } as never, derivedOf: (sx, sy, sz) => w.view().derivedOf(sx, sy, sz) };

  it('gives each house in the box one enclosed region with portals, and the street the sky', () => {
    const s = new OpenRegionStitch(view);
    for (let cx = -3; cx <= 2; cx++) for (let cy = -1; cy <= 1; cy++) for (let cz = -3; cz <= 2; cz++) s.touch(cx, cy, cz);
    const t0 = performance.now();
    s.update();
    const ms = performance.now() - t0;
    const stats = s.stats();
    const enclosed = [...s.all()].filter((r) => r.enclosed);
    console.log(`[open-regions town] ${JSON.stringify(stats)}, ${s.bytes} B, stitched in ${ms.toFixed(1)} ms; enclosed ${JSON.stringify(enclosed.map((r) => ({ m3: r.cells / 8, portals: r.portals })))}`);
    expect(stats.pieces).toBe(108);
    expect(enclosed.length).toBeGreaterThan(0);
    for (const r of enclosed) expect(r.portals).toBeGreaterThan(0);
    // The street 4 m up at a lot's corner (box cell 24 is world cell 280, the lot's first cells: no house) is under the sky.
    const street = s.regionAt(24, 8, 24)!;
    expect(street.enclosed).toBe(false);
    expect(street.sky).toBe(true);
    expect(s.skyAt(24, 8, 24)).toBe(true);
    // Houses of 8–14 m by 8–14 m, one to three 3 m storeys and a 45° roof: 190–2,000 m³ each, never more than one
    // house a region (a leak through a roof or a wall would join one to the street, or two houses together).
    expect(enclosed.length).toBeGreaterThanOrEqual(15);
    for (const r of enclosed) expect(r.cells / 8).toBeGreaterThan(190);
    for (const r of enclosed) expect(r.cells / 8).toBeLessThan(2000);
  });
});
