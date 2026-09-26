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
  CONTENT_ID_RE,
  NONCE_RE,
  PLAY_SESSION_ID_RE,
  PROJECT_ID_RE,
  RELAY_ID_RE,
  REQUEST_ID_RE,
  SESSION_ID_RE,
  SESSION_KINDS,
  WSTOKEN_RE,
  isConnId,
  isContentId,
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
  // Phase 23.8: test/debug start options.
  type PlayStartOptions,
  PLAY_START_SAVE_MAX_BYTES,
  PLAY_START_SAVE_SLOTS,
  PLAY_START_VARIABLES_MAX,
  PLAY_START_VARIABLE_MAX_CHARS,
} from './http';

// M2 content transport wire shapes + strict validators (packet 25:
// sessions.md §11.3/§16.1, workspace.md §7.6/§13.9, delivery.md §15).
export {
  CONTENT_ASSETS_LIMIT_DEFAULT,
  CONTENT_ASSETS_LIMIT_MAX,
  CONTENT_ASSET_BYTES_CACHE,
  CONTENT_ASSET_BYTES_MAX,
  CONTENT_INSPECT_TIMEOUT_MS,
  CONTENT_JOB_KINDS,
  CONTENT_JOB_RESULT_TTL_MS,
  CONTENT_JOB_STATES,
  CONTENT_OPEN_STAGES,
  CONTENT_PROPOSAL_MAX_BYTES,
  CONTENT_PUBLISH_CONCURRENCY_GLOBAL,
  CONTENT_PUBLISH_CONCURRENCY_PER_PROJECT,
  CONTENT_PUBLISH_TIMEOUT_MS,
  CONTENT_STAGED_BYTES_PER_PROJECT,
  CONTENT_STAGE_CREATE_RESPONSE_MAX,
  CONTENT_STAGE_MAX,
  CONTENT_UPLOAD_FRAME_MAX,
  checkUploadFrame,
  containsBinaryValue,
  encodeBinaryFreeStateFrame,
  parseAssetByteParams,
  parseContentAssetsQuery,
  parseJobId,
  parseStageCreateRequest,
  parseStageId,
  parseUploadFrameHeaders,
  validateContentJobView,
  type AssetByteParams,
  type ContentAssetsQuery,
  type ContentJobKind,
  type ContentJobState,
  type ContentJobView,
  type UploadFrameCheckInput,
  type UploadFrameVerdict,
} from './content';

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
  makeGameControlRequest,
  makeGameObserveRequest,
  makeInputRelayRequest,
  makeMutationApplied,
  makePong,
  makePlayStarted,
  playSnapshotPath,
  makePlayStopRequest,
  makePlayStopped,
  makeScreenshotRequest,
  parseInboundEvent,
  type InboundEvent,
  type PlayStopReason,
  type PlayStopRequestReason,
  type PlaySnapshotRef,
  type RuntimeSnapshotDoc,
  type PlayStartResolved,
  type ServerEventType,
  type ClientEventType,
} from './ws-events';

// Bridge message allowlist + strict validators (sessions.md §13.5).
export {
  BRIDGE_EDITOR_TO_PREVIEW_TYPES,
  BRIDGE_INPUT_MAX_BYTES,
  BRIDGE_DEBUG_MAX_BREAKPOINTS,
  BRIDGE_DEBUG_RESULT_MAX_BYTES,
  BRIDGE_DEBUG_COMMANDS,
  BRIDGE_INPUT_MAX_FRAMES,
  BRIDGE_LOAD_PROGRESS_MAX_BYTES,
  BRIDGE_MESSAGE_MAX_BYTES,
  BRIDGE_PREVIEW_TO_EDITOR_TYPES,
  BRIDGE_VERSION,
  LOAD_PHASES,
  validateBridgeEditorToPreview,
  validateBridgePreviewToEditor,
  type BridgeEditorToPreviewType,
  type BridgePreviewToEditorType,
  type LoadPhase,
} from './bridge';

