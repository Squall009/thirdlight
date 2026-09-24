/**
 * Content browser import/publish flow (sessions.md §19; commands.md §3.1.1/
 * §4/§8.5; packet 27).
 *
 * Pure state machine for one asset authoring flow:
 *
 *   drop candidate → create stage → upload frames → inspect (bounded job)
 *     → proposal → publishAsset (create | reimport) → committed
 *
 * Normative behaviors this module makes testable in Node:
 *
 *  - the **committed catalog** lives only in `ContentProjection` and is updated
 *    only by an applied `publishAsset` change. A failed upload, a failed
 *    inspect, a stale/late job or a cancelled flow therefore leaves the
 *    previous committed content and the projection untouched;
 *  - a **stale job result is a proposal, not an applied edit**: a proposal
 *    whose `stageId`/`jobId` no longer matches, or a job that reports
 *    `expired`/`cancelled`/`lateResultDiscarded`, never becomes publishable;
 *  - every bound is the contract's (frame ≤ 1 MiB, stage ≤ 32 MiB, job record
 *    TTL 900 s, page 1–128).
 *
 * Pure: no DOM, no I/O, no Node builtins, no network. The transport (the
 * client) performs the HTTP calls; this module decides what each result means.
 */

import {
  CONTENT_ASSETS_LIMIT_DEFAULT,
  CONTENT_ASSETS_LIMIT_MAX,
  CONTENT_STAGE_MAX,
  CONTENT_UPLOAD_FRAME_MAX,
  CONTENT_JOB_RESULT_TTL_MS,
  type ContentJobState,
  type ContentJobView,
} from '@thirdlight/protocol';

/** The only import extension M2 accepts (`project-model` §18.7 glTF 2.0 GLB). */
export const ASSET_DROP_EXTENSION = '.glb';

export type ImportPhase =
  | 'idle'
  | 'staging'
  | 'uploading'
  | 'inspecting'
  | 'proposed'
  | 'publishing'
  | 'committed'
  | 'failed'
  | 'cancelled'
  | 'stale';

/** What the current flow publishes: a new record, or a new version of one. */
export interface ImportTarget {
  mode: 'create' | 'reimport';
  /** Required for `reimport`; ignored (backend-assigned by the caller) for create. */
  assetId: string | null;
  displayName: string | null;
}

/** The bounded inspection proposal the inspect route returned (never bytes). */
export interface ImportProposal {
  /** The upload stage, or `null` for a file inspected in place in the game folder. */
  stageId: string | null;
  /** The game-folder file the version will reference (import from project folder). */
  sourcePath?: string;
  /** Set when the model was converted from an FBX at import (the original's facts). */
  convertedFrom?: unknown;
  digest: string;
  byteLength: number;
  status: string;
  /** The validated `asset-pipeline` proposal payload (bounded by the route). */
  proposal: unknown;
}

export interface AssetImportState {
  phase: ImportPhase;
  target: ImportTarget | null;
  stageId: string | null;
  /** Set for an import from the project folder: the file inspected in place. */
  sourcePath: string | null;
  jobId: string | null;
  bytesSent: number;
  totalBytes: number;
  proposal: ImportProposal | null;
  /** A bounded job status snapshot (never the proposal payload itself). */
  job: { jobId: string; state: ContentJobState } | null;
  error: { code: string; message: string } | null;
}

export const initialImportState: AssetImportState = Object.freeze({
  phase: 'idle',
  target: null,
  stageId: null,
  sourcePath: null,
  jobId: null,
  bytesSent: 0,
  totalBytes: 0,
  proposal: null,
  job: null,
  error: null,
});

function next(state: AssetImportState, patch: Partial<AssetImportState>): AssetImportState {
  return { ...state, ...patch };
}

/** Phases in which a flow is in flight (the UI disables a second import). */
export function isBusy(state: AssetImportState): boolean {
  return state.phase === 'staging' || state.phase === 'uploading' || state.phase === 'inspecting' || state.phase === 'publishing';
}

/** Whether the current flow produced a publishable proposal. */
export function canPublish(state: AssetImportState): boolean {
  return state.phase === 'proposed' && state.proposal !== null;
}

// ---- drop validation -----------------------------------------------------------

