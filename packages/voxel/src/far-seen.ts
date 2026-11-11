/**
 * What the far field's draws were seen at: visibility feedback from where
 * the far field is drawn, in rounds a frame or two old, for the selection
 * to spend its work and memory where the eye looks.
 *
 * - **A round** ({@link FarSeenWire}) is one drawn frame reduced on the GPU:
 *   each far node any of whose pixels showed, with its pixels and the
 *   nearest view depth a pixel of it was hit at. It comes late and never
 *   holds a frame; a round older than one already taken is stale and
 *   dropped (rounds are counted where they are made).
 * - **Seen** is remembered per node ({@link FarSeenLog}): the node's own
 *   last sighting, and for each ancestor the last sighting of anything
 *   under it. A node is seen lately when it, a node under it, or a node
 *   drawn over it (its stand-in) was seen within the turn window.
 * - **Unseen** is a node the eye has not met for a whole turn window while
 *   the rounds kept coming: behind the camera, under the ground, behind a
 *   ridge. Before the first window has passed nothing is unseen, so a far
 *   field without rounds (WebGL 2, a pass without the visibility target)
 *   selects by screen error alone, as before. Unseen refinements wait behind
 *   seen ones; unseen nodes are released (drawn coarser) only once the far
 *   field nears its GPU budget ({@link FAR_SEEN_RELEASE_SHARE}).
 */
import { farCellPixels } from './far-tree';
import { mipNodeKey, type MipNode } from './voxel-mips';

/**
 * ms a node keeps its detail after it was last seen: a look round (behind and back) comes within it and finds the
 * detail it left. Past it the node is drawn as if its error were {@link FAR_UNSEEN_ERROR_SCALE} of what it is.
 */
export const FAR_SEEN_TURN_MS = 6000;

/**
 * The share of its error an unseen node is selected by: a quarter, so it stands two levels coarser than a seen node
 * at its distance (a level halves the error). Not nothing, so a turn shows a coarser field, never a hole, and the
 * top levels are drawn whatever is seen.
 */
export const FAR_UNSEEN_ERROR_SCALE = 0.25;

/**
 * Times a node may come back into view within {@link FAR_SEEN_RETURN_WINDOWS} turn windows before it is held seen for
 * {@link FAR_SEEN_HOLD_WINDOWS}: a coarse stand-in whose surface stands above the finer one (a ridge, a bulge over
 * the skyline) is seen drawn coarse, hidden drawn fine, so it would be refined and released by turns for as long as
 * the eye stays.
 */
export const FAR_SEEN_RETURNS = 2;
export const FAR_SEEN_RETURN_WINDOWS = 4;
export const FAR_SEEN_HOLD_WINDOWS = 10;

/**
 * The share of its GPU budget the far field's drawn and made nodes reach before unseen nodes are released (drawn by
 * {@link FAR_UNSEEN_ERROR_SCALE} of their error). Below it what is unseen only waits behind what is seen: released at
 * any fill, a still camera's field never settled (a node drawn coarser is seen, refined, hidden again; measured: tens
 * of thousands of jobs where a few hundred nodes are drawn), so memory is spent on detail while it is there.
 */
export const FAR_SEEN_RELEASE_SHARE = 0.9;

/** ms between selections a change in what is seen may start (the eye's moves start them as before). */
export const FAR_SEEN_RESELECT_MS = 400;

/** Numbers a seen node takes in {@link FarSeenWire.nodes}: level, nx, ny, nz, pixels, nearest view depth (cells). */
export const FAR_SEEN_STRIDE = 6;

/** One round of visibility feedback, as the draws send it to the far field. */
export interface FarSeenWire {
  /** The round's number where it was made: rounds count up; one not past the last taken is stale. */
  readonly round: number;
  /** The last far event (its `seq`) the draws had applied when the round's frame was drawn. */
  readonly farSeq: number;
  /** The nodes seen, {@link FAR_SEEN_STRIDE} numbers each. */
  readonly nodes: readonly number[];
}

