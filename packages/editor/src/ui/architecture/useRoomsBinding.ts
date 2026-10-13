/**
 * The rooms drawn on a block layer, bound for its block editor's Rooms &
 * buildings mode: the
 * generated-architecture object whose `architecture.layer` names the layer
 * (the first such object; none until the first room is drawn), expanded with
 * the project's styles for the room plans, the walls' cell edges, buildings'
 * generated rooms and furnished props, the project's room programs and
 * furnishing sets, and the
 * commands that store it (a new object at the layer's place, in one
 * `createEntity`) or preview it in the Scene view while a wall is dragged.
 */
import { useMemo } from 'react';
import type { ArchitectureComponent, ArchitectureElement, ArchitectureOutline, ArchitectureRoomPlan, BlockLayerComponent, FurnishedProp, GraphDocument } from '@thirdlight/project-model';
import { ARCHITECTURE_PRESET_KIND, architectureGraphsOf, architectureStylesOf, architectureWallEdges, expandArchitecture, FURNISHING_SET_KIND, ROOM_PROGRAM_KIND } from '@thirdlight/runtime';

import type { ProjectedEntity } from '../../session/projection';
import type { ClientRef, ReportFailure, ViewportRef } from '../shell/commands';
import { withPresetSwapped } from '../../session/room-draw';
import { presetChoices } from './PresetSliders';
import { waitFor } from '../wait-for';

/** The rooms object of a layer as the block editor binds it. */
export interface RoomsBinding {
  /** The object (null: none yet: the first room makes it). */
  entityId: string | null;
  component: ArchitectureComponent | null;
  /** Its place (the layer's for a new one), and the layer's. */
  origin: readonly number[];
  layerOrigin: readonly number[];
  /** Its elements as expanded (the rooms' generated walls, which wall and corner pieces go on). */
  elements: readonly ArchitectureElement[];
  /** Each room storey's floor plan (expanded: floors and wall tops). */
  plans: readonly ArchitectureRoomPlan[];
  /** Buildings' furnished and pinned props, and the rooms their programs made (expanded). */
  props: readonly FurnishedProp[];
  planRooms: readonly ArchitectureOutline[];
  /** The project's room programs and furnishing sets: [id, name]. */
  programs: readonly (readonly [string, string])[];
  furnishings: readonly (readonly [string, string])[];
  /** The cell edges the rooms' walls stand on (the paint brush reaches their faces). */
  walls: ReadonlyMap<number, boolean> | null;
  /** Every preset: [id, name]. */
  presets: readonly (readonly [string, string])[];
  /** The project's scenes ([id, name]) and the one the rooms are in (a building's interior goes in another). */
  scenes: readonly (readonly [string, string])[];
  sceneId: string | null;
  /** Make a new scene named so (resolves its id; null: refused). */
  createScene(name: string): Promise<string | null>;
  /** Store the rooms (making the object on the first room). */
  setRooms(next: ArchitectureComponent, what: string): Promise<boolean>;
  /** Draw the object as `next` without storing it (null: as stored). */
  preview(entityId: string, next: ArchitectureComponent | null): void;
  /**
   * A project preset deriving from `base` (an engine starter), worn by every room of `base` (resolves its id; null:
   * refused); `via`: the client of the grouped action it is part of.
   */
  derive(base: string, via?: ClientRef): Promise<string | null>;
}

const NO_ELEMENTS: readonly ArchitectureElement[] = Object.freeze([]);

const NO_POSITION: readonly number[] = Object.freeze([0, 0, 0]);

