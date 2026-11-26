/**
 * The plain look of gas (fog) near the eye: a chunk's gas part (the voxel
 * derive's quads of gas faces against open space, derived-gas.ts) drawn as one
 * more mesh of the chunk's draw, flat in its material's colour and
 * see-through by how much gas lies behind each pixel. No light, no march,
 * no drift: a hull and a thickness.
 *
 * - **Colour and density.** The gas material's colour and its full density
 *   per metre, read from the surface's material table in the vertex stage
 *   (`VoxelSurface.gasLook`): a record's change reaches the fog with no mesh
 *   change.
 * - **See-through by density.** A hull has no inside, so how much gas a
 *   pixel looks through is made from two things it does have: the scene's
 *   depth behind the face (three's copy of the depth buffer as drawn before
 *   transparent surfaces) and the densities the derive wrote on each quad
 *   (its own cell's and the cell's behind it). The gas along the view ray
 *   runs from the face to the scene behind it, at most
 *   {@link GAS_DEPTH_CAP_M}; its first cell is at the face's own density,
 *   the rest at the density behind; the pixel's opacity is 1 − exp(−density
 *   a metre × that length). So fog thins to nothing where it meets the
 *   ground (no hard line at the contact), a fill's soft top reads thin, and
 *   a bank in a hollow reads as deep as the hollow. What it cannot know is
 *   where a bank ends in the air: fog standing free reads as thick as the
 *   scene behind it is far.
 * - **From inside.** With the eye in a gas cell the hull is behind or
 *   beside it and most view rays end on the ground without crossing a face.
 *   Then one screen-wide layer draws the fog between the eye and the scene:
 *   the eye's column of gas (the part's runs) taken as a level slab, its
 *   top and bottom the run's, wide without end, at the run's mean density.
 *   A ray leaves it through its top or bottom or ends at the scene, at most
 *   {@link GAS_DEPTH_CAP_M}; the layer comes in over the first
 *   {@link GAS_EYE_FADE_M} under the run's top, and while it draws, hull
 *   faces between the slab's heights are left out (the slab already holds
 *   that fog).
 * - **Light and shadows.** Unlit: no sun, lamp or light volume, no shadow
 *   cast or received. The hull takes the scene's distance and height fog at
 *   its own depth, as any draw does.
 * - **Order.** Blended, depth tested, no depth written, front faces only.
 *   Hull meshes sort with the scene's other transparent draws by three's
 *   order (back to front by object); the eye's layer draws after them all.
 *   Liquid is opaque and in the scene's depth, so fog over water is exact.
 *   A transparent draw inside a bank is fogged or not by that order, never
 *   per pixel.
 * - **The density overlay** (an editor's switch): the hull drawn nearly
 *   opaque, each face in a colour for its own cell's density, so thin fog
 *   can be found and erased; the eye's layer is off under it.
 * - **Cost.** One draw a chunk that shows gas and the eye's layer (three
 *   vertices, no pixels while the eye is outside). Its programs, and the
 *   depth copy they read, are made with the first gas part: a world with no
 *   gas compiles nothing.
 */
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { GAS_DENSITY_FULL, GAS_STEPS_PER_CELL, gasRunAt, VOXEL_SIZE_M, type ChunkGrid, type FloatingOrigin, type GasPart } from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
import { disposeObjectTree } from './dispose';
import type { N } from './effects-tsl';
import { geometryBytes, mediumQuadGeometry, type MediumQuadExtra } from './voxel-medium-geometry';
import type { VoxelSurface } from './voxel-surface';

const TSL: N = TSLTyped;
const { Fn, abs, attribute, cameraFar, cameraNear, cameraProjectionMatrixInverse, cameraWorldMatrix, dot, exp, float, length, max, min, mix, normalView, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, renderGroup, select, step, uniform, varying, vec3, vec4, viewportDepthTexture } = TSL;

/** The gas geometry's attribute holding each vertex's material id. */
export const VOXEL_GAS_MATERIAL_ATTRIBUTE = 'voxelGasMaterial';

/** The gas geometry's attribute holding each vertex's two densities (its face's own cell's, the cell's behind it; 0 … 1). */
export const VOXEL_GAS_DENSITY_ATTRIBUTE = 'voxelGasDensity';

