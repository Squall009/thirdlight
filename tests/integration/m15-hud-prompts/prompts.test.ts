/**
 * Phase 15.5: game-host imports the input package for types only, so it
 * keeps a copy of the default move/jump actions for prompts when a host is
 * given no input config. This pins the copy to the input package's default
 * and to project-model's `DEFAULT_INPUT` (what a project without its own
 * actions plays with).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_INPUT, hudPrompts } from '@thirdlight/game-host';
import { DEFAULT_INPUT_CONFIG } from '@thirdlight/input';
import { DEFAULT_INPUT } from '@thirdlight/project-model';

const moveJump = (c: { actions: readonly { name: string }[] }): unknown => JSON.parse(JSON.stringify(c.actions.filter((a) => a.name === 'move' || a.name === 'jump')));

describe('the HUD prompts\' default actions', () => {
  it('equal the input package\'s and the project model\'s default move and jump', () => {
    expect(moveJump(DEFAULT_PROMPT_INPUT)).toEqual(moveJump(DEFAULT_INPUT_CONFIG));
    expect(moveJump(DEFAULT_PROMPT_INPUT)).toEqual(moveJump(DEFAULT_INPUT));
    expect(hudPrompts(DEFAULT_INPUT, 'keyboard')).toEqual(hudPrompts(DEFAULT_PROMPT_INPUT, 'keyboard'));
  });
});
