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
import { LOD_BIAS_DEFAULT, LOD_HYSTERESIS_DEFAULT, type LodTuningSettings } from '@thirdlight/runtime';

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
 * (three starts with every level visible, so a level's own hysteresis then
 * applies to all). `hysteresis`: the project's margin, a fraction of the
 * switch distance a shown level switches back to the finer one by.
 */
export function pickLodLevel(levels: readonly { readonly distance: number; readonly hysteresis: number }[], distance: number, current: number, hysteresis = 0): number {
  if (levels.length <= 1) return 0;
  let i = 1;
  for (; i < levels.length; i += 1) {
    const level = levels[i]!;
    let switchAt = level.distance;
    // three's own per-level margin (also on the first pick, as three applies it); the project's only once a level
    // is shown: it switches back to the finer one that much closer.
    let margin = current < 0 || current === i ? level.hysteresis : 0;
    if (current === i && hysteresis > margin) margin = hysteresis;
    switchAt -= switchAt * margin;
    if (distance < switchAt) break;
  }
  return i - 1;
}

/**
 * `level.object.userData[LOD_CULL_LEVEL_KEY]`: the level is the model's cull
 * size — past it nothing is drawn (an empty level). Block layers, which draw
 * many models as one chunk, stop before it.
 */
export const LOD_CULL_LEVEL_KEY = '__tlLodCull';

/**
 * `lod.userData[LOD_MODEL_SCALE_KEY]`: the scale of the model's own nodes above
 * a LOD made from its `_LOD<n>` nodes (an FBX unit node of 0.01, say). Its
 * switch distances come from a radius measured with those scales already in,
 * so a pick divides the camera distance only by the scale on top of them (the
 * object's, as an instance-set copy does), not by that one again.
 */
export const LOD_MODEL_SCALE_KEY = '__tlLodModelScale';

/** `scene.userData[LOD_TUNING_KEY]`: the adapter's {@link LodTuning} (its frame's switch counts for tools reading the scene). */
export const LOD_TUNING_KEY = 'tlLodTuning';

/**
 * The project's LOD bias and hysteresis as the picks read them (one object
 * per adapter, shared by the render graph's LODs and the instance sets'
 * copies), and the switches the last frame made (diagnostics).
 */
export class LodTuning {
  bias = LOD_BIAS_DEFAULT;
  hysteresis = LOD_HYSTERESIS_DEFAULT;
  /** Changes with the bias or hysteresis: picks made under another revision are made again. */
  revision = 0;
  /** Placed models' LODs that changed level in the frame (since `beginFrame`). */
  switches = 0;
  /** Instance-set copies that changed level in the frame. */
  copySwitches = 0;

  /** Take new settings; true when they changed a pick input. */
  set(t: Partial<LodTuningSettings>): boolean {
    const bias = t.bias !== undefined && Number.isFinite(t.bias) && t.bias > 0 ? t.bias : this.bias;
    const hysteresis = t.hysteresis !== undefined && Number.isFinite(t.hysteresis) && t.hysteresis >= 0 ? t.hysteresis : this.hysteresis;
    if (bias === this.bias && hysteresis === this.hysteresis) return false;
    this.bias = bias;
    this.hysteresis = hysteresis;
    this.revision += 1;
    return true;
  }

  beginFrame(): void {
    this.switches = 0;
    this.copySwitches = 0;
  }
}

/** The level a LOD drew last: the render graph's pick, or three's own where three updates it. */
export function currentLodLevel(lod: THREE.LOD): number {
  const ours = lod.userData[LOD_LEVEL_KEY] as number | undefined;
  return ours !== undefined && ours >= 0 ? ours : lod.getCurrentLevel();
}
