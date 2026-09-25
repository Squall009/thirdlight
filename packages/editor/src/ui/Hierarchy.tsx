/**
 * Hierarchy panel (React, decision 0001 §10; phase 12) — the entity tree.
 *
 * - Rows collapse and expand (the arrow); which rows are collapsed is kept in
 *   this browser per project (localStorage), never in the project.
 * - Click selects, Ctrl/Cmd+click toggles, Shift+click selects a range.
 * - Dragging a row (or the selection it belongs to) drops it before a row
 *   (top edge), after it (bottom edge) or into it (middle): into a folder
 *   files it, into an object makes it a child. The empty list area files it
 *   at the root (of its own scene), at the end. World positions are kept by
 *   the command.
 * - Double-click renames.
 *
 * - Phase 12 (c), several scenes: each open scene is a header with its own
 *   tree. Clicking a header makes it the active scene (new objects go
 *   there); the header renames (double-click), toggles "start scene",
 *   deletes an empty scene and closes it. "New scene" and "open scene…"
 *   sit above the list. Dragging between scenes is refused (one command
 *   edits one scene).
 *
 * Every edit is a command issued by the app (`moveEntities`, `updateEntity`,
 * the scene-index ops).
 *
 * Phase 21.4: rows are memoised, rebuilt only when the tree's shape changes,
 * and a long list is windowed (see HIERARCHY_WINDOW_MIN_ROWS).
 */
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type MouseEvent } from 'react';

import {
  draggedRoots,
  dropTarget,
  dropZoneAt,
  nextSelection,
  sceneDropAllowed,
  visibleRows,
  type DropTarget,
  type TreeRow,
  type EffectiveEntityFlags,
} from '../session/hierarchy';
import type { ProjectedEntity } from '../session/projection';
import { ICON_FILES, iconKindFor } from '../viewport/icons';
import { ASSET_DRAG_TYPE, parseAssetDrag, type AssetDragPayload } from '../session/placement';

interface Props {
  entities: ProjectedEntity[];
  /**
   * Phase 21.4: changes whenever the tree's shape or labels change (entities
   * added or removed, parents, order, names, flags, kinds). Absent: the rows
   * are rebuilt whenever `entities` changes.
   */
  structureKey?: string | number;
  /** Effective (inherited) flags per entity id. */
  flags: ReadonlyMap<string, EffectiveEntityFlags>;
  /** The collapse state is remembered per project in this browser. */
  projectId: string;
  selectedIds: readonly string[];
  primaryId: string | null;
  onSelect: (ids: string[], primary: string | null) => void;
  onRename: (id: string, name: string) => void;
  onMove: (ids: string[], parentId: string | null, beforeId: string | null) => void;
  /** Phase 12 (c): the open scenes (absent: a single-scene project, one plain tree). */
  scenes?: readonly SceneHeaderView[];
  /** Phase 12 (c): the scenes that are not open in this browser. */
  closedScenes?: readonly { sceneId: string; name: string }[];
  onSceneAction?: (action: SceneAction) => void;
  /**
   * A model asset (or one piece) dropped from the asset tiles: onto a folder
   * files it inside, onto a scene header at that scene's root, elsewhere at
   * the root (of the row's scene).
   */
  onAssetDrop?: (asset: AssetDragPayload, parentId: string | null, sceneId: string | null) => void;
}

/** Phase 12 (c): one open scene's header. */
export interface SceneHeaderView {
  sceneId: string;
  name: string;
  start: boolean;
  active: boolean;
  entityCount: number;
}

/** Phase 12 (c): what the scene controls ask the app to do. */
export type SceneAction =
  | { kind: 'activate'; sceneId: string }
  | { kind: 'open'; sceneId: string }
  | { kind: 'close'; sceneId: string }
  | { kind: 'create' }
  | { kind: 'rename'; sceneId: string; name: string }
  | { kind: 'delete'; sceneId: string }
  | { kind: 'toggleStart'; sceneId: string };

const DRAG_TYPE = 'application/x-thirdlight-entity';

function collapseKey(projectId: string): string {
  return `thirdlight.hierarchy.collapsed.${projectId}`;
}

