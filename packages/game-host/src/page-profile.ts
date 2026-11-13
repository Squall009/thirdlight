/**
 * The page's frame profile: one read of everything the frame profiler knows
 * (shared profiler.ts), for whatever shows it (an editor panel, a Play
 * overlay, a capture file, MCP diagnostics) and for tests and benches.
 *
 * - **Threads.** The page's own spans (the host's frame, the adapter's
 *   stages, the voxel draws made), the simulation worker's (posted with each
 *   tick's frame and taken in here) and the voxel job workers' (recorded
 *   where their pool runs: in the worker, or on the page in single-thread
 *   mode), each the last frames of its ring.
 * - **Counters.** Each page frame's draw calls and triangles (the adapter's
 *   frame counts, the numbers `ctx.stats` reports) and the page's heap where
 *   the browser tells it; at a read, the stats window and what the adapter
 *   and the voxel draws hold now; the voxel pools' queues as the last tick
 *   reported them.
 * - **GPU.** Pass shares where timestamps resolve (render against compute),
 *   never their milliseconds at a frame-rate cap: there the GPU's clock
 *   follows its load, so the GPU's room is measured by the headroom meter on
 *   demand (`__tlVoxelPlay.meter`, `tools/voxel-bench` headroom).
 * - **Budget.** The tier's frame budget per thread and category, beside each
 *   category's use over the kept frames, and the frame arbiter's slices.
 * - **Spikes.** A frame whose interval passes {@link PROFILE_SPIKE_FACTOR}
 *   frame intervals, or whose own work or a tick's passes one, keeps what
 *   every thread did over it in a small ring of its own.
 *
 * Recording costs a few clock reads a span; nothing here makes objects until
 * something reads it.
 */
import { FRAME_BUDGET_BY_TIER, frameBudgetMs, type BehaviorStats, type FrameBudget } from '@thirdlight/runtime';
import { frameArbiter, PROFILE_FRAMES, SPAN_CATEGORIES, SpanRecorder, threadProfiler, wallClock, type FrameSliceReading, type PackedProfile, type ProfileFrame, type SpanCategory } from '@thirdlight/shared';
import type { PoolQueues } from '@thirdlight/voxel';

/** A frame is a spike when the time since the last one passes this many frame intervals (a frame at the cap missed). */
export const PROFILE_SPIKE_FACTOR = 1.5;
/** Spikes kept (the newest). */
export const PROFILE_SPIKES = 8;
/** Page frames a spike waits for the other threads' frames of its time to arrive before it is kept. */
const SPIKE_SETTLE_FRAMES = 4;
/** Page counters a frame: frame id, draw calls, triangles, page heap bytes (-1: not told). */
const COUNTER_WORDS = 4;

/** What the page's profile reads from the host when it is read (each absent part reads as nothing). */
export interface ProfileSources {
  /** The last stats window (`ctx.stats`). */
  stats?(): BehaviorStats | null;
  /** The adapter's diagnostics at a read (instances, GPU memory counts), loosely typed: a read only picks fields. */
  diagnostics?(): unknown;
  /** GPU ms of the render and compute passes of the last timestamp resolve (null: none measured). */
  gpuPasses?(): { readonly renderMs: number; readonly computeMs: number | null } | null;
  /** The voxel draws now: chunks, instances, triangles, far GPU bytes, batches waiting (null: no voxel worlds). */
  voxels?(): ProfileVoxels | null;
  /** Whether the page has the GPU headroom meter (a voxel page). */
  meter?(): boolean;
}

export interface ProfileVoxels {
  readonly chunks: number;
  readonly instances: number;
  readonly triangles: number;
  readonly farGpuBytes: number;
  readonly batchesWaiting: number;
}

/** One page frame's counters. */
export interface ProfileFrameCounters {
  readonly frame: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly heapBytes: number | null;
}

/** One budget row: what a category may spend on a thread at the tier's frame rate, and what it spent over the kept frames. */
export interface ProfileBudgetRow {
  readonly thread: 'page' | 'sim' | 'jobs';
  readonly category: SpanCategory;
  readonly budgetMs: number;
  /** Mean own ms a frame over the kept frames (job workers: a frame's sum over every worker, divided by the workers). */
  readonly meanMs: number;
  readonly worstMs: number;
  /** meanMs against budgetMs (null: nothing budgeted). */
  readonly use: number | null;
}

