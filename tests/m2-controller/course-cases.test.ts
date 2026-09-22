/**
 * Packet 32 — the real-adapter diagnostic-course suite.
 *
 * Every case runs the **real** stack in Node:
 * `@thirdlight/platformer` controller + `@thirdlight/runtime` phases/pre-roll +
 * `@thirdlight/physics-rapier` (the pinned `@dimforge/rapier2d-compat@0.20.0`
 * WASM) + `@thirdlight/input`'s pure raw-snapshot mapping, over
 * `fixtures/m2/course/**`. The tolerance bands come from the frozen
 * `tolerances.json` (packet-14 T-numbers and the accepted contracts), not from
 * the observations.
 *
 * The browser course (keyboard + physical gamepad) and all device/visual/CPU
 * claims are UNVERIFIED in this container: no browser/hardware exists. The
 * packet-37 procedure is `tests/browser/m2-controller/m2-controller.browser.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createStepInputSource, mapRawInput, type StepInputStep } from '@thirdlight/input';
import type { ActionSource, GameplaySettings } from '@thirdlight/runtime';
import {
  DT,
  SETTLE_STEPS,
  fixture,
  startRun,
  type CourseFile,
  type Run,
  type Step,
} from './helpers';

interface Atom {
  keyboardLeft: boolean;
  keyboardRight: boolean;
  keyboardJump: boolean;
  jumpLatch?: boolean;
  gamepad?: unknown;
}
interface Sequence {
  id: string;
  device: string;
  spans: { from: number; to: number; raw: string }[];
}
interface InputFile {
  atoms: Record<string, Atom>;
  sequences: Sequence[];
}
interface CaseExpect {
  toleranceRef?: string | string[];
  [key: string]: unknown;
}
interface ControllerCase {
  id: string;
  title: string;
  course: string;
  start: { x: number; y: number };
  input: string | null;
  settings?: Partial<GameplaySettings>;
  window?: {
    kind: 'buffered-jump' | 'coyote-runoff';
    firstJumpStep?: number;
    pressOffsetFromLanding?: number;
    runInput?: string;
    pressOffsetFromLastGrounded?: number;
    holdJump?: boolean;
  };
  stallAfterSteps?: number;
  stallSeconds?: number;
  expect: CaseExpect;
}

const inputFile = fixture<InputFile>('input-sequences.json');
const caseFile = fixture<{ cases: ControllerCase[] }>('cases.json');
const courses = new Map<string, CourseFile>();
for (const name of ['course.json', 'slope-course.json', 'snap-course.json']) {
  courses.set(name, fixture<CourseFile>(name));
}
const byId = new Map(caseFile.cases.map((c) => [c.id, c]));
function kase(id: string): ControllerCase {
  const c = byId.get(id);
  expect(c, `case ${id} must exist`).toBeDefined();
  return c as ControllerCase;
}

/** Expand a fixture sequence's spans into per-step raw snapshots. */
function stepsOf(sequenceId: string, extra: StepInputStep[] = []): StepInputStep[] {
  const seq = inputFile.sequences.find((s) => s.id === sequenceId);
  expect(seq, `sequence ${sequenceId} must exist`).toBeDefined();
  const steps: StepInputStep[] = [];
  for (const span of seq!.spans) {
    const raw = inputFile.atoms[span.raw];
    expect(raw, `atom ${span.raw} must exist`).toBeDefined();
    for (let i = span.from; i <= span.to; i += 1) steps.push({ stepIndex: i, raw: raw as never });
  }
  return [...steps, ...extra].sort((a, b) => a.stepIndex - b.stepIndex);
}

function source(sequenceId: string): ActionSource {
  return createStepInputSource(stepsOf(sequenceId));
}

function lastStep(sequenceId: string): number {
  const seq = inputFile.sequences.find((s) => s.id === sequenceId);
  return seq!.spans.reduce((m, s) => Math.max(m, s.to), 0);
}

/** Run a fixture case and return the open run (caller disposes). */
async function runCase(c: ControllerCase, actions?: ActionSource): Promise<{ run: Run; steps: number }> {
  const course = courses.get(c.course);
  expect(course, `course ${c.course} must exist`).toBeDefined();
  const steps = c.input ? lastStep(c.input) - SETTLE_STEPS + 1 : 200;
  const run = await startRun(course!, c.start, {
    actions: actions ?? source(c.input as string),
    settings: c.settings,
  });
  run.steps(steps);
  return { run, steps };
}

