import type { FolderImport, FolderImportReport } from './folder-import';
import type { TextureExtraction, TextureExtractionReport } from './model-textures';
import type { HeadlessEditors } from './headless';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { parseCommandEnvelope, parseEstablishRequest, parseStrictJsonBytes, sessionError, statusFor, isMutationOp, type SessionError } from '@thirdlight/protocol';
import { type CommandError, type QueryResult, type WorkspaceService } from '@thirdlight/workspace';
import { SessionRegistry, type SessionRecord } from './sessions';

import { SESSION_LIST_MAX, newConnId, newWsToken, type OriginDoc } from './util';

import type { Problem, SessionView } from './backend';

export interface SessionRoutesContext {
  readonly timeouts: { readonly wsTokenTtlSeconds: 60; readonly silentDropSeconds: 60; readonly presentTimeoutSeconds: 15; readonly inactivityTtlSeconds: number; readonly relayTimeoutSeconds: 10; readonly stopAckTimeoutSeconds: 5; readonly protocolErrorWindowSeconds: 60; readonly protocolErrorLimit: 10; };
  readonly nowMs: () => number;
  readonly service: WorkspaceService;
  readonly sessions: SessionRegistry;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  readonly bearerToken: (req: IncomingMessage) => string | null;
  readonly tokenScope: (token: string | null, req?: IncomingMessage) => string | null;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly readBody: (req: IncomingMessage) => Promise<{ ok: true; bytes: Uint8Array; } | { ok: false; error: SessionError; }>;
  readonly fullState: (projectId: string) => { ok: true; revision: number; manifest: Record<string, unknown>; scene: Record<string, unknown>; history: Record<string, unknown>; workspace: Record<string, unknown>; content?: Record<string, unknown>; } | { ok: false; error: SessionError; status: number; };
  readonly workspaceError: (e: CommandError) => SessionError;
  readonly sessionView: (s: SessionRecord) => SessionView;
  readonly recordProblem: (projectId: string, source: Problem["source"], code: string, message: string) => void;
  /** Inspects a folder's files before its `importAssets` command (absent: the command refuses an unprepared folder). */
  readonly folderImport?: FolderImport;
  /** Extracts a model's images before its `publishAsset` (absent: models keep their images). */
  readonly textures?: TextureExtraction;
  readonly notifyMutationApplied: (projectId: string, requestId: string, revision: number, origin: OriginDoc | null, change: unknown, sceneId?: string) => void;
  /** The backend's headless editors (the owner's browser evicts them). */
  readonly headless: HeadlessEditors;
  /** The owner of a play went away (its play is stopped after the grace period). */
  readonly onOwnerLost: (sessionId: string, detail?: string) => void;
}

