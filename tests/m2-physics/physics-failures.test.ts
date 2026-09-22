/**
 * Packet 31 — fixture replay of the adapter's failure surface through the
 * real library (`fixtures/m2/physics/failures.json`).
 *
 * Every case runs against the pinned `@dimforge/rapier2d-compat@0.20.0`; no
 * mock stands in for the library. The expected codes/reasons come from the
 * fixture (physics.md §6/§10 + project-model §21.2), never from the observed
 * behavior of a failing run.
 */
import { describe, expect, it } from 'vitest';
import { createPhysicsPort, PhysicsPortError } from '@thirdlight/physics-rapier';
import type {
  PhysicsPortInitResult,
  RapierPhysicsInitConfig,
  RapierPhysicsPort,
} from '@thirdlight/physics-rapier';
import { fixture } from './helpers';

interface FailureCase {
  id: string;
  op: string;
  config: RapierPhysicsInitConfig;
  expect: Record<string, unknown>;
  note: string;
}

const file = fixture<{ cases: FailureCase[] }>('failures.json');

/**
 * JSON cannot carry non-finite numbers; the fixture encodes them as strings
 * (`nonFiniteEncoding`) and this revives them before the config is built.
 */
function revive(value: unknown): unknown {
  if (value === 'NaN') return Number.NaN;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (Array.isArray(value)) return value.map(revive);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

function caseConfig(physicsCase: FailureCase): RapierPhysicsInitConfig {
  return revive(physicsCase.config) as RapierPhysicsInitConfig;
}

const RAD = (deg: number): number => (deg * Math.PI) / 180;

function config(): RapierPhysicsInitConfig {
  return {
    character: { x: 0, y: 0.9 },
    statics: [
      { entityId: 'floor', shape: { type: 'box', hx: 8, hy: 0.25 }, position: { x: 0, y: -0.25 }, rotationZ: 0 },
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
}

async function ready(cfg: RapierPhysicsInitConfig): Promise<RapierPhysicsPort> {
  const r: PhysicsPortInitResult = await createPhysicsPort(cfg);
  if (!r.ok) throw new Error(`unexpected init failure: ${JSON.stringify(r.error)}`);
  return r.port;
}

function caught(fn: () => unknown): PhysicsPortError | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof PhysicsPortError ? error : undefined;
  }
  return undefined;
}

describe('physics failure fixtures', () => {
  it('covers every declared failure class', () => {
    const ops = new Set(file.cases.map((c) => c.op));
    expect([...ops].sort()).toEqual([
      'create',
      'createAbortDuringInit',
      'createPreAborted',
      'disposeTwice',
      'nonFiniteDelta',
      'resetInvalid',
      'staleAfterDispose',
    ]);
    expect(file.cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const physicsCase of file.cases) {
    it(`${physicsCase.id} — ${physicsCase.note}`, async () => {
      const expectCode = physicsCase.expect['code'] as string | undefined;
      const expectReason = physicsCase.expect['reason'] as string | undefined;

      if (physicsCase.op === 'create') {
        const r = await createPhysicsPort(caseConfig(physicsCase));
        expect(r.ok, `expected failure (${String(expectCode)})`).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe(expectCode);
          if (expectReason) expect(r.error.reason).toBe(expectReason);
          expect(r.error.message.length).toBeGreaterThan(0);
        }
        return;
      }

      if (physicsCase.op === 'createPreAborted') {
        const controller = new AbortController();
        controller.abort();
        const r = await createPhysicsPort(caseConfig(physicsCase), controller.signal);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('physics_init_cancelled');
        expect('port' in r).toBe(false);
        // Nothing was left behind: a later init in the same process succeeds.
        const port = await ready(config());
        expect(port.implementation).toBe('rapier2d-compat@0.20.0');
        port.dispose();
        return;
      }

      if (physicsCase.op === 'createAbortDuringInit') {
        const controller = new AbortController();
        const pending = createPhysicsPort(caseConfig(physicsCase), controller.signal);
        controller.abort();
        const r = await pending;
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('physics_init_cancelled');
        const port = await ready(config());
        port.stageCharacterMove({ x: 0, y: 0 });
        expect(port.step().position.x).toBe(0);
        port.dispose();
        return;
      }

      if (physicsCase.op === 'disposeTwice' || physicsCase.op === 'staleAfterDispose') {
        const port = await ready(caseConfig(physicsCase));
        const staleOps = (physicsCase.expect['staleOps'] as string[]) ?? [];
        port.stageCharacterMove({ x: 0, y: 0 });
        port.step();
        port.dispose();
        expect(caught(() => port.dispose())).toBeUndefined(); // idempotent
        expect(port.diagnostics().live).toBe(false);
        if (physicsCase.expect['diagnosticsLive'] !== undefined) {
          expect(port.diagnostics().live).toBe(physicsCase.expect['diagnosticsLive']);
        }
        for (const op of staleOps) {
          const error =
            op === 'step'
              ? caught(() => port.step())
              : op === 'reset'
                ? caught(() => port.reset({ x: 0, y: 1 }))
                : caught(() => port.stageCharacterMove({ x: 0, y: 0 }));
          expect(error, `${op} must throw a structured disposed error`).toBeDefined();
          expect(error?.code).toBe(physicsCase.expect['errorCode'] ?? 'physics_port_disposed');
        }
        return;
      }

      if (physicsCase.op === 'nonFiniteDelta') {
        const port = await ready(caseConfig(physicsCase));
        port.stageCharacterMove({ x: 0, y: 0 });
        port.step();
        const before = port.step().position;
        port.stageCharacterMove({ x: Number.NaN, y: 0 });
        const error = caught(() => port.step());
        expect(error).toBeDefined();
        expect(error?.code).toBe(physicsCase.expect['errorCode']);
        expect(error?.reason).toBe(physicsCase.expect['reason']);
        // The failed step left the capsule where it was.
        const after = port.step().position;
        expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1e-6);
        port.dispose();
        return;
      }

      if (physicsCase.op === 'resetInvalid') {
        const port = await ready(caseConfig(physicsCase));
        const error = caught(() => port.reset({ x: Number.NaN, y: 0 }));
        expect(error).toBeDefined();
        expect(error?.code).toBe(physicsCase.expect['errorCode']);
        expect(error?.reason).toBe(physicsCase.expect['reason']);
        port.dispose();
        return;
      }

      throw new Error(`unknown failure-fixture op '${physicsCase.op}'`);
    });
  }
});
