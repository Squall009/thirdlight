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
/**
 * Phase 25.15: the most steps one relay covers (the last frame's
 * `stepOffset + steps`): 60 s at the default 120 Hz step, 2 minutes at 60 Hz.
 * The backend waits for the relay by this span.
 */
export const INPUT_RELAY_MAX_STEPS = 7_200;
/** Phase 25.15: the UI edges a relay frame may carry (the keys and pad buttons that drive menus). */
export const RELAY_UI_EDGES = ['up', 'down', 'left', 'right', 'submit', 'cancel', 'pause'] as const;
export type RelayUiEdge = (typeof RELAY_UI_EDGES)[number];
/** Phase 25.15: UI edges in one frame. */
export const RELAY_MAX_UI_EDGES = 8;
/** Phase 25.15: the standard gamepad layout's button and axis counts. */
export const RELAY_GAMEPAD_BUTTONS = 17;
export const RELAY_GAMEPAD_AXES = 4;
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
  /** Phase 25.9: one shared script library module (`libraries/<outputDigest>.js`), imported by behaviors. */
  | { kind: 'library'; contentId: string; outputDigest: string }
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
  if (parts.length === 4 && parts[2] === 'libraries') {
    const file = parts[3] as string;
    if (!file.endsWith('.js')) return { kind: 'invalid' };
    const digest = file.slice(0, -3);
    if (!DIGEST_RE.test(digest)) return { kind: 'invalid' };
    return { kind: 'library', contentId, outputDigest: digest };
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
/** Phase 24.8: frame version 2 — named actions and the pointer (no fixed moveX/moveY/jump channels). */
export interface RelayFrame {
  stepOffset: number;
  /**
   * Phase 25.15: run length — the frame holds for this many steps (absent: 1).
   * Its first step has it as written; the rest see its continuation (a
   * `pressed` action is `held`, `released` is `none`; the pointer keeps its
   * place and held buttons without the movement, wheel and edges; the UI
   * edges only on the first step). Steps no frame covers are neutral.
   */
  steps?: number;
  /** Phase 25.15: a virtual standard-mapped gamepad (absent: the pad at rest). */
  gamepad?: RelayGamepad;
  /** Phase 25.15: UI edges on the frame's first step (drive the focused document, the pause, the shell's screens). */
  ui?: RelayUiEdge[];
  /** Phase 9.8: named input actions this step (`{ v, x?, y?, p }` each; the character reads `move` and `jump` by default). */
  actions?: Record<string, { v: number; x?: number; y?: number; p: RelayJumpPhase }>;
  /** Phase 23.3: the pointer this step (a frame without one keeps the last position and buttons). */
  pointer?: RelayPointer;
}

/**
 * Phase 23.3: a relay frame's pointer sample — x, y in [0, 1] of the view
 * (0,0 top left), dx/dy/wheel in [-10, 10], button masks 0–7 (1 left,
 * 2 right, 4 middle), over/locked booleans.
 */
export interface RelayPointer {
  x: number;
  y: number;
  dx?: number;
  dy?: number;
  wheel?: number;
  buttons?: number;
  pressed?: number;
  released?: number;
  over?: boolean;
  locked?: boolean;
}

/**
 * Phase 25.15: a virtual gamepad in the standard layout — `buttons` values
 * 0–1 by standard index (0 A/cross, 1 B/circle, 9 start, 12–15 the D-pad; a
 * button is down at 0.5 or more), `axes` −1..1 (0/1 the left stick, 2/3 the
 * right; y down). Missing entries are at rest.
 */
export interface RelayGamepad {
  buttons?: number[];
  axes?: number[];
}

/** Phase 25.15: parse a relay gamepad (null when malformed); values quantized to 1e-4. */
export function parseRelayGamepad(value: unknown): RelayGamepad | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'buttons' && k !== 'axes')) return null;
  const list = (raw: unknown, max: number, lo: number): number[] | null | undefined => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length > max) return null;
    const out: number[] = [];
    for (const n of raw) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > 1) return null;
      const r = Math.round(n * 1e4) / 1e4;
      out.push(r === 0 ? 0 : r);
    }
    return out;
  };
  const buttons = list(v['buttons'], RELAY_GAMEPAD_BUTTONS, 0);
  const axes = list(v['axes'], RELAY_GAMEPAD_AXES, -1);
  if (buttons === null || axes === null) return null;
  return { ...(buttons !== undefined ? { buttons } : {}), ...(axes !== undefined ? { axes } : {}) };
}

/** Phase 25.15: parse a relay frame's UI edges (null when malformed). */
export function parseRelayUiEdges(value: unknown): RelayUiEdge[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > RELAY_MAX_UI_EDGES) return null;
  for (const e of value) if (typeof e !== 'string' || !(RELAY_UI_EDGES as readonly string[]).includes(e)) return null;
  return [...(value as RelayUiEdge[])];
}