export function makeSessionRoutes(ctx: SessionRoutesContext) {
  const { timeouts, nowMs, service, sessions, sendJson, sendError, bearerToken, tokenScope, requireAuth, readBody, fullState, workspaceError, sessionView, recordProblem, notifyMutationApplied, headless, onOwnerLost, folderImport, textures } = ctx;

  const establishSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const scope = tokenScope(bearerToken(req), req);
    if (scope === null) {
      sendError(res, sessionError('unauthorized', 'validation', 'establishing a session requires a valid bearer token'));
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
    const parsedReq = parseEstablishRequest(strict.value);
    if (!parsedReq.ok) {
      sendError(res, parsedReq.error);
      return;
    }
    const { projectId, sessionId, clientInfo } = parsedReq.request;
    if (scope !== 'admin' && scope !== `authoring:${projectId}`) {
      sendError(res, sessionError('unauthorized', 'validation', 'the token scope does not cover this project'));
      return;
    }
    // The project must be loadable.
    const probe = service.query({ op: 'queryProject', projectId }) as QueryResult;
    if (!probe.ok) {
      sendError(res, workspaceError(probe.error), statusFor(probe.error.cls));
      return;
    }
    // The owner's browser takes the project over from a headless editor.
    const current = sessions.sessionForProject(projectId);
    if (current !== undefined && current.sessionId !== sessionId && clientInfo?.label !== 'headless' && current.clientInfo?.label === 'headless') {
      const old = current.sessionId;
      sessions.evictProject(projectId);
      onOwnerLost(old, "the owner's editor browser took the project over from the backend's headless editor that ran it");
      await headless.evict(projectId);
    }
    const est = sessions.establish(projectId, sessionId, clientInfo, newConnId(), nowMs());
    if (est.result === 'conflict') {
      sendError(
        res,
        sessionError('session_conflict', 'conflict', 'an active authoring session already exists for this project', {
          activeSessionId: est.activeSessionId,
          lastActivityAt: est.lastActivityAt,
        }),
        409,
      );
      return;
    }
    const wsToken = newWsToken();
    sessions.allocateWsToken(wsToken, est.session, timeouts.wsTokenTtlSeconds * 1000, nowMs());
    const state = fullState(projectId);
    if (!state.ok) {
      sendError(res, state.error, state.status);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      sessionId: est.session.sessionId,
      connId: est.session.connId,
      wsToken,
      revision: state.revision,
      manifest: state.manifest,
      scene: state.scene,
      history: state.history,
      workspace: state.workspace,
      ...(state.content !== undefined ? { content: state.content } : {}),
    });
  };

  const listSessions = async (req: IncomingMessage, res: ServerResponse, query: Map<string, string>): Promise<void> => {
    const scope = tokenScope(bearerToken(req), req);
    if (scope === null) {
      sendError(res, sessionError('unauthorized', 'validation', 'a valid bearer token is required'));
      return;
    }
    // A project-scoped token sees its project only; the owner (admin) token
    // sees every project unless it filters.
    const filterProject = scope.startsWith('authoring:') ? scope.slice('authoring:'.length) : query.get('projectId') ?? undefined;
    const visible = sessions
      .all()
      .filter((s) => filterProject === undefined || s.projectId === filterProject)
      .slice(0, SESSION_LIST_MAX);
    sendJson(res, 200, { ok: true, sessions: visible.map(sessionView) });
  };

  const sessionLog = async (req: IncomingMessage, res: ServerResponse, sessionId: string, query: Map<string, string>): Promise<void> => {
    const s = sessions.sessionForSessionId(sessionId);
    if (s === undefined) {
      sendError(res, sessionError('session_not_found', 'not_found', 'no session with this id', { sessionId }), 404);
      return;
    }
    const authError = requireAuth(req, s.projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const limitRaw = query.get('limit');
    const limit = limitRaw === undefined ? 32 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) {
      sendError(res, sessionError('field_value', 'validation', 'limit must be an integer 1–128'));
      return;
    }
    const entries = sessions.logEntries(s, limit);
    sendJson(res, 200, { ok: true, sessionId: s.sessionId, total: entries.total, entries: entries.entries });
  };

  const commandRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
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
    // Strict parse of the bytes first, then the commands.md pipeline.
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const envelope = parseCommandEnvelope(strict.value);
    if (!envelope.ok) {
      sendError(res, envelope.error);
      return;
    }
    const env = strict.value as Record<string, unknown>;
    const envOrigin =
      typeof env.origin === 'object' && env.origin !== null && !Array.isArray(env.origin)
        ? (env.origin as OriginDoc)
        : null;
    // Caller binding: a browser-origin command must come from the
    // project's registered authoring session.
    if (envOrigin?.kind === 'browser' && sessions.sessionForProject(projectId) === undefined) {
      sendError(res, sessionError('session_required', 'validation', 'a browser-origin command requires a registered authoring session for the project'), 403);
      return;
    }
    const session = sessions.sessionForProject(projectId);
    if (session) sessions.touch(session, nowMs());
    // Mutation envelopes go through the commands.md pipeline; query
    // envelopes are served by the workspace query path (never a mutation,
    // no revision advance, no mutation.applied, no history).
    const isMut = isMutationOp(envelope.op);
    if (isMut) {
      // A script library change republishes the published scripts
      // that import it in the same command; compile them against the library
      // set it will commit first (the command reads only those prepared facts).
      if (envelope.op === 'setScriptLibrary' && typeof env.args === 'object' && env.args !== null && !Array.isArray(env.args)) {
        const args = env.args as Record<string, unknown>;
        if (typeof args['libraryId'] === 'string') {
          const prep = await service.prepareScriptLibraryDependents(projectId, args as unknown as Parameters<WorkspaceService['prepareScriptLibraryDependents']>[1]);
          if (!prep.ok && prep.kind === 'compile') {
            const first = prep.failure.diagnostics[0]?.message ?? prep.failure.reason;
            const message = `script ${prep.behaviorId} does not compile against the changed library @lib/${args['libraryId']}: ${first}`.slice(0, 256);
            recordProblem(projectId, 'compile', prep.failure.code, message);
            sendJson(res, 400, { ok: false, error: { code: prep.failure.code, cls: 'validation', message, behaviorId: prep.behaviorId, diagnostics: prep.failure.diagnostics.slice(0, 32) } });
            return;
          }
          if (!prep.ok) {
            recordProblem(projectId, 'command', prep.error.code, `setScriptLibrary: ${prep.error.message ?? prep.error.code}`);
            sendJson(res, statusFor(prep.error.cls), { ok: false, error: prep.error });
            return;
          }
        }
      }
      // A staged commit compiles the dependents of every changed library once, against the committed set.
      let stagePrep: { dependents: { behaviorId: string; outputDigest: string }[]; compiled: number } | null = null;
      if (envelope.op === 'commitScriptLibraryStage' && typeof env.args === 'object' && env.args !== null && !Array.isArray(env.args) && typeof (env.args as Record<string, unknown>)['stageId'] === 'string') {
        const prep = await service.prepareScriptLibraryStage(projectId, (env.args as Record<string, string>)['stageId']!);
        if (!prep.ok && prep.kind === 'compile') {
          const first = prep.failure.diagnostics[0]?.message ?? prep.failure.reason;
          const message = `script ${prep.behaviorId} does not compile against the staged libraries: ${first}`.slice(0, 256);
          recordProblem(projectId, 'compile', prep.failure.code, message);
          sendJson(res, 400, { ok: false, error: { code: prep.failure.code, cls: 'validation', message, behaviorId: prep.behaviorId, diagnostics: prep.failure.diagnostics.slice(0, 32) } });
          return;
        }
        // A missing stage is the command's refusal (reference_missing), with its revision checks first.
        if (!prep.ok && prep.error.code !== 'reference_missing') {
          recordProblem(projectId, 'command', prep.error.code, `commitScriptLibraryStage: ${prep.error.message ?? prep.error.code}`);
          sendJson(res, statusFor(prep.error.cls), { ok: false, error: prep.error });
          return;
        }
        if (prep.ok) stagePrep = { dependents: prep.dependents, compiled: prep.compiled };
      }
      // A folder import: the backend inspects the folder's files first (the command reads only those facts).
      let folderReport: FolderImportReport | null = null;
      if (envelope.op === 'importAssets' && folderImport !== undefined) {
        const prep = await folderImport.prepare(projectId, env.args);
        if (!prep.ok) {
          const error = { code: prep.code, cls: 'validation' as const, message: prep.message, ...(prep.path !== undefined ? { path: prep.path } : {}) };
          recordProblem(projectId, 'import', prep.code, `importAssets: ${prep.message}`);
          sendJson(res, 400, { ok: false, error });
          return;
        }
        folderReport = prep.report;
      }
      // A model publish with "extract textures" on: its images become texture assets first (their own command).
      let extraction: TextureExtractionReport | null = null;
      let command = env;
      if (envelope.op === 'publishAsset' && textures !== undefined) {
        let refused: CommandError | null = null;
        const prep = await textures.beforePublish(projectId, env, (request) => {
          const r = service.runCommand(request);
          if (!r.ok) {
            refused = r.error;
            return { ok: false, code: r.error.code, message: r.error.message ?? r.error.code };
          }
          if (r.duplicated === false) notifyMutationApplied(projectId, r.requestId, r.revision, envOrigin, r.change, (r as { sceneId?: string }).sceneId);
          return { ok: true, revision: r.revision, change: r.change };
        });
        if (prep !== null && !prep.ok) {
          recordProblem(projectId, 'import', prep.code, `publishAsset: ${prep.message}`);
          // The textures' own command's refusal as it is (a stale revision is the publish's too).
          const error: CommandError | null = refused;
          if (error !== null) sendJson(res, statusFor((error as CommandError).cls), { ok: false, error: { ...(error as CommandError), message: prep.message } });
          else sendJson(res, 400, { ok: false, error: { code: prep.code, cls: 'validation', message: prep.message } });
          return;
        }
        if (prep !== null) {
          command = prep.envelope;
          extraction = prep.report;
        }
      }
      const result = service.runCommand(command);
      if (result.ok && extraction !== null && result.duplicated === false) {
        if (session) sessions.record(session, 'command', result.requestId, result.revision, nowMs());
        notifyMutationApplied(projectId, result.requestId, result.revision, envOrigin, result.change, (result as { sceneId?: string }).sceneId);
        sendJson(res, 200, { ...result, textureExtraction: extraction });
        return;
      }
      if (!result.ok && folderReport !== null) {
        // The refusal says what the folder held besides it.
        sendJson(res, statusFor(result.error.cls), { ...result, folderImport: folderReport });
        return;
      }
      if (result.ok && folderReport !== null && result.duplicated === false) {
        if (session) sessions.record(session, 'command', result.requestId, result.revision, nowMs());
        notifyMutationApplied(projectId, result.requestId, result.revision, envOrigin, result.change, (result as { sceneId?: string }).sceneId);
        sendJson(res, 200, { ...result, folderImport: folderReport });
        return;
      }
      if (result.ok && stagePrep !== null && result.duplicated === false) {
        if (session) sessions.record(session, 'command', result.requestId, result.revision, nowMs());
        notifyMutationApplied(projectId, result.requestId, result.revision, envOrigin, result.change, (result as { sceneId?: string }).sceneId);
        sendJson(res, 200, { ...result, libraryStage: stagePrep });
        return;
      }
      if (result.ok) {
        if (result.duplicated === false) {
          notifyMutationApplied(projectId, result.requestId, result.revision, envOrigin, result.change, (result as { sceneId?: string }).sceneId);
          if (session) sessions.record(session, 'command', result.requestId, result.revision, nowMs());
        }
        sendJson(res, 200, result);
        return;
      }
      // The response is exactly the commands.md result — pass the
      // raw commands.md error through (it carries `currentRevision` etc.;
      // a SessionError re-wrap would drop those fields).
      if (result.error.code !== 'no_change') {
        recordProblem(projectId, 'command', result.error.code, `${envelope.op}: ${result.error.message ?? result.error.code}`);
      }
      sendJson(res, statusFor(result.error.cls), { ok: false, error: result.error });
      return;
    }
    // Query envelope: served by the workspace query path (read-only).
    const qres = service.query(env);
    if (qres.ok) {
      sendJson(res, 200, qres);
      return;
    }
    sendJson(res, statusFor(qres.error.cls), { ok: false, error: qres.error });
  };


  return { establishSession, listSessions, sessionLog, commandRoute };
}
