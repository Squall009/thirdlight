/**
 * A game page's voxel worlds as the surface cache lights them (the page's
 * lighting store is `cache`, `?voxelLight=cache`): every level-0 chunk's
 * drawn surface mesh is offered to the scene's surface cache as a tile
 * (`SurfaceVoxelSource`), marked to read the cache's light
 * (`SURFACE_READ.voxels`), and the traced rays walk the first world's
 * occupancy on the GPU (its walk buffers). A chunk drawn again (an edit, a
 * level change) is a new version of its tile.
 *
 * The cache is found through the link its adapter keeps on the scene
 * (`SURFACE_CACHE_KEY`: `voxels`), as the shadows' and decals' are.
 *
 * Pure of three.js but for the meshes it is handed.
 */
import type * as THREE from 'three';
import { frameBudgetMs, levelFrameBudget, type QualityLevelConfig } from '@thirdlight/project-model';
import { VOXEL_SIZE_M, walkRay, walkVoxels, type WalkSource, type WalkTable } from '@thirdlight/voxel';

import { SURFACE_READ } from './surface-cache-lookup';
import { SURFACE_READ_KEY } from './surface-cache-read';
import { SURFACE_CACHE_KEY, type SurfaceVoxelChunk, type SurfaceVoxelDiagnostics, type SurfaceVoxelSource } from './surface-cache-host';
import { voxelHitWords, walkSolidAt, type VoxelTileMesh } from './surface-cache-voxels';
import type { SurfaceTexel } from './surface-cache';
import { RESOLVE_PAGE } from './surface-resolve';
import { TRACE_MISS, TRACE_VOXELS, RAY_FLOATS } from './tracer-scene';
import type { TraceHit } from './tracer-cpu-math';
import { VOXEL_TRACE_SKIPS } from './tracer-wgsl';
import type { VoxelWalkBuffers } from './tracer-gpu';
import { VOXEL_CELL_KEY, type VoxelDecalSurfaces } from './voxel-chunk-view';
import { WALK_GPU_MAX_STEPS } from './voxel-walk-wgsl';
import { solidBlocksOf, type VoxelSolidBlocks } from './voxel-chart-worker';

/** What the scene's surface cache link offers a page's voxel worlds (the adapter puts it on `scene.userData[SURFACE_CACHE_KEY]`). */
export interface SurfaceCacheVoxelLink {
  voxels?(src: SurfaceVoxelSource | null): void;
  voxelDiagnostics?(): SurfaceVoxelDiagnostics;
  /** How far the light has caught up, cheap enough to read every frame: texels written so far, units stale, chunks waiting for charts, the probes settled and stale. */
  voxelProgress?(): VoxelLightProgress;
  /** Every texel and probe stale (a bench keeps the cache relighting to measure its GPU time while it has work). */
  voxelRelightAll?(): void;
  /** Traces `rays` (`RAY_FLOATS` each) on the GPU with the cache's tracer and reads the hits back (null: no live light yet). */
  traceRays?(rays: Float32Array): Promise<Uint32Array | null>;
  /** The texel a traced hit's light is in (null: a miss, or not resident). */
  resolveHit?(hit: TraceHit): SurfaceTexel | null;
  /** Traces `rays` and resolves their hits on the GPU and by the CPU twin over the same table (null: no live light or table yet). */
  resolveRays?(rays: Float32Array): Promise<VoxelResolveRays | null>;
}

/** How far a voxel page's cache light has caught up (`SurfaceCacheVoxelLink.voxelProgress`). */
export interface VoxelLightProgress {
  readonly texelsWritten: number;
  readonly staleUnits: number;
  readonly waiting: number;
  readonly probesSettled: boolean;
  readonly probesStale: number;
}

/** The probe rays' resolve on the GPU against its CPU twin (`SurfaceCacheVoxelLink.resolveRays`): the hits, the two texels a hit (two words each), and whether each GPU texel is lit. */
export interface VoxelResolveRays {
  readonly hits: Uint32Array;
  readonly gpu: Uint32Array;
  readonly cpu: Uint32Array;
  readonly lit: Uint8Array;
}

/** The scene's surface cache link (null: no cache on this page). */
export function surfaceCacheLinkOf(scene: THREE.Object3D): SurfaceCacheVoxelLink | null {
  return (scene.userData[SURFACE_CACHE_KEY] as SurfaceCacheVoxelLink | undefined) ?? null;
}

interface Chunk extends SurfaceVoxelChunk {
  mesh(): VoxelTileMesh | null;
}

/** The worlds' walks the feed reads: each world's GPU buffers and CPU table (absent: not on the GPU). */
export interface VoxelLightWalks {
  buffers(world: string): VoxelWalkBuffers | null;
  source(world: string): WalkSource | null;
  /** The world's walk table (what the GPU's blocks are uploaded from; absent: not on the GPU). */
  table?(world: string): WalkTable | null;
  worlds(): Iterable<string>;
}

