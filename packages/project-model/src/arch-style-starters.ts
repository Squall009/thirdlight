/**
 * The engine's neutral starter styles and presets: a plain room, a vaulted
 * hall with pilasters, a rail of posts (and a fence of it), and a pipe — the operators shown at work
 * on the starter row layout, with no game's look. Every project has them;
 * a project's graph of the same id replaces one, and a project's presets
 * may derive from them.
 *
 * Pure data.
 */
import type { GraphData, GraphEdge, GraphNode, GraphValue } from './graph';
import { ARCHITECTURE_PRESET_KIND, ARCHITECTURE_STYLE_KIND } from './arch-style-kinds';

export interface ArchitectureStarterGraph {
  graphId: string;
  kind: string;
  name: string;
  graph: GraphData;
}

/** A small graph builder: nodes in columns, wires by "node.port". */
function graph(nodes: [id: string, type: string, column: number, data?: Record<string, GraphValue>][], wires: [from: string, to: string][]): GraphData {
  const rows = new Map<number, number>();
  const out: GraphNode[] = nodes.map(([id, type, column, data]) => {
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { id, type, position: [column * 260, row * 150], ...(data !== undefined ? { data } : {}) };
  });
  const edges: GraphEdge[] = wires.map(([from, to], i) => {
    const [fn, fp] = from.split('.') as [string, string];
    const [tn, tp] = to.split('.') as [string, string];
    return { id: `e${i + 1}`, from: { node: fn, port: fp }, to: { node: tn, port: tp } };
  });
  return { nodes: out, edges };
}

const param = (name: string, def: number, min: number, max: number): Record<string, GraphValue> => ({ name, default: def, min, max });

