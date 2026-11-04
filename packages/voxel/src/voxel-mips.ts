/**
 * Voxel mips for the chunk tree: level L of the tree holds voxels of
 * 0.5 m × 2^L, one node per 2^L chunks a side, each node a chunk-shaped
 * block of edge³ voxels. A parent node is made from its 8 children (the
 * nodes one level down; at level 1, chunks) by a 2 × 2 × 2 downsample that
 * keeps the shape field meaning what it means at level 0, so the same rule
 * set and the same mesher read every level:
 *
 * - **shape** is the share of the parent that is solid: the mean of the 8
 *   cells' fill levels, counting only solid roles (open roles, {@link OPEN_ROLE}:
 *   air, liquid, openings, add nothing), rounded to the 16 levels. A
 *   construction cell's shape is its integrity, so it counts as full at any
 *   integrity ({@link fillLevel}), and a parent of a construction role is
 *   intact ({@link SHAPE_FULL}): damage stages show at level 0 only;
 * - **role** goes by priority ({@link MIP_ROLE_PRIORITY}). Bodies drawn as
 *   whole cells (every solid role but terrain) hold the parent when their
 *   cells are at least half of its 8, or when at least
 *   {@link MIP_SHEET_CELLS} of them lie in a sheet ({@link MIP_SHEET_NEIGHBOURS}
 *   body cells among a cell's 26 neighbours): a one-cell wall, floor or
 *   stepped roof stays closed at every level (thickened to the parent's
 *   cell), while a post, a rail or a fence (a line of cells) leaves the
 *   level. Cells count, not their share of the parent: a body is drawn
 *   whole, so a level-1 wall made of a one-cell sheet holds level 2 as
 *   level 0's held level 1. The parent then takes the first body role among those cells;
 *   terrain, drawn from its fill, holds it with any fill. A parent with no
 *   solid role is liquid when its liquid cells fill it to at least one level
 *   (the shape is then the liquid's share), else air;
 * - **material** is what the surface shows, so a coarse level wears the
 *   skin level 0 wears and not what lies under it (grass one cell thick over
 *   earth stays grass): among the counted cells nearest the surface (partly
 *   filled or beside an open cell; else beside a partly filled one; else
 *   beside the node's side, where the neighbour is not read; else all), the
 *   material of the most cells (ties: the larger summed fill, then the lower
 *   id). A liquid parent takes its dominant liquid;
 * - wetness comes from the first cell (in local-index order) of that
 *   material.
 *
 * A node therefore has the same form as a chunk (the same planes, the same
 * palette store and codec), so it streams, compresses, derives and meshes
 * with the same code. Mips are derived, never stored.
 *
 * An edit marks the nodes above every changed chunk stale, level by level
 * ({@link MipStaleSet}); the editor rebuilds them in the background, a
 * running game only the low levels near the edit.
 */
