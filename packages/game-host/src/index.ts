/**
 * @thirdlight/game-host — public surface (the game host and the audio
 * owner, both from the `.` entry).
 *
 * The host's DOM, control, audio and composition
 * modules are NOT subpaths — the entry is the only reachable surface, so a
 * bundle wrapper cannot reach past it.
 *
 * `createGameHost` + its constants/
 * types (GAME_HOST_API_VERSION, GAME_CONTROL_ACTIONS, GAME_HOST_MESSAGES,
 * GameHostConfig, GameHostObservation) and the structural injection
 * surfaces (HostInputOwner, HostRenderAdapter, GameHostSound), including
 * GameHostConfig.buildId/assetPaths, the adapter FACTORY, and the read-only
 * `runtime` seam on the returned host.
 *
 * The injected audio owner surface.
 * DOM/window access is isolated to `browserContextFactory` below (the only
 * function in this package that touches `window`); the owner core
 * (`./audio`) and the host core (`./host`) are DOM-free, deterministic and
 * Node-testable with injected fakes.
 */
import type { AudioContextLike, MediaElementLike } from './audio';
export {
  AUDIO_MAX_VOICES,
  AUDIO_MAX_DIAGNOSTICS,
  AUDIO_REPORT_LISTED,
  AUDIO_REPORT_NOTES,
  createGameAudioOwner,
  type AudioReport,
  type AudioSkipReason,
  type GameCueEvent,
  type GameAudioStatus,
  type GameAudioError,
  type GameAudioDiagnosticCode,
  type GameAudioDiagnostic,
  type GameAudioOwner,
  type GameAudioOwnerConfig,
  type AudioBufferLike,
  type AudioNodeLike,
  type GainNodeLike,
  type BufferSourceLike,
  type AudioContextLike,
  type AudioBus,
  AUDIO_PANNING_MODEL,
  type AudioCommandLike,
  type AudioListenerLike,
  type AudioObservation,
  type AudioParamLike,
  type AudioSpatialLike,
  type AudioVoiceInfo,
  type PannerNodeLike,
} from './audio';
// The player's settings storage (localStorage in the browser): bindings per profile, the shell's and the project's settings.
export { browserSaveStorage, createSettingsStore, saveChecksum, SAVE_MAX_BYTES, type SaveStorage, type SettingsStore } from './storage';
export type { FlowUiEdges, HostDom, HostDomNode, UiEdges } from './dom';
// The game shell (menus and HUD as UI documents) and the prompts generated from the input actions.
export { createShellController, type ShellConfigLike, type ShellController, type ShellObservation, type ShellScreenKey, type ShellState } from './shell';
// The scenes a page reads ahead (transitions' targets, the listed scene's next, the interiors behind doors near the camera).
export { BUILDING_READ_AHEAD_METRES, scenesToReadAhead } from './scene-read-ahead';
export {
  GAME_HOST_API_VERSION,
  GAME_CONTROL_ACTIONS,
  GAME_HOST_MESSAGES,
  createGameHost,
  composeGameRuntime,
  type GameRuntimeArgs,
  linkBehaviorModules,
  mapSoundStatus,
  type GameControlAction,
  type GameControlResult,
  type GameControlError,
  type GameHost,
  type GameHostConfig,
  type GameStartOptions,
  type GameStartOutcome,
  type GameHostObservation,
  type PlayState,
  type GameHostEnvironmentObservation,
  type SocketObservation,
  type GameHostSound,
  type HostInputOwner,
  type HostRenderAdapter,
  type ManifestBehaviorRow,
} from './host';

/**
 * The browser entry's ONLY DOM touchpoint (DOM/`window` access is
 * isolated to this browser entry). Returns the environment's AudioContext
 * producer — or `null` when the environment has no Web Audio (the owner
 * then reports status `unsupported`/`no_audio_context` and the game plays
 * silently). Never throws and never creates a context at call time: the
 * returned factory is invoked exactly once, by the owner, on the first
 * `unlock()` (the real local gesture — rule 7).
 */
export function browserContextFactory(): (() => AudioContextLike | null) | null {
  if (typeof window === 'undefined') return null;
  const ctor: (typeof window)['AudioContext'] | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (typeof ctor !== 'function') return null;
  return () => {
    try {
      return new ctor() as unknown as AudioContextLike;
    } catch {
      return null; // construction refused (e.g. no device) → owner: unsupported/blocked
    }
  };
}

/**
 * The media elements streamed audio files play through (each through the
 * owner's context as a MediaElementAudioSourceNode). Same-origin files
 * only: a cross-origin element without CORS would be heard as silence.
 * Null without a document.
 */