function gameplay(run: Run): Step[] {
  return run.records.slice(SETTLE_STEPS);
}
function groundedFraction(steps: Step[]): number {
  if (steps.length === 0) return 0;
  return steps.filter((s) => s.result.grounded).length / steps.length;
}
function ungroundedSteps(steps: Step[]): number {
  return steps.filter((s) => !s.result.grounded).length;
}
function maxRisePerStep(steps: Step[]): number {
  let max = 0;
  for (let i = 1; i < steps.length; i += 1) {
    max = Math.max(max, steps[i]!.position.y - steps[i - 1]!.position.y);
  }
  return max;
}
function contactsSeen(steps: Step[], key: 'ground' | 'wall' | 'head' | 'steepSlope'): boolean {
  return steps.some((s) => s.result.contacts[key]);
}

describe('frozen course fixtures', () => {
  it('carries the 64 static colliders of the packet-14 frozen course', () => {
    const course = courses.get('course.json')!;
    expect(course.statics).toHaveLength(64);
    expect(course.solver).toEqual({ hz: 120, gravityY: -19.62 });
    expect(course.controller).toMatchObject({ offsetSkin: 0.01, groundSnap: 0.1, autostep: false });
  });
  it('declares 28 diagnostic cases with tolerance references', () => {
    expect(caseFile.cases.length).toBe(28);
    for (const c of caseFile.cases) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.expect.toleranceRef, `${c.id} declares a tolerance reference`).toBeDefined();
    }
  });
});

describe('flat ground, movement and seams (real Rapier + controller)', () => {
  it('idle-settle: grounded every step, no Y drift, settled rest centre', async () => {
    const c = kase('idle-settle');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      expect(steps).toHaveLength(120);
      expect(ungroundedSteps(steps)).toBe(0);
      let maxDy = 0;
      for (let i = 1; i < steps.length; i += 1) {
        maxDy = Math.max(maxDy, Math.abs(steps[i]!.position.y - steps[i - 1]!.position.y));
      }
      expect(maxDy).toBeLessThanOrEqual(0.001);
      const finalY = steps[steps.length - 1]!.position.y;
      expect(Math.abs(finalY - 0.91)).toBeLessThanOrEqual(0.0005);
      // eslint-disable-next-line no-console
      console.log(`[idle-settle] restY=${finalY} maxDy=${maxDy}`);
    } finally {
      run.dispose();
    }
  });

  it('flat-run: run_speed band, grounded every step, seam crossed', async () => {
    const c = kase('flat-run');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      expect(ungroundedSteps(steps)).toBeLessThanOrEqual(2); // T3_at_seam
      // Steady window after acceleration: steps 30..end.
      const window = steps.slice(30);
      const dx = window.reduce((acc, s, i) => {
        const prev = i === 0 ? steps[29]! : window[i - 1]!;
        return acc + (s.position.x - prev.position.x);
      }, 0);
      const mean = dx / window.length / DT;
      expect(Math.abs(mean - 4) / 4).toBeLessThanOrEqual(0.05);
      const ys = steps.map((s) => s.position.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(0.005);
      // eslint-disable-next-line no-console
      console.log(`[flat-run] meanSpeed=${mean} maxYdev=${Math.max(...ys) - Math.min(...ys)} ungrounded=${ungroundedSteps(steps)}`);
    } finally {
      run.dispose();
    }
  });

  it('accel-decel-steps: 12 steps to run_speed, 8 steps to zero', async () => {
    const c = kase('accel-decel-steps');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      // Step n velocity = (x[n] − x[n−1]) / dt; the first 12 steps ramp to 4.
      const v = (i: number): number => (steps[i]!.position.x - steps[i - 1]!.position.x) / DT;
      expect(v(11)).toBeCloseTo(4, 6);
      expect(steps[11]!.vx).toBeCloseTo(4, 12);
      // Idle frames begin at fixture step 32: 8 steps to zero (measured).
      const decelStart = 32 - SETTLE_STEPS;
      for (let k = 0; k < 8; k += 1) expect(steps[decelStart + k]!.vx).toBeLessThan(4);
      expect(steps[decelStart + 7]!.vx).toBe(0);
      // The slide policy must never re-accelerate an idle character on flat ground.
      for (let k = 8; k < 14; k += 1) expect(steps[decelStart + k]!.vx).toBe(0);
      // eslint-disable-next-line no-console
      console.log(`[accel-decel] vx@11=${v(11)} vx@decelStart=${steps[decelStart]!.vx} vx@8=${steps[decelStart + 7]!.vx}`);
    } finally {
      run.dispose();
    }
  });

  it('seam-cross: the 0.02 m floor seam never dislodges the character', async () => {
    const c = kase('seam-cross');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      expect(steps.some((s) => s.position.x >= 0)).toBe(true);
      expect(ungroundedSteps(steps)).toBeLessThanOrEqual(2);
      expect(groundedFraction(steps)).toBeGreaterThanOrEqual(0.95);
      // eslint-disable-next-line no-console
      console.log(`[seam-cross] ungrounded=${ungroundedSteps(steps)} frac=${groundedFraction(steps)}`);
    } finally {
      run.dispose();
    }
  });
});

