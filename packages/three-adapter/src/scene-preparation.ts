/**
 * Scenes prepared ahead of their load (a scene read ahead, a transition's
 * target): their models parsed and instance buffers decoded, their textures
 * decoded, and their generated architecture made into the generator's
 * cache, so the frame the scene arrives in draws it whole. Each scene's
 * preparation is held until the scene is realized (its objects then hold
 * what it held) or let go; assets a game page holds by name (its loading
 * screen's) are held the same way.
 */
import type { ArchitectureComponent } from '@thirdlight/runtime';

import type { ArchitectureView } from './architecture-view';
import { modelRefsOf } from './entity-refs';
import type { MaterialLibrary } from './material-library';
import type { ModelsRealization } from './models';

type Handle = { readonly ready: Promise<void>; release(): void };

export interface ScenePreparationDeps {
  disposed(): boolean;
  realization(): ModelsRealization | null;
  materialLibrary: MaterialLibrary | null;
  architecture: ArchitectureView;
}

export interface ScenePreparations {
  /** Prepare a scene's objects (`textures`: the texture assets it names). */
  prepare(sceneId: string, entities: readonly { readonly id: string; readonly components: unknown }[], textures?: readonly string[]): Handle;
  /** Hold models and textures by asset id. */
  hold(models: readonly string[], textures: readonly string[]): Handle;
  /** The scene was realized: its preparation is let go. */
  realized(sceneId: string): void;
  clear(): void;
}

export function createScenePreparations(d: ScenePreparationDeps): ScenePreparations {
  const holds = new Map<string, { release(): void }>();
  const none: Handle = { ready: Promise.resolve(), release: () => undefined };
  const hold = (models: Iterable<string> | null, buffers: Iterable<string>, textures: readonly string[] | undefined): { ready: Promise<void>; release(): void } => {
    const held = models === null ? null : (d.realization()?.hold?.(models, buffers) ?? null);
    const decoded = textures !== undefined && textures.length > 0 && d.materialLibrary?.preloadTextures !== undefined ? d.materialLibrary.preloadTextures(textures) : null;
    let released = false;
    return {
      ready: Promise.all([held?.ready ?? Promise.resolve(), decoded?.ready.catch(() => undefined)]).then(() => undefined),
      release: (): void => {
        if (released) return;
        released = true;
        held?.release();
        decoded?.release();
      },
    };
  };
  return {
    prepare(sceneId, entities, textures) {
      holds.get(sceneId)?.release();
      holds.delete(sceneId);
      if (d.disposed()) return none;
      const refs = modelRefsOf(entities);
      const assets = hold(new Set([...refs.models.values(), ...[...refs.instances.values()].map((r) => r.assetId)]), [...refs.instances.values()].map((r) => r.buffer), textures);
      // Generated architecture (an interior behind a door): its chunks made now, drawn when the scene arrives.
      const objects: { id: string; component: ArchitectureComponent; origin: readonly number[]; materials?: Readonly<Record<string, string>> }[] = [];
      for (const e of entities) {
        const c = e.components as { architecture?: ArchitectureComponent; transform?: { position?: number[] }; materials?: Record<string, string> };
        if (c.architecture === undefined || !Array.isArray(c.architecture.elements)) continue;
        objects.push({ id: e.id, component: c.architecture, origin: c.transform?.position ?? [0, 0, 0], ...(c.materials !== undefined ? { materials: c.materials } : {}) });
      }
      const made = objects.length > 0 ? d.architecture.prepare(objects) : null;
      const handle = {
        release: (): void => {
          assets.release();
          made?.release();
          if (holds.get(sceneId) === handle) holds.delete(sceneId);
        },
      };
      holds.set(sceneId, handle);
      return { ready: Promise.all([assets.ready, made?.ready]).then(() => undefined), release: handle.release };
    },
    hold(models, textures) {
      if (d.disposed()) return none;
      return hold(models.length > 0 ? new Set(models) : null, [], textures);
    },
    realized(sceneId) {
      holds.get(sceneId)?.release();
      holds.delete(sceneId);
    },
    clear() {
      holds.clear();
    },
  };
}
