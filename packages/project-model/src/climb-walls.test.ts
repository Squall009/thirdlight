/** Climb volumes, gravity bodies and the controller's climb and wall fields in the model. */
import { describe, expect, it } from 'vitest';

import { canonicalController, character3DSettingsOf, controllerMovementOf, validateControllerComponent } from './components';
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

describe('climb volumes and wall moves in the model', () => {
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

  it('the movement profile: character by default; arcade steps up by autostep, keeps its ground snap and does not turn', () => {
    const errors: ModelErrorV2[] = [];
    validateControllerComponent({ profile: 'runner' }, '/c', errors, 4);
    expect(errors.map((e) => e.path)).toEqual(['/c/profile']);
    const settings = { run_speed: 6.75, jump_velocity: 9.9, gravity_y: -19.62, max_fall_speed: -24, max_slope_climb_deg: 45 };
    const character = character3DSettingsOf({}, settings);
    expect([character.profile, character.stepHeight, character.groundSnap, character.faceMovement]).toEqual(['character', 0.3, 0.3, true]);
    const arcade = character3DSettingsOf({ profile: 'arcade' }, settings);
    expect([arcade.profile, arcade.stepHeight, arcade.groundSnap, arcade.faceMovement]).toEqual(['arcade', 0, 0.1, false]);
    const stepping = character3DSettingsOf({ profile: 'arcade', autostep: true, autostepHeight: 0.25, stepHeight: 0.5, faceMovement: true }, settings);
    expect([stepping.stepHeight, stepping.groundSnap, stepping.faceMovement]).toEqual([0.25, 0.1, true]);
    expect(Object.keys(canonicalController({ profile: 'arcade', moveAction: 'walk', moveFrame: 'world' }))).toEqual(['moveFrame', 'profile', 'moveAction']);
  });
});
