/**
 * The adapter's realized entities: what each loaded entity's components make
 * (a box, a light, a block layer, a terrain, a spline, generated
 * architecture, a fog volume, decals, an effect) and what a host hangs on it,
 * realized from its document and released when its scene unloads.
 *
 * Kept apart from the adapter so the component table grows in one place.
 */
import * as THREE from 'three';
import type { ArchitectureComponent, BlockLayerComponent, BlockLayerData, SplineComponent, TerrainComponent } from '@thirdlight/project-model';

import type { AdapterEffects } from './adapter-effects';
import type { AdapterMaterials } from './adapter-materials';
import type { SceneAdapterOptions } from './adapter-types';
import type { ArchitectureView } from './architecture-view';
import { BATCH_KEY } from './batching';
import type { BlockLayerView } from './block-layers';
import type { ClippedDecals } from './clipped-decals';
import type { CoverModelLike } from './cover-models';
import type { CoverView } from './cover-view';
import type { ProjectedDecalLike } from './decal-projectors';
import { disposeObjectTree } from './dispose';
import type { EffectComponentLike } from './effects-player';
import { materialParamsOf, modelRefsOf, pathPaintOf } from './entity-refs';
import { applyEntityRenderFlags } from './entity-render-flags';
import type { FogVolumeLike } from './environment';
import type { WindZoneLike } from './wind-field';
import type { WindZoneComponent } from '@thirdlight/project-model';
import type { AuthoredSurface } from './lighting';
import { addBoxLightmapUv, type LightmapSet } from './lightmaps';
import type { SceneLights } from './lights-shadows';
import type { ModelsRealization } from './models';
import { markHostDrawing } from './occludees';
import { releaseEmissiveLooks, SHARED_MATERIAL_KEY } from './node-materials';
import type { RenderGraph } from './render-graph';
import type { SplineView } from './spline-view';
import { STATIC_KEY } from './static-merge';
import type { TerrainView } from './terrain-view';

/** A realized entity's document (the snapshot's or a scene batch's, deep-frozen and runtime-validated). */
export type EntityDoc = SceneAdapterOptions['snapshot']['scene']['entities'][number];

type FogVolumeComponent = { size: [number, number, number]; density: number; color: string; falloff?: number; heightFalloff?: number };

/** The views and parts a realized entity's components go to. */
export interface AdapterEntitiesDeps {
  readonly graph: RenderGraph;
  readonly lights: SceneLights;
  readonly blockView: BlockLayerView;
  readonly terrains: TerrainView;
  readonly splines: SplineView;
  readonly architecture: ArchitectureView;
  /** Ground cover (null: scatter is not drawn): a model's cover rules go to it. */
  readonly cover: CoverView | null;
  readonly clipped: ClippedDecals | null;
  readonly effects: AdapterEffects;
  readonly materials: AdapterMaterials;
  lightmaps(): LightmapSet | null;
  realization(): ModelsRealization | null;
  /** The unit box every box is drawn through when batched. */
  readonly unitBox: THREE.BufferGeometry;
  readonly vertexPaint: boolean;
  readonly terrain: boolean;
}

export class AdapterEntities {
  /** Each entity's own GPU resources (released when its scene unloads). */
  private readonly resources = new Map<string, { geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; shared?: THREE.Material }>();
  /** Box materials by value (shared by every box with the same values; counted). */
  private readonly boxMaterials = new Map<string, { material: THREE.Material; refs: number }>();
  private readonly boxMaterialKeys = new Map<THREE.Material, string>();
  /** The block layers realized from their documents (a host may drive layers of its own through `blockLayers()`). */
  readonly docLayers = new Set<string>();
  /** What a host hangs on entities (the editor's icons and outlines): it rides on the entity's node. */
  readonly overlays = new Map<string, Set<THREE.Object3D>>();
  /**
   * The static scope of each realized entity that never moves: its scene (static batching merges per scene, so
   * an unload drops only that scene's merged cells). None for an object kept loaded across scenes or spawned.
   */
  readonly staticScopes = new Map<string, string>();
  private readonly fogVolumeIds = new Set<string>();
  private readonly windZoneIds = new Set<string>();
  private readonly tmpWorld: number[] = [0, 0, 0];

  /** `docs`: the documents of every realized entity (the loaded scenes), read by the other parts. */
  constructor(
    readonly docs: Map<string, EntityDoc>,
    private readonly deps: AdapterEntitiesDeps,
  ) {}

