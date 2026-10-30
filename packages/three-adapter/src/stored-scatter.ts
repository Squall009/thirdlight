/**
 * Rule scatter's stored copies drawn — the baked copies of terrains' and
 * block layers' scatter rules (`project-model/scatter.ts`: trees, rocks)
 * through the GPU renderer ground cover and the instance brush draw with
 * (`copies-gpu.ts`; ground cover, made near the camera, is `cover-view.ts`'s).
 *
 * The block view and the terrain view hand each source over as they get it
 * (a block layer's chunks carry their scatter as text, a terrain's tiles
 * name a scatter blob, read here), so the editor's Scene view, Play and an
 * export draw the same copies from the same data.
 *
 * Copies are drawn per rule in groups of cells {@link SCATTER_GROUP_METRES}
 * wide: one copies set per rule and group, each copy at its own level of
 * detail and thinned by distance on the GPU, blocks of copies culled on the
 * page. A cell that changes (an edit baked again) rebuilds only its group. A
 * set's arithmetic (its copies put in compact blocks) is made on a worker
 * (`scatter-worker.ts`); the page makes the set's textures and draws from it
 * and puts it in place of the old one, which stays drawn until then, so a
 * re-bake or a streamed group never blinks.
 *
 * Copies a game's scripts hide or remove are shrunk to nothing in place (the
 * set keeps their slot: only that copy's texels are written); a removed copy
 * is left out when its group's set is next made for another reason (a
 * re-bake, the group streamed in again).
 */
import * as THREE from 'three';

import { type ScatterCopyChange } from '@thirdlight/runtime';
import { SCATTER_BLOB_DISTANCE, SCATTER_CHUNK_METERS_DEFAULT, INSTANCE_FLOATS, decodeChunkScatter, instanceDensityOf, resolveStreamingRings, scatterCellBytes, scatterCellOfBlob, squareDistance, storedScatterRules, type BlockChunk, type BlockLayerComponent, type BlockType, type ScatterCell, type ScatterRule, type StreamingRings, type StreamRing, type TerrainComponent } from '@thirdlight/project-model';

import type { MeshWorkerPort } from './block-mesh-pool';
import { COVER_FADE_START } from './cover-placement';
import { buildGpuCopySet, type GpuCopySetHandle, type GpuCopySetOptions } from './copies-gpu';
import type { CopyChunking } from './copies-prepare';
import type { InstanceSetStats } from './instancing';
import { blobCopies, blobShadowTemplate } from './scatter-shadows';
import { answerScatterPrepare, type ScatterPrepareReply, type ScatterPrepareRequest } from './scatter-worker';
import type { ImpostorStore } from './impostor';
import type { CullView } from './view-cull';
import type { LodTuning } from './lod-switch';
import { STATIC_CASTER_KEY } from './shadow-casters';
import type { ModelInstance } from './visual';
import type { WarmDraw } from './program-warmer';
import { askingRing, eyeMoved, recheckMetres, type PageWorldStream, type StreamCell } from './world-stream';
import { perfMark } from './perf-marks';
import { VIEW_OWNER_KEY } from './isolation-view';
import { SEE_THROUGH_KEY } from './see-through';

/** The width (m) of the squares a rule's copies are drawn together in: a few draws for a landscape, a bounded rebuild per edit. */
export const SCATTER_GROUP_METRES = 2048;
/** Main-thread time (ms) a frame may spend making sets (at least one set a frame). */
export const SCATTER_BUILD_MS = 4;

/** The page query that leaves the scatter out (`?scatter=off`: a diagnostic comparison). */
export const SCATTER_URL_PARAM = 'scatter';


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
  /** Build a made set's programs ahead of their first draw, its levels no copy draws at yet too (absent: built when first drawn). */
  warm?(d: WarmDraw): void;
}

/** What the block and terrain views tell the scatter view (their sources as they get them), and the copies a game's scripts hid, showed or removed. */
export type ScatterSink = Pick<StoredScatter, 'setBlockLayer' | 'replaceBlockChunks' | 'setTerrain' | 'setOrigin' | 'setHidden' | 'remove' | 'setCopyStates'> & {
  /** The block types (ground cover reads a block layer's tops by them). */
  setTypes?(types: readonly BlockType[]): void;
  /** The splines whose scatter bands terrain ground cover keeps clear of (the stored copies are baked clear of them). */
  setSplines?(splines: readonly import('./cover-worker').CoverSpline[]): void;
};

