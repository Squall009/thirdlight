/**
 * The derive side of the voxel streamer: what is built from the resident
 * voxels (meshes, collision, navigation, light, shader data) is built per
 * **section**, a cube of 8, 16 or 32 cells inside a 32³ storage chunk, so
 * an edit re-derives only the sections within the rules' reach of the
 * cells it changed, not the whole chunks around them.
 *
 * - **Jobs.** Wanted sections are sent per chunk: the chunk's payload and
 *   its apron (R deep, as for a whole-chunk derive) with the section ids;
 *   the worker fills the chunk's neighbourhood once and derives each
 *   section from it. An edit touching fewer chunks than there are workers
 *   splits each chunk's sections over the pool; otherwise, and for loads,
 *   one job a chunk.
 * - **Staleness.** Every section has its own input stamp, moved by any
 *   change within R of it (an edit, a neighbour landing, a refreshed
 *   chunk). A result is kept only while the stamps of its sections are the
 *   ones its job was sent with, so a change elsewhere in the same chunk
 *   does not throw away a result it cannot have changed.
 * - **Atomic swaps.** Every section one edit makes stale joins the edit's
 *   group. Results for a group are held, and the old results (and so the
 *   meshes and colliders drawn from them) stay until every section of the
 *   group has its new one and every chunk a refresh is reading again has
 *   landed; then all are swapped in one go and a `swap` event reports the
 *   group. An edit that meets a group still open (a second blast before
 *   the first is shown) merges into it: no frame shows half an edit. The
 *   voxels themselves change at once: reads see an edit as soon as it is
 *   applied. The coarser levels' drawn nodes an edit changes swap with it
 *   too (stream-mips.ts), and the seams between levels that read the
 *   group's chunks or those nodes are rebuilt from the held results before
 *   it swaps, and go in with it (stream-seams.ts).
 */
import { apronBytes, apronTransfer, buildApron, dependentChunks, type Apron } from './apron';
import { rulesRef, type AssemblyRuleSet } from './assembly';
import { joinSections, joinSectionsForDraw, type JoinedChunk, type JoinedDraw, type JoinTimes } from './chunk-join';
import { payloadTransfer, type ChunkPayload } from './chunk-wire';
import { chunkInWorld, chunkKey, sectionGrid, type CellGrid, type ChunkGrid, type SectionEdge } from './coords';
import type { SectionResult } from './derive-assembly';
import { derivedBytes, encodeDerived, type DerivedData } from './derived-data';
import { SHADER_BORDER_CELLS } from './derived-shader';
import type { DirtyTracker } from './dirty-tracker';
import { ALL_DERIVED_PARTS, DERIVED_PART } from './record';
import type { VoxelStoreCandidate } from './store';
import type { CellBox } from './stroke';
import type { DeriveInput, DeriveOutput, JobLane } from './stream-job';
import type { SeamSurface } from './lod-seam';
import type { EditHold } from './stream-seams';
import type { SampleRing, WorkerPool } from './worker-pool';
import { crc32 } from '@thirdlight/shared';

/** What one edit's atomic swap cost, from the edit to the swap. */
export interface SwapReport {
  /** The edit groups swapped together (an edit meeting an open group merges into it). */
  readonly groups: readonly number[];
  /** Sections whose new results were swapped in. */
  readonly sections: number;
  /** Derive jobs sent for them. */
  readonly jobs: number;
  /** Worker µs of those jobs: summed, and the longest one. */
  readonly workerUs: { readonly sum: number; readonly max: number };
  /** Main-thread ms building their aprons and payloads. */
  readonly mainMs: number;
  /** Per section: µs of its mesh producers (the surfaces and pieces), and of its whole derive. */
  readonly meshUs: readonly number[];
  readonly deriveUs: readonly number[];
  /** ms from the edit (or the refresh) to the swap. */
  readonly ms: number;
  /** The coarser levels' nodes (level, nx, ny, nz) whose new results went in with the swap (drawn nodes the edit changed). */
  readonly nodes: ReadonlyArray<readonly [number, number, number, number]>;
  /** The storage chunks whose draws the swap replaces (their `chunk` events came just before it), in key order. */
  readonly chunks: ReadonlyArray<readonly [number, number, number]>;
}

/** A chunk's derive results and events, as the streamer reports them (derive units are sections). */
export type SectionEvent =
  | { readonly type: 'derived' | 'shader'; readonly cx: number; readonly cy: number; readonly cz: number }
  /**
   * A storage chunk's sections have new results (all that one task brings:
   * an edit group's swap, or one job's answer): its joined draw
   * ({@link SectionDerives.joinedChunk}) is to be replaced. `shaderOnly`:
   * only shader data changed, the surfaces stand.
   */
  | { readonly type: 'chunk'; readonly cx: number; readonly cy: number; readonly cz: number; readonly shaderOnly: boolean }
  | { readonly type: 'swap'; readonly report: SwapReport };

