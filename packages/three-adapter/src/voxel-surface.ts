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
 * heaviest materials are looked up (colour and test pattern) and mixed by
 * their weights; wetness, averaged the same way, darkens the colour and
 * lowers the roughness. A material or wetness change re-uploads a grid and
 * rebuilds no mesh, and the blend is a function of the cells alone, so it
 * looks the same on any mesh that covers the surface.
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
 * Texture units: the grid texture, the material table, the pattern array
 * and the crack array, four of a lit program's sixteen (`texture-units.ts`);
 * the band test texture a fifth when it is on. Reads a pixel: nine grid
 * texels (ten with the owner cell's), five table texels (look and tiles of two materials, the crack
 * layer of the first), six pattern samples (a construction material takes
 * one projection, through the first of its three samples) and one crack
 * sample, two band samples more with the bands on.
 *
 * **Cracks.** A cracked block's faces (voxel damage stage 1) carry the
 * overlay's strength in a vertex attribute ({@link VOXEL_CRACK_ATTRIBUTE});
 * the crack texture (voxel-crack-texture.ts: the engine's, or the
 * material's kit's own) is laid one tile a cell face on the build grid's
 * metres, and a texel at or above 1 − strength darkens the face there, so
 * the cracks grow as the integrity drops.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { CONSTRUCTION_TILE_METRES, SHADER_CONSTRUCTION_BIT, SURFACE_OWNER_STEPS_PER_CELL, TERRAIN_TILE_METRES } from '@thirdlight/voxel';
import { crackArrayTexture } from './voxel-crack-texture';

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

/** How much a crack darkens the face under it (0 … 1). */
const CRACK_DARKEN = 0.7;

import { cameraRelative } from './camera-relative';
import type { N } from './effects-tsl';
import { texelTexture, texelTexture3D } from './texel-texture-node';
import { BAND_TEXELS, bandTexels, gridUv, type ProjectionOps } from './voxel-surface-projection';

const TSL: N = TSLTyped;
const { Fn, abs, attribute, clamp, float, floor, int, ivec2, ivec3, max, min, mix, mod, normalLocal, positionLocal, property, select, sqrt, texture, uniform, vec2, vec3, vec4 } = TSL;

/** The object `userData` key holding a voxel surface's per-object values ({@link VoxelSurfaceObject}). */
export const VOXEL_SURFACE_KEY = 'tlVoxelSurface';

/** Largest edge of the grid texture (texels): WebGPU's default 3D texture limit, which WebGL 2 desktop GPUs meet too. */
export const VOXEL_GRID_MAX_EDGE = 2048;

/** Entries the material table holds (material ids 0 … 4,095), 64 a row. */
const TABLE_WIDTH = 64;
/** Rows of one block of the table: looks in the first block, tiles in the second. */
const TABLE_ROWS = 4096 / TABLE_WIDTH;
/** Texels along a test pattern's side, and how many patterns there are. */
const PATTERN_SIZE = 64;
export const VOXEL_PATTERNS = 4;

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

function gridTexture(width: number, height: number, depth: number, data: Uint8Array | null): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(data, width, height, depth);
  tex.format = THREE.RGFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
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
 * uploads as it is.
 */
export class VoxelShaderGrids {
  texture: THREE.Data3DTexture;
  /** Regions along each axis of the texture. */
  private dims: [number, number, number] = [0, 0, 0];
  private readonly free: Array<[number, number, number]> = [];
  private used = 0;
  private retired: { texture: THREE.Texture; frames: number }[] = [];
  /** Uploads since made, and their bytes. */
  uploads = 0;
  uploadedBytes = 0;
  /** Times the texture grew. */
  grown = 0;

  constructor(readonly layout: VoxelSurfaceLayout) {
    // A one-texel stand-in until the first grid: a program binds a texture of the right kind from the start.
    this.texture = gridTexture(1, 1, 1, new Uint8Array(2));
  }

  /** Regions in use. */
  get count(): number {
    return this.used;
  }

  /** Bytes the texture holds on the GPU. */
  get gpuBytes(): number {
    const s = this.layout.side;
    return this.dims[0] * this.dims[1] * this.dims[2] * s * s * s * 2;
  }

  /** Bytes one region holds. */
  get regionBytes(): number {
    return this.layout.side ** 3 * 2;
  }

