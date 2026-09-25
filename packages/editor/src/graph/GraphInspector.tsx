/**
 * Phase 16.1: the Inspector for the selected graph item (node, edge, group
 * or comment). Node fields come from the node type's schema; every change
 * is one `graphEdit` through the host's `onEdit`.
 *
 * Phase 16.2: a graph kind may extend it — `extension(id)` renders the
 * Inspector for an item the kind knows better (an animator state, a
 * transition wire); it returns null for the rest, which get the generic
 * forms. `empty` replaces the hint shown when nothing is selected.
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react';

import { diagnoseGraph, edgeConversion, fieldValue, nodeDefOf, portDef, portsResolver, portTypeLabel, type GraphContext, type GraphData, type GraphKindDef, type GraphOp, type PortsOf } from './model';
import type { GraphFieldDef, GraphNode, GraphValue } from '@thirdlight/project-model';

interface Props {
  kind: GraphKindDef;
  graph: GraphData;
  ids: readonly string[];
  onEdit: (ops: GraphOp[]) => Promise<string | null>;
  /** Phase 16.2: the kind's own Inspector for an item (null = the generic form). */
  extension?: (id: string) => ReactNode | null;
  /** Phase 16.2: shown when nothing is selected. */
  empty?: ReactNode;
  /** Phase 18.1: what data-dependent ports read outside the graph (see GraphEditor). */
  portContext?: GraphContext;
  /** Phase 18.1: the choices for a field that names an asset (`GraphFieldDef.asset`); absent = a text box. */
  assetOptions?: (assetKind: string) => readonly { id: string; label: string }[];
  /** Phase 19.2: the choices of a text field the host knows (e.g. a call node's function: the script's functions); undefined = a text box. */
  fieldOptions?: (field: GraphFieldDef, node: GraphNode) => readonly { id: string; label: string }[] | undefined;
}

