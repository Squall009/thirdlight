import { describe, expect, it } from 'vitest';
import { flatTerrainTile, terrainLayersAt, type TerrainTile } from '@thirdlight/runtime';

import { metresPerStep, packFlat, packHeightNormal, packHeightNormalAlone, packHeightNormalBorder, packLayers, TERRAIN_TEXEL_BYTES } from './terrain-texels';

const S = 17;
const tileOf = (f: (x: number, z: number) => number): TerrainTile => {
  const t = flatTerrainTile(S, 0);
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) t.heights[z * S + x] = f(x, z);
  return t;
};

describe('terrain tile texels', () => {
  it('keeps the 16-bit step and gives neighbouring tiles the same normal on their shared edge', () => {
    // A slope over two tiles side by side: global x = tile * 16 + x.
    const height = (gx: number, gz: number): number => 20000 + gx * 37 + gx * gx * 9 + gz * gz * 3;
    const a = tileOf((x, z) => height(x, z));
    const b = tileOf((x, z) => height(16 + x, z));
    const tiles = new Map([
      ['0,0', a],
      ['1,0', b],
    ]);
    const nb = (tx: number) => (dx: number, dz: number) => tiles.get(`${tx + dx},${dz}`);
    const pa = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
    const pb = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
    const mps = metresPerStep([-100, 300]);
    packHeightNormal(pa, a, nb(0), mps, 1);
    packHeightNormal(pb, b, nb(1), mps, 1);
    for (let z = 0; z < S; z++) {
      const ea = (z * S + 16) * 4;
      const eb = (z * S + 0) * 4;
      expect((pa[ea]! << 8) | pa[ea + 1]!).toBe(height(16, z));
      expect([pa[ea + 2], pa[ea + 3]]).toEqual([pb[eb + 2], pb[eb + 3]]);
    }
    // The slope rises along +x: the normal leans toward −x.
    expect(pa[(8 * S + 8) * 4 + 2]!).toBeLessThan(127);
    // Packed alone (off the page), then its border again with the neighbours: the same texels.
    const alone = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
    packHeightNormalAlone(alone, a, mps, 1);
    expect(alone).not.toEqual(pa);
    packHeightNormalBorder(alone, a, nb(0), mps, 1);
    expect(alone).toEqual(pa);
  });

  it('mixes baked weights and hand paint as the surface queries do, and marks hole cells', () => {
    const t = flatTerrainTile(S, 0);
    t.weights = new Uint8Array(S * S * 8);
    t.paint = new Uint8Array(S * S * 9);
    t.holes = new Uint8Array(Math.ceil((16 * 16) / 8));
    for (let i = 0; i < S * S; i++) {
      // Baked: layer 1 (200) and layer 2 (55); paint: layer 3 (255) at amount i % 256.
      t.weights.set([1, 2, 0, 0, 200, 55, 0, 0], i * 8);
      t.paint.set([3, 0, 0, 0, 255, 0, 0, 0, i % 256], i * 9);
    }
    t.holes[0] = 0b10; // cell (1, 0)
    const out = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
    const ids = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
    packLayers(out, ids, t);
    expect([...ids.subarray(0, 4)]).toEqual([0, 1, 2, 3]);
    for (const i of [0, 40, 128, 288]) {
      const { layers, weights } = terrainLayersAt(t, i);
      const want = [0, 0, 0, 0];
      layers.forEach((l, k) => (want[l] = weights[k]!));
      for (let c = 0; c < 3; c++) expect(Math.abs(out[i * 4 + c]! - want[c]!), `sample ${i} layer ${c}`).toBeLessThanOrEqual(1);
    }
    expect(out[1 * 4 + 3]).toBe(255);
    expect(out[0 * 4 + 3]).toBe(0);
    // The last column's samples own no cell.
    expect(out[16 * 4 + 3]).toBe(0);
  });

  it('draws any layer: a layer goes in channel layer % 4 with its index; an empty channel takes a neighbour\'s layer', () => {
    const t = flatTerrainTile(S, 0);
    t.weights = new Uint8Array(S * S * 8);
    for (let i = 0; i < S * S; i++) t.weights.set([7, 1, 0, 0, 155, 100, 0, 0], i * 8);
    // Sample 5 has layer 12 (channel 0) instead of layer 1.
    t.weights.set([7, 12, 0, 0, 155, 100, 0, 0], 5 * 8);
    const out = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
    const ids = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
    packLayers(out, ids, t);
    // Channel 1 = layer 1 (100), channel 3 = layer 7 (the rest, 155).
    expect([out[0], out[1], out[2]]).toEqual([0, 100, 0]);
    expect([...ids.subarray(0, 4)]).toEqual([0, 1, 2, 7]);
    // Sample 4, next to sample 5: its empty channel 0 names layer 12 (the weight filtered in from 5 is that layer's).
    expect([...ids.subarray(4 * 4, 5 * 4)]).toEqual([12, 1, 2, 7]);
    expect([...ids.subarray(5 * 4, 6 * 4)]).toEqual([12, 1, 2, 7]);
    expect([out[5 * 4], out[5 * 4 + 1]]).toEqual([100, 0]);
    // Two layers in one channel at a sample: the stronger shows and takes the other's share.
    t.weights.set([3, 7, 0, 0, 60, 195, 0, 0], 0);
    packLayers(out, ids, t);
    expect([out[0], out[1], out[2], ids[3]]).toEqual([0, 0, 0, 7]);
  });

  it('a flat tile: filled texels', () => {
    const h = new Uint8Array(S * S * 4);
    const w = new Uint8Array(S * S * 4);
    const ids = new Uint8Array(S * S * 4);
    packFlat(h, w, ids, 0x1234);
    expect([...h.subarray(40, 44)]).toEqual([0x12, 0x34, 128, 128]);
    expect([...w.subarray(40, 44)]).toEqual([255, 0, 0, 0]);
    expect([...ids.subarray(40, 44)]).toEqual([0, 1, 2, 3]);
  });
});
