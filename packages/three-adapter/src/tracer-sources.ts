/**
 * The tracer's inputs made from what the engine already holds: a block
 * layer's grid, a terrain's loaded tiles, generated architecture's own
 * parameters and a model's distance-field bricks. Nothing is voxelized or
 * resampled here; the tracer reads the cells, samples and pieces as they are.
 */
import { COLLIDER_3D_LIMITS, architectureLightBlockers, blockTypeSolid, terrainHeightOf, terrainHoleAt, terrainTileKey, type ArchitectureComponent, type BlockCell, type BlockGridReader, type BlockType, type DistanceBricks, type TerrainField } from '@thirdlight/project-model';

import type { TraceArchitecture, TraceBox, TraceModelInstance } from './tracer-objects';
import type { Affine, TraceBlockLayer, TraceTerrain } from './tracer-scene';

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

/**
 * Generated architecture objects (expanded components and their world
 * origins) as boxes and flat triangles: its light blockers, the pieces its
 * colliders are made of plus those nobody collides with (walls with their
 * profile's thickness, cut round openings; stamped pieces; floors,
 * ceilings, vaults and roofs as meshes). Kit copies are models: they are
 * traced by their bricks.
 */
export function traceArchitectureOf(objects: readonly { component: ArchitectureComponent; origin: readonly number[] }[]): TraceArchitecture {
  const boxes: TraceBox[] = [];
  const tris: number[] = [];
  for (const { component, origin } of objects) {
    const o = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    for (const c of architectureLightBlockers(component, {}, { vertices: COLLIDER_3D_LIMITS.meshVertices, triangles: COLLIDER_3D_LIMITS.meshTriangles })) {
      if (c.kind === 'box') boxes.push({ center: [o[0]! + c.center[0], o[1]! + c.center[1], o[2]! + c.center[2]], half: c.half, rotation: c.rotation });
      else if (c.kind === 'mesh') {
        for (let i = 0; i + 2 < c.indices.length; i += 3) {
          for (let k = 0; k < 3; k += 1) {
            const v = c.indices[i + k]! * 3;
            tris.push(o[0]! + c.vertices[v]!, o[1]! + c.vertices[v + 1]!, o[2]! + c.vertices[v + 2]!);
          }
        }
      }
    }
  }
  return { boxes, triangles: new Float32Array(tris) };
}

/** A model placed by `worldToLocal` (its world → root map): one instance per brick set, or only `piece`'s. */
export function traceModelInstancesOf(bricks: DistanceBricks, worldToLocal: Affine, piece: string | null = null): TraceModelInstance[] {
  return bricks.sets.filter((s) => piece === null || s.piece === piece).map((set) => ({ worldToLocal, set }));
}
