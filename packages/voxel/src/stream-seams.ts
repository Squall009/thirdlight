/**
 * Seams between the levels the streamer draws (lod-seam.ts): which node
 * faces need one, built in workers (`seam` jobs), and kept current in the
 * same swap as whatever changed what they read.
 *
 * - **Selection.** A {@link LevelSelection} says which node of which level
 *   is drawn; a face of a drawn node of level L whose neighbours across it
 *   are drawn at L − 1 needs a seam, owned by that node. Until the level
 *   selection with hysteresis drives it, the static rings do
 *   ({@link ringSelection}: level 0 within the first radius, level 1 within
 *   the next, …).
 * - **Inputs.** A face's seam reads its node's derived result, the results
 *   of its same-level neighbours beside the face (they close the node's rim)
 *   and the finer level's results against the face and beside it: nodes of
 *   level ≥ 1, or at level 0 the drawn derive sections of the chunks there.
 *   It is built once every one of the node's own and the four finer inputs
 *   against the face has a result.
 * - **Swaps.** A seam is part of the swap of what changed its inputs, and
 *   the old one stays until then: a mip node's new result is held until the
 *   seams reading it are rebuilt from it ({@link StreamSeams.holdNode}), an
 *   edit's section group swaps only once the seams reading its chunks are
 *   rebuilt from its held results ({@link StreamSeams.holdChunks}), and a
 *   change of the selection builds every seam it adds and drops every seam
 *   it removes in one `seams` event ({@link StreamSeams.selectionChanged}).
 *   Inputs that change outside those (a chunk or a node landing while
 *   streaming in) rebuild the seams reading them as their jobs come back.
 */
import { chunkInWorld, type ChunkGrid } from './coords';
import type { DerivedData } from './derived-data';
import type { SurfaceBuffer } from './derived-mesh';
import type { DirtyTracker } from './dirty-tracker';
import { seamBytes, type FaceSeam, type NodeFace, type SeamFaceInput, type SeamSurface } from './lod-seam';
import type { Focus } from './stream-ring';
import type { JobLane } from './stream-job';
import { SampleRing, type JobOutcome, type WorkerPool } from './worker-pool';

/** Which node of which level is drawn (level 0: a chunk). */
export interface LevelSelection {
  /** Whether node (level, nx, ny, nz) is drawn: not split into finer nodes, and not inside a coarser drawn node. */
  drawn(level: number, nx: number, ny: number, nz: number): boolean;
}

/** A face of a node of a level. */
export interface SeamKey {
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly face: NodeFace;
}

/** Seams were built and dropped together (one swap): draw the built ones, stop drawing the removed ones. */
export interface SeamEvent {
  readonly type: 'seams';
  readonly built: readonly SeamKey[];
  readonly removed: readonly SeamKey[];
}

/** The four nodes of level L − 1 across face `f` of node n of level L, against it. */
function finerAcross(n: readonly number[], f: number, out: Array<[number, number, number]> = []): Array<[number, number, number]> {
  const axis = f >> 1;
  const inPlane = [0, 1, 2].filter((a) => a !== axis);
  for (let i = 0; i < 4; i++) {
    const c = [0, 0, 0];
    c[axis] = f & 1 ? 2 * (n[axis]! + 1) : 2 * n[axis]! - 1;
    c[inPlane[0]!] = 2 * n[inPlane[0]!]! + (i >> 1);
    c[inPlane[1]!] = 2 * n[inPlane[1]!]! + (i & 1);
    out.push(c as [number, number, number]);
  }
  return out;
}

/**
 * The level drawn across each face of a drawn node (index: the face): its
 * own level, one coarser, one finer (every node against the face at that
 * level), or −1 (nothing drawn there one level apart: outside the world, or
 * a selection more than a level apart).
 */
