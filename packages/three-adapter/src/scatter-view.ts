/**
 * Rule scatter drawn — the stored copies of terrains' and block layers'
 * scatter rules (`project-model/scatter.ts`) as instance sets (ground cover,
 * made near the camera, is `cover-view.ts`'s).
 *
 * The block view and the terrain view hand each source over as they get it
 * (a block layer's chunks carry their scatter as text, a terrain's tiles
 * name a scatter blob, read here), so the editor's Scene view, Play and an
 * export draw the same copies from the same data.
 *
 * Copies are drawn per rule in groups of cells {@link SCATTER_GROUP_METRES}
 * wide: one instance set per rule and group, its chunks the rule's chunk
 * size, culled per copy inside each draw (view-cull), each copy at its own
 * level of detail by default. Large groups keep the draws few; a cell that
 * changes (an edit baked again) rebuilds only its group. A set's arithmetic
 * — every copy's matrix per mesh, the chunks, bounds and level inputs, tens
 * of milliseconds for a dense forest's group — is made on a worker
 * (`scatter-worker.ts`); the page only makes the draws from it, a few
 * chunks at a time within {@link SCATTER_BUILD_MS} a frame (a dense group
 * entering the streaming ring is hundreds of draws: more than one frame
 * spares), and the old set stays drawn until the new one is whole and
 * replaces it, so a re-bake or a streamed group never stalls a frame or
 * blinks.
 *
 * Copies a game's scripts hide or remove are shrunk to nothing in place (the
 * set keeps their slot: only that copy's matrices are written and uploaded);
 * a removed copy is left out when its group's set is next made for another
 * reason (a re-bake, the group streamed in again).
 */
import * as THREE from 'three';

import { SCATTER_BLOB_DISTANCE, SCATTER_CHUNK_METERS_DEFAULT, INSTANCE_FLOATS, decodeChunkScatter, instanceDensityOf, resolveStreamingRings, scatterCellBytes, scatterCellOfBlob, squareDistance, storedScatterRules, type BlockChunk, type BlockLayerComponent, type BlockType, type ScatterCell, type ScatterCopyChange, type ScatterRule, type StreamingRings, type StreamRing, type TerrainComponent } from '@thirdlight/runtime';

import type { MeshWorkerPort } from './block-mesh-pool';
import { COVER_FADE_START } from './cover-view';
import { beginInstanceSet, buildInstanceSet, instanceSetPlan, type BuiltInstanceSet, type InstanceSetBuilder, type InstanceSetOptions, type InstanceSetStats } from './instancing';
import { blobCopies, blobShadowTemplate, copiesBySquare, distanceToSquare, pickCopies, shadowOnly, SHADOW_RING_METRES } from './scatter-shadows';
import { answerScatterPrepare, type ScatterPrepareReply, type ScatterPrepareRequest } from './scatter-worker';
import type { ImpostorStore } from './impostor';
import type { CullView } from './view-cull';
import type { LodTuning } from './lod-switch';
import { STATIC_CASTER_KEY } from './shadow-casters';
import type { ModelInstance } from './visual';
import { askingRing, eyeMoved, recheckMetres, type PageWorldStream, type StreamCell } from './world-stream';
import { perfMark } from './perf-marks';

/** The width (m) of the squares a rule's copies are drawn together in: a few draws for a landscape, a bounded rebuild per edit. */
export const SCATTER_GROUP_METRES = 2048;
/** Main-thread time (ms) a frame may spend making sets' draws (at least one set a frame). */
export const SCATTER_BUILD_MS = 4;
/** Copies per instance chunk the count grid aims at where only the chunk size should split (the near shadows' squares). */
const SCATTER_COPIES_PER_CHUNK = 1 << 20;
/**
 * Most copies per chunk of a group's set: a chunk is made in one go (its
 * draws, their buffers, its level picks) and culled whole on its first frame,
 * so a dense group (tens of thousands of copies in one rule chunk) is split by
 * count into chunks the page makes a few at a time within
 * {@link SCATTER_BUILD_MS}. A sparse group stays one chunk (its draws few).
 */
export const SCATTER_SET_CHUNK_COPIES = 4096;

/** The page query that leaves the scatter out (`?scatter=off`: a diagnostic comparison). */
export const SCATTER_URL_PARAM = 'scatter';

