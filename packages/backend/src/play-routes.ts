import { type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeDiagnosticsRequest, makeInputRelayRequest, makePlayStarted, makeScreenshotRequest, parseAdminNoArgsBody, parseInputRelayRequest, parsePlayStartRequest, parseScreenshotRequest, parseStrictJsonBytes, sessionError, statusFor, WS_OUT_FRAME_MAX, makeGameControlRequest, makeGameObserveRequest, parseGameControlRequest, parseGameObserveRequest, GAME_CONTROL_BODY_MAX_BYTES, GAME_OBSERVE_BODY_MAX_BYTES, type RuntimeSnapshotDoc, type SessionError } from '@thirdlight/protocol';
import { type CommandError, type QueryResult, type WorkspaceService } from '@thirdlight/workspace';
import { type BackendConfig } from './config';
import { createBehaviorCompilerPort } from './content';
import { PlayContentStore, type PlayArtifact } from './play-content';
import { buildPlayContentM3 } from './play-m3';
import { SessionRegistry, type SessionRecord } from './sessions';
import { PlayManager, type PlayRecord, type RelayOutcome, type InputRelayOutcome, type GameRelayOutcome, type GameRelayCode } from './play';

// ---- ID / token allocation (sessions.md §3: hex, CSPRNG) ----------------------

import type { Problem } from './backend';
import { MAX_DIAGNOSTICS, MAX_SCREENSHOT, hex, newPlaySessionId, newRelayId, utf8Len, type OriginDoc } from './util';

export interface PlayRoutesContext {
  readonly config: BackendConfig;
  readonly nowMs: () => number;
  readonly logStartup: (message: string) => void;
  readonly behaviorCompiler: ReturnType<typeof createBehaviorCompilerPort>;
  readonly service: WorkspaceService;
  readonly sessions: SessionRegistry;
  readonly playContent: PlayContentStore;
  readonly plays: PlayManager;
  readonly relayTimeoutMs: () => number;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  readonly bearerToken: (req: IncomingMessage) => string | null;
  readonly tokenScope: (token: string | null, req?: IncomingMessage) => string | null;
  readonly badOriginError: (found: string) => SessionError;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly readBody: (req: IncomingMessage) => Promise<{ ok: true; bytes: Uint8Array; } | { ok: false; error: SessionError; }>;
  readonly fullState: (projectId: string) => { ok: true; revision: number; manifest: Record<string, unknown>; scene: Record<string, unknown>; history: Record<string, unknown>; workspace: Record<string, unknown>; content?: Record<string, unknown>; } | { ok: false; error: SessionError; status: number; };
  readonly workspaceError: (e: CommandError) => SessionError;
  readonly connectedOwner: (rec: PlayRecord) => SessionRecord | undefined;
  readonly unavailableError: (playSessionId: string | undefined, hint: string) => SessionError;
  readonly recordProblem: (projectId: string, source: Problem["source"], code: string, message: string) => void;
}

