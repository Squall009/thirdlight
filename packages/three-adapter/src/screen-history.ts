/**
 * A screen-space result of the last frame that this frame's lit materials
 * read: ambient occlusion (`post-ao.ts`) and contact shadows
 * (`post-contact-shadows.ts`) are known only once the scene pass drew its
 * depth, so each is kept as a history and read on the next frame.
 *
 * - **Where it is kept: a light of the scene.** A light changes only the
 *   lights' program key, once, and costs nothing per object; three's own
 *   route (`builtinAOContext` on the scene pass) marks every material as
 *   holding nodes, so every object's uniforms were written again each frame
 *   (the village class: +0.5 ms on WebGL 2). With the light out of the
 *   scene no lit pixel samples its history.
 * - **How a pixel reads it: reprojected.** A pixel finds where its surface
 *   was on the last frame's screen (the last camera's matrices) and takes
 *   the value stored there if the depth there matches (else the result's
 *   neutral value, 1: a surface just uncovered gets none for a frame). The
 *   alternative, a depth prepass before the scene pass, draws every object
 *   twice: on a CPU-bound integrated-GPU game the draw calls are what the
 *   frame is short of. A moving object's own result lags a frame behind it.
 *
 * Transparent materials take none (three's rule: they write no depth the
 * result was computed from); a mesh decal takes the surface's under it.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { decalDrawOf } from './mesh-decals';
import { untransformedTexture } from './texel-texture-node';

const TSL: N = TSLTyped;
const { abs, float, Fn, logarithmicDepthToViewZ, positionView, renderGroup, rtt, select, uniform, vec2, vec4 } = TSL;

/**
 * How far a pixel's depth (a share of it, plus a few centimetres) may be
 * from the depth its result was computed at on the last frame and still
 * take it: wide enough for a half-resolution sample on a slanted floor,
 * narrow enough that an object in front of a wall never takes the wall's.
 */
export const HISTORY_DEPTH_TOLERANCE = 0.06;
/** Metres of depth difference always taken (near the camera the tolerance's share is too thin to hold a still sample). */
export const HISTORY_DEPTH_SLACK_M = 0.05;

/**
 * The history's light. Its uniforms are per render: the stack drawing the
 * scene sets them before its scene pass and turns them off after, so any
 * other draw of the scene (a capture, a stack without the result) takes none.
 */
export class ScreenHistoryLight extends THREE.Light {
  /** From this frame's view space to the last frame's view and clip space (the pixel's view position is at hand in every lit material). */
  readonly toLastView: N = uniform(new THREE.Matrix4()).setGroup(renderGroup);
  readonly toLastClip: N = uniform(new THREE.Matrix4()).setGroup(renderGroup);
  /** 1 while a stack with the result draws the scene and the history holds a frame. */
  readonly active: N = uniform(0).setGroup(renderGroup);
  /**
   * The history: the result (x) and view depth (y) of the last frame. One
   * target for the light's life, which every stack draws into: a texture node
   * whose texture is swapped for another after the lit programs bound it kept
   * reading the first one's destroyed GPU texture on WebGPU; a target's
   * resize is followed by three.
   */
  readonly historyTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  /** Read without three's texture transform (it would cost every lit draw a uniform and a matrix update). */
  readonly history: N = untransformedTexture(this.historyTarget.texture);
  /** The target was made on the GPU as a render target (`buildScreenHistory`). */
  initialized = false;
  /**
   * The history's size, as a shadow map's: resizing the target recreates its
   * GPU texture, and three refreshes the bindings of objects whose materials
   * hold no nodes only when a light's shadow map size changes (lit programs
   * would keep the destroyed texture). No shadow is drawn: the light's node
   * is not an analytic light's.
   */
  readonly shadow = { mapSize: new THREE.Vector2(1, 1) } as unknown as THREE.LightShadow;

  constructor(name: string) {
    super(0xffffff, 1);
    this.castShadow = true;
    this.name = name;
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
  }

  override dispose(): void {
    this.historyTarget.dispose();
    super.dispose();
  }
}

/** Whether a build takes a screen history (opaque materials and mesh decals). */
export function takesScreenHistory(builder: N): boolean {
  return !(builder.material?.transparent === true && decalDrawOf(builder.material) === null);
}

/** The light's last-frame result where this pixel's surface was (1 where none holds). */
export function screenHistoryAt(l: ScreenHistoryLight): N {
  return Fn(() => {
    const p = vec4(positionView, 1);
    const view = l.toLastView.mul(p).xyz.toVar();
    const clip = l.toLastClip.mul(p).toVar();
    const at = clip.xy.div(clip.w).mul(vec2(0.5, -0.5)).add(0.5).toVar();
    const h = l.history.sample(at).toVar();
    const onScreen = at.x.greaterThanEqual(0).and(at.x.lessThanEqual(1)).and(at.y.greaterThanEqual(0)).and(at.y.lessThanEqual(1));
    const same = abs(h.y.sub(view.z)).lessThan(abs(view.z).mul(HISTORY_DEPTH_TOLERANCE).add(HISTORY_DEPTH_SLACK_M));
    return select(onScreen.and(same).and(l.active.greaterThan(0.5)), h.x, float(1));
  })();
}

/** The scene pass's view depth at each of its pixels (a logarithmic depth buffer's turned back). */
export function scenePassViewZ(scenePass: N): N {
  const depth: N = scenePass.getTextureNode('depth');
  return Fn((_: unknown, builder: N) => (builder.renderer.logarithmicDepthBuffer === true ? logarithmicDepthToViewZ(depth, scenePass._cameraNear, scenePass._cameraFar) : scenePass.getViewZNode()))();
}

export interface ScreenHistoryStage {
  /** The node that draws this frame's result into the history (built into the pipeline's output). */
  readonly passes: N;
  /** The history's share of the screen's resolution. */
  setShare(share: number): void;
  /** Before a frame is drawn with `camera`: the light reads the last frame's history, seen from the last frame's camera. */
  beforeFrame(camera: THREE.Camera): void;
  /** After a frame is drawn with `camera`: its result is the next frame's history. */
  afterFrame(camera: THREE.Camera): void;
  dispose(): void;
}

/** `value` (and the pixel's `viewZ`), each frame after the scene pass, at `share` of the screen's resolution, into `light`'s history. */
export function buildScreenHistory(renderer: THREE.WebGPURenderer, light: ScreenHistoryLight, value: N, viewZ: N, share: number): ScreenHistoryStage {
  const history: N = rtt(vec4(value, viewZ, 0, 1), null, null, { type: THREE.HalfFloatType, resolutionScale: share });
  // It draws into the light's target (see `ScreenHistoryLight.historyTarget`).
  const own = history.renderTarget as THREE.RenderTarget;
  history.renderTarget = light.historyTarget;
  history.value = light.historyTarget.texture;
  own.dispose();
  const lastView = new THREE.Matrix4();
  const lastViewProjection = new THREE.Matrix4();
  const size = new THREE.Vector2();
  let drawn = false;
  return {
    passes: history,
    setShare(next) {
      share = next;
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
      // The light keeps its target and texture (the next stack draws into them): the node disposes its own.
      history.renderTarget = own;
      history.value = own.texture;
      history.dispose();
    },
  };
}
