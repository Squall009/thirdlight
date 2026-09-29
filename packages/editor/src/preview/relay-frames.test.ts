/**
 * Phase 25.15: the page resolves a relay's virtual gamepad through the
 * bindings, step by step: each step of a pad frame becomes its own frame (the
 * frame's own actions win), the pad is at rest in gaps and in frames without
 * one, frames without a pad pass through unchanged.
 */
import { describe, expect, it } from 'vitest';

import { resolveRelayFrames } from './relay-frames';

const CONFIG: Parameters<typeof resolveRelayFrames>[1] = {
  actions: [
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'gamepadButton', button: 0 }] },
    { name: 'fire', type: 'button', map: 'gameplay', bindings: [{ kind: 'gamepadButton', button: 7 }] },
  ],
};

describe('relay frames with a virtual gamepad (phase 25.15)', () => {
  it('passes frames without a pad through', () => {
    const frames = [{ stepOffset: 0, steps: 4, actions: { jump: { v: 1, p: 'pressed' as const } }, ui: ['submit'] }];
    expect(resolveRelayFrames(frames, CONFIG, 120)).toEqual(frames);
  });

  it('expands pad frames per step, keeps explicit actions over the pad, the pad at rest in gaps', () => {
    const out = resolveRelayFrames(
      [
        { stepOffset: 0, steps: 3, gamepad: { buttons: [1, 0, 0, 0, 0, 0, 0, 1] }, actions: { fire: { v: 0, p: 'none' } } },
        { stepOffset: 5, gamepad: { buttons: [1] }, ui: ['cancel'] },
        { stepOffset: 6, steps: 10, actions: { fire: { v: 1, p: 'held' } } },
      ],
      CONFIG,
      120,
    );
    expect(out.map((f) => f.stepOffset)).toEqual([0, 1, 2, 5, 6]);
    expect(out[0]!.actions).toEqual({ jump: { v: 1, p: 'pressed' }, fire: { v: 0, p: 'none' } });
    expect(out[1]!.actions).toEqual({ jump: { v: 1, p: 'held' }, fire: { v: 0, p: 'none' } });
    expect(out[0]!.ui).toEqual(['submit']);
    expect(out[1]!.ui).toBeUndefined();
    // After the gap (pad at rest) the button is a fresh press again; the frame's own ui first.
    expect(out[3]!.actions).toEqual({ jump: { v: 1, p: 'pressed' } });
    expect(out[3]!.ui).toEqual(['cancel', 'submit']);
    expect(out[4]).toEqual({ stepOffset: 6, steps: 10, actions: { fire: { v: 1, p: 'held' } } });
  });
});
