/**
 * The resident probe tiles on the GPU: one 3D texture all of them share
 * (probe-pack.ts lays it out), the tile table and the spatial index
 * (probe-index.ts) the shader finds a pixel's tile with.
 *
 * Incremental: a tile that arrives is uploaded into its own region (one
 * copy of its packed bytes; on WebGPU `queue.writeTexture`, on WebGL 2
 * `texSubImage3D`), a tile that goes gives its region back, and nothing else
 * is touched. The texture itself is allocated on the GPU only (no CPU copy
 * of it); when it has to grow, the old one is copied into the new one on the
 * GPU. The table and the index are small (16 bytes a texel; a few per tile)
 * and are rebuilt whole when the set changes.
 */
import * as THREE from 'three/webgpu';
import type { ProbeGridRecord } from '@thirdlight/runtime';

import { buildProbeIndex, EMPTY_PROBE_INDEX, PROBE_INDEX_WIDTH, type ProbeIndex } from './probe-index';
import { ProbeAtlasLayout, probeFade, probeTableRow, TABLE_ROW_FLOATS, TABLE_ROWS_PER_LINE, TABLE_TEXELS, type PackedProbeTile, type ProbePlace } from './probe-pack';

/** Largest edge of the packed probe texture (texels): WebGPU's default 3D texture limit (WebGL 2 desktop GPUs give at least as much). */
export const PROBE_PACK_MAX_EDGE = 2048;

/** A tile ready to go onto the GPU (probe-grids.ts loads them). */
export interface ProbeTileForGpu {
  /** The tile's resource key (its file and bake): the same key is the same probes. */
  readonly key: string;
  readonly sceneId: string;
  readonly grid: ProbeGridRecord;
  readonly packed: PackedProbeTile;
  /** Each probe's validity (PROBE_VALID, PROBE_MOVED or PROBE_FILLED), for the debug view. */
  readonly validity: Float32Array;
}

/** A tile on the GPU: its table row and its place in the texture. */
export interface ResidentProbeTile {
  readonly key: string;
  readonly sceneId: string;
  readonly grid: ProbeGridRecord;
  readonly validity: Float32Array;
  readonly row: number;
  readonly at: ProbePlace;
}

/** What a sync uploads with (three's WebGPU renderer, on either backend). */
export interface ProbeUploadRenderer {
  readonly backend: { readonly isWebGLBackend?: boolean; readonly device?: unknown; get(object: object): { texture?: unknown }; copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture, region: null, at: THREE.Vector3): void };
  initTexture(texture: THREE.Texture): void;
  copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture, region: THREE.Box3 | null, at: THREE.Vector3 | null): void;
}

type GpuQueue = { writeTexture(dst: { texture: unknown; origin: { x: number; y: number; z: number } }, data: ArrayBufferView, layout: { bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number; depthOrArrayLayers: number }): void };

/**
 * Each texture the store makes gets a version no earlier one had: three's
 * WebGL 2 backend rebinds a texture node's new texture only when its version
 * at creation differs from the old one's (two fresh textures both at 1 keep
 * the old, deleted one bound).
 */
let textureVersion = 0;
function fresh<T extends THREE.Texture>(tex: T): T {
  tex.needsUpdate = true;
  tex.version = Math.max(tex.version, ++textureVersion);
  return tex;
}

function gpuOnlyTexture(width: number, height: number, depth: number): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(null, width, height, depth);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  // Allocated on the GPU without data: the tiles are copied in.
  tex.source.dataReady = false;
  return fresh(tex);
}

function placeholderAtlas(): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(new Uint16Array(4), 1, 1, 1);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.HalfFloatType;
  tex.unpackAlignment = 1;
  return fresh(tex);
}

function floatTexture(data: Float32Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return fresh(tex);
}

/** Upload one packed tile into its place. */
function upload(renderer: ProbeUploadRenderer, atlas: THREE.Data3DTexture, tile: PackedProbeTile, at: ProbePlace): void {
  renderer.initTexture(atlas);
  if (renderer.backend.isWebGLBackend === true) {
    // A texture never given to the GPU: three's copy then uploads its data straight into the region.
    const src = new THREE.Data3DTexture(tile.data, tile.nx, tile.ny, tile.depth);
    src.format = THREE.RGBAFormat;
    src.type = THREE.HalfFloatType;
    renderer.backend.copyTextureToTexture(src, atlas, null, new THREE.Vector3(at.x, at.y, 0));
    return;
  }
  const device = renderer.backend.device as { queue: GpuQueue } | undefined;
  const gpu = renderer.backend.get(atlas).texture;
  if (device === undefined || gpu === undefined) throw new Error('the probe texture is not on the GPU');
  device.queue.writeTexture({ texture: gpu, origin: { x: at.x, y: at.y, z: 0 } }, tile.data, { bytesPerRow: tile.nx * 8, rowsPerImage: tile.ny }, { width: tile.nx, height: tile.ny, depthOrArrayLayers: tile.depth });
}

