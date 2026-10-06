/**
 * Canonical (normalized) document types: the shared vector/transform/box/
 * camera value types and the schemaVersion 1 manifest (the manifest of a
 * storage-v3 project, read by the automatic v3 → v4 upgrade). These
 * describe the STRICT output of the normalizer: every defaulted optional
 * field present, fixed key order, `parentId` only when non-null, `name`
 * only when present.
 *
 * Input values to the parse/validate/normalize entry points are `unknown` —
 * the boundary re-checks every rule; these types alone do not make a value
 * safe.
 */
import type { LocalLightMode } from './local-lights';

/** Three finite numbers (meters), in canonical order. */
export type Vec3 = [number, number, number];

/** Quaternion [x, y, z, w] (three.js order), finite. */
export type Quat = [number, number, number, number];

/** `transform` component. Local frame; roots are in the world frame. */
export interface TransformComponent {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** `box.material`: only `color`. */
export interface BoxMaterial {
  color: string;
}

/** `box` component — procedural unit box scaled by `size`. */
export interface BoxComponent {
  size: Vec3;
  material: BoxMaterial;
  /** Casts the directional light's realtime shadow (absent: true). */
  castShadow?: boolean;
  /** Shows realtime shadows falling on it (absent: true). */
  receiveShadow?: boolean;
  /** The light layers it is in, a bit mask (light-layers.ts; absent: every layer). */
  lightLayers?: number;
  /** How local lights reach it (local-lights.ts; absent: its material's mode, else per pixel). */
  localLights?: LocalLightMode;
}

/** `camera` component — perspective; `aspect` is never persisted. */
export interface CameraComponent {
  type: 'perspective';
  fovY: number;
  near: number;
  far: number;
}

/** Manifest scene reference. `path` is exactly `"scenes/main.json"`. */
export interface SceneRef {
  id: string;
  path: string;
}

/**
 * Project manifest (schemaVersion 1). Canonical field order:
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