export interface DropCandidate {
  name: string;
  byteLength: number;
}

export type DropVerdict =
  | { ok: true; displayName: string }
  | { ok: false; error: { code: string; message: string } };

/**
 * Validate a dropped/selected file **before** any network call: `.glb` only,
 * 1 … 32 MiB (the stage bound). An invalid drop creates no stage and no job
 * (sessions.md §19.1: the route rejects the frame; the editor explains it).
 */
export function validateDropCandidate(candidate: DropCandidate): DropVerdict {
  const name = candidate.name.trim();
  if (!name.toLowerCase().endsWith(ASSET_DROP_EXTENSION)) {
    return {
      ok: false,
      error: { code: 'import_rejected', message: `only ${ASSET_DROP_EXTENSION} (glTF binary) files can be imported` },
    };
  }
  if (!Number.isInteger(candidate.byteLength) || candidate.byteLength < 1) {
    return { ok: false, error: { code: 'import_rejected', message: 'the dropped file is empty' } };
  }
  if (candidate.byteLength > CONTENT_STAGE_MAX) {
    return {
      ok: false,
      error: {
        code: 'stage_limits_exceeded',
        message: `the file is ${candidate.byteLength} bytes; the stage bound is ${CONTENT_STAGE_MAX}`,
      },
    };
  }
  const displayName = name.slice(0, name.length - ASSET_DROP_EXTENSION.length).slice(0, 128) || name.slice(0, 128);
  return { ok: true, displayName };
}

// ---- upload frame planning -----------------------------------------------------

export interface UploadFrame {
  offset: number;
  length: number;
}

/**
 * Split a source into the bounded upload frames the route accepts
 * (workspace.md §7.6.2: one frame ≤ 1 MiB, sequential `X-Thirdlight-Offset`).
 */
export function planUploadFrames(byteLength: number, frameMax: number = CONTENT_UPLOAD_FRAME_MAX): UploadFrame[] {
  if (!Number.isInteger(byteLength) || byteLength < 1 || !Number.isInteger(frameMax) || frameMax < 1) return [];
  const frames: UploadFrame[] = [];
  for (let offset = 0; offset < byteLength; offset += frameMax) {
    frames.push({ offset, length: Math.min(frameMax, byteLength - offset) });
  }
  return frames;
}

// ---- flow transitions ----------------------------------------------------------

/** Start a flow. A failed/cancelled/committed flow may be restarted. */
export function beginImport(state: AssetImportState, target: ImportTarget): AssetImportState {
  if (isBusy(state)) return state; // never two flows at once
  return next(state, {
    phase: 'staging',
    target: { ...target },
    stageId: null,
    sourcePath: null,
    jobId: null,
    bytesSent: 0,
    totalBytes: 0,
    proposal: null,
    job: null,
    error: null,
  });
}

/**
 * Start an import from the project folder: no stage and no upload, the file is
 * inspected where it is (`POST /content/project-files/inspect`).
 */
export function beginProjectFileImport(state: AssetImportState, target: ImportTarget, sourcePath: string): AssetImportState {
  if (isBusy(state)) return state;
  return next(beginImport(state, target), { phase: 'inspecting', sourcePath });
}

/** `POST /content/stages` succeeded. */
export function stageCreated(state: AssetImportState, stageId: string, totalBytes: number): AssetImportState {
  if (state.phase !== 'staging') return state;
  return next(state, { phase: 'uploading', stageId, totalBytes, bytesSent: 0 });
}

/** One accepted `PUT /content/stages/:stageId/bytes` frame. */
export function frameSent(state: AssetImportState, bytesSent: number): AssetImportState {
  if (state.phase !== 'uploading') return state;
  return next(state, { bytesSent: Math.max(0, Math.min(state.totalBytes, bytesSent)) });
}

/** All frames acknowledged; the inspect call is next. */
export function uploadCompleted(state: AssetImportState): AssetImportState {
  if (state.phase !== 'uploading') return state;
  if (state.bytesSent !== state.totalBytes || state.totalBytes < 1) {
    return importFailed(state, { code: 'content_frame_invalid', message: 'the upload did not deliver the declared total' });
  }
  return next(state, { phase: 'inspecting' });
}

