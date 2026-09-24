/**
 * 2026-09-18 review repair — group B2 (R15) regression tests.
 *
 * R15: the existing-directory path of `createProject` (workspace.md §8.1
 * idempotency) called `ensureSession` — the FULL on-demand open pipeline —
 * instead of checking loadable disk state without side effects. Reproduced:
 * a healthy project owned by another live identity, or released by this
 * backend, returned `project_exists_invalid` (ownership) or succeeded with
 * a NEW claim written over the released record; a create on a corrupt
 * envelope with no ownership record wrote a new claim before returning the
 * failure. §8.1 is the authority: directory present + loads strictly ⇒
 * idempotent no-op `{ ok: true, created: false, revision }`; directory
 * present + unloadable ⇒ `project_exists_invalid` (with the load errors)
 * and NOTHING written.
 *
 * The acceptance here is the on-disk bytes: the ownership record
 * (`projects/<id>/.thirdlight/ownership.json`) and the project files
 * (storage v4: `projects/<id>/scenes/scene-main.json` and
 * `projects/<id>/content.json`) are captured before the second
 * `createProject` and must be byte-identical (or still absent) after it.
 *
 *   1. valid + owned by another live identity ⇒ `{ ok, created: false }`
 *      (pre-fix: `project_exists_invalid` / ownership_conflict) + ownership
 *      and envelope bytes identical.
 *   2. valid + released ⇒ `{ ok, created: false }` + ownership bytes
 *      identical (pre-fix: success but a new claim written over the
 *      released record).
 *   3. valid + owned by self (session already open) ⇒ `{ ok, created:
 *      false }` + ownership and envelope bytes identical (same-service
 *      guard).
 *   4. corrupt scene file, no ownership ⇒ `project_exists_invalid` with the
 *      load details + ownership file ABSENT afterwards (pre-fix: a new
 *      claim written before the failure).
 *   5. garbage manifest, no ownership ⇒ `project_exists_invalid` +
 *      ownership ABSENT afterwards.
 *   6. absent directory unchanged ⇒ `{ ok, created: true, revision: 0 }`
 *      and a first mutation succeeds (the creation flow still works).
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

import { openWorkspaceService } from '@thirdlight/workspace';

// ---- disposable roots (mkdtemp data roots; cleaned up in finally) ----------

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tl07-b2-'));
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

/** Instance 1's pinned backend identity (the durable records are format-checked). */
const BACKEND_ID = 'tb-c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';

/** The garbage bytes (invalid UTF-8 ⇒ `encoding_invalid`, §4.3 step 1). */
const GARBAGE = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0xc0]);

function projectDir(root: string, id: string): string {
  return join(root, 'projects', id);
}

function scenePath(root: string, id: string): string {
  return join(root, 'projects', id, 'scenes', 'scene-main.json');
}

function contentPath(root: string, id: string): string {
  return join(root, 'projects', id, 'content.json');
}

/**
 * The acceptance oracle: the bytes of
 * `projects/<id>/.thirdlight/ownership.json`, or `null` if the file is
 * absent. (`dir` is the project directory.)
 */
function ownBytes(dir: string): Uint8Array | null {
  const p = join(dir, '.thirdlight', 'ownership.json');
  return existsSync(p) ? readFileSync(p) : null;
}

/** Byte comparison (the ES2022 lib has no `Uint8Array.prototype.equals`). */
function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Parse an ownership record's fields (the test asserts identity, not format). */
function ownIdentity(bytes: Uint8Array | null): { backendId: string; pid: number; state: string } | null {
  if (bytes === null) return null;
  const rec = JSON.parse(new TextDecoder().decode(bytes)) as {
    backendId: string;
    pid: number;
    state: string;
  };
  return rec;
}

let seq = 0;
function nextRequestId(): string {
  seq += 1;
  return `req-${seq.toString(16).padStart(32, '0')}`;
}

// ---- the six R15 cases ---------------------------------------------------------

