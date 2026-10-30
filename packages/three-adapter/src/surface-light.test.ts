/**
 * The surface cache's direct light per light kind, as the pass computes it
 * (its CPU twin, `surface-light-cpu.ts`, the shaders line for line), held to
 * references worked out independently: the sun's and a point light's
 * closed forms, a spot's cone, and dense quadrature over a rectangle's and
 * a line's shape; traced soft shadows, two-sided lights, shadows off and
 * light layers.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, type BlockType } from '@thirdlight/project-model';

import type { CacheLight } from './surface-changes';
import { lightFrameCpu } from './surface-light-cpu';
import { AREA_RAYS, lightFrameOf, packLightFrame, sliceRays, splitLightFrame, type LightPassFrame } from './surface-light-frame';
import { SHADOW_TRACE } from './surface-light-pass';
import type { SurfaceCacheHost } from './surface-cache-host';
import { TRACE_ARCH, TRACE_UNFINISHED, packTraceScene, type PackedTraceScene } from './tracer-scene';
import type { TraceBox } from './tracer-objects';
import { sceneView, traceRayCpu } from './tracer-cpu';
import { opaqueByBlockTypes, traceBlockLayerOf } from './tracer-sources';

type V3 = [number, number, number];

const EMPTY = packTraceScene({});
/** Copies of one texel (a different random sequence each): their mean is the estimator's expectation. */
const COPIES = 400;

function light(over: Partial<CacheLight> & Pick<CacheLight, 'kind'>): CacheLight {
  return { id: 'l', on: true, position: [0, 3, 0], direction: [0, -1, 0], color: [10, 10, 10], range: 0, cone: 0, penumbra: 0, ...over };
}

/** The mean irradiance (red) a texel at `p` facing `n` gets over `COPIES` texels. */
function meanAt(p: V3, n: V3, l: CacheLight, scene: PackedTraceScene = EMPTY): number {
  const points = new Float32Array(COPIES * 6);
  for (let i = 0; i < COPIES; i += 1) points.set([...p, ...n], i * 6);
  const sun = l.kind === 'directional';
  const frame: LightPassFrame = { points, slices: [{ texels: COPIES, lights: sun ? [] : [0], suns: sun ? 1 : 0, level: 0 }], lights: sun ? [] : [l], suns: sun ? [l] : [] };
  const e = lightFrameCpu(frame, scene, 7, SHADOW_TRACE);
  let s = 0;
  for (let i = 0; i < COPIES; i += 1) s += e[i * 3]!;
  return s / COPIES;
}

const window = (d2: number, reach: number): number => Math.min(1, Math.max(0, 1 - (d2 / (reach * reach)) ** 2)) ** 2;

/** Irradiance at p (normal n) from a Lambertian rectangle (centre c, half sides u, v, facing f, whole intensity I), by quadrature. */
function rectReference(p: V3, n: V3, c: V3, u: V3, v: V3, f: V3, I: number, reach: number, twoSided: boolean, line = false): number {
  const N = 300;
  let sum = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < (line ? 1 : N); j += 1) {
      const a = ((i + 0.5) / N) * 2 - 1;
      const b = line ? 0 : ((j + 0.5) / N) * 2 - 1;
      const q = [0, 1, 2].map((k) => c[k]! + u[k]! * a + v[k]! * b);
      const lv = q.map((x, k) => x - p[k]!);
      const d2 = lv.reduce((s, x) => s + x * x, 0);
      const l = lv.map((x) => x / Math.sqrt(d2));
      const cr = Math.max(0, l[0]! * n[0] + l[1]! * n[1] + l[2]! * n[2]);
      const ce = -(l[0]! * f[0] + l[1]! * f[1] + l[2]! * f[2]);
      const emit = line ? (twoSided || ce > 0 ? 1 : 0) : twoSided ? Math.abs(ce) : Math.max(0, ce);
      sum += (I * cr * emit * window(d2, reach)) / d2;
    }
  }
  return sum / (line ? N : N * N);
}

