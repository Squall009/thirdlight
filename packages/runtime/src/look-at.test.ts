/**
 * The look-at constraint: angles toward the target in the model's space,
 * limits split over the chain, the turn speed, weight 0 turning back, and
 * the turn applied by the rig poser (the head ends facing the target).
 */
import type { EntityV3, ModelRig } from '@thirdlight/project-model';
import { describe, expect, it } from 'vitest';

import type { AnimatorControllerLike } from './animator';
import { AnimatorSystem } from './animator-system';
import { LookAtState, anglesToward } from './look-at';
import { RigPoser, composeMat4, mat4, type Mat4 } from './rig-pose';
import type { TransformState } from './types';

const RIG: ModelRig = {
  nodes: [
    { name: 'chest', parent: -1, t: [0, 1, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
    { name: 'head', parent: 0, t: [0, 0.5, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
  ],
  clips: [],
};
const CONTROLLER: AnimatorControllerLike = {
  controllerId: 'npc',
  parameters: [{ name: 'attention', type: 'float', default: 1 }],
  states: [{ id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: { assetId: 'asset-0001', clip: 'idle', duration: 1 } }, speed: 1, loop: true }],
  transitions: [],
  entry: 'idle',
  events: [],
};
const HZ = 60;
const DEG = Math.PI / 180;

function world(transforms: Map<string, TransformState>) {
  return (id: string, out: Mat4): boolean => {
    const t = transforms.get(id);
    if (t === undefined) return false;
    composeMat4(out, t.position, t.rotation, t.scale);
    return true;
  };
}

function setup(lookAt: Record<string, unknown>) {
  const transforms = new Map<string, TransformState>([
    ['npc', { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    // 60° to the npc's left of +Z (toward +X), level with the head.
    ['friend', { position: [5 * Math.sin(60 * DEG), 1.5, 5 * Math.cos(60 * DEG)], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
  ]);
  const poser = new RigPoser(RIG, 'asset-0001');
  const sys = new AnimatorSystem([CONTROLLER], { hz: HZ, seed: 0, characterIds: () => [], transformOf: (id) => transforms.get(id), grounded: () => true, inactive: () => new Set(), stepIndex: () => 0, rigOf: (id) => (id === 'npc' ? poser : null), worldMatrix: world(transforms), warn: () => undefined });
  sys.add([{ id: 'npc', name: 'npc', components: { transform: { position: [0, 0, 0] }, model: { asset: { assetId: 'asset-0001' } }, animator: { controller: 'npc', lookAt } } } as unknown as EntityV3]);
  /** The head's forward (+Z) as drawn by the rig poser: its yaw in degrees. */
  const headYaw = (): number => {
    const m = poser.nodeMatrix(1, sys.poseOf('npc'), mat4());
    return Math.atan2(m[8]!, m[10]!) / DEG;
  };
  const steps = (n: number) => {
    for (let i = 0; i < n; i++) sys.step();
  };
  return { sys, headYaw, steps };
}

describe('look-at', () => {
  it('measures yaw and pitch from +Z in the model space', () => {
    expect(anglesToward([0, 0, 0], [1, 0, 1])!.yaw).toBeCloseTo(45, 9);
    expect(anglesToward([0, 0, 0], [0, 1, 1])!.pitch).toBeCloseTo(45, 9);
    expect(anglesToward([0, 0, 0], [0, 0, 0])).toBeNull();
  });

  it('turns the head toward the target at the turn speed, splitting the turn over the chain', () => {
    const { sys, headYaw, steps } = setup({ head: { bone: 'head', yaw: 50, pitch: 30 }, chest: { bone: 'chest', yaw: 25, pitch: 10 }, target: 'friend', turnSpeed: 90 });
    steps(HZ / 2); // half a second at 90°/s: 45°
    expect(sys.poseOf('npc')!.look!.yaw).toBeCloseTo(45, 6);
    expect(headYaw()).toBeCloseTo(45, 6);
    steps(HZ); // the rest: it stops at the target's 60°
    expect(sys.poseOf('npc')!.look!.yaw).toBeCloseTo(60, 6);
    expect(headYaw()).toBeCloseTo(60, 6);
    // Split by the limits (50 : 25): the chest takes a third.
    const chest = sys.poseOf('npc')!.look!.bones[0]!;
    expect(chest.node).toBe('chest');
    expect(2 * Math.atan2(chest.rotation[1], chest.rotation[3]) / DEG).toBeCloseTo(20, 6);
    // Level with the head: no pitch.
    expect(sys.poseOf('npc')!.look!.pitch).toBeCloseTo(0, 6);
  });

  it('stops at the chain\'s limits and turns back at weight 0', () => {
    const { sys, headYaw, steps } = setup({ head: { bone: 'head', yaw: 40, pitch: 30 }, target: 'friend', turnSpeed: 120 });
    steps(HZ);
    expect(headYaw()).toBeCloseTo(40, 6);
    expect(sys.control.of('npc')!.setLookWeight(0)).toBe(true);
    steps(HZ / 4); // 30° back
    expect(headYaw()).toBeCloseTo(10, 6);
    steps(HZ);
    expect(sys.poseOf('npc')!.look).toBeUndefined();
    expect(headYaw()).toBeCloseTo(0, 9);
  });

  it('scripts set a point or no target; the weight parameter scales the turn', () => {
    const { sys, headYaw, steps } = setup({ head: { bone: 'head', yaw: 90, pitch: 30 }, weightParameter: 'attention', turnSpeed: 7200 });
    steps(2);
    expect(headYaw()).toBeCloseTo(0, 9); // nothing to look at
    const h = sys.control.of('npc')!;
    expect(h.setLookPoint([-5, 1.5, 0])).toBe(true);
    steps(2);
    expect(headYaw()).toBeCloseTo(-90, 6);
    h.set('attention', 0.5);
    steps(2);
    expect(headYaw()).toBeCloseTo(-45, 6);
    expect(h.setLookTarget(null)).toBe(true);
    steps(2);
    expect(headYaw()).toBeCloseTo(0, 9);
    expect(h.setLookWeight(2)).toBe(false);
  });

  it('the angles move as one step in yaw and pitch', () => {
    const s = new LookAtState({ head: { bone: 'h', yaw: 90, pitch: 90 }, turnSpeed: 50 });
    s.step({ yaw: 30, pitch: 40 }, 1, 0.2); // 10° along the way to (30, 40) (50° long)
    expect(s.yaw).toBeCloseTo(6, 9);
    expect(s.pitch).toBeCloseTo(8, 9);
  });
});
