/**
 * Phase 18.0/18.1: the "Material: <name>" centre tab — a graph material's
 * node graph on the graph framework (16.1) with the material node catalogue.
 *
 * - The graph: every gesture is one `graphEdit` on owner kind `material`
 *   (owner id = the materialId); the selection shows in the right dock's
 *   Inspector (GraphInspector with the material kind).
 * - Left: the exposed parameters (key, type, default, range, visibility) —
 *   Parameter nodes read them, objects override the public ones. Each change
 *   is one `setMaterial`.
 * - Phase 18.3: the Scene view, Play and exports draw the graph (compiled to
 *   TSL); the live preview pane is 18.2.
 *
 * Browser-only (React).
 */
import { useMemo, useState, type JSX } from 'react';
import type { GraphDocument, GraphValue, MaterialDef, MaterialParameter } from '@thirdlight/project-model';

import { GraphEditor } from '../../graph/GraphEditor';
import type { GraphKindDef, GraphOp } from '../../graph/model';
import { materialPortContext, parameterDefault } from '../../session/material-graph';

export interface MaterialDocumentProps {
  materialId: string;
  materials: readonly MaterialDef[];
  /** The registered graph kinds (from the backend). */
  kinds: Readonly<Record<string, GraphKindDef>>;
  /** The project's standalone graphs (material functions are called from the graph). */
  graphs: readonly GraphDocument[];
  textures: readonly { assetId: string; displayName: string }[];
  /** Sends `graphEdit` ops for the material (queued; resolves with a refusal or null). */
  onEdit: (materialId: string, ops: GraphOp[]) => Promise<string | null>;
  /** One `setMaterial` (parameters, name, removing the graph). */
  onSave: (material: MaterialDef) => void;
  onSelection: (ids: readonly string[]) => void;
  focus: { id: string; nonce: number } | null;
  error: string | null;
}

const PARAM_TYPES: readonly MaterialParameter['type'][] = ['float', 'vec2', 'vec3', 'vec4', 'color', 'texture'];

