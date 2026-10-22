/**
 * The adapter following the runtime's scene set: scenes realized when they
 * load and released when they unload, a scene list an editing host replaced
 * in place realized again only where its documents changed, the objects kept
 * loaded and the spawned prefab copies (`ctx.spawn` / `ctx.destroy`).
 *
 * Kept apart from the adapter so scene loading is followed in one place.
 */
import type { AdapterEntities, EntityDoc } from './adapter-entities';
import type { SceneRuntime } from './adapter-types';
import { modelRefsOf } from './entity-refs';
import type { LightmapSet } from './lightmaps';
import type { ModelsRealization } from './models';
import type { ScenePreparations } from './scene-preparation';
import { paintOnlyChange } from './vertex-paint-update';

type SceneRec = { ids: Set<string>; list: readonly unknown[] };
type SceneSet = NonNullable<ReturnType<NonNullable<SceneRuntime['sceneSet']>>>;

/** What following the scene set reaches in the rest of the adapter. */
export interface AdapterScenesHost {
  readonly runtime: SceneRuntime;
  readonly entities: AdapterEntities;
  realization(): ModelsRealization | null;
  lightmaps(): LightmapSet | null;
  /** An entity's look override is forgotten (it is released or realized again). */
  forgetLook(entityId: string): void;
  readonly preparations: ScenePreparations;
  /** The scene set's programs are built before the next present. */
  requestPrecompile(): void;
  /** The loaded scenes' lights are picked again. */
  selectLights(): void;
  /** The probe tiles follow these scenes. */
  followProbes(sceneIds: Iterable<string>): void;
  /** v3/v4 scenes: an unload alone changes the lights' programs too. */
  readonly v3: boolean;
  readonly vertexPaint: boolean;
  /** The snapshot's own scene (a host without a scene set draws it). */
  readonly ownScene: string | undefined;
}

export class AdapterScenes {
  /** Scenes realized so far (the start scenes came with the snapshot): their entities, and the list they came in. */
  private readonly realized = new Map<string, SceneRec>();
  /** The scene set revision realized (-1: realize it again at the next sync). */
  realizedRevision = -1;
  /** The scene set revision the last presented frame drew. */
  presentedRevision = -1;
  /** The scenes realized since the last drawn frame (for `onFrameDrawn`). */
  readonly frameRealized: string[] = [];
  /** The realized spawned entities: id → the runtime's (frozen) entity object. */
  private readonly spawned = new Map<string, unknown>();

  constructor(private readonly host: AdapterScenesHost) {
    const set = host.runtime.sceneSet?.();
    if (set !== undefined) {
      // A batch counts as realized when the snapshot brought its entities (the others are realized at the first sync).
      for (const b of set.batches) if (b.entities.every((e) => host.entities.docs.has(e.id))) this.realized.set(b.sceneId, { ids: new Set(b.entities.map((e) => e.id)), list: b.entities });
      // Batches the snapshot did not bring are realized at the first sync.
      if (this.realized.size === set.batches.length) this.realizedRevision = set.revision;
    }
  }

  /** The load rank of an entity's scene (higher: loaded later; -1: in none). */
  readonly rankOf = (id: string): number => {
    let i = 0;
    for (const rec of this.realized.values()) {
      if (rec.ids.has(id)) return i;
      i += 1;
    }
    return -1;
  };

  /** The probe tiles follow the realized scenes (a host without a scene set draws its snapshot's scene). */
  followProbes(): void {
    const own = this.host.ownScene;
    this.host.followProbes(this.realized.size > 0 ? this.realized.keys() : own !== undefined ? [own] : []);
  }

  /** Release some of a scene's entities, children before parents (reverse document order of `order`). */
  private releaseIds(ids: ReadonlySet<string>, order: readonly string[]): void {
    for (const id of ids) this.host.lightmaps()?.release(id);
    this.host.realization()?.removeEntities(ids);
    for (const id of ids) this.host.forgetLook(id);
    for (const id of [...order].reverse()) if (ids.has(id)) this.host.entities.release(id);
  }

  /** The runtime's scene set as realized now (a change since the last sync). */
  sync(): void {
    const set = this.host.runtime.sceneSet?.();
    if (set === undefined || set.revision === this.realizedRevision) return;
    this.realizedRevision = set.revision;
    const scenesRemoved = this.unloadGone(set);
    const edited = this.releaseEdited(set);
    const addedEdited = this.realizeEdited(edited);
    const addedNew = this.realizeNew(set);
    const added = addedEdited || addedNew;
    const removed = scenesRemoved || edited.removed;
    // The lights follow the scene set (a light switched on or off changes the shading programs too).
    if (added || removed) this.host.selectLights();
    if (added || removed) this.followProbes();
    if (scenesRemoved && !added && this.host.v3) this.host.requestPrecompile();
    this.syncSpawned((set as { spawned?: readonly unknown[] }).spawned ?? []);
  }

