/**
 * A chunk's projected ground surface as a heightfield, when it is one.
 *
 * A heightfield costs a physics engine far less than the same ground as a
 * triangle mesh (one height a lattice node instead of vertices, indices and
 * a tree over the triangles), so a chunk whose ground is a height function
 * over its footprint collides as one. The surface-nets ground puts a vertex
 * on the cell-corner lattice wherever the surface crosses only vertical
 * sample edges, and off it where a contour crosses a sample layer, so a
 * lattice heightfield is the ground exactly on level patches and within a
 * few centimetres of it on slopes. It is used only when it is within a
 * tolerance of the surface everywhere over it:
 *
 * - no triangle faces down (the underside of an overhang or a ledge, or the
 *   bottom of the world's ground);
 * - every lattice node it covers lies under exactly one height of the
 *   surface: none means the ground leaves the chunk through its top or
 *   bottom there, two (more than the tolerance apart) an overhang or a
 *   second layer. The surface's vertices near a chunk face are shared with
 *   the neighbour and may sit a little inside either chunk, so a face's
 *   nodes may lie under the neighbour's triangles: the heightfield then
 *   starts one node in from that face, and the triangles not wholly over
 *   it collide as they are ({@link GroundHeightfield.rest});
 * - the largest vertical distance between the surface's triangles and the
 *   heightfield, over the heightfield, is within the tolerance. Both are
 *   piecewise linear, so that distance is largest at a vertex of their
 *   overlay: a triangle's corners, the lattice nodes under it, and where
 *   its edges cross the heightfield's edges (the lattice lines and the cell
 *   diagonals); all are checked, nothing is sampled. A step's riser (a
 *   triangle on edge seen from above) has no height of its own and is
 *   checked by its corners and edges like any other triangle.
 *
 * Where only part of a chunk's ground is a height function (ground leaving
 * the chunk through its top or bottom, a cliff or an overhang in one part),
 * the same tests are made a lattice cell at a time and the cells that pass
 * are covered by rectangular patches ({@link groundHeightfieldPatches}).
 *
 * A heightfield cell is split along its diagonal from (min x, min z) to
 * (+x, +z), the diagonal the surface nets split their quads along.
 */
import { VOXEL_SIZE_M } from './coords';
import { POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, type SurfaceBuffer } from './derived-mesh';

/** How far (metres, vertically) a heightfield may lie from the ground surface it stands for. */
export const GROUND_HEIGHTFIELD_TOLERANCE_M = 0.005;

/**
 * A ground surface's heightfield over (most of) its chunk's footprint, and
 * the triangles it does not stand for.
 */
export interface GroundHeightfield {
  /** The heightfield's first lattice node (cells from the chunk's corner, 0 or 1). */
  readonly x0: number;
  readonly z0: number;
  /** Cells along x and z; each cell is the surface's cell square ({@link VOXEL_SIZE_M} at level 0). */
  readonly cellsX: number;
  readonly cellsZ: number;
  /** (cellsX + 1) · (cellsZ + 1) heights, metres from the chunk's corner, x-major: node (i, k) at i · (cellsZ + 1) + k. */
  readonly heights: Float32Array;
  /** The largest vertical distance between the heightfield and the surface over it, metres. */
  readonly deviationM: number;
  /** Triangles (by their index in the surface) not wholly over the heightfield: they collide as they are. */
  readonly rest: Uint32Array;
}

/** Why a ground surface is not a heightfield (for measurements). */
export type HeightfieldRefusal = 'empty' | 'facing' | 'uncovered' | 'layers' | 'deviation';

