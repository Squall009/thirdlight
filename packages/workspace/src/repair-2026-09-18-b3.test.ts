/**
 * 2026-09-18 review repair — group B3 (R7) regression tests.
 *
 * R7 (docs/reviews/2026-09-18-commits.md): containment checks are bypassed
 * by the startup scan and by child-directory symlinks. The supported
 * policy is now ONE rule, applied at every path site (scan, creation,
 * session open, and all subsequent path building):
 *
 *   A project of this backend is a real directory tree under the data
 *   root; any symlink component escaping the data root makes the path
 *   NOT a project of this backend — verified before any content-acting
 *   read or any write. (A hostile unlink-replace race AFTER
 *   verification is the workspace.md §7.1 bypassing-actor class —
 *   documented bound, not solved.)
 *
 * The three findings' repros, each against a DISPOSABLE outside
 * directory (mkdtemp) — symlinks never point at repo/user paths:
 *
 *   1. R7 scan: a project-directory symlink under the root, pointing at
 *      an outside directory with a valid manifest + empty scenes/, must
 *      NOT be completed by the startup scan (no main.json outside), the
 *      report entry must be an orphan with the escape note (NOT
 *      completed), and a query must reject the project.
 *   2. R7 scenes/.thirdlight: a real project whose scenes (resp.
 *      .thirdlight) is replaced by a symlink to an outside directory —
 *      a mutation on a FRESH open must fail with the
 *      `project_not_found` class and must leave the outside bytes
 *      UNCHANGED (no envelope write, no ownership claim, no recovery).
 *   3. R7 create: a projects name symlinked at an outside directory —
 *      `createProject` must return `project_exists_invalid` (a loadable
 *      outside project) with NO new files inside or outside.
 *
 * Real filesystem, unprivileged (symlink behavior is real).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from '@thirdlight/workspace';

// ---- disposable roots (mkdtemp data roots AND outside dirs; finally) ----

const roots: string[] = [];

function mkdtemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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

/** Sorted directory names (empty when absent) — the "unchanged" oracle. */
function listing(p: string): string[] {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
}

/**
 * Sorted recursive tree listing (relative names; dirs end with '/').
 * Symlinks are NOT followed (the outside trees contain no symlinks).
 */
