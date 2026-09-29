/**
 * Project debug commands - the declarations scripts make with
 * `ctx.debug.command`, the checks a call must pass, and the runtime's
 * command state (`DebugCommands`): what is declared, the calls waiting for
 * the next step, this step's calls and the log of calls run.
 *
 * A call rides on a step's input frame, so a recording replays it. The engine
 * declares `signal` itself: tools and the in-game console emit a signal
 * without a script, and the call is input like any other.
 */
import { DEBUG_COMMAND_NAME_RE, MAX_COMMAND_ARGS, validateDebugCommandCall, type ActionFrame, type DebugCommandCall } from './actions';
import { SIGNAL_DEBUG_COMMAND_NAME } from '@thirdlight/project-model';
import { MAX_SIGNAL_NAME } from './blocks';
import type { DebugCommandArgs, DebugCommandArgSpec, DebugCommandOptions, DebugCommandSpec, DebugCommandState } from './types';

/** Engine limits of debug commands (per game; queued calls; the applied log kept). */
export const MAX_DEBUG_COMMANDS = 32;
export const MAX_DEBUG_QUEUE = 16;
export const MAX_DEBUG_APPLIED = 16;
export const MAX_DEBUG_DESCRIPTION = 120;
export const NO_DEBUG_CALLS: readonly DebugCommandArgs[] = Object.freeze([]);

/** A script's bad `ctx.debug.command` call (the behavior host turns it into a module error). */
export class DebugCallError extends Error {
  readonly reason: 'behavior_debug_invalid' | 'behavior_debug_limit';
  constructor(reason: DebugCallError['reason'], message: string) {
    super(message);
    this.name = 'DebugCallError';
    this.reason = reason;
  }
}

/** A declaration's normalized spec (throws `DebugCallError` on a bad shape). */
export function debugSpecOf(name: string, options: DebugCommandOptions | undefined): DebugCommandSpec {
  if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) throw new DebugCallError('behavior_debug_invalid', `debug command "${name}": options must be { description?, args? }`);
  const description = options?.description ?? '';
  if (typeof description !== 'string' || description.length > MAX_DEBUG_DESCRIPTION) throw new DebugCallError('behavior_debug_invalid', `debug command "${name}": description must be text of at most ${MAX_DEBUG_DESCRIPTION} characters`);
  const raw: unknown = options?.args ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_COMMAND_ARGS) throw new DebugCallError('behavior_debug_invalid', `debug command "${name}": args must be a list of at most ${MAX_COMMAND_ARGS} { name, type, optional? }`);
  const seen = new Set<string>();
  const args: DebugCommandArgSpec[] = raw.map((a: unknown) => {
    const x = a as { name?: unknown; type?: unknown; optional?: unknown };
    if (typeof x !== 'object' || x === null || typeof x.name !== 'string' || !DEBUG_COMMAND_NAME_RE.test(x.name) || seen.has(x.name) || (x.type !== 'number' && x.type !== 'string' && x.type !== 'boolean') || (x.optional !== undefined && typeof x.optional !== 'boolean')) {
      throw new DebugCallError('behavior_debug_invalid', `debug command "${name}": each argument is { name (unique), type: 'number' | 'string' | 'boolean', optional? }`);
    }
    seen.add(x.name);
    return Object.freeze({ name: x.name, type: x.type, ...(x.optional === true ? { optional: true } : {}) });
  });
  return Object.freeze({ name, description, args: Object.freeze(args) });
}

/** Why a call does not match its command's declaration (null: it does). */
export function debugCallProblem(spec: DebugCommandSpec, args: DebugCommandArgs): string | null {
  for (const k of Object.keys(args)) if (!spec.args.some((a) => a.name === k)) return `"${spec.name}" has no argument "${k}"`;
  for (const a of spec.args) {
    const v = args[a.name];
    if (v === undefined) {
      if (a.optional !== true) return `"${spec.name}" needs its argument "${a.name}" (${a.type})`;
      continue;
    }
    if (typeof v !== a.type) return `"${spec.name}": argument "${a.name}" must be a ${a.type}`;
  }
  return null;
}

/**
 * The engine's own debug command: `signal <name>` emits a signal in the step
 * it rides on, where a script's `ctx.signals.emit` in the step before would
 * have; switches, movers, timelines, effects and scripts see it in that step.
 */
export const SIGNAL_DEBUG_COMMAND: DebugCommandSpec = Object.freeze({
  name: SIGNAL_DEBUG_COMMAND_NAME,
  description: 'Emit a signal, as a script\'s ctx.signals.emit does',
  args: Object.freeze([Object.freeze({ name: 'name', type: 'string' as const })]),
});
/** The commands the engine declares in every game (listed before the scripts' ones). */
export const ENGINE_DEBUG_COMMANDS: readonly DebugCommandSpec[] = Object.freeze([SIGNAL_DEBUG_COMMAND]);
const ENGINE_COMMANDS = ENGINE_DEBUG_COMMANDS;

/**
 * Why a checked call cannot run against the declared commands (null: it
 * can) — the same answer on the page and in the simulation worker.
 */
export function debugCallRefusal(registered: readonly DebugCommandSpec[], call: DebugCommandCall): string | null {
  const spec = registered.find((c) => c.name === call.name);
  if (spec === undefined) return `no script declared the debug command "${call.name}"`;
  const problem = debugCallProblem(spec, call.args);
  if (problem !== null || call.name !== SIGNAL_DEBUG_COMMAND.name) return problem;
  const n = call.args['name'];
  return typeof n === 'string' && n.length > 0 && n.length <= MAX_SIGNAL_NAME ? null : `a signal name is 1 to ${MAX_SIGNAL_NAME} characters`;
}

