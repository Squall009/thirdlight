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
 * How the occlusion reaches every lit material: as a light. A
 * `ScreenSpaceOcclusion` light in the scene (one per environment renderer,
 * there while its stack draws AO: with AO off no lit pixel samples its
 * history) has a light node that multiplies
 * the context's `ambientOcclusion` by the occlusion — what three's `AONode`
 * does for a material's AO map. three's own route, `builtinAOContext` on the
 * scene pass, marks every material as holding nodes, so every object's
 * uniforms were written again each frame (the village class: 187 buffer
 * writes a frame instead of 84, +0.5 ms on WebGL 2). A light changes only the
 * lights' program key, once, and costs nothing per object.
 *
 * The occlusion a frame draws with is the previous frame's, reprojected: a
 * pixel finds where its surface was on the last frame's screen (the last
 * camera's matrices) and takes the occlusion stored there if the depth there
 * matches (else none: a surface just uncovered gets no occlusion for a
 * frame). The alternative, a depth-and-normals prepass before the scene
 * pass, draws every object twice: on a CPU-bound integrated-GPU game the
 * draw calls are what the frame is short of. A moving object's own creases
 * lag one frame behind it, which a half-resolution, blurred AO hides.
 *
 * Transparent materials take no occlusion (three's rule: they write no depth
 * the occlusion was computed from).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { ao as gtao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { ssao } from 'three/examples/jsm/tsl/display/SSAONode.js';

import { decalDrawOf } from './mesh-decals';

/** TSL nodes are loosely typed here (three's node typings are generic-heavy). */
type N = any;
const TSL: N = TSLTyped;
const { abs, float, Fn, logarithmicDepthToViewZ, mix, positionView, renderGroup, rtt, select, texture, uniform, vec2, vec4 } = TSL;

/** Resolution of the ambient-occlusion pass relative to the scene pass: occlusion is low-frequency, half resolution is a quarter of the cost. */
export const AO_RESOLUTION_SCALE = 0.5;
/**
 * How far a pixel's depth (a share of it, plus a few centimetres) may be
 * from the depth its occlusion was computed at on the last frame and still
 * take it: wide enough for a half-resolution sample on a slanted floor,
 * narrow enough that an object in front of a wall never takes the wall's.
 */
export const AO_HISTORY_DEPTH_TOLERANCE = 0.06;
const AO_HISTORY_DEPTH_SLACK_M = 0.05;
/**
 * three's SSAO strength (its `intensity`) that makes it darken a crease about
 * as much as GTAO does at the same radius (measured on the environment
 * harness's contact shadows: at 1 it is about a fifth of GTAO's darkening).
 */
export const SSAO_STRENGTH = 3;

export type AoKind = 'ssao' | 'gtao';

/**
 * The occlusion as a light of the scene (only its node knows it). Its
 * uniforms are per render: the stack drawing the scene sets them before its
 * scene pass and turns them off after, so any other draw of the scene (a
 * capture, a stack without AO) takes no occlusion.
 */
export class ScreenSpaceOcclusion extends THREE.Light {
  readonly isScreenSpaceOcclusion = true;
  /** From this frame's view space to the last frame's view and clip space (the pixel's view position is at hand in every lit material). */
  readonly toLastView: N = uniform(new THREE.Matrix4()).setGroup(renderGroup);
  readonly toLastClip: N = uniform(new THREE.Matrix4()).setGroup(renderGroup);
  /** 1 while a stack with AO draws the scene and the history holds a frame. */
  readonly active: N = uniform(0).setGroup(renderGroup);
  readonly intensity: N = uniform(1).setGroup(renderGroup);
  /**
   * The history: occlusion (x) and view depth (y) of the last frame. One
   * target for the light's life, which every stack draws into: a texture node
   * whose texture is swapped for another after the lit programs bound it kept
   * reading the first one's destroyed GPU texture on WebGPU (no occlusion at
   * all); a target's resize is followed by three.
   */
  readonly historyTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  readonly history: N = texture(this.historyTarget.texture);
  /** The target was made on the GPU as a render target (`buildAmbientOcclusion`). */
  initialized = false;
  /**
   * The history's size, as a shadow map's: resizing the target recreates its
   * GPU texture, and three refreshes the bindings of objects whose materials
   * hold no nodes only when a light's shadow map size changes (lit programs
   * would keep the destroyed texture). No shadow is drawn: the light's node
   * is not an analytic light's.
   */
  readonly shadow = { mapSize: new THREE.Vector2(1, 1) } as unknown as THREE.LightShadow;

  constructor() {
    super(0xffffff, 1);
    this.castShadow = true;
    this.name = 'ambient occlusion';
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
  }

  override dispose(): void {
    this.historyTarget.dispose();
    super.dispose();
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
    // A mesh decal lies on the surface the history saw, so it takes that surface's occlusion; other see-through surfaces do not.
    if (builder.material?.transparent === true && decalDrawOf(builder.material) === null) return;
    const l = this.light;
    const occlusion = Fn(() => {
      const p = vec4(positionView, 1);
      const view = l.toLastView.mul(p).xyz.toVar();
      const clip = l.toLastClip.mul(p).toVar();
      const at = clip.xy.div(clip.w).mul(vec2(0.5, -0.5)).add(0.5).toVar();
      const h = l.history.sample(at).toVar();
      const onScreen = at.x.greaterThanEqual(0).and(at.x.lessThanEqual(1)).and(at.y.greaterThanEqual(0)).and(at.y.lessThanEqual(1));
      const same = abs(h.y.sub(view.z)).lessThan(abs(view.z).mul(AO_HISTORY_DEPTH_TOLERANCE).add(AO_HISTORY_DEPTH_SLACK_M));
      const taken = select(onScreen.and(same).and(l.active.greaterThan(0.5)), h.x, float(1));
      return mix(float(1), taken, l.intensity);
    })();
    builder.context.ambientOcclusion.mulAssign(occlusion);
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
  const viewZ: N = Fn((_: unknown, builder: N) => (builder.renderer.logarithmicDepthBuffer === true ? logarithmicDepthToViewZ(depth, scenePass._cameraNear, scenePass._cameraFar) : scenePass.getViewZNode()))();
  const history: N = rtt(vec4(node.getTextureNode().r, viewZ, 0, 1), null, null, { type: THREE.HalfFloatType, resolutionScale: AO_RESOLUTION_SCALE });
  // It draws into the light's target (see `ScreenSpaceOcclusion.historyTarget`).
  const own = history.renderTarget as THREE.RenderTarget;
  history.renderTarget = light.historyTarget;
  history.value = light.historyTarget.texture;
  own.dispose();
  const lastView = new THREE.Matrix4();
  const lastViewProjection = new THREE.Matrix4();
  const size = new THREE.Vector2();
  let share = AO_RESOLUTION_SCALE;
  let drawn = false;
  return {
    passes: history,
    setScale(sceneScale) {
      share = AO_RESOLUTION_SCALE * sceneScale;
      node.resolutionScale = share;
      history.setResolutionScale(share);
    },
    beforeFrame(cam) {
      // The history at this frame's size before the scene pass binds it (the history pass would resize it after).
      renderer.getDrawingBufferSize(size);
      const w = Math.max(1, Math.floor(size.x * share));
      const h = Math.max(1, Math.floor(size.y * share));
      if (light.historyTarget.width !== w || light.historyTarget.height !== h || !light.initialized) {
        light.historyTarget.setSize(w, h);
        light.shadow.mapSize.set(w, h);
        // Made as a render target now: a texture first made for sampling (the lit programs bind it before the
        // history pass first draws) is made again as an attachment, and the programs keep the destroyed one.
        renderer.initRenderTarget(light.historyTarget);
        light.initialized = true;
        drawn = false;
      }
      light.intensity.value = params.intensity;
      light.toLastView.value.multiplyMatrices(lastView, cam.matrixWorld);
      light.toLastClip.value.multiplyMatrices(lastViewProjection, cam.matrixWorld);
      light.active.value = drawn ? 1 : 0;
    },
    afterFrame(cam) {
      light.active.value = 0;
      lastView.copy(cam.matrixWorldInverse);
      lastViewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      drawn = true;
    },
    dispose() {
      light.active.value = 0;
      node.dispose();
      // The light keeps its target and texture (the next stack draws into them): the node disposes its own.
      history.renderTarget = own;
      history.value = own.texture;
      history.dispose();
    },
  };
}
