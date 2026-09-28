/**
 * The key/value storage a game keeps its player settings in — injected by
 * the wrapper (`localStorage` in the browser; a Map in tests), keyed by the
 * game's namespace (Play and an export use different ones). What lives there:
 * the player's changed input bindings per profile (the rebinding API), the
 * game shell's settings (volumes, quality) and a project's settings document.
 * Project save slots live elsewhere (IndexedDB, see `project-saves.ts`).
 */

/** The storage the wrapper injects (a `localStorage` adapter; a Map in tests). */
export interface SaveStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The largest stored entry read back (a longer one is ignored). */
export const SAVE_MAX_BYTES = 65_536;

/** FNV-1a 32-bit over the UTF-16 code units, as 8 hex digits. */
export function saveChecksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The player's settings of one game (its namespace in the injected storage). */
export interface SettingsStore {
  /**
   * Phase 23.14: a player profile's changed bindings (action → its bindings;
   * null when the profile saved none or the entry is unreadable).
   */
  readBindings(profile: string): Record<string, unknown[]> | null;
  writeBindings(profile: string, actions: Record<string, unknown[]>): void;
  /** Forget this game's stored settings (the default profile's bindings, the shell's and the project's settings). */
  clear(): void;
}

/** The keys `clear()` removes (under the namespace). */
const CLEARED_KEYS = ['bindings:default', 'shell-settings', 'project-settings'];

export function createSettingsStore(storage: SaveStorage, namespace: string): SettingsStore {
  const key = (k: string): string => `${namespace}:${k}`;
  const safeGet = (k: string): string | null => {
    try {
      return storage.get(key(k));
    } catch {
      return null;
    }
  };
  return {
    readBindings(profile) {
      const raw = safeGet(`bindings:${profile}`);
      if (raw === null || raw.length > SAVE_MAX_BYTES) return null;
      try {
        const d = JSON.parse(raw) as { version?: unknown; actions?: unknown };
        if (d.version !== 1 || typeof d.actions !== 'object' || d.actions === null || Array.isArray(d.actions)) return null;
        return Object.fromEntries(Object.entries(d.actions).filter(([k, v]) => /^[A-Za-z_]\w{0,31}$/.test(k) && Array.isArray(v))) as Record<string, unknown[]>;
      } catch {
        return null;
      }
    },
    writeBindings(profile, actions) {
      try {
        storage.set(key(`bindings:${profile}`), JSON.stringify({ version: 1, actions }));
      } catch {
        // storage full or refused: the bindings still apply for this session
      }
    },
    clear() {
      for (const k of CLEARED_KEYS) {
        try {
          storage.remove(key(k));
        } catch {
          // nothing to clear
        }
      }
    },
  };
}

/** A `localStorage` adapter that never throws on access (sandboxed or disabled storage reads as empty). */
export function browserSaveStorage(): SaveStorage | null {
  let ls: Storage | null = null;
  try {
    ls = (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    ls = null;
  }
  if (ls === null) return null;
  const store = ls;
  return {
    get: (k) => store.getItem(k),
    set: (k, v) => store.setItem(k, v),
    remove: (k) => store.removeItem(k),
  };
}
