/**
 * Runs the far world's columns through a pool of `worker_threads` workers
 * (far-worker-node.ts): writing the world, and building its far cache, with
 * a disk guard between columns; and the far selection measured over a
 * built cache (nodes drawn per level and distance from a few eyes).
 */
import { statfsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { buildFarCache, FarCacheReader, type FarBuildReport, type FarColumnResult } from '@thirdlight/workspace';
import { FarSelection, type FarSelected } from '@thirdlight/voxel';
import { farWorldColumns, farWorldDirs, finishFarWorld, type FarColumnWrite, type FarWorldOptions } from './far-world';
import type { FarWorkerTask } from './far-worker-node';

/** Free bytes on the file system holding `dir`. */
export function freeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

type Answer = { id: number; ok: true; result: unknown; ms?: number } | { id: number; ok: false; error: string };

/** A pool of far workers: tasks in, answers out in completion order. */
export class FarPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly waiting = new Map<number, (a: Answer) => void>();
  private seq = 0;

  constructor(file: string, n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(file);
      w.on('message', (a: Answer) => {
        const done = this.waiting.get(a.id);
        this.waiting.delete(a.id);
        this.idle.push(w);
        done?.(a);
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /** Runs tasks with every worker busy; `each` sees each answer as it lands; `stop` ends the run early (between tasks). */
  async run<T>(tasks: ReadonlyArray<Omit<FarWorkerTask, 'id'>>, each: (result: T, index: number, ms: number | undefined) => void, stop: () => string | null = () => null): Promise<string | null> {
    let next = 0;
    let stopped: string | null = null;
    let failure: Error | null = null;
    await new Promise<void>((resolve) => {
      let running = 0;
      const pump = (): void => {
        while (stopped === null && failure === null && next < tasks.length && this.idle.length > 0) {
          const why = stop();
          if (why !== null) {
            stopped = why;
            break;
          }
          const w = this.idle.pop()!;
          const index = next++;
          const id = ++this.seq;
          running++;
          this.waiting.set(id, (a) => {
            running--;
            if (a.ok) each(a.result as T, index, a.ms);
            else failure = new Error(a.error);
            pump();
          });
          w.postMessage({ ...tasks[index]!, id });
        }
        if (running === 0) resolve();
      };
      pump();
    });
    if (failure !== null) throw failure;
    return stopped;
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

export interface FarWorldReport {
  readonly dir: string;
  readonly columns: number;
  readonly files: number;
  readonly bytes: number;
  readonly uniform: number;
  readonly stored: number;
  readonly ms: number;
  /** Why it stopped before the last column (the disk guard), or null. */
  readonly stopped: string | null;
}

/**
 * Writes the far world into `projectDir` (`voxels/<name>/`) column by
 * column through the pool; the manifest last, once every column is written.
 * Stops between columns when the disk has less than `reserveBytes` free
 * (no manifest then: an unfinished world is not a world). `limit` writes
 * only that many columns, spread over the world, for an estimate.
 */
export async function writeFarWorld(pool: FarPool, projectDir: string, opts: FarWorldOptions & { name?: string; reserveBytes: number; limit?: number; onColumn?: (done: number, of: number, w: FarColumnWrite) => void }): Promise<FarWorldReport> {
  const t0 = performance.now();
  const { dir, gridDir } = farWorldDirs(projectDir, opts.name);
  const all = farWorldColumns(opts.sizeKm);
  // An estimate takes columns spread evenly over the world (centre to corners), not just the middle.
  const cols = opts.limit === undefined ? all : all.filter((_, i) => i % Math.max(1, Math.floor(all.length / opts.limit!)) === 0).slice(0, opts.limit);
  const files: string[] = [];
  let bytes = 0, uniform = 0, stored = 0, done = 0;
  const tasks = cols.map(([rx, rz]) => ({ kind: 'world' as const, gridDir, rx, rz, opts: { ...(opts.seed !== undefined ? { seed: opts.seed } : {}), ...(opts.sizeKm !== undefined ? { sizeKm: opts.sizeKm } : {}), ...(opts.style !== undefined ? { style: opts.style } : {}) } }));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(gridDir, { recursive: true });
  const stopped = await pool.run<FarColumnWrite>(
    tasks,
    (w) => {
      files.push(...w.files);
      bytes += w.bytes;
      uniform += w.uniform;
      stored += w.stored;
      done++;
      opts.onColumn?.(done, cols.length, w);
    },
    () => (freeBytes(gridDir) < opts.reserveBytes ? `disk: under ${(opts.reserveBytes / 2 ** 30).toFixed(1)} GiB free` : null),
  );
  if (stopped === null && opts.limit === undefined) finishFarWorld(dir, files);
  return { dir, columns: done, files: files.length, bytes, uniform, stored, ms: performance.now() - t0, stopped };
}

/** Builds a world's far cache with the region columns in the pool. */
export function buildFarCacheInPool(pool: FarPool, worldDir: string, cacheDir: string, minLevel?: number, onColumn?: (done: number, of: number) => void): Promise<FarBuildReport> {
  return buildFarCache(worldDir, cacheDir, {
    ...(minLevel !== undefined ? { minLevel } : {}),
    run: (columns, min) => ({
      async *[Symbol.asyncIterator]() {
        const out: FarColumnResult[] = [];
        let wake: (() => void) | null = null;
        let finished = false;
        let failed: unknown = null;
        let done = 0;
        void pool
          .run<FarColumnResult>(
            columns.map(([rx, rz]) => ({ kind: 'far' as const, worldDir, rx, rz, minLevel: min })),
            (r) => {
              out.push(r);
              onColumn?.(++done, columns.length);
              wake?.();
            },
          )
          .then(
            () => {
              finished = true;
              wake?.();
            },
            (e: unknown) => {
              failed = e;
              finished = true;
              wake?.();
            },
          );
        for (;;) {
          while (out.length > 0) yield out.shift()!;
          if (failed !== null) throw failed;
          if (finished) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    }),
  });
}

/** Pixels a radian at 720p with a 60° vertical field of view: what the far selection's error is measured at. */
export const PIXELS_PER_RADIAN_720P = 720 / (2 * Math.tan(Math.PI / 6));

/** The far selection seen from one eye: nodes per level, bytes, and nodes per distance band (km). */
export interface FarViewReport {
  readonly eye: readonly [number, number, number];
  readonly errorPixels: number;
  readonly drawn: number;
  readonly perLevel: Record<string, number>;
  readonly bytes: number;
  readonly heldByBudget: number;
  /** Drawn nodes by the distance (km) of their box from the eye: [0, 1), [1, 2), [2, 4), [4, 8), [8, ∞). */
  readonly perBand: number[];
  /** The coarsest level drawn in each band (−1: none). */
  readonly bandLevel: number[];
  readonly ms: number;
}

const BANDS_KM = [1, 2, 4, 8];

/** Measures the far selection over a built cache from `eyes` (cells) at each error. */
export function measureFarSelection(cacheDir: string, eyes: ReadonlyArray<readonly [number, number, number]>, errors: readonly number[], near: { half: number; height: number } | null): FarViewReport[] {
  const index = new FarCacheReader(cacheDir).index();
  const out: FarViewReport[] = [];
  for (const errorPixels of errors) for (const eye of eyes) {
    const sel = new FarSelection();
    const nearBox = near === null ? null : { min: [eye[0] - near.half, eye[1] - near.height, eye[2] - near.half] as const, max: [eye[0] + near.half, eye[1] + near.height, eye[2] + near.half] as const };
    const t0 = performance.now();
    const s: FarSelected = sel.select(index, { eye, pixelsPerRadian: PIXELS_PER_RADIAN_720P, errorPixels, near: nearBox });
    const ms = performance.now() - t0;
    const perLevel: Record<string, number> = {};
    const perBand = [0, 0, 0, 0, 0];
    const bandLevel = [-1, -1, -1, -1, -1];
    for (const d of s.drawn) {
      perLevel[`L${d.node.level}`] = (perLevel[`L${d.node.level}`] ?? 0) + 1;
      const km = d.distance / 2000;
      let b = BANDS_KM.findIndex((x) => km < x);
      if (b < 0) b = BANDS_KM.length;
      perBand[b]!++;
      bandLevel[b] = Math.max(bandLevel[b]!, d.node.level);
    }
    out.push({ eye, errorPixels, drawn: s.drawn.length, perLevel, bytes: s.bytes, heldByBudget: s.heldByBudget, perBand, bandLevel, ms });
  }
  return out;
}
