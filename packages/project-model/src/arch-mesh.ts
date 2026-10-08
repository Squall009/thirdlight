/**
 * Where generated architecture writes its triangles: one growing set of
 * flat typed arrays per material and level (no object per vertex or per
 * piece), and the planar fill every flat surface goes through — a polygon
 * cut into strips one trim row tall (each strip spans its row exactly once
 * across, like the sweeps' strips) and cells along them, so the surface has
 * the vertex density baked AO and painted grime need.
 *
 * Pure.
 */
import { TRIM_COLOUR_OCCLUSION, type TrimRow, type TrimSheet, trimRowDensity, trimRowV } from './trim-sheet';

/** How much the arrays grow when full (no per-vertex allocation: a few growths per chunk). */
const GROW = 2;

/**
 * One material's triangles in a chunk: one set of vertices, two index
 * lists — the near level (everything) and the far level (detail left out),
 * so the far level costs no vertices of its own.
 */
export interface ArchMeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** COLOR_0 as the trim material reads it, normalized bytes: R occlusion, G grime, B wetness, A 255. */
  colors: Uint8Array;
  indices: Uint32Array;
  farIndices: Uint32Array;
}

/** The levels a triangle goes in ({@link ArchMeshWriter.triangleIn}): near, far, both. */
export const NEAR = 1;
export const FAR = 2;
export const BOTH = 3;

export class ArchMeshWriter {
  vertexCount = 0;
  indexCount = 0;
  private pos: Float32Array;
  private nrm: Float32Array;
  private uv: Float32Array;
  private col: Uint8Array;
  private idx: Uint32Array;
  private far: Uint32Array;
  farCount = 0;
  /** Triangles written while set are detail: in the near level only. */
  detail = false;
  /** Bounds of what was written: min xyz, max xyz. */
  readonly bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

  constructor(vertices = 1024) {
    this.pos = new Float32Array(vertices * 3);
    this.nrm = new Float32Array(vertices * 3);
    this.uv = new Float32Array(vertices * 2);
    this.col = new Uint8Array(vertices * 4);
    this.idx = new Uint32Array(vertices * 3);
    this.far = new Uint32Array(vertices * 3);
  }

  private growVertices(): void {
    const v = Math.ceil((this.pos.length / 3) * GROW) + 16;
    const g = (a: Float32Array, k: number): Float32Array => {
      const b = new Float32Array(v * k);
      b.set(a);
      return b;
    };
    this.pos = g(this.pos, 3);
    this.nrm = g(this.nrm, 3);
    this.uv = g(this.uv, 2);
    const c = new Uint8Array(v * 4);
    c.set(this.col);
    this.col = c;
  }

