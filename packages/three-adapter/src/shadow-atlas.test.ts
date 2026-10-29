/**
 * The shadow atlas's plan (pure): tiles never overlap and stay inside the
 * atlas, sizes follow the rank, small rank changes move nothing, a full
 * atlas leaves the lowest-ranked lights unshadowed (and the light a better
 * one displaces fades out before its tile is given away), and the redraws
 * stay within their share of the atlas a frame.
 */
import { describe, expect, it } from 'vitest';

import { ATLAS_FADE_SECONDS, ATLAS_HOLD_FRAMES, ATLAS_REDRAW_SHARE, QuadAllocator, ShadowAtlasPlan, shadowRank, SPOT_TILE_MAX, SPOT_TILE_MIN, tileSizeFor, type AtlasGrant, type AtlasRequest, type AtlasTile } from './shadow-atlas';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function overlaps(a: AtlasTile, b: AtlasTile): boolean {
  return a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size;
}

function expectDisjoint(tiles: readonly AtlasTile[], side: number): void {
  for (const t of tiles) {
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(t.x + t.size).toBeLessThanOrEqual(side);
    expect(t.y + t.size).toBeLessThanOrEqual(side);
    expect(t.x % t.size).toBe(0);
    expect(t.y % t.size).toBe(0);
  }
  for (let i = 0; i < tiles.length; i += 1) for (let j = i + 1; j < tiles.length; j += 1) expect(overlaps(tiles[i]!, tiles[j]!), `${JSON.stringify(tiles[i])} ${JSON.stringify(tiles[j])}`).toBe(false);
}

const keys = Array.from({ length: 64 }, (_, i) => ({ light: i }));
const req = (i: number, rank: number, dirty = false, fade = 1): AtlasRequest => ({ key: keys[i]!, rank, fade, dirty });

/** Run frames of 1/60 s until the grants settle (fades done). */
function settle(plan: ShadowAtlasPlan, requests: readonly AtlasRequest[], frames = 40): ReadonlyMap<object, AtlasGrant> {
  let g: ReadonlyMap<object, AtlasGrant> = new Map();
  for (let f = 0; f < frames; f += 1) g = plan.update(requests, 1 / 60);
  return g;
}

describe('the quadtree allocator', () => {
  it('packs power-of-two tiles without overlap, merges freed siblings, and fails only when full', () => {
    const rnd = mulberry32(7);
    const side = 2048;
    const a = new QuadAllocator(side, 128);
    const held: AtlasTile[] = [];
    for (let step = 0; step < 4000; step += 1) {
      if (held.length > 0 && rnd() < 0.45) {
        a.release(held.splice(Math.floor(rnd() * held.length), 1)[0]!);
      } else {
        const size = 128 << Math.floor(rnd() * 4);
        const t = a.alloc(size);
        if (t !== null) held.push(t);
        else expect(a.freeTexels()).toBeLessThan(side * side);
      }
      if (step % 200 === 0) expectDisjoint(held, side);
      expect(a.freeTexels() + held.reduce((s, t) => s + t.size * t.size, 0)).toBe(side * side);
    }
    for (const t of held.splice(0)) a.release(t);
    // Everything freed merges back into the whole atlas.
    expect(a.alloc(side)).toEqual({ x: 0, y: 0, size: side });
  });
});

