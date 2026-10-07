/**
 * Meshing a block layer chunk — the stand-in shapes (full,
 * half, ramp, stairs, custom boxes), the hidden-face removal between
 * neighbours, and the merged per-chunk geometry the renderer draws (one
 * part per block look and material) and the collision triangles the 3D
 * physics port takes (one triangle mesh per chunk, split to the port's
 * mesh limits).
 *
 * Hidden faces: a triangle lying on one of its cell's six boundary planes is
 * dropped when the neighbour across that plane is solid (fills its cell), or
 * shows the very same face profile on the opposite side (two half blocks side
 * by side, two ramps next to each other). That works for any mesh whose outer
 * faces lie on the cell boundary — the stand-ins and kit models alike — and
 * never drops a triangle that could be seen. Multi-cell footprints keep all
 * their faces and never hide a neighbour's.
 *
 * Block-local frame: the origin at the bottom centre of the block's
 * footprint, +Y up, metres; a rotation turns it about +Y counter-clockwise
 * seen from above (x' = x cos + z sin, z' = −x sin + z cos — three.js's
 * rotation.y). Ramps and stairs rise toward +Z at rotation 0.
 */
import { COLLIDER_3D_LIMITS } from './components';
import { CHUNK_SIZE, blockTypeSolid, rotatedFootprint, type BlockCell, type BlockLayerComponent, type BlockShape, type BlockType, type BlockUvMode } from './block-layers';
import { autoVariant, cellKeyOf, chunkKeyOf, edgeAutoVariant, type BlockGrid } from './block-grid';
import { resolveCellLook, resolveEdgeLook } from './block-connect';
import { blockTypeIsEdge, edgeCollides, edgeFrame, edgeLookMetres, type BlockEdge } from './block-edges';
import { blockTopAt, cellCorners, cornerGradientAt, cornerHeightAt, diagonalSide, rotateXZ, subdividedGradientAt, subdividedHeightAt, topSubSquare, type CellCorners } from './block-surface';

/** Indexed triangles in the block-local frame; `groups` split the index list by material. */
export interface BlockMeshSource {
  positions: Float32Array;
  normals: Float32Array;
  /** Texture coordinates; absent, or NaN at a vertex (a model piece without any): world ones are generated there. */
  uvs?: Float32Array;
  indices: Uint32Array;
  groups: { start: number; count: number; material: number }[];
}

// ---- stand-in shapes -----------------------------------------------------------------

interface Quad {
  p: [number, number, number][];
  n: [number, number, number];
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Quad[] {
  return [
    { p: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], n: [1, 0, 0] },
    { p: [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], n: [-1, 0, 0] },
    { p: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], n: [0, 1, 0] },
    { p: [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], n: [0, -1, 0] },
    { p: [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], n: [0, 0, 1] },
    { p: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], n: [0, 0, -1] },
  ];
}

function quadsToSource(quads: readonly Quad[]): BlockMeshSource {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const q of quads) {
    const base = positions.length / 3;
    for (const v of q.p) {
      positions.push(v[0], v[1], v[2]);
      normals.push(q.n[0], q.n[1], q.n[2]);
    }
    if (q.p.length === 4) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else indices.push(base, base + 1, base + 2);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), groups: [{ start: 0, count: indices.length, material: 0 }] };
}

/** Drop box faces that meet another box's opposite face over their whole area (custom shapes). */
function withoutInnerFaces(boxes: readonly number[][]): Quad[] {
  const all = boxes.map((b) => box(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!));
  const out: Quad[] = [];
  const eps = 1e-6;
  all.forEach((faces, i) => {
    for (const f of faces) {
      const axis = f.n[0] !== 0 ? 0 : f.n[1] !== 0 ? 1 : 2;
      const plane = f.p[0]![axis]!;
      const others = [0, 1, 2].filter((a) => a !== axis);
      const lo = others.map((a) => Math.min(...f.p.map((v) => v[a]!)));
      const hi = others.map((a) => Math.max(...f.p.map((v) => v[a]!)));
      const covered = boxes.some((b, j) => {
        if (j === i) return false;
        // The other box touches this face's plane from the outside.
        const inside = f.n[axis]! > 0 ? Math.abs(b[axis]! - plane) < eps : Math.abs(b[axis + 3]! - plane) < eps;
        if (!inside) return false;
        return others.every((a, k) => b[a]! <= lo[k]! + eps && b[a + 3]! >= hi[k]! - eps);
      });
      if (!covered) out.push(f);
    }
  });
  return out;
}

/**
 * The stand-in / collision geometry of a shape for a footprint of `w × h × d`
 * metres (`none` gives a full box: a look without collision).
 */
export function shapeSource(shape: BlockShape, w: number, h: number, d: number, boxes?: readonly number[][]): BlockMeshSource {
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  switch (shape) {
    case 'half':
      return quadsToSource(box(x0, 0, z0, x1, h / 2, z1));
    case 'ramp': {
      const s = Math.hypot(h, d);
      return quadsToSource([
        { p: [[x0, 0, z1], [x0, 0, z0], [x1, 0, z0], [x1, 0, z1]], n: [0, -1, 0] },
        { p: [[x1, 0, z1], [x1, h, z1], [x0, h, z1], [x0, 0, z1]], n: [0, 0, 1] },
        { p: [[x0, 0, z0], [x0, h, z1], [x1, h, z1], [x1, 0, z0]], n: [0, d / s, -h / s] },
        { p: [[x1, 0, z0], [x1, h, z1], [x1, 0, z1]], n: [1, 0, 0] },
        { p: [[x0, 0, z1], [x0, h, z1], [x0, 0, z0]], n: [-1, 0, 0] },
      ]);
    }
    case 'stairs': {
      const hm = h / 2;
      return quadsToSource([
        { p: [[x0, 0, z1], [x0, 0, z0], [x1, 0, z0], [x1, 0, z1]], n: [0, -1, 0] },
        { p: [[x1, 0, z1], [x1, h, z1], [x0, h, z1], [x0, 0, z1]], n: [0, 0, 1] },
        { p: [[x0, 0, z0], [x0, hm, z0], [x1, hm, z0], [x1, 0, z0]], n: [0, 0, -1] },
        { p: [[x0, hm, z0], [x0, hm, 0], [x1, hm, 0], [x1, hm, z0]], n: [0, 1, 0] },
        { p: [[x0, hm, 0], [x0, h, 0], [x1, h, 0], [x1, hm, 0]], n: [0, 0, -1] },
        { p: [[x0, h, 0], [x0, h, z1], [x1, h, z1], [x1, h, 0]], n: [0, 1, 0] },
        { p: [[x1, 0, z0], [x1, hm, z0], [x1, hm, 0], [x1, 0, 0]], n: [1, 0, 0] },
        { p: [[x1, 0, 0], [x1, h, 0], [x1, h, z1], [x1, 0, z1]], n: [1, 0, 0] },
        { p: [[x0, 0, 0], [x0, hm, 0], [x0, hm, z0], [x0, 0, z0]], n: [-1, 0, 0] },
        { p: [[x0, 0, z1], [x0, h, z1], [x0, h, 0], [x0, 0, 0]], n: [-1, 0, 0] },
      ]);
    }
    case 'custom': {
      const bs = (boxes ?? [[0, 0, 0, 1, 1, 1]]).map((b) => [x0 + b[0]! * w, b[1]! * h, z0 + b[2]! * d, x0 + b[3]! * w, b[4]! * h, z0 + b[5]! * d]);
      return quadsToSource(withoutInnerFaces(bs));
    }
    default:
      return quadsToSource(box(x0, 0, z0, x1, h, z1));
  }
}

