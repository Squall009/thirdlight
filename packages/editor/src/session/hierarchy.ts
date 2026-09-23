/**
 * Hierarchy panel logic (phase 12), pure: the visible rows of the tree
 * (collapse + filter), multi-selection, where a drag would drop, and the
 * effective (inherited) flags. The panel and the viewport render from these;
 * every edit they lead to is a command (`moveEntities`, `updateEntity`).
 *
 * Pure: no DOM, no storage.
 */

import { effectiveEntityFlags, type EffectiveEntityFlags } from '@thirdlight/runtime';

import type { ProjectedEntity } from './projection';

export type { EffectiveEntityFlags };

/** The effective flags of every projected entity (folders pass them down). */
export function effectiveFlagsOf(entities: readonly ProjectedEntity[]): Map<string, EffectiveEntityFlags> {
  return effectiveEntityFlags(
    entities.map((e) => ({
      id: e.id,
      ...(e.parentId !== null ? { parentId: e.parentId } : {}),
      ...(e.active ? {} : { active: false as const }),
      ...(e.locked ? { locked: true as const } : {}),
      ...(e.static ? { static: true as const } : {}),
      ...(e.tags !== 0 ? { tags: e.tags } : {}),
      components: e.kind === 'folder' ? { folder: {} } : {},
    })) as Parameters<typeof effectiveEntityFlags>[0],
  );
}

export interface TreeRow {
  id: string;
  depth: number;
  hasChildren: boolean;
}

/** Children of each parent (null = root), in document order. */
export function childrenByParent(entities: readonly ProjectedEntity[]): Map<string | null, ProjectedEntity[]> {
  const byParent = new Map<string | null, ProjectedEntity[]>();
  const ids = new Set(entities.map((e) => e.id));
  for (const e of entities) {
    const key = e.parentId !== null && ids.has(e.parentId) ? e.parentId : null;
    const arr = byParent.get(key) ?? [];
    arr.push(e);
    byParent.set(key, arr);
  }
  return byParent;
}

/**
 * The rows the tree shows: depth-first in document order, children of a
 * collapsed row hidden. With a filter, every matching entity is shown (with
 * its ancestors, so it keeps its place in the tree) regardless of collapse.
 */
export function visibleRows(entities: readonly ProjectedEntity[], collapsed: ReadonlySet<string>, filter = ''): TreeRow[] {
  const byParent = childrenByParent(entities);
  const needle = filter.trim().toLowerCase();
  let keep: Set<string> | null = null;
  if (needle !== '') {
    keep = new Set<string>();
    const byId = new Map(entities.map((e) => [e.id, e]));
    for (const e of entities) {
      if (!e.name.toLowerCase().includes(needle) && !e.id.toLowerCase().includes(needle)) continue;
      let cur: ProjectedEntity | undefined = e;
      while (cur !== undefined && !keep.has(cur.id)) {
        keep.add(cur.id);
        cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined;
      }
    }
  }
  const rows: TreeRow[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const c of byParent.get(parentId) ?? []) {
      if (keep !== null && !keep.has(c.id)) continue;
      const kids = byParent.get(c.id) ?? [];
      rows.push({ id: c.id, depth, hasChildren: kids.length > 0 });
      if (keep !== null || !collapsed.has(c.id)) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/**
 * The next selection after a click on `id`: plain click selects only it,
 * Ctrl/Cmd toggles it, Shift selects the visible range from the anchor.
 */
export function nextSelection(
  current: readonly string[],
  anchor: string | null,
  id: string,
  mods: { toggle: boolean; range: boolean },
  rows: readonly TreeRow[],
): { ids: string[]; primary: string | null; anchor: string | null } {
  if (mods.range && anchor !== null) {
    const order = rows.map((r) => r.id);
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const range = order.slice(lo, hi + 1);
      const ids = mods.toggle ? [...new Set([...current, ...range])] : range;
      return { ids, primary: id, anchor };
    }
  }
  if (mods.toggle) {
    if (current.includes(id)) {
      const ids = current.filter((x) => x !== id);
      return { ids, primary: ids.at(-1) ?? null, anchor: id };
    }
    return { ids: [...current, id], primary: id, anchor: id };
  }
  return { ids: [id], primary: id, anchor: id };
}

/** Where on a row the pointer is: the top quarter, the middle, or the bottom quarter. */
export type DropZone = 'before' | 'into' | 'after';

export function dropZoneAt(offsetY: number, height: number): DropZone {
  if (offsetY < height * 0.25) return 'before';
  if (offsetY > height * 0.75) return 'after';
  return 'into';
}

/** The `moveEntities` target for a drop. */
export interface DropTarget {
  parentId: string | null;
  beforeId: string | null;
  zone: DropZone;
}

/**
 * Where dropping `dragged` on `targetId` (in `zone`) would move them, or null
 * when the drop is not allowed: onto itself or its own subtree, or a folder
 * under an object. "into" an object that cannot take the selection falls back
 * to before/after. `targetId` null means the empty list area (root, at the end).
 */
export function dropTarget(
  entities: readonly ProjectedEntity[],
  dragged: readonly string[],
  targetId: string | null,
  zone: DropZone,
): DropTarget | null {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const draggingFolder = dragged.some((id) => byId.get(id)?.kind === 'folder');
  if (targetId === null) return { parentId: null, beforeId: null, zone: 'after' };
  const target = byId.get(targetId);
  if (target === undefined) return null;
  // Not onto a dragged entity or anything inside one.
  const draggedSet = new Set(dragged);
  for (let cur: ProjectedEntity | undefined = target; cur !== undefined; cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined) {
    if (draggedSet.has(cur.id)) return null;
  }
  const canHold = (parentId: string | null): boolean =>
    !draggingFolder || parentId === null || byId.get(parentId)?.kind === 'folder';
  let z = zone;
  if (z === 'into' && !canHold(target.id)) z = 'after';
  if (z === 'into') return { parentId: target.id, beforeId: null, zone: 'into' };
  const parentId = target.parentId;
  if (!canHold(parentId)) return null;
  if (z === 'before') return { parentId, beforeId: target.id, zone: 'before' };
  // After: before the next sibling that is not being dragged (or at the end).
  const siblings = childrenByParent(entities).get(parentId) ?? [];
  const at = siblings.findIndex((s) => s.id === target.id);
  const next = siblings.slice(at + 1).find((s) => !draggedSet.has(s.id));
  return { parentId, beforeId: next?.id ?? null, zone: 'after' };
}

/** The dragged roots: selected ids without those whose ancestor is also selected, in document order. */
export function draggedRoots(entities: readonly ProjectedEntity[], ids: readonly string[]): string[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const set = new Set(ids);
  return entities
    .filter((e) => set.has(e.id))
    .filter((e) => {
      for (let p = e.parentId; p !== null; p = byId.get(p)?.parentId ?? null) if (set.has(p)) return false;
      return true;
    })
    .map((e) => e.id);
}
