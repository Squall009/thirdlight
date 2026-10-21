/**
 * A block layer's collision on the 2D plane: the same collision shapes the
 * 3D chunk collider is built from (`collisionLooks`, so every shape, sloped
 * corners, footprints and edge pieces count without code of their own), cut
 * by the play plane z = `planeZ` into convex 2D pieces the 2D physics world
 * takes as polygons.
 *
 * The cut: each collision triangle crossing the plane gives a segment in
 * (x, y). Seen along a vertical line, a segment of a downward-facing
 * triangle enters the solid and one of an upward-facing triangle leaves it.
 * Splitting x at every segment end, and where two segments cross, gives
 * slabs no segment ends or crosses inside; in each slab, the segments sorted
 * by height and counted (nonzero rule, never below zero) give the solid's
 * spans as trapezoids with vertical sides. Segments do cross: shapes may
 * overlap (an edge piece reaches half its thickness into the cells either
 * side of its line, a kit's collision mesh past its cell), and the cut meshes
 * every shape whole, so a face of one runs through the other.
 * Trapezoids of neighbouring slabs whose top and bottom run on as one line
 * are merged, so a flat run of ground is one box per chunk, a slope over
 * several cells one piece, a staircase a box per step.
 *
 * Why solid pieces, not outlines: the 2D world's queries (overlap, rays
 * from inside) and its one-way and internal-edge rules work on convex solid
 * colliders; a polyline has no inside, and a character on a polyline seam
 * snags where the port's internal-edge rule cannot see the solid behind it.
 * Pieces sharing a vertical side are the "tiles in a row" that rule handles.
 *
 * Half-open rows: the plane lies in the cell row z = floor(local z / cell
 * depth), as `ctx.grid.surface` reads it. On a row boundary the cut takes
 * the row in front (+z): a point exactly on the plane counts as behind it,
 * so a triangle of the row behind touches the plane without crossing it and
 * a face lying in the plane cuts nothing. Edge pieces on a z line run along
 * the plane, never across it: they are left out (a fence along the front of
 * a side view is scenery); those on an x line cut to thin walls.
 *
 * Pure geometry, deterministic: the same cells give the same pieces in the
 * same order on every thread.
 */
import { CHUNK_SIZE, rotatedFootprint, type BlockType } from './block-layers';
import type { BlockGridReader } from './block-grid';
import { MESH_WELD, collisionLooks, meshBlockChunk, type ChunkMeshPart } from './block-mesh';
import { MAX_COLLIDER_EXTENT, MIN_POLYGON_AREA } from './collider-shapes';

/** One convex piece: its centre (layer-local metres) and its corners counter-clockwise around it. */
export interface PlaneCutPiece {
  x: number;
  y: number;
  vertices: [number, number][];
}

/** A chunk's pieces: solid ones, and one-way ones (each its own collider, so its top is its own). */
export interface PlaneCutChunk {
  solid: PlaneCutPiece[];
  oneWay: PlaneCutPiece[];
}

/** Two heights or slopes closer than this (metres) are one. */
const SAME = 1e-4;
/** The widest and tallest a piece is made (metres): every corner stays within the 2D port's collider extent of its centre. */
const PIECE_SPAN = MAX_COLLIDER_EXTENT;

/** Where a layer's play plane cuts it: the plane's layer-local z and the cell row holding it. */
export function planeCutRow(cellDepth: number, originZ: number, planeZ: number): { localZ: number; row: number } {
  const localZ = planeZ - originZ;
  // The row in front on a boundary: snap a plane within a weld step of one onto it.
  const k = localZ / cellDepth;
  const near = Math.round(k);
  const row = Math.abs(k - near) * cellDepth < 1 / MESH_WELD ? near : Math.floor(k);
  return { localZ: Math.abs(k - near) * cellDepth < 1 / MESH_WELD ? near * cellDepth : localZ, row };
}

/** The most cells a block type's footprint reaches along z, turned any way (1: every block stays in its cell). */
function footprintDepth(types: ReadonlyMap<string, BlockType>): number {
  let depth = 1;
  for (const t of types.values()) {
    const f = rotatedFootprint(t, 0);
    depth = Math.max(depth, f[0], f[2]);
  }
  return depth;
}

