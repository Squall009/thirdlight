/**
 * The "Material: <name>" tab of the editor window — a graph material's
 * node graph on the graph framework with the material node catalogue.
 *
 * - The graph: every gesture is one `graphEdit` on owner kind `material`
 *   (owner id = the materialId); the selection shows in the right dock's
 *   Inspector (GraphInspector with the material kind).
 * - Left: the exposed parameters (key, type, default, range, visibility) —
 *   Parameter nodes read them, objects override the public ones. Each change
 *   is one `setMaterial`.
 * - The editor window's preview pane shows the material on a shape or a
 *   model of the project, compiled like the Scene view, Play and exports
 *   draw it; the compile problems show on their nodes (with the kind's own
 *   rules) and in the Problems tab.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { GraphDocument, GraphValue, MaterialDef, MaterialParameter } from '@thirdlight/project-model';
import { MATERIAL_DATA_MAX, MAX_TEXTURE_LAYERS } from '@thirdlight/project-model/limits';
import { materialGraphProblems, type MaterialFunctionLike } from '@thirdlight/three-adapter';

import { GraphEditor } from '../../graph/GraphEditor';
import type { GraphKindDef, GraphOp } from '../../graph/model';
import { materialPortContext, parameterDefault } from '../../session/material-graph';
import { slotProblemInput } from '../../session/texture-slots';
import { stringsIn, useTextureIds } from '../catalog/catalog-context';
import { RefPicker, TEXTURE_KINDS } from '../catalog/RefPicker';
import { usePreview } from '../preview/preview-request';
import { EditorToolbar, ToolButton, ToolbarSpacer } from '../chrome/EditorChrome';

export interface MaterialDocumentProps {
  materialId: string;
  materials: readonly MaterialDef[];
  /** The registered graph kinds (from the backend). */
  kinds: Readonly<Record<string, GraphKindDef>>;
  /** The project's standalone graphs (material functions are called from the graph). */
  graphs: readonly GraphDocument[];
  /** Sends `graphEdit` ops for the material (queued; resolves with a refusal or null). */
  onEdit: (materialId: string, ops: GraphOp[]) => Promise<string | null>;
  /** One `setMaterial` (parameters, name, removing the graph). */
  onSave: (material: MaterialDef) => void;
  onSelection: (ids: readonly string[]) => void;
  focus: { id: string; nonce: number } | null;
  error: string | null;
}

const PARAM_TYPES: readonly MaterialParameter['type'][] = ['float', 'vec2', 'vec3', 'vec4', 'color', 'texture', 'data'];
/** A new data parameter's grid (8 × 8 cells; any size up to MATERIAL_DATA_MAX per side). */
const NEW_DATA_SIZE: [number, number] = [8, 8];

