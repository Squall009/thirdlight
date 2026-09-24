/**
 * Content storage on the real filesystem (workspace.md §7.6, §11, §13;
 * project-model §19), ported from the packet-23 storage v2 tests
 * (archive/removed-v1-v2/workspace/m2-storage.test.ts) to storage v4 in
 * phase 9.3 step B.
 *
 * Every test uses a disposable data root on ext4 (/home/dadmin/.tl07-tmp-*),
 * seeds the committed storage v3 media project (a model and an audio asset,
 * fixtures/m3/contracts/envelope/valid/demo-0003-media-v3.json, revision 5)
 * with its source blobs under `sources/sha256/`, and drives the real
 * `@thirdlight/workspace` service, which upgrades it to storage v4 on open.
 * Nothing is mocked where the contract requires real filesystem behavior;
 * only the quota/clock/write-op seams are injected.
 *
 * Not ported (removed with the v1/v2 code): `captureContentView` (the
 * closure over referenced assets is built by the exporter from
 * `readCapturedV3`), the M2 envelope fixture rebuild/refusal cases, the v2
 * envelope accept/discard rewrite (the v4 content.json accept/discard is in
 * m3-storage.test.ts).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService, type WorkspaceService, type WorkspaceServiceConfig } from '@thirdlight/workspace';
import { defaultOps as defaultWriteOps } from '../src/write';
import { derivedCachePath, readDerivedImport, writeDerivedImport } from '../src/content-store';

import { REPO_ROOT, fileBytes, makeRoot, seedV3Project, sha256Hex } from './helpers';

const CONTRACTS = join(REPO_ROOT, 'fixtures', 'm3', 'contracts');
const MEDIA = join(CONTRACTS, 'envelope', 'valid', 'demo-0003-media-v3.json');
const PROJECT_ID = 'demo-0003';
const MODEL = 'asset-model-courier';
const AUDIO = 'asset-audio-cue-start';
const COURIER_BYTES = fileBytes(join(CONTRACTS, 'source-preimages', 'courier.glb'));
const WAV_BYTES = fileBytes(join(CONTRACTS, 'source-preimages', 'cue-start.wav'));
const COURIER = sha256Hex(COURIER_BYTES);
const WAV = sha256Hex(WAV_BYTES);
/** The media project's revision (every command below starts from it). */
const REV = 5;

const ENVELOPE = JSON.parse(readFileSync(MEDIA, 'utf8')) as {
  content: { assets: { assetId: string; versions: { version: number; importRecipe: unknown; metrics: unknown }[] }[] };
};

/** The recorded import recipe and metrics of one catalog version. */
function recipeMetrics(assetId: string, version: number) {
  const rec = ENVELOPE.content.assets.find((a) => a.assetId === assetId)!;
  const v = rec.versions.find((x) => x.version === version)!;
  return { importRecipe: v.importRecipe, metrics: v.metrics };
}

/** A `publishAsset` create of a new model asset over published bytes. */
function createModel(n: string, expectedRevision: number, assetId: string, digest: string, byteLength: number) {
  const meta = recipeMetrics(MODEL, 1);
  return {
    op: 'publishAsset' as const,
    projectId: PROJECT_ID,
    expectedRevision,
    requestId: 'req-' + n.repeat(32),
    origin: { kind: 'mcp', clientId: 'pi' },
    args: {
      mode: 'create',
      kind: 'model',
      assetId,
      displayName: assetId,
      sourceDigest: digest,
      sourceByteLength: byteLength,
      importRecipe: meta.importRecipe,
      metrics: meta.metrics,
      importedAt: '2026-09-18T12:00:00Z',
    },
  };
}

interface Ctx {
  root: string;
  dir: string;
  svc: WorkspaceService;
  clock: { value: number };
}

/** Seed the media project and its blobs (no service). */
function seed(tag: string): { root: string; dir: string } {
  const root = makeRoot(tag);
  const dir = seedV3Project(root, PROJECT_ID, fileBytes(MEDIA));
  mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
  writeFileSync(join(dir, 'sources', 'sha256', COURIER), COURIER_BYTES);
  writeFileSync(join(dir, 'sources', 'sha256', WAV), WAV_BYTES);
  return { root, dir };
}

