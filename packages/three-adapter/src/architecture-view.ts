/**
 * The adapter's generated architecture: objects carrying `architecture`
 * made into meshes at load, a chunk at a time, nearest the eye first.
 *
 * - Each chunk is one job for the generator workers (`architecture-worker.ts`,
 *   on workers of the view's worker script; the page runs the same function
 *   when no worker can). A chunk's key hashes the generator version, its
 *   sheets and profiles and only the elements that reach it, so an edit
 *   re-makes only the chunks it touches; made chunks are kept by key in
 *   memory (and, given a store, in IndexedDB across visits).
 * - A chunk draws one mesh per material slot (one draw per chunk per
 *   material), as a `THREE.LOD` of its near level and its far level (detail
 *   left out) where they differ; kit copies as instance sets of their models.
 *   The meshes stand still and cast into the cached static shadow map.
 *   They wear the object's materials for their slots (`architecture` or
 *   `*`): the trim material reads the generator's COLOR_0 (baked AO).
 * - An export that ships meshes names its blob (`baked`): its chunks are
 *   drawn as they are, nothing is generated.
 * - An object drawn on a block layer (`layer`) is made with the layer's
 *   wall paint read onto its faces; when the layer is set again only the
 *   chunks whose paint changed are made again (their keys hash it).
 * - What was drawn stays until what replaces it is in: an edit keeps a
 *   changed chunk's old meshes until its new ones are made, and an object
 *   released and realized again in the same frame (every edit) keeps all
 *   of them.
 */
import * as THREE from 'three';
import {
  ARCHITECTURE_CHUNK_DEFAULT,
  ARCHITECTURE_COPY_FLOATS,
  ARCHITECTURE_LOD_DISTANCE_DEFAULT,
  ARCHITECTURE_MATERIAL_SLOT,
  architectureChunkInput,
  architectureChunkKeys,
  architectureStylesOf,
  decodeArchitectureChunks,
  expandArchitecture,
  encodeArchitectureChunks,
  joinArchitectureChunkParts,
  type ArchitectureChunk,
  type ArchitectureChunkPart,
  type ArchitectureComponent,
  type ArchitectureGraphLike,
  type ArchitecturePaint,
  type ArchitecturePreview,
  type ArchitectureRoomPlan,
  type ArchitectureSheets,
  type ArchitectureStyles,
  type CutawayZone,
} from '@thirdlight/runtime';

import { answerArchitectureJob, type ArchitectureJobReply, type ArchitectureJobRequest } from './architecture-worker';
import type { MeshWorkerPort } from './block-mesh-pool';
import { splitByCutaway } from './block-cutaway-view';
import { buildInstanceSet, type BuiltInstanceSet } from './instancing';
import type { LodTuning } from './lod-switch';
import { ROOM_TAG_KEY } from './room-culling';
import { STATIC_CASTER_KEY } from './shadow-casters';
import type { ModelInstance } from './visual';
import { STREAM_ARRIVAL_MS } from './world-stream';

/** At most this many generator workers (the block mesher, the simulation, the page and the GPU process want cores too). */
export const ARCHITECTURE_WORKERS_MAX = 2;
/** Jobs a worker is given at once (one running, one waiting, so it never idles between replies). */
const IN_FLIGHT_PER_WORKER = 2;
/** Made chunks kept in memory by key (an undo, or a slider dragged back, finds them made): a cache's bound, not a project's. */
export const ARCHITECTURE_CACHE_BYTES = 64 * 1024 * 1024;
/** The chunk size (m) kit copies are culled and given levels by. */
const COPY_CHUNK_METRES = 32;
/** Performance marks: each chunk made (detail {object, ms, where}) and each object whose chunks are all drawn (detail {object, ms, chunks, first}). */
export const ARCHITECTURE_CHUNK_MARK = 'tl:arch:chunk';
export const ARCHITECTURE_READY_MARK = 'tl:arch:ready';
/** Performance mark: a slider's preview (detail {ms: the page's expanding and keying, objects made again}). */
export const ARCHITECTURE_PREVIEW_MARK = 'tl:arch:preview';

/** The page query that leaves generated architecture out (`?architecture=off`: a diagnostic comparison). */
export const ARCHITECTURE_URL_PARAM = 'architecture';

/** Whether a page draws generated architecture (`?architecture=off|0|false`: no). */
export function architectureFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(ARCHITECTURE_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** Made chunks kept across visits (an exported game's IndexedDB), by key. */
export interface ArchitectureChunkStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): void;
}

export interface ArchitectureViewDeps {
  /** The row tables the object's material slots wear (its `materials`, over `extra`: the trim sheets its presets name). */
  sheets(entityId: string, component: ArchitectureComponent, extra: Readonly<Record<string, string>>): ArchitectureSheets;
  /** The same for an object not realized yet (a scene prepared ahead), from its own `materials` (absent: as `sheets` with no object). */
  sheetsOf?(materials: Readonly<Record<string, string>> | undefined, component: ArchitectureComponent, extra: Readonly<Record<string, string>>): ArchitectureSheets;
  /** Put the object's materials (over `extra`) on a chunk (the undo; null: none). */
  materials(root: THREE.Object3D, entityId: string, extra: Readonly<Record<string, string>>): (() => void) | null;
  /** The style and preset graphs outlines are made by (absent: the engine's starters only). */
  styles?: readonly ArchitectureGraphLike[] | null;
  /** The wall paint of the block layer an object's rooms are drawn on, for an object at `origin` (absent or null: none). */
  paint?: ((layerId: string, origin: readonly number[]) => ArchitecturePaint | null) | undefined;
  /** A kit model's template for instance sets (null: still loading; `onReady` once it is in). */
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /** Put a model's own materials on an instance set (the undo; null: none). */
  dress(root: THREE.Object3D, assetId: string): (() => void) | null;
  /** Read a stored blob by digest (an export's shipped meshes; null: none can be read). */
  read: ((digest: string) => Promise<ArrayBuffer>) | null;
  /** List (or unlist) a root's drawables in the scene. */
  place(root: THREE.Object3D, shown: boolean): void;
  /** The cached static shadow is drawn again. */
  shapeChanged(): void;
  /** Something new to draw. */
  changed(): void;
  /** Makes a generator worker (absent or null: chunks are made on the page). */
  worker?: (() => MeshWorkerPort | null) | undefined;
  /** How many workers to start (absent: {@link ARCHITECTURE_WORKERS_MAX}). */
  workers?: number;
  store?: ArchitectureChunkStore | null;
  /** The frame's time for arrivals shared with world streaming (absent: {@link STREAM_ARRIVAL_MS} of its own). */
  arrival?: { left(): number; spent(ms: number): void } | null;
  tuning?: LodTuning;
  /** False: nothing is drawn (a diagnostic comparison). */
  drawn?: boolean;
  /**
   * The cut-away zones of the block layer an object is drawn on (by
   * reference: a new list is new zones; null: none), and where its cut meshes
   * go to fade and hide with them (block-cutaway-view.ts).
   */
  cutaway?: {
    of(layerId: string): { readonly zones: readonly CutawayZone[]; readonly cellSize: readonly number[]; readonly origin: readonly number[] } | null;
    register(layerId: string, key: string, meshes: readonly { mesh: THREE.Mesh; zones: readonly number[] }[]): void;
    drop(layerId: string, key: string): void;
  };
  /** An object's rooms as expanded (null: it is gone or has none): the page's rooms and portals. */
  rooms?: ((id: string, origin: readonly number[], component: ArchitectureComponent, rooms: readonly ArchitectureRoomPlan[] | null) => void) | undefined;
}