function tree(p: string): string[] {
  const out: string[] = [];
  for (const n of listing(p)) {
    let st;
    try {
      st = statSync(join(p, n));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(`${n}/`);
      for (const rel of tree(join(p, n))) out.push(join(n, rel));
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Byte comparison (the ES2022 lib has no `Uint8Array.prototype.equals`). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

let seq = 0;
function nextRequestId(): string {
  seq += 1;
  return `req-${seq.toString(16).padStart(32, '0')}`;
}

/** A valid project manifest matching the directory name `id`. */
function manifestBytes(id: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    id,
    name: 'Demo',
    createdAt: '2026-09-17T00:00:00Z',
    scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
  });
}

/** The R7 escape note the scan must report (pinned verbatim). */
const SCAN_ESCAPE_NOTE =
  'directory is not a contained project of this backend (symlink escape or missing path) — not completed, not modified';

/** The R7 create-gate detail message (pinned verbatim). */
const CREATE_ESCAPE_DETAIL =
  'the project directory is a symlink escape or an unresolvable path — not a project of this backend';

// ---- the three R7 cases --------------------------------------------------------

describe('R7 (group B3): one containment policy at scan / create / session-open', () => {
  it('1. R7 scan: a symlinked project dir is NOT completed — no outside write, orphan entry, query rejects', () => {
    const r = mkdtemp('tl07-b3-root-');
    const out = mkdtemp('tl07-b3-out-');
    const od = join(out, 'demo');
    try {
      // Outside: a valid manifest + an EMPTY scenes/ (the interrupted-
      // creation shape the scan would otherwise complete).
      mkdirSync(join(od, 'scenes'), { recursive: true });
      writeFileSync(join(od, 'project.json'), manifestBytes('demo'));
      const outsideBefore = tree(od);

      // The escape: projects/demo → the outside directory.
      mkdirSync(join(r, 'projects'), { recursive: true });
      symlinkSync(od, join(r, 'projects', 'demo'), 'dir');

      // Opening the service runs the startup scan.
      const s = openWorkspaceService({ root: r });
      try {
        // (a) The outside tree is UNCHANGED — no main.json was created
        //     outside the data root (pre-fix: the scan completed the
        //     creation through the symlink).
        expect(listing(join(od, 'scenes')), 'outside scenes must stay empty').toEqual([]);
        expect(existsSync(join(od, 'scenes', 'main.json'))).toBe(false);
        expect(tree(od)).toEqual(outsideBefore);

        // (b) The report entry is an ORPHAN with the escape note — NOT
        //     completed, not modified.
        const entry = s.lastScan.entries.find((e) => e.projectId === 'demo');
        expect(entry, 'the scan must report the demo entry').toBeDefined();
        expect(entry?.kind).toBe('orphan');
        expect(entry?.completion, 'the escaped entry must NOT be completed').toBeUndefined();
        expect(entry?.note).toBe(SCAN_ESCAPE_NOTE);

        // (c) A query rejects the escaped project.
        const q = s.query({ op: 'queryProject', projectId: 'demo' });
        expect(q.ok, JSON.stringify(q)).toBe(false);
        if (!q.ok) expect(q.error.code).toBe('project_not_found');
      } finally {
        s.dispose();
      }
    } finally {
      dropRoot(r);
      dropRoot(out);
    }
  });

  it('2a. R7 scenes: scenes replaced by an outside symlink — fresh-open mutation fails project_not_found, outside envelope unchanged', () => {
    const r = mkdtemp('tl07-b3-root-');
    const out = mkdtemp('tl07-b3-out-');
    const d = join(r, 'projects', 'demo');
    const scenesOut = join(out, 'scenes');
    try {
      // A valid project, released (a fresh open re-claims the released
      // record — no liveness ambiguity).
      const s1 = openWorkspaceService({ root: r });
      const c = s1.createProject('demo', 'Demo');
      expect(c, JSON.stringify(c)).toEqual({ ok: true, created: true, revision: 0 });
      const rel = s1.releaseWorkspace('demo');
      expect(rel.ok, JSON.stringify(rel)).toBe(true);
      s1.dispose();

      // The escape: move the real scenes OUTSIDE, symlink it back in.
      renameSync(join(d, 'scenes'), scenesOut); // carries the valid envelope
      symlinkSync(scenesOut, join(d, 'scenes'), 'dir');
      const envBefore = readFileSync(join(scenesOut, 'main.json'));
      const ownBefore = readFileSync(join(d, '.thirdlight', 'ownership.json'));

      // A FRESH service: the mutation must fail with the project_not_
      // found class — and write NOTHING (pre-fix: the claim landed
      // locally and the envelope write went through the symlink
      // OUTSIDE).
      const s2 = openWorkspaceService({ root: r });
      try {
        const m = s2.runCommand({
          op: 'createEntity',
          projectId: 'demo',
          expectedRevision: 0,
          requestId: nextRequestId(),
          args: { kind: 'box' },
        });
        expect(m.ok, JSON.stringify(m)).toBe(false);
        if (!m.ok) expect(m.error.code).toBe('project_not_found');
        expect(
          bytesEqual(readFileSync(join(scenesOut, 'main.json')), envBefore),
          'the outside envelope must be byte-identical',
        ).toBe(true);
        expect(
          bytesEqual(readFileSync(join(d, '.thirdlight', 'ownership.json')), ownBefore),
          'no ownership claim may be written locally',
        ).toBe(true);
      } finally {
        s2.dispose();
      }
    } finally {
      dropRoot(r);
      dropRoot(out);
    }
  });

  it('2b. R7 .thirdlight: .thirdlight replaced by an outside symlink — fresh-open mutation fails project_not_found, outside byte-identical', () => {
    const r = mkdtemp('tl07-b3-root-');
    const out = mkdtemp('tl07-b3-out-');
    const d = join(r, 'projects', 'demo');
    const tlOut = join(out, '.thirdlight');
    try {
      const s1 = openWorkspaceService({ root: r });
      const c = s1.createProject('demo', 'Demo');
      expect(c, JSON.stringify(c)).toEqual({ ok: true, created: true, revision: 0 });
      const rel = s1.releaseWorkspace('demo');
      expect(rel.ok, JSON.stringify(rel)).toBe(true);
      s1.dispose();

      // The escape: move the real .thirdlight OUTSIDE (it carries the
      // released ownership record + recovery/), symlink it back in.
      renameSync(join(d, '.thirdlight'), tlOut);
      symlinkSync(tlOut, join(d, '.thirdlight'), 'dir');
      const ownBefore = readFileSync(join(tlOut, 'ownership.json'));
      const tlListBefore = listing(tlOut);

      // A FRESH service: the mutation (which would claim the released
      // record — an ownership WRITE through .thirdlight) must fail with
      // the project_not_found class — pre-fix the claim was written
      // INTO the outside directory.
      const s2 = openWorkspaceService({ root: r });
      try {
        const m = s2.runCommand({
          op: 'createEntity',
          projectId: 'demo',
          expectedRevision: 0,
          requestId: nextRequestId(),
          args: { kind: 'box' },
        });
        expect(m.ok, JSON.stringify(m)).toBe(false);
        if (!m.ok) expect(m.error.code).toBe('project_not_found');
        expect(
          bytesEqual(readFileSync(join(tlOut, 'ownership.json')), ownBefore),
          'the outside ownership record must be byte-identical',
        ).toBe(true);
        expect(listing(tlOut), 'no new file may appear outside').toEqual(tlListBefore);
      } finally {
        s2.dispose();
      }
    } finally {
      dropRoot(r);
      dropRoot(out);
    }
  });

  it('3. R7 create: a symlinked projects name ⇒ project_exists_invalid, no new files inside or outside', () => {
    const r = mkdtemp('tl07-b3-root-');
    const out = mkdtemp('tl07-b3-out-');
    const od = join(out, 'projects', 'demo');
    try {
      // Outside: a FULLY LOADABLE project (manifest + envelope +
      // .thirdlight) — created for real by a service on the outside
      // root.
      const so = openWorkspaceService({ root: out });
      const co = so.createProject('demo', 'Demo');
      expect(co, JSON.stringify(co)).toEqual({ ok: true, created: true, revision: 0 });
      so.dispose();
      const outsideBefore = tree(od);
      const outsideFlatBefore = listing(od);

      // The escape: projects/demo → the outside project directory.
      mkdirSync(join(r, 'projects'), { recursive: true });
      symlinkSync(od, join(r, 'projects', 'demo'), 'dir');

      // createProject must fail `project_exists_invalid` (pre-fix: the
      // read-only converge LOADS the outside project and returns the
      // idempotent no-op success).
      const s = openWorkspaceService({ root: r });
      try {
        const res = s.createProject('demo', 'X');
        expect(res.ok, JSON.stringify(res)).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('project_exists_invalid');
          const details = res.error.details;
          expect(details?.length, 'one escape detail').toBe(1);
          expect(details?.[0]?.code).toBe('manifest_invalid');
          expect(details?.[0]?.path).toBe('');
          expect(details?.[0]?.message).toBe(CREATE_ESCAPE_DETAIL);
        }
        // No new files OUTSIDE ...
        expect(tree(od), 'the outside tree must be unchanged').toEqual(outsideBefore);
        // ... and INSIDE (only the symlink itself, no created files).
        expect(listing(join(r, 'projects'))).toEqual(['demo']);
        expect(listing(od)).toEqual(outsideFlatBefore);
      } finally {
        s.dispose();
      }
    } finally {
      dropRoot(r);
      dropRoot(out);
    }
  });
});