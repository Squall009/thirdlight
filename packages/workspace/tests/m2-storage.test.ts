/**
 * Packet 23 — content storage on the real filesystem (workspace.md §7.6,
 * §11, §13; project-model §19).
 *
 * Every test uses a disposable data root on ext4 (/home/dadmin/.tl07-tmp-*),
 * seeds the byte-exact storageVersion 2 project from fixtures/m2/storage,
 * installs the fixture blobs under `sources/sha256/`, and drives the real
 * `@thirdlight/workspace` service. Nothing is mocked where the contract
 * requires real filesystem behavior; only the quota/clock seams are injected.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type WorkspaceService, type WorkspaceServiceConfig } from '@thirdlight/workspace';
import { defaultOps as defaultWriteOps } from '../src/write';
import {
  derivedCachePath,
  readDerivedImport,
  writeDerivedImport,
} from '../src/content-store';

import { FIXTURES, REPO_ROOT, fileBytes, makeRoot, seedProject, sha256Hex } from './helpers';

const STORAGE = join(REPO_ROOT, 'fixtures', 'm2', 'storage');
const PROJECT_ID = 'demo-store-01';
const ASSET_A = 'asset-00000000000000a1';
const ASSET_B = 'asset-00000000000000b2';
const ALPHA = sha256Hex(fileBytes(join(STORAGE, 'blobs', 'alpha.bin')));
const BETA = sha256Hex(fileBytes(join(STORAGE, 'blobs', 'beta.bin')));

const ENVELOPE = JSON.parse(
  readFileSync(join(STORAGE, 'project', 'scenes', 'main.json'), 'utf8'),
) as {
  content: {
    assets: {
      assetId: string;
      currentVersion: number;
      versions: { version: number; sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown }[];
    }[];
  };
  scene: { revision: number };
};

function fixtureRecipeMetrics(assetId: string, version: number) {
  const rec = ENVELOPE.content.assets.find((a) => a.assetId === assetId)!;
  const v = rec.versions.find((x) => x.version === version)!;
  return { importRecipe: v.importRecipe, metrics: v.metrics, sourceByteLength: v.sourceByteLength };
}

interface Ctx {
  root: string;
  dir: string;
  svc: WorkspaceService;
  clock: { value: number };
}

let ctx: Ctx;

function setup(extra: Partial<WorkspaceServiceConfig> = {}): Ctx {
  const root = makeRoot('m2store');
  seedProject(root, join(STORAGE, 'project'), PROJECT_ID);
  const dir = join(root, 'projects', PROJECT_ID);
  mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
  copyFileSync(join(STORAGE, 'blobs', 'alpha.bin'), join(dir, 'sources', 'sha256', ALPHA));
  copyFileSync(join(STORAGE, 'blobs', 'beta.bin'), join(dir, 'sources', 'sha256', BETA));
  const clock = { value: Date.now() };
  const svc = openWorkspaceService({
    root,
    now: () => clock.value,
    ...extra,
  });
  return { root, dir, svc, clock };
}

function reopen(c: Ctx, extra: Partial<WorkspaceServiceConfig> = {}): WorkspaceService {
  c.svc.dispose();
  const svc = openWorkspaceService({
    root: c.root,
    now: () => c.clock.value,
    backendId: 'tb-00000000000000000000000000000001',
    ...extra,
  });
  c.svc = svc;
  return svc;
}

/** A fresh service identity (for the second-owner case). */
function openOther(c: Ctx, backendId: string): WorkspaceService {
  return openWorkspaceService({ root: c.root, backendId, now: () => c.clock.value });
}

/** Loose access to contract fields not on the CommandError interface. */
function ef(e: unknown): Record<string, unknown> {
  return e as Record<string, unknown>;
}

function blobPath(c: Ctx, digest: string): string {
  return join(c.dir, 'sources', 'sha256', digest);
}

