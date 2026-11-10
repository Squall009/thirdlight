/**
 * A GPU load a measuring run adds to every frame, to find how much room the
 * frame has at the display's cap without timestamps.
 *
 * At the cap a GPU's timestamps follow its clock governor, which slows the
 * clock when a frame leaves it idle, so the same work reads more ms on a
 * light frame. A load that makes the GPU miss frames keeps it busy (and its
 * clock up): the load at which the frames start to miss says how much room
 * there was, and once the GPU is the bottleneck the frame interval itself is
 * the GPU's time per frame. The measuring tool (`tools/voxel-bench`, the
 * `headroom` bench) drives these knobs through a page's test hook:
 *
 * - **ballast**: copies of one fixed full-screen fragment load into a target
 *   of its own, in one instanced draw (no CPU cost per copy), the unit the
 *   room is counted in;
 * - **copies**: the frame's drawables under chosen roots (a voxel world's
 *   near surfaces, its far field) drawn again `copies` times into a target of
 *   the scene pass's size, with the same camera, lights and materials (their
 *   CPU time is measured: a copy that costs more CPU than GPU says so);
 * - **hide shadows**: the shadow-casting lights stop casting (programs are
 *   built again once each way; a run waits for that);
 * - **bypass post**: the scene drawn into a target of the size the post
 *   stack draws it at, then copied to the canvas, instead of the stack.
 *
 * None of it is on unless a host sets it; with everything off the frame is
 * untouched.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, Loop, float, fract, instanceIndex, positionGeometry, screenUV, sin, texture, vec3, vec4 } = TSL;

/**
 * The three.js layer the copies draw: their roots' drawables and the scene's
 * lights are put in it while copies are on (layers 1, 30 and 31 are the
 * engine's reflection, batched and off-view layers).
 */
export const HEADROOM_LAYER = 29;

/** The most ballast copies a frame (the instanced draw's count is clamped to it). */
export const BALLAST_MAX = 4096;

/** The ballast's target: a fixed size, so its unit does not change with the canvas or the render scale. */
export const BALLAST_SIZE: readonly [number, number] = [640, 360];

/** ALU steps a ballast fragment runs (a dependent chain: the work cannot be skipped or merged). */
export const BALLAST_STEPS = 32;

export interface GpuLoadSettings {
  /** Ballast copies a frame (0: none). */
  readonly ballast?: number;
  /** Extra draws of {@link copyOf}'s drawables a frame (0: none). */
  readonly copies?: number;
  /** The roots whose drawables the copies draw, asked each frame (drawables arriving later are drawn too). */
  readonly copyOf?: () => readonly THREE.Object3D[];
  /** The shadow-casting lights stop casting. */
  readonly hideShadows?: boolean;
  /** The scene is drawn without the post stack, at the stack's size. */
  readonly bypassPost?: boolean;
}

export interface GpuLoadState {
  readonly ballast: number;
  readonly copies: number;
  /** Page-thread ms the copies took in the last frame that drew them. */
  readonly copyCpuMs: number;
  /** Lights the load stopped casting (0 while shadows are shown). */
  readonly lightsHidden: number;
  readonly bypassPost: boolean;
  /** The size the copies and the bypass drew at, [width, height] (0, 0: not drawn yet). */
  readonly size: readonly [number, number];
  /** Frames the load was applied to since it was last set. */
  readonly frames: number;
}

/** What of three's renderer the load drives (WebGPURenderer on either backend). */
export interface GpuLoadRenderer {
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(target: THREE.RenderTarget | null): void;
  getMRT?(): unknown;
  setMRT?(mrt: unknown): void;
  autoClear: boolean;
}

/** A light that casts with three's shadow node (the engine's own light-like nodes are left alone). */
function isShadowLight(o: THREE.Object3D): o is THREE.Light {
  const l = o as THREE.Light & { isDirectionalLight?: boolean; isSpotLight?: boolean; isPointLight?: boolean };
  return l.isLight === true && (l.isDirectionalLight === true || l.isSpotLight === true || l.isPointLight === true);
}

/** A drawable the main camera draws (layer 0); shadow-only stand-ins on other layers stay out of the copies. */
function isDrawn(o: THREE.Object3D): boolean {
  const d = o as THREE.Mesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
  return (d.isMesh === true || d.isPoints === true || d.isLine === true || d.isSprite === true) && o.layers.isEnabled(0);
}

function ballastMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  // A full-screen triangle in clip space (the instance matrix and camera play no part).
  m.vertexNode = vec4(positionGeometry.xy, 0, 1);
  m.colorNode = Fn(() => {
    const v = vec3(screenUV, float(instanceIndex).mul(0.0137)).toVar();
    Loop(BALLAST_STEPS, () => {
      v.assign(fract(sin(v.mul(12.9898).add(v.yzx.mul(78.233))).mul(43758.5453)));
    });
    // A faint sum: the target is written (the work is kept) but never saturates.
    return vec4(v.mul(1e-4), 1e-4);
  })();
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthTest = false;
  m.depthWrite = false;
  m.toneMapped = false;
  m.fog = false;
  return m;
}

function ballastGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.instanceCount = 0;
  return g;
}

function target(width: number, height: number, depth: boolean): THREE.RenderTarget {
  const t = new THREE.RenderTarget(width, height, { depthBuffer: depth, type: THREE.HalfFloatType });
  t.texture.name = 'gpu headroom';
  return t;
}

export class GpuLoad {
  private ballast = 0;
  private copies = 0;
  private copyOf: () => readonly THREE.Object3D[] = () => [];
  private hideShadows = false;
  private bypassPost = false;
  private frames = 0;
  private copyCpuMs = 0;
  private size: [number, number] = [0, 0];
  /** Lights this load stopped casting (given back when shadows are shown again). */
  private readonly hidden = new Set<THREE.Light>();
  /** Roots and lights put in {@link HEADROOM_LAYER}, taken out when the copies stop. */
  private tagged: THREE.Object3D[] = [];
  private ballastScene: THREE.Scene | null = null;
  private ballastGeometry: THREE.InstancedBufferGeometry | null = null;
  private ballastTarget: THREE.RenderTarget | null = null;
  private readonly ballastCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private copyTarget: THREE.RenderTarget | null = null;
  private plainTarget: THREE.RenderTarget | null = null;
  private blit: THREE.QuadMesh | null = null;
  private blitMaterial: THREE.MeshBasicNodeMaterial | null = null;

  set(s: GpuLoadSettings): void {
    this.ballast = Math.max(0, Math.min(BALLAST_MAX, Math.floor(s.ballast ?? 0)));
    this.copies = Math.max(0, Math.floor(s.copies ?? 0));
    if (s.copyOf !== undefined) this.copyOf = s.copyOf;
    this.hideShadows = s.hideShadows === true;
    this.bypassPost = s.bypassPost === true;
    this.frames = 0;
  }

  /** Whether the frame draws without its post stack ({@link drawPlain} instead). */
  get bypassesPost(): boolean {
    return this.bypassPost;
  }

  /** Whether {@link afterDraw} has anything to do (a load on, or lights or layers still to give back). */
  get active(): boolean {
    return this.ballast > 0 || this.copies > 0 || this.hideShadows || this.bypassPost || this.hidden.size > 0 || this.tagged.length > 0;
  }

  state(): GpuLoadState {
    return { ballast: this.ballast, copies: this.copies, copyCpuMs: this.copyCpuMs, lightsHidden: this.hidden.size, bypassPost: this.bypassPost, size: [this.size[0], this.size[1]], frames: this.frames };
  }

  /**
   * The frame's scene without the post stack: drawn into a target of the
   * stack's size (`width` × `height`), then copied to the canvas, so the
   * canvas is still presented every frame (the cap's back-pressure needs it).
   */
  drawPlain(renderer: GpuLoadRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number): void {
    const t = (this.plainTarget = this.sized(this.plainTarget, width, height, true));
    const before = renderer.getRenderTarget();
    renderer.setRenderTarget(t);
    renderer.render(scene, camera);
    renderer.setRenderTarget(before);
    if (this.blit === null) {
      const m = (this.blitMaterial = new THREE.MeshBasicNodeMaterial());
      m.depthTest = false;
      m.depthWrite = false;
      m.toneMapped = false;
      m.fog = false;
      this.blit = new THREE.QuadMesh(m);
    }
    this.blitMaterial!.colorNode = texture(t.texture);
    this.blit.render(renderer as unknown as THREE.Renderer);
  }

