/**
 * The project window's folder tree (Unity's left pane, Godot's FileSystem
 * dock): "All assets" (every asset file, wherever it is) and the game
 * folder's real folders, read a level at a time as they are opened and again
 * when the project changes. A folder is chosen with a click, opened with its
 * arrow, and is a drop target: items and folders dropped on it move into it.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type DragEvent, type JSX } from 'react';

import type { FolderView } from '../../session/catalog';
import { folderTrail } from '../../session/project-items';
import { useCatalog } from '../catalog/catalog-context';
import { FolderIcon } from './ProjectTiles';

interface Props {
  /** The chosen folder (null: All assets). */
  folder: string | null;
  onFolder: (folder: string | null) => void;
  /** Where a drop target is (the folder being dragged over), for its highlight. */
  dropping: string | null;
  onDragOver: (ev: DragEvent<HTMLElement>, folder: string) => void;
  onDragLeave: () => void;
  onDrop: (ev: DragEvent<HTMLElement>, folder: string) => void;
}

/** The subfolders of the folders asked for, read again when the project changes. */
function useFolders(open: ReadonlySet<string>): ReadonlyMap<string, readonly FolderView[]> {
  const { catalog, version } = useCatalog();
  const [read, setRead] = useState<{ version: number; map: Map<string, readonly FolderView[]> }>({ version: -1, map: new Map() });
  // The game folder's top is the empty path: the key is a list, not a joined string.
  const key = JSON.stringify([...open].sort());
  useEffect(() => {
    if (catalog === null) return;
    let live = true;
    const folders = JSON.parse(key) as string[];
    void Promise.all(folders.map((f) => catalog.folders(f).then((list) => [f, list] as const, () => [f, [] as FolderView[]] as const))).then((rows) => {
      if (live) setRead({ version, map: new Map(rows) });
    });
    return () => {
      live = false;
    };
  }, [catalog, version, key]);
  return read.map;
}

export function FolderTree(p: Props): JSX.Element {
  // The game folder's top is always open; a chosen folder's parents open with it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['']));
  useEffect(() => {
    if (p.folder === null) return;
    const trail = ['', ...folderTrail(p.folder).slice(0, -1)];
    setExpanded((e) => (trail.every((f) => e.has(f)) ? e : new Set([...e, ...trail])));
  }, [p.folder]);
  const children = useFolders(expanded);
  const toggle = (folder: string): void =>
    setExpanded((e) => {
      const next = new Set(e);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  const node = (folder: string, name: string, depth: number, hasFolders: boolean): JSX.Element => {
    const open = expanded.has(folder);
    const list = children.get(folder);
    return (
      <li key={`f:${folder}`} role="treeitem" aria-expanded={hasFolders ? open : undefined} aria-selected={p.folder === folder}>
        <div
          className={`tl-project__node${p.folder === folder ? ' is-selected' : ''}${p.dropping === folder ? ' is-drop' : ''}`}
          style={{ paddingLeft: 4 + depth * 12 }}
          data-tree-folder={folder}
          onDragOver={(ev) => p.onDragOver(ev, folder)}
          onDragLeave={p.onDragLeave}
          onDrop={(ev) => p.onDrop(ev, folder)}
        >
          <button className="tl-project__twist" aria-label={`${open ? 'hide' : 'show'} the subfolders of ${folder === '' ? 'the game folder' : folder}`} disabled={!hasFolders} onClick={() => toggle(folder)}>
            {hasFolders ? (open ? '▾' : '▸') : ''}
          </button>
          <button className="tl-project__node-name" aria-label={`folder ${folder === '' ? '(game folder)' : folder}`} onClick={() => p.onFolder(folder)} title={folder === '' ? 'The game folder' : folder}>
            <FolderIcon />
            {name}
          </button>
        </div>
        {open && list !== undefined && list.length > 0 && <ul role="group">{list.map((c) => node(c.path, c.name, depth + 1, c.hasFolders))}</ul>}
      </li>
    );
  };

  return (
    <ul className="tl-project__tree" role="tree" aria-label="project folders">
      <li role="treeitem" aria-selected={p.folder === null}>
        <div className={`tl-project__node${p.folder === null ? ' is-selected' : ''}`} style={{ paddingLeft: 4 }}>
          <span className="tl-project__twist" />
          <button className="tl-project__node-name" aria-label="all assets" onClick={() => p.onFolder(null)} title="Every asset file (models, textures, audio, fonts), wherever it is">
            All assets
          </button>
        </div>
      </li>
      {node('', 'Game folder', 0, true)}
    </ul>
  );
}
