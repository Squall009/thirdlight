/**
 * Packet 49 — the M3 run state machine against the promoted run fixtures
 * (`fixtures/m3/gameplay/run/**`): `states.json` (transitions T1–T8, queue
 * semantics, failure-is-not-death), `respawn-timing.json` (the exact bounded
 * respawn delay), `events-bound.json` (the ≤ 32 event ring),
 * `failure-phases.json` (the last-committed-state claim for every failure
 * phase) and `game-view.json` (view identity/staleness/playerMotion
 * derivation).
 *
 * The harness drives the real `GameSession` (the runtime-owned run state —
 * gameplay.md §1 ownership table) exactly as the fixture checker's replay
 * engine does: the run command queue, the per-step boundary and the
 * committed view bookkeeping are the implementation under test. The zone
 * *decisions* (the §4.2 swept-capsule predicate) are computed by the test
 * harness from the fixture's virtual `from`/`to` positions and committed
 * through the same session transitions the `gameplay`-phase module commits
 * through the port in a real run. The predicate mirror below is byte-for-byte
 * the contract's closed form (gameplay.md §4.2); the authoritative
 * re-derivation of the fixtures against the predicate is
 * `fixtures/m3/gameplay/tools/check-fixtures.mjs` (the green-bar 34/34).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GameSession,
  MAX_GAME_EVENTS,
  RESPAWN_DELAY_STEPS,
  type GameView,
  type RunState,
} from '@thirdlight/runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_FIXTURES = join(HERE, '..', '..', 'fixtures', 'm3', 'gameplay', 'run');

/** gameplay.md §4.2 / §8.2 contract constants (the checker's, verbatim). */
const CAPSULE_RADIUS = 0.3;
const CAPSULE_HALF_HEIGHT = 0.6;
const ZONE_OVERLAP_EPS = 1e-9;
const SIM_HZ = 120;

type Pt = [number, number];
interface FixtureZone {
  id: string;
  role: 'hazard' | 'checkpoint' | 'goal';
  center: Pt;
  size: Pt;
}
interface FixtureFile {
  fixtureVersion: number;
  snapshotId: string;
  killY: number;
  zones: FixtureZone[];
  spawnId: string;
  safeSpawnId: string;
  firstStep: number;
  cases: FixtureCase[];
}
interface FixtureCase {
  id: string;
  script: unknown[];
  expect: Record<string, unknown>;
}

function loadFixture(name: string): FixtureFile {
  return JSON.parse(readFileSync(join(RUN_FIXTURES, name), 'utf8')) as FixtureFile;
}

// ---------------------------------------------------------------------------
// The §4.2 swept-capsule predicate (mirror; see the file header).
// ---------------------------------------------------------------------------

function zoneTest(from: Pt, to: Pt, zone: FixtureZone): { overlap: boolean } {
  const hx = zone.size[0] / 2;
  const hy = zone.size[1] / 2;
  const [cx, cy] = zone.center;
  const rx0 = Math.min(from[0], to[0]);
  const rx1 = Math.max(from[0], to[0]);
  const ry0 = Math.min(from[1], to[1]) - CAPSULE_HALF_HEIGHT;
  const ry1 = Math.max(from[1], to[1]) + CAPSULE_HALF_HEIGHT;
  const zx0 = cx - hx;
  const zx1 = cx + hx;
  const zy0 = cy - hy;
  const zy1 = cy + hy;
  const dx = Math.max(0, rx0 - zx1, zx0 - rx1);
  const dy = Math.max(0, ry0 - zy1, zy0 - ry1);
  const d = Math.sqrt(dx * dx + dy * dy);
  return { overlap: d < CAPSULE_RADIUS - ZONE_OVERLAP_EPS };
}

