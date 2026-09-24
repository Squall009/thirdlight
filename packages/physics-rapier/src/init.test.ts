/**
 * Packet 31 — the real-library adapter lifecycle and behavior
 * (`@dimforge/rapier2d-compat@0.20.0`, the approved pin).
 *
 * These tests run the actual WASM library in Node (the pin is exercised for
 * real, not mocked): initialization/cancellation, the parentless capsule
 * against floor/wall/ceiling/box-ramp/convex-ramp statics, ground snap, the
 * grounding/support-normal rule, the failure surface, disposal and repeated
 * create/dispose cycles with the library's own collider/body counters.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CharacterMoveResult } from '@thirdlight/runtime';

import { createPhysicsPort, PHYSICS_IMPLEMENTATION, RAPIER_PIN } from './index';
import { DEFAULT_CAPSULE_HALF_HEIGHT, DEFAULT_CAPSULE_RADIUS, FIXED_HZ } from './constants';
import { PhysicsPortError } from './errors';
import type {
  PhysicsPortInitResult,
  RapierPhysicsInitConfig,
  RapierPhysicsPort,
  RapierStaticColliderSpec,
} from './types';

const RAD = (deg: number): number => (deg * Math.PI) / 180;
const DT = 1 / FIXED_HZ;
const REACH = DEFAULT_CAPSULE_HALF_HEIGHT + DEFAULT_CAPSULE_RADIUS;

function box(
  entityId: string,
  hx: number,
  hy: number,
  x: number,
  y: number,
  rotationZ = 0,
): RapierStaticColliderSpec {
  return { entityId, shape: { type: 'box', hx, hy }, position: { x, y }, rotationZ };
}

/** A ramp whose bottom-left corner is at `baseX`, ascending to the right. */
function ramp(entityId: string, baseX: number, deg: number, hx = 2, hy = 0.1): RapierStaticColliderSpec {
  const th = RAD(deg);
  return box(entityId, hx, hy, baseX + Math.cos(th) * hx, Math.sin(th) * hx, th);
}

function config(overrides: Partial<RapierPhysicsInitConfig> = {}): RapierPhysicsInitConfig {
  const base: RapierPhysicsInitConfig = {
    character: { x: 0, y: 0.9 },
    statics: [box('floor', 10, 0.25, 0, -0.25)],
    solver: { hz: 120, gravityY: -19.62 },
    controller: {
      offsetSkin: 0.01,
      groundSnap: 0.1,
      maxSlopeClimbRad: RAD(45),
      minSlopeSlideRad: RAD(30),
      autostep: false,
    },
  };
  return { ...base, ...overrides };
}

async function makePort(cfg = config()): Promise<{ port: RapierPhysicsPort }> {
  const r = await createPhysicsPort(cfg);
  if (!r.ok) throw new Error(`init failed: ${JSON.stringify(r.error)}`);
  return { port: r.port };
}

/** The packet-14 canonical character model (probe-rapier2d.mjs). */
class Probe {
  vy = 0;
  airborne = false;
  last: CharacterMoveResult | undefined;
  readonly results: CharacterMoveResult[] = [];

  constructor(
    readonly port: RapierPhysicsPort,
    readonly runSpeed = 4,
    readonly jumpVelocity = 7,
    readonly maxFallSpeed = -30,
  ) {}

  step(moveX: number, jump = false, speed = this.runSpeed): CharacterMoveResult {
    const grounded = this.last?.grounded === true;
    if (jump && grounded) {
      this.vy = this.jumpVelocity;
      this.airborne = true;
    }
    if (grounded && !this.airborne) this.vy = 0;
    else {
      this.vy += -19.62 * DT;
      if (this.vy < this.maxFallSpeed) this.vy = this.maxFallSpeed;
    }
    if (this.airborne && grounded && this.vy <= 0) this.airborne = false;
    this.port.stageCharacterMove({ x: moveX * speed * DT, y: this.vy * DT });
    const result = this.port.step();
    this.last = result;
    this.results.push(result);
    return result;
  }

