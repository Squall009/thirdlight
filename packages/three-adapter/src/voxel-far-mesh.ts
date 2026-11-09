/**
 * A voxel world's far field drawn as meshes (`@thirdlight/voxel`
 * far-field.ts): the far tree's nodes past the near rings, batched into a
 * few draws, coloured from the world's material table, drawn under the near
 * field and hidden where it draws.
 *
 * - **Batches.** Nodes are drawn in groups of {@link FAR_GROUP_NODES}² node
 *   columns of one level (every height in one), each group one merged
 *   geometry and one draw: a far field of thousands of nodes is a few
 *   hundred draws at most. A batch's far changes rebuild only the groups
 *   they touch, all in the batch's task, so a level change (a parent and its
 *   children) swaps between the same two frames.
 * - **Colour.** A vertex carries its cell's material and wetness; its colour
 *   is the material's table colour times its wall set's mean (the array's
 *   coarsest level), read in the vertex stage from the surface's own table
 *   and arrays, so a record's change reaches the far field with no mesh
 *   rebuilt. Lit like the near surfaces (the scene's lights), no shadows.
 * - **Depth.** Far nodes reach kilometres past the camera's far plane: the
 *   vertex stage writes a depth of its own, the camera's perspective depth
 *   of the distance pushed back by {@link FAR_DEPTH_PUSH} up to half the far
 *   plane, and past it the distance's logarithm up to {@link FAR_DEPTH_MAX_M}
 *   in what remains of the depth range. So far nodes sort among themselves at
 *   any distance, nothing is cut off at the far plane, and where a far node
 *   and the near field cover the same pixel the near field is in front.
 *   They are never frustum culled by three (its frustum ends at the far
 *   plane); the GPU clips what lies off screen.
 * - **Near field.** The batches' near cover (where the near field draws, by
 *   storage chunk, its edge ring left out) is a small 3D texture; a far
 *   fragment inside a covered chunk is discarded. Where the near field has
 *   not drawn a chunk yet the far node shows, and along the near field's
 *   edge both draw (the near in front), so no gap opens between them.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { FAR_POSITION_ORIGIN_CELLS, FAR_VERTEX_BYTES, mipNodeKey, POSITION_STEPS_PER_CELL, VOXEL_SIZE_M, type ChunkGrid, type FarDrawWire, type FarNodeDraw, type FloatingOrigin, type NearCoverWire } from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
import type { N } from './effects-tsl';
import { texelTexture3D } from './texel-texture-node';
import type { VoxelSurface } from './voxel-surface';

const TSL: N = TSLTyped;
const { Discard, Fn, If, attribute, cameraFar, cameraProjectionMatrix, clamp, float, floor, int, ivec3, log, mix, mod, positionView, positionWorld, select, uniform, varying, vec3, vec4 } = TSL;

/** The far geometry's attribute holding a vertex's material id + wetness · 4096 (far-mesh.ts's look word). */
export const VOXEL_FAR_LOOK_ATTRIBUTE = 'voxelFarLook';

/** Node columns a side one far draw holds (one level, every height). */
export const FAR_GROUP_NODES = 8;

/** How far behind its distance a far fragment's depth is (near the camera): where it meets the near field, the near field is in front. */
export const FAR_DEPTH_PUSH = 1.05;

/** The share of the camera's far plane up to which far depth is the camera's own (past it, logarithmic). */
export const FAR_DEPTH_SPLIT = 0.5;

/** The distance (metres) the far depth range ends at: a far node past it sorts as if there. */
export const FAR_DEPTH_MAX_M = 64_000;

interface FarGroup {
  readonly key: string;
  readonly level: number;
  /** The group's corner (world cells): its geometry's positions count from it. */
  readonly cell: readonly [number, number, number];
  readonly nodes: Map<string, FarNodeDraw>;
  mesh: THREE.Mesh | null;
  dirty: boolean;
  triangles: number;
  bytes: number;
}

export interface VoxelFarViewOptions {
  readonly grid: ChunkGrid;
  readonly origin: FloatingOrigin;
  /** The surface whose material table and arrays colour the far field. */
  readonly surface: VoxelSurface;
}

