/**
 * 2026-09-18 review repair — group A1 (R10 + R17) regression tests.
 *
 * Converted from docs/reviews/2026-09-18-probes.mjs (the probes pin the
 * BUGGY behavior at the reviewed HEAD; these tests pin the desired
 * post-repair behavior through the public API only):
 *
 *   QUERY_ALIAS  ⇒  R10a — caller mutation of a queryEntity result must
 *                not corrupt authoritative state (query / unrelated
 *                mutation / reopen all unaffected);
 *   ACK_ALIAS    ⇒  R10b — caller mutation of a success ack's history must
 *                not corrupt the dedup retry or the durable retry records
 *                (retry returns the original undoDepth; reopen loads and
 *                replays identically, no `retry_records_invalid`);
 *   ERROR_JSON   ⇒  R17 — arbitrary public input (BigInt, self-referencing
 *                object) must yield a validation-class failure whose
 *                `JSON.stringify(result)` does not throw and whose
 *                serialized form is bounded.
 *
 * Mutation attempts: a strict-mode consumer (this file) throws a
 * TypeError when writing a frozen value; a sloppy-mode consumer would
 * silently no-op. Both outcomes mean "the attempt did not reach
 * authoritative state", so `attempt` swallows the write and every
 * assertion below checks the STATE (subsequent queries, retries,
 * unrelated mutations, reopen) — not the local (possibly detached)
 * reference.
 */

import { mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  openWorkspaceService,
  type QueryEntitiesResult,
  type QueryEntityResult,
  type QueryProjectResult,
  type QueryResult,
} from '@thirdlight/workspace';

// ---- disposable roots (ext4, probe convention; cleaned up per test) ----------

const roots: string[] = [];

