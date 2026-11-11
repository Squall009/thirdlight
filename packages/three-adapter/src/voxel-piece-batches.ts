/**
 * A voxel world's kit pieces drawn across its chunks: one instanced draw a
 * piece kind (a mesh, its material, its mirror or flush cut: what a chunk
 * view's `VoxelKitDraw` key and flush faces name) for every chunk drawn,
 * instead of one a kind a chunk. The render CPU then follows the kinds in
 * view, not the chunks: a town of ~600 chunks drew ~1,500 piece draws a pass,
 * and the shadow pass drew them all again.
 *
 * - **Chunk runs.** Each chunk gives, per kind, its instances' matrices and
 *   data (`pieceU`: trim U offset and factor, wetness) as one run. A draw's
 *   buffer is its chunks' runs one after another; a chunk added, removed or
 *   replaced marks the kinds it holds, and {@link VoxelPieceBatches.flush}
 *   writes those buffers again. A chunk view flushes once at the end of a
 *   batch of chunk draws, so a swap's pieces change between the same two
 *   frames as its surfaces.
 * - **Culled by chunk.** Each pass's camera is tested against the chunks'
 *   spheres (a few hundred tests, shared by every kind), not against each
 *   instance. A draw's buffer holds the chunks the view sees first, then those
 *   only another camera (a shadow map) sees, then the rest, and each pass
 *   draws the leading part it needs: the view its own chunks, a shadow camera
 *   the first two parts (its chunks as it last drew are among them), any
 *   other camera all. The order changes only when a chunk crosses a frustum's
 *   edge; the buffers are written then, never between two passes of a frame
 *   (see `cull`), so every pass of a frame reads the same order.
 * - **Culled on the GPU too** (WebGPU, occlusion culling's depth pyramid
 *   path): each draw is a {@link PieceDraw}, its copies placed by instance
 *   columns, which the culler tests one by one against the pyramid among
 *   the view's chunks (voxel-piece-draw.ts). WebGL 2 has no such path (no
 *   compute, storage buffers or indirect draws) and draws the view's chunks.
 * - **Which camera is the view.** The camera of the last pass drawn without
 *   an override material (a shadow pass draws with one). A camera that moved
 *   since its chunks were picked draws everything (never too little): the
 *   view is culled again before the next pass of any kind, another camera
 *   once the frame is drawn.
 * - **Placed** from one anchor cell: matrices are metres from it, so they stay
 *   small in 32 bits; the group is placed from the anchor in 64 bits
 *   (camera-relative draws), and a chunk further than
 *   {@link PIECE_ANCHOR_REACH_CELLS} from it moves the anchor (every buffer
 *   written again, as rarely as the world is crossed).
 */
import * as THREE from 'three';
import { VOXEL_SIZE_M, type FloatingOrigin } from '@thirdlight/voxel';
import { INSTANCE_MATRIX_FLOATS } from './attribute-instancing';
import { disposeObjectTree } from './dispose';
import { applyObjectDecalLayers } from './projected-decals';
import { PieceDraw } from './voxel-piece-draw';
import { TRIM_RUN_ATTRIBUTE } from './voxel-trim-u';
import { CullView, maxScaleOf, SphereSide } from './view-cull';

/** `mesh.userData[PIECE_SOURCE_KEY]`: the piece mesh a draw draws (its own geometry shares that one's attributes). */
export const PIECE_SOURCE_KEY = 'voxelPieceSource';

/** How far (level-0 cells, on any axis) a chunk may lie from the anchor before the anchor moves to it: 1 km. */
export const PIECE_ANCHOR_REACH_CELLS = 2048;

/** Metres a chunk's sphere is grown by for the pieces reaching past its cells (a flush cut, a stagger, an eave). */
const PIECE_REACH_M = 1;

/**
 * The fewest instances a draw makes room for. Room comes in powers of two (a draw shrinks below a quarter of
 * its room): a small draw's matrices are a uniform array whose length is part of its program, so its program
 * changes only when its room does, and only to one of a few.
 */
const MIN_CAPACITY = 64;

/**
 * The draws' render order: after the world's surfaces (order 0). A draw holds a kind's pieces of every chunk in
 * view, near and far, so drawn among the surfaces by its nearest chunk it shades far pieces before the nearer
 * walls that hide them; drawn after every surface, the depth test leaves the hidden ones unshaded. Pieces hide
 * little themselves (rails, frames, eaves), so the surfaces lose nothing by going first.
 */
