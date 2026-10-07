/**
 * The paint a block chunk's mesh carries — COLOR_0 the four layer weights,
 * COLOR_1.r the wetness, per vertex — made with the meshing (on the page and
 * in the mesh workers alike, so both give the same bytes).
 *
 * Without wall paint (the layer's `wallPaint` off) every vertex takes the
 * tops' lattice under it (`chunkPaintColors`), walls included: the bytes are
 * what they were before walls had paint of their own.
 *
 * With wall paint, a vertex whose normal faces sideways (a wall projection
 * of the box mapping) takes the wall points (`block-wall-paint.ts`) of the
 * plane nearest it, bilinear between the two points across and the two in
 * height around it; the column whose side it is comes from the vertex's
 * first triangle (a vertex at a wall's end is shared by no other wall). Over
 * the lip: where the wall belongs to a run of cells, its top row takes the
 * top's paint above it and fades to the wall's own one wall-point step down
 * (unpainted, that is grass wrapping over the edge onto rock). Tops and
 * bottoms keep the lattice.
 *
 * With material rules (`blockLayer.rules`, `surface-rules.ts`) every vertex
 * is a surface point — its world position, the slope and box-mapping side of
 * its normal, the cell of its first triangle, and for tops the cavity from
 * the layer's tops around it — and the rules' layers fill the paint's
 * unpainted share: a top's layer 0, a wall point's layer 1. Hand paint stays
 * over the rules; erasing it gives the ground back to them.
 */
import { blockTypeSlopes, rotatedFootprint, type BlockCell, type BlockType, type CellMetaValue } from './block-layers';
import type { BlockGridReader } from './block-grid';
import { chunkPaintColors, PAINT_CHANNELS, PAINT_CHUNK_SIZE } from './block-paint';
import { blockTopAt, cellCorners, subdividedHeightAt, surfaceBelow, type CellCorners } from './block-surface';
import type { SurfacePoint, SurfaceRuleSet } from './surface-rules';
import { projectionOf } from './block-mesh';
import { UNPAINTED_WALL, wallPaintSteps, wallPointKey, type WallPaint } from './block-wall-paint';

const CHUNK_SIZE = PAINT_CHUNK_SIZE;
/** Box-mapping projection (+X, −X, +Y, −Y, +Z, −Z) → wall side (+X, −X, +Z, −Z); −1 for tops and bottoms. */
const PROJ_SIDE = [0, 1, -1, -1, 2, 3];

/** What a chunk's paint colours depend on besides the grid. */
export interface ChunkPaintOptions {
  /** The layer's `wallPaint`. */
  readonly wallPaint: boolean;
  /** The layer's top subdivision (a lip follows the cut top). */
  readonly topSubdivision: number;
  /** The layer's material rules (absent: the paint alone). */
  readonly rules?: SurfaceRuleSet;
  /** The layer object's world position (the rules read world heights and positions; absent: the origin). */
  readonly origin?: readonly number[];
}

/** A mesh part's geometry (layer-local metres). */
export interface PaintedGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/** The paint colours of one mesh part of chunk (cx, cz) (see the module comment). */
export function chunkMeshPaint(grid: BlockGridReader, types: ReadonlyMap<string, BlockType>, cx: number, cz: number, options: ChunkPaintOptions, part: PaintedGeometry): { weights: Uint8Array; wetness: Uint8Array } {
  const cs = grid.cellSize;
  const out = chunkPaintColors(grid.chunkPaint(cx, cz), cx, cz, cs, part.positions);
  if (!options.wallPaint && options.rules === undefined) return out;
  const { positions: p, normals: n, indices } = part;
  const count = p.length / 3;
  // Each vertex's first triangle.
  const first = new Int32Array(count).fill(-1);
  for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) if (first[indices[t + k]!]! < 0) first[indices[t + k]!] = t;
  // The paint's unpainted share per vertex, that the rules fill: the tops' layer 0 (and on a painted wall its points' layer 1).
  const share0 = options.rules !== undefined ? new Float32Array(count) : null;
  const share1 = options.rules !== undefined ? new Float32Array(count) : null;
  if (share0 !== null) for (let i = 0; i < count; i++) share0[i] = out.weights[i * 4]!;
  if (options.wallPaint) paintWalls(grid, types, cx, cz, options, part, first, out, share0, share1);
  if (options.rules !== undefined) applyRules(grid, types, options.rules, options.origin ?? [0, 0, 0], part, first, out, share0!, share1!);
  return out;
}