/**
 * Phase 25.15: check a relay frame's `steps` against the frame before it:
 * an integer 1..INPUT_RELAY_MAX_STEPS, the frame starting at or after the
 * previous frame's end, and the whole relay ending by INPUT_RELAY_MAX_STEPS.
 * Returns the frame's end (exclusive) or a reason.
 */
export function relayFrameEnd(stepOffset: number, steps: unknown, previousEnd: number): { ok: true; end: number } | { ok: false; reason: string } {
  if (steps !== undefined && (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1 || steps > INPUT_RELAY_MAX_STEPS)) {
    return { ok: false, reason: `steps must be an integer 1–${INPUT_RELAY_MAX_STEPS}` };
  }
  if (stepOffset < previousEnd) return { ok: false, reason: `frames must not overlap: this frame starts at step ${stepOffset}, inside the run before it (which ends at ${previousEnd})` };
  const end = stepOffset + ((steps as number | undefined) ?? 1);
  if (end > INPUT_RELAY_MAX_STEPS) return { ok: false, reason: `a relay covers at most ${INPUT_RELAY_MAX_STEPS} steps (stepOffset + steps of the last frame)` };
  return { ok: true, end };
}

const RELAY_POINTER_KEYS = ['x', 'y', 'dx', 'dy', 'wheel', 'buttons', 'pressed', 'released', 'over', 'locked'];

/** Phase 23.3: parse one relay pointer sample (null when it is malformed); x, y, dx, dy and wheel are quantized to 1e-4. */
export function parseRelayPointer(value: unknown): RelayPointer | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !RELAY_POINTER_KEYS.includes(k))) return null;
  const unit = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  const amount = (n: unknown): boolean => n === undefined || (typeof n === 'number' && Number.isFinite(n) && n >= -10 && n <= 10);
  const mask = (n: unknown): boolean => n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 7);
  const flag = (n: unknown): boolean => n === undefined || typeof n === 'boolean';
  if (!unit(v['x']) || !unit(v['y']) || !amount(v['dx']) || !amount(v['dy']) || !amount(v['wheel']) || !mask(v['buttons']) || !mask(v['pressed']) || !mask(v['released']) || !flag(v['over']) || !flag(v['locked'])) return null;
  const q = (n: number): number => {
    const r = Math.round(n * 1e4) / 1e4;
    return r === 0 ? 0 : r;
  };
  const out: RelayPointer = { x: q(v['x'] as number), y: q(v['y'] as number) };
  for (const k of ['dx', 'dy', 'wheel'] as const) if (v[k] !== undefined && q(v[k] as number) !== 0) out[k] = q(v[k] as number);
  for (const k of ['buttons', 'pressed', 'released'] as const) if (v[k] !== undefined && v[k] !== 0) out[k] = v[k] as number;
  for (const k of ['over', 'locked'] as const) if (v[k] !== undefined) out[k] = v[k] as boolean;
  return out;
}
export interface InputRelayRequest {
  mode: 'exclusive-test';
  frames: readonly RelayFrame[];
  /** Phase 25.16: restart the game first (the replay); the frames begin at the new run's first step. */
  restart?: boolean;
}

const RELAY_FRAME_FIELDS = new Map<string, string>([
  ['stepOffset', 'integer 0..2^53-1'],
  ['actions', 'optional: { <action name>: { v, x?, y?, p } } (phase 9.8 named actions)'],
  ['pointer', 'optional: { x, y (0-1 of the view), dx?, dy?, wheel?, buttons?, pressed?, released? (masks: 1 left, 2 right, 4 middle), over?, locked? } (phase 23.3)'],
  ['steps', `optional: integer 1–${INPUT_RELAY_MAX_STEPS}, the frame holds for this many steps (phase 25.15)`],
  ['gamepad', 'optional: { buttons?: [0-1 ×≤17], axes?: [-1..1 ×≤4] } a virtual standard gamepad (phase 25.15)'],
  ['ui', 'optional: 1-8 of up | down | left | right | submit | cancel | pause (phase 25.15)'],
]);
const RELAY_BODY_FIELDS = new Map<string, string>([
  ['mode', '"exclusive-test"'],
  ['frames', '1–600 ascending step-indexed frames'],
  ['restart', 'optional boolean: restart the game first; the frames begin at the new run\'s first step (phase 25.16)'],
]);
const JUMP_SET: readonly string[] = ['none', 'pressed', 'held', 'released'];
const MAX_STEP_OFFSET = 2 ** 53 - 1;