export interface ProfileSpike {
  /** When it was seen (wall ms) and why. */
  readonly at: number;
  readonly reason: 'interval' | 'page' | 'sim';
  /** The long stretch: the frame interval, or the thread's frame. */
  readonly ms: number;
  readonly thresholdMs: number;
  /** The window its threads' frames are kept over (wall ms). */
  readonly from: number;
  readonly to: number;
  readonly threads: { readonly page: readonly ProfileFrame[]; readonly sim: readonly ProfileFrame[]; readonly jobs: readonly ProfileFrame[] };
}

/** Everything the profile knows, as plain JSON-serialisable data. */
export interface ProfileReport {
  readonly at: number;
  readonly quality: string | null;
  readonly frameRateCap: number | null;
  /** The interval the frames are judged by (the cap's, else the tier's budget interval). */
  readonly intervalMs: number;
  readonly threads: { readonly page: readonly ProfileFrame[]; readonly sim: readonly ProfileFrame[]; readonly jobs: readonly ProfileFrame[] };
  readonly counters: {
    readonly frames: readonly ProfileFrameCounters[];
    /** The last stats window (`ctx.stats`: draw calls and triangles of its last frame, texture and geometry bytes, objects). */
    readonly stats: BehaviorStats | null;
    readonly instances: { readonly copies: number; readonly inView: number } | null;
    readonly gpuResources: { readonly geometries: number; readonly textures: number; readonly programs: number } | null;
    readonly voxels: ProfileVoxels | null;
    readonly queues: PoolQueues | null;
  };
  readonly gpu: {
    /** Whether the renderer resolves timestamps. */
    readonly timestamps: boolean;
    /** Render and compute passes' shares of the GPU time the last resolve measured (null: not measured). */
    readonly shares: { readonly render: number; readonly compute: number } | null;
    /** Room at the cap: never from timestamps; the headroom meter measures it on demand where the page has it. */
    readonly room: 'headroom meter' | 'not measurable here';
  };
  readonly budget: {
    readonly tier: FrameBudget['tier'];
    readonly hz: number;
    readonly intervalMs: number;
    readonly rows: readonly ProfileBudgetRow[];
    /** The GPU's planned shares (compared with pass shares, not milliseconds). */
    readonly gpu: Readonly<Partial<Record<SpanCategory, number>>>;
  };
  readonly slices: readonly FrameSliceReading[];
  readonly spikes: readonly ProfileSpike[];
  /** The profiler's own cost: spans the page records a frame, and a span's measured cost on this page (ns). */
  readonly cost: { readonly pageSpansPerFrame: number; readonly nsPerSpan: number };
}

interface PendingSpike {
  readonly at: number;
  readonly reason: ProfileSpike['reason'];
  readonly ms: number;
  readonly thresholdMs: number;
  from: number;
  to: number;
  until: number;
}

const overlaps = (f: ProfileFrame, from: number, to: number): boolean => f.start <= to && f.start + f.ms >= from;
const heapNow = (): number => {
  const m = (globalThis as { performance?: { memory?: { usedJSHeapSize?: unknown } } }).performance?.memory?.usedJSHeapSize;
  return typeof m === 'number' ? m : -1;
};

export class PageProfile {
  private readonly page = threadProfiler;
  private readonly sim = new SpanRecorder('sim');
  private readonly counters = new Float64Array(PROFILE_FRAMES * COUNTER_WORDS);
  private lastStart: number | null = null;
  private sources: ProfileSources = {};
  private queues: PoolQueues | null = null;
  private readonly pending: PendingSpike[] = [];
  private readonly spikes: ProfileSpike[] = [];
  private nsPerSpan: number | null = null;
  /** The interval frames are judged by now, and the tier's budget. */
  private intervalMs: number = FRAME_BUDGET_BY_TIER.medium.intervalMs;
  private budget: FrameBudget = FRAME_BUDGET_BY_TIER.medium;
  private cap: number | null = null;

