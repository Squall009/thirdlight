/**
 * Phase 21.3: what an incremental Scene view sync has to touch (pure; the
 * viewport applies it).
 *
 * The projection is copy-on-write (21.4): an entity it did not change keeps
 * its object, and `takeDirty()` names the ones it did. A sync looks at the
 * named entities plus any whose object differs from the one the view last
 * synced (a scene opened, a caller without the dirty set); the hierarchy
 * flags, the zone overlay and the selection are re-derived only when
 * something they read changed. Without a dirty set (or `all`), everything.
 */
import type { ProjectedEntity } from '../session/projection';

export interface SyncPlan {
  /** Every entity is looked at (a hydrate, or no dirty set). */
  readonly full: boolean;
  /** The entities to build or update. */
  readonly changed: readonly ProjectedEntity[];
  /** Parents, flags, kinds or the entity set changed: the hierarchy flags and folders are re-derived. */
  readonly structural: boolean;
  /** Something the zone overlay draws changed (zones, spawns, camera follow, colliders, the player, blocks). */
  readonly zones: boolean;
  /** The selected entity changed (its gizmo, highlight and handles follow). */
  readonly selectionTouched: boolean;
}

/** Whether the zone overlay draws something for an entity. */
export function zoneRelevant(e: ProjectedEntity | undefined): boolean {
  return e !== undefined && (e.gameZone !== undefined || e.playerSpawn !== undefined || e.cameraFollow !== undefined || e.collider !== undefined || e.controller === true || e.blocks !== undefined);
}

/** What the hierarchy flags, folders and parents are made of (a change re-derives them). */
export function structureOf(e: ProjectedEntity): string {
  return `${e.parentId ?? ''}|${e.active ? 1 : 0}${e.locked ? 1 : 0}${e.static ? 1 : 0}|${e.tags}|${e.kind}`;
}

export function planSync(
  entities: readonly ProjectedEntity[],
  synced: ReadonlyMap<string, ProjectedEntity>,
  dirty: { readonly all: boolean; readonly ids: ReadonlySet<string> } | undefined,
  selectedId: string | null,
): SyncPlan {
  const full = dirty === undefined || dirty.all;
  const changed: ProjectedEntity[] = [];
  if (full) changed.push(...entities);
  else for (const e of entities) if (synced.get(e.id) !== e || dirty.ids.has(e.id)) changed.push(e);
  let structural = full;
  let zones = full;
  let selectionTouched = full;
  for (const e of changed) {
    const before = synced.get(e.id);
    if (before === undefined || structureOf(before) !== structureOf(e)) structural = true;
    if (zoneRelevant(before) || zoneRelevant(e)) zones = true;
    if (e.id === selectedId) selectionTouched = true;
  }
  return { full, changed, structural, zones, selectionTouched };
}

/**
 * The view's nodes whose entities are gone. After the adds the nodes equal
 * the entities unless some left, so the set is only built then (`nodeCount`
 * is the view's node count after adding).
 */
export function removedIds(entities: readonly ProjectedEntity[], nodeIds: Iterable<string>, nodeCount: number, full: boolean): string[] {
  if (!full && nodeCount === entities.length) return [];
  const seen = new Set(entities.map((e) => e.id));
  const out: string[] = [];
  for (const id of nodeIds) if (!seen.has(id)) out.push(id);
  return out;
}