describe('packet 23 — v2 envelope, blob reads, integrity and capture (workspace.md §13)', () => {
  it('loads the v2 envelope, reads verified bytes and derives the captured content view', () => {
    ctx = setup();
    const q = ctx.svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(3);

    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_A, version: 2 });
    if (!r.ok) throw new Error(`readBlob failed: ${JSON.stringify(r)}`);
    expect(r.digest).toBe(ALPHA);
    expect(r.verified).toBe(true);
    expect(r.bytes.length).toBe(28);
    expect(sha256Hex(r.bytes)).toBe(ALPHA);

    const integrity = ctx.svc.contentIntegrity(PROJECT_ID);
    if (!integrity.ok) throw new Error('integrity failed');
    expect(integrity.summary).toMatchObject({ total: 3, ok: 3, missing: 0, corrupt: 0, orphanBlobs: 0 });
    // The superseded version 1 of asset A is not the current version.
    expect(integrity.entries.find((e) => e.assetId === ASSET_A && e.version === 1)!.referenced).toBe(false);
    expect(integrity.entries.find((e) => e.assetId === ASSET_A && e.version === 2)!.referenced).toBe(true);

    const view = ctx.svc.captureContentView(PROJECT_ID);
    if (!view.ok) throw new Error(`capture failed: ${JSON.stringify(view)}`);
    expect(view.view.revision).toBe(3);
    // The view is a closure over scene model references: only asset A.
    expect(view.view.assets.map((a) => a.assetId)).toEqual([ASSET_A]);
    expect(view.view.assets[0]!.version).toBe(2);
    expect(view.view.assets[0]!.sourceDigest).toBe(ALPHA);
    expect(view.view.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    ctx.svc.dispose();
  });

  it('reports a missing blob and fails the read closed (workspace.md §13.5)', () => {
    ctx = setup();
    rmSync(blobPath(ctx, BETA));
    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_B, version: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('blob_missing');
      expect(r.error.sourceDigest).toBe(BETA);
    }
    const integrity = ctx.svc.contentIntegrity(PROJECT_ID);
    if (!integrity.ok) throw new Error('integrity failed');
    expect(integrity.summary.missing).toBeGreaterThanOrEqual(1);
    // The project still opens, queries and loads — a missing blob never blocks.
    const q = ctx.svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean };
    expect(q.ok).toBe(true);
    ctx.svc.dispose();
  });

  it('detects and retains a tampered blob (fixture blob-tamper-detected)', () => {
    ctx = setup();
    const tampered = new TextEncoder().encode('tampered bytes, same name\n');
    writeFileSync(blobPath(ctx, ALPHA), tampered);
    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_A, version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('blob_corrupt');
    // The tampered bytes are retained byte-for-byte (never auto-repaired).
    expect(Array.from(fileBytes(blobPath(ctx, ALPHA)))).toEqual(Array.from(tampered));
    const integrity = ctx.svc.contentIntegrity(PROJECT_ID);
    if (!integrity.ok) throw new Error('integrity failed');
    expect(integrity.summary.corrupt).toBeGreaterThanOrEqual(1);
    ctx.svc.dispose();
  });

  it('reports orphan blobs as harmless (no GC; retained + counted only)', () => {
    ctx = setup();
    const orphan = new TextEncoder().encode('orphan, unreferenced\n');
    const orphanDigest = sha256Hex(orphan);
    writeFileSync(blobPath(ctx, orphanDigest), orphan);
    const integrity = ctx.svc.contentIntegrity(PROJECT_ID);
    if (!integrity.ok) throw new Error('integrity failed');
    expect(integrity.summary.orphanBlobs).toBe(1);
    // Harmless: a read of a catalog version still succeeds.
    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_A, version: 2 });
    expect(r.ok).toBe(true);
    expect(existsSync(blobPath(ctx, orphanDigest))).toBe(true);
    ctx.svc.dispose();
  });

  it('refuses a symlinked sources/ path with path_rejected (never followed)', () => {
    ctx = setup();
    rmSync(join(ctx.dir, 'sources'), { recursive: true, force: true });
    const outside = join(ctx.root, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(ctx.dir, 'sources'));
    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_A, version: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('path_rejected');
    ctx.svc.dispose();
  });

  it('captureContentView is unavailable for an M1 (storageVersion 1) project', () => {
    const root = makeRoot('m2store-v1');
    seedProject(root, join(FIXTURES, 'scenarios', '01-retry-lost-ack', 'disk-before'), 'demo-0001');
    const svc = openWorkspaceService({ root });
    const r = svc.captureContentView('demo-0001');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('project_unavailable');
      expect(ef(r.error)['reason']).toBe('version_combination_unsupported');
    }
    svc.dispose();
  });
});

