/**
 * How far a focus may move before a streamer holding only a few chunks (a
 * structure grid's read box) could plan anything differently: the least gap,
 * over the box's chunks and the level nodes over them, between a distance a
 * ring decision compares and the ring it is compared with.
 *
 * Every decision the streamer makes from the focus alone is such a comparison,
 * of a distance that moves no faster than the focus does:
 * - the load ring: a chunk's centre, horizontally against the load and unload
 *   radii and vertically against the load and unload heights; the way to the
 *   lead point widens those by the lead's length;
 * - the level choice (lod-select.ts): a node's horizontal box distance against
 *   the ring that splits it (and the ring plus its hysteresis, once split) and
 *   against the reach a finer level stands in to (and that plus the hysteresis);
 * - the mip rings: a node's horizontal box distance against its level's radius
 *   (where it is derived) and that plus {@link MIP_RING_HYSTERESIS_CELLS}
 *   (where its result is dropped);
 * - where the focus is also a collision focus (the camera's own ground): a
 *   chunk's box gaps, horizontally and vertically, against the collision ring's
 *   add and keep bounds. Only the chunks that hold cells count here: the air
 *   round them collides with nothing, so its body coming a little late or
 *   staying a little long changes nothing.
 * So until the focus has moved this far from where the streamer last planned,
 * an update would make the same choices; what does change without the focus
 * (a read or job ending, an edit) moves the streamer's `activity` instead.
 * The lanes and the queue's distance keys also follow the focus; they order
 * work that is out, they choose none, so they are left as last planned.
 */
import type { ChunkGrid } from './coords';
import type { ChunkBox } from './grid-place';
import { levelNodeDistance, type LevelRings } from './lod-select';
import type { CollisionRingBounds } from './collision-ring';
import { MIP_RING_HYSTERESIS_CELLS, type Focus, type StreamRing } from './stream-ring';

export interface QuietReachInput {
  readonly grid: ChunkGrid;
  /** The chunks the streamer may hold (it reads none past them). */
  readonly extent: ChunkBox;
  readonly focus: Focus;
  /** The lead point the reads look ahead to (the focus itself when still). */
  readonly lead: Focus;
  readonly ring: StreamRing;
  readonly levelRings: LevelRings;
  /** The coarsest level drawn. */
  readonly maxLevel: number;
  /** Each mip level's radius (cells). */
  readonly mipRadii: ReadonlyMap<number, number>;
  /**
   * The chunks that hold cells (absent: the extent), when the extent is larger (a structure grid's margin of air):
   * the level choice and the mip rings are compared for the nodes over them alone. The air round them draws nothing,
   * so its nodes' levels following a little late change nothing drawn; its loads (which the cells' derives wait for)
   * are compared for the whole extent.
   */
  readonly held?: ChunkBox;
  /** The collision ring's bounds where the focus is a collision focus (absent: it is not). */
  readonly collision?: CollisionRingBounds;
}

/** The gap (cells) from `d` to the nearest of `ts`. */
const gapTo = (d: number, ts: readonly number[]): number => {
  let best = Infinity;
  for (const t of ts) best = Math.min(best, Math.abs(d - t));
  return best;
};

/** How far (cells) the focus may move before any ring decision about a chunk of `extent` or a node over it changes (see the file's note). */
export function quietReach(q: QuietReachInput): number {
  const { grid: g, extent: e, focus: f } = q;
  const edge = g.edge;
  const half = edge / 2;
  const r = q.ring;
  const leadLength = Math.hypot(q.lead.x - f.x, q.lead.y - f.y, q.lead.z - f.z);
  const radii = [r.loadRadius, r.unloadRadius];
  const heights = [r.loadHeight, r.unloadHeight];
  let best = Infinity;
  for (let cx = e.min[0]; cx <= e.max[0]; cx++) {
    for (let cz = e.min[2]; cz <= e.max[2]; cz++) {
      const h = Math.hypot(cx * edge + half - f.x, cz * edge + half - f.z);
      best = Math.min(best, gapTo(h, radii) - leadLength);
    }
  }
  for (let cy = e.min[1]; cy <= e.max[1]; cy++) best = Math.min(best, gapTo(Math.abs(cy * edge + half - f.y), heights) - leadLength);
  const lr = q.levelRings;
  const hy = lr.hysteresis;
  const foci = [f];
  const n = q.held ?? e;
  for (let l = 0; l <= q.maxLevel; l++) {
    const ts: number[] = [];
    if (l >= 1) ts.push(lr.radii[l - 1]!, lr.radii[l - 1]! + hy);
    if (l < q.maxLevel) {
      const standIn = lr.radii[l]! + edge * 2 ** (l + 1);
      ts.push(standIn, standIn + hy);
    }
    const mip = q.mipRadii.get(l);
    if (mip !== undefined) ts.push(mip, mip + MIP_RING_HYSTERESIS_CELLS);
    if (ts.length === 0) continue;
    for (let nx = n.min[0] >> l; nx <= n.max[0] >> l; nx++) {
      for (let nz = n.min[2] >> l; nz <= n.max[2] >> l; nz++) best = Math.min(best, gapTo(levelNodeDistance(g, foci, { level: l, nx, ny: 0, nz }), ts));
    }
  }
  const b = q.collision;
  if (b !== undefined) {
    const gap = (v: number, lo: number): number => (v < lo ? lo - v : v > lo + edge ? v - lo - edge : 0);
    const hs = [b.radius, b.keepRadius];
    const vs = [b.height, b.keepHeight];
    for (let cx = n.min[0]; cx <= n.max[0]; cx++) {
      for (let cz = n.min[2]; cz <= n.max[2]; cz++) best = Math.min(best, gapTo(Math.hypot(gap(f.x, cx * edge), gap(f.z, cz * edge)), hs));
    }
    for (let cy = n.min[1]; cy <= n.max[1]; cy++) best = Math.min(best, gapTo(gap(f.y, cy * edge), vs));
  }
  return Math.max(0, best);
}
