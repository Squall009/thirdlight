/**
 * Level 0 held back at speed. While the streamer's focus moves faster than
 * {@link STREAM_DETAIL_SPEED} no streaming level-0 derive goes out (and those
 * waiting in the pool are cancelled): what is built is left behind within a
 * second. The levels drawn leave level 0 out until the speed has stayed under
 * it for the ring's widening delay (`held`), but derives resume as soon as
 * the focus is slow again (`fast` cleared), nearest it first, so a stopped
 * focus's ground does not wait for the delay. Bodies keep their ground at
 * speed through the collision-only derives round them (stream-collision.ts);
 * an edit's rebuilds always go.
 */
export class StreamDetail {
  /** Near only (fine far bricks past the detail ring): where level 0 may be drawn; null: everywhere. */
  private reach: ((cx: number, cy: number, cz: number) => boolean) | null = null;

  constructor(private readonly plan: { readonly detailHeld: boolean; readonly detailFast: boolean }) {}

  /** Near only (`reach`: where level 0 may be drawn, round the foci), or every ring drawn (null). */
  setReach(reach: ((cx: number, cy: number, cz: number) => boolean) | null): void {
    this.reach = reach;
  }

  /** Whether only the level-0 ring is drawn (fine far bricks past it). */
  get nearOnly(): boolean {
    return this.reach !== null;
  }

  /** Whether the levels drawn leave level 0 out for the focus's speed now (set at once, cleared after the delay). */
  get held(): boolean {
    return this.plan.detailHeld;
  }

  /** Whether the focus is faster than {@link STREAM_DETAIL_SPEED} now. */
  get fast(): boolean {
    return this.plan.detailFast;
  }

  /**
   * Whether streaming level-0 derives go out now (for a chunk, when given): not while the focus is fast, and near only
   * not past where level 0 may be drawn (nothing else reads a level-0 derive there: a body's ground has its own path).
   */
  deriveNow(cx?: number, cy?: number, cz?: number): boolean {
    if (this.plan.detailFast) return false;
    return this.reach === null || cx === undefined || this.reach(cx, cy!, cz!);
  }
}
