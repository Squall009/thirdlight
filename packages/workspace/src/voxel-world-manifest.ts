/** A voxel world's manifest (`world.json`): its format, how it is read, lifted, checked and written, and the folders of its grids. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chunkGrid,
  CHUNK_EDGES,
  isRegionFootprint,
  REGION_FOOTPRINTS,
  liftVersion,
  WORLD_GRID_ID,
  VOXEL_GRID_ID_MAX,
  WORLD_ID_BYTES,
  type ChunkEdge,
  type PaletteStore,
  type RegionFootprint,
  type RegionLayout,
} from '@thirdlight/voxel';
import { hexToBytes } from '@thirdlight/shared';
import { listRegionFiles, REGION_FILE_NAME_RE, RegionWorld, ShippedWorld, type WorldDirOptions } from './voxel-world-files';
import { writeAtomic } from './write';

/** The project folder holding its voxel worlds, one folder each. */
export const VOXEL_WORLDS_FOLDER = 'voxels';
/** A world's description and revision, next to its grids' folders. */
export const VOXEL_WORLD_MANIFEST = 'world.json';
/** The world manifest's format; a newer one is refused, an older one lifted ({@link liftManifest}). */
export const VOXEL_WORLD_FORMAT = 3;

/** The folder of a grid's region files inside a world's folder. */
export function gridFolder(gridId: number): string {
  return `grid-${gridId}`;
}

/** A structure grid of a world as its manifest lists it: its id (≥ 1) and its region files (sorted names). */
export interface VoxelWorldGrid {
  readonly id: number;
  readonly regions: readonly string[];
}

export interface VoxelWorldManifest {
  readonly format: number;
  /** The world id the region files carry (hex, 16 bytes). */
  readonly worldId: string;
  readonly edge: ChunkEdge;
  readonly layout: RegionLayout;
  readonly footprint: RegionFootprint;
  /** The world grid's region files (sorted names): any other region is air. */
  readonly regions: readonly string[];
  /** The structure grids, sorted by id, each with its region files listed as the world grid's are. */
  readonly grids: readonly VoxelWorldGrid[];
  /** Moves by one with every applied change. */
  readonly revision: number;
}

/**
 * A manifest of an older format lifted to this one, add-only. Format 1
 * listed no region files: lifting it lists the world grid's region files in
 * the folder at that moment (the most an old world can say). Format 2 had
 * no structure grids: it reads as a world without any.
 */
export function liftManifest(value: Record<string, unknown>, worldDir: string): Record<string, unknown> {
  const format = value.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) throw new Error(`unknown world manifest format ${String(format)}`);
  const steps = [
    { from: 1, lift: (o: Record<string, unknown>) => ({ ...o, format: 2, regions: listRegionFiles(join(worldDir, gridFolder(WORLD_GRID_ID))) }) },
    { from: 2, lift: (o: Record<string, unknown>) => ({ ...o, format: 3, grids: [] }) },
  ];
  return liftVersion('world manifest', format, VOXEL_WORLD_FORMAT, steps, value, (o) => o.format as number);
}

/** Whether `v` is a sorted list of region file names, each once. */
export const regionList = (v: unknown): v is string[] => Array.isArray(v) && !v.some((n, i) => typeof n !== 'string' || !REGION_FILE_NAME_RE.test(n) || (i > 0 && v[i - 1] >= n));

/** Reads a manifest of this format, refusing anything but its exact fields. */
export function parseVoxelWorldManifest(value: unknown): VoxelWorldManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('a world manifest is an object');
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'edge,footprint,format,grids,layout,regions,revision,worldId') throw new Error(`world manifest fields ${keys}`);
  if (o.format !== VOXEL_WORLD_FORMAT) throw new Error(`unknown world manifest format ${String(o.format)}`);
  const regions = o.regions;
  if (!regionList(regions)) throw new Error('regions is a sorted list of region file names, each once');
  const grids = o.grids;
  if (!Array.isArray(grids)) throw new Error('grids is a list of { id, regions }');
  const out: VoxelWorldGrid[] = [];
  for (const [i, g] of grids.entries()) {
    if (typeof g !== 'object' || g === null || Array.isArray(g) || Object.keys(g).sort().join(',') !== 'id,regions') throw new Error(`grids[${i}] is { id, regions }`);
    const { id, regions: listed } = g as Record<string, unknown>;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > VOXEL_GRID_ID_MAX) throw new Error(`grids[${i}].id is a whole number 1 … ${VOXEL_GRID_ID_MAX} (0 is the world grid)`);
    if (i > 0 && out[i - 1]!.id >= id) throw new Error('grids are sorted by id, each once');
    if (!regionList(listed)) throw new Error(`grids[${i}].regions is a sorted list of region file names, each once`);
    out.push({ id, regions: listed });
  }
  if (typeof o.worldId !== 'string' || !new RegExp(`^[0-9a-f]{${WORLD_ID_BYTES * 2}}$`).test(o.worldId)) throw new Error('worldId is 32 hex digits');
  if (!(CHUNK_EDGES as readonly unknown[]).includes(o.edge)) throw new Error(`chunk edge ${String(o.edge)}`);
  if (o.layout !== 'stacked' && o.layout !== 'column') throw new Error(`layout ${String(o.layout)}`);
  if (!isRegionFootprint(o.footprint)) throw new Error(`footprint ${String(o.footprint)} (cells a region side, one of ${REGION_FOOTPRINTS.join(', ')})`);
  if (typeof o.revision !== 'number' || !Number.isSafeInteger(o.revision) || o.revision < 0) throw new Error('revision is a whole number ≥ 0');
  return { format: VOXEL_WORLD_FORMAT, worldId: o.worldId, edge: o.edge as ChunkEdge, layout: o.layout, footprint: o.footprint as RegionFootprint, regions, grids: out, revision: o.revision };
}

