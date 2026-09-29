/**
 * ID and token syntax constants for sessions, `requestId` and project IDs.
 *
 * Deliberate duplicates of the project-model ID pattern: the dependency
 * direction (protocol → project-model) means the protocol cannot import an
 * internal pattern; the syntaxes are stable contract text (same record as
 * the runtime snapshot validator).
 */
import { ID_RE } from '@thirdlight/project-model/limits';

/** All project/entity/scene IDs (the project-model ID syntax). */
export const PROJECT_ID_RE = ID_RE;
/** `sess-` + 32 lowercase hex (client-generated). */
export const SESSION_ID_RE = /^sess-[0-9a-f]{32}$/;
/** `conn-` + 32 lowercase hex (server-generated). */
export const CONN_ID_RE = /^conn-[0-9a-f]{32}$/;
/** `play-` + 32 lowercase hex (server-generated). */
export const PLAY_SESSION_ID_RE = /^play-[0-9a-f]{32}$/;
/** 64 lowercase hex (server-generated, single-use, TTL). */
export const WSTOKEN_RE = /^[0-9a-f]{64}$/;
/** `relay-` + 32 lowercase hex (server-generated). */
export const RELAY_ID_RE = /^relay-[0-9a-f]{32}$/;
/** `req-` + 32 hex (client-generated, dedup lease). */
export const REQUEST_ID_RE = /^req-[0-9a-f]{32}$/;

export function isProjectId(v: unknown): v is string {
  return typeof v === 'string' && PROJECT_ID_RE.test(v);
}
export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID_RE.test(v);
}
export function isConnId(v: unknown): v is string {
  return typeof v === 'string' && CONN_ID_RE.test(v);
}
export function isPlaySessionId(v: unknown): v is string {
  return typeof v === 'string' && PLAY_SESSION_ID_RE.test(v);
}
export function isWsToken(v: unknown): v is string {
  return typeof v === 'string' && WSTOKEN_RE.test(v);
}
export function isRelayId(v: unknown): v is string {
  return typeof v === 'string' && RELAY_ID_RE.test(v);
}
export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && REQUEST_ID_RE.test(v);
}

/**
 * The play-content locator capability — 32 random bytes as
 * unpadded base64url (43 chars). A secret-equivalent that is redacted in logs
 * (`<redacted:contentId>`) and excluded from exports.
 */
export const CONTENT_ID_RE = /^[A-Za-z0-9_-]{43}$/;
export function isContentId(v: unknown): v is string {
  return typeof v === 'string' && CONTENT_ID_RE.test(v);
}

/** 16-hex handshake nonce (fresh per handshake). */
export const NONCE_RE = /^[0-9a-f]{16}$/;
export function isNonce(v: unknown): v is string {
  return typeof v === 'string' && NONCE_RE.test(v);
}

/**
 * The only session kind. MCP and admin clients never
 * establish sessions; any other `kind` ⇒ `field_value`.
 */
export const SESSION_KINDS = ['browser'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];