interface Sighting {
  at: number;
  pixels: number;
  /** Nearest view depth a pixel of it was hit at (cells). */
  nearest: number;
}

/** Sightings older than this many turn windows are forgotten (each prune walks them once). */
const FORGET_WINDOWS = 4;

/** What the far field's draws reported seen, by node and by the nodes over it. */
export class FarSeenLog {
  private readonly own = new Map<string, Sighting>();
  /** Latest sighting of anything under a node (its own excluded). */
  private readonly under = new Map<string, number>();
  /** Nodes seen again after a turn window unseen: how often since when; and the nodes held seen, until when. */
  private readonly returns = new Map<string, { n: number; since: number }>();
  private readonly held = new Map<string, number>();
  private lastRound = -Infinity;
  private lastFarSeq = -Infinity;
  private startedAt: number | null = null;
  private prunedAt = -Infinity;
  readonly counters = { rounds: 0, stale: 0, nodes: 0, pixels: 0, behind: 0, held: 0 };
  /**
   * The near field's load cylinder round the eye (cells; `edge` the chunk edge): a node wholly inside it is never
   * unseen. The near field draws there and the far view leaves such nodes out, so they are never seen; drawn coarser
   * they would reach out of the cylinder, be seen, refine and vanish again, round and round.
   */
  near: { readonly eye: readonly [number, number, number]; readonly radius: number; readonly height: number; readonly edge: number } | null = null;
  /** When the far field's selection under way started (what it takes as unseen is judged then). */
  selectingAt = 0;
  /** The wanted nodes the last selection took as unseen: a round that changes one of them selects again. */
  selectedUnseen = new Set<string>();
  /** When a round last started a selection (at most every {@link FAR_SEEN_RESELECT_MS}). */
  reselectedAt = -Infinity;

  constructor(
    /** {@link FAR_SEEN_TURN_MS}. */
    readonly turnMs = FAR_SEEN_TURN_MS,
    /** The far tree's top level: sightings are carried up to it. */
    private readonly topLevel = 30,
  ) {
    if (!(turnMs > 0)) throw new RangeError(`far seen: turn window ${turnMs} ms`);
  }

  /** Whether rounds have come for a whole turn window (before, nothing is unseen). */
  running(now: number): boolean {
    return this.startedAt !== null && now - this.startedAt >= this.turnMs;
  }

  /**
   * Takes a round seen at `now` (ms, this side's clock); false when it is stale (not newer than one taken). `farSeq`
   * is the last far event made here: how far behind the round's frame was is counted.
   */
  apply(fb: FarSeenWire, now: number, farSeq = fb.farSeq): boolean {
    if (!(fb.round > this.lastRound) || fb.farSeq < this.lastFarSeq || fb.nodes.length % FAR_SEEN_STRIDE !== 0) {
      this.counters.stale++;
      return false;
    }
    this.lastRound = fb.round;
    this.lastFarSeq = fb.farSeq;
    this.startedAt ??= now;
    this.counters.rounds++;
    this.counters.behind = Math.max(0, farSeq - fb.farSeq);
    let pixels = 0;
    const s = fb.nodes;
    for (let i = 0; i < s.length; i += FAR_SEEN_STRIDE) {
      const n: MipNode = { level: s[i]!, nx: s[i + 1]!, ny: s[i + 2]!, nz: s[i + 3]! };
      const key = mipNodeKey(n);
      const was = this.own.get(key);
      if (was !== undefined && now - was.at > this.turnMs) this.cameBack(key, now);
      this.own.set(key, { at: now, pixels: s[i + 4]!, nearest: s[i + 5]! });
      pixels += s[i + 4]!;
      for (let l = n.level + 1; l <= this.topLevel; l++) {
        const d = l - n.level;
        const k = mipNodeKey({ level: l, nx: n.nx >> d, ny: n.ny >> d, nz: n.nz >> d });
        if (this.under.get(k) === now) break;
        this.under.set(k, now);
      }
    }
    this.counters.nodes = s.length / FAR_SEEN_STRIDE;
    this.counters.pixels = pixels;
    if (now - this.prunedAt >= this.turnMs) this.prune(now);
    return true;
  }