export function faceLevels(sel: LevelSelection, maxLevel: number, level: number, nx: number, ny: number, nz: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < 6; f++) {
    const m = [nx, ny, nz];
    m[f >> 1]! += f & 1 ? 1 : -1;
    if (sel.drawn(level, m[0]!, m[1]!, m[2]!)) out.push(level);
    else if (level < maxLevel && sel.drawn(level + 1, m[0]! >> 1, m[1]! >> 1, m[2]! >> 1)) out.push(level + 1);
    else if (level > 0 && finerAcross([nx, ny, nz], f).every((c) => sel.drawn(level - 1, c[0], c[1], c[2]))) out.push(level - 1);
    else out.push(-1);
  }
  return out;
}

/**
 * Static distance rings: a node of level L ≥ 1 is split into level L − 1
 * while its horizontal box distance from the focus is under `radii[L − 1]`
 * (cells); the top level `maxLevel` is never inside a coarser one. Radii
 * growing by at least a node of the next level keep neighbours within one
 * level of each other.
 */
export function ringSelection(grid: ChunkGrid, focus: () => Focus, radii: readonly number[], maxLevel: number): LevelSelection {
  const distance = (level: number, nx: number, nz: number): number => {
    const f = focus();
    const size = grid.edge * 2 ** level;
    const dx = Math.max(0, nx * size - f.x, f.x - (nx + 1) * size);
    const dz = Math.max(0, nz * size - f.z, f.z - (nz + 1) * size);
    return Math.sqrt(dx * dx + dz * dz);
  };
  return {
    drawn(level, nx, ny, nz) {
      if (!Number.isInteger(level) || level < 0 || level > maxLevel) return false;
      if (!chunkInWorld(grid, nx * 2 ** level, ny * 2 ** level, nz * 2 ** level)) return false;
      if (level > 0 && distance(level, nx, nz) < radii[level - 1]!) return false;
      return level === maxLevel || distance(level + 1, nx >> 1, nz >> 1) < radii[level]!;
    },
  };
}

/** What the seams need from the streamer and its mip levels. */
export interface SeamHost {
  readonly grid: ChunkGrid;
  readonly gridId: number;
  readonly pool: WorkerPool;
  readonly tracker: DirtyTracker;
  readonly maxLevel: number;
  /** A node's current result (level ≥ 1): undefined when it has none yet, null when it has nothing to draw. */
  nodeResult(level: number, nx: number, ny: number, nz: number): DerivedData | null | undefined;
  /** Every kept node of level ≥ 1 (the candidates for drawing). */
  nodes(): Iterable<{ readonly level: number; readonly nx: number; readonly ny: number; readonly nz: number }>;
  /** A level-0 chunk's drawn section surfaces within a cell of a plane (axis, cells); undefined while one of them has no result. */
  chunkSurfaces(cx: number, cy: number, cz: number, axis: number, plane: number): SeamSurface[] | undefined;
  emit(e: SeamEvent): void;
  poke(): void;
}

/** A pending rebuild of seams, held by what caused it: `commit` puts them in (in the caller's swap), `cancel` drops them. */
export interface SeamHold {
  readonly done: boolean;
  commit(): void;
  cancel(): void;
}

/** Inputs replaced while a hold is built: a node's new result, or chunks' held section surfaces. */
interface Override {
  readonly level: number;
  readonly node?: { readonly nx: number; readonly ny: number; readonly nz: number; readonly result: DerivedData | null };
  readonly chunks?: (cx: number, cy: number, cz: number, axis: number, plane: number) => SeamSurface[] | undefined;
}

interface Entry {
  readonly id: string;
  readonly key: SeamKey;
  seam: FaceSeam | null;
  bytes: number;
  /** The newest launch (only its result goes in). */
  seq: number;
  /** No longer wanted: removed with the batch that dropped it. */
  leaving: boolean;
}

const EMPTY_SURFACE: SurfaceBuffer = Object.freeze({ vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0) });

const keyOf = (level: number, nx: number, ny: number, nz: number, face: number): string => `${level}:${nx},${ny},${nz}:${face}`;