// M2 play delivery: locator/manifest identity + bounded input relay
// (sessions.md §17/§18, delivery.md §2/§4/§8).
export {
  BUILD_OPTIONS_RECORD,
  INPUT_RELAY_ACK_TIMEOUT_MS,
  INPUT_RELAY_MAX_BODY_BYTES,
  INPUT_RELAY_MAX_FRAMES,
  INPUT_RELAY_MODE,
  INPUT_RELAY_RESULT_MAX_BYTES,
  MANIFEST_KEYS,
  PLAY_CONTENT_ARTIFACT_MAX_BYTES,
  PLAY_CONTENT_GRACE_SECONDS,
  PLAY_CONTENT_ID_BYTES,
  PLAY_CONTENT_MANIFEST_MAX_BYTES,
  PLAY_CONTENT_SET_MAX_BYTES,
  PLAY_CONTENT_TTL_SECONDS,
  RUNTIME_CONTENT_MANIFEST_VERSION,
  RUNTIME_CONTENT_TYPE,
  buildOptionsRecordBytes,
  classifyLocatorPath,
  manifestBuildIdInput,
  orderManifest,
  parseInputRelayRequest,
  redactContentId,
  validateInputRelayResult,
  type InputRelayRequest,
  type InputRelayResultDoc,
  type LocatorPath,
  type RelayFrame,
  type RelayJumpPhase,
} from './delivery';

// M3 v3 authoring wire + the §20 game control/observation relay (packet 48;
// workspace.md §16.3, sessions.md §19/§20, delivery.md §5).
export {
  CHANGE_TYPES,
  GAME_CONTROL_BODY_MAX_BYTES,
  GAME_CONTROL_COMMANDS,
  debugCommandCallProblem,
  GAME_CONTROL_RESULT_MAX_BYTES,
  GAME_EVENT_KINDS,
  GAME_GESTURES,
  GAME_INPUT_MODES,
  GAME_OBSERVATION_EVENT_MAX,
  GAME_OBSERVATION_MAX_BYTES,
  GAME_OBSERVE_BODY_MAX_BYTES,
  GAME_OBSERVE_TIMEOUT_DEFAULT_MS,
  GAME_OBSERVE_TIMEOUT_MAX_MS,
  GAME_OBSERVE_TIMEOUT_MIN_MS,
  GAME_RELAY_ERROR_CODES,
  GAME_RUN_STATES,
  GAME_SOUND_STATUSES,
  RUN_ID_RE,
  V3_CONTENT_KEYS,
  V3_ENVELOPE_KEYS,
  V3_MUTATION_OPS,
  V3_QUERY_OPS,
  V3_SCHEMA_VERSION,
  V3_SCENE_KEYS,
  V3_STORAGE_VERSION,
  CONTENT_PROJECTION_KEYS,
  ANIMATION_ROLE_KEYS,
  parseStageInspectRequest,
  parseProjectFilesQuery,
  parseProjectFileInspectRequest,
  type ProjectFileInspectRequest,
  type AnimationRoleBindingValue,
  type AnimationRolesValue,
  type StageInspectRequest,
  gameRelayError,
  isGameRelayId,
  isRunId,
  isSafeIdentifier,
  parseGameControlRequest,
  parseGameObserveRequest,
  validateChangeFrame,
  validateFullStateFrame,
  validateGameControlResult,
  validateGameObservation,
  validateQueryResultV3,
  validateV3ContentBlock,
  validateV3EnvelopeShape,
  validateV3MutationArgs,
  validateV3SceneShape,
  type GameControlCommand,
  type GameControlRequest,
  type GameObserveRequest,
  type GameRunState,
} from './m3';// Phase 9.6: light baking shared by the editor and the backend.
export {
  bakeHashes,
  bakeLightMode,
  hash16,
  isBakeStatic,
  LIGHTMAP_MAX_ATLAS,
  LIGHTMAP_MAX_ATLASES,
  packLightmaps,
  type BakeHashEntity,
  type LightmapItem,
  type LightmapPacking,
  type LightmapPlacement,
} from './bake';

// Phase 21.4: the change record on the WS (no previous side; keyed lists as deltas).
export { WIRE_LIST_KEYS, fromWireChange, toWireChange, type WireListDelta } from './wire-change';
