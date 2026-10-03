/**
 * Several player characters in one world (local co-op), on both ports (real
 * Rapier WASM). Each character sweeps its own staged move in the same step
 * and keeps its own grounding; characters never block each other (one walks
 * through the other) nor any query; placement, clearance and drop-through
 * name the character; a world with one character steps exactly as before.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMoveResult, CharacterMoveResult3D, PhysicsInitConfig3D } from '@thirdlight/runtime';

import { createPhysicsPort3D } from './3d/index';
import { createPhysicsPort } from './index';
import type { RapierPhysicsInitConfig, RapierPhysicsPort, RapierStaticColliderSpec } from './types';

const HZ = 120;
const DT = 1 / HZ;
const G = -19.62;
const RAD = (deg: number): number => (deg * Math.PI) / 180;
const CONTROLLER = { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: RAD(45), minSlopeSlideRad: RAD(30), autostep: false };

const box2 = (entityId: string, hx: number, hy: number, x: number, y: number, extra: Partial<RapierStaticColliderSpec> = {}): RapierStaticColliderSpec => ({ entityId, shape: { type: 'box', hx, hy }, position: { x, y }, rotationZ: 0, ...extra });

async function port2(extra: RapierPhysicsInitConfig['characters'], statics = [box2('floor', 20, 0.25, 0, -0.25)]): Promise<RapierPhysicsPort> {
  const r = await createPhysicsPort({ character: { x: -2, y: 1 }, ...(extra !== undefined ? { characters: extra } : {}), statics, solver: { hz: HZ, gravityY: G }, controller: CONTROLLER });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.port;
}

/** Steps with gravity for each character and its own walk speed (m/s); the last results by character ('' the first). */
function walk2(p: RapierPhysicsPort, speeds: Record<string, number>, steps: number): Record<string, CharacterMoveResult> {
  const vy: Record<string, number> = {};
  const last: Record<string, CharacterMoveResult> = {};
  for (let i = 0; i < steps; i += 1) {
    for (const [id, vx] of Object.entries(speeds)) {
      vy[id] = last[id]?.grounded === true ? 0 : Math.max(-30, (vy[id] ?? 0) + G * DT);
      p.stageCharacterMove({ x: vx * DT, y: vy[id]! * DT }, id === '' ? undefined : id);
    }
    last[''] = p.step();
    for (const id of Object.keys(speeds)) if (id !== '') last[id] = p.lastResultOf(id)!;
  }
  return last;
}

