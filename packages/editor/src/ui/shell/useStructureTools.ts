/**
 * The structure mode's wiring: the Scene view's structure tool armed by the
 * mode (or by GameObject → Structure, to draw a new building), its gestures
 * sent as the existing commands — `createEntity` with a `voxelStructure`,
 * `setComponent` for the definition, `setTransform` for a turn, `editVoxels`
 * on the structure's grid for a hand-edit stroke — and what the mode reads
 * back: the world's route (each grid's hand-edit count and last regenerate's
 * misfits), the tool's live readout and the last refusal; and the openings'
 * props: the project's models with their bounds (the prop picker's fit), a
 * prop put in an opening (`createEntity` of a child with a `voxelPortal`,
 * the backend names it in the opening) or taken out (`deleteEntity`), its
 * glass flag (`setComponent`).
 *
 * The editor never writes voxels itself: MCP sends the same commands.
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';
import { resolvedVoxelParts } from '@thirdlight/project-model/voxel-materials';
import { ASSET_QUERY_PAGE_MAX } from '@thirdlight/project-model/limits';
import { VOXEL_SIZE_M, type StructureDefinition, type StructureOpening } from '@thirdlight/voxel';

import type { ProjectedEntity } from '../../session/projection';
import { propPlacement, type PropAsset } from '../../session/structure-openings';
import { defaultMaterials, definitionOf, newStructure, NO_CONSTRUCTION_MATERIAL, yawRotation, type MisfitLike, type StructureMaterialChoice, type StructureValue } from '../../session/structure-shape';
import type { StructureArm } from '../../viewport/structure-tool';
import type { ClientRef, SetNotice, ViewportRef } from './commands';

/** A grid as the world's route answers it (what the mode reads). */
export interface StructureGridInfo {
  readonly id: number;
  /** Cells its hand edits hold. */
  readonly overrides: number;
  readonly lastRegenerate?: { readonly misfits: readonly (MisfitLike & { readonly at: readonly number[] | null })[]; readonly kept: number; readonly absorbed: number };
}

export interface StructureTools {
  /** GameObject → Structure: the pointer draws a rectangle on the ground (Esc leaves it). */
  startCreate(): void;
  /** Arm the tool for the mode (null: off). */
  arm(a: Omit<StructureArm, 'world'> & { world?: string } | null): void;
  /** The project's voxel materials a structure may use (construction ones first, by id). */
  readonly materials: readonly StructureMaterialChoice[];
  /** One `setComponent` of a structure's whole value (the backend completes and regenerates it). */
  define(entityId: string, value: StructureValue, def: StructureDefinition): Promise<boolean>;
  /** `regenerateStructures`: every structure an older generator wrote, one step. */
  regenerateAll(): Promise<void>;
  /** The world's grids as last read (by world, then grid id), read again after every change the feed brings. */
  grids(world: string): ReadonlyMap<number, StructureGridInfo> | null;
  /** Read a world's route again now. */
  refresh(world: string): void;
  /** What the tool's drag would make, live (null: nothing in flight). */
  readonly readout: string | null;
  /** Why the last gesture was not sent (null: none since the last one sent). */
  readonly refusal: string | null;
  /** Drawing a new building on the ground is armed. */
  readonly creating: boolean;
  /** The misfit picked in the list (its marker draws in the view), and picking one (null: none). */
  readonly picked: { readonly entityId: string; readonly misfit: MisfitLike } | null;
  pick(p: { entityId: string; misfit: MisfitLike } | null): void;
  /** The open scenes' objects (an opening's prop is one: its name and state). */
  readonly entities: readonly ProjectedEntity[];
  /** The opening selected in the view or the list (null: none). */
  readonly opening: { readonly entityId: string; readonly id: string } | null;
  selectOpening(o: { entityId: string; id: string } | null): void;
  /** The project's models as the prop picker reads them (read again after every asset change; null: not read yet). */
  readonly propAssets: readonly PropAsset[] | null;
  /** Put a model in an opening as its prop (null: none, an open hole), replacing the prop it has; `glass`: light passes it while shut. */
  setProp(structureId: string, value: StructureValue, opening: StructureOpening, asset: PropAsset | null, glass: boolean): Promise<void>;
  /** A prop's glass flag (its `voxelPortal`'s `stops.light` the other way round). */
  setGlass(propId: string, glass: boolean): Promise<void>;
}

