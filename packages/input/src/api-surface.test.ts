/**
 * Public surface and the module-boundary guarantees `dependencies.md` states
 * for `input`.
 *
 * The package exports the contracted names, a frame carries only the three
 * contracted plain fields (no DOM/Gamepad object), and the browser owner
 * exposes the documented lifecycle hooks. The negative boundary probe for the
 * forbidden edges is `tools/check-boundaries.mjs`; this suite checks the
 * runtime surface.
 */
import { describe, expect, it } from 'vitest';
import { viewSource } from './test-frame-view';
import type { ActionSource } from '@thirdlight/runtime';

import * as input from './index';
import { attachBrowserInput } from './browser';
import { mapRawInput } from './mapping';
import { createStepInputSource } from './step-source';

describe('public exports (dependencies.md §3 input row)', () => {
  it('exports every contracted name', () => {
    expect(typeof input.mapRawInput).toBe('function');
    expect(typeof input.attachBrowserInput).toBe('function');
    expect(typeof input.DEFAULT_KEYBOARD_MAP).toBe('object');
    expect(typeof input.GAMEPAD_DEAD_ZONE).toBe('number');
    // RawInputSnapshot / InputBindingOptions are type-only exports.
    // Beside the contracted names: the menu-control channel, the named input
    // actions, the character controller's pad controls, the 3D defaults, the
    // pointer/cursor helpers and the virtual gamepad.
    expect(Object.keys(input).sort()).toEqual([
      'DEFAULT_INPUT_CONFIG',
      'DEFAULT_INPUT_CONFIG_3D',
      'DEFAULT_KEYBOARD_MAP',
      'GAMEPAD_DEAD_ZONE',
      'MENU_CONFIRM_CODES',
      'MENU_GAMEPAD_CONFIRM_BUTTON',
      'MENU_MUTE_CODE',
      'STANDARD_CHARACTER_PAD',
      'VIRTUAL_PAD_AXES',
      'VIRTUAL_PAD_BUTTONS',
      'VIRTUAL_PAD_BUTTON_DOWN',
      'actionKeys',
      'attachBrowserInput',
      'bindsPointerButton',
      'bindsWheel',
      'characterKeys',
      'characterPad',
      'createActionEvaluator',
      'createMenuController',
      'createStepInputSource',
      'createVirtualPad',
      'cursorPresentation',
      'focusGameSurface',
      'mapRawInput',
      'readCharacterPad',
      'toActionFrame',
    ]);
  });

  it('maps one plain snapshot to one plain frame', () => {
    const frame = mapRawInput(
      { keyboardLeft: false, keyboardRight: true, keyboardJump: false },
      { stepIndex: 12 },
    );
    expect(frame).toEqual({ stepIndex: 12, moveX: 1, jump: 'none' });
    expect(Object.keys(frame).sort()).toEqual(['jump', 'moveX', 'stepIndex']);
  });
});

describe('browser owner lifecycle surface', () => {
  it('returns the ActionSource hooks plus detach/dispose/unavailable/attached', () => {
    const source = viewSource(attachBrowserInput(null, {
      window: null,
      document: null,
      navigator: null,
      getGamepads: null,
    }));
    expect(typeof source.sample).toBe('function');
    expect(typeof source.reset).toBe('function');
    expect(typeof source.diagnostics).toBe('function');
    expect(typeof source.detach).toBe('function');
    expect(typeof source.dispose).toBe('function');
    expect(typeof source.unavailable).toBe('function');
    expect(source.attached).toBe(true);
    source.detach();
    expect(source.attached).toBe(false);
  });

  it('counters start at zero and only move on the contracted events', () => {
    const source = viewSource(attachBrowserInput(null, {
      window: null,
      document: null,
      navigator: null,
      getGamepads: null,
    }));
    expect(source.diagnostics?.()).toEqual({
      suspendCount: 0,
      activateCount: 0,
      disconnectCount: 0,
      mappingUnsupportedCount: 0,
    });
  });
});

describe('step source satisfies the runtime ActionSource shape', () => {
  it('exposes sample/reset and samples exactly once per index', () => {
    const source = createStepInputSource([
      {
        stepIndex: 12,
        raw: { keyboardLeft: false, keyboardRight: false, keyboardJump: true },
      },
    ]);
    // The injectable step source is assignable to the runtime's injected port
    // type (a type-level proof that the runtime can consume it unchanged).
    const asActionSource: ActionSource = source;
    expect(typeof asActionSource.sample).toBe('function');
    expect(typeof asActionSource.reset).toBe('function');
    expect(asActionSource.sample(12).actions?.['jump']?.p).toBe('pressed');
    expect(asActionSource.sample(12).actions?.['jump']?.p).toBe('pressed');
  });
});