describe('R15 (group B2): the idempotent createProject is read-only (§8.1)', () => {
  it('1. valid + owned by another live identity: idempotent no-op, nothing written', () => {
    const r = makeRoot();
    const dir = projectDir(r, 'demo');
    try {
      // Instance 2 (a FOREIGN identity — no pinned backendId) creates and
      // claims, then is disposed WITHOUT release: the record stays owned,
      // pid = the live test pid, foreign backendId.
      const s2 = openWorkspaceService({ root: r });
      const c2 = s2.createProject('demo', 'Demo');
      expect(c2, JSON.stringify(c2)).toEqual({ ok: true, created: true, revision: 0 });
      s2.dispose();

      const ownBefore = ownBytes(dir);
      const envBefore = readFileSync(scenePath(r, 'demo'));
      const contentBefore = readFileSync(contentPath(r, 'demo'));
      expect(ownBefore, 'the record must exist and still be owned').not.toBeNull();
      const rec = ownIdentity(ownBefore);
      expect(rec, 'record parse').not.toBeNull();
      expect(rec?.backendId).not.toBe(BACKEND_ID); // foreign identity
      expect(rec?.pid).toBe(process.pid); // the live test pid
      expect(rec?.state).toBe('owned');

      // Instance 1 (a fresh service, same root): the idempotent re-create
      // must be a no-op that writes NOTHING (pre-fix: `ensureSession`
      // evaluated ownership and returned `project_exists_invalid` /
      // ownership_conflict for this healthy foreign-owned project).
      const s1 = openWorkspaceService({ root: r, backendId: BACKEND_ID });
      try {
        const res = s1.createProject('demo', 'Demo');
        expect(res, JSON.stringify(res)).toEqual({ ok: true, created: false, revision: 0 });
        expect(
          bytesEqual(ownBytes(dir), ownBefore),
          'ownership record must be byte-identical',
        ).toBe(true);
        expect(bytesEqual(readFileSync(scenePath(r, 'demo')), envBefore), 'scene file must be byte-identical').toBe(true);
        expect(bytesEqual(readFileSync(contentPath(r, 'demo')), contentBefore), 'content.json must be byte-identical').toBe(true);
      } finally {
        s1.dispose();
      }
    } finally {
      dropRoot(r);
    }
  });

  it('2. valid + released: idempotent no-op, the released record is NOT re-claimed', () => {
    const r = makeRoot();
    const dir = projectDir(r, 'demo');
    try {
      // Instance 2 (foreign identity) creates and then releases: the
      // record is state "released" (the supported §9 hand-edit boundary).
      const s2 = openWorkspaceService({ root: r });
      const c2 = s2.createProject('demo', 'Demo');
      expect(c2, JSON.stringify(c2)).toEqual({ ok: true, created: true, revision: 0 });
      const rel = s2.releaseWorkspace('demo');
      expect(rel.ok, JSON.stringify(rel)).toBe(true);
      s2.dispose();

      const ownBefore = ownBytes(dir);
      const envBefore = readFileSync(scenePath(r, 'demo'));
      const contentBefore = readFileSync(contentPath(r, 'demo'));
      expect(ownBefore).not.toBeNull();
      const recBefore = ownIdentity(ownBefore);
      expect(recBefore?.state).toBe('released');
      expect(recBefore?.backendId).not.toBe(BACKEND_ID);

      // Instance 1: the idempotent re-create must be a no-op. (Pre-fix:
      // success, but `ensureSession` re-claimed the released record — a
      // new ownership write with instance 1's identity and epoch + 1.)
      const s1 = openWorkspaceService({ root: r, backendId: BACKEND_ID });
      try {
        const res = s1.createProject('demo', 'Demo');
        expect(res, JSON.stringify(res)).toEqual({ ok: true, created: false, revision: 0 });
        expect(bytesEqual(ownBytes(dir), ownBefore), 'the released record must NOT be rewritten').toBe(true);
        const recAfter = ownIdentity(ownBytes(dir));
        expect(recAfter?.backendId).toBe(recBefore?.backendId);
        expect(recAfter?.state).toBe('released');
        expect(bytesEqual(readFileSync(scenePath(r, 'demo')), envBefore), 'scene file must be byte-identical').toBe(true);
        expect(bytesEqual(readFileSync(contentPath(r, 'demo')), contentBefore), 'content.json must be byte-identical').toBe(true);
      } finally {
        s1.dispose();
      }
    } finally {
      dropRoot(r);
    }
  });

  it('3. valid + owned by self (session open): idempotent no-op, bytes identical', () => {
    const r = makeRoot();
    const dir = projectDir(r, 'demo');
    try {
      // Instance 1 creates (the session opens) and then re-creates the
      // same project on the SAME service.
      const s1 = openWorkspaceService({ root: r, backendId: BACKEND_ID });
      try {
        const c1 = s1.createProject('demo', 'Demo');
        expect(c1, JSON.stringify(c1)).toEqual({ ok: true, created: true, revision: 0 });

        const ownBefore = ownBytes(dir);
        const envBefore = readFileSync(scenePath(r, 'demo'));
        const contentBefore = readFileSync(contentPath(r, 'demo'));
        expect(ownBefore).not.toBeNull();
        expect(ownIdentity(ownBefore)?.backendId).toBe(BACKEND_ID);

        const res = s1.createProject('demo', 'Demo');
        expect(res, JSON.stringify(res)).toEqual({ ok: true, created: false, revision: 0 });
        expect(bytesEqual(ownBytes(dir), ownBefore), 'ownership record must be byte-identical').toBe(true);
        expect(bytesEqual(readFileSync(scenePath(r, 'demo')), envBefore), 'scene file must be byte-identical').toBe(true);
        expect(bytesEqual(readFileSync(contentPath(r, 'demo')), contentBefore), 'content.json must be byte-identical').toBe(true);
      } finally {
        s1.dispose();
      }
    } finally {
      dropRoot(r);
    }
  });

  it('4. corrupt scene file, no ownership: project_exists_invalid, NOTHING written', () => {
    const r = makeRoot();
    const dir = projectDir(r, 'demo');
    try {
      // Build a complete project, then hand-corrupt its scene file and
      // remove the ownership record.
      const s = openWorkspaceService({ root: r, backendId: BACKEND_ID });
      const c = s.createProject('demo', 'Demo');
      expect(c, JSON.stringify(c)).toEqual({ ok: true, created: true, revision: 0 });
      s.dispose();
      writeFileSync(scenePath(r, 'demo'), GARBAGE);
      const contentBefore = readFileSync(contentPath(r, 'demo'));
      unlinkSync(join(dir, '.thirdlight', 'ownership.json'));
      expect(ownBytes(dir)).toBeNull();

      // The fresh service's createProject must fail with the LOAD
      // details — and must not write a claim first (pre-fix: the
      // on-demand open claimed the (absent) record BEFORE the load
      // failed, leaving a fresh ownership file behind).
      const s2 = openWorkspaceService({ root: r, backendId: BACKEND_ID });
      try {
        const res = s2.createProject('demo', 'Demo');
        expect(res.ok, JSON.stringify(res)).toBe(false);
        if (res.ok) throw new Error('createProject unexpectedly succeeded');
        expect(res.error.code).toBe('project_exists_invalid');
        expect(res.error.cls).toBe('unavailable');
        const details = res.error.details;
        expect(details?.length ?? 0, 'the load details must be reported').toBeGreaterThan(0);
        expect(details?.[0]?.code).toBe('encoding_invalid');
        // The v4 loader blocks with envelope_invalid; the detail names the file.
        expect(details?.[0]?.path).toBe('/scenes/scene-main.json');
        // Nothing written: the ownership file is still ABSENT, the garbage
        // scene file and content.json are byte-identical.
        expect(ownBytes(dir), 'no ownership record may be written').toBeNull();
        expect(bytesEqual(readFileSync(scenePath(r, 'demo')), GARBAGE), 'scene bytes must be untouched').toBe(true);
        expect(bytesEqual(readFileSync(contentPath(r, 'demo')), contentBefore), 'content.json must be untouched').toBe(true);
      } finally {
        s2.dispose();
      }
    } finally {
      dropRoot(r);
    }
  });

  it('5. garbage manifest, no ownership: project_exists_invalid, ownership absent', () => {
    const r = makeRoot();
    const dir = projectDir(r, 'demo');
    try {
      // Same setup, but the MANIFEST is corrupted instead of the envelope.
      const s = openWorkspaceService({ root: r, backendId: BACKEND_ID });
      const c = s.createProject('demo', 'Demo');
      expect(c, JSON.stringify(c)).toEqual({ ok: true, created: true, revision: 0 });
      s.dispose();
      writeFileSync(join(dir, 'project.json'), GARBAGE);
      unlinkSync(join(dir, '.thirdlight', 'ownership.json'));
      expect(ownBytes(dir)).toBeNull();

      const s2 = openWorkspaceService({ root: r, backendId: BACKEND_ID });
      try {
        const res = s2.createProject('demo', 'Demo');
        expect(res.ok, JSON.stringify(res)).toBe(false);
        if (res.ok) throw new Error('createProject unexpectedly succeeded');
        expect(res.error.code).toBe('project_exists_invalid');
        const details = res.error.details;
        expect(details?.length ?? 0, 'the manifest load details must be reported').toBeGreaterThan(0);
        expect(details?.[0]?.code).toBe('encoding_invalid');
        expect(ownBytes(dir), 'no ownership record may be written').toBeNull();
      } finally {
        s2.dispose();
      }
    } finally {
      dropRoot(r);
    }
  });

  it('6. guard: absent directory — the creation flow still works (create + first mutation)', () => {
    const r = makeRoot();
    try {
      const s = openWorkspaceService({ root: r, backendId: BACKEND_ID });
      try {
        const res = s.createProject('fresh', 'Fresh');
        expect(res, JSON.stringify(res)).toEqual({ ok: true, created: true, revision: 0 });
        // A first mutation on the created project must succeed.
        const m = s.runCommand({
          op: 'createEntity',
          projectId: 'fresh',
          expectedRevision: 0,
          requestId: nextRequestId(),
          args: { kind: 'box' },
        });
        expect(m.ok, JSON.stringify(m)).toBe(true);
        if (m.ok) {
          expect(m.revision).toBe(1);
        }
      } finally {
        s.dispose();
      }
    } finally {
      dropRoot(r);
    }
  });
});