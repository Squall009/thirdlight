/**
 * The shadow atlas on the GPU and its frame: ONE depth texture per renderer
 * that every shadowed spot light draws its shadow into, a tile each
 * (`shadow-atlas.ts` plans which and how large), sampled by the light loop
 * (`cluster-lights.ts`) through the shadow record each light's cluster
 * record names. It replaces a shadow map (and a texture unit, and a program
 * key) per light.
 *
 * - **The texture.** A square `DepthTexture` of the quality level's side,
 *   16-bit (`depth16unorm` / `DEPTH_COMPONENT16`: a spot's depth range is
 *   its reach, so 16 bits hold it; 8, 32 and 128 MiB at 2,048, 4,096 and
 *   8,192), compared in hardware with linear filtering. three's render
 *   targets need a colour attachment: the smallest there is (R8, half the
 *   depth's memory), never written.
 * - **Drawing a tile.** Through three's own shadow pass: the scene drawn with
 *   three's shadow material as the override and three's shadow
 *   render-object function (a stand-in light's `ShadowNode` gives both), so
 *   alpha-masked, see-through, bending and instanced casters draw into a
 *   tile exactly as into a light's own shadow map; a layered light's
 *   shadow-caster mask filters the casters. The render target's viewport is
 *   the tile, with no clear (the other tiles stay): the tile's old depth is
 *   wiped by a quad drawn first at the far depth with the depth test off.
 * - **A spot's camera** is three's spot shadow camera (its cone's angle,
 *   near 0.5 m), reaching as far as the light's range (its reach without
 *   one): the depth's range is what the light lights.
 * - **Records.** Each tiled light's shadow record (`cluster-pack.ts`
 *   `ClusterShadows`): world → atlas (the camera's projection and view, then
 *   the tile's place; the depth as its tile stores it, by the renderer's
 *   coordinate system), the tile, the shadow's strength, and its biases.
 * - **Redraws** (`dirty`): the light moved or turned (its camera changed),
 *   the static casters changed (their revision), or something moved within
 *   its reach (the frame's movers).
 *
 * Diagnostics: `renderer.shadowAtlas` (side, lights, tiled, waiting, tiles
 * and texels drawn a frame, the share of the atlas in tiles, MiB).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { ClusterLights } from './cluster-build';
import type { ClusterGpu } from './cluster-gpu';
import { ClusterShadows } from './cluster-pack';
import type { N } from './effects-tsl';
import { shadowSeesCutaways } from './block-cutaway-view';
import { castsShadowFor, roomKeyOf } from './light-layers';
import { ShadowAtlasPlan, shadowRank, type AtlasRequest, type AtlasTile, type ShadowAtlasDiagnostics } from './shadow-atlas';

const TSL: N = TSLTyped;
const { float, positionGeometry, vec4 } = TSL;

type StateFns = { resetRendererAndSceneState(r: unknown, s: THREE.Scene, state: object): object; restoreRendererAndSceneState(r: unknown, s: THREE.Scene, state: object): void };
/** three's own save, reset and restore of the renderer and scene state around a shadow pass. */
const RendererUtils = (THREE as unknown as { RendererUtils: StateFns }).RendererUtils;

/** A spot shadow camera's near plane (m): three's spot shadow camera's. */
export const SPOT_SHADOW_NEAR = 0.5;
/** Depth bias (three's convention: added to the compared depth; toward the light is negative). */
export const ATLAS_DEPTH_BIAS = -0.0002;
/** The receiving point moves along its normal this many of its tile's texels (their size where it is). */
export const ATLAS_NORMAL_BIAS_TEXELS = 1;

/** What a renderer offers the atlas (either backend). */
export interface AtlasRenderer {
  readonly coordinateSystem: number;
  readonly reversedDepthBuffer?: boolean;
  readonly _isPreCompiling?: boolean;
  autoClear: boolean;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  setRenderTarget(target: THREE.RenderTarget | null): void;
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderObjectFunction(fn: unknown): void;
  getRenderObjectFunction(): unknown;
  getMRT(): unknown;
  setMRT(mrt: unknown): void;
  shadowMap: { type: number };
}

type RenderObjectFn = (object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, group: unknown, ...rest: unknown[]) => void;

