/**
 * A block layer's level-building checks, for the Problems list: blocks that
 * float (touching nothing that reaches down to the layer's lowest blocks),
 * named regions that hold no cell of the layer, and places to stand that
 * cannot be walked to from the region the layer names (`walk.from`).
 *
 * They read the whole layer, so they run where an edit is checked off the
 * frame (the backend, after the edits settle), never per frame or per
 * command. Each kind is one line per layer with a count and the first cells.
 *
 * Floating: blocks join their face neighbours, and edge pieces join the
 * blocks beside, under and over them and the edge pieces they meet (a roof on
 * walls made of edge pieces stands). A group is grounded when it reaches the
 * layer's lowest row holding blocks (a layer built above another, or above
 * the ground of a terrain, is grounded on its own bottom).
 *
 * Pure: a layer's component, its cells and the project's block types in, the
 * problems out.
 */
import { BlockGrid, effectiveCellMeta, regionContains } from './block-grid';
import type { BlockLayerComponent, BlockLayerData, BlockType, CellField } from './block-layers';
import { rotatedFootprint } from './block-layers';
import { blockTypeIsEdge } from './block-edges';
import { BlockWalkGraph, footprintAnchors, walkReach, type WalkPlace } from './block-walk';
import { walkSettingsOf } from './block-walk-settings';

export type BlockCheckCode = 'block_floating' | 'block_region_empty' | 'block_unreachable';

export interface BlockLayerCheck {
  readonly code: BlockCheckCode;
  readonly message: string;
  /** The first cells it is about (at most `BLOCK_CHECK_EXAMPLES`). */
  readonly cells: readonly (readonly [number, number, number])[];
}

/** Cells named in one problem line (the count says how many there are). */
export const BLOCK_CHECK_EXAMPLES = 4;

