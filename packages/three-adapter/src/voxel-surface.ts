/**
 * The voxel surface shader and the GPU home of the shader data it reads.
 *
 * Voxel surface meshes carry only positions and normals. Each pixel finds
 * the materials around it in its chunk's shader grid (a cell's material id
 * and wetness, the chunk's cells plus a border of its neighbours', so a
 * blend crosses a chunk face without a seam) and blends them in the
 * shader: the eight cell centres around the pixel (moved a fixed depth into
 * the surface along its normal, so a face between a solid and an air cell
 * reads the solid one), each weighted per axis by a ramp of the blend
 * distance across the face between two cells, air cells left out. The two
 * heaviest materials are looked up (their texture sets, or a flat colour)
 * and mixed by their weights and heights: each material's height (0–1, in
 * its albedo's A) times its own height depth in metres decides which
 * shows where they meet (`voxel-surface-wetness.ts`). Wetness, averaged the
 * same way, darkens the colour, lowers the roughness, flattens the normal
 * detail and fills the crevices with standing water first, by height. A
 * material or wetness change re-uploads a grid and rebuilds no mesh, and the
 * blend is a function of the cells alone, so it looks the same on any mesh
 * that covers the surface.
 *
 * Terrain materials are projected in world space from three axes
 * (triplanar); construction (a cell of a construction role: the entry's
 * construction bit) is mapped from the build grid in metres
 * (`voxel-surface-projection.ts`: U along the face, V up it, a roof plane's
 * V up its slope), so a band of a texture sits at the same height on every
 * wall and floor. Each material's table entry gives the metres one repeat
 * covers for either (construction one 4 m full wall, terrain 2 m by
 * default). The texture phase is taken from the chunk's integer cell (per
 * object), so a floating-origin shift never moves a texture.
 *
 * A pixel whose blend finds no solid cell (a roof plane runs up to a cell
 * above each step of its stair, through air cells) takes the nearest solid
 * of the eight cells read instead, by plain trilinear weight: the roof's
 * own cells, not a neutral grey. Where all eight are air (an even roof's
 * ridge and hip apex lie a whole cell above its top voxels) it takes the
 * cell under them in its nearest column.
 *
 * **Owned faces.** A face whose vertices carry an owner offset (the voxel
 * derive's: a roof plane, the closing geometry a roof sets on a wall, a
 * wall's faces next to a roof; {@link VOXEL_OWNER_ATTRIBUTE}) shows its
 * owner cell's material and wetness alone, read in one more texel: the
 * pixel's position plus the interpolated offset lies in that cell. So a
 * roof and the wall it sits on never blend across their seam.
 *
 * Coarser levels of the chunk tree draw through the same program: a node's
 * grid holds its own (coarser) cells, so each object passes its cell size
 * and the grid is read in its cells, while the read depth, the blend
 * distance and the pattern scale stay in metres: a blend is equally wide, a
 * pattern the same size, and a thin surface layer read, at every level.
 *
 * The grids live in one GPU-only 3D texture (two bytes a cell, `rg8unorm`:
 * the entry's low byte, then its high byte), a chunk a `side`³ region. A
 * region is uploaded on its own (`queue.writeTexture` on WebGPU,
 * `texSubImage3D` through three's copy on WebGL 2), no CPU copy of the
 * texture is kept, and the texture grows by a GPU copy into a larger one.
 * A chunk whose grid holds one solid entry needs no region: the object
 * passes the entry instead.
 *
 * **Texture sets.** A material's surfaces draw from three texture arrays
 * (`setTextures`; one a map: albedo with the height in A, tangent-space
 * normal, ORM; texture layout v1), a layer per texture set; the table holds each material's wall,
 * floor and ceiling layer. Construction picks the floor layer on a face
 * looking up, the ceiling layer on one looking down and the wall layer on
 * every other (a roof plane included); terrain draws its one set (the
 * wall's) triplanar. A layer is sampled on the same projection as the
 * colour (the grid's U/V on construction, three axes on terrain) and the
 * normal map turned by that projection's frame (the grid's U and V, or each
 * axis's), so a texture's light and shade line up with its colour on every
 * face. A material without a layer draws its flat colour, its geometry
 * normal and the absent ORM. The test patterns (grey value noise, planks,
 * cobbles) replace the arrays under the `patterns` option.
 *
 * Texture units: the grid texture, the material table, the three texture
 * arrays and the crack array, six of a lit program's sixteen
 * (`texture-units.ts`; the pattern array in place of the three under
 * `patterns`: four); the band test texture one more when it is on, the
 * relief test heights one more under `patterns`. Reads a pixel: nine grid texels (ten
 * with the owner cell's), seven table texels (look, tiles and layers of two
 * materials, the crack layer of the first; two more, the materials' height
 * depths), three samples of each array for
 * each of the two materials (a construction material takes one projection,
 * through the first of its three samples; under `patterns` six pattern
 * samples) and one crack sample, two band samples more with the bands on.
 *
 * **Cracks.** A cracked block's faces (voxel damage stage 1) carry the
 * overlay's strength in a vertex attribute ({@link VOXEL_CRACK_ATTRIBUTE});
 * the crack texture (voxel-crack-texture.ts: the engine's, or the
 * material's kit's own) is one map a construction tile, laid on the build
 * grid exactly as the material's texture (its tile's metres, the same
 * phase), so cracked cells side by side show one pattern; a texel at or
 * above 1 − strength darkens the face there, so the cracks grow as the
 * integrity drops.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { VOXEL_MATERIAL_LIMITS, VOXEL_TEXTURE_MAPS, type VoxelTextureMap } from '@thirdlight/project-model';
import { CONSTRUCTION_TILE_METRES, SHADER_CONSTRUCTION_BIT, SURFACE_OWNER_STEPS_PER_CELL, TERRAIN_TILE_METRES } from '@thirdlight/voxel';
import { crackArrayTexture } from './voxel-crack-texture';
import { reliefHeightTexture } from './voxel-relief';

/**
 * The surface geometry's attribute holding a face's crack overlay strength (0 … 1: the derive's position w / 255),
 * non-zero only on a cracked cell's faces (voxel damage stage 1).
 */
export const VOXEL_CRACK_ATTRIBUTE = 'voxelCrack';

/**
 * The surface geometry's attribute holding a vertex's owner offset (snorm8x4: x, y, z the offset in quarter cells
 * of its buffer's cells times 1/127, w 1/127 when it has one; voxel `surfaceOwnerOf`), all 0 on a blended face.
 */
export const VOXEL_OWNER_ATTRIBUTE = 'voxelOwner';

/**
 * The relief mesh's attribute holding a vertex's crease weight (0 … 1: the
 * derive's byte / 255; 0 stays on the plain surface, 1 moves its full
 * depth); present only on relief draws, the only ones displaced.
 */
export const VOXEL_CREASE_ATTRIBUTE = 'voxelCrease';

/** A level past any texture array's last (a 4096² set has 13): sampled there, a far draw reads a set's mean colour. */
const FAR_MEAN_LEVEL = 16;

/** How much a crack darkens the face under it (0 … 1). */
const CRACK_DARKEN = 0.7;

import { cameraRelative } from './camera-relative';
import { WORLD_MAPPED_TEXTURES_KEY, type WorldMappedTextures } from './texture-streaming';
import type { N } from './effects-tsl';
import { texelTexture, texelTexture3D } from './texel-texture-node';
import { BAND_TEXELS, bandTexels, gridUv, tileUv } from './voxel-surface-projection';
import { declareVertexReach } from './vertex-reach';
import { NEUTRAL_TEXELS, NODE_OPS, textureHeightAt, textureSetAt, type SetProjectionMode } from './voxel-surface-sets';
import { seamBlendMetres, type BlendCell } from './voxel-surface-blend';
import { heightBlend, WET_DARKEN, WET_WATER_ROUGHNESS, wetLook } from './voxel-surface-wetness';

const TSL: N = TSLTyped;
const { Fn, abs, attribute, clamp, faceDirection, float, floor, int, ivec2, ivec3, log2, max, min, mix, mod, modelWorldMatrix, normalLocal, normalView, positionGeometry, positionLocal, positionView, positionWorld, property, select, smoothstep, sqrt, texture, transformNormalToView, uniform, varying, vec2, vec3, vec4 } = TSL;

/** The object `userData` key holding a voxel surface's per-object values ({@link VoxelSurfaceObject}). */
export const VOXEL_SURFACE_KEY = 'tlVoxelSurface';

