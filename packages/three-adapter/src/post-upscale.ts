/**
 * Render scale: the post stack drawn at a share of the screen's resolution
 * and upscaled to it with AMD FidelityFX Super Resolution 1 (three's
 * `FSR1Node`: EASU, an edge-adaptive Lanczos upscale, then RCAS, contrast-
 * adaptive sharpening).
 *
 * Everything up to and including anti-aliasing runs at the scale — the
 * scene pass, ambient occlusion, depth of field, bloom, tone mapping and
 * grading — so their cost shrinks with the pixels, and FSR 1 gets what AMD
 * asks of its input: an anti-aliased picture in display (perceptual) space.
 * The upscale is the last step, as in Unity URP's final pass.
 *
 * The scale changes in place (dynamic resolution): every target follows it
 * at its next frame, no node is rebuilt and no program compiled. At scale 1
 * the FSR passes are skipped and the scaled picture is put out as it is.
 */
import * as THREE from 'three';
import { rtt, select, uniform } from 'three/tsl';
import { fsr1 } from 'three/examples/jsm/tsl/display/FSR1Node.js';

/** TSL nodes are loosely typed here (three's node typings are generic-heavy). */
type N = any;

/** RCAS sharpening (0 strongest, 2 none): AMD's default for upscaled input. */
export const FSR_SHARPNESS = 0.2;

/** How the scaled picture reaches the screen: FSR 1, or plain bilinear filtering (a diagnostic comparison, `?upscale=bilinear`). */
export type UpscaleFilter = 'fsr1' | 'bilinear';

/** The page flag that upscales with bilinear filtering instead of FSR 1 (a diagnostic comparison). */
export const UPSCALE_URL_PARAM = 'upscale';

/** The upscale filter a page's query string asks for (FSR 1 unless `upscale=bilinear`). */
export function upscaleFilterFromUrl(search: string): UpscaleFilter {
  return new URLSearchParams(search).get(UPSCALE_URL_PARAM) === 'bilinear' ? 'bilinear' : 'fsr1';
}

/** A node drawn into a target at the scale (its own pass), as a texture node later passes sample. */
export interface ScaledTexture {
  readonly node: N;
  setScale(scale: number): void;
  dispose(): void;
}

export function scaledTexture(color: N, scale: number): ScaledTexture {
  const node: N = rtt(color, null, null, { type: THREE.HalfFloatType, resolutionScale: scale });
  return {
    node,
    setScale: (s) => node.setResolutionScale(s),
    dispose: () => node.dispose(),
  };
}

export interface UpscaleStage {
  /** The picture at the screen's resolution. */
  readonly output: N;
  setScale(scale: number): void;
  dispose(): void;
}

/** Upscale `low` (a texture node of the scaled picture) to the drawing buffer. */
export function buildUpscale(low: N, filter: UpscaleFilter, scale: number): UpscaleStage {
  if (filter === 'bilinear') return { output: low, setScale: () => undefined, dispose: () => undefined };
  const active = uniform(scale < 1 ? 1 : 0);
  const node: N = fsr1(low, uniform(FSR_SHARPNESS));
  // At scale 1 nothing is upscaled: its two passes are skipped (the output takes the picture as it is).
  const run = node.updateBefore.bind(node) as (frame: unknown) => void;
  node.updateBefore = (frame: unknown): void => {
    if (active.value > 0.5) run(frame);
  };
  return {
    output: select(active.greaterThan(0.5), node, low),
    setScale(s) {
      active.value = s < 1 ? 1 : 0;
    },
    dispose: () => node.dispose(),
  };
}

/**
 * Size a three display node's own targets (one that sizes them from the
 * drawing buffer, like SMAA) at the scale instead: it then works on the
 * scaled picture at its own resolution.
 */
export function atScale(node: N, scale: () => number): N {
  const setSize = node.setSize.bind(node) as (w: number, h: number) => void;
  node.setSize = (w: number, h: number): void => setSize(Math.max(1, Math.floor(w * scale())), Math.max(1, Math.floor(h * scale())));
  return node;
}
