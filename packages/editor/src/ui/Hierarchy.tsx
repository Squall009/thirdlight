/**
 * Hierarchy panel (React, decision 0001 §10) — the entity list.
 * Shows the projection's entities in a parent/child tree; clicking selects,
 * double-clicking renames, dragging a row onto another reparents it (onto
 * the list background: makes it a root). Edits are commands issued by the app.
 */
import { useState, type DragEvent, type JSX } from 'react';
import type { ProjectedEntity } from '../session/projection';

interface Props {
  entities: ProjectedEntity[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onReparent: (id: string, parentId: string | null) => void;
}

const DRAG_TYPE = 'application/x-thirdlight-entity';

interface Row {
  id: string;
  depth: number;
}

function buildRows(entities: ProjectedEntity[]): Row[] {
  const byParent = new Map<string | null, ProjectedEntity[]>();
  for (const e of entities) {
    const key = e.parentId;
    const arr = byParent.get(key) ?? [];
    arr.push(e);
    byParent.set(key, arr);
  }
  const rows: Row[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    const children = byParent.get(parentId) ?? [];
    for (const c of children) {
      rows.push({ id: c.id, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function Hierarchy({ entities, selectedId, onSelect, onRename, onReparent }: Props): JSX.Element {
  const [filter, setFilter] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const commitRename = (): void => {
    if (renaming !== null) {
      const name = renaming.draft.trim();
      const current = entities.find((e) => e.id === renaming.id);
      if (name !== '' && current !== undefined && name !== current.name) onRename(renaming.id, name);
    }
    setRenaming(null);
  };
  const dragged = (e: DragEvent): string | null => e.dataTransfer.getData(DRAG_TYPE) || null;
  const rows = buildRows(entities);
  const shown = filter === '' ? rows : rows.filter((r) => {
    const e = entities.find((x) => x.id === r.id);
    return e && (e.name.toLowerCase().includes(filter.toLowerCase()) || e.id.toLowerCase().includes(filter.toLowerCase()));
  });
  const byId = new Map(entities.map((e) => [e.id, e]));
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
        className={dropTarget === '' ? 'tl-hierarchy__list is-drop-root' : 'tl-hierarchy__list'}
        onDragOver={(ev) => {
          if (ev.dataTransfer.types.includes(DRAG_TYPE)) {
            ev.preventDefault();
            setDropTarget('');
          }
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(ev) => {
          const id = dragged(ev);
          setDropTarget(null);
          if (id !== null && entities.find((x) => x.id === id)?.parentId !== null) onReparent(id, null);
        }}
      >
        {shown.map((r) => {
          const e = byId.get(r.id);
          if (!e) return null;
          return (
            <li
              key={r.id}
              style={{ paddingLeft: `${8 + r.depth * 14}px` }}
              className={['tl-row', r.id === selectedId ? 'is-selected' : '', dropTarget === r.id ? 'is-drop' : ''].join(' ').trim()}
              onClick={() => onSelect(r.id === selectedId ? null : r.id)}
              onDoubleClick={() => setRenaming({ id: r.id, draft: e.name })}
              draggable={renaming?.id !== r.id}
              onDragStart={(ev) => {
                ev.dataTransfer.setData(DRAG_TYPE, r.id);
                ev.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(ev) => {
                if (!ev.dataTransfer.types.includes(DRAG_TYPE)) return;
                ev.preventDefault();
                ev.stopPropagation();
                setDropTarget(r.id);
              }}
              onDrop={(ev) => {
                ev.stopPropagation();
                const id = dragged(ev);
                setDropTarget(null);
                if (id !== null && id !== r.id && e.parentId !== id) onReparent(id, r.id);
              }}
            >
              <img className="tl-row__icon" src={`./icons/${ROW_ICON[e.kind]}.png`} alt="" aria-hidden="true" />
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
            </li>
          );
        })}
        {shown.length === 0 && <li className="tl-row tl-row--empty">no entities</li>}
      </ul>
    </div>
  );
}

/** The icon file per entity kind (see packages/editor/public/icons). */
const ROW_ICON: Record<string, string> = { box: 'box', camera: 'camera', light: 'sun', model: 'model', entity: 'empty' };
