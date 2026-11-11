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
import { chunkDistance2, inLoadRing, inNearRing, pastUnloadRing, speedRing, STREAM_DETAIL_SPEED, type Focus, type StreamRing } from './stream-ring';

/** How far ahead of the focus's motion chunks are read (seconds of travel). */
export const STREAM_PREFETCH_SECONDS = 1;

/** Source reads in flight at once: enough batches to keep a browser's six connections a host busy behind latency. */
export const DEFAULT_STREAM_READS = 8;

/** Seconds over which the focus's velocity is smoothed (a frame's jitter is not a direction). */
const VELOCITY_SMOOTH_S = 0.25;
/** A focus that has not moved for this long has no velocity. */
const STILL_AFTER_MS = 500;

/**
 * Half-width (cells; 32 m) of the way ahead read while the ring is narrowed
 * for speed: from the focus to its lead point, two chunks either side of the
 * line, so the chunks on it have their neighbours, diagonal ones included (a derive needs every
 * chunk round it) and nothing more. Ahead, a fast focus needs the ground it
 * will be over, not a whole ring round where it will be in a second: a disk
 * there swept twice the ground, and the gap between it and the focus's
 * unload bounds dropped chunks at the sides that were read again a moment
 * later. Slower, the lead's ring is the load ring's.
 */
export const STREAM_LEAD_CORRIDOR = 64;

/**
 * Where a chunk column lies against the way from the focus to its lead point:
 * the squared horizontal distance (cells²) from its centre to that segment and
 * how far along it (0 at the focus, 1 at the lead point).
 */
function alongWay(grid: ChunkGrid, focus: Focus, lead: Focus, cx: number, cz: number): { d2: number; t: number } {
  const h = grid.edge / 2;
  const px = (cx << grid.shift) + h - focus.x, pz = (cz << grid.shift) + h - focus.z;
  const sx = lead.x - focus.x, sz = lead.z - focus.z;
  const len2 = sx * sx + sz * sz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * sx + pz * sz) / len2));
  const ox = px - sx * t, oz = pz - sz * t;
  return { d2: ox * ox + oz * oz, t };
}

