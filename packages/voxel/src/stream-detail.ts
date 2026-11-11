/**
 * Level 0 held back at speed: what the streamer derives level 0 for while
 * its focus moves faster than {@link STREAM_DETAIL_SPEED} (the read plan
 * holds it, with the ring's widening delay): only the chunks bodies are made
 * of, those within the collision ring's keep bounds of a focus (the stream
 * focus and the level choice's other foci, the characters). The bounds are
 * the collision ring's own (its host sets them), so a body never loses the
 * ground under it to the hold.
 */
import { chunkNearFoci, collisionRingBounds, type CollisionRingBounds } from './collision-ring';
import type { ChunkGrid } from './coords';
import type { Focus } from './stream-ring';

export class StreamDetail {
  /** The collision ring's bounds (cells; default {@link collisionRingBounds}). */
  bounds: CollisionRingBounds = collisionRingBounds();

  constructor(
    private readonly grid: ChunkGrid,
    private readonly plan: { readonly detailHeld: boolean },
    private readonly foci: () => readonly Focus[],
  ) {}

  /** Whether level 0 is held back for the focus's speed now. */
  get held(): boolean {
    return this.plan.detailHeld;
  }

  /** Whether a chunk lies within the collision ring's keep bounds of a focus. */
  collides(cx: number, cy: number, cz: number): boolean {
    return chunkNearFoci(this.grid, this.foci(), cx, cy, cz, this.bounds.keepRadius, this.bounds.keepHeight);
  }

  /** Whether a chunk's level-0 streaming derive goes out now: always, unless held back and outside the collision ring. */
  deriveNow(cx: number, cy: number, cz: number): boolean {
    return !this.held || this.collides(cx, cy, cz);
  }
}
