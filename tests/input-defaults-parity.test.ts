/**
 * Phase 9.8: the input package's copy of the default actions (the editor's
 * Play preview may not import project-model values) equals project-model's.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_INPUT } from '../packages/project-model/src/input';
import { DEFAULT_INPUT_CONFIG } from '../packages/input/src/actions';

describe('input defaults parity', () => {
  it('the input package and project-model agree on the default actions', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_INPUT_CONFIG))).toEqual(JSON.parse(JSON.stringify(DEFAULT_INPUT)));
  });
});
