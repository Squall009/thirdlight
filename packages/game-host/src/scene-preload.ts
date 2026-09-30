/**
 * Scene loads that never show an empty world.
 *
 * A game page reads a scene when the game asks for it (`load`, the host's
 * `loadScene`). Handing the scene's entities to the simulation as soon as its
 * file is read, and reading and parsing its model files, textures and
 * instance buffers afterwards, on the frames after it attached, would make a
 * transition show the world without them (or, with the old scenes unloaded
 * first, nothing).
 *
 * The preloader puts a preparation step between the read and the answer: the
 * render side reads and parses what the scene draws (`prepare`, the adapter's
 * `prepareScene` and the page's asset reads) and only then are the entities
 * handed to the simulation. The simulation swaps a transition's scenes in one
 * step (see the runtime's transitions), so the next drawn frame shows the new
 * world whole.
 *
 * It also reads ahead (`want`): the host names the scenes a game is likely to
 * load next (the targets of the loaded scene transitions, the next entry of
 * the shell's scene list); those are read and prepared in the background, at
 * most `max` at a time, and let go when they are no longer named. A load of a
 * scene read ahead answers as soon as its preparation is done.
 */
import type { LoadedSceneBatch } from '@thirdlight/runtime';

import { startSceneAssets, type DeclaredAssetRow, type StartAssetSources, type VerifiedAssetReader } from './asset-reader';

type SceneEntities = LoadedSceneBatch['entities'];

/** The render side's preparation of one scene (`ready` never rejects; `release` lets go of what it holds). */
export interface ScenePreparation {
  readonly ready: Promise<void>;
  release(): void;
}

export interface ScenePreloadHooks {
  /** The game asked for a scene (`preloaded`: it was read ahead). */
  requested?(sceneId: string, preloaded: boolean): void;
  /** Its file was read and checked. */
  read?(sceneId: string, entities: number): void;
  /** Its assets were prepared (the entities go to the simulation now). */
  prepared?(sceneId: string, entities: number): void;
  failed?(sceneId: string, message: string): void;
}

export interface ScenePreloader {
  /** The host's scene loader: the entities once read and prepared (a scene read ahead: once its preparation is done). */
  load(sceneId: string): Promise<SceneEntities>;
  /**
   * The scenes worth having ready now and every scene's status: named scenes
   * that are not loaded are read and prepared (the first `max`); a scene read
   * ahead that is no longer named and not loading is let go.
   */
  want(sceneIds: readonly string[], status: Readonly<Record<string, string>>): void;
  /** The render side's preparation (the page sets it once its adapter exists; null: none). */
  setPrepare(prepare: ((sceneId: string, entities: SceneEntities) => ScenePreparation | null) | null): void;
  /** What is read ahead (diagnostics): being prepared, and ready. */
  view(): { readonly preloading: readonly string[]; readonly preloaded: readonly string[] };
  dispose(): void;
}

/** Scenes read ahead at once (each holds its models and textures in memory). */
export const SCENES_READ_AHEAD = 4;
/** The longest a load waits for its preparation before the entities go anyway (their assets then stream in). */
export const SCENE_PREPARE_WAIT_MS = 30_000;

interface Entry {
  readonly entities: Promise<SceneEntities>;
  /** Resolves once the preparation is done (or there is none, or it timed out); never rejects. */
  prepared: Promise<void> | null;
  preparation: ScenePreparation | null;
  done: boolean;
  /** A load of the game uses it (it is not let go by `want`). */
  asked: boolean;
}