export function browserMediaElementFactory(): (() => MediaElementLike | null) | null {
  if (typeof document === 'undefined') return null;
  return () => {
    try {
      return document.createElement('audio') as unknown as MediaElementLike;
    } catch {
      return null;
    }
  };
}
export {
  bufferResolver,
  prepareSceneCatalog,
  // The manifest's content files read back under their keys.
  expandManifestContentFiles,
  type ManifestContentFileRowLike,
  type ManifestBufferRow,
  type ManifestSceneRow,
  type SceneCatalogIo,
  type SceneLookLike,
} from './scene-catalog';
// A build's runtime content: the manifest and the catalog, read as the game needs it (v5; a v4 build opens the same way).
export { openRuntimeContent, type CatalogRow, type RuntimeCatalog, type RuntimeContent } from './runtime-content';
// A terrain's tiles read from their blobs (renderer, colliders and queries ask the field).
export { loadTerrainField, terrainTileOf } from './terrain-tiles';
// Scene loads prepared before they are handed to the simulation, and scenes read ahead.
export { createScenePreloader, pageScenePreparation, SCENES_READ_AHEAD, SCENE_PREPARE_WAIT_MS, type ScenePreloader, type ScenePreparation, type ScenePreparingAdapter, type ScenePreloadHooks } from './scene-preload';
// The simulation worker (runs the deterministic simulation off the page) and its page-side mirror.
export { runSimWorker, type SimWorkerDeps } from './sim-worker';
export { startRemoteSimulation, remoteStartError, type RemoteSimulation, type RemoteSimulationOptions, type SimPipelineStats } from './sim-remote';
export { createLocalSimAccess, type RelayPage, type SimAccess, type SimRay } from './sim-access';
export { browserWorkerAvailable, createBrowserSimWorker, loadPhysics2D, loadPhysics3D, workerGlobalEndpoint } from './sim-browser';
// The physics backends' hand-over (separate scripts; see physics-global.ts).
export { PHYSICS_2D_GLOBAL, PHYSICS_3D_GLOBAL, registerPhysics2D, registerPhysics3D, type Physics2DModule, type Physics3DModule } from './physics-global';
export { PHYSICS_MEMORY_CAP_BYTES, STEP_PAIR_STRIDE, TRANSFORM_STRIDE, type FrameState, type SimEndpoint, type SimInitMessage, type SimWorkerHandle, type SceneEntities } from './sim-protocol';
export { resolveThreadingMode, resolveTransport, simDelayFromUrl, threadingFromUrl, threadingLogLine, SIM_DELAY_URL_PARAM, SIM_THREAD_SETTING_VALUES, THREADS_URL_PARAM, type SimTransport, type ThreadingMode } from './threading';
export { TickInputSource, continueFrame, mergePhase } from './tick-input';
export { runDigest, stepDigest } from './step-digest';
export { RunProbe, runNowOf, type InputRunDigest, type RunDigestNow, type RunDigests, type RunNow } from './run-probe';
// The verified asset reader (start-scene assets first, bounded parallel; the rest on demand).
export { AssetReadError, ASSET_READS_IN_FLIGHT, createVerifiedAssetReader, startSceneAssets, mipPartsOf, type AssetReaderIo, type MipPartRow, type AssetRowSource, type DeclaredAssetRow, type StartAssetSources, type VerifiedAssetReader } from './asset-reader';
// Where a game page's start time goes (stages, first frame, slow frames, scene loads).
export { createStartTimings, FRAME_WATCH_MS, SLOW_FRAME_MS, type FrameWatch, type SceneLoadTiming, type SlowFrame, type StartStage, type StartTimings, type StartTimingsReport } from './start-timings';
export { createDebugConsole, consoleWords, parseConsoleLine, DEBUG_CONSOLE_KEY, type DebugConsole, type DebugConsoleDeps } from './debug-console';
export { PlayDebugger, sampleValue, type DebugRequest, type DebugResult, type DebugRuntime } from './play-debug';
export { RelayActionSource, type RelayEffect, type RelayTestFrame, type RelayUiEdgeName } from './relay-input';
// The pointer's UI hit test and the observation's element rectangles.
export { hitUiTargets, type UiHitTarget } from './ui-hit';
export type { UiElementObservation } from './ui-layer';
export { actionPrompts, actionWords, keyBindingLabel, keyLabel, padButtonLabel, resolveCursorMode, type ActionPrompt, type InputConfigLike } from './bindings';
// Project save documents (the page owns the slots: IndexedDB; the settings document: localStorage).
export { browserDeviceStorage, browserProjectSaveBackend, createProjectSaveService, memoryProjectSaveBackend, unavailableProjectSaveBackend, type DeviceStorage, readProjectSettings, type ProjectSaveBackend, type ProjectSaveService, type ProjectSlotObservation, type SaveThumbnailInfo, type ThumbnailCapture } from './project-saves';
export type { ProjectSavesObservation } from './host';
// The rebinding API (list, listen, conflicts, reset, profiles), device detection and glyphs.
export { createInputBindings, REBIND_DEFAULT_CANCEL, REBIND_DEFAULT_POLICY, REBIND_DEFAULT_TIMEOUT_S, type BindingsControllerDeps, type BindingsInputOwner, type InputBindingsController, type ListenOptions } from './rebind';
export { applyOverrides, applyRebind, bindingFrom, findConflicts, overridesOf, resetBindings, resolveTarget, validBinding, type Captured, type ConfigData, type RebindResult, type RebindTarget } from './input-bindings';
export { bindingGlyph, gamepadFamily, glyphDataUrl, glyphSvg, keyName, padAxisGlyph, padButtonGlyph, GLYPH_ICONS, type GlyphIcon, type GlyphOverrides } from './glyphs';
// The dialogue previewer (the editor's dialogue tab plays a conversation with the host's UI layer and audio, outside Play).
export { createDialoguePreview, type DialoguePreview, type DialoguePreviewDeps, type DialoguePreviewObservation } from './dialogue-preview';
export type { DialogueObservation } from './host';
