/**
 * The engine's default fallback kit: procedural pieces, so a world whose
 * materials no game kit binds still shows where its faces meet instead of
 * bare square voxel edges. It is engine-owned stand-in art, generated in code
 * here (no files, nothing to import, the same in every build), game-ready
 * and small:
 *
 * - **Edges:** a rounded strip along the edge (a quadratic profile from one
 *   face to the other, 1/4 cell in on each face and at most 1/16 proud, so
 *   it covers the voxel's square edge), its two ends closed.
 *   Inner edges take a cove in the open cell (a fillet between the two
 *   faces). One mesh each: the vertical and bottom edges are **aliases**,
 *   the top edge's mesh turned onto their side (one of the 24 cube
 *   rotations, cube-rotations.ts).
 * - **Corners:** an outer corner's cap is a curved triangle that closes the
 *   three strips meeting there (its rims are their end profiles); the bottom
 *   corner is the top one turned. Inner corners take none: the three coves
 *   meet by themselves.
 * - **Roof edges:** where the roof mesher's planes meet or end, each
 *   following the planes: a ridge cap and hip and valley caps over the line
 *   the planes meet on, a verge board along the slope up the gable edge
 *   (one mesh for both verges of a gable: the second is drawn mirrored), a
 *   chamfered eave lip under the low edge.
 * - **Debris:** chamfered rubble chunks on a damaged cell (two stages) and a
 *   chamfered broken rim on an intact face toward it.
 *
 * Flat faces stay plain voxel faces: no piece here covers one. Pieces are
 * drawn in the near ring only (level 0), so each has one mesh.
 *
 * **Every catalogue case has an answer here** ({@link DEFAULT_KIT_PIECES}):
 * a mesh, an alias, or `null` where the cell is drawn without one of this
 * kit's pieces: beams, banister rails and posts are drawn by the engine's
 * default pieces, the stand-in families with their run sections
 * (piece-table.ts, below `KIT_PIECE_BASE`), which every kit falls back to;
 * inner corners are left to the coves.
 *
 * A mesh is in metres, centred on the owning cell, in its case's own
 * orientation (kit-case-catalogue.ts: the open side toward +z, a vertical
 * edge or corner toward +x and +z, up +y), with UVs in cells for the debug
 * texture; a renderer turns, tips and staggers it as it does a kit's own.
 */
import { CUBE_ROTATION_X90, CUBE_ROTATION_ZM90 } from './cube-rotations';
import type { CaseCatalogueDef } from './kit-cases';
import type { PieceAlias, PieceKitSource } from './piece-table';
import { VOXEL_SIZE_M } from './coords';

/** The default kit's id: outside the project id syntax, so no project kit can take it. */
export const DEFAULT_KIT_ID = '@engine-default';

/** Sixteenths of a cell the default pieces' sizes are written in. */
export const DEFAULT_KIT_UNITS = 16;

/** A box: [x0, y0, z0, x1, y1, z1] in sixteenths of a cell from the cell's corner, in the case's orientation. */
export type DefaultKitBox = readonly [number, number, number, number, number, number];

/** A generated mesh: metres centred on the cell, smooth or flat normals, UVs in cells, triangles wound out. */
export interface KitMeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint16Array;
}

/** A default piece: its own mesh, or another case's mesh turned (an alias); and why it looks like that. */
export interface DefaultKitPiece {
  readonly note: string;
  readonly mesh?: () => KitMeshData;
  readonly alias?: PieceAlias;
}

type V3 = [number, number, number];

/** Builds a mesh from triangles of (position, normal, uv) vertices, sharing equal vertices. */
class MeshBuilder {
  private readonly p: number[] = [];
  private readonly n: number[] = [];
  private readonly t: number[] = [];
  private readonly i: number[] = [];
  private readonly at = new Map<string, number>();

  vertex(p: V3, n: V3, uv: readonly [number, number]): number {
    const key = [...p, ...n, ...uv].map((v) => v.toFixed(5)).join(',');
    let k = this.at.get(key);
    if (k === undefined) {
      k = this.p.length / 3;
      this.p.push(...p);
      this.n.push(...n);
      this.t.push(...uv);
      this.at.set(key, k);
    }
    return k;
  }

