/**
 * Bridge message allowlist + strict validators — sessions.md §13.5
 * (normative, exhaustive for M1).
 *
 * All messages are strict JSON with `v: 1` (the M1 discriminator); unknown
 * fields are rejected; anything outside the allowlist is dropped by the
 * transport (the editor/preview, packet 10) — these validators are the
 * single home of the strict shapes (dependencies.md §3: "bridge message
 * types + strict validators (sessions.md §7/§13.5)").
 *
 * The validators take the PARSED message value plus the transport
 * discriminators the caller supplies (origin/source checks are the
 * transport's job, §13.3 — they cannot be verified from the message body).
 * Pure: no I/O, no DOM.
 */
import { isNonce, isPlaySessionId, isRelayId } from './ids';

/** The exhaustive allowlists (sessions.md §13.5). */
export const BRIDGE_EDITOR_TO_PREVIEW_TYPES = [
  'tl.handshake',
  'tl.snapshot',
  'tl.play.stop',
  'tl.screenshot.request',
  'tl.diagnostics.request',
  'tl.ping',
] as const;
export type BridgeEditorToPreviewType = (typeof BRIDGE_EDITOR_TO_PREVIEW_TYPES)[number];

export const BRIDGE_PREVIEW_TO_EDITOR_TYPES = [
  'tl.handshake.ack',
  'tl.ready',
  'tl.stopped',
  'tl.screenshot.result',
  'tl.diagnostics.result',
  'tl.error',
  'tl.pong',
] as const;
export type BridgePreviewToEditorType = (typeof BRIDGE_PREVIEW_TO_EDITOR_TYPES)[number];

/** The M1 discriminator (all bridge messages carry `v: 1`). */
export const BRIDGE_VERSION = 1;

type Verdict = { ok: true } | { ok: false; reason: string; path?: string };

function str(v: unknown, min = 1, max = 256): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function int(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Validate one EDITOR → PREVIEW message (sessions.md §13.5).
 * `type` is the discriminator field of the message body.
 */
export function validateBridgeEditorToPreview(value: unknown): Verdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'message must be a JSON object' };
  }
  const m = value as Record<string, unknown>;
  if (m.v !== BRIDGE_VERSION) {
    return { ok: false, reason: `v must be ${BRIDGE_VERSION}`, path: '/v' };
  }
  const type = m.type as string | undefined;
  if (typeof type !== 'string' || !(BRIDGE_EDITOR_TO_PREVIEW_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'type not in the §13.5 editor→preview allowlist', path: '/type' };
  }
  switch (type) {
    case 'tl.handshake': {
      const allowed = new Set(['v', 'type', 'playSessionId', 'nonce', 'demo']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isNonce(m.nonce)) return { ok: false, reason: 'nonce must be 16 lowercase hex', path: '/nonce' };
      if (typeof m.demo !== 'boolean') return { ok: false, reason: 'demo must be a boolean', path: '/demo' };
      return { ok: true };
    }
    case 'tl.snapshot': {
      const allowed = new Set(['v', 'type', 'playSessionId', 'nonce', 'snapshot']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isNonce(m.nonce)) return { ok: false, reason: 'nonce must be 16 lowercase hex', path: '/nonce' };
      // The runtime.md §2 document: strict wrapper shape (the preview's
      // own validateRuntimeSnapshot is the deep re-validation boundary —
      // runtime.md §2; this check pins the wrapper fields only).
      const s = m.snapshot;
      if (typeof s !== 'object' || s === null || Array.isArray(s)) {
        return { ok: false, reason: 'snapshot must be the runtime.md §2 document', path: '/snapshot' };
      }
      const snap = s as Record<string, unknown>;
      for (const k of Object.keys(snap)) {
        if (!['snapshotId', 'projectId', 'revision', 'scene'].includes(k)) {
          return { ok: false, reason: `unknown snapshot field "${k}"`, path: `/snapshot/${k}` };
        }
      }
      if (!str(snap.snapshotId)) return { ok: false, reason: 'snapshot.snapshotId must be a string', path: '/snapshot/snapshotId' };
      if (!str(snap.projectId)) return { ok: false, reason: 'snapshot.projectId must be a string', path: '/snapshot/projectId' };
      if (!int(snap.revision, 0, 2 ** 53 - 1)) return { ok: false, reason: 'snapshot.revision must be an integer ≥ 0', path: '/snapshot/revision' };
      if (typeof snap.scene !== 'object' || snap.scene === null || Array.isArray(snap.scene)) {
        return { ok: false, reason: 'snapshot.scene must be a scene document', path: '/snapshot/scene' };
      }
      return { ok: true };
    }
    case 'tl.play.stop': {
      const allowed = new Set(['v', 'type', 'playSessionId']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      return { ok: true };
    }
    case 'tl.screenshot.request': {
      const allowed = new Set(['v', 'type', 'playSessionId', 'relayId', 'maxWidth']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m.relayId)) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (m.maxWidth !== undefined && !int(m.maxWidth, 256, 2048)) {
        return { ok: false, reason: 'maxWidth must be an integer 256–2048', path: '/maxWidth' };
      }
      return { ok: true };
    }
    case 'tl.diagnostics.request': {
      const allowed = new Set(['v', 'type', 'playSessionId', 'relayId']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m.relayId)) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      return { ok: true };
    }
    case 'tl.ping': {
      const allowed = new Set(['v', 'type']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unreachable type' };
  }
}

