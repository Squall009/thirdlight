/**
 * The colours the light volume bounces: each open cell of a kept brick carries the mean colour of the solid cells
 * across its faces, from the chunks' shader grids and the materials' looks. A look's colour is its tint times the mean
 * colour of its albedo texture for the side seen (the floor set under a cell, the ceiling set over it, the wall set
 * beside it), so a white plaster bounces as plaster and a tinted brick as the darker brick it draws; a look with no
 * texture set bounces its colour, and a textured look whose texture means are not known yet bounces the probes' grey.
 *
 * The texture means are measured once where the albedo array is handed to the surfaces (`textureLayerMeans`: a small
 * compute pass that reads a coarse level of every layer and averages it, so the volume needs no per-frame read). The
 * same pass reads the ORM array's A beside it (the glow mask), texel for texel, so each layer also has the mean of
 * what its glow draws: colour × mask.
 *
 * The glow a cell gives its rays' hits, written beside its colour: the mean, over the solid cells across its faces, of
 * each one's material's glow (one value a material: its glow colour × strength × the mean of what it draws, the tint
 * times its wall set's texture mean of colour × glow mask, or its flat colour without a set); 0 where none glows. Never
 * stored per voxel: a material's glow is its record's, its mask its texture's.
 */
import * as THREE from 'three/webgpu';
import { TEXTURE_STREAM_TAIL_PX } from '@thirdlight/project-model';
import { MATERIAL_BITS } from '@thirdlight/voxel';

import { BOUNCE_ALBEDO } from './surface-probes';
import { volumeEncode } from './voxel-light-volume-layout';
import type { VoxelMaterialLook } from './voxel-surface';

/**
 * By voxel id, the means of its wall, floor and ceiling layers (null: none of that side): the mean linear colour (r, g,
 * b), then, where the glow mask was read, the mean of colour × glow mask (three more: what its glow draws; absent: the
 * colour's, a mask of 1).
 */
export type VolumeBounceMeans = ReadonlyMap<number, readonly [readonly number[] | null, readonly number[] | null, readonly number[] | null]>;

/** A layer's mean of what its glow draws (colour × glow mask): its last three where measured, else its colour's. */
function drawnGlowMean(mean: readonly number[]): readonly number[] {
  return mean.length >= 6 ? mean.slice(3, 6) : mean;
}

/** The side of a solid cell a neighbour across `dy` sees: 0 its wall (beside), 1 its floor (the cell over it), 2 its ceiling (under it). */
function side(dy: number): number {
  return dy < 0 ? 1 : dy > 0 ? 2 : 0;
}

/**
 * The linear colour a look bounces seen from `side` (0 wall, 1 floor, 2 ceiling): its tint times its texture's mean
 * there (the wall's where it has no set for that side); a white look whose texture means are not known (none measured
 * yet, or no set) bounces the default grey.
 */
export function volumeLookBounce(look: VoxelMaterialLook, means: readonly (readonly number[] | null)[] | null, at: number): [number, number, number] {
  const tint = new THREE.Color().setHex(look.colour);
  const mean = means === null ? null : (means[at] ?? means[0] ?? null);
  if (mean !== null) return [tint.r * mean[0]!, tint.g * mean[1]!, tint.b * mean[2]!];
  if (look.colour === 0xffffff) return [BOUNCE_ALBEDO, BOUNCE_ALBEDO, BOUNCE_ALBEDO];
  return [tint.r, tint.g, tint.b];
}

function packRgba(r: number, g: number, b: number): number {
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(r) | (q(g) << 8) | (q(b) << 16) | (255 << 24)) >>> 0;
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const EDGE = 32;
const SIDE = EDGE + 2;

/** A grid of the volume's: a chunk's shader grid (34³ with its border) or its one entry. */
export type VolumeChunkGrid = Uint16Array | number;

/**
 * The radiance a material's surfaces give off into the volume (linear rgb; null: it does not glow): its look's glow
 * times the mean of what it draws, the tint times its wall set's texture mean of colour × glow mask (the side terrain
 * draws everywhere and construction on every face but floors and ceilings), or the tint alone without a set or before
 * the means are measured (as it draws with no set: its flat colour, glowing whole).
 */
