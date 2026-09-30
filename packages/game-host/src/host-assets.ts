/**
 * What the game host loads from assets, and the resource manager it is held
 * in.
 *
 * The page gives the host its resource manager (the same one the verified
 * reader, the scene adapter, the audio owner and the UI layer hold their
 * resources in); the host settles it after each frame, once the step's scene
 * changes are drawn, and reports what is resident. The host itself loads:
 *
 * - the input glyph images (object URLs, held until the host is disposed);
 * - the audio assets' bytes for the audio owner: a sound decoded on load is
 *   read and registered when the game starts, any other when something first
 *   plays it (a script, an event cue, an audio source); a sound the start
 *   rows do not name is found in the catalog first.
 *
 * The host stays fetch-free: every read goes through the injected
 * `readArtifact` (the page's verified reader).
 */
import { createResourceManager, type ResourceManager, type ResourceObservation } from '@thirdlight/runtime';

import type { GameAudioOwner } from './audio';

/** What the asset loading reads from the host's config. */
export interface HostAssetsConfig {
  readonly readArtifact: (path: string) => Promise<ArrayBuffer>;
  readonly audio: GameAudioOwner;
  readonly assetPaths?: Record<string, string>;
  readonly assetKinds?: Readonly<Record<string, string>>;
  readonly audioLoad?: Readonly<Record<string, { readonly loadType?: string; readonly preload?: boolean }>>;
  readonly lookupAsset?: (assetId: string) => Promise<{ readonly path: string; readonly kind: string; readonly loadType?: string; readonly preload?: boolean } | undefined>;
  readonly resources?: ResourceManager;
}

/**
 * The resource manager as a game's observation and Play diagnostics report
 * it: resident count and bytes per kind, loads and frees per kind, loads in
 * flight or failed, and the script handles alive (scripts' handles come with
 * `ctx.assets`; until then none).
 */
export type GameResourcesObservation = ResourceObservation;

export interface HostAssets {
  /** The manager everything loaded from assets is held in. */
  readonly resources: ResourceManager;
  /** A glyph image's object URL (null while it loads; loaded on first ask). */
  glyphImageUrl(assetId: string): string | null;
  /** Read and register the sounds decoded on load (the game starts). */
  registerStartSounds(): void;
  /** Something is about to play this sound: its bytes are read and registered (once) if they are not yet. */
  soundWanted(assetId: string): void;
  /** The frame's scene changes are drawn: free what lost its last holder. */
  frameDone(): void;
  observe(): GameResourcesObservation;
  dispose(): void;
}

/** The glyph images' holder (released when the host is disposed). */
const GLYPHS_HOLDER = 'host/glyphs';

export function createHostAssets(config: HostAssetsConfig, live: () => boolean): HostAssets {
  const resources = config.resources ?? createResourceManager();
  const own = config.resources === undefined;
  const glyphUrls = new Map<string, string | null>();

  /** An audio file read on first use and decoded when played (not decoded on load with its scene). */
  const readOnUse = (assetId: string): boolean => {
    if (config.assetKinds?.[assetId] !== 'audio') return false;
    const load = config.audioLoad?.[assetId];
    return load !== undefined && (load.loadType !== 'decode-on-load' || load.preload === false);
  };
  /** Sounds found through `lookupAsset` (asked once each): read, then registered by their load settings. */
  const lookupAsked = new Set<string>();
  const findSound = (assetId: string): void => {
    if (config.lookupAsset === undefined || config.assetPaths?.[assetId] !== undefined || lookupAsked.has(assetId)) return;
    lookupAsked.add(assetId);
    void config
      .lookupAsset(assetId)
      .then(async (row) => {
        if (!live() || row === undefined || row.kind !== 'audio') return;
        const buffer = await config.readArtifact(row.path);
        if (!live()) return;
        const onUse = row.loadType !== undefined && (row.loadType !== 'decode-on-load' || row.preload === false);
        if (onUse && config.audio.registerMusic !== undefined) config.audio.registerMusic(assetId, new Uint8Array(buffer));
        else config.audio.registerCue(assetId, new Uint8Array(buffer));
      })
      .catch(() => undefined);
  };
  /** Files read on first use, asked once each. */
  const onUseAsked = new Set<string>();

  return {
    resources,
    glyphImageUrl(assetId) {
      if (glyphUrls.has(assetId)) return glyphUrls.get(assetId)!;
      glyphUrls.set(assetId, null);
      const known = config.assetPaths?.[assetId];
      const urls = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void } }).URL;
      if (typeof urls?.createObjectURL !== 'function' || typeof Blob !== 'function') return null;
      // An image the rows at mount do not name (a portrait, say): its path from the catalog.
      const path = typeof known === 'string' ? Promise.resolve(known) : (config.lookupAsset?.(assetId).then((r) => r?.path) ?? Promise.resolve(undefined));
      void resources
        .acquire<string>('image', assetId, GLYPHS_HOLDER, async () => {
          const p = await path;
          if (p === undefined) throw new Error(`image ${assetId} is not in this build`);
          const buffer = await config.readArtifact(p);
          return { value: urls.createObjectURL!(new Blob([buffer])), bytes: buffer.byteLength, free: (u) => urls.revokeObjectURL?.(u) };
        })
        .then(
          (url) => {
            if (live()) glyphUrls.set(assetId, url);
          },
          () => undefined,
        );
      return null;
    },
    registerStartSounds() {
      // Resolve every audio asset through the injected reader (async — the
      // game plays silently until a sound's bytes arrive and decode; the owner
      // skips unregistered assets with a bounded diagnostic).
      if (config.assetPaths === undefined) return;
      const registered = new Set<string>();
      const soundIds = Object.entries(config.assetKinds ?? {}).filter(([id, k]) => k === 'audio' && !readOnUse(id)).map(([id]) => id);
      for (const assetId of soundIds) {
        if (registered.has(assetId)) continue;
        const path = config.assetPaths[assetId];
        if (typeof path !== 'string' || path.length === 0) continue;
        registered.add(assetId);
        void config
          .readArtifact(path)
          .then((buffer) => {
            if (!live()) return;
            const r = config.audio.registerCue(assetId, new Uint8Array(buffer));
            if (r.ok === false) console.warn('[game-host] cue registration failed', r.error.code);
          })
          .catch((error: unknown) => {
            // Bounded: the cue stays unregistered; the owner skips it and
            // the game plays silently (no page error, no unhandled reject).
            console.warn('[game-host] cue artifact read failed', error instanceof Error ? error.message : String(error));
          });
      }
    },
    soundWanted(assetId) {
      findSound(assetId);
      if (!readOnUse(assetId) || onUseAsked.has(assetId)) return;
      onUseAsked.add(assetId);
      const path = config.assetPaths?.[assetId];
      if (typeof path !== 'string' || config.audio.registerMusic === undefined) return;
      void config
        .readArtifact(path)
        .then((buffer) => {
          if (live()) config.audio.registerMusic?.(assetId, new Uint8Array(buffer));
        })
        .catch(() => undefined);
    },
    frameDone() {
      resources.settle();
    },
    observe() {
      return resources.observe();
    },
    dispose() {
      glyphUrls.clear();
      resources.releaseHolder(GLYPHS_HOLDER);
      if (own) resources.dispose();
    },
  };
}