/**
 * The voxels a derive reads: the resident world as the game sees it (the
 * base chunks with the runtime overlay laid over them).
 */
export interface DeriveView extends Pick<VoxelStoreCandidate, 'grid' | 'voxelAt'> {
  chunkForm(cx: number, cy: number, cz: number): 'absent' | 'uniform' | 'stored';
  /** A chunk's content for a job (its own arrays: they move to the worker). */
  chunkPayload(cx: number, cy: number, cz: number): ChunkPayload;
}

/** What the section derives need from the streamer that owns the chunks. */
export interface SectionHost {
  readonly store: DeriveView;
  readonly grid: ChunkGrid;
  readonly gridId: number;
  readonly pool: WorkerPool;
  readonly tracker: DirtyTracker;
  /** The dependency radius R (the rules' job radius). */
  readonly radius: number;
  readonly rules: AssemblyRuleSet | undefined;
  readonly counters: { derives: number; shaderDerives: number; staleRefused: number; deriveChecks: number; swaps: number };
  readonly rings: { readonly apronMs: SampleRing; readonly apronBytes: SampleRing; readonly deriveUs: SampleRing; readonly joinUs: SampleRing };
  isResident(cx: number, cy: number, cz: number): boolean;
  /** Whether a chunk that is not resident is on its way (being read or decoded, or inside the load ring and not held back by the budget). */
  coming(cx: number, cy: number, cz: number): boolean;
  /** Lane and distance² for a chunk's work outside an edit. */
  lane(cx: number, cy: number, cz: number): JobLane;
  distance2(cx: number, cy: number, cz: number): number;
  setPart(cx: number, cy: number, cz: number, part: string, bytes: number): boolean;
  emit(e: SectionEvent): void;
  poke(): void;
  /**
   * What a group (its ids) waits for besides its sections: the drawn mip
   * nodes its edits changed, and the seams reading them or its chunks,
   * rebuilt from `surfaces` (the group's results as they will be drawn);
   * `ready` when they are. Null: nothing to wait for.
   */
  seamHold?(groups: readonly number[], chunks: ReadonlyArray<readonly [number, number, number]>, surfaces: (cx: number, cy: number, cz: number, axis: number, plane: number) => SeamSurface[] | undefined, ready: () => void): EditHold | null;
}

interface Section {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly key: number;
  /** Its id in its chunk (sectionIdOf). */
  readonly id: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly chunk: number;
  derive: 'no' | 'yes' | 'edit';
  /** The derived parts the pending derive must rebuild (DERIVED_PART bits). */
  parts: number;
  /** Live job (0: none). */
  job: number;
  /** Input stamp: moves with every change within R. */
  stamp: number;
  derived: DeriveOutput | null;
  group: EditGroup | null;
  /** A new result waiting for its group to swap. */
  held: DeriveOutput | null;
  heldTimes: SectionResult['times'] | null;
}

interface EditGroup {
  readonly ids: number[];
  readonly members: Set<Section>;
  readonly waiting: Set<Section>;
  /** Chunks a refresh is reading again: the group swaps only after each has landed. */
  readonly chunks: Set<number>;
  startedAt: number;
  open: boolean;
  jobs: number;
  workerUs: number;
  workerUsMax: number;
  mainMs: number;
  /** The drawn nodes and seams swapping with the group: being rebuilt, or none needed ('none'); null: not asked yet. */
  seams: EditHold | 'none' | null;
}

const EMPTY_OUTPUT: DeriveOutput = Object.freeze({ solid: 0, exposed: 0, mask: null, hash: 0, assembly: null, shader: null });

/** Whether parts (DERIVED_PART bits) include any output the assembly evaluation builds (anything but the shader data). */
export function geometryParts(parts: number): boolean {
  return (parts & ~DERIVED_PART.shader) !== 0;
}

/** The sections of a chunk, as section-grid coordinates. */
export function sectionsOfChunk(grid: ChunkGrid, sections: CellGrid, cx: number, cy: number, cz: number): Array<{ sx: number; sy: number; sz: number }> {
  const n = grid.edge / sections.edge;
  const out: Array<{ sx: number; sy: number; sz: number }> = [];
  for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) out.push({ sx: cx * n + x, sy: cy * n + y, sz: cz * n + z });
  return out;
}

function cloneApron(a: Apron): Apron {
  return { edge: a.edge, radius: a.radius, dense: a.dense.slice(), uniform: a.uniform.slice(), offsets: a.offsets.slice(), values: a.values.slice() };
}

