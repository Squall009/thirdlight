/**
 * Phase 14.2: trigger shapes (`shape: box | circle`, a circle's `radius`) and
 * modes (`mode: enter | stay`) — validation and the canonical form (every new
 * field kept, an existing trigger's canonical bytes unchanged).
 */
import { describe, expect, it } from 'vitest';

import { BLOCK_COMPONENTS, TRIGGER_RADIUS, type TriggerComponent } from './index';
import type { ModelErrorV2 } from './errors';

const check = (value: unknown): string[] => {
  const errors: ModelErrorV2[] = [];
  BLOCK_COMPONENTS.trigger.validate(value, '/t', errors);
  return errors.map((e) => `${e.code} ${e.path}`);
};

describe('trigger component (phase 14.2)', () => {
  it('accepts boxes as before and circles with a radius; modes enter and stay', () => {
    expect(check({ size: [2, 2], signal: 'go' })).toEqual([]);
    expect(check({ size: [2, 2], signal: 'go', shape: 'box', mode: 'stay', once: true, exitSignal: 'left' })).toEqual([]);
    expect(check({ shape: 'circle', radius: 1.5, signal: 'go', mode: 'enter' })).toEqual([]);
    expect(check({ shape: 'circle', radius: TRIGGER_RADIUS.min, signal: 'go' })).toEqual([]);
    expect(check({ shape: 'circle', radius: TRIGGER_RADIUS.max, signal: 'go' })).toEqual([]);
  });

  it('refuses a circle without a radius or with a size, a box with a radius, bad shapes, modes and radii', () => {
    expect(check({ shape: 'circle', signal: 'go' })).toEqual(['field_missing /t/radius']);
    expect(check({ shape: 'circle', radius: 1, size: [1, 1], signal: 'go' })).toEqual(['field_unexpected /t/size']);
    expect(check({ size: [1, 1], radius: 1, signal: 'go' })).toEqual(['field_unexpected /t/radius']);
    expect(check({ radius: 1, signal: 'go' })).toEqual(['field_missing /t/size', 'field_unexpected /t/radius']);
    expect(check({ shape: 'cone', size: [1, 1], signal: 'go' })).toEqual(['field_value /t/shape']);
    expect(check({ size: [1, 1], signal: 'go', mode: 'exit' })).toEqual(['field_value /t/mode']);
    expect(check({ shape: 'circle', radius: 0, signal: 'go' })).toEqual(['field_value /t/radius']);
    expect(check({ shape: 'circle', radius: 251, signal: 'go' })).toEqual(['field_value /t/radius']);
  });

  it('the canonical form keeps every field, the new ones last; an old trigger is unchanged', () => {
    const canonical = BLOCK_COMPONENTS.trigger.canonical;
    const old: TriggerComponent = { exitSignal: 'out', once: true, signal: 'in', size: [1, 2] };
    expect(JSON.stringify(canonical(old))).toBe('{"size":[1,2],"signal":"in","once":true,"exitSignal":"out"}');
    const circle = { mode: 'stay', radius: 2, shape: 'circle', signal: 'in' } as TriggerComponent;
    expect(JSON.stringify(canonical(circle))).toBe('{"signal":"in","shape":"circle","radius":2,"mode":"stay"}');
    expect(BLOCK_COMPONENTS.trigger.fields).toEqual(['size', 'signal', 'once', 'exitSignal', 'shape', 'radius', 'mode', 'height']);
  });
});