  /** After the frame's draw: the shadows' switch, the ballast and the copies (`width` × `height`: the scene pass's size). */
  afterDraw(renderer: GpuLoadRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number): void {
    this.frames += 1;
    this.applyShadows(scene);
    const before = renderer.getRenderTarget();
    const mrt = renderer.getMRT?.() ?? null;
    const autoClear = renderer.autoClear;
    renderer.setMRT?.(null);
    renderer.autoClear = true;
    try {
      if (this.ballast > 0) this.drawBallast(renderer);
      const roots = this.copies > 0 ? this.copyOf() : [];
      if (roots.length > 0) this.drawCopies(renderer, scene, camera, width, height, roots);
      else if (this.tagged.length > 0) this.untag();
    } finally {
      renderer.setRenderTarget(before);
      renderer.setMRT?.(mrt);
      renderer.autoClear = autoClear;
    }
  }

  private applyShadows(scene: THREE.Scene): void {
    if (this.hideShadows) {
      scene.traverse((o) => {
        if (isShadowLight(o) && o.castShadow) {
          o.castShadow = false;
          this.hidden.add(o);
        }
      });
    } else if (this.hidden.size > 0) {
      for (const l of this.hidden) l.castShadow = true;
      this.hidden.clear();
    }
  }

  private drawBallast(renderer: GpuLoadRenderer): void {
    if (this.ballastScene === null) {
      const g = (this.ballastGeometry = ballastGeometry());
      const mesh = new THREE.Mesh(g, ballastMaterial());
      mesh.frustumCulled = false;
      this.ballastScene = new THREE.Scene();
      this.ballastScene.add(mesh);
      this.ballastTarget = target(BALLAST_SIZE[0], BALLAST_SIZE[1], false);
    }
    this.ballastGeometry!.instanceCount = this.ballast;
    renderer.setRenderTarget(this.ballastTarget);
    renderer.render(this.ballastScene, this.ballastCamera);
  }

  private drawCopies(renderer: GpuLoadRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, roots: readonly THREE.Object3D[]): void {
    const t0 = performance.now();
    // This frame's drawables under the roots and the scene's lights (the same lights: the same programs).
    this.untag();
    for (const root of roots) root.traverse((o) => void (isDrawn(o) && this.tag(o)));
    scene.traverse((o) => void ((o as THREE.Light).isLight === true && this.tag(o)));
    const t = (this.copyTarget = this.sized(this.copyTarget, width, height, true));
    const mask = camera.layers.mask;
    // The sky is the scene's, not the pass's: left out of the copies.
    const background = scene.background;
    scene.background = null;
    camera.layers.set(HEADROOM_LAYER);
    try {
      renderer.setRenderTarget(t);
      for (let i = 0; i < this.copies; i++) renderer.render(scene, camera);
    } finally {
      camera.layers.mask = mask;
      scene.background = background;
    }
    this.copyCpuMs = performance.now() - t0;
  }

  private tag(o: THREE.Object3D): void {
    if (o.layers.isEnabled(HEADROOM_LAYER)) return;
    o.layers.enable(HEADROOM_LAYER);
    this.tagged.push(o);
  }

  private untag(): void {
    for (const o of this.tagged) o.layers.disable(HEADROOM_LAYER);
    this.tagged = [];
  }

  private sized(t: THREE.RenderTarget | null, width: number, height: number, depth: boolean): THREE.RenderTarget {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    this.size = [w, h];
    if (t === null) return target(w, h, depth);
    if (t.width !== w || t.height !== h) t.setSize(w, h);
    return t;
  }

  dispose(): void {
    this.set({});
    for (const l of this.hidden) l.castShadow = true;
    this.hidden.clear();
    this.untag();
    this.ballastGeometry?.dispose();
    for (const m of this.ballastScene?.children ?? []) ((m as THREE.Mesh).material as THREE.Material).dispose();
    this.ballastTarget?.dispose();
    this.copyTarget?.dispose();
    this.plainTarget?.dispose();
    this.blitMaterial?.dispose();
    this.ballastScene = this.ballastGeometry = this.ballastTarget = this.copyTarget = this.plainTarget = this.blit = this.blitMaterial = null;
  }
}
