/**
 * Bridge message allowlist + strict validators — sessions.md §13.5 with the
 * packet-35 M2 v2 additions (delivery.md §7, sessions.md §17.6).
 *
 * All messages are strict JSON with `v: 2` (the M2 bridge discriminator); a
 * `v: 1` message is rejected exactly like an unknown field. Unknown fields are
 * rejected; anything outside the allowlist is dropped by the transport (the
 * editor/preview) — these validators are the single home of the strict shapes
 * (dependencies.md §3).
 *
 * The validators take the PARSED message value plus the transport
 * discriminators the caller supplies (origin/source checks are the transport's
 * job, §13.3 — they cannot be verified from the message body). Pure: no I/O.
 */
import { isContentId, isNonce, isPlaySessionId, isRelayId, isRequestId } from './ids';
import { validateInputRelayResult } from './delivery';

/** The exhaustive allowlists (sessions.md §13.5, v2). */
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
  'tl.error',
  'tl.pong',
] as const;
export type BridgePreviewToEditorType = (typeof BRIDGE_PREVIEW_TO_EDITOR_TYPES)[number];

/** The M2 discriminator (all bridge messages carry `v: 2`). */
export const BRIDGE_VERSION = 2;

/** §17.6: the general v2 message cap. */
export const BRIDGE_MESSAGE_MAX_BYTES = 65_536;
/** §17.6: `tl.load.progress` cap. */
export const BRIDGE_LOAD_PROGRESS_MAX_BYTES = 1_024;
/** §17.6: `tl.input.request` frames/bytes cap. */
export const BRIDGE_INPUT_MAX_FRAMES = 600;
export const BRIDGE_INPUT_MAX_BYTES = 16_384;

type Verdict = { ok: true } | { ok: false; reason: string; path?: string };

function str(v: unknown, min = 1, max = 256): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
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

/** `phase ∈ {shell, manifest, assets, behaviors, runtime}` (§17.6). */
export const LOAD_PHASES = ['shell', 'manifest', 'assets', 'behaviors', 'runtime'] as const;
export type LoadPhase = (typeof LOAD_PHASES)[number];

/** `jump ∈ {none, pressed, held, released}` (runtime.md §12.5). */
const JUMP_PHASES: readonly string[] = ['none', 'pressed', 'held', 'released'];

/**
 * Validate one EDITOR → PREVIEW message (sessions.md §13.5, v2).
 * `type` is the discriminator field of the message body.
 */
export function validateBridgeEditorToPreview(value: unknown): Verdict {
  if (!isPlainObject(value)) return { ok: false, reason: 'message must be a JSON object' };
  const m = value;
  if (m['v'] !== BRIDGE_VERSION) return { ok: false, reason: `v must be ${BRIDGE_VERSION}`, path: '/v' };
  const type = m['type'];
  if (typeof type !== 'string' || !(BRIDGE_EDITOR_TO_PREVIEW_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'type not in the §13.5 editor→preview allowlist', path: '/type' };
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
      if (!isPlainObject(s)) return { ok: false, reason: 'snapshot must be the runtime.md §2 document', path: '/snapshot' };
      for (const k of Object.keys(s)) {
        if (!['snapshotId', 'projectId', 'revision', 'scene', 'game', 'tags'].includes(k)) {
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
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'requestId', 'frames']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRequestId(m['requestId'])) return { ok: false, reason: 'requestId must be req- + 32 hex', path: '/requestId' };
      const frames = m['frames'];
      if (!Array.isArray(frames) || frames.length < 1 || frames.length > BRIDGE_INPUT_MAX_FRAMES) {
        return { ok: false, reason: `frames must contain 1–${BRIDGE_INPUT_MAX_FRAMES} entries`, path: '/frames' };
      }
      let previous = -1;
      for (let i = 0; i < frames.length; i += 1) {
        const f = frames[i];
        if (!isPlainObject(f)) return { ok: false, reason: 'every frame must be an object', path: `/frames/${i}` };
        const b2 = rejectUnknown(f, ['stepOffset', 'moveX', 'jump']);
        if (b2) return { ok: false, reason: b2.reason, path: `/frames/${i}${b2.path ?? ''}` };
        if (!int(f['stepOffset'], 0, 2 ** 53 - 1)) return { ok: false, reason: 'stepOffset must be an integer ≥ 0', path: `/frames/${i}/stepOffset` };
        if ((f['stepOffset'] as number) <= previous) return { ok: false, reason: 'frames must be strictly ascending by stepOffset', path: `/frames/${i}/stepOffset` };
        previous = f['stepOffset'] as number;
        if (typeof f['moveX'] !== 'number' || !Number.isFinite(f['moveX']) || (f['moveX'] as number) < -1 || (f['moveX'] as number) > 1) {
          return { ok: false, reason: 'moveX must be a finite number in [-1, 1]', path: `/frames/${i}/moveX` };
        }
        if (typeof f['jump'] !== 'string' || !JUMP_PHASES.includes(f['jump'])) {
          return { ok: false, reason: 'jump must be one of none | pressed | held | released', path: `/frames/${i}/jump` };
        }
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
      const bad = rejectUnknown(m, ['v', 'type', 'playSessionId', 'relayId', 'maxWidth']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (m['maxWidth'] !== undefined && !int(m['maxWidth'], 256, 2048)) {
        return { ok: false, reason: 'maxWidth must be an integer 256–2048', path: '/maxWidth' };
      }
      return { ok: true };
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
      const fields = type === 'tl.game.control' ? ['v', 'type', 'playSessionId', 'relayId', 'command'] : ['v', 'type', 'playSessionId', 'relayId'];
      const bad = rejectUnknown(m, fields);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      if (!isPlaySessionId(m['playSessionId'])) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m['relayId'])) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (type === 'tl.game.control' && !['start', 'replay', 'mute', 'unmute'].includes(String(m['command']))) {
        return { ok: false, reason: 'command must be start, replay, mute or unmute', path: '/command' };
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

/** Validate one PREVIEW → EDITOR message (sessions.md §13.5, v2). */
export function validateBridgePreviewToEditor(value: unknown): Verdict {
  if (!isPlainObject(value)) return { ok: false, reason: 'message must be a JSON object' };
  const m = value;
  if (m['v'] !== BRIDGE_VERSION) return { ok: false, reason: `v must be ${BRIDGE_VERSION}`, path: '/v' };
  const type = m['type'];
  if (typeof type !== 'string' || !(BRIDGE_PREVIEW_TO_EDITOR_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'type not in the §13.5 preview→editor allowlist', path: '/type' };
  }
  const general = tooLarge(m, BRIDGE_MESSAGE_MAX_BYTES);
  if (general !== null) return { ok: false, reason: general.reason };
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
        if (!str(m['dataUrl'], 10, 4 * 1024 * 1024)) return { ok: false, reason: 'dataUrl required when ok', path: '/dataUrl' };
        if (!(m['dataUrl'] as string).startsWith('data:image/png;base64,')) {
          return { ok: false, reason: 'dataUrl must be a base64 PNG data URL', path: '/dataUrl' };
        }
        if (!int(m['width'], 1, 2048)) return { ok: false, reason: 'width must be an integer 1–2048 when ok', path: '/width' };
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
        if (JSON.stringify(m['diagnostics']).length > 16_384) {
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
    case 'tl.pong': {
      const bad = rejectUnknown(m, ['v', 'type']);
      if (bad) return { ok: false, reason: bad.reason, path: bad.path };
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unreachable type' };
  }
}
