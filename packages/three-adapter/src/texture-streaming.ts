/**
 * Texture mip streaming on a game page (Unity's mipmap streaming, Unreal's
 * texture streaming pool, Godot 4.8's streamed textures).
 *
 * A streamed texture is a KTX2 whose file the build cut into parts (the
 * head: metadata and the mip tail; then one part per larger level). The page
 * reads the head first and draws with the tail at once; the levels above
 * are read one at a time as the texture's size on screen asks for them,
 * inside the page's texture budget (`texture-budget.ts` decides which).
 * Streaming is presentation only: nothing here touches the simulation, and
 * what is drawn never feeds back into it.
 *
 * Mechanics, the same for both renderers (three's WebGPURenderer on
 * WebGPU and on WebGL 2):
 *
 * - The transcoder is always given a whole, valid KTX2: the tail as a
 *   smaller texture, a larger level as a one-level file (`buildKtx2Subset`).
 *   Each decoded level is kept (its transcoded GPU data) and the texture's
 *   `mipmaps` is the chain from its largest resident level down.
 * - A change of resident levels is a new GPU texture of the new size: three
 *   allocates a texture's storage once (WebGL 2 `texStorage2D`, WebGPU
 *   `createTexture`) at the size and level count of its first upload, so the
 *   texture is let go on the GPU (its `dispose` event, which also drops the
 *   bind groups that pointed at it) and uploaded again with the new chain.
 *   A base/max-level window over a full-size allocation would keep the
 *   memory the budget is there to save, and WebGPU has no such window.
 * - The decoded texture is shared by every user; users that sample it
 *   their own way draw with a copy (`clone`), and each copy is a GPU texture
 *   of its own in three's WebGPURenderer. A copy of a streamed texture
 *   joins its stream, so every copy changes level together, and the budget
 *   counts each copy.
 * - The level a texture needs is worked out from each visible mesh that
 *   draws with it: the mesh's UV density (UV units per unit of its surface,
 *   measured once per geometry, as Unity's mesh UV distribution metric) with
 *   the texture's size and tiling gives texels per world unit; the camera's
 *   pixels per world unit at the mesh's distance (its bounding sphere's
 *   nearest point) turn that into texels per pixel, and the level is its
 *   base-2 logarithm.
 */
import * as THREE from 'three';
import { buildKtx2Subset, readKtx2Layout, type Ktx2Layout, type Ktx2Range } from '@thirdlight/runtime';

import { decodeKtx2 } from './ktx2';
import { planMipLevels, residentBytes, type MipCandidate } from './texture-budget';

/** One part of a streamed texture's file (the catalog's `mipParts` row). */
export interface MipPartRef {
  readonly offset: number;
  readonly byteLength: number;
  /** Levels (0 = largest) whose data are in it; the first part holds the metadata and the tail. */
  readonly levels: readonly number[];
}

/** Where a streamed texture's parts come from (verified reads of the page's reader). */
export interface StreamSource {
  readonly parts: readonly MipPartRef[];
  /** The verified bytes of part `index`. */
  read(index: number): Promise<Uint8Array>;
}

/** Material user data key: textures a node graph samples (they are not material properties). */
export const SAMPLED_TEXTURES_KEY = 'sampledTextures';

interface Mip {
  readonly data: ArrayBufferView;
  readonly width: number;
  readonly height: number;
}

/** A streamed texture of either kind. */
export type AnyStreamed = StreamedTexture | StreamedDataTexture;

interface TextureStream {
  readonly id: string;
  readonly root: AnyStreamed;
  readonly copies: Set<AnyStreamed>;
  readonly layout: Ktx2Layout;
  readonly source: StreamSource;
  /** The head part's bytes (metadata and tail; a few tens of KiB). */
  readonly head: Uint8Array;
  readonly tail: number;
  readonly levels: (Mip | null)[];
  readonly levelBytes: number[];
  readonly format: THREE.CompressedPixelFormat | THREE.PixelFormat;
  resident: number;
  wanted: number;
  weight: number;
  lastSeen: number;
  loading: number | null;
  closed: boolean;
  /** Drawn by something other than a mesh's material (a sky, a cookie, a lightmap): wanted at full size. */
  pinned: boolean;
  /** A level failed to read or decode: no new load before this time (the page's clock). */
  retryAt: number;
}

