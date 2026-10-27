/**
 * The live probes (surface-probes.ts) and their update (the probe pass's CPU
 * twin, surface-probe-cpu.ts, the shaders line for line):
 *
 * - multi-bounce: in a closed room whose every surface gets the same direct
 *   light E₀, bounced light builds up over updates to the radiosity
 *   solution of an enclosure, ρ E₀ / (1 − ρ), at the probes;
 * - the sky: a probe in the open sees it whole (a uniform sky of radiance L
 *   gives π L);
 * - rooms: a probe in a room with its door shut gets nothing from a lit
 *   yard outside (the doorway's door piece is not traced), and the yard's
 *   light once the door opens; a probe outside does not see a lit room
 *   through its shut door;
 * - stale and settled: marks make probes stale, updates that no longer
 *   move a probe settle it, and its tiles' walls come from its axis rays;
 *   restarted (as a bake starts them), probes keep none of the light they
 *   blended in before, where marked ones keep some;
 * - a closed generated room in a sunlit yard, a block slab reaching into
 *   it through its wall: a real surface cache host lights its texels (the
 *   light pass's twin), the probes read them where their rays hit, and the
 *   room's probes stay dark whatever the rays' turns; its probes inside the
 *   slab are dropped (their rays would start in the solid and read the
 *   yard's probes beyond the wall).
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, architectureStylesOf, buildRoomGraph, expandArchitecture, type ArchitectureComponent, type BlockType } from '@thirdlight/runtime';

import { probeUpdateCpu } from './surface-probe-cpu';
import type { CacheLight } from './surface-changes';
import { SurfaceCacheHost } from './surface-cache-host';
import { lightFrameCpu } from './surface-light-cpu';
import { lightFrameOf } from './surface-light-frame';
import { SHADOW_TRACE } from './surface-light-pass';
import { texelWords } from './surface-resolve';
import { patchTexelAddresses, tileTexelAddresses } from './surface-texels';
import { ProbeMarks, type ProbeSolid } from './probe-bricks';
import { probeSolid } from './probe-geometry';
import { BOUNCE_ALBEDO, LiveProbes, PROBE_FLOATS, PROBE_MIN_COUNT, selectSmallest, shIrradiance, type ProbePlacement } from './surface-probes';
import { SurfaceRooms } from './surface-rooms';
import { packTraceScene } from './tracer-scene';
import { opaqueByBlockTypes, traceBlockLayerOf } from './tracer-sources';
import type { TraceHit } from './tracer-cpu-math';

type V3 = [number, number, number];
const ROCK = opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]);

/** A closed block room (inside x, z 1..7, y 1..4) on a ground slab, a 2 m doorway gap in its +z wall (where a door piece stands, which the tracer does not stop). */
function room(doorOpen: boolean, gap = true): { scene: ReturnType<typeof packTraceScene>; rooms: SurfaceRooms; solid: ProbeSolid } {
  const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-10, 0, -10], max: [20, 6, 20] } });
  for (let z = -10; z < 20; z += 1) for (let x = -10; x < 20; x += 1) grid.set(x, 0, z, { block: 'rock' });
  for (let y = 1; y <= 4; y += 1) {
    for (let k = 0; k <= 7; k += 1) {
      for (const [x, z] of [[k, 0], [k, 7], [0, k], [7, k]] as const) {
        if (!(gap && z === 7 && (x === 3 || x === 4) && y <= 2)) grid.set(x, y, z, { block: 'rock' });
      }
    }
  }
  for (let z = 0; z <= 7; z += 1) for (let x = 0; x <= 7; x += 1) grid.set(x, 4, z, { block: 'rock' });
  const graph = buildRoomGraph([{ id: 'house', origin: [0, 0, 0], rooms: [{ id: 'r', outline: 'r', storey: 0, points: [[1, 1], [7, 1], [7, 7], [1, 7]], floor: 1, top: 4, covered: true, holes: [], openings: [{ id: 'door', from: [3, 7], to: [5, 7], bottom: 1, top: 3 }] }] }]);
  return { scene: packTraceScene({ blocks: [traceBlockLayerOf(grid, [0, 0, 0], ROCK)] }), rooms: new SurfaceRooms({ graph, open: () => doorOpen, version: 0 }), solid: probeSolid({ layers: [{ grid, origin: [0, 0, 0], opaque: ROCK }] }, 6) };
}

