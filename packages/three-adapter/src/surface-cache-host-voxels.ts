/**
 * The surface cache host's voxel worlds (`SurfaceCacheHost.voxels`): the
 * page's source of level-0 chunks it lights while the page's lighting store
 * is the cache, listed as tiles with the host's other surfaces, the live
 * light's budget where the tier gives none, and what the cache holds of them.
 *
 * Pure (no three.js, no device).
 */
import type { SurfaceCache, SurfaceTile } from './surface-cache';
import type { SurfaceRelight } from './surface-relight';
import { voxelChunkTile, type VoxelTile, type VoxelTileMesh } from './surface-cache-voxels';
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
  /** A resident tile's units' keys. */
  units(key: string): readonly string[];
  readonly relight: SurfaceRelight;
}

export class HostVoxels {
  private source: SurfaceVoxelSource | null = null;
  private applied = -1;

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

  /** The listing's part: each chunk drawn is seen; one not known at its version waits to be charted (`want`). */
  list(seen: Set<string>, known: (key: string, version: number) => boolean, want: (tile: VoxelTile) => void): void {
    const src = this.source;
    if (src === null) return;
    const solidAt = src.solidAt?.bind(src);
    for (const c of src.chunks()) {
      if (known(c.key, c.version)) {
        seen.add(c.key);
        continue;
      }
      want(voxelChunkTile(c.key, c.version, c.cell0, c.edge, () => c.mesh(), solidAt));
    }
  }

  /** What the cache holds of the voxel worlds now. */
  diagnostics(): SurfaceVoxelDiagnostics {
    const h = this.host;
    const isVoxel = (t: unknown): boolean => (t as { kind?: string } | undefined)?.kind === 'voxels';
    let tiles = 0;
    let chunks = 0;
    const ready = new Map<string, SurfaceTile>();
    for (const t of h.ready()) {
      if (!isVoxel(t)) continue;
      ready.set(t.key, t);
      chunks += 1;
      if (t.charts().length > 0) tiles += 1;
    }
    for (const p of h.pending()) if (p.voxel === true) chunks += 1;
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
    return { chunks, tiles, resident, charts, residentTexels, litTexels, staleUnits, levels: Array.from({ length: levels.length }, (_, l) => levels[l] ?? 0), bytes };
  }
}
