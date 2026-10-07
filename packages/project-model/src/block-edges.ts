/**
 * Edge pieces — block types that stand on the edge between two cells
 * (walls, doors, windows, fences, railings) instead of filling a cell.
 *
 * An edge is a vertical cell side: on an x line (`axis` 0, the plane x = X,
 * between cells X − 1 and X, running along z) or a z line (`axis` 1, the
 * plane z = Z, running along x), one cell row high. It is stored once, with
 * the cell on its + side: edge (x, y, z, 0) is the −x side of cell (x, y, z)
 * and the +x side of cell (x − 1, y, z). A layer's edges reach one past its
 * bounds along their axis, so its outer border can carry walls.
 *
 * A chunk stores its edges beside its cells (`edgePalette` + `edges` rows
 * `[lx, lz, y, axis, p]`, optional keys): the chunk is the one holding the
 * edge's (x, z), so a chunk file, its undo step, its mesh and its collider
 * carry its edges with its cells.
 *
 * An edge piece's look is drawn in the edge frame: the origin at the bottom
 * centre of the edge, local +X along it, local +Z the way it faces (+x for
 * an x-line edge, +z for a z-line one; `rot: 180` faces the other way). Its
 * collision shape is a slab across the edge (`full`, `half` the lower half)
 * `BLOCK_EDGE_THICKNESS` of a cell thick, custom boxes in a cell-sized
 * frame centred on the edge, or none. An edge piece blocks passage
 * (`ctx.grid`, pathfinding) unless its type says it does not or it is open
 * (a door); an open edge has no collider. Edge pieces hide no faces and are
 * never hidden.
 *
 * Pure data rules; the grid stores edges (`block-grid.ts`), the mesher draws
 * them (`block-mesh.ts`).
 */
import { BLOCK_LIMITS, CHUNK_SIZE, type BlockLayerComponent, type BlockType } from './block-layers';
import type { BlockGrid } from './block-grid';
import type { ModelErrorV2 } from './errors';
import { ID_RE } from './validate';

/** 0: on an x line (the plane x = X, running along z); 1: on a z line (running along x). */
export type BlockEdgeAxis = 0 | 1;

/** One edge piece. */
export interface BlockEdge {
  /** The edge block type (`placement: 'edge'`). */
  block: string;
  /** 180: it faces the other way (−x or −z); absent: +x for an x-line edge, +z for a z-line one. */
  rot?: 180;
  /** The look (variant index); absent: picked from the weights by the edge's place. */
  variant?: number;
  /** Open (a door): it lets passage through and has no collider. Absent: closed; stored only when true. */
  open?: boolean;
}

/** Where a block type goes: in a cell (absent) or on a cell edge. */
export type BlockPlacement = 'cell' | 'edge';
export const BLOCK_PLACEMENTS: readonly BlockPlacement[] = ['cell', 'edge'];

/** The collision shapes an edge piece may have: a slab (`full`, `half` its lower half), custom boxes or none. */
export const BLOCK_EDGE_SHAPES: readonly string[] = ['full', 'half', 'custom', 'none'];

/**
 * The thickness of an edge piece's slab (its `full` / `half` collision shape
 * and coloured stand-in), in cell widths: a wall an eighth of a cell thick
 * (12.5 cm on 1 m cells) blocks a character's capsule without eating into the
 * cells either side. A model look draws at its own thickness.
 */
export const BLOCK_EDGE_THICKNESS = 0.125;

/** A cell's four sides, as scripts name an edge from a cell. */
export const BLOCK_EDGE_SIDES = ['-x', '+x', '-z', '+z'] as const;
export type BlockEdgeSide = (typeof BLOCK_EDGE_SIDES)[number];

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

/** Whether a block type stands on cell edges. */
export function blockTypeIsEdge(t: Pick<BlockType, 'placement'> | undefined): boolean {
  return t?.placement === 'edge';
}

/** Whether an edge piece blocks passage now: its type blocks (absent `blocking`: it does) and it is not open. */
export function edgeBlocks(t: Pick<BlockType, 'blocking'>, e: Pick<BlockEdge, 'open'>): boolean {
  return t.blocking !== false && e.open !== true;
}

