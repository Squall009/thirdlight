/**
 * The prop lighting channel of a streamed world: each resident chunk's
 * coverage bytes from the props over it (prop-coverage.ts), kept while the
 * chunk is resident and counted against the stream budget as the chunk's
 * {@link PROP_COVERAGE_PART}.
 *
 * Built from the prop list only, so it is never saved and never written to
 * a file. Each prop is sampled once into its own cells where it stands
 * (`propCoverageLocal`), kept with it while it stays there, and a chunk's
 * bytes are its props' coverages combined in the order they were first
 * placed, so a chunk equals a fresh sampling of the same list cell for cell.
 * A chunk that loads is combined at once from the props already sampled; a
 * place, move or removal recombines only the box of cells the prop left and
 * entered, in the resident chunks it touches.
 *
 * Sampling is the cost (64 inside tests a cell, about a millisecond for a
 * 6 m canopy), so it is spread: `apply` only records what changed, and
 * `update` samples and recombines one prop at a time while its caller's
 * slice lasts (the simulation's derive slice), so a scene's props arriving
 * in one step take many steps, none much over the slice. A prop is sampled
 * only while a chunk it touches is resident. Readers learn which chunks'
 * bytes changed through `listen` (the walk's light stop reads them).
 */
import { chunkInWorld, chunkKey, chunkKeyOrNone, chunkOfKey, type ChunkGrid } from './coords';
import { combineCoverage, propBounds, propCoverageLocal, type PropLocalCoverage, type PropShape } from './prop-coverage';
import { SampleRing } from './worker-pool';

/** The budget part a chunk's prop channel is counted as. */
export const PROP_COVERAGE_PART = 'propCoverage';

/** What the channel needs of the streamer that holds the chunks. */
export interface PropChannelHost {
  readonly grid: ChunkGrid;
  setPart(cx: number, cy: number, cz: number, part: string, bytes: number): boolean;
}

interface PlacedProp {
  readonly id: string;
  readonly order: number;
  shape: PropShape;
  /** Keys of the chunks its bounds touch (resident or not). */
  chunks: number[];
  /** Its coverage sampled where it stands now (null: not sampled there yet, or no chunk it touches is resident). */
  cover: PropLocalCoverage | null;
}

/** What a prop's stamp waiting to be done replaces: the cells and chunks it covered when the chunks last saw it. */
interface Was {
  readonly cover: PropLocalCoverage | null;
  readonly chunks: readonly number[];
}

/** A box of world cells, inclusive low, exclusive high. */
type Box = [number, number, number, number, number, number];

export class PropLightChannel {
  private readonly props = new Map<string, PlacedProp>();
  /** Chunk key → the props whose bounds touch it. */
  private readonly over = new Map<number, Set<PlacedProp>>();
  /** Resident chunks built: key → coverage (null: no prop covers it). */
  private readonly built = new Map<number, Uint8Array | null>();
  /** A built chunk's cells holding coverage (so a chunk whose last covered cell goes is null again). */
  private readonly covered = new Map<number, number>();
  /** Props whose stamp waits (by id, in order of change), with what the chunks last saw of each. */
  private readonly stamps = new Map<string, Was>();
  private readonly listeners: ((cx: number, cy: number, cz: number) => void)[] = [];
  private scratch = new Uint8Array(0);
  private sampledBytes = 0;
  private seq = 0;
  /** µs each prop's stamp took (its sampling and the cells it left and entered recombined). */
  readonly changeUs = new SampleRing();
  /** Every chunk built or recombined (a load or a prop change), for tests and diagnostics; null: none. */
  onBuild: ((cx: number, cy: number, cz: number) => void) | null = null;

  constructor(
    private readonly host: PropChannelHost,
    /** A cell's edge in metres (a prop's place is in metres from the grid's origin). */
    private readonly cellM: number,
  ) {}

  /** Places a prop, or moves it to a new shape and place, and stamps it now. */
  place(id: string, shape: PropShape): void {
    this.apply([[id, shape]]);
    this.flush();
  }

  /** Takes a prop out now: the cells it covered are recombined without it. */
  remove(id: string): void {
    this.apply([[id, null]]);
    this.flush();
  }

