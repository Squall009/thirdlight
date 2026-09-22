/**
 * Packet 25 — content HTTP services (sessions.md §11.3/§16.1, workspace.md
 * §7.6/§13, delivery.md §15).
 *
 * The transport layer for M2 content: bounded upload framing, the bounded
 * inspection/publish job coordinator, the read-only content queries, and the
 * authenticated immutable-version asset-byte read. It performs **no
 * filesystem writes and no authoritative state mutation** — every write and
 * every byte read goes through the injected `WorkspaceService`, and the
 * immutable blob publication is the workspace's non-authoritative preparation
 * step, performed only after a *successful* inspection (workspace.md §13.3.2). The pure asset inspector
 * (`@thirdlight/asset-pipeline`) is constructed here and injected into the
 * workspace, which owns the staged-byte read (dependencies.md §4.1).
 *
 * Behavior-build jobs/publication are structurally unavailable (packet 33):
 * this module has no behavior-build kind, and the command pipeline already
 * refuses `publishBehavior{mode:"source"}` with
 * `behavior_publication_unavailable`.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CONTENT_ASSET_BYTES_CACHE,
  CONTENT_ASSET_BYTES_MAX,
  CONTENT_INSPECT_TIMEOUT_MS,
  CONTENT_JOB_RESULT_TTL_MS,
  CONTENT_OPEN_STAGES,
  CONTENT_PROPOSAL_MAX_BYTES,
  CONTENT_PUBLISH_CONCURRENCY_GLOBAL,
  CONTENT_PUBLISH_CONCURRENCY_PER_PROJECT,
  CONTENT_PUBLISH_TIMEOUT_MS,
  CONTENT_STAGE_MAX,
  CONTENT_UPLOAD_FRAME_MAX,
  checkUploadFrame,
  parseAssetByteParams,
  parseContentAssetsQuery,
  parseJobId,
  parseStageCreateRequest,
  parseStageId,
  parseStageInspectRequest,
  parseStrictJsonBytes,
  parseUploadFrameHeaders,
  sessionError,
  type ContentJobKind,
  type ContentJobState,
  type ContentJobView,
  type SessionError,
} from '@thirdlight/protocol';
import { inspectAudio, inspectGlb, AUDIO_PCM_WAV_TOOLCHAIN, M2_GLTF_TOOLCHAIN, type ImportJobPort, type ImportProposal } from '@thirdlight/asset-pipeline';
import { createBehaviorCompiler } from '@thirdlight/behavior-build';
import type { BehaviorCompiler } from '@thirdlight/behavior-build';
import type { CommandError, MutationSuccess, StageInspector, WorkspaceService } from '@thirdlight/workspace';

// ---- error surfacing (workspace/command codes → session-layer shape) ----------

/** Fields copied from a workspace/command error into the session error body. */
const CARRIED_FIELDS = [
  'hint',
  'path',
  'expected',
  'limit',
  'current',
  'max',
  'stageId',
  'jobId',
  'assetId',
  'assetVersion',
  'sourceDigest',
  'byteLength',
  'kind',
  'used',
  'needed',
  'reason',
  'projectId',
  'diagnostics',
  'diagnosticCount',
  'detailCount',
  'details',
  'onDiskState',
] as const;

/**
 * Surface a workspace/command error unchanged (sessions.md §11.3) with its
 * code-specific fields. Two accepted route-level class fixes are applied
 * (delivery.md §10.1 / sessions.md §16.1, and the packet-19 fixture's class
 * table): `blob_corrupt` is `internal` (HTTP 500) and
 * `asset_not_found`/`asset_version_not_found` are `not_found` (HTTP 404).
 */
const CLS_OVERRIDE: Record<string, SessionError['cls']> = {
  blob_corrupt: 'internal',
  asset_not_found: 'not_found',
  asset_version_not_found: 'not_found',
};

export function commandErrorToSession(e: CommandError): SessionError {
  const carried: Record<string, unknown> = {};
  for (const key of CARRIED_FIELDS) {
    const v = (e as unknown as Record<string, unknown>)[key];
    if (v === undefined) continue;
    carried[key] = v;
  }
  const cls = CLS_OVERRIDE[e.code] ?? e.cls;
  const err = sessionError(e.code as SessionError['code'], cls, e.message, carried as Partial<SessionError>);
  if (e.found !== undefined) {
    err.found = (typeof e.found === 'string' ? e.found : JSON.stringify(e.found) ?? String(e.found)).slice(0, 256);
  }
  return err;
}

/** `stage_limits_exceeded` for the transport-level frame/interaction bounds. */
function frameLimit(limit: string, current: number, max: number): SessionError {
  return sessionError('stage_limits_exceeded', 'validation', `a staging bound is exceeded: ${limit} ${current} > ${max}`, {
    limit,
    current,
    max,
    expected: `≤ ${max}`,
  });
}

// ---- the injected inspector ---------------------------------------------------

