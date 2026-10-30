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
 *   its reach, so 16 bits hold it), compared in hardware with linear
 *   filtering. three's render targets need a colour attachment: the
 *   smallest there is (R8, half the depth's memory), never written; with
 *   it 12, 48 and 192 MiB at 2,048, 4,096 and 8,192.
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
 *   its reach (the frame's movers). A light seen through faces then draws
 *   only the faces a mover is in or was last drawn in (`FaceRedraws`).
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
import { LIGHT_LAYERS_ALL } from '@thirdlight/project-model';

import { shadowSeesCutaways } from './block-cutaway-view';
import { objectLightLayers } from './light-layers';
import { FaceRedraws, ShadowAtlasPlan, shadowRank, type AtlasRequest, type AtlasTile, type ShadowAtlasDiagnostics } from './shadow-atlas';
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

  /** Draw the first `count` of `tiles` (their views' cameras placed) of `scene` into the atlas. */
  draw(renderer: AtlasRenderer, scene: THREE.Scene, view: THREE.Camera, tiles: readonly { tile: AtlasTile; camera: THREE.PerspectiveCamera; mask: number }[], count: number): void {
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
      for (let i = 0; i < count; i += 1) {
        const { tile, camera, mask } = tiles[i]!;
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
  /** What its cameras were placed from (`poseOf`): unchanged, they are not placed again. */
  readonly pose: Float64Array;
  /** A light seen through faces: which faces a redraw draws. */
  readonly faces: FaceRedraws;
}

/** Numbers a light's cameras are placed from: its place, a spot's target or a turn, its cone, its far, the renderer's depth conventions. */
const POSE_NUMBERS = 10;
const _pose = new Float64Array(POSE_NUMBERS);

/** A tile drawn this frame: the view's camera and the layers that cast into it. */
interface Draw {
  tile: AtlasTile;
  camera: THREE.PerspectiveCamera;
  mask: number;
}

const _frustum = new THREE.Frustum();
const _faceFrustum = new THREE.Frustum();
const _facePv = new THREE.Matrix4();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _target = new THREE.Vector3();
const _place = new THREE.Matrix4();
const _frame = new THREE.Matrix4();
const _rotation = new THREE.Matrix4();
const _toTile = new THREE.Matrix4();
/** A spot record's tile rectangle, and a face record's corners (one a face), rewritten per light. */
const _rect: [number, number, number] = [0, 0, 1];
const _corners: ([number, number] | null)[] = [null, null, null, null, null, null];
const _cornerStore: [number, number][] = Array.from({ length: 6 }, () => [0, 0]);
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
  /** The tiles to draw this frame (entries kept from frame to frame: `drawCount` of them are this frame's). */
  private readonly draws: Draw[] = [];
  private drawCount = 0;
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
    this.drawCount = 0;
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
      // A light that stands still keeps its cameras (placing six faces a frame for every shadowed light is main-thread time).
      if (poseOf(a, renderer, _pose, k.pose)) {
        if (a.kind === 'spot') placeSpotCamera(k.cameras[0]!, a.spot!, a.reach, renderer);
        else for (let f = 0; f < CUBE_FACES; f += 1) placeFaceCamera(k.cameras[f]!, f, a, renderer);
      }
      if (!a.shadowed) continue;
      const dist = Math.hypot(p.x - eye[12]!, p.y - eye[13]!, p.z - eye[14]!);
      const seen = a.seen && _frustum.intersectsSphere(_sphere.set(p, a.reach));
      const { rank, fade } = shadowRank(a.reach, dist, seen);
      const c0 = k.cameras[0]!;
      _place.multiplyMatrices(c0.projectionMatrix, c0.matrixWorldInverse);
      const changed = k.revision !== revision || !k.drawnWith.equals(_place);
      let near = false;
      for (let m = 0; !near && m + 3 < movers.length; m += 4) near = Math.hypot(movers[m]! - p.x, movers[m + 1]! - p.y, movers[m + 2]! - p.z) < a.reach + movers[m + 3]!;
      let dirty = changed || near;
      if (a.kind !== 'spot') dirty = k.faces.note(changed, near ? moverFaces(k.cameras, this.facesOf(a), movers) : 0) || dirty;
      // A light seen through faces ranks at half weight: its faces cost six views.
      const faces = a.kind === 'spot' ? 1 : this.facesOf(a).length;
      requests.push({ key: a.key, rank: faces > 1 ? rank / 2 : rank, fade, dirty, faces });
    }
    const grants = this.plan.update(requests, dt);
    const side = this.plan.side;
    const webgl = renderer.coordinateSystem === THREE.WebGLCoordinateSystem;
    // Clip z over w → the depth a tile stores.
    const zs = webgl && !reversed ? 0.5 : 1;
    const zo = webgl && !reversed ? 0.5 : 0;
    for (const a of lights) {
      const g = grants.get(a.key);
      const k = this.keptFor(a);
      const faces = a.kind === 'spot' ? [0] : this.facesOf(a);
      if (g !== undefined && g.draw !== null) {
        const want = a.kind === 'spot' ? 1 : k.faces.draw(g.draw, faceBits(faces));
        for (let i = 0; i < g.draw.length; i += 1) if (a.kind === 'spot' || (want & (1 << faces[i]!)) !== 0) this.addDraw(g.draw[i]!, k.cameras[faces[i]!]!, a.casterMask);
        k.revision = revision;
        k.drawnWith.multiplyMatrices(k.cameras[0]!.projectionMatrix, k.cameras[0]!.matrixWorldInverse);
      }
      const tiles = g !== undefined && g.tiles !== null && g.intensity > 0 ? g.tiles : null;
      if (a.kind === 'spot') {
        // A cookie's projection needs the record even without a shadow: the whole of [0, 1]², no strength.
        if (tiles === null && !a.cookie) continue;
        const t = tiles?.[0];
        const rect = _rect;
        rect[0] = t === undefined ? 0 : t.x / side;
        rect[1] = t === undefined ? 0 : t.y / side;
        rect[2] = t === undefined ? 1 : t.size / side;
        const c = k.cameras[0]!;
        const s = rect[2];
        // Clip → the tile's texture coordinates (from the top left) and the depth its texture stores.
        const toTile = _toTile.set(0.5 * s, 0, 0, rect[0] + 0.5 * s, 0, -0.5 * s, 0, rect[1] + 0.5 * s, 0, 0, zs, zo, 0, 0, 0, 1);
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
      const corners = _corners;
      corners.fill(null);
      for (let i = 0; i < faces.length; i += 1) {
        const c = _cornerStore[i]!;
        c[0] = tiles[i]!.x / side;
        c[1] = tiles[i]!.y / side;
        corners[faces[i]!] = c;
      }
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
    if (this.gpu === null || (this.drawCount === 0 && !this.gpu.needsWipe) || renderer._isPreCompiling === true) return;
    this.gpu.draw(renderer, scene, view, this.draws, this.drawCount);
    this.drawCount = 0;
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

  private addDraw(tile: AtlasTile, camera: THREE.PerspectiveCamera, mask: number): void {
    const d = this.draws[this.drawCount];
    if (d === undefined) this.draws.push({ tile, camera, mask });
    else {
      d.tile = tile;
      d.camera = camera;
      d.mask = mask;
    }
    this.drawCount += 1;
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
      this.kept.set(a.key, (k = { cameras, drawnWith: new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), revision: -1, pose: new Float64Array(POSE_NUMBERS).fill(Number.NaN), faces: new FaceRedraws() }));
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

/**
 * What `a`'s cameras are placed from, into `out`; whether it differs from
 * `last` (then `last` takes it). A spot: its place, its target's, its cone
 * and its far; a light seen through faces: its place, its turn and its far;
 * both: the renderer's depth conventions.
 */
function poseOf(a: AtlasLight, renderer: Pick<AtlasRenderer, 'coordinateSystem' | 'reversedDepthBuffer'>, out: Float64Array, last: Float64Array): boolean {
  if (a.kind === 'spot') {
    const l = a.spot!;
    const w = l.matrixWorld.elements;
    const t = l.target.matrixWorld.elements;
    out[0] = w[12]!;
    out[1] = w[13]!;
    out[2] = w[14]!;
    out[3] = t[12]!;
    out[4] = t[13]!;
    out[5] = t[14]!;
    out[6] = l.angle;
    out[7] = l.distance > 0 ? l.distance : a.reach;
  } else {
    out[0] = a.position.x;
    out[1] = a.position.y;
    out[2] = a.position.z;
    out[3] = a.turn?.x ?? 0;
    out[4] = a.turn?.y ?? 0;
    out[5] = a.turn?.z ?? 0;
    out[6] = a.turn?.w ?? 1;
    out[7] = a.range > 0 ? a.range : a.reach;
  }
  out[8] = renderer.coordinateSystem as number;
  out[9] = renderer.reversedDepthBuffer === true ? 1 : 0;
  let changed = false;
  for (let i = 0; i < POSE_NUMBERS; i += 1) {
    if (out[i] !== last[i]) {
      changed = true;
      last[i] = out[i]!;
    }
  }
  return changed;
}

/** Face `face`'s camera of a light seen through faces: 90° at its place, turned with it, reaching its range (its reach without one). */
/** The bits of `faces`. */
function faceBits(faces: readonly number[]): number {
  let bits = 0;
  for (const f of faces) bits |= 1 << f;
  return bits;
}

/** The faces (bits) whose views hold one of the movers' spheres (x, y, z, r). */
export function moverFaces(cameras: readonly THREE.PerspectiveCamera[], faces: readonly number[], movers: ArrayLike<number>): number {
  let bits = 0;
  for (const f of faces) {
    const c = cameras[f]!;
    _facePv.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    _faceFrustum.setFromProjectionMatrix(_facePv, c.coordinateSystem, c.reversedDepth);
    for (let m = 0; m + 3 < movers.length; m += 4) {
      _sphere.center.set(movers[m]!, movers[m + 1]!, movers[m + 2]!);
      _sphere.radius = movers[m + 3]!;
      if (_faceFrustum.intersectsSphere(_sphere)) {
        bits |= 1 << f;
        break;
      }
    }
  }
  return bits;
}

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
