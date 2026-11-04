/**
 * A derived chunk's collision as plain geometry in metres from the chunk's
 * corner, for a physics engine: the boxes (full-cell merges and the partial
 * shapes of beams, rails and posts) as centre + half extents, and the
 * projected ground surface as heightfield patches wherever it is a height
 * function (ground-heightfield.ts) and triangle meshes for the rest, and
 * the roofs' planes as meshes (a roof collides as the ramp it is drawn as). A
 * heightfield costs a physics engine a height a lattice node where a mesh
 * costs vertices, indices and a tree over its triangles.
 *
 * A physics port may bound one mesh's size (vertices, triangles); the
 * ground is then cut into several meshes of whole triangles, each with only
 * the vertices it uses. Nothing here knows the physics engine.
 */
import { VOXEL_SIZE_M } from './coords';
import { COLLISION_STEPS_PER_CELL, type CollisionOut } from './derived-data';
import { POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, type SurfaceBuffer } from './derived-mesh';
import { groundHeightfieldPatches } from './ground-heightfield';

export interface CollisionMesh {
  /** x, y, z per vertex, metres from the chunk's corner. */
  readonly vertices: Float32Array;
  /** Three vertex indices a triangle, counter-clockwise seen from outside. */
  readonly indices: Uint32Array;
}

/**
 * The ground as a heightfield: `cellsX` × `cellsZ` cells of {@link VOXEL_SIZE_M}
 * from (x, z) metres from the chunk's corner, each cell split from its
 * (min x, min z) corner to its (+x, +z) corner.
 */
export interface CollisionHeightfield {
  readonly x: number;
  readonly z: number;
  readonly cellsX: number;
  readonly cellsZ: number;
  /** (cellsX + 1) · (cellsZ + 1) heights, metres from the chunk's corner, x-major: node (i, k) at i · (cellsZ + 1) + k. */
  readonly heights: Float32Array;
}

export interface CollisionGeometry {
  /** Per box: centre x, y, z then half extents x, y, z, metres from the chunk's corner. */
  readonly boxes: Float32Array;
  /** How many leading boxes are full-cell merges (the rest are partial shapes). */
  readonly fullBoxes: number;
  /** The ground where it is a heightfield, in patches (none: all of it is in {@link meshes}). */
  readonly heightfields: readonly CollisionHeightfield[];
  /** The ground's triangles no heightfield stands for (all of them without one), then the roofs' ramps. */
  readonly meshes: readonly CollisionMesh[];
  /** Bytes of the arrays above (what a physics engine is handed). */
  readonly bytes: number;
}

/** What a chunk's collision is made from: a derived chunk, or its sections joined (chunk-join.ts). */
export interface CollisionSource {
  /** The chunk's edge (cells). */
  readonly edge: number;
  readonly collision: CollisionOut;
  readonly ground: SurfaceBuffer;
}

/** Limits on one mesh (a port's); unbounded when absent. */
export interface CollisionMeshLimits {
  readonly maxVertices?: number;
  readonly maxTriangles?: number;
}

/** A surface's vertex positions in metres from the chunk's corner. */
function surfacePositions(buf: SurfaceBuffer): Float32Array {
  const stride = SURFACE_VERTEX_BYTES;
  const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
  const out = new Float32Array(buf.vertexCount * 3);
  const toM = VOXEL_SIZE_M / POSITION_STEPS_PER_CELL;
  for (let v = 0; v < buf.vertexCount; v++) {
    // Positions count from one cell below the chunk's corner.
    for (let a = 0; a < 3; a++) out[v * 3 + a] = view.getUint16(v * stride + a * 2, true) * toM - VOXEL_SIZE_M;
  }
  return out;
}

/** A surface's triangles (all, or those listed in `only`) as meshes of whole triangles within the limits. */
function surfaceMeshes(buf: SurfaceBuffer, limits: CollisionMeshLimits, only?: Uint32Array): CollisionMesh[] {
  const tris = only?.length ?? buf.indices.length / 3;
  if (buf.vertexCount === 0 || tris === 0) return [];
  const pos = surfacePositions(buf);
  const maxV = limits.maxVertices ?? Infinity;
  const maxT = limits.maxTriangles ?? Infinity;
  if (maxV < 3 || maxT < 1) throw new RangeError('collision mesh limits must allow one triangle');
  if (only === undefined && buf.vertexCount <= maxV && tris <= maxT) return [{ vertices: pos, indices: Uint32Array.from(buf.indices) }];
  const out: CollisionMesh[] = [];
  let remap = new Map<number, number>();
  let verts: number[] = [];
  let idx: number[] = [];
  const flush = (): void => {
    if (idx.length === 0) return;
    out.push({ vertices: Float32Array.from(verts), indices: Uint32Array.from(idx) });
    remap = new Map();
    verts = [];
    idx = [];
  };
  for (let j = 0; j < tris; j++) {
    const t = only === undefined ? j : only[j]!;
    let fresh = 0;
    for (let k = 0; k < 3; k++) if (!remap.has(buf.indices[t * 3 + k]!)) fresh++;
    if (idx.length / 3 + 1 > maxT || remap.size + fresh > maxV) flush();
    for (let k = 0; k < 3; k++) {
      const v = buf.indices[t * 3 + k]!;
      let m = remap.get(v);
      if (m === undefined) {
        m = remap.size;
        remap.set(v, m);
        verts.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
      }
      idx.push(m);
    }
  }
  flush();
  return out;
}

