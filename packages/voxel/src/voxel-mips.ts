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
 *   level 0's held level 1. A sloped roof is then laid again column by
 *   column as a one-cell 45° stair ({@link relayRoofs}). The parent then
 *   takes the first body role among those cells;
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
import { roofReading, ROOF_WORD, type RoofProbe } from './roof-words';

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

/** The 4 horizontal directions (+x, +z, −x, −z) as x and z steps. */
const DIR_X = [1, 0, -1, 0] as const;
const DIR_Z = [0, 1, 0, -1] as const;

function roofAt(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, x: number, y: number, z: number): boolean {
  const e = grid.edge;
  if (x < 0 || y < 0 || z < 0 || x >= 2 * e || y >= 2 * e || z >= 2 * e) return false;
  const c = children[(x >= e ? 1 : 0) | (y >= e ? 2 : 0) | (z >= e ? 4 : 0)] ?? null;
  if (c === null) return false;
  const i = localIndex(grid, x % e, y % e, z % e);
  return c.role[i] === VOXEL_ROLE.roof && c.material[i] !== MATERIAL_AIR;
}

/**
 * The directions (bit k: {@link DIR_X}/{@link DIR_Z} k) child roof cell
 * (x, y, z) of a parent node rises toward, as the roof mesher reads them: a
 * roof cell one up and one across that way, or one down and one across the
 * other way; with none, a diagonal one gives the two directions of a hip's
 * eave corner. 0: no step of a sloped roof (flat or lone).
 */
function roofDirs(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, x: number, y: number, z: number): number {
  let dirs = 0;
  for (let k = 0; k < 4; k++) if (roofAt(grid, children, x + DIR_X[k]!, y + 1, z + DIR_Z[k]!) || roofAt(grid, children, x - DIR_X[k]!, y - 1, z - DIR_Z[k]!)) dirs |= 1 << k;
  for (let k = 0; k < 4 && dirs === 0; k++) {
    const j = (k + 1) & 3;
    const dx = DIR_X[k]! + DIR_X[j]!, dz = DIR_Z[k]! + DIR_Z[j]!;
    if (roofAt(grid, children, x + dx, y + 1, z + dz) || roofAt(grid, children, x - dx, y - 1, z - dz)) dirs = (1 << k) | (1 << j);
  }
  return dirs;
}

/** Per child column of a node (2·edge squared): its top roof cell (y; −1 none), material, wetness and roof. */
let colTop = new Int16Array(0);
let colMat = new Uint16Array(0);
let colWet = new Uint8Array(0);
let colRoof = new Int32Array(0);
let colStack = new Int32Array(0);
/** Per child column: its top roof cell's 1:2 reading (bit 0: read as 1:2, bit 1: the high cell of its pair). */
let colShallow = new Uint8Array(0);
/** Per roof (a column-top component): its lowest top (the eave), whether it is laid again, and whether it is 1:2. */
const roofEave: number[] = [];
const roofRelaid: boolean[] = [];
const roofShallow: boolean[] = [];

/** The child grid the column probe reads, and the cell it reads round. */
let probeGrid: ChunkGrid | null = null;
let probeChildren: ReadonlyArray<DenseChunk | null> = [];
let probeAt = [0, 0, 0];
const childProbe: RoofProbe = (dx, dy, dz) => roofAt(probeGrid!, probeChildren, probeAt[0]! + dx, probeAt[1]! + dy, probeAt[2]! + dz);

/** A child roof cell's 1:2 reading as the roof mesher reads it (see {@link colShallow}). */
function shallowAt(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, x: number, y: number, z: number): number {
  probeGrid = grid;
  probeChildren = children;
  probeAt = [x, y, z];
  const w = roofReading(childProbe);
  if ((w & ROOF_WORD.shallow) === 0) return 0;
  let k = 0;
  while (((w >>> k) & 1) === 0) k++;
  return 1 | (((w >>> (ROOF_WORD.phaseShift + k)) & 1) << 1);
}

/**
 * Whether every solid cell of parent cell (x, y, z) that is not roof lies
 * under the top roof cell of its finer column ({@link colTop}): a body the
 * roof covers, not one that stands through it (a chimney, a wall rising
 * past the roof, or a body in a column without roof).
 */
