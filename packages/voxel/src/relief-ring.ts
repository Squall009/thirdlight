/**
 * The relief ring: which level-0 derive sections also derive the relief
 * mesh (relief-mesh.ts) around a focus, planned per section (an 8 m cube
 * at the default edge) rather than per storage chunk, so the ring hugs
 * the distance it is drawn to.
 *
 * - **Distances.** `radius` is where the displacement ends (the vertex
 *   stage's fade reaches nothing there, {@link reliefFade}). A section
 *   joins the ring when its centre lies within the radius plus its half
 *   diagonal (so every point displaced belongs to a relief section) and
 *   leaves only past that plus {@link RELIEF_HYSTERESIS_CELLS}: a section
 *   changes only where nothing of it is displaced, so a section turning
 *   relief or plain never pops. Distances are 3D, from the section's centre
 *   to the focus, as the fade's are.
 * - **Neighbours.** A relief section keeps its edges toward plain sections
 *   whole and fixed (`plainNeighbours`), so a change of one section's state
 *   also changes the relief meshes of the relief sections round it: a plan
 *   names them all ({@link ReliefRing.affected}), and the streamer derives
 *   them again in one atomic swap, so no frame shows a relief section
 *   against a neighbour it was not meshed for.
 * - **Budget.** Relief has its own share of the stream budget
 *   ({@link RELIEF_BUDGET_SHARE}); the base world keeps the rest, so relief
 *   never evicts the world's own chunks. When the relief meshes outgrow the
 *   share the ring shrinks ({@link ReliefRing.fit}): the farthest sections
 *   drop until the rest fit, and the ring stays that small until the focus
 *   has moved a section edge, then tries its full radius again.
 *
 * Pure planning: no workers, no meshes; the streamer asks and acts.
 */
import { chunkInWorld, chunkKey, type CellGrid } from './coords';
import { RELIEF_SUBDIVISIONS, reliefNeighbourBit, type ReliefOptions } from './relief-mesh';
import { VOXEL_RING_SCALES, type Focus } from './stream-ring';

/** A quality level's relief: lattice steps a cell (0: no relief mesh, normal from the heights only), or one of {@link RELIEF_SUBDIVISIONS}. */
export const RELIEF_STEPS: readonly number[] = Object.freeze([0, ...RELIEF_SUBDIVISIONS]);

/**
 * Relief lattice steps by quality tier: none on any tier, so no relief mesh
 * is derived, streamed or drawn unless a quality level asks for it with its
 * own `voxelRelief` (2: 25 cm vertices, 4: 12.5 cm). The owner turned the
 * displacement off until the far field's bricks work (fewer triangles, a
 * lighter mesher); the heights still shade every surface through its normal.
 * Measured before that: 2 on medium and 4 on high were what the pictures
 * gained from; 8 never paid next to a normal map.
 */
export const RELIEF_STEPS_BY_TIER: Readonly<Record<'low' | 'medium' | 'high', number>> = Object.freeze({ low: 0, medium: 0, high: 0 });

/**
 * How a tier scales the relief distance: its own, not the ring scale, because the relief ring was sized by what is
 * seen (medium 16 m, high 24 m), not by the budget's area. A level's own ring scale, `voxelRings`, moves it by the
 * same factor against the tier's ring scale.
 */
export const RELIEF_RING_SCALES: Readonly<Record<'low' | 'medium' | 'high', number>> = Object.freeze({ low: VOXEL_RING_SCALES.low, medium: 1, high: 1.5 });

/** Cells the focus moves before the relief ring's centre is told to the draws again (the fade follows it): an eighth of a metre. */
export const RELIEF_FOCUS_STEP_CELLS = 0.25;

/** Where relief displaces by default (cells from a focus): 16 m, scaled per quality level (by {@link RELIEF_RING_SCALES}). */
export const DEFAULT_RELIEF_RADIUS_CELLS = 32;

/** Cells over which the displacement fades to none before the ring's radius (4 m). */
export const RELIEF_FADE_CELLS = 8;

/** Cells past joining distance a relief section stays relief (4 m): a focus moving back and forth does not re-derive it. */
export const RELIEF_HYSTERESIS_CELLS = 8;

/** The share of a stream budget relief meshes may hold (their derived copies and their draws); the base world keeps the rest. */
export const RELIEF_BUDGET_SHARE = 1 / 8;

/** The share of {@link RELIEF_BUDGET_SHARE} a shrunk ring keeps, so the next section derived does not shrink it again at once. */
const FIT_TO = 0.9;

/** Budget parts (`setPart`) holding relief bytes start with this: the stream budget counts them in the relief share. */
export const RELIEF_PART = 'relief';

/** The budget part of a chunk's relief draw (the share of its drawn mesh that is relief: the GPU's copy). */
export const RELIEF_DRAW_PART = `${RELIEF_PART}-draw`;

/** Cells the focus moves before the ring is planned again. */
const REPLAN_CELLS = 1;

/** A ring's settings: lattice steps a cell (0: none) and where the displacement ends (cells). */
export interface ReliefRingSettings {
  readonly n: number;
  readonly radius: number;
}