export class VoxelLightFeed implements SurfaceVoxelSource {
  private readonly chunksBy = new Map<THREE.Mesh, Chunk>();
  private readonly versions = new Map<string, number>();
  private linked: SurfaceCacheVoxelLink | null = null;

  constructor(private readonly walks: VoxelLightWalks, private readonly level: () => QualityLevelConfig | null) {}

  /** The world the traced rays walk: the first with a walk on the GPU. */
  private walked(): string | null {
    for (const w of this.walks.worlds()) if (this.walks.buffers(w) !== null) return w;
    return null;
  }

  chunks(): Iterable<SurfaceVoxelChunk> {
    return this.chunksBy.values();
  }

  solidAt(x: number, y: number, z: number): boolean | null {
    const w = this.walked();
    const src = w === null ? null : this.walks.source(w);
    if (src === null) return null;
    // The probes' placement asks it for every probe: one reader a walk source.
    if (this.solidOf?.src !== src) this.solidOf = { src, at: walkSolidAt(src) };
    return this.solidOf.at(x, y, z);
  }

  private solidOf: { readonly src: WalkSource; readonly at: (x: number, y: number, z: number) => boolean | null } | null = null;

  solidBlocks(cell0: readonly number[], edge: number): VoxelSolidBlocks | null {
    const w = this.walked();
    const t = w === null ? null : (this.walks.table?.(w) ?? null);
    return t === null ? null : solidBlocksOf(t, cell0, edge);
  }

  walk(): VoxelWalkBuffers | null {
    const w = this.walked();
    return w === null ? null : this.walks.buffers(w);
  }

  get relightMs(): number {
    const l = this.level();
    return l === null ? 0 : frameBudgetMs(levelFrameBudget(l), 'gpu', 'lighting');
  }

  /** The listener a world's chunk view tells of its level-0 surfaces (beside its decals': `also`). */
  surfaces(world: string, edge: number, also: VoxelDecalSurfaces | null): VoxelDecalSurfaces {
    return {
      added: (o) => {
        also?.added(o);
        const mesh = o as THREE.Mesh;
        const cell = mesh.userData[VOXEL_CELL_KEY] as readonly [number, number, number] | undefined;
        if (cell === undefined) return;
        const key = `${world}/${cell[0]},${cell[1]},${cell[2]}`;
        const version = (this.versions.get(key) ?? 0) + 1;
        this.versions.set(key, version);
        mesh.userData[SURFACE_READ_KEY] = SURFACE_READ.voxels;
        const geo = mesh.geometry;
        this.chunksBy.set(mesh, {
          key,
          version,
          cell0: [cell[0], cell[1], cell[2]],
          edge,
          mesh: () => {
            const p = geo.getAttribute('position');
            const i = geo.index;
            return p === undefined || i === null ? null : { positions: p.array, indices: i.array };
          },
        });
      },
      removed: (o) => {
        also?.removed(o);
        this.chunksBy.delete(o as THREE.Mesh);
      },
      moved: (o) => also?.moved(o),
    };
  }

  /** Offer the worlds to the scene's cache (once it has one; again for a new scene). */
  link(scene: THREE.Object3D): void {
    const l = surfaceCacheLinkOf(scene);
    if (l === this.linked) return;
    this.linked?.voxels?.(null);
    this.linked = l;
    l?.voxels?.(this);
  }

  /** A world closed: its chunks go. */
  dropWorld(world: string): void {
    for (const [mesh, c] of this.chunksBy) if (c.key.startsWith(`${world}/`)) this.chunksBy.delete(mesh);
  }

  /** The page goes, or the store is no longer the cache: the cache lets the worlds go, their surfaces read it no more. */
  unlink(): void {
    this.linked?.voxels?.(null);
    this.linked = null;
    for (const mesh of this.chunksBy.keys()) delete mesh.userData[SURFACE_READ_KEY];
    this.chunksBy.clear();
  }

  /** What the cache holds of the worlds (null: no cache linked). */
  diagnostics(): SurfaceVoxelDiagnostics | null {
    return this.linked?.voxelDiagnostics?.() ?? null;
  }

  /** Every texel and probe of the cache stale (a bench measuring the light's GPU time while it has work). */
  relightAll(): void {
    this.linked?.voxelRelightAll?.();
  }

  /** How far the cache's light has caught up (null: no cache linked): read every frame by a bench timing an edit. */
  progress(): VoxelLightProgress | null {
    return this.linked?.voxelProgress?.() ?? null;
  }

