/**
 * @thirdlight/protocol — public surface (dependencies.md §3 row:
 * "HTTP payload types + strict validators, WS event types + strict
 * validators, bridge message types + strict validators (sessions.md
 * §7/§13.5), ID syntax constants, allowlist constants").
 *
 * Thirdlight M1 wire protocol (docs/contracts/sessions.md, packet 09):
 * the strict JSON payload discipline (project-model §12.3 pass-1 byte
 * rules + unknown-field rejection), the session-layer error model
 * (§11.2/§11.3), the exhaustive WS event catalog with builders and
 * validators (§7), and the exhaustive bridge message allowlist with
 * strict validators (§13.5). Pure: no I/O, no Node built-ins, no DOM
 * (dependencies.md §4.1: project-model values + commands types only).
 */

// ID syntax constants + validators (sessions.md §3; commands.md §3).
export {
  CONN_ID_RE,
  NONCE_RE,
  PLAY_SESSION_ID_RE,
  PROJECT_ID_RE,
  RELAY_ID_RE,
  REQUEST_ID_RE,
  SESSION_ID_RE,
  SESSION_KINDS,
  WSTOKEN_RE,
  isConnId,
  isNonce,
  isPlaySessionId,
  isProjectId,
  isRelayId,
  isRequestId,
  isSessionId,
  isWsToken,
  type SessionKind,
} from './ids';

// Session-layer error model (sessions.md §11.2/§11.3).
export {
  ERROR_CODES,
  MESSAGE_LIMIT,
  WS_CLOSE_FRAME_TOO_BIG,
  WS_CLOSE_NORMAL,
  WS_CLOSE_PROTOCOL,
  WS_CLOSE_UNAUTHORIZED,
  clipMessage,
  sessionError,
  statusFor,
  type ErrorClass,
  type SessionError,
  type SessionErrorCode,
} from './errors';

// Strict JSON payload discipline (sessions.md §1/§6.1/§11.2).
export {
  checkField,
  checkOptionalObject,
  checkShape,
  isPlainObject,
  isStringNoControl,
  parseStrictJson,
  parseStrictJsonBytes,
  type FieldErrorResult,
  type FieldVerdict,
  type StrictParseResult,
} from './strict';

// HTTP payload types + strict validators (sessions.md §5.1/§6/§10.1/§12).
export {
  ALL_COMMAND_OPS,
  QUERY_OPS,
  SCREENSHOT_MAX_WIDTH_DEFAULT,
  SCREENSHOT_MAX_WIDTH_MAX,
  SCREENSHOT_MAX_WIDTH_MIN,
  isMutationOp,
  parseAdminCreateProjectRequest,
  parseAdminNoArgsBody,
  parseCommandEnvelope,
  parseEstablishRequest,
  parsePlayStartRequest,
  parseScreenshotRequest,
  type AdminCreateProjectRequest,
  type EstablishRequest,
  type PlayStartRequest,
  type ScreenshotRequest,
} from './http';

// WS event catalog (sessions.md §7, exhaustive for M1).
export {
  CLIENT_EVENT_TYPES,
  PLAY_STOP_REASONS,
  PLAY_STOP_REQUEST_REASONS,
  SERVER_EVENT_TYPES,
  WS_IN_FRAME_MAX,
  WS_OUT_FRAME_MAX,
  WS_SCREENSHOT_ACK_MAX,
  enforceDefaultFrameBound,
  inboundFrameAllowed,
  makeAttached,
  makeDiagnosticsRequest,
  makeErrorEvent,
  makeMutationApplied,
  makePong,
  makePlayStarted,
  makePlayStopRequest,
  makePlayStopped,
  makeScreenshotRequest,
  parseInboundEvent,
  type InboundEvent,
  type PlayStopReason,
  type PlayStopRequestReason,
  type RuntimeSnapshotDoc,
  type ServerEventType,
  type ClientEventType,
} from './ws-events';

// Bridge message allowlist + strict validators (sessions.md §13.5).
export {
  BRIDGE_EDITOR_TO_PREVIEW_TYPES,
  BRIDGE_PREVIEW_TO_EDITOR_TYPES,
  BRIDGE_VERSION,
  validateBridgeEditorToPreview,
  validateBridgePreviewToEditor,
  type BridgeEditorToPreviewType,
  type BridgePreviewToEditorType,
} from './bridge';