export function MaterialDocument(p: MaterialDocumentProps): JSX.Element {
  const m = p.materials.find((x) => x.materialId === p.materialId) ?? null;
  const kind = p.kinds['material'];
  const portContext = useMemo(() => materialPortContext(m?.parameters, p.graphs, p.kinds), [m?.parameters, p.graphs, p.kinds]);
  if (m === null) return <p className="tl-hint">This material no longer exists (deleted or undone). Close the tab, or undo the deletion.</p>;
  if (kind === undefined) return <p className="tl-hint">Loading the material node catalogue…</p>;
  if (m.graph === undefined) return <p className="tl-hint">"{m.name}" is a shader material (no graph). Use "Convert to graph" in the Materials tab.</p>;
  const functions = p.graphs.filter((g) => g.kind === 'material-function');
  const newNodeData = (type: string): Record<string, GraphValue> | undefined => {
    // A new Parameter node reads the first declared parameter; a new call runs the first function.
    if (type === 'parameter' && (m.parameters ?? []).length > 0) return { key: m.parameters![0]!.key };
    if (type === 'call' && functions.length > 0) return { function: functions[0]!.graphId };
    return undefined;
  };
  return (
    <div className="tl-animator-doc tl-material-doc" aria-label="material graph">
      <div className="tl-animator__bar">
        <input className="tl-input" aria-label="material name" defaultValue={m.name} key={`${m.materialId}:${m.name}`} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== m.name && p.onSave({ ...m, name: e.target.value.trim().slice(0, 128) })} />
        <span className="tl-hint">Graph material</span>
        <span className="tl-graph__spacer" />
        <button
          type="button"
          className="tl-button"
          title="Back to the shader material (the graph is removed; undo brings it back)"
          onClick={() => {
            const { graph: _g, ...rest } = m;
            p.onSave(rest);
          }}
        >
          Remove graph
        </button>
      </div>
      <p className="tl-hint tl-material-doc__note" role="note">
        The Scene view, Play and exports draw this graph (compiled to a node material); the {m.shader} shader part is used only after Remove graph.
      </p>
      {p.error !== null && (
        <p className="tl-error" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-animator-doc__main">
        <div className="tl-animator-doc__side">
          <ParameterEditor material={m} textures={p.textures} onSave={p.onSave} />
        </div>
        <div className="tl-animator-doc__graph">
          <GraphEditor
            key={m.materialId}
            kind={kind}
            owner={{ kind: 'material', id: m.materialId }}
            graph={m.graph}
            onEdit={(ops) => p.onEdit(m.materialId, ops)}
            onSelection={p.onSelection}
            focus={p.focus}
            newNodeData={newNodeData}
            portContext={portContext}
          />
        </div>
      </div>
    </div>
  );
}

/** The exposed parameters: one row per parameter; each change is one `setMaterial`. */
function ParameterEditor({ material, textures, onSave }: { material: MaterialDef; textures: MaterialDocumentProps['textures']; onSave: (m: MaterialDef) => void }): JSX.Element {
  const list = material.parameters ?? [];
  const save = (next: MaterialParameter[]): void => onSave({ ...material, parameters: next });
  const setAt = (i: number, patch: Partial<MaterialParameter>): void => save(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const add = (): void => {
    let n = list.length + 1;
    while (list.some((x) => x.key === `param${n}`)) n++;
    save([...list, { key: `param${n}`, type: 'float', default: 0 }]);
  };
  return (
    <div className="tl-material-params" aria-label="exposed parameters">
      <div className="tl-subhead">
        Exposed parameters
        <button type="button" className="tl-btn tl-btn--small" onClick={add} title="A parameter Parameter nodes read (objects may override public ones)">
          + parameter
        </button>
      </div>
      {list.length === 0 && <p className="tl-hint">None yet. Parameter nodes read these; objects override the public ones (Inspector → Materials).</p>}
      {list.map((x, i) => (
        <div key={`${i}:${x.key}`} className="tl-material-param" data-parameter={x.key}>
          <input className="tl-input" aria-label={`parameter ${i + 1} key`} defaultValue={x.key} maxLength={32} onBlur={(e) => e.target.value !== x.key && setAt(i, { key: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <select
            className="tl-input"
            aria-label={`parameter ${x.key} type`}
            value={x.type}
            onChange={(e) => {
              // A new type starts at its default; a colour or texture has no range.
              const type = e.target.value as MaterialParameter['type'];
              const { min: _a, max: _b, ...rest } = x;
              const numeric = type === 'float' || type.startsWith('vec');
              save(list.map((y, j) => (j === i ? { ...(numeric ? x : rest), type, default: parameterDefault(type) } : y)));
            }}
          >
            {PARAM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <ParameterValue param={x} textures={textures} onCommit={(v) => setAt(i, { default: v })} />
          <select className="tl-input" aria-label={`parameter ${x.key} visibility`} value={x.visibility ?? 'public'} onChange={(e) => setAt(i, { visibility: e.target.value as 'public' | 'private' })}>
            <option value="public">public</option>
            <option value="private">private</option>
          </select>
          <button type="button" className="tl-btn tl-btn--small" aria-label={`remove parameter ${x.key}`} onClick={() => save(list.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** A parameter's default: a number, 2–4 numbers, a colour or a texture (committed on blur / change). */
export function ParameterValue({ param, textures, onCommit, label }: { param: Pick<MaterialParameter, 'type' | 'key' | 'default' | 'min' | 'max'>; textures: MaterialDocumentProps['textures']; onCommit: (v: MaterialParameter['default']) => void; label?: string }): JSX.Element {
  const name = label ?? `parameter ${param.key} default`;
  const [draft, setDraft] = useState<string>(Array.isArray(param.default) ? param.default.join(', ') : String(param.default));
  if (param.type === 'color') return <input type="color" aria-label={name} value={String(param.default)} onChange={(e) => onCommit(e.target.value.toLowerCase())} />;
  if (param.type === 'texture') {
    return (
      <select className="tl-input" aria-label={name} value={String(param.default)} onChange={(e) => onCommit(e.target.value)}>
        <option value="">(none)</option>
        {textures.map((t) => (
          <option key={t.assetId} value={t.assetId}>
            {t.displayName}
          </option>
        ))}
      </select>
    );
  }
  const n = param.type === 'float' ? 1 : Number(param.type.slice(3));
  const commit = (): void => {
    const parts = draft.split(',').map((s) => Number(s.trim()));
    if (parts.length !== n || parts.some((x) => !Number.isFinite(x))) {
      setDraft(Array.isArray(param.default) ? param.default.join(', ') : String(param.default));
      return;
    }
    const v = n === 1 ? parts[0]! : parts;
    if (JSON.stringify(v) !== JSON.stringify(param.default)) onCommit(v);
  };
  return <input className="tl-input tl-input--num" aria-label={name} title={n === 1 ? 'a number' : `${n} numbers, comma separated`} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}
