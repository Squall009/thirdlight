import { describe, expect, it } from 'vitest';

import { deleteEntitiesArgs } from './delete-entities';

describe('deleteEntitiesArgs', () => {
  it('deletes a whole selection in one command, however many objects it holds', () => {
    expect(deleteEntitiesArgs([])).toEqual([]);
    expect(deleteEntitiesArgs(['a'])).toEqual([{ entityId: 'a' }]);
    expect(deleteEntitiesArgs(['a', 'b', 'c'])).toEqual([{ entityId: 'a', entityIds: ['b', 'c'] }]);
    const many = Array.from({ length: 3000 }, (_, i) => `e${i}`);
    const args = deleteEntitiesArgs(many);
    expect(args).toHaveLength(1);
    expect([args[0]!.entityId, ...args[0]!.entityIds!]).toEqual(many);
  });
});
