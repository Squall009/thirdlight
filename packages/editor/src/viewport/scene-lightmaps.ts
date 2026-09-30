/**
 * The Scene view's lightmaps: the project's bakes shown on the baked objects
 * (with game lighting), as Play and exports show them — each baked static
 * object's meshes get a lightmapped copy of their materials, and so do the
 * chunks of baked block layers whose geometry still has the layout the bake
 * was made for.
 *
 * Browser-only (three.js). The viewport owns one and calls it when entities,
 * bakes, the lighting mode or block chunks change.
 */
import * as THREE from 'three';
import { lightmappedMaterial, lightmapTexture, refreshLightmappedMaterial, type BlockLayerView, type LightingBakeLike, type TextureHolds } from '@thirdlight/three-adapter';

import type { ProjectedEntity } from '../session/projection';

export interface SceneLightmapHost {
  /** The Scene view's entities as last synced. */
  projected(): readonly ProjectedEntity[];
  /** The drawn object of an entity (a model instance or a box), or null. */
  rootOf(entityId: string): THREE.Object3D | null;
  /** Game lighting is on (lightmaps show only then). */
  gameLighting(): boolean;
  /** The block layers' view, when there is one. */
  blockView(): BlockLayerView | null;
  requestRender(): void;
}

type Entry = { bake: LightingBakeLike; atlas: string; scaleOffset: readonly number[]; layout?: string };

