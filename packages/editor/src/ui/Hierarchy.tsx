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
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react';

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
import { ASSET_DRAG_TYPE, parseAssetDrag, type AssetDragPayload } from '../session/placement';

interface Props {
  entities: ProjectedEntity[];
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

export function Hierarchy({ entities, flags, projectId, selectedIds, primaryId, onSelect, onRename, onMove, scenes, closedScenes, onSceneAction, onAssetDrop }: Props): JSX.Element {
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [renamingScene, setRenamingScene] = useState<{ sceneId: string; draft: string } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(projectId));
  const [drop, setDrop] = useState<{ targetId: string | null; target: DropTarget } | null>(null);
  const dragging = useRef<string[] | null>(null);
  const anchor = useRef<string | null>(null);

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
  const sceneTrees = useMemo(
    () =>
      scenes === undefined
        ? null
        : scenes.map((sc) => ({
            scene: sc,
            rows: collapsed.has(`scene:${sc.sceneId}`) ? [] : visibleRows(entities.filter((e) => e.sceneId === sc.sceneId), collapsed, filter),
          })),
    [scenes, entities, collapsed, filter],
  );
  const rows: TreeRow[] = useMemo(
    () => (sceneTrees !== null ? sceneTrees.flatMap((t) => t.rows) : visibleRows(entities, collapsed, filter)),
    [sceneTrees, entities, collapsed, filter],
  );
  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const selected = new Set(selectedIds);

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

  const renderRow = (r: TreeRow): JSX.Element | null => {
          const e = byId.get(r.id);
          if (!e) return null;
          const f = flags.get(r.id);
          const inactive = f !== undefined && !f.active;
          const locked = f?.locked === true;
          const isCollapsed = collapsed.has(r.id);
          return (
            <li
              key={r.id}
              data-entity-id={r.id}
              aria-selected={selected.has(r.id)}
              style={{ paddingLeft: `${4 + r.depth * 14}px` }}
              className={[
                'tl-row',
                selected.has(r.id) ? 'is-selected' : '',
                r.id === primaryId ? 'is-primary' : '',
                inactive ? 'is-inactive' : '',
                dropClass(r.id),
              ].join(' ').replace(/\s+/g, ' ').trim()}
              onClick={(ev) => {
                const next = nextSelection(selectedIds, anchor.current, r.id, { toggle: ev.ctrlKey || ev.metaKey, range: ev.shiftKey }, rows);
                anchor.current = next.anchor;
                onSelect(next.ids, next.primary);
              }}
              onDoubleClick={() => setRenaming({ id: r.id, draft: e.name })}
              draggable={renaming?.id !== r.id}
              onDragStart={(ev) => {
                // Dragging a selected row drags the whole selection.
                const ids = selected.has(r.id) ? draggedRoots(entities, selectedIds) : [r.id];
                if (!selected.has(r.id)) {
                  anchor.current = r.id;
                  onSelect([r.id], r.id);
                }
                dragging.current = ids;
                ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
                ev.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={endDrag}
              onDragOver={(ev) => overRow(ev, r.id)}
              onDrop={dropOn}
            >
              {r.hasChildren ? (
                <button
                  className="tl-row__twisty"
                  aria-label={isCollapsed ? `expand ${e.name}` : `collapse ${e.name}`}
                  aria-expanded={!isCollapsed}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    toggleCollapsed(r.id);
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
                <img className="tl-row__icon" src={`./icons/${ROW_ICON[e.kind] ?? 'empty'}.png`} alt="" aria-hidden="true" />
              )}
              <span className={`tl-row__kind tl-row__kind--${e.kind}`}>{e.kind}</span>
              {renaming?.id === r.id ? (
                <input
                  className="tl-row__rename"
                  aria-label="rename"
                  autoFocus
                  value={renaming.draft}
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={(ev) => setRenaming({ id: r.id, draft: ev.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') commitRename();
                    if (ev.key === 'Escape') setRenaming(null);
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
        };

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
        className={drop !== null && drop.targetId === null ? 'tl-hierarchy__list is-drop-root' : 'tl-hierarchy__list'}
        aria-label="Hierarchy"
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
        {sceneTrees === null
          ? rows.map(renderRow)
          : sceneTrees.map(({ scene: sc, rows: sceneRows }) => {
              const sceneCollapsed = collapsed.has(`scene:${sc.sceneId}`);
              return [
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
                </li>,
                ...sceneRows.map(renderRow),
              ];
            })}
        {rows.length === 0 && <li className="tl-row tl-row--empty">no entities</li>}
      </ul>
    </div>
  );
}

/** The icon file per entity kind (see packages/editor/public/icons). */
const ROW_ICON: Record<string, string> = { box: 'box', camera: 'camera', light: 'sun', model: 'model', entity: 'empty' };
