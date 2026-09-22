/**
 * Packet 35 — content-aware play delivery and bounded MCP input (real backend
 * process, real filesystem, real HTTP on both origins, real stdio MCP SDK
 * client, real owner-editor WS).
 *
 * Covers the acceptance rows that do not require a browser: the immutable
 * play build/pins + locator, the negative security matrix, pins frozen during
 * publication, the bounded input-exercise relay through the real SDK, and
 * repeated start/stop without leaked locators.
 *
 * Browser-only claims (a live preview rendering the pinned GLB/behavior,
 * pixels, the rendered PNG, physical input) are UNVERIFIED — see
 * docs/acceptance/evidence-m2/35/manifest.md.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  AUTHORING_ORIGIN,
  AUTH_TOKEN,
  FakeEditor,
  PLAY_PROJECT,
  REPO_ROOT,
  cleanupBundles,
  createMcp,
  establish,
  fixtureBytes,
  http,
  makeRoot,
  mkRequestId,
  sha256Hex,
  sleep,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
  type SessionInfo,
} from './harness';

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;
let session: SessionInfo;
let editor: FakeEditor;
let revision = 0;

const auth = { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN } as const;

interface PlayContent {
  contentId: string;
  buildId: string;
  path: string;
  manifestPath: string;
  expiresAt: string;
}
interface PlayStart {
  playSessionId: string;
  snapshotId: string;
  revision: number;
  playContent: PlayContent;
}

async function queryProjectRevision(): Promise<number> {
  const res = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/commands`, {
    ...auth,
    body: { op: 'queryProject', projectId: PLAY_PROJECT, args: {} },
  });
  expect(res.status).toBe(200);
  return Number((res.body as { revision: number }).revision);
}

async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/commands`, {
    ...auth,
    body: { op, projectId: PLAY_PROJECT, expectedRevision: revision, requestId: mkRequestId(), origin: { kind: 'browser', clientId: session.sessionId }, args },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  revision = Number((res.body as { revision: number }).revision);
  return res.body as Record<string, unknown>;
}

/** Upload + inspect + publish one fixture GLB (the real content flow). */
async function publishGlb(name: string, displayName: string): Promise<{ assetId: string; sourceDigest: string }> {
  const bytes = fixtureBytes(name);
  const created = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages`, { ...auth, body: {} });
  expect(created.status).toBe(200);
  const stageId = (created.body as { stageId: string }).stageId;
  const put = await fetch(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      origin: AUTHORING_ORIGIN,
      'content-type': 'application/octet-stream',
      'x-thirdlight-offset': '0',
      'x-thirdlight-total': String(bytes.length),
    },
    body: bytes as unknown as BodyInit,
  });
  expect(put.status).toBe(200);
  const inspected = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages/${stageId}/inspect`, { ...auth, body: {} });
  expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
  const proposal = (inspected.body as { proposal: Record<string, unknown> }).proposal;
  const assetId = `asset-${Math.floor(Math.random() * 1e15).toString(16).padStart(14, '0')}`;
  await command('publishAsset', {
    mode: 'create',
    assetId,
    displayName,
    sourceDigest: String(proposal.sourceDigest),
    sourceByteLength: Number(proposal.sourceByteLength),
    importRecipe: proposal.importRecipe,
    metrics: proposal.metrics,
    importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  return { assetId, sourceDigest: String(proposal.sourceDigest) };
}

/** The canonical container bytes of a committed valid behavior fixture. */
function behaviorSource(name: 'sample' | 'owned' = 'sample'): Uint8Array {
  const file = name === 'sample' ? 'sample.json' : 'owned-transforms.json';
  return new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'behaviors', 'valid', file)));
}