/** `mesh.userData[VOXEL_GAS_KEY]`: a chunk's gas mesh (counted apart from its surface). */
export const VOXEL_GAS_KEY = '__tlVoxelGas';

/** The most gas (metres along the view ray) a pixel is drawn through: the widest detail ring; past it no gas is drawn at all. */
export const GAS_DEPTH_CAP_M = 64;

/** Metres under its run's top over which the eye's layer comes in, so crossing a bank's surface does not switch the fog on at once. */
export const GAS_EYE_FADE_M = 1;

/** The least cosine between the view ray and a face's normal the first cell's length is made with (a grazing ray would cross it for ever). */
const GAS_GRAZE_COS = 0.05;

/** The overlay's opacity, and its colours from the thinnest density to the full one. */
const GAS_OVERLAY_ALPHA = 0.85;
const GAS_OVERLAY_RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [0.05, 0.2, 1],
  [1, 0.85, 0.05],
  [1, 0.05, 0.02],
];

/** How many chunks up or down a run is followed across chunk and section borders (far more than a detail ring is tall). */
const GAS_RUN_STEPS = 64;

const DENSITIES: MediumQuadExtra = {
  name: VOXEL_GAS_DENSITY_ATTRIBUTE,
  itemSize: 2,
  write: (extra, out, at) => {
    out[at] = (extra & 15) / GAS_DENSITY_FULL;
    out[at + 1] = (extra >>> 4) / GAS_DENSITY_FULL;
  },
};

/**
 * A chunk's gas quads as a float geometry (null: none): four vertices a
 * quad, positions in metres from the chunk's corner, the face's outward
 * normal, the quad's material and its two densities.
 */
export function gasGeometry(part: GasPart | null | undefined): THREE.BufferGeometry | null {
  return mediumQuadGeometry(part, VOXEL_SIZE_M / GAS_STEPS_PER_CELL, VOXEL_GAS_MATERIAL_ATTRIBUTE, DENSITIES);
}

/** The eye's gas: the run of its column it stands in (rows of the view's grid, a row past the last), its material and its cells' mean density (0 … 1). */
export interface GasEyeRun {
  readonly y0: number;
  readonly y1: number;
  readonly material: number;
  readonly density: number;
}

/** What the eye's layer draws with: its opacity a metre (0: off), the slab's top over the eye and its bottom under it (metres), and its colour. */
export interface GasEyeSlab {
  readonly perMetre: number;
  readonly aboveM: number;
  readonly belowM: number;
  readonly colour: readonly [number, number, number];
}

/**
 * The slab the eye's layer draws for an eye at height `y` (rows, as the
 * run's) in `run` (null: not in gas) of a gas of `colour` and `density` a
 * metre at its full density.
 */
export function gasEyeSlab(run: GasEyeRun | null, y: number, colour: readonly [number, number, number], density: number): GasEyeSlab {
  if (run === null || !(y >= run.y0 && y < run.y1)) return { perMetre: 0, aboveM: 0, belowM: 0, colour: [0, 0, 0] };
  const aboveM = (run.y1 - y) * VOXEL_SIZE_M;
  const belowM = (y - run.y0) * VOXEL_SIZE_M;
  return { perMetre: density * run.density * Math.min(1, aboveM / GAS_EYE_FADE_M), aboveM, belowM, colour };
}

/** The gas programs of a view (one hull program for all its chunks, one for the eye's layer), made with the first gas part. */
export class VoxelGasLook {
  private hull: THREE.Material | null = null;
  private eye: THREE.Material | null = null;
  /** x: the eye's layer's opacity a metre (0: off); y, z: its slab's top over the eye and bottom under it (metres). */
  readonly slab = new THREE.Vector4();
  readonly slabColour = new THREE.Vector3();
  private readonly slabU: N;
  private readonly slabColourU: N;
  private readonly overlayU: N = uniform(0);

  /** `before`: run once a render, before the first gas draw of it, with the render's camera (it sets {@link slab}). */
  constructor(
    private readonly surface: VoxelSurface,
    before: (camera: THREE.Camera) => void,
  ) {
    this.slabU = uniform(this.slab)
      .setGroup(renderGroup)
      .onRenderUpdate(({ camera }: { camera: THREE.Camera }) => (before(camera), this.slab));
    this.slabColourU = uniform(this.slabColour);
  }

