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
 * A bake's rings start at its level (the finest ring has its tiles' texel)
 * and stand round the scene's content, not the eye; drawn from the bake
 * they stay where it put them.
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

/**
 * Rings a terrain needs, the finest at level `first`, so that its farthest
 * point is inside the last one: from anywhere on it (rings following the
 * eye), or from `at` (x, z: rings standing there).
 */
export function terrainRingsNeeded(src: TerrainRingSource, first = 0, at?: readonly number[]): number {
  const dx = at === undefined ? (src.max[0] ?? 0) - (src.min[0] ?? 0) : Math.max(Math.abs((src.min[0] ?? 0) - at[0]!), Math.abs((src.max[0] ?? 0) - at[0]!));
  const dz = at === undefined ? (src.max[2] ?? 0) - (src.min[2] ?? 0) : Math.max(Math.abs((src.min[2] ?? 0) - at[1]!), Math.abs((src.max[2] ?? 0) - at[1]!));
  const reach = Math.hypot(dx, dz);
  for (let k = 0; k < TERRAIN_RINGS_MAX; k += 1) if (terrainRingHalf(first + k) >= reach) return k + 1;
  return TERRAIN_RINGS_MAX;
}

function texel(level: number): number {
  return SURFACE_TEXEL_METRES * 2 ** level;
}

/** Half the side of a ring at `level` less the step it may lag the eye by and a texel of border: what of it is always valid. */
export function terrainRingHalf(level: number): number {
  return texel(level) * (TERRAIN_RING_TEXELS / 2 - TERRAIN_RING_STEP - 1);
}

/** One terrain's rings: ring k at level `first` + k. */
export class TerrainRings {
  /** Each ring's centre (x, z), snapped to its step (null until the first update). */
  private centres: ([number, number] | null)[] = [];
  /** `at`: the rings' centres, kept where they are (a bake's rings drawn from it). */
  constructor(readonly source: TerrainRingSource, public rings: number, readonly first = 0, private readonly at: readonly (readonly [number, number])[] | null = null) {
    if (at !== null) this.centres = at.map(([x, z]) => [x, z]);
  }
  get bytes(): number {
    return this.rings * TERRAIN_RING_BYTES;
  }
  /** Each ring's centre (x, z) now (null: not placed yet). */
  centresNow(): ([number, number] | null)[] {
    return this.centres.slice(0, this.rings).map((c) => (c === null ? null : [c[0], c[1]]));
  }
  /** Follows the eye (never, for rings kept where they are); returns the rings that stepped (their new strips need light). */
  update(eye: readonly number[]): number[] {
    const moved: number[] = [];
    if (this.at !== null) return moved;
    this.centres.length = this.rings;
    for (let k = 0; k < this.rings; k += 1) {
      const step = texel(this.first + k) * TERRAIN_RING_STEP;
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
      const half = terrainRingHalf(this.first + k);
      if (Math.abs(x - c[0]) > half || Math.abs(z - c[1]) > half) continue;
      const t = texel(this.first + k);
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
    const t = texel(this.first + k);
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
    return texel(this.first + k);
  }

  /** Each ring's world square (x0, z0, x1, z1) that is valid now. */
  windows(): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (let k = 0; k < this.rings; k += 1) {
      const c = this.centres[k];
      if (c === undefined || c === null) break;
      const h = terrainRingHalf(this.first + k);
      out.push([c[0] - h, c[1] - h, c[0] + h, c[1] + h]);
    }
    return out;
  }
}
