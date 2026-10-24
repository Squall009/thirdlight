/**
 * The `project.json` schemaVersion: which formats this build writes, upgrades
 * and refuses.
 *
 * 8 is written (prefab copies are linked: a copy is one object naming its
 * prefab and the overrides it keeps). A 7 is upgraded on open
 * (`upgrade-schema-8.ts`, a list of named steps that later changes of the
 * same version extend), and a 6 first to 7 (`upgrade-scene-model.ts`) and
 * then to 8. Older formats (2 to 5) are refused, not upgraded: every template
 * and game was at 7 when their upgraders were dropped, and carrying four
 * upgrade chains made every format change touch code no project used. Such a
 * project opens once in the last engine that upgraded it, then here.
 */

/** The `project.json` schemaVersion this build writes. */
export const PROJECT_SCHEMA_VERSION = 8;
/** The format with plain prefab copies, upgraded to 8 on open (`upgradeToSchema8`). */
export const PROJECT_SCHEMA_VERSION_PLAIN_PREFAB_COPIES = 7;
/** The format with a scene `camera` entity, upgraded to 7 on open (`upgradeSceneModel`) and then to 8; the oldest this build opens. */
export const PROJECT_SCHEMA_VERSION_SCENE_CAMERA = 6;

/**
 * The last engine that upgrades a project older than schemaVersion 6 (its git
 * tag and commit): open the project there once, it writes the project back as
 * 7, then this build opens it (and upgrades it to 8).
 */
export const LAST_ENGINE_UPGRADING_OLD_PROJECTS = 'git tag upgrades-project-schema-2-to-5 (commit f3d40136)';

/** Whether the loader upgrades a project of this `project.json` schemaVersion (6 or 7, to 8). */
export function isUpgradedProjectSchemaVersion(v: unknown): v is 6 | 7 {
  return v === PROJECT_SCHEMA_VERSION_SCENE_CAMERA || v === PROJECT_SCHEMA_VERSION_PLAIN_PREFAB_COPIES;
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
  return `schemaVersion ${v} is too old: open the project once with Thirdlight ${LAST_ENGINE_UPGRADING_OLD_PROJECTS}, which writes it back as ${PROJECT_SCHEMA_VERSION_PLAIN_PREFAB_COPIES}, then open it here (this engine opens ${PROJECT_SCHEMA_VERSION_SCENE_CAMERA} to ${PROJECT_SCHEMA_VERSION}; the files were left untouched)`;
}
