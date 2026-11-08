/**
 * One kind of kit piece drawn for a chunk view (voxel-piece-batches.ts): a
 * plain mesh whose copies are placed by instance-matrix columns
 * (attribute-instancing.ts), so the GPU may cull them one by one against the
 * depth pyramid (occlusion-instances.ts) like any instanced draw of the scene.
 *
 * - **A copy's 16 floats** are its matrix (metres from the view's anchor),
 *   with the piece's own numbers in the matrix's fourth row, which an affine
 *   matrix leaves unused and the columns' transform never reads: the trim
 *   U's offset and factor and the cell's wetness ({@link PIECE_RIDER_FLOATS}).
 *   They travel with the copy into the culler's pools, so a culled draw reads
 *   them through its list exactly as a whole one reads its own columns.
 * - **Spheres** are kept per place beside the copies (the piece's bounds
 *   through its matrix), in the anchor's metres; the culler gets them in the
 *   world (the anchor's group moves with the floating origin).
 * - **Culled on the GPU** only as the view's draw on the pyramid path: the
 *   culler adopts the draw at its first draw and lists it each frame it was
 *   drawn (it lies below the scene's drawables, inside the chunk view).
 *   Every other pass draws the copies its batch asks for from its columns.
 */
import * as THREE from 'three';
import { CULLABLE_COPIES_KEY, CULLED_COPIES_ATTRIBUTE, INSTANCE_CULLER_KEY, INSTANCE_MATRIX_ATTRIBUTE, INSTANCE_MATRIX_FLOATS, installAttributeInstancing, type CullableCopies, type InstanceCullerHost, type InstanceIndirect, type InstanceViewDraw } from './attribute-instancing';
import { PIECE_DATA_FLOATS, PIECE_RIDER_FLOATS } from './voxel-trim-u';

/** The copy float the culled marker views (never read through it: the marker only names the build). */
const MARKER_FLOAT = 0;

/** Places in order (slot = place): a draw keeps no copy by slot, its order is what it last wrote. */
let identity = new Uint32Array(0);
function identityOrder(n: number): Uint32Array {
  if (identity.length < n) {
    identity = new Uint32Array(Math.max(n, identity.length * 2));
    for (let i = 0; i < identity.length; i++) identity[i] = i;
  }
  return identity;
}

const rayProbe = new THREE.Mesh();
const raySphere = new THREE.Sphere();
const rayMatrix = new THREE.Matrix4();

/** What a piece draw asks of the batches it draws for. */
export interface PieceDrawHost {
  /** The copies the view draws (the leading part), culled for the view as it is now; null: not culled for one. */
  viewCount(): number | null;
}

export class PieceDraw implements CullableCopies {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.InstancedBufferGeometry;
  indirect: InstanceIndirect | null = null;
  /** Lies below the scene's drawables: the culler lists it while it is drawn. */
  readonly nested = true;
  /** The copies as drawn: 16 floats a place. */
  readonly drawn: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  /** Each place's sphere in the anchor's metres, and in the world as last handed to the culler. */
  private readonly local: Float32Array;
  private readonly world: Float32Array;
  private version = 0;
  private packedFor = -1;
  private readonly placedAt = new Float64Array(3);
  private drawnOnce = false;
  /** Places written (what a raycast tests). */
  private count = 0;
  private readonly source: THREE.BufferGeometry;
  private readonly view: InstanceViewDraw & { version: number; count: number };