/** A room: walls (a dado below), a baseboard, a cove under the ceiling, a floor and a ceiling — or, vaulted, a barrel vault and pilasters. */
function roomStyle(vaulted: boolean): GraphData {
  return graph(
    [
      ['outline', 'outline', 0],
      ['height', 'parameter', 0, param('ceiling_height', vaulted ? 4 : 3, 2, 12)],
      ['thickness', 'parameter', 0, param('wall_thickness', 0.2, 0.05, 1)],
      ['dado', 'parameter', 0, param('dado_height', 0.9, 0, 3)],
      ['baseboard', 'parameter', 0, param('baseboard_height', 0.15, 0, 0.5)],
      ['moulding', 'parameter', 0, param('moulding_depth', 0.08, 0, 0.4)],
      ...(vaulted
        ? ([
            ['rise', 'parameter', 0, param('vault_rise', 1.5, 0.1, 6)],
            ['spacing', 'parameter', 0, param('column_spacing', 3, 1, 12)],
            ['colsize', 'parameter', 0, param('column_size', 0.35, 0.1, 1.5)],
          ] as [string, string, number, Record<string, GraphValue>][])
        : []),
      ['half', 'multiply', 1, { b: 0.5 }],
      ['coveSize', 'multiply', 1, { b: 4 }],
      ['inside', 'offset', 1],
      ['ceiling', 'raise', 1],
      ...(vaulted ? ([['colpath', 'offset', 1], ['colhalf', 'multiply', 1, { b: 0.5 }], ['colinset', 'add', 1], ['square', 'square', 1]] as [string, string, number, Record<string, GraphValue>?][]) : []),
      ['wallProfile', 'wall', 2, { chamfer: 0.02 }],
      ['baseProfile', 'band', 2, { depth: 0.02 }],
      ['coveProfile', 'cove', 2],
      ['frameProfile', 'frame', 2],
      ...(vaulted ? ([['shaftProfile', 'shaft', 2]] as [string, string, number][]) : []),
      ['walls', 'sweep', 3, { openings: true, wall: true }],
      ['baseboards', 'sweep', 3, { detail: true, openings: true }],
      ['crown', 'sweep', 3, { detail: true }],
      ['floor', 'fill', 3, { shape: 'flat', slot: 'floor' }],
      vaulted ? ['vault', 'fill', 3, { shape: 'barrel', slot: 'upper_wall', collide: 'no' }] : ['top', 'fill', 3, { shape: 'flat', slot: 'upper_wall', face: 'down', collide: 'no' }],
      ...(vaulted ? ([['pilaster', 'sweep', 3], ['pilasters', 'repeat', 3]] as [string, string, number, Record<string, GraphValue>?][]) : []),
      ['output', 'output', 4],
    ],
    [
      ['thickness.value', 'half.a'],
      ['half.value', 'inside.distance'],
      ['outline.path', 'inside.path'],
      ['outline.path', 'ceiling.path'],
      ['height.value', 'ceiling.height'],
      ['thickness.value', 'wallProfile.thickness'],
      ['height.value', 'wallProfile.height'],
      ['dado.value', 'wallProfile.dado'],
      ['baseboard.value', 'baseProfile.height'],
      ['moulding.value', 'coveSize.a'],
      ['coveSize.value', 'coveProfile.size'],
      ['moulding.value', 'coveProfile.depth'],
      ['height.value', 'coveProfile.top'],
      ['outline.path', 'walls.path'],
      ['wallProfile.profile', 'walls.profile'],
      ['frameProfile.profile', 'walls.frame'],
      ['inside.path', 'baseboards.path'],
      ['baseProfile.profile', 'baseboards.profile'],
      ['inside.path', 'crown.path'],
      ['coveProfile.profile', 'crown.profile'],
      ['outline.path', 'floor.path'],
      ['ceiling.path', vaulted ? 'vault.path' : 'top.path'],
      ...(vaulted
        ? ([
            ['rise.value', 'vault.rise'],
            ['colsize.value', 'colhalf.a'],
            ['colhalf.value', 'colinset.a'],
            ['half.value', 'colinset.b'],
            ['outline.path', 'colpath.path'],
            ['colinset.value', 'colpath.distance'],
            ['colsize.value', 'square.size'],
            ['height.value', 'shaftProfile.height'],
            ['square.path', 'pilaster.path'],
            ['shaftProfile.profile', 'pilaster.profile'],
            ['colpath.path', 'pilasters.path'],
            ['pilaster.element', 'pilasters.piece'],
            ['spacing.value', 'pilasters.spacing'],
            ['pilasters.element', 'output.elements'],
          ] as [string, string][])
        : []),
      ['walls.element', 'output.elements'],
      ['baseboards.element', 'output.elements'],
      ['crown.element', 'output.elements'],
      ['floor.element', 'output.elements'],
      [vaulted ? 'vault.element' : 'top.element', 'output.elements'],
    ],
  );
}

/** A rail along an open or closed path: posts every so often and a rail on them. */
function railStyle(): GraphData {
  return graph(
    [
      ['outline', 'outline', 0],
      ['spacing', 'parameter', 0, param('post_spacing', 1.5, 0.3, 6)],
      ['height', 'parameter', 0, param('rail_height', 1, 0.3, 3)],
      ['size', 'parameter', 0, param('post_size', 0.08, 0.03, 0.5)],
      ['railTop', 'add', 1, { b: -0.06 }],
      ['raised', 'raise', 1],
      ['square', 'square', 1],
      ['shaftProfile', 'shaft', 2, { slot: 'column' }],
      ['railProfile', 'wall', 2, { height: 0.06, inside: 'frame', outside: 'frame', top: 'frame', lower: 'frame' }],
      ['post', 'sweep', 3],
      ['posts', 'repeat', 3, { corners: true }],
      ['rail', 'sweep', 3],
      ['output', 'output', 4],
    ],
    [
      ['height.value', 'railTop.a'],
      ['outline.path', 'raised.path'],
      ['railTop.value', 'raised.height'],
      ['size.value', 'square.size'],
      ['height.value', 'shaftProfile.height'],
      ['size.value', 'railProfile.thickness'],
      ['square.path', 'post.path'],
      ['shaftProfile.profile', 'post.profile'],
      ['outline.path', 'posts.path'],
      ['post.element', 'posts.piece'],
      ['spacing.value', 'posts.spacing'],
      ['raised.path', 'rail.path'],
      ['railProfile.profile', 'rail.profile'],
      ['posts.element', 'output.elements'],
      ['rail.element', 'output.elements'],
    ],
  );
}

