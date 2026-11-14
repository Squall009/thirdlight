/**
 * What a viewer shows of a frame profile ({@link ProfileReport}), as data:
 * the timeline's columns (one a page frame, every thread's work in it by
 * category), a frame's breakdown (each thread's spans over it), the overlay's
 * few lines and the bounded digest MCP diagnostics carry. One home for the
 * category colours and names, so the editor's panel and the overlay say the
 * same thing.
 *
 * Pure: the editor's panel imports it through the
 * `@thirdlight/game-host/profile-view` subpath; the overlay and the Play
 * page's diagnostics import it directly.
 */
import { SPAN_CATEGORIES, type ProfileFrame, type SpanCategory } from '@thirdlight/shared';

import type { ProfileBudgetRow, ProfileReport, ProfileSpike } from './page-profile';

/** One colour a category, told apart on the editor's dark panels (and in the overlay's box). */
export const PROFILE_CATEGORY_COLOURS: Readonly<Record<SpanCategory, string>> = Object.freeze({
  render: '#5b9bff',
  voxelStream: '#2fc4b2',
  voxelMesh: '#9be7dc',
  voxelApply: '#17806f',
  props: '#c39bff',
  characters: '#ff8fb4',
  effects: '#ffad42',
  lighting: '#ffe27a',
  scripts: '#7fe0a6',
  physics: '#f0705a',
  pathfinding: '#b9d65f',
  audio: '#73c9ff',
  ui: '#b4bccb',
  other: '#5f6878',
});

/** A category as a reader names it. */
export const PROFILE_CATEGORY_LABELS: Readonly<Record<SpanCategory, string>> = Object.freeze({
  render: 'render',
  voxelStream: 'voxel streaming',
  voxelMesh: 'voxel meshing',
  voxelApply: 'voxel draws made',
  props: 'props',
  characters: 'characters',
  effects: 'effects',
  lighting: 'lighting',
  scripts: 'scripts',
  physics: 'physics',
  pathfinding: 'path finding',
  audio: 'audio',
  ui: 'UI',
  other: 'other',
});

/** The threads a viewer shows as lanes, and how it names them. */
export const PROFILE_LANES = ['page', 'sim', 'jobs'] as const;
export type ProfileLane = (typeof PROFILE_LANES)[number];
export const PROFILE_LANE_LABELS: Readonly<Record<ProfileLane, string>> = Object.freeze({ page: 'page', sim: 'simulation', jobs: 'job workers' });

/** A frame interval this many times the cap's is a missed frame (the page profile's spike rule). */
const LONG_FACTOR = 1.5;

/** One lane's work in a column: own ms by category (in {@link SPAN_CATEGORIES} order, none left out as zero rows). */
export interface ProfileLaneWork {
  readonly ms: number;
  readonly byCategory: readonly (readonly [SpanCategory, number])[];
}

/** One page frame and what every thread did from its start to the next frame's. */
export interface ProfileColumn {
  readonly index: number;
  readonly from: number;
  readonly to: number;
  readonly page: ProfileFrame;
  /** The time to the next page frame (null: the newest frame). */
  readonly intervalMs: number | null;
  /** A missed frame, a frame whose own work passed the interval, or one a kept spike covers. */
  readonly long: boolean;
  readonly lanes: Readonly<Record<ProfileLane, ProfileLaneWork>>;
}

const sumOf = (byCategory: ProfileFrame['byCategory']): number => SPAN_CATEGORIES.reduce((n, c) => n + (byCategory[c] ?? 0), 0);

function laneWork(frames: readonly ProfileFrame[], divide: number): ProfileLaneWork {
  const sums = new Map<SpanCategory, number>();
  for (const f of frames) for (const c of SPAN_CATEGORIES) {
    const v = f.byCategory[c];
    if (v !== undefined && v > 0) sums.set(c, (sums.get(c) ?? 0) + v / divide);
  }
  const byCategory = SPAN_CATEGORIES.filter((c) => sums.has(c)).map((c) => [c, sums.get(c)!] as const);
  return { ms: byCategory.reduce((n, [, v]) => n + v, 0), byCategory };
}