export interface DebugCommandsHost {
  /** Emit a signal now (the engine's `signal` command). */
  emitSignal(name: string): void;
  /** A frame's call was dropped (no such command, or its arguments do not match). */
  dropped(problem: string, stepIndex: number): void;
}

export type DebugQueueResult = { ok: true } | { ok: false; message: string; reason: 'debug_command' | 'pending'; path?: string };

/** The runtime's debug command state (declarations are kept across runs). */
export class DebugCommands {
  private readonly registry = new Map<string, DebugCommandSpec>(ENGINE_COMMANDS.map((c) => [c.name, c]));
  /** Calls queued by the host for the next sampled step. */
  private queue: DebugCommandCall[] = [];
  /** This step's calls by command (from its input frame); null: none. */
  private stepCalls: Map<string, DebugCommandArgs[]> | null = null;
  private readonly applied: { stepIndex: number; name: string; args: DebugCommandArgs }[] = [];
  private revision = 0;
  private cache: DebugCommandState | null = null;

  constructor(private readonly host: DebugCommandsHost) {}

  /**
   * A script's `ctx.debug.command(name, options)`: declares the command (the
   * first declaration wins) and, in the intent phase, returns this step's
   * calls. Throws `DebugCallError` on a bad declaration.
   */
  declare(name: string, options: DebugCommandOptions | undefined, intent: boolean): readonly DebugCommandArgs[] {
    if (typeof name !== 'string' || !DEBUG_COMMAND_NAME_RE.test(name)) throw new DebugCallError('behavior_debug_invalid', 'a debug command name is a letter or _, then up to 31 letters, digits, _ . : -');
    const known = this.registry.get(name);
    if (known === undefined) {
      if (this.registry.size - ENGINE_COMMANDS.length >= MAX_DEBUG_COMMANDS) throw new DebugCallError('behavior_debug_limit', `at most ${MAX_DEBUG_COMMANDS} debug commands per game`);
      this.registry.set(name, debugSpecOf(name, options));
      this.touched();
    } else if (options !== undefined && JSON.stringify(debugSpecOf(name, options)) !== JSON.stringify(known)) {
      const engine = ENGINE_COMMANDS.includes(known) ? ' (by the engine)' : '';
      throw new DebugCallError('behavior_debug_invalid', `debug command "${name}" is already declared${engine} with other options`);
    }
    if (!intent) return NO_DEBUG_CALLS;
    return this.stepCalls?.get(name) ?? NO_DEBUG_CALLS;
  }

  /** Queue a call for the next sampled step (checked against its declaration). */
  enqueue(call: DebugCommandCall): DebugQueueResult {
    const checked = validateDebugCommandCall(call);
    if (!checked.ok) return { ok: false, message: `debug command: ${checked.message}`, reason: 'debug_command', path: `/${checked.field}` };
    const problem = this.callProblem(checked.call);
    if (problem !== null) return { ok: false, message: problem, reason: 'debug_command' };
    if (this.queue.length >= MAX_DEBUG_QUEUE) return { ok: false, message: `at most ${MAX_DEBUG_QUEUE} debug command calls may wait for the next step`, reason: 'pending' };
    this.queue.push(checked.call);
    return { ok: true };
  }

  /** Whether calls wait for the next step. */
  get pending(): boolean {
    return this.queue.length > 0;
  }

  /** Take up to `room` queued calls (they ride on the step's frame). */
  take(room: number): DebugCommandCall[] {
    return this.queue.splice(0, Math.max(0, room));
  }

  /**
   * This step's calls from its frame, by command (in frame order). An engine
   * command runs here; a call no script declared, or whose arguments do not
   * match the declaration, is dropped and reported.
   */
  deliver(frame: ActionFrame): void {
    const commands = frame.commands;
    if (commands === undefined || commands.length === 0) {
      this.stepCalls = null;
      return;
    }
    const byName = new Map<string, DebugCommandArgs[]>();
    for (const c of commands) {
      const problem = this.callProblem(c);
      if (problem !== null) {
        this.host.dropped(problem, frame.stepIndex);
        continue;
      }
      if (c.name === SIGNAL_DEBUG_COMMAND.name) this.host.emitSignal(c.args['name'] as string);
      let list = byName.get(c.name);
      if (list === undefined) byName.set(c.name, (list = []));
      list.push(c.args);
      this.applied.push({ stepIndex: frame.stepIndex, name: c.name, args: c.args });
    }
    if (this.applied.length > MAX_DEBUG_APPLIED) this.applied.splice(0, this.applied.length - MAX_DEBUG_APPLIED);
    this.touched();
    this.stepCalls = byName.size > 0 ? byName : null;
  }

  /** A step without input calls (an input override). */
  clearStep(): void {
    this.stepCalls = null;
  }

  /** The declared commands (the engine's first) and the calls run (newest last). */
  state(): DebugCommandState {
    if (this.cache === null) {
      this.cache = Object.freeze({
        registered: Object.freeze([...this.registry.values()]),
        applied: Object.freeze(this.applied.map((a) => Object.freeze({ ...a }))),
        revision: this.revision,
      });
    }
    return this.cache;
  }

  private callProblem(call: DebugCommandCall): string | null {
    return debugCallRefusal(this.state().registered, call);
  }

  private touched(): void {
    this.revision += 1;
    this.cache = null;
  }
}