export class StreamSeams {
  readonly counters = { built: 0, holds: 0, superseded: 0, failed: 0 };
  /** Worker µs a face. */
  readonly seamUs = new SampleRing();
  private selection: LevelSelection;
  private readonly entries = new Map<string, Entry>();
  /** Faces whose inputs changed outside a hold: rebuilt as streaming work. */
  private readonly dirty = new Set<string>();
  private readonly jobs = new Set<number>();
  private total = 0;
  private seq = 0;
  /** The wanted faces are to be worked out again (a node landed or left); `batch`: the selection changed (one swap). */
  private stale = true;
  private batch = false;

  constructor(
    private readonly host: SeamHost,
    selection: LevelSelection,
  ) {
    this.selection = selection;
  }

  /** Bytes the kept seams hold. */
  get bytes(): number {
    return this.total;
  }

  get running(): number {
    return this.jobs.size;
  }

  /** The seam of a face (null: none needed, or not built yet). */
  seamOf(level: number, nx: number, ny: number, nz: number, face: NodeFace): FaceSeam | null {
    return this.entries.get(keyOf(level, nx, ny, nz, face))?.seam ?? null;
  }

  /** Every face that needs a seam now, with the seam drawn there (null: not built yet). */
  *seams(): IterableIterator<{ readonly key: SeamKey; readonly seam: FaceSeam | null }> {
    for (const e of this.entries.values()) if (!e.leaving) yield { key: e.key, seam: e.seam };
  }

  /** Replaces the level selection (the selection with hysteresis drives it); its change is one swap. */
  setSelection(sel: LevelSelection): void {
    this.selection = sel;
    this.selectionChanged();
  }

  /** The selection's answer changed (its focus moved): the faces it adds are built and those it removes dropped, in one swap. */
  selectionChanged(): void {
    this.stale = true;
    this.batch = true;
  }

  /** A node was added, removed or derived outside a hold: the faces wanted are looked at again, and those reading it rebuilt. */
  nodeChanged(level: number, nx: number, ny: number, nz: number): void {
    this.stale = true;
    for (const e of this.readers(level, nx, ny, nz)) this.dirty.add(e.id);
  }

  /** A level-0 chunk's drawn surfaces changed outside a hold: the seams reading it are rebuilt. */
  chunkChanged(cx: number, cy: number, cz: number): void {
    for (const e of this.readers(0, cx, cy, cz)) this.dirty.add(e.id);
  }

  /** Whether seam work can go on now (for the streamer's idle check). */
  pending(): boolean {
    if (this.jobs.size > 0 || this.stale) return true;
    for (const id of this.dirty) {
      const e = this.entries.get(id);
      if (e !== undefined && !e.leaving && this.input(e.key) !== null) return true;
    }
    return false;
  }

  /**
   * A node's new result is to go in: the seams reading it are rebuilt from
   * it first. Returns null when none does (put it in now); else a hold
   * whose `ready` is called once they are built: commit the node, then the
   * hold, in one task.
   */
  holdNode(level: number, nx: number, ny: number, nz: number, result: DerivedData | null, ready: () => void): SeamHold | null {
    // A node's first result may add faces (a pending change of the selection adds its own in one swap).
    if (this.stale && !this.batch) this.refresh(false);
    return this.hold(this.readers(level, nx, ny, nz), { level, node: { nx, ny, nz, result } }, 'mip', ready);
  }

  /** An edit group's chunks are to swap: the seams reading them are rebuilt from `surfaces` (their held results) first; null when none does. */
  holdChunks(chunks: ReadonlyArray<readonly [number, number, number]>, surfaces: Override['chunks'], ready: () => void): SeamHold | null {
    const faces = new Map<string, Entry>();
    for (const [cx, cy, cz] of chunks) for (const e of this.readers(0, cx, cy, cz)) faces.set(e.id, e);
    return this.hold([...faces.values()], { level: 0, chunks: surfaces }, 'edit', ready);
  }

