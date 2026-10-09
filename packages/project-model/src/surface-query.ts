/**
 * One surface query over block layers and terrains: the ground at a world
 * point — its height, normal, slope and material layer weights — from
 * whichever of them is there, for footsteps, effects and placement tools.
 * Scripts ask it as `ctx.surface`, tools as the backend's `querySurface`;
 * both read through here, so they agree with each other and with what the
 * colliders hold.
 *
 * Which surface answers: looking down from the point, each block layer's
 * ground at or below it (`surfaceBelow`: the colliders' shape; a point
 * inside blocks climbs to their top) and each terrain's ground under it
 * (`TerrainField`: the heightfield's triangles; none over a hole) when it
 * lies at or below the point too (within {@link SURFACE_SINK_METRES}: feet
 * sunk a little into the ground still stand on it), so a cellar or tunnel
 * of blocks under a hill answers on its own floor. Terrain over the point
 * answers only when nothing lies below it (a point inside the ground climbs
 * to the surface, as a point inside blocks climbs to their top). The
 * highest of these wins; a block layer wins a tie, and terrain less than
 * {@link SURFACE_TIE_METRES} above it counts as one (a terrain sample's
 * height is rounded to its 16-bit step, so ground made to meet a block top
 * may stand a hair over it). So a block area standing
 * on terrain answers on its tops (the terrain under it is cut away or lies
 * just below them), the terrain answers round it, and a bridge answers over
 * the ground below it only from above.
 *
 * Weights are what the ground shows there, strongest first, summing to 1:
 * on blocks the paint the chunk's mesh carries at that point (hand paint
 * over the layer's material rules, `chunkMeshPaint` for one vertex), on
 * terrain its nearest sample's layers (baked rules under hand paint). Block
 * paint also has a wetness; terrain has none (0).
 *
 * Pure.
 */
import type { BlockType } from './block-layers';
import type { BlockGridReader } from './block-grid';
import { CHUNK_SIZE } from './block-layers';
import { chunkMeshPaint } from './block-paint-mesh';
import { surfaceBelow } from './block-surface';
import type { SurfaceRuleSet } from './surface-rules';
import type { TerrainField } from './terrain-field';

/** A block layer as the surface query reads it. */
export interface SurfaceBlockSource {
  readonly kind: 'blocks';
  /** The layer's object id. */
  readonly id: string;
  /** The layer as shown (its kits swapped). */
  readonly grid: BlockGridReader;
  readonly types: ReadonlyMap<string, BlockType>;
  /** The layer object's world position. */
  readonly origin: readonly number[];
  /** The layer's top subdivision, wall paint and material rules (the paint the mesh shows). */
  readonly topSubdivision: number;
  readonly wallPaint: boolean;
  readonly rules?: SurfaceRuleSet;
  /** The anchor of a cell a larger block's footprint covers (absent: such cells read as empty). */
  readonly anchorOf?: (x: number, y: number, z: number) => readonly [number, number, number] | null;
}

/** A terrain as the surface query reads it (only its loaded tiles have ground). */
export interface SurfaceTerrainSource {
  readonly kind: 'terrain';
  /** The terrain's object id. */
  readonly id: string;
  readonly field: TerrainField;
}

export type SurfaceSource = SurfaceBlockSource | SurfaceTerrainSource;

/** The ground at a point. */
export interface SurfaceAt {
  /** What answered: a block layer or a terrain, and its object id. */
  source: 'blocks' | 'terrain';
  object: string;
  /** World height (metres) and the point on the ground. */
  height: number;
  point: [number, number, number];
  /** Unit normal (world). */
  normal: [number, number, number];
  /** Degrees from level. */
  slope: number;
  /** The material layers showing, strongest first, and their weights (0–1, summing to 1). */
  layers: number[];
  weights: number[];
  /** Painted wetness 0–1 (block paint; 0 on terrain). */
  wetness: number;
  /** On blocks: the cell whose top it is and its block type. */
  cell?: [number, number, number];
  block?: string;
}

/** How far terrain may stand over a block layer's top and still count as level with it (the blocks answer). */
export const SURFACE_TIE_METRES = 0.01;

