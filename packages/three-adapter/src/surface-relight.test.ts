/**
 * Change tracking of the surface cache's light: the scheduler on its own
 * (nearest first, waiting units moved forward, settled detection, the work
 * count following measured GPU time) and the page's host fed real engine
 * data (a `BlockGrid`, a `TerrainField`, a static model's bricks), where
 * every change path marks the units its light reaches and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, DEFAULT_PROBE_SPACING, TerrainField, buildDistanceBrickSet, encodeDistanceBricks, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { SurfaceCacheHost } from './surface-cache-host';
import { SurfaceChanges, SUN_STEP_RADIANS, type CacheLight } from './surface-changes';
import { RELIGHT_MIN_TEXELS, RELIGHT_START_TEXELS, SurfaceRelight, type RelightUnit } from './surface-relight';
import { LIGHT_RAYS, SUN_RAYS, lightFrameOf, packLightFrame, raysAtLevel } from './surface-light-pass';
import { opaqueByBlockTypes } from './tracer-sources';
import { bounceRayMetres } from './tracer-scene';

const unitAt = (key: string, x: number, texels = 100): RelightUnit => ({ key, min: [x, 0, 0], max: [x + 1, 1, 1], texels });

describe('surface relight: the scheduler', () => {
  it('lights stale texels nearest the eye first, a frame\'s count at a time, and moves long-waiting units forward', () => {
    const r = new SurfaceRelight(1.5);
    for (const x of [40, 10, 25, 2]) r.add(unitAt(`u${x}`, x, 30000));
    expect(r.order([0, 0, 0])).toEqual(['u2', 'u10', 'u25', 'u40']);
    // 32k texels: the nearest whole, then part of the next.
    const s1 = r.plan([0, 0, 0], 0);
    expect(s1.map((s) => [s.unit.key, s.from, s.to])).toEqual([['u2', 0, 30000], ['u10', 0, RELIGHT_START_TEXELS - 30000]]);
    // The next frame goes on where it stopped.
    const s2 = r.plan([0, 0, 0], 16);
    expect(s2[0]).toMatchObject({ from: RELIGHT_START_TEXELS - 30000, to: 30000 });
    expect(s2[0]!.unit.key).toBe('u10');
    expect(s2[1]).toMatchObject({ from: 0, to: RELIGHT_START_TEXELS - (30000 - (RELIGHT_START_TEXELS - 30000)) });
    expect(s2[1]!.unit.key).toBe('u25');
    // A unit marked again part-way starts over.
    r.markUnit('u25');
    const s3 = r.plan([0, 0, 0], 32);
    expect(s3[0]!.unit.key).toBe('u25');
    expect(s3[0]).toMatchObject({ from: 0 });
    // A near unit marked every frame does not starve a far one: waiting halves its distance every 30 frames.
    const q = new SurfaceRelight(1.5);
    q.add(unitAt('near', 1, 40000));
    q.add(unitAt('far', 60, 1000));
    let farAt = -1;
    for (let f = 0; f < 400 && farAt < 0; f += 1) {
      q.markUnit('near');
      if (q.plan([0, 0, 0], f * 16).some((s) => s.unit.key === 'far')) farAt = f;
    }
    expect(farAt).toBeGreaterThan(30);
    expect(farAt).toBeLessThan(250);
  });

  it('settles when nothing is stale, times the change, and then costs nothing', () => {
    const r = new SurfaceRelight(1.5);
    for (let i = 0; i < 5; i += 1) r.add(unitAt(`u${i}`, i * 3, 20000));
    expect(r.isSettled).toBe(false);
    let frames = 0;
    for (let t = 100; !r.isSettled; t += 16) {
      r.plan([0, 0, 0], t);
      frames += 1;
    }
    // 100,000 texels at 32k a frame.
    expect(frames).toBe(4);
    const d = r.diagnostics();
    expect(d).toMatchObject({ settled: true, stalePages: 0, staleTexels: 0, lastSettleFrames: 4, relitTexels: 100000 });
    expect(d.lastSettleMs).toBe(48);
    expect(r.plan([0, 0, 0], 200)).toEqual([]);
    // A mark wakes it; not live (the low tier, no pass) hands out nothing but keeps the marks.
    r.markBox([3, 0, 0], [7, 1, 1]);
    expect(r.diagnostics()).toMatchObject({ settled: false, stalePages: 2 });
    r.setBudget(0);
    expect(r.plan([0, 0, 0], 216)).toEqual([]);
    expect(r.diagnostics()).toMatchObject({ live: false, stalePages: 2 });
  });

  it('takes as many texels a frame as the measured GPU time fits in the budget', () => {
    const r = new SurfaceRelight(1.5);
    expect(r.diagnostics().texelsPerFrame).toBe(RELIGHT_START_TEXELS);
    // 3 ms for 32k: half as many next.
    r.report(3, 32768);
    expect(r.diagnostics().texelsPerFrame).toBe(16384);
    // Cheaper work moves it back up, smoothly.
    let last = 16384;
    for (let i = 0; i < 40; i += 1) {
      r.report(0.75, 16384);
      const n = r.diagnostics().texelsPerFrame;
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(last).toBeGreaterThan(32000);
    expect(last).toBeLessThanOrEqual(32768);
    // Never below the smallest dispatch worth making; a higher tier's budget takes more.
    r.report(500, 4096);
    expect(r.diagnostics().texelsPerFrame).toBe(RELIGHT_MIN_TEXELS);
    const hi = new SurfaceRelight(3);
    hi.report(1.5, 32768);
    expect(hi.diagnostics().texelsPerFrame).toBe(65536);
    expect(hi.diagnostics().msUsed).toBe(1.5);
  });
});

const lamp = (over: Partial<CacheLight> = {}): CacheLight => ({ id: 'lamp', kind: 'point', on: true, position: [8, 2, 8], direction: [0, -1, 0], color: [10, 9, 8], range: 6, cone: 0, penumbra: 0, ...over });
const sun = (dir: readonly number[], over: Partial<CacheLight> = {}): CacheLight => ({ id: 'sun', kind: 'directional', on: true, position: [0, 0, 0], direction: dir, color: [3, 3, 3], range: 0, cone: 0, penumbra: 0, ...over });

describe('surface relight: changes as marks', () => {
  /** A row of units 4 m apart along x, all lit. */
  function settledRow(): { r: SurfaceRelight; c: SurfaceChanges; stale: () => string[] } {
    const r = new SurfaceRelight(1.5);
    for (let i = 0; i < 20; i += 1) r.add({ key: `u${i}`, min: [i * 4, 0, 0], max: [i * 4 + 4, 4, 4], texels: 10 });
    const c = new SurfaceChanges(r);
    const settle = (): void => {
      for (let f = 0; !r.isSettled; f += 1) r.plan([0, 0, 0], f);
    };
    settle();
    const stale = (): string[] => {
      const out: string[] = [];
      for (let i = 0; i < 20; i += 1) if (r.isStale(`u${i}`)) out.push(`u${i}`);
      settle();
      return out;
    };
    return { r, c, stale };
  }

  it('a lamp switched, recoloured or moved marks what it reaches, where it was and where it is', () => {
    const { c, stale } = settledRow();
    c.setLights([lamp()]);
    // Reach 6 m round x = 8: units over x 2 … 14.
    expect(stale()).toEqual(['u0', 'u1', 'u2', 'u3']);
    c.setLights([lamp()]);
    expect(stale()).toEqual([]);
    // Under 2 % is no change.
    c.setLights([lamp({ color: [10.1, 9, 8] })]);
    expect(stale()).toEqual([]);
    c.setLights([lamp({ on: false })]);
    expect(stale()).toEqual(['u0', 'u1', 'u2', 'u3']);
    c.setLights([lamp({ on: false, color: [1, 1, 1] })]);
    expect(stale()).toEqual([]);
    c.setLights([lamp()]);
    stale();
    c.setLights([lamp({ position: [40, 2, 2] })]);
    expect(stale()).toEqual(['u0', 'u1', 'u2', 'u3', 'u8', 'u9', 'u10', 'u11']);
    // A light with no range reaches as far as its intensity carries.
    // Where it was (6 m round x = 40) and where it reaches now (2 m).
    c.setLights([lamp({ position: [40, 2, 2], range: 0, color: [0.04, 0.04, 0.04] })]);
    expect(stale()).toEqual(['u8', 'u9', 'u10', 'u11']);
    // Gone: what it reached.
    c.setLights([]);
    expect(stale()).toEqual(['u9', 'u10']);
  });

  it('the sun marks everything, but only once it has turned a step', () => {
    const { c, stale } = settledRow();
    c.setLights([sun([0, 1, 0])]);
    expect(stale()).toHaveLength(20);
    const turned = (a: number): number[] => [Math.sin(a), Math.cos(a), 0];
    c.setLights([sun(turned(SUN_STEP_RADIANS * 0.6))]);
    expect(stale()).toEqual([]);
    // The turn adds up from the light last computed.
    c.setLights([sun(turned(SUN_STEP_RADIANS * 1.1))]);
    expect(stale()).toHaveLength(20);
    c.setLights([sun(turned(SUN_STEP_RADIANS * 1.1), { color: [2, 2, 2] })]);
    expect(stale()).toHaveLength(20);
  });

  it('changed geometry marks itself and bounced light\'s reach, the lights touching it, and its shadow away from the sun', () => {
    const { c, stale } = settledRow();
    const reach = bounceRayMetres(DEFAULT_PROBE_SPACING);
    expect(reach).toBe(4);
    c.geometryChanged([41, 0, 0], [42, 1, 1]);
    // 37 … 46: units 9 … 11.
    expect(stale()).toEqual(['u9', 'u10', 'u11']);
    // A lamp touching it: all it reaches.
    c.setLights([lamp({ position: [44, 2, 2], range: 10 })]);
    stale();
    c.geometryChanged([41, 0, 0], [42, 1, 1]);
    expect(stale()).toEqual(['u8', 'u9', 'u10', 'u11', 'u12', 'u13']);
    // A low sun from +x (the lamp gone): the shadow falls toward −x, down to the floor (y 0) from 3 m up at
    // sine 0.5, 5.2 m along x: 35.8 … 42, unit 8 besides the reach's 9 … 11.
    c.setLights([sun([Math.sqrt(0.75), 0.5, 0])]);
    stale();
    c.geometryChanged([41, 2, 0], [42, 3, 1]);
    expect(stale()).toEqual(['u8', 'u9', 'u10', 'u11']);
    c.geometryChanged([61, 2, 0], [62, 3, 1]);
    expect(stale()).toEqual(['u13', 'u14', 'u15', 'u16']);
  });
});

