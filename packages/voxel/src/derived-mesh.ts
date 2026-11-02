/**
 * Mesh output buffers of a derived chunk (formats, DRAFT) and their
 * reference producers: a naive surface-nets pass for projected ground, cube
 * faces for modular bodies, and a detail-instance list for the features
 * the assembly evaluation resolved (beams, rails, posts). The producers are
 * there to fill and measure the formats; the real mesher and case pass
 * replace them, writing the same layouts.
 *
 * **Surface buffer** (one per surface kind): interleaved vertices whose
 * attributes are WebGPU/WebGL 2 vertex formats, then indices.
 * - position `uint16x4`: chunk-local, in 1/{@link POSITION_STEPS_PER_CELL}
 *   cell steps from one cell below the chunk's corner (so the surface's
 *   boundary vertices at −0.5 fit); w is 0, reserved;
 * - normal `snorm8x4` (w 0).
 * A vertex carries no material: the surface shader finds the materials
 * around each pixel in the chunk's shader data (derived-shader.ts) and
 * blends them there, so a material or wetness change never rebuilds a mesh
 * and blends look the same on every mesh detail level.
 * Indices are `uint16` below 65,536 vertices, else `uint32`; triangles are
 * counter-clockwise seen from outside.
 *
 * **Shared boundaries** (no cracks): a vertex's position is a function of
 * the samples around it only, quantised as an integer number of steps in
 * world cells, so two chunks that compute the same boundary vertex get the
 * same world position bit for bit. Each sample edge belongs to exactly one
 * chunk (the one holding its lower sample), so no triangle is emitted twice.
 *
 * **Detail instances**: 8 bytes each: x, y, z (chunk-local cell, uint8),
 * a byte of rotation (bits 0–1: quarter turns about +y) and flags (bits
 * 4–7, {@link INSTANCE_FLAG}), the piece (uint16: family << 2 | section)
 * and a reserved uint16 (0) that keeps the stride a multiple of four, as a
 * GPU instance buffer needs; the piece's material is its cell's, read from
 * the shader data like a surface's. A piece that replaces its cell's base
 * surface says so (`replacesBase`): the base surface is then not emitted
 * there, so an open rail is open, not a rail drawn over a solid block.
 */
import { ASSEMBLY_CLASS, CLASS_MASK, RUN_X, RUN_Z, type Neighbourhood } from './assembly';

/** Position steps per cell (1/1024 cell ≈ 0.5 mm). */
export const POSITION_STEPS_PER_CELL = 1024;

/** Density at or above which a projected sample is inside the ground. */
export const SURFACE_ISO = 128;

/** Bytes a surface vertex takes: position `uint16x4` and normal `snorm8x4`. */
export const SURFACE_VERTEX_BYTES = 12;

/** Bytes per detail instance. */
export const INSTANCE_BYTES = 8;

/** Instance flags (bits 4–7 of the rotation byte). */
export const INSTANCE_FLAG = Object.freeze({
  /** The piece replaces its cell's base surface (none is emitted under it). */
  replacesBase: 0x10,
});

/** Detail piece families (piece = family << 2 | section). */
export const PIECE_FAMILY = Object.freeze({ beam: 1, rail: 2, post: 3 });

/** Run sections: a merge-compatible piece is a body with ends, or a single. */
export const PIECE_SECTION = Object.freeze({ single: 0, start: 1, body: 2, end: 3 });

export interface SurfaceBuffer {
  readonly vertexCount: number;
  /** Interleaved vertices, {@link SURFACE_VERTEX_BYTES} each. */
  readonly vertices: Uint8Array;
  readonly indices: Uint16Array | Uint32Array;
}

export interface InstanceList {
  readonly count: number;
  /** {@link INSTANCE_BYTES} per instance. */
  readonly data: Uint8Array;
}

/** A growable byte buffer for vertices. */
class Bytes {
  buf = new Uint8Array(1024);
  view = new DataView(this.buf.buffer);
  length = 0;

  reserve(n: number): number {
    const at = this.length;
    if (at + n > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < at + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, at));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    this.length = at + n;
    return at;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** A surface under construction: vertices, then triangles. */
class SurfaceBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly tris: number[] = [];
  count = 0;

  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number): number {
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    return this.count++;
  }

  build(): SurfaceBuffer {
    const out = new Bytes();
    for (let v = 0; v < this.count; v++) {
      const at = out.reserve(SURFACE_VERTEX_BYTES);
      const d = out.view;
      d.setUint16(at, this.pos[3 * v]!, true);
      d.setUint16(at + 2, this.pos[3 * v + 1]!, true);
      d.setUint16(at + 4, this.pos[3 * v + 2]!, true);
      d.setUint16(at + 6, 0, true);
      d.setInt8(at + 8, this.nrm[3 * v]!);
      d.setInt8(at + 9, this.nrm[3 * v + 1]!);
      d.setInt8(at + 10, this.nrm[3 * v + 2]!);
      d.setInt8(at + 11, 0);
    }
    const indices = this.count < 65536 ? Uint16Array.from(this.tris) : Uint32Array.from(this.tris);
    return { vertexCount: this.count, vertices: out.done(), indices };
  }
}

