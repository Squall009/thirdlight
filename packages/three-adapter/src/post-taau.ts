/**
 * Temporal upscaling: the post stack's picture at the render scale (dynamic
 * resolution included) resolved over frames into the screen's resolution on
 * three's `TAAUNode` — the camera jittered by a sub-pixel Halton offset each
 * frame, each output pixel rebuilt from the nearest input samples and the
 * reprojected history (motion vectors from the scene pass,
 * `motion-vectors.ts`), the history clipped to the neighbourhood's colours.
 * It anti-aliases and upscales in one pass, in place of SMAA or FXAA and
 * FSR 1.
 *
 * Three's node keeps the jitter, the history and resolve targets, the seed
 * after a resize and the history copy; the resolve itself is this module's:
 * three's reads the depth at nine taps and the last frame's depth (a copy of
 * the whole depth buffer each frame, three matrix products a pixel) to find
 * disocclusions, which cost about 2.1 ms a 1080p frame on the Iris Xe. Here
 * the motion is taken at the nearest of five depth taps and disocclusion is
 * left to the neighbourhood clip, as Unreal's TAA does (Karis 2014): a
 * surface just uncovered takes its own colours within a frame or two.
 *
 * It resolves the display picture (after tone mapping and grading), where
 * the upscale stood before: every pass up to it keeps running at the scale,
 * and the clip works on the colours the player sees, which keeps bright
 * highlights from ringing. Unreal and Unity resolve before their bloom and
 * tone mapping; here that would draw bloom, depth of field and grading at
 * the output's resolution.
 *
 * A still view settles to one picture: once the camera has stood still for
 * {@link TAAU_HOLD_FRAMES} frames the jitter stops, and an output pixel whose
 * nearest input samples are the same as the last frame's keeps the picture
 * it shows (the history) instead of resolving again. Anything that changes
 * (a moving object, a light switched, the surface light settling) resolves
 * as before; a moving camera starts the jitter again. A view where
 * something moves by itself (wind, water, an animated material) never holds:
 * its moving pixels would lose the jitter's anti-aliasing. Without the hold
 * the jitter would keep a still frame changing in its last bit for ever.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import TAAUNode from 'three/examples/jsm/tsl/display/TAAUNode.js';

import type { N } from './effects-tsl';
import { motionFrameSeconds, setMotionCamera } from './motion-vectors';

const TSL: N = TSLTyped;
const { Fn, If, abs, clamp, exp, float, ivec2, luminance, max, min, mix, select, texture, uniform, uv, vec2, vec3, vec4 } = TSL;

/**
 * Frames the camera must stand still before the picture holds: the history
 * then keeps under 5 % of what it held while the camera moved (it takes
 * {@link TAAU_CURRENT_WEIGHT} of each new frame).
 */
export const TAAU_HOLD_FRAMES = 120;

/** The share of a new frame in a still pixel's history (three's TAAU default: more frames fill in the upscaled detail). */
export const TAAU_CURRENT_WEIGHT = 0.025;

/** The Halton offsets three's TAAU node steps through (its `computeHaltonOffsets(32)`). */
const JITTER_PHASES = 32;

/** How far (display colour) a held pixel's history may lie outside its nearest samples' colours: a step of 8 bits. */
const HOLD_SLACK = 1 / 255;

/** Motion (input pixels a frame) from which a pixel takes the new frame whole and the clip is at its tightest (three's default). */
const MAX_MOTION_PX = 128;

/** The page flag for comparisons: `?taau=0` draws SMAA where the temporal upscale would run, `?taau=motion` shows the motion vectors. */
export const TAAU_URL_PARAM = 'taau';
export type TaauFlag = 'off' | 'motion' | null;

/** What a page's query string asks of the temporal upscale. */
export function taauFlag(search: string): TaauFlag {
  const v = new URLSearchParams(search).get(TAAU_URL_PARAM);
  return v === '0' || v === 'off' ? 'off' : v === 'motion' ? 'motion' : null;
}

/** What the stage reads of the scene pass: its depth and motion targets. */
export interface TaauInputs {
  /** The picture at the render scale (a node drawn into its own target). */
  readonly beauty: N;
  readonly depth: N;
  readonly motion: N;
  readonly camera: THREE.Camera;
}

export interface TaauStage {
  /** The picture at the screen's resolution. */
  readonly output: N;
  /** Whether the last frame held its picture (diagnostics). */
  holding(): boolean;
  /** Whether a still camera may stop the jitter and hold the picture (not while something in view moves by itself). */
  setHoldAllowed(allowed: boolean): void;
  dispose(): void;
}