/** A section's coordinates in the section grid. */
export interface SectionCoord {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
}

/** Half a section's diagonal (cells): how far a point of a section lies from its centre at most. */
export function sectionHalfDiagonal(edge: number): number {
  return (edge * Math.sqrt(3)) / 2;
}

/** The fade of a ring displacing to `radius` cells: none from `end` on, full up to `start` (cells). */
export function reliefFade(radius: number): { readonly start: number; readonly end: number } {
  const end = Math.max(0, radius);
  return { start: Math.max(0, end - RELIEF_FADE_CELLS), end };
}

/** Throws unless a ring's settings are usable. */
export function checkReliefRing(s: ReliefRingSettings): void {
  if (!RELIEF_STEPS.includes(s.n)) throw new RangeError(`relief ring: n ${s.n} (one of ${RELIEF_STEPS.join(', ')})`);
  if (!Number.isFinite(s.radius) || s.radius < 0) throw new RangeError(`relief ring: radius ${s.radius} cells`);
}

export class ReliefRing {
  private settings: ReliefRingSettings = { n: 0, radius: 0 };
  private readonly members = new Map<number, SectionCoord>();
  /** Where sections join (cells from the focus to their centre): the settings' mesh radius, or less after a {@link fit}. */
  private limit = 0;
  /** The focus the ring was last planned at (null: plan at the next call). */
  private planned: Focus | null = null;
  /** Sections to mesh again at the next plan whatever their state (the lattice step changed). */
  private restep: SectionCoord[] = [];
  /** Where the ring last shrank to fit its share (null: at its full radius). */
  private shrunkAt: Focus | null = null;
  /** Sections dropped to fit the share, and plans made, since the ring was set. */
  readonly counters = { plans: 0, shrinks: 0, dropped: 0 };

  constructor(readonly sections: CellGrid) {}

  /** The lattice steps a cell (0: no relief). */
  get n(): number {
    return this.settings.n;
  }

  /** Relief sections now. */
  get size(): number {
    return this.members.size;
  }

  /** The radius the settings ask for (cells; where the displacement ends). */
  get radius(): number {
    return this.settings.n === 0 ? 0 : this.settings.radius;
  }

  /**
   * Where the displacement ends now (cells): the settings' radius, or less
   * while the ring is shrunk to its share, so no point of a plain section
   * is ever displaced (a vertex stage fades by {@link reliefFade} of it).
   */
  get displaceRadius(): number {
    if (this.settings.n === 0) return 0;
    if (this.shrunkAt === null) return this.settings.radius;
    return Math.max(0, Math.min(this.settings.radius, this.limit - sectionHalfDiagonal(this.sections.edge)));
  }

  /** New settings (n 0: no relief): planned again at the next {@link plan}, at their full radius. True when they differ. */
  set(s: ReliefRingSettings): boolean {
    checkReliefRing(s);
    if (s.n === this.settings.n && s.radius === this.settings.radius) return false;
    // Sections staying in the ring are meshed again at the new lattice step.
    if (s.n !== this.settings.n) this.restep = [...this.members.values()];
    this.settings = { n: s.n, radius: s.radius };
    this.limit = this.meshRadius();
    this.shrunkAt = null;
    this.planned = null;
    return true;
  }

  private meshRadius(): number {
    return this.settings.n === 0 ? -1 : this.settings.radius + sectionHalfDiagonal(this.sections.edge);
  }

  has(sx: number, sy: number, sz: number): boolean {
    return chunkInWorld(this.sections, sx, sy, sz) && this.members.has(chunkKey(this.sections, sx, sy, sz));
  }

