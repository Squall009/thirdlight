/**
 * The tracer against brute force, per geometry kind: every ray's nearest hit
 * is also found by testing it against every cell box, terrain triangle,
 * architecture box or model triangle on its own, and the tracer's distance,
 * normal and address must agree. Real engine data feeds it (a `BlockGrid`, a
 * `TerrainField` over encoded tiles).
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, TerrainField, type BlockType, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { rayTriangle, traceRayCpu, sceneView, unpackUnorm2, type TraceHit, type V3 } from './tracer-cpu';
import { opaqueByBlockTypes, traceBlockLayerOf, traceTerrainOf } from './tracer-sources';
import { TRACE_BLOCKS, TRACE_MISS, TRACE_TERRAIN, TRACE_UNFINISHED, packTraceScene, type TraceSceneSource } from './tracer-scene';

/** A seeded generator (mulberry32). */
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

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Trace, re-tracing from where an unfinished ray stopped (what a caller does over passes). */
function traceToEnd(src: TraceSceneSource, o: V3, d: V3, tmax: number): { hit: TraceHit; passes: number } {
  const s = sceneView(packTraceScene(src));
  let tmin = 0;
  for (let passes = 1; passes < 64; passes += 1) {
    const hit = traceRayCpu(s, o, d, tmin, tmax);
    if (hit.kind !== TRACE_UNFINISHED) return { hit, passes };
    expect(hit.t).toBeGreaterThan(tmin);
    tmin = hit.t;
  }
  throw new Error('never finished');
}

/** Slab test of a box; the entry distance and its face normal. */
function rayBox(o: V3, d: V3, lo: V3, hi: V3, tmax: number): { t: number; n: V3 } | null {
  let t0 = 0;
  let t1 = tmax;
  let n: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k += 1) {
    const inv = 1 / d[k]!;
    const a = (lo[k]! - o[k]!) * inv;
    const b = (hi[k]! - o[k]!) * inv;
    const near = Math.min(a, b);
    if (near > t0) {
      t0 = near;
      n = [0, 0, 0];
      n[k] = d[k]! > 0 ? -1 : 1;
    }
    t1 = Math.min(t1, Math.max(a, b));
  }
  // A ray starting inside the box meets it where it starts.
  return t0 < t1 ? { t: t0, n } : null;
}

const TYPES: BlockType[] = [
  { blockId: 'rock', shape: 'full' } as BlockType,
  { blockId: 'slab', shape: 'half' } as BlockType,
];

