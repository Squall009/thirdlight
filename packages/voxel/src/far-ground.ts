/**
 * A coarse floor everywhere: the ground's height from the far cache's
 * finest kept level (2 m cells), what the far field already draws there, as
 * a fallback collision surface where a body's fine collision is late. Nothing
 * falls through or hangs in the air while the fine ground is on its way, and
 * the fine surface replaces it once its column is settled.
 *
 * - **Data.** A far node column's nodes at the floor's level (the cache's
 *   index lists those holding anything) are read as stored and decoded in a
 *   worker (`far-ground` job, {@link farGroundTops}) into the top solid
 *   surface of each of its 2 m cell columns: its cell's fill read as height,
 *   in metres; NaN where a column holds no solid cell. A cave or an overhang
 *   is under that top: a body below it is not given the floor (the host
 *   compares heights, {@link FarGround.floorAt}).
 * - **The surface.** A storage chunk column's floor is a heightfield of the
 *   coarse cells over it: each lattice corner the highest top of the four
 *   coarse cells round it, so the floor lies on or above the coarse ground
 *   and the same corner reads the same from either chunk (no seam). A body
 *   on it drops a little when the fine ground (lower) replaces it, and one
 *   left inside fine ground that lies higher is lifted by its host.
 * - **Memory.** The tops of a node column are 4 KiB; at most
 *   {@link FAR_GROUND_CACHE_BYTES} are kept, least recently used dropped
 *   first (read again when wanted).
 */
import { decodeDenseChunk } from './cell-delta';
import { chunkGrid, VOXEL_SIZE_M, type ChunkCoord, type ChunkEdge, type ChunkGrid } from './coords';
import { createDenseChunk } from './dense-chunk';
import type { FarNodeSource } from './far-field';
import type { FarNodeIndex } from './far-tree';
import { fillLevel, ROLE_MASK, SHAPE_FULL, VOXEL_ROLE } from './record';
import { regionChunkCodecBytes, type RegionChunkRead } from './region-file';
import type { StoredChunk } from './stream-job';
import type { WorkerPool } from './worker-pool';

/** The far cache level the floor is made of: its finest kept level (2 m cells), what the far field draws nearest. */
export const FAR_GROUND_LEVEL = 2;

/** Bytes of node-column tops kept (4 KiB a 64 m column: about 1,000 columns, 64 km² of ground). */
export const FAR_GROUND_CACHE_BYTES = 4 * 1024 * 1024;

/** A node column's nodes as stored, for a `far-ground` job. */
export interface FarGroundInput {
  readonly edge: ChunkEdge;
  readonly level: number;
  readonly nodes: ReadonlyArray<{ readonly ny: number; readonly bytes: StoredChunk }>;
}

/** A `far-ground` job's answer: each cell column's top (metres; NaN: no solid), x-major (`x · edge + z`). */
export interface FarGroundOutput {
  readonly tops: Float32Array;
}

/** Whether a role stands as ground for a body (liquids do not). */
const standsOn = (role: number): boolean => (role & ROLE_MASK) !== VOXEL_ROLE.liquid;

/**
 * Each cell column's top solid surface (metres) over a far node column's nodes: the highest node first, the cell's
 * fill read as height. The worker's half of the floor; the same function runs in tests.
 */
