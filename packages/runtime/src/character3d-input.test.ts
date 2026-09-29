/**
 * The 3D character's input and intent vocabulary — the optional
 * second move axis of an action frame (older frames and replays unchanged),
 * `control_move`'s optional `y`, and the character intents' shapes and
 * values. The controller itself runs on the real Rapier 3D backend in
 * tests/integration/m23-3d.
 */
import { describe, expect, it } from 'vitest';

import { createRecordedActionSource, validateActionFrame } from './actions';
import { validateIntentPhase, validateIntentShape, validateIntentValue } from './intents';
import { inputView } from './behavior';

describe('phase 23.2: action frames carry an optional move-Y', () => {
  it('a frame without moveY validates exactly as before; with it, moveY follows moveX\'s rules', () => {
    // A version 1 frame reads as the move/jump actions (version 2).
    expect(validateActionFrame({ stepIndex: 3, moveX: 0.5, jump: 'none' })).toEqual({ ok: true, frame: { stepIndex: 3, actions: { move: { v: 0.5, p: 'none' }, jump: { v: 0, p: 'none' } } } });
    const withY = validateActionFrame({ stepIndex: 3, moveX: 0.5, moveY: -1, jump: 'held', actions: { run: { v: 1, p: 'held' } } });
    expect(withY.ok && withY.frame).toEqual({ stepIndex: 3, actions: { run: { v: 1, p: 'held' }, move: { v: 0.5, x: 0.5, y: -1, p: 'none' }, jump: { v: 1, p: 'held' } } });
    expect(validateActionFrame({ stepIndex: 3, moveX: 0, moveY: 1.5, jump: 'none' })).toMatchObject({ ok: false, field: 'moveY' });
    expect(validateActionFrame({ stepIndex: 3, moveX: 0, moveY: 0.12345, jump: 'none' })).toMatchObject({ ok: false, field: 'moveY' });
    expect(validateActionFrame({ stepIndex: 3, moveX: 0, moveY: 'up', jump: 'none' })).toMatchObject({ ok: false, field: 'moveY' });
    // Any other unknown key is still refused (strict shape).
    expect(validateActionFrame({ stepIndex: 3, moveX: 0, moveZ: 1, jump: 'none' })).toMatchObject({ ok: false, field: 'moveZ' });
  });

  it('a recorded run replays moveY; a script reads the move as a vector', () => {
    const src = createRecordedActionSource([{ stepIndex: 0, moveX: 0, moveY: 1, jump: 'none' }, { stepIndex: 1, moveX: 1, jump: 'none' }] as never);
    expect(src.sample(0)).toEqual({ stepIndex: 0, actions: { move: { v: 0, x: 0, y: 1, p: 'none' }, jump: { v: 0, p: 'none' } } });
    expect(src.sample(1)).toEqual({ stepIndex: 1, actions: { move: { v: 1, p: 'none' }, jump: { v: 0, p: 'none' } } });
    expect(inputView({ stepIndex: 0, actions: { move: { v: 0.5, x: 0.5, y: -0.25, p: 'none' } } }).vector('move')).toEqual([0.5, -0.25]);
    expect(inputView({ stepIndex: 0, actions: { move: { v: 0.5, p: 'none' } } }).vector('move')).toEqual([0.5, 0]);
  });
});

describe('phase 23.2: control_move y and the character intents', () => {
  const ok = (v: unknown) => {
    const s = validateIntentShape(v);
    expect(s.ok, JSON.stringify(s)).toBe(true);
    return s.ok ? s.intent : null;
  };
  const bad = (v: unknown) => {
    const s = validateIntentShape(v);
    expect(s.ok).toBe(false);
    return s.ok ? '' : s.error.detail;
  };

  it('shapes: canonical order, strict fields', () => {
    expect(ok({ kind: 'control_move', value: 0.5 })).toEqual({ kind: 'control_move', value: 0.5 });
    expect(ok({ kind: 'control_move', value: 0.5, y: -1 })).toEqual({ kind: 'control_move', value: 0.5, y: -1 });
    bad({ kind: 'control_move', y: -1, value: 0.5 });
    expect(ok({ kind: 'character_move', x: 1, z: 0 })).toEqual({ kind: 'character_move', x: 1, z: 0 });
    expect(ok({ kind: 'character_move', x: 1, z: 0, run: true })).toEqual({ kind: 'character_move', x: 1, z: 0, run: true });
    bad({ kind: 'character_move', x: 1 });
    bad({ kind: 'character_move', z: 0, x: 1 });
    bad({ kind: 'character_move', x: 1, z: 0, run: 'yes' });
    expect(ok({ kind: 'character_place', position: [1, 2, 3] })).toEqual({ kind: 'character_place', position: [1, 2, 3] });
    bad({ kind: 'character_place', position: { x: 1, y: 2, z: 3 } });
    bad({ kind: 'character_place', position: [1, 2] });
    expect(ok({ kind: 'character_enable', enabled: false })).toEqual({ kind: 'character_enable', enabled: false });
    bad({ kind: 'character_enable', enabled: 0 });
    bad({ kind: 'character_enable', enabled: true, extra: 1 });
  });

  it('values and phases: finite, bounded, intent phase only', () => {
    expect(validateIntentValue({ kind: 'control_move', value: 0, y: 2 })?.detail).toBe('value');
    expect(validateIntentValue({ kind: 'character_move', x: Number.NaN, z: 0 })?.detail).toBe('value');
    expect(validateIntentValue({ kind: 'character_place', position: [0, 1e7, 0] })?.detail).toBe('value');
    expect(validateIntentValue({ kind: 'character_place', position: [0, 1, 0] })).toBeNull();
    expect(validateIntentValue({ kind: 'character_enable', enabled: true })).toBeNull();
    expect(validateIntentPhase({ kind: 'character_move', x: 1, z: 0 }, 'transform')?.message).toContain('character_move intent is valid only in the intent phase');
    expect(validateIntentPhase({ kind: 'character_place', position: [0, 0, 0] }, 'intent')).toBeNull();
  });
});
