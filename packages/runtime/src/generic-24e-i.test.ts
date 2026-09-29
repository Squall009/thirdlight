/**
 * Generic gameplay pieces on their own: triggers (enter/exit events and a
 * scene transition per entry), a switch's configurable action (on the 2D
 * plane too, in the one step path every game runs),
 * velocity face-movement (the yaw of the motion, in 3D too) and a spawn's
 * yaw, the event → cue log, look overrides (set, clear, a new run, the save
 * section) and the track camera rig (offset, dead zone, damping, bounds).
 */
import { describe, expect, it } from 'vitest';
import type { EntityV3 } from '@thirdlight/project-model';

import { GameplayBlocks, type BlocksHost, type SceneTransitionRequest } from './blocks';
import { CameraBrain, type CameraWorld } from './camera-brain';
import { entityLookOf } from './primitives';
import type { TransformState } from './types';

const HZ = 120;
const T = (x: number, y: number, z = 0) => ({ position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const ent = (id: string, components: Record<string, unknown>, parentId?: string, at = T(0, 0)): EntityV3 => ({ id, ...(parentId !== undefined ? { parentId } : {}), components: { transform: at, ...components } }) as unknown as EntityV3;
const frame = (actions: Record<string, { p: string; v: number }> = {}) => ({ stepIndex: 0, moveX: 0, jump: 'none' as const, actions }) as never;

function harness(entities: EntityV3[], o: { dim3?: boolean } = {}) {
  const curr = new Map<string, TransformState>();
  for (const e of entities) {
    const t = e.components.transform;
    curr.set(e.id, { position: [...t.position] as [number, number, number], rotation: [...t.rotation] as [number, number, number, number], scale: [...t.scale] as [number, number, number] });
  }
  const transitions: { trigger: string; t: SceneTransitionRequest }[] = [];
  const host: BlocksHost = {
    hz: HZ,
    physics: undefined,
    curr,
    characterId: 'actor',
    characterCapsule: { radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0 } },
    character: () => {
      const t = curr.get('actor');
      return t === undefined ? null : { x: t.position[0], y: t.position[1] };
    },
    groundEntityId: () => null,
    sceneTransition: (trigger, t) => void transitions.push({ trigger, t }),
    ...(o.dim3 === true ? { physics3d: {} as never, character3: () => [...curr.get('actor')!.position] as [number, number, number] } : {}),
  };
  const blocks = new GameplayBlocks(host, entities);
  let i = 0;
  const move = (id: string, dx: number, dy = 0, dz = 0): void => {
    const p = curr.get(id)!.position;
    p[0] += dx;
    p[1] += dy;
    p[2] += dz;
  };
  const generic = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      i += 1;
      blocks.beforeStep(i);
      blocks.afterPhysics(frame());
    }
  };
  const yawOf = (id: string): number => {
    const q = curr.get(id)!.rotation;
    return (2 * Math.atan2(q[1]!, q[3]!) * 180) / Math.PI;
  };
  return { blocks, curr, transitions, move, generic, yawOf, frameAt: () => i };
}

describe('triggers', () => {
  it('the character entering and leaving a 2D trigger: enter/exit events, its signal, one transition per entry (once: the first only)', () => {
    const door = ent('door-0001', { trigger: { size: [1, 2], signal: 'door', sceneTransition: { scene: 'scene-b', spawn: 'spawn-b', unload: ['scene-a'] } } }, undefined, T(3, 1));
    const once = ent('gate-0001', { trigger: { size: [1, 2], signal: 'gate', once: true, sceneTransition: { scene: 'scene-c' } } }, undefined, T(10, 1));
    const h = harness([ent('actor', { controller: {} }, undefined, T(0, 1)), door, once]);
    h.generic();
    expect(h.transitions).toEqual([]);
    h.move('actor', 3);
    h.generic();
    expect(h.transitions).toEqual([{ trigger: 'door-0001', t: { scene: 'scene-b', spawn: 'spawn-b', unload: ['scene-a'] } }]);
    h.generic(); // staying inside: no second transition
    expect(h.transitions.length).toBe(1);
    h.move('actor', -3);
    h.generic();
    h.move('actor', 3);
    h.generic();
    expect(h.transitions.length).toBe(2); // a second entry
    h.move('actor', 7);
    h.generic();
    h.move('actor', -7);
    h.generic();
    h.move('actor', 7);
    h.generic();
    // Back through the door (a third entry), then the gate again: none (once).
    expect(h.transitions.map((t) => t.trigger)).toEqual(['door-0001', 'door-0001', 'gate-0001', 'door-0001']);
  });

  it('reports enter and exit events', () => {
    const h = harness([ent('actor', { controller: {} }, undefined, T(0, 1)), ent('zone-0001', { trigger: { shape: 'circle', radius: 0.5, signal: 'in', exitSignal: 'out' } }, undefined, T(1, 1))]);
    h.generic();
    h.move('actor', 1);
    h.generic();
    h.generic();
    expect(h.blocks.triggerEvents().map((e) => [e.type, e.trigger])).toEqual([['enter', 'zone-0001']]);
    expect(h.blocks.signaled('in')).toBe(true);
    h.move('actor', 5);
    h.generic();
    h.generic();
    expect(h.blocks.triggerEvents().map((e) => [e.type, e.trigger])).toEqual([['exit', 'zone-0001']]);
    expect(h.blocks.signaled('out')).toBe(true);
  });
});