/** Whether a page draws scatter (`?scatter=off|0|false`: no). */
export function scatterFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(SCATTER_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** What the view needs from its host. */
export interface ScatterViewDeps {
  /** A model instance to draw a rule's copies with (one per asset and piece, kept by the host); null while it loads (`onReady` then). */
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /** Dress a built set's meshes with the asset's materials; returns what takes them off again (before the set is dropped). */
  dress?(root: THREE.Object3D, assetId: string): (() => void) | null;
  /** A blob's bytes by digest (a terrain tile's scatter). */
  read: ((digest: string) => Promise<ArrayBuffer>) | null;
  /** A drawn group enters or leaves the scene (the render graph lists what it draws). */
  place(root: THREE.Object3D, shown: boolean): void;
  /** Copies that cast into the static shadow map appeared, moved or left. */
  shapeChanged?(): void;
  /** The project's LOD tuning (bias, hysteresis). */
  tuning?: LodTuning;
  /** Makes the worker sets are prepared on (null, or absent: on the page). */
  worker?: () => MeshWorkerPort | null;
  /** The models' impostors (a rule's `impostorSize`; absent: none, the copies keep their meshes). */
  impostors?: Pick<ImpostorStore, 'get' | 'update'>;
  /** Something was built (a frame should be drawn). */
  changed?(): void;
  /** World streaming (a game page): a streamed terrain's or layer's groups are drawn only within its scatter ring (absent: all). */
  stream?: PageWorldStream | null;
}

/** What the block and terrain views tell the scatter view (their sources as they get them), and the copies a game's scripts hid, showed or removed. */
export type ScatterSink = Pick<ScatterView, 'setBlockLayer' | 'replaceBlockChunks' | 'setTerrain' | 'setOrigin' | 'setHidden' | 'remove' | 'setCopyStates'> & {
  /** The block types (ground cover reads a block layer's tops by them). */
  setTypes?(types: readonly BlockType[]): void;
  /** The splines whose scatter bands terrain ground cover keeps clear of (the stored copies are baked clear of them). */
  setSplines?(splines: readonly import('./cover-worker').CoverSpline[]): void;
};

/** What the view holds (diagnostics). */
export interface ScatterViewDiagnostics {
  sources: number;
  cells: number;
  groups: number;
  sets: number;
  copies: number;
  /** Decoded copies' bytes. */
  bytes: number;
  /** Groups waiting to be built (their cells reading, their models loading, their sets being prepared or made). */
  pending: number;
  /** Sets being prepared (on the worker), and those prepared but not made yet (the frame's time spent). */
  preparing: number;
  prepared: number;
  /** Sets prepared so far, their mean and longest preparation (ms, on the worker), and whether a worker prepares them. */
  preparedSets: number;
  prepareMsMean: number;
  prepareMsMax: number;
  onWorker: boolean;
  /** The last frame's main-thread time making sets (ms) and the longest so far. */
  buildMs: number;
  buildMsMax: number;
  /** Copies scripts hid and removed (as the view follows them). */
  hidden: number;
  removed: number;
  instances: InstanceSetStats;
}

interface Cell {
  /** The stored form it was read from (a digest or the chunk's text); null: none. */
  ref: string | null;
  /** A streamed source's blob not read because its group is past the scatter ring (read when it comes near). */
  want: string | null;
  cell: ScatterCell | null;
  reading: string | null;
  group: string;
}

/** A rule's copies near the camera cast from shadow-only squares (its `shadowDistance`). */
interface NearShadows {
  readonly rule: ScatterRule;
  readonly floats: Float32Array;
  readonly count: number;
  /** The copies by square (made on the first frame that needs them). */
  index: Map<string, number[]> | null;
  readonly squares: Map<string, { root: THREE.Group; built: BuiltInstanceSet; undress: (() => void) | null }>;
}

interface RuleSet {
  readonly rule: string;
  readonly built: BuiltInstanceSet;
  readonly casts: boolean;
  readonly undress: (() => void) | null;
  /** The blob discs of the rule's set (the same copies, in the same order). */
  readonly blob: boolean;
  /** Each copy's candidate cell (ix, iz pairs, the set's order): finds a copy by its address. */
  readonly addrs: Int32Array;
}

/** One rule's set of a group being prepared: its generation, the copies' cells, and the answers (main set, blobs) as they arrive. */
interface Build {
  readonly gen: number;
  readonly rule: ScatterRule;
  readonly template: ModelInstance;
  /** The model's impostor quad its far copies draw (null: none, or not baked yet: made again once it is). */
  readonly impostor: THREE.Mesh | null;
  readonly count: number;
  readonly addrs: Int32Array;
  readonly jobs: number[];
  main: ScatterPrepareReply | null;
  blob: ScatterPrepareReply | null | 'none';
  /** Copies hidden, shown or removed after its copies were gathered: written into its sets once they are made. */
  readonly late: ScatterCopyChange[];
}

/** A prepared rule set of a group being made a few chunks a frame (its sets join the group once all are made). */
interface Making {
  readonly src: Source;
  readonly g: Group;
  readonly rule: string;
  readonly b: Build;
  /** The model's set, then the blobs' (null: none). */
  readonly main: InstanceSetBuilder;
  readonly blob: InstanceSetBuilder | null;
  /** The page's time spent making it so far (ms), the most in one frame, and the frames it took. */
  ms: number;
  frameMs: number;
  frames: number;
}

interface Group {
  readonly key: string;
  readonly root: THREE.Group;
  /** Rules whose sets are made again (once the group's cells are read and its models ready). */
  readonly dirty: Set<string>;
  /** Rules dropped from the source: their sets go at the next update. */
  stale: boolean;
  /** Per rule: the generation of its latest preparation, and the one under way. */
  readonly gens: Map<string, number>;
  readonly builds: Map<string, Build>;
  shown: boolean;
  sets: RuleSet[];
  near: NearShadows[];
}

interface Source {
  readonly id: string;
  rules: readonly ScatterRule[];
  rulesKey: string;
  origin: [number, number, number];
  hidden: boolean;
  readonly cells: Map<string, Cell>;
  readonly groups: Map<string, Group>;
  /** The world box of a cell key ("x,z"). */
  cellSize: number;
  /** Its scatter ring when it streams (null: every group drawn), and the groups it holds. */
  ring: StreamRing | null;
  readonly held: Set<string>;
  /** Where its groups were last streamed from (x, z; null: not yet), and whether its cells changed since. */
  streamAt: number[] | null;
  streamDirty: boolean;
  /** Its cells by group, kept until a cell comes or goes (null: to be gathered again). */
  groupCells: Map<string, Cell[]> | null;
}

const groupKeyOf = (src: Source, key: string): string => {
  const [x, z] = key.split(',').map(Number) as [number, number];
  const per = Math.max(1, Math.floor(SCATTER_GROUP_METRES / src.cellSize));
  return `${Math.floor(x / per)},${Math.floor(z / per)}`;
};

/** A streamed group's scatter before its blobs are read (a few hundred copies' worth). */
const SCATTER_BLOB_BYTES_GUESS = 64 * 1024;

/** Whether a cell's stored form is a block chunk's text rather than a blob digest (64 hex). */
const isChunkText = (ref: string): boolean => !/^[0-9a-f]{64}$/.test(ref);

/** A copy's state key within a source: its rule and candidate cell. */
const stateKey = (rule: string, ix: number, iz: number): string => `${rule}\u0000${ix},${iz}`;

export class ScatterView {
  private readonly sources = new Map<string, Source>();
  /** Copies a game's scripts hid or removed, per source (kept while a source comes and goes). */
  private readonly states = new Map<string, Map<string, 'hidden' | 'removed'>>();
  private port: MeshWorkerPort | null | undefined = undefined;
  private serial = 0;
  /** Jobs out → their group and build. */
  private readonly jobs = new Map<number, { src: Source; g: Group; rule: string; gen: number; kind: 'main' | 'blob' }>();
  /** Builds whose answers are all in, in arrival order. */
  private ready: { src: Source; g: Group; rule: string; gen: number }[] = [];
  /** The set being made a few chunks a frame (null: none). */
  private making: Making | null = null;
  private buildMs = 0;
  private buildMsMax = 0;
  private preparedSets = 0;
  private prepareMs = 0;
  private prepareMsMax = 0;
  private disposed = false;

  constructor(private readonly deps: ScatterViewDeps) {}

  /** A block layer's scatter: its rules and every chunk's stored copies. */
  setBlockLayer(id: string, component: BlockLayerComponent, origin: readonly number[], chunks: Iterable<BlockChunk>): void {
    const src = this.source(id, storedScatterRules(component.scatter), origin, 16 * component.cellSize[0]);
    if (src === null) return;
    this.ringOf(src, component.streaming);
    const seen = new Set<string>();
    for (const c of chunks) {
      const key = `${c.cx},${c.cz}`;
      seen.add(key);
      this.setText(src, key, c.scatter ?? null);
    }
    for (const key of [...src.cells.keys()]) if (!seen.has(key)) this.setText(src, key, null);
  }

  /** Some chunks of a block layer changed (an edit, the simulation): their stored copies. */
  replaceBlockChunks(id: string, chunks: readonly { cx: number; cz: number; chunk: BlockChunk | null }[]): void {
    const src = this.sources.get(id);
    if (src === undefined) return;
    for (const c of chunks) this.setText(src, `${c.cx},${c.cz}`, c.chunk?.scatter ?? null);
  }

  /** A terrain's scatter: its rules and every tile's scatter blob. */
  setTerrain(id: string, component: TerrainComponent, origin: readonly number[]): void {
    const src = this.source(id, storedScatterRules(component.scatter), origin, (component.tileSamples - 1) * component.spacing);
    if (src === null) return;
    this.ringOf(src, component.streaming);
    const seen = new Set<string>();
    for (const t of component.tiles) {
      const key = `${t.x},${t.z}`;
      seen.add(key);
      this.setDigest(src, key, t.scatter ?? null);
    }
    for (const key of [...src.cells.keys()]) if (!seen.has(key)) this.setDigest(src, key, null);
  }

  setOrigin(id: string, origin: readonly number[]): void {
    const src = this.sources.get(id);
    if (src === undefined) return;
    const at: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    if (at.every((v, i) => v === src.origin[i])) return;
    src.origin = at;
    for (const g of src.groups.values()) {
      this.show(g, false);
      g.root.position.set(...at);
      g.root.updateMatrixWorld(true);
      this.show(g, !src.hidden);
      // The near shadows' squares are where the copies stood: made again where they stand now.
      for (const n of g.near) {
        this.dropNear(n);
        n.index = null;
      }
    }
    if (this.casts(src)) this.deps.shapeChanged?.();
  }

  setHidden(id: string, hidden: boolean): void {
    const src = this.sources.get(id);
    if (src === undefined || src.hidden === hidden) return;
    src.hidden = hidden;
    for (const g of src.groups.values()) this.show(g, !hidden && g.sets.length > 0);
    if (this.casts(src)) this.deps.shapeChanged?.();
  }

  remove(id: string): void {
    const src = this.sources.get(id);
    if (src === undefined) return;
    for (const gk of src.held) this.deps.stream?.forget('scatter-group', `${src.id}/${gk}`);
    src.held.clear();
    this.deps.stream?.forgetObject(`scatter:${src.id}`);
    for (const g of src.groups.values()) this.dropGroup(g);
    if (this.casts(src)) this.deps.shapeChanged?.();
    this.sources.delete(id);
  }

  ids(): string[] {
    return [...this.sources.keys()];
  }

  /**
   * Copies a game's scripts hid, showed or removed: a hidden copy shrinks to
   * nothing in its set (shown: back at its place), a removed one (or one
   * back from removal, a new run) has its group's set made again.
   */
  setCopyStates(changes: readonly ScatterCopyChange[]): void {
    const now: ScatterCopyChange[] = [];
    for (const c of changes) {
      let states = this.states.get(c.entityId);
      if (states === undefined) this.states.set(c.entityId, (states = new Map()));
      const k = stateKey(c.rule, c.cell[0], c.cell[1]);
      const was = states.get(k) ?? 'shown';
      if (c.state === 'shown') states.delete(k);
      else states.set(k, c.state);
      const src = this.sources.get(c.entityId);
      if (src === undefined || was === c.state) continue;
      const cell = src.cells.get(c.key);
      if (cell === undefined) continue;
      const g = src.groups.get(cell.group);
      if (g === undefined) continue;
      // Back from removal (a new run): the drawn set left it out, so it is made again with it.
      if (was === 'removed') {
        this.markDirty(g, c.rule);
        continue;
      }
      // A set being prepared or made from copies gathered before this change: written into it once it is made.
      g.builds.get(c.rule)?.late.push(c);
      now.push(c);
    }
    if (this.writeStates(now)) this.deps.shapeChanged?.();
    if (changes.length > 0) this.deps.changed?.();
  }

  /**
   * Hidden, shown and removed copies written in place into the drawn sets
   * (a hidden or removed copy shrunk to nothing, a shown one back at its
   * place) and their near shadows' squares made again; returns whether a set
   * that casts into the static shadow map changed.
   */
  private writeStates(changes: readonly ScatterCopyChange[]): boolean {
    /** Per set, its copies to write again: index → transform. */
    const writes = new Map<RuleSet, { index: number; transform: number[] }[]>();
    for (const c of changes) {
      const src = this.sources.get(c.entityId);
      const cell = src?.cells.get(c.key);
      const g = cell !== undefined ? src!.groups.get(cell.group) : undefined;
      if (src === undefined || cell === undefined || g === undefined) continue;
      const original = this.copyOf(cell, c.rule, c.cell[0], c.cell[1]);
      if (original === null) continue;
      const gone = c.state !== 'shown';
      const rule = src.rules.find((r) => r.id === c.rule);
      for (const set of g.sets) {
        if (set.rule !== c.rule) continue;
        const index = indexOfAddress(set.addrs, c.cell[0], c.cell[1]);
        if (index < 0) continue;
        const t = Array.from(original);
        if (gone) t[7] = t[8] = t[9] = 0;
        else if (set.blob && rule?.blobShadow !== undefined) t.splice(0, INSTANCE_FLOATS, ...blobCopies(original, 1, rule.blobShadow));
        let w = writes.get(set);
        if (w === undefined) writes.set(set, (w = []));
        w.push({ index, transform: t });
      }
      // The near shadows' copies: written too, their squares made again.
      for (const n of g.near) {
        if (n.rule.id !== c.rule) continue;
        const set = g.sets.find((s) => s.rule === c.rule && !s.blob);
        const index = set === undefined ? -1 : indexOfAddress(set.addrs, c.cell[0], c.cell[1]);
        if (index < 0) continue;
        n.floats.set(original, index * INSTANCE_FLOATS);
        if (gone) n.floats[index * INSTANCE_FLOATS + 7] = n.floats[index * INSTANCE_FLOATS + 8] = n.floats[index * INSTANCE_FLOATS + 9] = 0;
        this.dropNear(n);
      }
    }
    let casts = false;
    for (const [set, list] of writes) {
      set.built.setCopies(list);
      casts ||= set.casts;
    }
    return casts;
  }

  /**
   * Prepare the sets of the groups that changed (on the worker), make those
   * prepared within the frame's time, and keep the near shadows around the
   * view's eye (the last frame's). Call once a frame. Returns whether
   * anything was built.
   */
  update(view: CullView | null = null): boolean {
    if (this.disposed) return false;
    const start = performance.now();
    // Streamed sources: the groups in their scatter ring are read and made, those past it go.
    if (view !== null && this.deps.stream != null) {
      for (const src of this.sources.values()) if (src.ring !== null) this.streamGroups(src, view.eye);
      this.deps.stream.spent(performance.now() - start);
    }
    // A model's impostor baked (one a frame, before the frame's draw: it draws with the page's renderer).
    let built = this.deps.impostors?.update() ?? false;
    let casts = false;
    for (const src of this.sources.values()) {
      for (const g of src.groups.values()) {
        if (g.stale) {
          // Sets of rules no longer listed go now.
          g.stale = false;
          const ids = new Set(src.rules.map((r) => r.id));
          if (g.sets.some((x) => !ids.has(x.rule)) || g.near.some((n) => !ids.has(n.rule.id))) {
            casts ||= this.replaceRule(src, g, (rule) => !ids.has(rule), null);
            built = true;
          }
          for (const r of [...g.builds.keys()]) if (!ids.has(r)) g.builds.delete(r);
        }
        if (g.dirty.size === 0 || (src.ring !== null && !src.held.has(g.key)) || !this.groupReady(src, g.key)) continue;
        const rules = [...g.dirty];
        g.dirty.clear();
        for (const id of rules) {
          const rule = src.rules.find((r) => r.id === id);
          if (rule !== undefined) this.prepare(src, g, rule);
        }
      }
    }
    // Make what is prepared, oldest first, a few chunks at a time within the frame's time (at least one chunk a frame).
    // A game page's streamed arrivals share their time with the block chunks' (world-stream.ts).
    const tm = performance.now();
    const until = Math.min(start + SCATTER_BUILD_MS, tm + (this.deps.stream?.arrivalLeft() ?? Number.POSITIVE_INFINITY));
    while (this.making !== null || this.ready.length > 0) {
      if (built && performance.now() > until) break;
      if (this.making === null) {
        const r = this.ready.shift()!;
        const done = this.begin(r.src, r.g, r.rule, r.gen);
        if (done === null) continue;
        casts ||= done;
        built = true;
        continue;
      }
      const m = this.making;
      const done = this.step(m, until, view);
      // Still under way: the frame's time is spent.
      if (this.making === m) break;
      if (done === null) continue;
      casts ||= done;
      built = true;
    }
    if (built) this.deps.stream?.arrived(performance.now() - tm);
    if (view !== null && view.camera !== null) {
      for (const src of this.sources.values()) for (const g of src.groups.values()) for (const n of g.near) built = this.nearShadows(src, n, view.eye[0]!, view.eye[2]!, start, built) || built;
    }
    this.buildMs = performance.now() - start;
    if (built) {
      this.buildMsMax = Math.max(this.buildMsMax, this.buildMs);
      if (casts) this.deps.shapeChanged?.();
      this.deps.changed?.();
    }
    // Answers still to come or to make: another frame.
    if (this.jobs.size > 0 || this.ready.length > 0 || this.making !== null) this.deps.changed?.();
    return built;
  }

  diagnostics(): ScatterViewDiagnostics {
    let cells = 0;
    let groups = 0;
    let sets = 0;
    let copies = 0;
    let bytes = 0;
    let pending = 0;
    const byLevel: number[] = [];
    let inView = 0;
    let culled = 0;
    let thinned = 0;
    for (const src of this.sources.values()) {
      for (const c of src.cells.values()) {
        if (c.cell !== null) cells += 1;
        bytes += scatterCellBytes(c.cell);
      }
      for (const g of src.groups.values()) {
        groups += 1;
        if (g.dirty.size > 0 || g.builds.size > 0) pending += 1;
        for (const s of g.sets) {
          sets += 1;
          const st = s.built.stats();
          copies += st.copies;
          inView += st.inView;
          culled += st.culled;
          thinned += st.thinned;
          st.byLevel.forEach((v, l) => (byLevel[l] = (byLevel[l] ?? 0) + v));
        }
      }
    }
    let hidden = 0;
    let removed = 0;
    for (const m of this.states.values()) for (const s of m.values()) if (s === 'hidden') hidden += 1;
    else removed += 1;
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    return {
      sources: this.sources.size,
      cells,
      groups,
      sets,
      copies,
      bytes,
      pending,
      preparing: this.jobs.size,
      prepared: this.ready.length + (this.making !== null ? 1 : 0),
      preparedSets: this.preparedSets,
      prepareMsMean: this.preparedSets > 0 ? r2(this.prepareMs / this.preparedSets) : 0,
      prepareMsMax: r2(this.prepareMsMax),
      onWorker: this.port !== null && this.port !== undefined,
      buildMs: r2(this.buildMs),
      buildMsMax: r2(this.buildMsMax),
      hidden,
      removed,
      instances: { copies, inView, byLevel, culled, thinned },
    };
  }

  /** The built sets' chunk meshes (picking, tests). */
  meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const src of this.sources.values()) for (const g of src.groups.values()) for (const s of g.sets) out.push(...s.built.meshes);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropMaking();
    for (const id of [...this.sources.keys()]) this.remove(id);
    this.port?.terminate();
    this.port = null;
  }

  // ---- internals ------------------------------------------------------------------------

  /** The source of `id`, made or updated (its rules changed: every group is built again). Null: it has no rules and none was drawn. */
  private source(id: string, rules: readonly ScatterRule[], origin: readonly number[], cellSize: number): Source | null {
    let src = this.sources.get(id);
    if (src === undefined && rules.length === 0) return null;
    if (src === undefined) {
      src = { id, rules, rulesKey: JSON.stringify(rules), origin: [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0], hidden: false, cells: new Map(), groups: new Map(), cellSize, ring: null, held: new Set(), streamAt: null, streamDirty: true, groupCells: null };
      this.sources.set(id, src);
      return src;
    }
    const key = JSON.stringify(rules);
    if (key !== src.rulesKey || cellSize !== src.cellSize) {
      src.rules = rules;
      src.rulesKey = key;
      src.cellSize = cellSize;
      for (const g of src.groups.values()) {
        g.stale = true;
        for (const r of rules) this.markDirty(g, r.id);
      }
    }
    this.setOrigin(id, origin);
    return src;
  }

  /** A source's scatter ring (a game page's streamed terrain or layer). */
  private ringOf(src: Source, streaming: StreamingRings | undefined): void {
    src.ring = this.deps.stream != null ? (resolveStreamingRings(streaming)?.scatter ?? null) : null;
    // Its cells may have changed (the caller sets them next).
    src.streamDirty = true;
  }

  /**
   * A streamed source's groups for the eye: those in its scatter ring (or
   * kept within its hysteresis) have their blobs read and their sets made;
   * the rest are let go (dropped at the resource manager's settle).
   */
  private streamGroups(src: Source, eye: ArrayLike<number>): void {
    if (!src.streamDirty && !eyeMoved(src.streamAt, eye, recheckMetres(src.ring!))) return;
    src.streamDirty = false;
    src.streamAt = [eye[0]!, eye[2]!];
    const stream = this.deps.stream!;
    const per = Math.max(1, Math.floor(SCATTER_GROUP_METRES / src.cellSize)) * src.cellSize;
    if (src.groupCells === null) {
      src.groupCells = new Map();
      for (const c of src.cells.values()) {
        let list = src.groupCells.get(c.group);
        if (list === undefined) src.groupCells.set(c.group, (list = []));
        list.push(c);
      }
    }
    const groups = src.groupCells;
    const bytesOf = (list: readonly Cell[]): number => list.reduce((n, c) => n + (c.cell !== null ? scatterCellBytes(c.cell) : c.want !== null ? SCATTER_BLOB_BYTES_GUESS : 0), 0);
    const cells: StreamCell[] = [];
    for (const [gk, list] of groups) {
      const [gx, gz] = gk.split(',').map(Number) as [number, number];
      const x0 = src.origin[0] + gx * per;
      const z0 = src.origin[2] + gz * per;
      cells.push({ key: `${src.id}/${gk}`, d: squareDistance(x0, z0, x0 + per, z0 + per, eye[0]!, eye[2]!), bytes: bytesOf(list), resident: src.held.has(gk) });
    }
    const hold = stream.residency('scatter-group', `scatter:${src.id}`, cells, askingRing(src.ring!));
    for (const [gk, list] of groups) {
      const k = `${src.id}/${gk}`;
      if (hold.has(k)) {
        if (!src.held.has(gk)) {
          src.held.add(gk);
          // Its blobs read now (they mark the group to be made as they arrive); a layer's chunks' copies are in already.
          for (const [key, c] of src.cells) if (c.group === gk && c.want !== null) this.setDigest(src, key, c.want);
          for (const c of list) if (c.cell !== null) this.touch(src, c);
        }
        if (!stream.holds('scatter-group', k)) stream.hold('scatter-group', k, bytesOf(list), () => this.evictGroup(src, gk));
      } else if (src.held.has(gk) && stream.holds('scatter-group', k)) stream.release('scatter-group', k);
    }
  }

  /** A streamed group let go: its sets go, and its blobs' copies (read again when it comes back). */
  private evictGroup(src: Source, gk: string): void {
    if (this.disposed || this.sources.get(src.id) !== src || !src.held.delete(gk)) return;
    src.streamDirty = true;
    const g = src.groups.get(gk);
    if (g !== undefined) {
      const casts = g.sets.some((x) => x.casts);
      this.dropGroup(g);
      src.groups.delete(gk);
      if (casts) this.deps.shapeChanged?.();
    }
    for (const c of src.cells.values()) {
      if (c.group !== gk || c.want !== null) continue;
      // A blob's copies go (a layer's chunk text stays: the layer holds it anyway).
      if (c.ref !== null && !isChunkText(c.ref)) {
        c.want = c.ref;
        c.ref = null;
        c.cell = null;
      } else if (c.reading !== null) {
        c.want = c.reading;
        c.reading = null;
      }
    }
    this.deps.changed?.();
  }

  private cellOf(src: Source, key: string): Cell {
    let c = src.cells.get(key);
    if (c === undefined) {
      c = { ref: null, want: null, cell: null, reading: null, group: groupKeyOf(src, key) };
      src.cells.set(key, c);
      src.groupCells = null;
      src.streamDirty = true;
    }
    return c;
  }

  private markDirty(g: Group, rule: string): void {
    g.dirty.add(rule);
    // An answer for the copies before this change is not wanted.
    g.builds.delete(rule);
  }

  private touch(src: Source, c: Cell): void {
    let g = src.groups.get(c.group);
    if (g === undefined) {
      const root = new THREE.Group();
      root.name = `scatter:${src.id}:${c.group}`;
      root.position.set(...src.origin);
      root.updateMatrixWorld(true);
      g = { key: c.group, root, dirty: new Set(), stale: false, gens: new Map(), builds: new Map(), shown: false, sets: [], near: [] };
      src.groups.set(c.group, g);
    }
    g.stale = true;
    for (const r of src.rules) this.markDirty(g, r.id);
  }

  private setText(src: Source, key: string, text: string | null): void {
    const c = this.cellOf(src, key);
    if (c.ref === text) return;
    c.ref = text;
    c.cell = text === null ? null : decodeChunkScatter(text);
    this.touch(src, c);
  }

  private setDigest(src: Source, key: string, digest: string | null): void {
    const c = this.cellOf(src, key);
    if (src.ring !== null && !src.held.has(c.group)) {
      // Past the scatter ring: only remembered (read when the camera comes near).
      c.want = digest;
      c.ref = null;
      c.cell = null;
      c.reading = null;
      return;
    }
    c.want = null;
    if (c.ref === digest && c.reading === null) return;
    if (digest === null) {
      c.ref = null;
      c.reading = null;
      c.cell = null;
      this.touch(src, c);
      return;
    }
    if (c.reading === digest || this.deps.read === null) return;
    c.reading = digest;
    this.touch(src, c);
    void this.deps.read(digest).then(
      (bytes) => {
        if (this.disposed || c.reading !== digest) return;
        c.reading = null;
        c.ref = digest;
        try {
          c.cell = scatterCellOfBlob(new Uint8Array(bytes));
        } catch (e) {
          console.warn(`scatter ${digest.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`);
          c.cell = null;
        }
        this.touch(src, c);
        this.deps.changed?.();
      },
      () => {
        if (c.reading === digest) c.reading = null;
      },
    );
  }

  /** Whether a group can be prepared: its cells read and every rule's model ready. */
  private groupReady(src: Source, group: string): boolean {
    for (const c of src.cells.values()) if (c.group === group && c.reading !== null) return false;
    for (const r of src.rules) if (this.deps.template(r.asset.assetId, r.asset.piece, () => this.modelReady(src)) === null) return false;
    return true;
  }

  /** A model a rule waited for is ready: the source's groups are built (again) with it. */
  private modelReady(src: Source): void {
    for (const g of src.groups.values()) for (const r of src.rules) this.markDirty(g, r.id);
    this.deps.changed?.();
  }

  private casts(src: Source): boolean {
    return src.rules.some((r) => r.castShadow === true);
  }

  /** A rule's set options (the copies' with their impostor, and the blobs'). */
  private options(rule: ScatterRule, blob: boolean, impostor: THREE.Mesh | null = null): InstanceSetOptions {
    const tuning = this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {};
    if (blob) return { chunkSize: rule.chunkSize ?? SCATTER_CHUNK_METERS_DEFAULT, copiesPerChunk: SCATTER_SET_CHUNK_COPIES, densityDistance: { start: SCATTER_BLOB_DISTANCE * COVER_FADE_START, end: SCATTER_BLOB_DISTANCE, min: 0 }, ...tuning };
    const far = impostor !== null && rule.impostorSize !== undefined ? { impostor: { mesh: impostor, size: rule.impostorSize } } : {};
    return { chunkSize: rule.chunkSize ?? SCATTER_CHUNK_METERS_DEFAULT, copiesPerChunk: SCATTER_SET_CHUNK_COPIES, density: instanceDensityOf(rule), lodPerCopy: rule.lodPerCopy ?? true, ...far, ...tuning };
  }

  /** Gather a rule's copies in a group (hidden ones shrunk to nothing, removed ones left out) and send them to be prepared. */
  private prepare(src: Source, g: Group, rule: ScatterRule): void {
    const template = this.deps.template(rule.asset.assetId, rule.asset.piece, () => this.modelReady(src));
    if (template === null) {
      g.dirty.add(rule.id);
      return;
    }
    const states = statesOfRule(this.states.get(src.id), rule.id);
    const cells = [...src.cells.values()].filter((c) => c.group === g.key && c.cell !== null);
    let n = 0;
    for (const c of cells) n += (c.cell!.get(rule.id)?.cells.length ?? 0) / 2;
    const floats = new Float32Array(n * INSTANCE_FLOATS);
    const addrs = new Int32Array(n * 2);
    let k = 0;
    for (const c of cells) {
      const copies = c.cell!.get(rule.id);
      if (copies === undefined) continue;
      for (let i = 0; i < copies.cells.length / 2; i++) {
        const ix = copies.cells[i * 2]!;
        const iz = copies.cells[i * 2 + 1]!;
        const state = states?.get(ix)?.get(iz);
        if (state === 'removed') continue;
        floats.set(copies.copies.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS), k * INSTANCE_FLOATS);
        if (state === 'hidden') floats[k * INSTANCE_FLOATS + 7] = floats[k * INSTANCE_FLOATS + 8] = floats[k * INSTANCE_FLOATS + 9] = 0;
        addrs[k * 2] = ix;
        addrs[k * 2 + 1] = iz;
        k += 1;
      }
    }
    const gen = (g.gens.get(rule.id) ?? 0) + 1;
    g.gens.set(rule.id, gen);
    // Until the model's impostor is baked its far copies draw its meshes; the group is made again once it is.
    const impostor = rule.impostorSize !== undefined ? (this.deps.impostors?.get(rule.asset.assetId, rule.asset.piece, () => this.modelReady(src)) ?? null) : null;
    const b: Build = { gen, rule, template, impostor, count: k, addrs: addrs.subarray(0, k * 2), jobs: [], main: null, blob: rule.blobShadow !== undefined && k > 0 ? null : 'none', late: [] };
    g.builds.set(rule.id, b);
    if (k === 0) {
      // Nothing left: the old sets go when this "build" is made.
      this.ready.push({ src, g, rule: rule.id, gen });
      return;
    }
    const used = floats.subarray(0, k * INSTANCE_FLOATS);
    const blobs = rule.blobShadow !== undefined ? blobCopies(used, k, rule.blobShadow) : null;
    this.send(src, g, rule.id, gen, 'main', template, used.slice(), k, this.options(rule, false, impostor));
    if (blobs !== null) this.send(src, g, rule.id, gen, 'blob', blobShadowTemplate(), blobs, k, this.options(rule, true));
  }

  /** A set's copies to its preparer: the worker's, else the page's own (answered at once). */
  private send(src: Source, g: Group, rule: string, gen: number, kind: 'main' | 'blob', template: ModelInstance, floats: Float32Array, count: number, options: InstanceSetOptions): void {
    const plan = instanceSetPlan(template, options);
    const job = ++this.serial;
    this.jobs.set(job, { src, g, rule, gen, kind });
    g.builds.get(rule)?.jobs.push(job);
    const req: ScatterPrepareRequest = { t: 'scatterPrepare', job, floats, count, parts: plan.prepareParts, options: plan.prepareOptions };
    const port = this.workerPort();
    if (port !== null) {
      port.post(req, [floats.buffer as ArrayBuffer]);
      return;
    }
    this.received(answerScatterPrepare(req));
  }

  private workerPort(): MeshWorkerPort | null {
    if (this.port === undefined) {
      this.port = this.deps.worker?.() ?? null;
      if (this.port !== null) {
        this.port.listen((raw) => {
          const r = raw as Partial<ScatterPrepareReply> | null;
          if (r?.t === 'scatterPrepared') this.received(r as ScatterPrepareReply);
        });
        this.port.onError((message) => {
          console.warn(`scatter worker: ${message}; sets are prepared on the page instead`);
          this.port?.terminate();
          this.port = null;
          // The answers it owed will not come: prepared again on the page.
          for (const j of this.jobs.values()) this.markDirty(j.g, j.rule);
          this.jobs.clear();
          this.deps.changed?.();
        });
      }
    }
    return this.port;
  }

  private received(r: ScatterPrepareReply): void {
    const j = this.jobs.get(r.job);
    if (j === undefined) return;
    this.jobs.delete(r.job);
    const b = j.g.builds.get(j.rule);
    if (this.disposed || b === undefined || b.gen !== j.gen || this.sources.get(j.src.id) !== j.src) return;
    if (!r.ok) {
      console.warn(`scatter ${j.src.id} ${j.rule}: ${r.message}`);
      j.g.builds.delete(j.rule);
      return;
    }
    this.preparedSets += 1;
    this.prepareMs += r.ms;
    this.prepareMsMax = Math.max(this.prepareMsMax, r.ms);
    if (j.kind === 'main') b.main = r;
    else b.blob = r;
    if (b.main !== null && b.blob !== null) this.ready.push({ src: j.src, g: j.g, rule: j.rule, gen: j.gen });
    this.deps.changed?.();
  }

  /**
   * Start making a prepared rule set's draws (a set with no copies left puts
   * nothing in place of the old ones at once); returns whether what casts into
   * the static shadow map changed (null: the answer was not wanted any more,
   * or nothing was put in place yet).
   */
  private begin(src: Source, g: Group, rule: string, gen: number): boolean | null {
    const b = g.builds.get(rule);
    if (b === undefined || b.gen !== gen || this.sources.get(src.id) !== src || src.groups.get(g.key) !== g) return null;
    // The model changed while it was prepared (reloaded): prepared again.
    if (b.count > 0 && this.deps.template(b.rule.asset.assetId, b.rule.asset.piece, () => this.modelReady(src)) !== b.template) {
      this.markDirty(g, rule);
      return null;
    }
    if (b.count === 0 || b.main === null || !b.main.ok) {
      g.builds.delete(rule);
      return this.replaceRule(src, g, (r) => r === rule, null);
    }
    const main = b.main;
    const blob = b.blob !== null && b.blob !== 'none' && b.blob.ok ? b.blob : null;
    const t0 = performance.now();
    this.making = {
      src,
      g,
      rule,
      b,
      main: beginInstanceSet(b.template, main.floats, b.count, `scatter:${src.id}:${rule}`, { ...this.options(b.rule, false, b.impostor), prepared: main.prepared }),
      blob: blob !== null ? beginInstanceSet(blobShadowTemplate(), blob.floats, b.count, `scatter-blob:${src.id}:${rule}`, { ...this.options(b.rule, true), prepared: blob.prepared }) : null,
      ms: performance.now() - t0,
      frameMs: 0,
      frames: 0,
    };
    return null;
  }

  /** Make the set under way until `until`; once whole, it replaces the rule's old sets (see {@link begin} for what it returns). */
  private step(m: Making, until: number, view: CullView | null): boolean | null {
    const { src, g, rule, b } = m;
    // Superseded (copies changed again, the group let go, the source gone): what was made goes.
    if (g.builds.get(rule) !== b || this.sources.get(src.id) !== src || src.groups.get(g.key) !== g) {
      this.dropMaking();
      return null;
    }
    const t0 = performance.now();
    m.frames += 1;
    let done = m.main.step(until);
    if (done && m.blob !== null) done = performance.now() < until && m.blob.step(until);
    // Culled for the view before it is shown: its first frame would work out every copy's sphere and level at once.
    if (done && view !== null && view.camera !== null) {
      done = performance.now() < until && m.main.prime(view, g.root.matrixWorld, until);
      if (done && m.blob !== null) done = performance.now() < until && m.blob.prime(view, g.root.matrixWorld, until);
    }
    const spent = performance.now() - t0;
    m.ms += spent;
    if (!done) {
      m.frameMs = Math.max(m.frameMs, spent);
      return null;
    }
    this.making = null;
    g.builds.delete(rule);
    const t1 = performance.now();
    let casts = this.replaceRule(src, g, (r) => r === rule, { b, main: m.main.set, blob: m.blob?.set ?? null });
    // Copies hidden, shown or removed since its copies were gathered.
    casts = this.writeStates(b.late) || casts;
    const swapMs = performance.now() - t1;
    m.ms += swapMs;
    m.frameMs = Math.max(m.frameMs, spent + swapMs);
    // What a set cost (the page's share over its frames, and the worker's), for measurements.
    const prepareMs = b.main?.ok === true ? b.main.ms : 0;
    perfMark('tl:scatter:made', { ms: Math.round(m.ms * 100) / 100, frameMs: Math.round(m.frameMs * 100) / 100, frames: m.frames, swapMs: Math.round(swapMs * 100) / 100, prepareMs: Math.round(prepareMs * 100) / 100, copies: b.count });
    return casts;
  }

  /** The set under way is not wanted: what was made of it goes (it was never shown). */
  private dropMaking(): void {
    const m = this.making;
    if (m === null) return;
    this.making = null;
    m.main.set.dispose();
    m.blob?.set.dispose();
  }

  /** Drop the sets of the rules `goes` names and put the made sets in (null: none); returns whether what casts into the static shadow map changed. */
  private replaceRule(src: Source, g: Group, goes: (rule: string) => boolean, made: { b: Build; main: BuiltInstanceSet; blob: BuiltInstanceSet | null } | null): boolean {
    const castBefore = g.sets.some((x) => goes(x.rule) && x.casts);
    this.show(g, false);
    for (const x of g.sets) if (goes(x.rule)) this.dropSet(x);
    g.sets = g.sets.filter((x) => !goes(x.rule));
    for (const n of g.near) if (goes(n.rule.id)) this.dropNear(n);
    g.near = g.near.filter((n) => !goes(n.rule.id));
    let castAfter = false;
    if (made !== null) castAfter = this.addSets(g, made.b, made.main, made.blob);
    g.root.updateMatrixWorld(true);
    this.show(g, !src.hidden && g.sets.length > 0);
    return castBefore || castAfter;
  }

  /** A made rule's sets (the model's, and the blobs') into their group; returns whether they cast into the static shadow map. */
  private addSets(g: Group, b: Build, built: BuiltInstanceSet, blobs: BuiltInstanceSet | null): boolean {
    const rule = b.rule;
    const main = b.main as Extract<ScatterPrepareReply, { ok: true }>;
    // A rule that casts near the camera only: its copies there cast from shadow-only squares, the rest never.
    const casts = rule.castShadow === true && rule.shadowDistance === undefined;
    if (rule.castShadow === true && rule.shadowDistance !== undefined) g.near.push({ rule, floats: main.floats, count: b.count, index: null, squares: new Map() });
    for (const m of built.meshes) {
      m.castShadow = casts;
      m.receiveShadow = true;
      if (casts) m.userData[STATIC_CASTER_KEY] = true;
    }
    const undress = this.deps.dress?.(built.group, rule.asset.assetId) ?? null;
    g.root.add(built.group);
    g.sets.push({ rule: rule.id, built, casts, undress, blob: false, addrs: b.addrs });
    if (blobs !== null) {
      // A disc under each copy near the camera, thinning out by distance; it neither casts nor takes shadows.
      for (const m of blobs.meshes) {
        m.castShadow = false;
        m.receiveShadow = false;
      }
      g.root.add(blobs.group);
      g.sets.push({ rule: rule.id, built: blobs, casts: false, undress: null, blob: true, addrs: b.addrs });
    }
    return casts;
  }

  /** A copy's stored transform in a cell (by its rule and candidate cell), or null. */
  private copyOf(c: Cell, rule: string, ix: number, iz: number): Float32Array | null {
    const copies = c.cell?.get(rule);
    if (copies === undefined) return null;
    const i = indexOfAddress(copies.cells, ix, iz);
    return i < 0 ? null : copies.copies.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS);
  }

  private show(g: Group, on: boolean): void {
    if (g.shown === on) return;
    g.shown = on;
    this.deps.place(g.root, on);
  }

  private dropGroup(g: Group): void {
    this.show(g, false);
    for (const s of g.sets) this.dropSet(s);
    g.sets = [];
    for (const n of g.near) this.dropNear(n);
    g.near = [];
    g.builds.clear();
    g.dirty.clear();
  }

  /** Keep a rule's near-shadow squares around the eye: drop the far ones, build the near ones (within the frame's time). */
  private nearShadows(src: Source, n: NearShadows, ex: number, ez: number, start: number, builtAlready: boolean): boolean {
    const d = n.rule.shadowDistance!;
    let built = false;
    for (const [key, sq] of [...n.squares]) {
      if (!src.hidden && distanceToSquare(ex, ez, key) <= d + SHADOW_RING_METRES / 2) continue;
      this.deps.place(sq.root, false);
      sq.built.dispose();
      sq.undress?.();
      n.squares.delete(key);
    }
    if (src.hidden) return false;
    n.index ??= copiesBySquare(n.floats, n.count, src.origin);
    // Only the squares within the distance are looked up (a group holds thousands; the eye is near a few).
    const S = SHADOW_RING_METRES;
    const near: { key: string; indices: number[] }[] = [];
    for (let iz = Math.floor((ez - d) / S); iz <= Math.floor((ez + d) / S); iz++) {
      for (let ix = Math.floor((ex - d) / S); ix <= Math.floor((ex + d) / S); ix++) {
        const key = `${ix},${iz}`;
        const indices = n.index.get(key);
        if (indices !== undefined && !n.squares.has(key) && distanceToSquare(ex, ez, key) <= d) near.push({ key, indices });
      }
    }
    for (const { key, indices } of near) {
      if ((builtAlready || built) && performance.now() - start > SCATTER_BUILD_MS) break;
      const template = this.deps.template(n.rule.asset.assetId, n.rule.asset.piece, () => this.modelReady(src));
      if (template === null) break;
      const set = buildInstanceSet(template, pickCopies(n.floats, indices), indices.length, `scatter-shadow:${src.id}:${n.rule.id}`, { chunkSize: SHADOW_RING_METRES, copiesPerChunk: SCATTER_COPIES_PER_CHUNK, ...(this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {}) });
      shadowOnly(set.meshes);
      const undress = this.deps.dress?.(set.group, n.rule.asset.assetId) ?? null;
      const root = new THREE.Group();
      root.name = `scatter-shadow:${src.id}:${key}`;
      root.position.set(...src.origin);
      root.add(set.group);
      root.updateMatrixWorld(true);
      this.deps.place(root, true);
      n.squares.set(key, { root, built: set, undress });
      built = true;
    }
    return built;
  }

  private dropNear(n: NearShadows): void {
    for (const sq of n.squares.values()) {
      this.deps.place(sq.root, false);
      sq.built.dispose();
      sq.undress?.();
    }
    n.squares.clear();
  }

  /** A set's chunks go before its materials may (a material released with its last user takes the chunks' render objects). */
  private dropSet(s: RuleSet): void {
    s.built.dispose();
    s.undress?.();
  }
}