class UnionFind {
  private readonly parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]!]!;
      i = p[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

const colKey = (x: number, z: number): string => `${x},${z}`;
const cellList = (cells: readonly (readonly [number, number, number])[]): string => cells.map((c) => `[${c.join(', ')}]`).join(', ');

/** The groups of blocks and edge pieces that reach no lower than the layer's lowest blocks. */
function floating(grid: BlockGrid, types: ReadonlyMap<string, BlockType>): { groups: number; count: number; cells: [number, number, number][] } {
  // The rows each column holds (a larger block fills its footprint), as runs of rows.
  const rows = new Map<string, Set<number>>();
  const add = (x: number, y: number, z: number): void => {
    const k = colKey(x, z);
    let s = rows.get(k);
    if (s === undefined) rows.set(k, (s = new Set()));
    s.add(y);
  };
  grid.forEach((x, y, z, idx) => {
    const cell = grid.valueOf(idx);
    if (cell.block === undefined) return;
    const t = types.get(cell.block);
    if (t !== undefined && blockTypeIsEdge(t)) return;
    const f = t !== undefined ? rotatedFootprint(t, cell.rot) : [1, 1, 1];
    for (let dx = 0; dx < f[0]!; dx++) for (let dy = 0; dy < f[1]!; dy++) for (let dz = 0; dz < f[2]!; dz++) add(x + dx, y + dy, z + dz);
  });
  const uf = new UnionFind();
  /** Per column: its runs [y0, y1] (inclusive) with their node ids, lowest first. */
  const runs = new Map<string, { y0: number; y1: number; id: number; x: number; z: number }[]>();
  let lowest = Infinity;
  for (const [k, set] of rows) {
    const [x, z] = k.split(',').map(Number) as [number, number];
    const ys = [...set].sort((a, b) => a - b);
    const list: { y0: number; y1: number; id: number; x: number; z: number }[] = [];
    for (const y of ys) {
      const last = list[list.length - 1];
      if (last !== undefined && last.y1 === y - 1) last.y1 = y;
      else list.push({ y0: y, y1: y, id: uf.add(), x, z });
    }
    lowest = Math.min(lowest, ys[0]!);
    runs.set(k, list);
  }
  const overlapping = (x: number, z: number, lo: number, hi: number): number[] => (runs.get(colKey(x, z)) ?? []).filter((r) => r.y0 <= hi && r.y1 >= lo).map((r) => r.id);
  // Face neighbours across columns.
  for (const list of runs.values()) {
    for (const r of list) {
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) for (const o of overlapping(r.x + dx, r.z + dz, r.y0, r.y1)) uf.union(r.id, o);
    }
  }
  // Edge pieces: each joins the blocks either side of it in its row and the rows next to it, the pieces over and under
  // it, and the pieces meeting its ends.
  const edges = new Map<string, { id: number; x: number; y: number; z: number; axis: number }>();
  grid.forEachEdge((x, y, z, axis) => {
    edges.set(`${x},${y},${z},${axis}`, { id: uf.add(), x, y, z, axis });
    lowest = Math.min(lowest, y);
  });
  const edgeAt = (x: number, y: number, z: number, axis: number): number | undefined => edges.get(`${x},${y},${z},${axis}`)?.id;
  for (const e of edges.values()) {
    const [ox, oz] = e.axis === 0 ? [e.x - 1, e.z] : [e.x, e.z - 1];
    for (const id of [...overlapping(e.x, e.z, e.y - 1, e.y + 1), ...overlapping(ox, oz, e.y - 1, e.y + 1)]) uf.union(e.id, id);
    // The ends of the piece: points on the grid lines.
    const ends: [number, number][] = e.axis === 0 ? [[e.x, e.z], [e.x, e.z + 1]] : [[e.x, e.z], [e.x + 1, e.z]];
    for (const dy of [-1, 0, 1]) {
      const y = e.y + dy;
      if (dy !== 0) {
        const s = edgeAt(e.x, y, e.z, e.axis);
        if (s !== undefined) uf.union(e.id, s);
      }
      for (const [px, pz] of ends) {
        for (const o of [edgeAt(px, y, pz - 1, 0), edgeAt(px, y, pz, 0), edgeAt(px - 1, y, pz, 1), edgeAt(px, y, pz, 1)]) if (o !== undefined && o !== e.id) uf.union(e.id, o);
      }
    }
  }
  const grounded = new Set<number>();
  for (const list of runs.values()) for (const r of list) if (r.y0 === lowest) grounded.add(uf.find(r.id));
  for (const e of edges.values()) if (e.y === lowest) grounded.add(uf.find(e.id));
  const groups = new Set<number>();
  let count = 0;
  const cells: [number, number, number][] = [];
  for (const list of runs.values()) {
    for (const r of list) {
      const root = uf.find(r.id);
      if (grounded.has(root)) continue;
      groups.add(root);
      count += r.y1 - r.y0 + 1;
      cells.push([r.x, r.y0, r.z]);
    }
  }
  for (const e of edges.values()) {
    const root = uf.find(e.id);
    if (grounded.has(root)) continue;
    groups.add(root);
    count += 1;
    cells.push([e.x, e.y, e.z]);
  }
  cells.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  return { groups: groups.size, count, cells: cells.slice(0, BLOCK_CHECK_EXAMPLES) };
}

