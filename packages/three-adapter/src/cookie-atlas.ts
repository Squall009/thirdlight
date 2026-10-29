/**
 * The spot lights' cookies in ONE texture with the area lights' tables: the
 * cookie atlas. A cookie used to be three's `SpotLight.map`, a texture (and
 * a texture unit, and a light node of its own) per spot; here every spot
 * that projects one reads its tile of the atlas through the light loop
 * (`cluster-lights.ts`), the way its shadow is a tile of the shadow atlas.
 *
 * - **One unit.** The lit programs' budget (`texture-units.ts`) has no room
 *   for a fourth texture of the light path, so the atlas IS the light
 *   tables' texture: {@link COOKIE_ATLAS_SIDE}² half floats (32 MiB), the
 *   LTC tables in the first tile's corner, cookies in the other tiles. It
 *   exists only while a spot projects a cookie; without one the light
 *   tables are the LTC tables alone (`cluster-area.ts`).
 * - **Tiles**: {@link COOKIE_TILE}² each, a cookie drawn into its tile once
 *   when it is loaded (or changes), shared by the spots that project the
 *   same image. Spots are served best rank first; past the atlas's tiles the
 *   lowest-ranked spots draw no cookie (`dropped`). A tile no spot asks for
 *   is kept until another cookie needs it (a spot leaving the view and
 *   coming back draws nothing again).
 * - **Drawn on the CPU**: the image scaled into the tile on a 2D canvas, sRGB
 *   decoded where the texture is sRGB, written as half floats, so it reads
 *   as three read the map (its rows the way three's upload puts them) on
 *   either renderer, and only the tile is sent (`queue.writeTexture` on
 *   WebGPU, `texSubImage2D` through three's copy on WebGL 2). A cookie whose
 *   pixels the page cannot read back (a GPU-compressed texture) draws
 *   none, with one console warning.
 * - **Memory**: the tiles' half floats are kept per cookie (512 KiB each),
 *   not the whole atlas, so a new renderer gets its texture again from them.
 */
import * as THREE from 'three/webgpu';

import { LTC_SIZE, ltcTablesData } from './cluster-area';
import type { ClusterUploadRenderer } from './cluster-gpu';

/** The atlas's side and a cookie tile's side (texels). */
export const COOKIE_ATLAS_SIDE = 2048;
export const COOKIE_TILE = 256;
/** Tiles a row; the first tile holds the LTC tables. */
export const COOKIE_COLUMNS = COOKIE_ATLAS_SIDE / COOKIE_TILE;
/** Cookie tiles in the atlas. */
export const COOKIE_TILES = COOKIE_COLUMNS * COOKIE_COLUMNS - 1;
/** The share of the atlas the LTC tables take (across, down). */
export const COOKIE_LTC_SHARE: readonly [number, number] = [(2 * LTC_SIZE) / COOKIE_ATLAS_SIDE, LTC_SIZE / COOKIE_ATLAS_SIDE];

/** A spot's cookie this frame: its image (the texture's `source`: copies of one decoded texture share it) and the spot's rank. */
export interface CookieRequest {
  readonly texture: THREE.Texture;
  readonly rank: number;
}

/**
 * Which cookie holds which tile (pure): best-ranked requests first, each
 * image one tile; a tile kept until a request with nowhere else to go needs
 * it (the one used least recently goes).
 */
export class CookieTiles {
  private readonly held = new Map<object, { tile: number; used: number }>();
  private readonly free: number[] = [];
  private frame = 0;
  dropped = 0;

  constructor(readonly tiles = COOKIE_TILES) {
    // Tile 0 holds the LTC tables.
    for (let t = tiles; t >= 1; t -= 1) this.free.push(t);
  }

  /** The tile of each requested image (-1: none this frame); `fresh` gets the images given a tile now (to be drawn). */
  assign(requests: readonly { key: object; rank: number }[], fresh: (key: object, tile: number) => void, gone: (key: object) => void): Map<object, number> {
    this.frame += 1;
    this.dropped = 0;
    const out = new Map<object, number>();
    const ranked = [...requests].sort((a, b) => b.rank - a.rank);
    for (const r of ranked) {
      if (out.has(r.key)) continue;
      const h = this.held.get(r.key);
      if (h !== undefined) {
        h.used = this.frame;
        out.set(r.key, h.tile);
      }
    }
    for (const r of ranked) {
      if (out.has(r.key)) continue;
      let tile = this.free.pop();
      if (tile === undefined) {
        // The least recently used image no request this frame holds.
        let worst: object | null = null;
        let at = Infinity;
        for (const [k, h] of this.held) if (h.used < this.frame && h.used < at) [worst, at] = [k, h.used];
        if (worst === null) {
          out.set(r.key, -1);
          this.dropped += 1;
          continue;
        }
        tile = this.held.get(worst)!.tile;
        this.held.delete(worst);
        gone(worst);
      }
      this.held.set(r.key, { tile, used: this.frame });
      out.set(r.key, tile);
      fresh(r.key, tile);
    }
    // Spots whose image was dropped share the count.
    this.dropped = requests.filter((r) => out.get(r.key) === -1).length;
    return out;
  }

