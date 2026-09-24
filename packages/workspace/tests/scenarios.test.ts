/**
 * Scenario replay (fixtures/commands/scenarios, storage v4) — the fixtures
 * pin exact request/response payloads and disk states. Each test seeds the
 * scenario's `disk-before` project directory into a real temp root, replays
 * `messages.json` through the real service, compares every `out` (deep
 * equality), then the `disk-after` project files (byte-for-byte).
 *
 * Scenarios 01–05: command pipeline behavior (retry/reuse/stale/invalid/
 * undo-redo). Scenarios 06/07: the restart after a crash before/after the
 * scene file's atomic replacement (the crash itself is the disk-before
 * state; real subprocess termination is exercised by
 * tests/crash-recovery.test.ts). Scenario 08: the external-change protocol
 * (detection, snapshot, pause, accept). Scenario 09: second-backend
 * ownership (conflict, then the automatic reclaim after the owner's death).
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

import {
  buildFakeProc,
  compareAuthoringDisk,
  deepEqual,
  dispatch,
  fileBytes,
  FIXTURES,
  makeRoot,
  SCENE_FILE,
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
/** The backend that restarts after the crash in scenarios 06/07. */
const BACKEND_C = {
  backendId: 'tb-cccccccccccccccccccccccccccccccc',
  pid: 4300,
};

const scenarioDir = (base: string, ...parts: string[]): string => join(FIXTURES, 'scenarios', base, ...parts);

function seedScenario(root: string, base: string): string {
  return seedProject(root, scenarioDir(base, 'disk-before'), 'demo-0001');
}

function loadMessages(scenario: string): Record<string, unknown>[] {
  return JSON.parse(readFileSync(scenarioDir(scenario, 'messages.json'), 'utf8'));
}

/** Replay every pinned message, asserting the pinned response. */
function runAll(svc: WorkspaceService, base: string): void {
  const messages = loadMessages(base);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const actual = dispatch(svc, m['in'] as Record<string, unknown>);
    expect(
      deepEqual(actual, m['out']),
      `scenario ${base} message ${i + 1}:\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(m['out'])}`,
    ).toBe(true);
  }
}

describe('scenario 01 — retry after lost ack', () => {
  it('replays the recorded result (duplicated: true) with no write', () => {
    const base = '01-retry-lost-ack';
    const root = makeRoot(base);
    const dir = seedScenario(root, base);
    const before = fileBytes(join(dir, SCENE_FILE));
    const svc = openWorkspaceService({ root, storageV4: true });
    runAll(svc, base);
    // The retry answered at pipeline step 2 (dedup): no write happened.
    expect(Buffer.from(fileBytes(join(dir, SCENE_FILE))).equals(Buffer.from(before))).toBe(true);
    expect(compareAuthoringDisk(dir, scenarioDir(base, 'disk-after'))).toEqual([]);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});

for (const base of ['02-request-id-reused', '03-stale-revision', '04-invalid-no-partial', '05-undo-redo-mixed'] as const) {
  describe(`scenario ${base}`, () => {
    it('replays the pinned messages and disk state', () => {
      const root = makeRoot(base);
      const dir = seedScenario(root, base);
      const svc = openWorkspaceService({ root, storageV4: true });
      runAll(svc, base);
      expect(compareAuthoringDisk(dir, scenarioDir(base, 'disk-after'))).toEqual([]);
      svc.dispose();
      rmSync(root, { recursive: true, force: true });
    });
  });
}

for (const base of ['06-crash-before-replace', '07-crash-after-replace'] as const) {
  describe(`scenario ${base}`, () => {
    it('the restarted backend reclaims the dead owner, loads the durable state and answers the retry', () => {
      const root = makeRoot(base);
      const dir = seedScenario(root, base);
      // The crashed owner (pid 4242) is gone from /proc.
      const procRoot = buildFakeProc(root, { 4242: 'dead' });
      const svc = openWorkspaceService({
        root,
        storageV4: true,
        ...BACKEND_C,
        procRoot,
        utcNow: () => '2026-09-17T09:45:00Z',
      });
      runAll(svc, base);
      // §5.4: the owner removed the crash-window temp at open (06).
      expect(readdirSync(join(dir, 'scenes')).filter((n) => n.includes('.tmp-'))).toEqual([]);
      expect(compareAuthoringDisk(dir, scenarioDir(base, 'disk-after'))).toEqual([]);
      svc.dispose();
      rmSync(root, { recursive: true, force: true });
    });
  });
}

describe('scenario 08 — unexpected external modification', () => {
  it('detects at the pre-write check, snapshots, pauses, accepts (byte-pinned disk-after)', () => {
    const base = '08-external-modification';
    const root = makeRoot(base);
    const dir = seedScenario(root, base);
    const externalBytes = readFileSync(scenarioDir(base, 'disk-external', SCENE_FILE));

    const svc = openWorkspaceService({
      root,
      storageV4: true,
      backendId: OWNER_A.backendId,
      pid: OWNER_A.pid,
      stamp: () => '20260917T101500Z',
    });
    // The backend is ALREADY RUNNING at T7 (its last known good is the
    // loaded disk state) when the bypassing writer edits the scene file.
    svc.query({ op: 'queryProject', projectId: 'demo-0001' });
    writeFileSync(join(dir, SCENE_FILE), externalBytes);

    runAll(svc, base);

    // Disk state is byte-pinned: the project files (scene rev 8, content
    // rewritten by the accept), the recovery snapshot (byte-identical
    // external bytes), the unchanged ownership record.
    expect(compareAuthoringDisk(dir, scenarioDir(base, 'disk-after'))).toEqual([]);
    const snaps = readdirSync(join(dir, '.thirdlight', 'recovery')).filter((n) => n.startsWith('scene-'));
    expect(snaps.length, 'exactly one recovery snapshot').toBe(1);
    const snap = join(dir, '.thirdlight', 'recovery', snaps[0]!);
    expect(existsSync(snap)).toBe(true);
    expect(Buffer.compare(Buffer.from(fileBytes(snap)), externalBytes)).toBe(0);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('scenario 09 — second-backend ownership', () => {
  it('conflicts with the live owner, then reclaims automatically after its death', () => {
    const base = '09-second-backend-ownership';
    const root = makeRoot(base);
    const dir = seedScenario(root, base);

    // Controlled /proc: owner A is LIVE for message 1, then gone.
    const procRoot = buildFakeProc(root, { 5000: 'live' });
    const svc = openWorkspaceService({
      root,
      storageV4: true,
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

    // The owner process dies before message 2: the project is reclaimed
    // automatically (epoch 0 → 1) and served.
    rmSync(join(procRoot, '5000'), { recursive: true, force: true });
    actual = dispatch(svc, messages[1]['in'] as Record<string, unknown>);
    expect(
      deepEqual(actual, messages[1]['out']),
      `message 2:\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(messages[1]['out'])}`,
    ).toBe(true);

    expect(compareAuthoringDisk(dir, scenarioDir(base, 'disk-after'))).toEqual([]);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});