// ---- face classification ------------------------------------------------------------

/** Sides: 0 +X, 1 −X, 2 +Y, 3 −Y, 4 +Z, 5 −Z; −1 interior. */
const OPPOSITE = [1, 0, 3, 2, 5, 4];
const SIDE_OFFSET: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** A source turned by a rotation, its triangles' sides, the profile key per side and each triangle's box-mapping projection. */
interface Classified {
  positions: Float32Array;
  normals: Float32Array;
  side: Int8Array;
  profile: string[];
  /** Per triangle: the projection its world texture coordinates use (`projectionOf` its flat face normal). */
  proj: Int8Array;
  /** Per triangle: its flat face normal (x, y, z; unit, either way round; 0 for a degenerate one), which world tangents follow. */
  face: Float64Array;
}

const classifiedCache = new WeakMap<BlockMeshSource, Map<string, Classified>>();

function classify(src: BlockMeshSource, rot: number, w: number, h: number, d: number): Classified {
  let byKey = classifiedCache.get(src);
  if (byKey === undefined) {
    byKey = new Map();
    classifiedCache.set(src, byKey);
  }
  const key = `${rot}|${w}|${h}|${d}`;
  const hit = byKey.get(key);
  if (hit !== undefined) return hit;
  const n = src.positions.length / 3;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [x, z] = rotateXZ(src.positions[i * 3]!, src.positions[i * 3 + 2]!, rot);
    positions[i * 3] = x;
    positions[i * 3 + 1] = src.positions[i * 3 + 1]!;
    positions[i * 3 + 2] = z;
    const [nx, nz] = rotateXZ(src.normals[i * 3]!, src.normals[i * 3 + 2]!, rot);
    normals[i * 3] = nx;
    normals[i * 3 + 1] = src.normals[i * 3 + 1]!;
    normals[i * 3 + 2] = nz;
  }
  const tris = src.indices.length / 3;
  const side = new Int8Array(tris).fill(-1);
  const proj = new Int8Array(tris);
  const face = new Float64Array(tris * 3);
  const planes = [w / 2, -w / 2, h, 0, d / 2, -d / 2];
  const eps = 1e-4 * Math.max(w, h, d);
  // A side's profile: the set of its boundary points projected onto the side
  // plane plus the area they cover (independent of how a face is triangulated).
  const points: number[][] = [[], [], [], [], [], []];
  const area = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t < tris; t++) {
    const a = src.indices[t * 3]!;
    const b = src.indices[t * 3 + 1]!;
    const c = src.indices[t * 3 + 2]!;
    proj[t] = triangleProjection(positions, normals, a, b, c);
    faceNormal(positions, a, b, c, face, t * 3);
    for (let s = 0; s < 6; s++) {
      const axis = s >> 1;
      const plane = planes[s]!;
      if (Math.abs(positions[a * 3 + axis]! - plane) < eps && Math.abs(positions[b * 3 + axis]! - plane) < eps && Math.abs(positions[c * 3 + axis]! - plane) < eps) {
        side[t] = s;
        const [u, v] = [0, 1, 2].filter((x) => x !== axis) as [number, number];
        const pts = points[s]!;
        pts.push(Math.round(positions[a * 3 + u]! * 1e4), Math.round(positions[a * 3 + v]! * 1e4), Math.round(positions[b * 3 + u]! * 1e4), Math.round(positions[b * 3 + v]! * 1e4), Math.round(positions[c * 3 + u]! * 1e4), Math.round(positions[c * 3 + v]! * 1e4));
        const e1u = positions[b * 3 + u]! - positions[a * 3 + u]!;
        const e1v = positions[b * 3 + v]! - positions[a * 3 + v]!;
        const e2u = positions[c * 3 + u]! - positions[a * 3 + u]!;
        const e2v = positions[c * 3 + v]! - positions[a * 3 + v]!;
        area[s] = area[s]! + Math.abs(e1u * e2v - e1v * e2u) / 2;
        break;
      }
    }
  }
  const profile = points.map((pts, s) => (pts.length === 0 ? '' : `${profilePoints(pts)}#${Math.round(area[s]! * 1e4)}`));
  const out = { positions, normals, side, profile, proj, face };
  byKey.set(key, out);
  return out;
}

// ---- world texture coordinates -----------------------------------------------------------

/**
 * Box mapping: a triangle's projection is the axis its flat face normal points
 * along most, with its sign (numbered as the sides: +X, −X, +Y, −Y, +Z, −Z).
 * A slope stays on the top projection up to 45° and takes its wall's past it;
 * the small tolerance keeps an exact 45° slope (rounded in floats) on the top.
 */
export function projectionOf(nx: number, ny: number, nz: number): number {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  const tol = 1e-6 * (ax + ay + az);
  if (ay + tol >= ax && ay + tol >= az) return ny >= 0 ? 2 : 3;
  if (ax + tol >= az) return nx >= 0 ? 0 : 1;
  return nz >= 0 ? 4 : 5;
}

/**
 * Per projection: the axis u follows and its sign, the same for v, and the
 * axis projected away. Seen from outside, every face shows the image upright
 * and unmirrored for textures as the engine loads them (flipY off: v = 0 is
 * the image's top row, so v runs down a wall), a top shows it with the
 * image's top toward −Z, and a bottom seen from below likewise.
 */
const PROJ_U_AXIS = [2, 2, 0, 0, 0, 0];
const PROJ_U_SIGN = [-1, 1, 1, 1, 1, -1];
const PROJ_V_AXIS = [1, 1, 2, 2, 1, 1];
const PROJ_V_SIGN = [-1, -1, 1, -1, -1, -1];
const PROJ_N_AXIS = [0, 0, 1, 1, 2, 2];

/** A triangle's projection from its flat face normal, turned to the side its vertex normals face (a model's winding may be either way). */
function triangleProjection(p: Float32Array, n: Float32Array, a: number, b: number, c: number): number {
  const ex = p[b * 3]! - p[a * 3]!;
  const ey = p[b * 3 + 1]! - p[a * 3 + 1]!;
  const ez = p[b * 3 + 2]! - p[a * 3 + 2]!;
  const fx = p[c * 3]! - p[a * 3]!;
  const fy = p[c * 3 + 1]! - p[a * 3 + 1]!;
  const fz = p[c * 3 + 2]! - p[a * 3 + 2]!;
  const nx = ey * fz - ez * fy;
  const ny = ez * fx - ex * fz;
  const nz = ex * fy - ey * fx;
  const sx = n[a * 3]! + n[b * 3]! + n[c * 3]!;
  const sy = n[a * 3 + 1]! + n[b * 3 + 1]! + n[c * 3 + 1]!;
  const sz = n[a * 3 + 2]! + n[b * 3 + 2]! + n[c * 3 + 2]!;
  if (nx === 0 && ny === 0 && nz === 0) return projectionOf(sx, sy, sz);
  return nx * sx + ny * sy + nz * sz < 0 ? projectionOf(-nx, -ny, -nz) : projectionOf(nx, ny, nz);
}

/**
 * World texture coordinates repeat every this many metres: each chunk takes
 * its UVs from the layer origin less the whole periods below its min corner
 * (x and z), so they stay small on a large layer (float32 UVs tens of
 * kilometres out step by millimetres, several texels of a fine texture).
 * Neighbouring chunks in different periods meet at a whole period, which is
 * a whole number of repeats of any texture whose repeat divides it: 720 m =
 * 2⁴ · 3² · 5, so 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 16 m … and any of those
 * over a whole number (0.5, 0.25, 1.5, 2.5 m …). Other repeats (7 m, 0.7 m)
 * show a seam where the period changes, every 720 m. Heights are not wrapped
 * (a chunk is a whole column).
 */
