/**
 * A project's voxel world opened over HTTP, as the voxel world page, Play
 * and the editor's Scene view open one: the world's manifest and listed
 * region files from its route, a chunk source reading those files by range
 * (a file the world does not list holds only air), and a pool of module
 * workers decoding and deriving its chunks.
 *
 * The files change under an open world when an edit is applied (by the
 * page itself, the editor, or MCP): the change names the files rewritten
 * with their new tags and the chunks to read again, and `applyChange`
 * hands those to the streamer. A world changed some other way (a revision
 * missed, files restored) is read again whole (`readAgain`).
 */
import { hexToBytes } from '@thirdlight/shared';
import { chunkGrid, eventTargetWorker, RegionChunkSource, STREAM_POOL_SETTINGS, WORLD_GRID_ID, WorkerPool, type CellBox, type ChunkCoord, type ChunkEdge, type ChunkGrid, type VoxelStreamer } from '@thirdlight/voxel';
import { defaultVoxelWorkers, rangeByteSource, type RangeReadStats } from './range-reads';

/** Region files a world's source keeps open at once. */
const OPEN_REGION_FILES = 64;

export interface VoxelWorldManifest {
  readonly revision: number;
  readonly worldId: string;
  readonly edge: number;
  readonly layout: 'stacked' | 'column';
  readonly footprint: 512 | 1024;
}

/** What a world's route answers. */
interface WorldInfo {
  ok: boolean;
  manifest?: VoxelWorldManifest;
  files?: Array<{ name: string; etag: string | null }>;
  error?: { message: string };
}

/** A change the backend applied to a world: a command's answer, or the editor feed's `voxelsChanged`. */
export interface WorldChange {
  readonly revision: number;
  readonly chunks: ReadonlyArray<readonly [number, number, number]>;
  readonly box: CellBox;
  readonly parts: number;
  readonly files: ReadonlyArray<{ readonly name: string; readonly etag: string | null }>;
}

export interface RangeWorldOptions {
  /** The world's route (manifest and file list); its region files are under `<url>/regions/<file>`. */
  readonly url: string;
  /** Sent with every request (the editor's token; none on Play's locator). */
  readonly headers?: Readonly<Record<string, string>>;
  /** The voxel worker script. */
  readonly workerUrl: string;
  /** Derive workers (default {@link defaultVoxelWorkers}). */
  readonly workers?: number;
  /** The workers' name (dev tools). */
  readonly workerName?: string;
  readonly stats?: RangeReadStats;
}

async function readInfo(url: string, headers: Readonly<Record<string, string>>): Promise<{ manifest: VoxelWorldManifest; files: NonNullable<WorldInfo['files']> }> {
  const res = await fetch(url, { headers });
  const info = (await res.json()) as WorldInfo;
  if (!info.ok || info.manifest === undefined) throw new Error(info.error?.message ?? `HTTP ${res.status}`);
  return { manifest: info.manifest, files: info.files ?? [] };
}

export class RangeWorld {
  readonly grid: ChunkGrid;
  readonly worldId: Uint8Array;
  readonly source: RegionChunkSource;
  readonly pool: WorkerPool;
  /** The listed region files and their tags (null: listed but unreadable, so its chunks are damaged). */
  readonly files = new Map<string, string | null>();
  revision: number;

  private constructor(
    private readonly o: RangeWorldOptions,
    readonly manifest: VoxelWorldManifest,
    files: ReadonlyArray<{ name: string; etag: string | null }>,
  ) {
    for (const f of files) this.files.set(f.name, f.etag);
    this.revision = manifest.revision;
    this.grid = chunkGrid(manifest.edge as ChunkEdge);
    this.worldId = hexToBytes(manifest.worldId);
    const headers = o.headers ?? {};
    const open = (name: string): ReturnType<typeof rangeByteSource> | null => (this.files.has(name) ? rangeByteSource(`${o.url}/regions/${encodeURIComponent(name)}`, headers, o.stats) : null);
    this.source = new RegionChunkSource({ worldId: this.worldId, gridId: WORLD_GRID_ID, grid: this.grid, layout: manifest.layout, footprint: manifest.footprint, open, maxOpen: OPEN_REGION_FILES });
    const options: WorkerOptions = { type: 'module', ...(o.workerName !== undefined ? { name: o.workerName } : {}) };
    this.pool = new WorkerPool({ size: o.workers ?? defaultVoxelWorkers(), create: () => eventTargetWorker(new Worker(o.workerUrl, options)), ...STREAM_POOL_SETTINGS });
  }

  static async open(o: RangeWorldOptions): Promise<RangeWorld> {
    const { manifest, files } = await readInfo(o.url, o.headers ?? {});
    return new RangeWorld(o, manifest, files);
  }

  /**
   * The files a change rewrote take their new tags (a file gone holds only
   * air) and the chunks it names are read again; returns the streamer's
   * edit group (the swap that shows the change names it).
   */
  applyChange(streamer: VoxelStreamer, c: WorldChange): number {
    this.revision = c.revision;
    for (const f of c.files) {
      if (f.etag === null) this.files.delete(f.name);
      else this.files.set(f.name, f.etag);
    }
    return streamer.refresh(c.chunks.map(([cx, cy, cz]) => ({ cx, cy, cz })), c.box, c.parts);
  }

  /**
   * Reads the manifest and every resident chunk again, after the world's
   * files changed in a way no change described: the chunks keep their old
   * content until the new lands, then everything is derived again. Null
   * when read again; else why not (another world in the folder needs a
   * fresh open).
   */
  async readAgain(streamer: VoxelStreamer, resident: Iterable<ChunkCoord>): Promise<string | null> {
    let now: Awaited<ReturnType<typeof readInfo>>;
    try {
      now = await readInfo(this.o.url, this.o.headers ?? {});
    } catch (e) {
      return `the world could not be read again: ${e instanceof Error ? e.message : String(e)}`;
    }
    const m = this.manifest;
    if (now.manifest.worldId !== m.worldId || now.manifest.edge !== m.edge || now.manifest.layout !== m.layout || now.manifest.footprint !== m.footprint) return 'another world is in this folder now';
    this.files.clear();
    for (const f of now.files) this.files.set(f.name, f.etag);
    this.revision = now.manifest.revision;
    streamer.refresh([...resident]);
    return null;
  }
}
