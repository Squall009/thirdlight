/**
 * The adapter's surface cache (`surface-cache-host.ts`): fed from the level
 * views (block layers, terrains, architecture) and the static model objects
 * the entities realized, with their rows' distance-field files.
 */
import type * as THREE from 'three';
import { DEFAULT_SURFACE_CACHE_MIB } from '@thirdlight/runtime';

import type { AdapterEntities, EntityDoc } from './adapter-entities';
import type { AdapterLevel } from './adapter-level';
import type { SceneAdapterOptions } from './adapter-types';
import type { SceneAdapterModelAsset } from './models';
import type { RenderGraph } from './render-graph';
import { SURFACE_CACHE_KEY, SurfaceCacheHost, type SurfaceHostModel } from './surface-cache-host';

/** Bytes in a MiB (the quality level names its budget in MiB). */
const MIB = 1024 * 1024;

export function createAdapterSurfaceCache(d: { opts: SceneAdapterOptions; scene: THREE.Scene; level: AdapterLevel; entities: AdapterEntities; docs: ReadonlyMap<string, EntityDoc>; graph: RenderGraph; matrix: THREE.Matrix4 }): SurfaceCacheHost | null {
  const { opts, level, entities, docs, graph } = d;
  if (opts.surfaceCache === false) return null;
  let rows: Map<string, SceneAdapterModelAsset> | null = null;
  const rowOf = (assetId: string): SceneAdapterModelAsset | undefined => {
    rows ??= new Map((opts.models?.assets ?? []).map((a) => [a.assetId, a]));
    return rows.get(assetId) ?? opts.models?.rowOf?.(assetId);
  };
  const models = (): SurfaceHostModel[] => {
    const out: SurfaceHostModel[] = [];
    for (const id of entities.staticScopes.keys()) {
      const model = (docs.get(id)?.components as { model?: { asset?: { assetId?: string }; piece?: string } } | undefined)?.model;
      const assetId = model?.asset?.assetId;
      if (assetId === undefined) continue;
      const row = rowOf(assetId);
      if (row?.bricks !== true || !graph.worldMatrixOf(id, d.matrix)) continue;
      out.push({ id, assetId, version: row.version, piece: model?.piece ?? null, world: d.matrix.elements.slice() });
    }
    return out;
  };
  const host = new SurfaceCacheHost(
    {
      layers: () => level.blockView.drawnLayers().map((l) => ({ id: l.id, origin: l.origin, grid: l.grid, version: l.surfaceVersion, chunks: l.chunks, opaque: l.opaque })),
      terrains: () => level.terrains.ids().flatMap((id) => {
        const field = level.terrains.field(id);
        return field !== null ? [{ id, field }] : [];
      }),
      architecture: () => level.architecture.surfaceObjects(),
      models,
      bricks: (assetId, version) => opts.models?.resolveBricks?.(assetId, version) ?? null,
    },
    DEFAULT_SURFACE_CACHE_MIB * MIB,
  );
  d.scene.userData[SURFACE_CACHE_KEY] = { diagnostics: () => host.diagnostics() };
  return host;
}

/** A level's surface-cache budget in bytes. */
export function surfaceCacheBytes(mib: number | undefined): number {
  return (mib ?? DEFAULT_SURFACE_CACHE_MIB) * MIB;
}
