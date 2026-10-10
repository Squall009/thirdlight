/**
 * KTX2 encoding on import.
 *
 * A PNG, JPEG or WebP texture imported with `ktx2: "color"` or `"normal"` is
 * encoded to a Basis Universal KTX2 with a full mip chain, and the KTX2 is
 * the asset version's stored bytes (the source is recorded as its original,
 * `convertedFrom`, like an FBX converted to GLB):
 *
 * - `color` (albedo, emissive, UI-free colour art): ETC1S, sRGB transfer
 *   function, perceptual, mipmaps filtered in sRGB — small files;
 * - `normal` (tangent-space normal maps): UASTC LDR 4×4 with Zstandard
 *   supercompression, linear, the encoder's normal-map preset (mipmaps
 *   renormalized) — keeps the precision normals need;
 * - `data` (masks, heights, roughness / occlusion / metalness
 *   packed per channel): UASTC LDR 4×4 with Zstandard, linear, mipmaps
 *   filtered in linear space, channels kept apart (ETC1S would mix them).
 *
 * Packing — a KTX2 texture (a texture array with several
 * layers) made from texture assets' images channel by channel: each
 * layer's R, G, B and A come from a channel of a source image or a constant.
 * When every layer is a whole UASTC KTX2 of one size, mip count and colour
 * space (what a game's KTX2-only textures are), the layers are joined without
 * re-encoding (`ktx2-container.ts`). Otherwise every source is decoded — a
 * KTX2 is transcoded to RGBA, or its lossless original (a PNG the backend
 * found) read in its place — and the layers are encoded once; a layer read
 * from transcoded texels is reported re-encoded (a second lossy generation).
 * All sources are the same size; the encoder takes at most 12 Mpix across the
 * layers (4 layers of 1024², 2 of 2048²).
 *
 * The encoder is `ktx2-encoder` (pinned; its bundled Basis Universal WASM
 * build, non-threaded), run off the backend's event loop in a worker thread
 * (`ktx2-worker.ts`) in the deployment, in-process in tests. A WebP source
 * is decoded with libwebp (`image-decode.ts`), so a lossy WebP is encoded from
 * the pixels a browser would draw.
 */
import { Worker } from 'node:worker_threads';

import { MAX_TEXTURE_LAYERS } from '@thirdlight/project-model/limits';
import * as ktx2Encoder from 'ktx2-encoder';

import { composePageRgba, type ComposeLayer } from './decal-page-compose';
import { decodeImage, sourceFormat, type DecodedImage } from './image-decode';
import { makeImageThumbnail } from './image-thumbnail';
import { joinUastcLayers, KTX2_TRANSFER_LINEAR, KTX2_TRANSFER_SRGB, readKtx2 } from './ktx2-container';

export type Ktx2Mode = 'color' | 'normal' | 'data';
export const KTX2_MODES: readonly Ktx2Mode[] = ['color', 'normal', 'data'];
/** The encoder package and its pinned version (recorded with every encoded version). */
export const KTX2_ENCODER = { name: 'ktx2-encoder', version: '0.6.0' } as const;
/**
 * The encoder's source limit (Basis Universal 2.5: 12 Mpix across the
 * slices). Kept: a known limit of the pinned encoder, not of the engine; a
 * larger texture is imported as PNG/JPEG or encoded outside the editor.
 */
export const KTX2_SOURCE_PIXELS_MAX = 12 * 1024 * 1024;

export type Ktx2EncodeResult =
  | { ok: true; ktx2: Uint8Array; source: { format: 'png' | 'jpeg' | 'webp'; width: number; height: number } }
  | { ok: false; code: 'texture_encode_unsupported' | 'texture_encode_failed'; message: string };

/** One channel of a packed layer: a channel of source image `source`, or a constant 0–255. */
export type PackSource = { source: number; channel: 0 | 1 | 2 | 3 } | { value: number };
/** A packed layer's R, G, B and A sources. */
export type PackLayer = readonly [PackSource, PackSource, PackSource, PackSource];

/**
 * A packed texture. `reencoded[i]`: layer i was made from texels transcoded
 * out of a lossy KTX2 and encoded again; false where the layer was joined
 * as stored or encoded from a lossless image. `joined`: the UASTC layers were
 * joined without re-encoding.
 */
