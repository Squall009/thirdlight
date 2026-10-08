/**
 * Neutral room programs, furnishing sets and buildings the floor-plan tests
 * and the incremental-expansion tests share. Test data, not game content.
 */
import type { ArchitectureGraphLike } from '../packages/project-model/src/arch-style';
import { FURNISHING_SET_KIND, ROOM_PROGRAM_KIND } from '../packages/project-model/src/arch-plan-kinds';
import type { ArchitectureBuilding } from '../packages/project-model/src/architecture';
import type { GraphData } from '../packages/project-model/src/graph';

export type P3 = [number, number, number];
export const at = (pts: [number, number][], y = 0): P3[] => pts.map(([x, z]) => [x, y, z]);

/** A neutral program: a hall the front door opens into, two rooms off it, a small room, and stairs when there are storeys. */
export function programGraph(opts: { upper?: boolean; stairs?: boolean } = {}): GraphData {
  const room = (id: string, type: string, area: number, extra: Record<string, unknown> = {}): GraphData['nodes'][number] => ({ id, type: 'room', position: [0, 0], data: { type, area, ...extra } as GraphData['nodes'][number]['data'] });
  return {
    nodes: [
      { id: 'program', type: 'program', position: [0, 0], data: { entrance: 'hall', filler: 'hall', minSide: 2.4 } },
      room('hall', 'hall', 1),
      room('a', 'room-a', 1.5),
      room('b', 'room-b', 1.2),
      room('c', 'small', 0.6),
      ...(opts.upper === true ? [room('u', 'upper', 1, { storeys: 'upper', count: 2 })] : []),
      ...(opts.stairs === true ? [room('s', 'stairs', 1, { stairs: true })] : []),
    ],
    edges: [
      { id: 'e1', from: { node: 'hall', port: 'door' }, to: { node: 'a', port: 'doors' } },
      { id: 'e2', from: { node: 'hall', port: 'door' }, to: { node: 'b', port: 'doors' } },
      ...(opts.stairs === true ? [{ id: 'e3', from: { node: 'hall', port: 'door' }, to: { node: 's', port: 'doors' } }] : []),
    ],
  };
}

/** A neutral furnishing set: two wall props and a corner prop in any room, a middle prop in room-a, lights everywhere. */
export function furnishingGraph(lights = 3): GraphData {
  const prop = (id: string, data: Record<string, unknown>): GraphData['nodes'][number] => ({ id, type: 'prop', position: [0, 0], data: data as GraphData['nodes'][number]['data'] });
  return {
    nodes: [
      { id: 'furnishing', type: 'furnishing', position: [0, 0], data: { lights, doorClearance: 1, pathWidth: 0.8 } },
      prop('cabinet', { model: 'kit-cabinet', place: 'wall', width: 1.2, depth: 0.5, height: 2, count: 2 }),
      prop('crate', { model: 'kit-crate', place: 'corner', width: 0.6, depth: 0.6, height: 0.6 }),
      prop('table', { room: 'room-a', model: 'kit-table', place: 'centre', width: 1.4, depth: 0.8, height: 0.8 }),
      { id: 'lamp', type: 'light', position: [0, 0], data: { height: 2.2 } },
    ],
    edges: [],
  };
}

export function graphs(opts: { upper?: boolean; stairs?: boolean; lights?: number } = {}): ArchitectureGraphLike[] {
  return [
    { graphId: 'test-program', kind: ROOM_PROGRAM_KIND, graph: programGraph(opts) },
    { graphId: 'test-furnishing', kind: FURNISHING_SET_KIND, graph: furnishingGraph(opts.lights) },
  ];
}

/** A 12 × 8 m building, its front door in the middle of its first wall. */
export const RECT: [number, number][] = [[0, 0], [12, 0], [12, 8], [0, 8]];
export const L_SHAPE: [number, number][] = [[0, 0], [12, 0], [12, 6], [6, 6], [6, 12], [0, 12]];

export function building(points: [number, number][], extra: Partial<ArchitectureBuilding> = {}): ArchitectureBuilding {
  return { id: 'house', path: { points: at(points), closed: true }, preset: 'starter-room', openings: [{ id: 'front', at: 6, width: 1, bottom: 0, top: 2.1 }], program: 'test-program', ...extra };
}