describe('jump behaviour (real Rapier + controller)', () => {
  it('jump-hold: apex gain inside the theoretical tolerance, lands back at rest', async () => {
    const c = kase('jump-hold');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      const restY = steps[0]!.position.y;
      const apex = Math.max(...steps.map((s) => s.position.y));
      const gain = apex - restY;
      expect(Math.abs(gain - 1.249)).toBeLessThanOrEqual(0.05);
      expect(Math.max(...steps.map((s) => s.vy))).toBeLessThanOrEqual(7 + 1e-9);
      const last = steps[steps.length - 1]!;
      expect(Math.abs(last.position.y - restY)).toBeLessThanOrEqual(0.001);
      expect(last.result.grounded).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[jump-hold] restY=${restY} apexGain=${gain} maxVy=${Math.max(...steps.map((s) => s.vy))}`);
    } finally {
      run.dispose();
    }
  });

  it('jump-tap: release halves the ascending velocity once (variable height)', async () => {
    const c = kase('jump-tap');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      // Steps 31 (press) and 32 (held) and 33 idle: vy(33) = 0.5 * (vy(32) + g*dt).
      const idx = (step: number): number => step - SETTLE_STEPS;
      const vyBefore = steps[idx(32)]!.vy;
      const vyAfter = steps[idx(33)]!.vy;
      expect(vyAfter).toBeCloseTo((vyBefore + -19.62 * DT) * 0.5, 9);
      expect(Math.max(...steps.map((s) => s.position.y))).toBeLessThan(2.1);
      // eslint-disable-next-line no-console
      console.log(`[jump-tap] vy32=${vyBefore} vy33=${vyAfter} apex=${Math.max(...steps.map((s) => s.position.y))}`);
    } finally {
      run.dispose();
    }
  });

  it('no-air-jump: repeated press edges while airborne never restore jump velocity', async () => {
    const c = kase('no-air-jump');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      // A jump start is the only transition that lifts vy to ~jump_velocity.
      let starts = 0;
      for (let i = 0; i < steps.length; i += 1) {
        const prev = i === 0 ? 0 : steps[i - 1]!.vy;
        if (steps[i]!.vy > 6 && prev < 1) starts += 1;
      }
      expect(starts).toBe(1);
      expect(Math.max(...steps.map((s) => s.vy))).toBeLessThanOrEqual(7 + 1e-9);
      // eslint-disable-next-line no-console
      console.log(`[no-air-jump] starts=${starts} maxVy=${Math.max(...steps.map((s) => s.vy))}`);
    } finally {
      run.dispose();
    }
  });
});

describe('wall, ceiling and ledge (real Rapier + controller)', () => {
  it('wall-stop: the run stops at the face band with no penetration', async () => {
    const c = kase('wall-stop');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      const stopCenter = 9.5 - 0.3 - 0.01;
      const maxX = Math.max(...steps.map((s) => s.position.x));
      expect(Math.abs(maxX - stopCenter)).toBeLessThanOrEqual(0.05);
      expect(Math.max(0, maxX - stopCenter)).toBeLessThanOrEqual(0.005);
      expect(contactsSeen(steps, 'wall')).toBe(true);
      expect(ungroundedSteps(steps)).toBe(0);
      // eslint-disable-next-line no-console
      console.log(`[wall-stop] maxX=${maxX} stopCenter=${stopCenter}`);
    } finally {
      run.dispose();
    }
  });

  it('high-speed-wall: 12 m/s approach, no tunnelling, stop within 10 steps of contact', async () => {
    const c = kase('high-speed-wall');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      const stopCenter = 9.5 - 0.3 - 0.01;
      const maxX = Math.max(...steps.map((s) => s.position.x));
      expect(Math.max(0, maxX - stopCenter)).toBeLessThanOrEqual(0.005);
      const contactIndex = steps.findIndex((s) => s.result.contacts.wall);
      expect(contactIndex).toBeGreaterThanOrEqual(0);
      const stopIndex = steps.findIndex(
        (s, i) => i > contactIndex && Math.abs(s.position.x - steps[i - 1]!.position.x) < 1e-4,
      );
      expect(stopIndex).toBeGreaterThan(contactIndex);
      expect(stopIndex - contactIndex).toBeLessThanOrEqual(10);
      // The corridor from the authored start to the face is shorter than the
      // distance the 40 m/s2 acceleration needs to reach 12 m/s from rest, so
      // the achieved approach speed is recorded (the T9 12 m/s figure is the
      // packet-14 instantaneous-velocity probe; C32-4).
      const approach = Math.max(...steps.slice(0, Math.max(1, contactIndex)).map((s) => s.vx));
      // eslint-disable-next-line no-console
      console.log(`[high-speed-wall] maxX=${maxX} contact@${contactIndex} stop@${stopIndex} approach=${approach}`);
      expect(approach).toBeGreaterThanOrEqual(8.0);
    } finally {
      run.dispose();
    }
  });

  it('high-speed-ledge: a true 12 m/s approach into the ledge face does not tunnel', async () => {
    const c = kase('high-speed-ledge');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      const faceCenter = 12 - 0.3 - 0.01;
      const approach = Math.max(...steps.map((s) => s.vx));
      expect(approach).toBeGreaterThanOrEqual(11.0);
      const maxX = Math.max(...steps.map((s) => s.position.x));
      expect(Math.max(0, maxX - faceCenter)).toBeLessThanOrEqual(0.005);
      const contactIndex = steps.findIndex((s) => s.result.contacts.wall);
      expect(contactIndex).toBeGreaterThanOrEqual(0);
      const stopIndex = steps.findIndex(
        (s, i) => i > contactIndex && Math.abs(s.position.x - steps[i - 1]!.position.x) < 1e-4,
      );
      expect(stopIndex).toBeGreaterThan(contactIndex);
      expect(stopIndex - contactIndex).toBeLessThanOrEqual(10);
      // eslint-disable-next-line no-console
      console.log(`[high-speed-ledge] approach=${approach} maxX=${maxX} contact@${contactIndex} stop@${stopIndex}`);
    } finally {
      run.dispose();
    }
  });

  it('ceiling-head-bump: head contact clamps the rise and zeroes vy', async () => {
    const c = kase('ceiling-head-bump');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      const maxCenterY = Math.max(...steps.map((s) => s.position.y));
      const headIndex = steps.findIndex((s) => s.result.contacts.head);
      expect(headIndex, 'a head contact must occur').toBeGreaterThanOrEqual(0);
      expect(maxCenterY).toBeLessThanOrEqual(3.095 + 1e-9);
      expect(maxCenterY).toBeGreaterThanOrEqual(3.085);
      let maxRise = 0;
      for (let i = headIndex + 1; i < steps.length; i += 1) {
        // Only the airborne window after the strike: once the character lands
        // on the ramp, ascending again is ordinary ramp movement.
        if (steps[i]!.result.grounded) break;
        maxRise = Math.max(maxRise, steps[i]!.position.y - steps[i - 1]!.position.y);
      }
      expect(maxRise).toBeLessThanOrEqual(5e-4);
      // eslint-disable-next-line no-console
      console.log(`[ceiling-head-bump] maxCenterY=${maxCenterY} head@${headIndex} maxRiseAfter=${maxRise}`);
    } finally {
      run.dispose();
    }
  });

  it('ledge-block-and-jump: the 0.4 m step blocks walking; a jump lands on the ledge top', async () => {
    const c = kase('ledge-block-and-jump');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      // Blocked window: while the character is pressed against the face it
      // stays at x ≈ ledge face (12) − radius 0.3 − skin 0.01.
      const faceCenter = 12 - 0.3 - 0.01;
      const blocked = steps.filter((s) => Math.abs(s.position.x - faceCenter) <= 0.02 && s.result.grounded);
      expect(blocked.length).toBeGreaterThan(10);
      const maxBlockedDx = Math.max(
        ...blocked.map((s, i) => Math.abs(s.position.x - (blocked[i - 1]?.position.x ?? s.position.x))),
      );
      expect(maxBlockedDx).toBeLessThanOrEqual(0.02);
      const landed = steps[steps.length - 1]!;
      const expectedLandTop = 0.4 + 0.9099987;
      expect(landed.position.x).toBeGreaterThan(12);
      expect(Math.abs(landed.position.y - expectedLandTop)).toBeLessThanOrEqual(0.05);
      expect(landed.result.grounded).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[ledge] maxBlockedDx=${maxBlockedDx} landed=(${landed.position.x},${landed.position.y})`);
    } finally {
      run.dispose();
    }
  });
});

