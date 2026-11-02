/**
 * The edits the voxel world page waits on: each is an edit group of the
 * streamer (a local edit, or a refresh after the backend applied a
 * command), done once the group's rebuilt sections were swapped in, all
 * in one go (the streamer's `swap` event names every group it closes).
 */
import type { SwapReport } from '@thirdlight/voxel';

/** When a swap happened: performance.now(), the frames drawn before it, and its report. */
export interface SwapSeen {
  readonly at: number;
  readonly frame: number;
  readonly report: SwapReport;
  /** Main-thread ms the page spent replacing the swapped sections' meshes and colliders. */
  readonly buildMs: number;
}

export class PendingEdits {
  private readonly waiting = new Map<number, (s: SwapSeen) => void>();

  /** Resolves with the swap that closes `group`, or null after `timeoutMs` (a chunk whose new content never lands). */
  wait(group: number, timeoutMs: number): Promise<SwapSeen | null> {
    return new Promise((done) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(group)) done(null);
      }, timeoutMs);
      this.waiting.set(group, (s) => {
        clearTimeout(timer);
        done(s);
      });
    });
  }

  /** A swap closed these groups. */
  swapped(s: SwapSeen): void {
    for (const g of s.report.groups) {
      const done = this.waiting.get(g);
      if (done === undefined) continue;
      this.waiting.delete(g);
      done(s);
    }
  }
}