describe('packet 23 — staging and immutable blob publication (workspace.md §7.6/§13.2)', () => {
  it('stages, publishes a new immutable blob, is idempotent and never overwrites', () => {
    ctx = setup();
    const bytes = new TextEncoder().encode('a brand new source blob\n');
    const digest = sha256Hex(bytes);
    const st = ctx.svc.stageContent(PROJECT_ID, { stageId: 'stg-new01', bytes, displayName: 'New Source' });
    if (!st.ok) throw new Error(`stage failed: ${JSON.stringify(st)}`);
    expect(st.digest).toBe(digest);
    expect(st.byteLength).toBe(bytes.length);

    const pub = ctx.svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'stage', stageId: 'stg-new01' } });
    if (!pub.ok) throw new Error(`publish failed: ${JSON.stringify(pub)}`);
    expect(pub.published).toBe(true);
    expect(pub.alreadyPresent).toBe(false);
    expect(sha256Hex(fileBytes(blobPath(ctx, digest)))).toBe(digest);

    // A retry is idempotent: the existing content-addressed path is verified,
    // never rewritten.
    const again = ctx.svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'bytes', bytes } });
    if (!again.ok) throw new Error('retry failed');
    expect(again.published).toBe(false);
    expect(again.alreadyPresent).toBe(true);

    // A named-but-mismatched digest is blob_corrupt, never a write.
    const mism = ctx.svc.publishBlob(PROJECT_ID, { digest: 'f'.repeat(64), byteLength: bytes.length, source: { kind: 'bytes', bytes } });
    expect(mism.ok).toBe(false);
    if (!mism.ok) expect(mism.error.code).toBe('blob_corrupt');

    // A foreign file already at a content-addressed path is detected as
    // corrupt and NOT overwritten by a publication of the right bytes.
    const other = new TextEncoder().encode('a different blob\n');
    const otherDigest = sha256Hex(other);
    writeFileSync(blobPath(ctx, otherDigest), new TextEncoder().encode('foreign bytes\n'));
    const foreign = ctx.svc.publishBlob(PROJECT_ID, { digest: otherDigest, byteLength: other.length, source: { kind: 'bytes', bytes: other } });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('blob_corrupt');
    expect(new TextDecoder().decode(fileBytes(blobPath(ctx, otherDigest)))).toBe('foreign bytes\n');
    ctx.svc.dispose();
  });

  it('BR-4: a harness edit under .thirdlight/staging/ is a supported path (no pause, digest recomputed from disk)', () => {
    ctx = setup();
    const first = new TextEncoder().encode('staged first bytes\n');
    const st = ctx.svc.stageContent(PROJECT_ID, { stageId: 'stg-harness01', bytes: first });
    expect(st.ok).toBe(true);
    const stagedPath = join(ctx.dir, '.thirdlight', 'staging', 'stg-harness01', 'source.bin');
    // The harness (or an operator) edits the staged file directly while this
    // backend owns the project.
    const edited = new TextEncoder().encode('harness-edited staged bytes\n');
    writeFileSync(stagedPath, edited);
    const editedDigest = sha256Hex(edited);

    const pub = ctx.svc.publishBlob(PROJECT_ID, { digest: editedDigest, byteLength: edited.length, source: { kind: 'stage', stageId: 'stg-harness01' } });
    if (!pub.ok) throw new Error(`publish failed: ${JSON.stringify(pub)}`);
    expect(pub.digest).toBe(editedDigest);
    expect(sha256Hex(fileBytes(blobPath(ctx, editedDigest)))).toBe(editedDigest);

    // No pause, no recovery snapshot, no external-change error.
    const q = ctx.svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; workspace: { writePaused: boolean } };
    expect(q.ok).toBe(true);
    expect(q.workspace.writePaused).toBe(false);
    const recovery = join(ctx.dir, '.thirdlight', 'recovery');
    expect(existsSync(recovery)).toBe(false);
    ctx.svc.dispose();
  });

  it('staging still works while an external change to the envelope is pending', () => {
    ctx = setup();
    // Open (claim) the project at revision 3 FIRST, then replace the envelope
    // with foreign but valid bytes: the next command's pre-write check
    // detects the modification (a fresh open would simply load revision 99).
    const opened = ctx.svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
    expect(opened.ok).toBe(true);
    expect(opened.revision).toBe(3);
    const envPath = join(ctx.dir, 'scenes', 'main.json');
    const doc = JSON.parse(readFileSync(envPath, 'utf8')) as Record<string, unknown>;
    (doc['scene'] as { revision: number }).revision = 99;
    writeFileSync(envPath, JSON.stringify(doc, null, 2) + '\n');
    const cmd = ctx.svc.runCommand({
      op: 'setTransform',
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'a'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { entityId: 'model-0001', transform: { position: [1, 0, 0] } },
    });
    expect(cmd.ok).toBe(false);
    if (!cmd.ok) expect(cmd.error.code).toBe('external_change_unresolved');

    // Staging writes still work (the pause never covers .thirdlight/**).
    const bytes = new TextEncoder().encode('staged during pause\n');
    const st = ctx.svc.stageContent(PROJECT_ID, { stageId: 'stg-pause01', bytes });
    expect(st.ok).toBe(true);
    if (st.ok) {
      const pub = ctx.svc.publishBlob(PROJECT_ID, { digest: st.digest, byteLength: bytes.length, source: { kind: 'stage', stageId: 'stg-pause01' } });
      expect(pub.ok).toBe(true);
    }
    ctx.svc.dispose();
  });

  it('fails closed past the stage TTL; an identical recorded retry replays without the stage', () => {
    ctx = setup();
    const bytes = new TextEncoder().encode('expiring staged bytes\n');
    const digest = sha256Hex(bytes);
    const st = ctx.svc.stageContent(PROJECT_ID, { stageId: 'stg-ttl01', bytes });
    if (!st.ok) throw new Error('stage failed');
    const pub = ctx.svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'stage', stageId: 'stg-ttl01' } });
    expect(pub.ok).toBe(true);

    // Publish an asset that references the blob (one revision consumed).
    const meta = fixtureRecipeMetrics(ASSET_A, 2);
    const pubArgs = {
      op: 'publishAsset' as const,
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'b'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: {
        mode: 'create',
        assetId: 'asset-00000000000000c3',
        displayName: 'Gamma',
        sourceDigest: digest,
        sourceByteLength: bytes.length,
        importRecipe: meta.importRecipe,
        metrics: meta.metrics,
        importedAt: '2026-09-18T12:00:00Z',
      },
    };
    const r1 = ctx.svc.runCommand(pubArgs);
    if (!r1.ok) throw new Error(`publishAsset failed: ${JSON.stringify(r1)}`);
    expect(r1.revision).toBe(4);

    // Advance the clock past the 3 600 s TTL and discard the stage.
    ctx.clock.value += 4_000_000;
    const gone = ctx.svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'stage', stageId: 'stg-ttl01' } });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.code).toBe('stage_expired');

    // The identical retry (same requestId) is served from the retry record at
    // pipeline step 2 — BEFORE any revision or stage lookup (workspace.md
    // §13.3.1 dedup-before-stage-lookup; commands.md §6.1 step 2).
    const r2 = ctx.svc.runCommand(pubArgs);
    if (!r2.ok) throw new Error('replay failed');
    expect(r2.duplicated).toBe(true);
    expect(r2.revision).toBe(4);
    ctx.svc.dispose();
  });

  it('a concurrent stale import never overwrites newer work (revision_conflict)', () => {
    ctx = setup();
    const meta = fixtureRecipeMetrics(ASSET_A, 2);
    // A second, stale client (expectedRevision 3) after the first advanced to 4.
    const r1 = ctx.svc.runCommand({
      op: 'publishAsset',
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'c'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { mode: 'reimport', assetId: ASSET_B, displayName: 'Beta v2', sourceDigest: ALPHA, sourceByteLength: 28, importRecipe: meta.importRecipe, metrics: meta.metrics, importedAt: '2026-09-18T12:00:00Z' },
    });
    if (!r1.ok) throw new Error('first publish failed');
    const r2 = ctx.svc.runCommand({
      op: 'publishAsset',
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'd'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { mode: 'reimport', assetId: ASSET_B, displayName: 'Beta v3', sourceDigest: BETA, sourceByteLength: 27, importRecipe: meta.importRecipe, metrics: meta.metrics, importedAt: '2026-09-18T12:00:00Z' },
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe('revision_conflict');
      expect(r2.error.currentRevision).toBe(4);
    }
    // The newer catalog is intact: asset B's current version is 2 (the first
    // publish). The blob read proves the referenced bytes are untouched.
    const rb = ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_B, version: 2 });
    expect(rb.ok).toBe(true);
    ctx.svc.dispose();
  });

  it('dedup precedes revision checks and survives a release/reopen (retry + play pins readable)', () => {
    ctx = setup();
    const meta = fixtureRecipeMetrics(ASSET_A, 2);
    const req = {
      op: 'publishAsset' as const,
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'e'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { mode: 'reimport', assetId: ASSET_A, displayName: 'Alpha v3', sourceDigest: BETA, sourceByteLength: 27, importRecipe: meta.importRecipe, metrics: meta.metrics, importedAt: '2026-09-18T12:00:00Z' },
    };
    const r1 = ctx.svc.runCommand(req);
    if (!r1.ok) throw new Error('publish failed');
    expect(r1.revision).toBe(4);

    // The new version is readable while it is the catalog's current version.
    const v3 = ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_A, version: 3 });
    expect(v3.ok).toBe(true);

    // Undo removes the appended version from the catalog (the recorded
    // inverse restores the previous record) — but the bytes are retained
    // (M2 has no GC) and the removed version is simply not addressable.
    const undo = ctx.svc.runCommand({
      op: 'undo',
      projectId: PROJECT_ID,
      expectedRevision: 4,
      requestId: 'req-' + 'f'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: {},
    });
    if (!undo.ok) throw new Error('undo failed');
    expect(undo.revision).toBe(5);
    const v3AfterUndo = ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_A, version: 3 });
    expect(v3AfterUndo.ok).toBe(false);
    if (!v3AfterUndo.ok) expect(v3AfterUndo.error.code).toBe('asset_version_not_found');
    // The bytes remain on disk, retained (never deleted).
    expect(sha256Hex(fileBytes(blobPath(ctx, BETA)))).toBe(BETA);

    // Redo reapplies the exact recorded next record: the version is
    // addressable again and its bytes verify.
    const redo = ctx.svc.runCommand({
      op: 'redo',
      projectId: PROJECT_ID,
      expectedRevision: 5,
      requestId: 'req-' + '0'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: {},
    });
    if (!redo.ok) throw new Error('redo failed');
    expect(redo.revision).toBe(6);
    expect(ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_A, version: 3 }).ok).toBe(true);

    // Release + reopen: every play pin (the current catalog version's bytes)
    // is still readable after a restart.
    const rel = ctx.svc.releaseWorkspace(PROJECT_ID);
    if (!rel.ok) throw new Error(`release failed: ${JSON.stringify(rel)}`);
    expect(rel.retryCleared).toBe(true);
    const svc2 = reopen(ctx);
    // After release the retry record is gone → the retry now re-executes
    // against the released state and fails the revision check safely
    // (a lost-ack retry can never replay across a release boundary, §9).
    const replay = svc2.runCommand(req);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('revision_conflict');
    const afterV3 = svc2.readBlob(PROJECT_ID, { assetId: ASSET_A, version: 3 });
    if (!afterV3.ok) throw new Error('after restart: ' + JSON.stringify(afterV3));
    expect(afterV3.digest).toBe(BETA);
    svc2.dispose();
  });

  it('refuses behavior source publication structurally (packet-33 preparer unavailable)', () => {
    ctx = setup();
    const r = ctx.svc.runCommand({
      op: 'publishBehavior',
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + '1'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: {
        behaviorId: 'behavior-00000000000000d4',
        displayName: 'Test',
        mode: 'source',
        declaration: { properties: [] },
        // A well-formed source object: the structural refusal is now the
        // preparer gate (no compiler is injected in this workspace), not the
        // args schema (packet 33 validates the supplied digest/length).
        source: { sourceDigest: ALPHA, sourceByteLength: 677 },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('behavior_publication_unavailable');
      expect(ef(r.error)['reason']).toBe('preparer_unavailable');
    }
    ctx.svc.dispose();
  });
});

