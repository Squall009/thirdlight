/**
 * The key light's shadow as a cached static map with a dynamic map on top
 * (HDRP's mixed cached shadows, Unreal's static/dynamic split).
 *
 * Most casters never move, yet three draws every caster into the sun's shadow
 * map every frame (the village class: 426 shadow draws a frame against 197 in
 * the view). Here the light's shadow is one node over two maps:
 *
 * - the **static map** draws only static casters (`shadow-casters.ts`), and
 *   only when what it shows changed (a change anywhere, or one within its
 *   reach), its region stepped, the light turned past
 *   {@link STATIC_SHADOW_TURN_DEGREES}, or a new renderer draws it;
 * - the **dynamic map** draws every other caster, every frame;
 * - the receiver takes the darker of the two (`min`, as three's
 *   `TileShadowNode` combines its tiles).
 *
 * Regions: the dynamic map follows the camera square by square of texels, as
 * the single map did. The static map cannot follow that closely without being
 * drawn every frame the camera moves, so its centre moves in steps of
 * {@link STATIC_SHADOW_STEP} of the square's half side, and it is that much
 * larger (same texel size, so the same shadow edges): wherever the camera is
 * within its step, the followed square lies inside the static map. Both grids
 * are whole texels in the light's frame, so static and dynamic texels line up.
 *
 * Each map is a three `ShadowNode` of a stand-in light (an `Object3D` with a
 * target and its own shadow), whose pass draws only its own casters (a filter
 * on three's per-object shadow render function). The stand-ins are never in
 * the scene: their matrices are written here.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { isStaticCaster, type StaticShadowRevision } from './shadow-casters';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, min, NodeUpdateType } = TSL;

/** The static map's centre moves in steps of this fraction of the shadow square's half side (it is drawn again at each step). */
export const STATIC_SHADOW_STEP = 0.5;

/** Texels added round the static map beyond the step's reach (the dynamic square's own snapping moves it up to half a texel). */
const STATIC_SHADOW_PAD_TEXELS = 4;

/** A light turning by more than this (degrees) since the static map was drawn draws it again; less, it keeps the map (a sweeping sun redraws every frame). */
export const STATIC_SHADOW_TURN_DEGREES = 0.05;

/** The shadow parameters the light realization planned (lighting.ts). */
export interface ShadowParams {
  /** Square map side, texels, and half the side of the followed square, metres. */
  readonly mapSize: number;
  readonly halfExtent: number;
  readonly near: number;
  readonly far: number;
  /** The light's distance before the square's centre, metres. */
  readonly distance: number;
  readonly bias: number;
  readonly normalBias: number;
}

/** The static map's side in texels and half side in metres for `p` (same texel size as the dynamic map). */
export function staticShadowSize(p: Pick<ShadowParams, 'mapSize' | 'halfExtent'>): { mapSize: number; halfExtent: number; texel: number } {
  const texel = (2 * p.halfExtent) / p.mapSize;
  // Half the dynamic side, plus the camera's reach within a step, plus the pad (whole texels).
  const halfTexels = Math.ceil(p.mapSize / 2 + (p.mapSize / 2) * (STATIC_SHADOW_STEP / 2)) + STATIC_SHADOW_PAD_TEXELS;
  return { mapSize: halfTexels * 2, halfExtent: halfTexels * texel, texel };
}

const _basis = new THREE.Matrix4();
const _eye = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();

/**
 * `point` snapped to a grid of `step` metres in the frame three's shadow
 * camera has for a light shining along `direction` (normalized), written to
 * `out`. The camera's own axes (`lookAt` with +Y up) make the grid whole
 * texels of the map when `step` is a whole number of texels.
 */
export function snapToLightGrid(point: THREE.Vector3, direction: THREE.Vector3, step: number, out: THREE.Vector3): THREE.Vector3 {
  _eye.copy(direction).negate();
  _basis.lookAt(_eye, _origin, _up);
  _basis.extractBasis(_x, _y, _z);
  const u = Math.round(point.dot(_x) / step) * step;
  const v = Math.round(point.dot(_y) / step) * step;
  const w = Math.round(point.dot(_z) / step) * step;
  return out.set(0, 0, 0).addScaledVector(_x, u).addScaledVector(_y, v).addScaledVector(_z, w);
}

/** What three's shadow pass hands a render-object function. */
type RenderObjectFn = (object: THREE.Object3D, ...rest: unknown[]) => void;

interface ShadowNodeLike {
  shadow: THREE.DirectionalLightShadow;
  shadowMap: THREE.RenderTarget | null;
  updateBeforeType: string;
  updateShadow(frame: unknown): void;
  getShadowRenderObjectFunction(renderer: unknown, shadow?: unknown): RenderObjectFn;
  dispose(): void;
}

