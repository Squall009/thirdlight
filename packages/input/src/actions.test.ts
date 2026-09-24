/**
 * Phase 9.8: named input actions — composites, gamepad buttons/axes,
 * processors and phases from synthetic device state, and the browser owner
 * with a project's bindings (fake window, synthetic key events; no gamepad).
 */
import { describe, expect, it } from 'vitest';

import { createActionEvaluator, DEFAULT_INPUT_CONFIG, platformerKeys, type InputConfigLike, type RawDeviceState } from './actions';
import { attachBrowserInput } from './browser';

const raw = (keys: string[] = [], pressed: string[] = [], gamepad: RawDeviceState['gamepad'] = null): RawDeviceState => ({ keys: new Set(keys), pressedKeys: new Set(pressed), gamepad });
const pad = (buttons: number[] = [], axes: number[] = [0, 0, 0, 0]): RawDeviceState['gamepad'] => ({ buttons: Array.from({ length: 17 }, (_, i) => buttons.includes(i)), axes });

describe('input actions', () => {
  it('evaluates composites: two keys → a 1D axis, four keys → a 2D axis', () => {
    const e = createActionEvaluator(DEFAULT_INPUT_CONFIG);
    let a = e.sample(raw(['KeyD']));
    expect(a['move']).toEqual({ v: 1, p: 'pressed' });
    a = e.sample(raw(['KeyD', 'KeyA']));
    expect(a['move']!.v).toBe(0); // both held: no contribution
    a = e.sample(raw(['ArrowUp', 'ArrowRight']));
    expect(a['navigate']!.x).toBeCloseTo(Math.SQRT1_2, 3);
    expect(a['navigate']!.y).toBeCloseTo(Math.SQRT1_2, 3);
    expect(a['navigate']!.v).toBeCloseTo(1, 3);
  });

  it('gives buttons their phases, counts a tap between samples, and reads gamepad buttons and sticks', () => {
    const e = createActionEvaluator(DEFAULT_INPUT_CONFIG);
    expect(e.sample(raw([], ['KeyJ']))['attack']).toEqual({ v: 1, p: 'pressed' }); // tapped and released before the sample
    expect(e.sample(raw())['attack']).toEqual({ v: 0, p: 'released' });
    expect(e.sample(raw())['attack']).toEqual({ v: 0, p: 'none' });
    expect(e.sample(raw([], [], pad([2])))['attack']!.p).toBe('pressed');
    expect(e.sample(raw([], [], pad([2])))['attack']!.p).toBe('held');
    // Stick: dead zone 0.2, rescaled; y is up-positive.
    const s = e.sample(raw([], [], pad([], [0.1, -0.6, 0, 0])));
    expect(s['move']!.v).toBe(0);
    expect(s['navigate']!.y).toBeCloseTo(0.503, 2); // radial: |(0.1, 0.6)| = 0.608 → (0.608 − 0.2) / 0.8
  });

  it('applies invert and scale; the strongest binding wins', () => {
    const cfg: InputConfigLike = { actions: [{ name: 'look', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'gamepadAxis', axis: 2 }, { kind: 'keys1d', negative: 'KeyQ', positive: 'KeyE' }], invert: true, scale: 2 }] };
    const e = createActionEvaluator(cfg);
    expect(e.sample(raw(['KeyE'], [], pad([], [0, 0, 0.5, 0])))['look']!.v).toBe(-2);
    expect(e.sample(raw([], [], pad([], [0, 0, 0.6, 0])))['look']!.v).toBe(-1);
  });

  it('derives the platformer keys from move/jump', () => {
    expect(platformerKeys(DEFAULT_INPUT_CONFIG)).toEqual({ left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], jump: ['Space'] });
  });

  it('the browser owner jumps with a rebound key and reports named actions in the frame', () => {
    const cfg: InputConfigLike = {
      actions: DEFAULT_INPUT_CONFIG.actions.map((a) => (a.name === 'jump' ? { ...a, bindings: [{ kind: 'key', code: 'KeyW' }] } : a)),
    };
    const listeners = new Map<string, ((e: Event) => void)[]>();
    const target = {
      addEventListener: (t: string, h: (e: Event) => void) => listeners.set(t, [...(listeners.get(t) ?? []), h]),
      removeEventListener: () => undefined,
    };
    const fire = (type: string, code: string): void => {
      for (const h of listeners.get(type) ?? []) h({ type, code, repeat: false, target, preventDefault: () => undefined } as unknown as Event);
    };
    const source = attachBrowserInput(target as unknown as EventTarget, { window: null, document: null, navigator: null, getGamepads: null, inputConfig: cfg });
    fire('keydown', 'Space');
    expect(source.sample(0).jump).toBe('none'); // Space no longer jumps
    fire('keyup', 'Space');
    fire('keydown', 'KeyW');
    const f = source.sample(1);
    expect(f.jump).toBe('pressed');
    expect(f.actions?.['jump']).toEqual({ v: 1, p: 'pressed' });
    fire('keydown', 'KeyJ');
    expect(source.sample(2).actions?.['attack']).toEqual({ v: 1, p: 'pressed' });
    source.dispose();
  });

  it('phase 9.10: menu edges from the ui keys, runtime rebinding, and a one-shot key capture', () => {
    const listeners = new Map<string, ((e: Event) => void)[]>();
    const target = {
      addEventListener: (t: string, h: (e: Event) => void) => listeners.set(t, [...(listeners.get(t) ?? []), h]),
      removeEventListener: () => undefined,
    };
    const fire = (type: string, code: string, repeat = false): void => {
      for (const h of listeners.get(type) ?? []) h({ type, code, repeat, target, preventDefault: () => undefined } as unknown as Event);
    };
    const source = attachBrowserInput(target as unknown as EventTarget, { window: null, document: null, navigator: null, getGamepads: null, inputConfig: DEFAULT_INPUT_CONFIG });
    fire('keydown', 'ArrowDown');
    fire('keydown', 'ArrowDown', true); // held: navigation repeats
    fire('keydown', 'Escape');
    // One edge per sample, in arrival order: down, down (the repeat), pause.
    expect(source.sampleUi()).toEqual({ up: false, down: true, left: false, right: false, submit: false, cancel: false, pause: false });
    expect(source.sampleUi().down).toBe(true);
    expect(source.sampleUi().pause).toBe(true);
    expect(source.sampleUi()).toEqual({ up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false });
    fire('keydown', 'Enter', true);
    expect(source.sampleUi().submit).toBe(false); // a repeat is not a new submit
    // Rebind jump to KeyK: Space stops jumping.
    source.configure({ actions: DEFAULT_INPUT_CONFIG.actions.map((a) => (a.name === 'jump' ? { ...a, bindings: [{ kind: 'key', code: 'KeyK' }] } : a)) });
    fire('keydown', 'Space');
    expect(source.sample(0).jump).toBe('none');
    fire('keydown', 'KeyK');
    expect(source.sample(1).jump).toBe('pressed');
    // Capture: the next key goes to the callback only.
    const got: (string | null)[] = [];
    source.captureKey((c) => got.push(c));
    fire('keydown', 'KeyQ');
    fire('keydown', 'Escape');
    expect(got).toEqual(['KeyQ']);
    expect(source.sampleUi().pause).toBe(true); // the second Escape was not captured
    source.dispose();
  });
});