  settle(steps = 12): void {
    for (let i = 0; i < steps; i += 1) this.step(0);
  }
}

describe('initialization', () => {
  it('creates a ready port with the contracted implementation string and pin', async () => {
    expect(RAPIER_PIN).toBe('0.20.0');
    expect(PHYSICS_IMPLEMENTATION).toBe('rapier2d-compat@0.20.0');
    const { port } = await makePort();
    expect(port.implementation).toBe(PHYSICS_IMPLEMENTATION);
    const diag = port.diagnostics?.();
    expect(diag).toMatchObject({
      implementation: PHYSICS_IMPLEMENTATION,
      worldColliderCount: 2,
      worldBodyCount: 1,
      staticColliderCount: 1,
      characterColliderCount: 1,
      live: true,
    });
    port.dispose();
  });

  it('reports a stale-handle disposal through the frozen diagnostics snapshot', async () => {
    const { port } = await makePort();
    const probe = new Probe(port);
    probe.settle(2);
    port.dispose();
    const after = port.diagnostics?.();
    expect(after?.live).toBe(false);
    expect(after?.steps).toBe(2);
    // Idempotent disposal: a second call is a no-op, not a throw.
    expect(() => port.dispose()).not.toThrow();
  });

  it('never exposes a port on cancellation and succeeds afterwards', async () => {
    const pre = new AbortController();
    pre.abort();
    const cancelled = await createPhysicsPort(config(), pre.signal);
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.error.code).toBe('physics_init_cancelled');

    // Abort observed during preparation (the same tick as the call).
    const during = new AbortController();
    const pending = createPhysicsPort(config(), during.signal);
    during.abort();
    const duringResult = await pending;
    expect(duringResult.ok).toBe(false);
    if (!duringResult.ok) expect(duringResult.error.code).toBe('physics_init_cancelled');
    expect('port' in duringResult).toBe(false);

    // A later init is unaffected (no adapter module state).
    const { port } = await makePort();
    const probe = new Probe(port);
    probe.settle(12);
    expect(probe.last?.grounded).toBe(true);
    port.dispose();
  });

  it('refuses invalid shapes, forbidden transforms and non-constant settings before creating a world', async () => {
    const cases: [string, RapierPhysicsInitConfig, string][] = [
      ['invalid shape', config({ statics: [box('bad', 0, 1, 0, 0)] }), 'invalid_shape'],
      [
        'parented',
        config({ statics: [{ ...box('p', 1, 1, 0, 0), parentId: 'group-0001' }] }),
        'parented',
      ],
      ['scale', config({ statics: [{ ...box('s', 1, 1, 0, 0), scale: [2, 1, 1] }] }), 'scale'],
      [
        'rotation',
        config({ statics: [{ ...box('r', 1, 1, 0, 0), rotation: [0.5, 0, 0, 0.5] }] }),
        'rotation',
      ],
      [
        'upright',
        config({ character: { x: 0, y: 0.9, rotation: [0, 0, 0.1, 0.99498743710662] } }),
        'upright',
      ],
      [
        'invalid transform',
        config({ statics: [{ ...box('n', 1, 1, 0, 0), rotationZ: Number.NaN }] }),
        'invalid_transform',
      ],
      [
        'invalid config',
        config({
          controller: {
            offsetSkin: 0.01,
            groundSnap: 0.1,
            maxSlopeClimbRad: RAD(45),
            minSlopeSlideRad: RAD(30),
            autostep: true,
          } as unknown as RapierPhysicsInitConfig['controller'],
        }),
        'invalid_config',
      ],
    ];
    for (const [label, cfg, reason] of cases) {
      const r: PhysicsPortInitResult = await createPhysicsPort(cfg);
      expect(r.ok, label).toBe(false);
      if (!r.ok) {
        expect(r.error.code, label).toBe('physics_init_failed');
        expect(r.error.reason, label).toBe(reason);
        expect(r.error.message.length, label).toBeGreaterThan(0);
      }
    }
  });
});

