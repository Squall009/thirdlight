/**
 * The clipped decals of a scene adapter: each loaded decal entity in
 * `clipped` mode gets a mesh cut from the surfaces inside its box (the
 * project-model clipper, `decal-clip.ts`), drawn as a mesh decal of its
 * material (`mesh-decals.ts`) under the entity's node.
 *
 * - **Made at load and when a receiver changes.** The component stores the
 *   projector only. The surfaces a box reaches are the render graph's meshes
 *   at full detail (`onSurfaces`): placed models and boxes (their batch
 *   mark), block chunks, generated architecture chunks and spline meshes
 *   (their surface mark), each in one of the decal's layers. A chunk
 *   re-meshed, an architecture object made again, a model reimported come
 *   and go as surfaces, and every decal whose box their bounds meet is looked
 *   at again. Terrain is not a receiver: its levels of detail change the
 *   surface with distance (it takes projected decals).
 * - **Cached by its inputs.** A clip's key hashes the projector, each
 *   receiver's geometry and its place relative to the decal's frame, and the
 *   clipper's version (`decal-clip-cache.ts`). Made meshes are kept by key in
 *   memory (a cache's bound, {@link CLIPPED_DECAL_CACHE_BYTES}) and, given a
 *   store, in an exported game's IndexedDB across visits, as generated
 *   architecture's chunks are: an unchanged key costs a lookup, not a clip.
 * - **On the generator's workers.** Each clip is a job for generated
 *   architecture's workers (`decal-clip-worker.ts`), which keep the
 *   receivers' arrays by hash so a big model crosses once; the page clips
 *   itself when there are none.
 * - **Static ones merge.** The mesh carries the batch mark and, for a static
 *   entity, its scene's static scope, so the static merger draws a cell's
 *   clipped decals of one material and sort order as one draw. The
 *   component's `sortOrder` is added to its material's
 *   (`DECAL_ORDER_OFFSET_KEY`). A decal under a moving parent is drawn as its
 *   node's child and follows it; a decal and the surface it marks moving
 *   together keep their key (receivers are placed relative to the decal), so
 *   a mark on a moving platform is never clipped again for the motion.
 * - **Rooms.** A static mark is in the room its projector looks from (the
 *   side of the surfaces it marks), so a mark across a room's outside corner
 *   is drawn with the outside.
 * - **Fades** are the clipper's per-vertex normal and edge fades, times the
 *   component's albedo opacity, read by the decal material from the mesh's
 *   `_decal_fade` attribute (`decal-material.ts`).
 *
 * What stays drawn until its replacement is in: a decal's old mesh keeps
 * drawing while a changed receiver's new clip is made.
 */
import * as THREE from 'three';
import { DECAL_LAYERS_ALL, decalClipGeometryHash, decalClipKey, decalClipMeshBytes, decodeDecalClipMesh, encodeDecalClipMesh, sortDecalClipReceivers, type DecalClipMesh, type DecalClipProjector } from '@thirdlight/runtime';

import { BATCH_KEY } from './batching';
import { answerDecalClipJob, type DecalClipJobReply, type DecalClipJobRequest, type DecalClipReceiverData } from './decal-clip-worker';
import { DECAL_FADE_ATTRIBUTE } from './decal-material';
import type { ProjectedDecalLike } from './decal-projectors';
import { DECAL_ORDER_OFFSET_KEY, decalDrawOf } from './mesh-decals';
import { DECAL_SURFACE_KEY, objectDecalLayers } from './projected-decals';
import { perfMark } from './perf-marks';
import type { SurfaceListener } from './render-graph';
import { ROOM_AT_KEY } from './room-culling';
import { STATIC_KEY } from './static-merge';

/** Made meshes kept in memory by key (an edit undone, a decal realized again after an edit find them made): a cache's bound, not a project's. */
export const CLIPPED_DECAL_CACHE_BYTES = 32 * 1024 * 1024;
/** Receiver arrays a worker keeps for the next clips (the page names what it lets go of past this): a cache's bound. */
export const CLIPPED_DECAL_WORKER_BYTES = 64 * 1024 * 1024;
/**
 * How long a decal whose surfaces keep changing (a level still arriving, chunk after chunk) waits for them to
 * stop before it is clipped anyway (ms): a box touched every frame by a moving surface is still clipped.
 */
export const CLIPPED_DECAL_SETTLE_MS = 250;
/**
 * How long after a decal is set an empty result (no surface under it) is not yet taken as its last word (ms):
 * a level's models and chunks arrive over its first second or two.
 */
