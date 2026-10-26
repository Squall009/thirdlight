/**
 * The surface cache's addressing per geometry kind and its residency, at the
 * tracer's own boundary: real engine data (a `BlockGrid`, a `TerrainField`,
 * architecture's colliders, bricks and surfels built from a mesh as an
 * import builds them) packed for the CPU tracer, traced rays' hits resolved
 * to texels, and the atlas checked texel by texel.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, TerrainField, buildDistanceBrickSet, encodeDistanceBricks, type ArchitectureComponent, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { SURFACE_PAGE_BYTES, SURFACE_PAGE_TEXELS, PageAtlas, packTile, type SurfaceChart } from './surface-cache-atlas';
import { blockChunkCharts } from './surface-cache-blocks';
import { SurfaceCache, surfaceLevelFor, type SurfaceTexel, type SurfaceTile } from './surface-cache';
import { SurfaceCacheHost, SURFACE_PREPARE_MS } from './surface-cache-host';
import { SurfaceScene, type SurfaceSceneInput } from './surface-cache-scene';
import { TERRAIN_RING_BYTES } from './surface-cache-terrain';
import { traceRayCpu, sceneView, type V3 } from './tracer-cpu';
import { opaqueByBlockTypes, traceBlockLayerOf, traceTerrainOf } from './tracer-sources';
import { TRACE_ARCH, TRACE_BLOCKS, TRACE_BRICKS, TRACE_MISS, TRACE_TERRAIN, TRACE_UNFINISHED, packTraceScene, worldToLocalOf } from './tracer-scene';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

const TYPES: BlockType[] = [{ blockId: 'rock', shape: 'full' } as BlockType, { blockId: 'slab', shape: 'half' } as BlockType];
const OPAQUE = opaqueByBlockTypes(TYPES);

/** A block room: an 8 × 8 floor, walls with a door, a pillar, a half block. */
function blockRoom(): { grid: BlockGrid; origin: V3 } {
  const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-4, 0, -4], max: [28, 6, 12] } });
  for (let x = 0; x < 20; x += 1) for (let z = 0; z < 8; z += 1) grid.set(x, 0, z, { block: 'rock' });
  for (let y = 1; y < 4; y += 1) for (let x = 0; x < 8; x += 1) {
    if (!(x === 3 && y < 3)) grid.set(x, y, 0, { block: 'rock' });
    grid.set(x, y, 7, { block: 'rock' });
  }
  for (let y = 1; y < 4; y += 1) grid.set(4, y, 4, { block: 'rock' });
  grid.set(6, 1, 2, { block: 'slab' });
  return { grid, origin: [-3, 0.5, 2] };
}

function terrainField(): TerrainField {
  const comp = { tileSamples: 17, spacing: 2, heightRange: [-8, 24], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } as TerrainComponent;
  const tiles = new Map<string, TerrainTile>();
  for (const t of comp.tiles) {
    const heights = new Uint16Array(17 * 17);
    for (let z = 0; z < 17; z += 1) for (let x = 0; x < 17; x += 1) heights[z * 17 + x] = Math.round(((3 * Math.sin((t.x * 16 + x) * 0.3) + 8) / 32) * 65535);
    tiles.set(`${t.x},${t.z}`, { samples: 17, heights, weights: null, holes: null, paint: null });
  }
  return new TerrainField(comp, [40, -6, -20], tiles);
}

const path = { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]] as [number, number, number][], closed: true as const };
const ROOM: ArchitectureComponent = {
  chunkSize: 16,
  profiles: { wall: { points: [[0.15, 0], [0.15, 3], [-0.15, 3], [-0.15, 0]], slots: ['lower_wall', 'bevel', 'upper_wall'] } },
  elements: [
    { id: 'a', kind: 'sweep', path, profile: 'wall', openings: [{ id: 'door', at: 4, width: 1.2, bottom: 0, top: 2.2 }] },
    { id: 'a-floor', kind: 'fill', path, shape: 'flat', slot: 'floor' },
  ],
} as ArchitectureComponent;

