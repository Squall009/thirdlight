/**
 * @thirdlight/project-model — public surface (dependencies.md §3;
 * project-model.md §12.1): types, parse*, validate*, normalize*, migrate*,
 * serializeCanonical, ERROR_CODES, KNOWN_VERSIONS.
 *
 * The project data model for M1 schemaVersion 1 (docs/contracts/
 * project-model.md): strict byte parsing with duplicate-key rejection,
 * total value validation, normalization to the §12.2 canonical form,
 * canonical byte serialization (the single canonical-bytes source),
 * migration entry points (M1: identity only), and the fixed M1 component
 * registry (transform / box / camera).
 *
 * Pure data and logic: no I/O, no three.js, no Node built-ins — the leaf
 * unit of the node-side graph (dependencies.md §4.1). All entry points are
 * pure and total: same input → same result; malformed data yields error
 * results, never thrown exceptions.
 */

export {
  ERROR_CODES,
  KNOWN_VERSIONS,
  type ErrorCode,
  type ModelError,
  type ModelResult,
  type SerializeResult,
} from './errors';

export type {
  BoxComponent,
  BoxMaterial,
  CameraComponent,
  Entity,
  EntityComponents,
  Manifest,
  Quat,
  Scene,
  SceneRef,
  TransformComponent,
  Vec3,
} from './types';

export { parseDocumentBytes, type ByteParse } from './parse-bytes';
export {
  parseManifest,
  parseScene,
} from './parse-api';

export {
  validateManifest,
  validateProject,
  validateScene,
  normalizeManifest,
  normalizeScene,
} from './validate';

export { serializeCanonical } from './normalize';

export { migrateManifest, migrateScene } from './migrate';