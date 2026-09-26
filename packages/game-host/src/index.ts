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
  type CueKind,
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
} from './audio';
export { browserSaveStorage, createSaveStore, saveChecksum, SAVE_MAX_BYTES, SAVE_SLOTS, type SaveDocument, type SaveRecords, type SaveSettings, type SaveSlot, type SaveStorage, type SaveStore } from './save';
export { counterPoints, levelScore, timeBonus, type ScoreRulesLike } from './score';
export { createFlowController, type FlowConfigLike, type FlowController, type FlowObservation, type FlowScreen, type FlowUiEdges, type LevelEnvironmentLike, type MenuSoundKind, type TitlePanLike, type TitleView } from './flow';
export {
  GAME_HOST_API_VERSION,
  GAME_CONTROL_ACTIONS,
  GAME_HOST_MESSAGES,
  createGameHost,
  composeGameRuntime,
  type GameRuntimeArgs,
  cueEventsForView,
  linkBehaviorModules,
  mapSoundStatus,
  titleAnchor,
  type GameControlAction,
  type GameControlResult,
  type GameControlError,
  type GameHost,
  type GameHostConfig,
  type GameStartOptions,
  type GameStartOutcome,
  type GameHostObservation,
  type GameHostSceneObservation,
  type GameHostSound,
  type HostInputOwner,
  type HostRenderAdapter,
  type ManifestBehaviorRow,
} from './host';
export {
  createHud,
  HUD_PROMPTS,
  type HostDom,
  type HostDomNode,
  type Hud,
  type HudState,
} from './hud';

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
  type ManifestBufferRow,
  type ManifestSceneRow,
  type SceneCatalogIo,
} from './scene-catalog';
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
export { createDebugConsole, consoleWords, parseConsoleLine, DEBUG_CONSOLE_KEY, type DebugConsole, type DebugConsoleDeps } from './debug-console';
export { PlayDebugger, sampleValue, type DebugRequest, type DebugResult, type DebugRuntime } from './play-debug';
export { RelayActionSource } from './relay-input';
export { DEFAULT_PROMPT_INPUT, hudPrompts, keyLabel, padButtonLabel, withKeyBinding, withPadBinding, withSavedBindings, type HudPromptState } from './bindings';