export function GraphInspector({ kind, graph, ids, onEdit, extension, empty, portContext, assetOptions, fieldOptions }: Props): JSX.Element {
  const portsOf = portsResolver(kind, graph, portContext);
  const [error, setError] = useState<string | null>(null);
  const edit = (ops: GraphOp[]): void => {
    void onEdit(ops).then(setError);
  };
  useEffect(() => setError(null), [ids.join(',')]);
  if (ids.length === 0) return <>{empty ?? <div className="tl-inspector__empty">Select a node, wire, group or comment.</div>}</>;
  if (ids.length > 1) return <div className="tl-inspector__empty">{ids.length} items selected.</div>;
  const id = ids[0]!;
  const own = extension?.(id) ?? null;
  if (own !== null) return <div className="tl-graph-inspector" aria-label="Graph item">{own}</div>;
  const node = graph.nodes.find((n) => n.id === id);
  const edge = graph.edges.find((e) => e.id === id);
  const group = (graph.groups ?? []).find((g) => g.id === id);
  const comment = (graph.comments ?? []).find((c) => c.id === id);
  return (
    <div className="tl-graph-inspector" aria-label="Graph item">
      {node !== undefined && <NodeFields kind={kind} graph={graph} node={node} edit={edit} portsOf={portsOf} {...(assetOptions !== undefined ? { assetOptions } : {})} {...(fieldOptions !== undefined ? { fieldOptions } : {})} />}
      {edge !== undefined && (
        <>
          <div className="tl-inspector__title">Wire</div>
          <p className="tl-hint">
            {edge.from.node}.{edge.from.port} → {edge.to.node}.{edge.to.port}
          </p>
          {(() => {
            const conv = edgeConversion(kind, graph, edge, portsOf);
            const out = portDef(kind, graph, edge.from.node, edge.from.port, 'out', portsOf);
            return <p className="tl-hint">{conv !== null ? `Implicit conversion: ${conv.label}` : `Type: ${portTypeLabel(kind, out?.type ?? '')}`}</p>;
          })()}
          <p className="tl-hint">{(edge.reroutes ?? []).length} reroute point(s) — double-click the wire to add one.</p>
          <button className="tl-btn tl-btn--small" onClick={() => edit([{ op: 'disconnect', ids: [edge.id] }])}>
            Delete wire
          </button>
        </>
      )}
      {group !== undefined && (
        <>
          <div className="tl-inspector__title">Group</div>
          <label className="tl-field">
            <span>Title</span>
            <TextField value={group.title} maxLength={64} label="Group title" onCommit={(title) => edit([{ op: 'setGroups', groups: [{ ...group, title }] }])} />
          </label>
          <label className="tl-field">
            <span>Colour</span>
            <input type="color" aria-label="Group colour" value={group.color} onChange={(e) => edit([{ op: 'setGroups', groups: [{ ...group, color: e.target.value.toLowerCase() }] }])} />
          </label>
        </>
      )}
      {comment !== undefined && (
        <>
          <div className="tl-inspector__title">Comment</div>
          <TextField multiline value={comment.text} maxLength={2000} label="Comment text" onCommit={(text) => text.length > 0 && edit([{ op: 'setComments', comments: [{ ...comment, text }] }])} />
        </>
      )}
      {error !== null && (
        <p className="tl-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function NodeFields({
  kind,
  graph,
  node,
  edit,
  portsOf,
  assetOptions,
  fieldOptions,
}: {
  kind: GraphKindDef;
  graph: GraphData;
  node: GraphNode;
  edit: (ops: GraphOp[]) => void;
  portsOf: PortsOf;
  assetOptions?: (assetKind: string) => readonly { id: string; label: string }[];
  fieldOptions?: (field: GraphFieldDef, node: GraphNode) => readonly { id: string; label: string }[] | undefined;
}): JSX.Element {
  const def = nodeDefOf(kind, node.type);
  const problems = diagnoseGraph(kind, graph, portsOf).filter((p) => p.nodeId === node.id);
  const ports = portsOf(node);
  const setField = (f: GraphFieldDef, v: GraphValue): void => {
    const data = { ...(node.data ?? {}) };
    // A value equal to the field default is not stored (absent = default).
    if (JSON.stringify(v) === JSON.stringify(f.default)) delete data[f.key];
    else data[f.key] = v;
    edit([{ op: 'setNodeData', id: node.id, data }]);
  };
  return (
    <>
      <div className="tl-inspector__title">{def?.label ?? node.type}</div>
      <p className="tl-hint">
        {def?.category ?? ''} · {node.id}
        {def?.description !== undefined ? ` — ${def.description}` : ''}
      </p>
      {problems.map((p, i) => (
        <p key={i} className={p.severity === 'error' ? 'tl-error' : 'tl-hint tl-warn'}>
          {p.severity}: {p.message}
        </p>
      ))}
      <label className="tl-field tl-field--check">
        <input type="checkbox" checked={node.collapsed === true} aria-label="Collapsed" onChange={(e) => edit([{ op: 'setCollapsed', ids: [node.id], collapsed: e.target.checked }])} />
        <span>Collapsed</span>
      </label>
      {(def?.fields ?? []).map((f) => {
        const v = fieldValue(node, f);
        const choices = f.type === 'string' ? fieldOptions?.(f, node) : undefined;
        return (
          <label key={f.key} className="tl-field">
            <span>{f.label}</span>
            {choices !== undefined ? (
              <select className="tl-input" aria-label={f.label} value={String(v)} onChange={(e) => setField(f, e.target.value)}>
                <option value="">(none)</option>
                {choices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
                {String(v) !== '' && !choices.some((o) => o.id === v) && <option value={String(v)}>{String(v)} (missing)</option>}
              </select>
            ) : f.type === 'color' ? (
              <input type="color" aria-label={f.label} value={String(v)} onChange={(e) => setField(f, e.target.value.toLowerCase())} />
            ) : f.type === 'string' && f.asset !== undefined && assetOptions !== undefined ? (
              <select className="tl-input" aria-label={f.label} value={String(v)} onChange={(e) => setField(f, e.target.value)}>
                <option value="">(none)</option>
                {assetOptions(f.asset).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
                {String(v) !== '' && !assetOptions(f.asset).some((o) => o.id === v) && <option value={String(v)}>{String(v)} (missing)</option>}
              </select>
            ) : f.type === 'boolean' ? (
              <input type="checkbox" aria-label={f.label} checked={v === true} onChange={(e) => setField(f, e.target.checked)} />
            ) : f.type === 'enum' ? (
              <select className="tl-input" aria-label={f.label} value={String(v)} onChange={(e) => setField(f, e.target.value)}>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : f.type === 'number' ? (
              <NumberField label={f.label} value={v as number} {...(f.min !== undefined ? { min: f.min } : {})} {...(f.max !== undefined ? { max: f.max } : {})} onCommit={(n) => setField(f, n)} />
            ) : f.type === 'vector' ? (
              <span className="tl-graph-inspector__vec">
                {(v as number[]).map((x, i) => (
                  <NumberField key={i} label={`${f.label} ${i + 1}`} value={x} {...(f.min !== undefined ? { min: f.min } : {})} {...(f.max !== undefined ? { max: f.max } : {})} onCommit={(n) => setField(f, (v as number[]).map((y, j) => (j === i ? n : y)))} />
                ))}
              </span>
            ) : (
              <TextField label={f.label} value={String(v)} maxLength={f.maxLength ?? 256} onCommit={(s) => setField(f, s)} />
            )}
          </label>
        );
      })}
      {def !== undefined && (
        <p className="tl-hint">
          Inputs: {ports.inputs.map((p) => `${p.label} (${portTypeLabel(kind, p.type)}${p.multi === true ? ', many' : ''}${p.required === true ? ', required' : ''})`).join(', ') || 'none'}
          <br />
          Outputs: {ports.outputs.map((p) => `${p.label} (${portTypeLabel(kind, p.type)})`).join(', ') || 'none'}
        </p>
      )}
    </>
  );
}

/** A number input that commits on Enter or blur (one edit per commit). */
function NumberField({ label, value, min, max, onCommit }: { label: string; value: number; min?: number; max?: number; onCommit: (v: number) => void }): JSX.Element {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
      setText(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return <input className="tl-input tl-input--num" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

function TextField({ label, value, maxLength, multiline, onCommit }: { label: string; value: string; maxLength: number; multiline?: boolean; onCommit: (v: string) => void }): JSX.Element {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (): void => {
    if (text !== value) onCommit(text);
  };
  return multiline === true ? (
    <textarea className="tl-input" aria-label={label} rows={4} maxLength={maxLength} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />
  ) : (
    <input className="tl-input" aria-label={label} maxLength={maxLength} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
  );
}
