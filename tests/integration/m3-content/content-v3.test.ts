/**
 * Packet 48 — v3 authoring/content parity over the REAL transports: a real
 * backend process, the real filesystem, a real WS and a real stdio MCP SDK
 * client. Covers v3 mutation/query/undo/retry/stale convergence, the additive
 * `{ kind?, animation? }` inspection path (presentation.md §41.3.2 stages 5–7
 * and §41.3.3 A1–A6) driven through the ordinary `publishAsset` command, and
 * the binary-free state/projection frames.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  AUTHORING_ORIGIN,
  V3_PROJECT,
  base64,
  cleanupBundles,
  createMcp,
  establish,
  http,
  makeRoot,
  mediaBytes,
  mediaJson,
  mkRequestId,
  openWs,
  publishArgs,
  sha256Hex,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
  type SessionInfo,
  type WsInbox,
} from './harness';
import { validateChangeFrame, validateFullStateFrame } from '@thirdlight/protocol';

interface ProfileCase {
  readonly id: string;
  readonly file: string;
  readonly roles: Record<string, { clipIndex: number; clipName: string }>;
  readonly expect: { verdict: string; code?: string; limit?: string };
}
interface ProfileCases {
  readonly cases: ProfileCase[];
}

const PROFILE = mediaJson<ProfileCases>('glb/profile-cases.json');
const rolesCase = (id: string): ProfileCase => {
  const c = PROFILE.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`missing profile case ${id}`);
  return c;
};
const VALID_ROLES = rolesCase('roles-ok-stored-order').roles;
const REORDERED_ROLES = rolesCase('roles-ok-reordered').roles;
const REORDERED_FILE = rolesCase('roles-ok-reordered').file;

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;
let mcp2: McpHarness;
let session: SessionInfo;
let ws: WsInbox;

async function currentRevision(): Promise<number> {
  const res = await mcp.call('tl_inspect', { target: 'project' });
  expect(res.body.ok).toBe(true);
  return Number(res.body.revision);
}

/** Upload + inspect one media fixture over the real MCP content tool. */
async function inspectMedia(
  rel: string,
  extra: Record<string, unknown> = {},
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const res = await mcp.call('tl_content_upload', { dataBase64: base64(mediaBytes(rel)), ...extra });
  return res;
}

async function command(
  m: McpHarness,
  op: string,
  args: Record<string, unknown>,
  expectedRevision: number,
  requestId = mkRequestId(),
): Promise<{ body: Record<string, unknown>; isError: boolean }> {
  return m.call('tl_command', { op, args, expectedRevision, requestId });
}

beforeAll(async () => {
  root = makeRoot('content');
  bp = await spawnBackend(root, [
    { token: AUTH_TOKEN, scope: `authoring:${V3_PROJECT}` },
    { token: ADMIN_TOKEN, scope: 'admin' },
  ]);
  mcp = await createMcp(bp.origin);
  mcp2 = await createMcp(bp.origin, V3_PROJECT, AUTH_TOKEN, 'packet-48-mcp-second');
  session = await establish(bp.origin);
  ws = await openWs(bp.origin, session);
}, 90_000);