/**
 * How far terrain may stand over the asked point and still count as the
 * ground under it (a foot sunk into the slope, a sample's 16-bit rounding):
 * well under a storey, so ground over a cellar's ceiling never does.
 */
export const SURFACE_SINK_METRES = 0.25;

/** The highest a block layer's own query starts from when the point has no height (its top row's top). */
const topOf = (g: BlockGridReader): number => g.max[1]! * g.cellSize[1]!;

/**
 * The ground at or below world point (x, y, z) from the sources (see the
 * module comment); `y` +Infinity asks for the top surface there. Null: no
 * source has ground there.
 */
export function surfaceAt(sources: readonly SurfaceSource[], x: number, y: number, z: number): SurfaceAt | null {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Number.isNaN(y)) return null;
  // `rank`: the height compared (a block top raised by the tie, so terrain must clear it by more).
  let best: { height: number; rank: number; s: SurfaceSource; hit: unknown } | null = null;
  /** The lowest terrain over the point: the answer only when nothing lies at or below it. */
  let over: { s: SurfaceTerrainSource; hit: NonNullable<ReturnType<TerrainField['sample']>> } | null = null;
  for (const s of sources) {
    if (s.kind === 'blocks') {
      const o = s.origin;
      if (s.grid.metadataOnly) continue;
      const ly = y === Infinity ? topOf(s.grid) : y - o[1]!;
      const hit = surfaceBelow(s.grid, s.types, x - o[0]!, ly, z - o[2]!, s.anchorOf as ((x: number, y: number, z: number) => [number, number, number] | null) | undefined);
      if (hit === null) continue;
      const height = o[1]! + hit.height;
      const rank = height + SURFACE_TIE_METRES;
      if (best === null || rank > best.rank || (rank === best.rank && best.s.kind === 'terrain')) best = { height, rank, s, hit };
    } else {
      const smp = s.field.sample(x, z);
      if (smp === null) continue;
      if (smp.height > y + SURFACE_SINK_METRES) {
        if (over === null || smp.height < over.hit.height) over = { s, hit: smp };
        continue;
      }
      if (best === null || smp.height > best.rank) best = { height: smp.height, rank: smp.height, s, hit: smp };
    }
  }
  if (best === null && over !== null) best = { height: over.hit.height, rank: over.hit.height, s: over.s, hit: over.hit };
  if (best === null) return null;
  const s = best.s;
  if (s.kind === 'terrain') {
    const smp = best.hit as NonNullable<ReturnType<TerrainField['sample']>>;
    return { source: 'terrain', object: s.id, height: smp.height, point: [x, smp.height, z], normal: smp.normal, slope: smp.slope, layers: smp.layers, weights: smp.weights.map((w) => w / 255), wetness: 0 };
  }
  const hit = best.hit as NonNullable<ReturnType<typeof surfaceBelow>>;
  const o = s.origin;
  const lx = x - o[0]!;
  const lz = z - o[2]!;
  const cs = s.grid.cellSize;
  // The paint the chunk's mesh shows at this one point (a one-vertex part: its own cell, its own normal).
  const part = { positions: Float32Array.of(lx, hit.height, lz), normals: Float32Array.of(hit.normal[0], hit.normal[1], hit.normal[2]), indices: Uint32Array.of(0, 0, 0) };
  const paint = chunkMeshPaint(s.grid, s.types, Math.floor(lx / cs[0]! / CHUNK_SIZE), Math.floor(lz / cs[2]! / CHUNK_SIZE), { wallPaint: s.wallPaint, topSubdivision: s.topSubdivision, ...(s.rules !== undefined ? { rules: s.rules } : {}), origin: o }, part);
  const order = [0, 1, 2, 3].filter((l) => paint.weights[l]! > 0).sort((a, b) => paint.weights[b]! - paint.weights[a]! || a - b);
  const c = s.grid.get(hit.cell[0], hit.cell[1], hit.cell[2]);
  return {
    source: 'blocks',
    object: s.id,
    height: best.height,
    point: [x, best.height, z],
    normal: hit.normal,
    slope: hit.slope,
    layers: order,
    weights: order.map((l) => paint.weights[l]! / 255),
    wetness: paint.wetness[0]! / 255,
    cell: hit.cell,
    ...(c?.block !== undefined ? { block: c.block } : {}),
  };
}
