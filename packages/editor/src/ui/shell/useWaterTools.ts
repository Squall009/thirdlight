/**
 * Water bodies in the editor: the Inspector's water section sends its
 * fields as one `setComponent` of the `waterBody` (the backend writes the
 * liquid with it, one undo step), "Add component → Water body" fills it from
 * where the object stands (the scene's voxel world, the object's height as
 * the level, the project's first liquid material), and what the backend
 * reports of each body (filled, drained by a leak and where, its seed
 * blocked) is read from its world's route after every change the feed
 * brings: the Inspector warns, and the Scene view marks where it leaks.
 *
 * The editor never writes the water itself: MCP sends the same commands.
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectedEntity } from '../../session/projection';
import type { StructureMaterialChoice } from '../../session/structure-shape';
import type { ClientRef, ViewportRef } from './commands';

/** A water body as the component holds it. */
export interface WaterBodyValue {
  readonly world: string;
  readonly level: number;
  readonly material: number;
  readonly reach: number;
}

/** A body's state as the world's route answers it. */
export interface WaterBodyState {
  readonly entityId: string;
  readonly status: 'filled' | 'breached' | 'seed_blocked';
  readonly cells: number;
  readonly leaks: ReadonlyArray<{ readonly at: readonly [number, number, number]; readonly kind: 'reach' | 'world'; readonly cells: number }>;
}

export interface WaterTools {
  /** The project's liquid voxel materials (by id). */
  readonly liquids: readonly StructureMaterialChoice[];
  /** A body's state as last read (undefined: not read yet). */
  state(world: string, entityId: string): WaterBodyState | undefined;
  /** One `setComponent` of a body's whole value (without a reach: the component's default). */
  set(entityId: string, value: Omit<WaterBodyValue, 'reach'> & { readonly reach?: number }): Promise<boolean>;
  /** The object becomes a water body where it stands (null: done; else why not). */
  add(entity: ProjectedEntity): Promise<string | null>;
  /** Why the last change was refused (null: none since one was applied). */
  readonly refusal: string | null;
}

interface Deps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  materials: readonly StructureMaterialChoice[];
  entities: readonly ProjectedEntity[];
}

/** The worlds the open scenes' water bodies fill, each once. */
function bodyWorlds(entities: readonly ProjectedEntity[]): string[] {
  const out = new Set<string>();
  for (const e of entities) {
    const w = (e.components['waterBody'] as { world?: unknown } | undefined)?.world;
    if (typeof w === 'string') out.add(w);
  }
  return [...out].sort();
}

export function useWaterTools(deps: Deps): WaterTools {
  const { clientRef, viewportRef } = deps;
  const [states, setStates] = useState<ReadonlyMap<string, readonly WaterBodyState[]>>(new Map());
  const [refusal, setRefusal] = useState<string | null>(null);
  const latest = useRef(deps);
  latest.current = deps;
  const liquids = useMemo(() => deps.materials.filter((m) => m.use === 'liquid').sort((a, b) => a.id - b.id), [deps.materials]);

  const read = useCallback((world: string): void => {
    const v = viewportRef.current;
    if (v === null) return;
    void v.voxelWorlds.info(world).then((info) => {
      const bodies = (info?.['bodies'] as WaterBodyState[] | undefined) ?? null;
      if (bodies !== null) setStates((m) => new Map(m).set(world, bodies));
    });
  }, [viewportRef]);

  // The bodies' worlds read when the scene's bodies change (one made, moved, its level set) and after every voxel change.
  const worlds = bodyWorlds(deps.entities);
  const bodiesKey = JSON.stringify(deps.entities.flatMap((e) => (e.components['waterBody'] === undefined ? [] : [[e.id, e.components['waterBody'], (e.components['transform'] as { position?: unknown } | undefined)?.position]])));
  useEffect(() => {
    for (const w of worlds) read(w);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names every body and its place; the list follows from it
  }, [bodiesKey, read]);
  useEffect(() => {
    const v = viewportRef.current;
    if (v === null) return undefined;
    return v.voxelWorlds.listen((c) => {
      if (bodyWorlds(latest.current.entities).includes(c.world)) read(c.world);
    });
  }, [viewportRef, read]);

  // Where the bodies leak, marked in the Scene view (bodies no longer in the scenes leave theirs).
  useEffect(() => {
    const ids = new Set(latest.current.entities.filter((e) => e.components['waterBody'] !== undefined).map((e) => e.id));
    const marks = [...states.values()].flatMap((list) => list.filter((b) => ids.has(b.entityId)).flatMap((b) => b.leaks.map((l) => ({ entityId: b.entityId, at: l.at }))));
    viewportRef.current?.voxelWorlds.waterLeaks(marks);
  }, [states, bodiesKey, viewportRef]);

  const state = useCallback((world: string, entityId: string) => states.get(world)?.find((b) => b.entityId === entityId), [states]);

  const set = useCallback(async (entityId: string, value: Omit<WaterBodyValue, 'reach'> & { readonly reach?: number }): Promise<boolean> => {
    const c = clientRef.current;
    if (c === null) return false;
    const r = await c.command('setComponent', { entityId, component: 'waterBody', value }, c.projection.revision);
    if (r.ok) {
      setRefusal(null);
      return true;
    }
    const res = r.response as { code?: string; message?: string };
    if (res.code === 'no_change') return true;
    setRefusal(`Water: ${res.message ?? res.code ?? 'refused'}`);
    return false;
  }, [clientRef]);

  const add = useCallback(async (e: ProjectedEntity): Promise<string | null> => {
    const world = latest.current.entities.map((x) => (x.components['voxelWorld'] as { world?: unknown } | undefined)?.world).find((w): w is string => typeof w === 'string');
    if (world === undefined) return 'A water body fills a voxel world: add a voxel world object to the scene first.';
    const liquid = liquids[0];
    if (liquid === undefined) return 'A water body needs a liquid voxel material: make a material whose voxel use is liquid first.';
    if (e.parentId !== undefined && e.parentId !== null) return "A water body is a root object (its position is its seed): move it out of its parent first.";
    const y = (e.components['transform'] as { position?: number[] } | undefined)?.position?.[1] ?? 0;
    // The surface at the object's height, on the half metre the cells are: the object stands in the water it makes.
    const level = Math.round(y * 2) / 2;
    // The reach left out takes the component's default.
    return (await set(e.id, { world, level, material: liquid.id })) ? null : 'The water body was refused (the reason is in the Water section).';
  }, [liquids, set]);

  return { liquids, state, set, add, refusal };
}