export function createScenePreloader(opts: {
  readonly read: (sceneId: string) => Promise<SceneEntities>;
  readonly max?: number;
  readonly prepareWaitMs?: number;
  readonly hooks?: ScenePreloadHooks;
}): ScenePreloader {
  const max = Math.max(0, opts.max ?? SCENES_READ_AHEAD);
  const waitMs = opts.prepareWaitMs ?? SCENE_PREPARE_WAIT_MS;
  const entries = new Map<string, Entry>();
  let prepare: ((sceneId: string, entities: SceneEntities) => ScenePreparation | null) | null = null;
  let disposed = false;

  const prepareEntry = (sceneId: string, e: Entry): Promise<void> => {
    if (e.prepared !== null) return e.prepared;
    e.prepared = e.entities.then(
      (entities) => {
        if (disposed || entries.get(sceneId) !== e) return;
        const p = prepare?.(sceneId, entities) ?? null;
        e.preparation = p;
        if (p === null) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        });
        return Promise.race([p.ready, timeout]).finally(() => clearTimeout(timer));
      },
      () => undefined,
    ).then(() => {
      e.done = true;
    });
    return e.prepared;
  };

  const start = (sceneId: string): Entry => {
    const e: Entry = { entities: opts.read(sceneId), prepared: null, preparation: null, done: false, asked: false };
    entries.set(sceneId, e);
    e.entities.then(
      (entities) => opts.hooks?.read?.(sceneId, entities.length),
      (err: unknown) => {
        if (entries.get(sceneId) === e) entries.delete(sceneId);
        if (e.asked) opts.hooks?.failed?.(sceneId, err instanceof Error ? err.message : String(err));
      },
    );
    if (prepare !== null) void prepareEntry(sceneId, e);
    return e;
  };

  const drop = (sceneId: string, e: Entry): void => {
    if (entries.get(sceneId) === e) entries.delete(sceneId);
    e.preparation?.release();
    e.preparation = null;
  };

  return {
    async load(sceneId) {
      if (disposed) throw new Error('the game page is closing');
      const had = entries.get(sceneId);
      const ahead = had !== undefined && !had.asked;
      opts.hooks?.requested?.(sceneId, ahead);
      // A scene loaded before (its preparation went to that load) is read and prepared again.
      if (had !== undefined && !ahead) drop(sceneId, had);
      const e = ahead ? had : start(sceneId);
      e.asked = true;
      const entities = await e.entities;
      await prepareEntry(sceneId, e);
      if (disposed) throw new Error('the game page is closing');
      opts.hooks?.prepared?.(sceneId, entities.length);
      // The render side lets go of the preparation once it realized the scene (`want` forgets the entry then).
      return entities;
    },
    want(sceneIds, status) {
      if (disposed) return;
      const named = new Set<string>();
      for (const id of sceneIds) {
        if (named.size >= max) break;
        if (status[id] === 'unloaded' && !entries.get(id)?.asked) named.add(id);
      }
      for (const [id, e] of [...entries]) {
        if (e.asked) {
          // A load's entry: kept while the scene loads; once loaded the render side holds it; a cancelled one is let go.
          if (status[id] === 'loaded') entries.delete(id);
          else if (status[id] === 'unloaded' && e.done) drop(id, e);
          continue;
        }
        if (!named.has(id)) drop(id, e);
      }
      for (const id of named) if (!entries.has(id)) start(id);
    },
    setPrepare(p) {
      prepare = p;
      if (p === null || disposed) return;
      for (const [id, e] of entries) void prepareEntry(id, e);
    },
    view() {
      const preloading: string[] = [];
      const preloaded: string[] = [];
      for (const [id, e] of entries) (e.done ? preloaded : preloading).push(id);
      return { preloading, preloaded };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [id, e] of [...entries]) drop(id, e);
    },
  };
}

/** The adapter surface a page's preparation uses (the three-adapter's `prepareScene`). */
export interface ScenePreparingAdapter {
  prepareScene?(sceneId: string, entities: readonly { readonly id: string; readonly components: unknown }[], textures?: readonly string[]): ScenePreparation;
}

/**
 * A game page's preparation of a scene: the declared assets its
 * objects name (directly or through materials, functions and effects, and its
 * own bakes; the same scan as the start scenes') are read and checked, and
 * the adapter parses its models, decodes its instance buffers and textures.
 * A failed read is not an error here: the asset fails where it is used.
 */
export function pageScenePreparation(o: {
  readonly adapter: () => ScenePreparingAdapter | null;
  readonly reader: VerifiedAssetReader;
  readonly sources: Omit<StartAssetSources, 'entities' | 'startSceneIds' | 'environment'>;
  /** A v5 build's catalog: the scene's dependency entries (read with the scene) are what it needs. */
  readonly catalog?: { sceneEntriesRead(sceneId: string): readonly DeclaredAssetRow[] | undefined };
}): (sceneId: string, entities: SceneEntities) => ScenePreparation {
  return (sceneId, entities) => {
    const bake = o.sources.lighting?.[sceneId];
    const listed = o.catalog?.sceneEntriesRead(sceneId);
    const rows = listed !== undefined ? listed.filter((r) => r.kind !== 'audio') : startSceneAssets({ ...o.sources, entities, startSceneIds: [sceneId], lighting: bake !== undefined ? { [sceneId]: bake } : {} });
    const read = o.reader.preload(rows).catch(() => undefined);
    const textures = rows.filter((r) => r.kind === 'texture').map((r) => r.assetId);
    const prepared = o.adapter()?.prepareScene?.(sceneId, entities as unknown as readonly { id: string; components: unknown }[], textures) ?? null;
    return {
      ready: Promise.all([read, prepared?.ready ?? Promise.resolve()]).then(() => undefined),
      release: () => prepared?.release(),
    };
  };
}