const TYPES: BlockType[] = [{ blockId: 'rock', shape: 'full' } as BlockType];
const OPAQUE = opaqueByBlockTypes(TYPES);

function terrain(tiles: Map<string, TerrainTile>): TerrainField {
  const comp = { tileSamples: 17, spacing: 2, heightRange: [-8, 24], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } as TerrainComponent;
  return new TerrainField(comp, [40, -6, 0], tiles);
}
function terrainTiles(bump: number): Map<string, TerrainTile> {
  const tiles = new Map<string, TerrainTile>();
  for (const x of [0, 1]) {
    const heights = new Uint16Array(17 * 17);
    for (let i = 0; i < heights.length; i += 1) heights[i] = 20000 + (x === 1 && i === 100 ? bump : 0);
    tiles.set(`${x},0`, { samples: 17, heights, weights: null, holes: null, paint: null });
  }
  return tiles;
}

/** A crate (2 × 0.8 × 1.2 m) as triangles. */
function crate(): { positions: [number, number, number][]; triangles: [number, number, number][]; uv1: null } {
  const positions: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];
  const [x0, y0, z0, x1, y1, z1] = [-1, 0, -0.6, 1, 0.8, 0.6];
  const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], e: [number, number, number]): void => {
    const i = positions.length;
    positions.push(a, b, c, e);
    triangles.push([i, i + 1, i + 2], [i, i + 2, i + 3]);
  };
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return { positions, triangles, uv1: null };
}