interface BuiltChunk {
  readonly group: THREE.Group;
  /** Its meshes of cut-away zones, registered with its layer under this key (null: none). */
  readonly cut: { readonly layer: string; readonly key: string } | null;
  readonly geometries: THREE.BufferGeometry[];
  readonly sets: BuiltInstanceSet[];
  readonly undo: (() => void)[];
  readonly triangles: number;
  readonly draws: number;
}

interface ChunkRec {
  cx: number;
  cz: number;
  key: string;
  elements: number[];
  /** A heavy chunk's parts (absent: made whole): each a job, joined once all are made. */
  parts?: ArchitectureChunkPart[] | undefined;
  built: BuiltChunk | null;
  builtKey: string | null;
}

interface Rec {
  /** The component as given, and as the generator makes it (outlines made by their presets' styles). */
  raw: ArchitectureComponent;
  component: ArchitectureComponent;
  /** The trim sheets its presets name (slot → material) and the presets its outlines resolved through. */
  materials: Readonly<Record<string, string>>;
  presets: ReadonlySet<string>;
  origin: [number, number, number];
  hidden: boolean;
  chunks: Map<string, ChunkRec>;
  /** Built chunks whose place no element reaches any more: dropped once the rest are in. */
  stale: BuiltChunk[];
  leaving: boolean;
  /** An export's shipped chunks (by "cx,cz"), and the digest being read. */
  baked: Map<string, ArchitectureChunk> | null;
  bakedDigest: string | null;
  reading: string | null;
  /** When the current parameters were set, and whether they were ever all drawn. */
  since: number;
  waiting: boolean;
  everReady: boolean;
  /** The first frame's time after `since` (null: none yet). */
  firstFrame: number | null;
  /** The cut-away zones its chunks were split by (the layer's list; null: none). */
  zones: readonly CutawayZone[] | null;
}

/** Objects of a scene prepared ahead of its load: their chunks being made into the cache, not drawn. */
interface Prep {
  component: ArchitectureComponent;
  chunks: Map<string, { cx: number; cz: number; key: string; elements: number[]; parts?: ArchitectureChunkPart[] | undefined }>;
  /** The keys still being made. */
  pending: Set<string>;
  done: () => void;
}

/** The job id of a prepared object (never an object id: those use the id syntax). */
const prepId = (id: string): string => `\u0000${id}`;

interface Job {
  id: string;
  ck: string;
  /** The chunk's key, or a part's. */
  key: string;
  /** A part's job: the key of the chunk it is part of. */
  chunk?: string;
  d: number;
}

/** What the view draws and makes (diagnostics). */
export interface ArchitectureViewDiagnostics {
  objects: number;
  chunks: number;
  /** Draws: meshes of the near levels (one per chunk per material) and instance sets. */
  draws: number;
  triangles: number;
  copies: number;
  queued: number;
  inFlight: number;
  /** Made, waiting for a frame's arrival time to be drawn. */
  arriving: number;
  workers: number;
  cached: number;
  cacheBytes: number;
  /** Chunks made, by where: generated on a worker or the page, found in memory or the store, shipped. */
  made: { worker: number; page: number; memory: number; store: number; baked: number };
  /** Generation time per chunk (ms): mean and worst, on workers and on the page. */
  workerMs: { mean: number; max: number };
  pageMs: { mean: number; max: number };
  /** The last object made whole: ms from its parameters set to its last chunk drawn. */
  lastReadyMs: number | null;
  problems: string[];
  errors: string[];
}

const keyOf = (cx: number, cz: number): string => `${cx},${cz}`;
const bytesOf = (c: ArchitectureChunk): number => {
  let n = 64;
  for (const m of c.meshes) for (const a of [m.mesh.positions, m.mesh.normals, m.mesh.uvs, m.mesh.colors, m.mesh.indices, m.mesh.farIndices]) n += a.byteLength;
  for (const s of c.copies) n += s.transforms.byteLength + s.ids.length * 16;
  return n;
};

export class ArchitectureView {
  private readonly recs = new Map<string, Rec>();
  private readonly preparing = new Map<string, Prep>();
  private readonly cache = new Map<string, { chunk: ArchitectureChunk; bytes: number }>();
  private cacheBytes = 0;
  private queue: Job[] = [];
  private queueSorted = false;
  private readonly ready: { id: string; ck: string; key: string; chunk: ArchitectureChunk }[] = [];
  private readonly looking = new Set<string>();
  private readonly jobs = new Map<number, Job & { worker: number }>();
  private nextJob = 1;
  private workers: { port: MeshWorkerPort; busy: number; warm: boolean }[] | null = null;
  private workersFailed = false;
  private readonly surfaces = new Map<string, THREE.MeshStandardMaterial>();
  private readonly made = { worker: 0, page: 0, memory: 0, store: 0, baked: 0 };
  private readonly ms = { worker: [0, 0, 0], page: [0, 0, 0] };
  private lastReadyMs: number | null = null;
  private readonly problems = new Set<string>();
  private readonly errors: string[] = [];
  private eye: ArrayLike<number> = [0, 0, 0];
  private disposed = false;
  private styles: ArchitectureStyles;
  private swaps: Readonly<Record<string, string>> = {};
  private previewing: ArchitecturePreview | null = null;

