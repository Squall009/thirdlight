/**
 * Shared helpers for the workspace tests.
 *
 * Tests run against REAL temporary directories under /home/dadmin/.tl07-tmp-*
 * (ext4 — /tmp is tmpfs and cannot exercise the directory-flush semantics),
 * cleaned up in afterAll. The scenario fixtures (fixtures/commands/scenarios)
 * pin exact request/response payloads and disk states; the runner replays
 * them through the real service and compares byte-for-byte.
 */

import { mkdirSync, cpSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

import { openWorkspaceService, type WorkspaceService, type WriteOps } from '@thirdlight/workspace';

import { buildEnvelopeBytes } from '../src/envelope';
import { defaultScene } from '../src/session';

export const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
export const FIXTURES = join(REPO_ROOT, 'fixtures', 'commands');
/** The one scene file of the corpus projects (storage v4). */
export const SCENE_FILE = join('scenes', 'scene-main.json');

/** A valid v4 project directory of the corpus (`envelope/valid/<name>`). */
export function projectFixture(name: string): string {
  return join(FIXTURES, 'envelope', 'valid', name);
}

/** Temp roots live on ext4 (/home/dadmin/.tl07-tmp-*), not tmpfs /tmp.
 * Each test removes its own root; the process-exit backstop below is a
 * safety net for failed tests (leftover roots are identifiable by the
 * `.tl07-tmp-` prefix and safe to remove manually). */
const roots: string[] = [];
let backstopInstalled = false;
function backstop(): void {
  if (backstopInstalled) return;
  backstopInstalled = true;
  const cleanup = (): void => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };
  try {
    // 'exit' covers normal exit and process.exit(); signal kills do NOT run
    // 'exit' handlers, so also clean up on the SIGTERM/SIGINT paths a
    // supervisor takes before escalating to SIGKILL. SIGKILL residue is
    // reaped by the next suite start (tests/test-hygiene.ts globalSetup).
    process.on('exit', cleanup);
    process.once('SIGTERM', () => {
      cleanup();
      process.exit(143);
    });
    process.once('SIGINT', () => {
      cleanup();
      process.exit(130);
    });
  } catch {
    // backstop is optional
  }
}

export function makeRoot(tag: string): string {
  const base = join(
    tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir(),
    `.tl07-tmp-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`,
  );
  mkdirSync(base, { recursive: true });
  roots.push(base);
  backstop();
  return base;
}

/**
 * A storage-v1 (M1) project at revision 0, built from the workspace's own v1
 * builders — for the few tests of v1-only behavior (the storage-version op
 * gate, M1 content refusal) until the v1/v2 code is removed (phase 9.3 step
 * B). The command corpus (`FIXTURES`) is storage v4.
 */
export function seedV1Project(root: string, projectId: string): string {
  const dir = join(root, 'projects', projectId);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    id: projectId,
    name: 'Demo Project',
    createdAt: '2026-09-16T23:40:00Z',
    scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
  };
  writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dir, 'scenes', 'main.json'), buildEnvelopeBytes(projectId, defaultScene(), []));
  return dir;
}

/** Copy a fixture disk state into `<root>/projects/<projectId>`. */
export function seedProject(root: string, diskDir: string, projectId: string): string {
  const dest = join(root, 'projects', projectId);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(diskDir, dest, { recursive: true });
  return dest;
}

