/**
 * Draws made before they are first drawn have their programs built ahead,
 * by the page's precompile, instead of in the frame that first draws them.
 *
 * A view that makes draws it keeps hidden until the camera reaches them (a
 * ground cover ring, a far level of stored copies) hands them here as they
 * are made. Here they are shown for the precompile (`hold`: drawn with
 * nothing in them, as they would draw; the precompile compiles what the
 * frame would draw, and a hidden draw is not drawn), a precompile is asked
 * for, and once it has run they go back to what their view says (`release`).
 * The precompile holds the present while it runs, so a held draw is never
 * presented. Each frame the views write their draws' state anew, so a held
 * draw is held again after them, until its precompile has run.
 *
 * Draws are made when a scene loads, so their programs are built with the
 * scene's own (the start's precompile); one made later (a grown texture
 * page, a streamed set with a level no copy draws at yet) costs a held
 * present instead of a frame building its program. Only draws that need it
 * ask for one: a precompile holds the present, so one asked for every set a
 * streamed world makes would keep the page from presenting.
 */

/** A draw (or a view's set of them) whose programs are built ahead. */
export interface WarmDraw {
  /**
   * Whether it still has programs to build ahead, asked once, in the frame after it was handed over (its view has
   * written it once): one that draws already built its programs in that frame; one whose programs another draw
   * already built (three shares a program between draws of one material and layout) needs none.
   */
  wanted(): boolean;
  /** Shown for the precompile, drawing nothing (called again every frame until it has run). */
  hold(): void;
  /** Its programs are built: back to what its view says. */
  release(): void;
  /** False: let go (its view dropped it); it is neither held nor released again. */
  alive(): boolean;
}

export interface ProgramWarmerDeps {
  /** No precompile wanted or running. */
  idle(): boolean;
  /** Ask for a precompile of the scene before the next present. */
  want(): void;
}

export interface ProgramWarmerStats {
  /** Draws whose programs were built ahead, and those waiting for a precompile. */
  warmed: number;
  waiting: number;
}

export class ProgramWarmer {
  /** Handed over since the last frame. */
  private fresh: WarmDraw[] = [];
  /** Held for a precompile that has not run yet. */
  private held: WarmDraw[] = [];
  private warmed = 0;

  constructor(private readonly deps: ProgramWarmerDeps) {}

  /** A draw made hidden: its programs are built ahead of its first draw. */
  add(d: WarmDraw): void {
    this.fresh.push(d);
  }

  /**
   * After the views wrote their draws for this frame, before the precompile
   * gate is asked whether the frame is presented.
   */
  frame(): void {
    if (this.held.length === 0 && this.fresh.length === 0) return;
    if (this.held.length > 0 && this.deps.idle()) {
      // The precompile asked for has run (with them held): this frame draws them as their views say.
      for (const d of this.held) {
        if (!d.alive()) continue;
        d.release();
        this.warmed += 1;
      }
      this.held = [];
    }
    if (this.fresh.length > 0) {
      let added = false;
      for (const d of this.fresh) {
        if (!d.alive() || !d.wanted()) continue;
        this.held.push(d);
        added = true;
      }
      this.fresh = [];
      // A precompile holds the present while it runs: asked for only when something needs it.
      if (added) this.deps.want();
    }
    this.held = this.held.filter((d) => d.alive());
    for (const d of this.held) d.hold();
  }

  stats(): ProgramWarmerStats {
    return { warmed: this.warmed, waiting: this.held.length + this.fresh.length };
  }
}
