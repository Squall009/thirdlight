/**
 * The page's side of project save documents — the storage
 * owner. The simulation (page or worker) asks for saves, loads and deletes
 * (`Runtime.takeSaveRequests`); this service carries them out against the
 * browser's storage and answers with entries of the next step's input
 * (`Runtime.queueSaveEvent`): the slot list, outcomes and loaded documents.
 *
 * Storage: slots in IndexedDB (a slot holds up to 1 MiB and a game up to 99 of
 * them — past localStorage's ~5 MB per origin), one key per slot for the
 * metadata (the slot list reads only these), one for the body and one for the
 * thumbnail. A slot's three keys are written (and deleted) in one transaction:
 * the metadata holds the body's checksum, so a write refused or cut off
 * between them would leave a slot that is neither the old save nor the new
 * one. A refused write answers with a storage code (`storage_full`,
 * `storage_unavailable`, `storage_failed`) next to the browser's text. At the
 * first save the host asks the browser to keep the site's data under disk
 * pressure (`navigator.storage.persist()`); the answer and the usage and quota
 * go to the simulation (`ctx.saves.storage()`) and observers.
 * The project settings document is small and must be known before
 * the first step (the runtime starts with it), so it is in the synchronous
 * key/value storage (`localStorage`, see `storage.ts`) next to the player's
 * other settings. Play and an export use different namespaces. No backend is
 * involved: an exported game keeps its saves in the player's browser.
 */
import { SAVE_LIMITS, SAVE_THUMBNAIL_DEFAULT, saveSlotMetaProblem, settingsDocumentOf, type SaveSchema, type SettingsEngineBinding, type SettingsFieldValue, projectSaveFileProblem, utf8Length, type ProjectSaveFile, type SaveEvent, type SaveRequest, type SaveSlotInfo, type SaveStorageCode, type SaveStorageInfo } from '@thirdlight/runtime';

import { saveChecksum, storageErrorCode, StorageUnavailableError, writeStored, type SaveStorage } from './storage';

/** An asynchronous key/value store (IndexedDB in the browser; a Map in tests). */
export interface ProjectSaveBackend {
  /** Several keys read together (null: absent). */
  read(keys: readonly string[]): Promise<(string | null)[]>;
  /** Puts and removes as one transaction: all of them are stored, or none (the promise rejects with the refusal). */
  write(puts: Readonly<Record<string, string>>, removes: readonly string[]): Promise<void>;
  /** Where the slots live (reported by observers); `unavailable`: the page has no storage and every write is refused. */
  readonly kind: 'indexeddb' | 'memory' | 'unavailable';
}

/** The browser's storage manager as the save service uses it (`navigator.storage`). */
export interface DeviceStorage {
  /** Whether the site's data is kept under disk pressure (asks nothing of the player). */
  persisted(): Promise<boolean>;
  /** Ask for that (the browser may grant it silently, ask the player or refuse). */
  persist(): Promise<boolean>;
  estimate(): Promise<{ usage?: number; quota?: number }>;
}

