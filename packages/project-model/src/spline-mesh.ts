/**
 * What is made along a spline: its mesh (a profile swept along the curve, or
 * a river's water) cut into pieces with levels of detail, and the copies of
 * the models its pieces repeat — and the blob they are stored in (`TLSP`,
 * the spline component's `data`).
 *
 * The mesh: cross-sections `mesh.step` metres apart, each the profile laid
 * across the curve's frame (across scaled by the half width there, up by the
 * frame's up, raised by the offset), cut into pieces about
 * {@link SPLINE_MESH_PIECE_METRES} long so each piece can be culled and
 * switch levels by its own distance. A piece's texture runs across the
 * profile (0-1) and along the curve (metres over the tiling). Water also
 * carries its flow in texture space (UV set 1: texture units a second along
 * the curve) and its foam (COLOR_0 red: 1 at the banks, fading to 0 over
 * `foam` metres in), what a water material reads for two-phase flow and a
 * foam line.
 *
 * The pieces' copies: one every `spacing` metres along the curve from
 * `start`, each facing along it (the model's +X along the curve, its +Y up;
 * upright: turned about up only), placed `offset` across and up.
 *
 * Levels of detail are index lists over a piece's vertices (made by the
 * host's simplifier, which this module does not run). Positions are relative
 * to the piece's centre, the centre relative to the spline object.
 *
 * Pure.
 */
import { hasBinaryMagic, readBinaryBlob, wrapBinaryBlob } from './binary-container';
import { SPLINE_MESH_STEP_DEFAULT, SPLINE_SURFACE_OFFSET_DEFAULT, SPLINE_WATER_FLOW_DEFAULT, SPLINE_WATER_FOAM_DEFAULT, type SplineComponent, type SplinePieceSettings } from './spline';
import { SplineCurve, type SplineFrame } from './spline-curve';
import { INSTANCE_FLOATS } from './types-v3';

/** Metres of curve one mesh piece covers (about: the curve's length divided evenly). */
export const SPLINE_MESH_PIECE_METRES = 64;
/** The first bytes of a spline's made blob ("TLSP"). */
export const SPLINE_MADE_MAGIC = Object.freeze([0x54, 0x4c, 0x53, 0x50]);
/** The payload layout this engine writes and reads. */
export const SPLINE_MADE_LAYOUT = 1;

/** One level of a mesh piece: its triangles over the piece's vertices and how far (m) its surface lies from the finest. */
export interface SplineMeshLevel {
  error: number;
  indices: Uint32Array;
}

/** One piece of a spline's mesh. */
export interface SplineMeshPiece {
  /** Its centre (m from the spline object) and the radius round it its vertices lie within. */
  center: [number, number, number];
  radius: number;
  /** Vertices a cross-section has (its rows run along the curve, first and last where it meets its neighbours). */
  rowLength: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Water only: the flow (UV set 1) and the foam (one per vertex). */
  flow: Float32Array | null;
  foam: Float32Array | null;
  /** The finest level first. */
  levels: SplineMeshLevel[];
}

/** What is made along one spline. */
export interface SplineMade {
  pieces: SplineMeshPiece[];
  /** Each `pieces` setting's copies (10 floats each, m from the spline object), by its index in the list. */
  copies: { index: number; copies: Float32Array }[];
}

const FLAT_PROFILE: readonly (readonly [number, number])[] = [[-1, 0], [1, 0]];
/** Water's cross-section: flat, with points across so its foam can fade in from the banks (vertex values interpolate). */
const WATER_PROFILE: readonly (readonly [number, number])[] = Array.from({ length: 9 }, (_, i) => [i / 4 - 1, 0] as const);