function loadCollapsed(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(collapseKey(projectId));
    const list = raw === null ? [] : (JSON.parse(raw) as unknown);
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Phase 21.4: a long list is windowed — only the rows in view (plus an
 * overscan) are in the DOM, between two spacers, so a project with thousands
 * of objects scrolls, selects and renames as fast as a small one. Rows have a
 * fixed height in that mode. Short lists (the common case) render every row.
 */
export const HIERARCHY_WINDOW_MIN_ROWS = 400;
/** Row and scene-header heights in the windowed list (px; the CSS of `.is-windowed` matches). */
export const HIERARCHY_ROW_PX = 24;
export const HIERARCHY_SCENE_PX = 28;
/** Rows rendered beyond each edge of the view. */
const OVERSCAN_ROWS = 24;

type ListItem = { type: 'scene'; scene: SceneHeaderView } | { type: 'row'; row: TreeRow };

/** The item at height `y` (tops ascending, one extra entry = the total height). */
function itemAt(tops: Float64Array, y: number): number {
  let lo = 0;
  let hi = tops.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** What a row needs from the panel at event time (a stable ref, so rows can be memoised). */
interface RowHandlers {
  click: (ev: MouseEvent<HTMLLIElement>, id: string) => void;
  startRename: (id: string, name: string) => void;
  dragStart: (ev: DragEvent<HTMLLIElement>, id: string) => void;
  dragEnd: () => void;
  dragOver: (ev: DragEvent<HTMLLIElement>, id: string) => void;
  drop: (ev: DragEvent) => void;
  toggle: (id: string) => void;
  renameDraft: (id: string, draft: string) => void;
  renameCommit: () => void;
  renameCancel: () => void;
}

interface RowProps {
  entity: ProjectedEntity;
  row: TreeRow;
  flags: EffectiveEntityFlags | undefined;
  selected: boolean;
  primary: boolean;
  collapsed: boolean;
  /** The rename draft while this row is being renamed. */
  draft: string | null;
  dropClass: string;
  handlers: { current: RowHandlers };
}

/** One entity row; memoised on its data (the handlers are a stable ref). */
const HierarchyRow = memo(function HierarchyRow({ entity: e, row: r, flags: f, selected, primary, collapsed: isCollapsed, draft, dropClass, handlers }: RowProps): JSX.Element {
  const inactive = f !== undefined && !f.active;
  const locked = f?.locked === true;
  return (
    <li
      data-entity-id={r.id}
      aria-selected={selected}
      style={{ paddingLeft: `${4 + r.depth * 14}px` }}
      className={['tl-row', selected ? 'is-selected' : '', primary ? 'is-primary' : '', inactive ? 'is-inactive' : '', dropClass].join(' ').replace(/\s+/g, ' ').trim()}
      onClick={(ev) => handlers.current.click(ev, r.id)}
      onDoubleClick={() => handlers.current.startRename(r.id, e.name)}
      draggable={draft === null}
      onDragStart={(ev) => handlers.current.dragStart(ev, r.id)}
      onDragEnd={() => handlers.current.dragEnd()}
      onDragOver={(ev) => handlers.current.dragOver(ev, r.id)}
      onDrop={(ev) => handlers.current.drop(ev)}
    >
      {r.hasChildren ? (
        <button
          className="tl-row__twisty"
          aria-label={isCollapsed ? `expand ${e.name}` : `collapse ${e.name}`}
          aria-expanded={!isCollapsed}
          onClick={(ev) => {
            ev.stopPropagation();
            handlers.current.toggle(r.id);
          }}
          onDoubleClick={(ev) => ev.stopPropagation()}
        >
          {isCollapsed ? '▸' : '▾'}
        </button>
      ) : (
        <span className="tl-row__twisty tl-row__twisty--leaf" aria-hidden="true" />
      )}
      {e.kind === 'folder' ? (
        <span className="tl-row__folder" aria-hidden="true" />
      ) : (
        <img className="tl-row__icon" src={e.kind === 'box' || e.kind === 'model' ? `./icons/${ROW_ICON[e.kind]}.png` : ICON_FILES[iconKindFor(e)]} alt="" aria-hidden="true" />
      )}
      <span className={`tl-row__kind tl-row__kind--${e.kind}`}>{e.kind}</span>
      {draft !== null ? (
        <input
          className="tl-row__rename"
          aria-label="rename"
          autoFocus
          value={draft}
          onClick={(ev) => ev.stopPropagation()}
          onChange={(ev) => handlers.current.renameDraft(r.id, ev.target.value)}
          onBlur={() => handlers.current.renameCommit()}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') handlers.current.renameCommit();
            if (ev.key === 'Escape') handlers.current.renameCancel();
          }}
        />
      ) : (
        <span className="tl-row__name" title={e.id}>{e.name}</span>
      )}
      {locked && (
        <span className="tl-row__flag" role="img" aria-label="locked" title={f?.inheritedFrom.locked ? 'locked by a folder above' : 'locked'}>
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="currentColor" />
            <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
      )}
      {f?.static === true && <span className="tl-row__flag tl-row__flag--static" title="static">S</span>}
    </li>
  );
});

