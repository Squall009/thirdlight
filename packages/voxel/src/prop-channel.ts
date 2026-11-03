/**
 * The prop lighting channel of a streamed world: each resident chunk's
 * coverage bytes from the props over it (prop-coverage.ts), kept while the
 * chunk is resident and counted against the stream budget as the chunk's
 * {@link PROP_COVERAGE_PART}.
 *
 * Built from the prop list only, so it is never saved and never written to
 * a file: a chunk's channel is built when the chunk loads, and a prop's
 * place, move or removal rebuilds only the resident chunks its old and new
 * bounds touch. Every build covers the chunk's props in the order they were
 * first placed, so a rebuilt chunk equals a fresh build of the same list.
 */
import { chunkInWorld, chunkKey, chunkKeyOrNone, chunkOfKey, type ChunkGrid } from './coords';
import { propBounds, propCoverageChunk, type PropShape } from './prop-coverage';
import { SampleRing } from './worker-pool';

/** The budget part a chunk's prop channel is counted as. */
export const PROP_COVERAGE_PART = 'propCoverage';

/** What the channel needs of the streamer that holds the chunks. */
export interface PropChannelHost {
  readonly grid: ChunkGrid;
  setPart(cx: number, cy: number, cz: number, part: string, bytes: number): boolean;
}

interface PlacedProp {
  readonly order: number;
  shape: PropShape;
  /** Keys of the chunks its bounds touch (resident or not). */
  chunks: number[];
}

export class PropLightChannel {
  private readonly props = new Map<string, PlacedProp>();
  /** Chunk key → the props whose bounds touch it. */
  private readonly over = new Map<number, Set<PlacedProp>>();
  /** Resident chunks built: key → coverage (null: no prop covers it). */
  private readonly built = new Map<number, Uint8Array | null>();
  private seq = 0;
  /** µs each {@link apply} (a place, move or removal, or a step's together) took, its rebuilt chunks included. */
  readonly changeUs = new SampleRing();
  /** Every chunk build (a load or a prop change), for tests and diagnostics; null: none. */
  onBuild: ((cx: number, cy: number, cz: number) => void) | null = null;

  constructor(
    private readonly host: PropChannelHost,
    /** A cell's edge in metres (a prop's place is in metres from the grid's origin). */
    private readonly cellM: number,
  ) {}

  /** Places a prop, or moves it to a new shape and place: the chunks it left and entered are rebuilt. */
  place(id: string, shape: PropShape): void {
    this.apply([[id, shape]]);
  }

  /** Takes a prop out: the chunks it stood over are rebuilt without it. */
  remove(id: string): void {
    this.apply([[id, null]]);
  }

  /**
   * Places, moves (a shape) and removes (null) props together: every chunk
   * any of them left or entered is rebuilt once, so a scene's props
   * arriving in one step cost one build a chunk, not one a prop.
   */
  apply(changes: Iterable<readonly [string, PropShape | null]>): void {
    const t0 = performance.now();
    const touched = new Set<number>();
    for (const [id, shape] of changes) {
      const old = this.props.get(id);
      if (old !== undefined) {
        for (const k of old.chunks) {
          touched.add(k);
          const set = this.over.get(k);
          set?.delete(old);
          if (set?.size === 0) this.over.delete(k);
        }
      }
      if (shape === null) {
        this.props.delete(id);
        continue;
      }
      const p: PlacedProp = old ?? { order: this.seq++, shape, chunks: [] };
      p.shape = shape;
      p.chunks = this.chunksOf(shape);
      for (const k of p.chunks) {
        let set = this.over.get(k);
        if (set === undefined) this.over.set(k, (set = new Set()));
        set.add(p);
        touched.add(k);
      }
      if (old === undefined) this.props.set(id, p);
    }
    this.rebuild(touched);
    this.changeUs.add((performance.now() - t0) * 1000);
  }

  /** A chunk became resident: its channel is built (a chunk already built, refreshed in place, keeps it). */
  loaded(cx: number, cy: number, cz: number): void {
    const key = chunkKey(this.host.grid, cx, cy, cz);
    if (!this.built.has(key)) this.build(key, cx, cy, cz);
  }

  /** A chunk left: its channel goes with it (the streamer drops the chunk's budget parts itself). */
  unloaded(cx: number, cy: number, cz: number): void {
    this.built.delete(chunkKey(this.host.grid, cx, cy, cz));
  }

  /** A resident chunk's coverage bytes (local cell index; null: no prop covers it), undefined when not built. */
  chunk(cx: number, cy: number, cz: number): Uint8Array | null | undefined {
    return this.built.get(chunkKey(this.host.grid, cx, cy, cz));
  }

  /** The prop coverage byte of a cell (world cells; 0 where no prop covers it or its chunk is not built). */
  at(x: number, y: number, z: number): number {
    const g = this.host.grid;
    const c = this.built.get(chunkKeyOrNone(g, x >> g.shift, y >> g.shift, z >> g.shift));
    if (c === undefined || c === null) return 0;
    const m = g.mask;
    return c[((((x & m) << g.shift) | (z & m)) << g.shift) | (y & m)]!;
  }

  /** What the channel holds: chunks built, those with coverage, their bytes, and the props. */
  stats(): { chunks: number; covered: number; bytes: number; props: number } {
    let covered = 0;
    let bytes = 0;
    for (const c of this.built.values()) {
      if (c === null) continue;
      covered++;
      bytes += c.byteLength;
    }
    return { chunks: this.built.size, covered, bytes, props: this.props.size };
  }

  private chunksOf(shape: PropShape): number[] {
    const g = this.host.grid;
    const b = propBounds(shape);
    const lo = b.min.map((m) => Math.floor(m / this.cellM) >> g.shift);
    const hi = b.max.map((m) => Math.floor(m / this.cellM) >> g.shift);
    const out: number[] = [];
    for (let cx = lo[0]!; cx <= hi[0]!; cx++) for (let cy = lo[1]!; cy <= hi[1]!; cy++) for (let cz = lo[2]!; cz <= hi[2]!; cz++) {
      if (chunkInWorld(g, cx, cy, cz)) out.push(chunkKey(g, cx, cy, cz));
    }
    return out;
  }

  private rebuild(keys: ReadonlySet<number>): void {
    const c = { cx: 0, cy: 0, cz: 0 };
    // Only chunks built (resident) are rebuilt; the others are built when they load.
    for (const key of keys) {
      if (!this.built.has(key)) continue;
      chunkOfKey(this.host.grid, key, c);
      this.build(key, c.cx, c.cy, c.cz);
    }
  }

  private build(key: number, cx: number, cy: number, cz: number): void {
    const props = this.over.get(key);
    const list = props === undefined ? [] : [...props].sort((a, b) => a.order - b.order).map((p) => p.shape);
    const out = list.length === 0 ? null : propCoverageChunk(this.host.grid, cx, cy, cz, list, this.cellM);
    this.built.set(key, out);
    this.host.setPart(cx, cy, cz, PROP_COVERAGE_PART, out?.byteLength ?? 0);
    this.onBuild?.(cx, cy, cz);
  }
}
