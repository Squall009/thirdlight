/**
 * Floor plans and furnishing as graph kinds (graph-kind data): room
 * programs and furnishing sets are a game's data, standalone graphs
 * (`content.graphs`) like architecture styles and presets, so the editor's
 * graph editor, Create menu, rename, delete and undo serve them.
 *
 * - A **room program** says what rooms a building's footprint is split
 *   into: one Program node (the grid walls snap to, the smallest room side,
 *   the doors' size, the room the front door opens into, what spare space
 *   becomes) and a Room node per room type (its share of the floor, how
 *   many, on which storeys, whether it holds the stairs, its inside preset).
 *   A wire between two Room nodes asks for a door between rooms of those
 *   types: the door graph. Every room is reachable whether wired or not.
 * - A **furnishing set** says what goes in rooms by type: one Furnishing
 *   node (the clearance kept in front of doors, the walkable path's width,
 *   how many lights a building gets), Prop nodes (a kit model, the room
 *   type it furnishes, against a wall, in a corner or in the middle, its
 *   footprint and count) and Light nodes (one light per room of the type).
 *
 * `arch-floor-plan.ts` splits footprints by a program, `arch-furnish.ts`
 * places a set's props; the engine ships neither programs nor sets.
 */
import { graphBool, graphFieldOf, graphNum, graphStr } from './arch-style-kinds';
import { ARCHITECTURE_LIMITS } from './architecture';
import type { GraphData, GraphFieldDef, GraphKindDef, GraphNode } from './graph';
import { MAX_LOCAL_LIGHTS } from './local-lights';

export const ROOM_PROGRAM_KIND = 'room-program';
export const FURNISHING_SET_KIND = 'furnishing-set';

/** Engine limits of one program or set graph (not tuning values): a house program has a dozen nodes. */
export const FLOOR_PLAN_GRAPH_NODES = 256;
/** The most rooms of one type on a storey and the most copies of one prop in a room (a request cannot ask for unbounded work). */
export const FLOOR_PLAN_COUNT_MAX = 64;

/** Which storeys a room type is on. */
export const ROOM_STOREYS = ['ground', 'upper', 'every'] as const;
export type RoomStoreys = (typeof ROOM_STOREYS)[number];
/** Where a prop stands in its room. */
export const PROP_PLACES = ['wall', 'corner', 'centre'] as const;
export type PropPlace = (typeof PROP_PLACES)[number];

const L = ARCHITECTURE_LIMITS;
const ID_PATTERN = '[a-z0-9][a-z0-9_-]{0,63}';
const ID_OR_EMPTY = `|${ID_PATTERN}`;
const num = (key: string, label: string, def: number, min: number, max: number): GraphFieldDef => ({ key, label, type: 'number', default: def, min, max });
const id = (key: string, label: string, def: string): GraphFieldDef => ({ key, label, type: 'string', default: def, maxLength: 64, pattern: ID_OR_EMPTY });

export const ROOM_PROGRAM_GRAPH_KIND: GraphKindDef = {
  kind: ROOM_PROGRAM_KIND,
  label: 'Room program',
  portTypes: [{ id: 'door', label: 'door', color: '#e0b070' }],
  conversions: [],
  categories: ['Program', 'Rooms'],
  nodes: [
    {
      type: 'program',
      label: 'Program',
      category: 'Program',
      description: 'How the footprint is split: walls on a grid from its corner, no room narrower than the smallest side, the doors\' size, the room the front door opens into and the type spare space becomes (empty: the first room\'s).',
      inputs: [],
      outputs: [],
      fields: [
        num('grid', 'Grid', 1, 0.1, 10),
        num('minSide', 'Smallest side', 2.4, 0.5, 100),
        num('doorWidth', 'Door width', 1, 0.3, 10),
        num('doorHeight', 'Door height', 2.1, 0.5, 10),
        id('entrance', 'Entrance room', ''),
        id('filler', 'Spare space', ''),
      ],
      max: 1,
      required: true,
    },
    {
      type: 'room',
      label: 'Room',
      category: 'Rooms',
      description: 'A room type: its share of the storey\'s floor, how many, on which storeys (ground; upper: each storey above it, the ground when there is none; every), whether it holds the stairs (on every storey, in one place) and the preset its inside wears (empty: the building\'s). Wire two rooms for a door between them.',
      inputs: [{ id: 'doors', label: 'doors', type: 'door', multi: true }],
      outputs: [{ id: 'door', label: 'door', type: 'door' }],
      fields: [
        { key: 'type', label: 'Type', type: 'string', default: 'room', maxLength: 64, pattern: ID_PATTERN },
        num('area', 'Share', 1, 0.01, 1000),
        num('count', 'Count', 1, 0, FLOOR_PLAN_COUNT_MAX),
        { key: 'storeys', label: 'Storeys', type: 'enum', options: ROOM_STOREYS, default: 'ground' },
        { key: 'stairs', label: 'Holds the stairs', type: 'boolean', default: false },
        id('preset', 'Inside preset', ''),
      ],
      titleField: 'type',
    },
  ],
  allowCycles: true,
  maxNodes: FLOOR_PLAN_GRAPH_NODES,
};