/** A slot's thumbnail as observers see it (the image itself via `thumbnail(slot)`). */
export interface SaveThumbnailInfo {
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** One used slot as the host knows it (the simulation's slot list, plus the picture's facts). */
export interface ProjectSlotObservation extends Omit<SaveSlotInfo, 'thumbnail'> {
  readonly thumbnail?: SaveThumbnailInfo;
}

interface StoredMeta {
  v: 1;
  slot: number;
  title: string;
  chapter: string;
  location: string;
  playSeconds: number;
  savedAt: string;
  version: number;
  bytes: number;
  sum: string;
  thumbnail?: SaveThumbnailInfo;
  /** The game's own fields (absent: none; older slots have none). */
  meta?: Record<string, string>;
}

/** A captured picture of the view (a data URL of the schema's format). */
export type ThumbnailCapture = (width: number, height: number, type: 'image/jpeg' | 'image/webp', quality: number) => { dataUrl: string; width: number; height: number } | null;

export interface ProjectSaveServiceConfig {
  readonly schema: SaveSchema;
  readonly backend: ProjectSaveBackend;
  readonly namespace: string;
  /** Answers for the simulation (queued into its next step's input). */
  readonly queue: (event: SaveEvent) => void;
  /** The synchronous storage the settings document is in (absent: settings last for the session only). */
  readonly settingsStorage?: SaveStorage;
  readonly captureThumbnail?: ThumbnailCapture;
  /** True while no picture can be drawn yet (the renderer is still starting): requests wait for it. */
  readonly pictureWaits?: () => boolean;
  /** The browser's storage manager (absent: persistence, usage and quota stay unknown). */
  readonly device?: DeviceStorage;
  /** Apply an engine setting a settings field drives. */
  readonly applyEngine?: (binding: SettingsEngineBinding, value: SettingsFieldValue) => void;
  /** The player's clock (ISO text) for `savedAt`. */
  readonly now?: () => string;
  readonly log?: (message: string) => void;
}

export interface ProjectSaveService {
  /** Read the slot list and hand it to the simulation. */
  start(): Promise<void>;
  /**
   * Carry out the simulation's requests (in order; a thumbnail is captured now, before any await).
   * Called every frame: requests held back while a picture cannot be drawn yet are carried out then.
   */
  handle(requests: readonly SaveRequest[]): void;
  /** Load a slot into the simulation (a `tl_play_start` save slot). */
  loadSlot(slot: number): Promise<void>;
  /** Hand a save document to the simulation (a `tl_play_start` save document; slot 0). */
  loadDocument(file: ProjectSaveFile): void;
  /** The used slots (metadata and picture facts), as last read or written. */
  slots(): readonly ProjectSlotObservation[];
  /** A slot's picture as a data URL (null: none). */
  thumbnail(slot: number): Promise<string | null>;
  /** The project settings document as stored (with defaults for the rest). */
  settings(): Readonly<Record<string, SettingsFieldValue>>;
  /** Settled when every request so far is done (tests, a reload). */
  idle(): Promise<void>;
  /**
   * Forget every slot of this game in this browser (the editor's
   * "Clear Play save"; the deleted level flow's own saves were what it cleared
   * before); the simulation gets the empty slot list.
   */
  clear(): Promise<void>;
  readonly storage: 'indexeddb' | 'memory' | 'unavailable';
  /** Whether the browser keeps the saves under disk pressure, and the site's usage and quota (null: unknown). */
  storageInfo(): SaveStorageInfo;
  /** Whether persistent storage was asked for (at the first save). */
  persistAsked(): boolean;
}

const metaKey = (ns: string, slot: number): string => `${ns}:slot:${slot}:meta`;
const bodyKey = (ns: string, slot: number): string => `${ns}:slot:${slot}:body`;
const thumbKey = (ns: string, slot: number): string => `${ns}:slot:${slot}:thumb`;
const settingsKey = (ns: string): string => `${ns}:project-settings`;

/** The stored project settings document (defaults for fields it lacks), read synchronously at start. */
export function readProjectSettings(schema: SaveSchema, storage: SaveStorage | undefined, namespace: string): Record<string, SettingsFieldValue> {
  let stored: unknown = null;
  try {
    const raw = storage?.get(settingsKey(namespace)) ?? null;
    if (raw !== null && raw.length <= 65_536) stored = JSON.parse(raw) as unknown;
  } catch {
    stored = null;
  }
  return settingsDocumentOf(schema.settings ?? [], stored);
}

function slotOf(m: StoredMeta): ProjectSlotObservation {
  return { slot: m.slot, title: m.title, chapter: m.chapter, location: m.location, playSeconds: m.playSeconds, savedAt: m.savedAt, version: m.version, bytes: m.bytes, meta: { ...(m.meta ?? {}) }, ...(m.thumbnail !== undefined ? { thumbnail: m.thumbnail } : {}) };
}

function metaProblem(m: unknown, slot: number): string | null {
  const r = m as StoredMeta;
  if (typeof r !== 'object' || r === null || r.v !== 1 || r.slot !== slot) return 'not a slot record';
  if (typeof r.title !== 'string' || typeof r.chapter !== 'string' || typeof r.location !== 'string' || typeof r.savedAt !== 'string' || typeof r.sum !== 'string') return 'not a slot record';
  if (!(typeof r.playSeconds === 'number' && r.playSeconds >= 0) || !Number.isInteger(r.version) || !Number.isInteger(r.bytes)) return 'not a slot record';
  if (r.meta !== undefined && saveSlotMetaProblem(r.meta) !== null) return 'not a slot record';
  return null;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** A refusal as a result carries it: the browser's text and the storage code. */
function refusal(e: unknown, fallback: string): { reason: string; code: SaveStorageCode } {
  const text = e instanceof Error || (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') ? (e as { message: string }).message : '';
  return { reason: clip(text !== '' ? text : fallback, 200), code: storageErrorCode(e) };
}

export function createProjectSaveService(cfg: ProjectSaveServiceConfig): ProjectSaveService {
  const { schema, backend, namespace: ns } = cfg;
  const log = cfg.log ?? (() => undefined);
  const now = cfg.now ?? (() => new Date().toISOString());
  const known = new Map<number, ProjectSlotObservation>();
  const damaged = new Map<number, string>();
  let chain: Promise<void> = Promise.resolve();
  let settingsDoc = readProjectSettings(schema, cfg.settingsStorage, ns);
  let info: SaveStorageInfo = { persisted: null, usage: null, quota: null };
  let asked = false;
  /** Ask the browser how much the site uses (and whether it keeps it), then tell the simulation. Never in the save chain: a browser that asks the player must not hold the saves up. */
  const refreshStorage = async (persist: boolean): Promise<void> => {
    const device = cfg.device;
    if (device === undefined) return;
    let persisted = info.persisted;
    try {
      persisted = persist ? await device.persist() : await device.persisted();
    } catch {
      // the browser refused to answer: what was known stays
    }
    let usage = info.usage;
    let quota = info.quota;
    try {
      const e = await device.estimate();
      usage = typeof e.usage === 'number' && Number.isFinite(e.usage) ? e.usage : null;
      quota = typeof e.quota === 'number' && Number.isFinite(e.quota) ? e.quota : null;
    } catch {
      // as above
    }
    info = { persisted: typeof persisted === 'boolean' ? persisted : null, usage, quota };
    cfg.queue({ kind: 'storage', ...info });
  };
  const thumb = { ...SAVE_THUMBNAIL_DEFAULT, ...(schema.thumbnail ?? {}) };

  const held: SaveRequest[] = [];
  const enqueue = (job: () => Promise<void>): void => {
    chain = chain.then(job).catch((e: unknown) => log(`save storage: ${e instanceof Error ? e.message : String(e)}`));
  };
  const slotList = (): SaveSlotInfo[] => {
    const out: SaveSlotInfo[] = [];
    for (let s = 1; s <= schema.slots; s += 1) {
      const k = known.get(s);
      if (k !== undefined) out.push({ slot: k.slot, title: clip(k.title, SAVE_LIMITS.metaText), chapter: clip(k.chapter, SAVE_LIMITS.metaText), location: clip(k.location, SAVE_LIMITS.metaText), playSeconds: k.playSeconds, savedAt: clip(k.savedAt, 40), version: k.version, bytes: k.bytes, thumbnail: k.thumbnail !== undefined, meta: k.meta });
      else if (damaged.has(s)) out.push({ slot: s, title: '', chapter: '', location: '', playSeconds: 0, savedAt: '', version: 0, bytes: 0, thumbnail: false, meta: {}, damaged: damaged.get(s)! });
    }
    return out;
  };
  const sendSlots = (): void => cfg.queue({ kind: 'slots', slots: slotList() });

  const readSlot = async (s: number): Promise<void> => {
    const [raw] = await backend.read([metaKey(ns, s)]);
    known.delete(s);
    damaged.delete(s);
    if (raw === null || raw === undefined) return;
    try {
      const m = JSON.parse(raw) as StoredMeta;
      const p = metaProblem(m, s);
      if (p !== null) damaged.set(s, p);
      else known.set(s, slotOf(m));
    } catch {
      damaged.set(s, 'the slot record does not parse');
    }
  };

  const applyEngineSettings = (values: Readonly<Record<string, SettingsFieldValue>>): void => {
    if (cfg.applyEngine === undefined) return;
    for (const f of schema.settings ?? []) if (f.engine !== undefined && values[f.key] !== undefined) cfg.applyEngine(f.engine, values[f.key]!);
  };
  applyEngineSettings(settingsDoc);

  const save = (r: Extract<SaveRequest, { op: 'save' }>): void => {
    // The picture is taken now (the frame just drawn), before any await.
    let picture: { dataUrl: string; width: number; height: number } | null = null;
    if (r.meta.thumbnail && cfg.captureThumbnail !== undefined) {
      try {
        picture = cfg.captureThumbnail(thumb.width, thumb.height, thumb.format === 'webp' ? 'image/webp' : 'image/jpeg', thumb.quality ?? 0.8);
      } catch {
        picture = null;
      }
      if (picture !== null && picture.dataUrl.length > SAVE_LIMITS.thumbnailBytes) {
        log(`the thumbnail of slot ${r.slot} is larger than ${SAVE_LIMITS.thumbnailBytes} bytes; saved without it`);
        picture = null;
      }
    }
    const savedAt = now();
    // The first save asks the browser to keep the site's data (a prompt in some browsers: not awaited).
    if (!asked) {
      asked = true;
      void refreshStorage(true);
    }
    enqueue(async () => {
      const bytes = utf8Length(r.text);
      if (bytes > SAVE_LIMITS.documentBytes) {
        cfg.queue({ kind: 'saved', slot: r.slot, ok: false, reason: `the save is larger than ${SAVE_LIMITS.documentBytes} bytes` });
        return;
      }
      const type = picture !== null ? picture.dataUrl.slice(5, picture.dataUrl.indexOf(';')) : '';
      const meta: StoredMeta = {
        v: 1,
        slot: r.slot,
        title: r.meta.title,
        chapter: r.meta.chapter,
        location: r.meta.location,
        playSeconds: r.meta.playSeconds,
        savedAt,
        version: r.meta.version,
        bytes,
        sum: saveChecksum(r.text),
        ...(r.meta.meta !== undefined && Object.keys(r.meta.meta).length > 0 ? { meta: { ...r.meta.meta } } : {}),
        ...(picture !== null ? { thumbnail: { type, width: picture.width, height: picture.height, bytes: picture.dataUrl.length } } : {}),
      };
      // Body, picture and metadata in one transaction (the metadata last): all of the new save or none of it.
      const puts: Record<string, string> = { [bodyKey(ns, r.slot)]: r.text };
      if (picture !== null) puts[thumbKey(ns, r.slot)] = picture.dataUrl;
      puts[metaKey(ns, r.slot)] = JSON.stringify(meta);
      try {
        await backend.write(puts, picture !== null ? [] : [thumbKey(ns, r.slot)]);
      } catch (e) {
        const why = refusal(e, 'storage refused the save');
        log(`save slot ${r.slot} was not stored (${why.code}): ${why.reason}`);
        cfg.queue({ kind: 'saved', slot: r.slot, ok: false, ...why });
        return;
      }
      known.set(r.slot, slotOf(meta));
      damaged.delete(r.slot);
      cfg.queue({ kind: 'saved', slot: r.slot, ok: true });
      sendSlots();
      void refreshStorage(false);
    });
  };

  const load = (slot: number): Promise<void> => {
    let done!: () => void;
    const settled = new Promise<void>((resolve) => (done = resolve));
    enqueue(async () => {
      try {
        const fail = (reason: string, code?: SaveStorageCode): void => cfg.queue({ kind: 'loaded', slot, ok: false, reason, ...(code !== undefined ? { code } : {}) });
        let rawMeta: string | null | undefined;
        let body: string | null | undefined;
        try {
          // One read: the metadata and the body of the same write.
          [rawMeta, body] = await backend.read([metaKey(ns, slot), bodyKey(ns, slot)]);
        } catch (e) {
          const why = refusal(e, 'storage refused the read');
          return fail(why.reason, why.code);
        }
        if (rawMeta === null || rawMeta === undefined || body === null || body === undefined) return fail(`save slot ${slot} is empty`);
        let meta: StoredMeta;
        try {
          meta = JSON.parse(rawMeta) as StoredMeta;
        } catch {
          return fail(`save slot ${slot} is damaged (the record does not parse)`);
        }
        if (metaProblem(meta, slot) !== null) return fail(`save slot ${slot} is damaged`);
        if (saveChecksum(body) !== meta.sum) return fail(`save slot ${slot} is damaged (checksum mismatch)`);
        if (utf8Length(body) > SAVE_LIMITS.documentBytes) return fail(`save slot ${slot} is larger than ${SAVE_LIMITS.documentBytes} bytes`);
        let file: unknown;
        try {
          file = JSON.parse(body) as unknown;
        } catch {
          return fail(`save slot ${slot} is damaged (does not parse)`);
        }
        const p = projectSaveFileProblem(file, schema.version);
        if (p !== null) return fail(p);
        cfg.queue({ kind: 'loaded', slot, ok: true, save: file as ProjectSaveFile });
      } finally {
        done();
      }
    });
    return settled;
  };

  const remove = (slot: number): void => {
    enqueue(async () => {
      try {
        await backend.write({}, [metaKey(ns, slot), bodyKey(ns, slot), thumbKey(ns, slot)]);
      } catch (e) {
        cfg.queue({ kind: 'deleted', slot, ok: false, ...refusal(e, 'storage refused the delete') });
        return;
      }
      known.delete(slot);
      damaged.delete(slot);
      cfg.queue({ kind: 'deleted', slot, ok: true });
      sendSlots();
    });
  };

  return {
    storage: backend.kind,
    storageInfo: () => info,
    persistAsked: () => asked,
    async start() {
      enqueue(async () => {
        for (let s = 1; s <= schema.slots; s += 1) await readSlot(s);
        sendSlots();
      });
      void refreshStorage(false);
      await chain;
    },
    handle(requests) {
      // A script may save on its first step, before the view has drawn anything: the save (and
      // what follows it, to keep the order) waits for the renderer so the slot gets its picture.
      held.push(...requests);
      if (held.length === 0 || (held.some((r) => r.op === 'save' && r.meta.thumbnail) && cfg.pictureWaits?.() === true)) return;
      for (const r of held.splice(0)) {
        switch (r.op) {
          case 'save':
            save(r);
            break;
          case 'load':
            void load(r.slot);
            break;
          case 'delete':
            remove(r.slot);
            break;
          case 'settings':
            settingsDoc = settingsDocumentOf(schema.settings ?? [], r.values);
            if (cfg.settingsStorage !== undefined) {
              // Refused (full, or no storage): the settings still apply for this session; the game is told.
              const refused = writeStored(cfg.settingsStorage, settingsKey(ns), JSON.stringify(settingsDoc));
              if (refused !== null) {
                log(`the settings document was not kept (${refused.code}): ${refused.reason}`);
                cfg.queue({ kind: 'settings', ok: false, ...refused });
              }
            }
            applyEngineSettings(settingsDoc);
            break;
        }
      }
    },
    loadSlot: (slot) => load(slot),
    loadDocument(file) {
      const p = projectSaveFileProblem(file, schema.version);
      const t = JSON.stringify(file);
      if (p !== null || utf8Length(t) > SAVE_LIMITS.documentBytes) cfg.queue({ kind: 'loaded', slot: 0, ok: false, reason: p ?? `the save is larger than ${SAVE_LIMITS.documentBytes} bytes` });
      else cfg.queue({ kind: 'loaded', slot: 0, ok: true, save: file });
    },
    slots() {
      return [...known.values()].sort((a, b) => a.slot - b.slot);
    },
    async thumbnail(slot) {
      if (known.get(slot)?.thumbnail === undefined) return null;
      const [url] = await backend.read([thumbKey(ns, slot)]);
      return url ?? null;
    },
    settings: () => settingsDoc,
    clear: async () => {
      for (let slot = 1; slot <= schema.slots; slot += 1) remove(slot);
      await chain;
    },
    idle: async () => {
      let before: Promise<void>;
      do {
        before = chain;
        await before;
      } while (before !== chain);
    },
  };
}

/** A Map-backed store (tests). A write applies all of its keys or, when it throws, none. */
export function memoryProjectSaveBackend(map: Map<string, string> = new Map()): ProjectSaveBackend {
  return {
    kind: 'memory',
    read: async (keys) => keys.map((k) => map.get(k) ?? null),
    write: async (puts, removes) => {
      for (const [k, v] of Object.entries(puts)) map.set(k, v);
      for (const k of removes) map.delete(k);
    },
  };
}

/** The page has no storage the saves can use: reads find nothing, every write is refused as `storage_unavailable`. */
export function unavailableProjectSaveBackend(reason: string): ProjectSaveBackend {
  return {
    kind: 'unavailable',
    read: async (keys) => keys.map(() => null),
    write: () => Promise.reject(new StorageUnavailableError(reason)),
  };
}

/**
 * IndexedDB (database `thirdlight-saves`, store `kv`), or null when the page
 * has none (a sandboxed frame, a browser with storage off). A database that
 * cannot be opened refuses as `storage_unavailable`.
 */
export function browserProjectSaveBackend(): ProjectSaveBackend | null {
  let idb: IDBFactory | null = null;
  try {
    idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null;
  } catch {
    idb = null;
  }
  if (idb === null) return null;
  const factory = idb;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open('thirdlight-saves', 1);
      } catch (e) {
        reject(new StorageUnavailableError(e instanceof Error ? e.message : 'IndexedDB refused'));
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new StorageUnavailableError(req.error?.message ?? 'IndexedDB could not open'));
    });
    // A database that could not open is tried again at the next request (the player may have freed it).
    db.catch(() => (db = null));
    return db;
  };
  /** One transaction: resolves when it commits, rejects with its error when it aborts (a refused request, the quota, a closed page). */
  const transact = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => () => T): Promise<T> => {
    const d = await open();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = d.transaction('kv', mode);
      } catch (e) {
        reject(e instanceof Error ? e : new Error('IndexedDB refused the transaction'));
        return;
      }
      let result: () => T = () => undefined as T;
      let thrown: unknown = null;
      tx.oncomplete = () => resolve(result());
      // The transaction's own error first (the quota, a refused request); else what a request threw as it was made.
      tx.onabort = () => reject(tx.error ?? thrown ?? new DOMException('the save storage transaction was aborted', 'AbortError'));
      try {
        result = body(tx.objectStore('kv'));
      } catch (e) {
        // A request refused as it was made (a full disk can refuse a put at once): nothing of the transaction stays.
        thrown = e;
        try {
          tx.abort();
        } catch {
          // already finished
        }
      }
    });
  };
  return {
    kind: 'indexeddb',
    read: (keys) =>
      transact('readonly', (store) => {
        const reqs = keys.map((k) => store.get(k));
        return () => reqs.map((r) => (typeof r.result === 'string' ? r.result : null));
      }),
    write: (puts, removes) =>
      transact('readwrite', (store) => {
        // Removes first, the puts in their order: the slot's metadata is the last request of its save.
        for (const k of removes) store.delete(k);
        for (const [k, v] of Object.entries(puts)) store.put(v, k);
        return () => undefined;
      }),
  };
}

/** The browser's storage manager (`navigator.storage`), or undefined where the page has none (an insecure origin, an older browser). */
export function browserDeviceStorage(): DeviceStorage | undefined {
  let m: StorageManager | undefined;
  try {
    m = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  } catch {
    m = undefined;
  }
  if (m === undefined || typeof m.estimate !== 'function') return undefined;
  const manager = m;
  return {
    persisted: () => (typeof manager.persisted === 'function' ? manager.persisted() : Promise.resolve(false)),
    persist: () => (typeof manager.persist === 'function' ? manager.persist() : Promise.resolve(false)),
    estimate: () => manager.estimate(),
  };
}
