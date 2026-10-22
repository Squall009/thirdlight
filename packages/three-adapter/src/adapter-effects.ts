/**
 * The adapter's visual effects: the effect player (effects-player.ts) with
 * what it loads held in the page's resource manager, project materials for
 * particles shaded with one, the objects carrying an `effect` component, and
 * the per-frame step that plays the runtime's requests.
 *
 * Kept apart from the adapter so the effects' wiring grows in one place.
 */
import * as THREE from 'three';
import type { ResourceManager } from '@thirdlight/runtime';

import { disposeObjectTree } from './dispose';
import { createEffectsPlayer, type EffectComponentLike, type EffectRequestLike, type EffectsDiagnostics, type EffectsPlayer } from './effects-player';
import type { MaterialLibrary } from './material-library';
import { objectResidentBytes } from './resource-bytes';
import { textureHolds, type TextureHolds } from './texture-holds';
import type { SceneAdapterOptions } from './adapter-types';

/** What a particle material holder wears until the project material library dresses it. */
const EFFECT_MATERIAL_PLACEHOLDER = new THREE.MeshBasicMaterial();
/** The effect models' holder in the resource manager (one effect player per page). */
const EFFECTS_HOLDER = 'effects';

/** The canvas the effects report on (an export has no other in-page diagnostics surface). */
interface MarkedCanvas {
  setAttribute?: (name: string, value: string) => void;
}

export class AdapterEffects {
  /** The player (null: the page plays no effects). */
  readonly player: EffectsPlayer | null;
  /** A project material for particles shaded with one (the library's compiled material, taken from a holder mesh). */
  private readonly materials = new Map<string, THREE.Mesh>();
  /** The effects' textures and models are held for the effect player's life. */
  private readonly textures: TextureHolds | null;
  /** Entities carrying an `effect` component (hidden ones stop spawning). */
  private readonly entities = new Set<string>();
  private lastNow: number | null = null;
  private mark = '';

  constructor(
    scene: THREE.Scene,
    private readonly resources: ResourceManager,
    opts: Pick<SceneAdapterOptions, 'effects' | 'materials'>,
    materialLibrary: MaterialLibrary | null,
  ) {
    const fx = opts.effects;
    this.textures = fx !== undefined ? textureHolds(resources, fx.loadTexture) : null;
    if (fx === undefined) {
      this.player = null;
      return;
    }
    const textures = this.textures!;
    const modelLoad = fx.loadModel;
    this.player = createEffectsPlayer({
      scene,
      defs: fx.defs,
      wind: fx.wind ?? opts.materials?.wind ?? null,
      loadTexture: (assetId) => textures.get(assetId, 'effects'),
      ...(modelLoad !== undefined
        ? {
            loadModel: (assetId: string) =>
              resources
                .acquire<THREE.Object3D>('effect-model', assetId, EFFECTS_HOLDER, async () => {
                  const root = await modelLoad(assetId);
                  if (root === null) throw new Error(`effect model ${assetId} is not available`);
                  return { value: root, ...objectResidentBytes(root), free: (r) => disposeObjectTree(r) };
                })
                .catch(() => null),
          }
        : {}),
      projectMaterial: (id: string) => {
        if (materialLibrary === null || id === '') return null;
        let holder = this.materials.get(id);
        if (holder === undefined) {
          holder = new THREE.Mesh(new THREE.BufferGeometry(), EFFECT_MATERIAL_PLACEHOLDER);
          materialLibrary.apply(holder, { '*': id });
          this.materials.set(id, holder);
        }
        // Still the placeholder: no such project material (the particles fall back to their built-in shading).
        return holder.material === EFFECT_MATERIAL_PLACEHOLDER ? null : (holder.material as THREE.Material);
      },
    });
  }

  /** An entity's `effect` component plays from its node (on start unless it waits for a signal or a script). */
  attach(entityId: string, node: THREE.Object3D, component: EffectComponentLike): void {
    if (this.player === null) return;
    this.entities.add(entityId);
    this.player.attach(entityId, node, component, component.playOnStart !== false);
  }

  detach(entityId: string): void {
    if (this.player === null) return;
    this.player.detach(entityId);
    this.entities.delete(entityId);
  }

  /**
   * The effect requests of the steps since the last frame (presentation only), then the effects step; the
   * canvas reports the executor and what plays.
   */
  frame(
    requests: readonly EffectRequestLike[],
    nodeFor: (entityId: string) => THREE.Object3D | undefined,
    hidden: ReadonlySet<string>,
    paused: boolean,
    camera: THREE.Camera | null,
    worldTime: (now: number) => number,
    canvas: MarkedCanvas | null,
  ): void {
    const effects = this.player;
    if (effects === null) return;
    for (const req of requests) effects.request(req, nodeFor);
    for (const id of this.entities) effects.setAttachedActive(id, !hidden.has(id));
    const perf = globalThis.performance;
    const now = perf !== undefined ? perf.now() : 0;
    const frameSeconds = this.lastNow === null || paused ? 0 : Math.max(0, (now - this.lastNow) / 1000);
    this.lastNow = now;
    if (camera !== null) effects.update(frameSeconds, camera, worldTime(now));
    const d = effects.diagnostics();
    const mark = `${d.executor ?? 'none'}|${d.playing}|${d.particles}|${d.lights}`;
    if (mark !== this.mark && typeof canvas?.setAttribute === 'function') {
      this.mark = mark;
      canvas.setAttribute('data-tl-effects', d.executor ?? 'none');
      canvas.setAttribute('data-tl-effects-playing', String(d.playing));
      canvas.setAttribute('data-tl-effects-particles', String(d.particles));
      canvas.setAttribute('data-tl-effects-lights', String(d.lights));
    }
  }

  diagnostics(): EffectsDiagnostics | null {
    return this.player?.diagnostics() ?? null;
  }

  dispose(): void {
    this.player?.dispose();
    this.textures?.releaseHolder('effects');
    this.resources.releaseHolder(EFFECTS_HOLDER);
    for (const h of this.materials.values()) h.geometry.dispose();
    this.materials.clear();
  }
}
