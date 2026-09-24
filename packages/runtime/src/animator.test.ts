/**
 * Phase 9.7: the animator state machine — transitions, conditions, exit
 * time, crossfade and blend weights, triggers and clip events.
 */
import { describe, expect, it } from 'vitest';

import { AnimatorMachine, type AnimatorControllerLike } from './animator';

const clip = (name: string, duration = 1) => ({ assetId: 'asset-0001', clip: name, duration });
const DT = 1 / 60;

function controller(extra: Partial<AnimatorControllerLike> = {}): AnimatorControllerLike {
  return {
    controllerId: 'player',
    parameters: [
      { name: 'speed', type: 'float', default: 0 },
      { name: 'grounded', type: 'bool', default: true },
      { name: 'jump', type: 'trigger' },
    ],
    states: [
      { id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: clip('idle', 2) }, speed: 1, loop: true },
      { id: 'run', name: 'Run', motion: { kind: 'clip', clip: clip('run', 0.5) }, speed: 1, loop: true },
      { id: 'jump', name: 'Jump', motion: { kind: 'clip', clip: clip('jump', 0.3) }, speed: 1, loop: false },
      { id: 'fall', name: 'Fall', motion: { kind: 'clip', clip: clip('fall', 0.6) }, speed: 1, loop: true },
    ],
    transitions: [
      { from: 'idle', to: 'run', conditions: [{ parameter: 'speed', op: 'greater', value: 0.1 }], duration: 0.1 },
      { from: 'run', to: 'idle', conditions: [{ parameter: 'speed', op: 'less', value: 0.1 }], duration: 0.1 },
      { from: '*', to: 'jump', conditions: [{ parameter: 'jump', op: 'trigger' }], duration: 0 },
      { from: 'jump', to: 'fall', conditions: [], duration: 0.05, exitTime: 1 },
      { from: 'fall', to: 'idle', conditions: [{ parameter: 'grounded', op: 'true' }], duration: 0.1 },
    ],
    entry: 'idle',
    events: [],
    ...extra,
  };
}
const run = (m: AnimatorMachine, seconds: number) => {
  const events: string[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) events.push(...m.step(DT).map((e) => e.name));
  return events;
};
const weightOf = (m: AnimatorMachine, name: string) => m.pose().clips.filter((c) => c.clip === name).reduce((s, c) => s + c.weight, 0);

