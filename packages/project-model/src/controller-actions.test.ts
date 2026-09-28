/**
 * Phase 24.8: the input actions a character controller reads (input frame
 * version 2 has no fixed move/jump channels).
 */
import { describe, it, expect } from 'vitest';
import { CONTROLLER_ACTION_DEFAULTS, canonicalController, controllerActionsOf, validateControllerComponent } from './components';
import type { ModelErrorV2 } from './errors';

describe('controller moveAction / jumpAction', () => {
  it('default to move and jump; a project names its own', () => {
    expect(CONTROLLER_ACTION_DEFAULTS).toEqual({ moveAction: 'move', jumpAction: 'jump' });
    expect(controllerActionsOf({})).toEqual({ move: 'move', jump: 'jump' });
    expect(controllerActionsOf(undefined)).toEqual({ move: 'move', jump: 'jump' });
    expect(controllerActionsOf({ moveAction: 'walk', jumpAction: 'hop' })).toEqual({ move: 'walk', jump: 'hop' });
  });

  it('are validated as action names and kept by the canonical form (absent keeps the old bytes)', () => {
    const errs = (c: unknown): string[] => {
      const e: ModelErrorV2[] = [];
      validateControllerComponent(c, '/c', e, 4);
      return e.map((x) => x.path);
    };
    expect(errs({ moveAction: 'walk', jumpAction: 'hop' })).toEqual([]);
    expect(errs({ moveAction: 'two words' })).toEqual(['/c/moveAction']);
    expect(errs({ jumpAction: 3 })).toEqual(['/c/jumpAction']);
    expect(canonicalController({ jumpAction: 'hop', moveAction: 'walk' })).toEqual({ moveAction: 'walk', jumpAction: 'hop' });
    expect(Object.keys(canonicalController({}))).toEqual([]);
  });
});
