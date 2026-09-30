/**
 * How the audio owner loads a sound: by its file's load type, with every
 * byte and buffer held in the page's resource manager.
 *
 * - `decode-on-load`: the file is read and decoded into a buffer (resource
 *   kind `audio`). The buffer is held by its scene when the scene preloads
 *   it, else from its first play by the scenes loaded then (the owner's
 *   scope), and freed when the last of them unloads; a play holds it too.
 * - `decode-while-playing`: the compressed bytes are kept (`audio-bytes`,
 *   held by the scene or the first play's scope as above) and decoded for
 *   each play; the decoded buffer is held by what plays it and freed after.
 * - `stream`: each play gets a media element that reads the file while it
 *   plays, heard through Web Audio (a MediaElementAudioSourceNode on the
 *   owner's context), freed when the play ends (`audio-stream`). Nothing is
 *   read ahead. A file with no URL (bytes registered directly) plays as
 *   decode-while-playing.
 *
 * `decodeAudioData` decodes only whole files and needs the context, which
 * exists only after the player's first gesture; before it, a sound held to
 * be decoded on load keeps its compressed bytes and is decoded at the
 * unlock. The browser's chunked decoder (WebCodecs `AudioDecoder`) is not
 * used: it takes demuxed packets (the page would need its own Ogg, MP3 and
 * FLAC demuxers), is not in every target browser and needs a secure
 * context, while a whole decode of a voice line takes tens of milliseconds.
 *
 * The loader holds no data of its own: its maps are what it knows about
 * each asset (load type, whether a decode failed) and which stream a play
 * owns; every byte and buffer is a manager resource.
 */
import type { ResourceManager } from '@thirdlight/runtime';

export type AudioLoadType = 'decode-on-load' | 'decode-while-playing' | 'stream';

/** One audio file as the host knows it: its load settings and how to read it. */
export interface AudioAssetSource {
  readonly loadType: AudioLoadType;
  /** Read with its scene (true) or only when first played. */
  readonly preload: boolean;
  /** The file's verified bytes (a fresh read each call; the loader keeps what it needs). */
  read(): Promise<Uint8Array>;
  /** Where a streamed file is read from as it plays. */
  readonly url?: string;
}

/** The media element a stream plays through (structural: the owner imports no DOM types). */
export interface MediaElementLike {
  src: string;
  preload: string;
  loop: boolean;
  playbackRate: number;
  preservesPitch?: boolean;
  readonly readyState: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** What the loader needs of the owner's context. */
export interface LoaderContextLike {
  decodeAudioData(data: ArrayBuffer): Promise<LoadedBufferLike>;
  createMediaElementSource?(element: MediaElementLike): { connect(target: unknown): void; disconnect?(): void };
}

export interface LoadedBufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  readonly length: number;
}

/** A stream's element and its node in the graph. */
export interface StreamValue {
  readonly element: MediaElementLike;
  readonly node: { connect(target: unknown): void; disconnect?(): void };
}

/** What a play gets: a decoded buffer or a stream, not yet ('wait'), or never ('failed'). */
export type Playable = { readonly kind: 'buffer'; readonly buffer: LoadedBufferLike } | { readonly kind: 'stream'; readonly stream: StreamValue } | 'wait' | 'failed';

/** HTMLMediaElement.HAVE_FUTURE_DATA: enough is buffered to play on. */
const HAVE_FUTURE_DATA = 3;

/** The resident size of a decoded buffer (32-bit float samples per channel). */
export function decodedBytes(b: LoadedBufferLike): number {
  const x = b as { length?: number; numberOfChannels?: number; duration?: number; sampleRate?: number };
  const frames = typeof x.length === 'number' ? x.length : Math.round((x.duration ?? 0) * (x.sampleRate ?? 0));
  return frames * Math.max(1, x.numberOfChannels ?? 1) * 4;
}

export interface AudioLoaderConfig {
  readonly resources: ResourceManager;
  /** Holder names are this prefix + the owner's name for the holder. */
  readonly prefix: string;
  /** The host's file for an asset (undefined: not in this build). */
  readonly source?: (assetId: string) => Promise<AudioAssetSource | undefined>;
  /** A new media element (absent: streams play as decode-while-playing). */
  readonly createMediaElement?: () => MediaElementLike | null;
  /** Something became playable (a decode, a read or a stream finished): the owner tries its waiting plays. */
  readonly onReady: () => void;
  /** A file could not be read or decoded (once per asset). */
  readonly onFailed: (assetId: string, message: string) => void;
}

