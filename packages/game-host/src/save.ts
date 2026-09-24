/**
 * Phase 9.11: the player's saves — three slots and an autosave, plus the
 * settings — in a key/value storage the wrapper injects (`localStorage` in the
 * browser; Play and an export use different namespaces). Each slot is one
 * versioned JSON document (≤ 64 KB) carrying an FNV-1a checksum: a slot that
 * does not parse, has another version or a wrong checksum is reported as
 * damaged and ignored, never loaded.
 */
import type { RunSaveState } from '@thirdlight/runtime';

/** The storage the wrapper injects (a `localStorage` adapter; a Map in tests). */
export interface SaveStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type SaveSlot = 'auto' | '1' | '2' | '3';
export const SAVE_SLOTS: readonly SaveSlot[] = ['auto', '1', '2', '3'];
export const SAVE_MAX_BYTES = 65_536;
export const SAVE_VERSION = 1;

export interface SaveDocument {
  version: number;
  savedAt: string;
  levelId: string;
  levelIndex: number;
  levelName: string;
  lives: number | null;
  run: RunSaveState;
  /** Per level: what was collected there and the best time. */
  levels: Record<string, { collected: string[]; bestSeconds?: number }>;
  /** Phase 14.3: the game's score from the levels completed before this save (with score rules). */
  score?: number;
}

/**
 * Phase 14.3: records kept apart from the slots (best score per level id),
 * so they survive a new game and the last level (which writes no autosave).
 */
export interface SaveRecords {
  bestScores: Record<string, number>;
}

export interface SaveSettings {
  music: number;
  sfx: number;
  quality: 'low' | 'medium' | 'high';
  /** Rebound keys by action name. */
  keys: Record<string, string>;
  /** Phase 14.5: the menu-sound volume (absent: the game's default). */
  ui?: number;
  /** Phase 14.5: rebound pad buttons by action name (`left`/`right`: the move buttons). */
  pad?: Record<string, number>;
}

export type SlotState = { state: 'ok'; doc: SaveDocument } | { state: 'empty' } | { state: 'damaged'; reason: string };

/** FNV-1a 32-bit over the UTF-16 code units, as 8 hex digits. */
export function saveChecksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface SaveStore {
  read(slot: SaveSlot): SlotState;
  write(slot: SaveSlot, doc: SaveDocument): { ok: true } | { ok: false; reason: string };
  readSettings(): SaveSettings | null;
  writeSettings(s: SaveSettings): void;
  /** Phase 14.3: the best scores per level (empty when none or unreadable). */
  readRecords(): SaveRecords;
  writeRecords(r: SaveRecords): void;
  /** Every slot and the settings of this game's namespace. */
  clear(): void;
}

export function createSaveStore(storage: SaveStorage, namespace: string): SaveStore {
  const key = (k: string): string => `${namespace}:${k}`;
  const safeGet = (k: string): string | null => {
    try {
      return storage.get(key(k));
    } catch {
      return null;
    }
  };
  return {
    read(slot) {
      const raw = safeGet(slot);
      if (raw === null) return { state: 'empty' };
      if (raw.length > SAVE_MAX_BYTES) return { state: 'damaged', reason: 'too large' };
      try {
        const wrapper = JSON.parse(raw) as { sum?: unknown; body?: unknown };
        if (typeof wrapper.sum !== 'string' || typeof wrapper.body !== 'string') return { state: 'damaged', reason: 'not a save' };
        if (saveChecksum(wrapper.body) !== wrapper.sum) return { state: 'damaged', reason: 'checksum mismatch' };
        const doc = JSON.parse(wrapper.body) as SaveDocument;
        if (doc.version !== SAVE_VERSION || typeof doc.levelId !== 'string' || typeof doc.run !== 'object' || doc.run === null) return { state: 'damaged', reason: 'unknown version' };
        return { state: 'ok', doc };
      } catch {
        return { state: 'damaged', reason: 'does not parse' };
      }
    },
    write(slot, doc) {
      const body = JSON.stringify(doc);
      const text = JSON.stringify({ sum: saveChecksum(body), body });
      if (text.length > SAVE_MAX_BYTES) return { ok: false, reason: `the save is larger than ${SAVE_MAX_BYTES} bytes` };
      try {
        storage.set(key(slot), text);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message.slice(0, 120) : 'storage refused the save' };
      }
    },
    readSettings() {
      const raw = safeGet('settings');
      if (raw === null) return null;
      try {
        const s = JSON.parse(raw) as Partial<SaveSettings>;
        const unit = (v: unknown, d: number): number => (typeof v === 'number' && v >= 0 && v <= 1 ? v : d);
        return {
          music: unit(s.music, 0.8),
          sfx: unit(s.sfx, 1),
          quality: s.quality === 'low' || s.quality === 'medium' ? s.quality : 'high',
          keys: typeof s.keys === 'object' && s.keys !== null ? Object.fromEntries(Object.entries(s.keys).filter(([k, v]) => /^[A-Za-z_]\w{0,31}$/.test(k) && typeof v === 'string' && /^[A-Za-z0-9]{1,32}$/.test(v))) : {},
          ...(typeof s.ui === 'number' && s.ui >= 0 && s.ui <= 1 ? { ui: s.ui } : {}),
          ...(typeof s.pad === 'object' && s.pad !== null && !Array.isArray(s.pad)
            ? { pad: Object.fromEntries(Object.entries(s.pad).filter(([k, v]) => /^[A-Za-z_]\w{0,31}$/.test(k) && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 31)) }
            : {}),
        };
      } catch {
        return null;
      }
    },
    writeSettings(s) {
      try {
        storage.set(key('settings'), JSON.stringify(s));
      } catch {
        // storage full or refused: the settings still apply for this session
      }
    },
    readRecords() {
      const raw = safeGet('records');
      if (raw === null || raw.length > SAVE_MAX_BYTES) return { bestScores: {} };
      try {
        const r = JSON.parse(raw) as { bestScores?: unknown };
        const b = r.bestScores;
        if (typeof b !== 'object' || b === null || Array.isArray(b)) return { bestScores: {} };
        return { bestScores: Object.fromEntries(Object.entries(b).filter(([k, v]) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(k) && Number.isSafeInteger(v))) as Record<string, number> };
      } catch {
        return { bestScores: {} };
      }
    },
    writeRecords(r) {
      try {
        storage.set(key('records'), JSON.stringify({ bestScores: r.bestScores }));
      } catch {
        // storage full or refused: the records still hold for this session
      }
    },
    clear() {
      for (const k of [...SAVE_SLOTS, 'settings', 'records']) {
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