/** Twice a triangle's signed area seen from above (x, z), counter-clockwise from +y positive. */
function upArea(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  // The y component of (b − a) × (c − a).
  return (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
}

/** Cells a heightfield patch covers at least: a smaller patch costs a physics engine more than its triangles as a mesh. */
export const MIN_HEIGHTFIELD_PATCH_CELLS = 16;

/**
 * A ground surface read against the lattice of its chunk: each node's
 * height, and which cells a heightfield stands for within the tolerance.
 */
interface GroundLattice {
  readonly n: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  /** Heights (cells) a node (NaN: no triangle of this chunk over it). */
  readonly heights: Float64Array;
  /** Nodes under two heights more than the tolerance apart (an overhang, a second layer). */
  readonly layered: Uint8Array;
  /** Cells under a triangle facing down (an underside). */
  readonly under: Uint8Array;
  /** Cells whose four nodes have one height each and over which the surface is within the tolerance of the field. */
  readonly ok: Uint8Array;
  /** The largest vertical distance (cells) between the surface and the field over each cell that is ok. */
  readonly dev: Float64Array;
  readonly facing: boolean;
  readonly layers: boolean;
  readonly tris: number;
}

function readLattice(buf: SurfaceBuffer, edge: number, tol: number): GroundLattice {
  const tris = buf.indices.length / 3;
  const S = POSITION_STEPS_PER_CELL;
  const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
  // Positions in cells from the chunk's corner (the buffer counts from one cell below it).
  const px = new Float64Array(buf.vertexCount);
  const py = new Float64Array(buf.vertexCount);
  const pz = new Float64Array(buf.vertexCount);
  for (let v = 0; v < buf.vertexCount; v++) {
    const at = v * SURFACE_VERTEX_BYTES;
    px[v] = view.getUint16(at, true) / S - 1;
    py[v] = view.getUint16(at + 2, true) / S - 1;
    pz[v] = view.getUint16(at + 4, true) / S - 1;
  }
  const idx = buf.indices;
  const n = edge + 1;
  // Twice the footprint of a riser triangle leaning by a few steps over two cells: no area of its own.
  const riser = 4 / S;
  const under = new Uint8Array(edge * edge);
  let facing = false;
  // Triangles by the lattice nodes their footprint may hold, so a node finds the triangles over it.
  const buckets: number[][] = Array.from({ length: n * n }, () => []);
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3]!;
    const b = idx[t * 3 + 1]!;
    const c = idx[t * 3 + 2]!;
    const area = upArea(px[a]!, pz[a]!, px[b]!, pz[b]!, px[c]!, pz[c]!);
    // On edge seen from above (a step's riser): no height of its own; its corners and edges are checked below. A riser
    // may lean a few position steps either way (vertices off the lattice are kept a step off its lines), which is
    // not an underside.
    if (Math.abs(area) <= riser) continue;
    const lx = Math.min(px[a]!, px[b]!, px[c]!);
    const hx = Math.max(px[a]!, px[b]!, px[c]!);
    const lz = Math.min(pz[a]!, pz[b]!, pz[c]!);
    const hz = Math.max(pz[a]!, pz[b]!, pz[c]!);
    if (area < 0) {
      // Facing down: the underside of ground (an overhang, a ledge, the bottom of the world's ground), never a
      // heightfield's top; no cell it lies over is one.
      facing = true;
      for (let i = Math.max(0, Math.floor(lx)); i < Math.min(edge, Math.ceil(hx)); i++) for (let k = Math.max(0, Math.floor(lz)); k < Math.min(edge, Math.ceil(hz)); k++) under[i * edge + k] = 1;
      continue;
    }
    for (let i = Math.max(0, Math.ceil(lx)); i <= Math.min(edge, Math.floor(hx)); i++) for (let k = Math.max(0, Math.ceil(lz)); k <= Math.min(edge, Math.floor(hz)); k++) buckets[i * n + k]!.push(t);
  }
  // The surface's height at each node; heights that differ are two layers.
  const heights = new Float64Array(n * n).fill(NaN);
  const layered = new Uint8Array(n * n);
  let layers = false;
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
    let h = NaN;
    for (const t of buckets[i * n + k]!) {
      const y = heightIn(idx, px, py, pz, t, i, k);
      if (y === null) continue;
      if (Number.isNaN(h)) h = y;
      else if (Math.abs(y - h) > tol) {
        layered[i * n + k] = 1;
        layers = true;
      }
    }
    heights[i * n + k] = h;
  }
  const ok = new Uint8Array(edge * edge);
  const dev = new Float64Array(edge * edge);
  for (let i = 0; i < edge; i++) for (let k = 0; k < edge; k++) {
    const a = i * n + k;
    const nodes = [a, a + 1, a + n, a + n + 1];
    ok[i * edge + k] = under[i * edge + k] === 0 && nodes.every((m) => !Number.isNaN(heights[m]!) && layered[m] === 0) ? 1 : 0;
  }
  // The largest vertical distance between the surface and the field is at a vertex of their overlay: a triangle's
  // corners, the lattice nodes under it (exact by construction) and where its edges cross the lattice lines and the
  // cell diagonals. Each such point is checked in every cell it lies in.
  const check = (x: number, y: number, z: number): void => {
    const i0 = Math.floor(x);
    const k0 = Math.floor(z);
    for (let i = Number.isInteger(x) ? i0 - 1 : i0; i <= i0; i++) for (let k = Number.isInteger(z) ? k0 - 1 : k0; k <= k0; k++) {
      if (i < 0 || k < 0 || i >= edge || k >= edge || ok[i * edge + k] === 0) continue;
      const fx = x - i;
      const fz = z - k;
      const h00 = heights[i * n + k]!;
      const h10 = heights[(i + 1) * n + k]!;
      const h01 = heights[i * n + k + 1]!;
      const h11 = heights[(i + 1) * n + k + 1]!;
      const f = fx >= fz ? h00 + fx * (h10 - h00) + fz * (h11 - h10) : h00 + fz * (h01 - h00) + fx * (h11 - h01);
      const d = Math.abs(f - y);
      if (d > tol) ok[i * edge + k] = 0;
      else if (d > dev[i * edge + k]!) dev[i * edge + k] = d;
    }
  };
  for (let t = 0; t < tris; t++) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t * 3 + e]!;
      const b = idx[t * 3 + ((e + 1) % 3)]!;
      const ax = px[a]!;
      const az = pz[a]!;
      check(ax, py[a]!, az);
      // Where the edge crosses a lattice line (x or z whole) or a cell diagonal (x − z whole).
      const dx = px[b]! - ax;
      const dz = pz[b]! - az;
      const dy = py[b]! - py[a]!;
      for (const [p, d] of [[ax, dx], [az, dz], [ax - az, dx - dz]] as const) {
        if (d === 0) continue;
        const lo = Math.ceil(Math.min(p, p + d));
        const hi = Math.floor(Math.max(p, p + d));
        for (let w = lo; w <= hi; w++) {
          const s = (w - p) / d;
          if (s > 0 && s < 1) check(ax + dx * s, py[a]! + dy * s, az + dz * s);
        }
      }
    }
  }
  return { n, px, py, pz, heights, layered, under, ok, dev, facing, layers, tris };
}