export function Hierarchy({ entities, structureKey, flags, projectId, selectedIds, primaryId, onSelect, onRename, onMove, scenes, closedScenes, onSceneAction, onAssetDrop }: Props): JSX.Element {
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [renamingScene, setRenamingScene] = useState<{ sceneId: string; draft: string } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(projectId));
  const [drop, setDrop] = useState<{ targetId: string | null; target: DropTarget } | null>(null);
  const dragging = useRef<string[] | null>(null);
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 600 });

  useEffect(() => setCollapsed(loadCollapsed(projectId)), [projectId]);
  const toggleCollapsed = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(collapseKey(projectId), JSON.stringify([...next]));
      } catch {
        // storage full or blocked: the tree still works for this page
      }
      return next;
    });
  };

  // Phase 12 (c): one tree per open scene (a collapsed scene hides its tree).
  // Phase 21.4: rebuilt only when the tree's shape changes (`structureKey`),
  // not when an object moves or a component value changes.
  const shapeKey = structureKey ?? entities;
  const sceneTrees = useMemo(
    () =>
      scenes === undefined
        ? null
        : scenes.map((sc) => ({
            scene: sc,
            rows: collapsed.has(`scene:${sc.sceneId}`) ? [] : visibleRows(entities.filter((e) => e.sceneId === sc.sceneId), collapsed, filter),
          })),
    // `entities` is read through `shapeKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenes, shapeKey, collapsed, filter],
  );
  const rows: TreeRow[] = useMemo(
    () => (sceneTrees !== null ? sceneTrees.flatMap((t) => t.rows) : visibleRows(entities, collapsed, filter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sceneTrees, shapeKey, collapsed, filter],
  );
  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  // The flat item list (scene headers and rows) and, when windowed, each item's top.
  const items: ListItem[] = useMemo(
    () => (sceneTrees === null ? rows.map((row) => ({ type: 'row' as const, row })) : sceneTrees.flatMap((t) => [{ type: 'scene' as const, scene: t.scene }, ...t.rows.map((row) => ({ type: 'row' as const, row }))])),
    [sceneTrees, rows],
  );
  const windowed = items.length > HIERARCHY_WINDOW_MIN_ROWS;
  const tops = useMemo(() => {
    if (!windowed) return null;
    const t = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++) t[i + 1] = t[i]! + (items[i]!.type === 'scene' ? HIERARCHY_SCENE_PX : HIERARCHY_ROW_PX);
    return t;
  }, [items, windowed]);
  const indexOf = useMemo(() => {
    if (!windowed) return null;
    const m = new Map<string, number>();
    items.forEach((it, i) => m.set(it.type === 'row' ? it.row.id : `scene:${it.scene.sceneId}`, i));
    return m;
  }, [items, windowed]);

  // The list's scroll position and height (windowed mode reads them).
  useEffect(() => {
    const el = listRef.current;
    if (el === null) return;
    const measure = (): void => setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [windowed]);

  // Windowed: a new selection made elsewhere (the Scene view) scrolls its row
  // into view — once per selection change (a later edit never yanks the list
  // back); a row that is not listed yet (just created) is scrolled to when it appears.
  const scrollTarget = useRef<string | null>(null);
  useEffect(() => {
    scrollTarget.current = primaryId;
  }, [primaryId]);
  useEffect(() => {
    const el = listRef.current;
    const target = scrollTarget.current;
    if (!windowed || el === null || tops === null || indexOf === null || target === null) return;
    const i = indexOf.get(target);
    if (i === undefined) return;
    scrollTarget.current = null;
    const top = tops[i]!;
    const bottom = tops[i + 1]!;
    if (top >= el.scrollTop && bottom <= el.scrollTop + el.clientHeight) return;
    el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    setView({ top: el.scrollTop, height: el.clientHeight });
  }, [primaryId, windowed, tops, indexOf]);

  const commitRename = (): void => {
    if (renaming !== null) {
      const name = renaming.draft.trim();
      const current = byId.get(renaming.id);
      if (name !== '' && current !== undefined && name !== current.name) onRename(renaming.id, name);
    }
    setRenaming(null);
  };

  const endDrag = (): void => {
    dragging.current = null;
    setDrop(null);
    setHint(null);
  };
  /** Phase 12 (c): a drop on a scene header files the dragged objects at that scene's root. */
  const isAssetDrag = (ev: DragEvent): boolean => onAssetDrop !== undefined && ev.dataTransfer.types.includes(ASSET_DRAG_TYPE);
  const overScene = (ev: DragEvent<HTMLLIElement>, sceneId: string): void => {
    if (isAssetDrag(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = 'copy';
      setDrop({ targetId: `scene:${sceneId}`, target: { parentId: null, beforeId: null, zone: 'into' } });
      return;
    }
    if (!ev.dataTransfer.types.includes(DRAG_TYPE) || dragging.current === null) return;
    ev.stopPropagation();
    if (!sceneDropAllowed(entities, dragging.current, sceneId)) {
      ev.dataTransfer.dropEffect = 'none';
      setDrop(null);
      setHint('Objects stay in their scene: moving between scenes is not supported yet.');
      return;
    }
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    setHint(null);
    setDrop({ targetId: `scene:${sceneId}`, target: { parentId: null, beforeId: null, zone: 'after' } });
  };
  const overRow = (ev: DragEvent<HTMLLIElement>, id: string): void => {
    if (isAssetDrag(ev)) {
      // A model lands in the folder under the pointer, or next to the row it is over.
      const row = byId.get(id);
      const folder = row?.kind === 'folder' ? id : row?.parentId !== null && row?.parentId !== undefined && byId.get(row.parentId)?.kind === 'folder' ? row.parentId : null;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = 'copy';
      setDrop({ targetId: folder ?? id, target: { parentId: folder, beforeId: null, zone: folder === null ? 'after' : 'into' } });
      return;
    }
    if (!ev.dataTransfer.types.includes(DRAG_TYPE) || dragging.current === null) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const target = dropTarget(entities, dragging.current, id, dropZoneAt(ev.clientY - rect.top, rect.height));
    ev.stopPropagation();
    if (target === null) {
      ev.dataTransfer.dropEffect = 'none';
      setDrop(null);
      const dragged = dragging.current;
      if (scenes !== undefined && dragged.some((d) => byId.get(d)?.sceneId !== byId.get(id)?.sceneId)) setHint('Objects stay in their scene: moving between scenes is not supported yet.');
      return;
    }
    setHint(null);
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    setDrop({ targetId: id, target });
  };
  const dropOn = (ev: DragEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    if (isAssetDrag(ev)) {
      const asset = parseAssetDrag(ev.dataTransfer.getData(ASSET_DRAG_TYPE));
      const targetId = drop?.targetId ?? null;
      const parentId = drop?.target.parentId ?? null;
      endDrag();
      if (asset === null) return;
      const sceneId =
        targetId !== null && targetId.startsWith('scene:')
          ? targetId.slice('scene:'.length)
          : targetId !== null
            ? (byId.get(targetId)?.sceneId ?? null)
            : null;
      onAssetDrop?.(asset, parentId, sceneId);
      return;
    }
    const ids = dragging.current;
    const target = drop?.target ?? null;
    endDrag();
    if (ids !== null && target !== null) onMove(ids, target.parentId, target.beforeId);
  };

  const dropClass = (id: string): string => {
    if (drop === null || drop.targetId !== id) return '';
    return drop.target.zone === 'into' ? 'is-drop' : drop.target.zone === 'before' ? 'is-drop-before' : 'is-drop-after';
  };

  // The rows' event handlers read the panel's latest state through this ref.
  const handlers = useRef<RowHandlers>(null as unknown as RowHandlers);
  handlers.current = {
    click: (ev, id) => {
      const next = nextSelection(selectedIds, anchor.current, id, { toggle: ev.ctrlKey || ev.metaKey, range: ev.shiftKey }, rows);
      anchor.current = next.anchor;
      onSelect(next.ids, next.primary);
    },
    startRename: (id, name) => setRenaming({ id, draft: name }),
    dragStart: (ev, id) => {
      // Dragging a selected row drags the whole selection.
      const ids = selected.has(id) ? draggedRoots(entities, selectedIds) : [id];
      if (!selected.has(id)) {
        anchor.current = id;
        onSelect([id], id);
      }
      dragging.current = ids;
      ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
      ev.dataTransfer.effectAllowed = 'move';
    },
    dragEnd: endDrag,
    dragOver: overRow,
    drop: dropOn,
    toggle: toggleCollapsed,
    renameDraft: (id, draft) => setRenaming({ id, draft }),
    renameCommit: commitRename,
    renameCancel: () => setRenaming(null),
  };

  const renderRow = (r: TreeRow): JSX.Element | null => {
    const e = byId.get(r.id);
    if (!e) return null;
    return (
      <HierarchyRow
        key={r.id}
        entity={e}
        row={r}
        flags={flags.get(r.id)}
        selected={selected.has(r.id)}
        primary={r.id === primaryId}
        collapsed={collapsed.has(r.id)}
        draft={renaming?.id === r.id ? renaming.draft : null}
        dropClass={dropClass(r.id)}
        handlers={handlers}
      />
    );
  };

  const renderSceneHeader = (sc: SceneHeaderView): JSX.Element => {
    const sceneCollapsed = collapsed.has(`scene:${sc.sceneId}`);
    return (
      <li
        key={`scene:${sc.sceneId}`}
        data-scene-id={sc.sceneId}
        aria-label={`scene ${sc.name}`}
        aria-current={sc.active ? 'true' : undefined}
        className={['tl-scene-header', sc.active ? 'is-active' : '', dropClass(`scene:${sc.sceneId}`)].join(' ').trim()}
        onClick={() => onSceneAction?.({ kind: 'activate', sceneId: sc.sceneId })}
        onDragOver={(ev) => overScene(ev, sc.sceneId)}
        onDrop={dropOn}
      >
        <button
          className="tl-row__twisty"
          aria-label={sceneCollapsed ? `expand scene ${sc.name}` : `collapse scene ${sc.name}`}
          aria-expanded={!sceneCollapsed}
          onClick={(ev) => {
            ev.stopPropagation();
            toggleCollapsed(`scene:${sc.sceneId}`);
          }}
        >
          {sceneCollapsed ? '▸' : '▾'}
        </button>
        {renamingScene?.sceneId === sc.sceneId ? (
          <input
            className="tl-row__rename"
            aria-label="rename scene"
            autoFocus
            value={renamingScene.draft}
            onClick={(ev) => ev.stopPropagation()}
            onChange={(ev) => setRenamingScene({ sceneId: sc.sceneId, draft: ev.target.value })}
            onBlur={() => {
              const name = renamingScene.draft.trim();
              if (name !== '' && name !== sc.name) onSceneAction?.({ kind: 'rename', sceneId: sc.sceneId, name });
              setRenamingScene(null);
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
              if (ev.key === 'Escape') setRenamingScene(null);
            }}
          />
        ) : (
          <span
            className="tl-scene-header__name"
            title={sc.sceneId}
            onDoubleClick={(ev) => {
              ev.stopPropagation();
              setRenamingScene({ sceneId: sc.sceneId, draft: sc.name });
            }}
          >
            {sc.name}
          </span>
        )}
        {sc.active && <span className="tl-scene-header__badge tl-scene-header__badge--active">active</span>}
        {sc.start && <span className="tl-scene-header__badge">start</span>}
        <span className="tl-scene-header__tools">
          <button
            aria-label={`start scene ${sc.name}`}
            aria-pressed={sc.start}
            title={sc.start ? 'The game starts with this scene (click to remove it from the start set)' : 'Add to the scenes the game starts with'}
            onClick={(ev) => {
              ev.stopPropagation();
              onSceneAction?.({ kind: 'toggleStart', sceneId: sc.sceneId });
            }}
          >
            ★
          </button>
          {sc.entityCount === 0 && (
            <button
              aria-label={`delete scene ${sc.name}`}
              title="Delete this empty scene"
              onClick={(ev) => {
                ev.stopPropagation();
                onSceneAction?.({ kind: 'delete', sceneId: sc.sceneId });
              }}
            >
              🗑
            </button>
          )}
          {scenes !== undefined && scenes.length > 1 && (
            <button
              aria-label={`close scene ${sc.name}`}
              title="Close (hide) this scene in this browser"
              onClick={(ev) => {
                ev.stopPropagation();
                onSceneAction?.({ kind: 'close', sceneId: sc.sceneId });
              }}
            >
              ×
            </button>
          )}
        </span>
      </li>
    );
  };

  const renderItem = (it: ListItem): JSX.Element | null => (it.type === 'scene' ? renderSceneHeader(it.scene) : renderRow(it.row));

  // Windowed: the items in view (plus the overscan) between two spacers.
  let body: (JSX.Element | null)[];
  if (windowed && tops !== null) {
    const total = tops[items.length]!;
    const from = itemAt(tops, Math.max(0, view.top - OVERSCAN_ROWS * HIERARCHY_ROW_PX));
    const to = Math.min(items.length - 1, itemAt(tops, view.top + view.height + OVERSCAN_ROWS * HIERARCHY_ROW_PX));
    // A row being renamed stays mounted (its field keeps focus) even when scrolled away.
    const renamingIndex = renaming !== null ? indexOf?.get(renaming.id) : undefined;
    body = [<li key="tl-spacer-top" className="tl-hierarchy__spacer" role="presentation" aria-hidden="true" style={{ height: `${tops[from]}px` }} />];
    if (renamingIndex !== undefined && renamingIndex < from) body.push(renderItem(items[renamingIndex]!));
    for (let i = from; i <= to; i++) body.push(renderItem(items[i]!));
    if (renamingIndex !== undefined && renamingIndex > to) body.push(renderItem(items[renamingIndex]!));
    body.push(<li key="tl-spacer-bottom" className="tl-hierarchy__spacer" role="presentation" aria-hidden="true" style={{ height: `${Math.max(0, total - tops[to + 1]!)}px` }} />);
  } else {
    body = items.map(renderItem);
  }

  return (
    <div className="tl-panel tl-hierarchy">
      <div className="tl-panel__title">Hierarchy</div>
      <input
        className="tl-hierarchy__filter"
        placeholder="filter…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {scenes !== undefined && (
        <div className="tl-hierarchy__scenes">
          <button className="tl-btn" onClick={() => onSceneAction?.({ kind: 'create' })}>
            + Scene
          </button>
          {closedScenes !== undefined && closedScenes.length > 0 && (
            <select
              aria-label="open scene"
              value=""
              onChange={(ev) => {
                if (ev.target.value !== '') onSceneAction?.({ kind: 'open', sceneId: ev.target.value });
              }}
            >
              <option value="">open scene…</option>
              {closedScenes.map((c) => (
                <option key={c.sceneId} value={c.sceneId}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {hint !== null && <div className="tl-hierarchy__hint" role="status">{hint}</div>}
      <ul
        ref={listRef}
        className={['tl-hierarchy__list', drop !== null && drop.targetId === null ? 'is-drop-root' : '', windowed ? 'is-windowed' : ''].join(' ').replace(/\s+/g, ' ').trim()}
        aria-label="Hierarchy"
        data-rows={rows.length}
        onScroll={
          windowed
            ? (ev) => {
                const el = ev.currentTarget;
                setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
              }
            : undefined
        }
        onDragOver={(ev) => {
          if (isAssetDrag(ev)) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'copy';
            setDrop({ targetId: null, target: { parentId: null, beforeId: null, zone: 'after' } });
            return;
          }
          if (!ev.dataTransfer.types.includes(DRAG_TYPE) || dragging.current === null) return;
          // With several scenes the empty area files at the root of the scene
          // the dragged objects live in (they must share one).
          if (scenes !== undefined) {
            const first = byId.get(dragging.current[0] ?? '')?.sceneId;
            if (first === undefined || !sceneDropAllowed(entities, dragging.current, first)) return;
          }
          ev.preventDefault();
          setDrop({ targetId: null, target: { parentId: null, beforeId: null, zone: 'after' } });
        }}
        onDragLeave={(ev) => {
          if (ev.currentTarget === ev.target) setDrop(null);
        }}
        onDrop={dropOn}
      >
        {body}
        {rows.length === 0 && <li className="tl-row tl-row--empty">no entities</li>}
      </ul>
    </div>
  );
}

/** The icon file per entity kind (see packages/editor/public/icons). */
const ROW_ICON: Record<string, string> = { box: 'box', camera: 'camera', light: 'sun', model: 'model', entity: 'empty' };