export function useRoomsBinding(layer: ProjectedEntity | null, entities: readonly ProjectedEntity[], graphs: readonly GraphDocument[], clientRef: ClientRef, viewportRef: ViewportRef, reportFailure: ReportFailure): RoomsBinding | undefined {
  const comp = layer?.components['blockLayer'] as BlockLayerComponent | undefined;
  const rooms = layer === null || comp === undefined ? undefined : entities.find((e) => (e.components['architecture'] as ArchitectureComponent | undefined)?.layer === layer.id);
  const component = (rooms?.components['architecture'] as ArchitectureComponent | undefined) ?? null;
  const layerOrigin = layer?.position ?? NO_POSITION;
  const origin = rooms?.position ?? layerOrigin;
  const table = useMemo(() => architectureStylesOf(architectureGraphsOf(graphs)), [graphs]);
  const expanded = useMemo(() => (component === null ? null : expandArchitecture(component, origin, table)), [component, origin, table]);
  const walls = useMemo(() => {
    if (expanded === null || comp === undefined) return null;
    return architectureWallEdges(expanded.component, [0, 1, 2].map((i) => (origin[i] ?? 0) - (layerOrigin[i] ?? 0)), comp.cellSize);
  }, [expanded, comp, origin, layerOrigin]);
  const presets = useMemo(() => presetChoices(graphs), [graphs]);
  const programs = useMemo(() => graphs.filter((g) => g.kind === ROOM_PROGRAM_KIND).map((g) => [g.graphId, g.name] as const), [graphs]);
  const furnishings = useMemo(() => graphs.filter((g) => g.kind === FURNISHING_SET_KIND).map((g) => [g.graphId, g.name] as const), [graphs]);
  if (layer === null || comp === undefined) return undefined;
  const roomsId = rooms?.id ?? null;
  const scenes = (clientRef.current?.projection.scenes ?? []).map((r) => [r.sceneId, r.name] as const);
  return {
    entityId: roomsId,
    component,
    origin,
    layerOrigin,
    plans: expanded?.rooms ?? [],
    props: expanded?.props ?? [],
    planRooms: expanded?.planRooms ?? [],
    programs,
    furnishings,
    elements: expanded?.component.elements ?? NO_ELEMENTS,
    walls,
    presets,
    scenes,
    sceneId: rooms?.sceneId ?? layer.sceneId ?? null,
    async createScene(name) {
      const c = clientRef.current;
      if (!c) return null;
      const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'interior';
      const taken = new Set(c.projection.scenes.map((r) => r.sceneId));
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      const r = await c.command('createScene', { sceneId: id, name }, c.projection.revision);
      reportFailure('New interior scene', r);
      // The index arrives with the change: the building is stored against the revision that has the scene.
      return r.ok ? waitFor(() => (c.projection.scenes.some((x) => x.sceneId === id) ? id : null)) : null;
    },
    async setRooms(next, what) {
      const c = clientRef.current;
      if (!c) return false;
      if (roomsId !== null) {
        // setComponent replaces the fields it names: a field the change drops (the last room, a stored plan) is named null.
        const dropped = Object.fromEntries(Object.keys(component ?? {}).filter((k) => !(k in next)).map((k) => [k, null]));
        const r = await c.setComponent(roomsId, 'architecture', { ...next, ...dropped }, c.projection.revision);
        reportFailure(what, r);
        return r.ok;
      }
      const r = await c.command('createEntity', { parentId: null, kind: 'group', name: `${layer.name} rooms`, transform: { position: [...layerOrigin] }, components: { architecture: next } }, c.projection.revision);
      reportFailure(what, r);
      return r.ok;
    },
    preview(entityId, next) {
      viewportRef.current?.previewComponent(entityId, 'architecture', next);
    },
    derive: (base, via) => derivePreset(via ?? clientRef, graphs, presets, base, roomsId, reportFailure),
  };
}

/**
 * A project preset deriving from `base` (an engine starter: its sliders
 * read-only), worn in its place by every room of rooms object `roomsId`
 * (null: none yet). Two commands: callers run it as one undo step.
 * Resolves the new preset's id (null: refused).
 */
export async function derivePreset(clientRef: ClientRef, graphs: readonly GraphDocument[], presets: readonly (readonly [string, string])[], base: string, roomsId: string | null, reportFailure: ReportFailure): Promise<string | null> {
  const c = clientRef.current;
  if (!c) return null;
  const ids = new Set(graphs.map((g) => g.graphId));
  let id = `${base}-1`;
  for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
  const name = `${presets.find(([p]) => p === base)?.[1] ?? base} (own)`;
  const made = await c.command('setGraph', { graph: { graphId: id, kind: ARCHITECTURE_PRESET_KIND, name, graph: { nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style: '', base, sheet: '' } }], edges: [] } } }, c.projection.revision);
  reportFailure('Derive a preset', made);
  if (!made.ok) return null;
  // The rooms that wore the starter wear the new preset (its sliders are the project's).
  const arch = roomsId === null ? undefined : (c.projection.getEntity(roomsId)?.components['architecture'] as ArchitectureComponent | undefined);
  const next = arch === undefined ? undefined : withPresetSwapped(arch, base, id);
  if (arch !== undefined && next !== undefined && roomsId !== null && JSON.stringify(next) !== JSON.stringify(arch)) {
    const r = await c.setComponent(roomsId, 'architecture', next, c.projection.revision);
    reportFailure('Derive a preset', r);
  }
  return id;
}