describe('a switch reads its action', () => {
  it('an interact switch fires on its own action (default: interact)', () => {
    const h = harness([ent('actor', { controller: {} }, undefined, T(0, 1)), ent('lever-a', { switch: { mode: 'interact', signal: 'a', size: [2, 2], action: 'use' } }, undefined, T(0, 1)), ent('lever-b', { switch: { mode: 'interact', signal: 'b', size: [2, 2] } }, undefined, T(0, 1))]);
    const step = (actions: Record<string, { p: string; v: number }>): void => {
      h.blocks.beforeStep(h.frameAt() + 1);
      h.blocks.afterPhysics(frame(actions));
      h.blocks.beforeStep(h.frameAt() + 2);
    };
    step({ interact: { p: 'pressed', v: 1 } });
    expect([h.blocks.signaled('a'), h.blocks.signaled('b')]).toEqual([false, true]);
    step({ use: { p: 'pressed', v: 1 } });
    expect([h.blocks.signaled('a'), h.blocks.signaled('b')]).toEqual([true, false]);
  });

  it('switches run on the 2D plane without a game session — stand (on entry, once) and interact (only inside)', () => {
    const h = harness([
      ent('actor', { controller: {} }, undefined, T(0, 1)),
      ent('plate', { switch: { mode: 'stand', signal: 'plate', size: [1, 2] } }, undefined, T(3, 1)),
      ent('lever', { switch: { mode: 'interact', signal: 'lever', size: [1, 2], once: true } }, undefined, T(6, 1)),
    ]);
    const signals = (actions: Record<string, { p: string; v: number }> = {}): string[] => {
      h.blocks.beforeStep(h.frameAt() + 1);
      h.blocks.afterPhysics(frame(actions));
      h.blocks.beforeStep(h.frameAt() + 2);
      return ['plate', 'lever'].filter((n) => h.blocks.signaled(n));
    };
    const press = { interact: { p: 'pressed', v: 1 } };
    expect(signals(press)).toEqual([]); // outside both: pressing does nothing
    h.move('actor', 3);
    expect(signals()).toEqual(['plate']); // stepping on the plate
    expect(signals()).toEqual([]); // standing on it: once per entry
    h.move('actor', 3);
    expect(signals()).toEqual([]); // at the lever, not pressing
    expect(signals(press)).toEqual(['lever']);
    expect(signals(press)).toEqual([]); // once: spent
    h.move('actor', -3);
    expect(signals()).toEqual(['plate']); // a second entry
  });
});