  /** Every tile given back. */
  clear(gone: (key: object) => void): void {
    for (const k of this.held.keys()) gone(k);
    this.held.clear();
    this.free.length = 0;
    for (let t = this.tiles; t >= 1; t -= 1) this.free.push(t);
  }

  get size(): number {
    return this.held.size;
  }
}

/** sRGB 8-bit → linear half float, and linear 8-bit → half float. */
const SRGB_HALF = new Uint16Array(256);
const LINEAR_HALF = new Uint16Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_HALF[i] = THREE.DataUtils.toHalfFloat(c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  LINEAR_HALF[i] = THREE.DataUtils.toHalfFloat(c);
}

type Drawable = CanvasImageSource & { width: number; height: number };

/** A texture's image as RGBA bytes at `side`², rows top first as drawn (null: its pixels cannot be read here). */
function pixelsOf(texture: THREE.Texture, side: number): Uint8ClampedArray | null {
  const image = texture.image as (Drawable & { data?: ArrayLike<number> }) | null | undefined;
  if (image === null || image === undefined || (texture as { isCompressedTexture?: boolean }).isCompressedTexture === true) return null;
  const data = image.data;
  if (data !== undefined) {
    // A data texture: RGBA bytes (nearest texel).
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || texture.format !== THREE.RGBAFormat) return null;
    const out = new Uint8ClampedArray(side * side * 4);
    for (let y = 0; y < side; y += 1) {
      const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) / side) * image.height));
      for (let x = 0; x < side; x += 1) {
        const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) / side) * image.width));
        out.set(data.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4), (y * side + x) * 4);
      }
    }
    return out;
  }
  if (typeof OffscreenCanvas === 'undefined' || !(image.width > 0)) return null;
  const ctx = new OffscreenCanvas(side, side).getContext('2d', { willReadFrequently: true });
  if (ctx === null) return null;
  ctx.drawImage(image, 0, 0, side, side);
  return ctx.getImageData(0, 0, side, side).data;
}

/**
 * A cookie's tile as half floats. The light loop reads a tile with its row
 * from the top as the spot's projection's image goes down; three read the
 * map with its texture's rows as uploaded (bottom up where three flipped
 * the image on upload), so a texture three did not flip goes in bottom up.
 */
export function rasterCookie(texture: THREE.Texture): Uint16Array | null {
  const px = pixelsOf(texture, COOKIE_TILE);
  if (px === null) return null;
  const lut = texture.colorSpace === THREE.SRGBColorSpace ? SRGB_HALF : LINEAR_HALF;
  const out = new Uint16Array(COOKIE_TILE * COOKIE_TILE * 4);
  const flip = !texture.flipY;
  for (let y = 0; y < COOKIE_TILE; y += 1) {
    const src = (flip ? COOKIE_TILE - 1 - y : y) * COOKIE_TILE * 4;
    const dst = y * COOKIE_TILE * 4;
    for (let x = 0; x < COOKIE_TILE * 4; x += 4) {
      out[dst + x] = lut[px[src + x]!]!;
      out[dst + x + 1] = lut[px[src + x + 1]!]!;
      out[dst + x + 2] = lut[px[src + x + 2]!]!;
      // Alpha is never read (a cookie tints by its colour, as three's did).
      out[dst + x + 3] = LINEAR_HALF[255]!;
    }
  }
  return out;
}

type GpuQueue = { writeTexture(dst: { texture: unknown; origin: { x: number; y: number } }, data: ArrayBufferView, layout: { bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number }): void };

/** A tile's place in the atlas (texels from the first row). */
function tileOrigin(tile: number): { x: number; y: number } {
  return { x: (tile % COOKIE_COLUMNS) * COOKIE_TILE, y: Math.floor(tile / COOKIE_COLUMNS) * COOKIE_TILE };
}

interface Held {
  tile: number;
  data: Uint16Array | null;
  version: number;
  /** Sent to the renderer's texture. */
  sent: boolean;
}

/** The cookie atlas of one scene: its tiles' contents, and the texture on the renderer drawn. */
export class CookieAtlas {
  private readonly tiles = new CookieTiles();
  private readonly held = new Map<object, Held>();
  private texture: THREE.DataTexture | null = null;
  private renderer: unknown = null;
  private staging: THREE.DataTexture | null = null;
  private readonly warned = new Set<string>();

  /** Spots past the tiles this frame (no cookie drawn). */
  get dropped(): number {
    return this.tiles.dropped;
  }

