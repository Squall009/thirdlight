/**
 * The packed light lists on the GPU (`cluster-pack.ts` writes them on the
 * CPU), and their reads in a shader: ONE RGBA32UI texture of light records
 * (floats as their bits), cell headers and index lists, read with
 * `textureLoad` / `texelFetch` only, the same on WebGPU and WebGL 2, so the
 * lists take one of a lit program's texture units (`texture-units.ts`).
 *
 * - **Upload.** A texture whose rows grew (or whose data is another view's)
 *   is made again and uploaded whole; otherwise only the rows this frame
 *   wrote go up: `queue.writeTexture` on WebGPU, `texSubImage2D` (three's
 *   copy from a texture never given to the GPU) on WebGL 2. three's own
 *   update path would send the whole texture every frame.
 * - **Reads.** `clusterCell` finds a pixel's cell from its place on the
 *   screen (a share of the render size, so the render scale and dynamic
 *   resolution change nothing) and its view depth; `clusterCellAt` takes
 *   that place from the pixel's view position through the projection the
 *   lists were built with, not the jittered one TAAU draws with, so a
 *   pixel reads exactly the cell the build tested it in; `clusterList`
 *   decodes the cell's header (a long list's count in its first word);
 *   `clusterLightTexel` reads a record. They follow `decodeCluster*` in
 *   `cluster-pack.ts` line for line.
 * - **Uniforms.** The grid changes every frame (its slices follow the
 *   farthest light), and so does where the headers start (past the
 *   records): its shape, slice mapping and that start are uniforms, so a new
 *   grid builds nothing.
 * - **The shadow atlas** (`shadow-atlas-draw.ts`) is the renderer's too: its
 *   depth texture and texel size ride here, so the light loop reads both
 *   from one place (a placeholder until the first shadowed light).
 * - **The light tables**: the area lights' LTC tables alone
 *   (`cluster-area.ts`), or, while a spot projects a cookie, the cookie atlas
 *   (`cookie-atlas.ts`) holding the tables in its first tile: one texture,
 *   one unit either way. The share of the texture the tables take rides with
 *   it, so switching builds nothing.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { ClusterGrid } from './cluster-build';
import { CLUSTER_COUNT_BITS, CLUSTER_LIGHT_TEXELS, CLUSTER_LONG_LIST, CLUSTER_TEXEL_WORDS, CLUSTER_TEXTURE_WIDTH, type ClusterPackResult, type ClusterTextures } from './cluster-pack';
import { ltcTablesTexture } from './cluster-area';
import type { N } from './effects-tsl';
import { targetTexture, texelTexture } from './texel-texture-node';

const TSL: N = TSLTyped;
const { If, clamp, float, floor, int, ivec2, log2, max, renderGroup, select, uint, uintBitsToFloat, uniform, vec2, vec4 } = TSL;

/** What an upload uses of three's renderer (either backend). */
export interface ClusterUploadRenderer {
  readonly backend: { readonly isWebGLBackend?: boolean; readonly device?: unknown; get(object: object): { texture?: unknown }; copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture, region: null, at: null): void };
  initTexture(texture: THREE.Texture): void;
}

type GpuQueue = { writeTexture(dst: { texture: unknown }, data: ArrayBufferView, layout: { bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number }): void };

/**
 * Each texture made here gets a version no earlier one had: three's WebGL 2
 * backend rebinds a texture node's new texture only when its version differs
 * from the old one's.
 */
let textureVersion = 0;
/** Revisions no other `ClusterGpu` had (a renderer's new one must rebind its readers whatever the old one's count was). */
let gpuRevision = 0;

function dataTexture(data: Uint32Array, rows: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, CLUSTER_TEXTURE_WIDTH, rows, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.version = Math.max(tex.version, ++textureVersion);
  return tex;
}

/**
 * A 1 × 1 compare-ready depth texture: what the light loop's atlas reads
 * before a renderer has an atlas. It belongs to a render target, as the
 * atlas does: three takes a depth texture without one to have the samples
 * of whatever the renderer draws at the time (MSAA's four), another binding.
 */
function placeholderAtlas(): THREE.RenderTarget {
  const t = new THREE.DepthTexture(1, 1, THREE.UnsignedShortType);
  t.compareFunction = THREE.LessEqualCompare;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return new THREE.RenderTarget(1, 1, { depthTexture: t, format: THREE.RedFormat });
}

/** One packed texture on the GPU: made again when its rows or its data array change, else its written rows sent. */
class ClusterTexture {
  texture: THREE.DataTexture;
  /** The data array the texture holds (a grown texture, or another view's, has another). */
  private data: Uint32Array;
  /** A texture three never uploads: its image is the rows a partial upload sends (WebGL 2). */
  private staging: THREE.DataTexture | null = null;
  /** Whether three has made the texture on the GPU (its first upload is whole). */
  private onGpu = false;

  constructor(data: Uint32Array, rows: number) {
    this.data = data;
    this.texture = dataTexture(data, rows);
  }

