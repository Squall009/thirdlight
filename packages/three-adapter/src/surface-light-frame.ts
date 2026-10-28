/**
 * One frame's direct-light work as the light pass takes it
 * (`surface-light-pass.ts`) and its CPU twin (`surface-light-cpu.ts`): the
 * stale texels the scheduler hands out (`SurfaceRelight.plan`), their
 * points, the lights reaching each slice, and the words both read.
 *
 * Words (one buffer): a slice table (`SLICE_WORDS` per slice: first texel,
 * texels, first ray, rays per texel, its lights' list, their count, rays
 * per sun, its cache level, the rooms its texels may be in and their count,
 * the suns lighting it as bits), the light lists, the suns (`SUN_WORDS`
 * each: direction toward it, caster mask, colour, shadows, its share
 * weight), the light records (`LIGHT_WORDS`), the room lists, and the
 * rooms (`surface-rooms.ts`) at `roomsAt`.
 *
 * Every directional light on lights the cache (its bounce and reflections
 * read it). Materials draw directional lights per pixel, so a texel's
 * alpha says how much of the drawn ones' light it holds: the luminance
 * share of their summed colour (exact for one, close for several; a
 * colour split between suns of different hue and visibility is off by
 * that hue). A light record:
 *
 * - 0–2 position (an area light: its centre), 3 reach, 4–6 colour
 *   (× intensity), 7 the spot's cos outer (`POINT_CONE` a point light,
 *   `AREA_CONE` an area light), 8–10 the spot's axis or the way an area
 *   light faces, 11 the spot's cos inner (an area light: 1 when two-sided),
 *   12–14 an area light's half side u, 15 its shape (`AREA_RECT`,
 *   `AREA_LINE`; 0 none), 16–18 its half side v (0 for a line), 19 its
 *   rays a texel at level 0 | 1 << 8 when it casts shadows | its shadow
 *   caster mask << 16 (the sun's: word 3 of its record), 20–21 the rooms
 *   it may light (list, count; 0: not held to rooms).
 *
 * Pure (no three.js, no device).
 */
import { LIGHT_LAYERS_ALL } from '@thirdlight/runtime';

import { lightReach, type CacheLight } from './surface-changes';
import type { SurfaceRooms } from './surface-rooms';
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
export { POINT_LIGHT_RADIUS } from './surface-changes';
/** How far (m) a texel's rays start off its surface. */
export const RAY_BIAS = 0.01;

export const SLICE_WORDS = 11;
export const LIGHT_WORDS = 22;
export const SUN_WORDS = 12;
/** The most directional lights a frame lights the cache with (a slice names its suns as bits of one word); past it the strongest, logged. */
export const MAX_CACHE_SUNS = 32;
/** Word 7 of a point light's record (a spot's cosine is never below −1). */
export const POINT_CONE = -3;
/** Word 7 of an area light's record. */
export const AREA_CONE = -5;
export const AREA_RECT = 1;
export const AREA_LINE = 2;
/** Bit of record word 19: the light casts shadows. */
export const LIGHT_SHADOWS = 1 << 8;

/** The most rays a light's record holds a texel (its rays take a byte of the record). */
const MAX_LIGHT_RAYS = 255;

/** A light's rays a texel at level 0 (`scale`: the lighting tier's multiple of the counts). */
export function lightRaysOf(l: CacheLight, scale = 1): number {
  return Math.min(MAX_LIGHT_RAYS, (l.rays ?? (l.kind === 'area' ? AREA_RAYS : l.kind === 'directional' ? SUN_RAYS : LIGHT_RAYS)) * scale);
}

/** How many suns a slice's bits name. */
export function sunCount(bits: number): number {
  let n = 0;
  for (let b = bits >>> 0; b !== 0; b &= b - 1) n += 1;
  return n;
}

