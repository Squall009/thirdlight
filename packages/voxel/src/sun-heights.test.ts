/**
 * The sun heights: a far node's tops against the brick march coming straight down, the far window composed from
 * nodes as they come and go (the highest over a column, cleared tiles on a move, wrapped uploads), the near window
 * from sky heights, and the march's reference: what stands toward the sun shades, what lies before a map's exit is
 * left to the map.
 */
import { describe, expect, it } from 'vitest';
import { CPU_SCALAR_OPS } from '@thirdlight/shared';

import { chunkGrid } from './coords';
import { farBricksFromFaces } from './far-bricks-faces';
import { marchFarNodeFrom } from './far-bricks-node';
import { createWorldStore, type PaletteStore } from './palette-store';
import { SHAPE_FULL, VOXEL_ROLE } from './record';
import { SKY_NONE, SkyColumns } from './sky-columns';
import { composeSkyTile, farBrickTops, FarSunTops, SUN_HEIGHT_NONE, SUN_HEIGHT_UNKNOWN, SunHeightWindow, sunLit, sunShadeAt, type SunColumn } from './sun-heights';

const grid = chunkGrid(32);

/** Ground rising along x (y = 40 + x / 4 over node (0, 1, 0)'s cells) with a block 6 cells tall on it at x, z 10–16. */
function hill(): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = -8; x < 40; x++) for (let z = -8; z < 40; z++) {
    const top = 40 + Math.floor(Math.max(0, x) / 4) + (x >= 10 && x < 16 && z >= 10 && z < 16 ? 6 : 0);
    for (let y = 24; y < top; y++) s.setVoxel(x, y, z, { material: 7, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
  }
  return s;
}

describe('far node tops', () => {
  it('meet the brick march coming straight down every sample column', () => {
    const b = farBricksFromFaces(grid, hill(), [0, 1, 0], 1);
    const tops = farBrickTops(b);
    const n = b.side * 8 + 1;
    expect(tops.length).toBe(n * n);
    let worst = 0;
    let compared = 0;
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const hit = marchFarNodeFrom(b, [x, n + 2, z], [0, -1, 0]);
      const top = tops[z * n + x]!;
      // A ray down the node's outer face runs along its box's side, which the march leaves at once.
      if (hit === null) {
        if (x > 0 && z > 0 && x < n - 1 && z < n - 1) expect(top, `column ${x}, ${z}`).toBe(-Infinity);
        continue;
      }
      compared++;
      worst = Math.max(worst, Math.abs(n + 2 - hit.t - top));
    }
    expect(compared).toBeGreaterThan(n * n * 0.9);
    // The march stops within its hit distance plus its shortest step of where the field crosses it.
    expect(worst).toBeLessThan(0.35);
    // The block stands 6 cells over the ground beside it (node cells from the node's floor at y 32).
    expect(tops[13 * n + 13]! - tops[13 * n + 20]!).toBeGreaterThan(4);
    expect(tops[13 * n + 20]!).toBeCloseTo(40 + 5 - 32, 0);
  });
});

