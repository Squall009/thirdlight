/**
 * The surface cache host's voxel worlds (`SurfaceCacheHost.voxels`): the
 * page's source of level-0 chunks it lights while the page's lighting store
 * is the cache, listed as tiles with the host's other surfaces, the live
 * light's budget where the tier gives none, and what the cache holds of them.
 *
 * A chunk's charts take milliseconds to make (thousands of triangles), so
 * they are made in steps, nearest chunk first, within the frame arbiter's
 * `surfacePrepare` slice (what the host's other surfaces have left of it);
 * a chunk drawn again keeps its old tile until its new charts are made.
 *
 * Pure (no three.js, no device).
 */
import { frameSliceMs } from '@thirdlight/shared';

import type { SurfaceCache, SurfaceTile } from './surface-cache';
import type { SurfaceRelight } from './surface-relight';
import { voxelChunkChartsSteps, voxelChunkTile, type VoxelChunkCharts, type VoxelTile, type VoxelTileMesh } from './surface-cache-voxels';
import type { VoxelWalkBuffers } from './tracer-gpu';

/** A voxel world's level-0 chunk as drawn: its key (world and chunk), its mesh's version, its corner cell and edge, and its mesh (null: gone). */
export interface SurfaceVoxelChunk {
  readonly key: string;
  readonly version: number;
  readonly cell0: readonly [number, number, number];
  readonly edge: number;
  mesh(): VoxelTileMesh | null;
}

/** What a page's voxel worlds give the cache when they are lit by it. */
export interface SurfaceVoxelSource {
  /** The level-0 chunks drawn now. */
  chunks(): Iterable<SurfaceVoxelChunk>;
  /** Whether a cell is drawn as a body (null: not known): a surface with a body in front of it is charted nowhere. */
  solidAt?(x: number, y: number, z: number): boolean | null;
  /** The occupancy walk the traced rays take through the voxels (null: none on the GPU yet). */
  walk(): VoxelWalkBuffers | null;
  /** GPU ms a frame the live light may take while texels are stale, where the tier gives it none (the lighting row of the tier's frame budget). */
  readonly relightMs: number;
}

/** What the cache holds of voxel worlds: chunks offered and charted, resident tiles, their texels, and how many of those are lit (no unit of theirs stale). */
export interface SurfaceVoxelDiagnostics {
  /** Chunks listed (charted or waiting to be) and charted with something to light. */
  readonly chunks: number;
  readonly tiles: number;
  readonly resident: number;
  readonly charts: number;
  readonly residentTexels: number;
  readonly litTexels: number;
  readonly staleUnits: number;
  /** Resident voxel tiles per level (index: level). */
  readonly levels: readonly number[];
  /** Bytes of pages the resident voxel tiles hold. */
  readonly bytes: number;
  /** Chunks whose charts are still being made or wait to be listed, chunks charted so far, and the longest frame's charting (ms). */
  readonly waiting: number;
  readonly charted: number;
  readonly chartMs: number;
}

/** What it reads of its host. */
export interface HostVoxelsDeps {
  /** The host's budget now (its tier's, else this one's). */
  budget(): number;
  applyBudget(ms: number): void;
  touch(): void;
  ready(): Iterable<SurfaceTile>;
  pending(): Iterable<{ readonly voxel?: boolean }>;
  readonly cache: SurfaceCache;
  /** A charted tile goes to the host's listing (made at once). */
  want(tile: VoxelTile): void;
  /** The version of a tile the host holds or waits on (undefined: none). */
  versionOf(key: string): number | undefined;
  /** A resident tile's units' keys. */
  units(key: string): readonly string[];
  readonly relight: SurfaceRelight;
}

/** A chunk being charted: its tile, the steps, and where it is (for nearest first). */
interface Charting {
  readonly tile: VoxelTile;
  readonly steps: Generator<void, VoxelChunkCharts>;
  readonly centre: readonly number[];
}

export class HostVoxels {
  private source: SurfaceVoxelSource | null = null;
  private applied = -1;
  private charting = new Map<string, Charting>();
  /** The longest frame's share spent charting since last read (ms), and the chunks charted. */
  readonly stats = { chartMs: 0, charted: 0 };

  constructor(private readonly host: HostVoxelsDeps) {}

  /** The voxel worlds' surfaces lit by the cache from now on (null: none; their tiles go on the next listing). */
  set(src: SurfaceVoxelSource | null): void {
    if (src === this.source) return;
    this.source = src;
    this.applyBudget();
    this.host.touch();
  }

