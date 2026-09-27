/**
 * Phase 23.19 (E15): the page's side of project save documents — the storage
 * owner. The simulation (page or worker) asks for saves, loads and deletes
 * (`Runtime.takeSaveRequests`); this service carries them out against the
 * browser's storage and answers with entries of the next step's input
 * (`Runtime.queueSaveEvent`): the slot list, outcomes and loaded documents.
 *
 * Storage: slots in IndexedDB (a slot holds up to 1 MiB and a game up to 99 of
 * them — past localStorage's ~5 MB per origin), one key per slot for the
 * metadata (the slot list reads only these), one for the body and one for the
 * thumbnail. The project settings document is small and must be known before
 * the first step (the runtime starts with it), so it lives in the synchronous
 * key/value storage (`localStorage`) next to the flow's settings. Play and an
 * export use different namespaces, as for the flow's saves. No backend is
 * involved: an exported game keeps its saves in the player's browser.
 */
import { SAVE_LIMITS, SAVE_THUMBNAIL_DEFAULT, settingsDocumentOf, type SaveSchema, type SettingsFieldValue, projectSaveFileProblem, utf8Length, type ProjectSaveFile, type SaveEvent, type SaveRequest, type SaveSlotInfo } from '@thirdlight/runtime';

import { saveChecksum, type SaveStorage } from './save';

/** An asynchronous key/value store (IndexedDB in the browser; a Map in tests). */
export interface ProjectSaveBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Where the slots live (reported by observers). */
  readonly kind: 'indexeddb' | 'memory';
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
}

/** A captured picture of the view (a data URL of the schema's format). */
export type ThumbnailCapture = (width: number, height: number, type: 'image/jpeg' | 'image/webp', quality: number) => { dataUrl: string; width: number; height: number } | null;

export interface ProjectSaveServiceConfig {
  readonly schema: SaveSchema;
  readonly backend: ProjectSaveBackend;
  readonly namespace: string;
  /** Answers for the simulation (queued into its next step's input). */
  readonly queue: (event: SaveEvent) => void;
  /** The synchronous storage the settings document lives in (absent: settings last for the session only). */
  readonly settingsStorage?: SaveStorage;
  readonly captureThumbnail?: ThumbnailCapture;
  /** Apply an engine setting a settings field drives. */
  readonly applyEngine?: (binding: 'music' | 'sfx' | 'ui' | 'quality', value: SettingsFieldValue) => void;
  /** The player's clock (ISO text) for `savedAt`. */
  readonly now?: () => string;
  readonly log?: (message: string) => void;
}

export interface ProjectSaveService {
  /** Read the slot list and hand it to the simulation. */
  start(): Promise<void>;
  /** Carry out the simulation's requests (in order; a thumbnail is captured now, before any await). */
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
  readonly storage: 'indexeddb' | 'memory';
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
  return { slot: m.slot, title: m.title, chapter: m.chapter, location: m.location, playSeconds: m.playSeconds, savedAt: m.savedAt, version: m.version, bytes: m.bytes, ...(m.thumbnail !== undefined ? { thumbnail: m.thumbnail } : {}) };
}