  /** A triangle, wound so its front faces along `out` (its vertices' normals, or a face's). */
  tri(a: number, b: number, c: number, out: V3): void {
    const P = this.p;
    const e1 = [P[b * 3]! - P[a * 3]!, P[b * 3 + 1]! - P[a * 3 + 1]!, P[b * 3 + 2]! - P[a * 3 + 2]!];
    const e2 = [P[c * 3]! - P[a * 3]!, P[c * 3 + 1]! - P[a * 3 + 1]!, P[c * 3 + 2]! - P[a * 3 + 2]!];
    const g = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    if (g[0]! * out[0] + g[1]! * out[1] + g[2]! * out[2] >= 0) this.i.push(a, b, c);
    else this.i.push(a, c, b);
  }

  /** A flat polygon (convex, as a fan) with one normal and planar UVs. */
  flat(points: readonly V3[], normal: V3): void {
    const ids = points.map((q) => this.vertex(q, normal, planarUv(q, normal)));
    for (let k = 1; k + 1 < ids.length; k++) this.tri(ids[0]!, ids[k]!, ids[k + 1]!, normal);
  }

  done(): KitMeshData {
    const half = VOXEL_SIZE_M / 2;
    // Built in cells from the cell's corner; stored in metres about its centre.
    return Object.freeze({
      positions: Float32Array.from(this.p, (v) => v * VOXEL_SIZE_M - half),
      normals: Float32Array.from(this.n),
      uvs: Float32Array.from(this.t),
      indices: Uint16Array.from(this.i),
    });
  }
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => mul(a, 1 / Math.hypot(...a));

/** UVs in cells along a face's two axes (the debug texture's cell a cell). */
function planarUv(p: V3, n: V3): [number, number] {
  const [ax, ay, az] = n.map(Math.abs) as V3;
  if (az >= ax && az >= ay) return [p[0], p[1]];
  if (ax >= ay) return [p[2], p[1]];
  return [p[0], p[2]];
}

const U = DEFAULT_KIT_UNITS;
/** How far an outer strip reaches in along each face, and its profile's control point out of the edge (16ths). */
const EDGE_REACH = 4;
const EDGE_BULGE = 3;
/**
 * A cove's reach along each face and its control point off the inner edge (16ths): it starts on each face and leaves
 * it at an angle (never tangent, so it does not fight the face it starts on).
 */
const COVE_REACH = 4;
const COVE_CONTROL = 1;
/** Profile segments of a strip. */
const SEGMENTS = 4;

/** A quadratic Bézier's point and tangent at t. */
function bezier2(a: readonly [number, number], c: readonly [number, number], b: readonly [number, number], t: number): { p: [number, number]; d: [number, number] } {
  const s = 1 - t;
  return {
    p: [s * s * a[0] + 2 * s * t * c[0] + t * t * b[0], s * s * a[1] + 2 * s * t * c[1] + t * t * b[1]],
    d: [2 * s * (c[0] - a[0]) + 2 * t * (b[0] - c[0]), 2 * s * (c[1] - a[1]) + 2 * t * (b[1] - c[1])],
  };
}

/**
 * A strip along x through the cell at edge (y0, z0) (16ths) whose profile in (y, z) offsets from the edge is the
 * Bézier a → c → b, normals out toward (+y, +z) of the profile's frame `fy`, `fz` (±1: which way the open side is).
 * Both ends are closed by a fan from the edge line.
 */
function strip(a: readonly [number, number], c: readonly [number, number], b: readonly [number, number], edge: readonly [number, number], f: readonly [number, number]): KitMeshData {
  const m = new MeshBuilder();
  const n = SEGMENTS;
  const pts: { y: number; z: number; ny: number; nz: number; v: number }[] = [];
  let arc = 0;
  let prev: [number, number] | null = null;
  for (let k = 0; k <= n; k++) {
    const { p, d } = bezier2(a, c, b, k / n);
    // The profile's normal: perpendicular to its tangent, toward the open side.
    let nr: [number, number] = [-d[1], d[0]];
    if (nr[0] + nr[1] < 0) nr = [-nr[0], -nr[1]];
    const len = Math.hypot(...nr);
    if (prev !== null) arc += Math.hypot(p[0] - prev[0], p[1] - prev[1]) / U;
    prev = p;
    pts.push({ y: (edge[0] + f[0] * p[0]) / U, z: (edge[1] + f[1] * p[1]) / U, ny: (f[0] * nr[0]) / len, nz: (f[1] * nr[1]) / len, v: arc });
  }
  const ids = [0, 1].map((x) => pts.map((q) => m.vertex([x, q.y, q.z], [0, q.ny, q.nz], [x, q.v])));
  for (let k = 0; k < n; k++) {
    const out: V3 = [0, pts[k]!.ny + pts[k + 1]!.ny, pts[k]!.nz + pts[k + 1]!.nz];
    m.tri(ids[0]![k]!, ids[1]![k]!, ids[1]![k + 1]!, out);
    m.tri(ids[0]![k]!, ids[1]![k + 1]!, ids[0]![k + 1]!, out);
  }
  for (const x of [0, 1]) {
    const normal: V3 = [x === 0 ? -1 : 1, 0, 0];
    const hub: V3 = [x, edge[0] / U, edge[1] / U];
    for (let k = 0; k < n; k++) m.flat([hub, [x, pts[k]!.y, pts[k]!.z], [x, pts[k + 1]!.y, pts[k + 1]!.z]], normal);
  }
  return m.done();
}

/** The outer top edge: a rounded strip over the edge at (y 16, z 16), from the top face to the front face. */
function outerEdge(): KitMeshData {
  // Offsets from the edge, (into −y …, into −z …): starts on the top face 1/4 cell back, ends on the front face 1/4 down.
  return strip([0, -EDGE_REACH], [EDGE_BULGE, EDGE_BULGE], [-EDGE_REACH, 0], [U, U], [1, 1]);
}

/** The inner bottom edge's cove in the open cell above and in front (floor meets wall), at (y 16, z 16). */
function innerEdge(): KitMeshData {
  return strip([0, COVE_REACH], [COVE_CONTROL, COVE_CONTROL], [COVE_REACH, 0], [U, U], [1, 1]);
}

/**
 * The outer top corner's cap at (16, 16, 16): a quadratic Bézier triangle whose three rims are the end profiles of
 * the strips meeting there, so it closes them; normals from its derivatives.
 */
function outerCorner(): KitMeshData {
  const m = new MeshBuilder();
  const w = EDGE_REACH;
  const o = EDGE_BULGE;
  // Control net about the corner, in 16ths: corners on the three edges, rims' control points between them.
  const P200: V3 = [-w, 0, 0];
  const P020: V3 = [0, -w, 0];
  const P002: V3 = [0, 0, -w];
  const P110: V3 = [o, o, 0];
  const P101: V3 = [o, 0, o];
  const P011: V3 = [0, o, o];
  const at = (u: number, v: number): V3 => {
    const s = 1 - u - v;
    let p = add(add(mul(P200, u * u), mul(P020, v * v)), mul(P002, s * s));
    p = add(p, add(add(mul(P110, 2 * u * v), mul(P101, 2 * u * s)), mul(P011, 2 * v * s)));
    return p;
  };
  const normal = (u: number, v: number): V3 => {
    const e = 1e-4;
    const uu = Math.min(u, 1 - e - v);
    const vv = Math.min(v, 1 - e - uu);
    const p = at(uu, vv);
    let nr = cross(sub(at(uu + e, vv), p), sub(at(uu, vv + e), p));
    if (dot(nr, [1, 1, 1]) < 0) nr = mul(nr, -1);
    return unit(nr);
  };
  const n = SEGMENTS - 1;
  const id = (i: number, j: number): number => {
    const u = i / n;
    const v = j / n;
    const p = add(at(u, v), [U, U, U]);
    const q: V3 = mul(p, 1 / U);
    const nr = normal(u, v);
    return m.vertex(q, nr, planarUv(q, nr));
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - i; j++) {
      const a = id(i, j);
      const b = id(i + 1, j);
      const c = id(i, j + 1);
      m.tri(a, b, c, [1, 1, 1]);
      if (i + j + 1 < n) m.tri(b, id(i + 1, j + 1), c, [1, 1, 1]);
    }
  }
  return m.done();
}

