/**
 * The packed light lists on the GPU (`cluster-pack.ts` writes them on the
 * CPU), and their reads in a shader: one RGBA32F texture of light records
 * and one R32UI texture of cell headers and index lists, both read with
 * `textureLoad` / `texelFetch` only, the same on WebGPU and WebGL 2.
 *
 * - **Upload.** A texture whose rows grew (or whose data is another view's)
 *   is made again and uploaded whole; otherwise only the rows this frame
 *   wrote go up: `queue.writeTexture` on WebGPU, `texSubImage2D` (three's
 *   copy from a texture never given to the GPU) on WebGL 2. three's own
 *   update path would send the whole texture every frame.
 * - **Reads.** `clusterCell` finds a pixel's cell from its place on the
 *   screen (a share of the render size, so the render scale, dynamic
 *   resolution and TAAU change nothing) and its view depth; `clusterList`
 *   decodes the cell's header (a long list's count in its first texel);
 *   `clusterLightTexel` reads a record. They follow `decodeCluster*` in
 *   `cluster-pack.ts` line for line.
 * - **Uniforms.** The grid changes every frame (its slices follow the
 *   farthest light): its shape and slice mapping are uniforms, so a new grid
 *   builds nothing.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { ClusterGrid } from './cluster-build';
import { CLUSTER_COUNT_BITS, CLUSTER_LIGHT_TEXELS, CLUSTER_LONG_LIST, CLUSTER_TEXTURE_WIDTH, type ClusterPackResult, type ClusterTextures } from './cluster-pack';
import type { N } from './effects-tsl';
import { texelTexture } from './texel-texture-node';

const TSL: N = TSLTyped;
const { If, clamp, float, floor, int, ivec2, log2, max, select, uint, uniform } = TSL;

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

function dataTexture(data: Float32Array | Uint32Array, rows: number): THREE.DataTexture {
  const float = data instanceof Float32Array;
  const tex = new THREE.DataTexture(data, CLUSTER_TEXTURE_WIDTH, rows, float ? THREE.RGBAFormat : THREE.RedIntegerFormat, float ? THREE.FloatType : THREE.UnsignedIntType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.version = Math.max(tex.version, ++textureVersion);
  return tex;
}

/** One packed texture on the GPU: made again when its rows or its data array change, else its written rows sent. */
class ClusterTexture {
  texture: THREE.DataTexture;
  /** The data array the texture holds (a grown texture, or another view's, has another). */
  private data: Float32Array | Uint32Array;
  /** A texture three never uploads: its image is the rows a partial upload sends (WebGL 2). */
  private staging: THREE.DataTexture | null = null;
  /** Whether three has made the texture on the GPU (its first upload is whole). */
  private onGpu = false;

  constructor(data: Float32Array | Uint32Array, rows: number) {
    this.data = data;
    this.texture = dataTexture(data, rows);
  }

  /** `data` up to `texels` on the GPU: whether the texture was made again (its readers bind the new one), and the bytes sent. */
  upload(renderer: ClusterUploadRenderer, data: Float32Array | Uint32Array, rows: number, texels: number): { remade: boolean; bytes: number } {
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
    const perTexel = data.BYTES_PER_ELEMENT * (data instanceof Float32Array ? 4 : 1);
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

/** The two packed textures on one renderer, and the grid's uniforms, as the shader reads them. */
export class ClusterGpu {
  readonly lights: ClusterTexture;
  readonly cells: ClusterTexture;
  /** tiles x, tiles y, slice scale, slice bias. */
  readonly grid = new THREE.Vector4(1, 1, 0, 0);
  /** slices, cells (where the lists start), 0, 0. */
  readonly extent = new THREE.Vector4(0, 0, 0, 0);
  /** Bumped when a texture was made again (its readers rebind). */
  revision = 0;

  constructor(textures: ClusterTextures) {
    this.lights = new ClusterTexture(textures.lightData, textures.lightRows);
    this.cells = new ClusterTexture(textures.clusterData, textures.clusterRows);
  }

  /** This frame's grid and packed textures on the GPU; the bytes sent. */
  upload(renderer: ClusterUploadRenderer, grid: ClusterGrid, textures: ClusterTextures, packed: ClusterPackResult): number {
    this.grid.set(grid.tilesX, grid.tilesY, grid.scale, grid.bias);
    this.extent.set(grid.slices, grid.clusters, 0, 0);
    const a = this.lights.upload(renderer, textures.lightData, textures.lightRows, packed.lightTexels);
    const b = this.cells.upload(renderer, textures.clusterData, textures.clusterRows, packed.clusterTexels);
    if (a.remade || b.remade) this.revision += 1;
    return a.bytes + b.bytes;
  }

  dispose(): void {
    this.lights.dispose();
    this.cells.dispose();
  }
}

/** The nodes a shader reads the lists through (one set per reading node; `sync` before each render). */
export interface ClusterNodes {
  readonly lights: N;
  readonly cells: N;
  readonly grid: N;
  readonly extent: N;
  sync(gpu: ClusterGpu): void;
}

export function clusterNodes(gpu: ClusterGpu): ClusterNodes {
  const nodes: ClusterNodes = {
    lights: texelTexture(gpu.lights.texture),
    cells: texelTexture(gpu.cells.texture),
    grid: uniform(new THREE.Vector4()),
    extent: uniform(new THREE.Vector4()),
    sync(g) {
      nodes.lights.value = g.lights.texture;
      nodes.cells.value = g.cells.texture;
      nodes.grid.value.copy(g.grid);
      nodes.extent.value.copy(g.extent);
    },
  };
  return nodes;
}

/** Texel `e` (an int node) of a packed texture. */
function texelAt(t: N, e: N): N {
  return t.load(ivec2(e.mod(CLUSTER_TEXTURE_WIDTH), e.div(CLUSTER_TEXTURE_WIDTH)));
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

/** A cell's list: the texel its first index is at, and its count (int nodes, variables). */
export function clusterList(t: ClusterNodes, cell: N): { at: N; count: N } {
  const head = texelAt(t.cells, cell).x;
  const at = int(head.div(uint(1 << CLUSTER_COUNT_BITS))).add(int(t.extent.y)).toVar('tlClusterAt');
  const count = int(head.mod(uint(1 << CLUSTER_COUNT_BITS))).toVar('tlClusterCount');
  If(count.equal(CLUSTER_LONG_LIST), () => {
    count.assign(int(texelAt(t.cells, at).x));
    at.addAssign(1);
  });
  return { at, count };
}

/** The light index (an int node) at texel `e` of a list. */
export function clusterIndexAt(t: ClusterNodes, e: N): N {
  return int(texelAt(t.cells, e).x);
}

/** Texel `k` of light record `index` (an int node). */
export function clusterLightTexel(t: ClusterNodes, index: N, k: number): N {
  return texelAt(t.lights, index.mul(CLUSTER_LIGHT_TEXELS).add(k));
}
