/**
 * A derived chunk's collision as plain geometry in metres from the chunk's
 * corner, for a physics engine: the boxes (full-cell merges and the partial
 * shapes of beams, rails and posts) as centre + half extents, and the
 * projected ground surface as triangle meshes.
 *
 * A physics port may bound one mesh's size (vertices, triangles); the
 * ground is then cut into several meshes of whole triangles, each with only
 * the vertices it uses. Nothing here knows the physics engine.
 */
import { VOXEL_SIZE_M } from './coords';
import { COLLISION_STEPS_PER_CELL, type DerivedData } from './derived-data';
import { POSITION_STEPS_PER_CELL, surfaceStride, type SurfaceBuffer } from './derived-mesh';

export interface CollisionMesh {
  /** x, y, z per vertex, metres from the chunk's corner. */
  readonly vertices: Float32Array;
  /** Three vertex indices a triangle, counter-clockwise seen from outside. */
  readonly indices: Uint32Array;
}

export interface CollisionGeometry {
  /** Per box: centre x, y, z then half extents x, y, z, metres from the chunk's corner. */
  readonly boxes: Float32Array;
  /** How many leading boxes are full-cell merges (the rest are partial shapes). */
  readonly fullBoxes: number;
  readonly meshes: readonly CollisionMesh[];
  /** Bytes of the arrays above (what a physics engine is handed). */
  readonly bytes: number;
}

/** Limits on one mesh (a port's); unbounded when absent. */
export interface CollisionMeshLimits {
  readonly maxVertices?: number;
  readonly maxTriangles?: number;
}

/** The ground surface's vertex positions in metres from the chunk's corner. */
function groundPositions(buf: SurfaceBuffer): Float32Array {
  const stride = surfaceStride(buf.slotBytes);
  const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
  const out = new Float32Array(buf.vertexCount * 3);
  const toM = VOXEL_SIZE_M / POSITION_STEPS_PER_CELL;
  for (let v = 0; v < buf.vertexCount; v++) {
    // Positions count from one cell below the chunk's corner.
    for (let a = 0; a < 3; a++) out[v * 3 + a] = view.getUint16(v * stride + a * 2, true) * toM - VOXEL_SIZE_M;
  }
  return out;
}

/** The ground surface as meshes of whole triangles within the limits. */
function groundMeshes(buf: SurfaceBuffer, limits: CollisionMeshLimits): CollisionMesh[] {
  const tris = buf.indices.length / 3;
  if (buf.vertexCount === 0 || tris === 0) return [];
  const pos = groundPositions(buf);
  const maxV = limits.maxVertices ?? Infinity;
  const maxT = limits.maxTriangles ?? Infinity;
  if (maxV < 3 || maxT < 1) throw new RangeError('collision mesh limits must allow one triangle');
  if (buf.vertexCount <= maxV && tris <= maxT) return [{ vertices: pos, indices: Uint32Array.from(buf.indices) }];
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
  for (let t = 0; t < tris; t++) {
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

/** A derived chunk's collision geometry (boxes and ground meshes), in metres from its corner. */
export function collisionGeometry(d: DerivedData, limits: CollisionMeshLimits = {}): CollisionGeometry {
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
  const meshes = groundMeshes(d.ground, limits);
  let bytes = boxes.byteLength;
  for (const m of meshes) bytes += m.vertices.byteLength + m.indices.byteLength;
  return { boxes, fullBoxes: d.collision.fullBoxes, meshes, bytes };
}