export function volumeLookGlow(look: VoxelMaterialLook, means: readonly (readonly number[] | null)[] | null): [number, number, number] | null {
  const g = look.glow;
  if (g === undefined || g[0] + g[1] + g[2] <= 0) return null;
  const tint = new THREE.Color().setHex(look.colour);
  const wall = means?.[0] ?? null;
  const mean = wall === null ? null : drawnGlowMean(wall);
  const c = mean === null ? [tint.r, tint.g, tint.b] : [tint.r * mean[0]!, tint.g * mean[1]!, tint.b * mean[2]!];
  return [g[0] * c[0]!, g[1] * c[1]!, g[2] * c[2]!];
}

/** The colours of the looks seen, packed, cached by grid entry and side for one pass over bricks; and their glows. */
export class VolumeColourCache {
  private readonly words = new Map<number, number>();
  private readonly glows = new Map<number, readonly [number, number, number] | null>();

  constructor(
    private readonly look: (material: number) => VoxelMaterialLook,
    private readonly means: VolumeBounceMeans | null,
  ) {}

  /** The glow of grid entry `entry`'s material (null: none). */
  glow(entry: number): readonly [number, number, number] | null {
    const m = entry & ((1 << MATERIAL_BITS) - 1);
    let g = this.glows.get(m);
    if (g === undefined) {
      g = volumeLookGlow(this.look(m), this.means === null ? null : (this.means.get(m) ?? null));
      this.glows.set(m, g);
    }
    return g;
  }

  /** The packed colour of grid entry `entry` seen from `at` (0 wall, 1 floor, 2 ceiling). */
  word(entry: number, at: number): number {
    const m = entry & ((1 << MATERIAL_BITS) - 1);
    const k = m * 4 + at;
    let c = this.words.get(k);
    if (c === undefined) {
      const rgb = volumeLookBounce(this.look(m), this.means === null ? null : (this.means.get(m) ?? null), at);
      c = packRgba(rgb[0], rgb[1], rgb[2]);
      this.words.set(k, c);
    }
    return c;
  }
}

/**
 * The packed colour of level-0 open cell (x, y, z) in `grid` (the chunk holding it, at chunk `c`): the mean of the
 * colours of the cells across its faces that hold a material, each seen from its side; 0 where none does (or the cell
 * is not open).
 */
export function volumeCellColour(grid: Uint16Array, c: readonly number[], x: number, y: number, z: number, colours: VolumeColourCache): number {
  const at = (lx: number, ly: number, lz: number): number => grid[((lx + 1) * SIDE + (lz + 1)) * SIDE + (ly + 1)]!;
  const lx = x - c[0]! * EDGE;
  const ly = y - c[1]! * EDGE;
  const lz = z - c[2]! * EDGE;
  if (at(lx, ly, lz) !== 0) return 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const e = at(lx + dx, ly + dy, lz + dz);
    if (e === 0) continue;
    const w = colours.word(e, side(dy));
    r += w & 255;
    g += (w >>> 8) & 255;
    b += (w >>> 16) & 255;
    n++;
  }
  return n === 0 ? 0 : (Math.round(r / n) | (Math.round(g / n) << 8) | (Math.round(b / n) << 16) | (255 << 24)) >>> 0;
}

/**
 * The glow word of level-0 open cell (x, y, z) in `grid` (as {@link volumeCellColour} reads it): the mean, over the
 * cells across its faces that hold a material, of each one's glow (a cell beside a glowing and a plain face takes half
 * the glow), packed as the light is (`volumeEncode`); 0 where none glows (or the cell is not open).
 */
export function volumeCellGlow(grid: Uint16Array, c: readonly number[], x: number, y: number, z: number, colours: VolumeColourCache): number {
  const at = (lx: number, ly: number, lz: number): number => grid[((lx + 1) * SIDE + (lz + 1)) * SIDE + (ly + 1)]!;
  const lx = x - c[0]! * EDGE;
  const ly = y - c[1]! * EDGE;
  const lz = z - c[2]! * EDGE;
  if (at(lx, ly, lz) !== 0) return 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let lit = false;
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const e = at(lx + dx, ly + dy, lz + dz);
    if (e === 0) continue;
    n++;
    const w = colours.glow(e);
    if (w === null) continue;
    lit = true;
    r += w[0];
    g += w[1];
    b += w[2];
  }
  return lit ? volumeEncode(r / n, g / n, b / n) : 0;
}

