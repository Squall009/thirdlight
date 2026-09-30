/**
 * The resource manager: everything a game page loads from its assets (the
 * verified bytes, models, textures (the sky's and the grading LUT's too),
 * animation clips, decoded audio, fonts, UI images, effect models) is held here by its holders
 * and freed when the last one goes, as Godot frees a refcounted `Resource`.
 *
 * - A holder is a string naming who keeps the resource: a loaded scene, a
 *   live entity, a playing sound, a scene being prepared, a material, a
 *   script's handle. `acquire` adds a holder (loading the resource once, the
 *   first time anyone asks); `release` removes it.
 * - A resource whose last holder went is not freed at once: it waits for
 *   `settle`, which the owner runs once the step's scene changes are applied
 *   (the game host after each frame). A transition that unloads one scene
 *   and loads another that uses the same model in the same step releases and
 *   takes it again before the settle, so it is kept, not reloaded.
 * - Each resource is freed when its own count reaches zero. Addressables
 *   frees memory only when a whole bundle unloads; a game page has no bundles
 *   (every file is its own URL), so there is nothing to wait for.
 *
 * Pure: no timers, no I/O. An owner without a frame of its own gives a
 * `schedule` (a microtask or a task) and the settle runs there.
 */

/** The kinds of resources a page loads from assets. */
export type ResourceKind = 'bytes' | 'model' | 'texture' | 'clip' | 'audio' | 'font' | 'image' | 'effect-model';

export const RESOURCE_KINDS: readonly ResourceKind[] = Object.freeze(['bytes', 'model', 'texture', 'clip', 'audio', 'font', 'image', 'effect-model']);

/** The key of one asset version's resource (its bytes, its parsed model or clips). Textures and the other decoded kinds are keyed by asset id. */
export function assetVersionKey(assetId: string, version: number): string {
  return `${assetId}@${version}`;
}

/** A holder name that starts with this is a script's handle (counted for the end-of-play report). */
export const RESOURCE_HANDLE_PREFIX = 'handle:';

/** What a load gives the manager: the value, its resident size and how it is freed. */
export interface LoadedResource<T> {
  readonly value: T;
  /** Resident bytes (CPU and GPU; an estimate where the platform does not say). */
  readonly bytes: number;
  /** Let go of what the value holds (dispose GPU data, close an image, delete a font face). */
  readonly free?: (value: T) => void;
}

/** Resident resources of one kind. */
export interface ResidentCount {
  readonly count: number;
  readonly bytes: number;
}

/** The manager as observers see it. */
export interface ResourceObservation {
  /** Ready resources per kind (only kinds that have some). */
  readonly resident: Readonly<Partial<Record<ResourceKind, ResidentCount>>>;
  /** Loads in flight. */
  readonly loading: number;
  /** Loads completed, frees done and loads failed since creation, per kind (only kinds with any). */
  readonly loads: Readonly<Partial<Record<ResourceKind, number>>>;
  readonly frees: Readonly<Partial<Record<ResourceKind, number>>>;
  readonly failed: number;
  /** Resources whose last holder went, waiting for the settle. */
  readonly waiting: number;
  /** Script handles alive (holders named `handle:…`). */
  readonly handles: number;
}

export interface ResourceManager {
  /**
   * Hold `(kind, key)` for `holder`, loading it the first time anyone asks
   * (later asks share that load). Resolves with the value; rejects when the
   * load fails (the failed entry is forgotten: a later ask loads again).
   * Holding the same resource twice under one holder is one hold.
   */
  acquire<T>(kind: ResourceKind, key: string, holder: string, load: () => Promise<LoadedResource<T>>): Promise<T>;
  /** Add a holder to a resource that is loaded or loading; false when there is none. */
  hold(kind: ResourceKind, key: string, holder: string): boolean;
  /** Let go of one hold (nothing when the holder did not hold it). */
  release(kind: ResourceKind, key: string, holder: string): void;
  /** Let go of everything this holder holds. */
  releaseHolder(holder: string): void;
  /** The value when it is loaded (undefined while loading or absent). */
  peek<T>(kind: ResourceKind, key: string): T | undefined;
  /** Whether the resource is loaded or loading. */
  has(kind: ResourceKind, key: string): boolean;
  /** The holders of one resource (diagnostics, tests). */
  holders(kind: ResourceKind, key: string): readonly string[];
  /** Free what lost its last holder since the last settle and was not taken again; returns how many. */
  settle(): number;
  observe(): ResourceObservation;
  /** Free everything (a page closing); later acquires reject. Idempotent. */
  dispose(): void;
}

export interface ResourceManagerOptions {
  /**
   * Run a settle soon (an owner without a frame loop: a microtask or a task).
   * Absent: the owner calls `settle` itself.
   */
  readonly schedule?: (settle: () => void) => void;
}

interface Entry {
  readonly kind: ResourceKind;
  readonly key: string;
  readonly id: string;
  readonly holders: Set<string>;
  state: 'loading' | 'ready';
  value: unknown;
  bytes: number;
  free: ((value: unknown) => void) | undefined;
  readonly promise: Promise<unknown>;
}

const idOf = (kind: ResourceKind, key: string): string => `${kind}\u0000${key}`;

