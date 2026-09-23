/**
 * Hierarchy panel (React, decision 0001 §10; phase 12) — the entity tree.
 *
 * - Rows collapse and expand (the arrow); which rows are collapsed is kept in
 *   this browser per project (localStorage), never in the project.
 * - Click selects, Ctrl/Cmd+click toggles, Shift+click selects a range.
 * - Dragging a row (or the selection it belongs to) drops it before a row
 *   (top edge), after it (bottom edge) or into it (middle): into a folder
 *   files it, into an object makes it a child. The empty list area files it
 *   at the root, at the end. World positions are kept by the command.
 * - Double-click renames.
 *
 * Every edit is a command issued by the app (`moveEntities`, `updateEntity`).
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react';

import {
  draggedRoots,
  dropTarget,
  dropZoneAt,
  nextSelection,
  visibleRows,
  type DropTarget,
  type EffectiveEntityFlags,
} from '../session/hierarchy';
import type { ProjectedEntity } from '../session/projection';

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
}

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

export function Hierarchy({ entities, flags, projectId, selectedIds, primaryId, onSelect, onRename, onMove }: Props): JSX.Element {
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
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

  const rows = useMemo(() => visibleRows(entities, collapsed, filter), [entities, collapsed, filter]);
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
  };
  const overRow = (ev: DragEvent<HTMLLIElement>, id: string): void => {
    if (!ev.dataTransfer.types.includes(DRAG_TYPE) || dragging.current === null) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const target = dropTarget(entities, dragging.current, id, dropZoneAt(ev.clientY - rect.top, rect.height));
    ev.stopPropagation();
    if (target === null) {
      ev.dataTransfer.dropEffect = 'none';
      setDrop(null);
      return;
    }
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    setDrop({ targetId: id, target });
  };
  const dropOn = (ev: DragEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    const ids = dragging.current;
    const target = drop?.target ?? null;
    endDrag();
    if (ids !== null && target !== null) onMove(ids, target.parentId, target.beforeId);
  };

  const dropClass = (id: string): string => {
    if (drop === null || drop.targetId !== id) return '';
    return drop.target.zone === 'into' ? 'is-drop' : drop.target.zone === 'before' ? 'is-drop-before' : 'is-drop-after';
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
      <ul
        className={drop !== null && drop.targetId === null ? 'tl-hierarchy__list is-drop-root' : 'tl-hierarchy__list'}
        aria-label="Hierarchy"
        onDragOver={(ev) => {
          if (!ev.dataTransfer.types.includes(DRAG_TYPE) || dragging.current === null) return;
          ev.preventDefault();
          setDrop({ targetId: null, target: { parentId: null, beforeId: null, zone: 'after' } });
        }}
        onDragLeave={(ev) => {
          if (ev.currentTarget === ev.target) setDrop(null);
        }}
        onDrop={dropOn}
      >
        {rows.map((r) => {
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
        })}
        {rows.length === 0 && <li className="tl-row tl-row--empty">no entities</li>}
      </ul>
    </div>
  );
}

/** The icon file per entity kind (see packages/editor/public/icons). */
const ROW_ICON: Record<string, string> = { box: 'box', camera: 'camera', light: 'sun', model: 'model', entity: 'empty' };