export type Ktx2PackResult =
  | { ok: true; ktx2: Uint8Array; width: number; height: number; layers: number; reencoded: boolean[]; joined: boolean }
  | { ok: false; code: 'texture_encode_unsupported' | 'texture_encode_failed'; message: string };

export interface TextureEncoder {
  encode(bytes: Uint8Array, mode: Ktx2Mode): Promise<Ktx2EncodeResult>;
  /** A tile thumbnail (PNG) of a PNG, JPEG or WebP image; null when the image cannot be read. */
  thumbnail(bytes: Uint8Array): Promise<Uint8Array | null>;
  /**
   * Pack the layers' channels from the source images (PNG/JPEG/WebP/KTX2 bytes) into one KTX2 (an
   * array with several layers). `lossless[i]`: source i's lossless original (a PNG), read in place of
   * a KTX2 source when the layers have to be encoded.
   */
  pack(sources: readonly Uint8Array[], layers: readonly PackLayer[], mode: Ktx2Mode, lossless?: readonly (Uint8Array | null)[]): Promise<Ktx2PackResult>;
  /** A decal page of side `size` composed of rectangles of the sources, one UASTC layer (`composeKtx2`). */
  compose(sources: readonly Uint8Array[], layer: ComposeLayer, size: number, mode: Ktx2Mode, lossless?: readonly (Uint8Array | null)[]): Promise<Ktx2ComposeResult>;
  /** An image's pixels (PNG, JPEG, WebP, or a single-image KTX2 transcoded: its top level) as 8-bit RGBA, at most `maxPixels`. */
  decode(bytes: Uint8Array, maxPixels: number): Promise<TextureDecodeResult>;
  dispose?(): void;
}

export type TextureDecodeResult = { ok: true; width: number; height: number; data: Uint8Array; transcoded: boolean } | { ok: false; message: string };

