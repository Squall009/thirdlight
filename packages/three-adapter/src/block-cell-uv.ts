/**
 * Cell-unit texture coordinates for materials made while block layers'
 * generated UVs counted cells.
 *
 * A stand-in chunk's UVs are metres from the layer origin (box mapping). They
 * used to be cells, and a height-blended layers material from that time
 * repeats its textures by a `tiling` per cell (`readsCellUv`). On a layer
 * whose cells are not 1 m such a material would repeat more or less often
 * than it did, so its chunk meshes take the same UVs divided back into cells:
 * u by the cell width (cells are square from above), v by the width on tops
 * and by the cell height on walls. Tops and walls are told apart by the
 * vertex normal's main axis, as the old mapping chose them.
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

/** Metre UVs divided back into cells: u by the cell width; v by the width on tops (normal mostly ±Y), else by the height. */
export function cellUnitUvs(metres: Float32Array, normals: Float32Array, cellSize: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(metres.length);
  const [w, h] = [cellSize[0], cellSize[1]];
  for (let i = 0; i < metres.length / 2; i++) {
    const nx = Math.abs(normals[i * 3]!);
    const ny = Math.abs(normals[i * 3 + 1]!);
    const nz = Math.abs(normals[i * 3 + 2]!);
    out[i * 2] = metres[i * 2]! / w;
    out[i * 2 + 1] = metres[i * 2 + 1]! / (ny >= nx && ny >= nz ? w : h);
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
  if (cells && kept.cells === null) kept.cells = cellUnitUvs(kept.metres, mesh.geometry.getAttribute('normal').array as Float32Array, kept.cellSize);
  const want = cells ? kept.cells! : kept.metres;
  if (uv.array === want) return;
  (uv as { array: Float32Array }).array = want;
  uv.needsUpdate = true;
}
