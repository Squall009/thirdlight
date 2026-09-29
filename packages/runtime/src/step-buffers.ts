/**
 * Reusable per-step buffers of the fixed-step loop, so a steady
 * step allocates nothing per entity and looks nothing up by id.
 *
 * - `TransformMirror` holds a copy of a transform map (the step's backup, the
 *   committed state) in objects it owns and overwrites in place. It keeps the
 *   source's key order exactly and remembers the source's objects by index,
 *   so a steady copy is one pass over two arrays. The copy is rebuilt when the
 *   source map, its size or its shape number (bumped by the runtime whenever
 *   it adds or removes transforms) changed.
 */
import type { TransformState } from './types';

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
