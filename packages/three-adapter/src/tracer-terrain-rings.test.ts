/**
 * A terrain traced in rings round the eye and the scene packed section by
 * section, against the whole field packed at once: real engine data (a
 * `TerrainField` over its tiles, a `BlockGrid`), the CPU twin of the GPU
 * tracer and of its hit resolve.
 */
import { mulberry32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import { BlockGrid, TerrainField, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import { SurfaceCache } from './surface-cache';
import { SurfaceScene } from './surface-cache-scene';
import { packResolveTable, resolveHitCpu, texelWords } from './surface-resolve';
import { sceneView, traceRayCpu, type TraceHit, type V3 } from './tracer-cpu';
import { HIT_WORDS, TRACE_MISS, TRACE_TERRAIN, TRACE_UNFINISHED, packTraceScene, type PackedTraceScene, type TraceSceneSource, type TraceTerrain } from './tracer-scene';
import { DEFAULT_STORAGE_BINDING_BYTES, TraceScenePacker } from './tracer-scene-packer';
import { opaqueByBlockTypes, traceBlockLayerOf, traceTerrainOf } from './tracer-sources';
import { TRACE_RING_CELLS, TerrainTraceRings } from './tracer-terrain-rings';

const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

const N = 64;
const RANGE: [number, number] = [-16, 48];

/** Hills over `tiles` tiles a side of N cells at 1 m (one missing, holes in one), continuous over tile edges. */
function hills(tiles: number, missing: string | null = null): TerrainField {
  const list: { x: number; z: number }[] = [];
  const map = new Map<string, TerrainTile>();
  for (let tz = 0; tz < tiles; tz += 1) for (let tx = 0; tx < tiles; tx += 1) {
    if (`${tx},${tz}` === missing) continue;
    list.push({ x: tx, z: tz });
    const heights = new Uint16Array((N + 1) * (N + 1));
    for (let z = 0; z <= N; z += 1) for (let x = 0; x <= N; x += 1) {
      const gx = tx * N + x;
      const gz = tz * N + z;
      const h = 6 + 5 * Math.sin(gx * 0.05) * Math.cos(gz * 0.04) + 2 * Math.sin(gx * 0.31 + gz * 0.17) + 18 * Math.sin(gx * 0.004);
      heights[z * (N + 1) + x] = Math.round(((h - RANGE[0]) / (RANGE[1] - RANGE[0])) * 65535);
    }
    let holes: Uint8Array | null = null;
    if (tx === 5 && tz === 5) {
      holes = new Uint8Array((N * N) / 8);
      for (let c = 0; c < N * N; c += 37) holes[c >> 3]! |= 1 << (c & 7);
    }
    map.set(`${tx},${tz}`, { samples: N + 1, heights, weights: null, holes, paint: null });
  }
  return new TerrainField({ tileSamples: N + 1, spacing: 1, heightRange: RANGE, tiles: list } as TerrainComponent, [-100, 2, -50], map);
}

function trace(scene: PackedTraceScene, o: V3, d: V3, tmax: number): TraceHit {
  const s = sceneView(scene);
  let tmin = 0;
  for (;;) {
    const hit = traceRayCpu(s, o, d, tmin, tmax);
    if (hit.kind !== TRACE_UNFINISHED) return hit;
    tmin = hit.t;
  }
}

/** The world cell (x, z) a terrain hit names through its record. */
function cellOf(t: TraceTerrain, hit: TraceHit): [number, number] {
  return [t.cellX0 + (hit.a0 % t.cellsX), t.cellZ0 + Math.floor(hit.a0 / t.cellsX)];
}

describe('tracer: terrain in rings round the eye', () => {
  const field = hills(12, '3,8');
  const eye: V3 = [-100 + 300.5, 20, -50 + 410.5];

  it('near the eye the rings trace exactly as the whole field; past the fine ring the coarse rings still meet the ground', () => {
    const rings = new TerrainTraceRings();
    rings.update(field, 0, eye);
    const traces = rings.traces();
    expect(traces.length).toBeGreaterThanOrEqual(2);
    expect(traces[0]!.cellsX).toBeLessThanOrEqual(TRACE_RING_CELLS);
    const whole = traceTerrainOf(field, field.heightSpan())!;
    const exact = packTraceScene({ terrain: [whole] });
    const ringed = packTraceScene({ terrain: traces });
    const r = mulberry32(7);
    let hits = 0;
    for (let i = 0; i < 600; i += 1) {
      const o: V3 = [eye[0] + r() * 120 - 60, 8 + r() * 30, eye[2] + r() * 120 - 60];
      const d = unit([r() * 2 - 1, -0.1 - r(), r() * 2 - 1]);
      const a = trace(exact, o, d, 100);
      const b = trace(ringed, o, d, 100);
      expect(b.kind).toBe(a.kind);
      if (a.kind === TRACE_MISS) continue;
      hits += 1;
      expect(b.object).toBe(0);
      expect(b.t).toBeCloseTo(a.t, 4);
      for (let k = 0; k < 3; k += 1) expect(b.normal[k]).toBeCloseTo(a.normal[k]!, 4);
      expect(cellOf(traces[0]!, b)).toEqual(cellOf(whole, a));
    }
    expect(hits).toBeGreaterThan(200);
    // Low rays out to the far hills: met by a coarse ring wherever the whole field meets them, within its coarser cells.
    let far = 0;
    for (let i = 0; i < 900; i += 1) {
      const o: V3 = [eye[0] + r() * 20 - 10, 34, eye[2] + r() * 20 - 10];
      const az = r() * Math.PI * 2;
      const d = unit([Math.cos(az), -0.002 - r() * 0.03, Math.sin(az)]);
      const a = trace(exact, o, d, 2000);
      if (a.kind === TRACE_MISS || a.t < 310) continue;
      const b = trace(ringed, o, d, 2000);
      expect(b.kind).toBe(TRACE_TERRAIN);
      // The fine ring's own ground is exact; a coarse ring's within its coarser cells.
      if (b.object === 0) expect(b.t).toBeCloseTo(a.t, 3);
      else {
        far += 1;
        expect(Math.abs(b.t - a.t)).toBeLessThan(0.15 * a.t);
      }
    }
    expect(far).toBeGreaterThan(10);
  });

  it('a hit on any ring resolves to its terrain\'s cache texel, on the GPU twin as on the CPU', () => {
    const rings = new TerrainTraceRings();
    rings.update(field, 0, eye);
    const small = hills(1);
    // A terrain before it, so the ringed terrain's records do not start at index 0.
    const scene = new SurfaceScene({ terrain: [{ key: 'small', trace: traceTerrainOf(small, small.heightSpan())! }, ...rings.traces().map((trace) => ({ key: 'hills', trace }))] });
    expect(scene.terrains.map((t) => t.key)).toEqual(['small', 'hills']);
    const cache = new SurfaceCache(256 * 1024 * 1024);
    cache.update(eye, scene.tiles, scene.terrains, true);
    const table = packResolveTable(scene, cache);
    const packed = packTraceScene(scene.traceSource());
    const r = mulberry32(11);
    const words = new Uint32Array(HIT_WORDS);
    const wf = new Float32Array(words.buffer);
    const seen = new Set<number>();
    let n = 0;
    for (let i = 0; i < 1500; i += 1) {
      const o: V3 = [eye[0] + r() * 40 - 20, 30, eye[2] + r() * 40 - 20];
      const az = r() * Math.PI * 2;
      const d = unit([Math.cos(az), -0.01 - r() * (i % 2 === 0 ? 0.05 : 1), Math.sin(az)]);
      const hit = trace(packed, o, d, 3000);
      if (hit.kind !== TRACE_TERRAIN) continue;
      const want = texelWords(scene.resolve(cache, hit), table.terrains);
      if (want[0] === 0) continue;
      wf[0] = hit.t;
      wf.set(hit.normal, 1);
      words.set([hit.kind | (hit.face << 8), hit.object, hit.a0, hit.a1], 4);
      const got = resolveHitCpu(table.words, words, 0);
      expect(got[0]).toBe(want[0]);
      expect(Math.abs((got[1]! & 0xffff) - (want[1] & 0xffff)) + Math.abs((got[1]! >>> 16) - (want[1] >>> 16))).toBeLessThanOrEqual(1);
      seen.add(hit.object);
      n += 1;
    }
    expect(n).toBeGreaterThan(300);
    // Hits on the fine ring and on coarser ones (records past the first terrain's).
    expect([...seen].filter((o) => o >= 1).length).toBeGreaterThanOrEqual(2);
  });
});

describe('the traced scene packed section by section', () => {
  /** A field of `tiles`² tiles sharing one heights array (the shape does not matter, the size does). */
  function wide(tiles: number): TerrainField {
    const heights = new Uint16Array((N + 1) * (N + 1));
    for (let i = 0; i < heights.length; i += 1) heights[i] = (i * 2654435761) % 65536;
    const list: { x: number; z: number }[] = [];
    const map = new Map<string, TerrainTile>();
    for (let z = 0; z < tiles; z += 1) for (let x = 0; x < tiles; x += 1) {
      list.push({ x, z });
      map.set(`${x},${z}`, { samples: N + 1, heights, weights: null, holes: null, paint: null });
    }
    return new TerrainField({ tileSamples: N + 1, spacing: 1, heightRange: RANGE, tiles: list } as TerrainComponent, [0, 0, 0], map);
  }
  const types = [{ blockId: 'rock', shape: 'full' } as BlockType];
  function layer(cells: number): TraceSceneSource['blocks'] {
    const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [64, 8, 64] } });
    for (let i = 0; i < cells; i += 1) g.set(i % 64, 0, Math.floor(i / 64), { block: 'rock' });
    return [traceBlockLayerOf(g, [8000, 0, 8000], opaqueByBlockTypes(types))];
  }
  const size = (dirty: readonly (readonly [number, number])[]): number => dirty.reduce((n, [a, b]) => n + b - a, 0);

  it('a 16 km field stays within a storage binding; the rings follow the eye; a change re-writes only its own section', () => {
    const field = wide(256);
    const rings = new TerrainTraceRings();
    const eye: V3 = [8000.5, 10, 8000.5];
    expect(rings.update(field, 0, eye)).toBe(true);
    const first = rings.traces();
    const packer = new TraceScenePacker();
    const blocks = layer(64 * 20);
    const a = packer.pack({ blocks, terrain: first });
    expect(a.fits).toBe(true);
    // The whole field at its spacing would take ~4 GB; its rings take a few MB a ring.
    expect(a.words.byteLength).toBeLessThanOrEqual(DEFAULT_STORAGE_BINDING_BYTES);
    expect(a.bytes.terrain).toBeLessThan(32 * 1024 * 1024);
    expect(first.length).toBeLessThanOrEqual(7);
    // A step within ring 0's slack moves nothing; past it, ring 0 and the ring round it are made again, the coarse ones kept.
    expect(rings.update(field, 0, [eye[0] + 60, 10, eye[2]])).toBe(false);
    expect(rings.update(field, 0, [eye[0] + 200, 10, eye[2]])).toBe(true);
    const moved = rings.traces();
    expect(moved[0]).not.toBe(first[0]);
    for (let k = 2; k < moved.length; k += 1) expect(moved[k]).toBe(first[k]);
    const b = packer.pack({ blocks, terrain: moved });
    expect(b.resized).toBe(false);
    expect(size(b.dirty)).toBeLessThanOrEqual(16 + b.bytes.terrain / 4);
    expect(b.dirty.some(([from]) => from === 16)).toBe(false);
    // A block layer changed: its section only, and the terrain's items are copied, not packed again.
    const more = layer(64 * 21);
    const t0 = performance.now();
    const c = packer.pack({ blocks: more, terrain: moved });
    const ms = performance.now() - t0;
    expect(size(c.dirty)).toBeLessThanOrEqual(16 + c.bytes.blocks / 4);
    expect(ms).toBeLessThan(50);
    // What the packer holds traces as a scene packed whole.
    const whole = packTraceScene({ blocks: more, terrain: moved });
    const r = mulberry32(3);
    for (let i = 0; i < 200; i += 1) {
      const o: V3 = [eye[0] + 200 + r() * 200 - 100, 40, eye[2] + r() * 200 - 100];
      const d = unit([r() * 2 - 1, -0.05 - r(), r() * 2 - 1]);
      const x = trace(c, o, d, 3000);
      const y = trace(whole, o, d, 3000);
      expect([x.kind, x.object, x.a0, x.a1]).toEqual([y.kind, y.object, y.a0, y.a1]);
    }
    const o: V3 = [8010.5, 5, 8010.5];
    expect(trace(c, o, [0, -1, 0], 10).kind).not.toBe(TRACE_MISS);
    // Made within a frame's budget: the rings before stay traced until the new ones are all made.
    const far: V3 = [eye[0] + 2000, 10, eye[2] - 1500];
    let calls = 0;
    let longest = 0;
    for (;;) {
      calls += 1;
      const t1 = performance.now();
      const done = rings.update(field, 0, far, 1);
      longest = Math.max(longest, performance.now() - t1);
      if (done) break;
      expect(rings.traces().every((t, i) => t === moved[i])).toBe(true);
      expect(rings.busy).toBe(true);
    }
    expect(calls).toBeGreaterThan(5);
    expect(longest).toBeLessThan(15);
    expect(rings.traces()[0]).not.toBe(moved[0]);
  });

  it('a scene over the binding is not packed and says what it needs', () => {
    const packer = new TraceScenePacker(4096);
    const p = packer.pack({ blocks: layer(64 * 64) });
    expect(p.fits).toBe(false);
    expect(p.neededWords * 4).toBeGreaterThan(4096);
  });
});