export interface AudioLoader {
  /** Declare a file whose settings the owner was given directly (its bytes are held for `holder`). */
  register(assetId: string, loadType: AudioLoadType, bytes: Uint8Array, holder: string): void;
  /** The load type once known (undefined while the host is asked). */
  loadTypeOf(assetId: string): AudioLoadType | undefined;
  /** Load what `holder` keeps of the file ahead of its plays (a scene's preload, dialogue read ahead); `decode`: decode a file decoded while playing now too. */
  hold(assetId: string, holder: string, decode?: boolean): void;
  /** Let go of everything `holder` holds. */
  release(holder: string): void;
  /** Hand a play's stream over to another holder (a track that started from the one that waited for it). */
  adopt(from: string, to: string): void;
  /** The holders a sound's first play keeps its data for (the scenes loaded now). */
  setScope(holders: readonly string[]): void;
  /** What a play for `holder` gets now (starting whatever load it needs). */
  playable(assetId: string, holder: string): Playable;
  /** The context exists (the unlock) or sound is back on: decode what was held to be decoded on load. */
  contextReady(ctx: LoaderContextLike): void;
  /** Decode nothing until `contextReady` (sound muted). */
  pause(): void;
  /** A decode failed for good (the owner reports it once). */
  failed(assetId: string): boolean;
  /** Forget everything (the owner is disposed). */
  dispose(): void;
}

