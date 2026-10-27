/**
 * "Bake lighting": the live lighting run until it settles, then saved.
 *
 * The bake is the live system itself, on the page's WebGPU device, with
 * three changes for its run:
 *
 * - every tile of the loaded scene is resident at one level, the finest at
 *   which all of them fit `SAVED_SURFACE_CACHE_MIB` (a low-tier device then
 *   holds the saved light whole), not by distance from the eye;
 * - the lights' modes decide what is saved (`savedLights`): first the
 *   `baked` and `mixed` lights light the cache, then the probes start over
 *   from it (`LiveProbes.restart`: none of the live light's past) and
 *   settle on their bounce; then, the probes held, only the `baked` lights' direct
 *   light settles in the cache (a `mixed` light's direct light is drawn per
 *   pixel, a `realtime` light's is never saved);
 * - the budget is the most a frame may spend (`SURFACE_LIGHT_MS_MAX`).
 *
 * The cache's pages are then read back, with each resident tile's place and
 * the probes' tiles as the probe lighting holds them; the page goes back to
 * its own residency, budget and lights.
 */
import { SAVED_SURFACE_CACHE_MIB, SURFACE_LIGHT_MS_MAX } from '@thirdlight/runtime';

import { SURFACE_LEVELS, SURFACE_PAGE_BYTES, SURFACE_PAGE_TEXELS, SURFACE_TEXEL_BYTES } from './surface-cache-atlas';
import { TERRAIN_RING_SHARE } from './surface-cache';
import type { SurfaceCacheHost } from './surface-cache-host';
import type { SavedProbeTile, SavedSurfaceLight } from './surface-bake-file';
import type { SurfaceLightRuntime } from './surface-light-runtime';
import type { CacheLight } from './surface-changes';
import type { GpuBuffer, GpuTexture, TracerDevice } from './tracer-gpu';

const MIB = 1024 * 1024;
/** A bake that has not settled in this long (ms) gives up. */
export const BAKE_TIMEOUT_MS = 20 * 60 * 1000;
/** Frames drawn after each change of the bake's lights before settling is asked (the lights reach the cache's marks a frame later). */
const BAKE_SWITCH_FRAMES = 4;
/**
 * Frames in a row the light must stay settled, the probes placed the same,
 * before it is saved: the probes are placed again when what they stand on
 * arrives (rooms, a surface made), and a placement's new probes are briefly
 * settled before their first update.
 */
const BAKE_STEADY_FRAMES = 20;

/** Which part of the saved light the cache holds during a bake (null: every light, live). */
export type BakePart = 'bounce' | 'direct' | null;

/** What a bake drives on the page's live lighting. */
export interface SurfaceBakeHooks {
  readonly host: SurfaceCacheHost;
  setPart(part: BakePart): void;
  /** The live runtime (null: not running yet, or never: `off` says why). */
  runtime(): SurfaceLightRuntime | null;
  device(): TracerDevice | null;
  /** Why the light is not live (null: it is). */
  off(): string | null;
  /** The probes' tiles as the probe lighting holds them now. */
  probeTiles(): readonly SavedProbeTile[];
  /** The lights whose light the bake keeps (baked and mixed), as they are now. */
  lights(): readonly CacheLight[];
}

export interface SurfaceBakeOptions {
  /** Draw one frame of the page (the bake runs on the frames drawn). */
  frame(): Promise<void>;
  onProgress?(text: string, fraction: number): void;
  signal?: AbortSignal;
}

export type SurfaceBakeOutcome = { ok: true; saved: SavedSurfaceLight; millis: number; texels: number } | { ok: false; message: string };

const MAP_READ = 0x1;
const COPY_DST = 0x8;