const ShadowNodeBase = THREE.ShadowNode as unknown as new (light: THREE.Object3D, shadow: THREE.LightShadow) => ShadowNodeLike;

/** One map's pass: three's shadow node, drawing only the static casters or only the others. */
class PassShadowNode extends ShadowNodeBase {
  private base: RenderObjectFn | null = null;
  private filtered: RenderObjectFn | null = null;
  constructor(
    light: THREE.Object3D,
    shadow: THREE.LightShadow,
    private readonly staticPass: boolean,
  ) {
    super(light, shadow);
    // Drawn by the cached node (which decides when), never by the frame on its own.
    this.updateBeforeType = NodeUpdateType.NONE;
  }
  override getShadowRenderObjectFunction(renderer: unknown, shadow?: unknown): RenderObjectFn {
    const base = super.getShadowRenderObjectFunction(renderer, shadow);
    if (base !== this.base) {
      const want = this.staticPass;
      this.base = base;
      this.filtered = (object, ...rest) => {
        if (isStaticCaster(object) === want) base(object, ...rest);
      };
    }
    return this.filtered!;
  }
}

/** A light that is only a shadow: placed here, never in the scene. */
class ShadowStandIn extends THREE.Object3D {
  readonly target = new THREE.Object3D();
  readonly shadow: THREE.DirectionalLightShadow;
  constructor(name: string, mapSize: number, halfExtent: number, near: number, far: number) {
    super();
    this.name = name;
    // Three reads a light's shadow matrix as drawn only while it casts.
    this.castShadow = true;
    this.matrixAutoUpdate = false;
    this.target.matrixAutoUpdate = false;
    const s = new THREE.DirectionalLight().shadow;
    s.mapSize.set(mapSize, mapSize);
    s.camera.left = -halfExtent;
    s.camera.right = halfExtent;
    s.camera.top = halfExtent;
    s.camera.bottom = -halfExtent;
    s.camera.near = near;
    s.camera.far = far;
    s.camera.updateProjectionMatrix();
    this.shadow = s;
  }
  /** Shine along `dir` (normalized) on `centre` from `distance` before it. */
  place(centre: THREE.Vector3, dir: THREE.Vector3, distance: number): void {
    this.target.position.copy(centre);
    this.position.copy(centre).addScaledVector(dir, -distance);
    this.updateMatrix();
    this.updateMatrixWorld();
    this.target.updateMatrix();
    this.target.updateMatrixWorld();
    // Its camera and frustum where it now shines (what a change must touch to show in its map).
    this.shadow.updateMatrices(this as unknown as THREE.Light);
  }
}

export interface CachedShadowCounts {
  /** Static and dynamic map draws in the last frame, and since the node was made. */
  readonly static: number;
  readonly dynamic: number;
  readonly staticTotal: number;
  readonly dynamicTotal: number;
}

const ShadowBaseNodeBase = THREE.ShadowBaseNode as unknown as new (light: THREE.Light) => {
  updateBeforeType: string;
  setupShadowPosition(builder: unknown): void;
  dispose(): void;
};

/** The key light's shadow node (`light.shadow.shadowNode`): a cached static map and a dynamic map, combined. */
export class CachedShadowNode extends ShadowBaseNodeBase {
  static get type(): string {
    return 'CachedShadowNode';
  }
  private readonly light: THREE.DirectionalLight;
  private readonly revision: StaticShadowRevision;
  private readonly params: ShadowParams;
  private readonly staticSize: { mapSize: number; halfExtent: number; texel: number };
  /** The static map's depth reach beyond the dynamic one's (its centre is up to half a step off along the light). */
  private readonly depthPad: number;
  private readonly staticLight: ShadowStandIn;
  private readonly dynamicLight: ShadowStandIn;
  private staticNode: PassShadowNode | null = null;
  private dynamicNode: PassShadowNode | null = null;
  /** Where and along what the static map was last placed, and whether it must be drawn again. */
  private readonly staticCentre = new THREE.Vector3(Number.NaN, 0, 0);
  private readonly staticDir = new THREE.Vector3(Number.NaN, 0, 0);
  private staticDirty = true;
  private drawnRevision = -1;
  private drawnBy: unknown = null;
  private readonly cameraFrame = new WeakMap<object, number>();
  private counts = { static: 0, dynamic: 0 };
  private last = { static: 0, dynamic: 0 };
  private totals = { static: 0, dynamic: 0 };
  private readonly tmp = new THREE.Vector3();