/** A closed crate (2 × 0.8 × 1.2 m) as triangles, with a UV1 per vertex when asked. */
function crate(uv1: boolean): { positions: V3[]; triangles: V3[]; uv1: number[] | null } {
  const positions: V3[] = [];
  const triangles: V3[] = [];
  const uv: number[] = [];
  const quad = (a: V3, b: V3, c: V3, e: V3, slot: number): void => {
    const i = positions.length;
    positions.push(a, b, c, e);
    uv.push(slot / 6, 0, (slot + 1) / 6, 0, (slot + 1) / 6, 1, slot / 6, 1);
    triangles.push([i, i + 1, i + 2], [i, i + 2, i + 3]);
  };
  const [x0, y0, z0, x1, y1, z1] = [-1, 0, -0.6, 1, 0.8, 0.6];
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 0);
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], 1);
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], 2);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 3);
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], 4);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], 5);
  return { positions, triangles, uv1: uv1 ? uv : null };
}

function sceneInput(): SurfaceSceneInput {
  const { grid, origin } = blockRoom();
  const field = terrainField();
  const surfels = buildDistanceBrickSet('', [crate(false)])!;
  const uvSet = buildDistanceBrickSet('', [crate(true)])!;
  return {
    blocks: [{ key: 'room', grid, origin, opaque: OPAQUE, version: 1, chunks: ['0,0', '1,0', '0,-1'], trace: traceBlockLayerOf(grid, origin, OPAQUE) }],
    terrain: [{ key: 'land', trace: traceTerrainOf(field, [-8, 24])! }],
    architecture: [{ key: 'house-a', component: ROOM, origin: [0, 0.5, -16], version: 1 }, { key: 'house-b', component: ROOM, origin: [14, 0.5, -16], version: 1 }],
    models: [
      { key: 'crate-surfels', worldToLocal: worldToLocalOf([30, 1, 6], [0, Math.sin(0.4), 0, Math.cos(0.4)], [1.5, 1.5, 1.5]), bricks: { sets: [surfels] }, version: 1 },
      { key: 'crate-uv1', worldToLocal: worldToLocalOf([34, 1, 6], [0, 0, 0, 1], [1, 1, 1]), bricks: { sets: [uvSet] }, version: 1 },
    ],
  };
}

/** Every resident chart's rectangle on its page: none overlaps another, and all lie inside their blocks. */
function expectAtlasDisjoint(cache: SurfaceCache): number {
  const pages = new Map<number, Uint8Array>();
  let charts = 0;
  let outside = 0;
  let overlaps = 0;
  cache.forEachResident((_, __, blocks, packing) => {
    packing.places.forEach((p) => {
      const b = blocks[p.block]!;
      if (p.x + p.w > b.side || p.y + p.h > b.side) outside += 1;
      let page = pages.get(b.page);
      if (page === undefined) pages.set(b.page, (page = new Uint8Array(SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS)));
      for (let y = 0; y < p.h; y += 1) for (let x = 0; x < p.w; x += 1) {
        const i = (b.y + p.y + y) * SURFACE_PAGE_TEXELS + b.x + p.x + x;
        if (page[i] !== 0) overlaps += 1;
        page[i] = 1;
      }
      charts += 1;
    });
  });
  expect(outside).toBe(0);
  expect(overlaps).toBe(0);
  return charts;
}

const texelKey = (t: SurfaceTexel): string => ('page' in t ? `p${t.page}:${t.x},${t.y}` : `${t.terrain}:${t.ring}:${t.x},${t.y}`);