export function MaterialDocument(p: MaterialDocumentProps): JSX.Element {
  const m = p.materials.find((x) => x.materialId === p.materialId) ?? null;
  const kind = p.kinds['material'];
  const portContext = useMemo(() => materialPortContext(m?.parameters, p.graphs, p.kinds), [m?.parameters, p.graphs, p.kinds]);
  // What the compiler says about this graph (missing textures, functions, parameters; pixel-only inputs in a vertex offset).
  // The textures it names (read by id: the project may hold thousands).
  const named = useMemo(() => stringsIn([m?.graph ?? null, m?.parameters ?? null]), [m?.graph, m?.parameters]);
  const textureIds = useTextureIds(named);
  // The preview pane shows this material (the functions it may call compile with it).
  const functions = useMemo(() => p.graphs.filter((g) => g.kind === 'material-function'), [p.graphs]);
  const hasGraph = m?.graph !== undefined;
  usePreview(useMemo(() => (hasGraph ? { kind: 'material' as const, materialId: p.materialId, materials: p.materials, functions: functions as unknown as MaterialFunctionLike[] } : null), [hasGraph, p.materialId, p.materials, functions]));
  const compileProblems = useMemo(() => {
    if (m?.graph === undefined) return [];
    // Per-layer slots compile as their array's key.
    const input = slotProblemInput(m, textureIds);
    return materialGraphProblems({ graph: m.graph, ...(input.parameters !== undefined ? { parameters: input.parameters as unknown as Parameters<typeof materialGraphProblems>[0]['parameters'] } : {}) }, p.graphs as unknown as MaterialFunctionLike[], input.textureIds);
  }, [m, p.graphs, textureIds]);
  if (m === null) return <p className="tl-hint">This material no longer exists (deleted or undone). Close the tab, or undo the deletion.</p>;
  if (kind === undefined) return <p className="tl-hint">Loading the material node catalogue…</p>;
  if (m.graph === undefined) return <p className="tl-hint">"{m.name}" is a shader material (no graph). Choose it in the project window and use "Convert to graph" in its Inspector.</p>;
  const newNodeData = (type: string): Record<string, GraphValue> | undefined => {
    // A new Parameter node reads the first declared parameter; a new call runs the first function.
    if (type === 'parameter' && (m.parameters ?? []).length > 0) return { key: m.parameters![0]!.key };
    if (type === 'call' && functions.length > 0) return { function: functions[0]!.graphId };
    return undefined;
  };
  return (
    <div className="tl-animator-doc tl-material-doc" aria-label="material graph">
      <EditorToolbar label="material toolbar">
        <span className="tl-editor-toolbar__note">Graph material</span>
        <ToolbarSpacer />
        <ToolButton
          action="delete"
          label="Remove graph"
          title="Back to the shader material (the graph is removed; undo brings it back)"
          onClick={() => {
            const { graph: _g, ...rest } = m;
            p.onSave(rest);
          }}
        />
      </EditorToolbar>
      <p className="tl-hint tl-material-doc__note" role="note">
        The preview, the Scene view, Play and exports draw this graph (compiled to a node material); the {m.shader} shader part is used only after Remove graph.
      </p>
      {p.error !== null && (
        <p className="tl-error" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-animator-doc__main">
        <div className="tl-animator-doc__side">
          <ParameterEditor material={m} onSave={p.onSave} />
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
            extraProblems={compileProblems}
          />
        </div>
      </div>
    </div>
  );
}

/** The exposed parameters: one row per parameter; each change is one `setMaterial`. */
function ParameterEditor({ material, onSave }: { material: MaterialDef; onSave: (m: MaterialDef) => void }): JSX.Element {
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
        <ToolButton action="add" label="Parameter" aria="add parameter" title="A parameter Parameter nodes read (objects may override public ones)" onClick={add} />
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
              const { min: _a, max: _b, size: _c, ...rest } = x;
              const { size: _d, ...ranged } = x;
              const numeric = type === 'float' || type.startsWith('vec');
              save(list.map((y, j) => (j === i ? { ...(numeric ? ranged : rest), type, default: parameterDefault(type), ...(type === 'data' ? { size: NEW_DATA_SIZE } : {}) } : y)));
            }}
          >
            {PARAM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <ParameterValue param={x} slots onCommit={(v) => setAt(i, { default: v })} />
          {x.type === 'data' && <DataSize value={x.size ?? NEW_DATA_SIZE} name={`parameter ${x.key} size`} onCommit={(size) => setAt(i, { size })} />}
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

/**
 * A parameter's default: a number, 2–4 numbers, a colour or a texture
 * (committed on blur / change). `slots`: a texture may instead name one
 * single-layer texture per array layer (a material's default or an
 * instance's value, not an object's override).
 */
export function ParameterValue({ param, onCommit, label, slots }: { param: Pick<MaterialParameter, 'type' | 'key' | 'default' | 'min' | 'max'>; onCommit: (v: MaterialParameter['default']) => void; label?: string; slots?: boolean }): JSX.Element {
  const name = label ?? `parameter ${param.key} default`;
  const [draft, setDraft] = useState<string>(Array.isArray(param.default) ? param.default.join(', ') : String(param.default));
  if (param.type === 'color') return <input type="color" aria-label={name} value={String(param.default)} onChange={(e) => onCommit(e.target.value.toLowerCase())} />;
  if (param.type === 'texture') return <TextureValue value={param.default} name={name} slots={slots === true} onCommit={onCommit} />;
  // A data parameter's default is the RGBA bytes every cell starts with.
  const n = param.type === 'float' ? 1 : param.type === 'data' ? 4 : Number(param.type.slice(3));
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

/** The slots a texture parameter starts with when switched to per-layer slots (the layered template's four layers). */
const NEW_SLOT_COUNT = 4;

/**
 * A texture value: one texture (a plain one or an array), or per-layer
 * slots — a picker per array layer, Play and the export assemble the array.
 * A new slot list is held here until one slot names a texture (a list with
 * none filled is not a value).
 */
function TextureValue({ value, name, slots, onCommit }: { value: MaterialParameter['default']; name: string; slots: boolean; onCommit: (v: MaterialParameter['default']) => void }): JSX.Element {
  // The list shown until the material holds it: picks not saved yet (a quick second pick builds on the
  // first, not on the saved list), or a new list with no slot filled (not a value to save).
  const [held, setHeld] = useState<string[] | null>(null);
  const saved = Array.isArray(value) ? (value as unknown[]).map(String) : null;
  const confirmed = held !== null && saved !== null && held.length === saved.length && held.every((x, i) => x === saved[i]);
  useEffect(() => {
    if (confirmed) setHeld(null);
  }, [confirmed]);
  // An object's override is one texture: over a material's slots it starts as none (the slots draw).
  if (!slots && Array.isArray(value)) return <RefPicker aria={name} kinds={TEXTURE_KINDS} value="" none="(the material's slots)" onPick={(id) => onCommit(id)} />;
  const list = held ?? saved;
  if (list === null) {
    return (
      <span className="tl-texture-value">
        <RefPicker aria={name} kinds={TEXTURE_KINDS} value={String(value)} none="(none)" onPick={(id) => onCommit(id)} />
        {slots && (
          <button type="button" className="tl-btn tl-btn--small" aria-label={`${name} per-layer slots`} title="One single-layer texture per array layer instead of a prebuilt array (Play and the export assemble the array; an empty slot takes the first filled slot's texture)" onClick={() => setHeld(Array.from({ length: NEW_SLOT_COUNT }, () => ''))}>
            slots
          </button>
        )}
      </span>
    );
  }
  const set = (next: string[]): void => {
    setHeld(next);
    if (next.some((x) => x !== '')) onCommit(next);
  };
  return (
    <span className="tl-texture-slots" role="group" aria-label={`${name} slots`}>
      {list.map((id, i) => (
        <RefPicker key={i} aria={`${name} slot ${i + 1}`} kinds={TEXTURE_KINDS} value={id} none="(empty)" onPick={(v) => set(list.map((x, j) => (j === i ? v : x)))} />
      ))}
      <button type="button" className="tl-btn tl-btn--small" aria-label={`${name} add slot`} title="Another array layer" disabled={list.length >= MAX_TEXTURE_LAYERS} onClick={() => set([...list, ''])}>
        +
      </button>
      <button type="button" className="tl-btn tl-btn--small" aria-label={`${name} remove slot`} title="Drop the last array layer" disabled={list.length <= 1} onClick={() => set(list.slice(0, -1))}>
        −
      </button>
      <button
        type="button"
        className="tl-btn tl-btn--small"
        aria-label={`${name} one texture`}
        title="Back to one texture (a prebuilt array or a plain texture)"
        onClick={() => {
          setHeld(null);
          onCommit('');
        }}
      >
        one
      </button>
    </span>
  );
}

/** A data parameter's grid size (cells per side, 1–64; committed on blur / Enter). */
function DataSize({ value, name, onCommit }: { value: readonly [number, number]; name: string; onCommit: (v: [number, number]) => void }): JSX.Element {
  const [draft, setDraft] = useState(`${value[0]}, ${value[1]}`);
  const commit = (): void => {
    const parts = draft.split(/[,x×]/).map((s) => Number(s.trim()));
    if (parts.length !== 2 || !parts.every((x) => Number.isInteger(x) && x >= 1 && x <= MATERIAL_DATA_MAX)) {
      setDraft(`${value[0]}, ${value[1]}`);
      return;
    }
    if (parts[0] !== value[0] || parts[1] !== value[1]) onCommit([parts[0]!, parts[1]!]);
  };
  return <input className="tl-input tl-input--num" aria-label={name} title={`cells: width, height (1–${MATERIAL_DATA_MAX} each)`} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}
