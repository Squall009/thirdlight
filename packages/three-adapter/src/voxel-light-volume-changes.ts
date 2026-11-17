/**
 * What draw batches ask of the light volume, waiting for its frame slice: a
 * batch shows many chunks and walk blocks at once (a flight's start takes
 * out a whole ring), and finding what changed in each (a grid's cells, a
 * block's bricks) and marking what that reaches is work in proportion to the
 * batch. At the batch only what cannot wait is done (the block's cells as
 * they were, copied before the walk's table changes); the comparison and the
 * marks run in the volume's slice of later frames, so a large batch is
 * spread over frames. Until then the volume is not settled.
 *
 * A thing changed again before it was looked at keeps its first "before":
 * the comparison then finds everything that changed since the volume last
 * saw it.
 */
export class VolumePendingChanges<V> {
  private readonly pending = new Map<string, V>();

  /** `key` changed from `before` (kept if it is already waiting: the older state is what the volume last saw). */
  add(key: string, before: V): void {
    if (!this.pending.has(key)) this.pending.set(key, before);
  }

  get size(): number {
    return this.pending.size;
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  /** Changes taken in order while `more()` says so (one at least): each handed to `take` and forgotten. */
  drain(more: () => boolean, take: (key: string, before: V) => void): number {
    let n = 0;
    for (const [key, before] of this.pending) {
      if (n > 0 && !more()) break;
      this.pending.delete(key);
      take(key, before);
      n++;
    }
    return n;
  }

  /** A key no longer of interest (its chunk went). */
  delete(key: string): void {
    this.pending.delete(key);
  }

  clear(): void {
    this.pending.clear();
  }
}

/** A brick as a change's marks read and write it: its updates toward settling and its rays' place in their sequence. */
export interface VolumeHistoryBrick {
  updates: number;
  samples: number;
}

/**
 * What a change of light does to a brick's history (the volume's sun, sky, lamps and edits): a brick it reaches starts
 * again from nothing, its rays from the start of their sequence, so once settled it holds what a volume started with
 * the light as it is now holds (nothing of a light that went). While changes keep coming (one within `continueFrames`
 * of the last: a blend of looks, a moving lamp, a brush stroke) a brick keeps half its history instead, so the light
 * follows smoothly, and starts from nothing once the changes have stopped for as long.
 */
export class VolumeHistory<B extends VolumeHistoryBrick> {
  private lastChange = -Infinity;
  private readonly later = new Set<B>();

  constructor(
    private readonly settle: number,
    private readonly continueFrames: number,
    /** A brick marked: it is stale (to be updated). */
    private readonly stale: (b: B) => void,
  ) {}

  /** A change at `frame`: whether it continues the one before. */
  change(frame: number): boolean {
    const continuing = frame - this.lastChange <= this.continueFrames;
    this.lastChange = frame;
    return continuing;
  }

  /** A brick from nothing. */
  restart(b: B): void {
    b.updates = 0;
    b.samples = 0;
    this.later.delete(b);
    this.stale(b);
  }

  /** A brick a change reaches (`continuing`: what {@link change} said). */
  marked(b: B, continuing: boolean): void {
    if (!continuing) {
      this.restart(b);
      return;
    }
    b.updates = Math.min(b.updates, this.settle >> 1);
    this.later.add(b);
    this.stale(b);
  }

  /** Each frame: bricks that kept history through continuing changes start from nothing once the changes stopped. */
  frame(frame: number): void {
    if (this.later.size === 0 || frame - this.lastChange <= this.continueFrames) return;
    for (const b of [...this.later]) this.restart(b);
  }

  /** A brick gone (out of the window). */
  forget(b: B): void {
    this.later.delete(b);
  }

  /** Bricks waiting to start again once the changes stop. */
  get waiting(): number {
    return this.later.size;
  }
}