  /** Whether a program of its was made (a world that showed no gas never makes one). */
  get built(): boolean {
    return this.hull !== null || this.eye !== null;
  }

  /** Whether the hull draws the density overlay. */
  get overlay(): boolean {
    return (this.overlayU.value as number) > 0.5;
  }

  set overlay(on: boolean) {
    this.overlayU.value = on ? 1 : 0;
  }

  /** The hull's program: a chunk's gas faces. */
  get material(): THREE.Material {
    if (this.hull !== null) return this.hull;
    const m = cameraRelative(new MeshBasicNodeMaterial());
    m.name = 'voxel gas';
    m.transparent = true;
    m.depthWrite = false;
    m.side = THREE.FrontSide;
    m.lights = false;
    const look = varying(this.surface.gasLook(attribute(VOXEL_GAS_MATERIAL_ATTRIBUTE, 'float')));
    const density = varying(attribute(VOXEL_GAS_DENSITY_ATTRIBUTE, 'vec2'));
    m.colorNode = Fn(() => {
      // The scene behind this pixel as drawn before transparent surfaces, along the view axis (negative, as positionView.z).
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture().x, cameraNear, cameraFar);
      // View depth to length along the ray.
      const along = length(positionView).div(max(positionView.z.negate(), 1e-3));
      const depth = min(max(positionView.z.sub(sceneZ), 0).mul(along), GAS_DEPTH_CAP_M).toVar();
      const cosN = max(abs(dot(normalize(positionView), normalView)), GAS_GRAZE_COS);
      const first = min(depth, float(VOXEL_SIZE_M).div(cosN));
      const through = look.a.mul(density.x.mul(first).add(density.y.mul(depth.sub(first))));
      // This pixel's height over the eye: inside the eye's slab the layer already draws this fog.
      const up = cameraWorldMatrix.mul(vec4(positionView, 0)).y;
      const inSlab = this.slabU.x.greaterThan(0).and(up.lessThan(this.slabU.y)).and(up.greaterThan(this.slabU.z.negate()));
      const alpha = select(inSlab, float(0), float(1).sub(exp(through.negate())));
      const [thin, half, full] = GAS_OVERLAY_RAMP.map((c) => vec3(...c));
      const ramp = mix(mix(thin, half, min(density.x.mul(2), 1)), full, max(density.x.mul(2).sub(1), 0));
      return vec4(mix(look.rgb, ramp, this.overlayU), mix(alpha, float(GAS_OVERLAY_ALPHA), this.overlayU));
    })();
    this.hull = m;
    return m;
  }

  /** The eye's layer's program: one triangle over the screen, no pixels while the eye is outside gas. */
  get eyeMaterial(): THREE.Material {
    if (this.eye !== null) return this.eye;
    const m = new MeshBasicNodeMaterial();
    m.name = 'voxel gas eye';
    m.transparent = true;
    m.depthTest = false;
    m.depthWrite = false;
    m.lights = false;
    // Its pixels have no place in the scene for the scene's fog to read.
    m.fog = false;
    const on = step(1e-6, this.slabU.x).mul(float(1).sub(this.overlayU));
    // A triangle over the screen in clip space; collapsed to a point while the layer is off.
    m.vertexNode = vec4(positionGeometry.xy.mul(on), 0, 1);
    const clip = varying(positionGeometry.xy);
    m.colorNode = Fn(() => {
      const far = cameraProjectionMatrixInverse.mul(vec4(clip, 0.5, 1));
      const ray = normalize(far.xyz.div(far.w)).toVar();
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture().x, cameraNear, cameraFar);
      const toScene = sceneZ.negate().div(max(ray.z.negate(), 1e-3));
      const up = cameraWorldMatrix.mul(vec4(ray, 0)).y.toVar();
      // Where the ray leaves the slab: through its top going up, its bottom going down.
      const out = select(up.greaterThan(0), this.slabU.y.div(max(up, 1e-4)), this.slabU.z.div(max(up.negate(), 1e-4)));
      const depth = min(min(toScene, out), GAS_DEPTH_CAP_M);
      return vec4(this.slabColourU, float(1).sub(exp(this.slabU.x.mul(depth).negate())));
    })();
    this.eye = m;
    return m;
  }

  dispose(): void {
    this.hull?.dispose();
    this.eye?.dispose();
    this.hull = this.eye = null;
  }
}

