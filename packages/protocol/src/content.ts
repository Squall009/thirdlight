/**
 * M2 content transport wire shapes + strict validators (packet 25).
 *
 * The single home of the content route/message/error shapes added by packet
 * 25 (dependencies.md §3 `protocol` row: "the packet-19 route/message/error
 * types + strict validators (asset-byte reads, content/job/query ...) — the
 * sole wire-shape home"). Everything here is a **pure** validator/builder:
 * no I/O, no filesystem, no workspace/backend import. The M1 exports in
 * `http.ts`/`ws-events.ts` are unchanged; the packet-25 additions are
 * additive and versioned by their own constant set.
 *
 * Sources: sessions.md §11.3/§11.5/§16.1 (asset-byte reads, error codes,
 * bounds); workspace.md §13.9/§7.6.2 (upload/stage bounds); delivery.md §15
 * and `fixtures/m2/contracts/delivery/{protocol-surface,upload-bounds}.json`
 * (content/job/query routes and the re-derived upload-bound cases).
 */
import { isProjectId } from './ids';
import { checkField, checkShape, isPlainObject, type FieldErrorResult } from './strict';
import { sessionError, type SessionError } from './errors';

// ---- constants (sessions.md §11.5; workspace.md §13.9) ------------------------

/** §11.5: one upload frame ≤ 1 MiB. */
export const CONTENT_UPLOAD_FRAME_MAX = 1_048_576;
/** §11.5/§13.9: one staged source (and one authoritative source blob) ≤ 32 MiB. */
export const CONTENT_STAGE_MAX = 33_554_432;
/** §13.9: ≤ 128 MiB of staged bytes per project. */
export const CONTENT_STAGED_BYTES_PER_PROJECT = 134_217_728;
/** §7.6.2: ≤ 8 open stages per project. */
export const CONTENT_OPEN_STAGES = 8;
/** §11.5: the asset byte-read response cap (32 MiB). */
export const CONTENT_ASSET_BYTES_MAX = 33_554_432;
/** §15: proposal response ≤ 256 KiB. */
export const CONTENT_PROPOSAL_MAX_BYTES = 262_144;
/** §11.5/§18: inspection job budget 30 s. */
export const CONTENT_INSPECT_TIMEOUT_MS = 30_000;
/** §11.5: publish job budget 120 s. */
export const CONTENT_PUBLISH_TIMEOUT_MS = 120_000;
/** §13.9: ≤ 2 concurrent publishes per project. */
export const CONTENT_PUBLISH_CONCURRENCY_PER_PROJECT = 2;
/** §13.9: ≤ 4 concurrent publishes globally. */
export const CONTENT_PUBLISH_CONCURRENCY_GLOBAL = 4;
/** The bounded lifetime of a completed job record (late results are refused). */
export const CONTENT_JOB_RESULT_TTL_MS = 900_000;
/** The asset-list/query page ceiling (commands.md §4 `queryAssets`). */
export const CONTENT_ASSETS_LIMIT_MAX = 128;
export const CONTENT_ASSETS_LIMIT_DEFAULT = 50;

/** A `stageId` is a project-model §5.1 ID (workspace.md §7.6.1). */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The response `Content-Length` bound for a JSON route. */
export const CONTENT_STAGE_CREATE_RESPONSE_MAX = 4096;
/** Asset-byte read cache rule (sessions.md §16.1). */
export const CONTENT_ASSET_BYTES_CACHE = 'private, max-age=31536000, immutable';

// ---- upload framing (workspace.md §7.6.2; upload-bounds.json) -----------------

export interface UploadFrameCheckInput {
  /** The frame body length in bytes. */
  frameBytes: number;
  /** The frame's declared start offset (`X-Thirdlight-Offset`). */
  offset: number;
  /** The bytes already received for this stage (the expected next offset). */
  expectedOffset: number;
  /** The declared full source length (`X-Thirdlight-Total`). */
  declaredTotal: number;
  /** Currently open stages for the project (including this one). */
  openStages: number;
  /** Staged bytes currently held for the project. */
  stagedBytes: number;
}

export type UploadFrameVerdict =
  | { accepted: true; complete: boolean }
  | {
      accepted: false;
      code: 'content_frame_invalid' | 'stage_limits_exceeded';
      limit?: 'frame_bytes' | 'stage_bytes' | 'open_stages' | 'staged_bytes_per_project';
    };

