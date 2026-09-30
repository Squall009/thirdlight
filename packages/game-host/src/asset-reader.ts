/**
 * The verified asset reader of a game page (Play's preview;
 * the export can use the same one). The page does not read every declared
 * asset before it mounts:
 *
 * - `startSceneAssets` names the assets the start scenes need (what their
 *   objects reference, through the materials, material functions and
 *   effects they use, the environment and the start scenes' bakes); the page
 *   reads those before the mount, at most ASSET_READS_IN_FLIGHT at a time;
 * - every other asset is read when something asks for it (a scene loaded
 *   later, a texture a material needs, a sound the host plays), through the
 *   same reader.
 *
 * The bytes are the resource manager's `bytes` kind: read once while
 * anyone holds them (a scene being prepared, the start, a decoder until it
 * has them) and freed when no one does; asked for again later, they are read
 * again (the HTTP cache has them). They are checked against the manifest's
 * length and digest before anyone gets them; a failed check is an
 * `asset_source_invalid` error naming the asset.
 */
import { assetVersionKey, createResourceManager, type LoadedResource, type ResourceManager } from '@thirdlight/runtime';

/** One manifest asset row (the fields the reader uses). */
export interface DeclaredAssetRow {
  readonly assetId: string;
  readonly version: number;
  readonly path: string;
  readonly kind: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
}

/** One part of a streamed texture's file, as the catalog row lists it (`mipParts`). */
export interface MipPartRow {
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
  /** Where the part starts in the whole file. */
  readonly offset: number;
  /** Mip levels (0 = largest) whose data are in it. */
  readonly levels: readonly number[];
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * A texture row's streaming parts, checked (contiguous from 0, together the
 * whole file, each at its digest path); null when the row has none or they
 * are malformed (the texture is then read whole).
 */
export function mipPartsOf(row: DeclaredAssetRow): MipPartRow[] | null {
  const raw = (row as unknown as { mipParts?: unknown }).mipParts;
  if (!Array.isArray(raw) || raw.length < 2 || row.kind !== 'texture') return null;
  const out: MipPartRow[] = [];
  let at = 0;
  for (const p of raw as Record<string, unknown>[]) {
    if (typeof p !== 'object' || p === null) return null;
    const { path, digest, byteLength, offset, levels } = p;
    if (typeof digest !== 'string' || !DIGEST_RE.test(digest) || path !== `content/sha256/${digest}`) return null;
    if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength < 1 || offset !== at) return null;
    if (!Array.isArray(levels) || levels.length === 0 || !levels.every((l) => typeof l === 'number' && Number.isInteger(l) && l >= 0 && l < 32)) return null;
    out.push({ path, digest, byteLength, offset: at, levels: [...(levels as number[])] });
    at += byteLength;
  }
  return at === row.sourceByteLength ? out : null;
}

export interface AssetReaderIo {
  /** Read one manifest-declared relative path. */
  readonly read: (path: string) => Promise<ArrayBuffer>;
  readonly sha256Hex: (bytes: Uint8Array) => Promise<string>;
}

/**
 * Reads in flight at once: enough to keep a local or LAN connection busy
 * (browsers allow 6 per HTTP/1.1 host, and hashing overlaps the transfer)
 * without queuing every file of a large project at the same moment.
 */
export const ASSET_READS_IN_FLIGHT = 8;

/** A declared asset whose bytes do not match the manifest (or could not be read). */
export class AssetReadError extends Error {
  readonly code = 'asset_source_invalid';
  readonly assetId: string;
  constructor(assetId: string, message: string) {
    super(message);
    this.assetId = assetId;
  }
}

export interface VerifiedAssetReader {
  /**
   * The verified bytes of one declared asset, read once while anyone holds
   * them. With a `holder` they stay held for it until `release(holder)`;
   * without one they are handed over and held no longer (a decoder that
   * keeps what it made from them needs nothing more).
   */
  bytes(assetId: string, version: number, holder?: string): Promise<ArrayBuffer>;
  /**
   * The verified bytes of part `index` of a streamed texture (`mipPartsOf`),
   * read once while anyone holds them; without a `holder` handed over.
   */
  part(row: DeclaredAssetRow, index: number, holder?: string): Promise<Uint8Array>;
  /** The same by artifact path; null when the path is not a declared asset. */
  bytesAt(path: string, holder?: string): Promise<ArrayBuffer> | null;
  /** Bytes read, verified and still held (no read is started). */
  peek(assetId: string, version: number): ArrayBuffer | undefined;
  /**
   * Read `rows` (at most ASSET_READS_IN_FLIGHT at a time with every other
   * read) and hold them for `holder` until `release(holder)`; resolves when
   * all are verified, rejects with the first failure. `onRead` reports the
   * bytes done so far of these rows.
   */
  preload(rows: readonly DeclaredAssetRow[], onRead?: (loadedBytes: number, totalBytes: number) => void, holder?: string): Promise<void>;
  /** Let go of the bytes `holder` holds. */
  release(holder: string): void;
  /** Reads started and bytes verified so far. */
  stats(): { reads: number; bytes: number };
}

