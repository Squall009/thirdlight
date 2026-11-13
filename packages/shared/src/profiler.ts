/**
 * The frame profiler's spans: named stretches of a thread's frame, kept for
 * the last {@link PROFILE_FRAMES} frames of each thread (the page, the
 * simulation worker, the voxel job workers) so a panel can show what every
 * thread did in a frame, and a budget table can compare each category's use
 * with what the tier allows.
 *
 * Built to be left on: one recorder per thread keeps everything in
 * preallocated typed arrays (a span is two clock reads and a few stores, no
 * object), and nothing is turned into objects until something reads it. A
 * worker hands its closed frames over packed in one Float64Array
 * ({@link SpanRecorder.pack}), which the page's recorder for that lane takes
 * in as they are ({@link SpanRecorder.ingest}).
 *
 * Spans nest (`begin` / `end`): a span's own time (`selfMs`) leaves out what
 * ran inside it, and the categories sum own time, so a frame's category sums
 * never count a stretch twice. Times are on the shared wall clock
 * (`wallClock`), so spans of two threads line up.
 *
 * A thread's frames past the ring are overwritten; spans past
 * {@link PROFILE_SPANS_PER_FRAME} in one frame are counted (`dropped`) but
 * still added to the category sums.
 */
import { wallClock } from './clock';

/**
 * What a span's time is spent on: the frame budget table's rows. The owner's
 * list (items and props, characters, GPU particle effects, lighting, game
 * logic, path finding and everything else on the main thread), with the
 * voxel world's three stages apart because they are budgeted apart.
 */
export const SPAN_CATEGORIES = [
  /** The scene's sync, culling and draw submission. */
  'render',
  /** Voxel streaming: what to load, plan and select, near and far. */
  'voxelStream',
  /** Voxel decoding, deriving and meshing (job workers). */
  'voxelMesh',
  /** Voxel results made into draws and uploaded on the page. */
  'voxelApply',
  /** Props and items: models, their levels of detail, batches, decals. */
  'props',
  /** Characters and animation. */
  'characters',
  /** Effects and particles. */
  'effects',
  /** Lights, shadows, probes and the surface cache. */
  'lighting',
  /** Game logic: the scripts and their timers. */
  'scripts',
  'physics',
  'pathfinding',
  'audio',
  'ui',
  'other',
] as const;
export type SpanCategory = (typeof SPAN_CATEGORIES)[number];

/** The threads a profile has spans of (the GPU's lane is pass shares, not spans). */
export const PROFILER_THREADS = ['page', 'sim', 'jobs'] as const;
export type ProfilerThread = (typeof PROFILER_THREADS)[number];

/** Frames a thread's ring keeps: four seconds at 30 Hz, two at 60. */
export const PROFILE_FRAMES = 120;
/** Spans a frame keeps; more are counted and summed, not kept. */
export const PROFILE_SPANS_PER_FRAME = 128;
/** How deep spans nest (deeper ones are timed as their parent's). */
const MAX_DEPTH = 8;
/** Numbers a packed span takes: name, start, ms, self ms, depth, lane. */
const SPAN_WORDS = 6;
/** Numbers a packed frame's head takes before its sums and spans: id, start, end, tick, spans, dropped. */
const FRAME_HEAD = 6;
const CATEGORIES = SPAN_CATEGORIES.length;
const CATEGORY_INDEX: Readonly<Record<SpanCategory, number>> = Object.freeze(Object.fromEntries(SPAN_CATEGORIES.map((c, i) => [c, i])) as Record<SpanCategory, number>);

/** One span as a reader gets it (plain data). */
export interface ProfileSpan {
  readonly name: string;
  readonly category: SpanCategory;
  /** Wall-clock ms (`wallClock`). */
  readonly start: number;
  readonly ms: number;
  /** `ms` without the spans that ran inside it. */
  readonly selfMs: number;
  readonly depth: number;
  /** The job worker it ran on (job spans only). */
  readonly lane?: number;
}

/** One frame of one thread as a reader gets it (plain data). */
export interface ProfileFrame {
  readonly thread: ProfilerThread;
  /** The recording thread's own frame count. */
  readonly frame: number;
  /** The simulation tick the frame sent or ran (absent: none). */
  readonly tick?: number;
  readonly start: number;
  readonly ms: number;
  /** Own ms by category (categories with none left out). */
  readonly byCategory: Readonly<Partial<Record<SpanCategory, number>>>;
  readonly spans: readonly ProfileSpan[];
  /** Spans that did not fit (their time is in `byCategory`). */
  readonly dropped: number;
}

