/**
 * The structure grids of a world the Scene view streams (scene-voxels-worker.ts): each grid a structure object of
 * the open scenes places is read by range from its own region files, streamed, derived and meshed in its world's pool
 * under the world's job ids, and its draws sent under its draw name with where it stands, so the page draws it with
 * its world's surface and piece batches as Play does.
 *
 * Everything a grid streams is in its own frame: the view's focus is moved into it ({@link GridFrame}). A grid
 * whose object moved or turned gets its new frame (the page moves the draws itself, at once); its streamer hears of
 * the focus again only once the focus has moved a share of its gap to the grid, as in Play (a grid 100 m off plans
 * every few metres, not every cell), so a town's grids cost nothing while the view stands still or looks elsewhere.
 *
 * A change the backend applied to a grid (a structure made, regenerated, edited by hand, copied; an undo or redo of
 * one) names the grid's chunks: only those are read and derived again. A change reaching past the box the grid
 * streams round (a taller house) opens the grid again round its new chunks.
 */
import { ChunkDrawBatcher, GRID_EXTENT_MARGIN_CHUNKS, GridFrame, gridDrawName, grownChunkBox, streamerWalkSource, VOXEL_SIZE_M, worldStreamer, type CellBox, type GridWalk, type ChunkBox, type ChunkDrawBatch, type DirtyTracker, type GridPlacement, type PieceTable, type VoxelStreamer } from '@thirdlight/voxel';
import type { RangeWorld } from './range-world';
import type { SceneVoxelsIn } from './scene-voxels-wire';

type OpenMessage = Extract<SceneVoxelsIn, { t: 'open' }>;

/** How far the focus moves, as a share of its gap to a grid's box, before that grid's streamer is told (Play's share). */
const REFOCUS_SHARE = 1 / 8;

export class SceneGridStream {
  readonly name: string;
  readonly streamer: VoxelStreamer;
  readonly batcher: ChunkDrawBatcher;
  private frame: GridFrame;
  /** The chunks the grid's files held when opened, and the box its streamer reads (metres in its frame). */
  readonly extent: ChunkBox;
  private readonly box: { readonly min: readonly number[]; readonly max: readonly number[] };
  /** The focus last told (cells in the grid's frame; null: never). */
  private told: readonly number[] | null = null;
  closed = false;
  /** Everything round the focus is streamed and drawn (until the next focus move or change). */
  settled = false;
  private kick: (() => void) | null = null;
  /** The walk through its cells (its own frame), for picks. */
  private readonly walkSource;

  constructor(
    world: RangeWorld,
    worldName: string,
    place: GridPlacement,
    source: Parameters<typeof worldStreamer>[0]['source'],
    extent: ChunkBox,
    m: OpenMessage,
    shared: { readonly tracker: DirtyTracker; readonly pieces: PieceTable },
    post: (b: ChunkDrawBatch) => void,
    private readonly onSettled: () => void,
  ) {
    this.name = gridDrawName(worldName, place.gridId);
    this.frame = new GridFrame(place);
    this.extent = extent;
    const read = grownChunkBox(extent, GRID_EXTENT_MARGIN_CHUNKS);
    const cm = world.grid.edge * VOXEL_SIZE_M;
    this.box = { min: read.min.map((v) => v * cm), max: read.max.map((v) => (v + 1) * cm) };
    this.streamer = worldStreamer({ grid: world.grid, source, pool: world.pool, gridId: place.gridId, tracker: shared.tracker, extent: read, pieces: shared.pieces, fineBricks: false }, m);
    this.batcher = new ChunkDrawBatcher(this.name, this.streamer, m.sectionEdge, post, { place: { world: worldName, grid: place.gridId, position: place.position, yawRad: place.yawRad } });
    this.walkSource = streamerWalkSource(this.streamer, null);
    void this.loop();
  }

  /** The grid as a ray walks it: its frame, its cells, the box of the chunks it holds (grid metres). */
  walk(): GridWalk {
    const cm = this.streamer.grid.edge * VOXEL_SIZE_M;
    const e = this.extent;
    return { frame: this.frame, source: this.walkSource, box: { lo: [e.min[0] * cm, e.min[1] * cm, e.min[2] * cm], hi: [(e.max[0] + 1) * cm, (e.max[1] + 1) * cm, (e.max[2] + 1) * cm] } };
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      try {
        await this.streamer.settle();
      } catch {
        // A read or derive that failed leaves its chunk as it was; the next focus or change tries again.
      }
      if (this.closed) return;
      this.settled = true;
      this.onSettled();
      await new Promise<void>((ok) => (this.kick = ok));
      this.settled = false;
    }
  }

  private wake(): void {
    const k = this.kick;
    this.kick = null;
    k?.();
  }

  /** Whether `chunks` lie within the box its streamer reads less a chunk (a change past it opens the grid again). */
  covers(chunks: ReadonlyArray<readonly [number, number, number]>): boolean {
    const e = grownChunkBox(this.extent, GRID_EXTENT_MARGIN_CHUNKS - 1);
    return chunks.every((c) => c.every((v, a) => v >= e.min[a]! && v <= e.max[a]!));
  }

  /** The object moved or turned: the focus is moved into its new frame (the page has moved the draws). */
  place(p: GridPlacement): void {
    if (p.position.every((v, a) => v === this.frame.position[a]) && p.yawRad === this.frame.yawRad) return;
    this.frame = new GridFrame(p);
    this.told = null;
  }

  /** Where the view looks (world metres): told to the grid's streamer once it moved its share of the gap. */
  focus(x: number, y: number, z: number): void {
    const g = this.frame.toGrid(x, y, z);
    const gap = Math.hypot(...[0, 1, 2].map((a) => Math.max(0, this.box.min[a]! - g[a]!, g[a]! - this.box.max[a]!)));
    const f = g.map((v) => v / VOXEL_SIZE_M);
    const share = Math.max(1, (gap / VOXEL_SIZE_M) * REFOCUS_SHARE);
    const t = this.told;
    if (t !== null && f.every((v, a) => Math.abs(v - t[a]!) < share)) return;
    this.told = f;
    this.streamer.setFocus(Math.floor(f[0]!), Math.floor(f[1]!), Math.floor(f[2]!));
    this.wake();
  }

  /** A change the backend applied to the grid's chunks: they are read again, only what they reach derived again. */
  changed(chunks: ReadonlyArray<readonly [number, number, number]>, parts: number, materialSwaps: readonly number[] | undefined): void {
    if (chunks.length === 0) return;
    const e = this.streamer.grid.edge;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const c of chunks) for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, c[a]! * e);
      max[a] = Math.max(max[a]!, c[a]! * e + e - 1);
    }
    const box: CellBox = { minX: min[0]!, minY: min[1]!, minZ: min[2]!, maxX: max[0]!, maxY: max[1]!, maxZ: max[2]! };
    this.streamer.refresh(chunks.map(([cx, cy, cz]) => ({ cx, cy, cz })), box, parts, materialSwaps);
    this.wake();
  }

  /** The piece table of the project's kits from now on (what it changes derives again). */
  setPieces(table: PieceTable): void {
    this.streamer.pieces.set(table);
    this.wake();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.batcher.close();
    this.wake();
  }
}

