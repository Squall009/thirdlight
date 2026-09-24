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
  readonly notifyMutationApplied: (projectId: string, requestId: string, revision: number, origin: OriginDoc | null, change: unknown, sceneId?: string) => void;
  /** Phase 11: the backend's headless editors (the owner's browser evicts them). */
  readonly headless: HeadlessEditors;
  /** The owner of a play went away (its play is stopped after the grace period). */
  readonly onOwnerLost: (sessionId: string) => void;
}

export function makeSessionRoutes(ctx: SessionRoutesContext) {
  const { timeouts, nowMs, service, sessions, sendJson, sendError, bearerToken, tokenScope, requireAuth, readBody, fullState, workspaceError, sessionView, recordProblem, notifyMutationApplied, headless, onOwnerLost } = ctx;

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
    // The project must be loadable (§5.1 outcomes).
    const probe = service.query({ op: 'queryProject', projectId }) as QueryResult;
    if (!probe.ok) {
      sendError(res, workspaceError(probe.error), statusFor(probe.error.cls));
      return;
    }
    // Phase 11: the owner's browser takes the project over from a headless editor.
    const current = sessions.sessionForProject(projectId);
    if (current !== undefined && current.sessionId !== sessionId && clientInfo?.label !== 'headless' && current.clientInfo?.label === 'headless') {
      const old = current.sessionId;
      sessions.evictProject(projectId);
      onOwnerLost(old);
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
    // §6.1: strict parse of the bytes first, then the commands.md pipeline.
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
    // §6.1 caller binding: a browser-origin command must come from the
    // project's registered authoring session.
    if (envOrigin?.kind === 'browser' && sessions.sessionForProject(projectId) === undefined) {
      sendError(res, sessionError('session_required', 'validation', 'a browser-origin command requires a registered authoring session for the project'), 403);
      return;
    }
    const session = sessions.sessionForProject(projectId);
    if (session) sessions.touch(session, nowMs());
    // §6.1: mutation envelopes go through the commands.md pipeline; query
    // envelopes are served by the workspace query path (never a mutation,
    // no revision advance, no mutation.applied, no history).
    const isMut = isMutationOp(envelope.op);
    if (isMut) {
      const result = service.runCommand(env);
      if (result.ok) {
        if (result.duplicated === false) {
          notifyMutationApplied(projectId, result.requestId, result.revision, envOrigin, result.change, (result as { sceneId?: string }).sceneId);
          if (session) sessions.record(session, 'command', result.requestId, result.revision, nowMs());
        }
        sendJson(res, 200, result);
        return;
      }
      // §6.1: the response is exactly the commands.md result — pass the
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