/** Whether an edge piece has a collider now: a collision shape, and not open. */
export function edgeCollides(t: Pick<BlockType, 'shape'>, e: Pick<BlockEdge, 'open'>): boolean {
  return t.shape !== 'none' && e.open !== true;
}

/** The stored edge (x, y, z, axis) of a cell's side. */
export function edgeOfSide(x: number, y: number, z: number, side: BlockEdgeSide): [number, number, number, BlockEdgeAxis] {
  switch (side) {
    case '-x':
      return [x, y, z, 0];
    case '+x':
      return [x + 1, y, z, 0];
    case '-z':
      return [x, y, z, 1];
    case '+z':
      return [x, y, z + 1, 1];
  }
}

/** The side a stored edge is of the cell on its + side (`-x` or `-z`). */
export const sideOfAxis = (axis: number): BlockEdgeSide => (axis === 0 ? '-x' : '-z');

/** Whether an edge lies within a layer's bounds (one past the cells along its axis: the outer border carries edges). */
export function edgeInBounds(min: readonly number[], max: readonly number[], x: number, y: number, z: number, axis: number): boolean {
  if (y < min[1]! || y >= max[1]!) return false;
  if (axis === 0) return x >= min[0]! && x <= max[0]! && z >= min[2]! && z < max[2]!;
  return x >= min[0]! && x < max[0]! && z >= min[2]! && z <= max[2]!;
}

// ---- values -------------------------------------------------------------------

/** Validate one edge value (shape only; the block type is checked with the content). */
export function validateBlockEdge(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'an edge is an object {block, rot?, variant?, open?}', v);
  for (const k of Object.keys(v)) if (!['block', 'rot', 'variant', 'open'].includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown edge field "${k}"`, k);
  if (typeof v['block'] !== 'string' || !ID_RE.test(v['block'])) err(errors, 'id_invalid', `${path}/block`, 'an edge names its block type (the id syntax)', v['block']);
  if (v['rot'] !== undefined && v['rot'] !== 0 && v['rot'] !== 180) err(errors, 'field_value', `${path}/rot`, 'an edge piece faces one way or the other: rot is 0 or 180', v['rot']);
  if (v['variant'] !== undefined && (!isInt(v['variant']) || v['variant'] < 0 || v['variant'] >= BLOCK_LIMITS.variants)) err(errors, 'field_value', `${path}/variant`, `variant is an index 0-${BLOCK_LIMITS.variants - 1}`, v['variant']);
  if (v['open'] !== undefined && typeof v['open'] !== 'boolean') err(errors, 'field_type', `${path}/open`, 'open is a boolean', v['open']);
}

/** The canonical form of an edge (fixed key order, rot 0 and closed dropped). */
export function canonicalBlockEdge(e: BlockEdge): BlockEdge {
  return { block: e.block, ...(e.rot === 180 ? { rot: 180 as const } : {}), ...(e.variant !== undefined ? { variant: e.variant } : {}), ...(e.open === true ? { open: true } : {}) };
}

// ---- block types ------------------------------------------------------------------

/**
 * The rules a block type's placement adds: an edge piece has an edge shape,
 * no footprint or solid flag (it fills no cell), and turns only end for end;
 * `blocking` belongs to edge pieces.
 */
export function validateBlockPlacement(t: Record<string, unknown>, p: string, errors: ModelErrorV2[]): void {
  const pl = t['placement'];
  if (pl !== undefined && !BLOCK_PLACEMENTS.includes(pl as BlockPlacement)) return err(errors, 'field_value', `${p}/placement`, 'placement is cell or edge', pl);
  if (t['blocking'] !== undefined && typeof t['blocking'] !== 'boolean') err(errors, 'field_type', `${p}/blocking`, 'blocking is a boolean', t['blocking']);
  if (pl !== 'edge') {
    if (t['blocking'] !== undefined) err(errors, 'field_unexpected', `${p}/blocking`, 'blocking belongs to an edge piece (placement edge)', 'blocking');
    return;
  }
  if (t['shape'] !== undefined && !BLOCK_EDGE_SHAPES.includes(t['shape'] as string)) err(errors, 'field_value', `${p}/shape`, `an edge piece's collision shape is ${BLOCK_EDGE_SHAPES.join(', ')} (a slab across the edge, its lower half, boxes or none)`, t['shape']);
  if (t['footprint'] !== undefined) err(errors, 'field_unexpected', `${p}/footprint`, 'an edge piece stands on one cell edge (no footprint; stack edges for a taller wall)', 'footprint');
  if (t['solid'] !== undefined) err(errors, 'field_unexpected', `${p}/solid`, 'an edge piece fills no cell (no solid flag)', 'solid');
  const r = t['rotations'];
  if (Array.isArray(r) && r.some((x) => x !== 0 && x !== 180)) err(errors, 'field_value', `${p}/rotations`, 'an edge piece turns end for end only: rotations is a set of 0 and 180', r);
}