/** Probes outside rooms over a box: bricks of the finest level (nothing is solid unless `solid` says so). */
function over(min: V3, max: V3, solid: ProbeSolid = { solid: () => false }): ProbePlacement {
  return {
    key: JSON.stringify([min, max]),
    geometry: () => {
      const marks = new ProbeMarks(2);
      marks.mark(min, max, 0);
      return { marks, solid };
    },
  };
}

/** Update every probe `n` times; returns the mean irradiance (red, facing up) of the probes. */
function run(probes: LiveProbes, n: number, scene: ReturnType<typeof packTraceScene>, rooms: Uint32Array | null, direct: (p: V3, nrm: V3) => V3, sky = new Float32Array(12), albedo?: () => V3 | null, channel = 0): number {
  const all = Uint32Array.from({ length: probes.count }, (_, i) => i);
  for (let u = 0; u < n; u += 1) {
    const values = probeUpdateCpu({ probes, slots: all, sky, rooms, seed: 11 + u, scene, direct, ...(albedo !== undefined ? { albedo } : {}) });
    probes.accept(all, values, true, u);
  }
  const e = [0, 0, 0];
  let s = 0;
  for (let i = 0; i < probes.count; i += 1) s += shIrradiance(probes.state, i * PROBE_FLOATS, [0, 1, 0], e)[channel]!;
  return s / probes.count;
}