  /** A vertex; returns its index. */
  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number, occlusion: number): number {
    if (this.vertexCount * 3 + 3 > this.pos.length) this.growVertices();
    const i = this.vertexCount++;
    this.pos[i * 3] = px;
    this.pos[i * 3 + 1] = py;
    this.pos[i * 3 + 2] = pz;
    this.nrm[i * 3] = nx;
    this.nrm[i * 3 + 1] = ny;
    this.nrm[i * 3 + 2] = nz;
    this.uv[i * 2] = u;
    this.uv[i * 2 + 1] = v;
    const o = occlusion > 0 ? (occlusion < 1 ? occlusion : 1) : 0;
    this.col[i * 4 + TRIM_COLOUR_OCCLUSION] = Math.round(o * 255);
    this.col[i * 4 + 3] = 255;
    const b = this.bounds;
    if (px < b[0]!) b[0] = px;
    if (py < b[1]!) b[1] = py;
    if (pz < b[2]!) b[2] = pz;
    if (px > b[3]!) b[3] = px;
    if (py > b[4]!) b[4] = py;
    if (pz > b[5]!) b[5] = pz;
    return i;
  }

  /** A triangle, wound so its face looks along (nx, ny, nz). */
  triangle(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    this.triangleIn(this.detail ? NEAR : BOTH, a, b, c, nx, ny, nz);
  }

  /**
   * A triangle in the near level only (NEAR), the far only (FAR: written
   * when the far level stands in for finer near triangles with fewer, over
   * the same vertices; nothing when detail), or both.
   */
  triangleIn(levels: number, a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    if (this.detail) levels &= NEAR;
    if (levels === 0) return;
    if ((levels & NEAR) !== 0 && this.indexCount + 3 > this.idx.length) this.idx = grown(this.idx, this.indexCount + 3);
    if ((levels & FAR) !== 0 && this.farCount + 3 > this.far.length) this.far = grown(this.far, this.farCount + 3);
    const p = this.pos;
    const e1x = p[b * 3]! - p[a * 3]!;
    const e1y = p[b * 3 + 1]! - p[a * 3 + 1]!;
    const e1z = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const e2x = p[c * 3]! - p[a * 3]!;
    const e2y = p[c * 3 + 1]! - p[a * 3 + 1]!;
    const e2z = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    // Counter-clockwise faces the viewer (three.js and glTF front faces).
    const flip = cx * nx + cy * ny + cz * nz < 0;
    if ((levels & NEAR) !== 0) {
      this.idx[this.indexCount++] = a;
      this.idx[this.indexCount++] = flip ? c : b;
      this.idx[this.indexCount++] = flip ? b : c;
    }
    if ((levels & FAR) === 0) return;
    this.far[this.farCount++] = a;
    this.far[this.farCount++] = flip ? c : b;
    this.far[this.farCount++] = flip ? b : c;
  }

  /** A triangle, wound so its face looks along the sum of its vertices' normals. */
  triangleFacing(a: number, b: number, c: number, levels = BOTH): void {
    const n = this.nrm;
    this.triangleIn(levels, a, b, c, n[a * 3]! + n[b * 3]! + n[c * 3]!, n[a * 3 + 1]! + n[b * 3 + 1]! + n[c * 3 + 1]!, n[a * 3 + 2]! + n[b * 3 + 2]! + n[c * 3 + 2]!);
  }

  /** Copy another writer's triangles in, each vertex turned by the yaw (cos, sin about +Y) and moved by (tx, ty, tz). */
  stamp(src: ArchMeshWriter, cos: number, sin: number, tx: number, ty: number, tz: number): void {
    const base = this.vertexCount;
    const sp = src.pos;
    const sn = src.nrm;
    for (let i = 0; i < src.vertexCount; i++) {
      // +X turned toward (cos, 0, sin): x' = x·cos − z·sin, z' = x·sin + z·cos.
      const x = sp[i * 3]!;
      const z = sp[i * 3 + 2]!;
      const nx = sn[i * 3]!;
      const nz = sn[i * 3 + 2]!;
      const k = this.vertex(x * cos - z * sin + tx, sp[i * 3 + 1]! + ty, x * sin + z * cos + tz, nx * cos - nz * sin, sn[i * 3 + 1]!, nx * sin + nz * cos, src.uv[i * 2]!, src.uv[i * 2 + 1]!, 0);
      this.col[k * 4 + TRIM_COLOUR_OCCLUSION] = src.col[i * 4 + TRIM_COLOUR_OCCLUSION]!;
    }
    if (this.indexCount + src.indexCount > this.idx.length) this.idx = grown(this.idx, this.indexCount + src.indexCount);
    for (let i = 0; i < src.indexCount; i++) this.idx[this.indexCount++] = src.idx[i]! + base;
    // The piece's far level, unless the copies are all detail.
    if (this.detail) return;
    if (this.farCount + src.farCount > this.far.length) this.far = grown(this.far, this.farCount + src.farCount);
    for (let i = 0; i < src.farCount; i++) this.far[this.farCount++] = src.far[i]! + base;
  }

  /** The arrays, cut to what was written (copies: the writer may be used again). */
  finish(): ArchMeshArrays {
    return {
      positions: this.pos.slice(0, this.vertexCount * 3),
      normals: this.nrm.slice(0, this.vertexCount * 3),
      uvs: this.uv.slice(0, this.vertexCount * 2),
      colors: this.col.slice(0, this.vertexCount * 4),
      indices: this.idx.slice(0, this.indexCount),
      farIndices: this.far.slice(0, this.farCount),
    };
  }
}

/** An index list grown to hold at least `need` (doubling). */
function grown(a: Uint32Array, need: number): Uint32Array {
  const n = new Uint32Array(Math.max(need, Math.ceil(a.length * GROW) + 48));
  n.set(a);
  return n;
}

