/**
 * What the adapter reads of an entity's components before it realizes it:
 * the models, animations and instance sets it loads, and the overrides of
 * its graph materials' parameters (structural reads, no three.js).
 */
import { instanceDensityOf, type InstancePaint, type PathPaintGrid, type VertexPaintMesh } from '@thirdlight/runtime';

import type { MaterialOverridesLike } from './material-library';
import type { InstanceSetRef } from './models';

/** An entity's `materialParams` component (overrides of its graph materials' public parameters). */
export function materialParamsOf(components: unknown): MaterialOverridesLike | null {
  const v = (components as { materialParams?: unknown } | undefined)?.materialParams;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as MaterialOverridesLike) : null;
}

/** An entity's vertex paint on generated meshes (`vertexPaint.paths`: its architecture's or spline's), or undefined. */
export function pathPaintOf(components: unknown): readonly PathPaintGrid[] | undefined {
  const paths = (components as { vertexPaint?: { paths?: unknown } } | undefined)?.vertexPaint?.paths;
  return Array.isArray(paths) && paths.length > 0 ? (paths as PathPaintGrid[]) : undefined;
}

/** The model, animation and instance-set references of some entities (structural reads), and the models' vertex paint. */
export function modelRefsOf(entities: readonly { id: string; components: unknown }[]): {
  models: Map<string, string>;
  pieces: Map<string, string>;
  animations: Map<string, { readonly assetId: string; readonly version: number }>;
  instances: Map<string, InstanceSetRef>;
  paints: Map<string, readonly VertexPaintMesh[]>;
} {
  const paints = new Map<string, readonly VertexPaintMesh[]>();
  const models = new Map<string, string>();
  const pieces = new Map<string, string>();
  const animations = new Map<string, { readonly assetId: string; readonly version: number }>();
  const instances = new Map<string, InstanceSetRef>();
  for (const e of entities) {
    const comps = e.components as {
      model?: { asset?: { assetId?: unknown }; piece?: unknown };
      modelAnimation?: { assetId?: unknown; version?: unknown };
      instances?: { asset?: { assetId?: unknown; piece?: unknown }; buffer?: unknown; count?: unknown; chunkSize?: unknown; densityStart?: unknown; densityEnd?: unknown; densityMin?: unknown; lodPerCopy?: unknown; paint?: InstancePaint };
      vertexPaint?: { meshes?: unknown };
    };
    if (comps.model !== undefined && typeof comps.model.asset?.assetId === 'string') {
      models.set(e.id, comps.model.asset.assetId);
      if (typeof comps.model.piece === 'string') pieces.set(e.id, comps.model.piece);
      const meshes = comps.vertexPaint?.meshes;
      if (Array.isArray(meshes) && meshes.length > 0) paints.set(e.id, meshes as VertexPaintMesh[]);
    }
    if (comps.modelAnimation !== undefined && typeof comps.modelAnimation.assetId === 'string' && Number.isInteger(comps.modelAnimation.version)) {
      animations.set(e.id, { assetId: comps.modelAnimation.assetId, version: comps.modelAnimation.version as number });
    }
    const inst = comps.instances;
    if (inst !== undefined && typeof inst.asset?.assetId === 'string' && typeof inst.buffer === 'string' && Number.isInteger(inst.count)) {
      const piece = typeof inst.asset.piece === 'string' ? inst.asset.piece : undefined;
      instances.set(e.id, { assetId: inst.asset.assetId, ...(piece !== undefined ? { piece } : {}), buffer: inst.buffer, count: inst.count as number, ...(typeof inst.chunkSize === 'number' ? { chunkSize: inst.chunkSize } : {}), density: instanceDensityOf(inst), ...(inst.lodPerCopy === true ? { lodPerCopy: true } : {}), ...(inst.paint !== undefined ? { paint: inst.paint } : {}) });
    }
  }
  return { models, pieces, animations, instances, paints };
}