interface Deps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  materials: readonly MaterialDef[];
  entities: readonly ProjectedEntity[];
  /** The scene new objects go into. */
  sceneId: string | null;
  setNotice: SetNotice;
  /** Open the new structure's mode (false: it has none, e.g. the projection is behind). */
  created: (entityId: string) => void;
}

/** What drawing a new building asks for (the notice over the view while it is armed). */
const CREATE_HINT = 'Drag a rectangle on the ground to draw the building (Esc leaves).';

/** The voxel worlds the open scenes' `voxelWorld` objects name (the first, a new building's). */
function worldsOf(entities: readonly ProjectedEntity[]): string[] {
  const out: string[] = [];
  for (const e of entities) {
    const w = (e.components['voxelWorld'] as { world?: unknown } | undefined)?.world;
    if (typeof w === 'string' && !out.includes(w)) out.push(w);
  }
  return out;
}

export function useStructureTools(deps: Deps): StructureTools {
  const { clientRef, viewportRef, setNotice } = deps;
  const [readout, setReadout] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [picked, pick] = useState<{ entityId: string; misfit: MisfitLike } | null>(null);
  const [infos, setInfos] = useState<ReadonlyMap<string, ReadonlyMap<number, StructureGridInfo>>>(new Map());
  const [opening, selectOpening] = useState<{ entityId: string; id: string } | null>(null);
  const [propAssets, setPropAssets] = useState<readonly PropAsset[] | null>(null);
  const latest = useRef(deps);
  latest.current = deps;
  /** The structure the tool is armed on (what an opening picked in the view belongs to). */
  const armedRef = useRef<string | null>(null);

  const materials = useMemo((): StructureMaterialChoice[] => {
    const parts = resolvedVoxelParts(deps.materials);
    const out: StructureMaterialChoice[] = [];
    for (const m of deps.materials) {
      const v = parts.get(m.materialId);
      if (v === undefined || v.use === undefined || out.some((x) => x.id === v.id)) continue;
      out.push({ id: v.id, name: m.name, use: v.use });
    }
    return out.sort((a, b) => (a.use === 'construction' ? 0 : 1) - (b.use === 'construction' ? 0 : 1) || a.id - b.id);
  }, [deps.materials]);
  const materialsRef = useRef(materials);
  materialsRef.current = materials;

  /** A command's refusal said where the mode shows it; true when it was applied. */
  const run = useCallback(async (what: string, op: string, args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (c === null) return false;
    const r = await c.command(op, args, c.projection.revision);
    if (r.ok) {
      setRefusal(null);
      return true;
    }
    const res = r.response as { code?: string; message?: string };
    // A drag that ends where it began changes nothing: not a refusal worth saying.
    if (res.code === 'no_change') return true;
    setRefusal(`${what}: ${res.message ?? res.code ?? 'refused'}`);
    return false;
  }, [clientRef]);

  const refresh = useCallback((world: string): void => {
    const v = viewportRef.current;
    if (v === null) return;
    void v.voxelWorlds.info(world).then((info) => {
      const grids = (info?.['grids'] as StructureGridInfo[] | undefined) ?? null;
      if (grids === null) return;
      setInfos((m) => new Map(m).set(world, new Map(grids.map((g) => [g.id, g]))));
    });
  }, [viewportRef]);

  // Every change the feed brings (a stroke, its undo, a regenerate) reads the changed world's route again.
  useEffect(() => {
    const v = viewportRef.current;
    if (v === null) return undefined;
    return v.voxelWorlds.listen((c) => {
      if (infos.has(c.world)) refresh(c.world);
    });
  }, [viewportRef, refresh, infos]);

  const callbacks = useMemo(() => ({
    create: async (world: string, corner: readonly [number, number, number], w: number, d: number): Promise<void> => {
      const mats = defaultMaterials(materialsRef.current);
      if (mats === null) {
        setRefusal(NO_CONSTRUCTION_MATERIAL);
        return;
      }
      const c = clientRef.current;
      if (c === null) return;
      const { value, offset } = newStructure(world, w, d, mats);
      // The object stands where the anchored grid's cell 0 goes, so the drawn rectangle is where the walls rise.
      const position = [corner[0] - offset * VOXEL_SIZE_M, corner[1], corner[2] - offset * VOXEL_SIZE_M];
      const sceneId = latest.current.sceneId;
      const r = await c.command('createEntity', { ...(sceneId !== null ? { sceneId } : {}), parentId: null, kind: 'group', name: 'Structure', transform: { position }, components: { voxelStructure: value } }, c.projection.revision);
      setCreating(false);
      viewportRef.current?.voxelWorlds.structureTool(null, null);
      if (!r.ok || r.createdId === undefined) {
        const res = r.ok ? { message: 'no object made' } : (r.response as { message?: string; code?: string });
        setNotice(`New structure: ${res.message ?? 'refused'}`);
        return;
      }
      setRefusal(null);
      refresh(world);
      latest.current.created(r.createdId);
    },
    define: async (entityId: string, def: StructureDefinition): Promise<void> => {
      const e = latest.current.entities.find((x) => x.id === entityId);
      const cur = e?.components['voxelStructure'] as StructureValue | undefined;
      if (cur === undefined) return;
      await run('Structure', 'setComponent', { entityId, component: 'voxelStructure', value: { ...def, world: cur.world, grid: cur.grid } });
      refresh(cur.world);
    },
    place: async (entityId: string, position: readonly number[], yawRad: number): Promise<void> => {
      await run('Turn', 'setTransform', { entityId, transform: { position: [...position], rotation: yawRotation(yawRad) } });
    },
    stroke: async (entityId: string, command: Record<string, unknown>): Promise<void> => {
      const e = latest.current.entities.find((x) => x.id === entityId);
      const world = (e?.components['voxelStructure'] as StructureValue | undefined)?.world;
      if (world === undefined) return;
      await run('Hand edit', 'editVoxels', { world, command });
      refresh(world);
    },
    refused: (m: string) => setRefusal(m),
    readout: (t: string | null) => setReadout(t),
    selectOpening: (id: string | null) => {
      const a = armedRef.current;
      selectOpening(id === null || a === null ? null : { entityId: a, id });
    },
  }), [clientRef, viewportRef, run, refresh, setNotice]);

  const arm = useCallback((a: (Omit<StructureArm, 'world'> & { world?: string }) | null): void => {
    armedRef.current = a?.entityId ?? null;
    const v = viewportRef.current;
    if (v === null) return;
    if (a === null) {
      v.voxelWorlds.structureTool(null, null);
      return;
    }
    const world = a.world ?? (a.value as StructureValue | null)?.world ?? '';
    v.voxelWorlds.structureTool({ ...a, world }, callbacks);
  }, [viewportRef, callbacks]);

  const startCreate = useCallback((): void => {
    const v = viewportRef.current;
    const world = worldsOf(latest.current.entities)[0];
    if (v === null) return;
    if (world === undefined) {
      setNotice('A structure is built in a voxel world: add a voxel world object to the scene first.');
      return;
    }
    if (defaultMaterials(materialsRef.current) === null) {
      setNotice(NO_CONSTRUCTION_MATERIAL);
      return;
    }
    setCreating(true);
    setNotice(CREATE_HINT, 'info');
    v.voxelWorlds.structureTool({ tool: 'create', navigate: false, world, entityId: null, value: null, store: null, brushShape: 'box', voxel: null, marker: null }, {
      ...callbacks,
      create: async (...args) => {
        setNotice(null);
        await callbacks.create(...args);
      },
      // No mode is open yet: what the drag would make and why it was refused show in the notice over the view.
      refused: (m: string) => setNotice(m),
      readout: (t: string | null) => setNotice(t === null ? CREATE_HINT : `${CREATE_HINT} ${t}`, 'info'),
    });
  }, [viewportRef, callbacks, setNotice]);

  // Esc while drawing a new building (no gesture in flight) leaves it.
  useEffect(() => {
    if (!creating) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setCreating(false);
      setNotice(null);
      viewportRef.current?.voxelWorlds.structureTool(null, null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating, viewportRef, setNotice]);

  const define = useCallback(async (entityId: string, value: StructureValue, def: StructureDefinition): Promise<boolean> => {
    const ok = await run('Structure', 'setComponent', { entityId, component: 'voxelStructure', value: { ...def, world: value.world, grid: value.grid } });
    refresh(value.world);
    return ok;
  }, [run, refresh]);

  const regenerateAll = useCallback(async (): Promise<void> => {
    await run('Regenerate all', 'regenerateStructures', {});
    for (const w of worldsOf(latest.current.entities)) refresh(w);
  }, [run, refresh]);

  const grids = useCallback((world: string) => infos.get(world) ?? null, [infos]);

  // The project's models with their bounds (the prop picker), read page by page each time an opening is selected.
  useEffect(() => {
    const c = clientRef.current;
    if (c === null || opening === null) return undefined;
    let live = true;
    void (async () => {
      const out: PropAsset[] = [];
      for (let offset = 0; ; offset += ASSET_QUERY_PAGE_MAX) {
        const r = await c.queryAssets({ limit: ASSET_QUERY_PAGE_MAX, offset }).catch(() => null);
        if (r === null || !r.ok) return;
        for (const a of r.assets) if (a.kind === 'model') out.push({ assetId: a.assetId, displayName: a.displayName, bounds: a.bounds ?? null });
        if (r.assets.length < ASSET_QUERY_PAGE_MAX) break;
      }
      if (live) setPropAssets(out);
    })();
    return () => {
      live = false;
    };
  }, [clientRef, opening]);

  const setProp = useCallback(async (structureId: string, value: StructureValue, o: StructureOpening, asset: PropAsset | null, glass: boolean): Promise<void> => {
    const c = clientRef.current;
    if (c === null) return;
    const old = o.prop === undefined ? undefined : latest.current.entities.find((e) => e.id === o.prop);
    if (old !== undefined && !(await run('Prop', 'deleteEntity', { entityId: old.id }))) return;
    if (asset === null) return;
    const at = propPlacement(definitionOf(value), o, asset.bounds);
    if (at === null) return;
    const sceneId = latest.current.sceneId;
    await run('Prop', 'createEntity', { ...(sceneId !== null ? { sceneId } : {}), parentId: structureId, kind: 'model', name: `${asset.displayName} (${o.id})`, model: { asset: { assetId: asset.assetId } }, transform: { position: at.position, rotation: at.rotation, scale: [1, 1, 1] }, components: { voxelPortal: { open: false, stops: { light: !glass, sight: true, walk: true } } } });
  }, [clientRef, run]);

  const setGlass = useCallback(async (propId: string, glass: boolean): Promise<void> => {
    const e = latest.current.entities.find((x) => x.id === propId);
    const portal = e?.components['voxelPortal'] as { open: boolean; stops: { light: boolean; sight: boolean; walk: boolean } } | undefined;
    if (portal === undefined) return;
    await run('Glass', 'setComponent', { entityId: propId, component: 'voxelPortal', value: { ...portal, stops: { ...portal.stops, light: !glass } } });
  }, [run]);

  return { startCreate, arm, materials, define, regenerateAll, grids, refresh, readout, refusal, creating, picked, pick, opening, selectOpening, propAssets, setProp, setGlass, entities: deps.entities };
}
