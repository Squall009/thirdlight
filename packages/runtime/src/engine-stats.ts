/**
 * The engine's frame statistics as the page reports them (`ctx.stats`,
 * `$flow.stats`): checked when they arrive, held for scripts to read.
 * Presentation, like the view size: the host reports them once per stats
 * window, outside the input frame, so they are never in the digest or a
 * save.
 */
import type { BehaviorStats, BehaviorStatsTime } from './types-behavior-world';

/**
 * The window the page measures frame times over (ms): the average and the
 * worst frame of the last half second, as a game's FPS counter shows them
 * (long enough to average, short enough to show a hitch). Also how often the
 * stats reach scripts and UI documents.
 */
export const STATS_WINDOW_MS = 500;

/** What `ctx.stats` reads before the first window ends. */
export const ENGINE_STATS_NONE: BehaviorStats = Object.freeze({
  fps: 0,
  frameMs: Object.freeze({ avg: 0, worst: 0 }),
  cpuMs: Object.freeze({ avg: 0, worst: 0 }),
  gpuMs: null,
  drawCalls: 0,
  triangles: 0,
  textureBytes: 0,
  textureBudgetBytes: 0,
  geometryBytes: 0,
  entities: 0,
  quality: 'high',
  windowMs: 0,
});

const QUALITY = new Set(['low', 'medium', 'high']);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const timeOf = (v: unknown): BehaviorStatsTime | null => {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as Record<string, unknown>;
  return count(t['avg']) && count(t['worst']) ? Object.freeze({ avg: t['avg'], worst: t['worst'] }) : null;
};

/** Reported stats, checked (null: not stats — a field missing, negative or not a number). */
export function engineStatsOf(v: unknown): BehaviorStats | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  const frameMs = timeOf(s['frameMs']);
  const cpuMs = timeOf(s['cpuMs']);
  const gpuMs = s['gpuMs'] === null ? null : timeOf(s['gpuMs']);
  if (frameMs === null || cpuMs === null || (s['gpuMs'] !== null && gpuMs === null)) return null;
  const n = ['fps', 'drawCalls', 'triangles', 'textureBytes', 'textureBudgetBytes', 'geometryBytes', 'entities', 'windowMs'] as const;
  for (const k of n) if (!count(s[k])) return null;
  if (typeof s['quality'] !== 'string' || !QUALITY.has(s['quality'])) return null;
  return Object.freeze({
    fps: s['fps'] as number,
    frameMs,
    cpuMs,
    gpuMs,
    drawCalls: s['drawCalls'] as number,
    triangles: s['triangles'] as number,
    textureBytes: s['textureBytes'] as number,
    textureBudgetBytes: s['textureBudgetBytes'] as number,
    geometryBytes: s['geometryBytes'] as number,
    entities: s['entities'] as number,
    quality: s['quality'],
    windowMs: s['windowMs'] as number,
  });
}

/** The last stats the page reported (`ctx.stats`). */
export class EngineStatsHolder {
  private current: BehaviorStats = ENGINE_STATS_NONE;

  /** Take reported stats (false: not stats; the last ones stay). */
  set(v: unknown): boolean {
    const s = engineStatsOf(v);
    if (s === null) return false;
    this.current = s;
    return true;
  }

  now(): BehaviorStats {
    return this.current;
  }
}