export function farGroundTops(input: FarGroundInput, decompress: (b: Uint8Array) => Uint8Array): FarGroundOutput {
  const g = chunkGrid(input.edge);
  const e = g.edge;
  const cellM = VOXEL_SIZE_M * 2 ** input.level;
  const tops = new Float32Array(e * e).fill(Number.NaN);
  let left = e * e;
  const d = createDenseChunk(g);
  const nodes = [...input.nodes].sort((a, b) => b.ny - a.ny);
  for (const n of nodes) {
    if (left === 0) break;
    const b = n.bytes;
    const read: RegionChunkRead = 'uniform' in b ? (b.uniform === 0 ? { cx: 0, cy: n.ny, cz: 0, kind: 'air' } : { cx: 0, cy: n.ny, cz: 0, kind: 'uniform', value: b.uniform }) : { cx: 0, cy: n.ny, cz: 0, kind: 'stored', bytes: b.stored, raw: b.raw };
    const codec = regionChunkCodecBytes(g, read, decompress);
    if (codec === null) continue;
    decodeDenseChunk(g, codec, d);
    for (let x = 0; x < e; x++) for (let z = 0; z < e; z++) {
      const k = x * e + z;
      if (!Number.isNaN(tops[k]!)) continue;
      for (let y = e - 1; y >= 0; y--) {
        const li = ((x * e + z) * e) + y;
        if (d.material[li] === 0 || d.shape[li] === 0 || !standsOn(d.role[li]!)) continue;
        tops[k] = (n.ny * e + y + fillLevel(d.role[li]!, d.shape[li]!) / SHAPE_FULL) * cellM;
        left--;
        break;
      }
    }
  }
  return { tops };
}

/** What the floor reads the far cache and runs its jobs through. */
export interface FarGroundHost {
  readonly source: FarNodeSource;
  /** The far cache's index (null: not read yet). */
  index(): FarNodeIndex | null;
  readonly pool: WorkerPool;
  /** The storage chunk grid. */
  readonly grid: ChunkGrid;
  /** A job id of the pool's id space (the streamer's tracker). */
  jobId(): number;
  poke(): void;
}

interface Column {
  tops: Float32Array | null;
  /** Reading or decoding. */
  busy: boolean;
  used: number;
}

/** A storage chunk column's floor: a heightfield of the coarse cells over it (metres from the column's corner, y absolute). */
export interface FarGroundField {
  /** Coarse cells a side over the chunk column. */
  readonly cells: number;
  readonly cellM: number;
  /** (cells + 1)² heights (metres), x-major: corner (i, k) at i · (cells + 1) + k. */
  readonly heights: Float32Array;
  /** The lowest and highest height. */
  readonly min: number;
  readonly max: number;
}

export class FarGround {
  private readonly columns = new Map<string, Column>();
  private tick = 0;
  private readonly level: number;
  /** The index's nodes at the floor's level by node column (built once an index is known). */
  private byColumn: { readonly index: FarNodeIndex; readonly ny: Map<string, number[]> } | null = null;
  /** Node columns sent to be read and decoded since the floor was made. */
  reads = 0;

  constructor(private readonly host: FarGroundHost) {
    this.level = Math.max(FAR_GROUND_LEVEL, host.source.minLevel);
  }

  /** Bytes of tops kept. */
  get bytes(): number {
    let n = 0;
    for (const c of this.columns.values()) if (c.tops !== null) n += c.tops.byteLength;
    return n;
  }

  /** Storage chunk cells a coarse cell spans along an axis. */
  private get span(): number {
    return 2 ** this.level;
  }

  /**
   * A storage chunk column's floor (null: not known yet, asked for; or a coarse cell under it holds no ground). Its
   * corners need the coarse cells round them, so a chunk column on a node column's edge asks for the neighbour too.
   */
  field(cx: number, cz: number): FarGroundField | null {
    const e = this.host.grid.edge;
    const span = this.span;
    const cells = e / span;
    const cellM = VOXEL_SIZE_M * span;
    const g0x = cx * cells;
    const g0z = cz * cells;
    // The coarse cells from one before the column to one past it: every corner's four neighbours.
    const side = cells + 2;
    const tops = new Float32Array(side * side);
    let missing = false;
    for (let i = 0; i < side; i++) for (let k = 0; k < side; k++) {
      const t = this.topAt(g0x - 1 + i, g0z - 1 + k);
      if (t === undefined) missing = true;
      else tops[i * side + k] = t;
    }
    if (missing) return null;
    const heights = new Float32Array((cells + 1) * (cells + 1));
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i <= cells; i++) for (let k = 0; k <= cells; k++) {
      // Corner (i, k) lies between coarse cells i − 1 and i of the column (tops' i and i + 1): the highest that holds ground.
      let h = -Infinity;
      for (const v of [tops[i * side + k]!, tops[(i + 1) * side + k]!, tops[i * side + k + 1]!, tops[(i + 1) * side + k + 1]!]) if (!Number.isNaN(v) && v > h) h = v;
      if (h === -Infinity) return null;
      heights[i * (cells + 1) + k] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    return { cells, cellM, heights, min, max };
  }

