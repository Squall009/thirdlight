/**
 * The shadow atlas on the GPU and its frame: ONE depth texture per renderer
 * that every shadowed local light draws its shadow into, a tile for a
 * spot, a tile a face for a point light (six) or an area light (five; six
 * when it lights both sides) (`shadow-atlas.ts` plans which and how
 * large), sampled by the light loop (`cluster-lights.ts`) through the shadow
 * record each light's cluster record names. It replaces a shadow map (and a
 * texture unit, and a program key) per light.
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
 *   one): the depth's range is what the light lights. **A face's camera** is
 *   three's point-light face camera (90°, near 0.5 m; `shadow-cube.ts`) at
 *   the light, an area light's at its rectangle's middle, turned with it.
 * - **Records.** Each tiled light's shadow record (`cluster-pack.ts`
 *   `ClusterShadows`): a spot's world → atlas (the camera's projection and
 *   view, then the tile's place; the depth as its tile stores it, by the
 *   renderer's coordinate system), the tile, the shadow's strength, and its
 *   biases; a light seen through faces its frame, its faces' tiles and the
 *   terms of their stored depth. A spot projecting a cookie has its record
 *   without a tile too (its projection, no strength).
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
import { LIGHT_LAYERS_ALL } from '@thirdlight/runtime';

import { shadowSeesCutaways } from './block-cutaway-view';
import { objectLightLayers } from './light-layers';
import { ShadowAtlasPlan, shadowRank, type AtlasRequest, type AtlasTile, type ShadowAtlasDiagnostics } from './shadow-atlas';
import { AREA_BACK_FACE, CUBE_FACES, cubeDepthTerms, placeCubeFace } from './shadow-cube';

const TSL: N = TSLTyped;
const { float, positionGeometry, vec4 } = TSL;

type StateFns = { resetRendererAndSceneState(r: unknown, s: THREE.Scene, state: object): object; restoreRendererAndSceneState(r: unknown, s: THREE.Scene, state: object): void };
/** three's own save, reset and restore of the renderer and scene state around a shadow pass. */
const RendererUtils = (THREE as unknown as { RendererUtils: StateFns }).RendererUtils;

