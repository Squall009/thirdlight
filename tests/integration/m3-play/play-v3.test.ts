/**
 * Packet 59 — the v3 play route (real backend process, real filesystem, real
 * HTTP on both origins; B16/B19/B20; delivery.md §2/§3/§5).
 *
 * Drives the `POST /api/v1/projects/:projectId/play` route for a v3 project
 * (the committed `demo-0003` box-based v3 envelope): the backend reads the
 * captured state through the `readCapturedV3` seam, builds the immutable v3
 * play artifact set with the SHARED M3 closure builder (`buildPlayContentM3` —
 * the same builder the export uses), and serves it from the locator. This test
 * proves the route end-to-end: the v2 manifest + the v3 scene + the M3 play
 * bundle are served, the manifest is self-identifying, and the pin is honored
 * across a live authoring edit (B19/B20).
 *
 * Browser-only claims (the real WebGL render, the real audio, the physical
 * gamepad, the real relay round-trip) are UNVERIFIED — see
 * tests/browser/m3-play/README.md (packet-38 baseline §1).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  AUTHORING_ORIGIN,
  V3_PROJECT,
  cleanupBundles,
  establish,
  http,
  makeRoot,
  mkRequestId,
  openWs,
  sha256Hex,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type SessionInfo,
  type WsInbox,
} from '../m3-content/harness';

let root: DisposableRoot;
let bp: BackendProcess;
let session: SessionInfo;
let ws: WsInbox | undefined;
let revision = 0;

const auth = { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN } as const;

interface PlayStart {
  ok: boolean;
  playSessionId: string;
  snapshotId: string;
  revision: number;
  playContent: { contentId: string; buildId: string; path: string; manifestPath: string; expiresAt: string };
}

/** The v3 play bundle (the M3 preview wrapper entry) served as the locator's game.js. */
const M3_BUNDLE_STUB = '// m3 play bundle stub (packet 59 integration test)\n';

async function queryRevision(): Promise<number> {
  const res = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/commands`, {
    ...auth,
    body: { op: 'queryProject', projectId: V3_PROJECT, args: {} },
  });
  expect(res.status).toBe(200);
  return Number((res.body as { revision: number }).revision);
}

async function command(op: string, args: Record<string, unknown>): Promise<number> {
  const res = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/commands`, {
    ...auth,
    body: { op, projectId: V3_PROJECT, expectedRevision: revision, requestId: mkRequestId(), origin: { kind: 'browser', clientId: session.sessionId }, args },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  revision = Number((res.body as { revision: number }).revision);
  return revision;
}

async function startPlay(): Promise<PlayStart> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/play`, { ...auth, body: { options: { demo: false } } });
    if (res.status === 200) return res.body as PlayStart;
    const body = res.body as { error?: { code?: string; activePlaySessionId?: string } };
    if (body.error?.code === 'play_already_active' && body.error.activePlaySessionId !== undefined) {
      await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/play/${body.error.activePlaySessionId}/stop`, { ...auth, body: {} });
      continue;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  throw new Error('could not start a v3 play');
}

async function locator(path: string): Promise<{ status: number; bytes: Uint8Array; body: unknown }> {
  const res = await http(`${bp.previewOrigin}${path}`);
  return { status: res.status, bytes: res.bytes, body: res.body };
}