/** A chamfer's size on boards and rubble (16ths). */
const CHAMFER = 1;

/**
 * Boxes (16ths from the cell's corner) as one mesh, each with its edges and corners chamfered (6 faces, 12 bevels,
 * 8 corner triangles: 44 triangles).
 */
function boxes(list: readonly DefaultKitBox[]): KitMeshData {
  const m = new MeshBuilder();
  for (const b of list) {
    const lo: V3 = [b[0] / U, b[1] / U, b[2] / U];
    const hi: V3 = [b[3] / U, b[4] / U, b[5] / U];
    const c = Math.min(CHAMFER / U, ...[0, 1, 2].map((a) => (hi[a]! - lo[a]!) / 3));
    // A box point: on side s (−1, +1) of each axis, pulled in by the chamfer on the axes named in `inset`.
    const pt = (s: V3, inset: readonly number[]): V3 => [0, 1, 2].map((a) => (s[a]! > 0 ? hi[a]! : lo[a]!) - (inset.includes(a) ? s[a]! * c : 0)) as V3;
    for (let a = 0; a < 3; a++) {
      for (const sa of [-1, 1]) {
        const [b1, b2] = [(a + 1) % 3, (a + 2) % 3];
        const quad: V3[] = [];
        for (const [s1, s2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          const s: V3 = [0, 0, 0];
          s[a] = sa;
          s[b1] = s1;
          s[b2] = s2;
          quad.push(pt(s, [b1, b2]));
        }
        const normal: V3 = [0, 0, 0];
        normal[a] = sa;
        m.flat(quad, normal);
      }
    }
    if (c === 0) continue;
    // Bevels: between the faces of axes a and b, along the third axis.
    for (let a = 0; a < 3; a++) {
      for (let bx = a + 1; bx < 3; bx++) {
        const r = 3 - a - bx;
        for (const sa of [-1, 1]) {
          for (const sb of [-1, 1]) {
            const quad: V3[] = [];
            for (const [sr, onA] of [[-1, true], [1, true], [1, false], [-1, false]] as const) {
              const s: V3 = [0, 0, 0];
              s[a] = sa;
              s[bx] = sb;
              s[r] = sr;
              quad.push(pt(s, onA ? [bx, r] : [a, r]));
            }
            const normal: V3 = [0, 0, 0];
            normal[a] = sa;
            normal[bx] = sb;
            m.flat(quad, unit(normal));
          }
        }
      }
    }
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const s: V3 = [sx, sy, sz];
          m.flat([pt(s, [1, 2]), pt(s, [0, 2]), pt(s, [0, 1])], unit(s));
        }
      }
    }
  }
  return m.done();
}

