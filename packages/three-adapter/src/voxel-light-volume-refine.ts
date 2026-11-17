/**
 * The light volume's bookkeeping beside its update (voxel-light-volume.ts):
 *
 * - **The refining** ({@link VolumeRefiner}): while nothing is stale, or the
 *   stale work leaves room, the update keeps taking settled bricks short of
 *   their history (`VOLUME_HISTORY_UPDATES`), so the light keeps converging
 *   while the view stands still and stops once every brick has had its
 *   history. The fewest updates first, a brick farther from the eye waiting
 *   for more of them and one behind the camera longer, so the view round the
 *   eye converges first and the rest in turn.
 * - **The index's rows** ({@link VolumeIndexRows}): the window's index (a
 *   slot + 1 a brick of every level, wrapped) as the page keeps it, the rows
 *   to upload, and the bricks put in it the frame after their first update
 *   (their slot holds their own light then, not the last brick's of that
 *   slot: readers and the filter's neighbours never read a slot's old light).
 */
import { VOLUME_HISTORY_UPDATES, VOLUME_INDEX_ROWS, VOLUME_INDEX_WIDTH, VOLUME_WINDOW_BRICKS, volumeCellM, volumeLevelIndexTexel } from './voxel-light-volume-layout';

/** A brick as the refining reads it. */
export interface RefineBrick {
  readonly level: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly slot: number;
  readonly updates: number;
}

/**
 * Updates more a brick waits for in the refining's order for each level-0 brick (2 m) it lies from the eye: the view
 * round the eye is refined well ahead (one 8 m off waits for 8 more, one at the window's edge for its whole history).
 */
const REFINE_UPDATES_A_BRICK = 2;
/** Updates more a brick behind the camera waits for. */
const REFINE_BEHIND_UPDATES = 16;
/** Frames' worth of bricks the refining orders at a time. */
const REFINE_LOOKAHEAD = 4;

/** Metres a level-0 brick spans. */
const BRICK_M = volumeCellM(0) * 4;

/** The gap (in level-0 bricks) between the eye's level-0 brick `e` and a brick's span along one axis (0 inside). */
const gap = (lo: number, n: number, v: number): number => (v < lo ? lo - v : v >= lo + n ? v - lo - n + 1 : 0);

/** A brick's distance from the eye's level-0 brick `e`, in level-0 bricks (the largest of the axes' gaps). */
function brickGap(b: RefineBrick, e: readonly number[]): number {
  const n = 1 << b.level;
  return Math.max(gap(b.bx * n, n, e[0]!), gap(b.by * n, n, e[1]!), gap(b.bz * n, n, e[2]!));
}

/** Bricks with a slot by distance from the eye (buckets of {@link brickGap}, to the level-0 window's reach). */
export function volumeNearestFirst<B extends RefineBrick>(bricks: Iterable<B>, eye: readonly number[]): B[][] {
  const e = eye.map((v) => Math.floor(v / BRICK_M));
  const reach = Math.max(...VOLUME_WINDOW_BRICKS);
  const buckets: B[][] = Array.from({ length: reach + 1 }, () => []);
  for (const b of bricks) if (b.slot >= 0) buckets[Math.min(reach, brickGap(b, e))]!.push(b);
  return buckets;
}

/** Which settled bricks the update refines next, and whether every one is refined. */
export class VolumeRefiner<B extends RefineBrick> {
  /** Bricks made stale so far (a count: whether anything changed since the refining last ran out). */
  private changes = 0;
  private refinedAt = -1;
  private queue: B[] = [];
  private at = 0;
  /** Frames' worth of the idle share saved toward a dispatch of its own. */
  private saved = 0;

  /** A brick was made stale (nothing is refined while it waits; the refining starts again after). */
  changed(): void {
    this.changes++;
  }

  /** Every brick has had its history since the last change. */
  get refined(): boolean {
    return this.refinedAt === this.changes;
  }

  /**
   * Whether this frame's update, with nothing stale, refines (call once a frame): a dispatch of the live light's size on
   * a share of the frames (`idleShare` of the live light's), so the update's own ms a brick are read from dispatches of
   * one size (a small one a frame would hold the pass's fixed cost a dispatch over few bricks, and the pacing would cut
   * the stale work that follows).
   */
  idleFrame(idleShare: number): boolean {
    this.saved = Math.min(1, this.saved + idleShare);
    if (this.refined || this.saved < 1) return false;
    this.saved -= 1;
    return true;
  }

  /** Bricks ordered and not taken yet. */
  get ordered(): number {
    return this.queue.length - this.at;
  }