describe('face velocity and a spawn yaw', () => {
  it('a velocity model faces the horizontal motion of its parent (2D: ±90°), turning at a half turn per turnSeconds', () => {
    const h = harness([ent('actor', { controller: {} }, undefined, T(0, 1)), ent('look', { faceMovement: { mode: 'velocity', turnSeconds: 0.5 } }, 'actor')]);
    h.generic();
    for (let k = 0; k < 120; k++) {
      h.move('actor', 0.05);
      h.generic();
    }
    expect(h.yawOf('look')).toBeCloseTo(90, 6);
    // Turning back to −X takes a half turn in 0.5 s: after 0.25 s it is half way (0° or 180°; here through 0).
    for (let k = 0; k < 30; k++) {
      h.move('actor', -0.05);
      h.generic();
    }
    expect(Math.abs(h.yawOf('look'))).toBeLessThan(90);
    for (let k = 0; k < 60; k++) {
      h.move('actor', -0.05);
      h.generic();
    }
    expect(h.yawOf('look')).toBeCloseTo(-90, 6);
    // Standing keeps the yaw.
    h.generic(10);
    expect(h.yawOf('look')).toBeCloseTo(-90, 6);
    // A spawn yaw (radians) turns it at once (plus its offset).
    h.blocks.faceSpawn('actor', Math.PI);
    expect(Math.abs(h.yawOf('look'))).toBeCloseTo(180, 6);
  });

  it('in 3D: any direction on the ground, with an offset; a top-level model faces its own motion', () => {
    const h = harness([ent('actor', { controller: {} }, undefined, T(0, 1)), ent('drone', { faceMovement: { mode: 'velocity', turnSeconds: 0, yawOffset: 90 } }, undefined, T(5, 1))], { dim3: true });
    h.generic();
    h.move('drone', 0, 0, 0.1); // along +Z: yaw 0, plus the 90° offset
    h.generic();
    expect(h.yawOf('drone')).toBeCloseTo(90, 6);
    h.move('drone', -0.1, 0, -0.1); // toward −X −Z: atan2(−1, −1) = −135°, + 90 = −45°
    h.generic();
    expect(h.yawOf('drone')).toBeCloseTo(-45, 6);
  });

  it('a two-sided model reads as a velocity facer (offset yawRight − 90°); a spawn yaw (radians) turns it at once', () => {
    const h = harness([
      ent('actor', { controller: {} }, undefined, T(0, 1)),
      ent('look', { faceMovement: { yawRight: 90, yawLeft: -90 } }, 'actor'),
      ent('tilted', { faceMovement: { yawRight: 120, yawLeft: -120 } }, 'actor'),
    ]);
    // A spawn yaw is the yaw itself plus the offset (not snapped to a side).
    h.blocks.faceSpawn('actor', -Math.PI / 2);
    expect(h.yawOf('look')).toBeCloseTo(-90, 6);
    expect(h.yawOf('tilted')).toBeCloseTo(-60, 6);
    h.blocks.faceSpawn('actor', Math.PI / 3);
    expect(h.yawOf('look')).toBeCloseTo(60, 6);
    expect(h.yawOf('tilted')).toBeCloseTo(90, 6);
    // It turns with the motion now (default turnSeconds 0.12 s: a half turn in 15 steps at 120 Hz).
    h.generic();
    for (let k = 0; k < 30; k++) {
      h.move('actor', -0.05);
      h.generic();
    }
    expect(h.yawOf('look')).toBeCloseTo(-90, 6);
    expect(h.yawOf('tilted')).toBeCloseTo(-60, 6); // −X plus the 30° offset (yawLeft is not read)
    for (let k = 0; k < 30; k++) {
      h.move('actor', 0.05);
      h.generic();
    }
    expect(h.yawOf('look')).toBeCloseTo(90, 6);
    expect(h.yawOf('tilted')).toBeCloseTo(120, 6); // +X faces yawRight
  });
});

describe('the event → cue log', () => {
  it('notes signals and trigger/primitive events only once enabled, and hands each over once', () => {
    const h = harness([ent('actor', { controller: {} }, undefined, T(0, 1)), ent('zone-0001', { trigger: { size: [1, 2], signal: 'in' } }, undefined, T(0, 1)), ent('crate', { health: { max: 3 } })]);
    h.generic();
    expect(h.blocks.takeCueLog()).toBeNull();
    h.blocks.enableCueLog();
    h.blocks.primitives.damage('crate', 1, 'test');
    h.blocks.emit('go');
    h.move('actor', 5);
    h.generic();
    h.move('actor', -5);
    h.generic();
    const log = h.blocks.takeCueLog()!;
    expect(log.signals).toEqual(['go', 'in']);
    expect(log.events).toEqual([
      { name: 'damaged', entity: 'crate' },
      { name: 'exit', entity: 'zone-0001' },
      { name: 'enter', entity: 'zone-0001' },
    ]);
    expect(h.blocks.takeCueLog()).toBeNull();
  });
});

