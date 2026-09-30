/**
 * The project window (Unity's Project window, Godot's FileSystem dock): the
 * game folder's real folders on the left, the chosen folder's subfolders and
 * files on the right — every asset, resource and scene — or "All assets", every
 * asset file wherever it is. The list pages from the project index, so it
 * scrolls tens of thousands of items at the cost of a screenful.
 *
 * - Browsing: Unity's search (`t:audio l:voice name`; in a folder it searches
 *   that folder and below), a kind menu that writes the `t:`, sort, grid or list
 *   with a tile-size slider, a breadcrumb.
 * - Choosing: click, Ctrl/Cmd-click, Shift-click a range (read from the index
 *   when it is not on screen), Ctrl/Cmd-A all.
 * - Moving: drag items and folders onto a folder (a tile, the tree, the
 *   breadcrumb), or cut (Ctrl/Cmd-X) and paste (Ctrl/Cmd-V) into the folder
 *   shown; each move is one command and one undo. New folder, rename folder.
 * - Opening: a double-click opens a folder, or the item's editor.
 *
 * Display and intent only: every change is a command through the session.
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent } from 'react';

import { ASSET_KINDS, INDEX_PAGE_DEFAULT, INDEX_PAGE_MAX } from '@thirdlight/project-model/limits';

import type { FolderView, IndexEntryView, IndexQuery } from '../../session/catalog';
import { ASSET_DRAG_TYPE } from '../../session/placement';
import { PROJECT_KINDS, parseSearch, typeOf, withType } from '../../session/project-search';
import { folderKey, folderTrail, freeFolderName, isAssetKind, isWithin, itemKey, parseProjectDrag, PROJECT_DRAG_TYPE, selectionOf, type ProjectItem, type ProjectSelection } from '../../session/project-items';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { useCatalog } from '../catalog/catalog-context';
import { useIndexList } from '../catalog/useIndexList';
import { VirtualList } from '../catalog/VirtualList';
import { MATERIAL_DRAG_TYPE } from '../MaterialsPanel';
import { LabelsBar } from '../LoadableFields';
import type { LoadingNameActions } from '../useLoadingNames';
import { FolderTree } from './FolderTree';
import { AssetTile, FolderTile, ItemTile, PieceTile, type ChooseEvent, type ProjectView } from './ProjectTiles';
import type { ProjectCommands } from './useProjectCommands';

interface Props {
  /** The chosen folder (null: All assets). */
  folder: string | null;
  onFolder: (folder: string | null) => void;
  selectedAssetId: string | null;
  onSelectAsset: (assetId: string) => void;
  /** A resource or scene was chosen (null: an asset or nothing): the side panel shows it. */
  onFocus: (entry: IndexEntryView | null) => void;
  onOpen: (item: ProjectItem) => void;
  commands: ProjectCommands;
  loading?: LoadingNameActions;
  thumbnails: TileThumbnails | null;
  /** The selected model's pieces (a file of 2+ expands into piece tiles). */
  pieces: { assetId: string; list: readonly { name: string }[] } | null;
  /** A model file's name (a piece tile's title). */
  fileName: (assetId: string) => string;
}

type Sort = '' | 'name' | 'kind' | 'path';
const TILE_GAP = 8;
const TILE_PADDING = 8;
const ROW_STRIDE = 26;
const DEFAULT_TILE = 112;