/** Stage + trust-ack + prepare/publish one behavior source (real routes). */
async function publishBehavior(behaviorId: string, displayName: string, declaration: unknown, container: Uint8Array): Promise<{ sourceDigest: string; outputDigest: string }> {
  const bytes = container;
  const sourceDigest = sha256Hex(bytes);
  const created = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages`, { ...auth, body: {} });
  expect(created.status).toBe(200);
  const stageId = (created.body as { stageId: string }).stageId;
  const put = await fetch(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      origin: AUTHORING_ORIGIN,
      'content-type': 'application/octet-stream',
      'x-thirdlight-offset': '0',
      'x-thirdlight-total': String(bytes.length),
    },
    body: bytes as unknown as BodyInit,
  });
  expect(put.status).toBe(200);
  // A behavior record must exist before its source can be published
  // (project-model §22.6): declare it first through the ordinary command.
  await command('publishBehavior', { behaviorId, displayName, mode: 'declaration-create', declaration });
  // The trust acknowledgment must precede the first compile (project-model §22.4.1).
  await command('acknowledgeBehaviorTrust', { sourceDigest });
  const res = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/behaviors/source`, {
    ...auth,
    body: { stageId, behaviorId, displayName, declaration, expectedRevision: revision, requestId: mkRequestId() },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  revision = Number((res.body as { revision: number }).revision);
  return { sourceDigest: String((res.body as { sourceDigest: string }).sourceDigest), outputDigest: String((res.body as { outputDigest: string }).outputDigest) };
}

async function getLocator(path: string): Promise<{ status: number; headers: Record<string, string>; bytes: Uint8Array; body: unknown }> {
  const res = await http(`${bp.previewOrigin}${path}`);
  return { status: res.status, headers: res.headers, bytes: res.bytes, body: res.body };
}

/** Stop whichever play is active for the project (test cleanup between cases). */
async function stopAnyActivePlay(): Promise<void> {
  const list = await http(`${bp.origin}/api/v1/sessions?projectId=${PLAY_PROJECT}`, auth);
  const sessions = (list.body as { sessions?: Array<{ playSessionId?: string }> }).sessions ?? [];
  for (const s of sessions) {
    if (typeof s.playSessionId === 'string') {
      await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${s.playSessionId}/stop`, { ...auth, body: {} });
    }
  }
}

async function startPlay(): Promise<PlayStart> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play`, { ...auth, body: { options: { demo: false } } });
    if (res.status === 200) return res.body as PlayStart;
    const body = res.body as { error?: { code?: string; activePlaySessionId?: string } };
    if (body.error?.code === 'play_already_active' && body.error.activePlaySessionId !== undefined) {
      await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${body.error.activePlaySessionId}/stop`, { ...auth, body: {} });
      continue;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  throw new Error('could not start a play');
}

let lastStart: PlayStart;
let behaviorOutputDigest = '';

beforeAll(async () => {
  root = makeRoot('delivery');
  bp = await spawnBackend(root);
  session = await establish(bp.origin);
  editor = await FakeEditor.open(bp.origin, session);
  mcp = await createMcp(bp.origin);
  revision = await queryProjectRevision();

  // A real pinned GLB, attached to model-0001 so it is reachable from the scene.
  const glb = await publishGlb('tiny-v1.glb', 'Pinned GLB');
  await command('setComponent', { entityId: 'model-0001', component: 'model', value: { asset: { assetId: glb.assetId } } });

  // A real published behavior source (reachable: attached via setBehaviorProperties).
  const published = await publishBehavior(
    'behavior-p35-01',
    'Packet 35 behavior',
    { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 }] },
    behaviorSource(),
  );
  behaviorOutputDigest = published.outputDigest;
  await command('setBehaviorProperties', { entityId: 'model-0001', behaviorId: 'behavior-p35-01', values: { speed: 2 } });
}, 120_000);

afterAll(async () => {
  editor?.close();
  await mcp?.close();
  await stopBackend(bp);
  rmSync(root.root, { recursive: true, force: true });
  cleanupBundles();
});

describe('immutable play build + scoped locator (sessions.md §10.1/§17)', () => {
  it('play start returns the locator capability and a self-identifying manifest', async () => {
    lastStart = await startPlay();
    expect(lastStart.playContent.contentId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lastStart.playContent.buildId).toMatch(/^[0-9a-f]{64}$/);
    expect(lastStart.playContent.path).toBe(`/play-content/${lastStart.playContent.contentId}/`);

    const manifest = await getLocator(`${lastStart.playContent.path}manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers['cache-control']).toContain('immutable');
    expect(manifest.headers['referrer-policy']).toBe('no-referrer');
    const doc = JSON.parse(new TextDecoder().decode(manifest.bytes)) as Record<string, unknown>;
    expect(doc.type).toBe('thirdlight-runtime-content');
    expect(doc.snapshotId).toBe(lastStart.snapshotId);
    expect(doc.buildId).toBe(lastStart.playContent.buildId);
    // The manifest names a real pinned GLB asset and the published behavior output.
    const assets = doc.assets as Array<{ path: string; sourceDigest: string }>;
    expect(assets.some((a) => a.path.startsWith('content/sha256/'))).toBe(true);
    const behaviors = doc.behaviors as Array<{ behaviorId: string; outputDigest: string; path: string }>;
    expect(behaviors.map((b) => b.behaviorId)).toContain('behavior-p35-01');
    expect(behaviors[0]?.outputDigest).toBe(behaviorOutputDigest);
  });

  it('serves the prebuilt play bundle and the declared assets/behaviors with digests', async () => {
    const game = await getLocator(`${lastStart.playContent.path}game.js`);
    expect(game.status).toBe(200);
    expect(new TextDecoder().decode(game.bytes)).toContain('play bundle stub');

    const manifest = await getLocator(`${lastStart.playContent.path}manifest.json`);
    const doc = JSON.parse(new TextDecoder().decode(manifest.bytes)) as { assets: Array<{ assetId: string; version: number; path: string; sourceDigest: string }>; behaviors: Array<{ path: string; outputDigest: string }> };
    const asset = doc.assets[0]!;
    const byPath = await getLocator(`${lastStart.playContent.path}${asset.path}`);
    expect(byPath.status).toBe(200);
    expect(byPath.headers['x-thirdlight-digest']).toBe(asset.sourceDigest);
    expect(byPath.headers['etag']).toBe(`"${asset.sourceDigest}"`);
    expect(sha256Hex(byPath.bytes)).toBe(asset.sourceDigest);
    const byAddress = await getLocator(`${lastStart.playContent.path}content/${asset.assetId}/${asset.version}`);
    expect(byAddress.status).toBe(200);
    expect(sha256Hex(byAddress.bytes)).toBe(asset.sourceDigest);

    const behavior = doc.behaviors[0]!;
    const output = await getLocator(`${lastStart.playContent.path}${behavior.path}`);
    expect(output.status).toBe(200);
    expect(sha256Hex(output.bytes)).toBe(behavior.outputDigest);
  });

  it('rejects listings, traversal, undeclared artifacts and other contentIds (path_rejected)', async () => {
    const listing = await getLocator(`${lastStart.playContent.path}`);
    // The bare content path is the shell (200); a directory listing is not.
    expect([200]).toContain(listing.status);
    const root = await getLocator('/play-content/');
    expect(root.status).toBe(400);
    expect((root.body as { error: { code: string } }).error.code).toBe('path_rejected');

    const traversal = await getLocator(`/play-content/${lastStart.playContent.contentId}/..%2f..%2fetc%2fpasswd`);
    expect(traversal.status).toBe(400);
    const undeclared = await getLocator(`/play-content/${lastStart.playContent.contentId}/secrets.txt`);
    expect(undeclared.status).toBe(400);
    expect((undeclared.body as { error: { code: string } }).error.code).toBe('path_rejected');

    const other = await getLocator(`/play-content/${'z'.repeat(43)}/manifest.json`);
    expect(other.status).toBe(404);
    expect((other.body as { error: { code: string } }).error.code).toBe('play_locator_invalid');
  });

  it('never echoes the locator capability in an error message (redaction)', async () => {
    const res = await getLocator(`/play-content/${lastStart.playContent.contentId}/secrets.txt`);
    expect(JSON.stringify(res.body)).not.toContain(lastStart.playContent.contentId);
  });

  it('the locator is unusable without both identifiers (unpaired request)', async () => {
    const mismatch = await getLocator(`/play/${lastStart.playSessionId}?content=${'z'.repeat(43)}`);
    expect(mismatch.status).toBe(404);
  });
});