/** ms the focus's speed must stay down before a ring narrowed for it widens again. */
export const STREAM_WIDEN_AFTER_MS = 1000;

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
  /** When the current run of steps began: motion is only what has lasted a smoothing window. */
  private since = 0;

  /** `maxJump` (cells): a step longer than this is a jump and resets the velocity. */
  constructor(private readonly maxJump: number) {}

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
    // A jump by its length alone: steps reach the streamer at the simulation's ticks, not the frames that made them,
    // so two can come a fraction of a millisecond apart and a speed read from one step is noise (it reset a
    // 150 m/s flight's velocity several times a second, and the ring widened and refilled each time).
    if (!(dt > 0) || dist > this.maxJump) {
      this.vx = this.vy = this.vz = 0;
      this.movedAt = 0;
      return;
    }
    // A step after a pause starts a run with no velocity behind it (one placement is not a direction).
    if (this.movedAt === 0 || now - this.movedAt > STILL_AFTER_MS) {
      this.vx = this.vy = this.vz = 0;
      this.since = now;
    }
    const k = Math.min(1, dt / VELOCITY_SMOOTH_S);
    this.vx += (dx / dt - this.vx) * k;
    this.vy += (dy / dt - this.vy) * k;
    this.vz += (dz / dt - this.vz) * k;
    this.movedAt = now;
  }

  /**
   * Whether the focus is travelling: it moved lately, in a run of steps lasting at least the smoothing window (a
   * single step, a placement of the camera a little way off, is not travel and changes neither ring nor lead).
   */
  private moving(now: number): boolean {
    return this.movedAt !== 0 && now - this.movedAt <= STILL_AFTER_MS && this.movedAt - this.since >= VELOCITY_SMOOTH_S * 1000;
  }

  /** The focus's smoothed speed (cells a second; 0 when still). */
  speed(now: number): number {
    return this.moving(now) ? Math.hypot(this.vx, this.vy, this.vz) : 0;
  }

  /** The lead point (the focus itself when still or prefetch is off). */
  lead(f: Focus, now: number, seconds: number, maxCells: number): Focus {
    if (!(seconds > 0) || !this.moving(now)) return f;
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
 * A chunk's place in the pool's queue while the focus moves (squared cells,
 * smaller first): its distance from the way between the focus and the lead
 * point, plus a quarter of how far along it lies (the ground under the focus
 * before the ground a second ahead), and four times its distance behind the
 * focus (ground left behind is wanted last). With no lead point, its
 * distance from the focus. Collision under and ahead of a fast camera then
 * comes before the sides of the ring.
 */
export function motionDistance2(grid: ChunkGrid, focus: Focus, lead: Focus, cx: number, cy: number, cz: number): number {
  const sx = lead.x - focus.x, sy = lead.y - focus.y, sz = lead.z - focus.z;
  const len2 = sx * sx + sy * sy + sz * sz;
  if (len2 === 0) return chunkDistance2(grid, focus, cx, cy, cz);
  const h = grid.edge / 2;
  const px = (cx << grid.shift) + h - focus.x, py = (cy << grid.shift) + h - focus.y, pz = (cz << grid.shift) + h - focus.z;
  const t = (px * sx + py * sy + pz * sz) / len2;
  if (t < 0) return 4 * (px * px + py * py + pz * pz);
  const k = Math.min(1, t);
  const ox = px - sx * k, oy = py - sy * k, oz = pz - sz * k;
  return ox * ox + oy * oy + oz * oz + (k * k * len2) / 4;
}

/**
 * Every chunk inside the load bounds of the focus or of the way to the lead
 * point (`leadRadius` either side of the segment from the focus to it, the
 * lead point's own ring at its end; the load ring's radius by default), in
 * read order: columns by horizontal distance to the lead point, a column's
 * chunks together, nearest the lead point's height first. Along the way a
 * column's rows follow the height between the focus and the lead point.
 * Built column by column (a few hundred columns sorted, not the ring's
 * thousands of chunks), since it is rebuilt each time the focus or the lead
 * point crosses a chunk.
 */
export function readOrder(grid: ChunkGrid, ring: StreamRing, focus: Focus, lead: Focus, leadRadius = ring.loadRadius): WantedChunk[] {
  // At speed (the way read narrower than the ring) columns go by the pool's key instead (under the focus, then
  // along the way, the sides after): the way ahead was read as the lead point passed, so what is left unread is what
  // the focus has come to, and read last it held up the ground under the focus.
  const byWay = leadRadius < ring.loadRadius && lead !== focus;
  const e = grid.edge;
  const h = e / 2;
  const r2 = ring.loadRadius * ring.loadRadius;
  const l2 = leadRadius * leadRadius;
  // Chunk rows whose centre is within the load height of a point.
  const rows = (y: number): [number, number] => [Math.max(grid.chunkMinY, Math.ceil((y - ring.loadHeight - h) / e)), Math.min(grid.chunkMinY + grid.chunkSpanY - 1, Math.floor((y + ring.loadHeight - h) / e))];
  const [fy0, fy1] = rows(focus.y);
  const reach = Math.max(ring.loadRadius, leadRadius);
  const x0 = Math.max(grid.chunkMinXZ, Math.floor((Math.min(focus.x, lead.x) - reach) / e));
  const x1 = Math.min(grid.chunkMinXZ + grid.chunkSpanXZ - 1, Math.floor((Math.max(focus.x, lead.x) + reach) / e));
  const z0 = Math.max(grid.chunkMinXZ, Math.floor((Math.min(focus.z, lead.z) - reach) / e));
  const z1 = Math.min(grid.chunkMinXZ + grid.chunkSpanXZ - 1, Math.floor((Math.max(focus.z, lead.z) + reach) / e));
  const cols: Array<{ cx: number; cz: number; h2: number; inFocus: boolean; lead: [number, number] | null }> = [];
  for (let cx = x0; cx <= x1; cx++) {
    const px = (cx << grid.shift) + h;
    for (let cz = z0; cz <= z1; cz++) {
      const pz = (cz << grid.shift) + h;
      const inFocus = (px - focus.x) ** 2 + (pz - focus.z) ** 2 <= r2;
      const lh2 = byWay ? motionDistance2(grid, focus, { x: lead.x, y: focus.y, z: lead.z }, cx, (Math.floor(focus.y) >> grid.shift), cz) : (px - lead.x) ** 2 + (pz - lead.z) ** 2;
      let leadRows: [number, number] | null = null;
      if (lead !== focus) {
        const w = alongWay(grid, focus, lead, cx, cz);
        if (w.d2 <= l2) leadRows = rows(focus.y + (lead.y - focus.y) * w.t);
      }
      if (inFocus || leadRows !== null) cols.push({ cx, cz, h2: lh2, inFocus, lead: leadRows });
    }
  }
  cols.sort((a, b) => a.h2 - b.h2);
  const out: WantedChunk[] = [];
  const cys: number[] = [];
  cols.forEach((col, column) => {
    cys.length = 0;
    const lo = Math.min(fy0, col.lead?.[0] ?? fy0), hi = Math.max(fy1, col.lead?.[1] ?? fy1);
    for (let cy = lo; cy <= hi; cy++) if ((col.inFocus && cy >= fy0 && cy <= fy1) || (col.lead !== null && cy >= col.lead[0] && cy <= col.lead[1])) cys.push(cy);
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
  /** The last update narrowed or widened the ring for the focus's speed (the levels kept derived follow it). */
  ringChanged = false;
  /**
   * Level 0 is held back for the focus's speed ({@link STREAM_DETAIL_SPEED}): set at once when the speed passes it,
   * cleared once the speed has stayed under it for {@link STREAM_WIDEN_AFTER_MS} (a moment's dip in a fast flight must
   * not ask for the level-0 ring's derives and draws).
   */
  detailHeld = false;
  /** The last update set or cleared {@link detailHeld}. */
  detailChanged = false;
  /** The focus is faster than {@link STREAM_DETAIL_SPEED} now (no delay: what the held level 0 is still derived by). */
  detailFast = false;
  /** Since when the focus's speed has been under {@link STREAM_DETAIL_SPEED} while level 0 is held (NaN: it has not). */
  private slowSince = Number.NaN;
  private motion: FocusMotion;
  private focusChunk = Number.NaN;
  private leadChunk = Number.NaN;
  /** The ring as set; {@link current} is it at the focus's speed ({@link speedRing}). */
  private base: StreamRing;
  private current: StreamRing;
  /** Since when the focus's speed has asked for a wider ring than the current one (NaN: it has not). */
  private widerSince = Number.NaN;

  constructor(
    private readonly grid: ChunkGrid,
    ring: StreamRing,
    private readonly prefetchSeconds: number,
  ) {
    this.base = ring;
    this.current = ring;
    this.motion = StreamReadPlan.motionFor(ring);
  }

  /** The load ring the plan reads for (the ring as set, narrowed at speed). */
  get ring(): StreamRing {
    return this.current;
  }

  /** The ring as set. */
  get baseRing(): StreamRing {
    return this.base;
  }

  /** Half-width (cells) of the way to the lead point that is read: {@link STREAM_LEAD_CORRIDOR} while the ring is narrowed for speed, else the load radius. */
  get leadRadius(): number {
    return this.current.loadRadius < this.base.loadRadius ? Math.min(STREAM_LEAD_CORRIDOR, this.current.loadRadius) : this.current.loadRadius;
  }

  /** Whether a chunk lies within `radius` (cells, horizontally) of the way from the focus to the lead point and within `height` of the height along it. */
  private onWay(focus: Focus, cx: number, cy: number, cz: number, radius: number, height: number): boolean {
    if (this.lead === focus) return false;
    const w = alongWay(this.grid, focus, this.lead, cx, cz);
    if (w.d2 > radius * radius) return false;
    const dy = (cy << this.grid.shift) + this.grid.edge / 2 - (focus.y + (this.lead.y - focus.y) * w.t);
    return Math.abs(dy) <= height;
  }

  /** Whether a chunk is wanted: inside the load bounds of the focus or of the way to the lead point. */
  wants(focus: Focus, cx: number, cy: number, cz: number): boolean {
    return inLoadRing(this.grid, this.ring, focus, cx, cy, cz) || this.onWay(focus, cx, cy, cz, this.leadRadius, this.ring.loadHeight);
  }

  /** Whether a chunk column's work goes in the near lane: within the near radius of the focus, or on the way read ahead of it at speed. */
  near(focus: Focus, cx: number, cz: number): boolean {
    if (inNearRing(this.grid, this.ring, focus, cx, cz)) return true;
    if (this.lead === focus || !(this.current.loadRadius < this.base.loadRadius)) return false;
    return alongWay(this.grid, focus, this.lead, cx, cz).d2 <= this.leadRadius * this.leadRadius;
  }

  /** A new load ring: the next update plans again (what it no longer holds unloads, what it now holds loads). */
  setRing(ring: StreamRing): void {
    this.base = ring;
    this.current = ring;
    this.widerSince = Number.NaN;
    this.slowSince = Number.NaN;
    this.motion = StreamReadPlan.motionFor(ring);
    this.focusChunk = Number.NaN;
    this.leadChunk = Number.NaN;
  }

  /** A step past the near radius is a jump, not motion. */
  private static motionFor(ring: StreamRing): FocusMotion {
    return new FocusMotion(ring.nearRadius);
  }

  moved(focus: Focus, now: number): void {
    this.motion.move(focus, now);
  }

  /** Sets the lead point for this update; true when the focus or the lead point entered another chunk. */
  update(focus: Focus, now: number): boolean {
    const g = this.grid;
    const chunkOf = (p: Focus): number => chunkKeyOrNone(g, Math.floor(p.x) >> g.shift, Math.floor(p.y) >> g.shift, Math.floor(p.z) >> g.shift);
    const fk = chunkOf(focus);
    // At speed the ring narrows to what the pool can fill (the motion stays: it is the base ring's).
    // It narrows at once and widens only once the speed has stayed down for STREAM_WIDEN_AFTER_MS: a widened ring
    // asks for the whole base ring's reads and derives, which a moment's dip in the speed must not start.
    const speed = this.motion.speed(now);
    this.holdDetail(speed, now);
    const ring = speedRing(this.base, speed, g.edge);
    if (ring.loadRadius > this.current.loadRadius) {
      if (Number.isNaN(this.widerSince)) this.widerSince = now;
    } else this.widerSince = Number.NaN;
    this.ringChanged = ring.loadRadius < this.current.loadRadius || (ring.loadRadius > this.current.loadRadius && now - this.widerSince >= STREAM_WIDEN_AFTER_MS);
    if (this.ringChanged) {
      this.current = ring;
      this.widerSince = Number.NaN;
    }
    // The lead point reaches a second of travel up to the ring as set, so faster travel reads further ahead.
    const lead = this.motion.lead(focus, now, this.prefetchSeconds, Math.max(this.base.nearRadius, this.base.loadRadius));
    const lk = lead === focus ? fk : chunkOf(lead);
    // A lead point outside the world leads nowhere.
    this.lead = lk < 0 ? focus : lead;
    if (fk === this.focusChunk && lk === this.leadChunk && !this.ringChanged) return false;
    this.focusChunk = fk;
    this.leadChunk = lk;
    return true;
  }

  /** Holds level 0 back at once past {@link STREAM_DETAIL_SPEED}, and lets it go once the speed stayed under it for {@link STREAM_WIDEN_AFTER_MS}. */
  private holdDetail(speed: number, now: number): void {
    const held = this.detailHeld;
    this.detailFast = speed > STREAM_DETAIL_SPEED;
    if (speed > STREAM_DETAIL_SPEED) {
      this.slowSince = Number.NaN;
      this.detailHeld = true;
    } else if (held) {
      if (Number.isNaN(this.slowSince)) this.slowSince = now;
      if (now - this.slowSince >= STREAM_WIDEN_AFTER_MS) {
        this.detailHeld = false;
        this.slowSince = Number.NaN;
      }
    }
    this.detailChanged = this.detailHeld !== held;
  }

  /**
   * Past the unload bounds of the focus and of the way to the lead point (its read width and height plus the ring's
   * unload gap): the bounds are one shape along the way, so nothing between the focus and the lead point is dropped
   * only to be read again a moment later.
   */
  pastUnload(focus: Focus, cx: number, cy: number, cz: number): boolean {
    const r = this.ring;
    return pastUnloadRing(this.grid, r, focus, cx, cy, cz) && !this.onWay(focus, cx, cy, cz, this.leadRadius + (r.unloadRadius - r.loadRadius), r.unloadHeight);
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