describe('surface cache: direct light per light kind', () => {
  it('the sun: its colour times the cosine, unshadowed; shadows off lights through a wall', () => {
    const sd = [0.3, 0.8, 0.52];
    const l = Math.hypot(...sd);
    const sun = light({ kind: 'directional', direction: sd.map((v) => v / l), color: [2, 2, 2] });
    expect(meanAt([0, 0, 0], [0, 1, 0], sun)).toBeCloseTo((2 * 0.8) / l, 4);
    expect(meanAt([0, 0, 0], [0, -1, 0], sun)).toBe(0);
    // A slab overhead: in its shadow, unless the sun casts none.
    const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-20, 0, -20], max: [20, 4, 20] } });
    for (let z = -20; z < 20; z += 1) for (let x = -20; x < 20; x += 1) grid.set(x, 3, z, { block: 'rock' });
    const roof = packTraceScene({ blocks: [traceBlockLayerOf(grid, [0, 0, 0], opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]))] });
    expect(meanAt([0.5, 0, 0.5], [0, 1, 0], sun, roof)).toBe(0);
    expect(meanAt([0.5, 0, 0.5], [0, 1, 0], { ...sun, shadows: false }, roof)).toBeCloseTo((2 * 0.8) / l, 4);
    // The sun's share (what materials take back out, drawing the sun per pixel): the cosine where it reaches, 0 in shadow.
    const share = (scene: PackedTraceScene): number => {
      const frame: LightPassFrame = { points: Float32Array.from([0.5, 0, 0.5, 0, 1, 0]), slices: [{ texels: 1, lights: [], suns: 1, level: 0 }], lights: [], suns: [sun] };
      const out = new Float32Array(1);
      const e = lightFrameCpu(frame, scene, 7, SHADOW_TRACE, out);
      expect(e[0]).toBeCloseTo(2 * out[0]!, 5);
      return out[0]!;
    };
    expect(share(EMPTY)).toBeCloseTo(0.8 / l, 5);
    expect(share(roof)).toBe(0);
  });

  it('a point light: intensity × cosine over the distance squared, windowed to its range; a spot within its cone', () => {
    const p = light({ kind: 'point', position: [1, 2, 0.5], color: [30, 30, 30], range: 8 });
    const d2 = 1 + 4 + 0.25;
    expect(meanAt([0, 0, 0], [0, 1, 0], p)).toBeCloseTo(((30 * 2) / Math.sqrt(d2) / d2) * window(d2, 8), 4);
    // A 30° spot pointing down: full on its axis, nothing outside its cone.
    const cone = Math.cos((30 * Math.PI) / 180);
    const spot = light({ kind: 'spot', position: [0, 3, 0], direction: [0, -1, 0], color: [80, 80, 80], range: 12, cone, penumbra: 0.2 });
    expect(meanAt([0, 0, 0], [0, 1, 0], spot)).toBeCloseTo((80 / 9) * window(9, 12), 4);
    expect(meanAt([3, 0, 0], [0, 1, 0], spot)).toBe(0);
  });

  it('a rectangle light: the quadrature over its shape, one- and two-sided', () => {
    const u: V3 = [0.6, 0, 0];
    const v: V3 = [0, 0, 0.3];
    const rect = light({ kind: 'area', position: [0, 2.5, 0], direction: [0, -1, 0], color: [40, 40, 40], range: 10, area: { u, v, twoSided: false } });
    for (const p of [[0, 0, 0], [1.5, 0, 0.4], [0.3, 2.2, 0]] as V3[]) {
      const want = rectReference(p, [0, 1, 0], [0, 2.5, 0], u, v, [0, -1, 0], 40, 10, false);
      expect(Math.abs(meanAt(p, [0, 1, 0], rect) - want) / want, `at ${p.join(',')}`).toBeLessThan(0.04);
    }
    // Above the panel, facing it: nothing from a one-sided light, its mirror image from a two-sided one.
    const above: V3 = [0.1, 4, 0];
    expect(meanAt(above, [0, -1, 0], rect)).toBe(0);
    const two = { ...rect, area: { u, v, twoSided: true } };
    const want = rectReference(above, [0, -1, 0], [0, 2.5, 0], u, v, [0, -1, 0], 40, 10, true);
    expect(Math.abs(meanAt(above, [0, -1, 0], two) - want) / want).toBeLessThan(0.04);
    // The rays a texel casts at level 0.
    expect(AREA_RAYS).toBe(16);
  });

  it('the high tier\'s rays: a frame with a ray scale of 2 casts twice the rays a texel for the sun and every light, to the same light', () => {
    const u: V3 = [0.6, 0, 0];
    const v: V3 = [0, 0, 0.3];
    const rect = light({ kind: 'area', position: [0, 2.5, 0], direction: [0, -1, 0], color: [40, 40, 40], range: 10, area: { u, v, twoSided: false } });
    const sun = light({ kind: 'directional', direction: [0.3, -1, 0.2], color: [2, 2, 2] });
    const points = new Float32Array(COPIES * 6);
    for (let i = 0; i < COPIES; i += 1) points.set([0.4, 0, 0.1, 0, 1, 0], i * 6);
    const frame: LightPassFrame = { points, slices: [{ texels: COPIES, lights: [0], suns: 1, level: 0 }], lights: [rect], suns: [sun] };
    const doubled: LightPassFrame = { ...frame, rayScale: 2 };
    expect(sliceRays(frame, frame.slices[0]!)).toBe(8 + 16);
    expect(sliceRays(doubled, doubled.slices[0]!)).toBe(16 + 32);
    expect(packLightFrame(doubled).rays).toBe(2 * packLightFrame(frame).rays);
    // A coarser level still halves them.
    expect(sliceRays(doubled, { ...doubled.slices[0]!, level: 1 })).toBe(8 + 16);
    const sum = (e: Float32Array): number => {
      let t = 0;
      for (let i = 0; i < COPIES; i += 1) t += e[i * 3]!;
      return t / COPIES;
    };
    const base = sum(lightFrameCpu(frame, EMPTY, 7, SHADOW_TRACE));
    expect(Math.abs(sum(lightFrameCpu(doubled, EMPTY, 7, SHADOW_TRACE)) - base) / base).toBeLessThan(0.03);
  });

  it('a line light: the quadrature along it, its one side', () => {
    const u: V3 = [0, 0, 1.5];
    const line = light({ kind: 'area', position: [0.2, 1.6, 0], direction: [1, 0, 0], color: [12, 12, 12], range: 5, area: { u, v: [0, 0, 0], twoSided: false } });
    for (const [p, n] of [[[1.2, 0, 0], [0, 1, 0]], [[2, 1.6, 0.5], [-1, 0, 0]]] as [V3, V3][]) {
      const want = rectReference(p, n, [0.2, 1.6, 0], u, [0, 0, 0], [1, 0, 0], 12, 5, false, true);
      expect(Math.abs(meanAt(p, n, line) - want) / want, `at ${p.join(',')}`).toBeLessThan(0.04);
    }
    // Behind it (−x): dark one-sided.
    expect(meanAt([-2, 1.6, 0], [1, 0, 0], line)).toBe(0);
  });

  it('soft shadows: a blocker under a rectangle light leaves an umbra, a penumbra and full light', () => {
    // A 2 × 2 m panel at 3 m over a 1 m block on the floor's middle at 1.5 m.
    const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-8, 0, -8], max: [8, 4, 8] } });
    grid.set(0, 1, 0, { block: 'rock' });
    const scene = packTraceScene({ blocks: [traceBlockLayerOf(grid, [0, 0, 0], opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]))] });
    const rect = light({ kind: 'area', position: [0.5, 3, 0.5], direction: [0, -1, 0], color: [40, 40, 40], range: 12, area: { u: [1, 0, 0], v: [0, 0, 1], twoSided: false } });
    const at = (x: number): number => meanAt([x, 0, 0.5], [0, 1, 0], rect, scene) / meanAt([x, 0, 0.5], [0, 1, 0], rect);
    const under = at(0.5);
    const edge = at(1.6);
    const out = at(4);
    expect(under).toBeLessThan(0.25);
    expect(edge).toBeGreaterThan(under + 0.2);
    expect(edge).toBeLessThan(0.97);
    expect(out).toBeGreaterThan(0.99);
    // The same light without shadows lights through the block.
    expect(meanAt([0.5, 0, 0.5], [0, 1, 0], { ...rect, shadows: false }, scene) / meanAt([0.5, 0, 0.5], [0, 1, 0], rect)).toBeCloseTo(1, 5);
  });

  it('shadow caster masks: an object outside the caster mask of a light casts none of its shadow', () => {
    const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-8, 0, -8], max: [8, 4, 8] } });
    grid.set(0, 1, 0, { block: 'rock' });
    const layer = traceBlockLayerOf(grid, [0, 0, 0], opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]));
    const scene = packTraceScene({ blocks: [{ ...layer, layers: 0b10 }] });
    const lamp = light({ kind: 'point', position: [0.5, 3.5, 0.5], color: [20, 20, 20], range: 8, shadows: true });
    const under: V3 = [0.5, 0, 0.5];
    expect(meanAt(under, [0, 1, 0], { ...lamp, casterMask: 0b10 }, scene)).toBe(0);
    expect(meanAt(under, [0, 1, 0], { ...lamp, casterMask: 0b01 }, scene)).toBeCloseTo(meanAt(under, [0, 1, 0], lamp), 5);
    const sun = light({ kind: 'directional', direction: [0, 1, 0], color: [2, 2, 2], shadows: true });
    expect(meanAt(under, [0, 1, 0], { ...sun, casterMask: 0b11 }, scene)).toBe(0);
    expect(meanAt(under, [0, 1, 0], { ...sun, casterMask: 0b01 }, scene)).toBeCloseTo(2, 4);
  });

  it('light layers: a light lights only the units in its mask; one past the per-pixel cap lights the cache all the same', () => {
    const units = [
      { key: 'a', min: [0, 0, 0], max: [1, 1, 1], texels: 2 },
      { key: 'b', min: [0, 0, 0], max: [1, 1, 1], texels: 2, layers: 0b10 },
    ];
    // The host's two calls the frame reads: its planned slices, and where their texels are (none here).
    const host = { slicesThisFrame: () => units.map((unit) => ({ unit, from: 0, to: 2 })), texelsOf: () => null } as unknown as SurfaceCacheHost;
    const many = Array.from({ length: 40 }, (_, i) => light({ kind: 'point', id: `p${i}`, position: [0.5, 2, 0.5], range: 4, lightMask: i === 0 ? 0b01 : 0xff }));
    const sun = light({ kind: 'directional', direction: [0, 1, 0], lightMask: 0b01 });
    const f = lightFrameOf(host, [...many, sun]);
    expect(f.slices[0]!.lights).toHaveLength(40);
    expect(f.slices[0]!.suns).toBe(1);
    expect(f.slices[1]!.lights).toHaveLength(39);
    expect(f.slices[1]!.lights).not.toContain(0);
    expect(f.slices[1]!.suns).toBe(0);
    // Every directional light on lights the cache, each in the units its mask names.
    const moon = light({ kind: 'directional', id: 'moon', direction: [1, 0, 0] });
    const two = lightFrameOf(host, [sun, moon, { ...moon, id: 'off', on: false }]);
    expect(two.suns.map((l) => l.id)).toEqual(['l', 'moon']);
    expect(two.slices.map((s) => s.suns)).toEqual([0b11, 0b10]);
  });

  it('two suns: each lights the texel, and the share materials take back out is the drawn suns\' luminance share', () => {
    const up = light({ kind: 'directional', id: 'up', direction: [0, 1, 0], color: [2, 2, 2] });
    const slant = light({ kind: 'directional', id: 'slant', direction: [0.6, 0.8, 0], color: [0, 3, 0] });
    const grid = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-20, 0, -20], max: [20, 4, 20] } });
    for (let z = -20; z < 20; z += 1) for (let x = -20; x < 20; x += 1) grid.set(x, 3, z, { block: 'rock' });
    const roof = packTraceScene({ blocks: [traceBlockLayerOf(grid, [0, 0, 0], opaqueByBlockTypes([{ blockId: 'rock', shape: 'full' } as BlockType]))] });
    const run = (scene: PackedTraceScene, drawn?: ReadonlySet<string>): { e: Float32Array; share: number } => {
      const frame: LightPassFrame = { points: Float32Array.from([0.5, 0, 0.5, 0, 1, 0]), slices: [{ texels: 1, lights: [], suns: 0b11, level: 0 }], lights: [], suns: [up, { ...slant, shadows: false }], ...(drawn !== undefined ? { drawnSuns: drawn } : {}) };
      const out = new Float32Array(1);
      const e = lightFrameCpu(frame, scene, 7, SHADOW_TRACE, out);
      return { e, share: out[0]! };
    };
    // Open sky: both, green from the slanted one only.
    const open = run(EMPTY);
    expect(open.e[0]).toBeCloseTo(2, 4);
    expect(open.e[1]).toBeCloseTo(2 + 3 * 0.8, 4);
    const lu = 2, ls = 0.7152 * 3;
    expect(open.share).toBeCloseTo((lu * 1 + ls * 0.8) / (lu + ls), 4);
    // Under the roof: only the shadowless one reaches.
    const under = run(roof);
    expect(under.e[0]).toBeCloseTo(0, 5);
    expect(under.e[1]).toBeCloseTo(3 * 0.8, 4);
    expect(under.share).toBeCloseTo((ls * 0.8) / (lu + ls), 4);
    // Only the first drawn per pixel: the share is its own, exactly.
    expect(run(EMPTY, new Set(['up'])).share).toBeCloseTo(1, 5);
    expect(run(roof, new Set(['up'])).share).toBe(0);
  });

  it('a frame reached by many lights is cut into runs within a ray budget, every texel once, its light unchanged', () => {
    const lights = Array.from({ length: 12 }, (_, i) => light({ kind: 'area', id: `a${i}`, position: [i * 0.3, 2.5, 0], color: [5, 5, 5], range: 10, area: { u: [0.3, 0, 0], v: [0, 0, 0.2], twoSided: false } }));
    const texels = 300;
    const points = new Float32Array(texels * 6);
    for (let i = 0; i < texels; i += 1) points.set([i * 0.01, 0, 0, 0, 1, 0], i * 6);
    const frame: LightPassFrame = { points, slices: [{ texels: 120, lights: lights.map((_, j) => j), suns: 0, level: 0 }, { texels: 180, lights: [0, 1, 2], suns: 0, level: 1 }], lights, suns: [] };
    const parts = splitLightFrame(frame, 4000);
    expect(parts.length).toBeGreaterThan(3);
    let seen = 0;
    for (const p of parts) {
      expect(p.first).toBe(seen);
      expect(packLightFrame(p.frame).rays).toBeLessThanOrEqual(4000);
      seen += p.frame.slices.reduce((n, s) => n + s.texels, 0);
    }
    expect(seen).toBe(texels);
    expect(sliceRays(frame, frame.slices[0]!)).toBe(12 * 16);
    // The same light whole or in parts (each part draws its own random sequence: equal in the mean).
    const whole = lightFrameCpu(frame, EMPTY, 3, SHADOW_TRACE);
    const cut = new Float32Array(texels * 3);
    for (const p of parts) cut.set(lightFrameCpu(p.frame, EMPTY, 3, SHADOW_TRACE), p.first * 3);
    const sum = (a: Float32Array): number => a.reduce((x, y) => x + y, 0);
    expect(Math.abs(sum(cut) - sum(whole)) / sum(whole)).toBeLessThan(0.05);
  });

  it('a shadow ray longer than its step budget: traced on to the wall that stops it, and blocked (never lit) if it still runs out', () => {
    // Posts round a 600 m line (none on it) cut the architecture grid into ~256 cells along it, twice one pass's budget; a wall stands before the lamp.
    const posts: TraceBox[] = [];
    for (let x = 0; x < 600; x += 1) for (const [y, z] of [[0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]] as const) posts.push({ center: [x + 0.5, y, z], half: [0.05, 0.05, 0.05], rotation: [0, 0, 0, 1] });
    const wall: TraceBox = { center: [590, 0, 0], half: [0.5, 0.55, 0.55], rotation: [0, 0, 0, 1] };
    const open = packTraceScene({ arch: { boxes: posts, triangles: new Float32Array(0) } });
    const walled = packTraceScene({ arch: { boxes: [...posts, wall], triangles: new Float32Array(0) } });
    const o: V3 = [1, 0, 0];
    const d: V3 = [1, 0, 0];
    expect(traceRayCpu(sceneView(walled), o, d, 0, 594, { ...SHADOW_TRACE, resumes: 0 }).kind).toBe(TRACE_UNFINISHED);
    expect(traceRayCpu(sceneView(walled), o, d, 0, 594, SHADOW_TRACE).kind).toBe(TRACE_ARCH);
    const lamp = light({ kind: 'point', position: [595, 0, 0], color: [1e6, 1e6, 1e6], range: 1000 });
    const lit = (scene: PackedTraceScene, resumes?: number): number => {
      const frame: LightPassFrame = { points: Float32Array.from([1, 0, 0, 1, 0, 0]), slices: [{ texels: 1, lights: [0], suns: 0, level: 0 }], lights: [lamp], suns: [] };
      return lightFrameCpu(frame, scene, 7, { ...SHADOW_TRACE, ...(resumes === undefined ? {} : { resumes }) })[0]!;
    };
    // Resumed, the open line reaches the lamp and the walled one is in the wall's shadow.
    expect(lit(open)).toBeGreaterThan(0);
    expect(lit(walled)).toBe(0);
    // Out of steps with no resume left: blocked, never light through the wall it did not reach.
    expect(lit(walled, 0)).toBe(0);
    expect(lit(open, 0)).toBe(0);
  });
});
