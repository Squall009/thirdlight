/**
 * Packet 25 backend content-transport units: the bounded job coordinator
 * (cancellation, expiry, late results, concurrency), the upload assembly
 * bounds, the error→session mapping, and the injected inspector binding.
 * The HTTP routes themselves are covered end-to-end in
 * `tests/integration/m2-content/**` against a real backend process.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportJobPort } from '@thirdlight/asset-pipeline';
import { ContentJobs, ContentUploads, commandErrorToSession, createAssetInspector } from './content';

function fakeJobPort(stageId: string): ImportJobPort {
  return {
    now: () => 1000,
    isCancelled: () => false,
    proposalId: () => `p-${'a'.repeat(32)}`,
    stageId: () => stageId,
    expiresAt: () => '2026-09-18T10:00:00Z',
    timeoutMs: 30_000,
  };
}

describe('ContentJobs (bounded coordination, expiry and late results)', () => {
  it('records a bounded successful result and refuses an unknown job', () => {
    let now = 1_000_000;
    const jobs = new ContentJobs(() => now);
    const begun = jobs.begin('inspect', 'demo-0001');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(jobs.get(begun.jobId).ok).toBe(true);
    jobs.finish(begun.jobId, { stageId: 'stg-1' });
    const got = jobs.get(begun.jobId);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.job.state).toBe('succeeded');
      expect(got.job.result).toEqual({ stageId: 'stg-1' });
    }
    const unknown = jobs.get(`job-${'0'.repeat(32)}`);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('job_not_found');
    void now;
  });

  it('expires a job whose bounded deadline elapsed (late results are discarded)', () => {
    let now = 0;
    const jobs = new ContentJobs(() => now);
    const begun = jobs.begin('inspect', 'demo-0001');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    now = 31_000; // past the 30 s inspect deadline
    const got = jobs.get(begun.jobId);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('job_expired');
    // A result arriving now is discarded, not applied.
    jobs.finish(begun.jobId, { stageId: 'stg-late' });
    const after = jobs.get(begun.jobId);
    expect(after.ok).toBe(false);
  });

  it('cancels a job and discards a late result', () => {
    const jobs = new ContentJobs(() => 0);
    const begun = jobs.begin('publish', 'demo-0001');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(jobs.isCancelled(begun.jobId)).toBe(false);
    jobs.cancel(begun.jobId);
    expect(jobs.isCancelled(begun.jobId)).toBe(true);
    jobs.finish(begun.jobId, { digest: 'a'.repeat(64) });
    const got = jobs.get(begun.jobId);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.job.state).toBe('cancelled');
      expect(got.job.lateResultDiscarded).toBe(true);
      expect(got.job.result).toBeUndefined();
    }
  });

  it('enforces the publish concurrency bound per project', () => {
    const jobs = new ContentJobs(() => 0);
    for (let i = 0; i < 2; i += 1) expect(jobs.begin('publish', 'demo-0001').ok).toBe(true);
    const third = jobs.begin('publish', 'demo-0001');
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe('content_publish_failed');
    // Another project is unaffected (the global bound is 4).
    expect(jobs.begin('publish', 'demo-0002').ok).toBe(true);
  });
});

describe('ContentUploads (bounded frame assembly)', () => {
  it('assembles a single-frame upload and enforces the open-stage bound', () => {
    const uploads = new ContentUploads(() => 0);
    const first = uploads.begin('demo-0001');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const frame = new Uint8Array([1, 2, 3, 4]);
    const appended = uploads.append('demo-0001', first.stageId, 0, 4, frame);
    expect(appended.ok).toBe(true);
    if (appended.ok && appended.complete) expect(Array.from(appended.bytes)).toEqual([1, 2, 3, 4]);

    for (let i = 0; i < 8; i += 1) expect(uploads.begin('demo-0001').ok).toBe(true);
    const ninth = uploads.begin('demo-0001');
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) {
      expect(ninth.error.code).toBe('stage_limits_exceeded');
      expect(ninth.error.limit).toBe('open_stages');
    }
  });

  it('rejects a frame gap and an oversize frame', () => {
    const uploads = new ContentUploads(() => 0);
    const begun = uploads.begin('demo-0001');
    if (!begun.ok) throw new Error('begin failed');
    const gap = uploads.append('demo-0001', begun.stageId, 8, 16, new Uint8Array(8));
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.error.code).toBe('content_frame_invalid');
    const oversize = uploads.append('demo-0001', begun.stageId, 0, 2_000_000, new Uint8Array(1_048_577));
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) {
      expect(oversize.error.code).toBe('stage_limits_exceeded');
      expect(oversize.error.limit).toBe('frame_bytes');
    }
  });
});

describe('commandErrorToSession (accepted route class mappings)', () => {
  it('maps blob_corrupt to internal and asset_not_found to not_found', () => {
    const corrupt = commandErrorToSession({ code: 'blob_corrupt', cls: 'validation', message: 'x', sourceDigest: 'a'.repeat(64) });
    expect(corrupt.cls).toBe('internal');
    expect(corrupt.code).toBe('blob_corrupt');
    const missing = commandErrorToSession({ code: 'asset_not_found', cls: 'validation', message: 'x', assetId: 'asset-1' });
    expect(missing.cls).toBe('not_found');
    const stage = commandErrorToSession({ code: 'stage_expired', cls: 'unavailable', message: 'x' });
    expect(stage.cls).toBe('unavailable');
  });
});

describe('createAssetInspector (backend constructs the injected inspector)', () => {
  it('inspects a real fixture GLB with the pinned profile and a supplied job', () => {
    const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'fixtures', 'm2', 'assets', 'tiny-v1.glb')));
    const inspect = createAssetInspector();
    const proposal = inspect(bytes, fakeJobPort('stg-fixture'));
    expect(proposal.status).toBe('ok');
    expect(proposal.stageId).toBe('stg-fixture');
    expect(proposal.importRecipe.profile).toBe('gltf-glb');
    expect(proposal.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects a malformed GLB with ordered diagnostics (never throws)', () => {
    const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'fixtures', 'm2', 'assets', 'truncated.glb')));
    const proposal = createAssetInspector()(bytes, fakeJobPort('stg-fixture'));
    expect(proposal.status).toBe('rejected');
    expect(proposal.diagnostics.length).toBeGreaterThan(0);
  });
});