export const WORLD_UV_PERIOD_METRES = 720;

/** The whole periods a chunk's world UVs leave out along x or z: its min corner (layer-local metres) rounded down to a period. */
export function worldUvWrap(chunkMin: number): number {
  return Math.floor(chunkMin / WORLD_UV_PERIOD_METRES) * WORLD_UV_PERIOD_METRES;
}

/** World texture coordinates (layer-local metres, x and z less the chunk's whole periods `wx`, `wz`) of a point under a projection, written to `out` at `o`. */
function worldUv(proj: number, px: number, py: number, pz: number, wx: number, wz: number, out: number[], o: number): void {
  const ua = PROJ_U_AXIS[proj]!;
  const va = PROJ_V_AXIS[proj]!;
  out[o] = PROJ_U_SIGN[proj]! * (ua === 0 ? px - wx : ua === 1 ? py : pz - wz);
  out[o + 1] = PROJ_V_SIGN[proj]! * (va === 0 ? px - wx : va === 1 ? py : pz - wz);
}

/**
 * Pushes a vertex's tangent under a projection: the direction of +u over its
 * triangle's flat face (dP/du: the projected-away axis follows the face, so a
 * slope's tangent climbs with it), made perpendicular to the vertex normal
 * (Gram-Schmidt). Taken from the face, not the vertex normal: a smoothed
 * vertex's normal can lean far from its face (a bevel's rounded edge), and
 * solving +u on the plane that normal describes tips the tangent toward the
 * projected-away axis, up to nearly vertical. Where the vertex normal runs
 * along +u itself, the tangent is the normal crossed with the face's +v
 * direction instead (there is no +u on the surface to follow). w is the handedness that makes cross(normal, tangent) × w
 * run along −v: toward the top of the image, as glTF's tangents do (textures
 * load with v = 0 the top row), so a normal map whose green points up the
 * image lights the right way. Where a mesh has no tangents, the frame
 * three.js derives from the texture coordinates runs along +v instead, and
 * the renderer turns the green around there.
 */
function worldTangent(proj: number, fx: number, fy: number, fz: number, nx: number, ny: number, nz: number, out: number[]): void {
  const a = PROJ_U_AXIS[proj]!;
  const b = PROJ_V_AXIS[proj]!;
  const c = PROJ_N_AXIS[proj]!;
  const f = [fx, fy, fz];
  const fc = f[c]!;
  // The projected-away axis is the face normal's largest component, so this is only 0 for a degenerate face.
  const flat = Math.abs(fc) < 1e-9;
  const su = PROJ_U_SIGN[proj]!;
  const sv = PROJ_V_SIGN[proj]!;
  const t = [0, 0, 0];
  t[a] = su;
  if (!flat) t[c] = (-f[a]! / fc) * su;
  const d = [0, 0, 0];
  d[b] = sv;
  if (!flat) d[c] = (-f[b]! / fc) * sv;
  const k = nx * t[0]! + ny * t[1]! + nz * t[2]!;
  let gx = t[0]! - nx * k;
  let gy = t[1]! - ny * k;
  let gz = t[2]! - nz * k;
  let len = Math.hypot(gx, gy, gz);
  if (len < 1e-6 * Math.hypot(t[0]!, t[1]!, t[2]!)) {
    // The normal along +u leaves no +u on the surface; any direction perpendicular to it will do, and
    // cross(normal, +v) is one (+v is not along the normal, as +u is).
    gx = ny * d[2]! - nz * d[1]!;
    gy = nz * d[0]! - nx * d[2]!;
    gz = nx * d[1]! - ny * d[0]!;
    len = Math.hypot(gx, gy, gz);
    if (!(len > 0)) [gx, gy, gz, len] = [t[0]!, t[1]!, t[2]!, Math.hypot(t[0]!, t[1]!, t[2]!)];
  }
  const cx = ny * gz - nz * gy;
  const cy = nz * gx - nx * gz;
  const cz = nx * gy - ny * gx;
  out.push(gx / len, gy / len, gz / len, cx * d[0]! + cy * d[1]! + cz * d[2]! >= 0 ? -1 : 1);
}

/** A triangle's flat face normal (unit; 0 when it has no area), written to `out` at `o`. */
function faceNormal(p: Float32Array, a: number, b: number, c: number, out: Float64Array, o: number): void {
  const ex = p[b * 3]! - p[a * 3]!;
  const ey = p[b * 3 + 1]! - p[a * 3 + 1]!;
  const ez = p[b * 3 + 2]! - p[a * 3 + 2]!;
  const fx = p[c * 3]! - p[a * 3]!;
  const fy = p[c * 3 + 1]! - p[a * 3 + 1]!;
  const fz = p[c * 3 + 2]! - p[a * 3 + 2]!;
  const nx = ey * fz - ez * fy;
  const ny = ez * fx - ex * fz;
  const nz = ex * fy - ey * fx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 0) {
    out[o] = nx / len;
    out[o + 1] = ny / len;
    out[o + 2] = nz / len;
  }
}

/** Whether a source vertex has texture coordinates of its own. */
const hasOwnUv = (src: BlockMeshSource, v: number): boolean => src.uvs !== undefined && !Number.isNaN(src.uvs[v * 2]!);

/**
 * A side's boundary points (integer pairs, 0.1 mm) as one string: sorted and
 * without repeats, so two sides compare equal exactly when they have the same
 * set of points. Only equality is ever asked of it, so the order is numeric
 * (no per-point strings to build and sort).
 */
function profilePoints(pts: readonly number[]): string {
  const order: number[] = [];
  for (let i = 0; i < pts.length; i += 2) order.push(i);
  order.sort((i, j) => pts[i]! - pts[j]! || pts[i + 1]! - pts[j + 1]!);
  let out = '';
  let pu = NaN;
  let pv = NaN;
  for (const i of order) {
    const u = pts[i]!;
    const v = pts[i + 1]!;
    if (u === pu && v === pv) continue;
    out += out === '' ? `${u}:${v}` : `/${u}:${v}`;
    pu = u;
    pv = v;
  }
  return out;
}

// ---- sloped cells ------------------------------------------------------------------------

const slopedCache = new WeakMap<BlockMeshSource, Map<string, { source: BlockMeshSource; classified: Classified }>>();

/**
 * A single-cell look with a sloped top: its turned geometry warped so every
 * height y becomes y × the corner surface at the vertex (the bottom stays,
 * the top follows the corners, the sides become trapezoids). Triangles are
 * cut along the top's split diagonal first, so each piece lies in one planar half
 * and the warped mesh is exactly the surface `block-surface.ts` describes;
 * normals are transformed with the warp (the inverse transpose of its
 * Jacobian), and pieces that shrink to nothing (a side whose corners are both
 * 0) are dropped. The result is in the cell's frame at rotation 0 (the
 * rotation is already applied), classified for hidden faces like any look.
 *
 * A top cut n × n (`subdivision` above 1) is cut along the sub-squares'
 * lines first and then along each sub-square's own diagonal, and follows the
 * subdivided surface (inner heights blended from the corners).
 */