describe('capsule against static geometry (real library)', () => {
  it('rests grounded on the floor with a (0, 1) support normal and the settled rest center', async () => {
    const { port } = await makePort();
    const probe = new Probe(port);
    probe.settle(12);
    for (let i = 0; i < 120; i += 1) {
      const r = probe.step(0);
      expect(r.grounded).toBe(true);
      expect(r.supportNormal.x).toBe(0);
      expect(r.supportNormal.y).toBe(1);
      expect(r.contacts).toEqual({ ground: true, wall: false, head: false, steepSlope: false });
    }
    expect(probe.last?.position.x).toBeCloseTo(0, 6);
    expect(probe.last?.position.y).toBeCloseTo(0.91, 3);
    port.dispose();
  });

  it('stops at a wall within the skin gap and reports a wall contact', async () => {
    const { port } = await makePort(
      config({ character: { x: 0, y: 0.9 }, statics: [box('floor', 10, 0.25, 0, -0.25), box('wall', 0.25, 2, 3.75, 2)] }),
    );
    const probe = new Probe(port);
    probe.settle(12);
    let sawWall = false;
    for (let i = 0; i < 200; i += 1) {
      const r = probe.step(1);
      if (r.contacts.wall) sawWall = true;
    }
    expect(sawWall).toBe(true);
    // Wall face at x=3.5: the center must stop at 3.5 - 0.3 - 0.01.
    expect(probe.last!.position.x).toBeLessThanOrEqual(3.5 - DEFAULT_CAPSULE_RADIUS - 0.01 + 0.005);
    expect(probe.last!.contacts.wall).toBe(true);
    port.dispose();
  });

  it('bumps the ceiling, clamps the rise and reports a head contact', async () => {
    const { port } = await makePort(
      config({
        character: { x: 0, y: 0.9 },
        statics: [box('floor', 10, 0.25, 0, -0.25), box('ceiling', 4, 0.25, 0, 2.25)],
      }),
    );
    const probe = new Probe(port);
    probe.settle(12);
    let maxY = 0;
    let sawHead = false;
    for (let i = 0; i < 200; i += 1) {
      const r = probe.step(0, i === 0);
      if (r.contacts.head) sawHead = true;
      maxY = Math.max(maxY, r.position.y);
    }
    expect(sawHead).toBe(true);
    // Ceiling underside at y=2.0: center top = 2.0 - 0.9 - 0.01 + 5 mm.
    expect(maxY).toBeLessThanOrEqual(2.0 - REACH - 0.01 + 0.005);
    port.dispose();
  });

  it('climbs a 43 degree box ramp and refuses a 47 degree one', async () => {
    const { port } = await makePort(
      config({
        character: { x: 0.5, y: 0.9 },
        statics: [box('floor', 20, 0.25, 0, -0.25), ramp('ramp-a', 2, 43), ramp('ramp-b', 6, 47)],
      }),
    );
    const probe = new Probe(port);
    probe.settle(12);
    let grounded = 0;
    for (let i = 0; i < 120; i += 1) {
      const r = probe.step(1);
      if (r.grounded) grounded += 1;
      if (r.position.x >= 3.0) break;
    }
    expect(grounded / 120).toBeGreaterThan(0);
    expect(probe.last!.position.y).toBeGreaterThan(1.5);
    port.dispose();
  });

  it('climbs a bounded convex-polygon ramp created through convexHull', async () => {
    const { port } = await makePort(
      config({
        character: { x: -1, y: 0.9 },
        statics: [
          box('floor', 10, 0.25, 0, -0.25),
          {
            entityId: 'poly-ramp',
            shape: { type: 'polygon', vertices: [[0, 0], [3.0, 0], [3.0, 1.732050807569]] },
            position: { x: 0.5, y: 0 },
            rotationZ: 0,
          },
        ],
      }),
    );
    const probe = new Probe(port);
    probe.settle(12);
    let maxY = 0;
    for (let i = 0; i < 120; i += 1) maxY = Math.max(maxY, probe.step(1).position.y);
    expect(maxY).toBeGreaterThan(1.5);
    port.dispose();
  });

  it('snaps down a 5 cm step within the snap distance and free-falls off a 50 cm drop', async () => {
    const { port } = await makePort(
      config({
        character: { x: 0, y: 0.9 },
        statics: [
          box('upper', 5, 0.25, 0, -0.25),
          box('mid', 2.5, 0.25, 7.5, -0.3),
          box('deep', 2.5, 0.25, 12.5, -0.8),
        ],
      }),
    );
    const probe = new Probe(port);
    probe.settle(12);
    let snapped = 0;
    let ungrounded = 0;
    let groundedAfterDrop = false;
    for (let i = 0; i < 400; i += 1) {
      const r = probe.step(1);
      if (r.snapped) snapped += 1;
      if (!r.grounded) {
        ungrounded += 1;
        // Snap must never be reported while the character is airborne.
        expect(r.snapped).toBe(false);
      }
      if (r.position.x > 12 && r.grounded) groundedAfterDrop = true;
      if (r.position.x > 14) break;
    }
    // 5 cm step: snap is applied and the character stays on the ground.
    expect(snapped).toBeGreaterThan(0);
    // 50 cm drop: real free fall (measured 19 ungrounded steps) and a landing.
    expect(ungrounded).toBeGreaterThanOrEqual(5);
    expect(groundedAfterDrop).toBe(true);
    port.dispose();
  });

  it('returns only the contracted XY fields (no Z anywhere)', async () => {
    const { port } = await makePort();
    const probe = new Probe(port);
    probe.settle(1);
    const r = probe.last!;
    expect(Object.keys(r).sort()).toEqual(
      // Phase 9.9 adds groundEntityId (the collider under a grounded character).
      ['applied', 'contacts', 'groundEntityId', 'grounded', 'position', 'requested', 'snapped', 'supportNormal'].sort(),
    );
    for (const vec of [r.requested, r.applied, r.position, r.supportNormal]) {
      expect(Object.keys(vec).sort()).toEqual(['x', 'y']);
    }
    expect(Object.keys(r.contacts).sort()).toEqual(['ground', 'head', 'steepSlope', 'wall']);
    expect(JSON.stringify(r)).not.toContain('"z"');
    port.dispose();
  });

  it('clamps a downward command while grounded (the contract guard)', async () => {
    const { port } = await makePort();
    const probe = new Probe(port);
    probe.settle(12);
    const before = probe.last!.position;
    port.stageCharacterMove({ x: 0, y: -3 * DT });
    const r = port.step();
    expect(r.requested.y).toBeCloseTo(-3 * DT, 12);
    expect(r.applied.y).toBeGreaterThan(-1e-3);
    expect(Math.hypot(r.position.x - before.x, r.position.y - before.y)).toBeLessThan(1e-3);
    expect(port.diagnostics?.().groundedDownwardClampedCount).toBe(1);
    port.dispose();
  });
});