  /** Scenes no longer loaded are released (objects kept loaded move to the scene-less list as they are drawn). */
  private unloadGone(set: SceneSet): boolean {
    const live = new Set(set.batches.map((b) => b.sceneId));
    const staying = new Map<string, unknown>();
    for (const e of (set as { spawned?: readonly unknown[] }).spawned ?? []) staying.set((e as { id: string }).id, e);
    let removed = false;
    for (const [sceneId, rec] of [...this.realized]) {
      if (live.has(sceneId)) continue;
      const ids = new Set([...rec.ids].filter((id) => {
        if (!staying.has(id) || this.spawned.has(id)) return true;
        this.spawned.set(id, staying.get(id));
        return false;
      }));
      this.releaseIds(ids, [...ids]);
      this.realized.delete(sceneId);
      removed = true;
    }
    return removed;
  }

  /**
   * A realized scene whose list was replaced in place (an editing host's scene): only the entities whose
   * document changed are realized again, and the ones gone released (all releases first: an entity may move to
   * another scene's list).
   */
  private releaseEdited(set: SceneSet): { list: { sceneId: string; rec: SceneRec; entities: readonly EntityDoc[] }[]; removed: boolean } {
    const docs = this.host.entities.docs;
    const list: { sceneId: string; rec: SceneRec; entities: readonly EntityDoc[] }[] = [];
    let removed = false;
    for (const b of set.batches) {
      const rec = this.realized.get(b.sceneId);
      if (rec === undefined || rec.list === b.entities) continue;
      const entities = b.entities as unknown as EntityDoc[];
      const next = new Map(entities.map((e) => [e.id, e]));
      const gone = new Set<string>();
      for (const id of rec.ids) {
        const doc = next.get(id);
        if (doc === docs.get(id)) continue;
        if (doc !== undefined && this.host.vertexPaint && paintOnlyChange(docs.get(id), doc)) this.host.entities.repaintInPlace(doc);
        else gone.add(id);
      }
      if (gone.size > 0) {
        this.releaseIds(gone, (rec.list as readonly { id: string }[]).map((e) => e.id));
        for (const id of gone) rec.ids.delete(id);
        removed = true;
      }
      rec.list = b.entities;
      list.push({ sceneId: b.sceneId, rec, entities });
    }
    return { list, removed };
  }

  private realizeEdited(edited: { list: { sceneId: string; rec: SceneRec; entities: readonly EntityDoc[] }[] }): boolean {
    let added = false;
    for (const { sceneId, rec, entities } of edited.list) {
      const fresh = entities.filter((e) => !rec.ids.has(e.id));
      if (fresh.length === 0) continue;
      for (const e of fresh) {
        this.host.entities.realize(e, sceneId);
        rec.ids.add(e.id);
      }
      this.host.realization()?.addEntities(modelRefsOf(fresh));
      added = true;
    }
    return added;
  }

  private realizeNew(set: SceneSet): boolean {
    let added = false;
    for (const b of set.batches) {
      if (this.realized.has(b.sceneId)) continue;
      const entities = b.entities as unknown as EntityDoc[];
      for (const e of entities) this.host.entities.realize(e, b.sceneId);
      this.realized.set(b.sceneId, { ids: new Set(entities.map((e) => e.id)), list: b.entities });
      this.host.realization()?.addEntities(modelRefsOf(entities));
      // Its entities hold what the preparation held.
      this.host.preparations.realized(b.sceneId);
      this.frameRealized.push(b.sceneId);
      // The attached scene's programs are built before it is presented.
      this.host.requestPrecompile();
      added = true;
    }
    return added;
  }

  /** Release every realized scene; the next sync realizes the scene set again (new bakes). */
  releaseAll(): void {
    for (const [sceneId, rec] of [...this.realized]) {
      this.releaseIds(rec.ids, (rec.list as readonly { id: string }[]).map((e) => e.id));
      this.realized.delete(sceneId);
    }
    this.realizedRevision = -1;
  }

  /** Spawned prefab copies: gone ones (or the same id spawned again in a new run) released, new ones realized. */
  private syncSpawned(spawned: readonly unknown[]): void {
    const live = new Map<string, unknown>();
    for (const e of spawned) live.set((e as { id: string }).id, e);
    const gone = [...this.spawned].filter(([id, e]) => live.get(id) !== e).map(([id]) => id);
    if (gone.length > 0) {
      const ids = new Set(gone);
      this.host.realization()?.removeEntities(ids);
      for (const id of gone.reverse()) {
        this.host.entities.release(id);
        this.spawned.delete(id);
        this.host.forgetLook(id);
      }
    }
    const added = spawned.filter((e) => !this.spawned.has((e as { id: string }).id)) as unknown as EntityDoc[];
    if (added.length === 0) return;
    for (const e of added) {
      this.host.entities.realize(e);
      this.spawned.set(e.id, e);
    }
    this.host.realization()?.addEntities(modelRefsOf(added));
  }
}