/**
 * The bounded upload-frame decision (workspace.md §13.9 + the re-derived
 * `fixtures/m2/contracts/delivery/upload-bounds.json` cases; the order is the
 * checker's derived order: frame cap → offset → declared total → open stages →
 * project staged-bytes cap). Pure.
 */
export function checkUploadFrame(input: UploadFrameCheckInput): UploadFrameVerdict {
  const { frameBytes, offset, expectedOffset, declaredTotal, openStages, stagedBytes } = input;
  if (!Number.isInteger(frameBytes) || frameBytes < 0) {
    return { accepted: false, code: 'content_frame_invalid' };
  }
  if (frameBytes > CONTENT_UPLOAD_FRAME_MAX) {
    return { accepted: false, code: 'stage_limits_exceeded', limit: 'frame_bytes' };
  }
  if (offset !== expectedOffset) return { accepted: false, code: 'content_frame_invalid' };
  if (!Number.isInteger(declaredTotal) || declaredTotal < 1 || declaredTotal > CONTENT_STAGE_MAX) {
    return { accepted: false, code: 'stage_limits_exceeded', limit: 'stage_bytes' };
  }
  if (openStages >= CONTENT_OPEN_STAGES) {
    return { accepted: false, code: 'stage_limits_exceeded', limit: 'open_stages' };
  }
  if (stagedBytes + frameBytes > CONTENT_STAGED_BYTES_PER_PROJECT) {
    return { accepted: false, code: 'stage_limits_exceeded', limit: 'staged_bytes_per_project' };
  }
  if (frameBytes === 0 || offset + frameBytes > declaredTotal) {
    return { accepted: false, code: 'content_frame_invalid' };
  }
  return { accepted: true, complete: offset + frameBytes === declaredTotal };
}

/** The strict upload-frame headers (sessions.md §11.3 `content_frame_invalid`). */
export function parseUploadFrameHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  bodyLength: number,
):
  | { ok: true; offset: number; declaredTotal: number; frameBytes: number }
  | { ok: false; error: SessionError } {
  const rawOffset = firstHeader(headers['x-thirdlight-offset']);
  const rawTotal = firstHeader(headers['x-thirdlight-total']);
  const offset = parseNonNegInt(rawOffset);
  if (offset === null) {
    return {
      ok: false,
      error: sessionError('content_frame_invalid', 'validation', 'X-Thirdlight-Offset must be a non-negative integer', {
        path: 'X-Thirdlight-Offset',
        found: rawOffset === undefined ? '(absent)' : String(rawOffset).slice(0, 64),
        expected: 'integer ≥ 0',
      }),
    };
  }
  const declaredTotal = parseNonNegInt(rawTotal);
  if (declaredTotal === null || declaredTotal < 1) {
    return {
      ok: false,
      error: sessionError('content_frame_invalid', 'validation', 'X-Thirdlight-Total must be a positive integer (the declared source length)', {
        path: 'X-Thirdlight-Total',
        found: rawTotal === undefined ? '(absent)' : String(rawTotal).slice(0, 64),
        expected: 'integer ≥ 1',
      }),
    };
  }
  return { ok: true, offset, declaredTotal, frameBytes: bodyLength };
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function parseNonNegInt(v: string | undefined): number | null {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

// ---- asset-byte reads (sessions.md §16.1) -------------------------------------

export interface AssetByteParams {
  projectId: string;
  assetId: string;
  version: number;
}

/** A path-shaped identifier segment is rejected before any storage call (§16.1). */
function pathShaped(raw: string): boolean {
  return raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw.includes('%');
}

/**
 * Strict `(projectId, assetId, version)` for
 * `GET /api/v1/projects/:projectId/content/assets/:assetId/versions/:version/bytes`.
 * Path-shaped values ⇒ `path_rejected`; syntax/type failures ⇒ `field_value`
 * (both before any workspace/storage call).
 */
export function parseAssetByteParams(
  rawProjectId: string,
  rawAssetId: string,
  rawVersion: string,
):
  | { ok: true; params: AssetByteParams }
  | { ok: false; error: SessionError } {
  if (pathShaped(rawProjectId) || pathShaped(rawAssetId) || pathShaped(rawVersion)) {
    return {
      ok: false,
      error: sessionError('path_rejected', 'validation', 'an identifier segment contains a path separator or an encoded separator', {
        path: '/',
        found: [rawProjectId, rawAssetId, rawVersion].map((s) => s.slice(0, 64)).join(' | '),
        expected: 'bare identifiers only (no /, \\, %xx or ..)',
      }),
    };
  }
  if (!isProjectId(rawProjectId)) {
    return { ok: false, error: fieldValue('/projectId', rawProjectId, 'project-model ID syntax') };
  }
  if (!ID_RE.test(rawAssetId)) {
    return { ok: false, error: fieldValue('/assetId', rawAssetId, 'project-model ID syntax') };
  }
  if (!/^[1-9][0-9]*$/.test(rawVersion)) {
    return { ok: false, error: fieldValue('/version', rawVersion, 'a positive integer (decimal, no leading zeros)') };
  }
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version)) {
    return { ok: false, error: fieldValue('/version', rawVersion, 'a positive integer ≤ 2^53−1') };
  }
  return { ok: true, params: { projectId: rawProjectId, assetId: rawAssetId, version } };
}

