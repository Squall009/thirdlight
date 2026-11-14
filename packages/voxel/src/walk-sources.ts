/**
 * What the occupancy walk (occupancy-walk.ts) reads where a world runs: the
 * streamer's derived results (level 0 by derive section, the mip levels by
 * node) and the far nodes drawn, kept beside the far field for it.
 *
 * - **Level 0** is a section's newest committed result (what is drawn,
 *   also while a rebuild is pending); a section without one is not known
 *   there. A result without an assembly is air.
 * - **Mip levels** are a node's newest result; a node derived to nothing
 *   drawn (all air or all buried) is not known there, so the walk looks
 *   further (the far node, or air).
 * - **Far nodes** are the bricks of the nodes the far field draws, copied
 *   as they go to the page (their samples, brick table and boxes; not their
 *   looks), dropped as they go from it, counted in the world's resident
 *   bytes. A fine node (built on the page's GPU) and a mesh node give none.
 */
import { cellBit, OCCUPANCY, type DerivedData, type LightOut, type OccupancyOut } from './derived-data';
import type { FarBricks } from './far-bricks';
import type { FarEvent } from './far-field';
import { mipNodeKey, type MipNode } from './voxel-mips';
import type { DeriveOutput } from './stream-job';
import { LIGHT_STOP_COVERAGE, type WalkBlockView, type WalkFarNode, type WalkSource, type WalkStop } from './occupancy-walk';
import { lightCoverageAt } from './prop-coverage';
import { valueOf } from './record';

/** A block known to hold no stopping cell. */
export const WALK_EMPTY_VIEW: WalkBlockView = Object.freeze({ flag: OCCUPANCY.empty, brick: () => OCCUPANCY.empty, cell: () => false });

/** A block every cell of which stops the ray. */
export const WALK_SOLID_VIEW: WalkBlockView = Object.freeze({ flag: OCCUPANCY.solid, brick: () => OCCUPANCY.solid, cell: () => true });

const brickFlag = (occ: OccupancyOut, i: number): number => (occ.bricks[i >> 2]! >> ((i & 3) * 2)) & 3;

/** A cell's occupancy (a body drawn) from a derived result. */
function solidCell(occ: OccupancyOut, i: number): boolean {
  return occ.flag === OCCUPANCY.solid || (occ.flag === OCCUPANCY.mixed && cellBit(occ.mask, i));
}

/** Whether a cell stops light: solid, and covering at least {@link LIGHT_STOP_COVERAGE}. */
export function lightStops(occ: OccupancyOut, light: LightOut, i: number): boolean {
  if (!solidCell(occ, i)) return false;
  if (light.uniform >= 0) return light.uniform >= LIGHT_STOP_COVERAGE;
  return cellBit(light.full, i) || lightCoverageAt(light, i, 0) >= LIGHT_STOP_COVERAGE;
}

/** A derived result (a section's or a node's assembly) as one stop reads it. */
export function derivedWalkView(d: DerivedData, stop: WalkStop): WalkBlockView {
  const occ = d.occupancy;
  if (occ.flag === OCCUPANCY.empty) return WALK_EMPTY_VIEW;
  if (stop === 'solid') {
    if (occ.flag === OCCUPANCY.solid) return WALK_SOLID_VIEW;
    return { flag: OCCUPANCY.mixed, brick: (i) => brickFlag(occ, i), cell: (i) => cellBit(occ.mask, i) };
  }
  const light = d.light;
  if (light.uniform >= 0) return light.uniform >= LIGHT_STOP_COVERAGE && occ.flag === OCCUPANCY.solid ? WALK_SOLID_VIEW : light.uniform >= LIGHT_STOP_COVERAGE ? { flag: OCCUPANCY.mixed, brick: () => OCCUPANCY.mixed, cell: (i) => solidCell(occ, i) } : WALK_EMPTY_VIEW;
  // A brick with no body holds nothing that stops light; one with bodies is read cell by cell (a damaged one may not).
  return { flag: OCCUPANCY.mixed, brick: (i) => (occ.flag === OCCUPANCY.solid || brickFlag(occ, i) !== OCCUPANCY.empty ? OCCUPANCY.mixed : OCCUPANCY.empty), cell: (i) => lightStops(occ, light, i) };
}