/** The job workers the report's pools ran (the job lane shows a frame's work over them, as the budget does). */
export const profileWorkers = (r: ProfileReport): number => Math.max(1, r.counters.queues?.workers ?? 1);

/**
 * The timeline's columns, oldest first: each page frame from its start to the
 * next one's, with the simulation's and the job workers' frames that started
 * in it (the job lane per worker: a frame's job time over the workers).
 */
export function profileColumns(r: ProfileReport): ProfileColumn[] {
  const page = r.threads.page;
  const workers = profileWorkers(r);
  const spikes = r.spikes;
  let si = 0;
  let ji = 0;
  const sim = r.threads.sim;
  const jobs = r.threads.jobs;
  // Frames before the first page frame belong to none.
  while (si < sim.length && page.length > 0 && sim[si]!.start < page[0]!.start) si++;
  while (ji < jobs.length && page.length > 0 && jobs[ji]!.start < page[0]!.start) ji++;
  return page.map((f, index) => {
    const next = page[index + 1];
    const to = next !== undefined ? next.start : f.start + Math.max(f.ms, r.intervalMs);
    const inSim: ProfileFrame[] = [];
    while (si < sim.length && sim[si]!.start < to) inSim.push(sim[si++]!);
    const inJobs: ProfileFrame[] = [];
    while (ji < jobs.length && jobs[ji]!.start < to) inJobs.push(jobs[ji++]!);
    const intervalMs = next !== undefined ? next.start - f.start : null;
    const long = (intervalMs !== null && intervalMs > LONG_FACTOR * r.intervalMs) || sumOf(f.byCategory) > r.intervalMs || spikes.some((s) => s.from < to && s.to > f.start && s.from >= f.start);
    return { index, from: f.start, to, page: f, intervalMs, long, lanes: { page: laneWork([f], 1), sim: laneWork(inSim, 1), jobs: laneWork(inJobs, workers) } };
  });
}

/** One stacked segment of a timeline bar (pixels, y down from the lane's top). */
export interface ProfileBarSegment {
  readonly category: SpanCategory;
  readonly y: number;
  readonly h: number;
}

/**
 * A lane's bar in a column, stacked from the lane's bottom in category order:
 * `scaleMs` fills the lane's height (work past it is cut at the top).
 */
export function profileBar(work: ProfileLaneWork, laneHeight: number, scaleMs: number): ProfileBarSegment[] {
  const out: ProfileBarSegment[] = [];
  let used = 0;
  for (const [category, ms] of work.byCategory) {
    const h = Math.min(laneHeight - used, (ms / Math.max(1e-6, scaleMs)) * laneHeight);
    if (h <= 0) break;
    used += h;
    out.push({ category, y: laneHeight - used, h });
  }
  return out;
}

/** The ms a lane's full height shows: twice the frame interval, so the cap's line sits half way and a long frame still shows. */
export const profileScaleMs = (r: ProfileReport): number => 2 * r.intervalMs;

/** The column under x (pixels) on a timeline `width` wide of `count` columns (null: none). */
export function profileColumnAt(x: number, width: number, count: number): number | null {
  if (count === 0 || width <= 0 || x < 0 || x >= width) return null;
  return Math.min(count - 1, Math.floor((x / width) * count));
}

/** One row of a frame's breakdown: a span (or a simulation tick's frame) as the tree shows it. */
export interface ProfileSpanRow {
  readonly name: string;
  readonly category: SpanCategory;
  readonly ms: number;
  readonly selfMs: number;
  readonly depth: number;
  /** The job worker it ran on (job rows). */
  readonly lane?: number;
}