/** What a view's chunk draw holds of its gas: its group, its gas mesh, its gas part (the runs the eye is looked up in) and its bytes. */
export interface GasHolder {
  readonly group: THREE.Group;
  gas: THREE.Mesh | null;
  gasPart: GasPart | null;
  bytes: number;
}

/** What {@link VoxelGasDraws} needs of its view. */
export interface VoxelGasDrawsOptions {
  readonly surface: VoxelSurface;
  readonly grid: ChunkGrid;
  readonly origin: FloatingOrigin;
  /** The view's root: the eye's layer is added under it, and the eye is placed in its frame. */
  readonly root: THREE.Object3D;
  /** Whether gas is drawn (false: a comparison of what drawing it costs). */
  readonly drawn: boolean;
  /** A drawn level-0 chunk's draw. */
  readonly find: (cx: number, cy: number, cz: number) => GasHolder | undefined;
}

/**
 * A view's gas: its chunks' hull meshes, replaced alone when only a chunk's
 * gas part changes, the eye's layer, and their counts.
 */
export class VoxelGasDraws {
  /** Triangles of the gas meshes drawn, and the gas meshes replaced alone. */
  triangles = 0;
  sets = 0;
  /** The gas programs, made with the first gas part. */
  readonly look: VoxelGasLook;
  /** The eye's layer (null until the first gas part). */
  layer: THREE.Mesh | null = null;
  /** The run the eye stood in at the last render (null: not in gas). */
  eyeRun: GasEyeRun | null = null;
  /** Bumped when any chunk's gas changes: the eye's run is looked up again. */
  private version = 0;
  private seen = { version: -1, x: NaN, y: NaN, z: NaN };
  private readonly at = new THREE.Vector3();

  constructor(private readonly opts: VoxelGasDrawsOptions) {
    this.look = new VoxelGasLook(opts.surface, (camera) => this.update(camera));
  }

  /** Shows or hides the density overlay (an editor's switch); nothing is compiled or rebuilt. */
  setOverlay(on: boolean): void {
    this.look.overlay = on;
  }

  /** A chunk's gas mesh (null: no gas face, or gas not drawn); counted once {@link shown}. */
  mesh(part: GasPart | null | undefined): THREE.Mesh | null {
    if (!this.opts.drawn || part == null) return null;
    this.ensureLayer();
    const geo = gasGeometry(part);
    if (geo === null) return null;
    const mesh = new THREE.Mesh(geo, this.look.material);
    mesh.name = 'voxel gas';
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData[VOXEL_GAS_KEY] = true;
    return mesh;
  }

  /** What a chunk's draw keeps of a gas part for the eye (null: gas not drawn, or none). */
  kept(part: GasPart | null | undefined): GasPart | null {
    return this.opts.drawn && part != null && part.runCount > 0 ? part : null;
  }

  /** The eye's layer, made with the first gas part: drawn after every other transparent draw, never culled. */
  private ensureLayer(): void {
    if (this.layer !== null) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const layer = new THREE.Mesh(geo, this.look.eyeMaterial);
    layer.name = 'voxel gas eye';
    layer.frustumCulled = false;
    layer.matrixAutoUpdate = false;
    layer.castShadow = layer.receiveShadow = false;
    layer.renderOrder = Number.MAX_SAFE_INTEGER;
    this.layer = layer;
    this.opts.root.add(layer);
  }

  /** A gas mesh began to be drawn (or a chunk's gas changed). */
  shown(mesh: THREE.Mesh | null): void {
    this.version++;
    if (mesh !== null) this.triangles += (mesh.geometry.index?.count ?? 0) / 3;
  }

  /** A gas mesh is no longer drawn: its geometry goes (its render objects with it when `whole`, else its draw's tree takes them). */
  gone(mesh: THREE.Mesh, whole: boolean): void {
    this.version++;
    this.triangles -= (mesh.geometry.index?.count ?? 0) / 3;
    mesh.geometry.dispose();
    if (whole) disposeObjectTree(mesh);
  }