import { OPEN_ROLE } from './assembly';
import { localIndex, type ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import { OCCUPANCY } from './derived-data';
import { fillLevel, isConstructionRole, MATERIAL_AIR, SHAPE_EMPTY, SHAPE_FULL, VOXEL_ROLE } from './record';

/**
 * Which role a parent takes when its children hold several (first wins):
 * bodies drawn as whole cells before ground, so a wall standing in a node
 * of ground keeps its block and the ground's surface closes round it; walls
 * and their footings before floors, so a wall meeting a slab keeps its
 * height; terrain last.
 */
export const MIP_ROLE_PRIORITY: readonly number[] = Object.freeze([
  VOXEL_ROLE.wall,
  VOXEL_ROLE.foundation,
  VOXEL_ROLE.pillar,
  VOXEL_ROLE.floor,
  VOXEL_ROLE.stair,
  VOXEL_ROLE.roof,
  VOXEL_ROLE.terrain,
]);

/** A node of the chunk tree: level (0 = a chunk) and its coordinates at that level. */
export interface MipNode {
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** The node at `level` above chunk (cx, cy, cz). */
export function mipNodeOf(cx: number, cy: number, cz: number, level: number): MipNode {
  return { level, nx: cx >> level, ny: cy >> level, nz: cz >> level };
}

/** A node's key within its level (for sets and maps). */
export function mipNodeKey(n: MipNode): string {
  return `${n.level}:${n.nx},${n.ny},${n.nz}`;
}

/** The 8 children of a node (level − 1), in octant order (bit 0 x, bit 1 y, bit 2 z). */
export function mipChildren(n: MipNode): MipNode[] {
  if (n.level < 1) throw new RangeError('a chunk (level 0) has no children');
  const out: MipNode[] = [];
  for (let o = 0; o < 8; o++) out.push({ level: n.level - 1, nx: 2 * n.nx + (o & 1), ny: 2 * n.ny + ((o >> 1) & 1), nz: 2 * n.nz + ((o >> 2) & 1) });
  return out;
}

/** Per role: 1 when it is in {@link MIP_ROLE_PRIORITY} (a solid role the downsample counts). */
const SOLID_PRIORITY = new Uint8Array(16);
for (const r of MIP_ROLE_PRIORITY) SOLID_PRIORITY[r] = 1;

/** Per role: 1 for a body drawn as whole cells (every counted solid role but terrain). */
const WHOLE_CELL = new Uint8Array(16);
for (const r of MIP_ROLE_PRIORITY) if (r !== VOXEL_ROLE.terrain) WHOLE_CELL[r] = 1;

/** Body cells of a parent's 8 that hold it whatever their arrangement: half the parent. */
const HALF_PARENT_CELLS = 4;

/**
 * Body cells among a cell's 26 neighbours from which it lies in a sheet or
 * a mass rather than a line: a cell inside a flat one-cell wall has 8, a
 * step of a 45° roof 8 (its row and the rows above and below it, edge to
 * edge), a wall's edge 5 and a beam against a wall 11, while a rail or a
 * post has 2 and a rail's cell over its post 3–5.
 */
export const MIP_SHEET_NEIGHBOURS = 6;

/**
 * Sheet cells of a parent's 8 that hold it: two, so a one-cell sheet at any
 * axis-aligned or 45° slope keeps every parent it passes (it crosses each in
 * at least two cells), while a lone cell at a sheet's rim does not grow it.
 */
export const MIP_SHEET_CELLS = 2;

/** Scratch for one parent cell's downsample: per material, cells, summed fill and first cell; per role, summed fill. */
const mats = new Uint16Array(8);
const matCells = new Uint8Array(8);
const matFill = new Uint16Array(8);
const matFirst = new Int32Array(8);
const roleFill = new Uint16Array(16);
const roleCells = new Uint8Array(16);
/** Per cell of a parent: how near the surface it lies ({@link EXPOSURE}). */
const exposure = new Uint8Array(8);

/**
 * How near the surface a child cell lies, best first: partly filled or
 * beside an open cell (the surface runs through or along it); beside a
 * partly filled cell (under a thin top, the surface a fraction of a cell
 * away); beside a cell outside the node (not known here); buried.
 */
const EXPOSURE = Object.freeze({ surface: 3, under: 2, unknown: 1, buried: 0 });

/** The 6 face neighbours (x, y, z offsets). */
const FACES: ReadonlyArray<readonly [number, number, number]> = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];

const openRole = (r: number): boolean => OPEN_ROLE[r] === 1;

/**
 * Exposure ({@link EXPOSURE}) of child cell (x, y, z) of a parent node, in
 * the node's child cells (0 … 2 · edge − 1 a side, octant by the half).
 */
function exposureOf(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, x: number, y: number, z: number): number {
  const e = grid.edge;
  const own = children[(x >= e ? 1 : 0) | (y >= e ? 2 : 0) | (z >= e ? 4 : 0)]!;
  const oi = localIndex(grid, x % e, y % e, z % e);
  if (fillLevel(own.role[oi]!, own.shape[oi]!) < SHAPE_FULL) return EXPOSURE.surface;
  let best: number = EXPOSURE.buried;
  for (const [dx, dy, dz] of FACES) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (nx < 0 || ny < 0 || nz < 0 || nx >= 2 * e || ny >= 2 * e || nz >= 2 * e) {
      if (best < EXPOSURE.unknown) best = EXPOSURE.unknown;
      continue;
    }
    const c = children[(nx >= e ? 1 : 0) | (ny >= e ? 2 : 0) | (nz >= e ? 4 : 0)] ?? null;
    if (c === null) return EXPOSURE.surface;
    const ni = localIndex(grid, nx % e, ny % e, nz % e);
    if (c.material[ni] === MATERIAL_AIR || openRole(c.role[ni]!)) return EXPOSURE.surface;
    if (fillLevel(c.role[ni]!, c.shape[ni]!) < SHAPE_FULL && best < EXPOSURE.under) best = EXPOSURE.under;
  }
  return best;
}