/** The writers of one chunk: one per material slot. */
export class ArchChunkWriters {
  readonly map = new Map<string, ArchMeshWriter>();
  /** Triangles written from now on are detail (near level only) or not, in every writer. */
  detail = false;
  get(material: string): ArchMeshWriter {
    let w = this.map.get(material);
    if (w === undefined) {
      w = new ArchMeshWriter();
      this.map.set(material, w);
    }
    w.detail = this.detail;
    return w;
  }
}

// ---- polygons --------------------------------------------------------------------------------

/** Twice the signed area of a 2D polygon (xy pairs; positive: counter-clockwise). */
export function polygonArea2(p: ArrayLike<number>): number {
  const n = p.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2]! * p[j * 2 + 1]! - p[j * 2]! * p[i * 2 + 1]!;
  }
  return a;
}

function inTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Ear-clipping triangulation of a simple 2D polygon (xy pairs, either
 * winding): index triples into its points. Deterministic (first ear found,
 * in order); O(n²), fine for room outlines.
 */
export function triangulatePolygon(p: ArrayLike<number>): number[] {
  const n = p.length / 2;
  const out: number[] = [];
  if (n < 3) return out;
  const ccw = polygonArea2(p) > 0;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length]!;
      const b = idx[k]!;
      const c = idx[(k + 1) % idx.length]!;
      const ax = p[a * 2]!;
      const ay = p[a * 2 + 1]!;
      const bx = p[b * 2]!;
      const by = p[b * 2 + 1]!;
      const cx = p[c * 2]!;
      const cy = p[c * 2 + 1]!;
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (cross <= 1e-12) continue;
      let inside = false;
      for (const q of idx) {
        if (q === a || q === b || q === c) continue;
        const qx = p[q * 2]!;
        const qy = p[q * 2 + 1]!;
        // A hole's bridge repeats two points: a copy of the ear's own corner is not inside it.
        if ((qx === ax && qy === ay) || (qx === bx && qy === by) || (qx === cx && qy === cy)) continue;
        if (inTriangle(qx, qy, ax, ay, bx, by, cx, cy)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push(a, b, c);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate (collinear) remainder: drop the flattest point and go on.
      idx.splice(0, 1);
    }
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}

/**
 * One polygon from an outer polygon and holes inside it (xy pairs each): each
 * hole joined to the outline by a bridge (there and back along one line) from
 * its rightmost point to a point of the outline it can see, so ear clipping
 * fills the outline round the holes. The outline comes out counter-clockwise.
 * A hole not inside the outline is left out.
 */
export function bridgeHoles(outer: ArrayLike<number>, holes: readonly ArrayLike<number>[]): number[] {
  let poly: number[] = Array.from(outer);
  if (polygonArea2(poly) < 0) poly = reversed(poly);
  const hs = holes
    .map((h) => (polygonArea2(h) > 0 ? reversed(Array.from(h)) : Array.from(h)))
    .filter((h) => h.length >= 6 && pointInPolygon(h[0]!, h[1]!, poly))
    .map((h) => {
      let m = 0;
      for (let i = 1; i < h.length / 2; i++) if (h[i * 2]! > h[m * 2]! || (h[i * 2]! === h[m * 2]! && h[i * 2 + 1]! < h[m * 2 + 1]!)) m = i;
      return { h, m };
    })
    .sort((a, b) => b.h[b.m * 2]! - a.h[a.m * 2]!);
  for (const { h, m } of hs) {
    const mx = h[m * 2]!;
    const my = h[m * 2 + 1]!;
    const n = poly.length / 2;
    // The nearest crossing of the ray to +x with the outline, and the edge's end further along x.
    let best = Infinity;
    let pick = -1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = poly[i * 2]!;
      const ay = poly[i * 2 + 1]!;
      const bx = poly[j * 2]!;
      const by = poly[j * 2 + 1]!;
      if ((ay > my) === (by > my) && ay !== my && by !== my) continue;
      if (ay === by) continue;
      const t = (my - ay) / (by - ay);
      if (t < 0 || t > 1) continue;
      const x = ax + (bx - ax) * t;
      if (x < mx || x >= best) continue;
      best = x;
      pick = ax > bx ? i : j;
    }
    if (pick < 0) continue;
    // A point of the outline inside the triangle (M, crossing, pick) hides pick: take the one at the smallest angle.
    const px = poly[pick * 2]!;
    const py = poly[pick * 2 + 1]!;
    let v = pick;
    let bestAngle = Infinity;
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const qx = poly[i * 2]!;
      const qy = poly[i * 2 + 1]!;
      if (i !== pick && !(qx >= mx && inTriangle(qx, qy, mx, my, best, my, px, py))) continue;
      // The angle off the ray as its tangent (candidates lie ahead of M): plain arithmetic, the same everywhere.
      const angle = Math.abs(qy - my) / Math.max(1e-12, qx - mx);
      const d = (qx - mx) * (qx - mx) + (qy - my) * (qy - my);
      if (angle < bestAngle - 1e-12 || (Math.abs(angle - bestAngle) <= 1e-12 && d < bestDist)) {
        bestAngle = angle;
        bestDist = d;
        v = i;
      }
    }
    const hn = h.length / 2;
    const ring: number[] = [];
    for (let k = 0; k <= hn; k++) {
      const q = (m + k) % hn;
      ring.push(h[q * 2]!, h[q * 2 + 1]!);
    }
    poly = [...poly.slice(0, v * 2 + 2), ...ring, poly[v * 2]!, poly[v * 2 + 1]!, ...poly.slice(v * 2 + 2)];
  }
  return poly;
}

