/**
 * The occlusion oracle's counting on a small synthetic scene: id pictures
 * painted by hand (what the GPU pass writes), entries as the pass lists them.
 */
import { describe, expect, it } from 'vitest';

import { countOracle, hiddenEntries, hiddenFractions, memberTriangles, oracleIdAt, oracleIdBytes, type OracleEntry } from './occlusion-oracle-count';

const W = 16;
const H = 8;

/** An RGBA8 picture with rectangles of ids painted in order (later ones in front). */
function picture(rects: readonly [id: number, x0: number, y0: number, x1: number, y1: number][]): Uint8Array {
  const px = new Uint8Array(W * H * 4);
  for (const [id, x0, y0, x1, y1] of rects) {
    const [r, g, b] = oracleIdBytes(id);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) px.set([r, g, b, 255], (y * W + x) * 4);
    }
  }
  return px;
}

describe('occlusion oracle counting', () => {
  it('round-trips 24-bit ids through a pixel', () => {
    for (const id of [1, 255, 256, 65535, 65536, 1_234_567, 2 ** 24 - 1]) {
      const px = new Uint8Array([...oracleIdBytes(id), 255]);
      expect(oracleIdAt(px, 0)).toBe(id);
    }
    expect(oracleIdAt(new Uint8Array([9, 9, 9, 0]), 0)).toBe(0);
  });

  it('counts hidden items, draws and triangles by kind', () => {
    // A wall (id 1) in front; four instanced copies (2-5) of which two show beside it; a merged cell of three
    // members (6-8): 6 shows, 7 is behind the wall, 8 was outside the view's range (no triangles drawn); a
    // single prop (9) wholly behind the wall; a transparent pane (10) seen in the second picture.
    const entries: OracleEntry[] = [
      { kind: 'single', base: 1, count: 1, triangles: 12, draws: 1 },
      { kind: 'instanced', base: 2, count: 4, triangles: 100, draws: 1 },
      { kind: 'merged', base: 6, count: 3, triangles: [30, 50, 0], draws: 1 },
      { kind: 'single', base: 9, count: 1, triangles: 500, draws: 2 },
      { kind: 'transparent', base: 10, count: 1, triangles: 2, draws: 1 },
    ];
    const opaque = picture([
      [2, 8, 0, 10, 2],
      [4, 12, 0, 14, 2],
      [6, 8, 4, 16, 8],
      // The wall covers the left half, over everything behind it there.
      [1, 0, 0, 8, 8],
    ]);
    const transparent = picture([[10, 9, 3, 11, 4]]);
    const c = countOracle(entries, [opaque, transparent]);

    expect(c.stray).toBe(0);
    expect(c.byKind.instanced).toEqual({ items: 4, hiddenItems: 2, draws: 1, hiddenDraws: 0, triangles: 400, hiddenTriangles: 200 });
    // The member not drawn counts neither way.
    expect(c.byKind.merged).toEqual({ items: 2, hiddenItems: 1, draws: 1, hiddenDraws: 0, triangles: 80, hiddenTriangles: 50 });
    expect(c.byKind.single).toEqual({ items: 2, hiddenItems: 1, draws: 3, hiddenDraws: 2, triangles: 512, hiddenTriangles: 500 });
    expect(c.byKind.transparent.hiddenItems).toBe(0);
    expect(c.total).toEqual({ items: 9, hiddenItems: 4, draws: 6, hiddenDraws: 2, triangles: 994, hiddenTriangles: 750 });
    expect(hiddenFractions(c.total)).toEqual({ items: 0.444, draws: 0.333, triangles: 0.755 });
    // Whole draws an ideal culling skips: only the prop behind the wall (the merged cell shows one member).
    expect(hiddenEntries(entries, [opaque, transparent]).map((e) => e.base)).toEqual([9]);
  });

  it('reports ids that belong to no entry as stray', () => {
    const entries: OracleEntry[] = [{ kind: 'single', base: 1, count: 1, triangles: 2, draws: 1 }, { kind: 'single', base: 5, count: 1, triangles: 2, draws: 1 }];
    // Id 3 lies in the range but no entry owns it; 70,000 lies past every entry.
    const c = countOracle(entries, [picture([[1, 0, 0, 1, 1], [3, 1, 0, 2, 1], [70_000, 2, 0, 4, 1]])]);
    expect(c.stray).toBe(3);
    expect(c.covered).toBe(4);
    expect(c.total.hiddenItems).toBe(1);
  });

  it('gives a merged draw\'s triangles to the members whose vertices they use', () => {
    // Members at vertices 0-3, 4-9 and 10-12; the drawn range holds two triangles of the second and one of the first.
    const index = [4, 5, 6, 7, 8, 9, 0, 1, 2, 10, 11, 12];
    expect([...memberTriangles(index, 0, 9, [0, 4, 10])]).toEqual([1, 2, 0]);
    expect([...memberTriangles(index, 0, 12, [0, 4, 10])]).toEqual([1, 2, 1]);
  });
});