export interface ProbeSyncResult {
  /** Tiles uploaded now, and their bytes; tiles that did not fit the texture within its budget. */
  readonly uploaded: number;
  readonly uploadedBytes: number;
  readonly unplaced: number;
}

export class ProbeTileStore {
  atlas: THREE.Data3DTexture = placeholderAtlas();
  table: THREE.DataTexture = floatTexture(new Float32Array(TABLE_ROWS_PER_LINE * TABLE_ROW_FLOATS), TABLE_ROWS_PER_LINE * TABLE_TEXELS, 1);
  index: THREE.DataTexture = floatTexture(EMPTY_PROBE_INDEX.data, 1, 1);
  indexOf: ProbeIndex = EMPTY_PROBE_INDEX;
  /** The table as the texture holds it (row × TABLE_ROW_FLOATS) and per row its box, for the CPU's picks. */
  tableData: Float32Array = this.table.image.data as Float32Array;
  boxes: Float32Array = new Float32Array(TABLE_ROWS_PER_LINE * 6);
  /** The resident tiles in table order (scene, then the record's order). */
  tiles: readonly ResidentProbeTile[] = [];
  unplaced = 0;
  /** Counts the changes of the resident set (tiles, places or textures): the light rebinds lit objects when it changes. */
  revision = 0;
  private layout: ProbeAtlasLayout | null = null;
  private readonly resident = new Map<string, ResidentProbeTile>();
  private freeRows: number[] = [];
  private rows = 0;
  /** Textures replaced, disposed once no frame can still bind them. */
  private retired: { texture: THREE.Texture; frames: number }[] = [];

  /** Tiles on the GPU. */
  get count(): number {
    return this.resident.size;
  }

  /** The textures' bytes on the GPU. */
  get gpuBytes(): number {
    return (this.layout?.bytes() ?? 0) + this.tableData.byteLength + this.indexOf.data.byteLength;
  }

  /**
   * Hold `ready` (in table order) on the GPU and let go of every resident
   * tile not in `keep` (tiles still wanted stay while their replacement
   * loads). Uploads only what arrived. `shape`: the widest and deepest tile
   * that may come (the followed scenes' tiles), so a later one does not start
   * the texture again.
   */
  sync(ready: readonly ProbeTileForGpu[], keep: ReadonlySet<string>, renderer: ProbeUploadRenderer, budget: number, shape?: { columnWidth: number; depth: number }, maxEdge = PROBE_PACK_MAX_EDGE): ProbeSyncResult {
    let changed = false;
    for (const [key, t] of this.resident) {
      if (keep.has(key)) continue;
      this.layout?.release(t.at, t.grid.resolution[1]);
      this.resident.delete(key);
      this.freeRows.push(t.row);
      changed = true;
    }
    // Columns as wide as the widest tile and as deep as the deepest; a wider or deeper one starts the texture again.
    let columnWidth = Math.max(this.layout?.columnWidth ?? 1, shape?.columnWidth ?? 1);
    let depth = Math.max(this.layout?.depth ?? 1, shape?.depth ?? 1);
    for (const t of ready) {
      columnWidth = Math.max(columnWidth, t.packed.nx);
      depth = Math.max(depth, t.packed.depth);
    }
    if (this.layout === null || columnWidth > this.layout.columnWidth || depth > this.layout.depth) {
      this.layout = new ProbeAtlasLayout(columnWidth, depth, maxEdge);
      this.retire(this.atlas);
      this.atlas = placeholderAtlas();
      this.revision++;
      for (const t of this.resident.values()) this.freeRows.push(t.row);
      this.resident.clear();
      changed = true;
    }
    const layout = this.layout;
    let uploaded = 0;
    let uploadedBytes = 0;
    let unplaced = 0;
    for (const t of ready) {
      if (this.resident.has(t.key)) continue;
      let at = layout.place(t.packed.ny);
      if (at === null) {
        const before = { cols: layout.cols, height: layout.height };
        if (layout.grow(t.packed.ny, budget)) {
          this.growTexture(renderer, before);
          at = layout.place(t.packed.ny);
        }
      }
      if (at === null) {
        unplaced++;
        continue;
      }
      upload(renderer, this.atlas, t.packed, at);
      uploaded++;
      uploadedBytes += t.packed.data.byteLength;
      const row = this.freeRows.length > 0 ? this.freeRows.pop()! : this.rows++;
      this.resident.set(t.key, { key: t.key, sceneId: t.sceneId, grid: t.grid, validity: t.validity, row, at });
      changed = true;
    }
    this.unplaced = unplaced;
    if (changed) this.rebuildLookups(ready, renderer);
    if (this.resident.size === 0 && this.layout.cols > 0) {
      // Nothing resident: give the texture back.
      this.retire(this.atlas);
      this.atlas = placeholderAtlas();
      this.revision++;
      this.layout = null;
      this.freeRows = [];
      this.rows = 0;
    }
    return { uploaded, uploadedBytes, unplaced };
  }