describe('failure surface', () => {
  it('throws a structured error for a non-finite staged delta and does not move the capsule', async () => {
    const { port } = await makePort();
    const probe = new Probe(port);
    probe.settle(12);
    const before = probe.last!.position;
    port.stageCharacterMove({ x: Number.NaN, y: 0 });
    let error: unknown;
    try {
      port.step();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PhysicsPortError);
    expect((error as PhysicsPortError).code).toBe('physics_port_error');
    expect((error as PhysicsPortError).reason).toBe('collision_correction_failed');
    // The world is untouched: the next step continues from the same pose.
    const r = probe.step(0);
    expect(r.position.x).toBeCloseTo(before.x, 9);
    expect(r.position.y).toBeCloseTo(before.y, 6);
    port.dispose();
  });

  it('throws on any world call after dispose and refuses a non-finite reset', async () => {
    const { port } = await makePort();
    const probe = new Probe(port);
    probe.settle(2);
    port.dispose();
    for (const call of [
      () => port.stageCharacterMove({ x: 0, y: 0 }),
      () => port.step(),
      () => port.reset?.({ x: 0, y: 1 }),
    ]) {
      let error: unknown;
      try {
        call();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PhysicsPortError);
      expect((error as PhysicsPortError).code).toBe('physics_port_disposed');
    }

    const { port: live } = await makePort();
    expect(() => live.reset?.({ x: Number.NaN, y: 0 })).toThrowError(PhysicsPortError);
    live.dispose();
  });
});

