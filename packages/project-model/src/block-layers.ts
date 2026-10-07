/**
 * Block layers — a grid of blocks for building levels.
 *
 * Content (v4, optional keys, absent = none so existing content bytes stay):
 * - `content.blockTypes[]` — block definitions: a mesh (a model asset, a
 *   piece of one, or a prefab's model) per weighted variant, or a coloured
 *   stand-in built from the collision shape; a collision shape (full, half,
 *   ramp, stairs, custom boxes, none); whether it is solid (fills its cell
 *   and hides the faces of neighbours touching it); a footprint of several
 *   cells; the allowed rotations; default cell metadata; material mapping.
 * - `content.cellFields[]` — the project's cell metadata schema (bool, enum,
 *   int, float, string fields with defaults).
 * - `content.blockStamps[]` — saved patterns of cells (a cottage footprint,
 *   a bridge span) placed with the `stamp` edit.
 *
 * Scene (v4): an entity carries the `blockLayer` component (cell size per
 * axis, bounds in cells, metadata-only or not, collision on/off); its origin
 * is the entity's position (the min corner of cell [0, 0, 0]; the layer is a
 * root at identity rotation and unit scale). The cells live in the scene's
 * `blocks[]` (one entry per layer entity that has cells or regions): sparse
 * chunks of 16 × 16 columns, each a palette of cell values and run-length
 * columns, and the layer's named regions. Storage v4 writes each chunk to its
 * own file (`scenes/<sceneId>.blocks/<entityId>.<cx>.<cz>.json`).
 *
 * A cell holds a block id, a rotation (quarter turns about +Y), a variant
 * (absent: picked deterministically from the variants' weights by the cell
 * coordinates) and metadata overrides; a metadata-only cell holds only
 * metadata. A block with a larger footprint is stored at its anchor (the
 * footprint's min corner); the cells it covers stay empty.
 *
 * Pure data rules; the grid helpers are `block-grid.ts`, the meshing
 * `block-mesh.ts`.
 */
import { validateLightLayerMask } from './light-layers';
import { ID_RE } from './validate';
import type { ModelErrorV2 } from './errors';
import { chunkPaintError, decodeChunkPaint, encodeChunkPaint, isUnpainted } from './block-paint';
import { liveBlockPrefabProblem } from './block-live';

// ---- types -----------------------------------------------------------------------

/** A metadata value: bool, number (int/float) or string. */
export type CellMetaValue = boolean | number | string;

/** One cell's value. At least one of `block` / `meta`. */
export interface BlockCell {
  /** The block type (`content.blockTypes[].blockId`); absent = a metadata-only cell. */
  block?: string;
  /** Degrees about +Y (counter-clockwise seen from above): 90, 180 or 270; absent = 0. */
  rot?: 90 | 180 | 270;
  /** The variant index; absent = picked from the weights by the cell coordinates. */
  variant?: number;
  /**
   * The heights of the block's top corners — −x−z, +x−z, +x+z, −x+z in the
   * layer's axes, whatever the rotation — in cell heights above the cell's
   * bottom, 0–4 in steps of 1/64 (absent: a flat full top, all 1). A
   * single-cell `full` block only: sloped terrain. Above 1, so a slope that
   * crosses row boundaries inside one column stays one smooth surface (the
   * cell reaches into the cells above it, which then stay empty). The top is
   * two triangles split along one diagonal (`splitsMainDiagonal`); the sides
   * follow the corners.
   */
  corners?: [number, number, number, number];
  /** Metadata overrides (field key → value); the block's defaults and the schema's fill the rest. */
  meta?: Record<string, CellMetaValue>;
}

/** A chunk: 16 × 16 columns. `columns[i] = [lx, lz, y0, n0, p0, y1, n1, p1, …]` (runs of `n` cells from `y` holding `palette[p]`). */
export interface BlockChunk {
  cx: number;
  cz: number;
  palette: BlockCell[];
  columns: number[][];
  /**
   * The layer's paint over this chunk — base64 of its 17 × 17
   * lattice vertices × (four layer weights summing to 255, a wetness), what
   * a painted terrain material reads (`block-paint.ts`). Absent: unpainted
   * (all first layer, dry).
   */
  paint?: string;
}

/** A named set of cells: boxes `[x0, y0, z0, x1, y1, z1]` (min inclusive, max exclusive). */
export interface BlockRegion {
  regionId: string;
  boxes: number[][];
}

/** A layer's cells and regions in a scene (`scene.blocks[]`). */
export interface BlockLayerData {
  entityId: string;
  chunks?: BlockChunk[];
  regions?: BlockRegion[];
}

/** The `blockLayer` component. */
export interface BlockLayerComponent {
  /** Metres per cell along x, y, z. */
  cellSize: [number, number, number];
  /** The cells the layer may hold (min inclusive, max exclusive). */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** A layer of metadata-only cells (deploy zones, no-walk areas, trigger ids): no blocks, no geometry (absent: false; stored only when true). */
  metadataOnly?: boolean;
  /** The blocks' collision shapes are colliders in a 3D project (absent: true; stored only when false). */
  collision?: boolean;
  /** Casts the directional light's shadow (absent: true; stored only when false). */
  castShadow?: boolean;
  /** Shows shadows falling on it (absent: true; stored only when false). */
  receiveShadow?: boolean;
  /** The light layers its blocks are in, a bit mask (light-layers.ts; absent: every layer). */
  lightLayers?: number;
  /**
   * Degrees: the steepest part of the layer's surface that counts as ground —
   * characters do not walk up steeper slopes whatever their own slope limit,
   * and `ctx.grid` surface queries call steeper surfaces not walkable (absent:
   * each character's own slope limit; queries use the project's
   * `max_slope_climb_deg`).
   */
  maxSlope?: number;
  /**
   * Degrees: the crease angle of the layer's tops. Tops that meet at the same
   * height share smoothed vertex normals (across cells and chunk edges) where
   * they meet at less than this angle; sharper edges stay hard (absent or 0:
   * flat-shaded tops; stored only when above 0).
   */
  smoothAngle?: number;
  /** How finely sloped tops are cut, one of `BLOCK_TOP_SUBDIVISIONS` (absent: 1; stored only when above 1). */
  topSubdivision?: number;
}

export type BlockShape = 'full' | 'half' | 'ramp' | 'stairs' | 'custom' | 'none';
export const BLOCK_SHAPES: readonly BlockShape[] = ['full', 'half', 'ramp', 'stairs', 'custom', 'none'];

/**
 * Where a block look's texture coordinates come from: `model`, the look's
 * own (a stand-in, or a model piece without any, takes world ones); `world`,
 * generated from the cell's position in the layer, in metres, so a texture
 * runs on across cells without a seam (box mapping: one planar projection
 * per face).
 */
export type BlockUvMode = 'model' | 'world';
export const BLOCK_UV_MODES: readonly BlockUvMode[] = ['model', 'world'];

/** One look of a block: a model (asset, optional piece), a prefab's model, or a coloured stand-in shaped like the collision shape. */
export interface BlockVariant {
  model?: { assetId: string; piece?: string };
  prefab?: string;
  /** The stand-in's colour (no model/prefab) — "#rrggbb". */
  color?: string;
  /** Relative weight when the cell names no variant (absent: 1). */
  weight?: number;
  /** This look's texture coordinates (absent: the block type's). */
  uv?: BlockUvMode;
}

export interface BlockType {
  blockId: string;
  name: string;
  variants: BlockVariant[];
  /** The collision shape (and the stand-in's shape). */
  shape: BlockShape;
  /** `custom`: boxes in footprint units `[x0, y0, z0, x1, y1, z1]` within [0, 1]. */
  boxes?: number[][];
  /** Fills its cell and hides the faces of neighbours touching it (absent: shape is `full`). */
  solid?: boolean;
  /** Cells along x, y, z (absent: [1, 1, 1]). */
  footprint?: [number, number, number];
  /** Allowed rotations in degrees (absent: all four). */
  rotations?: number[];
  /** Default cell metadata. */
  metadata?: Record<string, CellMetaValue>;
  /** Model material mapping (source material name or "*" → materialId). */
  materials?: Record<string, string>;
  /** Its looks' texture coordinates (absent: `model`; stored only when `world`); a variant may set its own. */
  uv?: BlockUvMode;
  /**
   * Its prefab looks spawn the prefab as a live entity per cell while the
   * game runs (`block-live.ts`); absent: the prefab's model is drawn only.
   * Stored only when true.
   */
  live?: boolean;
}

export type CellFieldType = 'bool' | 'enum' | 'int' | 'float' | 'string';
export const CELL_FIELD_TYPES: readonly CellFieldType[] = ['bool', 'enum', 'int', 'float', 'string'];