  constructor(private readonly deps: ArchitectureViewDeps) {
    this.styles = architectureStylesOf(deps.styles ?? undefined);
  }

  /** The style and preset graphs changed: objects with outlines are made again (unchanged chunks keep their keys). */
  setStyles(graphs: readonly ArchitectureGraphLike[] | null): void {
    this.styles = architectureStylesOf(graphs ?? undefined);
    this.remake(() => true);
  }

  /** The presets a script swapped (preset → the one shown in its place), all of them. */
  setSwaps(swaps: Readonly<Record<string, string>>): void {
    this.swaps = swaps;
    this.remake(() => true);
  }

  /**
   * A slider being dragged: `values` over preset `preview.preset` and every
   * preset derived from it (null: the stored values again). Only objects
   * whose outlines that preset reaches are made again. Returns how many.
   */
  preview(preview: ArchitecturePreview | null): number {
    const t0 = performance.now();
    const before = this.previewing;
    this.previewing = preview;
    const objects = this.remake((rec) => (before !== null && rec.presets.has(before.preset)) || (preview !== null && rec.presets.has(preview.preset)));
    performance.mark(ARCHITECTURE_PREVIEW_MARK, { detail: { ms: performance.now() - t0, objects } });
    return objects;
  }

  /**
   * A block layer was set again (its cells or paint changed): objects drawn
   * on it are expanded again with its wall paint; only the chunks whose
   * paint changed are made again (their keys hash it).
   */
  layerChanged(layerId: string): number {
    return this.remake((rec) => rec.raw.layer === layerId, true);
  }

  /** Expand again the objects with outlines that `which` picks, and ask for the chunks that changed. */
  private remake(which: (rec: Rec) => boolean, any = false): number {
    let n = 0;
    for (const [id, rec] of this.recs) {
      if (rec.leaving || (!any && (rec.raw.outlines?.length ?? 0) === 0) || !which(rec)) continue;
      const sheetsBefore = JSON.stringify(rec.materials);
      this.expand(id, rec);
      n += 1;
      if (this.deps.drawn === false) continue;
      if (JSON.stringify(rec.materials) !== sheetsBefore) for (const c of rec.chunks.values()) if (c.built !== null) this.redress(id, c.built);
      this.refresh(id, rec);
    }
    if (n > 0) this.dispatch();
    return n;
  }

  /** The component the generator makes from the one given (outlines made by their presets' styles). */
  private expand(id: string, rec: Rec): void {
    const paint = rec.raw.layer !== undefined ? (this.deps.paint?.(rec.raw.layer, rec.origin) ?? null) : null;
    const x = expandArchitecture(rec.raw, rec.origin, this.styles, { swaps: this.swaps, preview: this.previewing, paint });
    // Shipped meshes are of the stored presets: a swapped or previewed one is generated here.
    const restyled = rec.raw.baked !== undefined && (rec.raw.outlines ?? []).some((o) => this.swaps[o.preset] !== undefined || (this.previewing !== null && x.presets.has(this.previewing.preset)));
    if (restyled) {
      const { baked: _baked, ...rest } = x.component;
      rec.component = rest;
    } else rec.component = x.component;
    rec.materials = x.materials;
    rec.presets = x.presets;
    for (const p of x.problems) this.problems.add(`${id}: ${p}`);
    this.deps.rooms?.(id, rec.origin, rec.raw, x.rooms);
  }

  /** An object carrying `architecture` was realized (or realized again), at `origin`. */
  set(id: string, component: ArchitectureComponent, origin: readonly number[]): void {
    const o: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    let rec = this.recs.get(id);
    if (rec === undefined) {
      rec = { raw: component, component, materials: {}, presets: new Set(), origin: o, hidden: false, chunks: new Map(), stale: [], leaving: false, baked: null, bakedDigest: null, reading: null, since: performance.now(), waiting: true, everReady: false, firstFrame: null, zones: null };
      this.recs.set(id, rec);
    }
    rec.leaving = false;
    const moved = rec.origin.some((v, i) => v !== o[i]);
    rec.raw = component;
    rec.origin = o;
    this.expand(id, rec);
    if (moved) for (const c of rec.chunks.values()) if (c.built !== null) this.moveBuilt(rec, c.built);
    if (this.deps.drawn === false) return;
    this.refresh(id, rec);
    // Jobs go out now, not at the next frame: the workers start (and load their script) while the scene's first frame is
    // still being prepared; the frame re-sorts what is left by the eye.
    this.dispatch();
  }

  /**
   * Objects about to load (a scene prepared ahead of its load, `entities`
   * as its document has them): their chunks made into the cache on the
   * workers, not drawn, so the frame the scene arrives in draws them at
   * once (their keys are found). `ready` once all are made (or failed);
   * `release` drops what is still waiting.
   */
  prepare(objects: readonly { readonly id: string; readonly component: ArchitectureComponent; readonly origin: readonly number[]; readonly materials?: Readonly<Record<string, string>> }[]): { readonly ready: Promise<void>; release(): void } {
    const ids: string[] = [];
    const waits: Promise<void>[] = [];
    if (this.deps.drawn !== false && !this.disposed) {
      for (const o of objects) {
        if (o.component.baked !== undefined) continue;
        const x = expandArchitecture(o.component, o.origin, this.styles, { swaps: this.swaps });
        const sheets = this.deps.sheetsOf?.(o.materials, x.component, x.materials) ?? this.deps.sheets('', x.component, x.materials);
        const id = prepId(o.id);
        const prep: Prep = { component: x.component, chunks: new Map(), pending: new Set(), done: () => undefined };
        for (const [ck, k] of architectureChunkKeys(x.component, sheets)) {
          prep.chunks.set(ck, { cx: k.cx, cz: k.cz, key: k.key, elements: k.elements, parts: k.parts });
          if (this.cache.has(k.key) || prep.pending.has(k.key)) continue;
          if (k.parts !== undefined && k.parts.every((p) => this.cache.has(p.key))) {
            this.remember(k.key, joinArchitectureChunkParts(k.parts.map((p) => this.cache.get(p.key)!.chunk)));
            continue;
          }
          prep.pending.add(k.key);
          this.enqueueChunk(id, ck, k, sheets);
        }
        if (prep.pending.size === 0) continue;
        waits.push(new Promise<void>((resolve) => (prep.done = resolve)));
        this.preparing.get(id)?.done();
        this.preparing.set(id, prep);
        ids.push(id);
      }
      this.dispatch();
    }
    return {
      ready: Promise.all(waits).then(() => undefined),
      release: () => {
        for (const id of ids) {
          const prep = this.preparing.get(id);
          if (prep === undefined) continue;
          this.preparing.delete(id);
          prep.done();
        }
        this.queue = this.queue.filter((j) => this.recs.has(j.id) || this.preparing.has(j.id));
      },
    };
  }

