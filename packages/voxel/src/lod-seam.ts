/**
 * Seams between chunk-tree levels: where a node of level L is drawn next to
 * nodes of level L − 1 across one of its faces, the coarser node owns a
 * **transition strip** that joins its own surface's open boundary at that
 * face to the finer nodes' boundary there, plus **flaps** where the two
 * boundaries cannot be joined. Both meshes stay as derived: a level-0
 * chunk's surface (and so its heightfield collider) and the coarse node's
 * are never moved; the seam is a buffer of its own, drawn with the coarse
 * node.
 *
 * Why the coarser side and a strip, not the finer side's stitch or skirts:
 * the finer boundary holds everything the coarser one has (a roof or a thin
 * wall the coarse level dropped is still there), so walking the coarse
 * boundary onto it never pulls a surface far, while a stitch onto the
 * coarse boundary would drag the finer surface onto ground the coarse level
 * kept; skirts leave cracks wherever the two boundaries differ by more than
 * a flap reaches, and are in sight at grazing angles.
 *
 * - **Boundary rows.** Each side's open edges within half of its own cell
 *   of the face plane: only triangles with two vertices that near the plane
 *   are looked at (an edge's reverse lies in such a triangle too), their
 *   vertices welded by exact position (sections of one chunk and crease
 *   copies emit the same position more than once).
 * - **Strip.** Every coarse boundary vertex at the face moves to the
 *   nearest point of the fine boundary; the coarse node's triangles touching
 *   a moved vertex are drawn again by the seam with it moved (the node's own
 *   triangles stay as derived and drawn, so the seam only adds surface), and
 *   for every coarse boundary edge p → q (whose middle lies on this face)
 *   the polygon P, the fine boundary's vertices walked from P back to Q, Q
 *   is fanned from P (P, Q: p and q moved). It shares Q → P with the moved
 *   copy of the coarse edge and the walked fine edges reversed with the fine
 *   surface. Moved rather than left in place and bridged: measured on the
 *   caves, a bridge from the unmoved coarse boundary let 2.4 times as many
 *   rays through as moving it.
 * - **Flaps.** A coarse edge whose ends land on different fine boundary
 *   chains, or on one fine edge the wrong way round (the levels connect a
 *   saddle differently), and a fine boundary edge no strip reached, hang a
 *   flap one coarse cell deep inward along their normals.
 *
 * Positions: the seam is cut into **pieces**, one per finer node against the
 * face (four for a full face), each in the finer level's position steps from
 * an origin {@link SEAM_PIECE_PAD_CELLS} cells below that node's corner, so
 * a strip vertex on the fine boundary is bit for bit the fine surface's
 * vertex. A piece's vertices are not shared (three a triangle).
 */
import { POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, type SurfaceBuffer } from './derived-mesh';

const S = POSITION_STEPS_PER_CELL;

/**
 * Cells (of the finer level) a seam piece's origin lies below the finer
 * node's corner on every axis: a strip and its flaps reach at most a coarse
 * cell and a half past the node, so the piece's positions stay in range.
 */
export const SEAM_PIECE_PAD_CELLS = 8;

/** A surface as a seam reads it: positions in its level's steps from one cell below cell (x0, y0, z0) of that level. */
export interface SeamSurface {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly ground: SurfaceBuffer;
  readonly base: SurfaceBuffer;
}

/** A node face: axis · 2 + side (axis 0 x, 1 y, 2 z; side 1 the high face). */
export type NodeFace = 0 | 1 | 2 | 3 | 4 | 5;

