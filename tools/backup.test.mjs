/**
 * tools/backup.mjs: create / verify / restore over real directories, the
 * live-project refusal, tamper detection, and the never-overwrite rule.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBackup, listBackups, ownershipState, restoreBackup, verifyBackup } from './backup.mjs';

const TOOL = new URL('./backup.mjs', import.meta.url).pathname;

function fakeProject(dataRoot, id, { owned } = {}) {
  const dir = join(dataRoot, 'projects', id);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
  mkdirSync(join(dir, '.thirdlight', 'derived'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ schemaVersion: 1, engineVersion: '0.1.0', id, name: 'Fake', createdAt: '2026-09-22T00:00:00Z', scenes: [{ sceneId: 'main', path: 'scenes/main.json' }] }, null, 2) + '\n');
  writeFileSync(join(dir, 'scenes', 'main.json'), JSON.stringify({ storageVersion: 3, type: 'thirdlight-envelope', projectId: id, scene: { revision: 7, entities: [] }, retry: { retention: 128, records: [{ requestId: 'r1' }] } }, null, 2) + '\n');
  writeFileSync(join(dir, 'sources', 'sha256', 'abc'), 'blob-bytes');
  writeFileSync(join(dir, '.thirdlight', 'derived', 'cache.bin'), 'derived');
  if (owned !== undefined) {
    writeFileSync(join(dir, '.thirdlight', 'ownership.json'), JSON.stringify({ storageVersion: 1, state: owned.state, backendId: 'tb-x', pid: owned.pid, openedAt: '2026-09-22T00:00:00Z', lockEpoch: 0 }));
  }
  return dir;
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tl-backup-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('backup create / verify / restore', () => {
  it('copies the authoritative files (not .thirdlight), writes the manifest last, verifies, restores byte-identically', () => {
    fakeProject(root, 'game');
    const out = join(root, 'backups');
    mkdirSync(out);
    const r = createBackup({ dataRoot: root, projectId: 'game', outRoot: out, now: new Date('2026-09-22T12:34:56Z') });
    expect(r.dir).toBe(join(out, 'game-20260922T123456Z'));
    expect(r.manifest.revision).toBe(7);
    expect(r.manifest.files.map((f) => f.path)).toEqual(['project.json', 'scenes/main.json', 'sources/sha256/abc']);
    expect(existsSync(join(r.dir, '.thirdlight'))).toBe(false);
    expect(verifyBackup(r.dir)).toMatchObject({ ok: true, problems: [] });
    expect(listBackups(out)).toMatchObject([{ complete: true, projectId: 'game', revision: 7, files: 3 }]);

    const other = mkdtempSync(join(tmpdir(), 'tl-backup-dest-'));
    try {
      const restored = restoreBackup({ backupDir: r.dir, dataRoot: other });
      expect(restored.projectId).toBe('game');
      for (const rel of ['project.json', 'scenes/main.json', 'sources/sha256/abc']) {
        expect(readFileSync(join(other, 'projects', 'game', rel))).toEqual(readFileSync(join(root, 'projects', 'game', rel)));
      }
      expect(existsSync(join(other, 'projects', 'game', '.thirdlight'))).toBe(false);
      // Never overwrites.
      expect(() => restoreBackup({ backupDir: r.dir, dataRoot: other })).toThrow(/already exists/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('--as restores under a new id: identity rewritten, retry records dropped, revision kept', () => {
    fakeProject(root, 'game');
    const out = join(root, 'backups');
    mkdirSync(out);
    const r = createBackup({ dataRoot: root, projectId: 'game', outRoot: out });
    const restored = restoreBackup({ backupDir: r.dir, dataRoot: root, as: 'game-copy' });
    expect(restored).toMatchObject({ projectId: 'game-copy', revision: 7 });
    const manifest = JSON.parse(readFileSync(join(root, 'projects', 'game-copy', 'project.json'), 'utf8'));
    expect(manifest.id).toBe('game-copy');
    const env = JSON.parse(readFileSync(join(root, 'projects', 'game-copy', 'scenes', 'main.json'), 'utf8'));
    expect(env.projectId).toBe('game-copy');
    expect(env.scene.revision).toBe(7);
    expect(env.retry.records).toEqual([]);
    expect(readFileSync(join(root, 'projects', 'game-copy', 'sources', 'sha256', 'abc'), 'utf8')).toBe('blob-bytes');
  });

  it('a tampered, truncated or incomplete backup fails verification and is not restored', () => {
    fakeProject(root, 'game');
    const out = join(root, 'backups');
    mkdirSync(out);
    const r = createBackup({ dataRoot: root, projectId: 'game', outRoot: out });
    writeFileSync(join(r.dir, 'sources', 'sha256', 'abc'), 'changed');
    expect(verifyBackup(r.dir).problems).toEqual(['modified: sources/sha256/abc']);
    rmSync(join(r.dir, 'sources', 'sha256', 'abc'));
    writeFileSync(join(r.dir, 'extra.txt'), 'x');
    expect(verifyBackup(r.dir).problems).toEqual(['missing: sources/sha256/abc', 'not in the inventory: extra.txt']);
    expect(() => restoreBackup({ backupDir: r.dir, dataRoot: root, as: 'x' })).toThrow(/refusing to restore/);
    rmSync(join(r.dir, 'backup-manifest.json'));
    expect(verifyBackup(r.dir).ok).toBe(false);
    expect(listBackups(out)).toMatchObject([{ complete: false }]);
  });

  it('refuses a project a running backend owns; a released or dead-owner project is fine', () => {
    fakeProject(root, 'live', { owned: { state: 'owned', pid: process.pid } });
    fakeProject(root, 'released', { owned: { state: 'released', pid: process.pid } });
    fakeProject(root, 'dead', { owned: { state: 'owned', pid: 2147483000 } });
    const out = join(root, 'backups');
    mkdirSync(out);
    expect(ownershipState(join(root, 'projects', 'live')).live).toBe(true);
    expect(() => createBackup({ dataRoot: root, projectId: 'live', outRoot: out })).toThrow(/in use/);
    expect(createBackup({ dataRoot: root, projectId: 'released', outRoot: out }).manifest.projectId).toBe('released');
    expect(createBackup({ dataRoot: root, projectId: 'dead', outRoot: out }).manifest.projectId).toBe('dead');
  });

  it('a folder project backs up the whole game folder (assets, art, .git) except process state, and restores into a new folder', () => {
    // A registered folder project: <game>/thirdlight.json + <game>/thirdlight/ + the game's own files.
    const game = join(root, 'game');
    const marker = { thirdlightProject: 1, projectId: 'sprout', name: 'Sprout', projectDir: 'thirdlight', engine: { version: '0.1.0' } };
    mkdirSync(join(game, 'assets', 'props'), { recursive: true });
    mkdirSync(join(game, '.git', 'lfs'), { recursive: true });
    writeFileSync(join(game, 'thirdlight.json'), JSON.stringify(marker));
    writeFileSync(join(game, 'assets', 'props', 'crate.glb'), 'glTF crate bytes');
    writeFileSync(join(game, '.git', 'lfs', 'object'), 'lfs object');
    writeFileSync(join(game, 'README.md'), 'the game');
    const inTree = fakeProject(root, 'sprout');
    renameSync(inTree, join(game, 'thirdlight'));
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ registryVersion: 1, projects: { sprout: { folder: game } } }));
    const out = join(root, 'backups');
    mkdirSync(out);
    const r = createBackup({ dataRoot: root, projectId: 'sprout', outRoot: out });
    expect(r.manifest).toMatchObject({ backupVersion: 2, scope: 'game-folder', folder: game, projectDir: 'thirdlight', revision: 7 });
    expect(r.manifest.files.map((f) => f.path)).toEqual([
      '.git/lfs/object',
      'README.md',
      'assets/props/crate.glb',
      'thirdlight/project.json',
      'thirdlight/scenes/main.json',
      'thirdlight/sources/sha256/abc',
      'thirdlight.json',
    ]);
    expect(existsSync(join(r.dir, 'thirdlight', '.thirdlight'))).toBe(false);
    expect(verifyBackup(r.dir)).toMatchObject({ ok: true, problems: [] });

    // A whole-folder backup restores only into a folder, never over files.
    expect(() => restoreBackup({ backupDir: r.dir, dataRoot: root })).toThrow(/--folder/);
    expect(() => restoreBackup({ backupDir: r.dir, dataRoot: root, folder: game })).toThrow(/not empty/);

    const target = join(root, 'restored-game');
    const restored = restoreBackup({ backupDir: r.dir, dataRoot: root, as: 'sprout-2', folder: target });
    expect(restored).toMatchObject({ projectId: 'sprout-2', folder: target, dir: join(target, 'thirdlight') });
    expect(readFileSync(join(target, 'assets', 'props', 'crate.glb'), 'utf8')).toBe('glTF crate bytes');
    expect(readFileSync(join(target, '.git', 'lfs', 'object'), 'utf8')).toBe('lfs object');
    expect(JSON.parse(readFileSync(join(target, 'thirdlight.json'), 'utf8'))).toMatchObject({ thirdlightProject: 1, projectId: 'sprout-2', name: 'Sprout', projectDir: 'thirdlight' });
    expect(JSON.parse(readFileSync(join(target, 'thirdlight', 'project.json'), 'utf8')).id).toBe('sprout-2');
    const env = JSON.parse(readFileSync(join(target, 'thirdlight', 'scenes', 'main.json'), 'utf8'));
    expect(env).toMatchObject({ projectId: 'sprout-2', retry: { records: [] } });
    expect(existsSync(join(target, 'thirdlight', '.thirdlight'))).toBe(false);
    // Never overwrites a folder that already holds something.
    expect(() => restoreBackup({ backupDir: r.dir, dataRoot: root, as: 'sprout-3', folder: target })).toThrow(/not empty/);
    // An empty target folder is fine; the same id is kept without --as.
    const empty = join(root, 'empty-target');
    mkdirSync(empty);
    const same = restoreBackup({ backupDir: r.dir, dataRoot: root, folder: empty });
    expect(same.projectId).toBe('sprout');
    expect(readFileSync(join(empty, 'thirdlight.json'))).toEqual(readFileSync(join(game, 'thirdlight.json')));

    // The backup may not be written inside the game folder it copies.
    expect(() => createBackup({ dataRoot: root, projectId: 'sprout', outRoot: join(game, 'backups') })).toThrow(/inside the game folder/);
  });

  it('an older folder backup (version 1: project subfolder + marker in the manifest) still restores into a folder', () => {
    const src = fakeProject(root, 'old');
    const out = join(root, 'backups');
    mkdirSync(out);
    const r = createBackup({ dataRoot: root, projectId: 'old', outRoot: out });
    // Turn it into the pre-2026-09-23 folder-project shape.
    const m = JSON.parse(readFileSync(join(r.dir, 'backup-manifest.json'), 'utf8'));
    m.folder = '/somewhere/old';
    m.marker = { thirdlightProject: 1, projectId: 'old', name: 'Old', projectDir: 'thirdlight' };
    writeFileSync(join(r.dir, 'backup-manifest.json'), JSON.stringify(m, null, 2));
    expect(verifyBackup(r.dir).ok).toBe(true);
    const target = join(root, 'old-restored');
    restoreBackup({ backupDir: r.dir, dataRoot: root, folder: target });
    expect(readFileSync(join(target, 'thirdlight', 'project.json'))).toEqual(readFileSync(join(src, 'project.json')));
    expect(JSON.parse(readFileSync(join(target, 'thirdlight.json'), 'utf8'))).toMatchObject({ projectId: 'old', projectDir: 'thirdlight' });
  });

  it('the CLI: create, verify, list, restore --as; usage errors exit 2', () => {
    fakeProject(root, 'game');
    const run = (...args) => spawnSync(process.execPath, [TOOL, ...args, '--data-root', root], { encoding: 'utf8' });
    const c = run('create', 'game');
    expect(c.status, c.stderr).toBe(0);
    const dir = /backup: (\S+) /.exec(c.stdout)[1];
    expect(run('verify', dir).status).toBe(0);
    expect(run('list').stdout).toContain('game  revision 7  3 files');
    const rs = run('restore', dir, '--as', 'again');
    expect(rs.status, rs.stderr).toBe(0);
    expect(existsSync(join(root, 'projects', 'again', 'project.json'))).toBe(true);
    expect(run('restore', dir).status).toBe(1); // "game" exists
    expect(run('create').status).toBe(2);
    expect(run('bogus').status).toBe(2);
  });
});
