/**
 * Where a game page's start time goes. A small recorder the
 * page (Play's preview, and later the export) marks as it starts: named
 * stages with a start and an end (they may overlap: the simulation worker
 * starts while the assets are read), the first drawn frame, the slow frames
 * after it, and each scene loaded during play (its file read, the frame that
 * attached it, the slow frames after that).
 *
 * All times are milliseconds from the page's time origin
 * (`performance.timeOrigin`, reported as `epochMs`), so a tool can line them
 * up with its own clock. The report is bounded (at most 24 stages, the 8
 * worst frames, the last 8 scene loads) so it fits in play diagnostics.
 */

/** Frames slower than this count as slow (ms between two drawn frames; 20 fps). */
export const SLOW_FRAME_MS = 50;
/** How long after the first frame (and after a scene attaches) frames are watched (ms). */
export const FRAME_WATCH_MS = 10_000;
const MAX_STAGES = 24;
const MAX_WORST = 8;
const MAX_SCENE_LOADS = 8;

export interface StartStage {
  readonly name: string;
  readonly startMs: number;
  endMs: number | null;
  note?: string;
}

export interface SlowFrame {
  /** When the frame was drawn (ms from the time origin). */
  readonly atMs: number;
  /** Time since the previous drawn frame. */
  readonly ms: number;
}

export interface FrameWatch {
  /** Drawn frames seen in the window. */
  frames: number;
  /** Frames slower than SLOW_FRAME_MS, 100 ms and 250 ms. */
  over50: number;
  over100: number;
  over250: number;
  /** The slowest frames (worst first). */
  worst: SlowFrame[];
}

export interface SceneLoadTiming {
  readonly sceneId: string;
  /** The game asked for the scene. */
  readonly requestedMs: number;
  /** Its file was read and verified (null: still reading, or it failed). */
  readMs: number | null;
  entities: number | null;
  /** The first frame that drew it (the render side's add). */
  attachedMs: number | null;
  /** That frame's time since the previous frame. */
  attachFrameMs: number | null;
  /** The precompile that frame waited for (ms; null: none). */
  precompileMs?: number | null;
  /** It was read ahead (a preload) before the game asked. */
  preloaded?: boolean;
  /** Its assets were prepared (models parsed, textures decoded) and it went to the simulation. */
  preparedMs?: number | null;
  /**
   * Draw calls of the last frame drawn before the request, of
   * the frame that attached it, and the fewest of any frame drawn from the
   * request to the end of the watch after the attach (an empty world shows
   * as a drop), with the frames drawn while it loaded and their longest gap.
   */
  drawsBefore?: number | null;
  attachDraws?: number | null;
  drawsMin?: number | null;
  loadingFrames?: number;
  loadingWorstMs?: number;
  /** Frames in the FRAME_WATCH_MS after the attach. */
  after: FrameWatch;
  error?: string;
}

export interface StartTimingsReport {
  /** `performance.timeOrigin` (ms since the epoch): every other time counts from it. */
  readonly epochMs: number;
  readonly stages: readonly StartStage[];
  readonly firstFrameMs: number | null;
  /** The first drawn frame's draw calls (it waits for the start scenes' models). */
  readonly firstFrameDraws?: number | null;
  /** Frames in the FRAME_WATCH_MS after the first frame. */
  readonly afterFirstFrame: FrameWatch;
  readonly sceneLoads: readonly SceneLoadTiming[];
  /** Extra counts the page adds (asset reads, bytes …). */
  readonly counts: Readonly<Record<string, number>>;
}