function makeRoot(tag: string): string {
  const root = join(
    '/home/dadmin',
    `.tl07-tmp-a1-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`,
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

/** Swallow a caller mutation attempt (throws on frozen, no-ops otherwise). */
function attempt(fn: () => void): void {
  try {
    fn();
  } catch {
    // frozen value: TypeError in strict mode — the desired outcome class.
  }
}

let sequence = 0;

/** The probe's request shape: a createEntity at the given revision. */
function request(revision: number): {
  op: 'createEntity';
  projectId: string;
  expectedRevision: number;
  requestId: string;
  args: { kind: 'box'; name: string };
} {
  sequence += 1;
  return {
    op: 'createEntity',
    projectId: 'demo',
    expectedRevision: revision,
    requestId: `req-${sequence.toString(16).padStart(32, '0')}`,
    args: { kind: 'box', name: `Box ${sequence}` },
  };
}

/**
 * Serialized-size ceiling for R17 assertions, derived from the bounded
 * `found` conversion limits: 64 total nodes × (≤ 200-char strings +
 * marker + syntax ≈ 240) + 64 keys/object × (≤ 200-char keys + syntax ≈
 * 210) ≈ 30 KB, plus the fixed error envelope (code/cls/path/
 * expected/message/hint + ≤ 32-char op echo + projectId) — short for
 * the paths used here. 32768 covers both with margin.
 */
const BOUNDED = 32768;

/** Pinned identity: the dispose + reopen tests re-open with the SAME
 * process identity (workspace.md §6.2 `own-record`: in-memory state was
 * discarded, the durable claim is unchanged — the probe's semantics). */
const BACKEND_ID = 'tb-11112222333344445555666677778888';

// ---- tests ---------------------------------------------------------------------

describe('2026-09-18 review group A1 (R10, R17) regressions', () => {
  it('R10a (QUERY_ALIAS): mutating a queryEntity result cannot change authoritative state', () => {
    const root = makeRoot('r10a');
    try {
      const s = openWorkspaceService({ root, backendId: BACKEND_ID });
      expect(s.createProject('demo', 'Demo').ok).toBe(true);
      const req = request(0);
      const ack = s.runCommand(req);
      expect(ack.ok).toBe(true);
      if (ack.ok !== true) throw new Error('createEntity failed');
      const createdId = ack.createdId;
      if (createdId === undefined) throw new Error('createdId missing');

      const q1 = s.query({ op: 'queryEntity', projectId: 'demo', args: { entityId: createdId } }) as QueryEntityResult;
      expect(q1.ok).toBe(true);
      if (q1.ok !== true) throw new Error('queryEntity failed');
      // Probe QUERY_ALIAS: the caller rewrites the exported entity.
      attempt(() => {
        const entity = q1.entity as { name: string };
        entity.name = 'not-a-command';
      });
      // Same revision: the query shows the UNMODIFIED name.
      const q2 = s.query({ op: 'queryEntity', projectId: 'demo', args: { entityId: createdId } }) as QueryEntityResult;
      expect(q2.ok).toBe(true);
      if (q2.ok !== true) throw new Error('queryEntity (2) failed');
      expect(q2.revision).toBe(1);
      expect((q2.entity as { name?: string }).name).toBe(req.args.name);
      // An unrelated mutation succeeds.
      expect(s.runCommand(request(1)).ok).toBe(true);
      // Reopen (fresh service, same root, same identity): the on-disk
      // name is the original.
      s.dispose();
      const s2 = openWorkspaceService({ root, backendId: BACKEND_ID });
      const q3 = s2.query({ op: 'queryEntity', projectId: 'demo', args: { entityId: createdId } }) as QueryEntityResult;
      expect(q3.ok).toBe(true);
      if (q3.ok !== true) throw new Error('queryEntity after reopen failed');
      expect((q3.entity as { name?: string }).name).toBe(req.args.name);
      s2.dispose();
    } finally {
      dropRoot(root);
    }
  });

  it('R10b (ACK_ALIAS): mutating a success ack cannot corrupt the dedup retry or the durable retry records', () => {
    const root = makeRoot('r10b');
    try {
      const s = openWorkspaceService({ root, backendId: BACKEND_ID });
      expect(s.createProject('demo', 'Demo').ok).toBe(true);
      const req = request(0);
      const ack = s.runCommand(req);
      expect(ack.ok).toBe(true);
      if (ack.ok !== true) throw new Error('createEntity failed');
      const originalDepth = ack.history.undoDepth;
      expect(originalDepth).toBe(1);
      // Probe ACK_ALIAS: the caller corrupts the returned history.
      attempt(() => {
        ack.history.undoDepth = -1;
      });
      // The dedup retry of the SAME request returns the original undoDepth.
      const retry = s.runCommand(req);
      expect(retry.ok).toBe(true);
      if (retry.ok !== true) throw new Error('retry failed');
      expect(retry.duplicated).toBe(true);
      expect(retry.history.undoDepth).toBe(originalDepth);
      // A subsequent different mutation succeeds.
      expect(s.runCommand(request(1)).ok).toBe(true);
      // Reopen (fresh service, same root, same identity): the retry
      // records load and replay identically (no `retry_records_invalid`).
      s.dispose();
      const s2 = openWorkspaceService({ root, backendId: BACKEND_ID });
      const q = s2.query({ op: 'queryProject', projectId: 'demo' }) as QueryResult;
      expect(q.ok).toBe(true);
      if (q.ok !== true) throw new Error(`reopen query failed: ${JSON.stringify(q.error)}`);
      const replay = s2.runCommand(req);
      expect(replay.ok).toBe(true);
      if (replay.ok !== true) throw new Error('replay after reopen failed');
      expect(replay.duplicated).toBe(true);
      expect(replay.history.undoDepth).toBe(originalDepth);
      s2.dispose();
    } finally {
      dropRoot(root);
    }
  });

  it('R10c: mutating a queryProject result (manifest/scene/history/workspace) leaves state unaffected', () => {
    const root = makeRoot('r10c-proj');
    try {
      const s = openWorkspaceService({ root });
      expect(s.createProject('demo', 'Demo').ok).toBe(true);
      expect(s.runCommand(request(0)).ok).toBe(true);
      const q1 = s.query({ op: 'queryProject', projectId: 'demo' }) as QueryProjectResult;
      expect(q1.ok).toBe(true);
      if (q1.ok !== true) throw new Error('queryProject failed');
      const snapshot = JSON.stringify(q1);
      // One focused mutation per exported shape.
      attempt(() => {
        q1.manifest.name = 'not-a-command';
      });
      attempt(() => {
        q1.scene.entityCount = 999;
      });
      attempt(() => {
        q1.history.undoDepth = -1;
      });
      attempt(() => {
        (q1.workspace as { writePaused: boolean }).writePaused = true;
      });
      // Re-query: the projection is identical.
      const q2 = s.query({ op: 'queryProject', projectId: 'demo' });
      expect(JSON.stringify(q2)).toBe(snapshot);
      // An unrelated command is unaffected.
      expect(s.runCommand(request(1)).ok).toBe(true);
    } finally {
      dropRoot(root);
    }
  });

  it('R10c: mutating queryEntities entities / a queryEntity subtree leaves state unaffected', () => {
    const root = makeRoot('r10c-ents');
    try {
      const s = openWorkspaceService({ root });
      expect(s.createProject('demo', 'Demo').ok).toBe(true);
      const first = s.runCommand(request(0));
      expect(first.ok).toBe(true);
      if (first.ok !== true) throw new Error('createEntity failed');
      const createdId = first.createdId;
      if (createdId === undefined) throw new Error('createdId missing');
      expect(s.runCommand(request(1)).ok).toBe(true);

      // Entities page.
      const qe = s.query({ op: 'queryEntities', projectId: 'demo' }) as QueryEntitiesResult;
      expect(qe.ok).toBe(true);
      if (qe.ok !== true) throw new Error('queryEntities failed');
      const pageSnapshot = JSON.stringify(qe);
      const target = qe.entities[1];
      if (target === undefined) throw new Error('expected the created entity on the page');
      attempt(() => {
        (target as { name: string }).name = 'not-a-command';
      });
      const qe2 = s.query({ op: 'queryEntities', projectId: 'demo' });
      expect(JSON.stringify(qe2)).toBe(pageSnapshot);

      // Subtree.
      const sub1 = s.query({ op: 'queryEntity', projectId: 'demo', args: { entityId: createdId, includeSubtree: true } }) as QueryEntityResult;
      expect(sub1.ok).toBe(true);
      if (sub1.ok !== true) throw new Error('queryEntity failed');
      const sub = sub1.subtree;
      if (sub === undefined) throw new Error('subtree missing');
      const subTarget = sub.entities[0];
      if (subTarget === undefined) throw new Error('subtree is empty');
      const subSnapshot = JSON.stringify(sub1);
      attempt(() => {
        (subTarget as { name: string }).name = 'not-a-command';
      });
      const sub2 = s.query({ op: 'queryEntity', projectId: 'demo', args: { entityId: createdId, includeSubtree: true } });
      expect(JSON.stringify(sub2)).toBe(subSnapshot);

      // An unrelated command is unaffected.
      expect(s.runCommand(request(2)).ok).toBe(true);
    } finally {
      dropRoot(root);
    }
  });

  it("R10c: mutating a query failure's error payload cannot change the re-issued failure", () => {
    const root = makeRoot('r10c-err');
    try {
      const s = openWorkspaceService({ root });
      expect(s.createProject('demo', 'Demo').ok).toBe(true);
      // The SAME caller object is passed to both queries: pre-repair the
      // raw value was echoed by reference (error.found === argValue), so
      // the attempt below rewrote the CALLER's input object.
      const argValue = { nested: { deep: 1 } };
      const bad1 = s.query({ op: 'queryEntity', projectId: 'demo', args: { entityId: argValue } }) as QueryResult;
      expect(bad1.ok).toBe(false);
      if (bad1.ok !== false) throw new Error('expected a validation failure');
      expect(bad1.error.cls).toBe('validation');
      const bad1Snapshot = JSON.stringify(bad1);
      const found = bad1.error.found as { nested: { deep: number } } | undefined;
      if (found === undefined) throw new Error('found missing');
      attempt(() => {
        found.nested.deep = 2;
      });
      // The re-issued failure serializes identically, and the caller's own
      // input object was not mutated through the echoed `found`.
      const bad2 = s.query({ op: 'queryEntity', projectId: 'demo', args: { entityId: argValue } });
      expect(JSON.stringify(bad2)).toBe(bad1Snapshot);
      expect(argValue.nested.deep).toBe(1);
      // Subsequent valid queries are unaffected.
      expect(s.query({ op: 'queryProject', projectId: 'demo' }).ok).toBe(true);
    } finally {
      dropRoot(root);
    }
  });

  it('R17 (ERROR_JSON): a BigInt arg yields a serializable, bounded validation failure', () => {
    const root = makeRoot('r17-bigint');
    try {
      const s = openWorkspaceService({ root });
      expect(s.createProject('demo', 'Demo').ok).toBe(true);
      const result = s.query({ op: 'queryEntities', projectId: 'demo', args: { limit: 1n } });
      expect(result.ok).toBe(false);
      if (result.ok !== false) throw new Error('expected a validation failure');
      expect(result.error.cls).toBe('validation');
      expect(result.error.code).toBe('field_type');
      // R17: JSON.stringify(result) must not throw.
      let serialized = '';
      expect(() => {
        serialized = JSON.stringify(result);
      }).not.toThrow();
      expect(serialized.length).toBeLessThanOrEqual(BOUNDED);
      // The diagnostic is a bounded string form, not the raw BigInt.
      const found = (JSON.parse(serialized) as { error: { found: unknown } }).error.found;
      expect(typeof found).toBe('string');
    } finally {
      dropRoot(root);
    }
  });

  it('R17 (ERROR_JSON): a self-referencing arg yields a serializable, bounded validation failure', () => {
    const root = makeRoot('r17-cycle');
    try {
      const s = openWorkspaceService({ root });
      expect(s.createProject('demo', 'Demo').ok).toBe(true);
      const cycle: Record<string, unknown> = { id: 'demo' };
      cycle.self = cycle;
      // Spec case: queryProject with an unknown args field (the key is
      // echoed, the value is not read).
      const r1 = s.query({ op: 'queryProject', projectId: 'demo', args: { entityId: cycle } });
      expect(r1.ok).toBe(false);
      if (r1.ok !== false) throw new Error('expected a validation failure');
      expect(r1.error.cls).toBe('validation');
      expect(() => JSON.stringify(r1)).not.toThrow();
      expect(JSON.stringify(r1).length).toBeLessThanOrEqual(BOUNDED);
      // queryEntity echoes the CYCLIC VALUE itself in `found` (the R17
      // mechanism: the raw value was copied into the error).
      const r2 = s.query({ op: 'queryEntity', projectId: 'demo', args: { entityId: cycle } });
      expect(r2.ok).toBe(false);
      if (r2.ok !== false) throw new Error('expected a validation failure');
      expect(r2.error.cls).toBe('validation');
      expect(() => JSON.stringify(r2)).not.toThrow();
      expect(JSON.stringify(r2).length).toBeLessThanOrEqual(BOUNDED);
      const found = (JSON.parse(JSON.stringify(r2)) as { error: { found: { self: unknown } } }).error.found;
      expect(typeof found.self).toBe('string'); // cycle marker, not a nested object
    } finally {
      dropRoot(root);
    }
  });
});