  /**
   * Places, moves (a shape) and removes (null) props: recorded at once (a chunk loading from now on sees each where it
   * now is), stamped by {@link update} or {@link flush}. A prop changed again before its stamp is stamped once.
   */
  apply(changes: Iterable<readonly [string, PropShape | null]>): void {
    for (const [id, shape] of changes) {
      const old = this.props.get(id);
      if (old !== undefined) {
        if (!this.stamps.has(id)) this.stamps.set(id, { cover: old.cover, chunks: old.chunks });
        this.dropCover(old);
        for (const k of old.chunks) {
          const set = this.over.get(k);
          set?.delete(old);
          if (set?.size === 0) this.over.delete(k);
        }
      }
      if (shape === null) {
        this.props.delete(id);
        continue;
      }
      const p: PlacedProp = old ?? { id, order: this.seq++, shape, chunks: [], cover: null };
      p.shape = shape;
      p.chunks = this.chunksOf(shape);
      for (const k of p.chunks) {
        let set = this.over.get(k);
        if (set === undefined) this.over.set(k, (set = new Set()));
        set.add(p);
      }
      if (old === undefined) this.props.set(id, p);
      if (!this.stamps.has(id) && this.touchesBuilt(p.chunks)) this.stamps.set(id, { cover: null, chunks: [] });
    }
  }

  /** Whether stamps wait. */
  get pending(): boolean {
    return this.stamps.size > 0;
  }

  /** Stamps waiting props in order while `more()` says so (one at least): each sampled where it stands and its cells recombined. */
  update(more: () => boolean = () => true): void {
    let n = 0;
    for (const [id, was] of this.stamps) {
      if (n++ > 0 && !more()) break;
      this.stamps.delete(id);
      this.stamp(id, was);
    }
  }

  /** Every waiting stamp, now. */
  flush(): void {
    this.update();
  }

  /** `fn` hears of every resident chunk whose bytes changed (cell coordinates of the chunk). */
  listen(fn: (cx: number, cy: number, cz: number) => void): void {
    this.listeners.push(fn);
  }

  /** A chunk became resident: its channel is combined from the props sampled; those over it not yet sampled wait for their stamps. */
  loaded(cx: number, cy: number, cz: number): void {
    const key = chunkKey(this.host.grid, cx, cy, cz);
    if (this.built.has(key)) return;
    this.built.set(key, null);
    this.covered.set(key, 0);
    const props = this.over.get(key);
    if (props !== undefined) for (const p of props) if (p.cover === null && !this.stamps.has(p.id)) this.stamps.set(p.id, { cover: null, chunks: [] });
    const e = this.host.grid.edge;
    const x0 = cx << this.host.grid.shift;
    const y0 = cy << this.host.grid.shift;
    const z0 = cz << this.host.grid.shift;
    this.recombine(key, cx, cy, cz, [x0, y0, z0, x0 + e, y0 + e, z0 + e]);
  }