export function makePlayRoutes(ctx: PlayRoutesContext) {
  const { config, nowMs, logStartup, behaviorCompiler, service, sessions, playContent, plays, relayTimeoutMs, sendJson, sendError, bearerToken, tokenScope, badOriginError, requireAuth, readBody, fullState, workspaceError, connectedOwner, unavailableError, recordProblem } = ctx;

  /** The prebuilt play bundle bytes served as `game.js` (bounded read). */
  const readGameBundle = (file = 'preview-m3.js'): Uint8Array | null => {
    const path = join(config.previewStaticDir, file);
    try {
      if (!existsSync(path) || !statSync(path).isFile()) return null;
      const bytes = new Uint8Array(readFileSync(path));
      if (bytes.length === 0 || bytes.length > 33_554_432) return null;
      return bytes;
    } catch {
      return null;
    }
  };

  /** A UTC second stamp in the project-model §7.2 format. */
  const utcSecond = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const playStartRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const scope = tokenScope(bearerToken(req), req);
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const parsedReq = parsePlayStartRequest(strict.value);
    if (!parsedReq.ok) {
      sendError(res, parsedReq.error);
      return;
    }
    // Preconditions (§10.1), in order.
    const probe = service.query({ op: 'queryProject', projectId }) as QueryResult;
    if (!probe.ok) {
      sendError(res, workspaceError(probe.error), statusFor(probe.error.cls));
      return;
    }
    const session = sessions.sessionForProject(projectId);
    if (session === undefined) {
      sendError(res, unavailableError(undefined, 'connect the editor browser: no registered authoring session for this project'), 503);
      return;
    }
    if (parsedReq.request.sessionId !== undefined && parsedReq.request.sessionId !== session.sessionId) {
      sendError(res, sessionError('session_not_found', 'not_found', 'that browser session is not the active session for this project', { activeSessionId: session.sessionId }), 404);
      return;
    }
    const active = plays.activeFor(projectId);
    if (active !== undefined) {
      sendError(
        res,
        sessionError('play_already_active', 'conflict', 'a play session is already active for this project', {
          activePlaySessionId: active.playSessionId,
        }),
        409,
      );
      return;
    }
    // Build the runtime snapshot at the CURRENT revision (the play's
    // revision is frozen from here — §10.2).
    const state = fullState(projectId);
    if (!state.ok) {
      sendError(res, state.error, state.status);
      return;
    }
    const snapshotId = `${projectId}@r${state.revision}`;
    // C35-5 / sessions.md §19.x: the SCENE document's `schemaVersion` (1/2/3).
    // The full-state projection now carries it directly.
    const sceneSchemaVersion =
      typeof state.scene.schemaVersion === 'number'
        ? state.scene.schemaVersion
        : state.content !== undefined
          ? 2
          : 1;
    const snapshot: RuntimeSnapshotDoc = {
      snapshotId,
      projectId,
      revision: state.revision,
      scene: {
        schemaVersion: sceneSchemaVersion,
        sceneId: state.scene.sceneId as string,
        revision: state.revision,
        entities: state.scene.entities as ReadonlyArray<Record<string, unknown>>,
      },
    };
    const playSessionId = newPlaySessionId();
    const now = nowMs();
    // Packet 35: build the immutable runtime-content manifest + artifact set
    // BEFORE the play record exists (a failed build writes nothing and leaves
    // the previous artifact/locator untouched — delivery §2.2). Each branch
    // reads its own prebuilt play bundle (M2 `preview.js` / M3 `preview-m3.js`).
    // Play builds the SHARED M3 closure from the captured v3 content (the
    // single acknowledged envelope read — readCapturedV3).
    // Only current (v3) projects play; older schema versions are no longer supported.
    if (sceneSchemaVersion !== 3 && sceneSchemaVersion !== 4) {
      sendError(
        res,
        sessionError('play_build_unavailable', 'validation', `this project uses scene schema v${sceneSchemaVersion}; only v3 projects can play`, { reason: 'version_unsupported' }),
        409,
      );
      return;
    }
    let builtCore: { buildId: string; contentDigest: string; manifestBytes: Uint8Array; artifacts: readonly PlayArtifact[] };
    {
      const captured = service.readCapturedV3(projectId);
      if (!captured.ok) {
        sendError(res, workspaceError(captured.error), statusFor(captured.error.cls));
        return;
      }
      if (captured.read.revision !== state.revision) {
        sendError(
          res,
          sessionError('play_build_unavailable', 'conflict', 'the captured revision changed before the play build', { reason: 'revision_conflict' }),
          409,
        );
        return;
      }
      // The v3 play bundle (the M3 preview wrapper entry — the single shared
      // createGameHost composition), served as the locator's game.js.
      const gameBundleM3 = readGameBundle('preview-m3.js');
      if (gameBundleM3 === null) {
        sendError(
          res,
          sessionError('play_build_unavailable', 'unavailable', 'the prebuilt M3 play bundle is missing (run the workspace build)', {
            reason: 'game_bundle_missing',
          }),
          503,
        );
        return;
      }
      // Phase 12 (c): a v4 project plays its start scenes (merged) and ships
      // every scene for on-demand loading.
      const v4 = captured.read.scenes !== undefined;
      if (v4) snapshot.scene = captured.read.scene as RuntimeSnapshotDoc['scene'];
      const builtM3 = await buildPlayContentM3({
        service,
        compiler: behaviorCompiler,
        projectId,
        revision: state.revision,
        capturedAt: utcSecond(now),
        scene: v4
          ? (captured.read.scene as { schemaVersion: number; sceneId: string; revision: number; entities: ReadonlyArray<Record<string, unknown>> })
          : {
              schemaVersion: 3,
              sceneId: state.scene.sceneId as string,
              revision: state.revision,
              entities: state.scene.entities as ReadonlyArray<Record<string, unknown>>,
            },
        content: captured.read.content as Record<string, unknown>,
        gameBundle: gameBundleM3,
        ...(v4 ? { scenes: captured.read.scenes!, startScenes: captured.read.startScenes ?? [] } : {}),
      });
      if (!builtM3.ok) {
        recordProblem(projectId, 'play', builtM3.error.code, `Play build failed: ${builtM3.error.message}`);
        sendError(res, builtM3.error, statusFor(builtM3.error.cls));
        return;
      }
      // The preview verifies the snapshot's game block against the manifest.
      snapshot.game = (captured.read.content as { game?: unknown }).game ?? null;
      // Phase 12 (b): the tag registry, when the project defines tags (the
      // preview checks it against the manifest).
      const tags = (captured.read.content as { tags?: unknown[] }).tags;
      if (Array.isArray(tags) && tags.length > 0) (snapshot as { tags?: unknown }).tags = tags;
      builtCore = {
        buildId: builtM3.built.buildId,
        contentDigest: builtM3.built.contentDigest,
        manifestBytes: builtM3.built.manifestBytes,
        artifacts: builtM3.built.artifacts,
      };
    }
    const published = playContent.publish({
      playSessionId,
      projectId,
      revision: state.revision,
      snapshotId,
      buildId: builtCore.buildId,
      contentDigest: builtCore.contentDigest,
      manifestBytes: builtCore.manifestBytes,
      artifacts: builtCore.artifacts,
    });
    if (!published.ok) {
      sendError(res, published.error, statusFor(published.error.cls));
      return;
    }
    const rec = plays.add(playSessionId, projectId, session.sessionId, snapshot, parsedReq.request.demo, builtCore.buildId, now);
    session.playSessionId = playSessionId;
    // `startedBy` = who started the play. The one owner token is used by the
    // browser and by tools alike; a browser request carries an Origin
    // header, a tool/operator request does not.
    const startedBy: OriginDoc | null =
      scope === 'admin' && req.headers.origin === undefined ? { kind: 'admin', clientId: 'operator' } : { kind: 'browser', clientId: session.sessionId };
    const payload = makePlayStarted({
      playSessionId,
      startedBy,
      snapshot,
      playContent: { contentId: published.contentId, buildId: builtCore.buildId, path: `/play-content/${published.contentId}/` },
    });
    let delivered = false;
    if (session.connected && session.socket) {
      try {
        if (utf8Len(payload) <= WS_OUT_FRAME_MAX) {
          session.socket.send(payload);
          delivered = true;
        } else {
          logStartup('play.started frame exceeds the 1 MiB bound; held (internal)');
        }
      } catch {
        delivered = false;
      }
    }
    if (!delivered) {
      // Held for one-shot delivery on the owner's (re)attach (§7.1).
      session.pendingPlayStarted = { playSessionId, payload };
    }
    sessions.record(session, 'play', playSessionId, rec.revision, now, 'started');
    sendJson(res, 200, {
      ok: true,
      playSessionId,
      playBase: `${config.previewOrigin}/`,
      snapshotId,
      revision: rec.revision,
      demo: rec.demo,
      expiresAt: new Date(rec.expiresAt).toISOString(),
      playContent: {
        contentId: published.contentId,
        buildId: builtCore.buildId,
        path: `/play-content/${published.contentId}/`,
        manifestPath: 'manifest.json',
        expiresAt: new Date(published.set.expiresAtMs).toISOString(),
      },
    });
  };

  const playStopRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string, playSessionId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const noArgs = parseAdminNoArgsBody(strict.value);
    if (!noArgs.ok) {
      sendError(res, noArgs.error);
      return;
    }
    const rec = plays.get(playSessionId);
    if (rec === undefined || rec.projectId !== projectId || (rec.state !== 'active' && rec.state !== 'presented')) {
      sendError(res, sessionError('play_not_found', 'not_found', 'no active play session with this id', { playSessionId }), 404);
      return;
    }
    const owner = connectedOwner(rec);
    if (owner === undefined) {
      sendError(res, unavailableError(rec.playSessionId, 'the editor browser must be connected to stop this play'), 503);
      return;
    }
    sessions.record(owner, 'play', rec.playSessionId, rec.revision, nowMs(), 'stop_requested');
    plays.stop(rec, 'request');
    sendJson(res, 200, { ok: true, playSessionId });
  };

  const relayRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    playSessionId: string,
    kind: 'screenshot' | 'diagnostics',
  ): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    let maxWidth: number | undefined;
    if (kind === 'screenshot') {
      const parsedReq = parseScreenshotRequest(strict.value);
      if (!parsedReq.ok) {
        sendError(res, parsedReq.error);
        return;
      }
      maxWidth = parsedReq.request.maxWidth;
    } else {
      const noArgs = parseAdminNoArgsBody(strict.value);
      if (!noArgs.ok) {
        sendError(res, noArgs.error);
        return;
      }
    }
    // Preconditions (§12 step 2), in order: exists → presented → owner WS
    // connected.
    const rec = plays.get(playSessionId);
    if (rec === undefined || rec.projectId !== projectId || (rec.state !== 'active' && rec.state !== 'presented')) {
      sendError(res, sessionError('play_not_found', 'not_found', 'no active play session with this id', { playSessionId }), 404);
      return;
    }
    if (rec.state !== 'presented') {
      sendError(res, unavailableError(rec.playSessionId, 'the preview is not ready: the play is not yet presented'), 503);
      return;
    }
    const owner = connectedOwner(rec);
    if (owner === undefined) {
      sendError(res, unavailableError(rec.playSessionId, 'the editor browser must be connected for this live action'), 503);
      return;
    }
    const relayId = newRelayId();
    const payload =
      kind === 'screenshot' ? makeScreenshotRequest(relayId, maxWidth) : makeDiagnosticsRequest(relayId);
    const outcome: RelayOutcome = await plays.relay(rec.playSessionId, kind, relayId, payload);
    sessions.record(owner, kind, relayId, rec.revision, nowMs(), outcome.ok ? 'ok' : (outcome.ok ? undefined : outcome.code));
    if (outcome.ok && outcome.kind === 'screenshot') {
      if (outcome.dataUrl.length > MAX_SCREENSHOT) {
        sendError(res, sessionError('relay_failed', 'unavailable', 'screenshot dataUrl exceeds the 1 MiB bound', { cause: 'dataUrl_too_large' }), 503);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        playSessionId,
        snapshotId: rec.snapshotId,
        revision: rec.revision,
        width: outcome.width,
        height: outcome.height,
        dataUrl: outcome.dataUrl,
      });
      return;
    }
    if (outcome.ok && outcome.kind === 'diagnostics') {
      if (utf8Len(JSON.stringify(outcome.diagnostics)) > MAX_DIAGNOSTICS) {
        sendError(res, sessionError('relay_failed', 'unavailable', 'diagnostics exceed the 16 KiB bound', { cause: 'diagnostics_too_large' }), 503);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        playSessionId,
        snapshotId: rec.snapshotId,
        revision: rec.revision,
        diagnostics: outcome.diagnostics,
      });
      return;
    }
    const code =
      outcome.code === 'screenshot_timeout' || outcome.code === 'diagnostics_timeout'
        ? outcome.code
        : 'relay_failed';
    sendError(
      res,
      sessionError(code, 'unavailable', `${kind} relay ${outcome.code === 'relay_failed' ? 'failed' : 'timed out'}`, {
        relayId,
        ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      }),
      503,
    );
  };

  /**
   * `POST /api/v1/projects/:projectId/play/:playSessionId/input` — the bounded
   * input-exercise relay (sessions.md §18.1). The mode is exclusive: the frame
   * sequence is applied by the preview through the checked bridge, and the
   * result reports the applied step range plus the pinned snapshot/build
   * identity. No browser ⇒ the structured `session_unavailable` outcome.
   */
  const inputRelayRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    playSessionId: string,
  ): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    // The 16 KiB body bound is checked before the strict parse (§18.1.1).
    if (body.bytes.length > 16_384) {
      sendError(
        res,
        sessionError('input_relay_limits_exceeded', 'validation', 'the relay body exceeds the 16384-byte bound', {
          limit: 'body_bytes',
          current: body.bytes.length,
          max: 16_384,
        }),
        400,
      );
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const parsedReq = parseInputRelayRequest(strict.value);
    if (!parsedReq.ok) {
      sendError(res, parsedReq.error, statusFor(parsedReq.error.cls));
      return;
    }
    const rec = plays.get(playSessionId);
    if (rec === undefined || rec.projectId !== projectId || (rec.state !== 'active' && rec.state !== 'presented')) {
      sendError(res, sessionError('play_not_found', 'not_found', 'no active play session with this id', { playSessionId }), 404);
      return;
    }
    const owner = connectedOwner(rec);
    if (owner === undefined) {
      sendError(res, unavailableError(rec.playSessionId, 'the editor browser must be connected for the input relay'), 503);
      return;
    }
    const requestId = `req-${hex(16)}`;
    const payload = makeInputRelayRequest(requestId, parsedReq.request.frames);
    const outcome: InputRelayOutcome = await plays.relayInput(rec.playSessionId, requestId, payload);
    if (outcome.ok) {
      sessions.record(owner, 'play', requestId, rec.revision, nowMs(), 'input_relay');
      sendJson(res, 200, {
        ok: true,
        mode: 'exclusive-test',
        playSessionId,
        snapshotId: rec.snapshotId,
        buildId: rec.buildId,
        appliedFromStep: outcome.appliedFromStep,
        appliedToStep: outcome.appliedToStep,
        inputMode: 'test',
        clearedAt: new Date(nowMs()).toISOString(),
      });
      return;
    }
    const code = outcome.code;
    const cls = code === 'input_relay_conflict' ? 'conflict' : 'unavailable';
    sendError(
      res,
      sessionError(code, cls, `input relay ${code === 'input_relay_timeout' ? 'timed out' : 'failed'}`, {
        ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      }),
      statusFor(cls),
    );
  };

  /**
   * Surface a §20 relay failure as the closed-set session error (sessions.md
   * §20.2). Unknown codes never leak through: they collapse to
   * `game_relay_rejected` (dropped and counted). No credential, capability,
   * absolute path or binary crosses.
   */
  const sendGameRelayFailure = (res: ServerResponse, code: GameRelayCode | 'bad_origin' | 'field_value' | 'play_not_found', cause?: string, runId?: string): void => {
    if (code === 'bad_origin') {
      sendError(res, badOriginError('forbidden'), 403);
      return;
    }
    const cls =
      code === 'game_run_stale' || code === 'input_relay_conflict'
        ? 'conflict'
        : code === 'play_not_found'
          ? 'not_found'
          : code === 'play_locator_expired' || code === 'game_relay_rejected' || code === 'game_relay_timeout' || code === 'session_unavailable'
            ? 'unavailable'
            : 'validation';
    const message =
      code === 'game_relay_timeout'
        ? 'the game relay timed out waiting for the preview'
        : code === 'session_unavailable'
          ? 'the editor browser must be connected and presenting for the game relay'
          : code === 'game_relay_rejected'
            ? 'the game relay was rejected (wrong source/nonce or a malformed result)'
            : `game relay failed (${code})`;
    sendError(
      res,
      sessionError(code, cls, message, {
        ...(cause !== undefined ? { cause } : {}),
        ...(runId !== undefined ? { runId } : {}),
      }),
      statusFor(cls),
    );
  };

  /** Resolve the play + its presented owner for a §20 relay (or send the error). */
  const resolveGameRelayPlay = (
    res: ServerResponse,
    projectId: string,
    playSessionId: string,
  ): { rec: PlayRecord; owner: SessionRecord } | null => {
    const rec = plays.get(playSessionId);
    if (rec === undefined || rec.projectId !== projectId || (rec.state !== 'active' && rec.state !== 'presented')) {
      sendError(res, sessionError('play_not_found', 'not_found', 'no active play session with this id', { playSessionId }), 404);
      return null;
    }
    if (nowMs() > rec.expiresAt) {
      sendGameRelayFailure(res, 'play_locator_expired');
      return null;
    }
    const owner = connectedOwner(rec);
    if (owner === undefined) {
      sendGameRelayFailure(res, 'session_unavailable', 'no registered browser');
      return null;
    }
    if (rec.state !== 'presented') {
      sendError(
        res,
        sessionError('session_unavailable', 'unavailable', 'the play exists but is not presented yet', {
          playSessionId,
          reason: 'not_presented',
        }),
        503,
      );
      return null;
    }
    return { rec, owner };
  };

  /**
   * `POST …/play/:playSessionId/control` — the bounded §20 game-control relay.
   * The request is forwarded to the owner editor (which relays it to the
   * verified preview) and only the preview's exact result is returned. Without
   * a connected, presenting browser the contracted structured
   * `session_unavailable` is returned — never a fabricated success. No relay
   * request/result carries bytes, a token or a capability.
   */
  const gameControlRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string, playSessionId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    if (body.bytes.length > GAME_CONTROL_BODY_MAX_BYTES) {
      sendError(
        res,
        sessionError('limits_exceeded', 'validation', 'the control body exceeds the 4096-byte bound', { limit: 'body_bytes', current: body.bytes.length, max: GAME_CONTROL_BODY_MAX_BYTES }),
        400,
      );
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const parsedReq = parseGameControlRequest(strict.value);
    if (!parsedReq.ok) {
      sendError(res, parsedReq.error, statusFor(parsedReq.error.cls));
      return;
    }
    const found = resolveGameRelayPlay(res, projectId, playSessionId);
    if (found === null) return;
    const { rec, owner } = found;
    // §20.3: a stale expectedRunId is refused with the current run identity and
    // NO command is applied (409 conflict).
    if (parsedReq.request.expectedRunId !== undefined && parsedReq.request.expectedRunId !== rec.gameRunId) {
      sendGameRelayFailure(res, 'game_run_stale', `${parsedReq.request.expectedRunId} != ${rec.gameRunId}`, rec.gameRunId);
      return;
    }
    const relayId = `relay-${hex(16)}`;
    const payload = makeGameControlRequest(relayId, parsedReq.request.command, parsedReq.request.expectedRunId, parsedReq.request.sceneId);
    const outcome: GameRelayOutcome = await plays.relayGame(rec.playSessionId, 'control', relayId, payload, relayTimeoutMs());
    if (outcome.ok) {
      sessions.record(owner, 'play', relayId, rec.revision, nowMs(), 'game_control');
      sendJson(res, 200, outcome.result);
      return;
    }
    sendGameRelayFailure(res, outcome.code, outcome.cause, outcome.runId);
  };

  /**
   * `POST …/play/:playSessionId/observe` — the bounded §20 observation relay.
   * The observation is read by the preview from the committed read-only
   * `GameView`; the backend performs no gameplay or observation math and only
   * validates the returned document's shape/bounds.
   */
  const gameObserveRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string, playSessionId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    if (body.bytes.length > GAME_OBSERVE_BODY_MAX_BYTES) {
      sendError(
        res,
        sessionError('limits_exceeded', 'validation', 'the observe body exceeds the 4096-byte bound', { limit: 'body_bytes', current: body.bytes.length, max: GAME_OBSERVE_BODY_MAX_BYTES }),
        400,
      );
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const parsedReq = parseGameObserveRequest(strict.value);
    if (!parsedReq.ok) {
      sendError(res, parsedReq.error, statusFor(parsedReq.error.cls));
      return;
    }
    const found = resolveGameRelayPlay(res, projectId, playSessionId);
    if (found === null) return;
    const { rec, owner } = found;
    const relayId = `relay-${hex(16)}`;
    const payload = makeGameObserveRequest(relayId, parsedReq.request.timeoutMs);
    const outcome: GameRelayOutcome = await plays.relayGame(rec.playSessionId, 'observe', relayId, payload, parsedReq.request.timeoutMs);
    if (outcome.ok) {
      sessions.record(owner, 'play', relayId, rec.revision, nowMs(), 'game_observe');
      sendJson(res, 200, outcome.result);
      return;
    }
    sendGameRelayFailure(res, outcome.code, outcome.cause, outcome.runId);
  };


  return { playStartRoute, playStopRoute, relayRoute, inputRelayRoute, gameControlRoute, gameObserveRoute };
}