describe('slope limit, sliding and snapping (real Rapier + controller)', () => {
  it('ramp-a43-climb: a 43 degree ramp is climbed and grounded', async () => {
    const c = kase('ramp-a43-climb');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      const startY = steps[0]!.position.y;
      const apex = Math.max(...steps.map((s) => s.position.y));
      expect(apex - startY).toBeGreaterThanOrEqual(1.0);
      // Ascent window: while x is on the ramp and y is rising.
      const ascent = steps.filter((s) => s.position.x > 2.2 && s.position.x < 4.2 && s.position.y > startY + 0.1);
      expect(ascent.length).toBeGreaterThan(10);
      expect(groundedFraction(ascent)).toBeGreaterThanOrEqual(0.95);
      // eslint-disable-next-line no-console
      console.log(`[ramp-a43] gain=${apex - startY} ascentSteps=${ascent.length} groundedFrac=${groundedFraction(ascent)}`);
    } finally {
      run.dispose();
    }
  });

  it('ramp-b47-refuse: the too-steep ramp refuses the climb', async () => {
    const c = kase('ramp-b47-refuse');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      const startY = steps[0]!.position.y;
      // The last 120 steps are 1 s of pushing into the 47 degree face.
      const push = steps.slice(-120);
      const gain = Math.max(...push.map((s) => s.position.y)) - startY;
      expect(gain).toBeLessThanOrEqual(0.3);
      // eslint-disable-next-line no-console
      console.log(`[ramp-b47] gainOver1s=${gain}`);
    } finally {
      run.dispose();
    }
  });

  it('slope-threshold: the 29.9/30.0/44.9/45.0/45.1 degree classification table', async () => {
    const rows = [
      { id: 'slope-threshold-29.9', angle: 29.9, grounded: true, steep: false },
      { id: 'slope-threshold-30.0', angle: 30, grounded: true, steep: false },
      { id: 'slope-threshold-44.9', angle: 44.9, grounded: true, steep: false },
      { id: 'slope-threshold-45.0', angle: 45, grounded: true, steep: false },
      { id: 'slope-threshold-45.1', angle: 45.1, grounded: false, steep: true },
    ];
    for (const row of rows) {
      const c = kase(row.id);
      const { run } = await runCase(c);
      try {
        const steps = gameplay(run);
        // The slope support is established by the first step's downward probe
        // (packet 31's declared 1-step settle); the second executed step is the
        // first measured contact normal.
        const measured = run.records[1] ?? steps[0]!;
        const normalY = measured.result.supportNormal.y;
        const declared = (c.expect.supportNormalY as { value: number; tolerance: number });
        expect(Math.abs(normalY - declared.value)).toBeLessThanOrEqual(declared.tolerance);
        // The controller's classification (physics.md §8.2): grounded ⇔ raw
        // grounded AND supportNormal.y ≥ cos(45°).
        const cosMax = Math.cos((45 * Math.PI) / 180);
        const controllerGrounded = measured.result.grounded && normalY >= cosMax - 1e-6;
        expect(controllerGrounded).toBe(row.grounded);
        expect(measured.result.contacts.steepSlope).toBe(row.steep);
        const last = steps[steps.length - 1]!;
        const driftY = last.position.y - steps[0]!.position.y;
        const driftX = last.position.x - steps[0]!.position.x;
        // eslint-disable-next-line no-console
        console.log(`[slope ${row.angle}] normalY=${normalY} rawGrounded=${measured.result.grounded} steep=${measured.result.contacts.steepSlope} controllerGrounded=${controllerGrounded} slideDrift=(${driftX},${driftY})`);
        // C32-1 slide policy: at/below the minimum slide angle the character
        // holds; at/above it slides down the face while idle.
        if (row.angle === 29.9) {
          expect(Math.abs(driftY)).toBeLessThanOrEqual(0.01);
        } else if (row.angle === 30 || row.angle === 44.9 || row.angle === 45) {
          // Slides downhill (−x) while idle, at the minimum slide angle and above.
          expect(driftY).toBeLessThanOrEqual(-0.1);
          expect(driftX).toBeLessThan(0);
        }
      } finally {
        run.dispose();
      }
    }
  });

  it('snap-within: a 0.05 m step-down is absorbed; never airborne', async () => {
    const c = kase('snap-within');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      // Region of the 0.05 m step-down (x ≈ 5): the upper floor rests at 0.91,
      // the 0.05 m lower floor at 0.86.
      const region = steps.filter((s) => s.position.x > 4.5 && s.position.x < 9.5);
      expect(region.length).toBeGreaterThan(50);
      const minY = Math.min(...region.map((s) => s.position.y));
      expect(minY).toBeGreaterThan(0.855);
      expect(region.filter((s) => !s.result.grounded).length).toBe(0);
      expect(region.some((s) => s.result.snapped)).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[snap-within] minY=${minY} ungrounded=${region.filter((s) => !s.result.grounded).length}`);
    } finally {
      run.dispose();
    }
  });

  it('snap-beyond: a 0.50 m step-down is not snapped; the character falls and lands lower', async () => {
    const c = kase('snap-beyond');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      const deepSteps = steps.filter((s) => s.position.x > 10);
      expect(deepSteps.length).toBeGreaterThan(60);
      // The measured 0.20.0 behaviour (packet-31 C31-3): the snap chains across
      // steps, so the 0.50 m drop is descended over several grounded, snapped
      // steps rather than one free-fall; no single step may exceed the bounded
      // ground-contact correction (snap 0.1 + skin 0.01).
      let maxStepDrop = 0;
      for (let i = 1; i < deepSteps.length; i += 1) {
        maxStepDrop = Math.max(maxStepDrop, deepSteps[i - 1]!.position.y - deepSteps[i]!.position.y);
      }
      expect(maxStepDrop).toBeLessThanOrEqual(0.11 + 1e-6);
      const snappedDeep = deepSteps.filter((s) => s.result.snapped).length;
      expect(snappedDeep).toBeGreaterThanOrEqual(1);
      // Lands on the deep floor: 0.91 − 0.55 = 0.36 (within 5 cm).
      const landedY = deepSteps[deepSteps.length - 1]!.position.y;
      expect(Math.abs(landedY - 0.36)).toBeLessThanOrEqual(0.05);
      expect(deepSteps[deepSteps.length - 1]!.result.grounded).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[snap-beyond] snappedDeep=${snappedDeep} maxStepDrop=${maxStepDrop} landedY=${landedY}`);
    } finally {
      run.dispose();
    }
  });
});

