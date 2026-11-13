/**
 * The frame profile as a file, and as a stream of reads a viewer adds up.
 *
 * - **Capture file** (`version: 1`): a small header (the build, the tier, the
 *   cap, the renderer, when) and one {@link ProfileReport} as the page reads
 *   it. The Play/export overlay and the editor's profiler panel write it; the
 *   panel opens it again to inspect it offline. {@link parseProfileCapture}
 *   refuses another version or a file that is not one, with the reason.
 * - **Adding reads up** ({@link ProfileAccumulator}): a viewer that polls
 *   asks the page only for what arrived since its last read (the page
 *   profile's `read(after)` with the cursor the last read returned), keeps
 *   the last frames of every thread as the page does and gives back one
 *   whole report.
 *
 * Pure data and code: the editor's panel imports it through the
 * `@thirdlight/game-host/profile-view` subpath.
 */
import { isPlainObject, PROFILE_FRAMES, type ProfileFrame } from '@thirdlight/shared';

import type { ProfileCursor, ProfileReport, ProfileSpike } from './page-profile';

/** The capture file's version: a reader refuses any other. */
export const PROFILE_CAPTURE_VERSION = 1;
/** What a capture file says it is (a JSON file a user may pick by mistake is told apart). */
export const PROFILE_CAPTURE_KIND = 'thirdlight-frame-profile';

/** Where a capture was saved from. */
export type ProfileCaptureSource = 'play' | 'export' | 'editor';

export interface ProfileCaptureHeader {
  /** The build of the game the profile ran (the Play or export build id; null: not known). */
  readonly build: string | null;
  /** The quality tier the budget is the tier of, and the quality level drawn. */
  readonly tier: string;
  readonly quality: string | null;
  /** The frame-rate cap (null: none, the display's rate). */
  readonly frameRateCap: number | null;
  /** The renderer that drew it (webgpu, webgl2; null: not known). */
  readonly renderer: string | null;
  /** When it was saved (ISO 8601). */
  readonly date: string;
  readonly source: ProfileCaptureSource;
}

export interface ProfileCapture {
  readonly version: typeof PROFILE_CAPTURE_VERSION;
  readonly kind: typeof PROFILE_CAPTURE_KIND;
  readonly header: ProfileCaptureHeader;
  readonly report: ProfileReport;
}

/** A capture of `report` (the header's tier, quality and cap are the report's own). */
export function makeProfileCapture(report: ProfileReport, header: { build: string | null; renderer: string | null; source: ProfileCaptureSource; date?: Date }): ProfileCapture {
  return {
    version: PROFILE_CAPTURE_VERSION,
    kind: PROFILE_CAPTURE_KIND,
    header: {
      build: header.build,
      tier: report.budget.tier,
      quality: report.quality,
      frameRateCap: report.frameRateCap,
      renderer: header.renderer,
      date: (header.date ?? new Date()).toISOString(),
      source: header.source,
    },
    report,
  };
}

/** The renderer drawing now, as the adapter's diagnostics name it (null: none yet or not told). */
export function rendererOf(adapter: { diagnostics?(): unknown } | null): string | null {
  const d = adapter?.diagnostics?.() as { ok?: boolean; diagnostics?: { renderer?: { backend?: unknown } } } | undefined;
  const b = d?.ok === true ? d.diagnostics?.renderer?.backend : undefined;
  return typeof b === 'string' ? b : null;
}

/** The file's text. */
export function profileCaptureText(capture: ProfileCapture): string {
  return JSON.stringify(capture);
}

/** The file's name: when it was saved, sortable, safe on every file system. */
export function profileCaptureFileName(capture: ProfileCapture): string {
  return `thirdlight-profile-${capture.header.date.replace(/\.\d+Z$/, 'Z').replace(/[:]/g, '-')}.json`;
}

const isFrameList = (v: unknown): boolean => Array.isArray(v) && v.every((f) => isPlainObject(f) && typeof f['start'] === 'number' && typeof f['ms'] === 'number' && isPlainObject(f['byCategory']) && Array.isArray(f['spans']));