describe('surface cache: live probes', () => {
  it('multi-bounce: a closed room lit evenly converges to the enclosure solution ρ E₀ / (1 − ρ)', () => {
    const { scene, rooms } = room(false, false);
    const probes = new LiveProbes(2, 0.5);
    probes.place(null, rooms);
    expect(probes.grids.length).toBeGreaterThan(0);
    const E0 = 3;
    const reference = (BOUNCE_ALBEDO * E0) / (1 - BOUNCE_ALBEDO);
    const one = run(probes, 1, scene, rooms.words, () => [E0, E0, E0]);
    // One update: one bounce, ρ E₀.
    expect(one).toBeCloseTo(BOUNCE_ALBEDO * E0, 1);
    const many = run(probes, 60, scene, rooms.words, () => [E0, E0, E0]);
    expect(Math.abs(many - reference) / reference).toBeLessThan(0.03);
  });

  it('bounce takes the colour the materials put in the cache: a red room bounces red, a texel no material drew bounces the default', () => {
    const { scene, rooms } = room(false, false);
    const probes = new LiveProbes(2, 0.5);
    probes.place(null, rooms);
    const red = (): V3 => [0.6, 0.1, 0.1];
    const r = run(probes, 60, scene, rooms.words, () => [3, 3, 3], new Float32Array(12), red, 0);
    expect(Math.abs(r - (0.6 * 3) / (1 - 0.6)) / ((0.6 * 3) / 0.4)).toBeLessThan(0.04);
    const fresh = new LiveProbes(2, 0.5);
    fresh.place(null, rooms);
    expect(run(fresh, 60, scene, rooms.words, () => [3, 3, 3], new Float32Array(12), red, 1)).toBeCloseTo((0.1 * 3) / 0.9, 1);
    const none = new LiveProbes(2, 0.5);
    none.place(null, rooms);
    expect(run(none, 1, scene, rooms.words, () => [3, 3, 3], new Float32Array(12), () => null)).toBeCloseTo(BOUNCE_ALBEDO * 3, 1);
  });

  it('the sky: a probe in the open sees it whole', () => {
    const probes = new LiveProbes(2, 0.5);
    probes.place(over([0, 0, 0], [4, 2, 4]), null);
    // A uniform sky of radiance 1: band 0 holds 1 × √(4π) … as SH, c₀ = L · Y₀ · 4π.
    const sky = new Float32Array(12);
    sky.fill(0.282095 * 4 * Math.PI, 0, 3);
    const e = run(probes, 1, packTraceScene({}), null, () => [0, 0, 0], sky);
    expect(e).toBeCloseTo(Math.PI, 1);
  });

  it('rooms: a probe behind a shut door gets nothing from the lit yard, and its light once the door opens; one outside sees nothing of a lit room through its shut door', () => {
    const yard = (p: V3): V3 => (p[2] > 7.5 && p[1] < 1.5 ? [5, 5, 5] : [0, 0, 0]);
    // The room's floor alone is lit.
    const inside = (p: V3): V3 => (p[1] < 1.5 && p[0] > 1 && p[0] < 7 && p[2] > 1 && p[2] < 7 ? [5, 5, 5] : [0, 0, 0]);
    for (const doorOpen of [false, true]) {
      const { scene, rooms } = room(doorOpen);
      const probes = new LiveProbes(2, 0.5);
      probes.place(null, rooms);
      const e = run(probes, 4, scene, rooms.words, yard);
      if (doorOpen) expect(e).toBeGreaterThan(1e-3);
      else expect(e).toBe(0);
      // Without rooms the shut door leaks: the doorway is open to the tracer.
      if (!doorOpen) {
        const leak = new LiveProbes(2, 0.5);
        leak.place(null, rooms);
        expect(run(leak, 4, scene, null, yard)).toBeGreaterThan(1e-3);
      }
    }
    // Probes in the yard by the shut door, at the doorway's height, facing it: they see the lit floor through it only without rooms.
    const { scene, rooms, solid } = room(false);
    const byDoor = (rs: Uint32Array | null): number => {
      const outside = new LiveProbes(2, 0.5);
      outside.place(over([2, 1, 8], [6, 3, 12], solid), rooms);
      run(outside, 3, scene, rs, inside);
      const e = [0, 0, 0];
      let lit = 0;
      for (let i = 0; i < outside.count; i += 1) {
        const p = [outside.positions[i * 3]!, outside.positions[i * 3 + 1]!, outside.positions[i * 3 + 2]!];
        if (outside.rooms[i] !== 0xffffffff || p[2]! < 7.5 || p[2]! > 10 || p[1]! > 3 || p[0]! < 2 || p[0]! > 6) continue;
        lit += shIrradiance(outside.state, i * PROBE_FLOATS, [0, 0, -1], e)[0]!;
      }
      return lit;
    };
    expect(byDoor(null)).toBeGreaterThan(1e-3);
    expect(byDoor(rooms.words)).toBe(0);
  });

  it('the nearest stale probes are picked by selection, as a sort would pick them', () => {
    let seed = 5;
    const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (const [n, k] of [[1000, 64], [50, 64], [7, 3], [300, 300], [2000, 1]] as const) {
      const keys = Float32Array.from({ length: n }, () => Math.floor(rnd() * 100));
      const order = Uint32Array.from({ length: n }, (_, i) => i);
      const want = [...keys].sort((a, b) => a - b).slice(0, Math.min(k, n));
      selectSmallest(keys, order, n, Math.min(k, n));
      expect([...keys.slice(0, Math.min(k, n))].sort((a, b) => a - b)).toEqual(want);
      for (let i = 0; i < n; i += 1) expect(keys[i]).toBe(Math.floor(keys[i]!));
    }
  });

  it('in an open scene the nearest stale probes are picked from one ordering for a few updates, and ordered again when the eye moves', () => {
    const probes = new LiveProbes(2, 0.5);
    probes.place(over([0, 0, 0], [160, 8, 160]), null);
    expect(probes.count).toBeGreaterThan(20000);
    const P = probes.positions;
    const nearest = (eye: V3, k: number): number[] => Array.from({ length: probes.count }, (_, i) => i)
      .map((i) => [i, (P[i * 3]! - eye[0]) ** 2 + (P[i * 3 + 1]! - eye[1]) ** 2 + (P[i * 3 + 2]! - eye[2]) ** 2] as const)
      .sort((a, b) => a[1] - b[1]).slice(0, k).map(([i]) => (P[i * 3]! - eye[0]) ** 2 + (P[i * 3 + 1]! - eye[1]) ** 2 + (P[i * 3 + 2]! - eye[2]) ** 2);
    const dist = (eye: V3, picked: Uint32Array): number[] => [...picked].map((i) => (P[i * 3]! - eye[0]) ** 2 + (P[i * 3 + 1]! - eye[1]) ** 2 + (P[i * 3 + 2]! - eye[2]) ** 2).sort((a, b) => a - b);
    const eye: V3 = [40.3, 2.1, 51.7];
    for (let u = 0; u < 5; u += 1) {
      const picked = probes.plan(eye, u);
      expect(dist(eye, picked)).toEqual(nearest(eye, picked.length));
    }
    // A step past a probe spacing orders them again round the new eye.
    const moved: V3 = [120.4, 2.1, 30.2];
    const picked = probes.plan(moved, 6);
    expect(dist(moved, picked)).toEqual(nearest(moved, picked.length));
  });

  it('an update takes as many probes as the budget holds, and never fewer than the tracer latency makes worth it', () => {
    const settle = (cost: (n: number) => number, budget: number): number => {
      const probes = new LiveProbes(2, budget);
      for (let k = 0; k < 20; k += 1) {
        const n = probes.diagnostics().perUpdate;
        probes.report(cost(n), n);
      }
      return probes.diagnostics().perUpdate;
    };
    // Work-bound: 1 µs a probe within 1 ms.
    expect(settle((n) => n * 0.001, 1)).toBe(960);
    // Latency-bound (the village's brick rays): 3 ms whatever the count.
    expect(settle((n) => 3 + n * 0.0004, 0.5)).toBe(PROBE_MIN_COUNT);
  });

  it('placed again, a probe at a place it held keeps its light, its stale state and its changes not yet taken (under its new index)', () => {
    const probes = new LiveProbes(2, 0.5);
    probes.place(over([0, 0, 0], [4, 2, 4]), null);
    const slots = Uint32Array.from([0, 5, 9]);
    const values = new Float32Array(slots.length * PROBE_FLOATS);
    slots.forEach((_, k) => values.fill(k + 1, k * PROBE_FLOATS, k * PROBE_FLOATS + 12));
    probes.accept(slots, values, true, 0);
    const at = (i: number): number[] => [...probes.positions.subarray(i * 3, i * 3 + 3)];
    const where = [...slots].map(at);
    // More bricks: the first ones' probes keep their places but not their indices.
    probes.place(over([-12, 0, -12], [4, 2, 4]), null);
    const now = where.map((p) => Array.from({ length: probes.count }, (_, i) => i).find((i) => at(i).every((v, a) => v === p[a]))!);
    expect(new Set(probes.takeChangedProbes())).toEqual(new Set(now));
    now.forEach((i, k) => expect(probes.state[i * PROBE_FLOATS]).toBe(k + 1));
  });

  it('stale and settled: marks make probes stale, updates that no longer move them settle them', () => {
    const { scene, rooms } = room(false, false);
    const probes = new LiveProbes(2, 0.5);
    probes.place(null, rooms);
    expect(probes.isSettled).toBe(false);
    const all = Uint32Array.from({ length: probes.count }, (_, i) => i);
    let u = 0;
    for (; u < 60 && !probes.isSettled; u += 1) probes.accept(all, probeUpdateCpu({ probes, slots: all, sky: new Float32Array(12), rooms: rooms.words, seed: u, scene, direct: () => [1, 1, 1] }), true, u);
    expect(probes.isSettled).toBe(true);
    expect(probes.plan([4, 2, 4], 0).length).toBe(0);
    probes.markBox([0, 0, 0], [8, 8, 8]);
    expect(probes.isSettled).toBe(false);
    expect(probes.plan([4, 2, 4], 0).length).toBe(probes.count);
    // Placing again over the same bounds keeps the probes.
    expect(probes.place(null, rooms)).toBe(false);
  });

  it('restarted, a probe forgets the light it blended in: marked, a room that went dark keeps a tenth of its old light; restarted, none', () => {
    const { scene, rooms } = room(false, false);
    const lit = (restart: boolean): number => {
      const probes = new LiveProbes(2, 0.5);
      probes.place(null, rooms);
      const all = Uint32Array.from({ length: probes.count }, (_, i) => i);
      const before = run(probes, 20, scene, rooms.words, () => [3, 3, 3]);
      const layout = probes.layout;
      if (restart) probes.restart();
      else probes.markBox(null, null);
      // Restarted, the records go to the GPU again (as when the probes are placed again).
      expect(probes.layout).toBe(restart ? layout + 1 : layout);
      for (let u = 0; u < 60 && !probes.isSettled; u += 1) {
        const slots = probes.plan([4, 2, 4], u);
        if (slots.length > 0) probes.accept(slots, probeUpdateCpu({ probes, slots, sky: new Float32Array(12), rooms: rooms.words, seed: 100 + u, scene, direct: () => [0, 0, 0] }), true, u);
      }
      expect(probes.isSettled).toBe(true);
      const e = [0, 0, 0];
      let s = 0;
      for (let i = 0; i < probes.count; i += 1) s += shIrradiance(probes.state, i * PROBE_FLOATS, [0, 1, 0], e)[0]!;
      return s / probes.count / before;
    };
    expect(lit(false)).toBeGreaterThan(0.05);
    expect(lit(true)).toBe(0);
  });
});