/**
 * A member between two end sections `a` and `b` (corresponding points, 16ths from the cell's corner): the faces
 * `segs` and the lips `lips` (point i to j, wound toward `out`) and the end caps `caps` (polygons of point indices,
 * convex, the first end's facing `−along`, the second's `+along`).
 */
function loft(a: readonly V3[], b: readonly V3[], along: V3, segs: readonly (readonly [number, number, V3])[], lips: readonly (readonly [number, number, V3])[], caps: readonly (readonly number[])[]): KitMeshData {
  const m = new MeshBuilder();
  const c = (p: V3): V3 => mul(p, 1 / U);
  const face = (pts: V3[], out: V3): void => {
    // The polygon's own normal, turned toward `out` (flat shading, planar UVs).
    let nr = unit(cross(sub(pts[1]!, pts[0]!), sub(pts[2]!, pts[0]!)));
    if (dot(nr, out) < 0) nr = mul(nr, -1);
    m.flat(pts, nr);
  };
  for (const [i, j, out] of [...segs, ...lips]) face([c(a[i]!), c(b[i]!), c(b[j]!), c(a[j]!)], out);
  for (const poly of caps) {
    face(poly.map((k) => c(a[k]!)), mul(along, -1));
    face(poly.map((k) => c(b[k]!)), along);
  }
  return m.done();
}

