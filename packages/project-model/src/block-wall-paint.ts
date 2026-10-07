/**
 * Wall paint of a block layer — paint of its own on the walls (the exposed
 * side faces), for a layer that turns it on (`blockLayer.wallPaint`).
 *
 * Points lie on the walls' planes (the column borders), about
 * {@link WALL_PAINT_STEP_METRES} apart: a cell side holds `along + 1`
 * points across (its two ends included, so a side is painted from its own
 * points; the ends are shared with the next side of the same plane and a
 * dab writes them alike) and a point every `1 / up` row in height. A point is
 * named by its column, the side of the column it is on (0 +X, 1 −X, 2 +Z,
 * 3 −Z), its index across (0 … along) and its height index (rows × up from
 * the layer's row 0). It holds the block paint's five bytes (four layer
 * weights summing to 255 and a wetness, `block-paint.ts`).
 *
 * Stored sparsely, with the chunk of its column: `BlockChunk.wallPaint` is
 * base64 of 9-byte records sorted by point — column (x | z << 4, chunk-local),
 * side << 5 | index across, height index + 32768 (u16 LE), then the five
 * bytes. A point not stored is unpainted: all second layer and dry (a wall's
 * own default, as the tops' is the first layer). Points stay where they are
 * when heights change, as the tops' paint does, so paint survives a height
 * edit; a chunk whose cells are all removed drops them.
 *
 * Pure and deterministic (the brush is `paint-brush.ts`; meshing reads the
 * points through `block-paint-mesh.ts`).
 */
import { brushFalloff, paintPoint, type PaintBrush, type PaintLayout } from './paint-brush';
import { BLOCK_PAINT_LAYOUT, PAINT_CHANNELS, PAINT_CHUNK_SIZE } from './block-paint';
import { decodeBase64, encodeBase64 } from './png-decode';

const CHUNK_SIZE = PAINT_CHUNK_SIZE;
/** Roughly how far apart wall points are (each axis takes the whole number of steps per cell nearest to it). */
export const WALL_PAINT_STEP_METRES = 0.5;
/** Most points per cell side across or per row in height (a large cell's points are further apart). */
export const WALL_PAINT_MAX_STEPS = 16;
/** Bytes per stored point: column, side and index across, height index (2), the five paint bytes. */
export const WALL_POINT_BYTES = 9;
/** An unpainted wall point: all second layer, dry. */
export const UNPAINTED_WALL: readonly number[] = Object.freeze([0, 255, 0, 0, 0]);
/** The block paint's bytes, unpainted on the second layer (erasing the only weight gives it back there). */
export const WALL_PAINT_LAYOUT: PaintLayout = Object.freeze({ ...BLOCK_PAINT_LAYOUT, rest: 1 });
/** Offset that keeps a stored height index (rows × up, the layer's rows reach below 0) a u16. */
const HEIGHT_OFFSET = 32768;
/** Offset of the height index in a point key: the layer's ±1,024 rows × 16 fit, and keys stay small integers (fast map keys). */
const KEY_HEIGHT_OFFSET = 16384;

/** Points per cell: `along` steps across a side (along + 1 points), `up` per row. */
export interface WallSteps {
  readonly along: number;
  readonly up: number;
}

/** A layer's wall point spacing for its cell size. */
export function wallPaintSteps(cellSize: readonly number[]): WallSteps {
  const steps = (m: number): number => Math.max(1, Math.min(WALL_PAINT_MAX_STEPS, Math.round(m / WALL_PAINT_STEP_METRES)));
  return { along: steps(cellSize[0]!), up: steps(cellSize[1]!) };
}

/** A chunk's wall points: point key → its five bytes. */
export type WallPaint = Map<number, Uint8Array>;

/** The key of a point (chunk-local column, side, index across, height index); keys sort as the stored records do. */
export function wallPointKey(lx: number, lz: number, side: number, j: number, k: number): number {
  return ((k + KEY_HEIGHT_OFFSET) * 32 + j) * 1024 + side * 256 + lz * 16 + lx;
}

/** A key's [lx, lz, side, j, k]. */
export function wallPointOfKey(key: number): [number, number, number, number, number] {
  const low = key % 1024;
  const high = Math.floor(key / 1024);
  return [low % 16, (low >> 4) % 16, low >> 8, high % 32, Math.floor(high / 32) - KEY_HEIGHT_OFFSET];
}