export interface CellField {
  key: string;
  type: CellFieldType;
  /** Absent: false / the first enum value / 0 / "". */
  default?: CellMetaValue;
  /** enum only: the values. */
  values?: string[];
  /** int/float: the range. */
  min?: number;
  max?: number;
  /** The overlay colour the editor paints the field with ("#rrggbb"). */
  color?: string;
  label?: string;
}

/** A saved pattern of cells (relative to its min corner). */
export interface BlockStamp {
  stampId: string;
  name: string;
  size: [number, number, number];
  palette: BlockCell[];
  /** `[x, z, y0, n0, p0, …]` runs, as a chunk's columns (coordinates within `size`). */
  columns: number[][];
}

// ---- limits ------------------------------------------------------------------------

export const CHUNK_SIZE = 16;

/**
 * Engine limits (they protect the runtime and keep requests under the 64 KiB
 * command cap): block types of 8 variants, 32 metadata fields, stamps of at
 * most 16,384 cells, 16 layers per scene, a layer up to 1,024 × 256 × 1,024
 * cells, coordinates within ±4,096 horizontally and ±1,024 vertically, 256
 * regions of 1,024 boxes. A project has as many block types and stamps as it
 * needs (each is edited alone; cells name a type by id through a per-chunk
 * palette), and a layer as many cells as its bounds hold: what bounds a layer
 * is memory (diagnostics show each layer's), never a cell count.
 */
export const BLOCK_LIMITS = Object.freeze({
  variants: 8,
  footprint: 8,
  customBoxes: 8,
  cellFields: 32,
  enumValues: 32,
  stringLength: 64,
  stampCells: 16_384,
  stampSize: 64,
  layersPerScene: 16,
  layerWidth: 1024,
  layerHeight: 256,
  coordinateXZ: 4096,
  coordinateY: 1024,
  chunkPalette: 4096,
  regions: 256,
  regionBoxes: 1024,
  cellSizeMin: 0.05,
  cellSizeMax: 64,
});

/**
 * A sloped cell's corner heights are multiples of 1/64 of the cell height:
 * exact in binary, so stored values, diffs and replays never drift, and fine
 * enough for smooth hills (1.6 cm on a 1 m cell).
 */
export const BLOCK_CORNER_STEPS = 64;
/**
 * The highest corner of a sloped cell, in cell heights. A column's top cell is
 * the row under its lowest corner, so a column whose corners differ by up to
 * three rows is always one smooth surface (its cell reaches up to three rows
 * into the cells above it, which stay empty); steeper columns keep a wall.
 * Three rows covers 56° on half-height cells and 71° on cubes.
 */
export const BLOCK_CORNER_MAX = 4;

/** The steepest and flattest `maxSlope` a layer may set (degrees). */
export const BLOCK_MAX_SLOPE_RANGE = Object.freeze({ min: 1, max: 89 });
/**
 * A layer's crease angle (`smoothAngle`, degrees): 0 keeps every top
 * flat-shaded (the default), 180 smooths across any edge where tops meet.
 */
export const BLOCK_SMOOTH_ANGLE_RANGE = Object.freeze({ min: 0, max: 180 });
/**
 * How finely a sloped top is cut (`topSubdivision`): 1 is the corners' two
 * planar triangles; 2 cuts it 2 × 2 with the inner heights blended from the
 * corners, so a hill reads as rolling ground instead of diamonds. The
 * collision shape stays the corners' two triangles either way.
 */
export const BLOCK_TOP_SUBDIVISIONS: readonly number[] = Object.freeze([1, 2]);
export const CELL_FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const REGION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const PIECE_RE = /^[^\u0000-\u001f]{1,128}$/;
const ROTATIONS = [0, 90, 180, 270];

// ---- helpers -------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
function onlyKeys(v: Record<string, unknown>, keys: readonly string[], path: string, errors: ModelErrorV2[], what: string): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}"`, k, keys.join(', '));
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const canonNum = (n: number): number => (n === 0 ? 0 : n);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedKeys = (o: Record<string, unknown>): string[] => Object.keys(o).sort(cmp);

function isIntVec3(v: unknown, lo: number, hi: number): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => isInt(x) && x >= lo && x <= hi);
}

// ---- cell values ------------------------------------------------------------------

/** Validate one cell value (shape only; references are checked with the content). */
export function validateBlockCell(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a cell is an object {block?, rot?, variant?, corners?, meta?}', v, 'object');
  onlyKeys(v, ['block', 'rot', 'variant', 'corners', 'meta'], path, errors, 'cell');
  if (v['block'] !== undefined && (typeof v['block'] !== 'string' || !ID_RE.test(v['block']))) err(errors, 'id_invalid', `${path}/block`, 'a block id uses the id syntax', v['block']);
  if (v['rot'] !== undefined && v['rot'] !== 0 && v['rot'] !== 90 && v['rot'] !== 180 && v['rot'] !== 270) err(errors, 'field_value', `${path}/rot`, 'rot is 0, 90, 180 or 270 (degrees about +Y)', v['rot'], '0 | 90 | 180 | 270');
  if (v['variant'] !== undefined && (!isInt(v['variant']) || v['variant'] < 0 || v['variant'] >= BLOCK_LIMITS.variants)) err(errors, 'field_value', `${path}/variant`, `variant is an index 0-${BLOCK_LIMITS.variants - 1}`, v['variant']);
  if (v['corners'] !== undefined) {
    const c = v['corners'];
    if (!Array.isArray(c) || c.length !== 4 || !c.every((x) => finite(x) && x >= 0 && x <= BLOCK_CORNER_MAX && Number.isInteger(x * BLOCK_CORNER_STEPS))) {
      err(errors, 'field_value', `${path}/corners`, `corners is 4 heights (−x−z, +x−z, +x+z, −x+z) in 0-${BLOCK_CORNER_MAX} cell heights, in steps of 1/${BLOCK_CORNER_STEPS}`, c);
    } else if (c.every((x) => x === 0)) err(errors, 'field_value', `${path}/corners`, 'a sloped cell has at least one corner above 0 (a cell without height is empty)', c);
    if (v['block'] === undefined) err(errors, 'field_value', `${path}/corners`, 'corners belong to a block cell', c);
  }
  if (v['meta'] !== undefined) validateMetaMap(v['meta'], `${path}/meta`, errors);
  const hasMeta = isPlainObject(v['meta']) && Object.keys(v['meta']).length > 0;
  if (v['block'] === undefined && !hasMeta) err(errors, 'field_value', path, 'a cell holds a block, metadata or both (an empty cell is not stored)', v, '{block} or {meta}');
  if (v['block'] === undefined && (v['rot'] !== undefined || v['variant'] !== undefined)) err(errors, 'field_value', path, 'rot and variant belong to a block cell', v);
}

function validateMetaMap(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'metadata is an object (field key → value)', v, 'object');
  const keys = Object.keys(v);
  if (keys.length > BLOCK_LIMITS.cellFields) err(errors, 'limits_exceeded', path, `at most ${BLOCK_LIMITS.cellFields} metadata fields`, keys.length);
  for (const k of keys) {
    if (!CELL_FIELD_KEY_RE.test(k)) err(errors, 'field_value', `${path}/${k}`, 'a metadata key is an identifier (1-32 characters)', k);
    const x = v[k];
    if (typeof x === 'string') {
      if (x.length > BLOCK_LIMITS.stringLength) err(errors, 'field_value', `${path}/${k}`, `a metadata string has at most ${BLOCK_LIMITS.stringLength} characters`, x.length);
    } else if (typeof x !== 'boolean' && !finite(x)) err(errors, 'field_type', `${path}/${k}`, 'a metadata value is a boolean, a finite number or a string', x, 'boolean | number | string');
  }
}

/** The canonical form of a cell (fixed key order, rot 0 dropped, meta keys sorted, empty meta dropped). */
export function canonicalBlockCell(c: BlockCell): BlockCell {
  const out: BlockCell = {};
  if (c.block !== undefined) out.block = c.block;
  if (c.block !== undefined && c.rot !== undefined && (c.rot as number) !== 0) out.rot = c.rot;
  if (c.block !== undefined && c.variant !== undefined) out.variant = c.variant;
  if (c.block !== undefined && c.corners !== undefined && !c.corners.every((x) => x === 1)) out.corners = [canonNum(c.corners[0]), canonNum(c.corners[1]), canonNum(c.corners[2]), canonNum(c.corners[3])];
  if (c.meta !== undefined) {
    const keys = sortedKeys(c.meta);
    if (keys.length > 0) {
      const meta: Record<string, CellMetaValue> = {};
      for (const k of keys) {
        const x = c.meta[k] as CellMetaValue;
        meta[k] = typeof x === 'number' ? canonNum(x) : x;
      }
      out.meta = meta;
    }
  }
  return out;
}