/**
 * The chunk rows (cz, from and to) whose cells can reach the plane's row: its
 * own, and the one behind when a footprint reaches over from it.
 */
export function planeCutChunkRows(row: number, types: ReadonlyMap<string, BlockType>): [number, number] {
  return [Math.floor((row - footprintDepth(types) + 1) / CHUNK_SIZE), Math.floor(row / CHUNK_SIZE)];
}

/**
 * The grid seen through the plane's rows: the chunk's cells and edge pieces
 * that cannot reach the plane are skipped (they would only be meshed to be
 * cut away), while neighbour reads still see every cell, so faces between
 * blocks are hidden as in the 3D mesh.
 */
function rowView(grid: BlockGridReader, zFrom: number, row: number): BlockGridReader {
  const view = Object.create(grid) as BlockGridReader;
  view.forEachInChunk = (ck, cb) => grid.forEachInChunk(ck, (x, y, z, i) => (z >= zFrom && z <= row ? cb(x, y, z, i) : undefined));
  view.forEachEdgeInChunk = (ck, cb) => grid.forEachEdgeInChunk(ck, (x, y, z, axis, i) => (axis === 0 && z === row ? cb(x, y, z, axis, i) : undefined));
  return view;
}

interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** +1: the solid starts above it; −1: it ends there. */
  w: number;
}

/** The segments the plane z = `zc` cuts from the parts' triangles (x0 < x1; vertical ones dropped: they bound slabs only). */
function cutSegments(parts: readonly ChunkMeshPart[], zc: number, out: Segment[]): void {
  const q = (v: number): number => Math.round(v * MESH_WELD) / MESH_WELD;
  const px = [0, 0, 0];
  const py = [0, 0, 0];
  const pz = [0, 0, 0];
  const side = [false, false, false];
  const hit: number[] = [];
  for (const part of parts) {
    const P = part.positions;
    const I = part.indices;
    for (let i = 0; i < I.length; i += 3) {
      let front = 0;
      for (let k = 0; k < 3; k++) {
        const v = I[i + k]! * 3;
        px[k] = P[v]!;
        py[k] = P[v + 1]!;
        pz[k] = P[v + 2]!;
        // A point within a weld step of the plane counts as behind it (the half-open row).
        side[k] = pz[k]! - zc > 1 / MESH_WELD;
        if (side[k]) front += 1;
      }
      if (front === 0 || front === 3) continue;
      const ny = (pz[1]! - pz[0]!) * (px[2]! - px[0]!) - (px[1]! - px[0]!) * (pz[2]! - pz[0]!);
      const nx = (py[1]! - py[0]!) * (pz[2]! - pz[0]!) - (pz[1]! - pz[0]!) * (py[2]! - py[0]!);
      const nz = (px[1]! - px[0]!) * (py[2]! - py[0]!) - (py[1]! - py[0]!) * (px[2]! - px[0]!);
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 0) || Math.abs(ny) < 1e-9 * len) continue;
      // Which way it faces from its normals (a look's winding is not relied on).
      const N = part.normals;
      const up = N[I[i]! * 3 + 1]! + N[I[i + 1]! * 3 + 1]! + N[I[i + 2]! * 3 + 1]!;
      if (Math.abs(up) < 1e-6) continue;
      hit.length = 0;
      for (let k = 0; k < 3; k++) {
        const a = k;
        const b = (k + 1) % 3;
        if (side[a] === side[b]) continue;
        const t = Math.min(1, Math.max(0, (zc - pz[a]!) / (pz[b]! - pz[a]!)));
        hit.push(q(px[a]! + (px[b]! - px[a]!) * t), q(py[a]! + (py[b]! - py[a]!) * t));
      }
      if (hit.length !== 4 || hit[0] === hit[2]) continue;
      const flip = hit[0]! > hit[2]!;
      out.push({ x0: flip ? hit[2]! : hit[0]!, y0: flip ? hit[3]! : hit[1]!, x1: flip ? hit[0]! : hit[2]!, y1: flip ? hit[1]! : hit[3]!, w: up < 0 ? 1 : -1 });
    }
  }
}

