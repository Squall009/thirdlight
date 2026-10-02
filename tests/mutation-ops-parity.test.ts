/**
 * The mutation op list is defined once in commands (the validator, the
 * host's records); the wire contract in protocol cannot import values from
 * commands, so its copy is held to the same list here.
 */
import { describe, expect, it } from 'vitest';

import { MUTATION_OPS } from '../packages/commands/src/index';
import { V3_MUTATION_OPS } from '../packages/protocol/src/index';

describe('mutation ops', () => {
  it('the wire list is the commands list', () => {
    expect(new Set(MUTATION_OPS).size).toBe(MUTATION_OPS.length);
    // The same ops (each list keeps its own order).
    expect([...MUTATION_OPS.slice(MUTATION_OPS.length - V3_MUTATION_OPS.length)].sort()).toEqual([...V3_MUTATION_OPS].sort());
  });
});