function slopedLook(src: BlockMeshSource, rot: number, w: number, h: number, d: number, corners: CellCorners, subdivision = 1): { source: BlockMeshSource; classified: Classified } {
  let byKey = slopedCache.get(src);
  if (byKey === undefined) {
    byKey = new Map();
    slopedCache.set(src, byKey);
  }
  const n = subdivision;
  const key = `${rot}|${w}|${h}|${d}|${corners.join(',')}${n > 1 ? `|${n}` : ''}`;
  const hit = byKey.get(key);
  if (hit !== undefined) return hit;
  if (byKey.size > 4096) byKey.clear();
  const heightAt = n > 1 ? (u: number, v: number): number => subdividedHeightAt(corners, n, u, v) : (u: number, v: number): number => cornerHeightAt(corners, u, v);
  const gradientAt = n > 1 ? (u: number, v: number): [number, number] => subdividedGradientAt(corners, n, u, v) : (u: number, v: number): [number, number] => cornerGradientAt(corners, u, v);
  // Cells are square from above, so a quarter-turned look still fills its cell as it is.
  const turned = classify(src, rot, w, h, d);
  const hasUv = src.uvs !== undefined;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const groups: BlockMeshSource['groups'] = [];
  type V = { p: [number, number, number]; n: [number, number, number]; t: [number, number] };
  const vertex = (i: number): V => {
    const n: [number, number, number] = [turned.normals[i * 3]!, turned.normals[i * 3 + 1]!, turned.normals[i * 3 + 2]!];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return {
    p: [turned.positions[i * 3]!, turned.positions[i * 3 + 1]!, turned.positions[i * 3 + 2]!],
    n: [n[0] / len, n[1] / len, n[2] / len],
    t: hasUv ? [src.uvs![i * 2]!, src.uvs![i * 2 + 1]!] : [0, 0],
    };
  };
  const lerp = (a: V, b: V, k: number): V => ({
    p: [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k],
    n: [a.n[0] + (b.n[0] - a.n[0]) * k, a.n[1] + (b.n[1] - a.n[1]) * k, a.n[2] + (b.n[2] - a.n[2]) * k],
    t: [a.t[0] + (b.t[0] - a.t[0]) * k, a.t[1] + (b.t[1] - a.t[1]) * k],
  });
  const uOf = (v: V): number => Math.min(1, Math.max(0, v.p[0] / w + 0.5));
  const vOf = (v: V): number => Math.min(1, Math.max(0, v.p[2] / d + 0.5));
  // The signed distance to the split diagonal's vertical plane (cells).
  const side = (v: V): number => {
    const s = diagonalSide(corners, uOf(v), vOf(v));
    return Math.abs(s) < 1e-7 ? 0 : s;
  };
  let out = 0;
  const emit = (tri: V[]): void => {
    const cu = (uOf(tri[0]!) + uOf(tri[1]!) + uOf(tri[2]!)) / 3;
    const cv = (vOf(tri[0]!) + vOf(tri[1]!) + vOf(tri[2]!)) / 3;
    const [gu, gv] = gradientAt(cu, cv);
    const warped = tri.map((v) => {
      const f = heightAt(uOf(v), vOf(v));
      const y = v.p[1];
      const a = (y * gu) / w;
      const b = (y * gv) / d;
      let n: [number, number, number] = [f * v.n[0] - a * v.n[1], v.n[1], f * v.n[2] - b * v.n[1]];
      const len = Math.hypot(n[0], n[1], n[2]);
      n = len > 1e-9 ? [n[0] / len, n[1] / len, n[2] / len] : v.n;
      return { p: [v.p[0], y * f, v.p[2]] as [number, number, number], n, t: v.t };
    });
    const [A, B, C] = warped as [V, V, V];
    const ex = [B.p[0] - A.p[0], B.p[1] - A.p[1], B.p[2] - A.p[2]];
    const fx = [C.p[0] - A.p[0], C.p[1] - A.p[1], C.p[2] - A.p[2]];
    const cross = Math.hypot(ex[1]! * fx[2]! - ex[2]! * fx[1]!, ex[2]! * fx[0]! - ex[0]! * fx[2]!, ex[0]! * fx[1]! - ex[1]! * fx[0]!);
    if (cross < 1e-10 * Math.max(w, h, d) ** 2) return;
    for (const v of warped) {
      positions.push(v.p[0], v.p[1], v.p[2]);
      normals.push(v.n[0], v.n[1], v.n[2]);
      if (hasUv) uvs.push(v.t[0], v.t[1]);
    }
    out += 3;
  };
  /** Cut a triangle along a line (`sideOf`: a signed distance, linear in the vertex's position, 0 on it); the pieces go to `next`. */
  const cut = (tri: V[], sideOf: (v: V) => number, next: (t: V[]) => void): void => {
    const s = tri.map(sideOf);
    if (!(s.some((x) => x > 0) && s.some((x) => x < 0))) {
      next(tri);
      return;
    }
    // Cut along the line: the lone vertex on one side makes a triangle, the other two a quad (two triangles).
    const pos = s.filter((x) => x > 0).length;
    const lone = s.findIndex((x) => (pos === 1 ? x > 0 : x < 0));
    if (s.some((x) => x === 0)) {
      // One vertex on the line: the edge opposite it crosses it once.
      const on = s.findIndex((x) => x === 0);
      const a = tri[(on + 1) % 3]!;
      const b = tri[(on + 2) % 3]!;
      const sa = s[(on + 1) % 3]!;
      const sb = s[(on + 2) % 3]!;
      const m = lerp(a, b, sa / (sa - sb));
      next([tri[on]!, a, m]);
      next([tri[on]!, m, b]);
      return;
    }
    const L = tri[lone]!;
    const P = tri[(lone + 1) % 3]!;
    const Q = tri[(lone + 2) % 3]!;
    const sl = s[lone]!;
    const m1 = lerp(L, P, sl / (sl - s[(lone + 1) % 3]!));
    const m2 = lerp(L, Q, sl / (sl - s[(lone + 2) % 3]!));
    next([L, m1, m2]);
    next([m1, P, Q]);
    next([m1, Q, m2]);
  };
  const snap = (x: number): number => (Math.abs(x) < 1e-7 ? 0 : x);
  /**
   * A subdivided top: cut along the sub-squares' lines, then each piece along
   * its sub-square's diagonal. A face on the cell's side follows a straight
   * line of the surface (the blend is linear along a cell edge) and the base
   * does not move, so neither needs the cuts.
   */
  const cutSubdivided = (tri: V[]): void => {
    const on = (f: (v: V) => number, at: number): boolean => tri.every((v) => Math.abs(f(v) - at) < 1e-7);
    if (on(uOf, 0) || on(uOf, 1) || on(vOf, 0) || on(vOf, 1) || tri.every((v) => Math.abs(v.p[1]) < 1e-9)) {
      emit(tri);
      return;
    }
    let pieces = [tri];
    for (let k = 1; k < n; k++) {
      for (const along of [uOf, vOf]) {
        const next: V[][] = [];
        for (const piece of pieces) cut(piece, (v) => snap(along(v) - k / n), (t) => next.push(t));
        pieces = next;
      }
    }
    for (const piece of pieces) {
      const sq = topSubSquare(corners, n, (uOf(piece[0]!) + uOf(piece[1]!) + uOf(piece[2]!)) / 3, (vOf(piece[0]!) + vOf(piece[1]!) + vOf(piece[2]!)) / 3);
      cut(piece, (v) => snap(diagonalSide(sq.corners, uOf(v) * n - sq.i, vOf(v) * n - sq.j)), emit);
    }
  };
  for (const g of src.groups) {
    const start = out;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const tri = [vertex(src.indices[i]!), vertex(src.indices[i + 1]!), vertex(src.indices[i + 2]!)];
      if (n > 1) cutSubdivided(tri);
      else cut(tri, side, emit);
    }
    if (out > start) groups.push({ start, count: out - start, material: g.material });
  }
  const source: BlockMeshSource = {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    ...(hasUv ? { uvs: new Float32Array(uvs) } : {}),
    indices: Uint32Array.from({ length: out }, (_, i) => i),
    groups,
  };
  const result = { source, classified: classify(source, 0, w, h, d) };
  byKey.set(key, result);
  return result;
}

