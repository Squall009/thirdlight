/**
 * The header above every item editor in the editor window: the item's
 * picture, its name (renamed here, one command, where the kind can be), its
 * kind and the folder its file is in. The folder is read from the project
 * index by id, so it shows for any project size.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';

import type { DocRef } from '../../session/editor-window';
import { folderOfPath, ITEM_KIND_OF_DOCUMENT } from '../../session/project-items';
import { useCatalog } from '../catalog/catalog-context';
import { documentIcon, documentKind, type WorkspaceHost } from './kinds';

/** The folder of an item's file, read from the index (undefined while it is read; null: not in the index). */
function useItemFolder(kind: string | undefined, id: string): string | null | undefined {
  const { catalog, version } = useCatalog();
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (catalog === null || kind === undefined) return;
    let live = true;
    void catalog.entries([id], [kind]).then((found) => {
      const path = found[0]?.path ?? null;
      if (live) setFolder(path === null ? null : folderOfPath(path));
    });
    return () => {
      live = false;
    };
  }, [catalog, version, kind, id]);
  return folder;
}

export function EditorHeader({ doc, host }: { doc: DocRef; host: WorkspaceHost }): JSX.Element {
  const k = documentKind(doc.kind);
  const itemKind = ITEM_KIND_OF_DOCUMENT[doc.kind];
  const name = k?.name(doc.id, host) ?? doc.id;
  const label = k?.label ?? doc.kind;
  // A visual script's tab says "Graph" (it edits in the graph editor); its header says what it is.
  const kindName = doc.kind === 'visual-script' ? 'Visual script' : label;
  const folder = useItemFolder(itemKind, doc.id);
  const [error, setError] = useState<string | null>(null);
  const renamable = itemKind !== undefined && host.items.canRename(itemKind);
  const commit = (value: string): void => {
    const next = value.trim();
    if (itemKind === undefined || next === '' || next === name) return;
    void host.items.rename({ kind: itemKind, id: doc.id }, next).then(setError);
  };
  return (
    <header className="tl-editor-header" aria-label="editor header" data-item-kind={itemKind}>
      <img className="tl-editor-header__icon" src={documentIcon(doc.kind)} alt="" aria-hidden="true" />
      <div className="tl-editor-header__text">
        {renamable ? (
          <input
            className="tl-editor-header__name"
            aria-label={`${label.toLowerCase()} name`}
            title="Rename (Enter)"
            defaultValue={name}
            key={`${doc.id}:${name}`}
            maxLength={64}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                // Escape here undoes the typing; it does not close the window.
                e.preventDefault();
                e.stopPropagation();
                (e.target as HTMLInputElement).value = name;
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        ) : (
          <span className="tl-editor-header__name is-static">{name}</span>
        )}
        <span className="tl-editor-header__meta">
          <span className="tl-editor-header__kind">{kindName}</span>
          {folder !== undefined && (
            <span className="tl-editor-header__folder" title={folder === null ? 'not in the project index' : `in ${folder === '' ? 'the game folder' : folder}`}>
              {folder === null ? '' : folder === '' ? 'game folder' : folder}
            </span>
          )}
        </span>
      </div>
      {error !== null && (
        <span className="tl-error tl-editor-header__error" role="alert">
          {error}
        </span>
      )}
    </header>
  );
}