export const PIECE_RENDER_ORDER = 1;

/** The other cameras remembered (a shadow map each); the oldest are forgotten past this. */
const MAX_OTHER_CAMERAS = 8;

/** A chunk's class in the drawn order: the view sees it, only another camera does, or none. */
const VIEW = 0;
const OTHER = 1;
const REST = 2;

/** One kind of piece: what its draw draws with. */
export interface PieceKind {
  /** Equal for runs that share a draw (the same geometry, material and cut). */
  readonly key: string;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
}

/** One chunk's instances of one kind: `n` matrices (16 floats each, metres from the chunk's corner) and `n` data quads. */
export interface PieceRun {
  readonly kind: PieceKind;
  readonly n: number;
  readonly matrices: Float32Array;
  readonly data: Float32Array;
}

interface Chunk {
  /** The chunk's corner (level-0 cells) and its extent (metres a side). */
  readonly cell: readonly [number, number, number];
  readonly sizeM: number;
  /** Its runs, matrices moved to the anchor, and each run's spheres (the piece's bounds through each matrix). */
  runs: readonly PieceRun[];
  readonly spheres: readonly Float32Array[];
  cls: number;
  /** How far ahead of the view its centre was when its class was last found (metres). */
  depth: number;
  /** Its sphere's centre (metres from the anchor) and radius. */
  readonly centre: [number, number, number];
  readonly radius: number;
}

interface Batch {
  readonly kind: PieceKind;
  readonly chunks: Set<Chunk>;
  total: number;
  /** Instances of the chunks the view sees, and of those only another camera sees (they follow). */
  inView: number;
  inOther: number;
  draw: PieceDraw | null;
  capacity: number;
  dirty: boolean;
}

const sphere = new THREE.Vector3();

export interface VoxelPieceBatchesOptions {
  readonly origin: FloatingOrigin;
  readonly shadows: boolean;
}

/** Every kit piece of one chunk view, drawn per kind across its chunks. */
export class VoxelPieceBatches {
  /** The draws' group (placed at the anchor, relative to the floating origin). */
  readonly root = new THREE.Group();
  private readonly chunks = new Map<object, Chunk>();
  private readonly batches = new Map<string, Batch>();
  private readonly origin: FloatingOrigin;
  private readonly shadows: boolean;
  private anchor: [number, number, number];
  /** The view, the camera it is culled for, and the other cameras by their last frustum. */
  private readonly view = new CullView();
  private viewCamera: THREE.Camera | null = null;
  private readonly others = new Map<THREE.Camera, CullView>();
  /** A cull for a camera met in a pass is waiting for the frame's end. */
  private cullQueued = false;
  private decalLayers: number | undefined = undefined;
  /** Chunk spheres tested and buffers written by culling since made (diagnostics). */
  culls = 0;
  reorders = 0;

  constructor(opts: VoxelPieceBatchesOptions) {
    this.origin = opts.origin;
    this.shadows = opts.shadows;
    const o = opts.origin.origin;
    this.anchor = [o.x, o.y, o.z];
    this.root.name = 'voxel-pieces';
    this.root.matrixAutoUpdate = false;
    this.place();
  }

