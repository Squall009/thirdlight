/**
 * A list of project index entries read in pages as it is scrolled: the
 * first page when the query changes, then the pages the rows in view need
 * (a virtualized list reports them). When the index changes the pages are
 * read again; until they arrive the old ones stay on screen, so an edit does
 * not blank the list.
 *
 * Browser-only (React).
 */
import { INDEX_PAGE_DEFAULT } from '@thirdlight/project-model/limits';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { IndexEntryView, IndexQuery } from '../../session/catalog';
import { useCatalog } from './catalog-context';


export interface IndexList {
  /** Entries matching the query (null until the first page arrived). */
  readonly total: number | null;
  /** The entry at a position, when its page is read. */
  entry(index: number): IndexEntryView | undefined;
  /** Read the pages that cover [from, to). */
  need(from: number, to: number): void;
  /** Why the last page could not be read (null: it could). */
  readonly error: string | null;
}

interface Cache {
  readonly key: string;
  readonly pages: Map<number, readonly IndexEntryView[]>;
  readonly loading: Set<number>;
  total: number | null;
}

export function queryKey(q: IndexQuery): string {
  return JSON.stringify([q.kinds ?? [], q.text?.trim() ?? '', q.label ?? null, q.loadable ?? null, q.referencing ?? null, q.labels ?? [], q.folder ?? null, q.recursive ?? false, q.sort ?? null, q.descending ?? false]);
}

export function useIndexList(query: IndexQuery, enabled = true): IndexList {
  const { catalog, version } = useCatalog();
  const key = queryKey(query);
  const cacheKey = `${key}|${version}`;
  const [, redraw] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<Cache | null>(null);
  /** The pages of this query from before the index changed, shown until they are read again. */
  const staleRef = useRef<Cache | null>(null);
  if (cacheRef.current === null || cacheRef.current.key !== cacheKey) {
    const old = cacheRef.current;
    staleRef.current = old !== null && old.key.slice(0, old.key.lastIndexOf('|')) === key ? old : null;
    cacheRef.current = { key: cacheKey, pages: new Map(), loading: new Set(), total: null };
  }
  const queryRef = useRef(query);
  queryRef.current = query;

  const load = useCallback(
    (page: number) => {
      const cache = cacheRef.current;
      if (catalog === null || cache === null || !enabled || cache.pages.has(page) || cache.loading.has(page)) return;
      cache.loading.add(page);
      void catalog.page(queryRef.current, page * INDEX_PAGE_DEFAULT, INDEX_PAGE_DEFAULT).then(
        (r) => {
          cache.loading.delete(page);
          if (cacheRef.current !== cache) return;
          cache.pages.set(page, r.entries);
          cache.total = r.total;
          if (staleRef.current !== null && cache.pages.has(0)) staleRef.current = null;
          setError(null);
          redraw((n) => n + 1);
        },
        (e: unknown) => {
          cache.loading.delete(page);
          if (cacheRef.current !== cache) return;
          setError(e instanceof Error ? e.message : String(e));
        },
      );
    },
    [catalog, enabled],
  );

  // The first page of a new query (or after the index changed).
  useEffect(() => {
    load(0);
  }, [load, cacheKey]);

  // A new function per query and index version, so a list asks again for the pages it shows.
  const need = useCallback(
    (from: number, to: number) => {
      for (let p = Math.floor(from / INDEX_PAGE_DEFAULT); p <= Math.floor(Math.max(from, to - 1) / INDEX_PAGE_DEFAULT); p++) load(p);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `cacheKey` is not read here; it renews the function so the list's range effect runs again
    [load, cacheKey],
  );

  const cache = cacheRef.current;
  const stale = staleRef.current;
  return useMemo<IndexList>(
    () => ({
      total: cache.total ?? stale?.total ?? null,
      entry: (i) => {
        const p = Math.floor(i / INDEX_PAGE_DEFAULT);
        const page = cache.pages.get(p) ?? stale?.pages.get(p);
        return page?.[i - p * INDEX_PAGE_DEFAULT];
      },
      need,
      error,
    }),
    // A redraw (a page arrived) makes a new list object, so the rows draw again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `cache.total`/pages change in place; the redraw counter stands for them
    [cache, stale, need, error, cache.total, cache.pages.size],
  );
}