/** A brick's 64 colours (cell x, then y, then z) from the grid of the chunk holding it; 0 where none. */
export function volumeBrickColours(bx: number, by: number, bz: number, grids: ReadonlyMap<string, VolumeChunkGrid>, colours: VolumeColourCache, out: Uint32Array): void {
  out.fill(0);
  const c = [Math.floor((bx * 4) / EDGE), Math.floor((by * 4) / EDGE), Math.floor((bz * 4) / EDGE)];
  const g = grids.get(`${c[0]},${c[1]},${c[2]}`);
  if (g === undefined || typeof g === 'number') return;
  for (let lz = 0; lz < 4; lz++) for (let ly = 0; ly < 4; ly++) for (let lx = 0; lx < 4; lx++) out[lx + 4 * (ly + 4 * lz)] = volumeCellColour(g, c, bx * 4 + lx, by * 4 + ly, bz * 4 + lz, colours);
}

/** A brick's 64 glow words (as {@link volumeBrickColours}); whether any is not 0. */
export function volumeBrickGlows(bx: number, by: number, bz: number, grids: ReadonlyMap<string, VolumeChunkGrid>, colours: VolumeColourCache, out: Uint32Array): boolean {
  out.fill(0);
  const c = [Math.floor((bx * 4) / EDGE), Math.floor((by * 4) / EDGE), Math.floor((bz * 4) / EDGE)];
  const g = grids.get(`${c[0]},${c[1]},${c[2]}`);
  if (g === undefined || typeof g === 'number') return false;
  let any = false;
  for (let lz = 0; lz < 4; lz++) for (let ly = 0; ly < 4; ly++) for (let lx = 0; lx < 4; lx++) {
    const w = volumeCellGlow(g, c, bx * 4 + lx, by * 4 + ly, bz * 4 + lz, colours);
    out[lx + 4 * (ly + 4 * lz)] = w;
    if (w !== 0) any = true;
  }
  return any;
}

/**
 * What of a look the volume reads (its bounce colours seen from each side and its glow), as a key: a record edit that
 * changes it for a voxel id changes what the cells beside that material hold.
 */
export function volumeLookKey(look: VoxelMaterialLook, means: readonly (readonly number[] | null)[] | null): string {
  return JSON.stringify([volumeLookBounce(look, means, 0), volumeLookBounce(look, means, 1), volumeLookBounce(look, means, 2), volumeLookGlow(look, means)]);
}

/**
 * The open cells of a chunk (0 … 31 a side) that border a solid cell of one of `ids` across a face (its grid's border
 * cells included: a material in the next chunk across a face), as a box, or null where none does: the cells whose
 * colour and glow a record edit of those materials changes.
 */
export function volumeMaterialBox(grid: VolumeChunkGrid, ids: ReadonlySet<number>): [number[], number[]] | null {
  const mask = (1 << MATERIAL_BITS) - 1;
  // A chunk of one entry is solid through: its own cells hold no light, and the open cells beside it lie in the chunks
  // across its faces, whose grids' borders hold it.
  if (typeof grid === 'number') return null;
  const at = (x: number, y: number, z: number): number => grid[(x * SIDE + z) * SIDE + y]!;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let x = 0; x < SIDE; x++) for (let z = 0; z < SIDE; z++) for (let y = 0; y < SIDE; y++) {
    const e = at(x, y, z);
    if (e === 0 || !ids.has(e & mask)) continue;
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const n = [x + dx - 1, y + dy - 1, z + dz - 1];
      if (n.some((v) => v < 0 || v >= EDGE) || at(n[0]! + 1, n[1]! + 1, n[2]! + 1) !== 0) continue;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, n[k]!);
        hi[k] = Math.max(hi[k]!, n[k]!);
      }
    }
  }
  return lo[0] === Infinity ? null : [lo, hi];
}

