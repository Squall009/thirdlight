/**
 * Packet 46 — real SIGKILL durability for a storage v3 project's state after
 * its in-place upgrade to storage v4 (workspace.md §5.3).
 *
 * The child runner (tests/crash/m3-storage-child.ts, esbuild-bundled) drives a
 * real `setGameConfig` and SIGKILLs itself from inside a WriteOps seam at an
 * exact boundary. The committed v3 fixture is seeded and opened once by the
 * parent (upgraded in place to v4: project.json v2, content.json,
 * scenes/scene-main.json); a game-config edit writes content.json alone. The
 * parent reopens (explicit stale-owner takeover where needed) and asserts what
 * is durable:
 *
 *   - crash before/after the content.json replacement: old state + no record
 *     (fresh re-execution) or new state + record (durable replay);
 *   - a SIGKILLed owner is reported stale by the scan and reclaimed on the next access;
 *   - a lost ack is replayed, never double-applied.
 *
 * The v2→v3 copy-operator crash cases (`migrateProjectCopyV3`) were removed
 * with the operator (phase 9.3 step B); the original suite is archived at
 * archive/removed-v1-v2/tests/crash/m3-storage-crash.test.ts.
 *
 * Process-crash guarantees are proven here; power-loss durability is the
 * stronger property this suite cannot prove without a power-failure simulator.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const V3 = 'demo-0003';
const REQUEST_ID = 'req-' + 'e'.repeat(32);
const CREATED_AT = '2026-09-19T10:00:00Z';

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
  // Open once: the v3 project is upgraded in place to storage v4; the graceful
  // close releases the ownership so the child claims it at once.
  const svc = open(root);
  const q = svc.query({ op: 'queryProject', projectId: V3 }) as { ok: boolean; revision?: number };
  if (!q.ok || q.revision !== 3) throw new Error('seed did not open as v4 at revision 3: ' + JSON.stringify(q));
  svc.close();
}

const CONTENT_REL = 'content.json';
type ContentFile = {
  storageVersion: number;
  revision: number;
  retry: { records: { requestId: string }[] };
  content: { game: { title: string } | null };
};
function contentFile(root: string): ContentFile {
  return JSON.parse(readFileSync(join(root, 'projects', V3, CONTENT_REL), 'utf8')) as ContentFile;
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

function runChild(mode: string, root: string, backendId: string): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    const c = spawn(
      process.execPath,
      [childBundle, mode, root, V3, backendId],
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

describe('packet 46 — real SIGKILL at the content.json boundary of an upgraded v3 project (workspace.md §5.3)', () => {
  it('SIGKILL before the rename: old state, leftover temp cleaned on open, retry re-executes', async () => {
    const root = makeRoot('v3-before');
    seedV3(root);
    const before = readFileSync(join(root, 'projects', V3, CONTENT_REL));
    const ex = await runChild('v3-env-before', root, 'tb-' + '1'.repeat(32));
    expect(ex.signal, ex.stdout).toBe('SIGKILL');
    // The old content.json is intact (no record) and the W temp is left behind.
    expect(readFileSync(join(root, 'projects', V3, CONTENT_REL)).equals(before)).toBe(true);
    const onDisk = contentFile(root);
    expect(onDisk.revision).toBe(3);
    expect(onDisk.retry.records.length).toBe(0);
    const temps = (): string[] => readdirSync(join(root, 'projects', V3)).filter((n) => n.startsWith('.content.json.tmp-'));
    expect(temps().length).toBeGreaterThanOrEqual(1);

    const svc = open(root);
    takeover(svc, V3);
    const q = svc.query({ op: 'queryProject', projectId: V3 }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(3);
    // The open cleaned the leftover temp.
    expect(temps()).toEqual([]);
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
    expect(ex.signal, ex.stdout).toBe('SIGKILL');
    const onDisk = contentFile(root);
    expect(onDisk.storageVersion).toBe(4);
    expect(onDisk.revision).toBe(4);
    expect(onDisk.retry.records.length).toBe(1);
    expect(onDisk.retry.records[0]!.requestId).toBe(REQUEST_ID);
    expect(onDisk.content.game?.title).toBe('Crash edited');

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
    expect(ex.signal, ex.stdout).toBe('SIGKILL');

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