/** The metres a block type's look and collision shape are made for on an edge: a slab along the edge (custom boxes: a whole cell around it). */
export function edgeLookMetres(t: Pick<BlockType, 'shape'>, cs: readonly number[]): [number, number, number] {
  return [cs[0]!, cs[1]!, t.shape === 'custom' ? cs[2]! : cs[2]! * BLOCK_EDGE_THICKNESS];
}

/** Where an edge piece is drawn: its origin (layer-local metres, the bottom centre of the edge) and its turn about +Y in degrees. */
export function edgeFrame(cs: readonly number[], x: number, y: number, z: number, axis: number, rot: number | undefined): { ox: number; oy: number; oz: number; rot: number } {
  // An x-line edge runs along z: the look's +X turned onto it (a quarter turn), facing +x.
  const base = axis === 0 ? 90 : 0;
  const turn = (base + (rot ?? 0)) % 360;
  return axis === 0 ? { ox: x * cs[0]!, oy: y * cs[1]!, oz: (z + 0.5) * cs[2]!, rot: turn } : { ox: (x + 0.5) * cs[0]!, oy: y * cs[1]!, oz: z * cs[2]!, rot: turn };
}

/** A live edge piece's root placement in the world (the frame the chunk draws its model in). */
export function liveEdgePlacement(
  origin: { x: number; y: number; z: number },
  cs: readonly number[],
  x: number,
  y: number,
  z: number,
  axis: number,
  rot: number | undefined,
): { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] } {
  const f = edgeFrame(cs, x, y, z, axis, rot);
  const a = ((f.rot * Math.PI) / 180) / 2;
  return { position: [origin.x + f.ox, origin.y + f.oy, origin.z + f.oz], rotation: f.rot === 0 ? [0, 0, 0, 1] : [0, Math.sin(a), 0, Math.cos(a)], scale: [1, 1, 1] };
}

// ---- chunks -----------------------------------------------------------------------------

/** A chunk's edge rows: `[lx, lz, y, axis, p]` (lx, lz within the chunk; p an `edgePalette` index). */
export const EDGE_ROW_LENGTH = 5;

/** The rules of a chunk's `edgePalette` and `edges` (structure, uniqueness, the layer's bounds). */
export function validateChunkEdges(c: Record<string, unknown>, cp: string, errors: ModelErrorV2[], comp: Pick<BlockLayerComponent, 'bounds' | 'metadataOnly'>): void {
  const palette = c['edgePalette'];
  const rows = c['edges'];
  if (palette === undefined && rows === undefined) return;
  if (comp.metadataOnly === true) return err(errors, 'field_value', `${cp}/edges`, 'a metadata-only layer holds no edge pieces');
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > BLOCK_LIMITS.chunkPalette) return err(errors, 'field_value', `${cp}/edgePalette`, `edgePalette is a list of 1-${BLOCK_LIMITS.chunkPalette} edges (with edges)`, Array.isArray(palette) ? palette.length : palette);
  const before = errors.length;
  palette.forEach((e, i) => validateBlockEdge(e, `${cp}/edgePalette/${i}`, errors));
  if (errors.length > before) return;
  if (!Array.isArray(rows) || rows.length < 1) return err(errors, 'field_value', `${cp}/edges`, 'edges is a non-empty list of [lx, lz, y, axis, p] rows (with an edgePalette)', rows);
  const seen = new Set<number>();
  const cx = c['cx'] as number;
  const cz = c['cz'] as number;
  const { min, max } = comp.bounds;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const p = `${cp}/edges/${i}`;
    if (!Array.isArray(r) || r.length !== EDGE_ROW_LENGTH || !r.every(isInt)) return err(errors, 'field_value', p, 'an edge row is [lx, lz, y, axis, p] integers', r);
    const [lx, lz, y, axis, pi] = r as number[];
    if (lx! < 0 || lx! >= CHUNK_SIZE || lz! < 0 || lz! >= CHUNK_SIZE || (axis !== 0 && axis !== 1) || pi! < 0 || pi! >= palette.length) return err(errors, 'field_value', p, `an edge row has lx, lz in 0-${CHUNK_SIZE - 1}, axis 0 or 1 and an edgePalette index`, r);
    const k = edgeLocalKey(lx!, lz!, y!, axis);
    if (seen.has(k)) return err(errors, 'field_value', p, 'an edge appears twice', r);
    seen.add(k);
    const x = cx * CHUNK_SIZE + lx!;
    const z = cz * CHUNK_SIZE + lz!;
    if (!edgeInBounds(min, max, x, y!, z, axis)) return err(errors, 'field_value', p, "an edge lies outside its layer's bounds", [x, y, z, axis]);
  }
}