export interface SeamFaceInput {
  /** The node edge (cells of its level). */
  readonly edge: number;
  /** The coarse node's level (≥ 1); the finer side is one level down. */
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly face: NodeFace;
  /** The coarse node's surfaces (its derive), in its level's cells. */
  readonly coarse: SeamSurface;
  /**
   * Its neighbours of the same level around the face (beside it on the
   * face's plane, diagonals too): their triangles close the node's own open
   * edges at its rim, so only the edges at the face are joined.
   */
  readonly coarseAround: readonly SeamSurface[];
  /**
   * The finer side's surfaces (nodes or sections, in the finer level's
   * cells) against the face and beside it: the strip at the face's rim
   * projects onto the same finer boundary as the neighbouring node's strip.
   */
  readonly fine: readonly SeamSurface[];
}

/** Finer-level cells past the face's rim a seam reads the boundary rows of. */
export const SEAM_RIM_CELLS = 4;

/** One piece of a face's seam: positions in the finer level's steps from `origin` (finer-level cells). */
export interface SeamPiece {
  readonly origin: readonly [number, number, number];
  readonly ground: SurfaceBuffer;
  readonly base: SurfaceBuffer;
}

export interface SeamCounts {
  /** Strip triangles (the moved coarse triangles among them), and flap triangles. */
  strip: number;
  moved: number;
  flaps: number;
  /** Coarse edges whose ends land on different fine chains, or the wrong way round on one fine edge. */
  unmatched: number;
  /** Vertices clamped into a piece's range (0 in practice). */
  clamped: number;
  /** Boundary edges found: coarse, fine. */
  coarseEdges: number;
  fineEdges: number;
}

/** A coarse node face's seam. */
export interface FaceSeam {
  /** The coarse node's level and coordinates, and the face. */
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly face: NodeFace;
  /** Pieces with at least one triangle. */
  readonly pieces: readonly SeamPiece[];
  readonly counts: SeamCounts;
}

/** Bytes a seam's pieces hold (what the stream budget counts). */
export function seamBytes(s: FaceSeam): number {
  let n = 0;
  for (const p of s.pieces) n += p.ground.vertices.byteLength + p.ground.indices.byteLength + p.base.vertices.byteLength + p.base.indices.byteLength;
  return n;
}

/** One side's boundary rows at the face: welded vertices (world steps of the finer level) and open edges. */
class Rows {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  private readonly ids = new Map<number, number>();
  private readonly directed = new Map<number, number>();
  /** Triangles with a vertex at the face, of the surfaces added with `own`: welded ids (−1: not at the face) and positions and normals. */
  readonly tris: Array<{ readonly ids: number[]; readonly p: number[]; readonly n: number[] }> = [];

  constructor(
    private readonly axis: number,
    /** The plane, finer-level steps. */
    private readonly plane: number,
    /** Origin and span of the weld key (finer-level steps); vertices outside it on the face's plane are not read. */
    private readonly key0: readonly number[],
    private readonly keySpan: number,
  ) {}

  /** Whether a position lies in the window the rows read (the face and its rim). */
  private inWindow(x: number, y: number, z: number): boolean {
    const k = this.key0;
    const K = this.keySpan;
    return x >= k[0]! && x < k[0]! + K && y >= k[1]! && y < k[1]! + K && z >= k[2]! && z < k[2]! + K;
  }