/**
 * Build the workspace-injected inspector (packet 48): asset-pipeline's
 * `inspectGlb`/`inspectAudio` bound to the pinned profile/recipe/toolchain
 * (project-model §18.5/§18.7, presentation.md §41.3.3/§41.4.3). The workspace
 * supplies the job port (clock, cancellation, proposal identity) and forwards
 * the caller's typed request; the importer never reads a clock, PRNG or
 * environment variable itself.
 *
 * `request.kind === 'audio'` selects the bounded PCM-WAV inspector;
 * `request.animation` requests the role-aware animated GLB profile
 * (presentation.md §41.3.3 A1–A6). Without either, the accepted M2 model
 * proposal is byte-unchanged.
 */
export function createAssetInspector(): StageInspector {
  return (bytes, job, request) => {
    if (request?.kind === 'audio') {
      return inspectAudio(bytes, {
        profile: 'pcm-wav',
        recipeVersion: 1,
        toolchain: AUDIO_PCM_WAV_TOOLCHAIN,
        job,
      });
    }
    return inspectGlb(bytes, {
      profile: 'gltf-glb',
      recipeVersion: 1,
      toolchain: M2_GLTF_TOOLCHAIN,
      job,
      ...(request?.animation !== undefined ? { animation: request.animation } : {}),
    });
  };
}

/**
 * Build the workspace-injected behavior-source compiler (packet 33;
 * dependencies.md §4.1: `backend` constructs the `behavior-build` compiler and
 * injects it). The injected clock is the only time source the cooperative
 * compile bound uses; the compiler itself reads no clock (project-model §5.4).
 * The pinned module table travels with the instance, so the prepared manifest
 * records the host's actual pins.
 */
export function createBehaviorCompilerPort(now: () => number): BehaviorCompiler {
  return createBehaviorCompiler({ now });
}

// ---- bounded job coordination -------------------------------------------------

interface JobRecord {
  jobId: string;
  projectId: string;
  kind: ContentJobKind;
  state: ContentJobState;
  createdAt: number;
  expiresAt: number;
  deadlineMs: number;
  cancelled: boolean;
  result?: ContentJobView['result'];
  error?: { code: string; message: string };
  lateResultDiscarded?: true;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

/**
 * Bounded in-memory job coordinator (the packet instruction's "bounded job
 * coordination with cancellation/expiry and late-result handling"). Records
 * are bounded summaries only — never proposal/byte payloads. A caller
 * disconnect cancels a job; a result that arrives after cancellation/expiry
 * is discarded and reported as `lateResultDiscarded` (never resurrected).
 */
export class ContentJobs {
  private readonly records = new Map<string, JobRecord>();
  private readonly now: () => number;
  private readonly onFail: ((projectId: string, kind: ContentJobKind, code: string, message: string) => void) | undefined;

  constructor(now: () => number, onFail?: (projectId: string, kind: ContentJobKind, code: string, message: string) => void) {
    this.now = now;
    this.onFail = onFail;
  }

  /**
   * Begin a job. Publish jobs honour the concurrency bound (2/project,
   * 4/global — workspace.md §13.9); exceeding it is `content_publish_failed`
   * (`busy`, unavailable) before any work starts.
   */
  begin(kind: ContentJobKind, projectId: string):
    | { ok: true; jobId: string; deadlineMs: number }
    | { ok: false; error: SessionError } {
    this.prune();
    if (kind === 'publish') {
      const active = [...this.records.values()].filter((r) => r.state === 'pending');
      const perProject = active.filter((r) => r.kind === 'publish' && r.projectId === projectId).length;
      const global = active.filter((r) => r.kind === 'publish').length;
      if (perProject >= CONTENT_PUBLISH_CONCURRENCY_PER_PROJECT || global >= CONTENT_PUBLISH_CONCURRENCY_GLOBAL) {
        return {
          ok: false,
          error: sessionError('content_publish_failed', 'unavailable', 'the content publish concurrency bound is reached', {
            reason: 'busy',
            limit: perProject >= CONTENT_PUBLISH_CONCURRENCY_PER_PROJECT ? 'publishes_per_project' : 'publishes_global',
            current: perProject >= CONTENT_PUBLISH_CONCURRENCY_PER_PROJECT ? perProject : global,
            max: perProject >= CONTENT_PUBLISH_CONCURRENCY_PER_PROJECT ? CONTENT_PUBLISH_CONCURRENCY_PER_PROJECT : CONTENT_PUBLISH_CONCURRENCY_GLOBAL,
          }),
        };
      }
    }
    const nowMs = this.now();
    const jobId = `job-${hex(randomBytes(16))}`;
    const deadlineMs = kind === 'inspect' ? CONTENT_INSPECT_TIMEOUT_MS : CONTENT_PUBLISH_TIMEOUT_MS;
    this.records.set(jobId, {
      jobId,
      projectId,
      kind,
      state: 'pending',
      createdAt: nowMs,
      expiresAt: nowMs + CONTENT_JOB_RESULT_TTL_MS,
      deadlineMs,
      cancelled: false,
    });
    return { ok: true, jobId, deadlineMs };
  }