  /**
   * The top (metres) of coarse cell (gx, gz) (global coarse cells), NaN where it holds no ground; undefined while
   * its node column is not known (asked for).
   */
  private topAt(gx: number, gz: number): number | undefined {
    const e = this.host.grid.edge;
    const nx = Math.floor(gx / e);
    const nz = Math.floor(gz / e);
    const col = this.column(nx, nz);
    if (col === null) return undefined;
    return col[(gx - nx * e) * e + (gz - nz * e)]!;
  }

  /** A node column's tops (null: not known yet; asked for). */
  private column(nx: number, nz: number): Float32Array | null {
    const key = `${nx},${nz}`;
    let c = this.columns.get(key);
    if (c === undefined) {
      c = { tops: null, busy: false, used: 0 };
      this.columns.set(key, c);
    }
    c.used = ++this.tick;
    if (c.tops === null && !c.busy) this.read(nx, nz, c);
    return c.tops;
  }

  private read(nx: number, nz: number, c: Column): void {
    const h = this.host;
    const idx = h.index();
    if (idx === null) return;
    if (this.byColumn?.index !== idx) {
      const ny = new Map<string, number[]>();
      for (const n of idx.nodes(this.level)) {
        const k = `${n.nx},${n.nz}`;
        (ny.get(k) ?? ny.set(k, []).get(k)!).push(n.ny);
      }
      this.byColumn = { index: idx, ny };
    }
    const nodes: ChunkCoord[] = (this.byColumn.ny.get(`${nx},${nz}`) ?? []).map((y) => ({ cx: nx, cy: y, cz: nz }));
    if (nodes.length === 0) {
      // No node holds anything: no ground anywhere in the column.
      c.tops = new Float32Array(h.grid.edge * h.grid.edge).fill(Number.NaN);
      return;
    }
    c.busy = true;
    void h.source.read(this.level, nodes).then(
      (reads) => {
        const list: Array<{ ny: number; bytes: StoredChunk }> = [];
        const transfer: ArrayBuffer[] = [];
        for (const r of reads) {
          if (r.kind === 'stored') {
            const stored = r.bytes.slice();
            list.push({ ny: r.cy, bytes: { stored, raw: r.raw } });
            transfer.push(stored.buffer as ArrayBuffer);
          } else if (r.kind === 'uniform') list.push({ ny: r.cy, bytes: { uniform: r.value } });
        }
        const input: FarGroundInput = { edge: h.grid.edge as ChunkEdge, level: this.level, nodes: list };
        this.reads++;
        return h.pool.submit<FarGroundOutput>({ id: h.jobId(), kind: 'far-ground', lane: 'edit', distance: 0, input, transfer });
      },
      () => null,
    ).then((o) => {
      c.busy = false;
      h.poke();
      if (o === null || o.status !== 'done') return;
      c.tops = (o.output as FarGroundOutput).tops;
      this.trim();
    });
  }

  /** Drops the least recently used columns' tops past {@link FAR_GROUND_CACHE_BYTES}. */
  private trim(): void {
    if (this.bytes <= FAR_GROUND_CACHE_BYTES) return;
    const done = [...this.columns.entries()].filter(([, c]) => c.tops !== null && !c.busy).sort((a, b) => a[1].used - b[1].used);
    let bytes = this.bytes;
    for (const [key, c] of done) {
      if (bytes <= FAR_GROUND_CACHE_BYTES) break;
      bytes -= c.tops!.byteLength;
      this.columns.delete(key);
    }
  }
}