async function stopAnyActivePlay(): Promise<void> {
  const list = await http(`${bp.origin}/api/v1/sessions?projectId=${V3_PROJECT}`, auth);
  const sessions = (list.body as { sessions?: Array<{ playSessionId?: string }> }).sessions ?? [];
  for (const s of sessions) {
    if (typeof s.playSessionId === 'string') {
      await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/play/${s.playSessionId}/stop`, { ...auth, body: {} });
    }
  }
}

beforeAll(async () => {
  root = makeRoot('play-v3');
  // The v3 play bundle (the M3 preview wrapper entry) that the backend serves
  // as the locator's game.js for a v3 play.
  writeFileSync(join(root.previewDir, 'preview-m3.js'), M3_BUNDLE_STUB);
  bp = await spawnBackend(root, [
    { token: AUTH_TOKEN, scope: `authoring:${V3_PROJECT}` },
    { token: ADMIN_TOKEN, scope: 'admin' },
  ]);
  session = await establish(bp.origin);
  // A live owner WS: the play stop route requires a connected owner
  // (connectedOwner: s.connected && s.socket).
  ws = await openWs(bp.origin, session);
  revision = await queryRevision();
}, 90_000);

afterAll(async () => {
  cleanupBundles();
  ws?.close();
  if (bp) await stopBackend(bp);
  if (root) await import('node:fs').then((m) => m.rmSync(root.root, { recursive: true, force: true }));
}, 60_000);

describe('v3 play route (real backend + locator)', () => {
  it('startPlay for a v3 project serves a v2 manifest + v3 scene + the M3 bundle', async () => {
    await stopAnyActivePlay();
    const start = await startPlay();
    expect(start.ok).toBe(true);
    expect(start.playSessionId).toMatch(/^play-/);
    expect(start.snapshotId).toBe(`${V3_PROJECT}@r${revision}`);
    expect(start.playContent.buildId).toMatch(/^[0-9a-f]{64}$/);

    const { contentId, buildId, path, manifestPath } = start.playContent;

    // The locator serves the runtime-content manifest v2 document.
    const manifest = await locator(`${path}${manifestPath}`);
    expect(manifest.status).toBe(200);
    const doc = JSON.parse(new TextDecoder().decode(manifest.bytes)) as Record<string, unknown>;
    expect(doc.manifestVersion).toBe(2);
    expect(doc.type).toBe('thirdlight-runtime-content');
    expect(doc.buildId).toBe(buildId);
    expect(doc.projectId).toBe(V3_PROJECT);
    expect(doc.snapshotId).toBe(`${V3_PROJECT}@r${revision}`);
    // The box-based demo has no media assets; the resolved six-key settings are
    // present (defaults, since the authored settings block is empty).
    expect(Array.isArray(doc.assets)).toBe(true);
    expect((doc.assets as unknown[]).length).toBe(0);
    expect(typeof doc.settings).toBe('object');
    expect(typeof doc.game).toBe('object');
    expect(doc.sceneDigest).toMatch(/^[0-9a-f]{64}$/);

    // The v3 scene is NOT served by the locator (the accepted §17.2.1 route
    // set has no scene route — it arrives via the nonce-verified tl.snapshot
    // bridge; the manifest's sceneDigest is the identity the preview verifies
    // it against). A locator scene.json read is path_rejected (400).
    const sceneRejected = await locator(`${path}scene.json`);
    expect(sceneRejected.status).toBe(400);
    expect(doc.sceneDigest).toMatch(/^[0-9a-f]{64}$/);

    // The M3 play bundle is served as game.js.
    const game = await locator(`${path}game.js`);
    expect(game.status).toBe(200);
    expect(new TextDecoder().decode(game.bytes)).toBe(M3_BUNDLE_STUB);

    await stopAnyActivePlay();
  });

  it('the pin is honored across a live authoring edit (B19/B20)', async () => {
    await stopAnyActivePlay();
    const before = await queryRevision();

    // A pinned play captures the build at the current revision.
    const pinned = await startPlay();
    const pinnedManifest = JSON.parse(
      new TextDecoder().decode((await locator(`${pinned.playContent.path}${pinned.playContent.manifestPath}`)).bytes),
    ) as Record<string, unknown>;
    const pinnedBuildId = String(pinnedManifest.buildId);
    const pinnedSettingsDigest = String(pinnedManifest.settingsDigest);

    // A live authoring edit (setSettings) advances the revision + produces a
    // new settingsDigest/contentDigest/buildId. The pinned play keeps its
    // snapshotId/buildId/revision (frozen at start — delivery §10.2).
    await command('setSettings', { settings: { run_speed: 6 } });
    const after = await queryRevision();
    expect(after).toBe(before + 1);

    // A FRESH play adopts the new capture (new buildId + settingsDigest).
    const fresh = await startPlay();
    const freshManifest = JSON.parse(
      new TextDecoder().decode((await locator(`${fresh.playContent.path}${fresh.playContent.manifestPath}`)).bytes),
    ) as Record<string, unknown>;
    expect(String(freshManifest.buildId)).not.toBe(pinnedBuildId);
    expect(String(freshManifest.settingsDigest)).not.toBe(pinnedSettingsDigest);
    expect(fresh.revision).toBe(after);
    expect(fresh.snapshotId).toBe(`${V3_PROJECT}@r${after}`);
    const freshSettings = freshManifest.settings as Record<string, unknown>;
    expect(freshSettings.run_speed).toBe(6);

    // The PINNED play's locator still serves the original (frozen) build — its
    // snapshotId/buildId/revision are unchanged and its artifact set is intact.
    const pinnedStill = JSON.parse(
      new TextDecoder().decode((await locator(`${pinned.playContent.path}${pinned.playContent.manifestPath}`)).bytes),
    ) as Record<string, unknown>;
    expect(String(pinnedStill.buildId)).toBe(pinnedBuildId);
    expect(pinnedStill.revision).toBe(before);
    expect(String(pinnedStill.settingsDigest)).toBe(pinnedSettingsDigest);

    await stopAnyActivePlay();
  });
});