/**
 * The material the 8 cells at `cells` show (those whose role passes
 * `counts`): among the cells nearest the surface ({@link EXPOSURE}; `near`
 * null: all alike), the material of the most cells, then of the largest
 * summed fill, then the lower id; returns the index of that material's
 * first such cell in `child`.
 */
function dominantCell(child: DenseChunk, cells: Int32Array, counts: (role: number) => boolean, near: Uint8Array | null): number {
  let top = 0;
  if (near !== null) for (let c = 0; c < 8; c++) if (near[c]! > top && child.material[cells[c]!] !== MATERIAL_AIR && counts(child.role[cells[c]!]!)) top = near[c]!;
  let k = 0;
  for (let c = 0; c < 8; c++) {
    const ci = cells[c]!;
    const m = child.material[ci]!;
    if (m === MATERIAL_AIR || !counts(child.role[ci]!) || (near !== null && near[c] !== top)) continue;
    let j = 0;
    while (j < k && mats[j] !== m) j++;
    if (j === k) {
      mats[k] = m;
      matCells[k] = 0;
      matFill[k] = 0;
      matFirst[k] = ci;
      k++;
    }
    matCells[j]!++;
    matFill[j]! += fillLevel(child.role[ci]!, child.shape[ci]!);
  }
  let best = 0;
  for (let j = 1; j < k; j++) {
    const more = matCells[j]! - matCells[best]! || matFill[j]! - matFill[best]! || mats[best]! - mats[j]!;
    if (more > 0) best = j;
  }
  return matFirst[best]!;
}

/** Whether child cell (x, y, z) of a parent node (0 … 2 · edge − 1 a side) is a whole-cell body. */
function bodyAt(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, x: number, y: number, z: number): boolean {
  const e = grid.edge;
  const c = children[(x >= e ? 1 : 0) | (y >= e ? 2 : 0) | (z >= e ? 4 : 0)] ?? null;
  if (c === null) return false;
  const i = localIndex(grid, x % e, y % e, z % e);
  return c.material[i] !== MATERIAL_AIR && c.shape[i] !== SHAPE_EMPTY && WHOLE_CELL[c.role[i]!] === 1;
}

/**
 * Whether body cell (x, y, z) of a parent node lies in a sheet: at least
 * {@link MIP_SHEET_NEIGHBOURS} bodies among its 26 neighbours. A neighbour
 * outside the node (not read here) is taken as its mirror through the cell,
 * so a line or a sheet crossing the node's side counts as it does inside.
 */
function sheetAt(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, x: number, y: number, z: number): boolean {
  const last = 2 * grid.edge - 1;
  const at = (v: number, d: number): number => (v + d < 0 || v + d > last ? v - d : v + d);
  let n = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    if ((dx | dy | dz) === 0 || !bodyAt(grid, children, at(x, dx), at(y, dy), at(z, dz))) continue;
    if (++n >= MIP_SHEET_NEIGHBOURS) return true;
  }
  return false;
}

const solidRole = (r: number): boolean => OPEN_ROLE[r] !== 1;
const liquidRole = (r: number): boolean => r === VOXEL_ROLE.liquid;

/**
 * Downsamples 8 children (octant order; null = all air) into `out`, a node
 * of the same edge. Returns false when the parent is all air (`out` is
 * then air too).
 */