describe('look overrides', () => {
  it('validates, sets, clears, resets with a new run and travels in the components save section', () => {
    const h = harness([ent('actor', { controller: {} }, undefined, T(0, 1)), ent('lamp', { box: { size: [1, 1, 1] } })]);
    const p = h.blocks.primitives;
    expect(entityLookOf({ emissive: '#FF0000' })).toEqual({ emissive: '#ff0000' });
    expect(entityLookOf({})).toBeNull();
    expect(entityLookOf({ emissive: 'red' })).toBeNull();
    expect(entityLookOf({ emissiveIntensity: 5 })).toBeNull();
    expect(entityLookOf({ tint: '#00ff00', glow: 1 })).toBeNull();
    const v0 = p.lookVersion;
    expect(p.setLook('lamp', { emissive: '#ff8800', emissiveIntensity: 2 })).toBe(true);
    expect(p.setLook('nothing', { tint: '#ffffff' })).toBe(false);
    expect(p.lookOf('lamp')).toEqual({ emissive: '#ff8800', emissiveIntensity: 2 });
    expect(p.lookVersion).toBeGreaterThan(v0);
    // set replaces the whole override
    expect(p.setLook('lamp', { tint: '#80ff80' })).toBe(true);
    expect(p.lookOf('lamp')).toEqual({ tint: '#80ff80' });
    const saved = p.saveState();
    expect(saved.look).toEqual({ lamp: { tint: '#80ff80' } });
    expect(p.checkState(saved)).toBeNull();
    expect(p.checkState({ look: { lamp: { tint: 'green' } } })).not.toBeNull();
    expect(p.clearLook('lamp')).toBe(true);
    expect(p.clearLook('lamp')).toBe(false);
    p.restoreState(saved);
    expect(p.lookOf('lamp')).toEqual({ tint: '#80ff80' });
    p.resetRun();
    expect(p.looksView().size).toBe(0);
    p.setLook('lamp', { emissive: '#ffffff' });
    h.blocks.remove(new Set(['lamp']));
    expect(p.looksView().size).toBe(0);
  });
});

describe('the track camera rig', () => {
  const world = (pos: Record<string, number[]>): CameraWorld => ({
    worldOf: (id, p, r) => {
      const at = pos[id];
      if (at === undefined) return false;
      [p[0], p[1], p[2]] = [at[0]!, at[1]!, at[2]!];
      [r[0], r[1], r[2], r[3]] = [0, 0, 0, 1];
      return true;
    },
  });
  const BASE = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
  it('keeps its placed rotation and offset, moves only past the dead zone, lags by damping, stays in bounds', () => {
    const b = new CameraBrain(HZ, { fovY: 60, near: 0.1, far: 100 });
    b.add([{ id: 'cam', components: { virtualCamera: { rig: 'track', target: 'hero', deadZone: [2, 1, 0], boundsMin: [-100, 0, -100], boundsMax: [5, 100, 100] } } }]);
    const pos: Record<string, number[]> = { cam: [0, 3, 12], hero: [0, 1, 0] };
    b.step(BASE, null, world(pos));
    // Framed as placed: the offset (0, 2, 12) from the hero.
    expect(b.view().position).toEqual([0, 3, 12]);
    // Inside the dead zone (1 m either side in x): no move.
    pos['hero'] = [0.9, 1, 0];
    b.step(BASE, null, world(pos));
    expect(b.view().position[0]).toBeCloseTo(0, 12);
    // Past it: the framed point follows the overflow (rigid without damping).
    pos['hero'] = [3, 1, 0];
    b.step(BASE, null, world(pos));
    expect(b.view().position[0]).toBeCloseTo(2, 12);
    // Bounds: the framed point stops at x = 5.
    pos['hero'] = [20, 1, 0];
    b.step(BASE, null, world(pos));
    expect(b.view().position[0]).toBeCloseTo(5, 12);
    // z has no dead zone (0): it follows at once; the rotation stays as placed.
    pos['hero'] = [20, 1, -4];
    b.step(BASE, null, world(pos));
    expect(b.view().position[2]).toBeCloseTo(8, 12);
    expect(b.view().rotation).toEqual([0, 0, 0, 1]);
  });
  it('damping eases toward the target; an authored offset wins over the placement', () => {
    const b = new CameraBrain(HZ, { fovY: 60, near: 0.1, far: 100 });
    b.add([{ id: 'cam', components: { virtualCamera: { rig: 'track', target: 'hero', trackOffset: [0, 0, 10], damping: 0.5 } } }]);
    const pos: Record<string, number[]> = { cam: [50, 50, 50], hero: [0, 0, 0] };
    b.step(BASE, null, world(pos));
    expect(b.view().position).toEqual([0, 0, 10]);
    pos['hero'] = [4, 0, 0];
    b.step(BASE, null, world(pos));
    const x1 = b.view().position[0];
    expect(x1).toBeGreaterThan(0);
    expect(x1).toBeLessThan(0.1);
    for (let k = 0; k < 600; k++) b.step(BASE, null, world(pos));
    expect(b.view().position[0]).toBeCloseTo(4, 3);
  });
});
