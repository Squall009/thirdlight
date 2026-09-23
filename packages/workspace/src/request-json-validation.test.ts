/**
 * 2026-09-18 review repair — group A2 (R11 + R12 + R13) regression tests.
 *
 * Converted from docs/reviews/2026-09-18-probes.mjs (the probes pin the
 * BUGGY behavior at the reviewed HEAD; these tests pin the desired
 * post-repair behavior through the public API only):
 *
 *   NULL_DIGEST             ⇒  R11 — a fresh request with a non-canonicalizable
 *                              value (undefined optional property, BigInt,
 *                              Date, nested undefined) must be rejected with a
 *                              structured validation error BEFORE any record
 *                              is built: nothing written to disk, no `null`
 *                              digest in the envelope, the same requestId
 *                              re-issues fresh (never `request_id_reused`),
 *                              and the project reopens cleanly. Dedup/pause/
 *                              revision ordering for VALID requests is
 *                              preserved (identical retry ⇒ duplicated).
 *   STARTUP_THROW           ⇒  R12 — a persisted retry result whose
 *                              `change.type` is the JSON object
 *                              `{"toString":0}` (valid JSON, corrupt shape)
 *                              must NOT abort `openWorkspaceService`: the
 *                              corrupt project is blocked per workspace.md
 *                              §7.5 (`project_unavailable`, structured load
 *                              reason), its bytes are retained
 *                              byte-identical, and a healthy project in the
 *                              same root stays fully usable.
 *   INVALID_RECORD_REPLAY   ⇒  R13 — persisted retry records are strictly
 *                              validated at load: enclosing-project
 *                              consistency (`result.projectId` equals the
 *                              project id), complete historical
 *                              entity/change payloads per the model authority
 *                              (strict schema — but NO reference-existence
 *                              against the current scene). Malformed records
 *                              block the project per §7.5 without rewriting
 *                              disk; a healthy sibling stays usable.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService, type QueryResult } from '@thirdlight/workspace';

// ---- disposable roots (ext4, probe convention; cleaned up per test) ----------

const roots: string[] = [];

function makeRoot(tag: string): string {
  const root = join(
    '/home/dadmin',
    `.tl07-tmp-a2-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function rmrf(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) rmrf(p);
    else unlinkSync(p);
  }
  rmdirSync(dir);
}

function dropRoot(root: string): void {
  try {
    rmrf(root);
  } catch {
    // best effort — the afterAll backstop retries
  }
}

afterAll(() => {
  for (const r of roots.splice(0)) dropRoot(r);
});

// ---- helpers -----------------------------------------------------------------

/** Pinned identity: reopen tests re-open with the SAME process identity
 * (workspace.md §6.2 `own-record`: the durable claim is unchanged). */
const BACKEND_ID = 'tb-aa11bb22cc33dd44ee55ff6600112233';

let seq = 0;

/** A fresh, syntactically valid requestId (commands.md §3). */
function nextRequestId(): string {
  seq += 1;
  return `req-${seq.toString(16).padStart(32, '0')}`;
}

/** A valid createEntity request (the probe's request shape). */
function createEntityRequest(
  projectId: string,
  revision: number,
  requestId: string,
): {
  op: 'createEntity';
  projectId: string;
  expectedRevision: number;
  requestId: string;
  args: { kind: 'box' };
} {
  return {
    op: 'createEntity',
    projectId,
    expectedRevision: revision,
    requestId,
    args: { kind: 'box' },
  };
}

function scenePath(root: string, projectId: string): string {
  return join(root, 'projects', projectId, 'scenes', 'main.json');
}

/** Byte comparison (the ES2022 lib has no `Uint8Array.prototype.equals`). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** A JSON value (the shape persisted records have after a strict parse). */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface EnvelopeShape {
  storageVersion: number;
  type: string;
  projectId: string;
  scene: Json;
  retry: { retention: number; records: Json[] };
}

// ---- R11: the canonicalizability gate -----------------------------------------

/**
 * One R11 case: the bad request (built by `makeBad`) is rejected with a
 * structured validation error; the on-disk envelope is byte-identical
 * (no record appended, no null digest); re-issuing the SAME requestId is a
 * fresh rejection (never `request_id_reused`); the project reopens cleanly
 * and serves a valid mutation.
 */
