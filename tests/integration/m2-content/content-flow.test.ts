/**
 * Packet 25 — content HTTP services integration (real backend process, real
 * filesystem, real stdio MCP SDK client, real WS).
 *
 * Covers the packet's acceptance: real import/query/instantiate/edit/retry
 * flow; browser-origin and MCP-origin commands producing the same structured
 * results; bounded job errors; and projection convergence where
 * `mutation.applied` frames reconstruct the current projection without
 * GLB/source bytes.
 */
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  AUTHORING_ORIGIN,
  CONTENT_PROJECT,
  establish,
  fixtureBytes,
  fixtureFile,
  http,
  makeRoot,
  mkRequestId,
  cleanupBundles,
  createMcp,
  openWs,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
  type SessionInfo,
  type WsInbox,
} from './harness';

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;
let session: SessionInfo;
let ws: WsInbox;
let revision = 0;
let importedAssetId = '';
let importedDigest = '';
let prefabId = '';

/** Current revision from a bounded MCP query. */
async function currentRevision(): Promise<number> {
  const res = await mcp.call('tl_inspect', { target: 'project' });
  expect(res.body.ok).toBe(true);
  return Number(res.body.revision);
}

/** Upload + inspect a fixture GLB through the real MCP content tool. */
async function uploadAndInspect(name: string): Promise<Record<string, unknown>> {
  const bytes = fixtureBytes(name);
  const res = await mcp.call('tl_content_upload', { dataBase64: Buffer.from(bytes).toString('base64') });
  expect(res.isError, JSON.stringify(res.body)).toBe(false);
  const proposal = res.body.proposal as Record<string, unknown>;
  expect(proposal.status).toBe('ok');
  return proposal;
}