describe('the shadow atlas plan', () => {
  it('sizes tiles by rank (largest near, never past the atlas) and fades shadows with distance', () => {
    expect(tileSizeFor(2, 4096)).toBe(SPOT_TILE_MAX);
    expect(tileSizeFor(0.5, 4096)).toBe(SPOT_TILE_MAX);
    expect(tileSizeFor(0.25, 4096)).toBe(SPOT_TILE_MAX / 2);
    expect(tileSizeFor(0.01, 4096)).toBe(SPOT_TILE_MIN);
    expect(tileSizeFor(2, 512)).toBe(512);
    const near = shadowRank(8, 4, true);
    const far = shadowRank(8, 39, true);
    expect(near.rank).toBeGreaterThan(far.rank);
    expect(near.fade).toBe(1);
    expect(far.fade).toBeGreaterThan(0);
    expect(far.fade).toBeLessThan(0.1);
    expect(shadowRank(8, 4, false).rank).toBe(0);
    expect(shadowRank(8, 41, true).rank).toBe(0);
  });

  it('gives tiles best rank first, without overlap, and draws them; a light gaining a tile fades in', () => {
    const plan = new ShadowAtlasPlan(4096);
    const requests = Array.from({ length: 20 }, (_, i) => req(i, 2 / (i + 1)));
    const first = plan.update(requests, 1 / 60);
    // New tiles: drawn (within the frame's share), not sampled until drawn, then faded in.
    const drawnTexels = [...first.values()].reduce((s, g) => s + (g.draw?.size ?? 0) ** 2, 0);
    expect(drawnTexels).toBeLessThanOrEqual(4096 * 4096 * ATLAS_REDRAW_SHARE);
    const g0 = first.get(keys[0]!)!;
    expect(g0.draw).not.toBeNull();
    expect(g0.intensity).toBeGreaterThan(0);
    expect(g0.intensity).toBeLessThan(0.2);
    const g = settle(plan, requests);
    const tiles = [...g.values()].map((x) => x.tile).filter((t): t is AtlasTile => t !== null);
    expect(tiles.length).toBe(20);
    expectDisjoint(tiles, 4096);
    expect(g.get(keys[0]!)!.tile!.size).toBe(SPOT_TILE_MAX);
    expect(g.get(keys[19]!)!.tile!.size).toBeLessThan(SPOT_TILE_MAX);
    expect(g.get(keys[0]!)!.intensity).toBe(1);
    // Settled and clean: nothing is drawn again.
    expect([...plan.update(requests, 1 / 60).values()].every((x) => x.draw === null)).toBe(true);
    // A dirty light's tile only.
    const dirty = plan.update(requests.map((r, i) => (i === 3 ? { ...r, dirty: true } : r)), 1 / 60);
    expect([...dirty.entries()].filter(([, x]) => x.draw !== null).map(([k]) => k)).toEqual([keys[3]]);
  });

  it('keeps a tile size through small rank changes, and changes it after the hold, sampling the old tile until the new one is drawn', () => {
    const plan = new ShadowAtlasPlan(4096);
    settle(plan, [req(0, 1)]);
    const before = plan.update([req(0, 1)], 1 / 60).get(keys[0]!)!.tile!;
    expect(before.size).toBe(SPOT_TILE_MAX);
    // Asking for a quarter of the size, one frame in two: never held long enough.
    for (let f = 0; f < 3 * ATLAS_HOLD_FRAMES; f += 1) expect(plan.update([req(0, f % 2 === 0 ? 0.1 : 1)], 1 / 60).get(keys[0]!)!.tile).toEqual(before);
    // Asking for it steadily: after the hold, the smaller tile, drawn the frame it is taken (no frame unshadowed).
    let after: AtlasGrant | undefined;
    for (let f = 0; f < ATLAS_HOLD_FRAMES + 1; f += 1) {
      after = plan.update([req(0, 0.1)], 1 / 60).get(keys[0]!)!;
      expect(after.tile).not.toBeNull();
      expect(after.intensity).toBe(1);
    }
    expect(after!.tile!.size).toBe(tileSizeFor(0.1, 4096));
  });

  it('leaves the lowest-ranked lights unshadowed when the atlas is full, and a displaced light fades out before its tile is given away', () => {
    const plan = new ShadowAtlasPlan(512);
    // A 512 atlas: the best light takes it whole; the second waits, unshadowed.
    let g = settle(plan, [req(0, 2), req(1, 1)]);
    expect(g.get(keys[0]!)!.tile).toEqual({ x: 0, y: 0, size: 512 });
    expect(g.get(keys[1]!)!.tile).toBeNull();
    expect(g.get(keys[1]!)!.intensity).toBe(0);
    expect(plan.diagnostics()).toMatchObject({ side: 512, lights: 2, tiled: 1, waiting: 1 });
    // The second light comes nearer and outranks the first: the first fades out over the fade time, keeping its
    // tile (still drawn) meanwhile; then the second takes it.
    const fadeFrames = Math.ceil(ATLAS_FADE_SECONDS * 60);
    const firstIntensity: number[] = [];
    for (let f = 0; f < fadeFrames + 4; f += 1) {
      g = plan.update([req(0, 1), req(1, 2)], 1 / 60);
      firstIntensity.push(g.get(keys[0]!)!.intensity);
      // Never both sampling one tile.
      const a = g.get(keys[0]!)!.tile;
      const b = g.get(keys[1]!)!.tile;
      if (a !== null && b !== null) expect(overlaps(a, b)).toBe(false);
    }
    for (let i = 1; i < firstIntensity.length; i += 1) expect(firstIntensity[i]!).toBeLessThanOrEqual(firstIntensity[i - 1]!);
    // A host drawing on demand is asked for every frame of it, up to the one where the waiting light takes the tile.
    expect(plan.moving()).toBe(true);
    expect(firstIntensity[0]!).toBeGreaterThan(0.9);
    expect(firstIntensity.at(-1)).toBe(0);
    g = settle(plan, [req(0, 1), req(1, 2)]);
    expect(g.get(keys[1]!)!.tile).toEqual({ x: 0, y: 0, size: 512 });
    expect(g.get(keys[1]!)!.intensity).toBe(1);
    expect(g.get(keys[0]!)!.tile).toBeNull();
  });

  it('drops a light out of view at once, and redraws within the frame\'s share, best rank first', () => {
    const plan = new ShadowAtlasPlan(2048);
    const many = Array.from({ length: 40 }, (_, i) => req(i, 1 / (i + 1)));
    settle(plan, many, 80);
    expectDisjoint([...plan.update(many, 1 / 60).values()].map((x) => x.tile).filter((t): t is AtlasTile => t !== null), 2048);
    // Every tile dirty: a quarter of the atlas a frame at most, best first; the rest keep their depth.
    const all = plan.update(many.map((r) => ({ ...r, dirty: true })), 1 / 60);
    const drawn = [...all.values()].filter((x) => x.draw !== null);
    expect(drawn.reduce((s, x) => s + x.draw!.size ** 2, 0)).toBeLessThanOrEqual(2048 * 2048 * ATLAS_REDRAW_SHARE);
    expect(all.get(keys[0]!)!.draw).not.toBeNull();
    expect([...all.values()].every((x) => x.tile === null || x.intensity > 0)).toBe(true);
    // Out of view (rank 0): no tile, no shadow.
    const g = plan.update([req(0, 0), ...many.slice(1)], 1 / 60);
    expect(g.get(keys[0]!)).toBeUndefined();
  });
});