export interface ProfileBreakdown {
  readonly from: number;
  readonly to: number;
  readonly long: boolean;
  readonly threads: Readonly<Record<ProfileLane, readonly ProfileSpanRow[]>>;
  /** Simulation ticks in the frame. */
  readonly ticks: readonly number[];
}

/** What every thread did in a column's frame: the page's spans, each tick's spans under it, each job by worker. */
export function profileBreakdown(r: ProfileReport, column: ProfileColumn): ProfileBreakdown {
  const rows = (frames: readonly ProfileFrame[], header: (f: ProfileFrame) => string | null): ProfileSpanRow[] =>
    frames.flatMap((f) => {
      const head = header(f);
      // In start order, a parent before the spans it holds (a page's clock reads 0.1 ms: starts tie).
      const spans = [...f.spans].sort((a, b) => a.start - b.start || a.depth - b.depth).map((s) => ({ name: s.name, category: s.category, ms: s.ms, selfMs: s.selfMs, depth: s.depth + (head !== null ? 1 : 0), ...(s.lane !== undefined ? { lane: s.lane } : {}) }));
      return head === null ? spans : [{ name: head, category: 'other' as SpanCategory, ms: f.ms, selfMs: Math.max(0, f.ms - sumOf(f.byCategory)), depth: 0 }, ...spans];
    });
  const inside = (frames: readonly ProfileFrame[]): ProfileFrame[] => frames.filter((f) => f.start >= column.from && f.start < column.to);
  const sim = inside(r.threads.sim);
  return {
    from: column.from,
    to: column.to,
    long: column.long,
    threads: {
      page: rows([column.page], () => null),
      sim: rows(sim, (f) => (f.tick !== undefined ? `tick ${f.tick}` : 'tick')),
      jobs: rows(inside(r.threads.jobs), () => null),
    },
    ticks: sim.map((f) => f.tick ?? -1).filter((t) => t >= 0),
  };
}

/** The columns a spike covers (to open "what every thread was doing" on the timeline). */
export function profileSpikeColumn(columns: readonly ProfileColumn[], spike: ProfileSpike): number | null {
  const hit = columns.find((c) => spike.from < c.to && spike.to > c.from && spike.from >= c.from) ?? columns.find((c) => spike.from < c.to && spike.to > c.from);
  return hit?.index ?? null;
}

/** A report made of a spike's own frames (its window's threads), so the same views show it after its frames left the rings. */
export function profileOfSpike(r: ProfileReport, spike: ProfileSpike): ProfileReport {
  return { ...r, threads: spike.threads, spikes: [spike] };
}

const ms2 = (v: number): string => v.toFixed(2);
const top = (rows: readonly ProfileBudgetRow[], n: number): ProfileBudgetRow[] => [...rows].sort((a, b) => b.meanMs - a.meanMs).slice(0, n);

/** Own ms a frame of a thread, its mean over the kept frames (job workers: over the page's frames and the workers). */
function threadMean(r: ProfileReport, lane: ProfileLane): number {
  return r.budget.rows.filter((x) => x.thread === lane).reduce((n, x) => n + x.meanMs, 0);
}

/**
 * The Play/export overlay's profiler lines: each thread's own ms a frame and
 * its three busiest categories against their budgets, the categories over
 * budget, the GPU's pass shares and the last spike.
 */
