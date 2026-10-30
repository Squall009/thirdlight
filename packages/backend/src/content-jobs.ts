/**
 * The content transport's bounded in-memory coordinators: inspection and
 * publish jobs (cancellation, expiry, late results discarded) and upload
 * assembly (bounded frames, one staged write through the workspace on
 * completion). Records are bounded summaries, never payloads.
 */

import { randomBytes } from 'node:crypto';
import {
  CONTENT_INSPECT_TIMEOUT_MS,
  CONTENT_JOB_RESULT_TTL_MS,
  CONTENT_OPEN_STAGES,
  CONTENT_PUBLISH_CONCURRENCY_GLOBAL,
  CONTENT_PUBLISH_CONCURRENCY_PER_PROJECT,
  CONTENT_PUBLISH_TIMEOUT_MS,
  CONTENT_STAGE_MAX,
  CONTENT_UPLOAD_FRAME_MAX,
  checkUploadFrame,
  sessionError,
  type ContentJobKind,
  type ContentJobState,
  type ContentJobView,
  type SessionError,
} from '@thirdlight/protocol';

/** `stage_limits_exceeded` for the transport-level frame/interaction bounds. */
export function frameLimit(limit: string, current: number, max: number): SessionError {
  return sessionError('stage_limits_exceeded', 'validation', `a staging bound is exceeded: ${limit} ${current} > ${max}`, {
    limit,
    current,
    max,
    expected: `≤ ${max}`,
  });
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
 * Bounded in-memory job coordinator with cancellation/expiry and late-result
 * handling. Records
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
   * 4/global); exceeding it is `content_publish_failed`
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
