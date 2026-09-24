/**
 * Phase 14.7: two physics fixes in the port.
 * - A kinematic body rising beside the character (a gate opening) no longer
 *   drags it up the wall; one the character stands on still moves it.
 * - One-way platforms are ignored by the spawn clearance probe (a spawn inside
 *   one is free); they support only feet on their top.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMoveResult } from '@thirdlight/runtime';

import { createPhysicsPort } from './index';
import { FIXED_HZ } from './constants';
import type { RapierPhysicsPort, RapierStaticColliderSpec } from './types';

const DT = 1 / FIXED_HZ;
const RAD = (deg: number): number => (deg * Math.PI) / 180;
const G = -19.62;

const box = (entityId: string, hx: number, hy: number, x: number, y: number, extra: Partial<RapierStaticColliderSpec> = {}): RapierStaticColliderSpec => ({ entityId, shape: { type: 'box', hx, hy }, position: { x, y }, rotationZ: 0, ...extra });

async function port(character: { x: number; y: number }, statics: RapierStaticColliderSpec[]): Promise<RapierPhysicsPort> {
  const r = await createPhysicsPort({
    character,
    statics,
    solver: { hz: 120, gravityY: G },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: RAD(45), minSlopeSlideRad: RAD(30), autostep: false },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.port;
}

/** One step: walk at `moveX` m/s with gravity, the kinematic body `id` posed at `at` (after the sweep). */
function stepWith(p: RapierPhysicsPort, state: { vy: number; last?: CharacterMoveResult }, moveX: number, id: string, at: { x: number; y: number }): CharacterMoveResult {
  state.vy = state.last?.grounded === true ? 0 : Math.max(-30, state.vy + G * DT);
  p.setKinematicPositions!([{ entityId: id, position: at, rotationZ: 0 }]);
  p.stageCharacterMove({ x: moveX * DT, y: state.vy * DT });
  state.last = p.step();
  return state.last;
}

// Floor top at y = 0; the default capsule (radius 0.3, 1.8 m) rests with its centre at 0.91.
const FLOOR = box('floor', 20, 0.25, 0, -0.25);

describe('a kinematic body rising beside the character', () => {
  it('does not lift a character pressing against its side (it rises past, the character walks on)', async () => {
    // A 3 m gate whose left face is at x = 2, rising 3.2 m at 3 m/s.
    const gate = box('gate', 0.25, 1.5, 2.25, 1.5, { kinematic: true });
    const p = await port({ x: 0, y: 0.91 }, [FLOOR, gate]);
    const s = { vy: 0 } as { vy: number; last?: CharacterMoveResult };
    let gy = 1.5;
    let maxY = -Infinity;
    for (let i = 0; i < 360; i += 1) {
      if (i >= 60) gy = Math.min(4.7, gy + 3 * DT); // the character reaches the gate before it opens
      const r = stepWith(p, s, 4, 'gate', { x: 2.25, y: gy });
      maxY = Math.max(maxY, r.position.y);
      // Never inside the gate while its bottom is below the capsule's straight side (its rounded top may slip under).
      if (gy - 1.5 < r.position.y + 0.6) expect(r.position.x).toBeLessThan(2 - 0.3 + 1e-3);
    }
    expect(maxY).toBeLessThan(0.92); // never lifted (the rest height is 0.91 ± the controller's skin)
    expect(s.last!.position.x).toBeGreaterThan(3); // walked on under the open gate
    expect(s.last!.grounded).toBe(true);
    p.dispose();
  });

  it('still moves a character standing on it', async () => {
    const lift = box('lift', 1, 0.2, 0, -0.2, { kinematic: true });
    const p = await port({ x: 0, y: 0.91 }, [box('floor', 20, 0.25, 0, -3), lift]);
    const s = { vy: 0 } as { vy: number; last?: CharacterMoveResult };
    let ly = -0.2;
    for (let i = 0; i < 30; i += 1) stepWith(p, s, 0, 'lift', { x: 0, y: ly });
    const startY = s.last!.position.y;
    for (let i = 0; i < 120; i += 1) {
      ly += 1 * DT;
      stepWith(p, s, 0, 'lift', { x: 0, y: ly });
    }
    expect(s.last!.position.y - startY).toBeGreaterThan(0.9); // rode up ~1 m
    p.dispose();
  });
});

describe('spawn clearance and one-way platforms', () => {
  // A one-way shelf 0.2 m thick, top at y = 1.3.
  const shelf = (x = 0): RapierStaticColliderSpec => box('shelf', 2, 0.1, x, 1.2, { oneWay: true });

  it('a spawn inside a one-way platform is not blocked; its support is the floor below', async () => {
    const p = await port({ x: -6, y: 0.91 }, [FLOOR, shelf()]);
    // Centre 0.91: the capsule (0.01..1.81) passes through the shelf (1.1..1.3).
    const r = p.characterClearance({ x: 0, y: 0.91 });
    expect(r).toMatchObject({ ok: true, penetration: 0 });
    expect(r.supportNormal).toEqual({ x: 0, y: 1 });
    // The same slab as a solid collider blocks.
    const solid = await port({ x: -6, y: 0.91 }, [FLOOR, box('slab', 2, 0.1, 0, 1.2)]);
    expect(solid.characterClearance({ x: 0, y: 0.91 })).toMatchObject({ ok: false, reason: 'blocked' });
    p.dispose();
    solid.dispose();
  });

  it('a one-way platform supports feet on its top, not feet inside or under it', async () => {
    // No floor under the shelf: only the shelf could support.
    const p = await port({ x: -6, y: 10 }, [shelf()]);
    expect(p.characterClearance({ x: 0, y: 1.3 + 0.91 })).toMatchObject({ ok: true }); // standing on it
    expect(p.characterClearance({ x: 0, y: 1.2 + 0.9 })).toMatchObject({ ok: false, reason: 'no_support' }); // feet inside it
    expect(p.characterClearance({ x: 0, y: 0.5 })).toMatchObject({ ok: false, reason: 'no_support' }); // under it
    p.dispose();
  });

  it('placeCharacter inside a one-way platform: the character falls through to the floor', async () => {
    const p = await port({ x: -6, y: 0.91 }, [FLOOR, box('shelf', 2, 0.1, 0, 1.2, { oneWay: true })]);
    // The feet at the shelf's middle, 0.1 m under its top (deeper than the landing tolerance).
    expect(p.placeCharacter({ x: 0, y: 1.2 + 0.9 })).toMatchObject({ ok: true });
    const s = { vy: 0 } as { vy: number; last?: CharacterMoveResult };
    let r: CharacterMoveResult | undefined;
    for (let i = 0; i < 120; i += 1) {
      s.vy = s.last?.grounded === true ? 0 : Math.max(-30, s.vy + G * DT);
      p.stageCharacterMove({ x: 0, y: s.vy * DT });
      r = s.last = p.step();
    }
    expect(r!.grounded).toBe(true);
    expect(r!.position.y).toBeLessThan(0.93);
    p.dispose();
  });
});
