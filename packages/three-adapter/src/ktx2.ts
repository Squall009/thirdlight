/**
 * KTX2 (Basis Universal) textures on the page — one shared
 * KTX2Loader per page (three warns about several: each loads the transcoder
 * and starts its own workers), used by GLBs with KHR_texture_basisu and by
 * KTX2 texture assets alike.
 *
 * The transcoder files (`basis_transcoder.js/.wasm`, from the pinned three)
 * are served next to the page: the editor and the export under
 * `./decoders/basis/`, Play under `/decoders/basis/`. The page names that
 * base once (`setKtx2DecoderBase`) before a KTX2 texture is decoded.
 *
 * The GPU format the transcoder writes is picked from a WebGL 2 probe of the
 * same browser (three's `detectSupport` rules, the Linux/Mesa emulation filter
 * included), for both backends: the formats it can pick (BC7/BC1-3 on
 * desktop, ASTC/ETC2 on mobile) are the ones WebGPU exposes on the same GPU,
 * with an uncompressed RGBA fallback when none is there.
 */
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { DataTexture, RGBAFormat, type CompressedTexture, type Texture } from 'three';

/** `«KTX 20»\r\n\x1A\n`. */
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function isKtx2(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  for (let i = 0; i < 12; i++) if (bytes[i] !== KTX2_IDENTIFIER[i]) return false;
  return true;
}

/**
 * KTX2Loader picks the GPU format to transcode to from the renderer's
 * compressed-texture extensions. The loader does not own the game's renderer,
 * so it asks a small WebGL2 context of its own (same browser and GPU).
 */
export function textureSupport(): { isWebGPURenderer: false; extensions: { has(name: string): boolean; get(name: string): unknown } } {
  const doc = (globalThis as { document?: { createElement(tag: string): { getContext(kind: string): unknown } } }).document;
  // A worker (the editor's thumbnails) has no document: an OffscreenCanvas asks the same GPU.
  const Offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => { getContext(kind: string): unknown } }).OffscreenCanvas;
  const canvas = doc !== undefined ? doc.createElement('canvas') : Offscreen !== undefined ? new Offscreen(1, 1) : undefined;
  const gl = canvas?.getContext('webgl2') as { getExtension(name: string): unknown } | null | undefined;
  const get = (name: string): unknown => (gl ? gl.getExtension(name) : null);
  return { isWebGPURenderer: false, extensions: { has: (name) => get(name) !== null, get } };
}

let base: string | null = null;
let shared: { base: string; loader: KTX2Loader } | null = null;

/** Where this page serves three's decoder files (`<base>basis/…`, a URL ending in `/`). */
export function setKtx2DecoderBase(decoderBase: string): void {
  base = decoderBase;
}

/** The page's KTX2Loader for `decoderBase` (made on first need). */
export function sharedKtx2Loader(decoderBase: string): KTX2Loader {
  if (shared !== null && shared.base === decoderBase) return shared.loader;
  shared?.loader.dispose();
  const loader = new KTX2Loader();
  loader.setTranscoderPath(`${decoderBase}basis/`);
  loader.detectSupport(textureSupport() as unknown as Parameters<KTX2Loader['detectSupport']>[0]);
  // Every texture the loader makes from a transcode (texture assets and model images alike) is
  // handed over uploadable: see `uploadableKtx2Texture`.
  const internal = loader as unknown as { _createTextureFrom: (result: unknown, container: unknown) => Texture | Promise<Texture> };
  const createFrom = internal._createTextureFrom.bind(loader);
  internal._createTextureFrom = (result, container) => {
    const made = createFrom(result, container);
    return made instanceof Promise ? made : uploadableKtx2Texture(made);
  };
  shared = { base: decoderBase, loader };
  return loader;
}

/**
 * A transcoded texture the renderers can upload. On a GPU without a
 * compressed format the transcoder writes plain RGBA, which three's loader
 * still wraps as a `CompressedTexture` of `RGBAFormat`: the WebGPU backend
 * has no block size for an uncompressed format and throws inside the draw
 * (its renderer draws nothing from then on: an editor worker's thumbnails
 * stopped at the first such model), and the WebGL backend sends it as a
 * compressed upload, which GL refuses. The same pixels and mip levels as a
 * `DataTexture` are an ordinary upload on both. Anything else is returned
 * as it is.
 */
export function uploadableKtx2Texture(texture: Texture): Texture {
  const c = texture as CompressedTexture & { isCompressedArrayTexture?: boolean; isCompressedCubeTexture?: boolean };
  if (c.isCompressedTexture !== true || c.isCompressedArrayTexture === true || c.isCompressedCubeTexture === true || (c.format as number) !== RGBAFormat) return texture;
  const mips = c.mipmaps as unknown as { data: Uint8Array; width: number; height: number }[];
  const top = mips[0];
  if (top === undefined) return texture;
  const d = new DataTexture(top.data, top.width, top.height, RGBAFormat, c.type);
  // Every level, the single one too: what reads the texture's levels (mip streaming) finds them where a compressed texture keeps them.
  d.mipmaps = mips.map((m) => ({ data: m.data, width: m.width, height: m.height }));
  d.minFilter = c.minFilter;
  d.magFilter = c.magFilter;
  d.generateMipmaps = false;
  d.colorSpace = c.colorSpace;
  d.premultiplyAlpha = c.premultiplyAlpha;
  d.flipY = false;
  d.wrapS = c.wrapS;
  d.wrapT = c.wrapT;
  d.anisotropy = c.anisotropy;
  d.name = c.name;
  d.userData = c.userData;
  d.needsUpdate = true;
  c.dispose();
  return d;
}

/** Decode a KTX2 texture asset's bytes (the base set by `setKtx2DecoderBase`). */
export function decodeKtx2(bytes: ArrayBuffer | Uint8Array): Promise<CompressedTexture | DataTexture> {
  if (base === null) return Promise.reject(new Error('a KTX2 texture needs the Basis transcoder, and this page names no decoder path'));
  const loader = sharedKtx2Loader(base);
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // A fresh buffer: the loader hands it to a worker (transferred) and caches tasks by buffer.
  const buffer = view.slice().buffer;
  return new Promise((resolve, reject) => {
    void loader.parse(buffer, (t: CompressedTexture | DataTexture) => resolve(t), (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}