  /** A node seen again after a turn window unseen; held seen once that happens too often. */
  private cameBack(key: string, now: number): void {
    const r = this.returns.get(key);
    if (r === undefined || now - r.since > FAR_SEEN_RETURN_WINDOWS * this.turnMs) {
      this.returns.set(key, { n: 1, since: now });
      return;
    }
    if (++r.n < FAR_SEEN_RETURNS) return;
    this.returns.delete(key);
    this.held.set(key, now + FAR_SEEN_HOLD_WINDOWS * this.turnMs);
    this.counters.held++;
  }

  /** Whether a node lies wholly inside the near field's load cylinder. */
  private insideNear(n: MipNode): boolean {
    const r = this.near;
    if (r === null) return false;
    const s = r.edge << n.level;
    const [ex, ey, ez] = r.eye;
    if (n.ny * s < ey - r.height || (n.ny + 1) * s > ey + r.height) return false;
    const dx = Math.max(Math.abs(n.nx * s - ex), Math.abs((n.nx + 1) * s - ex));
    const dz = Math.max(Math.abs(n.nz * s - ez), Math.abs((n.nz + 1) * s - ez));
    return dx * dx + dz * dz <= r.radius * r.radius;
  }

  /** Whether a node or a node over it is held seen. */
  private isHeld(n: MipNode, now: number): boolean {
    if (this.held.size === 0) return false;
    for (let l = n.level; l <= this.topLevel; l++) {
      const d = l - n.level;
      const until = this.held.get(mipNodeKey({ level: l, nx: n.nx >> d, ny: n.ny >> d, nz: n.nz >> d }));
      if (until !== undefined && until > now) return true;
    }
    return false;
  }

  /** When a node, a node under it or a node over it was last seen (null: never). */
  seenAt(n: MipNode): number | null {
    const key = mipNodeKey(n);
    let t = Math.max(this.own.get(key)?.at ?? -Infinity, this.under.get(key) ?? -Infinity);
    for (let l = n.level + 1; l <= this.topLevel; l++) {
      const d = l - n.level;
      const o = this.own.get(mipNodeKey({ level: l, nx: n.nx >> d, ny: n.ny >> d, nz: n.nz >> d }));
      if (o !== undefined && o.at > t) t = o.at;
    }
    return Number.isFinite(t) ? t : null;
  }

  /** Whether the eye has not met a node for a whole turn window while rounds kept coming. */
  unseen(n: MipNode, now: number): boolean {
    if (!this.running(now) || this.isHeld(n, now) || this.insideNear(n)) return false;
    const t = this.seenAt(n);
    return t === null || now - t > this.turnMs;
  }

  /**
   * The error a drawn node was last seen at (pixels: its cell at the nearest depth a pixel of it showed), within the
   * turn window; null when it was not seen itself lately.
   */
  seenError(n: MipNode, now: number, pixelsPerRadian: number): number | null {
    const o = this.own.get(mipNodeKey(n));
    if (o === undefined || now - o.at > this.turnMs) return null;
    return farCellPixels(n.level, o.nearest, pixelsPerRadian);
  }

  /** Pixels a node showed in the last round it was seen in (0: never seen). */
  pixelsOf(n: MipNode): number {
    return this.own.get(mipNodeKey(n))?.pixels ?? 0;
  }

  private prune(now: number): void {
    this.prunedAt = now;
    const old = now - FORGET_WINDOWS * this.turnMs;
    for (const [k, o] of this.own) if (o.at < old) this.own.delete(k);
    for (const [k, t] of this.under) if (t < old) this.under.delete(k);
    for (const [k, t] of this.held) if (t <= now) this.held.delete(k);
    for (const [k, r] of this.returns) if (now - r.since > FAR_SEEN_RETURN_WINDOWS * this.turnMs) this.returns.delete(k);
  }
}
