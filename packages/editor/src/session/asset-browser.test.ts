import { describe, it, expect } from 'vitest';
import {
  applyAssetQueryPage,
  beginImport,
  canPublish,
  cancelImport,
  committed,
  discardImport,
  frameSent,
  importFailed,
  initialImportState,
  inspectionSucceeded,
  isBusy,
  jobUpdated,
  planAssetQuery,
  planUploadFrames,
  publishArgsFromProposal,
  publishStarted,
  stageCreated,
  uploadCompleted,
  utcSecondTimestamp,
  validateDropCandidate,
  type AssetImportState,
  type ImportProposal,
} from './asset-browser';
import { ContentProjection } from './content-projection';
import type { ContentJobView } from '@thirdlight/protocol';

function proposal(overrides: Partial<ImportProposal> = {}): ImportProposal {
  return {
    stageId: 'stage-0001',
    digest: 'a'.repeat(64),
    byteLength: 1024,
    status: 'ok',
    proposal: {
      status: 'ok',
      kind: 'model',
      sourceDigest: 'a'.repeat(64),
      sourceByteLength: 1024,
      importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
      metrics: { nodes: 1, meshes: 1, vertices: 24 },
    },
    ...overrides,
  };
}

function job(state: ContentJobView['state'], extra: Partial<ContentJobView> = {}): ContentJobView {
  return {
    jobId: 'job-' + '0'.repeat(32),
    projectId: 'demo-0001',
    kind: 'inspect',
    state,
    createdAt: '2026-09-18T00:00:00Z',
    expiresAt: '2026-09-18T00:15:00Z',
    ...extra,
  };
}

function uploaded(phase: 'inspecting' | 'proposed' = 'proposed'): AssetImportState {
  let s = beginImport(initialImportState, { mode: 'create', assetId: 'asset-0001', displayName: 'Rock' });
  s = stageCreated(s, 'stage-0001', 1024);
  s = frameSent(s, 1024);
  s = uploadCompleted(s);
  if (phase === 'proposed') s = inspectionSucceeded(s, proposal());
  return s;
}