/**
 * `POST .../inspect` returned a proposal. The proposal is accepted only when it
 * belongs to THIS stage and the flow is still inspecting — a result for a
 * superseded stage is a stale proposal and is discarded (never publishable).
 */
export function inspectionSucceeded(state: AssetImportState, proposal: ImportProposal): AssetImportState {
  if (state.phase !== 'inspecting') return state;
  if (state.sourcePath !== null) {
    const file = proposal.sourcePath ?? (proposal.convertedFrom as { sourcePath?: string } | undefined)?.sourcePath;
    if (file !== state.sourcePath) return stale(state, 'inspect result belongs to another file');
    return next(state, { phase: 'proposed', proposal });
  }
  if (proposal.stageId !== state.stageId) return stale(state, 'inspect result belongs to a superseded stage');
  return next(state, { phase: 'proposed', proposal });
}

/**
 * A bounded job read (`GET /content/jobs/:jobId`). `expired`, `cancelled` and a
 * discarded late result move the flow to `stale` and clear the proposal so it
 * can never be published; only `succeeded` keeps the flow publishable.
 */
export function jobUpdated(state: AssetImportState, job: ContentJobView): AssetImportState {
  if (state.jobId !== null && job.jobId !== state.jobId) return state;
  if (job.state === 'expired' || job.state === 'cancelled' || job.lateResultDiscarded === true) {
    return next(stale(state, `the inspection job is ${job.state}`), { jobId: job.jobId, job: { jobId: job.jobId, state: job.state } });
  }
  if (job.state === 'failed') {
    const code = job.error?.code ?? 'import_rejected';
    return next(importFailed(state, { code, message: job.error?.message ?? code }), {
      jobId: job.jobId,
      job: { jobId: job.jobId, state: job.state },
    });
  }
  return next(state, { jobId: job.jobId, job: { jobId: job.jobId, state: job.state } });
}

/** The `publishAsset` command was submitted (its ack is the HTTP response). */
export function publishStarted(state: AssetImportState): AssetImportState {
  if (!canPublish(state)) return state;
  return next(state, { phase: 'publishing' });
}

/**
 * The `publishAsset` command applied. The catalog itself is advanced by the
 * `mutation.applied` change (the content projection), not here — a failure of
 * the command simply leaves this flow in `failed` and the catalog untouched.
 */
export function committed(state: AssetImportState): AssetImportState {
  if (state.phase !== 'publishing') return state;
  return next(state, { phase: 'committed' });
}

/** A failed upload/inspect/publish: previous committed content is untouched. */
export function importFailed(state: AssetImportState, error: { code: string; message: string }): AssetImportState {
  return next(state, { phase: 'failed', error: { ...error }, proposal: null });
}

/** Cancel: no publish is sent; the stage is discarded by the transport. */
export function cancelImport(state: AssetImportState): AssetImportState {
  if (state.phase === 'committed' || state.phase === 'failed') return state;
  return next(state, { phase: 'cancelled', proposal: null, error: null });
}

/** The stage was discarded / the flow reset (`DELETE .../stages/:stageId`). */
export function discardImport(state: AssetImportState): AssetImportState {
  return { ...initialImportState, target: state.target ? { ...state.target } : null };
}

function stale(state: AssetImportState, message: string): AssetImportState {
  return next(state, { phase: 'stale', proposal: null, error: { code: 'job_expired', message } });
}

/** The bounded job-record TTL the client uses before treating a poll as expired. */
export function jobResultTtlMs(): number {
  return CONTENT_JOB_RESULT_TTL_MS;
}

// ---- publish args from a proposal ------------------------------------------------

/** `YYYY-MM-DDTHH:mm:ssZ` (project-model §7.2 second precision). */
export function utcSecondTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The strict `publishAsset` args (commands.md §3.1.1/§A3.5) — stage-free facts only. */
export interface PublishAssetRequestArgs {
  mode: 'create' | 'reimport';
  assetId: string;
  /** §A3.5: required on a create; on a reimport it must equal the record's kind. */
  kind: 'model' | 'audio' | 'texture';
  displayName?: string;
  sourceDigest: string;
  sourceByteLength: number;
  /** A file referenced in place in the game folder (import from project folder). */
  sourcePath?: string;
  /** The FBX a converted model was made from (the backend's facts, passed through). */
  convertedFrom?: unknown;
  importRecipe: unknown;
  metrics: unknown;
  importedAt: string;
  /** §8.5.1: the atomic animated reimport (model reimport only). */
  animation?: { entityId: string; roles: unknown };
}

