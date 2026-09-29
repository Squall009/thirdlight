/**
 * The input package's copy of the default actions (the editor's
 * Play preview may not import project-model values) equals project-model's.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_INPUT, DEFAULT_INPUT_3D } from '../packages/project-model/src/input';
import { DEFAULT_INPUT_CONFIG, DEFAULT_INPUT_CONFIG_3D } from '../packages/input/src/actions';

describe('input defaults parity', () => {
  it('the input package and project-model agree on the default actions', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_INPUT_CONFIG))).toEqual(JSON.parse(JSON.stringify(DEFAULT_INPUT)));
  });
  it('and on the 3D defaults', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_INPUT_CONFIG_3D))).toEqual(JSON.parse(JSON.stringify(DEFAULT_INPUT_3D)));
  });
});
