/**
 * Phase 22.0: one surface for what the page asks of the simulation beyond the
 * synchronous `Runtime` reads — script property values, the visual-script
 * debugger, fresh diagnostics, the MCP input exercise and physics queries —
 * the same in both threading modes. In single-thread mode the answers come
 * from the page's runtime right away; in worker mode they are asked of the
 * worker (sim-remote.ts) and arrive with its next message.
 */
import type { Runtime } from '@thirdlight/runtime';
import { PlayDebugger, type DebugRequest } from './play-debug';
import type { RelayActionSource } from './relay-input';
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
  beginInputTest(frames: readonly { stepOffset: number; moveX: number; jump: string }[], onComplete: (from: number, to: number) => void): boolean;
  readonly inputTestActive: boolean;
  /** Rays against the level's colliders (the character excluded), as the physics port answers them. */
  raycast(rays: readonly SimRay[]): Promise<({ distance: number } | null)[]>;
  overlap(shape: unknown, at: { x: number; y: number }): Promise<string[]>;
}

interface PhysicsQueries {
  raycast?(origin: { x: number; y: number }, dir: { x: number; y: number }, maxDistance: number): { distance: number } | null;
  overlap?(shape: unknown, center: { x: number; y: number }): string[];
}

/** The single-thread surface over the page's own runtime. */
export function createLocalSimAccess(opts: { runtime: Runtime; relay?: RelayActionSource; physics?: PhysicsQueries; stepHz: number }): SimAccess {
  const rt = opts.runtime;
  let debug: PlayDebugger | null = null;
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
    beginInputTest: (frames, onComplete) => {
      if (opts.relay === undefined) return false;
      const d = rt.getDiagnostics();
      return opts.relay.beginTest(frames, (d.ok ? d.diagnostics.stepIndex : 0) + 1, onComplete);
    },
    get inputTestActive() {
      return opts.relay?.testActive === true;
    },
    raycast: (rays) => Promise.resolve(rays.map((r) => opts.physics?.raycast?.(r.origin, r.dir, r.maxDistance) ?? null)),
    overlap: (shape, at) => Promise.resolve(opts.physics?.overlap?.(shape, at) ?? []),
  };
}
