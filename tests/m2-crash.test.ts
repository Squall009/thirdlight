/**
 * Packet 23 — crash durability on the REAL filesystem with REAL subprocess
 * termination (workspace.md §5.1/§13.3.4; acceptance A09).
 *
 * The child runner (tests/crash/m2-child.ts, esbuild-bundled) opens the real
 * storage v4 project, drives a real blob publication and/or a v4 file
 * replacement (the scene file for a scene edit, content.json for a
 * publishAsset), and SIGKILLs itself from inside a WriteOps seam at the exact
 * crash boundary.
 *
 * Seeding (phase 9.3 step B): the committed M2 storage fixture is storage v2,
 * which the workspace now refuses. The seeded copy is converted to the
 * equivalent storage v3 envelope (tests/storage-seed.ts) and opened once by
 * the parent, which upgrades it in place to v4 (project.json v2, content.json,
 * scenes/scene-main.json) before the child runs.
 *
 * The parent then reopens (explicit stale-owner takeover) and
 * asserts what is durable:
 *   - crash before/after blob publication: no acked reference; the blob is
 *     absent or present-and-correct; temps are cleaned on open; retry is
 *     idempotent;
 *   - crash before/after envelope replacement: old state + no record (fresh
 *     re-execution) or new state + record (durable replay);
 *   - crash after the blob but before/after the command: unreferenced durable
 *     bytes at worst, and an acked reference always has durable bytes.
 *
 * Process-crash guarantees are proven here; power-loss durability is the
 * stronger property this suite cannot fully prove without a power-failure
 * simulator (recorded in the handoff).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { openWorkspaceService } from '@thirdlight/workspace';

import { upgradeSeededEnvelopeToV3 } from './storage-seed';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE = join(REPO_ROOT, 'fixtures', 'm2', 'storage');
const PROJECT_ID = 'demo-store-01';

const ROOT_BASE = tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir();
const roots: string[] = [];
let scratch: string;
let childBundle: string;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const FRESH_BYTES = new TextEncoder().encode('packet-23 crash-test fresh blob\n');
const ALPHA = sha256Hex(readFileSync(join(STORAGE, 'blobs', 'alpha.bin')));
const BETA = sha256Hex(readFileSync(join(STORAGE, 'blobs', 'beta.bin')));
const FRESH = sha256Hex(FRESH_BYTES);
const FRESH_LENGTH = FRESH_BYTES.length;

function makeRoot(tag: string): string {
  const r = join(ROOT_BASE, `.tl23-crash-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(r, { recursive: true });
  roots.push(r);
  return r;
}

function seedV4Project(root: string): string {
  cpSync(join(STORAGE, 'project'), join(root, 'projects', PROJECT_ID), { recursive: true });
  const dir = join(root, 'projects', PROJECT_ID);
  mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
  cpSync(join(STORAGE, 'blobs', 'alpha.bin'), join(dir, 'sources', 'sha256', ALPHA));
  cpSync(join(STORAGE, 'blobs', 'beta.bin'), join(dir, 'sources', 'sha256', BETA));
  upgradeSeededEnvelopeToV3(dir);
  // Open once: the v3 project is upgraded in place to storage v4.
  const svc = openWorkspaceService({ root });
  const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision?: number };
  if (!q.ok || q.revision !== 3) throw new Error('seed did not open as v4 at revision 3: ' + JSON.stringify(q));
  // Graceful close releases the ownership so the child claims it at once.
  svc.close();
  return dir;
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

function runChild(mode: string, root: string, backendId: string): Promise<ChildExit & { pid: number }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [childBundle, mode, root, PROJECT_ID, backendId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      c.kill('SIGKILL');
      reject(new Error(`child ${mode} timed out (stdout=${out} stderr=${err})`));
    }, 20000);
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

const SCENE_REL = join('scenes', 'scene-main.json');
const CONTENT_REL = 'content.json';

/** The v4 scene file (a setTransform writes it; its records are the scene's). */
function sceneFile(root: string): { storageVersion: number; scene: { revision: number }; retry: { records: { requestId: string }[] } } {
  return JSON.parse(readFileSync(join(root, 'projects', PROJECT_ID, SCENE_REL), 'utf8'));
}

