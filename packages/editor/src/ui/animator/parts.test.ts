/**
 * The animator controller the project window's Create makes from the chosen
 * model's clips: one looping state on the first clip (with a `speed`
 * parameter), or character locomotion picked from the clips' names; the name
 * typed in Create is the controller's; no clips, or no idle and run for
 * locomotion, is a reason instead of a controller.
 */
import { describe, expect, it } from 'vitest';

import { newAnimatorController } from './parts';

const CLIPS = [
  { name: 'Wave', duration: 1.5 },
  { name: 'Idle', duration: 2 },
  { name: 'Run_Fast', duration: 0.8 },
];

describe('newAnimatorController', () => {
  it('a plain controller is one looping state playing the model\'s first clip, under the name given', () => {
    const c = newAnimatorController(false, 'animator-01', 'My animator', 'model-a', CLIPS);
    if (typeof c === 'string') throw new Error(c);
    expect(c.controllerId).toBe('animator-01');
    expect(c.name).toBe('My animator');
    expect(c.parameters).toEqual([{ name: 'speed', type: 'float', default: 0 }]);
    expect(c.states).toEqual([{ id: 'state-01', name: 'Wave', motion: { kind: 'clip', clip: { assetId: 'model-a', clip: 'Wave', duration: 1.5 } }, speed: 1, loop: true, position: [180, 40] }]);
    expect(c.entry).toBe('state-01');
    expect(c.transitions).toEqual([]);
  });

  it('a zero-length first clip still gets a positive duration', () => {
    const c = newAnimatorController(false, 'a', 'A', 'model-a', [{ name: 'Pose', duration: 0 }]);
    if (typeof c === 'string') throw new Error(c);
    expect(c.states[0]!.motion).toEqual({ kind: 'clip', clip: { assetId: 'model-a', clip: 'Pose', duration: 0.001 } });
  });

  it('locomotion picks idle and run by name (a name containing it when none is exact), under the name given', () => {
    const c = newAnimatorController(true, 'loco', 'Hero moves', 'model-a', CLIPS);
    if (typeof c === 'string') throw new Error(c);
    expect(c.name).toBe('Hero moves');
    expect(c.entry).toBe('idle');
    expect(c.states.map((s) => [s.id, s.motion.kind === 'clip' ? s.motion.clip.clip : null])).toEqual([['idle', 'Idle'], ['run', 'Run_Fast']]);
    expect(c.parameters.map((p) => p.name)).toEqual(['speed', 'grounded', 'velocityY', 'landed']);
  });

  it('answers why when there is nothing to build from', () => {
    expect(newAnimatorController(false, 'a', 'A', 'model-a', [])).toContain('no animation clips');
    expect(newAnimatorController(true, 'a', 'A', 'model-a', [])).toContain('no animation clips');
    expect(newAnimatorController(true, 'a', 'A', 'model-a', [{ name: 'Wave', duration: 1 }])).toContain('an idle and a run');
  });
});
