/**
 * A terrain's scatter (`scatter.ts`): its stored rules' copies baked per
 * tile, each tile's in a blob of its own (`TerrainTileRef.scatter`), so a
 * stroke on the scatter never sends the tile's heights and layers again.
 *
 * An edit of the ground bakes the copies again over what it changed — the
 * samples whose height, layers, paint or holes differ, grown by the rules'
 * reach — and a `bake` bakes them everywhere. Copies belong to the tile
 * their point lies in (its box's min edges included, its max edges not).
 *
 * Pure.
 */
import { SCATTER_BLOB_MAGIC, bakeScatterCell, decodeScatterCell, encodeScatterCell, sameScatterCell, type ScatterCell, type ScatterRect, type ScatterRule, type ScatterSurface } from './scatter';
import { hasBinaryMagic, readBinaryBlob, wrapBinaryBlob } from './binary-container';
import { terrainTileKey } from './terrain';
import type { TerrainTile } from './terrain-tile';
import { TERRAIN_PAINT_BYTES, TERRAIN_WEIGHT_BYTES, terrainHoleAt } from './terrain-tile';

/**
 * The samples whose height, baked layers, hand paint or holes differ
 * between `before` and `after` (tiles by "x,z"; a tile only in `after`
 * changed everywhere), as global sample indices [x0, z0, x1, z1]; null:
 * nothing changed.
 */
export function terrainChangedSamples(before: ReadonlyMap<string, TerrainTile>, after: ReadonlyMap<string, TerrainTile>, cells: number): [number, number, number, number] | null {
  let r: [number, number, number, number] | null = null;
  const grow = (x: number, z: number): void => {
    r = r === null ? [x, z, x, z] : [Math.min(r[0], x), Math.min(r[1], z), Math.max(r[2], x), Math.max(r[3], z)];
  };
  const s = cells + 1;
  for (const [key, t] of after) {
    const [tx, tz] = key.split(',').map(Number) as [number, number];
    const old = before.get(key);
    if (old === undefined) {
      grow(tx * cells, tz * cells);
      grow(tx * cells + cells, tz * cells + cells);
      continue;
    }
    if (old === t) continue;
    const differs = (a: Uint8Array | null, b: Uint8Array | null, stride: number, i: number): boolean => {
      if (a === b) return false;
      for (let k = 0; k < stride; k++) if ((a?.[i * stride + k] ?? -1) !== (b?.[i * stride + k] ?? -1)) return true;
      return false;
    };
    for (let j = 0; j < s; j++) {
      for (let i = 0; i < s; i++) {
        const n = j * s + i;
        const hole = i < cells && j < cells && terrainHoleAt(old, i, j) !== terrainHoleAt(t, i, j);
        if (hole || old.heights[n] !== t.heights[n] || differs(old.weights, t.weights, TERRAIN_WEIGHT_BYTES, n) || differs(old.paint, t.paint, TERRAIN_PAINT_BYTES, n)) {
          grow(tx * cells + i, tz * cells + j);
          // A hole is a cell: its far corner too.
          if (hole) grow(tx * cells + i + 1, tz * cells + j + 1);
        }
      }
    }
  }
  return r;
}

/** A tile's world box in XZ. */
export function terrainTileRect(origin: readonly number[], size: number, x: number, z: number): ScatterRect {
  return [origin[0]! + x * size, origin[2]! + z * size, origin[0]! + (x + 1) * size, origin[2]! + (z + 1) * size];
}

/**
 * Bake a terrain's stored scatter rules over `rect` (world XZ; null: every
 * tile, whole). `tiles` lists the tiles to bake ([x, z]), `prev` their
 * scatter to bake from (absent: none), `stored` what they hold now (absent:
 * `prev`; a stroke's hand edits make the two differ). Returns the tiles
 * whose scatter changed from `stored` (null: none left) and the candidates
 * looked at.
 */
export function bakeTerrainScatter(rules: readonly ScatterRule[], surface: ScatterSurface, origin: readonly number[], size: number, tiles: readonly (readonly [number, number])[], prev: ReadonlyMap<string, ScatterCell>, rect: ScatterRect | null, stored: ReadonlyMap<string, ScatterCell> = prev): { cells: Map<string, ScatterCell | null>; looked: number } {
  const cells = new Map<string, ScatterCell | null>();
  let looked = 0;
  for (const [x, z] of tiles) {
    const bounds = terrainTileRect(origin, size, x, z);
    if (rect !== null && (rect[0] >= bounds[2] || rect[2] <= bounds[0] || rect[1] >= bounds[3] || rect[3] <= bounds[1])) continue;
    const key = terrainTileKey(x, z);
    const r = bakeScatterCell(rules, surface, prev.get(key) ?? null, bounds, rect, origin);
    looked += r.looked;
    if (sameScatterCell(stored.get(key) ?? null, r.cell)) continue;
    cells.set(key, r.cell.size === 0 ? null : r.cell);
  }
  return { cells, looked };
}

/** A tile's scatter as its stored blob (uncompressed: the copies are floats). Null: nothing to store. */
export function scatterBlobOf(cell: ScatterCell | null): Uint8Array | null {
  if (cell === null) return null;
  const payload = encodeScatterCell(cell);
  return payload === null ? null : wrapBinaryBlob(SCATTER_BLOB_MAGIC, 'none', payload.length, payload);
}

/** A scatter blob's cell (throws a short message when it is not one). */
export function scatterCellOfBlob(blob: Uint8Array): ScatterCell {
  const h = readBinaryBlob(blob, SCATTER_BLOB_MAGIC, 'scatter');
  if (h.compression !== 'none') throw new Error('scatter binary: stored uncompressed');
  if (h.stored.length !== h.rawLength) throw new Error(`scatter binary: the header says ${h.rawLength} bytes, the blob holds ${h.stored.length}`);
  return decodeScatterCell(h.stored);
}

/** Whether bytes are a scatter blob (its first bytes suffice). */
export function isScatterBlob(bytes: Uint8Array): boolean {
  return hasBinaryMagic(bytes, SCATTER_BLOB_MAGIC);
}