  /** What a section's derive is asked for: null when it is drawn plain, else n and which of its 26 neighbours are plain. */
  optionsFor(sx: number, sy: number, sz: number): ReliefOptions | null {
    if (!this.has(sx, sy, sz)) return null;
    let plainNeighbours = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if ((dx !== 0 || dy !== 0 || dz !== 0) && !this.has(sx + dx, sy + dy, sz + dz)) plainNeighbours |= reliefNeighbourBit(dx, dy, dz);
    }
    return { n: this.settings.n, plainNeighbours };
  }

  /** The relief sections and their distance (cells) from the focus planned at. */
  *list(): IterableIterator<SectionCoord & { readonly d: number }> {
    const f = this.planned;
    for (const c of this.members.values()) yield { ...c, d: f === null ? 0 : this.distance(c.sx, c.sy, c.sz, f) };
  }

  private distance(sx: number, sy: number, sz: number, f: Focus): number {
    const e = this.sections.edge;
    return Math.hypot((sx + 0.5) * e - f.x, (sy + 0.5) * e - f.y, (sz + 0.5) * e - f.z);
  }

  /**
   * Plans the ring round `focus` (cells): the sections that turned relief
   * or plain, or null when the focus has not moved a cell since the last
   * plan (and nothing asked for a new one). A shrunk ring takes its full
   * radius again once the focus is a section edge from where it shrank.
   */
  plan(focus: Focus): SectionCoord[] | null {
    const last = this.planned;
    if (last !== null && Math.hypot(focus.x - last.x, focus.y - last.y, focus.z - last.z) < REPLAN_CELLS) return null;
    if (this.shrunkAt !== null && Math.hypot(focus.x - this.shrunkAt.x, focus.y - this.shrunkAt.y, focus.z - this.shrunkAt.z) >= this.sections.edge) {
      this.limit = this.meshRadius();
      this.shrunkAt = null;
    }
    this.planned = { x: focus.x, y: focus.y, z: focus.z };
    this.counters.plans++;
    const changed: SectionCoord[] = this.restep;
    this.restep = [];
    const next = new Map<number, SectionCoord>();
    if (this.limit >= 0) {
      const g = this.sections;
      const e = g.edge;
      const keep = this.limit + RELIEF_HYSTERESIS_CELLS;
      const lo = (v: number): number => Math.floor((v - keep) / e);
      const hi = (v: number): number => Math.floor((v + keep) / e);
      for (let sx = lo(focus.x); sx <= hi(focus.x); sx++) for (let sz = lo(focus.z); sz <= hi(focus.z); sz++) for (let sy = lo(focus.y); sy <= hi(focus.y); sy++) {
        if (!chunkInWorld(g, sx, sy, sz)) continue;
        const key = chunkKey(g, sx, sy, sz);
        const d = this.distance(sx, sy, sz, focus);
        const was = this.members.get(key);
        if (d <= this.limit || (was !== undefined && d <= keep)) next.set(key, was ?? { sx, sy, sz });
      }
    }
    const restepped = new Set(changed.map((c) => chunkKey(this.sections, c.sx, c.sy, c.sz)));
    for (const [key, c] of this.members) if (!next.has(key) && !restepped.has(key)) changed.push(c);
    for (const [key, c] of next) if (!this.members.has(key) && !restepped.has(key)) changed.push(c);
    this.members.clear();
    for (const [key, c] of next) this.members.set(key, c);
    return changed;
  }

  /**
   * The sections whose derive a change of `changed` alters: those sections,
   * and every relief section round one of them (its edges toward them are
   * kept whole or split by their state). Each once.
   */
  affected(changed: readonly SectionCoord[]): SectionCoord[] {
    const g = this.sections;
    const out = new Map<number, SectionCoord>();
    for (const c of changed) {
      if (chunkInWorld(g, c.sx, c.sy, c.sz)) out.set(chunkKey(g, c.sx, c.sy, c.sz), c);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const sx = c.sx + dx;
        const sy = c.sy + dy;
        const sz = c.sz + dz;
        if (!chunkInWorld(g, sx, sy, sz)) continue;
        const key = chunkKey(g, sx, sy, sz);
        const m = this.members.get(key);
        if (m !== undefined) out.set(key, m);
      }
    }
    return [...out.values()];
  }

  /**
   * Keeps the ring inside `share` bytes: when the relief sections hold more
   * (`bytesOf` a section, as derived), the farthest drop until the rest hold
   * {@link FIT_TO} of it, and sections join only nearer than the nearest
   * dropped until the focus has moved a section edge. Returns the dropped
   * sections (null: the ring fits).
   */
  fit(share: number, bytesOf: (c: SectionCoord) => number): SectionCoord[] | null {
    const all = [...this.list()].map((c) => ({ c, d: c.d, bytes: bytesOf(c) }));
    let total = 0;
    for (const a of all) total += a.bytes;
    if (total <= share || this.planned === null) return null;
    all.sort((a, b) => b.d - a.d);
    const dropped: SectionCoord[] = [];
    let nearest = Infinity;
    for (const a of all) {
      if (total <= share * FIT_TO) break;
      total -= a.bytes;
      nearest = a.d;
      dropped.push({ sx: a.c.sx, sy: a.c.sy, sz: a.c.sz });
      this.members.delete(chunkKey(this.sections, a.c.sx, a.c.sy, a.c.sz));
    }
    // Sections as near as the nearest dropped one go too (ties), so what stays all lies nearer than where sections join now.
    for (const a of all) {
      if (a.d < nearest || !this.has(a.c.sx, a.c.sy, a.c.sz)) continue;
      dropped.push({ sx: a.c.sx, sy: a.c.sy, sz: a.c.sz });
      this.members.delete(chunkKey(this.sections, a.c.sx, a.c.sy, a.c.sz));
    }
    this.limit = Math.min(this.limit, nearest) - 1e-6;
    this.shrunkAt = this.planned;
    this.counters.shrinks++;
    this.counters.dropped += dropped.length;
    return dropped;
  }

  /** The ring's state for a report (cells). */
  state(): { readonly n: number; readonly radius: number; readonly displaceRadius: number; readonly joinRadius: number; readonly sections: number; readonly shrunk: boolean; readonly plans: number; readonly shrinks: number; readonly dropped: number } {
    return { n: this.settings.n, radius: this.radius, displaceRadius: this.displaceRadius, joinRadius: Math.max(0, this.limit), sections: this.members.size, shrunk: this.shrunkAt !== null, ...this.counters };
  }
}
