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
 * - what scripts load with `ctx.assets`: the simulation's load requests are
 *   carried out by the page's `loadAssets` (the key resolved, the assets
 *   read, parsed or decoded, and held for the handle's holder), and the
 *   answer goes back as the simulation's input; a release lets the holder go
 *   (a handle released while it loads is let go once its load is done).
 *
 * The host stays fetch-free: every read goes through the injected
 * `readArtifact` (the page's verified reader) or `loadAssets`.
 */
import { createResourceManager, RESOURCE_HANDLE_PREFIX, type AssetHandleAnswer, type AssetHandleRequest, type ResourceManager, type ResourceObservation } from '@thirdlight/runtime';

/** What the asset loading reads from the host's config. */
export interface HostAssetsConfig {
  readonly readArtifact: (path: string) => Promise<ArrayBuffer>;
  readonly assetPaths?: Record<string, string>;
  readonly lookupAsset?: (assetId: string) => Promise<{ readonly path: string; readonly kind: string } | undefined>;
  readonly resources?: ResourceManager;
  /**
   * Load what a script's key names (an asset id, an address or a label) and
   * hold it in the resource manager for `holder`; resolves with the ids the
   * key named. Rejects when the key names nothing in this build or a load
   * failed (then nothing stays held for `holder`). Absent: scripts' loads fail.
   */
  readonly loadAssets?: (key: string, holder: string) => Promise<readonly string[]>;
  /** The texture streamer's report (resident texture bytes against the budget; the page's renderer makes it); absent: none. */
  readonly textureStreaming?: () => object;
}

/** One script handle as the observation and the report show it. */
export interface ScriptHandleReport {
  readonly handle: number;
  readonly key: string;
  readonly state: 'loading' | 'ready' | 'failed';
  /** Assets and resources the key named (0 until ready). */
  readonly assets: number;
  /** Why the load failed (failed only). */
  readonly error?: string;
}

/** Handles listed in an observation (the counts say how many there are). */
const HANDLES_LISTED = 32;

/**
 * The resource manager as a game's observation and Play diagnostics report
 * it: resident count and bytes per kind, loads and frees per kind, loads in
 * flight or failed, and the script handles alive (scripts' handles come with
 * `ctx.assets`; until then none).
 */
export interface GameResourcesObservation extends ResourceObservation {
  /** The script handles open now (first 32; `handles` counts them all). */
  readonly open?: readonly ScriptHandleReport[];
  /** Handles still open when a run ended (a restart): released then; the last 32, `notReleasedCount` all. */
  readonly notReleased?: readonly ScriptHandleReport[];
  readonly notReleasedCount?: number;
  /** Texture streaming: resident texture bytes against the budget, each streamed texture's levels. */
  readonly textures?: object;
}

export interface HostAssets {
  /** The manager everything loaded from assets is held in. */
  readonly resources: ResourceManager;
  /** A glyph image's object URL (null while it loads; loaded on first ask). */
  glyphImageUrl(assetId: string): string | null;
  /** Carry out the simulation's asset loads and releases; the answers go to `answer` (the next step's input). */
  serviceHandles(requests: readonly AssetHandleRequest[], answer: (a: AssetHandleAnswer) => void): void;
  /** The frame's scene changes are drawn: free what lost its last holder. */
  frameDone(): void;
  observe(): GameResourcesObservation;
  /** Let everything go; returns the script handles still open (reported as not released at the play's end). */
  dispose(): readonly ScriptHandleReport[];
}

/** The glyph images' holder (released when the host is disposed). */
const GLYPHS_HOLDER = 'host/glyphs';

export function createHostAssets(config: HostAssetsConfig, live: () => boolean): HostAssets {
  const resources = config.resources ?? createResourceManager();
  const own = config.resources === undefined;
  const glyphUrls = new Map<string, string | null>();


  /** Scripts' handles the host holds for (by handle number). */
  interface HostHandle {
    readonly key: string;
    state: ScriptHandleReport['state'];
    assets: number;
    error: string;
    released: boolean;
  }
  const handles = new Map<number, HostHandle>();
  const notReleased: ScriptHandleReport[] = [];
  let notReleasedCount = 0;
  const reportOf = (handle: number, h: HostHandle): ScriptHandleReport => ({ handle, key: h.key, state: h.state, assets: h.assets, ...(h.state === 'failed' ? { error: h.error } : {}) });
  const holderOf = (handle: number): string => `${RESOURCE_HANDLE_PREFIX}${handle}`;
  const startLoad = (handle: number, key: string, answer: (a: AssetHandleAnswer) => void): void => {
    const h: HostHandle = { key, state: 'loading', assets: 0, error: '', released: false };
    handles.set(handle, h);
    const load = config.loadAssets;
    const done = load === undefined ? Promise.reject(new Error('this game page cannot load assets by name')) : load(key, holderOf(handle));
    void done.then(
      (ids) => {
        // Released while it loaded (or the host closed): what it took is let go now.
        if (h.released || !live()) {
          resources.releaseHolder(holderOf(handle));
          return;
        }
        h.state = 'ready';
        h.assets = ids.length;
        answer({ handle, ok: true, assets: [...ids] });
      },
      (e: unknown) => {
        resources.releaseHolder(holderOf(handle));
        if (h.released || !live()) return;
        h.state = 'failed';
        h.error = (e instanceof Error ? e.message : String(e)).slice(0, 256);
        answer({ handle, ok: false, message: h.error });
      },
    );
  };

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
    serviceHandles(requests, answer) {
      for (const r of requests) {
        if (r.op === 'load') {
          startLoad(r.handle, r.key, answer);
          continue;
        }
        const h = handles.get(r.handle);
        if (h === undefined) continue;
        handles.delete(r.handle);
        h.released = true;
        resources.releaseHolder(holderOf(r.handle));
        if (r.runEnded === true) {
          notReleasedCount += 1;
          notReleased.push(reportOf(r.handle, h));
          if (notReleased.length > HANDLES_LISTED) notReleased.shift();
        }
      }
    },
    frameDone() {
      resources.settle();
    },
    observe() {
      const base = resources.observe();
      const open = [...handles].slice(0, HANDLES_LISTED).map(([n, h]) => reportOf(n, h));
      return {
        ...base,
        handles: handles.size,
        ...(open.length > 0 ? { open } : {}),
        ...(notReleasedCount > 0 ? { notReleased: [...notReleased], notReleasedCount } : {}),
        ...(config.textureStreaming !== undefined ? { textures: config.textureStreaming() } : {}),
      };
    },
    dispose() {
      const open = [...handles].map(([n, h]) => reportOf(n, h));
      for (const [n, h] of handles) {
        h.released = true;
        resources.releaseHolder(holderOf(n));
      }
      handles.clear();
      glyphUrls.clear();
      resources.releaseHolder(GLYPHS_HOLDER);
      if (own) resources.dispose();
      return open;
    },
  };
}
