/**
 * Bridge message allowlist + strict validators.
 *
 * All messages are strict JSON with `v: 2` (the bridge protocol version); a
 * `v: 1` message is rejected exactly like an unknown field. Unknown fields are
 * rejected; anything outside the allowlist is dropped by the transport (the
 * editor/preview) — these validators are the single home of the strict shapes.
 *
 * The validators take the PARSED message value plus the transport
 * discriminators the caller supplies (origin/source checks are the transport's
 * job — they cannot be verified from the message body). Pure: no I/O.
 */
import { ID_RE } from '@thirdlight/project-model/limits';
import { isContentId, isNonce, isPlaySessionId, isRelayId, isRequestId } from './ids';
import {
  BRIDGE_LOAD_PROGRESS_MAX_BYTES,
  BRIDGE_MESSAGE_MAX_BYTES,
  INPUT_RELAY_MAX_BODY_BYTES,
  INPUT_RELAY_MAX_FRAMES,
  parseRelayGamepad,
  parseRelayPointer,
  parseRelayUiEdges,
  relayFrameEnd,
  validateInputRelayResult,
} from './delivery';
import { SCREENSHOT_DATA_URL_MAX, SCREENSHOT_MAX_WIDTH_MAX, SCREENSHOT_MAX_WIDTH_MIN } from './http';
import { PLAY_DIAGNOSTICS_MAX_BYTES } from './diagnostics-bound';
import { playProblemProblem } from './play-problems';
import { debugCommandCallProblem, RELAY_ANSWER_WITHIN_MAX_MS } from './m3';

/** The exhaustive allowlists (v2). */
export const BRIDGE_EDITOR_TO_PREVIEW_TYPES = [
  'tl.handshake',
  'tl.snapshot',
  'tl.playContent.expect',
  'tl.input.request',
  'tl.play.stop',
  'tl.screenshot.request',
  'tl.diagnostics.request',
  'tl.game.control',
  'tl.game.observe',
  'tl.debug.request',
  'tl.ping',
] as const;
export type BridgeEditorToPreviewType = (typeof BRIDGE_EDITOR_TO_PREVIEW_TYPES)[number];

export const BRIDGE_PREVIEW_TO_EDITOR_TYPES = [
  'tl.handshake.ack',
  'tl.ready',
  'tl.load.progress',
  'tl.input.result',
  'tl.stopped',
  'tl.screenshot.result',
  'tl.diagnostics.result',
  'tl.game.control.result',
  'tl.game.observe.result',
  'tl.debug.result',
  'tl.error',
  // A problem the running game reports for its author (once per kind).
  'tl.play.problem',
  'tl.pong',
] as const;
export type BridgePreviewToEditorType = (typeof BRIDGE_PREVIEW_TO_EDITOR_TYPES)[number];

/** The bridge protocol version (all bridge messages carry `v: 2`). */
export const BRIDGE_VERSION = 2;

/** The general v2 message cap and the `tl.load.progress` cap (the delivery contract's). */
export { BRIDGE_LOAD_PROGRESS_MAX_BYTES, BRIDGE_MESSAGE_MAX_BYTES };
/** `tl.input.request` frames/bytes cap: an input request carries one relay. */
export const BRIDGE_INPUT_MAX_FRAMES = INPUT_RELAY_MAX_FRAMES;
export const BRIDGE_INPUT_MAX_BYTES = INPUT_RELAY_MAX_BODY_BYTES;
/** Breakpoints in one `tl.debug.request` (node ids as the debugger names them, `fn:<id>/<node>` inside a function). */
export const BRIDGE_DEBUG_MAX_BREAKPOINTS = 64;
/** The `tl.debug.result` body bound. */
export const BRIDGE_DEBUG_RESULT_MAX_BYTES = 32_768;
/** What a debug request may ask of the running play besides reading. */
export const BRIDGE_DEBUG_COMMANDS = ['pause', 'resume', 'step'] as const;
/** Game-control commands (play controls plus the debugger's pause / resume / step). */
const GAME_CONTROL = ['replay', 'mute', 'unmute', 'loadScene', 'unloadScene', 'clearSave', 'debugPause', 'debugResume', 'debugStep', 'debugCommand'];
const ENTITY_ID_RE = ID_RE;
/** A debugger node id: a graph item id, optionally scoped (`fn:<functionId>/` or `lib:<graphId>/`). */
const DEBUG_NODE_RE = /^(?:(?:fn|lib):[A-Za-z0-9_-]{1,64}\/)?[A-Za-z0-9_-]{1,64}$/;