  /** Sources a host or its page gives (laid over the ones given before: a new host's replace the last one's). */
  attach(sources: ProfileSources): void {
    this.sources = { ...this.sources, ...sources };
    // A page with a host is read through its global (Play, an export, the benches and tests).
    (globalThis as Record<string, unknown>)[PROFILE_HOOK] ??= { read: () => this.read() };
  }

  /** The frame rate and tier the page draws at: the interval frames are judged by, and the slices the page's arbiter hands out. */
  follow(frameRateCap: number | null, tier: FrameBudget['tier']): void {
    this.cap = frameRateCap;
    this.budget = FRAME_BUDGET_BY_TIER[tier];
    this.intervalMs = frameRateCap !== null ? 1000 / frameRateCap : this.budget.intervalMs;
    frameArbiter.setInterval(this.intervalMs);
    frameArbiter.install(this.budget.slices);
  }

  /** A page frame starts (`at`: its animation frame's time on the wall clock). */
  frameStart(at: number): void {
    this.page.beginFrame(at);
  }

  /** The page frame ends (at `end`, else now): its counts, then whether it was a spike. */
  frameEnd(drawCalls: number, triangles: number, end: number = wallClock()): void {
    this.page.endFrame(end);
    const frame = this.page.frameCount - 1;
    const o = (frame % PROFILE_FRAMES) * COUNTER_WORDS;
    this.counters[o] = frame;
    this.counters[o + 1] = drawCalls;
    this.counters[o + 2] = triangles;
    this.counters[o + 3] = heapNow();
    const start = this.page.closedStart();
    const interval = this.lastStart !== null ? start - this.lastStart : 0;
    const threshold = PROFILE_SPIKE_FACTOR * this.intervalMs;
    if (interval > threshold) this.spike('interval', interval, threshold, this.lastStart!, end);
    else if (end - start > this.intervalMs) this.spike('page', end - start, this.intervalMs, start, end);
    this.lastStart = start;
    this.settle(false);
  }

  /** A tick's frame from the simulation worker: its profiler frames and its pools' queues. */
  simFrames(profile: PackedProfile | undefined, queues: PoolQueues | undefined): void {
    if (queues !== undefined) this.queues = queues;
    if (profile === undefined) return;
    const before = this.sim.frameCount;
    if (!this.sim.ingest(profile)) return;
    for (let back = 0; back < this.sim.frameCount - before; back++) {
      const start = this.sim.closedStart(back);
      const ms = this.sim.closedEnd(back) - start;
      if (ms > this.intervalMs) this.spike('sim', ms, this.intervalMs, start, start + ms);
    }
  }

  private spike(reason: ProfileSpike['reason'], ms: number, thresholdMs: number, from: number, to: number): void {
    const open = this.pending.find((p) => p.from <= to && p.to >= from);
    if (open !== undefined) {
      open.from = Math.min(open.from, from);
      open.to = Math.max(open.to, to);
      return;
    }
    this.pending.push({ at: wallClock(), reason, ms, thresholdMs, from, to, until: this.page.frameCount + SPIKE_SETTLE_FRAMES });
  }

  /** Spikes whose other threads' frames had time to arrive are kept (`all`: every pending one, for a read). */
  private settle(all: boolean): void {
    if (this.pending.length === 0) return;
    const now = this.page.frameCount;
    for (let i = 0; i < this.pending.length; ) {
      const p = this.pending[i]!;
      if (!all && p.until > now) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      const t = this.threads();
      const keep = (frames: readonly ProfileFrame[]): ProfileFrame[] => frames.filter((f) => overlaps(f, p.from, p.to));
      this.spikes.push({ at: p.at, reason: p.reason, ms: p.ms, thresholdMs: p.thresholdMs, from: p.from, to: p.to, threads: { page: keep(t.page), sim: keep(t.sim), jobs: keep(t.jobs) } });
      if (this.spikes.length > PROFILE_SPIKES) this.spikes.splice(0, this.spikes.length - PROFILE_SPIKES);
    }
  }

