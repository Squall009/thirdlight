/**
 * Per-vertex ambient occlusion of a block chunk's mesh (`blockLayer.vertexAO`):
 * how closed in each vertex's corner is by neighbouring blocks, as a factor of
 * its indirect light (1: open, down to 1 − strength: a corner closed on three
 * sides). Made with the meshing (page and mesh workers alike, the same
 * bytes), so it costs nothing per frame, and every lit material takes it
 * without a material of its own (the renderer reads the vertex attribute in
 * its lighting).
 *
 * The classic voxel corner test, done at any vertex: from the vertex, half a
 * cell out along its normal, four points a little short of a cell away in the
 * plane across the normal are tested for blocks. A floor vertex at the foot
 * of a wall finds the wall in two of them, one in an inside corner three; a
 * vertex out in the open none. The plane follows the surface (a slope's
 * samples lie along the slope), and a point is in a block when it is under
 * that block's top there — a full block's whole cell, a half block's lower
 * half, under a ramp's slope or a hill's sloped top — so rolling ground is
 * never darkened by its own steps, while a wall standing in a hill is
 * darkened where the hill meets it. A full edge piece (a wall or door made
 * of edges) closes the half cell either side of it, counting half (it closes
 * both sides of its line). Larger blocks' footprints close nothing. The
 * darkening runs over one cell, as the stand-in faces are cell-sized; a model
 * look is shaded at its own vertices by the same test.
 *
 * Pure: the grid (a kit view shows the swapped blocks), the types, a mesh
 * part's positions and normals in, one float per vertex out.
 */
import { blockTypeSlopes, blockTypeSolid, rotatedFootprint, type BlockCell, type BlockType } from './block-layers';
import { cellKeyOf, type BlockGridReader } from './block-grid';
import { blockTypeIsEdge } from './block-edges';
import { blockTopAt, cellCorners } from './block-surface';

/** How far a sample lies along the plane (a share of the cell): short of the neighbouring cell's centre, off the cell borders a vertex mid-face sits on. */
const SAMPLE_REACH = 0.45;
/** How near an edge piece's plane a point is closed by it (a share of the cell): the half cell either side, so the samples round a vertex on its line find it. */
const EDGE_REACH = 0.5;
/** What a sample closed by an edge piece counts (a thin wall closes both sides of its line: four half samples shade its foot as a cell wall's two shade one side). */
const EDGE_WEIGHT = 0.5;
/** Closed samples that make a fully closed corner (of four; the fourth is the face's own open side). */
const CLOSED_CORNER = 3;
/** The highest a sloped top reaches above its own row (corner heights are 0-4 rows). */
const SLOPE_REACH_ROWS = 4;

/** A part's geometry (layer-local metres). */
export interface AoGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
}

/** What a cell holds for the test: nothing, a block filling it, or a shaped block (its top decides; `reach`: rows its top may rise to). */
type CellFill = null | true | { readonly type: BlockType; readonly cell: BlockCell; readonly reach: number };