/**
 * The level-0 bricks (world bricks, a box a chunk: lo … hi inclusive) holding the open cells that border a solid cell
 * of one of `ids` in the chunks' grids (by `cx,cy,cz`): what a record edit of those materials rewrites and marks.
 */
export function volumeMaterialBricks(grid: VolumeChunkGrid, chunk: readonly number[], ids: ReadonlySet<number>): [number[], number[]] | null {
  const box = volumeMaterialBox(grid, ids);
  if (box === null) return null;
  return [box[0].map((v, a) => Math.floor((v + chunk[a]! * EDGE) / 4)), box[1].map((v, a) => Math.floor((v + chunk[a]! * EDGE) / 4))];
}

/** A packed colour as linear rgb (0: none, the default grey, as the update reads it). */
export function volumeColourRgb(word: number): [number, number, number] {
  if (word === 0) return [BOUNCE_ALBEDO, BOUNCE_ALBEDO, BOUNCE_ALBEDO];
  return [(word & 255) / 255, ((word >>> 8) & 255) / 255, ((word >>> 16) & 255) / 255];
}

// ---------------------------------------------------------------------------------------------------------------
// The texture means

/** The part of a `GPUDevice` the means' pass calls. */
interface MeansDevice {
  createBuffer(desc: { size: number; usage: number; label?: string }): { destroy(): void; mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void };
  createShaderModule(desc: { code: string; label?: string }): unknown;
  createComputePipeline(desc: Record<string, unknown>): { getBindGroupLayout(i: number): unknown };
  createBindGroup(desc: Record<string, unknown>): unknown;
  createCommandEncoder(): { beginComputePass(d?: unknown): { setPipeline(p: unknown): void; setBindGroup(i: number, g: unknown): void; dispatchWorkgroups(x: number): void; end(): void }; copyBufferToBuffer(a: unknown, ao: number, b: unknown, bo: number, n: number): void; finish(): unknown };
  readonly queue: { writeBuffer(b: unknown, o: number, d: ArrayBufferView): void; submit(list: unknown[]): void };
}

/** A GPU texture as the means' pass reads its shape. */
interface MeansTexture {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly format: string;
  createView(desc: Record<string, unknown>): unknown;
}

/** Texels a side the level the means are read from has at most (a coarse level holds the layer's mean colour). */
const MEANS_LEVEL_TEXELS = 16;

/**
 * Texels a side the level the glow mask's share is read from has at most: the always-resident tail's largest (a
 * streamed array's finer levels may not be there yet). Finer than the colour's: the encoder's mip filter rings at a
 * sharp mask's edges and its levels are clamped at 0, so a crack mask's mean drifts up by about a tenth at 32² and
 * below (measured, `tools/voxel-bench/glow-mask.test.ts`); at 128² it holds.
 */
const MASK_LEVEL_TEXELS = TEXTURE_STREAM_TAIL_PX;

/** Invocations a layer's workgroup sums the mask's level with. */
const MEANS_GROUP = 64;

/**
 * Per layer (a workgroup each): the albedo's coarse level summed by one invocation as ever (its mean colour), and over
 * the finer level of both the albedo and the ORM array's A (the glow mask, read at the same place of its own level;
 * `q.w` 0: no ORM array, the mask 1) the sums of colour × mask with the mask's own, and of the colour alone, so the
 * mask's share of each channel is told apart from the colour's mean (`f.w` 1: sRGB bytes in a plain format, made linear
 * a texel before they are summed).
 */
