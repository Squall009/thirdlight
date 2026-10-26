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
import type { SceneLights } from './lights-shadows';
import type { SceneAdapterModelAsset } from './models';
import type { RenderGraph } from './render-graph';
import type { CacheLight } from './surface-changes';
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

/**
 * The page's point, spot and directional lights as the cache's change
 * tracking reads them (once a frame; their world matrices as last drawn).
 */
export function surfaceLightsOf(lights: SceneLights): CacheLight[] {
  const out: CacheLight[] = [];
  lights.forEachLight((id, kind, light, direction) => {
    if (kind !== 'point' && kind !== 'spot' && kind !== 'directional') return;
    const m = light.matrixWorld.elements;
    const k = light.intensity;
    const color = [light.color.r * k, light.color.g * k, light.color.b * k];
    const on = light.visible;
    if (kind === 'directional') {
      // Toward the light: against the way its light travels.
      const d = direction ?? [0, -1, 0];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
      out.push({ id, kind, on, position: [m[12]!, m[13]!, m[14]!], direction: [-d[0]! / l, -d[1]! / l, -d[2]! / l], color, range: 0, cone: 0, penumbra: 0 });
      return;
    }
    const spot = kind === 'spot' ? (light as THREE.SpotLight) : null;
    // A spot's axis: toward its target (a child of the light, placed and turned with it).
    let axis = [0, -1, 0];
    if (spot !== null) {
      const t = spot.target.matrixWorld.elements;
      const a = [t[12]! - m[12]!, t[13]! - m[13]!, t[14]! - m[14]!];
      const l = Math.hypot(a[0]!, a[1]!, a[2]!);
      if (l > 1e-9) axis = [a[0]! / l, a[1]! / l, a[2]! / l];
    }
    out.push({
      id,
      kind,
      on,
      position: [m[12]!, m[13]!, m[14]!],
      direction: axis,
      color,
      range: (light as THREE.PointLight).distance ?? 0,
      cone: spot === null ? 0 : Math.cos(spot.angle),
      penumbra: spot?.penumbra ?? 0,
    });
  });
  return out;
}