/** A shadow camera's near plane (m): three's spot and point shadow cameras'. */
export const SHADOW_CAMERA_NEAR = 0.5;
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
  /** The layers casting into the tile drawn now, and whether its tile was wiped yet. */
  private mask = LIGHT_LAYERS_ALL;
  private wiped = false;
  /**
   * Not drawn yet: the whole atlas is wiped once first. A depth texture bound
   * before anything was drawn into it fails the draws that read it on WebGL 2
   * (an incomplete texture where a shadow sampler is declared), even where no
   * record points into it.
   */
  needsWipe = true;

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

  /** Draw `tiles` (their views' cameras placed) of `scene` into the atlas. */
  draw(renderer: AtlasRenderer, scene: THREE.Scene, view: THREE.Camera, tiles: readonly { tile: AtlasTile; camera: THREE.PerspectiveCamera; mask: number }[]): void {
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
        if (this.mask !== LIGHT_LAYERS_ALL && (objectLightLayers(object) & this.mask) === 0) return;
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
      if (this.needsWipe) {
        this.needsWipe = false;
        this.wiped = false;
        renderer.render(this.wipeScene, view);
      }
      for (const { tile, camera, mask } of tiles) {
        this.target.viewport.set(tile.x, tile.y, tile.size, tile.size);
        this.target.scissor.set(tile.x, tile.y, tile.size, tile.size);
        camera.layers.mask = view.layers.mask;
        this.standIn.shadow.camera = camera;
        this.mask = mask;
        this.wiped = false;
        renderer.render(scene, camera);
        // Nothing in the tile's view to draw: the wipe alone.
        if (!this.wiped) renderer.render(this.wipeScene, camera);
      }
    } finally {
      this.mask = LIGHT_LAYERS_ALL;
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

/**
 * A light the clusters list with a shadow or a cookie: its slot in the
 * frame's lights, the object it stays (`key`), and how it is seen.
 */
export interface AtlasLight {
  readonly slot: number;
  readonly key: object;
  /** A spot (one view, its cone), a point light (six faces round it) or an area light (five or six faces from its centre). */
  readonly kind: 'spot' | 'point' | 'area';
  /** A spot's three light (its cone and target). */
  readonly spot: THREE.SpotLight | null;
  /** Where it is (world) and, for an area light, how it is turned. */
  readonly position: THREE.Vector3;
  readonly turn: THREE.Quaternion | null;
  /** Its reach (m) and its range (0: none; its shadow then reaches its reach). */
  readonly reach: number;
  readonly range: number;
  /** On and in a room that is seen (the caller's test), its room's key for the rest. */
  readonly seen: boolean;
  /** The layers whose objects cast its shadow. */
  readonly casterMask: number;
  /** It casts a shadow (asks for tiles); a spot projecting a cookie gets its record (its projection) either way. */
  readonly shadowed: boolean;
  readonly cookie: boolean;
  /** An area light lighting both sides: its sixth face too. */
  readonly twoSided: boolean;
}

export interface AtlasFrameDeps {
  /** Spheres (x, y, z, r) of what moved this frame. */
  movers(): ArrayLike<number>;
  /** The static casters' revision (a change draws every tile again). */
  staticRevision(): number;
}

interface Kept {
  /** One camera a view: a spot's one, a light seen through faces six (face order). */
  readonly cameras: THREE.PerspectiveCamera[];
  /** The first camera's projection × view the tiles were drawn with, and the static revision. */
  readonly drawnWith: THREE.Matrix4;
  revision: number;
}

/** A tile drawn this frame: the view's camera and the layers that cast into it. */
interface Draw {
  readonly tile: AtlasTile;
  readonly camera: THREE.PerspectiveCamera;
  readonly mask: number;
}

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _target = new THREE.Vector3();
const _place = new THREE.Matrix4();
const _frame = new THREE.Matrix4();
const _rotation = new THREE.Matrix4();
/** The faces of a light seen all round, and of a one-sided area light (no face behind its emitter). */
const ALL_FACES = [0, 1, 2, 3, 4, 5];
const AREA_FACES = ALL_FACES.filter((f) => f !== AREA_BACK_FACE);

/** The atlas's plan and records for each frame, and its texture on the renderer drawn. */
export class AdapterShadowAtlas {
  private plan: ShadowAtlasPlan;
  private gpu: AtlasTarget | null = null;
  private gpuRenderer: unknown = null;
  private readonly kept = new WeakMap<object, Kept>();
  readonly shadows = new ClusterShadows();
  private readonly requests: AtlasRequest[] = [];
  private draws: Draw[] = [];
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
   * Plan the frame for `camera`: tiles for the shadowed `lights` (best on
   * screen first), their shadow records written (and a cookie spot's
   * projection) and each light's `shadow` set in `input`; the tiles to draw
   * kept for `draw`.
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
    for (const a of lights) {
      const k = this.keptFor(a);
      const p = a.position;
      if (a.kind === 'spot') placeSpotCamera(k.cameras[0]!, a.spot!, a.reach, renderer);
      else for (let f = 0; f < CUBE_FACES; f += 1) placeFaceCamera(k.cameras[f]!, f, a, renderer);
      if (!a.shadowed) continue;
      const dist = Math.hypot(p.x - eye[12]!, p.y - eye[13]!, p.z - eye[14]!);
      const seen = a.seen && _frustum.intersectsSphere(_sphere.set(p, a.reach));
      const { rank, fade } = shadowRank(a.reach, dist, seen);
      const c0 = k.cameras[0]!;
      _place.multiplyMatrices(c0.projectionMatrix, c0.matrixWorldInverse);
      let dirty = k.revision !== revision || !k.drawnWith.equals(_place);
      for (let m = 0; !dirty && m + 3 < movers.length; m += 4) dirty = Math.hypot(movers[m]! - p.x, movers[m + 1]! - p.y, movers[m + 2]! - p.z) < a.reach + movers[m + 3]!;
      // A light seen through faces ranks at half weight: its faces cost six views.
      const faces = a.kind === 'spot' ? 1 : this.facesOf(a).length;
      requests.push({ key: a.key, rank: faces > 1 ? rank / 2 : rank, fade, dirty, faces });
    }
    const grants = this.plan.update(requests, dt);
    const side = this.plan.side;
    const webgl = renderer.coordinateSystem === THREE.WebGLCoordinateSystem;
    // Clip z over w → the depth a tile stores.
    const [zs, zo] = webgl && !reversed ? [0.5, 0.5] : [1, 0];
    for (const a of lights) {
      const g = grants.get(a.key);
      const k = this.keptFor(a);
      const faces = a.kind === 'spot' ? [0] : this.facesOf(a);
      if (g !== undefined && g.draw !== null) {
        g.draw.forEach((tile, i) => this.draws.push({ tile, camera: k.cameras[faces[i]!]!, mask: a.casterMask }));
        k.revision = revision;
        k.drawnWith.multiplyMatrices(k.cameras[0]!.projectionMatrix, k.cameras[0]!.matrixWorldInverse);
      }
      const tiles = g !== undefined && g.tiles !== null && g.intensity > 0 ? g.tiles : null;
      if (a.kind === 'spot') {
        // A cookie's projection needs the record even without a shadow: the whole of [0, 1]², no strength.
        if (tiles === null && !a.cookie) continue;
        const t = tiles?.[0];
        const rect: [number, number, number] = t === undefined ? [0, 0, 1] : [t.x / side, t.y / side, t.size / side];
        const c = k.cameras[0]!;
        const s = rect[2];
        // Clip → the tile's texture coordinates (from the top left) and the depth its texture stores.
        const toTile = new THREE.Matrix4().set(0.5 * s, 0, 0, rect[0] + 0.5 * s, 0, -0.5 * s, 0, rect[1] + 0.5 * s, 0, 0, zs, zo, 0, 0, 0, 1);
        toTile.multiply(c.projectionMatrix).multiply(c.matrixWorldInverse);
        // One tile texel's size per metre from the light: 2 tan(half angle) / side.
        const texelPerMetre = t === undefined ? 0 : (2 * Math.tan(a.spot!.angle)) / t.size;
        input.shadow[a.slot] = this.shadows.add({ matrix: toTile.elements, rect, intensity: tiles === null ? 0 : g!.intensity, near: c.near, far: c.far, bias: ATLAS_DEPTH_BIAS, normalBias: texelPerMetre * ATLAS_NORMAL_BIAS_TEXELS });
        continue;
      }
      if (tiles === null) continue;
      // World → the light's frame (its faces' axes): its turn undone, from its place.
      _rotation.identity();
      if (a.turn !== null) _rotation.makeRotationFromQuaternion(a.turn);
      _frame.copy(_rotation).setPosition(a.position).invert();
      const corners: ([number, number] | null)[] = [null, null, null, null, null, null];
      faces.forEach((f, i) => (corners[f] = [tiles[i]!.x / side, tiles[i]!.y / side]));
      const c = k.cameras[0]!;
      input.shadow[a.slot] = this.shadows.addCube({
        matrix: _frame.elements,
        near: c.near,
        far: c.far,
        bias: ATLAS_DEPTH_BIAS,
        // A face is 90° across: 2 / its side, a texel's size per metre.
        normalBias: (2 / tiles[0]!.size) * ATLAS_NORMAL_BIAS_TEXELS,
        depth: cubeDepthTerms(c.projectionMatrix.elements, zs, zo),
        intensity: g!.intensity,
        size: tiles[0]!.size / side,
        faces: corners,
      });
    }
  }

  /** Draw the planned tiles (before the frame's own render). */
  draw(renderer: AtlasRenderer, scene: THREE.Scene, view: THREE.Camera): void {
    if (this.gpu === null || (this.draws.length === 0 && !this.gpu.needsWipe) || renderer._isPreCompiling === true) return;
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

  /** The faces a light seen through faces draws, in tile order. */
  private facesOf(a: AtlasLight): readonly number[] {
    return a.kind === 'area' && !a.twoSided ? AREA_FACES : ALL_FACES;
  }

  private keptFor(a: AtlasLight): Kept {
    let k = this.kept.get(a.key);
    const views = a.kind === 'spot' ? 1 : CUBE_FACES;
    if (k === undefined || k.cameras.length !== views) {
      const cameras = Array.from({ length: views }, () => {
        const camera = new THREE.PerspectiveCamera(a.kind === 'spot' ? 50 : 90, 1, SHADOW_CAMERA_NEAR, 500);
        // What a block layer cuts away from the view still casts.
        shadowSeesCutaways(camera);
        return camera;
      });
      this.kept.set(a.key, (k = { cameras, drawnWith: new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), revision: -1 }));
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

/** `camera`'s projection for `renderer`'s depth conventions, `fov` degrees, reaching `far` (made again only when one changed). */
function project(camera: THREE.PerspectiveCamera, fov: number, far: number, renderer: Pick<AtlasRenderer, 'coordinateSystem' | 'reversedDepthBuffer'>): void {
  const reversed = renderer.reversedDepthBuffer === true;
  const c = camera as THREE.PerspectiveCamera & { _reversedDepth?: boolean };
  if (camera.fov === fov && camera.far === far && camera.coordinateSystem === renderer.coordinateSystem && (c._reversedDepth === true) === reversed) return;
  camera.fov = fov;
  camera.aspect = 1;
  camera.near = SHADOW_CAMERA_NEAR;
  camera.far = far;
  camera.coordinateSystem = renderer.coordinateSystem as THREE.CoordinateSystem;
  c._reversedDepth = reversed;
  camera.updateProjectionMatrix();
}

/** Face `face`'s camera of a light seen through faces: 90° at its place, turned with it, reaching its range (its reach without one). */
function placeFaceCamera(camera: THREE.PerspectiveCamera, face: number, a: AtlasLight, renderer: Pick<AtlasRenderer, 'coordinateSystem' | 'reversedDepthBuffer'>): void {
  project(camera, 90, Math.max(SHADOW_CAMERA_NEAR * 2, a.range > 0 ? a.range : a.reach), renderer);
  placeCubeFace(camera, face, a.position, a.turn);
}

/** `camera` as three's spot shadow camera for `light` (its cone, near 0.5 m) reaching `reach` metres, in `renderer`'s depth conventions. */
export function placeSpotCamera(camera: THREE.PerspectiveCamera, light: THREE.SpotLight, reach: number, renderer: Pick<AtlasRenderer, 'coordinateSystem' | 'reversedDepthBuffer'>): void {
  project(camera, THREE.MathUtils.RAD2DEG * 2 * light.angle, Math.max(SHADOW_CAMERA_NEAR * 2, light.distance > 0 ? light.distance : reach), renderer);
  const w = light.matrixWorld.elements;
  _target.setFromMatrixPosition(light.target.matrixWorld);
  // As three's spot shadow: at the light, looking at its target (lookAt reads the world matrix it brings up to date).
  camera.position.set(w[12]!, w[13]!, w[14]!);
  camera.lookAt(_target);
  camera.updateMatrixWorld(true);
}
