/**
 * Phase 19.2: the visual-script debugger inside the Play preview.
 *
 * The editor never runs game code: it polls this object over the preview
 * bridge (`tl.debug.request` → `tl.debug.result`) with the behavior it shows,
 * the object whose instance it debugs, its breakpoints and an optional
 * pause / resume / step. Everything is read from the running runtime:
 *
 * - a visual script built for Play (the backend's debug build) answers
 *   `debug(state)` with the nodes it entered in the current step, the last
 *   step each node ran, the last value read along each data wire and its
 *   variables — `runtime.behaviorDebug`;
 * - breakpoints are a step watcher on the runtime: after every executed step
 *   it looks at the watched instances' traces and holds the simulation right
 *   there when a breakpoint node ran (a step boundary: deterministic, the
 *   same step at any frame rate); held, `step` runs exactly one step;
 *   `resume` releases the hold.
 *
 * Values are sampled into short texts (bounded result). Pure (no DOM): the
 * runtime is passed in, so this is unit-testable.
 */

/** The runtime surface the debugger uses (the runtime's phase 19.2 members). */
export interface DebugRuntime {
  readonly debugHeld?: boolean;
  setDebugHold?(hold: boolean): void;
  debugStep?(): void;
  setStepWatcher?(watcher: ((stepIndex: number) => boolean) | null): void;
  behaviorDebug?(filter?: { behaviorId?: string; entityId?: string }): { behaviorId: string; entityId: string; debug: unknown }[];
  getDiagnostics(): { ok: true; diagnostics: { stepIndex: number } } | { ok: false; error: unknown };
}

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

interface RawDebug {
  step?: unknown;
  trace?: unknown;
  dropped?: unknown;
  last?: unknown;
  wires?: unknown;
  locals?: unknown;
  vars?: unknown;
}

const MAX_INSTANCES = 64;
const MAX_TEXT = 48;
/** The result stays well inside the bridge bound (`BRIDGE_DEBUG_RESULT_MAX_BYTES`, 32 KiB). */
const RESULT_BUDGET = 30_000;