/**
 * Strict parse of one relay body. Applies the §18.1.1 bounds: exactly the
 * accepted mode, 1–600 frames, strictly ascending `stepOffset` with no
 * duplicates, named actions and the pointer only (phase 24.8: frame version
 * 2 — no moveX/moveY/jump), and a body ≤ 16 384 bytes.
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
  let previousEnd = 0;
  for (let i = 0; i < framesRaw.length; i += 1) {
    const entry = framesRaw[i];
    const frameShape = checkShape(entry, `/frames/${i}`, RELAY_FRAME_FIELDS, ['stepOffset']);
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
    // Phase 25.15: run length, no overlap, the relay's span bounded.
    const rawSteps = (frameShape.value as Record<string, unknown>)['steps'];
    const span = relayFrameEnd(stepOffset, rawSteps, previousEnd);
    if (!span.ok) {
      return {
        ok: false,
        error: span.reason.startsWith('a relay covers')
          ? { code: 'input_relay_limits_exceeded', cls: 'validation', message: span.reason, path: `/frames/${i}`, limit: 'steps', current: stepOffset + (typeof rawSteps === 'number' ? rawSteps : 1), max: INPUT_RELAY_MAX_STEPS }
          : { code: 'field_value', cls: 'validation', message: span.reason, path: `/frames/${i}/${span.reason.startsWith('steps') ? 'steps' : 'stepOffset'}` },
      };
    }
    previousEnd = span.end;
    const rawGamepad = (frameShape.value as Record<string, unknown>)['gamepad'];
    let gamepad: RelayGamepad | undefined;
    if (rawGamepad !== undefined) {
      const g = parseRelayGamepad(rawGamepad);
      if (g === null) return { ok: false, error: { code: 'field_value', cls: 'validation', message: `gamepad is { buttons?: up to ${RELAY_GAMEPAD_BUTTONS} numbers 0-1 (standard layout), axes?: up to ${RELAY_GAMEPAD_AXES} numbers -1..1 }`, path: `/frames/${i}/gamepad` } };
      gamepad = g;
    }
    const rawUi = (frameShape.value as Record<string, unknown>)['ui'];
    let ui: RelayUiEdge[] | undefined;
    if (rawUi !== undefined) {
      const u = parseRelayUiEdges(rawUi);
      if (u === null) return { ok: false, error: { code: 'field_value', cls: 'validation', message: `ui is 1-${RELAY_MAX_UI_EDGES} of ${RELAY_UI_EDGES.join(' | ')}`, path: `/frames/${i}/ui` } };
      ui = u;
    }
    const rawActions = (frameShape.value as Record<string, unknown>)['actions'];
    let actions: RelayFrame['actions'];
    if (rawActions !== undefined) {
      const bad = {
        ok: false as const,
        error: { code: 'field_value' as const, cls: 'validation' as const, message: 'actions maps up to 64 action names to { v, x?, y? (numbers in [-10, 10]), p: none | pressed | held | released }', path: `/frames/${i}/actions` },
      };
      if (typeof rawActions !== 'object' || rawActions === null || Array.isArray(rawActions) || Object.keys(rawActions).length > 64) return bad; // phase 23.14: project-model MAX_INPUT_ACTIONS
      actions = {};
      for (const [name, a] of Object.entries(rawActions as Record<string, unknown>)) {
        const v = a as Record<string, unknown> | null;
        const num = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x >= -10 && x <= 10;
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name) || typeof v !== 'object' || v === null || !num(v['v']) || typeof v['p'] !== 'string' || !JUMP_SET.includes(v['p'] as string)) return bad;
        if ((v['x'] !== undefined && !num(v['x'])) || (v['y'] !== undefined && !num(v['y'])) || Object.keys(v).some((k) => !['v', 'x', 'y', 'p'].includes(k))) return bad;
        actions[name] = { v: v['v'] as number, ...(v['x'] !== undefined ? { x: v['x'] as number } : {}), ...(v['y'] !== undefined ? { y: v['y'] as number } : {}), p: v['p'] as RelayJumpPhase };
      }
    }
    const rawPointer = (frameShape.value as Record<string, unknown>)['pointer'];
    let pointer: RelayPointer | undefined;
    if (rawPointer !== undefined) {
      const parsed = parseRelayPointer(rawPointer);
      if (parsed === null) {
        return {
          ok: false,
          error: { code: 'field_value', cls: 'validation', message: 'pointer is { x, y (numbers in [0, 1]), dx?, dy?, wheel? (in [-10, 10]), buttons?, pressed?, released? (masks 0-7: 1 left, 2 right, 4 middle), over?, locked? (booleans) }', path: `/frames/${i}/pointer` },
        };
      }
      pointer = parsed;
    }
    frames.push({
      stepOffset,
      ...(typeof rawSteps === 'number' && rawSteps !== 1 ? { steps: rawSteps } : {}),
      ...(actions !== undefined ? { actions } : {}),
      ...(pointer !== undefined ? { pointer } : {}),
      ...(gamepad !== undefined ? { gamepad } : {}),
      ...(ui !== undefined ? { ui } : {}),
    });
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
  const restart = (shape.value as Record<string, unknown>)['restart'];
  if (restart !== undefined && typeof restart !== 'boolean') {
    return { ok: false, error: { code: 'field_type', cls: 'validation', message: 'restart must be true or false', path: '/restart', found: typeof restart, expected: 'boolean' } };
  }
  return { ok: true, request: { mode: INPUT_RELAY_MODE, frames, ...(restart === true ? { restart: true } : {}) } };
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
