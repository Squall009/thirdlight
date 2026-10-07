/**
 * `ctx.grid`'s walk queries — the places one step away, a path between two
 * places, the places reachable within a cost — over a loaded layer as it is
 * now (its kits, its doors open or closed, cells scripts wrote this step).
 * The graph is project-model's (`block-walk.ts`), the one the editor's
 * reachability check walks; how a unit moves along a path, and who occupies
 * a cell, is the game's (`avoid`, `costField`).
 *
 * The graph finds places lazily over the columns a query visits and is kept
 * for the next query with the same settings while the layer has had no write
 * (a cell, an edge, a door opened; a new kit view is a new grid as shown), so
 * a game asking every step pays for the columns once. A kept graph that has
 * read `WALK_QUERY_MAX_NODES` columns is dropped (its memory grows with what
 * it read). At most `WALK_QUERY_MAX_NODES` places are expanded per query.
 */
import {
  BlockWalkGraph,
  cellCenter,
  effectiveCellMeta,
  findWalkPath,
  walkReach,
  walkSettingsOf,
  type BlockGridReader,
  type BlockLayerComponent,
  type BlockType,
  type CellField,
  type WalkPlace,
  type WalkSettings,
  WALK_QUERY_MAX_NODES,
} from '@thirdlight/project-model';

/** Options of the walk queries; absent fields take the layer's `walk`, then the engine's defaults. */
export interface GridWalkOptions {
  /** How far a step may rise (m). */
  maxStep?: number;
  /** How far a step may drop (m). */
  maxDrop?: number;
  /** The free height a place needs above it (m). */
  headroom?: number;
  /** The steepest top that can be stood on (degrees; absent: the layer's maxSlope, else the project's). */
  maxSlope?: number;
  /** Steps across cell corners too (both ways round the corner walkable). */
  diagonal?: boolean;
  /** A boolean cell field: only tops whose cell has it true are walked (absent: the layer's walk field, else every top). */
  field?: string;
  /** A number cell field: entering a place costs its cell's value per metre (absent: 1 per metre); 0 or less: it cannot be entered. */
  costField?: string;
  /**
   * Cells that cannot be entered (places other units stand on), as [x, y, z] each; a start is never avoided.
   * @graphType list
   */
  avoid?: readonly (readonly number[])[];
}

/** A place on a walk: the cell whose top it is, the point on that top at the cell's centre, and the cost to it (m, times any cost field). */
export interface GridWalkPlace {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly point: { readonly x: number; readonly y: number; readonly z: number };
  readonly cost: number;
}

/** The walk graphs kept between queries: per grid as shown, the write count they were made at and the graphs by settings. */
export type WalkGraphCache = WeakMap<BlockGridReader, { writeCount: number; graphs: Map<string, BlockWalkGraph> }>;

/** What a walk query reads of a loaded layer. */
export interface WalkLayer {
  readonly component: BlockLayerComponent;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  /** The grid as its kits show it. */
  readonly shown: BlockGridReader;
  /** The layer's writes so far (a kept graph made at another count is stale). */
  readonly writeCount: number;
  /** Where graphs are kept between queries. */
  readonly graphs: WalkGraphCache;
  /** The anchor of a cell a larger block covers (null: none). */
  anchorOf(x: number, y: number, z: number): readonly [number, number, number] | null;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A query's graph and entry cost, or null when its options do not fit (an unknown field, a negative length, …). */
export function walkGraphFor(layer: WalkLayer, types: ReadonlyMap<string, BlockType>, fields: ReadonlyMap<string, CellField>, defaultMaxSlope: number, options: unknown): { graph: BlockWalkGraph; enter: ((p: WalkPlace) => number) | undefined } | null {
  if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) return null;
  const o = (options ?? {}) as GridWalkOptions;
  const query: { -readonly [K in keyof WalkSettings]?: WalkSettings[K] } = {};
  for (const k of ['maxStep', 'maxDrop', 'headroom', 'maxSlope'] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (!num(v) || v < 0) return null;
    query[k] = v;
  }
  if (o.diagonal !== undefined) {
    if (typeof o.diagonal !== 'boolean') return null;
    query.diagonal = o.diagonal;
  }
  const field = o.field ?? layer.component.walk?.field;
  if (field !== undefined && (typeof field !== 'string' || fields.get(field)?.type !== 'bool')) return null;
  if (o.costField !== undefined && (typeof o.costField !== 'string' || !['int', 'float'].includes(fields.get(o.costField)?.type ?? ''))) return null;
  if (o.avoid !== undefined && (!Array.isArray(o.avoid) || !o.avoid.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isSafeInteger(v))))) return null;
  const grid = layer.shown;
  const fieldList = [...fields.values()];
  const metaOf = (x: number, y: number, z: number): Record<string, unknown> => {
    const a = layer.anchorOf(x, y, z);
    return effectiveCellMeta(a !== null ? grid.get(a[0], a[1], a[2]) : grid.get(x, y, z), types, fieldList);
  };
  const settings = walkSettingsOf(layer.component, defaultMaxSlope, query);
  let kept = layer.graphs.get(grid);
  if (kept === undefined || kept.writeCount !== layer.writeCount) layer.graphs.set(grid, (kept = { writeCount: layer.writeCount, graphs: new Map() }));
  const key = JSON.stringify([settings, field ?? null]);
  let graph = kept.graphs.get(key);
  if (graph !== undefined && graph.columnCount > WALK_QUERY_MAX_NODES) {
    kept.graphs.delete(key);
    graph = undefined;
  }
  if (graph === undefined) {
    graph = new BlockWalkGraph(grid, types, settings, {
      anchorOf: (x, y, z) => layer.anchorOf(x, y, z),
      ...(field !== undefined ? { standable: (x: number, y: number, z: number) => metaOf(x, y, z)[field] === true } : {}),
    });
    kept.graphs.set(key, graph);
  }
  const avoid = o.avoid !== undefined && o.avoid.length > 0 ? new Set(o.avoid.map((c) => `${c[0]},${c[1]},${c[2]}`)) : null;
  const costField = o.costField;
  const enter =
    avoid === null && costField === undefined
      ? undefined
      : (p: WalkPlace): number => {
          if (avoid !== null && avoid.has(`${p.x},${p.y},${p.z}`)) return 0;
          if (costField === undefined) return 1;
          const v = metaOf(p.x, p.y, p.z)[costField];
          return typeof v === 'number' ? v : 1;
        };
  return { graph, enter };
}

