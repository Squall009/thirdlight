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
 *   occupancy for light. Structure grids stamped into the same channel
 *   (structure-stamp.ts) stop light there too, and at the mip levels by
 *   their stopping cells (a level's cell stops where one under it does);
 *   props stop nothing at the mips. The far nodes are the voxels' alone.
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
import { LIGHT_STOP_COVERAGE, type WalkBlockView, type WalkFarNode, type WalkPartial, type WalkSource, type WalkStop } from './occupancy-walk';
import { combineCoverage, lightCoverageAt } from './prop-coverage';
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

/** A block's partly covered cells from their coverage by cell index (`e` cells a side), as the walk reads them. */
export function walkPartialOf(cells: ReadonlyMap<number, number>, e: number): WalkPartial {
  const n = e >> 2;
  const bricks = new Uint8Array(n * n * n);
  for (const i of cells.keys()) {
    const x = Math.floor(i / (e * e));
    const z = Math.floor(i / e) % e;
    const y = i % e;
    bricks[((x >> 2) * n + (z >> 2)) * n + (y >> 2)] = 1;
  }
  return { brick: (i) => bricks[i] === 1, cell: (i) => cells.get(i) ?? 0 };
}

/**
 * The cells of a derived result's grid the light stop passes that a body covers in part: drawn as a body (construction
 * damaged under half its integrity) with a coverage under {@link LIGHT_STOP_COVERAGE} (null: none). The ground's cells
 * over its surface are not among them (not bodies: their fill places the surface, not a share of the cell).
 */
function partialCellsOf(occ: OccupancyOut, light: LightOut, e: number): Map<number, number> | null {
  let out: Map<number, number> | null = null;
  if (light.uniform >= 0) {
    if (light.uniform === 0 || light.uniform >= LIGHT_STOP_COVERAGE || occ.flag === OCCUPANCY.empty) return null;
    for (let i = 0; i < e * e * e; i++) if (solidCell(occ, i)) (out ??= new Map()).set(i, light.uniform);
    return out;
  }
  for (let k = 0; k < light.partialCells.length; k++) {
    const c = light.partialCover[k]!;
    const i = light.partialCells[k]!;
    if (c < LIGHT_STOP_COVERAGE && solidCell(occ, i)) (out ??= new Map()).set(i, c);
  }
  return out;
}

/** A derived result's partly covered cells as the walk reads them, found once a result (a walk enters a block often). */
const partialKept = new WeakMap<LightOut, WalkPartial | null>();
function partialOf(occ: OccupancyOut, light: LightOut, e: number): WalkPartial | null {
  let p = partialKept.get(light);
  if (p === undefined) {
    const cells = partialCellsOf(occ, light, e);
    p = cells === null ? null : walkPartialOf(cells, e);
    partialKept.set(light, p);
  }
  return p;
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
  const passed = partialOf(occ, light, e);
  const withPassed = passed === null ? {} : { partial: passed };
  if (light.uniform >= 0) return light.uniform >= LIGHT_STOP_COVERAGE && occ.flag === OCCUPANCY.solid ? WALK_SOLID_VIEW : light.uniform >= LIGHT_STOP_COVERAGE ? { flag: OCCUPANCY.mixed, brick: () => OCCUPANCY.mixed, cell: (i) => solidCell(occ, i), column: solidColumn } : passed === null ? WALK_EMPTY_VIEW : { ...WALK_EMPTY_VIEW, ...withPassed };
  // A cell stops light when it is a body and covers fully or, partly, by half or more (lightStops, a word at a time).
  let partial: Uint32Array | null | undefined;
  const column = (c: number): number => {
    partial ??= partialStopMask(light, e * e * e);
    return (solidColumn(c) & (maskBits(light.full, c * e, e) | maskBits(partial, c * e, e))) >>> 0;
  };
  // A brick with no body holds nothing that stops light; one with bodies is read cell by cell (a damaged one may not).
  return { flag: OCCUPANCY.mixed, brick: (i) => (occ.flag === OCCUPANCY.solid || brickFlag(occ, i) !== OCCUPANCY.empty ? OCCUPANCY.mixed : OCCUPANCY.empty), cell: (i) => lightStops(occ, light, i), column, ...withPassed };
}

/** What a walk source reads of a world's prop channel: a resident chunk's coverage bytes (null: no prop covers it; undefined: not built). */
export interface WalkPropCoverage {
  chunk(cx: number, cy: number, cz: number): Uint8Array | null | undefined;
  /**
   * The cells of a mip node (its level's cells, one bit each) that structure grids stamped into the channel stop
   * (null: none): at the mip levels a stamped structure stops light as its own cells do in the world grid's mips.
   */
  mipStops?(level: number, nx: number, ny: number, nz: number): Uint32Array | null;
  /** Moves on whenever any chunk's bytes or classes change (absent: views with props are made at every read). */
  readonly version?: number;
}

/** Level-0 views with props kept made (a walk enters the same blocks ray after ray), past which the oldest go. */
const PROP_VIEWS_KEPT = 512;

/**
 * A level-0 block's light-stop view with the props over it: a cell also stops where its own coverage joined with the
 * props' (`lightCoverageAt`) reaches {@link LIGHT_STOP_COVERAGE}. `props`: the storage chunk's bytes, the block's cells
 * at `(ox, oy, oz)` in it (`csh`: the chunk's edge as a shift), `e` cells a side; `light`: the block's own coverage
 * (null: air). The view as it was where no prop stops anything.
 */
export function propStopView(base: WalkBlockView, light: LightOut | null, props: Uint8Array, ox: number, oy: number, oz: number, e: number, csh: number): WalkBlockView {
  let mask: Uint32Array | null = null;
  let parts: Map<number, number> | null = null;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const row = (((ox + x) << csh) | (oz + z)) << csh;
    for (let y = 0; y < e; y++) {
      const p = props[row | (oy + y)]!;
      if (p === 0) continue;
      const i = (x * e + z) * e + y;
      if ((light === null ? p : lightCoverageAt(light, i, p)) < LIGHT_STOP_COVERAGE) {
        // Passed, in part: the props' share joined with the cell's own body's (a damaged one's), never the ground's fill.
        if (!base.cell(i)) (parts ??= new Map()).set(i, combineCoverage(base.partial?.cell(i) ?? 0, p));
        continue;
      }
      (mask ??= new Uint32Array(Math.ceil((e * e * e) / 32)))[i >>> 5]! |= 1 << (i & 31);
    }
  }
  const view = parts === null ? base : withPartial(base, parts, e);
  return mask === null ? view : maskStopView(view, mask, e);
}