/** A solid span over one or more slabs: x from `xa` to `xb`, bottom `ba`→`bb`, top `ta`→`tb`. */
interface Trapezoid {
  xa: number;
  xb: number;
  ba: number;
  bb: number;
  ta: number;
  tb: number;
}

const lineAt = (xa: number, ya: number, xb: number, yb: number, x: number): number => ya + ((yb - ya) * (x - xa)) / (xb - xa);

/** The solid spans of the segments, merged along x where top and bottom run straight on. */
function spans(segs: readonly Segment[]): Trapezoid[] {
  const xs = [...new Set(segs.flatMap((s) => [s.x0, s.x1]))].sort((a, b) => a - b);
  const byStart = [...segs].sort((a, b) => a.x0 - b.x0);
  let next0 = 0;
  // The segments reaching across the current slab (those starting at or before it, not yet ended).
  let live: Segment[] = [];
  const done: Trapezoid[] = [];
  let open: Trapezoid[] = [];
  const active: { s: Segment; ya: number; yb: number; ym: number }[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const xa = xs[i]!;
    let xb = xs[i + 1]!;
    while (next0 < byStart.length && byStart[next0]!.x0 <= xa) live.push(byStart[next0++]!);
    live = live.filter((s) => s.x1 > xa);
    active.length = 0;
    for (const s of live) active.push({ s, ya: lineAt(s.x0, s.y0, s.x1, s.y1, xa), yb: lineAt(s.x0, s.y0, s.x1, s.y1, xb), ym: 0 });
    // Two segments crossing inside the slab: it ends at the first crossing (the rest is the next slab).
    active.sort((a, b) => a.ya - b.ya || a.yb - b.yb);
    let cross = xb;
    for (let j = 1; j < active.length; j++) {
      if (active[j]!.yb - active[j - 1]!.yb >= -SAME) continue;
      for (let k = 0; k < active.length; k++) {
        for (let l = k + 1; l < active.length; l++) {
          const da = active[l]!.ya - active[k]!.ya;
          const db = active[l]!.yb - active[k]!.yb;
          if ((da > SAME && db < -SAME) || (da < -SAME && db > SAME)) cross = Math.min(cross, xa + ((xb - xa) * da) / (da - db));
        }
      }
      break;
    }
    if (cross < xb && cross > xa) {
      xs.splice(i + 1, 0, cross);
      xb = cross;
      for (const a of active) a.yb = lineAt(a.s.x0, a.s.y0, a.s.x1, a.s.y1, xb);
    }
    for (const a of active) a.ym = (a.ya + a.yb) / 2;
    // Upward through the slab; on a tie an entering face first, so solids touching there count as one.
    active.sort((a, b) => a.ym - b.ym || b.s.w - a.s.w);
    const here: Trapezoid[] = [];
    let count = 0;
    let bottom: (typeof active)[number] | null = null;
    for (const a of active) {
      const before = count;
      count = Math.max(0, count + a.s.w);
      if (before === 0 && count > 0) bottom = a;
      else if (before > 0 && count === 0 && bottom !== null) {
        if (a.ya - bottom.ya > SAME || a.yb - bottom.yb > SAME) here.push({ xa, xb, ba: bottom.ya, bb: bottom.yb, ta: a.ya, tb: a.yb });
        bottom = null;
      }
    }
    // Each span carries on one that ends where it starts with the same top and bottom lines.
    const next: Trapezoid[] = [];
    for (const t of here) {
      const j = open.findIndex((o) => o.xb === xa && Math.abs(o.bb - t.ba) < SAME && Math.abs(o.tb - t.ta) < SAME && Math.abs(lineAt(o.xa, o.ba, o.xb, o.bb, xb) - t.bb) < SAME && Math.abs(lineAt(o.xa, o.ta, o.xb, o.tb, xb) - t.tb) < SAME);
      if (j < 0) {
        next.push(t);
        continue;
      }
      const o = open.splice(j, 1)[0]!;
      next.push({ xa: o.xa, xb, ba: o.ba, bb: t.bb, ta: o.ta, tb: t.tb });
    }
    done.push(...open);
    open = next;
  }
  done.push(...open);
  return done;
}