  /** The live light's GPU ms a frame the worlds give where the tier gives none (0: no world lit here). */
  get relightMs(): number {
    return this.source?.relightMs ?? 0;
  }

  /** The host's budget into its scheduler and probes when it changed (the worlds' follows their quality level). */
  applyBudget(): void {
    const ms = this.host.budget();
    if (ms === this.applied) return;
    this.applied = ms;
    this.host.applyBudget(ms);
  }

  /** The occupancy walk the traced rays take (null: no voxel world lit here, or none on the GPU yet). */
  walk(): VoxelWalkBuffers | null {
    return this.source?.walk() ?? null;
  }

  /** The listing's part: each chunk drawn is seen; one not held at its version is charted (the old one kept meanwhile). */
  list(seen: Set<string>): void {
    const src = this.source;
    const was = this.charting;
    this.charting = new Map();
    if (src === null) return;
    const solidAt = src.solidAt?.bind(src);
    for (const c of src.chunks()) {
      const held = this.host.versionOf(c.key);
      if (held !== undefined) seen.add(c.key);
      if (held === c.version) continue;
      const job = was.get(c.key);
      if (job !== undefined && job.tile.version === c.version) {
        this.charting.set(c.key, job);
        continue;
      }
      const mesh = c.mesh();
      const tile = voxelChunkTile(c.key, c.version, c.cell0, c.edge, () => c.mesh(), solidAt);
      const steps = voxelChunkChartsSteps(mesh?.positions ?? [], mesh?.indices ?? [], c.cell0, c.edge, solidAt);
      this.charting.set(c.key, { tile, steps, centre: [0, 1, 2].map((a) => (tile.min[a]! + tile.max[a]!) / 2) });
    }
  }

  /** Chunks still being charted. */
  get waiting(): number {
    return this.charting.size;
  }

  /** Charts chunks, nearest `eye` first, until the frame's slice (from `t0`) is spent; each done goes to the host. */
  step(eye: ArrayLike<number>, t0: number): void {
    if (this.charting.size === 0) return;
    const slice = frameSliceMs('surfacePrepare');
    const start = performance.now();
    const d = (j: Charting): number => (j.centre[0]! - eye[0]!) ** 2 + (j.centre[1]! - eye[1]!) ** 2 + (j.centre[2]! - eye[2]!) ** 2;
    const order = [...this.charting.values()].sort((a, b) => d(a) - d(b));
    for (const job of order) {
      for (;;) {
        if (performance.now() - t0 >= slice) {
          this.stats.chartMs = Math.max(this.stats.chartMs, performance.now() - start);
          return;
        }
        const r = job.steps.next();
        if (r.done !== true) continue;
        job.tile.made = r.value;
        this.charting.delete(job.tile.key);
        this.stats.charted += 1;
        this.host.want(job.tile);
        break;
      }
    }
    this.stats.chartMs = Math.max(this.stats.chartMs, performance.now() - start);
  }

  /** What the cache holds of the voxel worlds now. */
  diagnostics(): SurfaceVoxelDiagnostics {
    const h = this.host;
    const isVoxel = (t: unknown): boolean => (t as { kind?: string } | undefined)?.kind === 'voxels';
    let tiles = 0;
    let chunks = 0;
    let waiting = this.charting.size;
    const ready = new Map<string, SurfaceTile>();
    for (const t of h.ready()) {
      if (!isVoxel(t)) continue;
      ready.set(t.key, t);
      chunks += 1;
      if (t.charts().length > 0) tiles += 1;
    }
    for (const p of h.pending()) if (p.voxel === true) {
      chunks += 1;
      waiting += 1;
    }
    chunks += this.charting.size;
    let resident = 0;
    let charts = 0;
    let residentTexels = 0;
    let litTexels = 0;
    let staleUnits = 0;
    let bytes = 0;
    const levels: number[] = [];
    h.cache.forEachResident((key, level, _blocks, packing, made) => {
      if (!ready.has(key)) return;
      resident += 1;
      charts += made.length;
      bytes += packing.bytes;
      levels[level] = (levels[level] ?? 0) + 1;
      for (const u of h.units(key)) {
        const n = h.relight.unitOf(u)?.texels ?? 0;
        residentTexels += n;
        if (h.relight.isStale(u)) staleUnits += 1;
        else litTexels += n;
      }
    });
    const chartMs = this.stats.chartMs;
    this.stats.chartMs = 0;
    return { chunks, tiles, resident, charts, residentTexels, litTexels, staleUnits, levels: Array.from({ length: levels.length }, (_, l) => levels[l] ?? 0), bytes, waiting, charted: this.stats.charted, chartMs };
  }
}
