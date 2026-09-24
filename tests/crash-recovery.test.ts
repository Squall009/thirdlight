/**
 * Packet 07 — crash-recovery on the REAL filesystem with REAL subprocess
 * termination (workspace.md §5.1/§5.2, §6.2, §9.4).
 *
 * The child runner (tests/crash/child.ts, esbuild-bundled) runs the
 * workspace service with a fault seam at the exact crash point, then
 * SIGKILLs itself:
 *   - crash-before: dies between the temp write and the atomic rename —
 *     old state on disk, a leftover temp, no record, no ack.
 *   - crash-after:  dies after the rename (new bytes on disk) and before
 *     the directory flush completes / the ack is sent.
 *   - claim:        a second LIVE backend (for the ownership-conflict
 *     assertion with the real /proc liveness rules).
 *
 * These live under the repo-root tests/ (not a package) because
 * node:child_process is a forbidden edge for package code
 * (dependencies.md §4.1). Temp roots are on ext4 (/home/dadmin).
 *
 * Process-crash guarantees are proven here; POWER-LOSS durability is a
 * stronger property (directory-flush ordering) that this suite exercises
 * through the same write sequence but cannot fully prove without a
 * power-failure simulator — the handoff records that explicitly.
 */

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { openWorkspaceService } from '@thirdlight/workspace';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO_ROOT, 'fixtures', 'commands');

const ROOT_BASE = join(tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir());
let scratch: string;
let childBundle: string;
const roots: string[] = [];

