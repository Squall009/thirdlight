/**
 * The surface cache on the page: which static surfaces' light is resident
 * round the drawn eye, within the quality level's budget (`surface-cache.ts`
 * decides; this host feeds it the loaded scene).
 *
 * - Block layers offer their built chunk columns (what the world stream
 *   holds on a game page), terrains their loaded tiles, generated
 *   architecture its objects, and static model objects their pieces once
 *   their distance-field file (bricks and surfels) is read.
 * - A tile is offered only once its charts are made; charts are made a few
 *   at a time, nearest first, within `SURFACE_PREPARE_MS` a frame, so a
 *   scene coming in never stalls a frame.
 *
 * Measurements read it from `scene.userData[SURFACE_CACHE_KEY]`.
 */
import { decodeDistanceBricks, type ArchitectureComponent, type BlockCell, type DistanceBricks, type TerrainField } from '@thirdlight/runtime';

import { SurfaceCache, type SurfaceCacheDiagnostics, type SurfaceTile } from './surface-cache';
import { architecturePiecesOf } from './surface-cache-arch';
import type { SurfaceBlockGrid } from './surface-cache-blocks';
import { architectureTile, blockChunkTile, modelPieceTiles } from './surface-cache-scene';
import type { TerrainRingSource } from './surface-cache-terrain';
import { invertAffine, type Affine } from './tracer-words';

/** `scene.userData[SURFACE_CACHE_KEY]`: the page's surface cache (a measurement reads its diagnostics). */
export const SURFACE_CACHE_KEY = 'tlSurfaceCache';
/** Main-thread time a frame may spend making tiles' charts (ms). */
export const SURFACE_PREPARE_MS = 1;
/** How often (ms) the host lists the loaded scene's surfaces again when nothing says it changed. */
const LIST_MS = 250;

/** A block layer as the host reads it from the block view. */
export interface SurfaceHostLayer {
  readonly id: string;
  readonly origin: readonly number[];
  readonly grid: SurfaceBlockGrid;
  /** Changes with what stops light (its block types). */
  readonly version: number;
  /** Its built chunk columns ("cx,cz") and each one's version (bumped when it is meshed again). */
  readonly chunks: readonly (readonly [string, number])[];
  readonly opaque: (cell: BlockCell) => boolean;
}

/** A static model object: its entity, model row and world matrix (column-major 4 × 4, as three's). */
export interface SurfaceHostModel {
  readonly id: string;
  readonly assetId: string;
  readonly version: number;
  readonly piece: string | null;
  readonly world: ArrayLike<number>;
}

export interface SurfaceCacheHostDeps {
  readonly layers: () => readonly SurfaceHostLayer[];
  readonly terrains: () => readonly { readonly id: string; readonly field: TerrainField }[];
  /** Generated architecture objects (a new component object is a new version). */
  readonly architecture: () => readonly { readonly id: string; readonly component: ArchitectureComponent; readonly origin: readonly number[] }[];
  readonly models: () => readonly SurfaceHostModel[];
  /** A model row's distance-field file (null: it has none). */
  readonly bricks: (assetId: string, version: number) => Promise<Uint8Array> | null;
}

export interface SurfaceCacheHostDiagnostics extends SurfaceCacheDiagnostics {
  /** Surfaces of the loaded scene whose charts are not made yet, and models whose files are being read. */
  readonly preparing: number;
  readonly reading: number;
  /** The last frame's time making charts (ms). */
  readonly prepareMs: number;
}

/** A matrix (column-major 4 × 4) as the world → local affine map. */
function worldToLocalOfMatrix(m: ArrayLike<number>): Affine {
  return invertAffine([m[0]!, m[4]!, m[8]!, m[12]!, m[1]!, m[5]!, m[9]!, m[13]!, m[2]!, m[6]!, m[10]!, m[14]!]);
}

/** A terrain's loaded tiles' world box: what its rings cover. */
function ringSourceOf(id: string, field: TerrainField): TerrainRingSource | null {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const key of field.loadedTiles().keys()) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x + 1);
    z1 = Math.max(z1, z + 1);
  }
  if (x0 === Infinity) return null;
  const side = field.n * field.spacing;
  const o = field.origin;
  return { key: id, min: [o[0] + x0 * side, o[1], o[2] + z0 * side], max: [o[0] + x1 * side, o[1], o[2] + z1 * side] };
}

interface Pending {
  /** Where it is (for nearest first) and its version. */
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly version: number;
  /** Makes its tile and its charts. */
  readonly make: () => SurfaceTile;
}

/** A number for a placement (its matrix to the millimetre): a moved static object is a new version of its tiles. */
function placementHash(m: ArrayLike<number>, version: number): number {
  let h = 5381 + version;
  for (let i = 0; i < 16; i += 1) h = (Math.imul(h, 33) + Math.round((m[i] ?? 0) * 1000)) | 0;
  return h >>> 0;
}

export class SurfaceCacheHost {
  readonly cache: SurfaceCache;
  private listedAt = -Infinity;
  /** Made tiles by key (kept while their source is loaded and unchanged). */
  private readonly ready = new Map<string, SurfaceTile>();
  private readonly pending = new Map<string, Pending>();
  private terrains: TerrainRingSource[] = [];
  private readonly memos = new Map<string, { version: number; memo: Map<number, boolean> }>();
  /** Model files by asset and version: read (decoded), being read, or none. */
  private readonly files = new Map<string, DistanceBricks | 'reading' | null>();
  private readonly componentVersions = new WeakMap<object, number>();
  private componentVersion = 0;
  private changed = true;
  private prepareMs = 0;
  private offered: SurfaceTile[] = [];