export class SectionDerives {
  readonly sections: CellGrid;
  /** Sections a chunk edge. */
  readonly perAxis: number;
  private readonly bySection = new Map<number, Section>();
  private readonly byChunk = new Map<number, Section[]>();
  private readonly wanted = new Set<Section>();
  /** Live jobs: their sections, in the order sent. */
  private readonly jobs = new Map<number, Section[]>();
  /** Chunks a refresh is reading again → the group waiting on them. */
  private readonly chunkGroups = new Map<number, EditGroup>();
  /** Sections waiting for their chunk's neighbours, by chunk key: a neighbour's landing wants them again. */
  private readonly blocked = new Map<number, Set<Section>>();
  /**
   * Blocked sections kept in their edit group because the neighbours they
   * wait for are coming: the edit swaps (and is reported) only once they
   * derive, so its whole change lands in one swap. One whose neighbours
   * stop coming leaves its group at the next request.
   */
  private readonly heldBlocked = new Set<Section>();
  /** Open groups by every id they answer to (a merged group keeps the ids of those merged into it). */
  private readonly groups = new Map<number, EditGroup>();
  private stampSeq = 0;
  private groupSeq = 0;
  /** Chunks whose sections took new results in this task, not yet announced: chunk key → whether only shader data changed. */
  private readonly touched = new Map<number, { cx: number; cy: number; cz: number; shaderOnly: boolean }>();

  constructor(
    private readonly host: SectionHost,
    edge: SectionEdge,
    private readonly editMsPerUpdate: number,
  ) {
    const e = host.grid.edge;
    if (edge > e || e % edge !== 0) throw new RangeError(`section edge ${edge} for chunks of ${e}`);
    if (edge < e && host.rules === undefined) throw new RangeError('sections smaller than a chunk need assembly rules');
    if (host.radius > edge) throw new RangeError(`dependency radius ${host.radius} past a section of ${edge}`);
    this.sections = sectionGrid(edge);
    this.perAxis = e / edge;
  }

  /** Live derive jobs. */
  get deriving(): number {
    return this.jobs.size;
  }

  /** A section's current result (null: none yet, or a rebuild pending); `drawn`: its newest committed result even while a rebuild is pending. */
  derivedOf(sx: number, sy: number, sz: number, drawn = false): DeriveOutput | null {
    if (!chunkInWorld(this.sections, sx, sy, sz)) return null;
    const s = this.bySection.get(chunkKey(this.sections, sx, sy, sz));
    return s === undefined || (s.derive !== 'no' && !drawn) ? null : s.derived;
  }

  *derived(): IterableIterator<{ cx: number; cy: number; cz: number; result: DeriveOutput }> {
    for (const s of this.bySection.values()) if (s.derive === 'no' && s.derived !== null) yield { cx: s.sx, cy: s.sy, cz: s.sz, result: s.derived };
  }

  /**
   * A storage chunk's sections joined into one draw (chunk-join.ts): each
   * section's newest committed result, so a section waiting for its group's
   * swap still gives the result drawn before it. Null when no section of the
   * chunk has an assembly result (not resident, air, or derived without
   * rules).
   */
  joinedChunk(cx: number, cy: number, cz: number, times?: JoinTimes): JoinedChunk | null {
    const results = this.sectionResults(cx, cy, cz);
    if (results === null) return null;
    const t0 = performance.now();
    const out = joinSections(this.host.grid.edge, this.sections.edge, results, times);
    this.host.rings.joinUs.add((performance.now() - t0) * 1000);
    return out;
  }

  /** {@link joinedChunk} as a renderer uploads it: the shader grid's entries written into `cells` (chunk-join.ts `joinSectionsForDraw`). */
  joinedDraw(cx: number, cy: number, cz: number, cells: Uint16Array, times?: JoinTimes): JoinedDraw | null {
    const results = this.sectionResults(cx, cy, cz);
    if (results === null) return null;
    const t0 = performance.now();
    const out = joinSectionsForDraw(this.host.grid.edge, this.sections.edge, results, cells, times);
    this.host.rings.joinUs.add((performance.now() - t0) * 1000);
    return out;
  }

  /** A chunk's sections' newest committed assembly results by section id (null: none of them has one). */
  private sectionResults(cx: number, cy: number, cz: number): Array<DerivedData | null> | null {
    if (!chunkInWorld(this.host.grid, cx, cy, cz)) return null;
    const list = this.byChunk.get(chunkKey(this.host.grid, cx, cy, cz));
    if (list === undefined) return null;
    const results = new Array<DerivedData | null>(list.length).fill(null);
    let any = false;
    for (const s of list) {
      const a = s.derived?.assembly ?? null;
      results[s.id] = a;
      any ||= a !== null;
    }
    return any ? results : null;
  }

  /** Whether a chunk has sections and each has had a result (what it draws is known; air included). */
  chunkReady(cx: number, cy: number, cz: number): boolean {
    if (!chunkInWorld(this.host.grid, cx, cy, cz)) return false;
    const list = this.byChunk.get(chunkKey(this.host.grid, cx, cy, cz));
    return list !== undefined && list.every((s) => s.derived !== null);
  }