describe('animator state machine', () => {
  it('starts in the entry state and loops its clip', () => {
    const m = new AnimatorMachine(controller());
    expect(m.stateName()).toBe('Idle');
    run(m, 2.5);
    const idle = m.pose().clips[0]!;
    expect(idle.clip).toBe('idle');
    expect(idle.time).toBeCloseTo(0.5, 1);
  });

  it('crossfades on a condition: weights move from source to target over the duration', () => {
    const m = new AnimatorMachine(controller());
    m.set('speed', 3);
    m.step(DT); // the transition fires and the fade starts
    run(m, 0.05);
    expect(weightOf(m, 'idle')).toBeGreaterThan(0.3);
    expect(weightOf(m, 'run')).toBeGreaterThan(0.3);
    expect(weightOf(m, 'idle') + weightOf(m, 'run')).toBeCloseTo(1, 5);
    run(m, 0.1);
    expect(m.stateName()).toBe('Run');
    expect(weightOf(m, 'run')).toBeCloseTo(1, 5);
    m.set('speed', 0);
    run(m, 0.2);
    expect(m.stateName()).toBe('Idle');
  });

  it('fires a trigger once from any state, then leaves a non-looping state at its exit time', () => {
    const m = new AnimatorMachine(controller());
    m.set('grounded', false);
    expect(m.trigger('jump')).toBe(true);
    m.step(DT);
    expect(m.stateName()).toBe('Jump');
    expect(m.get('jump')).toBe(false); // consumed
    run(m, 0.25);
    expect(m.stateName()).toBe('Jump'); // exit time 1 = 0.3 s not reached yet
    run(m, 0.2);
    expect(m.stateName()).toBe('Fall');
    run(m, 1);
    expect(m.stateName()).toBe('Fall'); // not grounded
    m.set('grounded', true);
    run(m, 0.2);
    expect(m.stateName()).toBe('Idle');
  });

  it('ignores unknown parameters and wrong types; clamps ints', () => {
    const m = new AnimatorMachine(controller({ parameters: [...controller().parameters, { name: 'lives', type: 'int', default: 3 }] }), { lives: 2.7, nope: 1 });
    expect(m.get('lives')).toBe(2);
    expect(m.set('speed', true)).toBe(false);
    expect(m.set('grounded', 1)).toBe(false);
    expect(m.set('missing', 1)).toBe(false);
    expect(m.trigger('speed')).toBe(false);
  });

  it('blends a 1D tree by its parameter and keeps the clips in step', () => {
    const m = new AnimatorMachine(
      controller({
        states: [
          {
            id: 'move',
            name: 'Move',
            motion: { kind: 'blend1d', parameter: 'speed', children: [{ threshold: 0, clip: clip('walk', 1) }, { threshold: 4, clip: clip('run', 0.5) }] },
            speed: 1,
            loop: true,
          },
        ],
        transitions: [],
        entry: 'move',
      }),
    );
    m.set('speed', 1);
    expect(weightOf(m, 'walk')).toBeCloseTo(0.75, 5);
    expect(weightOf(m, 'run')).toBeCloseTo(0.25, 5);
    m.set('speed', 9);
    expect(weightOf(m, 'run')).toBeCloseTo(1, 5);
    m.set('speed', 2);
    run(m, 0.2);
    const [walk, runClip] = m.pose().clips;
    // Same normalized time in both clips.
    expect(walk!.time / 1).toBeCloseTo(runClip!.time / 0.5, 5);
  });

  it('scales playback by speed and a speed parameter', () => {
    const m = new AnimatorMachine(
      controller({
        parameters: [{ name: 'rate', type: 'float', default: 2 }],
        states: [{ id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: clip('idle', 4) }, speed: 0.5, speedParameter: 'rate', loop: true }],
        transitions: [],
        entry: 'idle',
      }),
    );
    run(m, 1);
    expect(m.pose().clips[0]!.time).toBeCloseTo(1, 1);
  });

  it('fires clip events each time a playing clip passes them (loops too)', () => {
    const m = new AnimatorMachine(controller({ events: [{ assetId: 'asset-0001', clip: 'idle', time: 0.5, name: 'step' }] }));
    expect(run(m, 0.4)).toEqual([]);
    expect(run(m, 0.2)).toEqual(['step']);
    expect(run(m, 2)).toEqual(['step']); // one more pass in the next loop (2 s clip)
  });

  it('is deterministic', () => {
    const a = new AnimatorMachine(controller());
    const b = new AnimatorMachine(controller());
    for (const m of [a, b]) {
      m.set('speed', 2);
      run(m, 0.37);
      m.trigger('jump');
      run(m, 0.91);
    }
    expect(a.pose()).toEqual(b.pose());
  });
});