/** The wall points over the wall vertices, the top's paint wrapping over the lip (see the module comment). */
function paintWalls(grid: BlockGridReader, types: ReadonlyMap<string, BlockType>, cx: number, cz: number, options: ChunkPaintOptions, part: PaintedGeometry, first: Int32Array, out: { weights: Uint8Array; wetness: Uint8Array }, share0: Float32Array | null, share1: Float32Array | null): void {
  const cs = grid.cellSize;
  const { positions: p, normals: n, indices } = part;
  const count = p.length / 3;
  const st = wallPaintSteps(cs);
  const stepY = cs[1]! / st.up;
  const value = new Float64Array(PAINT_CHANNELS);
  /** The top of each run of cells asked for, by the (column, row) asked from (vertices of one wall share it). */
  const runs = createRunTops(grid, types, options.topSubdivision, cx * CHUNK_SIZE, cz * CHUNK_SIZE);
  /** The wall points of the last column's chunk (a chunk's walls are mostly its own columns'). */
  let pointsKey = Number.NaN;
  let points: WallPaint | null = null;
  /** Snaps a coordinate that lies on a point line to it (float positions a hair off a whole step). */
  const snap = (v: number): number => (Math.abs(v - Math.round(v)) < 1e-4 ? Math.round(v) : v);
  for (let i = 0; i < count; i++) {
    const side = PROJ_SIDE[projectionOf(n[i * 3]!, n[i * 3 + 1]!, n[i * 3 + 2]!)]!;
    if (side < 0 || first[i]! < 0) continue;
    const t = first[i]!;
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const mx = (p[a]! + p[b]! + p[c]!) / 3;
    const my = (p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3;
    const mz = (p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3;
    const px = p[i * 3]!;
    const py = p[i * 3 + 1]!;
    const pz = p[i * 3 + 2]!;
    // The wall's plane (the nearest column border), the column whose side it is, and the place across it.
    let ox: number;
    let oz: number;
    let across: number;
    if (side < 2) {
      const plane = Math.round(px / cs[0]!);
      ox = side === 0 ? plane - 1 : plane;
      oz = Math.floor(mz / cs[2]!);
      across = snap((pz / cs[2]! - oz) * st.along);
    } else {
      const plane = Math.round(pz / cs[2]!);
      oz = side === 2 ? plane - 1 : plane;
      ox = Math.floor(mx / cs[0]!);
      across = snap((px / cs[0]! - ox) * st.along);
    }
    across = Math.max(0, Math.min(st.along, across));
    const up = snap(py / stepY);
    const j0 = Math.min(st.along - 1, Math.floor(across));
    const k0 = Math.floor(up);
    const fj = across - j0;
    const fk = up - k0;
    const occ = Math.floor(ox / CHUNK_SIZE);
    const ocz = Math.floor(oz / CHUNK_SIZE);
    if (occ * 65536 + ocz !== pointsKey) {
      pointsKey = occ * 65536 + ocz;
      points = grid.chunkWallPaint(occ, ocz);
    }
    const lx = ox - occ * CHUNK_SIZE;
    const lz = oz - ocz * CHUNK_SIZE;
    const p00 = pointAt(points, lx, lz, side, j0, k0);
    const p10 = pointAt(points, lx, lz, side, Math.min(st.along, j0 + 1), k0);
    const p01 = pointAt(points, lx, lz, side, j0, k0 + 1);
    const p11 = pointAt(points, lx, lz, side, Math.min(st.along, j0 + 1), k0 + 1);
    for (let ch = 0; ch < PAINT_CHANNELS; ch++) value[ch] = (p00[ch]! * (1 - fj) + p10[ch]! * fj) * (1 - fk) + (p01[ch]! * (1 - fj) + p11[ch]! * fj) * fk;
    // Over the lip: the top's paint (the lattice value already there) down to one step below the run's top.
    const top = runs.top(ox, oz, mx, my, mz, px, pz);
    const f = top === null ? 1 : Math.max(0, Math.min(1, (top - py) / stepY));
    if (share0 !== null) {
      share0[i] = out.weights[i * 4]! * (1 - f);
      share1![i] = value[1]! * f;
    }
    for (let ch = 0; ch < 4; ch++) out.weights[i * 4 + ch] = Math.round(out.weights[i * 4 + ch]! * (1 - f) + value[ch]! * f);
    out.wetness[i * 4] = Math.round(out.wetness[i * 4]! * (1 - f) + value[4]! * f);
  }
}

/**
 * The rules at every vertex poured into the paint's unpainted share
 * (`share0` of layer 0, `share1` of layer 1, out of 255): the weights become
 * the hand paint plus the share split by the rules, bytes summing to 255.
 */
function applyRules(grid: BlockGridReader, types: ReadonlyMap<string, BlockType>, rules: SurfaceRuleSet, origin: readonly number[], part: PaintedGeometry, first: Int32Array, out: { weights: Uint8Array; wetness: Uint8Array }, share0: Float32Array, share1: Float32Array): void {
  const cs = grid.cellSize;
  const { positions: p, normals: n, indices } = part;
  const count = p.length / 3;
  const layers: number[] = [];
  const weights: number[] = [];
  const rule = new Float64Array(4);
  const mixed = new Float64Array(4);
  let i = 0;
  let cell: BlockCell | null | undefined;
  /** The cell of the vertex's first triangle (its centroid, nudged into the block against its normal). */
  const cellOf = (): BlockCell | null => {
    if (cell !== undefined) return cell;
    const t = first[i]!;
    if (t < 0) return (cell = null);
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k]! * 3;
      mx += p[v]! / 3;
      my += p[v + 1]! / 3;
      mz += p[v + 2]! / 3;
    }
    const e = 0.01 * Math.min(cs[0]!, cs[1]!);
    return (cell = grid.get(Math.floor((mx - n[i * 3]! * e) / cs[0]!), Math.floor((my - n[i * 3 + 1]! * e) / cs[1]!), Math.floor((mz - n[i * 3 + 2]! * e) / cs[2]!)));
  };
  const point: SurfacePoint = {
    x: 0,
    y: 0,
    z: 0,
    slope: 0,
    wall: false,
    // The tops around (straight down from a little above): how far they lie above this vertex; walls and bottoms have none.
    cavity: (radius) => {
      if (point.wall || n[i * 3 + 1]! <= 0) return 0;
      const px = p[i * 3]!;
      const py = p[i * 3 + 1]!;
      const pz = p[i * 3 + 2]!;
      let sum = 0;
      let k = 0;
      for (const [dx, dz] of [[-radius, 0], [radius, 0], [0, -radius], [0, radius]] as const) {
        const hit = surfaceBelow(grid, types, px + dx, py + 2 * radius, pz + dz);
        if (hit === null) continue;
        sum += hit.height;
        k += 1;
      }
      return k === 0 ? 0 : sum / k - py;
    },
  };
  if (rules.readsCell) {
    point.meta = (key: string): CellMetaValue | undefined => {
      const c = cellOf();
      if (c === null) return undefined;
      return c.meta?.[key] ?? (c.block !== undefined ? types.get(c.block)?.metadata?.[key] : undefined);
    };
  }
  for (i = 0; i < count; i++) {
    cell = undefined;
    const nx = n[i * 3]!;
    const ny = n[i * 3 + 1]!;
    const nz = n[i * 3 + 2]!;
    point.x = origin[0]! + p[i * 3]!;
    point.y = origin[1]! + p[i * 3 + 1]!;
    point.z = origin[2]! + p[i * 3 + 2]!;
    point.slope = (Math.acos(Math.max(-1, Math.min(1, ny / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1)))) * 180) / Math.PI;
    point.wall = PROJ_SIDE[projectionOf(nx, ny, nz)]! >= 0;
    if (rules.readsCell) {
      const c = cellOf();
      if (c?.block !== undefined) point.block = c.block;
      else delete point.block;
    }
    const k = rules.evaluate(point, layers, weights);
    rule.fill(0);
    for (let j = 0; j < k; j++) if (layers[j]! < 4) rule[layers[j]!] = rule[layers[j]!]! + weights[j]! / 255;
    const s0 = share0[i]!;
    const s1 = share1[i]!;
    const share = s0 + s1;
    for (let ch = 0; ch < 4; ch++) mixed[ch] = out.weights[i * 4 + ch]! - (ch === 0 ? s0 : ch === 1 ? s1 : 0) + share * rule[ch]!;
    // Bytes summing to 255: rounded, the remainder to the largest.
    let sum = 0;
    let big = 0;
    for (let ch = 0; ch < 4; ch++) {
      const b = Math.max(0, Math.min(255, Math.round(mixed[ch]!)));
      out.weights[i * 4 + ch] = b;
      sum += b;
      if (b > out.weights[i * 4 + big]!) big = ch;
    }
    out.weights[i * 4 + big] = Math.max(0, Math.min(255, out.weights[i * 4 + big]! + 255 - sum));
  }
}