  /**
   * Up to `count` bricks to refine into `list`: of `bricks`, those `idle` says may be (settled, with a slot, short of
   * their history), in the refining's order round `eye` looking along `forward`. Finding none left records that every
   * brick is refined.
   */
  take(bricks: () => Iterable<B>, idle: (b: B) => boolean, eye: readonly number[], forward: readonly number[], count: number, list: B[]): void {
    if (this.refined) return;
    let left = count;
    // A brick once a call: the order made again partway may hold one the last order gave this call.
    const taken = new Set<B>();
    for (let pass = 0; pass < 2 && left > 0; pass++) {
      while (this.at < this.queue.length && left > 0) {
        const b = this.queue[this.at++]!;
        if (!idle(b) || taken.has(b)) continue;
        taken.add(b);
        list.push(b);
        left--;
      }
      if (left === 0) return;
      this.queue = this.order(bricks(), idle, eye, forward, REFINE_LOOKAHEAD * count);
      this.at = 0;
      if (this.queue.length === 0) {
        this.refinedAt = this.changes;
        return;
      }
    }
  }

  /** Up to `want` bricks in order: by their updates, plus {@link REFINE_UPDATES_A_BRICK} for every level-0 brick from the eye, plus {@link REFINE_BEHIND_UPDATES} behind the camera. */
  private order(bricks: Iterable<B>, idle: (b: B) => boolean, eye: readonly number[], fw: readonly number[], want: number): B[] {
    const e = eye.map((v) => Math.floor(v / BRICK_M));
    const buckets: B[][] = [];
    for (const b of bricks) {
      if (!idle(b)) continue;
      const n = 1 << b.level;
      // Behind: its centre more than its own size behind the eye along the view.
      const behind = ((b.bx + 0.5) * n - e[0]! - 0.5) * fw[0]! + ((b.by + 0.5) * n - e[1]! - 0.5) * fw[1]! + ((b.bz + 0.5) * n - e[2]! - 0.5) * fw[2]! < -n;
      const key = Math.min(b.updates, VOLUME_HISTORY_UPDATES) + REFINE_UPDATES_A_BRICK * brickGap(b, e) + (behind ? REFINE_BEHIND_UPDATES : 0);
      (buckets[key] ??= []).push(b);
    }
    const out: B[] = [];
    for (const bucket of buckets) {
      if (bucket === undefined) continue;
      for (const b of bucket) {
        out.push(b);
        if (out.length >= want) return out;
      }
    }
    return out;
  }
}

/** A brick as the index reads it. */
export interface IndexBrick {
  readonly level: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly slot: number;
  published: boolean;
}

/** The window's index on the page: a word a brick of every level (its slot + 1, or 0), and its rows to upload. */
export class VolumeIndexRows<B extends IndexBrick> {
  readonly words = new Uint32Array(VOLUME_INDEX_WIDTH * VOLUME_INDEX_ROWS);
  private readonly dirty = new Set<number>();
  /** Bricks updated for the first time, put in the index at the next {@link publish}. */
  private readonly fresh = new Set<B>();

  /** A brick's word in the index (every level's window, wrapped, stacked by rows). */
  place(level: number, bx: number, by: number, bz: number): number {
    const [x, y] = volumeLevelIndexTexel(level, bx, by, bz);
    return y * VOLUME_INDEX_WIDTH + x;
  }

  /** A brick's entry set (its slot + 1, or 0) and its row marked for upload. */
  set(b: B, value: number): void {
    const i = this.place(b.level, b.bx, b.by, b.bz);
    this.words[i] = value;
    this.dirty.add(Math.floor(i / VOLUME_INDEX_WIDTH));
  }

  /** A brick's first update was dispatched: it goes into the index next frame. */
  firstUpdate(b: B): void {
    if (!b.published) this.fresh.add(b);
  }

  /** A brick left its window (an entry it has is cleared by the caller). */
  forget(b: B): void {
    this.fresh.delete(b);
  }

  /** The bricks updated for the first time since the last call go into the index. */
  publish(): void {
    for (const b of this.fresh) {
      if (b.slot < 0 || b.published) continue;
      b.published = true;
      this.set(b, b.slot + 1);
    }
    this.fresh.clear();
  }

  /** The rows changed, handed to `write` and forgotten. */
  flush(write: (words: Uint32Array, rows: ReadonlySet<number>) => void): void {
    if (this.dirty.size === 0) return;
    write(this.words, this.dirty);
    this.dirty.clear();
  }
}