  /** Draws (kinds with instances). */
  get draws(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.total > 0) n++;
    return n;
  }

  /** Instances drawn, and of them those the view drew last (its chunks'). */
  get instances(): number {
    let n = 0;
    for (const b of this.batches.values()) n += b.total;
    return n;
  }

  get instancesInView(): number {
    let n = 0;
    for (const b of this.batches.values()) n += b.inView;
    return n;
  }

  /** Draws the view sees some of. */
  get drawsInView(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.inView > 0) n++;
    return n;
  }

  /** Every draw is in decal layers `mask` from now on (undefined: every layer). */
  setDecalLayers(mask: number | undefined): void {
    this.decalLayers = mask;
    applyObjectDecalLayers(this.root, mask);
  }

  /**
   * Replaces chunk `id`'s pieces (its corner `cell` in level-0 cells, `sizeM` metres a side) with `runs`, whose
   * matrices are metres from that corner (none: it draws no piece). Written at the next {@link flush}.
   */
  set(id: object, cell: readonly [number, number, number], sizeM: number, runs: readonly PieceRun[]): void {
    this.remove(id);
    if (runs.length === 0) return;
    if (cell.some((c, a) => Math.abs(c - this.anchor[a]!) > PIECE_ANCHOR_REACH_CELLS)) this.moveAnchor(cell);
    const half = sizeM / 2;
    const at = cell.map((c, a) => (c - this.anchor[a]!) * VOXEL_SIZE_M) as [number, number, number];
    for (const r of runs) {
      for (let i = 0; i < r.n; i++) for (let a = 0; a < 3; a++) r.matrices[i * INSTANCE_MATRIX_FLOATS + 12 + a]! += at[a]!;
    }
    const spheres = runs.map((r) => pieceSpheres(r));
    const chunk: Chunk = { cell: [cell[0], cell[1], cell[2]], sizeM, runs, spheres, cls: REST, depth: 0, centre: [at[0] + half, at[1] + half, at[2] + half], radius: half * Math.sqrt(3) + PIECE_REACH_M };
    chunk.cls = this.classOf(chunk);
    this.chunks.set(id, chunk);
    for (const r of runs) {
      const b = this.batchOf(r.kind);
      b.chunks.add(chunk);
      b.dirty = true;
    }
  }

  /** Stops drawing chunk `id`'s pieces (at the next {@link flush}). */
  remove(id: object): void {
    const c = this.chunks.get(id);
    if (c === undefined) return;
    this.chunks.delete(id);
    for (const r of c.runs) {
      const b = this.batches.get(r.kind.key);
      if (b === undefined) continue;
      b.chunks.delete(c);
      b.dirty = true;
    }
  }

  /** Instances chunk `id` draws (0: none). */
  countOf(id: object): number {
    let n = 0;
    for (const r of this.chunks.get(id)?.runs ?? []) n += r.n;
    return n;
  }

  /** Writes every draw whose chunks changed: grown or shrunk, made or dropped. */
  flush(): void {
    for (const [key, b] of this.batches) {
      if (!b.dirty) continue;
      b.dirty = false;
      let total = 0;
      for (const c of b.chunks) for (const r of c.runs) if (r.kind.key === key) total += r.n;
      b.total = total;
      if (total === 0) {
        this.drop(b);
        this.batches.delete(key);
        continue;
      }
      if (b.draw === null || total > b.capacity || (total < b.capacity / 4 && b.capacity > MIN_CAPACITY)) this.make(b, Math.max(MIN_CAPACITY, 2 ** Math.ceil(Math.log2(total))));
      this.write(b);
    }
  }

  /** After a floating-origin re-base: the group placed again (the matrices are the anchor's). */
  rebase(): void {
    this.place();
  }

  dispose(): void {
    for (const b of this.batches.values()) this.drop(b);
    this.batches.clear();
    this.chunks.clear();
    this.others.clear();
  }

  private place(): void {
    const o = this.origin.origin;
    this.root.position.set((this.anchor[0] - o.x) * VOXEL_SIZE_M, (this.anchor[1] - o.y) * VOXEL_SIZE_M, (this.anchor[2] - o.z) * VOXEL_SIZE_M);
    this.root.updateMatrix();
    this.root.updateMatrixWorld(true);
  }

  /** The anchor moves to `cell`: every chunk's matrices and sphere move with it, every draw is written again. */
  private moveAnchor(cell: readonly number[]): void {
    const d = [0, 1, 2].map((a) => (this.anchor[a]! - cell[a]!) * VOXEL_SIZE_M);
    this.anchor = [cell[0]!, cell[1]!, cell[2]!];
    for (const c of this.chunks.values()) {
      for (let a = 0; a < 3; a++) c.centre[a]! += d[a]!;
      for (const r of c.runs) for (let i = 0; i < r.n; i++) for (let a = 0; a < 3; a++) r.matrices[i * INSTANCE_MATRIX_FLOATS + 12 + a]! += d[a]!;
      for (const s of c.spheres) for (let i = 0; i < s.length; i += 4) for (let a = 0; a < 3; a++) s[i + a]! += d[a]!;
    }
    for (const b of this.batches.values()) b.dirty = true;
    this.place();
  }

  private batchOf(kind: PieceKind): Batch {
    let b = this.batches.get(kind.key);
    if (b === undefined) this.batches.set(kind.key, (b = { kind, chunks: new Set(), total: 0, inView: 0, inOther: 0, draw: null, capacity: 0, dirty: true }));
    return b;
  }

  /** A draw with room for `capacity` instances (the old one dropped). */
  private make(b: Batch, capacity: number): void {
    this.drop(b);
    const draw = new PieceDraw(b.kind.geometry, b.kind.material, capacity, { viewCount: () => this.viewCountOf(b) });
    const mesh = draw.mesh;
    mesh.name = `voxel-pieces ${b.kind.key}`;
    mesh.castShadow = mesh.receiveShadow = this.shadows;
    mesh.renderOrder = PIECE_RENDER_ORDER;
    mesh.userData['voxelKitPiece'] = true;
    // What it draws: the kind's own mesh (the draw's geometry shares its attributes) and whether that is a trim run's.
    mesh.userData[PIECE_SOURCE_KEY] = b.kind.geometry;
    if (b.kind.geometry.getAttribute(TRIM_RUN_ATTRIBUTE) !== undefined) mesh.userData['voxelTrimGeometry'] = true;
    mesh.onBeforeRender = (_r, scene, camera) => {
      const n = this.countFor(b, scene, camera);
      draw.beforeDraw(scene, n, n === b.inView && scene.overrideMaterial === null && this.view.is(camera));
    };
    // Outside a pass the draw holds all of its instances (what a reader of the count expects).
    mesh.onAfterRender = () => {
      draw.geometry.instanceCount = b.total;
    };
    b.draw = draw;
    b.capacity = capacity;
    if (this.decalLayers !== undefined) applyObjectDecalLayers(mesh, this.decalLayers);
    this.root.add(mesh);
  }

  private drop(b: Batch): void {
    if (b.draw === null) return;
    this.root.remove(b.draw.mesh);
    // Its render objects hold on the kind's shared material until the mesh itself is disposed.
    disposeObjectTree(b.draw.mesh);
    b.draw.dispose();
    b.draw = null;
    b.capacity = 0;
  }

  /**
   * The copies the view's pass draws, culled for the view camera as it is now (the GPU culler asks once a frame,
   * before any pass: a view that moved is culled here, as its first pass would); null: no view yet.
   */
  private viewCountOf(b: Batch): number | null {
    const cam = this.viewCamera;
    if (cam === null) return null;
    this.cull();
    return this.view.is(cam) ? b.inView : null;
  }

  /** Writes a draw's buffers in the chunks' order: the view's, the other cameras', the rest; and its bounds. */
  private write(b: Batch): void {
    const draw = b.draw!;
    const key = b.kind.key;
    let at = 0;
    const counts = [0, 0, 0];
    // The view's chunks nearest first (each pixel shaded once where pieces overlap), then the others as they come.
    const seen = [...b.chunks].filter((c) => c.cls === VIEW).sort((p, q) => p.depth - q.depth);
    for (let cls = VIEW; cls <= REST; cls++) {
      for (const c of cls === VIEW ? seen : b.chunks) {
        if (c.cls !== cls) continue;
        c.runs.forEach((r, i) => {
          if (r.kind.key !== key) return;
          draw.put(at, r.n, r.matrices, r.data, c.spheres[i]!);
          at += r.n;
          counts[cls]! += r.n;
        });
      }
    }
    b.inView = counts[VIEW]!;
    b.inOther = counts[OTHER]!;
    draw.written(at);
    draw.geometry.instanceCount = b.total;
    // The bounds three culls the whole draw by in every pass: round its chunks' spheres.
    const box = new THREE.Box3();
    for (const c of b.chunks) {
      box.expandByPoint(sphere.set(c.centre[0] - c.radius, c.centre[1] - c.radius, c.centre[2] - c.radius));
      box.expandByPoint(sphere.set(c.centre[0] + c.radius, c.centre[1] + c.radius, c.centre[2] + c.radius));
    }
    const bounds = draw.geometry.boundingSphere!;
    box.getBoundingSphere(bounds);
    // three sorts the piece draws among themselves (after the surfaces) by their spheres' centres: at the nearest
    // chunk in view, the kinds nearest the camera go first (the whole ring's centre would order them at random);
    // grown to keep every chunk inside.
    const near = seen[0];
    if (near !== undefined) {
      sphere.set(near.centre[0], near.centre[1], near.centre[2]);
      bounds.radius += sphere.distanceTo(bounds.center);
      bounds.center.copy(sphere);
    }
  }

  /** A chunk's class against the view and the other cameras as they were last culled for. */
  private classOf(c: Chunk): number {
    const w = this.root.matrixWorld.elements;
    const x = c.centre[0] * w[0]! + c.centre[1] * w[4]! + c.centre[2] * w[8]! + w[12]!;
    const y = c.centre[0] * w[1]! + c.centre[1] * w[5]! + c.centre[2] * w[9]! + w[13]!;
    const z = c.centre[0] * w[2]! + c.centre[1] * w[6]! + c.centre[2] * w[10]! + w[14]!;
    if (this.view.camera !== null) c.depth = this.view.depth(x, y, z);
    if (this.view.camera !== null && this.view.side(x, y, z, c.radius) !== SphereSide.Outside) return VIEW;
    for (const o of this.others.values()) if (o.side(x, y, z, c.radius) !== SphereSide.Outside) return OTHER;
    return REST;
  }

  /**
   * The chunks' classes for the view camera as it is now and the other cameras as they are now, the draws holding
   * a chunk whose class changed written again. Runs before a pass draws when the view moved (its matrices change
   * only between frames, so no pass of this frame drew yet), and after the frame (a microtask) when a pass met
   * another camera: a buffer rewritten after a pass of the same frame drew part of it would change that pass's
   * draw too, on a backend that uploads before the frame's commands run.
   */
  private cull(force = false): void {
    const cam = this.viewCamera;
    if (cam === null) return;
    const moved = !this.view.is(cam);
    if (!moved && !force) return;
    if (moved) this.view.set(cam);
    for (const [c, o] of this.others) o.set(c);
    this.culls++;
    let changed = false;
    for (const c of this.chunks.values()) {
      const cls = this.classOf(c);
      if (cls === c.cls) continue;
      c.cls = cls;
      changed = true;
      for (const r of c.runs) {
        const b = this.batches.get(r.kind.key);
        if (b !== undefined) b.dirty = true;
      }
    }
    if (!changed) return;
    this.reorders++;
    for (const b of this.batches.values()) {
      if (!b.dirty || b.draw === null) continue;
      b.dirty = false;
      this.write(b);
    }
  }

  /** How many of a draw's instances the pass of `camera` draws (see the file's note). */
  private countFor(b: Batch, scene: THREE.Scene, camera: THREE.Camera): number {
    const plain = scene.overrideMaterial === null;
    if (plain && camera !== this.viewCamera) {
      // A new view: everything this pass, culled for it from the next pass on.
      this.viewCamera = camera;
      this.view.clear();
      return b.total;
    }
    this.cull();
    if (plain) return this.view.is(camera) ? b.inView : b.total;
    const o = this.others.get(camera);
    if (o !== undefined && o.camera !== null && o.is(camera)) return b.inView + b.inOther;
    if (o === undefined) {
      if (this.others.size >= MAX_OTHER_CAMERAS) this.others.delete(this.others.keys().next().value!);
      this.others.set(camera, new CullView());
    }
    // Drawn whole now; its own chunks are picked once the frame is drawn, for its next pass.
    if (!this.cullQueued) {
      this.cullQueued = true;
      queueMicrotask(() => {
        this.cullQueued = false;
        this.cull(true);
      });
    }
    return b.total;
  }
}

/** A run's copies' spheres (centre xyz in the run's metres, radius): the piece's bounds through each matrix. */
function pieceSpheres(r: PieceRun): Float32Array {
  const g = r.kind.geometry;
  if (g.boundingSphere === null) g.computeBoundingSphere();
  const { center: c, radius } = g.boundingSphere!;
  const out = new Float32Array(r.n * 4);
  const m = r.matrices;
  for (let i = 0; i < r.n; i++) {
    const o = i * INSTANCE_MATRIX_FLOATS;
    for (let a = 0; a < 3; a++) out[i * 4 + a] = m[o + a]! * c.x + m[o + 4 + a]! * c.y + m[o + 8 + a]! * c.z + m[o + 12 + a]!;
    out[i * 4 + 3] = radius * maxScaleOf(m, o);
  }
  return out;
}