export interface StartTimings {
  /** Start a stage (a second begin of the same name is ignored). */
  begin(name: string): void;
  /** End a stage (begun now when it never began: a point in time). */
  end(name: string, note?: string): void;
  /** A stage whose times the page learned elsewhere (e.g. the bundle's resource timing). */
  record(name: string, startMs: number, endMs: number, note?: string): void;
  /** Add to a count (asset reads, bytes …). */
  count(name: string, add: number): void;
  /**
   * A drawn frame (the renderer's hook), with the scenes it attached. With
   * the render call's time and when the first render call began, the first
   * frame adds the stages `rendererInit` (first call → the first drawn
   * frame's call) and `firstRender` (that call).
   */
  frame(info?: { readonly realizedScenes?: readonly string[]; readonly renderMs?: number; readonly firstCallAt?: number; readonly precompile?: { readonly startedAt: number; readonly ms: number }; readonly draws?: number }): void;
  /** The game asked for a scene (`preloaded` when it was read ahead) / its file is read / prepared / the read failed. */
  sceneRequested(sceneId: string, preloaded?: boolean): void;
  sceneRead(sceneId: string, entities: number): void;
  scenePrepared(sceneId: string, entities?: number): void;
  sceneFailed(sceneId: string, message: string): void;
  report(): StartTimingsReport;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

function emptyWatch(): FrameWatch {
  return { frames: 0, over50: 0, over100: 0, over250: 0, worst: [] };
}

function addFrame(w: FrameWatch, atMs: number, ms: number): void {
  w.frames += 1;
  if (ms <= SLOW_FRAME_MS) return;
  w.over50 += 1;
  if (ms > 100) w.over100 += 1;
  if (ms > 250) w.over250 += 1;
  if (w.worst.length < MAX_WORST || ms > w.worst[w.worst.length - 1]!.ms) {
    w.worst.push({ atMs: round1(atMs), ms: round1(ms) });
    w.worst.sort((a, b) => b.ms - a.ms);
    if (w.worst.length > MAX_WORST) w.worst.length = MAX_WORST;
  }
}

/** A recorder on `now` (default `performance.now()`; tests pass a clock). */
export function createStartTimings(opts: { now?: () => number; epochMs?: number } = {}): StartTimings {
  const now = opts.now ?? (() => performance.now());
  const epochMs = opts.epochMs ?? (typeof performance !== 'undefined' ? performance.timeOrigin : 0);
  const stages = new Map<string, StartStage>();
  const counts: Record<string, number> = {};
  let firstFrameMs: number | null = null;
  let lastFrameMs: number | null = null;
  let lastDraws: number | null = null;
  let firstFrameDraws: number | null = null;
  const afterFirst = emptyWatch();
  const loads: SceneLoadTiming[] = [];
  const pendingLoad = (sceneId: string): SceneLoadTiming | undefined => {
    for (let i = loads.length - 1; i >= 0; i -= 1) if (loads[i]!.sceneId === sceneId) return loads[i];
    return undefined;
  };
  return {
    begin(name) {
      if (stages.has(name) || stages.size >= MAX_STAGES) return;
      stages.set(name, { name, startMs: round1(now()), endMs: null });
    },
    end(name, note) {
      let s = stages.get(name);
      if (s === undefined) {
        if (stages.size >= MAX_STAGES) return;
        s = { name, startMs: round1(now()), endMs: null };
        stages.set(name, s);
      }
      if (s.endMs === null) s.endMs = round1(now());
      if (note !== undefined) s.note = note.slice(0, 80);
    },
    record(name, startMs, endMs, note) {
      if (stages.has(name) || stages.size >= MAX_STAGES) return;
      stages.set(name, { name, startMs: round1(startMs), endMs: round1(endMs), ...(note !== undefined ? { note: note.slice(0, 80) } : {}) });
    },
    count(name, add) {
      counts[name] = (counts[name] ?? 0) + add;
    },
    frame(info) {
      const t = now();
      const gap = lastFrameMs === null ? 0 : t - lastFrameMs;
      lastFrameMs = t;
      if (firstFrameMs === null) {
        firstFrameMs = round1(t);
        firstFrameDraws = info?.draws ?? null;
        if (info?.renderMs !== undefined && info.firstCallAt !== undefined && stages.size < MAX_STAGES - 2) {
          const callStart = t - info.renderMs;
          // The renderer was ready when the precompile began (it waits for an initialised renderer).
          const pre = info.precompile;
          const readyAt = pre !== undefined ? Math.min(pre.startedAt, callStart) : callStart;
          stages.set('rendererInit', { name: 'rendererInit', startMs: round1(Math.min(info.firstCallAt, readyAt)), endMs: round1(readyAt) });
          if (pre !== undefined) stages.set('precompile', { name: 'precompile', startMs: round1(pre.startedAt), endMs: round1(pre.startedAt + pre.ms) });
          stages.set('firstRender', { name: 'firstRender', startMs: round1(callStart), endMs: round1(t) });
        }
      } else if (t - firstFrameMs <= FRAME_WATCH_MS) {
        addFrame(afterFirst, t, gap);
      }
      const draws = info?.draws;
      for (const l of loads) {
        if (l.attachedMs !== null && t - l.attachedMs > 0 && t - l.attachedMs <= FRAME_WATCH_MS) addFrame(l.after, t, gap);
        // Frames while it loads, and the fewest draws from the request to the end of the watch.
        if (l.attachedMs === null && l.error === undefined) {
          l.loadingFrames = (l.loadingFrames ?? 0) + 1;
          l.loadingWorstMs = Math.max(l.loadingWorstMs ?? 0, round1(gap));
        }
        if (draws !== undefined && (l.attachedMs === null || t - l.attachedMs <= FRAME_WATCH_MS)) l.drawsMin = l.drawsMin === null || l.drawsMin === undefined ? draws : Math.min(l.drawsMin, draws);
      }
      if (draws !== undefined) lastDraws = draws;
      for (const sceneId of info?.realizedScenes ?? []) {
        const l = pendingLoad(sceneId);
        if (l !== undefined && l.attachedMs === null) {
          l.attachedMs = round1(t);
          l.attachFrameMs = round1(gap);
          l.precompileMs = info?.precompile !== undefined ? round1(info.precompile.ms) : null;
          l.attachDraws = draws ?? null;
        }
      }
    },
    sceneRequested(sceneId, preloaded) {
      loads.push({ sceneId, requestedMs: round1(now()), readMs: null, entities: null, attachedMs: null, attachFrameMs: null, after: emptyWatch(), preloaded: preloaded === true, preparedMs: null, drawsBefore: lastDraws, attachDraws: null, drawsMin: null, loadingFrames: 0, loadingWorstMs: 0 });
      if (loads.length > MAX_SCENE_LOADS) loads.shift();
    },
    sceneRead(sceneId, entities) {
      const l = pendingLoad(sceneId);
      if (l === undefined || l.readMs !== null) return;
      l.readMs = round1(now());
      l.entities = entities;
    },
    scenePrepared(sceneId, entities) {
      const l = pendingLoad(sceneId);
      if (l === undefined) return;
      if (l.entities === null && entities !== undefined) l.entities = entities;
      // A scene read ahead was read before the request: its read counts as done then.
      if (l.readMs === null) l.readMs = l.requestedMs;
      l.preparedMs = round1(now());
    },
    sceneFailed(sceneId, message) {
      const l = pendingLoad(sceneId);
      if (l !== undefined) l.error = message.slice(0, 120);
    },
    report() {
      return {
        epochMs: Math.round(epochMs),
        stages: [...stages.values()].map((s) => ({ ...s })),
        firstFrameMs,
        firstFrameDraws,
        afterFirstFrame: { ...afterFirst, worst: [...afterFirst.worst] },
        sceneLoads: loads.map((l) => ({ ...l, after: { ...l.after, worst: [...l.after.worst] } })),
        counts: { ...counts },
      };
    },
  };
}
