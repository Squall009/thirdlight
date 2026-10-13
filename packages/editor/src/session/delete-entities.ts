/**
 * A delete of several objects as `deleteEntity` commands: one for all of
 * them (`entityIds`: one revision, one undo), or as many as the request size
 * takes (project-model `DELETE_ENTITIES_MAX`) for a larger selection.
 */
import { DELETE_ENTITIES_MAX } from '@thirdlight/project-model/limits';

/** The `deleteEntity` arguments that delete `ids` (none for none). */
export function deleteEntitiesArgs(ids: readonly string[]): { entityId: string; entityIds?: string[] }[] {
  const out: { entityId: string; entityIds?: string[] }[] = [];
  for (let i = 0; i < ids.length; i += DELETE_ENTITIES_MAX + 1) {
    const chunk = ids.slice(i, i + DELETE_ENTITIES_MAX + 1);
    out.push(chunk.length > 1 ? { entityId: chunk[0]!, entityIds: chunk.slice(1) } : { entityId: chunk[0]! });
  }
  return out;
}
