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
 * Rebuild shows a cold atlas's pages at a preview size first (seconds
 * sooner), then the pages themselves once composed; their arrays are decoded
 * before the view swaps to them, so the decals never blink out between.
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DecalPageRef } from '@thirdlight/project-model';

import { decalPageArrayIds, type DecalAtlasView } from '../../session/decal-atlas';
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
  /** A read or a composition under way (`finishing`: the preview shows, the pages themselves are composed). */
  readonly busy: 'reading' | 'composing' | 'finishing' | null;
  readonly error: string | null;
  /** The Scene view draws from composed pages when there are current ones (remembered per browser). */
  readonly drawFromPages: boolean;
  setDrawFromPages(on: boolean): void;
  /** The atlas panel shows (the decal editor is open): the pages are read while it does. */
  setShown(shown: boolean): void;
  /** Compose the pages now. */
  rebuild(): Promise<void>;
  /** The places the Scene view draws from (null: the materials' own textures); the same pages keep their signature. */
  readonly drawn: { readonly signature: string; readonly refs: Readonly<Record<string, DecalPageRef>>; readonly preview?: true } | null;
  /**
   * The last Rebuild that went through preview pages: the preview's time and the wait for the pages from the click.
   * The backend's own answer for the pages times only its last request, which finds them composed behind the preview.
   */
  readonly rebuilt: { readonly previewMs: number; readonly ms: number; readonly signature: string } | null;
}

/** How long the decoded pages are held past the swap (the decals' materials take their own holds within a frame or two). */
const PRELOAD_HOLD_MS = 2000;

/**
 * `watch`: what the pages are made of as the editor sees it (a change reads them again when they matter);
 * `preload`: decode these page arrays (`decalPageArrayIds`) ahead of the swap to them, held until let go.
 */
export function useDecalAtlas(o: { clientRef: ClientRef; watch: string; preload?: (arrayIds: readonly string[]) => { readonly ready: Promise<void>; release(): void } | null }): DecalAtlas {
  const { clientRef, watch, preload } = o;
  const [view, setView] = useState<DecalAtlasView | null>(null);
  const [busy, setBusy] = useState<DecalAtlas['busy']>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawFromPages, setDrawState] = useState(() => stored(DRAW_KEY, true));
  const [shown, setShown] = useState(false);
  const [rebuilt, setRebuilt] = useState<DecalAtlas['rebuilt']>(null);
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
    const started = performance.now();
    try {
      const first = await c.decalAtlas(true, true);
      if (!first.ok) {
        setError(first.error.message);
        return;
      }
      setView(first.view);
      setError(null);
      if (first.view.composed?.preview !== true) return;
      // The preview shows; the pages themselves are composed behind it.
      setBusy('finishing');
      // The preview's own time, as the status said while it showed.
      const previewMs = first.view.composed.ms;
      const r = await c.decalAtlas(true);
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      const held = r.view.composed !== null ? (preload?.(decalPageArrayIds(r.view.composed.refs)) ?? null) : null;
      await held?.ready;
      setView(r.view);
      if (r.view.composed !== null) setRebuilt({ previewMs, ms: Math.round(performance.now() - started), signature: r.view.composed.signature });
      if (held !== null) setTimeout(() => held.release(), PRELOAD_HOLD_MS);
    } finally {
      composing.current = false;
      setBusy(null);
    }
  }, [clientRef, preload]);

  const setDrawFromPages = useCallback((v: boolean) => {
    setDrawState(v);
    store(DRAW_KEY, v);
  }, []);

  const composed = view?.composed ?? null;
  return { view, busy, error, drawFromPages, setDrawFromPages, setShown, rebuild, drawn: drawFromPages ? composed : null, rebuilt };
}