/** What a walk source reads of a streamer. */
export interface WalkStreamerView {
  readonly sections: { readonly shift: number };
  readonly grid: { readonly shift: number; readonly edge: number };
  derivedOf(sx: number, sy: number, sz: number, drawn?: boolean): DeriveOutput | null;
  readonly mips: { readonly maxLevel: number; derivedOf(level: number, nx: number, ny: number, nz: number): DerivedData | null } | null;
  isResident(cx: number, cy: number, cz: number): boolean;
  voxelAt(x: number, y: number, z: number, out: { material: number; role: number; shape: number; wetness: number }): unknown;
}

/**
 * A walk source over a streamer (`far`: the far nodes drawn, kept for walks; absent: none) — `mips: false` reads
 * level 0 alone.
 */
export function streamerWalkSource(s: WalkStreamerView, far?: FarWalkNodes | null, opts: { readonly mips?: boolean } = {}): WalkSource {
  const mips = opts.mips === false ? null : s.mips;
  const cell = { material: 0, role: 0, shape: 0, wetness: 0 };
  return {
    maxLevel: mips?.maxLevel ?? 0,
    blockShift: (level) => (level === 0 ? s.sections.shift : s.grid.shift),
    block(level, bx, by, bz, stop) {
      if (level === 0) {
        const r = s.derivedOf(bx, by, bz, true);
        if (r === null) return null;
        return r.assembly === null ? WALK_EMPTY_VIEW : derivedWalkView(r.assembly, stop);
      }
      const d = mips?.derivedOf(level, bx, by, bz) ?? null;
      return d === null ? null : derivedWalkView(d, stop);
    },
    record(x, y, z) {
      const sh = s.grid.shift;
      if (!s.isResident(x >> sh, y >> sh, z >> sh)) return null;
      s.voxelAt(x, y, z, cell);
      return valueOf(cell);
    },
    ...(far != null ? { farAt: (x: number, y: number, z: number) => far.farAt(x, y, z), farEdge: s.grid.edge } : {}),
  };
}

/** Bytes a far node's kept bricks take. */
function keptBytes(b: FarBricks): number {
  return b.bricks.byteLength + b.samples.byteLength + b.blocks.byteLength + b.bounds.byteLength;
}

/**
 * The far nodes drawn, by level, as a walk marches them. `copy`: the draws leave for another thread (their buffers are
 * handed over), so what the walk needs is copied first.
 */
export class FarWalkNodes {
  private readonly levels = new Map<number, Map<string, WalkFarNode>>();
  private sorted: number[] = [];
  bytes = 0;

  constructor(
    /** Cells a side of a node (the world's chunk edge). */
    readonly edge: number,
    private readonly copy: boolean,
  ) {}

  /** A far event: its removals, then its additions with bricks. */
  apply(e: Pick<FarEvent, 'added' | 'removed'>): void {
    for (const n of e.removed) this.drop(n);
    for (const a of e.added) {
      this.drop(a);
      if (a.bricks === undefined) continue;
      const b = a.bricks;
      const bricks: FarBricks = this.copy ? { side: b.side, bricks: b.bricks.slice(), samples: b.samples.slice(), looks: new Uint16Array(0), blocks: b.blocks.slice(), bounds: b.bounds.slice() } : b;
      let m = this.levels.get(a.level);
      if (m === undefined) {
        this.levels.set(a.level, (m = new Map()));
        this.sorted = [...this.levels.keys()].sort((x, y) => x - y);
      }
      m.set(mipNodeKey(a), { level: a.level, nx: a.nx, ny: a.ny, nz: a.nz, bricks });
      this.bytes += keptBytes(bricks);
    }
  }

  private drop(n: MipNode): void {
    const m = this.levels.get(n.level);
    const key = mipNodeKey(n);
    const had = m?.get(key);
    if (had === undefined) return;
    m!.delete(key);
    this.bytes -= keptBytes(had.bricks);
  }

  /** The finest far node kept over a level-0 cell (null: none). */
  farAt(x: number, y: number, z: number): WalkFarNode | null {
    for (const level of this.sorted) {
      const span = this.edge * 2 ** level;
      const n = this.levels.get(level)!.get(mipNodeKey({ level, nx: Math.floor(x / span), ny: Math.floor(y / span), nz: Math.floor(z / span) }));
      if (n !== undefined) return n;
    }
    return null;
  }

  /** Nodes kept. */
  get count(): number {
    let n = 0;
    for (const m of this.levels.values()) n += m.size;
    return n;
  }

  clear(): void {
    this.levels.clear();
    this.sorted = [];
    this.bytes = 0;
  }
}
