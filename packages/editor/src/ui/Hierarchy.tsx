/**
 * Hierarchy panel (React, decision 0001 §10) — the entity list.
 * Shows the projection's entities in a parent/child tree; clicking selects.
 * React renders the list only; the three.js viewport is untouched here.
 */
import { useState, type JSX } from 'react';
import type { ProjectedEntity } from '../session/projection';

interface Props {
  entities: ProjectedEntity[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

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

export function Hierarchy({ entities, selectedId, onSelect }: Props): JSX.Element {
  const [filter, setFilter] = useState('');
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
      <ul className="tl-hierarchy__list">
        {shown.map((r) => {
          const e = byId.get(r.id);
          if (!e) return null;
          return (
            <li
              key={r.id}
              style={{ paddingLeft: `${8 + r.depth * 14}px` }}
              className={r.id === selectedId ? 'tl-row is-selected' : 'tl-row'}
              onClick={() => onSelect(r.id === selectedId ? null : r.id)}
            >
              <span className={`tl-row__kind tl-row__kind--${e.kind}`}>{e.kind}</span>
              <span className="tl-row__name" title={e.id}>{e.name}</span>
            </li>
          );
        })}
        {shown.length === 0 && <li className="tl-row tl-row--empty">no entities</li>}
      </ul>
    </div>
  );
}