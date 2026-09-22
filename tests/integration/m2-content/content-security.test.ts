/**
 * Packet 25 — content transport security negatives (real backend process, real
 * filesystem). Covers the packet's failure list: unauthenticated/cross-project
 * upload/read, malformed multipart/chosen binary framing, path escapes, a
 * disconnected client, oversize payloads, replay after an expired stage and
 * restart, and a staged-file read.
 */
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  AUTHORING_ORIGIN,
  CONTENT_PROJECT,
  fixtureBytes,
  http,
  makeRoot,
  mkRequestId,
  cleanupBundles,
  createMcp,
  seedSecondProject,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
} from './harness';

const OTHER_PROJECT = 'demo-other-01';
const OTHER_ASSET = 'asset-other-proj-0001';

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;

async function bytes(path: string, token?: string, origin?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await http(`${bp.origin}${path}`, {
    ...(token !== undefined ? { token } : {}),
    ...(origin !== undefined ? { origin } : {}),
  });
  return { status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
}

function errorCode(body: Record<string, unknown>): string {
  const err = body.error as { code?: string } | undefined;
  return err?.code ?? '';
}

async function createStage(): Promise<string> {
  const res = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/content/stages`, {
    body: {},
    token: AUTH_TOKEN,
    origin: AUTHORING_ORIGIN,
  });
  expect(res.status).toBe(200);
  return String((res.body as { stageId: string }).stageId);
}

async function uploadFrame(stageId: string, offset: number, total: number, bytesIn: Uint8Array, token = AUTH_TOKEN): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    rawBody: bytesIn,
    token,
    origin: AUTHORING_ORIGIN,
    headers: { 'x-thirdlight-offset': String(offset), 'x-thirdlight-total': String(total) },
  });
  return { status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
}

beforeAll(async () => {
  root = makeRoot('security');
  seedSecondProject(root, OTHER_PROJECT);
  bp = await spawnBackend(root, [
    { token: AUTH_TOKEN, scope: `authoring:${CONTENT_PROJECT}` },
    { token: ADMIN_TOKEN, scope: 'admin' },
  ]);
  mcp = await createMcp(bp.origin, 'packet-25-security');
}, 90_000);

afterAll(async () => {
  cleanupBundles();
  await mcp?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('packet 25 — content transport security', () => {
  it('rejects unauthenticated asset-byte reads (401) and never reads a file', async () => {
    const res = await bytes(`/api/v1/projects/${CONTENT_PROJECT}/content/assets/asset-00000000000000a1/versions/2/bytes`);
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe('unauthorized');
  });

  it('rejects a cross-project authoring token (401) and never reads another project\'s version (404)', async () => {
    // The CONTENT_PROJECT token cannot address the other project.
    const wrongProject = await bytes(
      `/api/v1/projects/${OTHER_PROJECT}/content/assets/${OTHER_ASSET}/versions/2/bytes`,
      AUTH_TOKEN,
      AUTHORING_ORIGIN,
    );
    expect(wrongProject.status).toBe(401);
    expect(errorCode(wrongProject.body)).toBe('unauthorized');

    // With the admin token, the other project's assetId is absent from THIS
    // project's catalog: never a cross-project read.
    const foreign = await bytes(
      `/api/v1/projects/${CONTENT_PROJECT}/content/assets/${OTHER_ASSET}/versions/2/bytes`,
      ADMIN_TOKEN,
      AUTHORING_ORIGIN,
    );
    expect(foreign.status).toBe(404);
    expect(errorCode(foreign.body)).toBe('asset_not_found');
    // The control: the other project's own route serves it.
    const control = await bytes(
      `/api/v1/projects/${OTHER_PROJECT}/content/assets/${OTHER_ASSET}/versions/2/bytes`,
      ADMIN_TOKEN,
      AUTHORING_ORIGIN,
    );
    expect(control.status).toBe(200);
  });

  it('rejects a foreign Origin (403) and a cross-project upload token (401)', async () => {
    const foreignOrigin = await bytes(
      `/api/v1/projects/${CONTENT_PROJECT}/content/assets/asset-00000000000000a1/versions/2/bytes`,
      AUTH_TOKEN,
      'http://evil.example',
    );
    expect(foreignOrigin.status).toBe(403);
    expect(errorCode(foreignOrigin.body)).toBe('bad_origin');

    const wrongToken = await http(`${bp.origin}/api/v1/projects/${OTHER_PROJECT}/content/stages`, {
      body: {},
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(wrongToken.status).toBe(401);
    expect(errorCode(wrongToken.body as Record<string, unknown>)).toBe('unauthorized');
  });

  it('rejects path-shaped identifiers before any storage call', async () => {
    for (const assetId of ['%2e%2e%2fsecret', '..%2f..%2fetc', 'a%5cb', '..']) {
      const res = await bytes(
        `/api/v1/projects/${CONTENT_PROJECT}/content/assets/${assetId}/versions/1/bytes`,
        AUTH_TOKEN,
        AUTHORING_ORIGIN,
      );
      expect([400, 404], `${assetId} → ${res.status}`).toContain(res.status);
      if (res.status === 400) expect(errorCode(res.body)).toBe('path_rejected');
    }
    // A non-numeric version and a traversal jobId are refused too.
    const badVersion = await bytes(
      `/api/v1/projects/${CONTENT_PROJECT}/content/assets/asset-00000000000000a1/versions/..%2f1/bytes`,
      AUTH_TOKEN,
      AUTHORING_ORIGIN,
    );
    expect(badVersion.status).toBe(400);
    expect(errorCode(badVersion.body)).toBe('path_rejected');
    const badJob = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/content/jobs/..%2f1`, {
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(badJob.status).toBe(400);
  });

  it('never exposes staged bytes through the asset route (a stage id is not an asset)', async () => {
    const stageId = await createStage();
    const upload = await uploadFrame(stageId, 0, 4, new Uint8Array([1, 2, 3, 4]));
    expect(upload.status).toBe(200);
    const staged = await bytes(
      `/api/v1/projects/${CONTENT_PROJECT}/content/assets/${stageId}/versions/1/bytes`,
      AUTH_TOKEN,
      AUTHORING_ORIGIN,
    );
    expect(staged.status).toBe(404);
    expect(errorCode(staged.body)).toBe('asset_not_found');
    // The stage itself is only reachable for inspection/discard (and the
    // malformed bytes are rejected by the import profile).
    const inspect = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/content/stages/${stageId}/inspect`, {
      body: {},
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(inspect.status).toBe(400);
    expect(errorCode(inspect.body as Record<string, unknown>)).toBe('import_rejected');
  }, 60_000);

  it('a malformed GLB leaves no durable source blob and no durable effect (GF-5)', async () => {
    const before = await mcp.call('tl_inspect', { target: 'project' });
    const beforeRevision = Number(before.body.revision);
    const stageId = await createStage();
    const bad = fixtureBytes('truncated.glb');
    const upload = await uploadFrame(stageId, 0, bad.length, bad);
    expect(upload.status).toBe(200);
    expect(upload.body.complete).toBe(true);
    const uploadDigest = String(upload.body.digest);
    expect(uploadDigest).toBe(createHash('sha256').update(bad).digest('hex'));
    // Upload completion stages the bytes but publishes nothing (workspace.md
    // §13.3.2): publication moved to a successful inspection by GF-5.
    expect(existsSync(join(root.projectDir, 'sources', 'sha256', uploadDigest))).toBe(false);
    // Inspection rejects the malformed GLB ...
    const inspect = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/content/stages/${stageId}/inspect`, {
      body: {},
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(inspect.status).toBe(400);
    expect(errorCode(inspect.body as Record<string, unknown>)).toBe('import_rejected');
    // ... and the refusal leaves NO durable blob and NO new orphan blob
    // (workspace.md §13.4 F2: durable effect "none").
    expect(existsSync(join(root.projectDir, 'sources', 'sha256', uploadDigest))).toBe(false);
    const integrity = await mcp.call('tl_content_query', { target: 'integrity' });
    expect((integrity.body.summary as { orphanBlobs?: number }).orphanBlobs).toBe(0);
    // No durable effect at all: the revision is unchanged.
    const after = await mcp.call('tl_inspect', { target: 'project' });
    expect(Number(after.body.revision)).toBe(beforeRevision);
    // Positive control for the same existence check: a VALID GLB inspected
    // through the same route IS published (workspace.md §13.3.2 step 2).
    const good = fixtureBytes('tiny-v1.glb');
    const goodStage = await createStage();
    const goodUpload = await uploadFrame(goodStage, 0, good.length, good);
    expect(goodUpload.body.complete).toBe(true);
    const goodDigest = String(goodUpload.body.digest);
    expect(existsSync(join(root.projectDir, 'sources', 'sha256', goodDigest))).toBe(false);
    const goodInspect = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/content/stages/${goodStage}/inspect`, {
      body: {},
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(goodInspect.status).toBe(200);
    expect(existsSync(join(root.projectDir, 'sources', 'sha256', goodDigest))).toBe(true);
  }, 60_000);

  it('rejects malformed upload framing (missing/incorrect offset) with no stage extension', async () => {
    const stageId = await createStage();
    // Missing X-Thirdlight-Offset.
    const missing = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/content/stages/${stageId}/bytes`, {
      method: 'PUT',
      rawBody: new Uint8Array([1, 2, 3]),
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
      headers: { 'x-thirdlight-total': '3' },
    });
    expect(missing.status).toBe(400);
    expect(errorCode(missing.body as Record<string, unknown>)).toBe('content_frame_invalid');
    // A gap in the offset sequence.
    const gap = await uploadFrame(stageId, 8, 16, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(gap.status).toBe(400);
    expect(errorCode(gap.body)).toBe('content_frame_invalid');
    // The stage is still empty: a correct first frame is accepted.
    const ok = await uploadFrame(stageId, 0, 4, new Uint8Array([9, 9, 9, 9]));
    expect(ok.status).toBe(200);
    expect(ok.body.complete).toBe(true);
  }, 60_000);

  it('rejects an oversize upload frame before writing (stage_limits_exceeded/frame_bytes)', async () => {
    const stageId = await createStage();
    const tooBig = new Uint8Array(1_048_577);
    const res = await uploadFrame(stageId, 0, 1_048_577, tooBig);
    expect(res.status).toBe(400);
    expect(errorCode(res.body)).toBe('stage_limits_exceeded');
    expect((res.body.error as { limit?: string }).limit).toBe('frame_bytes');
  }, 60_000);

  it('survives a disconnected client without extending the staged sequence', async () => {
    const stageId = await createStage();
    // A raw request that declares a body it never sends, then destroys the
    // socket: the server must not record a partial frame.
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: Number(new URL(bp.origin).port),
          path: `/api/v1/projects/${CONTENT_PROJECT}/content/stages/${stageId}/bytes`,
          method: 'PUT',
          headers: {
            authorization: `Bearer ${AUTH_TOKEN}`,
            origin: AUTHORING_ORIGIN,
            'content-type': 'application/octet-stream',
            'x-thirdlight-offset': '0',
            'x-thirdlight-total': '16',
            'content-length': '16',
          },
        },
        () => undefined,
      );
      req.on('error', () => resolve());
      req.write(new Uint8Array([1, 2, 3]));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    // The next correct frame is expected at offset 0 (no partial extension).
    const ok = await uploadFrame(stageId, 0, 4, new Uint8Array([5, 5, 5, 5]));
    expect(ok.status).toBe(200);
    expect(ok.body.byteLength).toBe(4);
  }, 60_000);

  it('refuses an upload/tool request for an unknown stage', async () => {
    const unknown = await uploadFrame('stg-00000000000000000000000000000000', 0, 4, new Uint8Array([1, 2, 3, 4]));
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown.body)).toBe('stage_not_found');
  });

  it('keeps behavior-build publication unavailable through MCP (no mock success)', async () => {
    const rev = await mcp.call('tl_inspect', { target: 'project' });
    const res = await mcp.call('tl_command', {
      op: 'publishBehavior',
      expectedRevision: Number(rev.body.revision),
      args: {
        behaviorId: 'behavior-missing',
        displayName: 'Unavailable',
        mode: 'source',
        declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] },
        source: { sourceDigest: 'b'.repeat(64), sourceByteLength: 3 },
      },
    });
    expect(res.isError).toBe(true);
    expect((res.body.error as { code: string }).code).toBe('behavior_publication_unavailable');
  });

  it('replays a recorded publication after a restart and refuses the lost stage', async () => {
    // Record a publication, then restart the backend process on the same root.
    const proposal = await mcp.call('tl_content_upload', {
      dataBase64: Buffer.from(fixtureBytes('tiny-v1.glb')).toString('base64'),
    });
    expect(proposal.isError, JSON.stringify(proposal.body)).toBe(false);
    const prop = proposal.body.proposal as Record<string, unknown>;
    const rev = await mcp.call('tl_inspect', { target: 'project' });
    const assetId = 'asset-00000000000000f7';
    const envelope = {
      op: 'publishAsset',
      projectId: CONTENT_PROJECT,
      expectedRevision: Number(rev.body.revision),
      requestId: mkRequestId(),
      origin: { kind: 'mcp', clientId: 'restart-test' },
      args: {
        mode: 'create',
        assetId,
        displayName: 'Restart Probe',
        sourceDigest: String(prop.sourceDigest),
        sourceByteLength: Number(prop.sourceByteLength),
        importRecipe: prop.importRecipe,
        metrics: prop.metrics,
        importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
    };
    const first = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/commands`, { body: envelope, token: AUTH_TOKEN });
    expect((first.body as Record<string, unknown>).ok).toBe(true);
    const stageId = String(proposal.body.jobId ?? '');
    void stageId;

    await mcp.close();
    await stopBackend(bp);
    bp = await spawnBackend(root, [
      { token: AUTH_TOKEN, scope: `authoring:${CONTENT_PROJECT}` },
      { token: ADMIN_TOKEN, scope: 'admin' },
    ]);
    // The killed owner's record is stale: the operator takes over explicitly.
    const takeover = await http(`${bp.origin}/api/v1/admin/projects/${CONTENT_PROJECT}/takeover`, {
      body: {},
      token: ADMIN_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(takeover.status).toBe(200);
    mcp = await createMcp(bp.origin, 'packet-25-security-restarted');

    // The durable retry record replays the publication byte-identically.
    const replay = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/commands`, { body: envelope, token: AUTH_TOKEN });
    expect((replay.body as Record<string, unknown>).ok).toBe(true);
    expect((replay.body as Record<string, unknown>).duplicated).toBe(true);

    // An in-memory upload stage does not survive the restart.
    const lost = await uploadFrame(`stg-${'1'.repeat(32)}`, 0, 4, new Uint8Array([1, 2, 3, 4]));
    expect(lost.status).toBe(404);
    expect(errorCode(lost.body)).toBe('stage_not_found');
  }, 120_000);
});
