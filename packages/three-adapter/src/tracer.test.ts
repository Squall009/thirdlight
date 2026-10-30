/**
 * The tracer against brute force, per geometry kind: every ray's nearest hit
 * is also found by testing it against every cell box, terrain triangle,
 * architecture box or model triangle on its own, and the tracer's distance,
 * normal and address must agree. Real engine data feeds it (a `BlockGrid`, a
 * `TerrainField` over its tiles, architecture's own colliders, bricks built
 * from a mesh as an import builds them).
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, TerrainField, architectureStylesOf, buildDistanceBrickSet, expandArchitecture, buildDistanceBricks, decodeDistanceBricks, encodeDistanceBricks, type ArchitectureComponent, type BlockType, type ModelGeometryPrimitive, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import type { CacheLight } from './surface-changes';
import { lightFrameCpu } from './surface-light-cpu';
import { SHADOW_TRACE } from './surface-light-pass';
import { EXACT_TRACE, rayTriangle, traceRayCpu, sceneView, unpackUnorm2, type TraceHit, type V3 } from './tracer-cpu';
import { opaqueByBlockTypes, traceArchitectureOf, traceBlockLayerOf, traceModelInstancesOf, traceTerrainOf } from './tracer-sources';
import { TRACE_ARCH, TRACE_BLOCKS, TRACE_BRICKS, TRACE_MISS, TRACE_RESUMES, TRACE_TERRAIN, TRACE_UNFINISHED, invertAffine, packTraceScene, worldToLocalOf, type TraceSceneSource } from './tracer-scene';

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
    const hit = traceRayCpu(s, o, d, tmin, tmax, { ...EXACT_TRACE, resumes: 0 });
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

  it('steps empty chunks and sub-blocks whole across a large layer, and resumes rays that run out of steps', () => {
    // 512 cells wide, nearly empty: a ray across it crosses ~30 chunks but few cells.
    const min: V3 = [0, 0, 0];
    const max: V3 = [512, 32, 512];
    const grid = new BlockGrid({ cellSize, bounds: { min, max } });
    const cells: V3[] = [];
    for (const c of [[500, 3, 497], [260, 10, 255], [3, 2, 7]] as V3[]) {
      grid.set(c[0], c[1], c[2], { block: 'rock' });
      cells.push(c);
    }
    // A band of chunks with one far cell each: every chunk is occupied, but the ray's sub-blocks are empty.
    for (let x = 16; x < 496; x += 16) {
      grid.set(x + 15, 31, 0, { block: 'rock' });
      cells.push([x + 15, 31, 0]);
    }
    // A band with a cell in every sub-block along the ray (none on its row) forces cell steps.
    for (let x = 16; x < 496; x += 4) {
      grid.set(x, 28, 3, { block: 'rock' });
      cells.push([x, 28, 3]);
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
    // Past the sparse band in one pass; along the dense band every sub-block's cells are walked: more than one pass's budget.
    const o1: V3 = [origin[0] + 16.2, origin[1] + 10.25, origin[2] + 8.5];
    const sparse = traceToEnd(src, o1, unit([1, 0.00001, 0.00001]), 2000);
    expect(brute(cells, o1, unit([1, 0.00001, 0.00001]), 2000)).toBeNull();
    expect(sparse.hit.kind).toBe(TRACE_MISS);
    expect(sparse.passes).toBe(1);
    const o2: V3 = [origin[0] + 16.2, origin[1] + 15.25, origin[2] + 0.5];
    const d2 = unit([1, 0.00001, 0.00001]);
    const ref2 = brute(cells, o2, d2, 2000);
    const run = traceToEnd(src, o2, d2, 2000);
    expect(ref2).toBeNull();
    expect(run.hit.kind).toBe(TRACE_MISS);
    expect(run.passes).toBeGreaterThan(1);
    // Within one call the tracer resumes it itself, to the same answer.
    const resumed = traceRayCpu(sceneView(packTraceScene(src)), o2, d2, 0, 2000);
    expect(run.passes).toBeLessThanOrEqual(1 + TRACE_RESUMES);
    expect(resumed.kind).toBe(TRACE_MISS);
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

/** Slab test of an oriented box (centre, half extents, rotation): the entry distance, or null. */
function rayObb(o: V3, d: V3, center: readonly number[], half: readonly number[], q: readonly number[]): number | null {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  const axes: V3[] = [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ];
  const rel: V3 = [o[0] - center[0]!, o[1] - center[1]!, o[2] - center[2]!];
  let t0 = 0;
  let t1 = Infinity;
  for (let k = 0; k < 3; k += 1) {
    const a = axes[k]!;
    const e = a[0] * rel[0] + a[1] * rel[1] + a[2] * rel[2];
    const f = a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
    const lo = (-half[k]! - e) / f;
    const hi = (half[k]! - e) / f;
    t0 = Math.max(t0, Math.min(lo, hi));
    t1 = Math.min(t1, Math.max(lo, hi));
  }
  return t0 <= t1 ? t0 : null;
}