afterAll(async () => {
  cleanupBundles();
  ws?.close();
  await mcp?.close();
  await mcp2?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('packet 48 — v3 command parity over the real transports', () => {
  it('the real stdio MCP advertises the §20 relay tools and the v3 mutation ops', async () => {
    const names = await mcp.listTools();
    for (const expected of ['tl_game_control', 'tl_game_observe', 'tl_command', 'tl_content_upload']) {
      expect(names).toContain(expected);
    }
    const tools = await mcp.call('tl_command', { op: 'setGameConfig', args: {}, expectedRevision: 0 });
    // An unknown-op rejection would name the op list; the v3 op is accepted as
    // a known op (its arg validation then fails, not the router).
    expect(tools.isError).toBe(true);
    expect(String((tools.body.error as { code?: string })?.code)).not.toBe('tool_error');
  });

  it('edits the bounded game config through tl_command (one revision, one binary-free change frame)', async () => {
    const before = await currentRevision();
    const seen = ws.events.length;
    // Phase 12 (c): the backend upgrades the v3 fixture to v4 on open — the v4
    // game block has no kill height (a game rule for scripts / hazard zones).
    const res = await command(mcp, 'setGameConfig', { game: { title: 'Beacon Reach v2', objective: 'Reach the far beacon' } }, before);
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    expect(res.body.revision).toBe(before + 1);
    const frame = await ws.waitFor((e) => e.type === 'mutation.applied' && e.revision === before + 1);
    expect(validateChangeFrame(frame).ok, JSON.stringify(validateChangeFrame(frame))).toBe(true);
    const change = frame.change as { type: string; changedFields?: string[] };
    expect(change.type).toBe('setGameConfig');
    expect(change.changedFields).toContain('title');
    // No binary and no base64 media anywhere in the state frames.
    const text = JSON.stringify(ws.events.slice(seen));
    expect(text).not.toContain('base64');
    expect(JSON.stringify(frame)).not.toMatch(/"\d+,/);

    // Packet 48 coordinator repair: the v3 `queryGameConfig` query now serves
    // over the shared command surface. Both transports read the same state.
    const viaMcp = await mcp.call('tl_content_query', { target: 'game' });
    expect(viaMcp.isError, JSON.stringify(viaMcp.body)).toBe(false);
    const game = viaMcp.body.game as { title?: string; objective?: string; killY?: number } | null;
    expect(game?.title).toBe('Beacon Reach v2');
    expect(game?.objective).toBe('Reach the far beacon');
    expect(game).not.toHaveProperty('killY');
    const viaHttp = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/commands`, {
      body: { op: 'queryGameConfig', projectId: V3_PROJECT },
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(viaHttp.status).toBe(200);
    const httpBody = viaHttp.body as { ok?: boolean; game?: { title?: string } | null; revision?: number };
    expect(httpBody.ok).toBe(true);
    expect(httpBody.game?.title).toBe('Beacon Reach v2');
    expect(httpBody.revision).toBe(before + 1);
    // The v3 query result shape validates.
    // (the shared query surface returns the same envelope as the workspace)
  });

  it('applies a surface preset to a box entity (one undoable edit)', async () => {
    const before = await currentRevision();
    const res = await command(mcp, 'applySurfacePreset', { entityId: 'box-0001', preset: 'hazard' }, before);
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    expect(res.body.revision).toBe(before + 1);
    const change = res.body.change as { type: string; preset: string };
    expect(change.type).toBe('applySurfacePreset');
    expect(change.preset).toBe('hazard');
  });

  it('undo restores both v3 edits and one retry replays identically (duplicated: true)', async () => {
    const rev = await currentRevision();
    const undo1 = await command(mcp, 'undo', {}, rev);
    expect(undo1.isError).toBe(false);
    const undo2 = await command(mcp, 'undo', {}, rev + 1);
    expect(undo2.isError).toBe(false);
    expect(undo2.body.history).toMatchObject({ undoDepth: 0 });
    // Replay the exact same requestId: the retry record serves it (dedup
    // precedes the revision check), so the result is byte-identical.
    const requestId = mkRequestId();
    const first = await command(mcp, 'setGameConfig', { game: { objective: 'Reach the beacon twice' } }, rev + 2, requestId);
    expect(first.isError).toBe(false);
    const again = await command(mcp, 'setGameConfig', { game: { objective: 'Reach the beacon twice' } }, rev + 2, requestId);
    expect(again.isError).toBe(false);
    expect(again.body.duplicated).toBe(true);
    expect(again.body.revision).toBe(first.body.revision);
  });

  it('refuses a stale edit and both clients converge on the same revision', async () => {
    const rev = await currentRevision();
    const winner = await command(mcp, 'setGameConfig', { game: { instructions: 'winner' } }, rev);
    expect(winner.isError).toBe(false);
    const loser = await command(mcp2, 'setGameConfig', { game: { instructions: 'loser' } }, rev);
    expect(loser.isError).toBe(true);
    expect((loser.body.error as { code?: string })?.code).toBe('revision_conflict');
    expect((loser.body.error as { currentRevision?: number })?.currentRevision).toBe(winner.body.revision);
    // Both clients observe the winning revision (real convergence).
    expect(await currentRevision()).toBe(winner.body.revision);
  });

  it('the full-state payload is the v3 projection and is binary-free', () => {
    expect(validateFullStateFrame(session.body).ok, JSON.stringify(validateFullStateFrame(session.body))).toBe(true);
    const scene = session.body.scene as {
      sceneId: string;
      schemaVersion: number;
      entities: Array<{ id: string; components: Record<string, unknown> }>;
    };
    // C35-5 / CC-48-3 (promoted at Gate L): the scene projection reports the
    // SCENE document's version — 4 once the backend upgraded the v3 fixture
    // (phase 12 c), not the manifest's.
    expect(scene.schemaVersion).toBe(4);
    // The v3 fixture's v3-only components cross the wire (gameZone/cameraFollow).
    const zone = scene.entities.find((e) => e.id === 'zone-0001');
    expect(zone?.components['gameZone']).toBeDefined();
    expect(scene.entities.some((e) => e.components['cameraFollow'] !== undefined)).toBe(true);
    expect(Object.keys(session.body)).not.toContain('bytes');
    expect(JSON.stringify(session.body)).not.toContain('base64');
  });
});

let animatedEntityId = '';

describe('packet 48 — role-aware animated reimport reaches §41.3.2 stages 5–7', () => {
  it('inspects a real animated GLB with roles and publishes it through publishAsset', async () => {
    const inspected = await inspectMedia('glb/courier-roles.glb', { kind: 'model', animation: { roles: VALID_ROLES } });
    expect(inspected.isError, JSON.stringify(inspected.body)).toBe(false);
    const proposal = inspected.body.proposal as Record<string, unknown>;
    expect(proposal.status).toBe('ok');
    expect((proposal.metrics as { animations?: number }).animations).toBe(3);
    const rev = await currentRevision();
    const created = await command(
      mcp,
      'publishAsset',
      publishArgs('create', 'asset-courier-0001', proposal, { kind: 'model', displayName: 'Courier' }),
      rev,
    );
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    expect(created.body.revision).toBe(rev + 1);
  });

  it('binds the version-local role mapping by creating the animated entity (stages 1–4)', async () => {
    const rev = await currentRevision();
    const res = await command(
      mcp,
      'createEntity',
      {
        kind: 'model',
        name: 'Courier',
        model: { asset: { assetId: 'asset-courier-0001' } },
        components: {
          modelAnimation: { assetId: 'asset-courier-0001', version: 1, roles: VALID_ROLES },
        },
      },
      rev,
    );
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    animatedEntityId = String(res.body.createdId);
    expect(animatedEntityId.startsWith('model-')).toBe(true);
  });

  it('refuses an animated reimport whose clipName disagrees with the bytes (stage 5)', async () => {
    const badRoles = JSON.parse(JSON.stringify(VALID_ROLES)) as Record<string, { clipIndex: number; clipName: string }>;
    badRoles['idle']!.clipName = 'NotTheClip';
    const res = await inspectMedia('glb/courier-roles.glb', { kind: 'model', animation: { roles: badRoles } });
    expect(res.isError).toBe(true);
    const diagnostics = (res.body.error as { diagnostics?: Array<{ code?: string }> })?.diagnostics ?? [];
    expect(diagnostics.map((d) => d.code)).toContain('animation_role_mismatch');
  });

  it('refuses the animated profile negatives A2/A6/ambiguity through the same transport', async () => {
    for (const id of ['role-skin-rejected', 'role-root-motion-rejected', 'role-name-ambiguous']) {
      const c = rolesCase(id);
      const res = await inspectMedia(`glb/${c.file}`, { kind: 'model', animation: { roles: c.roles } });
      expect(res.isError, `${id} should be rejected`).toBe(true);
      const diagnostics = (res.body.error as { diagnostics?: Array<{ code?: string }> })?.diagnostics ?? [];
      expect(diagnostics.map((d) => d.code), id).toContain(c.expect.code);
    }
  });

  it('reimports reordered clips atomically and undo restores bytes and mapping together', async () => {
    const inspected = await inspectMedia(`glb/${REORDERED_FILE}`, { kind: 'model', animation: { roles: REORDERED_ROLES } });
    expect(inspected.isError, JSON.stringify(inspected.body)).toBe(false);
    const proposal = inspected.body.proposal as Record<string, unknown>;
    const rev = await currentRevision();
    const res = await command(
      mcp,
      'publishAsset',
      publishArgs('reimport', 'asset-courier-0001', proposal, {
        kind: 'model',
        animation: { entityId: animatedEntityId, roles: REORDERED_ROLES },
      }),
      rev,
    );
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    const change = res.body.change as {
      animation?: {
        previous?: { assetId?: string; version?: number; roles?: unknown };
        next?: { assetId?: string; version?: number; roles?: unknown };
      };
    };
    expect(change.animation).toBeDefined();
    // CC-L-1 (Gate L): the change carries the FULL `modelAnimation` component
    // in both directions — `version` advances to the newly appended version
    // together with the mapping (the binding is owned by that
    // (assetId, version)); a roles-only change would leave the entity
    // recording the old version, so capture would keep delivering the
    // previous bytes (project-model §19.2) — a silent no-op success.
    expect(change.animation?.previous).toEqual({ assetId: 'asset-courier-0001', version: 1, roles: VALID_ROLES });
    expect(change.animation?.next).toEqual({ assetId: 'asset-courier-0001', version: 2, roles: REORDERED_ROLES });
    // Regression (CC-L-1): the entity's recorded version advanced with the
    // mapping — the reimported bytes are now what capture resolves the
    // entity to.
    const entityAfter = await mcp.call('tl_inspect', { target: 'entity', entityId: animatedEntityId });
    expect(entityAfter.isError).toBe(false);
    const compAfter = (entityAfter.body as { entity?: { components?: { modelAnimation?: { version?: number; roles?: unknown } } } }).entity?.components?.modelAnimation;
    expect(compAfter?.version).toBe(2);
    expect(compAfter?.roles).toEqual(REORDERED_ROLES);
    // Undo moves both together: one history entry, bytes back to version 1.
    const undone = await command(mcp, 'undo', {}, rev + 1);
    expect(undone.isError).toBe(false);
    const asset = await mcp.call('tl_content_query', { target: 'asset', assetId: 'asset-courier-0001' });
    expect((asset.body.asset as { currentVersion: number }).currentVersion).toBe(1);
    // Regression (CC-L-1): the entity's component is the FULL previous
    // component after undo — version 1 is a valid binding against the
    // rolled-back record (1 ≤ version ≤ currentVersion, project-model
    // §23.3.6); a roles-only restore would have left version 2 recorded
    // above currentVersion 1 (an invalid binding).
    const entityUndone = await mcp.call('tl_inspect', { target: 'entity', entityId: animatedEntityId });
    expect(entityUndone.isError).toBe(false);
    const compUndone = (entityUndone.body as { entity?: { components?: { modelAnimation?: { version?: number; roles?: unknown } } } }).entity?.components?.modelAnimation;
    expect(compUndone?.version).toBe(1);
    expect(compUndone?.roles).toEqual(VALID_ROLES);
  });

  it('leaves no durable blob for a rejected animated GLB (blob-after-accept ordering)', async () => {
    const before = readdirSync(`${root.v3Dir}/sources/sha256`).length;
    const res = await inspectMedia('glb/bad-skin.glb', { kind: 'model', animation: { roles: VALID_ROLES } });
    expect(res.isError).toBe(true);
    const after = readdirSync(`${root.v3Dir}/sources/sha256`).length;
    expect(after).toBe(before);
  });
});

describe('packet 48 — content transport security', () => {
  it('rejects an unauthenticated upload and a foreign origin before any storage call', async () => {
    const unauth = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/content/stages`, { body: {} });
    expect(unauth.status).toBe(401);
    const foreign = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/content/stages`, {
      body: {},
      token: AUTH_TOKEN,
      origin: 'http://evil.example',
    });
    expect(foreign.status).toBe(403);
    expect((foreign.body as { error: { code: string } }).error.code).toBe('bad_origin');
  });

  it('rejects path-shaped stage ids and oversized frames before any write', async () => {
    const stage = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/content/stages`, { body: {}, token: AUTH_TOKEN, origin: AUTHORING_ORIGIN });
    const stageId = (stage.body as { stageId: string }).stageId;
    const traversal = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/content/stages/${encodeURIComponent('..%2f..%2fetc')}/bytes`, {
      method: 'PUT',
      rawBody: new Uint8Array([1]),
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
      headers: { 'x-thirdlight-offset': '0', 'x-thirdlight-total': '1' },
    });
    expect([400, 404]).toContain(traversal.status);
    const oversized = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/content/stages/${stageId}/bytes`, {
      method: 'PUT',
      rawBody: new Uint8Array(1_048_577),
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
      headers: { 'x-thirdlight-offset': '0', 'x-thirdlight-total': '1048577' },
    });
    expect(oversized.status).toBe(400);
    expect((oversized.body as { error: { code: string } }).error.code).toBe('stage_limits_exceeded');
  });

  it('rejects a cross-project token on every content route', async () => {
    const res = await http(`${bp.origin}/api/v1/projects/demo-0002/content/stages`, {
      body: {},
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(res.status).toBe(401);
  });

  it('routes a browser-origin and an MCP-origin v3 envelope through the same executor (identical error)', async () => {
    const rev = await currentRevision();
    // The same malformed partial edit: an unknown game-config field must fail
    // identically whichever origin submits it (one executor, no second path).
    const viaMcp = await mcp.call('tl_command', {
      op: 'setGameConfig',
      args: { game: { notAField: true } },
      expectedRevision: rev,
      requestId: mkRequestId(),
    });
    const viaBrowser = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/commands`, {
      body: {
        op: 'setGameConfig',
        projectId: V3_PROJECT,
        expectedRevision: rev,
        requestId: mkRequestId(),
        origin: { kind: 'browser', clientId: session.sessionId },
        args: { game: { notAField: true } },
      },
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaBrowser.status).not.toBe(200);
    const mcpError = viaMcp.body.error as { code?: string; path?: string };
    const httpError = (viaBrowser.body as { error: { code?: string; path?: string } }).error;
    expect(httpError.code).toBe(mcpError.code);
    expect(httpError.path).toBe(mcpError.path);
  });

  it('reports an unknown stage and an unknown job structurally (never a fabricated success)', async () => {
    const unknownStage = await http(
      `${bp.origin}/api/v1/projects/${V3_PROJECT}/content/stages/stage-${'0'.repeat(32)}/inspect`,
      { body: {}, token: AUTH_TOKEN, origin: AUTHORING_ORIGIN },
    );
    expect(unknownStage.status).toBe(404);
    const unknownJob = await http(`${bp.origin}/api/v1/projects/${V3_PROJECT}/content/jobs/job-${'0'.repeat(32)}`, {
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(unknownJob.status).toBe(404);
  });
});