/** A wall point's bytes (unpainted when not stored). */
function pointAt(points: WallPaint | null, lx: number, lz: number, side: number, j: number, k: number): readonly number[] | Uint8Array {
  if (points === null || points.size === 0) return UNPAINTED_WALL;
  return points.get(wallPointKey(lx, lz, side, j, k)) ?? UNPAINTED_WALL;
}

/**
 * The tops of runs of cells: `top(x, z, …)` is the height (layer metres) of
 * the top of the run of cells in column (x, z) that the triangle with
 * centroid (mx, my, mz) is a side of, at (px, pz); null when the triangle is
 * not beside a cell of the column (an edge piece standing above the ground).
 * A sloped cell reaches into the empty rows above it, so the rows below are
 * looked at for one reaching the centroid. Runs found are kept: the many
 * vertices of one wall ask for the same one.
 */
function createRunTops(grid: BlockGridReader, types: ReadonlyMap<string, BlockType>, subdivision: number, x0: number, z0: number): { top(x: number, z: number, mx: number, my: number, mz: number, px: number, pz: number): number | null } {
  const cs = grid.cellSize;
  /** The run's top cell: its row and how its top is measured (a flat height, or corners). */
  interface RunTop {
    readonly row: number;
    readonly flat: number;
    readonly corners: CellCorners | null;
  }
  const known = new Map<number, RunTop | null>();
  const has = (x: number, y: number, z: number): boolean => grid.get(x, y, z)?.block !== undefined;
  const topOf = (x: number, y: number, z: number): RunTop => {
    const cell = grid.get(x, y, z)!;
    const t = types.get(cell.block!);
    if (t === undefined) return { row: y, flat: (y + 1) * cs[1]!, corners: null };
    const f = rotatedFootprint(t, 0);
    if (f[0] !== 1 || f[1] !== 1 || f[2] !== 1) return { row: y, flat: (y + 1) * cs[1]!, corners: null };
    const corners = blockTypeSlopes(t) ? cellCorners(cell) : null;
    if (corners !== null) return { row: y, flat: 0, corners };
    // Other shapes: their top at the cell's middle (a half block, a ramp's mean, stairs' upper step).
    const sample = blockTopAt(t, cell, cs, 0, 0);
    return { row: y, flat: y * cs[1]! + (sample?.height ?? cs[1]!), corners: null };
  };
  const heightOf = (r: RunTop, x: number, z: number, atx: number, atz: number): number => {
    if (r.corners === null) return r.flat;
    const u = Math.min(1, Math.max(0, atx / cs[0]! - x));
    const v = Math.min(1, Math.max(0, atz / cs[2]! - z));
    return (r.row + subdividedHeightAt(r.corners, subdivision, u, v)) * cs[1]!;
  };
  return {
    top(x, z, mx, my, mz, px, pz) {
      const row = Math.floor(my / cs[1]! + 1e-9);
      // Small integer keys (fast to look up): columns near the chunk's corner (x0, z0), rows within the layer's ±1,024.
      const key = ((x - x0 + 64) * 256 + (z - z0 + 64)) * 4096 + row + 2048;
      let run = known.get(key);
      if (run === undefined) {
        if (has(x, row, z)) {
          let y = row;
          while (has(x, y + 1, z)) y += 1;
          run = topOf(x, y, z);
        } else run = null;
        known.set(key, run);
      }
      if (run !== null) return heightOf(run, x, z, px, pz);
      // A sloped cell below whose top reaches the centroid.
      for (let d = 1; d <= 4; d++) {
        const cell = grid.get(x, row - d, z);
        if (cell?.block === undefined || cell.corners === undefined) continue;
        const r = topOf(x, row - d, z);
        if (r.corners !== null && heightOf(r, x, z, mx, mz) >= my) return heightOf(r, x, z, px, pz);
      }
      return null;
    },
  };
}