type Frame = { renderer: THREE.WebGPURenderer };
type Builder = { renderPipeline?: unknown; context: { renderPipelineState: { viewOffsetOwner?: unknown } }; getSharedContext(): unknown; renderer: { reversedDepthBuffer?: boolean } };
const Base = TAAUNode as unknown as new (beauty: N, depth: N, velocity: N, camera: THREE.Camera) => {
  camera: THREE.Camera;
  beautyNode: N;
  velocityNode: N;
  _resolveMaterial: THREE.NodeMaterial;
  _seedMaterial: THREE.NodeMaterial & { outputNode: N };
  _historyRenderTarget: THREE.RenderTarget;
  _jitterOffset: N;
  _jitterIndex: number;
  _textureNode: N;
  _needsPostProcessingSync: boolean;
  setViewOffset(w: number, h: number): void;
  clearViewOffset(): void;
  updateBefore(frame: Frame): void;
  dispose(): void;
};

/** `history` (rgb) clipped toward the box's middle until it lies inside `lo`…`hi` (Karis 2014). */
const clipToBox = (lo: N, hi: N, history: N): N => {
  const half = hi.sub(lo).mul(0.5).add(1e-7);
  const mid = hi.add(lo).mul(0.5);
  const v = history.sub(mid);
  const unit = abs(v.div(half));
  const most = max(max(unit.x, unit.y), unit.z);
  return select(most.greaterThan(1), mid.add(v.div(most)), history);
};

/** The new frame blended into the history by `weight` (rgb), each weighed down by its brightness (bright pixels flicker less). */
const blendFrames = (current: N, history: N, weight: N): N => {
  const lc = luminance(current.div(max(max(current.r, current.g), current.b).add(1)));
  const lh = luminance(history.div(max(max(history.r, history.g), history.b).add(1)));
  const wc = weight.div(lc.add(1));
  const wh = float(1).sub(weight).div(lh.add(1));
  return current.mul(wc).add(history.mul(wh)).div(max(wc.add(wh), 1e-5));
};

/** Three's TAAU node with this module's resolve and the still view's hold. */
class TemporalUpscaleNode extends Base {
  /** The camera has stood still long enough (the jitter stopped). */
  holding = false;
  /** Holding may start (nothing in view moves by itself: a held view would draw moving things without the jitter). */
  holdAllowed = true;
  /** 1 while `previous` holds the last frame's input. */
  readonly previousValid: N = uniform(0);
  /** The last frame's input (only kept while holding). */
  readonly previous = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly previousNode: N = texture(this.previous.texture);
  private readonly sceneDepth: N;
  private still = 0;
  private readonly lastWorld = new THREE.Matrix4();
  private readonly lastProjection = new THREE.Matrix4();
  private lastTime = -1;
  private warmed = false;
  /** The resolve while the camera moves (three's node's own material), and while holding. */
  private readonly movingMaterial: THREE.NodeMaterial;
  private readonly heldMaterial = new THREE.NodeMaterial();

  constructor(beauty: N, depth: N, motion: N, camera: THREE.Camera) {
    // Three's node copies its depth node's texture into a last-frame depth when it has a size: it gets an empty one
    // (this resolve needs no last-frame depth), the scene's depth is read here.
    super(beauty, texture(new THREE.Texture()), motion, camera);
    this.sceneDepth = depth;
    this.movingMaterial = this._resolveMaterial;
    this.heldMaterial.name = 'TAAU.held';
  }

  override setViewOffset(w: number, h: number): void {
    // The camera before this frame's jitter (the last frame's was cleared): has it moved?
    const cam = this.camera as THREE.PerspectiveCamera;
    // This frame's pose (three updates it inside its render, after this hook).
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const moved = !this.lastWorld.equals(cam.matrixWorld) || !this.lastProjection.equals(cam.projectionMatrix);
    this.lastWorld.copy(cam.matrixWorld);
    this.lastProjection.copy(cam.projectionMatrix);
    setMotionCamera(cam.projectionMatrix, cam.matrixWorldInverse);
    this.still = moved ? 0 : this.still + 1;
    this.holding = this.holdAllowed && this.still >= TAAU_HOLD_FRAMES;
    super.setViewOffset(w, h);
  }

  override clearViewOffset(): void {
    // Three's clear (the motion vectors are this engine's: `motion-vectors.ts`), but holding the jitter stays where it is.
    (this.camera as THREE.PerspectiveCamera).clearViewOffset();
    if (!this.holding) this._jitterIndex = (this._jitterIndex + 1) % JITTER_PHASES;
  }