/** A block's view with more partly covered cells (`cells`, coverage by index), its own kept where these say nothing. */
function withPartial(base: WalkBlockView, cells: ReadonlyMap<number, number>, e: number): WalkBlockView {
  const own = base.partial ?? null;
  const add = walkPartialOf(cells, e);
  const partial: WalkPartial = own === null ? add : { brick: (i) => add.brick(i) || own.brick(i), cell: (i) => cells.get(i) ?? own.cell(i) };
  return { flag: base.flag, brick: (i) => base.brick(i), cell: (i) => base.cell(i), ...(base.column !== undefined ? { column: (c: number) => base.column!(c) } : {}), partial };
}

/**
 * A block's view with more stopping cells: those of `mask` (one bit a cell, the block's index `(x · e + z) · e + y`)
 * stop the ray too.
 */
export function maskStopView(base: WalkBlockView, mask: Uint32Array, e: number): WalkBlockView {
  const m: Uint32Array = mask;
  const bit = (i: number): boolean => ((m[i >>> 5]! >>> (i & 31)) & 1) === 1;
  const n = e >> 2;
  // A brick holds a stopping cell of the mask when any of its 16 columns' four cells does (found once: a walk asks often).
  const held = new Uint8Array(n * n * n);
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const col = maskBits(m, (x * e + z) * e, e);
    if (col === 0) continue;
    for (let by = 0; by < n; by++) if (((col >>> (by * 4)) & 15) !== 0) held[((x >> 2) * n + (z >> 2)) * n + by] = 1;
  }
  const maskBrick = (i: number): boolean => held[i] === 1;
  return {
    ...(base.partial !== undefined ? { partial: base.partial } : {}),
    flag: base.flag === OCCUPANCY.solid ? OCCUPANCY.solid : OCCUPANCY.mixed,
    brick: (i) => {
      const f = base.brick(i);
      return f === OCCUPANCY.solid ? f : maskBrick(i) ? OCCUPANCY.mixed : f;
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
  // Views joined with props, by block: made again when the section's result or the channel changed.
  const joined = new Map<string, { readonly r: DeriveOutput; readonly version: number; readonly view: WalkBlockView }>();
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
        const key = `${bx},${by},${bz}`;
        const version = props!.version;
        const had = version === undefined ? undefined : joined.get(key);
        if (had !== undefined && had.r === r && had.version === version) return had.view;
        const sh = s.sections.shift;
        const view = propStopView(base, r.assembly?.light ?? null, c, (bx & sectionMask) << sh, (by & sectionMask) << sh, (bz & sectionMask) << sh, 1 << sh, s.grid.shift);
        if (version !== undefined) {
          if (joined.size >= PROP_VIEWS_KEPT) joined.delete(joined.keys().next().value!);
          joined.set(key, { r, version, view });
        }
        return view;
      }
      const d = mips?.derivedOf(level, bx, by, bz) ?? null;
      const m = stop === 'light' && mips !== null ? (props?.mipStops?.(level, bx, by, bz) ?? null) : null;
      // A node the mips know nothing of (all air) is known where a structure stands in it.
      if (m !== null) return maskStopView(d === null ? WALK_EMPTY_VIEW : derivedWalkView(d, stop), m, 1 << s.grid.shift);
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