  /**
   * A chunk's derive sections within a cell of a plane (`axis`, cells) as a
   * seam reads them: each section's drawn result (with `held`, the one
   * waiting for its group's swap first). Undefined while one of them has
   * never had a result, or the chunk has no sections.
   */
  seamSurfaces(cx: number, cy: number, cz: number, axis: number, plane: number, held = false): SeamSurface[] | undefined {
    if (!chunkInWorld(this.host.grid, cx, cy, cz)) return undefined;
    const list = this.byChunk.get(chunkKey(this.host.grid, cx, cy, cz));
    if (list === undefined) return undefined;
    const e = this.sections.edge;
    const out: SeamSurface[] = [];
    for (const s of list) {
      const lo = [s.sx * e, s.sy * e, s.sz * e];
      if (plane < lo[axis]! - 1 || plane > lo[axis]! + e + 1) continue;
      const r = (held ? (s.held ?? s.derived) : s.derived) ?? null;
      if (r === null) return undefined;
      const a = r.assembly;
      if (a !== null && (a.ground.vertexCount > 0 || a.base.vertexCount > 0)) out.push({ x0: lo[0]!, y0: lo[1]!, z0: lo[2]!, ground: a.ground, base: a.base });
    }
    return out;
  }

  /** Registers what a section's derived representation costs, against its chunk's budget entry. */
  setPart(sx: number, sy: number, sz: number, part: string, bytes: number): boolean {
    if (!chunkInWorld(this.sections, sx, sy, sz)) return false;
    const s = this.bySection.get(chunkKey(this.sections, sx, sy, sz));
    return s !== undefined && this.host.setPart(s.cx, s.cy, s.cz, `${part}#${s.id}`, bytes);
  }

  private chunkBox(cx: number, cy: number, cz: number): CellBox {
    const sh = this.host.grid.shift;
    return { minX: cx << sh, minY: cy << sh, minZ: cz << sh, maxX: ((cx + 1) << sh) - 1, maxY: ((cy + 1) << sh) - 1, maxZ: ((cz + 1) << sh) - 1 };
  }

