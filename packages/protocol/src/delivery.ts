/**
 * M2 delivery wire shapes — sessions.md §11.3/§11.5/§17/§18 (immutable
 * play-content locator, runtime-content manifest identity, bounded
 * input-exercise relay) and delivery.md §2/§4/§6/§8.
 *
 * Pure: strict validators and constants only — no I/O, no crypto, no Node
 * built-ins. The digest algorithms live in the host (backend/tests); this
 * module owns the exact *bytes* a digest covers (`manifestBuildIdInput`) and
 * the exact request shapes.
 *
 * Contract-change requests recorded by packet 35 (docs/handoffs/35.md):
 *  - the backend↔editor WS input-relay event names (`input.request` /
 *    `input.result`) are not in the sessions.md §7 catalog;
 *  - sessions.md §10.1/§17.2 name the locator `path` as `/play-content/<id>/`
 *    while §17.2.1/§17.4 name `GET /play/:playSessionId` as the shell and
 *    reject the bare content path — both shell routes are served.
 */
import { checkField, checkShape } from './strict';
import { isContentId, isPlaySessionId, isRequestId } from './ids';
import type { SessionError } from './errors';

// ---- constants (sessions.md §11.5, delivery.md §11) ---------------------------

/** Absolute locator lifetime from play start; never extended by reads. */
export const PLAY_CONTENT_TTL_SECONDS = 900;
/** In-flight-read grace after a terminal play state. */
export const PLAY_CONTENT_GRACE_SECONDS = 60;
/** 32 CSPRNG bytes ⇒ 43 base64url characters. */
export const PLAY_CONTENT_ID_BYTES = 32;
/** The manifest document cap (sessions.md §11.5). */
export const PLAY_CONTENT_MANIFEST_MAX_BYTES = 262_144;
/** The whole artifact-set cap (§17.3). */
export const PLAY_CONTENT_SET_MAX_BYTES = 536_870_912;
/** The single-artifact cap (§17.3). */
export const PLAY_CONTENT_ARTIFACT_MAX_BYTES = 33_554_432;
/** The bounded relay frame count (§18.1.1). */
export const INPUT_RELAY_MAX_FRAMES = 600;
/** The bounded relay body size (§18.1.1). */
export const INPUT_RELAY_MAX_BODY_BYTES = 16_384;
/** The `tl.input.result` ack timeout (§18.1.2). */
export const INPUT_RELAY_ACK_TIMEOUT_MS = 10_000;
/** The v2 bridge message cap (§17.6). */
export const BRIDGE_MESSAGE_MAX_BYTES = 65_536;
/** The `tl.load.progress` cap (§17.6). */
export const BRIDGE_LOAD_PROGRESS_MAX_BYTES = 1_024;
/** session.md §11.5: the input relay body bound restated for the WS ack. */
export const INPUT_RELAY_RESULT_MAX_BYTES = 4_096;

/** The one accepted relay mode (§18.1.1). */
export const INPUT_RELAY_MODE = 'exclusive-test' as const;

/** The manifest discriminator (§17.1.1). */
export const RUNTIME_CONTENT_TYPE = 'thirdlight-runtime-content' as const;
export const RUNTIME_CONTENT_MANIFEST_VERSION = 1 as const;

/** The exact canonical option-set record (delivery.md §4.2). */
export const BUILD_OPTIONS_RECORD = Object.freeze({
  bundler: 'esbuild@0.28.2',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
  target: 'es2022',
  loaders: ['ts', 'tsx'],
});