/** The occlusion factor per vertex of one mesh part (see the module comment); `strength` 0-1. */
export function chunkMeshAO(grid: BlockGridReader, types: ReadonlyMap<string, BlockType>, part: AoGeometry, strength: number): Float32Array {
  const cs = grid.cellSize;
  const { positions: p, normals: n } = part;
  const count = p.length / 3;
  const out = new Float32Array(count).fill(1);
  if (!(strength > 0)) return out;
  /** What each cell holds (cached per call: neighbouring vertices test the same cells). */
  const fills = new Map<number, CellFill>();
  const fillOf = (x: number, y: number, z: number): CellFill => {
    const k = cellKeyOf(x, y, z);
    let v = fills.get(k);
    if (v === undefined) {
      const c = grid.get(x, y, z);
      const t = c?.block !== undefined ? types.get(c.block) : undefined;
      if (c === null || t === undefined || blockTypeIsEdge(t) || t.shape === 'none') v = null;
      else {
        const f = rotatedFootprint(t, c.rot);
        const corners = cellCorners(c);
        if (f[0] !== 1 || f[1] !== 1 || f[2] !== 1) v = null;
        else if (blockTypeSolid(t) && corners === null) v = true;
        else v = { type: t, cell: c, reach: corners !== null && blockTypeSlopes(t) ? Math.max(1, ...corners) : 1 };
      }
      fills.set(k, v);
    }
    return v;
  };
  /** Whether a point lies under the top of the block in cell (x, y, z). */
  const under = (x: number, y: number, z: number, px: number, py: number, pz: number): boolean => {
    const f = fillOf(x, y, z);
    if (f === null) return false;
    if (f === true) return py < (y + 1) * cs[1]!;
    const top = blockTopAt(f.type, f.cell, cs, px - (x + 0.5) * cs[0]!, pz - (z + 0.5) * cs[2]!);
    return top !== null && py < y * cs[1]! + top.height;
  };
  const hasEdges = grid.edgeCount > 0;
  /** Whether a full edge piece stands on an edge (cached per call as the cells are). */
  const edges = new Map<number, boolean>();
  const edgeFull = (x: number, y: number, z: number, axis: number): boolean => {
    const k = cellKeyOf(x, y, z) * 2 + axis;
    let v = edges.get(k);
    if (v === undefined) {
      const e = grid.edgeAt(x, y, z, axis);
      v = e !== null && types.get(e.block)?.shape === 'full';
      edges.set(k, v);
    }
    return v;
  };
  /** How much a layer-local point is closed: 1 under a block's top, `EDGE_WEIGHT` beside a full edge piece, else 0. */
  const closed = (px: number, py: number, pz: number): number => {
    const fx = px / cs[0]!;
    const fy = py / cs[1]!;
    const fz = pz / cs[2]!;
    const x = Math.floor(fx);
    const y = Math.floor(fy);
    const z = Math.floor(fz);
    if (under(x, y, z, px, py, pz)) return 1;
    // A sloped top below may reach up into this empty cell.
    if (fillOf(x, y, z) === null) {
      for (let d = 1; d <= SLOPE_REACH_ROWS; d++) {
        const f = fillOf(x, y - d, z);
        if (f === null) continue;
        if (f !== true && f.reach > d && under(x, y - d, z, px, py, pz)) return 1;
        break;
      }
    }
    if (!hasEdges) return 0;
    const u = fx - x;
    const w = fz - z;
    const edge = (u < EDGE_REACH && edgeFull(x, y, z, 0)) || (u >= 1 - EDGE_REACH && edgeFull(x + 1, y, z, 0)) || (w < EDGE_REACH && edgeFull(x, y, z, 1)) || (w >= 1 - EDGE_REACH && edgeFull(x, y, z + 1, 1));
    return edge ? EDGE_WEIGHT : 0;
  };
  for (let i = 0; i < count; i++) {
    const nx = n[i * 3]!;
    const ny = n[i * 3 + 1]!;
    const nz = n[i * 3 + 2]!;
    // Half a cell out along the normal.
    const ox = p[i * 3]! + nx * cs[0]! * 0.5;
    const oy = p[i * 3 + 1]! + ny * cs[1]! * 0.5;
    const oz = p[i * 3 + 2]! + nz * cs[2]! * 0.5;
    // The plane across the normal: t1 from the first axis that is not its main one (made square to the normal), t2 = n × t1.
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    const main = ay >= ax && ay >= az ? 1 : ax >= az ? 0 : 2;
    const a = main === 0 ? 1 : 0;
    const na = a === 0 ? nx : ny;
    let t1x = (a === 0 ? 1 : 0) - na * nx;
    let t1y = (a === 1 ? 1 : 0) - na * ny;
    let t1z = -na * nz;
    const l1 = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z) || 1;
    t1x /= l1;
    t1y /= l1;
    t1z /= l1;
    const t2x = ny * t1z - nz * t1y;
    const t2y = nz * t1x - nx * t1z;
    const t2z = nx * t1y - ny * t1x;
    // A cell's reach along each (a cell is no cube when its height differs from its width).
    const r1 = SAMPLE_REACH * Math.sqrt((t1x * cs[0]!) ** 2 + (t1y * cs[1]!) ** 2 + (t1z * cs[2]!) ** 2);
    const r2 = SAMPLE_REACH * Math.sqrt((t2x * cs[0]!) ** 2 + (t2y * cs[1]!) ** 2 + (t2z * cs[2]!) ** 2);
    let shut = 0;
    for (let sa = -1; sa <= 1; sa += 2) {
      for (let sb = -1; sb <= 1; sb += 2) {
        shut += closed(ox + sa * r1 * t1x + sb * r2 * t2x, oy + sa * r1 * t1y + sb * r2 * t2y, oz + sa * r1 * t1z + sb * r2 * t2z);
      }
    }
    if (shut > 0) out[i] = 1 - strength * Math.min(1, shut / CLOSED_CORNER);
  }
  return out;
}