/**
 * Validate one PREVIEW → EDITOR message (sessions.md §13.5).
 */
export function validateBridgePreviewToEditor(value: unknown): Verdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'message must be a JSON object' };
  }
  const m = value as Record<string, unknown>;
  if (m.v !== BRIDGE_VERSION) {
    return { ok: false, reason: `v must be ${BRIDGE_VERSION}`, path: '/v' };
  }
  const type = m.type as string | undefined;
  if (typeof type !== 'string' || !(BRIDGE_PREVIEW_TO_EDITOR_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'type not in the §13.5 preview→editor allowlist', path: '/type' };
  }
  switch (type) {
    case 'tl.handshake.ack': {
      const allowed = new Set(['v', 'type', 'playSessionId', 'nonce']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isNonce(m.nonce)) return { ok: false, reason: 'nonce must be 16 lowercase hex', path: '/nonce' };
      return { ok: true };
    }
    case 'tl.ready': {
      const allowed = new Set(['v', 'type', 'playSessionId', 'snapshotId', 'revision']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!str(m.snapshotId)) return { ok: false, reason: 'snapshotId must be a string', path: '/snapshotId' };
      if (!int(m.revision, 0, 2 ** 53 - 1)) return { ok: false, reason: 'revision must be an integer ≥ 0', path: '/revision' };
      return { ok: true };
    }
    case 'tl.stopped': {
      const allowed = new Set(['v', 'type', 'playSessionId']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      return { ok: true };
    }
    case 'tl.screenshot.result': {
      const allowed = new Set(['v', 'type', 'playSessionId', 'relayId', 'ok', 'dataUrl', 'width', 'height', 'error']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m.relayId)) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (typeof m.ok !== 'boolean') return { ok: false, reason: 'ok must be a boolean', path: '/ok' };
      if (m.ok) {
        if (!str(m.dataUrl, 10, 4 * 1024 * 1024)) return { ok: false, reason: 'dataUrl required when ok', path: '/dataUrl' };
        if (typeof m.dataUrl !== 'string' || !m.dataUrl.startsWith('data:image/png;base64,')) {
          return { ok: false, reason: 'dataUrl must be a base64 PNG data URL', path: '/dataUrl' };
        }
        if (!int(m.width, 1, 2048)) return { ok: false, reason: 'width must be an integer 1–2048 when ok', path: '/width' };
        if (!int(m.height, 1, 100000)) return { ok: false, reason: 'height must be an integer ≥ 1 when ok', path: '/height' };
        if (m.error !== undefined) return { ok: false, reason: 'error must be absent when ok', path: '/error' };
      } else {
        const e = m.error as Record<string, unknown> | undefined;
        if (typeof e !== 'object' || e === null || Array.isArray(e)) {
          return { ok: false, reason: 'error required when not ok', path: '/error' };
        }
        if (typeof e.code !== 'string' || e.code.length < 1 || e.code.length > 128) {
          return { ok: false, reason: 'error.code must be a non-empty string ≤ 128', path: '/error/code' };
        }
        if (e.message !== undefined && !str(e.message, 0, 256)) {
          return { ok: false, reason: 'error.message must be a string ≤ 256', path: '/error/message' };
        }
      }
      return { ok: true };
    }
    case 'tl.diagnostics.result': {
      const allowed = new Set(['v', 'type', 'playSessionId', 'relayId', 'ok', 'diagnostics', 'error']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!isRelayId(m.relayId)) return { ok: false, reason: 'relayId must be relay- + 32 hex', path: '/relayId' };
      if (typeof m.ok !== 'boolean') return { ok: false, reason: 'ok must be a boolean', path: '/ok' };
      if (m.ok) {
        if (typeof m.diagnostics !== 'object' || m.diagnostics === null || Array.isArray(m.diagnostics)) {
          return { ok: false, reason: 'diagnostics required when ok', path: '/diagnostics' };
        }
        if (JSON.stringify(m.diagnostics).length > 16384) {
          return { ok: false, reason: 'diagnostics exceeds the 16 KiB bound', path: '/diagnostics' };
        }
      }
      return { ok: true };
    }
    case 'tl.error': {
      const allowed = new Set(['v', 'type', 'playSessionId', 'code', 'message']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      if (!isPlaySessionId(m.playSessionId)) return { ok: false, reason: 'playSessionId must be play- + 32 hex', path: '/playSessionId' };
      if (!str(m.code, 1, 128)) return { ok: false, reason: 'code must be a non-empty string ≤ 128', path: '/code' };
      if (m.message !== undefined && !str(m.message, 0, 256)) {
        return { ok: false, reason: 'message must be a string ≤ 256', path: '/message' };
      }
      return { ok: true };
    }
    case 'tl.pong': {
      const allowed = new Set(['v', 'type']);
      for (const k of Object.keys(m)) if (!allowed.has(k)) return { ok: false, reason: `unknown field "${k}"`, path: `/${k}` };
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unreachable type' };
  }
}