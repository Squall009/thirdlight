/**
 * Ground cover on meshes: the faces of a placed model and the floors of
 * generated architecture as a {@link ScatterSurface}, so their cover rules
 * are baked into point sets (`cover-points.ts`) by the same code as a block
 * layer's, and drawn by the same GPU renderer.
 *
 * A mesh is a triangle list in its source's frame (world metres less the
 * source's origin; 9 floats a triangle). Only faces that look up can hold
 * cover: the ground at a point is the highest such face over it, and the
 * floors under it (a model's interior floor under its roof, an upper
 * storey's floor over a lower one) are the next faces down. Faces are sorted
 * into a grid of square cells once, so a bake reads a handful per point.
 *
 * The bake's squares (chunks) are {@link MESH_COVER_CHUNK_METRES} a side in
 * the source's frame: only those a face reaches are baked and drawn.
 *
 * Pure.
 */
import { SCATTER_MIN_NORMAL_Y, validateScatterRules, type ScatterGround, type ScatterRect, type ScatterSurface } from './scatter';
import type { ModelErrorV2 } from './errors';

/** Metres a side of the squares a mesh's cover points are baked, held and culled in. */
export const MESH_COVER_CHUNK_METRES = 16;
/** The most cells a side of a mesh's face grid takes (its cells grow with the mesh beyond that). */
const GRID_CELLS_MAX = 256;
/** Metres a floor lies under the ground above it before it is a floor of its own (a face's own edge is not). */
const FLOOR_GAP = 1e-3;

/**
 * Validate the cover rules of a model or architecture (`scatter`): the
 * scatter rule format, and every rule ground cover (`cover: true`) — a mesh
 * has no stored scatter.
 */
export function validateMeshCoverRules(value: unknown, path: string, errors: ModelErrorV2[]): void {
  validateScatterRules(value, path, errors, false);
  if (!Array.isArray(value)) return;
  value.forEach((r, i) => {
    if (typeof r === 'object' && r !== null && (r as { cover?: unknown }).cover !== true) errors.push({ code: 'field_value', path: `${path}/${i}/cover`, message: 'a rule on a model or architecture is ground cover: cover is true', found: (r as { cover?: unknown }).cover ?? null } as ModelErrorV2);
  });
}

/** The squares (keys "cx,cz", source frame) a triangle list's upward faces reach. */
export function meshCoverChunks(tris: Float32Array, chunk = MESH_COVER_CHUNK_METRES): Set<string> {
  const out = new Set<string>();
  for (let t = 0; t + 9 <= tris.length; t += 9) {
    if (faceNormalY(tris, t) <= SCATTER_MIN_NORMAL_Y) continue;
    const x0 = Math.min(tris[t]!, tris[t + 3]!, tris[t + 6]!);
    const x1 = Math.max(tris[t]!, tris[t + 3]!, tris[t + 6]!);
    const z0 = Math.min(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!);
    const z1 = Math.max(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!);
    for (let cz = Math.floor(z0 / chunk); cz <= Math.floor(z1 / chunk); cz++) for (let cx = Math.floor(x0 / chunk); cx <= Math.floor(x1 / chunk); cx++) out.add(`${cx},${cz}`);
  }
  return out;
}

/** Square (cx, cz) of a mesh source at world `origin` as a world XZ box. */
export function meshCoverChunkRect(origin: readonly number[], cx: number, cz: number, chunk = MESH_COVER_CHUNK_METRES): ScatterRect {
  const ox = origin[0] ?? 0;
  const oz = origin[2] ?? 0;
  return [ox + cx * chunk, oz + cz * chunk, ox + (cx + 1) * chunk, oz + (cz + 1) * chunk];
}

/** The unit normal's up part of triangle `t` (as wound: counter-clockwise seen from its front). */
function faceNormalY(tris: Float32Array, t: number): number {
  const ax = tris[t + 3]! - tris[t]!;
  const ay = tris[t + 4]! - tris[t + 1]!;
  const az = tris[t + 5]! - tris[t + 2]!;
  const bx = tris[t + 6]! - tris[t]!;
  const by = tris[t + 7]! - tris[t + 1]!;
  const bz = tris[t + 8]! - tris[t + 2]!;
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  return len > 0 ? ny / len : 0;
}

/**
 * A triangle list (source frame, 9 floats a triangle, wound
 * counter-clockwise seen from the front) at world `origin` as scatter reads
 * it: the ground is its upward faces; it has no material layers, block
 * types or regions.
 */
