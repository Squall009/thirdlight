/**
 * The behavior host's error types and the helpers that read a thrown script
 * error: the visual-script node it came from, where in the compiled script
 * it was thrown, and its message clipped for diagnostics. Shared by the host
 * and the code that runs a script's hooks.
 */
import { clipMessage } from './errors';

/**
 * A behavior-host failure. Behavior-host failures are `config_invalid`
 * (prepare/instantiate), `module_error` (step/frozen-state) or
 * `transform_owner_forbidden` (ownership) with the contract's exact reasons.
 */
export class BehaviorHostError extends Error {
  readonly code: 'config_invalid' | 'module_error' | 'transform_owner_forbidden';
  readonly reason: string;
  readonly detail?: string;
  /** The visual-script node that was running (see `graphNodeIdOf`). */
  nodeId?: string;
  /** Where in the project's compiled modules the error came from (see `compiledFramesOf`). */
  frames?: CompiledFrame[];
  constructor(
    code: BehaviorHostError['code'],
    reason: string,
    message: string,
    detail?: string,
  ) {
    super(clipMessage(message));
    this.name = 'BehaviorHostError';
    this.code = code;
    this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}

// A node inside a function is `fn:<functionId>/<nodeId>` or `lib:<graphId>/<nodeId>`.
const GRAPH_NODE_ID_RE = /^(?:(?:fn|lib):[A-Za-z0-9_-]{1,64}\/)?[A-Za-z0-9_-]{1,64}$/;
export const GRAPH_DETAIL_RE = /^[a-z_]{1,32}$/;

/**
 * The visual-script node an error came from. Code generated from
 * a behavior graph tags every error thrown while a node runs with the node's
 * id (`nodeId`); the runtime copies it into the script error (diagnostics,
 * Play) so the failure points at the node. Any other error has none.
 */
export function graphNodeIdOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const id = (e as { nodeId?: unknown }).nodeId;
  return typeof id === 'string' && GRAPH_NODE_ID_RE.test(id) ? id : undefined;
}

/** One position in a project's compiled script module (`behaviors/<digest>.js` or `libraries/<digest>.js`). */
export interface CompiledFrame {
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

const COMPILED_FRAME_RE = /((?:behaviors|libraries)\/[0-9a-f]{64}\.js):(\d+):(\d+)/g;

/**
 * The project-module positions in an error's stack, innermost
 * first (at most `max`; engine frames skipped). The browsers' stack formats
 * all end a frame with `<url>:<line>:<column>`, and a compiled script is
 * always loaded from a digest-named file, so only those frames match. The
 * Play backend maps them to the source files with the build's source maps.
 * Never part of the simulation state (diagnostics only).
 */
export function compiledFramesOf(e: unknown, max = 4): CompiledFrame[] {
  if (typeof e !== 'object' || e === null) return [];
  const carried = (e as { frames?: unknown }).frames;
  if (Array.isArray(carried)) return (carried as CompiledFrame[]).slice(0, max);
  let stack: unknown;
  try {
    stack = (e as { stack?: unknown }).stack;
  } catch {
    return [];
  }
  if (typeof stack !== 'string') return [];
  const out: CompiledFrame[] = [];
  for (const m of stack.matchAll(COMPILED_FRAME_RE)) {
    out.push({ file: m[1] as string, line: Number(m[2]), column: Number(m[3]) });
    if (out.length >= max) break;
  }
  return out;
}

/** A host error that keeps the script frames of the error it wraps. */
export function withFrames(err: BehaviorHostError, cause: unknown): BehaviorHostError {
  const frames = compiledFramesOf(cause);
  if (frames.length > 0) err.frames = frames;
  return err;
}

/** A write to the frozen `prepare` result (`behavior_state_shared`). */
export class FrozenPreparedError extends Error {
  constructor(message: string) {
    super(clipMessage(message));
    this.name = 'FrozenPreparedError';
  }
}

export function isThenable(v: unknown): boolean {
  return (
    (typeof v === 'object' && v !== null) || typeof v === 'function'
  ) && typeof (v as { then?: unknown }).then === 'function';
}

/**
 * The per-instance intent cap marker. The runtime maps it to
 * `module_error`/`behavior_intent_limit`/`per_instance`; it is thrown before
 * `ctx.emit` so no over-limit intent is ever committed.
 */
export class BehaviorHostIntentLimit extends Error {
  readonly code = 'module_error';
  readonly reason = 'behavior_intent_limit';
  readonly detail = 'per_instance';
  constructor(entityId: string) {
    super(clipMessage(`behavior instance "${entityId}" exceeded the per-instance intent bound`));
    this.name = 'BehaviorHostIntentLimit';
  }
}

/** An error's message, clipped for diagnostics. */
export function messageOf(e: unknown): string {
  // Duck-typed: an artifact executed in another realm (the Node `vm` test host)
  // throws an Error that is not `instanceof` this realm's Error.
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
    const m = (e as { message: string }).message;
    if (m !== '') return clipMessage(m);
  }
  if (e instanceof Error) return clipMessage(e.message !== '' ? e.message : 'Error');
  try {
    const s = JSON.stringify(e);
    if (typeof s === 'string' && s.length > 0) return clipMessage(s);
  } catch {
    /* non-serializable */
  }
  return clipMessage(String(e));
}