/** One number per edge within a chunk (rows sort by it: y, axis, z, x). */
export function edgeLocalKey(lx: number, lz: number, y: number, axis: number): number {
  return ((y + BLOCK_LIMITS.coordinateY) * 2 + axis) * CHUNK_SIZE * CHUNK_SIZE + lz * CHUNK_SIZE + lx;
}

/** A chunk's edges in canonical form: palette entries merged and reindexed by first use, rows ordered (null: none). */
export function canonicalChunkEdges(palette: readonly BlockEdge[] | undefined, rows: readonly (readonly number[])[] | undefined): { edgePalette: BlockEdge[]; edges: number[][] } | null {
  return canonicalEdgeRows(palette, rows, (a, b) => edgeLocalKey(a[0]!, a[1]!, a[2]!, a[3]!) - edgeLocalKey(b[0]!, b[1]!, b[2]!, b[3]!));
}

/** Pattern edge rows (a stamp's, an array edit's: `[x, z, y, axis, p]` within the pattern) in canonical form (y, axis, z, x ascending). */
export function canonicalPatternEdges(palette: readonly BlockEdge[] | undefined, rows: readonly (readonly number[])[] | undefined): { edgePalette: BlockEdge[]; edges: number[][] } | null {
  return canonicalEdgeRows(palette, rows, (a, b) => a[2]! - b[2]! || a[3]! - b[3]! || a[1]! - b[1]! || a[0]! - b[0]!);
}

function canonicalEdgeRows(palette: readonly BlockEdge[] | undefined, rows: readonly (readonly number[])[] | undefined, order: (a: readonly number[], b: readonly number[]) => number): { edgePalette: BlockEdge[]; edges: number[][] } | null {
  if (palette === undefined || rows === undefined || rows.length === 0) return null;
  const canon = palette.map(canonicalBlockEdge);
  const keyOf = canon.map((e) => JSON.stringify(e));
  const sorted = rows.map((r) => [...r]).sort(order);
  const byKey = new Map<string, number>();
  const edgePalette: BlockEdge[] = [];
  const edges = sorted.map((r) => {
    const k = keyOf[r[4]!]!;
    let q = byKey.get(k);
    if (q === undefined) {
      q = edgePalette.length;
      byKey.set(k, q);
      edgePalette.push(canon[r[4]!]!);
    }
    return [r[0]!, r[1]!, r[2]!, r[3]!, q];
  });
  return { edgePalette, edges };
}

/** The content's rules for a chunk's edges: each names an edge block type with that variant. */
export function composeChunkEdges(palette: readonly BlockEdge[] | undefined, path: string, types: ReadonlyMap<string, BlockType>, errors: ModelErrorV2[]): void {
  (palette ?? []).forEach((e, k) => {
    const p = `${path}/${k}`;
    const t = types.get(e.block);
    if (t === undefined) err(errors, 'reference_missing', `${p}/block`, 'an edge names a block type of content.blockTypes', e.block);
    else if (!blockTypeIsEdge(t)) err(errors, 'field_value', `${p}/block`, `block "${t.blockId}" fills cells; an edge holds an edge piece (placement edge)`, e.block);
    else {
      if (!(t.rotations ?? [0, 180]).includes(e.rot ?? 0)) err(errors, 'field_value', `${p}/rot`, `edge piece "${t.blockId}" allows the rotations ${(t.rotations ?? [0, 180]).join(', ')}`, e.rot ?? 0);
      if (e.variant !== undefined && e.variant >= t.variants.length) err(errors, 'field_value', `${p}/variant`, `block "${t.blockId}" has ${t.variants.length} variant(s)`, e.variant);
    }
  });
}

