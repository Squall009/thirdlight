/**
 * Packet 23 — migration copy on the real filesystem (workspace.md §14).
 *
 * The accepted migration fixtures are executed: `migration/v1-source` is
 * copied read-only, the destination is compared byte-for-byte against
 * `migration/expected-v2-destination`, and `migration/interrupted-copy`
 * resumes from its recorded phase. The source project is re-hashed to prove it
 * is retained byte-for-byte.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

import { REPO_ROOT, buildFakeProc, fileBytes, makeRoot, seedProject, sha256Hex } from './helpers';

const MIGRATION = join(REPO_ROOT, 'fixtures', 'm2', 'contracts', 'migration');
const DEST_PROJECT = 'demo-m1-v2';
const CREATED_AT = '2026-09-18T12:00:00Z';

function hashTree(dir: string): string {
  return sha256Hex(fileBytes(join(dir, 'project.json'))) + ':' + sha256Hex(fileBytes(join(dir, 'scenes', 'main.json')));
}

function open(root: string, extra: Record<string, unknown> = {}): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => CREATED_AT, ...extra });
}

describe('packet 23 — explicit operator migration copy (workspace.md §14)', () => {
  it('copies an M1 source to a new M2 project, byte-identical to the fixture, source untouched', () => {
    const root = makeRoot('m2mig');
    seedProject(root, join(MIGRATION, 'v1-source'), 'demo-m1');
    const sourceDir = join(root, 'projects', 'demo-m1');
    const before = hashTree(sourceDir);

    const svc = open(root);
    const res = svc.migrateProjectCopy('demo-m1', DEST_PROJECT);
    if (!res.ok) throw new Error('migration failed: ' + JSON.stringify(res));
    expect(res.sourceRevision).toBe(3);
    expect(res.newRevision).toBe(0);
    expect(res.revisionPolicy).toBe('reset-to-zero');
    expect(res.historyReset).toBe(true);
    expect(res.retryCleared).toBe(true);
    expect(res.blobsCopied).toBe(0);
    expect(res.resumed).toBe(false);

    // The destination equals the accepted expected-v2-destination bytes.
    const destDir = join(root, 'projects', DEST_PROJECT);
    expect(Array.from(fileBytes(join(destDir, 'project.json')))).toEqual(
      Array.from(fileBytes(join(MIGRATION, 'expected-v2-destination', 'project.json'))),
    );
    expect(Array.from(fileBytes(join(destDir, 'scenes', 'main.json')))).toEqual(
      Array.from(fileBytes(join(MIGRATION, 'expected-v2-destination', 'scenes', 'main.json'))),
    );
    // The marker is removed and the destination is loadable as an M2 project.
    expect(existsSync(join(destDir, '.thirdlight', 'migration.json'))).toBe(false);
    const q = svc.query({ op: 'queryProject', projectId: DEST_PROJECT }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(0);

    // The source project is byte-identical and was never written.
    expect(hashTree(sourceDir)).toBe(before);

    // A second migration to the same (now loadable) destination refuses.
    const again = svc.migrateProjectCopy('demo-m1', DEST_PROJECT);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('migration_destination_exists');
    // The source is still byte-identical after the refusal.
    expect(hashTree(sourceDir)).toBe(before);
    svc.dispose();
  });

  it('reports an interrupted migration destination in the startup scan and never auto-completes it', () => {
    const root = makeRoot('m2mig-scan');
    seedProject(root, join(MIGRATION, 'v1-source'), 'demo-m1');
    seedProject(root, join(MIGRATION, 'interrupted-copy'), DEST_PROJECT);
    const destDir = join(root, 'projects', DEST_PROJECT);
    expect(existsSync(join(destDir, 'scenes', 'main.json'))).toBe(false);

    const svc = open(root);
    const scan = svc.scan();
    const entry = scan.entries.find((e) => e.projectId === DEST_PROJECT);
    expect(entry).toBeDefined();
    expect(entry!.migration).toBe('resume_required');
    expect(entry!.code).toBe('migration_resume_required');
    // The §8.3 default-envelope completion did NOT run.
    expect(existsSync(join(destDir, 'scenes', 'main.json'))).toBe(false);

    // Resume completes the destination and removes the marker.
    const res = svc.migrateProjectCopy('demo-m1', DEST_PROJECT);
    if (!res.ok) throw new Error('resume failed: ' + JSON.stringify(res));
    expect(res.resumed).toBe(true);
    expect(Array.from(fileBytes(join(destDir, 'scenes', 'main.json')))).toEqual(
      Array.from(fileBytes(join(MIGRATION, 'expected-v2-destination', 'scenes', 'main.json'))),
    );
    expect(existsSync(join(destDir, '.thirdlight', 'migration.json'))).toBe(false);
    // The resumed destination now loads.
    const q = svc.query({ op: 'queryProject', projectId: DEST_PROJECT }) as { ok: boolean };
    expect(q.ok).toBe(true);
    svc.dispose();
  });

  it('refuses a marker that names a different source (migration_marker_conflict) without writing', () => {
    const root = makeRoot('m2mig-conflict');
    seedProject(root, join(MIGRATION, 'v1-source'), 'demo-m1');
    const destDir = join(root, 'projects', DEST_PROJECT);
    mkdirSync(join(destDir, '.thirdlight'), { recursive: true });
    writeFileSync(
      join(destDir, '.thirdlight', 'migration.json'),
      JSON.stringify(
        {
          storageVersion: 1,
          type: 'migration-copy',
          sourceProjectId: 'demo-other',
          newProjectId: DEST_PROJECT,
          phase: 'manifest',
          startedAt: CREATED_AT,
        },
        null,
        2,
      ) + '\n',
    );
    const svc = open(root);
    const res = svc.migrateProjectCopy('demo-m1', DEST_PROJECT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('migration_marker_conflict');
    expect(existsSync(join(destDir, 'scenes', 'main.json'))).toBe(false);
    svc.dispose();
  });

  it('refuses a missing/invalid source and a source owned by a live backend', () => {
    const root = makeRoot('m2mig-src');
    seedProject(root, join(MIGRATION, 'v1-source'), 'demo-m1');
    const sourceThirdlight = join(root, 'projects', 'demo-m1', '.thirdlight');
    mkdirSync(sourceThirdlight, { recursive: true });
    writeFileSync(
      join(sourceThirdlight, 'ownership.json'),
      JSON.stringify(
        { storageVersion: 1, state: 'owned', backendId: 'tb-' + 'a'.repeat(32), pid: 4242, openedAt: '2026-09-17T09:00:00Z', lockEpoch: 0 },
        null,
        2,
      ) + '\n',
    );
    const procRoot = buildFakeProc(root, { 4242: 'live' }, 'thirdlight', '2026-09-17T09:00:00Z');
    const svc = openWorkspaceService({
      root,
      utcNow: () => CREATED_AT,
      procRoot,
      processMarker: 'thirdlight',
      // A distinct identity so the source's record is not "self".
      backendId: 'tb-' + 'b'.repeat(32),
    });
    const owned = svc.migrateProjectCopy('demo-m1', DEST_PROJECT);
    expect(owned.ok).toBe(false);
    if (!owned.ok) expect(owned.error.code).toBe('migration_source_invalid');

    const missing = svc.migrateProjectCopy('demo-nope', DEST_PROJECT);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('migration_source_invalid');

    const self = svc.migrateProjectCopy('demo-m1', 'demo-m1');
    expect(self.ok).toBe(false);
    svc.dispose();
  });
});
