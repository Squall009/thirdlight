/**
 * Canonical (normalized) document types — project-model.md §7–§10: the
 * shared vector/transform/box/camera value types and the schemaVersion 1
 * manifest (the manifest of a storage-v3 project, read by the automatic
 * v3 → v4 upgrade). The M1 scene/entity types were removed in phase 9.3.
 * These describe the STRICT output of the normalizer
 * (§12.2): every defaulted optional field present, fixed key order,
 * `parentId` only when non-null, `name` only when present.
 *
 * Input values to the parse/validate/normalize entry points are `unknown` —
 * the boundary re-checks every rule (contract §12.1/§12.3); these types alone
 * do not make a value safe.
 */

/** Three finite numbers (meters), canonical order per §10. */
export type Vec3 = [number, number, number];

/** Quaternion [x, y, z, w] (three.js order, §10.1), finite. */
export type Quat = [number, number, number, number];

/** `transform` component (§10.1). Local frame; roots are in the world frame. */
export interface TransformComponent {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** `box.material` (§10.2). M1 carries only `color`. */
export interface BoxMaterial {
  color: string;
}

/** `box` component (§10.2) — procedural unit box scaled by `size`. */
export interface BoxComponent {
  size: Vec3;
  material: BoxMaterial;
}

/** `camera` component (§10.3) — perspective; `aspect` is never persisted. */
export interface CameraComponent {
  type: 'perspective';
  fovY: number;
  near: number;
  far: number;
}

/** Manifest scene reference (§7.1). M1: `path` is exactly `"scenes/main.json"`. */
export interface SceneRef {
  id: string;
  path: string;
}

/**
 * Project manifest (§7). Immutable during M1 editing. Canonical field order:
 * `schemaVersion`, `engineVersion`, `id`, `name`, `createdAt`, `scenes`.
 */
export interface Manifest {
  schemaVersion: 1;
  engineVersion: string;
  id: string;
  name: string;
  createdAt: string;
  scenes: [SceneRef];
}