export type PublishArgsResult =
  | { ok: true; args: PublishAssetRequestArgs }
  | { ok: false; error: { code: string; message: string } };

/**
 * Build the exact `publishAsset` args from an accepted inspection proposal.
 * Only an `ok` proposal can be published (a rejected proposal never reaches
 * this path — the inspect route already returned `import_rejected`), and the
 * digest/byte length/recipe/metrics always come from the proposal rather than
 * from anything the editor recomputed. M3 (packet 43/48 §A3.5): `kind` is
 * REQUIRED on a create (the discriminator is immutable at create) and, on a
 * reimport, must equal the record's kind — the caller passes the kind the
 * drop validation decided.
 */
export function publishArgsFromProposal(
  proposal: ImportProposal,
  target: ImportTarget,
  importedAt: string,
  kind: 'model' | 'audio' | 'texture',
  animation?: { entityId: string; roles: unknown },
): PublishArgsResult {
  const p = proposal.proposal as {
    status?: unknown;
    sourceDigest?: unknown;
    sourceByteLength?: unknown;
    importRecipe?: unknown;
    metrics?: unknown;
    kind?: unknown;
  } | null;
  if (p === null || typeof p !== 'object') {
    return { ok: false, error: { code: 'import_rejected', message: 'the inspection proposal is not an object' } };
  }
  if (p.status !== 'ok') {
    return { ok: false, error: { code: 'import_rejected', message: 'the inspection proposal was not accepted' } };
  }
  if (typeof p.sourceDigest !== 'string' || typeof p.sourceByteLength !== 'number') {
    return { ok: false, error: { code: 'import_rejected', message: 'the proposal carries no source digest/length' } };
  }
  if (target.mode === 'reimport' && !target.assetId) {
    return { ok: false, error: { code: 'field_missing', message: 'a reimport needs the existing assetId' } };
  }
  const assetId = target.mode === 'create' ? target.assetId : target.assetId;
  if (!assetId) {
    return { ok: false, error: { code: 'field_missing', message: 'the import has no assetId yet' } };
  }
  return {
    ok: true,
    args: {
      mode: target.mode,
      assetId,
      kind,
      ...(target.displayName ? { displayName: target.displayName } : {}),
      sourceDigest: p.sourceDigest,
      sourceByteLength: p.sourceByteLength,
      ...(proposal.sourcePath !== undefined ? { sourcePath: proposal.sourcePath } : {}),
      ...(proposal.convertedFrom !== undefined ? { convertedFrom: proposal.convertedFrom } : {}),
      importRecipe: p.importRecipe,
      metrics: p.metrics,
      importedAt,
      ...(animation !== undefined ? { animation } : {}),
    },
  };
}

// ---- asset query paging --------------------------------------------------------

export interface AssetPageRequest {
  limit: number;
  offset: number;
}

/** Clamp a page request into the contract's `queryAssets` bounds (1–128). */
export function planAssetQuery(request: Partial<AssetPageRequest>): AssetPageRequest {
  const rawLimit = request.limit ?? CONTENT_ASSETS_LIMIT_DEFAULT;
  const rawOffset = request.offset ?? 0;
  const limit = Math.max(1, Math.min(CONTENT_ASSETS_LIMIT_MAX, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : CONTENT_ASSETS_LIMIT_DEFAULT));
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  return { limit, offset };
}

export interface AssetQueryState {
  total: number;
  offset: number;
  limit: number;
  /** True when the backend reported more pages. */
  hasMore: boolean;
}

/** Fold one `queryAssets` page into the paging state. */
export function applyAssetQueryPage(state: AssetQueryState | null, page: { total: number; offset: number; limit: number; count: number }): AssetQueryState {
  const prevTotal = state?.total ?? 0;
  return {
    total: Math.max(0, page.total, prevTotal),
    offset: page.offset,
    limit: page.limit,
    hasMore: page.offset + page.count < Math.max(page.total, prevTotal),
  };
}