const MEANS_WGSL = /* wgsl */ `
@group(0) @binding(0) var t: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> p: vec4<u32>;
@group(0) @binding(3) var m: texture_2d_array<f32>;
@group(0) @binding(4) var<uniform> q: vec4<u32>;
@group(0) @binding(5) var<uniform> f: vec4<u32>;
var<workgroup> wp: array<vec4<f32>, ${MEANS_GROUP}>;
var<workgroup> wc: array<vec4<f32>, ${MEANS_GROUP}>;
fn lin(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}
@compute @workgroup_size(${MEANS_GROUP})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let layer = wg.x;
  var pr = vec4<f32>(0.0);
  var co = vec4<f32>(0.0);
  let nf = f.y * f.z;
  for (var i = li; i < nf; i += ${MEANS_GROUP}u) {
    let x = i % f.y;
    let y = i / f.y;
    var c = textureLoad(t, vec2<u32>(x, y), layer, f.x).rgb;
    if (f.w != 0u) { c = lin(c); }
    var a = 1.0;
    if (q.w != 0u) { a = textureLoad(m, vec2<u32>(x * q.y / f.y, y * q.z / f.z), layer, q.x).a; }
    pr += vec4<f32>(c * a, a);
    co += vec4<f32>(c, 1.0);
  }
  wp[li] = pr;
  wc[li] = co;
  workgroupBarrier();
  for (var k = ${MEANS_GROUP / 2}u; k > 0u; k = k >> 1u) {
    if (li < k) {
      wp[li] += wp[li + k];
      wc[li] += wc[li + k];
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    var s = vec4<f32>(0.0);
    for (var y = 0u; y < p.z; y++) { for (var x = 0u; x < p.y; x++) { s += textureLoad(t, vec2<u32>(x, y), layer, p.x); } }
    out[layer * 3u] = s / f32(p.y * p.z);
    out[layer * 3u + 1u] = wp[0] / f32(nf);
    out[layer * 3u + 2u] = wc[0] / f32(nf);
  }
}`;

const STORAGE = 0x80;
const COPY_SRC = 0x4;
const COPY_DST = 0x8;
const UNIFORM = 0x40;
const MAP_READ = 0x1;

/** The level of a texture whose larger side is at most `texels` (its last where none is), and its size. */
function meansLevel(t: MeansTexture, texels: number): [number, number, number] {
  let level = 0;
  while (level < t.mipLevelCount - 1 && Math.max(t.width >> level, t.height >> level) > texels) level++;
  return [level, Math.max(1, t.width >> level), Math.max(1, t.height >> level)];
}

/**
 * A layer's means from the pass's sums (each over its level's texel count): `s` the coarse level's colour, `prod` the
 * finer level's colour × glow mask (rgb) and mask (a), `col` its colour alone (linear there). Its mean linear colour
 * (`lin`: the coarse mean made linear), then the mean of what its glow draws: that colour times each channel's share
 * the mask keeps (`prod / col`; the mask's mean where a channel is black), so a layer whose mask is 1 everywhere gives
 * its colour mean again exactly.
 */
export function layerMeansOfSums(s: readonly number[], prod: readonly number[], col: readonly number[], lin: (c: number) => number): number[] {
  const colour = [lin(s[0]!), lin(s[1]!), lin(s[2]!)];
  const drawn = [0, 1, 2].map((k) => colour[k]! * (col[k]! > 0 ? prod[k]! / col[k]! : prod[3]!));
  return [...colour, ...drawn];
}

/**
 * The means of every layer of a texture array on the GPU (null: not on WebGPU, or no texture there): a coarse level's
 * texels averaged per layer (sRGB formats are read linear; a plain 8-bit format holding sRGB colour is turned linear
 * here), each layer's [r, g, b] mean colour followed by its mean of colour × glow mask (`layerMeansOfSums`), the mask the
 * A of `maskTexture`'s same layer (the ORM array: null, none, the mask 1).
 */