/** The corners on each side (by the side index): +X, −X, +Y, −Y, +Z, −Z. */
const SIDE_CORNERS: readonly (readonly number[])[] = [[1, 2], [0, 3], [], [], [2, 3], [0, 1]];

/** Whether a cell's face on side `s` stays inside the cell's side square (a flat cell's always does). */
function sideInside(corners: CellCorners | null, s: number): boolean {
  return corners === null || SIDE_CORNERS[s]!.every((i) => corners[i]! <= 1);
}

// ---- chunk meshing --------------------------------------------------------------------

/** One merged part of a chunk mesh (a block look × material), in layer-local metres. */
export interface ChunkMeshPart {
  /** `<source key>#<material>` — the renderer's draw-group key. */
  key: string;
  blockId: string;
  variant: number;
  material: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Tangents (xyz, w the handedness): a look with world texture coordinates whose resolver asked for them. */
  tangents?: Float32Array;
  /** Lightmap UVs, when a lightmap layout was made for the chunk (`chunkLightmapLayout`). */
  uv1?: Float32Array;
  indices: Uint32Array;
}

/** What the mesher needs per block cell: the source to draw (null: nothing), and a key naming it. */
export interface BlockLookResolver {
  /**
   * The look of a block type's variant (a stand-in or a model's geometry);
   * null while not loaded (nothing drawn yet). `uv: 'world'` gives every
   * vertex world texture coordinates (absent: the look's own, world ones only
   * where it has none); `tangents` adds tangents to world ones.
   */
  source(type: BlockType, variant: number, footprintMetres: [number, number, number]): { key: string; source: BlockMeshSource; uv?: BlockUvMode; tangents?: boolean } | null;
  /** Whether a block type hides neighbours' faces (default: `blockTypeSolid`). */
  solid?(type: BlockType): boolean;
  /** Whether an edge piece is meshed (default: every one; collision leaves out open ones). */
  edge?(type: BlockType, edge: BlockEdge): boolean;
}

interface CellLook {
  type: BlockType;
  variant: number;
  rot: number;
  single: boolean;
  /** Fills its cell and hides the faces of neighbours touching it (a sloped cell never does). */
  solid: boolean;
  /** A sloped top's corners (null: flat); a side whose corners rise above 1 reaches out of the cell's side square. */
  corners: CellCorners | null;
  classified: Classified | null;
  key: string | null;
  source: BlockMeshSource | null;
  /** Every vertex takes world texture coordinates. */
  world: boolean;
  /** Its world texture coordinates come with tangents. */
  tangents: boolean;
}

class Accumulator {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  tangents: number[] = [];
  indices: number[] = [];
}

/**
 * How a layer's tops are drawn: the `blockLayer` fields `smoothAngle` and
 * `topSubdivision` (absent: flat-shaded tops as the corners lay them — the
 * mesh is then exactly what it was before either field existed).
 */
export interface BlockTopOptions {
  /** Degrees: tops meeting at the same height at less than this angle share smoothed normals; above 0 to take effect. */
  readonly smoothAngle?: number;
  /** Sloped tops cut n × n (1: the corners' two triangles). */
  readonly topSubdivision?: number;
}

/** A layer component's top options. */
export function blockTopOptions(c: Pick<BlockLayerComponent, 'smoothAngle' | 'topSubdivision'>): BlockTopOptions {
  return { ...(c.smoothAngle !== undefined && c.smoothAngle > 0 ? { smoothAngle: c.smoothAngle } : {}), ...(c.topSubdivision !== undefined && c.topSubdivision > 1 ? { topSubdivision: c.topSubdivision } : {}) };
}

/** A block cell placed for meshing: its look, its turned geometry, its origin and which of its sides are hidden. */
interface PlacedCell {
  look: CellLook;
  source: BlockMeshSource;
  rotated: Classified;
  cell: BlockCell;
  ox: number;
  oy: number;
  oz: number;
  hidden: boolean[];
}

/** One top triangle of the chunk waiting for its smoothed normals. */
interface PendingTop {
  part: { acc: Accumulator; seen: SeenVertices; tangents: boolean };
  /** Layer-local positions and uvs of its three corners, its unit face normal and its corners' weld points. */
  p: number[];
  uv: number[];
  n: [number, number, number];
  keys: [WeldPoint, WeldPoint, WeldPoint];
  /** Its projection, and per corner whether its uv is a world one (a world corner is split where the projection changes). */
  proj: number;
  world: [boolean, boolean, boolean];
}

/** A point of the weld: a position on a 0.1 mm grid (layer-local metres) and the tops meeting there. */
interface WeldPoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** [nx, ny, nz, corner angle] per top. */
  readonly list: number[];
  sorted: boolean;
  next: WeldPoint | null;
}

/** Mixes integers into a 32-bit hash bucket (collisions are told apart by the exact values kept beside it). */
const mix = (a: number, b: number, c: number): number => (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d)) | 0;

/**
 * The weld, keyed by numbers: meshing a sloped chunk welds every top corner,
 * and building a string per corner was a large share of the meshing time.
 */
class WeldTable {
  private readonly buckets = new Map<number, WeldPoint>();
  private count = 0;

  at(px: number, py: number, pz: number): WeldPoint {
    const x = Math.round(px * 1e4);
    const y = Math.round(py * 1e4);
    const z = Math.round(pz * 1e4);
    const h = mix(x, y, z);
    const first = this.buckets.get(h);
    for (let w = first ?? null; w !== null; w = w.next) if (w.x === x && w.y === y && w.z === z) return w;
    const w: WeldPoint = { id: this.count++, x, y, z, list: [], sorted: false, next: first ?? null };
    this.buckets.set(h, w);
    return w;
  }
}

interface SeenVertex {
  readonly point: WeldPoint;
  readonly key: readonly number[];
  readonly out: number;
  readonly next: SeenVertex | null;
}

/** A part's smoothed top vertices: a corner landing on the same weld point with the same normal, uv and projection reuses one. */
class SeenVertices {
  private readonly buckets = new Map<number, SeenVertex>();

  /** The vertex for a weld point and rounded normal + uv + projection (`key`), or -1. */
  get(point: WeldPoint, key: readonly number[]): number {
    for (let v = this.buckets.get(this.hash(point, key)) ?? null; v !== null; v = v.next) {
      if (v.point === point && v.key[0] === key[0] && v.key[1] === key[1] && v.key[2] === key[2] && v.key[3] === key[3] && v.key[4] === key[4] && v.key[5] === key[5]) return v.out;
    }
    return -1;
  }

  set(point: WeldPoint, key: readonly number[], out: number): void {
    const h = this.hash(point, key);
    this.buckets.set(h, { point, key, out, next: this.buckets.get(h) ?? null });
  }

  private hash(point: WeldPoint, key: readonly number[]): number {
    return mix(point.id, mix(key[0]!, key[1]!, key[2]!), mix(key[3]!, key[4]!, key[5]!));
  }
}

