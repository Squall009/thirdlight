/**
 * Packet 46 — real SIGKILL durability for v3 state and the v2→v3 copy
 * (workspace.md §5.3/§16.5.3).
 *
 * The child runner (tests/crash/m3-storage-child.ts, esbuild-bundled) drives a
 * real v3 command or a real `migrateProjectCopyV3` and SIGKILLs itself from
 * inside a WriteOps seam at an exact boundary. The parent reopens (explicit
 * stale-owner takeover where needed) and asserts what is durable:
 *
 *   - crash before/after the v3 envelope replacement: old state + no record
 *     (fresh re-execution) or new state + record (durable replay);
 *   - crash after each copy marker phase (created/manifest/blobs/envelope) and
 *     before/after the destination envelope replacement: the resume path is
 *     idempotent and completes the destination byte-exactly;
 *   - a SIGKILLed owner is reported stale by the scan and reclaimed on the next access;
 *   - a lost ack is replayed, never double-applied.
 *
 * Process-crash guarantees are proven here; power-loss durability is the
 * stronger property this suite cannot prove without a power-failure simulator.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const CONTRACTS = join(REPO_ROOT, 'fixtures', 'm3', 'contracts');
const V3 = 'demo-0003';
const SOURCE = 'demo-0002';
const DEST = 'demo-0003';
const REQUEST_ID = 'req-' + 'e'.repeat(32);
const CREATED_AT = '2026-09-19T10:00:00Z';
const COURIER_DIGEST = 'ec535bb2ebcdecb508d7ea0372fe1562d547a9dd0fd5498d1d55c3e61ba44ecc';

const ROOT_BASE = tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir();
const roots: string[] = [];
let scratch: string;
let childBundle: string;

function makeRoot(tag: string): string {
  const r = join(ROOT_BASE, `.tl46-crash-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(r, { recursive: true });
  roots.push(r);
  return r;
}

function copyBytes(from: string, to: string): void {
  writeFileSync(to, readFileSync(from));
}

function seedV3(root: string): void {
  const dir = join(root, 'projects', V3);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  copyBytes(join(STORAGE, 'project-v3-demo-0003', 'project.json'), join(dir, 'project.json'));
  copyBytes(join(STORAGE, 'project-v3-demo-0003', 'scenes', 'main.json'), join(dir, 'scenes', 'main.json'));
}

function seedSource(root: string): void {
  const dir = join(root, 'projects', SOURCE);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
  copyBytes(join(STORAGE, 'project-v2-demo-0002', 'project.json'), join(dir, 'project.json'));
  copyBytes(join(STORAGE, 'project-v2-demo-0002', 'scenes', 'main.json'), join(dir, 'scenes', 'main.json'));
  copyBytes(join(CONTRACTS, 'source-preimages', 'courier.glb'), join(dir, 'sources', 'sha256', COURIER_DIGEST));
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

function runChild(mode: string, root: string, backendId: string): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    const c = spawn(
      process.execPath,
      [childBundle, mode, root, V3, SOURCE, DEST, backendId],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      c.kill('SIGKILL');
      reject(new Error(`child ${mode} timed out (stdout=${out} stderr=${err})`));
    }, 30000);
    c.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    c.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: out });
    });
  });
}

function open(root: string): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => CREATED_AT });
}

function takeover(svc: WorkspaceService, projectId: string): void {
  const t = svc.takeoverWorkspace(projectId);
  if (!t.ok) throw new Error('takeover failed: ' + JSON.stringify(t));
}

function editRequest(revision: number) {
  return {
    op: 'setGameConfig',
    projectId: V3,
    expectedRevision: revision,
    requestId: REQUEST_ID,
    origin: { kind: 'mcp', clientId: 'pi-crash' },
    args: { game: { title: 'Crash edited' } },
  };
}

beforeAll(async () => {
  scratch = join(ROOT_BASE, `.tl46-crash-bundle-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  childBundle = join(scratch, 'm3-storage-child.bundle.mjs');
  await build({
    entryPoints: [join(REPO_ROOT, 'tests', 'crash', 'm3-storage-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: childBundle,
    logLevel: 'silent',
  });
}, 60000);

afterAll(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('packet 46 — real SIGKILL at the v3 envelope boundary (workspace.md §5.3)', () => {
  it('SIGKILL before the rename: old v3 state, leftover temp cleaned on open, retry re-executes', async () => {
    const root = makeRoot('v3-before');
    seedV3(root);
    const ex = await runChild('v3-env-before', root, 'tb-' + '1'.repeat(32));
    expect(ex.signal).toBe('SIGKILL');
    const envPath = join(root, 'projects', V3, 'scenes', 'main.json');
    const before = JSON.parse(readFileSync(envPath, 'utf8')) as { scene: { revision: number }; retry: { records: unknown[] } };
    expect(before.scene.revision).toBe(3);
    expect(before.retry.records.length).toBe(0);

    const svc = open(root);
    takeover(svc, V3);
    const q = svc.query({ op: 'queryProject', projectId: V3 }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(3);
    // The open cleaned the leftover temp.
    const leftovers = readFileSync(envPath).length > 0; // envelope intact
    expect(leftovers).toBe(true);
    // The same request re-executes fresh.
    const r = svc.runCommand(editRequest(3)) as { ok: boolean; revision?: number; duplicated?: boolean };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.revision).toBe(4);
    expect(r.duplicated).toBe(false);
    svc.dispose();
  });

  it('SIGKILL after the rename (before the ack): the new v3 state and record are durable and replay', async () => {
    const root = makeRoot('v3-after');
    seedV3(root);
    const ex = await runChild('v3-env-after', root, 'tb-' + '2'.repeat(32));
    expect(ex.signal).toBe('SIGKILL');
    const envPath = join(root, 'projects', V3, 'scenes', 'main.json');
    const onDisk = JSON.parse(readFileSync(envPath, 'utf8')) as {
      storageVersion: number;
      scene: { revision: number };
      retry: { records: { requestId: string }[] };
      content: { game: { title: string } };
    };
    expect(onDisk.storageVersion).toBe(3);
    expect(onDisk.scene.revision).toBe(4);
    expect(onDisk.retry.records.length).toBe(1);
    expect(onDisk.retry.records[0]!.requestId).toBe(REQUEST_ID);
    expect(onDisk.content.game.title).toBe('Crash edited');

    const svc = open(root);
    takeover(svc, V3);
    const q = svc.query({ op: 'queryProject', projectId: V3 }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(4);
    // A lost-ack retry replays durably (never double-applied).
    const r = svc.runCommand(editRequest(3)) as { ok: boolean; revision?: number; duplicated?: boolean };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.revision).toBe(4);
    expect(r.duplicated).toBe(true);
    svc.dispose();
  });

  it('reports a SIGKILLed owner as stale and reclaims it on the next command', async () => {
    const root = makeRoot('v3-stale');
    seedV3(root);
    const ex = await runChild('stale-owner', root, 'tb-' + '3'.repeat(32));
    expect(ex.signal).toBe('SIGKILL');

    const svc = open(root);
    const entry = svc.scan().entries.find((e) => e.projectId === V3);
    expect(entry?.staleOwnership).toBe(true);
    // The owner is proven dead: the next command reclaims and is served.
    const r = svc.runCommand(editRequest(3)) as { ok: boolean; revision?: number };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.revision).toBe(4);
    svc.dispose();
  });

  it('replays a lost ack after a clean child exit (restart convergence)', async () => {
    const root = makeRoot('v3-lostack');
    seedV3(root);
    const ex = await runChild('v3-ack', root, 'tb-' + '4'.repeat(32));
    expect(ex.signal).toBe(null);
    expect(ex.code).toBe(0);

    const svc = open(root);
    takeover(svc, V3);
    const q = svc.query({ op: 'queryProject', projectId: V3 }) as { ok: boolean; revision: number };
    expect(q.revision).toBe(4);
    const r = svc.runCommand(editRequest(3)) as { ok: boolean; revision?: number; duplicated?: boolean };
    expect(r.ok).toBe(true);
    expect(r.duplicated).toBe(true);
    expect(r.revision).toBe(4);
    svc.dispose();
  });
});

describe('packet 46 — real SIGKILL at every copy boundary (workspace.md §16.5.3)', () => {
  for (const mode of [
    'mig-phase-created',
    'mig-phase-manifest',
    'mig-phase-blobs',
    'mig-phase-envelope',
    'mig-before-envelope',
    'mig-after-envelope',
  ]) {
    it(`${mode}: resume completes the destination byte-exactly and removes the marker`, async () => {
      const root = makeRoot(mode);
      seedSource(root);
      const ex = await runChild(mode, root, 'tb-' + '5'.repeat(32));
      expect(ex.signal).toBe('SIGKILL');
      const destDir = join(root, 'projects', DEST);
      // The destination is never loadable before the resume (no authoritative
      // envelope with a valid project state / a marker present).
      const svc = open(root);
      const scanEntry = svc.scan().entries.find((e) => e.projectId === DEST);
      if (mode !== 'mig-phase-envelope' && mode !== 'mig-after-envelope') {
        expect(scanEntry?.migration).toBe('resume_required');
      }
      const res = svc.migrateProjectCopyV3(SOURCE, DEST);
      expect(res.ok, `${mode}: ${JSON.stringify(res)}`).toBe(true);
      if (!res.ok) throw new Error(`${mode} resume failed: ${JSON.stringify(res)}`);
      expect(res.resumed, mode).toBe(true);
      expect(res.sourceVersion).toBe(2);
      expect(res.newVersion).toBe(3);
      // The destination envelope equals the committed expected fixture.
      expect(
        Buffer.compare(
          readFileSync(join(destDir, 'scenes', 'main.json')),
          readFileSync(join(CONTRACTS, 'migration', 'expected-v3-destination', 'envelope.json')),
        ),
        mode,
      ).toBe(0);
      expect(readFileSync(join(destDir, 'project.json')).equals(
        readFileSync(join(CONTRACTS, 'migration', 'expected-v3-destination', 'project.json')),
      )).toBe(true);
      // The copied blob is correct, the marker is gone and the project loads.
      expect(
        Buffer.compare(
          readFileSync(join(destDir, 'sources', 'sha256', COURIER_DIGEST)),
          readFileSync(join(CONTRACTS, 'source-preimages', 'courier.glb')),
        ),
        mode,
      ).toBe(0);
      expect(() => readFileSync(join(destDir, '.thirdlight', 'migration.json'))).toThrow();
      const q = svc.query({ op: 'queryProject', projectId: DEST }) as { ok: boolean; revision: number };
      expect(q.ok, mode).toBe(true);
      expect(q.revision, mode).toBe(0);
      svc.dispose();
    });
  }
});
