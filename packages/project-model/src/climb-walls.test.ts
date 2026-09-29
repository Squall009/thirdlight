/** Phase 25.13: climb volumes, gravity bodies and the controller's climb and wall fields in the model. */
import { describe, expect, it } from 'vitest';

import { canonicalController, controllerMovementOf, validateControllerComponent } from './components';
import type { ModelErrorV2 } from './errors';
import { validateSceneV4 } from './scene-v3';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (components: Record<string, unknown>) => ({
  schemaVersion: 4,
  sceneId: 'main',
  revision: 1,
  entities: [
    { id: 'spawn-0001', components: { transform: T, playerSpawn: {} } },
    { id: 'thing-0001', components: { transform: T, ...components } },
  ],
});
const codes = (components: Record<string, unknown>): string[] => {
  const r = validateSceneV4(scene(components));
  return r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`);
};

describe('phase 25.13 model', () => {
  it('a climb volume needs a size; a gravity body takes a scale and a body', () => {
    expect(codes({ climbVolume: { size: [1, 4] } })).toEqual([]);
    expect(codes({ climbVolume: { size: [1, 4, 1] } })).toEqual([]);
    expect(codes({ climbVolume: {} }).some((c) => c.includes('/climbVolume/size'))).toBe(true);
    expect(codes({ gravity: {} })).toEqual([]);
    expect(codes({ gravity: { scale: 2, size: [1, 1] } })).toEqual([]);
    expect(codes({ gravity: { scale: 11 } }).some((c) => c.includes('/gravity/scale'))).toBe(true);
  });

  it('a gravity body falls by itself: not with a mover, a collider or a waypoint patrol (an edge patrol may fall)', () => {
    expect(codes({ gravity: {}, patrol: { mode: 'edges', speed: 1 } })).toEqual([]);
    expect(codes({ gravity: {}, patrol: { mode: 'waypoints', waypoints: [[1, 0, 0]], speed: 1 } }).some((c) => c.startsWith('component_conflict') || c.includes('conflict'))).toBe(true);
    expect(codes({ gravity: {}, mover: { waypoints: [[1, 0, 0]], speed: 1, mode: 'once' } }).length).toBeGreaterThan(0);
  });

  it('the controller climb and wall fields: validated, defaulted (both wall abilities off), last in canonical order', () => {
    const errors: ModelErrorV2[] = [];
    validateControllerComponent({ climbSpeed: 0, wallSlide: 'yes', wallJumpAway: 60, climbAction: '1x' }, '/c', errors, 4);
    expect(errors.map((e) => e.path).sort()).toEqual(['/c/climbAction', '/c/climbSpeed', '/c/wallJumpAway', '/c/wallSlide']);
    expect(controllerMovementOf({})).toEqual({ climbSpeed: 2, climbAction: null, wallSlide: false, wallSlideSpeed: 2, wallJump: false, wallJumpAway: null, wallJumpUp: null, wallJumpLock: null });
    expect(Object.keys(canonicalController({ wallJump: true, climbSpeed: 3, moveAction: 'walk', skin: 0.02 }))).toEqual(['skin', 'moveAction', 'climbSpeed', 'wallJump']);
    expect(JSON.stringify(canonicalController({ skin: 0.02 }))).toBe('{"skin":0.02}');
  });
});
