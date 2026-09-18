/**
 * Deep isolation for the public API boundary (2026-09-18 review, R10).
 *
 * The workspace publishes authoritative in-memory state — scene entities,
 * the manifest, retry-record results, history change data, validation
 * details — inside query and mutation results. A returned reference that
 * aliases that state is a second mutation path next to `runCommand`
 * (the contract's single mutation path, commands.md §6.1): the R10 probes
 * showed a caller rewriting `queryEntity(...).entity.name` or an ack's
 * `history.undoDepth` corrupting the durable state.
 *
 * Chosen isolation (R10 repair): a DEEP FREEZE at the public boundary,
 * not a deep copy. Queries are the hot path (immediate in-memory reads,
 * workspace.md §5.3); a boundary copy would re-allocate up to 1024
 * entities on every query, while a freeze touches each shared object
 * once (the first export) and every later export/ack/replay is an O(1)
 * `Object.isFrozen` skip per already-frozen node. The freeze is
 * transparent to consumers: read access, comparison, `JSON.stringify`
 * and `structuredClone` are unaffected; a write attempt is a silent
 * no-op (sloppy mode) or a `TypeError` (strict mode) — either way the
 * authoritative state is untouched.
 *
 * Freezing published snapshots is safe for the mutation path because the
 * commands layer is pure: `applyMutation` / `executeUndo` / `executeRedo`
 * build new scene/history objects and never mutate their inputs (stored
 * inverse/forward values are read and deep-cloned on re-application), so
 * each mutation operates on a fresh object graph.
 *
 * Non-plain objects (e.g. an `Error` instance with attached diagnostics)
 * are frozen shallowly at the object level plus their own enumerable
 * fields — `Error` internals (message/stack) need no deeper treatment
 * and an `Error` is never the authoritative state itself.
 */

/**
 * Recursively freeze a value (idempotent; already-frozen subtrees are
 * skipped). Primitives pass through; plain objects and arrays are frozen
 * after their own enumerable values; any other object (Error, typed
 * array, class instance) is frozen after its own enumerable fields.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  const obj = value as object as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  Object.freeze(value);
  return value;
}