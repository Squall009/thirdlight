/**
 * Scenario replay (fixtures/commands/scenarios) — the accepted fixtures
 * pin exact request/response payloads and disk states. Each test seeds the
 * scenario's `disk-before` into a real temp root, replays `messages.json`
 * through the real service, compares every `out` (deep equality), then the
 * `disk-after` authoring state (byte-for-byte).
 *
 * Scenarios 01–05: command pipeline behavior (retry/reuse/stale/invalid/
 * undo-redo). Scenario 08: the external-change protocol (detection,
 * snapshot, pause, accept). Scenario 09: second-backend ownership
 * (conflict → stale → explicit takeover).
 *
 * Scenarios 06/07 (crash points) are exercised by the process-level crash
 * tests at the repo root (tests/crash-recovery.test.mjs), which need
 * real subprocess termination.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

import {
  buildFakeProc,
  compareAuthoringDisk,
  deepEqual,
  deepEqualModelLoose,
  dispatch,
  fileBytes,
  FIXTURES,
  makeRoot,
  seedProject,
} from './helpers';

const OWNER_A = {
  backendId: 'tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  pid: 5000,
};
const BACKEND_B = {
  backendId: 'tb-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  pid: 5150,
};

function envelopeFixture(name: string): string {
  return join(FIXTURES, 'envelope', 'valid', name);
}

/** Seed the command-scenario precondition: manifest from disk-before plus
 * the pinned envelope fixture (scenario.md cross-reference). */
function seedCommandScenario(root: string, scenario: string, envelopeFile: string): string {
  const base = join(FIXTURES, 'scenarios', scenario);
  const dir = seedProject(root, join(base, 'disk-before'), 'demo-0001');
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  writeFileSync(join(dir, 'scenes', 'main.json'), readFileSync(envelopeFixture(envelopeFile)));
  return dir;
}

function loadMessages(scenario: string): Record<string, unknown>[] {
  return JSON.parse(readFileSync(join(FIXTURES, 'scenarios', scenario, 'messages.json'), 'utf8'));
}

/** Replay every pinned message, asserting the pinned response. */
function runAll(svc: WorkspaceService, base: string, looseModelText = false): void {
  const messages = loadMessages(base);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const actual = dispatch(svc, m['in'] as Record<string, unknown>);
    const eq = looseModelText ? deepEqualModelLoose(actual, m['out']) : deepEqual(actual, m['out']);
    expect(
      eq,
      `scenario ${base} message ${i + 1}:\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(m['out'])}`,
    ).toBe(true);
  }
}