describe('surface cache: addressing per kind', () => {
  it('block faces: coplanar faces share charts, every visible face has its own texels, hidden faces none', () => {
    const { grid } = blockRoom();
    const c = blockChunkCharts(grid, OPAQUE, 0, 0);
    // The floor's top inside the walls, the walls' faces: far fewer charts than faces.
    expect(c.faces).toBeGreaterThan(300);
    expect(c.charts.length).toBeLessThan(c.faces / 4);
    // The 16-cell floor row's top (y = 0, +y) is one chart wide where nothing stands on it.
    const tops = c.charts.filter((ch) => ch.kind === 'area' && ch.w >= 8);
    expect(tops.length).toBeGreaterThan(0);
    // The face under the floor is visible (open below); the face between two floor cells is not.
    expect(c.keys.length).toBe(c.faces);
    const scene = new SurfaceScene(sceneInput());
    const cache = new SurfaceCache(256 * 1024 * 1024);
    cache.update([4, 2, 4], scene.tiles, scene.terrains, true);
    expect(cache.levelOf('room/0,0')).toBe(0);
    // Each visible face's centre at level 0 (10 cm texels, 1 m cells) has its own texel inside its chart.
    const seen = new Map<string, number>();
    const tile = scene.blockTile(0, 0, 0)!;
    const made = tile.made!;
    for (let i = 0; i < made.keys.length; i += 1) {
      const key = made.keys[i]!;
      const face = key % 6;
      const li = Math.floor(key / 6);
      const cell = [li % 16, Math.floor(li / 256) + grid.min[1]!, Math.floor(li / 16) % 16];
      const dx = grid.max[0]! - grid.min[0]!;
      const dz = grid.max[2]! - grid.min[2]!;
      const local = [cell[0]! - grid.min[0]!, cell[1]! - grid.min[1]!, cell[2]! - grid.min[2]!];
      const hit = { kind: TRACE_BLOCKS, t: 1, normal: [0, 0, 0] as V3, face, object: 0, a0: (local[1]! * dz + local[2]!) * dx + local[0]!, a1: 32768 | (32768 << 16) };
      const t = scene.resolve(cache, hit)!;
      expect(t).not.toBeNull();
      const k = texelKey(t);
      expect(seen.has(k), `face ${key} shares texel ${k}`).toBe(false);
      seen.set(k, key);
    }
    expect(seen.size).toBe(made.faces);
    // A face behind an opaque neighbour has no texel: the top of a floor cell under a wall.
    const hidden = { kind: TRACE_BLOCKS, t: 1, normal: [0, 1, 0] as V3, face: 2, object: 0, a0: ((0 - 0) * (16) + (0 + 4)) * 32 + 4, a1: 0 };
    expect(scene.resolve(cache, hidden)).toBeNull();
    expectAtlasDisjoint(cache);
  });

  it('every traced hit on every kind resolves to a resident texel; distinct surfaces never share one', () => {
    const scene = new SurfaceScene(sceneInput());
    const cache = new SurfaceCache(256 * 1024 * 1024);
    const eye: V3 = [10, 3, 0];
    cache.update(eye, scene.tiles, scene.terrains, true);
    expect(cache.diagnostics().tiles.beyond).toBe(0);
    const s = sceneView(packTraceScene(scene.traceSource()));
    const r = rng(5);
    const byKind = new Map<number, number>();
    const owner = new Map<string, string>();
    let unresolved = 0;
    for (let i = 0; i < 6000; i += 1) {
      const o: V3 = [-6 + r() * 50, 1.6 + r() * 4.5, -22 + r() * 34];
      const d = unit([r() * 2 - 1, r() * 2 - 1.3, r() * 2 - 1]);
      let tmin = 0;
      let hit = traceRayCpu(s, o, d, tmin, 120);
      while (hit.kind === TRACE_UNFINISHED) {
        tmin = hit.t;
        hit = traceRayCpu(s, o, d, tmin, 120);
      }
      // A ray that begins inside a solid is stopped where it begins, on no surface of its own.
      if (hit.kind === TRACE_MISS || hit.t <= 1e-4) continue;
      byKind.set(hit.kind, (byKind.get(hit.kind) ?? 0) + 1);
      const t = scene.resolve(cache, hit);
      if (t === null) {
        unresolved += 1;
        continue;
      }
      // A texel belongs to one surface: the same kind, object and facing (coplanar pieces of one object share).
      const surface = `${hit.kind}/${hit.kind === TRACE_ARCH ? 'arch' : hit.object}/${hit.normal.map((v) => Math.round(v * 4)).join(',')}`;
      const k = texelKey(t);
      const was = owner.get(k);
      if (was === undefined) owner.set(k, surface);
      else if (hit.kind !== TRACE_BRICKS && hit.kind !== TRACE_TERRAIN) expect(was).toBe(surface);
    }
    for (const kind of [TRACE_BLOCKS, TRACE_TERRAIN, TRACE_ARCH, TRACE_BRICKS]) expect(byKind.get(kind) ?? 0, `kind ${kind}`).toBeGreaterThan(30);
    expect(unresolved).toBe(0);
    expectAtlasDisjoint(cache);
    // The crate without UV1 keeps its light on its surfels, the one with UV1 in its UV1 square.
    const kinds = new Map<string, string>();
    cache.forEachResident((key, _, __, ___, charts) => kinds.set(key, charts[0]?.kind ?? 'none'));
    expect(kinds.get('crate-surfels/')).toBe('surfels');
    expect(kinds.get('crate-uv1/')).toBe('area');
  });

  it('terrain rings: a point is in the finest ring that holds it, and beyond the last it is not resident', () => {
    const scene = new SurfaceScene(sceneInput());
    const cache = new SurfaceCache(64 * 1024 * 1024);
    cache.update([50, 0, -10], scene.tiles, scene.terrains, true);
    const d = cache.diagnostics();
    // 64 × 32 m of terrain: three rings reach across it from anywhere on it (ring 2 holds 95.6 m either side of the eye).
    expect(d.rings['land']).toBe(3);
    expect(d.ringBytes).toBe(3 * TERRAIN_RING_BYTES);
    const near = cache.ringTexelOf('land', 51, -10)!;
    expect(near.ring).toBe(0);
    const far = cache.ringTexelOf('land', 50 + 40, -10)!;
    expect(far.ring).toBe(1);
    expect(cache.ringTexelOf('land', 50 + 200, -10)).toBeNull();
    // Ten centimetres apart near the eye: neighbouring texels.
    const next = cache.ringTexelOf('land', 51.1, -10)!;
    expect((next.x - near.x + 512) % 512).toBe(1);
  });
});

