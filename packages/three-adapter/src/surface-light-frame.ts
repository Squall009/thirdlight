/**
 * One frame's direct-light work as the light pass takes it
 * (`surface-light-pass.ts`) and its CPU twin (`surface-light-cpu.ts`): the
 * stale texels the scheduler hands out (`SurfaceRelight.plan`), their
 * points, the lights reaching each slice, and the words both read.
 *
 * Words (one buffer): a slice table (`SLICE_WORDS` per slice: first texel,
 * texels, first ray, rays per texel, its lights' list, their count, sun
 * rays, its cache level), the light lists, the sun (`SUN_WORDS`: direction
 * toward it, colour, shadows) and the light records (`LIGHT_WORDS`):
 *
 * - 0–2 position (an area light: its centre), 3 reach, 4–6 colour
 *   (× intensity), 7 the spot's cos outer (`POINT_CONE` a point light,
 *   `AREA_CONE` an area light), 8–10 the spot's axis or the way an area
 *   light faces, 11 the spot's cos inner (an area light: 1 when two-sided),
 *   12–14 an area light's half side u, 15 its shape (`AREA_RECT`,
 *   `AREA_LINE`; 0 none), 16–18 its half side v (0 for a line), 19 its
 *   rays a texel at level 0 | 1 << 8 when it casts shadows.
 *
 * Pure (no three.js, no device).
 */
import { LIGHT_LAYERS_ALL } from '@thirdlight/runtime';

import { lightReach, type CacheLight } from './surface-changes';
import type { SurfaceCacheHost } from './surface-cache-host';
import { TEXEL_POINT_FLOATS, patchTexelPoints, tileTexelPoints } from './surface-texels';

/**
 * Rays a texel casts toward the sun (over its disc), toward each point or
 * spot light (over its small sphere) and over each area light's shape, at
 * cache level 0: the medium tier's counts. A small light's penumbra is a
 * few centimetres, which four rays resolve; the sun's wider one takes
 * eight; an area light's shape, as wide as a lamp's panel, sixteen.
 */
export const SUN_RAYS = 8;
export const LIGHT_RAYS = 4;
export const AREA_RAYS = 16;

/** Rays a texel of cache level `level` casts: halved a level (a coarser texel is wider than the detail more rays would resolve), at least one. */
export function raysAtLevel(rays: number, level: number): number {
  return Math.max(1, rays >> Math.max(0, level));
}

/** The sun's disc (radians, its angular radius): its shadows' penumbra. */
export const SUN_DISC_RADIANS = 0.02;
/** The sphere (m) a point or spot light's shadow rays aim over: three's lights have no size, a little softness reads as real. */
export const POINT_LIGHT_RADIUS = 0.05;
/** How far (m) a texel's rays start off its surface. */
export const RAY_BIAS = 0.01;

export const SLICE_WORDS = 8;
export const LIGHT_WORDS = 20;
export const SUN_WORDS = 8;
/** Word 7 of a point light's record (a spot's cosine is never below −1). */
export const POINT_CONE = -3;
/** Word 7 of an area light's record. */
export const AREA_CONE = -5;
export const AREA_RECT = 1;
export const AREA_LINE = 2;
/** Bit of record word 19: the light casts shadows. */
export const LIGHT_SHADOWS = 1 << 8;

/** A light's rays a texel at level 0. */
export function lightRaysOf(l: CacheLight): number {
  return l.rays ?? (l.kind === 'area' ? AREA_RAYS : l.kind === 'directional' ? SUN_RAYS : LIGHT_RAYS);
}

/** Rays each texel of a frame's slice casts. */
export function sliceRays(frame: LightPassFrame, sl: LightPassFrame['slices'][number]): number {
  const sunRays = sl.sun ? raysAtLevel(SUN_RAYS, sl.level) : 0;
  return Math.max(1, sunRays + sl.lights.reduce((r, j) => r + raysAtLevel(lightRaysOf(frame.lights[j]!), sl.level), 0));
}

/**
 * A frame cut into parts of at most `maxRays` rays (a slice is cut between
 * texels when it does not fit): each part is one run of the pass, so no
 * buffer outgrows the device's binding size however many lights reach.
 * Each part: its frame and its first texel in the whole.
 */
export function splitLightFrame(frame: LightPassFrame, maxRays: number): { frame: LightPassFrame; first: number }[] {
  const out: { frame: LightPassFrame; first: number }[] = [];
  let slices: LightPassFrame['slices'][number][] = [];
  let rays = 0;
  let first = 0;
  const flush = (): void => {
    const n = slices.reduce((s, sl) => s + sl.texels, 0);
    out.push({ frame: { ...frame, points: frame.points.subarray(first * TEXEL_POINT_FLOATS, (first + n) * TEXEL_POINT_FLOATS), slices }, first });
    first += n;
    slices = [];
    rays = 0;
  };
  for (const sl of frame.slices) {
    const per = sliceRays(frame, sl);
    let left = sl.texels;
    while (left > 0) {
      let room = Math.floor((maxRays - rays) / per);
      if (room < 1) {
        if (slices.length > 0) {
          flush();
          continue;
        }
        // One texel with more rays than a part holds goes alone.
        room = 1;
      }
      const take = Math.min(left, room);
      slices.push({ ...sl, texels: take });
      rays += take * per;
      left -= take;
    }
  }
  if (slices.length > 0) flush();
  return out;
}

