/**
 * What an Inspector reference's "Open" does: the project window's own
 * double-click (a material, a graph, a script, … opens in the editor
 * window), offered to every reference picker below the editor root without
 * passing it down through each panel.
 *
 * Browser-only (React).
 */
import { createContext, useContext, type JSX, type ReactNode } from 'react';

import { documentOfItem } from '../../session/project-items';

export interface ItemOpener {
  /** Open a project item (an index entry's kind and id) as a double-click in the project window does. */
  open(item: { kind: string; id: string }): void;
}

const ItemOpenerContext = createContext<ItemOpener | null>(null);

export function ItemOpenerProvider(p: { opener: ItemOpener; children: ReactNode }): JSX.Element {
  return <ItemOpenerContext.Provider value={p.opener}>{p.children}</ItemOpenerContext.Provider>;
}

/** The opener for an item of this index kind, or null when no editor opens it (assets, scenes) or none is provided. */
export function useItemOpener(kind: string | null): ((id: string) => void) | null {
  const opener = useContext(ItemOpenerContext);
  if (opener === null || kind === null || documentOfItem({ kind, id: '' }) === null) return null;
  return (id) => opener.open({ kind, id });
}

/** "Open" beside a reference: shown when the referenced item opens in an editor. */
export function OpenItemButton(p: { kind: string | null; id: string; aria: string }): JSX.Element | null {
  const open = useItemOpener(p.id === '' ? null : p.kind);
  if (open === null) return null;
  return (
    <button type="button" className="tl-btn tl-btn--small tl-ref__open" aria-label={`Open ${p.aria}`} title="Open in the editor window" onClick={() => open(p.id)}>
      Open
    </button>
  );
}
