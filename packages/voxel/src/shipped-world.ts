/**
 * A voxel world as an exported game ships it.
 *
 * An export has no backend to read region files by range from: each world
 * a scene names ships its listed region files whole, as content-addressed
 * files (`content/sha256/<digest>`), and the build's catalog lists the
 * world (its id, grid, layout, footprint and revision) with every file's
 * name, digest and length. A game reads a file once, the first time a
 * chunk of its region is asked for, checks it against its row and then
 * serves the region's reads from those bytes ({@link wholeFileByteSource});
 * a file the world does not list is air, as on the backend.
 *
 * Pure: the read of a file is passed in (the exported page's content
 * reader, a test's disk read), so this module does no I/O of its own.
 */
import { chunkGrid, CHUNK_EDGES, isRegionFootprint, REGION_FOOTPRINTS, type ChunkEdge, type RegionFootprint } from './coords';
import { parseRegionFileName, VOXEL_WORLD_NAME_RE, WORLD_GRID_ID, WORLD_ID_BYTES, type RegionByteSource, type RegionLayout } from './region-file';
import { RegionChunkSource } from './region-source';
import { hexToBytes } from '@thirdlight/shared';

/** One shipped region file: its name in the world grid's folder, and the digest and length of its bytes. */
export interface ShippedVoxelFile {
  readonly name: string;
  readonly digest: string;
  readonly byteLength: number;
}

/** One shipped world (the world manifest's fields, and its region files as shipped). */
export interface ShippedVoxelWorld {
  /** The world's name (`voxels/<world>/` in the project; what a `voxelWorld` component names). */
  readonly world: string;
  /** The world id the region files carry (hex). */
  readonly worldId: string;
  readonly edge: ChunkEdge;
  readonly layout: RegionLayout;
  readonly footprint: RegionFootprint;
  /** The world's revision when the build was made. */
  readonly revision: number;
  /** Its listed region files, by name; any other region is air. */
  readonly files: readonly ShippedVoxelFile[];
}

/** A shipped world's fields, in their canonical order. */
const WORLD_KEYS = 'world,worldId,edge,layout,footprint,revision,files';
const FILE_KEYS = 'name,digest,byteLength';
const DIGEST = /^[0-9a-f]{64}$/;
const WORLD_ID = new RegExp(`^[0-9a-f]{${WORLD_ID_BYTES * 2}}$`);

/** Region tables a world's chunk source keeps open at once (a shipped one holds each open file's bytes too). */
export const OPEN_REGION_FILES = 64;

/** A shipped world rebuilt field by field, in the canonical key order. */
export function canonicalShippedVoxelWorld(w: ShippedVoxelWorld): ShippedVoxelWorld {
  return {
    world: w.world,
    worldId: w.worldId,
    edge: w.edge,
    layout: w.layout,
    footprint: w.footprint,
    revision: w.revision,
    files: [...w.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((f) => ({ name: f.name, digest: f.digest, byteLength: f.byteLength })),
  };
}

/**
 * Why a list of shipped worlds is not one (null: it is): each world once,
 * in name order, with exactly its fields; its files in name order, each a
 * region file name of its layout with a digest and a length.
 */
export function shippedVoxelWorldsProblem(v: unknown): string | null {
  if (!Array.isArray(v)) return 'voxelWorlds is a list';
  let last = '';
  for (const [i, raw] of v.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `voxelWorlds[${i}] is not an object`;
    const w = raw as Record<string, unknown>;
    if (Object.keys(w).join(',') !== WORLD_KEYS) return `voxelWorlds[${i}] has the keys ${WORLD_KEYS.replace(/,/g, ', ')}`;
    if (typeof w.world !== 'string' || !VOXEL_WORLD_NAME_RE.test(w.world)) return `voxelWorlds[${i}].world is not a world name`;
    if (i > 0 && !(last < w.world)) return 'voxelWorlds are in ascending world name order, each once';
    last = w.world;
    if (typeof w.worldId !== 'string' || !WORLD_ID.test(w.worldId)) return `voxelWorlds[${i}].worldId is ${WORLD_ID_BYTES * 2} hex digits`;
    if (!(CHUNK_EDGES as readonly unknown[]).includes(w.edge)) return `voxelWorlds[${i}].edge is one of ${CHUNK_EDGES.join(', ')}`;
    if (w.layout !== 'stacked' && w.layout !== 'column') return `voxelWorlds[${i}].layout is stacked or column`;
    if (!isRegionFootprint(w.footprint)) return `voxelWorlds[${i}].footprint is one of ${REGION_FOOTPRINTS.join(', ')}`;
    if (typeof w.revision !== 'number' || !Number.isSafeInteger(w.revision) || w.revision < 0) return `voxelWorlds[${i}].revision is a whole number ≥ 0`;
    if (!Array.isArray(w.files)) return `voxelWorlds[${i}].files is a list`;
    let lastName = '';
    for (const [k, f] of (w.files as unknown[]).entries()) {
      if (typeof f !== 'object' || f === null || Object.keys(f).join(',') !== FILE_KEYS) return `voxelWorlds[${i}].files[${k}] has the keys name, digest, byteLength`;
      const r = f as Record<string, unknown>;
      if (typeof r.name !== 'string' || parseRegionFileName(w.layout, r.name) === null) return `voxelWorlds[${i}].files[${k}].name is not a ${w.layout} region file name`;
      if (k > 0 && !(lastName < r.name)) return `voxelWorlds[${i}].files are in ascending name order, each once`;
      lastName = r.name;
      if (typeof r.digest !== 'string' || !DIGEST.test(r.digest)) return `voxelWorlds[${i}].files[${k}].digest is 64 lowercase hex`;
      if (typeof r.byteLength !== 'number' || !Number.isSafeInteger(r.byteLength) || r.byteLength < 1) return `voxelWorlds[${i}].files[${k}].byteLength is a positive whole number`;
    }
  }
  return null;
}

/**
 * A region file read whole on its first read (`load`, once) and every read
 * served from those bytes (a copy of the range): up to `length` bytes from
 * `offset`, fewer at the end. A failed load fails this read and the next
 * one tries again.
 */
export function wholeFileByteSource(load: () => Promise<Uint8Array>): RegionByteSource {
  let bytes: Promise<Uint8Array> | null = null;
  return {
    read: async (offset, length) => {
      const p = (bytes ??= load());
      p.catch(() => {
        if (bytes === p) bytes = null;
      });
      const all = await p;
      // A copy, never a view: what a read returns may be transferred to a worker, which would detach the whole file.
      return all.slice(Math.min(offset, all.length), Math.min(offset + length, all.length));
    },
  };
}

/**
 * The chunk source of a shipped world: each listed file read whole through
 * `readFile` (which checks it against its row) the first time its region is
 * opened; regions not listed are air.
 */
export function shippedChunkSource(w: ShippedVoxelWorld, readFile: (file: ShippedVoxelFile) => Promise<Uint8Array>): RegionChunkSource {
  const byName = new Map(w.files.map((f) => [f.name, f]));
  return new RegionChunkSource({
    worldId: hexToBytes(w.worldId),
    gridId: WORLD_GRID_ID,
    grid: chunkGrid(w.edge),
    layout: w.layout,
    footprint: w.footprint,
    maxOpen: OPEN_REGION_FILES,
    open: (name) => {
      const f = byName.get(name);
      return f === undefined ? null : wholeFileByteSource(() => readFile(f));
    },
  });
}
