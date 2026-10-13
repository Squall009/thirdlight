/**
 * A delete of several objects as `deleteEntity` commands: one for all of
 * them (`entityIds`: one revision, one undo), or as many as the request takes
 * (project-model `DELETE_ENTITIES_MAX` ids and the request's bytes) for a
 * larger selection.
 */
import { DELETE_ENTITIES_MAX } from '@thirdlight/project-model/limits';
import { jsonBytes, requestBatches } from './request-batches';

/** What `deleteEntity` holds besides its ids (the arguments with an empty list). */
const DELETE_FIXED_BYTES = jsonBytes({ entityId: '', entityIds: [] });

/** The `deleteEntity` arguments that delete `ids` (none for none). */
export function deleteEntitiesArgs(ids: readonly string[]): { entityId: string; entityIds?: string[] }[] {
  return requestBatches(ids, DELETE_ENTITIES_MAX + 1, DELETE_FIXED_BYTES).map(([first, ...rest]) => (rest.length > 0 ? { entityId: first!, entityIds: rest } : { entityId: first! }));
}

/** The ids one `deleteEntity` of `deleteEntitiesArgs` removes (its subtrees go with them). */
export function deletedIds(args: { entityId: string; entityIds?: string[] }): string[] {
  return [args.entityId, ...(args.entityIds ?? [])];
}