/** The §4.3 same-step decision (first match wins, ID-ordered ties). */
function decide(
  checkpointId: string | null,
  zones: FixtureZone[],
  killY: number,
  from: Pt,
  to: Pt,
):
  | { kind: 'none' }
  | { kind: 'death'; cause: 'hazard'; zoneId: string }
  | { kind: 'death'; cause: 'fall' }
  | { kind: 'checkpoint'; zoneId: string }
  | { kind: 'goal'; zoneId: string } {
  const sorted = [...zones].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const hazards = sorted.filter((z) => z.role === 'hazard' && zoneTest(from, to, z).overlap);
  if (hazards.length > 0) return { kind: 'death', cause: 'hazard', zoneId: hazards[0]!.id };
  if (to[1] < killY) return { kind: 'death', cause: 'fall' };
  const checkpoint = sorted.find((z) => z.role === 'checkpoint' && zoneTest(from, to, z).overlap);
  if (checkpointId === null && checkpoint) return { kind: 'checkpoint', zoneId: checkpoint.id };
  const goals = sorted.filter((z) => z.role === 'goal' && zoneTest(from, to, z).overlap);
  if (goals.length > 0) return { kind: 'goal', zoneId: goals[0]!.id };
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// The replay harness (the checker's Run engine semantics over GameSession).
// ---------------------------------------------------------------------------

interface TimelineEntry {
  stepIndex: number;
  state: RunState;
  evaluated: boolean;
}

/** The failure-phases.json `where` → (code, reason) table (gameplay.md §8.1). */
const FAILURE_TABLE: Record<string, { code: string; reason: string }> = {
  intent: { code: 'module_error', reason: 'module_threw' },
  controller: { code: 'module_error', reason: 'module_threw' },
  physics: { code: 'physics_port_error', reason: 'result' },
  transform: { code: 'module_error', reason: 'phase_violation' },
  gameplay: { code: 'module_error', reason: 'gameplay_invalid' },
  camera: { code: 'module_error', reason: 'phase_violation' },
  commit: { code: 'module_error', reason: 'phase_violation' },
  'reset:R1': { code: 'game_spawn_invalid', reason: 'reference' },
  'reset:R2': { code: 'game_spawn_blocked', reason: 'hazard' },
  'reset:R3': { code: 'game_spawn_blocked', reason: 'blocked' },
  'reset:R4': { code: 'physics_port_error', reason: 'reset' },
  'reset:R5': { code: 'physics_port_error', reason: 'reset' },
  'reset:R6': { code: 'module_error', reason: 'module_threw' },
  'reset:R7': { code: 'module_error', reason: 'phase_violation' },
  'reset:R8': { code: 'module_error', reason: 'phase_violation' },
};

function replayCase(file: FixtureFile, testCase: FixtureCase): { view: GameView; timeline: TimelineEntry[] } {
  const session = new GameSession(file.snapshotId);
  let nextStep = file.firstStep;
  const timeline: TimelineEntry[] = [];

  const stepOnce = (from: Pt, to: Pt): void => {
    const ordinal = nextStep;
    const outcome = session.boundary(ordinal);
    // Packet 49: the due reset is the queued-request no-op seam (no world
    // mutation); the run-state bookkeeping (outcome.events, the T5 state)
    // is what this harness verifies.
    void outcome;
    const evaluated = session.runState === 'playing';
    if (evaluated) {
      const decision = decide(session.checkpointTotal, file.zones, file.killY, from, to);
      if (decision.kind === 'death') {
        if (decision.cause === 'hazard') session.beginRespawn(ordinal, 'hazard', decision.zoneId);
        else session.beginRespawn(ordinal, 'fall');
      } else if (decision.kind === 'checkpoint') {
        session.activateCheckpoint(ordinal, decision.zoneId);
      } else if (decision.kind === 'goal') {
        session.reachGoal(ordinal, decision.zoneId);
      }
    }
    nextStep += 1;
    timeline.push({ stepIndex: ordinal, state: session.runState, evaluated });
  };

  const apply = (ops: unknown[]): void => {
    for (const raw of ops) {
      const op = raw as Record<string, unknown>;
      if (op.op === 'submit') {
        const res = session.submit(op.command as 'start' | 'replay');
        const expectError = op.expectError as Record<string, unknown> | undefined;
        if (expectError !== undefined) {
          expect(res.ok).toBe(false);
          if (!res.ok) compareSubset(expectError, res.error, `submit/${testCase.id}`);
        } else {
          expect(res, `submit ${op.command} @${testCase.id}`).toMatchObject({ ok: true });
        }
      } else if (op.op === 'step') {
        stepOnce(op.from as Pt, op.to as Pt);
      } else if (op.op === 'steps') {
        for (let k = 0; k < (op.count as number); k += 1) stepOnce(op.from as Pt, op.to as Pt);
      } else if (op.op === 'repeat') {
        for (let k = 0; k < (op.count as number); k += 1) apply(op.ops as unknown[]);
      } else if (op.op === 'fail') {
        const where = op.where as string;
        const entry = FAILURE_TABLE[where];
        expect(entry, `unknown failure phase ${where}`).toBeDefined();
        session.markFailure(entry!.code, entry!.reason, nextStep, where);
      } else {
        throw new Error(`unknown op ${JSON.stringify(op.op)}`);
      }
    }
  };
  apply(testCase.script);

  const view = session.buildView({
    snapshotId: file.snapshotId,
    stepIndex: nextStep,
    simTime: nextStep / SIM_HZ,
    playerId: 'player',
    cameraId: 'camera',
    spawnId: file.spawnId,
    checkpointSafeSpawnId: session.checkpointTotal === null ? null : file.safeSpawnId,
    playerMotion: { speed: 0, grounded: true },
  });
  return { view, timeline };
}

/** compareSubset (the checker's): every expected key must exist and match. */
function compareSubset(expected: unknown, actual: unknown, path: string): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `expected array at ${path}`).toBe(true);
    if (Array.isArray(actual)) {
      expect(actual.length, `length at ${path}`).toBe(expected.length);
      expected.forEach((v, i) => compareSubset(v, actual[i], `${path}[${i}]`));
    }
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    expect(actual !== null && typeof actual === 'object', `expected object at ${path}`).toBe(true);
    for (const k of Object.keys(expected as Record<string, unknown>)) {
      const obj = actual as Record<string, unknown>;
      expect(k in obj, `missing key ${path}.${k}`).toBe(true);
      compareSubset((expected as Record<string, unknown>)[k], obj[k], `${path}.${k}`);
    }
    return;
  }
  expect(Object.is(expected, actual), `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`).toBe(true);
}

