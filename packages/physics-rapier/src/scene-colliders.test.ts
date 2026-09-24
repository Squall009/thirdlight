/**
 * Phase 12 (c): a loaded scene's static colliders are added to the live
 * world and an unloaded scene's are freed (the library's own counters), and
 * the character collides with a floor that arrived after creation.
 */
import { describe, expect, it } from 'vitest';

import { createPhysicsPort } from './index';
import type { RapierPhysicsInitConfig, RapierPhysicsPort } from './types';

const RAD = (deg: number): number => (deg * Math.PI) / 180;

function config(): RapierPhysicsInitConfig {
  return {
    character: { x: 20, y: 1.5 },
    statics: [{ entityId: 'floor-main', shape: { type: 'box', hx: 5, hy: 0.25 }, position: { x: 0, y: -0.25 }, rotationZ: 0 }],
    solver: { hz: 120, gravityY: -19.62 },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: RAD(45), minSlopeSlideRad: RAD(30), autostep: false },
  };
}

async function port(): Promise<RapierPhysicsPort> {
  const r = await createPhysicsPort(config());
  if (!r.ok) throw new Error(r.error.message);
  return r.port;
}

describe('scene colliders (phase 12 c)', () => {
  it('adds a loaded floor the character then stands on, and frees it on unload', async () => {
    const p = await port();
    const before = p.diagnostics();
    p.addStaticColliders([{ entityId: 'floor-cave', shape: { type: 'box', hx: 5, hy: 0.25 }, position: { x: 20, y: -0.25 }, rotationZ: 0 }]);
    expect(p.diagnostics().worldColliderCount).toBe(before.worldColliderCount! + 1);
    expect(p.diagnostics().worldBodyCount).toBe(before.worldBodyCount! + 1);
    // Falling onto the new floor: the character ends up grounded on it.
    let grounded = false;
    for (let i = 0; i < 240; i += 1) {
      p.stageCharacterMove({ x: 0, y: -0.1 });
      grounded = p.step().grounded;
    }
    expect(grounded).toBe(true);

    p.removeStaticColliders(['floor-cave', 'not-there']);
    expect(p.diagnostics().worldColliderCount).toBe(before.worldColliderCount);
    expect(p.diagnostics().worldBodyCount).toBe(before.worldBodyCount);
    // A bad shape adds nothing (the whole batch is checked first).
    expect(() => p.addStaticColliders([
      { entityId: 'ok', shape: { type: 'box', hx: 1, hy: 1 }, position: { x: 0, y: 5 }, rotationZ: 0 },
      { entityId: 'bad', shape: { type: 'box', hx: -1, hy: 1 }, position: { x: 0, y: 5 }, rotationZ: 0 },
    ])).toThrow(/hx/);
    expect(p.diagnostics().worldColliderCount).toBe(before.worldColliderCount);
    p.dispose();
  });

  it('phase 9.9: overlap queries find the colliders in a box or a circle, never the character', async () => {
    const p = await port();
    p.addStaticColliders([
      { entityId: 'crate-a', shape: { type: 'box', hx: 0.5, hy: 0.5 }, position: { x: 3, y: 1.5 }, rotationZ: 0 },
      { entityId: 'crate-b', shape: { type: 'box', hx: 0.5, hy: 0.5 }, position: { x: 6, y: 1.5 }, rotationZ: 0 },
    ]);
    p.stageCharacterMove({ x: 0, y: 0 });
    p.step();
    expect(p.overlap({ type: 'box', hx: 1, hy: 0.4 }, { x: 3.2, y: 1.5 })).toEqual(['crate-a']);
    expect(p.overlap({ type: 'box', hx: 2, hy: 0.4 }, { x: 4.5, y: 1.5 })).toEqual(['crate-a', 'crate-b']);
    expect(p.overlap({ type: 'circle', radius: 0.6 }, { x: 6.9, y: 1.5 })).toEqual(['crate-b']);
    expect(p.overlap({ type: 'circle', radius: 0.4 }, { x: 4.5, y: 1.5 })).toEqual([]);
    expect(p.overlap({ type: 'box', hx: 0.5, hy: 0.5 }, { x: 20, y: 1.5 })).toEqual([]); // the character is not reported
    expect(p.overlap({ type: 'box', hx: -1, hy: 1 }, { x: 3, y: 1.5 })).toEqual([]);
    p.dispose();
  });
});
