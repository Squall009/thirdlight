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
 * - **Props** marked to affect lighting stop light too where a world has
 *   their channel (prop-channel.ts): a level-0 cell stops the light stop
 *   where the voxels' coverage joined with the props' reaches
 *   {@link LIGHT_STOP_COVERAGE} (`coverageAt`'s rule), so the walk reads one
 *   occupancy for light. The mips and far nodes are the voxels' alone.
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

/** `e` bits of a cell mask from cell `i0` on (`e` ≤ 32 and dividing 32, `i0` a multiple of `e`; a null mask: none). */
function maskBits(m: Uint32Array | null, i0: number, e: number): number {
  if (m === null) return 0;
  const w = m[i0 >>> 5]!;
  return e === 32 ? w : (w >>> (i0 & 31)) & ((1 << e) - 1);
}

/** The cells of a derived result's grid that stop light by their partial coverage alone, one bit each (null: none). */
function partialStopMask(light: LightOut, cells: number): Uint32Array | null {
  let m: Uint32Array | null = null;
  for (let k = 0; k < light.partialCells.length; k++) {
    if (light.partialCover[k]! < LIGHT_STOP_COVERAGE) continue;
    const i = light.partialCells[k]!;
    (m ??= new Uint32Array(Math.ceil(cells / 32)))[i >>> 5]! |= 1 << (i & 31);
  }
  return m;
}

/** A derived result (a section's or a node's assembly) as one stop reads it. */
export function derivedWalkView(d: DerivedData, stop: WalkStop): WalkBlockView {
  const occ = d.occupancy;
  if (occ.flag === OCCUPANCY.empty) return WALK_EMPTY_VIEW;
  const e = d.edge;
  const all = e === 32 ? 0xffffffff : (1 << e) - 1;
  const solidColumn = (c: number): number => (occ.flag === OCCUPANCY.solid ? all : maskBits(occ.mask, c * e, e));
  if (stop === 'solid') {
    if (occ.flag === OCCUPANCY.solid) return WALK_SOLID_VIEW;
    return { flag: OCCUPANCY.mixed, brick: (i) => brickFlag(occ, i), cell: (i) => cellBit(occ.mask, i), column: solidColumn };
  }
  const light = d.light;
  if (light.uniform >= 0) return light.uniform >= LIGHT_STOP_COVERAGE && occ.flag === OCCUPANCY.solid ? WALK_SOLID_VIEW : light.uniform >= LIGHT_STOP_COVERAGE ? { flag: OCCUPANCY.mixed, brick: () => OCCUPANCY.mixed, cell: (i) => solidCell(occ, i), column: solidColumn } : WALK_EMPTY_VIEW;
  // A cell stops light when it is a body and covers fully or, partly, by half or more (lightStops, a word at a time).
  let partial: Uint32Array | null | undefined;
  const column = (c: number): number => {
    partial ??= partialStopMask(light, e * e * e);
    return (solidColumn(c) & (maskBits(light.full, c * e, e) | maskBits(partial, c * e, e))) >>> 0;
  };
  // A brick with no body holds nothing that stops light; one with bodies is read cell by cell (a damaged one may not).
  return { flag: OCCUPANCY.mixed, brick: (i) => (occ.flag === OCCUPANCY.solid || brickFlag(occ, i) !== OCCUPANCY.empty ? OCCUPANCY.mixed : OCCUPANCY.empty), cell: (i) => lightStops(occ, light, i), column };
}

/** What a walk source reads of a world's prop channel: a resident chunk's coverage bytes (null: no prop covers it; undefined: not built). */
export interface WalkPropCoverage {
  chunk(cx: number, cy: number, cz: number): Uint8Array | null | undefined;
}

/**
 * A level-0 block's light-stop view with the props over it: a cell also stops where its own coverage joined with the
 * props' (`lightCoverageAt`) reaches {@link LIGHT_STOP_COVERAGE}. `props`: the storage chunk's bytes, the block's cells
 * at `(ox, oy, oz)` in it (`csh`: the chunk's edge as a shift), `e` cells a side; `light`: the block's own coverage
 * (null: air). The view as it was where no prop stops anything.
 */
export function propStopView(base: WalkBlockView, light: LightOut | null, props: Uint8Array, ox: number, oy: number, oz: number, e: number, csh: number): WalkBlockView {
  let mask: Uint32Array | null = null;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const row = (((ox + x) << csh) | (oz + z)) << csh;
    for (let y = 0; y < e; y++) {
      const p = props[row | (oy + y)]!;
      if (p === 0) continue;
      const i = (x * e + z) * e + y;
      if ((light === null ? p : lightCoverageAt(light, i, p)) < LIGHT_STOP_COVERAGE) continue;
      (mask ??= new Uint32Array(Math.ceil((e * e * e) / 32)))[i >>> 5]! |= 1 << (i & 31);
    }
  }
  if (mask === null) return base;
  const m: Uint32Array = mask;
  const bit = (i: number): boolean => ((m[i >>> 5]! >>> (i & 31)) & 1) === 1;
  const n = e >> 2;
  // A brick holds a prop's stopping cell when any of its 16 columns' four cells does.
  const propBrick = (i: number): boolean => {
    const by = i % n;
    const bz = ((i - by) / n) % n;
    const bx = Math.floor(i / (n * n));
    for (let x = bx * 4; x < bx * 4 + 4; x++) for (let z = bz * 4; z < bz * 4 + 4; z++) if (((maskBits(m, (x * e + z) * e, e) >>> (by * 4)) & 15) !== 0) return true;
    return false;
  };
  return {
    flag: base.flag === OCCUPANCY.solid ? OCCUPANCY.solid : OCCUPANCY.mixed,
    brick: (i) => {
      const f = base.brick(i);
      return f === OCCUPANCY.solid ? f : propBrick(i) ? OCCUPANCY.mixed : f;
    },
    cell: (i) => base.cell(i) || bit(i),
    column: (c) => {
      let own = 0;
      if (base.column !== undefined) own = base.column(c);
      else if (base.flag === OCCUPANCY.solid) own = e === 32 ? 0xffffffff : (1 << e) - 1;
      else if (base.flag !== OCCUPANCY.empty) for (let y = 0; y < e; y++) if (base.cell(c * e + y)) own |= 1 << y;
      return (own | maskBits(m, c * e, e)) >>> 0;
    },
  };
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
 * level 0 alone; `props`: the world's prop channel, joined into the light stop at level 0 (absent: the voxels alone).
 */
export function streamerWalkSource(s: WalkStreamerView, far?: FarWalkNodes | null, opts: { readonly mips?: boolean; readonly props?: WalkPropCoverage | null } = {}): WalkSource {
  const mips = opts.mips === false ? null : s.mips;
  const props = opts.props ?? null;
  const cell = { material: 0, role: 0, shape: 0, wetness: 0 };
  const per = s.grid.shift - s.sections.shift;
  const sectionMask = (1 << per) - 1;
  return {
    maxLevel: mips?.maxLevel ?? 0,
    blockShift: (level) => (level === 0 ? s.sections.shift : s.grid.shift),
    block(level, bx, by, bz, stop) {
      if (level === 0) {
        const r = s.derivedOf(bx, by, bz, true);
        if (r === null) return null;
        const base = r.assembly === null ? WALK_EMPTY_VIEW : derivedWalkView(r.assembly, stop);
        const c = stop === 'light' && props !== null ? props.chunk(bx >> per, by >> per, bz >> per) : null;
        if (c == null) return base;
        const sh = s.sections.shift;
        return propStopView(base, r.assembly?.light ?? null, c, (bx & sectionMask) << sh, (by & sectionMask) << sh, (bz & sectionMask) << sh, 1 << sh, s.grid.shift);
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

/** What {@link streamerWalkBlocks} reads of a streamer. */
export interface WalkBlocksView {
  readonly sections: { readonly shift: number };
  readonly grid: { readonly shift: number };
  derivedChunks(): Iterable<{ readonly cx: number; readonly cy: number; readonly cz: number }>;
  readonly mips: { derived(): Iterable<{ readonly level: number; readonly nx: number; readonly ny: number; readonly nz: number; readonly result: DerivedData | null }> } | null;
}

/**
 * The walk blocks a streamer knows now, as `[level, x, y, z]`: at level 0 the chunk of every derive section with a
 * result (a chunk once a section), at the mip levels every node with something drawn.
 */
export function* streamerWalkBlocks(s: WalkBlocksView): IterableIterator<readonly [number, number, number, number]> {
  const per = s.grid.shift - s.sections.shift;
  for (const d of s.derivedChunks()) yield [0, d.cx >> per, d.cy >> per, d.cz >> per];
  for (const n of s.mips?.derived() ?? []) if (n.result !== null) yield [n.level, n.nx, n.ny, n.nz];
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
