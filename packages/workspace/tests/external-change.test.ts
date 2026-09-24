/**
 * The external-change protocol (workspace.md §7) — detection at the
 * pre-write check / verification read, snapshot BEFORE pause, the pending
 * change, and the operator resolutions (accept / discard).
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type MutationResult, type QueryResult } from '@thirdlight/workspace';

import { FIXTURES, SCENE_FILE, makeRoot, seedProject, sha256Hex } from './helpers';

/** demo-0001 at T7 (revision 7, storage v4), owned by the service under test. */
function seedT7(root: string): string {
  const base = '08-external-modification';
  const dir = seedProject(root, join(FIXTURES, 'scenarios', base, 'disk-before'), 'demo-0001');
  // Re-pin the ownership record to this service's identity (the fixture's
  // nominal owner) so the service is the current owner; then load T7 as
  // the last known good.
  return dir;
}

function svcOn(root: string) {
  return openWorkspaceService({
    root,
    backendId: 'tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pid: 5000,
    stamp: () => '20260917T101500Z',
  });
}

const MUTATION = {
  op: 'setTransform',
  projectId: 'demo-0001',
  expectedRevision: 7,
  requestId: 'req-60000000000000000000000000000001',
  origin: { kind: 'mcp', clientId: 'pi-harness' },
  args: { entityId: 'box-0004', transform: { position: [0, 1, 0] } },
};