function underRoof(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, x: number, y: number, z: number): boolean {
  const e = grid.edge;
  const side = 2 * e;
  for (let c = 0; c < 8; c++) {
    const bx = 2 * x + (c & 1), by = 2 * y + ((c >> 1) & 1), bz = 2 * z + ((c >> 2) & 1);
    const ch = children[(bx >= e ? 1 : 0) | (by >= e ? 2 : 0) | (bz >= e ? 4 : 0)] ?? null;
    if (ch === null) continue;
    const i = localIndex(grid, bx % e, by % e, bz % e);
    if (ch.material[i] === MATERIAL_AIR || openRole(ch.role[i]!) || ch.role[i] === VOXEL_ROLE.roof) continue;
    if (by >= colTop[bx * side + bz]!) return false;
  }
  return true;
}

/**
 * Re-lays a sloped roof at the coarse level as a 45° stair one cell thick,
 * column by column of the node. A 45° roof not aligned to the parent grid
 * puts a slope column's two cells into two parents, so the cell-by-cell
 * downsample gives a two-cell band whose mid-slope cells read as hips and
 * ridges (planes and roof-edge pieces crossing the slopes), and drops the
 * eave row (too few cells to hold a parent).
 *
 * The finer columns' top roof cells are grouped into roofs (columns side by
 * side or corner to corner whose tops differ by at most one cell); a roof's
 * eave height a is its lowest top, and each column's ring r its top − a (how
 * many steps in from the eave). A parent column over a roof with a slope step
 * ({@link roofDirs}), or one cut by the node's side, takes one roof cell at
 * floor(a / 2) + ceil(r / 2), r the smallest ring among its finer columns:
 * the parent's eave is the parent holding the finer eave on every side,
 * whichever way the footprint meets the parent grid (an eave column holding
 * one finer column or two has ring 0 both ways), and the smallest ring of a
 * 2 × 2 is its outermost corner's, so a hip's, a gable's or an L's rings
 * (each the smaller of an x and a z distance) halve into the coarse
 * footprint's own rings: one step a parent, ridges, hips, valleys and eaves
 * where the finer roof has them, odd or even, its planes within one finer
 * cell of the finer ones at the eave. A roof cut by the node's top or bottom
 * face may miss its eave inside the node (its lowest top is then higher, and
 * the parent heights a step off at that face).
 *
 * The parent's roof cells over those finer runs are cleared first (a
 * separate roof lower in the column stays), and so are cells of other
 * bodies the finer roof covers ({@link underRoof}: a gable's end wall, the
 * wall under an eave), at the new roof cell and above it; a cell a body
 * standing through the roof holds (a chimney) keeps it. Flat and lone roof cells keep
 * the cell-by-cell result. Returns whether it laid a cell.
 */