  private sharedBoxMaterial(surface: AuthoredSurface | undefined, color: string): THREE.Material {
    const key = surface ? JSON.stringify(['s', surface.color, surface.roughness, surface.metalness, surface.emissive, surface.emissiveIntensity]) : JSON.stringify(['l', color]);
    let rec = this.boxMaterials.get(key);
    if (rec === undefined) {
      const material: THREE.Material = surface
        ? new THREE.MeshStandardMaterial({
            color: new THREE.Color(surface.color),
            roughness: surface.roughness,
            metalness: surface.metalness,
            emissive: new THREE.Color(surface.emissive),
            emissiveIntensity: surface.emissiveIntensity,
          })
        : new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
      material.userData[SHARED_MATERIAL_KEY] = true;
      rec = { material, refs: 0 };
      this.boxMaterials.set(key, rec);
      this.boxMaterialKeys.set(material, key);
    }
    rec.refs += 1;
    return rec.material;
  }

  private releaseBoxMaterial(material: THREE.Material): void {
    const key = this.boxMaterialKeys.get(material);
    const rec = key === undefined ? undefined : this.boxMaterials.get(key);
    if (rec === undefined || key === undefined) return;
    rec.refs -= 1;
    if (rec.refs > 0) return;
    this.boxMaterials.delete(key);
    this.boxMaterialKeys.delete(material);
    material.dispose();
  }

  /** Box primitive: unit-axis geometry sized by `size`; the transform's `scale` multiplies on top per frame. */
  private realizeBox(e: EntityDoc, scope: string | null, own: { geometries: THREE.BufferGeometry[]; shared?: THREE.Material }): THREE.Mesh | null {
    const box = e.components.box;
    if (!box) return null;
    const geometry = new THREE.BoxGeometry(box.size[0], box.size[1], box.size[2]);
    addBoxLightmapUv(geometry);
    const surface = (e.components as { surface?: AuthoredSurface }).surface;
    // An entity carrying `surface` takes its values literally (no preset lookup); no `surface` ⇒ the plain
    // Lambert path. Boxes with equal values share one material (a per-object look — `ctx.look`, a lightmap —
    // copies it first), so they can be drawn together.
    const material = this.sharedBoxMaterial(surface, box.material.color);
    own.geometries.push(geometry);
    own.shared = material;
    const boxMesh = new THREE.Mesh(geometry, material);
    // Drawn through the one unit box scaled by the size when batched.
    boxMesh.userData[BATCH_KEY] = { geometry: this.deps.unitBox, scale: [box.size[0], box.size[1], box.size[2]] };
    if (scope !== null) boxMesh.userData[STATIC_KEY] = scope;
    // Boxes cast and receive the key light's shadow (data: box.castShadow / receiveShadow), in their light layers.
    applyEntityRenderFlags(boxMesh, e.components);
    this.deps.graph.nodeFor(e.id)!.add(boxMesh);
    return boxMesh;
  }

