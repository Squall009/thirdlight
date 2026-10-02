/**
 * The engine state a project save's sections capture and restore (the
 * `SaveSectionsPort` the runtime's saves use): block-layer cells, material
 * values, `ctx.save` storage, spawned copies, dialogue, the environment
 * blend and the objects' components, plus where the play stands (`world`).
 *
 * The runtime hands over the parts that own each section; this module only
 * routes a section to its owner and checks the shapes the runtime keeps
 * itself (the storage keys, the counters).
 */
import { COUNTER_NAME_RULE, SCRIPT_SAVE_LIMITS } from '@thirdlight/project-model';

import type { GameplayBlocks } from './blocks';
import type { DialogueRunner } from './dialogue';
import type { EntityAccess, EntityFieldsSave } from './entity-access';
import type { EnvironmentDirector, EnvironmentSaveState } from './environment-director';
import type { RuntimeGrid } from './grid';
import type { MaterialSaveEntry, RuntimeMaterials } from './material-params';
import type { PrimitivesSaveState } from './primitives';
import type { SaveSectionsPort, WorldSave } from './project-saves';

/** One spawned copy as a save document's `spawned` section keeps it. */
export interface SavedSpawnCopy {
  prefabId: string;
  ids: string[];
  position: number[];
  rotation: number[];
  scale: number[];
  /** The property values the copy's root script was spawned with (absent: the prefab's). */
  properties?: Record<string, unknown>;
}

/** `ctx.save` rules (shared by the start's injected script variables). */
export const SAVE_MAX_KEYS = SCRIPT_SAVE_LIMITS.keys;
export const SAVE_MAX_VALUE_CHARS = SCRIPT_SAVE_LIMITS.valueChars;
export const SAVE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A value's JSON text when it fits a save value, else null. */
export function saveValueText(value: unknown): string | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  return text === undefined || text.length > SAVE_MAX_VALUE_CHARS ? null : text;
}

/** The runtime's parts that own the sections. */
export interface SaveSectionOwners {
  readonly grid: RuntimeGrid;
  readonly materials: RuntimeMaterials;
  readonly saveStore: Map<string, unknown>;
  readonly dialogue: DialogueRunner;
  readonly environment: EnvironmentDirector;
  /** Whether a scene is loaded now (a saved active scene comes back only then). */
  sceneLoaded(sceneId: string): boolean;
  readonly entityAccess: EntityAccess;
  /** The gameplay blocks now (null without them). */
  blocks(): GameplayBlocks | null;
  spawnedCopies(): SavedSpawnCopy[];
  spawnedCopiesProblem(value: unknown): string | null;
  restoreSpawnedCopies(copies: readonly SavedSpawnCopy[]): void;
  captureWorld(): WorldSave;
  worldProblem(world: WorldSave): string | null;
  applyWorld(world: WorldSave): void;
}

export function saveSectionsPort(o: SaveSectionOwners): SaveSectionsPort {
  return {
    capture(section) {
      switch (section) {
        case 'grid':
          return o.grid.api.diff();
        case 'materials':
          return o.materials.saveState();
        case 'storage':
          return Object.fromEntries([...o.saveStore.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        case 'spawned':
          return o.spawnedCopies();
        case 'dialogue':
          return o.dialogue.saveState();
        case 'environment':
          return o.environment.saveState();
        case 'components': {
          const blocks = o.blocks();
          // The named counters travel with the objects' state (a collectible's total with it being collected).
          const state = blocks?.primitives.saveState() ?? {};
          const counters = blocks?.countersView() ?? {};
          // The fields scripts wrote (ctx.entity(id).set), only when there are any.
          const fields = o.entityAccess.saveState();
          return { ...state, ...(Object.keys(counters).length > 0 ? { counters } : {}), ...(Object.keys(fields).length > 0 ? { fields } : {}) };
        }
      }
    },
    check(section, value) {
      switch (section) {
        case 'grid':
          return null;
        case 'materials':
          return o.materials.checkState(value);
        case 'storage': {
          if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length > SAVE_MAX_KEYS) return `the storage section maps at most ${SAVE_MAX_KEYS} keys to values`;
          for (const [k, v] of Object.entries(value)) if (!SAVE_KEY_RE.test(k) || saveValueText(v) === null) return `storage key "${k.slice(0, 64)}" does not fit ctx.save's rules`;
          return null;
        }
        case 'spawned':
          return o.spawnedCopiesProblem(value);
        case 'dialogue':
          return o.dialogue.checkState(value);
        case 'environment':
          return o.environment.checkState(value);
        case 'components': {
          if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'fields' in value) {
            const { fields, ...others } = value as Record<string, unknown>;
            const problem = o.entityAccess.checkState(fields);
            if (problem !== null) return problem;
            value = others;
          }
          if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'counters' in value) {
            const { counters, ...rest } = value as Record<string, unknown>;
            // Only the shape refuses the section: a name the counter rule refuses is skipped at restore
            // (with a log line), so one bad name never costs the whole load.
            if (typeof counters !== 'object' || counters === null || Array.isArray(counters)) return 'the components section\'s counters map names to numbers';
            return o.blocks()?.primitives.checkState(rest) ?? null;
          }
          return o.blocks()?.primitives.checkState(value) ?? null;
        }
      }
    },
    captureWorld: (): WorldSave => o.captureWorld(),
    checkWorld: (world: WorldSave): string | null => o.worldProblem(world),
    applyWorld: (world: WorldSave): void => o.applyWorld(world),
    apply(section, value) {
      switch (section) {
        case 'grid':
          return o.grid.restoreDiff(value);
        case 'materials':
          o.materials.restoreState(value as MaterialSaveEntry[] | undefined);
          return null;
        case 'storage':
          o.saveStore.clear();
          for (const [k, v] of Object.entries((value ?? {}) as Record<string, unknown>)) o.saveStore.set(k, JSON.parse(saveValueText(v)!) as unknown);
          return null;
        case 'spawned':
          o.restoreSpawnedCopies((value ?? []) as SavedSpawnCopy[]);
          return null;
        case 'dialogue':
          o.dialogue.restoreState(value);
          // Each section returns here: a restore never falls through into the next section's.
          return null;
        case 'environment':
          o.environment.restoreState(value as EnvironmentSaveState | undefined, (id) => o.sceneLoaded(id));
          return null;
        case 'components': {
          const { counters, fields, ...rest } = (value ?? {}) as Record<string, unknown>;
          const blocks = o.blocks();
          blocks?.primitives.restoreState(rest as PrimitivesSaveState);
          const skipped = blocks?.setCounters((counters ?? {}) as Record<string, unknown>) ?? [];
          o.entityAccess.restoreState(fields as EntityFieldsSave | undefined);
          return skipped.length === 0 ? null : `counters not restored (${COUNTER_NAME_RULE}, with a number): ${skipped.slice(0, 8).map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}${skipped.length > 8 ? ` and ${skipped.length - 8} more` : ''}`;
        }
      }
    },
  };
}