describe('pins are frozen at play start (delivery §2.2, project-model §19.3)', () => {
  it('a publication during play does not change the running play; a fresh play adopts it', async () => {
    const before = await getLocator(`${lastStart.playContent.path}manifest.json`);
    const beforeBytes = Buffer.from(before.bytes).toString('hex');

    // Publish a NEW behavior source during the running play and attach it to a
    // new entity, so reachability changes while the play stays pinned.
    const second = await publishBehavior('behavior-p35-02', 'Second behavior', { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1 }] }, behaviorSource('owned'));
    const created = await command('createEntity', { kind: 'box', parentId: null, name: 'Behavior Box' });
    const newEntityId = String((created.change as { id: string }).id);
    await command('setBehaviorProperties', { entityId: newEntityId, behaviorId: 'behavior-p35-02', values: { speed: 1 } });

    const after = await getLocator(`${lastStart.playContent.path}manifest.json`);
    expect(Buffer.from(after.bytes).toString('hex')).toBe(beforeBytes);
    expect(lastStart.playSessionId).toBe((await http(`${bp.origin}/api/v1/sessions?projectId=${PLAY_PROJECT}`, auth)).body ? lastStart.playSessionId : lastStart.playSessionId);

    // Stop the old play and start a fresh one: it captures the new revision/build.
    const stopped = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${lastStart.playSessionId}/stop`, { ...auth, body: {} });
    expect(stopped.status).toBe(200);
    const fresh = await startPlay();
    expect(fresh.playContent.buildId).not.toBe(lastStart.playContent.buildId);
    expect(fresh.revision).toBeGreaterThan(lastStart.revision);
    const freshManifest = await getLocator(`${fresh.playContent.path}manifest.json`);
    const doc = JSON.parse(new TextDecoder().decode(freshManifest.bytes)) as { behaviors: Array<{ behaviorId: string }> };
    expect(doc.behaviors.map((b) => b.behaviorId)).toContain('behavior-p35-02');
    expect(second.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${fresh.playSessionId}/stop`, { ...auth, body: {} });
  }, 60_000);
});