export const FURNISHING_SET_GRAPH_KIND: GraphKindDef = {
  kind: FURNISHING_SET_KIND,
  label: 'Furnishing set',
  portTypes: [],
  conversions: [],
  categories: ['Furnishing', 'Props'],
  nodes: [
    {
      type: 'furnishing',
      label: 'Furnishing',
      category: 'Furnishing',
      description: 'Kept free: metres in front of each door, and a walkable path this wide joining a room\'s doors and stairs. The gap between a prop and its wall, and the most lights one building gets (largest rooms first).',
      inputs: [],
      outputs: [],
      fields: [num('doorClearance', 'Door clearance', 1, 0, 10), num('pathWidth', 'Path width', 0.8, 0, 10), num('wallGap', 'Wall gap', 0.02, 0, 1), num('lights', 'Lights', 4, 0, MAX_LOCAL_LIGHTS)],
      max: 1,
      required: true,
    },
    {
      type: 'prop',
      label: 'Prop',
      category: 'Props',
      description: 'A kit model placed in rooms of a type (empty: any room): its back against a wall facing the room, in a corner, or in the middle facing the door; its footprint (width along its X, depth along its Z, metres), height (not in front of windows above it), how many, and the space kept round it.',
      inputs: [],
      outputs: [],
      fields: [
        id('room', 'Room type', ''),
        { key: 'model', label: 'Model', type: 'string', default: '', maxLength: 64, pattern: ID_PATTERN, asset: 'model' },
        { key: 'piece', label: 'Piece', type: 'string', default: '', maxLength: 128 },
        { key: 'place', label: 'Place', type: 'enum', options: PROP_PLACES, default: 'wall' },
        num('width', 'Width', 1, 0.05, L.distanceMax),
        num('depth', 'Depth', 0.6, 0.05, L.distanceMax),
        num('height', 'Height', 1, 0.01, L.distanceMax),
        num('count', 'Count', 1, 0, FLOOR_PLAN_COUNT_MAX),
        num('spacing', 'Space round it', 0.2, 0, 10),
      ],
      titleField: 'room',
    },
    {
      type: 'light',
      label: 'Light',
      category: 'Props',
      description: 'A point light in the middle of each room of a type (empty: any room), this high over its floor.',
      inputs: [],
      outputs: [],
      fields: [id('room', 'Room type', ''), { key: 'color', label: 'Colour', type: 'color', default: '#ffe2b8' }, num('intensity', 'Intensity', 1.5, 0, 8), num('range', 'Range', 6, 0, 1000), num('height', 'Height', 2.2, 0, L.distanceMax)],
      titleField: 'room',
    },
  ],
  allowCycles: false,
  maxNodes: FLOOR_PLAN_GRAPH_NODES,
};

/** A room type of a program. */
export interface RoomTypeDef {
  /** The Room node's id (wires name it). */
  node: string;
  type: string;
  area: number;
  count: number;
  storeys: RoomStoreys;
  stairs: boolean;
  preset: string;
}

export interface RoomProgramDef {
  id: string;
  grid: number;
  minSide: number;
  doorWidth: number;
  doorHeight: number;
  entrance: string;
  filler: string;
  rooms: readonly RoomTypeDef[];
  /** Door links between room types (each pair once, sorted). */
  links: readonly (readonly [string, string])[];
}

export interface FurnishingPropDef {
  node: string;
  room: string;
  model: string;
  piece: string;
  place: PropPlace;
  width: number;
  depth: number;
  height: number;
  count: number;
  spacing: number;
}

export interface FurnishingLightDef {
  node: string;
  room: string;
  color: string;
  intensity: number;
  range: number;
  height: number;
}

export interface FurnishingSetDef {
  id: string;
  doorClearance: number;
  pathWidth: number;
  wallGap: number;
  lights: number;
  props: readonly FurnishingPropDef[];
  lightDefs: readonly FurnishingLightDef[];
}

