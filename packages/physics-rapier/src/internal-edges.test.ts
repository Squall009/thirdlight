/**
 * Phase 25.4: internal edges in the 2D port. Where static colliders share a
 * face, a collider's corner on that face is not on the surface of their
 * union; Rapier still grounds the character on it (any contact whose normal
 * tilts up). The port refuses that ground, so stacked or overlapping
 * colliders behave like one; real corners (a ledge) still hold the character.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMoveResult } from '@thirdlight/runtime';

import { createPhysicsPort } from './index';
import { FIXED_HZ } from './constants';
import type { RapierPhysicsPort, RapierStaticColliderSpec } from './types';

const DT = 1 / FIXED_HZ;
const RAD = (deg: number): number => (deg * Math.PI) / 180;
const G = -19.62;
const box = (entityId: string, hx: number, hy: number, x: number, y: number): RapierStaticColliderSpec => ({ entityId, shape: { type: 'box', hx, hy }, position: { x, y }, rotationZ: 0 });

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

/** One step at `vx` m/s: gravity while not grounded, or the jump velocity `jump`. */
function step(p: RapierPhysicsPort, s: { vy: number; last?: CharacterMoveResult }, vx: number, jump?: number): CharacterMoveResult {
  s.vy = jump ?? (s.last?.grounded === true ? 0 : Math.max(-30, s.vy + G * DT));
  p.stageCharacterMove({ x: vx * DT, y: s.vy * DT });
  s.last = p.step();
  return s.last;
}

const FLOOR = box('floor', 20, 0.5, 0, -0.5);

/**
 * Walk into a wall whose face is 2 m away (dir 1: on the right, -1: mirrored
 * on the left), jump, keep pressing: the heights, and the steps grounded above the floor.
 */
async function slideDown(wall: RapierStaticColliderSpec[], dir = 1): Promise<{ ys: number[]; groundedAbove: number; landed: boolean }> {
  const p = await port({ x: 0, y: 0.91 }, [FLOOR, ...wall]);
  const s = { vy: 0 } as { vy: number; last?: CharacterMoveResult };
  for (let i = 0; i < 120; i++) step(p, s, 6 * dir);
  step(p, s, 6 * dir, 12);
  const ys: number[] = [];
  let groundedAbove = 0;
  for (let i = 0; i < 300; i++) {
    const r = step(p, s, 6 * dir);
    ys.push(r.position.y);
    if (r.grounded && r.position.y > 0.92) groundedAbove += 1;
    expect(r.position.x * dir).toBeLessThan(2 - 0.3 + 1e-3);
  }
  const landed = s.last!.grounded && Math.abs(s.last!.position.y - 0.91) < 0.01;
  p.dispose();
  return { ys, groundedAbove, landed };
}

describe('phase 25.4: internal edges (2D port)', () => {
  it('a wall of ten stacked boxes: never grounded at a seam; the same fall as one tall box', async () => {
    const one = await slideDown([box('w', 0.5, 5, 2.5, 5)]);
    const stacked = await slideDown(Array.from({ length: 10 }, (_, i) => box(`w${i}`, 0.5, 0.5, 2.5, 0.5 + i)));
    expect(one.groundedAbove).toBe(0);
    expect(stacked.groundedAbove).toBe(0);
    expect(stacked.landed).toBe(true);
    for (let i = 0; i < one.ys.length; i++) expect(Math.abs(stacked.ys[i]! - one.ys[i]!)).toBeLessThan(0.01);
  });

  it('overlapping boxes (a wall of 1.2 m boxes 1 m apart) behave the same', async () => {
    const one = await slideDown([box('w', 0.5, 5, 2.5, 5)]);
    const overlapping = await slideDown(Array.from({ length: 10 }, (_, i) => box(`w${i}`, 0.5, 0.6, 2.5, 0.5 + i)));
    expect(overlapping.groundedAbove).toBe(0);
    for (let i = 0; i < one.ys.length; i++) expect(Math.abs(overlapping.ys[i]! - one.ys[i]!)).toBeLessThan(0.01);
  });

  it('D46: pressed against a wall on its left, the character falls as against one on its right', async () => {
    const right = await slideDown([box('w', 0.5, 5, 2.5, 5)]);
    const left = await slideDown([box('w', 0.5, 5, -2.5, 5)], -1);
    const stackedLeft = await slideDown(Array.from({ length: 10 }, (_, i) => box(`w${i}`, 0.5, 0.5, -2.5, 0.5 + i)), -1);
    expect(left.landed).toBe(true);
    expect(stackedLeft.landed).toBe(true);
    for (let i = 0; i < right.ys.length; i++) {
      expect(Math.abs(left.ys[i]! - right.ys[i]!)).toBeLessThan(0.01);
      expect(Math.abs(stackedLeft.ys[i]! - right.ys[i]!)).toBeLessThan(0.01);
    }
  });

  it('a real corner still holds: standing past the edge of a ledge built from tiles stays grounded', async () => {
    // Tiles from x = -3 to 1 with their top at y = 1; the capsule's centre 0.2 m past the last tile's edge.
    const tiles = Array.from({ length: 4 }, (_, i) => box(`t${i}`, 0.5, 0.5, -2.5 + i, 0.5));
    const p = await port({ x: 1.2, y: 1.95 }, [box('floor', 20, 0.5, 0, -5), ...tiles]);
    const s = { vy: 0 } as { vy: number; last?: CharacterMoveResult };
    for (let i = 0; i < 60; i++) step(p, s, 0);
    expect(s.last!.grounded).toBe(true);
    expect(s.last!.position.y).toBeGreaterThan(1.8); // held on the ledge, not fallen to the floor far below
    p.dispose();
  });
});
