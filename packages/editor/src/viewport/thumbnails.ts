/**
 * Asset tile thumbnails, from the import cache (`cache/imported/<digest>/
 * thumbnails/`): drawing a tile reads its small PNG and nothing else — never
 * a texture's own bytes, never a model file. Where the cache has none:
 *
 * - a texture's is made by the backend from its image (the PNG/JPEG, or the
 *   image a KTX2 was encoded from) when the tile asks for it;
 * - a model's is drawn in the editor worker (model-thumbnail.ts: the file is
 *   parsed and drawn off the page) and stored in the cache, with one per
 *   piece for a file of several; files wait in a queue, the newest tile
 *   first, and a tile that scrolled away is dropped from it.
 *
 * Object URLs are kept for the tiles on screen and a few hundred more; the
 * rest are revoked, so scrolling a large catalog does not keep every picture.
 *
 * Browser-only.
 */
import { ASSET_THUMBNAIL_EDGE } from '@thirdlight/project-model/limits';
import type { RendererPreference, RendererPreferenceSource, VertexColorMode } from '@thirdlight/three-adapter';

import { editorWorkers } from '../workers/editor-workers';
import { renderModelThumbnails } from '../workers/model-thumbnail';

/** Thumbnail edge in pixels (tiles show it at half size on HiDPI screens). */
export const THUMBNAIL_SIZE = ASSET_THUMBNAIL_EDGE;

/** Object URLs kept for tiles that are not on screen (the ones on screen are always kept). */
const KEPT_URLS = 512;

export interface ThumbnailSource {
  /** The cached PNG (null: none); with `make`, the backend makes a texture's from its image first. */
  read(digest: string, piece: string | null, make?: { asset: string }): Promise<Blob | null>;
  store(digest: string, piece: string | null, png: Uint8Array): Promise<void>;
  /** A model file's bytes (to draw its thumbnails off the page). */
  modelBytes(assetId: string, version: number): Promise<Uint8Array>;
  vertexColorsFor(assetId: string): VertexColorMode;
  renderer(): { preference: RendererPreference; source: RendererPreferenceSource };
}

/** What a tile shows: an asset version (and one of its pieces). */
export interface TileRef {
  readonly assetId: string;
  readonly kind: string;
  readonly version: number;
  readonly digest: string;
  readonly piece: string | null;
}

interface Entry {
  url: Promise<string | null>;
  resolved: string | null;
  /** Tiles showing it now. */
  users: number;
  lastUsed: number;
}

interface ModelJob {
  ref: TileRef;
  resolve: (ok: boolean) => void;
}

export class TileThumbnails {
  private readonly entries = new Map<string, Entry>();
  private readonly modelJobs = new Map<string, ModelJob>();
  /** Tiles on screen per asset version (0: none; a model job for it is dropped). */
  private readonly onScreen = new Map<string, number>();
  private queue: string[] = [];
  private running = false;
  private disposed = false;
  private clock = 0;
  /** Model files drawn and PNGs made by the backend (tests and the bench read them). */
  readonly stats = { modelsDrawn: 0, cacheReads: 0 };

  constructor(private readonly source: ThumbnailSource) {}

  /** The tile's picture URL (null: none, the tile keeps its icon); `hold` it while the tile is on screen. */
  url(ref: TileRef): Promise<string | null> {
    const key = `${ref.digest}|${ref.piece ?? ''}`;
    let e = this.entries.get(key);
    if (e === undefined) {
      const entry: Entry = { url: Promise.resolve(null), resolved: null, users: 0, lastUsed: ++this.clock };
      entry.url = this.load(ref).then((u) => {
        entry.resolved = u;
        return u;
      });
      this.entries.set(key, entry);
      e = entry;
    }
    e.lastUsed = ++this.clock;
    return e.url;
  }

