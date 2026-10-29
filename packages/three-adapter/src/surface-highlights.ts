/**
 * Highlights on the surfaces that read the surface cache: the shared parts.
 *
 * The cache holds diffuse light only. A reading pixel's highlights stay per
 * pixel: point, spot and area lights alike through the light clusters' loop
 * (`cluster-lights.ts`, area lights with three's rectangle-light maths in
 * `cluster-area.ts`), three's own nodes for the lights that still have their
 * own shadow map; their diffuse light is the cache's (`buildReadLights`,
 * `surface-cache-read.ts`).
 *
 * - **A line light** is drawn as a strip `LINE_HIGHLIGHT_METRES` wide along
 *   its length (LTC integrates polygons; a thin rectangle is the nearest
 *   one), its radiance its intensity over the strip's area: right along its
 *   facing, dimmer than the cache's isotropic line toward grazing.
 * - **Shadowing: the cache's visibility, as a ratio.** The cache's texel
 *   already holds the traced, soft-shadowed light of those lights. A pixel
 *   compares it with the unshadowed diffuse light the same lights give it
 *   per pixel: their ratio is the share of the lights the texel sees, and
 *   every highlight is scaled by it (the ratio estimator of Heitz et al.,
 *   "Combining analytic direct illumination and stochastic shadows", 2018).
 *   No memory per light and no extra ray: one division a pixel. It is one
 *   share for all of them (a pixel in one lamp's shadow and another's light
 *   takes the mean) and it clamps at 1 where the cache holds light the pixel
 *   does not shade (glowing surfaces).
 * - **Glowing surfaces** light the cache as area lights of their own and
 *   give no highlight (reflections show them): they are never listed.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';

const TSL: N = TSLTyped;
const { clamp, float, luminance, max, select } = TSL;

/** The width a line light's highlight is drawn with (m). */
export const LINE_HIGHLIGHT_METRES = 0.02;
/** A glowing surface's cache lights carry this in their id (they give no highlight). */
export const GLOW_LIGHT_MARK = '#glow';
/** The albedo luminance below which a pixel's per-pixel diffuse light is not turned back into irradiance (it is all but nothing there). */
const DARK_ALBEDO = 0.02;

/** Whether a build shades highlights (three's physical lighting: standard, physical, graph and layered materials). */
export function buildsHighlights(builder: N): boolean {
  return builder.context?.lightingModel instanceof THREE.PhysicalLightingModel;
}

/**
 * The share of the lights a reading pixel shades per pixel that its cache
 * texel sees (0–1): the cache's irradiance (÷ π, the sun's share out) over
 * the same lights' unshadowed irradiance here (their diffuse light over the
 * albedo).
 */
export function cacheVisibility(cacheIrradiance: N, localDiffuse: N, albedo: N): N {
  const a = luminance(albedo);
  const unshadowed = select(a.greaterThan(DARK_ALBEDO), luminance(localDiffuse).div(max(a, float(DARK_ALBEDO))), float(0));
  return clamp(luminance(cacheIrradiance).div(max(unshadowed, float(1e-6))), float(0), float(1));
}
