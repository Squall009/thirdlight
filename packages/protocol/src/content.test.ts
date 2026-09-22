/**
 * Packet 25 protocol validators — pure wire shapes for the content transport.
 * The upload-bound cases mirror
 * `fixtures/m2/contracts/delivery/upload-bounds.json` (re-derived there by the
 * fixture checker's `p19-upload` group); the numbers are inlined because the
 * pure protocol package may not read the filesystem.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_ASSETS_LIMIT_MAX,
  CONTENT_OPEN_STAGES,
  CONTENT_STAGED_BYTES_PER_PROJECT,
  CONTENT_STAGE_MAX,
  CONTENT_UPLOAD_FRAME_MAX,
  checkUploadFrame,
  containsBinaryValue,
  encodeBinaryFreeStateFrame,
  parseAssetByteParams,
  parseCommandEnvelope,
  parseContentAssetsQuery,
  parseJobId,
  parseStageCreateRequest,
  parseStageId,
  parseUploadFrameHeaders,
  validateContentJobView,
} from './index';

describe('checkUploadFrame (workspace.md §13.9 / upload-bounds.json cases)', () => {
  const cases = [
    { caseId: 'U1', frameBytes: 1_048_576, offset: 0, expectedOffset: 0, declaredTotal: 1_048_576, openStages: 1, stagedBytes: 0, expect: { accepted: true, code: null, limit: null } },
    { caseId: 'U2', frameBytes: 1_048_577, offset: 0, expectedOffset: 0, declaredTotal: 2_097_152, openStages: 1, stagedBytes: 0, expect: { accepted: false, code: 'stage_limits_exceeded', limit: 'frame_bytes' } },
    { caseId: 'U3', frameBytes: 4096, offset: 8192, expectedOffset: 4096, declaredTotal: 8192, openStages: 1, stagedBytes: 0, expect: { accepted: false, code: 'content_frame_invalid', limit: null } },
    { caseId: 'U4', frameBytes: 1_048_576, offset: 33_554_432, expectedOffset: 33_554_432, declaredTotal: 34_603_008, openStages: 1, stagedBytes: 33_554_432, expect: { accepted: false, code: 'stage_limits_exceeded', limit: 'stage_bytes' } },
    { caseId: 'U5', frameBytes: 4096, offset: 0, expectedOffset: 0, declaredTotal: 4096, openStages: 8, stagedBytes: 0, expect: { accepted: false, code: 'stage_limits_exceeded', limit: 'open_stages' } },
    { caseId: 'U6', frameBytes: 4096, offset: 0, expectedOffset: 0, declaredTotal: 4096, openStages: 2, stagedBytes: 134_217_728, expect: { accepted: false, code: 'stage_limits_exceeded', limit: 'staged_bytes_per_project' } },
    { caseId: 'U7', frameBytes: 4096, offset: 4096, expectedOffset: 4096, declaredTotal: 8192, openStages: 1, stagedBytes: 4096, expect: { accepted: true, code: null, limit: null } },
  ] as const;

  for (const c of cases) {
    it(`derives ${c.caseId} exactly`, () => {
      const verdict = checkUploadFrame({
        frameBytes: c.frameBytes,
        offset: c.offset,
        expectedOffset: c.expectedOffset,
        declaredTotal: c.declaredTotal,
        openStages: c.openStages,
        stagedBytes: c.stagedBytes,
      });
      if (c.expect.accepted) {
        expect(verdict.accepted).toBe(true);
        if (verdict.accepted) expect(typeof verdict.complete).toBe('boolean');
      } else {
        expect(verdict.accepted).toBe(false);
        if (!verdict.accepted) {
          expect(verdict.code).toBe(c.expect.code);
          expect(verdict.limit ?? null).toBe(c.expect.limit);
        }
      }
    });
  }

  it('marks a completing frame and rejects an over-declared total', () => {
    const done = checkUploadFrame({ frameBytes: 100, offset: 0, expectedOffset: 0, declaredTotal: 100, openStages: 1, stagedBytes: 0 });
    expect(done).toEqual({ accepted: true, complete: true });
    const over = checkUploadFrame({ frameBytes: 4096, offset: 0, expectedOffset: 0, declaredTotal: CONTENT_STAGE_MAX + 1, openStages: 1, stagedBytes: 0 });
    expect(over).toEqual({ accepted: false, code: 'stage_limits_exceeded', limit: 'stage_bytes' });
  });
});

describe('parseUploadFrameHeaders', () => {
  it('accepts decimal offsets and totals', () => {
    const r = parseUploadFrameHeaders({ 'x-thirdlight-offset': '4096', 'x-thirdlight-total': '8192' }, 4096);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r).toMatchObject({ offset: 4096, declaredTotal: 8192, frameBytes: 4096 });
  });
  it('rejects missing/malformed/negative values with content_frame_invalid', () => {
    for (const headers of [
      { 'x-thirdlight-total': '10' },
      { 'x-thirdlight-offset': '-1', 'x-thirdlight-total': '10' },
      { 'x-thirdlight-offset': '01', 'x-thirdlight-total': '10' },
      { 'x-thirdlight-offset': '0', 'x-thirdlight-total': '0' },
      { 'x-thirdlight-offset': '0' },
    ] as Array<Record<string, string | undefined>>) {
      const r = parseUploadFrameHeaders(headers, 4);
      expect(r.ok, JSON.stringify(headers)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('content_frame_invalid');
    }
  });
});

describe('parseAssetByteParams (sessions.md §16.1)', () => {
  it('accepts a bare (assetId, version)', () => {
    const r = parseAssetByteParams('demo-0001', 'asset-00000000000000a1', '2');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params).toEqual({ projectId: 'demo-0001', assetId: 'asset-00000000000000a1', version: 2 });
  });
  it('rejects path-shaped segments with path_rejected before any storage call', () => {
    for (const [pid, assetId, version] of [
      ['demo-0001', '..%2fsecret', '1'],
      ['demo-0001', 'a%5cb', '1'],
      ['demo-0001', '..', '1'],
      ['demo-0001', 'ok', '%2e%2e'],
      ['demo-0001', 'ok', '../1'],
    ]) {
      const r = parseAssetByteParams(pid!, assetId!, version!);
      expect(r.ok, `${assetId} ${version}`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('path_rejected');
    }
  });
  it('rejects syntax/value failures with field_value', () => {
    for (const [pid, assetId, version] of [
      ['demo-0001', 'ASSET', '1'],
      ['demo-0001', 'asset-1', '0'],
      ['demo-0001', 'asset-1', '01'],
      ['demo-0001', 'asset-1', 'x'],
    ]) {
      const r = parseAssetByteParams(pid!, assetId!, version!);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('field_value');
    }
  });
});

describe('stage/job/query validators', () => {
  it('a stage create body is strict and optional-displayName only', () => {
    expect(parseStageCreateRequest({}).ok).toBe(true);
    expect(parseStageCreateRequest({ displayName: 'My Model' }).ok).toBe(true);
    const bad = parseStageCreateRequest({ displayName: '' });
    expect(bad.ok).toBe(false);
    const unknown = parseStageCreateRequest({ path: '/etc/passwd' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('field_unexpected');
  });

  it('stageId/jobId path segments reject traversal', () => {
    expect(parseStageId('stg-abcdef').ok).toBe(true);
    const traversal = parseStageId('..%2fetc');
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error.code).toBe('path_rejected');
    expect(parseJobId(`job-${'a'.repeat(32)}`).ok).toBe(true);
    expect(parseJobId('job-short').ok).toBe(false);
  });

  it('bounds the asset list query', () => {
    expect(parseContentAssetsQuery(new Map())).toEqual({ ok: true, query: { limit: 50, offset: 0 } });
    expect(parseContentAssetsQuery(new Map([['limit', String(CONTENT_ASSETS_LIMIT_MAX)]])).ok).toBe(true);
    for (const params of [
      [['limit', String(CONTENT_ASSETS_LIMIT_MAX + 1)]],
      [['limit', '0']],
      [['offset', '-1']],
      [['cursor', 'abc']],
    ] as Array<Array<[string, string]>>) {
      const r = parseContentAssetsQuery(new Map(params));
      expect(r.ok, JSON.stringify(params)).toBe(false);
    }
  });

  it('validates a bounded job view', () => {
    const view = {
      jobId: `job-${'a'.repeat(32)}`,
      projectId: 'demo-0001',
      kind: 'inspect',
      state: 'succeeded',
      createdAt: '2026-09-18T10:00:00Z',
      expiresAt: '2026-09-18T10:15:00Z',
      result: { stageId: 'stg-1', proposalId: `p-${'b'.repeat(32)}` },
    };
    expect(validateContentJobView(view)).toBe(true);
    expect(validateContentJobView({ ...view, state: 'unknown' })).toBe(false);
    expect(validateContentJobView({ ...view, kind: 'behavior-build' })).toBe(false);
    expect(validateContentJobView({ ...view, jobId: 'job-short' })).toBe(false);
  });

  it('bounds and binary-guards full-state/change frames', () => {
    expect(containsBinaryValue({ change: { type: 'setTransform' } })).toBe(false);
    expect(containsBinaryValue({ change: { bytes: new Uint8Array([1, 2]) } })).toBe(true);
    expect(containsBinaryValue(new ArrayBuffer(4))).toBe(true);
    expect(encodeBinaryFreeStateFrame({ type: 'mutation.applied', revision: 1 }, 1024)).toContain('mutation.applied');
    expect(encodeBinaryFreeStateFrame({ type: 'mutation.applied', bytes: new Uint8Array([1]) }, 1024)).toBeNull();
    expect(encodeBinaryFreeStateFrame({ type: 'mutation.applied', pad: 'x'.repeat(2048) }, 1024)).toBeNull();
  });
});

describe('parseCommandEnvelope (packet 25 op surface extension)', () => {
  it('routes the M1 ops unchanged', () => {
    for (const op of ['createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo', 'queryProject', 'queryEntity', 'queryEntities']) {
      const r = parseCommandEnvelope({ op, projectId: 'demo-0001', args: {} });
      expect(r.ok, op).toBe(true);
    }
  });
  it('routes the M2 mutation and content query ops', () => {
    for (const op of [
      'publishAsset',
      'publishBehavior',
      'setBehaviorProperties',
      'setComponent',
      'setSettings',
      'acknowledgeBehaviorTrust',
      'createPrefab',
      'instantiatePrefab',
      'queryAssets',
      'queryPrefabs',
      'queryBehaviors',
    ]) {
      const r = parseCommandEnvelope({ op, projectId: 'demo-0001', args: {} });
      expect(r.ok, op).toBe(true);
      if (r.ok) expect(r.op).toBe(op);
    }
  });
  it('still rejects an unknown op', () => {
    const r = parseCommandEnvelope({ op: 'teleport', projectId: 'demo-0001' });
    expect(r.ok).toBe(false);
  });
});