/** The v4 content file (a publishAsset writes it; its records are the content's). */
function contentFile(root: string): { storageVersion: number; revision: number; retry: { records: { requestId: string }[] } } {
  return JSON.parse(readFileSync(join(root, 'projects', PROJECT_ID, CONTENT_REL), 'utf8'));
}

/** The project revision: the highest file revision (store-v4.ts). */
function projectRevision(root: string): number {
  return Math.max(sceneFile(root).scene.revision, contentFile(root).revision);
}

function allRecordIds(root: string): string[] {
  return [...sceneFile(root).retry.records, ...contentFile(root).retry.records].map((r) => r.requestId);
}

function blobDir(root: string): string {
  return join(root, 'projects', PROJECT_ID, 'sources', 'sha256');
}

beforeAll(async () => {
  scratch = join(ROOT_BASE, `.tl23-crash-bundle-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  childBundle = join(scratch, 'm2-child.bundle.mjs');
  await build({
    entryPoints: [join(REPO_ROOT, 'tests', 'crash', 'm2-child.ts')],
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

describe('packet 23 — real SIGKILL at the blob / v4 file boundaries (workspace.md §13.3.4)', () => {
  it('SIGKILL before the blob rename: no blob, leftover temp cleaned on open, retry is idempotent', async () => {
    const root = makeRoot('blob-before');
    const dir = seedV4Project(root);
    const ex = await runChild('blob-before', root, 'tb-' + '1'.repeat(32));
    expect(ex.signal, ex.stdout).toBe('SIGKILL');
    const temps = readdirSync(blobDir(root)).filter((n) => n.startsWith(`.${FRESH}.tmp-`));
    expect(temps.length).toBeGreaterThanOrEqual(1);
    expect(readdirSync(blobDir(root))).not.toContain(FRESH);

    const svc = openWorkspaceService({ root });
    const to = svc.takeoverWorkspace(PROJECT_ID);
    if (!to.ok) throw new Error('takeover failed: ' + JSON.stringify(to));
    // The open cleaned the leftover blob temp (workspace.md §5.4/§13.2 rule 5).
    expect(readdirSync(blobDir(root)).filter((n) => n.startsWith(`.${FRESH}.tmp-`))).toEqual([]);
    expect(readdirSync(blobDir(root))).not.toContain(FRESH);
    // The project files are untouched (no unreferenced record).
    expect(projectRevision(root)).toBe(3);
    expect(allRecordIds(root)).toEqual([]);

    // A fresh publication of the same bytes succeeds (idempotent retry).
    const bytes = FRESH_BYTES;
    const pub = svc.publishBlob(PROJECT_ID, { digest: FRESH, byteLength: bytes.length, source: { kind: 'bytes', bytes } });
    if (!pub.ok) throw new Error('republish failed: ' + JSON.stringify(pub));
    expect(pub.published).toBe(true);
    expect(readdirSync(blobDir(root))).toContain(FRESH);
    svc.dispose();
  }, 30000);

  it('SIGKILL after the blob rename: the immutable blob is durable and correct; republish is idempotent', async () => {
    const root = makeRoot('blob-after');
    seedV4Project(root);
    const ex = await runChild('blob-after', root, 'tb-' + '2'.repeat(32));
    expect(ex.signal, ex.stdout).toBe('SIGKILL');
    // The rename completed: the blob is on disk with the right content.
    const bytes = readFileSync(join(blobDir(root), FRESH));
    expect(sha256Hex(bytes)).toBe(FRESH);
    // The project files were never touched by the blob publication.
    expect(projectRevision(root)).toBe(3);
    expect(allRecordIds(root)).toEqual([]);

    const svc = openWorkspaceService({ root });
    const to = svc.takeoverWorkspace(PROJECT_ID);
    if (!to.ok) throw new Error('takeover failed');
    const again = svc.publishBlob(PROJECT_ID, { digest: FRESH, byteLength: bytes.length, source: { kind: 'bytes', bytes } });
    if (!again.ok) throw new Error('republish failed');
    expect(again.published).toBe(false);
    expect(again.alreadyPresent).toBe(true);
    svc.dispose();
  }, 30000);

  it('SIGKILL before the scene-file rename: old state, no record, retry re-executes fresh', async () => {
    const root = makeRoot('env-before');
    const dir = seedV4Project(root);
    const ex = await runChild('env-before', root, 'tb-' + '3'.repeat(32));
    expect(ex.signal, ex.stdout).toBe('SIGKILL');
    expect(sceneFile(root).scene.revision).toBe(3);
    expect(sceneFile(root).retry.records).toEqual([]);
    expect(projectRevision(root)).toBe(3);
    // The W temp of the scene file is left behind by the crash.
    expect(readdirSync(join(dir, 'scenes')).filter((n) => n.startsWith('.scene-main.json.tmp-')).length).toBeGreaterThanOrEqual(1);

    const svc = openWorkspaceService({ root });
    const to = svc.takeoverWorkspace(PROJECT_ID);
    if (!to.ok) throw new Error('takeover failed');
    expect(readdirSync(join(dir, 'scenes')).filter((n) => n.startsWith('.scene-main.json.tmp-'))).toEqual([]);
    const r = svc.runCommand({
      op: 'setTransform',
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'd'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { entityId: 'model-0001', transform: { position: [1, 0, 0] } },
    });
    if (!r.ok) throw new Error('retry failed: ' + JSON.stringify(r));
    expect(r.duplicated).toBe(false);
    expect(r.revision).toBe(4);
    expect(sceneFile(root).scene.revision).toBe(4);
    expect(sceneFile(root).retry.records.map((x) => x.requestId)).toEqual(['req-' + 'd'.repeat(32)]);
    svc.dispose();
  }, 30000);

  it('SIGKILL after the scene-file rename: new state + durable record; replay is duplicated and byte-stable', async () => {
    const root = makeRoot('env-after');
    seedV4Project(root);
    const ex = await runChild('env-after', root, 'tb-' + '4'.repeat(32));
    expect(ex.signal, ex.stdout).toBe('SIGKILL');
    expect(sceneFile(root).storageVersion).toBe(4);
    expect(sceneFile(root).scene.revision).toBe(4);
    expect(sceneFile(root).retry.records.map((x) => x.requestId)).toContain('req-' + 'd'.repeat(32));
    // A scene-only edit writes the scene file alone (one W; content.json untouched).
    expect(contentFile(root).revision).toBe(3);
    const frozen = readFileSync(join(root, 'projects', PROJECT_ID, SCENE_REL));

    const svc = openWorkspaceService({ root });
    const to = svc.takeoverWorkspace(PROJECT_ID);
    if (!to.ok) throw new Error('takeover failed');
    const r = svc.runCommand({
      op: 'setTransform',
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'd'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { entityId: 'model-0001', transform: { position: [1, 0, 0] } },
    });
    if (!r.ok) throw new Error('replay failed: ' + JSON.stringify(r));
    expect(r.duplicated).toBe(true);
    expect(r.revision).toBe(4);
    expect(readFileSync(join(root, 'projects', PROJECT_ID, SCENE_REL)).equals(frozen)).toBe(true);
    svc.dispose();
  }, 30000);

  it('SIGKILL after the blob, before the command: unreferenced durable bytes; the fresh retry commits once', async () => {
    const root = makeRoot('publish-before');
    seedV4Project(root);
    const ex = await runChild('publish-before', root, 'tb-' + '5'.repeat(32));
    expect(ex.signal, ex.stdout).toBe('SIGKILL');
    // Blob durable, content.json unchanged, no record.
    expect(sha256Hex(readFileSync(join(blobDir(root), FRESH)))).toBe(FRESH);
    expect(contentFile(root).revision).toBe(3);
    expect(projectRevision(root)).toBe(3);
    expect(allRecordIds(root)).toEqual([]);

    const svc = openWorkspaceService({ root });
    const to = svc.takeoverWorkspace(PROJECT_ID);
    if (!to.ok) throw new Error('takeover failed');
    const r = svc.runCommand({
      op: 'publishAsset',
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'c'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: {
        mode: 'create',
        kind: 'model',
        assetId: 'asset-00000000000000ee',
        displayName: 'Crash',
        sourceDigest: FRESH,
        sourceByteLength: FRESH_LENGTH,
        importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
        metrics: {
          nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0,
          vertices: 3, triangles: 1, animations: 0, animationChannels: 0, clipDurationMs: 0,
          decodedGeometryBytes: 36, decodedImageBytes: 0,
        },
        importedAt: '2026-09-18T12:00:00Z',
      },
    });
    if (!r.ok) throw new Error('retry failed: ' + JSON.stringify(r));
    expect(r.duplicated).toBe(false);
    expect(r.revision).toBe(4);
    const rb = svc.readBlob(PROJECT_ID, { assetId: 'asset-00000000000000ee', version: 1 });
    expect(rb.ok).toBe(true);
    svc.dispose();
  }, 30000);

  it('SIGKILL after the content.json rename carrying a new reference: the acked reference has durable bytes and replays', async () => {
    const root = makeRoot('publish-after');
    seedV4Project(root);
    const ex = await runChild('publish-after', root, 'tb-' + '6'.repeat(32));
    expect(ex.signal, ex.stdout).toBe('SIGKILL');
    // publishAsset writes content.json alone: the new revision and the record live there.
    expect(contentFile(root).storageVersion).toBe(4);
    expect(contentFile(root).revision).toBe(4);
    expect(contentFile(root).retry.records.map((x) => x.requestId)).toContain('req-' + 'c'.repeat(32));
    expect(sceneFile(root).scene.revision).toBe(3);
    expect(sha256Hex(readFileSync(join(blobDir(root), FRESH)))).toBe(FRESH);
    const frozen = readFileSync(join(root, 'projects', PROJECT_ID, CONTENT_REL));

    const svc = openWorkspaceService({ root });
    const to = svc.takeoverWorkspace(PROJECT_ID);
    if (!to.ok) throw new Error('takeover failed');
    // The durable record replays (no re-publication, no stage lookup).
    const r = svc.runCommand({
      op: 'publishAsset',
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'c'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: {
        mode: 'create',
        kind: 'model',
        assetId: 'asset-00000000000000ee',
        displayName: 'Crash',
        sourceDigest: FRESH,
        sourceByteLength: FRESH_LENGTH,
        importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
        metrics: {
          nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0,
          vertices: 3, triangles: 1, animations: 0, animationChannels: 0, clipDurationMs: 0,
          decodedGeometryBytes: 36, decodedImageBytes: 0,
        },
        importedAt: '2026-09-18T12:00:00Z',
      },
    });
    if (!r.ok) throw new Error('replay failed: ' + JSON.stringify(r));
    expect(r.duplicated).toBe(true);
    expect(readFileSync(join(root, 'projects', PROJECT_ID, CONTENT_REL)).equals(frozen)).toBe(true);
    // The acked reference resolves to verified durable bytes after restart.
    const rb = svc.readBlob(PROJECT_ID, { assetId: 'asset-00000000000000ee', version: 1 });
    if (!rb.ok) throw new Error('readBlob failed: ' + JSON.stringify(rb));
    expect(rb.digest).toBe(FRESH);
    expect(rb.verified).toBe(true);
    svc.dispose();
  }, 30000);
});