/** A span as convex pieces within the port's extent (split across x, then between its bottom and top). */
function piecesOf(t: Trapezoid, out: PlaneCutPiece[]): void {
  const nx = Math.max(1, Math.ceil((t.xb - t.xa) / PIECE_SPAN));
  for (let i = 0; i < nx; i++) {
    const xa = t.xa + ((t.xb - t.xa) * i) / nx;
    const xb = i + 1 === nx ? t.xb : t.xa + ((t.xb - t.xa) * (i + 1)) / nx;
    const ba = lineAt(t.xa, t.ba, t.xb, t.bb, xa);
    const bb = lineAt(t.xa, t.ba, t.xb, t.bb, xb);
    const ta = lineAt(t.xa, t.ta, t.xb, t.tb, xa);
    const tb = lineAt(t.xa, t.ta, t.xb, t.tb, xb);
    const ny = Math.max(1, Math.ceil(Math.max(ta - ba, tb - bb) / PIECE_SPAN));
    for (let j = 0; j < ny; j++) {
      const lo = (a: number, b: number): number => a + ((b - a) * j) / ny;
      const hi = (a: number, b: number): number => (j + 1 === ny ? b : a + ((b - a) * (j + 1)) / ny);
      const corners: [number, number][] = [[xa, lo(ba, ta)], [xb, lo(bb, tb)]];
      if (hi(bb, tb) - lo(bb, tb) > SAME) corners.push([xb, hi(bb, tb)]);
      if (hi(ba, ta) - lo(ba, ta) > SAME) corners.push([xa, hi(ba, ta)]);
      if (corners.length < 3) continue;
      let area = 0;
      for (let k = 0; k < corners.length; k++) {
        const a = corners[k]!;
        const b = corners[(k + 1) % corners.length]!;
        area += a[0] * b[1] - b[0] * a[1];
      }
      if (area / 2 < MIN_POLYGON_AREA) continue;
      const cx = (xa + xb) / 2;
      const cy = (Math.min(...corners.map((c) => c[1])) + Math.max(...corners.map((c) => c[1]))) / 2;
      out.push({ x: cx, y: cy, vertices: corners.map(([x, y]) => [x - cx, y - cy]) });
    }
  }
}

/** The pieces of the block types `include` keeps, from one chunk seen through the plane's rows. */
function cutChunk(view: BlockGridReader, cx: number, cz: number, types: ReadonlyMap<string, BlockType>, zc: number, include: (t: BlockType) => boolean): PlaneCutPiece[] {
  const segs: Segment[] = [];
  cutSegments(meshBlockChunk(view, cx, cz, types, collisionLooks(include, true)), zc, segs);
  const out: PlaneCutPiece[] = [];
  for (const t of spans(segs)) piecesOf(t, out);
  return out;
}

/**
 * One chunk's 2D collision: its blocks' collision shapes cut at the plane
 * (layer-local z `localZ` in cell row `row`, from `planeCutRow`), solid and
 * one-way blocks apart (each meshed without the other: one-way blocks are
 * empty space to the solid ones and the other way round). Empty lists: the
 * chunk has nothing on the plane.
 */
export function planeCollisionChunk(grid: BlockGridReader, cx: number, cz: number, types: ReadonlyMap<string, BlockType>, localZ: number, row: number): PlaneCutChunk {
  const view = rowView(grid, row - footprintDepth(types) + 1, row);
  let anyOneWay = false;
  for (const t of types.values()) if (t.oneWay === true) anyOneWay = true;
  return {
    solid: cutChunk(view, cx, cz, types, localZ, (t) => t.oneWay !== true),
    oneWay: anyOneWay ? cutChunk(view, cx, cz, types, localZ, (t) => t.oneWay === true) : [],
  };
}