/** One renderer's atlas: the render target, three's shadow material and render-object function, the wiping quad. */
class AtlasTarget {
  readonly target: THREE.RenderTarget;
  readonly depth: THREE.DepthTexture;
  /** A light that is only a shadow: three's shadow material and render-object function are kept per light. */
  private readonly standIn = new THREE.SpotLight();
  private readonly shadowNode: { getShadowMaterial(): THREE.Material; getShadowRenderObjectFunction(renderer: unknown, shadow?: unknown): RenderObjectFn; dispose(): void };
  private readonly wipe: THREE.Mesh;
  private readonly wipeScene = new THREE.Scene();
  private base: RenderObjectFn | null = null;
  private filtered: RenderObjectFn | null = null;
  /** The light whose tile is drawn now, and whether its tile was wiped yet. */
  private light: THREE.Light | null = null;
  private wiped = false;

  constructor(
    readonly side: number,
    readonly reversed: boolean,
  ) {
    const depth = new THREE.DepthTexture(side, side, THREE.UnsignedShortType);
    depth.name = 'ShadowAtlasDepth';
    depth.compareFunction = reversed ? THREE.GreaterEqualCompare : THREE.LessEqualCompare;
    depth.minFilter = THREE.LinearFilter;
    depth.magFilter = THREE.LinearFilter;
    this.target = new THREE.RenderTarget(side, side, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, depthTexture: depth, generateMipmaps: false });
    this.target.texture.name = 'ShadowAtlas';
    this.depth = depth;
    this.shadowNode = new (THREE.ShadowNode as unknown as new (l: THREE.Light, s: THREE.LightShadow) => AtlasTarget['shadowNode'])(this.standIn, this.standIn.shadow);
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'shadow atlas wipe';
    // Drawn with this material in the shadow pass, not the pass's override.
    (m as unknown as { allowOverride: boolean }).allowOverride = false;
    m.colorWrite = false;
    m.depthFunc = THREE.AlwaysDepth;
    m.side = THREE.DoubleSide;
    m.fog = false;
    m.lights = false;
    m.vertexNode = vec4(positionGeometry.xy, 0, 1);
    (m as unknown as { depthNode: N }).depthNode = float(reversed ? 0 : 1);
    this.wipe = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
    this.wipe.name = 'shadow atlas wipe';
    this.wipe.frustumCulled = false;
    this.wipe.castShadow = true;
    this.wipeScene.add(this.wipe);
    this.wipeScene.matrixWorldAutoUpdate = false;
    this.wipe.updateMatrixWorld();
  }

  /** Draw `tiles` (their lights' cameras placed) of `scene` into the atlas. */
  draw(renderer: AtlasRenderer, scene: THREE.Scene, view: THREE.Camera, tiles: readonly { tile: AtlasTile; camera: THREE.PerspectiveCamera; light: THREE.Light }[]): void {
    const state = RendererUtils.resetRendererAndSceneState(renderer, scene, {});
    const base = this.shadowNode.getShadowRenderObjectFunction(renderer, this.standIn.shadow);
    if (base !== this.base) {
      this.base = base;
      this.filtered = (object, s, camera, geometry, material, group, ...rest) => {
        // The tile's old depth wiped first (the render-object calls come in draw order).
        if (!this.wiped) {
          this.wiped = true;
          base(this.wipe, s, camera, this.wipe.geometry, this.wipe.material as THREE.Material, null, ...rest);
        }
        if (object === this.wipe) return;
        if (this.light !== null && !castsShadowFor(this.light, object)) return;
        base(object, s, camera, geometry, material, group, ...rest);
      };
    }
    // The pass's name in GPU timings and captures.
    const name = scene.name;
    scene.name = 'Shadow atlas';
    try {
      renderer.autoClear = false;
      scene.overrideMaterial = this.shadowNode.getShadowMaterial();
      renderer.setRenderObjectFunction(this.filtered);
      renderer.setRenderTarget(this.target);
      for (const { tile, camera, light } of tiles) {
        this.target.viewport.set(tile.x, tile.y, tile.size, tile.size);
        this.target.scissor.set(tile.x, tile.y, tile.size, tile.size);
        camera.layers.mask = view.layers.mask;
        this.standIn.shadow.camera = camera;
        this.light = light;
        this.wiped = false;
        renderer.render(scene, camera);
        // Nothing in the tile's view to draw: the wipe alone.
        if (!this.wiped) renderer.render(this.wipeScene, camera);
      }
    } finally {
      this.light = null;
      scene.name = name;
      this.target.viewport.set(0, 0, this.side, this.side);
      this.target.scissor.set(0, 0, this.side, this.side);
      RendererUtils.restoreRendererAndSceneState(renderer, scene, state);
    }
  }

  dispose(): void {
    this.target.dispose();
    this.depth.dispose();
    this.shadowNode.dispose();
    this.wipe.geometry.dispose();
    (this.wipe.material as THREE.Material).dispose();
  }
}

/** A shadowed light the clusters list: its slot in the frame's lights and its reach (m). */
export interface AtlasLight {
  readonly slot: number;
  readonly light: THREE.SpotLight;
  readonly reach: number;
}

