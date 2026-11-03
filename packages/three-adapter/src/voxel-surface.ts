/**
 * The voxel surface shader and the GPU home of the shader data it reads.
 *
 * Voxel surface meshes carry only positions and normals. Each pixel finds
 * the materials around it in its chunk's shader grid (a cell's material id
 * and wetness, the chunk's cells plus a border of its neighbours', so a
 * blend crosses a chunk face without a seam) and blends them in the
 * shader: the eight cell centres around the pixel (moved a quarter cell into
 * the surface along its normal, so a face between a solid and an air cell
 * reads the solid one), each weighted per axis by a ramp of the blend
 * distance across the face between two cells, air cells left out. The two
 * heaviest materials are looked up (colour and test pattern) and mixed by
 * their weights; wetness, averaged the same way, darkens the colour and
 * lowers the roughness. A material or wetness change re-uploads a grid and
 * rebuilds no mesh, and the blend is a function of the cells alone, so it
 * looks the same on any mesh that covers the surface.
 *
 * Materials are projected in world space from three axes (triplanar),
 * terrain and construction alike, with the texture phase taken from the
 * chunk's integer cell (per object), so a floating-origin shift never moves
 * a texture.
 *
 * The grids live in one GPU-only 3D texture (two bytes a cell, `rg8unorm`:
 * the entry's low byte, then its high byte), a chunk a `side`³ region. A
 * region is uploaded on its own (`queue.writeTexture` on WebGPU,
 * `texSubImage3D` through three's copy on WebGL 2), no CPU copy of the
 * texture is kept, and the texture grows by a GPU copy into a larger one.
 * A chunk whose grid holds one solid entry needs no region: the object
 * passes the entry instead.
 *
 * Texture units: the grid texture, the material table and the pattern
 * array, three of a lit program's sixteen (`texture-units.ts`). Reads a
 * pixel: eight grid texels, two table texels and six pattern samples.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { cameraRelative } from './camera-relative';
import type { N } from './effects-tsl';
import { texelTexture, texelTexture3D } from './texel-texture-node';

const TSL: N = TSLTyped;
const { Fn, abs, clamp, float, floor, int, ivec2, ivec3, max, min, mix, mod, normalLocal, positionLocal, property, select, texture, uniform, vec3, vec4 } = TSL;

/** The object `userData` key holding a voxel surface's per-object values ({@link VoxelSurfaceObject}). */
export const VOXEL_SURFACE_KEY = 'tlVoxelSurface';

/** Largest edge of the grid texture (texels): WebGPU's default 3D texture limit, which WebGL 2 desktop GPUs meet too. */
export const VOXEL_GRID_MAX_EDGE = 2048;

/** Entries the material table holds (material ids 0 … 4,095), 64 a row. */
const TABLE_WIDTH = 64;
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
}