describe('packet 23 — quota and write faults (workspace.md §13.4 F7/F8)', () => {
  it('fails a publication with content_quota_exceeded (project quota) before writing', () => {
    ctx = setup({ maxSourceBytesPerProject: 10 });
    const bytes = new TextEncoder().encode('bigger than the tiny quota\n');
    const digest = sha256Hex(bytes);
    const st = ctx.svc.stageContent(PROJECT_ID, { stageId: 'stg-quota01', bytes });
    if (!st.ok) throw new Error('stage failed');
    const pub = ctx.svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'stage', stageId: 'stg-quota01' } });
    expect(pub.ok).toBe(false);
    if (!pub.ok) {
      expect(pub.error.code).toBe('content_quota_exceeded');
      expect(ef(pub.error)['kind']).toBe('project_quota');
    }
    expect(existsSync(blobPath(ctx, digest))).toBe(false);
    ctx.svc.dispose();
  });

  it('fails with content_quota_exceeded (device space) when the reserve cannot be met', () => {
    ctx = setup({ freeSpaceBytes: () => 1024 });
    const bytes = new TextEncoder().encode('device space case\n');
    const digest = sha256Hex(bytes);
    const pub = ctx.svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'bytes', bytes } });
    expect(pub.ok).toBe(false);
    if (!pub.ok) {
      expect(pub.error.code).toBe('content_quota_exceeded');
      expect(ef(pub.error)['kind']).toBe('device_space');
    }
    expect(existsSync(blobPath(ctx, digest))).toBe(false);
    ctx.svc.dispose();
  });

  it('maps an ENOSPC during blob publication to content_publish_failed with the envelope unchanged', () => {
    const root = makeRoot('m2store-enospc');
    seedProject(root, join(STORAGE, 'project'), PROJECT_ID);
    const dir = join(root, 'projects', PROJECT_ID);
    mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
    const envPath = join(dir, 'scenes', 'main.json');
    const before = fileBytes(envPath);
    const svc = openWorkspaceService({
      root,
      ops: {
        ...defaultOpsForTest(),
        openTempFile: (p: string) => {
          if (p.includes(join('sources', 'sha256'))) {
            const e = new Error('ENOSPC') as Error & { code?: string };
            e.code = 'ENOSPC';
            throw e;
          }
          return defaultOpsForTest().openTempFile(p);
        },
      },
    });
    const bytes = new TextEncoder().encode('enospc blob\n');
    const digest = sha256Hex(bytes);
    const st = svc.stageContent(PROJECT_ID, { stageId: 'stg-enospc1', bytes });
    expect(st.ok).toBe(true);
    const pub = svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'stage', stageId: 'stg-enospc1' } });
    expect(pub.ok).toBe(false);
    if (!pub.ok) {
      expect(pub.error.code).toBe('content_publish_failed');
      expect(ef(pub.error)['reason']).toBe('write');
      expect(ef(pub.error)['onDiskState']).toBe('previous');
    }
    expect(Array.from(fileBytes(envPath))).toEqual(Array.from(before));
    expect(existsSync(join(dir, 'sources', 'sha256', digest))).toBe(false);
    svc.dispose();
  });

  it('rejects a second owner (ownership_conflict) for content operations', () => {
    ctx = setup();
    const q = ctx.svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean };
    expect(q.ok).toBe(true);
    const other = openOther(ctx, 'tb-00000000000000000000000000000002');
    const st = other.stageContent(PROJECT_ID, { stageId: 'stg-owner01', bytes: new TextEncoder().encode('x') });
    expect(st.ok).toBe(false);
    if (!st.ok) {
      expect(st.error.code).toBe('project_unavailable');
      expect(ef(st.error)['reason']).toBe('ownership_conflict');
    }
    other.dispose();
    ctx.svc.dispose();
  });
});