/** The places to stand the layer's `walk.from` region cannot be walked to from (null: no region to walk from, or it has none of the layer's places). */
function unreachable(grid: BlockGrid, component: BlockLayerComponent, types: ReadonlyMap<string, BlockType>, fields: readonly CellField[], defaultMaxSlope: number): { from: string; starts: number; places: number; count: number; cells: [number, number, number][] } | null {
  const from = component.walk?.from;
  const boxes = from !== undefined ? grid.regions.get(from) : undefined;
  if (from === undefined || boxes === undefined) return null;
  const anchorOf = footprintAnchors(grid, types);
  const field = component.walk?.field;
  const standable =
    field === undefined
      ? undefined
      : (x: number, y: number, z: number): boolean => {
          const a = anchorOf(x, y, z);
          const cell = a !== null ? grid.get(a[0], a[1], a[2]) : grid.get(x, y, z);
          return effectiveCellMeta(cell, types, fields)[field] === true;
        };
  const graph = new BlockWalkGraph(grid, types, walkSettingsOf(component, defaultMaxSlope), { anchorOf, ...(standable !== undefined ? { standable } : {}) });
  const all: WalkPlace[] = [];
  const columns = new Set<string>();
  grid.forEach((x, _y, z) => columns.add(colKey(x, z)));
  for (const k of columns) {
    const [x, z] = k.split(',').map(Number) as [number, number];
    all.push(...graph.placesIn(x, z));
  }
  const starts = all.filter((p) => regionContains(boxes, p.x, p.y, p.z) || regionContains(boxes, p.x, p.y + 1, p.z));
  const reached = new Set(walkReach(graph, starts, { maxNodes: Infinity }).places.map((r) => r.place.key));
  const missed = all.filter((p) => !reached.has(p.key));
  missed.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  return { from, starts: starts.length, places: all.length, count: missed.length, cells: missed.slice(0, BLOCK_CHECK_EXAMPLES).map((p) => [p.x, p.y, p.z]) };
}

/**
 * The checks of one layer (see the module comment). `defaultMaxSlope` is the
 * slope a layer without its own `maxSlope` walks (the project's steepest
 * walkable slope).
 */
export function blockLayerChecks(layerId: string, component: BlockLayerComponent, data: BlockLayerData | null, content: { readonly blockTypes?: readonly BlockType[]; readonly cellFields?: readonly CellField[] }, defaultMaxSlope: number): BlockLayerCheck[] {
  const out: BlockLayerCheck[] = [];
  const grid = BlockGrid.from(component, data);
  const types = new Map((content.blockTypes ?? []).map((t) => [t.blockId, t]));
  const name = `block layer "${layerId}"`;
  // Regions with no cell inside the layer's bounds (left behind by a smaller bounds).
  const empty = [...grid.regions].filter(([, boxes]) => boxes.every((b) => b[3]! <= grid.min[0]! || b[0]! >= grid.max[0]! || b[4]! <= grid.min[1]! || b[1]! >= grid.max[1]! || b[5]! <= grid.min[2]! || b[2]! >= grid.max[2]!)).map(([id]) => id).sort();
  if (empty.length > 0) {
    out.push({ code: 'block_region_empty', message: `${name}: ${empty.length === 1 ? 'region' : `${empty.length} regions`} ${empty.slice(0, BLOCK_CHECK_EXAMPLES).map((r) => `"${r}"`).join(', ')}${empty.length > BLOCK_CHECK_EXAMPLES ? ', …' : ''} ${empty.length === 1 ? 'holds' : 'hold'} no cell of the layer (outside its bounds): scripts reading ${empty.length === 1 ? 'it' : 'them'} get no cells`, cells: [] });
  }
  if (component.metadataOnly === true) return out;
  const f = floating(grid, types);
  if (f.groups > 0) {
    out.push({ code: 'block_floating', message: `${name}: ${f.count} block${f.count === 1 ? '' : 's'} in ${f.groups} group${f.groups === 1 ? '' : 's'} float${f.count === 1 ? 's' : ''} (nothing joins ${f.groups === 1 ? 'it' : 'them'} to the layer's lowest blocks), at ${cellList(f.cells)}${f.count > f.cells.length ? ', …' : ''}`, cells: f.cells });
  }
  const u = unreachable(grid, component, types, content.cellFields ?? [], defaultMaxSlope);
  if (u !== null && u.starts === 0) {
    out.push({ code: 'block_unreachable', message: `${name}: its walk starts in region "${u.from}", which holds no place to stand (a top with headroom on a walkable slope): nothing is reachable`, cells: [] });
  } else if (u !== null && u.count > 0) {
    out.push({ code: 'block_unreachable', message: `${name}: ${u.count} of ${u.places} places to stand cannot be walked to from region "${u.from}" (step, drop, headroom and walls as the layer's walk sets them), at ${cellList(u.cells)}${u.count > u.cells.length ? ', …' : ''}`, cells: u.cells });
  }
  return out;
}