describe('packet 27 — invalid drop (no stage, no job, no state change)', () => {
  it('rejects a non-GLB name and an oversized file before any network call', () => {
    expect(validateDropCandidate({ name: 'rock.obj', byteLength: 10 })).toEqual({
      ok: false,
      error: { code: 'import_rejected', message: 'only .glb (glTF binary) files can be imported' },
    });
    expect(validateDropCandidate({ name: 'rock.glb', byteLength: 0 }).ok).toBe(false);
    const big = validateDropCandidate({ name: 'rock.glb', byteLength: 33_554_433 });
    expect(big.ok).toBe(false);
    if (big.ok) return;
    expect(big.error.code).toBe('stage_limits_exceeded');
  });

  it('accepts a valid GLB and derives a bounded display name', () => {
    const v = validateDropCandidate({ name: 'Rock Formation.GLB', byteLength: 2048 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.displayName).toBe('Rock Formation');
  });
});

describe('packet 27 — bounded upload frame plan (workspace.md §7.6.2)', () => {
  it('splits a source into ≤ 1 MiB sequential frames', () => {
    expect(planUploadFrames(0)).toEqual([]);
    expect(planUploadFrames(1)).toEqual([{ offset: 0, length: 1 }]);
    expect(planUploadFrames(1_048_576)).toEqual([{ offset: 0, length: 1_048_576 }]);
    expect(planUploadFrames(1_048_577)).toEqual([
      { offset: 0, length: 1_048_576 },
      { offset: 1_048_576, length: 1 },
    ]);
    expect(planUploadFrames(2_621_440).length).toBe(3);
  });
});

describe('packet 27 — the import flow state machine', () => {
  it('walks stage → upload → inspect → propose → publish → committed', () => {
    let s = beginImport(initialImportState, { mode: 'create', assetId: 'asset-0001', displayName: null });
    expect(s.phase).toBe('staging');
    expect(isBusy(s)).toBe(true);
    s = stageCreated(s, 'stage-0001', 10);
    expect(s.phase).toBe('uploading');
    s = frameSent(s, 10);
    s = uploadCompleted(s);
    expect(s.phase).toBe('inspecting');
    s = inspectionSucceeded(s, proposal({ stageId: 'stage-0001', byteLength: 10 }));
    expect(s.phase).toBe('proposed');
    expect(canPublish(s)).toBe(true);
    s = publishStarted(s);
    expect(s.phase).toBe('publishing');
    s = committed(s);
    expect(s.phase).toBe('committed');
    expect(isBusy(s)).toBe(false);
  });

  it('a short upload fails closed (no inspect, no publish)', () => {
    let s = beginImport(initialImportState, { mode: 'create', assetId: 'asset-0001', displayName: null });
    s = stageCreated(s, 'stage-0001', 10);
    s = frameSent(s, 4);
    s = uploadCompleted(s);
    expect(s.phase).toBe('failed');
    expect(s.error?.code).toBe('content_frame_invalid');
    expect(canPublish(s)).toBe(false);
  });

  it('cancel sends nothing and marks the flow cancelled', () => {
    const s = cancelImport(uploaded('inspecting'));
    expect(s.phase).toBe('cancelled');
    expect(s.proposal).toBeNull();
    expect(() => publishStarted(s)).not.toThrow();
    expect(publishStarted(s).phase).toBe('cancelled');
  });

  it('discard resets to idle after a failure', () => {
    const failed = importFailed(uploaded('proposed'), { code: 'content_publish_failed', message: 'disk full' });
    expect(failed.phase).toBe('failed');
    expect(discardImport(failed).phase).toBe('idle');
  });
});

describe('packet 27 — stale job result is a proposal, never an applied edit', () => {
  it('a proposal for a superseded stage is discarded', () => {
    let s = uploaded('inspecting');
    s = inspectionSucceeded(s, proposal({ stageId: 'stage-0002' }));
    expect(s.phase).toBe('stale');
    expect(s.proposal).toBeNull();
    expect(s.error?.code).toBe('job_expired');
    expect(canPublish(s)).toBe(false);
  });

  it('an expired / cancelled / late job never becomes publishable', () => {
    for (const j of [
      job('expired'),
      job('cancelled'),
      job('succeeded', { lateResultDiscarded: true }),
    ]) {
      const s = jobUpdated(uploaded('proposed'), j);
      expect(s.phase).toBe('stale');
      expect(s.proposal).toBeNull();
      expect(canPublish(s)).toBe(false);
    }
  });

  it('a failed job surfaces its structured code and clears the proposal', () => {
    const s = jobUpdated(uploaded('proposed'), job('failed', { error: { code: 'import_rejected', message: 'bad GLB' } }));
    expect(s.phase).toBe('failed');
    expect(s.error).toEqual({ code: 'import_rejected', message: 'bad GLB' });
    expect(s.proposal).toBeNull();
  });

  it('a pending/succeeded job read is bounded status only', () => {
    const s = jobUpdated(uploaded('proposed'), job('succeeded', { result: { stageId: 'stage-0001', digest: 'a'.repeat(64) } }));
    expect(s.phase).toBe('proposed');
    expect(s.job).toEqual({ jobId: 'job-' + '0'.repeat(32), state: 'succeeded' });
  });
});

describe('packet 27 — failure preserves the previous committed content', () => {
  it('a failed reimport leaves the content projection untouched', () => {
    const content = new ContentProjection();
    content.hydrate({
      assets: [
        {
          assetId: 'asset-0001',
          kind: 'model',
          displayName: 'Rock',
          currentVersion: 1,
          versionCount: 1,
          versions: [{ version: 1, sourceDigest: 'a'.repeat(64), sourceByteLength: 100 }],
        },
      ],
    });
    const before = content.listAssets().map((a) => ({ ...a }));

    let s = beginImport(initialImportState, { mode: 'reimport', assetId: 'asset-0001', displayName: null });
    s = stageCreated(s, 'stage-0001', 200);
    s = frameSent(s, 200);
    s = uploadCompleted(s);
    s = inspectionSucceeded(s, proposal({ stageId: 'stage-0001' }));
    s = publishStarted(s);
    s = importFailed(s, { code: 'content_publish_failed', message: 'publication failed' });

    expect(s.phase).toBe('failed');
    // The catalog is unchanged: only an APPLIED publishAsset change updates it.
    expect(content.listAssets()).toEqual(before);
    expect(content.currentVersion('asset-0001')).toBe(1);
  });
});

describe('packet 27 — publishAsset args come from the proposal (stage-free facts)', () => {
  it('builds the strict args for a create (M3: with the immutable kind, §A3.5)', () => {
    const r = publishArgsFromProposal(proposal(), { mode: 'create', assetId: 'asset-0002', displayName: 'Rock' }, '2026-09-18T12:00:00Z', 'model');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args).toEqual({
      mode: 'create',
      assetId: 'asset-0002',
      kind: 'model',
      displayName: 'Rock',
      sourceDigest: 'a'.repeat(64),
      sourceByteLength: 1024,
      importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
      metrics: { nodes: 1, meshes: 1, vertices: 24 },
      importedAt: '2026-09-18T12:00:00Z',
    });
  });

  it('carries the atomic animated reimport when supplied (§8.5.1)', () => {
    const roles = { idle: { clipIndex: 0, clipName: 'Idle' }, run: { clipIndex: 1, clipName: 'Run' }, airborne: { clipIndex: 2, clipName: 'Airborne' } };
    const r = publishArgsFromProposal(proposal(), { mode: 'reimport', assetId: 'asset-0002', displayName: null }, '2026-09-18T12:00:00Z', 'model', { entityId: 'model-0001', roles });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.animation).toEqual({ entityId: 'model-0001', roles });
    expect(r.args.kind).toBe('model');
  });

  it('refuses a rejected proposal and a reimport without an assetId', () => {
    const rejected = publishArgsFromProposal(proposal({ proposal: { status: 'rejected' } }), { mode: 'create', assetId: 'asset-0002', displayName: null }, '2026-09-18T12:00:00Z', 'model');
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('import_rejected');
    const noId = publishArgsFromProposal(proposal(), { mode: 'reimport', assetId: null, displayName: null }, '2026-09-18T12:00:00Z', 'model');
    expect(noId.ok).toBe(false);
    if (noId.ok) return;
    expect(noId.error.code).toBe('field_missing');
  });

  it('utcSecondTimestamp matches project-model §7.2 (second precision)', () => {
    expect(utcSecondTimestamp(new Date('2026-09-18T12:34:56.789Z'))).toBe('2026-09-18T12:34:56Z');
  });
});

describe('packet 27 — bounded asset query paging', () => {
  it('clamps limit/offset into the §4 bounds and folds pages', () => {
    expect(planAssetQuery({})).toEqual({ limit: 50, offset: 0 });
    expect(planAssetQuery({ limit: 1000, offset: -3 })).toEqual({ limit: 128, offset: 0 });
    const first = applyAssetQueryPage(null, { total: 129, offset: 0, limit: 50, count: 50 });
    expect(first).toEqual({ total: 129, offset: 0, limit: 50, hasMore: true });
    const last = applyAssetQueryPage(first, { total: 129, offset: 100, limit: 50, count: 29 });
    expect(last.hasMore).toBe(false);
  });
});
