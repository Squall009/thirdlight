/**
 * The adapter's level geometry views — block layers (`block-layers.ts`) and
 * terrains (`terrain-view.ts`) — made with what they need from the adapter:
 * the scene's static drawables, model looks for block cells, materials,
 * baked lightmaps, the cached static shadow, the scatter sink and, on a game
 * page, world streaming.
 *
 * Kept apart from the adapter so the level's views grow in one place.
 */
import * as THREE from 'three';

import { BlockLayerView, blockLookFromObject, type BlockModelLook } from './block-layers';
import { createBrowserMeshWorker } from './block-mesh-pool';
import type { LightmapSet } from './lightmaps';
import type { MaterialLibrary } from './material-library';
import type { ScatterSink } from './scatter-view';
import { STATIC_CASTER_KEY, type StaticShadowRevision } from './shadow-casters';
import { TerrainTileStore } from './terrain-tile-store';
import { TerrainView } from './terrain-view';
import type { ModelInstance } from './visual';
import type { PageWorldStream } from './world-stream';

export interface LevelViewsDeps {
  /** A model's instance for block cells (null while it loads: `onReady` then). */
  blockInstance(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /** The prefabs block cells may show (their root's model). */
  readonly prefabs: readonly { prefabId: string; entities: readonly { parentLocalId?: string; components: Record<string, unknown> }[] }[];
  /** An asset's material mapping (its import's). */
  assetMaterials(assetId: string): Readonly<Record<string, string>> | undefined;
  readonly materials: MaterialLibrary | null;
  /** The baked lightmaps now (they change when a bake is applied). */
  lightmaps(): LightmapSet | null;
  /** Compile a cut-away's fade copy in the background. */
  precompile(probe: THREE.Object3D): void;
  readonly staticShadows: StaticShadowRevision | null;
  /** The scene's static drawables. */
  listStatic(o: THREE.Object3D): void;
  unlistStatic(o: THREE.Object3D): void;
  /** The LOD bias in force. */
  lodBias(): number;
  readonly scatter: ScatterSink | undefined;
  readonly stream: PageWorldStream | null;
  readonly meshWorkerUrl: string | undefined;
  /** A game page's decoded tiles (shared with collision), else the views read their own through `read`. */
  readonly tiles: TerrainTileStore | undefined;
  readonly read: ((digest: string) => Promise<ArrayBuffer>) | null;
  /** The direction toward the key light (null: none): the far ground's horizon shadows. */
  sun(): readonly [number, number, number] | null;
  /** The far ground's horizon light (false: left out, a diagnostic comparison). */
  readonly horizon: boolean;
  onChange(): void;
}

/** The block layers' view, the terrains' view, and the tile store the adapter made for itself (null: the page's). */
export function createLevelViews(d: LevelViewsDeps): { blockView: BlockLayerView; terrains: TerrainView; ownTiles: TerrainTileStore | null } {
  const blockLooks = new Map<string, BlockModelLook | null>();
  const blockView = new BlockLayerView({
    ...(d.scatter !== undefined ? { scatter: d.scatter } : {}),
    stream: d.stream,
    modelLook: (assetId, piece, onReady) => {
      const key = `${assetId}|${piece ?? ''}`;
      if (blockLooks.has(key)) return blockLooks.get(key) ?? null;
      const inst = d.blockInstance(assetId, piece, () => {
        onReady();
        d.onChange();
      });
      if (inst === null) return null;
      const look = blockLookFromObject(inst.root);
      blockLooks.set(key, look);
      return look;
    },
    prefabModel: (prefabId) => {
      const root = d.prefabs.find((p) => p.prefabId === prefabId)?.entities.find((e) => e.parentLocalId === undefined);
      const m = root?.components['model'] as { asset?: { assetId?: string }; piece?: string } | undefined;
      return typeof m?.asset?.assetId === 'string' ? { assetId: m.asset.assetId, ...(typeof m.piece === 'string' ? { piece: m.piece } : {}) } : null;
    },
    applyMaterials: (mesh, type, assetId) => {
      if (d.materials === null) return;
      const base = assetId !== null ? d.assetMaterials(assetId) : undefined;
      const mapping = { ...(base ?? {}), ...(type.materials ?? {}) };
      if (Object.keys(mapping).length > 0) d.materials.apply(mesh, mapping, null);
    },
    ...(d.meshWorkerUrl !== undefined ? { meshWorkers: () => createBrowserMeshWorker(d.meshWorkerUrl!) } : {}),
    meshed: () => d.onChange(),
    // Baked block-layer chunks: lightmap UVs, and the chunk's lightmap when its layout is the baked one.
    lightmapped: (id) => d.lightmaps()?.hasChunks(id) === true,
    chunkBuilt: (id, cx, cz, group, layout) => d.lightmaps()?.applyChunk(id, cx, cz, layout, group),
    chunkDropped: (id, cx, cz) => d.lightmaps()?.releaseChunk(id, cx, cz),
    precompile: (probe) => d.precompile(probe),
    // A restyle's chunks arrive over several frames: the cached static shadow is drawn again once, after the last.
    restyling: (on) => d.staticShadows?.hold(on),
    // The chunks' drawables join the scene on their own (the view's layer and chunk groups stay outside it).
    place: (chunk, shown) => {
      // Chunks change only by being meshed again (new meshes listed): they cast into the static shadow map.
      if (shown) chunk.traverse((o) => void ((o as THREE.Mesh).isMesh === true && (o.userData[STATIC_CASTER_KEY] = true)));
      for (const o of chunk.children) {
        if (shown) d.listStatic(o);
        else d.unlistStatic(o);
      }
    },
  });
  // Terrains — CDLOD over their tiles' texture arrays. The page's decoded tiles (a game page's, shared with collision), else the adapter's own.
  const ownTiles = d.tiles === undefined ? new TerrainTileStore({ read: d.read, worker: d.meshWorkerUrl !== undefined ? () => createBrowserMeshWorker(d.meshWorkerUrl!, 'thirdlight-terrain') : null }) : null;
  const terrains = new TerrainView({
    tiles: d.tiles ?? ownTiles!,
    place: (mesh, shown) => (shown ? d.listStatic(mesh) : d.unlistStatic(mesh)),
    shapeChanged: () => d.staticShadows?.bump(),
    shapeChangedWithin: (x, y, z, r) => d.staticShadows?.changedWithin(x, y, z, r),
    materials: d.materials,
    changed: () => d.onChange(),
    lodBias: () => d.lodBias(),
    stream: d.stream,
    sun: () => d.sun(),
    horizon: d.horizon,
    ...(d.scatter !== undefined ? { scatter: d.scatter } : {}),
  });
  return { blockView, terrains, ownTiles };
}
