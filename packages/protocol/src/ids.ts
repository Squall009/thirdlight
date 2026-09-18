/**
 * ID and token syntax constants — sessions.md §3 (normative) +
 * commands.md §3 (`requestId`) + project-model §5.1 (project IDs).
 *
 * Deliberate duplicates of the project-model ID pattern: the dependency
 * direction (protocol → project-model) means the protocol cannot import an
 * internal pattern; the syntaxes are stable contract text (same record as
 * the runtime snapshot validator, handoff 08).
 */

/** project-model §5.1: all project/entity/scene IDs. */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** sessions.md §3: `sess-` + 32 lowercase hex (client-generated). */
export const SESSION_ID_RE = /^sess-[0-9a-f]{32}$/;
/** sessions.md §3: `conn-` + 32 lowercase hex (server-generated). */
export const CONN_ID_RE = /^conn-[0-9a-f]{32}$/;
/** sessions.md §3: `play-` + 32 lowercase hex (server-generated). */
export const PLAY_SESSION_ID_RE = /^play-[0-9a-f]{32}$/;
/** sessions.md §3: 64 lowercase hex (server-generated, single-use, TTL). */
export const WSTOKEN_RE = /^[0-9a-f]{64}$/;
/** sessions.md §3: `relay-` + 32 lowercase hex (server-generated). */
export const RELAY_ID_RE = /^relay-[0-9a-f]{32}$/;
/** commands.md §3: `req-` + 32 hex (client-generated, dedup lease). */
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

/** sessions.md §3: 16-hex handshake nonce (fresh per handshake). */
export const NONCE_RE = /^[0-9a-f]{16}$/;
export function isNonce(v: unknown): v is string {
  return typeof v === 'string' && NONCE_RE.test(v);
}

/**
 * sessions.md §4.2: the only M1 session kind. MCP and admin clients never
 * establish sessions; any other `kind` ⇒ `field_value`.
 */
export const SESSION_KINDS = ['browser'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];