/** How far a roof cap reaches out from its line along each plane, and how far it stands above the planes (16ths). */
const ROOF_CAP_REACH = 2.5;
const ROOF_CAP_RISE = 0.75;

/**
 * A cap along a line where two 45° planes meet (16ths from the cell's corner): `line(t)` the line's point at t of
 * 0 … 1, `lateral` the horizontal offset that moves onto plane A (its negation onto plane B), `dy` how far the
 * planes are below (convex: a ridge or a hip) or above (concave: a valley) the line at that offset. The cap covers
 * both planes near the line, standing {@link ROOF_CAP_RISE} above them, with a lip down to each plane.
 */
function lineCap(line: (t: number) => V3, lateral: V3, dy: number): KitMeshData {
  const r = ROOF_CAP_RISE;
  const section = (t: number): V3[] => {
    const l = line(t);
    const pa = add(l, [lateral[0], dy, lateral[2]]);
    const pb = add(l, [-lateral[0], dy, -lateral[2]]);
    // A on its plane, A lifted, the line lifted, B lifted, B on its plane, the line on the planes.
    return [pa, add(pa, [0, r, 0]), add(l, [0, r, 0]), add(pb, [0, r, 0]), pb, l];
  };
  const a = section(0);
  const b = section(1);
  const along = unit(sub(line(1), line(0)));
  const up: V3 = [0, 1, 0];
  return loft(a, b, along, [[1, 2, up], [2, 3, up]], [[0, 1, lateral], [3, 4, mul(lateral, -1)]], [[0, 1, 2, 5], [5, 2, 3, 4]]);
}

/** The ridge cap: along x on the cell's +z side, where the plane rising toward +z (y 32 there) meets the other slope. */
function ridgeCap(): KitMeshData {
  const w = ROOF_CAP_REACH;
  return lineCap((t) => [16 * t, 32, 16], [0, 0, w], -w);
}

/**
 * The verge board: up the gable edge on the +z face, along the plane rising toward +x (y 16 at x 0 to 32 at x 16,
 * the plane through the stair's outer corners), from 3 below the plane's edge to {@link ROOF_CAP_RISE} above it,
 * 1.25 out of the face. Its ends are cut square to the slope, so the boards of a gable's cells meet end to end; the
 * other verge of the gable is this one mirrored (roof-mesher.ts `roofEdgesOf`).
 */
function vergeBoard(): KitMeshData {
  const n: V3 = unit([-1, 1, 0]);
  const at = (x: number, s: number, t: number): V3 => add([x, 16 + x, 16 + s], mul(n, t));
  const section = (x: number): V3[] => [at(x, 0, 0), at(x, 0, ROOF_CAP_RISE), at(x, 1.25, ROOF_CAP_RISE), at(x, 1.25, -3), at(x, 0, -3)];
  // Ends square to the slope through the lattice points the plane's edge crosses (x 0 and 16).
  const a = section(0).map((p) => add(p, mul([1, 1, 0], -dot(sub(p, [0, 16, 16]), [0.5, 0.5, 0]))));
  const b = section(16).map((p) => add(p, mul([1, 1, 0], -dot(sub(p, [16, 32, 16]), [0.5, 0.5, 0]))));
  const along = unit([1, 1, 0]);
  return loft(a, b, along, [[1, 2, n], [2, 3, [0, 0, 1]], [3, 4, mul(n, -1)]], [[0, 1, [0, 0, -1]]], [[0, 1, 2, 3, 4]]);
}

