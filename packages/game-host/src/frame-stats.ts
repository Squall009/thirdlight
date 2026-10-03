/**
 * The engine's frame statistics, measured on the page: the time from one
 * frame to the next, the page thread's work per frame, the GPU's time where
 * timestamp queries exist (null otherwise: "not measured", never estimated),
 * each as the average and the worst frame over a window (`STATS_WINDOW_MS`),
 * with the last frame's draw calls and triangles, the resident texture and
 * geometry bytes against the texture budget, the objects and the quality
 * level. One snapshot per window feeds `ctx.stats`, `$flow.stats`, the stats
 * overlay and Play diagnostics, so they all read the same numbers.
 */
import { STATS_WINDOW_MS, type BehaviorStats, type BehaviorStatsTime } from '@thirdlight/runtime';

/** What one window's snapshot is made from, read when the window ends. */
export interface FrameStatsSources {
  /** The last frame's draw calls and triangles (absent: no frame drawn yet). */
  readonly frame: () => { drawCalls: number; triangles: number } | undefined;
  /** GPU time measured since the last call; null where the renderer measures none. */
  readonly gpu: () => { ms: number; frames: number; worst: number } | null;
  /** Resident texture bytes and the budget (absent: no texture streamer). */
  readonly textures: () => { residentBytes: number; budgetBytes: number } | undefined;
  /** Geometry bytes of the loaded models. */
  readonly geometryBytes: () => number;
  readonly entities: () => number;
  readonly quality: () => string;
}

export interface FrameStats {
  /**
   * One frame: `cpuMs` of page work, ended at `now` (performance.now ms).
   * True when this frame ended a window (a new snapshot).
   */
  frame(cpuMs: number, now: number): boolean;
  /** The last window's snapshot (null before the first window ends). */
  snapshot(): BehaviorStats | null;
}

const round = (v: number): number => Math.round(v * 100) / 100;
const time = (sum: number, n: number, worst: number): BehaviorStatsTime => ({ avg: n > 0 ? round(sum / n) : 0, worst: round(worst) });

export function createFrameStats(sources: FrameStatsSources, windowMs: number = STATS_WINDOW_MS): FrameStats {
  let windowStart: number | null = null;
  let lastFrameAt: number | null = null;
  let frames = 0;
  let intervals = 0;
  let intervalSum = 0;
  let intervalWorst = 0;
  let cpuSum = 0;
  let cpuWorst = 0;
  let current: BehaviorStats | null = null;
  return {
    frame(cpuMs, now) {
      if (windowStart === null) windowStart = now;
      if (lastFrameAt !== null) {
        const dt = Math.max(0, now - lastFrameAt);
        intervals += 1;
        intervalSum += dt;
        intervalWorst = Math.max(intervalWorst, dt);
      }
      lastFrameAt = now;
      frames += 1;
      cpuSum += Math.max(0, cpuMs);
      cpuWorst = Math.max(cpuWorst, cpuMs);
      const elapsed = now - windowStart;
      if (elapsed < windowMs) return false;
      const gpu = sources.gpu();
      const tex = sources.textures();
      const f = sources.frame();
      current = {
        fps: round((intervals * 1000) / Math.max(1, intervalSum)),
        frameMs: time(intervalSum, intervals, intervalWorst),
        cpuMs: time(cpuSum, frames, cpuWorst),
        gpuMs: gpu === null ? null : time(gpu.ms, gpu.frames, gpu.worst),
        drawCalls: f?.drawCalls ?? 0,
        triangles: f?.triangles ?? 0,
        textureBytes: tex?.residentBytes ?? 0,
        textureBudgetBytes: tex?.budgetBytes ?? 0,
        geometryBytes: Math.max(0, sources.geometryBytes()),
        entities: sources.entities(),
        quality: sources.quality(),
        windowMs: round(elapsed),
      };
      windowStart = now;
      frames = 0;
      intervals = 0;
      intervalSum = 0;
      intervalWorst = 0;
      cpuSum = 0;
      cpuWorst = 0;
      return true;
    },
    snapshot: () => current,
  };
}

/** What the host gives its stats: the adapter, the runtime and the page's resource views, read when a window ends. */
export interface HostStatsDeps {
  readonly adapter: () => { diagnostics?(): { ok: true; diagnostics: { frame?: { drawCalls: number; triangles: number } } } | { ok: false }; takeGpuTime?(): { ms: number; frames: number; worst: number } | null; qualityLevel?(): string } | null;
  readonly entities: () => number;
  /** The texture streamer's observation (resident and budget bytes). */
  readonly textureStreaming?: () => object;
  /** The page's resources (geometry bytes: the models' resident bytes without the images inside them). */
  readonly resources?: { observe(): { resident: Readonly<Record<string, { bytes: number; textures?: { bytes: number } } | undefined>> } };
  /** The simulation is in a worker: the page's work for a frame starts when its frame arrives. */
  readonly worker: boolean;
  /** A new window's stats (to the simulation, the overlay). */
  readonly published: (stats: BehaviorStats) => void;
}

export interface HostStats {
  /** The host's frame begins (its per-frame work, after the simulation's steps on the page). */
  begin(): void;
  /** The frame's draw calls were submitted. */
  end(): void;
  snapshot(): BehaviorStats | null;
}

/** Geometry bytes over the model kinds' resident resources (their own bytes without the images inside them). */
export function geometryBytesOf(resident: Readonly<Record<string, { bytes: number; textures?: { bytes: number } } | undefined>>): number {
  let n = 0;
  for (const kind of ['model', 'effect-model']) {
    const r = resident[kind];
    if (r !== undefined) n += r.bytes - (r.textures?.bytes ?? 0);
  }
  return n;
}

export function createHostStats(deps: HostStatsDeps): HostStats {
  const stats = createFrameStats({
    frame: () => {
      const d = deps.adapter()?.diagnostics?.();
      return d !== undefined && d.ok ? d.diagnostics.frame : undefined;
    },
    gpu: () => deps.adapter()?.takeGpuTime?.() ?? null,
    textures: () => {
      const t = deps.textureStreaming?.() as { residentBytes?: unknown; budgetBytes?: unknown } | undefined;
      return t !== undefined && typeof t.residentBytes === 'number' && typeof t.budgetBytes === 'number' ? { residentBytes: t.residentBytes, budgetBytes: t.budgetBytes } : undefined;
    },
    geometryBytes: () => (deps.resources !== undefined ? geometryBytesOf(deps.resources.observe().resident) : 0),
    entities: deps.entities,
    quality: () => deps.adapter()?.qualityLevel?.() ?? 'high',
  });
  let start = 0;
  return {
    begin() {
      const now = performance.now();
      // On the page thread the frame began with its steps, at the animation frame's time.
      const frameTime = (globalThis as { document?: { timeline?: { currentTime?: unknown } } }).document?.timeline?.currentTime;
      start = !deps.worker && typeof frameTime === 'number' && frameTime <= now ? frameTime : now;
    },
    end() {
      const now = performance.now();
      if (stats.frame(now - start, now)) deps.published(stats.snapshot()!);
    },
    snapshot: () => stats.snapshot(),
  };
}