/** A thread's closed frames since its last pack, and the span names it registered since then. */
export interface PackedProfile {
  /** Names added since the last pack, in id order from `firstName`. */
  readonly names: readonly (readonly [string, SpanCategory])[];
  readonly firstName: number;
  readonly data: Float64Array;
}

/** A span name once registered (an index: recording passes it, not the string). */
export type SpanId = number;

/** Job spans are kept beside the thread's own, under this lane offset (lane = worker index). */
const NO_LANE = -1;

export class SpanRecorder {
  private readonly names: string[] = [];
  private readonly cats: number[] = [];
  private readonly byName = new Map<string, SpanId>();
  // Spans: frames × spans per frame.
  private readonly sName: Uint16Array;
  private readonly sStart: Float64Array;
  private readonly sMs: Float32Array;
  private readonly sSelf: Float32Array;
  private readonly sDepth: Uint8Array;
  private readonly sLane: Int16Array;
  // Frames.
  private readonly fId: Float64Array;
  private readonly fStart: Float64Array;
  private readonly fEnd: Float64Array;
  private readonly fTick: Float64Array;
  private readonly fCount: Uint16Array;
  private readonly fDropped: Uint32Array;
  /** Own ms by category, and the job workers' (two rows a frame). */
  private readonly fSums: Float64Array;
  // The open frame.
  private open = false;
  private slot = 0;
  private frameSeq = 0;
  /** Frames closed so far (the ring holds the last `frames` of them). */
  private closed = 0;
  private packedUpTo = 0;
  private namesPacked = 0;
  // The nesting stack.
  private readonly stackId = new Int32Array(MAX_DEPTH);
  private readonly stackStart = new Float64Array(MAX_DEPTH);
  private readonly stackChild = new Float64Array(MAX_DEPTH);
  private depth = 0;
  /** Begins past `MAX_DEPTH`, ended without a record. */
  private overflow = 0;

  constructor(
    public thread: ProfilerThread,
    readonly frames: number = PROFILE_FRAMES,
    readonly spansPerFrame: number = PROFILE_SPANS_PER_FRAME,
  ) {
    const n = frames * spansPerFrame;
    this.sName = new Uint16Array(n);
    this.sStart = new Float64Array(n);
    this.sMs = new Float32Array(n);
    this.sSelf = new Float32Array(n);
    this.sDepth = new Uint8Array(n);
    this.sLane = new Int16Array(n);
    this.fId = new Float64Array(frames);
    this.fStart = new Float64Array(frames);
    this.fEnd = new Float64Array(frames);
    this.fTick = new Float64Array(frames).fill(-1);
    this.fCount = new Uint16Array(frames);
    this.fDropped = new Uint32Array(frames);
    this.fSums = new Float64Array(frames * CATEGORIES * 2);
  }

  /** The id of a span name (registered once; the same name keeps its first category). */
  span(name: string, category: SpanCategory): SpanId {
    const known = this.byName.get(name);
    if (known !== undefined) return known;
    const id = this.names.length;
    if (id > 0xffff) throw new RangeError('too many span names');
    this.names.push(name);
    this.cats.push(CATEGORY_INDEX[category]);
    this.byName.set(name, id);
    return id;
  }

  /** The clock spans are timed on. */
  now(): number {
    return wallClock();
  }

  /** The frame starts (at `at`, else now); spans recorded before it in the same frame stay in it. */
  beginFrame(at: number = wallClock()): void {
    if (!this.open) this.openFrame(at);
    else if (this.fCount[this.slot] === 0 && this.fDropped[this.slot] === 0) this.fStart[this.slot] = at;
    else this.fStart[this.slot] = Math.min(this.fStart[this.slot]!, at);
  }

  /** Tags the open frame with the simulation tick it sent or ran. */
  tick(seq: number): void {
    if (!this.open) this.openFrame(wallClock());
    this.fTick[this.slot] = seq;
  }

  /** A span starts now (nested in the one open, if any). */
  begin(id: SpanId): void {
    if (!this.open) this.openFrame(wallClock());
    if (this.depth >= MAX_DEPTH) {
      this.overflow += 1;
      return;
    }
    this.stackId[this.depth] = id;
    this.stackStart[this.depth] = wallClock();
    this.stackChild[this.depth] = 0;
    this.depth += 1;
  }

  /** The innermost open span ends now. */
  end(): void {
    if (this.overflow > 0) {
      this.overflow -= 1;
      return;
    }
    if (this.depth === 0) return;
    this.depth -= 1;
    const d = this.depth;
    const start = this.stackStart[d]!;
    const ms = wallClock() - start;
    if (d > 0) this.stackChild[d - 1] = this.stackChild[d - 1]! + ms;
    this.put(this.stackId[d]!, start, ms, Math.max(0, ms - this.stackChild[d]!), d, NO_LANE);
  }

