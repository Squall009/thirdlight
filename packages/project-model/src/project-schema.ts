/**
 * The `project.json` schemaVersion: which formats this build writes, upgrades
 * and refuses.
 *
 * 7 is written (the engine owns the view; scenes hold shots and objects carry
 * a keep-loaded flag). A 6 is upgraded on open (`upgrade-scene-model.ts`).
 * Older formats (2 to 5) are refused, not upgraded: every template and game
 * was at 7 when their upgraders were dropped, and carrying four upgrade chains
 * made every format change touch code no project used. Such a project opens
 * once in the last engine that upgraded it, then here.
 */

/** The `project.json` schemaVersion this build writes. */
export const PROJECT_SCHEMA_VERSION = 7;
/** The format with a scene `camera` entity, upgraded to 7 on open (`upgradeSceneModel`); the oldest this build opens. */
export const PROJECT_SCHEMA_VERSION_SCENE_CAMERA = 6;

/**
 * The last engine that upgrades a project older than schemaVersion 6 (its git
 * tag and commit): open the project there once, it writes the project back as
 * 7, then this build opens it.
 */
export const LAST_ENGINE_UPGRADING_OLD_PROJECTS = 'git tag upgrades-project-schema-2-to-5 (commit f3d40136)';

/** Whether the loader upgrades a project of this `project.json` schemaVersion (6 to 7). */
export function isUpgradedProjectSchemaVersion(v: unknown): v is 6 {
  return v === PROJECT_SCHEMA_VERSION_SCENE_CAMERA;
}

/**
 * Whether this is a project format older than the oldest this build opens
 * (schemaVersion 2 to 5; a 1 is a storage-v3 manifest, read by its own path).
 */
export function isRefusedProjectSchemaVersion(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 2 && v < PROJECT_SCHEMA_VERSION_SCENE_CAMERA;
}

/**
 * The refusal text for a project format older than the oldest this build
 * opens; the engine that upgrades it comes first (the project list shortens
 * the text).
 */
export function refusedProjectSchemaMessage(v: number): string {
  return `schemaVersion ${v} is too old: open the project once with Thirdlight ${LAST_ENGINE_UPGRADING_OLD_PROJECTS}, which writes it back as ${PROJECT_SCHEMA_VERSION}, then open it here (this engine opens ${PROJECT_SCHEMA_VERSION_SCENE_CAMERA} and ${PROJECT_SCHEMA_VERSION}; the files were left untouched)`;
}