/** One world's far field draws. */
export class VoxelFarView {
  readonly root = new THREE.Group();
  private readonly groups = new Map<string, FarGroup>();
  private readonly groupOf = new Map<string, string>();
  private material: THREE.Material | null = null;
  private cover: THREE.Data3DTexture;
  private coverNode: N | null = null;
  /** The cover's corner (world chunks) and size (chunks). */
  private coverMin: [number, number, number] = [0, 0, 0];
  private readonly coverAt = uniform(new THREE.Vector3(0, 0, 0));
  private readonly coverSize = uniform(new THREE.Vector3(1, 1, 1));
  private hidden = false;
  triangles = 0;
  bytes = 0;
  /** Far nodes drawn (with anything to draw). */
  nodes = 0;
  /** Groups rebuilt (draws replaced) since made. */
  rebuilds = 0;
  /** ms the last batch's group rebuilds took. */
  lastBuildMs = 0;
  /** The near cover now: its corner and size (chunks), and the chunks it hides the far field in. */
  coverState = { min: [0, 0, 0] as number[], size: [1, 1, 1] as number[], covered: 0 };

  constructor(private readonly opts: VoxelFarViewOptions) {
    this.root.name = 'voxel-far';
    this.root.matrixAutoUpdate = false;
    this.cover = coverTexture(new Uint8Array(1), [1, 1, 1]);
  }

  /** The number of far draws (groups with anything to draw). */
  get draws(): number {
    let n = 0;
    for (const g of this.groups.values()) if (g.mesh !== null) n++;
    return n;
  }

  /** Shows or hides every far draw (a page's switch; nothing is rebuilt). */
  setVisible(on: boolean): void {
    this.hidden = !on;
    this.root.visible = on;
  }

  get visible(): boolean {
    return !this.hidden;
  }

  /** A batch's far changes and near cover, all applied in this task. */
  apply(far: FarDrawWire | undefined, cover: NearCoverWire | undefined): void {
    if (cover !== undefined) this.setCover(cover);
    if (far === undefined) return;
    const t0 = performance.now();
    for (const n of far.removed) {
      const key = mipNodeKey(n);
      const gk = this.groupOf.get(key);
      if (gk === undefined) continue;
      this.groupOf.delete(key);
      const g = this.groups.get(gk)!;
      g.nodes.delete(key);
      g.dirty = true;
    }
    for (const a of far.added) {
      const key = mipNodeKey(a);
      const old = this.groupOf.get(key);
      if (old !== undefined) {
        this.groups.get(old)!.nodes.delete(key);
        this.groups.get(old)!.dirty = true;
      }
      const g = this.group(a.level, a.nx, a.nz);
      g.nodes.set(key, a);
      g.dirty = true;
      this.groupOf.set(key, g.key);
    }
    for (const g of [...this.groups.values()]) if (g.dirty) this.rebuild(g);
    this.lastBuildMs = performance.now() - t0;
  }

  private group(level: number, nx: number, nz: number): FarGroup {
    const gx = Math.floor(nx / FAR_GROUP_NODES);
    const gz = Math.floor(nz / FAR_GROUP_NODES);
    const key = `${level}:${gx},${gz}`;
    let g = this.groups.get(key);
    if (g === undefined) {
      const span = FAR_GROUP_NODES * this.opts.grid.edge * 2 ** level;
      g = { key, level, cell: [gx * span, 0, gz * span], nodes: new Map(), mesh: null, dirty: false, triangles: 0, bytes: 0 };
      this.groups.set(key, g);
    }
    return g;
  }

  private rebuild(g: FarGroup): void {
    g.dirty = false;
    this.rebuilds++;
    if (g.mesh !== null) {
      this.root.remove(g.mesh);
      g.mesh.geometry.dispose();
      g.mesh = null;
      this.triangles -= g.triangles;
      this.bytes -= g.bytes;
      this.nodes -= g.nodes.size;
    }
    if (g.nodes.size === 0) {
      this.groups.delete(g.key);
      return;
    }
    const geo = groupGeometry(this.opts.grid, g, [...g.nodes.values()]);
    g.triangles = (geo.index?.count ?? 0) / 3;
    g.bytes = geometryBytes(geo);
    this.triangles += g.triangles;
    this.bytes += g.bytes;
    this.nodes += g.nodes.size;
    const mesh = new THREE.Mesh(geo, this.farMaterial());
    mesh.name = `voxel-far ${g.key}`;
    mesh.matrixAutoUpdate = false;
    // Three's frustum ends at the camera's far plane; far draws reach past it (their depth is their own).
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.userData['voxelFar'] = g.key;
    this.place(mesh, g.cell);
    g.mesh = mesh;
    this.root.add(mesh);
  }