/**
 * A rule's hidden and removed copies by candidate cell (ix, then iz), from a
 * source's states (null: none): a dense group's tens of thousands of copies
 * are looked up by number, not by a key string each.
 */
function statesOfRule(states: ReadonlyMap<string, 'hidden' | 'removed'> | undefined, rule: string): Map<number, Map<number, 'hidden' | 'removed'>> | null {
  if (states === undefined || states.size === 0) return null;
  const prefix = stateKey(rule, 0, 0).slice(0, rule.length + 1);
  let out: Map<number, Map<number, 'hidden' | 'removed'>> | null = null;
  for (const [k, st] of states) {
    if (!k.startsWith(prefix)) continue;
    const comma = k.indexOf(',', prefix.length);
    const ix = Number(k.slice(prefix.length, comma));
    const iz = Number(k.slice(comma + 1));
    out ??= new Map();
    let row = out.get(ix);
    if (row === undefined) out.set(ix, (row = new Map()));
    row.set(iz, st);
  }
  return out;
}

/** The index of candidate cell (ix, iz) in a list of cell pairs (-1: not there). */
function indexOfAddress(cells: Int32Array, ix: number, iz: number): number {
  for (let i = 0; i < cells.length; i += 2) if (cells[i] === ix && cells[i + 1] === iz) return i / 2;
  return -1;
}
