/**
 * The input prompts name the project's declared actions and their bindings.
 */
import { describe, expect, it } from 'vitest';
import { actionPrompts, actionWords, keyLabel, padButtonLabel } from './bindings';

describe('labels', () => {
  it('names keys and pad buttons as a player reads them', () => {
    expect(keyLabel('KeyJ')).toBe('J');
    expect(keyLabel('ArrowUp')).toBe('Up');
    expect(keyLabel('Digit7')).toBe('7');
    expect(keyLabel('ShiftLeft')).toBe('ShiftLeft');
    expect(padButtonLabel(9)).toBe('Start');
    expect(padButtonLabel(30)).toBe('button 30');
  });
});

describe('prompts generated from the declared input actions', () => {
  const config = {
    actions: [
      { name: 'moveX', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'keys1d', negative: 'KeyA', positive: 'KeyD' }] },
      { name: 'walk', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'gamepadStick', x: 0, y: 1 }, { kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' }] },
      { name: 'open_door', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyE' }] },
      { name: 'unbound', type: 'button', map: 'gameplay', bindings: [] },
      { name: 'confirm', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'Enter' }] },
    ],
  };
  it('names every action of the maps in declaration order, with no action special', () => {
    expect(actionWords('moveX')).toBe('move x');
    expect(actionWords('open_door')).toBe('open door');
    expect(actionPrompts(config).map((p) => p.text)).toEqual(['A/D move x', 'WASD walk', 'E open door']);
    expect(actionPrompts(config, undefined, ['ui']).map((p) => p.text)).toEqual(['Enter confirm']);
    // The label the input in use shows (a rebinding's glyph) wins over the first keyboard binding.
    expect(actionPrompts(config, (n) => (n === 'open_door' ? 'Y' : '')).map((p) => p.keys)).toEqual(['A/D', 'WASD', 'Y']);
  });
});