  constructor(light: THREE.DirectionalLight, revision: StaticShadowRevision, params: ShadowParams) {
    super(light);
    this.light = light;
    this.revision = revision;
    this.params = params;
    this.staticSize = staticShadowSize(params);
    this.depthPad = params.halfExtent * (STATIC_SHADOW_STEP / 2) + this.staticSize.texel;
    this.updateBeforeType = NodeUpdateType.RENDER;
    this.dynamicLight = new ShadowStandIn('dynamic shadow', params.mapSize, params.halfExtent, params.near, params.far);
    this.staticLight = new ShadowStandIn('static shadow', this.staticSize.mapSize, this.staticSize.halfExtent, params.near, params.far + 2 * this.depthPad);
    this.dynamicLight.shadow.bias = params.bias;
    // The bias is in the map's depth units: the same distance in metres over the static map's longer depth range.
    this.staticLight.shadow.bias = (params.bias * (params.far - params.near)) / (params.far + 2 * this.depthPad - params.near);
    this.dynamicLight.shadow.normalBias = params.normalBias;
    this.staticLight.shadow.normalBias = params.normalBias;
  }

  /**
   * Place the maps for this frame: the dynamic one on `dynamicCentre` (the
   * followed square, whole texels), the static one on `point` snapped to its
   * step. `direction` is normalized.
   */
  follow(point: THREE.Vector3, dynamicCentre: THREE.Vector3, direction: THREE.Vector3): void {
    this.dynamicLight.place(dynamicCentre, direction, this.params.distance);
    const turned = !(this.staticDir.dot(direction) >= Math.cos(THREE.MathUtils.degToRad(STATIC_SHADOW_TURN_DEGREES)));
    if (turned) this.staticDir.copy(direction);
    const step = this.params.halfExtent * STATIC_SHADOW_STEP;
    // A whole number of texels, so the static grid lines up with the dynamic one.
    const texelStep = Math.max(1, Math.round(step / this.staticSize.texel)) * this.staticSize.texel;
    const centre = snapToLightGrid(point, this.staticDir, texelStep, this.tmp);
    if (!turned && centre.distanceToSquared(this.staticCentre) < 1e-12) return;
    this.staticCentre.copy(centre);
    this.staticLight.place(centre, this.staticDir, this.params.distance + this.depthPad);
    this.staticDirty = true;
  }

  /** Draw the static map again on the next frame (a new renderer, settings changed). */
  invalidate(): void {
    this.staticDirty = true;
  }

  /**
   * Before a frame is drawn (after everything that changes the casters): the last frame's draws are counted,
   * and a change reported where it happened draws the static map again if it lies within the map's reach.
   */
  roll(): void {
    this.last = this.counts;
    this.counts = { static: 0, dynamic: 0 };
    const frustum = this.staticLight.shadow.getFrustum();
    if (this.revision.drain((s) => frustum.intersectsSphere(s))) this.staticDirty = true;
  }

  diagnostics(): CachedShadowCounts {
    return { static: this.last.static, dynamic: this.last.dynamic, staticTotal: this.totals.static, dynamicTotal: this.totals.dynamic };
  }

  setup(builder: N): N {
    if (builder.renderer.shadowMap.enabled === false) return undefined;
    if (this.staticNode === null || this.dynamicNode === null) {
      this.staticNode = new PassShadowNode(this.staticLight, this.staticLight.shadow, true);
      this.dynamicNode = new PassShadowNode(this.dynamicLight, this.dynamicLight.shadow, false);
      this.staticDirty = true;
    }
    const s = this.staticNode;
    const d = this.dynamicNode;
    return Fn((b: N) => {
      this.setupShadowPosition(b);
      return min(s, d).toVar('cachedShadow');
    })();
  }

  updateBefore(frame: N): void {
    const renderer = frame.renderer;
    if (renderer._isPreCompiling === true) return;
    const s = this.staticNode;
    const d = this.dynamicNode;
    if (s === null || d === null || s.shadowMap === null || d.shadowMap === null) return;
    // Once per frame and view camera (three's own shadow node does the same).
    if (this.cameraFrame.get(frame.camera) === frame.frameId) return;
    this.cameraFrame.set(frame.camera, frame.frameId);
    const intensity = this.light.shadow.intensity;
    this.staticLight.shadow.intensity = intensity;
    this.dynamicLight.shadow.intensity = intensity;
    if (renderer !== this.drawnBy || this.revision.value !== this.drawnRevision) this.staticDirty = true;
    if (this.staticDirty) {
      s.updateShadow(frame);
      this.staticDirty = false;
      this.drawnRevision = this.revision.value;
      this.drawnBy = renderer;
      this.counts.static += 1;
      this.totals.static += 1;
    }
    d.updateShadow(frame);
    this.counts.dynamic += 1;
    this.totals.dynamic += 1;
  }

  override dispose(): void {
    this.staticNode?.dispose();
    this.dynamicNode?.dispose();
    this.staticNode = null;
    this.dynamicNode = null;
    this.staticDirty = true;
    super.dispose();
  }
}