  constructor(private readonly deps: SurfaceCacheHostDeps, budgetBytes: number) {
    this.cache = new SurfaceCache(budgetBytes);
  }

  setBudget(bytes: number): void {
    if (bytes === this.cache.budgetBytes) return;
    this.cache.setBudget(bytes);
    this.changed = true;
  }

  /** Something loaded or changed (a scene, a chunk built, an edit): the surfaces are listed again on the next frame. */
  touch(): void {
    this.listedAt = -Infinity;
  }

  /** Once a frame, with the drawn eye. */
  update(eye: ArrayLike<number>): void {
    const now = performance.now();
    if (now - this.listedAt >= LIST_MS) {
      this.listedAt = now;
      this.list();
    }
    this.prepare(eye, now);
    // A tile with nothing to light (a chunk of hidden faces only) is made once and never offered.
    if (this.changed) this.offered = [...this.ready.values()].filter((t) => t.charts().length > 0);
    this.cache.update([eye[0]!, eye[1]!, eye[2]!], this.offered, this.terrains, this.changed);
    this.changed = false;
  }

  /** Whether `key` at `version` is made or waiting; else it waits (a changed one is let go first). */
  private want(seen: Set<string>, key: string, version: number, min: readonly number[], max: readonly number[], make: () => SurfaceTile): void {
    seen.add(key);
    const had = this.ready.get(key);
    if (had !== undefined && had.version === version) return;
    if (had !== undefined) {
      this.ready.delete(key);
      this.changed = true;
    }
    const p = this.pending.get(key);
    if (p === undefined || p.version !== version) this.pending.set(key, { min, max, version, make });
  }

  /** The loaded scene's surfaces: what is ready stays, what changed or is new waits to be made, what left goes. */
  private list(): void {
    const seen = new Set<string>();
    for (const layer of this.deps.layers()) {
      let m = this.memos.get(layer.id);
      if (m === undefined || m.version !== layer.version) this.memos.set(layer.id, (m = { version: layer.version, memo: new Map() }));
      const memo = m.memo;
      for (const [ck, gen] of layer.chunks) {
        const key = `${layer.id}/${ck}`;
        const version = layer.version * 65536 + gen;
        if (this.ready.get(key)?.version === version || this.pending.get(key)?.version === version) {
          seen.add(key);
          continue;
        }
        const tile = blockChunkTile({ key: layer.id, grid: layer.grid, origin: layer.origin, opaque: layer.opaque, version }, 0, ck, memo);
        this.want(seen, key, version, tile.min, tile.max, () => (tile.charts(), tile));
      }
    }
    this.terrains = [];
    for (const { id, field } of this.deps.terrains()) {
      const r = ringSourceOf(id, field);
      if (r !== null) this.terrains.push(r);
    }
    for (const a of this.deps.architecture()) {
      let version = this.componentVersions.get(a.component);
      if (version === undefined) this.componentVersions.set(a.component, (version = ++this.componentVersion));
      this.want(seen, a.id, version, a.origin, a.origin, () => architectureTile(a.id, version, architecturePiecesOf(a.component, a.origin)));
    }
    for (const m of this.deps.models()) {
      const file = this.file(m.assetId, m.version);
      if (file === null) continue;
      const version = placementHash(m.world, m.version);
      const pieces = m.piece !== null ? [m.piece] : file.sets.map((s) => s.piece);
      const fresh = pieces.every((piece) => {
        const key = `${m.id}/${piece}`;
        seen.add(key);
        return this.ready.get(key)?.version === version;
      });
      if (fresh) continue;
      for (const tile of modelPieceTiles({ key: m.id, worldToLocal: worldToLocalOfMatrix(m.world), bricks: file, piece: m.piece, version })) {
        if (tile.chart === null) continue;
        this.ready.set(tile.key, tile);
        this.changed = true;
      }
    }
    for (const key of [...this.ready.keys()]) if (!seen.has(key)) {
      this.ready.delete(key);
      this.changed = true;
    }
    for (const key of [...this.pending.keys()]) if (!seen.has(key)) this.pending.delete(key);
  }

  /** A model's decoded file (null: none, or still being read). */
  private file(assetId: string, version: number): DistanceBricks | null {
    const key = `${assetId}@${version}`;
    const f = this.files.get(key);
    if (f !== undefined) return f === 'reading' ? null : f;
    const read = this.deps.bricks(assetId, version);
    if (read === null) {
      this.files.set(key, null);
      return null;
    }
    this.files.set(key, 'reading');
    read.then(
      (bytes) => {
        this.files.set(key, decodeDistanceBricks(bytes));
        this.touch();
      },
      () => this.files.set(key, null),
    );
    return null;
  }

  /** Makes waiting tiles' charts, nearest first, within the frame's share. */
  private prepare(eye: ArrayLike<number>, t0: number): void {
    this.prepareMs = 0;
    if (this.pending.size === 0) return;
    const d = (p: Pending): number => Math.hypot(Math.max(p.min[0]! - eye[0]!, 0, eye[0]! - p.max[0]!), Math.max(p.min[2]! - eye[2]!, 0, eye[2]! - p.max[2]!));
    const order = [...this.pending].sort((a, b) => d(a[1]) - d(b[1]));
    for (const [key, p] of order) {
      if (performance.now() - t0 >= SURFACE_PREPARE_MS) break;
      this.pending.delete(key);
      this.ready.set(key, p.make());
      this.changed = true;
    }
    this.prepareMs = performance.now() - t0;
  }

  diagnostics(): SurfaceCacheHostDiagnostics {
    let reading = 0;
    for (const f of this.files.values()) if (f === 'reading') reading += 1;
    return { ...this.cache.diagnostics(), preparing: this.pending.size, reading, prepareMs: this.prepareMs };
  }
}