type Verdict = { ok: true } | { ok: false; reason: string; path?: string };

function str(v: unknown, min = 1, max = 256): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

/** The optional wait a relay request asks its answer within, or why it is refused. */
function answerWithinProblem(v: unknown): Verdict | null {
  if (v === undefined || int(v, 0, RELAY_ANSWER_WITHIN_MAX_MS)) return null;
  return { ok: false, reason: `answerWithinMs must be an integer of 0..${RELAY_ANSWER_WITHIN_MAX_MS}`, path: '/answerWithinMs' };
}

function int(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isDigest(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rejectUnknown(m: Record<string, unknown>, allowed: readonly string[]): { reason: string; path: string } | null {
  for (const k of Object.keys(m)) {
    if (!allowed.includes(k)) return { reason: `unknown field "${k}"`, path: `/${k}` };
  }
  return null;
}

function tooLarge(m: Record<string, unknown>, max: number): { reason: string } | null {
  if (JSON.stringify(m).length > max) return { reason: `message exceeds the ${max}-byte bound` };
  return null;
}

/** `phase ∈ {shell, manifest, assets, behaviors, runtime}`. */
export const LOAD_PHASES = ['shell', 'manifest', 'assets', 'behaviors', 'runtime'] as const;
export type LoadPhase = (typeof LOAD_PHASES)[number];

/**
 * Validate one EDITOR → PREVIEW message (v2).
 * `type` is the discriminator field of the message body.
 */
export function validateBridgeEditorToPreview(value: unknown): Verdict {
  if (!isPlainObject(value)) return { ok: false, reason: 'message must be a JSON object' };
  const m = value;
  if (m['v'] !== BRIDGE_VERSION) return { ok: false, reason: `v must be ${BRIDGE_VERSION}`, path: '/v' };
  const type = m['type'];
  if (typeof type !== 'string' || !(BRIDGE_EDITOR_TO_PREVIEW_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'type not in the editor→preview allowlist', path: '/type' };
  }
  switch (type) {
    case 'tl.handshake': {
      const bad = rejectUnknown(m, ['v', 'type', 'bridgeVersion', 'playSessionId', 'nonce', 'demo', 'contentId', 'buildId']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (m['bridgeVersion'] !== 2) return { ok: false, reason: 'bridgeVersion must be 2', path: '/bridgeVersion' };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isNonce(m['nonce'])) return { ok: false, reason: 'nonce must be 16 lowercase hex', path: '/nonce' };
      if (typeof m['demo'] !== 'boolean') return { ok: false, reason: 'demo must be a boolean', path: '/demo' };
      if (!isContentId(m['contentId'])) return { ok: false, reason: 'contentId must be 43 base64url chars', path: '/contentId' };
      if (!isDigest(m['buildId'])) return { ok: false, reason: 'buildId must be 64 lowercase hex', path: '/buildId' };
      return { ok: true };
    }
    case 'tl.snapshot': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'nonce', 'snapshot']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isNonce(m['nonce'])) return { ok: false, reason: 'nonce must be 16 lowercase hex', path: '/nonce' };
      const s = m['snapshot'];
      if (!isPlainObject(s)) return { ok: false, reason: 'snapshot must be the runtime snapshot document', path: '/snapshot' };
      for (const k of Object.keys(s)) {
        // `start` — a test/debug start the backend resolved (the preview hands it to the host).
        if (!['snapshotId', 'projectId', 'revision', 'scene', 'game', 'tags', 'start'].includes(k)) {
          return { ok: false, reason: `unknown snapshot field "${k}"`, path: `/snapshot/${k}` };
        }
      }
      if (!str(s['snapshotId'])) return { ok: false, reason: 'snapshot.snapshotId must be a string', path: '/snapshot/snapshotId' };
      if (!str(s['projectId'])) return { ok: false, reason: 'snapshot.projectId must be a string', path: '/snapshot/projectId' };
      if (!int(s['revision'], 0, 2 ** 53 - 1)) return { ok: false, reason: 'snapshot.revision must be an integer ≥ 0', path: '/snapshot/revision' };
      if (!isPlainObject(s['scene'])) return { ok: false, reason: 'snapshot.scene must be a scene document', path: '/snapshot/scene' };
      if (s['game'] !== undefined && s['game'] !== null && !isPlainObject(s['game'])) {
        return { ok: false, reason: 'snapshot.game must be the game block or null', path: '/snapshot/game' };
      }
      if (s['start'] !== undefined && !isPlainObject(s['start'])) return { ok: false, reason: 'snapshot.start must be the resolved start options', path: '/snapshot/start' };
      return { ok: true };
    }
    case 'tl.playContent.expect': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'contentId', 'buildId']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isContentId(m['contentId'])) return { ok: false, reason: 'contentId must be 43 base64url chars', path: '/contentId' };
      if (!isDigest(m['buildId'])) return { ok: false, reason: 'buildId must be 64 lowercase hex', path: '/buildId' };
      return { ok: true };
    }
    case 'tl.input.request': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'requestId', 'frames', 'restart', 'hold']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRequestId(m['requestId'])) return { ok: false, reason: 'requestId must be req- + 32 hex', path: '/requestId' };
      // Restart the game first.
      if (m['restart'] !== undefined && typeof m['restart'] !== 'boolean') return { ok: false, reason: 'restart must be a boolean', path: '/restart' };
      // Hold the game right after the last step.
      if (m['hold'] !== undefined && typeof m['hold'] !== 'boolean') return { ok: false, reason: 'hold must be a boolean', path: '/hold' };
      const frames = m['frames'];
      if (!Array.isArray(frames) || frames.length < 1 || frames.length > BRIDGE_INPUT_MAX_FRAMES) {
        return { ok: false, reason: `frames must contain 1–${BRIDGE_INPUT_MAX_FRAMES} entries`, path: '/frames' };
      }
      let previous = -1;
      let previousEnd = 0;
      for (let i = 0; i < frames.length; i += 1) {
        const f = frames[i];
        if (!isPlainObject(f)) return { ok: false, reason: 'every frame must be an object', path: `/frames/${i}` };
        // Frame version 2 — named actions and the pointer (validated by the relay parser upstream).
        // Run length, a virtual gamepad and UI edges.
        const b2 = rejectUnknown(f, ['stepOffset', 'steps', 'actions', 'pointer', 'gamepad', 'ui']);
        if (b2) return { ok: false, reason: b2.reason, path: `/frames/${i}${b2.path ?? ''}` };
        if (!int(f['stepOffset'], 0, 2 ** 53 - 1)) return { ok: false, reason: 'stepOffset must be an integer ≥ 0', path: `/frames/${i}/stepOffset` };
        if ((f['stepOffset'] as number) <= previous) return { ok: false, reason: 'frames must be strictly ascending by stepOffset', path: `/frames/${i}/stepOffset` };
        previous = f['stepOffset'] as number;
        const span = relayFrameEnd(previous, f['steps'], previousEnd);
        if (!span.ok) return { ok: false, reason: span.reason, path: `/frames/${i}` };
        previousEnd = span.end;
        if (f['gamepad'] !== undefined && parseRelayGamepad(f['gamepad']) === null) return { ok: false, reason: 'gamepad must be { buttons?: [0-1 ×≤17], axes?: [-1..1 ×≤4] }', path: `/frames/${i}/gamepad` };
        if (f['ui'] !== undefined && parseRelayUiEdges(f['ui']) === null) return { ok: false, reason: 'ui must be 1-8 of up | down | left | right | submit | cancel | pause', path: `/frames/${i}/ui` };
        if (f['actions'] !== undefined && !isPlainObject(f['actions'])) return { ok: false, reason: 'actions must be an object of action values', path: `/frames/${i}/actions` };
        if (f['pointer'] !== undefined && parseRelayPointer(f['pointer']) === null) return { ok: false, reason: 'pointer must be { x, y, dx?, dy?, wheel?, buttons?, pressed?, released?, over?, locked? }', path: `/frames/${i}/pointer` };
      }
      const size = JSON.stringify(m).length;
      if (size > BRIDGE_INPUT_MAX_BYTES) return { ok: false, reason: `tl.input.request exceeds the ${BRIDGE_INPUT_MAX_BYTES}-byte bound` };
      return { ok: true };
    }
    case 'tl.play.stop': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      return { ok: true };
    }
    case 'tl.screenshot.request': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'relayId', 'maxWidth', 'answerWithinMs', 'ui']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (m['maxWidth'] !== undefined && !int(m['maxWidth'], SCREENSHOT_MAX_WIDTH_MIN, SCREENSHOT_MAX_WIDTH_MAX)) {
        return { ok: false, reason: `maxWidth must be an integer ${SCREENSHOT_MAX_WIDTH_MIN}–${SCREENSHOT_MAX_WIDTH_MAX}`, path: '/maxWidth' };
      }
      if (m['ui'] !== undefined && typeof m['ui'] !== 'boolean') return { ok: false, reason: 'ui must be true or false', path: '/ui' };
      return answerWithinProblem(m['answerWithinMs']) ?? { ok: true };
    }
    case 'tl.diagnostics.request': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'relayId']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      return { ok: true };
    }
    case 'tl.game.control':
    case 'tl.game.observe': {
      // loadScene / unloadScene carry the scene id.
      const sceneCommand = m['command'] === 'loadScene' || m['command'] === 'unloadScene';
      // An observation may name an entity (its script property values).
      // A debug command carries its name and arguments.
      const debugCommand = m['command'] === 'debugCommand';
      const replay = m['command'] === 'replay';
      const fields = type === 'tl.game.control' ? ['v', 'type', 'playSessionId', 'relayId', 'command', ...(sceneCommand ? ['sceneId'] : []), ...(debugCommand ? ['name', 'args'] : []), ...(replay ? ['answerWithinMs'] : [])] : ['v', 'type', 'playSessionId', 'relayId', 'entityId'];
      const bad = rejectUnknown(m, fields);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (type === 'tl.game.control' && !GAME_CONTROL.includes(String(m['command']))) {
        return { ok: false, reason: `command must be one of ${GAME_CONTROL.join(', ')}`, path: '/command' };
      }
      if (type === 'tl.game.observe' && m['entityId'] !== undefined && (typeof m['entityId'] !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m['entityId']))) {
        return { ok: false, reason: 'entityId must be an entity id', path: '/entityId' };
      }
      if (sceneCommand && (typeof m['sceneId'] !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m['sceneId']))) {
        return { ok: false, reason: 'sceneId must be a scene id', path: '/sceneId' };
      }
      if (replay) {
        const late = answerWithinProblem(m['answerWithinMs']);
        if (late !== null) return late;
      }
      if (type === 'tl.game.control' && debugCommand) {
        const p = debugCommandCallProblem(m['name'], m['args']);
        if (p !== null) return { ok: false, reason: p.problem, path: p.path };
      }
      return { ok: true };
    }
    case 'tl.debug.request': {
      // The visual-script debugger — which behavior (and object) it watches, its breakpoints, an optional command.
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'relayId', 'behaviorId', 'entityId', 'breakpoints', 'command']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (typeof m['behaviorId'] !== 'string' || !ENTITY_ID_RE.test(m['behaviorId'])) return { ok: false, reason: 'behaviorId must be a behavior id', path: '/behaviorId' };
      if (m['entityId'] !== undefined && (typeof m['entityId'] !== 'string' || !ENTITY_ID_RE.test(m['entityId']))) return { ok: false, reason: 'entityId must be an entity id', path: '/entityId' };
      const bps = m['breakpoints'];
      if (!Array.isArray(bps) || bps.length > BRIDGE_DEBUG_MAX_BREAKPOINTS || !bps.every((b) => typeof b === 'string' && DEBUG_NODE_RE.test(b))) {
        return { ok: false, reason: `breakpoints must list at most ${BRIDGE_DEBUG_MAX_BREAKPOINTS} node ids`, path: '/breakpoints' };
      }
      if (m['command'] !== undefined && !(BRIDGE_DEBUG_COMMANDS as readonly string[]).includes(String(m['command']))) {
        return { ok: false, reason: `command must be one of ${BRIDGE_DEBUG_COMMANDS.join(', ')}`, path: '/command' };
      }
      return { ok: true };
    }
    case 'tl.ping': {
      const bad = rejectUnknown(m, ['v', 'type']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unreachable type' };
  }
}