  /** A tile shows this picture (its URL is kept while held). */
  hold(ref: TileRef): () => void {
    const key = `${ref.digest}|${ref.piece ?? ''}`;
    const e = this.entries.get(key);
    if (e !== undefined) e.users += 1;
    this.onScreen.set(ref.digest, (this.onScreen.get(ref.digest) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const now = this.entries.get(key);
      if (now !== undefined) {
        now.users = Math.max(0, now.users - 1);
        now.lastUsed = ++this.clock;
      }
      const n = (this.onScreen.get(ref.digest) ?? 1) - 1;
      if (n <= 0) this.onScreen.delete(ref.digest);
      else this.onScreen.set(ref.digest, n);
      this.trim();
    };
  }

  private async load(ref: TileRef): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/.test(ref.digest) || (ref.kind !== 'model' && ref.kind !== 'texture')) return null;
    try {
      this.stats.cacheReads += 1;
      const cached = await this.source.read(ref.digest, ref.piece, ref.kind === 'texture' && ref.piece === null ? { asset: ref.assetId } : undefined);
      if (cached !== null) return this.disposed ? null : URL.createObjectURL(cached);
    } catch {
      return null;
    }
    if (ref.kind !== 'model') return null;
    // Not cached: draw the file (and its pieces) off the page, then read what was stored.
    if (!(await this.drawModel(ref))) return null;
    try {
      const made = await this.source.read(ref.digest, ref.piece);
      return made === null || this.disposed ? null : URL.createObjectURL(made);
    } catch {
      return null;
    }
  }

  private drawModel(ref: TileRef): Promise<boolean> {
    const running = this.modelJobs.get(ref.digest);
    if (running !== undefined) {
      // A newer ask goes first.
      this.queue = [ref.digest, ...this.queue.filter((d) => d !== ref.digest)];
      return new Promise((resolve) => {
        const prev = running.resolve;
        running.resolve = (ok) => {
          prev(ok);
          resolve(ok);
        };
      });
    }
    return new Promise((resolve) => {
      this.modelJobs.set(ref.digest, { ref: { ...ref, piece: null }, resolve });
      this.queue.unshift(ref.digest);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let digest = this.queue.shift(); digest !== undefined; digest = this.queue.shift()) {
        const job = this.modelJobs.get(digest);
        if (job === undefined) continue;
        // A tile that scrolled away before its turn is not drawn (it asks again when it is back).
        if ((this.onScreen.get(digest) ?? 0) <= 0 || this.disposed) {
          this.modelJobs.delete(digest);
          this.forget(digest);
          job.resolve(false);
          continue;
        }
        let ok = false;
        try {
          ok = await this.drawAndStore(job.ref);
        } catch {
          ok = false;
        }
        this.modelJobs.delete(digest);
        job.resolve(ok);
      }
    } finally {
      this.running = false;
    }
  }

  private async drawAndStore(ref: TileRef): Promise<boolean> {
    const bytes = await this.source.modelBytes(ref.assetId, ref.version);
    const input = { bytes, assetId: ref.assetId, version: ref.version, digest: ref.digest, vertexColors: this.source.vertexColorsFor(ref.assetId), renderer: this.source.renderer() };
    const out = await editorWorkers().run(
      'modelThumbnail',
      () => {
        const copy = bytes.slice();
        return { input: { ...input, bytes: copy }, transfer: [copy.buffer] };
      },
      { lane: 'thumbnails', inline: () => renderModelThumbnails(input) },
    );
    if (out.file === null) return false;
    this.stats.modelsDrawn += 1;
    await this.source.store(ref.digest, null, out.file);
    for (const p of out.pieces) await this.source.store(ref.digest, p.name, p.png);
    return true;
  }

  /** Forget the entries of a digest that were never made (asked again later, they load again). */
  private forget(digest: string): void {
    for (const [key, e] of this.entries) if (key.startsWith(`${digest}|`) && e.resolved === null && e.users === 0) this.entries.delete(key);
  }

  /** Revoke the least recently shown URLs beyond `KEPT_URLS` that no tile shows. */
  private trim(): void {
    if (this.entries.size <= KEPT_URLS) return;
    const idle = [...this.entries].filter(([, e]) => e.users === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, e] of idle.slice(0, this.entries.size - KEPT_URLS)) {
      this.entries.delete(key);
      void e.url.then((u) => {
        if (u !== null) URL.revokeObjectURL(u);
      });
    }
  }

  /** How many picture URLs are kept (the bench reads it). */
  get kept(): number {
    return this.entries.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) void e.url.then((u) => u !== null && URL.revokeObjectURL(u));
    this.entries.clear();
    for (const j of this.modelJobs.values()) j.resolve(false);
    this.modelJobs.clear();
    this.queue = [];
  }
}