/** A value as short text: numbers to 3 decimals, vectors "x, y, z", lists/maps by size and first items. */
export function sampleValue(v: unknown, depth = 0): string {
  let out: string;
  if (v === null || v === undefined) out = 'none';
  else if (typeof v === 'number') out = Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0';
  else if (typeof v === 'boolean') out = v ? 'true' : 'false';
  else if (typeof v === 'string') out = JSON.stringify(v);
  else if (Array.isArray(v)) {
    if (v.length === 3 && v.every((x) => typeof x === 'number')) out = v.map((x) => sampleValue(x, depth + 1)).join(', ');
    else out = depth > 0 ? `[${v.length}]` : `[${v.length}] ${v.slice(0, 4).map((x) => sampleValue(x, depth + 1)).join(', ')}${v.length > 4 ? ', …' : ''}`;
  } else if (v instanceof Map) {
    const entries = [...v.entries()];
    out = depth > 0 ? `{${entries.length}}` : `{${entries.length}} ${entries.slice(0, 3).map(([k, x]) => `${String(k)}: ${sampleValue(x, depth + 1)}`).join(', ')}${entries.length > 3 ? ', …' : ''}`;
  } else out = typeof v;
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT - 1)}…` : out;
}

function texts(o: unknown, limit: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof o !== 'object' || o === null) return out;
  let n = 0;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (n++ >= limit) break;
    out[k.slice(0, 160)] = sampleValue(v);
  }
  return out;
}

export class PlayDebugger {
  private session: { behaviorId: string; entityId: string | null; breakpoints: Set<string> } | null = null;

  constructor(
    private readonly rt: DebugRuntime,
    /** Steps a node stays "recently active" (half a second of steps is a good glance). */
    private readonly recentSteps: number,
  ) {}

  /** The views of the watched behavior's instances (only debug builds answer). */
  private views(behaviorId: string, entityId?: string | null): { entityId: string; debug: RawDebug }[] {
    const all = this.rt.behaviorDebug?.({ behaviorId, ...(entityId !== null && entityId !== undefined ? { entityId } : {}) }) ?? [];
    return all.filter((v) => typeof v.debug === 'object' && v.debug !== null).map((v) => ({ entityId: v.entityId, debug: v.debug as RawDebug }));
  }

  private stepIndex(): number {
    const d = this.rt.getDiagnostics();
    return d.ok ? d.diagnostics.stepIndex : 0;
  }

  /** A breakpoint node in the current traces of the watched instances (the first by instance, then trace order). */
  private currentHit(): { entityId: string; nodeId: string } | null {
    const s = this.session;
    if (s === null || s.breakpoints.size === 0) return null;
    for (const v of this.views(s.behaviorId, s.entityId)) {
      const trace = Array.isArray(v.debug.trace) ? (v.debug.trace as unknown[]) : [];
      for (const id of trace) if (typeof id === 'string' && s.breakpoints.has(id)) return { entityId: v.entityId, nodeId: id };
    }
    return null;
  }

  /** Install or remove the breakpoint watcher for the current session. */
  private arm(): void {
    const s = this.session;
    if (s === null || s.breakpoints.size === 0) {
      this.rt.setStepWatcher?.(null);
      return;
    }
    this.rt.setStepWatcher?.(() => this.currentHit() !== null);
  }

  /** One poll: take the request's settings and command, answer with the watched instance. */
  request(req: DebugRequest): DebugResult {
    const bps = new Set(req.breakpoints);
    const prev = this.session;
    const changed = prev === null || prev.behaviorId !== req.behaviorId || prev.entityId !== (req.entityId ?? null) || prev.breakpoints.size !== bps.size || [...bps].some((b) => !prev.breakpoints.has(b));
    this.session = { behaviorId: req.behaviorId, entityId: req.entityId ?? null, breakpoints: bps };
    if (changed) this.arm();
    if (req.command === 'pause') this.rt.setDebugHold?.(true);
    else if (req.command === 'resume') this.rt.setDebugHold?.(false);
    else if (req.command === 'step') this.rt.debugStep?.();
    return this.result();
  }

  /** The editor stopped debugging (tab closed): no watcher, never left holding. */
  end(): void {
    this.session = null;
    this.rt.setStepWatcher?.(null);
    this.rt.setDebugHold?.(false);
  }

  /** The game-control commands (MCP `tl_game_control`): pause / resume / step. */
  control(command: 'debugPause' | 'debugResume' | 'debugStep'): void {
    if (command === 'debugPause') this.rt.setDebugHold?.(true);
    else if (command === 'debugResume') this.rt.setDebugHold?.(false);
    else this.rt.debugStep?.();
  }

  /** The observation's `debug` block (null when nobody debugs and nothing is held). */
  observation(): { paused: boolean; stepIndex: number; breakpoints: number; hit: { behaviorId: string; entityId: string; nodeId: string } | null } | null {
    const paused = this.rt.debugHeld === true;
    if (this.session === null && !paused) return null;
    const hit = paused ? this.currentHit() : null;
    return { paused, stepIndex: this.stepIndex(), breakpoints: this.session?.breakpoints.size ?? 0, hit: hit !== null && this.session !== null ? { behaviorId: this.session.behaviorId, ...hit } : null };
  }

  private result(): DebugResult {
    const s = this.session!;
    const paused = this.rt.debugHeld === true;
    const all = this.views(s.behaviorId);
    const chosen = s.entityId !== null ? all.find((v) => v.entityId === s.entityId) : all[0];
    const base: DebugResult = {
      paused,
      stepIndex: this.stepIndex(),
      hit: paused ? this.currentHit() : null,
      instances: all.slice(0, MAX_INSTANCES).map((v) => v.entityId),
      debuggable: all.length > 0,
      instance: chosen !== undefined ? this.instanceView(chosen, 256, 128) : null,
    };
    if (chosen !== undefined && JSON.stringify(base).length > RESULT_BUDGET) base.instance = this.instanceView(chosen, 64, 32);
    return base;
  }

  private instanceView(v: { entityId: string; debug: RawDebug }, maxTrace: number, maxWires: number): DebugInstanceView {
    const d = v.debug;
    const step = typeof d.step === 'number' ? d.step : -1;
    const trace = (Array.isArray(d.trace) ? (d.trace as unknown[]) : []).filter((x): x is string => typeof x === 'string');
    const last = typeof d.last === 'object' && d.last !== null ? (d.last as Record<string, unknown>) : {};
    const recent = Object.entries(last)
      .filter(([, k]) => typeof k === 'number' && k >= 0 && step - k < this.recentSteps)
      .map(([id]) => id)
      .slice(0, maxTrace);
    return {
      entityId: v.entityId,
      step,
      trace: trace.slice(0, maxTrace),
      dropped: (typeof d.dropped === 'number' ? d.dropped : 0) + Math.max(0, trace.length - maxTrace),
      recent,
      wires: texts(d.wires, maxWires),
      vars: texts(d.vars, 64),
      locals: texts(d.locals, 64),
    };
  }
}
