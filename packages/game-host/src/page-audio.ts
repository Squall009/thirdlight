/**
 * What a game page tells its audio owner and host about the build's audio
 * files, from the catalog: each file's load settings and verified bytes
 * (and, to stream it, its URL), and which files a scene or the
 * project-wide blocks name with their preload setting.
 *
 * A file whose row carries no load settings (a build from before they
 * existed) is decoded on load and preloaded, as such builds played.
 */
import type { AudioAssetSource, AudioLoadType } from './audio-loading';
import type { AudioRow } from './host-audio';
import type { CatalogRow, RuntimeCatalog } from './runtime-content';

const LOAD_TYPES: readonly string[] = ['decode-on-load', 'decode-while-playing', 'stream'];

const loadTypeOf = (r: CatalogRow): AudioLoadType => (typeof r['loadType'] === 'string' && LOAD_TYPES.includes(r['loadType']) ? (r['loadType'] as AudioLoadType) : 'decode-on-load');
const rowOf = (r: CatalogRow): AudioRow => ({ assetId: r.assetId, preload: r['preload'] !== false });
const audioRows = (rows: readonly CatalogRow[]): AudioRow[] => {
  const out = new Map<string, AudioRow>();
  for (const r of rows) if (r.kind === 'audio') out.set(r.assetId, rowOf(r));
  return [...out.values()];
};

export interface PageAudio {
  /** The audio owner's `source`. */
  source(assetId: string): Promise<AudioAssetSource | undefined>;
  /** The host's `sceneAudio`. */
  sceneAudio(sceneId: string): Promise<readonly AudioRow[]>;
  /** The host's `projectAudio`. */
  projectAudio(): Promise<readonly AudioRow[]>;
}

export function pageAudio(o: {
  readonly catalog: RuntimeCatalog;
  /** The verified bytes of one asset version (read for the caller, held by no one after). */
  readonly bytes: (assetId: string, version: number) => Promise<ArrayBuffer>;
  /** A catalog path's URL (absent: streamed files are read whole and decoded when played). */
  readonly assetUrl?: (path: string) => string;
}): PageAudio {
  return {
    async source(assetId) {
      const row = await o.catalog.lookup(assetId);
      if (row === undefined || row.kind !== 'audio') return undefined;
      const loadType = loadTypeOf(row);
      return {
        loadType,
        preload: row['preload'] !== false,
        read: () => o.bytes(row.assetId, row.version).then((b) => new Uint8Array(b)),
        // A stream is the one read that is not hashed before it is heard: the element plays what arrives.
        ...(loadType === 'stream' && o.assetUrl !== undefined ? { url: o.assetUrl(row.path) } : {}),
      };
    },
    async sceneAudio(sceneId) {
      const rows = await (o.catalog.sceneEntries(sceneId) ?? Promise.resolve([] as readonly CatalogRow[]));
      return audioRows(rows);
    },
    async projectAudio() {
      return audioRows(o.catalog.shared());
    },
  };
}