  /** A finished span (`start` on this recorder's clock) inside whatever span is open. */
  add(id: SpanId, start: number, ms: number): void {
    if (!this.open) this.openFrame(start);
    const d = this.depth;
    if (d > 0) this.stackChild[d - 1] = this.stackChild[d - 1]! + ms;
    this.put(id, start, ms, ms, d, NO_LANE);
  }

  /** A job a worker ran (`lane`: the worker's index), counted in the job workers' sums. */
  job(id: SpanId, lane: number, start: number, ms: number): void {
    if (!this.open) this.openFrame(start);
    this.put(id, start, ms, ms, 0, lane);
  }

  /** The frame ends (at `at`, else now); spans still open are cut there. */
  endFrame(at: number = wallClock()): void {
    while (this.depth > 0) this.end();
    this.overflow = 0;
    if (!this.open) this.openFrame(at);
    this.fEnd[this.slot] = at;
    this.open = false;
    this.closed += 1;
  }

  /** Frames closed so far. */
  get frameCount(): number {
    return this.closed;
  }

  private openFrame(at: number): void {
    this.slot = this.closed % this.frames;
    const s = this.slot;
    this.fId[s] = this.frameSeq++;
    this.fStart[s] = at;
    this.fEnd[s] = at;
    this.fTick[s] = -1;
    this.fCount[s] = 0;
    this.fDropped[s] = 0;
    this.fSums.fill(0, s * CATEGORIES * 2, (s + 1) * CATEGORIES * 2);
    this.open = true;
  }

  private put(id: SpanId, start: number, ms: number, self: number, depth: number, lane: number): void {
    const s = this.slot;
    const c = this.cats[id] ?? CATEGORY_INDEX.other;
    const at = (s * 2 + (lane === NO_LANE ? 0 : 1)) * CATEGORIES + c;
    this.fSums[at] = this.fSums[at]! + self;
    const n = this.fCount[s]!;
    if (n >= this.spansPerFrame) {
      this.fDropped[s] = this.fDropped[s]! + 1;
      return;
    }
    const i = s * this.spansPerFrame + n;
    this.sName[i] = id;
    this.sStart[i] = start;
    this.sMs[i] = ms;
    this.sSelf[i] = self;
    this.sDepth[i] = depth;
    this.sLane[i] = lane;
    this.fCount[s] = n + 1;
  }

  /** The ring slots of the closed frames still kept, oldest first. */
  private keptSlots(from = 0): number[] {
    const first = Math.max(0, from, this.closed - this.frames);
    const out: number[] = [];
    for (let f = first; f < this.closed; f++) out.push(f % this.frames);
    return out;
  }

  /**
   * The kept closed frames, oldest first, as plain data: the thread's own
   * spans, and (`jobs`) the job workers' spans recorded on it as a frame of
   * the `jobs` thread with the same frame id.
   */
  read(last: number = this.frames): { readonly own: ProfileFrame[]; readonly jobs: ProfileFrame[] } {
    const own: ProfileFrame[] = [];
    const jobs: ProfileFrame[] = [];
    for (const s of this.keptSlots(this.closed - last)) {
      own.push(this.frameOf(s, false));
      if (this.hasJobs(s)) jobs.push(this.frameOf(s, true));
    }
    return { own, jobs };
  }

  private hasJobs(s: number): boolean {
    const base = (s * 2 + 1) * CATEGORIES;
    for (let c = 0; c < CATEGORIES; c++) if (this.fSums[base + c]! > 0) return true;
    const n = this.fCount[s]!;
    for (let k = 0; k < n; k++) if (this.sLane[s * this.spansPerFrame + k]! !== NO_LANE) return true;
    return false;
  }

  private frameOf(s: number, jobs: boolean): ProfileFrame {
    const byCategory: Partial<Record<SpanCategory, number>> = {};
    const base = (s * 2 + (jobs ? 1 : 0)) * CATEGORIES;
    for (let c = 0; c < CATEGORIES; c++) {
      const v = this.fSums[base + c]!;
      if (v > 0) byCategory[SPAN_CATEGORIES[c]!] = v;
    }
    const spans: ProfileSpan[] = [];
    const n = this.fCount[s]!;
    for (let k = 0; k < n; k++) {
      const i = s * this.spansPerFrame + k;
      const lane = this.sLane[i]!;
      if ((lane !== NO_LANE) !== jobs) continue;
      const id = this.sName[i]!;
      spans.push({ name: this.names[id] ?? '?', category: SPAN_CATEGORIES[this.cats[id] ?? CATEGORY_INDEX.other]!, start: this.sStart[i]!, ms: this.sMs[i]!, selfMs: this.sSelf[i]!, depth: this.sDepth[i]!, ...(lane !== NO_LANE ? { lane } : {}) });
    }
    spans.sort((a, b) => a.start - b.start);
    const tick = this.fTick[s]!;
    return { thread: jobs ? 'jobs' : this.thread, frame: this.fId[s]!, ...(tick >= 0 ? { tick } : {}), start: this.fStart[s]!, ms: this.fEnd[s]! - this.fStart[s]!, byCategory, spans, dropped: this.fDropped[s]! };
  }