// ---- the edges edit -----------------------------------------------------------------------

/** Set the edges at `at` (x, y, z, axis, …) or every edge on or inside `box` (`null` removes); `keep`: only where none stands. */
export interface EdgesEdit {
  kind: 'edges';
  at?: number[];
  box?: number[];
  edge: BlockEdge | null;
  mode?: 'set' | 'keep';
}

/** The edit's shape (argument rules); null: valid. */
export function edgesEditShapeError(e: Record<string, unknown>): { key: string; message: string } | null {
  const ints = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => Number.isSafeInteger(x));
  if ((e['at'] === undefined) === (e['box'] === undefined)) return { key: 'at', message: 'an edges edit takes at (x, y, z, axis quads) or box' };
  if (e['at'] !== undefined && (!ints(e['at']) || e['at'].length === 0 || e['at'].length % 4 !== 0 || e['at'].some((v, i) => i % 4 === 3 && v !== 0 && v !== 1))) return { key: 'at', message: 'at is a flat list of integer x, y, z, axis (0: an x line, 1: a z line) quads' };
  if (e['box'] !== undefined && (!ints(e['box']) || e['box'].length !== 6)) return { key: 'box', message: 'box is [x0, y0, z0, x1, y1, z1] integers (max exclusive): the edges on or inside it' };
  if (e['edge'] !== null) {
    const errors: ModelErrorV2[] = [];
    validateBlockEdge(e['edge'], '', errors);
    if (errors.length > 0) return { key: 'edge', message: `${errors[0]!.path || 'edge'}: ${errors[0]!.message}` };
  }
  if (e['mode'] !== undefined && e['mode'] !== 'set' && e['mode'] !== 'keep') return { key: 'mode', message: 'mode is set or keep' };
  return null;
}

/** The edges an edges edit names (x, y, z, axis), in a stable order; a string: why it cannot. */
export function edgesEditTargets(g: Pick<BlockGrid, 'min' | 'max'>, e: EdgesEdit, maxEdges: number): number[][] | string {
  const out: number[][] = [];
  if (e.at !== undefined) {
    for (let k = 0; k < e.at.length; k += 4) {
      const [x, y, z, axis] = [e.at[k]!, e.at[k + 1]!, e.at[k + 2]!, e.at[k + 3]!];
      if (!edgeInBounds(g.min, g.max, x, y, z, axis)) return `edge [${x}, ${y}, ${z}, ${axis}] lies outside the layer's bounds [${g.min.join(', ')}] - [${g.max.join(', ')}] (edges reach one past the cells along their axis)`;
      out.push([x, y, z, axis]);
    }
    return out;
  }
  const b = e.box!;
  if (!(b[3]! > b[0]! && b[4]! > b[1]! && b[5]! > b[2]!)) return 'a box has max > min on every axis';
  // Clip to the bounds (one past the cells on the edge axis), then every edge on the box's outline or inside it.
  const x0 = Math.max(b[0]!, g.min[0]);
  const x1 = Math.min(b[3]!, g.max[0]);
  const y0 = Math.max(b[1]!, g.min[1]);
  const y1 = Math.min(b[4]!, g.max[1]);
  const z0 = Math.max(b[2]!, g.min[2]);
  const z1 = Math.min(b[5]!, g.max[2]);
  const count = Math.max(0, y1 - y0) * (Math.max(0, x1 - x0 + 1) * Math.max(0, z1 - z0) + Math.max(0, x1 - x0) * Math.max(0, z1 - z0 + 1));
  if (count > maxEdges) return `a box covers at most ${maxEdges} edges of the layer`;
  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) for (let x = x0; x <= x1; x++) out.push([x, y, z, 0]);
    for (let z = z0; z <= z1; z++) for (let x = x0; x < x1; x++) out.push([x, y, z, 1]);
  }
  return out;
}