/** `JSON.stringify(record, null, 2) + "\n"` — the bytes `buildOptionsDigest` covers. */
export function buildOptionsRecordBytes(): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(BUILD_OPTIONS_RECORD, null, 2)}\n`);
}

// ---- runtime-content manifest identity (§17.1.1) ------------------------------

/** The manifest keys in their exact canonical order (`buildId` last). */
export const MANIFEST_KEYS = [
  'manifestVersion',
  'type',
  'projectId',
  'revision',
  'snapshotId',
  'capturedAt',
  'sceneDigest',
  'contentDigest',
  'assets',
  'behaviors',
  'modules',
  'enginePins',
  'recipes',
  'toolchain',
  'buildOptionsDigest',
  'buildId',
] as const;

/**
 * The exact bytes `buildId` covers: the canonical document serialization of the
 * manifest without `buildId`, key order exactly as §17.1.1 writes it,
 * `JSON.stringify(…, null, 2) + "\n"`. Returns `null` when a key is missing.
 */
export function manifestBuildIdInput(manifest: Record<string, unknown>): Uint8Array | null {
  const without: Record<string, unknown> = {};
  for (const key of MANIFEST_KEYS) {
    if (key === 'buildId') continue;
    if (!(key in manifest)) return null;
    without[key] = manifest[key];
  }
  return new TextEncoder().encode(`${JSON.stringify(without, null, 2)}\n`);
}

/** Rebuild a parsed manifest in the canonical key order (unknown keys rejected). */
export function orderManifest(manifest: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of Object.keys(manifest)) {
    if (!(MANIFEST_KEYS as readonly string[]).includes(key)) return null;
  }
  const ordered: Record<string, unknown> = {};
  for (const key of MANIFEST_KEYS) {
    if (key in manifest) ordered[key] = manifest[key];
  }
  return ordered;
}

// ---- the locator path set (§17.2.1) -------------------------------------------

/** One classified locator path (relative to the preview origin). */
export type LocatorPath =
  | { kind: 'shell'; contentId: string }
  | { kind: 'manifest'; contentId: string }
  | { kind: 'game'; contentId: string }
  | { kind: 'asset'; contentId: string; assetId: string; version: number }
  | { kind: 'asset-digest'; contentId: string; digest: string }
  | { kind: 'behavior'; contentId: string; outputDigest: string }
  /** Phase 12 (c): one scene of a v4 build (`scenes/<sceneId>.json`). */
  | { kind: 'scene'; contentId: string; sceneId: string }
  | { kind: 'invalid' };

const DIGEST_RE = /^[0-9a-f]{64}$/;
const ASSET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Classify one URL path against the exact §17.2.1 route set. Anything else
 * (listings, traversal, undeclared paths, other `contentId`s) is `invalid` ⇒
 * `path_rejected` — never a filesystem fallback.
 */
export function classifyLocatorPath(pathname: string): LocatorPath {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  if (parts.length < 2 || parts[0] !== 'play-content') return { kind: 'invalid' };
  const contentId = parts[1] as string;
  if (!isContentId(contentId)) return { kind: 'invalid' };
  if (parts.length === 2) return { kind: 'shell', contentId };
  if (parts.length === 3 && parts[2] === 'manifest.json') return { kind: 'manifest', contentId };
  if (parts.length === 3 && parts[2] === 'game.js') return { kind: 'game', contentId };
  if (parts.length === 5 && parts[2] === 'content' && parts[3] === 'sha256') {
    const digest = parts[4] as string;
    if (!DIGEST_RE.test(digest)) return { kind: 'invalid' };
    return { kind: 'asset-digest', contentId, digest };
  }
  if (parts.length === 5 && parts[2] === 'content') {
    const assetId = parts[3] as string;
    const versionRaw = parts[4] as string;
    if (!ASSET_ID_RE.test(assetId) || !/^[0-9]+$/.test(versionRaw)) return { kind: 'invalid' };
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1) return { kind: 'invalid' };
    return { kind: 'asset', contentId, assetId, version };
  }
  if (parts.length === 4 && parts[2] === 'content' && parts[3] === 'sha256') {
    return { kind: 'invalid' };
  }
  if (parts.length === 4 && parts[2] === 'scenes') {
    const file = parts[3] as string;
    if (!file.endsWith('.json')) return { kind: 'invalid' };
    const sceneId = file.slice(0, -5);
    if (!ASSET_ID_RE.test(sceneId)) return { kind: 'invalid' };
    return { kind: 'scene', contentId, sceneId };
  }
  if (parts.length === 4 && parts[2] === 'behaviors') {
    const outputDigest = parts[3] as string;
    if (!outputDigest.endsWith('.js')) return { kind: 'invalid' };
    const digest = outputDigest.slice(0, -3);
    if (!DIGEST_RE.test(digest)) return { kind: 'invalid' };
    return { kind: 'behavior', contentId, outputDigest: digest };
  }
  return { kind: 'invalid' };
}

/** Replace one locator value with the normative redaction token (§17.4). */
export function redactContentId(text: string, contentId: string | undefined): string {
  if (contentId === undefined || contentId.length === 0) return text;
  return text.split(contentId).join('<redacted:contentId>');
}

// ---- bounded input-exercise relay (§18.1) -------------------------------------

export type RelayJumpPhase = 'none' | 'pressed' | 'held' | 'released';
export interface RelayFrame {
  stepOffset: number;
  moveX: number;
  jump: RelayJumpPhase;
  /** Phase 9.8: named input actions this step (`{ v, x?, y?, p }` each). */
  actions?: Record<string, { v: number; x?: number; y?: number; p: RelayJumpPhase }>;
}
export interface InputRelayRequest {
  mode: 'exclusive-test';
  frames: readonly RelayFrame[];
}

const RELAY_FRAME_FIELDS = new Map<string, string>([
  ['stepOffset', 'integer 0..2^53-1'],
  ['moveX', 'finite number -1..1 (quantized to 1e-4)'],
  ['jump', 'none | pressed | held | released'],
  ['actions', 'optional: { <action name>: { v, x?, y?, p } } (phase 9.8 named actions)'],
]);
const RELAY_BODY_FIELDS = new Map<string, string>([
  ['mode', '"exclusive-test"'],
  ['frames', '1–600 ascending step-indexed frames'],
]);
const JUMP_SET: readonly string[] = ['none', 'pressed', 'held', 'released'];
const MOVE_QUANTUM = 1e-4;
const MAX_STEP_OFFSET = 2 ** 53 - 1;

function quantize(v: number): number {
  return Math.round(v / MOVE_QUANTUM) * MOVE_QUANTUM;
}

/**
 * Strict parse of one relay body. Applies the §18.1.1 bounds: exactly the
 * accepted mode, 1–600 frames, strictly ascending `stepOffset` with no
 * duplicates, `moveX` finite in [−1,1] quantized like the recorded source, and
 * a body ≤ 16 384 bytes.
 */
export function parseInputRelayRequest(
  value: unknown,
): { ok: true; request: InputRelayRequest } | { ok: false; error: SessionError } {
  const shape = checkShape(value, '', RELAY_BODY_FIELDS, ['mode', 'frames']);
  if (!shape.ok) return { ok: false, error: shape.error };
  const modeField = checkField(shape.value, 'mode', '', '"exclusive-test"', (v) =>
    v === INPUT_RELAY_MODE ? null : { problem: `mode must be exactly "${INPUT_RELAY_MODE}"`, kind: 'value' },
  );
  if (!modeField.ok) return { ok: false, error: modeField.error };
  const framesRaw = shape.value.frames;
  if (!Array.isArray(framesRaw)) {
    return {
      ok: false,
      error: { code: 'field_type', cls: 'validation', message: 'frames must be an array', path: '/frames', found: typeof framesRaw, expected: 'array of 1–600 frames' },
    };
  }
  if (framesRaw.length < 1 || framesRaw.length > INPUT_RELAY_MAX_FRAMES) {
    return {
      ok: false,
      error: {
        code: 'input_relay_limits_exceeded',
        cls: 'validation',
        message: `frames must contain 1–${INPUT_RELAY_MAX_FRAMES} entries (found ${framesRaw.length})`,
        path: '/frames',
        limit: 'frames',
        current: framesRaw.length,
        max: INPUT_RELAY_MAX_FRAMES,
      },
    };
  }
  const frames: RelayFrame[] = [];
  let previous = -1;
  for (let i = 0; i < framesRaw.length; i += 1) {
    const entry = framesRaw[i];
    const frameShape = checkShape(entry, `/frames/${i}`, RELAY_FRAME_FIELDS, ['stepOffset', 'moveX', 'jump']);
    if (!frameShape.ok) return { ok: false, error: frameShape.error };
    const offset = checkField(frameShape.value, 'stepOffset', `/frames/${i}`, 'integer 0..2^53-1', (v) =>
      typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_STEP_OFFSET
        ? null
        : { problem: 'stepOffset must be an integer ≥ 0', kind: 'value' },
    );
    if (!offset.ok) return { ok: false, error: offset.error };
    const stepOffset = offset.value as number;
    if (stepOffset <= previous) {
      return {
        ok: false,
        error: {
          code: 'field_value',
          cls: 'validation',
          message: 'frames must be strictly ascending by stepOffset with no duplicates',
          path: `/frames/${i}/stepOffset`,
          found: String(stepOffset),
          expected: `> ${previous}`,
        },
      };
    }
    previous = stepOffset;
    const moveX = checkField(frameShape.value, 'moveX', `/frames/${i}`, 'finite number -1..1', (v) =>
      typeof v === 'number' && Number.isFinite(v) && v >= -1 && v <= 1
        ? null
        : { problem: 'moveX must be a finite number in [-1, 1]', kind: 'value' },
    );
    if (!moveX.ok) return { ok: false, error: moveX.error };
    const jump = checkField(frameShape.value, 'jump', `/frames/${i}`, 'none | pressed | held | released', (v) =>
      typeof v === 'string' && JUMP_SET.includes(v) ? null : { problem: 'jump must be one of none | pressed | held | released', kind: 'value' },
    );
    if (!jump.ok) return { ok: false, error: jump.error };
    const rawActions = (frameShape.value as Record<string, unknown>)['actions'];
    let actions: RelayFrame['actions'];
    if (rawActions !== undefined) {
      const bad = {
        ok: false as const,
        error: { code: 'field_value' as const, cls: 'validation' as const, message: 'actions maps up to 32 action names to { v, x?, y? (numbers in [-10, 10]), p: none | pressed | held | released }', path: `/frames/${i}/actions` },
      };
      if (typeof rawActions !== 'object' || rawActions === null || Array.isArray(rawActions) || Object.keys(rawActions).length > 32) return bad;
      actions = {};
      for (const [name, a] of Object.entries(rawActions as Record<string, unknown>)) {
        const v = a as Record<string, unknown> | null;
        const num = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= -10 && x <= 10;
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name) || typeof v !== 'object' || v === null || !num(v['v']) || typeof v['p'] !== 'string' || !JUMP_SET.includes(v['p'] as string)) return bad;
        if ((v['x'] !== undefined && !num(v['x'])) || (v['y'] !== undefined && !num(v['y'])) || Object.keys(v).some((k) => !['v', 'x', 'y', 'p'].includes(k))) return bad;
        actions[name] = { v: v['v'] as number, ...(v['x'] !== undefined ? { x: v['x'] as number } : {}), ...(v['y'] !== undefined ? { y: v['y'] as number } : {}), p: v['p'] as RelayJumpPhase };
      }
    }
    frames.push({ stepOffset, moveX: quantize(moveX.value as number), jump: jump.value as RelayJumpPhase, ...(actions !== undefined ? { actions } : {}) });
  }
  const bodyBytes = new TextEncoder().encode(JSON.stringify({ mode: INPUT_RELAY_MODE, frames })).length;
  if (bodyBytes > INPUT_RELAY_MAX_BODY_BYTES) {
    return {
      ok: false,
      error: {
        code: 'input_relay_limits_exceeded',
        cls: 'validation',
        message: `the relay body exceeds the ${INPUT_RELAY_MAX_BODY_BYTES}-byte bound`,
        limit: 'body_bytes',
        current: bodyBytes,
        max: INPUT_RELAY_MAX_BODY_BYTES,
      },
    };
  }
  return { ok: true, request: { mode: INPUT_RELAY_MODE, frames } };
}

/** The §18.1.2 result shape (built by the backend). */
export interface InputRelayResultDoc {
  ok: true;
  mode: 'exclusive-test';
  playSessionId: string;
  snapshotId: string;
  buildId: string;
  appliedFromStep: number;
  appliedToStep: number;
  inputMode: 'test';
  clearedAt: string;
}

// ---- the `tl.input.result` bridge/payload ack (§17.6/§18.1.2) ------------------

/**
 * Validate one preview → editor `tl.input.result` payload (the backend relays
 * it as the WS `input.result` event). Bounded: `appliedFromStep`/`appliedToStep`
 * are integers and the pair is ordered.
 */
export function validateInputRelayResult(value: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'must be an object' };
  const m = value as Record<string, unknown>;
  if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex' };
  if (!isRequestId(m['requestId'])) return { ok: false, reason: 'requestId must be req- + 32 hex' };
  if (typeof m['ok'] !== 'boolean') return { ok: false, reason: 'ok must be a boolean' };
  if (m['ok'] === true) {
    const from = m['appliedFromStep'];
    const to = m['appliedToStep'];
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) return { ok: false, reason: 'appliedFromStep must be an integer ≥ 0' };
    if (typeof to !== 'number' || !Number.isInteger(to) || to < from) return { ok: false, reason: 'appliedToStep must be an integer ≥ appliedFromStep' };
  } else {
    const error = m['error'];
    if (typeof error !== 'object' || error === null || Array.isArray(error)) return { ok: false, reason: 'error is required when ok is false' };
    const code = (error as Record<string, unknown>)['code'];
    if (typeof code !== 'string' || code.length < 1 || code.length > 128) return { ok: false, reason: 'error.code must be a 1–128 char string' };
  }
  return { ok: true };
}
