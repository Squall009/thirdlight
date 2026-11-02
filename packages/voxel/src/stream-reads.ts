/**
 * The order the streamer reads chunks in, shaped for sources where every
 * request costs a round trip (HTTP range reads behind real latency):
 *
 * - **Whole columns.** Region files store a chunk column as one byte range
 *   and the columns of a region row next to each other, so the read list
 *   keeps a column's chunks together (nearest column first, then outward
 *   from the focus height inside it). A batch then asks for whole columns
 *   and the source joins them into a few ranges, instead of one request per
 *   one or two chunks taken shell by shell.
 * - **Prefetch along the motion.** The focus's velocity, smoothed over a
 *   fraction of a second, puts a lead point about a second ahead; chunks
 *   are wanted around the focus and around the lead point, read nearest the
 *   lead point first, and kept while either still holds them. A moving
 *   camera then finds the ground ahead already read. A jump (a teleport, a
 *   respawn, a test moving the focus) is not motion: it resets the velocity.
 */
import { chunkKeyOrNone, type ChunkGrid } from './coords';
import { chunkDistance2, pastUnloadRing, type Focus, type StreamRing } from './stream-ring';

/** How far ahead of the focus's motion chunks are read (seconds of travel). */
export const STREAM_PREFETCH_SECONDS = 1;

/** Source reads in flight at once: enough batches to keep a browser's six connections a host busy behind latency. */
export const DEFAULT_STREAM_READS = 8;

/** Seconds over which the focus's velocity is smoothed (a frame's jitter is not a direction). */
const VELOCITY_SMOOTH_S = 0.25;
/** A focus that has not moved for this long has no velocity. */
const STILL_AFTER_MS = 500;

/** One chunk the streamer wants, with its squared distance to the focus (the budget's horizon key). */
export interface WantedChunk {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly d2: number;
  /** Column id inside the list: equal for the chunks of one (cx, cz) column, which sit next to each other. */
  readonly column: number;
}

/**
 * The focus's motion, for prefetch. `move` is called with each new focus
 * (cells) and the time; `lead` is where the focus will be `seconds` later,
 * capped at `maxCells` from it.
 */
export class FocusMotion {
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private last: Focus | null = null;
  private lastAt = 0;
  private movedAt = 0;

  /**
   * `maxJump` (cells): a step longer than this, or faster than `maxSpeed`
   * cells a second, is a jump and resets the velocity.
   */
  constructor(
    private readonly maxJump: number,
    private readonly maxSpeed: number,
  ) {}

  move(f: Focus, now: number): void {
    const p = this.last;
    this.last = f;
    const dt = (now - this.lastAt) / 1000;
    this.lastAt = now;
    if (p === null) return;
    const dx = f.x - p.x;
    const dy = f.y - p.y;
    const dz = f.z - p.z;
    if (dx === 0 && dy === 0 && dz === 0) return;
    const dist = Math.hypot(dx, dy, dz);
    if (!(dt > 0) || dist > this.maxJump || dist / dt > this.maxSpeed) {
      this.vx = this.vy = this.vz = 0;
      this.movedAt = 0;
      return;
    }
    const k = Math.min(1, dt / VELOCITY_SMOOTH_S);
    this.vx += (dx / dt - this.vx) * k;
    this.vy += (dy / dt - this.vy) * k;
    this.vz += (dz / dt - this.vz) * k;
    this.movedAt = now;
  }

  /** The lead point (the focus itself when still or prefetch is off). */
  lead(f: Focus, now: number, seconds: number, maxCells: number): Focus {
    if (!(seconds > 0) || this.movedAt === 0 || now - this.movedAt > STILL_AFTER_MS) return f;
    let lx = this.vx * seconds;
    let ly = this.vy * seconds;
    let lz = this.vz * seconds;
    const len = Math.hypot(lx, ly, lz);
    if (len > maxCells) {
      const s = maxCells / len;
      lx *= s;
      ly *= s;
      lz *= s;
    }
    return { x: f.x + lx, y: f.y + ly, z: f.z + lz };
  }
}

/**
 * Every chunk inside the load bounds of the focus or of the lead point, in
 * read order: columns by horizontal distance to the lead point, a column's
 * chunks together, nearest the lead point's height first. Built column by
 * column (a few hundred columns sorted, not the ring's thousands of chunks),
 * since it is rebuilt each time the focus or the lead point crosses a chunk.
 */
