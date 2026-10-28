/**
 * "Bake lighting": the live lighting run until it settles, then saved.
 *
 * The bake is the live system itself, on the page's WebGPU device, with
 * three changes for its run:
 *
 * - every tile of the loaded scene is resident at one level, the finest at
 *   which all of them and its terrains' rings fit `SAVED_SURFACE_CACHE_MIB`
 *   (a low-tier device then holds the saved light whole), not by distance
 *   from the eye; each terrain's rings start at that level and stand round
 *   the scene's content (its tiles and lights; else its terrains), out to
 *   the terrain's far edge;
 * - the lights' modes decide what is saved (`savedLights`): first the
 *   `baked` and `mixed` lights light the cache, then the probes start over
 *   from it (`LiveProbes.restart`: none of the live light's past) and
 *   settle on their bounce; then, the probes held, only the `baked` lights' direct
 *   light settles in the cache (a `mixed` light's direct light is drawn per
 *   pixel, a `realtime` light's is never saved);
 * - the budget is the most a frame may spend (`SURFACE_LIGHT_MS_MAX`);
 * - with `owns`, one scene of the loaded ones is saved: the level is
 *   fitted over its tiles, and it saves its tiles (their pages only), the
 *   probes over them and its own lights (`ownSavedLight`); the other
 *   scenes are lit beside it, as they light and shade it.
 *
 * The cache's pages and the scene's terrains' rings are then read back,
 * with each resident tile's place and the probes' tiles as the probe
 * lighting holds them; the page goes back to its own residency, budget and
 * lights.
 */
import { SAVED_SURFACE_CACHE_MIB, SURFACE_LIGHT_MS_MAX } from '@thirdlight/runtime';

import { SURFACE_LEVELS, SURFACE_PAGE_TEXELS, SURFACE_TEXEL_BYTES } from './surface-cache-atlas';
import { TERRAIN_RING_SHARE } from './surface-cache';
import { TERRAIN_RING_TEXELS, TERRAIN_RINGS_MAX } from './surface-cache-terrain';
import type { SurfaceCacheHost } from './surface-cache-host';
import type { SavedProbeTile, SavedRingsRecord, SavedSurfaceLight } from './surface-bake-file';
import type { SurfaceLightRuntime } from './surface-light-runtime';
import type { CacheLight } from './surface-changes';
import { GPU_BUFFER_USAGE, GPU_MAP_READ, type GpuBuffer, type GpuTexture, type TracerDevice } from './tracer-gpu';
import type { SurfaceTile } from './surface-cache';
import { GLOW_LIGHT_MARK } from './surface-highlights';

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
  /** Whether an entity is of the scene being saved (absent: every loaded scene's surfaces are saved). */
  owns?(entityId: string): boolean;
  /** Draw one frame of the page (the bake runs on the frames drawn). */
  frame(): Promise<void>;
  onProgress?(text: string, fraction: number): void;
  signal?: AbortSignal;
}

export type SurfaceBakeOutcome = { ok: true; saved: SavedSurfaceLight; millis: number; texels: number } | { ok: false; message: string };

const MAP_READ = GPU_MAP_READ;
const COPY_DST = GPU_BUFFER_USAGE.COPY_DST;

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
    const prepared = host.preparedTiles() ?? [];
    const ownTile = (key: string): boolean => o.owns === undefined || o.owns(surfaceKeyOwner(key));
    const own = prepared.filter((t) => ownTile(t.key));
    const at = ringsCentre(own, h.lights().filter((l) => ownTile(l.id)), host.cache.ringTerrains().filter(ownTile).map((k) => host.cache.ringsOf(k)!.source));
    // The finest level whose pages and rings fit the saved budget.
    let level = SURFACE_LEVELS - 1;
    for (let l = 0; l < SURFACE_LEVELS; l += 1) if (host.cache.bytesAt(own, l) + host.cache.bakeRingBytes(l, at, ownTile) <= savedBytes) {
      level = l;
      break;
    }
    // The other open scenes' tiles are lit beside it at the same level, given room up to as much again (coarser past it).
    const others = Math.min(savedBytes, host.cache.bytesAt(prepared.filter((t) => !ownTile(t.key)), level));
    host.setBudget(Math.ceil((savedBytes + others) / (1 - TERRAIN_RING_SHARE)) + host.cache.bakeRingBytes(level, at));
    host.cache.setBakeLevel(level, at);
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
    const tiles = host.savedTiles().filter((t) => ownTile(t.key));
    let pages = 0;
    let texelCount = 0;
    for (const t of tiles) for (const b of t.blocks) {
      pages = Math.max(pages, b.page + 1);
      texelCount += b.side * b.side;
    }
    const texels = await readLayers(device, atlas, SURFACE_PAGE_TEXELS, 0, pages);
    const rings: SavedRingsRecord[] = [];
    const ringTex = rt.textures.rings;
    for (const [ti, key] of host.cache.ringTerrains().entries()) {
      const r = host.cache.ringsOf(key);
      const centres = r?.centresNow() ?? [];
      if (r === null || ringTex === null || !ownTile(key) || r.rings === 0 || centres.some((c) => c === null)) continue;
      rings.push({ terrain: key, first: r.first, centres: centres as [number, number][], texels: await readLayers(device, ringTex, TERRAIN_RING_TEXELS, ti * TERRAIN_RINGS_MAX, r.rings) });
    }
    const all = { level, pages, texels, tiles, probes: h.probeTiles(), lights: [...h.lights()], ...(rings.length > 0 ? { rings } : {}) };
    const saved = o.owns === undefined ? all : ownSavedLight(all, own, o.owns);
    return { ok: true, saved, millis: Math.round(performance.now() - t0), texels: texelCount };
  } finally {
    host.seeding.hold(false);
    h.setPart(null);
    host.cache.setBakeLevel(null);
    host.setBudget(before.bytes);
    host.setRelightBudget(before.ms);
  }
}

