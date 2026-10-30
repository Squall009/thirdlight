/**
 * Object shape checks and deep freezing for JSON-like data.
 *
 * The variants are kept apart on purpose: each one is what its callers were
 * written and tested against, and they differ on inputs that do occur
 * (class instances, frozen parents over unfrozen children, typed arrays).
 */

/** A non-null object that is not an array: what a JSON object parses to (class instances pass too). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A non-array object whose prototype is `Object.prototype` or `null`: a
 * literal or parsed JSON object, never a class instance (a `Map`, a `Date`,
 * an `Error`). The command and workspace validators use it so a non-JSON
 * value cannot pass as a request body.
 */
export function isPlainObjectStrict(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Freezes a value and everything it holds through its own enumerable keys.
 * An already-frozen object is taken as frozen all the way down and skipped,
 * which also makes it safe on shared subtrees.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Like `deepFreeze`, but walks into already-frozen objects too, so a frozen
 * wrapper around unfrozen data still ends up frozen throughout.
 */
export function deepFreezeAll<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreezeAll(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Like `deepFreeze`, but passes typed arrays and other ArrayBuffer views
 * through unfrozen: `Object.freeze` throws on a view with elements, and the
 * workspace hands out blob bytes as fresh views per read.
 */
export function deepFreezeExceptViews<T>(value: T): T {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) return value;
  for (const v of Object.values(value)) deepFreezeExceptViews(v);
  Object.freeze(value);
  return value;
}
