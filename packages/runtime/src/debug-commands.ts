/**
 * Phase 23.8: project debug commands - the declarations scripts make with
 * `ctx.debug.command` and the checks a call must pass. Pure (no runtime state).
 */
import { DEBUG_COMMAND_NAME_RE, MAX_COMMAND_ARGS } from './actions';
import type { DebugCommandArgs, DebugCommandArgSpec, DebugCommandOptions, DebugCommandSpec } from './types';

/** Phase 23.8: engine limits of debug commands (per game; queued calls; the applied log kept). */
export const MAX_DEBUG_COMMANDS = 32;
export const MAX_DEBUG_QUEUE = 16;
export const MAX_DEBUG_APPLIED = 16;
export const MAX_DEBUG_DESCRIPTION = 120;
export const NO_DEBUG_CALLS: readonly DebugCommandArgs[] = Object.freeze([]);

/** Phase 23.8: a script's bad `ctx.debug.command` call (the behavior host turns it into a module error). */
export class DebugCallError extends Error {
  readonly reason: 'behavior_debug_invalid' | 'behavior_debug_limit';
  constructor(reason: DebugCallError['reason'], message: string) {
    super(message);
    this.name = 'DebugCallError';
    this.reason = reason;
  }
}

/** Phase 23.8: a declaration's normalized spec (throws `DebugCallError` on a bad shape). */
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

/** Phase 23.8: why a call does not match its command's declaration (null: it does). */
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