  private threads(): { page: ProfileFrame[]; sim: ProfileFrame[]; jobs: ProfileFrame[] } {
    const page = this.page.read();
    const sim = this.sim.read();
    return { page: page.own, sim: sim.own, jobs: [...page.jobs, ...sim.jobs].sort((a, b) => a.start - b.start) };
  }

  private counterFrames(): ProfileFrameCounters[] {
    const out: ProfileFrameCounters[] = [];
    const n = this.page.frameCount;
    for (let f = Math.max(0, n - PROFILE_FRAMES); f < n; f++) {
      const o = (f % PROFILE_FRAMES) * COUNTER_WORDS;
      const heap = this.counters[o + 3]!;
      out.push({ frame: this.counters[o]!, drawCalls: this.counters[o + 1]!, triangles: this.counters[o + 2]!, heapBytes: heap >= 0 ? heap : null });
    }
    return out;
  }

  private budgetRows(t: { page: ProfileFrame[]; sim: ProfileFrame[]; jobs: ProfileFrame[] }): ProfileBudgetRow[] {
    const rows: ProfileBudgetRow[] = [];
    const workers = Math.max(1, this.queues?.workers ?? 1);
    for (const thread of ['page', 'sim', 'jobs'] as const) {
      const frames = t[thread];
      for (const category of SPAN_CATEGORIES) {
        const budgetMs = frameBudgetMs(this.budget, thread, category);
        let sum = 0;
        let worst = 0;
        for (const f of frames) {
          const v = (f.byCategory[category] ?? 0) / (thread === 'jobs' ? workers : 1);
          sum += v;
          worst = Math.max(worst, v);
        }
        if (budgetMs === 0 && sum === 0) continue;
        // Job frames exist only where a job answered: the mean is over the page's frames, as the budget is a frame's.
        const n = thread === 'jobs' ? Math.max(1, t.page.length) : Math.max(1, frames.length);
        const meanMs = sum / n;
        rows.push({ thread, category, budgetMs, meanMs, worstMs: worst, use: budgetMs > 0 ? meanMs / budgetMs : null });
      }
    }
    return rows;
  }

  /** A span's cost on this page (ns), measured once on a recorder of its own. */
  private spanCost(): number {
    if (this.nsPerSpan !== null) return this.nsPerSpan;
    const r = new SpanRecorder('page', 1, 5000);
    const id = r.span('cost', 'other');
    // Enough spans that a page's coarse clock (0.1 ms where the page is not cross-origin isolated) reads them to a few ns.
    const n = 5000;
    const t0 = performance.now();
    r.beginFrame();
    for (let i = 0; i < n; i++) {
      r.begin(id);
      r.end();
    }
    r.endFrame();
    this.nsPerSpan = ((performance.now() - t0) * 1e6) / n;
    return this.nsPerSpan;
  }

  /** The whole profile now (plain data). */
  read(): ProfileReport {
    this.settle(true);
    const t = this.threads();
    const stats = this.sources.stats?.() ?? null;
    const d = this.sources.diagnostics?.() as { ok?: boolean; diagnostics?: { lod?: { instances?: { copies?: number; inView?: number } }; gpu?: { geometries?: number; textures?: number; programs?: number } } } | undefined;
    const inst = d?.ok === true ? d.diagnostics?.lod?.instances : undefined;
    const gpuMem = d?.ok === true ? d.diagnostics?.gpu : undefined;
    const passes = this.sources.gpuPasses?.() ?? null;
    const total = passes === null ? 0 : passes.renderMs + (passes.computeMs ?? 0);
    const spans = t.page.reduce((n, f) => n + f.spans.length + f.dropped, 0);
    return {
      at: wallClock(),
      quality: stats?.quality ?? null,
      frameRateCap: this.cap,
      intervalMs: this.intervalMs,
      threads: t,
      counters: {
        frames: this.counterFrames(),
        stats,
        instances: inst !== undefined ? { copies: inst.copies ?? 0, inView: inst.inView ?? 0 } : null,
        gpuResources: gpuMem !== undefined ? { geometries: gpuMem.geometries ?? 0, textures: gpuMem.textures ?? 0, programs: gpuMem.programs ?? 0 } : null,
        voxels: this.sources.voxels?.() ?? null,
        queues: this.queues,
      },
      gpu: {
        timestamps: passes !== null,
        shares: passes !== null && total > 0 ? { render: passes.renderMs / total, compute: (passes.computeMs ?? 0) / total } : null,
        room: this.sources.meter?.() === true ? 'headroom meter' : 'not measurable here',
      },
      budget: { tier: this.budget.tier, hz: this.budget.hz, intervalMs: this.budget.intervalMs, rows: this.budgetRows(t), gpu: this.budget.gpu },
      slices: frameArbiter.read(),
      spikes: [...this.spikes],
      cost: { pageSpansPerFrame: t.page.length > 0 ? spans / t.page.length : 0, nsPerSpan: this.spanCost() },
    };
  }
}