describe('animator override layers (phase 14.6)', () => {
  /** Base: idle/run by speed. Layer "upper body" (mask spine, arm): empty until `attack`, then the attack clip once, back to empty. */
  const layered = (extra: Partial<AnimatorControllerLike['layers'] extends readonly (infer L)[] | undefined ? L : never> = {}): AnimatorControllerLike =>
    controller({
      parameters: [...controller().parameters, { name: 'attack', type: 'trigger' }, { name: 'aim', type: 'float', default: 1 }],
      layers: [
        {
          name: 'Upper body',
          mask: ['spine', 'arm'],
          weight: 1,
          states: [
            { id: 'none', name: 'None', motion: { kind: 'empty' }, speed: 1, loop: true },
            { id: 'attack', name: 'Attack', motion: { kind: 'clip', clip: clip('attack', 0.5) }, speed: 1, loop: false },
          ],
          transitions: [
            { from: 'none', to: 'attack', conditions: [{ parameter: 'attack', op: 'trigger' }], duration: 0 },
            { from: 'attack', to: 'none', conditions: [], duration: 0, exitTime: 1 },
          ],
          entry: 'none',
          ...extra,
        },
      ],
    });

  it('runs a second state machine beside the base layer and poses it with its mask and weight', () => {
    const m = new AnimatorMachine(layered());
    expect(m.layerCount()).toBe(2);
    m.set('speed', 3);
    run(m, 0.3);
    expect(m.stateName()).toBe('Run');
    expect(m.stateName(1)).toBe('None');
    let pose = m.pose();
    expect(pose.layers).toHaveLength(1);
    expect(pose.layers![0]).toMatchObject({ name: 'Upper body', mask: ['spine', 'arm'], weight: 1, state: 'None', clips: [] });
    // Attack with the upper body while running: the base keeps running.
    m.trigger('attack');
    m.step(DT);
    expect(m.stateName(1)).toBe('Attack');
    expect(m.stateName()).toBe('Run');
    expect(m.get('attack')).toBe(false);
    run(m, 0.25);
    pose = m.pose();
    expect(pose.clips.map((c) => c.clip)).toEqual(['run']);
    expect(pose.layers![0]!.clips.map((c) => c.clip)).toEqual(['attack']);
    expect(pose.layers![0]!.clips[0]!.time).toBeCloseTo(0.25 + DT, 2);
    // The attack plays once, then the layer is empty again (the base shows through).
    run(m, 0.35);
    expect(m.stateName(1)).toBe('None');
    expect(m.pose().layers![0]!.clips).toEqual([]);
    expect(m.stateName()).toBe('Run');
  });

  it('shares triggers: a trigger tested by both layers reaches both in the same step', () => {
    const c = layered();
    const both: AnimatorControllerLike = { ...c, transitions: [...c.transitions, { from: '*', to: 'jump', conditions: [{ parameter: 'attack', op: 'trigger' }], duration: 0 }] };
    const m = new AnimatorMachine(both);
    m.trigger('attack');
    m.step(DT);
    expect(m.stateName()).toBe('Jump');
    expect(m.stateName(1)).toBe('Attack');
    expect(m.get('attack')).toBe(false);
  });

  it('scales the layer weight by its weight parameter (clamped to 0–1) and fires no events at weight 0', () => {
    const c = layered({ weight: 0.5, weightParameter: 'aim', entry: 'attack', transitions: [] });
    const m = new AnimatorMachine({ ...c, events: [{ assetId: 'asset-0001', clip: 'attack', time: 0.1, name: 'hit' }] });
    expect(m.pose().layers![0]!.weight).toBeCloseTo(0.5, 6);
    m.set('aim', 4);
    expect(m.pose().layers![0]!.weight).toBe(1);
    m.set('aim', 0);
    expect(m.pose().layers![0]!.weight).toBe(0);
    expect(run(m, 0.2)).toEqual([]);
    const n = new AnimatorMachine({ ...c, events: [{ assetId: 'asset-0001', clip: 'attack', time: 0.1, name: 'hit' }] });
    expect(run(n, 0.2)).toEqual(['hit']);
  });

  it('crossfades a layer from empty: its clips ramp up from weight 0', () => {
    const m = new AnimatorMachine(layered({ transitions: [{ from: 'none', to: 'attack', conditions: [{ parameter: 'attack', op: 'trigger' }], duration: 0.2 }] }));
    m.trigger('attack');
    run(m, 0.1);
    const w = m.pose().layers![0]!.clips.reduce((s, x) => s + x.weight, 0);
    expect(w).toBeGreaterThan(0.3);
    expect(w).toBeLessThan(0.7);
    run(m, 0.2);
    expect(m.pose().layers![0]!.clips[0]!.weight).toBeCloseTo(1, 5);
  });

  it('a controller without layers poses exactly as before (no layers key)', () => {
    const m = new AnimatorMachine(controller());
    m.set('speed', 2);
    run(m, 0.5);
    expect(Object.keys(m.pose()).sort()).toEqual(['clips', 'state']);
    expect(m.layerCount()).toBe(1);
    expect(m.stateName(5)).toBe(m.stateName());
  });

  it('is deterministic with layers', () => {
    const a = new AnimatorMachine(layered());
    const b = new AnimatorMachine(layered());
    for (const m of [a, b]) {
      m.set('speed', 2);
      run(m, 0.37);
      m.trigger('attack');
      run(m, 0.21);
    }
    expect(a.pose()).toEqual(b.pose());
  });
});