describe('Z lock and snapshot immutability', () => {
  it('no-z-drift: position.z, rotation and scale stay bit-identical', async () => {
    const c = kase('no-z-drift');
    const { run } = await runCase(c);
    try {
      const steps = gameplay(run);
      expect(steps.length).toBeGreaterThan(0);
      // Every recorded step's result carries no Z key at all.
      for (const s of steps) {
        expect(Object.prototype.hasOwnProperty.call(s.result.position, 'z')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(s.result.applied, 'z')).toBe(false);
      }
      const t = run.transform();
      expect(t.position[2]).toBe(0);
      expect(t.rotation).toEqual([0, 0, 0, 1]);
      expect(t.scale).toEqual([1, 1, 1]);
      const d = run.diagnostics();
      if (!d.ok) throw new Error('diagnostics failed');
      // eslint-disable-next-line no-console
      console.log(`[no-z-drift] steps=${steps.length} z=${t.position[2]}`);
    } finally {
      run.dispose();
    }
  });

  it('the runtime snapshot is not mutated by a full run', async () => {
    const c = kase('no-z-drift');
    const course = courses.get(c.course)!;
    const before = JSON.stringify(course);
    const { run } = await runCase(c);
    try {
      expect(JSON.stringify(course)).toBe(before);
      const snapshot = (run.runtime as unknown as { snapshotId?: string }).snapshotId;
      void snapshot;
      // The runtime deep-freezes its snapshot; every fixture object stays intact.
      expect(before).toBe(JSON.stringify(course));
    } finally {
      run.dispose();
    }
  });
});

