/**
 * The edits the voxel world page waits on: each names the chunks its
 * answer changed, and is done once every one of them has landed with its
 * new content and has its new derived results (full results, or the
 * shader data alone when only material or wetness changed).
 */

/** Chunks an edit is waiting on (key → landed with the new content yet), and when each edit's meshes were all swapped. */
export interface PendingEdit {
  readonly waiting: Map<number, boolean>;
  readonly done: (atMs: number, collidersAtMs: number) => void;
  /** When the newest of its chunks' bodies was replaced. */
  collidersAt: number;
}

export class PendingEdits {
  private readonly edits = new Set<PendingEdit>();

  add(p: PendingEdit): void {
    this.edits.add(p);
  }

  /** Forgets an edit; false when it was already done. */
  delete(p: PendingEdit): boolean {
    return this.edits.delete(p);
  }

  /** A chunk's new content landed. */
  loaded(key: number): void {
    for (const p of this.edits) if (p.waiting.has(key)) p.waiting.set(key, true);
  }

  /** A landed chunk has its new results (`collidersAt`: when its bodies were replaced, NaN when they were not touched). */
  settle(key: number, collidersAt: number): void {
    for (const p of [...this.edits]) {
      if (p.waiting.get(key) !== true) continue;
      p.waiting.delete(key);
      if (!Number.isNaN(collidersAt)) p.collidersAt = collidersAt;
      if (p.waiting.size === 0) {
        this.edits.delete(p);
        p.done(performance.now(), p.collidersAt);
      }
    }
  }
}
