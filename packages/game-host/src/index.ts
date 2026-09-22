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
} from './audio';
export {
  GAME_HOST_API_VERSION,
  GAME_CONTROL_ACTIONS,
  GAME_HOST_MESSAGES,
  createGameHost,
  cueEventsForView,
  linkBehaviorModules,
  mapSoundStatus,
  type GameControlAction,
  type GameControlResult,
  type GameControlError,
  type GameHost,
  type GameHostConfig,
  type GameHostObservation,
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
}