export function downsampleMip(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, out: DenseChunk): boolean {
  if (children.length !== 8) throw new RangeError('a mip node has 8 children');
  const e = grid.edge;
  const h = e >> 1;
  const cells = new Int32Array(8);
  let any = false;
  const air = (pi: number): void => {
    out.material[pi] = MATERIAL_AIR;
    out.role[pi] = VOXEL_ROLE.air;
    out.shape[pi] = SHAPE_EMPTY;
    out.wetness[pi] = 0;
  };
  for (let o = 0; o < 8; o++) {
    const child = children[o] ?? null;
    const ox = (o & 1) * h;
    const oy = ((o >> 1) & 1) * h;
    const oz = ((o >> 2) & 1) * h;
    const { material, role: roles, shape: shapes, wetness } = child ?? out;
    for (let x = 0; x < h; x++) for (let z = 0; z < h; z++) for (let y = 0; y < h; y++) {
      const pi = localIndex(grid, ox + x, oy + y, oz + z);
      if (child === null) {
        air(pi);
        continue;
      }
      for (let c = 0; c < 8; c++) cells[c] = localIndex(grid, 2 * x + (c & 1), 2 * y + ((c >> 1) & 1), 2 * z + ((c >> 2) & 1));
      // Most parents cover one voxel 8 times (sky, rock): air stays air, a whole-cell solid stays itself.
      const c0 = cells[0]!;
      const m0 = material[c0]!;
      let same = true;
      for (let c = 1; c < 8 && same; c++) {
        const ci = cells[c]!;
        same = material[ci] === m0 && (m0 === MATERIAL_AIR || (roles[ci] === roles[c0] && shapes[ci] === shapes[c0] && wetness[ci] === wetness[c0]));
      }
      if (same && m0 === MATERIAL_AIR) {
        air(pi);
        continue;
      }
      if (same && fillLevel(roles[c0]!, shapes[c0]!) === SHAPE_FULL && SOLID_PRIORITY[roles[c0]!] === 1) {
        out.material[pi] = m0;
        out.role[pi] = roles[c0]!;
        out.shape[pi] = SHAPE_FULL;
        out.wetness[pi] = wetness[c0]!;
        any = true;
        continue;
      }
      roleFill.fill(0);
      roleCells.fill(0);
      let bodies = 0;
      for (let c = 0; c < 8; c++) {
        const ci = cells[c]!;
        if (material[ci] === MATERIAL_AIR) continue;
        const r = roles[ci]!;
        roleFill[r]! += fillLevel(r, shapes[ci]!);
        if (WHOLE_CELL[r] === 1 && shapes[ci] !== SHAPE_EMPTY) {
          roleCells[r]!++;
          bodies++;
        }
      }
      let solid = 0;
      for (const r of MIP_ROLE_PRIORITY) solid += roleFill[r]!;
      let held = bodies >= HALF_PARENT_CELLS;
      if (!held && bodies >= MIP_SHEET_CELLS) {
        let sheets = 0;
        for (let c = 0; c < 8 && !held; c++) {
          const bx = ox * 2 + 2 * x + (c & 1), by = oy * 2 + 2 * y + ((c >> 1) & 1), bz = oz * 2 + 2 * z + ((c >> 2) & 1);
          if (bodyAt(grid, children, bx, by, bz) && sheetAt(grid, children, bx, by, bz)) held = ++sheets >= MIP_SHEET_CELLS;
        }
      }
      let role: number = VOXEL_ROLE.air;
      for (const r of MIP_ROLE_PRIORITY) {
        if (r === VOXEL_ROLE.terrain ? roleFill[r] === 0 : !held || roleCells[r] === 0) continue;
        role = r;
        break;
      }
      let shape = Math.round(solid / 8);
      let counts = solidRole;
      if (role === VOXEL_ROLE.air || shape === 0) {
        shape = Math.round(roleFill[VOXEL_ROLE.liquid]! / 8);
        role = VOXEL_ROLE.liquid;
        counts = liquidRole;
      }
      if (shape === 0) {
        air(pi);
        continue;
      }
      // A construction shape is integrity, not fill: a parent block is intact (damage shows at the finest level only).
      if (isConstructionRole(role)) shape = SHAPE_FULL;
      let near: Uint8Array | null = null;
      // Which cells lie nearest the surface matters only between two or more materials.
      let m1 = MATERIAL_AIR;
      let mixed = false;
      for (let c = 0; c < 8 && !mixed; c++) {
        const ci = cells[c]!;
        const m = material[ci]!;
        if (m === MATERIAL_AIR || !counts(roles[ci]!)) continue;
        if (m1 === MATERIAL_AIR) m1 = m;
        else mixed = m !== m1;
      }
      if (mixed && counts === solidRole) {
        for (let c = 0; c < 8; c++) exposure[c] = exposureOf(grid, children, ox * 2 + 2 * x + (c & 1), oy * 2 + 2 * y + ((c >> 1) & 1), oz * 2 + 2 * z + ((c >> 2) & 1));
        near = exposure;
      }
      const first = dominantCell(child, cells, counts, near);
      out.material[pi] = child.material[first]!;
      out.role[pi] = role;
      out.wetness[pi] = child.wetness[first]!;
      out.shape[pi] = shape;
      any = true;
    }
  }
  return any;
}

/**
 * The tree nodes made stale by changed chunks, per level up to a highest
 * level: every ancestor of a changed chunk, once.
 */
export class MipStaleSet {
  private readonly stale = new Map<string, MipNode>();

  constructor(readonly maxLevel: number) {
    if (!Number.isInteger(maxLevel) || maxLevel < 1) throw new RangeError(`highest mip level ${maxLevel}`);
  }