export function manifestBytes(m: VoxelWorldManifest): Uint8Array {
  const ordered = { format: m.format, worldId: m.worldId, edge: m.edge, layout: m.layout, footprint: m.footprint, regions: m.regions, grids: m.grids.map((g) => ({ id: g.id, regions: g.regions })), revision: m.revision };
  return new TextEncoder().encode(`${JSON.stringify(ordered, null, 2)}\n`);
}

/**
 * Writes a new world folder from a store's chunks: the world grid's region
 * files, then the manifest at revision 0. Refuses a folder that already
 * holds a world.
 */
export function writeVoxelWorld(dir: string, m: Omit<VoxelWorldManifest, 'format' | 'revision' | 'regions' | 'grids'>, store: PaletteStore): { files: number } {
  if (existsSync(join(dir, VOXEL_WORLD_MANIFEST))) throw new Error(`${dir} already holds a voxel world`);
  let manifest = parseVoxelWorldManifest({ format: VOXEL_WORLD_FORMAT, revision: 0, regions: [], grids: [], ...m });
  if (store.grid.edge !== manifest.edge) throw new Error(`the store's chunk edge ${store.grid.edge} is not the world's ${manifest.edge}`);
  const world = RegionWorld.create(join(dir, gridFolder(WORLD_GRID_ID)), worldOptions(manifest), store);
  manifest = { ...manifest, regions: world.listedRegions() };
  const out = writeAtomic({ dir, target: VOXEL_WORLD_MANIFEST, bytes: manifestBytes(manifest), allowedPreHashes: null, previousHash: null });
  if (!out.ok) throw new Error(`${join(dir, VOXEL_WORLD_MANIFEST)}: not written`);
  return { files: world.files.size };
}

/**
 * Writes a world folder's manifest at revision 0 listing region files
 * already written into its grids' folders (a generator writing a large
 * world tile by tile, never holding it whole): the world grid's `regions`,
 * and each structure grid's in `grids`. Refuses a folder that already holds
 * a world, and a listed file that is not there.
 */
export function writeVoxelWorldManifest(dir: string, m: Omit<VoxelWorldManifest, 'format' | 'revision' | 'regions' | 'grids'>, regions: readonly string[], grids: readonly VoxelWorldGrid[] = []): void {
  if (existsSync(join(dir, VOXEL_WORLD_MANIFEST))) throw new Error(`${dir} already holds a voxel world`);
  const sorted = (names: readonly string[]): string[] => [...new Set(names)].sort();
  const listed = [{ id: WORLD_GRID_ID, regions: sorted(regions) }, ...[...grids].sort((a, b) => a.id - b.id).map((g) => ({ id: g.id, regions: sorted(g.regions) }))];
  for (const g of listed) for (const name of g.regions) if (!existsSync(join(dir, gridFolder(g.id), name))) throw new Error(`${gridFolder(g.id)}/${name}: listed but not written`);
  const manifest = parseVoxelWorldManifest({ format: VOXEL_WORLD_FORMAT, revision: 0, ...m, regions: listed[0]!.regions, grids: listed.slice(1) });
  const out = writeAtomic({ dir, target: VOXEL_WORLD_MANIFEST, bytes: manifestBytes(manifest), allowedPreHashes: null, previousHash: null });
  if (!out.ok) throw new Error(`${join(dir, VOXEL_WORLD_MANIFEST)}: not written`);
}

export function worldOptions(m: VoxelWorldManifest, gridId: number = WORLD_GRID_ID): WorldDirOptions {
  return { grid: chunkGrid(m.edge), worldId: hexToBytes(m.worldId), layout: m.layout, footprint: m.footprint, gridId };
}

/** A world folder's manifest, lifted to this format and checked; throws when it is missing or refused. */
export function readVoxelWorldManifest(dir: string): VoxelWorldManifest {
  const bytes = readFileSync(join(dir, VOXEL_WORLD_MANIFEST));
  return parseVoxelWorldManifest(liftManifest(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, dir));
}

/**
 * The shipped world a game save is made against, from a world folder: its
 * world grid's region files as its manifest lists them, each checked
 * against the world id and tile it must hold.
 */
export function openShippedWorld(dir: string): ShippedWorld {
  const m = readVoxelWorldManifest(dir);
  return new ShippedWorld(join(dir, gridFolder(WORLD_GRID_ID)), worldOptions(m), m.regions);
}
