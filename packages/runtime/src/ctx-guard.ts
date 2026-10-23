/**
 * A script's `ctx` works only while one of its hooks runs.
 *
 * Hooks are synchronous by contract, but a script can still keep a `ctx`
 * past its hook: an `async` hook's code after an `await`, a promise
 * callback, a timer. That code runs when the JavaScript job queue drains,
 * which is after the runtime's whole batch of steps on the page and at a
 * different point in the simulation worker, so anything it did would land
 * in whatever step happened to be next: the same game would play
 * differently on the page and in the worker, and a script switched off for
 * being async would keep acting. So every function reachable from a
 * script's `ctx` (its own `emit` and `log`, and every engine control:
 * `ctx.audio`, `ctx.spawn`, handles a call returns, …) is called through a
 * facade that refuses the call when no hook is running: it throws, which
 * ends the late code, and the script's module logs it once.
 *
 * The facades are made once per control object (and once per `ctx` getter),
 * so a call costs one counter check and the call itself; a method's results
 * are looked at once to learn whether they carry functions (a handle) or
 * are plain data, which then passes through untouched.
 *
 * Reading a plain value (`ctx.stepIndex`, a field of a result) is not a
 * call and is not refused: it changes nothing in the game.
 */

/** Hooks running now (any runtime in this thread; hooks never nest, but a count is safe). */
let running = 0;

/** A hook starts: its `ctx` (and every other script's) may be used until `hookEnded`. */
export function hookStarted(): void {
  running += 1;
}

/** A hook returned or threw. */
export function hookEnded(): void {
  running -= 1;
}

/** Objects scripts get as plain data (never a facade). */
function isData(v: object): boolean {
  return Array.isArray(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer;
}

/** The object (or something it holds, two levels down) has a function or an accessor a script could call. */
function hasCalls(v: unknown, depth = 0): boolean {
  if (typeof v === 'function') return true;
  if (typeof v !== 'object' || v === null || isData(v) || depth > 2) return false;
  for (let p: object | null = v; p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(p, k)!;
      if (d.get !== undefined || d.set !== undefined || typeof d.value === 'function') return true;
      if (typeof d.value === 'object' && d.value !== null && hasCalls(d.value, depth + 1)) return true;
    }
  }
  return false;
}

export interface CtxGuard {
  /** The script's view of a `ctx` value: a facade when it has functions, else the value itself. */
  guard<T>(value: T, path: string): T;
  /**
   * A `ctx` getter's view: one facade for every value the getter returns (calls
   * go to its current value), or the current value itself when it is plain data.
   */
  live<T>(get: () => T, path: string): () => T;
}

/** How a script fixes work it meant to do after its hook (said in the Problems line of an async hook or a late ctx call). */
export const CTX_LATER_FIX = 'To fix it, keep work for later in `state` and act on it in a later step.';

/**
 * The facades of one script module. `late(path)` makes the error a refused
 * call throws (the module logs it once); `path` names the call (`ctx.audio.play`).
 */
export function createCtxGuard(late: (path: string) => Error): CtxGuard {
  const facades = new WeakMap<object, unknown>();

  /** A function that runs only inside a hook; `self` is the object it belongs to (absent: the caller's `this`). */
  const guardFn = (fn: (...args: unknown[]) => unknown, self: unknown, path: string): ((...args: unknown[]) => unknown) => {
    // 0: no object result seen yet, 1: its results are plain data, 2: they carry functions (handles).
    let results = 0;
    const resultPath = `${path}()`;
    return function guarded(this: unknown, ...args: unknown[]): unknown {
      if (running === 0) throw late(path);
      const r = fn.apply(self === undefined ? this : self, args);
      if (results === 1 || r === null || (typeof r !== 'object' && typeof r !== 'function')) return r;
      if (results === 0) {
        results = hasCalls(r) ? 2 : 1;
        if (results === 1) return r;
      }
      return guard(r, resultPath);
    };
  };

  /** A facade over `source()`'s members: the object at hand (`fixed`), or a getter's current value. */
  const facadeOf = (shape: object, source: () => Record<string, unknown>, fixed: boolean, path: string): object => {
    const out: PropertyDescriptorMap = Object.create(null) as PropertyDescriptorMap;
    for (let p: object | null = shape; p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k === 'constructor' || k in out) continue;
        const d = Object.getOwnPropertyDescriptor(p, k)!;
        const sub = `${path}.${k}`;
        if (typeof d.value === 'function') {
          // A method of a fixed object is wrapped once; a live value's is looked up at the call.
          const fn = fixed
            ? guardFn(d.value as (...args: unknown[]) => unknown, shape, sub)
            : guardFn(function (this: unknown, ...args: unknown[]): unknown {
                const cur = source();
                return (cur[k] as (...a: unknown[]) => unknown).apply(cur, args);
              }, undefined, sub);
          out[k] = { value: fn, enumerable: d.enumerable === true };
        } else if (d.set !== undefined) {
          const get = d.get;
          const set = d.set;
          out[k] = {
            ...(get !== undefined ? { get: () => guard(get.call(source()), sub) } : {}),
            set: (x: unknown) => {
              if (running === 0) throw late(sub);
              set.call(source(), x);
            },
            enumerable: d.enumerable === true,
          };
        } else {
          out[k] = { get: () => guard(source()[k], sub), enumerable: d.enumerable === true };
        }
      }
    }
    return Object.freeze(Object.defineProperties({}, out));
  };

  const guard = <T>(value: T, path: string): T => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    const v = value as unknown as object;
    const known = facades.get(v);
    if (known !== undefined) return known as T;
    const out = typeof v === 'function' ? guardFn(v as (...args: unknown[]) => unknown, undefined, path) : hasCalls(v) ? facadeOf(v, () => v as Record<string, unknown>, true, path) : v;
    facades.set(v, out);
    return out as T;
  };

  const live = <T>(get: () => T, path: string): (() => T) => {
    // Decided at the first object value: a facade forwarding to the current value, or the value itself.
    let facade: unknown = null;
    let plain = false;
    return () => {
      if (facade !== null) return facade as T;
      const v = get();
      if (typeof v === 'function') return guard(v, path);
      if (plain || v === null || typeof v !== 'object') return v;
      if (!hasCalls(v)) {
        plain = true;
        return v;
      }
      facade = facadeOf(v, () => get() as unknown as Record<string, unknown>, false, path);
      return facade as T;
    };
  };

  return { guard, live };
}
