/**
 * 2026-09-18 review repair — group B1 (R14) regression tests.
 *
 * R14: the startup scan's 100-entry LOG cap (workspace.md §10: "bounded
 * log: ≤ 100 project entries, then a count") was applied to the WORK:
 * `scanEntry` was never called for entries beyond index 99, so the
 * deterministic §8.3 completion (and the corruption/stale reporting) never
 * ran for them, and a repeated scan never reached them (the cap is
 * positional, and sort order is stable).
 *
 * These tests pin the desired post-repair behavior through the public API
 * and the on-disk state only:
 *
 *   1. cap is on the log, not work — 101 manifest-only projects (interrupted
 *      creation) ⇒ the fresh service's startup scan completes ALL 101
 *      envelopes (the 101st included), while the report keeps exactly 100
 *      entries, `total === 101`, `truncated === true`, and the report object
 *      keeps exactly its current field set (entries/total/truncated).
 *   2. work beyond index 99 on a non-completable entry — a corrupt envelope
 *      at p100 does not abort the open, its bytes are retained
 *      byte-identical, and a low-index project (p000) is queryable and
 *      mutable through the fresh service.
 *   3. on-demand access does not complete a blocked entry — querying p100
 *      on the same fresh service fails with the structured loader error
 *      (`project_unavailable` / `encoding_invalid` for the invalid-UTF-8
 *      bytes) and p100's bytes stay byte-identical: neither the scan's work
 *      nor the on-demand open completes or repairs a blocked entry.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  openWorkspaceService,
  type QueryResult,
  type WorkspaceService,
} from '@thirdlight/workspace';

// ---- disposable roots (mkdtemp data roots; cleaned up in finally) ----------

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tl07-b1-'));
  roots.push(root);
  return root;
}

function dropRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort — the afterAll backstop retries
  }
}

afterAll(() => {
  for (const r of roots.splice(0)) dropRoot(r);
});

// ---- helpers -----------------------------------------------------------------

/** Pinned backend identity (the durable records are format-checked). */
const BACKEND_ID = 'tb-b1b2b3b4b5b6b7b8b9b0b1b2b3b4b5b6';

/** The 101 project ids: p000 … p100 (p100 is index 100 — beyond the cap). */
const IDS: readonly string[] = Array.from(
  { length: 101 },
  (_, i) => `p${i.toString().padStart(3, '0')}`,
);

/** The garbage envelope bytes (invalid UTF-8 ⇒ `encoding_invalid`, §4.3 step 1). */
const GARBAGE = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0xc0]);

