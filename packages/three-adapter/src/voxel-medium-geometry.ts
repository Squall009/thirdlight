/**
 * A medium part's quads (the voxel derive's liquid or gas faces,
 * derived-medium.ts) as a geometry: four vertices a quad, positions in
 * metres from the chunk's corner, the face's outward normal, the quad's
 * material, two triangles a quad wound to face out. What the plain liquid
 * and the plain gas draws share.
 */
import * as THREE from 'three';
import { MEDIUM_FACE_NORMALS, MEDIUM_QUAD_BYTES, type MediumQuads } from '@thirdlight/voxel';

/** A second attribute a quad's spare byte gives its four vertices. */
export interface MediumQuadExtra {
  readonly name: string;
  readonly itemSize: number;
  /** Writes the byte's `itemSize` values at `out[at …]`. */
  write(extra: number, out: Float32Array, at: number): void;
}

/**
 * The quads' geometry (null: none): `metresPerStep` the metres of one
 * position step, `materialAttribute` the attribute holding each vertex's
 * material id.
 */
export function mediumQuadGeometry(part: MediumQuads | null | undefined, metresPerStep: number, materialAttribute: string, extra?: MediumQuadExtra): THREE.BufferGeometry | null {
  if (part == null || part.count === 0) return null;
  const n = part.count;
  const pos = new Float32Array(n * 12);
  const nor = new Float32Array(n * 12);
  const mat = new Float32Array(n * 4);
  const more = extra === undefined ? null : new Float32Array(n * 4 * extra.itemSize);
  const index = n * 4 < 65536 ? new Uint16Array(n * 6) : new Uint32Array(n * 6);
  const view = new DataView(part.quads.buffer, part.quads.byteOffset, n * MEDIUM_QUAD_BYTES);
  const m = metresPerStep;
  for (let k = 0; k < n; k++) {
    const o = k * MEDIUM_QUAD_BYTES;
    const lo = [view.getUint16(o, true) * m, view.getUint16(o + 2, true) * m, view.getUint16(o + 4, true) * m];
    const hi = [view.getUint16(o + 6, true) * m, view.getUint16(o + 8, true) * m, view.getUint16(o + 10, true) * m];
    const material = view.getUint16(o + 12, true);
    const face = view.getUint8(o + 14);
    const normal = MEDIUM_FACE_NORMALS[face]!;
    // The face's flat axis, and the two it spans (u, v) so that u × v points along the normal.
    const axis = face >> 1;
    const sign = normal[axis]!;
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const corners: Array<[number, number]> = sign > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
    corners.forEach(([cu, cv], c) => {
      const at = (k * 4 + c) * 3;
      pos[at + axis] = lo[axis]!;
      pos[at + u] = cu === 0 ? lo[u]! : hi[u]!;
      pos[at + v] = cv === 0 ? lo[v]! : hi[v]!;
      nor[at] = normal[0];
      nor[at + 1] = normal[1];
      nor[at + 2] = normal[2];
      mat[k * 4 + c] = material;
      if (more !== null) extra!.write(view.getUint8(o + 15), more, (k * 4 + c) * extra!.itemSize);
    });
    const b = k * 4;
    index.set([b, b + 1, b + 2, b, b + 2, b + 3], k * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute(materialAttribute, new THREE.BufferAttribute(mat, 1));
  if (more !== null) geo.setAttribute(extra!.name, new THREE.BufferAttribute(more, extra!.itemSize));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}

/** Bytes a geometry holds on the GPU (its attributes and index): what a chunk's draw counts for its meshes. */
export function geometryBytes(geo: THREE.BufferGeometry): number {
  let n = geo.index?.array.byteLength ?? 0;
  for (const a of Object.values(geo.attributes)) n += (a as THREE.BufferAttribute).array.byteLength;
  return n;
}