/**
 * Which ground collides as a heightfield: wherever it is one (`true`), level
 * patches only (`'level'`, to compare) or none (`false`: all ground as
 * meshes). Sloped heightfields are swept a cell at a time by the physics
 * port (physics-rapier sweep3d.ts), so they land where the mesh does.
 */
export type HeightfieldUse = boolean | 'level';

/**
 * A chunk's collision geometry (boxes, the ground's heightfield patches
 * where `heightfields` takes them, and ground meshes for the rest), in
 * metres from its corner.
 */
export function collisionGeometry(d: CollisionSource, limits: CollisionMeshLimits = {}, heightfields: HeightfieldUse = true): CollisionGeometry {
  const src = d.collision.boxes;
  const boxes = new Float32Array(src.length);
  const toM = VOXEL_SIZE_M / COLLISION_STEPS_PER_CELL;
  for (let b = 0; b * 6 < src.length; b++) {
    for (let a = 0; a < 3; a++) {
      const lo = src[b * 6 + a]! * toM;
      const hi = src[b * 6 + 3 + a]! * toM;
      boxes[b * 6 + a] = (lo + hi) / 2;
      boxes[b * 6 + 3 + a] = (hi - lo) / 2;
    }
  }
  const found = heightfields === false ? null : groundHeightfieldPatches(d.ground, d.edge, { levelOnly: heightfields === 'level' });
  const fields: CollisionHeightfield[] = (found?.patches ?? []).map((p) => ({ x: p.x0 * VOXEL_SIZE_M, z: p.z0 * VOXEL_SIZE_M, cellsX: p.cellsX, cellsZ: p.cellsZ, heights: p.heights }));
  const meshes = surfaceMeshes(d.ground, limits, fields.length === 0 ? undefined : found!.rest);
  meshes.push(...surfaceMeshes(d.collision.ramps, limits));
  let bytes = boxes.byteLength;
  for (const f of fields) bytes += f.heights.byteLength;
  for (const m of meshes) bytes += m.vertices.byteLength + m.indices.byteLength;
  return { boxes, fullBoxes: d.collision.fullBoxes, heightfields: fields, meshes, bytes };
}

/** A part of a chunk's static body, in the shape physics ports take (metres; the body sits at the chunk's corner). */
export interface CollisionBodyPart {
  readonly shape:
    | { readonly type: 'box'; readonly hx: number; readonly hy: number; readonly hz: number }
    | { readonly type: 'heightfield'; readonly cellsX: number; readonly cellsZ: number; readonly cellX: number; readonly cellZ: number; readonly heights: Float32Array }
    | { readonly type: 'mesh'; readonly vertices: Float32Array; readonly indices: Uint32Array; readonly oriented: true };
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
}

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
/** A quarter turn about +y: (x, z) → (z, −x). */
const QUARTER_Y = Object.freeze({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 });

/**
 * A chunk's collision geometry as the parts of one static compound body
 * (the editor's page and the runtime build the same body from it).
 *
 * Physics ports split a heightfield cell from (+x, min z) to (min x, +z)
 * (Rapier's own order), the voxel ground from (min x, min z) to (+x, +z):
 * the field is handed over turned a quarter about +y, which maps one
 * diagonal onto the other, with its heights turned to match. The ground
 * meshes are wound counter-clockwise from outside and nothing stands behind
 * them (`oriented`), so edges between their triangles never catch.
 */
export function collisionBodyParts(geo: CollisionGeometry): CollisionBodyPart[] {
  const parts: CollisionBodyPart[] = [];
  for (const h of geo.heightfields) {
    // The part's own x runs along the chunk's −z (from the field's +z end), its own z along the chunk's +x.
    const ownX = h.cellsZ;
    const ownZ = h.cellsX;
    const heights = new Float32Array((ownX + 1) * (ownZ + 1));
    for (let u = 0; u <= ownX; u++) for (let v = 0; v <= ownZ; v++) heights[u * (ownZ + 1) + v] = h.heights[v * (h.cellsZ + 1) + (h.cellsZ - u)]!;
    parts.push({ shape: { type: 'heightfield', cellsX: ownX, cellsZ: ownZ, cellX: VOXEL_SIZE_M, cellZ: VOXEL_SIZE_M, heights }, position: { x: h.x, y: 0, z: h.z + h.cellsZ * VOXEL_SIZE_M }, rotation: QUARTER_Y });
  }
  const b = geo.boxes;
  for (let i = 0; i < b.length; i += 6) parts.push({ shape: { type: 'box', hx: b[i + 3]!, hy: b[i + 4]!, hz: b[i + 5]! }, position: { x: b[i]!, y: b[i + 1]!, z: b[i + 2]! }, rotation: IDENTITY });
  for (const m of geo.meshes) parts.push({ shape: { type: 'mesh', vertices: m.vertices, indices: m.indices, oriented: true }, position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY });
  return parts;
}