/** A profile in a few numbers, for a bench's line (own ms a frame per thread, the busy share of the wall time its frames cover). */
export interface ProfileSummary {
  readonly frames: { readonly page: number; readonly sim: number; readonly jobs: number };
  /** Own ms a page frame: the page's spans, and the simulation's and the job workers' over the same frames. */
  readonly msPerFrame: { readonly page: number; readonly sim: number | null; readonly jobs: number | null };
  readonly busy: { readonly page: number; readonly sim: number | null };
  /** Per thread and category, the mean own ms a frame where it is above zero, beside its budget. */
  readonly rows: readonly ProfileBudgetRow[];
  readonly spikes: number;
  readonly spansPerFrame: number;
  readonly nsPerSpan: number;
}

const ownMs = (frames: readonly ProfileFrame[]): number => frames.reduce((n, f) => n + Object.values(f.byCategory).reduce((m, v) => m + (v ?? 0), 0), 0);
const wallMs = (frames: readonly ProfileFrame[]): number => (frames.length === 0 ? 0 : frames[frames.length - 1]!.start + frames[frames.length - 1]!.ms - frames[0]!.start);
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The summary of a profile read (`ProfileReport`). */
export function profileSummary(r: ProfileReport): ProfileSummary {
  const { page, sim, jobs } = r.threads;
  const per = (frames: readonly ProfileFrame[]): number | null => (frames.length === 0 ? null : round3(ownMs(frames) / frames.length));
  const busy = (frames: readonly ProfileFrame[]): number | null => (frames.length < 2 ? null : round3(ownMs(frames) / Math.max(1e-9, wallMs(frames))));
  return {
    frames: { page: page.length, sim: sim.length, jobs: jobs.length },
    msPerFrame: { page: per(page) ?? 0, sim: per(sim), jobs: jobs.length === 0 ? null : round3(ownMs(jobs) / Math.max(1, page.length)) },
    busy: { page: busy(page) ?? 0, sim: busy(sim) },
    rows: r.budget.rows.filter((x) => x.meanMs > 0).map((x) => ({ ...x, meanMs: round3(x.meanMs), worstMs: round3(x.worstMs), budgetMs: round3(x.budgetMs), use: x.use === null ? null : round3(x.use) })),
    spikes: r.spikes.length,
    spansPerFrame: round3(r.cost.pageSpansPerFrame),
    nsPerSpan: Math.round(r.cost.nsPerSpan),
  };
}

/** This page's profile (one per page: every host on it records into the same page thread). */
export const pageProfile = new PageProfile();

/** The host's stages of a page frame as spans (the adapter's stages nest inside the render). */
export const HOST_SPAN = Object.freeze({
  scenes: threadProfiler.span('scene requests', 'other'),
  input: threadProfiler.span('input and UI', 'ui'),
  overlays: threadProfiler.span('overlays', 'ui'),
  host: threadProfiler.span('saves, problems and assets', 'other'),
  audio: threadProfiler.span('sounds and music', 'audio'),
  render: threadProfiler.span('render frame', 'render'),
  anchors: threadProfiler.span('UI anchors', 'ui'),
});

/** The global a page's tools read the profile through (Play, an export, the benches and e2e tests). */
export const PROFILE_HOOK = '__tlProfiler';