/** Largest edge of the grid texture (texels): WebGPU's default 3D texture limit, which WebGL 2 desktop GPUs meet too. */
export const VOXEL_GRID_MAX_EDGE = 2048;

/** Entries the material table holds (material ids 0 … 4,095), 64 a row. */
const TABLE_WIDTH = 64;
/** Rows of one block of the table: looks in the first block, tiles in the second, heights in the third, texture layers in the fourth. */
const TABLE_ROWS = 4096 / TABLE_WIDTH;
/** The first texel of the table's layer block. */
const LAYER_BLOCK = 3 * TABLE_ROWS * TABLE_WIDTH;
/** Texels along a test pattern's side, and how many patterns there are. */
const PATTERN_SIZE = 64;
export const VOXEL_PATTERNS = 4;
/** Anisotropic filtering of the texture arrays: floors and walls are seen at grazing angles. */
const TEXTURE_ANISOTROPY = 4;
/** The texture arrays the surfaces draw from, one a map of a texture set (a map left out: its neutral value). */
export type VoxelSurfaceTextureArrays = Partial<Record<VoxelTextureMap, THREE.Texture>>;

/** How the shader data's cells and entries are laid out (the voxel format's numbers, passed in by its owner). */
export interface VoxelSurfaceLayout {
  /** Metres a cell. */
  readonly cellMetres: number;
  /** Cells along a grid's side (chunk edge + 2 · border). */
  readonly side: number;
  /** Cells of neighbouring chunks a grid holds on each side. */
  readonly border: number;
  /** Bits of an entry's material id (the wetness sits above them). */
  readonly materialBits: number;
  /** Largest wetness. */
  readonly wetnessMax: number;
  /** How far into a surface the grid is read (level-0 cells, so the same metres at every level). */
  readonly readDepthCells: number;
}

/** What a surface object passes the shader (in its `userData` under {@link VOXEL_SURFACE_KEY}). */
export interface VoxelSurfaceObject {
  /** The grid's region origin in the texture (texels: x, y, z) and the chunk's one solid entry (w; −1: read the grid). */
  readonly slot: THREE.Vector4;
  /** The chunk corner's cell (level-0 cells), each axis modulo {@link PHASE_CELLS}: where its textures start. */
  readonly phase: THREE.Vector3;
  /** The chunk corner in metres, each axis modulo {@link PHASE_CELLS} cells times √2: where a 45° slope's V starts (`gridPhases`). */
  readonly slopePhase: THREE.Vector3;
  /** The same modulo {@link PHASE_CELLS} cells times √5: where a 1:2 slope's V starts. */
  readonly slope5Phase: THREE.Vector3;
  /** Metres a cell of the object's grid (its level's cells; the layout's for level 0). */
  cellMetres: number;
}

/** Cells after which every pattern repeats a whole number of times (the per-object texture phase is taken modulo it). */
export const PHASE_CELLS = 1024;

type GpuQueue = { writeTexture(dst: { texture: unknown; origin: { x: number; y: number; z: number } }, data: ArrayBufferView, layout: { bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number; depthOrArrayLayers: number }): void };

/** What the grid store uploads and copies with (three's WebGPU renderer, either backend). */
export interface VoxelGridRenderer {
  readonly backend: { readonly isWebGLBackend?: boolean; readonly device?: unknown; get(object: object): { texture?: unknown }; copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture, region: null, at: THREE.Vector3): void };
  initTexture(texture: THREE.Texture): void;
  copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture, region: THREE.Box3 | null, at: THREE.Vector3 | null): void;
}

/**
 * Each texture made gets a version no earlier one had: three's WebGL 2
 * backend rebinds a texture node's new texture only when its version
 * differs from the old one's.
 */
let textureVersion = 0;
function fresh<T extends THREE.Texture>(tex: T): T {
  tex.needsUpdate = true;
  tex.version = Math.max(tex.version, ++textureVersion);
  return tex;
}

/** What a region store's texels are: their format, bytes a texel, and how they are filtered when sampled. */
export interface RegionTexels {
  readonly format: typeof THREE.RedFormat | typeof THREE.RGFormat | typeof THREE.RGBAFormat;
  readonly bytes: 1 | 2 | 4;
  readonly filter: typeof THREE.NearestFilter | typeof THREE.LinearFilter;
}

/** The shader grids' texels: an entry's two bytes, read texel by texel. */
const GRID_TEXELS: RegionTexels = { format: THREE.RGFormat, bytes: 2, filter: THREE.NearestFilter };

/** The share of a region store's smaller size that must stay free for {@link VoxelShaderGrids.trim} to shrink to it. */
export const GRID_TRIM_SLACK = 1 / 8;

function gridTexture(width: number, height: number, depth: number, data: Uint8Array | null, texels: RegionTexels = GRID_TEXELS): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(data, width, height, depth);
  tex.format = texels.format;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = texels.filter;
  tex.magFilter = texels.filter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  // Allocated on the GPU without data: the grids are copied in.
  if (data === null) tex.source.dataReady = false;
  return fresh(tex);
}

/**
 * The resident chunks' shader grids on the GPU: one region of `side`³
 * texels a chunk, regions handed out and given back as chunks come and go.
 * Texel (x, y, z) of a region is grid cell (y, z, x)'s entry: the grid's
 * order (x, z, y with y fastest) is the texture's memory order, so a grid
 * uploads as it is. The same store with other texels (`texels`) keeps the
 * far field's distance bricks, a brick a region.
 *
 * Regions are handed out from the oldest part of the texture first (the
 * size it had before each growth), so what a later growth added empties as
 * its holders go; {@link trim} then gives that part back.
 */
export class VoxelShaderGrids {
  texture: THREE.Data3DTexture;
  /** Regions along each axis of the texture. */
  private dims: [number, number, number] = [0, 0, 0];
  /** The regions along each axis after each growth (the last is {@link dims}). */
  private steps: Array<[number, number, number]> = [];
  /** Free regions by the growth that added them, each handed out lowest first. */
  private free: Array<Array<[number, number, number]>> = [];
  /** Regions in use by the growth that added them. */
  private usedIn: number[] = [];
  private used = 0;
  private retired: { texture: THREE.Texture; frames: number }[] = [];
  /** Uploads since made, and their bytes. */
  uploads = 0;
  uploadedBytes = 0;
  /** Times the texture grew, and shrank. */
  grown = 0;
  shrunk = 0;

  constructor(
    readonly layout: Pick<VoxelSurfaceLayout, 'side'>,
    private readonly texels: RegionTexels = GRID_TEXELS,
  ) {
    // A one-texel stand-in until the first grid: a program binds a texture of the right kind from the start.
    this.texture = gridTexture(1, 1, 1, new Uint8Array(texels.bytes), texels);
  }

  /** Regions in use. */
  get count(): number {
    return this.used;
  }

  /** Regions the texture holds. */
  get capacity(): number {
    return this.dims[0] * this.dims[1] * this.dims[2];
  }

  /** Bytes the texture holds on the GPU. */
  get gpuBytes(): number {
    return this.capacity * this.regionBytes;
  }

  /** Bytes one region holds. */
  get regionBytes(): number {
    return this.layout.side ** 3 * this.texels.bytes;
  }

  /** A free region's origin (texels), the texture grown when none is left. */
  allocate(renderer: VoxelGridRenderer): THREE.Vector3 {
    let g = this.free.findIndex((f) => f.length > 0);
    if (g < 0) {
      this.grow(renderer);
      g = this.free.length - 1;
    }
    const [x, y, z] = this.free[g]!.pop()!;
    this.usedIn[g]!++;
    this.used++;
    const s = this.layout.side;
    return new THREE.Vector3(x * s, y * s, z * s);
  }

  /** Gives a region back. */
  release(origin: THREE.Vector3): void {
    const s = this.layout.side;
    const r: [number, number, number] = [origin.x / s, origin.y / s, origin.z / s];
    const g = this.stepOf(r);
    this.free[g]!.push(r);
    this.usedIn[g]!--;
    this.used--;
  }

  /** The growth that added a region: the first size that holds it. */
  private stepOf(r: readonly [number, number, number]): number {
    const g = this.steps.findIndex((d) => r[0] < d[0] && r[1] < d[1] && r[2] < d[2]);
    if (g < 0) throw new Error(`voxel grid texture: region ${r.join(', ')} is not one of its regions`);
    return g;
  }

