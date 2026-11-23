/**
 * Where a structure grid stands in its world, and the arithmetic between
 * its frame and the world's.
 *
 * A structure grid (a grid id ≥ 1 of a world, its region files listed in
 * the world manifest) uses the same cells, chunks and regions as the world
 * grid in a local frame of its own. Its place is a position (metres, where
 * its cell (0, 0, 0)'s corner stands) and a yaw about the vertical axis
 * (floors stay level: never a tilt or a scale). The voxel files do not hold
 * it: it is the structure object's, so moving a structure rewrites no
 * voxel. A world point p lies at grid point R(−yaw)(p − position); a grid
 * point q at R(yaw) q + position, with R the rotation about +y in the
 * right-handed sense three.js and the physics port share (+x turns toward
 * −z for a positive yaw).
 *
 * Also here: the chunks a grid holds (from its region files' tables, so a
 * grid's streamer reads round its own cells and no further), the name its
 * draws go under on the page, and the text form a page passes placements
 * in (a bench's query switch, until structure objects carry them).
 */
import type { ChunkCoord } from './coords';
import { parseRegionFileName, VOXEL_GRID_ID_MAX, type RegionLayout } from './region-file';
import type { RegionChunkSource } from './region-source';

/** A structure grid of a world and where it stands: its id (≥ 1), its cell (0, 0, 0)'s corner in world metres, its yaw (radians). */
export interface GridPlacement {
  readonly gridId: number;
  readonly position: readonly [number, number, number];
  readonly yawRad: number;
}

/** A box of chunks, inclusive on both ends. */
export interface ChunkBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Why `p` is not a placement (null: it is one). */
export function gridPlacementProblem(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return 'a grid placement is { gridId, position: [x, y, z], yawRad }';
  const o = p as Record<string, unknown>;
  if (typeof o.gridId !== 'number' || !Number.isInteger(o.gridId) || o.gridId < 1 || o.gridId > VOXEL_GRID_ID_MAX) return 'gridId is a whole number 1 … 2³² − 1 (0 is the world grid)';
  if (!Array.isArray(o.position) || o.position.length !== 3 || !o.position.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'position is [x, y, z] in metres';
  if (typeof o.yawRad !== 'number' || !Number.isFinite(o.yawRad)) return 'yawRad is a finite number';
  return null;
}

/** A grid's frame: points and directions between the world (metres) and the grid (metres from its cell (0, 0, 0)). */
export class GridFrame {
  readonly gridId: number;
  readonly position: readonly [number, number, number];
  readonly yawRad: number;
  private readonly c: number;
  private readonly s: number;

  constructor(place: GridPlacement) {
    const why = gridPlacementProblem(place);
    if (why !== null) throw new RangeError(why);
    this.gridId = place.gridId;
    this.position = [place.position[0], place.position[1], place.position[2]];
    this.yawRad = place.yawRad;
    this.c = Math.cos(place.yawRad);
    this.s = Math.sin(place.yawRad);
  }

  /** A world point (metres) in the grid's frame (metres from its cell (0, 0, 0)). */
  toGrid(x: number, y: number, z: number): [number, number, number] {
    const dx = x - this.position[0];
    const dz = z - this.position[2];
    return [this.c * dx - this.s * dz, y - this.position[1], this.s * dx + this.c * dz];
  }

  /** A grid point (metres from its cell (0, 0, 0)) in the world (metres). */
  toWorld(x: number, y: number, z: number): [number, number, number] {
    return [this.c * x + this.s * z + this.position[0], y + this.position[1], -this.s * x + this.c * z + this.position[2]];
  }

  /** A world direction (a velocity) in the grid's frame: turned, never moved. */
  directionToGrid(x: number, y: number, z: number): [number, number, number] {
    return [this.c * x - this.s * z, y, this.s * x + this.c * z];
  }

  /** The yaw as a unit quaternion (x, y, z, w), as three.js and the physics port take a rotation. */
  quaternion(): { x: number; y: number; z: number; w: number } {
    return { x: 0, y: Math.sin(this.yawRad / 2), z: 0, w: Math.cos(this.yawRad / 2) };
  }
}

/**
 * The chunks a grid holds: the box round every chunk its listed region files' tables name (null: none, an
 * empty grid). Reads only the tables (one request a file when they fit); a file that cannot be read is left out
 * here, its chunks reported damaged when they are read.
 */
export async function gridChunkExtent(source: Pick<RegionChunkSource, 'table'>, layout: RegionLayout, listed: readonly string[]): Promise<ChunkBox | null> {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
  for (const name of listed) {
    const at = parseRegionFileName(layout, name);
    if (at === null) continue;
    const index = await source.table(at.rx, at.ry, at.rz).catch(() => null);
    if (index === null) continue;
    for (let i = 0; i < index.size; i++) {
      index.coordOf(i, c);
      const v = [c.cx, c.cy, c.cz];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, v[a]!);
        max[a] = Math.max(max[a]!, v[a]!);
      }
    }
  }
  return min[0] === Infinity ? null : { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] };
}