// ---- patterns: copies, stamps and arrays carry their edges ----------------------------------

/** Whether an edge lies on or inside a box `[x0, y0, z0, x1, y1, z1]` (max exclusive for cells: the box's outline edges count). */
export function edgeInBox(b: readonly number[], x: number, y: number, z: number, axis: number): boolean {
  return edgeInBounds([b[0]!, b[1]!, b[2]!], [b[3]!, b[4]!, b[5]!], x, y, z, axis);
}

/**
 * An edge moved by a pattern transform within a `w` × `d` extent: turned
 * `turn` degrees counter-clockwise seen from above (as cells turn: x' = z,
 * z' = w − x), then mirrored; its place (the edge's lower grid point and its
 * axis) and the way it faces follow.
 */
export function transformEdge(lx: number, lz: number, axis: number, rot: number | undefined, w: number, d: number, turn: number, mirror: 'x' | 'z' | undefined): { x: number; z: number; axis: BlockEdgeAxis; rot: 0 | 180 } {
  let a: [number, number] = [lx, lz];
  let b: [number, number] = axis === 0 ? [lx, lz + 1] : [lx + 1, lz];
  // The way it faces (+x for an x-line edge, +z for a z-line one; rot 180 the other way).
  let f: [number, number] = axis === 0 ? [1, 0] : [0, 1];
  if (rot === 180) f = [-f[0], -f[1]];
  let W = w;
  let D = d;
  for (let i = 0; i < ((turn / 90) | 0); i++) {
    a = [a[1], W - a[0]];
    b = [b[1], W - b[0]];
    f = [f[1], -f[0]];
    [W, D] = [D, W];
  }
  if (mirror === 'x') {
    a = [W - a[0], a[1]];
    b = [W - b[0], b[1]];
    f = [-f[0], f[1]];
  } else if (mirror === 'z') {
    a = [a[0], D - a[1]];
    b = [b[0], D - b[1]];
    f = [f[0], -f[1]];
  }
  const nextAxis: BlockEdgeAxis = a[0] === b[0] ? 0 : 1;
  const facesPlus = nextAxis === 0 ? f[0] > 0 : f[1] > 0;
  return { x: Math.min(a[0], b[0]), z: Math.min(a[1], b[1]), axis: nextAxis, rot: facesPlus ? 0 : 180 };
}

/** The rules of a pattern's edge rows (`[x, z, y, axis, p]` within `size`, the outline included; an `edgePalette` index). */
export function validatePatternEdges(palette: unknown, rows: unknown, path: string, size: readonly number[], errors: ModelErrorV2[]): void {
  if (palette === undefined && rows === undefined) return;
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > BLOCK_LIMITS.chunkPalette) return err(errors, 'field_value', `${path}/edgePalette`, `edgePalette is a list of 1-${BLOCK_LIMITS.chunkPalette} edges (with edges)`, Array.isArray(palette) ? palette.length : palette);
  const before = errors.length;
  palette.forEach((e, i) => validateBlockEdge(e, `${path}/edgePalette/${i}`, errors));
  if (errors.length > before) return;
  if (!Array.isArray(rows) || rows.length < 1) return err(errors, 'field_value', `${path}/edges`, 'edges is a non-empty list of [x, z, y, axis, p] rows (with an edgePalette)', rows);
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const p = `${path}/edges/${i}`;
    if (!Array.isArray(r) || r.length !== EDGE_ROW_LENGTH || !r.every(isInt)) return err(errors, 'field_value', p, 'an edge row is [x, z, y, axis, p] integers', r);
    const [x, z, y, axis, pi] = r as number[];
    if ((axis !== 0 && axis !== 1) || pi! < 0 || pi! >= palette.length || !edgeInBounds([0, 0, 0], size, x!, y!, z!, axis)) return err(errors, 'field_value', p, `an edge row lies within the pattern (its outline included), axis 0 or 1, with an edgePalette index`, r);
    const k = `${x},${z},${y},${axis}`;
    if (seen.has(k)) return err(errors, 'field_value', p, 'an edge appears twice', r);
    seen.add(k);
  }
}