/** The cross-section's points and the normals of the profile (2D: across, up), smoothed at its corners. */
function profileOf(c: SplineComponent): { pts: readonly (readonly [number, number])[]; normals: [number, number][]; u: number[] } {
  const pts = c.mesh?.kind === 'water' ? WATER_PROFILE : (c.mesh?.profile ?? FLAT_PROFILE);
  const n = pts.length;
  const edge = (i: number): [number, number] => {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    // Left to right: the edge's normal is its direction turned a quarter toward up.
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  const normals: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? edge(i - 1) : null;
    const b = i < n - 1 ? edge(i) : null;
    const x = (a?.[0] ?? 0) + (b?.[0] ?? 0);
    const y = (a?.[1] ?? 0) + (b?.[1] ?? 0);
    const l = Math.hypot(x, y) || 1;
    normals.push([x / l, y / l]);
  }
  // Across the texture: the profile's own length, 0 at the left edge, 1 at the right.
  const u: number[] = [0];
  for (let i = 1; i < n; i++) u.push(u[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const total = u[n - 1]! || 1;
  return { pts, normals, u: u.map((v) => v / total) };
}

/** The mesh along a spline (its curve placed at the object's origin), in pieces, each with its finest level only. */
export function sweepSplineMesh(c: SplineComponent): SplineMeshPiece[] {
  const m = c.mesh;
  if (m === undefined || c.points.length < 2) return [];
  const curve = SplineCurve.of(c, [0, 0, 0]);
  if (curve.length <= 0) return [];
  const water = m.kind === 'water';
  const offset = m.offset ?? (water ? 0 : SPLINE_SURFACE_OFFSET_DEFAULT);
  const step = m.step ?? SPLINE_MESH_STEP_DEFAULT;
  const tiling = m.tiling ?? c.width ?? curve.maxWidth;
  const flowRate = (m.flow ?? SPLINE_WATER_FLOW_DEFAULT) / tiling;
  const foam = m.foam ?? SPLINE_WATER_FOAM_DEFAULT;
  const prof = profileOf(c);
  const P = prof.pts.length;
  const count = Math.max(1, Math.round(curve.length / SPLINE_MESH_PIECE_METRES));
  const pieces: SplineMeshPiece[] = [];
  let prev: SplineFrame | undefined;
  for (let k = 0; k < count; k++) {
    const from = (curve.length * k) / count;
    const to = (curve.length * (k + 1)) / count;
    const frames = curve.frames(step, from, to);
    if (prev !== undefined && frames[0] !== undefined) {
      // The first cross-section is the previous piece's last: the same frame, so the pieces meet without a crack.
      frames[0] = prev;
    }
    prev = frames[frames.length - 1];
    const rows = frames.length;
    const v = rows * P;
    const world = new Float64Array(v * 3);
    const normals = new Float32Array(v * 3);
    const uvs = new Float32Array(v * 2);
    const flow = water ? new Float32Array(v * 2) : null;
    const foamMask = water ? new Float32Array(v) : null;
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (let r = 0; r < rows; r++) {
      const f = frames[r]!;
      const hw = f.width / 2;
      for (let j = 0; j < P; j++) {
        const [a, h] = prof.pts[j]!;
        const i = r * P + j;
        const across = a * hw;
        const up = h + offset;
        const x = f.x + f.rx * across + f.ux * up;
        const y = f.y + f.ry * across + f.uy * up;
        const z = f.z + f.rz * across + f.uz * up;
        world[i * 3] = x;
        world[i * 3 + 1] = y;
        world[i * 3 + 2] = z;
        lo = [Math.min(lo[0]!, x), Math.min(lo[1]!, y), Math.min(lo[2]!, z)];
        hi = [Math.max(hi[0]!, x), Math.max(hi[1]!, y), Math.max(hi[2]!, z)];
        const [na, nh] = prof.normals[j]!;
        const nx = f.rx * na + f.ux * nh;
        const ny = f.ry * na + f.uy * nh;
        const nz = f.rz * na + f.uz * nh;
        const nl = Math.hypot(nx, ny, nz) || 1;
        normals[i * 3] = nx / nl;
        normals[i * 3 + 1] = ny / nl;
        normals[i * 3 + 2] = nz / nl;
        uvs[i * 2] = prof.u[j]!;
        uvs[i * 2 + 1] = f.distance / tiling;
        if (flow !== null) {
          flow[i * 2] = 0;
          flow[i * 2 + 1] = flowRate;
        }
        if (foamMask !== null) foamMask[i] = foam > 0 ? Math.max(0, 1 - (hw - Math.abs(across)) / foam) : 0;
      }
    }
    // Held as 32-bit floats, as the blob stores them: what is made reads back the same.
    const center: [number, number, number] = [Math.fround((lo[0]! + hi[0]!) / 2), Math.fround((lo[1]! + hi[1]!) / 2), Math.fround((lo[2]! + hi[2]!) / 2)];
    const positions = new Float32Array(v * 3);
    let r2 = 0;
    for (let i = 0; i < v; i++) {
      const dx = world[i * 3]! - center[0];
      const dy = world[i * 3 + 1]! - center[1];
      const dz = world[i * 3 + 2]! - center[2];
      positions[i * 3] = dx;
      positions[i * 3 + 1] = dy;
      positions[i * 3 + 2] = dz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    // Two triangles per quad between neighbouring cross-sections, wound counter-clockwise seen from the frame's up
    // (right × along points up): their front faces up.
    const indices = new Uint32Array((rows - 1) * (P - 1) * 6);
    let o = 0;
    for (let r = 0; r + 1 < rows; r++) {
      for (let j = 0; j + 1 < P; j++) {
        const a = r * P + j;
        const b = a + 1;
        const cc = a + P;
        const d = cc + 1;
        indices[o++] = a;
        indices[o++] = b;
        indices[o++] = cc;
        indices[o++] = b;
        indices[o++] = d;
        indices[o++] = cc;
      }
    }
    pieces.push({ center, radius: Math.fround(Math.sqrt(r2) * (1 + 1e-6)), rowLength: P, positions, normals, uvs, flow, foam: foamMask, levels: [{ error: 0, indices }] });
  }
  return pieces;
}

/** The copies of one `pieces` setting along a spline (10 floats each, m from the spline object). */
export function splinePieceCopies(c: SplineComponent, p: SplinePieceSettings): Float32Array {
  if (c.points.length < 2) return new Float32Array(0);
  const curve = SplineCurve.of(c, [0, 0, 0]);
  const start = p.start ?? 0;
  if (start > curve.length) return new Float32Array(0);
  const n = Math.floor((curve.length - start) / p.spacing + 1e-9) + 1;
  const out = new Float32Array(n * INSTANCE_FLOATS);
  const [ox, oy] = p.offset ?? [0, 0];
  const yaw = ((p.yaw ?? 0) * Math.PI) / 180;
  const upright = p.upright !== false;
  for (let k = 0; k < n; k++) {
    const f = curve.frameAt(start + k * p.spacing);
    // Its axes: +X along the curve, +Y up (upright: level along it, world up), +Z = X × Y.
    let xx = f.tx;
    let xy = f.ty;
    let xz = f.tz;
    let yx = f.ux;
    let yy = f.uy;
    let yz = f.uz;
    if (upright) {
      const l = Math.hypot(f.tx, f.tz) || 1;
      xx = f.tx / l;
      xy = 0;
      xz = f.tz / l;
      yx = 0;
      yy = 1;
      yz = 0;
    }
    const zx = xy * yz - xz * yy;
    const zy = xz * yx - xx * yz;
    const zz = xx * yy - xy * yx;
    let q = quatFromAxes(xx, xy, xz, yx, yy, yz, zx, zy, zz);
    if (yaw !== 0) q = mulQuat(q, [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    // Across and up: level and world up for an upright piece, the curve's own (rolled) frame otherwise.
    const up = upright ? [0, 1, 0] : [f.ux, f.uy, f.uz];
    const rl = Math.hypot(f.tx, f.tz) || 1;
    const rx = upright ? -f.tz / rl : f.rx;
    const ry = upright ? 0 : f.ry;
    const rz = upright ? f.tx / rl : f.rz;
    const o = k * INSTANCE_FLOATS;
    out[o] = f.x + rx * ox + up[0]! * oy;
    out[o + 1] = f.y + ry * ox + up[1]! * oy;
    out[o + 2] = f.z + rz * ox + up[2]! * oy;
    out[o + 3] = q[0];
    out[o + 4] = q[1];
    out[o + 5] = q[2];
    out[o + 6] = q[3];
    out[o + 7] = 1;
    out[o + 8] = 1;
    out[o + 9] = 1;
  }
  return out;
}

type Quat = [number, number, number, number];

/** The rotation whose columns are the axes (a rotation matrix to a quaternion). */
function quatFromAxes(m00: number, m10: number, m20: number, m01: number, m11: number, m21: number, m02: number, m12: number, m22: number): Quat {
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const l = Math.hypot(...q) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function mulQuat(a: Quat, b: Quat): Quat {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}

/** What a spline makes (the mesh's pieces at their finest; the host adds the coarser levels). */
export function makeSpline(c: SplineComponent): SplineMade {
  return { pieces: sweepSplineMesh(c), copies: (c.pieces ?? []).map((p, index) => ({ index, copies: splinePieceCopies(c, p) })) };
}

// ---- the blob ---------------------------------------------------------------------------------

/** The blob of what a spline made (uncompressed: floats and indices). */
export function encodeSplineMade(made: SplineMade): Uint8Array {
  let bytes = 8;
  for (const p of made.pieces) {
    const v = p.positions.length / 3;
    bytes += 4 * 4 + 4 + 4 + 4 + v * (3 + 3 + 2) * 4 + (p.flow !== null ? v * 3 * 4 : 0) + 4;
    for (const l of p.levels) bytes += 8 + l.indices.length * 4;
  }
  bytes += 4;
  for (const c of made.copies) bytes += 8 + c.copies.length * 4;
  const payload = new Uint8Array(bytes);
  const dv = new DataView(payload.buffer);
  let o = 0;
  const u32 = (v: number): void => {
    dv.setUint32(o, v, true);
    o += 4;
  };
  const f32 = (v: number): void => {
    dv.setFloat32(o, v, true);
    o += 4;
  };
  const floats = (a: Float32Array): void => {
    for (let i = 0; i < a.length; i++) f32(a[i]!);
  };
  u32(SPLINE_MADE_LAYOUT);
  u32(made.pieces.length);
  for (const p of made.pieces) {
    f32(p.center[0]);
    f32(p.center[1]);
    f32(p.center[2]);
    f32(p.radius);
    u32(p.flow !== null ? 1 : 0);
    u32(p.positions.length / 3);
    u32(p.rowLength);
    floats(p.positions);
    floats(p.normals);
    floats(p.uvs);
    if (p.flow !== null) {
      floats(p.flow);
      floats(p.foam!);
    }
    u32(p.levels.length);
    for (const l of p.levels) {
      f32(l.error);
      u32(l.indices.length);
      for (let i = 0; i < l.indices.length; i++) u32(l.indices[i]!);
    }
  }
  u32(made.copies.length);
  for (const c of made.copies) {
    u32(c.index);
    u32(c.copies.length / INSTANCE_FLOATS);
    floats(c.copies);
  }
  return wrapBinaryBlob(SPLINE_MADE_MAGIC, 'none', payload.length, payload);
}

/** What a spline's made blob holds (throws a short message when it is not one). */
export function decodeSplineMade(blob: Uint8Array): SplineMade {
  const h = readBinaryBlob(blob, SPLINE_MADE_MAGIC, 'spline');
  if (h.compression !== 'none') throw new Error('spline binary: stored uncompressed');
  if (h.stored.length !== h.rawLength) throw new Error(`spline binary: the header says ${h.rawLength} bytes, the blob holds ${h.stored.length}`);
  const bytes = h.stored;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number): void => {
    if (o + n > bytes.byteLength) throw new Error('spline binary: cut short');
  };
  const u32 = (): number => {
    need(4);
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  const f32 = (): number => {
    need(4);
    const v = dv.getFloat32(o, true);
    o += 4;
    return v;
  };
  const floats = (n: number): Float32Array => {
    need(n * 4);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(o + i * 4, true);
    o += n * 4;
    return out;
  };
  const layout = u32();
  if (layout !== SPLINE_MADE_LAYOUT) throw new Error(`spline binary: layout ${layout} is not one this engine reads`);
  const pieces: SplineMeshPiece[] = [];
  const pc = u32();
  for (let k = 0; k < pc; k++) {
    const center: [number, number, number] = [f32(), f32(), f32()];
    const radius = f32();
    const flags = u32();
    const v = u32();
    const rowLength = u32();
    const positions = floats(v * 3);
    const normals = floats(v * 3);
    const uvs = floats(v * 2);
    const flow = (flags & 1) !== 0 ? floats(v * 2) : null;
    const foam = (flags & 1) !== 0 ? floats(v) : null;
    const levels: SplineMeshLevel[] = [];
    const lc = u32();
    for (let l = 0; l < lc; l++) {
      const error = f32();
      const n = u32();
      need(n * 4);
      const indices = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const idx = dv.getUint32(o + i * 4, true);
        if (idx >= v) throw new Error('spline binary: an index past the vertices');
        indices[i] = idx;
      }
      o += n * 4;
      levels.push({ error, indices });
    }
    pieces.push({ center, radius, rowLength, positions, normals, uvs, flow, foam, levels });
  }
  const copies: SplineMade['copies'] = [];
  const cc = u32();
  for (let k = 0; k < cc; k++) {
    const index = u32();
    const n = u32();
    copies.push({ index, copies: floats(n * INSTANCE_FLOATS) });
  }
  return { pieces, copies };
}

/** Whether bytes are a spline's made blob (its first bytes suffice). */
export function isSplineMadeBlob(bytes: Uint8Array): boolean {
  return hasBinaryMagic(bytes, SPLINE_MADE_MAGIC);
}