  override updateBefore(frame: Frame): void {
    // Everything the hold draws with is made on the first frame the input has a size, or the frame the camera first
    // stands still long enough would make it (a hitch, and GPU resources that appear while the game runs): the last
    // frame's input target at the input's size, and the held resolve drawn once through three's own resolve, so its
    // program and its draw's bindings exist. With no last frame yet (`previousValid` 0) it draws the plain resolve.
    if (!this.warmed) {
      const input = (this.beautyNode as { renderTarget: THREE.RenderTarget }).renderTarget.texture.image as { width?: number; height?: number } | null;
      const iw = input?.width ?? 0;
      const ih = input?.height ?? 0;
      if (iw >= 1 && ih >= 1) {
        this.warmed = true;
        this.previous.setSize(iw, ih);
        frame.renderer.initRenderTarget(this.previous);
        this._resolveMaterial = this.heldMaterial;
        super.updateBefore(frame);
      }
    }
    const now = performance.now();
    if (this.lastTime >= 0) motionFrameSeconds.value = Math.min(0.25, Math.max(1e-4, (now - this.lastTime) / 1000));
    this.lastTime = now;
    const holding = this.holding;
    // The resolve drawn: the one that first asks whether the pixel's samples changed while holding.
    this._resolveMaterial = holding ? this.heldMaterial : this.movingMaterial;
    super.updateBefore(frame);
    const src = (this.beautyNode as { renderTarget: THREE.RenderTarget }).renderTarget.texture;
    const image = src.image as { width?: number; height?: number } | null;
    const w = image?.width ?? 0;
    const h = image?.height ?? 0;
    if (!holding || w < 1 || h < 1) {
      this.previousValid.value = 0;
      return;
    }
    // This frame's input, which the next frame's pixels compare theirs with.
    const r = frame.renderer;
    const resized = this.previous.width !== w || this.previous.height !== h;
    if (resized) {
      this.previous.setSize(w, h);
      r.initRenderTarget(this.previous);
    }
    r.copyTextureToTexture(src, this.previous.texture);
    this.previousValid.value = resized ? 0 : 1;
  }

  setup(builder: Builder): N {
    // Three's own setup but for the resolve: the jitter owned for the pipeline, the seed after a resize.
    if (builder.renderPipeline && !builder.context.renderPipelineState.viewOffsetOwner) {
      builder.context.renderPipelineState.viewOffsetOwner = this;
      this._needsPostProcessingSync = true;
      const input = (): { width: number; height: number } => (this.beautyNode as { renderTarget: THREE.RenderTarget }).renderTarget.texture.image as { width: number; height: number };
      TSL.OnBeforeRenderPipeline(() => this.setViewOffset(input().width, input().height));
      TSL.OnAfterRenderPipeline(() => this.clearViewOffset());
    }
    const shared = TSL.context(builder.getSharedContext());
    const colorOutput = TSL.property('vec4');
    const lockOutput = TSL.property('vec4');
    this._seedMaterial.contextNode = shared;
    this._seedMaterial.colorNode = Fn(() => {
      colorOutput.assign(this.beautyNode.sample(uv()));
      lockOutput.assign(0);
      return vec4(0);
    })();
    this._seedMaterial.outputNode = TSL.outputStruct(colorOutput, lockOutput);
    const reversed = builder.renderer.reversedDepthBuffer === true;
    this.movingMaterial.contextNode = shared;
    this.movingMaterial.fragmentNode = this.resolve(reversed);
    this.heldMaterial.contextNode = shared;
    this.heldMaterial.fragmentNode = this.heldResolve(reversed);
    return this._textureNode;
  }

  /**
   * Holding: the history where the five input samples nearest the pixel are the last frame's and the history lies
   * within their colours; else the resolve. The second test catches a pixel whose outer samples changed while the
   * nearest five did not (an edge passing a corner): its history then holds a colour none of them has.
   */
  private heldResolve(reversed: boolean): N {
    const beauty = this.beautyNode;
    const previous = this.previousNode;
    const history: N = texture(this._historyRenderTarget.textures[0]!);
    const valid = this.previousValid;
    const jitter = this._jitterOffset;
    const resolve = this.resolve(reversed);
    return Fn(() => {
      const at = uv();
      const size = vec2(beauty.size());
      const last = ivec2(size).sub(1);
      const closest = ivec2(at.mul(size).sub(vec2(0.5).add(jitter)).round()).toVar();
      const change = float(0).toVar();
      const lo = vec3(1e9).toVar();
      const hi = vec3(-1e9).toVar();
      for (const [x, y] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const t = clamp(closest.add(ivec2(x, y)), ivec2(0), last);
        const c = beauty.load(t).toVar();
        const d = abs(c.sub(previous.load(t)));
        change.assign(max(change, max(max(d.x, d.y), max(d.z, d.w))));
        lo.assign(min(lo, c.rgb));
        hi.assign(max(hi, c.rgb));
      }
      const kept = history.sample(at).toVar();
      const within = kept.rgb.greaterThanEqual(lo.sub(HOLD_SLACK)).all().and(kept.rgb.lessThanEqual(hi.add(HOLD_SLACK)).all());
      const out = vec4(0).toVar();
      If(valid.greaterThan(0.5).and(change.lessThanEqual(0)).and(within), () => {
        out.assign(kept);
      }).Else(() => {
        out.assign(resolve);
      });
      return out;
    })();
  }