/** Snorm8 of a unit-vector component. */
function snorm8(v: number): number {
  return Math.max(-127, Math.min(127, Math.round(v * 127)));
}

/** Corner offsets of a dual cube (x, y, z each 0 or 1), bit 0 = x, bit 1 = y, bit 2 = z. */
const CORNERS: Array<[number, number, number]> = [];
for (let c = 0; c < 8; c++) CORNERS.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);
/** The 12 edges of a cube as corner pairs. */
const EDGES: Array<[number, number]> = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if ((a & bit) === 0) EDGES.push([a, a | bit]);

/**
 * The projected surface (naive surface nets over ground density at cell
 * centres, iso {@link SURFACE_ISO}): one vertex per dual cube the surface
 * crosses, at the mean of its edge crossings; one quad per sign-changing
 * sample edge whose lower sample lies in the chunk. Needs classes and
 * shapes one cell around the chunk.
 */
export function groundSurface(n: Neighbourhood, classes: Uint8Array): SurfaceBuffer {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const b = new SurfaceBuilder();
  // Densities of the samples at local −1 … E, indexed (x·m + z)·m + y with m = E + 2 and local l at l + 1.
  const m = e + 2;
  const dens = new Uint8Array(m * m * m);
  let inside = 0;
  for (let x = 0; x < m; x++) for (let z = 0; z < m; z++) {
    const src = ((x - 1 + p) * s + (z - 1 + p)) * s + (p - 1);
    const dst = (x * m + z) * m;
    for (let y = 0; y < m; y++) {
      const i = src + y;
      const d = (classes[i]! & CLASS_MASK) === ASSEMBLY_CLASS.ground ? n.shapes[i]! : 0;
      dens[dst + y] = d;
      if (d >= SURFACE_ISO) inside++;
    }
  }
  // All outside or all inside: no sample edge changes sign.
  if (inside === 0 || inside === dens.length) return b.build();
  const di = (x: number, y: number, z: number): number => ((x + 1) * m + (z + 1)) * m + (y + 1);
  const dual = new Int32Array((e + 1) ** 3).fill(-1);
  const corner = new Float64Array(8);
  const vertexOf = (x: number, y: number, z: number): number => {
    const k = ((x + 1) * (e + 1) + (z + 1)) * (e + 1) + (y + 1);
    if (dual[k]! >= 0) return dual[k]!;
    for (let c = 0; c < 8; c++) {
      const [ox, oy, oz] = CORNERS[c]!;
      corner[c] = dens[di(x + ox, y + oy, z + oz)]!;
    }
    let fx = 0;
    let fy = 0;
    let fz = 0;
    let crossings = 0;
    for (const [a, c] of EDGES) {
      const da = corner[a]!;
      const dc = corner[c]!;
      if (da >= SURFACE_ISO === dc >= SURFACE_ISO) continue;
      const t = (SURFACE_ISO - 0.5 - da) / (dc - da);
      const [ax, ay, az] = CORNERS[a]!;
      const [cx, cy, cz] = CORNERS[c]!;
      fx += ax + (cx - ax) * t;
      fy += ay + (cy - ay) * t;
      fz += az + (cz - az) * t;
      crossings++;
    }
    fx /= crossings;
    fy /= crossings;
    fz /= crossings;
    // Density rises into the ground, so the outward normal is minus its gradient.
    let gx = 0;
    let gy = 0;
    let gz = 0;
    for (let c = 0; c < 8; c++) {
      const [ox, oy, oz] = CORNERS[c]!;
      gx += (ox === 1 ? 1 : -1) * corner[c]!;
      gy += (oy === 1 ? 1 : -1) * corner[c]!;
      gz += (oz === 1 ? 1 : -1) * corner[c]!;
    }
    const len = Math.hypot(gx, gy, gz) || 1;
    const steps = POSITION_STEPS_PER_CELL;
    const q = (cell: number, f: number): number => (cell + 1) * steps + steps / 2 + Math.round(f * steps);
    const v = b.vertex(q(x, fx), q(y, fy), q(z, fz), snorm8(-gx / len), snorm8(-gy / len), snorm8(-gz / len));
    dual[k] = v;
    return v;
  };
  const quad = (a: number, c: number, d: number, f: number, flip: boolean): void => {
    if (flip) b.tris.push(a, f, d, a, d, c);
    else b.tris.push(a, c, d, a, d, f);
  };
  const SX = m * m;
  const SZ = m;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
    const col = di(x, 0, z);
    for (let y = 0; y < e; y++) {
      const i = col + y;
      const inside = dens[i]! >= SURFACE_ISO;
      // Edge along +x: the quad joins the dual cubes at (x, y−1…y, z−1…z), ordered round +x (y, then z).
      if (inside !== dens[i + SX]! >= SURFACE_ISO) quad(vertexOf(x, y - 1, z - 1), vertexOf(x, y, z - 1), vertexOf(x, y, z), vertexOf(x, y - 1, z), !inside);
      // Along +y: round +y is z, then x.
      if (inside !== dens[i + 1]! >= SURFACE_ISO) quad(vertexOf(x - 1, y, z - 1), vertexOf(x - 1, y, z), vertexOf(x, y, z), vertexOf(x, y, z - 1), !inside);
      // Along +z: round +z is x, then y.
      if (inside !== dens[i + SZ]! >= SURFACE_ISO) quad(vertexOf(x - 1, y - 1, z), vertexOf(x, y - 1, z), vertexOf(x, y, z), vertexOf(x - 1, y, z), !inside);
    }
  }
  return b.build();
}