const clampTo = (v: number, f: GraphFieldDef | undefined): number => Math.min(f?.max ?? Infinity, Math.max(f?.min ?? -Infinity, v));
/** A number field clamped to its range (the editor keeps it there; a hand-made graph may not). */
function numIn(kind: GraphKindDef, n: GraphNode, key: string): number {
  const f = kind.nodes.find((d) => d.type === n.type)?.fields?.find((x) => x.key === key);
  return clampTo(graphNum(kind, n, key), f);
}
const nodesOf = (graph: GraphData): GraphNode[] => (graph.nodes ?? []).filter((n) => typeof n?.id === 'string' && typeof n.type === 'string');

/** A program graph read (nodes in their stored order). */
export function roomProgramDef(graphId: string, graph: GraphData): RoomProgramDef {
  const K = ROOM_PROGRAM_GRAPH_KIND;
  const nodes = nodesOf(graph);
  const head = nodes.find((n) => n.type === 'program');
  const rooms: RoomTypeDef[] = [];
  for (const n of nodes) {
    if (n.type !== 'room') continue;
    const type = graphStr(K, n, 'type');
    if (type === '') continue;
    const storeys = graphStr(K, n, 'storeys');
    rooms.push({ node: n.id, type, area: numIn(K, n, 'area'), count: Math.round(numIn(K, n, 'count')), storeys: (ROOM_STOREYS as readonly string[]).includes(storeys) ? (storeys as RoomStoreys) : 'ground', stairs: graphBool(K, n, 'stairs'), preset: graphStr(K, n, 'preset') });
  }
  const typeOf = new Map(rooms.map((r) => [r.node, r.type]));
  const links = new Map<string, [string, string]>();
  for (const e of graph.edges ?? []) {
    const a = typeOf.get(e?.from?.node);
    const b = typeOf.get(e?.to?.node);
    if (a === undefined || b === undefined) continue;
    const pair: [string, string] = a <= b ? [a, b] : [b, a];
    links.set(pair.join('\u0000'), pair);
  }
  const at = (key: string, fallback: number): number => (head !== undefined ? numIn(K, head, key) : fallback);
  return {
    id: graphId,
    grid: at('grid', 1),
    minSide: at('minSide', 2.4),
    doorWidth: at('doorWidth', 1),
    doorHeight: at('doorHeight', 2.1),
    entrance: head !== undefined ? graphStr(K, head, 'entrance') : '',
    filler: head !== undefined ? graphStr(K, head, 'filler') : '',
    rooms,
    links: [...links.values()].sort((p, q) => (p.join() < q.join() ? -1 : 1)),
  };
}

/** A furnishing set graph read (props and lights in their stored order). */
export function furnishingSetDef(graphId: string, graph: GraphData): FurnishingSetDef {
  const K = FURNISHING_SET_GRAPH_KIND;
  const nodes = nodesOf(graph);
  const head = nodes.find((n) => n.type === 'furnishing');
  const props: FurnishingPropDef[] = [];
  const lightDefs: FurnishingLightDef[] = [];
  for (const n of nodes) {
    if (n.type === 'prop') {
      const model = graphStr(K, n, 'model');
      if (model === '') continue;
      const place = graphStr(K, n, 'place');
      props.push({
        node: n.id,
        room: graphStr(K, n, 'room'),
        model,
        piece: graphStr(K, n, 'piece'),
        place: (PROP_PLACES as readonly string[]).includes(place) ? (place as PropPlace) : 'wall',
        width: numIn(K, n, 'width'),
        depth: numIn(K, n, 'depth'),
        height: numIn(K, n, 'height'),
        count: Math.round(numIn(K, n, 'count')),
        spacing: numIn(K, n, 'spacing'),
      });
    } else if (n.type === 'light') {
      const color = graphFieldOf(K, n, 'color');
      lightDefs.push({ node: n.id, room: graphStr(K, n, 'room'), color: typeof color === 'string' && /^#[0-9a-f]{6}$/.test(color) ? color : '#ffffff', intensity: numIn(K, n, 'intensity'), range: numIn(K, n, 'range'), height: numIn(K, n, 'height') });
    }
  }
  const at = (key: string, fallback: number): number => (head !== undefined ? numIn(K, head, key) : fallback);
  return { id: graphId, doorClearance: at('doorClearance', 1), pathWidth: at('pathWidth', 0.8), wallGap: at('wallGap', 0.02), lights: Math.round(at('lights', 4)), props, lightDefs };
}

/** What a new program or furnishing set graph starts as: its head node. */
export function floorPlanGraphTemplate(kind: string): GraphData | null {
  if (kind === ROOM_PROGRAM_KIND) return { nodes: [{ id: 'program', type: 'program', position: [0, 0] }], edges: [] };
  if (kind === FURNISHING_SET_KIND) return { nodes: [{ id: 'furnishing', type: 'furnishing', position: [0, 0] }], edges: [] };
  return null;
}