/** Run the page's live lighting to settled and read back what it saved. */
export async function runSurfaceBake(h: SurfaceBakeHooks, o: SurfaceBakeOptions): Promise<SurfaceBakeOutcome> {
  const { host } = h;
  const t0 = performance.now();
  const before = { ms: host.relightBudgetMs, bytes: host.cache.budgetBytes };
  const savedBytes = SAVED_SURFACE_CACHE_MIB * MIB;
  const until = async (done: () => boolean, text: string, fraction: number): Promise<string | null> => {
    o.onProgress?.(text, fraction);
    for (;;) {
      if (o.signal?.aborted === true) return 'the bake was cancelled';
      if (performance.now() - t0 > BAKE_TIMEOUT_MS) return `the lighting did not settle in ${BAKE_TIMEOUT_MS / 60000} minutes`;
      await o.frame();
      const off = h.off();
      if (off !== null && off !== 'starting') return off === 'no-webgpu' ? 'baking lighting needs WebGPU (the Scene view draws with WebGL 2)' : `the live lighting is off (${off})`;
      if (done()) return null;
    }
  };
  const frames = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) await o.frame();
  };
  try {
    // Lit from what the scene is, not from the last bake.
    host.seeding.hold(true);
    host.setRelightBudget(SURFACE_LIGHT_MS_MAX);
    // Room for the terrain's rings beside the saved pages (the rings light the ground the probes see; they are not saved).
    host.setBudget(Math.ceil(savedBytes / (1 - TERRAIN_RING_SHARE)));
    let why = await until(() => h.runtime() !== null && host.preparedTiles() !== null, 'starting the live lighting…', 0);
    if (why !== null) return { ok: false, message: why };
    const level = host.cache.fitLevel(host.preparedTiles() ?? [], savedBytes) ?? SURFACE_LEVELS - 1;
    host.cache.setBakeLevel(level);
    h.setPart('bounce');
    await frames(BAKE_SWITCH_FRAMES);
    why = await until(() => host.relight.isSettled, 'lighting the surfaces…', 0.05);
    if (why !== null) return { ok: false, message: why };
    // The probes start over from the settled cache: what they blended in before (the live light's levels, lights
    // and geometry since changed) would linger in the saved probes.
    host.probes.restart();
    let steady = 0;
    let layout = -1;
    const settledSteadily = (): boolean => {
      const ok = host.relight.isSettled && host.diagnostics().probes.settled && host.probes.layout === layout;
      layout = host.probes.layout;
      steady = ok ? steady + 1 : 0;
      return steady >= BAKE_STEADY_FRAMES;
    };
    why = await until(settledSteadily, 'lighting the probes…', 0.1);
    if (why !== null) return { ok: false, message: why };
    // The probes hold the baked and mixed lights' bounce; the cache keeps only what is drawn as saved.
    host.probes.setBudget(0);
    h.setPart('direct');
    await frames(BAKE_SWITCH_FRAMES);
    why = await until(() => host.relight.isSettled, 'keeping the baked lights…', 0.7);
    if (why !== null) return { ok: false, message: why };
    const rt = h.runtime();
    const device = h.device();
    const atlas = rt?.textures.atlas ?? null;
    if (rt === null || device === null || atlas === null) return { ok: false, message: 'the live lighting stopped during the bake' };
    o.onProgress?.('reading the light back…', 0.85);
    const tiles = host.savedTiles();
    let pages = 0;
    let texelCount = 0;
    for (const t of tiles) for (const b of t.blocks) {
      pages = Math.max(pages, b.page + 1);
      texelCount += b.side * b.side;
    }
    const texels = await readPages(device, atlas, pages);
    const probes = h.probeTiles();
    return { ok: true, saved: { level, pages, texels, tiles, probes, lights: [...h.lights()] }, millis: Math.round(performance.now() - t0), texels: texelCount };
  } finally {
    host.seeding.hold(false);
    h.setPart(null);
    host.cache.setBakeLevel(null);
    host.setBudget(before.bytes);
    host.setRelightBudget(before.ms);
  }
}

/** The atlas's first `pages` pages as RGBA half floats. */
async function readPages(device: TracerDevice, atlas: GpuTexture, pages: number): Promise<Uint16Array> {
  if (pages === 0) return new Uint16Array(0);
  const bytesPerRow = SURFACE_PAGE_TEXELS * SURFACE_TEXEL_BYTES;
  const buffer: GpuBuffer = device.createBuffer({ size: pages * SURFACE_PAGE_BYTES, usage: MAP_READ | COPY_DST, label: 'surface bake read' });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer!({ texture: atlas, origin: { x: 0, y: 0, z: 0 } }, { buffer, bytesPerRow, rowsPerImage: SURFACE_PAGE_TEXELS }, { width: SURFACE_PAGE_TEXELS, height: SURFACE_PAGE_TEXELS, depthOrArrayLayers: pages });
  device.queue.submit([enc.finish()]);
  await buffer.mapAsync(MAP_READ);
  const out = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return out;
}