/**
 * The merged geometry of one chunk: for each block cell of the chunk its
 * look, turned and placed, with the faces hidden by neighbours left out.
 * Positions are relative to the layer origin (the min corner of cell 0).
 *
 * With a crease angle (`options.smoothAngle`) the tops — triangles facing up
 * that lie on their block's top surface — get vertex normals averaged over
 * every top meeting at the same point (the same height there), weighted by
 * the corner angle, leaving out tops turned away by more than the angle (a
 * crease stays hard). The tops of the columns just outside the chunk count
 * too, so both chunks give a point on their shared edge the same normal (no
 * seam). Walls and other faces keep their own normals.
 */
export function meshBlockChunk(grid: BlockGrid, cx: number, cz: number, types: ReadonlyMap<string, BlockType>, looks: BlockLookResolver, options: BlockTopOptions = {}): ChunkMeshPart[] {
  const cs = grid.cellSize;
  const subdivision = Math.max(1, Math.floor(options.topSubdivision ?? 1));
  const smoothAngle = options.smoothAngle ?? 0;
  const smoothing = smoothAngle > 0;
  const solidOf = (t: BlockType): boolean => (looks.solid !== undefined ? looks.solid(t) : blockTypeSolid(t));
  // Looks that depend only on the cell value, by palette index; looks that also depend on the place (a variant
  // picked by weight, a connected piece), by cell.
  const lookCache = new Map<number, CellLook | null>();
  const placeCache = new Map<number, CellLook | null>();
  const lookOf = (x: number, y: number, z: number): CellLook | null => {
    const idx = grid.indexAt(x, y, z);
    if (idx < 0) return null;
    const cell = grid.valueOf(idx);
    if (cell.block === undefined) return null;
    const t = types.get(cell.block);
    if (t === undefined) return null;
    const placed = cell.variant === undefined && (t.variants.length > 1 || t.connect !== undefined);
    const cache = placed ? placeCache : lookCache;
    const cacheKey = placed ? cellKeyOf(x, y, z) : idx;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;
    const resolved = resolveCellLook(grid, t, cell, x, y, z, cell.variant ?? autoVariant(t, x, y, z));
    const variant = resolved.variant;
    const f = rotatedFootprint(t, 0);
    const fm: [number, number, number] = [f[0] * cs[0]!, f[1] * cs[1]!, f[2] * cs[2]!];
    const single = f[0] === 1 && f[1] === 1 && f[2] === 1;
    const src = looks.source(t, variant, fm);
    const rot = resolved.rot;
    const corners = single ? cellCorners(cell) : null;
    const sloped = src !== null && corners !== null ? slopedLook(src.source, rot, fm[0], fm[1], fm[2], corners, subdivision) : null;
    const world = src?.uv === 'world';
    const tangents = world && src?.tangents === true;
    const look: CellLook =
      sloped !== null
        ? { type: t, variant, rot: 0, single, solid: false, corners, classified: sloped.classified, key: src!.key, source: sloped.source, world, tangents }
        : { type: t, variant, rot, single, solid: corners === null && solidOf(t), corners: null, classified: src !== null && single ? classify(src.source, rot, fm[0], fm[1], fm[2]) : null, key: src?.key ?? null, source: src?.source ?? null, world, tangents };
    cache.set(cacheKey, look);
    return look;
  };
  const place = (x: number, y: number, z: number, cell: BlockCell): PlacedCell | null => {
    const look = lookOf(x, y, z);
    if (look === null || look.source === null || look.key === null) return null;
    const f = rotatedFootprint(look.type, look.rot);
    // Which sides are hidden.
    const hidden = [false, false, false, false, false, false];
    if (look.classified !== null) {
      for (let s = 0; s < 6; s++) {
        if (look.classified.profile[s] === '') continue;
        const o = SIDE_OFFSET[s]!;
        const nb = lookOf(x + o[0], y + o[1], z + o[2]);
        if (nb === null || !nb.single) continue;
        // A solid neighbour covers a face only where the face stays inside the cell's side.
        if (nb.solid && sideInside(look.corners, s)) hidden[s] = true;
        else if (nb.classified !== null && nb.classified.profile[OPPOSITE[s]!] === look.classified.profile[s]) hidden[s] = true;
      }
    }
    // The block origin: the bottom centre of its (turned) footprint.
    return { look, source: look.source, rotated: look.classified ?? classifyUnculled(look.source, look.rot), cell, ox: (x + f[0] / 2) * cs[0]!, oy: y * cs[1]!, oz: (z + f[2] / 2) * cs[2]!, hidden };
  };
  // Tops (with a crease angle): each top corner's weld key → its tops' face normals and corner angles, [nx, ny, nz, weight] each.
  const weld = new WeldTable();
  const tops: PendingTop[] = [];
  const topEps = 1e-4 * Math.max(cs[0]!, cs[1]!, cs[2]!);
  /** A visible triangle of a placed cell when it is a top (its corners in layer-local metres and its unit face normal), else null. */
  const topOf = (c: PlacedCell, a: number, b: number, d: number): { p: number[]; n: [number, number, number] } | null => {
    const r = c.rotated.positions;
    const p = [r[a * 3]! + c.ox, r[a * 3 + 1]! + c.oy, r[a * 3 + 2]! + c.oz, r[b * 3]! + c.ox, r[b * 3 + 1]! + c.oy, r[b * 3 + 2]! + c.oz, r[d * 3]! + c.ox, r[d * 3 + 1]! + c.oy, r[d * 3 + 2]! + c.oz];
    const e = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
    const f = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!];
    const nx = e[1]! * f[2]! - e[2]! * f[1]!;
    const ny = e[2]! * f[0]! - e[0]! * f[2]!;
    const nz = e[0]! * f[1]! - e[1]! * f[0]!;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0) || ny / len < 1e-6) return null;
    // On the block's top surface: the centroid at the top's height there.
    const mx = (p[0]! + p[3]! + p[6]!) / 3 - c.ox;
    const my = (p[1]! + p[4]! + p[7]!) / 3 - c.oy;
    const mz = (p[2]! + p[5]! + p[8]!) / 3 - c.oz;
    let top: number;
    if (c.look.corners !== null) top = subdividedHeightAt(c.look.corners, subdivision, Math.min(1, Math.max(0, mx / cs[0]! + 0.5)), Math.min(1, Math.max(0, mz / cs[2]! + 0.5))) * cs[1]!;
    else {
      // A connected piece's top turns with the rotation it resolved to.
      const sample = blockTopAt(c.look.type, c.look.rot === (c.cell.rot ?? 0) ? c.cell : { ...c.cell, rot: c.look.rot as BlockCell['rot'] }, cs, mx, mz);
      if (sample === null) return null;
      top = sample.height;
    }
    return Math.abs(my - top) < topEps ? { p, n: [nx / len, ny / len, nz / len] } : null;
  };
  /** Count a top's corners in the weld (their angles weight its normal). */
  const weldTop = (p: readonly number[], n: readonly number[]): [WeldPoint, WeldPoint, WeldPoint] => {
    const keys: WeldPoint[] = [];
    for (let k = 0; k < 3; k++) {
      const o = k * 3;
      const a = ((k + 1) % 3) * 3;
      const b = ((k + 2) % 3) * 3;
      const ux = p[a]! - p[o]!, uy = p[a + 1]! - p[o + 1]!, uz = p[a + 2]! - p[o + 2]!;
      const vx = p[b]! - p[o]!, vy = p[b + 1]! - p[o + 1]!, vz = p[b + 2]! - p[o + 2]!;
      const cos = (ux * vx + uy * vy + uz * vz) / (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1);
      const key = weld.at(p[o]!, p[o + 1]!, p[o + 2]!);
      key.list.push(n[0]!, n[1]!, n[2]!, Math.acos(Math.min(1, Math.max(-1, cos))));
      keys.push(key);
    }
    return keys as [WeldPoint, WeldPoint, WeldPoint];
  };
  type Part = { acc: Accumulator; seen: SeenVertices; tangents: boolean; blockId: string; variant: number; material: number };
  const parts = new Map<string, Part>();
  const partOf = (lookKey: string, material: number, tangents: boolean, blockId: string, variant: number): Part => {
    const key = `${lookKey}#${material}`;
    let part = parts.get(key);
    if (part === undefined) {
      part = { acc: new Accumulator(), seen: new SeenVertices(), tangents, blockId, variant, material };
      parts.set(key, part);
    }
    return part;
  };
  const uv: number[] = [0, 0];
  const wx = worldUvWrap(cx * CHUNK_SIZE * cs[0]!);
  const wz = worldUvWrap(cz * CHUNK_SIZE * cs[2]!);
  /**
   * One triangle of a placed look (source index `i`, triangle `t`) into its
   * part. A source vertex with world uvs becomes one vertex per projection of
   * the triangles using it (`remap` keys v·7 + 1 + projection; own uvs: v·7).
   */
  const emitTriangle = (part: Part, remap: Map<number, number>, src: BlockMeshSource, rotated: Classified, worldLook: boolean, i: number, t: number, ox: number, oy: number, oz: number): void => {
    const acc = part.acc;
    const proj = rotated.proj[t]!;
    for (let k = 0; k < 3; k++) {
      const v = src.indices[i + k]!;
      const world = worldLook || !hasOwnUv(src, v);
      const rk = world ? v * 7 + 1 + proj : v * 7;
      let out = remap.get(rk);
      if (out === undefined) {
        out = acc.positions.length / 3;
        remap.set(rk, out);
        const px = rotated.positions[v * 3]! + ox;
        const py = rotated.positions[v * 3 + 1]! + oy;
        const pz = rotated.positions[v * 3 + 2]! + oz;
        const nx = rotated.normals[v * 3]!;
        const ny = rotated.normals[v * 3 + 1]!;
        const nz = rotated.normals[v * 3 + 2]!;
        acc.positions.push(px, py, pz);
        acc.normals.push(nx, ny, nz);
        if (world) {
          worldUv(proj, px, py, pz, wx, wz, uv, 0);
          acc.uvs.push(uv[0]!, uv[1]!);
        } else acc.uvs.push(src.uvs![v * 2]!, src.uvs![v * 2 + 1]!);
        if (part.tangents) worldTangent(proj, rotated.face[t * 3]!, rotated.face[t * 3 + 1]!, rotated.face[t * 3 + 2]!, nx, ny, nz, acc.tangents);
      }
      acc.indices.push(out);
    }
  };
  grid.forEachInChunk(chunkKeyOf(cx, cz), (x, y, z, idx) => {
    const cell: BlockCell = grid.valueOf(idx);
    if (cell.block === undefined) return;
    const placed = place(x, y, z, cell);
    if (placed === null) return;
    const { look, source: src, rotated, ox, oy, oz, hidden } = placed;
    for (const g of src.groups) {
      const part = partOf(look.key!, g.material, look.tangents, look.type.blockId, look.variant);
      const remap = new Map<number, number>();
      for (let i = g.start; i < g.start + g.count; i += 3) {
        const t = i / 3;
        const s = look.classified !== null ? look.classified.side[t]! : -1;
        if (s >= 0 && hidden[s]) continue;
        const proj = rotated.proj[t]!;
        if (smoothing) {
          const top = topOf(placed, src.indices[i]!, src.indices[i + 1]!, src.indices[i + 2]!);
          if (top !== null) {
            const uvs = [0, 0, 0, 0, 0, 0];
            const world: [boolean, boolean, boolean] = [false, false, false];
            for (let k = 0; k < 3; k++) {
              const v = src.indices[i + k]!;
              world[k] = look.world || !hasOwnUv(src, v);
              if (world[k]) worldUv(proj, top.p[k * 3]!, top.p[k * 3 + 1]!, top.p[k * 3 + 2]!, wx, wz, uvs, k * 2);
              else {
                uvs[k * 2] = src.uvs![v * 2]!;
                uvs[k * 2 + 1] = src.uvs![v * 2 + 1]!;
              }
            }
            tops.push({ part, p: top.p, uv: uvs, n: top.n, keys: weldTop(top.p, top.n), proj, world });
            continue;
          }
        }
        emitTriangle(part, remap, src, rotated, look.world, i, t, ox, oy, oz);
      }
    }
  });
  // The chunk's edge pieces: each look turned onto its edge, nothing hidden (they are thinner than a cell).
  grid.forEachEdgeInChunk(chunkKeyOf(cx, cz), (x, y, z, axis, idx) => {
    const edge = grid.edgeValueOf(idx);
    const t = types.get(edge.block);
    if (t === undefined || !blockTypeIsEdge(t) || (looks.edge !== undefined && !looks.edge(t, edge))) return;
    const { variant, rot } = resolveEdgeLook(grid, t, edge, x, y, z, axis, edge.variant ?? edgeAutoVariant(t, x, y, z, axis));
    const src = looks.source(t, variant, edgeLookMetres(t, cs));
    if (src === null) return;
    const f = edgeFrame(cs, x, y, z, axis, rot);
    const rotated = classifyUnculled(src.source, f.rot);
    const world = src.uv === 'world';
    for (const g of src.source.groups) {
      const part = partOf(src.key, g.material, world && src.tangents === true, t.blockId, variant);
      const remap = new Map<number, number>();
      for (let i = g.start; i < g.start + g.count; i += 3) emitTriangle(part, remap, src.source, rotated, world, i, i / 3, f.ox, f.oy, f.oz);
    }
  });
  if (smoothing && tops.length > 0) {
    // The tops of the columns around the chunk, so a point on the chunk's edge averages the same tops either side.
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const ring = (x: number, z: number): void =>
      grid.forEachInColumn(x, z, (y, idx) => {
        const cell = grid.valueOf(idx);
        if (cell.block === undefined) return;
        const placed = place(x, y, z, cell);
        if (placed === null) return;
        const { look, source: src } = placed;
        for (const g of src.groups) {
          for (let i = g.start; i < g.start + g.count; i += 3) {
            const s = look.classified !== null ? look.classified.side[i / 3]! : -1;
            if (s >= 0 && placed.hidden[s]) continue;
            const top = topOf(placed, src.indices[i]!, src.indices[i + 1]!, src.indices[i + 2]!);
            if (top !== null) weldTop(top.p, top.n);
          }
        }
      });
    for (let x = x0 - 1; x <= x0 + CHUNK_SIZE; x++) {
      ring(x, z0 - 1);
      ring(x, z0 + CHUNK_SIZE);
    }
    for (let z = z0; z < z0 + CHUNK_SIZE; z++) {
      ring(x0 - 1, z);
      ring(x0 + CHUNK_SIZE, z);
    }
    const cosAngle = Math.cos((Math.min(180, smoothAngle) * Math.PI) / 180) - 1e-9;
    // Each point's tops in one order (whichever chunk sums them), so both chunks of an edge get the very same normal.
    const contributions = (point: WeldPoint): number[] => {
      const list = point.list;
      if (!point.sorted) {
        const entries: number[][] = [];
        for (let i = 0; i < list.length; i += 4) entries.push(list.slice(i, i + 4));
        entries.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]! || a[3]! - b[3]!);
        list.length = 0;
        for (const e of entries) list.push(...e);
        point.sorted = true;
      }
      return list;
    };
    for (const t of tops) {
      const { acc, seen } = t.part;
      for (let k = 0; k < 3; k++) {
        const list = contributions(t.keys[k]!);
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (let i = 0; i < list.length; i += 4) {
          if (list[i]! * t.n[0] + list[i + 1]! * t.n[1] + list[i + 2]! * t.n[2] < cosAngle) continue;
          sx += list[i]! * list[i + 3]!;
          sy += list[i + 1]! * list[i + 3]!;
          sz += list[i + 2]! * list[i + 3]!;
        }
        const len = Math.hypot(sx, sy, sz);
        const n = len > 1e-12 ? [sx / len, sy / len, sz / len] : t.n;
        const u = t.uv[k * 2]!;
        const v = t.uv[k * 2 + 1]!;
        // Corners that land on the same point with the same normal, uv and projection share one vertex.
        const id = [Math.round(n[0]! * 1e6), Math.round(n[1]! * 1e6), Math.round(n[2]! * 1e6), Math.round(u * 1e5), Math.round(v * 1e5), t.world[k] ? t.proj : -1];
        let out = seen.get(t.keys[k]!, id);
        if (out < 0) {
          out = acc.positions.length / 3;
          seen.set(t.keys[k]!, id, out);
          acc.positions.push(t.p[k * 3]!, t.p[k * 3 + 1]!, t.p[k * 3 + 2]!);
          acc.normals.push(n[0]!, n[1]!, n[2]!);
          acc.uvs.push(u, v);
          if (t.part.tangents) worldTangent(t.proj, t.n[0], t.n[1], t.n[2], n[0]!, n[1]!, n[2]!, acc.tangents);
        }
        acc.indices.push(out);
      }
    }
  }
  const out: ChunkMeshPart[] = [];
  for (const [key, p] of [...parts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (p.acc.indices.length === 0) continue;
    out.push({ key, blockId: p.blockId, variant: p.variant, material: p.material, positions: new Float32Array(p.acc.positions), normals: new Float32Array(p.acc.normals), uvs: new Float32Array(p.acc.uvs), ...(p.tangents ? { tangents: new Float32Array(p.acc.tangents) } : {}), indices: new Uint32Array(p.acc.indices) });
  }
  return out;
}