// ---- stage routes -------------------------------------------------------------

const STAGE_CREATE_FIELDS = new Map([['displayName', 'string 1–128, no control chars (optional)']]);

/**
 * `POST /api/v1/projects/:projectId/content/stages` body: strict, optional
 * `displayName` only (the stage id is server-allocated).
 */
export function parseStageCreateRequest(value: unknown): FieldErrorResult {
  const shape = checkShape(value ?? {}, '', STAGE_CREATE_FIELDS, []);
  if (!shape.ok) return { ok: false, error: shape.error };
  if (shape.value.displayName !== undefined) {
    const dn = checkField(shape.value, 'displayName', '', 'string 1–128, no control chars', (v) =>
      typeof v === 'string' && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v)
        ? null
        : { problem: 'displayName must be 1–128 chars with no control characters', kind: 'value' },
    );
    if (!dn.ok) return { ok: false, error: dn.error };
  }
  return { ok: true, value: shape.value };
}

/** A `stageId` path segment (`project-model` §5.1 ID syntax). */
export function parseStageId(raw: string): { ok: true; stageId: string } | { ok: false; error: SessionError } {
  if (pathShaped(raw)) {
    return {
      ok: false,
      error: sessionError('path_rejected', 'validation', 'stageId contains a path separator or an encoded separator', {
        path: '/stageId',
        found: raw.slice(0, 64),
        expected: 'project-model ID syntax (no /, \\, %xx or ..)',
      }),
    };
  }
  if (!ID_RE.test(raw)) return { ok: false, error: fieldValue('/stageId', raw, 'project-model ID syntax') };
  return { ok: true, stageId: raw };
}

/** A `jobId` path segment (`job-` + 32 lowercase hex). */
export function parseJobId(raw: string): { ok: true; jobId: string } | { ok: false; error: SessionError } {
  if (pathShaped(raw)) {
    return {
      ok: false,
      error: sessionError('path_rejected', 'validation', 'jobId contains a path separator or an encoded separator', {
        path: '/jobId',
        found: raw.slice(0, 64),
        expected: 'job- + 32 lowercase hex',
      }),
    };
  }
  if (!/^job-[0-9a-f]{32}$/.test(raw)) return { ok: false, error: fieldValue('/jobId', raw, 'job- + 32 lowercase hex') };
  return { ok: true, jobId: raw };
}

// ---- bounded content queries --------------------------------------------------

export interface ContentAssetsQuery {
  limit: number;
  offset: number;
}

/** `GET .../content/assets?limit&offset` (commands.md §4 `queryAssets` bounds). */
export function parseContentAssetsQuery(
  params: ReadonlyMap<string, string>,
):
  | { ok: true; query: ContentAssetsQuery }
  | { ok: false; error: SessionError } {
  for (const key of params.keys()) {
    if (key !== 'limit' && key !== 'offset') {
      return { ok: false, error: sessionError('field_unexpected', 'validation', `unknown query parameter "${key.slice(0, 64)}"`, { path: `?${key.slice(0, 64)}`, expected: 'limit, offset' }) };
    }
  }
  let limit = CONTENT_ASSETS_LIMIT_DEFAULT;
  const rawLimit = params.get('limit');
  if (rawLimit !== undefined) {
    if (!/^[0-9]+$/.test(rawLimit)) return { ok: false, error: fieldValue('/limit', rawLimit, 'an integer 1–128') };
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > CONTENT_ASSETS_LIMIT_MAX) {
      return { ok: false, error: fieldValue('/limit', rawLimit, 'an integer 1–128') };
    }
  }
  let offset = 0;
  const rawOffset = params.get('offset');
  if (rawOffset !== undefined) {
    if (!/^[0-9]+$/.test(rawOffset)) return { ok: false, error: fieldValue('/offset', rawOffset, 'an integer ≥ 0') };
    offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, error: fieldValue('/offset', rawOffset, 'an integer ≥ 0') };
  }
  return { ok: true, query: { limit, offset } };
}