/**
 * Chunks a grid's streamer reads past the chunks the grid holds: the chunks beside them (air) must be known for
 * theirs to derive, and those beside the air for its own derive (it can stand on a neighbour's ground).
 */
export const GRID_EXTENT_MARGIN_CHUNKS = 2;

/** A box grown by `n` chunks on every side. */
export function grownChunkBox(b: ChunkBox, n: number): ChunkBox {
  return { min: [b.min[0] - n, b.min[1] - n, b.min[2] - n], max: [b.max[0] + n, b.max[1] + n, b.max[2] + n] };
}

/** The name a structure grid's draws go under on the page (its world's name and its id; the world grid's are the world's own). */
export function gridDrawName(world: string, gridId: number): string {
  return `${world}#${gridId}`;
}

/**
 * Placements as a page passes them (`<world>:<id>,<x>,<y>,<z>,<yaw°>;<id>,…` with more worlds after `|`), by world;
 * throws on anything else, naming what is wrong.
 */
export function parseGridPlacements(text: string): Map<string, GridPlacement[]> {
  const out = new Map<string, GridPlacement[]>();
  if (text.trim() === '') return out;
  for (const part of text.split('|')) {
    const colon = part.indexOf(':');
    if (colon <= 0) throw new Error(`grid placements: "${part.slice(0, 40)}" is <world>:<id>,<x>,<y>,<z>,<yaw°>;…`);
    const world = part.slice(0, colon);
    const list: GridPlacement[] = out.get(world) ?? [];
    for (const item of part.slice(colon + 1).split(';')) {
      if (item === '') continue;
      const v = item.split(',').map(Number);
      const place: GridPlacement = { gridId: v[0]!, position: [v[1]!, v[2]!, v[3]!], yawRad: ((v[4] ?? NaN) * Math.PI) / 180 };
      const why = v.length === 5 ? gridPlacementProblem(place) : 'five numbers';
      if (why !== null) throw new Error(`grid placements: "${item}": ${why}`);
      if (list.some((p) => p.gridId === place.gridId)) throw new Error(`grid placements: grid ${place.gridId} of ${world} placed twice`);
      list.push(place);
    }
    out.set(world, list);
  }
  return out;
}

/** The text {@link parseGridPlacements} reads, for a world's placements (yaw written in degrees, as a person reads it). */
export function gridPlacementsText(world: string, places: readonly GridPlacement[]): string {
  const n = (v: number): string => String(Math.round(v * 1e4) / 1e4);
  return `${world}:${places.map((p) => [p.gridId, ...p.position.map(n), n((p.yawRad * 180) / Math.PI)].join(',')).join(';')}`;
}

/** The page switch placements reach Play by (a bench's: `?voxelGrids=<text>`, {@link parseGridPlacements}). */
export const VOXEL_GRIDS_URL_PARAM = 'voxelGrids';

/** Where a structure grid's draws stand, carried with its draw batches: its world's name, its id and its place. */
export interface GridPlaceWire {
  readonly world: string;
  readonly grid: number;
  readonly position: readonly [number, number, number];
  readonly yawRad: number;
}