  private place(o3: THREE.Object3D, cell: readonly number[]): void {
    const o = this.opts.origin.origin;
    o3.position.set((cell[0]! - o.x) * VOXEL_SIZE_M, (cell[1]! - o.y) * VOXEL_SIZE_M, (cell[2]! - o.z) * VOXEL_SIZE_M);
    o3.updateMatrix();
    o3.updateMatrixWorld(true);
  }

  /** After a floating-origin re-base: every draw's position again, and the cover's corner. */
  rebase(): void {
    for (const g of this.groups.values()) if (g.mesh !== null) this.place(g.mesh, g.cell);
    this.placeCover();
  }

  private setCover(c: NearCoverWire): void {
    const old = this.cover;
    this.cover = coverTexture(c.cells, c.size);
    if (this.coverNode !== null) (this.coverNode as unknown as { value: THREE.Texture }).value = this.cover;
    old.dispose();
    this.coverMin = [c.min[0], c.min[1], c.min[2]];
    let covered = 0;
    for (let i = 0; i < c.cells.length; i++) covered += c.cells[i]!;
    this.coverState = { min: [...c.min], size: [...c.size], covered };
    (this.coverSize.value as THREE.Vector3).set(c.size[0], c.size[1], c.size[2]);
    this.placeCover();
  }

  private placeCover(): void {
    const o = this.opts.origin.origin;
    const e = this.opts.grid.edge;
    (this.coverAt.value as THREE.Vector3).set((this.coverMin[0] * e - o.x) * VOXEL_SIZE_M, (this.coverMin[1] * e - o.y) * VOXEL_SIZE_M, (this.coverMin[2] * e - o.z) * VOXEL_SIZE_M);
  }

  /** The far draws' material (one for the view): lit, coloured in the vertex stage, its own depth, hidden under the near cover. */
  private farMaterial(): THREE.Material {
    if (this.material !== null) return this.material;
    const m = cameraRelative(new MeshStandardNodeMaterial());
    m.name = 'voxel far field';
    m.metalness = 0;
    m.roughness = 1;
    const surface = this.opts.surface;
    const look = attribute(VOXEL_FAR_LOOK_ATTRIBUTE, 'float');
    const colour = varying(surface.farColour(mod(look, 4096), floor(look.div(4096))));
    const coverNode = texelTexture3D(this.cover);
    this.coverNode = coverNode;
    const chunkM = float(this.opts.grid.edge * VOXEL_SIZE_M);
    const coverAt = this.coverAt;
    const coverSize = this.coverSize;
    m.colorNode = Fn(() => {
      const c = floor(positionWorld.sub(coverAt).div(chunkM)).toVar();
      const inside = c.x.greaterThanEqual(0).and(c.y.greaterThanEqual(0)).and(c.z.greaterThanEqual(0)).and(c.x.lessThan(coverSize.x)).and(c.y.lessThan(coverSize.y)).and(c.z.lessThan(coverSize.z));
      const at = clamp(c, vec3(0), coverSize.sub(1));
      const covered = coverNode.load(ivec3(int(at.x), int(at.y), int(at.z))).r.greaterThan(0.5);
      If(inside.and(covered), () => {
        Discard();
      });
      return vec4(colour, 1);
    })();
    m.vertexNode = Fn(() => {
      const pv = positionView;
      const clip = cameraProjectionMatrix.mul(vec4(pv, 1)).toVar();
      const A = cameraProjectionMatrix.element(2).z;
      const B = cameraProjectionMatrix.element(3).z;
      // The camera's own normalized depth of a distance x along the view axis (standard, reversed and either range alike).
      const ndc = (x: N): N => A.negate().add(B.div(x));
      const x = pv.z.negate().mul(FAR_DEPTH_PUSH).max(1e-3).toVar();
      const split = cameraFar.mul(FAR_DEPTH_SPLIT);
      const zSplit = ndc(split);
      const zEnd = mix(zSplit, ndc(cameraFar), 0.9999);
      const t = clamp(log(x.div(split)).div(log(float(FAR_DEPTH_MAX_M).div(split))), 0, 1);
      const z = select(x.lessThan(split), ndc(x), mix(zSplit, zEnd, t));
      return vec4(clip.x, clip.y, z.mul(clip.w), clip.w);
    })();
    this.material = m;
    return m;
  }

