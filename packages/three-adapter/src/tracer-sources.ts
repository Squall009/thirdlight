/**
 * The tracer's inputs made from what the engine already holds: a block
 * layer's grid and a terrain's loaded tiles. Nothing is voxelized or
 * resampled; the tracer reads the cells and samples as they are.
 */
import { blockTypeSolid, terrainHeightOf, terrainHoleAt, terrainTileKey, type BlockCell, type BlockGridReader, type BlockType, type TerrainField } from '@thirdlight/runtime';

import type { TraceBlockLayer, TraceTerrain } from './tracer-scene';

/**
 * Which cells stop light: those whose block type fills its cell
 * (`blockTypeSolid`, the same rule that hides a neighbour's faces). Half
 * blocks, ramps, stairs and multi-cell pieces let rays through.
 */
export function opaqueByBlockTypes(types: readonly BlockType[]): (cell: BlockCell) => boolean {
  const solid = new Map(types.map((t) => [t.blockId, blockTypeSolid(t)]));
  return (cell) => cell.block !== undefined && solid.get(cell.block) === true;
}

/** A block layer placed at `origin` (the min corner of cell 0, 0, 0; layers neither rotate nor scale). */
export function traceBlockLayerOf(grid: BlockGridReader, origin: readonly number[], opaque: (cell: BlockCell) => boolean): TraceBlockLayer {
  return {
    worldToLocal: [1, 0, 0, -(origin[0] ?? 0), 0, 1, 0, -(origin[1] ?? 0), 0, 0, 1, -(origin[2] ?? 0)],
    cellSize: grid.cellSize,
    min: grid.min,
    max: grid.max,
    forEachOpaque(cell) {
      const byIndex = new Map<number, boolean>();
      grid.forEach((x, y, z, index) => {
        let o = byIndex.get(index);
        if (o === undefined) byIndex.set(index, (o = opaque(grid.valueOf(index))));
        if (o) cell(x, y, z);
      });
    },
  };
}

/**
 * A terrain's loaded tiles as one rectangle of the height grid (cells of a
 * tile that is not loaded, and holes, are open).
 */
export function traceTerrainOf(field: TerrainField, heightRange: readonly number[]): TraceTerrain | null {
  const tiles = field.loadedTiles();
  if (tiles.size === 0) return null;
  const n = field.n;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const key of tiles.keys()) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x + 1);
    z1 = Math.max(z1, z + 1);
  }
  const cellsX = (x1 - x0) * n;
  const cellsZ = (z1 - z0) * n;
  const sx = cellsX + 1;
  const heights = new Float32Array(sx * (cellsZ + 1));
  for (const [key, t] of tiles) {
    const [tx, tz] = key.split(',').map(Number) as [number, number];
    const bx = (tx - x0) * n;
    const bz = (tz - z0) * n;
    for (let z = 0; z <= n; z += 1) for (let x = 0; x <= n; x += 1) heights[(bz + z) * sx + bx + x] = terrainHeightOf(heightRange, t.heights[z * (n + 1) + x]!);
  }
  const o = field.origin;
  return {
    worldToLocal: [1, 0, 0, -o[0], 0, 1, 0, -o[1], 0, 0, 1, -o[2]],
    spacing: field.spacing,
    cellsX,
    cellsZ,
    cellX0: x0 * n,
    cellZ0: z0 * n,
    heights,
    hole(x, z) {
      const t = tiles.get(terrainTileKey(x0 + Math.floor(x / n), z0 + Math.floor(z / n)));
      return t === undefined || terrainHoleAt(t, x % n, z % n);
    },
  };
}
