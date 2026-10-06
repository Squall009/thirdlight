/**
 * Cell-unit texture coordinates for materials made while block layers'
 * generated UVs counted cells.
 *
 * A stand-in chunk's UVs are metres from the layer origin (box mapping). They
 * used to be cells, and a height-blended layers material from that time
 * repeats its textures by a `tiling` per cell (`readsCellUv`). On a layer
 * whose cells are not 1 m such a material would repeat more or less often
 * than it did, so its chunk meshes take the same UVs divided back into cells:
 * u by the cell width (cells are square from above), v by the width under a
 * top (or bottom) projection and by the cell height under a wall's. Which
 * projection a triangle used is read from its UVs: a wall's v is −y exactly
 * (heights are neither wrapped nor scaled), a top's follows z. Not from the
 * vertex normal: a smoothed slope's normals lean either side of 45° while
 * its triangles keep one projection, and dividing by the wrong size
 * stretched them by the cell's width-to-height ratio.
 *
 * The metre UVs stay with the mesh: a material change in place (the project
 * switching to per-layer tilings) puts them back.
 */
import type * as THREE from 'three';

import { CELL_UV_KEY } from './material-graph';

/** `mesh.userData[METRE_UV_KEY]`: a stand-in chunk mesh's own (metre) UVs and its layer's cell size. */
const METRE_UV_KEY = '__tlMetreUv';

interface KeptUv {
  readonly metres: Float32Array;
  readonly cellSize: readonly [number, number, number];
  cells: Float32Array | null;
}

/**
 * Metre UVs divided back into cells: u by the cell width; v by the height
 * where all three corners of a triangle have v = −y (a wall's projection),
 * else by the width. A top's triangle passes that test only where its v
 * (z less the chunk's whole periods, or its negative) equals −y at all three
 * corners: a 45° slope lying exactly on that plane, which then counts as a
 * wall. `index` null: the triangles are the vertices in threes.
 */
export function cellUnitUvs(metres: Float32Array, positions: ArrayLike<number>, index: ArrayLike<number> | null, cellSize: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(metres.length);
  const [w, h] = [cellSize[0], cellSize[1]];
  const count = metres.length / 2;
  // Unreferenced vertices keep the top's divisor.
  for (let i = 0; i < count; i++) {
    out[i * 2] = metres[i * 2]! / w;
    out[i * 2 + 1] = metres[i * 2 + 1]! / w;
  }
  const corners = index === null ? count - (count % 3) : index.length;
  const wallV = (v: number): boolean => metres[v * 2 + 1] === -positions[v * 3 + 1]!;
  for (let i = 0; i + 2 < corners; i += 3) {
    const a = index === null ? i : index[i]!;
    const b = index === null ? i + 1 : index[i + 1]!;
    const c = index === null ? i + 2 : index[i + 2]!;
    if (!(wallV(a) && wallV(b) && wallV(c))) continue;
    // A vertex never joins triangles of two projections (the mesher splits it), so this only rewrites wall vertices.
    out[a * 2 + 1] = metres[a * 2 + 1]! / h;
    out[b * 2 + 1] = metres[b * 2 + 1]! / h;
    out[c * 2 + 1] = metres[c * 2 + 1]! / h;
  }
  return out;
}

/** Keep a stand-in chunk mesh's metre UVs (only where cells are not 1 m: there both units agree). */
export function keepMetreUv(mesh: THREE.Mesh, cellSize: readonly [number, number, number]): void {
  if (cellSize[0] === 1 && cellSize[1] === 1) return;
  const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (uv === undefined) return;
  const kept: KeptUv = { metres: uv.array as Float32Array, cellSize: [cellSize[0], cellSize[1], cellSize[2]], cells: null };
  mesh.userData[METRE_UV_KEY] = kept;
}

/** Give a kept chunk mesh the UVs its material reads: cells for a material that counts them, else metres. */
export function syncCellUv(mesh: THREE.Mesh): void {
  const kept = mesh.userData[METRE_UV_KEY] as KeptUv | undefined;
  if (kept === undefined) return;
  const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (uv === undefined) return;
  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const cells = list.some((m) => m.userData[CELL_UV_KEY] === true);
  if (cells && kept.cells === null) kept.cells = cellUnitUvs(kept.metres, mesh.geometry.getAttribute('position').array, mesh.geometry.getIndex()?.array ?? null, kept.cellSize);
  const want = cells ? kept.cells! : kept.metres;
  if (uv.array === want) return;
  (uv as { array: Float32Array }).array = want;
  uv.needsUpdate = true;
}