  /** The atlas on `renderer` for this frame's cookies (null: none wanted, the light tables alone); each request's tile (-1: none). */
  frame(renderer: ClusterUploadRenderer, requests: readonly CookieRequest[], out: Map<THREE.Texture, number>): THREE.DataTexture | null {
    out.clear();
    if (requests.length === 0) {
      if (this.texture !== null) this.dispose();
      return null;
    }
    if (this.renderer !== renderer) this.drop();
    const keyed = requests.map((r) => ({ key: r.texture.source as object, rank: r.rank }));
    const tiles = this.tiles.assign(
      keyed,
      (key, tile) => this.held.set(key, { tile, data: null, version: -1, sent: false }),
      (key) => this.held.delete(key),
    );
    let fresh = false;
    for (const r of requests) {
      const key = r.texture.source as object;
      const h = this.held.get(key);
      const tile = tiles.get(key) ?? -1;
      if (h === undefined || tile < 0) {
        out.set(r.texture, -1);
        continue;
      }
      if (h.version !== r.texture.version) {
        h.version = r.texture.version;
        h.data = rasterCookie(r.texture);
        h.sent = false;
        if (h.data === null) this.warn(r.texture);
      }
      out.set(r.texture, h.data === null ? -1 : tile);
      if (!h.sent) fresh = true;
    }
    if (this.texture === null) this.make(renderer);
    else if (fresh) this.send(renderer);
    return this.texture;
  }

  dispose(): void {
    this.drop();
    this.tiles.clear(() => undefined);
    this.held.clear();
    this.staging?.dispose();
    this.staging = null;
  }

  /** The renderer's texture goes (every tile is sent again to the next one). */
  private drop(): void {
    this.texture?.dispose();
    this.texture = null;
    this.renderer = null;
    for (const h of this.held.values()) h.sent = false;
  }

  /** The texture made on `renderer` with the LTC tables and every held tile; its CPU copy let go once on the GPU. */
  private make(renderer: ClusterUploadRenderer): void {
    const data = new Uint16Array(COOKIE_ATLAS_SIDE * COOKIE_ATLAS_SIDE * 4);
    const ltc = ltcTablesData();
    const ltcRow = 2 * LTC_SIZE * 4;
    for (let y = 0; y < LTC_SIZE; y += 1) data.set(ltc.subarray(y * ltcRow, (y + 1) * ltcRow), y * COOKIE_ATLAS_SIDE * 4);
    for (const h of this.held.values()) {
      if (h.data === null) continue;
      const o = tileOrigin(h.tile);
      for (let y = 0; y < COOKIE_TILE; y += 1) data.set(h.data.subarray(y * COOKIE_TILE * 4, (y + 1) * COOKIE_TILE * 4), ((o.y + y) * COOKIE_ATLAS_SIDE + o.x) * 4);
      h.sent = true;
    }
    const t = new THREE.DataTexture(data, COOKIE_ATLAS_SIDE, COOKIE_ATLAS_SIDE, THREE.RGBAFormat, THREE.HalfFloatType);
    t.name = 'CookieAtlas';
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.flipY = false;
    t.needsUpdate = true;
    renderer.initTexture(t);
    // On the GPU: the 32 MiB copy is not kept (later tiles go up on their own).
    (t.image as { data: Uint16Array | null }).data = null;
    this.texture = t;
    this.renderer = renderer;
  }

  /** The tiles not on the renderer's texture yet, sent. */
  private send(renderer: ClusterUploadRenderer): void {
    const texture = this.texture!;
    for (const h of this.held.values()) {
      if (h.sent || h.data === null) continue;
      h.sent = true;
      const o = tileOrigin(h.tile);
      if (renderer.backend.isWebGLBackend === true) {
        let staging = this.staging;
        if (staging === null) staging = this.staging = new THREE.DataTexture(h.data, COOKIE_TILE, COOKIE_TILE, THREE.RGBAFormat, THREE.HalfFloatType);
        staging.image = { data: h.data, width: COOKIE_TILE, height: COOKIE_TILE } as unknown as typeof staging.image;
        (renderer.backend as unknown as { copyTextureToTexture(s: THREE.Texture, d: THREE.Texture, r: null, at: THREE.Vector2): void }).copyTextureToTexture(staging, texture, null, new THREE.Vector2(o.x, o.y));
      } else {
        const device = renderer.backend.device as { queue: GpuQueue } | undefined;
        const gpu = renderer.backend.get(texture).texture;
        if (device === undefined || gpu === undefined) throw new Error('the cookie atlas is not on the GPU');
        device.queue.writeTexture({ texture: gpu, origin: o }, h.data, { bytesPerRow: COOKIE_TILE * 8, rowsPerImage: COOKIE_TILE }, { width: COOKIE_TILE, height: COOKIE_TILE });
      }
    }
  }

  private warn(texture: THREE.Texture): void {
    const name = texture.name || texture.uuid;
    if (this.warned.has(name)) return;
    this.warned.add(name);
    console.warn(`Spot cookie ${name}: its pixels cannot be read back to draw into the cookie atlas (a GPU-compressed texture?); the spot draws no cookie.`);
  }
}