/** A stable key of a canonical cell (equal cells, equal keys). */
export function blockCellKey(c: BlockCell): string {
  return JSON.stringify(canonicalBlockCell(c));
}

// ---- runs (chunk columns and stamps) ----------------------------------------------

/**
 * Validate `columns` of a chunk (`xzMax` 16) or a stamp (its size). Returns
 * the number of cells, or -1 on a structural error.
 */
function validateColumns(v: unknown, path: string, errors: ModelErrorV2[], xMax: number, zMax: number, yMin: number, yMax: number, paletteLength: number): number {
  if (!Array.isArray(v)) {
    err(errors, 'field_type', path, 'columns is an array of [x, z, y, n, p, …] runs', v, 'array');
    return -1;
  }
  if (v.length > xMax * zMax) {
    err(errors, 'limits_exceeded', path, `at most ${xMax * zMax} columns`, v.length);
    return -1;
  }
  let cells = 0;
  const seen = new Set<number>();
  for (let i = 0; i < v.length; i++) {
    const col = v[i];
    const p = `${path}/${i}`;
    if (!Array.isArray(col) || col.length < 5 || (col.length - 2) % 3 !== 0 || !col.every(isInt)) {
      err(errors, 'field_value', p, 'a column is [x, z, y, n, p, …] integers (runs of n cells from y holding palette[p])', col);
      return -1;
    }
    const [x, z] = col as number[];
    if (x! < 0 || x! >= xMax || z! < 0 || z! >= zMax) {
      err(errors, 'field_value', p, `column x/z must be within 0-${xMax - 1} / 0-${zMax - 1}`, [x, z]);
      return -1;
    }
    const k = z! * 4096 + x!;
    if (seen.has(k)) {
      err(errors, 'field_value', p, 'a column appears twice', [x, z]);
      return -1;
    }
    seen.add(k);
    const runs: [number, number, number][] = [];
    for (let j = 2; j < col.length; j += 3) {
      const y = col[j] as number;
      const n = col[j + 1] as number;
      const pi = col[j + 2] as number;
      if (n < 1 || y < yMin || y + n > yMax) {
        err(errors, 'field_value', p, `a run covers cells within y ${yMin}-${yMax - 1} (n >= 1)`, [y, n]);
        return -1;
      }
      if (pi < 0 || pi >= paletteLength) {
        err(errors, 'field_value', p, 'a run names a palette entry', pi);
        return -1;
      }
      runs.push([y, n, pi]);
      cells += n;
    }
    runs.sort((a, b) => a[0] - b[0]);
    for (let j = 1; j < runs.length; j++) {
      if (runs[j]![0] < runs[j - 1]![0] + runs[j - 1]![1]) {
        err(errors, 'field_value', p, 'the runs of a column overlap', col);
        return -1;
      }
    }
  }
  return cells;
}

/**
 * Canonical palette + columns: duplicate palette values merged, runs sorted
 * and joined, palette reindexed by first use (columns by z then x, runs by y),
 * unused entries dropped. Diff-friendly and deterministic.
 */
export function canonicalRuns(palette: readonly BlockCell[], columns: readonly (readonly number[])[]): { palette: BlockCell[]; columns: number[][] } {
  const canon = palette.map(canonicalBlockCell);
  const keyOf = canon.map((c) => JSON.stringify(c));
  const firstByKey = new Map<string, number>();
  const alias = keyOf.map((k, i) => {
    const f = firstByKey.get(k);
    if (f !== undefined) return f;
    firstByKey.set(k, i);
    return i;
  });
  const cols = columns
    .map((col) => {
      const runs: [number, number, number][] = [];
      for (let j = 2; j < col.length; j += 3) runs.push([col[j]!, col[j + 1]!, alias[col[j + 2]!]!]);
      runs.sort((a, b) => a[0] - b[0]);
      const merged: [number, number, number][] = [];
      for (const r of runs) {
        const last = merged[merged.length - 1];
        if (last !== undefined && last[2] === r[2] && last[0] + last[1] === r[0]) last[1] += r[1];
        else merged.push([r[0], r[1], r[2]]);
      }
      return { x: col[0]!, z: col[1]!, runs: merged };
    })
    .filter((c) => c.runs.length > 0)
    .sort((a, b) => a.z - b.z || a.x - b.x);
  const remap = new Map<number, number>();
  const outPalette: BlockCell[] = [];
  const outColumns: number[][] = [];
  for (const c of cols) {
    const row = [c.x, c.z];
    for (const [y, n, p] of c.runs) {
      let q = remap.get(p);
      if (q === undefined) {
        q = outPalette.length;
        remap.set(p, q);
        outPalette.push(canon[p]!);
      }
      row.push(y, n, q);
    }
    outColumns.push(row);
  }
  return { palette: outPalette, columns: outColumns };
}

// ---- content: block types --------------------------------------------------------

function validateVariant(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a variant is an object {model? | prefab? | color?, weight?}', v, 'object');
  onlyKeys(v, ['model', 'prefab', 'color', 'weight', 'uv'], path, errors, 'variant');
  validateUvMode(v['uv'], `${path}/uv`, errors);
  const sources = ['model', 'prefab', 'color'].filter((k) => v[k] !== undefined);
  if (sources.length > 1) err(errors, 'field_value', path, 'a variant is a model, a prefab or a colour (one of them)', sources);
  if (v['model'] !== undefined) {
    const m = v['model'];
    if (!isPlainObject(m)) err(errors, 'field_type', `${path}/model`, 'model is {assetId, piece?}', m, 'object');
    else {
      onlyKeys(m, ['assetId', 'piece'], `${path}/model`, errors, 'model');
      if (typeof m['assetId'] !== 'string' || !ID_RE.test(m['assetId'])) err(errors, 'id_invalid', `${path}/model/assetId`, 'assetId uses the id syntax', m['assetId']);
      if (m['piece'] !== undefined && (typeof m['piece'] !== 'string' || !PIECE_RE.test(m['piece']))) err(errors, 'field_value', `${path}/model/piece`, 'piece is a node name (1-128 characters)', m['piece']);
    }
  }
  if (v['prefab'] !== undefined && (typeof v['prefab'] !== 'string' || !ID_RE.test(v['prefab']))) err(errors, 'id_invalid', `${path}/prefab`, 'prefab is a prefabId', v['prefab']);
  if (v['color'] !== undefined && (typeof v['color'] !== 'string' || !COLOR_RE.test(v['color']))) err(errors, 'field_value', `${path}/color`, 'color is "#rrggbb" (lower case)', v['color']);
  if (v['weight'] !== undefined && (!finite(v['weight']) || v['weight'] <= 0 || v['weight'] > 1000)) err(errors, 'field_value', `${path}/weight`, 'weight is a number in (0, 1000]', v['weight']);
}

function validateUvMode(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v !== undefined && !BLOCK_UV_MODES.includes(v as BlockUvMode)) err(errors, 'field_value', path, 'uv is model or world', v, BLOCK_UV_MODES.join(' | '));
}

function validateUnitBox(b: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(b) || b.length !== 6 || !b.every((x) => finite(x) && x >= 0 && x <= 1)) return err(errors, 'field_value', path, 'a box is [x0, y0, z0, x1, y1, z1] within [0, 1]', b);
  if (!((b[3] as number) > (b[0] as number) && (b[4] as number) > (b[1] as number) && (b[5] as number) > (b[2] as number))) err(errors, 'field_value', path, 'a box has max > min on every axis', b);
}

export function validateBlockTypes(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'blockTypes is an array', value, 'array');
  const seen = new Set<string>();
  value.forEach((t, i) => {
    const p = `${path}/${i}`;
    validateBlockType(t, p, errors);
    if (isPlainObject(t) && typeof t['blockId'] === 'string') {
      if (seen.has(t['blockId'])) err(errors, 'id_duplicate', `${p}/blockId`, 'blockId is used twice', t['blockId']);
      seen.add(t['blockId']);
    }
  });
}

