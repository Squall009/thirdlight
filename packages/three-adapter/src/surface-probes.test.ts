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
 *   move a probe settle it, and its tiles' walls come from its axis rays.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, buildRoomGraph, type BlockType } from '@thirdlight/runtime';

import { probeUpdateCpu } from './surface-probe-cpu';
import { BOUNCE_ALBEDO, LiveProbes, PROBE_FLOATS, selectSmallest, shIrradiance } from './surface-probes';
import { SurfaceRooms } from './surface-rooms';
import { packTraceScene } from './tracer-scene';
import { opaqueByBlockTypes, traceBlockLayerOf } from './tracer-sources';

type V3 = [number, number, number];
const ROCK = opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]);

/** A closed block room (inside x, z 1..7, y 1..4) on a ground slab, a 2 m doorway gap in its +z wall (where a door piece stands, which the tracer does not stop). */
function room(doorOpen: boolean, gap = true): { scene: ReturnType<typeof packTraceScene>; rooms: SurfaceRooms } {
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
  return { scene: packTraceScene({ blocks: [traceBlockLayerOf(grid, [0, 0, 0], ROCK)] }), rooms: new SurfaceRooms({ graph, open: () => doorOpen, version: 0 }) };
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
    probes.place({ min: [0, 0, 0], max: [4, 2, 4] }, null);
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
    const { scene, rooms } = room(false);
    const byDoor = (rs: Uint32Array | null): number => {
      const outside = new LiveProbes(2, 0.5);
      outside.place({ min: [2, 1, 8], max: [6, 3, 12] }, rooms);
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
});