  /**
   * Adds a surface's rows: its positions scaled by `scale` (2 for the
   * coarse side, 1 for the fine) from one cell below (x0, y0, z0) of its
   * level; vertices within `tol` steps of the plane count.
   */
  add(buf: SurfaceBuffer, scale: number, x0: number, y0: number, z0: number, tol: number, own = false): void {
    const n = buf.vertexCount;
    if (n === 0) return;
    const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
    const o = [(x0 - 1) * S, (y0 - 1) * S, (z0 - 1) * S];
    const a = this.axis;
    const local = new Int32Array(n).fill(-1);
    const near = new Uint8Array(n);
    let any = false;
    for (let v = 0; v < n; v++) {
      const b = v * SURFACE_VERTEX_BYTES;
      const c = (o[a]! + view.getUint16(b + 2 * a, true)) * scale;
      if (Math.abs(c - this.plane) > tol) continue;
      if (!this.inWindow((o[0]! + view.getUint16(b, true)) * scale, (o[1]! + view.getUint16(b + 2, true)) * scale, (o[2]! + view.getUint16(b + 4, true)) * scale)) continue;
      near[v] = 1;
      any = true;
    }
    if (!any) return;
    const id = (v: number): number => {
      let w = local[v]!;
      if (w >= 0) return w;
      const b = v * SURFACE_VERTEX_BYTES;
      const x = (o[0]! + view.getUint16(b, true)) * scale;
      const y = (o[1]! + view.getUint16(b + 2, true)) * scale;
      const z = (o[2]! + view.getUint16(b + 4, true)) * scale;
      const K = this.keySpan;
      const key = ((x - this.key0[0]!) * K + (y - this.key0[1]!)) * K + (z - this.key0[2]!);
      const known = this.ids.get(key);
      const nx = view.getInt8(b + 8), ny = view.getInt8(b + 9), nz = view.getInt8(b + 10);
      if (known === undefined) {
        w = this.pos.length / 3;
        this.ids.set(key, w);
        this.pos.push(x, y, z);
        this.nrm.push(nx, ny, nz);
      } else {
        // Crease copies weld into one position: their normals are summed.
        w = known;
        this.nrm[3 * w] = this.nrm[3 * w]! + nx;
        this.nrm[3 * w + 1] = this.nrm[3 * w + 1]! + ny;
        this.nrm[3 * w + 2] = this.nrm[3 * w + 2]! + nz;
      }
      local[v] = w;
      return w;
    };
    const I = buf.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const i0 = I[t]!, i1 = I[t + 1]!, i2 = I[t + 2]!;
      const k = near[i0]! + near[i1]! + near[i2]!;
      if (own && k > 0) {
        const tri = { ids: [] as number[], p: [] as number[], n: [] as number[] };
        for (const v of [i0, i1, i2]) {
          const b = v * SURFACE_VERTEX_BYTES;
          tri.ids.push(near[v] ? id(v) : -1);
          for (let c = 0; c < 3; c++) tri.p.push((o[c]! + view.getUint16(b + 2 * c, true)) * scale);
          const nx = view.getInt8(b + 8), ny = view.getInt8(b + 9), nz = view.getInt8(b + 10);
          const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          tri.n.push(nx / l, ny / l, nz / l);
        }
        this.tris.push(tri);
      }
      if (k < 2) continue;
      if (near[i0] && near[i1]) this.edge(id(i0), id(i1));
      if (near[i1] && near[i2]) this.edge(id(i1), id(i2));
      if (near[i2] && near[i0]) this.edge(id(i2), id(i0));
    }
  }

  private edge(p: number, q: number): void {
    if (p === q) return;
    this.directed.set(p * EDGE_KEY + q, (this.directed.get(p * EDGE_KEY + q) ?? 0) + 1);
  }

  /** Open edges (directed as their triangle has them), each with no reverse among the rows. */
  open(keep?: (p: number, q: number) => boolean): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const k of this.directed.keys()) {
      const p = Math.floor(k / EDGE_KEY);
      const q = k - p * EDGE_KEY;
      if (this.directed.has(q * EDGE_KEY + p)) continue;
      if (keep === undefined || keep(p, q)) out.push([p, q]);
    }
    // Map order follows the buffers' order; sorting makes the seam independent of it.
    out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    return out;
  }

  normal(v: number): [number, number, number] {
    const x = this.nrm[3 * v]!, y = this.nrm[3 * v + 1]!, z = this.nrm[3 * v + 2]!;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  }

  point(v: number): [number, number, number] {
    return [this.pos[3 * v]!, this.pos[3 * v + 1]!, this.pos[3 * v + 2]!];
  }
}

/** Welded vertex ids stay below this (the directed-edge key's base). */
const EDGE_KEY = 1 << 26;

/** Longest walk along the fine boundary between the targets of one coarse edge's ends. */
const WALK = 64;