  /** The frames closed since the last pack (null: none), to post to the page. */
  pack(): PackedProfile | null {
    const slots = this.keptSlots(this.packedUpTo);
    this.packedUpTo = this.closed;
    if (slots.length === 0) return null;
    let words = 1;
    for (const s of slots) words += FRAME_HEAD + CATEGORIES * 2 + this.fCount[s]! * SPAN_WORDS;
    const data = new Float64Array(words);
    data[0] = slots.length;
    let o = 1;
    for (const s of slots) {
      const n = this.fCount[s]!;
      data[o++] = this.fId[s]!;
      data[o++] = this.fStart[s]!;
      data[o++] = this.fEnd[s]!;
      data[o++] = this.fTick[s]!;
      data[o++] = n;
      data[o++] = this.fDropped[s]!;
      data.set(this.fSums.subarray(s * CATEGORIES * 2, (s + 1) * CATEGORIES * 2), o);
      o += CATEGORIES * 2;
      for (let k = 0; k < n; k++) {
        const i = s * this.spansPerFrame + k;
        data[o++] = this.sName[i]!;
        data[o++] = this.sStart[i]!;
        data[o++] = this.sMs[i]!;
        data[o++] = this.sSelf[i]!;
        data[o++] = this.sDepth[i]!;
        data[o++] = this.sLane[i]!;
      }
    }
    const firstName = this.namesPacked;
    const names = this.names.slice(firstName).map((n, i) => [n, SPAN_CATEGORIES[this.cats[firstName + i]!]!] as const);
    this.namesPacked = this.names.length;
    return { names, firstName, data };
  }

  /**
   * Takes in another thread's packed frames as its lane's recorder (this
   * recorder records nothing of its own): its names keep the other thread's
   * ids. False: not a packed profile (nothing taken).
   */
  ingest(p: PackedProfile): boolean {
    if (typeof p !== 'object' || p === null || !(p.data instanceof Float64Array) || !Array.isArray(p.names) || p.firstName !== this.names.length) return false;
    for (const [name, category] of p.names) {
      const c = (CATEGORY_INDEX as Readonly<Record<string, number>>)[category as string];
      if (typeof name !== 'string' || c === undefined) return false;
      this.names.push(name);
      this.cats.push(c);
      this.byName.set(name, this.names.length - 1);
    }
    const d = p.data;
    let o = 1;
    for (let f = 0; f < d[0]!; f++) {
      if (o + FRAME_HEAD > d.length) return false;
      this.openFrame(d[o + 1]!);
      const s = this.slot;
      this.fId[s] = d[o]!;
      this.fEnd[s] = d[o + 2]!;
      this.fTick[s] = d[o + 3]!;
      const total = d[o + 4]!;
      const n = Math.min(total, this.spansPerFrame);
      this.fDropped[s] = d[o + 5]! + (total - n);
      o += FRAME_HEAD;
      if (o + CATEGORIES * 2 + total * SPAN_WORDS > d.length) {
        this.open = false;
        return false;
      }
      this.fSums.set(d.subarray(o, o + CATEGORIES * 2), s * CATEGORIES * 2);
      o += CATEGORIES * 2;
      for (let k = 0; k < total; k++) {
        if (k < n) {
          const i = s * this.spansPerFrame + k;
          this.sName[i] = d[o]!;
          this.sStart[i] = d[o + 1]!;
          this.sMs[i] = d[o + 2]!;
          this.sSelf[i] = d[o + 3]!;
          this.sDepth[i] = d[o + 4]!;
          this.sLane[i] = d[o + 5]!;
        }
        o += SPAN_WORDS;
      }
      this.fCount[s] = n;
      this.open = false;
      this.closed += 1;
    }
    return true;
  }
}

/**
 * This thread's recorder (one per page or worker: each has its own copy of
 * this module). A worker names its thread when it starts.
 */
export const threadProfiler = new SpanRecorder('page');