/** Rays each texel of a frame's slice casts. */
export function sliceRays(frame: LightPassFrame, sl: LightPassFrame['slices'][number]): number {
  const scale = frame.rayScale ?? 1;
  const sunRays = raysAtLevel(SUN_RAYS * scale, sl.level) * sunCount(sl.suns);
  return Math.max(1, sunRays + sl.lights.reduce((r, j) => r + raysAtLevel(lightRaysOf(frame.lights[j]!, scale), sl.level), 0));
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
  /** Per slice: its texels, the lights reaching its unit, the suns lighting it (bit i: `suns[i]`), and its cache level (ray counts fall with it). */
  readonly slices: readonly { readonly texels: number; readonly lights: readonly number[]; readonly suns: number; readonly level: number; /** The rooms its texels may be in (absent: none). */ readonly rooms?: readonly number[] }[];
  /** The point, spot and area lights. */
  readonly lights: readonly CacheLight[];
  /** Per light, the rooms it may light (null or absent: not held to rooms), and the packed rooms (`SurfaceRooms.words`). */
  readonly lightRooms?: readonly (readonly number[] | null)[];
  readonly rooms?: Uint32Array;
  /** The directional lights on (at most `MAX_CACHE_SUNS`). */
  readonly suns: readonly CacheLight[];
  /** Ids of the suns materials draw per pixel, whose share a texel's alpha holds (absent: every sun). */
  readonly drawnSuns?: ReadonlySet<string>;
  /** The lighting tier's multiple of every light's rays (absent: 1). */
  readonly rayScale?: number;
}

/** The frame's word buffer and its counts (`roomsAt`: where the rooms start; 0 when there are none). */
export function packLightFrame(frame: LightPassFrame): { words: Uint32Array; texels: number; rays: number; sunAt: number; roomsAt: number; suns: number } {
  const n = frame.slices.length;
  const listWords = frame.slices.reduce((s, sl) => s + sl.lights.length, 0);
  const sunAt = n * SLICE_WORDS + listWords;
  const recordsEnd = sunAt + frame.suns.length * SUN_WORDS + frame.lights.length * LIGHT_WORDS;
  const roomLists = frame.slices.reduce((s, sl) => s + (sl.rooms?.length ?? 0), 0) + (frame.lightRooms ?? []).reduce((s, r) => s + (r?.length ?? 0), 0);
  const roomsAt = frame.rooms === undefined ? 0 : recordsEnd + roomLists;
  const words = new Uint32Array(recordsEnd + roomLists + (frame.rooms?.length ?? 0));
  const f = new Float32Array(words.buffer);
  let texel = 0;
  let ray = 0;
  let list = n * SLICE_WORDS;
  let rooms = recordsEnd;
  frame.slices.forEach((sl, i) => {
    const sunRays = sl.suns !== 0 ? raysAtLevel(SUN_RAYS * (frame.rayScale ?? 1), sl.level) : 0;
    const rpt = sliceRays(frame, sl);
    words.set([texel, sl.texels, ray, rpt, list, sl.lights.length, sunRays, sl.level, rooms, sl.rooms?.length ?? 0, sl.suns >>> 0], i * SLICE_WORDS);
    for (const j of sl.lights) words[list++] = j;
    for (const r of sl.rooms ?? []) words[rooms++] = r;
    texel += sl.texels;
    ray += sl.texels * rpt;
  });
  const drawn = (l: CacheLight): boolean => frame.drawnSuns === undefined || frame.drawnSuns.has(l.id);
  const lum = luminance;
  const drawnLum = frame.suns.reduce((t, l) => t + (drawn(l) ? lum(l.color) : 0), 0);
  frame.suns.forEach((l, i) => {
    const at = sunAt + i * SUN_WORDS;
    f.set(l.direction, at);
    f.set(l.color, at + 4);
    words[at + 7] = l.shadows === false ? 0 : 1;
    words[at + 3] = l.casterMask ?? LIGHT_LAYERS_ALL;
    f[at + 8] = drawn(l) && drawnLum > 0 ? lum(l.color) / drawnLum : 0;
  });
  const lightsAt = sunAt + frame.suns.length * SUN_WORDS;
  frame.lights.forEach((l, j) => {
    const at = lightsAt + j * LIGHT_WORDS;
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
    words[at + 19] = (lightRaysOf(l, frame.rayScale ?? 1) | (l.shadows === false ? 0 : LIGHT_SHADOWS) | ((l.casterMask ?? LIGHT_LAYERS_ALL) << 16)) >>> 0;
    const held = frame.lightRooms?.[j] ?? null;
    words[at + 20] = rooms;
    words[at + 21] = held?.length ?? 0;
    for (const r of held ?? []) words[rooms++] = r;
  });
  if (frame.rooms !== undefined) words.set(frame.rooms, roomsAt);
  return { words, texels: texel, rays: ray, sunAt, roomsAt, suns: frame.suns.length };
}