  /** Works out the wanted faces when stale, and sends rebuilds of dirty faces, as far as the pool has room. */
  request(): void {
    if (this.stale) this.refresh(this.batch);
    let room = this.host.pool.room();
    for (const id of this.dirty) {
      if (room <= 0) return;
      const e = this.entries.get(id);
      if (e === undefined || e.leaving) {
        this.dirty.delete(id);
        continue;
      }
      const input = this.input(e.key);
      if (input === null) continue;
      this.dirty.delete(id);
      const seq = ++this.seq;
      e.seq = seq;
      room--;
      void this.send(input, 'mip').then((seam) => {
        if (seam === undefined) return;
        this.put([[e, seq, seam]], []);
      });
    }
  }

  /** The faces the selection wants now; with `batch`, the ones it adds are built and the ones it drops removed in one swap. */
  private refresh(batch: boolean): void {
    this.stale = false;
    this.batch = false;
    const sel = this.selection;
    const want = new Map<string, SeamKey>();
    for (const n of this.host.nodes()) {
      if (n.level < 1 || !sel.drawn(n.level, n.nx, n.ny, n.nz)) continue;
      const levels = faceLevels(sel, this.host.maxLevel, n.level, n.nx, n.ny, n.nz);
      for (let f = 0; f < 6; f++) {
        if (levels[f] !== n.level - 1) continue;
        const key: SeamKey = { level: n.level, nx: n.nx, ny: n.ny, nz: n.nz, face: f as NodeFace };
        want.set(keyOf(n.level, n.nx, n.ny, n.nz, f), key);
      }
    }
    const added: Entry[] = [];
    const removed: Entry[] = [];
    for (const [id, e] of this.entries) if (!want.has(id) && !e.leaving) removed.push(e);
    for (const [id, key] of want) {
      const e = this.entries.get(id);
      if (e !== undefined) {
        e.leaving = false;
        continue;
      }
      const n: Entry = { id, key, seam: null, bytes: 0, seq: 0, leaving: false };
      this.entries.set(id, n);
      added.push(n);
    }
    if (!batch) {
      for (const e of added) this.dirty.add(e.id);
      for (const e of removed) this.drop(e);
      if (removed.length > 0) this.host.emit({ type: 'seams', built: [], removed: removed.map((e) => e.key) });
      return;
    }
    // One swap: the old seams stay drawn until every new one that can be built now is back.
    for (const e of removed) e.leaving = true;
    const hold = this.hold(added, { level: -1 }, 'mip', () => hold?.commit(), removed);
    if (hold === null && removed.length > 0) {
      for (const e of removed) this.drop(e);
      this.host.emit({ type: 'seams', built: [], removed: removed.map((e) => e.key) });
    }
  }

  /** Builds `faces` (those whose inputs are there) with `ov`, calling `ready` when all are back. */
  private hold(faces: readonly Entry[], ov: Override, lane: JobLane, ready: () => void, removing: readonly Entry[] = []): SeamHold | null {
    const launches: Array<[Entry, number, SeamFaceInput]> = [];
    for (const e of faces) {
      if (e.leaving) continue;
      const input = this.input(e.key, ov);
      if (input === null) {
        this.dirty.add(e.id);
        continue;
      }
      launches.push([e, ++this.seq, input]);
    }
    if (launches.length === 0 && removing.length === 0) return null;
    this.counters.holds++;
    const results: Array<[Entry, number, FaceSeam]> = [];
    let left = launches.length;
    let cancelled = false;
    let committed = false;
    const hold: SeamHold & { done: boolean } = {
      done: left === 0,
      commit: () => {
        if (cancelled || committed) return;
        committed = true;
        for (const [e, seq] of launches) {
          // The face's inputs changed while it was built here: it is rebuilt from the newer ones.
          if (!results.some((r) => r[0] === e)) this.dirty.add(e.id);
          if (e.seq !== seq) this.dirty.add(e.id);
        }
        this.put(results, removing);
      },
      cancel: () => {
        if (committed) return;
        cancelled = true;
        for (const [e] of launches) this.dirty.add(e.id);
      },
    };
    for (const [e, seq] of launches) {
      e.seq = seq;
      this.dirty.delete(e.id);
    }
    if (left === 0) {
      // Nothing to build, only seams to drop: in at once.
      queueMicrotask(() => ready());
      return hold;
    }
    for (const [e, seq, input] of launches) {
      void this.send(input, lane).then((seam) => {
        if (seam !== undefined) results.push([e, seq, seam]);
        left--;
        if (left === 0 && !cancelled) {
          hold.done = true;
          ready();
        }
      });
    }
    return hold;
  }