/** What the view holds (diagnostics). */
export interface StoredScatterDiagnostics {
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

interface RuleSet {
  readonly rule: string;
  readonly built: GpuCopySetHandle;
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

export class StoredScatter {
  private readonly sources = new Map<string, Source>();
  /** Copies a game's scripts hid or removed, per source (kept while a source comes and goes). */
  private readonly states = new Map<string, Map<string, 'hidden' | 'removed'>>();
  private port: MeshWorkerPort | null | undefined = undefined;
  private serial = 0;
  /** Jobs out → their group and build. */
  private readonly jobs = new Map<number, { src: Source; g: Group; rule: string; gen: number; kind: 'main' | 'blob' }>();
  /** Builds whose answers are all in, in arrival order. */
  private ready: { src: Source; g: Group; rule: string; gen: number }[] = [];
  private buildMs = 0;
  private buildMsMax = 0;
  private preparedSets = 0;
  private prepareMs = 0;
  private prepareMsMax = 0;
  private disposed = false;

  /** The copies draws' programs built so far, by what three keys them by (program-warmer.ts). */
  private readonly programsBuilt = new Set<string>();

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
   * place); returns whether a set
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
    }
    let casts = false;
    for (const [set, list] of writes) {
      set.built.setCopies(list);
      casts ||= set.casts;
    }
    return casts;
  }

  /**
   * Prepare the sets of the groups that changed (on the worker) and make
   * those prepared within the frame's time. Call once a frame. Returns
   * whether anything was built.
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
          if (g.sets.some((x) => !ids.has(x.rule))) {
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
    // Make what is prepared, oldest first, within the frame's time (at least one set a frame).
    // A game page's streamed arrivals share their time with the block chunks' (world-stream.ts).
    const tm = performance.now();
    const until = Math.min(start + SCATTER_BUILD_MS, tm + (this.deps.stream?.arrivalLeft() ?? Number.POSITIVE_INFINITY));
    while (this.ready.length > 0) {
      if (built && performance.now() > until) break;
      const r = this.ready.shift()!;
      const done = this.make(r.src, r.g, r.rule, r.gen);
      if (done === null) continue;
      casts ||= done;
      built = true;
    }
    if (built) this.deps.stream?.arrived(performance.now() - tm);
    this.buildMs = performance.now() - start;
    if (built) {
      this.buildMsMax = Math.max(this.buildMsMax, this.buildMs);
      if (casts) this.deps.shapeChanged?.();
      this.deps.changed?.();
    }
    // Answers still to come or to make: another frame.
    if (this.jobs.size > 0 || this.ready.length > 0) this.deps.changed?.();
    return built;
  }

  diagnostics(): StoredScatterDiagnostics {
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
      prepared: this.ready.length,
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
    for (const src of this.sources.values()) for (const g of src.groups.values()) for (const s of g.sets) out.push(...s.built.drawMeshes);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
      root.userData[VIEW_OWNER_KEY] = src.id;
      root.position.set(...src.origin);
      root.updateMatrixWorld(true);
      g = { key: c.group, root, dirty: new Set(), stale: false, gens: new Map(), builds: new Map(), shown: false, sets: [] };
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

  /** A rule's set options (the copies' with their impostor and near shadows, and the blobs'). */
  private options(rule: ScatterRule, blob: boolean, impostor: THREE.Mesh | null = null): GpuCopySetOptions {
    const tuning = this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {};
    if (blob) return { densityDistance: { start: SCATTER_BLOB_DISTANCE * COVER_FADE_START, end: SCATTER_BLOB_DISTANCE, min: 0 }, ...tuning };
    const far = impostor !== null && rule.impostorSize !== undefined ? { impostor: { mesh: impostor, size: rule.impostorSize } } : {};
    // A rule that casts near the camera only: its copies there cast into the moving shadow map, the rest never.
    const near = rule.castShadow === true && rule.shadowDistance !== undefined ? { shadowDistance: rule.shadowDistance } : {};
    const bend = rule.bendAway !== undefined ? { bendAway: rule.bendAway } : {};
    return { density: instanceDensityOf(rule), lodPerCopy: rule.lodPerCopy ?? true, ...far, ...near, ...bend, ...tuning };
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
    // Culled in pieces of the rule's chunk size (by place only: a dense group's blocks keep its draws whole).
    const chunking = { chunkSize: rule.chunkSize ?? SCATTER_CHUNK_METERS_DEFAULT, copiesPerChunk: Number.MAX_SAFE_INTEGER };
    this.send(src, g, rule.id, gen, 'main', used.slice(), k, chunking);
    if (blobs !== null) this.send(src, g, rule.id, gen, 'blob', blobs, k, chunking);
  }

  /** A set's copies to its preparer: the worker's, else the page's own (answered at once). */
  private send(src: Source, g: Group, rule: string, gen: number, kind: 'main' | 'blob', floats: Float32Array, count: number, chunking: CopyChunking): void {
    const job = ++this.serial;
    this.jobs.set(job, { src, g, rule, gen, kind });
    g.builds.get(rule)?.jobs.push(job);
    const req: ScatterPrepareRequest = { t: 'scatterPrepare', job, floats, count, chunking };
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
   * Make a prepared rule set's draws and put them in place of its old ones (a
   * set with no copies left puts nothing in their place); returns whether
   * what casts into the static shadow map changed (null: the answer was not
   * wanted any more).
   */
  private make(src: Source, g: Group, rule: string, gen: number): boolean | null {
    const b = g.builds.get(rule);
    if (b === undefined || b.gen !== gen || this.sources.get(src.id) !== src || src.groups.get(g.key) !== g) return null;
    // The model changed while it was prepared (reloaded): prepared again.
    if (b.count > 0 && this.deps.template(b.rule.asset.assetId, b.rule.asset.piece, () => this.modelReady(src)) !== b.template) {
      this.markDirty(g, rule);
      return null;
    }
    g.builds.delete(rule);
    if (b.count === 0 || b.main === null || !b.main.ok) return this.replaceRule(src, g, (r) => r === rule, null);
    const t0 = performance.now();
    const blob = b.blob !== null && b.blob !== 'none' && b.blob.ok ? b.blob : null;
    const main = buildGpuCopySet(b.template, b.main.floats, b.count, `scatter:${src.id}:${rule}`, { ...this.options(b.rule, false, b.impostor), preparedCopies: b.main.prepared });
    const blobs = blob !== null ? buildGpuCopySet(blobShadowTemplate(), blob.floats, b.count, `scatter-blob:${src.id}:${rule}`, { ...this.options(b.rule, true), preparedCopies: blob.prepared }) : null;
    let casts = this.replaceRule(src, g, (r) => r === rule, { b, main, blob: blobs });
    if (this.deps.warm !== undefined) for (const s of [main, blobs]) if (s !== null) this.deps.warm(s.warmDraw(this.programsBuilt));
    // Copies hidden, shown or removed since its copies were gathered.
    casts = this.writeStates(b.late) || casts;
    // What a set cost (the page's share, and the worker's), for measurements.
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    perfMark('tl:scatter:made', { ms, frameMs: ms, frames: 1, swapMs: ms, prepareMs: Math.round(b.main.ms * 100) / 100, copies: b.count });
    return casts;
  }

  /** Drop the sets of the rules `goes` names and put the made sets in (null: none); returns whether what casts into the static shadow map changed. */
  private replaceRule(src: Source, g: Group, goes: (rule: string) => boolean, made: { b: Build; main: GpuCopySetHandle; blob: GpuCopySetHandle | null } | null): boolean {
    const castBefore = g.sets.some((x) => goes(x.rule) && x.casts);
    this.show(g, false);
    for (const x of g.sets) if (goes(x.rule)) this.dropSet(x);
    g.sets = g.sets.filter((x) => !goes(x.rule));
    let castAfter = false;
    if (made !== null) castAfter = this.addSets(g, made.b, made.main, made.blob);
    g.root.updateMatrixWorld(true);
    this.show(g, !src.hidden && g.sets.length > 0);
    return castBefore || castAfter;
  }

  /** A made rule's sets (the model's, and the blobs') into their group; returns whether they cast into the static shadow map. */
  private addSets(g: Group, b: Build, built: GpuCopySetHandle, blobs: GpuCopySetHandle | null): boolean {
    const rule = b.rule;
    // A rule that casts near the camera only casts from its near-shadow draws (the set's own), the rest never.
    const casts = rule.castShadow === true && rule.shadowDistance === undefined;
    for (const m of built.drawMeshes) {
      m.castShadow = casts;
      m.receiveShadow = true;
      if (casts) m.userData[STATIC_CASTER_KEY] = true;
      // A rule's copies fade round see-through subjects unless it opts out (see-through.ts).
      if ((rule as { seeThrough?: unknown }).seeThrough === false) m.userData[SEE_THROUGH_KEY] = false;
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
    g.builds.clear();
    g.dirty.clear();
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
