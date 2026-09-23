/**
 * Packet 48 — the bounded §20 game control/observation relay over the REAL
 * transports: a real backend process, a real WS (the owner editor) and the real
 * stdio MCP SDK tools. Nothing simulates gameplay; the relay only forwards the
 * preview's exact result. The absent-browser/unpresented cases return the
 * contracted structured `session_unavailable` — never a fabricated success.
 *
 * The play record is exercised on the committed v3 fixture project; the relay
 * only forwards, so no game runs here (sessions.md §20).
 */
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  AUTHORING_ORIGIN,
  V2_AUTH_TOKEN,
  V2_PROJECT,
  V3_PROJECT,
  cleanupBundles,
  createMcp,
  establish,
  http,
  makeRoot,
  openWs,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
  type SessionInfo,
  type WsInbox,
} from './harness';
import { parseInboundEvent, validateGameControlResult, validateGameObservation } from '@thirdlight/protocol';

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;
let session: SessionInfo;
let ws: WsInbox;
let playSessionId = '';
let snapshotId = '';
let buildId = '';
let runId = '';

function controlResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    playSessionId,
    snapshotId,
    buildId,
    runId,
    command: 'start',
    state: 'playing',
    acceptedAtStep: 0,
    inputMode: 'physical',
    ...overrides,
  };
}

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    playSessionId,
    snapshotId,
    revision: 6,
    buildId,
    runId,
    stepIndex: 12,
    simTime: 0.1,
    state: 'playing',
    checkpointId: null,
    checkpointActive: false,
    deathCount: 0,
    goalReached: false,
    eventCount: 1,
    eventDropped: 0,
    failed: false,
    inputMode: 'physical',
    sound: { status: 'blocked', unlocked: false, voices: 0, muted: false, gesture: 'none' },
    events: [
      { id: `${runId}/runStarted/0`, kind: 'runStarted', stepIndex: 0, boundary: true, deathCount: 0 },
    ],
    observedAt: '2026-09-19T10:00:03Z',
    ...overrides,
  };
}

/** Reply to the next `game.control.request`/`game.observe.request` on the owner WS. */
async function replyToRelay(kind: 'control' | 'observe', payload: Record<string, unknown>, ok = true): Promise<Record<string, unknown>> {
  const request = await ws.waitFor(
    (e) => e.type === (kind === 'control' ? 'game.control.request' : 'game.observe.request'),
  );
  const ackType = kind === 'control' ? 'game.control.ack' : 'game.observe.ack';
  ws.send({
    type: ackType,
    relayId: request.relayId,
    ok,
    ...(ok ? { result: payload } : { error: { code: String(payload.code ?? 'game_relay_rejected') } }),
  });
  return request;
}

beforeAll(async () => {
  root = makeRoot('relay');
  bp = await spawnBackend(root, [
    { token: V2_AUTH_TOKEN, scope: `authoring:${V2_PROJECT}` },
    { token: AUTH_TOKEN, scope: `authoring:${V3_PROJECT}` },
    { token: ADMIN_TOKEN, scope: 'admin' },
  ]);
  mcp = await createMcp(bp.origin, V3_PROJECT, AUTH_TOKEN, 'packet-48-relay-mcp');
  session = await establish(bp.origin, V3_PROJECT, AUTH_TOKEN);
  ws = await openWs(bp.origin, session);
  const started = await mcp.call('tl_play_start', {});
  expect(started.isError, JSON.stringify(started.body)).toBe(false);
  playSessionId = String(started.body.playSessionId);
  snapshotId = String(started.body.snapshotId);
  buildId = String((started.body.playContent as { buildId: string }).buildId);
  runId = `${snapshotId}#0`;
  await ws.waitFor((e) => e.type === 'play.started' && e.playSessionId === playSessionId);
}, 90_000);