export interface AtlasFrameDeps {
  /** Whether the room a light is in is seen (no room: true). */
  roomSeen(key: number | undefined): boolean;
  /** Spheres (x, y, z, r) of what moved this frame. */
  movers(): ArrayLike<number>;
  /** The static casters' revision (a change draws every tile again). */
  staticRevision(): number;
}

interface Kept {
  readonly camera: THREE.PerspectiveCamera;
  /** The camera's projection × view the tile was drawn with, and the static revision. */
  readonly drawnWith: THREE.Matrix4;
  revision: number;
}

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _place = new THREE.Matrix4();

/** The atlas's plan and records for each frame, and its texture on the renderer drawn. */
export class AdapterShadowAtlas {
  private plan: ShadowAtlasPlan;
  private gpu: AtlasTarget | null = null;
  private gpuRenderer: unknown = null;
  private readonly kept = new WeakMap<THREE.Light, Kept>();
  readonly shadows = new ClusterShadows();
  private readonly requests: AtlasRequest[] = [];
  private readonly byKey = new Map<object, AtlasLight>();
  private draws: { tile: AtlasTile; camera: THREE.PerspectiveCamera; light: THREE.Light }[] = [];
  private lastAt = -1;

  constructor(
    private readonly d: AtlasFrameDeps,
    side: number,
  ) {
    this.plan = new ShadowAtlasPlan(side);
  }

  /** The quality level's side (texels): every tile is drawn again in a new atlas. */
  setSide(side: number): void {
    if (side === this.plan.side) return;
    this.dropGpu();
    this.plan.reset(side);
  }

  /**
   * Plan the frame for `camera`: tiles for `lights` (best on screen first),
   * their shadow records written and each light's `shadow` slot set in
   * `input`; the tiles to draw kept for `draw`.
   */
  prepare(renderer: AtlasRenderer, gpu: ClusterGpu, camera: THREE.Camera, lights: readonly AtlasLight[], input: ClusterLights): void {
    this.shadows.clear();
    this.draws = [];
    const now = performance.now();
    const dt = this.lastAt < 0 ? 0 : (now - this.lastAt) / 1000;
    this.lastAt = now;
    if (lights.length === 0 && this.gpu === null) return;
    if (this.gpuRenderer !== renderer) this.dropGpu();
    const reversed = renderer.reversedDepthBuffer === true;
    if (this.gpu === null || this.gpu.reversed !== reversed) {
      this.gpu?.dispose();
      this.gpu = new AtlasTarget(this.plan.side, reversed);
      this.gpuRenderer = renderer;
    }
    gpu.setAtlas(this.gpu.depth);
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv, camera.coordinateSystem);
    const eye = camera.matrixWorld.elements;
    const movers = this.d.movers();
    const revision = this.d.staticRevision();
    const requests = this.requests;
    requests.length = 0;
    this.byKey.clear();
    for (const a of lights) {
      const l = a.light;
      const k = this.keptFor(l);
      placeSpotCamera(k.camera, l, a.reach, renderer);
      const w = l.matrixWorld.elements;
      _pos.set(w[12]!, w[13]!, w[14]!);
      const dist = Math.hypot(_pos.x - eye[12]!, _pos.y - eye[13]!, _pos.z - eye[14]!);
      const seen = l.visible && this.d.roomSeen(roomKeyOf(l)) && _frustum.intersectsSphere(_sphere.set(_pos, a.reach));
      const { rank, fade } = shadowRank(a.reach, dist, seen);
      _place.multiplyMatrices(k.camera.projectionMatrix, k.camera.matrixWorldInverse);
      let dirty = k.revision !== revision || !k.drawnWith.equals(_place);
      for (let m = 0; !dirty && m + 3 < movers.length; m += 4) dirty = Math.hypot(movers[m]! - _pos.x, movers[m + 1]! - _pos.y, movers[m + 2]! - _pos.z) < a.reach + movers[m + 3]!;
      requests.push({ key: l, rank, fade, dirty });
      this.byKey.set(l, a);
    }
    const grants = this.plan.update(requests, dt);
    const side = this.plan.side;
    const webgl = renderer.coordinateSystem === THREE.WebGLCoordinateSystem;
    for (const [key, g] of grants) {
      const a = this.byKey.get(key)!;
      const k = this.keptFor(a.light);
      if (g.draw !== null) {
        this.draws.push({ tile: g.draw, camera: k.camera, light: a.light });
        k.revision = revision;
        k.drawnWith.multiplyMatrices(k.camera.projectionMatrix, k.camera.matrixWorldInverse);
      }
      if (g.tile === null || g.intensity <= 0) continue;
      const t = g.tile;
      const u0 = t.x / side;
      const v0 = t.y / side;
      const s = t.size / side;
      // Clip → the tile's texture coordinates (from the top left) and the depth its texture stores.
      const z = webgl && !reversedProjection(renderer) ? [0.5, 0.5] : [1, 0];
      const toTile = new THREE.Matrix4().set(0.5 * s, 0, 0, u0 + 0.5 * s, 0, -0.5 * s, 0, v0 + 0.5 * s, 0, 0, z[0]!, z[1]!, 0, 0, 0, 1);
      toTile.multiply(k.camera.projectionMatrix).multiply(k.camera.matrixWorldInverse);
      // One tile texel's size per metre from the light: 2 tan(half angle) / side.
      const texelPerMetre = (2 * Math.tan(a.light.angle)) / t.size;
      input.shadow[a.slot] = this.shadows.add({ matrix: toTile.elements, rect: [u0, v0, s], intensity: g.intensity, near: k.camera.near, far: k.camera.far, bias: ATLAS_DEPTH_BIAS, normalBias: texelPerMetre * ATLAS_NORMAL_BIAS_TEXELS });
    }
  }

  /** Draw the planned tiles (before the frame's own render). */
  draw(renderer: AtlasRenderer, scene: THREE.Scene, view: THREE.Camera): void {
    if (this.draws.length === 0 || this.gpu === null || renderer._isPreCompiling === true) return;
    this.gpu.draw(renderer, scene, view, this.draws);
    this.draws = [];
  }

  /** Whether the next frames draw something else (a host drawing on demand must draw them). */
  moving(): boolean {
    return this.plan.moving();
  }

  diagnostics(): (ShadowAtlasDiagnostics & { mib: number }) | null {
    if (this.gpu === null) return null;
    const side = this.plan.side;
    // 16-bit depth and the 8-bit colour three's render target needs.
    return { ...this.plan.diagnostics(), mib: (side * side * 3) / (1024 * 1024) };
  }

  dispose(): void {
    this.dropGpu();
  }

  private keptFor(l: THREE.Light): Kept {
    let k = this.kept.get(l);
    if (k === undefined) {
      const camera = new THREE.PerspectiveCamera(50, 1, SPOT_SHADOW_NEAR, 500);
      // What a block layer cuts away from the view still casts.
      shadowSeesCutaways(camera);
      this.kept.set(l, (k = { camera, drawnWith: new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), revision: -1 }));
    }
    return k;
  }

  /** A new renderer or side: the old one's texture goes (every tile is drawn again). */
  private dropGpu(): void {
    this.gpu?.dispose();
    this.gpu = null;
    this.gpuRenderer = null;
    this.plan.reset(this.plan.side);
  }
}