function assertRejectedClean(
  tag: string,
  makeBad: () => Record<string, unknown>,
  expectedPath: string,
): void {
  const root = makeRoot(tag);
  try {
    const s = openWorkspaceService({ root, backendId: BACKEND_ID });
    expect(s.createProject('demo', 'Demo').ok).toBe(true);
    const before = readFileSync(scenePath(root, 'demo'));
    const bad = makeBad();
    const r1 = s.runCommand(bad);
    expect(r1.ok).toBe(false);
    if (r1.ok !== false) {
      throw new Error(`expected a validation rejection, got: ${JSON.stringify(r1)}`);
    }
    expect(r1.error.code).toBe('invalid_request');
    expect(r1.error.cls).toBe('validation');
    expect(r1.error.path).toBe(expectedPath);
    // The error is JSON-serializable (the A1 bounded `found` conversion).
    expect(() => JSON.stringify(r1)).not.toThrow();
    // (a)+(b): nothing written — the envelope is byte-identical; the retry
    // block holds no record (no record appended, no null digest).
    const after = readFileSync(scenePath(root, 'demo'));
    expect(bytesEqual(after, before)).toBe(true);
    const env = JSON.parse(readFileSync(scenePath(root, 'demo'), 'utf8')) as EnvelopeShape;
    expect(env.retry.records).toEqual([]);
    // (c): re-issuing the SAME requestId (same object ⇒ same requestId and
    // same non-canonicalizable content) is a fresh rejection, not
    // `request_id_reused` — no record was ever recorded for it.
    const r2 = s.runCommand(bad);
    expect(r2.ok).toBe(false);
    if (r2.ok !== false) {
      throw new Error(`expected a fresh rejection, got: ${JSON.stringify(r2)}`);
    }
    expect(r2.error.code).not.toBe('request_id_reused');
    expect(r2.error.code).toBe('invalid_request');
    expect(r2.error.path).toBe(expectedPath);
    // (d): the project reopens cleanly — the retry block is valid and the
    // project serves a valid mutation.
    s.dispose();
    const s2 = openWorkspaceService({ root, backendId: BACKEND_ID });
    const q = s2.query({ op: 'queryProject', projectId: 'demo' }) as QueryResult;
    expect(q.ok).toBe(true);
    if (q.ok !== true) {
      throw new Error(`reopen query failed: ${JSON.stringify(q.error)}`);
    }
    expect(q.revision).toBe(0);
    expect(s2.runCommand(createEntityRequest('demo', 0, nextRequestId())).ok).toBe(true);
    s2.dispose();
  } finally {
    dropRoot(root);
  }
}

// ---- R12/R13: corrupt-record roots --------------------------------------------

interface CorruptRoot {
  root: string;
  /** The first service (still holding the in-memory state at corruption time). */
  s: ReturnType<typeof openWorkspaceService>;
  ack: { ok: true; createdId?: string; revision: number };
  /** The exact request that produced the persisted record. */
  original: ReturnType<typeof createEntityRequest>;
  /** The corrupted on-disk bytes (must be retained byte-identical). */
  corruptBytes: Uint8Array;
  badPath: string;
}

/**
 * A root with two projects: `bad` (one successful createEntity record
 * persisted) and `good` (fresh). Returns the setup for corruption.
 */
function setupCorruptRoot(tag: string): CorruptRoot {
  const root = makeRoot(tag);
  const s = openWorkspaceService({ root, backendId: BACKEND_ID });
  expect(s.createProject('bad', 'Bad').ok).toBe(true);
  expect(s.createProject('good', 'Good').ok).toBe(true);
  const original = createEntityRequest('bad', 0, nextRequestId());
  const ack = s.runCommand(original);
  expect(ack.ok).toBe(true);
  if (ack.ok !== true) throw new Error('setup createEntity failed');
  if (ack.createdId === undefined) throw new Error('setup createdId missing');
  const badPath = scenePath(root, 'bad');
  return { root, s, ack, original, corruptBytes: new Uint8Array(), badPath };
}

/**
 * Corrupt the persisted record of the `bad` project, dispose, and reopen.
 * R12: `openWorkspaceService` (which runs the startup scan) must NEVER
 * throw from the corrupt project.
 */
function corruptAndReopen(
  tag: string,
  corrupt: (rec: Record<string, Json>, createdId: string) => void,
): { t: CorruptRoot; s2: ReturnType<typeof openWorkspaceService> } {
  const t = setupCorruptRoot(tag);
  const env = JSON.parse(readFileSync(t.badPath, 'utf8')) as EnvelopeShape;
  const rec = env.retry.records[0] as Record<string, Json>;
  corrupt(rec, t.ack.createdId!);
  writeFileSync(t.badPath, JSON.stringify(env));
  t.corruptBytes = readFileSync(t.badPath);
  t.s.dispose();
  const s2 = openWorkspaceService({ root: t.root, backendId: BACKEND_ID });
  return { t, s2 };
}

/**
 * The §7.5 battery for a corrupt `bad` project next to a healthy `good`
 * one: the scan reports the block (no throw); query + replay + fresh
 * mutation on `bad` all fail `project_unavailable` with the specific
 * reason; the on-disk bytes are retained byte-identical; the healthy
 * sibling is fully usable (query + mutation + dedup ack).
 */