/** A place as scripts read it (world point at the top's centre height). */
export function walkPlaceView(layer: WalkLayer, p: WalkPlace, cost: number): GridWalkPlace {
  const c = cellCenter(layer.origin, layer.shown.cellSize, p.x, p.y, p.z);
  return Object.freeze({ x: p.x, y: p.y, z: p.z, point: Object.freeze({ x: c.x, y: layer.origin.y + p.height, z: c.z }), cost });
}

const cellArg = (v: unknown): v is readonly [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isSafeInteger(n));

/** The places one step from a cell's place (empty: no place there, or options that do not fit). */
export function walkNeighboursQuery(layer: WalkLayer, types: ReadonlyMap<string, BlockType>, fields: ReadonlyMap<string, CellField>, defaultMaxSlope: number, cell: unknown, options: unknown): readonly GridWalkPlace[] {
  const q = cellArg(cell) ? walkGraphFor(layer, types, fields, defaultMaxSlope, options) : null;
  if (q === null) return Object.freeze([]);
  const from = q.graph.placeAt(...(cell as [number, number, number]));
  if (from === null) return Object.freeze([]);
  const out: GridWalkPlace[] = [];
  for (const s of q.graph.steps(from)) {
    const m = q.enter?.(s.place) ?? 1;
    if (m > 0 && Number.isFinite(m)) out.push(walkPlaceView(layer, s.place, s.cost * m));
  }
  return Object.freeze(out);
}

/** The cheapest path between two cells' places, start and end included (null: none, too far to search, or options that do not fit). */
export function walkPathQuery(layer: WalkLayer, types: ReadonlyMap<string, BlockType>, fields: ReadonlyMap<string, CellField>, defaultMaxSlope: number, from: unknown, to: unknown, options: unknown): readonly GridWalkPlace[] | null {
  if (!cellArg(from) || !cellArg(to)) return null;
  const q = walkGraphFor(layer, types, fields, defaultMaxSlope, options);
  if (q === null) return null;
  const a = q.graph.placeAt(...from);
  const b = q.graph.placeAt(...to);
  if (a === null || b === null) return null;
  const r = findWalkPath(q.graph, a, b, q.enter !== undefined ? { enter: q.enter } : {});
  if (!r.ok) return null;
  // Each place with the cost so far.
  let cost = 0;
  const out: GridWalkPlace[] = [walkPlaceView(layer, r.places[0]!, 0)];
  for (let i = 1; i < r.places.length; i++) {
    const step = q.graph.steps(r.places[i - 1]!).find((s) => s.place.key === r.places[i]!.key)!;
    cost += step.cost * (q.enter?.(step.place) ?? 1);
    out.push(walkPlaceView(layer, r.places[i]!, cost));
  }
  return Object.freeze(out);
}

/** The places reachable from a cell's place within a cost (m, times any cost field), cheapest first (empty: no place there, or options that do not fit). */
export function walkReachQuery(layer: WalkLayer, types: ReadonlyMap<string, BlockType>, fields: ReadonlyMap<string, CellField>, defaultMaxSlope: number, from: unknown, maxCost: unknown, options: unknown): readonly GridWalkPlace[] {
  if (!cellArg(from) || !num(maxCost) || maxCost < 0) return Object.freeze([]);
  const q = walkGraphFor(layer, types, fields, defaultMaxSlope, options);
  if (q === null) return Object.freeze([]);
  const a = q.graph.placeAt(...from);
  if (a === null) return Object.freeze([]);
  const r = walkReach(q.graph, [a], { maxCost, ...(q.enter !== undefined ? { enter: q.enter } : {}) });
  return Object.freeze(r.places.map((p) => walkPlaceView(layer, p.place, p.cost)));
}