export function createResourceManager(options: ResourceManagerOptions = {}): ResourceManager {
  const entries = new Map<string, Entry>();
  const byHolder = new Map<string, Set<Entry>>();
  /** Entries whose last holder went (freed at the settle unless taken again). */
  const dropped = new Set<Entry>();
  const loads: Partial<Record<ResourceKind, number>> = {};
  const frees: Partial<Record<ResourceKind, number>> = {};
  let failed = 0;
  let disposed = false;
  let scheduled = false;

  const scheduleSettle = (): void => {
    const schedule = options.schedule;
    if (schedule === undefined || scheduled || disposed) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      settle();
    });
  };

  const addHolder = (e: Entry, holder: string): void => {
    if (e.holders.has(holder)) return;
    e.holders.add(holder);
    let set = byHolder.get(holder);
    if (set === undefined) byHolder.set(holder, (set = new Set()));
    set.add(e);
    dropped.delete(e);
  };

  const dropHolder = (e: Entry, holder: string): void => {
    if (!e.holders.delete(holder)) return;
    const set = byHolder.get(holder);
    if (set !== undefined) {
      set.delete(e);
      if (set.size === 0) byHolder.delete(holder);
    }
    if (e.holders.size === 0) {
      dropped.add(e);
      scheduleSettle();
    }
  };

  const forget = (e: Entry): void => {
    if (entries.get(e.id) === e) entries.delete(e.id);
    dropped.delete(e);
    for (const h of e.holders) {
      const set = byHolder.get(h);
      if (set === undefined) continue;
      set.delete(e);
      if (set.size === 0) byHolder.delete(h);
    }
    e.holders.clear();
  };

  const freeEntry = (e: Entry): void => {
    forget(e);
    frees[e.kind] = (frees[e.kind] ?? 0) + 1;
    try {
      e.free?.(e.value);
    } catch {
      // A failed free leaves nothing the manager can do; the entry is gone either way.
    }
    e.value = undefined;
  };

  function settle(): number {
    let n = 0;
    for (const e of [...dropped]) {
      dropped.delete(e);
      // A load still running is freed when it completes with no holder (below).
      if (e.holders.size > 0 || e.state !== 'ready' || entries.get(e.id) !== e) continue;
      freeEntry(e);
      n += 1;
    }
    return n;
  }

  return {
    acquire<T>(kind: ResourceKind, key: string, holder: string, load: () => Promise<LoadedResource<T>>): Promise<T> {
      if (disposed) return Promise.reject(new Error('the resource manager is closed'));
      const id = idOf(kind, key);
      let e = entries.get(id);
      if (e === undefined) {
        let entry!: Entry;
        // Started now (a read begins in this call); a load that throws is a failed load.
        let started: Promise<LoadedResource<T>>;
        try {
          started = Promise.resolve(load());
        } catch (err) {
          started = Promise.reject(err);
        }
        const promise = started
          .then(
            (r) => {
              if (disposed || entries.get(id) !== entry) {
                // Forgotten meanwhile (the manager closed): nothing will hold it.
                try {
                  r.free?.(r.value);
                } catch {
                  /* best effort */
                }
                throw new Error('the resource manager is closed');
              }
              entry.state = 'ready';
              entry.value = r.value;
              entry.bytes = Number.isFinite(r.bytes) && r.bytes > 0 ? r.bytes : 0;
              entry.free = r.free as ((value: unknown) => void) | undefined;
              loads[kind] = (loads[kind] ?? 0) + 1;
              // Every holder went while it loaded: it waits for the settle like any other.
              if (entry.holders.size === 0) {
                dropped.add(entry);
                scheduleSettle();
              }
              return r.value;
            },
            (err: unknown) => {
              if (entries.get(id) === entry) {
                failed += 1;
                forget(entry);
              }
              throw err;
            },
          );
        // The caller of each acquire sees the failure; the manager itself never leaves one unhandled.
        promise.catch(() => undefined);
        entry = { kind, key, id, holders: new Set(), state: 'loading', value: undefined, bytes: 0, free: undefined, promise };
        entries.set(id, entry);
        e = entry;
      }
      addHolder(e, holder);
      return e.promise as Promise<T>;
    },
    hold(kind, key, holder) {
      if (disposed) return false;
      const e = entries.get(idOf(kind, key));
      if (e === undefined) return false;
      addHolder(e, holder);
      return true;
    },
    release(kind, key, holder) {
      const e = entries.get(idOf(kind, key));
      if (e !== undefined) dropHolder(e, holder);
    },
    releaseHolder(holder) {
      const set = byHolder.get(holder);
      if (set === undefined) return;
      for (const e of [...set]) dropHolder(e, holder);
    },
    peek<T>(kind: ResourceKind, key: string): T | undefined {
      const e = entries.get(idOf(kind, key));
      return e !== undefined && e.state === 'ready' ? (e.value as T) : undefined;
    },
    has(kind, key) {
      return entries.has(idOf(kind, key));
    },
    holders(kind, key) {
      return [...(entries.get(idOf(kind, key))?.holders ?? [])];
    },
    settle,
    observe() {
      const resident: Partial<Record<ResourceKind, { count: number; bytes: number }>> = {};
      let loading = 0;
      for (const e of entries.values()) {
        if (e.state !== 'ready') {
          loading += 1;
          continue;
        }
        const r = (resident[e.kind] ??= { count: 0, bytes: 0 });
        r.count += 1;
        r.bytes += e.bytes;
      }
      let handles = 0;
      for (const h of byHolder.keys()) if (h.startsWith(RESOURCE_HANDLE_PREFIX)) handles += 1;
      return { resident, loading, loads: { ...loads }, frees: { ...frees }, failed, waiting: dropped.size, handles };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const e of [...entries.values()]) {
        if (e.state === 'ready') freeEntry(e);
        else forget(e);
      }
      entries.clear();
      byHolder.clear();
      dropped.clear();
    },
  };
}
