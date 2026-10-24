/**
 * The args and change data of the linked-copy commands: overrides written by
 * editing a copy's parts, reverting and applying them, unpacking a copy and
 * making a variant. Kept apart from `types.ts` so the linked-copy area grows
 * on its own.
 */
import type { EntityV3, PrefabDefinition } from '@thirdlight/project-model';

/**
 * Names the overrides of one copy: `entityId` is the copy (its root) or one
 * of its parts. `part` names a part of the copy by its part path (a removed
 * part has no object to name); `path` one field of that part (`name`,
 * `tags`, `components/<component>[/<field>…]`). `all` names every override
 * of the copy (and, to apply, the objects added to it). To apply, `entityId`
 * may also name an object added to a copy, alone: it becomes a part of that
 * copy's prefab (a linked copy added so nests in it).
 */
export interface PrefabOverrideTargetArgs {
  entityId: string;
  part?: string;
  path?: string;
  all?: boolean;
}

/** `unpackPrefab`: the copy becomes plain objects (ids kept). */
export interface UnpackPrefabArgs {
  entityId: string;
}

/** `createPrefabVariant`: a new prefab made of one linked copy of `basePrefabId`. */
export interface CreatePrefabVariantArgs {
  basePrefabId: string;
  prefabId: string;
  displayName: string;
}

/** One stored scene object at its place in the scene's object list. */
export interface SceneEntry {
  index: number;
  entity: EntityV3;
}

/**
 * A change to linked copies, as stored: the scene objects it replaced (at
 * their places before) and the ones it put in (at their places after), and
 * any prefab it changed. Editing a copy's part, reverting, applying and
 * unpacking all store it, so undo and redo swap the two sides. The objects a
 * copy assembles into travel beside it (`change.assembled`).
 */
export interface PrefabLinkEditChange {
  type: 'prefabLinkEdit';
  /** The copies the change concerns. */
  copyIds: string[];
  previous: SceneEntry[];
  next: SceneEntry[];
  /** The ids of the objects `previous` holds and `next` does not (a client that is sent only `next` needs them). */
  removedIds: string[];
  /** A copy placed under a copy's part: its root and its parts' ids, as `instantiatePrefab` reports them. */
  placed?: { prefabId: string; rootId: string; mapping: { localId: string; entityId: string }[] };
  /** Prefabs replaced (apply): the whole definition before and after. */
  prefabs?: { prefabId: string; previous: PrefabDefinition; next: PrefabDefinition }[];
}

/** Undo of a `prefabLinkEdit`: the entry's change with its sides swapped. */
export interface PrefabLinkEditInverse {
  kind: 'prefabLinkEdit';
}
