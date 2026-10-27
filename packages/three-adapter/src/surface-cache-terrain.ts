/**
 * The surface cache's addressing of terrain: rings of texels laid over the
 * height grid around the view (a clipmap), each ring the same texel count
 * and twice the texel size of the one inside it. A world of any size costs
 * the same few rings; what lies beyond the last ring is not resident.
 *
 * Each ring follows the eye in steps of `TERRAIN_RING_STEP` texels and wraps
 * (texel x is world x / texel size, modulo the ring's side), so a step
 * leaves every texel still inside where it was and only the strip that came
 * in needs light (`moved` names the rings that stepped).
 *
 * Pure (no three.js).
 */
import { SURFACE_TEXEL_BYTES, SURFACE_TEXEL_METRES } from './surface-cache-atlas';

/** Texels per ring side. */
export const TERRAIN_RING_TEXELS = 512;
/** The most rings one terrain holds (ring 6's 6.4 m texels reach about 1.5 km from the eye). */
export const TERRAIN_RINGS_MAX = 7;
/** Texels a ring steps by when the eye has moved past it. */
export const TERRAIN_RING_STEP = 16;
/** Texels per side of a ring patch: the unit a ring's light is computed and marked stale by. */
export const TERRAIN_PATCH_TEXELS = 64;
/** Bytes of one ring. */
export const TERRAIN_RING_BYTES = TERRAIN_RING_TEXELS * TERRAIN_RING_TEXELS * SURFACE_TEXEL_BYTES;

/** A terrain's place: what the rings need to know of it. */
export interface TerrainRingSource {
  readonly key: string;
  /** The terrain's world box (x, z place the rings; y is the heights' range, for marks). */
  readonly min: readonly number[];
  readonly max: readonly number[];
}

/**
 * A square of a ring's texels on the world grid (`TERRAIN_PATCH_TEXELS` a
 * side, cut to the ring's valid window): world texel indices `ix`, `iz`
 * (world x / the ring's texel) from its corner, `w` × `h` of them.
 */
export interface RingPatch {
  readonly ring: number;
  readonly px: number;
  readonly pz: number;
  readonly ix: number;
  readonly iz: number;
  readonly w: number;
  readonly h: number;
}

/** Where a point's light is in the rings: the ring (0 finest) and the texel in it. */
export interface RingTexel {
  readonly ring: number;
  readonly x: number;
  readonly y: number;
}

/** Rings a terrain needs so that its farthest point from anywhere on it is inside the last one. */
export function terrainRingsNeeded(src: TerrainRingSource): number {
  const reach = Math.hypot((src.max[0] ?? 0) - (src.min[0] ?? 0), (src.max[2] ?? 0) - (src.min[2] ?? 0));
  for (let k = 0; k < TERRAIN_RINGS_MAX; k += 1) if (terrainRingHalf(k) >= reach) return k + 1;
  return TERRAIN_RINGS_MAX;
}

function texel(k: number): number {
  return SURFACE_TEXEL_METRES * 2 ** k;
}

/** Half a ring's side less the step it may lag the eye by and a texel of border: what of it is always valid. */
export function terrainRingHalf(k: number): number {
  return texel(k) * (TERRAIN_RING_TEXELS / 2 - TERRAIN_RING_STEP - 1);
}

/** One terrain's rings. */
export class TerrainRings {
  /** Each ring's centre (x, z), snapped to its step (null until the first update). */
  private centres: ([number, number] | null)[] = [];
  constructor(readonly source: TerrainRingSource, public rings: number) {}
  get bytes(): number {
    return this.rings * TERRAIN_RING_BYTES;
  }
  /** Follows the eye; returns the rings that stepped (their new strips need light). */
  update(eye: readonly number[]): number[] {
    const moved: number[] = [];
    this.centres.length = this.rings;
    for (let k = 0; k < this.rings; k += 1) {
      const step = texel(k) * TERRAIN_RING_STEP;
      const c = this.centres[k] ?? null;
      const x = eye[0] ?? 0;
      const z = eye[2] ?? 0;
      if (c !== null && Math.abs(x - c[0]) <= step && Math.abs(z - c[1]) <= step) continue;
      this.centres[k] = [Math.round(x / step) * step, Math.round(z / step) * step];
      moved.push(k);
    }
    return moved;
  }
  /** The texel holding world point (x, z): in the finest ring that holds it, or null beyond the last (or before the first update). */
  texelOf(x: number, z: number): RingTexel | null {
    for (let k = 0; k < this.rings; k += 1) {
      const c = this.centres[k];
      if (c === undefined || c === null) return null;
      const half = terrainRingHalf(k);
      if (Math.abs(x - c[0]) > half || Math.abs(z - c[1]) > half) continue;
      const t = texel(k);
      const wrap = (v: number): number => ((Math.floor(v / t) % TERRAIN_RING_TEXELS) + TERRAIN_RING_TEXELS) % TERRAIN_RING_TEXELS;
      return { ring: k, x: wrap(x), y: wrap(z) };
    }
    return null;
  }
  /**
   * Ring `k`'s patches over its valid window on the terrain, less those
   * wholly inside the ring within it (that light is read from the finer ring).
   */
  patches(k: number): RingPatch[] {
    const win = this.windows();
    const w = win[k];
    if (w === undefined) return [];
    const t = texel(k);
    const inner = k > 0 ? win[k - 1]! : null;
    const P = TERRAIN_PATCH_TEXELS;
    // The window, cut to the terrain (texels off it hold no light).
    const src = this.source;
    const ix0 = Math.ceil(Math.max(w[0], src.min[0]!) / t - 1e-9);
    const iz0 = Math.ceil(Math.max(w[1], src.min[2]!) / t - 1e-9);
    const ix1 = Math.floor(Math.min(w[2], src.max[0]!) / t + 1e-9);
    const iz1 = Math.floor(Math.min(w[3], src.max[2]!) / t + 1e-9);
    const out: RingPatch[] = [];
    for (let pz = Math.floor(iz0 / P); pz * P < iz1; pz += 1) {
      for (let px = Math.floor(ix0 / P); px * P < ix1; px += 1) {
        const ax = Math.max(ix0, px * P);
        const az = Math.max(iz0, pz * P);
        const bx = Math.min(ix1, (px + 1) * P);
        const bz = Math.min(iz1, (pz + 1) * P);
        if (bx <= ax || bz <= az) continue;
        if (inner !== null && ax * t >= inner[0] && bx * t <= inner[2] && az * t >= inner[1] && bz * t <= inner[3]) continue;
        out.push({ ring: k, px, pz, ix: ax, iz: az, w: bx - ax, h: bz - az });
      }
    }
    return out;
  }

  /** The world texel size of ring `k` (m). */
  texelMetres(k: number): number {
    return texel(k);
  }

  /** Each ring's world square (x0, z0, x1, z1) that is valid now. */
  windows(): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (let k = 0; k < this.rings; k += 1) {
      const c = this.centres[k];
      if (c === undefined || c === null) break;
      const h = terrainRingHalf(k);
      out.push([c[0] - h, c[1] - h, c[0] + h, c[1] + h]);
    }
    return out;
  }
}