export function readOrder(grid: ChunkGrid, ring: StreamRing, focus: Focus, lead: Focus): WantedChunk[] {
  const e = grid.edge;
  const h = e / 2;
  const r2 = ring.loadRadius * ring.loadRadius;
  // Chunk rows whose centre is within the load height of a point.
  const rows = (y: number): [number, number] => [Math.max(grid.chunkMinY, Math.ceil((y - ring.loadHeight - h) / e)), Math.min(grid.chunkMinY + grid.chunkSpanY - 1, Math.floor((y + ring.loadHeight - h) / e))];
  const [fy0, fy1] = rows(focus.y);
  const [ly0, ly1] = rows(lead.y);
  const x0 = Math.max(grid.chunkMinXZ, Math.floor((Math.min(focus.x, lead.x) - ring.loadRadius) / e));
  const x1 = Math.min(grid.chunkMinXZ + grid.chunkSpanXZ - 1, Math.floor((Math.max(focus.x, lead.x) + ring.loadRadius) / e));
  const z0 = Math.max(grid.chunkMinXZ, Math.floor((Math.min(focus.z, lead.z) - ring.loadRadius) / e));
  const z1 = Math.min(grid.chunkMinXZ + grid.chunkSpanXZ - 1, Math.floor((Math.max(focus.z, lead.z) + ring.loadRadius) / e));
  const cols: Array<{ cx: number; cz: number; h2: number; inFocus: boolean; inLead: boolean }> = [];
  for (let cx = x0; cx <= x1; cx++) {
    const px = (cx << grid.shift) + h;
    for (let cz = z0; cz <= z1; cz++) {
      const pz = (cz << grid.shift) + h;
      const inFocus = (px - focus.x) ** 2 + (pz - focus.z) ** 2 <= r2;
      const lh2 = (px - lead.x) ** 2 + (pz - lead.z) ** 2;
      const inLead = lead !== focus && lh2 <= r2;
      if (inFocus || inLead) cols.push({ cx, cz, h2: lh2, inFocus, inLead });
    }
  }
  cols.sort((a, b) => a.h2 - b.h2);
  const out: WantedChunk[] = [];
  const cys: number[] = [];
  cols.forEach((col, column) => {
    cys.length = 0;
    for (let cy = Math.min(fy0, ly0); cy <= Math.max(fy1, ly1); cy++) if ((col.inFocus && cy >= fy0 && cy <= fy1) || (col.inLead && cy >= ly0 && cy <= ly1)) cys.push(cy);
    cys.sort((a, b) => Math.abs((a << grid.shift) + h - lead.y) - Math.abs((b << grid.shift) + h - lead.y));
    for (const cy of cys) out.push({ cx: col.cx, cy, cz: col.cz, d2: chunkDistance2(grid, focus, col.cx, cy, col.cz), column });
  });
  return out;
}

/**
 * A streamer's read planning state: the focus's motion and lead point, the
 * chunks of both (so the read list is rebuilt only when either crosses a
 * chunk), and the stored chunks read but waiting for room in the pool.
 */
export class StreamReadPlan<Held> {
  /** Where the focus is heading (the focus itself when still): the ring is kept around both. */
  lead: Focus = { x: 0, y: 0, z: 0 };
  /** Stored chunks read and waiting for room in the pool, oldest first. */
  readonly held: Held[] = [];
  private readonly motion: FocusMotion;
  private focusChunk = Number.NaN;
  private leadChunk = Number.NaN;

  constructor(
    private readonly grid: ChunkGrid,
    private readonly ring: StreamRing,
    private readonly prefetchSeconds: number,
  ) {
    // A step past the near radius, or faster than that a frame at 60 Hz, is a jump, not motion.
    this.motion = new FocusMotion(ring.nearRadius, ring.nearRadius * 60);
  }

  moved(focus: Focus, now: number): void {
    this.motion.move(focus, now);
  }

  /** Sets the lead point for this update; true when the focus or the lead point entered another chunk. */
  update(focus: Focus, now: number): boolean {
    const g = this.grid;
    const chunkOf = (p: Focus): number => chunkKeyOrNone(g, Math.floor(p.x) >> g.shift, Math.floor(p.y) >> g.shift, Math.floor(p.z) >> g.shift);
    const fk = chunkOf(focus);
    const lead = this.motion.lead(focus, now, this.prefetchSeconds, this.ring.nearRadius);
    const lk = lead === focus ? fk : chunkOf(lead);
    // A lead point outside the world leads nowhere.
    this.lead = lk < 0 ? focus : lead;
    if (fk === this.focusChunk && lk === this.leadChunk) return false;
    this.focusChunk = fk;
    this.leadChunk = lk;
    return true;
  }

  /** Past the unload bounds of the focus and of the lead point. */
  pastUnload(focus: Focus, cx: number, cy: number, cz: number): boolean {
    return pastUnloadRing(this.grid, this.ring, focus, cx, cy, cz) && (this.lead === focus || pastUnloadRing(this.grid, this.ring, this.lead, cx, cy, cz));
  }

  /**
   * The chunks next to a batch's columns along a source's row axis, as far
   * as the ring's hysteresis reaches (a chunk kept there stays until the
   * focus leaves), within the unload bounds: the source reads a run of
   * neighbouring columns in one request, so ground the ring is about to
   * reach comes with the column wanted now instead of one request a column
   * later.
   */
  *rowNeighbours(focus: Focus, axis: 'x' | 'z', batch: readonly { cx: number; cy: number; cz: number }[]): IterableIterator<{ cx: number; cy: number; cz: number }> {
    const reach = Math.floor((this.ring.unloadRadius - this.ring.loadRadius) / this.grid.edge);
    if (reach <= 0) return;
    const columns = new Map<number, { cx: number; cz: number; cys: number[] }>();
    for (const c of batch) {
      const k = chunkKeyOrNone(this.grid, c.cx, this.grid.chunkMinY, c.cz);
      let col = columns.get(k);
      if (col === undefined) columns.set(k, (col = { cx: c.cx, cz: c.cz, cys: [] }));
      col.cys.push(c.cy);
    }
    for (const col of columns.values()) {
      for (let d = -reach; d <= reach; d++) {
        if (d === 0) continue;
        const cx = axis === 'x' ? col.cx + d : col.cx;
        const cz = axis === 'z' ? col.cz + d : col.cz;
        for (const cy of col.cys) if (chunkKeyOrNone(this.grid, cx, cy, cz) >= 0 && !this.pastUnload(focus, cx, cy, cz)) yield { cx, cy, cz };
      }
    }
  }
}
