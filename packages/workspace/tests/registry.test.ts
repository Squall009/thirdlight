/**
 * Projects in their own folders (the registry): create in a folder outside
 * the data root, reopen from a fresh service, edit, register an existing
 * folder, refuse duplicates/overlaps, survive a missing folder, unregister
 * without touching files, resolve a path to its project, refuse a symlink
 * swap.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

import { makeRoot } from './helpers';

const PIN = { version: '0.1.0', commit: 'a'.repeat(40), lockfileDigest: 'b'.repeat(64) };
let reqN = 0;
const rid = (): string => `req-${(++reqN).toString(16).padStart(32, '0')}`;

function createBox(svc: WorkspaceService, projectId: string): { ok: boolean; revision?: number } {
  const q = svc.query({ op: 'queryProject', projectId }) as { revision: number };
  return svc.runCommand({
    op: 'createEntity',
    projectId,
    expectedRevision: q.revision,
    requestId: rid(),
    origin: { kind: 'mcp', clientId: 'registry-test' },
    args: { kind: 'box', parentId: null, name: 'crate' },
  }) as { ok: boolean; revision?: number };
}

describe('projects in their own folders', () => {
  it('creates a project in a folder: marker, thirdlight/ subfolder, .gitignore, registry', () => {
    const base = makeRoot('reg-create');
    const root = join(base, 'data');
    const game = join(base, 'games', 'sprout');
    mkdirSync(join(base, 'games'), { recursive: true });
    const svc = openWorkspaceService({ root });
    const res = svc.createProjectInFolder(game, 'sprout', 'Sprout', { engine: PIN });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, created: true, revision: 0 });

    const marker = JSON.parse(readFileSync(join(game, 'thirdlight.json'), 'utf8'));
    expect(marker).toEqual({ thirdlightProject: 1, projectId: 'sprout', name: 'Sprout', projectDir: 'thirdlight', engine: PIN });
    expect(existsSync(join(game, 'thirdlight', 'project.json'))).toBe(true);
    expect(existsSync(join(game, 'thirdlight', 'content.json'))).toBe(true);
    expect(existsSync(join(game, 'thirdlight', 'scenes', 'scene-main.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(game, 'thirdlight', 'project.json'), 'utf8')).schemaVersion).toBe(2);
    expect(readFileSync(join(game, 'thirdlight', '.gitignore'), 'utf8')).toContain('.thirdlight/');
    expect(existsSync(join(root, 'projects', 'sprout'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))).toEqual({ registryVersion: 1, projects: { sprout: { folder: game } } });

    // Edits land in the folder; a fresh service (backend restart) finds the project.
    expect(createBox(svc, 'sprout').ok).toBe(true);
    svc.close();
    const svc2 = openWorkspaceService({ root });
    const q = svc2.query({ op: 'queryProject', projectId: 'sprout' }) as { ok: boolean; revision: number };
    expect(q).toMatchObject({ ok: true, revision: 1 });
    expect(svc2.lastScan.entries.find((e) => e.projectId === 'sprout')).toMatchObject({ kind: 'project', loadable: true, folder: game });
    svc2.close();
  });

  it('registers an existing folder; refuses duplicates, overlaps, non-projects and relative paths', () => {
    const base = makeRoot('reg-register');
    const first = openWorkspaceService({ root: join(base, 'data-a') });
    const game = join(base, 'game');
    expect(first.createProjectInFolder(game, 'meadow', 'Meadow').ok).toBe(true);
    first.close();

    const svc = openWorkspaceService({ root: join(base, 'data-b') });
    expect(svc.registerProject(game)).toMatchObject({ ok: true, projectId: 'meadow', created: true });
    expect(svc.registerProject(game)).toMatchObject({ ok: true, projectId: 'meadow', created: false }); // idempotent
    expect(svc.query({ op: 'queryProject', projectId: 'meadow' })).toMatchObject({ ok: true });

    // A folder inside the registered one, a relative path, a folder with no marker, the data root itself.
    const nested = join(game, 'levels');
    mkdirSync(nested);
    expect(svc.createProjectInFolder(nested, 'inner', 'Inner')).toMatchObject({ ok: false });
    expect(svc.registerProject('relative/path')).toMatchObject({ ok: false });
    mkdirSync(join(base, 'empty'));
    expect(svc.registerProject(join(base, 'empty'))).toMatchObject({ ok: false });
    expect(svc.createProjectInFolder(join(base, 'data-b', 'x'), 'x', 'X')).toMatchObject({ ok: false });
    // The same id elsewhere is refused.
    expect(svc.createProject('taken', 'In tree').ok).toBe(true);
    expect(svc.createProjectInFolder(join(base, 'other'), 'taken', 'Dup')).toMatchObject({ ok: false });
    expect(existsSync(join(base, 'other', 'thirdlight.json'))).toBe(false);
    svc.close();
  });

  it('a missing folder is reported unavailable (no crash); unregister forgets it and keeps files', () => {
    const base = makeRoot('reg-missing');
    const root = join(base, 'data');
    const game = join(base, 'game');
    const svc = openWorkspaceService({ root });
    expect(svc.createProjectInFolder(game, 'gone', 'Gone').ok).toBe(true);
    expect(svc.createProjectInFolder(join(base, 'kept'), 'kept', 'Kept').ok).toBe(true);
    svc.close();
    renameSync(game, join(base, 'moved-away'));

    const svc2 = openWorkspaceService({ root });
    const entry = svc2.lastScan.entries.find((e) => e.projectId === 'gone');
    expect(entry).toMatchObject({ kind: 'project', loadable: false, code: 'folder_unavailable' });
    expect(svc2.query({ op: 'queryProject', projectId: 'gone' })).toMatchObject({ ok: false });
    expect(svc2.query({ op: 'queryProject', projectId: 'kept' })).toMatchObject({ ok: true });

    expect(svc2.unregisterProject('kept')).toMatchObject({ ok: true });
    expect(existsSync(join(base, 'kept', 'thirdlight', 'project.json'))).toBe(true);
    expect(svc2.query({ op: 'queryProject', projectId: 'kept' })).toMatchObject({ ok: false });
    expect(svc2.unregisterProject('not-registered')).toMatchObject({ ok: false });

    // The folder comes back while the backend runs: listed and usable again; gone again: unavailable.
    renameSync(join(base, 'moved-away'), game);
    expect(svc2.scan().entries.find((e) => e.projectId === 'gone')).toMatchObject({ kind: 'project', loadable: true });
    expect(svc2.query({ op: 'queryProject', projectId: 'gone' })).toMatchObject({ ok: true });
    renameSync(game, join(base, 'moved-away'));
    expect(svc2.scan().entries.find((e) => e.projectId === 'gone')).toMatchObject({ kind: 'project', loadable: false, code: 'folder_unavailable' });
    svc2.close();
  });

  it('resolves any path inside a project folder to its id; unregistered markers say so', () => {
    const base = makeRoot('reg-resolve');
    const svc = openWorkspaceService({ root: join(base, 'data') });
    const game = join(base, 'game');
    expect(svc.createProjectInFolder(game, 'sprout', 'Sprout').ok).toBe(true);
    const deep = join(game, 'art', 'scripts');
    mkdirSync(deep, { recursive: true });
    expect(svc.resolveFolder(deep)).toEqual({ ok: true, projectId: 'sprout', folder: game });
    expect(svc.resolveFolder(game)).toMatchObject({ ok: true, projectId: 'sprout' });
    expect(svc.resolveFolder(base)).toMatchObject({ ok: false, reason: 'no_marker' });
    const loose = join(base, 'loose');
    mkdirSync(loose);
    writeFileSync(join(loose, 'thirdlight.json'), JSON.stringify({ thirdlightProject: 1, projectId: 'loose', name: 'Loose', projectDir: 'thirdlight' }));
    expect(svc.resolveFolder(loose)).toMatchObject({ ok: false, reason: 'not_registered', markerProjectId: 'loose' });
    svc.close();
  });

  it('a registered project folder swapped for a symlink elsewhere is not opened', () => {
    const base = makeRoot('reg-swap');
    const root = join(base, 'data');
    const game = join(base, 'game');
    const svc = openWorkspaceService({ root });
    expect(svc.createProjectInFolder(game, 'swap', 'Swap').ok).toBe(true);
    svc.close();
    // The next backend loads the registry (recording the real folder), then the folder is swapped.
    const svc2 = openWorkspaceService({ root });
    renameSync(join(game, 'thirdlight'), join(base, 'elsewhere'));
    symlinkSync(join(base, 'elsewhere'), join(game, 'thirdlight'));
    expect(svc2.query({ op: 'queryProject', projectId: 'swap' })).toMatchObject({ ok: false });
    // A later scan (the picker's list) reports it instead of adopting the new place.
    expect(svc2.scan().entries.find((e) => e.projectId === 'swap')).toMatchObject({ loadable: false, code: 'folder_unavailable' });
    expect(svc2.query({ op: 'queryProject', projectId: 'swap' })).toMatchObject({ ok: false });
    svc2.close();
  });
});