export class SceneLightmaps {
  private readonly host: SceneLightmapHost;
  /** Entities by id; block-layer chunks by `<layer>#<cx>,<cz>` (never an entity id). */
  private readonly entries = new Map<string, Entry>();
  private readonly chunkLayers = new Set<string>();
  /** The lights a bake holds in full (not realtime while it is used). */
  readonly bakedLightIds = new Set<string>();
  /**
   * The atlases, held in the Scene view's resource manager per entity or
   * chunk that shows one (decoded once, shared): an object that is not drawn
   * (its scene closed) lets its atlas go, and an atlas nothing shows is freed.
   */
  private holds: TextureHolds | null = null;
  private readonly held = new Map<string, THREE.Texture | 'loading'>();
  /** Per entity or chunk: its lightmap texture and the lightmapped copy of each original material. */
  private copies = new Map<string, { map: THREE.Texture; atlas: THREE.Texture; copies: Map<THREE.Material, THREE.Material | null> }>();
  private swapped: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[]; copy: THREE.Material | THREE.Material[] }[] = [];

  constructor(host: SceneLightmapHost) {
    this.host = host;
  }

  /** The project's bakes (sceneId → bake); null clears them. The caller re-syncs its lights (held lights leave realtime) and applies. */
  set(bakes: Readonly<Record<string, LightingBakeLike>> | null, holds: TextureHolds | null): void {
    this.unapply();
    this.releaseCopies();
    // A re-bake publishes new versions of the same atlas assets: they are read again.
    this.releaseAll();
    this.holds = holds;
    this.entries.clear();
    this.chunkLayers.clear();
    this.bakedLightIds.clear();
    for (const bake of Object.values(bakes ?? {})) {
      for (const id of bake.bakedLights) this.bakedLightIds.add(id);
      for (const e of bake.entries) {
        const atlas = bake.atlases[e.atlas];
        if (atlas === undefined) continue;
        if (e.chunk !== undefined && e.layout !== undefined) {
          this.chunkLayers.add(e.entityId);
          this.entries.set(`${e.entityId}#${e.chunk[0]},${e.chunk[1]}`, { bake, atlas, scaleOffset: e.scaleOffset, layout: e.layout });
        } else this.entries.set(e.entityId, { bake, atlas, scaleOffset: e.scaleOffset });
      }
    }
  }

  /** Whether a bake has lightmaps for chunks of this block layer (its chunks need lightmap UVs). */
  hasChunks(layerId: string): boolean {
    return this.chunkLayers.has(layerId);
  }

  /** Put the original materials back (before the scene changes under the copies). */
  unapply(): void {
    for (const s of this.swapped) if (s.mesh.material === s.copy) s.mesh.material = s.original;
    this.swapped = [];
  }

  /** Swap the lightmapped copies in (game lighting only); cheap when nothing changed. */
  apply(): void {
    if (!this.host.gameLighting() || this.entries.size === 0) return;
    const projected = this.host.projected();
    const ambientBaked = (bake: LightingBakeLike): boolean =>
      bake.bakedLights.some((id) => {
        const t = projected.find((e) => e.id === id)?.light?.type;
        return t === 'ambient' || t === 'hemisphere';
      });
    // Copies this pass does not put on a mesh are released (an entity removed or not realized, a
    // material swapped for another, a chunk whose layout changed): they are rebuilt when needed again.
    const visited = new Set<string>();
    const chunkMeshes = new Map<string, THREE.Mesh[]>();
    const view = this.host.blockView();
    for (const layerId of this.chunkLayers) {
      for (const t of view?.lightmapTargets(layerId) ?? []) {
        const key = `${layerId}#${t.cx},${t.cz}`;
        if (this.entries.get(key)?.layout === t.layout) chunkMeshes.set(key, [...t.meshes, ...t.coarse]);
      }
    }
    const drawn = new Set<string>();
    for (const [key, entry] of this.entries) {
      const meshes = entry.layout !== undefined ? (chunkMeshes.get(key) ?? null) : this.entityMeshes(key);
      if (meshes === null) continue;
      drawn.add(key);
      const atlas = this.atlasFor(key, entry.atlas);
      if (atlas === null) continue;
      visited.add(key);
      let rec = this.copies.get(key);
      if (rec !== undefined && rec.atlas !== atlas) {
        rec.map.dispose();
        for (const c of rec.copies.values()) c?.dispose();
        rec = undefined;
      }
      if (rec === undefined) {
        rec = { map: lightmapTexture(atlas, entry.scaleOffset), atlas, copies: new Map() };
        this.copies.set(key, rec);
      }
      const r = rec;
      const used = new Set<THREE.Material>();
      const ignoreAmbient = ambientBaked(entry.bake);
      for (const mesh of meshes) {
        const original = mesh.material;
        const list = Array.isArray(original) ? original : [original];
        const copies = list.map((m) => {
          used.add(m);
          if (!r.copies.has(m)) r.copies.set(m, lightmappedMaterial(m, r.map, entry.bake.range, ignoreAmbient));
          const c = r.copies.get(m) ?? null;
          if (c !== null) refreshLightmappedMaterial(c, m);
          return c ?? m;
        });
        if (copies.some((c, i) => c !== list[i])) {
          const copy = Array.isArray(original) ? copies : copies[0]!;
          mesh.material = copy;
          this.swapped.push({ mesh, original, copy });
        }
      }
      for (const [m, c] of [...r.copies]) {
        if (used.has(m)) continue;
        c?.dispose();
        r.copies.delete(m);
      }
    }
    for (const [key, rec] of [...this.copies]) {
      if (visited.has(key)) continue;
      rec.map.dispose();
      for (const c of rec.copies.values()) c?.dispose();
      this.copies.delete(key);
    }
    // What is not drawn lets its atlas go.
    for (const key of [...this.held.keys()]) if (!drawn.has(key)) this.release(key);
  }

  dispose(): void {
    this.unapply();
    this.releaseCopies();
    this.releaseAll();
  }

  /** An entity's meshes with UV1 (another entity's nodes below it keep their own lightmap); null when it is not drawn. */
  private entityMeshes(entityId: string): THREE.Mesh[] | null {
    const root = this.host.rootOf(entityId);
    if (root === null) return null;
    const out: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D): void => {
      const owner = (o as { entityId?: string }).entityId;
      if (o !== root && owner !== undefined && owner !== entityId) return;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh === true && mesh.geometry.getAttribute('uv1') !== undefined) out.push(mesh);
      for (const c of o.children) visit(c);
    };
    visit(root);
    return out;
  }

  private releaseCopies(): void {
    for (const rec of this.copies.values()) {
      rec.map.dispose();
      for (const c of rec.copies.values()) c?.dispose();
    }
    this.copies.clear();
  }

  /** An object's atlas (held for it; null while it is read). */
  private atlasFor(key: string, assetId: string): THREE.Texture | null {
    const have = this.held.get(key);
    if (have === 'loading') return null;
    if (have !== undefined) return have;
    const holds = this.holds;
    if (holds === null) return null;
    this.held.set(key, 'loading');
    void holds.get(assetId, `lightmap:${key}`).then((t) => {
      if (this.held.get(key) !== 'loading') return;
      if (t === null) {
        this.release(key);
        return;
      }
      this.held.set(key, t);
      this.unapply();
      this.apply();
      this.host.requestRender();
    });
    return null;
  }

  private release(key: string): void {
    this.held.delete(key);
    this.holds?.releaseHolder(`lightmap:${key}`);
  }

  private releaseAll(): void {
    for (const key of [...this.held.keys()]) this.release(key);
  }
}