  constructor(
    source: THREE.BufferGeometry,
    material: THREE.Material,
    readonly capacity: number,
    private readonly host: PieceDrawHost,
  ) {
    installAttributeInstancing();
    this.source = source;
    const g = new THREE.InstancedBufferGeometry();
    g.name = source.name;
    for (const [name, a] of Object.entries(source.attributes)) g.setAttribute(name, a);
    if (source.index !== null) g.setIndex(source.index);
    for (const grp of source.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
    g.setDrawRange(source.drawRange.start, source.drawRange.count);
    this.drawn = new Float32Array(capacity * INSTANCE_MATRIX_FLOATS);
    // Static usage: written (and uploaded) only when the batch writes it.
    this.buffer = new THREE.InstancedInterleavedBuffer(this.drawn, INSTANCE_MATRIX_FLOATS, 1);
    for (let i = 0; i < 4; i++) g.setAttribute(`${INSTANCE_MATRIX_ATTRIBUTE}${i}`, new THREE.InterleavedBufferAttribute(this.buffer, 4, i * 4));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere();
    this.geometry = g;
    this.local = new Float32Array(capacity * 4);
    this.world = new Float32Array(capacity * 4);
    this.view = { version: 0, count: 0, drawn: this.drawn, order: identityOrder(capacity), spheres: this.world };
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData[CULLABLE_COPIES_KEY] = this;
    // A plain mesh would test its geometry once at the group's place: each copy is tested as an instanced mesh's is.
    this.mesh.raycast = (raycaster, hits) => this.raycast(raycaster, hits);
  }

  /**
   * Writes `n` copies at place `at`: their matrices (16 floats each, anchor metres), their data quads (trim U
   * offset, factor, wetness) into the matrices' fourth rows, and their spheres from the piece's bounds.
   */
  put(at: number, n: number, matrices: Float32Array, data: Float32Array, spheres: Float32Array): void {
    const d = this.drawn;
    d.set(matrices.subarray(0, n * INSTANCE_MATRIX_FLOATS), at * INSTANCE_MATRIX_FLOATS);
    for (let i = 0; i < n; i++) {
      const o = (at + i) * INSTANCE_MATRIX_FLOATS;
      for (let k = 0; k < PIECE_RIDER_FLOATS.length; k++) d[o + PIECE_RIDER_FLOATS[k]!] = data[i * PIECE_DATA_FLOATS + k]!;
    }
    this.local.set(spheres.subarray(0, n * 4), at * 4);
  }

  /** The first `n` places are written: they go to the GPU (and to the culler, as a new order). */
  written(n: number): void {
    this.count = n;
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(0, n * INSTANCE_MATRIX_FLOATS);
    this.buffer.needsUpdate = true;
    this.version++;
  }

  /** Copies the next pass draws, right before it (its batch's count), and whether that pass is the view's. */
  beforeDraw(scene: THREE.Object3D, n: number, view: boolean): void {
    // A culler on the GPU takes the draw, before its first render object is made where it is there already (its
    // build reads copies by list); one that comes later takes it at its next draw (its program built once again).
    // It lies below the scene's drawables, so the culler never finds it there.
    if (this.indirect === null) (scene.userData[INSTANCE_CULLER_KEY] as InstanceCullerHost | undefined)?.adopt(this);
    this.drawnOnce = true;
    this.geometry.instanceCount = n;
    this.indirect?.draw(this.geometry, view);
  }

  viewDraw(): InstanceViewDraw | null {
    const n = this.host.viewCount();
    if (n === null) return null;
    // The anchor's group as placed now (it moves with the floating origin): the spheres in the world again.
    this.mesh.updateWorldMatrix(true, false);
    const w = this.mesh.matrixWorld.elements;
    if (w[12] !== this.placedAt[0] || w[13] !== this.placedAt[1] || w[14] !== this.placedAt[2]) {
      this.placedAt[0] = w[12]!;
      this.placedAt[1] = w[13]!;
      this.placedAt[2] = w[14]!;
      this.version++;
    }
    if (this.packedFor !== this.version || this.view.count !== n) {
      const s = this.local;
      const out = this.world;
      for (let p = 0; p < n; p++) {
        const o = p * 4;
        out[o] = s[o]! + w[12]!;
        out[o + 1] = s[o + 1]! + w[13]!;
        out[o + 2] = s[o + 2]! + w[14]!;
        out[o + 3] = s[o + 3]!;
      }
      this.packedFor = this.version;
    }
    this.view.version = this.version;
    this.view.count = n;
    return this.view;
  }

  /** Each written copy tested by its sphere, then its triangles (the matrix without the riders), hits named by place. */
  private raycast(raycaster: THREE.Raycaster, hits: THREE.Intersection[]): void {
    const probe = rayProbe;
    probe.geometry = this.source;
    probe.material = this.mesh.material;
    const world = this.mesh.matrixWorld;
    const found: THREE.Intersection[] = [];
    for (let p = 0; p < this.count; p++) {
      const o = p * 4;
      raySphere.center.set(this.local[o]!, this.local[o + 1]!, this.local[o + 2]!).applyMatrix4(world);
      raySphere.radius = this.local[o + 3]!;
      if (!raycaster.ray.intersectsSphere(raySphere)) continue;
      const e = rayMatrix.fromArray(this.drawn, p * INSTANCE_MATRIX_FLOATS).elements;
      e[3] = e[7] = e[11] = 0;
      e[15] = 1;
      probe.matrixWorld.multiplyMatrices(world, rayMatrix);
      found.length = 0;
      probe.raycast(raycaster, found);
      for (const h of found) {
        h.instanceId = p;
        h.object = this.mesh;
        hits.push(h);
      }
    }
  }

  markCulled(on: boolean): void {
    const g = this.geometry;
    if ((g.getAttribute(CULLED_COPIES_ATTRIBUTE) !== undefined) === on) return;
    if (on) g.setAttribute(CULLED_COPIES_ATTRIBUTE, new THREE.InterleavedBufferAttribute(this.buffer, 1, MARKER_FLOAT));
    else {
      g.deleteAttribute(CULLED_COPIES_ATTRIBUTE);
      (g as THREE.InstancedBufferGeometry & { indirect: unknown }).indirect = null;
    }
    // three keeps a render object's program until its material's version changes.
    if (this.drawnOnce) for (const m of Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material]) m.needsUpdate = true;
  }