  /** Puts built seams in (each only if no newer build of its face was sent since) and drops the removed ones; one event. */
  private put(results: ReadonlyArray<readonly [Entry, number, FaceSeam]>, removed: readonly Entry[]): void {
    const built: SeamKey[] = [];
    for (const [e, seq, seam] of results) {
      if (this.entries.get(e.id) !== e || e.leaving) continue;
      if (e.seq !== seq) {
        this.counters.superseded++;
        continue;
      }
      this.total += seamBytes(seam) - e.bytes;
      e.bytes = seamBytes(seam);
      e.seam = seam;
      this.dirty.delete(e.id);
      this.counters.built++;
      built.push(e.key);
    }
    const gone: SeamKey[] = [];
    for (const e of removed) {
      if (!e.leaving || this.entries.get(e.id) !== e) continue;
      this.drop(e);
      gone.push(e.key);
    }
    if (built.length > 0 || gone.length > 0) this.host.emit({ type: 'seams', built, removed: gone });
  }

  private drop(e: Entry): void {
    this.entries.delete(e.id);
    this.dirty.delete(e.id);
    this.total -= e.bytes;
  }

  private send(input: SeamFaceInput, lane: JobLane): Promise<FaceSeam | undefined> {
    const host = this.host;
    const k = input;
    const id = host.tracker.beginJob({ grid: host.gridId, key: 0 }).id;
    host.tracker.expireJob(id);
    this.jobs.add(id);
    return host.pool.submit<FaceSeam>({ id, kind: 'seam', lane, distance: 0, input: k, transfer: [] }).then((o: JobOutcome<FaceSeam>) => {
      this.jobs.delete(id);
      host.poke();
      if (o.status !== 'done') {
        if (o.status !== 'cancelled') this.counters.failed++;
        return undefined;
      }
      this.seamUs.add(o.workerUs);
      return o.output;
    });
  }

  /** The kept faces whose seam reads node (level, nx, ny, nz) (level 0: a chunk): as the node, its neighbour beside the face, or the finer side. */
  private readers(level: number, nx: number, ny: number, nz: number): Entry[] {
    const out: Entry[] = [];
    const add = (l: number, x: number, y: number, z: number, f: number): void => {
      const e = this.entries.get(keyOf(l, x, y, z, f));
      if (e !== undefined && !out.includes(e)) out.push(e);
    };
    const n = [nx, ny, nz];
    for (let f = 0; f < 6; f++) {
      const axis = f >> 1;
      const inPlane = [0, 1, 2].filter((a) => a !== axis);
      if (level >= 1) {
        // As the node, or as a neighbour beside the face of a node of its level.
        for (let du = -1; du <= 1; du++) for (let dw = -1; dw <= 1; dw++) {
          const m = [...n];
          m[inPlane[0]!]! += du;
          m[inPlane[1]!]! += dw;
          add(level, m[0]!, m[1]!, m[2]!, f);
        }
      }
      // As the finer side of a node one level up: its layer against face f, within a node beside the face.
      const a = n[axis]!;
      const across = f & 1 ? (a % 2 === 0 ? a / 2 - 1 : null) : a % 2 !== 0 ? (a + 1) / 2 : null;
      if (across === null) continue;
      // Node m of the level up reads finer coordinates 2m − 1 … 2m + 2 beside the face.
      const span = (x: number): number[] => [Math.ceil((x - 2) / 2), Math.floor((x + 1) / 2)];
      for (const mu of span(n[inPlane[0]!]!)) {
        for (const mw of span(n[inPlane[1]!]!)) {
          const m = [0, 0, 0];
          m[axis] = across;
          m[inPlane[0]!] = mu;
          m[inPlane[1]!] = mw;
          add(level + 1, m[0]!, m[1]!, m[2]!, f);
        }
      }
    }
    return out;
  }