/**
 * A decoded KTX2 whose mip levels stream. Its copies (made by `clone`, for
 * users that sample it their own way) belong to the same stream.
 */
export class StreamedTexture extends THREE.CompressedTexture {
  readonly isStreamedTexture = true;
  /** The stream this texture draws from (null once it is let go). */
  stream: TextureStream | null = null;

  override copy(source: THREE.CompressedTexture): this {
    super.copy(source);
    joinStream(this, source);
    return this;
  }

  override dispose(): void {
    leaveStream(this);
    super.dispose();
  }
}

/**
 * A streamed texture the transcoder wrote as plain RGBA (a GPU without a
 * compressed format): the same stream as a `DataTexture`, which both
 * renderers upload as data (a `CompressedTexture` of an uncompressed format
 * they cannot: see `uploadableKtx2Texture`).
 */
export class StreamedDataTexture extends THREE.DataTexture {
  readonly isStreamedTexture = true;
  /** The stream this texture draws from (null once it is let go). */
  stream: TextureStream | null = null;

  override copy(source: THREE.DataTexture): this {
    super.copy(source);
    joinStream(this, source);
    return this;
  }

  override dispose(): void {
    leaveStream(this);
    super.dispose();
  }
}

/** A copy belongs to its source's stream. */
function joinStream(copy: AnyStreamed, source: THREE.Texture): void {
  const stream = (source as Partial<AnyStreamed>).stream ?? null;
  copy.stream = stream;
  if (stream !== null && !stream.closed) stream.copies.add(copy);
}

/** Let a texture go: the root closes its stream; a copy only leaves it. */
function leaveStream(t: AnyStreamed): void {
  const s = t.stream;
  if (s === null) return;
  if (s.root === t) closeStream(s);
  else s.copies.delete(t);
  t.stream = null;
}

function closeStream(s: TextureStream): void {
  s.closed = true;
  s.copies.clear();
  s.levels.fill(null);
}

/** Bytes of one level of a compressed format (4×4 blocks) or of RGBA8 (the transcoder's fallback). */
function levelByteSize(format: THREE.PixelFormat | THREE.CompressedPixelFormat, blockBytes: number, width: number, height: number): number {
  if (format === THREE.RGBAFormat) return width * height * 4;
  return Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes;
}

/** What the streamer reports (resident bytes against the budget, each streamed texture's levels). */
export interface TextureStreamingObservation {
  readonly budgetBytes: number;
  /** Streamed textures (every copy) and `fixedBytes`. */
  readonly residentBytes: number;
  readonly streamedBytes: number;
  /** Textures that do not stream (counted against the budget, never dropped). */
  readonly fixedBytes: number;
  /** The resident bytes are above the budget (the tails and the textures that do not stream alone exceed it). */
  readonly over: boolean;
  readonly loading: number;
  readonly upgrades: number;
  readonly drops: number;
  readonly textures: readonly {
    readonly id: string;
    readonly width: number;
    readonly height: number;
    readonly levels: number;
    readonly tail: number;
    /** The largest level resident (0: full size). */
    readonly resident: number;
    /** The largest level its size on screen asks for (`tail` when not seen). */
    readonly wanted: number;
    readonly copies: number;
    readonly bytes: number;
  }[];
}