function checkRunFixture(name: string, withTimeline: boolean): void {
  const file = loadFixture(name);
  it(`${name}: all ${file.cases.length} cases`, () => {
    for (const c of file.cases) {
      const { view, timeline } = replayCase(file, c);
      compareSubset(c.expect.final, view, `${c.id}.final`);
      if (c.expect.events !== undefined) compareSubset(c.expect.events, view.events, `${c.id}.events`);
      if (c.expect.retainedFirst !== undefined) compareSubset(c.expect.retainedFirst, view.events[0], `${c.id}.retainedFirst`);
      if (c.expect.retainedLast !== undefined) compareSubset(c.expect.retainedLast, view.events[view.events.length - 1], `${c.id}.retainedLast`);
      if (withTimeline && c.expect.timeline !== undefined) compareSubset(c.expect.timeline, timeline, `${c.id}.timeline`);
    }
  });
}

describe('M3 run state machine (gameplay.md §2/§6) vs the promoted run fixtures', () => {
  it('contract constants (gameplay.md §8.2)', () => {
    expect(RESPAWN_DELAY_STEPS).toBe(30);
    expect(MAX_GAME_EVENTS).toBe(32);
  });

  checkRunFixture('states.json', true);
  checkRunFixture('respawn-timing.json', true);
  checkRunFixture('events-bound.json', false);
  checkRunFixture('failure-phases.json', false);

  it('game-view.json: identity / staleness / playerMotion derivation', () => {
    const doc = JSON.parse(readFileSync(join(RUN_FIXTURES, 'game-view.json'), 'utf8')) as {
      cases: Array<Record<string, any>>;
    };
    const stale = (a: { runId: string; stepIndex: number }, b: { runId: string; stepIndex: number }): boolean =>
      a.runId !== b.runId || a.stepIndex < b.stepIndex;
    for (const c of doc.cases) {
      if (c.op === 'identity') {
        const file: FixtureFile = {
          fixtureVersion: 1,
          snapshotId: c.snapshotId,
          killY: -4,
          zones: [],
          spawnId: 'spawn-0001',
          safeSpawnId: 'spawn-0002',
          firstStep: 0,
          cases: [c],
        };
        const { view } = replayCase(file, c);
        const actual = {
          runId: view.runId,
          state: view.state,
          stepIndex: view.stepIndex,
          staleAgainstSelf: stale(view, view),
        };
        compareSubset(c.expect, actual, c.id);
      } else if (c.op === 'staleness') {
        const actual = stale(c.view, c.current);
        expect(actual, c.id).toBe(c.expect.stale);
      } else if (c.op === 'motion') {
        // C41-1: speed = |lastCompletedSegment| × SIM_HZ; awaitingStart/won
        // (no completed step) ⇒ { speed: 0, grounded: true }.
        const neutral = c.runState === 'awaitingStart' || c.runState === 'won';
        const seg = c.lastCompletedSegment as { from: Pt; to: Pt } | undefined;
        const raw = !neutral && seg !== undefined
          ? Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]) * SIM_HZ
          : 0;
        const actual = { speed: Math.round(raw * 1e6) / 1e6, grounded: neutral || seg === undefined ? true : c.grounded };
        compareSubset(c.expect, actual, c.id);
      } else {
        throw new Error(`unknown game-view op ${JSON.stringify(c.op)}`);
      }
    }
  });
});