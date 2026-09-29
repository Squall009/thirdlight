/** Phase 25.12: the mover's signal fields and the gravity easing in the model. */
import { describe, expect, it } from 'vitest';

import { canonicalMover, validateMoverComponent, type MoverComponent } from './blocks';
import type { ModelErrorV2 } from './errors';

describe('the mover model (25.12 fields)', () => {
  const check = (v: Record<string, unknown>): ModelErrorV2[] => {
    const errors: ModelErrorV2[] = [];
    validateMoverComponent({ waypoints: [[1, 0, 0]], speed: 1, mode: 'once', ...v }, '/m', errors);
    return errors;
  };
  it('accepts the signals and the gravity easing; refuses one signal both starting and stopping it', () => {
    expect(check({ easing: 'gravity', stopOn: 'a', toggleOn: 'b', reverseOn: 'c', startOn: 'd' })).toEqual([]);
    expect(check({ startOn: 'a', reverseOn: 'a' })).toEqual([]);
    expect(check({ startOn: 'a', stopOn: 'a' }).map((e) => e.path)).toEqual(['/m/stopOn']);
    expect(check({ stopOn: 'a', toggleOn: 'a' }).map((e) => e.path)).toEqual(['/m/toggleOn']);
    expect(check({ stopOn: 'no spaces' }).map((e) => e.path)).toEqual(['/m/stopOn']);
    expect(check({ easing: 'bounce' }).map((e) => e.path)).toEqual(['/m/easing']);
  });
  it('the new fields come last in the canonical form (an existing mover keeps its bytes)', () => {
    const c = canonicalMover({ reverseOn: 'r', toggleOn: 't', stopOn: 's', active: false, maxPush: 5, startOn: 'g', waypoints: [[1, 0, 0]], speed: 1, mode: 'once' } as MoverComponent);
    expect(Object.keys(c)).toEqual(['waypoints', 'speed', 'mode', 'startOn', 'maxPush', 'active', 'stopOn', 'toggleOn', 'reverseOn']);
    expect(JSON.stringify(canonicalMover({ waypoints: [[1, 0, 0]], speed: 1, mode: 'once', startOn: 'g' }))).toBe('{"waypoints":[[1,0,0]],"speed":1,"mode":"once","startOn":"g"}');
  });
});
