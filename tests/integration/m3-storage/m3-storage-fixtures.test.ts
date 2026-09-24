/**
 * Packet 46 — committed storage fixtures executed end to end.
 *
 * Runs the committed fixture checker (positive + corruption control) as a real
 * process, then drives the real workspace service over the committed v3
 * project: it opens (upgraded in place to storage v4), writes and replays a
 * lost ack.
 *
 * The `migrateProjectCopyV3` case (v2 source → contracts destination) was
 * removed with the operator (phase 9.3 step B); the original suite is archived
 * at archive/removed-v1-v2/tests/integration/m3-storage/.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceService } from '@thirdlight/workspace';

import { REPO_ROOT, makeRoot, seedProject } from '../../../packages/workspace/tests/helpers';

const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const CREATED_AT = '2026-09-19T10:00:00Z';

describe('packet 46 — committed storage fixtures', () => {
  it('the fixture checker passes and its corruption control detects every corruption', () => {
    const checker = join(STORAGE, 'tools', 'check-fixtures.mjs');
    const ok = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain('all checks passed');
    const control = spawnSync(process.execPath, [checker, '--corrupt-control'], { encoding: 'utf8' });
    expect(control.status, control.stdout + control.stderr).toBe(0);
    expect(control.stdout).toContain('6/6 detected');
  });

  it('loads the committed v3 project, writes a v3 edit and replays the lost ack', () => {
    const root = makeRoot('m3int-v3');
    seedProject(root, join(STORAGE, 'project-v3-demo-0003'), 'demo-0003');
    const svc = openWorkspaceService({ root, utcNow: () => CREATED_AT });
    const q = svc.query({ op: 'queryProject', projectId: 'demo-0003' }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    // The open upgraded the v3 project in place to storage v4.
    const content = JSON.parse(readFileSync(join(root, 'projects', 'demo-0003', 'content.json'), 'utf8')) as { storageVersion: number };
    expect(content.storageVersion).toBe(4);
    const r = svc.runCommand({
      op: 'setGameConfig',
      projectId: 'demo-0003',
      expectedRevision: q.revision,
      requestId: 'req-' + '7'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { game: { title: 'Integrated' } },
    }) as { ok: boolean; revision?: number; duplicated?: boolean };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const replay = svc.runCommand({
      op: 'setGameConfig',
      projectId: 'demo-0003',
      expectedRevision: q.revision,
      requestId: 'req-' + '7'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { game: { title: 'Integrated' } },
    }) as { ok: boolean; duplicated?: boolean };
    expect(replay.ok).toBe(true);
    expect(replay.duplicated).toBe(true);
    svc.dispose();
  });
});