/** Where a reader finds a row it was not given (the page's catalog: rows read so far, and the shard reads). */
export interface AssetRowSource {
  row(assetId: string, version?: number): DeclaredAssetRow | undefined;
  rowAt(path: string): DeclaredAssetRow | undefined;
  lookup(assetId: string): Promise<DeclaredAssetRow | undefined>;
}

/** The holder `preload` holds for when the caller names none. */
export const PRELOAD_HOLDER = 'preload';

export function createVerifiedAssetReader(rows: readonly DeclaredAssetRow[], io: AssetReaderIo, opts: { inFlight?: number; catalog?: AssetRowSource; resources?: ResourceManager } = {}): VerifiedAssetReader {
  const limit = Math.max(1, opts.inFlight ?? ASSET_READS_IN_FLIGHT);
  const catalog = opts.catalog;
  // The bytes live in the page's resource manager (kind `bytes`), freed once no one holds them.
  const resources = opts.resources ?? createResourceManager({ schedule: (run) => queueMicrotask(run) });
  const byKey = new Map(rows.map((r) => [`${r.assetId}@${r.version}`, r]));
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const holderOf = (holder: string): string => `reader/${holder}`;
  let started = 0;
  let verifiedBytes = 0;
  let transient = 0;
  // A small limiter: a read waits for a slot, holds it while it reads and hashes.
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next !== undefined) next();
    else active -= 1;
  };
  /** One file read and checked against its length and digest. */
  const verifiedFile = async (assetId: string, path: string, byteLength: number, expected: string): Promise<ArrayBuffer> => {
    started += 1;
    await slot();
    try {
      let buf: ArrayBuffer;
      try {
        buf = await io.read(path);
      } catch (e) {
        throw new AssetReadError(assetId, `${assetId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const raw = new Uint8Array(buf);
      if (raw.byteLength !== byteLength) throw new AssetReadError(assetId, `${assetId}: byte length ${raw.byteLength} !== manifest ${byteLength}`);
      const digest = await io.sha256Hex(raw);
      if (digest !== expected) throw new AssetReadError(assetId, `${assetId}: digest ${digest} !== manifest ${expected}`);
      verifiedBytes += raw.byteLength;
      return buf;
    } finally {
      release();
    }
  };
  const verifiedRead = (row: DeclaredAssetRow) => async (): Promise<LoadedResource<ArrayBuffer>> => {
    const parts = mipPartsOf(row);
    if (parts === null) {
      const buf = await verifiedFile(row.assetId, row.path, row.sourceByteLength, row.sourceDigest);
      return { value: buf, bytes: buf.byteLength };
    }
    // A streamed texture ships as its parts only: the whole file is their concatenation, checked again as one.
    const whole = new Uint8Array(row.sourceByteLength);
    for (const p of parts) whole.set(new Uint8Array(await verifiedFile(row.assetId, p.path, p.byteLength, p.digest)), p.offset);
    const digest = await io.sha256Hex(whole);
    if (digest !== row.sourceDigest) throw new AssetReadError(row.assetId, `${row.assetId}: digest ${digest} !== manifest ${row.sourceDigest}`);
    return { value: whole.buffer, bytes: whole.byteLength };
  };
  /** A streamed texture's part, held by digest (two textures with the same file share it). */
  const readPart = (row: DeclaredAssetRow, index: number, holder: string | undefined): Promise<Uint8Array> => {
    const p = mipPartsOf(row)?.[index];
    if (p === undefined) return Promise.reject(new AssetReadError(row.assetId, `${row.assetId} has no streaming part ${index}`));
    const key = `sha256:${p.digest}`;
    const load = async (): Promise<LoadedResource<ArrayBuffer>> => {
      const buf = await verifiedFile(row.assetId, p.path, p.byteLength, p.digest);
      return { value: buf, bytes: buf.byteLength };
    };
    if (holder !== undefined) return resources.acquire<ArrayBuffer>('bytes', key, holderOf(holder), load).then((b) => new Uint8Array(b));
    transient += 1;
    const h = holderOf(`read:${transient}`);
    return resources
      .acquire<ArrayBuffer>('bytes', key, h, load)
      .then((b) => new Uint8Array(b))
      .finally(() => resources.release('bytes', key, h));
  };
  /** Hold one row's bytes for `holder` (a failed read is forgotten: a later ask reads again). */
  const readRow = (row: DeclaredAssetRow, holder: string | undefined): Promise<ArrayBuffer> => {
    const key = assetVersionKey(row.assetId, row.version);
    if (holder !== undefined) return resources.acquire('bytes', key, holderOf(holder), verifiedRead(row));
    // Handed over: held only until the caller has them.
    transient += 1;
    const h = holderOf(`read:${transient}`);
    const p = resources.acquire('bytes', key, h, verifiedRead(row));
    return p.finally(() => resources.release('bytes', key, h));
  };
  return {
    bytes(assetId, version, holder) {
      const row = byKey.get(`${assetId}@${version}`) ?? catalog?.row(assetId, version);
      if (row !== undefined) return readRow(row, holder);
      const missing = (): AssetReadError => new AssetReadError(assetId, `${assetId} v${version} is not declared in this build`);
      if (catalog === undefined) return Promise.reject(missing());
      // A row no read so far had: its catalog shard names it (or the build does not have it).
      return catalog.lookup(assetId).then(() => {
        const found = catalog.row(assetId, version);
        if (found === undefined) throw missing();
        return readRow(found, holder);
      });
    },
    part(row, index, holder) {
      return readPart(row, index, holder);
    },
    bytesAt(path, holder) {
      const row = byPath.get(path) ?? catalog?.rowAt(path);
      return row === undefined ? null : readRow(row, holder);
    },
    peek(assetId, version) {
      return resources.peek<ArrayBuffer>('bytes', assetVersionKey(assetId, version));
    },
    async preload(list, onRead, holder = PRELOAD_HOLDER) {
      // A streamed texture's start is its head (metadata and mip tail); its larger levels stream later.
      const sizeOf = (r: DeclaredAssetRow): number => mipPartsOf(r)?.[0]?.byteLength ?? r.sourceByteLength;
      const total = list.reduce((s, r) => s + sizeOf(r), 0);
      let loaded = 0;
      await Promise.all(
        list.map((r) =>
          (mipPartsOf(r) !== null ? readPart(r, 0, holder) : readRow(r, holder)).then((b) => {
            loaded += b.byteLength;
            onRead?.(loaded, total);
          }),
        ),
      );
    },
    release(holder) {
      resources.releaseHolder(holderOf(holder));
    },
    stats() {
      return { reads: started, bytes: verifiedBytes };
    },
  };
}

/** What `startSceneAssets` reads from the manifest (any other key is ignored). */
export interface StartAssetSources {
  readonly assets: readonly DeclaredAssetRow[];
  /** The start scenes' objects (the runtime snapshot's scene). */
  readonly entities: readonly unknown[];
  /** The start scenes' ids (their bakes are read; absent: every bake). */
  readonly startSceneIds?: readonly string[];
  readonly materials?: readonly unknown[];
  readonly materialFunctions?: readonly unknown[];
  readonly effects?: readonly unknown[];
  readonly environment?: unknown;
  readonly lighting?: Readonly<Record<string, unknown>>;
}

/**
 * The assets the start scenes need before the first frame —
 * every declared asset id their objects name, directly or through the
 * materials (a model's own material map too), material functions and effects
 * they use; the environment's (sky, presets); and the start scenes' bakes.
 * Sounds are left to the host, which reads them when it plays them. A name
 * this misses is not an error: that asset is read when it is asked for.
 */
export function startSceneAssets(src: StartAssetSources): DeclaredAssetRow[] {
  const assetIds = new Set(src.assets.map((a) => a.assetId));
  const idOf = (v: unknown, key: string): string | undefined => {
    const id = (v as Record<string, unknown> | null)?.[key];
    return typeof id === 'string' ? id : undefined;
  };
  const materials = new Map<string, unknown>();
  for (const m of src.materials ?? []) {
    const id = idOf(m, 'materialId');
    if (id !== undefined) materials.set(id, m);
  }
  const functions = new Map<string, unknown>();
  for (const f of src.materialFunctions ?? []) {
    const id = idOf(f, 'graphId');
    if (id !== undefined) functions.set(id, f);
  }
  const effects = new Map<string, unknown>();
  for (const f of src.effects ?? []) {
    const id = idOf(f, 'effectId');
    if (id !== undefined) effects.set(id, f);
  }
  const found = new Set<string>();
  const queued = new Set<unknown>();
  const queue: unknown[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) return;
    if (typeof value === 'string') {
      if (assetIds.has(value)) found.add(value);
      for (const table of [materials, functions, effects]) {
        const def = table.get(value);
        if (def !== undefined && !queued.has(def)) {
          queued.add(def);
          queue.push(def);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    if (typeof value === 'object' && value !== null) for (const v of Object.values(value)) visit(v, depth + 1);
  };
  visit(src.entities, 0);
  visit(src.environment, 0);
  const lighting = src.lighting ?? {};
  const bakeKeys = src.startSceneIds !== undefined && src.startSceneIds.some((id) => id in lighting) ? src.startSceneIds.filter((id) => id in lighting) : Object.keys(lighting);
  for (const k of bakeKeys) visit(lighting[k], 0);
  // A model's own material map (by the model's asset row) is followed once the model is found.
  const followModels = (): void => {
    for (const row of src.assets) {
      if (row.kind !== 'model' || !found.has(row.assetId)) continue;
      const map = (row as { materials?: unknown }).materials;
      if (map !== undefined && !queued.has(map)) {
        queued.add(map);
        queue.push(map);
      }
    }
  };
  followModels();
  while (queue.length > 0) {
    visit(queue.shift(), 0);
    if (queue.length === 0) followModels();
  }
  return src.assets.filter((a) => found.has(a.assetId) && a.kind !== 'audio');
}
