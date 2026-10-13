import { describe, expect, it } from 'vitest';
import { DELETE_ENTITIES_MAX } from '@thirdlight/project-model/limits';

import { deleteEntitiesArgs } from './delete-entities';

describe('deleteEntitiesArgs', () => {
  it('deletes a selection in one command, a larger one in as many as the request size takes', () => {
    expect(deleteEntitiesArgs([])).toEqual([]);
    expect(deleteEntitiesArgs(['a'])).toEqual([{ entityId: 'a' }]);
    expect(deleteEntitiesArgs(['a', 'b', 'c'])).toEqual([{ entityId: 'a', entityIds: ['b', 'c'] }]);
    const many = Array.from({ length: DELETE_ENTITIES_MAX + 2 }, (_, i) => `e${i}`);
    const args = deleteEntitiesArgs(many);
    expect(args.length).toBe(2);
    expect(args[0]!.entityIds!.length).toBe(DELETE_ENTITIES_MAX);
    expect(args[1]).toEqual({ entityId: `e${DELETE_ENTITIES_MAX + 1}` });
  });
});
