/**
 * Packet 31 — public surface (dependencies.md §3 `physics-rapier` row) and the
 * structural compatibility of the adapter config with the accepted
 * `runtime.md` §12.6 port shapes.
 *
 * The value exports are exactly the contracted three (`createPhysicsPort`,
 * `RAPIER_PIN`, `PHYSICS_IMPLEMENTATION`); the config/result types are
 * additive type-only exports the host needs (recorded as C31-2). The adapter
 * config must accept an accepted `PhysicsInitConfig` unchanged — that is
 * checked structurally here.
 */
import { describe, expect, it } from 'vitest';
import type { CharacterMoveResult, PhysicsPort } from '@thirdlight/runtime';

import * as physicsRapier from './index';
import { createPhysicsPort } from './index';
import { AUTOSTEP_DISABLED, DEFAULT_CAPSULE_HALF_HEIGHT, DEFAULT_CAPSULE_RADIUS, CONTROLLER_OFFSET_SKIN, FIXED_HZ, GROUND_SNAP_DISTANCE, RAPIER_PIN, PHYSICS_IMPLEMENTATION } from './constants';

const RAD = (deg: number): number => (deg * Math.PI) / 180;

/**
 * A local mirror of the accepted runtime.md §12.6 `PhysicsInitConfig` (the
 * runtime package does not export the init-config type — the factory lives in
 * this adapter). Assigning it to `createPhysicsPort` is the compile-time
 * check that the adapter config is a structural superset of the accepted
 * shape.
 */
interface AcceptedRuntimeInitConfig {
  character: { x: number; y: number };
  statics: readonly {
    entityId: string;
    shape: unknown;
    position: { x: number; y: number };
    rotationZ: number;
  }[];
  solver: { hz: 120; gravityY: number };
  controller: {
    offsetSkin: 0.01;
    groundSnap: 0.1;
    maxSlopeClimbRad: number;
    minSlopeSlideRad: number;
    autostep: false;
  };
}

const accepted: AcceptedRuntimeInitConfig = {
  character: { x: 0, y: 0.9 },
  statics: [
    {
      entityId: 'floor-0001',
      shape: { type: 'box', hx: 8, hy: 0.3 },
      position: { x: 0, y: -0.3 },
      rotationZ: 0,
    },
  ],
  solver: { hz: 120, gravityY: -19.62 },
  controller: {
    offsetSkin: 0.01,
    groundSnap: 0.1,
    maxSlopeClimbRad: RAD(45),
    minSlopeSlideRad: RAD(30),
    autostep: false,
  },
};

describe('public exports', () => {
  it('exports exactly the contracted value surface', () => {
    expect(Object.keys(physicsRapier).sort()).toEqual([
      'PHYSICS_IMPLEMENTATION',
      'PhysicsPortError',
      'RAPIER_PIN',
      'createPhysicsPort',
      // Phase 22.3: the Rapier WebAssembly memory size (the simulation worker's growth limit).
      'physicsMemoryBytes',
    ]);
  });

  it('carries the approved pin and implementation identity', () => {
    expect(RAPIER_PIN).toBe('0.20.0');
    expect(PHYSICS_IMPLEMENTATION).toBe('rapier2d-compat@0.20.0');
    expect(FIXED_HZ).toBe(120);
    expect(DEFAULT_CAPSULE_RADIUS).toBe(0.3);
    expect(DEFAULT_CAPSULE_HALF_HEIGHT).toBe(0.6);
    expect(CONTROLLER_OFFSET_SKIN).toBe(0.01);
    expect(GROUND_SNAP_DISTANCE).toBe(0.1);
    expect(AUTOSTEP_DISABLED).toBe(false);
  });

  it('accepts the accepted PhysicsInitConfig unchanged and returns a PhysicsPort', async () => {
    // `accepted` is typed with the runtime's own accepted shape: if the
    // adapter changed any field name/unit, this stops compiling.
    const result = await createPhysicsPort(accepted);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const port: PhysicsPort = result.port;
    expect(typeof port.stageCharacterMove).toBe('function');
    expect(typeof port.step).toBe('function');
    expect(typeof port.reset).toBe('function');
    expect(typeof port.dispose).toBe('function');
    expect(typeof port.diagnostics).toBe('function');
    // M3 (gameplay.md §5.2): the restricted reset/clearance operations.
    const resetPort = result.port as {
      clearCharacterMotion(): void;
      placeCharacter(c: { x: number; y: number }): { ok: boolean; reason?: string };
      characterClearance(c: { x: number; y: number }): { ok: boolean; reason?: string };
    };
    expect(typeof resetPort.clearCharacterMotion).toBe('function');
    expect(typeof resetPort.placeCharacter).toBe('function');
    expect(typeof resetPort.characterClearance).toBe('function');
    const moved: CharacterMoveResult = (() => {
      port.stageCharacterMove({ x: 1 / 120, y: 0 });
      return port.step();
    })();
    expect(Object.keys(moved).sort()).toEqual(
      // Phase 9.9 adds groundEntityId (the collider under a grounded character).
      ['applied', 'contacts', 'groundEntityId', 'grounded', 'position', 'requested', 'snapped', 'supportNormal'].sort(),
    );
    port.dispose();
  });
});