/** A pipe along an open or closed path: a round section lifted off it, its ends capped. */
function pipeStyle(): GraphData {
  return graph(
    [
      ['outline', 'outline', 0],
      ['radius', 'parameter', 0, param('pipe_radius', 0.06, 0.01, 1)],
      ['height', 'parameter', 0, param('pipe_height', 0.3, 0, 20)],
      ['section', 'round', 2, { sides: 10, slot: 'column' }],
      ['pipe', 'sweep', 3],
      ['output', 'output', 4],
    ],
    [
      ['radius.value', 'section.radius'],
      ['height.value', 'section.height'],
      ['outline.path', 'pipe.path'],
      ['section.profile', 'pipe.profile'],
      ['pipe.element', 'output.elements'],
    ],
  );
}

function preset(style: string, base: string, values: Record<string, number> = {}): GraphData {
  const nodes: GraphNode[] = [{ id: 'preset', type: 'preset', position: [0, 0], data: { style, base, sheet: '' } }];
  Object.entries(values).forEach(([parameter, value], i) => nodes.push({ id: `v-${parameter}`, type: 'value', position: [0, 150 * (i + 1)], data: { parameter, value } }));
  return { nodes, edges: [] };
}

/** The starters (ids are the engine's; a project's graph of an id replaces it). */
export const ARCHITECTURE_STARTER_GRAPHS: readonly ArchitectureStarterGraph[] = Object.freeze([
  { graphId: 'starter-room-style', kind: ARCHITECTURE_STYLE_KIND, name: 'Room (starter)', graph: roomStyle(false) },
  { graphId: 'starter-hall-style', kind: ARCHITECTURE_STYLE_KIND, name: 'Vaulted hall (starter)', graph: roomStyle(true) },
  { graphId: 'starter-rail-style', kind: ARCHITECTURE_STYLE_KIND, name: 'Rail (starter)', graph: railStyle() },
  { graphId: 'starter-pipe-style', kind: ARCHITECTURE_STYLE_KIND, name: 'Pipe (starter)', graph: pipeStyle() },
  { graphId: 'starter-room', kind: ARCHITECTURE_PRESET_KIND, name: 'Room (starter)', graph: preset('starter-room-style', '') },
  { graphId: 'starter-room-tall', kind: ARCHITECTURE_PRESET_KIND, name: 'Tall room (starter)', graph: preset('', 'starter-room', { ceiling_height: 4.2, dado_height: 1.2, moulding_depth: 0.14 }) },
  { graphId: 'starter-hall', kind: ARCHITECTURE_PRESET_KIND, name: 'Vaulted hall (starter)', graph: preset('starter-hall-style', '') },
  { graphId: 'starter-rail', kind: ARCHITECTURE_PRESET_KIND, name: 'Rail (starter)', graph: preset('starter-rail-style', '') },
  { graphId: 'starter-fence', kind: ARCHITECTURE_PRESET_KIND, name: 'Fence (starter)', graph: preset('', 'starter-rail', { post_spacing: 2, rail_height: 1.1, post_size: 0.12 }) },
  { graphId: 'starter-pipe', kind: ARCHITECTURE_PRESET_KIND, name: 'Pipe (starter)', graph: preset('starter-pipe-style', '') },
]);

/** What a new style or preset graph starts as: a style with its Outline and Output; a preset deriving from the starter room. */
export function architectureGraphTemplate(kind: string): GraphData {
  if (kind === ARCHITECTURE_STYLE_KIND) return { nodes: [{ id: 'outline', type: 'outline', position: [0, 0] }, { id: 'output', type: 'output', position: [780, 0] }], edges: [] };
  if (kind === ARCHITECTURE_PRESET_KIND) return preset('', 'starter-room');
  return { nodes: [], edges: [] };
}
