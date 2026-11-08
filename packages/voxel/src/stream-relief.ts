/**
 * The streamer's relief ring (relief-ring.ts) at work: planned at the focus
 * each update, the sections it changes derived again in one group (they
 * swap together, as an edit's do), its bytes (the `relief` budget parts:
 * the sections' relief meshes and their chunks' relief draws) kept to its
 * share of the stream budget by shrinking the ring, never by evicting the
 * world's chunks.
 */
import type { CellGrid, ChunkGrid } from './coords';
import { RELIEF_BUDGET_SHARE, RELIEF_DRAW_PART, RELIEF_PART, ReliefRing, type ReliefRingSettings, type SectionCoord } from './relief-ring';
import type { Focus } from './stream-ring';

/** What the relief ring needs of the streamer's derive sections. */
export interface ReliefDerives {
  readonly sections: CellGrid;
  newGroup(): number;
  settleGroup(group: number): void;
  rederiveRelief(coords: Iterable<SectionCoord>, group: number): number;
  reliefBytesOf(sx: number, sy: number, sz: number): number;
}

export class StreamRelief {
  readonly ring: ReliefRing;
  /** Bytes of the `relief` budget parts of resident chunks. */
  bytes = 0;
  /** Ring changes that derived sections again (each one swap). */
  plans = 0;

  constructor(
    private readonly derives: ReliefDerives,
    private readonly grid: ChunkGrid,
    /** A resident chunk's budget parts (null: none, or not resident). */
    private readonly parts: (cx: number, cy: number, cz: number) => ReadonlyMap<string, number> | null,
  ) {
    this.ring = new ReliefRing(derives.sections);
  }

  /** New settings (n 0: none): planned at the next update; true when they differ. */
  set(s: ReliefRingSettings): boolean {
    return this.ring.set(s);
  }

  /** Where relief displaces now (cells from the focus; 0: none): the ring's radius, or less while it is shrunk to its share. */
  get radius(): number {
    return this.ring.displaceRadius;
  }

  /** The bytes relief may hold in a budget (0 while the ring is off); the base world keeps the rest. */
  share(budgetBytes: number): number {
    return this.ring.n === 0 ? 0 : Math.floor(budgetBytes * RELIEF_BUDGET_SHARE);
  }

  /** Whether a budget part is relief's (counted in its share). */
  static isPart(part: string): boolean {
    return part.startsWith(RELIEF_PART);
  }

  /** Plans the ring at the focus; what changed derives again in one swap. */
  plan(focus: Focus): void {
    const changed = this.ring.plan(focus);
    if (changed !== null && changed.length > 0) this.rederive(this.ring.affected(changed));
  }

  /** Over its share of `budgetBytes`, the ring shrinks to fit (the dropped sections and their neighbours derive again). */
  fit(budgetBytes: number): void {
    const share = this.share(budgetBytes);
    if (share === 0 || this.bytes <= share) return;
    const dropped = this.ring.fit(share, (c) => this.bytesOf(c));
    if (dropped !== null) this.rederive(this.ring.affected(dropped));
  }

  private rederive(sections: readonly SectionCoord[]): void {
    const group = this.derives.newGroup();
    if (this.derives.rederiveRelief(sections, group) > 0) this.plans++;
    this.derives.settleGroup(group);
  }

  /** A relief section's bytes: its relief part, and its share of its chunk's relief draw (by its part of the chunk's relief parts). */
  private bytesOf(sc: SectionCoord): number {
    const own = this.derives.reliefBytesOf(sc.sx, sc.sy, sc.sz);
    if (own === 0) return 0;
    const k = this.grid.edge / this.derives.sections.edge;
    const parts = this.parts(Math.floor(sc.sx / k), Math.floor(sc.sy / k), Math.floor(sc.sz / k));
    const draw = parts?.get(RELIEF_DRAW_PART) ?? 0;
    if (draw === 0) return own;
    let sum = 0;
    for (const [name, b] of parts!) if (name.startsWith(`${RELIEF_PART}#`)) sum += b;
    return own + (sum > 0 ? (draw * own) / sum : 0);
  }
}
