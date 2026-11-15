/**
 * How each GPU pass on the page is hidden for a measurement, by category
 * (project-model `GPU_PASS_CATEGORIES`): the page's measured GPU time per
 * category (game-host gpu-measure.ts) hides one category for a few frames and
 * reads what the frame saved, so a pass that is not registered here is never
 * measured. A pass registers once, where it is made:
 *
 *   const off = gpuPassHides.register({ category: 'lighting', name: 'surface light', present: () => live, hide: (h) => (hidden = h) });
 *   // … and `off()` when it is disposed.
 *
 * `hide(true)` means the pass draws nothing and dispatches nothing from the
 * next frame on, and `hide(false)` that it draws again as it did: hiding must
 * not change what the pass holds (work it skipped waits, light it computed
 * stays), so the frame returns to the same picture. `present()` says whether
 * the pass has anything to draw or dispatch on this page now (a category with
 * no pass present is reported as absent, not as zero).
 *
 * One registry a page, like the page's profiler: every adapter on it and the
 * voxel worlds' draws register into the same one.
 */
import type { GpuPassCategory } from '@thirdlight/project-model';

export interface GpuPassHide {
  readonly category: GpuPassCategory;
  /** What the pass is, for a reader (`surface light`, `voxel near surfaces`). */
  readonly name: string;
  /** Whether it has anything to draw or dispatch now. */
  present(): boolean;
  hide(hidden: boolean): void;
}

interface Entry {
  readonly pass: GpuPassHide;
  hidden: boolean;
}

export class GpuPassHides {
  private readonly entries = new Set<Entry>();
  private readonly hiddenNow = new Set<GpuPassCategory>();
  /** Passes held hidden by name whatever the categories (a measurement of one of two passes sharing a category). */
  private readonly held = new Set<string>();

  /** A pass joins its category (hidden at once if its category is hidden now, or it is held); the call returned takes it out. */
  register(pass: GpuPassHide): () => void {
    const e: Entry = { pass, hidden: false };
    this.entries.add(e);
    if (this.hiddenNow.has(pass.category) || this.held.has(pass.name)) this.apply(e, true);
    return () => {
      this.entries.delete(e);
    };
  }

  /**
   * Exactly these categories hidden, every other shown. A pass whose hide
   * throws leaves nothing hidden: every pass is shown again before the error
   * goes on, so a failed measurement never leaves the page drawing less.
   */
  set(hidden: Iterable<GpuPassCategory>): void {
    const want = new Set(hidden);
    try {
      for (const e of this.entries) {
        const h = want.has(e.pass.category) || this.held.has(e.pass.name);
        if (e.hidden !== h) this.apply(e, h);
      }
      this.hiddenNow.clear();
      for (const c of want) this.hiddenNow.add(c);
    } catch (err) {
      this.showAll();
      throw err;
    }
  }

  /**
   * These passes (by name) stay hidden from now on whatever the categories, and are not present to a measurement, so a
   * category's reading is the rest of it (two lighting stores on one page, read one at a time); empty: none held.
   */
  hold(names: Iterable<string>): void {
    this.held.clear();
    for (const n of names) this.held.add(n);
    this.set([...this.hiddenNow]);
  }

  /** The passes held now (by name). */
  holding(): string[] {
    return [...this.held];
  }

  /** Every pass shown again but those held (errors of a pass's own show are swallowed: the others still show). */
  showAll(): void {
    this.hiddenNow.clear();
    for (const e of this.entries) {
      if (!e.hidden || this.held.has(e.pass.name)) continue;
      e.hidden = false;
      try {
        e.pass.hide(false);
      } catch {
        /* the rest are shown regardless */
      }
    }
  }

  /** The categories hidden now. */
  hidden(): GpuPassCategory[] {
    return [...this.hiddenNow];
  }

  /** The passes present now, by category (a category with none is left out). */
  present(): Partial<Record<GpuPassCategory, string[]>> {
    const out: Partial<Record<GpuPassCategory, string[]>> = {};
    for (const e of this.entries) {
      if (this.held.has(e.pass.name)) continue;
      let on = false;
      try {
        on = e.pass.present();
      } catch {
        on = false;
      }
      if (on) (out[e.pass.category] ??= []).push(e.pass.name);
    }
    return out;
  }

  private apply(e: Entry, hidden: boolean): void {
    // Marked first: a hide that throws half way is still shown again by `showAll`.
    e.hidden = hidden;
    e.pass.hide(hidden);
  }
}

/** The page's registry. */
export const gpuPassHides = new GpuPassHides();