  isCancelled(jobId: string): boolean {
    const r = this.records.get(jobId);
    return r === undefined || r.cancelled;
  }

  /** Bounded elapsed check for the job's deadline (the transport's own guard). */
  overDeadline(jobId: string): boolean {
    const r = this.records.get(jobId);
    if (r === undefined) return true;
    return this.now() - r.createdAt > r.deadlineMs;
  }

  finish(jobId: string, result: ContentJobView['result']): void {
    const r = this.records.get(jobId);
    if (r === undefined) return;
    if (r.state !== 'pending') {
      // A late result (after cancellation/expiry) is discarded, never applied.
      r.lateResultDiscarded = true;
      return;
    }
    if (r.cancelled || this.now() - r.createdAt > r.deadlineMs) {
      r.state = r.cancelled ? 'cancelled' : 'expired';
      r.lateResultDiscarded = true;
      return;
    }
    r.state = 'succeeded';
    r.result = result;
  }

  fail(jobId: string, code: string, message: string): void {
    const r = this.records.get(jobId);
    if (r === undefined) return;
    if (r.state !== 'pending') {
      r.lateResultDiscarded = true;
      return;
    }
    if (r.cancelled || this.now() - r.createdAt > r.deadlineMs) {
      r.state = r.cancelled ? 'cancelled' : 'expired';
      r.lateResultDiscarded = true;
      return;
    }
    r.state = 'failed';
    r.error = { code, message: message.slice(0, 256) };
    this.onFail?.(r.projectId, r.kind, code, r.error.message);
  }

  cancel(jobId: string): void {
    const r = this.records.get(jobId);
    if (r === undefined || r.state !== 'pending') return;
    r.cancelled = true;
    r.state = 'cancelled';
  }