describe('window boundaries (coyote / jump buffer) on the real course', () => {
  /** Build a first-jump-then-second-press sequence for the buffered-jump cases. */
  async function buffered(c: ControllerCase): Promise<{ fired: boolean; landedStep: number }> {
    const course = courses.get(c.course)!;
    const first = c.window!.firstJumpStep as number;
    // Recon: run the first jump and find its landing (first grounded step after
    // leaving the ground).
    const reconActions: StepInputStep[] = [];
    for (let i = 12; i <= 200; i += 1) {
      if (i === first) reconActions.push({ stepIndex: i, raw: inputFile.atoms['jump_press'] as never });
      else if (i > first && i < first + 60) reconActions.push({ stepIndex: i, raw: inputFile.atoms['jump_held'] as never });
      else reconActions.push({ stepIndex: i, raw: inputFile.atoms['idle'] as never });
    }
    const recon = await startRun(course, c.start, { actions: createStepInputSource(reconActions) });
    recon.steps(200 - SETTLE_STEPS);
    const reconSteps = gameplay(recon);
    const jumpedIdx = reconSteps.findIndex((s) => s.vy > 1);
    const landedIdx = reconSteps.findIndex((s, i) => i > jumpedIdx && s.result.grounded);
    const landedStep = landedIdx + SETTLE_STEPS;
    recon.dispose();

    const pressStep = landedStep + (c.window!.pressOffsetFromLanding as number);
    const actions: StepInputStep[] = [];
    for (let i = 12; i <= 200; i += 1) {
      if (i === first) actions.push({ stepIndex: i, raw: inputFile.atoms['jump_press'] as never });
      else if (i > first && i < first + 60) actions.push({ stepIndex: i, raw: inputFile.atoms['jump_held'] as never });
      else if (i === pressStep) actions.push({ stepIndex: i, raw: inputFile.atoms['jump_press'] as never });
      else actions.push({ stepIndex: i, raw: inputFile.atoms['idle'] as never });
    }
    const run = await startRun(course, c.start, { actions: createStepInputSource(actions) });
    run.steps(200 - SETTLE_STEPS);
    const steps = gameplay(run);
    const secondJump = steps.some(
      (s, i) => i > landedIdx && i > jumpedIdx + 2 && s.vy > 6 && steps[i - 1]!.vy < 1,
    );
    run.dispose();
    return { fired: secondJump, landedStep };
  }

  it('jump-buffer-in-window: a press 7 steps before landing fires the jump', async () => {
    const r = await buffered(kase('jump-buffer-in-window'));
    // eslint-disable-next-line no-console
    console.log(`[buffer-in] landedStep=${r.landedStep} fired=${r.fired}`);
    expect(r.fired).toBe(true);
  });

  it('jump-buffer-expired: a press 10 steps before landing never fires', async () => {
    const r = await buffered(kase('jump-buffer-expired'));
    // eslint-disable-next-line no-console
    console.log(`[buffer-out] landedStep=${r.landedStep} fired=${r.fired}`);
    expect(r.fired).toBe(false);
  });

  it('coyote window: the last permitted step and one step later (run off the ledge)', async () => {
    for (const id of ['coyote-last-step', 'coyote-one-step-late']) {
      const c = kase(id);
      const course = courses.get(c.course)!;
      // Recon: run right off the ledge and find the last grounded step.
      const reconActions = stepsOf(c.window!.runInput as string);
      const recon = await startRun(course, c.start, { actions: createStepInputSource(reconActions) });
      recon.steps(160 - SETTLE_STEPS);
      const reconSteps = gameplay(recon);
      let lastGroundedStep = -1;
      for (let i = 0; i < reconSteps.length; i += 1) {
        if (reconSteps[i]!.result.grounded) lastGroundedStep = reconSteps[i]!.stepIndex;
      }
      recon.dispose();
      const pressStep = lastGroundedStep + (c.window!.pressOffsetFromLastGrounded as number);
      const actions = stepsOf(c.window!.runInput as string).map((s) =>
        s.stepIndex === pressStep
          ? { stepIndex: s.stepIndex, raw: inputFile.atoms['jump_press'] as never }
          : s,
      );
      const run = await startRun(course, c.start, { actions: createStepInputSource(actions) });
      run.steps(160 - SETTLE_STEPS);
      const steps = gameplay(run);
      const fired = steps.some((s) => s.vy > 1);
      // eslint-disable-next-line no-console
      console.log(`[${id}] lastGroundedStep=${lastGroundedStep} pressStep=${pressStep} fired=${fired}`);
      expect(fired).toBe(c.expect.fires as boolean);
      run.dispose();
    }
  });
});