  /**
   * The GPU tracer's voxel hits against the CPU walk's over the same blocks:
   * `rays` from round `at` (within `spread` metres) in random directions, up
   * to `reach` metres; both hits resolved to the cache's texels on the CPU.
   */
  async check(at: readonly number[], n: number, spread = 6, reach = 16): Promise<VoxelLightCheck | null> {
    const w = this.walked();
    const src = w === null ? null : this.walks.source(w);
    const l = this.linked;
    if (src === null || l?.traceRays === undefined || l.resolveHit === undefined) return null;
    const rays = checkRays(at, n, spread, reach);
    const t0 = performance.now();
    const words = await l.traceRays(rays);
    if (words === null) return null;
    const ms = performance.now() - t0;
    const out: VoxelLightCheck = { rays: n, gpuHits: 0, cpuHits: 0, hitMismatches: 0, resolved: 0, texelMismatches: 0, examples: [], ms };
    const f = new Float32Array(words.buffer, words.byteOffset, words.length);
    for (let k = 0; k < n; k++) {
      const o = k * 8;
      const kind = words[o + 4]! & 255;
      const gpu: TraceHit = { kind, t: f[o]!, normal: [f[o + 1]!, f[o + 2]!, f[o + 3]!], face: (words[o + 4]! >>> 8) & 255, object: words[o + 5]!, a0: words[o + 6]!, a1: words[o + 7]! };
      const cpu = cpuVoxelTrace(src, rays.subarray(k * RAY_FLOATS, k * RAY_FLOATS + RAY_FLOATS));
      if (gpu.kind === TRACE_VOXELS) out.gpuHits++;
      if (cpu.kind === TRACE_VOXELS) out.cpuHits++;
      const sameHit = gpu.kind === cpu.kind && (cpu.kind !== TRACE_VOXELS || (gpu.face === cpu.face && gpu.a0 === cpu.a0 && (gpu.a1 & 0xffff) === (cpu.a1 & 0xffff)));
      if (!sameHit) out.hitMismatches++;
      const tg = gpu.kind === TRACE_VOXELS ? l.resolveHit(gpu) : null;
      const tc = cpu.kind === TRACE_VOXELS ? l.resolveHit(cpu) : null;
      if (tg !== null) out.resolved++;
      const same = (tg === null && tc === null) || (tg !== null && tc !== null && JSON.stringify(tg) === JSON.stringify(tc));
      if (!same) {
        out.texelMismatches++;
        if (out.examples.length < 6) out.examples.push({ ray: k, gpu: { kind: gpu.kind, face: gpu.face, a0: gpu.a0, a1: gpu.a1, t: gpu.t, texel: tg }, cpu: { kind: cpu.kind, face: cpu.face, a0: cpu.a0, a1: cpu.a1, t: cpu.t, texel: tc } });
      }
    }
    return out;
  }

  /**
   * The resolve pass's texels for voxel hits against its CPU twin's, over
   * the table the probe rays read: `n` rays from round `at` as `check` casts
   * them, traced on the GPU; their hits resolved on the GPU and on the CPU
   * (`resolveHitCpu`), and by the scene's own CPU way for comparison.
   */
  async resolveCheck(at: readonly number[], n: number, spread = 6, reach = 16): Promise<VoxelResolveCheck | null> {
    const l = this.linked;
    if (l?.resolveRays === undefined || l.resolveHit === undefined) return null;
    const r = await l.resolveRays(checkRays(at, n, spread, reach));
    if (r === null) return null;
    const out: VoxelResolveCheck = { rays: n, voxelHits: 0, resolved: 0, lit: 0, mismatches: 0, sceneDiffers: 0, examples: [] };
    const f = new Float32Array(r.hits.buffer, r.hits.byteOffset, r.hits.length);
    for (let k = 0; k < n; k++) {
      const o = k * 8;
      const kind = r.hits[o + 4]! & 255;
      const g = [r.gpu[k * 2]!, r.gpu[k * 2 + 1]!];
      const c = [r.cpu[k * 2]!, r.cpu[k * 2 + 1]!];
      if (kind === TRACE_VOXELS) {
        out.voxelHits++;
        if (g[0] !== 0) out.resolved++;
        out.lit += r.lit[k]!;
        const hit: TraceHit = { kind, t: f[o]!, normal: [f[o + 1]!, f[o + 2]!, f[o + 3]!], face: (r.hits[o + 4]! >>> 8) & 255, object: r.hits[o + 5]!, a0: r.hits[o + 6]!, a1: r.hits[o + 7]! };
        const s = l.resolveHit(hit);
        const sw = s !== null && 'page' in s ? [((RESOLVE_PAGE << 30) | s.page) >>> 0, (s.x | (s.y << 16)) >>> 0] : [0, 0];
        if (sw[0] !== g[0] || sw[1] !== g[1]) out.sceneDiffers++;
      }
      if (g[0] !== c[0] || g[1] !== c[1]) {
        out.mismatches++;
        if (out.examples.length < 6) out.examples.push({ ray: k, kind, gpu: g, cpu: c });
      }
    }
    return out;
  }
}