describe('tracer: block layers', () => {
  const cellSize: V3 = [1, 0.5, 1];
  const origin: V3 = [-10.5, 2, 4.25];
  function layer(seed: number, min: V3, max: V3, fill: number): { grid: BlockGrid; cells: V3[] } {
    const grid = new BlockGrid({ cellSize, bounds: { min, max } });
    const r = rng(seed);
    const cells: V3[] = [];
    for (let y = min[1]; y < max[1]; y += 1) {
      for (let z = min[2]; z < max[2]; z += 1) {
        for (let x = min[0]; x < max[0]; x += 1) {
          const v = r();
          if (v < fill) {
            grid.set(x, y, z, { block: 'rock' });
            cells.push([x, y, z]);
          } else if (v < fill * 1.5) grid.set(x, y, z, { block: 'slab' });
        }
      }
    }
    return { grid, cells };
  }
  function brute(cells: V3[], o: V3, d: V3, tmax: number): { t: number; n: V3; cell: V3 } | null {
    let best: { t: number; n: V3; cell: V3 } | null = null;
    for (const c of cells) {
      const lo: V3 = [origin[0] + c[0] * cellSize[0], origin[1] + c[1] * cellSize[1], origin[2] + c[2] * cellSize[2]];
      const hi: V3 = [lo[0] + cellSize[0], lo[1] + cellSize[1], lo[2] + cellSize[2]];
      const h = rayBox(o, d, lo, hi, tmax);
      if (h !== null && (best === null || h.t < best.t)) best = { ...h, cell: c };
    }
    return best;
  }

  it('meets the nearest opaque cell (half blocks let light through), with its face and cell', () => {
    const min: V3 = [-6, -2, -5];
    const max: V3 = [30, 20, 26];
    const { grid, cells } = layer(7, min, max, 0.03);
    const src: TraceSceneSource = { blocks: [traceBlockLayerOf(grid, origin, opaqueByBlockTypes(TYPES))] };
    const r = rng(11);
    let hits = 0;
    for (let i = 0; i < 400; i += 1) {
      const o: V3 = [origin[0] + (r() * 44 - 8), origin[1] + r() * 12 - 1, origin[2] + r() * 40 - 8];
      const d = unit([r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]);
      const ref = brute(cells, o, d, 200);
      const { hit } = traceToEnd(src, o, d, 200);
      if (ref === null) {
        expect(hit.kind).toBe(TRACE_MISS);
        continue;
      }
      hits += 1;
      expect(hit.kind).toBe(TRACE_BLOCKS);
      expect(hit.t).toBeCloseTo(ref.t, 4);
      if (ref.t > 0) expect(hit.normal.map((v) => Math.round(v))).toEqual(ref.n.map((v) => v + 0));
      const D = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const [x, y, z] = [ref.cell[0] - min[0], ref.cell[1] - min[1], ref.cell[2] - min[2]];
      expect(hit.a0).toBe((y * D[2]! + z) * D[0]! + x);
      const [fu, fv] = unpackUnorm2(hit.a1);
      expect(fu).toBeGreaterThanOrEqual(0);
      expect(fv).toBeLessThanOrEqual(1);
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('steps empty chunks whole across a large layer, and resumes rays that run out of steps', () => {
    // 512 cells wide, nearly empty: a ray across it crosses ~30 chunks but few cells.
    const min: V3 = [0, 0, 0];
    const max: V3 = [512, 32, 512];
    const grid = new BlockGrid({ cellSize, bounds: { min, max } });
    const cells: V3[] = [];
    for (const c of [[500, 3, 497], [260, 10, 255], [3, 2, 7]] as V3[]) {
      grid.set(c[0], c[1], c[2], { block: 'rock' });
      cells.push(c);
    }
    // A dense band of chunks with one far cell each forces cell steps (every chunk occupied).
    for (let x = 16; x < 496; x += 16) {
      grid.set(x + 15, 31, 0, { block: 'rock' });
      cells.push([x + 15, 31, 0]);
    }
    const src: TraceSceneSource = { blocks: [traceBlockLayerOf(grid, origin, opaqueByBlockTypes(TYPES))] };
    const target: V3 = [origin[0] + 500.5, origin[1] + 3.5 * 0.5, origin[2] + 497.5];
    const o: V3 = [origin[0] + 3.5, origin[1] + 8, origin[2] + 3.5];
    const d = unit([target[0] - o[0], target[1] - o[1], target[2] - o[2]]);
    const ref = brute(cells, o, d, 2000)!;
    const { hit, passes } = traceToEnd(src, o, d, 2000);
    expect(hit.kind).toBe(TRACE_BLOCKS);
    expect(hit.t).toBeCloseTo(ref.t, 3);
    expect(passes).toBe(1);
    // Along the occupied band every chunk's cells are walked: more than one pass's budget.
    const o2: V3 = [origin[0] + 16.2, origin[1] + 15.25, origin[2] + 0.5];
    const d2 = unit([1, 0.00001, 0.00001]);
    const ref2 = brute(cells, o2, d2, 2000);
    const run = traceToEnd(src, o2, d2, 2000);
    expect(ref2).toBeNull();
    expect(run.hit.kind).toBe(TRACE_MISS);
    expect(run.passes).toBeGreaterThan(1);
  });
});

describe('tracer: terrain', () => {
  const comp: TerrainComponent = { tileSamples: 17, spacing: 2, heightRange: [-8, 24], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: 2, z: 1 }] } as TerrainComponent;
  const origin: V3 = [-20, 1.5, 7];
  function field(seed: number): TerrainField {
    const r = rng(seed);
    const tiles = new Map<string, TerrainTile>();
    for (const t of comp.tiles) {
      const heights = new Uint16Array(17 * 17);
      // Hills from a few bumps, continuous over tile edges (positions are global samples).
      for (let z = 0; z < 17; z += 1) {
        for (let x = 0; x < 17; x += 1) {
          const gx = t.x * 16 + x;
          const gz = t.z * 16 + z;
          const h = 4 + 6 * Math.sin(gx * 0.31) * Math.cos(gz * 0.23) + 3 * Math.sin(gx * 0.07 + gz * 0.11);
          heights[z * 17 + x] = Math.round(((h + 8) / 32) * 65535);
        }
      }
      const holes = new Uint8Array(32);
      if (t.x === 1) for (let k = 0; k < 6; k += 1) {
        const c = Math.floor(r() * 256);
        holes[c >> 3]! |= 1 << (c & 7);
      }
      tiles.set(`${t.x},${t.z}`, { samples: 17, heights, weights: null, holes: t.x === 1 ? holes : null, paint: null });
    }
    return new TerrainField(comp, origin, tiles);
  }
  function triangles(f: TerrainField): { a: V3; b: V3; c: V3 }[] {
    const out: { a: V3; b: V3; c: V3 }[] = [];
    for (const [key, t] of f.loadedTiles()) {
      const [tx, tz] = key.split(',').map(Number) as [number, number];
      const h = (x: number, z: number): number => origin[1] + comp.heightRange[0]! + (t.heights[z * 17 + x]! / 65535) * 32;
      for (let z = 0; z < 16; z += 1) {
        for (let x = 0; x < 16; x += 1) {
          const ci = z * 16 + x;
          if (t.holes !== null && (t.holes[ci >> 3]! & (1 << (ci & 7))) !== 0) continue;
          const P = (dx: number, dz: number): V3 => [origin[0] + (tx * 16 + x + dx) * 2, h(x + dx, z + dz), origin[2] + (tz * 16 + z + dz) * 2];
          out.push({ a: P(0, 0), b: P(1, 0), c: P(0, 1) }, { a: P(1, 1), b: P(0, 1), c: P(1, 0) });
        }
      }
    }
    return out;
  }

  it('meets the nearest terrain triangle (holes and missing tiles open), with its normal and cell', () => {
    const f = field(3);
    const t = traceTerrainOf(f, comp.heightRange)!;
    const src: TraceSceneSource = { terrain: [t] };
    const tris = triangles(f);
    const r = rng(5);
    let hits = 0;
    let unfinished = 0;
    for (let i = 0; i < 500; i += 1) {
      const o: V3 = [origin[0] + r() * 110 - 7, origin[1] + 2 + r() * 30, origin[2] + r() * 76 - 6];
      const d = unit([r() * 2 - 1, -0.05 - r() * (i % 3 === 0 ? 0.15 : 1), r() * 2 - 1]);
      let ref: { t: number; tri: { a: V3; b: V3; c: V3 } } | null = null;
      for (const tri of tris) {
        const th = rayTriangle(o, d, tri.a, tri.b, tri.c, 0, 300);
        if (th < (ref?.t ?? Infinity)) ref = { t: th, tri };
      }
      const run = traceToEnd(src, o, d, 300);
      if (run.passes > 1) unfinished += 1;
      if (ref === null) {
        expect(run.hit.kind).toBe(TRACE_MISS);
        continue;
      }
      hits += 1;
      expect(run.hit.kind).toBe(TRACE_TERRAIN);
      expect(run.hit.t).toBeCloseTo(ref.t, 3);
      const { a, b, c } = ref.tri;
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let n = unit([e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]);
      if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
      for (let k = 0; k < 3; k += 1) expect(run.hit.normal[k]).toBeCloseTo(n[k]!, 4);
      const p: V3 = [o[0] + d[0] * run.hit.t, 0, o[2] + d[2] * run.hit.t];
      const cx = Math.floor((p[0] - origin[0]) / 2);
      const cz = Math.floor((p[2] - origin[2]) / 2);
      const [fx, fz] = unpackUnorm2(run.hit.a1);
      expect(cz * t.cellsX + cx === run.hit.a0 || fx < 1e-3 || fz < 1e-3 || fx > 0.999 || fz > 0.999).toBe(true);
    }
    expect(hits).toBeGreaterThan(120);
    // Grazing rays may need a second pass; most finish in one.
    expect(unfinished).toBeLessThan(25);
  });
});