export function profileOverlayLines(r: ProfileReport, now: number = r.at): string[] {
  const lines = [`profile  ${r.budget.tier} tier, ${r.frameRateCap !== null ? `cap ${r.frameRateCap} fps` : 'no cap'}, frame ${r.intervalMs.toFixed(1)} ms`];
  for (const lane of PROFILE_LANES) {
    const rows = r.budget.rows.filter((x) => x.thread === lane && x.meanMs > 0);
    const busy = threadMean(r, lane);
    const name = lane === 'jobs' ? 'jobs' : lane === 'sim' ? 'sim ' : 'page';
    const cats = top(rows, 3).map((x) => `${PROFILE_CATEGORY_LABELS[x.category]} ${ms2(x.meanMs)}/${x.budgetMs.toFixed(1)}`);
    lines.push(`${name}  ${ms2(busy).padStart(6)} ms  ${rows.length === 0 ? '(none)' : cats.join('  ')}`);
  }
  const over = r.budget.rows.filter((x) => x.use !== null && x.use > 1);
  if (over.length > 0) lines.push(`over   ${over.map((x) => `${x.thread}/${PROFILE_CATEGORY_LABELS[x.category]} ${Math.round(x.use! * 100)}%`).join('  ')}`);
  lines.push(`gpu    ${r.gpu.shares !== null ? `render ${Math.round(r.gpu.shares.render * 100)}%  compute ${Math.round(r.gpu.shares.compute * 100)}% (shares, not ms)` : 'not measured (no timestamps; room: headroom meter)'}`);
  const last = r.spikes.at(-1);
  if (last !== undefined) {
    const spans = last.threads.page.flatMap((f) => f.spans).sort((a, b) => b.ms - a.ms).slice(0, 2);
    lines.push(`spike  ${last.ms.toFixed(1)} ms (${last.reason}) ${((now - last.at) / 1000).toFixed(0)} s ago${spans.length > 0 ? `: ${spans.map((s) => `${s.name} ${s.ms.toFixed(1)}`).join(', ')}` : ''}`);
  } else lines.push('spike  none kept');
  return lines;
}

/** The digest's bound: it rides inside the Play diagnostics' 16 KiB answer with the other parts. */
export const PROFILE_DIGEST_MAX_BYTES = 6144;

/** Spans the digest names per thread of the worst spike. */
const DIGEST_TOP_SPANS = 6;