/** Rays from round `at` (within `spread` metres) in random directions, up to `reach` metres (`VoxelLightFeed`'s checks). */
function checkRays(at: readonly number[], n: number, spread: number, reach: number): Float32Array {
  let s = 0x9e3779b9;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const rays = new Float32Array(n * RAY_FLOATS);
  for (let k = 0; k < n; k++) {
    const d = [rnd() * 2 - 1, rnd() * 2 - 1.2, rnd() * 2 - 1];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    rays.set([at[0]! + (rnd() * 2 - 1) * spread, at[1]! + rnd() * spread * 0.5, at[2]! + (rnd() * 2 - 1) * spread, 0, d[0]! / len, d[1]! / len, d[2]! / len, reach], k * RAY_FLOATS);
  }
  return rays;
}

/** The resolve pass's voxel texels against its CPU twin's (`VoxelLightFeed.resolveCheck`). */
export interface VoxelResolveCheck {
  readonly rays: number;
  /** Rays that hit a voxel; of those resolved on the GPU to a texel, and to a lit one. */
  voxelHits: number;
  resolved: number;
  lit: number;
  /** Rays whose GPU and CPU texels differ. */
  mismatches: number;
  /** Voxel hits `SurfaceScene.resolve` (the CPU's own way: the nearest charted point) puts in another texel, or none. */
  sceneDiffers: number;
  readonly examples: Record<string, unknown>[];
}

/** The tracer's voxel hits against the CPU walk's (`VoxelLightFeed.check`). */
export interface VoxelLightCheck {
  readonly rays: number;
  gpuHits: number;
  cpuHits: number;
  /** Rays whose kind, face or cell differ. */
  hitMismatches: number;
  /** GPU hits resolved to a resident texel. */
  resolved: number;
  /** Rays whose two hits resolve to different texels (or one to none). */
  texelMismatches: number;
  readonly examples: { ray: number; gpu: Record<string, unknown>; cpu: Record<string, unknown> }[];
  readonly ms: number;
}

/** The tracer's voxel walk of one ray (`RAY_FLOATS`), on the CPU over the same blocks: the steps `traceVoxels` takes in the tracer's WGSL. */
export function cpuVoxelTrace(src: WalkSource, ray: Float32Array): TraceHit {
  const o = [ray[0]!, ray[1]!, ray[2]!];
  const d = [ray[4]!, ray[5]!, ray[6]!];
  const lim = ray[7]!;
  let t0 = ray[3]!;
  const miss: TraceHit = { kind: TRACE_MISS, t: lim, normal: [0, 0, 0], face: 0, object: 0, a0: 0, a1: 0 };
  for (let k = 0; k <= VOXEL_TRACE_SKIPS; k++) {
    if (!(t0 < lim)) return miss;
    const p = [0, 1, 2].map((a) => Math.fround(o[a]! + d[a]! * t0));
    const r = walkRay(p, d);
    if (r === null) return miss;
    const w = walkVoxels(src, r, Math.fround(lim - t0), { stop: 'light', far: false, maxSteps: WALK_GPU_MAX_STEPS });
    if (w.hit === null) return miss;
    if (w.hit.normal.every((v) => v === 0)) {
      // Inside a body where it starts: on from where it leaves that cell.
      let te = Infinity;
      for (let a = 0; a < 3; a++) {
        const dd = Math.abs(d[a]!) < 1e-7 ? (d[a]! >= 0 ? 1e-7 : -1e-7) : d[a]!;
        te = Math.min(te, ((r.cell[a]! + (dd > 0 ? 1 : 0)) * VOXEL_SIZE_M - p[a]!) / dd);
      }
      t0 = t0 + Math.max(te, 0) + 1e-4;
      continue;
    }
    const t = t0 + w.hit.t;
    if (t >= lim) return miss;
    const axis = w.hit.normal.findIndex((v) => v !== 0);
    const [pu, pv] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
    const q = [0, 1, 2].map((a) => (p[a]! + d[a]! * w.hit!.t) / VOXEL_SIZE_M - w.hit!.cell[a]!);
    const words = voxelHitWords(w.hit.cell, q[pu!]!, q[pv!]!);
    const normal: [number, number, number] = [w.hit.normal[0], w.hit.normal[1], w.hit.normal[2]];
    return { kind: TRACE_VOXELS, t, normal, face: axis * 2 + (normal[axis]! < 0 ? 1 : 0), object: 0, ...words };
  }
  return miss;
}
