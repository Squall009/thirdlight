/**
 * Vertex paint that no longer fits its model: a reimport changed or removed
 * a painted mesh. The paint stays stored (undoing the reimport brings it
 * back); it is reported here as `paint_mismatch`, and the renderer does not
 * draw it (it checks the same vertex count and position hash).
 *
 * Reads every scene's painted models and instance sets; a model's meshes are
 * read from its current version's file once per file digest.
 */
import { paintableMeshes, readModelGeometry, vertexPaintMismatches, type InstancePaint, type PaintableMesh, type VertexPaintComponent } from '@thirdlight/project-model';

import { sha256Hex } from './digest';
import type { WorkspaceService } from './types';

/** One painted object whose paint does not fit its model. */
export interface PaintMismatchRow {
  readonly sceneId: string;
  readonly entityId: string;
  readonly assetId: string;
  readonly version: number;
  readonly message: string;
}

type Entity = { id: string; name?: string; components: { model?: { asset?: { assetId?: string } }; vertexPaint?: VertexPaintComponent; instances?: { asset?: { assetId?: string }; paint?: InstancePaint } } };
type Asset = { assetId: string; currentVersion?: number; versions?: { version: number }[] };

/** Models' meshes by file digest (a cache's bound: the painted models of one project). */
export type PaintMeshCache = Map<string, readonly Pick<PaintableMesh, 'mesh' | 'vertices' | 'positions'>[] | string>;
const CACHE_MAX = 64;

export function paintMismatches(service: Pick<WorkspaceService, 'readCapturedV3' | 'readBlob'>, projectId: string, cache: PaintMeshCache = new Map()): PaintMismatchRow[] | null {
  const captured = service.readCapturedV3(projectId);
  if (!captured.ok) return null;
  const assets = new Map((((captured.read.content as { assets?: Asset[] } | null)?.assets) ?? []).map((a) => [a.assetId, a]));
  const rows: PaintMismatchRow[] = [];
  for (const scene of (captured.read.scenes ?? []) as { sceneId: string; entities: Entity[] }[]) {
    for (const e of scene.entities) {
      const c = e.components;
      const painted = c.vertexPaint?.meshes ?? c.instances?.paint?.meshes;
      const assetId = c.vertexPaint?.meshes !== undefined ? c.model?.asset?.assetId : c.instances?.asset?.assetId;
      if (painted === undefined || assetId === undefined) continue;
      const a = assets.get(assetId);
      const version = a?.currentVersion ?? a?.versions?.reduce((m, v) => Math.max(m, v.version), 0) ?? 0;
      const named = e.name !== undefined ? `"${e.name}" (${e.id})` : e.id;
      if (version < 1) {
        rows.push({ sceneId: scene.sceneId, entityId: e.id, assetId, version, message: `${named}: its vertex paint is kept but not drawn: the model ${assetId} has no version` });
        continue;
      }
      const blob = service.readBlob(projectId, { assetId, version });
      if (!blob.ok) continue; // a missing file is the missing-files check's report
      let meshes = cache.get(blob.digest);
      if (meshes === undefined) {
        const g = readModelGeometry(blob.bytes);
        meshes = g.ok ? paintableMeshes(g.geometry, sha256Hex).map(({ mesh, vertices, positions }) => ({ mesh, vertices, positions })) : g.message;
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(blob.digest, meshes);
      }
      if (typeof meshes === 'string') {
        rows.push({ sceneId: scene.sceneId, entityId: e.id, assetId, version, message: `${named}: its vertex paint is kept but not drawn: the model ${assetId} v${version} cannot be read (${meshes})` });
        continue;
      }
      const off = vertexPaintMismatches(painted, meshes);
      if (off.length > 0) rows.push({ sceneId: scene.sceneId, entityId: e.id, assetId, version, message: `${named}: vertex paint kept but not drawn on ${assetId} v${version}: ${off.map((m) => m.message).join('; ')} (repaint after removing it, or undo the reimport)` });
    }
  }
  return rows;
}