function reversed(p: number[]): number[] {
  const out: number[] = [];
  for (let i = p.length / 2 - 1; i >= 0; i--) out.push(p[i * 2]!, p[i * 2 + 1]!);
  return out;
}

/** Whether a 2D point lies inside a polygon (xy pairs; even-odd). */
export function pointInPolygon(x: number, y: number, p: ArrayLike<number>): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2]!;
    const yi = p[i * 2 + 1]!;
    const xj = p[j * 2]!;
    const yj = p[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Clip a convex 2D polygon (xy pairs) to `a·x + b·y ≥ c`. */
function clipHalf(poly: number[], a: number, b: number, c: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const px = poly[i * 2]!;
    const py = poly[i * 2 + 1]!;
    const qx = poly[j * 2]!;
    const qy = poly[j * 2 + 1]!;
    const dp = a * px + b * py - c;
    const dq = a * qx + b * qy - c;
    if (dp >= 0) out.push(px, py);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push(px + (qx - px) * t, py + (qy - py) * t);
    }
  }
  return out;
}

/** Distance from a 2D point to the nearest of a polygon's edges (xy pairs, closed). */
export function distanceToEdges(px: number, py: number, p: ArrayLike<number>): number {
  const n = p.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2]!;
    const ay = p[i * 2 + 1]!;
    const dx = p[j * 2]! - ax;
    const dy = p[j * 2 + 1]! - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + dx * t - px;
    const ey = ay + dy * t - py;
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** A plane's frame: origin, the strips' along axis (u) and across axis (v), and the face's normal. */
export interface PlaneFrame {
  o: readonly number[];
  a: readonly number[];
  b: readonly number[];
  n: readonly number[];
}

export interface PlanarFillOptions {
  sheet: TrimSheet;
  row: TrimRow;
  /** Metres between cells along the strips (absent: the row's height). */
  cell?: number;
  /** Occlusion at the polygon's edges fading over `aoRadius` (0: none). */
  aoStrength: number;
  aoRadius: number;
  /** The polygon whose edges darken (absent: the filled one). */
  aoEdges?: ArrayLike<number>;
  /** More polygons whose edges darken too (holes'). */
  aoLoops?: readonly ArrayLike<number>[];
}

/** The vertex written at exactly (x, y) of a band's cells (`seen`: their points in order; `cells`: first vertex, count), or -1. */
function vertexOf(seen: readonly number[], cells: readonly number[], x: number, y: number): number {
  let at = 0;
  for (let q = 0; q < cells.length; q += 2) {
    for (let k = 0; k < cells[q + 1]!; k++, at++) if (seen[at * 2] === x && seen[at * 2 + 1] === y) return cells[q]! + k;
  }
  return -1;
}

/**
 * Fill a planar polygon (2D xy pairs in the frame's a/b coordinates) into
 * `w`: triangulated, cut into strips one row tall across b (aligned to
 * multiples of the row's height from the frame's origin, so neighbouring
 * fills line up) and cells along a; each strip spans its row once.
 */
