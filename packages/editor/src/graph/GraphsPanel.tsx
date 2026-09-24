/**
 * Phase 16.1: the Graphs list (bottom dock) — the project's standalone graph
 * documents with their kind and problem counts; create, rename, delete and
 * open (the graph opens in the centre area). Graphs owned by other
 * documents (animator controllers, materials, behaviors, effects) open from
 * their own lists in later phases.
 */
import { useState, type JSX } from 'react';

import { diagnoseGraph, type GraphKindDef } from './model';
import type { GraphDocument } from '@thirdlight/project-model';

interface Props {
  graphs: readonly GraphDocument[];
  kinds: Readonly<Record<string, GraphKindDef>>;
  openId: string | null;
  error: string | null;
  onOpen: (graphId: string) => void;
  onCreate: (kind: string, name: string) => void;
  onRename: (graphId: string, name: string) => void;
  onDelete: (graphId: string) => void;
}

export function GraphsPanel({ graphs, kinds, openId, error, onOpen, onCreate, onRename, onDelete }: Props): JSX.Element {
  const kindIds = Object.keys(kinds);
  const [kind, setKind] = useState<string>(kindIds[0] ?? '');
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="tl-panel tl-graphs">
      <div className="tl-panel__title">Graphs</div>
      <form
        className="tl-graphs__new"
        onSubmit={(e) => {
          e.preventDefault();
          const k = kindIds.includes(kind) ? kind : (kindIds[0] ?? '');
          if (k === '' || name.trim() === '') return;
          onCreate(k, name.trim());
          setName('');
        }}
      >
        <select className="tl-input" aria-label="Graph kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kindIds.map((k) => (
            <option key={k} value={k}>
              {kinds[k]!.label}
            </option>
          ))}
        </select>
        <input className="tl-input" aria-label="New graph name" placeholder="New graph name" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="tl-btn tl-btn--small" type="submit" disabled={name.trim() === '' || kindIds.length === 0}>
          Create graph
        </button>
      </form>
      {error !== null && (
        <p className="tl-error" role="alert">
          {error}
        </p>
      )}
      {graphs.length === 0 ? (
        <div className="tl-inspector__empty">No graphs yet.</div>
      ) : (
        <ul className="tl-graphs__list" aria-label="Graph list">
          {graphs.map((g) => {
            const k = kinds[g.kind];
            const problems = k !== undefined ? diagnoseGraph(k, g.graph) : [];
            const errors = problems.filter((p) => p.severity === 'error').length;
            return (
              <li key={g.graphId} className={`tl-graphs__row${openId === g.graphId ? ' is-active' : ''}`} data-graph-id={g.graphId} onDoubleClick={() => onOpen(g.graphId)}>
                {renaming?.id === g.graphId ? (
                  <input
                    autoFocus
                    className="tl-input"
                    aria-label="Graph name"
                    maxLength={64}
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: g.graphId, name: e.target.value })}
                    onBlur={() => {
                      if (renaming.name.trim() !== '' && renaming.name !== g.name) onRename(g.graphId, renaming.name.trim());
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="tl-graphs__name">{g.name}</span>
                )}
                <span className="tl-graphs__meta">
                  {k?.label ?? g.kind} · {g.graph.nodes.length} node{g.graph.nodes.length === 1 ? '' : 's'}
                  {problems.length > 0 ? ` · ${errors} error${errors === 1 ? '' : 's'}, ${problems.length - errors} warning${problems.length - errors === 1 ? '' : 's'}` : ''}
                </span>
                <button className="tl-btn tl-btn--small" onClick={() => onOpen(g.graphId)} aria-label={`Open ${g.name}`}>
                  Open
                </button>
                <button className="tl-btn tl-btn--small" onClick={() => setRenaming({ id: g.graphId, name: g.name })} aria-label={`Rename ${g.name}`}>
                  Rename
                </button>
                <button className="tl-btn tl-btn--small" onClick={() => onDelete(g.graphId)} aria-label={`Delete ${g.name}`}>
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