function fieldValue(path: string, found: unknown, expected: string): SessionError {
  return sessionError('field_value', 'validation', `${path} has an invalid value`, {
    path,
    found: (typeof found === 'string' ? found : JSON.stringify(found) ?? String(found)).slice(0, 64),
    expected,
  });
}

// ---- content jobs (delivery.md §15 `GET .../content/jobs/:jobId`) ------------

export const CONTENT_JOB_KINDS = ['inspect', 'publish'] as const;
export type ContentJobKind = (typeof CONTENT_JOB_KINDS)[number];

export const CONTENT_JOB_STATES = ['pending', 'succeeded', 'failed', 'cancelled', 'expired'] as const;
export type ContentJobState = (typeof CONTENT_JOB_STATES)[number];

/**
 * The bounded job view (≤ 16 KiB). `result` carries only a bounded summary —
 * never bytes (the proposal itself is returned by the synchronous inspect
 * route and is re-queryable through the proposal's own proposalId).
 */
export interface ContentJobView {
  jobId: string;
  projectId: string;
  kind: ContentJobKind;
  state: ContentJobState;
  createdAt: string;
  expiresAt: string;
  /** Present when `state === 'succeeded'` (a bounded summary). */
  result?: { stageId?: string; digest?: string; byteLength?: number; proposalId?: string; status?: string };
  /** Present when `state === 'failed'` (a stable code). */
  error?: { code: string; message: string };
  /** True when a result arrived after cancellation/expiry was recorded. */
  lateResultDiscarded?: true;
}

const JOB_STATE_SET = new Set<string>(CONTENT_JOB_STATES);
const JOB_KIND_SET = new Set<string>(CONTENT_JOB_KINDS);

/** Strict validation of a job view (the builder is the backend's registry). */
export function validateContentJobView(value: unknown): value is ContentJobView {
  if (!isPlainObject(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.jobId !== 'string' || !/^job-[0-9a-f]{32}$/.test(v.jobId)) return false;
  if (typeof v.projectId !== 'string' || !isProjectId(v.projectId)) return false;
  if (typeof v.kind !== 'string' || !JOB_KIND_SET.has(v.kind)) return false;
  if (typeof v.state !== 'string' || !JOB_STATE_SET.has(v.state)) return false;
  if (typeof v.createdAt !== 'string' || typeof v.expiresAt !== 'string') return false;
  if (v.result !== undefined && !isPlainObject(v.result)) return false;
  if (v.error !== undefined) {
    if (!isPlainObject(v.error) || typeof (v.error as Record<string, unknown>).code !== 'string') return false;
  }
  return true;
}

// ---- full-state/change binary exclusion (sessions.md §11.6/§17.6) -------------

/**
 * True when a value embeds raw binary (a typed array / ArrayBuffer) anywhere.
 * The WS full-state frame and `mutation.applied` must never carry GLB or
 * compiled-behavior bytes (sessions.md §11.6; delivery.md §10.1 N18).
 */
export function containsBinaryValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (value === null || value === undefined) return false;
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) return value.some((v) => containsBinaryValue(v, depth + 1));
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (containsBinaryValue(v, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Assert a full-state/change payload is binary-free and within `maxBytes`
 * when serialized. Returns the serialized text (the exact bytes that would be
 * sent) or `null` when the payload must not be sent.
 */
export function encodeBinaryFreeStateFrame(value: unknown, maxBytes: number): string | null {
  if (containsBinaryValue(value)) return null;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  // UTF-8 byte length without Buffer (protocol is Node-builtin-free).
  if (new TextEncoder().encode(text).length > maxBytes) return null;
  return text;
}