describe('tracer: generated architecture', () => {
  const path = { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]] as [number, number, number][], closed: true as const };
  const room: ArchitectureComponent = {
    chunkSize: 16,
    profiles: { wall: { points: [[0.15, 0], [0.15, 3], [-0.15, 3], [-0.15, 0]], slots: ['lower_wall', 'bevel', 'upper_wall'] } },
    elements: [
      { id: 'a', kind: 'sweep', path, profile: 'wall', openings: [{ id: 'door', at: 4, width: 1.2, bottom: 0, top: 2.2 }] },
      { id: 'a-floor', kind: 'fill', path, shape: 'flat', slot: 'floor' },
    ],
  } as ArchitectureComponent;
  const origins: V3[] = [[2, 0.5, -3], [14, 0.5, 4]];

  it('meets the nearest wall box (with its thickness, the door open) or floor triangle', () => {
    const objects = origins.map((origin) => ({ component: room, origin }));
    const arch = traceArchitectureOf(objects);
    expect(arch.boxes.length).toBeGreaterThan(4);
    expect(arch.triangles.length).toBeGreaterThan(0);
    const src: TraceSceneSource = { arch };
    const r = rng(21);
    let hits = 0;
    for (let i = 0; i < 600; i += 1) {
      const o: V3 = [-2 + r() * 28, 0.6 + r() * 3.5, -6 + r() * 18];
      const d = unit([r() * 2 - 1, r() * 1.6 - 0.9, r() * 2 - 1]);
      let ref = Infinity;
      for (const b of arch.boxes) ref = Math.min(ref, rayObb(o, d, b.center, b.half, b.rotation) ?? Infinity);
      for (let k = 0; k < arch.triangles.length; k += 9) {
        const t = arch.triangles;
        ref = Math.min(ref, rayTriangle(o, d, [t[k]!, t[k + 1]!, t[k + 2]!], [t[k + 3]!, t[k + 4]!, t[k + 5]!], [t[k + 6]!, t[k + 7]!, t[k + 8]!], 0, 100));
      }
      const { hit } = traceToEnd(src, o, d, 100);
      if (ref > 100) {
        expect(hit.kind).toBe(TRACE_MISS);
        continue;
      }
      hits += 1;
      expect(hit.kind).toBe(TRACE_ARCH);
      expect(hit.t).toBeCloseTo(ref, 4);
      expect(Math.hypot(...hit.normal)).toBeCloseTo(1, 5);
    }
    expect(hits).toBeGreaterThan(120);
    // Through the door: no wall; beside it: the wall's outer face, 0.15 m before its middle line.
    const o: V3 = [origins[0]![0] + 4, origins[0]![1] + 1, origins[0]![2] - 3];
    expect(traceToEnd(src, o, [0, 0, 1], 2.9).hit.kind).toBe(TRACE_MISS);
    const beside = traceToEnd(src, [o[0] + 1.5, o[1], o[2]], [0, 0, 1], 10).hit;
    expect(beside.kind).toBe(TRACE_ARCH);
    expect(beside.t).toBeCloseTo(3 - 0.15, 4);
    expect(beside.normal[2]).toBeCloseTo(-1, 5);
  });

  it('a closed starter room holds its lamp in: its ceiling stops light though nothing collides with it, and faces the room', () => {
    const outline = { id: 'r', preset: 'starter-room', path: { points: [[0, 0, 0], [6, 0, 0], [6, 0, 5], [0, 0, 5]] as [number, number, number][], closed: true } };
    const component = expandArchitecture({ elements: [], outlines: [outline] } as ArchitectureComponent, [0, 0, 0], architectureStylesOf([])).component;
    const arch = traceArchitectureOf([{ component, origin: [0, 0, 0] }]);
    const scene = packTraceScene({ arch });
    // From inside, straight up: the ceiling, wound to face down into the room.
    const up = traceToEnd({ arch }, [3, 1.5, 2.5], [0, 1, 0], 20).hit;
    expect(up.kind).toBe(TRACE_ARCH);
    expect(up.normal[1]).toBeCloseTo(-1, 5);
    const lamp: CacheLight = { id: 'lamp', kind: 'point', on: true, position: [3, 2, 2.5], direction: [0, -1, 0], color: [20, 20, 20], range: 14, cone: 0, penumbra: 0, shadows: true };
    const lit = (p: V3, n: V3): number => {
      const copies = 32;
      const points = new Float32Array(copies * 6);
      for (let i = 0; i < copies; i += 1) points.set([...p, ...n], i * 6);
      const e = lightFrameCpu({ points, slices: [{ texels: copies, lights: [0], suns: 0, level: 0 }], lights: [lamp], suns: [] }, scene, 3, SHADOW_TRACE);
      let sum = 0;
      for (let i = 0; i < copies; i += 1) sum += e[i * 3]!;
      return sum / copies;
    };
    expect(lit([3, 0.05, 2.5], [0, 1, 0])).toBeGreaterThan(0.5);
    // Above the ceiling looking down at the lamp, and outside each wall looking in: dark.
    expect(lit([3, 4, 2.5], [0, -1, 0])).toBe(0);
    expect(lit([2, 6, 1.5], [0, -1, 0])).toBe(0);
    expect(lit([-1, 1, 2.5], [1, 0, 0])).toBe(0);
    expect(lit([7, 1, 2.5], [-1, 0, 0])).toBe(0);
    expect(lit([3, 1, -1], [0, 0, 1])).toBe(0);
    expect(lit([3, 1, 6], [0, 0, -1])).toBe(0);
  });
});