  /** `GET .../content/jobs/:jobId` (job_not_found / job_expired). */
  get(jobId: string): { ok: true; job: ContentJobView } | { ok: false; error: SessionError } {
    const r = this.records.get(jobId);
    if (r === undefined) {
      return {
        ok: false,
        error: sessionError('job_not_found', 'not_found', `no content job '${jobId}' exists`, { jobId }),
      };
    }
    if (r.state === 'expired' || this.now() > r.expiresAt || (r.state === 'pending' && this.now() - r.createdAt > r.deadlineMs)) {
      if (r.state === 'pending') r.state = 'expired';
      return {
        ok: false,
        error: sessionError('job_expired', 'unavailable', `content job '${jobId}' expired; a late result is never applied`, {
          jobId,
          reason: r.state,
        }),
      };
    }
    const job: ContentJobView = {
      jobId: r.jobId,
      projectId: r.projectId,
      kind: r.kind,
      state: r.state,
      createdAt: new Date(r.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      expiresAt: new Date(r.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    if (r.result !== undefined) job.result = r.result;
    if (r.error !== undefined) job.error = r.error;
    if (r.lateResultDiscarded === true) job.lateResultDiscarded = true;
    return { ok: true, job };
  }

  dispose(): void {
    this.records.clear();
  }

  /** Drop records whose bounded retention elapsed (memory stays bounded). */
  private prune(): void {
    const nowMs = this.now();
    for (const [id, r] of [...this.records.entries()]) {
      if (nowMs > r.expiresAt && r.state !== 'pending') this.records.delete(id);
    }
  }
}

// ---- bounded upload staging ------------------------------------------------

interface UploadSession {
  stageId: string;
  projectId: string;
  chunks: Uint8Array[];
  received: number;
  declaredTotal: number | null;
  displayName?: string;
  createdAt: number;
  /** True once the completing frame was assembled and staged. */
  complete: boolean;
}

/** Server-side upload assembly (the transport buffers bounded frames; the
 * workspace performs the single staged write on completion). */
export class ContentUploads {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  private forProject(projectId: string): UploadSession[] {
    return [...this.sessions.values()].filter((u) => u.projectId === projectId);
  }

  private stagedBytes(projectId: string): number {
    return this.forProject(projectId)
      .filter((u) => !u.complete)
      .reduce((n, u) => n + u.received, 0);
  }

  /** `POST .../content/stages`: allocate a bounded, empty upload session. */
  begin(projectId: string, displayName?: string): { ok: true; stageId: string } | { ok: false; error: SessionError } {
    const open = this.forProject(projectId).filter((u) => !u.complete).length;
    if (open >= CONTENT_OPEN_STAGES) {
      return { ok: false, error: frameLimit('open_stages', open + 1, CONTENT_OPEN_STAGES) };
    }
    const stageId = `stg-${hex(randomBytes(16))}`;
    this.sessions.set(stageId, {
      stageId,
      projectId,
      chunks: [],
      received: 0,
      declaredTotal: null,
      ...(displayName !== undefined ? { displayName } : {}),
      createdAt: this.now(),
      complete: false,
    });
    return { ok: true, stageId };
  }

  get(stageId: string): UploadSession | undefined {
    return this.sessions.get(stageId);
  }

  /**
   * Append one bounded frame. Uses the accepted `checkUploadFrame` order
   * (frame cap → offset → declared total → open stages → project cap); on the
   * completing frame returns the assembled bytes for the workspace's single
   * `stageContent` write.
   */
  append(
    projectId: string,
    stageId: string,
    offset: number,
    declaredTotal: number,
    frame: Uint8Array,
  ):
    | { ok: true; received: number; complete: false }
    | { ok: true; received: number; complete: true; bytes: Uint8Array }
    | { ok: false; error: SessionError } {
    const s = this.sessions.get(stageId);
    if (s === undefined || s.projectId !== projectId) {
      return { ok: false, error: sessionError('stage_not_found', 'not_found', `no open upload stage '${stageId}'`, { stageId }) };
    }
    if (s.declaredTotal !== null && s.declaredTotal !== declaredTotal) {
      return {
        ok: false,
        error: sessionError('content_frame_invalid', 'validation', 'X-Thirdlight-Total changed between frames of one upload', {
          path: 'X-Thirdlight-Total',
          found: String(declaredTotal),
          expected: String(s.declaredTotal),
        }),
      };
    }
    const verdict = checkUploadFrame({
      frameBytes: frame.length,
      offset,
      expectedOffset: s.received,
      declaredTotal,
      openStages: this.forProject(projectId).filter((u) => !u.complete).length,
      stagedBytes: this.stagedBytes(projectId),
    });
    if (!verdict.accepted) {
      if (verdict.code === 'content_frame_invalid') {
        return {
          ok: false,
          error: sessionError('content_frame_invalid', 'validation', 'the upload frame does not continue the declared sequence', {
            path: 'X-Thirdlight-Offset',
            found: String(offset),
            expected: `offset ${s.received} (received ${s.received} of ${declaredTotal})`,
          }),
        };
      }
      const limit = verdict.limit ?? 'frame_bytes';
      const max =
        limit === 'frame_bytes'
          ? CONTENT_UPLOAD_FRAME_MAX
          : limit === 'stage_bytes'
            ? CONTENT_STAGE_MAX
            : limit === 'open_stages'
              ? CONTENT_OPEN_STAGES
              : CONTENT_STAGE_MAX;
      const current = limit === 'frame_bytes' ? frame.length : limit === 'open_stages' ? this.forProject(projectId).filter((u) => !u.complete).length : declaredTotal;
      return { ok: false, error: frameLimit(limit, current, max) };
    }
    s.declaredTotal = declaredTotal;
    if (this.stagedBytes(projectId) + frame.length > CONTENT_STAGE_MAX) {
      return { ok: false, error: frameLimit('stage_bytes', this.stagedBytes(projectId) + frame.length, CONTENT_STAGE_MAX) };
    }
    s.chunks.push(frame);
    s.received += frame.length;
    if (!verdict.complete) return { ok: true, received: s.received, complete: false };
    const bytes = new Uint8Array(s.received);
    let off = 0;
    for (const c of s.chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    s.complete = true;
    return { ok: true, received: s.received, complete: true, bytes };
  }

  /** Drop an upload session (discard/abort/cleanup). */
  discard(stageId: string): boolean {
    return this.sessions.delete(stageId);
  }

  /** TTL cleanup: abandoned upload sessions are dropped (never persisted). */
  cleanup(maxAgeMs: number): number {
    const nowMs = this.now();
    let removed = 0;
    for (const [id, s] of [...this.sessions.entries()]) {
      if (nowMs - s.createdAt > maxAgeMs) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  dispose(): void {
    this.sessions.clear();
  }
}

// ---- route handling ----------------------------------------------------------

export interface ContentRouteDeps {
  service: WorkspaceService;
  now: () => number;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  /** Bounded transport log (the backend's startup ring). */
  log: (message: string) => void;
  /** A content job (import inspection, publication) failed. */
  onJobFailed?: (projectId: string, kind: string, code: string, message: string) => void;
}

const FRAME_BOUND_MS = CONTENT_JOB_RESULT_TTL_MS;

/**
 * The packet-25 content routes. `handle()` returns true when it served the
 * request (parts are the `/api/v1/projects/<pid>/content/...` segments).
 */
export class ContentRoutes {
  readonly jobs: ContentJobs;
  readonly uploads: ContentUploads;
  private readonly deps: ContentRouteDeps;

  constructor(deps: ContentRouteDeps) {
    this.deps = deps;
    this.jobs = new ContentJobs(deps.now, deps.onJobFailed);
    this.uploads = new ContentUploads(deps.now);
  }

  dispose(): void {
    this.jobs.dispose();
    this.uploads.dispose();
  }

  /**
   * Dispatch one content request. `parts` = the full split path; the content
   * segment is `parts[4]` under `/api/v1/projects/<pid>/...`.
   * Returns false when the path is not a content route (the caller 404s).
   */
  async handle(req: IncomingMessage, res: ServerResponse, method: string, parts: string[], query: Map<string, string>): Promise<boolean> {
    if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'projects' || parts[4] !== 'content') return false;
    const projectIdRaw = parts[3] ?? '';
    const projectId = projectIdRaw;
    this.uploads.cleanup(FRAME_BOUND_MS);
    const n = parts.length;

    // POST /api/v1/projects/:projectId/content/stages
    if (n === 6 && parts[5] === 'stages') {
      if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
      await this.createStage(req, res, projectId);
      return true;
    }
    // PUT /api/v1/projects/:projectId/content/stages/:stageId/bytes
    if (n === 8 && parts[5] === 'stages' && parts[7] === 'bytes') {
      if (method !== 'PUT') return this.methodNotAllowed(res, 'PUT');
      await this.uploadBytes(req, res, projectId, parts[6] ?? '');
      return true;
    }
    // POST /api/v1/projects/:projectId/content/stages/:stageId/inspect
    if (n === 8 && parts[5] === 'stages' && parts[7] === 'inspect') {
      if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
      await this.inspect(req, res, projectId, parts[6] ?? '');
      return true;
    }
    // DELETE /api/v1/projects/:projectId/content/stages/:stageId
    if (n === 7 && parts[5] === 'stages') {
      if (method !== 'DELETE') return this.methodNotAllowed(res, 'DELETE');
      this.discardStage(req, res, projectId, parts[6] ?? '');
      return true;
    }
    // GET /api/v1/projects/:projectId/content/assets
    if (n === 6 && parts[5] === 'assets') {
      if (method !== 'GET') return this.methodNotAllowed(res, 'GET');
      this.listAssets(req, res, projectId, query);
      return true;
    }
    // GET /api/v1/projects/:projectId/content/assets/:assetId/versions/:version/bytes
    if (n === 10 && parts[5] === 'assets' && parts[7] === 'versions' && parts[9] === 'bytes') {
      if (method !== 'GET') return this.methodNotAllowed(res, 'GET');
      this.assetBytes(req, res, projectId, parts[6] ?? '', parts[8] ?? '');
      return true;
    }
    // GET /api/v1/projects/:projectId/content/assets/:assetId
    if (n === 7 && parts[5] === 'assets') {
      if (method !== 'GET') return this.methodNotAllowed(res, 'GET');
      this.assetRecord(req, res, projectId, parts[6] ?? '');
      return true;
    }
    // GET /api/v1/projects/:projectId/content/integrity
    if (n === 6 && parts[5] === 'integrity') {
      if (method !== 'GET') return this.methodNotAllowed(res, 'GET');
      this.integrity(req, res, projectId);
      return true;
    }
    // GET /api/v1/projects/:projectId/content/jobs/:jobId
    if (n === 7 && parts[5] === 'jobs') {
      if (method !== 'GET') return this.methodNotAllowed(res, 'GET');
      this.job(req, res, projectId, parts[6] ?? '');
      return true;
    }
    return false;
  }

  private methodNotAllowed(res: ServerResponse, expected: string): true {
    this.deps.sendError(res, sessionError('invalid_request', 'validation', 'method not allowed', { expected }), 405);
    return true;
  }

  // ---- stage create / upload / inspect / discard ----------------------------

  private async createStage(req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> {
    const auth = this.deps.requireAuth(req, projectId, false);
    if (auth !== null) return this.deps.sendError(res, auth);
    const body = await this.readJsonBody(req, res);
    if (body === null) return;
    const parsed = parseStageCreateRequest(body);
    if (!parsed.ok) return this.deps.sendError(res, parsed.error);
    const value = parsed.value as Record<string, unknown>;
    const displayName = typeof value.displayName === 'string' ? value.displayName : undefined;
    const begun = this.uploads.begin(projectId, displayName);
    if (!begun.ok) return this.deps.sendError(res, begun.error);
    const expiresAt = new Date(this.deps.now() + FRAME_BOUND_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.deps.sendJson(res, 200, { ok: true, stageId: begun.stageId, expiresAt });
  }

  private async uploadBytes(req: IncomingMessage, res: ServerResponse, projectId: string, rawStageId: string): Promise<void> {
    const auth = this.deps.requireAuth(req, projectId, false);
    if (auth !== null) return this.deps.sendError(res, auth);
    const sid = parseStageId(rawStageId);
    if (!sid.ok) return this.deps.sendError(res, sid.error);
    // The stage must be an open upload session (a stage id alone is never
    // addressable): an unknown/expired/restarted session is stage_not_found.
    const session = this.uploads.get(sid.stageId);
    if (session === undefined || session.projectId !== projectId) {
      return this.deps.sendError(
        res,
        sessionError('stage_not_found', 'not_found', `no open upload stage '${sid.stageId}' (a restart or expiry loses it)`, {
          stageId: sid.stageId,
        }),
      );
    }
    const frame = await this.readFrame(req, res);
    if (frame === null) return;
    const headers = parseUploadFrameHeaders(req.headers as Record<string, string | string[] | undefined>, frame.length);
    if (!headers.ok) return this.deps.sendError(res, headers.error);
    if (frame.length > CONTENT_UPLOAD_FRAME_MAX) {
      return this.deps.sendError(res, frameLimit('frame_bytes', frame.length, CONTENT_UPLOAD_FRAME_MAX));
    }
    const job = this.jobs.begin('publish', projectId);
    if (!job.ok) return this.deps.sendError(res, job.error);
    const appended = this.uploads.append(projectId, sid.stageId, headers.offset, headers.declaredTotal, frame);
    if (!appended.ok) {
      this.jobs.fail(job.jobId, appended.error.code, appended.error.message);
      return this.deps.sendError(res, appended.error);
    }
    if (!appended.complete) {
      this.jobs.finish(job.jobId, { stageId: sid.stageId });
      this.deps.sendJson(res, 200, { ok: true, stageId: sid.stageId, byteLength: appended.received, complete: false, jobId: job.jobId });
      return;
    }
    // The single staged write (workspace-owned; the transport writes nothing).
    const staged = this.deps.service.stageContent(projectId, {
      stageId: sid.stageId,
      bytes: appended.bytes,
      ...(session.displayName !== undefined ? { displayName: session.displayName } : {}),
    });
    if (!staged.ok) {
      this.jobs.fail(job.jobId, staged.error.code, staged.error.message);
      return this.deps.sendError(res, commandErrorToSession(staged.error));
    }
    // The immutable blob publication is deliberately NOT performed here: it is
    // the last step of a *successful* inspection (workspace.md §13.3.2 order:
    // stage ⇒ refusal/caps ⇒ read ⇒ digest ⇒ import-profile validation ⇒
    // `publishBlob`). Publishing at upload completion would give a malformed
    // GLB a durable `sources/sha256/<digest>` blob, contradicting
    // workspace.md §13.4 F2 ("none"). The completed upload session is retained
    // (its displayName feeds the inspect proposal) until the caller discards it
    // or the TTL cleanup runs.
    if (this.jobs.overDeadline(job.jobId)) {
      // The bounded preparation budget elapsed: a late result is never
      // presented as success (job_expired on the job route; here refused).
      this.jobs.fail(job.jobId, 'content_publish_failed', 'the publish job exceeded its bounded budget');
      return this.deps.sendError(
        res,
        sessionError('content_publish_failed', 'unavailable', 'the publish job exceeded its bounded budget', {
          reason: 'timeout',
          jobId: job.jobId,
          stageId: sid.stageId,
        }),
      );
    }
    this.jobs.finish(job.jobId, { stageId: sid.stageId, digest: staged.digest, byteLength: staged.byteLength });
    this.deps.sendJson(res, 200, {
      ok: true,
      stageId: sid.stageId,
      byteLength: staged.byteLength,
      digest: staged.digest,
      complete: true,
      jobId: job.jobId,
    });
  }

  private async inspect(req: IncomingMessage, res: ServerResponse, projectId: string, rawStageId: string): Promise<void> {
    const auth = this.deps.requireAuth(req, projectId, false);
    if (auth !== null) return this.deps.sendError(res, auth);
    const sid = parseStageId(rawStageId);
    if (!sid.ok) return this.deps.sendError(res, sid.error);
    const body = await this.readJsonBody(req, res);
    if (body === null) return;
    // Packet 48: the additive `{ kind?, animation? }` inspect body requests the
    // bounded PCM-WAV inspector or the role-aware animated GLB profile
    // (presentation.md §41.3.3). An absent/empty body is the accepted M2 model
    // inspection, byte-unchanged.
    const inspected0 = parseStageInspectRequest(body);
    if (!inspected0.ok) return this.deps.sendError(res, inspected0.error);
    const job = this.jobs.begin('inspect', projectId);
    if (!job.ok) return this.deps.sendError(res, job.error);
    const upload = this.uploads.get(sid.stageId);
    const result = this.deps.service.inspectStage(projectId, sid.stageId, {
      isCancelled: () => this.jobs.isCancelled(job.jobId),
      ...(upload?.displayName !== undefined ? { displayName: upload.displayName } : {}),
      ...(inspected0.request.kind !== undefined ? { kind: inspected0.request.kind } : {}),
      ...(inspected0.request.animation !== undefined ? { animation: inspected0.request.animation } : {}),
    });
    if (!result.ok) {
      this.jobs.fail(job.jobId, result.error.code, result.error.message);
      return this.deps.sendError(res, commandErrorToSession(result.error));
    }
    // Step 2 of workspace.md §13.3.2: only an accepted import profile reaches
    // the immutable publication. A rejected (malformed) GLB therefore leaves no
    // durable blob (workspace.md §13.4 F2 durable effect "none"); its staged
    // input stays non-authoritative and TTL-bounded. The transport still writes
    // nothing itself — the workspace owns every byte of this write.
    const pubJob = this.jobs.begin('publish', projectId);
    if (!pubJob.ok) {
      this.jobs.fail(job.jobId, pubJob.error.code, pubJob.error.message);
      return this.deps.sendError(res, pubJob.error);
    }
    const published = this.deps.service.publishBlob(projectId, {
      digest: result.proposal.sourceDigest,
      byteLength: result.proposal.sourceByteLength,
      source: { kind: 'stage', stageId: sid.stageId },
    });
    if (!published.ok) {
      this.jobs.fail(pubJob.jobId, published.error.code, published.error.message);
      this.jobs.fail(job.jobId, published.error.code, published.error.message);
      return this.deps.sendError(res, commandErrorToSession(published.error));
    }
    if (this.jobs.overDeadline(pubJob.jobId)) {
      const message = 'the publish job exceeded its bounded budget';
      this.jobs.fail(pubJob.jobId, 'content_publish_failed', message);
      this.jobs.fail(job.jobId, 'content_publish_failed', message);
      return this.deps.sendError(
        res,
        sessionError('content_publish_failed', 'unavailable', message, {
          reason: 'timeout',
          jobId: pubJob.jobId,
          stageId: sid.stageId,
        }),
      );
    }
    this.jobs.finish(pubJob.jobId, {
      stageId: sid.stageId,
      digest: result.proposal.sourceDigest,
      byteLength: result.proposal.sourceByteLength,
    });
    const encoded = JSON.stringify({ ok: true, proposal: result.proposal, truncated: false });
    if (new TextEncoder().encode(encoded).length > CONTENT_PROPOSAL_MAX_BYTES) {
      // Keep the response bounded: drop the non-authoritative display lists
      // and report the truncation (the persistable facts are unchanged). Only
      // a model proposal carries the display lists; an audio proposal's
      // bounded `inspection` is already tiny and is passed through unchanged.
      const p = result.proposal;
      const proposal =
        p.kind === 'audio'
          ? p
          : {
              ...p,
              inspection: {
                nodeNames: [],
                materialNames: [],
                clipNames: [],
                sceneCount: (p.inspection as { sceneCount: number }).sceneCount,
                truncated: true,
              },
            };
      this.jobs.finish(job.jobId, { stageId: sid.stageId, proposalId: result.proposal.proposalId, status: result.proposal.status });
      this.deps.sendJson(res, 200, { ok: true, proposal, truncated: true, jobId: job.jobId });
      return;
    }
    this.jobs.finish(job.jobId, { stageId: sid.stageId, proposalId: result.proposal.proposalId, status: result.proposal.status });
    this.deps.sendJson(res, 200, { ok: true, proposal: result.proposal, truncated: false, jobId: job.jobId });
  }

  private discardStage(req: IncomingMessage, res: ServerResponse, projectId: string, rawStageId: string): void {
    const auth = this.deps.requireAuth(req, projectId, false);
    if (auth !== null) return this.deps.sendError(res, auth);
    const sid = parseStageId(rawStageId);
    if (!sid.ok) return this.deps.sendError(res, sid.error);
    const discarded = this.uploads.discard(sid.stageId);
    const result = this.deps.service.discardStage(projectId, sid.stageId);
    if (result.ok) {
      this.deps.sendJson(res, 200, { ok: true, discarded: result.discarded || discarded });
      return;
    }
    if (result.error.code === 'stage_not_found' && discarded) {
      // The only persisted copy was the in-memory upload buffer.
      this.deps.sendJson(res, 200, { ok: true, discarded: true });
      return;
    }
    this.deps.sendError(res, commandErrorToSession(result.error));
  }

  // ---- bounded content queries ----------------------------------------------

  private listAssets(req: IncomingMessage, res: ServerResponse, projectId: string, query: Map<string, string>): void {
    const auth = this.deps.requireAuth(req, projectId, false);
    if (auth !== null) return this.deps.sendError(res, auth);
    const parsed = parseContentAssetsQuery(query);
    if (!parsed.ok) return this.deps.sendError(res, parsed.error);
    const result = this.deps.service.query({ op: 'queryAssets', projectId, args: { limit: parsed.query.limit, offset: parsed.query.offset } });
    if (!result.ok) return this.deps.sendError(res, commandErrorToSession(result.error));
    const page = result as unknown as { assets: unknown; total: number; offset: number; limit: number };
    const next = page.offset + page.limit < page.total ? String(page.offset + page.limit) : null;
    this.deps.sendJson(res, 200, { ok: true, assets: page.assets, total: page.total, nextCursor: next });
  }

  private assetRecord(req: IncomingMessage, res: ServerResponse, projectId: string, rawAssetId: string): void {
    const auth = this.deps.requireAuth(req, projectId, false);
    if (auth !== null) return this.deps.sendError(res, auth);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(rawAssetId)) {
      return this.deps.sendError(res, sessionError('field_value', 'validation', 'assetId must use the project-model ID syntax', { path: '/assetId', found: rawAssetId.slice(0, 64) }));
    }
    const result = this.deps.service.query({ op: 'queryAssets', projectId, args: { assetId: rawAssetId, includeVersions: true, limit: 1, offset: 0 } });
    if (!result.ok) return this.deps.sendError(res, commandErrorToSession(result.error));
    const page = result as unknown as { assets: Array<Record<string, unknown>> };
    const asset = page.assets[0];
    if (asset === undefined) {
      return this.deps.sendError(res, sessionError('asset_not_found', 'validation', `no asset record '${rawAssetId}' exists in the catalog`, { assetId: rawAssetId }));
    }
    const versions = asset.versions ?? [];
    const summary = { ...asset };
    delete summary.versions;
    this.deps.sendJson(res, 200, { ok: true, asset: summary, versions });
  }

  private integrity(req: IncomingMessage, res: ServerResponse, projectId: string): void {
    const auth = this.deps.requireAuth(req, projectId, false);
    if (auth !== null) return this.deps.sendError(res, auth);
    const result = this.deps.service.contentIntegrity(projectId);
    if (!result.ok) return this.deps.sendError(res, commandErrorToSession(result.error));
    this.deps.sendJson(res, 200, { ok: true, entries: result.entries, summary: result.summary });
  }

  private job(req: IncomingMessage, res: ServerResponse, projectId: string, rawJobId: string): void {
    const auth = this.deps.requireAuth(req, projectId, false);
    if (auth !== null) return this.deps.sendError(res, auth);
    const parsed = parseJobId(rawJobId);
    if (!parsed.ok) return this.deps.sendError(res, parsed.error);
    const got = this.jobs.get(parsed.jobId);
    if (!got.ok) return this.deps.sendError(res, got.error);
    if (got.job.projectId !== projectId) {
      // Project scoping: another project's job is indistinguishable from absent.
      return this.deps.sendError(res, sessionError('job_not_found', 'not_found', `no content job '${parsed.jobId}' exists`, { jobId: parsed.jobId }));
    }
    this.deps.sendJson(res, 200, { ok: true, job: got.job });
  }

  // ---- authenticated committed asset bytes (sessions.md §16.1) ---------------

  private assetBytes(req: IncomingMessage, res: ServerResponse, projectIdRaw: string, rawAssetId: string, rawVersion: string): void {
    const auth = this.deps.requireAuth(req, projectIdRaw, false);
    if (auth !== null) return this.deps.sendError(res, auth);
    const parsed = parseAssetByteParams(projectIdRaw, rawAssetId, rawVersion);
    if (!parsed.ok) return this.deps.sendError(res, parsed.error);
    const result = this.deps.service.readBlob(parsed.params.projectId, {
      assetId: parsed.params.assetId,
      version: parsed.params.version,
    });
    if (!result.ok) return this.deps.sendError(res, commandErrorToSession(result.error));
    if (result.byteLength > CONTENT_ASSET_BYTES_MAX) {
      return this.deps.sendError(res, frameLimit('stage_bytes', result.byteLength, CONTENT_ASSET_BYTES_MAX));
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(result.byteLength));
    res.setHeader('x-thirdlight-digest', result.digest);
    res.setHeader('etag', `"${result.digest}"`);
    res.setHeader('cache-control', CONTENT_ASSET_BYTES_CACHE);
    res.statusCode = 200;
    res.end(result.bytes);
  }

  // ---- bounded body readers --------------------------------------------------

  /** Strict JSON body (≤ 1 MiB), `{}` when empty; `null` on a sent error. */
  private async readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
    const bytes = await this.readBounded(req, res, 1024 * 1024, 'invalid_request');
    if (bytes === null) return null;
    // The same strict byte discipline as the command route (sessions.md §6.1:
    // BOM-free UTF-8, strict JSON, no duplicate keys).
    const strict = parseStrictJsonBytes(bytes.length === 0 ? new TextEncoder().encode('{}') : bytes);
    if (!strict.ok) {
      this.deps.sendError(res, strict.error);
      return null;
    }
    return strict.value;
  }

  /** The raw upload frame (bounded by the frame cap; oversize ⇒ null + error). */
  private async readFrame(req: IncomingMessage, res: ServerResponse): Promise<Uint8Array | null> {
    const declared = req.headers['content-length'];
    if (typeof declared === 'string') {
      const n = Number(declared);
      if (Number.isInteger(n) && n > CONTENT_UPLOAD_FRAME_MAX) {
        this.deps.sendError(res, frameLimit('frame_bytes', n, CONTENT_UPLOAD_FRAME_MAX));
        return null;
      }
    }
    const bytes = await this.readBounded(req, res, CONTENT_UPLOAD_FRAME_MAX, 'frame');
    return bytes;
  }

  private readBounded(req: IncomingMessage, res: ServerResponse, max: number, kind: 'frame' | 'invalid_request'): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let done = false;
      const fail = (error: SessionError): void => {
        if (done) return;
        done = true;
        this.deps.sendError(res, error);
        resolve(null);
      };
      req.on('data', (chunk: Uint8Array) => {
        if (done) return;
        size += chunk.length;
        if (size > max) {
          if (kind === 'frame') fail(frameLimit('frame_bytes', size, CONTENT_UPLOAD_FRAME_MAX));
          else fail(sessionError('invalid_request', 'validation', 'request body exceeds the 1 MiB bound'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        const out = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        resolve(out);
      });
      req.on('error', () => fail(sessionError('invalid_request', 'validation', 'request body read failed')));
    });
  }
}