  /** Marks the ancestors of changed chunks stale (levels 1 … maxLevel). */
  markChanged(chunks: Iterable<{ readonly cx: number; readonly cy: number; readonly cz: number }>): void {
    for (const c of chunks) for (let l = 1; l <= this.maxLevel; l++) {
      const n = mipNodeOf(c.cx, c.cy, c.cz, l);
      this.stale.set(mipNodeKey(n), n);
    }
  }

  /** Marks one node stale (its rebuild failed, or was refused, and must run again). */
  mark(n: MipNode): void {
    if (n.level < 1 || n.level > this.maxLevel) throw new RangeError(`mip level ${n.level} outside 1 … ${this.maxLevel}`);
    this.stale.set(mipNodeKey(n), { level: n.level, nx: n.nx, ny: n.ny, nz: n.nz });
  }

  /** Whether a node waits to be rebuilt. */
  has(n: MipNode): boolean {
    return this.stale.has(mipNodeKey(n));
  }

  /** Stale nodes, lowest level first (a parent is rebuilt after its children), then by coordinates. */
  nodes(maxLevel = this.maxLevel): MipNode[] {
    return [...this.stale.values()].filter((n) => n.level <= maxLevel).sort((a, b) => a.level - b.level || a.nx - b.nx || a.ny - b.ny || a.nz - b.nz);
  }

  /** Clears a node once rebuilt. */
  rebuilt(n: MipNode): void {
    this.stale.delete(mipNodeKey(n));
  }

  get size(): number {
    return this.stale.size;
  }
}

/**
 * Solid/empty/mixed flags ({@link OCCUPANCY}) of every chunk-tree node, so
 * culling, rays and the far field skip whole empty or whole solid subtrees
 * without reading voxels. A chunk's flag is its derived occupancy flag (a
 * chunk never given one, all air, is empty); a node above is empty when all
 * 8 children are, solid when all 8 are, and mixed otherwise.
 *
 * A chunk whose flag changes marks its ancestors stale (the same
 * {@link MipStaleSet} the mips use); a read refreshes stale nodes first,
 * lowest level first, so a flag read is never stale.
 */
export class ChunkTreeFlags {
  private readonly flags = new Map<string, number>();
  private readonly stale: MipStaleSet;

  constructor(readonly maxLevel: number) {
    this.stale = new MipStaleSet(maxLevel);
  }

  /** Sets a chunk's flag (its derived occupancy flag); marks its ancestors stale when it changed. */
  setChunk(cx: number, cy: number, cz: number, flag: number): void {
    if (flag !== OCCUPANCY.empty && flag !== OCCUPANCY.solid && flag !== OCCUPANCY.mixed) throw new RangeError(`occupancy flag ${flag}`);
    const key = mipNodeKey(mipNodeOf(cx, cy, cz, 0));
    if ((this.flags.get(key) ?? OCCUPANCY.empty) === flag) return;
    if (flag === OCCUPANCY.empty) this.flags.delete(key);
    else this.flags.set(key, flag);
    this.stale.markChanged([{ cx, cy, cz }]);
  }

  /** Nodes waiting to be refreshed (lowest level first). */
  staleNodes(): MipNode[] {
    return this.stale.nodes();
  }

  /** Recomputes every stale node from its children, lowest level first; returns the nodes whose flag changed. */
  refresh(): MipNode[] {
    const changed: MipNode[] = [];
    for (const n of this.stale.nodes()) {
      let empty = 0;
      let solid = 0;
      for (const c of mipChildren(n)) {
        const f = this.flags.get(mipNodeKey(c)) ?? OCCUPANCY.empty;
        if (f === OCCUPANCY.empty) empty++;
        else if (f === OCCUPANCY.solid) solid++;
      }
      const flag = empty === 8 ? OCCUPANCY.empty : solid === 8 ? OCCUPANCY.solid : OCCUPANCY.mixed;
      const key = mipNodeKey(n);
      if ((this.flags.get(key) ?? OCCUPANCY.empty) !== flag) changed.push(n);
      if (flag === OCCUPANCY.empty) this.flags.delete(key);
      else this.flags.set(key, flag);
      this.stale.rebuilt(n);
    }
    return changed;
  }

  /** A node's flag (level 0: a chunk), refreshed first when anything below it changed. */
  flagOf(n: MipNode): number {
    if (n.level > this.maxLevel) throw new RangeError(`level ${n.level} is above the highest level ${this.maxLevel}`);
    if (this.stale.size > 0) this.refresh();
    return this.flags.get(mipNodeKey(n)) ?? OCCUPANCY.empty;
  }
}
