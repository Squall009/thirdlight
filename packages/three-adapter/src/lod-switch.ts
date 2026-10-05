/**
 * Which level of detail a `THREE.LOD` draws, picked outside three.js.
 *
 * three's own LOD keeps every level attached and hides the ones it does not
 * draw, so all of them stay in the graph it walks each frame. The render
 * graph keeps a LOD as data instead (never in the scene) and attaches only
 * the level this picks. The pick is three's `LOD.update` rule — the same
 * switch distances, the same hysteresis, the camera's distance divided by
 * its zoom — with "the level drawn last frame" kept as a number rather than
 * read back from the levels' `visible` flags.
 */
import type * as THREE from 'three';

/**
 * `lod.userData[LOD_LEVEL_KEY]`: the level the render graph attached last
 * (diagnostics read it where three's `getCurrentLevel` is never updated).
 */
export const LOD_LEVEL_KEY = '__tlLodLevel';

/**
 * `mesh.userData[LOD_OWNER_KEY]`: the LOD a drawable is a level of (its
 * nearest one), set by the render graph while it holds the LOD — static
 * batching copies every level of it together.
 */
export const LOD_OWNER_KEY = '__tlLodOwner';

/**
 * The level to draw at `distance` (camera to LOD, divided by the camera's
 * zoom). `current`: the level drawn last frame, or -1 before the first pick
 * (three starts with every level visible, so hysteresis then applies to all).
 */
export function pickLodLevel(levels: readonly { readonly distance: number; readonly hysteresis: number }[], distance: number, current: number): number {
  if (levels.length <= 1) return 0;
  let i = 1;
  for (; i < levels.length; i += 1) {
    const level = levels[i]!;
    let switchAt = level.distance;
    if (current < 0 || current === i) switchAt -= switchAt * level.hysteresis;
    if (distance < switchAt) break;
  }
  return i - 1;
}

/** The level a LOD drew last: the render graph's pick, or three's own where three updates it. */
export function currentLodLevel(lod: THREE.LOD): number {
  const ours = lod.userData[LOD_LEVEL_KEY] as number | undefined;
  return ours !== undefined && ours >= 0 ? ours : lod.getCurrentLevel();
}