  /** An object was released: it goes at the next {@link update} unless set again first. */
  remove(id: string): void {
    const rec = this.recs.get(id);
    if (rec !== undefined) rec.leaving = true;
  }

  /** The object's materials or their sheets changed: worn again, and chunks whose sheet changed made again. */
  restyle(id: string): void {
    const rec = this.recs.get(id);
    if (rec === undefined) return;
    for (const c of rec.chunks.values()) if (c.built !== null) this.redress(id, c.built);
    this.refresh(id, rec);
    this.deps.shapeChanged();
  }

  /** Every object's sheets read again (the project's material definitions changed). */
  restyleAll(): void {
    for (const id of this.recs.keys()) this.restyle(id);
  }

  setHidden(id: string, hidden: boolean): void {
    const rec = this.recs.get(id);
    if (rec === undefined || rec.hidden === hidden) return;
    rec.hidden = hidden;
    for (const c of rec.chunks.values()) if (c.built !== null) this.deps.place(c.built.group, !hidden);
    this.deps.shapeChanged();
  }

  ids(): string[] {
    return [...this.recs.keys()];
  }

  /** An object's drawn meshes at full detail (its chunks' near levels; kit copies left out): what a probe bake sees of it. */
  meshes(id: string): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D): void => {
      if ((o as THREE.LOD).isLOD === true) {
        const first = (o as THREE.LOD).levels[0]?.object;
        if (first !== undefined) visit(first);
        return;
      }
      const m = o as THREE.Mesh;
      if (m.isMesh === true && (m as THREE.InstancedMesh).isInstancedMesh !== true) out.push(m);
      for (const c of o.children) visit(c);
    };
    for (const ch of this.recs.get(id)?.chunks.values() ?? []) if (ch.built !== null) visit(ch.built.group);
    return out;
  }

  /** Once a frame before the draw: drop released objects, send jobs nearest `eye` first, draw arrived chunks within the frame's arrival time. */
  update(eye: ArrayLike<number>): void {
    for (const [id, rec] of [...this.recs]) {
      if (!rec.leaving) continue;
      this.recs.delete(id);
      this.deps.rooms?.(id, rec.origin, rec.raw, null);
      for (const c of rec.chunks.values()) if (c.built !== null) this.dropBuilt(c.built);
      for (const b of rec.stale) this.dropBuilt(b);
    }
    const now = performance.now();
    for (const rec of this.recs.values()) rec.firstFrame ??= now;
    // Its layer's cut-away zones changed (a room or region edited, cut-aways set): its chunks are split again.
    for (const [id, rec] of this.recs) {
      const zones = rec.raw.layer !== undefined ? (this.deps.cutaway?.of(rec.raw.layer)?.zones ?? null) : null;
      if (zones === rec.zones) continue;
      rec.zones = zones;
      for (const [ck, ch] of rec.chunks) {
        if (ch.built === null || ch.builtKey === null) continue;
        ch.builtKey = null;
        const hit = this.cache.get(ch.key) ?? (rec.baked !== null ? { chunk: rec.baked.get(ck)! } : undefined);
        if (hit?.chunk !== undefined) this.ready.push({ id, ck, key: ch.key, chunk: hit.chunk });
        else this.want(id, ck, ch, this.deps.sheets(id, rec.component, rec.materials));
      }
    }
    if (eye[0] !== this.eye[0] || eye[1] !== this.eye[1] || eye[2] !== this.eye[2]) {
      this.eye = [eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0];
      this.queueSorted = false;
    }
    this.dispatch();
    let left = this.deps.arrival?.left() ?? STREAM_ARRIVAL_MS;
    // While a worker is still starting (its script loading), the page makes the nearest chunks it was sent itself, a
    // frame's arrival time at a time: the spawn's chunks are not kept waiting on a worker's start.
    const cold = [...this.jobs].filter(([, j]) => this.workers?.[j.worker]?.warm === false);
    if (cold.length > 0 && !this.pageMakes()) {
      const nearest = cold.map(([n, j]) => ({ n, j, d: this.distanceOf(j) })).sort((a, b) => a.d - b.d);
      let took = 0;
      for (const { n, j, d } of nearest) {
        if (left <= 0 && took > 0 && !this.near(j, d)) break;
        took += 1;
        this.jobs.delete(n);
        const t0 = performance.now();
        const req = this.request(j);
        if (req !== null) this.receive(j, answerArchitectureJob(req), 'page');
        const spent = performance.now() - t0;
        left -= spent;
        this.deps.arrival?.spent(spent);
      }
    }
    // Without workers the page makes chunks itself, within what is left of the frame's time (at least one).
    if (this.pageMakes()) {
      let made = 0;
      while (this.queue.length > 0 && (made === 0 || left > 0)) {
        const t0 = performance.now();
        const job = this.queue.shift()!;
        const req = this.request(job);
        if (req !== null) {
          const reply = answerArchitectureJob(req);
          this.receive(job, reply, 'page');
        }
        made += 1;
        const spent = performance.now() - t0;
        left -= spent;
        this.deps.arrival?.spent(spent);
      }
    }
    // Arrived chunks drawn within what is left of the frame's arrival time (at least one a frame).
    // The chunks round the eye (the spawn's, a teleport's) and those of an object not yet drawn at all (a scene loading:
    // they arrive only as fast as they are made) are drawn whatever the time: a view never shows a level half made.
    let first = true;
    const urgent = (r: { id: string; ck: string }): boolean => this.recs.get(r.id)?.everReady === false || this.near(r, this.distanceOf(r));
    while (this.ready.length > 0 && (first || left > 0 || urgent(this.ready[0]!))) {
      first = false;
      const t0 = performance.now();
      const r = this.ready.shift()!;
      this.apply(r.id, r.ck, r.key, r.chunk);
      const spent = performance.now() - t0;
      left -= spent;
      this.deps.arrival?.spent(spent);
    }
    for (const [id, rec] of this.recs) this.settle(id, rec);
  }

  diagnostics(): ArchitectureViewDiagnostics {
    let chunks = 0;
    let draws = 0;
    let triangles = 0;
    let copies = 0;
    for (const rec of this.recs.values()) {
      for (const c of rec.chunks.values()) {
        if (c.built === null) continue;
        chunks += 1;
        draws += c.built.draws;
        triangles += c.built.triangles;
        for (const s of c.built.sets) copies += s.count;
      }
    }
    const mean = (m: number[]): { mean: number; max: number } => ({ mean: m[0]! > 0 ? m[1]! / m[0]! : 0, max: m[2]! });
    return {
      objects: this.recs.size,
      chunks,
      draws,
      triangles,
      copies,
      queued: this.queue.length,
      inFlight: this.jobs.size,
      arriving: this.ready.length,
      workers: this.workers?.length ?? 0,
      cached: this.cache.size,
      cacheBytes: this.cacheBytes,
      made: { ...this.made },
      workerMs: mean(this.ms.worker),
      pageMs: mean(this.ms.page),
      lastReadyMs: this.lastReadyMs,
      problems: [...this.problems].slice(0, 16),
      errors: [...this.errors],
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.preparing.values()) p.done();
    this.preparing.clear();
    for (const rec of this.recs.values()) {
      for (const c of rec.chunks.values()) if (c.built !== null) this.dropBuilt(c.built);
      for (const b of rec.stale) this.dropBuilt(b);
    }
    this.recs.clear();
    for (const w of this.workers ?? []) w.port.terminate();
    this.workers = null;
    for (const m of this.surfaces.values()) m.dispose();
    this.surfaces.clear();
    this.cache.clear();
  }

  // ---- making --------------------------------------------------------------------------------

  /** Key the object's chunks for its current parameters and sheets; ask for those not drawn as they are. */
  private refresh(id: string, rec: Rec): void {
    const c = rec.component;
    if (c.baked !== undefined && this.deps.read !== null) {
      this.loadBaked(id, rec, c.baked);
      return;
    }
    const sheets = this.deps.sheets(id, c, rec.materials);
    const keys = architectureChunkKeys(c, sheets);
    let changed = false;
    for (const [ck, ch] of [...rec.chunks]) {
      if (keys.has(ck)) continue;
      rec.chunks.delete(ck);
      if (ch.built !== null) rec.stale.push(ch.built);
      changed = true;
    }
    for (const [ck, k] of keys) {
      const have = rec.chunks.get(ck);
      if (have !== undefined && have.key === k.key) {
        have.elements = k.elements;
        have.parts = k.parts;
        continue;
      }
      changed = true;
      const ch: ChunkRec = have ?? { cx: k.cx, cz: k.cz, key: k.key, elements: k.elements, built: null, builtKey: null };
      ch.key = k.key;
      ch.elements = k.elements;
      ch.parts = k.parts;
      rec.chunks.set(ck, ch);
      this.want(id, ck, ch, sheets);
    }
    if (changed) {
      rec.since = performance.now();
      rec.waiting = true;
      rec.firstFrame = null;
    }
  }

  private want(id: string, ck: string, ch: ChunkRec, sheets: ArchitectureSheets): void {
    const hit = this.cache.get(ch.key);
    if (hit !== undefined) {
      // Most recently used last.
      this.cache.delete(ch.key);
      this.cache.set(ch.key, hit);
      this.made.memory += 1;
      this.ready.push({ id, ck, key: ch.key, chunk: hit.chunk });
      return;
    }
    // Its parts all made before (an edit elsewhere in a heavy chunk, undone): joined now.
    if (this.joinParts(id, ck, ch, 'memory')) return;
    // Generated now and looked up in the store at once: the store answers first for chunks far down the queue (a
    // second visit), the generator first for the spawn's (opening IndexedDB takes a while on a cold start).
    this.enqueueChunk(id, ck, ch, sheets);
    const store = this.deps.store;
    if (store === undefined || store === null || this.looking.has(ch.key)) return;
    this.looking.add(ch.key);
    store.get(ch.key).then(
      (bytes) => {
        this.looking.delete(ch.key);
        if (this.disposed || bytes === null) return;
        const chunk = this.decodeOne(bytes);
        const now = this.recs.get(id)?.chunks.get(ck);
        if (chunk === null || now === undefined || now.key !== ch.key || now.builtKey === ch.key || this.cache.has(ch.key)) return;
        this.queue = this.queue.filter((j) => j.key !== ch.key && j.chunk !== ch.key);
        this.remember(ch.key, chunk);
        this.made.store += 1;
        this.ready.push({ id, ck, key: ch.key, chunk });
        this.deps.changed();
      },
      () => this.looking.delete(ch.key),
    );
  }

  /** The sheets each wanted key was keyed with (what its job generates with). */
  private readonly sheetsOf = new Map<string, ArchitectureSheets>();

  private decodeOne(bytes: Uint8Array): ArchitectureChunk | null {
    try {
      return decodeArchitectureChunks(bytes)[0] ?? null;
    } catch {
      return null;
    }
  }

  /** A chunk's jobs: the chunk whole, or each of its parts not made yet. */
  private enqueueChunk(id: string, ck: string, k: { key: string; parts?: ArchitectureChunkPart[] | undefined }, sheets: ArchitectureSheets): void {
    if (k.parts === undefined) {
      this.sheetsOf.set(k.key, sheets);
      this.enqueue({ id, ck, key: k.key, d: 0 });
      return;
    }
    for (const p of k.parts) {
      if (this.cache.has(p.key)) continue;
      this.sheetsOf.set(p.key, sheets);
      this.enqueue({ id, ck, key: p.key, chunk: k.key, d: 0 });
    }
  }

  /**
   * A heavy chunk whose parts are all made: joined (the bytes of the chunk
   * made whole), kept and stored by the chunk's key and drawn (or, prepared,
   * counted done). False while a part is missing.
   */
  private joinParts(id: string, ck: string, ch: { key: string; parts?: ArchitectureChunkPart[] | undefined }, where: 'worker' | 'page' | 'memory'): boolean {
    if (ch.parts === undefined) return false;
    const made: ArchitectureChunk[] = [];
    for (const p of ch.parts) {
      const hit = this.cache.get(p.key);
      if (hit === undefined) return false;
      made.push(hit.chunk);
    }
    const chunk = joinArchitectureChunkParts(made);
    this.made[where] += 1;
    this.remember(ch.key, chunk);
    if (where !== 'memory') this.deps.store?.put(ch.key, encodeArchitectureChunks([chunk]));
    if (this.preparing.has(id)) this.prepared({ id, ck, key: ch.key, d: 0 });
    else this.ready.push({ id, ck, key: ch.key, chunk });
    return true;
  }

  private enqueue(job: Job): void {
    if (this.queue.some((j) => j.key === job.key && j.id === job.id && j.ck === job.ck)) return;
    this.queue.push(job);
    this.queueSorted = false;
    this.deps.changed();
  }

  /** The request a job sends (null: its chunk is no longer wanted under that key). */
  private request(job: Job): ArchitectureJobRequest | null {
    const rec = this.recs.get(job.id) ?? this.preparing.get(job.id);
    const ch = rec?.chunks.get(job.ck);
    if (rec === undefined || ch === undefined || ch.key !== (job.chunk ?? job.key)) return null;
    // Made meanwhile for an object that loaded (a prepared chunk whose scene arrived first).
    if (this.preparing.has(job.id) && this.cache.has(ch.key)) {
      this.prepared({ ...job, key: ch.key });
      return null;
    }
    const part = job.chunk !== undefined ? ch.parts?.find((p) => p.key === job.key) : undefined;
    if (job.chunk !== undefined && part === undefined) return null;
    return { t: 'archGenerate', job: this.nextJob++, component: architectureChunkInput(rec.component, { cx: ch.cx, cz: ch.cz, elements: part?.elements ?? ch.elements }), sheets: this.sheetsOf.get(job.key) ?? {}, cx: ch.cx, cz: ch.cz };
  }

  /** A prepared object's chunk is in the cache (or failed): its preparation is done once all are. */
  private prepared(job: Job): void {
    const prep = this.preparing.get(job.id);
    if (prep === undefined) return;
    prep.pending.delete(job.key);
    if (prep.pending.size > 0) return;
    this.preparing.delete(job.id);
    prep.done();
  }

  /** Whether a chunk at squared distance `d` is one of those round the eye (within one and a half chunks). */
  private near(j: Pick<Job, 'id'>, d: number): boolean {
    const size = this.recs.get(j.id)?.component.chunkSize ?? ARCHITECTURE_CHUNK_DEFAULT;
    return d <= 2.25 * size * size;
  }

  /** A chunk's squared distance from the eye (level). */
  private distanceOf(j: Pick<Job, 'id' | 'ck'>): number {
    const rec = this.recs.get(j.id);
    const ch = rec?.chunks.get(j.ck);
    if (rec === undefined || ch === undefined) return Infinity;
    const size = rec.component.chunkSize ?? ARCHITECTURE_CHUNK_DEFAULT;
    const x = rec.origin[0] + (ch.cx + 0.5) * size - this.eye[0]!;
    const z = rec.origin[2] + (ch.cz + 0.5) * size - this.eye[2]!;
    return x * x + z * z;
  }

  private pageMakes(): boolean {
    return this.deps.worker === undefined || this.workersFailed || (this.workers !== null && this.workers.length === 0);
  }

  /** Nearest first: send queued jobs to free workers. */
  private dispatch(): void {
    if (this.queue.length === 0) return;
    if (!this.queueSorted) {
      for (const j of this.queue) j.d = this.distanceOf(j);
      this.queue.sort((a, b) => a.d - b.d);
      this.queueSorted = true;
    }
    if (this.pageMakes()) return;
    this.startWorkers();
    if (this.workers === null || this.workers.length === 0) return;
    for (;;) {
      let w = -1;
      for (let i = 0; i < this.workers.length; i++) if (this.workers[i]!.busy < IN_FLIGHT_PER_WORKER && (w < 0 || this.workers[i]!.busy < this.workers[w]!.busy)) w = i;
      if (w < 0 || this.queue.length === 0) return;
      const job = this.queue.shift()!;
      const req = this.request(job);
      if (req === null) continue;
      this.jobs.set(req.job, { ...job, worker: w });
      this.workers[w]!.busy += 1;
      this.workers[w]!.port.post(req);
    }
  }

  private startWorkers(): void {
    if (this.workers !== null || this.deps.worker === undefined) return;
    const n = Math.max(1, Math.min(ARCHITECTURE_WORKERS_MAX, this.deps.workers ?? ARCHITECTURE_WORKERS_MAX));
    const list: { port: MeshWorkerPort; busy: number; warm: boolean }[] = [];
    for (let i = 0; i < n; i++) {
      const port = this.deps.worker();
      if (port === null) break;
      const entry = { port, busy: 0, warm: false };
      port.listen((raw) => {
        const m = raw as Partial<ArchitectureJobReply> | null;
        if (m?.t !== 'archGenerated' || typeof m.job !== 'number') return;
        entry.busy = Math.max(0, entry.busy - 1);
        entry.warm = true;
        const job = this.jobs.get(m.job);
        // A job the page made itself meanwhile (the workers were still starting): the worker's answer is not needed.
        if (job === undefined) return;
        this.jobs.delete(m.job);
        this.receive(job, m as ArchitectureJobReply, 'worker');
        this.deps.changed();
      });
      port.onError((message) => this.failWorkers(message));
      list.push(entry);
    }
    this.workers = list;
  }

  private failWorkers(message: string): void {
    if (this.workersFailed) return;
    this.workersFailed = true;
    this.fail(`architecture workers: ${message}`);
    for (const w of this.workers ?? []) w.port.terminate();
    this.workers = [];
    // Their jobs are made on the page.
    for (const j of this.jobs.values()) this.queue.push({ id: j.id, ck: j.ck, key: j.key, ...(j.chunk !== undefined ? { chunk: j.chunk } : {}), d: 0 });
    this.jobs.clear();
    this.queueSorted = false;
    this.deps.changed();
  }

  private receive(job: Job, reply: ArchitectureJobReply, where: 'worker' | 'page'): void {
    if (!reply.ok) {
      this.fail(`architecture ${job.id}: chunk ${job.ck}: ${reply.message}`);
      this.prepared({ ...job, key: job.chunk ?? job.key });
      return;
    }
    const m = this.ms[where];
    m[0] = m[0]! + 1;
    m[1] = m[1]! + reply.ms;
    m[2] = Math.max(m[2]!, reply.ms);
    performance.mark(ARCHITECTURE_CHUNK_MARK, { detail: { object: job.id, chunk: job.ck, ms: reply.ms, where, ...(job.chunk !== undefined ? { part: true } : {}) } });
    this.remember(job.key, reply.chunk);
    this.sheetsOf.delete(job.key);
    if (job.chunk !== undefined) {
      // A part: the chunk is joined once its last part is in (the part is kept: an edit beside it re-makes only its neighbours).
      const ch = (this.recs.get(job.id) ?? this.preparing.get(job.id))?.chunks.get(job.ck);
      if (ch !== undefined && ch.key === job.chunk) this.joinParts(job.id, job.ck, ch, where);
      else if (this.preparing.has(job.id)) this.prepared({ ...job, key: job.chunk });
      return;
    }
    this.made[where] += 1;
    this.deps.store?.put(job.key, encodeArchitectureChunks([reply.chunk]));
    if (this.preparing.has(job.id)) this.prepared(job);
    else this.ready.push({ id: job.id, ck: job.ck, key: job.key, chunk: reply.chunk });
  }

  private remember(key: string, chunk: ArchitectureChunk): void {
    const bytes = bytesOf(chunk);
    const had = this.cache.get(key);
    if (had !== undefined) this.cacheBytes -= had.bytes;
    this.cache.delete(key);
    this.cache.set(key, { chunk, bytes });
    this.cacheBytes += bytes;
    while (this.cacheBytes > ARCHITECTURE_CACHE_BYTES && this.cache.size > 1) {
      const [k, v] = this.cache.entries().next().value!;
      this.cache.delete(k);
      this.cacheBytes -= v.bytes;
    }
  }

  private loadBaked(id: string, rec: Rec, digest: string): void {
    if (rec.bakedDigest === digest && rec.baked !== null) return;
    if (rec.reading === digest || this.deps.read === null) return;
    rec.reading = digest;
    this.deps.read(digest).then(
      (buf) => {
        if (this.disposed || this.recs.get(id) !== rec || rec.reading !== digest) return;
        rec.reading = null;
        let chunks: ArchitectureChunk[];
        try {
          chunks = decodeArchitectureChunks(new Uint8Array(buf));
        } catch (e) {
          this.fail(`architecture ${id}: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        rec.baked = new Map(chunks.map((c) => [keyOf(c.cx, c.cz), c]));
        rec.bakedDigest = digest;
        for (const c of chunks) {
          const ck = keyOf(c.cx, c.cz);
          const key = `${digest}:${ck}`;
          rec.chunks.set(ck, rec.chunks.get(ck) ?? { cx: c.cx, cz: c.cz, key, elements: [], built: null, builtKey: null });
          rec.chunks.get(ck)!.key = key;
          this.made.baked += 1;
          this.ready.push({ id, ck, key, chunk: c });
        }
        rec.since = performance.now();
        rec.waiting = true;
        this.deps.changed();
      },
      (e: unknown) => {
        if (rec.reading === digest) rec.reading = null;
        this.fail(`architecture ${id}: ${digest.slice(0, 12)}… could not be read (${e instanceof Error ? e.message : String(e)})`);
      },
    );
  }

  /** All of an object's chunks drawn: let go of the stale ones and mark the time it took. */
  private settle(id: string, rec: Rec): void {
    if (!rec.waiting) return;
    for (const ch of rec.chunks.values()) if (ch.builtKey !== ch.key) return;
    if (rec.reading !== null) return;
    rec.waiting = false;
    for (const b of rec.stale) this.dropBuilt(b);
    rec.stale = [];
    const ms = performance.now() - rec.since;
    this.lastReadyMs = ms;
    // `frame`: ms from the parameters to the first frame that could send their jobs (the rest is making and drawing).
    performance.mark(ARCHITECTURE_READY_MARK, { detail: { object: id, ms, chunks: rec.chunks.size, first: !rec.everReady, frame: (rec.firstFrame ?? rec.since) - rec.since } });
    rec.everReady = true;
  }

  // ---- drawing -------------------------------------------------------------------------------

  private apply(id: string, ck: string, key: string, chunk: ArchitectureChunk): void {
    const rec = this.recs.get(id);
    const ch = rec?.chunks.get(ck);
    if (rec === undefined || ch === undefined || ch.key !== key || ch.builtKey === key || this.disposed) return;
    for (const p of chunk.problems) this.problems.add(`${id}: ${p}`);
    // Kit models first: a chunk is drawn once every model it places is in (their arrival applies it again).
    const templates = chunk.copies.map((s) => this.deps.template(s.model.assetId, s.model.piece, () => this.recs.get(id)?.chunks.get(ck)?.key === key && this.ready.push({ id, ck, key, chunk })));
    if (templates.some((t) => t === null)) return;
    const size = rec.component.chunkSize ?? ARCHITECTURE_CHUNK_DEFAULT;
    const lodDistance = rec.component.lodDistance ?? ARCHITECTURE_LOD_DISTANCE_DEFAULT;
    const cast = rec.component.castShadow !== false;
    const receive = rec.component.receiveShadow !== false;
    const group = new THREE.Group();
    group.name = `architecture:${id}:${ck}`;
    group.position.set(...rec.origin);
    const centre = new THREE.Vector3((ch.cx + 0.5) * size, 0, (ch.cz + 0.5) * size);
    const geometries: THREE.BufferGeometry[] = [];
    let triangles = 0;
    let draws = 0;
    // Drawn on a layer with cut-away zones: each level's triangles in a zone are meshes of their own (fading and hiding with it).
    const layerCut = rec.raw.layer !== undefined ? (this.deps.cutaway?.of(rec.raw.layer) ?? null) : null;
    rec.zones = layerCut?.zones ?? null;
    const cutOffset = layerCut === null ? null : rec.origin.map((v, i) => v - (layerCut.origin[i] ?? 0));
    const cutMeshes: { mesh: THREE.Mesh; zones: readonly number[] }[] = [];
    for (const m of chunk.meshes) {
      const material = this.surface(m.material);
      const l = m.mesh;
      // One set of vertices; the near and far levels are index lists over it.
      const attributes = {
        position: new THREE.BufferAttribute(l.positions, 3),
        normal: new THREE.BufferAttribute(l.normals, 3),
        uv: new THREE.BufferAttribute(l.uvs, 2),
        color: new THREE.BufferAttribute(l.colors, 4, true),
      };
      let bounds: { box: THREE.Box3; sphere: THREE.Sphere } | null = null;
      const meshOf = (indices: Uint32Array, level: number): THREE.Mesh => {
        const g = new THREE.BufferGeometry();
        for (const [name, a] of Object.entries(attributes)) g.setAttribute(name, a);
        g.setIndex(new THREE.BufferAttribute(indices, 1));
        if (bounds === null) {
          g.computeBoundingBox();
          g.computeBoundingSphere();
          bounds = { box: g.boundingBox!, sphere: g.boundingSphere! };
        } else {
          g.boundingBox = bounds.box.clone();
          g.boundingSphere = bounds.sphere.clone();
        }
        geometries.push(g);
        const mesh = new THREE.Mesh(g, material);
        mesh.name = `architecture:${id}:${ck}:${m.material}:lod${level}`;
        // A chunk spans rooms: each face is lit by the room it looks into and drawn while that room is seen (room-culling.ts).
        mesh.userData[ROOM_TAG_KEY] = true;
        mesh.castShadow = cast;
        mesh.receiveShadow = receive;
        if (cast) mesh.userData[STATIC_CASTER_KEY] = true;
        return mesh;
      };
      /** A level: one mesh, or (in a layer's cut-away zones) the triangles in none and a mesh per set of zones. */
      const levelOf = (indices: Uint32Array, level: number): THREE.Object3D => {
        const split = layerCut === null ? null : splitByCutaway(l.positions, indices, layerCut.zones, layerCut.cellSize, cutOffset!);
        if (split === null) return meshOf(indices, level);
        const g = new THREE.Group();
        if (split.base.length > 0) g.add(meshOf(split.base, level));
        for (const c of split.cut) {
          const cm = meshOf(c.indices, level);
          g.add(cm);
          cutMeshes.push({ mesh: cm, zones: c.zones });
        }
        return g;
      };
      triangles += l.indices.length / 3;
      draws += 1;
      if (l.farIndices.length === l.indices.length) {
        group.add(levelOf(l.indices, 0));
        continue;
      }
      // The near level and, past the LOD distance from the chunk's middle, the far one (detail left out).
      const lod = new THREE.LOD();
      lod.name = `architecture:${id}:${ck}:${m.material}`;
      lod.position.copy(centre);
      const a = levelOf(l.indices, 0);
      a.position.copy(centre).negate();
      lod.addLevel(a, 0);
      const b = l.farIndices.length > 0 ? levelOf(l.farIndices, 1) : new THREE.Object3D();
      b.position.copy(centre).negate();
      lod.addLevel(b, lodDistance);
      group.add(lod);
    }
    const sets: BuiltInstanceSet[] = [];
    const undo: (() => void)[] = [];
    chunk.copies.forEach((s, i) => {
      const t = templates[i];
      if (t === null || t === undefined || s.transforms.length === 0) return;
      const built = buildInstanceSet(t, s.transforms, s.transforms.length / ARCHITECTURE_COPY_FLOATS, `architecture:${id}:${ck}:${s.model.assetId}`, { chunkSize: COPY_CHUNK_METRES, ...(this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {}) });
      for (const mesh of built.meshes) {
        mesh.castShadow = cast;
        mesh.receiveShadow = receive;
        if (cast) mesh.userData[STATIC_CASTER_KEY] = true;
      }
      const undress = this.deps.dress(built.group, s.model.assetId);
      if (undress !== null) undo.push(undress);
      group.add(built.group);
      sets.push(built);
      draws += built.meshes.length;
    });
    // The object's materials on the meshes (the first undo: a restyle replaces it).
    undo.unshift(this.deps.materials(group, id, rec.materials) ?? ((): void => undefined));
    group.updateMatrixWorld(true);
    if (ch.built !== null) this.dropBuilt(ch.built);
    const cut = cutMeshes.length > 0 ? { layer: rec.raw.layer!, key: `architecture:${id}:${ck}` } : null;
    if (cut !== null) this.deps.cutaway?.register(cut.layer, cut.key, cutMeshes);
    ch.built = { group, geometries, sets, undo, triangles, draws, cut };
    ch.builtKey = key;
    if (!rec.hidden) this.deps.place(group, true);
    this.deps.shapeChanged();
    this.deps.changed();
  }

  /** The plain surface a slot's meshes are made with (one per slot, shared: the object's material replaces it). */
  private surface(slot: string): THREE.MeshStandardMaterial {
    let m = this.surfaces.get(slot);
    if (m === undefined) {
      m = new THREE.MeshStandardMaterial({ color: 0x9a968c, roughness: 0.9, metalness: 0 });
      m.name = slot === '' ? ARCHITECTURE_MATERIAL_SLOT : slot;
      this.surfaces.set(slot, m);
    }
    return m;
  }

  private redress(id: string, b: BuiltChunk): void {
    b.undo[0]?.();
    b.undo[0] = this.deps.materials(b.group, id, this.recs.get(id)?.materials ?? {}) ?? ((): void => undefined);
  }

  private moveBuilt(rec: Rec, b: BuiltChunk): void {
    b.group.position.set(...rec.origin);
    b.group.updateMatrixWorld(true);
    this.deps.place(b.group, false);
    if (!rec.hidden) this.deps.place(b.group, true);
    this.deps.shapeChanged();
  }

  private dropBuilt(b: BuiltChunk): void {
    if (b.cut !== null) this.deps.cutaway?.drop(b.cut.layer, b.cut.key);
    this.deps.place(b.group, false);
    for (const u of b.undo) u();
    for (const s of b.sets) s.dispose();
    for (const g of b.geometries) g.dispose();
    this.deps.shapeChanged();
  }

  private fail(message: string): void {
    this.errors.push(message.slice(0, 200));
    if (this.errors.length > 16) this.errors.shift();
  }
}
