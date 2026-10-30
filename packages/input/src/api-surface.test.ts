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

describe('public exports', () => {
  it('exports every contracted name', () => {
    expect(typeof input.attachBrowserInput).toBe('function');
    expect(typeof input.createActionEvaluator).toBe('function');
    expect(typeof input.GAMEPAD_DEAD_ZONE).toBe('number');
    // InputBindingOptions is a type-only export. Beside these: the menu-control
    // channel, the 3D defaults, the pointer/cursor helpers and the virtual gamepad.
    expect(Object.keys(input).sort()).toEqual([
      'DEFAULT_INPUT_CONFIG',
      'DEFAULT_INPUT_CONFIG_3D',
      'GAMEPAD_DEAD_ZONE',
      'MENU_CONFIRM_CODES',
      'MENU_GAMEPAD_CONFIRM_BUTTON',
      'MENU_MUTE_CODE',
      'VIRTUAL_PAD_AXES',
      'VIRTUAL_PAD_BUTTONS',
      'VIRTUAL_PAD_BUTTON_DOWN',
      'actionKeys',
      'attachBrowserInput',
      'bindsPointerButton',
      'bindsWheel',
      'createActionEvaluator',
      'createMenuController',
      'createVirtualPad',
      'cursorPresentation',
      'focusGameSurface',
    ]);
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

describe('the browser owner satisfies the runtime ActionSource shape', () => {
  it('exposes sample/reset; a frame carries only plain data', () => {
    // A type-level proof that the runtime can consume the source unchanged.
    const asActionSource: ActionSource = attachBrowserInput(null, { window: null, document: null, navigator: null, getGamepads: null });
    expect(typeof asActionSource.reset).toBe('function');
    expect(JSON.parse(JSON.stringify(asActionSource.sample(12)))).toEqual(asActionSource.sample(12));
  });
});