  /** A face's inputs (with `ov` in place of what it replaces), or null while its node or the four finer inputs against it have no result. */
  private input(key: SeamKey, ov?: Override): SeamFaceInput | null {
    const host = this.host;
    const E = host.grid.edge;
    const { level, face } = key;
    const n = [key.nx, key.ny, key.nz];
    const axis = face >> 1;
    const inPlane = [0, 1, 2].filter((a) => a !== axis);
    const nodeOf = (l: number, x: number, y: number, z: number): DerivedData | null | undefined => {
      const o = ov?.node;
      if (o !== undefined && ov!.level === l && o.nx === x && o.ny === y && o.nz === z) return o.result;
      return host.nodeResult(l, x, y, z);
    };
    const surface = (x: number, y: number, z: number, d: DerivedData | null): SeamSurface => ({ x0: x * E, y0: y * E, z0: z * E, ground: d?.ground ?? EMPTY_SURFACE, base: d?.base ?? EMPTY_SURFACE });
    const own = nodeOf(level, key.nx, key.ny, key.nz);
    if (own === undefined) return null;
    const coarseAround: SeamSurface[] = [];
    for (let du = -1; du <= 1; du++) for (let dw = -1; dw <= 1; dw++) {
      if (du === 0 && dw === 0) continue;
      const m = [...n];
      m[inPlane[0]!]! += du;
      m[inPlane[1]!]! += dw;
      const d = nodeOf(level, m[0]!, m[1]!, m[2]!);
      if (d != null) coarseAround.push(surface(m[0]!, m[1]!, m[2]!, d));
    }
    // The finer layer against the face: the four against it (needed) and the twelve beside them (read when there).
    const fine: SeamSurface[] = [];
    const planeCells = (n[axis]! + (face & 1)) * 2 * E;
    const f = level - 1;
    for (let i = -1; i <= 2; i++) for (let j = -1; j <= 2; j++) {
      const c = [0, 0, 0];
      c[axis] = face & 1 ? 2 * (n[axis]! + 1) : 2 * n[axis]! - 1;
      c[inPlane[0]!] = 2 * n[inPlane[0]!]! + i;
      c[inPlane[1]!] = 2 * n[inPlane[1]!]! + j;
      const needed = i >= 0 && i <= 1 && j >= 0 && j <= 1;
      if (!chunkInWorld(host.grid, c[0]! * 2 ** f, c[1]! * 2 ** f, c[2]! * 2 ** f)) continue;
      if (f === 0) {
        const s = ov?.chunks !== undefined ? ov.chunks(c[0]!, c[1]!, c[2]!, axis, planeCells) : host.chunkSurfaces(c[0]!, c[1]!, c[2]!, axis, planeCells);
        if (s === undefined) {
          if (needed) return null;
          continue;
        }
        fine.push(...s);
      } else {
        const d = nodeOf(f, c[0]!, c[1]!, c[2]!);
        if (d === undefined) {
          if (needed) return null;
          continue;
        }
        if (d !== null) fine.push(surface(c[0]!, c[1]!, c[2]!, d));
      }
    }
    return { edge: E, level, nx: key.nx, ny: key.ny, nz: key.nz, face, coarse: surface(key.nx, key.ny, key.nz, own), coarseAround, fine };
  }
}