/**
 * A sunlit yard of 1 m blocks (ground top at y = 0) with a slab one cell thick at 1…2 m over x −8…0, z −7…1, and a
 * starter room (walls on x ±2, z −9.6 and −6.4, 3 m high, a ceiling, no opening): the slab passes through the room's
 * south wall into its south-west corner. Its texels lit by the sun through the CPU twin of the light pass, at `level`.
 */
function sunlitYardAndRoom(level: number): { host: SurfaceCacheHost; texels: Map<string, V3> } {
  const outline = { id: 'closed', preset: 'starter-room', path: { points: [[-2, 0, -9.6], [2, 0, -9.6], [2, 0, -6.4], [-2, 0, -6.4]] as V3[], closed: true } };
  const arch = expandArchitecture({ elements: [], outlines: [outline] } as ArchitectureComponent, [0, 0, 0], architectureStylesOf([]));
  const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [20, 6, 16] } });
  for (const [x0, y0, z0, x1, y1, z1] of [[0, 0, 0, 20, 1, 16], [2, 2, 3, 10, 3, 11]] as const) {
    for (let x = x0; x < x1; x += 1) for (let y = y0; y < y1; y += 1) for (let z = z0; z < z1; z += 1) grid.set(x, y, z, { block: 'rock' });
  }
  const graph = buildRoomGraph([{ id: 'arch', origin: [0, 0, 0], rooms: arch.rooms }]);
  const host = new SurfaceCacheHost(
    { layers: () => [{ id: 'yard', origin: [-10, -1, -10], grid, version: 1, chunks: [['0,0', 1], ['1,0', 1]], opaque: ROCK }], terrains: () => [], architecture: () => [{ id: 'arch', component: arch.component, origin: [0, 0, 0] }], models: () => [], bricks: () => null, rooms: () => ({ graph, open: () => false, version: 0 }) },
    64 * 1024 * 1024,
    1000,
  );
  const toSun: V3 = [-0.3, 1, -0.6];
  const l = Math.hypot(...toSun);
  const sun: CacheLight = { id: 'sun', kind: 'directional', on: true, position: [0, 0, 0], direction: toSun.map((v) => v / l) as V3, color: [2, 2, 2], range: 0, cone: 0, penumbra: 0, shadows: true };
  host.setLights([sun]);
  host.setLive(true);
  const eye = [0, 2, 0];
  let now = 0;
  for (let i = 0; i < 400 && !(host.preparedTiles() !== null && host.diagnostics().tiles.offered > 0 && host.diagnostics().tiles.resident === host.diagnostics().tiles.offered); i += 1) host.update(eye, (now += 100));
  host.cache.setBakeLevel(level);
  const texels = new Map<string, V3>();
  for (let f = 0; f < 3000; f += 1) {
    host.update(eye, (now += 16));
    const slices = host.slicesThisFrame();
    if (slices.length === 0) {
      if (host.relight.isSettled && f > 20) break;
      continue;
    }
    const frame = lightFrameOf(host, [sun], null, host.rooms());
    const e = lightFrameCpu(frame, packTraceScene(host.traceSource().source), f, SHADOW_TRACE);
    const n = frame.slices.reduce((k, s) => k + s.texels, 0);
    const addresses = new Uint32Array(n * 2);
    let at = 0;
    for (const s of slices) {
      const src = host.texelsOf(s.unit.key);
      if (src !== null) ('patch' in src ? patchTexelAddresses : tileTexelAddresses)(src as never, s.from, s.to, addresses, at * 2);
      at += s.to - s.from;
    }
    for (let i = 0; i < n; i += 1) texels.set(`${addresses[i * 2]},${addresses[i * 2 + 1]}`, [e[i * 3]!, e[i * 3 + 1]!, e[i * 3 + 2]!]);
  }
  expect(host.relight.isSettled).toBe(true);
  return { host, texels };
}