/** The field over cells [x0, x1) × [z0, z1) of the lattice, with the triangles not wholly over it. */
function fieldOf(g: GroundLattice, edge: number, x0: number, z0: number, x1: number, z1: number, cellMetres: number): Omit<GroundHeightfield, 'rest'> {
  const cellsX = x1 - x0;
  const cellsZ = z1 - z0;
  const out = new Float32Array((cellsX + 1) * (cellsZ + 1));
  for (let i = 0, o = 0; i <= cellsX; i++) for (let k = 0; k <= cellsZ; k++, o++) out[o] = g.heights[(x0 + i) * g.n + z0 + k]! * cellMetres;
  let worst = 0;
  for (let i = x0; i < x1; i++) for (let k = z0; k < z1; k++) worst = Math.max(worst, g.dev[i * edge + k]!);
  return { x0, z0, cellsX, cellsZ, heights: out, deviationM: worst * cellMetres };
}

/** Whether triangle t lies wholly over cells [x0, x1] × [z0, z1] (its corners within). */
function within(g: GroundLattice, idx: ArrayLike<number>, t: number, x0: number, z0: number, x1: number, z1: number): boolean {
  for (let e = 0; e < 3; e++) {
    const v = idx[t * 3 + e]!;
    if (g.px[v]! < x0 || g.px[v]! > x1 || g.pz[v]! < z0 || g.pz[v]! > z1) return false;
  }
  return true;
}

