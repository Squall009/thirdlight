/**
 * The project window's tiles and rows: a folder, an asset (its picture from
 * the import cache, its summary read while it is on screen), a piece of a
 * multi-piece model file, and a resource or scene. Every one can be chosen,
 * opened with a double-click and dragged; a folder is also a drop target.
 *
 * Browser-only (React).
 */
import type { DragEvent, JSX, MouseEvent } from 'react';

import type { IndexEntryView } from '../../session/catalog';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { useAssetSummaries } from '../catalog/catalog-context';
import { TileImage } from '../assets/TileImage';
import { kindIcon } from '../../session/item-icons';

/** How a list draws its items: tiles in a grid, or one row each. */
export type ProjectView = 'grid' | 'list';

export type ChooseEvent = Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>;

interface Common {
  view: ProjectView;
  chosen: boolean;
  cut: boolean;
  onChoose: (ev: ChooseEvent) => void;
  onOpen: () => void;
  onDragStart: (ev: DragEvent<HTMLLIElement>) => void;
}

function classOf(base: string, c: Common, extra = ''): string {
  return `${c.view === 'list' ? 'tl-project__row' : 'tl-tile'} ${base}${c.chosen ? ' is-selected' : ''}${c.cut ? ' is-cut' : ''}${extra}`;
}

/** A resource's or scene's picture from the icon registry (its kind's short name for a kind the registry does not know). */
function Glyph(p: { kind: string }): JSX.Element {
  const src = kindIcon(p.kind);
  return (
    <span className={`tl-tile__icon tl-tile__icon--${p.kind}${src === undefined ? ' tl-project__glyph' : ''}`} aria-hidden="true">
      {src !== undefined ? <img className="tl-tile__img tl-tile__img--kind" src={src} alt="" draggable={false} /> : p.kind.slice(0, 3).toUpperCase()}
    </span>
  );
}

export function FolderIcon(): JSX.Element {
  return <img className="tl-project__folder-icon" src={kindIcon('folder')} alt="" aria-hidden="true" draggable={false} />;
}

/** A folder: double-click opens it; items and folders dropped on it move into it. */
export function FolderTile(p: Common & { path: string; name: string; dropping: boolean; onDragOver: (ev: DragEvent<HTMLLIElement>) => void; onDragLeave: () => void; onDrop: (ev: DragEvent<HTMLLIElement>) => void }): JSX.Element {
  return (
    <li
      className={classOf('tl-project__folder', p, p.dropping ? ' is-drop' : '')}
      aria-selected={p.chosen}
      data-folder={p.path}
      title={`${p.path} — double-click to open; drop items here to move them in`}
      draggable
      onClick={p.onChoose}
      onDoubleClick={p.onOpen}
      onDragStart={p.onDragStart}
      onDragOver={p.onDragOver}
      onDragLeave={p.onDragLeave}
      onDrop={p.onDrop}
    >
      <span className="tl-tile__icon tl-tile__icon--folder" aria-hidden="true">
        <FolderIcon />
      </span>
      <span className="tl-tile__name">{p.name}</span>
      {p.view === 'grid' ? <span className="tl-tile__meta">folder</span> : <span className="tl-project__cell tl-project__cell--kind">folder</span>}
    </li>
  );
}

/** An asset: its summary is read by id while it is on screen. */
export function AssetTile(p: Common & { e: IndexEntryView; primary: boolean; pieces: readonly { name: string }[] | null; open: boolean; thumbnails: TileThumbnails | null; onToggle: () => void }): JSX.Element {
  const [a] = useAssetSummaries([p.e.id]);
  const kind = p.e.kind;
  const multi = kind === 'model' && p.pieces !== null && p.pieces.length >= 2;
  return (
    <li
      className={classOf('', { ...p, chosen: p.chosen || p.primary })}
      aria-selected={p.chosen || p.primary}
      onClick={p.onChoose}
      onDoubleClick={p.onOpen}
      title={kind === 'model' ? `${p.e.name} — drag into the scene or hierarchy, or onto a folder` : `${p.e.path ?? p.e.id}`}
      data-asset-id={p.e.id}
      data-kind={kind}
      draggable
      onDragStart={p.onDragStart}
    >
      <span className={`tl-tile__icon tl-tile__icon--${kind}`} aria-hidden="true">
        <TileImage summary={a} kind={kind} piece={null} thumbnails={p.thumbnails} />
      </span>
      <span className="tl-tile__name">{p.e.name}</span>
      {p.view === 'list' && <span className="tl-project__cell tl-project__cell--path">{p.e.path ?? ''}</span>}
      <span className={p.view === 'grid' ? 'tl-tile__meta' : 'tl-project__cell tl-project__cell--kind'} title={a !== undefined ? `${a.versionCount} version(s)${a.sourcePath !== undefined ? ` · ${a.sourcePath}` : ''}` : (p.e.path ?? '')}>
        {kind}
        {a !== undefined ? ` · v${a.currentVersion}` : ''}
        {multi && (
          <button
            className="tl-tile__pieces"
            aria-expanded={p.open}
            aria-label={`${p.open ? 'hide' : 'show'} the ${p.pieces!.length} pieces of ${p.e.name}`}
            title={`${p.pieces!.length} pieces — each can be dragged on its own`}
            onClick={(ev) => {
              ev.stopPropagation();
              p.onToggle();
            }}
          >
            {p.open ? '▾' : '▸'} {p.pieces!.length}
          </button>
        )}
      </span>
    </li>
  );
}

/** One piece tile of an expanded model file. */
export function PieceTile(p: { view: ProjectView; assetId: string; name: string; fileName: string; thumbnails: TileThumbnails | null; onSelect: () => void; onDragStart: (ev: DragEvent<HTMLLIElement>) => void }): JSX.Element {
  const [a] = useAssetSummaries([p.assetId]);
  return (
    <li
      className={`${p.view === 'list' ? 'tl-project__row' : 'tl-tile'} tl-tile--piece`}
      title={`${p.name} (piece of ${p.fileName}) — drag into the scene or hierarchy`}
      data-asset-id={p.assetId}
      data-piece={p.name}
      draggable
      onClick={p.onSelect}
      onDragStart={p.onDragStart}
    >
      <span className="tl-tile__icon tl-tile__icon--model" aria-hidden="true">
        <TileImage summary={a} kind="model" piece={p.name} thumbnails={p.thumbnails} />
      </span>
      <span className="tl-tile__name">{p.name}</span>
      <span className={p.view === 'grid' ? 'tl-tile__meta' : 'tl-project__cell tl-project__cell--kind'}>piece</span>
    </li>
  );
}

/** A resource or a scene. */
export function ItemTile(p: Common & { e: IndexEntryView }): JSX.Element {
  return (
    <li
      className={classOf('tl-project__item', p)}
      aria-selected={p.chosen}
      onClick={p.onChoose}
      onDoubleClick={p.onOpen}
      title={`${p.e.path ?? p.e.id} — double-click to open`}
      data-item-kind={p.e.kind}
      data-item-id={p.e.id}
      draggable
      onDragStart={p.onDragStart}
    >
      <Glyph kind={p.e.kind} />
      <span className="tl-tile__name">{p.e.name}</span>
      {p.view === 'list' && <span className="tl-project__cell tl-project__cell--path">{p.e.path ?? ''}</span>}
      <span className={p.view === 'grid' ? 'tl-tile__meta' : 'tl-project__cell tl-project__cell--kind'}>{p.e.kind}</span>
    </li>
  );
}