function assertBlockedAndSiblingUsable(
  t: CorruptRoot,
  s2: ReturnType<typeof openWorkspaceService>,
): void {
  // The startup scan completed and reports the corrupt project (reaching
  // here already proves openWorkspaceService did not throw).
  const entry = s2.lastScan.entries.find((e) => e.projectId === 'bad');
  expect(entry?.loadable).toBe(false);
  expect(entry?.code).toBe('retry_records_invalid');
  const goodEntry = s2.lastScan.entries.find((e) => e.projectId === 'good');
  expect(goodEntry?.loadable).toBe(true);
  // The corrupt project is blocked per workspace.md §7.5.
  const q = s2.query({ op: 'queryProject', projectId: 'bad' }) as QueryResult;
  expect(q.ok).toBe(false);
  if (q.ok !== false) throw new Error(`expected a blocked query, got: ${JSON.stringify(q)}`);
  expect(q.error.code).toBe('project_unavailable');
  expect(q.error.reason).toBe('retry_records_invalid');
  // The bytes are retained byte-for-byte (no auto-repair, ever).
  expect(bytesEqual(readFileSync(t.badPath), t.corruptBytes)).toBe(true);
  // A retry of the ORIGINAL request: the project stays blocked — no dedup
  // replay and no fresh execution (workspace.md §7.5: commands return
  // project_unavailable while the load fails).
  const replay = s2.runCommand(t.original);
  expect(replay.ok).toBe(false);
  if (replay.ok !== false) {
    throw new Error(`expected a blocked replay, got: ${JSON.stringify(replay)}`);
  }
  expect(replay.error.code).toBe('project_unavailable');
  expect(replay.error.reason).toBe('retry_records_invalid');
  // A fresh mutation on the corrupt project is blocked too.
  const fresh = s2.runCommand(createEntityRequest('bad', 0, nextRequestId()));
  expect(fresh.ok).toBe(false);
  if (fresh.ok !== false) {
    throw new Error(`expected a blocked fresh mutation, got: ${JSON.stringify(fresh)}`);
  }
  expect(fresh.error.code).toBe('project_unavailable');
  expect(fresh.error.reason).toBe('retry_records_invalid');
  // The healthy sibling is fully usable.
  const qg = s2.query({ op: 'queryProject', projectId: 'good' }) as QueryResult;
  expect(qg.ok).toBe(true);
  if (qg.ok !== true) throw new Error(`sibling query failed: ${JSON.stringify(qg.error)}`);
  expect(qg.revision).toBe(0);
  const gReq = createEntityRequest('good', 0, nextRequestId());
  const gAck = s2.runCommand(gReq);
  expect(gAck.ok).toBe(true);
  if (gAck.ok !== true) throw new Error(`sibling mutation failed: ${JSON.stringify(gAck.error)}`);
  expect(gAck.revision).toBe(1);
  // And its dedup ack is intact.
  const gRetry = s2.runCommand(gReq);
  expect(gRetry.ok).toBe(true);
  if (gRetry.ok !== true) throw new Error(`sibling retry failed: ${JSON.stringify(gRetry.error)}`);
  expect(gRetry.duplicated).toBe(true);
}

// ---- tests ---------------------------------------------------------------------