/** Bucket rings searched for a coarse vertex's nearest fine boundary edge (coarse cells). */
const SEARCH_RINGS = 64;

interface Proj {
  /** The nearest fine boundary edge (−1: none within reach), the parameter along it, and its nearer end (the vertex the coarse one moves to). */
  readonly e: number;
  readonly t: number;
  readonly v: number;
  readonly p: [number, number, number];
  readonly n: [number, number, number];
}

/** A point with its normal. */
type Corner = readonly [readonly [number, number, number], readonly [number, number, number]];

/** Growable triangle lists of one piece. */
class PieceOut {
  readonly ground: number[] = [];
  readonly base: number[] = [];
}

function closest(px: number, py: number, pz: number, A: readonly number[], B: readonly number[]): [number, number, number, number] {
  const dx = B[0]! - A[0]!, dy = B[1]! - A[1]!, dz = B[2]! - A[2]!;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 === 0 ? 0 : ((px - A[0]!) * dx + (py - A[1]!) * dy + (pz - A[2]!) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [A[0]! + t * dx, A[1]! + t * dy, A[2]! + t * dz, t];
}

/**
 * Builds a coarse node face's seam from its own surface and the finer
 * surfaces against the face (see the file comment). Pure; runs in a worker.
 */
export function buildFaceSeam(input: SeamFaceInput): FaceSeam {
  const { edge: E, level, face } = input;
  if (!Number.isInteger(level) || level < 1) throw new RangeError(`seam level ${level}`);
  if (!Number.isInteger(face) || face < 0 || face > 5) throw new RangeError(`node face ${face}`);
  const axis = face >> 1;
  const side = face & 1;
  const n = [input.nx, input.ny, input.nz];
  // The coarse node's corner and the plane, in finer-level cells.
  const corner = n.map((c) => c * 2 * E);
  const planeCells = corner[axis]! + side * 2 * E;
  const plane = planeCells * S;
  // The window rows are read in: the face and its rim, SEAM_RIM_CELLS round it (a cube on the face's plane).
  const span = (2 * E + 2 * SEAM_RIM_CELLS) * S;
  const key0 = corner.map((c) => (c - SEAM_RIM_CELLS) * S);
  key0[axis] = (planeCells - E - SEAM_RIM_CELLS) * S;
  const inPlane = [0, 1, 2].filter((a) => a !== axis) as [number, number];
  const counts: SeamCounts = { strip: 0, moved: 0, flaps: 0, unmatched: 0, clamped: 0, coarseEdges: 0, fineEdges: 0 };
  const pieces = new Map<number, PieceOut>();
  const pieceOf = (u: number, w: number): PieceOut => {
    const iu = Math.min(1, Math.max(0, Math.floor((u / S - corner[inPlane[0]]!) / E)));
    const iw = Math.min(1, Math.max(0, Math.floor((w / S - corner[inPlane[1]]!) / E)));
    const k = iu * 2 + iw;
    let p = pieces.get(k);
    if (p === undefined) pieces.set(k, (p = new PieceOut()));
    return p;
  };
  for (const kind of ['ground', 'base'] as const) {
    const coarse = new Rows(axis, plane, key0, span);
    coarse.add(input.coarse[kind], 2, input.coarse.x0, input.coarse.y0, input.coarse.z0, S, true);
    // Their triangles at the face too: one touching a vertex this seam moves is drawn again moved, or a gap opens
    // between it and the moved copies of the node's own.
    for (const c of input.coarseAround) coarse.add(c[kind], 2, c.x0, c.y0, c.z0, S, true);
    const fine = new Rows(axis, plane, key0, span);
    for (const f of input.fine) fine.add(f[kind], 1, f.x0, f.y0, f.z0, S / 2);
    // Only this face's coarse edges: their middle within the face (edges of the node's other faces meet it at its rim).
    const lo = inPlane.map((a) => corner[a]! * S);
    const hi = inPlane.map((a) => (corner[a]! + 2 * E) * S);
    const cEdges = coarse.open((p, q) => {
      for (let k = 0; k < 2; k++) {
        const a = inPlane[k]!;
        const m = (coarse.pos[3 * p + a]! + coarse.pos[3 * q + a]!) / 2;
        if (m < lo[k]! || m >= hi[k]!) return false;
      }
      return true;
    });
    const fEdges = fine.open();
    counts.coarseEdges += cEdges.length;
    counts.fineEdges += fEdges.length;
    if (cEdges.length === 0 && fEdges.length === 0) continue;
    const write = (tri: readonly Corner[], at: PieceOut, flap: boolean): void => {
      const [a, b, c] = tri;
      const ux = b![0][0] - a![0][0], uy = b![0][1] - a![0][1], uz = b![0][2] - a![0][2];
      const vx = c![0][0] - a![0][0], vy = c![0][1] - a![0][1], vz = c![0][2] - a![0][2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      // Coincident corners (a coarse vertex already on the fine boundary) make no triangle.
      if (cx * cx + cy * cy + cz * cz < 1e-6) return;
      const out = at[kind];
      for (const [p, nn] of tri) out.push(p[0], p[1], p[2], nn[0], nn[1], nn[2]);
      if (flap) counts.flaps++;
      else counts.strip++;
    };
    const flapUnder = (rows: Rows, p: number, q: number, at: (v: number) => readonly [number, number, number]): void => {
      const depth = 2 * S;
      const np = rows.normal(p), nq = rows.normal(q);
      const a = at(p), b = at(q);
      const ad: [number, number, number] = [a[0] - depth * np[0], a[1] - depth * np[1], a[2] - depth * np[2]];
      const bd: [number, number, number] = [b[0] - depth * nq[0], b[1] - depth * nq[1], b[2] - depth * nq[2]];
      const piece = pieceOf((a[inPlane[0]]! + b[inPlane[0]]!) / 2, (a[inPlane[1]]! + b[inPlane[1]]!) / 2);
      // The edge runs p → q in its triangle: the flap takes q → p, continuing the surface over the edge.
      write([[b, nq], [a, np], [ad, np]], piece, true);
      write([[b, nq], [ad, np], [bd, nq]], piece, true);
    };
    if (fEdges.length === 0) {
      for (const [p, q] of cEdges) flapUnder(coarse, p, q, (v) => coarse.point(v));
      continue;
    }
    // Fine boundary edges bucketed on the face (a coarse cell a bucket) for the nearest-point search.
    const bucket = 2 * S;
    const bkey = (u: number, w: number): number => (u + 0x8000) * 0x10000 + (w + 0x8000);
    const buckets = new Map<number, number[]>();
    const FP = fine.pos;
    for (let i = 0; i < fEdges.length; i++) {
      const [u, w] = fEdges[i]!;
      const a0 = inPlane[0], a1 = inPlane[1];
      const u0 = Math.floor(Math.min(FP[3 * u + a0]!, FP[3 * w + a0]!) / bucket), u1 = Math.floor(Math.max(FP[3 * u + a0]!, FP[3 * w + a0]!) / bucket);
      const w0 = Math.floor(Math.min(FP[3 * u + a1]!, FP[3 * w + a1]!) / bucket), w1 = Math.floor(Math.max(FP[3 * u + a1]!, FP[3 * w + a1]!) / bucket);
      for (let bu = u0; bu <= u1; bu++) for (let bw = w0; bw <= w1; bw++) {
        const k = bkey(bu, bw);
        let list = buckets.get(k);
        if (list === undefined) buckets.set(k, (list = []));
        list.push(i);
      }
    }
    const incoming = new Map<number, number>();
    const outgoing = new Map<number, number>();
    for (let i = 0; i < fEdges.length; i++) {
      outgoing.set(fEdges[i]![0], i);
      incoming.set(fEdges[i]![1], i);
    }
    const reached = new Uint8Array(fEdges.length);
    const proj = new Map<number, Proj>();
    const project = (v: number): Proj => {
      const known = proj.get(v);
      if (known !== undefined) return known;
      const [x, y, z] = coarse.point(v);
      const pt = [x, y, z];
      const hu = Math.floor(pt[inPlane[0]]! / bucket), hw = Math.floor(pt[inPlane[1]]! / bucket);
      let best = Infinity;
      let e = -1, t = 0;
      let at: [number, number, number] = [x, y, z];
      for (let r = 0; r < SEARCH_RINGS; r++) {
        for (let du = -r; du <= r; du++) for (let dw = -r; dw <= r; dw++) {
          if (Math.max(Math.abs(du), Math.abs(dw)) !== r) continue;
          for (const i of buckets.get(bkey(hu + du, hw + dw)) ?? []) {
            const [u, w] = fEdges[i]!;
            const c = closest(x, y, z, fine.point(u), fine.point(w));
            const d = (c[0] - x) ** 2 + (c[1] - y) ** 2 + (c[2] - z) ** 2;
            if (d < best) {
              best = d;
              e = i;
              t = c[3];
              at = [c[0], c[1], c[2]];
            }
          }
        }
        // Buckets past ring r lie at least r buckets away on the face.
        if (best <= (r * bucket) ** 2) break;
      }
      // The nearer end of the edge, not the point on it: every seam vertex is then exactly a vertex of one of the
      // two surfaces (a point inside a fine edge, rounded to whole steps, leaves a sliver along the boundary).
      let out: Proj = { e, t, v: -1, p: at, n: coarse.normal(v) };
      if (e >= 0) {
        const end = t < 0.5 ? fEdges[e]![0] : fEdges[e]![1];
        out = { e, t, v: end, p: fine.point(end), n: fine.normal(end) };
      }
      proj.set(v, out);
      return out;
    };
    const loose: Array<[number, number]> = [];
    for (const [p, q] of cEdges) {
      const P = project(p);
      const Q = project(q);
      if (P.e < 0 || Q.e < 0) {
        loose.push([p, q]);
        continue;
      }
      reached[P.e] = 1;
      reached[Q.e] = 1;
      const path: number[] = [];
      let found = P.e === Q.e && Q.t <= P.t + 1e-9;
      if (P.e === Q.e && !found) {
        // On one fine edge the wrong way round: the levels run this stretch in opposite directions.
        loose.push([p, q]);
        counts.unmatched++;
        continue;
      }
      // Against the fine boundary's direction from P's edge: its start, the start of the edge before it, … to Q's edge.
      let e = P.e;
      for (let k = 0; k < WALK && !found; k++) {
        const u = fEdges[e]![0];
        path.push(u);
        const prev = incoming.get(u);
        if (prev === undefined) break;
        if (prev === Q.e) found = true;
        else {
          e = prev;
          reached[e] = 1;
        }
      }
      if (!found) {
        loose.push([p, q]);
        counts.unmatched++;
        continue;
      }
      const ids: number[] = [];
      for (const u of [P.v, ...path, Q.v]) if (ids[ids.length - 1] !== u) ids.push(u);
      if (ids.length < 3) continue;
      const poly = ids.map((u): Corner => [fine.point(u), fine.normal(u)]);
      const piece = pieceOf((P.p[inPlane[0]]! + Q.p[inPlane[0]]!) / 2, (P.p[inPlane[1]]! + Q.p[inPlane[1]]!) / 2);
      // Fanned from P: the polygon P, …, Q closes with Q → P, the moved coarse edge reversed.
      for (let i = 1; i + 1 < poly.length; i++) write([poly[0]!, poly[i]!, poly[i + 1]!], piece, false);
    }
    // The coarse triangles at the face drawn again with their boundary vertices moved.
    for (const t of coarse.tris) {
      // Only triangles a move changed (a vertex already on the fine boundary moves by nothing).
      if (!t.ids.some((v, j) => { const m = v >= 0 ? proj.get(v) : undefined; return m !== undefined && m.e >= 0 && (m.p[0] !== t.p[3 * j] || m.p[1] !== t.p[3 * j + 1] || m.p[2] !== t.p[3 * j + 2]); })) continue;
      const tri: Corner[] = [0, 1, 2].map((j): Corner => {
        const v = t.ids[j]!;
        const m = v >= 0 ? proj.get(v) : undefined;
        return [m !== undefined && m.e >= 0 ? m.p : [t.p[3 * j]!, t.p[3 * j + 1]!, t.p[3 * j + 2]!], [t.n[3 * j]!, t.n[3 * j + 1]!, t.n[3 * j + 2]!]];
      });
      const piece = pieceOf((tri[0]![0][inPlane[0]]! + tri[1]![0][inPlane[0]]! + tri[2]![0][inPlane[0]]!) / 3, (tri[0]![0][inPlane[1]]! + tri[1]![0][inPlane[1]]! + tri[2]![0][inPlane[1]]!) / 3);
      write(tri, piece, false);
      counts.moved++;
    }
    for (const [p, q] of loose) flapUnder(coarse, p, q, (v) => { const m = proj.get(v); return m !== undefined && m.e >= 0 ? m.p : coarse.point(v); });
    for (let i = 0; i < fEdges.length; i++) {
      if (reached[i] !== 0) continue;
      const [p, q] = fEdges[i]!;
      // Only edges on this face: a fine edge past the face's rim is the neighbouring coarse node's to join.
      let inside = true;
      for (let k = 0; k < 2; k++) {
        const a = inPlane[k]!;
        const m = (fine.pos[3 * p + a]! + fine.pos[3 * q + a]!) / 2;
        if (m < lo[k]! || m >= hi[k]!) inside = false;
      }
      if (inside) flapUnder(fine, p, q, (v) => fine.point(v));
    }
  }
  const out: SeamPiece[] = [];
  for (const [k, p] of [...pieces.entries()].sort((a, b) => a[0] - b[0])) {
    const fineNode = [0, 0, 0];
    fineNode[axis] = side === 1 ? (n[axis]! + 1) * 2 : n[axis]! * 2 - 1;
    fineNode[inPlane[0]] = n[inPlane[0]]! * 2 + (k >> 1);
    fineNode[inPlane[1]] = n[inPlane[1]]! * 2 + (k & 1);
    const origin = fineNode.map((c) => c * E - SEAM_PIECE_PAD_CELLS) as [number, number, number];
    out.push({ origin, ground: encode(p.ground, origin, counts), base: encode(p.base, origin, counts) });
  }
  return { level, nx: input.nx, ny: input.ny, nz: input.nz, face, pieces: out, counts };
}

/** Six numbers a corner (position in world steps, unit normal) → a surface buffer in steps from `origin` (cells). */
function encode(corners: readonly number[], origin: readonly number[], counts: SeamCounts): SurfaceBuffer {
  const vertexCount = corners.length / 6;
  const vertices = new Uint8Array(vertexCount * SURFACE_VERTEX_BYTES);
  const view = new DataView(vertices.buffer);
  for (let v = 0; v < vertexCount; v++) {
    const b = v * SURFACE_VERTEX_BYTES;
    for (let a = 0; a < 3; a++) {
      let p = Math.round(corners[6 * v + a]! - origin[a]! * S);
      if (p < 0 || p > 0xffff) {
        counts.clamped++;
        p = p < 0 ? 0 : 0xffff;
      }
      view.setUint16(b + 2 * a, p, true);
      view.setInt8(b + 8 + a, Math.max(-127, Math.min(127, Math.round(corners[6 * v + 3 + a]! * 127))));
    }
  }
  const indices = vertexCount < 0x10000 ? new Uint16Array(vertexCount) : new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) indices[i] = i;
  return { vertexCount, vertices, indices };
}