  /** A chunk's content landed (first load): its sections exist now, and everything within R of it is derived again. */
  chunkLanded(cx: number, cy: number, cz: number): void {
    const ck = chunkKey(this.host.grid, cx, cy, cz);
    if (!this.byChunk.has(ck)) {
      const list: Section[] = [];
      const n = this.perAxis;
      for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) {
        const sx = cx * n + x;
        const sy = cy * n + y;
        const sz = cz * n + z;
        const s: Section = { sx, sy, sz, key: chunkKey(this.sections, sx, sy, sz), id: (x * n + z) * n + y, cx, cy, cz, chunk: ck, derive: 'no', parts: 0, job: 0, stamp: 0, derived: null, group: null, held: null, heldTimes: null };
        list.push(s);
        this.bySection.set(s.key, s);
      }
      this.byChunk.set(ck, list);
    }
    this.invalidate(this.chunkBox(cx, cy, cz), 'yes', ALL_DERIVED_PARTS, null);
    // A section's job carries its chunk's whole apron, so a section blocked on an unknown neighbour chunk may lie
    // farther than R from this one: every blocked section of the chunks around it is looked at again.
    const g = this.host.grid;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      if (!chunkInWorld(g, cx + dx, cy + dy, cz + dz)) continue;
      const nk = chunkKey(g, cx + dx, cy + dy, cz + dz);
      const waiting = this.blocked.get(nk);
      if (waiting === undefined) continue;
      this.blocked.delete(nk);
      for (const s of waiting) if (this.bySection.get(s.key) === s && s.derive !== 'no') this.wanted.add(s);
    }
  }

  /** A chunk left: its sections, their jobs, and their places in any group go. */
  chunkDropped(cx: number, cy: number, cz: number): void {
    const ck = chunkKey(this.host.grid, cx, cy, cz);
    const list = this.byChunk.get(ck);
    this.byChunk.delete(ck);
    this.blocked.delete(ck);
    this.touched.delete(ck);
    const touched = new Set<EditGroup>();
    for (const s of list ?? []) {
      if (s.job !== 0) {
        this.host.pool.cancel(s.job);
        this.jobs.delete(s.job);
        s.job = 0;
      }
      if (s.group !== null) touched.add(s.group);
      this.heldBlocked.delete(s);
      this.leave(s, false);
      this.wanted.delete(s);
      this.bySection.delete(s.key);
    }
    const g = this.chunkGroups.get(ck);
    if (g !== undefined) {
      this.chunkGroups.delete(ck);
      g.chunks.delete(ck);
      touched.add(g);
    }
    for (const t of touched) this.maybeSwap(t);
  }

  /** A new edit group (one edit, or one refresh): its id names it in the `swap` report. */
  newGroup(): number {
    return this.open().ids[0]!;
  }

  private open(): EditGroup {
    const g: EditGroup = { ids: [++this.groupSeq], members: new Set(), waiting: new Set(), chunks: new Set(), startedAt: performance.now(), open: true, jobs: 0, workerUs: 0, workerUsMax: 0, mainMs: 0, seams: null };
    this.groups.set(g.ids[0]!, g);
    return g;
  }

  private group(id: number | null): EditGroup | null {
    if (id === null) return null;
    const g = this.groups.get(id);
    return g !== undefined && g.open ? g : null;
  }

  /** A refresh will read this chunk again: the group swaps only once its new content has landed (or the refresh is dropped). */
  awaitChunk(groupId: number, cx: number, cy: number, cz: number): void {
    let g = this.group(groupId);
    if (g === null) return;
    const ck = chunkKey(this.host.grid, cx, cy, cz);
    const before = this.chunkGroups.get(ck);
    if (before !== undefined && before !== g && before.open) g = this.merge(before, g);
    g.chunks.add(ck);
    this.chunkGroups.set(ck, g);
  }

  /** The open group a refresh of this chunk swaps in (null: none waits on it). */
  refreshGroup(cx: number, cy: number, cz: number): number | null {
    const g = this.chunkGroups.get(chunkKey(this.host.grid, cx, cy, cz));
    return g !== undefined && g.open ? g.ids[0]! : null;
  }

  /** A refreshed chunk's new content landed: everything within reach of `box` is derived again in the group waiting on it. */
  contentLanded(cx: number, cy: number, cz: number, box: CellBox, parts: number): void {
    const ck = chunkKey(this.host.grid, cx, cy, cz);
    const g = this.chunkGroups.get(ck) ?? null;
    this.chunkGroups.delete(ck);
    this.invalidate(box, 'edit', parts, g);
    if (g !== null) {
      g.chunks.delete(ck);
      this.maybeSwap(g);
    }
  }

  /** A refresh of the chunk was dropped (damaged, superseded, edited here): the group no longer waits on it. */
  contentDropped(cx: number, cy: number, cz: number): void {
    const ck = chunkKey(this.host.grid, cx, cy, cz);
    const g = this.chunkGroups.get(ck);
    if (g === undefined) return;
    this.chunkGroups.delete(ck);
    g.chunks.delete(ck);
    this.maybeSwap(g);
  }

  /** Ends a group's setup: it swaps now if nothing in it needs a new result. */
  settleGroup(groupId: number): void {
    const g = this.group(groupId);
    if (g !== null) this.maybeSwap(g);
  }

  /**
   * Every resident section within reach of `box` is stale: its stamp moves
   * (results already on their way are refused) and it is derived again. A
   * change that feeds only the shader data reaches no further than the
   * shader border and rebuilds only that. With a group, the sections join
   * it and swap with it.
   */
  invalidate(box: CellBox, why: 'yes' | 'edit', parts: number, groupOrId: EditGroup | number | null): void {
    let g = typeof groupOrId === 'number' ? this.group(groupOrId) : groupOrId;
    const geometry = geometryParts(parts);
    for (const d of dependentChunks(this.sections, box, geometry ? this.host.radius : SHADER_BORDER_CELLS)) {
      const s = this.bySection.get(chunkKey(this.sections, d.cx, d.cy, d.cz));
      if (s === undefined) continue;
      s.stamp = ++this.stampSeq;
      this.want(s, why, geometry ? ALL_DERIVED_PARTS : parts);
      if (g !== null) g = this.join(g, s);
      else if (s.group !== null) {
        s.held = null;
        s.group.waiting.add(s);
        this.unready(s.group);
      }
    }
  }

  private want(s: Section, why: 'yes' | 'edit', parts: number): void {
    s.parts = (s.derive === 'no' ? 0 : s.parts) | parts;
    if (s.derive !== 'edit') s.derive = why;
    this.wanted.add(s);
  }

  /** Adds a section to a group (merging the group it is already in); returns the group it is in now. */
  private join(g: EditGroup, s: Section): EditGroup {
    if (s.group !== null && s.group !== g) g = this.merge(s.group, g);
    s.group = g;
    g.members.add(s);
    g.waiting.add(s);
    s.held = null;
    s.heldTimes = null;
    this.unready(g);
    return g;
  }

  /** A group's results changed after its seams were asked for: they are asked for again once all are back. */
  private unready(g: EditGroup): void {
    if (g.seams !== null && g.seams !== 'none') g.seams.cancel();
    g.seams = null;
  }

  /** Merges group `a` into `b` (both swap together, as one). */
  private merge(a: EditGroup, b: EditGroup): EditGroup {
    if (a === b) return b;
    for (const m of a.members) {
      m.group = b;
      b.members.add(m);
    }
    for (const w of a.waiting) b.waiting.add(w);
    for (const c of a.chunks) {
      b.chunks.add(c);
      this.chunkGroups.set(c, b);
    }
    b.ids.push(...a.ids);
    b.startedAt = Math.min(a.startedAt, b.startedAt);
    b.jobs += a.jobs;
    b.workerUs += a.workerUs;
    b.workerUsMax = Math.max(a.workerUsMax, b.workerUsMax);
    b.mainMs += a.mainMs;
    this.unready(a);
    this.unready(b);
    a.open = false;
    for (const id of a.ids) this.groups.set(id, b);
    return b;
  }

  /** Takes a section out of its group (it cannot be derived now, or its chunk left); `swap`: let the group swap without it. */
  private leave(s: Section, swap = true): void {
    const g = s.group;
    if (g === null) return;
    s.group = null;
    s.held = null;
    s.heldTimes = null;
    g.members.delete(s);
    g.waiting.delete(s);
    this.unready(g);
    if (swap) this.maybeSwap(g);
  }

  private maybeSwap(g: EditGroup): void {
    if (!g.open || g.waiting.size > 0 || g.chunks.size > 0) return;
    const members = [...g.members].sort((a, b) => a.key - b.key);
    if (g.seams === null) {
      const chunks = [...new Map(members.map((m) => [m.chunk, [m.cx, m.cy, m.cz] as const])).values()];
      g.seams = this.host.seamHold?.(g.ids.slice(), chunks, (cx, cy, cz, axis, plane) => this.seamSurfaces(cx, cy, cz, axis, plane, true), () => this.maybeSwap(g)) ?? 'none';
    }
    if (g.seams !== 'none' && !g.seams.done) return;
    g.open = false;
    const meshUs: number[] = [];
    const deriveUs: number[] = [];
    for (const m of members) {
      m.group = null;
      const out = m.held;
      const times = m.heldTimes;
      m.held = null;
      m.heldTimes = null;
      if (times !== null) {
        meshUs.push(Number(times.meshUs.toFixed(1)));
        deriveUs.push(Number((times.evaluateUs + times.meshUs + times.consumersUs).toFixed(1)));
      }
      if (out !== null) this.commit(m, out);
    }
    for (const id of g.ids) this.groups.delete(id);
    const chunks = [...new Map(members.map((m) => [m.chunk, [m.cx, m.cy, m.cz] as const])).entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    this.flushChunks();
    if (g.seams !== 'none') g.seams.commit();
    const nodes = g.seams === 'none' ? [] : g.seams.nodes.slice();
    this.host.counters.swaps++;
    this.host.emit({ type: 'swap', report: { groups: g.ids.slice(), sections: members.length, jobs: g.jobs, workerUs: { sum: Math.round(g.workerUs), max: Math.round(g.workerUsMax) }, mainMs: Number(g.mainMs.toFixed(3)), meshUs, deriveUs, ms: Number((performance.now() - g.startedAt).toFixed(2)), chunks, nodes } });
  }

  /** A section's new result: held for its group, or in at once. */
  private deliver(s: Section, out: DeriveOutput, times: SectionResult['times'] | null): void {
    const g = s.group;
    if (g !== null && g.open) {
      s.held = out;
      s.heldTimes = times;
      g.waiting.delete(s);
      this.maybeSwap(g);
      return;
    }
    this.commit(s, out);
  }

  private commit(s: Section, out: DeriveOutput): void {
    s.derive = 'no';
    s.parts = 0;
    const counters = this.host.counters;
    if (out.shader !== null && s.derived?.assembly != null) {
      // Only the shader data was rebuilt: it replaces that part of the full result.
      const assembly = { ...s.derived.assembly, shader: out.shader };
      s.derived = { ...s.derived, assembly, hash: crc32(encodeDerived(assembly)) };
      counters.shaderDerives++;
      this.host.setPart(s.cx, s.cy, s.cz, `derive#${s.id}`, derivedBytes(assembly));
      this.host.emit({ type: 'shader', cx: s.sx, cy: s.sy, cz: s.sz });
      this.touch(s, true);
      return;
    }
    this.touch(s, false);
    s.derived = out;
    counters.derives++;
    this.host.setPart(s.cx, s.cy, s.cz, `derive#${s.id}`, out.assembly !== null ? derivedBytes(out.assembly) : (out.mask?.byteLength ?? 0));
    this.host.emit({ type: 'derived', cx: s.sx, cy: s.sy, cz: s.sz });
  }

  private touch(s: Section, shaderOnly: boolean): void {
    const t = this.touched.get(s.chunk);
    if (t === undefined) this.touched.set(s.chunk, { cx: s.cx, cy: s.cy, cz: s.cz, shaderOnly });
    else t.shaderOnly &&= shaderOnly;
  }

  /** Announces every chunk whose sections took new results since the last flush (one `chunk` event each, key order). */
  private flushChunks(): void {
    if (this.touched.size === 0) return;
    const list = [...this.touched.entries()].sort((a, b) => a[0] - b[0]);
    this.touched.clear();
    for (const [, t] of list) this.host.emit({ type: 'chunk', cx: t.cx, cy: t.cy, cz: t.cz, shaderOnly: t.shaderOnly });
  }

  /** Whether all of a chunk's neighbours are known (resident, or outside the world): its apron can be built. */
  private canDerive(cx: number, cy: number, cz: number): boolean {
    if (!this.host.isResident(cx, cy, cz)) return false;
    if (this.host.radius === 0) return true;
    const g = this.host.grid;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      if (!chunkInWorld(g, cx + dx, cy + dy, cz + dz)) continue;
      if (!this.host.isResident(cx + dx, cy + dy, cz + dz)) return false;
    }
    return true;
  }

  /** Whether a section's pending derive rebuilds only its shader data (it has a full result to keep). */
  private shaderOnly(s: Section): boolean {
    return s.parts === DERIVED_PART.shader && s.derived?.assembly != null;
  }

  /** Whether anything wanted can be sent now (for the streamer's idle check). */
  pending(): boolean {
    if (this.jobs.size > 0) return true;
    for (const s of this.wanted) if (this.shaderOnly(s) || this.canDerive(s.cx, s.cy, s.cz)) return true;
    return false;
  }

  /**
   * Sends the wanted sections' jobs: an edit's first (within
   * `editMsPerUpdate` of main-thread time), then the rest (within
   * `msPerUpdate`), as far as the pool has room. A section whose chunk's
   * neighbours are not all known waits outside the set: a neighbour's
   * landing wants it again.
   */
  request(msPerUpdate: number, editsOnly = false): void {
    this.releaseBlocked();
    if (this.wanted.size === 0) return;
    const byChunk = new Map<number, Section[]>();
    const edits: number[] = [];
    const rest: number[] = [];
    for (const s of this.wanted) {
      let l = byChunk.get(s.chunk);
      if (l === undefined) {
        byChunk.set(s.chunk, (l = []));
        (s.derive === 'edit' ? edits : rest).push(s.chunk);
      } else if (s.derive === 'edit' && rest.includes(s.chunk)) {
        rest.splice(rest.indexOf(s.chunk), 1);
        edits.push(s.chunk);
      }
      l.push(s);
    }
    let room = this.host.pool.room();
    const t0 = performance.now();
    for (const [order, budget] of [[edits, this.editMsPerUpdate], [editsOnly ? [] : rest, msPerUpdate]] as const) {
      for (const ck of order) {
        if (room <= 0 || performance.now() - t0 > budget) break;
        const list = byChunk.get(ck)!;
        for (const s of list) this.wanted.delete(s);
        this.host.counters.deriveChecks++;
        const shader = list.filter((s) => this.shaderOnly(s));
        const full = list.filter((s) => !this.shaderOnly(s));
        // An edit's work spreads over the pool: a chunk's sections are split only while there are fewer chunks than
        // workers (each job fills its chunk's neighbourhood once, so more jobs than workers only repeat that).
        const split = order === edits ? Math.max(1, Math.ceil(this.host.pool.size / edits.length)) : 1;
        if (shader.length > 0) room -= this.send(shader, true, split);
        if (full.length > 0) room -= this.send(full, false, split);
      }
    }
  }

  /** Lets go of held blocked sections whose group closed, whose chunk left, or whose neighbours stopped coming (the group may swap without them). */
  private releaseBlocked(): void {
    for (const s of this.heldBlocked) {
      if (this.wanted.has(s)) continue;
      const g = s.group;
      if (g !== null && g.open && this.bySection.get(s.key) === s && this.neighboursComing(s.cx, s.cy, s.cz)) continue;
      this.heldBlocked.delete(s);
      this.leave(s);
    }
  }

  /** Whether every neighbour of a chunk that is not resident is on its way (so a section blocked on them will derive). */
  private neighboursComing(cx: number, cy: number, cz: number): boolean {
    const g = this.host.grid;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      if (!chunkInWorld(g, cx + dx, cy + dy, cz + dz)) continue;
      if (!this.host.isResident(cx + dx, cy + dy, cz + dz) && !this.host.coming(cx + dx, cy + dy, cz + dz)) return false;
    }
    return true;
  }

  /** Sends one chunk's sections (all shader-only, or all full) in up to `split` jobs; returns the jobs sent. */
  private send(list: Section[], shaderOnly: boolean, split: number): number {
    const host = this.host;
    const { cx, cy, cz } = list[0]!;
    for (const s of list) this.heldBlocked.delete(s);
    if (!shaderOnly && !this.canDerive(cx, cy, cz)) {
      let waiting = this.blocked.get(list[0]!.chunk);
      if (waiting === undefined) this.blocked.set(list[0]!.chunk, (waiting = new Set()));
      // An edit's section waits in its group for neighbours on their way (the edit lands whole, in one swap);
      // otherwise the group swaps without it and it derives as streaming once its neighbours are known.
      const keep = list.some((s) => s.group !== null && s.group.open) && this.neighboursComing(cx, cy, cz);
      for (const s of list) {
        if (keep && s.group !== null && s.group.open) this.heldBlocked.add(s);
        else this.leave(s);
        waiting.add(s);
      }
      return 0;
    }
    const store = host.store;
    const form = store.chunkForm(cx, cy, cz);
    const rules = host.rules;
    if (form === 'absent' && rules === undefined) {
      // An air chunk has nothing to derive.
      for (const s of list) this.deliver(s, EMPTY_OUTPUT, null);
      this.flushChunks();
      return 0;
    }
    const radius = shaderOnly ? SHADER_BORDER_CELLS : host.radius;
    const t0 = performance.now();
    const apron = buildApron(store, cx, cy, cz, radius);
    const apronMs = performance.now() - t0;
    host.rings.apronMs.add(apronMs);
    if (!shaderOnly && form === 'absent' && apron.dense.every((d, k) => d === 0 && apron.uniform[k] === 0)) {
      // Air with air all around: nothing stands, nothing is drawn.
      for (const s of list) this.deliver(s, EMPTY_OUTPUT, null);
      this.flushChunks();
      return 0;
    }
    host.rings.apronBytes.add(apronBytes(apron));
    const isEdit = list.some((s) => s.derive === 'edit');
    const lane: JobLane = isEdit ? 'edit' : host.lane(cx, cy, cz);
    const distance = isEdit ? 0 : host.distance2(cx, cy, cz);
    const k = Math.min(list.length, split);
    const ref = { grid: host.gridId, key: list[0]!.chunk };
    for (let j = 0; j < k; j++) {
      const part = list.filter((_, i) => i % k === j);
      const t1 = performance.now();
      const payload = store.chunkPayload(cx, cy, cz);
      // The apron's buffers move with the last job; the others take copies.
      const a = j === k - 1 ? apron : cloneApron(apron);
      const buildMs = performance.now() - t1 + (j === 0 ? apronMs : 0);
      // Staleness is the sections' own stamps: the tracker's id only routes the reply.
      const id = host.tracker.beginJob(ref).id;
      host.tracker.expireJob(id);
      const stamps = part.map((s) => s.stamp);
      for (const s of part) s.job = id;
      this.jobs.set(id, part);
      for (const g of new Set(part.map((s) => s.group))) {
        if (g === null || !g.open) continue;
        g.jobs++;
        g.mainMs += buildMs;
      }
      const sections = shaderOnly || rules !== undefined ? { edge: this.sections.edge as SectionEdge, ids: part.map((s) => s.id) } : undefined;
      const input: DeriveInput = {
        edge: host.grid.edge,
        chunk: { grid: host.gridId, cx, cy, cz },
        payload,
        radius,
        apron: a,
        ...(shaderOnly ? { parts: DERIVED_PART.shader } : rules === undefined ? {} : { rules: rulesRef(rules) }),
        ...(sections === undefined ? {} : { sections }),
      };
      void host.pool.submit<DeriveOutput>({ id, kind: 'derive', lane, distance, input, transfer: payloadTransfer(payload, apronTransfer(a)) }).then((o) => this.answered(id, part, stamps, o));
    }
    return k;
  }

  private answered(id: number, part: readonly Section[], stamps: readonly number[], o: Awaited<ReturnType<WorkerPool['submit']>>): void {
    this.host.poke();
    this.jobs.delete(id);
    if (o.status === 'cancelled') return;
    if (o.status !== 'done') {
      for (const s of part) {
        if (s.job !== id) continue;
        s.job = 0;
        if (this.bySection.get(s.key) !== s) continue;
        // Refused or failed: the same input fails again, so the section is not retried (and its group swaps without it).
        if (o.status === 'refused' || o.status === 'failed') this.leave(s);
        else this.want(s, s.derive === 'edit' ? 'edit' : 'yes', s.parts || ALL_DERIVED_PARTS);
      }
      return;
    }
    this.host.rings.deriveUs.add(o.workerUs);
    for (const g of new Set(part.map((s) => s.group))) {
      if (g === null || !g.open) continue;
      g.workerUs += o.workerUs;
      g.workerUsMax = Math.max(g.workerUsMax, o.workerUs);
    }
    const out = o.output as DeriveOutput;
    part.forEach((s, i) => {
      if (s.job === id) s.job = 0;
      if (this.bySection.get(s.key) !== s || s.stamp !== stamps[i] || this.wanted.has(s)) {
        this.host.counters.staleRefused++;
        return;
      }
      const r = out.sections?.[i];
      if (r === undefined) {
        this.deliver(s, out, null);
        return;
      }
      if (r.id !== s.id) throw new Error(`derive job ${id}: section ${r.id} answered for ${s.id}`);
      this.deliver(s, { solid: 0, exposed: 0, mask: null, hash: r.hash, assembly: r.assembly, shader: r.shader }, r.times);
    });
    this.flushChunks();
  }
}