  /** A chunk that kept gas runs without a mesh left the view. */
  dropped(): void {
    this.version++;
  }

  /**
   * Gives a drawn chunk its new gas (only its gas part changed: a change only between air and gas, or of a gas's
   * density or material); its surfaces, pieces, liquid and grid stay. Returns its bytes now (0: not drawn).
   */
  set(cx: number, cy: number, cz: number, part: GasPart | null | undefined): number {
    const m = this.opts.find(cx, cy, cz);
    if (m === undefined) return 0;
    this.sets++;
    const old = m.gas;
    if (old !== null) {
      m.group.remove(old);
      m.bytes -= geometryBytes(old.geometry);
      this.gone(old, true);
    }
    m.gas = this.mesh(part);
    m.gasPart = this.kept(part);
    if (m.gas !== null) {
      m.group.add(m.gas);
      m.bytes += geometryBytes(m.gas.geometry);
    }
    this.shown(m.gas);
    return m.bytes;
  }

  /** The gas run holding cell (x, y, z) of the view's grid as its chunk's part gives it (rows of the grid), or null. */
  private cellRun(x: number, y: number, z: number): { y0: number; y1: number; material: number; sum: number } | null {
    const e = this.opts.grid.edge;
    const cx = Math.floor(x / e);
    const cy = Math.floor(y / e);
    const cz = Math.floor(z / e);
    const r = gasRunAt(this.opts.find(cx, cy, cz)?.gasPart, x - cx * e, y - cy * e, z - cz * e);
    return r === null ? null : { y0: r.y0 + cy * e, y1: r.y1 + cy * e, material: r.material, sum: r.sum };
  }

  /** The whole run of one gas holding cell (x, y, z): its chunk's run joined with those over and under it across section and chunk borders. */
  runAt(x: number, y: number, z: number): GasEyeRun | null {
    const first = this.cellRun(x, y, z);
    if (first === null) return null;
    let { y0, y1, sum } = first;
    for (let k = 0; k < GAS_RUN_STEPS; k++) {
      const up = this.cellRun(x, y1, z);
      if (up === null || up.material !== first.material) break;
      y1 = up.y1;
      sum += up.sum;
    }
    for (let k = 0; k < GAS_RUN_STEPS; k++) {
      const down = this.cellRun(x, y0 - 1, z);
      if (down === null || down.material !== first.material) break;
      y0 = down.y0;
      sum += down.sum;
    }
    return { y0, y1, material: first.material, density: sum / ((y1 - y0) * GAS_DENSITY_FULL) };
  }

  /** Before a render's first gas draw: where the camera stands in the view's gas, and the slab its layer draws. */
  update(camera: THREE.Camera): void {
    const c = camera.matrixWorld.elements;
    const p = this.opts.root.worldToLocal(this.at.set(c[12]!, c[13]!, c[14]!));
    const o = this.opts.origin.origin;
    const y = p.y / VOXEL_SIZE_M + o.y;
    const cell = [Math.floor(p.x / VOXEL_SIZE_M + o.x), Math.floor(y), Math.floor(p.z / VOXEL_SIZE_M + o.z)] as const;
    const s = this.seen;
    if (s.version !== this.version || s.x !== cell[0] || s.y !== cell[1] || s.z !== cell[2]) {
      this.seen = { version: this.version, x: cell[0], y: cell[1], z: cell[2] };
      this.eyeRun = this.runAt(...cell);
    }
    const run = this.eyeRun;
    const look = run === null ? null : this.opts.surface.tableEntry(run.material).gas;
    const slab = gasEyeSlab(run, y, look === null ? [0, 0, 0] : [look[0], look[1], look[2]], look === null ? 0 : look[3]);
    this.look.slab.set(slab.perMetre, slab.aboveM, slab.belowM, 0);
    this.look.slabColour.set(...slab.colour);
  }

  dispose(): void {
    if (this.layer !== null) {
      this.layer.removeFromParent();
      this.layer.geometry.dispose();
      disposeObjectTree(this.layer);
      this.layer = null;
    }
    this.look.dispose();
  }
}