/**
 * The ground surface as a heightfield over a chunk of `edge` cells, or why
 * not. `toleranceM` is the vertical distance allowed between the two;
 * `cellMetres` the edge of the surface's cells (a mip node's are coarser,
 * coords.ts `mipCellMetres`).
 */
export function groundHeightfield(buf: SurfaceBuffer, edge: number, toleranceM = GROUND_HEIGHTFIELD_TOLERANCE_M, cellMetres = VOXEL_SIZE_M): GroundHeightfield | HeightfieldRefusal {
  if (buf.vertexCount === 0 || buf.indices.length === 0) return 'empty';
  const tol = toleranceM / cellMetres;
  const g = readLattice(buf, edge, tol);
  if (g.facing) return 'facing';
  if (g.layers) return 'layers';
  const n = g.n;
  // A footprint edge's nodes may lie under the neighbour's triangles (the surface's vertices near a chunk face
  // are shared and may sit a little inside either chunk): the heightfield then starts one node in, and the
  // triangles between it and the face collide as they are.
  // A face's line is judged without the corners it shares with the faces across (those are judged with the rest below).
  const lineCovered = (fixed: number, alongX: boolean): boolean => {
    for (let j = 1; j < edge; j++) if (Number.isNaN(alongX ? g.heights[j * n + fixed]! : g.heights[fixed * n + j]!)) return false;
    return true;
  };
  const x0 = lineCovered(0, false) ? 0 : 1;
  const x1 = lineCovered(edge, false) ? edge : edge - 1;
  const z0 = lineCovered(0, true) ? 0 : 1;
  const z1 = lineCovered(edge, true) ? edge : edge - 1;
  if (x1 <= x0 || z1 <= z0) return 'uncovered';
  for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) if (Number.isNaN(g.heights[i * n + k]!)) return 'uncovered';
  for (let i = x0; i < x1; i++) for (let k = z0; k < z1; k++) if (g.ok[i * edge + k] === 0) return 'deviation';
  const rest: number[] = [];
  for (let t = 0; t < g.tris; t++) if (!within(g, buf.indices, t, x0, z0, x1, z1)) rest.push(t);
  return { ...fieldOf(g, edge, x0, z0, x1, z1, cellMetres), rest: Uint32Array.from(rest) };
}

/** How {@link groundHeightfieldPatches} reads a surface. */
export interface HeightfieldPatchOptions {
  /** Vertical distance allowed between field and surface, metres (default {@link GROUND_HEIGHTFIELD_TOLERANCE_M}). */
  readonly toleranceM?: number;
  /** The edge of the surface's cells, metres (a mip node's are coarser, coords.ts `mipCellMetres`). */
  readonly cellMetres?: number;
  /** The fewest cells a patch covers (default {@link MIN_HEIGHTFIELD_PATCH_CELLS}). */
  readonly minCells?: number;
  /** Level cells only (every node of a patch one height). */
  readonly levelOnly?: boolean;
}

/** The ground's heightfield patches and the triangles none of them stands for. */
export interface GroundHeightfieldPatches {
  readonly patches: readonly Omit<GroundHeightfield, 'rest'>[];
  /** Triangles (by their index in the surface) not wholly over one patch: they collide as they are. */
  readonly rest: Uint32Array;
}

