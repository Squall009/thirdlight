/**
 * How the voxel surface's two heaviest materials meet by their heights, and
 * how the surface gets wet. Written once over the projection's scalar
 * interface (`voxel-surface-projection.ts`): the program builds it from
 * shader nodes, the tests run it on numbers.
 *
 * **Height blend, in metres.** A material's height map is 0–1 (1 its
 * surface); its own height depth (`heightDepth`, metres) says how far below
 * the surface 0 lies, so sand stays shallow and rock deep and no texture is
 * squeezed onto a shared scale. Where two materials meet, each one's surface
 * there (height × depth, metres below the plain surface) is raised by its
 * share of the blend: the one standing higher wins, over a contrast of
 * {@link HEIGHT_BLEND_CONTRAST_METRES}, so rock's tops break through sand and
 * sand fills rock's cracks. The share's weight is the deeper depth plus the
 * contrast, so a material whose share is whole always shows alone, and two
 * flat materials (no depth) blend by their shares as before.
 *
 * **Wetness** (the voxel wetness bits, 0 dry … 1 the wettest level), the
 * owner's R111: rising wetness darkens the albedo and lowers the roughness;
 * it flattens the material's normal detail; and water fills the crevices
 * first, by height: the water line rises with the square of the wetness to
 * {@link WET_FILL_MAX} of the height range, so damp ground only darkens and
 * the wettest level stands as water in the low parts (flat, near-mirror
 * smooth, darker still). Shader data only: a wetness paint uploads a grid and
 * rebuilds no mesh.
 */
import type { ProjectionOps } from './voxel-surface-projection';

/** Metres over which the higher of two meeting materials takes over (the height blend's contrast). */
export const HEIGHT_BLEND_CONTRAST_METRES = 0.01;
/** How much the wettest level darkens the albedo (a porous surface soaked). */
export const WET_DARKEN = 0.5;
/** How much standing water darkens it on top. */
export const WET_WATER_DARKEN = 0.2;
/** The share of a material's roughness the wettest level keeps. */
export const WET_ROUGHNESS_KEEP = 0.4;
/** The roughness of standing water. */
export const WET_WATER_ROUGHNESS = 0.03;
/** How far the wettest level flattens the normal detail toward the surface's own normal (water flattens it all). */
export const WET_FLATTEN = 0.4;
/** The water line at the wettest level, in the blended height's 0–1 (crevices below it stand under water). */
export const WET_FILL_MAX = 0.6;
/** The height range over which the water's edge fades in (its shore). */
export const WET_SHORE = 0.04;

/** The smallest depth a height is measured against (a material of no depth has no low parts). */
const MIN_DEPTH_METRES = 1e-5;

/** The scalar helpers the blend needs, from the projection's operations. */
function helpers<F, B>(o: ProjectionOps<F, B>) {
  const zero = o.num(0);
  const one = o.num(1);
  const min = (a: F, b: F): F => o.sub(zero, o.max(o.sub(zero, a), o.sub(zero, b)));
  const clamp01 = (x: F): F => min(o.max(x, zero), one);
  const mix = (a: F, b: F, t: F): F => o.add(a, o.mul(o.sub(b, a), t));
  return { zero, one, min, clamp01, mix };
}

/** Where two materials meet: the second's share by height, the blended surface's recess (metres) and height (0–1). */
export interface HeightBlend<F> {
  readonly share: F;
  readonly recess: F;
  readonly height: F;
}

/**
 * The height blend of material A (height `hA` 0–1, depth `dA` metres) and B (`hB`, `dB`) where B's share of the
 * cell blend is `share`: B's share by height, how far (metres) the blended surface lies below the plain one, and its
 * height in the blended depth's 0–1 (1: the surface, also where the materials have no depth).
 */
export function heightBlend<F, B>(o: ProjectionOps<F, B>, hA: F, dA: F, hB: F, dB: F, share: F): HeightBlend<F> {
  const { one, clamp01, mix } = helpers(o);
  const w = o.num(HEIGHT_BLEND_CONTRAST_METRES);
  // Each surface's level (metres, ≤ 0) raised by its share weighted past the deeper depth.
  const span = o.add(o.max(dA, dB), w);
  const sA = o.add(o.mul(o.sub(hA, one), dA), o.mul(o.sub(one, share), span));
  const sB = o.add(o.mul(o.sub(hB, one), dB), o.mul(share, span));
  const top = o.sub(o.max(sA, sB), w);
  const wA = o.max(o.sub(sA, top), o.num(0));
  const wB = o.max(o.sub(sB, top), o.num(0));
  const s = clamp01(o.div(wB, o.max(o.add(wA, wB), o.num(1e-6))));
  const recess = mix(o.mul(o.sub(one, hA), dA), o.mul(o.sub(one, hB), dB), s);
  const depth = o.max(mix(dA, dB, s), o.num(MIN_DEPTH_METRES));
  return { share: s, recess, height: clamp01(o.sub(one, o.div(recess, depth))) };
}

/** What wetness does to a pixel: albedo and roughness multipliers, the standing water's share, the normal's flattening. */
export interface WetLook<F> {
  /** The albedo's multiplier. */
  readonly albedo: F;
  /** The roughness's multiplier before the water (the water's own roughness mixes in by `water`). */
  readonly roughness: F;
  /** 0 … 1: how much of the pixel stands under water. */
  readonly water: F;
  /** 0 … 1: how far the normal detail goes toward the surface's own normal. */
  readonly flatten: F;
}

/** What wetness `wet` (0 … 1) does to a pixel whose blended height is `height` (0–1). */
export function wetLook<F, B>(o: ProjectionOps<F, B>, wet: F, height: F): WetLook<F> {
  const { one, clamp01 } = helpers(o);
  const line = o.mul(o.mul(wet, wet), o.num(WET_FILL_MAX));
  // Under the line by more than the shore: water; a pixel exactly at it: none (dry ground at level 0 never floods).
  const water = clamp01(o.div(o.sub(line, height), o.num(WET_SHORE)));
  return {
    albedo: o.mul(o.sub(one, o.mul(wet, o.num(WET_DARKEN))), o.sub(one, o.mul(water, o.num(WET_WATER_DARKEN)))),
    roughness: o.sub(one, o.mul(wet, o.num(1 - WET_ROUGHNESS_KEEP))),
    water,
    flatten: clamp01(o.add(o.mul(wet, o.num(WET_FLATTEN)), water)),
  };
}
