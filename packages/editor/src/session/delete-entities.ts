/**
 * A delete of several objects as one `deleteEntity` command (`entityIds`:
 * one revision, one undo). There is no count per command: the request's
 * bytes bound a selection, and one too large for them is refused whole with
 * the backend's message rather than split into several undo steps.
 */

/** The `deleteEntity` arguments that delete `ids` (none for none). */
export function deleteEntitiesArgs(ids: readonly string[]): { entityId: string; entityIds?: string[] }[] {
  const [first, ...rest] = ids;
  if (first === undefined) return [];
  return [rest.length > 0 ? { entityId: first, entityIds: rest } : { entityId: first }];
}

/** The ids one `deleteEntity` of `deleteEntitiesArgs` removes (its subtrees go with them). */
export function deletedIds(args: { entityId: string; entityIds?: string[] }): string[] {
  return [args.entityId, ...(args.entityIds ?? [])];
}