export const CLIPPED_DECAL_EMPTY_WAIT_MS = 2000;
/** Clips the page makes itself in a frame when there are no workers (ms; at least one). */
const PAGE_CLIP_BUDGET_MS = 4;
/** The key prefix of clipped meshes in the store (it is shared with generated architecture's chunks). */
export const CLIPPED_DECAL_STORE_PREFIX = 'decal-clip:';
/** Performance marks: each decal drawn after a change (detail {decal, ms, where}) and every decal drawn (detail {ms, decals}). */
export const CLIPPED_DECAL_MARK = 'tl:decal:clip';
export const CLIPPED_DECALS_READY_MARK = 'tl:decal:clip-ready';
/** `scene.userData[CLIPPED_DECALS_KEY]`: the scene's clipped decals (a measurement reads their diagnostics). */
export const CLIPPED_DECALS_KEY = 'tlClippedDecals';
/** `mesh.userData[CLIPPED_DECAL_KEY]`: the decal entity a clipped mesh is (it is never a receiver). */
export const CLIPPED_DECAL_KEY = '__tlClippedDecal';
/** A grid cell of the boxes kept to find decals and surfaces near each other (m). */
const GRID_CELL = 8;
/** A box over more cells than this is kept apart and tested always (a long wall, a big model). */
const GRID_CELLS_MAX = 512;

/** Made meshes kept across visits (an exported game's IndexedDB), by key. */
export interface ClippedDecalStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): void;
}

/** The generator's workers as the clips use them (architecture-view.ts `sideWorker`/`postSide`/`onSideJobs`). */
export interface ClippedDecalWorkers {
  sideWorker(): number | 'page' | null;
  postSide(worker: number, message: unknown, transfer?: readonly ArrayBuffer[]): void;
  onSideJobs(reply: (worker: number, message: unknown) => void, failed: () => void): void;
}

export interface ClippedDecalsDeps {
  /** The decal entity's node (made when it has none; null: not realized). */
  node(id: string): THREE.Object3D | null;
  /** Put the decal material on a clipped mesh (the undo; null: no such material). */
  dress(mesh: THREE.Mesh, materialId: string): (() => void) | null;
  workers: ClippedDecalWorkers | null;
  store?: ClippedDecalStore | null;
  /** Something new to draw. */
  changed(): void;
}

/** What the clipped decals hold and cost (diagnostics `renderer.clippedDecals`). */
export interface ClippedDecalsDiagnostics {
  /** Clipped decals loaded; of them drawn (a mesh), with nothing under them (no mesh), and not settled yet. */
  readonly decals: number;
  readonly drawn: number;
  readonly empty: number;
  readonly pending: number;
  /** Their meshes' triangles, and the surfaces they may be cut from. */
  readonly triangles: number;
  readonly surfaces: number;
  /** Meshes made, by where: clipped on a worker or the page, found in memory or the store. */
  readonly made: { worker: number; page: number; memory: number; store: number };
  /** Clip time per decal (ms) on the workers and the page: mean and worst. */
  readonly workerMs: { mean: number; max: number };
  readonly pageMs: { mean: number; max: number };
  /** From the first decal set to all of them drawn, the last time they all were (ms; null: not yet), and from the page's first frame (ms, frames). */
  readonly readyMs: number | null;
  readonly readyAfterFirstFrameMs: number | null;
  readonly readyFrames: number | null;
  readonly cacheBytes: number;
  readonly problems: string[];
}

/** A box grid: items by the cells their boxes cover (boxes over too many cells kept apart). */
class BoxGrid<T> {
  private readonly cells = new Map<string, Set<T>>();
  private readonly big = new Set<T>();
  private readonly at = new Map<T, string[] | null>();

  set(item: T, box: THREE.Box3 | null): void {
    this.remove(item);
    if (box === null || box.isEmpty()) return;
    const [x0, y0, z0, x1, y1, z1] = this.range(box);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > GRID_CELLS_MAX) {
      this.big.add(item);
      this.at.set(item, null);
      return;
    }
    const keys: string[] = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const k = `${x},${y},${z}`;
          let c = this.cells.get(k);
          if (c === undefined) this.cells.set(k, (c = new Set()));
          c.add(item);
          keys.push(k);
        }
    this.at.set(item, keys);
  }

  remove(item: T): void {
    const keys = this.at.get(item);
    if (keys === undefined) return;
    this.at.delete(item);
    if (keys === null) {
      this.big.delete(item);
      return;
    }
    for (const k of keys) {
      const c = this.cells.get(k);
      c?.delete(item);
      if (c?.size === 0) this.cells.delete(k);
    }
  }

  /** Each item whose cells meet `box`'s (once each; the caller tests the boxes themselves). */
  near(box: THREE.Box3, fn: (item: T) => void): void {
    const seen = new Set<T>();
    for (const t of this.big) {
      seen.add(t);
      fn(t);
    }
    const [x0, y0, z0, x1, y1, z1] = this.range(box);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > GRID_CELLS_MAX) {
      for (const t of this.at.keys()) if (!seen.has(t)) fn(t);
      return;
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const c = this.cells.get(`${x},${y},${z}`);
          if (c === undefined) continue;
          for (const t of c) {
            if (seen.has(t)) continue;
            seen.add(t);
            fn(t);
          }
        }
  }

  private range(b: THREE.Box3): [number, number, number, number, number, number] {
    const f = (v: number): number => Math.floor(v / GRID_CELL);
    return [f(b.min.x), f(b.min.y), f(b.min.z), f(b.max.x), f(b.max.y), f(b.max.z)];
  }
}

