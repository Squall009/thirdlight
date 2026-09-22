/**
 * Project creation (§8) and the startup scan (§10): deterministic
 * completion of interrupted creations, orphan/corrupt reporting (no
 * destructive action), stale-ownership reporting, leftover-temp reporting,
 * the 100-entry bound, and idempotent createProject.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService } from '@thirdlight/workspace';

import { FIXTURES, buildFakeProc, makeRoot, seedProject } from './helpers';

function manifestFor(id: string, name: string): string {
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        engineVersion: '0.1.0',
        id,
        name,
        createdAt: '2026-09-16T23:40:00Z',
        scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
      },
      null,
      2,
    ) + '\n'
  );
}

describe('createProject (§8)', () => {
  it('creates the layout, manifest, initial envelope and the ownership claim', () => {
    const root = makeRoot('create-1');
    const svc = openWorkspaceService({ root, utcNow: () => '2026-09-17T11:00:00Z' });
    const res = svc.createProject('proj-new', 'New Project');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('create failed');
    expect(res.created).toBe(true);
    expect(res.revision).toBe(0);

    const dir = join(root, 'projects', 'proj-new');
    for (const sub of ['', 'scenes', '.thirdlight', '.thirdlight/recovery']) {
      expect(statSync(join(dir, sub)).isDirectory(), `dir ${sub}`).toBe(true);
    }
    // The manifest is canonical (2-space, trailing newline, pinned order).
    const manPath = join(dir, 'project.json');
    const manRaw = readFileSync(manPath, 'utf8');
    const man = JSON.parse(manRaw);
    expect(man).toEqual({
      schemaVersion: 1,
      engineVersion: '0.1.0',
      id: 'proj-new',
      name: 'New Project',
      createdAt: '2026-09-17T11:00:00Z',
      scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
    });
    expect(manRaw).toBe(JSON.stringify(man, null, 2) + '\n');

    // The initial envelope: the default scene at revision 0 at the current
    // storage version (content block present), no records.
    const env = JSON.parse(readFileSync(join(dir, 'scenes', 'main.json'), 'utf8'));
    expect(env.storageVersion).toBe(3);
    expect(env.scene.schemaVersion).toBe(3);
    expect(typeof env.content).toBe('object');
    expect(env.type).toBe('authoring-state');
    expect(env.projectId).toBe('proj-new');
    expect(env.scene.revision).toBe(0);
    expect(env.scene.entities.map((e: { id: string }) => e.id)).toEqual(['cam-main', 'light-0001', 'light-0002']);
    expect(env.retry).toEqual({ retention: 128, records: [] });

    // The ownership claim (epoch 0, our identity).
    const rec = JSON.parse(readFileSync(join(dir, '.thirdlight', 'ownership.json'), 'utf8'));
    expect(rec.state).toBe('owned');
    expect(rec.lockEpoch).toBe(0);
    expect(rec.pid).toBe(process.pid);

    // Idempotent re-create: no-op, same revision.
    const again = svc.createProject('proj-new', 'New Project');
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.created).toBe(false);
      expect(again.revision).toBe(0);
    }
    // The manifest is immutable (byte-identical).
    expect(readFileSync(manPath, 'utf8')).toBe(manRaw);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('field preconditions fail with field_* (nothing written)', () => {
    const root = makeRoot('create-2');
    const svc = openWorkspaceService({ root });
    const badId = svc.createProject('Bad ID', 'x');
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error.code).toMatch(/^field_/);
    const badId2 = svc.createProject('', 'x');
    expect(badId2.ok).toBe(false);
    if (!badId2.ok) expect(badId2.error.code).toBe('field_type');
    const badName = svc.createProject('proj-ok', '');
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.error.code).toBe('field_value');
    const longName = svc.createProject('proj-ok', 'x'.repeat(129));
    expect(longName.ok).toBe(false);
    if (!longName.ok) expect(longName.error.code).toBe('field_value');
    const controlName = svc.createProject('proj-ok', 'bad\u0000name');
    expect(controlName.ok).toBe(false);
    if (!controlName.ok) expect(controlName.error.code).toBe('field_value');
    // Nothing was written.
    expect(statSync(join(root, 'projects')).isDirectory()).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('an existing invalid project directory ⇒ project_exists_invalid (nothing written)', () => {
    const root = makeRoot('create-3');
    const dir = join(root, 'projects', 'proj-bad');
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(join(dir, 'project.json'), 'garbage not json');
    const before = readFileSync(join(dir, 'project.json'));
    const svc = openWorkspaceService({ root });
    const res = svc.createProject('proj-bad', 'Bad');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('project_exists_invalid');
      expect(res.error.details.length).toBeGreaterThanOrEqual(1);
      expect(res.error.details.length).toBeLessThanOrEqual(10);
    }
    expect(readFileSync(join(dir, 'project.json')).equals(before)).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('createProject while a live foreign owner holds the project ⇒ idempotent no-op, nothing written (not a takeover — R15)', () => {
    const root = makeRoot('create-4');
    // Seed the scenario-09 disk (owner A live in the fake /proc).
    const dir = seedProject(root, join(FIXTURES, 'scenarios', '09-second-backend-ownership', 'disk-before'), 'demo-0001');
    const envBefore = readFileSync(join(dir, 'scenes', 'main.json'));
    const procRoot = buildFakeProc(root, { 5000: 'live' });
    const svc = openWorkspaceService({ root, backendId: 'tb-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', pid: 5150, procRoot });
    // R15 (2026-09-18 review): the §8.1 idempotent create is READ-ONLY —
    // a loadable existing project is a no-op regardless of who owns it;
    // no session is opened and no claim is written (pre-fix this
    // returned project_exists_invalid / ownership_conflict).
    const res = svc.createProject('demo-0001', 'Demo Project');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.created).toBe(false);
      expect(res.revision).toBe(7);
    }
    // The foreign record is untouched (no takeover, no re-claim) and the
    // envelope bytes are identical.
    const rec = JSON.parse(readFileSync(join(dir, '.thirdlight', 'ownership.json'), 'utf8'));
    expect(rec.backendId).toBe('tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(rec.pid).toBe(5000);
    expect(rec.state).toBe('owned');
    expect(rec.lockEpoch).toBe(0);
    expect(readFileSync(join(dir, 'scenes', 'main.json')).equals(envBefore)).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('startup scan (§10)', () => {
  it('classifies orphans, corrupt projects, stale ownership and leftover temps (read-only)', () => {
    const root = makeRoot('scan-1');
    const proj = (id: string) => join(root, 'projects', id);
    const procRoot = buildFakeProc(root, { 5000: 'dead' });

    // orphan: no manifest.
    mkdirSync(proj('orphan-1'), { recursive: true });
    writeFileSync(join(proj('orphan-1'), 'junk.txt'), 'x');

    // corrupt manifest.
    mkdirSync(join(proj('corrupt-man'), 'scenes'), { recursive: true });
    writeFileSync(join(proj('corrupt-man'), 'project.json'), '{nope');

    // corrupt envelope (missing type), stale ownership record.
    mkdirSync(join(proj('corrupt-env'), 'scenes'), { recursive: true });
    writeFileSync(join(proj('corrupt-env'), 'project.json'), manifestFor('corrupt-env', 'Corrupt'));
    const envNoType = JSON.parse(readFileSync(join(FIXTURES, 'envelope', 'valid', 'demo-0001-rev0.json'), 'utf8')) as Record<string, unknown>;
    delete envNoType['type'];
    writeFileSync(join(proj('corrupt-env'), 'scenes', 'main.json'), JSON.stringify(envNoType, null, 2) + '\n');
    mkdirSync(join(proj('corrupt-env'), '.thirdlight'), { recursive: true });
    writeFileSync(
      join(proj('corrupt-env'), '.thirdlight', 'ownership.json'),
      JSON.stringify({ storageVersion: 1, state: 'owned', backendId: 'tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pid: 5000, openedAt: '2026-09-17T09:00:00Z', lockEpoch: 0 }, null, 2) + '\n',
    );

    // leftover temp (reported, NOT cleaned).
    mkdirSync(join(proj('temp-1'), 'scenes'), { recursive: true });
    writeFileSync(join(proj('temp-1'), 'project.json'), manifestFor('temp-1', 'Temp'));
    const env0raw = readFileSync(join(FIXTURES, 'envelope', 'valid', 'demo-0001-rev0.json'), 'utf8');
    const env0 = env0raw.replace('"projectId": "demo-0001"', '"projectId": "temp-1"');
    writeFileSync(join(proj('temp-1'), 'scenes', 'main.json'), env0);
    writeFileSync(join(proj('temp-1'), 'scenes', '.main.json.tmp-4242-7'), 'partial');

    const svc = openWorkspaceService({ root, procRoot });
    const report = svc.scan(); // the startup scan already ran: lastScan
    expect(svc.lastScan).toBe(report);
    expect(report.truncated).toBe(false);
    const byId = new Map(report.entries.map((e) => [e.projectId, e]));

    expect(byId.get('orphan-1')?.kind).toBe('orphan');
    expect(byId.get('corrupt-man')?.kind).toBe('project');
    expect(byId.get('corrupt-man')?.loadable).toBe(false);
    expect(byId.get('corrupt-man')?.code).toBe('manifest_invalid');
    expect(byId.get('corrupt-env')?.loadable).toBe(false);
    expect(byId.get('corrupt-env')?.code).toBe('envelope_invalid');
    expect(byId.get('corrupt-env')?.staleOwnership).toBe(true);
    expect(byId.get('corrupt-env')?.leftoverTemps).toBeUndefined();
    expect(byId.get('temp-1')?.loadable).toBe(true);
    expect(byId.get('temp-1')?.leftoverTemps).toBe(1);
    // The scan is read-only: the temp file is still there.
    expect(statSync(join(proj('temp-1'), 'scenes', '.main.json.tmp-4242-7')).isFile()).toBe(true);
    // No ownership claim was made by the scan (no new records written).
    expect(() => readFileSync(join(proj('temp-1'), '.thirdlight', 'ownership.json'))).toThrow();
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('completes an interrupted creation deterministically (the scan only sanctioned write)', () => {
    const root = makeRoot('scan-2');
    const dir = join(root, 'projects', 'proj-half');
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(join(dir, 'project.json'), manifestFor('proj-half', 'Half'));
    // NO scenes/main.json (the crash point of §8.3 step 3).

    const svc = openWorkspaceService({ root });
    const entry = svc.lastScan.entries.find((e) => e.projectId === 'proj-half');
    expect(entry?.kind).toBe('project');
    expect(entry?.completion).toBe('completed');
    expect(entry?.loadable).toBe(true);

    // The completed envelope is the default scene at revision 0.
    const env = JSON.parse(readFileSync(join(dir, 'scenes', 'main.json'), 'utf8'));
    expect(env.scene.revision).toBe(0);
    expect(env.scene.entities.map((e: { id: string }) => e.id)).toEqual(['cam-main', 'light-0001', 'light-0002']);
    expect(env.retry).toEqual({ retention: 128, records: [] });

    // The project opens and works afterwards.
    const q = svc.query({ op: 'queryProject', projectId: 'proj-half' });
    expect((q as { ok: boolean }).ok).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('bounds the report at 100 entries (total + truncated)', () => {
    const root = makeRoot('scan-3');
    for (let i = 0; i < 105; i++) {
      mkdirSync(join(root, 'projects', `p${String(i).padStart(3, '0')}`), { recursive: true });
    }
    const svc = openWorkspaceService({ root });
    const r = svc.lastScan;
    expect(r.total).toBe(105);
    expect(r.entries.length).toBe(100);
    expect(r.truncated).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});