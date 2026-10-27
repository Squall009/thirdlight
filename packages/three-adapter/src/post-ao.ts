/**
 * Ambient occlusion on the indirect light only.
 *
 * Screen-space AO (three's SSAO or GTAO node) needs the frame's depth and
 * normals, so it is known only after the scene is drawn. Multiplying the
 * finished picture by it (what the post stack did before) also dims the sun
 * and lamps, which real occlusion of sky and bounce light never does: a
 * sunlit wall's foot went grey. Here every lit material instead takes the
 * occlusion into its indirect light: the lighting models multiply the
 * ambient, sky, probe and reflection terms by the lighting context's
 * `ambientOcclusion`, never the direct ones.
 *
 * How the occlusion reaches every lit material: as the last frame's
 * history, reprojected (`screen-history.ts`), in a `ScreenSpaceOcclusion`
 * light of the scene (one per environment renderer, there while its stack
 * draws AO), whose light node multiplies the context's `ambientOcclusion` by
 * it — what three's `AONode` does for a material's AO map. A moving object's
 * own creases lag one frame behind it, which a half-resolution, blurred AO
 * hides.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { ao as gtao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { ssao } from 'three/examples/jsm/tsl/display/SSAONode.js';

import { buildScreenHistory, scenePassViewZ, ScreenHistoryLight, screenHistoryAt, takesScreenHistory } from './screen-history';

/** TSL nodes are loosely typed here (three's node typings are generic-heavy). */
type N = any;
const TSL: N = TSLTyped;
const { float, mix, renderGroup, uniform } = TSL;

/** Resolution of the ambient-occlusion pass relative to the scene pass: occlusion is low-frequency, half resolution is a quarter of the cost. */
export const AO_RESOLUTION_SCALE = 0.5;
/**
 * three's SSAO strength (its `intensity`) that makes it darken a crease about
 * as much as GTAO does at the same radius (measured on the environment
 * harness's contact shadows: at 1 it is about a fifth of GTAO's darkening).
 */
export const SSAO_STRENGTH = 3;

export type AoKind = 'ssao' | 'gtao';

/** The occlusion as a light of the scene (only its node knows it). */
export class ScreenSpaceOcclusion extends ScreenHistoryLight {
  readonly isScreenSpaceOcclusion = true;
  readonly intensity: N = uniform(1).setGroup(renderGroup);

  constructor() {
    super('ambient occlusion');
  }
}

/** The occlusion light's node: multiplies the lighting context's ambient occlusion (opaque materials and mesh decals only). */
class ScreenSpaceOcclusionNode extends (THREE.LightingNode as unknown as new () => { [k: string]: unknown }) {
  static get type(): string {
    return 'ScreenSpaceOcclusionNode';
  }

  constructor(readonly light: ScreenSpaceOcclusion) {
    super();
  }

  setup(builder: N): void {
    if (!takesScreenHistory(builder)) return;
    const l = this.light;
    builder.context.ambientOcclusion.mulAssign(mix(float(1), screenHistoryAt(l), l.intensity));
  }
}

/** Teach a renderer the occlusion light. */
export function registerScreenSpaceOcclusion(renderer: { library: { addLight(node: unknown, light: unknown): void } }): void {
  renderer.library.addLight(ScreenSpaceOcclusionNode, ScreenSpaceOcclusion);
}

export interface AmbientOcclusionStage {
  /** The node that runs the AO and history passes each frame (built into the pipeline's output). */
  readonly passes: N;
  /** The scene pass's resolution scale (the AO follows it at its own share). */
  setScale(sceneScale: number): void;
  /** Before a frame is drawn with `camera`: the light reads the last frame's history, seen from the last frame's camera. */
  beforeFrame(camera: THREE.Camera): void;
  /** After a frame is drawn with `camera`: its occlusion is the next frame's history. */
  afterFrame(camera: THREE.Camera): void;
  dispose(): void;
}

/**
 * The AO of a scene pass drawn with an MRT holding `normal` (view-space
 * normals), fed to `light`. `intensity` 0–n mixes the occlusion in (1: as computed).
 */
export function buildAmbientOcclusion(renderer: THREE.WebGPURenderer, kind: AoKind, scenePass: N, camera: THREE.Camera, light: ScreenSpaceOcclusion, params: { radius: number; intensity: number }): AmbientOcclusionStage {
  const depth: N = scenePass.getTextureNode('depth');
  const normal: N = scenePass.getTextureNode('normal');
  const node: N = kind === 'gtao' ? gtao(depth, normal, camera) : ssao(depth, normal, camera);
  node.radius.value = params.radius;
  // SSAO's obscurance is much fainter than GTAO's for the same crease: scaled so the two kinds darken alike.
  if (kind === 'ssao') node.intensity.value = SSAO_STRENGTH;
  node.resolutionScale = AO_RESOLUTION_SCALE;
  // The history: this frame's occlusion and view depth, kept for the next frame's scene pass (which overwrites the depth).
  const history = buildScreenHistory(renderer, light, node.getTextureNode().r, scenePassViewZ(scenePass), AO_RESOLUTION_SCALE);
  return {
    passes: history.passes,
    setScale(sceneScale) {
      const share = AO_RESOLUTION_SCALE * sceneScale;
      node.resolutionScale = share;
      history.setShare(share);
    },
    beforeFrame(cam) {
      light.intensity.value = params.intensity;
      history.beforeFrame(cam);
    },
    afterFrame(cam) {
      history.afterFrame(cam);
    },
    dispose() {
      node.dispose();
      history.dispose();
    },
  };
}