  /** The texture at the layout's new size, the old one's contents copied in on the GPU. */
  private growTexture(renderer: ProbeUploadRenderer, before: { cols: number; height: number }): void {
    const layout = this.layout!;
    const next = gpuOnlyTexture(layout.width, layout.height, layout.depth);
    renderer.initTexture(next);
    if (before.cols > 0 && before.height > 0) {
      const old = this.atlas;
      const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(before.cols * layout.columnWidth, before.height, layout.depth));
      renderer.copyTextureToTexture(old, next, box, new THREE.Vector3(0, 0, 0));
    }
    this.retire(this.atlas);
    this.atlas = next;
    this.revision++;
  }

  /**
   * The table (rows of the resident tiles) and the index, in table order,
   * written into the textures in place (uploaded now: an object whose own
   * data did not change does not upload its textures on WebGL 2); a texture
   * too small is replaced by one twice the size.
   */
  private rebuildLookups(order: readonly ProbeTileForGpu[], renderer: ProbeUploadRenderer): void {
    this.revision++;
    const lines = Math.max(1, Math.ceil(this.rows / TABLE_ROWS_PER_LINE));
    if (this.table.image.height < lines) {
      const height = 2 ** Math.ceil(Math.log2(lines));
      this.tableData = new Float32Array(height * TABLE_ROWS_PER_LINE * TABLE_ROW_FLOATS);
      this.boxes = new Float32Array(height * TABLE_ROWS_PER_LINE * 6);
      this.retire(this.table);
      this.table = floatTexture(this.tableData, TABLE_ROWS_PER_LINE * TABLE_TEXELS, height);
      this.revision++;
    } else this.tableData.fill(0);
    const ranked = order.map((t) => this.resident.get(t.key)).filter((t): t is ResidentProbeTile => t !== undefined);
    // Resident tiles no longer in `order` (kept while their replacement loads) go last.
    const listed = new Set(ranked.map((t) => t.key));
    for (const t of this.resident.values()) if (!listed.has(t.key)) ranked.push(t);
    for (const t of ranked) {
      this.tableData.set(probeTableRow(t.grid, t.at), t.row * TABLE_ROW_FLOATS);
      this.boxes.set([...t.grid.min, ...t.grid.max], t.row * 6);
    }
    this.tiles = ranked;
    this.table.needsUpdate = true;
    renderer.initTexture(this.table);
    const index = buildProbeIndex(ranked.map((t) => ({ row: t.row, min: t.grid.min, max: t.grid.max, fade: probeFade(t.grid) })));
    this.indexOf = index;
    if (this.index.image.width !== PROBE_INDEX_WIDTH || this.index.image.height < index.height) {
      const height = 2 ** Math.ceil(Math.log2(index.height));
      this.retire(this.index);
      this.index = floatTexture(new Float32Array(height * PROBE_INDEX_WIDTH * 4), PROBE_INDEX_WIDTH, height);
      this.revision++;
    }
    const data = this.index.image.data as Float32Array;
    data.set(index.data);
    data.fill(0, index.data.length);
    this.index.needsUpdate = true;
    renderer.initTexture(this.index);
  }

  private retire(texture: THREE.Texture): void {
    this.retired.push({ texture, frames: 2 });
  }

  /** A frame was drawn: let go of textures no frame binds any more. */
  frameDrawn(): void {
    if (this.retired.length === 0) return;
    for (const r of this.retired) if (--r.frames <= 0) r.texture.dispose();
    this.retired = this.retired.filter((r) => r.frames > 0);
  }

  dispose(): void {
    for (const r of this.retired) r.texture.dispose();
    this.retired = [];
    this.atlas.dispose();
    this.table.dispose();
    this.index.dispose();
  }
}