export function meshScatterSurface(tris: Float32Array, origin: readonly number[]): ScatterSurface {
  const ox = origin[0] ?? 0;
  const oy = origin[1] ?? 0;
  const oz = origin[2] ?? 0;
  // The upward faces and their normals.
  const up: number[] = [];
  const normals: number[] = [];
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let t = 0; t + 9 <= tris.length; t += 9) {
    const ny = faceNormalY(tris, t);
    if (ny <= SCATTER_MIN_NORMAL_Y) continue;
    const ax = tris[t + 3]! - tris[t]!;
    const ay = tris[t + 4]! - tris[t + 1]!;
    const az = tris[t + 5]! - tris[t + 2]!;
    const bx = tris[t + 6]! - tris[t]!;
    const by = tris[t + 7]! - tris[t + 1]!;
    const bz = tris[t + 8]! - tris[t + 2]!;
    const nx = ay * bz - az * by;
    const nz = ax * by - ay * bx;
    const len = Math.hypot(nx, az * bx - ax * bz, nz);
    up.push(t);
    normals.push(nx / len, ny, nz / len);
    for (const k of [0, 3, 6]) {
      x0 = Math.min(x0, tris[t + k]!);
      x1 = Math.max(x1, tris[t + k]!);
      z0 = Math.min(z0, tris[t + k + 2]!);
      z1 = Math.max(z1, tris[t + k + 2]!);
    }
  }
  // The faces by grid cell (source frame).
  const cell = up.length === 0 ? 1 : Math.max(1, (x1 - x0) / GRID_CELLS_MAX, (z1 - z0) / GRID_CELLS_MAX);
  const cells = new Map<string, number[]>();
  up.forEach((t, i) => {
    const fx0 = Math.floor(Math.min(tris[t]!, tris[t + 3]!, tris[t + 6]!) / cell);
    const fx1 = Math.floor(Math.max(tris[t]!, tris[t + 3]!, tris[t + 6]!) / cell);
    const fz0 = Math.floor(Math.min(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!) / cell);
    const fz1 = Math.floor(Math.max(tris[t + 2]!, tris[t + 5]!, tris[t + 8]!) / cell);
    for (let cz = fz0; cz <= fz1; cz++) {
      for (let cx = fx0; cx <= fx1; cx++) {
        const key = `${cx},${cz}`;
        const list = cells.get(key);
        if (list === undefined) cells.set(key, [i]);
        else list.push(i);
      }
    }
  });
  /** The highest upward face over source point (lx, lz) below source height `below`: its height and index, or null. */
  const hit = (lx: number, lz: number, below: number): { y: number; i: number } | null => {
    let best: { y: number; i: number } | null = null;
    for (const i of cells.get(`${Math.floor(lx / cell)},${Math.floor(lz / cell)}`) ?? []) {
      const t = up[i]!;
      const ax = tris[t]!;
      const az = tris[t + 2]!;
      const e1x = tris[t + 3]! - ax;
      const e1z = tris[t + 5]! - az;
      const e2x = tris[t + 6]! - ax;
      const e2z = tris[t + 8]! - az;
      const det = e1x * e2z - e2x * e1z;
      if (Math.abs(det) < 1e-12) continue;
      const px = lx - ax;
      const pz = lz - az;
      const u = (px * e2z - e2x * pz) / det;
      const v = (e1x * pz - px * e1z) / det;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const y = tris[t + 1]! + u * (tris[t + 4]! - tris[t + 1]!) + v * (tris[t + 7]! - tris[t + 1]!);
      if (y < below && (best === null || y > best.y)) best = { y, i };
    }
    return best;
  };
  const g: ScatterGround = {
    x: 0,
    y: 0,
    z: 0,
    slope: 0,
    wall: false,
    nx: 0,
    ny: 1,
    nz: 0,
    cavity(radius: number): number {
      // The mean of the ground `radius` round (within twice the radius above), less the point's.
      let sum = 0;
      let n = 0;
      for (const [dx, dz] of [[-radius, 0], [radius, 0], [0, -radius], [0, radius]] as const) {
        const h = hit(g.x - ox + dx, g.z - oz + dz, g.y - oy + 2 * radius);
        if (h === null) continue;
        sum += h.y + oy;
        n += 1;
      }
      return n === 0 ? 0 : sum / n - g.y;
    },
    layer: () => 0,
  };
  const ground = (x: number, z: number, h: { y: number; i: number } | null): ScatterGround | null => {
    if (h === null) return null;
    g.x = x;
    g.y = h.y + oy;
    g.z = z;
    g.nx = normals[h.i * 3]!;
    g.ny = normals[h.i * 3 + 1]!;
    g.nz = normals[h.i * 3 + 2]!;
    g.slope = (Math.acos(Math.min(1, g.ny)) * 180) / Math.PI;
    return g;
  };
  return {
    at: (x, z) => ground(x, z, hit(x - ox, z - oz, Infinity)),
    under: (x, z, y) => ground(x, z, hit(x - ox, z - oz, y - oy - FLOOR_GAP)),
  };
}