let seq = 0;
function nextRequestId(): string {
  seq += 1;
  return `req-${seq.toString(16).padStart(32, '0')}`;
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

/** Create the 101 complete projects p000…p100 with one service. */
function createAll(root: string): WorkspaceService {
  const s = openWorkspaceService({ root, backendId: BACKEND_ID });
  for (const id of IDS) {
    const c = s.createProject(id, `Project ${id}`);
    if (c.ok !== true) {
      throw new Error(`createProject(${id}) failed: ${JSON.stringify(c)}`);
    }
  }
  return s;
}

/** Drop every envelope (manifests remain ⇒ 101 manifest-only projects). */
function unlinkAllEnvelopes(root: string): void {
  for (const id of IDS) unlinkSync(scenePath(root, id));
}

describe('R14 (group B1): the scan cap bounds the LOG, not the work', () => {
  // Shared state for tests 2 and 3 (test 3 runs on the SAME fresh service).
  let service: WorkspaceService | null = null;
  let root: string | null = null;

  it(
    '1. cap is on the log, not work: all 101 completions run; report keeps 100 entries',
    () => {
      const r = makeRoot();
      root = r;
      try {
        const s = createAll(r);
        s.dispose();
        // Interrupted-creation state for all 101.
        unlinkAllEnvelopes(r);

        // A fresh service: the startup scan must visit every entry.
        const s2 = openWorkspaceService({ root: r, backendId: BACKEND_ID });

        // (a) ALL 101 envelopes exist on disk — the 101st (index 100)
        // included. Pre-fix, the scan never reached p100, so its
        // completion never wrote the envelope.
        for (const id of IDS) {
          expect(existsSync(scenePath(r, id)), `missing ${id}/scenes/main.json`).toBe(true);
        }

        // (b) the bounded log: 100 entries, total 101, truncated.
        const report = s2.lastScan;
        expect(report.total).toBe(101);
        expect(report.entries.length).toBe(100);
        expect(report.truncated).toBe(true);

        // (c) the report keeps EXACTLY its current field set (no new
        // fields — the cap is on the log, not the report's shape).
        expect(Object.keys(report).sort()).toEqual(['entries', 'total', 'truncated']);

        s2.dispose();
      } finally {
        root = null;
        dropRoot(r);
      }
    },
  );

  it('2. work beyond index 99 on a non-completable entry: corrupt p100 does not abort the open; p000 usable', () => {
    const r = makeRoot();
    root = r;
    try {
      const s = createAll(r);
      s.dispose();
      unlinkAllEnvelopes(r);
      // The 101st entry (index 100) cannot complete: corrupt envelope bytes.
      writeFileSync(scenePath(r, 'p100'), GARBAGE);

      let s2: WorkspaceService | undefined;
      let openError: unknown = null;
      try {
        s2 = openWorkspaceService({ root: r, backendId: BACKEND_ID });
      } catch (e) {
        openError = e;
      }
      expect(openError, `open threw: ${String(openError)}`).toBeNull();
      if (s2 === undefined) throw new Error('openWorkspaceService threw (caught)');
      service = s2;

      // The scan's work beyond index 99 reported the corruption WITHOUT
      // touching the bytes: p100's corrupt bytes are byte-identical.
      expect(bytesEqual(readFileSync(scenePath(r, 'p100')), GARBAGE)).toBe(true);

      // The low-index project (p000) was completed by the scan and is
      // queryable and mutable through the fresh service.
      const q = s2.query({ op: 'queryProject', projectId: 'p000' }) as QueryResult;
      expect(q.ok).toBe(true);
      if (q.ok !== true) throw new Error(`p000 query failed: ${JSON.stringify(q)}`);
      const m = s2.runCommand({
        op: 'createEntity',
        projectId: 'p000',
        expectedRevision: q.revision,
        requestId: nextRequestId(),
        args: { kind: 'box' },
      });
      expect(m.ok, JSON.stringify(m)).toBe(true);
      // NOTE: the service is left OPEN on purpose — test 3 runs on this
      // same fresh service (the task's guard case). Its cleanup owns the
      // dispose + root drop.
    } finally {
      // Only clean up the root if the service itself is not left open for
      // test 3 (i.e. this test threw before reaching the end).
      if (service === null) {
        root = null;
        dropRoot(r);
      }
    }
  });

  it('3. on-demand access does not complete a blocked entry: p100 stays blocked and byte-identical', () => {
    // Same fresh service as test 2 (it must still be open and p100 corrupt).
    const s = service;
    const r = root;
    if (s === null || r === null) {
      throw new Error('test 2 did not leave the shared fresh service open');
    }
    try {
      // (a) querying p100 is a STRUCTURED failure pinning the code the
      // current loader produces for the corrupt (invalid-UTF-8) envelope —
      // the project is blocked until operator repair, never auto-completed.
      const q = s.query({ op: 'queryProject', projectId: 'p100' }) as QueryResult;
      expect(q.ok).toBe(false);
      if (q.ok !== false) throw new Error(`p100 query unexpectedly ok: ${JSON.stringify(q)}`);
      expect(q.error.code).toBe('project_unavailable');
      expect(q.error.cls).toBe('unavailable');
      expect(q.error.reason).toBe('encoding_invalid');

      // (b) neither the scan's work nor the on-demand open completed or
      // repaired the blocked entry: p100's bytes are byte-identical.
      expect(bytesEqual(readFileSync(scenePath(r, 'p100')), GARBAGE)).toBe(true);
    } finally {
      service = null;
      root = null;
      s.dispose();
      dropRoot(r);
    }
  });
});