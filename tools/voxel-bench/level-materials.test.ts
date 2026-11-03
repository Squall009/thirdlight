/**
 * The material a coarse level shows on the ground is the one level 0 shows
 * at the same place: a surface layer thinner than a coarse cell (grass over
 * earth) must not give way, at that level, to what lies under it. While the
 * downsample took the dominant material and the shader read a quarter of a
 * coarse cell deep, 21 % (level 1) and 71 % (level 2) of the columns of a
 * 128 m square of the slice's hills, and 74 % / 85 % of the hard cases',
 * showed earth where level 0 shows grass.
 */
import { chunkGrid, createWorldStore, TERRAIN_RULES, VOXEL_SIZE_M } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { FEATURE_BASE, FEATURE_PAD, FEATURE_TOP, featuresStore } from './features';
import { levelMaterialMismatch, levelSurfaces, type LevelMaterialResult } from './level-materials';
import { loadArea, surfaceY } from './regions';
import { hillyWorld } from './worlds';

const grid = chunkGrid(32);
/** The slice page's blend distance (metres). */
const BLEND_M = VOXEL_SIZE_M / 2;
/** Share of columns a level may show another material than level 0 (where the two surfaces lie a cell apart, at creases). */
const MISMATCH_BOUND = 0.005;

function expectMatch(r: readonly LevelMaterialResult[]): void {
  expect(r.map((l) => l.level)).toEqual([1, 2]);
  for (const l of r) {
    expect(l.samples).toBeGreaterThan(10_000);
    expect(l.share, `level ${l.level}: ${JSON.stringify(l.pairs)}`).toBeLessThanOrEqual(MISMATCH_BOUND);
  }
}

describe('the material shown at every level', () => {
  it("matches level 0 on the slice's hills at levels 1 and 2", () => {
    const store = createWorldStore(grid);
    // A hilly 64 m square of the slice world (its generator, slopes on every side, above the lakes), a level-2 node of margin round it.
    const [x0, z0] = [-256, 0];
    const size = 128;
    loadArea(hillyWorld({ footprint: 1024 }).grids[0]!, store, x0 - 128, z0 - 128, x0 + size + 128, z0 + size + 128);
    let lo = Infinity, hi = -Infinity;
    for (let x = x0; x < x0 + size; x += 8) for (let z = z0; z < z0 + size; z += 8) {
      const y = surfaceY(store, x, z, 400, -64)!;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    expect(hi - lo).toBeGreaterThan(16);
    const s = levelSurfaces(store, TERRAIN_RULES, { x0, x1: x0 + size, z0, z1: z0 + size, y0: lo - 8, y1: hi + 8 }, 2);
    expectMatch(levelMaterialMismatch(s, { margin: 8, blendM: BLEND_M }));
  }, 120_000);

  it('matches level 0 on the hard cases at levels 1 and 2', () => {
    // The first 8 cases (slopes, bank, cliff, terraces, overhang, arch: two level-2 nodes); the thin ones after them
    // leave the coarse levels by the fill, and deriving them too would double the test's time.
    const s = levelSurfaces(featuresStore(), TERRAIN_RULES, { x0: 0, x1: 8 * FEATURE_PAD, z0: 0, z1: FEATURE_PAD, y0: FEATURE_BASE, y1: FEATURE_TOP }, 2);
    expectMatch(levelMaterialMismatch(s, { margin: 8, blendM: BLEND_M }));
  }, 120_000);
});