/** Decode in this thread (the worker runs this too). */
export async function decodeTextureRgba(bytes: Uint8Array, maxPixels: number): Promise<TextureDecodeResult> {
  const format = sourceFormat(bytes);
  if (format === null) return { ok: false, message: 'not a PNG, JPEG, WebP or KTX2 image' };
  try {
    const img = format === 'ktx2' ? await transcodeKtx2Rgba(bytes, maxPixels) : await decodeImage(bytes, format, maxPixels);
    return { ok: true, width: img.width, height: img.height, data: img.data, transcoded: format === 'ktx2' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Encode one PNG, JPEG or WebP to KTX2 in this thread (the worker runs this too). */
export async function encodeKtx2(bytes: Uint8Array, mode: Ktx2Mode): Promise<Ktx2EncodeResult> {
  const format = sourceFormat(bytes);
  if (format === 'ktx2') return { ok: false, code: 'texture_encode_unsupported', message: 'the texture is already KTX2 (import it without ktx2 encoding)' };
  if (format === null) return { ok: false, code: 'texture_encode_unsupported', message: 'not a PNG, JPEG or WebP image' };
  let img: DecodedImage;
  try {
    img = await decodeImage(bytes, format, KTX2_SOURCE_PIXELS_MAX);
  } catch (e) {
    return { ok: false, code: 'texture_encode_failed', message: `the ${format.toUpperCase()} could not be decoded: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (img.width * img.height > KTX2_SOURCE_PIXELS_MAX) {
    return { ok: false, code: 'texture_encode_unsupported', message: `KTX2 encoding takes at most ${KTX2_SOURCE_PIXELS_MAX} pixels (${img.width}×${img.height} is larger; 2048×4096 fits)` };
  }
  try {
    const colour = mode === 'color';
    const ktx2 = await ktx2Encoder.encodeToKTX2(bytes, {
      imageDecoder: async () => ({ width: img.width, height: img.height, data: img.data }),
      isUASTC: !colour,
      generateMipmap: true,
      isKTX2File: true,
      isNormalMap: mode === 'normal',
      isPerceptual: colour,
      isSetKTX2SRGBTransferFunc: colour,
      // ETC1S: the encoder's quality scale (1-255); UASTC: Zstandard supercompression.
      ...(colour ? { qualityLevel: 128 } : { needSupercompression: true }),
      enableDebug: false,
    });
    return { ok: true, ktx2, source: { format, width: img.width, height: img.height } };
  } catch (e) {
    return { ok: false, code: 'texture_encode_failed', message: `KTX2 encoding failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The Basis Universal module of the packer (the pinned wrapper's own build, loaded once per thread). */
interface BasisEncoderLike {
  setCreateKTX2File(v: boolean): void;
  setUASTC(v: boolean): void;
  setMipGen(v: boolean): void;
  setYFlip(v: boolean): void;
  setPerceptual(v: boolean): void;
  setKTX2AndBasisSRGBTransferFunc?(v: boolean): void;
  setKTX2SRGBTransferFunc(v: boolean): void;
  setNormalMapPreset?(): void;
  setNormalMap(): void;
  setQualityLevel(level: number): void;
  setKTX2UASTCSupercompression(v: boolean): void;
  setPackUASTCFlags?(flags: number): void;
  setDebug(v: boolean): void;
  setTexType(t: number): void;
  setSliceSourceImage(slice: number, data: Uint8Array, width: number, height: number, type: number): boolean | void;
  encode(out: Uint8Array): number;
  delete(): void;
}
/** The transcoder side of the same module (a KTX2 read back to RGBA). */
interface Ktx2FileLike {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLayers(): number;
  getFaces(): number;
  isHDR(): boolean;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, format: number, getAlphaForOpaqueFormats: number, channel0: number, channel1: number): number;
  close(): void;
  delete(): void;
}
interface BasisModuleLike {
  BasisEncoder: new () => BasisEncoderLike;
  KTX2File: new (bytes: Uint8Array) => Ktx2FileLike;
  transcoder_texture_format: { cTFRGBA32: { value: number } };
}
let packModule: Promise<BasisModuleLike> | null = null;

/** The pinned wrapper's Basis Universal module (encoder and transcoder), loaded once per thread. */
async function basisModule(): Promise<BasisModuleLike | null> {
  if (packModule === null) {
    // The wrapper's Node entry exports its module loader (its typings name the browser entry's exports).
    const Loader = (ktx2Encoder as unknown as { NodeBasisEncoder?: new () => { init(): Promise<unknown> } }).NodeBasisEncoder;
    if (Loader === undefined) return null;
    packModule = new Loader().init() as Promise<BasisModuleLike>;
  }
  return packModule;
}

/**
 * A single-image KTX2's top mip level as RGBA bytes (the stored values: an
 * sRGB texture's bytes stay sRGB-encoded, as a PNG's would be). Throws with
 * the reason when it is not one LDR 2D image or exceeds `maxPixels`.
 */
async function transcodeKtx2Rgba(bytes: Uint8Array, maxPixels: number): Promise<DecodedImage> {
  // The container is checked first: the transcoder takes a truncated header for a valid file.
  if (readKtx2(bytes) === null) throw new Error('not a readable Basis Universal KTX2');
  const mod = await basisModule();
  if (mod === null) throw new Error('the KTX2 transcoder is not loaded');
  const f = new mod.KTX2File(bytes);
  try {
    if (!f.isValid()) throw new Error('not a readable Basis Universal KTX2');
    if (f.getLayers() > 1 || f.getFaces() !== 1) throw new Error('a texture array or cube map cannot be a pack source (pack single textures)');
    if (f.isHDR()) throw new Error('an HDR KTX2 cannot be packed');
    const width = f.getWidth();
    const height = f.getHeight();
    if (width * height > maxPixels) throw new Error(`${width}×${height} is more than the ${maxPixels} pixels a source may have here`);
    if (!f.startTranscoding()) throw new Error('the transcoder refused it');
    const format = mod.transcoder_texture_format.cTFRGBA32.value;
    const data = new Uint8Array(f.getImageTranscodedSizeInBytes(0, 0, 0, format));
    if (data.length !== width * height * 4 || !f.transcodeImage(data, 0, 0, 0, format, 0, -1, -1)) throw new Error('the transcoder could not decode it');
    return { width, height, data };
  } finally {
    f.close();
    f.delete();
  }
}
/** Basis Universal's texture types (`basis_texture_type`): one 2D image, a 2D array. */
const BASIS_TEX_2D = 0;
const BASIS_TEX_2D_ARRAY = 1;
/** `setSliceSourceImage`: raw RGBA pixels. */
const SOURCE_RAW = 0;

/**
 * Pack and encode in this thread. Every source is decoded
 * (PNG/JPEG/WebP), all must share one size; each layer's four channels are read
 * from them (or set to a constant), and the layers are encoded together as a
 * 2D array (one image: a plain 2D texture) with the mode's settings — the
 * same as `encodeKtx2`'s for colour and normal maps.
 */
export async function packKtx2(sources: readonly Uint8Array[], layers: readonly PackLayer[], mode: Ktx2Mode, lossless: readonly (Uint8Array | null)[] = []): Promise<Ktx2PackResult> {
  if (layers.length < 1 || layers.length > MAX_TEXTURE_LAYERS) return { ok: false, code: 'texture_encode_unsupported', message: `a packed texture has 1-${MAX_TEXTURE_LAYERS} layers` };
  const used = new Set<number>();
  for (const l of layers) for (const c of l) if ('source' in c) used.add(c.source);
  if (used.size === 0) return { ok: false, code: 'texture_encode_unsupported', message: 'a packed texture needs at least one source image (its size)' };
  // Every layer the whole RGBA of one KTX2: join them as stored when they are UASTC alike.
  const whole = layers.map((l) => {
    const s = l[0];
    return s !== undefined && 'source' in s && l.every((c, k) => 'source' in c && c.source === s.source && c.channel === k) ? s.source : -1;
  });
  if (whole.every((i) => i >= 0 && sources[i] !== undefined && sourceFormat(sources[i]!) === 'ktx2')) {
    const joined = joinUastcLayers(whole.map((i) => sources[i]!), mode === 'color' ? KTX2_TRANSFER_SRGB : KTX2_TRANSFER_LINEAR);
    if (joined.ok) {
      const head = readKtx2(joined.ktx2)!;
      return { ok: true, ktx2: joined.ktx2, width: head.width, height: head.height, layers: layers.length, reencoded: layers.map(() => false), joined: true };
    }
  }
  // Only the sources a channel reads are decoded; the first fixes the size and
  // bounds the rest, so the decoded pixels never exceed the layers' budget.
  const images = new Map<number, DecodedImage>();
  // The sources whose texels were transcoded out of a KTX2 (no lossless original given).
  const transcoded = new Set<number>();
  let width = 0;
  let height = 0;
  for (const i of used) {
    const given = sources[i];
    if (given === undefined) return { ok: false, code: 'texture_encode_unsupported', message: `a channel names source ${i + 1}, which is not given` };
    const original = lossless[i] ?? null;
    const bytes = original !== null && sourceFormat(given) === 'ktx2' ? original : given;
    const format = sourceFormat(bytes);
    if (format === null) return { ok: false, code: 'texture_encode_unsupported', message: `source ${i + 1} is not a PNG, JPEG, WebP or KTX2 image` };
    let img: DecodedImage;
    try {
      const max = images.size === 0 ? KTX2_SOURCE_PIXELS_MAX : width * height;
      if (format === 'ktx2') {
        img = await transcodeKtx2Rgba(bytes, max);
        transcoded.add(i);
      } else img = await decodeImage(bytes, format, max);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, code: 'texture_encode_failed', message: `source ${i + 1} could not be decoded: ${reason}${images.size > 0 ? ` (every source of a packed texture has one size, ${width}×${height})` : ''}` };
    }
    if (images.size === 0) {
      width = img.width;
      height = img.height;
      if (width * height * layers.length > KTX2_SOURCE_PIXELS_MAX) {
        return { ok: false, code: 'texture_encode_unsupported', message: `KTX2 encoding takes at most ${KTX2_SOURCE_PIXELS_MAX} pixels across the layers (${layers.length} × ${width}×${height} is more; e.g. 4 layers of 1024×1024 fit)` };
      }
    } else if (img.width !== width || img.height !== height) {
      return { ok: false, code: 'texture_encode_unsupported', message: `every source of a packed texture has one size: source ${i + 1} is ${img.width}×${img.height}, another ${width}×${height}` };
    }
    images.set(i, img);
  }
  const n = width * height;
  const slices = layers.map((l) => {
    const out = new Uint8Array(n * 4);
    for (let c = 0; c < 4; c++) {
      const src = l[c]!;
      if ('value' in src) {
        const v = Math.max(0, Math.min(255, Math.round(src.value)));
        for (let i = 0; i < n; i++) out[i * 4 + c] = v;
      } else {
        const d = images.get(src.source)!.data;
        for (let i = 0; i < n; i++) out[i * 4 + c] = d[i * 4 + src.channel]!;
      }
    }
    return out;
  });
  const reencoded = layers.map((l) => l.some((c) => 'source' in c && transcoded.has(c.source)));
  const encoded = await encodeSlices(slices, width, height, mode, mode !== 'color');
  return encoded.ok ? { ok: true, ktx2: encoded.ktx2, width, height, layers: slices.length, reencoded, joined: false } : encoded;
}

/**
 * Encode RGBA slices (one: a 2D texture; more: an array) with the mode's
 * settings: colour sRGB and perceptual, a normal map with the encoder's
 * normal preset, data linear; `uastc` UASTC with Zstandard, else ETC1S (a
 * colour import's quality); `uastcLevel` the UASTC effort (absent: the
 * encoder's default, as imports use).
 */
async function encodeSlices(slices: readonly Uint8Array[], width: number, height: number, mode: Ktx2Mode, uastc: boolean, uastcLevel?: number): Promise<{ ok: true; ktx2: Uint8Array } | { ok: false; code: 'texture_encode_failed'; message: string }> {
  const n = width * height;
  try {
    const mod = await basisModule();
    if (mod === null) return { ok: false, code: 'texture_encode_failed', message: 'the KTX2 encoder\'s Node entry is not loaded' };
    // The wrapper's module prints its progress unless this is off (encodeToKTX2 sets it per call).
    (globalThis as { __KTX2_DEBUG__?: boolean }).__KTX2_DEBUG__ = false;
    const enc = new mod.BasisEncoder();
    try {
      const colour = mode === 'color';
      enc.setDebug(false);
      enc.setCreateKTX2File(true);
      enc.setUASTC(uastc);
      enc.setMipGen(true);
      enc.setYFlip(false);
      if (enc.setKTX2AndBasisSRGBTransferFunc !== undefined) enc.setKTX2AndBasisSRGBTransferFunc(colour);
      else enc.setKTX2SRGBTransferFunc(colour);
      if (mode === 'normal') {
        if (enc.setNormalMapPreset !== undefined) enc.setNormalMapPreset();
        else enc.setNormalMap();
      }
      // ETC1S: the same quality as a colour import; UASTC: Zstandard supercompression.
      if (!uastc) enc.setQualityLevel(128);
      else enc.setKTX2UASTCSupercompression(true);
      if (uastc && uastcLevel !== undefined) enc.setPackUASTCFlags?.(uastcLevel);
      enc.setPerceptual(colour);
      enc.setTexType(slices.length > 1 ? BASIS_TEX_2D_ARRAY : BASIS_TEX_2D);
      for (let i = 0; i < slices.length; i++) {
        if (enc.setSliceSourceImage(i, slices[i]!, width, height, SOURCE_RAW) === false) return { ok: false, code: 'texture_encode_failed', message: `the encoder refused layer ${i + 1}` };
      }
      // The output: at most the raw size with mips, plus headers; one retry with twice the room.
      let capacity = Math.ceil(n * slices.length * 4 * (4 / 3)) + 64 * 1024;
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = new Uint8Array(capacity);
        const length = enc.encode(out);
        if (length > 0) return { ok: true, ktx2: out.slice(0, length) };
        capacity *= 2;
      }
      return { ok: false, code: 'texture_encode_failed', message: 'KTX2 encoding failed (the encoder produced nothing)' };
    } finally {
      enc.delete();
    }
  } catch (e) {
    return { ok: false, code: 'texture_encode_failed', message: `KTX2 encoding failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The UASTC effort of a composed decal page (Basis Universal's "faster"
 * pack level; imports keep the encoder's default). Measured on a noisy
 * 1024² image: 2.4 s at 31.57 dB PSNR against 8.2 s at 31.63 dB by default
 * (the fastest level: 0.7 s at 24.0 dB). A 2048² page holds dozens of
 * marks and is made once, then cached.
 */
export const DECAL_PAGE_UASTC_LEVEL = 1;

/** A composed decal page: the KTX2 of one layer, and whether a source's texels were transcoded out of a lossy KTX2. */
export type Ktx2ComposeResult = { ok: true; ktx2: Uint8Array; reencoded: boolean } | { ok: false; code: 'texture_encode_unsupported' | 'texture_encode_failed'; message: string };

/**
 * A decal page composed of rectangles of the sources (`decal-page-compose.ts`),
 * encoded as one UASTC layer (in every mode, so the pages of a set join into
 * one array without re-encoding) of side `size`. A KTX2 source is
 * transcoded, or its lossless original (`lossless[i]`) read instead.
 */
export async function composeKtx2(sources: readonly Uint8Array[], layer: ComposeLayer, size: number, mode: Ktx2Mode, lossless: readonly (Uint8Array | null)[] = []): Promise<Ktx2ComposeResult> {
  if (!Number.isInteger(size) || size < 1 || size * size > KTX2_SOURCE_PIXELS_MAX) return { ok: false, code: 'texture_encode_unsupported', message: `a composed decal page is at most ${KTX2_SOURCE_PIXELS_MAX} pixels (${size}² asked)` };
  const used = new Set<number>();
  for (const p of layer.place) for (const c of p.channels) if ('source' in c) used.add(c.source);
  const images: (DecodedImage | undefined)[] = [];
  let reencoded = false;
  for (const i of used) {
    const given = sources[i];
    if (given === undefined) return { ok: false, code: 'texture_encode_unsupported', message: `a rectangle reads source ${i + 1}, which is not given` };
    const original = lossless[i] ?? null;
    const bytes = original !== null && sourceFormat(given) === 'ktx2' ? original : given;
    const format = sourceFormat(bytes);
    if (format === null) return { ok: false, code: 'texture_encode_unsupported', message: `source ${i + 1} is not a PNG, JPEG, WebP or KTX2 image` };
    try {
      if (format === 'ktx2') {
        images[i] = await transcodeKtx2Rgba(bytes, KTX2_SOURCE_PIXELS_MAX);
        reencoded = true;
      } else images[i] = await decodeImage(bytes, format, KTX2_SOURCE_PIXELS_MAX);
    } catch (e) {
      return { ok: false, code: 'texture_encode_failed', message: `source ${i + 1} could not be decoded: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  let pixels: Uint8Array;
  try {
    pixels = composePageRgba(size, layer, images);
  } catch (e) {
    return { ok: false, code: 'texture_encode_unsupported', message: e instanceof Error ? e.message : String(e) };
  }
  const encoded = await encodeSlices([pixels], size, size, mode, true, DECAL_PAGE_UASTC_LEVEL);
  return encoded.ok ? { ok: true, ktx2: encoded.ktx2, reencoded } : encoded;
}

/** The encoder worker's heap and stack limits (MB). */
export const KTX2_WORKER_LIMITS = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 } as const;

/** In this thread (tests; a busy encode holds the event loop). */
export function createInlineTextureEncoder(): TextureEncoder {
  return { encode: encodeKtx2, pack: (sources, layers, mode, lossless) => packKtx2(sources, layers, mode, lossless), compose: (sources, layer, size, mode, lossless) => composeKtx2(sources, layer, size, mode, lossless), thumbnail: (bytes) => makeImageThumbnail(bytes), decode: decodeTextureRgba };
}

/**
 * How long the encoder worker is kept after its last job. The encoder's WASM
 * memory only grows (WebAssembly memory cannot shrink), so a worker kept for
 * the backend's life holds the peak of its largest encode; ending it once
 * idle gives that back, and the next encode starts a fresh one (a few tens of
 * milliseconds, small beside an encode).
 */
export const KTX2_WORKER_IDLE_MS = 10_000;

/**
 * The deployment's encoder: one worker thread (the script built next to the
 * backend bundle), one encode at a time in order, started on first use and
 * ended once idle; a crashed worker fails its job and is started again for
 * the next.
 */
export function createWorkerTextureEncoder(workerUrl: URL, options: { idleMs?: number } = {}): TextureEncoder & { readonly workerRunning: boolean } {
  const idleMs = options.idleMs ?? KTX2_WORKER_IDLE_MS;
  let worker: Worker | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let next = 1;
  const pending = new Map<number, (r: Ktx2EncodeResult | Ktx2PackResult | Ktx2ComposeResult | TextureDecodeResult | { thumbnail: Uint8Array | null }) => void>();
  const failAll = (message: string): void => {
    for (const done of pending.values()) done({ ok: false, code: 'texture_encode_failed', message });
    pending.clear();
  };
  const stop = (): void => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
    const w = worker;
    worker = null;
    void w?.terminate();
    failAll('the KTX2 encoder stopped');
  };
  const start = (): Worker => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
    if (worker !== null) return worker;
    // A bound on the worker's JS heap: a runaway decode or encode ends the
    // worker (its job fails, the next starts a fresh one), not the backend.
    // Pixel buffers and the encoder's WASM memory are bounded by the source
    // pixel limit, not by these.
    const w = new Worker(workerUrl, { resourceLimits: KTX2_WORKER_LIMITS });
    w.unref();
    w.on('message', (m: { id: number; result: Ktx2EncodeResult | Ktx2PackResult | Ktx2ComposeResult | TextureDecodeResult | { thumbnail: Uint8Array | null } }) => {
      const done = pending.get(m.id);
      pending.delete(m.id);
      done?.(m.result);
      if (pending.size === 0 && worker === w) {
        idle = setTimeout(stop, idleMs);
        idle.unref();
      }
    });
    // Only the current worker's end fails the jobs waiting: one ended for
    // idleness may exit after its successor took new jobs.
    w.on('error', (e) => {
      if (worker === w) failAll(`the KTX2 encoder stopped: ${e.message}`);
    });
    w.on('exit', () => {
      if (worker !== w) return;
      worker = null;
      failAll('the KTX2 encoder stopped');
    });
    worker = w;
    return w;
  };
  return {
    get workerRunning() {
      return worker !== null;
    },
    encode(bytes, mode) {
      const w = start();
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, resolve as (r: Ktx2EncodeResult | Ktx2PackResult | Ktx2ComposeResult | TextureDecodeResult | { thumbnail: Uint8Array | null }) => void);
        const copy = bytes.slice();
        w.postMessage({ id, bytes: copy, mode }, [copy.buffer]);
      });
    },
    pack(sources, layers, mode, lossless = []) {
      const w = start();
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, resolve as (r: Ktx2EncodeResult | Ktx2PackResult | Ktx2ComposeResult | TextureDecodeResult | { thumbnail: Uint8Array | null }) => void);
        const copies = sources.map((b) => b.slice());
        const originals = lossless.map((b) => (b === null ? null : b.slice()));
        const moved = [...copies, ...originals.flatMap((b) => (b === null ? [] : [b]))].map((c) => c.buffer);
        w.postMessage({ id, pack: { sources: copies, layers, lossless: originals }, mode }, moved);
      });
    },
    compose(sources, layer, size, mode, lossless = []) {
      const w = start();
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, resolve as (r: Ktx2EncodeResult | Ktx2PackResult | Ktx2ComposeResult | TextureDecodeResult | { thumbnail: Uint8Array | null }) => void);
        const copies = sources.map((b) => b.slice());
        const originals = lossless.map((b) => (b === null ? null : b.slice()));
        const moved = [...copies, ...originals.flatMap((b) => (b === null ? [] : [b]))].map((c) => c.buffer);
        w.postMessage({ id, compose: { sources: copies, layer, size, lossless: originals }, mode }, moved);
      });
    },
    thumbnail(bytes) {
      const w = start();
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, (r) => resolve('thumbnail' in r ? r.thumbnail : null));
        const copy = bytes.slice();
        w.postMessage({ id, thumbnail: copy }, [copy.buffer]);
      });
    },
    decode(bytes, maxPixels) {
      const w = start();
      const id = next++;
      return new Promise((resolve) => {
        // A stopped worker answers the encoder's failure shape: its message is the reason.
        pending.set(id, (r) => resolve('width' in r || ('ok' in r && r.ok === false) ? (r as TextureDecodeResult) : { ok: false, message: 'the decoder answered something else' }));
        const copy = bytes.slice();
        w.postMessage({ id, decode: { bytes: copy, maxPixels } }, [copy.buffer]);
      });
    },
    dispose() {
      stop();
    },
  };
}
