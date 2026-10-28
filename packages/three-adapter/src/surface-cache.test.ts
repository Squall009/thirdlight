/**
 * The surface cache's addressing per geometry kind and its residency, at the
 * tracer's own boundary: real engine data (a `BlockGrid`, a `TerrainField`,
 * architecture's colliders, bricks and surfels built from a mesh as an
 * import builds them) packed for the CPU tracer, traced rays' hits resolved
 * to texels, and the atlas checked texel by texel.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BlockGrid, TerrainField, buildDistanceBrickSet, encodeDistanceBricks, type ArchitectureComponent, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { SURFACE_PAGE_BYTES, SURFACE_PAGE_TEXELS, PageAtlas, areaTexels, packTile, type SurfaceChart } from './surface-cache-atlas';
import { blockChunkCharts } from './surface-cache-blocks';
import { SurfaceCache, surfaceLevelFor, type SurfaceTexel, type SurfaceTile } from './surface-cache';
import { surfelLevelFor } from './surface-cache-atlas';
import { invertAffine } from './tracer-words';
import { SurfaceCacheHost, SurfaceModelSlots, SURFACE_PREPARE_MS } from './surface-cache-host';
import { markStaticModelRead } from './adapter-surface-cache';
import type { EntityDoc } from './adapter-entities';
import type { SceneAdapterOptions } from './adapter-types';
import { MODEL_PIECE_KEY, tagModelPieces } from './pieces';
import { surfaceSlotOf } from './surface-cache-read';
import { SurfaceScene, type ArchTile, type BlockTile, type ModelTile, type SurfaceSceneInput } from './surface-cache-scene';
import { TERRAIN_RING_BYTES } from './surface-cache-terrain';
import { traceRayCpu, sceneView, type V3 } from './tracer-cpu';
import { opaqueByBlockTypes, traceBlockLayerOf, traceTerrainOf } from './tracer-sources';
import { HIT_WORDS, TRACE_ARCH, TRACE_BLOCKS, TRACE_BRICKS, TRACE_MISS, TRACE_TERRAIN, TRACE_UNFINISHED, packTraceScene, worldToLocalOf } from './tracer-scene';
import { packResolveTable, resolveHitCpu, texelWords } from './surface-resolve';
import { SURFACE_READ, lookupSurfaceCpu, packSurfaceLookup } from './surface-cache-lookup';
import { TERRAIN_RINGS_MAX } from './surface-cache-terrain';
import { TEXEL_POINT_FLOATS, patchTexelAddresses, patchTexelPoints, tileTexelAddresses, tileTexelPoints } from './surface-texels';

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

  it('the GPU resolve\'s table and walk find the texel the CPU addressing does, for every kind', () => {
    const scene = new SurfaceScene(sceneInput());
    const cache = new SurfaceCache(256 * 1024 * 1024);
    cache.update([10, 3, 0], scene.tiles, scene.terrains, true);
    const table = packResolveTable(scene, cache);
    const s = sceneView(packTraceScene(scene.traceSource()));
    const r = rng(5);
    const hits = new Uint32Array(HIT_WORDS);
    const hf = new Float32Array(hits.buffer);
    const byKind = new Map<number, number>();
    let near = 0;
    let n = 0;
    for (let i = 0; i < 6000; i += 1) {
      const o: V3 = [-6 + r() * 50, 1.6 + r() * 4.5, -22 + r() * 34];
      const d = unit([r() * 2 - 1, r() * 2 - 1.3, r() * 2 - 1]);
      let tmin = 0;
      let hit = traceRayCpu(s, o, d, tmin, 120);
      while (hit.kind === TRACE_UNFINISHED) {
        tmin = hit.t;
        hit = traceRayCpu(s, o, d, tmin, 120);
      }
      if (hit.kind === TRACE_MISS || hit.t <= 1e-4) continue;
      hf[0] = hit.t;
      hf.set(hit.normal, 1);
      hits.set([hit.kind | (hit.face << 8), hit.object, hit.a0, hit.a1], 4);
      const want = texelWords(scene.resolve(cache, hit), table.terrains);
      const got = resolveHitCpu(table.words, hits, 0);
      n += 1;
      byKind.set(hit.kind, (byKind.get(hit.kind) ?? 0) + 1);
      if (got[0] === want[0] && got[1] === want[1]) continue;
      // The table holds f32: a point within a hair of a texel's edge may land in the neighbour, never further.
      expect(got[0]).toBe(want[0]);
      expect(Math.abs((got[1] & 0xffff) - (want[1] & 0xffff)) + Math.abs((got[1] >>> 16) - (want[1] >>> 16))).toBeLessThanOrEqual(1);
      near += 1;
    }
    for (const kind of [TRACE_BLOCKS, TRACE_TERRAIN, TRACE_ARCH, TRACE_BRICKS]) expect(byKind.get(kind) ?? 0, `kind ${kind}`).toBeGreaterThan(30);
    expect(near / n).toBeLessThan(0.002);
    // A tile let go resolves to nothing.
    cache.update([10, 3, 0], [], scene.terrains, true);
    const gone = packResolveTable(scene, cache);
    expect(resolveHitCpu(gone.words, hits, 0)[0] === 0 || hits[4]! % 256 === TRACE_TERRAIN).toBe(true);
  });

  it('a drawn pixel finds the texel the CPU addressing gives its point, from its position and normal alone (blocks, terrain, architecture: its rectangle found at a vertex of its triangle)', () => {
    const scene = new SurfaceScene(sceneInput());
    const cache = new SurfaceCache(256 * 1024 * 1024);
    cache.update([10, 3, 0], scene.tiles, scene.terrains, true);
    const words = packSurfaceLookup(scene, cache);
    const s = sceneView(packTraceScene(scene.traceSource()));
    const r = rng(9);
    const kindOf = new Map([[TRACE_BLOCKS, SURFACE_READ.blocks], [TRACE_TERRAIN, SURFACE_READ.terrain], [TRACE_ARCH, SURFACE_READ.arch]]);
    const tried = new Map<number, number>();
    const same = new Map<number, number>();
    let coarser = 0;
    let otherChart = 0;
    let fromVertex = 0;
    for (let i = 0; i < 6000; i += 1) {
      const o: V3 = [-6 + r() * 50, 1.6 + r() * 4.5, -22 + r() * 34];
      const d = unit([r() * 2 - 1, r() * 2 - 1.3, r() * 2 - 1]);
      let tmin = 0;
      let hit = traceRayCpu(s, o, d, tmin, 120);
      while (hit.kind === TRACE_UNFINISHED) {
        tmin = hit.t;
        hit = traceRayCpu(s, o, d, tmin, 120);
      }
      const kind = kindOf.get(hit.kind);
      if (kind === undefined || hit.t <= 1e-4) continue;
      const want = scene.resolve(cache, hit);
      if (want === null) continue;
      const p: V3 = [o[0] + d[0] * hit.t, o[1] + d[1] * hit.t, o[2] + d[2] * hit.t];
      const got = lookupSurfaceCpu(words, kind, p, hit.normal);
      tried.set(kind, (tried.get(kind) ?? 0) + 1);
      if (kind === SURFACE_READ.arch) {
        // A triangle's pixels read the rectangle its first vertex found: from a vertex elsewhere on the same plane the
        // pixel still reads its own chart (or nothing, the vertex on another rectangle it is off), never another chart.
        const n = hit.normal;
        const t = unit(Math.abs(n[1]) > 0.9 ? [n[2], 0, -n[0]] : [-n[2], 0, n[0]]);
        const vertex = [p[0] + t[0] * 1.5, p[1] + t[1] * 1.5 + 0.4, p[2] + t[2] * 1.5];
        const moved = lookupSurfaceCpu(words, kind, p, n, { vertex });
        if (moved !== null) {
          expect(moved).toEqual(got);
          fromVertex += 1;
        }
        expect(lookupSurfaceCpu(words, kind, p, n, { vertex: [p[0] + n[0] * 0.5, p[1] + n[1] * 0.5, p[2] + n[2] * 0.5] })).toBeNull();
      }
      expect(got, `kind ${kind} at ${p.map((v) => v.toFixed(3))}`).not.toBeNull();
      if ('page' in want) {
        expect(got!.texture).toBe('atlas');
        // f32 positions: a point within a hair of a texel's edge may land in the neighbour, never further.
        const off = Math.abs(Math.floor(got!.x) - want.x) + Math.abs(Math.floor(got!.y) - want.y);
        // Architecture: disjoint pieces on one plane whose rectangles overlap each hold that point's light; the lookup takes the first.
        if (kind === SURFACE_READ.arch && (got!.layer !== want.page || off > 1)) {
          otherChart += 1;
          continue;
        }
        expect(got!.layer).toBe(want.page);
        // f32 positions: a point within a hair of a texel's edge may land in the neighbour, never further.
        expect(off, `kind ${kind} at ${p.map((v) => v.toFixed(3))}`).toBeLessThanOrEqual(1);
        if (off === 0) same.set(kind, (same.get(kind) ?? 0) + 1);
      } else {
        expect(got!.texture).toBe('rings');
        const base = cache.ringTerrains().indexOf(want.terrain) * TERRAIN_RINGS_MAX;
        // Within a texel of a ring's edge the next ring out is read (the filter stays inside a window).
        if (got!.layer === base + want.ring + 1) {
          coarser += 1;
          continue;
        }
        expect(got!.layer).toBe(base + want.ring);
        const wrap = (v: number): number => ((Math.floor(v) % 512) + 512) % 512;
        if (wrap(got!.x) === want.x && wrap(got!.y) === want.y) same.set(kind, (same.get(kind) ?? 0) + 1);
      }
    }
    for (const kind of [SURFACE_READ.blocks, SURFACE_READ.terrain, SURFACE_READ.arch]) {
      expect(tried.get(kind) ?? 0, `kind ${kind}`).toBeGreaterThan(30);
      expect((same.get(kind) ?? 0) / tried.get(kind)!, `kind ${kind}`).toBeGreaterThan(kind === SURFACE_READ.arch ? 0.95 : 0.99);
    }
    expect(coarser / tried.get(SURFACE_READ.terrain)!).toBeLessThan(0.02);
    expect(otherChart / tried.get(SURFACE_READ.arch)!).toBeLessThan(0.05);
    expect(fromVertex / tried.get(SURFACE_READ.arch)!).toBeGreaterThan(0.3);
    // Off every surface (in the air, a normal no chart faces) nothing is found.
    expect(lookupSurfaceCpu(words, SURFACE_READ.blocks, [100, 50, 100], [0, 1, 0])).toBeNull();
    expect(lookupSurfaceCpu(words, SURFACE_READ.arch, [4, 2, -12], [0, 1, 0])).toBeNull();
    // A tile let go is read by nobody.
    cache.update([10, 3, 0], [], scene.terrains, true);
    const gone = packSurfaceLookup(scene, cache);
    expect(lookupSurfaceCpu(gone, SURFACE_READ.blocks, [0.5, 1.5, 3], [0, 1, 0])).toBeNull();
  });

  it('a static model\'s pixel finds its surfel\'s texel by its copy\'s slot, or its UV1 in the square', () => {
    const scene = new SurfaceScene(sceneInput());
    const cache = new SurfaceCache(256 * 1024 * 1024);
    cache.update([10, 3, 0], scene.tiles, scene.terrains, true);
    const slots = new Map([['crate-surfels/', 1], ['crate-uv1/', 2]]);
    const words = packSurfaceLookup(scene, cache, (owner) => slots.get(owner));
    const r = rng(3);
    for (const [owner, uv1] of [['crate-surfels', false], ['crate-uv1', true]] as const) {
      const tile = scene.tiles.find((t) => (t as ModelTile).owner === owner) as ModelTile;
      const level = cache.levelOf(tile.key)!;
      const toWorld = invertAffine(tile.worldToLocal);
      const s = tile.set.surfels!;
      const mesh = crate(uv1);
      let tried = 0;
      let missed = 0;
      let nearCell = 0;
      for (let i = 0; i < 2000; i += 1) {
        // A point on a random triangle of the mesh, in the model's root, then in the world.
        const tri = mesh.triangles[Math.floor(r() * mesh.triangles.length)]!;
        let a = r();
        let b = r();
        if (a + b > 1) [a, b] = [1 - a, 1 - b];
        const [p0, p1, p2] = tri.map((k) => mesh.positions[k]!) as [V3, V3, V3];
        const lp = [0, 1, 2].map((k) => p0[k]! + (p1[k]! - p0[k]!) * a + (p2[k]! - p0[k]!) * b);
        const e1 = [0, 1, 2].map((k) => p1[k]! - p0[k]!);
        const e2 = [0, 1, 2].map((k) => p2[k]! - p0[k]!);
        const ln = unit([e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]);
        const wp = [0, 1, 2].map((k) => toWorld[k * 4]! * lp[0]! + toWorld[k * 4 + 1]! * lp[1]! + toWorld[k * 4 + 2]! * lp[2]! + toWorld[k * 4 + 3]!);
        // Normals through the inverse transpose: the world → root map's columns.
        const w = tile.worldToLocal;
        const wn = unit([0, 1, 2].map((k) => w[k]! * ln[0] + w[4 + k]! * ln[1] + w[8 + k]! * ln[2]) as V3);
        const uv = uv1 ? (() => {
          const t = tri.map((k) => [mesh.uv1![k * 2]!, mesh.uv1![k * 2 + 1]!]) as [number[], number[], number[]];
          return [0, 1].map((k) => t[0]![k]! + (t[1]![k]! - t[0]![k]!) * a + (t[2]![k]! - t[0]![k]!) * b);
        })() : undefined;
        const got = lookupSurfaceCpu(words, SURFACE_READ.model, wp, wn, { slot: slots.get(`${owner}/`)!, ...(uv !== undefined ? { uv1: uv } : {}) });
        tried += 1;
        if (got === null) {
          missed += 1;
          continue;
        }
        expect(got.texture).toBe('atlas');
        if (uv !== undefined) {
          // The UV1 square: the texel the CPU addressing gives the pixel's UV1.
          const want = cache.texelOf(tile.key, 0, { u: uv[0]! * (tile.chart as { w: number }).w, v: uv[1]! * (tile.chart as { h: number }).h }) as { page: number; x: number; y: number };
          expect([got.layer, Math.floor(got.x), Math.floor(got.y)]).toEqual([want.page, want.x, want.y]);
          continue;
        }
        // A surfel's texel, whose surfel stands in the pixel's cell at the level the cache holds the tile at and faces its way.
        const k = surfelLevelFor(tile.chart as unknown as { levels: number[]; spacing: number }, level);
        const cell = s.spacing * 2 ** k;
        let index = -1;
        for (let j = 0; j < (s.levels[k] ?? 0); j += 1) {
          const want = cache.texelOf(tile.key, 0, { index: j }) as { page: number; x: number; y: number };
          if (want.page === got.layer && want.x === Math.floor(got.x) && want.y === Math.floor(got.y)) index = j;
        }
        expect(index).toBeGreaterThanOrEqual(0);
        const sp = [s.positions[index * 3]!, s.positions[index * 3 + 1]!, s.positions[index * 3 + 2]!];
        // f32 placements: a point within a hair of a cell's edge may take the neighbour cell's surfel, never one further.
        const off = [0, 1, 2].reduce((n, q) => n + Math.abs(Math.floor(sp[q]! / cell) - Math.floor(lp[q]! / cell)), 0);
        expect(off).toBeLessThanOrEqual(1);
        if (off === 1) nearCell += 1;
        expect(s.normals[index * 3]! * ln[0] + s.normals[index * 3 + 1]! * ln[1] + s.normals[index * 3 + 2]! * ln[2]).toBeGreaterThan(0.5);
      }
      // A point of the surface whose cell holds no surfel of its facing (a corner's sliver) keeps its own lights.
      expect(missed / tried, owner).toBeLessThan(0.05);
      expect(nearCell / tried, owner).toBeLessThan(0.01);
    }
    // No slot, another object's slot gone, or a slot past the table: nothing.
    expect(lookupSurfaceCpu(words, SURFACE_READ.model, [30, 1.5, 6], [0, 1, 0], { slot: 0 })).toBeNull();
    expect(lookupSurfaceCpu(words, SURFACE_READ.model, [30, 1.5, 6], [0, 1, 0], { slot: 9 })).toBeNull();
    const without = packSurfaceLookup(scene, cache, (key) => (key === 'crate-uv1/' ? 2 : undefined));
    expect(lookupSurfaceCpu(without, SURFACE_READ.model, [30, 1.5, 6], [0, 1, 0], { slot: 1 })).toBeNull();
  });

  it('each piece of a model placed whole reads its own piece\'s light: one slot per piece, named as its file names it', () => {
    // A file of two pieces side by side, as an import builds its distance-field file (one set per top-level piece).
    const shifted = (dx: number): ReturnType<typeof crate> => {
      const c = crate(false);
      return { ...c, positions: c.positions.map((p) => [p[0] + dx, p[1], p[2]] as V3) };
    };
    const input = sceneInput();
    const bricks = { sets: [buildDistanceBrickSet('a', [shifted(0)])!, buildDistanceBrickSet('b', [shifted(4)])!] };
    const scene = new SurfaceScene({ ...input, models: [...input.models!, { key: 'shelf', worldToLocal: worldToLocalOf([30, 1, 14], [0, 0, 0, 1], [1, 1, 1]), bricks, version: 1 }] });
    const cache = new SurfaceCache(256 * 1024 * 1024);
    cache.update([10, 3, 0], scene.tiles, scene.terrains, true);
    // The realized file: its top-level nodes are its pieces; each mesh is named with its piece while the file is whole.
    const root = new THREE.Group();
    for (const [name, dx] of [['a', 0], ['b', 4]] as const) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 0.8, 1.2), new THREE.MeshBasicMaterial());
      mesh.name = name;
      mesh.position.set(dx, 0.4, 0);
      root.add(mesh);
    }
    tagModelPieces(root);
    const host = { modelSlots: new SurfaceModelSlots() } as unknown as SurfaceCacheHost;
    const opts = { models: { assets: [{ assetId: 'shelf-glb', bricks: true }] } } as unknown as SceneAdapterOptions;
    const docs = new Map([['shelf', { components: { model: { asset: { assetId: 'shelf-glb' } } } }]]) as unknown as ReadonlyMap<string, EntityDoc>;
    markStaticModelRead(host, opts, docs, 'shelf', root);
    const [ma, mb] = root.children as THREE.Mesh[];
    expect(surfaceSlotOf(ma!)).toBeGreaterThan(0);
    expect(surfaceSlotOf(mb!)).not.toBe(surfaceSlotOf(ma!));
    const words = packSurfaceLookup(scene, cache, (key) => host.modelSlots.peek(key));
    for (const [piece, mesh, x] of [['a', ma!, 30], ['b', mb!, 34]] as const) {
      const key = `shelf/${piece}`;
      const tile = scene.tiles.find((t) => t.key === key) as ModelTile;
      const k = surfelLevelFor(tile.chart as unknown as { levels: number[]; spacing: number }, cache.levelOf(key)!);
      const own = new Set<string>();
      for (let j = 0; j < (tile.set.surfels!.levels[k] ?? 0); j += 1) {
        const t = cache.texelOf(key, 0, { index: j }) as { page: number; x: number; y: number };
        own.add(`${t.page}/${t.x}/${t.y}`);
      }
      // Points over the piece's top: each reads a texel of its own piece's surfels.
      let found = 0;
      for (const [dx, dz] of [[-0.5, -0.3], [0, 0], [0.5, 0.3], [0.7, -0.2]] as const) {
        const got = lookupSurfaceCpu(words, SURFACE_READ.model, [x + dx, 1.8, 14 + dz], [0, 1, 0], { slot: surfaceSlotOf(mesh) });
        if (got === null) continue;
        found += 1;
        expect(own.has(`${got.layer}/${Math.floor(got.x)}/${Math.floor(got.y)}`), `${piece} at ${dx},${dz}`).toBe(true);
      }
      expect(found, piece).toBeGreaterThanOrEqual(3);
    }
    // A file of one piece (its levels and collider under one name) is named as its file names it: ''.
    const one = new THREE.Group();
    for (const name of ['rock_LOD0', 'rock_LOD1', 'rock_COL']) one.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry()), { name }));
    tagModelPieces(one);
    expect(one.children.map((c) => c.userData[MODEL_PIECE_KEY])).toEqual(['', '', '']);
  });

  it('every texel\'s point lies on its own texel: a ray onto it resolves back to it, for every kind', () => {
    const scene = new SurfaceScene(sceneInput());
    const cache = new SurfaceCache(256 * 1024 * 1024);
    cache.update([10, 3, 0], scene.tiles, scene.terrains, true);
    const s = sceneView(packTraceScene(scene.traceSource()));
    const pts = new Float32Array(TEXEL_POINT_FLOATS);
    const addr = new Uint32Array(2);
    const room = blockRoom();
    const tried = new Map<string, number>();
    const wrong = new Map<string, number>();
    const back = (p: Float32Array): SurfaceTexel | 'hidden' | null => {
      const n: V3 = [p[3]!, p[4]!, p[5]!];
      const o: V3 = [p[0]! + n[0] * 0.05, p[1]! + n[1] * 0.05, p[2]! + n[2] * 0.05];
      // A surfel's point stands off its mesh by about a voxel of the model's field (`SURFEL_LIFT_VOXELS`).
      const hit = traceRayCpu(s, o, [-n[0], -n[1], -n[2]], 0, 0.5);
      // A face resting on a piece that faces the other way (a wall's foot on its floor) is hidden: the ray meets either.
      if (hit.kind !== TRACE_MISS && hit.normal[0] * n[0] + hit.normal[1] * n[1] + hit.normal[2] * n[2] < -0.5) return 'hidden';
      return hit.kind === TRACE_MISS ? null : scene.resolve(cache, hit);
    };
    for (const tile of scene.tiles) {
      const r = cache.residentOf(tile.key);
      if (r === null) continue;
      const t = tile as BlockTile | ArchTile | ModelTile;
      const texels = r.packing.places.reduce((n, p) => n + p.w * p.h, 0);
      for (let i = 0; i < texels; i += 13) {
        const src = { tile: t, level: r.level, packing: r.packing, charts: r.charts, blocks: r.blocks };
        tileTexelPoints(src, i, i + 1, pts, 0);
        tileTexelAddresses(src, i, i + 1, addr, 0);
        if (pts[3] === 0 && pts[4] === 0 && pts[5] === 0) continue;
        // The texel's place on the atlas: its chart's rectangle, a border texel at its nearest interior one.
        let c = 0;
        let first = 0;
        while (first + r.packing.places[c]!.w * r.packing.places[c]!.h <= i) first += r.packing.places[c++]!.w * r.packing.places[c - 1]!.h;
        const place = r.packing.places[c]!;
        const b = r.blocks[place.block]!;
        const chart = r.charts[c]!;
        // The light pass writes the texel at its own place.
        expect([addr[0]! & 0x3fffffff, addr[1]! & 0xffff, addr[1]! >>> 16]).toEqual([b.page, b.x + place.x + ((i - first) % place.w), b.y + place.y + Math.floor((i - first) / place.w)]);
        let x = (i - first) % place.w;
        let y = Math.floor((i - first) / place.w);
        if (chart.kind === 'area') {
          x = Math.min(areaTexels(chart.w, r.level), Math.max(1, x));
          y = Math.min(areaTexels(chart.h, r.level), Math.max(1, y));
        }
        // A half block's faces have texels but stop no ray (the tracer's rule): nothing to land on.
        if (t.kind === 'blocks') {
          const cell = [0, 1, 2].map((k) => Math.floor(pts[k]! - pts[3 + k]! * 0.01 - room.origin[k]!));
          const at = room.grid.indexAt(cell[0]!, cell[1]!, cell[2]!);
          if (at < 0 || !OPAQUE(room.grid.valueOf(at))) continue;
        }
        const got = back(pts);
        if (got === 'hidden') continue;
        tried.set(t.kind, (tried.get(t.kind) ?? 0) + 1);
        if (got === null || !('page' in got) || got.page !== b.page || got.x !== b.x + place.x + x || got.y !== b.y + place.y + y) wrong.set(t.kind, (wrong.get(t.kind) ?? 0) + 1);
      }
    }
    for (const kind of ['blocks', 'arch', 'model']) expect(tried.get(kind) ?? 0, kind).toBeGreaterThan(20);
    // Block faces land exactly; a surfel's point may lie nearer a neighbour surfel after the hit's quantization.
    expect(wrong.get('blocks') ?? 0).toBe(0);
    expect((wrong.get('model') ?? 0) / tried.get('model')!).toBeLessThan(0.15);
    // An architecture chart is its touching coplanar pieces' bounding rectangle: texels off the pieces (a room's
    // inside on its wall tops' plane) have no surface to land on, and some lie under another rectangle's piece.
    expect((wrong.get('arch') ?? 0) / tried.get('arch')!).toBeLessThan(0.25);
    // Terrain: each ring patch's texel is where the rings hold that point, unless a finer ring holds it.
    const rings = cache.ringsOf('land')!;
    let checked = 0;
    for (let k = 0; k < rings.rings; k += 1) {
      for (const patch of rings.patches(k)) {
        const field = terrainField();
        for (let i = 0; i < patch.w * patch.h; i += 97) {
          patchTexelPoints({ patch, texel: rings.texelMetres(k), field, terrain: 0 }, i, i + 1, pts, 0);
          patchTexelAddresses({ patch, texel: rings.texelMetres(k), field, terrain: 0 }, i, i + 1, addr, 0);
          if (pts[4] === 0) continue;
          const got = back(pts);
          expect(got).not.toBeNull();
          const want = cache.ringTexelOf('land', pts[0]!, pts[2]!);
          expect(got).toEqual(want);
          if (want!.ring === k) {
            expect(want!.x).toBe((((patch.ix + (i % patch.w)) % 512) + 512) % 512);
            expect([addr[0]! & 7, addr[1]! & 0xffff, addr[1]! >>> 16]).toEqual([want!.ring, want!.x, want!.y]);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
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
    // The high tier's reach: each level reaches twice as far, so a tile 20 m out stays at 10 cm.
    expect(surfaceLevelFor(20, 24)).toBe(0);
    roomy.setDetail(1, 2);
    roomy.update([0, 0, 0], tiles, [], true);
    expect([roomy.levelOf('t1'), roomy.levelOf('t2')]).toEqual([0, 1]);
    expect(roomy.levelOf('t1999')).toBe(surfaceLevelFor(1999 * 14, 24));
    roomy.setDetail(1, 1);
    roomy.update([0, 0, 0], tiles, [], true);
    expect(roomy.levelOf('t1')).toBe(surfaceLevelFor(14));
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

  it('static models\' slots are kept per piece of an object and used again once it leaves', () => {
    const alive = new Set(['a', 'b']);
    const host = new SurfaceCacheHost({ layers: () => [], terrains: () => [], architecture: () => [], models: () => [], bricks: () => null, modelAlive: (id) => alive.has(id) }, 64 * 1024 * 1024);
    // Slots: one per piece for as long as its object is in the scene, then used again.
    const slots = host.modelSlots;
    const [a, a2, b] = [slots.slotOf('a', ''), slots.slotOf('a', 'lid'), slots.slotOf('b', '')];
    expect(a).toBeGreaterThan(0);
    expect(new Set([a, a2, b]).size).toBe(3);
    expect(slots.slotOf('a', '')).toBe(a);
    expect(slots.peek('a/lid')).toBe(a2);
    alive.delete('a');
    host.touch();
    host.update([0, 2, 0]);
    expect(slots.peek('a/')).toBeUndefined();
    expect(slots.peek('a/lid')).toBeUndefined();
    expect([slots.slotOf('c', ''), slots.slotOf('c', 'x')].sort()).toEqual([a, a2].sort());
  });
});