  /** The draw is gone: the culler lets go, its own buffers are freed (the piece's shared attributes are not). */
  dispose(): void {
    this.indirect?.release();
    this.indirect = null;
    if (this.mesh.userData[CULLABLE_COPIES_KEY] === this) delete this.mesh.userData[CULLABLE_COPIES_KEY];
    const g = this.geometry;
    for (const name of Object.keys(g.attributes)) if (!name.startsWith(INSTANCE_MATRIX_ATTRIBUTE) && name !== CULLED_COPIES_ATTRIBUTE) g.deleteAttribute(name);
    g.setIndex(null);
    g.dispose();
  }
}

/** Whether `o` is a kit-piece draw (a chunk view's, one a piece kind). */
export const isPieceDraw = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true && o.userData['voxelKitPiece'] === true;

/** The copies a piece draw draws now (outside a pass: all it holds). */
export const pieceDrawCopies = (mesh: THREE.Mesh): number => (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;

/** The buffer the GPU reads a piece draw's copies from: 16 floats a copy (its matrix columns, the riders in them). */
export const pieceDrawColumns = (mesh: THREE.Mesh): THREE.InstancedInterleavedBuffer => (mesh.geometry.getAttribute(`${INSTANCE_MATRIX_ATTRIBUTE}0`) as THREE.InterleavedBufferAttribute).data as THREE.InstancedInterleavedBuffer;

/** Copy `i`'s matrix as the columns' transform applies it (its fourth row carries the piece's data, never read as a row). */
export function pieceCopyMatrix(mesh: THREE.Mesh, i: number, m: THREE.Matrix4): THREE.Matrix4 {
  const e = m.fromArray(pieceDrawColumns(mesh).array as Float32Array, i * INSTANCE_MATRIX_FLOATS).elements;
  e[3] = e[7] = e[11] = 0;
  e[15] = 1;
  return m;
}

/** Copy `i`'s data as its riders carry it: trim U offset, factor, wetness. */
export const pieceCopyData = (mesh: THREE.Mesh, i: number): number[] => PIECE_RIDER_FLOATS.map((f) => (pieceDrawColumns(mesh).array as Float32Array)[i * INSTANCE_MATRIX_FLOATS + f]!);
