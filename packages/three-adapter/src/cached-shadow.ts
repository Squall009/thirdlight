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
 *   reach; a caster's material changed in place or swapped, or a caster no
 *   longer static), its region stepped, the light turned past
 *   {@link STATIC_SHADOW_TURN_DEGREES}, or a new renderer draws it;
 * - the **dynamic map** is drawn every frame: first the static map's depths
 *   copied in (one full-map quad, `ShadowUnderlay`), then every other caster
 *   on top, so the map holds the nearer of the two at each texel;
 * - the receiver samples the dynamic map only, as it would the single map:
 *   the same filter taps per pixel as an uncached shadow (sampling both maps
 *   and taking the darker cost the village class 0.35 ms a frame of GPU time).
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
 * the scene: their matrices are written here. The static map is never sampled
 * by a receiver, only read texel by texel into the dynamic one: its texels
 * line up with the dynamic map's (same texel size, whole-texel grids), and
 * its depth is moved into the dynamic map's range (both are orthographic:
 * depth is linear in the distance along the light).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { castsShadowFor, isLayeredLight } from './light-layers';
import { DrawnCasters, isStaticCaster, type StaticShadowRevision } from './shadow-casters';
import { withEmptyInstanceDraws } from './attribute-instancing';
import { STATIC_SHADOW_CAMERA_KEY } from './view-cull';
import { shadowSeesCutaways } from './block-cutaway-view';
import { perfMark } from './perf-marks';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, If, Discard, float, int, ivec2, positionGeometry, screenCoordinate, textureLoad, uniform, vec4, NodeUpdateType } = TSL;

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
  /** Casters drawn into the map by its last pass. */
  drawn = 0;
  /** Drawn before the first caster of each pass (the dynamic map's copy of the static one); null: none. */
  underlay: THREE.Mesh | null = null;
  private underlaid = false;
  /** The static pass: what each caster was drawn with (a change made in place draws the map again). */
  readonly drawnWith = new DrawnCasters();
  /**
   * The dynamic pass: whether the static map holds a static caster. One it
   * does not (it turned static since the map was drawn) is drawn here this
   * frame, and `missed` asks for the static map again.
   */
  staticHolds: ((o: THREE.Object3D) => boolean) | null = null;
  missed = false;
  /** The casters the light's shadow caster mask lets in (null: every caster). */
  casts: ((o: THREE.Object3D) => boolean) | null = null;
  constructor(
    light: THREE.Object3D,
    shadow: THREE.LightShadow,
    private readonly staticPass: boolean,
  ) {
    super(light, shadow);
    if (staticPass) shadow.camera.userData[STATIC_SHADOW_CAMERA_KEY] = true;
    // Drawn by the cached node (which decides when), never by the frame on its own.
    this.updateBeforeType = NodeUpdateType.NONE;
  }
  override getShadowRenderObjectFunction(renderer: unknown, shadow?: unknown): RenderObjectFn {
    const base = super.getShadowRenderObjectFunction(renderer, shadow);
    if (base !== this.base) {
      const want = this.staticPass;
      this.base = base;
      this.filtered = (object, ...rest) => {
        // The pass's render objects come in draw order: the underlay goes in before the first of them.
        const u = this.underlay;
        if (!this.underlaid && u !== null) {
          this.underlaid = true;
          base(u, rest[0], rest[1], u.geometry, u.material, null, ...rest.slice(5));
        }
        // A caster outside the light's shadow caster mask is in neither map.
        if (this.casts !== null && !this.casts(object)) return;
        const isStatic = isStaticCaster(object);
        if (isStatic !== want) {
          if (!isStatic || this.staticHolds === null || this.staticHolds(object)) return;
          this.missed = true;
        }
        if (want) this.drawnWith.add(object);
        this.drawn += 1;
        base(object, ...rest);
      };
    }
    return this.filtered!;
  }
  /** Draw the map now (its casters, after the underlay if one is set). */
  draw(frame: unknown): void {
    this.drawn = 0;
    this.underlaid = false;
    this.drawnWith.clear();
    if (this.staticPass) withEmptyInstanceDraws(() => this.updateShadow(frame));
    else this.updateShadow(frame);
  }


  /**
   * The map's render target, for a map no receiver samples (a receiver's
   * shadow setup makes it otherwise). Its depth is read texel by texel, never
   * compared: no compare function (a WebGL 2 texel fetch of a texture with a
   * compare mode is undefined) and nearest filtering.
   */
  ensureTarget(builder: N): THREE.RenderTarget {
    if (this.shadowMap === null) {
      const self = this as unknown as { setupRenderTarget(shadow: THREE.LightShadow, builder: unknown): { shadowMap: THREE.RenderTarget; depthTexture: THREE.DepthTexture } };
      const { shadowMap, depthTexture } = self.setupRenderTarget(this.shadow, builder);
      depthTexture.compareFunction = null;
      depthTexture.minFilter = THREE.NearestFilter;
      depthTexture.magFilter = THREE.NearestFilter;
      this.shadow.camera.coordinateSystem = builder.camera.coordinateSystem;
      this.shadow.camera.updateProjectionMatrix();
      this.shadowMap = shadowMap;
    }
    return this.shadowMap;
  }
}

/**
 * The static map's depths drawn into the dynamic map: a quad over the whole
 * map, each texel reading the static texel at the same place (`offset`
 * texels away) and writing its depth moved into the dynamic range
 * (`depth × scale + shift`). Texels where the static map holds nothing, or a
 * caster outside the dynamic map's depth range (the single map would have
 * clipped it), are left as they are.
 */