/** Validate one PREVIEW → EDITOR message (v2). */
export function validateBridgePreviewToEditor(value: unknown): Verdict {
  if (!isPlainObject(value)) return { ok: false, reason: 'message must be a JSON object' };
  const m = value;
  if (m['v'] !== BRIDGE_VERSION) return { ok: false, reason: `v must be ${BRIDGE_VERSION}`, path: '/v' };
  const type = m['type'];
  if (typeof type !== 'string' || !(BRIDGE_PREVIEW_TO_EDITOR_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'type not in the preview→editor allowlist', path: '/type' };
  }
  // A screenshot answer carries the image and has its own bound (every field
  // is bounded below, the data URL by SCREENSHOT_DATA_URL_MAX); the general
  // bound would refuse any real scene's PNG.
  // A screenshot answer that is not ok carries no image, so the general bound
  // holds for it as for every other message.
  if (type !== 'tl.screenshot.result' || m['ok'] !== true) {
    const general = tooLarge(m, BRIDGE_MESSAGE_MAX_BYTES);
    if (general !== null) return { ok: false, reason: general.reason };
  }
  switch (type) {
    case 'tl.handshake.ack': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'nonce']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isNonce(m['nonce'])) return { ok: false, reason: 'nonce must be 16 lowercase hex', path: '/nonce' };
      return { ok: true };
    }
    case 'tl.ready': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'snapshotId', 'revision', 'buildId', 'contentDigest', 'stepIndex']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!str(m['snapshotId'])) return { ok: false, reason: 'snapshotId must be a string', path: '/snapshotId' };
      if (!int(m['revision'], 0, 2 ** 53 - 1)) return { ok: false, reason: 'revision must be an integer ≥ 0', path: '/revision' };
      if (!isDigest(m['buildId'])) return { ok: false, reason: 'buildId must be 64 lowercase hex', path: '/buildId' };
      if (!isDigest(m['contentDigest'])) return { ok: false, reason: 'contentDigest must be 64 lowercase hex', path: '/contentDigest' };
      if (!int(m['stepIndex'], 0, 2 ** 53 - 1)) return { ok: false, reason: 'stepIndex must be an integer ≥ 0', path: '/stepIndex' };
      return { ok: true };
    }
    case 'tl.load.progress': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'phase', 'loadedBytes', 'totalBytes']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (typeof m['phase'] !== 'string' || !(LOAD_PHASES as readonly string[]).includes(m['phase'])) {
        return { ok: false, reason: `phase must be one of ${LOAD_PHASES.join(' | ')}`, path: '/phase' };
      }
      if (typeof m['loadedBytes'] !== 'number' || !Number.isInteger(m['loadedBytes']) || (m['loadedBytes'] as number) < 0) {
        return { ok: false, reason: 'loadedBytes must be an integer ≥ 0', path: '/loadedBytes' };
      }
      if (typeof m['totalBytes'] !== 'number' || !Number.isInteger(m['totalBytes']) || (m['totalBytes'] as number) < 0) {
        return { ok: false, reason: 'totalBytes must be an integer ≥ 0', path: '/totalBytes' };
      }
      const size = JSON.stringify(m).length;
      if (size > BRIDGE_LOAD_PROGRESS_MAX_BYTES) return { ok: false, reason: `tl.load.progress exceeds the ${BRIDGE_LOAD_PROGRESS_MAX_BYTES}-byte bound` };
      return { ok: true };
    }
    case 'tl.input.result': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'requestId', 'ok', 'appliedFromStep', 'appliedToStep', 'error']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      const verdict = validateInputRelayResult({
        playSessionId: m['playSessionId'],
        requestId: m['requestId'],
        ok: m['ok'],
        appliedFromStep: m['appliedFromStep'],
        appliedToStep: m['appliedToStep'],
        error: m['error'],
      });
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      return { ok: true };
    }
    case 'tl.stopped': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      return { ok: true };
    }
    case 'tl.screenshot.result': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'relayId', 'ok', 'dataUrl', 'width', 'height', 'error']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (typeof m['ok'] !== 'boolean') return { ok: false, reason: 'ok must be a boolean', path: '/ok' };
      if (m['ok']) {
        if (typeof m['dataUrl'] !== 'string' || m['dataUrl'].length < 10) return { ok: false, reason: 'dataUrl required when ok', path: '/dataUrl' };
        if (m['dataUrl'].length > SCREENSHOT_DATA_URL_MAX) {
          return { ok: false, reason: `dataUrl is ${m['dataUrl'].length} characters, over the ${SCREENSHOT_DATA_URL_MAX}-character screenshot bound`, path: '/dataUrl' };
        }
        if (!(m['dataUrl'] as string).startsWith('data:image/png;base64,')) {
          return { ok: false, reason: 'dataUrl must be a base64 PNG data URL', path: '/dataUrl' };
        }
        if (!int(m['width'], 1, SCREENSHOT_MAX_WIDTH_MAX)) return { ok: false, reason: `width must be an integer 1–${SCREENSHOT_MAX_WIDTH_MAX} when ok`, path: '/width' };
        if (!int(m['height'], 1, 100_000)) return { ok: false, reason: 'height must be an integer ≥ 1 when ok', path: '/height' };
        if (m['error'] !== undefined) return { ok: false, reason: 'error must be absent when ok', path: '/error' };
      } else {
        const e = m['error'];
        if (!isPlainObject(e)) return { ok: false, reason: 'error required when not ok', path: '/error' };
        if (typeof e['code'] !== 'string' || e['code'].length < 1 || e['code'].length > 128) {
          return { ok: false, reason: 'error.code must be a non-empty string ≤ 128', path: '/error/code' };
        }
        if (e['message'] !== undefined && !str(e['message'], 0, 256)) {
          return { ok: false, reason: 'error.message must be a string ≤ 256', path: '/error/message' };
        }
        const extra = rejectUnknown(e, ['code', 'message']);
        if (extra) return { ok: false, reason: extra.reason, path: `/error${extra.path}` };
      }
      return { ok: true };
    }
    case 'tl.diagnostics.result': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'relayId', 'ok', 'diagnostics', 'error']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (typeof m['ok'] !== 'boolean') return { ok: false, reason: 'ok must be a boolean', path: '/ok' };
      if (m['ok']) {
        if (!isPlainObject(m['diagnostics'])) return { ok: false, reason: 'diagnostics required when ok', path: '/diagnostics' };
        if (JSON.stringify(m['diagnostics']).length > PLAY_DIAGNOSTICS_MAX_BYTES) {
          return { ok: false, reason: 'diagnostics exceeds the 16 KiB bound', path: '/diagnostics' };
        }
      }
      return { ok: true };
    }
    case 'tl.game.control.result':
    case 'tl.game.observe.result': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'relayId', 'ok', 'result', 'error']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (typeof m['ok'] !== 'boolean') return { ok: false, reason: 'ok must be a boolean', path: '/ok' };
      if (m['ok'] && !isPlainObject(m['result'])) return { ok: false, reason: 'result required when ok', path: '/result' };
      if (JSON.stringify(m['result'] ?? null).length > 16_384) return { ok: false, reason: 'result exceeds the 16 KiB bound', path: '/result' };
      return { ok: true };
    }
    case 'tl.debug.result': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'relayId', 'ok', 'result', 'error']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (typeof m['ok'] !== 'boolean') return { ok: false, reason: 'ok must be a boolean', path: '/ok' };
      if (m['ok'] && !isPlainObject(m['result'])) return { ok: false, reason: 'result required when ok', path: '/result' };
      if (JSON.stringify(m['result'] ?? null).length > BRIDGE_DEBUG_RESULT_MAX_BYTES) return { ok: false, reason: `result exceeds the ${BRIDGE_DEBUG_RESULT_MAX_BYTES}-byte bound`, path: '/result' };
      return { ok: true };
    }
    case 'tl.error': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'code', 'phase', 'message']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!str(m['code'], 1, 128)) return { ok: false, reason: 'code must be a non-empty string ≤ 128', path: '/code' };
      if (m['phase'] !== undefined && (typeof m['phase'] !== 'string' || !(LOAD_PHASES as readonly string[]).includes(m['phase']))) {
        return { ok: false, reason: `phase must be one of ${LOAD_PHASES.join(' | ')}`, path: '/phase' };
      }
      if (m['message'] !== undefined && !str(m['message'], 0, 256)) {
        return { ok: false, reason: 'message must be a string ≤ 256', path: '/message' };
      }
      return { ok: true };
    }
    case 'tl.play.problem': {
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'code', 'message']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      const problem = playProblemProblem(m['code'], m['message']);
      if (problem !== null) return { ok: false, reason: problem };
      return { ok: true };
    }
    case 'tl.pong': {
      const bad = rejectUnknown(m, ['v', 'type']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unreachable type' };
  }
}