  /** A free region's origin (texels), the texture grown when none is left. */
  allocate(renderer: VoxelGridRenderer): THREE.Vector3 {
    if (this.free.length === 0) this.grow(renderer);
    const [x, y, z] = this.free.pop()!;
    this.used++;
    const s = this.layout.side;
    return new THREE.Vector3(x * s, y * s, z * s);
  }

  /** Gives a region back. */
  release(origin: THREE.Vector3): void {
    const s = this.layout.side;
    this.free.push([origin.x / s, origin.y / s, origin.z / s]);
    this.used--;
  }

  /** Uploads a grid (side³ entries, grid order) into its region. */
  upload(renderer: VoxelGridRenderer, origin: THREE.Vector3, entries: Uint16Array): void {
    const s = this.layout.side;
    const bytes = new Uint8Array(entries.buffer, entries.byteOffset, s * s * s * 2);
    renderer.initTexture(this.texture);
    if (renderer.backend.isWebGLBackend === true) {
      // A texture never given to the GPU: three's copy uploads its data straight into the region.
      const src = new THREE.Data3DTexture(bytes, s, s, s);
      src.format = THREE.RGFormat;
      src.type = THREE.UnsignedByteType;
      renderer.backend.copyTextureToTexture(src, this.texture, null, origin);
    } else {
      const device = renderer.backend.device as { queue: GpuQueue } | undefined;
      const gpu = renderer.backend.get(this.texture).texture;
      if (device === undefined || gpu === undefined) throw new Error('the voxel grid texture is not on the GPU');
      device.queue.writeTexture({ texture: gpu, origin: { x: origin.x, y: origin.y, z: origin.z } }, bytes, { bytesPerRow: s * 2, rowsPerImage: s }, { width: s, height: s, depthOrArrayLayers: s });
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
    const tex = gridTexture(next[0] * s, next[1] * s, next[2] * s, null);
    renderer.initTexture(tex);
    if (old[0] > 0) renderer.copyTextureToTexture(this.texture, tex, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(old[0] * s, old[1] * s, old[2] * s)), new THREE.Vector3(0, 0, 0));
    // The new regions, handed out lowest first.
    for (let z = next[2] - 1; z >= 0; z--) for (let y = next[1] - 1; y >= 0; y--) for (let x = next[0] - 1; x >= 0; x--) {
      if (x < old[0] && y < old[1] && z < old[2]) continue;
      this.free.push([x, y, z]);
    }
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
 * engine's; voxel-crack-texture.ts).
 */
function tableTexture(): THREE.DataTexture {
  const rows = 2 * TABLE_ROWS;
  const tex = new THREE.DataTexture(new Float32Array(TABLE_WIDTH * rows * 4), TABLE_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return fresh(tex);
}

export interface VoxelSurfaceOptions {
  /** The look of material id `m` (ids 1 … 2^materialBits − 1). */
  look(material: number): VoxelMaterialLook;
  /** Metres over which two neighbouring cells' materials blend (0 … one cell). */
  blendMetres: number;
  /** `flat`: one colour, no reads (to measure what the blend costs). */
  shading?: 'blend' | 'flat';
  /** Draw construction with the band test texture (bands at fixed heights in the tile) instead of its pattern. */
  bands?: boolean;
}

/** The surface material, its grids and the setting it reads each frame. */
export interface VoxelSurface {
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly grids: VoxelShaderGrids;
  /** Metres the blend runs over (a uniform: changing it needs no new program). */
  setBlendMetres(m: number): void;
  /**
   * The crack textures the kits replace the engine's with ({@link CRACK_TEXELS}² bytes each, layer k + 1 of the
   * array) and each material's layer (0: the engine's): what a cracked face of that material draws.
   */
  setCracks(layers: readonly Uint8Array[], materialLayer: (material: number) => number): void;
  /** The values an object passes (made once per surface object; `slot.w` −1 until it is given a grid or an entry), its grid's cells `cellMetres` (default the layout's). */
  objectValues(cellMetres?: number): VoxelSurfaceObject;
  dispose(): void;
}

/** A face's crack strength: the geometry's attribute (absent on a geometry without one: no cracks). */
const crackStrength = (): N =>
  Fn((builder: { hasGeometryAttribute(name: string): boolean }) => (builder.hasGeometryAttribute(VOXEL_CRACK_ATTRIBUTE) ? attribute(VOXEL_CRACK_ATTRIBUTE, 'float') : float(0)))();

/** A vertex's owner offset (cells; w > 0: it has one), from the geometry's attribute (absent: none). */
const ownerOffset = (): N =>
  Fn((builder: { hasGeometryAttribute(name: string): boolean }) => (builder.hasGeometryAttribute(VOXEL_OWNER_ATTRIBUTE) ? attribute(VOXEL_OWNER_ATTRIBUTE, 'vec4').mul(127) : vec4(0)))();

/** The surface material over a set of shader grids. */
export function createVoxelSurface(layout: VoxelSurfaceLayout, opts: VoxelSurfaceOptions): VoxelSurface {
  const grids = new VoxelShaderGrids(layout);
  const table = tableTexture();
  const tdata = table.image.data as Float32Array;
  const c = new THREE.Color();
  const ids = Math.min(4096, 2 ** layout.materialBits);
  const phaseM = PHASE_CELLS * layout.cellMetres;
  const tile = (m: number, what: string, metres: number): number => {
    if (!(metres > 0) || Math.abs(phaseM / metres - Math.round(phaseM / metres)) > 1e-9) throw new RangeError(`voxel material ${m}: a ${what} tile of ${metres} m does not divide the ${phaseM} m phase`);
    return metres;
  };
  if (SHADER_CONSTRUCTION_BIT !== 2 ** layout.materialBits * (layout.wetnessMax + 1)) throw new RangeError('voxel surface: the construction bit is not above the wetness');
  for (let m = 1; m < ids; m++) {
    const l = opts.look(m);
    c.setHex(l.colour);
    tdata.set([c.r, c.g, c.b, Math.max(0, Math.min(VOXEL_PATTERNS - 1, l.pattern))], m * 4);
    tdata.set([tile(m, 'construction', l.constructionTileMetres ?? CONSTRUCTION_TILE_METRES), tile(m, 'terrain', l.terrainTileMetres ?? TERRAIN_TILE_METRES), 0, 0], (TABLE_ROWS * TABLE_WIDTH + m) * 4);
  }
  const patterns = patternTexture();
  const bands = opts.bands === true ? bandTexture() : null;
  let cracks = crackArrayTexture([]);
  const cracksNode = texture(cracks);
  // Placed relative to the camera in 64 bits: a voxel world may lie kilometres from the origin.
  const material = cameraRelative(new THREE.MeshStandardNodeMaterial());
  material.metalness = 0;
  material.name = 'voxel surface';
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
  // A blended "material" is the key material + construction · 2^materialBits: the same id as ground and as wall blend apart.
  const decode = (entry: N): { mat: N; wet: N } => ({
    mat: mod(entry, matMask).add(select(entry.greaterThanEqual(SHADER_CONSTRUCTION_BIT), float(matMask), float(0))),
    wet: mod(floor(entry.div(matMask)), layout.wetnessMax + 1),
  });
  const look = (m: N, block: number): N => tableNode.load(ivec2(int(mod(m, TABLE_WIDTH)), int(floor(m.div(TABLE_WIDTH))).add(block * TABLE_ROWS)));
  const nodeOps: ProjectionOps<N, N> = {
    num: (v) => float(v),
    add: (a, b) => a.add(b),
    sub: (a, b) => a.sub(b),
    mul: (a, b) => a.mul(b),
    div: (a, b) => a.div(b),
    abs: (a) => abs(a),
    max: (a, b) => max(a, b),
    sqrt: (a) => sqrt(a),
    less: (a, b) => a.lessThan(b),
    pick: (c, a, b) => select(c, a, b),
  };
  if (opts.shading === 'flat') {
    material.colorNode = vec4(0.55, 0.52, 0.47, 1);
    material.roughnessNode = float(0.85);
  } else {
    const shade = Fn(() => {
      const n = normalLocal.normalize();
      // Cells of the object's grid from its corner, read into the surface by a depth in metres (not a share of the
      // object's cells: a coarse cell's share would reach under a thin surface layer), kept on the grid (border included).
      const edge = layout.side - 2 * layout.border;
      const q = clamp(positionLocal.sub(n.mul(layout.readDepthCells * layout.cellMetres)).div(cellU), -0.5, edge + 0.5);
      const t = q.sub(0.5);
      const c0 = floor(t);
      // The blend's metres in this grid's cells (at most one cell): the same width at every level.
      const blendCells = clamp(blendM.div(cellU), 1e-3, 1);
      const f = t.sub(c0);
      const w1 = clamp(f.sub(0.5).div(blendCells).add(0.5), 0, 1);
      const w0 = vec3(1).sub(w1);
      const f0 = vec3(1).sub(f);
      const g0 = ivec3(c0).add(layout.border);
      const hi = int(layout.side - 1);
      const slot = slotU;
      const o = ivec3(slot.xyz);
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
        const gx = min(g0.x.add(dx), hi);
        const gy = min(g0.y.add(dy), hi);
        const gz = min(g0.z.add(dz), hi);
        // Texture x, y, z are grid y, z, x (the grid's memory order).
        const texel = gridNode.load(ivec3(o.x.add(gy), o.y.add(gz), o.z.add(gx)));
        const lo = floor(texel.r.mul(255).add(0.5));
        const hiB = floor(texel.g.mul(255).add(0.5));
        const { mat, wet } = decode(lo.add(hiB.mul(256)));
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
      const ownCell = ivec3(floor(positionLocal.div(cellU).add(ownerAt.xyz.div(SURFACE_OWNER_STEPS_PER_CELL)))).add(layout.border);
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
      const p = phaseU.mul(layout.cellMetres).add(positionLocal);
      const ps = slopePhaseU.add(positionLocal);
      const ps5 = slope5PhaseU.add(positionLocal);
      const [gu, gv] = gridUv(nodeOps, [p.x, p.y, p.z], [ps.x, ps.y, ps.z], [ps5.x, ps5.y, ps5.z], [n.x, n.y, n.z]);
      const g = vec2(gu, gv);
      // Triplanar weights by the normal (terrain); a construction material takes the grid projection alone.
      const bw = abs(n).pow(vec3(4));
      const bn = bw.div(bw.x.add(bw.y).add(bw.z));
      const albedo = (m: N): N => {
        const id = mod(m, matMask);
        const l = look(id, 0).toVar();
        const tiles = look(id, 1).toVar();
        const built = m.greaterThanEqual(matMask);
        const layer = int(floor(l.a.add(0.5)));
        const sample = (uv: N): N => texture(patterns, uv).depth(layer).r;
        const pt = p.div(tiles.y);
        const gt = g.div(tiles.x);
        const pat = sample(select(built, gt, pt.zy)).mul(select(built, float(1), bn.x)).add(sample(pt.xz).mul(select(built, float(0), bn.y))).add(sample(pt.xy).mul(select(built, float(0), bn.z)));
        const shaded = l.rgb.mul(pat.sub(0.5).mul(1.2).add(1)).toVar();
        if (bands === null) return shaded;
        // Into a variable first: the pick below is a branch, and a sample inside it would vary per pixel.
        const band = texture(bands, gt).toVar();
        return select(built, mix(l.rgb, band.rgb, band.a), shaded);
      };
      // Sampled in uniform control flow (WGSL refuses an implicit-derivative sample inside a branch that varies per pixel): into variables first, then picked.
      const a1 = albedo(mA).toVar();
      const a2 = albedo(mB).toVar();
      const blended = mix(a1, a2, share);
      // Nothing solid among the eight cells (should not happen on a surface): a neutral grey shows it.
      const seen = solid.or(owned).or(nw.greaterThan(0));
      // Cracks (a damaged block's faces, damage stage 1): one crack tile a cell face, on the grid's metres; a texel
      // shows once the face's strength reaches it (bright cracks first). Sampled outside any branch, as above.
      const crackLayer = int(floor(look(mod(mA, matMask), 1).z.add(0.5)));
      const crackTexel = cracksNode.sample(g.div(layout.cellMetres)).depth(crackLayer).r.toVar();
      const strength = crackStrength();
      const cracked = select(strength.greaterThan(0.002).and(crackTexel.greaterThan(0.002)).and(crackTexel.greaterThanEqual(float(1).sub(strength))), float(CRACK_DARKEN), float(0));
      const colour = mix(vec3(0.5), blended.mul(float(1).sub(wetness.mul(0.5))).mul(float(1).sub(cracked)), select(seen, float(1), float(0)));
      wetOut.assign(wetness);
      return vec4(colour, 1);
    });
    // The colour is built before the roughness in a program, so the roughness reads the wetness the colour found.
    const wetOut = property('float', 'tlVoxelWetness');
    material.colorNode = shade();
    material.roughnessNode = mix(float(0.85), float(0.3), wetOut);
  }
  return {
    material,
    grids,
    setBlendMetres(m) {
      blendM.value = Math.max(0, m);
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
    dispose() {
      grids.dispose();
      table.dispose();
      patterns.dispose();
      cracks.dispose();
      bands?.dispose();
      material.dispose();
    },
  };
}