describe('packet 23 — derived caches are regenerable and never authoritative (workspace.md §13.6)', () => {
  it('writes, reads, deletes and re-reads a derived import without touching the envelope', () => {
    ctx = setup();
    const envPath = join(ctx.dir, 'scenes', 'main.json');
    const before = fileBytes(envPath);
    const importJson = new TextEncoder().encode(JSON.stringify({ nodes: ['a'] }, null, 2) + '\n');
    const w = writeDerivedImport(
      { ops: defaultOpsForTest() },
      { projectId: PROJECT_ID, dir: ctx.dir, thirdlightDir: join(ctx.dir, '.thirdlight'), storageVersion: 2, revision: 3, scene: null, content: null },
      ALPHA,
      'r'.repeat(64),
      importJson,
    );
    if (!w.ok) throw new Error('derived write failed');
    expect(w.path).toBe(join(derivedCachePath(join(ctx.dir, '.thirdlight'), ALPHA, 'r'.repeat(64)), 'import.json'));
    const read = readDerivedImport(join(ctx.dir, '.thirdlight'), ALPHA, 'r'.repeat(64));
    if (!read.ok) throw new Error('derived read failed');
    expect(Array.from(read.bytes)).toEqual(Array.from(importJson));
    // The envelope was not written (non-authoritative).
    expect(Array.from(fileBytes(envPath))).toEqual(Array.from(before));

    // Deleting the cache is harmless; the read reports derived_cache_unavailable.
    rmSync(join(ctx.dir, '.thirdlight', 'derived'), { recursive: true, force: true });
    const gone = readDerivedImport(join(ctx.dir, '.thirdlight'), ALPHA, 'r'.repeat(64));
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.code).toBe('derived_cache_unavailable');
    // The project state is unaffected.
    const q = ctx.svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(3);
    ctx.svc.dispose();
  });
});

