/**
 * Phase 12 hierarchy semantics over a validated v3 scene: folders and the
 * inherited entity flags.
 *
 * - A folder is organisation only. It has no transform and sits at the root
 *   or inside another folder, so its children's local transforms are world
 *   transforms relative to the nearest non-folder ancestor.
 * - `active: false` on any ancestor makes the whole subtree inactive.
 * - A folder passes `locked` and `static` down to its whole subtree (through
 *   objects too); an object's own `locked`/`static` apply to itself only.
 *
 * `resolveSceneHierarchy` is what the game loads: folders and inactive
 * entities removed, children re-hung under their nearest non-folder ancestor
 * and each entity carrying its effective `static` and tag mask. It runs once when a scene
 * is loaded, never per frame. Pure: no I/O, no three.js.
 */

import {
  isFolderEntity,
  type EntityV3,
  type ResolvedSceneV3,
  type SceneEntityV3,
  type SceneV3,
} from './types-v3';

/** The effective flags of one entity, and which ancestor set an inherited one. */
export interface EffectiveEntityFlags {
  active: boolean;
  locked: boolean;
  static: boolean;
  /** Phase 12 (b): the effective tag mask — own mask OR every folder above's mask. */
  tags: number;
  /** The tag bits that come from folders above (not set on the entity itself). */
  inheritedTags: number;
  /** The id of the nearest ancestor that switched the flag on/off for this entity (absent: its own value). */
  inheritedFrom: { active?: string; locked?: string; static?: string };
}

type FlagEntity = Pick<SceneEntityV3, 'id' | 'parentId' | 'active' | 'locked' | 'static' | 'tags' | 'components'>;

/**
 * Effective flags for every entity, keyed by id. Entities must be in
 * parent-before-child order (the scene invariant); an entity whose parent is
 * unknown is treated as a root.
 */
export function effectiveEntityFlags(entities: readonly FlagEntity[]): Map<string, EffectiveEntityFlags> {
  const out = new Map<string, EffectiveEntityFlags>();
  // What each entity hands to its children: inactive (any entity), and the
  // locked/static a folder set somewhere above (or on itself), with the id of
  // the entity that set it.
  const down = new Map<string, { inactive?: string; locked?: string; static?: string; tags?: number }>();
  for (const e of entities) {
    const inherited = (e.parentId !== undefined ? down.get(e.parentId) : undefined) ?? {};
    const own = (e.tags ?? 0) >>> 0;
    const fromFolders = (inherited.tags ?? 0) >>> 0;
    const flags: EffectiveEntityFlags = {
      active: e.active !== false,
      locked: e.locked === true,
      static: e.static === true,
      tags: (own | fromFolders) >>> 0,
      inheritedTags: (fromFolders & ~own) >>> 0,
      inheritedFrom: {},
    };
    if (inherited.inactive !== undefined) {
      flags.active = false;
      flags.inheritedFrom.active = inherited.inactive;
    }
    if (inherited.locked !== undefined && !flags.locked) {
      flags.locked = true;
      flags.inheritedFrom.locked = inherited.locked;
    }
    if (inherited.static !== undefined && !flags.static) {
      flags.static = true;
      flags.inheritedFrom.static = inherited.static;
    }
    const folder = isFolderEntity(e);
    down.set(e.id, {
      ...(flags.active ? {} : { inactive: inherited.inactive ?? e.id }),
      ...(inherited.locked !== undefined ? { locked: inherited.locked } : folder && e.locked === true ? { locked: e.id } : {}),
      ...(inherited.static !== undefined ? { static: inherited.static } : folder && e.static === true ? { static: e.id } : {}),
      // Tags: every folder's own mask reaches its whole subtree.
      tags: (fromFolders | (folder ? own : 0)) >>> 0,
    });
    out.set(e.id, flags);
  }
  return out;
}

/**
 * The nearest ancestor of `id` that is not a folder (null: none). `parentOf`
 * maps an id to its parent id; `isFolder` says whether an id is a folder.
 * Stops on a cycle (the validator reports cycles separately).
 */
export function nearestObjectAncestor(
  parentId: string | undefined | null,
  parentOf: (id: string) => string | undefined,
  isFolder: (id: string) => boolean,
): string | null {
  const seen = new Set<string>();
  let cur = parentId ?? undefined;
  while (cur !== undefined && !seen.has(cur)) {
    if (!isFolder(cur)) return cur;
    seen.add(cur);
    cur = parentOf(cur);
  }
  return null;
}

/**
 * The scene as the game loads it: no folders, no inactive entities, each
 * child under its nearest non-folder ancestor, effective `static` on each
 * entity (`locked` is editor-only and dropped). Document order is kept.
 */
export function resolveSceneHierarchy(scene: SceneV3 | ResolvedSceneV3): ResolvedSceneV3 {
  const entities = scene.entities as readonly SceneEntityV3[];
  const flags = effectiveEntityFlags(entities);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const out: EntityV3[] = [];
  for (const e of entities) {
    if (isFolderEntity(e)) continue;
    const f = flags.get(e.id);
    if (f === undefined || !f.active) continue;
    const parentId = nearestObjectAncestor(
      e.parentId,
      (id) => byId.get(id)?.parentId,
      (id) => {
        const p = byId.get(id);
        return p !== undefined && isFolderEntity(p);
      },
    );
    out.push({
      id: e.id,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(parentId !== null ? { parentId } : {}),
      ...(f.static ? { static: true as const } : {}),
      ...(f.tags !== 0 ? { tags: f.tags } : {}),
      components: e.components,
    });
  }
  return { schemaVersion: 3, sceneId: scene.sceneId, revision: scene.revision, entities: out };
}