function metaProblem(m: unknown, slot: number): string | null {
  const r = m as StoredMeta;
  if (typeof r !== 'object' || r === null || r.v !== 1 || r.slot !== slot) return 'not a slot record';
  if (typeof r.title !== 'string' || typeof r.chapter !== 'string' || typeof r.location !== 'string' || typeof r.savedAt !== 'string' || typeof r.sum !== 'string') return 'not a slot record';
  if (!(typeof r.playSeconds === 'number' && r.playSeconds >= 0) || !Number.isInteger(r.version) || !Number.isInteger(r.bytes)) return 'not a slot record';
  return null;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

export function createProjectSaveService(cfg: ProjectSaveServiceConfig): ProjectSaveService {
  const { schema, backend, namespace: ns } = cfg;
  const log = cfg.log ?? (() => undefined);
  const now = cfg.now ?? (() => new Date().toISOString());
  const known = new Map<number, ProjectSlotObservation>();
  const damaged = new Map<number, string>();
  let chain: Promise<void> = Promise.resolve();
  let settingsDoc = readProjectSettings(schema, cfg.settingsStorage, ns);
  const thumb = { ...SAVE_THUMBNAIL_DEFAULT, ...(schema.thumbnail ?? {}) };

  const enqueue = (job: () => Promise<void>): void => {
    chain = chain.then(job).catch((e: unknown) => log(`save storage: ${e instanceof Error ? e.message : String(e)}`));
  };
  const slotList = (): SaveSlotInfo[] => {
    const out: SaveSlotInfo[] = [];
    for (let s = 1; s <= schema.slots; s += 1) {
      const k = known.get(s);
      if (k !== undefined) out.push({ slot: k.slot, title: clip(k.title, SAVE_LIMITS.metaText), chapter: clip(k.chapter, SAVE_LIMITS.metaText), location: clip(k.location, SAVE_LIMITS.metaText), playSeconds: k.playSeconds, savedAt: clip(k.savedAt, 40), version: k.version, bytes: k.bytes, thumbnail: k.thumbnail !== undefined });
      else if (damaged.has(s)) out.push({ slot: s, title: '', chapter: '', location: '', playSeconds: 0, savedAt: '', version: 0, bytes: 0, thumbnail: false, damaged: damaged.get(s)! });
    }
    return out;
  };
  const sendSlots = (): void => cfg.queue({ kind: 'slots', slots: slotList() });

  const readSlot = async (s: number): Promise<void> => {
    const raw = await backend.get(metaKey(ns, s));
    known.delete(s);
    damaged.delete(s);
    if (raw === null) return;
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
        ...(picture !== null ? { thumbnail: { type, width: picture.width, height: picture.height, bytes: picture.dataUrl.length } } : {}),
      };
      try {
        await backend.set(bodyKey(ns, r.slot), r.text);
        if (picture !== null) await backend.set(thumbKey(ns, r.slot), picture.dataUrl);
        else await backend.remove(thumbKey(ns, r.slot));
        await backend.set(metaKey(ns, r.slot), JSON.stringify(meta));
      } catch (e) {
        cfg.queue({ kind: 'saved', slot: r.slot, ok: false, reason: clip(e instanceof Error ? e.message : 'storage refused the save', 200) });
        return;
      }
      known.set(r.slot, slotOf(meta));
      damaged.delete(r.slot);
      cfg.queue({ kind: 'saved', slot: r.slot, ok: true });
      sendSlots();
    });
  };

  const load = (slot: number): Promise<void> => {
    let done!: () => void;
    const settled = new Promise<void>((resolve) => (done = resolve));
    enqueue(async () => {
      try {
        const [rawMeta, body] = await Promise.all([backend.get(metaKey(ns, slot)), backend.get(bodyKey(ns, slot))]);
        const fail = (reason: string): void => cfg.queue({ kind: 'loaded', slot, ok: false, reason });
        if (rawMeta === null || body === null) return fail(`save slot ${slot} is empty`);
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
        await backend.remove(metaKey(ns, slot));
        await backend.remove(bodyKey(ns, slot));
        await backend.remove(thumbKey(ns, slot));
      } catch (e) {
        cfg.queue({ kind: 'deleted', slot, ok: false, reason: clip(e instanceof Error ? e.message : 'storage refused', 200) });
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
    async start() {
      enqueue(async () => {
        for (let s = 1; s <= schema.slots; s += 1) await readSlot(s);
        sendSlots();
      });
      await chain;
    },
    handle(requests) {
      for (const r of requests) {
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
            try {
              cfg.settingsStorage?.set(settingsKey(ns), JSON.stringify(settingsDoc));
            } catch {
              // storage full or refused: the settings still apply for this session
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
      return backend.get(thumbKey(ns, slot));
    },
    settings: () => settingsDoc,
    idle: async () => {
      let before: Promise<void>;
      do {
        before = chain;
        await before;
      } while (before !== chain);
    },
  };
}

/** A Map-backed store (tests; a page without IndexedDB keeps saves for the session only). */
export function memoryProjectSaveBackend(map: Map<string, string> = new Map()): ProjectSaveBackend {
  return {
    kind: 'memory',
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

/**
 * IndexedDB (database `thirdlight-saves`, store `kv`), or null when the page
 * has none (a sandboxed frame, a browser with storage off).
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
        reject(e instanceof Error ? e : new Error('IndexedDB refused'));
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB could not open'));
    });
    return db;
  };
  const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
    const d = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction('kv', mode);
      const req = body(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  };
  return {
    kind: 'indexeddb',
    get: async (k) => {
      const v = await run<unknown>('readonly', (s) => s.get(k));
      return typeof v === 'string' ? v : null;
    },
    set: async (k, v) => {
      await run('readwrite', (s) => s.put(v, k));
    },
    remove: async (k) => {
      await run('readwrite', (s) => s.delete(k));
    },
  };
}