/**
 * The ground surface as heightfield patches wherever it is a height function
 * within the tolerance, the rest as it is. Each cell of the chunk's lattice
 * whose four nodes have one height each, under no underside and over which
 * the surface lies within the tolerance of the field, may be part of a
 * patch; such cells are covered by rectangles (greedy: along x, then grown
 * along z), and a rectangle of fewer than {@link MIN_HEIGHTFIELD_PATCH_CELLS}
 * cells stays triangles. So ground that leaves the chunk through its top or
 * bottom, a cliff, a terrace or an overhang in one corner keeps the rest of
 * the chunk a heightfield.
 */
export function groundHeightfieldPatches(buf: SurfaceBuffer, edge: number, options: HeightfieldPatchOptions = {}): GroundHeightfieldPatches {
  const tris = buf.indices.length / 3;
  if (buf.vertexCount === 0 || tris === 0) return { patches: [], rest: new Uint32Array(0) };
  const cellMetres = options.cellMetres ?? VOXEL_SIZE_M;
  const minCells = options.minCells ?? MIN_HEIGHTFIELD_PATCH_CELLS;
  const g = readLattice(buf, edge, (options.toleranceM ?? GROUND_HEIGHTFIELD_TOLERANCE_M) / cellMetres);
  const free = Uint8Array.from(g.ok);
  if (options.levelOnly === true) {
    const n = g.n;
    for (let i = 0; i < edge; i++) for (let k = 0; k < edge; k++) {
      const h = g.heights[i * n + k]!;
      if (g.heights[i * n + k + 1] !== h || g.heights[(i + 1) * n + k] !== h || g.heights[(i + 1) * n + k + 1] !== h) free[i * edge + k] = 0;
    }
  }
  const rects: Array<[number, number, number, number]> = [];
  for (let k = 0; k < edge; k++) for (let i = 0; i < edge; i++) {
    if (free[i * edge + k] === 0) continue;
    let i1 = i;
    while (i1 < edge && free[i1 * edge + k] === 1) i1++;
    let k1 = k + 1;
    for (; k1 < edge; k1++) {
      let row = true;
      for (let x = i; x < i1 && row; x++) row = free[x * edge + k1] === 1;
      if (!row) break;
    }
    for (let x = i; x < i1; x++) for (let z = k; z < k1; z++) free[x * edge + z] = 0;
    if ((i1 - i) * (k1 - k) >= minCells) rects.push([i, k, i1, k1]);
  }
  const patches = rects.map(([x0, z0, x1, z1]) => fieldOf(g, edge, x0, z0, x1, z1, cellMetres));
  const rest: number[] = [];
  for (let t = 0; t < tris; t++) if (!rects.some(([x0, z0, x1, z1]) => within(g, buf.indices, t, x0, z0, x1, z1))) rest.push(t);
  return { patches, rest: Uint32Array.from(rest) };
}

/** Triangle t's height (cells) over the point (x, z), or null when the point is outside its footprint. */
function heightIn(idx: ArrayLike<number>, px: Float64Array, py: Float64Array, pz: Float64Array, t: number, x: number, z: number): number | null {
  const a = idx[t * 3]!;
  const b = idx[t * 3 + 1]!;
  const c = idx[t * 3 + 2]!;
  const area = upArea(px[a]!, pz[a]!, px[b]!, pz[b]!, px[c]!, pz[c]!);
  if (area === 0) return null;
  const wa = upArea(x, z, px[b]!, pz[b]!, px[c]!, pz[c]!) / area;
  const wb = upArea(px[a]!, pz[a]!, x, z, px[c]!, pz[c]!) / area;
  const wc = 1 - wa - wb;
  const eps = 1e-9;
  if (wa < -eps || wb < -eps || wc < -eps) return null;
  return wa * py[a]! + wb * py[b]! + wc * py[c]!;
}
