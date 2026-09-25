/**
 * Phase 21.2: reusable per-step buffers of the fixed-step loop, so a steady
 * step allocates nothing per entity and looks nothing up by id.
 *
 * - `TransformMirror` holds a copy of a transform map (the step's backup, the
 *   committed state) in objects it owns and overwrites in place. It keeps the
 *   source's key order exactly and remembers the source's objects by index,
 *   so a steady copy is one pass over two arrays. The copy is rebuilt when the
 *   source map, its size or its shape number (bumped by the runtime whenever
 *   it adds or removes transforms) changed.
 * - `MotionSegments` keeps the last completed motion segment of each entity
 *   as numbers and hands out the frozen `MotionSegment` objects only when
 *   asked (once per entity per committed step, the same object until the
 *   next commit, like the frozen map it replaces).
 */
import type { MotionSegment, TransformState } from './types';

function cloneTransform(t: TransformState): TransformState {
  return {
    position: [t.position[0], t.position[1], t.position[2]],
    rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]],
    scale: [t.scale[0], t.scale[1], t.scale[2]],
  };
}

/** Copy `src` into `dst` element by element (both own their arrays). */
function copyTransform(dst: TransformState, src: TransformState): void {
  const dp = dst.position;
  const sp = src.position;
  dp[0] = sp[0];
  dp[1] = sp[1];
  dp[2] = sp[2];
  const dr = dst.rotation;
  const sr = src.rotation;
  dr[0] = sr[0];
  dr[1] = sr[1];
  dr[2] = sr[2];
  dr[3] = sr[3];
  const ds = dst.scale;
  const ss = src.scale;
  ds[0] = ss[0];
  ds[1] = ss[1];
  ds[2] = ss[2];
}

export class TransformMirror {
  /** The copy. Its objects belong to the mirror (others may add or delete keys; the next copy after a shape change rebuilds). */
  readonly map = new Map<string, TransformState>();
  /** Aligned by index, in the source's order: the ids, the source's objects, the mirror's objects. */
  readonly ids: string[] = [];
  readonly src: TransformState[] = [];
  readonly dst: TransformState[] = [];
  /** Bumped at every rebuild (index-aligned caches of others key on it). */
  generation = 0;
  private source: ReadonlyMap<string, TransformState> | null = null;
  private shape = -1;
  private readonly rebuildVisit = (t: TransformState, id: string): void => {
    const copy = cloneTransform(t);
    this.map.set(id, copy);
    this.ids.push(id);
    this.src.push(t);
    this.dst.push(copy);
  };

  /**
   * Make `map` an exact copy of `src` (same keys in the same order, equal
   * values, own objects). `shape` is the source's shape number: while it,
   * the source and its size are unchanged, its keys and objects are too.
   */
  copyFrom(src: ReadonlyMap<string, TransformState>, shape: number): void {
    if (src === this.source && shape === this.shape && src.size === this.src.length) {
      const s = this.src;
      const d = this.dst;
      for (let i = 0; i < s.length; i += 1) copyTransform(d[i]!, s[i]!);
      return;
    }
    this.map.clear();
    this.ids.length = 0;
    this.src.length = 0;
    this.dst.length = 0;
    src.forEach(this.rebuildVisit);
    this.source = src;
    this.shape = shape;
    this.generation += 1;
  }
}

/** Per mirror: the segment arrays of its entries (null: not in the entity order). */
interface SegmentIndex {
  generation: number;
  order: readonly string[] | null;
  data: (number[] | null)[];
}

export class MotionSegments {
  /** Per entity: from.x, from.y, to.x, to.y. */
  private readonly data = new Map<string, number[]>();
  /** The frozen objects handed out since the last commit. */
  private readonly views = new Map<string, Readonly<MotionSegment>>();
  /** The commit each handed-out view belongs to (a view of an older commit is stale; nothing is cleared per step). */
  private readonly viewCommit = new Map<string, number>();
  private commit = 0;
  /** Index-aligned segment arrays per backup mirror (the runtime alternates two). */
  private readonly indexes = new Map<TransformMirror, SegmentIndex>();

  private dataOf(id: string): number[] {
    let d = this.data.get(id);
    if (d === undefined) {
      d = [0, 0, 0, 0];
      this.data.set(id, d);
    }
    return d;
  }

  /**
   * Record the step's segments: for every id of `order` in the mirror, from
   * the mirror's copy (the state before the step) to its source (after it).
   */
  record(order: readonly string[], backup: TransformMirror): void {
    this.commit += 1;
    let index = this.indexes.get(backup);
    if (index === undefined || index.generation !== backup.generation || index.order !== order) {
      const inOrder = new Set(order);
      const data: (number[] | null)[] = [];
      for (const id of backup.ids) data.push(inOrder.has(id) ? this.dataOf(id) : null);
      index = { generation: backup.generation, order, data };
      this.indexes.set(backup, index);
    }
    const data = index.data;
    const before = backup.dst;
    const after = backup.src;
    for (let i = 0; i < data.length; i += 1) {
      const d = data[i];
      if (d === null || d === undefined) continue;
      const b = before[i]!.position;
      const a = after[i]!.position;
      d[0] = b[0];
      d[1] = b[1];
      d[2] = a[0];
      d[3] = a[1];
    }
  }

  /** Set one entity's segment (a reset's zero-motion segment). */
  set(id: string, fromX: number, fromY: number, toX: number, toY: number): void {
    const d = this.dataOf(id);
    d[0] = fromX;
    d[1] = fromY;
    d[2] = toX;
    d[3] = toY;
    this.viewCommit.delete(id);
  }

  delete(id: string): void {
    this.data.delete(id);
    this.views.delete(id);
    this.viewCommit.delete(id);
    // Index-aligned arrays may hold the removed array: rebuild them.
    this.indexes.clear();
  }

  has(id: string): boolean {
    return this.data.has(id);
  }

  /** The raw numbers (from.x, from.y, to.x, to.y) without allocating; undefined when there is none. */
  raw(id: string): number[] | undefined {
    return this.data.get(id);
  }

  /** The frozen segment (the same object until the next commit). */
  get(id: string): Readonly<MotionSegment> | undefined {
    const v = this.views.get(id);
    if (v !== undefined && this.viewCommit.get(id) === this.commit) return v;
    const d = this.data.get(id);
    if (d === undefined) return undefined;
    const seg = Object.freeze({ from: Object.freeze({ x: d[0]!, y: d[1]! }), to: Object.freeze({ x: d[2]!, y: d[3]! }) });
    this.views.set(id, seg);
    this.viewCommit.set(id, this.commit);
    return seg;
  }
}
