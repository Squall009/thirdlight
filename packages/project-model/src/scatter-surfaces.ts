/**
 * The two sources scatter rules read (`scatter.ts`): a terrain's tiles and a
 * block layer's tops, each as a {@link ScatterSurface} in world metres, and
 * the named regions of block layers that rules keep clear.
 *
 * Terrain: the ground and normal are the terrain's surface (`TerrainField`,
 * the colliders' triangles), the layer shares those its nearest sample shows
 * (baked rules under hand paint), the cavity the mean height `radius` away
 * less the point's (as the material rules' bake measures it).
 *
 * Block layers: the ground is the highest block top in the column (the
 * colliders' shape, `surfaceBelow`), the block type and metadata its cell's,
 * the layer shares the paint the chunk's mesh shows there (hand paint over
 * the layer's material rules, `chunkMeshPaint` for that one point), the
 * cavity measured over the tops around.
 *
 * Pure.
 */
import type { BlockType, CellMetaValue } from './block-layers';
import type { BlockGridReader } from './block-grid';
import { chunkMeshPaint } from './block-paint-mesh';
import { surfaceBelow } from './block-surface';
import type { ScatterGround, ScatterSurface } from './scatter';
import type { SurfaceRuleSet } from './surface-rules';
import type { TerrainField } from './terrain-field';
import { CHUNK_SIZE } from './block-layers';

/** A terrain as scatter reads it (only its loaded tiles have ground). */
export function terrainScatterSurface(field: TerrainField, excluded?: ScatterSurface['excluded']): ScatterSurface {
  let layers: number[] = [];
  let weights: number[] = [];
  const g: ScatterGround = {
    x: 0,
    y: 0,
    z: 0,
    slope: 0,
    wall: false,
    nx: 0,
    ny: 1,
    nz: 0,
    cavity(radius: number): number {
      let sum = 0;
      let n = 0;
      for (const [dx, dz] of [[-radius, 0], [radius, 0], [0, -radius], [0, radius]] as const) {
        const h = field.heightAt(g.x + dx, g.z + dz);
        if (h === null) continue;
        sum += h;
        n += 1;
      }
      return n === 0 ? 0 : sum / n - g.y;
    },
    layer(l: number): number {
      for (let i = 0; i < layers.length; i++) if (layers[i] === l) return weights[i]! / 255;
      return 0;
    },
  };
  return {
    at(x: number, z: number): ScatterGround | null {
      const s = field.sample(x, z);
      if (s === null) return null;
      g.x = x;
      g.y = s.height;
      g.z = z;
      g.slope = s.slope;
      [g.nx, g.ny, g.nz] = s.normal;
      layers = s.layers;
      weights = s.weights;
      return g;
    },
    ...(excluded !== undefined ? { excluded } : {}),
  };
}

/** What a block layer's scatter reads besides its grid. */
export interface BlockScatterSource {
  readonly grid: BlockGridReader;
  readonly types: ReadonlyMap<string, BlockType>;
  /** The layer object's world position. */
  readonly origin: readonly number[];
  /** The layer's top subdivision and material rules (the paint the mesh shows). */
  readonly topSubdivision: number;
  readonly rules?: SurfaceRuleSet;
}

/** A block layer's tops as scatter reads them. */
export function blockScatterSurface(src: BlockScatterSource, excluded?: ScatterSurface['excluded']): ScatterSurface {
  const { grid, types, origin } = src;
  const cs = grid.cellSize;
  const top = grid.max[1]! * cs[1]!;
  let cell: [number, number, number] = [0, 0, 0];
  let shares: Uint8Array | null = null;
  const g: ScatterGround = {
    x: 0,
    y: 0,
    z: 0,
    slope: 0,
    wall: false,
    nx: 0,
    ny: 1,
    nz: 0,
    cavity(radius: number): number {
      const ly = g.y - origin[1]!;
      let sum = 0;
      let n = 0;
      for (const [dx, dz] of [[-radius, 0], [radius, 0], [0, -radius], [0, radius]] as const) {
        const hit = surfaceBelow(grid, types, g.x - origin[0]! + dx, ly + 2 * radius, g.z - origin[2]! + dz);
        if (hit === null) continue;
        sum += hit.height;
        n += 1;
      }
      return n === 0 ? 0 : sum / n - ly;
    },
    layer(l: number): number {
      if (l < 0 || l > 3) return 0;
      if (shares === null) {
        // The paint the chunk's mesh shows at this one point (a one-vertex part: its own cell, its own normal).
        const lx = g.x - origin[0]!;
        const lz = g.z - origin[2]!;
        const part = { positions: Float32Array.of(lx, g.y - origin[1]!, lz), normals: Float32Array.of(g.nx, g.ny, g.nz), indices: Uint32Array.of(0, 0, 0) };
        shares = chunkMeshPaint(grid, types, Math.floor(lx / cs[0]! / CHUNK_SIZE), Math.floor(lz / cs[2]! / CHUNK_SIZE), { wallPaint: false, topSubdivision: src.topSubdivision, ...(src.rules !== undefined ? { rules: src.rules } : {}), origin }, part).weights;
      }
      return shares[l]! / 255;
    },
  };
  return {
    at(x: number, z: number): ScatterGround | null {
      const hit = surfaceBelow(grid, types, x - origin[0]!, top, z - origin[2]!);
      if (hit === null) return null;
      g.x = x;
      g.y = origin[1]! + hit.height;
      g.z = z;
      g.slope = hit.slope;
      [g.nx, g.ny, g.nz] = hit.normal;
      cell = hit.cell;
      shares = null;
      const c = grid.get(cell[0], cell[1], cell[2]);
      if (c?.block !== undefined) g.block = c.block;
      else delete g.block;
      g.meta = (key: string): CellMetaValue | undefined => c?.meta?.[key] ?? (c?.block !== undefined ? types.get(c.block)?.metadata?.[key] : undefined);
      return g;
    },
    ...(excluded !== undefined ? { excluded } : {}),
  };
}

/** A block layer's named regions as scatter exclusion reads them. */
export interface ScatterRegionLayer {
  readonly regions: ReadonlyMap<string, readonly (readonly number[])[]>;
  readonly cellSize: readonly number[];
  readonly origin: readonly number[];
}

/**
 * Whether a world point lies in the columns of a region of these names in
 * any of the layers (a region's boxes are cells [x0, y0, z0, x1, y1, z1];
 * only their footprint counts, so a rule keeps a whole village clear).
 */
export function regionExcluder(layers: readonly ScatterRegionLayer[]): (x: number, z: number, names: readonly string[]) => boolean {
  return (x, z, names) => {
    for (const l of layers) {
      const cx = Math.floor((x - l.origin[0]!) / l.cellSize[0]!);
      const cz = Math.floor((z - l.origin[2]!) / l.cellSize[2]!);
      for (const name of names) {
        for (const b of l.regions.get(name) ?? []) if (cx >= b[0]! && cx < b[3]! && cz >= b[2]! && cz < b[5]!) return true;
      }
    }
    return false;
  };
}