function isDefault(v: Uint8Array): boolean {
  for (let i = 0; i < PAINT_CHANNELS; i++) if (v[i] !== UNPAINTED_WALL[i]) return false;
  return true;
}

/** A stored wall paint's problem (null: fine). */
export function wallPaintError(v: unknown): string | null {
  if (typeof v !== 'string') return `wallPaint is base64 of ${WALL_POINT_BYTES}-byte points (column, side and index across, height index, 4 layer weights, wetness)`;
  const b = decodeBase64(v);
  if (b === null || b.length === 0 || b.length % WALL_POINT_BYTES !== 0) return `wallPaint decodes to a whole number of ${WALL_POINT_BYTES}-byte points`;
  let last = -1;
  for (let o = 0; o < b.length; o += WALL_POINT_BYTES) {
    const i = o / WALL_POINT_BYTES;
    const j = b[o + 1]! & 31;
    if (j > WALL_PAINT_MAX_STEPS) return `point ${i}: the index across is 0-${WALL_PAINT_MAX_STEPS}`;
    const key = wallPointKey(b[o]! & 15, b[o]! >> 4, b[o + 1]! >> 5, j, b[o + 2]! + b[o + 3]! * 256 - HEIGHT_OFFSET);
    if (b[o + 1]! >> 5 > 3) return `point ${i}: the side is 0-3 (+X, −X, +Z, −Z)`;
    if (key <= last) return `point ${i}: points are sorted and each is stored once`;
    last = key;
    if (b[o + 4]! + b[o + 5]! + b[o + 6]! + b[o + 7]! !== 255) return `point ${i}: the four layer weights sum to 255`;
  }
  return null;
}

/** A stored wall paint's points (null: none or malformed — validation refuses those). */
export function decodeWallPaint(s: string | undefined): WallPaint | null {
  if (s === undefined || wallPaintError(s) !== null) return null;
  const b = decodeBase64(s)!;
  const out: WallPaint = new Map();
  for (let o = 0; o < b.length; o += WALL_POINT_BYTES) {
    const key = wallPointKey(b[o]! & 15, b[o]! >> 4, b[o + 1]! >> 5, b[o + 1]! & 31, b[o + 2]! + b[o + 3]! * 256 - HEIGHT_OFFSET);
    out.set(key, b.slice(o + 4, o + 4 + PAINT_CHANNELS));
  }
  return out;
}

/** The stored form of a chunk's points (undefined: nothing painted, not stored). Unpainted points are left out. */
export function encodeWallPaint(points: WallPaint | null | undefined): string | undefined {
  if (points === null || points === undefined) return undefined;
  const keys = [...points.keys()].filter((k) => !isDefault(points.get(k)!)).sort((a, b) => a - b);
  if (keys.length === 0) return undefined;
  const b = new Uint8Array(keys.length * WALL_POINT_BYTES);
  keys.forEach((key, i) => {
    const [lx, lz, side, j, k] = wallPointOfKey(key);
    const o = i * WALL_POINT_BYTES;
    const kk = k + HEIGHT_OFFSET;
    b[o] = lx | (lz << 4);
    b[o + 1] = (side << 5) | j;
    b[o + 2] = kk & 255;
    b[o + 3] = kk >> 8;
    b.set(points.get(key)!, o + 4);
  });
  return encodeBase64(b);
}

/** The canonical text of a stored wall paint (unpainted points dropped; undefined: nothing left or malformed). */
export function canonicalWallPaint(s: string | undefined): string | undefined {
  return encodeWallPaint(decodeWallPaint(s));
}

/** Side → [normal axis (0 x, 2 z), +1 or −1]. */
export const WALL_SIDE_AXES: readonly (readonly [number, number])[] = [[0, 1], [0, -1], [2, 1], [2, -1]];