describe('several characters on the 2D port', () => {
  it('each sweeps its own move in the same step and lands on its own', async () => {
    const p = await port2([{ id: 'p2', x: 2, y: 3 }]);
    expect(p.diagnostics().characterColliderCount).toBe(2);
    const r = walk2(p, { '': 1, p2: -0.5 }, 240);
    expect(r['']!.grounded).toBe(true);
    expect(r['p2']!.grounded).toBe(true);
    // Two seconds: the first walked about 2 m right, the second about 1 m left.
    expect(r['']!.position.x).toBeCloseTo(0, 1);
    expect(r['p2']!.position.x).toBeCloseTo(1, 1);
    expect(p.lastResultOf('nobody')).toBeUndefined();
  });

  it('characters never block each other nor a query', async () => {
    const p = await port2([{ id: 'p2', x: 0, y: 1 }]);
    walk2(p, { '': 0, p2: 0 }, 60);
    // The first walks right through the second, standing at x = 0.
    const r = walk2(p, { '': 2, p2: 0 }, 240);
    expect(r['']!.position.x).toBeGreaterThan(1.5);
    expect(r['']!.contacts.wall).toBe(false);
    // A ray across both characters hits the wall behind them, not a character.
    const q = await port2([{ id: 'p2', x: 0, y: 1 }], [box2('floor', 20, 0.25, 0, -0.25), box2('wall', 0.25, 2, 5, 2)]);
    walk2(q, { '': 0, p2: 0 }, 60);
    expect(q.raycast({ x: -5, y: 1 }, { x: 1, y: 0 }, 20)?.entityId).toBe('wall');
    expect(q.overlap({ type: 'circle', radius: 0.5 }, { x: 0, y: 1 })).toEqual([]);
  });

  it('placement, clearance and drop-through name the character; an unknown one is an error', async () => {
    const p = await port2([{ id: 'p2', x: 2, y: 1 }], [box2('floor', 20, 0.25, 0, -0.25), box2('ledge', 1, 0.1, 6, 1.9, { oneWay: true })]);
    expect(p.placeCharacter({ x: 6, y: 3 }, 'p2').ok).toBe(true);
    let r = walk2(p, { '': 0, p2: 0 }, 120);
    // The second stands on the one-way ledge, the first on the floor.
    expect(r['p2']!.groundEntityId).toBe('ledge');
    expect(r['']!.groundEntityId).toBe('floor');
    p.dropThrough(30, 'p2');
    r = walk2(p, { '': 0, p2: 0 }, 120);
    expect(r['p2']!.groundEntityId).toBe('floor');
    expect(p.characterClearance({ x: 0, y: 1 }, 'p2').ok).toBe(true);
    expect(() => p.placeCharacter({ x: 0, y: 1 }, 'nobody')).toThrow(/no character "nobody"/);
  });

  it('a further character with a repeated id is refused before any world work', async () => {
    const r = await createPhysicsPort({ character: { x: 0, y: 1 }, characters: [{ id: 'a', x: 1, y: 1 }, { id: 'a', x: 2, y: 1 }], statics: [], solver: { hz: HZ, gravityY: G }, controller: CONTROLLER });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/characters\[1\]\.id/);
  });
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const capsule3 = (x: number, y: number, z: number): PhysicsInitConfig3D['character'] => ({ position: { x, y, z }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } });

async function port3(extra: PhysicsInitConfig3D['characters']) {
  const made = await createPhysicsPort3D({
    dimension: 3,
    character: capsule3(-2, 2, 0),
    ...(extra !== undefined ? { characters: extra } : {}),
    statics: [{ entityId: 'floor', shape: { type: 'box', hx: 20, hy: 0.5, hz: 20 }, position: { x: 0, y: -0.5, z: 0 }, rotation: IDENTITY }],
    solver: { hz: HZ, gravityY: G },
    controller: CONTROLLER,
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return made.port;
}

describe('several characters on the 3D port', () => {
  it('each sweeps its own move; they pass through each other; placement names the character', async () => {
    const p = await port3([{ ...capsule3(2, 2, 0), id: 'p2' }]);
    const vy: Record<string, number> = {};
    const last: Record<string, CharacterMoveResult3D> = {};
    const run = (moves: Record<string, [number, number]>, steps: number): void => {
      for (let i = 0; i < steps; i += 1) {
        for (const [id, [vx, vz]] of Object.entries(moves)) {
          vy[id] = last[id]?.grounded === true ? 0 : Math.max(-30, (vy[id] ?? 0) + G * DT);
          p.stageCharacterMove({ x: vx * DT, y: vy[id]! * DT, z: vz * DT }, id === '' ? undefined : id);
        }
        last[''] = p.step();
        last['p2'] = p.lastResultOf!('p2')!;
      }
    };
    run({ '': [0, 0], p2: [0, 0] }, 120);
    expect(last['']!.grounded && last['p2']!.grounded).toBe(true);
    // The first walks along +x through the second; the second walks along +z.
    run({ '': [2, 0], p2: [0, 1] }, 240);
    expect(last['']!.position.x).toBeCloseTo(2, 0);
    expect(last['p2']!.position.z).toBeCloseTo(2, 0);
    expect(last['p2']!.position.x).toBeCloseTo(2, 1);
    expect(p.raycast!({ x: -5, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 20)).toBeNull();
    expect(p.placeCharacter!({ x: 5, y: 2, z: 5 }, 'p2').ok).toBe(true);
    run({ '': [0, 0], p2: [0, 0] }, 120);
    expect(last['p2']!.position.x).toBeCloseTo(5, 5);
    expect(last['p2']!.groundEntityId).toBe('floor');
  });
});