describe('packet 23 — v2 envelope compatibility (workspace.md §4.5)', () => {
  it('reports storage_version_unsupported for an unknown version and content_invalid for a bad content block', () => {
    const root = makeRoot('m2store-ver');
    seedProject(root, join(STORAGE, 'project'), PROJECT_ID);
    const envPath = join(root, 'projects', PROJECT_ID, 'scenes', 'main.json');
    const good = JSON.parse(readFileSync(envPath, 'utf8')) as Record<string, unknown>;

    // The blocked session re-runs the load on every access, so one service can
    // observe both failures after the operator edits the file by hand.
    // Packet 46: M3 knows storageVersion [1,2,3] (workspace.md §16.2), so the
    // unknown-version probe uses 4 — the accepted unknown-version rule is
    // unchanged, only the known set grew by the v3 row.
    const svc = openWorkspaceService({ root });
    const unknown = { ...good, storageVersion: 4 };
    writeFileSync(envPath, JSON.stringify(unknown, null, 2) + '\n');
    const q1 = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; error?: { reason?: string } };
    expect(q1.ok).toBe(false);
    expect(q1.error?.reason).toBe('storage_version_unsupported');

    // A known v3 storageVersion with a v2 scene is the §16.2 combination
    // refusal (single error, deeper checks stop), not an unknown version.
    const v3Combo = { ...good, storageVersion: 3 };
    writeFileSync(envPath, JSON.stringify(v3Combo, null, 2) + '\n');
    const qCombo = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; error?: { reason?: string } };
    expect(qCombo.ok).toBe(false);
    expect(qCombo.error?.reason).toBe('version_combination_unsupported');

    const badContent = structuredClone(good) as { content: { assets: { displayName: string }[] } };
    badContent.content.assets[0]!.displayName = '';
    writeFileSync(envPath, JSON.stringify(badContent, null, 2) + '\n');
    const q2 = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; error?: { reason?: string } };
    expect(q2.ok).toBe(false);
    expect(q2.error?.reason).toBe('content_invalid');
    // The bytes are retained untouched.
    expect(JSON.parse(readFileSync(envPath, 'utf8')).content.assets[0].displayName).toBe('');
    svc.dispose();
  });
});

/** The real write ops (the ENOSPC test delegates non-blob opens to them). */
function defaultOpsForTest() {
  return defaultWriteOps;
}

