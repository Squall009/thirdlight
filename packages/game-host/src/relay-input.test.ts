/**
 * The input exercise's frames — run length (a frame's first step
 * as written, the rest its continuation), neutral gaps, UI edges handed to
 * the page on a frame's first step, and the pointer through the UI hit test
 * (overUi, presses over the UI kept from the game, a click on release over
 * the same target).
 */
import { describe, expect, it } from 'vitest';

import { RelayActionSource, type RelayEffect } from './relay-input';
import { hitUiTargets, type UiHitTarget } from './ui-hit';

const physical = { sample: (i: number) => ({ stepIndex: i, actions: { move: { v: 1, p: 'held' as const } } }) };

function run(src: RelayActionSource, from: number, n: number): ReturnType<RelayActionSource['sample']>[] {
  return Array.from({ length: n }, (_, k) => src.sample(from + k));
}

describe('relay test frames (phase 25.15)', () => {
  it('a run holds its frame: pressed on the first step, held after; gaps are neutral; completion after the last run', () => {
    const src = new RelayActionSource(physical);
    let done: [number, number] | null = null;
    src.beginTest(
      [
        { stepOffset: 0, steps: 3, actions: { jump: { v: 1, p: 'pressed' }, move: { v: 0.5, p: 'none' } } },
        { stepOffset: 5, steps: 2, actions: { fire: { v: 1, p: 'released' } } },
      ],
      10,
      (a, b) => (done = [a, b]),
    );
    const out = run(src, 10, 8);
    expect(out[0]!.actions).toEqual({ jump: { v: 1, p: 'pressed' }, move: { v: 0.5, p: 'none' } });
    expect(out[1]!.actions).toEqual({ jump: { v: 1, p: 'held' }, move: { v: 0.5, p: 'none' } });
    expect(out[2]!.actions).toEqual({ jump: { v: 1, p: 'held' }, move: { v: 0.5, p: 'none' } });
    expect(out[3]).toEqual({ stepIndex: 13 });
    expect(out[4]).toEqual({ stepIndex: 14 });
    expect(out[5]!.actions).toEqual({ fire: { v: 1, p: 'released' } });
    expect(out[6]!.actions).toEqual({ fire: { v: 1, p: 'none' } });
    expect(done).toEqual([10, 16]);
    expect(src.testActive).toBe(false);
    // The physical source is back.
    expect(out[7]!.actions).toEqual({ move: { v: 1, p: 'held' } });
  });

  it('a run keeps the pointer where it is without its movement, wheel and edges; UI edges go to the page on the first step only', () => {
    const src = new RelayActionSource(physical);
    const effects: RelayEffect[] = [];
    src.setEffectSink((e) => effects.push(e));
    src.beginTest([{ stepOffset: 0, steps: 3, pointer: { x: 0.3, y: 0.4, dx: 0.1, buttons: 1, pressed: 1 }, ui: ['down', 'submit'] }], 0, () => undefined);
    const out = run(src, 0, 3);
    expect(out[0]!.pointer).toEqual({ x: 0.3, y: 0.4, dx: 0.1, buttons: 1, pressed: 1 });
    expect(out[1]!.pointer).toEqual({ x: 0.3, y: 0.4, buttons: 1 });
    expect(effects).toEqual([{ kind: 'ui', edges: ['down', 'submit'] }]);
  });

  it('the pointer over a UI target: overUi, the press and its release stay with the UI, a press and release on one target clicks it', () => {
    const targets: UiHitTarget[] = [{ key: 'sim:menu#3', rect: [0.4, 0.4, 0.2, 0.1] }, { key: 'sim:menu#backdrop', rect: [0, 0, 1, 1] }];
    const src = new RelayActionSource(physical);
    const effects: RelayEffect[] = [];
    src.setEffectSink((e) => effects.push(e));
    src.setUiHit((x, y) => hitUiTargets(targets, x, y)?.key ?? null);
    src.beginTest(
      [
        { stepOffset: 0, pointer: { x: 0.5, y: 0.45, buttons: 1 } },
        { stepOffset: 1, pointer: { x: 0.5, y: 0.45 } },
        // A click in one frame (pressed and released between samples) on a modal backdrop: taken by the UI (a click there does nothing).
        { stepOffset: 2, pointer: { x: 0.1, y: 0.1, pressed: 1, released: 1 } },
      ],
      0,
      () => undefined,
    );
    const out = run(src, 0, 3);
    expect(out[0]!.pointer).toEqual({ x: 0.5, y: 0.45, overUi: true });
    expect(out[1]!.pointer).toEqual({ x: 0.5, y: 0.45, overUi: true });
    expect(out[2]!.pointer).toEqual({ x: 0.1, y: 0.1, overUi: true });
    expect(effects).toEqual([{ kind: 'click', key: 'sim:menu#3' }, { kind: 'click', key: 'sim:menu#backdrop' }]);
  });

  it('a press over the game view stays with the game; releasing it over the UI still reaches the game', () => {
    const targets: UiHitTarget[] = [{ key: 'hud:hud#1', rect: [0.8, 0, 0.2, 0.1] }];
    const src = new RelayActionSource(physical);
    const effects: RelayEffect[] = [];
    src.setEffectSink((e) => effects.push(e));
    src.setUiHit((x, y) => hitUiTargets(targets, x, y)?.key ?? null);
    src.beginTest(
      [
        { stepOffset: 0, pointer: { x: 0.5, y: 0.5, buttons: 1 } },
        { stepOffset: 1, pointer: { x: 0.9, y: 0.05, buttons: 1 } },
        { stepOffset: 2, pointer: { x: 0.9, y: 0.05 } },
      ],
      0,
      () => undefined,
    );
    const out = run(src, 0, 3);
    expect(out[0]!.pointer).toEqual({ x: 0.5, y: 0.5, buttons: 1 });
    expect(out[1]!.pointer).toEqual({ x: 0.9, y: 0.05, buttons: 1, overUi: true });
    expect(out[2]!.pointer).toEqual({ x: 0.9, y: 0.05, overUi: true });
    expect(effects).toEqual([]);
  });

  it('frames of a paused game take steps\' places: UI edges still go to the page, the next step continues after them', () => {
    const src = new RelayActionSource(physical);
    const effects: RelayEffect[] = [];
    src.setEffectSink((e) => effects.push(e));
    let done: [number, number] | null = null;
    src.beginTest(
      [
        { stepOffset: 0, ui: ['pause'] },
        { stepOffset: 3, ui: ['submit'] },
        { stepOffset: 4, actions: { jump: { v: 1, p: 'pressed' } } },
      ],
      5,
      (a, b) => (done = [a, b]),
    );
    expect(src.sample(4)).toEqual({ stepIndex: 4 }); // the step before the first (the relay starts after it)
    src.sample(5); // offset 0: the pause edge
    src.idle(); // paused frames: offsets 1, 2, 3 (the submit edge)
    src.idle();
    src.idle();
    expect(effects).toEqual([{ kind: 'ui', edges: ['pause'] }, { kind: 'ui', edges: ['submit'] }]);
    expect(src.sample(6).actions).toEqual({ jump: { v: 1, p: 'pressed' } });
    expect(done).toEqual([5, 6]);
  });

  it('the hit test: topmost first, edges inclusive, nothing outside', () => {
    const targets: UiHitTarget[] = [{ key: 'a', rect: [0.1, 0.1, 0.2, 0.2] }, { key: 'b', rect: [0, 0, 0.5, 0.5] }];
    expect(hitUiTargets(targets, 0.2, 0.2)?.key).toBe('a');
    expect(hitUiTargets(targets, 0.4, 0.4)?.key).toBe('b');
    expect(hitUiTargets(targets, 0.3, 0.3)?.key).toBe('a');
    expect(hitUiTargets(targets, 0.6, 0.1)).toBeNull();
  });
});
