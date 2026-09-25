/**
 * Phase 19.2: the visual-script debugger's bridge shapes as the editor UI sees
 * them (`tl.debug.request` → `tl.debug.result`). The debugger itself runs
 * where the simulation runs — since phase 22.0 in the game host
 * (`@thirdlight/game-host` `PlayDebugger`, in the page or in the simulation
 * worker); the editor UI never runs game code and may not import the game
 * host, so it keeps these structural types (the same shapes).
 */

export interface DebugRequest {
  behaviorId: string;
  entityId?: string;
  breakpoints: readonly string[];
  command?: 'pause' | 'resume' | 'step';
}

/** One instance as the debugger shows it. */
export interface DebugInstanceView {
  entityId: string;
  /** The step its trace belongs to. */
  step: number;
  /** The nodes it entered in that step, in order (bounded; `dropped` more were only counted). */
  trace: string[];
  dropped: number;
  /** Nodes that ran within the last `recentSteps` steps (the "active" highlight while running). */
  recent: string[];
  /** The last value read along each data wire (edge id, `fn:<id>/<edge>` in a function), as short text. */
  wires: Record<string, string>;
  /** Per-object variables (public and private) and the last value of each local. */
  vars: Record<string, string>;
  locals: Record<string, string>;
}

export interface DebugResult {
  paused: boolean;
  stepIndex: number;
  /** While paused: a breakpoint node that ran in the held step (and on which object), else null. */
  hit: { entityId: string; nodeId: string } | null;
  /** The objects running this behavior as a debug build (at most 64). */
  instances: string[];
  /** false: no instance answers (not a visual script, or Play runs a build without debugging — e.g. unpublished graph edits). */
  debuggable: boolean;
  instance: DebugInstanceView | null;
}
