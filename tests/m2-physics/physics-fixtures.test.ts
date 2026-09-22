/**
 * Packet 31 — fixture replay through the real library
 * (`fixtures/m2/physics/cases.json` + the four course fixtures).
 *
 * Every case is driven through the real `@thirdlight/physics-rapier` adapter
 * (the pinned `@dimforge/rapier2d-compat@0.20.0` WASM, not a mock) with the
 * packet-14 canonical character model, and every per-step result is checked
 * with the runtime's own accepted `validateCharacterMoveResult`.
 *
 * The expectation bands come from `fixtures/m2/physics/**` (frozen packet-14
 * course tolerances and `docs/planning/m2-contracts/physics.md` §7/§8); the
 * measured values are recorded in `docs/acceptance/evidence-m2/31/`.
 */
import { describe, expect, it } from 'vitest';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import {
  buildConfig,
  evaluate,
  fixture,
  runCase,
  type CourseFile,
  type PhysicsCase,
} from './helpers';

interface CaseFile {
  kind: string;
  cases: PhysicsCase[];
}

const cases = fixture<CaseFile>('cases.json');
const courses = new Map<string, CourseFile>();
for (const name of ['course.json', 'snap-course.json', 'slope-course.json', 'convex-course.json']) {
  courses.set(name, fixture<CourseFile>(name));
}

describe('frozen course geometry', () => {
  it('carries the 64 static colliders of the packet-14 frozen course', () => {
    const course = courses.get('course.json')!;
    expect(course.statics).toHaveLength(64);
    expect(course.statics.filter((s) => s.shape && (s.shape as { type?: string }).type === 'polygon')).toHaveLength(0);
    expect(course.solver).toEqual({ hz: 120, gravityY: -19.62 });
    expect(course.controller).toMatchObject({ offsetSkin: 0.01, groundSnap: 0.1, autostep: false });
  });

  it('matches the frozen packet-14 ramp geometry exactly', () => {
    const course = courses.get('course.json')!;
    const rampA = course.statics.find((s) => s.entityId === 'rampA43')!;
    expect(rampA.position.x).toBeCloseTo(3.097030552429, 12);
    expect(rampA.position.y).toBeCloseTo(1.022997540094, 12);
    expect(rampA.rotationZ).toBeCloseTo((43 * Math.PI) / 180, 12);
    const rampB = course.statics.find((s) => s.entityId === 'rampB47')!;
    expect(rampB.rotationZ).toBeCloseTo((47 * Math.PI) / 180, 12);
  });
});

describe('physics cases (real Rapier 2D)', () => {
  for (const physicsCase of cases.cases) {
    it(`${physicsCase.id} — ${physicsCase.description}`, async () => {
      const course = courses.get(physicsCase.course);
      expect(course, `course ${physicsCase.course} must exist`).toBeDefined();
      const init = await createPhysicsPort(buildConfig(course!, physicsCase.start));
      expect(init.ok, `${physicsCase.id} init failed: ${JSON.stringify(init.ok ? null : init.error)}`).toBe(true);
      if (!init.ok) return;
      try {
        const run = runCase(init.port, course!, physicsCase);
        const failures = evaluate(run, physicsCase, physicsCase.start.y);
        expect(failures).toEqual([]);
        // The measured summary is emitted for the evidence manifest.
        const results = run.records.map((r) => r.result);
        const summary = {
          steps: results.length,
          grounded: results.filter((r) => r.grounded).length,
          snapped: results.filter((r) => r.snapped).length,
          end: results[results.length - 1]?.position,
          diagnostics: init.port.diagnostics?.(),
        };
        expect(summary.steps).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(`[${physicsCase.id}] ${JSON.stringify(summary)}`);
      } finally {
        init.port.dispose();
      }
    }, 60_000);
  }
});