export function fillPlanarPolygon(w: ArchMeshWriter, poly: ArrayLike<number>, f: PlaneFrame, opt: PlanarFillOptions): void {
  const tris = triangulatePolygon(poly);
  if (tris.length === 0) return;
  const density = trimRowDensity(opt.sheet, opt.row);
  const h = (opt.row.bottom - opt.row.top) / density;
  const cell = Math.max(0.1, opt.cell ?? h);
  const su = density / opt.sheet.size[0];
  const [v0, v1] = trimRowV(opt.sheet, opt.row);
  const edges = opt.aoEdges ?? poly;
  const [nx, ny, nz] = [f.n[0]!, f.n[1]!, f.n[2]!];
  for (let t = 0; t < tris.length; t += 3) {
    const tri = [poly[tris[t]! * 2]!, poly[tris[t]! * 2 + 1]!, poly[tris[t + 1]! * 2]!, poly[tris[t + 1]! * 2 + 1]!, poly[tris[t + 2]! * 2]!, poly[tris[t + 2]! * 2 + 1]!];
    let bmin = Infinity;
    let bmax = -Infinity;
    let amin = Infinity;
    let amax = -Infinity;
    for (let k = 0; k < 3; k++) {
      amin = Math.min(amin, tri[k * 2]!);
      amax = Math.max(amax, tri[k * 2]!);
      bmin = Math.min(bmin, tri[k * 2 + 1]!);
      bmax = Math.max(bmax, tri[k * 2 + 1]!);
    }
    for (let bi = Math.floor(bmin / h); bi * h < bmax; bi++) {
      const lo = bi * h;
      const band = clipHalf(clipHalf(tri, 0, 1, lo), 0, -1, -(lo + h));
      if (band.length < 6) continue;
      // The far level: the band (convex) as one fan over the cells' vertices at its corners (the same places, UVs
      // and AO: UVs follow the place); the cells' own triangles if a corner is in no cell (a sliver left out).
      const seen: number[] = [];
      const cells: number[] = [];
      for (let ai = Math.floor(amin / cell); ai * cell < amax; ai++) {
        const cellPoly = clipHalf(clipHalf(band, 1, 0, ai * cell), -1, 0, -(ai + 1) * cell);
        const m = cellPoly.length / 2;
        if (m < 3 || Math.abs(polygonArea2(cellPoly)) < 1e-10) continue;
        const first = w.vertexCount;
        cells.push(first, m);
        for (let k = 0; k < m; k++) {
          const x = cellPoly[k * 2]!;
          const y = cellPoly[k * 2 + 1]!;
          seen.push(x, y);
          let across = (y - lo) / h;
          across = across < 0 ? 0 : across > 1 ? 1 : across;
          let dEdge = opt.aoStrength > 0 ? distanceToEdges(x, y, edges) : 0;
          if (opt.aoStrength > 0) for (const loop of opt.aoLoops ?? []) dEdge = Math.min(dEdge, distanceToEdges(x, y, loop));
          const occ = opt.aoStrength > 0 ? opt.aoStrength * Math.max(0, 1 - dEdge / opt.aoRadius) : 0;
          w.vertex(f.o[0]! + f.a[0]! * x + f.b[0]! * y, f.o[1]! + f.a[1]! * x + f.b[1]! * y, f.o[2]! + f.a[2]! * x + f.b[2]! * y, nx, ny, nz, x * su, v0 + (v1 - v0) * across, occ);
        }
        for (let k = 1; k < m - 1; k++) w.triangleIn(NEAR, first, first + k, first + k + 1, nx, ny, nz);
      }
      const fan: number[] = [];
      for (let k = 0; k < band.length / 2; k++) {
        const v = vertexOf(seen, cells, band[k * 2]!, band[k * 2 + 1]!);
        if (v < 0) {
          fan.length = 0;
          break;
        }
        if (fan[fan.length - 1] !== v) fan.push(v);
      }
      while (fan.length > 1 && fan[fan.length - 1] === fan[0]) fan.pop();
      if (fan.length >= 3) for (let k = 1; k < fan.length - 1; k++) w.triangleIn(FAR, fan[0]!, fan[k]!, fan[k + 1]!, nx, ny, nz);
      else for (let q = 0; q < cells.length; q += 2) for (let k = 1; k < cells[q + 1]! - 1; k++) w.triangleIn(FAR, cells[q]!, cells[q]! + k, cells[q]! + k + 1, nx, ny, nz);
    }
  }
}
