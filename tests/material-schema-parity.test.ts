/**
 * Phase 9.4: the editor's copy of the material schema equals project-model's
 * (the editor may import project-model types only).
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_WIND, MATERIAL_PARAMS, MATERIAL_SHADERS, MATERIAL_TEXTURE_SLOTS } from '../packages/project-model/src/materials';
import * as editor from '../packages/editor/src/session/material-schema';

describe('material schema parity', () => {
  it('the editor copy matches project-model', () => {
    expect([...editor.MATERIAL_SHADERS]).toEqual([...MATERIAL_SHADERS]);
    expect(editor.MATERIAL_PARAMS).toEqual(MATERIAL_PARAMS);
    expect(editor.MATERIAL_TEXTURE_SLOTS).toEqual(MATERIAL_TEXTURE_SLOTS);
    expect(editor.DEFAULT_WIND).toEqual(DEFAULT_WIND);
  });
});