describe('packet 23 — fixture index and staging faults', () => {
  it('the storage fixture index hashes every committed fixture byte-exactly', () => {
    const index = JSON.parse(readFileSync(join(STORAGE, 'expected.json'), 'utf8')) as {
      fixtureFiles: { path: string; sha256: string; byteLength: number }[];
      caseStatus: { case: string; status: string }[];
    };
    expect(index.fixtureFiles.length).toBeGreaterThanOrEqual(4);
    for (const f of index.fixtureFiles) {
      const bytes = fileBytes(join(STORAGE, f.path));
      expect(sha256Hex(bytes), f.path).toBe(f.sha256);
      expect(bytes.length, f.path).toBe(f.byteLength);
    }
    // Every accepted contract case is classified executed/declarative.
    expect(index.caseStatus.length).toBeGreaterThanOrEqual(16);
    expect(index.caseStatus.every((c) => ['executed', 'declarative'].includes(c.status))).toBe(true);
  });

  it('reports stage_not_found for an unknown stage and discards a stage', () => {
    ctx = setup();
    const missing = ctx.svc.publishBlob(PROJECT_ID, { digest: ALPHA, byteLength: 28, source: { kind: 'stage', stageId: 'stg-absent1' } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('stage_not_found');

    const bytes = new TextEncoder().encode('discard me\n');
    const st = ctx.svc.stageContent(PROJECT_ID, { stageId: 'stg-discard1', bytes });
    expect(st.ok).toBe(true);
    const d = ctx.svc.discardStage(PROJECT_ID, 'stg-discard1');
    expect(d.ok).toBe(true);
    const d2 = ctx.svc.discardStage(PROJECT_ID, 'stg-discard1');
    expect(d2.ok).toBe(false);
    if (!d2.ok) expect(d2.error.code).toBe('stage_not_found');
    ctx.svc.dispose();
  });

  it('maps an fsync failure during blob publication to content_publish_failed (envelope unchanged)', () => {
    const root = makeRoot('m2store-fsync');
    seedProject(root, join(STORAGE, 'project'), PROJECT_ID);
    const dir = join(root, 'projects', PROJECT_ID);
    mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
    const envPath = join(dir, 'scenes', 'main.json');
    const before = fileBytes(envPath);
    // Claim (open) the project successfully first; only then inject the fsync
    // failure so the blob publication is the failing phase.
    let failFsync = false;
    const svc = openWorkspaceService({
      root,
      ops: {
        ...defaultOpsForTest(),
        fsyncFile: (fd: number) => {
          if (failFsync) {
            const e = new Error('EIO') as Error & { code?: string };
            e.code = 'EIO';
            throw e;
          }
          defaultOpsForTest().fsyncFile(fd);
        },
      },
    });
    const opened = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean };
    expect(opened.ok).toBe(true);
    failFsync = true;
    const bytes = new TextEncoder().encode('fsync failure blob\n');
    const digest = sha256Hex(bytes);
    const pub = svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'bytes', bytes } });
    expect(pub.ok).toBe(false);
    if (!pub.ok) {
      expect(pub.error.code).toBe('content_publish_failed');
      expect(ef(pub.error)['reason']).toBe('write');
    }
    expect(Array.from(fileBytes(envPath))).toEqual(Array.from(before));
    expect(existsSync(join(dir, 'sources', 'sha256', digest))).toBe(false);
    svc.dispose();
  });
});