afterAll(async () => {
  cleanupBundles();
  ws?.close();
  await mcp?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('packet 48 — §20 relay tools are bounded and never fabricate', () => {
  it('the real stdio MCP exposes both relay tools', async () => {
    const names = await mcp.listTools();
    expect(names).toContain('tl_game_control');
    expect(names).toContain('tl_game_observe');
  });

  it('returns the contracted session_unavailable while the play is not presented', async () => {
    const res = await mcp.call('tl_game_control', { playSessionId, command: 'start' });
    expect(res.isError).toBe(true);
    const error = res.body.error as { code?: string; reason?: string };
    expect(error.code).toBe('session_unavailable');
    const observed = await mcp.call('tl_game_observe', { playSessionId });
    expect(observed.isError).toBe(true);
    expect((observed.body.error as { code?: string }).code).toBe('session_unavailable');
  });

  it('rejects an unknown play and a malformed control command structurally', async () => {
    const unknown = await mcp.call('tl_game_control', { playSessionId: `play-${'0'.repeat(32)}`, command: 'start' });
    expect(unknown.isError).toBe(true);
    expect((unknown.body.error as { code?: string }).code).toBe('play_not_found');
    const bad = await mcp.call('tl_game_control', { playSessionId, command: 'teleport' });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toBeDefined();
  });

  it('forwards an accepted control and returns the preview result verbatim', async () => {
    ws.send({ type: 'play.preview.ready', playSessionId });
    await new Promise((r) => setTimeout(r, 50));
    const call = mcp.call('tl_game_control', { playSessionId, command: 'start' });
    await replyToRelay('control', controlResult());
    const res = await call;
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    expect(res.body.playSessionId).toBe(playSessionId);
    expect(res.body.runId).toBe(runId);
    expect(res.body.command).toBe('start');
    expect(validateGameControlResult(res.body).ok, JSON.stringify(validateGameControlResult(res.body))).toBe(true);
  });

  it('forwards an observation and returns a bounded, binary-free document', async () => {
    const call = mcp.call('tl_game_observe', { playSessionId, timeoutMs: 2000 });
    await replyToRelay('observe', observation());
    const res = await call;
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    expect(validateGameObservation(res.body).ok, JSON.stringify(validateGameObservation(res.body))).toBe(true);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('base64');
    expect(text.length).toBeLessThanOrEqual(16_384);
    expect(res.body.sound).toMatchObject({ status: 'blocked', unlocked: false });
  });

  it('refuses a stale expectedRunId with game_run_stale and the current run identity, applying nothing', async () => {
    const res = await mcp.call('tl_game_control', { playSessionId, command: 'replay', expectedRunId: `${snapshotId}#99` });
    expect(res.isError).toBe(true);
    const error = res.body.error as { code?: string; runId?: string };
    expect(error.code).toBe('game_run_stale');
    expect(error.runId).toBe(runId);
  });

  it('times out a relay the preview never answers (game_relay_timeout, 503)', async () => {
    const res = await mcp.call('tl_game_observe', { playSessionId, timeoutMs: 250 });
    expect(res.isError).toBe(true);
    expect((res.body.error as { code?: string }).code).toBe('game_relay_timeout');
    expect(res.body.__httpStatus).toBe(503);
  });

  it('drops a wrong-session ack and never resolves a relay from it', async () => {
    // A WS attached to a DIFFERENT project's session is not the play owner.
    const other = await establish(bp.origin, V2_PROJECT, V2_AUTH_TOKEN);
    const otherWs = await openWs(bp.origin, other);
    const call = mcp.call('tl_game_observe', { playSessionId, timeoutMs: 400 });
    const request = await ws.waitFor((e) => e.type === 'game.observe.request');
    otherWs.send({ type: 'game.observe.ack', relayId: request.relayId, ok: true, result: observation() });
    const res = await call;
    otherWs.close();
    expect(res.isError).toBe(true);
    expect((res.body.error as { code?: string }).code).toBe('game_relay_timeout');
  });

  it('keeps the session log bounded and free of credentials/capabilities/paths', async () => {
    const res = await http(`${bp.origin}/api/v1/sessions/${session.sessionId}/log?limit=128`, {
      token: AUTH_TOKEN,
      origin: AUTHORING_ORIGIN,
    });
    expect(res.status).toBe(200);
    const body = res.body as { total: number; entries: Array<{ kind: string; ref?: string }> };
    expect(body.entries.length).toBeLessThanOrEqual(128);
    const text = JSON.stringify(body);
    expect(text).not.toContain(AUTH_TOKEN);
    expect(text).not.toContain('/home/');
    expect(text).not.toContain('contentId');
  });
});

describe('packet 48 — §20 wire shapes are strict and bounded', () => {
  it('accepts a well-formed game.control.ack and rejects a malformed one', () => {
    const good = parseInboundEvent({ type: 'game.control.ack', relayId: `relay-${'a'.repeat(32)}`, ok: true, result: controlResult() });
    expect(good.ok).toBe(true);
    const bad = parseInboundEvent({ type: 'game.control.ack', relayId: `relay-${'a'.repeat(32)}`, ok: true, result: { ok: true } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe('protocol_error');
  });

  it('rejects an observation carrying binary and one over the event bound', () => {
    expect(validateGameObservation(observation()).ok).toBe(true);
    const withBinary = observation({ events: [new Uint8Array([1, 2, 3])] } as Record<string, unknown>);
    expect(validateGameObservation(withBinary).ok).toBe(false);
    const tooMany = observation({ events: Array.from({ length: 33 }, (_, i) => ({ id: `e${i}`, kind: 'died', stepIndex: i, boundary: false, deathCount: i })) });
    expect(validateGameObservation(tooMany).ok).toBe(false);
  });

  it('rejects a control result missing the identity tuple', () => {
    const missing = controlResult();
    delete missing.buildId;
    expect(validateGameControlResult(missing).ok).toBe(false);
  });
});
