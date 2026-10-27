/**
 * `POST /api/v1/projects/:projectId/lighting/bake {sceneId}`: "Bake
 * lighting" of a scene, asked of the project's editor (an agent's
 * `tl_bake_lighting`; the Lighting window's button runs the same bake in
 * the page).
 *
 * The bake runs where the live lighting runs: the editor page's Scene view
 * on WebGPU (a headless editor is opened when no browser is connected).
 * The backend sends `lighting.bake.request` to the project's editor and
 * answers at once with a job (`202 {jobId}`); the editor's
 * `lighting.bake.ack` finishes it, read with
 * `GET …/lighting/bake/:jobId` (a bake takes longer than an HTTP answer may
 * wait). The editor saves the result through the commands (`publishAsset`,
 * `setLighting`), so the backend's only part is the request and the answer.
 * One bake at a time per project.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ERROR_CODES, makeLightingBakeRequest, parseStrictJsonBytes, sessionError, type SessionError, type SessionErrorCode } from '@thirdlight/protocol';

import type { HeadlessEditors } from './headless';
import type { SessionRegistry } from './sessions';
import { newRelayId } from './util';

/** How long (ms) the editor may take to bake and save: the page's own settle limit and the saving after it. */
export const LIGHTING_BAKE_ANSWER_MS = 25 * 60 * 1000;

type BakeAnswer = { ok: true; message: string } | { ok: false; code: SessionErrorCode; message: string };

/** An editor's failure code as a session error's (one it may not name is a failed bake). */
const codeOf = (code: string | undefined): SessionErrorCode => ((ERROR_CODES as readonly string[]).includes(code ?? '') ? (code as SessionErrorCode) : 'bake_failed');

/** A finished job is kept this long (ms) for its answer to be read. */
const JOB_KEEP_MS = 60 * 60 * 1000;

interface Job {
  readonly jobId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly sceneId: string;
  readonly startedAt: number;
  answer: BakeAnswer | null;
  finishedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface LightingBakeRouteContext {
  readonly sessions: SessionRegistry;
  readonly headless: HeadlessEditors;
  readonly sendToOwner: (sessionId: string, payload: string) => boolean;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly readBody: (req: IncomingMessage) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: SessionError }>;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  /** Whether the project has this scene. */
  readonly hasScene: (projectId: string, sceneId: string) => boolean;
  readonly logStartup: (message: string) => void;
  /** Override of the answer's limit (tests). */
  readonly answerMs?: number;
}

export function makeLightingBakeRoute(ctx: LightingBakeRouteContext) {
  const jobs = new Map<string, Job>();
  const finish = (job: Job, answer: BakeAnswer): void => {
    if (job.answer !== null) return;
    job.answer = answer;
    job.finishedAt = Date.now();
    if (job.timer !== null) clearTimeout(job.timer);
    job.timer = null;
  };
  const forget = (): void => {
    const now = Date.now();
    for (const [id, j] of jobs) if (j.finishedAt !== null && now - j.finishedAt > JOB_KEEP_MS) jobs.delete(id);
  };
  const view = (j: Job): Record<string, unknown> => ({
    jobId: j.jobId,
    sceneId: j.sceneId,
    state: j.answer === null ? 'running' : j.answer.ok ? 'done' : 'failed',
    millis: (j.finishedAt ?? Date.now()) - j.startedAt,
    ...(j.answer !== null ? (j.answer.ok ? { message: j.answer.message } : { code: j.answer.code, message: j.answer.message }) : {}),
  });

  /** POST: start a bake of `{sceneId}` in the project's editor. */
  const start = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = ctx.requireAuth(req, projectId, false);
    if (authError !== null) {
      ctx.sendError(res, authError);
      return;
    }
    const body = await ctx.readBody(req);
    if (!body.ok) {
      ctx.sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      ctx.sendError(res, strict.error);
      return;
    }
    const v = strict.value as Record<string, unknown>;
    const extra = Object.keys(v).find((k) => k !== 'sceneId');
    if (extra !== undefined || typeof v['sceneId'] !== 'string') {
      ctx.sendError(res, sessionError('invalid_request', 'validation', extra !== undefined ? `unknown field "${extra}"` : 'sceneId is required (the scene to bake)'), 400);
      return;
    }
    const sceneId = v['sceneId'];
    if (!ctx.hasScene(projectId, sceneId)) {
      ctx.sendError(res, sessionError('scene_not_found', 'not_found', `the project has no scene "${sceneId}"`), 404);
      return;
    }
    forget();
    if ([...jobs.values()].some((j) => j.projectId === projectId && j.answer === null)) {
      ctx.sendError(res, sessionError('bake_busy', 'conflict', 'a lighting bake of this project is running; try again when it is done'), 409);
      return;
    }
    if (ctx.sessions.sessionForProject(projectId)?.connected !== true) {
      const opened = await ctx.headless.ensure(projectId);
      if (!opened.ok) ctx.logStartup(`headless: ${opened.reason}`);
    }
    const session = ctx.sessions.sessionForProject(projectId);
    if (session === undefined || session.connected !== true) {
      ctx.sendError(res, sessionError('session_unavailable', 'unavailable', 'connect the editor browser: the bake runs in the editor (no headless editor could start)'), 503);
      return;
    }
    const job: Job = { jobId: newRelayId(), projectId, sessionId: session.sessionId, sceneId, startedAt: Date.now(), answer: null, finishedAt: null, timer: null };
    jobs.set(job.jobId, job);
    const limit = ctx.answerMs ?? LIGHTING_BAKE_ANSWER_MS;
    job.timer = setTimeout(() => finish(job, { ok: false, code: 'bake_timeout', message: `the editor did not answer in ${Math.round(limit / 60000)} minutes` }), limit);
    job.timer.unref?.();
    if (!ctx.sendToOwner(session.sessionId, makeLightingBakeRequest(job.jobId, sceneId))) finish(job, { ok: false, code: 'session_unavailable', message: 'the editor could not be reached' });
    ctx.sendJson(res, 202, { ok: true, ...view(job) });
  };

  /** GET: a bake job's state (`running`, `done` with what it did, `failed` with why). */
  const read = (req: IncomingMessage, res: ServerResponse, projectId: string, jobId: string): void => {
    const authError = ctx.requireAuth(req, projectId, false);
    if (authError !== null) {
      ctx.sendError(res, authError);
      return;
    }
    const j = jobs.get(jobId);
    if (j === undefined || j.projectId !== projectId) {
      ctx.sendError(res, sessionError('job_not_found', 'not_found', 'no lighting bake with this id (finished ones are kept for an hour)'), 404);
      return;
    }
    ctx.sendJson(res, 200, { ok: true, ...view(j) });
  };

  /** An editor's `lighting.bake.ack` (false: no such running bake asked of that session). */
  const resolveAck = (sessionId: string, ack: { relayId: string; ok: boolean; message?: string; error?: { code: string; message?: string } }): boolean => {
    const j = jobs.get(ack.relayId);
    if (j === undefined || j.sessionId !== sessionId || j.answer !== null) return false;
    finish(j, ack.ok ? { ok: true, message: ack.message ?? 'baked' } : { ok: false, code: codeOf(ack.error?.code), message: ack.error?.message ?? 'the bake failed' });
    return true;
  };

  const dispose = (): void => {
    for (const j of jobs.values()) finish(j, { ok: false, code: 'session_unavailable', message: 'the backend stopped' });
  };

  return { start, read, resolveAck, dispose };
}
