/**
 * Phase-scoped write guard — runtime.md §12.2 (promoted from `platformer.md`
 * §2.2).
 *
 * The runtime passes a write-only `state.curr` during the `transform` phase
 * and a throwing read-only view during `intent`, `controller` and `physics`.
 * `state.prev`, `state.order`, `state.entities` component data and the
 * `StepContext` are read-only in every phase. Every violation throws a
 * `PhaseViolationError`, which the runtime turns into a fail-stop
 * `module_error` (`reason: "phase_violation"`).
 */
import type { SimEntityData, SimState, TransformState } from './types';

/** A phase/ownership violation (module_error, reason `phase_violation`). */
export class PhaseViolationError extends Error {
  readonly reason = 'phase_violation';
  constructor(message: string) {
    super(message);
    this.name = 'PhaseViolationError';
  }
}

/** A second staged move for one entity in one step (reason `duplicate_move`). */
export class DuplicateMoveError extends Error {
  readonly reason = 'duplicate_move';
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateMoveError';
  }
}

function violation(message: string): never {
  throw new PhaseViolationError(message);
}

/** A transform proxy whose writes throw (used for non-writable reads). */
function protectedTransform(t: TransformState): TransformState {
  const protectArray = (arr: readonly number[]): number[] =>
    new Proxy(arr as number[], {
      set: () => violation('writing state.curr outside the transform phase is not allowed'),
      defineProperty: () => violation('writing state.curr outside the transform phase is not allowed'),
      deleteProperty: () => violation('writing state.curr outside the transform phase is not allowed'),
    });
  return new Proxy(t, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      return Array.isArray(v) ? protectArray(v as readonly number[]) : v;
    },
    set: () => violation('writing state.curr outside the transform phase is not allowed'),
    defineProperty: () => violation('writing state.curr outside the transform phase is not allowed'),
    deleteProperty: () => violation('writing state.curr outside the transform phase is not allowed'),
  });
}

/**
 * A `Map`-shaped view of the live transforms. `writable === null` makes every
 * transform read-only; otherwise only IDs in `writable` are mutable.
 */
function guardedTransformMap(
  inner: Map<string, TransformState>,
  writable: ReadonlySet<string> | null,
): Map<string, TransformState> {
  const get = (id: string): TransformState | undefined => {
    const t = inner.get(id);
    if (t === undefined) return undefined;
    if (writable !== null && writable.has(id)) return t;
    return protectedTransform(t);
  };
  const view: Record<string | symbol, unknown> = {
    get size(): number {
      return inner.size;
    },
    get,
    has: (id: string): boolean => inner.has(id),
    keys: (): IterableIterator<string> => inner.keys(),
    values: (): IterableIterator<TransformState> =>
      [...inner.keys()].map((id) => get(id)!).values(),
    entries: (): IterableIterator<[string, TransformState]> =>
      [...inner.keys()].map((id) => [id, get(id)!] as [string, TransformState]).values(),
    forEach: (cb: (value: TransformState, key: string, map: Map<string, TransformState>) => void): void => {
      for (const id of inner.keys()) cb(get(id)!, id, view as unknown as Map<string, TransformState>);
    },
    set: () => violation('mutating state.curr is not allowed in this phase'),
    delete: () => violation('mutating state.curr is not allowed in this phase'),
    clear: () => violation('mutating state.curr is not allowed in this phase'),
  };
  view[Symbol.iterator] = view['entries'];
  view[Symbol.toStringTag] = 'Map';
  return view as unknown as Map<string, TransformState>;
}

/** A read-only `Map` view over any values (used for `state.entities`). */
function readOnlyMapView<V>(inner: ReadonlyMap<string, V>): ReadonlyMap<string, V> {
  const view: Record<string | symbol, unknown> = {
    get size(): number {
      return inner.size;
    },
    get: (id: string): V | undefined => inner.get(id),
    has: (id: string): boolean => inner.has(id),
    keys: (): IterableIterator<string> => inner.keys(),
    values: (): IterableIterator<V> => inner.values(),
    entries: (): IterableIterator<[string, V]> => inner.entries(),
    forEach: (cb: (value: V, key: string, map: ReadonlyMap<string, V>) => void): void => {
      for (const [k, v] of inner) cb(v, k, view as unknown as ReadonlyMap<string, V>);
    },
    set: () => violation('state.entities is read-only'),
    delete: () => violation('state.entities is read-only'),
    clear: () => violation('state.entities is read-only'),
  };
  view[Symbol.iterator] = view['entries'];
  view[Symbol.toStringTag] = 'Map';
  return view as unknown as ReadonlyMap<string, V>;
}

/**
 * The `SimState` handed to a phase-`transform` module: only the entities that
 * module owns are mutable, and only through `curr`.
 */
export function phaseScopedState(args: {
  order: readonly string[];
  entities: ReadonlyMap<string, SimEntityData>;
  stepIndex: number;
  simTime: number;
  prev: Map<string, TransformState>;
  curr: Map<string, TransformState>;
  writableOwners: ReadonlySet<string> | null;
}): SimState {
  const state = {
    order: Object.freeze([...args.order]),
    entities: readOnlyMapView(args.entities),
    stepIndex: args.stepIndex,
    simTime: args.simTime,
    prev: guardedTransformMap(args.prev, null),
    curr: guardedTransformMap(args.curr, args.writableOwners),
  };
  return new Proxy(state as SimState, {
    set: () => violation('the step state is read-only outside state.curr'),
    defineProperty: () => violation('the step state is read-only outside state.curr'),
    deleteProperty: () => violation('the step state is read-only outside state.curr'),
  });
}

/** Freeze a `StepContext` behind a proxy whose writes throw. */
export function frozenContext<T extends object>(ctx: T): T {
  return new Proxy(ctx, {
    set: () => violation('the step context is frozen'),
    defineProperty: () => violation('the step context is frozen'),
    deleteProperty: () => violation('the step context is frozen'),
  });
}
