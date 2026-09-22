/**
 * Packet 46 — committed storage fixtures executed end to end.
 *
 * Runs the committed fixture checker (positive + corruption control) as a real
 * process, then drives the real workspace service over the committed on-disk
 * states: the v3 project loads and writes, and `migrateProjectCopyV3` on the
 * committed v2 source produces the contracts `expected-v3-destination` bytes
 * while the source tree stays byte-identical.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceService } from '@thirdlight/workspace';

import { REPO_ROOT, fileBytes, makeRoot, seedProject, sha256Hex } from '../../../packages/workspace/tests/helpers';

const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const CONTRACTS = join(REPO_ROOT, 'fixtures', 'm3', 'contracts');
const COURIER = 'ec535bb2ebcdecb508d7ea0372fe1562d547a9dd0fd5498d1d55c3e61ba44ecc';
const CREATED_AT = '2026-09-19T10:00:00Z';

function hashTree(dir: string): string {
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  return walk(dir)
    .map((p) => `${p.slice(dir.length + 1)}:${sha256Hex(fileBytes(p))}`)
    .join('\n');
}

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

  it('migrates the committed v2 source to the contracts destination, source byte-identical', () => {
    const root = makeRoot('m3int-mig');
    const sourceDir = seedProject(root, join(STORAGE, 'project-v2-demo-0002'), 'demo-0002');
    mkdirSync(join(sourceDir, 'sources', 'sha256'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'sources', 'sha256', COURIER),
      fileBytes(join(CONTRACTS, 'source-preimages', 'courier.glb')),
    );
    const before = hashTree(sourceDir);
    const svc = openWorkspaceService({ root, utcNow: () => CREATED_AT });
    const res = svc.migrateProjectCopyV3('demo-0002', 'demo-0003');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.blobsCopied).toBe(1);
    expect(res.sourceVersion).toBe(2);
    expect(res.newVersion).toBe(3);
    const destDir = join(root, 'projects', 'demo-0003');
    expect(
      Buffer.compare(
        readFileSync(join(destDir, 'scenes', 'main.json')),
        readFileSync(join(CONTRACTS, 'migration', 'expected-v3-destination', 'envelope.json')),
      ),
    ).toBe(0);
    expect(hashTree(sourceDir)).toBe(before);
    // A refused second migration also leaves the source byte-identical.
    const again = svc.migrateProjectCopyV3('demo-0002', 'demo-0003');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('migration_destination_exists');
    expect(hashTree(sourceDir)).toBe(before);
    svc.dispose();
  });
});