/** A closed mesh: a box with a sphere on it (sharp edges and a smooth curve). */
function boxAndSphere(): { positions: V3[]; triangles: V3[] } {
  const positions: V3[] = [];
  const triangles: V3[] = [];
  const quad = (a: V3, b: V3, c: V3, e: V3): void => {
    const i = positions.length;
    positions.push(a, b, c, e);
    triangles.push([i, i + 1, i + 2], [i, i + 2, i + 3]);
  };
  const [x0, y0, z0, x1, y1, z1] = [-1, 0, -0.6, 1, 0.8, 0.6];
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  // A sphere of radius 0.5 floating above the box.
  const base = positions.length;
  const [rings, segs, R, cy] = [16, 24, 0.5, 1.6];
  for (let i = 0; i <= rings; i += 1) {
    for (let j = 0; j < segs; j += 1) {
      const th = (i / rings) * Math.PI;
      const ph = (j / segs) * 2 * Math.PI;
      positions.push([R * Math.sin(th) * Math.cos(ph), cy + R * Math.cos(th), R * Math.sin(th) * Math.sin(ph)]);
    }
  }
  for (let i = 0; i < rings; i += 1) {
    for (let j = 0; j < segs; j += 1) {
      const a = base + i * segs + j;
      const b = base + i * segs + ((j + 1) % segs);
      const c = a + segs;
      const e = b + segs;
      triangles.push([a, b, e], [a, e, c]);
    }
  }
  return { positions, triangles };
}

