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
  /** Cells along x and z; each cell is {@link VOXEL_SIZE_M} square. */
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
export type HeightfieldRefusal = 'empty' | 'uncovered' | 'layers' | 'deviation';

/** Twice a triangle's signed area seen from above (x, z), counter-clockwise from +y positive. */
function upArea(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  // The y component of (b − a) × (c − a).
  return (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
}

/**
 * The ground surface as a heightfield over a chunk of `edge` cells, or why
 * not. `toleranceM` is the vertical distance allowed between the two.
 */
export function groundHeightfield(buf: SurfaceBuffer, edge: number, toleranceM = GROUND_HEIGHTFIELD_TOLERANCE_M): GroundHeightfield | HeightfieldRefusal {
  const tris = buf.indices.length / 3;
  if (buf.vertexCount === 0 || tris === 0) return 'empty';
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
  const tol = toleranceM / VOXEL_SIZE_M;
  // Triangles by the lattice nodes their footprint may hold, so a node finds the triangles over it.
  const buckets: number[][] = Array.from({ length: n * n }, () => []);
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3]!;
    const b = idx[t * 3 + 1]!;
    const c = idx[t * 3 + 2]!;
    // On edge seen from above (a step's riser): no height of its own; its corners and edges are checked below.
    if (upArea(px[a]!, pz[a]!, px[b]!, pz[b]!, px[c]!, pz[c]!) === 0) continue;
    const x0 = Math.max(0, Math.ceil(Math.min(px[a]!, px[b]!, px[c]!)));
    const x1 = Math.min(edge, Math.floor(Math.max(px[a]!, px[b]!, px[c]!)));
    const z0 = Math.max(0, Math.ceil(Math.min(pz[a]!, pz[b]!, pz[c]!)));
    const z1 = Math.min(edge, Math.floor(Math.max(pz[a]!, pz[b]!, pz[c]!)));
    for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) buckets[i * n + k]!.push(t);
  }
  // The surface's height at each node (NaN: none of this chunk's triangles is over it); heights that differ are two layers.
  const heights = new Float64Array(n * n).fill(NaN);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
    let h = NaN;
    for (const t of buckets[i * n + k]!) {
      const y = heightIn(idx, px, py, pz, t, i, k);
      if (y === null) continue;
      if (Number.isNaN(h)) h = y;
      else if (Math.abs(y - h) > tol) return 'layers';
    }
    heights[i * n + k] = h;
  }
  // A footprint edge's nodes may lie under the neighbour's triangles (the surface's vertices near a chunk face
  // are shared and may sit a little inside either chunk): the heightfield then starts one node in, and the
  // triangles between it and the face collide as they are.
  // A face's line is judged without the corners it shares with the faces across (those are judged with the rest below).
  const lineCovered = (fixed: number, alongX: boolean): boolean => {
    for (let j = 1; j < edge; j++) if (Number.isNaN(alongX ? heights[j * n + fixed]! : heights[fixed * n + j]!)) return false;
    return true;
  };
  const x0 = lineCovered(0, false) ? 0 : 1;
  const x1 = lineCovered(edge, false) ? edge : edge - 1;
  const z0 = lineCovered(0, true) ? 0 : 1;
  const z1 = lineCovered(edge, true) ? edge : edge - 1;
  if (x1 <= x0 || z1 <= z0) return 'uncovered';
  for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) if (Number.isNaN(heights[i * n + k]!)) return 'uncovered';
  const field = (x: number, z: number): number => {
    const i = Math.min(x1 - 1, Math.floor(x));
    const k = Math.min(z1 - 1, Math.floor(z));
    const fx = x - i;
    const fz = z - k;
    const h00 = heights[i * n + k]!;
    const h11 = heights[(i + 1) * n + k + 1]!;
    if (fx >= fz) return h00 + fx * (heights[(i + 1) * n + k]! - h00) + fz * (h11 - heights[(i + 1) * n + k]!);
    return h00 + fz * (heights[i * n + k + 1]! - h00) + fx * (h11 - heights[i * n + k + 1]!);
  };
  const over = (x: number, z: number): boolean => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  let worst = 0;
  const check = (x: number, y: number, z: number): void => {
    if (over(x, z)) worst = Math.max(worst, Math.abs(field(x, z) - y));
  };
  const rest: number[] = [];
  for (let t = 0; t < tris; t++) {
    let inside = true;
    for (let e = 0; e < 3; e++) {
      const a = idx[t * 3 + e]!;
      const b = idx[t * 3 + ((e + 1) % 3)]!;
      const ax = px[a]!;
      const az = pz[a]!;
      if (!over(ax, az)) inside = false;
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
    if (worst > tol) return 'deviation';
    if (!inside) rest.push(t);
  }
  const cellsX = x1 - x0;
  const cellsZ = z1 - z0;
  const out = new Float32Array((cellsX + 1) * (cellsZ + 1));
  for (let i = 0, o = 0; i <= cellsX; i++) for (let k = 0; k <= cellsZ; k++, o++) out[o] = heights[(x0 + i) * n + z0 + k]! * VOXEL_SIZE_M;
  return { x0, z0, cellsX, cellsZ, heights: out, deviationM: worst * VOXEL_SIZE_M, rest: Uint32Array.from(rest) };
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