/** A receiver geometry's arrays as the clipper reads them, their hash and size (kept per geometry until its arrays change). */
interface GeometryData {
  readonly data: DecalClipReceiverData;
  readonly hash: string;
  readonly bytes: number;
  readonly versions: string;
}

/** Floats `n` per vertex, as stored when they already are (interleaved and quantized attributes are unpacked). */
function floatsOf(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, n: number): Float32Array {
  const plain = a as THREE.BufferAttribute;
  if ((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute !== true && plain.array instanceof Float32Array && a.itemSize === n && !a.normalized) return plain.array.subarray(0, a.count * n);
  const out = new Float32Array(a.count * n);
  for (let i = 0; i < a.count; i++) {
    out[i * n] = a.getX(i);
    if (n > 1) out[i * n + 1] = a.getY(i);
    if (n > 2) out[i * n + 2] = a.getZ(i);
  }
  return out;
}

const geometryData = new WeakMap<THREE.BufferGeometry, GeometryData>();
const versionsOf = (g: THREE.BufferGeometry): string => {
  const v = (a: { version?: number } | null | undefined): number => a?.version ?? -1;
  return `${v(g.getAttribute('position') as { version?: number })}:${v(g.getAttribute('normal') as { version?: number } | undefined)}:${v(g.index)}`;
};

/** The geometry a clip reads from a mesh (null: no positions). */
function dataOf(g: THREE.BufferGeometry): GeometryData | null {
  const versions = versionsOf(g);
  const known = geometryData.get(g);
  if (known !== undefined && known.versions === versions) return known;
  const pos = g.getAttribute('position');
  if (pos === undefined || pos.itemSize < 3) return null;
  const positions = floatsOf(pos, 3);
  const nrm = g.getAttribute('normal');
  const normals = nrm !== undefined && nrm.itemSize === 3 ? floatsOf(nrm, 3) : null;
  const ix = g.index;
  const index = ix === null ? null : ix.array instanceof Uint16Array || ix.array instanceof Uint32Array ? ix.array.subarray(0, ix.count) : Uint32Array.from(ix.array as ArrayLike<number>).subarray(0, ix.count);
  const data: DecalClipReceiverData = { positions, normals, index };
  const out: GeometryData = { data, hash: decalClipGeometryHash(positions, normals, index), bytes: positions.byteLength + (normals?.byteLength ?? 0) + (index?.byteLength ?? 0), versions };
  geometryData.set(g, out);
  return out;
}

/** Whether a drawn mesh is a decal's own mark (a clipped decal's mesh or a mesh decal): never a surface to place a decal on. */
export function isDecalMark(o: THREE.Object3D): boolean {
  const m = o as THREE.Mesh;
  if (m.userData?.[CLIPPED_DECAL_KEY] !== undefined) return true;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  return mats.some((mat) => mat !== undefined && decalDrawOf(mat) !== null);
}

/** Whether a drawable is a surface a clipped decal may be cut from (its layers aside). */
export function isDecalSurface(o: THREE.Object3D): boolean {
  const m = o as THREE.Mesh;
  if (m.isMesh !== true || (m as THREE.InstancedMesh).isInstancedMesh === true || (m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh === true) return false;
  const d = m.userData;
  if (d[CLIPPED_DECAL_KEY] !== undefined || (d[BATCH_KEY] === undefined && d[DECAL_SURFACE_KEY] !== true)) return false;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  // A decal over a decal is the decals' sort order's job; a see-through surface (water, glass) takes no mark.
  for (const mat of mats) if (mat === undefined || decalDrawOf(mat) !== null || mat.transparent === true) return false;
  return m.geometry?.getAttribute('position') !== undefined;
}

interface Surface {
  readonly mesh: THREE.Mesh;
  box: THREE.Box3 | null;
  /** Let go of by the render graph (dropped at the next frame, once the decals it reached are told). */
  gone: boolean;
}

interface Receiver {
  readonly geometry: string;
  readonly matrix: number[];
  readonly g: GeometryData;
}

interface Job {
  readonly key: string;
  readonly projector: DecalClipProjector;
  readonly receivers: readonly Receiver[];
}

interface DecalRec {
  readonly id: string;
  decal: ProjectedDecalLike;
  scope: string | null;
  /** The world matrix last clipped for (its frame and box follow it). */
  readonly matrix: THREE.Matrix4;
  /** Its box in the world (the grid's). */
  readonly box: THREE.Box3;
  dirty: boolean;
  /** When it was first made dirty since it was last looked at, and the frame a surface near it last changed. */
  dirtySince: number;
  touched: number;
  /** The key it wants drawn ('' nothing under it), and the key of what is drawn. */
  key: string | null;
  shown: string | null;
  mesh: THREE.Mesh | null;
  undo: (() => void) | null;
  /** When it was set (its first mesh's time is measured from it), and whether it has been drawn since. */
  readonly since: number;
  everShown: boolean;
}

const v3 = new THREE.Vector3();
const q4 = new THREE.Quaternion();
const s3 = new THREE.Vector3();
const frame = new THREE.Matrix4();
const rel = new THREE.Matrix4();
const UNIT = new THREE.Vector3(1, 1, 1);
/**
 * Steps a receiver's place relative to the decal (and the decal's scale) is rounded to before it is keyed and
 * clipped: 2⁻²⁰ (about a micrometre, a millionth of a turn). A decal and its surface moving together compose
 * their matrices through other rotations each frame and land a rounding error apart; on this grid they keep
 * one key (−0 is made 0: its bits differ).
 */
const PLACE_STEPS = 1048576;
const placed = (v: number): number => Math.round(v * PLACE_STEPS) / PLACE_STEPS + 0;
const BOX_CORNERS = [-0.5, 0.5];

/** A placeholder until the decal material is put on (hidden: nothing draws, the batcher leaves it alone). */
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

export class ClippedDecals implements SurfaceListener {
  private readonly decals = new Map<string, DecalRec>();
  private readonly decalGrid = new BoxGrid<DecalRec>();
  private readonly surfaces = new Map<THREE.Object3D, Surface>();
  private readonly surfaceGrid = new BoxGrid<Surface>();
  /** Surfaces that came, went or moved since the last frame (their boxes are read then: an entity's parts are placed after they come). */
  private readonly touched = new Set<THREE.Object3D>();
  /** Decal entities whose node was placed since the last frame, and decals to look at again. */
  private readonly placedIds = new Set<string>();
  private readonly dirtyRecs = new Set<DecalRec>();
  /** Decals with nothing under them yet, still in their empty wait. */
  private readonly emptyWait = new Set<DecalRec>();
  /** Decals whose empty result is final at once (the editor's placement preview: the surfaces it moves over are all there). */
  private readonly noWait = new Set<string>();
  private readonly cache = new Map<string, { mesh: DecalClipMesh; bytes: number }>();
  private cacheBytes = 0;
  /** Keys waiting for a job, being made (on a worker or read from the store), and the jobs on workers. */
  private queue: Job[] = [];
  private readonly making = new Set<string>();
  private readonly jobs = new Map<number, { job: Job; worker: number }>();
  private nextJob = 1;
  /** Per worker: the geometries it holds (hash → bytes, oldest first) and their total. */
  private readonly held: { geometries: Map<string, number>; bytes: number }[] = [];
  private readonly pageHeld = new Map<string, DecalClipReceiverData>();
  private readonly made = { worker: 0, page: 0, memory: 0, store: 0 };
  private readonly ms = { worker: [0, 0, 0], page: [0, 0, 0] };
  private readonly problems = new Set<string>();
  private frameNo = 0;
  private firstSet: number | null = null;
  private readyMs: number | null = null;
  /** When the first frame was drawn, and the frames and time from it to all decals drawn (the last time they all were). */
  private firstFrameAt: number | null = null;
  private readyFrames: number | null = null;
  private readyAfterFirstFrameMs: number | null = null;
  private wasReady = false;
  private workersGone = false;
  private disposed = false;

  constructor(private readonly deps: ClippedDecalsDeps) {
    deps.workers?.onSideJobs(
      (worker, message) => this.reply(worker, message as DecalClipJobReply),
      () => this.workersFailed(),
    );
  }

  /** A decal entity was realized (or realized again) with `decal` (null, or not clipped: it has none). */
  set(id: string, decal: ProjectedDecalLike | null, scope: string | null): void {
    if (decal === null || decal.mode !== 'clipped') {
      this.remove(id);
      return;
    }
    let rec = this.decals.get(id);
    if (rec === undefined) {
      rec = { id, decal, scope, matrix: new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), box: new THREE.Box3(), dirty: true, dirtySince: performance.now(), touched: -1, key: null, shown: null, mesh: null, undo: null, since: performance.now(), everShown: false };
      this.decals.set(id, rec);
      if (!this.noWait.has(id)) this.firstSet ??= rec.since;
    } else {
      // Realized again after an edit: its node is new, so its mesh is made again (from the cache when its key holds).
      this.dropMesh(rec);
      rec.decal = decal;
      rec.scope = scope;
      rec.shown = null;
      rec.key = null;
      this.dirty(rec);
    }
    // Its box is placed at the next frame (the node's matrix is right by then).
    rec.matrix.elements[15] = Number.NaN;
    this.placedIds.add(id);
    this.dirty(rec);
  }

  /** The decal entity was released (or its decal removed): its mesh goes (its key's mesh stays cached). */
  remove(id: string): void {
    const rec = this.decals.get(id);
    if (rec === undefined) return;
    this.dropMesh(rec);
    this.decalGrid.remove(rec);
    this.decals.delete(id);
  }

  /**
   * The decal's empty result is final at once (true), or only after the wait a level's arriving surfaces need
   * (false, the default): a placement preview moves over a scene that is already there.
   */
  waitForSurfaces(id: string, wait: boolean): void {
    if (wait) this.noWait.delete(id);
    else this.noWait.add(id);
  }

  /** The clipped mesh drawn for a decal now (null: none, or not made yet): what "Bake to model" writes. */
  meshOf(id: string): THREE.Mesh | null {
    return this.decals.get(id)?.mesh ?? null;
  }

  // ---- SurfaceListener (the render graph)

  added(o: THREE.Object3D): void {
    if (this.disposed || !isDecalSurface(o)) return;
    const known = this.surfaces.get(o);
    if (known !== undefined) known.gone = false;
    else this.surfaces.set(o, { mesh: o as THREE.Mesh, box: null, gone: false });
    this.touched.add(o);
  }

  removed(o: THREE.Object3D): void {
    const s = this.surfaces.get(o);
    if (s === undefined) return;
    // With no decal to tell, it just goes.
    if (this.decals.size === 0) {
      this.surfaceGrid.remove(s);
      this.surfaces.delete(o);
      this.touched.delete(o);
      return;
    }
    s.gone = true;
    this.touched.add(o);
  }

  moved(o: THREE.Object3D): void {
    if (this.decals.size > 0 && this.surfaces.has(o)) this.touched.add(o);
  }

  /** Once a frame before the draw (after the world matrices): follow moved decals and changed surfaces, clip what changed. */
  beforeFrame(): void {
    if (this.disposed) return;
    this.frameNo += 1;
    const now = performance.now();
    this.firstFrameAt ??= now;
    // Surfaces are placed only once a decal could be told (a level without clipped decals pays nothing more).
    if (this.touched.size > 0 && this.decals.size > 0) {
      for (const o of this.touched) {
        const s = this.surfaces.get(o);
        if (s === undefined) continue;
        // The decals its old and new places reach are looked at again.
        if (s.box !== null) this.touchNear(s.box);
        if (s.gone) {
          this.surfaceGrid.remove(s);
          this.surfaces.delete(o);
          continue;
        }
        s.box = this.worldBox(s.mesh);
        this.surfaceGrid.set(s, s.box);
        if (s.box !== null) this.touchNear(s.box);
      }
      this.touched.clear();
    }
    // Only decals whose node was placed (moved, or new) are looked at: a still level costs nothing a frame.
    if (this.placedIds.size > 0) {
      for (const id of this.placedIds) {
        const rec = this.decals.get(id);
        const node = rec === undefined ? null : this.deps.node(id);
        if (rec === undefined || node === null || rec.matrix.equals(node.matrixWorld)) continue;
        rec.matrix.copy(node.matrixWorld);
        this.decalBox(rec);
        this.decalGrid.set(rec, rec.box);
        this.dirty(rec);
      }
      this.placedIds.clear();
    }
    if (this.emptyWait.size > 0) {
      for (const rec of this.emptyWait) {
        if (!this.decals.has(rec.id) || rec.key !== '') this.emptyWait.delete(rec);
        else if (this.noWait.has(rec.id) || now - rec.since >= CLIPPED_DECAL_EMPTY_WAIT_MS) {
          this.emptyWait.delete(rec);
          this.show(rec, null, '', 'page');
        }
      }
      // Still waiting: frames go on (a host drawing on demand draws one).
      if (this.emptyWait.size > 0) this.deps.changed();
    }
    if (this.dirtyRecs.size === 0 && this.jobs.size === 0 && this.making.size === 0 && this.wasReady) return;
    for (const rec of this.dirtyRecs) {
      if (!this.decals.has(rec.id)) {
        this.dirtyRecs.delete(rec);
        continue;
      }
      const node = this.deps.node(rec.id);
      if (node === null || (rec.touched >= this.frameNo && now - rec.dirtySince <= CLIPPED_DECAL_SETTLE_MS)) continue;
      this.dirtyRecs.delete(rec);
      this.resolve(rec, node);
    }
    this.dispatch();
    this.settle(now);
    // Decals waiting for their surfaces to settle are looked at in a later frame: a host drawing on demand draws one.
    if (this.dirtyRecs.size > 0) this.deps.changed();
  }

  placed(entityId: string): void {
    if (this.decals.has(entityId)) this.placedIds.add(entityId);
  }

  diagnostics(): ClippedDecalsDiagnostics {
    let drawn = 0;
    let empty = 0;
    let triangles = 0;
    for (const r of this.decals.values()) {
      if (r.mesh !== null) {
        drawn += 1;
        triangles += (r.mesh.geometry.index?.count ?? 0) / 3;
      } else if (r.shown !== null && r.shown === r.key) empty += 1;
    }
    const mean = (m: number[]): { mean: number; max: number } => ({ mean: m[0]! > 0 ? m[1]! / m[0]! : 0, max: m[2]! });
    return {
      decals: this.decals.size,
      drawn,
      empty,
      pending: this.pendingCount(),
      triangles,
      surfaces: this.surfaces.size,
      made: { ...this.made },
      workerMs: mean(this.ms.worker),
      pageMs: mean(this.ms.page),
      readyMs: this.readyMs,
      readyAfterFirstFrameMs: this.readyAfterFirstFrameMs,
      readyFrames: this.readyFrames,
      cacheBytes: this.cacheBytes,
      problems: [...this.problems],
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.decals.keys()]) this.remove(id);
    this.cache.clear();
    this.queue = [];
    this.jobs.clear();
  }

  // ---- internals

  private pendingCount(): number {
    let n = 0;
    for (const r of this.decals.values()) if (r.dirty || r.key === null || r.shown !== r.key) n += 1;
    return n;
  }

  private settle(now: number): void {
    const ready = this.decals.size > 0 && this.pendingCount() === 0;
    if (ready && !this.wasReady && this.firstSet !== null) {
      this.readyMs = now - this.firstSet;
      this.readyFrames = this.frameNo;
      this.readyAfterFirstFrameMs = this.firstFrameAt === null ? null : now - this.firstFrameAt;
      perfMark(CLIPPED_DECALS_READY_MARK, { ms: this.readyMs, frames: this.frameNo, afterFirstFrameMs: this.readyAfterFirstFrameMs, decals: this.decals.size });
    }
    this.wasReady = ready;
  }

  private dirty(rec: DecalRec): void {
    if (!rec.dirty) rec.dirtySince = performance.now();
    rec.dirty = true;
    this.dirtyRecs.add(rec);
    this.wasReady = false;
  }

  private touchNear(box: THREE.Box3): void {
    this.decalGrid.near(box, (rec) => {
      if (!rec.box.intersectsBox(box)) return;
      this.dirty(rec);
      rec.touched = this.frameNo;
    });
  }

  private worldBox(mesh: THREE.Mesh): THREE.Box3 | null {
    const g = mesh.geometry;
    if (g.boundingBox === null) g.computeBoundingBox();
    if (g.boundingBox === null || g.boundingBox.isEmpty()) return null;
    return g.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  }

  /** The decal's box in the world, from its node's matrix and its size. */
  private decalBox(rec: DecalRec): void {
    const s = rec.decal.size;
    rec.box.makeEmpty();
    for (const x of BOX_CORNERS) for (const y of BOX_CORNERS) for (const z of BOX_CORNERS) rec.box.expandByPoint(v3.set(x * (s[0] ?? 1), y * (s[1] ?? 1), z * (s[2] ?? 1)).applyMatrix4(rec.matrix));
  }

  /** Find the decal's receivers and its key; show what the key names, or have it made. */
  private resolve(rec: DecalRec, node: THREE.Object3D): void {
    rec.dirty = false;
    const layers = typeof rec.decal.layers === 'number' ? rec.decal.layers : DECAL_LAYERS_ALL;
    // The decal's rigid frame: receivers are placed relative to it, its scale is the projector's.
    node.matrixWorld.decompose(v3, q4, s3);
    frame.compose(v3, q4, UNIT).invert();
    const found: Receiver[] = [];
    const seen = new Set<string>();
    this.surfaceGrid.near(rec.box, (s) => {
      if (s.box === null || !s.box.intersectsBox(rec.box) || (objectDecalLayers(s.mesh) & layers) === 0) return;
      const g = dataOf(s.mesh.geometry);
      if (g === null) return;
      rel.multiplyMatrices(frame, s.mesh.matrixWorld);
      const matrix = Array.from(rel.elements, placed);
      const tag = `${g.hash}:${matrix.join(',')}`;
      if (seen.has(tag)) return;
      seen.add(tag);
      found.push({ geometry: g.hash, matrix, g });
    });
    const sx = placed(s3.x), sy = placed(s3.y), sz = placed(s3.z);
    const c = rec.decal;
    const projector: DecalClipProjector = {
      matrix: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1],
      size: [...c.size],
      ...(c.normalFade !== undefined ? { normalFade: c.normalFade } : {}),
      ...(c.edgeFade !== undefined ? { edgeFade: [...c.edgeFade] } : {}),
    };
    const receivers = sortDecalClipReceivers(found);
    const key = receivers.length === 0 ? '' : decalClipKey(projector, receivers);
    if (key === rec.key && rec.shown === key) return;
    rec.key = key;
    if (key === '') {
      // Nothing under it yet, so soon after it was set: the level's surfaces may still be arriving (a model
      // loading, a chunk being meshed). It counts as settled only once the wait is over with still nothing there.
      if (!this.noWait.has(rec.id) && performance.now() - rec.since < CLIPPED_DECAL_EMPTY_WAIT_MS) {
        this.dropMesh(rec);
        rec.shown = null;
        this.emptyWait.add(rec);
        this.deps.changed();
        return;
      }
      this.show(rec, null, '', 'page');
      return;
    }
    this.emptyWait.delete(rec);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // Most recently used last (the first ones go when the cache is full).
      this.cache.delete(key);
      this.cache.set(key, hit);
      this.made.memory += 1;
      this.show(rec, hit.mesh, key, 'memory');
      return;
    }
    if (this.making.has(key)) return;
    this.making.add(key);
    const job: Job = { key, projector, receivers };
    const store = this.deps.store ?? null;
    if (store === null) {
      this.queue.push(job);
      return;
    }
    void store.get(CLIPPED_DECAL_STORE_PREFIX + key).then(
      (bytes) => {
        const mesh = bytes === null ? null : decodeDecalClipMesh(bytes);
        if (mesh === null || this.disposed) {
          if (!this.disposed) this.queue.push(job);
          return;
        }
        this.arrived(key, mesh, 'store', 0);
      },
      () => this.queue.push(job),
    );
  }

  /** Jobs to free workers (or made on the page when there are none, within the frame's budget). */
  private dispatch(): void {
    if (this.queue.length === 0) return;
    let pageLeft = PAGE_CLIP_BUDGET_MS;
    let pageMade = 0;
    const wanted = new Set<string | null>();
    for (const r of this.decals.values()) wanted.add(r.key);
    while (this.queue.length > 0) {
      const w = this.workersGone || this.deps.workers === null ? 'page' : this.deps.workers.sideWorker();
      if (w === null) return;
      const job = this.queue[0]!;
      // A key nobody wants any more (its decals moved on or left) is not made.
      if (!wanted.has(job.key)) {
        this.queue.shift();
        this.making.delete(job.key);
        continue;
      }
      if (w === 'page') {
        if (pageMade > 0 && pageLeft <= 0) return;
        this.queue.shift();
        const t0 = performance.now();
        const reply = answerDecalClipJob({ t: 'decalClip', job: 0, projector: job.projector, receivers: job.receivers.map((r) => ({ geometry: r.geometry, matrix: r.matrix, data: r.g.data })) }, this.pageHeld);
        this.pageHeld.clear();
        if (reply.ok) this.arrived(job.key, reply.mesh, 'page', reply.ms);
        else this.failed(job.key, reply.message);
        pageMade += 1;
        pageLeft -= performance.now() - t0;
        continue;
      }
      this.queue.shift();
      this.post(w, job);
    }
  }

  /** Send `job` to worker `w`: the receivers it does not hold go with it; past its bound, the oldest it holds are let go. */
  private post(w: number, job: Job): void {
    while (this.held.length <= w) this.held.push({ geometries: new Map(), bytes: 0 });
    const h = this.held[w]!;
    const used = new Set(job.receivers.map((r) => r.geometry));
    const receivers: DecalClipJobRequest['receivers'][number][] = [];
    for (const r of job.receivers) {
      const had = h.geometries.get(r.geometry);
      if (had !== undefined) {
        h.geometries.delete(r.geometry);
        h.geometries.set(r.geometry, had);
        receivers.push({ geometry: r.geometry, matrix: r.matrix });
      } else {
        h.geometries.set(r.geometry, r.g.bytes);
        h.bytes += r.g.bytes;
        receivers.push({ geometry: r.geometry, matrix: r.matrix, data: r.g.data });
      }
    }
    const forget: string[] = [];
    for (const [g, bytes] of h.geometries) {
      if (h.bytes <= CLIPPED_DECAL_WORKER_BYTES) break;
      if (used.has(g)) continue;
      h.geometries.delete(g);
      h.bytes -= bytes;
      forget.push(g);
    }
    const n = this.nextJob++;
    this.jobs.set(n, { job, worker: w });
    const req: DecalClipJobRequest = { t: 'decalClip', job: n, projector: job.projector, receivers, ...(forget.length > 0 ? { forget } : {}) };
    this.deps.workers!.postSide(w, req);
  }

  private reply(worker: number, m: DecalClipJobReply): void {
    if (m?.t !== 'decalClipped') return;
    const j = this.jobs.get(m.job);
    if (j === undefined) return;
    this.jobs.delete(m.job);
    if (m.ok) {
      this.arrived(j.job.key, m.mesh, 'worker', m.ms);
      this.deps.changed();
      return;
    }
    if (m.missing === true) {
      // What the page thought the worker held is not so: it holds nothing, and the job goes again with its arrays.
      const h = this.held[worker];
      if (h !== undefined) {
        h.geometries.clear();
        h.bytes = 0;
      }
      this.queue.unshift(j.job);
      return;
    }
    this.failed(j.job.key, m.message);
  }

  private workersFailed(): void {
    this.workersGone = true;
    for (const { job } of this.jobs.values()) this.queue.unshift(job);
    this.jobs.clear();
    this.held.length = 0;
    this.deps.changed();
  }

  private failed(key: string, message: string): void {
    this.making.delete(key);
    this.problems.add(message);
    for (const rec of this.decals.values()) if (rec.key === key) this.show(rec, null, key, 'page');
  }

  /** A made mesh: kept by its key, written to the store when it was clipped here, and shown on the decals that want it. */
  private arrived(key: string, mesh: DecalClipMesh, where: 'worker' | 'page' | 'store', ms: number): void {
    this.making.delete(key);
    this.made[where] += 1;
    if (where !== 'store') {
      const t = this.ms[where];
      t[0] = t[0]! + 1;
      t[1] = t[1]! + ms;
      t[2] = Math.max(t[2]!, ms);
      this.deps.store?.put(CLIPPED_DECAL_STORE_PREFIX + key, encodeDecalClipMesh(mesh));
    }
    this.remember(key, mesh);
    for (const rec of this.decals.values()) if (rec.key === key && rec.shown !== key) this.show(rec, mesh, key, where);
    this.settle(performance.now());
  }

  private remember(key: string, mesh: DecalClipMesh): void {
    if (this.cache.has(key)) return;
    const bytes = decalClipMeshBytes(mesh);
    this.cache.set(key, { mesh, bytes });
    this.cacheBytes += bytes;
    for (const [k, v] of this.cache) {
      if (this.cacheBytes <= CLIPPED_DECAL_CACHE_BYTES || k === key) break;
      this.cache.delete(k);
      this.cacheBytes -= v.bytes;
    }
  }

  private dropMesh(rec: DecalRec): void {
    const mesh = rec.mesh;
    if (mesh === null) return;
    rec.undo?.();
    rec.undo = null;
    mesh.removeFromParent();
    mesh.geometry.dispose();
    rec.mesh = null;
  }

  /** Draw `m` (null: nothing) as the decal's mesh, in place of what it drew. */
  private show(rec: DecalRec, m: DecalClipMesh | null, key: string, where: 'worker' | 'page' | 'memory' | 'store'): void {
    const node = this.deps.node(rec.id);
    this.dropMesh(rec);
    rec.shown = key;
    if (m !== null && m.index.length > 0 && node !== null) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
      g.setAttribute('tangent', new THREE.BufferAttribute(m.tangents, 4));
      const albedo = rec.decal.opacity?.albedo;
      const fades = typeof albedo === 'number' && albedo !== 1 ? m.fades.map((f) => f * albedo) : m.fades;
      g.setAttribute(DECAL_FADE_ATTRIBUTE, new THREE.BufferAttribute(fades, 1));
      g.setIndex(new THREE.BufferAttribute(m.index, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, HIDDEN);
      mesh.name = `decal-clip:${rec.id}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData[CLIPPED_DECAL_KEY] = rec.id;
      mesh.userData[BATCH_KEY] = true;
      if (rec.scope !== null) {
        mesh.userData[STATIC_KEY] = rec.scope;
        // Its room is the one its marks face: where the projector looks from (the box's +Z face), not the middle of
        // its bounds, which across a room's outside corner lies inside the room (and would be culled with it).
        const front = v3.set(0, 0, (rec.decal.size[2] ?? 1) / 2).applyMatrix4(node.matrixWorld);
        mesh.userData[ROOM_AT_KEY] = [front.x, front.y, front.z];
      }
      const order = rec.decal.sortOrder;
      if (typeof order === 'number' && order !== 0) mesh.userData[DECAL_ORDER_OFFSET_KEY] = order;
      rec.undo = this.deps.dress(mesh, rec.decal.material);
      rec.mesh = mesh;
      node.add(mesh);
    }
    if (!rec.everShown) {
      rec.everShown = true;
      perfMark(CLIPPED_DECAL_MARK, { decal: rec.id, ms: performance.now() - rec.since, where: key === '' ? 'nothing' : where });
    }
    this.deps.changed();
  }
}
