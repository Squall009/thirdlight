/**
 * The hand-over between the two lighting stores when a page runs both
 * (`?voxelLight=hybrid`): the surface cache's probes give the sky and bounce
 * light near the eye (its texels lit for their bounce, not read per pixel:
 * voxel-surface-path.ts `voxelStoreReadsTexels`), the voxel light volume
 * beyond a distance d, and across a fade of width w before d each pixel takes
 * a blend of the two (the volume's share smoothstep(d − w, d, x), the probes'
 * the rest), x being the pixel's distance to the eye across (x and z: the two
 * stores' windows follow the eye across, and a high eye keeps the cache on
 * the ground under it). Lamps' direct light is per pixel in both zones.
 *
 * d is a lighting tier setting (`voxelLightHandoverM`), `?voxelLightHandover=<m>`
 * overrides it for a bench. Each store keeps only what its share needs: the
 * cache lists the chunks within d + w (one fade of lead, so a chunk the eye
 * moves toward is charted before its pixels ask for it), the volume drops
 * bricks lying wholly within d − w − one level-0 brick (the eye's step
 * between re-looks).
 *
 * The volume's share as its per-pixel read takes it is
 * voxel-light-handover-nodes.ts's uniform; this file is its CPU twin and the
 * rules each store keeps by.
 *
 * Pure (no three.js).
 */

/** The fade's width as a share of the hand-over distance (w = d × this). */
export const VOXEL_HANDOVER_FADE_SHARE = 0.25;

/** The page flag for a bench: `?voxelLightHandover=<m>` sets the hand-over distance in place of the tier's. */
export const VOXEL_HANDOVER_URL_PARAM = 'voxelLightHandover';

/** The hand-over distance a page's query names (null: none, or not a positive number). */
export function voxelHandoverFromUrl(search: string): number | null {
  const v = Number(new URLSearchParams(search).get(VOXEL_HANDOVER_URL_PARAM) ?? NaN);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Where the fade runs (metres across from the eye): the volume's share is 0 before `from` and 1 from `to` on. */
export interface HandoverRing {
  readonly from: number;
  readonly to: number;
}

/** The ring of a hand-over distance d (m). */
export function handoverRing(d: number): HandoverRing {
  return { from: d * (1 - VOXEL_HANDOVER_FADE_SHARE), to: d };
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** The volume's share at distance `x` across from the eye (the TSL read's CPU twin). */
export function handoverVolumeShare(ring: HandoverRing, x: number): number {
  return smooth(ring.from, ring.to, x);
}

/** The cache's share at distance `x` (the rest: the two always sum to 1). */
export function handoverCacheShare(ring: HandoverRing, x: number): number {
  return 1 - handoverVolumeShare(ring, x);
}

/** How far across the cache lists chunks: the ring's end and one fade more. */
export function handoverCacheReach(ring: HandoverRing): number {
  return ring.to + (ring.to - ring.from);
}

/**
 * Within what distance across a volume brick lies wholly to be dropped: the fade's start less one step of the eye
 * (`stepM`, the distance it may move between re-looks), so no pixel the volume's share reaches lacks its bricks.
 */
export function handoverVolumeKeepFrom(ring: HandoverRing, stepM: number): number {
  return ring.from - stepM;
}

/**
 * Whether a brick whose box across spans x0 … x1, z0 … z1 (metres) is kept by the volume's hand-over rule: some part
 * of it lies past `keepFrom` from the eye (ex, ez); `keepFrom` null keeps every brick.
 */
export function handoverKeepsBox(keepFrom: number | null, ex: number, ez: number, x0: number, x1: number, z0: number, z1: number): boolean {
  if (keepFrom === null || keepFrom <= 0) return true;
  const fx = Math.max(Math.abs(x0 - ex), Math.abs(x1 - ex));
  const fz = Math.max(Math.abs(z0 - ez), Math.abs(z1 - ez));
  return Math.hypot(fx, fz) > keepFrom;
}

/** The nearest distance across from (ex, ez) to a box spanning x0 … x1, z0 … z1. */
export function boxDistanceAcross(ex: number, ez: number, x0: number, x1: number, z0: number, z1: number): number {
  const dx = ex < x0 ? x0 - ex : ex > x1 ? ex - x1 : 0;
  const dz = ez < z0 ? z0 - ez : ez > z1 ? ez - z1 : 0;
  return Math.hypot(dx, dz);
}
