/**
 * `project.json` schemaVersion 8: the upgrade of a 7 (and of a 6, after its
 * own upgrade to 7) on open.
 *
 * One version, several changes: each change that needs the bump is a named
 * step here, run in order on the raw documents before they are validated,
 * so a project upgrades once whichever changes it needs. A later change that
 * shares the version adds its step to `SCHEMA_8_STEPS`; a step must keep the
 * project's look and behaviour (or say in a note what it could not keep) and
 * must leave a project that does not use what it changes untouched.
 *
 * Steps:
 * - `linkPrefabCopies`: plain prefab copies become linked copies, their
 *   differences kept as overrides (`upgrade-linked-copies.ts`).
 */
import { linkPrefabCopies } from './upgrade-linked-copies';

export interface Schema8Step {
  /** The step's name (the order of the list is the order it runs in). */
  readonly name: string;
  /** Pure: the upgraded documents (unchanged ones may be the same objects), whether anything changed, and notes for Problems. */
  run(content: unknown, scenes: readonly unknown[]): { content: unknown; scenes: unknown[]; changed: boolean; notes: string[] };
}

/** The steps from 7 to 8, in order. */
export const SCHEMA_8_STEPS: readonly Schema8Step[] = [{ name: 'linkPrefabCopies', run: linkPrefabCopies }];

export interface UpgradeToSchema8Result {
  content: unknown;
  scenes: unknown[];
  /** Whether any document changed (false: only the version number moves). */
  changed: boolean;
  notes: string[];
  /** The steps that changed something. */
  applied: string[];
}

/** Upgrade a schemaVersion 7 project's documents to 8 (every step in order). Pure. */
export function upgradeToSchema8(contentIn: unknown, scenesIn: readonly unknown[], steps: readonly Schema8Step[] = SCHEMA_8_STEPS): UpgradeToSchema8Result {
  let content = contentIn;
  let scenes = [...scenesIn];
  const notes: string[] = [];
  const applied: string[] = [];
  for (const step of steps) {
    const r = step.run(content, scenes);
    notes.push(...r.notes);
    if (!r.changed) continue;
    content = r.content;
    scenes = r.scenes;
    applied.push(step.name);
  }
  return { content, scenes, changed: applied.length > 0, notes, applied };
}