describe('surface cache: no outside light in a closed generated room', () => {
  it("a slab through its wall: the room's probes stay dark at every cache level and rays' turns, its probes in the slab dropped", () => {
    const sky = new Float32Array(12);
    sky.fill(0.282095 * 4 * Math.PI, 0, 3);
    for (const level of [0, 1]) {
      for (const seed of [0, 1000, 77777]) {
        const { host, texels } = sunlitYardAndRoom(level);
        const probes = host.probes;
        const rooms = host.rooms()!.words;
        const scene = packTraceScene(host.traceSource().source);
        const resolve = host.resolveScene().scene;
        // A hit's direct light is its texel's, as the probe pass resolves it.
        const direct = (_p: V3, _n: V3, hit: TraceHit): V3 => {
          const w = texelWords(resolve.resolve(host.cache, hit), []);
          return texels.get(`${w[0]},${w[1]}`) ?? [0, 0, 0];
        };
        let sawSun = 0;
        for (let u = 0; u < 400 && !probes.isSettled; u += 1) {
          const slots = probes.plan([0, 2, 0], u);
          if (slots.length === 0) continue;
          probes.accept(slots, probeUpdateCpu({ probes, slots, sky, rooms, seed: seed + u, scene, direct: (p, n, hit) => {
            const v = direct(p, n, hit);
            sawSun = Math.max(sawSun, v[0]);
            return v;
          } }), true, u);
        }
        expect(probes.isSettled).toBe(true);
        expect(sawSun).toBeGreaterThan(0.5);
        const roomEnd = probes.grids[probes.roomGrids]!.at;
        let room = 0;
        let yard = 0;
        let dropped = 0;
        for (let i = 0; i < probes.count; i += 1) {
          const dc = probes.state[i * PROBE_FLOATS]!;
          if (i < roomEnd) {
            room = Math.max(room, dc);
            const [x, y, z] = [probes.positions[i * 3]!, probes.positions[i * 3 + 1]!, probes.positions[i * 3 + 2]!];
            if (x < 0 && z > -7 && y > 1 && y < 2) dropped += probes.state[i * PROBE_FLOATS + 13] === 0 ? 1 : 0;
          } else yard = Math.max(yard, dc);
        }
        expect(yard).toBeGreaterThan(1);
        expect(dropped).toBeGreaterThan(0);
        // Without the slab's probes dropped the room held 7 % of the yard's light (the saved-probe check's bound is 5 %).
        expect(room).toBeLessThan(yard * 0.002);
      }
    }
  }, 120_000);
});