export function fileBytes(p: string): Uint8Array {
  return new Uint8Array(readFileSync(p));
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compare an authoring-state disk against a fixture disk state: every file
 * present in the fixture must be byte-identical, and no extra authoring
 * files may appear (workspace-internal `.thirdlight` contents are compared
 * separately when pinned).
 */
export function compareAuthoringDisk(actualDir: string, fixtureDir: string): string[] {
  const problems: string[] = [];
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  for (const f of walk(fixtureDir)) {
    const rel = f.slice(fixtureDir.length + 1);
    const actual = join(actualDir, rel);
    if (!existsSync(actual) || !statSync(actual).isFile()) {
      problems.push(`missing: ${rel}`);
      continue;
    }
    const a = fileBytes(actual);
    const b = fileBytes(f);
    if (a.length !== b.length || sha256Hex(a) !== sha256Hex(b)) {
      problems.push(`byte mismatch: ${rel}`);
    }
  }
  return problems;
}

/** Dispatch one scenario message through the service. */
export function dispatch(svc: WorkspaceService, msg: Record<string, unknown>): unknown {
  const op = msg['op'];
  if (op === 'createProject') {
    return svc.createProject(msg['projectId'] as string, msg['name'] as string);
  }
  if (op === 'releaseWorkspace') return svc.releaseWorkspace(msg['projectId'] as string);
  if (op === 'takeoverWorkspace') return svc.takeoverWorkspace(msg['projectId'] as string);
  if (op === 'acceptExternalState') return svc.acceptExternalState(msg['projectId'] as string);
  if (op === 'discardExternalState') return svc.discardExternalState(msg['projectId'] as string);
  if (op === 'scan') return svc.scan();
  // Mutations and queries both go through the op field.
  if (typeof op === 'string' && ['queryProject', 'queryEntity', 'queryEntities'].includes(op)) {
    return svc.query(msg);
  }
  return svc.runCommand(msg);
}

/**
 * Deep equality with stable key-order-independent comparison (JSON values).
 * `overrides` rewrites specific response fields before comparing (e.g. the
 * self pid in takeover results — fixtures pin a nominal pid).
 */
export function deepEqual(actual: unknown, expected: unknown, overrides?: (actual: any) => any): boolean {
  const a = overrides ? overrides(structuredClone(actual)) : actual;
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(expected));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/**
 * A controlled /proc tree for liveness tests (workspace.md §6.2).
 * `live` processes get a stat file (started well before `openedAt`) and a
 * cmdline containing the marker; `dead` processes get no /proc entry.
 */
export function buildFakeProc(
  root: string,
  procs: Record<number, 'live' | 'dead' | 'reused'>,
  marker = 'thirdlight',
  openedAt = '2026-09-17T09:00:00Z',
): string {
  const procRoot = join(root, 'proc');
  mkdirSync(procRoot, { recursive: true });
  const bootWallMs = Date.now() - uptime() * 1000;
  // The liveness check derives start times from `btime` in <procRoot>/stat
  // (the same clock the fake start times are built against).
  writeFileSync(join(procRoot, 'stat'), `btime ${Math.floor(bootWallMs / 1000)}\n`);
  for (const [pid, kind] of Object.entries(procs)) {
    const n = Number(pid);
    if (kind === 'dead') continue; // absent ⇒ dead
    const dir = join(procRoot, String(n));
    mkdirSync(dir, { recursive: true });
    let startTicks: number;
    if (kind === 'reused') {
      // Started NOW (after any past openedAt) ⇒ pid reuse ⇒ dead.
      startTicks = Math.floor((Date.now() - bootWallMs + 5000) / 10);
    } else {
      // One minute before openedAt ⇒ started before it.
      startTicks = Math.max(1, Math.floor((Date.parse(openedAt) - bootWallMs - 60_000) / 10));
    }
    // stat: `pid (comm) S <19 fields, last = starttime> ...`
    const fields: string[] = [];
    for (let i = 0; i < 18; i++) fields.push('0');
    fields.push(String(startTicks));
    writeFileSync(join(dir, 'stat'), `${n} (fake-thirdlight) S ${fields.join(' ')} 0 0 0\n`);
    writeFileSync(join(dir, 'cmdline'), Buffer.concat([Buffer.from(`${marker}-node`), Buffer.from([0]), Buffer.from('--run')]).subarray(0, Buffer.from(`${marker}-node`).length + 1));
  }
  return procRoot;
}