/** A profile in a few kilobytes: what an agent reads through `tl_diagnostics` (sections ['profile']). */
export interface ProfileDigest {
  readonly tier: string;
  readonly hz: number;
  readonly quality: string | null;
  readonly frameRateCap: number | null;
  readonly intervalMs: number;
  readonly frames: Readonly<Record<ProfileLane, number>>;
  /** Mean own ms a frame per thread, and each category's mean and worst against its budget. */
  readonly threads: Readonly<Record<ProfileLane, { readonly meanMs: number; readonly categories: readonly { readonly category: SpanCategory; readonly meanMs: number; readonly worstMs: number; readonly budgetMs: number; readonly use: number | null }[] }>>;
  readonly overBudget: readonly string[];
  readonly counters: {
    readonly drawCalls: number | null;
    readonly triangles: number | null;
    readonly instances: ProfileReport['counters']['instances'];
    readonly pageHeapMiB: number | null;
    readonly textureMiB: number | null;
    readonly geometryMiB: number | null;
    readonly voxels: ProfileReport['counters']['voxels'];
    readonly queues: ProfileReport['counters']['queues'];
    /** MiB resident and budgeted per memory budget ([resident (null: no count), budget]); each side's [resident, budget, target] (absent: an older capture). */
    readonly memoryMiB?: { readonly rows: Readonly<Record<string, readonly [number | null, number | null]>>; readonly page: readonly [number | null, number | null, number | null]; readonly gpu: readonly [number | null, number | null, number | null] };
  };
  readonly gpu: ProfileReport['gpu'];
  readonly spikes: { readonly kept: number; readonly worst: null | { readonly reason: ProfileSpike['reason']; readonly ms: number; readonly thresholdMs: number; readonly agoS: number; readonly top: Readonly<Record<ProfileLane, readonly { readonly name: string; readonly category: SpanCategory; readonly ms: number }[]>> } };
  readonly cost: ProfileReport['cost'];
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const mib = (b: number | null | undefined): number | null => (typeof b === 'number' && b >= 0 ? Math.round((b / 1048576) * 10) / 10 : null);

function memoryDigest(m: NonNullable<ProfileReport['counters']['memory']>): NonNullable<ProfileDigest['counters']['memoryMiB']> {
  const rows: Record<string, readonly [number | null, number | null]> = {};
  for (const x of m.rows) rows[x.id] = [mib(x.resident), mib(x.budget)];
  return { rows, page: [mib(m.page.resident), mib(m.page.budget), mib(m.page.target)], gpu: [mib(m.gpu.resident), mib(m.gpu.budget), mib(m.gpu.target)] };
}

/** The digest of a profile read, within {@link PROFILE_DIGEST_MAX_BYTES} (the worst spike's spans and the quiet categories go first if it is not). */
export function profileDigest(r: ProfileReport, now: number = r.at, maxBytes = PROFILE_DIGEST_MAX_BYTES): ProfileDigest {
  const lastCounters = r.counters.frames.at(-1);
  const worst = r.spikes.reduce<ProfileSpike | null>((w, s) => (w === null || s.ms > w.ms ? s : w), null);
  const build = (topSpans: number, allCategories: boolean): ProfileDigest => {
    const topOf = (frames: readonly ProfileFrame[]): { name: string; category: SpanCategory; ms: number }[] =>
      frames
        .flatMap((f) => f.spans)
        .sort((a, b) => b.ms - a.ms)
        .slice(0, topSpans)
        .map((s) => ({ name: s.name, category: s.category, ms: r3(s.ms) }));
    const thread = (lane: ProfileLane): ProfileDigest['threads'][ProfileLane] => ({
      meanMs: r3(threadMean(r, lane)),
      categories: r.budget.rows.filter((x) => x.thread === lane && (allCategories || x.meanMs > 0)).map((x) => ({ category: x.category, meanMs: r3(x.meanMs), worstMs: r3(x.worstMs), budgetMs: r3(x.budgetMs), use: x.use === null ? null : r3(x.use) })),
    });
    return {
      tier: r.budget.tier,
      hz: r.budget.hz,
      quality: r.quality,
      frameRateCap: r.frameRateCap,
      intervalMs: r3(r.intervalMs),
      frames: { page: r.threads.page.length, sim: r.threads.sim.length, jobs: r.threads.jobs.length },
      threads: { page: thread('page'), sim: thread('sim'), jobs: thread('jobs') },
      overBudget: r.budget.rows.filter((x) => x.use !== null && x.use > 1).map((x) => `${x.thread}/${x.category}`),
      counters: {
        drawCalls: lastCounters?.drawCalls ?? r.counters.stats?.drawCalls ?? null,
        triangles: lastCounters?.triangles ?? r.counters.stats?.triangles ?? null,
        instances: r.counters.instances,
        pageHeapMiB: mib(lastCounters?.heapBytes),
        textureMiB: mib(r.counters.stats?.textureBytes),
        geometryMiB: mib(r.counters.stats?.geometryBytes),
        voxels: r.counters.voxels,
        queues: r.counters.queues,
        ...(r.counters.memory !== undefined ? { memoryMiB: memoryDigest(r.counters.memory) } : {}),
      },
      gpu: r.gpu,
      spikes: {
        kept: r.spikes.length,
        worst: worst === null ? null : { reason: worst.reason, ms: r3(worst.ms), thresholdMs: r3(worst.thresholdMs), agoS: Math.round((now - worst.at) / 100) / 10, top: { page: topOf(worst.threads.page), sim: topOf(worst.threads.sim), jobs: topOf(worst.threads.jobs) } },
      },
      cost: { pageSpansPerFrame: r3(r.cost.pageSpansPerFrame), nsPerSpan: Math.round(r.cost.nsPerSpan) },
    };
  };
  for (const [spans, all] of [[DIGEST_TOP_SPANS, true], [DIGEST_TOP_SPANS, false], [2, false], [0, false]] as const) {
    const d = build(spans, all);
    if (JSON.stringify(d).length <= maxBytes) return d;
  }
  return build(0, false);
}
