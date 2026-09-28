/**
 * Phase 25.7: `project.json` schemaVersion 4.
 *
 * The format bump of the scale limits. Version 4 is the format whose new
 * entity ids are written with at least six digits (`box-000001`,
 * `entity-ids.ts`); the documents themselves keep their shape, so a
 * schemaVersion 3 project is upgraded by the loader without changing a
 * document: its four-digit ids (`box-0001`) stay as they are (an id is any
 * string of the id syntax; references to it keep working), and the open
 * writes the project back as schemaVersion 4 (one new revision, as the
 * phase 24.8 upgrade does). A schemaVersion 2 project goes through
 * `upgradeProjectDocsV24` first, then this.
 */
import { PROJECT_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION_V24 } from './upgrade-v24';

export interface UpgradeV25Result {
  /** The upgraded documents (deep copies; the inputs are untouched). */
  content: unknown;
  scenes: unknown[];
  /** What the upgrade changed (for the upgrade notes). */
  notes: string[];
}

/** Upgrade a schemaVersion 3 project's raw content block and scene documents to schemaVersion 4. Pure. */
export function upgradeProjectDocsV25(contentIn: unknown, scenesIn: readonly unknown[]): UpgradeV25Result {
  const content = JSON.parse(JSON.stringify(contentIn ?? null)) as unknown;
  const scenes = scenesIn.map((s) => JSON.parse(JSON.stringify(s ?? null)) as unknown);
  return {
    content,
    scenes,
    notes: [`project schemaVersion ${PROJECT_SCHEMA_VERSION_V24} → ${PROJECT_SCHEMA_VERSION} (phase 25.7): new objects get six-digit ids (box-000001); the existing ids are kept`],
  };
}