  /** Realize an entity's document (`sceneId`: the scene it came with; null for a spawned or scene-less one). */
  realize(e: EntityDoc, sceneId: string | null = null): void {
    const { graph, materials } = this.deps;
    const t = e.components.transform;
    graph.addEntity(e.id, e.parentId ?? null);
    const flags = e as { static?: boolean; keepLoaded?: boolean };
    const scope = sceneId !== null && flags.static === true && flags.keepLoaded !== true ? sceneId : null;
    if (scope !== null) this.staticScopes.set(e.id, scope);
    graph.world.setLocal(e.id, t.position, t.rotation, t.scale);
    this.docs.set(e.id, e);
    // Only an entity that shows something (or anchors an effect) gets a node, when it does; the rest is the table row.
    const own: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; shared?: THREE.Material } = { geometries: [], materials: [] };
    const boxMesh = this.realizeBox(e, scope, own);
    if (boxMesh === null) this.deps.lights.realize(e);
    this.realizeViews(e);
    const c = e.components as { fogVolume?: unknown; windZone?: unknown; decal?: ProjectedDecalLike & { material?: string }; materials?: Record<string, string>; effect?: EffectComponentLike };
    if (c.fogVolume !== undefined) this.fogVolumeIds.add(e.id);
    if (c.windZone !== undefined) this.windZoneIds.add(e.id);
    materials.decalPages?.set(e.id, c.decal?.material ?? null);
    materials.projectors?.set(e.id, graph.nodeFor(e.id)!, c.decal ?? null);
    this.deps.clipped?.set(e.id, c.decal ?? null, scope);
    const node = graph.node(e.id);
    const mapping = materials.effective(e.id, c.materials);
    // With the object's values for its graph materials' public parameters.
    if (boxMesh !== null && node !== undefined && materials.library !== null && mapping !== undefined) materials.undo.set(e.id, materials.library.apply(node, mapping, materialParamsOf(e.components)));
    if (boxMesh !== null && node !== undefined) this.deps.lightmaps()?.apply(e.id, node);
    if (own.geometries.length > 0) this.resources.set(e.id, own);
    // An effect component plays from the object (on start unless it waits for a signal or a script).
    if (this.deps.effects.player !== null && c.effect !== undefined) this.deps.effects.attach(e.id, graph.nodeFor(e.id)!, c.effect);
    // The effects it names are made ahead (WebGPU), so the first show builds no pipelines.
    if (this.deps.effects.player !== null) this.deps.effects.warmNamed(e.components as unknown as Record<string, unknown>);
    // What a host hangs on it (back after the entity was realized again), last: the material, look and lightmap paths above never see it.
    const hung = this.overlays.get(e.id);
    if (hung !== undefined) {
      const holder = graph.nodeFor(e.id)!;
      for (const o of hung) holder.add(o);
    }
  }

  /** The level views an entity's components feed: a block layer, a spline, architecture, a terrain. */
  private realizeViews(e: EntityDoc): void {
    const { blockView, splines, architecture, terrains, materials } = this.deps;
    const t = e.components.transform;
    const c = e.components as { blockLayer?: BlockLayerComponent & { data?: BlockLayerData }; terrain?: TerrainComponent; spline?: SplineComponent; architecture?: ArchitectureComponent; materials?: Record<string, string>; model?: CoverModelLike };
    // A block layer (its cells ride on the resolved component).
    if (c.blockLayer !== undefined) {
      this.docLayers.add(e.id);
      blockView.setLayer(e.id, c.blockLayer, t.position, c.blockLayer.data ?? null);
      architecture.layerChanged(e.id);
    }
    if (c.spline !== undefined) splines.set(e.id, c.spline, t.position, this.deps.vertexPaint ? pathPaintOf(e.components) : undefined);
    if (c.architecture !== undefined) architecture.set(e.id, c.architecture, t.position, this.deps.vertexPaint ? pathPaintOf(e.components) : undefined);
    // A model's ground cover (its faces read once it has loaded and stands still).
    if (c.model?.scatter !== undefined) this.deps.cover?.setModel(e.id, c.model);
    if (c.terrain !== undefined && this.deps.terrain) terrains.setTerrain(e.id, c.terrain, t.position, { components: e.components, materials: materials.effective(e.id, c.materials) ?? null, overrides: materialParamsOf(e.components) });
  }

  /** An entity whose vertex paint alone changed: what it draws stays, its paint is swapped once read (vertex-paint-update.ts). */
  repaintInPlace(e: EntityDoc): void {
    const before = this.docs.get(e.id)?.components as { spline?: SplineComponent; architecture?: ArchitectureComponent } | undefined;
    this.docs.set(e.id, e);
    const c = e.components as { spline?: SplineComponent; architecture?: ArchitectureComponent };
    const at = e.components.transform.position;
    // The generator's input is the one drawn (equal by value): only the paint is new.
    if (c.spline !== undefined) this.deps.splines.set(e.id, before?.spline ?? c.spline, at, pathPaintOf(e.components));
    if (c.architecture !== undefined) this.deps.architecture.set(e.id, before?.architecture ?? c.architecture, at, pathPaintOf(e.components));
    const refs = modelRefsOf([e]);
    this.deps.realization()?.updatePaint(e.id, { meshes: refs.paints.get(e.id), instances: refs.instances.get(e.id) });
  }

  release(id: string): void {
    const { graph, materials } = this.deps;
    if (this.docLayers.delete(id)) this.deps.blockView.removeLayer(id);
    this.deps.terrains.removeTerrain(id);
    this.deps.splines.remove(id);
    this.deps.architecture.remove(id);
    this.deps.cover?.setModel(id, null);
    materials.runtime?.release(id);
    this.deps.effects.detach(id);
    const obj = graph.node(id);
    // Per-object looks first (a look override's own copies), then the shared paths undo.
    if (obj !== undefined) releaseEmissiveLooks(obj);
    this.deps.lightmaps()?.release(id);
    this.fogVolumeIds.delete(id);
    this.windZoneIds.delete(id);
    materials.decalPages?.remove(id);
    materials.projectors?.remove(id);
    this.deps.clipped?.remove(id);
    // Its light (a directional or ambient light hangs off the scene; one on the node goes with it).
    this.deps.lights.release(id);
    // What a host hangs on it leaves the node first (the host keeps it; it comes back when the entity does).
    const hung = this.overlays.get(id);
    if (hung !== undefined && obj !== undefined) for (const o of hung) obj.remove(o);
    materials.undo.get(id)?.();
    materials.undo.delete(id);
    materials.swaps?.removed(id);
    // Its drawables leave the scene first (the node's tree is all its own: children have nodes of their own).
    graph.removeEntity(id);
    // Its render objects (a material that outlives it — a project material, a shared box
    // material — would keep them) and a light's shadow map.
    if (obj !== undefined) disposeObjectTree(obj);
    this.docs.delete(id);
    this.staticScopes.delete(id);
    const own = this.resources.get(id);
    if (own !== undefined) {
      for (const g of own.geometries) g.dispose();
      for (const m of own.materials) m.dispose();
      if (own.shared !== undefined) this.releaseBoxMaterial(own.shared);
      this.resources.delete(id);
    }
  }

  /** The fog volumes of the loaded scenes, in world space (entities may move). */
  fogVolumesNow(): FogVolumeLike[] {
    const out: FogVolumeLike[] = [];
    const graph = this.deps.graph;
    const at = this.tmpWorld;
    for (const id of this.fogVolumeIds) {
      const fv = (this.docs.get(id)?.components as { fogVolume?: FogVolumeComponent } | undefined)?.fogVolume;
      if (fv === undefined || graph.isHidden(id) || !graph.world.position(id, at)) continue;
      out.push({ center: [at[0]!, at[1]!, at[2]!], size: fv.size, density: fv.density, color: fv.color, ...(fv.falloff !== undefined ? { falloff: fv.falloff } : {}), ...(fv.heightFalloff !== undefined ? { heightFalloff: fv.heightFalloff } : {}) });
    }
    return out;
  }

  /** The wind zones of the loaded scenes that are shown, at their world matrices now (entities may move). */
  windZonesNow(): WindZoneLike[] {
    const out: WindZoneLike[] = [];
    if (this.windZoneIds.size === 0) return out;
    const graph = this.deps.graph;
    const world = graph.world;
    for (const id of this.windZoneIds) {
      const zone = (this.docs.get(id)?.components as { windZone?: WindZoneComponent } | undefined)?.windZone;
      const row = world.indexOf(id);
      if (zone === undefined || row === undefined || graph.isHidden(id)) continue;
      out.push({ key: id, zone, matrix: world.world.subarray(row * 16, row * 16 + 16) });
    }
    return out;
  }

  /** A host's drawing hung on an entity's node (it comes back when the entity is realized again). */
  attachOverlay(entityId: string, object: THREE.Object3D): void {
    let hung = this.overlays.get(entityId);
    if (hung === undefined) this.overlays.set(entityId, (hung = new Set()));
    hung.add(object);
    // The host's own drawing: occlusion culling never leaves it out.
    markHostDrawing(object);
    if (object.parent !== null) object.removeFromParent();
    this.deps.graph.nodeFor(entityId)?.add(object);
  }

  detachOverlay(entityId: string, object: THREE.Object3D): void {
    const hung = this.overlays.get(entityId);
    if (hung === undefined || !hung.delete(object)) return;
    if (hung.size === 0) this.overlays.delete(entityId);
    object.removeFromParent();
  }

  /** Every entity's own geometry and the shared box materials (the rest goes with the scene). */
  dispose(): void {
    for (const own of this.resources.values()) {
      for (const g of own.geometries) {
        try { g.dispose(); } catch { /* best effort */ }
      }
      for (const m of own.materials) {
        try { m.dispose(); } catch { /* best effort */ }
      }
    }
    this.resources.clear();
  }

  disposeBoxMaterials(): void {
    for (const rec of this.boxMaterials.values()) rec.material.dispose();
    this.boxMaterials.clear();
    this.boxMaterialKeys.clear();
  }
}
