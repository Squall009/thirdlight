/**
 * Phase 14.0: the character capsule is data. A small capsule (radius 0.25 m,
 * 1 m tall) walks under a 1.2 m ceiling that stops the default 1.8 m capsule;
 * with its offset putting the entity origin at the feet it lands with the
 * origin on the ground; the clearance probe, `placeCharacter` and one-way
 * platforms use its own shape.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMoveResult } from '@thirdlight/runtime';

import { createPhysicsPort } from './index';
import { FIXED_HZ } from './constants';
import type { RapierCharacterSpec, RapierPhysicsInitConfig, RapierPhysicsPort, RapierStaticColliderSpec } from './types';

const DT = 1 / FIXED_HZ;
const RAD = (deg: number): number => (deg * Math.PI) / 180;

const box = (entityId: string, hx: number, hy: number, x: number, y: number, extra: Partial<RapierStaticColliderSpec> = {}): RapierStaticColliderSpec => ({ entityId, shape: { type: 'box', hx, hy }, position: { x, y }, rotationZ: 0, ...extra });

/** Floor top at y = 0; a ceiling slab over x 2..4 whose underside is 1.2 m up. */
const LEVEL = [box('floor', 20, 0.25, 0, -0.25), box('ceiling', 1, 0.5, 3, 1.7)];

async function port(character: RapierCharacterSpec, statics = LEVEL): Promise<RapierPhysicsPort> {
  const cfg: RapierPhysicsInitConfig = {
    character,
    statics,
    solver: { hz: 120, gravityY: -19.62 },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: RAD(45), minSlopeSlideRad: RAD(30), autostep: false },
  };
  const r = await createPhysicsPort(cfg);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.port;
}

/** Walk (moveX m/s) with gravity for `steps` steps; returns the last result. */
function walk(p: RapierPhysicsPort, moveX: number, steps: number): CharacterMoveResult {
  let vy = 0;
  let last: CharacterMoveResult | undefined;
  for (let i = 0; i < steps; i += 1) {
    vy = last?.grounded === true ? 0 : Math.max(-30, vy - 19.62 * DT);
    p.stageCharacterMove({ x: moveX * DT, y: vy * DT });
    last = p.step();
  }
  return last!;
}

const SMALL = { radius: 0.25, halfHeight: 0.25 };

describe('the character capsule from the init config', () => {
  it('a 1 m capsule walks under a 1.2 m ceiling that stops the default 1.8 m capsule', async () => {
    const tall = await port({ x: 0, y: 0.91 });
    const stopped = walk(tall, 4, 240);
    // The ceiling's left face is at x = 2: the default capsule stops before it.
    expect(stopped.position.x).toBeLessThan(2 - 0.3 + 0.001);
    expect(stopped.contacts.wall).toBe(true);
    tall.dispose();

    const small = await port({ x: 0, y: 0.51, ...SMALL });
    const through = walk(small, 4, 240);
    expect(through.position.x).toBeGreaterThan(5);
    expect(through.grounded).toBe(true);
    small.dispose();
  });

  it('with the offset at half its height the entity origin lands on the ground (feet on the ground)', async () => {
    const p = await port({ x: -5, y: 1.5, ...SMALL, offset: { x: 0, y: 0.5 } });
    const landed = walk(p, 0, 240);
    expect(landed.grounded).toBe(true);
    // The origin is the feet: on the floor top (y = 0) within the controller's skin.
    expect(landed.position.y).toBeGreaterThanOrEqual(0);
    expect(landed.position.y).toBeLessThan(0.02);
    expect(landed.position.x).toBeCloseTo(-5, 6);
    p.dispose();
  });

  it('the clearance probe and placeCharacter use the capsule and its offset', async () => {
    const p = await port({ x: -5, y: 0.01, ...SMALL, offset: { x: 0, y: 0.5 } });
    // Under the ceiling with the feet on the floor: the 1 m capsule fits.
    expect(p.characterClearance({ x: 3, y: 0.01 })).toMatchObject({ ok: true });
    // With the feet at 0.5 m its top (1.5 m) is inside the ceiling slab.
    expect(p.characterClearance({ x: 3, y: 0.5 })).toMatchObject({ ok: false, reason: 'blocked' });
    expect(p.placeCharacter({ x: 3, y: 0.01 })).toMatchObject({ ok: true });
    const r = walk(p, 0, 30);
    expect(r.position.y).toBeLessThan(0.02);
    expect(r.position.x).toBeCloseTo(3, 6);
    p.dispose();

    // The default capsule centred at 0.91 does not fit under the same ceiling.
    const tall = await port({ x: -5, y: 0.91 });
    expect(tall.characterClearance({ x: 3, y: 0.91 })).toMatchObject({ ok: false, reason: 'blocked' });
    tall.dispose();
  });

  it('a one-way platform tests the feet of the configured capsule', async () => {
    // A one-way shelf whose top is at 0.6 m; the small capsule (origin at its feet) drops onto it from above.
    const shelf = [box('floor', 20, 0.25, 0, -0.25), box('shelf', 1, 0.1, 0, 0.5, { oneWay: true })];
    const p = await port({ x: 0, y: 1.2, ...SMALL, offset: { x: 0, y: 0.5 } }, shelf);
    const r = walk(p, 0, 240);
    expect(r.grounded).toBe(true);
    expect(r.position.y).toBeGreaterThan(0.59);
    expect(r.position.y).toBeLessThan(0.63);
    p.dispose();
  });

  it('refuses a capsule that is not finite or not positive', async () => {
    const bad = async (character: RapierCharacterSpec): Promise<boolean> => {
      const r = await createPhysicsPort({
        character,
        statics: LEVEL,
        solver: { hz: 120, gravityY: -19.62 },
        controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: RAD(45), minSlopeSlideRad: RAD(30), autostep: false },
      });
      if (r.ok) r.port.dispose();
      return !r.ok;
    };
    expect(await bad({ x: 0, y: 1, radius: 0 })).toBe(true);
    expect(await bad({ x: 0, y: 1, radius: 0.3, halfHeight: -1 })).toBe(true);
    expect(await bad({ x: 0, y: 1, radius: 0.3, halfHeight: 0.2, offset: { x: Number.NaN, y: 0 } })).toBe(true);
    expect(await bad({ x: 0, y: 1, radius: 0.3, halfHeight: 0 })).toBe(false);
  });
});