/**
 * Where a bake's terrain rings stand (x, z): the middle of the scene's
 * tiles and of its lights that have a place (a glowing sign on bare ground
 * has no tile), else of its terrains.
 */
function ringsCentre(tiles: readonly Pick<SurfaceTile, 'min' | 'max'>[], lights: readonly CacheLight[], terrains: readonly { readonly min: readonly number[]; readonly max: readonly number[] }[]): [number, number] {
  const boxes: { min: readonly number[]; max: readonly number[] }[] = [...tiles];
  for (const l of lights) if (l.kind !== 'directional') boxes.push({ min: l.position, max: l.position });
  if (boxes.length === 0) boxes.push(...terrains);
  if (boxes.length === 0) return [0, 0];
  const x0 = Math.min(...boxes.map((b) => b.min[0]!));
  const x1 = Math.max(...boxes.map((b) => b.max[0]!));
  const z0 = Math.min(...boxes.map((b) => b.min[2]!));
  const z1 = Math.max(...boxes.map((b) => b.max[2]!));
  return [(x0 + x1) / 2, (z0 + z1) / 2];
}

/** `count` layers of an array texture of `side`² RGBA half floats, from layer `first`. */
async function readLayers(device: TracerDevice, texture: GpuTexture, side: number, first: number, count: number): Promise<Uint16Array> {
  if (count === 0) return new Uint16Array(0);
  const bytesPerRow = side * SURFACE_TEXEL_BYTES;
  const buffer: GpuBuffer = device.createBuffer({ size: count * side * bytesPerRow, usage: MAP_READ | COPY_DST, label: 'surface bake read' });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer!({ texture, origin: { x: 0, y: 0, z: first } }, { buffer, bytesPerRow, rowsPerImage: side }, { width: side, height: side, depthOrArrayLayers: count });
  device.queue.submit([enc.finish()]);
  await buffer.mapAsync(MAP_READ);
  const out = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return out;
}

/** The entity a surface tile's key (`<entity>/…`, an architecture object's id) or a cache light's id (`<entity>#glow…`) is of. */
export function surfaceKeyOwner(key: string): string {
  const glow = key.indexOf(GLOW_LIGHT_MARK);
  const k = glow >= 0 ? key.slice(0, glow) : key;
  const slash = k.indexOf('/');
  return slash >= 0 ? k.slice(0, slash) : k;
}

/**
 * One scene's part of a bake read back over every loaded scene: its tiles
 * (already `saved.tiles`) on their pages only, packed down in order; the
 * probe tiles whose box meets one of its tiles (`own`, as prepared); its
 * own lights. Another scene's probes or lights saved with it would be
 * merged with that scene's own bake when both are loaded.
 */
export function ownSavedLight(saved: SavedSurfaceLight, own: readonly Pick<SurfaceTile, 'min' | 'max'>[], owns: (entityId: string) => boolean): SavedSurfaceLight {
  const used = [...new Set(saved.tiles.flatMap((t) => t.blocks.map((b) => b.page)))].sort((a, b) => a - b);
  const pageOf = new Map(used.map((p, i) => [p, i]));
  const halves = SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS * 4;
  const texels = new Uint16Array(used.length * halves);
  used.forEach((p, i) => texels.set(saved.texels.subarray(p * halves, (p + 1) * halves), i * halves));
  const tiles = saved.tiles.map((t) => ({ ...t, blocks: t.blocks.map((b) => ({ ...b, page: pageOf.get(b.page)! })) }));
  const meets = (p: SavedProbeTile): boolean => own.some((t) => [0, 1, 2].every((k) => p.min[k]! <= t.max[k]! && p.max[k]! >= t.min[k]!));
  const lights = saved.lights?.filter((l) => owns(surfaceKeyOwner(l.id)));
  const rings = saved.rings?.filter((r) => owns(surfaceKeyOwner(r.terrain)));
  return { level: saved.level, pages: used.length, texels, tiles, probes: saved.probes.filter(meets), ...(lights !== undefined ? { lights } : {}), ...(rings !== undefined && rings.length > 0 ? { rings } : {}) };
}