describe('surface cache: residency within the budget', () => {
  /** A row of `n` tiles `gap` metres apart, each one chart of `size` × `size` metres. */
  function row(n: number, gap = 14, size = 24): SurfaceTile[] {
    const chart: SurfaceChart = { kind: 'area', w: size, h: size };
    return Array.from({ length: n }, (_, i) => ({ key: `t${i}`, min: [i * gap, 0, 0], max: [i * gap + 1, 1, 1], version: 1, charts: () => [chart] }));
  }

  it('levels fall with distance; when the budget is full the farthest tiles go coarser, then are let go', () => {
    expect(surfaceLevelFor(5)).toBe(0);
    expect(surfaceLevelFor(20)).toBe(1);
    expect(surfaceLevelFor(1e6)).toBe(5);
    const tiles = row(2000);
    const roomy = new SurfaceCache(256 * 1024 * 1024);
    roomy.update([0, 0, 0], tiles, [], true);
    expect(roomy.diagnostics().tiles.resident).toBe(2000);
    expect(roomy.levelOf('t0')).toBe(0);
    expect(roomy.levelOf('t1999')).toBe(surfaceLevelFor(1999 * 14));
    // Four pages: a 24 m chart at level 0 takes one, at level 5 a 16² block.
    const tight = new SurfaceCache(4 * SURFACE_PAGE_BYTES);
    tight.update([0, 0, 0], tiles, [], true);
    const d = tight.diagnostics();
    expect(d.usedBytes).toBeLessThanOrEqual(d.budgetBytes);
    expect(d.tiles.beyond).toBeGreaterThan(0);
    expect(d.tiles.resident + d.tiles.beyond).toBe(2000);
    // What is held is the nearest, never finer than its distance asks.
    let last = -1;
    for (let i = 0; i < 2000; i += 1) {
      const l = tight.levelOf(`t${i}`);
      if (l === null) {
        for (let j = i; j < 2000; j += 1) expect(tight.levelOf(`t${j}`)).toBeNull();
        break;
      }
      expect(l).toBeGreaterThanOrEqual(surfaceLevelFor(i * 14));
      last = i;
    }
    expect(last).toBeGreaterThan(400);
  });

  it('moving along the row streams tiles in and out, never above the budget, and a still eye changes nothing', () => {
    const tiles = row(2000);
    const budget = 4 * SURFACE_PAGE_BYTES;
    const cache = new SurfaceCache(budget);
    let ms = 0;
    for (let x = 0, n = 0; x <= 14000; x += 23, n += 1) {
      cache.update([x, 0, 0], tiles, [], false);
      const d = cache.diagnostics();
      expect(d.usedBytes).toBeLessThanOrEqual(budget);
      expect(cache.levelOf(`t${Math.round(x / 14)}`)).toBe(0);
      if (n % 50 === 0) expectAtlasDisjoint(cache);
      ms = Math.max(ms, d.ms);
    }
    const d = cache.diagnostics();
    expect(d.evicted).toBeGreaterThan(50);
    expect(d.peakUsedBytes).toBeLessThanOrEqual(budget);
    // A decision over 2,000 tiles takes a few milliseconds (a generous bound: hosts vary).
    expect(ms).toBeLessThan(50);
    cache.update([14000.3, 0, 0], tiles, [], false);
    cache.takeChanges();
    cache.update([14000.3, 0, 0], tiles, [], false);
    cache.update([14000.3, 0, 0], tiles, [], true);
    const ch = cache.takeChanges();
    expect(ch.allocated).toEqual([]);
    expect(ch.freed).toEqual([]);
    // Tiles that leave the scene (unloaded) are let go at once.
    cache.update([14000.3, 0, 0], tiles.slice(0, 1000), [], true);
    expect(cache.levelOf('t1000')).toBeNull();
    expect(cache.levelOf('t999')).not.toBeNull();
    expect(cache.takeChanges().freed.length).toBeGreaterThan(0);
  });

  it('the atlas hands out blocks from 8 texels to a page and joins them again', () => {
    const atlas = new PageAtlas(3);
    const r = rng(9);
    const got = [];
    for (let i = 0; i < 400; i += 1) {
      const side = 8 << Math.floor(r() * 4);
      const b = atlas.alloc(side);
      if (b !== null) got.push(b);
    }
    expect(atlas.usedTexels).toBeLessThanOrEqual(3 * SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS);
    for (const b of got) atlas.release(b);
    expect(atlas.usedTexels).toBe(0);
    for (let p = 0; p < 3; p += 1) expect(atlas.alloc(SURFACE_PAGE_TEXELS)).not.toBeNull();
    expect(atlas.alloc(8)).toBeNull();
    // A tile larger than a page spreads over whole pages.
    const big = packTile(Array.from({ length: 30 }, () => ({ kind: 'area' as const, w: 9, h: 9 })), 0);
    expect(big.blocks.filter((b) => b === SURFACE_PAGE_TEXELS).length).toBeGreaterThan(1);
  });
});