export interface TextureStreamerOptions {
  /** The texture budget (bytes). */
  readonly budgetBytes: number;
  /**
   * Bytes of every decoded texture of the page, streamed ones counted once
   * at their resident size (the resource manager's `texture` total, kept in
   * step through `onResize`, and the images inside model files); what is not
   * the streamer's own is fixed.
   */
  readonly textureBytes?: () => number;
  /** A streamed texture's resident bytes (one copy) changed (the resource manager's entry). */
  readonly onResize?: (id: string, texture: AnyStreamed, bytes: number) => void;
  /** Something the page draws changed (a level arrived or went): draw a frame. */
  readonly onChange?: () => void;
  /** Level reads and decodes at once. */
  readonly inFlight?: number;
  /** How often the needs are worked out again (ms). */
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export interface TextureStreamer {
  /** Open a streamed texture: reads its head and decodes the tail. */
  open(id: string, source: StreamSource): Promise<AnyStreamed>;
  /**
   * Keep a streamed texture at full size (a user whose need is not a mesh's
   * size on screen: a sky, a light's cookie, a lightmap). It still counts
   * against the budget, first in line.
   */
  pin(texture: THREE.Texture): void;
  /** Work out what the visible meshes need and move towards it (call before drawing a frame). */
  update(scene: THREE.Object3D, camera: THREE.Camera, heightPx: number, force?: boolean): void;
  setBudget(bytes: number): void;
  observe(): TextureStreamingObservation;
  /** Levels loads in flight or waiting (tests wait for them). */
  pending(): number;
  dispose(): void;
}

/** A stream's largest level worth reading: never below 0. */
const clampLevel = (l: number, n: number): number => Math.max(0, Math.min(n - 1, l));

const TRIANGLE_SAMPLES = 4096;
/** After a level failed to read or decode, the texture waits this long before the next try (a lost connection is not hammered). */
const LEVEL_RETRY_MS = 2000;
const uvDensityCache = new WeakMap<THREE.BufferGeometry, Map<number, number>>();

/** UV units per unit of surface (square root of UV area over surface area) of a geometry's UV set. */
function uvDensity(g: THREE.BufferGeometry, channel: number): number {
  let per = uvDensityCache.get(g);
  if (per === undefined) uvDensityCache.set(g, (per = new Map()));
  const known = per.get(channel);
  if (known !== undefined) return known;
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  const uv = g.getAttribute(channel === 0 ? 'uv' : `uv${channel}`) as THREE.BufferAttribute | undefined;
  let density = 0;
  if (pos !== undefined && uv !== undefined && pos.itemSize >= 3) {
    const index = g.index;
    const triangles = Math.floor((index !== null ? index.count : pos.count) / 3);
    const step = Math.max(1, Math.floor(triangles / TRIANGLE_SAMPLES));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let world = 0;
    let tex = 0;
    for (let t = 0; t < triangles; t += step) {
      const i0 = index !== null ? index.getX(t * 3) : t * 3;
      const i1 = index !== null ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index !== null ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      world += b.sub(a).cross(c.sub(a)).length() / 2;
      const u0 = uv.getX(i0);
      const v0 = uv.getY(i0);
      tex += Math.abs((uv.getX(i1) - u0) * (uv.getY(i2) - v0) - (uv.getX(i2) - u0) * (uv.getY(i1) - v0)) / 2;
    }
    density = world > 0 ? Math.sqrt(tex / world) : 0;
  }
  per.set(channel, density);
  return density;
}

/** The streamed textures a material draws with (its texture properties, and what a node graph samples). */
function streamedOf(m: THREE.Material, out: AnyStreamed[]): void {
  for (const v of Object.values(m)) if (isStreamedTexture(v) && v.stream !== null) out.push(v);
  const sampled = (m.userData as Record<string, unknown> | undefined)?.[SAMPLED_TEXTURES_KEY];
  if (Array.isArray(sampled)) for (const v of sampled) if (isStreamedTexture(v) && v.stream !== null) out.push(v);
}

export function createTextureStreamer(options: TextureStreamerOptions): TextureStreamer {
  let budget = Math.max(0, options.budgetBytes);
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const inFlight = Math.max(1, options.inFlight ?? 2);
  const interval = options.intervalMs ?? 100;
  const streams = new Set<TextureStream>();
  let lastUpdate = -Infinity;
  let loads = 0;
  let upgrades = 0;
  let drops = 0;
  let target = new Map<TextureStream, number>();
  let disposed = false;

  const bytesOf = (s: TextureStream, level: number): number => residentBytes({ levelBytes: s.levelBytes, copies: 1 }, level);
  /** Textures that do not stream: the page's texture bytes without the streamed ones. */
  const fixedBytes = (): number => {
    if (options.textureBytes === undefined) return 0;
    let own = 0;
    for (const s of streams) if (!s.closed) own += bytesOf(s, s.resident);
    return Math.max(0, options.textureBytes() - own);
  };
  const copiesOf = (s: TextureStream): number => Math.max(1, s.copies.size);

  /** Every user's texture gets the chain from the resident level down, as a new GPU texture of that size. */
  const apply = (s: TextureStream): void => {
    const mips: Mip[] = [];
    for (let l = s.resident; l < s.levels.length; l++) {
      const m = s.levels[l];
      if (m === null || m === undefined) break;
      mips.push(m);
    }
    const top = mips[0];
    if (top === undefined) return;
    // The source (its image) is shared by the texture and every copy; a data texture's image holds its top level.
    s.root.image = s.root instanceof StreamedDataTexture ? { data: top.data as Uint8Array, width: top.width, height: top.height } : { width: top.width, height: top.height };
    for (const t of [s.root, ...s.copies]) {
      t.mipmaps = mips as unknown as THREE.CompressedTexture['mipmaps'];
      // Let the GPU texture go (and the bind groups using it); the next draw uploads the new chain.
      t.dispatchEvent({ type: 'dispose' });
      t.needsUpdate = true;
    }
    options.onResize?.(s.id, s.root, bytesOf(s, s.resident));
    options.onChange?.();
  };

  const decodeLevels = async (s: TextureStream, first: number, last: number, parts: Map<number, Uint8Array>): Promise<Mip[]> => {
    const read = (range: Ktx2Range): Uint8Array => {
      if (range.offset + range.length <= s.head.length) return s.head.subarray(range.offset, range.offset + range.length);
      for (const [i, bytes] of parts) {
        const p = s.source.parts[i]!;
        if (range.offset >= p.offset && range.offset + range.length <= p.offset + p.byteLength) return bytes.subarray(range.offset - p.offset, range.offset - p.offset + range.length);
      }
      throw new RangeError(`bytes ${range.offset}+${range.length} of ${s.id} are in no part read`);
    };
    const file = buildKtx2Subset(s.layout, first, last, read);
    const t = await decodeKtx2(file);
    try {
      if (t.format !== s.format) throw new Error(`${s.id}: level ${first} transcoded to another format`);
      return (t.mipmaps as unknown as Mip[]).slice(0, last - first + 1);
    } finally {
      t.dispose();
    }
  };

  const partOf = (s: TextureStream, level: number): number => s.source.parts.findIndex((p) => p.levels.includes(level));

  /** Read and decode the next larger level of `s` (one level at a time). */
  const loadNext = (s: TextureStream): void => {
    const level = s.resident - 1;
    if (level < 0 || s.loading !== null || s.closed) return;
    s.loading = level;
    loads += 1;
    const index = partOf(s, level);
    void (async () => {
      try {
        if (index < 0) throw new Error(`${s.id}: no part holds level ${level}`);
        const bytes = await s.source.read(index);
        if (s.closed || disposed) return;
        const [mip] = await decodeLevels(s, level, level, new Map([[index, bytes]]));
        if (s.closed || disposed || mip === undefined) return;
        s.levels[level] = mip;
        // Still wanted at this size (the plan may have moved on while it loaded).
        const t = target.get(s);
        if (t !== undefined && t <= level && s.resident === level + 1) {
          s.resident = level;
          upgrades += 1;
          apply(s);
        } else s.levels[level] = null;
      } catch {
        // A level that cannot be read or decoded leaves the texture as it is (its tail still draws); tried again later.
        s.retryAt = now() + LEVEL_RETRY_MS;
      } finally {
        s.loading = null;
        loads -= 1;
        if (!disposed) pump();
      }
    })();
  };

  /** Start the loads the plan asks for (neediest first), up to the in-flight limit. */
  const pump = (): void => {
    if (loads >= inFlight) return;
    // The texture furthest below what it needs first, then the larger on screen.
    const at = now();
    const waiting = [...target].filter(([s, t]) => !s.closed && s.loading === null && t < s.resident && at >= s.retryAt).sort(([a], [b]) => b.resident - b.wanted - (a.resident - a.wanted) || b.weight - a.weight);
    for (const [s] of waiting) {
      if (loads >= inFlight) break;
      loadNext(s);
    }
  };

  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const camPos = new THREE.Vector3();
  const found: AnyStreamed[] = [];

  const plan = (): void => {
    const candidates: MipCandidate[] = [];
    const byId = new Map<string, TextureStream>();
    let i = 0;
    for (const s of streams) {
      const id = `${i++}`;
      byId.set(id, s);
      candidates.push({ id, levelBytes: s.levelBytes, tail: s.tail, resident: s.resident, wanted: s.wanted, copies: copiesOf(s), weight: s.weight });
    }
    const p = planMipLevels(candidates, budget, fixedBytes());
    target = new Map();
    for (const [id, t] of p.target) target.set(byId.get(id)!, t);
    // Drops at once (the budget holds before any load lands); loads one level at a time.
    for (const [s, t] of target) {
      if (t <= s.resident) continue;
      for (let l = s.resident; l < t; l++) s.levels[l] = null;
      s.resident = t;
      drops += 1;
      apply(s);
    }
    pump();
  };

  return {
    async open(id, source) {
      if (disposed) throw new Error('the texture streamer is closed');
      const headPart = source.parts[0];
      const last = source.parts[source.parts.length - 1];
      if (headPart === undefined || last === undefined) throw new Error(`${id}: a streamed texture has no parts`);
      const head = await source.read(0);
      const fileLength = last.offset + last.byteLength;
      const r = readKtx2Layout(head, fileLength);
      if (!r.ok) throw new Error(`${id}: ${r.message}`);
      const layout = r.layout;
      const n = layout.levels.length;
      const tail = Math.min(...headPart.levels);
      if (!(tail >= 1 && tail < n)) throw new Error(`${id}: its head holds no mip tail`);
      const decoded = await decodeKtx2(buildKtx2Subset(layout, tail, n - 1, (range) => head.subarray(range.offset, range.offset + range.length)));
      const mips = decoded.mipmaps as unknown as Mip[];
      const top = mips[0];
      if (top === undefined) throw new Error(`${id}: its tail decoded to nothing`);
      const blocks = Math.ceil(top.width / 4) * Math.ceil(top.height / 4);
      const blockBytes = blocks > 0 ? top.data.byteLength / blocks : 16;
      const levels: (Mip | null)[] = new Array<Mip | null>(n).fill(null);
      const levelBytes: number[] = [];
      for (let l = 0; l < n; l++) {
        if (l >= tail) {
          levels[l] = mips[l - tail] ?? null;
          levelBytes.push(mips[l - tail]?.data.byteLength ?? 0);
        } else levelBytes.push(levelByteSize(decoded.format, blockBytes, Math.max(1, layout.width >>> l), Math.max(1, (layout.height || 1) >>> l)));
      }
      // Plain RGBA (no compressed format on this GPU) streams as data; anything else as compressed levels.
      const root: AnyStreamed =
        (decoded.format as number) === THREE.RGBAFormat
          ? new StreamedDataTexture(top.data as Uint8Array, top.width, top.height, THREE.RGBAFormat, decoded.type)
          : new StreamedTexture(mips as unknown as THREE.CompressedTexture['mipmaps'], top.width, top.height, decoded.format as THREE.CompressedPixelFormat, decoded.type);
      root.mipmaps = mips as unknown as THREE.CompressedTexture['mipmaps'];
      root.colorSpace = decoded.colorSpace;
      root.premultiplyAlpha = decoded.premultiplyAlpha;
      root.minFilter = decoded.minFilter;
      root.magFilter = decoded.magFilter;
      root.generateMipmaps = false;
      root.flipY = false;
      root.needsUpdate = true;
      decoded.dispose();
      const stream: TextureStream = {
        id,
        root,
        copies: new Set(),
        layout,
        source,
        head,
        tail,
        levels,
        levelBytes,
        format: decoded.format,
        resident: tail,
        wanted: tail,
        weight: 0,
        lastSeen: now(),
        loading: null,
        closed: false,
        pinned: false,
        retryAt: 0,
      };
      root.stream = stream;
      streams.add(stream);
      return root;
    },

    update(scene, camera, heightPx, force = false) {
      if (disposed) return;
      for (const s of [...streams]) if (s.closed) streams.delete(s);
      if (streams.size === 0) return;
      const t = now();
      if (!force && t - lastUpdate < interval) return;
      lastUpdate = t;
      for (const s of streams) {
        s.wanted = s.pinned ? 0 : s.tail;
        s.weight = s.pinned ? Number.MAX_SAFE_INTEGER : -1 - (t - s.lastSeen) / 1000;
      }
      // World matrices as the draw will see them: an object added or moved this
      // frame still holds its old (or identity) matrix until the renderer's own
      // update, and a stale one measures it at the wrong distance — a far
      // object placed at the origin asks for a large level it will keep.
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreen, camera.coordinateSystem, camera.reversedDepth);
      camPos.setFromMatrixPosition(camera.matrixWorld);
      const persp = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true ? (camera as THREE.PerspectiveCamera) : null;
      const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true ? (camera as THREE.OrthographicCamera) : null;
      const h = Math.max(1, heightPx);
      scene.traverseVisible((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh !== true || mesh.material === undefined) return;
        found.length = 0;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) streamedOf(m, found);
        if (found.length === 0) return;
        const g = mesh.geometry;
        const bounds = (mesh as { boundingSphere?: THREE.Sphere | null }).boundingSphere ?? (g.boundingSphere ?? (g.computeBoundingSphere(), g.boundingSphere));
        if (bounds === null || bounds === undefined) return;
        sphere.copy(bounds).applyMatrix4(mesh.matrixWorld);
        if (!frustum.intersectsSphere(sphere)) return;
        const dist = Math.max(persp?.near ?? 0.01, camPos.distanceTo(sphere.center) - sphere.radius, 1e-4);
        const pxPerWorld = persp !== null ? h / (2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) : ortho !== null ? (h * ortho.zoom) / Math.max(1e-6, ortho.top - ortho.bottom) : h / dist;
        const scale = Math.max(1e-6, mesh.matrixWorld.getMaxScaleOnAxis());
        const radiusPx = sphere.radius * pxPerWorld;
        for (const tex of found) {
          const s = tex.stream!;
          const density = uvDensity(g, tex.channel);
          if (density <= 0) continue;
          const repeat = Math.max(Math.abs(tex.repeat.x), Math.abs(tex.repeat.y), 1e-6);
          const texelsPerWorld = (Math.max(s.layout.width, s.layout.height || 1) * density * repeat) / scale;
          const ratio = texelsPerWorld / pxPerWorld;
          const level = clampLevel(Math.floor(Math.log2(Math.max(1, ratio))), s.levels.length);
          s.wanted = Math.min(s.wanted, level);
          s.weight = Math.max(s.weight, radiusPx);
          s.lastSeen = t;
        }
      });
      plan();
    },

    pin(texture) {
      const s = isStreamedTexture(texture) ? texture.stream : null;
      if (s === null || s.closed) return;
      s.pinned = true;
      lastUpdate = -Infinity;
    },

    setBudget(bytes) {
      budget = Math.max(0, bytes);
      lastUpdate = -Infinity;
    },

    observe() {
      let streamed = 0;
      const textures = [...streams]
        .filter((s) => !s.closed)
        .map((s) => {
          const bytes = bytesOf(s, s.resident) * copiesOf(s);
          streamed += bytes;
          return { id: s.id, width: s.layout.width, height: s.layout.height || 1, levels: s.levels.length, tail: s.tail, resident: s.resident, wanted: s.wanted, copies: copiesOf(s), bytes };
        });
      const fixed = fixedBytes();
      return { budgetBytes: budget, residentBytes: streamed + fixed, streamedBytes: streamed, fixedBytes: fixed, over: streamed + fixed > budget, loading: loads, upgrades, drops, textures };
    },

    pending() {
      let n = loads;
      for (const [s, t] of target) if (!s.closed && t < s.resident && s.loading === null) n += 1;
      return n;
    },

    dispose() {
      disposed = true;
      for (const s of streams) closeStream(s);
      streams.clear();
      target.clear();
    },
  };
}

/** Whether a texture is a streamed one (its size changes as levels stream). */
export function isStreamedTexture(t: unknown): t is StreamedTexture | StreamedDataTexture {
  return t instanceof StreamedTexture || t instanceof StreamedDataTexture;
}
