/**
 * The stable backend surface (dependencies.md §3: `@thirdlight/backend` →
 * `openWorkspaceService`-style bootstrap + the `/services` subpath).
 *
 * `createBackend(config)` is what the MCP adapter (packet 11) and the
 * integration tests import from `@thirdlight/backend/services`. The
 * default subpath (`.`) is the executable bootstrap (the owner-deployment
 * process entry) — no package imports it (dependencies.md §4.3).
 */
export {
  createBackend,
  MAX_DIAGNOSTICS,
  MAX_HTTP_BODY,
  MAX_SCREENSHOT,
  SESSION_LIST_MAX,
  STARTUP_LOG_RING,
  type Backend,
  type SessionView,
} from '../backend';
export {
  DEFAULT_TIMEOUTS,
  mergeTimeouts,
  parseBackendConfig,
  type BackendConfig,
  type BackendTimeouts,
  type BackendTokenEntry,
} from '../config';
export { SESSION_LOG_RING, type LogEntry, type LogKind, type SessionRecord } from '../sessions';
export {
  acknowledgePreparedDigest,
  publishBehaviorSource,
  type PublishBehaviorSourceOutcome,
  type PublishBehaviorSourceRequest,
} from '../behavior';
export {
  type PlayHooks,
  type PlayRecord,
  type PlayState,
  type PlayStopReason,
  type RelayOutcome,
  PlayManager,
} from '../play';