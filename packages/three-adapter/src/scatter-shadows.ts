/**
 * The foliage policy's cheap shadows for rule scatter (`scatter.ts`):
 *
 * - Blob shadows: a soft dark disc on the ground under each copy, drawn as
 *   one more instanced draw of the copies' own placements (a disc instead of
 *   the model), thinning out by distance — a contact shadow that needs no
 *   shadow map and moves with nothing.
 * - Near shadows: a rule that casts with a `shadowDistance` casts only from
 *   copies near the camera — squares of {@link SHADOW_RING_METRES} within the
 *   distance, built from the stored copies as shadow-only draws (the shadow
 *   cameras' layer, never the view's) into the moving shadow map — so the
 *   far copies, most of them, never enter a shadow pass and the cached static
 *   map never holds them.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { INSTANCE_FLOATS } from '@thirdlight/runtime';

import { CUTAWAY_LAYER } from './block-cutaway-view';
import type { N } from './effects-tsl';
import type { ModelInstance } from './visual';

const TSL: N = TSLTyped;

/** How dark a blob shadow is at its middle (0–1). */
export const BLOB_SHADOW_OPACITY = 0.45;
/** The side (m) of the squares a rule's near shadows are built in. */
export const SHADOW_RING_METRES = 64;
/** Metres a blob sits over the copy's base (its depth test then never loses to the ground it lies on). */
const BLOB_LIFT = 0.03;

let blob: { template: ModelInstance; material: THREE.Material; geometry: THREE.BufferGeometry } | null = null;

/** The blob's model: a unit disc lying flat, black, its alpha falling off toward the rim (one per page). */
export function blobShadowTemplate(): ModelInstance {
  if (blob !== null) return blob.template;
  const geometry = new THREE.CircleGeometry(1, 16);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;
  const fromMiddle = TSL.distance(TSL.uv(), TSL.vec2(0.5, 0.5)).mul(2);
  (material as unknown as { colorNode: unknown }).colorNode = TSL.vec3(0, 0, 0);
  (material as unknown as { opacityNode: unknown }).opacityNode = TSL.float(1).sub(TSL.smoothstep(0.3, 1, fromMiddle)).mul(BLOB_SHADOW_OPACITY);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'blob-shadow';
  const root = new THREE.Group();
  root.add(mesh);
  blob = { template: { glbRoot: root } as unknown as ModelInstance, material, geometry };
  return blob.template;
}

/** The blobs' placements: each copy's, its scale times `radius`, lifted a little off the ground. */
export function blobCopies(floats: Float32Array, count: number, radius: number): Float32Array {
  const out = floats.slice(0, count * INSTANCE_FLOATS);
  for (let i = 0; i < count; i++) {
    const o = i * INSTANCE_FLOATS;
    out[o + 1] = out[o + 1]! + BLOB_LIFT;
    out[o + 7] = out[o + 7]! * radius;
    out[o + 8] = out[o + 8]! * radius;
    out[o + 9] = out[o + 9]! * radius;
  }
  return out;
}

/** Make the meshes of a built set shadow-only: the shadow cameras draw them, the view never does. */
export function shadowOnly(meshes: readonly THREE.Mesh[]): void {
  for (const m of meshes) {
    m.layers.set(CUTAWAY_LAYER);
    m.castShadow = true;
    m.receiveShadow = false;
  }
}

/** The copies of `floats` whose ground point (the source's frame + `origin`) lies in each near-shadow square, by square key. */
export function copiesBySquare(floats: Float32Array, count: number, origin: readonly number[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const S = SHADOW_RING_METRES;
  for (let i = 0; i < count; i++) {
    const o = i * INSTANCE_FLOATS;
    const key = `${Math.floor((origin[0]! + floats[o]!) / S)},${Math.floor((origin[2]! + floats[o + 2]!) / S)}`;
    let list = out.get(key);
    if (list === undefined) out.set(key, (list = []));
    list.push(i);
  }
  return out;
}

/** The copies at `indices` as their own buffer. */
export function pickCopies(floats: Float32Array, indices: readonly number[]): Float32Array {
  const out = new Float32Array(indices.length * INSTANCE_FLOATS);
  indices.forEach((i, k) => out.set(floats.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS), k * INSTANCE_FLOATS));
  return out;
}

/** The distance (m, across the ground) from a point to a square. */
export function distanceToSquare(x: number, z: number, key: string): number {
  const [ix, iz] = key.split(',').map(Number) as [number, number];
  const S = SHADOW_RING_METRES;
  const dx = Math.max(ix * S - x, 0, x - (ix + 1) * S);
  const dz = Math.max(iz * S - z, 0, z - (iz + 1) * S);
  return Math.hypot(dx, dz);
}