/** A node of level 0 (cells 0.5 m, a node 16 m) whose tops are all `h` cells. */
function flatNode(h: number): Parameters<FarSunTops['add']>[2] {
  const s = createWorldStore(grid);
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < h; y++) s.setVoxel(x, y, z, { material: 7, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
  return farBricksFromFaces(grid, s, [0, 0, 0], 1);
}

describe('the far window', () => {
  it('is the highest of the nodes over a column, composed again as they come and go', () => {
    const f = new FarSunTops(32, 0.5, 1);
    f.window.follow(0, 0);
    while (f.composeNext());
    f.window.takeChanged();
    // Two nodes over one place (as a coarse node and the finer ones drawn inside it would be).
    f.add('low', { level: 0, nx: 0, ny: 0, nz: 0 }, flatNode(10));
    f.add('high', { level: 0, nx: 0, ny: 0, nz: 0 }, flatNode(20));
    expect(f.window.waiting).toBeGreaterThan(0);
    while (f.composeNext());
    expect(f.window.topAt(4.5, 4.5)).toBeCloseTo(10, 1);
    const changed = f.window.takeChanged();
    expect(changed.length).toBeGreaterThan(0);
    f.remove('high');
    while (f.composeNext());
    expect(f.window.topAt(4.5, 4.5)).toBeCloseTo(5, 1);
    f.remove('low');
    while (f.composeNext());
    expect(f.window.topAt(4.5, 4.5)).toBe(SUN_HEIGHT_UNKNOWN);
    expect(f.bytes).toBe(0);
  });

  it('clears the tiles that enter on a move and keeps the rest', () => {
    const w = new SunHeightWindow(1, 64, 16);
    w.follow(0, 0);
    while (w.next() !== null);
    w.set(5, 5, 42);
    w.takeChanged();
    // One tile east: the four tiles of the new column enter, cleared and waiting; the column kept reads as before.
    expect(w.follow(16, 0)).toBe(true);
    expect(w.waiting).toBe(4);
    expect(w.topAt(5.5, 5.5)).toBe(42);
    const entered = w.takeChanged();
    expect(entered.length).toBe(4);
    // Wrapped: the entering column lands where the one that left was (texel x 32 of 64 for tile 2 … here tile 2).
    for (const c of entered) expect(w.data.subarray(c.offset, c.offset + c.count).every((v) => v === SUN_HEIGHT_UNKNOWN)).toBe(true);
    // Tile column 2 of 4 (slots 2, 6, 10, 14 of 16 tiles of 256 columns): where tile column −2 was.
    expect(entered.map((c) => c.offset / 256).sort((a, b) => a - b)).toEqual([2, 6, 10, 14]);
    expect(w.topAt(-20, 0)).toBe(SUN_HEIGHT_UNKNOWN);
  });
});

describe('the near window', () => {
  it('takes the highest sky top of the worlds drawn, open sky where nothing is solid', () => {
    const w = new SunHeightWindow(0.5, 128, 32);
    w.follow(0, 0);
    while (w.next() !== null);
    const a = new SkyColumns(32);
    const b = new SkyColumns(32);
    const ha = new Int16Array(32 * 32).fill(SKY_NONE);
    ha[3 * 32 + 4] = 20;
    const hb = new Int16Array(32 * 32).fill(SKY_NONE);
    hb[3 * 32 + 4] = 30;
    a.apply([{ cx: 0, cz: 0, heights: ha }]);
    b.apply([{ cx: 0, cz: 0, heights: hb }]);
    composeSkyTile(w, 0, 0, [a, b], 0.5);
    // Cell (3, 4): x 1.5–2 m, z 2–2.5 m; its top cell 30 → 15 m.
    expect(w.topAt(1.75, 2.25)).toBe(15);
    expect(w.topAt(0.25, 0.25)).toBe(SUN_HEIGHT_NONE);
    composeSkyTile(w, 1, 0, [a, b], 0.5);
    expect(w.topAt(16.25, 0.25)).toBe(SUN_HEIGHT_UNKNOWN);
  });
});

describe('the shade line (reference)', () => {
  // A wall 10 m tall over x = 20–22 m; ground at 0 elsewhere; 1 m columns. The sun 45° up from +x.
  const at = (x: number): SunColumn => ({ top: x >= 20 && x < 22 ? 10 : 0, cellM: 1 });
  const column = (x: number, _z: number): SunColumn => at(x);
  const sun = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const opts = { steps: 32, topMax: 10, farFrom: 0, ops: CPU_SCALAR_OPS };
  const lit = (x: number, y: number, o = opts): number => sunLit(CPU_SCALAR_OPS, y, sunShadeAt(column, x + 0.5, 0.5, sun, o).all, 1);

  it("shades the ground on the wall's far side from the sun and lights the near side", () => {
    expect(lit(15, 0.75)).toBe(0);
    expect(lit(25, 0.75)).toBe(1);
    // Past the shadow's reach (10 m of wall at 45°): lit again; up the shaded column, lit above the wall's line.
    expect(lit(5, 0.75)).toBe(1);
    expect(lit(15, 8)).toBe(1);
  });

  it('counts only casters from `farFrom` across in `far`, and nothing under a low sun', () => {
    const near = sunShadeAt(column, 15.5, 0.5, sun, { ...opts, farFrom: 12 });
    expect(near.all).toBeGreaterThan(0);
    expect(near.far).toBe(SUN_HEIGHT_NONE);
    const low = sunShadeAt(column, 15.5, 0.5, [1, 0.01, 0], opts);
    expect(low.all).toBe(0);
    expect(sunShadeAt(column, 15.5, 0.5, sun, { ...opts, steps: 0 }).all).toBe(0);
  });
});