export function validateBlockType(t: unknown, p: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(t)) return err(errors, 'field_type', p, 'a block type is an object', t, 'object');
  onlyKeys(t, ['blockId', 'name', 'variants', 'shape', 'boxes', 'solid', 'footprint', 'rotations', 'metadata', 'materials', 'uv', 'live'], p, errors, 'block type');
  if (t['live'] !== undefined) {
    if (typeof t['live'] !== 'boolean') err(errors, 'field_type', `${p}/live`, 'live is a boolean', t['live'], 'boolean');
    else if (t['live'] && (!Array.isArray(t['variants']) || !t['variants'].some((v) => isPlainObject(v) && v['prefab'] !== undefined))) err(errors, 'field_value', `${p}/live`, 'a live block spawns its prefab looks: give it a prefab look', t['live']);
  }
  validateUvMode(t['uv'], `${p}/uv`, errors);
  if (typeof t['blockId'] !== 'string' || !ID_RE.test(t['blockId'])) err(errors, 'id_invalid', `${p}/blockId`, 'blockId uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', t['blockId']);
  if (typeof t['name'] !== 'string' || t['name'].length < 1 || t['name'].length > 128 || /[\u0000-\u001f]/.test(t['name'])) err(errors, 'field_value', `${p}/name`, 'name is 1-128 characters without control characters', t['name']);
  const variants = t['variants'];
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > BLOCK_LIMITS.variants) err(errors, 'field_value', `${p}/variants`, `variants is a list of 1-${BLOCK_LIMITS.variants} looks`, variants);
  else variants.forEach((v, j) => validateVariant(v, `${p}/variants/${j}`, errors));
  if (!BLOCK_SHAPES.includes(t['shape'] as BlockShape)) err(errors, 'field_value', `${p}/shape`, 'shape is full, half, ramp, stairs, custom or none', t['shape'], BLOCK_SHAPES.join(' | '));
  if (t['shape'] === 'custom') {
    const boxes = t['boxes'];
    if (!Array.isArray(boxes) || boxes.length < 1 || boxes.length > BLOCK_LIMITS.customBoxes) err(errors, 'field_value', `${p}/boxes`, `a custom shape is 1-${BLOCK_LIMITS.customBoxes} boxes`, boxes);
    else boxes.forEach((b, j) => validateUnitBox(b, `${p}/boxes/${j}`, errors));
  } else if (t['boxes'] !== undefined) err(errors, 'field_unexpected', `${p}/boxes`, 'boxes belong to a custom shape', 'boxes');
  if (t['solid'] !== undefined && typeof t['solid'] !== 'boolean') err(errors, 'field_type', `${p}/solid`, 'solid is a boolean', t['solid'], 'boolean');
  if (t['footprint'] !== undefined && !isIntVec3(t['footprint'], 1, BLOCK_LIMITS.footprint)) err(errors, 'field_value', `${p}/footprint`, `footprint is [x, y, z] cells, each 1-${BLOCK_LIMITS.footprint}`, t['footprint']);
  if (t['rotations'] !== undefined) {
    const r = t['rotations'];
    if (!Array.isArray(r) || r.length < 1 || r.length > 4 || !r.every((x) => ROTATIONS.includes(x as number)) || new Set(r).size !== r.length) err(errors, 'field_value', `${p}/rotations`, 'rotations is a non-empty set of 0, 90, 180, 270', r);
  }
  if (t['metadata'] !== undefined) validateMetaMap(t['metadata'], `${p}/metadata`, errors);
  if (t['materials'] !== undefined) {
    const m = t['materials'];
    if (!isPlainObject(m)) err(errors, 'field_type', `${p}/materials`, 'materials is a map (source material name or "*" → materialId)', m, 'object');
    else {
      if (Object.keys(m).length > 32) err(errors, 'limits_exceeded', `${p}/materials`, 'at most 32 material slots', Object.keys(m).length);
      for (const [k, id] of Object.entries(m)) {
        if (k.length < 1 || k.length > 128) err(errors, 'field_value', `${p}/materials`, 'a slot name is 1-128 characters', k);
        if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${p}/materials/${k}`, 'a materialId uses the id syntax', id);
      }
    }
  }
}

function canonicalMeta(m: Record<string, CellMetaValue>): Record<string, CellMetaValue> {
  const out: Record<string, CellMetaValue> = {};
  for (const k of sortedKeys(m)) {
    const x = m[k] as CellMetaValue;
    out[k] = typeof x === 'number' ? canonNum(x) : x;
  }
  return out;
}

export function canonicalBlockType(t: BlockType): BlockType {
  const out: BlockType = {
    blockId: t.blockId,
    name: t.name,
    variants: t.variants.map((v) => ({
      ...(v.model !== undefined ? { model: { assetId: v.model.assetId, ...(v.model.piece !== undefined ? { piece: v.model.piece } : {}) } } : {}),
      ...(v.prefab !== undefined ? { prefab: v.prefab } : {}),
      ...(v.color !== undefined ? { color: v.color } : {}),
      ...(v.weight !== undefined ? { weight: canonNum(v.weight) } : {}),
      ...(v.uv !== undefined ? { uv: v.uv } : {}),
    })),
    shape: t.shape,
  };
  if (t.shape === 'custom' && t.boxes !== undefined) out.boxes = t.boxes.map((b) => b.map(canonNum));
  if (t.solid !== undefined) out.solid = t.solid;
  if (t.footprint !== undefined && !(t.footprint[0] === 1 && t.footprint[1] === 1 && t.footprint[2] === 1)) out.footprint = [t.footprint[0], t.footprint[1], t.footprint[2]];
  if (t.rotations !== undefined) out.rotations = [...t.rotations].sort((a, b) => a - b);
  if (t.metadata !== undefined && Object.keys(t.metadata).length > 0) out.metadata = canonicalMeta(t.metadata);
  if (t.materials !== undefined && Object.keys(t.materials).length > 0) {
    const m: Record<string, string> = {};
    for (const k of sortedKeys(t.materials)) m[k] = t.materials[k]!;
    out.materials = m;
  }
  if (t.uv === 'world') out.uv = 'world';
  if (t.live === true) out.live = true;
  return out;
}

/** A variant's texture coordinates: its own, else its block type's (absent: `model`); out of range reads variant 0. */
export function blockVariantUv(t: Pick<BlockType, 'uv' | 'variants'>, variant: number): BlockUvMode {
  return (t.variants[variant] ?? t.variants[0])?.uv ?? t.uv ?? 'model';
}

export function canonicalBlockTypes(list: readonly BlockType[]): BlockType[] {
  return [...list].sort((a, b) => cmp(a.blockId, b.blockId)).map(canonicalBlockType);
}

/** Whether a block type hides the faces of neighbours touching it (absent `solid`: a full shape). */
export function blockTypeSolid(t: Pick<BlockType, 'shape' | 'solid' | 'footprint'>): boolean {
  if (t.footprint !== undefined && (t.footprint[0] !== 1 || t.footprint[1] !== 1 || t.footprint[2] !== 1)) return false;
  return t.solid ?? t.shape === 'full';
}

/** Whether a block type's cells may carry corner heights (a sloped top): a single-cell full shape. */
export function blockTypeSlopes(t: Pick<BlockType, 'shape' | 'footprint'>): boolean {
  return t.shape === 'full' && (t.footprint === undefined || (t.footprint[0] === 1 && t.footprint[1] === 1 && t.footprint[2] === 1));
}

/** The footprint in cells after a rotation (90/270 swap x and z). */
export function rotatedFootprint(t: Pick<BlockType, 'footprint'>, rot: number | undefined): [number, number, number] {
  const f = t.footprint ?? [1, 1, 1];
  return rot === 90 || rot === 270 ? [f[2], f[1], f[0]] : [f[0], f[1], f[2]];
}

// ---- content: cell fields ----------------------------------------------------------

export function validateCellFields(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'cellFields is an array', value, 'array');
  if (value.length > BLOCK_LIMITS.cellFields) err(errors, 'limits_exceeded', path, `at most ${BLOCK_LIMITS.cellFields} cell fields`, value.length);
  const seen = new Set<string>();
  value.forEach((f, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(f)) return err(errors, 'field_type', p, 'a cell field is an object', f, 'object');
    onlyKeys(f, ['key', 'type', 'default', 'values', 'min', 'max', 'color', 'label'], p, errors, 'cell field');
    if (typeof f['key'] !== 'string' || !CELL_FIELD_KEY_RE.test(f['key'])) err(errors, 'field_value', `${p}/key`, 'key is an identifier (1-32 characters)', f['key']);
    else if (seen.has(f['key'])) err(errors, 'id_duplicate', `${p}/key`, 'a cell field key is used twice', f['key']);
    else seen.add(f['key']);
    const type = f['type'];
    if (!CELL_FIELD_TYPES.includes(type as CellFieldType)) return err(errors, 'field_value', `${p}/type`, 'type is bool, enum, int, float or string', type, CELL_FIELD_TYPES.join(' | '));
    if (type === 'enum') {
      const vals = f['values'];
      if (!Array.isArray(vals) || vals.length < 1 || vals.length > BLOCK_LIMITS.enumValues || !vals.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= BLOCK_LIMITS.stringLength) || new Set(vals).size !== vals.length) {
        err(errors, 'field_value', `${p}/values`, `an enum field has 1-${BLOCK_LIMITS.enumValues} distinct values (1-${BLOCK_LIMITS.stringLength} characters)`, vals);
      }
    } else if (f['values'] !== undefined) err(errors, 'field_unexpected', `${p}/values`, 'values belong to an enum field', 'values');
    if (type === 'int' || type === 'float') {
      for (const k of ['min', 'max'] as const) {
        const x = f[k];
        if (x !== undefined && (!finite(x) || (type === 'int' && !isInt(x)))) err(errors, 'field_value', `${p}/${k}`, `${k} is a ${type === 'int' ? 'whole' : 'finite'} number`, x);
      }
      if (finite(f['min']) && finite(f['max']) && (f['min'] as number) > (f['max'] as number)) err(errors, 'field_value', `${p}/min`, 'min <= max', f['min']);
    } else if (f['min'] !== undefined || f['max'] !== undefined) err(errors, 'field_unexpected', `${p}/min`, 'min/max belong to an int or float field', 'min');
    if (f['color'] !== undefined && (typeof f['color'] !== 'string' || !COLOR_RE.test(f['color']))) err(errors, 'field_value', `${p}/color`, 'color is "#rrggbb" (lower case)', f['color']);
    if (f['label'] !== undefined && (typeof f['label'] !== 'string' || f['label'].length < 1 || f['label'].length > 64)) err(errors, 'field_value', `${p}/label`, 'label is 1-64 characters', f['label']);
    if (f['default'] !== undefined) {
      const problem = cellFieldValueError(f as unknown as CellField, f['default']);
      if (problem !== null) err(errors, 'field_value', `${p}/default`, `default: ${problem}`, f['default']);
    }
  });
}

/** Why `v` does not fit the field (null: it fits). */
export function cellFieldValueError(f: Pick<CellField, 'type' | 'values' | 'min' | 'max'>, v: unknown): string | null {
  switch (f.type) {
    case 'bool':
      return typeof v === 'boolean' ? null : 'a boolean';
    case 'enum':
      return typeof v === 'string' && (f.values ?? []).includes(v) ? null : `one of ${(f.values ?? []).join(', ')}`;
    case 'string':
      return typeof v === 'string' && v.length <= BLOCK_LIMITS.stringLength ? null : `a string of at most ${BLOCK_LIMITS.stringLength} characters`;
    case 'int':
    case 'float': {
      if (!finite(v) || (f.type === 'int' && !isInt(v))) return f.type === 'int' ? 'a whole number' : 'a finite number';
      if (f.min !== undefined && v < f.min) return `>= ${f.min}`;
      if (f.max !== undefined && v > f.max) return `<= ${f.max}`;
      return null;
    }
  }
}

/** A field's default value (absent: false / the first enum value / 0 / ""). */
export function cellFieldDefault(f: CellField): CellMetaValue {
  if (f.default !== undefined) return f.default;
  switch (f.type) {
    case 'bool':
      return false;
    case 'enum':
      return f.values?.[0] ?? '';
    case 'string':
      return '';
    default:
      return f.min !== undefined && f.min > 0 ? f.min : f.max !== undefined && f.max < 0 ? f.max : 0;
  }
}

export function canonicalCellFields(list: readonly CellField[]): CellField[] {
  return list.map((f) => ({
    key: f.key,
    type: f.type,
    ...(f.default !== undefined ? { default: typeof f.default === 'number' ? canonNum(f.default) : f.default } : {}),
    ...(f.type === 'enum' && f.values !== undefined ? { values: [...f.values] } : {}),
    ...(f.min !== undefined ? { min: canonNum(f.min) } : {}),
    ...(f.max !== undefined ? { max: canonNum(f.max) } : {}),
    ...(f.color !== undefined ? { color: f.color } : {}),
    ...(f.label !== undefined ? { label: f.label } : {}),
  }));
}

// ---- content: stamps -----------------------------------------------------------------

export function validateBlockStamp(s: unknown, p: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(s)) return err(errors, 'field_type', p, 'a stamp is an object', s, 'object');
  onlyKeys(s, ['stampId', 'name', 'size', 'palette', 'columns'], p, errors, 'stamp');
  if (typeof s['stampId'] !== 'string' || !ID_RE.test(s['stampId'])) err(errors, 'id_invalid', `${p}/stampId`, 'stampId uses the id syntax', s['stampId']);
  if (typeof s['name'] !== 'string' || s['name'].length < 1 || s['name'].length > 128 || /[\u0000-\u001f]/.test(s['name'])) err(errors, 'field_value', `${p}/name`, 'name is 1-128 characters', s['name']);
  const size = s['size'];
  if (!isIntVec3(size, 1, BLOCK_LIMITS.stampSize)) return err(errors, 'field_value', `${p}/size`, `size is [x, y, z] cells, each 1-${BLOCK_LIMITS.stampSize}`, size);
  const palette = s['palette'];
  if (!Array.isArray(palette) || palette.length > BLOCK_LIMITS.chunkPalette) return err(errors, 'field_value', `${p}/palette`, `palette is a list of at most ${BLOCK_LIMITS.chunkPalette} cells`, palette);
  const before = errors.length;
  palette.forEach((c, i) => validateBlockCell(c, `${p}/palette/${i}`, errors));
  if (errors.length > before) return;
  const n = validateColumns(s['columns'], `${p}/columns`, errors, size[0], size[2], 0, size[1], palette.length);
  if (n > BLOCK_LIMITS.stampCells) err(errors, 'limits_exceeded', `${p}/columns`, `a stamp holds at most ${BLOCK_LIMITS.stampCells} cells`, n);
}

export function validateBlockStamps(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'blockStamps is an array', value, 'array');
  const seen = new Set<string>();
  value.forEach((s, i) => {
    validateBlockStamp(s, `${path}/${i}`, errors);
    if (isPlainObject(s) && typeof s['stampId'] === 'string') {
      if (seen.has(s['stampId'])) err(errors, 'id_duplicate', `${path}/${i}/stampId`, 'stampId is used twice', s['stampId']);
      seen.add(s['stampId']);
    }
  });
}

export function canonicalBlockStamp(s: BlockStamp): BlockStamp {
  const runs = canonicalRuns(s.palette, s.columns);
  return { stampId: s.stampId, name: s.name, size: [s.size[0], s.size[1], s.size[2]], palette: runs.palette, columns: runs.columns };
}

export function canonicalBlockStamps(list: readonly BlockStamp[]): BlockStamp[] {
  return [...list].sort((a, b) => cmp(a.stampId, b.stampId)).map(canonicalBlockStamp);
}

// ---- the blockLayer component ----------------------------------------------------------

/**
 * Engine default for a new layer: 1 m cubes (a common kit module; the E8
 * target's cell height is data — a half-metre step is `cellSize [1, 0.5, 1]`)
 * over 64 × 16 × 64 cells (the interactive-editing target of E8).
 */
export const BLOCK_LAYER_DEFAULT: BlockLayerComponent = Object.freeze({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [64, 16, 64] } }) as BlockLayerComponent;

/** The stored fields of the `blockLayer` component, in canonical order. */
export const BLOCK_LAYER_FIELDS = ['cellSize', 'bounds', 'metadataOnly', 'collision', 'castShadow', 'receiveShadow', 'maxSlope', 'smoothAngle', 'topSubdivision', 'lightLayers'] as const;

export function validateBlockLayerComponent(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'blockLayer is an object', v, 'object');
  onlyKeys(v, BLOCK_LAYER_FIELDS, path, errors, 'blockLayer');
  const cs = v['cellSize'];
  if (!Array.isArray(cs) || cs.length !== 3 || !cs.every((x) => finite(x) && x >= BLOCK_LIMITS.cellSizeMin && x <= BLOCK_LIMITS.cellSizeMax)) {
    err(errors, 'field_value', `${path}/cellSize`, `cellSize is [x, y, z] metres, each ${BLOCK_LIMITS.cellSizeMin}-${BLOCK_LIMITS.cellSizeMax}`, cs);
  } else if (cs[0] !== cs[2]) {
    // A quarter-turned look can't fill a cell that is not square from above without distorting it.
    err(errors, 'field_value', `${path}/cellSize`, `cellSize x (${cs[0]}) and z (${cs[2]}) must be equal: cells are square from above (only the height y may differ)`, cs);
  }
  const b = v['bounds'];
  if (!isPlainObject(b)) err(errors, 'field_type', `${path}/bounds`, 'bounds is {min: [x, y, z], max: [x, y, z]} cells', b, 'object');
  else {
    onlyKeys(b, ['min', 'max'], `${path}/bounds`, errors, 'bounds');
    const min = b['min'];
    const max = b['max'];
    const okMin = Array.isArray(min) && min.length === 3 && isInt(min[0]) && isInt(min[1]) && isInt(min[2]) && Math.abs(min[0]) <= BLOCK_LIMITS.coordinateXZ && Math.abs(min[2]) <= BLOCK_LIMITS.coordinateXZ && Math.abs(min[1]) <= BLOCK_LIMITS.coordinateY;
    const okMax = Array.isArray(max) && max.length === 3 && isInt(max[0]) && isInt(max[1]) && isInt(max[2]) && Math.abs(max[0]) <= BLOCK_LIMITS.coordinateXZ && Math.abs(max[2]) <= BLOCK_LIMITS.coordinateXZ && Math.abs(max[1]) <= BLOCK_LIMITS.coordinateY;
    if (!okMin) err(errors, 'field_value', `${path}/bounds/min`, `bounds.min is integer cells within ±${BLOCK_LIMITS.coordinateXZ} (y ±${BLOCK_LIMITS.coordinateY})`, min);
    if (!okMax) err(errors, 'field_value', `${path}/bounds/max`, `bounds.max is integer cells within ±${BLOCK_LIMITS.coordinateXZ} (y ±${BLOCK_LIMITS.coordinateY})`, max);
    if (okMin && okMax) {
      const w = (max as number[])[0]! - (min as number[])[0]!;
      const h = (max as number[])[1]! - (min as number[])[1]!;
      const d = (max as number[])[2]! - (min as number[])[2]!;
      if (w < 1 || h < 1 || d < 1) err(errors, 'field_value', `${path}/bounds`, 'bounds.max > bounds.min on every axis', b);
      if (w > BLOCK_LIMITS.layerWidth || d > BLOCK_LIMITS.layerWidth || h > BLOCK_LIMITS.layerHeight) err(errors, 'limits_exceeded', `${path}/bounds`, `a layer spans at most ${BLOCK_LIMITS.layerWidth} × ${BLOCK_LIMITS.layerHeight} × ${BLOCK_LIMITS.layerWidth} cells`, [w, h, d]);
    }
  }
  for (const k of ['metadataOnly', 'collision', 'castShadow', 'receiveShadow']) if (v[k] !== undefined && typeof v[k] !== 'boolean') err(errors, 'field_type', `${path}/${k}`, `${k} is a boolean`, v[k], 'boolean');
  const ms = v['maxSlope'];
  if (ms !== undefined && (!finite(ms) || ms < BLOCK_MAX_SLOPE_RANGE.min || ms > BLOCK_MAX_SLOPE_RANGE.max)) err(errors, 'field_value', `${path}/maxSlope`, `maxSlope is degrees in ${BLOCK_MAX_SLOPE_RANGE.min}-${BLOCK_MAX_SLOPE_RANGE.max}`, ms);
  const sa = v['smoothAngle'];
  if (sa !== undefined && (!finite(sa) || sa < BLOCK_SMOOTH_ANGLE_RANGE.min || sa > BLOCK_SMOOTH_ANGLE_RANGE.max)) err(errors, 'field_value', `${path}/smoothAngle`, `smoothAngle is degrees in ${BLOCK_SMOOTH_ANGLE_RANGE.min}-${BLOCK_SMOOTH_ANGLE_RANGE.max} (0: flat-shaded tops)`, sa);
  const ts = v['topSubdivision'];
  if (ts !== undefined && !BLOCK_TOP_SUBDIVISIONS.includes(ts as number)) err(errors, 'field_value', `${path}/topSubdivision`, `topSubdivision is one of ${BLOCK_TOP_SUBDIVISIONS.join(', ')}`, ts);
  validateLightLayerMask(v['lightLayers'], `${path}/lightLayers`, errors, 1);
}

export function canonicalBlockLayerComponent(c: BlockLayerComponent): BlockLayerComponent {
  return {
    cellSize: [canonNum(c.cellSize[0]), canonNum(c.cellSize[1]), canonNum(c.cellSize[2])],
    bounds: { min: [c.bounds.min[0], c.bounds.min[1], c.bounds.min[2]], max: [c.bounds.max[0], c.bounds.max[1], c.bounds.max[2]] },
    ...(c.metadataOnly === true ? { metadataOnly: true as const } : {}),
    ...(c.collision === false ? { collision: false as const } : {}),
    ...(c.castShadow === false ? { castShadow: false as const } : {}),
    ...(c.receiveShadow === false ? { receiveShadow: false as const } : {}),
    ...(c.maxSlope !== undefined ? { maxSlope: canonNum(c.maxSlope) } : {}),
    ...(c.smoothAngle !== undefined && c.smoothAngle > 0 ? { smoothAngle: canonNum(c.smoothAngle) } : {}),
    ...(c.topSubdivision !== undefined && c.topSubdivision > 1 ? { topSubdivision: c.topSubdivision } : {}),
    ...(c.lightLayers !== undefined ? { lightLayers: c.lightLayers } : {}),
  };
}

// ---- scene blocks ----------------------------------------------------------------------

function validateRegionBox(b: unknown, path: string, errors: ModelErrorV2[]): void {
  const X = BLOCK_LIMITS.coordinateXZ;
  const Y = BLOCK_LIMITS.coordinateY;
  if (!Array.isArray(b) || b.length !== 6 || !b.every(isInt)) return err(errors, 'field_value', path, 'a region box is [x0, y0, z0, x1, y1, z1] integers (max exclusive)', b);
  const [x0, y0, z0, x1, y1, z1] = b as number[];
  if (Math.abs(x0!) > X || Math.abs(x1!) > X || Math.abs(z0!) > X || Math.abs(z1!) > X || Math.abs(y0!) > Y || Math.abs(y1!) > Y) return err(errors, 'field_value', path, `a region box lies within ±${X} (y ±${Y})`, b);
  if (!(x1! > x0! && y1! > y0! && z1! > z0!)) err(errors, 'field_value', path, 'a region box has max > min on every axis', b);
}

export function validateBlockRegion(r: unknown, p: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(r)) return err(errors, 'field_type', p, 'a region is {regionId, boxes}', r, 'object');
  onlyKeys(r, ['regionId', 'boxes'], p, errors, 'region');
  if (typeof r['regionId'] !== 'string' || !REGION_ID_RE.test(r['regionId'])) err(errors, 'id_invalid', `${p}/regionId`, 'a region id is 1-64 letters, digits, "_", "." or "-" (e.g. "battle1.deploy.player")', r['regionId']);
  const boxes = r['boxes'];
  if (!Array.isArray(boxes) || boxes.length < 1 || boxes.length > BLOCK_LIMITS.regionBoxes) return err(errors, 'field_value', `${p}/boxes`, `a region has 1-${BLOCK_LIMITS.regionBoxes} boxes`, Array.isArray(boxes) ? boxes.length : boxes);
  boxes.forEach((b, i) => validateRegionBox(b, `${p}/boxes/${i}`, errors));
}

/**
 * The scene document's own block rules: structure, every layer entry names a
 * scene entity carrying `blockLayer` (at most one entry per layer, 16 layers
 * per scene), every cell lies within its layer's bounds, a metadata-only layer
 * holds no blocks. Block types and metadata fields are the
 * content's (`composeBlockLayers`).
 */
export function validateSceneBlocks(value: unknown, entities: readonly unknown[], errors: ModelErrorV2[], merged = false): void {
  const path = '/blocks';
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'blocks is an array of layer entries', value, 'array');
  const layers = new Map<string, BlockLayerComponent>();
  for (const e of entities) {
    if (!isPlainObject(e) || !isPlainObject(e['components'])) continue;
    const bl = (e['components'] as Record<string, unknown>)['blockLayer'];
    if (bl !== undefined && typeof e['id'] === 'string') layers.set(e['id'], bl as BlockLayerComponent);
  }
  if (!merged && value.length > BLOCK_LIMITS.layersPerScene) err(errors, 'limits_exceeded', path, `a scene holds at most ${BLOCK_LIMITS.layersPerScene} block layers with cells`, value.length);
  const seen = new Set<string>();
  value.forEach((entry, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(entry)) return err(errors, 'field_type', p, 'a layer entry is {entityId, chunks?, regions?}', entry, 'object');
    onlyKeys(entry, ['entityId', 'chunks', 'regions'], p, errors, 'layer entry');
    const id = entry['entityId'];
    if (typeof id !== 'string' || !ID_RE.test(id)) return err(errors, 'id_invalid', `${p}/entityId`, 'entityId uses the id syntax', id);
    if (seen.has(id)) err(errors, 'id_duplicate', `${p}/entityId`, 'a layer has two entries', id);
    seen.add(id);
    const comp = layers.get(id);
    if (comp === undefined) return err(errors, 'reference_missing', `${p}/entityId`, 'a layer entry names an entity of this scene that carries blockLayer', id, 'an entity with blockLayer');
    const b = isPlainObject(comp) && isPlainObject(comp.bounds) ? comp.bounds : null;
    const min = b !== null && Array.isArray(b.min) ? b.min : [0, 0, 0];
    const max = b !== null && Array.isArray(b.max) ? b.max : [0, 0, 0];
    const chunks = entry['chunks'];
    if (chunks !== undefined) {
      if (!Array.isArray(chunks)) err(errors, 'field_type', `${p}/chunks`, 'chunks is an array', chunks, 'array');
      else {
        const keys = new Set<string>();
        chunks.forEach((c, j) => {
          const cp = `${p}/chunks/${j}`;
          if (!isPlainObject(c)) return err(errors, 'field_type', cp, 'a chunk is {cx, cz, palette, columns, paint?}', c, 'object');
          onlyKeys(c, ['cx', 'cz', 'palette', 'columns', 'paint'], cp, errors, 'chunk');
          // The chunk's paint lattice.
          if (c['paint'] !== undefined) {
            const pe = chunkPaintError(c['paint']);
            if (pe !== null) err(errors, 'field_value', `${cp}/paint`, pe, typeof c['paint'] === 'string' ? `${c['paint'].length} characters` : c['paint']);
          }
          const cx = c['cx'];
          const cz = c['cz'];
          const lim = BLOCK_LIMITS.coordinateXZ / CHUNK_SIZE;
          if (!isInt(cx) || !isInt(cz) || Math.abs(cx) > lim || Math.abs(cz) > lim) return err(errors, 'field_value', cp, `chunk coordinates are integers within ±${lim}`, [cx, cz]);
          const key = `${cx},${cz}`;
          if (keys.has(key)) err(errors, 'id_duplicate', cp, 'a chunk appears twice', key);
          keys.add(key);
          const palette = c['palette'];
          if (!Array.isArray(palette) || palette.length > BLOCK_LIMITS.chunkPalette) return err(errors, 'field_value', `${cp}/palette`, `palette is a list of at most ${BLOCK_LIMITS.chunkPalette} cells`, Array.isArray(palette) ? palette.length : palette);
          const before = errors.length;
          palette.forEach((cell, k) => validateBlockCell(cell, `${cp}/palette/${k}`, errors));
          if (errors.length > before) return;
          if (comp.metadataOnly === true && palette.some((cell) => isPlainObject(cell) && cell['block'] !== undefined)) {
            err(errors, 'field_value', `${cp}/palette`, 'a metadata-only layer holds no blocks', id);
          }
          const n = validateColumns(c['columns'], `${cp}/columns`, errors, CHUNK_SIZE, CHUNK_SIZE, BLOCK_LIMITS.coordinateY * -1, BLOCK_LIMITS.coordinateY, palette.length);
          if (n < 0) return;
          // Every cell within the layer's bounds.
          for (const col of c['columns'] as number[][]) {
            const x = (cx as number) * CHUNK_SIZE + col[0]!;
            const z = (cz as number) * CHUNK_SIZE + col[1]!;
            let bad = x < min[0]! || x >= max[0]! || z < min[2]! || z >= max[2]!;
            for (let r = 2; !bad && r < col.length; r += 3) if (col[r]! < min[1]! || col[r]! + col[r + 1]! > max[1]!) bad = true;
            if (bad) {
              err(errors, 'field_value', `${cp}/columns`, "a cell lies outside its layer's bounds", [x, z]);
              break;
            }
          }
        });
      }
    }
    const regions = entry['regions'];
    if (regions !== undefined) {
      if (!Array.isArray(regions) || regions.length > BLOCK_LIMITS.regions) err(errors, 'field_value', `${p}/regions`, `regions is a list of at most ${BLOCK_LIMITS.regions}`, Array.isArray(regions) ? regions.length : regions);
      else {
        const ids = new Set<string>();
        regions.forEach((r, j) => {
          validateBlockRegion(r, `${p}/regions/${j}`, errors);
          if (isPlainObject(r) && typeof r['regionId'] === 'string') {
            if (ids.has(r['regionId'])) err(errors, 'id_duplicate', `${p}/regions/${j}/regionId`, 'a region id is used twice in a layer', r['regionId']);
            ids.add(r['regionId']);
          }
        });
      }
    }
  });
}

/** The canonical `blocks` list: entries by entityId, chunks by (cz, cx), regions by id; empty entries dropped (null: none left). */
export function canonicalSceneBlocks(list: readonly BlockLayerData[]): BlockLayerData[] | null {
  const out: BlockLayerData[] = [];
  for (const entry of [...list].sort((a, b) => cmp(a.entityId, b.entityId))) {
    const chunks = (entry.chunks ?? [])
      .map((c) => canonicalBlockChunk(c))
      .filter((c): c is BlockChunk => c !== null)
      .sort((a, b) => a.cz - b.cz || a.cx - b.cx);
    const regions = (entry.regions ?? []).map((r) => ({ regionId: r.regionId, boxes: r.boxes.map((b) => [...b]) })).sort((a, b) => cmp(a.regionId, b.regionId));
    if (chunks.length === 0 && regions.length === 0) continue;
    out.push({ entityId: entry.entityId, ...(chunks.length > 0 ? { chunks } : {}), ...(regions.length > 0 ? { regions } : {}) });
  }
  return out.length > 0 ? out : null;
}

const canonicalChunks = new WeakSet<BlockChunk>();

/** A chunk in canonical form (null when it holds no cells). Chunks already canonical are returned as they are. */
export function canonicalBlockChunk(c: BlockChunk): BlockChunk | null {
  if (canonicalChunks.has(c)) return c;
  const runs = canonicalRuns(c.palette, c.columns);
  if (runs.columns.length === 0) return null;
  // An all-unpainted lattice is not stored.
  const paint = c.paint !== undefined ? decodeChunkPaint(c.paint) : null;
  const out: BlockChunk = { cx: c.cx, cz: c.cz, palette: runs.palette, columns: runs.columns, ...(paint !== null && !isUnpainted(paint) ? { paint: encodeChunkPaint(paint) } : {}) };
  canonicalChunks.add(out);
  return out;
}

/** Mark a chunk the grid helpers built as canonical (they build canonical chunks). */
export function markCanonicalChunk(c: BlockChunk): BlockChunk {
  canonicalChunks.add(c);
  return c;
}

// ---- composition with the content ---------------------------------------------------------

export interface BlockContentView {
  blockTypes?: readonly BlockType[];
  cellFields?: readonly CellField[];
  blockStamps?: readonly BlockStamp[];
  assets?: readonly { assetId: string; kind?: string }[];
  prefabs?: readonly { prefabId: string; entities: readonly { localId: string; parentLocalId?: string; components: Record<string, unknown> }[] }[];
  materials?: readonly { materialId: string }[];
}

/** The content's references of block types (assets, prefabs, materials) and metadata defaults (fields). */
export function composeBlockContent(content: BlockContentView, errors: ModelErrorV2[]): void {
  const assets = new Map((content.assets ?? []).map((a) => [a.assetId, a.kind ?? 'model']));
  const prefabs = new Map((content.prefabs ?? []).map((p) => [p.prefabId, p]));
  const materials = new Set((content.materials ?? []).map((m) => m.materialId));
  const fields = new Map((content.cellFields ?? []).map((f) => [f.key, f]));
  (content.blockTypes ?? []).forEach((t, i) => {
    const p = `/blockTypes/${i}`;
    t.variants.forEach((v, j) => {
      if (v.model !== undefined && assets.get(v.model.assetId) !== 'model') err(errors, 'asset_reference_missing', `${p}/variants/${j}/model/assetId`, 'a block variant names a model asset of this project', v.model.assetId);
      if (v.prefab !== undefined) {
        const pf = prefabs.get(v.prefab);
        const root = pf?.entities.find((e) => e.parentLocalId === undefined);
        if (pf === undefined) err(errors, 'prefab_reference_missing', `${p}/variants/${j}/prefab`, 'a block variant names a prefab of this project', v.prefab);
        else if (t.live === true) {
          // A live block's root without a model is a logic-only cell (a trigger, a sound): the chunk draws nothing for it.
          const problem = liveBlockPrefabProblem(pf);
          if (problem !== null) err(errors, 'field_value', `${p}/variants/${j}/prefab`, `prefab "${v.prefab}" cannot be a live block: ${problem}`, v.prefab);
        } else if (root === undefined || root.components['model'] === undefined) err(errors, 'field_value', `${p}/variants/${j}/prefab`, "a block variant's prefab has a model on its root (the block shows that model)", v.prefab);
      }
    });
    for (const [slot, id] of Object.entries(t.materials ?? {})) if (!materials.has(id)) err(errors, 'reference_missing', `${p}/materials/${slot}`, 'the material mapping names no material of this project', id);
    for (const [k, x] of Object.entries(t.metadata ?? {})) {
      const f = fields.get(k);
      if (f === undefined) err(errors, 'reference_missing', `${p}/metadata/${k}`, 'default metadata names a field of content.cellFields', k);
      else {
        const problem = cellFieldValueError(f, x);
        if (problem !== null) err(errors, 'field_value', `${p}/metadata/${k}`, `the value must be ${problem}`, x);
      }
    }
  });
  (content.blockStamps ?? []).forEach((s, i) => composeCells(s.palette, `/blockStamps/${i}/palette`, content, errors, false));
}

function composeCells(palette: readonly BlockCell[], path: string, content: BlockContentView, errors: ModelErrorV2[], metadataOnly: boolean): void {
  const types = new Map((content.blockTypes ?? []).map((t) => [t.blockId, t]));
  const fields = new Map((content.cellFields ?? []).map((f) => [f.key, f]));
  palette.forEach((c, k) => {
    const p = `${path}/${k}`;
    if (c.block !== undefined) {
      const t = types.get(c.block);
      if (metadataOnly) err(errors, 'field_value', `${p}/block`, 'a metadata-only layer holds no blocks', c.block);
      if (t === undefined) err(errors, 'reference_missing', `${p}/block`, 'a cell names a block type of content.blockTypes', c.block);
      else {
        if (!(t.rotations ?? ROTATIONS).includes(c.rot ?? 0)) err(errors, 'field_value', `${p}/rot`, `block "${t.blockId}" allows the rotations ${(t.rotations ?? ROTATIONS).join(', ')}`, c.rot ?? 0);
        if (c.variant !== undefined && c.variant >= t.variants.length) err(errors, 'field_value', `${p}/variant`, `block "${t.blockId}" has ${t.variants.length} variant(s)`, c.variant);
        if (c.corners !== undefined && !blockTypeSlopes(t)) err(errors, 'field_value', `${p}/corners`, `corners slope the top of a single-cell full block; block "${t.blockId}" is ${t.shape}${t.footprint !== undefined ? ` with a footprint of ${t.footprint.join(' × ')}` : ''}`, c.corners);
      }
    }
    for (const [key, x] of Object.entries(c.meta ?? {})) {
      const f = fields.get(key);
      if (f === undefined) err(errors, 'reference_missing', `${p}/meta/${key}`, 'cell metadata names a field of content.cellFields', key);
      else {
        const problem = cellFieldValueError(f, x);
        if (problem !== null) err(errors, 'field_value', `${p}/meta/${key}`, `the value must be ${problem}`, x);
      }
    }
  });
}

const composed = new WeakMap<BlockChunk, { types: unknown; fields: unknown; metadataOnly: boolean }>();

/**
 * A scene's cells against the content: block types and rotations/variants
 * they allow, metadata fields and value types, and multi-cell footprints
 * (inside the bounds, not covering another cell). Chunks already checked
 * against the same block types and fields are skipped.
 */
export function composeBlockLayers(blocks: readonly BlockLayerData[] | undefined, entities: readonly { id: string; components: Record<string, unknown> }[], content: BlockContentView, errors: ModelErrorV2[]): void {
  if (blocks === undefined || blocks.length === 0) return;
  const comps = new Map<string, BlockLayerComponent>();
  for (const e of entities) if (e.components['blockLayer'] !== undefined) comps.set(e.id, e.components['blockLayer'] as BlockLayerComponent);
  const types = new Map((content.blockTypes ?? []).map((t) => [t.blockId, t]));
  blocks.forEach((entry, i) => {
    const comp = comps.get(entry.entityId);
    if (comp === undefined) return;
    const metadataOnly = comp.metadataOnly === true;
    let hasFootprints = false;
    (entry.chunks ?? []).forEach((c, j) => {
      if (c.palette.some((cell) => cell.block !== undefined && (types.get(cell.block)?.footprint ?? null) !== null)) hasFootprints = true;
      const seen = composed.get(c);
      if (seen !== undefined && seen.types === content.blockTypes && seen.fields === content.cellFields && seen.metadataOnly === metadataOnly) return;
      const before = errors.length;
      composeCells(c.palette, `/blocks/${i}/chunks/${j}/palette`, content, errors, metadataOnly);
      if (errors.length === before) composed.set(c, { types: content.blockTypes, fields: content.cellFields, metadataOnly });
    });
    if (hasFootprints) footprintErrors(entry, comp, types, `/blocks/${i}`, errors);
  });
}

function footprintErrors(entry: BlockLayerData, comp: BlockLayerComponent, types: ReadonlyMap<string, BlockType>, path: string, errors: ModelErrorV2[]): void {
  const occupied = new Set<string>();
  const anchors: { x: number; y: number; z: number; f: [number, number, number]; id: string }[] = [];
  for (const c of entry.chunks ?? []) {
    for (const col of c.columns) {
      const x = c.cx * CHUNK_SIZE + col[0]!;
      const z = c.cz * CHUNK_SIZE + col[1]!;
      for (let r = 2; r < col.length; r += 3) {
        const cell = c.palette[col[r + 2]!]!;
        for (let y = col[r]!; y < col[r]! + col[r + 1]!; y++) {
          occupied.add(`${x},${y},${z}`);
          const t = cell.block !== undefined ? types.get(cell.block) : undefined;
          if (t?.footprint !== undefined) anchors.push({ x, y, z, f: rotatedFootprint(t, cell.rot), id: t.blockId });
        }
      }
    }
  }
  for (const a of anchors) {
    if (a.x + a.f[0] > comp.bounds.max[0] || a.y + a.f[1] > comp.bounds.max[1] || a.z + a.f[2] > comp.bounds.max[2]) {
      err(errors, 'field_value', path, `block "${a.id}" at [${a.x}, ${a.y}, ${a.z}] reaches outside the layer's bounds (footprint ${a.f.join(' × ')})`, [a.x, a.y, a.z]);
      return;
    }
    for (let dx = 0; dx < a.f[0]; dx++)
      for (let dy = 0; dy < a.f[1]; dy++)
        for (let dz = 0; dz < a.f[2]; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const k = `${a.x + dx},${a.y + dy},${a.z + dz}`;
          if (occupied.has(k)) {
            err(errors, 'field_value', path, `block "${a.id}" at [${a.x}, ${a.y}, ${a.z}] covers the cell [${k}], which holds another cell (a footprint's cells stay empty)`, [a.x, a.y, a.z]);
            return;
          }
          occupied.add(k);
        }
  }
}

