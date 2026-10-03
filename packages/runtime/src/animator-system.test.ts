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
  const s = new AnimatorSystem([CONTROLLER], { hz: 60, seed, characterId: () => '', transformOf: () => undefined, grounded: () => true, inactive: () => new Set(), stepIndex: () => 0, rigOf: () => null, worldMatrix: () => false, warn: () => undefined });
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
