/**
 * The rooms drawn on the selected block layer, bound for its Rooms tool: the
 * generated-architecture object whose `architecture.layer` names the layer
 * (the first such object; none until the first room is drawn), expanded with
 * the project's styles for the room plans and the walls' cell edges, and the
 * commands that store it (a new object at the layer's place, in one
 * `createEntity`) or preview it in the Scene view while a wall is dragged.
 */
import { useMemo } from 'react';
import type { ArchitectureComponent, BlockLayerComponent, GraphDocument } from '@thirdlight/project-model';
import { architectureGraphsOf, architectureStylesOf, architectureWallEdges, expandArchitecture } from '@thirdlight/runtime';

import type { ProjectedEntity } from '../../session/projection';
import type { ClientRef, ReportFailure, ViewportRef } from '../shell/commands';
import { presetChoices } from './ArchitecturePanels';
import type { RoomsBinding } from './RoomsPanel';

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
  if (layer === null || comp === undefined) return undefined;
  const roomsId = rooms?.id ?? null;
  return {
    entityId: roomsId,
    component,
    origin,
    layerOrigin,
    plans: expanded?.rooms ?? [],
    walls,
    presets,
    async setRooms(next, what) {
      const c = clientRef.current;
      if (!c) return false;
      if (roomsId !== null) {
        const r = await c.setComponent(roomsId, 'architecture', next, c.projection.revision);
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
  };
}