function setup(extra: Partial<WorkspaceServiceConfig> = {}): Ctx {
  const { root, dir } = seed('content-store');
  const clock = { value: Date.now() };
  const svc = openWorkspaceService({ root, now: () => clock.value, ...extra });
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

/** Loose access to contract fields not on the CommandError interface. */
function ef(e: unknown): Record<string, unknown> {
  return e as Record<string, unknown>;
}

function blobPath(c: { dir: string }, digest: string): string {
  return join(c.dir, 'sources', 'sha256', digest);
}

function queryRevision(svc: WorkspaceService): number {
  const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
  expect(q.ok, JSON.stringify(q)).toBe(true);
  return q.revision;
}

let ctx: Ctx;

describe('blob reads and integrity (workspace.md §13)', () => {
  it('opens the upgraded project and reads verified bytes; integrity covers every catalog version', () => {
    ctx = setup();
    expect(queryRevision(ctx.svc)).toBe(REV);
    expect(existsSync(join(ctx.dir, 'content.json'))).toBe(true);

    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: MODEL, version: 1 });
    if (!r.ok) throw new Error(`readBlob failed: ${JSON.stringify(r)}`);
    expect(r.digest).toBe(COURIER);
    expect(r.verified).toBe(true);
    expect(r.bytes.length).toBe(47);
    expect(sha256Hex(r.bytes)).toBe(COURIER);
    const a = ctx.svc.readBlob(PROJECT_ID, { assetId: AUDIO, version: 1 });
    if (!a.ok) throw new Error(`readBlob failed: ${JSON.stringify(a)}`);
    expect(a.digest).toBe(WAV);

    const integrity = ctx.svc.contentIntegrity(PROJECT_ID);
    if (!integrity.ok) throw new Error('integrity failed');
    expect(integrity.summary).toMatchObject({ total: 2, ok: 2, missing: 0, corrupt: 0, orphanBlobs: 0 });
    expect(integrity.entries.find((e) => e.assetId === MODEL && e.version === 1)!.referenced).toBe(true);

    // An unknown asset/version is the accepted not-found error, never a read.
    const noAsset = ctx.svc.readBlob(PROJECT_ID, { assetId: 'asset-nope', version: 1 });
    expect(noAsset.ok).toBe(false);
    if (!noAsset.ok) expect(noAsset.error.code).toBe('asset_not_found');
    const noVersion = ctx.svc.readBlob(PROJECT_ID, { assetId: MODEL, version: 2 });
    expect(noVersion.ok).toBe(false);
    if (!noVersion.ok) expect(noVersion.error.code).toBe('asset_version_not_found');
    ctx.svc.dispose();
  });

  it('reports a missing blob and fails the read closed (workspace.md §13.5)', () => {
    ctx = setup();
    rmSync(blobPath(ctx, WAV));
    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: AUDIO, version: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('blob_missing');
      expect(r.error.sourceDigest).toBe(WAV);
    }
    const integrity = ctx.svc.contentIntegrity(PROJECT_ID);
    if (!integrity.ok) throw new Error('integrity failed');
    expect(integrity.summary).toMatchObject({ total: 2, ok: 1, missing: 1 });
    // The project still opens, queries and loads — a missing blob never blocks.
    expect(queryRevision(ctx.svc)).toBe(REV);
    ctx.svc.dispose();
  });

  it('detects and retains a tampered blob', () => {
    ctx = setup();
    const tampered = new TextEncoder().encode('tampered bytes, same name\n');
    writeFileSync(blobPath(ctx, COURIER), tampered);
    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: MODEL, version: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('blob_corrupt');
    // The tampered bytes are retained byte-for-byte (never auto-repaired).
    expect(Array.from(fileBytes(blobPath(ctx, COURIER)))).toEqual(Array.from(tampered));
    const integrity = ctx.svc.contentIntegrity(PROJECT_ID);
    if (!integrity.ok) throw new Error('integrity failed');
    expect(integrity.summary).toMatchObject({ total: 2, ok: 1, corrupt: 1 });
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
    expect(ctx.svc.readBlob(PROJECT_ID, { assetId: MODEL, version: 1 }).ok).toBe(true);
    expect(existsSync(blobPath(ctx, orphanDigest))).toBe(true);
    ctx.svc.dispose();
  });

  it('refuses a symlinked sources/ path with path_rejected (never followed)', () => {
    ctx = setup();
    const outside = join(ctx.root, 'outside');
    mkdirSync(join(outside, 'sha256'), { recursive: true });
    // The same bytes outside: only the symlink makes the read wrong.
    copyFileSync(blobPath(ctx, COURIER), join(outside, 'sha256', COURIER));
    rmSync(join(ctx.dir, 'sources'), { recursive: true, force: true });
    symlinkSync(outside, join(ctx.dir, 'sources'));
    const r = ctx.svc.readBlob(PROJECT_ID, { assetId: MODEL, version: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('path_rejected');
    ctx.svc.dispose();
  });
});