function publishArgs(
  mode: 'create' | 'reimport',
  assetId: string,
  proposal: Record<string, unknown>,
  displayName: string,
): Record<string, unknown> {
  return {
    mode,
    assetId,
    displayName,
    sourceDigest: String(proposal.sourceDigest),
    sourceByteLength: Number(proposal.sourceByteLength),
    importRecipe: proposal.importRecipe,
    metrics: proposal.metrics,
    // project-model §18.4 `importedAt` (the implementation requires it in the
    // args; the accepted commands.md §3.1.1 list omits it — recorded in the
    // packet-25 handoff).
    importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

async function command(body: Record<string, unknown>, browser = false): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/commands`, {
    body,
    token: AUTH_TOKEN,
    ...(browser ? { origin: AUTHORING_ORIGIN } : {}),
  });
  return { status: res.status, body: res.body as Record<string, unknown> };
}

beforeAll(async () => {
  root = makeRoot('flow');
  bp = await spawnBackend(root, [
    { token: AUTH_TOKEN, scope: `authoring:${CONTENT_PROJECT}` },
    { token: ADMIN_TOKEN, scope: 'admin' },
  ]);
  mcp = await createMcp(bp.origin);
  session = await establish(bp.origin);
  ws = await openWs(bp.origin, session);
  // The establish full state carries the packet-25 content projection.
  const content = session.body.content as { assets: Array<{ assetId: string }> } | undefined;
  expect(content).toBeDefined();
  expect(content?.assets.map((a) => a.assetId)).toContain('asset-00000000000000a1');
  revision = session.revision;
}, 90_000);

afterAll(async () => {
  cleanupBundles();
  ws?.close();
  await mcp?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('packet 25 — content flow (real process + real fs + real stdio MCP)', () => {
  it('the actual stdio MCP lists the M1 tools plus the packet-25 content tools', async () => {
    const names = await mcp.listTools();
    for (const expected of ['tl_inspect', 'tl_command', 'tl_content_query', 'tl_content_upload', 'tl_content_job']) {
      expect(names).toContain(expected);
    }
  });

  it('serves authenticated committed asset bytes by immutable version', async () => {
    const res = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/content/assets/asset-00000000000000a1/versions/2/bytes`, {
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(res.status).toBe(200);
    const alpha = fixtureFile('storage/blobs/alpha.bin');
    expect(res.bytes.length).toBe(alpha.length);
    expect(Buffer.from(res.bytes).toString('hex')).toBe(Buffer.from(alpha).toString('hex'));
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-thirdlight-digest']).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers['etag']).toBe(`"${res.headers['x-thirdlight-digest']}"`);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('imports a GLB through the real upload/inspect/publishAsset path (MCP)', async () => {
    const proposal = await uploadAndInspect('tiny-v1.glb');
    importedDigest = String(proposal.sourceDigest);
    importedAssetId = 'asset-00000000000000c3';
    revision = await currentRevision();
    const publish = await mcp.call('tl_command', {
      op: 'publishAsset',
      expectedRevision: revision,
      args: publishArgs('create', importedAssetId, proposal, 'Tiny v1'),
    });
    expect(publish.isError, JSON.stringify(publish.body)).toBe(false);
    expect(publish.body.ok).toBe(true);
    expect(Number(publish.body.revision)).toBe(revision + 1);
    const change = publish.body.change as Record<string, unknown>;
    expect(change.type).toBe('publishAsset');
    revision = Number(publish.body.revision);

    const list = await mcp.call('tl_content_query', { target: 'assets', includeVersions: true });
    expect(list.body.ok).toBe(true);
    const assets = list.body.assets as Array<Record<string, unknown>>;
    const record = assets.find((a) => a.assetId === importedAssetId);
    expect(record).toBeDefined();
    expect(record?.currentVersion).toBe(1);

    const bytes = await http(`${bp.origin}/api/v1/projects/${CONTENT_PROJECT}/content/assets/${importedAssetId}/versions/1/bytes`, {
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(bytes.status).toBe(200);
    expect(bytes.headers['x-thirdlight-digest']).toBe(importedDigest);
    const source = fixtureBytes('tiny-v1.glb');
    expect(bytes.bytes.length).toBe(source.length);
    expect(Buffer.from(bytes.bytes).toString('hex')).toBe(Buffer.from(source).toString('hex'));
  }, 60_000);

  it('converges the projection from mutation.applied frames with no binary payloads', async () => {
    const applied = await ws.waitFor((e) => e.type === 'mutation.applied' && (e.change as Record<string, unknown>)?.type === 'publishAsset');
    const text = JSON.stringify(applied);
    expect(text.length).toBeLessThan(1024 * 1024);
    expect(text).not.toContain('"bytes"');
    expect(text).not.toContain(Buffer.from(fixtureBytes('tiny-v1.glb')).toString('base64').slice(0, 48));
    const change = applied.change as Record<string, unknown>;
    const next = change.next as Record<string, unknown>;
    expect(next.assetId).toBe(importedAssetId);
    expect((next.versions as Array<Record<string, unknown>>)[0]?.sourceDigest).toBe(importedDigest);
    const revisions = ws.events.filter((e) => e.type === 'mutation.applied').map((e) => Number(e.revision));
    for (let i = 1; i < revisions.length; i += 1) expect(revisions[i]).toBe((revisions[i - 1] ?? 0) + 1);
  });

  it('produces the same command results and errors for browser-origin and MCP-origin requests', async () => {
    revision = await currentRevision();
    // The same logical edit from both origins: identical result shape, one
    // revision each, fresh requestIds.
    const mcpCreate = await command({
      op: 'createEntity',
      projectId: CONTENT_PROJECT,
      expectedRevision: revision,
      requestId: mkRequestId(),
      origin: { kind: 'mcp', clientId: 'parity-mcp' },
      args: { kind: 'box', name: 'Parity MCP', parentId: null },
    });
    expect(mcpCreate.body.ok).toBe(true);
    const browserCreate = await command(
      {
        op: 'createEntity',
        projectId: CONTENT_PROJECT,
        expectedRevision: Number(mcpCreate.body.revision),
        requestId: mkRequestId(),
        origin: { kind: 'browser', clientId: 'parity-browser' },
        args: { kind: 'box', name: 'Parity Browser', parentId: null },
      },
      true,
    );
    expect(browserCreate.body.ok).toBe(true);
    expect((browserCreate.body.change as Record<string, unknown>).type).toBe((mcpCreate.body.change as Record<string, unknown>).type);
    expect(String(browserCreate.body.createdId)).toMatch(/^box-[0-9]{4}$/);
    revision = Number(browserCreate.body.revision);

    // A stale command from either origin yields the same structured conflict.
    const staleBody = {
      op: 'setTransform',
      projectId: CONTENT_PROJECT,
      expectedRevision: 0,
      requestId: mkRequestId(),
      args: { entityId: 'model-0001', transform: { position: [9, 9, 9] } },
    };
    const staleMcp = await command({ ...staleBody, origin: { kind: 'mcp', clientId: 'parity-mcp' } });
    const staleBrowser = await command({ ...staleBody, origin: { kind: 'browser', clientId: 'parity-browser' } }, true);
    for (const res of [staleMcp, staleBrowser]) {
      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
      const err = res.body.error as { code: string; currentRevision: number };
      expect(err.code).toBe('revision_conflict');
      expect(err.currentRevision).toBe(revision);
    }
  }, 60_000);

  it('captures a prefab, applies a legal property override and instantiates twice (independent copies)', async () => {
    revision = await currentRevision();
    const publishBehavior = await mcp.call('tl_command', {
      op: 'publishBehavior',
      expectedRevision: revision,
      args: {
        behaviorId: 'behavior-0001',
        displayName: 'Lantern Glow',
        mode: 'declaration-create',
        declaration: {
          properties: [
            { key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 },
            { key: 'target', label: 'Target', type: 'entityRef', default: null },
          ],
        },
      },
    });
    expect(publishBehavior.isError, JSON.stringify(publishBehavior.body)).toBe(false);
    revision = Number(publishBehavior.body.revision);

    const group = await mcp.call('tl_command', { op: 'createEntity', expectedRevision: revision, args: { kind: 'group', name: 'Kit' } });
    expect(group.body.ok).toBe(true);
    revision = Number(group.body.revision);
    const groupId = String(group.body.createdId);
    const box = await mcp.call('tl_command', {
      op: 'createEntity',
      expectedRevision: revision,
      args: { kind: 'box', name: 'Kit Box', parentId: groupId },
    });
    expect(box.body.ok).toBe(true);
    revision = Number(box.body.revision);
    const boxId = String(box.body.createdId);
    const props = await mcp.call('tl_command', {
      op: 'setBehaviorProperties',
      expectedRevision: revision,
      args: { entityId: boxId, behaviorId: 'behavior-0001', values: { speed: 4.5, target: groupId } },
    });
    expect(props.isError, JSON.stringify(props.body)).toBe(false);
    revision = Number(props.body.revision);

    const capture = await mcp.call('tl_command', {
      op: 'createPrefab',
      expectedRevision: revision,
      args: { prefabId: 'prefab-0001', displayName: 'Kit', sourceEntityId: groupId },
    });
    expect(capture.isError, JSON.stringify(capture.body)).toBe(false);
    prefabId = 'prefab-0001';
    revision = Number(capture.body.revision);

    const instantiate = await mcp.call('tl_command', {
      op: 'instantiatePrefab',
      expectedRevision: revision,
      args: { prefabId, overrides: [{ localId: boxId, key: 'speed', value: 7.25 }] },
    });
    expect(instantiate.isError, JSON.stringify(instantiate.body)).toBe(false);
    const change = instantiate.body.change as Record<string, unknown>;
    expect(change.type).toBe('instantiatePrefab');
    const mapping = change.mapping as Array<{ localId: string; entityId: string }>;
    expect(mapping.map((m) => m.localId)).toEqual([groupId, boxId]);
    const rootId = String(change.rootId);
    revision = Number(instantiate.body.revision);

    const newBoxId = mapping.find((m) => m.localId === boxId)?.entityId as string;
    const observed = await mcp.call('tl_inspect', { target: 'entity', entityId: newBoxId });
    const entity = observed.body.entity as { components: { behavior: { values: { speed: number; target: string } } } };
    expect(entity.components.behavior.values.speed).toBe(7.25);
    expect(entity.components.behavior.values.target).toBe(rootId);

    const second = await mcp.call('tl_command', { op: 'instantiatePrefab', expectedRevision: revision, args: { prefabId } });
    expect(second.body.ok).toBe(true);
    const secondChange = second.body.change as Record<string, unknown>;
    const secondMapping = secondChange.mapping as Array<{ localId: string; entityId: string }>;
    expect(secondMapping.find((m) => m.localId === boxId)?.entityId).not.toBe(newBoxId);
    revision = Number(second.body.revision);

    const prefabQuery = await mcp.call('tl_content_query', { target: 'prefabs', includeEntities: true });
    expect(prefabQuery.body.ok).toBe(true);
    expect((prefabQuery.body.prefabs as Array<Record<string, unknown>>)[0]?.prefabId).toBe(prefabId);
  }, 60_000);

  it('replays an identical retry after a lost ack (duplicated: true)', async () => {
    revision = await currentRevision();
    const envelope = {
      op: 'setTransform',
      projectId: CONTENT_PROJECT,
      expectedRevision: revision,
      requestId: mkRequestId(),
      origin: { kind: 'mcp', clientId: 'retry-test' },
      args: { entityId: 'model-0001', transform: { position: [2, 0, 0] } },
    };
    const first = await command(envelope);
    expect(first.body.ok).toBe(true);
    const retry = await command(envelope);
    expect(retry.body.duplicated).toBe(true);
    expect({ ...retry.body, duplicated: false }).toEqual(first.body);
    revision = Number(first.body.revision);
  });

  it('appends a reimport version and rejects a stale reimport without changing the catalog', async () => {
    const before = await mcp.call('tl_content_query', { target: 'assets', includeVersions: true });
    revision = await currentRevision();
    const proposal = await uploadAndInspect('tiny-v2.glb');
    const stale = await mcp.call('tl_command', {
      op: 'publishAsset',
      expectedRevision: revision - 1,
      args: publishArgs('reimport', importedAssetId, proposal, 'Tiny v2'),
    });
    expect(stale.isError).toBe(true);
    expect((stale.body.error as { code: string }).code).toBe('revision_conflict');
    expect((stale.body.error as { currentRevision: number }).currentRevision).toBe(revision);
    const after = await mcp.call('tl_content_query', { target: 'assets', includeVersions: true });
    expect(after.body.assets).toEqual(before.body.assets);

    const ok = await mcp.call('tl_command', {
      op: 'publishAsset',
      expectedRevision: revision,
      args: publishArgs('reimport', importedAssetId, proposal, 'Tiny v2'),
    });
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    revision = Number(ok.body.revision);
    const listed = await mcp.call('tl_content_query', { target: 'asset', assetId: importedAssetId, includeVersions: true });
    expect((listed.body.asset as { currentVersion: number }).currentVersion).toBe(2);
  }, 60_000);

  it('reports a bounded job result and refuses an unknown job', async () => {
    const bytes = fixtureBytes('tiny-v1.glb');
    const res = await mcp.call('tl_content_upload', { dataBase64: Buffer.from(bytes).toString('base64') });
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    const jobId = String(res.body.jobId);
    expect(jobId).toMatch(/^job-[0-9a-f]{32}$/);
    const job = await mcp.call('tl_content_job', { jobId });
    expect(job.body.ok).toBe(true);
    expect((job.body.job as { state: string }).state).toBe('succeeded');
    const unknown = await mcp.call('tl_content_job', { jobId: `job-${'0'.repeat(32)}` });
    expect(unknown.isError).toBe(true);
    expect((unknown.body.error as { code: string }).code).toBe('job_not_found');
  }, 60_000);

  it('refuses behavior source publication without a prepared digest (packet 33)', async () => {
    revision = await currentRevision();
    const res = await mcp.call('tl_command', {
      op: 'publishBehavior',
      expectedRevision: revision,
      args: {
        behaviorId: 'behavior-0001',
        displayName: 'Lantern Glow',
        mode: 'source',
        declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] },
        source: { sourceDigest: 'a'.repeat(64), sourceByteLength: 10 },
      },
    });
    // Packet 33 registers the compiler on the real backend, so the refusal is
    // now the digest-bound preparation gate (`preparation_missing`), not the
    // absence of a preparer. The end-to-end publication path is exercised in
    // tests/integration/m2-builds/.
    expect(res.isError).toBe(true);
    const err = res.body.error as { code: string; reason?: string };
    expect(err.code).toBe('behavior_publication_unavailable');
    expect(err.reason).toBe('preparation_missing');
  });

  it('a full re-attach matches the incremental projection', async () => {
    // Re-attach the SAME session (a fresh sessionId would 409 while active).
    const again = await establish(bp.origin, session.sessionId);
    const content = again.body.content as { assets: Array<{ assetId: string; currentVersion: number }> };
    expect(content.assets.find((a) => a.assetId === importedAssetId)?.currentVersion).toBe(2);
    expect(again.revision).toBe(await currentRevision());
  }, 60_000);

  it('replays a recorded publication without needing the stage (dedup precedes stage lookup)', async () => {
    const proposal = await uploadAndInspect('tiny-v1.glb');
    const assetId = 'asset-00000000000000e5';
    revision = await currentRevision();
    const envelope = {
      op: 'publishAsset',
      projectId: CONTENT_PROJECT,
      expectedRevision: revision,
      requestId: mkRequestId(),
      origin: { kind: 'mcp', clientId: 'expired-stage' },
      args: publishArgs('create', assetId, proposal, 'Expired Stage Probe'),
    };
    const first = await command(envelope);
    expect(first.body.ok).toBe(true);
    const replay = await command(envelope);
    expect(replay.body.duplicated).toBe(true);
    revision = Number(first.body.revision);
  }, 60_000);

  it('serves the content integrity report', async () => {
    const res = await mcp.call('tl_content_query', { target: 'integrity' });
    expect(res.body.ok).toBe(true);
    const summary = res.body.summary as { total: number; ok: number; missing: number; corrupt: number };
    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.ok).toBe(summary.total);
    expect(summary.missing).toBe(0);
    expect(summary.corrupt).toBe(0);
  });
});
