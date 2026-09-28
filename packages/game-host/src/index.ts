/**
 * @thirdlight/game-host — public surface (the delivery.md §3.1 face + the
 * packet-54 `.` audio entry).
 *
 * dependencies.md §3 row: the host's DOM, control, audio and composition
 * modules are NOT subpaths — the entry is the only reachable surface, so a
 * bundle wrapper cannot reach past it.
 *
 * Packet 55 (delivery.md §3.1/§3.2): `createGameHost` + the §3.1 constants/
 * types (GAME_HOST_API_VERSION, GAME_CONTROL_ACTIONS, GAME_HOST_MESSAGES,
 * GameHostConfig, GameHostObservation) and the structural injection
 * surfaces (HostInputOwner, HostRenderAdapter, GameHostSound). Additive over
 * the binding surface (CC-55-1/CC-55-1b/CC-55-2, packet-55 handoff):
 * GameHostConfig.buildId/assetPaths, the adapter FACTORY, and the read-only
 * `runtime` seam on the returned host.
 *
 * Packet 54: the injected audio owner surface of presentation.md §41.4.7.
 * DOM/window access is isolated to `browserContextFactory` below (the only
 * function in this package that touches `window`); the owner core
 * (`./audio`) and the host core (`./host`) are DOM-free, deterministic and
 * Node-testable with injected fakes.
 */
import type { AudioContextLike } from './audio';
export {
  AUDIO_MAX_VOICES,
  AUDIO_MAX_DIAGNOSTICS,
  createGameAudioOwner,
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
  MUSIC_MAX_REGISTERED,
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
// Phase 24.4j: the game shell (menus and HUD as UI documents) and the prompts generated from the input actions.
export { createShellController, type ShellConfigLike, type ShellController, type ShellObservation, type ShellScreenKey, type ShellState } from './shell';
export {
  GAME_HOST_API_VERSION,
  GAME_CONTROL_ACTIONS,
  GAME_HOST_MESSAGES,
  createGameHost,
  scenesToReadAhead,
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
 * The browser entry's ONLY DOM touchpoint (§41.4.7: DOM/`window` access is
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
}export {
  bufferResolver,
  prepareSceneCatalog,
  // Phase 25.7b: the manifest's content files read back under their keys.
  expandManifestContentFiles,
  type ManifestContentFileRowLike,
  type ManifestBufferRow,
  type ManifestSceneRow,
  type SceneCatalogIo,
} from './scene-catalog';
// Phase 25.24e: scene loads prepared before they are handed to the simulation, and scenes read ahead.
export { createScenePreloader, pageScenePreparation, SCENES_READ_AHEAD, SCENE_PREPARE_WAIT_MS, type ScenePreloader, type ScenePreparation, type ScenePreparingAdapter, type ScenePreloadHooks } from './scene-preload';
// Phase 22.0: the simulation worker (runs the deterministic simulation off the page) and its page-side mirror.
export { runSimWorker, type SimWorkerDeps } from './sim-worker';
export { startRemoteSimulation, remoteStartError, type RemoteSimulation, type RemoteSimulationOptions } from './sim-remote';
export { createLocalSimAccess, type SimAccess, type SimRay } from './sim-access';
export { browserWorkerAvailable, createBrowserSimWorker, loadPhysics3D, workerGlobalEndpoint } from './sim-browser';
// Phase 23.0: the 3D physics backend's hand-over (a separate script; see physics-3d-global.ts).
export { PHYSICS_3D_GLOBAL, registerPhysics3D, type Physics3DModule } from './physics-3d-global';
export { PHYSICS_MEMORY_CAP_BYTES, TRANSFORM_STRIDE, type FrameState, type SimEndpoint, type SimInitMessage, type SimWorkerHandle, type SceneEntities } from './sim-protocol';
export { resolveThreadingMode, resolveTransport, threadingFromUrl, threadingLogLine, SIM_THREAD_SETTING_VALUES, THREADS_URL_PARAM, type SimTransport, type ThreadingMode } from './threading';
export { TickInputSource, continueFrame, mergePhase } from './tick-input';
export { stepDigest } from './step-digest';
// Phase 25.24b: the verified asset reader (start-scene assets first, bounded parallel; the rest on demand).
export { AssetReadError, ASSET_READS_IN_FLIGHT, createVerifiedAssetReader, startSceneAssets, type AssetReaderIo, type DeclaredAssetRow, type StartAssetSources, type VerifiedAssetReader } from './asset-reader';
// Phase 25.24a: where a game page's start time goes (stages, first frame, slow frames, scene loads).
export { createStartTimings, FRAME_WATCH_MS, SLOW_FRAME_MS, type FrameWatch, type SceneLoadTiming, type SlowFrame, type StartStage, type StartTimings, type StartTimingsReport } from './start-timings';
export { createDebugConsole, consoleWords, parseConsoleLine, DEBUG_CONSOLE_KEY, type DebugConsole, type DebugConsoleDeps } from './debug-console';
export { PlayDebugger, sampleValue, type DebugRequest, type DebugResult, type DebugRuntime } from './play-debug';
export { RelayActionSource } from './relay-input';
export { actionPrompts, actionWords, keyBindingLabel, keyLabel, padButtonLabel, resolveCursorMode, type ActionPrompt, type InputConfigLike } from './bindings';
// Phase 23.19: project save documents (the page owns the slots: IndexedDB; the settings document: localStorage).
export { browserProjectSaveBackend, createProjectSaveService, memoryProjectSaveBackend, readProjectSettings, type ProjectSaveBackend, type ProjectSaveService, type ProjectSlotObservation, type SaveThumbnailInfo, type ThumbnailCapture } from './project-saves';
export type { ProjectSavesObservation } from './host';
// Phase 23.14: the rebinding API (list, listen, conflicts, reset, profiles), device detection and glyphs.
export { createInputBindings, REBIND_DEFAULT_CANCEL, REBIND_DEFAULT_POLICY, REBIND_DEFAULT_TIMEOUT_S, type BindingsControllerDeps, type BindingsInputOwner, type InputBindingsController, type ListenOptions } from './rebind';
export { applyOverrides, applyRebind, bindingFrom, findConflicts, overridesOf, resetBindings, resolveTarget, validBinding, type Captured, type ConfigData, type RebindResult, type RebindTarget } from './input-bindings';
export { bindingGlyph, gamepadFamily, glyphDataUrl, glyphSvg, keyName, padAxisGlyph, padButtonGlyph, GLYPH_ICONS, type GlyphIcon, type GlyphOverrides } from './glyphs';
// Phase 23.16: the dialogue previewer (the editor's dialogue tab plays a conversation with the host's UI layer and audio, outside Play).
export { createDialoguePreview, type DialoguePreview, type DialoguePreviewDeps, type DialoguePreviewObservation } from './dialogue-preview';
export type { DialogueObservation } from './host';
