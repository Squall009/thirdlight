/**
 * Phase 25.24b: the verified asset reader of a game page (Play's preview;
 * the export can use the same one). Before 25.24 the page read and re-hashed
 * every declared asset of every scene, one at a time, before it mounted. Now:
 *
 * - `startSceneAssets` names the assets the start scenes need (what their
 *   objects reference, through the materials, material functions and
 *   effects they use, the environment and the start scenes' bakes); the page
 *   reads those before the mount, at most ASSET_READS_IN_FLIGHT at a time;
 * - every other asset is read when something asks for it (a scene loaded
 *   later, a texture a material needs, a sound the host plays), through the
 *   same reader.
 *
 * Each asset is read at most once and its bytes are checked against the
 * manifest's length and digest before anyone gets them, as before; a failed
 * check is an `asset_source_invalid` error naming the asset.
 */

/** One manifest asset row (the fields the reader uses). */
export interface DeclaredAssetRow {
  readonly assetId: string;
  readonly version: number;
  readonly path: string;
  readonly kind: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
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
  /** The verified bytes of one declared asset (read once; later calls share the read). */
  bytes(assetId: string, version: number): Promise<ArrayBuffer>;
  /** The same by artifact path; null when the path is not a declared asset. */
  bytesAt(path: string): Promise<ArrayBuffer> | null;
  /** Bytes already read and verified (no read is started). */
  peek(assetId: string, version: number): ArrayBuffer | undefined;
  /**
   * Read `rows` (at most ASSET_READS_IN_FLIGHT at a time with every other
   * read); resolves when all are verified, rejects with the first failure.
   * `onRead` reports the bytes done so far of these rows.
   */
  preload(rows: readonly DeclaredAssetRow[], onRead?: (loadedBytes: number, totalBytes: number) => void): Promise<void>;
  /** Reads started and bytes verified so far. */
  stats(): { reads: number; bytes: number };
}

export function createVerifiedAssetReader(rows: readonly DeclaredAssetRow[], io: AssetReaderIo, opts: { inFlight?: number } = {}): VerifiedAssetReader {
  const limit = Math.max(1, opts.inFlight ?? ASSET_READS_IN_FLIGHT);
  const byKey = new Map(rows.map((r) => [`${r.assetId}@${r.version}`, r]));
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const reads = new Map<string, Promise<ArrayBuffer>>();
  const done = new Map<string, ArrayBuffer>();
  let started = 0;
  let verifiedBytes = 0;
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
  const readRow = (row: DeclaredAssetRow): Promise<ArrayBuffer> => {
    const key = `${row.assetId}@${row.version}`;
    let p = reads.get(key);
    if (p !== undefined) return p;
    started += 1;
    p = slot().then(async () => {
      try {
        let buf: ArrayBuffer;
        try {
          buf = await io.read(row.path);
        } catch (e) {
          throw new AssetReadError(row.assetId, `${row.assetId}: ${e instanceof Error ? e.message : String(e)}`);
        }
        const raw = new Uint8Array(buf);
        if (raw.byteLength !== row.sourceByteLength) throw new AssetReadError(row.assetId, `${row.assetId}: byte length ${raw.byteLength} !== manifest ${row.sourceByteLength}`);
        const digest = await io.sha256Hex(raw);
        if (digest !== row.sourceDigest) throw new AssetReadError(row.assetId, `${row.assetId}: digest ${digest} !== manifest ${row.sourceDigest}`);
        done.set(key, buf);
        verifiedBytes += raw.byteLength;
        return buf;
      } finally {
        release();
      }
    });
    reads.set(key, p);
    // A failed read is not kept: a later ask reads again (the failure is still reported to this one's callers).
    p.catch(() => {
      if (reads.get(key) === p) reads.delete(key);
    });
    return p;
  };
  return {
    bytes(assetId, version) {
      const row = byKey.get(`${assetId}@${version}`);
      if (row === undefined) return Promise.reject(new AssetReadError(assetId, `${assetId} v${version} is not declared in this build`));
      return readRow(row);
    },
    bytesAt(path) {
      const row = byPath.get(path);
      return row === undefined ? null : readRow(row);
    },
    peek(assetId, version) {
      return done.get(`${assetId}@${version}`);
    },
    async preload(list, onRead) {
      const total = list.reduce((s, r) => s + r.sourceByteLength, 0);
      let loaded = 0;
      await Promise.all(
        list.map((r) =>
          readRow(r).then((b) => {
            loaded += b.byteLength;
            onRead?.(loaded, total);
          }),
        ),
      );
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
 * Phase 25.24b: the assets the start scenes need before the first frame —
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
  return src.assets.filter((a) => found.has(a.assetId) && a.kind !== 'audio' && a.kind !== 'music');
}