/** One frame's work as the pass takes it: the planned slices' texel points and the lights reaching each. */
export interface LightPassFrame {
  /** Texel points (`TEXEL_POINT_FLOATS` each), slices in order. */
  readonly points: Float32Array;
  /** Per slice: its texels, the lights reaching its unit, whether the sun is on, and its cache level (ray counts fall with it). */
  readonly slices: readonly { readonly texels: number; readonly lights: readonly number[]; readonly sun: boolean; readonly level: number }[];
  /** The point, spot and area lights. */
  readonly lights: readonly CacheLight[];
  /** The sun (null: none on). */
  readonly sun: CacheLight | null;
}

/** The frame's word buffer and its counts. */
export function packLightFrame(frame: LightPassFrame): { words: Uint32Array; texels: number; rays: number; sunAt: number } {
  const n = frame.slices.length;
  const listWords = frame.slices.reduce((s, sl) => s + sl.lights.length, 0);
  const sunAt = n * SLICE_WORDS + listWords;
  const words = new Uint32Array(sunAt + SUN_WORDS + frame.lights.length * LIGHT_WORDS);
  const f = new Float32Array(words.buffer);
  let texel = 0;
  let ray = 0;
  let list = n * SLICE_WORDS;
  frame.slices.forEach((sl, i) => {
    const sunRays = sl.sun ? raysAtLevel(SUN_RAYS, sl.level) : 0;
    const rpt = sliceRays(frame, sl);
    words.set([texel, sl.texels, ray, rpt, list, sl.lights.length, sunRays, sl.level], i * SLICE_WORDS);
    for (const j of sl.lights) words[list++] = j;
    texel += sl.texels;
    ray += sl.texels * rpt;
  });
  if (frame.sun !== null) {
    f.set(frame.sun.direction, sunAt);
    f.set(frame.sun.color, sunAt + 4);
    words[sunAt + 7] = frame.sun.shadows === false ? 0 : 1;
  }
  frame.lights.forEach((l, j) => {
    const at = sunAt + SUN_WORDS + j * LIGHT_WORDS;
    f.set(l.position, at);
    f[at + 3] = lightReach(l);
    f.set(l.color, at + 4);
    f.set(l.direction, at + 8);
    if (l.kind === 'area' && l.area !== undefined) {
      f[at + 7] = AREA_CONE;
      f[at + 11] = l.area.twoSided ? 1 : 0;
      f.set(l.area.u, at + 12);
      words[at + 15] = Math.hypot(l.area.v[0] ?? 0, l.area.v[1] ?? 0, l.area.v[2] ?? 0) > 0 ? AREA_RECT : AREA_LINE;
      f.set(l.area.v, at + 16);
    } else {
      const spot = l.kind === 'spot';
      f[at + 7] = spot ? l.cone : POINT_CONE;
      // The penumbra's inner edge, as three's: the cone's angle less its penumbra share.
      f[at + 11] = spot ? Math.cos(Math.acos(Math.min(1, Math.max(-1, l.cone))) * (1 - l.penumbra)) : 1;
    }
    words[at + 19] = lightRaysOf(l) | (l.shadows === false ? 0 : LIGHT_SHADOWS);
  });
  return { words, texels: texel, rays: ray, sunAt };
}

/** Whether a light lights a unit of these light layers. */
function lights(l: CacheLight, layers: number): boolean {
  return ((l.lightMask ?? LIGHT_LAYERS_ALL) & layers) !== 0;
}

/**
 * This frame's planned work from the host (`SurfaceCacheHost.slicesThisFrame`):
 * each slice's texel points, the lights whose reach touches its unit and
 * whose mask shares a layer with it, and the sun when one is on.
 */
export function lightFrameOf(host: SurfaceCacheHost, all: readonly CacheLight[], points: Float32Array | null = null): LightPassFrame {
  const slices = host.slicesThisFrame();
  const texels = slices.reduce((n, s) => n + (s.to - s.from), 0);
  const out = points !== null && points.length >= texels * TEXEL_POINT_FLOATS ? points : new Float32Array(texels * TEXEL_POINT_FLOATS);
  const local = all.filter((l) => l.on && l.kind !== 'directional');
  const sun = all.find((l) => l.on && l.kind === 'directional') ?? null;
  const reach = local.map((l) => lightReach(l));
  const list: LightPassFrame['slices'][number][] = [];
  let at = 0;
  for (const s of slices) {
    const src = host.texelsOf(s.unit.key);
    const n = s.to - s.from;
    if (src === null) out.fill(0, at, at + n * TEXEL_POINT_FLOATS);
    else if ('patch' in src) patchTexelPoints(src, s.from, s.to, out, at);
    else tileTexelPoints(src, s.from, s.to, out, at);
    at += n * TEXEL_POINT_FLOATS;
    const layers = s.unit.layers ?? LIGHT_LAYERS_ALL;
    const touching: number[] = [];
    local.forEach((l, j) => {
      if (!lights(l, layers)) return;
      const r = reach[j]!;
      for (let k = 0; k < 3; k += 1) if (l.position[k]! + r < s.unit.min[k]! || l.position[k]! - r > s.unit.max[k]!) return;
      touching.push(j);
    });
    list.push({ texels: n, lights: touching, sun: sun !== null && lights(sun, layers), level: src === null ? 0 : 'patch' in src ? src.patch.ring : src.level });
  }
  return { points: out, slices: list, lights: local, sun };
}
