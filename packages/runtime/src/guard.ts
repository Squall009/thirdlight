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
 *
 * Phase 21.2: the views are made once per module and phase and reused every
 * step (`liveScopedState`), and each guarded transform or array has one
 * guard proxy for its lifetime, so a steady step makes no new views.
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

const CURR_READ_ONLY = 'writing state.curr outside the transform phase is not allowed';

const arrayGuard: ProxyHandler<number[]> = {
  set: () => violation(CURR_READ_ONLY),
  defineProperty: () => violation(CURR_READ_ONLY),
  deleteProperty: () => violation(CURR_READ_ONLY),
};

/** One guard proxy per guarded object while it lives (the runtime overwrites its transforms in place). */
const guardedArrays = new WeakMap<readonly number[], number[]>();
const guardedTransforms = new WeakMap<TransformState, TransformState>();

function protectArray(arr: readonly number[]): number[] {
  let p = guardedArrays.get(arr);
  if (p === undefined) {
    p = new Proxy(arr as number[], arrayGuard);
    guardedArrays.set(arr, p);
  }
  return p;
}

const transformGuard: ProxyHandler<TransformState> = {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver) as unknown;
    return Array.isArray(v) ? protectArray(v as readonly number[]) : v;
  },
  set: () => violation(CURR_READ_ONLY),
  defineProperty: () => violation(CURR_READ_ONLY),
  deleteProperty: () => violation(CURR_READ_ONLY),
};

/** A transform proxy whose writes throw (used for non-writable reads). */
function protectedTransform(t: TransformState): TransformState {
  let p = guardedTransforms.get(t);
  if (p === undefined) {
    p = new Proxy(t, transformGuard);
    guardedTransforms.set(t, p);
  }
  return p;
}

/**
 * A `Map`-shaped view of the live transforms. `writable() === null` makes
 * every transform read-only; otherwise only IDs in `writable()` are mutable.
 * The map and the writable set are read at each call.
 */
function guardedTransformMap(
  source: () => Map<string, TransformState>,
  writable: () => ReadonlySet<string> | null,
): Map<string, TransformState> {
  const get = (id: string): TransformState | undefined => {
    const t = source().get(id);
    if (t === undefined) return undefined;
    const w = writable();
    if (w !== null && w.has(id)) return t;
    return protectedTransform(t);
  };
  const view: Record<string | symbol, unknown> = {
    get size(): number {
      return source().size;
    },
    get,
    has: (id: string): boolean => source().has(id),
    keys: (): IterableIterator<string> => source().keys(),
    values: (): IterableIterator<TransformState> =>
      [...source().keys()].map((id) => get(id)!).values(),
    entries: (): IterableIterator<[string, TransformState]> =>
      [...source().keys()].map((id) => [id, get(id)!] as [string, TransformState]).values(),
    forEach: (cb: (value: TransformState, key: string, map: Map<string, TransformState>) => void): void => {
      for (const id of source().keys()) cb(get(id)!, id, view as unknown as Map<string, TransformState>);
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
function readOnlyMapView<V>(source: () => ReadonlyMap<string, V>): ReadonlyMap<string, V> {
  const view: Record<string | symbol, unknown> = {
    get size(): number {
      return source().size;
    },
    get: (id: string): V | undefined => source().get(id),
    has: (id: string): boolean => source().has(id),
    keys: (): IterableIterator<string> => source().keys(),
    values: (): IterableIterator<V> => source().values(),
    entries: (): IterableIterator<[string, V]> => source().entries(),
    forEach: (cb: (value: V, key: string, map: ReadonlyMap<string, V>) => void): void => {
      for (const [k, v] of source()) cb(v, k, view as unknown as ReadonlyMap<string, V>);
    },
    set: () => violation('state.entities is read-only'),
    delete: () => violation('state.entities is read-only'),
    clear: () => violation('state.entities is read-only'),
  };
  view[Symbol.iterator] = view['entries'];
  view[Symbol.toStringTag] = 'Map';
  return view as unknown as ReadonlyMap<string, V>;
}

const stateGuard: ProxyHandler<SimState> = {
  set: () => violation('the step state is read-only outside state.curr'),
  defineProperty: () => violation('the step state is read-only outside state.curr'),
  deleteProperty: () => violation('the step state is read-only outside state.curr'),
};

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
    entities: readOnlyMapView(() => args.entities),
    stepIndex: args.stepIndex,
    simTime: args.simTime,
    prev: guardedTransformMap(() => args.prev, () => null),
    curr: guardedTransformMap(() => args.curr, () => args.writableOwners),
  };
  return new Proxy(state as SimState, stateGuard);
}

/** Phase 21.2: where a reused state view reads the step's current values. */
export interface LiveStateSource {
  /** A frozen copy of the entity order (the same array while the order is unchanged). */
  order(): readonly string[];
  entities(): ReadonlyMap<string, SimEntityData>;
  stepIndex(): number;
  simTime(): number;
  prev(): Map<string, TransformState>;
  curr(): Map<string, TransformState>;
  /** The module's writable owners in this phase (null: none). */
  writableOwners(): ReadonlySet<string> | null;
}

/**
 * Phase 21.2: a `SimState` made once per module and phase and reused every
 * step — the guards of `phaseScopedState`, reading the current values from
 * `source` at each access.
 */
export function liveScopedState(source: LiveStateSource): SimState {
  const state = Object.defineProperties({} as Record<string, unknown>, {
    order: { get: () => source.order(), enumerable: true },
    entities: { value: readOnlyMapView(() => source.entities()), enumerable: true },
    stepIndex: { get: () => source.stepIndex(), enumerable: true },
    simTime: { get: () => source.simTime(), enumerable: true },
    prev: { value: guardedTransformMap(() => source.prev(), () => null), enumerable: true },
    curr: { value: guardedTransformMap(() => source.curr(), () => source.writableOwners()), enumerable: true },
  });
  return new Proxy(state as unknown as SimState, stateGuard);
}

const contextGuard: ProxyHandler<object> = {
  set: () => violation('the step context is frozen'),
  defineProperty: () => violation('the step context is frozen'),
  deleteProperty: () => violation('the step context is frozen'),
};

/** Freeze a `StepContext` behind a proxy whose writes throw. */
export function frozenContext<T extends object>(ctx: T): T {
  return new Proxy(ctx, contextGuard as ProxyHandler<T>);
}