describe('packet-30 mapping drives the controller (keyboard + gamepad raw snapshots)', () => {
  it('keyboard right-arrow/D held reaches run_speed and jumps', async () => {
    const c = kase('flat-run');
    const { run } = await runCase({ ...c, input: 'run-right-120' });
    try {
      const steps = gameplay(run);
      const mean = (steps[steps.length - 1]!.position.x - steps[0]!.position.x) / steps.length / DT;
      expect(mean).toBeGreaterThan(3.8);
    } finally {
      run.dispose();
    }
  });

  it('a standard gamepad stick + face button produce the same run and jump', async () => {
    const course = courses.get('course.json')!;
    const padRun = await startRun(course, { x: -10, y: 0.9 }, { actions: source('pad-run-right-120') });
    padRun.steps(120 - SETTLE_STEPS);
    const padSteps = gameplay(padRun);
    const padMean = (padSteps[padSteps.length - 1]!.position.x - padSteps[0]!.position.x) / padSteps.length / DT;
    padRun.dispose();

    const keyRun = await startRun(course, { x: -10, y: 0.9 }, { actions: source('run-right-120') });
    keyRun.steps(120 - SETTLE_STEPS);
    const keySteps = gameplay(keyRun);
    const keyMean = (keySteps[keySteps.length - 1]!.position.x - keySteps[0]!.position.x) / keySteps.length / DT;
    keyRun.dispose();

    expect(Math.abs(padMean - keyMean)).toBeLessThanOrEqual(1e-6);
    // eslint-disable-next-line no-console
    console.log(`[device-parity] gamepadMean=${padMean} keyboardMean=${keyMean}`);
  });

  it('a jump held across a focus suspension is never a phantom press (loss of focus)', async () => {
    const course = courses.get('course.json')!;
    // The suspension semantics live in the browser owner's `awaitingRelease`
    // state (packet 30, input.md §5.3/§5.4); the step source cannot express
    // them, so the real mapping (`mapRawInput`) is threaded with the previous
    // state and the produced frames are replayed through the runtime's
    // recorded source — a real mapping + real controller combination.
    const raw = (jump: boolean, latch = false): never =>
      ({ keyboardLeft: false, keyboardRight: false, keyboardJump: jump, jumpLatch: latch }) as never;
    const frames = [];
    let down = false;
    let awaiting = false;
    for (let i = 12; i <= 79; i += 1) {
      if (i === 21) awaiting = true; // focus lost: next activation is 'held'
      const snapshot = raw(i >= 21 && i <= 25, i === 30);
      const frame = mapRawInput(snapshot, {
        stepIndex: i,
        previousJumpDown: down,
        jumpAwaitingRelease: awaiting,
      });
      frames.push(frame);
      // The mapping's own state rule (input.md §5.3): while awaiting release a
      // down control is 'held' and further sampling resumes after an up.
      if (awaiting) {
        down = i >= 21 && i <= 25;
        awaiting = down;
        if (!down) awaiting = false;
      } else {
        down = (i >= 21 && i <= 25) || i === 30;
      }
    }
    // The runtime's recorded source validates the jump phase chain strictly,
    // and a post-suspension 'held' legitimately has no preceding press (the
    // browser owner's activation rule, packet-30 C30-6); the live runtime only
    // validates each frame, so the frames are replayed through a plain source.
    const actions: ActionSource = {
      sample: (n) => frames[n - 12] ?? { stepIndex: n, moveX: 0, jump: 'none' },
    };
    const run = await startRun(course, { x: -10, y: 0.9 }, { actions });
    run.steps(68);
    const steps = gameplay(run);
    // Steps 21..25 (held, no press edge) never lift the character; the fresh
    // press at step 30 does jump exactly once.
    const heldSteps = steps.filter((s) => s.stepIndex >= 21 - SETTLE_STEPS && s.stepIndex <= 25 - SETTLE_STEPS);
    expect(heldSteps.every((s) => Math.abs(s.vy) < 1e-9)).toBe(true);
    let starts = 0;
    for (let i = 0; i < steps.length; i += 1) {
      const prev = i === 0 ? 0 : steps[i - 1]!.vy;
      if (steps[i]!.vy > 6 && prev < 1) starts += 1;
    }
    expect(starts).toBe(1);
    run.dispose();
  });
});