export function createAudioLoader(config: AudioLoaderConfig): AudioLoader {
  const { resources, prefix } = config;
  const h = (holder: string): string => prefix + holder;
  let ctx: LoaderContextLike | null = null;
  let disposed = false;
  /** Load settings by asset (null: asked, not in this build). */
  const known = new Map<string, { loadType: AudioLoadType; read: () => Promise<Uint8Array>; url?: string } | null>();
  const asking = new Map<string, Promise<void>>();
  const failedIds = new Set<string>();
  /** Holds waiting for the context: holder → assets to decode on load. */
  const decodeLater = new Map<string, Set<string>>();
  /** The stream key a play owns (holder → key). */
  const streamOf = new Map<string, string>();
  let streamSerial = 0;
  let scope: readonly string[] = ['play'];
  /** Every holder name used (let go at dispose). */
  const used = new Set<string>();
  /** A file registered again (a new version) is a new resource; plays of the old one keep theirs. */
  const generation = new Map<string, number>();
  const keyOf = (assetId: string): string => {
    const g = generation.get(assetId);
    return g === undefined ? assetId : `${assetId}~${g}`;
  };
  /** Decoding waits (sound is muted): what is held to be decoded on load keeps its bytes meanwhile. */
  let decoding = true;

  const fail = (assetId: string, e: unknown): void => {
    if (disposed || failedIds.has(assetId)) return;
    failedIds.add(assetId);
    config.onFailed(assetId, e instanceof Error ? e.message : String(e));
  };

  /** Ask the host for a file's settings (once); resolves when known. */
  const ask = (assetId: string): Promise<void> => {
    if (known.has(assetId)) return Promise.resolve();
    let p = asking.get(assetId);
    if (p !== undefined) return p;
    const source = config.source;
    p = (source === undefined ? Promise.resolve(undefined) : source(assetId)).then(
      (s) => {
        asking.delete(assetId);
        if (disposed || known.has(assetId)) return;
        known.set(assetId, s === undefined ? null : { loadType: s.loadType, read: () => s.read(), ...(s.url !== undefined ? { url: s.url } : {}) });
        config.onReady();
      },
      (e: unknown) => {
        asking.delete(assetId);
        fail(assetId, e);
      },
    );
    asking.set(assetId, p);
    return p;
  };

  /** Hold the compressed bytes for `holder` (read once while anyone holds them). */
  const holdBytes = (assetId: string, holder: string): Promise<Uint8Array> => {
    const k = known.get(assetId);
    used.add(holder);
    if (k === undefined || k === null) return Promise.reject(new Error(`${assetId} is not an audio file of this build`));
    return resources.acquire<Uint8Array>('audio-bytes', keyOf(assetId), h(holder), async () => {
      const bytes = await k.read();
      return { value: bytes, bytes: bytes.byteLength };
    });
  };

  /** Hold the decoded buffer for `holder` (decoded once while anyone holds it). */
  const holdDecoded = (assetId: string, holder: string): Promise<LoadedBufferLike> => {
    const c = ctx;
    used.add(holder);
    if (c === null) return Promise.reject(new Error('no audio context yet'));
    const key = keyOf(assetId);
    return resources.acquire<LoadedBufferLike>('audio', key, h(holder), async () => {
      // The bytes are held while they decode (a scope may hold them longer: decode-while-playing).
      const tmp = `decoding:${assetId}`;
      try {
        const bytes = await holdBytes(assetId, tmp);
        // decodeAudioData detaches what it is given: it decodes a copy, the kept bytes stay usable.
        const buffer = await c.decodeAudioData(bytes.slice().buffer);
        return { value: buffer, bytes: decodedBytes(buffer) };
      } finally {
        resources.release('audio-bytes', key, h(tmp));
      }
    });
  };

  const watch = (assetId: string, p: Promise<unknown>): void => {
    p.then(
      () => {
        if (!disposed) config.onReady();
      },
      (e: unknown) => fail(assetId, e),
    );
  };

  /** A decode-on-load file held for `holder`: decoded now, or its bytes until there is a context. */
  const holdOnLoad = (assetId: string, holder: string): void => {
    if (ctx !== null && decoding) {
      watch(assetId, holdDecoded(assetId, holder));
      return;
    }
    let set = decodeLater.get(holder);
    if (set === undefined) decodeLater.set(holder, (set = new Set()));
    set.add(assetId);
    watch(assetId, holdBytes(assetId, holder));
  };

  const holdKnown = (assetId: string, holder: string, decode: boolean): void => {
    const k = known.get(assetId);
    if (k === undefined || k === null || failedIds.has(assetId)) return;
    if (k.loadType === 'decode-on-load') holdOnLoad(assetId, holder);
    else if (k.loadType === 'decode-while-playing' || k.url === undefined || config.createMediaElement === undefined) {
      watch(assetId, holdBytes(assetId, holder));
      // A play about to come: decoded now (held with the bytes, freed with them), so it starts at once.
      if (decode && ctx !== null && decoding) watch(assetId, holdDecoded(assetId, holder));
    }
    // A stream reads nothing ahead: its element reads the file when it plays.
  };

  /** A new stream for one play: an element reading the file, ready once it can play on. */
  const openStream = (assetId: string, url: string, holder: string): void => {
    const c = ctx;
    const make = config.createMediaElement;
    if (c === null || make === undefined || c.createMediaElementSource === undefined) return;
    streamSerial += 1;
    const key = `${assetId}#${streamSerial}`;
    streamOf.set(holder, key);
    used.add(holder);
    const p = resources.acquire<StreamValue>('audio-stream', key, h(holder), () => {
      const element = make();
      if (element === null) return Promise.reject(new Error('this page cannot make a media element'));
      element.preload = 'auto';
      return new Promise((resolve, reject) => {
        const ok = (): void => {
          element.removeEventListener('error', bad);
          const node = c.createMediaElementSource!(element);
          resolve({
            value: { element, node },
            // What the element buffers is the browser's (not observable); the stream counts, not its bytes.
            bytes: 0,
            free: (v) => {
              v.element.pause();
              v.element.removeAttribute('src');
              v.element.load();
              v.node.disconnect?.();
            },
          });
        };
        const bad = (): void => {
          element.removeEventListener('canplay', ok);
          element.removeAttribute('src');
          element.load();
          reject(new Error(`${assetId}: the stream could not be read`));
        };
        element.addEventListener('canplay', ok, { once: true });
        element.addEventListener('error', bad, { once: true });
        element.src = url;
        if (element.readyState >= HAVE_FUTURE_DATA) ok();
      });
    });
    watch(assetId, p);
  };

  return {
    register(assetId, loadType, bytes, holder) {
      if (known.has(assetId)) {
        // A new registration replaces the old data (a new version of the file); a play of the old one keeps it.
        resources.release('audio', keyOf(assetId), h(holder));
        resources.release('audio-bytes', keyOf(assetId), h(holder));
        generation.set(assetId, (generation.get(assetId) ?? 0) + 1);
      }
      known.set(assetId, { loadType, read: () => Promise.resolve(bytes) });
      failedIds.delete(assetId);
      used.add(holder);
      void resources.acquire('audio-bytes', keyOf(assetId), h(holder), () => Promise.resolve({ value: bytes, bytes: bytes.byteLength })).catch(() => undefined);
      if (loadType === 'decode-on-load') holdOnLoad(assetId, holder);
    },
    loadTypeOf(assetId) {
      const k = known.get(assetId);
      return k === undefined || k === null ? undefined : k.url !== undefined || k.loadType !== 'stream' || config.createMediaElement === undefined ? k.loadType : 'decode-while-playing';
    },
    hold(assetId, holder, decode = false) {
      if (disposed) return;
      if (known.has(assetId)) holdKnown(assetId, holder, decode);
      else if (config.source !== undefined) void ask(assetId).then(() => holdKnown(assetId, holder, decode));
    },
    release(holder) {
      decodeLater.delete(holder);
      const key = streamOf.get(holder);
      streamOf.delete(holder);
      if (key !== undefined) resources.release('audio-stream', key, h(holder));
      resources.releaseHolder(h(holder));
    },
    adopt(from, to) {
      const key = streamOf.get(from);
      if (key === undefined) return;
      streamOf.delete(from);
      streamOf.set(to, key);
      used.add(to);
      resources.hold('audio-stream', key, h(to));
      resources.release('audio-stream', key, h(from));
    },
    setScope(holders) {
      scope = holders.length > 0 ? [...holders] : ['play'];
    },
    playable(assetId, holder) {
      if (disposed || failedIds.has(assetId)) return 'failed';
      const k = known.get(assetId);
      if (k === undefined) {
        // Without the host's catalog a file may still be registered later.
        if (config.source !== undefined) void ask(assetId);
        return 'wait';
      }
      if (k === null) return 'failed';
      const streamed = k.loadType === 'stream' && k.url !== undefined && config.createMediaElement !== undefined;
      if (streamed) {
        const key = streamOf.get(holder);
        if (key !== undefined) {
          const s = resources.peek<StreamValue>('audio-stream', key);
          if (s !== undefined) return { kind: 'stream', stream: s };
          return resources.has('audio-stream', key) ? 'wait' : 'failed';
        }
        if (ctx === null) return 'wait';
        openStream(assetId, k.url!, holder);
        return 'wait';
      }
      // A first play (nothing holds the file yet) keeps its data for the scenes loaded now; a file
      // a scene preloaded or the dialogue read ahead stays with them.
      const keep = k.loadType === 'decode-on-load' ? 'audio' : 'audio-bytes';
      const key = keyOf(assetId);
      if (!resources.has(keep, key) && !(keep === 'audio' && resources.has('audio-bytes', key))) {
        for (const s of scope) {
          if (keep === 'audio-bytes') watch(assetId, holdBytes(assetId, s));
          else holdOnLoad(assetId, s);
        }
      }
      if (ctx === null || !decoding) return 'wait';
      const buffer = resources.peek<LoadedBufferLike>('audio', key);
      if (buffer !== undefined) {
        used.add(holder);
        resources.hold('audio', key, h(holder));
        return { kind: 'buffer', buffer };
      }
      if (!resources.holders('audio', key).includes(h(holder))) watch(assetId, holdDecoded(assetId, holder));
      return 'wait';
    },
    contextReady(c) {
      ctx = c;
      decoding = true;
      for (const [holder, ids] of [...decodeLater]) {
        decodeLater.delete(holder);
        for (const id of ids) {
          const p = holdDecoded(id, holder);
          watch(id, p);
          // Once decoded the holder keeps the buffer; the compressed bytes go (registered files keep theirs).
          const key = keyOf(id);
          void p.then(
            () => {
              if (!holder.startsWith('registered')) resources.release('audio-bytes', key, h(holder));
            },
            () => undefined,
          );
        }
      }
    },
    pause() {
      decoding = false;
    },
    failed(assetId) {
      return failedIds.has(assetId);
    },
    dispose() {
      disposed = true;
      for (const holder of used) resources.releaseHolder(h(holder));
      for (const [holder, key] of streamOf) resources.release('audio-stream', key, h(holder));
      streamOf.clear();
      decodeLater.clear();
      known.clear();
    },
  };
}