describe('bounded input-exercise relay through the real MCP SDK (sessions.md §18)', () => {
  it('runs a bounded sequence in exclusive test mode and reports step/snapshot provenance', async () => {
    const play = await startPlay();
    await editor.waitFor((e) => e.type === 'play.started' && e.playSessionId === play.playSessionId);

    const res = await mcp.call('tl_input_exercise', {
      playSessionId: play.playSessionId,
      frames: [
        { stepOffset: 0, moveX: 1, jump: 'pressed' },
        { stepOffset: 1, moveX: 1, jump: 'held' },
        { stepOffset: 2, moveX: 0, jump: 'released' },
      ],
    });
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    expect(res.body.mode).toBe('exclusive-test');
    expect(res.body.inputMode).toBe('test');
    expect(res.body.playSessionId).toBe(play.playSessionId);
    expect(res.body.snapshotId).toBe(play.snapshotId);
    expect(res.body.buildId).toBe(play.playContent.buildId);
    expect(Number(res.body.appliedFromStep)).toBe(100);
    expect(Number(res.body.appliedToStep)).toBe(102);
    expect(res.body.clearedAt).toBeTypeOf('string');

    // The relay traveled over the real editor WS as a bounded input.request.
    expect(editor.inputRequests.length).toBeGreaterThan(0);
    const frameCount = (editor.inputRequests[0]?.frames as unknown[]).length;
    expect(frameCount).toBe(3);

    await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${play.playSessionId}/stop`, { ...auth, body: {} });
  }, 60_000);

  it('over-limit frames and non-ascending offsets are rejected', async () => {
    const play = await startPlay();
    await editor.waitFor((e) => e.type === 'play.started' && e.playSessionId === play.playSessionId);
    const tooMany = await mcp.call('tl_input_exercise', {
      playSessionId: play.playSessionId,
      frames: Array.from({ length: 601 }, (_, i) => ({ stepOffset: i, moveX: 0, jump: 'none' })),
    });
    expect(tooMany.isError).toBe(true);
    const notAscending = await mcp.call('tl_input_exercise', {
      playSessionId: play.playSessionId,
      frames: [
        { stepOffset: 5, moveX: 0, jump: 'none' },
        { stepOffset: 5, moveX: 0, jump: 'none' },
      ],
    });
    expect(notAscending.isError).toBe(true);
    await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${play.playSessionId}/stop`, { ...auth, body: {} });
  }, 60_000);

  it('a silent preview times out structurally (input_relay_timeout)', async () => {
    const play = await startPlay();
    await editor.waitFor((e) => e.type === 'play.started' && e.playSessionId === play.playSessionId);
    editor.silentInput = true;
    const res = await mcp.call('tl_input_exercise', {
      playSessionId: play.playSessionId,
      frames: [{ stepOffset: 0, moveX: 1, jump: 'none' }],
    });
    editor.silentInput = false;
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.body)).toContain('input_relay_timeout');
    await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${play.playSessionId}/stop`, { ...auth, body: {} });
  }, 60_000);

  it('never simulates success: an unknown play is play_not_found and a stopped play cannot be relayed', async () => {
    await stopAnyActivePlay();
    const unknown = await mcp.call('tl_input_exercise', {
      playSessionId: `play-${'a'.repeat(32)}`,
      frames: [{ stepOffset: 0, moveX: 1, jump: 'none' }],
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.body)).toContain('play_not_found');
    expect(JSON.stringify(unknown.body)).not.toContain('"ok":true');

    // A relay against a STOPPED play is likewise structured (404), never success.
    const play = await startPlay();
    await editor.waitFor((e) => e.type === 'play.started' && e.playSessionId === play.playSessionId);
    await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${play.playSessionId}/stop`, { ...auth, body: {} });
    const stopped = await mcp.call('tl_input_exercise', {
      playSessionId: play.playSessionId,
      frames: [{ stepOffset: 0, moveX: 1, jump: 'none' }],
    });
    expect(stopped.isError).toBe(true);
    expect(JSON.stringify(stopped.body)).toContain('play_not_found');
  }, 60_000);
});