const unculledCache = new WeakMap<BlockMeshSource, Map<number, Classified>>();
function classifyUnculled(src: BlockMeshSource, rot: number): Classified {
  let m = unculledCache.get(src);
  if (m === undefined) {
    m = new Map();
    unculledCache.set(src, m);
  }
  const hit = m.get(rot);
  if (hit !== undefined) return hit;
  // No boundary planes to match: every triangle is interior (kept).
  const c = classify(src, rot, Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
  const kept = { ...c, side: new Int8Array(c.side.length).fill(-1), profile: ['', '', '', '', '', ''] };
  m.set(rot, kept);
  return kept;
}

// ---- collision ---------------------------------------------------------------------------

const collisionSources = new Map<string, BlockMeshSource>();

function collisionSourceOf(t: BlockType, fm: [number, number, number]): BlockMeshSource | null {
  if (t.shape === 'none') return null;
  const key = `${t.shape}|${fm.join(',')}|${JSON.stringify(t.boxes ?? null)}`;
  let s = collisionSources.get(key);
  if (s === undefined) {
    if (collisionSources.size > 4096) collisionSources.clear();
    s = shapeSource(t.shape, fm[0], fm[1], fm[2], t.boxes);
    collisionSources.set(key, s);
  }
  return s;
}

/** A 3D port triangle mesh (flat lists, layer-local metres). */
export interface CollisionMeshPiece {
  vertices: number[];
  indices: number[];
}

/** A collision piece is one mesh collider, so it keeps the mesh collider's limits. */
export const COLLISION_PIECE_LIMITS = Object.freeze({ vertices: COLLIDER_3D_LIMITS.meshVertices, triangles: COLLIDER_3D_LIMITS.meshTriangles });

/**
 * The collision triangles of one chunk from its blocks' collision shapes
 * (faces between neighbours hidden with the collision rule: a neighbour with
 * a full single-cell shape, or the same face profile), vertices merged, split
 * into pieces within the port's mesh limits. Empty: nothing to collide with.
 */
export function collisionMeshChunk(grid: BlockGrid, cx: number, cz: number, types: ReadonlyMap<string, BlockType>): CollisionMeshPiece[] {
  const parts = meshBlockChunk(grid, cx, cz, types, {
    source: (t, _v, fm) => {
      const s = collisionSourceOf(t, fm);
      return s === null ? null : { key: 'c', source: s };
    },
    solid: (t) => t.shape === 'full' && (t.footprint === undefined || (t.footprint[0] === 1 && t.footprint[1] === 1 && t.footprint[2] === 1)),
    // An open door lets the player through.
    edge: (t, e) => edgeCollides(t, e),
  });
  // Merge vertices (1e-4 m grid) and collect the triangles.
  const tris: number[] = [];
  const verts: number[] = [];
  const at = new Map<string, number>();
  const vid = (x: number, y: number, z: number): number => {
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let i = at.get(k);
    if (i === undefined) {
      i = verts.length / 3;
      at.set(k, i);
      verts.push(x, y, z);
    }
    return i;
  };
  for (const p of parts) {
    for (let i = 0; i < p.indices.length; i += 3) {
      const a = p.indices[i]!;
      const b = p.indices[i + 1]!;
      const c = p.indices[i + 2]!;
      const ia = vid(p.positions[a * 3]!, p.positions[a * 3 + 1]!, p.positions[a * 3 + 2]!);
      const ib = vid(p.positions[b * 3]!, p.positions[b * 3 + 1]!, p.positions[b * 3 + 2]!);
      const ic = vid(p.positions[c * 3]!, p.positions[c * 3 + 1]!, p.positions[c * 3 + 2]!);
      if (ia === ib || ib === ic || ia === ic) continue;
      tris.push(ia, ib, ic);
    }
  }
  // Split into pieces within the limits (triangles in order; vertices remapped per piece).
  const pieces: CollisionMeshPiece[] = [];
  let cur: CollisionMeshPiece = { vertices: [], indices: [] };
  let remap = new Map<number, number>();
  for (let i = 0; i < tris.length; i += 3) {
    const need = [tris[i]!, tris[i + 1]!, tris[i + 2]!].filter((v) => !remap.has(v)).length;
    if (cur.indices.length / 3 >= COLLISION_PIECE_LIMITS.triangles || remap.size + need > COLLISION_PIECE_LIMITS.vertices) {
      pieces.push(cur);
      cur = { vertices: [], indices: [] };
      remap = new Map();
    }
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k]!;
      let o = remap.get(v);
      if (o === undefined) {
        o = remap.size;
        remap.set(v, o);
        cur.vertices.push(verts[v * 3]!, verts[v * 3 + 1]!, verts[v * 3 + 2]!);
      }
      cur.indices.push(o);
    }
  }
  if (cur.indices.length > 0) pieces.push(cur);
  return pieces;
}

/** The chunk (cx, cz) holding a cell column. */
export function chunkOfCell(x: number, z: number): [number, number] {
  return [Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
}