describe('surface cache on the page', () => {
  it('offers the loaded scene as its charts are made, a little each frame, and reads static models\' files', async () => {
    const { grid, origin } = blockRoom();
    const big = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [96, 4, 96] } });
    for (let x = 0; x < 96; x += 1) for (let z = 0; z < 96; z += 1) for (let y = 0; y < 1 + ((x * 7 + z * 13) % 3); y += 1) big.set(x, y, z, { block: 'rock' });
    const file = encodeDistanceBricks({ sets: [buildDistanceBrickSet('', [crate(false)])!] });
    let reads = 0;
    const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 1, 5, 1];
    const host = new SurfaceCacheHost(
      {
        layers: () => [
          { id: 'room', origin, grid, version: 1, chunks: [['0,0', 1], ['1,0', 1]], opaque: OPAQUE },
          { id: 'town', origin: [0, 0, 40], grid: big, version: 1, chunks: Array.from({ length: 36 }, (_, i) => [`${i % 6},${Math.floor(i / 6)}`, 1] as const), opaque: OPAQUE },
        ],
        terrains: () => [{ id: 'land', field: terrainField() }],
        architecture: () => [{ id: 'house', component: ROOM, origin: [0, 0.5, -16] }],
        models: () => [{ id: 'crate', assetId: 'crate', version: 3, piece: null, world }, { id: 'crate-2', assetId: 'crate', version: 3, piece: null, world: world.map((v, i) => (i === 12 ? 9 : v)) }],
        bricks: () => {
          reads += 1;
          return Promise.resolve(file);
        },
      },
      64 * 1024 * 1024,
    );
    let frames = 0;
    let worst = 0;
    for (; frames < 400; frames += 1) {
      host.update([4, 2, 4]);
      await Promise.resolve();
      const d = host.diagnostics();
      worst = Math.max(worst, d.prepareMs);
      if (frames > 2 && d.preparing === 0 && d.reading === 0 && d.tiles.resident === d.tiles.offered && d.tiles.offered > 0) {
        host.touch();
        host.update([4, 2, 4]);
        if (host.diagnostics().tiles.offered === d.tiles.offered) break;
      }
    }
    const d = host.diagnostics();
    // Made over several frames, each within its share (one chart set may run past it).
    expect(frames).toBeGreaterThan(1);
    expect(worst).toBeLessThan(SURFACE_PREPARE_MS + 50);
    // Two room chunks, the town's chunks with faces, the house and two crates.
    expect(d.tiles.offered).toBe(2 + 36 + 1 + 2);
    expect(d.tiles.resident).toBe(d.tiles.offered);
    expect(d.usedBytes).toBeLessThanOrEqual(d.budgetBytes);
    expect(d.rings['land']).toBe(3);
    // One read per model file, however many objects place it.
    expect(reads).toBe(1);
    // A smaller budget holds less, never more than it.
    host.setBudget(16 * 1024 * 1024);
    host.update([4, 2, 4]);
    const small = host.diagnostics();
    expect(small.budgetBytes).toBe(16 * 1024 * 1024);
    expect(small.usedBytes).toBeLessThanOrEqual(small.budgetBytes);
  });
});
