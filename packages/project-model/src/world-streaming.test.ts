import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { decodeTerrainOverview, encodeTerrainOverview, terrainOverviewTile, TERRAIN_OVERVIEW_SAMPLES } from './terrain-overview';
import { setTerrainHole, terrainHoleAt, terrainLayersAt, writeSampleLayers, TERRAIN_PAINT_BYTES, TERRAIN_WEIGHT_BYTES, type TerrainTile } from './terrain-tile';
import { inStreamRing, nearestSquareDistance, resolveStreamingRings, squareDistance, streamingBudgetBytesOf, STREAMING_BUDGET_DEFAULT_MB, validateStreamingRings } from './world-streaming';

describe('world streaming rings', () => {
  it('resolves the rings with their defaults', () => {
    expect(resolveStreamingRings(undefined)).toBeNull();
    const r = resolveStreamingRings({ render: 1000 })!;
    expect(r.render).toEqual({ radius: 1000, hysteresis: 100 });
    // Collision and scatter fall back to the render ring, live to collision.
    expect(r.collision.radius).toBe(1000);
    expect(r.scatter.radius).toBe(1000);
    const s = resolveStreamingRings({ render: 1000, collision: 64, hysteresis: 10 })!;
    expect(s.collision).toEqual({ radius: 64, hysteresis: 10 });
    expect(s.live).toEqual({ radius: 64, hysteresis: 10 });
    expect(s.scatter).toEqual({ radius: 1000, hysteresis: 10 });
  });

  it('keeps a loaded cell past its ring until it is past the hysteresis', () => {
    const ring = { radius: 100, hysteresis: 10 };
    expect(inStreamRing(100, ring, false)).toBe(true);
    expect(inStreamRing(105, ring, false)).toBe(false);
    expect(inStreamRing(105, ring, true)).toBe(true);
    expect(inStreamRing(111, ring, true)).toBe(false);
  });

  it('measures across the ground to a square', () => {
    expect(squareDistance(0, 0, 10, 10, 5, 5)).toBe(0);
    expect(squareDistance(0, 0, 10, 10, 13, 14)).toBe(5);
    expect(nearestSquareDistance(0, 0, 10, 10, [[20, 0, 5], [5, 99, -3]])).toBe(3);
    expect(nearestSquareDistance(0, 0, 10, 10, [])).toBe(Infinity);
  });

  it('checks the component field', () => {
    const errs = (v: unknown, live: boolean): string[] => {
      const e: ModelErrorV2[] = [];
      validateStreamingRings(v, '/s', e, live);
      return e.map((x) => `${x.code} ${x.path}`);
    };
    expect(errs({ render: 500, collision: 50, scatter: 300, hysteresis: 5 }, false)).toEqual([]);
    expect(errs({ render: 500, live: 20 }, true)).toEqual([]);
    expect(errs({ render: 500, live: 20 }, false)).toEqual(['field_unexpected /s/live']);
    expect(errs({ collision: 5 }, false)).toEqual(['field_missing /s/render']);
    expect(errs({ render: 0 }, false)).toEqual(['field_value /s/render']);
    expect(errs(3, false)).toEqual(['field_type /s']);
  });

  it('reads the budget setting', () => {
    expect(streamingBudgetBytesOf(undefined)).toBe(STREAMING_BUDGET_DEFAULT_MB * 1024 * 1024);
    expect(streamingBudgetBytesOf({ streaming_budget_mb: 64 })).toBe(64 * 1024 * 1024);
  });
});

describe('terrain overview', () => {
  const s = 65;
  const full = (): TerrainTile => {
    const heights = new Uint16Array(s * s);
    for (let i = 0; i < heights.length; i++) heights[i] = (i * 7919) % 65536;
    const weights = new Uint8Array(s * s * TERRAIN_WEIGHT_BYTES);
    for (let i = 0; i < s * s; i++) writeSampleLayers(weights, i * TERRAIN_WEIGHT_BYTES, [i % 3, 5], [200, 55]);
    const paint = new Uint8Array(s * s * TERRAIN_PAINT_BYTES);
    // Hand paint at one sample the overview takes (row 4, column 8): all layer 7.
    const at = 4 * s + 8;
    paint[at * TERRAIN_PAINT_BYTES] = 7;
    paint[at * TERRAIN_PAINT_BYTES + 4] = 255;
    paint[at * TERRAIN_PAINT_BYTES + 8] = 255;
    const t: TerrainTile = { samples: s, heights, weights, holes: null, paint };
    // The overview's cell (2, 1) covers full cells x 8..11, z 4..7: half of them holes; cell (0, 0) one in sixteen.
    for (let z = 4; z < 8; z++) for (let x = 8; x < 10; x++) setTerrainHole(t, x, z, true);
    setTerrainHole(t, 0, 0, true);
    return t;
  };

  it('takes the heights the coarsest level draws, the layers shown there and the holes by majority', () => {
    const t = full();
    const o = terrainOverviewTile(t);
    expect(o.samples).toBe(TERRAIN_OVERVIEW_SAMPLES);
    const step = (s - 1) / (TERRAIN_OVERVIEW_SAMPLES - 1);
    for (let j = 0; j < TERRAIN_OVERVIEW_SAMPLES; j++) for (let i = 0; i < TERRAIN_OVERVIEW_SAMPLES; i++) expect(o.heights[j * TERRAIN_OVERVIEW_SAMPLES + i]).toBe(t.heights[j * step * s + i * step]);
    // Layers as the tile shows them (paint mixed in): the painted sample is layer 7.
    expect(terrainLayersAt(o, 1 * TERRAIN_OVERVIEW_SAMPLES + 2)).toEqual(terrainLayersAt(t, 4 * s + 8));
    expect(terrainLayersAt(o, 1 * TERRAIN_OVERVIEW_SAMPLES + 2).layers).toEqual([7]);
    expect(terrainLayersAt(o, 0)).toEqual(terrainLayersAt(t, 0));
    expect(o.paint).toBeNull();
    expect(terrainHoleAt(o, 2, 1)).toBe(true);
    expect(terrainHoleAt(o, 0, 0)).toBe(false);
  });

  it('round-trips through its payload', () => {
    const tiles = [{ x: -3, z: 7, tile: terrainOverviewTile(full()) }, { x: 0, z: 0, tile: terrainOverviewTile({ samples: 17, heights: new Uint16Array(17 * 17).fill(9), weights: null, holes: null, paint: null }) }];
    const back = decodeTerrainOverview(encodeTerrainOverview(tiles));
    expect(back.map((t) => [t.x, t.z])).toEqual([[-3, 7], [0, 0]]);
    expect(Array.from(back[0]!.tile.heights)).toEqual(Array.from(tiles[0]!.tile.heights));
    expect(Array.from(back[0]!.tile.weights!)).toEqual(Array.from(tiles[0]!.tile.weights!));
    expect(Array.from(back[0]!.tile.holes!)).toEqual(Array.from(tiles[0]!.tile.holes!));
    expect(back[1]!.tile.heights[5]).toBe(9);
    expect(() => decodeTerrainOverview(new Uint8Array([2, 0, 0, 0, 0]))).toThrow(/layout/);
  });
});