  /**
   * Gives back the part of the texture later growths added once none of its regions is in use (a copy on the GPU
   * into a texture of the earlier size; the regions in use keep their origins), as long as a share
   * ({@link GRID_TRIM_SLACK}) of the smaller texture stays free, so a store at its size does not shrink and grow
   * again by turns. True when it shrank.
   */
  trim(renderer: VoxelGridRenderer): boolean {
    let k = this.steps.length - 1;
    while (k > 0 && this.usedIn[k] === 0) {
      const d = this.steps[k - 1]!;
      if (this.used > d[0] * d[1] * d[2] * (1 - GRID_TRIM_SLACK)) break;
      k--;
    }
    if (k === this.steps.length - 1) return false;
    const s = this.layout.side;
    const next = this.steps[k]!;
    const tex = gridTexture(next[0] * s, next[1] * s, next[2] * s, null, this.texels);
    renderer.initTexture(tex);
    renderer.copyTextureToTexture(this.texture, tex, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(next[0] * s, next[1] * s, next[2] * s)), new THREE.Vector3(0, 0, 0));
    this.steps.length = this.free.length = this.usedIn.length = k + 1;
    this.retired.push({ texture: this.texture, frames: 2 });
    this.texture = tex;
    this.dims = [next[0], next[1], next[2]];
    this.shrunk++;
    this.onTexture?.(tex);
    return true;
  }

  /** Uploads a grid (side³ entries, grid order; or side³ texels of the store's own) into its region. */
  upload(renderer: VoxelGridRenderer, origin: THREE.Vector3, entries: Uint16Array | Uint8Array): void {
    const s = this.layout.side;
    const t = this.texels.bytes;
    const bytes = new Uint8Array(entries.buffer, entries.byteOffset, s * s * s * t);
    renderer.initTexture(this.texture);
    if (renderer.backend.isWebGLBackend === true) {
      // A texture never given to the GPU: three's copy uploads its data straight into the region.
      const src = new THREE.Data3DTexture(bytes, s, s, s);
      src.format = this.texels.format;
      src.type = THREE.UnsignedByteType;
      renderer.backend.copyTextureToTexture(src, this.texture, null, origin);
    } else {
      const device = renderer.backend.device as { queue: GpuQueue } | undefined;
      const gpu = renderer.backend.get(this.texture).texture;
      if (device === undefined || gpu === undefined) throw new Error('the voxel grid texture is not on the GPU');
      device.queue.writeTexture({ texture: gpu, origin: { x: origin.x, y: origin.y, z: origin.z } }, bytes, { bytesPerRow: s * t, rowsPerImage: s }, { width: s, height: s, depthOrArrayLayers: s });
    }
    this.uploads++;
    this.uploadedBytes += bytes.byteLength;
  }

  /** Call once a frame: textures replaced two frames ago are disposed (no frame binds them any more). */
  frame(): void {
    this.retired = this.retired.filter((r) => {
      if (--r.frames > 0) return true;
      r.texture.dispose();
      return false;
    });
  }

  dispose(): void {
    for (const r of this.retired) r.texture.dispose();
    this.retired = [];
    this.texture.dispose();
  }

  /**
   * Grows the regions along the shortest axis by a quarter (at least one;
   * the first grid makes 4³), copying the old texture in on the GPU: a
   * small step, so little of the texture stands empty.
   */
  private grow(renderer: VoxelGridRenderer): void {
    const s = this.layout.side;
    const per = Math.floor(VOXEL_GRID_MAX_EDGE / s);
    const old = this.dims;
    let next: [number, number, number];
    if (old[0] === 0) next = [4, 4, 4];
    else {
      const axis = [2, 1, 0].reduce((best, a) => (old[a]! < old[best]! ? a : best), 2);
      next = [old[0], old[1], old[2]];
      next[axis] = Math.min(per, old[axis]! + Math.max(1, Math.floor(old[axis]! / 4)));
      if (next[axis] === old[axis]) throw new Error(`voxel grid texture: no room past ${old.join(' × ')} regions`);
    }
    const tex = gridTexture(next[0] * s, next[1] * s, next[2] * s, null, this.texels);
    renderer.initTexture(tex);
    if (old[0] > 0) renderer.copyTextureToTexture(this.texture, tex, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(old[0] * s, old[1] * s, old[2] * s)), new THREE.Vector3(0, 0, 0));
    // The new regions, handed out lowest first.
    const added: Array<[number, number, number]> = [];
    for (let z = next[2] - 1; z >= 0; z--) for (let y = next[1] - 1; y >= 0; y--) for (let x = next[0] - 1; x >= 0; x--) {
      if (x < old[0] && y < old[1] && z < old[2]) continue;
      added.push([x, y, z]);
    }
    this.free.push(added);
    this.usedIn.push(0);
    this.steps.push([next[0], next[1], next[2]]);
    this.retired.push({ texture: this.texture, frames: 2 });
    this.texture = tex;
    this.dims = next;
    this.grown++;
    this.onTexture?.(tex);
  }

  /** Told when the texture is replaced (the material binds the new one). */
  onTexture: ((tex: THREE.Data3DTexture) => void) | null = null;
}

/**
 * A material's look in the table: a colour (sRGB hex), a test pattern
 * (0 … {@link VOXEL_PATTERNS} − 1), and the metres one repeat of its
 * texture covers on construction and on terrain (defaults
 * CONSTRUCTION_TILE_METRES and TERRAIN_TILE_METRES; each must divide the
 * phase length, {@link PHASE_CELLS} cells, so the phase never moves it).
 */
export interface VoxelMaterialLook {
  readonly colour: number;
  readonly pattern: number;
  readonly constructionTileMetres?: number;
  readonly terrainTileMetres?: number;
  /**
   * Metres its height map's 0 lies below its surface (its 1): how its height blends with a neighbour's, how deep its
   * crevices fill with water, how far relief moves it (absent: the material record's default).
   */
  readonly heightDepthMetres?: number;
  /** Metres over which it blends into a neighbouring material (absent: the surface's, {@link VoxelSurface.setBlendMetres}); the smaller of two wins. */
  readonly blendMetres?: number;
  /** Under `patterns`, its layer of the relief test heights (absent: flat): the debug program has no texture sets. */
  readonly testHeightLayer?: number;
}