class ShadowUnderlay {
  readonly mesh: THREE.Mesh;
  readonly offset = uniform(new THREE.Vector2());
  readonly scale = uniform(1);
  readonly shift = uniform(0);
  constructor(staticDepth: THREE.DepthTexture, staticSize: number, reversed: boolean) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'static shadow underlay';
    // Drawn with this material in the shadow pass, not the pass's depth material.
    (m as unknown as { allowOverride: boolean }).allowOverride = false;
    m.colorWrite = false;
    m.side = THREE.DoubleSide;
    m.fog = false;
    m.lights = false;
    m.vertexNode = vec4(positionGeometry.xy, 0, 1);
    const last = int(staticSize - 1);
    const texel = ivec2(screenCoordinate.xy.floor().add(this.offset)).clamp(ivec2(0, 0), ivec2(last, last));
    // A reversed depth buffer stores 1 − depth (far at 0): moved in the forward sense, written back reversed.
    const stored = textureLoad(staticDepth, texel);
    const forward = reversed ? float(1).sub(stored) : stored;
    const moved = forward.mul(this.scale).add(this.shift);
    m.depthNode = Fn(() => {
      If(forward.greaterThanEqual(1).or(moved.lessThan(0)).or(moved.greaterThanEqual(1)), () => {
        Discard();
      });
      return reversed ? float(1).sub(moved) : moved;
    })();
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
    this.mesh.name = 'static shadow underlay';
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }
  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
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
    // What a block layer cuts away from the view still casts.
    shadowSeesCutaways(s.camera);
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
  private underlay: ShadowUnderlay | null = null;
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
    // Receivers compare against the dynamic map only (the static depths are copied into it): its bias is the light's.
    this.dynamicLight.shadow.bias = params.bias;
    this.dynamicLight.shadow.normalBias = params.normalBias;
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
      const s = new PassShadowNode(this.staticLight, this.staticLight.shadow, true);
      this.staticNode = s;
      this.dynamicNode = new PassShadowNode(this.dynamicLight, this.dynamicLight.shadow, false);
      this.dynamicNode.staticHolds = (o) => s.drawnWith.has(o);
      const light = this.light;
      const casts = isLayeredLight(light) ? (o: THREE.Object3D) => castsShadowFor(light, o) : null;
      s.casts = casts;
      this.dynamicNode.casts = casts;
      this.staticDirty = true;
    }
    if (this.underlay === null) {
      const target = this.staticNode.ensureTarget(builder);
      this.underlay = new ShadowUnderlay(target.depthTexture as THREE.DepthTexture, this.staticSize.mapSize, builder.renderer.reversedDepthBuffer === true);
    }
    const d = this.dynamicNode;
    return Fn((b: N) => {
      this.setupShadowPosition(b);
      return d;
    })();
  }

  /** Line the underlay up for this frame: the static texel under each dynamic one, and the depth moved between their ranges. */
  private alignUnderlay(u: ShadowUnderlay): void {
    const dc = this.dynamicLight.shadow.camera;
    const sc = this.staticLight.shadow.camera;
    // The dynamic map's centre is its target; where it falls in the static map, in texels from the top-left
    // (both maps as three draws them: screen and texel coordinates from the top-left on either backend).
    const p = this.tmp.copy(this.dynamicLight.target.position).project(sc);
    const size = this.staticSize.mapSize;
    const half = this.params.mapSize / 2;
    u.offset.value.set(Math.round(((p.x + 1) / 2) * size - half), Math.round(((1 - p.y) / 2) * size - half));
    // Depth is (distance along the light − near) / (far − near) in each map; the distance differs by how far
    // apart the two cameras sit along the light.
    const dir = this.staticDir;
    const k = this.staticLight.position.dot(dir) - this.dynamicLight.position.dot(dir);
    u.scale.value = (sc.far - sc.near) / (dc.far - dc.near);
    u.shift.value = (sc.near - dc.near + k) / (dc.far - dc.near);
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
    // A static caster the map misses is drawn by the dynamic pass meanwhile; while changes are held it waits for their one redraw.
    if (renderer !== this.drawnBy || this.revision.value !== this.drawnRevision || (d.missed && !this.revision.holding) || s.drawnWith.changed()) this.staticDirty = true;
    d.missed = false;
    if (this.staticDirty) {
      // The static map drawn again (measurements line it up with the frames: a large map is a GPU frame's worth).
      perfMark('tl:shadow:static');
      s.draw(frame);
      this.staticDirty = false;
      this.drawnRevision = this.revision.value;
      this.drawnBy = renderer;
      this.counts.static += 1;
      this.totals.static += 1;
    }
    // An empty static map has nothing to copy (a scene with no static casters draws the dynamic map alone).
    const u = this.underlay;
    if (u !== null && s.drawn > 0) {
      this.alignUnderlay(u);
      d.underlay = u.mesh;
    } else d.underlay = null;
    d.draw(frame);
    this.counts.dynamic += 1;
    this.totals.dynamic += 1;
  }

  override dispose(): void {
    this.staticNode?.dispose();
    this.dynamicNode?.dispose();
    this.staticNode = null;
    this.dynamicNode = null;
    this.underlay?.dispose();
    this.underlay = null;
    this.staticDirty = true;
    super.dispose();
  }
}