describe('external change (workspace.md §7)', () => {
  it('invalid external bytes pause with externalValid:false; accept fails, discard restores LKG', () => {
    const root = makeRoot('ext-invalid');
    const dir = seedT7(root);
    const envPath = join(dir, SCENE_FILE);
    const lkg = readFileSync(envPath);
    const svc = svcOn(root);
    svc.query({ op: 'queryProject', projectId: 'demo-0001' }); // load LKG

    // A bypassing writer clobbers the file with garbage.
    const garbage = Buffer.from('this is not json at all');
    writeFileSync(envPath, garbage);
    const res = svc.runCommand(MUTATION) as MutationResult;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('must fail');
    expect(res.error.code).toBe('external_change_unresolved');
    expect(res.error.pendingChange.externalValid).toBe(false);
    expect(res.error.pendingChange.externalErrorCount).toBeGreaterThan(0);
    expect(res.error.pendingChange.externalHash).toBe(sha256Hex(garbage));

    // Accepting an INVALID external document is rejected (it would break
    // the invariants); the pending change stays.
    const accept = svc.acceptExternalState('demo-0001');
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.error.code).toBe('external_change_invalid');

    // Discard restores the last known good bytes atomically.
    const discard = svc.discardExternalState('demo-0001');
    expect(discard.ok).toBe(true);
    if (!discard.ok) throw new Error('discard failed');
    expect(discard.revision).toBe(7);
    expect(readFileSync(envPath).equals(lkg)).toBe(true);

    // Writes resume; the original mutation now succeeds.
    const ok = svc.runCommand(MUTATION) as MutationResult;
    expect(ok.ok).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('a foreign deletion snapshots empty content; discard restores LKG (file re-created)', () => {
    const root = makeRoot('ext-delete');
    const dir = seedT7(root);
    const envPath = join(dir, SCENE_FILE);
    const lkg = readFileSync(envPath);
    const svc = svcOn(root);
    svc.query({ op: 'queryProject', projectId: 'demo-0001' });
    rmSync(envPath); // foreign deletion

    const res = svc.runCommand(MUTATION) as MutationResult;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('must fail');
    expect(res.error.code).toBe('external_change_unresolved');
    // The snapshot of a deletion is the empty content.
    expect(res.error.pendingChange.externalHash).toBe(sha256Hex(new Uint8Array(0)));

    const discard = svc.discardExternalState('demo-0001');
    expect(discard.ok).toBe(true);
    expect(readFileSync(envPath).equals(lkg)).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('a second external change while pending re-fires the protocol (new snapshot, new hash)', () => {
    const root = makeRoot('ext-again');
    const dir = seedT7(root);
    const envPath = join(dir, SCENE_FILE);
    const lkg = readFileSync(envPath);
    const svc = svcOn(root);
    svc.query({ op: 'queryProject', projectId: 'demo-0001' });

    const ext1 = Buffer.concat([Buffer.from(lkg).subarray(0, lkg.length - 2), Buffer.from('X\n')]);
    writeFileSync(envPath, ext1);
    const r1 = svc.runCommand(MUTATION) as MutationResult;
    if (r1.ok || r1.error.code !== 'external_change_unresolved') throw new Error('first detection failed');
    const h1 = r1.error.pendingChange.externalHash;

    // A different foreign write while paused. Writes are paused, so a
    // plain mutation fails immediately against the CURRENT pending
    // (detection happens at the next envelope write — the resolution).
    const ext2 = Buffer.concat([Buffer.from(lkg).subarray(0, lkg.length - 2), Buffer.from('Y\n')]);
    writeFileSync(envPath, ext2);
    const r2 = svc.runCommand({ ...MUTATION, requestId: 'req-60000000000000000000000000000002' }) as MutationResult;
    if (r2.ok || r2.error.code !== 'external_change_unresolved') throw new Error('paused mutation must fail');
    expect(r2.error.pendingChange.externalHash).toBe(h1); // still the first pending

    // The resolution write re-checks the disk: ext2 ≠ {LKG, ext1} ⇒ the
    // protocol re-fires (new snapshot of ext2, new pending hash).
    const d1 = svc.discardExternalState('demo-0001');
    if (d1.ok || d1.error.code !== 'external_change_unresolved') throw new Error('re-fire failed');
    const h2 = d1.error.pendingChange.externalHash;
    expect(h2).toBe(sha256Hex(ext2));
    expect(h2).not.toBe(h1);
    const recDir = join(dir, '.thirdlight', 'recovery');
    const snaps = readdirSync(recDir).filter((n) => n.startsWith('scene-'));
    expect(snaps.length).toBe(2); // oldest-16 pruning keeps both
    const matching2 = snaps.filter((n) => readFileSync(join(recDir, n)).equals(ext2));
    const matching1 = snaps.filter((n) => readFileSync(join(recDir, n)).equals(ext1));
    expect(matching2.length).toBe(1); // the new snapshot is ext2's bytes
    expect(matching1.length).toBe(1); // the first snapshot is retained as evidence

    // Discarding again now matches the disk (pending externalHash) and
    // restores LKG.
    const d2 = svc.discardExternalState('demo-0001');
    expect(d2.ok).toBe(true);
    expect(readFileSync(envPath).equals(lkg)).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('queries are served from the last known good while paused (§5.6)', () => {
    const root = makeRoot('ext-query');
    const dir = seedT7(root);
    const envPath = join(dir, SCENE_FILE);
    const lkg = readFileSync(envPath);
    const svc = svcOn(root);
    const before = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as QueryResult;
    expect(before.ok).toBe(true);

    const ext = Buffer.concat([Buffer.from(lkg).subarray(0, lkg.length - 2), Buffer.from('Z\n')]);
    writeFileSync(envPath, ext);
    const fail = svc.runCommand(MUTATION) as MutationResult;
    expect(fail.ok).toBe(false);

    const paused = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as QueryResult;
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error('paused query must be served');
    // Same LKG projection as before the edit (never the foreign bytes).
    const { scene: aScene, ...aRest } = paused as Record<string, unknown> & { scene: unknown };
    const { scene: bScene, ...bRest } = before as Record<string, unknown> & { scene: unknown };
    expect(JSON.stringify(aScene)).toBe(JSON.stringify(bScene));
    void aRest;
    void bRest;
    expect((paused as { workspace?: { writePaused: boolean } }).workspace?.writePaused).toBe(true);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps at most 16 recovery snapshots (oldest pruned)', () => {
    const root = makeRoot('ext-prune');
    const dir = seedT7(root);
    const envPath = join(dir, SCENE_FILE);
    const lkg = readFileSync(envPath);
    const svc = svcOn(root);
    svc.query({ op: 'queryProject', projectId: 'demo-0001' });
    const recDir = join(dir, '.thirdlight', 'recovery');
    for (let i = 0; i < 18; i++) {
      const ext = Buffer.concat([Buffer.from(lkg), Buffer.from(`\n// ext ${i}\n`)]);
      writeFileSync(envPath, ext);
      const r = svc.runCommand({
        ...MUTATION,
        requestId: `req-${String(9000 + i).padStart(32, '0')}`,
      }) as MutationResult;
      if (r.ok || r.error.code !== 'external_change_unresolved') throw new Error(`detection ${i} failed`);
      // Resolve (discard) so the next foreign write is a new detection.
      const d = svc.discardExternalState('demo-0001');
      if (!d.ok) throw new Error(`discard ${i} failed: ${JSON.stringify(d).slice(0, 200)}`);
    }
    const snaps = readdirSync(recDir).filter((n) => n.startsWith('scene-') && n.endsWith('.json')).sort();
    expect(snaps.length).toBe(16);
    svc.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});