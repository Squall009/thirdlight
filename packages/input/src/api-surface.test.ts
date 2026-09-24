/**
 * Packet 30 — public surface and the module-boundary guarantees the accepted
 * `dependencies.md` §3 `input` row and §4.1 edge state.
 *
 * The package exports the contracted names, a frame carries only the three
 * contracted plain fields (no DOM/Gamepad object), and the browser owner
 * exposes the documented lifecycle hooks. The negative boundary probe for the
 * forbidden edges is run separately against `tools/check-boundaries.mjs` (see
 * the packet-30 evidence manifest); this suite checks the runtime surface.
 */
import { describe, expect, it } from 'vitest';
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
    // Packet 55 (delivery.md §4.1/§4.2) adds the menu-control channel
    // constants + the pure controller (additive — the contracted names above
    // are unchanged).
    // Phase 9.8 adds the named input actions (additive).
    expect(Object.keys(input).sort()).toEqual([
      'DEFAULT_INPUT_CONFIG',
      'DEFAULT_KEYBOARD_MAP',
      'GAMEPAD_DEAD_ZONE',
      'MENU_CONFIRM_CODES',
      'MENU_GAMEPAD_CONFIRM_BUTTON',
      'MENU_MUTE_CODE',
      'actionKeys',
      'attachBrowserInput',
      'createActionEvaluator',
      'createMenuController',
      'createStepInputSource',
      'focusGameSurface',
      'mapRawInput',
      'platformerKeys',
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
    const source = attachBrowserInput(null, {
      window: null,
      document: null,
      navigator: null,
      getGamepads: null,
    });
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
    const source = attachBrowserInput(null, {
      window: null,
      document: null,
      navigator: null,
      getGamepads: null,
    });
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
    expect(asActionSource.sample(12).jump).toBe('pressed');
    expect(asActionSource.sample(12).jump).toBe('pressed');
  });
});