/** A hip (convex) or valley (concave) cap: from the cell's low corner (16, 16, 16) up to its high corner (0, 32, 0). */
function diagonalCap(concave: boolean): KitMeshData {
  const w = ROOF_CAP_REACH / Math.SQRT2;
  // Off the line by (w, 0, −w): one plane's distance up the slope changes by w, so its height by ∓w.
  return lineCap((t) => [16 - 16 * t, 16 + 16 * t, 16 - 16 * t], [w, 0, -w], concave ? w : -w);
}

const own = (note: string, mesh: () => KitMeshData): DefaultKitPiece => Object.freeze({ note, mesh });
const box = (note: string, ...list: DefaultKitBox[]): DefaultKitPiece => own(note, () => boxes(list));
const alias = (note: string, of: string, rotation: number): DefaultKitPiece => Object.freeze({ note, alias: Object.freeze({ case: of, rotation }) });

/**
 * Per catalogue case id: the default piece, or null (see the file comment).
 * A test checks this lists exactly the world catalogue's cases.
 */
export const DEFAULT_KIT_PIECES: Readonly<Record<string, DefaultKitPiece | null>> = Object.freeze({
  'edge-out-top': own('a rounded strip over the top edge, from the top face to the front face', outerEdge),
  'edge-out-vertical': alias('the top edge\'s strip turned up the outside corner', 'edge-out-top', CUBE_ROTATION_ZM90),
  'edge-out-bottom': alias('the top edge\'s strip turned under the underside edge', 'edge-out-top', CUBE_ROTATION_X90),
  'edge-in-top': alias('the floor cove turned up under the ceiling', 'edge-in-bottom', CUBE_ROTATION_X90),
  'edge-in-vertical': alias('the floor cove turned up the inside corner', 'edge-in-bottom', CUBE_ROTATION_ZM90),
  'edge-in-bottom': own('a cove where the wall meets the floor, in the open cell', innerEdge),
  'corner-out-top': own('a rounded cap closing the three strips at a top corner', outerCorner),
  'corner-out-bottom': alias('the top corner\'s cap turned under', 'corner-out-top', CUBE_ROTATION_X90),
  'corner-in-top': null,
  'corner-in-bottom': null,
  'roof-ridge': own('a ridge cap over the line the two planes meet on', ridgeCap),
  'roof-eave': box('an eave lip under the plane\'s low edge', [0, -1, 14, 16, 3, 17]),
  'roof-gable': own('a verge board up the gable edge, along the slope (rising toward +x; the other side mirrored)', vergeBoard),
  'roof-hip': own('a hip cap up the line the two planes meet on', () => diagonalCap(false)),
  'roof-valley': own('a valley board up the crease the two planes meet in', () => diagonalCap(true)),
  debris: box('a few chunks of rubble', [2, 0, 3, 9, 6, 10], [8, 0, 6, 14, 4, 13], [4, 5, 5, 10, 9, 11]),
  'debris-heavy': box('a low heap of rubble', [1, 0, 1, 12, 3, 9], [6, 0, 8, 15, 2, 15]),
  'debris-face': box('a broken rim on the face opening to the damage', [3, 3, 16, 13, 13, 17]),
  beam: null,
  'banister-rail': null,
  'banister-post': null,
});

/** A default case's own mesh (null: the case is an alias or has no piece). */
export function defaultKitMesh(caseId: string): KitMeshData | null {
  return DEFAULT_KIT_PIECES[caseId]?.mesh?.() ?? null;
}

/**
 * The default kit as the piece table reads it: one variant of the body
 * section for each case with its own mesh, an alias for each aliased case.
 * Cases the catalogue lacks are left out (a catalogue of another version may
 * have fewer).
 */
export function defaultKitSource(catalogue: CaseCatalogueDef): PieceKitSource {
  const cases: Record<string, { sections?: Record<string, { variants: { weight?: number }[] }>; alias?: PieceAlias }> = {};
  for (const c of catalogue.cases) {
    const p = DEFAULT_KIT_PIECES[c.id];
    if (p?.mesh !== undefined) cases[c.id] = { sections: { body: { variants: [{}] } } };
    else if (p?.alias !== undefined) cases[c.id] = { alias: p.alias };
  }
  return { voxelKitId: DEFAULT_KIT_ID, cases };
}
