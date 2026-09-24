/**
 * Phase 9.3 step B: the workspace opens storage v4 projects (and upgrades a
 * storage v3 project in place); a storage v1 (M1) or v2 (M2) project on disk
 * is refused with `project_unavailable { reason: "storage_version_unsupported" }`
 * for queries and commands alike, the startup scan reports it not loadable
 * with that code, and no project file is written (only the ownership record
 * under .thirdlight/, which every open claims).
 *
 * (The v3 → v4 upgrade on open is pinned by storage-v4.test.ts.)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult } from '@thirdlight/workspace';

import { makeRoot, seedLegacyProject } from './helpers';

/** Every file under `dir` (relative path → bytes), directories included as markers. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const r = rel === '' ? n : `${rel}/${n}`;
      if (statSync(p).isDirectory()) {
        out.set(`${r}/`, '');
        walk(p, r);
      } else {
        out.set(r, readFileSync(p).toString('base64'));
      }
    }
  };
  walk(dir, '');
  return out;
}

/** One pinned backend identity across the "restart" (like the other storage tests). */
const SELF = { backendId: 'tb-' + 'e'.repeat(32), pid: 6400 };

interface Unavailable {
  ok: false;
  error: { code: string; reason?: string; details?: { code: string; path: string; message: string }[] };
}

for (const version of [1, 2] as const) {
  describe(`a storage v${version} project on disk`, () => {
    it('is refused with project_unavailable storage_version_unsupported; nothing is written', () => {
      const root = makeRoot(`legacy-v${version}`);
      const projectId = `legacy-000${version}`;
      const dir = seedLegacyProject(root, projectId, version);
      const before = tree(dir);
      expect([...before.keys()]).toEqual(['project.json', 'scenes/', 'scenes/main.json']);

      const svc = openWorkspaceService({ root, ...SELF });

      // The startup scan: a project, not loadable, with the code.
      const entry = svc.lastScan.entries.find((e) => e.projectId === projectId);
      expect(entry).toMatchObject({ kind: 'project', loadable: false, code: 'storage_version_unsupported' });
      expect(entry?.completion).toBeUndefined();

      // A query is refused.
      const q = svc.query({ op: 'queryProject', projectId }) as unknown as Unavailable;
      expect(q.ok).toBe(false);
      expect(q.error.code).toBe('project_unavailable');
      expect(q.error.reason).toBe('storage_version_unsupported');
      // The details name the storage version and say what to do.
      const detail = q.error.details?.[0];
      expect(detail?.code).toBe('storage_version_unsupported');
      expect(detail?.path).toBe('/storageVersion');
      expect(detail?.message).toContain(`storage version ${version}`);

      // A command is refused the same way (never applied, never recorded).
      const c = svc.runCommand({
        op: 'createEntity',
        projectId,
        expectedRevision: 0,
        requestId: `req-${String(version).padStart(32, '0')}`,
        origin: { kind: 'mcp', clientId: 'legacy-test' },
        args: { kind: 'box', parentId: null, name: 'b' },
      }) as MutationResult;
      expect(c.ok).toBe(false);
      if (!c.ok) {
        expect(c.error.code).toBe('project_unavailable');
        expect((c.error as unknown as { reason?: string }).reason).toBe('storage_version_unsupported');
      }

      // A second scan still reports it the same way.
      expect(svc.scan().entries.find((x) => x.projectId === projectId)).toMatchObject({ loadable: false, code: 'storage_version_unsupported' });
      svc.dispose();

      // A fresh service (a restart) refuses it again.
      const svc2 = openWorkspaceService({ root, ...SELF });
      const q2 = svc2.query({ op: 'queryProject', projectId }) as unknown as Unavailable;
      expect(q2.ok).toBe(false);
      expect(q2.error.reason).toBe('storage_version_unsupported');
      svc2.dispose();

      // The project files are byte-identical: no upgrade, no v4 file, no
      // v3 safety copy. The only write is the backend's own process state
      // under .thirdlight/ — the ownership record every open claims (a
      // blocked project included) — and no recovery snapshot.
      const after = tree(dir);
      const authoring = (t: Map<string, string>) => new Map([...t].filter(([k]) => !k.startsWith('.thirdlight/')));
      expect(authoring(after)).toEqual(before);
      const state = [...after.keys()].filter((k) => k.startsWith('.thirdlight/') && !k.endsWith('/'));
      // The ownership record and its epoch claim file only.
      expect(state).toEqual(['.thirdlight/claim-0', '.thirdlight/ownership.json']);
    });
  });
}