  /** One output pixel: the new frame rebuilt at it from the nearest input samples, blended into its reprojected, clipped history. */
  private resolve(reversed: boolean): N {
    const beauty = this.beautyNode;
    const depth = this.sceneDepth;
    const motion = this.velocityNode;
    const history: N = texture(this._historyRenderTarget.textures[0]!);
    const jitter = this._jitterOffset;
    const taps: (readonly [number, number])[] = [];
    for (let y = -1; y <= 1; y += 1) for (let x = -1; x <= 1; x += 1) taps.push([x, y]);
    return Fn(() => {
      const at = uv();
      const size = vec2(beauty.size()).toVar();
      const last = ivec2(size).sub(1);
      const pIn = at.mul(size).toVar();
      // The input sample nearest the output pixel (sample (m, n) was drawn at m + 0.5 + jitter).
      const closest = ivec2(pIn.sub(vec2(0.5).add(jitter)).round()).toVar();
      const tapAt = (x: number, y: number): N => clamp(closest.add(ivec2(x, y)), ivec2(0), last);
      // The motion of the nearest surface among five taps: an edge moves with what is in front.
      const nearest = tapAt(0, 0).toVar();
      const nearestDepth = depth.load(nearest).r.toVar();
      for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const t = tapAt(x, y);
        const d = depth.load(t).r;
        const nearer = reversed ? d.greaterThan(nearestDepth) : d.lessThan(nearestDepth);
        nearest.assign(select(nearer, t, nearest));
        nearestDepth.assign(select(nearer, d, nearestDepth));
      }
      const was = at.sub(motion.load(nearest).xy.mul(vec2(0.5, -0.5))).toVar();
      // The new frame here: the taps weighed by a Gaussian fit of Blackman-Harris at their jittered places, and their
      // colours' mean and spread for the clip (rgb: the picture's alpha is the nearest sample's).
      const sum = vec3(0).toVar();
      const weights = float(0).toVar();
      const m1 = vec3(0).toVar();
      const m2 = vec3(0).toVar();
      const centre = jitter.add(0.5).sub(pIn).toVar();
      for (const [x, y] of taps) {
        const c = max(beauty.load(tapAt(x, y)).rgb, vec3(0)).toVar();
        const d = vec2(closest.add(ivec2(x, y))).add(centre);
        const w = exp(d.dot(d).mul(-2.29));
        sum.addAssign(c.mul(w));
        weights.addAssign(w);
        m1.addAssign(c);
        m2.addAssign(c.mul(c));
      }
      const current = sum.div(max(weights, 1e-5)).toVar();
      const mean = m1.div(taps.length).toVar();
      const moved = clamp(at.sub(was).mul(size).length().div(MAX_MOTION_PX), 0, 1).toVar();
      const gamma = mix(float(0.5), float(1), float(1).sub(moved).pow2());
      const spread = max(m2.div(taps.length).sub(mean.mul(mean)), vec3(0)).sqrt().mul(gamma).toVar();
      const kept = clipToBox(mean.sub(spread), mean.add(spread), history.sample(was).rgb);
      const onScreen = was.x.greaterThanEqual(0).and(was.y.greaterThanEqual(0)).and(was.x.lessThanEqual(1)).and(was.y.lessThanEqual(1));
      const weight = select(onScreen, clamp(moved.add(TAAU_CURRENT_WEIGHT), 0, 1), float(1));
      return vec4(blendFrames(current, kept, weight), beauty.load(tapAt(0, 0)).a);
    })();
  }

  override dispose(): void {
    this._resolveMaterial = this.movingMaterial;
    this.heldMaterial.dispose();
    this.previous.dispose();
    super.dispose();
  }
}

/** The temporal upscale of `inputs.beauty` to the drawing buffer. */
export function buildTaau(inputs: TaauInputs): TaauStage {
  const node = new TemporalUpscaleNode(inputs.beauty, inputs.depth, inputs.motion, inputs.camera);
  return {
    output: TSL.nodeObject(node),
    holding: () => node.holding && node.previousValid.value === 1,
    setHoldAllowed(allowed) {
      node.holdAllowed = allowed;
    },
    dispose: () => node.dispose(),
  };
}