describe('scenario 01 — retry after lost ack', () => {
  it('replays the recorded result (duplicated: true) with no write', () => {
    const base = '01-retry-lost-ack';
    const root = makeRoot(base);
    const dir = seedCommandScenario(root, base, 'demo-0001-rev5.json');
    const before = fileBytes(join(dir, 'scenes', 'main.json'));
    const svc = openWorkspaceService({ root });
    runAll(svc, base);
    // The retry answered at pipeline step 2 (dedup): no write happened.
    const after = fileBytes(join(dir, 'scenes', 'main.json'));
    expect(after.length).toBe(before.length);
    expect(compareAuthoringDisk(dir, join(FIXTURES, 'scenarios', base, 'disk-after'))).toEqual([]);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});

for (const [base, env] of [
  ['02-request-id-reused', 'demo-0001-rev5.json'],
  ['03-stale-revision', 'demo-0001-rev5.json'],
  ['04-invalid-no-partial', 'demo-0001-rev5.json'],
  ['05-undo-redo-mixed', 'demo-0001-rev0.json'],
] as const) {
  describe(`scenario ${base}`, () => {
    it('replays the pinned messages and disk state', () => {
      const root = makeRoot(base);
      const dir = seedCommandScenario(root, base, env);
      const svc = openWorkspaceService({ root });
      // 04's embedded model detail text is compared tolerantly (the
      // commands fixture's hand-written hint predates the accepted model
      // package's wording — see the helpers doc on deepEqualModelLoose).
      runAll(svc, base, base === '04-invalid-no-partial');
      expect(compareAuthoringDisk(dir, join(FIXTURES, 'scenarios', base, 'disk-after'))).toEqual([]);
      svc.dispose();
      rmSync(root, { recursive: true, force: true });
    });
  });
}

describe('scenario 08 — unexpected external modification', () => {
  it('detects at the pre-write check, snapshots, pauses, accepts (byte-pinned disk-after)', () => {
    const base = '08-external-modification';
    const root = makeRoot(base);
    const dir = seedProject(root, join(FIXTURES, 'scenarios', base, 'disk-before'), 'demo-0001');
    const externalBytes = readFileSync(
      join(FIXTURES, 'scenarios', base, 'disk-external', 'scenes', 'main.json'),
    );

    const svc = openWorkspaceService({
      root,
      backendId: OWNER_A.backendId,
      pid: OWNER_A.pid,
      stamp: () => '20260917T101500Z',
    });
    // The backend is ALREADY RUNNING at T7 (its last known good is the
    // loaded disk state) when the bypassing writer edits the file.
    svc.query({ op: 'queryProject', projectId: 'demo-0001' });
    writeFileSync(join(dir, 'scenes', 'main.json'), externalBytes);

    runAll(svc, base);

    // Disk state is byte-pinned: main.json (rev 8), the recovery snapshot
    // (byte-identical external bytes), the unchanged ownership record,
    // the manifest.
    expect(compareAuthoringDisk(dir, join(FIXTURES, 'scenarios', base, 'disk-after'))).toEqual([]);
    const snap = join(dir, '.thirdlight', 'recovery', 'scene-20260917T101500Z-5923fe48.json');
    expect(existsSync(snap), 'recovery snapshot present').toBe(true);
    expect(Buffer.compare(Buffer.from(fileBytes(snap)), externalBytes)).toBe(0);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('scenario 09 — second-backend ownership', () => {
  it('conflicts with the live owner, reports stale after death, takes over explicitly', () => {
    const base = '09-second-backend-ownership';
    const root = makeRoot(base);
    const dir = seedProject(root, join(FIXTURES, 'scenarios', base, 'disk-before'), 'demo-0001');

    // Controlled /proc: owner A is LIVE for message 1, then gone.
    const procRoot = buildFakeProc(root, { 5000: 'live' });
    const svc = openWorkspaceService({
      root,
      backendId: BACKEND_B.backendId,
      pid: BACKEND_B.pid,
      procRoot,
      utcNow: () => '2026-09-17T10:30:00Z',
    });
    const messages = loadMessages(base);

    // Message 1: A live ⇒ ownership_conflict (with the disk holder).
    let actual = dispatch(svc, messages[0]['in'] as Record<string, unknown>);
    expect(
      deepEqual(actual, messages[0]['out']),
      `message 1:\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(messages[0]['out'])}`,
    ).toBe(true);

    // The owner process dies before message 2.
    rmSync(join(procRoot, '5000'), { recursive: true, force: true });
    actual = dispatch(svc, messages[1]['in'] as Record<string, unknown>);
    expect(
      deepEqual(actual, messages[1]['out']),
      `message 2:\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(messages[1]['out'])}`,
    ).toBe(true);

    // Message 3: explicit takeover (the operator command; epoch 0 → 1).
    actual = dispatch(svc, messages[2]['in'] as Record<string, unknown>);
    expect(
      deepEqual(actual, messages[2]['out']),
      `message 3:\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(messages[2]['out'])}`,
    ).toBe(true);

    // Message 4: the project is usable.
    actual = dispatch(svc, messages[3]['in'] as Record<string, unknown>);
    expect(deepEqual(actual, messages[3]['out'])).toBe(true);

    expect(compareAuthoringDisk(dir, join(FIXTURES, 'scenarios', base, 'disk-after'))).toEqual([]);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});