/** Whether a resolved cell hides a modular body's face (another body, or ground at least half full). */
function hidesFace(n: Neighbourhood, classes: Uint8Array, i: number): boolean {
  const k = classes[i]! & CLASS_MASK;
  return k === ASSEMBLY_CLASS.wall || (k === ASSEMBLY_CLASS.ground && n.shapes[i]! >= SURFACE_ISO);
}

/** Face directions: axis (0 x, 1 y, 2 z) and sign. */
const FACES: Array<[number, number]> = [[0, -1], [0, 1], [1, -1], [1, 1], [2, -1], [2, 1]];

/**
 * The modular base surface: a quad on every face of a wall-class cell
 * whose neighbour does not hide it. Beams and rails get none (their
 * detail pieces replace them), so faces of the walls behind them are kept.
 */
export function baseSurface(n: Neighbourhood, classes: Uint8Array): SurfaceBuffer {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const strides = [s * s, 1, s];
  const b = new SurfaceBuilder();
  const steps = POSITION_STEPS_PER_CELL;
  const corner = [0, 0, 0];
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    const i = ((x + p) * s + (z + p)) * s + (y + p);
    if ((classes[i]! & CLASS_MASK) !== ASSEMBLY_CLASS.wall) continue;
    for (const [axis, sign] of FACES) {
      if (hidesFace(n, classes, i + sign * strides[axis]!)) continue;
      // The face's plane and its two in-plane axes (u, v) with u × v pointing outward.
      const u = (axis + (sign > 0 ? 1 : 2)) % 3;
      const v = (axis + (sign > 0 ? 2 : 1)) % 3;
      const base = [x, y, z];
      const nrm = [0, 0, 0];
      nrm[axis] = sign * 127;
      const quad: number[] = [];
      for (const [du, dv] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
        corner[0] = base[0]!;
        corner[1] = base[1]!;
        corner[2] = base[2]!;
        if (sign > 0) corner[axis]! += 1;
        corner[u]! += du;
        corner[v]! += dv;
        quad.push(b.vertex((corner[0]! + 1) * steps, (corner[1]! + 1) * steps, (corner[2]! + 1) * steps, nrm[0]!, nrm[1]!, nrm[2]!));
      }
      b.tris.push(quad[0]!, quad[1]!, quad[2]!, quad[0]!, quad[2]!, quad[3]!);
    }
  }
  return b.build();
}

/**
 * Detail instances for the chunk's beams, rails and posts: one per cell,
 * with its run section from the neighbours along the run (same class), so
 * a renderer can merge a run of bodies between two ends.
 */
export function detailInstances(n: Neighbourhood, classes: Uint8Array): InstanceList {
  const e = n.edge;
  const p = n.pad;
  const s = n.side;
  const out = new Bytes();
  let count = 0;
  for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) for (let y = 0; y < e; y++) {
    const i = ((x + p) * s + (z + p)) * s + (y + p);
    const r = classes[i]!;
    const k = r & CLASS_MASK;
    if (k !== ASSEMBLY_CLASS.beam && k !== ASSEMBLY_CLASS.rail) continue;
    const runX = (r & RUN_X) !== 0;
    const runZ = (r & RUN_Z) !== 0;
    const post = runX && runZ;
    const family = k === ASSEMBLY_CLASS.beam ? PIECE_FAMILY.beam : post ? PIECE_FAMILY.post : PIECE_FAMILY.rail;
    let section: number = PIECE_SECTION.single;
    if (!post) {
      const step = runX ? s * s : s;
      const same = (j: number): boolean => classes[j] === r;
      const prev = same(i - step);
      const next = same(i + step);
      section = prev && next ? PIECE_SECTION.body : next ? PIECE_SECTION.start : prev ? PIECE_SECTION.end : PIECE_SECTION.single;
    }
    const at = out.reserve(INSTANCE_BYTES);
    const d = out.view;
    d.setUint8(at, x);
    d.setUint8(at + 1, y);
    d.setUint8(at + 2, z);
    d.setUint8(at + 3, (runZ && !post ? 1 : 0) | INSTANCE_FLAG.replacesBase);
    d.setUint16(at + 4, (family << 2) | section, true);
    d.setUint16(at + 6, 0, true);
    count++;
  }
  return { count, data: out.done() };
}
