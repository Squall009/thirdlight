/**
 * The session's catalog for every panel, picker and list below the editor
 * root, without passing it down through each: the index pages and the
 * records read by id (session/catalog.ts), and the counters that say when
 * lists should read their pages again (`version`) and when records waited on
 * arrived (`loaded`).
 *
 * Browser-only (React).
 */
import { createContext, useContext, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';

import type { AssetView } from '../../session/content-projection';
import type { Catalog } from '../../session/catalog';

export interface CatalogView {
  readonly catalog: Catalog | null;
  /** The asset summaries read so far (by id). */
  readonly asset: (assetId: string) => AssetView | undefined;
  readonly version: number;
  readonly loaded: number;
}

const NONE: CatalogView = { catalog: null, asset: () => undefined, version: 0, loaded: 0 };
const CatalogContext = createContext<CatalogView>(NONE);

export function CatalogProvider(p: { catalog: Catalog | null; asset: (assetId: string) => AssetView | undefined; children: ReactNode }): JSX.Element {
  const [counters, setCounters] = useState({ version: 0, loaded: 0 });
  const { catalog, asset } = p;
  useEffect(() => {
    if (catalog === null) return;
    const read = (): void => setCounters((c) => (c.version === catalog.version && c.loaded === catalog.loaded ? c : { version: catalog.version, loaded: catalog.loaded }));
    read();
    return catalog.subscribe(read);
  }, [catalog]);
  const value = useMemo<CatalogView>(() => ({ catalog, asset, version: counters.version, loaded: counters.loaded }), [catalog, asset, counters]);
  return <CatalogContext.Provider value={value}>{p.children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogView {
  return useContext(CatalogContext);
}

/**
 * Asset summaries by id for a view: the ones not read yet are asked for, and
 * the view draws again when they arrive (undefined until then, or when no
 * such asset exists).
 */
export function useAssetSummaries(ids: readonly string[]): (AssetView | undefined)[] {
  const view = useCatalog();
  const key = ids.join('\u0000');
  useEffect(() => {
    if (view.catalog === null || key === '') return;
    void view.catalog.ensureAssets(key.split('\u0000'));
  }, [view.catalog, view.version, key]);
  // The context changes when records arrive (`loaded`), so the view draws again then.
  return ids.map((id) => view.asset(id));
}

/**
 * Which of these ids may name a texture: the ones read and found to be
 * textures, and the ones not read yet (a check that a reference resolves
 * waits for them rather than reporting them missing). The ones the backend
 * does not know, or that are other kinds, are left out.
 */
export function useTextureIds(candidates: readonly string[]): ReadonlySet<string> {
  const view = useCatalog();
  const key = [...new Set(candidates)].sort().join('\u0000');
  useEffect(() => {
    if (view.catalog === null || key === '') return;
    void view.catalog.ensureAssets(key.split('\u0000'));
  }, [view.catalog, view.version, key]);
  return useMemo(() => {
    const out = new Set<string>();
    if (key === '') return out;
    for (const id of key.split('\u0000')) {
      const a = view.asset(id);
      if (a !== undefined ? a.kind === 'texture' : view.catalog === null || !view.catalog.assetAbsent(id)) out.add(id);
    }
    return out;
    // `loaded` stands for the summaries that arrived since.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the summaries change in place; `loaded` counts their arrivals
  }, [key, view.loaded, view.version, view.catalog, view.asset]);
}

/** Every string in a value (the ids a record may name). */
export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value !== '') out.push(value);
  } else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}
