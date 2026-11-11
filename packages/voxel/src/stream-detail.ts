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
  constructor(private readonly plan: { readonly detailHeld: boolean; readonly detailFast: boolean }) {}

  /** Whether the levels drawn leave level 0 out for the focus's speed now (set at once, cleared after the delay). */
  get held(): boolean {
    return this.plan.detailHeld;
  }

  /** Whether the focus is faster than {@link STREAM_DETAIL_SPEED} now. */
  get fast(): boolean {
    return this.plan.detailFast;
  }

  /** Whether streaming level-0 derives go out now: not while the focus is fast. */
  deriveNow(): boolean {
    return !this.plan.detailFast;
  }
}
