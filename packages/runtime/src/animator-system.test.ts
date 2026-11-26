/**
 * The animators of the loaded objects: start times (authored, or random
 * from the game's seed) and the script handle's play().
 */
import type { EntityV3 } from '@thirdlight/project-model';
import { describe, expect, it } from 'vitest';

import type { AnimatorControllerLike } from './animator';
import { AnimatorSystem } from './animator-system';

const CONTROLLER: AnimatorControllerLike = {
  controllerId: 'npc',
  parameters: [],
  states: [
    { id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: { assetId: 'asset-0001', clip: 'idle', duration: 2 } }, speed: 1, loop: true },
    { id: 'talk', name: 'Talk', motion: { kind: 'clip', clip: { assetId: 'asset-0001', clip: 'talk', duration: 4 } }, speed: 1, loop: true },
  ],
  transitions: [],
  entry: 'idle',
  events: [],
};

const entity = (id: string, animator: Record<string, unknown>): EntityV3 => ({ id, name: id, components: { transform: { position: [0, 0, 0] }, animator: { controller: 'npc', ...animator } } }) as unknown as EntityV3;

function system(seed: number, entities: EntityV3[]): AnimatorSystem {
  const s = new AnimatorSystem([CONTROLLER], { hz: 60, seed, characterIds: () => [], transformOf: () => undefined, grounded: () => true, inactive: () => new Set(), stepIndex: () => 0, rigOf: () => null, worldMatrix: () => false, warn: () => undefined });
  s.add(entities);
  return s;
}
const timeOf = (s: AnimatorSystem, id: string): number => s.poseOf(id)!.clips[0]!.time;

describe('animator start times', () => {
  it('an authored start time puts the entry state there', () => {
    const s = system(0, [entity('npc-a', { startTime: 0.25 })]);
    expect(timeOf(s, 'npc-a')).toBeCloseTo(0.5, 9);
  });

  it('random starts differ between copies, repeat with the seed and a reset, and change with another seed', () => {
    const ids = ['npc-a', 'npc-b', 'npc-c', 'npc-d'];
    const a = system(7, ids.map((id) => entity(id, { randomStart: true })));
    const times = ids.map((id) => timeOf(a, id));
    expect(new Set(times.map((t) => t.toFixed(6))).size).toBe(ids.length);
    for (const t of times) expect(t >= 0 && t < 2).toBe(true);
    // Same seed: the same starts (a replay, an export, the worker).
    const b = system(7, ids.map((id) => entity(id, { randomStart: true })));
    expect(ids.map((id) => timeOf(b, id))).toEqual(times);
    // A run restart starts them alike.
    for (let i = 0; i < 30; i++) a.step();
    a.reset();
    expect(ids.map((id) => timeOf(a, id))).toEqual(times);
    // Another seed: other starts.
    const c = system(8, ids.map((id) => entity(id, { randomStart: true })));
    expect(ids.map((id) => timeOf(c, id))).not.toEqual(times);
  });

  it("a player character's model animator gets its speed, grounding and vertical velocity each step: idle, run, airborne", () => {
    const clipState = (id: string, name: string): AnimatorControllerLike['states'][number] => ({ id, name, motion: { kind: 'clip', clip: { assetId: 'asset-0001', clip: id, duration: 1 } }, speed: 1, loop: true });
    const locomotion: AnimatorControllerLike = {
      controllerId: 'loco',
      parameters: [{ name: 'speed', type: 'float', default: 0 }, { name: 'grounded', type: 'bool', default: true }, { name: 'velocityY', type: 'float', default: 0 }],
      states: [clipState('idle', 'Idle'), clipState('run', 'Run'), clipState('air', 'Air')],
      transitions: [
        { from: '*', to: 'air', conditions: [{ parameter: 'grounded', op: 'false' }], duration: 0 },
        { from: 'idle', to: 'run', conditions: [{ parameter: 'speed', op: 'greater', value: 0.5 }], duration: 0 },
        { from: 'air', to: 'idle', conditions: [{ parameter: 'grounded', op: 'true' }], duration: 0 },
      ],
      entry: 'idle',
      events: [],
    };
    const pos: [number, number, number] = [0, 0, 0];
    let grounded = true;
    const s = new AnimatorSystem([locomotion], { hz: 60, seed: 0, characterIds: () => ['player'], transformOf: (id) => (id === 'player' ? { position: [...pos], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } : undefined), grounded: () => grounded, inactive: () => new Set(), stepIndex: () => 0, rigOf: () => null, worldMatrix: () => false, warn: () => undefined });
    // The model is a child of the player character, as on the starter player.
    s.add([{ id: 'player', name: 'player', components: { transform: { position: [0, 0, 0] } } } as unknown as EntityV3, { id: 'model', name: 'model', parentId: 'player', components: { transform: { position: [0, 0, 0] }, animator: { controller: 'loco' } } } as unknown as EntityV3]);
    const h = s.control.of('model')!;
    for (let i = 0; i < 5; i++) s.step();
    expect(h.state()).toBe('Idle');
    // 3 m/s on the ground: Run.
    for (let i = 0; i < 5; i++) {
      pos[0] += 3 / 60;
      s.step();
    }
    expect(h.state()).toBe('Run');
    expect(h.get('speed')).toBeCloseTo(3, 6);
    // Off the ground and rising.
    grounded = false;
    pos[1] += 0.1;
    s.step();
    expect(h.state()).toBe('Air');
    expect(h.get('grounded')).toBe(false);
    expect(h.get('velocityY')).toBeCloseTo(6, 6);
  });

  it('the script handle plays a state from a normalized time', () => {
    const s = system(0, [entity('npc-a', {})]);
    const h = s.control.of('npc-a')!;
    expect(h.play('Talk', 0, 0, 0.5)).toBe(true);
    expect(h.state()).toBe('Talk');
    expect(timeOf(s, 'npc-a')).toBeCloseTo(2, 9);
    expect(h.play('Talk', 0, 3)).toBe(false);
    expect(h.play('Nope')).toBe(false);
  });
});