  dispose(): void {
    for (const g of this.groups.values()) g.mesh?.geometry.dispose();
    this.groups.clear();
    this.groupOf.clear();
    this.root.clear();
    this.material?.dispose();
    this.cover.dispose();
    this.triangles = this.bytes = this.nodes = 0;
  }
}

function coverTexture(cells: Uint8Array, size: readonly [number, number, number]): THREE.Data3DTexture {
  // Read normalized (r8unorm): a covered chunk is 1, stored as 255.
  const t = new THREE.Data3DTexture(cells.map((c) => (c === 0 ? 0 : 255)), size[0], size[1], size[2]);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.unpackAlignment = 1;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** A group's nodes as one geometry: positions in metres from the group's corner, normals, look words; indices offset. */
export function groupGeometry(grid: ChunkGrid, g: { readonly level: number; readonly cell: readonly [number, number, number] }, nodes: readonly FarNodeDraw[]): THREE.BufferGeometry {
  let n = 0;
  let k = 0;
  for (const d of nodes) {
    n += d.mesh.vertexCount;
    k += d.mesh.indices.length;
  }
  const pos = new Float32Array(n * 3);
  const nor = new Int8Array(n * 4);
  const look = new Float32Array(n);
  const index = n < 65536 ? new Uint16Array(k) : new Uint32Array(k);
  const scale = 2 ** g.level;
  const stepM = (scale * VOXEL_SIZE_M) / POSITION_STEPS_PER_CELL;
  let v0 = 0;
  let i0 = 0;
  for (const d of nodes) {
    const m = d.mesh;
    const view = new DataView(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength);
    // The node's far origin, in metres from the group's corner.
    const ox = ((d.nx * grid.edge - FAR_POSITION_ORIGIN_CELLS) * scale - g.cell[0]) * VOXEL_SIZE_M;
    const oy = ((d.ny * grid.edge - FAR_POSITION_ORIGIN_CELLS) * scale - g.cell[1]) * VOXEL_SIZE_M;
    const oz = ((d.nz * grid.edge - FAR_POSITION_ORIGIN_CELLS) * scale - g.cell[2]) * VOXEL_SIZE_M;
    for (let i = 0; i < m.vertexCount; i++) {
      const o = i * FAR_VERTEX_BYTES;
      const at = (v0 + i) * 3;
      pos[at] = ox + view.getUint16(o, true) * stepM;
      pos[at + 1] = oy + view.getUint16(o + 2, true) * stepM;
      pos[at + 2] = oz + view.getUint16(o + 4, true) * stepM;
      look[v0 + i] = view.getUint16(o + 6, true);
      const no = (v0 + i) * 4;
      nor[no] = view.getInt8(o + 8);
      nor[no + 1] = view.getInt8(o + 9);
      nor[no + 2] = view.getInt8(o + 10);
    }
    const src = m.indices;
    for (let j = 0; j < src.length; j++) index[i0 + j] = src[j]! + v0;
    v0 += m.vertexCount;
    i0 += src.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 4, true));
  geo.setAttribute(VOXEL_FAR_LOOK_ATTRIBUTE, new THREE.BufferAttribute(look, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}

function geometryBytes(geo: THREE.BufferGeometry): number {
  let n = geo.index?.array.byteLength ?? 0;
  for (const a of Object.values(geo.attributes)) n += (a as THREE.BufferAttribute).array.byteLength;
  return n;
}