describe('packet 23 — accepted M2 envelope fixtures', () => {
  const M2_ENVELOPE = join(REPO_ROOT, 'fixtures', 'm2', 'contracts', 'envelope');
  const M2_EXPECTED = JSON.parse(
    readFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'contracts', 'expected.json'), 'utf8'),
  ) as { entries: { path: string; kind: string; valid: boolean; code?: string; projectId?: string }[] };

  it('rebuilds every valid v2 envelope byte-identically', async () => {
    const { buildEnvelopeBytesV2, validateEnvelope } = await import('../src/envelope');
    const valid = M2_EXPECTED.entries.filter((e) => e.kind === 'envelope' && e.valid);
    expect(valid.length).toBeGreaterThanOrEqual(2);
    for (const e of valid) {
      const bytes = fileBytes(join(REPO_ROOT, 'fixtures', 'm2', 'contracts', e.path));
      const res = validateEnvelope(bytes, e.projectId!);
      expect(res.ok, e.path).toBe(true);
      if (!res.ok) continue;
      expect(res.storageVersion).toBe(2);
      const rebuilt = buildEnvelopeBytesV2(e.projectId!, res.scene, res.content!, res.records);
      expect(Array.from(rebuilt), e.path).toEqual(Array.from(bytes));
    }
  });

  it('reports the declared reason for every invalid v2 envelope fixture', async () => {
    const { validateEnvelope } = await import('../src/envelope');
    // `asset-reference-missing` is a cross-block failure: scene and content
    // are individually valid, so the envelope loader alone accepts it (the
    // session loader's step-6e check is covered by the open test below).
    const invalid = M2_EXPECTED.entries.filter(
      (e) => e.kind === 'envelope' && !e.valid && e.code !== 'asset_reference_missing',
    );
    expect(invalid.length).toBeGreaterThanOrEqual(9);
    for (const e of invalid) {
      // The envelope document's own projectId (the directory-name equality is
      // a load-time check; the fixtures are standalone documents).
      const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'contracts', e.path), 'utf8')) as { projectId?: string };
      const bytes = fileBytes(join(REPO_ROOT, 'fixtures', 'm2', 'contracts', e.path));
      const res = validateEnvelope(bytes, raw.projectId ?? 'demo-0002');
      expect(res.ok, `${e.path} should fail`).toBe(false);
      if (res.ok) continue;
      // Packet 46: the M2 fixture `storage-version-3.json` was generated when
      // `storageVersion` 3 was unknown (the M2 declaration is
      // `storage_version_unsupported`). M3 knows [1,2,3] (workspace.md
      // §16.2), so this document now reaches the §16.2 combination check and
      // is refused as `version_combination_unsupported`. The fixture bytes are
      // unchanged; only the declared M2-era expectation is superseded by the
      // promoted M3 contract.
      const expectedReason =
        e.path === 'envelope/invalid/storage-version-3.json' ? 'version_combination_unsupported' : e.code;
      expect(res.reason, e.path).toBe(expectedReason);
    }
  });

  it('fails a v2 envelope with a dangling model reference as asset_reference_missing at open', () => {
    const root = makeRoot('m2store-ref');
    const dir = join(root, 'projects', 'demo-0002');
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          engineVersion: '0.1.0',
          id: 'demo-0002',
          name: 'Reference Demo',
          createdAt: '2026-09-18T12:00:00Z',
          scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(
      join(dir, 'scenes', 'main.json'),
      fileBytes(join(M2_ENVELOPE, 'invalid', 'asset-reference-missing.json')),
    );
    const svc = openWorkspaceService({ root });
    const q = svc.query({ op: 'queryProject', projectId: 'demo-0002' }) as { ok: boolean; error?: { reason?: string } };
    expect(q.ok).toBe(false);
    expect(q.error?.reason).toBe('asset_reference_missing');
    svc.dispose();
  });
});

describe('packet 23 — external change on a v2 envelope (workspace.md §7)', () => {
  function makePending(c: Ctx): void {
    const opened = c.svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean };
    expect(opened.ok).toBe(true);
    const envPath = join(c.dir, 'scenes', 'main.json');
    const doc = JSON.parse(readFileSync(envPath, 'utf8')) as Record<string, unknown>;
    (doc['scene'] as { revision: number }).revision = 99;
    writeFileSync(envPath, JSON.stringify(doc, null, 2) + '\n');
    const cmd = c.svc.runCommand({
      op: 'setTransform',
      projectId: PROJECT_ID,
      expectedRevision: 3,
      requestId: 'req-' + 'a'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { entityId: 'model-0001', transform: { position: [1, 0, 0] } },
    });
    expect(cmd.ok).toBe(false);
    if (!cmd.ok) expect(cmd.error.code).toBe('external_change_unresolved');
  }

  it('acceptExternalState rewrites the v2 envelope (content preserved) and unpauses', () => {
    ctx = setup();
    makePending(ctx);
    const acc = ctx.svc.acceptExternalState(PROJECT_ID);
    if (!acc.ok) throw new Error('accept failed: ' + JSON.stringify(acc));
    expect(acc.revision).toBe(99);
    expect(acc.historyReset).toBe(true);
    const q = ctx.svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number; workspace: { writePaused: boolean } };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(99);
    expect(q.workspace.writePaused).toBe(false);
    // The rewritten envelope is a v2 envelope carrying the content block.
    const disk = JSON.parse(readFileSync(join(ctx.dir, 'scenes', 'main.json'), 'utf8')) as { storageVersion: number; content: { assets: unknown[] }; retry: { records: unknown[] } };
    expect(disk.storageVersion).toBe(2);
    expect(disk.content.assets.length).toBe(2);
    expect(disk.retry.records).toEqual([]);
    // Content is still addressable.
    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: ASSET_A, version: 2 });
    expect(r.ok).toBe(true);
    ctx.svc.dispose();
  });

  it('discardExternalState restores the v2 last-known-good envelope and unpauses', () => {
    ctx = setup();
    makePending(ctx);
    const disc = ctx.svc.discardExternalState(PROJECT_ID);
    if (!disc.ok) throw new Error('discard failed: ' + JSON.stringify(disc));
    expect(disc.revision).toBe(3);
    expect(disc.historyReset).toBe(true);
    const q = ctx.svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number; workspace: { writePaused: boolean } };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(3);
    expect(q.workspace.writePaused).toBe(false);
    const disk = JSON.parse(readFileSync(join(ctx.dir, 'scenes', 'main.json'), 'utf8')) as { storageVersion: number; scene: { revision: number } };
    expect(disk.storageVersion).toBe(2);
    expect(disk.scene.revision).toBe(3);
    ctx.svc.dispose();
  });
});