/** A capture file's text read back, or why it is not one this engine reads. */
export function parseProfileCapture(text: string): { ok: true; capture: ProfileCapture } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (!isPlainObject(v) || v['kind'] !== PROFILE_CAPTURE_KIND) return { ok: false, error: 'not a frame profile capture' };
  if (v['version'] !== PROFILE_CAPTURE_VERSION) return { ok: false, error: `capture version ${String(v['version'])}; this engine reads version ${PROFILE_CAPTURE_VERSION}` };
  const h = v['header'];
  const r = v['report'];
  if (!isPlainObject(h) || typeof h['tier'] !== 'string' || typeof h['date'] !== 'string') return { ok: false, error: 'the capture has no header' };
  if (!isPlainObject(r) || !isPlainObject(r['threads']) || !isPlainObject(r['budget']) || !isPlainObject(r['counters']) || !isPlainObject(r['gpu']) || !Array.isArray(r['spikes']) || !Array.isArray(r['slices'])) return { ok: false, error: 'the capture has no profile' };
  const t = r['threads'];
  if (!isFrameList(t['page']) || !isFrameList(t['sim']) || !isFrameList(t['jobs'])) return { ok: false, error: 'the capture\'s threads are not frame lists' };
  if (!Array.isArray(r['budget']['rows']) || typeof r['intervalMs'] !== 'number') return { ok: false, error: 'the capture has no budget' };
  return { ok: true, capture: v as unknown as ProfileCapture };
}

const frameKey = (f: ProfileFrame): string => `${f.thread}:${f.frame}:${f.start}`;

/**
 * The reads of one page added up, as a viewer keeps them: the last
 * {@link PROFILE_FRAMES} frames of each thread (and the page's counter
 * frames), the spikes the page keeps, and every other part of the newest read.
 */
export class ProfileAccumulator {
  private last: ProfileReport | null = null;
  private page: ProfileFrame[] = [];
  private sim: ProfileFrame[] = [];
  private jobs: ProfileFrame[] = [];
  private counterFrames: ProfileReport['counters']['frames'][number][] = [];
  private spikes: ProfileSpike[] = [];

  constructor(private readonly keepSpikes = 8) {}

  /** What to ask the page for next (null: everything it keeps). */
  get cursor(): ProfileCursor | null {
    return this.last?.seq ?? null;
  }

  /** Adds a read (a whole report or the cut `read(after)` gives). A page that started again (its counts went back) starts the sum again. */
  add(r: ProfileReport): void {
    const prev = this.last?.seq;
    if (prev !== undefined && (r.seq.page < prev.page || r.seq.sim < prev.sim)) this.clear();
    const merge = (kept: ProfileFrame[], more: readonly ProfileFrame[]): ProfileFrame[] => {
      const seen = new Set(kept.map(frameKey));
      const all = [...kept, ...more.filter((f) => !seen.has(frameKey(f)))].sort((a, b) => a.start - b.start);
      return all.slice(Math.max(0, all.length - PROFILE_FRAMES));
    };
    this.page = merge(this.page, r.threads.page);
    this.sim = merge(this.sim, r.threads.sim);
    this.jobs = merge(this.jobs, r.threads.jobs);
    const have = new Set(this.counterFrames.map((c) => c.frame));
    const counters = [...this.counterFrames, ...r.counters.frames.filter((c) => !have.has(c.frame))].sort((a, b) => a.frame - b.frame);
    this.counterFrames = counters.slice(Math.max(0, counters.length - PROFILE_FRAMES));
    const known = new Set(this.spikes.map((s) => s.at));
    const spikes = [...this.spikes, ...r.spikes.filter((s) => !known.has(s.at))].sort((a, b) => a.at - b.at);
    this.spikes = spikes.slice(Math.max(0, spikes.length - this.keepSpikes));
    this.last = r;
  }

  /** Everything added, as one report (null: nothing yet). */
  report(): ProfileReport | null {
    if (this.last === null) return null;
    return { ...this.last, threads: { page: [...this.page], sim: [...this.sim], jobs: [...this.jobs] }, counters: { ...this.last.counters, frames: [...this.counterFrames] }, spikes: [...this.spikes] };
  }

  clear(): void {
    this.last = null;
    this.page = [];
    this.sim = [];
    this.jobs = [];
    this.counterFrames = [];
    this.spikes = [];
  }
}