/** The test patterns: flat, grain, planks, cobbles (luminance about 0.5, in every channel). */
function patternTexture(): THREE.DataArrayTexture {
  const n = PATTERN_SIZE;
  const data = new Uint8Array(n * n * VOXEL_PATTERNS * 4);
  // A small deterministic hash: the same pattern on every run and renderer.
  const hash = (x: number, y: number, k: number): number => {
    let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  for (let k = 0; k < VOXEL_PATTERNS; k++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 0.5;
    if (k === 1) v = 0.35 + 0.3 * (0.6 * hash(x, y, 1) + 0.4 * hash(x >> 2, y >> 2, 2));
    else if (k === 2) v = 0.5 + 0.18 * Math.sin((y / n) * Math.PI * 8) + 0.08 * (hash(x >> 3, y, 3) - 0.5) - ((y % 16) === 0 ? 0.25 : 0);
    else if (k === 3) {
      const row = y >> 4;
      const xs = (x + (row & 1) * 8) % 16;
      v = (y % 16) < 2 || xs < 2 ? 0.25 : 0.5 + 0.15 * (hash((x + (row & 1) * 8) >> 4, row, 4) - 0.5);
    }
    const b = Math.max(0, Math.min(255, Math.round(v * 255)));
    const o = ((k * n + y) * n + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = b;
    data[o + 3] = 255;
  }
  const tex = new THREE.DataArrayTexture(data, n, n, VOXEL_PATTERNS);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return fresh(tex);
}

/** A two-layer array of one texel a layer: what a map's array node holds until (or without) the real array. */
function neutralArray(texel: readonly number[]): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(new Uint8Array([...texel, ...texel]), 1, 1, 2);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Filtered as the real arrays are: three builds a nearest-filtered texture's reads as loads, and the program keeps
  // the reads it was built with when the array arrives.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  return fresh(tex);
}

/** Each map's neutral array. */
const neutralArrays = (): Record<VoxelTextureMap, THREE.DataArrayTexture> => ({ albedo: neutralArray(NEUTRAL_TEXELS.albedo), normal: neutralArray(NEUTRAL_TEXELS.normal), orm: neutralArray(NEUTRAL_TEXELS.orm) });

/** Binds each map's array (absent: its neutral one) to its node. */
function bindArrays(nodes: Record<VoxelTextureMap, N>, neutral: Record<VoxelTextureMap, THREE.Texture>, arrays: VoxelSurfaceTextureArrays | null): void {
  for (const map of VOXEL_TEXTURE_MAPS) {
    const t = arrays?.[map] ?? neutral[map];
    if (t !== neutral[map]) {
      // A tile repeats (a loaded KTX2 clamps by default), at a grazing view too.
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = TEXTURE_ANISOTROPY;
    }
    (nodes[map] as unknown as { value: THREE.Texture }).value = t;
  }
}

/**
 * The arrays as world-mapped textures (texture-streaming.ts) at the finest tile a material with a layer draws them
 * at (the table's tile and layer blocks), so a page's streamer measures their need from the chunks drawn with them.
 */
function worldMapped(tdata: Float32Array, ids: number, textures: THREE.Texture[]): WorldMappedTextures {
  let tile = Infinity;
  for (let m = 1; m < ids; m++) {
    const ly = (LAYER_BLOCK + m) * 4;
    if (tdata[ly]! < 0 && tdata[ly + 1]! < 0 && tdata[ly + 2]! < 0) continue;
    const t = (TABLE_ROWS * TABLE_WIDTH + m) * 4;
    tile = Math.min(tile, tdata[t]!, tdata[t + 1]!);
  }
  return { textures, tileMetres: Number.isFinite(tile) ? tile : CONSTRUCTION_TILE_METRES };
}

/** The band test texture over one construction tile (`voxel-surface-projection.ts`). */
function bandTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(bandTexels(CONSTRUCTION_TILE_METRES), BAND_TEXELS, BAND_TEXELS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return fresh(tex);
}

/**
 * The material table: a texel a material id, linear colour in rgb, pattern
 * index in a; a second block of rows below it the tiles (construction
 * metres in r, terrain metres in g) and its crack layer in b (0: the
 * engine's; voxel-crack-texture.ts); a third its relief (height layer in r,
 * −1 none; depth in metres in g) and its own blend metres in b (−1: the
 * surface's); a fourth its texture layers (wall, floor,
 * ceiling in r, g, b; −1 none).
 */
function tableTexture(): THREE.DataTexture {
  const rows = 4 * TABLE_ROWS;
  const data = new Float32Array(TABLE_WIDTH * rows * 4);
  // No material has a texture layer until the arrays are set.
  data.fill(-1, LAYER_BLOCK * 4);
  const tex = new THREE.DataTexture(data, TABLE_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return fresh(tex);
}

export interface VoxelSurfaceOptions {
  /** The look of material id `m` (ids 1 … 2^materialBits − 1). */
  look(material: number): VoxelMaterialLook;
  /** Metres over which two neighbouring cells' materials blend (0 … one cell) where neither material sets its own. */
  blendMetres: number;
  /** `flat`: one colour, no reads (to measure what the blend costs). */
  shading?: 'blend' | 'flat';
  /** Draw construction with the band test texture (bands at fixed heights in the tile) over its flat colour instead of its texture set or pattern. */
  bands?: boolean;
  /** Draw every material with the test patterns (by its look's pattern index) instead of texture sets: the debug program. */
  patterns?: boolean;
  /**
   * Relief: a draw carrying crease weights ({@link VOXEL_CREASE_ATTRIBUTE},
   * the relief mesh) is displaced in the vertex stage by its materials'
   * heights (the albedos' A) and height depths, blended as the pixels
   * blend them, its shadow too. Absent: none of it is built.
   */
  relief?: boolean;
  /**
   * Under `patterns`: relief test heights (`size`² bytes a layer, 1 the
   * surface, 0 a material's depth below it; the looks name a layer), what
   * the debug program has in place of texture sets: its heights blend, its
   * lighting normal follows them, and with `relief` they displace.
   */
  heights?: { readonly size: number; readonly layers: readonly Uint8Array[] };
}

/** What the relief draws with now ({@link VoxelSurface.setRelief}). */
export interface VoxelReliefSettings {
  /** Lattice steps a cell of the relief mesh: the heights are read no sharper than its vertex spacing. */
  readonly n?: number;
  /** Move relief vertices (false: the relief mesh draws flat). */
  readonly displace?: boolean;
  /** Bend the lighting normal by the heights. */
  readonly bump?: boolean;
  /** The point (scene metres) the relief ring is centred on, and the distances over which displacement fades to none. */
  readonly focus?: THREE.Vector3;
  readonly fadeStartM?: number;
  readonly fadeEndM?: number;
}

/**
 * What a draw's program reads, chosen per draw from what its grid holds and its level (never per pixel):
 * `materials` 1 when the draw's grid holds one solid material (its second set is never read), and the sets'
 * projection (`blend`: triplanar on terrain; `axis`: one read a map, see `SetProjectionMode`).
 */
export interface VoxelSurfacePath {
  readonly materials: 1 | 2;
  readonly projection: SetProjectionMode;
}

/** The program every draw can take: two materials blended, terrain triplanar. */
export const FULL_PATH: VoxelSurfacePath = Object.freeze({ materials: 2, projection: 'blend' });

const pathKey = (p: VoxelSurfacePath): string => `${p.materials}-${p.projection}`;

/** The surface material, its grids and the setting it reads each frame. */
export interface VoxelSurface {
  /** The program of {@link FULL_PATH}. */
  readonly material: THREE.MeshStandardNodeMaterial;
  /** The program for a draw's path (made on the first ask, then shared; the same grids, table, arrays and uniforms). */
  materialFor(path: VoxelSurfacePath): THREE.MeshStandardNodeMaterial;
  /** Programs made so far (diagnostics). */
  readonly variants: number;
  readonly grids: VoxelShaderGrids;
  /**
   * Metres the blend runs over where no material of a seam sets its own (a uniform: changing it needs no new
   * program, mesh or table upload). Where materials meet, the smallest of theirs wins.
   */
  setBlendMetres(m: number): void;
  /** The blend metres in use where no material sets its own. */
  readonly blendMetres: number;
  /**
   * The crack textures the kits replace the engine's with ({@link CRACK_TEXELS}² bytes each, layer k + 1 of the
   * array) and each material's layer (0: the engine's): what a cracked face of that material draws.
   */
  setCracks(layers: readonly Uint8Array[], materialLayer: (material: number) => number): void;
  /** Sets what the relief draws with (no new program); a no-op without heights. */
  setRelief(s: VoxelReliefSettings): void;
  /**
   * The texture arrays and each material's wall, floor and ceiling layer in them (null or −1: none, its flat colour):
   * the arrays are bound and the table's layers rewritten, no program, grid or mesh changes. A map left out reads its
   * neutral value; null arrays: every material flat again. The surface does not own the arrays (never disposes them).
   * Without effect under `patterns`.
   */
  setTextures(arrays: VoxelSurfaceTextureArrays | null, layers: (material: number) => readonly [number, number, number] | null): void;
  /** Whether the program draws texture sets (false: the test patterns). */
  readonly textured: boolean;
  /**
   * Every material's look again (a material record changed): the table is rewritten and uploaded, nothing else
   * (no program, no grid, no mesh: looks are shader data). The ms it took on this thread.
   */
  setLooks(look: (material: number) => VoxelMaterialLook): number;
  /** Table uploads {@link setLooks} made, and the ms the last one took. */
  readonly tableUploads: number;
  readonly tableMs: number;
  /** What the table holds for a material (diagnostics): linear colour, pattern, tiles in metres, crack layer, relief layer (−1 none) and depth. */
  tableEntry(material: number): { colour: [number, number, number]; pattern: number; constructionTileMetres: number; terrainTileMetres: number; crackLayer: number; reliefLayer: number; reliefDepthM: number; blendM: number; layers: [number, number, number] };
  /**
   * The deepest relief of any material (metres; 0 without heights): how far a displaced vertex can move, what culling
   * bounds grow by. A geometry keeps the bound it was placed with until it is placed again.
   */
  readonly reliefDepthM: number;
  /** The values an object passes (made once per surface object; `slot.w` −1 until it is given a grid or an entry), its grid's cells `cellMetres` (default the layout's). */
  objectValues(cellMetres?: number): VoxelSurfaceObject;
  /**
   * A far draw's colour (linear) of material `m` (a node): its table colour, times its wall set's albedo as the
   * array's coarsest level holds it (the set's mean colour) where it has one, darkened by wetness `wet` (0 … max).
   * Read from the same table and arrays as the surface, so a record's change reaches far draws with no mesh change.
   */
  farColour(m: N, wet: N): N;
  dispose(): void;
}

/** A face's crack strength: the geometry's attribute (absent on a geometry without one: no cracks). */
const crackStrength = (): N =>
  Fn((builder: { hasGeometryAttribute(name: string): boolean }) => (builder.hasGeometryAttribute(VOXEL_CRACK_ATTRIBUTE) ? attribute(VOXEL_CRACK_ATTRIBUTE, 'float') : float(0)))();

/** A vertex's owner offset (cells; w > 0: it has one), from the geometry's attribute (absent: none). */
const ownerOffset = (): N =>
  Fn((builder: { hasGeometryAttribute(name: string): boolean }) => (builder.hasGeometryAttribute(VOXEL_OWNER_ATTRIBUTE) ? attribute(VOXEL_OWNER_ATTRIBUTE, 'vec4').mul(127) : vec4(0)))();

/** The materials round a surface point, as a pixel blends them ({@link createVoxelSurface}'s `blendAt`). */
interface Blend {
  /** The heaviest material and the second (key material + construction · 2^materialBits), and the second's share. */
  readonly mA: N;
  readonly mB: N;
  readonly share: N;
  readonly wetness: N;
  /** Whether any solid cell was found. */
  readonly seen: N;
  /** World metres of the point from the object's phase, the grid projection's (U, V), the triplanar weights. */
  readonly p: N;
  readonly gu: N;
  readonly gv: N;
  readonly bn: N;
}

/** A vertex's crease weight, from the geometry's attribute (only relief meshes carry it). */
const creaseWeight = (): N => attribute(VOXEL_CREASE_ATTRIBUTE, 'float');

/** What the blend reads: the layout, the grid and the material table's entries, the object's uniforms. */
interface BlendInputs {
  readonly layout: VoxelSurfaceLayout;
  readonly cellU: N;
  readonly blendM: N;
  /** A material's own blend metres (negative: none, the surface's). */
  blendOf(mat: N): N;
  readonly gridNode: N;
  readonly slotU: N;
  readonly phaseU: N;
  readonly slopePhaseU: N;
  readonly slope5PhaseU: N;
  decode(entry: N): { mat: N; wet: N };
}

/**
 * The materials round a point of the surface (object-local metres) with normal `n`, as the pixel blends them:
 * the two heaviest and the second's share, the wetness, and where its textures are read. The vertex stage
 * calls it too (relief), so a vertex moves by the very blend its pixels show.
 */
function surfaceBlend(ctx: BlendInputs, pos: N, n: N): Blend {
  const { layout, cellU, blendM, blendOf, gridNode, slotU, phaseU, slopePhaseU, slope5PhaseU, decode } = ctx;
  // Cells of the object's grid from its corner, read into the surface by a depth in metres (not a share of the
  // object's cells: a coarse cell's share would reach under a thin surface layer), kept on the grid (border included).
  const edge = layout.side - 2 * layout.border;
  const q = clamp(pos.sub(n.mul(layout.readDepthCells * layout.cellMetres)).div(cellU), -0.5, edge + 0.5);
  const t = q.sub(0.5);
  const c0 = floor(t);
  const f = t.sub(c0);
  const f0 = vec3(1).sub(f);
  const g0 = ivec3(c0).add(layout.border);
  const hi = int(layout.side - 1);
  const slot = slotU;
  const o = ivec3(slot.xyz);
  // The eight cells round the point, read once: their materials say how wide the blend between them is.
  const cells: { mat: N; wet: N }[] = [];
  const asks: BlendCell<N, N>[] = [];
  for (let k = 0; k < 8; k++) {
    const gx = min(g0.x.add(k & 1), hi);
    const gy = min(g0.y.add((k >> 1) & 1), hi);
    const gz = min(g0.z.add((k >> 2) & 1), hi);
    // Texture x, y, z are grid y, z, x (the grid's memory order).
    const texel = gridNode.load(ivec3(o.x.add(gy), o.y.add(gz), o.z.add(gx)));
    const lo = floor(texel.r.mul(255).add(0.5));
    const hiB = floor(texel.g.mul(255).add(0.5));
    const e = decode(lo.add(hiB.mul(256)));
    const cell = { mat: e.mat.toVar(), wet: e.wet.toVar() };
    cells.push(cell);
    asks.push({ own: blendOf(cell.mat).toVar(), solid: cell.mat.greaterThan(0.5) });
  }
  // Where materials meet the smallest blend wins (voxel-surface-blend.ts); in this grid's cells (at most one cell):
  // the same width in metres at every level.
  const blendCells = clamp(seamBlendMetres(NODE_OPS, asks, blendM).toVar().div(cellU), 1e-3, 1);
  const w1 = clamp(f.sub(0.5).div(blendCells).add(0.5), 0, 1);
  const w0 = vec3(1).sub(w1);
  const m1 = float(-1).toVar();
  const v1 = float(0).toVar();
  const m2 = float(-1).toVar();
  const v2 = float(0).toVar();
  const wetSum = float(0).toVar();
  const total = float(0).toVar();
  // The nearest solid by plain trilinear weight, for a pixel whose blend weights find none.
  const nm = float(-1).toVar();
  const nw = float(0).toVar();
  const nWet = float(0).toVar();
  for (let k = 0; k < 8; k++) {
    const dx = k & 1;
    const dy = (k >> 1) & 1;
    const dz = (k >> 2) & 1;
    const { mat, wet } = cells[k]!;
    const isSolid = select(mat.greaterThan(0.5), float(1), float(0));
    const w = (dx ? w1.x : w0.x).mul(dy ? w1.y : w0.y).mul(dz ? w1.z : w0.z).mul(isSolid).toVar();
    wetSum.addAssign(w.mul(wet));
    total.addAssign(w);
    const tw = (dx ? f.x : f0.x).mul(dy ? f.y : f0.y).mul(dz ? f.z : f0.z).mul(isSolid).add(isSolid.mul(1e-6)).toVar();
    const nearer = tw.greaterThan(nw);
    nm.assign(select(nearer, mat, nm));
    nWet.assign(select(nearer, wet, nWet));
    nw.assign(max(nw, tw));
    // The two heaviest materials: a newcomer heavier than the second takes its place; the first stays the heaviest.
    const same1 = mat.equal(m1);
    const same2 = mat.equal(m2);
    const takes = same1.or(same2).not().and(w.greaterThan(v2));
    v1.assign(select(same1, v1.add(w), v1));
    const nv2 = select(same2, v2.add(w), select(takes, w, v2)).toVar();
    const nm2 = select(takes, mat, m2).toVar();
    const swap = nv2.greaterThan(v1);
    const am = select(swap, nm2, m1).toVar();
    const av = select(swap, nv2, v1).toVar();
    const bm = select(swap, m1, nm2).toVar();
    const bv = select(swap, v1, nv2).toVar();
    m1.assign(am);
    v1.assign(av);
    m2.assign(bm);
    v2.assign(bv);
  }
  // An even roof's ridge and hip apex run a whole cell above the roof's top voxels, so the eight cells round such a
  // pixel are all air: the cell under them in the pixel's nearest column is the roof's own, taken only then.
  {
    const bx = min(g0.x.add(select(f.x.greaterThanEqual(0.5), int(1), int(0))), hi);
    const bz = min(g0.z.add(select(f.z.greaterThanEqual(0.5), int(1), int(0))), hi);
    const by = max(g0.y.sub(1), int(0));
    const texel = gridNode.load(ivec3(o.x.add(by), o.y.add(bz), o.z.add(bx)));
    const { mat, wet } = decode(floor(texel.r.mul(255).add(0.5)).add(floor(texel.g.mul(255).add(0.5)).mul(256)));
    const takes = mat.greaterThan(0.5).and(nw.lessThanEqual(0));
    nm.assign(select(takes, mat, nm));
    nWet.assign(select(takes, wet, nWet));
    nw.assign(select(takes, float(1e-6), nw));
  }
  // An owned face: the cell its pixel's position plus the interpolated offset lies in, alone (no blend).
  const ownerAt = ownerOffset().toVar();
  const ownCell = ivec3(floor(pos.div(cellU).add(ownerAt.xyz.div(SURFACE_OWNER_STEPS_PER_CELL)))).add(layout.border);
  const lo3 = int(0);
  const ox = clamp(ownCell.x, lo3, hi);
  const oy = clamp(ownCell.y, lo3, hi);
  const oz = clamp(ownCell.z, lo3, hi);
  const ownTexel = gridNode.load(ivec3(o.x.add(oy), o.y.add(oz), o.z.add(ox))).toVar();
  const ownEntry = decode(floor(ownTexel.r.mul(255).add(0.5)).add(floor(ownTexel.g.mul(255).add(0.5)).mul(256)));
  const owner = { mat: ownEntry.mat.toVar(), wet: ownEntry.wet.toVar() };
  const owned = ownerAt.w.greaterThan(0.5).and(owner.mat.greaterThan(0.5)).toVar();
  // A chunk of one solid entry passes it instead of a grid; a blend that found no solid takes the nearest solid.
  const solid = slot.w.greaterThanEqual(0);
  const se = decode(max(slot.w, 0));
  const none = v1.lessThanEqual(0);
  const mA = select(solid, se.mat, select(owned, owner.mat, select(none, nm, m1)));
  const mB = select(solid, se.mat, select(owned, owner.mat, select(none, nm, max(m2, 0))));
  const share = select(solid.or(none).or(owned), float(0), v2.div(max(v1.add(v2), 1e-6)));
  const wetness = select(solid, se.wet, select(owned, owner.wet, select(none, nWet, wetSum.div(max(total, 1e-6))))).div(layout.wetnessMax);
  // World metres from the object's grid phase (plain, and the slope's) plus the local position.
  const p = phaseU.mul(layout.cellMetres).add(pos);
  const ps = slopePhaseU.add(pos);
  const ps5 = slope5PhaseU.add(pos);
  const [gu, gv] = gridUv(NODE_OPS, [p.x, p.y, p.z], [ps.x, ps.y, ps.z], [ps5.x, ps5.y, ps5.z], [n.x, n.y, n.z]);
  // Triplanar weights by the normal (terrain); a construction material takes the grid projection alone.
  const bw = abs(n).pow(vec3(4));
  const bn = bw.div(bw.x.add(bw.y).add(bw.z));
  // Nothing solid among the eight cells (should not happen on a surface): a neutral grey shows it.
  const seen = solid.or(owned).or(nw.greaterThan(0));
  return { mA, mB, share, wetness, seen, p, gu, gv, bn };
}

/** The surface material over a set of shader grids. */
export function createVoxelSurface(layout: VoxelSurfaceLayout, opts: VoxelSurfaceOptions): VoxelSurface {
  const grids = new VoxelShaderGrids(layout);
  const table = tableTexture();
  const tdata = table.image.data as Float32Array;
  let reliefDepthM = 0;
  const c = new THREE.Color();
  const ids = Math.min(4096, 2 ** layout.materialBits);
  const phaseM = PHASE_CELLS * layout.cellMetres;
  const tile = (m: number, what: string, metres: number): number => {
    if (!(metres > 0) || Math.abs(phaseM / metres - Math.round(phaseM / metres)) > 1e-9) throw new RangeError(`voxel material ${m}: a ${what} tile of ${metres} m does not divide the ${phaseM} m phase`);
    return metres;
  };
  if (SHADER_CONSTRUCTION_BIT !== 2 ** layout.materialBits * (layout.wetnessMax + 1)) throw new RangeError('voxel surface: the construction bit is not above the wetness');
  // The texture sets' program, unless the debug patterns or a flat colour are asked for.
  const textured = opts.patterns !== true && opts.shading !== 'flat';
  /** Writes every material's look into the table (its crack layer, set by the kits, is kept). */
  const fill = (look: (material: number) => VoxelMaterialLook): void => {
    let deepest = 0;
    for (let m = 1; m < ids; m++) {
      const l = look(m);
      c.setHex(l.colour);
      tdata.set([c.r, c.g, c.b, Math.max(0, Math.min(VOXEL_PATTERNS - 1, l.pattern))], m * 4);
      const t = (TABLE_ROWS * TABLE_WIDTH + m) * 4;
      tdata[t] = tile(m, 'construction', l.constructionTileMetres ?? CONSTRUCTION_TILE_METRES);
      tdata[t + 1] = tile(m, 'terrain', l.terrainTileMetres ?? TERRAIN_TILE_METRES);
      const depth = l.heightDepthMetres ?? VOXEL_MATERIAL_LIMITS.heightDepthDefault;
      if (!(depth >= 0) || !Number.isFinite(depth)) throw new RangeError(`voxel material ${m}: a height depth of ${depth} m`);
      const layer = opts.heights === undefined ? undefined : l.testHeightLayer;
      if (layer !== undefined && (!Number.isInteger(layer) || layer < 0 || layer >= opts.heights!.layers.length)) throw new RangeError(`voxel material ${m}: relief layer ${layer}`);
      const blend = l.blendMetres;
      if (blend !== undefined && !(blend >= 0 && Number.isFinite(blend))) throw new RangeError(`voxel material ${m}: a blend of ${blend} m`);
      tdata.set([layer ?? -1, depth, blend ?? -1, 0], (2 * TABLE_ROWS * TABLE_WIDTH + m) * 4);
      // Under the patterns only a material with a test layer has a height; with texture sets any may.
      if (textured || layer !== undefined) deepest = Math.max(deepest, depth);
    }
    reliefDepthM = opts.relief === true ? deepest : 0;
  };
  fill(opts.look);
  let tableUploads = 0;
  let tableMs = 0;
  // The relief test heights: the debug program's only heights (the texture sets carry theirs in the albedos' A).
  const heights = opts.heights === undefined || textured || opts.shading === 'flat' ? null : fresh(reliefHeightTexture(opts.heights.layers, opts.heights.size));
  const patterns = textured ? null : patternTexture();
  const neutral = textured ? neutralArrays() : null;
  const arrayNodes = neutral === null ? null : { albedo: texture(neutral.albedo), normal: texture(neutral.normal), orm: texture(neutral.orm) };
  const bands = opts.bands === true ? bandTexture() : null;
  let cracks = crackArrayTexture([]);
  const cracksNode = texture(cracks);
  // Placed relative to the camera in 64 bits: a voxel world may lie kilometres from the origin.
  const material = cameraRelative(new THREE.MeshStandardNodeMaterial());
  material.metalness = 0;
  material.name = 'voxel surface';
  /** The texture arrays bound (none: the neutral values). */
  let bound: THREE.Texture[] = [];
  const mapTextures = (): void => void (material.userData[WORLD_MAPPED_TEXTURES_KEY] = worldMapped(tdata, ids, bound));
  const blendM = uniform(Math.max(0, opts.blendMetres));
  const gridNode = texelTexture3D(grids.texture);
  grids.onTexture = (tex) => {
    (gridNode as unknown as { value: THREE.Texture }).value = tex;
  };
  const tableNode = texelTexture(table);
  const slotOf = (o: THREE.Object3D): VoxelSurfaceObject | undefined => o.userData[VOXEL_SURFACE_KEY] as VoxelSurfaceObject | undefined;
  const slotU = uniform(new THREE.Vector4(0, 0, 0, -1));
  slotU.onObjectUpdate(({ object }: { object: THREE.Object3D }) => slotOf(object)?.slot ?? (slotU.value as THREE.Vector4).set(0, 0, 0, -1));
  const phaseU = uniform(new THREE.Vector3());
  phaseU.onObjectUpdate(({ object }: { object: THREE.Object3D }) => slotOf(object)?.phase ?? (phaseU.value as THREE.Vector3).set(0, 0, 0));
  const slopePhaseU = uniform(new THREE.Vector3());
  slopePhaseU.onObjectUpdate(({ object }: { object: THREE.Object3D }) => slotOf(object)?.slopePhase ?? (slopePhaseU.value as THREE.Vector3).set(0, 0, 0));
  const slope5PhaseU = uniform(new THREE.Vector3());
  slope5PhaseU.onObjectUpdate(({ object }: { object: THREE.Object3D }) => slotOf(object)?.slope5Phase ?? (slope5PhaseU.value as THREE.Vector3).set(0, 0, 0));
  const cellU = uniform(layout.cellMetres);
  cellU.onObjectUpdate(({ object }: { object: THREE.Object3D }) => slotOf(object)?.cellMetres ?? layout.cellMetres);
  const matMask = 2 ** layout.materialBits;
  // Relief: the vertex spacing (lattice steps a cell), switches, and the ring's centre in the object's own metres.
  const reliefN = uniform(4);
  // Texels along a height layer's side (the albedo array's, set with the arrays; the test heights'): the vertex
  // stage's level of detail.
  const heightEdgeU = uniform(textured ? 1 : (opts.heights?.size ?? 1));
  const displaceU = uniform(1);
  const bumpU = uniform(1);
  const fadeStartU = uniform(1e6);
  const fadeEndU = uniform(2e6);
  const reliefFocus = new THREE.Vector3();
  const focusU = uniform(new THREE.Vector3());
  focusU.onObjectUpdate(({ object }: { object: THREE.Object3D }) => {
    const e = object.matrixWorld.elements;
    return (focusU.value as THREE.Vector3).set(reliefFocus.x - e[12]!, reliefFocus.y - e[13]!, reliefFocus.z - e[14]!);
  });
  // A blended "material" is the key material + construction · 2^materialBits: the same id as ground and as wall blend apart.
  const decode = (entry: N): { mat: N; wet: N } => ({
    mat: mod(entry, matMask).add(select(entry.greaterThanEqual(SHADER_CONSTRUCTION_BIT), float(matMask), float(0))),
    wet: mod(floor(entry.div(matMask)), layout.wetnessMax + 1),
  });
  const look = (m: N, block: number): N => tableNode.load(ivec2(int(mod(m, TABLE_WIDTH)), int(floor(m.div(TABLE_WIDTH))).add(block * TABLE_ROWS)));

  /** Builds the surface's program for a draw's path into `material` (every path reads the same grids, table and arrays). */
  const program = (material: THREE.MeshStandardNodeMaterial, path: VoxelSurfacePath): void => {
    if (opts.shading === 'flat') {
      material.colorNode = vec4(0.55, 0.52, 0.47, 1);
      material.roughnessNode = float(0.85);
    } else {
      const blendOf = (m: N): N => look(mod(m, matMask), 2).z;
      const blendCtx: BlendInputs = { layout, cellU, blendM, blendOf, gridNode, slotU, phaseU, slopePhaseU, slope5PhaseU, decode };
      const blendAt = (pos: N, n: N): Blend => surfaceBlend(blendCtx, pos, n);
      /** A point's materials as the texture sets read them (the projection's inputs from the blend). */
      const setPoint = (b: Blend, n: N) => ({ n, p: b.p, gu: b.gu, gv: b.gv, bn: b.bn });
      /** A material's height depth (metres: where its height 0 lies below its surface). */
      const depthOf = (m: N): N => look(mod(m, matMask), 2).y;
      /**
       * A material's relief test height (0–1; 1 without a test layer) at the point, read as its pattern is (grid U/V on
       * construction, triplanar on terrain), at a level of detail (`lod`, from the material's tile metres: none in the
       * fragment, its implicit mips). The debug program's heights.
       */
      const testHeightOf = (m: N, b: Blend, lod: ((tileM: N) => N) | null): N => {
        const id = mod(m, matMask);
        const r = look(id, 2).toVar();
        const tiles = look(id, 1).toVar();
        const built = m.greaterThanEqual(matMask);
        const layer = int(floor(max(r.x, 0).add(0.5)));
        const level = lod === null ? null : lod(select(built, tiles.x, tiles.y)).toVar();
        const sample = (uv: N): N => {
          const t = texture(heights!, uv).depth(layer);
          return (level === null ? t : t.level(level)).r.toVar();
        };
        const pt = b.p.div(tiles.y);
        const gt = vec2(...tileUv(NODE_OPS, [b.gu, b.gv], tiles.x));
        const h0 = sample(select(built, gt, pt.zy));
        const h1 = sample(pt.xz);
        const h2 = sample(pt.xy);
        const h = h0.mul(select(built, float(1), b.bn.x)).add(h1.mul(select(built, float(0), b.bn.y))).add(h2.mul(select(built, float(0), b.bn.z)));
        return select(r.x.lessThan(-0.5), float(1), h);
      };
      // The texture sets' maps, the table and the bands, as both stages read them.
      const sets = textured ? { maps: arrayNodes!, look, matMask, bands } : null;
      // The colour is built before the roughness, metalness, occlusion and normal in a program, so they read what the
      // colour found: the texture sets' ORM and normal, the recess, and what the wetness does.
      const normalOut = property('vec3', 'tlVoxelNormal');
      const ormOut = property('vec3', 'tlVoxelOrm');
      const reliefOut = property('float', 'tlVoxelRecess');
      const roughKeepOut = property('float', 'tlVoxelWetRoughness');
      const waterOut = property('float', 'tlVoxelWater');
      const flattenOut = property('float', 'tlVoxelWetFlatten');
      const shade = Fn(() => {
        const n = normalLocal.normalize();
        const b = blendAt(positionLocal, n);
        const { mA, mB, share, wetness, seen, p, gu, gv, bn } = b;
        const dA = depthOf(mA).toVar();
        const dB = depthOf(mB).toVar();
        const albedo = (m: N): N => {
          const id = mod(m, matMask);
          const l = look(id, 0).toVar();
          const tiles = look(id, 1).toVar();
          const built = m.greaterThanEqual(matMask);
          const layer = int(floor(l.a.add(0.5)));
          const sample = (uv: N): N => texture(patterns!, uv).depth(layer).r;
          const pt = p.div(tiles.y);
          const gt = vec2(...tileUv(NODE_OPS, [gu, gv], tiles.x));
          const pat = sample(select(built, gt, pt.zy)).mul(select(built, float(1), bn.x)).add(sample(pt.xz).mul(select(built, float(0), bn.y))).add(sample(pt.xy).mul(select(built, float(0), bn.z)));
          const shaded = l.rgb.mul(pat.sub(0.5).mul(1.2).add(1)).toVar();
          if (bands === null) return shaded;
          // Into a variable first: the pick below is a branch, and a sample inside it would vary per pixel.
          const band = texture(bands, gt).toVar();
          return select(built, mix(l.rgb, band.rgb, band.a), shaded);
        };
        // Sampled in uniform control flow (WGSL refuses an implicit-derivative sample inside a branch that varies per pixel): into variables first, then picked.
        let blended: N;
        let height: N;
        if (sets !== null) {
          const at = setPoint(b, n);
          const s1 = textureSetAt(sets, mA, at, path.projection);
          // One material in the draw: its second is never another set (its share is 0), so it is not read again.
            const s2 = path.materials === 1 ? s1 : textureSetAt(sets, mB, at, path.projection);
          const hb = heightBlend(NODE_OPS, s1.height.toVar(), dA, s2.height.toVar(), dB, share);
          const hs = hb.share.toVar();
          height = hb.height;
          reliefOut.assign(select(seen, hb.recess, float(0)));
          blended = mix(s1.albedo, s2.albedo, hs);
          normalOut.assign(select(seen, mix(s1.normal, s2.normal, hs).normalize(), n));
          ormOut.assign(select(seen, mix(s1.orm, s2.orm, hs), vec3(1, 0.8, 0)));
        } else {
          const a1 = albedo(mA).toVar();
          const a2 = albedo(mB).toVar();
          if (heights !== null) {
            const hb = heightBlend(NODE_OPS, testHeightOf(mA, b, null), dA, testHeightOf(mB, b, null), dB, share);
            const hs = hb.share.toVar();
            height = hb.height;
            reliefOut.assign(select(seen, hb.recess, float(0)));
            blended = mix(a1, a2, hs);
          } else {
            height = float(1);
            blended = mix(a1, a2, share);
          }
        }
        // Wetness (R111): darker, smoother, flatter, and water standing in the low parts first.
        const wet = wetLook(NODE_OPS, wetness, select(seen, height, float(1)).toVar());
        roughKeepOut.assign(wet.roughness);
        waterOut.assign(wet.water);
        flattenOut.assign(wet.flatten);
        // Cracks (a damaged block's faces, damage stage 1): one crack map a construction tile, laid on the grid exactly as
        // the material's texture (the same metres and phase), so neighbouring cracked cells show one continuous pattern;
        // a texel shows once the face's strength reaches it (bright cracks first). Sampled outside any branch, as above.
        const crackLook = look(mod(mA, matMask), 1).toVar();
        const crackLayer = int(floor(crackLook.z.add(0.5)));
        const crackTexel = cracksNode.sample(vec2(...tileUv(NODE_OPS, [gu, gv], crackLook.x))).depth(crackLayer).r.toVar();
        const strength = crackStrength();
        const cracked = select(strength.greaterThan(0.002).and(crackTexel.greaterThan(0.002)).and(crackTexel.greaterThanEqual(float(1).sub(strength))), float(CRACK_DARKEN), float(0));
        const colour = mix(vec3(0.5), blended.mul(wet.albedo).mul(float(1).sub(cracked)), select(seen, float(1), float(0)));
        return vec4(colour, 1);
      });
      material.colorNode = shade();
      material.roughnessNode = mix((textured ? ormOut.y : float(0.85)).mul(roughKeepOut), float(WET_WATER_ROUGHNESS), waterOut);
      if (textured) {
        material.metalnessNode = ormOut.z;
        material.aoNode = ormOut.x;
        // The texture sets' normal (object space: world directions), flattened toward the surface's own by the wetness.
        material.normalNode = transformNormalToView(mix(normalOut, normalLocal.normalize(), flattenOut).normalize()).normalize();
      }
      if (opts.relief === true && (textured || heights !== null)) {
        // The vertex stage: a relief vertex moves inward along its normal by the blended recess, its crease weight and
        // the ring's fade; heights are read at the mip whose texels are as wide as the vertex spacing, never sharper.
        // Three's shadow pass draws with the material's position node too, so a relief mesh that casts moves the same.
        material.positionNode = Fn((builder: { hasGeometryAttribute(name: string): boolean }) => {
          if (!builder.hasGeometryAttribute(VOXEL_CREASE_ATTRIBUTE)) return positionLocal;
          const n = normalLocal.normalize();
          const b = blendAt(positionLocal, n);
          const stepM = cellU.div(reliefN);
          const lod = (tileM: N): N => log2(max(stepM.mul(heightEdgeU).div(tileM), 1));
          const heightOf = (m: N): N => {
            if (sets === null) return testHeightOf(m, b, lod);
            const tiles = look(mod(m, matMask), 1).toVar();
            return textureHeightAt(sets, m, setPoint(b, n), lod(max(select(m.greaterThanEqual(matMask), tiles.x, tiles.y), VOXEL_MATERIAL_LIMITS.tileMetresMin)).toVar());
          };
          const hb = heightBlend(NODE_OPS, heightOf(b.mA).toVar(), depthOf(b.mA), heightOf(b.mB).toVar(), depthOf(b.mB), b.share);
          const d = select(b.seen, hb.recess, float(0)).toVar();
          const fade = float(1).sub(smoothstep(fadeStartU, fadeEndU, positionLocal.sub(focusU).length()));
          return positionLocal.sub(n.mul(d.mul(creaseWeight()).mul(fade).mul(displaceU)));
        })();
        // A relief mesh casts no shadow where its view draws shadows (its chunk's plain surfaces do, voxel-chunk-view.ts),
        // so it looks its shadow up where the plain surface is: a recessed point is then lit or shaded exactly as the
        // plain surface there (no point lies behind its own caster's far side).
        material.receivedShadowPositionNode = Fn((builder: { hasGeometryAttribute(name: string): boolean }) =>
          builder.hasGeometryAttribute(VOXEL_CREASE_ATTRIBUTE) ? varying(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz) : positionWorld,
        )();
      }
      if (heights !== null) {
        // The debug program's lighting normal follows its test heights (the geometry's normals are never rebuilt): the
        // recess's screen derivatives bend the view normal (Mikkelsen's surface gradient, in metres), less as it wets.
        material.normalNode = Fn(() => {
          const hgt = reliefOut.negate().mul(bumpU).mul(float(1).sub(flattenOut));
          const sx = positionView.dFdx();
          const sy = positionView.dFdy();
          const nv = normalView;
          const r1 = sy.cross(nv);
          const r2 = nv.cross(sx);
          const det = sx.dot(r1).mul(faceDirection);
          const grad = det.sign().mul(hgt.dFdx().mul(r1).add(hgt.dFdy().mul(r2)));
          return det.abs().mul(nv).sub(grad).normalize();
        })();
      }
    }
  };
  program(material, FULL_PATH);
  // The position node moves only relief vertices, and a relief geometry's bounds already hold its deepest relief
  // (voxel-chunk-view.ts): no vertex leaves its geometry's bounds, so occlusion culling may test a draw whole.
  declareVertexReach(material, () => 0);
  /** The programs of the other paths, made when a draw first asks (the flat program has one). */
  const variants = new Map<string, THREE.MeshStandardNodeMaterial>([[pathKey(FULL_PATH), material]]);
  const materialFor = (path: VoxelSurfacePath): THREE.MeshStandardNodeMaterial => {
    const key = opts.shading === 'flat' ? pathKey(FULL_PATH) : pathKey(path);
    let m = variants.get(key);
    if (m === undefined) {
      m = cameraRelative(new THREE.MeshStandardNodeMaterial());
      m.metalness = 0;
      m.name = `voxel surface ${key}`;
      m.userData = material.userData;
      program(m, path);
      declareVertexReach(m, () => 0);
      variants.set(key, m);
    }
    return m;
  };
  return {
    material,
    materialFor,
    get variants() {
      return variants.size;
    },
    grids,
    setBlendMetres(m) {
      blendM.value = Math.max(0, m);
    },
    get blendMetres() {
      return blendM.value as number;
    },
    get reliefDepthM() {
      return reliefDepthM;
    },
    setLooks(look) {
      const t0 = performance.now();
      fill(look);
      mapTextures();
      fresh(table);
      tableUploads++;
      tableMs = performance.now() - t0;
      return tableMs;
    },
    get tableUploads() {
      return tableUploads;
    },
    get tableMs() {
      return tableMs;
    },
    tableEntry(m) {
      const a = m * 4;
      const t = (TABLE_ROWS * TABLE_WIDTH + m) * 4;
      const r = (2 * TABLE_ROWS * TABLE_WIDTH + m) * 4;
      const ly = (LAYER_BLOCK + m) * 4;
      return { colour: [tdata[a]!, tdata[a + 1]!, tdata[a + 2]!], pattern: tdata[a + 3]!, constructionTileMetres: tdata[t]!, terrainTileMetres: tdata[t + 1]!, crackLayer: tdata[t + 2]!, reliefLayer: tdata[r]!, reliefDepthM: tdata[r + 1]!, blendM: tdata[r + 2]!, layers: [tdata[ly]!, tdata[ly + 1]!, tdata[ly + 2]!] };
    },
    get textured() {
      return textured;
    },
    setTextures(arrays, layers) {
      if (arrayNodes === null || neutral === null) return;
      bindArrays(arrayNodes, neutral, arrays);
      heightEdgeU.value = (arrays?.albedo?.image as { width?: number } | undefined)?.width ?? 1;
      for (let m = 1; m < ids; m++) tdata.set((arrays === null ? null : layers(m)) ?? [-1, -1, -1], (LAYER_BLOCK + m) * 4);
      bound = arrays === null ? [] : VOXEL_TEXTURE_MAPS.flatMap((map) => (arrays[map] !== undefined ? [arrays[map]] : []));
      mapTextures();
      fresh(table);
      tableUploads++;
    },
    setRelief(r) {
      if (r.n !== undefined) reliefN.value = r.n;
      if (r.displace !== undefined) displaceU.value = r.displace ? 1 : 0;
      if (r.bump !== undefined) bumpU.value = r.bump ? 1 : 0;
      if (r.focus !== undefined) reliefFocus.copy(r.focus);
      if (r.fadeStartM !== undefined) fadeStartU.value = r.fadeStartM;
      if (r.fadeEndM !== undefined) fadeEndU.value = Math.max(r.fadeEndM, (r.fadeStartM ?? (fadeStartU.value as number)) + 1e-3);
    },
    setCracks(layers, materialLayer) {
      const old = cracks;
      cracks = crackArrayTexture(layers);
      (cracksNode as unknown as { value: THREE.Texture }).value = cracks;
      old.dispose();
      for (let m = 1; m < ids; m++) tdata[(TABLE_ROWS * TABLE_WIDTH + m) * 4 + 2] = Math.max(0, Math.min(layers.length, materialLayer(m)));
      fresh(table);
    },
    objectValues: (cellMetres = layout.cellMetres) => ({ slot: new THREE.Vector4(0, 0, 0, -1), phase: new THREE.Vector3(), slopePhase: new THREE.Vector3(), slope5Phase: new THREE.Vector3(), cellMetres }),
    farColour(m, wet) {
      const base = look(m, 0).rgb.toVar();
      const layer = look(m, 3).x.toVar();
      let colour: N = base;
      if (arrayNodes !== null) {
        // Sampled whatever the layer (uniform control flow), then picked: the coarsest level is the set's mean.
        const mean = texture(arrayNodes.albedo, vec2(0.5, 0.5)).depth(int(max(layer, 0))).level(float(FAR_MEAN_LEVEL)).rgb;
        colour = select(layer.greaterThan(-0.5), base.mul(mean), base);
      }
      return colour.mul(float(1).sub(wet.div(layout.wetnessMax).mul(WET_DARKEN)));
    },
    dispose() {
      grids.dispose();
      table.dispose();
      patterns?.dispose();
      if (neutral !== null) for (const map of VOXEL_TEXTURE_MAPS) neutral[map].dispose();
      cracks.dispose();
      bands?.dispose();
      heights?.dispose();
      for (const m of variants.values()) m.dispose();
    },
  };
}