function makeRoot(tag: string): string {
  const r = join(ROOT_BASE, `.tl07-crash-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(r, { recursive: true });
  roots.push(r);
  return r;
}

/** demo-0001 at mainline T5 (storage v4: project.json, content.json,
 * scenes/scene-main.json). A setTransform writes the scene file only (one W). */
function seedProject(root: string, projectId: string): string {
  const dir = join(root, 'projects', projectId);
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(join(FIXTURES, 'envelope', 'valid', 'demo-0001-rev5'), dir, { recursive: true });
  return dir;
}

/** The scene file and its W temp prefix (write.ts: `.<target>.tmp-<pid>-<n>`). */
const SCENE_FILE = join('scenes', 'scene-main.json');
const SCENE_TEMP_PREFIX = '.scene-main.json.tmp-';

type ChildExit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

function runChild(mode: string, root: string, projectId: string, backendId: string, requestId?: string, expectedRevision?: number): Promise<ChildExit & { pid: number }> {
  return new Promise((resolve, reject) => {
    const args = [childBundle, mode, root, projectId, backendId];
    if (requestId !== undefined) args.push(requestId);
    if (expectedRevision !== undefined) args.push(String(expectedRevision));
    const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.stderr.on('data', (d) => {
      err += d;
    });
    const timer = setTimeout(() => {
      c.kill('SIGKILL');
      reject(new Error(`child ${mode} timed out (stdout=${out} stderr=${err})`));
    }, 15000);
    c.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    c.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: out, pid: c.pid! });
    });
  });
}

async function waitForLine(state: { out: string; done: boolean }, needle: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (state.out.includes(needle)) return;
    if (state.done) throw new Error(`child exited without ${JSON.stringify(needle)} (got: ${state.out})`);
    if (Date.now() > deadline) throw new Error(`child did not emit ${JSON.stringify(needle)} (got: ${state.out})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function envJson(path: string): { scene: { revision: number }; retry: { records: { requestId: string }[] } } {
  return JSON.parse(readFileSync(path, 'utf8')) as { scene: { revision: number }; retry: { records: { requestId: string }[] } };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(ROOT_BASE, '.tl07-crash-bundle-'));
  childBundle = join(scratch, 'child.bundle.mjs');
  await build({
    entryPoints: [join(REPO_ROOT, 'tests', 'crash', 'child.ts')],
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

describe('crash recovery with real subprocess termination (workspace.md §5/§6)', () => {
  it('SIGKILL before the rename: old state + leftover temp; restart re-executes the request fresh (no double-apply)', async () => {
    const root = makeRoot('before');
    const dir = seedProject(root, 'demo-0001');
    const envPath = join(dir, SCENE_FILE);
    const before = readFileSync(envPath);
    const requestId = 'req-11111111111111111111111111111101';
    const childId = 'tb-11111111111111111111111111111111';

    const ex = await runChild('crash-before', root, 'demo-0001', childId, requestId, 5);
    expect(ex.signal).toBe('SIGKILL');

    // The crash left the OLD state on disk (the rename never happened)…
    expect(readFileSync(envPath).equals(before)).toBe(true);
    // …and a leftover temp file in the scenes directory.
    const temps = readdirSync(join(dir, 'scenes')).filter((n) => n.startsWith(SCENE_TEMP_PREFIX));
    expect(temps.length).toBeGreaterThanOrEqual(1);
    // The claim had completed: the ownership record is the child's (now dead).
    const rec = JSON.parse(readFileSync(join(dir, '.thirdlight', 'ownership.json'), 'utf8')) as {
      state: string;
      backendId: string;
      pid: number;
    };
    expect(rec.state).toBe('owned');
    expect(rec.backendId).toBe(childId);
    expect(rec.pid).toBe(ex.pid);

    // Restart: the child's pid is gone from /proc, so the new backend
    // reclaims the project automatically.
    const svc = openWorkspaceService({ root });
    const q = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean };
    expect(q.ok).toBe(true);

    // The crashed request left NO durable record: re-sending it executes
    // fresh (commands.md §7.3) — exactly once.
    const r = svc.runCommand({
      op: 'setTransform',
      projectId: 'demo-0001',
      expectedRevision: 5,
      requestId,
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
    }) as MutationResult;
    expect(r.ok).toBe(true);
    expect(r.revision).toBe(6);
    expect(r.duplicated).toBe(false);

    // The takeover's open cleaned the leftover temp (owner cleans at
    // open, §5.4); the disk carries the applied state with the record.
    const tempsAfter = readdirSync(join(dir, 'scenes')).filter((n) => n.startsWith(SCENE_TEMP_PREFIX));
    expect(tempsAfter).toEqual([]);
    const disk = envJson(envPath);
    expect(disk.scene.revision).toBe(6);
    expect(disk.retry.records.map((x) => x.requestId)).toContain(requestId);
    svc.dispose();
  }, 30000);

  it('SIGKILL after the rename: new bytes on disk; restart replays the ack from the durable record (duplicated, no rewrite)', async () => {
    const root = makeRoot('after');
    const dir = seedProject(root, 'demo-0001');
    const envPath = join(dir, SCENE_FILE);
    const requestId = 'req-22222222222222222222222222222202';
    const childId = 'tb-22222222222222222222222222222222';

    const ex = await runChild('crash-after', root, 'demo-0001', childId, requestId, 5);
    expect(ex.signal).toBe('SIGKILL');

    // The rename completed before the crash: the NEW bytes are on disk
    // (revision 6, the record present) — but no ack was ever sent.
    const diskNow = envJson(envPath);
    expect(diskNow.scene.revision).toBe(6);
    expect(diskNow.retry.records.map((x) => x.requestId)).toContain(requestId);
    const frozen = readFileSync(envPath);

    const svc = openWorkspaceService({ root });
    const q = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean };
    expect(q.ok).toBe(true);

    // The retry (same requestId) is answered from the durable record —
    // replayed, never re-applied; the disk is byte-identical.
    const r = svc.runCommand({
      op: 'setTransform',
      projectId: 'demo-0001',
      expectedRevision: 5,
      requestId,
      origin: { kind: 'mcp', clientId: 'pi-harness' },
      args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
    }) as MutationResult;
    if (!r.ok) throw new Error(`retry failed: ${JSON.stringify(r)}`);
    expect(r.duplicated).toBe(true);
    expect(r.revision).toBe(6);
    // Phase 14.8: the replay is the live acknowledgement, the edited scene included.
    expect(r.sceneId).toBe('scene-main');
    expect(readFileSync(envPath).equals(frozen)).toBe(true);
    svc.dispose();
  }, 30000);

  it('a second LIVE backend (real /proc) is rejected with the real holder; no takeover until it is gone', async () => {
    const root = makeRoot('live');
    seedProject(root, 'demo-0001');
    const holderId = 'tb-33333333333333333333333333333333';

    const holder = spawn(process.execPath, [childBundle, 'claim', root, 'demo-0001', holderId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const holderState = { out: '', done: false };
    holder.stdout!.on('data', (d) => {
      holderState.out += d;
    });
    holder.on('exit', () => {
      holderState.done = true;
    });
    await waitForLine(holderState, '"holding":true', 15000);
    expect(holder.pid).toBeGreaterThan(0);

    const svc = openWorkspaceService({ root });
    const q = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as {
      ok: boolean;
      error?: { code: string; reason?: string; holder?: { backendId: string; pid: number; state: string } };
    };
    expect(q.ok).toBe(false);
    expect(q.error?.code).toBe('project_unavailable');
    expect(q.error?.reason).toBe('ownership_conflict');
    expect(q.error?.holder?.backendId).toBe(holderId);
    expect(q.error?.holder?.pid).toBe(holder.pid!);
    expect(q.error?.holder?.state).toBe('owned');

    // Even an EXPLICIT takeover must fail while the owner is live.
    const to = svc.takeoverWorkspace('demo-0001');
    expect(to.ok).toBe(false);
    if (!to.ok) expect(to.error.code).toBe('ownership_conflict');

    // Stop the holder; the project is reclaimed on the next access.
    holder.kill('SIGTERM');
    await new Promise<void>((resolve) => holder.on('exit', () => resolve()));
    const q2 = svc.query({ op: 'queryProject', projectId: 'demo-0001' }) as { ok: boolean };
    expect(q2.ok).toBe(true);
    svc.dispose();
  }, 30000);
});