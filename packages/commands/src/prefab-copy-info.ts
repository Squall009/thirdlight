/**
 * What an object of a linked copy is, for a reader (the editor's Inspector,
 * MCP): the copy it belongs to, the prefab that copy links (as stored — a
 * variant's copy names the variant, though its assembled root comes from the
 * base), the part it is, and every override the copy keeps. The editor sees
 * only assembled objects, so this is how it learns which fields a copy
 * overrides and what Revert and Apply would name.
 */
import type { PrefabOverride } from '@thirdlight/project-model';

import { locateCopies } from './prefab-copy-edit';
import type { ContentDocument, SceneDocument } from './types';

export interface PrefabCopyInfo {
  /** The copy's root (the stored object holding the link). */
  copyId: string;
  /** The prefab the copy links. */
  prefabId: string;
  /** The object's part path key in that prefab. */
  part: string;
  /** The object is the copy's root. */
  root: boolean;
  /** Every override the copy keeps (all parts). */
  overrides: PrefabOverride[];
  /** The scene id of each of the copy's parts, by part path key (a reader names an override's part by it). */
  partIds: Record<string, string>;
}

/** The copy an object of the scene belongs to (null: it is no linked copy's root or part). */
export function describePrefabCopy(scene: SceneDocument, content: ContentDocument | undefined, entityId: string): PrefabCopyInfo | null {
  const loc = locateCopies(scene, content);
  const found = loc?.find(entityId) ?? null;
  if (loc === null || found === null) return null;
  const root = loc.links.get(found.copyId);
  const link = (root?.components as { prefab?: { prefabId: string; overrides?: PrefabOverride[] } } | undefined)?.prefab;
  if (link === undefined) return null;
  return { copyId: found.copyId, prefabId: link.prefabId, part: found.key, root: found.root, overrides: JSON.parse(JSON.stringify(link.overrides ?? [])) as PrefabOverride[], partIds: Object.fromEntries(loc.made(found.copyId).partIds) };
}
