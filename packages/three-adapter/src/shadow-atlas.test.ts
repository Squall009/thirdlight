/**
 * The shadow atlas's plan (pure): tiles never overlap and stay inside the
 * atlas, sizes follow the rank, small rank changes move nothing, a full
 * atlas leaves the lowest-ranked lights unshadowed (and the light a better
 * one displaces fades out before its tile is given away), and the redraws
 * stay within their share of the atlas a frame without starving any tile.
 */
import { describe, expect, it } from 'vitest';

import { ATLAS_EVICT_MARGIN, ATLAS_FADE_SECONDS, ATLAS_FADE_STEP_MAX, ATLAS_HOLD_FRAMES, ATLAS_REDRAW_SHARE, ATLAS_REDRAW_WAIT_FRAMES, FACE_TILE_MAX, FACE_TILE_MIN, QuadAllocator, ShadowAtlasPlan, shadowRank, SPOT_TILE_MAX, SPOT_TILE_MIN, tileSizeFor, type AtlasGrant, type AtlasRequest, type AtlasTile } from './shadow-atlas';

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
    const drawnTexels = [...first.values()].reduce((s, g) => s + (g.draw?.[0]?.size ?? 0) ** 2, 0);
    expect(drawnTexels).toBeLessThanOrEqual(4096 * 4096 * ATLAS_REDRAW_SHARE);
    const g0 = first.get(keys[0]!)!;
    expect(g0.draw).not.toBeNull();
    expect(g0.intensity).toBeGreaterThan(0);
    expect(g0.intensity).toBeLessThan(0.2);
    const g = settle(plan, requests);
    const tiles = [...g.values()].map((x) => x.tiles?.[0] ?? null).filter((t): t is AtlasTile => t !== null);
    expect(tiles.length).toBe(20);
    expectDisjoint(tiles, 4096);
    expect(g.get(keys[0]!)!.tiles![0]!.size).toBe(SPOT_TILE_MAX);
    expect(g.get(keys[19]!)!.tiles![0]!.size).toBeLessThan(SPOT_TILE_MAX);
    expect(g.get(keys[0]!)!.intensity).toBe(1);
    // Settled and clean: nothing is drawn again.
    expect([...plan.update(requests, 1 / 60).values()].every((x) => x.draw === null)).toBe(true);
    // A dirty light's tile only.
    const dirty = plan.update(requests.map((r, i) => (i === 3 ? { ...r, dirty: true } : r)), 1 / 60);
    expect([...dirty.entries()].filter(([, x]) => x.draw !== null).map(([k]) => k)).toEqual([keys[3]]);
  });

  it('fades a new tile in over frames after a long pause (a host drawing on demand), and says so until done', () => {
    const plan = new ShadowAtlasPlan(4096);
    plan.update([req(0, 1)], 1 / 60);
    settle(plan, [req(0, 1)]);
    // The next frame comes a second later (nothing moved meanwhile, or a precompile skipped frames) with new lights.
    const requests = [req(0, 1), req(1, 0.8), req(2, 0.6)];
    const late = plan.update(requests, 1);
    expect(late.get(keys[1]!)!.draw).not.toBeNull();
    expect(late.get(keys[1]!)!.intensity).toBeCloseTo(ATLAS_FADE_STEP_MAX / ATLAS_FADE_SECONDS, 5);
    expect(plan.moving()).toBe(true);
    let frames = 1;
    while (plan.moving() && frames < 100) {
      plan.update(requests, 1);
      frames += 1;
    }
    expect(frames).toBe(Math.ceil(ATLAS_FADE_SECONDS / ATLAS_FADE_STEP_MAX));
    // The frame that settles it draws nothing: a host's last frame says the atlas is still.
    expect(plan.diagnostics()).toMatchObject({ tiled: 3, waiting: 0, drawn: 0 });
    expect(plan.update(requests, 1).get(keys[2]!)!.intensity).toBe(1);
  });

  it('keeps a tile size through small rank changes, and changes it after the hold, sampling the old tile until the new one is drawn', () => {
    const plan = new ShadowAtlasPlan(4096);
    settle(plan, [req(0, 1)]);
    const before = plan.update([req(0, 1)], 1 / 60).get(keys[0]!)!.tiles![0]!;
    expect(before.size).toBe(SPOT_TILE_MAX);
    // Asking for a quarter of the size, one frame in two: never held long enough.
    for (let f = 0; f < 3 * ATLAS_HOLD_FRAMES; f += 1) expect(plan.update([req(0, f % 2 === 0 ? 0.1 : 1)], 1 / 60).get(keys[0]!)!.tiles?.[0]).toEqual(before);
    // Asking for it steadily: after the hold, the smaller tile, drawn the frame it is taken (no frame unshadowed).
    let after: AtlasGrant | undefined;
    for (let f = 0; f < ATLAS_HOLD_FRAMES + 1; f += 1) {
      after = plan.update([req(0, 0.1)], 1 / 60).get(keys[0]!)!;
      expect(after.tiles).not.toBeNull();
      expect(after.intensity).toBe(1);
    }
    expect(after!.tiles![0]!.size).toBe(tileSizeFor(0.1, 4096));
  });

  it('asks a host drawing on demand for the frames a resize waits for, and not for one that found no room', () => {
    const plan = new ShadowAtlasPlan(4096);
    settle(plan, [req(0, 0.1)]);
    expect(plan.moving()).toBe(false);
    // The view comes closer in one step (one frame): the light asks for a larger tile, and the frames come until it has it.
    let frames = 0;
    do {
      plan.update([req(0, 1)], 1 / 60);
      frames += 1;
    } while (plan.moving() && frames < 100);
    expect(frames).toBe(ATLAS_HOLD_FRAMES);
    expect(plan.update([req(0, 1)], 1 / 60).get(keys[0]!)!.tiles![0]!.size).toBe(SPOT_TILE_MAX);
    // Four lights fill a 1,024 atlas with 512 tiles; one asks for the whole atlas: after the hold it finds no room,
    // keeps its tile, and the view stops drawing.
    const full = new ShadowAtlasPlan(1024);
    const four = [0, 1, 2, 3].map((i) => req(i, 0.2));
    settle(full, four);
    expect([...full.update(four, 1 / 60).values()].map((g) => g.tiles?.[0]?.size)).toEqual([512, 512, 512, 512]);
    const asks = [...four.slice(0, 3), req(3, 1)];
    let more = 0;
    do {
      full.update(asks, 1 / 60);
      more += 1;
    } while (full.moving() && more < 200);
    expect(more).toBe(ATLAS_HOLD_FRAMES);
    expect(full.update(asks, 1 / 60).get(keys[3]!)!.tiles![0]!.size).toBe(512);
    expect(full.moving()).toBe(false);
  });

  it('leaves the lowest-ranked lights unshadowed when the atlas is full, and a displaced light fades out before its tile is given away', () => {
    const plan = new ShadowAtlasPlan(512);
    // A 512 atlas: the best light takes it whole; the second waits, unshadowed.
    let g = settle(plan, [req(0, 2), req(1, 1)]);
    expect(g.get(keys[0]!)!.tiles?.[0]).toEqual({ x: 0, y: 0, size: 512 });
    expect(g.get(keys[1]!)!.tiles).toBeNull();
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
      const a = g.get(keys[0]!)!.tiles?.[0];
      const b = g.get(keys[1]!)!.tiles?.[0];
      if (a !== undefined && b !== undefined) expect(overlaps(a, b)).toBe(false);
    }
    for (let i = 1; i < firstIntensity.length; i += 1) expect(firstIntensity[i]!).toBeLessThanOrEqual(firstIntensity[i - 1]!);
    // A host drawing on demand is asked for every frame of it, up to the one where the waiting light takes the tile.
    expect(plan.moving()).toBe(true);
    expect(firstIntensity[0]!).toBeGreaterThan(0.9);
    expect(firstIntensity.at(-1)).toBe(0);
    g = settle(plan, [req(0, 1), req(1, 2)]);
    expect(g.get(keys[1]!)!.tiles?.[0]).toEqual({ x: 0, y: 0, size: 512 });
    expect(g.get(keys[1]!)!.intensity).toBe(1);
    expect(g.get(keys[0]!)!.tiles).toBeNull();
  });

  it('drops a light out of view at once, and redraws within the frame\'s share, best rank first', () => {
    const plan = new ShadowAtlasPlan(2048);
    const many = Array.from({ length: 40 }, (_, i) => req(i, 1 / (i + 1)));
    settle(plan, many, 80);
    expectDisjoint([...plan.update(many, 1 / 60).values()].map((x) => x.tiles?.[0] ?? null).filter((t): t is AtlasTile => t !== null), 2048);
    // Every tile dirty: a quarter of the atlas a frame at most, best first; the rest keep their depth.
    const all = plan.update(many.map((r) => ({ ...r, dirty: true })), 1 / 60);
    const drawn = [...all.values()].filter((x) => x.draw !== null);
    expect(drawn.reduce((s, x) => s + x.draw![0]!.size ** 2, 0)).toBeLessThanOrEqual(2048 * 2048 * ATLAS_REDRAW_SHARE);
    expect(all.get(keys[0]!)!.draw).not.toBeNull();
    expect([...all.values()].every((x) => x.tiles === null || x.intensity > 0)).toBe(true);
    // Out of view (rank 0): no tile, no shadow.
    const g = plan.update([req(0, 0), ...many.slice(1)], 1 / 60);
    expect(g.get(keys[0]!)).toBeUndefined();
  });
  it('gives a light with faces all of them or none, one size, inside the face sizes, beside spots', () => {
    const plan = new ShadowAtlasPlan(2048);
    const cube = (i: number, rank: number, faces = 6): AtlasRequest => ({ ...req(i, rank), faces });
    let g = settle(plan, [req(0, 1), cube(1, 1), cube(2, 0.05, 5)]);
    const spot = g.get(keys[0]!)!.tiles!;
    const point = g.get(keys[1]!)!.tiles!;
    const area = g.get(keys[2]!)!.tiles!;
    expect(spot.length).toBe(1);
    expect(point.length).toBe(6);
    expect(area.length).toBe(5);
    expect(new Set(point.map((t) => t.size))).toEqual(new Set([FACE_TILE_MAX]));
    expect(area[0]!.size).toBeGreaterThanOrEqual(FACE_TILE_MIN);
    expect(area[0]!.size).toBeLessThan(FACE_TILE_MAX);
    expectDisjoint([...spot, ...point, ...area], 2048);
    // A full atlas: a 512 atlas holds one point light's six 64–128 faces, not a second's; that one waits whole.
    const small = new ShadowAtlasPlan(512);
    g = settle(small, [cube(0, 1), cube(1, 0.9)]);
    const first = g.get(keys[0]!)!.tiles;
    expect(first?.length).toBe(6);
    expectDisjoint(first!, 512);
    const second = g.get(keys[1]!)!.tiles;
    expect(second === null || second.length === 6).toBe(true);
    expect(small.diagnostics().used).toBeLessThanOrEqual(1);
    // Every face of a dirty light is drawn together.
    const d = small.update([{ ...cube(0, 1), dirty: true }, cube(1, 0.9)], 1 / 60);
    expect(d.get(keys[0]!)!.draw?.length).toBe(6);
  });
  it('redraws every dirty tile within a few frames while a moving caster keeps the best lamp dirty on the low tier', () => {
    // The low tier's 2,048 atlas: a near spot's 1,024 tile is the whole frame's share, a point light's six 512 faces
    // more than it. A character walks between them, so both stay dirty every frame.
    const side = 2048;
    const plan = new ShadowAtlasPlan(side);
    const cube = (i: number, rank: number, dirty: boolean): AtlasRequest => ({ ...req(i, rank, dirty), faces: 6 });
    const lamps = (dirty: boolean, extra: AtlasRequest[] = []): AtlasRequest[] => [req(0, 1, dirty), req(1, 0.6, dirty), cube(2, 0.5, dirty), ...extra];
    settle(plan, lamps(false), 80);
    expect(plan.diagnostics()).toMatchObject({ tiled: 3, waiting: 0 });
    expect(plan.update(lamps(false), 1 / 60).get(keys[0]!)!.tiles![0]!.size).toBe(1024);
    const bound = ATLAS_REDRAW_WAIT_FRAMES + 3;
    const lastDrawn = new Map<object, number>();
    const longest = new Map<object, number>();
    let newcomerDrawn = -1;
    let newcomerShown = -1;
    let reported = 0;
    for (let f = 0; f < 120; f += 1) {
      // Half way, a fourth lamp comes into view: its new tile is drawn, then shown, within the bound too.
      const g = plan.update(lamps(true, f >= 60 ? [req(3, 0.3, true)] : []), 1 / 60);
      const spent = [...g.values()].reduce((n, x) => n + (x.draw === null ? 0 : x.draw.length * x.draw[0]!.size ** 2), 0);
      const tiles = [...g.values()].filter((x) => x.draw !== null).length;
      if (tiles > 1) expect(spent).toBeLessThanOrEqual(side * side * ATLAS_REDRAW_SHARE);
      for (const [key, x] of g) {
        if (x.draw === null) continue;
        longest.set(key, Math.max(longest.get(key) ?? 0, f - (lastDrawn.get(key) ?? (key === keys[3] ? 59 : -1))));
        lastDrawn.set(key, f);
      }
      expect(plan.diagnostics()).toMatchObject({ drawn: tiles, drawnTexels: spent });
      reported = Math.max(reported, plan.diagnostics().longestWait);
      const n = g.get(keys[3]!);
      if (n !== undefined && n.draw !== null && newcomerDrawn < 0) newcomerDrawn = f;
      if (n !== undefined && n.intensity > 0 && newcomerShown < 0) {
        newcomerShown = f;
        expect(newcomerDrawn, 'shown only once drawn').toBeGreaterThanOrEqual(0);
      }
    }
    for (const k of [keys[0]!, keys[1]!, keys[2]!, keys[3]!]) {
      expect(lastDrawn.get(k), `light ${(k as { light: number }).light} drawn`).toBeGreaterThanOrEqual(120 - bound);
      expect(longest.get(k)!, `light ${(k as { light: number }).light}'s longest wait`).toBeLessThanOrEqual(bound);
    }
    expect(newcomerDrawn - 60).toBeLessThanOrEqual(bound);
    // The diagnostics' longest wait is the frames between draws less the frame drawn.
    expect(reported).toBe(Math.max(...longest.values()) - 1);
    expect(newcomerShown).toBeGreaterThanOrEqual(newcomerDrawn);
    // With four tiles that each fill the share the turns go round; with two, the best lamp still redraws most frames.
    let best = 0;
    for (let f = 0; f < 60; f += 1) if (plan.update([req(0, 1, true), req(1, 0.6, true), cube(2, 0.5, false), req(3, 0.3, false)], 1 / 60).get(keys[0]!)!.draw !== null) best += 1;
    expect(best).toBeGreaterThanOrEqual(40);
  });

  it('keeps a full atlas\'s holder against a light of about its rank, and gives way to one clearly better', () => {
    const plan = new ShadowAtlasPlan(512);
    settle(plan, [req(0, 1), req(1, 0.5)]);
    // Ranks within the margin, the newcomer just ahead: the holder keeps its tile for good.
    const close = [req(0, 1), req(1, 1 * ATLAS_EVICT_MARGIN * 0.99)];
    const g = settle(plan, close, 120);
    expect(g.get(keys[0]!)!.tiles?.[0]).toEqual({ x: 0, y: 0, size: 512 });
    expect(g.get(keys[1]!)!.tiles).toBeNull();
    // Past the margin: it fades out and the better light takes the tile.
    const clear = [req(0, 1), req(1, 1 * ATLAS_EVICT_MARGIN * 1.01)];
    const h = settle(plan, clear, 60);
    expect(h.get(keys[1]!)!.tiles?.[0]).toEqual({ x: 0, y: 0, size: 512 });
    expect(h.get(keys[0]!)!.tiles).toBeNull();
  });
});