/** Whether a light lights a unit of these light layers. */
function lights(l: CacheLight, layers: number): boolean {
  return ((l.lightMask ?? LIGHT_LAYERS_ALL) & layers) !== 0;
}

/**
 * This frame's planned work from the host (`SurfaceCacheHost.slicesThisFrame`):
 * each slice's texel points, the lights whose reach touches its unit and
 * whose mask shares a layer with it, and the suns on whose mask does. With
 * rooms, a light standing in a closed room set reaches only the units
 * those rooms touch, and the pass tests each texel's room.
 */
export function lightFrameOf(host: SurfaceCacheHost, all: readonly CacheLight[], points: Float32Array | null = null, rooms: SurfaceRooms | null = null, rayScale = 1, drawnSuns?: ReadonlySet<string>): LightPassFrame {
  const slices = host.slicesThisFrame();
  const texels = slices.reduce((n, s) => n + (s.to - s.from), 0);
  const out = points !== null && points.length >= texels * TEXEL_POINT_FLOATS ? points : new Float32Array(texels * TEXEL_POINT_FLOATS);
  const local = all.filter((l) => l.on && l.kind !== 'directional');
  const suns = cacheSuns(all);
  const reach = local.map((l) => lightReach(l));
  const held = rooms === null ? null : local.map((l) => rooms.lightRooms(l.position, l.shadows === false));
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
      const h = held?.[j] ?? null;
      if (h !== null && !rooms!.touches(s.unit.min, s.unit.max, h)) return;
      touching.push(j);
    });
    const unitRooms = held !== null && touching.some((j) => held[j] !== null) ? rooms!.unitRooms(s.unit.min, s.unit.max) : [];
    let sunBits = 0;
    suns.forEach((l, i) => {
      if (lights(l, layers)) sunBits |= 1 << i;
    });
    list.push({ texels: n, lights: touching, suns: sunBits >>> 0, level: src === null ? 0 : 'patch' in src ? src.patch.ring : src.level, ...(unitRooms.length > 0 ? { rooms: unitRooms } : {}) });
  }
  return { points: out, slices: list, lights: local, suns, ...(drawnSuns !== undefined ? { drawnSuns } : {}), ...(rayScale !== 1 ? { rayScale } : {}), ...(rooms !== null && held!.some((h) => h !== null) ? { lightRooms: held!, rooms: rooms.words } : {}) };
}

/** A linear colour's luminance (Rec. 709). */
function luminance(c: readonly number[]): number {
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}

let sunsDropped = 0;

/** The directional lights on, the strongest `MAX_CACHE_SUNS` where more are (said once per count). */
export function cacheSuns(all: readonly CacheLight[]): CacheLight[] {
  const on = all.filter((l) => l.on && l.kind === 'directional');
  if (on.length <= MAX_CACHE_SUNS) return on;
  const kept = on.map((l, i) => ({ l, i, k: luminance(l.color) })).sort((a, b) => b.k - a.k || a.i - b.i).slice(0, MAX_CACHE_SUNS).sort((a, b) => a.i - b.i).map((x) => x.l);
  if (on.length !== sunsDropped) {
    sunsDropped = on.length;
    console.warn(`[thirdlight] surface cache: ${on.length} directional lights on; the strongest ${MAX_CACHE_SUNS} light the cache, the rest only per pixel`);
  }
  return kept;
}
