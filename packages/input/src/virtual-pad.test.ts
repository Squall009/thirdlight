/**
 * The virtual standard gamepad read through the bindings — a
 * button bound to an action gives pressed then held then released, a stick
 * gives a 2D axis past its dead zone, a hold binding counts after its time,
 * and the D-pad, A, B and start give menu edges on a fresh press.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_INPUT_CONFIG_3D, type InputConfigLike } from './actions';
import { createVirtualPad } from './virtual-pad';

const CONFIG: InputConfigLike = {
  actions: [
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'gamepadButton', button: 0 }] },
    { name: 'interact', type: 'button', map: 'gameplay', bindings: [{ kind: 'gamepadButton', button: 3, hold: 0.5 }] },
    { name: 'move', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'gamepadStick', x: 0, y: 1 }] },
  ],
};

describe('virtual gamepad', () => {
  it('buttons give pressed, held and released; a stick a 2D axis (y up); rest gives nothing', () => {
    const pad = createVirtualPad(CONFIG, 1000 / 60);
    expect(pad.step(null).actions).toEqual({});
    const a = pad.step({ buttons: [1], axes: [1, -1] });
    expect(a.actions['jump']).toEqual({ v: 1, p: 'pressed' });
    expect(a.actions['move']!.x).toBeGreaterThan(0.6);
    expect(a.actions['move']!.y).toBeGreaterThan(0.6);
    expect(pad.step({ buttons: [0.7] }).actions['jump']).toEqual({ v: 1, p: 'held' });
    expect(pad.step({ buttons: [0.2] }).actions['jump']).toEqual({ v: 0, p: 'released' });
    expect(pad.step({ axes: [0.1, 0] }).actions['move']).toBeUndefined();
  });

  it('a hold binding counts once held its time (steps of the given length)', () => {
    const pad = createVirtualPad(CONFIG, 100);
    const held = Array.from({ length: 7 }, () => pad.step({ buttons: [0, 0, 0, 1] }).actions['interact']?.v ?? 0);
    expect(held).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });

  it('the D-pad, the left stick, A, B and start give menu edges on a fresh press', () => {
    const pad = createVirtualPad(DEFAULT_INPUT_CONFIG_3D, 1000 / 120);
    const down = [];
    down[13] = 1;
    expect(pad.step({ buttons: down }).ui).toEqual(['down']);
    expect(pad.step({ buttons: down }).ui).toEqual([]);
    expect(pad.step({ axes: [0, -0.9] }).ui).toEqual(['up']);
    expect(pad.step({ buttons: [1, 1] }).ui).toEqual(['submit', 'cancel']);
    const start = [];
    start[9] = 1;
    expect(pad.step({ buttons: start }).ui).toEqual(['pause']);
  });
});
