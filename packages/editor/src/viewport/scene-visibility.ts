/**
 * Whether the Scene view is seen, and the frames asked for while it is not.
 *
 * Out of sight (the Game view in front, where Play draws) the view draws
 * nothing and does no per-frame work: animated materials and effect previews
 * would otherwise redraw the whole scene every frame behind Play, on the same
 * main thread and GPU as the game. A canvas lent to a preview pane is seen
 * whatever the centre view shows. A frame asked for meanwhile is drawn once
 * the view is seen again (and restarts the animation loops from there).
 */
export class SceneVisibility {
  private hidden = false;
  private lent = false;
  private frameWanted = false;

  /** `draw` asks for a frame; `mark` shows the state (`data-suspended` on the canvas). */
  constructor(
    private readonly draw: () => void,
    private readonly mark: (suspended: boolean) => void,
  ) {}

  setHidden(on: boolean): void {
    this.hidden = on;
    this.changed();
  }

  setLent(on: boolean): void {
    this.lent = on;
    this.changed();
  }

  /** May a frame draw now? When not, it is remembered for when the view is seen. */
  allows(): boolean {
    if (!this.hidden || this.lent) return true;
    this.frameWanted = true;
    return false;
  }

  private changed(): void {
    const suspended = this.hidden && !this.lent;
    this.mark(suspended);
    if (!suspended && this.frameWanted) {
      this.frameWanted = false;
      this.draw();
    }
  }
}
