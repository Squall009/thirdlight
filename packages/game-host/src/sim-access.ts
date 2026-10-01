/**
 * One surface for what the page asks of the simulation beyond the
 * synchronous `Runtime` reads — script property values, the visual-script
 * debugger, fresh diagnostics, the MCP input exercise and physics queries —
 * the same in both threading modes. In single-thread mode the answers come
 * from the page's runtime right away; in worker mode they are asked of the
 * worker (sim-remote.ts) and arrive with its next message.
 */
import type { ActionFrame, Runtime } from '@thirdlight/runtime';
import { PlayDebugger, type DebugRequest } from './play-debug';
import type { RelayActionSource, RelayEffect, RelayTestFrame } from './relay-input';
import { hitUiTargets, type UiHitTarget } from './ui-hit';
import { RunProbe, runNowOf, type RunDigests, type RunNow } from './run-probe';
import type { ThreadingMode } from './threading';

export interface SimRay {
  readonly origin: { x: number; y: number };
  readonly dir: { x: number; y: number };
  readonly maxDistance: number;
}

export interface SimAccess {
  readonly mode: ThreadingMode;
  /** How the worker's transforms reach the page (null in single-thread mode). */
  readonly transport: 'shared' | 'message' | null;
  /** The runtime the host presents (the real one, or the worker's mirror). */
  readonly runtime: Runtime;
  behaviorProperties(entityId: string): Promise<unknown[]>;
  debugRequest(request: DebugRequest): Promise<unknown>;
  debugControl(command: 'debugPause' | 'debugResume' | 'debugStep'): Promise<void>;
  /** The observation's debugger block (null when nobody debugs and nothing is held). */
  debugObservation(): Promise<unknown>;
  diagnostics(): Promise<ReturnType<Runtime['getDiagnostics']>>;
  /** Start an exclusive input exercise (per-step frames from the next step); false while one runs. */
  /** Frames carry named actions and the pointer (version 2: no fixed move/jump channels). */
  /** `hold` holds the game right after the last step (until the next exercise); an exercise on a game held so starts at exactly the next step. */
  beginInputTest(frames: readonly RelayTestFrame[], onComplete: (from: number, to: number) => void, options?: { readonly restart?: boolean; readonly hold?: boolean }): boolean;
  /** The run digest now and after the last exercise's last step (null: nothing to observe). */
  runDigests(): Promise<RunDigests | null>;
  /** Which run the simulation is in (0: the one the play started with; one more per restart applied) and its step now. */
  runNow(): Promise<RunNow | null>;
  readonly inputTestActive: boolean;
  /**
   * The page's UI for the input exercise — its hit targets (a
   * relayed pointer is tested against them) and where the relay's UI edges
   * and clicks go (the page applies them at its next frame).
   */
  setRelayPage(page: RelayPage | null): void;
  /** A page frame in which the game is paused while an exercise runs (it takes one step's place: UI edges and clicks still apply). */
  relayIdle(): void;
  /** Rays against the scene's colliders (the character excluded), as the physics port answers them. */
  raycast(rays: readonly SimRay[]): Promise<({ distance: number } | null)[]>;
  overlap(shape: unknown, at: { x: number; y: number }): Promise<string[]>;
}

/** The page side of the input exercise (its UI). */
export interface RelayPage {
  targets(): readonly UiHitTarget[];
  effect(e: RelayEffect): void;
}

interface PhysicsQueries {
  raycast?(origin: { x: number; y: number }, dir: { x: number; y: number }, maxDistance: number): { distance: number } | null;
  overlap?(shape: unknown, center: { x: number; y: number }): string[];
}

/** The single-thread surface over the page's own runtime. */
export function createLocalSimAccess(opts: { runtime: Runtime; relay?: RelayActionSource; physics?: PhysicsQueries; stepHz: number }): SimAccess {
  const rt = opts.runtime;
  let debug: PlayDebugger | null = null;
  const probe = new RunProbe(rt);
  const debuggerOf = (): PlayDebugger => (debug ??= new PlayDebugger(rt, Math.max(1, Math.round(opts.stepHz / 2))));
  return {
    mode: 'single',
    transport: null,
    runtime: rt,
    behaviorProperties: (entityId) => Promise.resolve((rt as { behaviorProperties?: (id: string) => unknown[] }).behaviorProperties?.(entityId) ?? []),
    debugRequest: (request) => Promise.resolve(debuggerOf().request(request)),
    debugControl: (command) => {
      debuggerOf().control(command);
      return Promise.resolve();
    },
    debugObservation: () => Promise.resolve((debug ?? (rt.debugHeld === true ? debuggerOf() : null))?.observation() ?? null),
    diagnostics: () => Promise.resolve(rt.getDiagnostics()),
    beginInputTest: (frames, onComplete, options) => {
      if (opts.relay === undefined) return false;
      if (opts.relay.testActive) return false;
      const restart = options?.restart === true;
      const hold = options?.hold === true;
      // A game held by the last exercise starts this one at exactly the next step.
      const held = probe.held;
      probe.release();
      const d = rt.getDiagnostics();
      return opts.relay.beginTest(
        frames,
        (d.ok ? d.diagnostics.stepIndex : 0) + (held ? 0 : 1),
        (from, to) => {
          probe.exerciseDone(from, to, restart, hold);
          onComplete(from, to);
        },
        restart,
      );
    },
    runDigests: () => Promise.resolve(probe.read()),
    runNow: () => Promise.resolve(runNowOf(rt)),
    get inputTestActive() {
      return opts.relay?.testActive === true;
    },
    relayIdle: () => opts.relay?.idle(),
    setRelayPage: (page) => {
      opts.relay?.setUiHit(page === null ? null : (x, y) => hitUiTargets(page.targets(), x, y)?.key ?? null);
      opts.relay?.setEffectSink(page === null ? null : (e) => page.effect(e));
    },
    raycast: (rays) => Promise.resolve(rays.map((r) => opts.physics?.raycast?.(r.origin, r.dir, r.maxDistance) ?? null)),
    overlap: (shape, at) => Promise.resolve(opts.physics?.overlap?.(shape, at) ?? []),
  };
}