  /** `data` up to `texels` on the GPU: whether the texture was made again (its readers bind the new one), and the bytes sent. */
  upload(renderer: ClusterUploadRenderer, data: Uint32Array, rows: number, texels: number): { remade: boolean; bytes: number } {
    if (data !== this.data || rows !== this.texture.image.height) {
      this.texture.dispose();
      this.data = data;
      this.texture = dataTexture(data, rows);
      renderer.initTexture(this.texture);
      this.onGpu = true;
      return { remade: true, bytes: data.byteLength };
    }
    if (!this.onGpu) {
      renderer.initTexture(this.texture);
      this.onGpu = true;
      return { remade: false, bytes: data.byteLength };
    }
    if (texels <= 0) return { remade: false, bytes: 0 };
    const sendRows = Math.min(rows, Math.ceil(texels / CLUSTER_TEXTURE_WIDTH));
    const perTexel = data.BYTES_PER_ELEMENT * CLUSTER_TEXEL_WORDS;
    if (renderer.backend.isWebGLBackend === true) {
      let staging = this.staging;
      if (staging === null) {
        staging = this.staging = new THREE.DataTexture(data, CLUSTER_TEXTURE_WIDTH, sendRows, this.texture.format as THREE.PixelFormat, this.texture.type);
      }
      staging.image = { data, width: CLUSTER_TEXTURE_WIDTH, height: sendRows } as unknown as typeof staging.image;
      renderer.backend.copyTextureToTexture(staging, this.texture, null, null);
    } else {
      const device = renderer.backend.device as { queue: GpuQueue } | undefined;
      const gpu = renderer.backend.get(this.texture).texture;
      if (device === undefined || gpu === undefined) throw new Error('the cluster texture is not on the GPU');
      device.queue.writeTexture({ texture: gpu }, data, { bytesPerRow: CLUSTER_TEXTURE_WIDTH * perTexel, rowsPerImage: sendRows }, { width: CLUSTER_TEXTURE_WIDTH, height: sendRows });
    }
    return { remade: false, bytes: sendRows * CLUSTER_TEXTURE_WIDTH * perTexel };
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** The packed texture on one renderer, and the grid's uniforms, as the shader reads them. */
export class ClusterGpu {
  readonly lists: ClusterTexture;
  /** tiles x, tiles y, slice scale, slice bias. */
  readonly grid = new THREE.Vector4(1, 1, 0, 0);
  /** slices, cells, the first header's word (past the records), the shadow atlas's texel (1 / its side). */
  readonly extent = new THREE.Vector4(0, 0, 0, 1);
  /** The shadow atlas's depth (`shadow-atlas-draw.ts` sets it; `revision` moves when it does). */
  atlas: THREE.DepthTexture;
  /** The atlas read before a renderer has one (its render target freed with the rest). */
  private readonly placeholder = placeholderAtlas();
  /** The light tables (the LTC tables, or the cookie atlas holding them) and the share of it the tables take. */
  tables: THREE.Texture = ltcTablesTexture();
  readonly tablesShare = new THREE.Vector2(1, 1);
  /** The projection the lists were built with (the camera's, unjittered). */
  readonly projection = new THREE.Matrix4();
  /** Bumped when the texture was made again (its readers rebind). */
  revision = 0;

  constructor(textures: ClusterTextures) {
    this.lists = new ClusterTexture(textures.data, textures.rows);
    this.atlas = this.placeholder.depthTexture as THREE.DepthTexture;
  }

  /** This frame's grid and packed texture on the GPU; the bytes sent. */
  upload(renderer: ClusterUploadRenderer, grid: ClusterGrid, textures: ClusterTextures, packed: ClusterPackResult, projection: ArrayLike<number>): number {
    this.grid.set(grid.tilesX, grid.tilesY, grid.scale, grid.bias);
    this.projection.fromArray(projection);
    this.extent.set(grid.slices, grid.clusters, packed.listWord, 1 / Math.max(1, this.atlas.image.width ?? 1));
    const a = this.lists.upload(renderer, textures.data, textures.rows, packed.texels);
    if (a.remade) this.revision = ++gpuRevision;
    return a.bytes;
  }

  /** The renderer's shadow atlas from now on: its readers bind it. */
  setAtlas(depth: THREE.DepthTexture): void {
    if (depth === this.atlas) return;
    this.atlas = depth;
    this.extent.w = 1 / Math.max(1, depth.image.width ?? 1);
    this.revision = ++gpuRevision;
  }

  /** The light tables from now on (`share`: the part of the texture the LTC tables take): their readers bind them. */
  setTables(texture: THREE.Texture, shareX: number, shareY: number): void {
    if (texture === this.tables) return;
    this.tables = texture;
    this.tablesShare.set(shareX, shareY);
    this.revision = ++gpuRevision;
  }

  dispose(): void {
    this.lists.dispose();
    this.placeholder.depthTexture?.dispose();
    this.placeholder.dispose();
  }
}

/** The nodes a shader reads the lists through (one set per reading node; `sync` before each render). */
export interface ClusterNodes {
  readonly lists: N;
  readonly grid: N;
  readonly extent: N;
  readonly projection: N;
  /** The shadow atlas's depth (compare reads). */
  readonly atlas: N;
  /** The light tables, and the share of them the LTC tables take (vec2). */
  readonly tables: N;
  readonly tablesShare: N;
  sync(gpu: ClusterGpu): void;
}

export function clusterNodes(gpu: ClusterGpu): ClusterNodes {
  const nodes: ClusterNodes = {
    lists: texelTexture(gpu.lists.texture),
    // Once a render for every draw (the render group): an object three finds unchanged keeps its own group's
    // values, and the grid changes every frame.
    grid: uniform(new THREE.Vector4()).setGroup(renderGroup),
    extent: uniform(new THREE.Vector4()).setGroup(renderGroup),
    projection: uniform(new THREE.Matrix4()).setGroup(renderGroup),
    atlas: targetTexture(gpu.atlas),
    tables: texelTexture(gpu.tables),
    tablesShare: uniform(new THREE.Vector2(1, 1)).setGroup(renderGroup),
    sync(g) {
      nodes.lists.value = g.lists.texture;
      nodes.atlas.value = g.atlas;
      nodes.tables.value = g.tables;
      nodes.tablesShare.value.copy(g.tablesShare);
      nodes.grid.value.copy(g.grid);
      nodes.extent.value.copy(g.extent);
      nodes.projection.value.copy(g.projection);
    },
  };
  return nodes;
}

/** Texel `e` (an int node) of the packed texture. */
function texelAt(t: N, e: N): N {
  return t.load(ivec2(e.mod(CLUSTER_TEXTURE_WIDTH), e.div(CLUSTER_TEXTURE_WIDTH)));
}

/** Word `w` (an int node) of the packed texture: its texel's component `w mod 4`. */
function wordAt(t: N, w: N): N {
  const texel = texelAt(t, w.div(CLUSTER_TEXEL_WORDS));
  const c = w.mod(CLUSTER_TEXEL_WORDS);
  return select(c.equal(0), texel.x, select(c.equal(1), texel.y, select(c.equal(2), texel.z, texel.w)));
}

/**
 * The cell (an int node; -1 past the last slice) of a pixel at `screen`
 * (its share of the render size, 0–1, y up) and view depth `depth` (m,
 * positive). Nearer than the first slice reads slice 0.
 */
export function clusterCell(t: ClusterNodes, screen: N, depth: N): N {
  const tilesX = t.grid.x;
  const tilesY = t.grid.y;
  const tx = clamp(floor(screen.x.mul(tilesX)), float(0), tilesX.sub(1));
  const ty = clamp(floor(screen.y.mul(tilesY)), float(0), tilesY.sub(1));
  const s = floor(log2(max(depth, float(1e-6))).mul(t.grid.z).add(t.grid.w));
  const slice = max(s, float(0));
  const cell = int(tx.add(tilesX.mul(ty.add(tilesY.mul(slice)))));
  return select(slice.lessThan(t.extent.x), cell, int(-1));
}

/** The cell (an int node; -1 past the last slice) of a pixel at view position `view` (vec3 node), placed through the lists' projection. */
export function clusterCellAt(t: ClusterNodes, view: N): N {
  const clip = t.projection.mul(vec4(view, 1));
  const share = clip.xy.div(clip.w).mul(0.5).add(vec2(0.5));
  return clusterCell(t, share, view.z.negate());
}

/** A cell's list: the word its first index is at, and its count (int nodes, variables named from `name`, one name per reader in a program). */
export function clusterList(t: ClusterNodes, cell: N, name = 'tlCluster'): { at: N; count: N } {
  const base = int(t.extent.z);
  const head = wordAt(t.lists, base.add(cell));
  const at = int(head.div(uint(1 << CLUSTER_COUNT_BITS))).add(base).add(int(t.extent.y)).toVar(`${name}At`);
  const count = int(head.mod(uint(1 << CLUSTER_COUNT_BITS))).toVar(`${name}Count`);
  If(count.equal(CLUSTER_LONG_LIST), () => {
    count.assign(int(wordAt(t.lists, at)));
    at.addAssign(1);
  });
  return { at, count };
}

/** The light index (an int node) at word `w` of a list. */
export function clusterIndexAt(t: ClusterNodes, w: N): N {
  return int(wordAt(t.lists, w));
}

/** Texel `e` (an int node) of the packed texture, its words as the floats they hold (a shadow record's). */
export function clusterTexel(t: ClusterNodes, e: N): N {
  return uintBitsToFloat(texelAt(t.lists, e));
}

/** Texel `k` of light record `index` (an int node), its words as the floats they hold. */
export function clusterLightTexel(t: ClusterNodes, index: N, k: number): N {
  return uintBitsToFloat(texelAt(t.lists, index.mul(CLUSTER_LIGHT_TEXELS).add(k)));
}