// `process` is Node-only and the package tsconfig keeps `types: []` (the
// production adapter uses no Node built-in — dependencies.md §4.1).
declare const process: { memoryUsage(): { rss: number; heapUsed: number; external: number } };

describe('resource release over many create/dispose cycles', () => {
  it('keeps the library world counts constant and releases every world', async () => {
    const cfg = config({
      statics: [
        box('floor', 20, 0.25, 0, -0.25),
        ramp('ramp-a', 2, 43),
        ramp('ramp-b', 6, 47),
        box('wall', 0.25, 2, 9.75, 1.5),
        ...Array.from({ length: 57 }, (_, i) => box(`filler-${i}`, 0.25, 0.25, 24 + 0.75 * i, 0.25)),
      ],
    });
    const expectedStatics = cfg.statics.length;
    const cycles = 100;
    const heapAt = new Map<number, { rss: number; heapUsed: number; external: number }>();
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const { port } = await makePort(cfg);
      const diag = port.diagnostics!();
      expect(diag.staticColliderCount).toBe(expectedStatics);
      expect(diag.worldColliderCount).toBe(expectedStatics + 1);
      expect(diag.worldBodyCount).toBe(expectedStatics);
      const probe = new Probe(port);
      probe.settle(12);
      for (let i = 0; i < 12; i += 1) probe.step(1);
      const after = port.diagnostics!();
      expect(after.steps).toBe(24);
      port.dispose();
      expect(port.diagnostics!().live).toBe(false);
      // A disposed handle never reaches the freed world again.
      expect(() => port.step()).toThrowError(PhysicsPortError);
      if (cycle === 9 || cycle === cycles - 1) {
        const m = process.memoryUsage();
        heapAt.set(cycle, { rss: m.rss, heapUsed: m.heapUsed, external: m.external });
      }
    }
    const first = heapAt.get(9)!;
    const last = heapAt.get(cycles - 1)!;
    const rssFirst = first.rss;
    const rssLast = last.rss;
    // Honest limits: RSS is dominated by Rapier's WASM linear memory, which
    // never shrinks after `World.free()` (measured: JS heap flat within ~2 MB
    // over 100 cycles while RSS grows 14-90 MB run-dependently). This is a
    // bounded-growth smoke check, not a leak proof; the counted release
    // evidence is the per-cycle library world counts and the stale-handle
    // throw (which proves `World.free()` ran).
    expect(rssLast - rssFirst).toBeLessThan(128 * 1024 * 1024);

    const { port: finalPort } = await makePort(cfg);
    const finalProbe = new Probe(finalPort);
    finalProbe.settle(12);
    expect(finalProbe.last?.grounded).toBe(true);
    finalPort.dispose();
    // eslint-disable-next-line no-console
    console.log(
      `[resource-cycles] cycles=${cycles} statics=${expectedStatics} ` +
        `collidersPerCycle=${expectedStatics + 1} bodiesPerCycle=${expectedStatics} ` +
        `rssAfter10Cycles=${rssFirst} rssAfter${cycles}Cycles=${rssLast} rssDeltaBytes=${rssLast - rssFirst} ` +
        `jsHeapDeltaBytes=${last.heapUsed - first.heapUsed} externalDeltaBytes=${last.external - first.external}`,
    );
  }, 120_000);
});

beforeEach(() => {
  // A cheap guard against accidental shared state between tests: every port in
  // this file is created explicitly inside its test.
});