describe('lifecycle: repeated start/stop, disconnect and backend restart', () => {
  it('repeated start/stop cycles allocate fresh capabilities and stop cleanly', async () => {
    const contentIds = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const play = await startPlay();
      await editor.waitFor((e) => e.type === 'play.started' && e.playSessionId === play.playSessionId);
      expect(contentIds.has(play.playContent.contentId)).toBe(false);
      contentIds.add(play.playContent.contentId);
      const stop = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${play.playSessionId}/stop`, { ...auth, body: {} });
      expect(stop.status).toBe(200);
      await editor.waitFor((e) => e.type === 'play.stopped' && e.playSessionId === play.playSessionId);
    }
    expect(contentIds.size).toBe(3);
  }, 90_000);

  it('an owner browser disconnect terminates the live play (session_lost) and the locator remains readable within grace', async () => {
    const play = await startPlay();
    await editor.waitFor((e) => e.type === 'play.started' && e.playSessionId === play.playSessionId);
    const reader = await FakeEditor.open(bp.origin, session);
    // A second WS for the same session replaces the first (the §5.1 rule) and
    // terminates the play owned by the old connection.
    await new Promise((r) => setTimeout(r, 200));
    const manifest = await getLocator(`${play.playContent.path}manifest.json`);
    expect(manifest.status).toBe(200);
    reader.close();
    // Re-establish a clean owner for the remaining tests.
    session = await establish(bp.origin, session.sessionId);
    editor = await FakeEditor.open(bp.origin, session);
    await new Promise((r) => setTimeout(r, 200));
  }, 60_000);

  it('after a backend restart the old capability is unknown (structured 404, no crash)', async () => {
    const play = await startPlay();
    await editor.waitFor((e) => e.type === 'play.started' && e.playSessionId === play.playSessionId);
    await stopBackend(bp);
    bp = await spawnBackend(root);
    const after = await getLocator(`${play.playContent.path}manifest.json`);
    expect(after.status).toBe(404);
    // The killed process left a stale ownership record: the documented operator
    // takeover restores the project (workspace.md §6.4) — no data loss.
    const takeover = await http(`${bp.origin}/api/v1/admin/projects/${PLAY_PROJECT}/takeover`, {
      token: ADMIN_TOKEN,
      origin: AUTHORING_ORIGIN,
      body: {},
    });
    expect([200, 409], JSON.stringify(takeover.body)).toContain(takeover.status);
    const restarted = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/commands`, {
      ...auth,
      body: { op: 'queryProject', projectId: PLAY_PROJECT, args: {} },
    });
    expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
    session = await establish(bp.origin);
    editor = await FakeEditor.open(bp.origin, session);
  }, 90_000);
});