// ---- The block footprint component ------------------------------------------

/**
 * A prop's occupancy footprint — the
 * metadata it writes into the block-layer cells beneath it (a house marks its
 * cells blocked, a market stall a shop). Which fields and values it writes is
 * data (`set`, fields of the project's cell schema); the engine knows no
 * field names. The editor writes the cells when the prop is placed or moved
 * (an `editBlocks` meta edit); the component itself changes nothing at run
 * time.
 */
export interface BlockFootprintComponent {
  /** The block layer written (its entity id; absent: every layer under the prop). */
  layer?: string;
  /** Cells along x and z, centred on the prop and turned with its quarter turns about +Y (absent: [1, 1]). */
  size?: [number, number];
  /** The metadata the cells beneath take (field key → value). */
  set: Record<string, CellMetaValue>;
}

/** Largest footprint side in cells (a building lot, not a district). */
export const BLOCK_FOOTPRINT_MAX = 64;

export function validateBlockFootprintComponent(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'blockFootprint is an object {layer?, size?, set}', v, 'object');
  onlyKeys(v, ['layer', 'size', 'set'], path, errors, 'blockFootprint');
  if (v['layer'] !== undefined && (typeof v['layer'] !== 'string' || !ID_RE.test(v['layer']))) err(errors, 'id_invalid', `${path}/layer`, 'layer is the id of a block layer object', v['layer']);
  const s = v['size'];
  if (s !== undefined && !(Array.isArray(s) && s.length === 2 && s.every((x) => isInt(x) && x >= 1 && x <= BLOCK_FOOTPRINT_MAX))) err(errors, 'field_value', `${path}/size`, `size is [x, z] cells, each 1-${BLOCK_FOOTPRINT_MAX}`, s);
  const set = v['set'];
  if (set === undefined) return err(errors, 'field_missing', `${path}/set`, 'blockFootprint needs set (the metadata its cells take: field key → value)');
  // An empty map is allowed (a new footprint before its fields are chosen writes nothing).
  validateMetaMap(set, `${path}/set`, errors);
}

export function canonicalBlockFootprint(c: BlockFootprintComponent): BlockFootprintComponent {
  const set: Record<string, CellMetaValue> = {};
  for (const k of sortedKeys(c.set)) {
    const x = c.set[k] as CellMetaValue;
    set[k] = typeof x === 'number' ? canonNum(x) : x;
  }
  return {
    ...(c.layer !== undefined ? { layer: c.layer } : {}),
    ...(c.size !== undefined && !(c.size[0] === 1 && c.size[1] === 1) ? { size: [c.size[0], c.size[1]] as [number, number] } : {}),
    set,
  };
}