describe('tracer: imported static models (distance-field bricks)', () => {
  it('meets the model within a voxel of its triangles, placed rotated and scaled; the blob round-trips', () => {
    const mesh = boxAndSphere();
    const t0 = performance.now();
    const set = buildDistanceBrickSet('', [mesh])!;
    const ms = performance.now() - t0;
    const bricks = decodeDistanceBricks(encodeDistanceBricks({ sets: [set] }))!;
    expect(bricks.sets[0]!.samples).toEqual(set.samples);
    expect(Array.from(bricks.sets[0]!.bricks)).toEqual(Array.from(set.bricks));
    // Longest side 2.1 m (the sphere's top): 32 voxels.
    expect(set.voxel).toBeCloseTo(2.1 / 32, 6);
    expect(ms).toBeLessThan(2000);
    const placed = [3, -1, 2];
    const rot = [0, Math.sin(0.35), 0, Math.cos(0.35)];
    const scale = 1.5;
    const toLocal = worldToLocalOf(placed, rot, [scale, scale, scale]);
    const toWorld = invertAffine(toLocal);
    const world = (p: V3): V3 => [0, 1, 2].map((r) => toWorld[r * 4]! * p[0] + toWorld[r * 4 + 1]! * p[1] + toWorld[r * 4 + 2]! * p[2] + toWorld[r * 4 + 3]!) as V3;
    const tris = mesh.triangles.map((t) => t.map((i) => world(mesh.positions[i]!)) as [V3, V3, V3]);
    const src: TraceSceneSource = { bricks: traceModelInstancesOf(bricks, toLocal) };
    const r = rng(33);
    const tolerance = set.voxel * scale;
    let hits = 0;
    let disagree = 0;
    let alike = 0;
    for (let i = 0; i < 500; i += 1) {
      const target: V3 = world([r() * 2.4 - 1.2, r() * 2.4 - 0.2, r() * 1.6 - 0.8]);
      // From outside the model (6 m off; it spans 3.2 m).
      const away = unit([r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]);
      const o: V3 = [placed[0]! + away[0] * 6, placed[1]! + away[1] * 6, placed[2]! + away[2] * 6];
      const d = unit([target[0] - o[0], target[1] - o[1], target[2] - o[2]]);
      let ref = Infinity;
      let refN: V3 = [0, 0, 0];
      for (const [a, b, c] of tris) {
        const t = rayTriangle(o, d, a, b, c, 0, 50);
        if (t < ref) {
          ref = t;
          refN = unit([(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]);
        }
      }
      const { hit } = traceToEnd(src, o, d, 50);
      // Grazing rays may disagree within a voxel of the silhouette.
      if ((ref === Infinity) !== (hit.kind === TRACE_MISS)) {
        disagree += 1;
        continue;
      }
      if (ref === Infinity) continue;
      hits += 1;
      expect(hit.kind).toBe(TRACE_BRICKS);
      expect(Math.abs(hit.t - ref)).toBeLessThan(tolerance);
      // The field's gradient is the surface normal, rounded within a voxel or two of the box's edges.
      if (hit.normal[0] * refN[0] + hit.normal[1] * refN[1] + hit.normal[2] * refN[2] > 0.9) alike += 1;
    }
    expect(hits).toBeGreaterThan(250);
    expect(alike / hits).toBeGreaterThan(0.85);
    expect(disagree).toBeLessThan(15);
  });

  it('shadow rays: any hit blocks wherever the nearest hit does; the cone blocks only rays passing close by', () => {
    const set = buildDistanceBrickSet('', [boxAndSphere()])!;
    const bricks = { sets: [set] };
    // A row of the model, and a ground slab of blocks under it.
    const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-8, -1, -8], max: [8, 0, 8] } });
    for (let z = -8; z < 8; z += 1) for (let x = -8; x < 8; x += 1) grid.set(x, -1, z, { block: 'rock' });
    const src: TraceSceneSource = {
      blocks: [traceBlockLayerOf(grid, [0, 0, 0], opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]))],
      bricks: [-4, 0, 4].flatMap((x) => traceModelInstancesOf(bricks, worldToLocalOf([x, 0, 0], [0, 0, 0, 1], [1, 1, 1]))),
    };
    const s = sceneView(packTraceScene(src));
    const r = rng(5);
    let blocked = 0;
    let extra = 0;
    for (let i = 0; i < 600; i += 1) {
      const o: V3 = [r() * 14 - 7, 0.02, r() * 6 - 3];
      const d = unit([r() * 2 - 1, 0.2 + r(), r() * 2 - 1]);
      const exact = traceRayCpu(s, o, d, 0, 40);
      const any = traceRayCpu(s, o, d, 0, 40, { anyHit: true, cone: 0 });
      const cone = traceRayCpu(s, o, d, 0, 40, { anyHit: true, cone: 0.01 });
      if (exact.kind !== TRACE_MISS) {
        blocked += 1;
        expect(any.kind, `ray ${i}`).not.toBe(TRACE_MISS);
        expect(cone.kind, `ray ${i}`).not.toBe(TRACE_MISS);
      } else if (cone.kind !== TRACE_MISS) {
        extra += 1;
        // Blocked by the cone: the ray passes within cone × distance (plus a voxel) of the model.
        expect(cone.kind).toBe(TRACE_BRICKS);
      }
      expect(any.kind === TRACE_MISS).toBe(exact.kind === TRACE_MISS);
    }
    expect(blocked).toBeGreaterThan(60);
    expect(extra).toBeLessThan(blocked * 0.2);
  });

  it('a model as the engine reads it: one set per top-level piece of its render geometry', () => {
    const mesh = boxAndSphere();
    const prim = (piece: string, extra: Partial<ModelGeometryPrimitive> = {}): ModelGeometryPrimitive => ({ piece, collision: false, higherLod: false, pieceCollision: false, occluder: false, positions: mesh.positions, triangles: mesh.triangles, node: piece, primitive: 0, local: [], ...extra });
    const one = buildDistanceBricks({ primitives: [prim('crate'), prim('crate', { collision: true }), prim('crate', { higherLod: true })], skipped: [] });
    expect(one.sets.map((s) => s.piece)).toEqual(['']);
    const kit = buildDistanceBricks({ primitives: [prim('wall'), prim('arch')], skipped: [] });
    expect(kit.sets.map((s) => s.piece)).toEqual(['arch', 'wall']);
  });
});