/** What a surface object passes the shader (in its `userData` under {@link VOXEL_SURFACE_KEY}). */
export interface VoxelSurfaceObject {
  /** The grid's region origin in the texture (texels: x, y, z) and the chunk's one solid entry (w; −1: read the grid). */
  readonly slot: THREE.Vector4;
  /** The chunk corner's cell, each axis modulo {@link PHASE_CELLS}: where its textures start. */
  readonly phase: THREE.Vector3;
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

/** A material's look in the table: a colour (sRGB hex) and a test pattern (0 … {@link VOXEL_PATTERNS} − 1). */
export interface VoxelMaterialLook {
  readonly colour: number;
  readonly pattern: number;
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

/** The material table: a texel a material id, linear colour in rgb, pattern index in a. */
function tableTexture(): THREE.DataTexture {
  const rows = Math.ceil(4096 / TABLE_WIDTH);
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
  /** Metres a test pattern's tile covers. */
  patternMetres?: number;
  /** `flat`: one colour, no reads (to measure what the blend costs). */
  shading?: 'blend' | 'flat';
}

/** The surface material, its grids and the setting it reads each frame. */
export interface VoxelSurface {
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly grids: VoxelShaderGrids;
  /** Metres the blend runs over (a uniform: changing it needs no new program). */
  setBlendMetres(m: number): void;
  /** The values an object passes (made once per surface object; `slot.w` −1 until it is given a grid or an entry). */
  objectValues(): VoxelSurfaceObject;
  dispose(): void;
}

/** The surface material over a set of shader grids. */
export function createVoxelSurface(layout: VoxelSurfaceLayout, opts: VoxelSurfaceOptions): VoxelSurface {
  const grids = new VoxelShaderGrids(layout);
  const table = tableTexture();
  const tdata = table.image.data as Float32Array;
  const c = new THREE.Color();
  const ids = Math.min(4096, 2 ** layout.materialBits);
  for (let m = 1; m < ids; m++) {
    const l = opts.look(m);
    c.setHex(l.colour);
    tdata.set([c.r, c.g, c.b, Math.max(0, Math.min(VOXEL_PATTERNS - 1, l.pattern))], m * 4);
  }
  const patterns = patternTexture();
  // Placed relative to the camera in 64 bits: a voxel world may lie kilometres from the origin.
  const material = cameraRelative(new THREE.MeshStandardNodeMaterial());
  material.metalness = 0;
  material.name = 'voxel surface';
  const cellsOfBlend = (m: number): number => Math.max(1e-3, Math.min(1, m / layout.cellMetres));
  const blendCells = uniform(cellsOfBlend(opts.blendMetres));
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
  const matMask = 2 ** layout.materialBits;
  const decode = (entry: N): { mat: N; wet: N } => ({ mat: mod(entry, matMask), wet: floor(entry.div(matMask)) });
  const look = (m: N): N => tableNode.load(ivec2(int(mod(m, TABLE_WIDTH)), int(floor(m.div(TABLE_WIDTH)))));
  const patternM = opts.patternMetres ?? 2;
  if (opts.shading === 'flat') {
    material.colorNode = vec4(0.55, 0.52, 0.47, 1);
    material.roughnessNode = float(0.85);
  } else {
    const shade = Fn(() => {
      const n = normalLocal.normalize();
      // Cells from the chunk's corner, a quarter cell into the surface, kept on the grid (border included).
      const edge = layout.side - 2 * layout.border;
      const q = clamp(positionLocal.div(layout.cellMetres).sub(n.mul(0.25)), -0.5, edge + 0.5);
      const t = q.sub(0.5);
      const c0 = floor(t);
      const w1 = clamp(t.sub(c0).sub(0.5).div(blendCells).add(0.5), 0, 1);
      const w0 = vec3(1).sub(w1);
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
        const w = (dx ? w1.x : w0.x).mul(dy ? w1.y : w0.y).mul(dz ? w1.z : w0.z).mul(select(mat.greaterThan(0.5), float(1), float(0))).toVar();
        wetSum.addAssign(w.mul(wet));
        total.addAssign(w);
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
      // A chunk of one solid entry passes it instead of a grid.
      const solid = slot.w.greaterThanEqual(0);
      const se = decode(max(slot.w, 0));
      const mA = select(solid, se.mat, m1);
      const mB = select(solid, se.mat, max(m2, 0));
      const share = select(solid, float(0), v2.div(max(v1.add(v2), 1e-6)));
      const wetness = select(solid, se.wet, wetSum.div(max(total, 1e-6))).div(layout.wetnessMax);
      // Triplanar projection in world cells (the object's phase plus the local cell), the axes weighted by the normal.
      const p = phaseU.add(positionLocal.div(layout.cellMetres)).div(patternM / layout.cellMetres);
      const bw = abs(n).pow(vec3(4));
      const bn = bw.div(bw.x.add(bw.y).add(bw.z));
      const albedo = (m: N): N => {
        const l = look(m);
        const layer = int(floor(l.a.add(0.5)));
        const sample = (uv: N): N => texture(patterns, uv).depth(layer).r;
        const pat = sample(p.zy).mul(bn.x).add(sample(p.xz).mul(bn.y)).add(sample(p.xy).mul(bn.z));
        return l.rgb.mul(pat.sub(0.5).mul(1.2).add(1));
      };
      // Sampled in uniform control flow (WGSL refuses an implicit-derivative sample inside a branch that varies per pixel): into variables first, then picked.
      const a1 = albedo(mA).toVar();
      const a2 = albedo(mB).toVar();
      const blended = mix(a1, a2, share);
      // Nothing solid around (should not happen on a surface): a neutral grey shows it.
      const seen = solid.or(v1.greaterThan(0));
      const colour = mix(vec3(0.5), blended.mul(float(1).sub(wetness.mul(0.5))), select(seen, float(1), float(0)));
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
      blendCells.value = cellsOfBlend(m);
    },
    objectValues: () => ({ slot: new THREE.Vector4(0, 0, 0, -1), phase: new THREE.Vector3() }),
    dispose() {
      grids.dispose();
      table.dispose();
      patterns.dispose();
      material.dispose();
    },
  };
}