describe('2026-09-18 review group A2 (R11, R12, R13) regressions', () => {
  describe('R11 (NULL_DIGEST): non-canonicalizable fresh requests', () => {
    it('R11a (probe NULL_DIGEST): origin: undefined is rejected before any record is built', () => {
      assertRejectedClean(
        'r11-undefined',
        () => ({
          ...createEntityRequest('demo', 0, nextRequestId()),
          origin: undefined,
        }),
        '/origin',
      );
    });

    it('R11b: a BigInt inside args is rejected (path points at the element)', () => {
      assertRejectedClean(
        'r11-bigint',
        () => ({
          ...createEntityRequest('demo', 0, nextRequestId()),
          args: { kind: 'box', scale: [1n] },
        }),
        '/args/scale/0',
      );
    });

    it('R11c: a Date inside args is rejected (not a plain JSON object)', () => {
      assertRejectedClean(
        'r11-date',
        () => ({
          ...createEntityRequest('demo', 0, nextRequestId()),
          args: { kind: 'box', stamp: new Date() },
        }),
        '/args/stamp',
      );
    });

    it('R11d: a nested undefined in an optional field is rejected', () => {
      assertRejectedClean(
        'r11-nested-undefined',
        () => ({
          ...createEntityRequest('demo', 0, nextRequestId()),
          args: { kind: 'box', name: undefined },
        }),
        '/args/name',
      );
    });

    it('R11e (sanity): dedup/revision ordering for VALID requests is preserved', () => {
      const root = makeRoot('r11-sanity');
      try {
        const s = openWorkspaceService({ root, backendId: BACKEND_ID });
        expect(s.createProject('demo', 'Demo').ok).toBe(true);
        const req = createEntityRequest('demo', 0, nextRequestId());
        const a1 = s.runCommand(req);
        expect(a1.ok).toBe(true);
        if (a1.ok !== true) throw new Error(`valid create failed: ${JSON.stringify(a1.error)}`);
        expect(a1.revision).toBe(1);
        expect(a1.duplicated).toBe(false);
        // Identical retry: dedup replay at the SAME revision.
        const a2 = s.runCommand(req);
        expect(a2.ok).toBe(true);
        if (a2.ok !== true) throw new Error(`retry failed: ${JSON.stringify(a2.error)}`);
        expect(a2.duplicated).toBe(true);
        expect(a2.revision).toBe(1);
        const q = s.query({ op: 'queryProject', projectId: 'demo' }) as QueryResult;
        expect(q.ok).toBe(true);
        if (q.ok !== true) throw new Error(`query failed: ${JSON.stringify(q.error)}`);
        expect(q.revision).toBe(1);
        // The envelope's record has a real 64-hex digest (never null).
        const env = JSON.parse(readFileSync(scenePath(root, 'demo'), 'utf8')) as EnvelopeShape;
        expect(env.retry.records).toHaveLength(1);
        expect((env.retry.records[0] as Record<string, Json>)['digest']).toMatch(/^[0-9a-f]{64}$/);
        s.dispose();
      } finally {
        dropRoot(root);
      }
    });
  });

  describe('R12 (STARTUP_THROW): JSON-shaped corrupt discriminators', () => {
    it('R12a (probe STARTUP_THROW): change.type = {"toString":0} blocks the project, never throws', () => {
      const { t, s2 } = corruptAndReopen('r12-change-type', (rec, _createdId) => {
        const result = rec['result'] as Record<string, Json>;
        const change = result['change'] as Record<string, Json>;
        change['type'] = { toString: 0 };
      });
      assertBlockedAndSiblingUsable(t, s2);
      s2.dispose();
      dropRoot(t.root);
    });

    it('R12b: result.op = {"toString":0} (sibling coercion) blocks the project, never throws', () => {
      const { t, s2 } = corruptAndReopen('r12-op', (rec, _createdId) => {
        const result = rec['result'] as Record<string, Json>;
        result['op'] = { toString: 0 };
      });
      assertBlockedAndSiblingUsable(t, s2);
      s2.dispose();
      dropRoot(t.root);
    });
  });

  describe('R13 (INVALID_RECORD_REPLAY): strict historical record validation', () => {
    it('R13a (probe INVALID_RECORD_REPLAY): result.projectId ≠ project id ⇒ blocked at reopen', () => {
      const { t, s2 } = corruptAndReopen('r13-project', (rec, _createdId) => {
        const result = rec['result'] as Record<string, Json>;
        result['projectId'] = 'another-project';
      });
      assertBlockedAndSiblingUsable(t, s2);
      s2.dispose();
      dropRoot(t.root);
    });

    it('R13b: a created entity of only {id} (missing components) ⇒ blocked at reopen', () => {
      const { t, s2 } = corruptAndReopen('r13-entity-id-only', (rec, createdId) => {
        const result = rec['result'] as Record<string, Json>;
        const change = result['change'] as Record<string, Json>;
        change['entity'] = { id: createdId };
      });
      assertBlockedAndSiblingUsable(t, s2);
      s2.dispose();
      dropRoot(t.root);
    });

    it('R13c: unknown fields nested in the entity payload ⇒ blocked at reopen', () => {
      const { t, s2 } = corruptAndReopen('r13-entity-unknown', (rec, _createdId) => {
        const result = rec['result'] as Record<string, Json>;
        const change = result['change'] as Record<string, Json>;
        const entity = change['entity'] as Record<string, Json>;
        entity['bogus'] = 1;
      });
      assertBlockedAndSiblingUsable(t, s2);
      s2.dispose();
      dropRoot(t.root);
    });

    it('R13d: unknown fields in the change payload ⇒ blocked at reopen', () => {
      const { t, s2 } = corruptAndReopen('r13-change-unknown', (rec, _createdId) => {
        const result = rec['result'] as Record<string, Json>;
        const change = result['change'] as Record<string, Json>;
        change['extra'] = 2;
      });
      assertBlockedAndSiblingUsable(t, s2);
      s2.dispose();
      dropRoot(t.root);
    });
  });
});