  /** A chunk left: its channel goes with it (the streamer drops the chunk's budget parts itself); props over no resident chunk let their samples go. */
  unloaded(cx: number, cy: number, cz: number): void {
    const key = chunkKey(this.host.grid, cx, cy, cz);
    if (!this.built.delete(key)) return;
    this.covered.delete(key);
    const props = this.over.get(key);
    if (props !== undefined) for (const p of props) if (p.cover !== null && !this.touchesBuilt(p.chunks)) this.dropCover(p);
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

  /** What the channel holds: chunks built, those with coverage, their bytes, the props, the bytes of their samples and the stamps waiting. */
  stats(): { chunks: number; covered: number; bytes: number; props: number; sampledBytes: number; pending: number } {
    let covered = 0;
    let bytes = 0;
    for (const c of this.built.values()) {
      if (c === null) continue;
      covered++;
      bytes += c.byteLength;
    }
    return { chunks: this.built.size, covered, bytes, props: this.props.size, sampledBytes: this.sampledBytes, pending: this.stamps.size };
  }

  private dropCover(p: PlacedProp): void {
    if (p.cover !== null) this.sampledBytes -= p.cover.bytes.byteLength;
    p.cover = null;
  }

  private touchesBuilt(chunks: readonly number[]): boolean {
    for (const k of chunks) if (this.built.has(k)) return true;
    return false;
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

  /** One prop's stamp: sampled where it now stands (while a chunk it touches is resident), then the cells it left and entered recombined. */
  private stamp(id: string, was: Was): void {
    const t0 = performance.now();
    const p = this.props.get(id);
    if (p !== undefined && p.cover === null && this.touchesBuilt(p.chunks)) {
      p.cover = propCoverageLocal(p.shape, this.cellM);
      this.sampledBytes += p.cover.bytes.byteLength;
    }
    const boxes = [was.cover, p?.cover ?? null].filter((c): c is PropLocalCoverage => c !== null && c.cells > 0);
    if (boxes.length > 0) {
      const g = this.host.grid;
      const c = { cx: 0, cy: 0, cz: 0 };
      for (const key of new Set([...was.chunks, ...(p?.chunks ?? [])])) {
        if (!this.built.has(key)) continue;
        chunkOfKey(g, key, c);
        const x0 = c.cx << g.shift;
        const y0 = c.cy << g.shift;
        const z0 = c.cz << g.shift;
        const e = g.edge;
        // The union of the boxes it left and entered, within the chunk.
        const box: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (const b of boxes) for (let a = 0; a < 3; a++) {
          box[a] = Math.min(box[a]!, b.lo[a]!);
          box[a + 3] = Math.max(box[a + 3]!, b.lo[a]! + b.size[a]!);
        }
        const clip: Box = [Math.max(box[0], x0), Math.max(box[1], y0), Math.max(box[2], z0), Math.min(box[3], x0 + e), Math.min(box[4], y0 + e), Math.min(box[5], z0 + e)];
        if (clip[0] < clip[3] && clip[1] < clip[4] && clip[2] < clip[5]) this.recombine(key, c.cx, c.cy, c.cz, clip);
      }
    }
    this.changeUs.add((performance.now() - t0) * 1000);
  }

  /**
   * A box of a built chunk's cells (world cells) combined again from the sampled props over the chunk, in the order
   * they were placed: the fold every cell of a fresh sampling makes. Listeners hear of it when a byte changed.
   */
  private recombine(key: number, cx: number, cy: number, cz: number, box: Box): void {
    const g = this.host.grid;
    const sh = g.shift;
    const x0 = cx << sh;
    const y0 = cy << sh;
    const z0 = cz << sh;
    let out = this.built.get(key) ?? null;
    const sy = box[4] - box[1];
    const cells = (box[3] - box[0]) * (box[5] - box[2]) * sy;
    if (this.scratch.length < cells) this.scratch = new Uint8Array(cells);
    // The box as it was (to tell whether anything changed, and how many covered cells it held), then cleared.
    let before = 0;
    if (out !== null) {
      let k = 0;
      for (let x = box[0]; x < box[3]; x++) for (let z = box[2]; z < box[5]; z++) {
        const row = ((((x - x0) << sh) | (z - z0)) << sh) - y0;
        for (let y = box[1]; y < box[4]; y++, k++) {
          const v = out[row + y]!;
          this.scratch[k] = v;
          if (v !== 0) before++;
          out[row + y] = 0;
        }
      }
    }
    const list = [...(this.over.get(key) ?? [])].filter((p) => p.cover !== null && p.cover.cells > 0).sort((a, b) => a.order - b.order);
    for (const p of list) {
      const cv = p.cover!;
      const lx = Math.max(box[0], cv.lo[0]);
      const ly = Math.max(box[1], cv.lo[1]);
      const lz = Math.max(box[2], cv.lo[2]);
      const hx = Math.min(box[3], cv.lo[0] + cv.size[0]);
      const hy = Math.min(box[4], cv.lo[1] + cv.size[1]);
      const hz = Math.min(box[5], cv.lo[2] + cv.size[2]);
      if (lx >= hx || ly >= hy || lz >= hz) continue;
      for (let x = lx; x < hx; x++) for (let z = lz; z < hz; z++) {
        const src = ((x - cv.lo[0]) * cv.size[2] + (z - cv.lo[2])) * cv.size[1] - cv.lo[1];
        const row = ((((x - x0) << sh) | (z - z0)) << sh) - y0;
        for (let y = ly; y < hy; y++) {
          const b = cv.bytes[src + y]!;
          if (b === 0) continue;
          out ??= new Uint8Array(g.cellsPerChunk);
          out[row + y] = combineCoverage(out[row + y]!, b);
        }
      }
    }
    let after = 0;
    let changed = false;
    if (out !== null) {
      let k = 0;
      for (let x = box[0]; x < box[3]; x++) for (let z = box[2]; z < box[5]; z++) {
        const row = ((((x - x0) << sh) | (z - z0)) << sh) - y0;
        for (let y = box[1]; y < box[4]; y++, k++) {
          const v = out[row + y]!;
          if (v !== 0) after++;
          if (v !== (before > 0 ? this.scratch[k]! : 0)) changed = true;
        }
      }
    }
    const count = (this.covered.get(key) ?? 0) - before + after;
    this.covered.set(key, count);
    if (count === 0) out = null;
    this.built.set(key, out);
    // Every build lands as the chunk's budget part (the streamer keeps the last).
    this.host.setPart(cx, cy, cz, PROP_COVERAGE_PART, out?.byteLength ?? 0);
    this.onBuild?.(cx, cy, cz);
    if (changed) for (const fn of this.listeners) fn(cx, cy, cz);
  }
}