describe('surface relight on the page', () => {
  it('each change path marks the units its light reaches: lamps, the sun, block and terrain edits, a static object moved', async () => {
    const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [64, 4, 64] } });
    for (let x = 0; x < 64; x += 1) for (let z = 0; z < 64; z += 1) grid.set(x, 0, z, { block: 'rock' });
    const gens = new Map<string, number>();
    for (let cz = 0; cz < 4; cz += 1) for (let cx = 0; cx < 4; cx += 1) gens.set(`${cx},${cz}`, 1);
    let field = terrain(terrainTiles(0));
    const file = encodeDistanceBricks({ sets: [buildDistanceBrickSet('', [crate()])!] });
    let world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, 1, 20, 1];
    const host = new SurfaceCacheHost(
      {
        layers: () => [{ id: 'town', origin: [0, 0, 0], grid, version: 1, chunks: [...gens], opaque: OPAQUE }],
        terrains: () => [{ id: 'land', field }],
        architecture: () => [],
        models: () => [{ id: 'crate', assetId: 'crate', version: 1, piece: null, world }],
        bricks: () => Promise.resolve(file),
      },
      64 * 1024 * 1024,
      1.5,
    );
    host.setLive(true);
    const eye = [8, 2, 8];
    let now = 0;
    const settle = async (): Promise<number> => {
      let frames = 0;
      for (; frames < 2000; frames += 1) {
        host.touch();
        host.update(eye, (now += 16));
        await Promise.resolve();
        const d = host.diagnostics();
        if (d.preparing === 0 && d.reading === 0 && d.tiles.resident === d.tiles.offered && d.tiles.offered > 0 && d.relight.settled) break;
      }
      return frames;
    };
    await settle();
    // The units lit from now until settled again: what the last change marked.
    const relitUntilSettled = async (): Promise<string[]> => {
      const out = new Set<string>();
      for (let f = 0; f < 2000; f += 1) {
        host.touch();
        host.update(eye, (now += 16));
        await Promise.resolve();
        for (const sl of host.slicesThisFrame()) out.add(sl.unit.key);
        const d = host.diagnostics();
        if (d.preparing === 0 && d.reading === 0 && d.relight.settled) break;
      }
      return [...out].sort();
    };
    const r = host.relight;
    const all = (): string[] => r.unitsIn([-1e9, -1e9, -1e9], [1e9, 1e9, 1e9]);
    const staleNow = (): string[] => all().filter((k) => r.isStale(k)).sort();
    const keys = all();
    // Block tiles are lit chart by chart (a lamp marks the faces round it, not its whole chunk column).
    const of = (list: string[], tile: string): boolean => list.some((k) => k.startsWith(`${tile}|`));
    expect(of(keys, 'town/3,3')).toBe(true);
    expect(keys).toContain('crate/');
    expect(keys.some((k) => k.startsWith('land#'))).toBe(true);
    const box = (min: number[], max: number[]): string[] => r.unitsIn(min, max).sort();
    const union = (...lists: string[][]): string[] => [...new Set(lists.flat())].sort();
    const reach = bounceRayMetres(DEFAULT_PROBE_SPACING);

    // The light pass's frame: each slice's texels on their surfaces, with the lights reaching its unit.
    host.setLights([lamp(), sun([0, 1, 0])]);
    host.update(eye, (now += 16));
    const frame = lightFrameOf(host, [lamp(), sun([0, 1, 0])]);
    const planned = host.slicesThisFrame();
    expect(frame.slices.map((s) => s.texels)).toEqual(planned.map((s) => s.to - s.from));
    expect(frame.slices.every((s) => s.sun)).toBe(true);
    planned.forEach((s, i) => {
      const touches = s.unit.min.every((v, k) => v <= lamp().position[k]! + 6) && s.unit.max.every((v, k) => v >= lamp().position[k]! - 6);
      expect(frame.slices[i]!.lights).toEqual(touches ? [0] : []);
    });
    const packed = packLightFrame(frame);
    expect(packed.rays).toBe(frame.slices.reduce((n, s) => n + s.texels * (raysAtLevel(SUN_RAYS, s.level) + s.lights.length * raysAtLevel(LIGHT_RAYS, s.level)), 0));
    // Coarser texels cast fewer rays, never none.
    expect([0, 1, 2, 3, 5].map((l) => raysAtLevel(SUN_RAYS, l))).toEqual([8, 4, 2, 1, 1]);
    // Every texel sits on a surface of its unit (spare surfel texels and holes have no normal).
    let placed = 0;
    let off = 0;
    for (const s of planned) {
      for (let t = 0; t < s.to - s.from; t += 1, off += 6) {
        const p = frame.points.subarray(off, off + 6);
        if (p[3] === 0 && p[4] === 0 && p[5] === 0) continue;
        placed += 1;
        for (let k = 0; k < 3; k += 1) {
          expect(p[k]!).toBeGreaterThanOrEqual(s.unit.min[k]! - 1e-3);
          expect(p[k]!).toBeLessThanOrEqual(s.unit.max[k]! + 1e-3);
        }
      }
    }
    expect(placed).toBeGreaterThan(0);
    await settle();
    host.setLights([]);
    await settle();

    // A lamp switched on in the town: what it reaches, and nothing on the terrain 26 m away.
    host.setLights([lamp()]);
    expect(staleNow()).toEqual(r.unitsNear([8, 2, 8], 6).sort());
    expect(staleNow().some((k) => k.startsWith('land'))).toBe(false);
    await settle();
    host.setLights([lamp({ on: false })]);
    expect(staleNow()).toEqual(r.unitsNear([8, 2, 8], 6).sort());
    await settle();

    // Time of day: the sun steps, everything is stale; under a step nothing is.
    host.setLights([sun([0, 1, 0])]);
    expect(staleNow()).toEqual(all().sort());
    await settle();
    host.setLights([sun([Math.sin(SUN_STEP_RADIANS / 2), Math.cos(SUN_STEP_RADIANS / 2), 0])]);
    expect(staleNow()).toEqual([]);

    // A block placed (live or by a command, the chunk is built again): the chunk column, bounced light's reach round it
    // and its shadow straight down; not the far chunks, the crate or the terrain.
    grid.set(56, 1, 56, { block: 'rock' });
    gens.set('3,3', 2);
    const before = box([48 - reach, -reach, 48 - reach], [64 + reach, 4 + reach, 64 + reach]);
    const staleBlocks = await relitUntilSettled();
    // The edited chunk was packed again (its charts, the new block's among them, stale as new) and every unit
    // within reach is marked; nothing else.
    const fresh = all().filter((k) => k.startsWith('town/3,3|'));
    expect(fresh.length).toBeGreaterThan(0);
    const expectBlocks = union(before.filter((k) => !k.startsWith('town/3,3|')), fresh);
    expect(staleBlocks).toEqual(expectBlocks);
    expect(of(staleBlocks, 'town/0,0')).toBe(false);
    expect(staleBlocks).not.toContain('crate/');
    expect(staleBlocks.some((k) => k.startsWith('land'))).toBe(false);

    // A terrain edit (new data for one tile): that tile's box and round it; a field made again with the same data: nothing.
    field = terrain(terrainTiles(0));
    expect(await relitUntilSettled()).toEqual([]);
    field = terrain(terrainTiles(3000));
    const [y0, y1] = field.heightSpan();
    const tile = field.tileBounds(1, 0);
    const staleTerrain = await relitUntilSettled();
    expect(staleTerrain).toEqual(union(box([tile[0] - reach, y0 - reach, tile[1] - reach], [tile[2] + reach, y1 + reach, tile[3] + reach]), box([tile[0], -1e9, tile[1]], [tile[2], y1, tile[3]])));
    expect(staleTerrain.length).toBeGreaterThan(0);
    expect(staleTerrain.every((k) => k.startsWith('land'))).toBe(true);

    // A static object moved: where it was and where it is.
    world = world.map((v, i) => (i === 12 ? 30 : v));
    const moved = await relitUntilSettled();
    expect(moved).toContain('crate/');
    expect(of(moved, 'town/1,1')).toBe(true);
    expect(of(moved, 'town/2,1')).toBe(true);
    expect(of(moved, 'town/1,2')).toBe(false);
    expect(of(moved, 'town/3,3')).toBe(false);
    expect(moved.some((k) => k.startsWith('land'))).toBe(false);
    expect(host.diagnostics().relight).toMatchObject({ settled: true, stalePages: 0, live: true, budgetMs: 1.5 });
  });
});
