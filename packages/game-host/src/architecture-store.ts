/**
 * Generated architecture's chunks kept in the player's browser between
 * visits (IndexedDB database `thirdlight-architecture`, store `chunks`), by
 * the chunk's key: the hash of the generator version and every parameter
 * and sheet the chunk is made from, so a key never names stale meshes and a
 * second visit draws without generating. Clipped decals' meshes are kept
 * here too, by their own keys (clipped-decals.ts). An exported game uses it;
 * Play generates afresh (its parameters change with every edit).
 *
 * A cache, not a save: anything that fails (no IndexedDB, a full disk) just
 * means the chunk is generated again.
 */

const DB = 'thirdlight-architecture';
const STORE = 'chunks';
/**
 * Entries (chunks and clipped decals' meshes) kept before the store is
 * emptied and starts again (each a few to tens of kilobytes): a cache's
 * bound on the player's disk, not a project's.
 */
export const ARCHITECTURE_STORE_MAX_CHUNKS = 8192;

/** Made chunks by key (the shape the adapter's `architectureStore` takes). */
export interface BrowserArchitectureStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): void;
}

/** The store (null: the page has no IndexedDB). */
export function browserArchitectureStore(): BrowserArchitectureStore | null {
  let factory: IDBFactory | null = null;
  try {
    factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null;
  } catch {
    factory = null;
  }
  if (factory === null) return null;
  const idb = factory;
  let db: Promise<IDBDatabase | null> | null = null;
  const open = (): Promise<IDBDatabase | null> => {
    db ??= new Promise<IDBDatabase | null>((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = idb.open(DB, 1);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const d = req.result;
        // Past the bound, start again (the next visit fills it with what the game uses now).
        try {
          const tx = d.transaction(STORE, 'readwrite');
          const count = tx.objectStore(STORE).count();
          count.onsuccess = () => {
            if (count.result > ARCHITECTURE_STORE_MAX_CHUNKS) tx.objectStore(STORE).clear();
          };
        } catch {
          // a cache: nothing to do
        }
        resolve(d);
      };
      req.onerror = () => resolve(null);
    });
    return db;
  };
  // Opened now, while the game loads: the first chunk asked for does not wait on the database opening.
  void open();
  /** What was made since the last write, written in one transaction. */
  const pending = new Map<string, Uint8Array>();
  let flushing = false;
  return {
    get: async (key) => {
      const d = await open();
      if (d === null) return null;
      return new Promise<Uint8Array | null>((resolve) => {
        try {
          const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
          req.onsuccess = () => resolve(req.result instanceof Uint8Array ? req.result : req.result instanceof ArrayBuffer ? new Uint8Array(req.result) : null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    },
    put: (key, bytes) => {
      // Written together, one transaction for what a frame made: a level's load makes hundreds (clipped decals),
      // and a transaction each kept the database busy long after the level was drawn.
      pending.set(key, bytes);
      if (flushing) return;
      flushing = true;
      setTimeout(() => {
        flushing = false;
        const batch = [...pending];
        pending.clear();
        void open().then((d) => {
          if (d === null) return;
          try {
            const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
            for (const [k, b] of batch) store.put(b, k);
          } catch {
            // a cache: what was not written is made again next time
          }
        });
      }, 0);
    },
  };
}
