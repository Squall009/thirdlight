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
 * A step added after projects were already written at 8 is `recorded`: it
 * runs on a 7 with the others, and on an 8 whose `project.json` `upgrades`
 * list does not name it yet; the loader adds its name to that list, so it
 * runs once whichever version the project was at.
 *
 * Steps:
 * - `linkPrefabCopies`: plain prefab copies become linked copies, their
 *   differences kept as overrides (`upgrade-linked-copies.ts`).
 * - `planes` (recorded): the project-wide physics dimension is retired; a 2D
 *   project's scenes get a default plane and its 2D colliders and
 *   controllers their 3D forms (`upgrade-planes.ts`).
 * - `light-counts` (recorded): the counts of local lights are retired: quality
 *   levels' `localLights`/`shadowedLights` and furnishing sets' `lights`
 *   (`upgrade-light-counts.ts`).
 */
import { linkPrefabCopies } from './upgrade-linked-copies';
import { retireLightCounts } from './upgrade-light-counts';
import { upgradeToPlanes } from './upgrade-planes';

export interface Schema8Step {
  /** The step's name (the order of the list is the order it runs in). */
  readonly name: string;
  /** Pure: the upgraded documents (unchanged ones may be the same objects), whether anything changed, and notes for Problems. */
  run(content: unknown, scenes: readonly unknown[]): { content: unknown; scenes: unknown[]; changed: boolean; notes: string[] };
  /** Added after 8 was written: recorded by its name in `project.json` `upgrades`, and run on an 8 that lacks it. */
  readonly recorded?: true;
}

/** The steps from 7 to 8, in order. */
export const SCHEMA_8_STEPS: readonly Schema8Step[] = [
  { name: 'linkPrefabCopies', run: linkPrefabCopies },
  { name: 'planes', run: upgradeToPlanes, recorded: true },
  { name: 'light-counts', run: retireLightCounts, recorded: true },
];

/** The recorded steps' names: what a project made or upgraded by this build has had (a new project needs none of them). */
export const RECORDED_SCHEMA_8_STEPS: readonly string[] = SCHEMA_8_STEPS.filter((s) => s.recorded === true).map((s) => s.name);

/** The recorded steps an 8 still needs (those its `upgrades` list does not name). */
export function pendingSchema8Steps(upgrades: readonly string[] | undefined): Schema8Step[] {
  return SCHEMA_8_STEPS.filter((s) => s.recorded === true && upgrades?.includes(s.name) !== true);
}

/** An `upgrades` list with every recorded step's name added (sorted, each once). */
export function withRecordedSteps(upgrades: readonly string[] | undefined): string[] {
  return [...new Set([...(upgrades ?? []), ...RECORDED_SCHEMA_8_STEPS])].sort();
}

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
