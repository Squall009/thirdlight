/**
 * Splines that write voxels, in the editor: the Inspector's spline section
 * sends its `voxels` settings as one `setComponent` of the spline (the
 * backend writes the road or river with it, one undo step; moving a point
 * with the spline's handles is the same command, sent when the drag ends),
 * and what the backend reports of each spline's last write (the cells it
 * holds, cells left alone because someone edited them since, hand edits the
 * fit rule could not keep) is read from its world's route after every
 * change the feed brings: the Inspector lists them, and the Scene view
 * marks where they are.
 *
 * The editor never writes the voxels itself: MCP sends the same commands.
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { voxelUseTakesKit } from '@thirdlight/project-model/voxel-materials';
import type { ProjectedEntity } from '../../session/projection';
import type { StructureMaterialChoice } from '../../session/structure-shape';
import type { ClientRef, ViewportRef } from './commands';

/** A spline's `voxels` section as the component holds it. */
export interface SplineVoxelsValue {
  readonly kind: 'road' | 'path' | 'river';
  readonly material: number;
  readonly bed?: { readonly material: number; readonly depth: number };
  readonly shoulder?: { readonly width: number; readonly slope: number };
  readonly clear?: number;
}

/** A cell the last write reports, with its place in the scene (metres, the cell's middle). */
export interface SplineReportedCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly at: readonly [number, number, number];
}

/** A spline's state as the world's route answers it. */
export interface SplineVoxelState {
  readonly entityId: string;
  /** Cells its record holds, and the record's bytes. */
  readonly written: number;
  readonly recordBytes: number;
  readonly lastWrite?: {
    readonly cells: number;
    readonly putBack: number;
    readonly kept: number;
    readonly absorbed: number;
    readonly leftAlone: readonly SplineReportedCell[];
    readonly misfits: readonly SplineReportedCell[];
  };
}

export interface SplineVoxelTools {
  /** The materials a road or path is made of (not liquid), and a river's (liquid), by id. */
  readonly solids: readonly StructureMaterialChoice[];
  readonly liquids: readonly StructureMaterialChoice[];
  /** The world the spline's scene writes into (null: its scene names none, or several). */
  world(): string | null;
  /** A spline's state as last read (undefined: not read yet). */
  state(entityId: string): SplineVoxelState | undefined;
  /** One `setComponent` of the spline with `voxels` (null: the section removed, what it wrote put back). */
  set(entity: ProjectedEntity, voxels: SplineVoxelsValue | null): Promise<boolean>;
  /** Why the last change was refused (null: none since one was applied). */
  readonly refusal: string | null;
}

interface Deps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  materials: readonly StructureMaterialChoice[];
  entities: readonly ProjectedEntity[];
}

/** The one voxel world the open scenes name (a spline writes into its scene's one world). */
function sceneWorld(entities: readonly ProjectedEntity[]): string | null {
  const names = new Set<string>();
  for (const e of entities) {
    const w = (e.components['voxelWorld'] as { world?: unknown } | undefined)?.world;
    if (typeof w === 'string') names.add(w);
  }
  return names.size === 1 ? [...names][0]! : null;
}

const voxelSplines = (entities: readonly ProjectedEntity[]): ProjectedEntity[] => entities.filter((e) => (e.components['spline'] as { voxels?: unknown } | undefined)?.voxels !== undefined);

export function useSplineVoxelTools(deps: Deps): SplineVoxelTools {
  const { clientRef, viewportRef } = deps;
  const [states, setStates] = useState<readonly SplineVoxelState[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const latest = useRef(deps);
  latest.current = deps;
  const solids = useMemo(() => deps.materials.filter((m) => voxelUseTakesKit(m.use)).sort((a, b) => a.id - b.id), [deps.materials]);
  const liquids = useMemo(() => deps.materials.filter((m) => m.use === 'liquid').sort((a, b) => a.id - b.id), [deps.materials]);

  const read = useCallback((): void => {
    const v = viewportRef.current;
    const world = sceneWorld(latest.current.entities);
    if (v === null || world === null) return;
    void v.voxelWorlds.info(world).then((info) => {
      const splines = (info?.['splines'] as SplineVoxelState[] | undefined) ?? null;
      if (splines !== null) setStates(splines);
    });
  }, [viewportRef]);

  // Read again when the scene's voxel splines change, and after every voxel change of their world.
  const key = JSON.stringify(voxelSplines(deps.entities).map((e) => [e.id, e.components['spline'], (e.components['transform'] as { position?: unknown } | undefined)?.position]));
  useEffect(() => {
    if (key !== '[]') read();
  }, [key, read]);
  useEffect(() => {
    const v = viewportRef.current;
    if (v === null) return undefined;
    return v.voxelWorlds.listen((c) => {
      if (c.world === sceneWorld(latest.current.entities) && voxelSplines(latest.current.entities).length > 0) read();
    });
  }, [viewportRef, read]);

  // The cells left alone and the misfits of the splines in the scenes, marked in the Scene view.
  useEffect(() => {
    const ids = new Set(voxelSplines(latest.current.entities).map((e) => e.id));
    const marks = states.filter((s) => ids.has(s.entityId)).flatMap((s) => [...(s.lastWrite?.leftAlone ?? []), ...(s.lastWrite?.misfits ?? [])].map((c) => ({ entityId: s.entityId, at: c.at })));
    viewportRef.current?.voxelWorlds.splineMarks(marks);
  }, [states, key, viewportRef]);

  const state = useCallback((entityId: string) => states.find((s) => s.entityId === entityId), [states]);
  const world = useCallback(() => sceneWorld(latest.current.entities), []);

  const set = useCallback(async (entity: ProjectedEntity, voxels: SplineVoxelsValue | null): Promise<boolean> => {
    const c = clientRef.current;
    const spline = entity.components['spline'] as Record<string, unknown> | undefined;
    if (c === null || spline === undefined) return false;
    const { voxels: _was, ...rest } = spline;
    const value = voxels === null ? rest : { ...rest, voxels };
    const r = await c.command('setComponent', { entityId: entity.id, component: 'spline', value }, c.projection.revision);
    if (r.ok) {
      setRefusal(null);
      return true;
    }
    const res = r.response as { code?: string; message?: string };
    if (res.code === 'no_change') return true;
    setRefusal(`Voxels: ${res.message ?? res.code ?? 'refused'}`);
    return false;
  }, [clientRef]);

  return { solids, liquids, world, state, set, refusal };
}
