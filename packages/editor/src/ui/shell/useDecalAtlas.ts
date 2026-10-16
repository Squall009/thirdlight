/**
 * The decal atlas's wiring: the decal pages Play and the export will use
 * (read from the backend while the decal editor's atlas panel is there, or while the Scene view
 * draws from composed pages), Rebuild pages (one composition on the backend),
 * and which composed pages the Scene view draws from.
 *
 * The Scene view draws from composed pages only while they are the pages the
 * project's build would make now: an edit that changes them (a decal of a new
 * material, a texture imported again) makes the backend answer without them,
 * and the view goes back to the materials' own textures until the next
 * Rebuild; so does a read that fails (the pages can no longer be checked).
 * "Scene view draws from the pages" off keeps the own textures.
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DecalPageRef } from '@thirdlight/project-model';

import type { DecalAtlasView } from '../../session/decal-atlas';
import type { ClientRef } from './commands';

const DRAW_KEY = 'thirdlight.decalAtlas.draw.v1';
/** A burst of edits is read once, after it. */
const REFRESH_DELAY_MS = 400;

const stored = (key: string, fallback: boolean): boolean => {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const store = (key: string, v: boolean): void => {
  try {
    window.localStorage.setItem(key, v ? '1' : '0');
  } catch {
    // A browser without storage keeps it for this page only.
  }
};

export interface DecalAtlas {
  /** The pages (null: not read yet). */
  readonly view: DecalAtlasView | null;
  /** A read or a composition under way. */
  readonly busy: 'reading' | 'composing' | null;
  readonly error: string | null;
  /** The Scene view draws from composed pages when there are current ones (remembered per browser). */
  readonly drawFromPages: boolean;
  setDrawFromPages(on: boolean): void;
  /** The atlas panel shows (the decal editor is open): the pages are read while it does. */
  setShown(shown: boolean): void;
  /** Compose the pages now. */
  rebuild(): Promise<void>;
  /** The places the Scene view draws from (null: the materials' own textures); the same pages keep their signature. */
  readonly drawn: { readonly signature: string; readonly refs: Readonly<Record<string, DecalPageRef>> } | null;
}

/** `watch`: what the pages are made of as the editor sees it (a change reads them again when they matter). */
export function useDecalAtlas(o: { clientRef: ClientRef; watch: string }): DecalAtlas {
  const { clientRef, watch } = o;
  const [view, setView] = useState<DecalAtlasView | null>(null);
  const [busy, setBusy] = useState<DecalAtlas['busy']>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawFromPages, setDrawState] = useState(() => stored(DRAW_KEY, true));
  const [shown, setShown] = useState(false);
  const composing = useRef(false);

  const read = useCallback(async () => {
    const c = clientRef.current;
    if (c === null || composing.current) return;
    setBusy('reading');
    const r = await c.decalAtlas(false);
    if (composing.current) return;
    setBusy(null);
    if (r.ok) {
      setView(r.view);
      setError(null);
    } else {
      setError(r.error.message);
      // Unread pages may be out of date: the view goes back to the materials' own textures.
      setView((v) => (v === null || v.composed === null ? v : { ...v, composed: null }));
    }
  }, [clientRef]);

  // Read while the atlas panel shows, or while composed pages are drawn (they may have gone out of date).
  const matters = shown || (drawFromPages && (view?.composed ?? null) !== null);
  useEffect(() => {
    if (!matters) return;
    const t = setTimeout(() => void read(), REFRESH_DELAY_MS);
    return () => clearTimeout(t);
  }, [watch, matters, read]);
  // Shown: read at once.
  useEffect(() => {
    if (shown) void read();
  }, [shown, read]);

  const rebuild = useCallback(async () => {
    const c = clientRef.current;
    if (c === null || composing.current) return;
    composing.current = true;
    setBusy('composing');
    try {
      const r = await c.decalAtlas(true);
      if (r.ok) {
        setView(r.view);
        setError(null);
      } else setError(r.error.message);
    } finally {
      composing.current = false;
      setBusy(null);
    }
  }, [clientRef]);

  const setDrawFromPages = useCallback((v: boolean) => {
    setDrawState(v);
    store(DRAW_KEY, v);
  }, []);

  const composed = view?.composed ?? null;
  return { view, busy, error, drawFromPages, setDrawFromPages, setShown, rebuild, drawn: drawFromPages ? composed : null };
}
