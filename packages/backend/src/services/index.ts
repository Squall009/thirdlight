/**
 * The stable backend surface (`@thirdlight/backend` →
 * `openWorkspaceService`-style bootstrap + the `/services` subpath).
 *
 * `createBackend(config)` is what the MCP adapter and the
 * integration tests import from `@thirdlight/backend/services`. The
 * default subpath (`.`) is the executable bootstrap (the owner-deployment
 * process entry) — no package imports it.
 */
export {
  createBackend,
  MAX_DIAGNOSTICS,
  MAX_HTTP_BODY,
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
} from '../play';// Script error and log locations mapped back to the project's sources.
export { mapCompiledLocation, withSourceLocations, type CompiledLocation, type SourceLocation, type SourceMapTable } from '../source-locations';