export async function textureLayerMeans(device: unknown, gpuTexture: unknown, srgbData: boolean, maskTexture: unknown = null): Promise<number[][] | null> {
  const d = device as MeansDevice | null;
  const t = gpuTexture as MeansTexture | null;
  if (d === null || t === null || typeof t.createView !== 'function') return null;
  const [level, w, h] = meansLevel(t, MEANS_LEVEL_TEXELS);
  const [fLevel, fw, fh] = meansLevel(t, MASK_LEVEL_TEXELS);
  const layers = t.depthOrArrayLayers;
  const mt = maskTexture as MeansTexture | null;
  const mask = mt !== null && typeof mt.createView === 'function' && mt.depthOrArrayLayers >= layers ? mt : null;
  const [mLevel, mw, mh] = mask === null ? [0, 1, 1] : meansLevel(mask, Math.max(fw, fh));
  const plainSrgb = srgbData && !t.format.endsWith('-srgb');
  const bytes = layers * 48;
  const pipeline = d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code: MEANS_WGSL, label: 'voxel albedo means' }), entryPoint: 'main' }, label: 'voxel albedo means' });
  const out = d.createBuffer({ size: bytes, usage: STORAGE | COPY_SRC, label: 'voxel albedo means' });
  const read = d.createBuffer({ size: bytes, usage: MAP_READ | COPY_DST, label: 'voxel albedo means read' });
  const params = d.createBuffer({ size: 16, usage: UNIFORM | COPY_DST, label: 'voxel albedo means params' });
  const maskParams = d.createBuffer({ size: 16, usage: UNIFORM | COPY_DST, label: 'voxel albedo means mask params' });
  const fineParams = d.createBuffer({ size: 16, usage: UNIFORM | COPY_DST, label: 'voxel albedo means fine params' });
  try {
    d.queue.writeBuffer(params, 0, new Uint32Array([level, w, h, layers]));
    d.queue.writeBuffer(maskParams, 0, new Uint32Array([mLevel, mw, mh, mask === null ? 0 : 1]));
    d.queue.writeBuffer(fineParams, 0, new Uint32Array([fLevel, fw, fh, plainSrgb ? 1 : 0]));
    const view = t.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: t.mipLevelCount });
    // Without a mask the albedo is bound in its place (never read: a binding needs a texture).
    const maskView = mask === null ? view : mask.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: mask.mipLevelCount });
    const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: out } }, { binding: 2, resource: { buffer: params } }, { binding: 3, resource: maskView }, { binding: 4, resource: { buffer: maskParams } }, { binding: 5, resource: { buffer: fineParams } }] });
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass({ label: 'voxel albedo means' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(layers);
    pass.end();
    enc.copyBufferToBuffer(out, 0, read, 0, bytes);
    d.queue.submit([enc.finish()]);
    await read.mapAsync(MAP_READ);
    const v = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    const lin = (c: number): number => (!plainSrgb ? c : c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return Array.from({ length: layers }, (_, i) => layerMeansOfSums([...v.subarray(i * 12, i * 12 + 4)], [...v.subarray(i * 12 + 4, i * 12 + 8)], [...v.subarray(i * 12 + 8, i * 12 + 12)], lin));
  } finally {
    out.destroy();
    read.destroy();
    params.destroy();
    maskParams.destroy();
    fineParams.destroy();
  }
}

/**
 * The bounce colours' texture means as the volume keeps them: measured from the albedo array (and the ORM array's glow
 * mask) each time the surfaces are given them (the last ask wins), by voxel id from its wall, floor and ceiling layers.
 */
export class VolumeBounceSource {
  /** By voxel id (null: none measured, or no array). */
  means: VolumeBounceMeans | null = null;
  /** Ms from the last ask to its means (the pass, its read back and the wait for the GPU). */
  lastMs = 0;
  private ask = 0;

  /**
   * The means of `gpuTexture`'s layers measured (null: none: the looks' colours alone), the glow mask from `maskTexture`'s
   * A (null: none, a mask of 1), `layers` each voxel id's; `done` once {@link means} changed.
   */
  measure(device: unknown, gpuTexture: unknown, srgbData: boolean, layers: ReadonlyMap<number, readonly [number, number, number]> | null, done: () => void, maskTexture: unknown = null): void {
    const ask = ++this.ask;
    if (gpuTexture === null || layers === null) {
      if (this.means === null) return;
      this.means = null;
      done();
      return;
    }
    const t0 = performance.now();
    void textureLayerMeans(device, gpuTexture, srgbData, maskTexture).then(
      (means) => {
        if (ask !== this.ask || means === null) return;
        this.lastMs = performance.now() - t0;
        const by = new Map<number, [number[] | null, number[] | null, number[] | null]>();
        for (const [id, l] of layers) by.set(id, [means[l[0]] ?? null, means[l[1]] ?? null, means[l[2]] ?? null]);
        this.means = by;
        done();
      },
      () => undefined,
    );
  }
}