function relayRoofs(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, out: DenseChunk): boolean {
  const e = grid.edge;
  const side = 2 * e;
  const top = side - 1;
  const columns = side * side;
  if (colTop.length < columns) {
    colTop = new Int16Array(columns);
    colMat = new Uint16Array(columns);
    colWet = new Uint8Array(columns);
    colRoof = new Int32Array(columns);
    colStack = new Int32Array(columns);
    colShallow = new Uint8Array(columns);
  }
  for (let bx = 0; bx < side; bx++) for (let bz = 0; bz < side; bz++) {
    const c = bx * side + bz;
    colRoof[c] = -1;
    let y = top;
    while (y >= 0 && !roofAt(grid, children, bx, y, bz)) y--;
    colTop[c] = y;
    colShallow[c] = 0;
    if (y < 0) continue;
    colShallow[c] = shallowAt(grid, children, bx, y, bz);
    const ch = children[(bx >= e ? 1 : 0) | (y >= e ? 2 : 0) | (bz >= e ? 4 : 0)]!;
    const i = localIndex(grid, bx % e, y % e, bz % e);
    colMat[c] = ch.material[i]!;
    colWet[c] = ch.wetness[i]!;
  }
  // Roofs: column tops joined side by side or corner to corner within a cell's height.
  roofEave.length = 0;
  roofRelaid.length = 0;
  roofShallow.length = 0;
  for (let c0 = 0; c0 < columns; c0++) {
    if (colTop[c0]! < 0 || colRoof[c0]! >= 0) continue;
    const id = roofEave.length;
    let eave = colTop[c0]!;
    let relaid = false;
    let shallow = 0;
    let steep = 0;
    let sp = 0;
    colStack[sp++] = c0;
    colRoof[c0] = id;
    while (sp > 0) {
      const c = colStack[--sp]!;
      const bx = (c / side) | 0, bz = c - bx * side;
      const y = colTop[c]!;
      eave = Math.min(eave, y);
      const dirs = roofDirs(grid, children, bx, y, bz);
      if (!relaid && (bx === 0 || bz === 0 || bx === top || bz === top || dirs !== 0)) relaid = true;
      if ((colShallow[c]! & 1) !== 0) shallow++;
      else if (dirs !== 0) steep++;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const nx = bx + dx, nz = bz + dz;
        if (nx < 0 || nz < 0 || nx > top || nz > top) continue;
        const n = nx * side + nz;
        if (colTop[n]! < 0 || colRoof[n]! >= 0 || Math.abs(colTop[n]! - y) > 1) continue;
        colRoof[n] = id;
        colStack[sp++] = n;
      }
    }
    roofEave.push(eave);
    roofRelaid.push(relaid);
    roofShallow.push(shallow > steep);
  }
  let placed = false;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    let lowest = -1;
    let roof = -1;
    let lo: number = e;
    let hi = -1;
    for (let c = 0; c < 4; c++) {
      const col = (2 * x + (c & 1)) * side + 2 * z + (c >> 1);
      const y = colTop[col]!;
      if (y < 0 || !roofRelaid[colRoof[col]!]) continue;
      if (lowest < 0 || y < lowest) {
        lowest = y;
        roof = colRoof[col]!;
      }
      let low = y;
      while (low > 0 && roofAt(grid, children, 2 * x + (c & 1), low - 1, 2 * z + (c >> 1))) low--;
      lo = Math.min(lo, low >> 1);
      hi = Math.max(hi, y >> 1);
    }
    if (roof < 0) continue;
    const a = roofEave[roof]!;
    let rise = (lowest - a + 1) >> 1;
    if (roofShallow[roof]) {
      // A 1:2 roof: each finer column's distance in from the eave is twice its ring plus its phase; the parent's
      // distance is half the smallest of its columns' (rounded up, as a 45° ring halves), and its rise half that,
      // so the coarse stair is 1:2 again with a pair at its eave.
      let d = Infinity;
      for (let c = 0; c < 4; c++) {
        const col = (2 * x + (c & 1)) * side + 2 * z + (c >> 1);
        if (colTop[col]! < 0 || colRoof[col] !== roof) continue;
        d = Math.min(d, 2 * (colTop[col]! - a) + (colShallow[col]! >> 1));
      }
      rise = ((d + 1) >> 1) >> 1;
    }
    const want = Math.min(e - 1, (a >> 1) + rise);
    for (let y = Math.min(lo, want); y <= Math.max(hi, want); y++) {
      const i = localIndex(grid, x, y, z);
      // Bodies the finer roof covers (a gable's end wall, the wall under an eave) hold a parent by priority, but
      // the roof is laid over them: above the new roof cell they would stand through it, at it they would cut it.
      if (out.role[i] !== VOXEL_ROLE.roof && !(y >= want && out.material[i] !== MATERIAL_AIR && !openRole(out.role[i]!) && underRoof(grid, children, x, y, z))) continue;
      out.material[i] = MATERIAL_AIR;
      out.role[i] = VOXEL_ROLE.air;
      out.shape[i] = SHAPE_EMPTY;
      out.wetness[i] = 0;
    }
    const i = localIndex(grid, x, want, z);
    if (out.material[i] !== MATERIAL_AIR && !openRole(out.role[i]!)) continue;
    // The material of most of the finer top cells of that roof (ties: the lower id).
    let best = -1;
    let bestCount = 0;
    for (let c = 0; c < 4; c++) {
      const col = (2 * x + (c & 1)) * side + 2 * z + (c >> 1);
      if (colTop[col]! < 0 || colRoof[col] !== roof) continue;
      let count = 0;
      for (let d = 0; d < 4; d++) {
        const other = (2 * x + (d & 1)) * side + 2 * z + (d >> 1);
        if (colTop[other]! >= 0 && colRoof[other] === roof && colMat[other] === colMat[col]) count++;
      }
      if (best < 0 || count > bestCount || (count === bestCount && colMat[col]! < colMat[best]!)) {
        best = col;
        bestCount = count;
      }
    }
    out.material[i] = colMat[best]!;
    out.role[i] = VOXEL_ROLE.roof;
    out.shape[i] = SHAPE_FULL;
    out.wetness[i] = colWet[best]!;
    placed = true;
  }
  return placed;
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
  let roofs = false;
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
      if (same && roles[c0] === VOXEL_ROLE.roof) roofs = true;
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
      if (roleCells[VOXEL_ROLE.roof]! > 0) roofs = true;
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
  // Only a node with roof cells below it has a roof to lay again.
  if (roofs && relayRoofs(grid, children, out)) any = true;
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