/** Whether `renderer` draws with a reversed depth buffer (its projections map the near plane to 1). */
function reversedProjection(renderer: AtlasRenderer): boolean {
  return renderer.reversedDepthBuffer === true;
}

/** `camera` as three's spot shadow camera for `light` (its cone, near 0.5 m) reaching `reach` metres, in `renderer`'s depth conventions. */
export function placeSpotCamera(camera: THREE.PerspectiveCamera, light: THREE.SpotLight, reach: number, renderer: Pick<AtlasRenderer, 'coordinateSystem' | 'reversedDepthBuffer'>): void {
  const fov = THREE.MathUtils.RAD2DEG * 2 * light.angle;
  const far = Math.max(SPOT_SHADOW_NEAR * 2, light.distance > 0 ? light.distance : reach);
  const reversed = renderer.reversedDepthBuffer === true;
  const c = camera as THREE.PerspectiveCamera & { _reversedDepth?: boolean };
  if (camera.fov !== fov || camera.far !== far || camera.coordinateSystem !== renderer.coordinateSystem || (c._reversedDepth === true) !== reversed) {
    camera.fov = fov;
    camera.aspect = 1;
    camera.near = SPOT_SHADOW_NEAR;
    camera.far = far;
    camera.coordinateSystem = renderer.coordinateSystem as THREE.CoordinateSystem;
    c._reversedDepth = reversed;
    camera.updateProjectionMatrix();
  }
  const w = light.matrixWorld.elements;
  _pos.set(w[12]!, w[13]!, w[14]!);
  _target.setFromMatrixPosition(light.target.matrixWorld);
  // As three's spot shadow: at the light, looking at its target (lookAt reads the world matrix it brings up to date).
  camera.position.copy(_pos);
  camera.lookAt(_target);
  camera.updateMatrixWorld(true);
}
