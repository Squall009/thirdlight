/**
 * Transform synchronization — runtime.md §6 (the adapter copies the
 * runtime's interpolated values into Object3Ds and performs no other
 * transform math).
 *
 * Pure mapping helper: writes only to the target Object3D; the input
 * tuples are read, never mutated. Kept as an internal module (not part
 * of the public surface row) so the mapping is unit-testable without a
 * WebGL context (packet 08 test note; recorded in docs/handoffs/08.md).
 */
import type { Object3D } from 'three';

/** Three-adapter-local tuple types (structural; the adapter must not
 *  import @thirdlight/project-model — dependencies.md §4.1 edge table). */
export type AdapterVec3 = readonly [number, number, number];
/** Quaternion in three.js order [x, y, z, w] (project-model §10.1). */
export type AdapterQuat = readonly [number, number, number, number];

/**
 * Copy one interpolated transform into an Object3D (local frame):
 * position, quaternion, scale. The parent chain composes world
 * transforms via three.js; no other transform math is done here (§6:
 * the three-adapter copies these values into Object3Ds).
 */
export function applyTransformToObject3D(
  obj: Object3D,
  position: AdapterVec3,
  rotation: AdapterQuat,
  scale: AdapterVec3,
): void {
  obj.position.set(position[0], position[1], position[2]);
  obj.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
  obj.scale.set(scale[0], scale[1], scale[2]);
}