/** What a wall dab needs of the grid. */
export interface WallPaintSurface {
  readonly cellSize: readonly number[];
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** A cell holding a block: 0 none, 1 a flat cell, 2 a sloped one (it may show part of a neighbour's face). */
  blockAt(x: number, y: number, z: number): 0 | 1 | 2;
  /** Whether an edge piece stands on the edge (`block-edges.ts`: axis 0 the cell's −x side, 1 its −z side). */
  edgeAt(x: number, y: number, z: number, axis: number): boolean;
  /** A chunk's points to write, or null when the chunk holds nothing. */
  points(cx: number, cz: number): WallPaint | null;
  /**
   * A point of chunk (cx, cz) changed: its column (chunk-local) and side say
   * which other chunk draws it too (an edge piece on a chunk border is
   * meshed with the chunk on the border's + side).
   */
  touched(cx: number, cz: number, lx: number, lz: number, side: number): void;
}

/**
 * Whether the side `side` of column (x, z) shows a face at height `h` (rows):
 * a row the point touches has a block in the column and none hiding it
 * across (a sloped one across may show part of it), or an edge piece on
 * that side. Hidden points are never painted (a dab into the ground would
 * otherwise store every buried face it reaches).
 */
function exposed(s: WallPaintSurface, x: number, z: number, side: number, h: number): boolean {
  const [axis, sign] = WALL_SIDE_AXES[side]!;
  const nx = axis === 0 ? x + sign : x;
  const nz = axis === 2 ? z + sign : z;
  const r = Math.floor(h);
  const rows = h === r ? [r - 1, r] : [r];
  for (const y of rows) {
    if (s.blockAt(x, y, z) !== 0 && s.blockAt(nx, y, nz) !== 1) return true;
    // The edge on that side: stored by the cell on its + side.
    if (axis === 0 ? s.edgeAt(sign > 0 ? x + 1 : x, y, z, 0) : s.edgeAt(x, y, sign > 0 ? z + 1 : z, 1)) return true;
  }
  return false;
}

/**
 * One brush dab on the walls at `at` ([x, y, z]: columns and rows, a point
 * on a wall): every exposed wall point within the radius (cells across;
 * distance in metres, so points where walls meet are painted alike) takes
 * the brush by its falloff. Returns the number of points changed.
 */
export function wallPaintDab(surface: WallPaintSurface, at: readonly [number, number, number], brush: PaintBrush): number {
  const cs = surface.cellSize;
  const st = wallPaintSteps(cs);
  const rm = brush.radius * cs[0]!;
  const reach = Math.ceil(brush.radius) + 1;
  const ax = at[0] * cs[0]!;
  const ay = at[1] * cs[1]!;
  const az = at[2] * cs[2]!;
  const k0 = Math.ceil(((ay - rm) / cs[1]!) * st.up);
  const k1 = Math.floor(((ay + rm) / cs[1]!) * st.up);
  const xc = Math.floor(at[0]);
  const zc = Math.floor(at[2]);
  let changed = 0;
  for (let z = Math.max(surface.minZ, zc - reach); z <= Math.min(surface.maxZ - 1, zc + reach); z++) {
    for (let x = Math.max(surface.minX, xc - reach); x <= Math.min(surface.maxX - 1, xc + reach); x++) {
      const cx = Math.floor(x / CHUNK_SIZE);
      const cz = Math.floor(z / CHUNK_SIZE);
      let points: WallPaint | null | undefined;
      for (let side = 0; side < 4; side++) {
        const [axis, sign] = WALL_SIDE_AXES[side]!;
        for (let j = 0; j <= st.along; j++) {
          // The point's place in metres: on the side's plane, j / along of the way across.
          const across = j / st.along;
          const px = axis === 0 ? (sign > 0 ? x + 1 : x) * cs[0]! : (x + across) * cs[0]!;
          const pz = axis === 2 ? (sign > 0 ? z + 1 : z) * cs[2]! : (z + across) * cs[2]!;
          const dxz = (px - ax) * (px - ax) + (pz - az) * (pz - az);
          if (dxz > rm * rm) continue;
          for (let k = Math.max(k0, surface.minY * st.up); k <= Math.min(k1, surface.maxY * st.up); k++) {
            const py = (k / st.up) * cs[1]!;
            const f = brushFalloff(dxz + (py - ay) * (py - ay), rm, brush.falloff);
            if (f <= 0 || !exposed(surface, x, z, side, k / st.up)) continue;
            if (points === undefined) points = surface.points(cx, cz);
            if (points === null) continue;
            const lx = x - cx * CHUNK_SIZE;
            const lz = z - cz * CHUNK_SIZE;
            const key = wallPointKey(lx, lz, side, j, k);
            const value = points.get(key) ?? Uint8Array.from(UNPAINTED_WALL);
            if (!paintPoint(value, 0, WALL_PAINT_LAYOUT, brush, brush.strength * f)) continue;
            if (isDefault(value)) points.delete(key);
            else points.set(key, value);
            surface.touched(cx, cz, lx, lz, side);
            changed += 1;
          }
        }
      }
    }
  }
  return changed;
}
