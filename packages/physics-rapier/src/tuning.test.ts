/**
 * Phase 15.3: the port takes the project's step rate (60/120/240 Hz) and the
 * player's skin, ground snap and autostep from its init config (defaults
 * 120 Hz, 0.01 m, 0.1 m, off — the values the frozen traces were made with).
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMoveResult } from '@thirdlight/runtime';

import { createPhysicsPort } from './index';
import type { RapierControllerConfig, RapierPhysicsInitConfig, RapierPhysicsPort, RapierStaticColliderSpec } from './types';

const RAD = (deg: number): number => (deg * Math.PI) / 180;
const box = (entityId: string, hx: number, hy: number, x: number, y: number): RapierStaticColliderSpec => ({ entityId, shape: { type: 'box', hx, hy }, position: { x, y }, rotationZ: 0 });
/** Floor top at y = 0, a 0.2 m step up at x >= 2. */
const LEVEL = [box('floor', 20, 0.25, 0, -0.25), box('step', 5, 0.1, 7, 0.1)];

function config(hz: number, controller: Partial<RapierControllerConfig> = {}): RapierPhysicsInitConfig {
  return {
    character: { x: 0, y: 0.91 },
    statics: LEVEL,
    solver: { hz, gravityY: -19.62 },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: RAD(45), minSlopeSlideRad: RAD(30), autostep: false, ...controller },
  };
}

async function port(cfg: RapierPhysicsInitConfig): Promise<RapierPhysicsPort> {
  const r = await createPhysicsPort(cfg);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.port;
}

function walk(p: RapierPhysicsPort, hz: number, moveX: number, seconds: number): CharacterMoveResult {
  const dt = 1 / hz;
  let vy = 0;
  let last: CharacterMoveResult | undefined;
  for (let i = 0; i < Math.round(seconds * hz); i += 1) {
    vy = last?.grounded === true ? 0 : Math.max(-30, vy - 19.62 * dt);
    p.stageCharacterMove({ x: moveX * dt, y: vy * dt });
    last = p.step();
  }
  return last!;
}

describe('physics tuning from the init config (phase 15.3)', () => {
  it('accepts the project step rates 60, 120 and 240 Hz; refuses others and out-of-range tuning', async () => {
    for (const hz of [60, 120, 240]) {
      const r = await createPhysicsPort(config(hz));
      expect(r.ok, `${hz} Hz`).toBe(true);
      if (r.ok) r.port.dispose();
    }
    for (const [label, cfg] of [
      ['90 Hz', config(90)],
      ['skin 0', config(120, { offsetSkin: 0 })],
      ['snap -1', config(120, { groundSnap: -1 })],
      ['autostep without a height', config(120, { autostep: true })],
      ['autostep 3 m', config(120, { autostep: true, autostepHeight: 3 })],
    ] as const) {
      const r = await createPhysicsPort(cfg);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.error.reason, label).toBe('invalid_config');
    }
  });

  it('the same walk covers the same distance at 60, 120 and 240 Hz', async () => {
    const xs: number[] = [];
    for (const hz of [60, 120, 240]) {
      const p = await port(config(hz));
      xs.push(walk(p, hz, 1, 1).position.x);
      p.dispose();
    }
    // (the first step of each lands the character: at most one step of travel differs)
    for (const x of xs) expect(Math.abs(x - 1)).toBeLessThan(1 / 60 + 1e-6);
  });

  it('the skin is the gap the character keeps: a resting capsule sits skin above the floor', async () => {
    const rest = async (skin: number): Promise<number> => {
      const p = await port({ ...config(120, { offsetSkin: skin }), character: { x: -5, y: 1 } });
      const y = walk(p, 120, 0, 1).position.y;
      p.dispose();
      return y;
    };
    const d = await rest(0.01);
    const w = await rest(0.05);
    expect(d).toBeCloseTo(0.9 + 0.01, 2);
    expect(w).toBeCloseTo(0.9 + 0.05, 2);
    expect(w - d).toBeGreaterThan(0.03);
  });

  it('autostep climbs a 0.2 m step that stops a character without it', async () => {
    const off = await port(config(120));
    const blocked = walk(off, 120, 3, 2);
    expect(blocked.position.x).toBeLessThan(2);
    off.dispose();
    const on = await port(config(120, { autostep: true, autostepHeight: 0.25 }));
    const climbed = walk(on, 120, 3, 2);
    expect(climbed.position.x).toBeGreaterThan(3);
    expect(climbed.position.y).toBeGreaterThan(1.05);
    on.dispose();
    // a step higher than the autostep height still blocks
    const low = await port(config(120, { autostep: true, autostepHeight: 0.1 }));
    expect(walk(low, 120, 3, 2).position.x).toBeLessThan(2);
    low.dispose();
  });
});