/** The folders a folder view shows before its files (none while searching or in All assets). */
function useSubfolders(folder: string | null): readonly FolderView[] {
  const { catalog, version } = useCatalog();
  const [list, setList] = useState<readonly FolderView[]>([]);
  useEffect(() => {
    if (catalog === null || folder === null) {
      setList([]);
      return;
    }
    let live = true;
    void catalog.folders(folder).then(
      (l) => live && setList(l),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [catalog, version, folder]);
  return list;
}

export function ProjectWindow(p: Props): JSX.Element {
  const { catalog } = useCatalog();
  const [text, setText] = useState('');
  const [sort, setSort] = useState<Sort>('');
  const [descending, setDescending] = useState(false);
  const [view, setView] = useState<ProjectView>('grid');
  const [size, setSize] = useState(DEFAULT_TILE);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [clip, setClip] = useState<ProjectSelection | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ mode: 'new' | 'rename'; folder: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);

  const search = useMemo(() => parseSearch(text), [text]);
  const searching = search.text !== '' || search.kinds !== null || search.labels.length > 0;
  const folder = p.folder;
  const query = useMemo<IndexQuery>(
    () => ({
      ...(search.kinds !== null ? { kinds: search.kinds } : folder === null ? { kinds: ASSET_KINDS } : {}),
      ...(search.text !== '' ? { text: search.text } : {}),
      ...(search.labels.length > 0 ? { labels: search.labels } : {}),
      ...(folder !== null ? { folder, recursive: searching } : {}),
      ...(sort !== '' ? { sort } : {}),
      ...(descending ? { descending: true } : {}),
    }),
    [search, folder, searching, sort, descending],
  );
  const list = useIndexList(query);
  const subfolders = useSubfolders(folder !== null && !searching ? folder : null);
  const folderCount = subfolders.length;

  // A new folder or search: nothing chosen, the list from its top.
  const listKey = `${folder ?? '*'}|${text}|${sort}|${descending ? 1 : 0}|${view}`;
  useEffect(() => {
    setChosen(new Set());
    setAnchor(null);
  }, [folder, text]);

  // The selected model's pieces follow it in the list while it is expanded.
  const pieces = p.pieces;
  const openPieces = pieces !== null && expanded === pieces.assetId && pieces.list.length >= 2 ? pieces : null;
  const insert = openPieces !== null && openAt !== null ? { at: openAt, count: openPieces.list.length } : null;
  const total = folderCount + (list.total ?? 0) + (insert?.count ?? 0);
  /** What is drawn at a list position: a folder, an index entry, or a piece of the expanded file. */
  const slot = (i: number): { folder: number } | { entry: number } | { piece: number } => {
    if (i < folderCount) return { folder: i };
    const j = i - folderCount;
    if (insert === null || j <= insert.at) return { entry: j };
    if (j <= insert.at + insert.count) return { piece: j - insert.at - 1 };
    return { entry: j - insert.count };
  };

  /** The selection keys of list positions [from, to], read from the index where they are not on screen. */
  const keysBetween = useCallback(
    async (from: number, to: number): Promise<string[]> => {
      const out: string[] = [];
      for (let i = from; i <= to && i < folderCount; i++) out.push(folderKey(subfolders[i]!.path));
      const e0 = Math.max(0, from - folderCount);
      const e1 = to - folderCount;
      if (e1 < 0 || catalog === null) return out;
      for (let at = e0; at <= e1; ) {
        const have = list.entry(at);
        if (have !== undefined) {
          out.push(itemKey(have));
          at += 1;
          continue;
        }
        const count = Math.min(INDEX_PAGE_MAX, e1 - at + 1);
        const page = await catalog.page(query, at, count);
        for (const e of page.entries) out.push(itemKey(e));
        at += Math.max(1, page.entries.length);
        if (page.entries.length === 0) break;
      }
      return out;
    },
    [catalog, folderCount, list, query, subfolders],
  );

  const choose = (ev: ChooseEvent, key: string, index: number, entry: IndexEntryView | null): void => {
    setError(null);
    if (ev.shiftKey && anchor !== null) {
      const [i, j] = [anchor, index].sort((x, y) => x - y) as [number, number];
      void keysBetween(i, j).then((keys) => setChosen((c) => new Set([...c, ...keys])));
    } else if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(chosen);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setChosen(next);
      setAnchor(index);
    } else {
      setChosen(new Set([key]));
      setAnchor(index);
    }
    if (entry !== null && isAssetKind(entry.kind)) {
      p.onSelectAsset(entry.id);
      p.onFocus(null);
    } else p.onFocus(entry);
  };

  const run = async (what: Promise<string | null>): Promise<boolean> => {
    setBusy(true);
    try {
      const err = await what;
      setError(err);
      return err === null;
    } finally {
      setBusy(false);
    }
  };

  /** Move a selection into a folder (a folder is never moved into itself). */
  const moveInto = async (sel: ProjectSelection, to: string): Promise<boolean> => {
    const folders = sel.folders.filter((f) => !isWithin(to, f));
    if (sel.items.length === 0 && folders.length === 0) return false;
    return run(p.commands.move(sel.items, folders, to));
  };

  const dragStart = (ev: DragEvent<HTMLLIElement>, key: string, entry: IndexEntryView | null, piece: string | null): void => {
    const keys = chosen.has(key) && piece === null ? [...chosen] : [key];
    const sel = selectionOf(keys);
    ev.dataTransfer.setData(PROJECT_DRAG_TYPE, JSON.stringify(sel));
    // One model or texture also drops into the Scene view, the Hierarchy and texture fields; one material onto an object.
    if (entry !== null && keys.length === 1 && (entry.kind === 'model' || entry.kind === 'texture')) {
      ev.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(piece === null ? { assetId: entry.id, kind: entry.kind } : { assetId: entry.id, kind: entry.kind, piece }));
    }
    if (entry !== null && keys.length === 1 && entry.kind === 'material') ev.dataTransfer.setData(MATERIAL_DRAG_TYPE, entry.id);
    ev.dataTransfer.effectAllowed = 'copyMove';
  };
  const dragOver = (ev: DragEvent<HTMLElement>, target: string): void => {
    if (!ev.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    if (dropping !== target) setDropping(target);
  };
  const drop = (ev: DragEvent<HTMLElement>, target: string): void => {
    setDropping(null);
    const sel = parseProjectDrag(ev.dataTransfer.getData(PROJECT_DRAG_TYPE));
    if (sel === null) return;
    ev.preventDefault();
    ev.stopPropagation();
    void moveInto(sel, target).then((ok) => ok && setChosen(new Set()));
  };

  const cut = (): void => {
    if (chosen.size === 0) return;
    setClip(selectionOf(chosen));
  };
  const paste = async (): Promise<void> => {
    if (clip === null || folder === null) return;
    if (await moveInto(clip, folder)) setClip(null);
  };
  const cutKeys = useMemo(() => new Set(clip === null ? [] : [...clip.items.map(itemKey), ...clip.folders.map(folderKey)]), [clip]);

  const chosenFolders = [...chosen].filter((k) => k.startsWith('folder:')).map((k) => k.slice('folder:'.length));
  const renameTarget = chosenFolders.length === 1 && chosen.size === 1 ? chosenFolders[0]! : folder !== null && folder !== '' && chosen.size === 0 ? folder : null;
  const startNew = (): void => {
    if (folder === null) return;
    setNaming({ mode: 'new', folder, value: freeFolderName(subfolders.map((f) => f.name)) });
  };
  const startRename = (): void => {
    if (renameTarget === null) return;
    setNaming({ mode: 'rename', folder: renameTarget, value: renameTarget.slice(renameTarget.lastIndexOf('/') + 1) });
  };
  const finishNaming = async (): Promise<void> => {
    if (naming === null) return;
    const name = naming.value.trim();
    if (name === '') return;
    if (naming.mode === 'new') {
      const path = naming.folder === '' ? name : `${naming.folder}/${name}`;
      if (await run(p.commands.createFolder(path))) setNaming(null);
      return;
    }
    const parent = naming.folder.includes('/') ? naming.folder.slice(0, naming.folder.lastIndexOf('/')) : '';
    const renamed = parent === '' ? name : `${parent}/${name}`;
    if (await run(p.commands.renameFolder(naming.folder, name))) {
      setNaming(null);
      // Inside the renamed folder: stay there under its new name.
      if (folder !== null && isWithin(folder, naming.folder)) p.onFolder(`${renamed}${folder.slice(naming.folder.length)}`);
      setChosen(new Set());
    }
  };

  const listRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>): void => {
    const tag = (ev.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    // The window's scene shortcuts (paste objects, delete the selected object) are not meant here; undo and redo are.
    if (!(mod && (key === 'z' || key === 'y'))) ev.stopPropagation();
    if (mod && key === 'x') {
      ev.preventDefault();
      cut();
    } else if (mod && key === 'v') {
      ev.preventDefault();
      void paste();
    } else if (mod && key === 'a') {
      ev.preventDefault();
      void keysBetween(0, total - 1).then((keys) => setChosen(new Set(keys)));
    } else if (ev.key === 'F2') {
      ev.preventDefault();
      startRename();
    } else if (ev.key === 'Escape') {
      setChosen(new Set());
      setClip(null);
    }
  };

  const labelItems = [...chosen].filter((k) => !k.startsWith('folder:') && !k.startsWith('scene:')).map((k) => {
    const at = k.indexOf(':');
    return { kind: k.slice(0, at), id: k.slice(at + 1) };
  });
  const trail = folder === null ? [] : folderTrail(folder);
  const kindNow = typeOf(text);

  return (
    <div className="tl-project" data-folder={folder ?? ''}>
      <FolderTree folder={folder} onFolder={(f) => p.onFolder(f)} dropping={dropping} onDragOver={dragOver} onDragLeave={() => setDropping(null)} onDrop={drop} />
      <div className="tl-project__main" ref={listRef} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="tl-project__bar">
          <nav className="tl-project__crumbs" aria-label="folder path">
            {folder === null ? (
              <span className="tl-project__crumb is-current">All assets</span>
            ) : (
              [{ path: '', name: 'Game folder' }, ...trail.map((t) => ({ path: t, name: t.slice(t.lastIndexOf('/') + 1) }))].map((c, i, all) => (
                <span key={c.path} className="tl-project__crumb-wrap">
                  {i > 0 && <span className="tl-project__crumb-sep">›</span>}
                  <button
                    className={`tl-project__crumb${i === all.length - 1 ? ' is-current' : ''}${dropping === c.path ? ' is-drop' : ''}`}
                    data-crumb={c.path}
                    onClick={() => p.onFolder(c.path)}
                    onDragOver={(ev) => dragOver(ev, c.path)}
                    onDragLeave={() => setDropping(null)}
                    onDrop={(ev) => drop(ev, c.path)}
                  >
                    {c.name}
                  </button>
                </span>
              ))
            )}
          </nav>
          <input className="tl-input tl-input--small tl-project__search" type="search" aria-label="search the project" placeholder="t:audio l:voice name" value={text} onChange={(e) => setText(e.target.value)} title={folder === null ? 'Search every asset: t:<kind> (t:audio, t:material, t:scene…), l:<label>, and a part of the name, id or file' : `Search ${folder === '' ? 'the game folder' : folder} and its subfolders: t:<kind>, l:<label>, and a part of the name, id or file`} />
          <select className="tl-input tl-input--small" aria-label="filter by kind" value={kindNow ?? ''} onChange={(e) => setText(withType(text, e.target.value === '' ? null : e.target.value))}>
            <option value="">any kind</option>
            {PROJECT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select className="tl-input tl-input--small" aria-label="sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="">kind, id</option>
            <option value="name">name</option>
            <option value="kind">kind, name</option>
            <option value="path">file</option>
          </select>
          <button className="tl-btn tl-btn--small" aria-pressed={descending} aria-label="descending" title="The other way round" onClick={() => setDescending((d) => !d)}>
            {descending ? '↓' : '↑'}
          </button>
          <button className="tl-btn tl-btn--small" aria-pressed={view === 'grid'} onClick={() => setView('grid')} title="Tiles">
            grid
          </button>
          <button className="tl-btn tl-btn--small" aria-pressed={view === 'list'} onClick={() => setView('list')} title="One row each">
            list
          </button>
          {view === 'grid' && <input className="tl-project__size" type="range" aria-label="tile size" min={72} max={192} step={8} value={size} onChange={(e) => setSize(Number(e.target.value))} />}
        </div>
        <div className="tl-project__bar">
          <button className="tl-btn tl-btn--small" disabled={folder === null || busy} onClick={startNew} title={folder === null ? 'Choose a folder of the game folder first' : 'Make a folder here'}>
            new folder
          </button>
          <button className="tl-btn tl-btn--small" disabled={renameTarget === null || busy} onClick={startRename} title="Rename the chosen folder (F2)">
            rename folder
          </button>
          <button className="tl-btn tl-btn--small" disabled={chosen.size === 0} onClick={cut} title="Cut the chosen items and folders (Ctrl+X); paste them into another folder">
            cut
          </button>
          <button className="tl-btn tl-btn--small" disabled={clip === null || folder === null || busy} onClick={() => void paste()} title={folder === null ? 'Open a folder to paste into' : `Move what was cut into ${folder === '' ? 'the game folder' : folder} (Ctrl+V; one undo)`}>
            paste{clip !== null ? ` (${clip.items.length + clip.folders.length})` : ''}
          </button>
          {chosen.size > 0 && (
            <span className="tl-project__count" data-testid="project-chosen">
              {chosen.size} chosen
            </span>
          )}
          {naming !== null && (
            <span className="tl-project__naming">
              <input
                className="tl-input tl-input--small"
                aria-label="folder name"
                autoFocus
                value={naming.value}
                onChange={(e) => setNaming({ ...naming, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void finishNaming();
                  if (e.key === 'Escape') setNaming(null);
                }}
              />
              <button className="tl-btn tl-btn--small" onClick={() => void finishNaming()}>
                {naming.mode === 'new' ? 'make' : 'rename'}
              </button>
            </span>
          )}
        </div>
        {error !== null && (
          <div className="tl-assets__error" role="alert" data-testid="project-error" title={error}>
            {error}
          </div>
        )}
        {p.loading !== undefined && labelItems.length > 1 && <LabelsBar items={labelItems} actions={p.loading} onClear={() => setChosen(new Set())} />}
        <VirtualList
          key={listKey}
          className={`tl-assets__list tl-project__list ${view === 'grid' ? 'tl-tiles tl-tiles--virtual' : 'tl-project__rows'}`}
          style={{ ['--tile-size' as string]: `${size}px` }}
          count={total}
          stride={view === 'grid' ? size + TILE_GAP : ROW_STRIDE}
          gap={view === 'grid' ? TILE_GAP : 0}
          padding={view === 'grid' ? TILE_PADDING : 0}
          {...(view === 'grid' ? { minItemWidth: size } : {})}
          overscan={3}
          onRange={(from, to) => list.need(Math.max(0, from - folderCount - (insert?.count ?? 0)), Math.max(0, to - folderCount))}
          empty={<li className="tl-row tl-row--empty">{list.total === null ? 'loading…' : searching ? 'nothing found' : folder === null ? 'no assets' : 'empty folder'}</li>}
          renderItem={(i) => {
            const at = slot(i);
            if ('folder' in at) {
              const f = subfolders[at.folder]!;
              const key = folderKey(f.path);
              return (
                <FolderTile
                  key={key}
                  view={view}
                  path={f.path}
                  name={f.name}
                  chosen={chosen.has(key)}
                  cut={cutKeys.has(key)}
                  dropping={dropping === f.path}
                  onChoose={(ev) => choose(ev, key, i, null)}
                  onOpen={() => p.onFolder(f.path)}
                  onDragStart={(ev) => dragStart(ev, key, null, null)}
                  onDragOver={(ev) => dragOver(ev, f.path)}
                  onDragLeave={() => setDropping(null)}
                  onDrop={(ev) => drop(ev, f.path)}
                />
              );
            }
            if ('piece' in at) {
              const pc = openPieces!.list[at.piece]!;
              const entry = { kind: 'model', id: openPieces!.assetId, path: null, name: pc.name, labels: [] };
              return <PieceTile key={`${openPieces!.assetId}|${pc.name}`} view={view} assetId={openPieces!.assetId} name={pc.name} fileName={p.fileName(openPieces!.assetId)} thumbnails={p.thumbnails} onSelect={() => p.onSelectAsset(openPieces!.assetId)} onDragStart={(ev) => dragStart(ev, itemKey(entry), entry, pc.name)} />;
            }
            const e = list.entry(at.entry);
            if (e === undefined) return <li key={`slot:${i}`} className={view === 'grid' ? 'tl-tile tl-tile--loading' : 'tl-project__row tl-tile--loading'} aria-hidden="true" />;
            const key = itemKey(e);
            const common = {
              view,
              chosen: chosen.size > 1 && chosen.has(key),
              cut: cutKeys.has(key),
              onChoose: (ev: ChooseEvent) => choose(ev, key, i, e),
              onOpen: () => p.onOpen({ kind: e.kind, id: e.id }),
              onDragStart: (ev: DragEvent<HTMLLIElement>) => dragStart(ev, key, e, null),
            };
            if (!isAssetKind(e.kind)) return <ItemTile key={key} {...common} chosen={chosen.has(key)} e={e} />;
            const index = at.entry;
            return (
              <AssetTile
                key={key}
                {...common}
                e={e}
                primary={e.id === p.selectedAssetId}
                pieces={pieces !== null && pieces.assetId === e.id ? pieces.list : null}
                open={openPieces !== null && openPieces.assetId === e.id}
                thumbnails={p.thumbnails}
                onToggle={() => {
                  setExpanded((x) => (x === e.id ? null : e.id));
                  setOpenAt(index);
                }}
              />
            );
          }}
        />
        <div className="tl-assets__paging" data-total={list.total ?? ''}>
          {folderCount > 0 ? `${folderCount} folder(s) · ` : ''}
          {list.total ?? '…'} item(s)
          {list.total !== null && list.total > INDEX_PAGE_DEFAULT ? ' (read as they scroll into view)' : ''}
          {list.error !== null ? ` · ${list.error}` : ''}
        </div>
      </div>
    </div>
  );
}