describe('staging and immutable blob publication (workspace.md §7.6/§13.2)', () => {
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
    expect(existsSync(blobPath(ctx, 'f'.repeat(64)))).toBe(false);

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
    expect(existsSync(recovery) ? readdirSync(recovery) : []).toEqual([]);
    ctx.svc.dispose();
  });

  it('staging still works while an external change to content.json is pending', () => {
    ctx = setup();
    // Open (claim) the project FIRST, then replace content.json with foreign
    // but valid bytes: the next command that writes content.json detects it
    // in its pre-write check (v4 checks the files a transaction writes).
    expect(queryRevision(ctx.svc)).toBe(REV);
    const contentPath = join(ctx.dir, 'content.json');
    const doc = JSON.parse(readFileSync(contentPath, 'utf8')) as { content: { game: { title: string } } };
    doc.content.game.title = 'Hand edited';
    writeFileSync(contentPath, JSON.stringify(doc, null, 2) + '\n');
    const cmd = ctx.svc.runCommand({
      op: 'setGameConfig',
      projectId: PROJECT_ID,
      expectedRevision: REV,
      requestId: 'req-' + 'a'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: { game: { title: 'Nope' } },
    });
    expect(cmd.ok).toBe(false);
    if (!cmd.ok) expect(cmd.error.code).toBe('external_change_unresolved');

    // Staging writes still work (the pause never covers .thirdlight/**).
    const bytes = new TextEncoder().encode('staged during pause\n');
    const st = ctx.svc.stageContent(PROJECT_ID, { stageId: 'stg-pause01', bytes });
    expect(st.ok, JSON.stringify(st)).toBe(true);
    if (st.ok) {
      const pub = ctx.svc.publishBlob(PROJECT_ID, { digest: st.digest, byteLength: bytes.length, source: { kind: 'stage', stageId: 'stg-pause01' } });
      expect(pub.ok, JSON.stringify(pub)).toBe(true);
      expect(existsSync(blobPath(ctx, st.digest))).toBe(true);
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
    const pubArgs = createModel('b', REV, 'asset-model-gamma', digest, bytes.length);
    const r1 = ctx.svc.runCommand(pubArgs);
    if (!r1.ok) throw new Error(`publishAsset failed: ${JSON.stringify(r1)}`);
    expect(r1.revision).toBe(REV + 1);
    // The retry record lives in content.json (the file the transaction wrote).
    const onDisk = JSON.parse(readFileSync(join(ctx.dir, 'content.json'), 'utf8')) as { retry: { records: { requestId: string }[] } };
    expect(onDisk.retry.records.map((r) => r.requestId)).toContain(pubArgs.requestId);

    // Advance the clock past the 3 600 s TTL: the stage is gone.
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
    expect(r2.revision).toBe(REV + 1);
    ctx.svc.dispose();
  });

  it('a concurrent stale import never overwrites newer work (revision_conflict)', () => {
    ctx = setup();
    const b1 = new TextEncoder().encode('first import\n');
    const b2 = new TextEncoder().encode('second, stale import\n');
    for (const b of [b1, b2]) expect(ctx.svc.publishBlob(PROJECT_ID, { digest: sha256Hex(b), byteLength: b.length, source: { kind: 'bytes', bytes: b } }).ok).toBe(true);
    const r1 = ctx.svc.runCommand(createModel('c', REV, 'asset-model-first', sha256Hex(b1), b1.length));
    if (!r1.ok) throw new Error(`first publish failed: ${JSON.stringify(r1)}`);
    // A second, stale client (expectedRevision REV) after the first advanced.
    const r2 = ctx.svc.runCommand(createModel('d', REV, 'asset-model-second', sha256Hex(b2), b2.length));
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error.code).toBe('revision_conflict');
      expect(r2.error.currentRevision).toBe(REV + 1);
    }
    // The newer catalog is intact: the first import is readable, the stale
    // one was never recorded.
    expect(ctx.svc.readBlob(PROJECT_ID, { assetId: 'asset-model-first', version: 1 }).ok).toBe(true);
    const stale = ctx.svc.readBlob(PROJECT_ID, { assetId: 'asset-model-second', version: 1 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('asset_not_found');
    ctx.svc.dispose();
  });

  it('undo/redo of a publication, and dedup across a release/reopen (play pins stay readable)', () => {
    ctx = setup();
    const bytes = new TextEncoder().encode('gamma model bytes\n');
    const digest = sha256Hex(bytes);
    expect(ctx.svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'bytes', bytes } }).ok).toBe(true);
    const req = createModel('e', REV, 'asset-model-gamma', digest, bytes.length);
    const r1 = ctx.svc.runCommand(req);
    if (!r1.ok) throw new Error(`publish failed: ${JSON.stringify(r1)}`);
    expect(r1.revision).toBe(REV + 1);
    expect(ctx.svc.readBlob(PROJECT_ID, { assetId: 'asset-model-gamma', version: 1 }).ok).toBe(true);

    // Undo removes the published record from the catalog — the bytes are
    // retained (no GC) and simply not addressable.
    const undo = ctx.svc.runCommand({ op: 'undo', projectId: PROJECT_ID, expectedRevision: REV + 1, requestId: 'req-' + 'f'.repeat(32), origin: { kind: 'mcp', clientId: 'pi' }, args: {} });
    if (!undo.ok) throw new Error('undo failed');
    expect(undo.revision).toBe(REV + 2);
    const afterUndo = ctx.svc.readBlob(PROJECT_ID, { assetId: 'asset-model-gamma', version: 1 });
    expect(afterUndo.ok).toBe(false);
    if (!afterUndo.ok) expect(afterUndo.error.code).toBe('asset_not_found');
    expect(sha256Hex(fileBytes(blobPath(ctx, digest)))).toBe(digest);

    // Redo reapplies the exact recorded record: addressable again, verified.
    const redo = ctx.svc.runCommand({ op: 'redo', projectId: PROJECT_ID, expectedRevision: REV + 2, requestId: 'req-' + '0'.repeat(32), origin: { kind: 'mcp', clientId: 'pi' }, args: {} });
    if (!redo.ok) throw new Error('redo failed');
    expect(redo.revision).toBe(REV + 3);
    expect(ctx.svc.readBlob(PROJECT_ID, { assetId: 'asset-model-gamma', version: 1 }).ok).toBe(true);

    // Before the release the identical retry replays from the durable record.
    const dup = ctx.svc.runCommand(req);
    if (!dup.ok) throw new Error('replay failed');
    expect(dup.duplicated).toBe(true);
    expect(dup.revision).toBe(REV + 1);

    // Release clears the records; after a reopen the retry re-executes and
    // fails the revision check safely (a lost-ack retry never replays across
    // a release boundary, §9) — and every play pin is still readable.
    const rel = ctx.svc.releaseWorkspace(PROJECT_ID);
    if (!rel.ok) throw new Error(`release failed: ${JSON.stringify(rel)}`);
    expect(rel.retryCleared).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(ctx.dir, 'content.json'), 'utf8')) as { retry: { records: unknown[] } };
    expect(onDisk.retry.records).toEqual([]);
    const svc2 = reopen(ctx);
    const replay = svc2.runCommand(req);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('revision_conflict');
    const pin = svc2.readBlob(PROJECT_ID, { assetId: 'asset-model-gamma', version: 1 });
    if (!pin.ok) throw new Error('after restart: ' + JSON.stringify(pin));
    expect(pin.digest).toBe(digest);
    expect(svc2.readBlob(PROJECT_ID, { assetId: MODEL, version: 1 }).ok).toBe(true);
    svc2.dispose();
  });

  it('refuses behavior source publication structurally (preparer unavailable)', () => {
    ctx = setup();
    const r = ctx.svc.runCommand({
      op: 'publishBehavior',
      projectId: PROJECT_ID,
      expectedRevision: REV,
      requestId: 'req-' + '1'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: {
        behaviorId: 'behavior-00000000000000d4',
        displayName: 'Test',
        mode: 'source',
        declaration: { properties: [] },
        // A well-formed source object: the structural refusal is the preparer
        // gate (no compiler is injected in this workspace).
        source: { sourceDigest: COURIER, sourceByteLength: 47 },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('behavior_publication_unavailable');
      expect(ef(r.error)['reason']).toBe('preparer_unavailable');
    }
    ctx.svc.dispose();
  });

  it('reports stage_not_found for an unknown stage and discards a stage', () => {
    ctx = setup();
    const missing = ctx.svc.publishBlob(PROJECT_ID, { digest: COURIER, byteLength: 47, source: { kind: 'stage', stageId: 'stg-absent1' } });
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
});

describe('quota and write faults (workspace.md §13.4 F7/F8)', () => {
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

  it('maps an ENOSPC during blob publication to content_publish_failed with the project files unchanged', () => {
    const { root, dir } = seed('content-store-enospc');
    const svc = openWorkspaceService({
      root,
      ops: {
        ...defaultWriteOps,
        openTempFile: (p: string) => {
          if (p.includes(join('sources', 'sha256'))) {
            const e = new Error('ENOSPC') as Error & { code?: string };
            e.code = 'ENOSPC';
            throw e;
          }
          return defaultWriteOps.openTempFile(p);
        },
      },
    });
    // Open (and upgrade) first so the snapshot is the v4 files.
    expect(queryRevision(svc)).toBe(REV);
    const before = [fileBytes(join(dir, 'content.json')), fileBytes(join(dir, 'scenes', 'scene-main.json'))];
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
    expect(Array.from(fileBytes(join(dir, 'content.json')))).toEqual(Array.from(before[0]!));
    expect(Array.from(fileBytes(join(dir, 'scenes', 'scene-main.json')))).toEqual(Array.from(before[1]!));
    expect(existsSync(join(dir, 'sources', 'sha256', digest))).toBe(false);
    svc.dispose();
  });

  it('maps an fsync failure during blob publication to content_publish_failed (project files unchanged)', () => {
    const { root, dir } = seed('content-store-fsync');
    // Claim (open) the project successfully first; only then inject the fsync
    // failure so the blob publication is the failing phase.
    let failFsync = false;
    const svc = openWorkspaceService({
      root,
      ops: {
        ...defaultWriteOps,
        fsyncFile: (fd: number) => {
          if (failFsync) {
            const e = new Error('EIO') as Error & { code?: string };
            e.code = 'EIO';
            throw e;
          }
          defaultWriteOps.fsyncFile(fd);
        },
      },
    });
    expect(queryRevision(svc)).toBe(REV);
    const before = fileBytes(join(dir, 'content.json'));
    failFsync = true;
    const bytes = new TextEncoder().encode('fsync failure blob\n');
    const digest = sha256Hex(bytes);
    const pub = svc.publishBlob(PROJECT_ID, { digest, byteLength: bytes.length, source: { kind: 'bytes', bytes } });
    expect(pub.ok).toBe(false);
    if (!pub.ok) {
      expect(pub.error.code).toBe('content_publish_failed');
      expect(ef(pub.error)['reason']).toBe('write');
    }
    expect(Array.from(fileBytes(join(dir, 'content.json')))).toEqual(Array.from(before));
    expect(existsSync(join(dir, 'sources', 'sha256', digest))).toBe(false);
    svc.dispose();
  });

  it('rejects a second owner (ownership_conflict) for content operations', () => {
    ctx = setup();
    expect(queryRevision(ctx.svc)).toBe(REV);
    const other = openWorkspaceService({ root: ctx.root, backendId: 'tb-00000000000000000000000000000002', now: () => ctx.clock.value });
    const st = other.stageContent(PROJECT_ID, { stageId: 'stg-owner01', bytes: new TextEncoder().encode('x') });
    expect(st.ok).toBe(false);
    if (!st.ok) {
      expect(st.error.code).toBe('project_unavailable');
      expect(ef(st.error)['reason']).toBe('ownership_conflict');
    }
    const rb = other.readBlob(PROJECT_ID, { assetId: MODEL, version: 1 });
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(ef(rb.error)['reason']).toBe('ownership_conflict');
    expect(existsSync(join(ctx.dir, '.thirdlight', 'staging', 'stg-owner01'))).toBe(false);
    other.dispose();
    ctx.svc.dispose();
  });
});

describe('derived caches are regenerable and never authoritative (workspace.md §13.6)', () => {
  it('writes, reads, deletes and re-reads a derived import without touching the project files', () => {
    ctx = setup();
    expect(queryRevision(ctx.svc)).toBe(REV);
    const before = fileBytes(join(ctx.dir, 'content.json'));
    const importJson = new TextEncoder().encode(JSON.stringify({ nodes: ['a'] }, null, 2) + '\n');
    const w = writeDerivedImport(
      { ops: defaultWriteOps },
      { projectId: PROJECT_ID, dir: ctx.dir, thirdlightDir: join(ctx.dir, '.thirdlight'), storageVersion: 4, revision: REV, scene: null, content: null },
      COURIER,
      'r'.repeat(64),
      importJson,
    );
    if (!w.ok) throw new Error('derived write failed');
    expect(w.path).toBe(join(derivedCachePath(join(ctx.dir, '.thirdlight'), COURIER, 'r'.repeat(64)), 'import.json'));
    const read = readDerivedImport(join(ctx.dir, '.thirdlight'), COURIER, 'r'.repeat(64));
    if (!read.ok) throw new Error('derived read failed');
    expect(Array.from(read.bytes)).toEqual(Array.from(importJson));
    // content.json was not written (non-authoritative).
    expect(Array.from(fileBytes(join(ctx.dir, 'content.json')))).toEqual(Array.from(before));

    // Deleting the cache is harmless; the read reports derived_cache_unavailable.
    rmSync(join(ctx.dir, '.thirdlight', 'derived'), { recursive: true, force: true });
    const gone = readDerivedImport(join(ctx.dir, '.thirdlight'), COURIER, 'r'.repeat(64));
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.code).toBe('derived_cache_unavailable');
    // The project state is unaffected.
    expect(queryRevision(ctx.svc)).toBe(REV);
    ctx.svc.dispose();
  });
});

describe('content.json load refusals (workspace.md §4.5)', () => {
  it('reports storage_version_unsupported for an unknown version and content_invalid for a bad content block', () => {
    // Upgrade the media project to v4 once, then edit content.json by hand
    // while no backend holds it.
    const { root, dir } = seed('content-store-ver');
    const SELF = { backendId: 'tb-' + '9'.repeat(32), pid: 6500 };
    const first = openWorkspaceService({ root, ...SELF });
    expect(queryRevision(first)).toBe(REV);
    first.dispose();
    const contentPath = join(dir, 'content.json');
    const good = JSON.parse(readFileSync(contentPath, 'utf8')) as Record<string, unknown>;
    const reasonAfter = (doc: unknown): string | undefined => {
      writeFileSync(contentPath, JSON.stringify(doc, null, 2) + '\n');
      const svc = openWorkspaceService({ root, ...SELF });
      const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; error?: { code?: string; reason?: string } };
      expect(q.ok).toBe(false);
      expect(q.error?.code).toBe('project_unavailable');
      const scan = svc.lastScan.entries.find((e) => e.projectId === PROJECT_ID);
      expect(scan?.loadable).toBe(false);
      expect(scan?.code).toBe(q.error?.reason);
      svc.dispose();
      return q.error?.reason;
    };

    expect(reasonAfter({ ...good, storageVersion: 5 })).toBe('storage_version_unsupported');

    const badContent = structuredClone(good) as { content: { assets: { displayName: string }[] } };
    badContent.content.assets[0]!.displayName = '';
    expect(reasonAfter(badContent)).toBe('content_invalid');
    // The bytes are retained untouched (never repaired or rewritten).
    expect(JSON.parse(readFileSync(contentPath, 'utf8')).content.assets[0].displayName).toBe('');

    // Restoring the good bytes makes the project load again.
    writeFileSync(contentPath, JSON.stringify(good, null, 2) + '\n');
    const svc = openWorkspaceService({ root, ...SELF });
    expect(queryRevision(svc)).toBe(REV);
    svc.dispose();
  });
});
