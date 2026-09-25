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
 * - Phase 18.2: a live preview (sphere, plane, cube or a model of the
 *   project, in the project environment) compiled like the Scene view, Play
 *   and exports draw it (18.3); the compile problems show on their nodes
 *   (with the kind's own rules) and in the Problems tab.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { GraphDocument, GraphValue, MaterialDef, MaterialParameter } from '@thirdlight/project-model';
import { materialGraphProblems, type EnvironmentLike, type MaterialDefLike, type MaterialFunctionLike, type WindLike } from '@thirdlight/three-adapter';
import type * as THREE from 'three';

import { GraphEditor } from '../../graph/GraphEditor';
import type { GraphKindDef, GraphOp } from '../../graph/model';
import { materialPortContext, parameterDefault } from '../../session/material-graph';
import { MaterialPreview, type PreviewShape } from '../../viewport/material-preview';

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
  /** Phase 18.2: the preview's environment (the project's, with its wind); null = a neutral backdrop. */
  environment: (EnvironmentLike & { wind?: WindLike }) | null;
  /** The project's model assets (the preview's "model" shape). */
  models: readonly { assetId: string; displayName: string }[];
  /** A texture asset's texture (the preview's own library). */
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  /** A model asset as a new object for the preview (null: unavailable); `dispose` releases it. */
  loadModel: (assetId: string) => Promise<{ root: THREE.Object3D; dispose: () => void } | null>;
}

const PARAM_TYPES: readonly MaterialParameter['type'][] = ['float', 'vec2', 'vec3', 'vec4', 'color', 'texture'];

export function MaterialDocument(p: MaterialDocumentProps): JSX.Element {
  const m = p.materials.find((x) => x.materialId === p.materialId) ?? null;
  const kind = p.kinds['material'];
  const portContext = useMemo(() => materialPortContext(m?.parameters, p.graphs, p.kinds), [m?.parameters, p.graphs, p.kinds]);
  // Phase 18.2: what the compiler says about this graph (missing textures, functions, parameters; pixel-only inputs in a vertex offset).
  const textureKey = p.textures.map((t) => t.assetId).join(',');
  const textureIds = useMemo(() => new Set(textureKey === '' ? [] : textureKey.split(',')), [textureKey]);
  const compileProblems = useMemo(
    () => (m?.graph !== undefined ? materialGraphProblems({ graph: m.graph, ...(m.parameters !== undefined ? { parameters: m.parameters } : {}) }, p.graphs as unknown as MaterialFunctionLike[], textureIds) : []),
    [m?.graph, m?.parameters, p.graphs, textureIds],
  );
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
        The preview, the Scene view, Play and exports draw this graph (compiled to a node material); the {m.shader} shader part is used only after Remove graph.
      </p>
      {p.error !== null && (
        <p className="tl-error" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-animator-doc__main">
        <div className="tl-animator-doc__side">
          <PreviewPane materialId={m.materialId} materials={p.materials} graphs={p.graphs} environment={p.environment} models={p.models} loadTexture={p.loadTexture} loadModel={p.loadModel} />
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
            extraProblems={compileProblems}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Phase 18.2: the live preview — the material on a sphere, a plane, a cube
 * or a model of the project, in the project environment; drag to orbit.
 */
function PreviewPane(p: Pick<MaterialDocumentProps, 'materials' | 'graphs' | 'environment' | 'models' | 'loadTexture' | 'loadModel'> & { materialId: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<MaterialPreview | null>(null);
  const [shape, setShape] = useState<PreviewShape>('sphere');
  const [modelId, setModelId] = useState('');
  const [status, setStatus] = useState('starting…');
  const latest = useRef(p);
  latest.current = p;
  // The models list is rebuilt on every host render: its ids are the dependency.
  const modelsKey = p.models.map((x) => x.assetId).join(',');
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const preview = new MaterialPreview(canvas, { loadTexture: (id) => latest.current.loadTexture(id) });
    previewRef.current = preview;
    const timer = window.setInterval(() => {
      const info = preview.info();
      const probs = preview.problems();
      const errors = (probs ?? []).filter((x) => x.severity === 'error').length;
      setStatus(info.state !== 'ready' ? `${info.state}…` : `${info.backend}${errors > 0 ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}`);
      canvas.dataset['tlPreviewFrames'] = String(preview.frameCount());
      canvas.dataset['tlRenderer'] = info.backend ?? '';
    }, 250);
    return () => {
      window.clearInterval(timer);
      preview.dispose();
      previewRef.current = null;
    };
  }, []);
  useEffect(() => {
    previewRef.current?.setMaterial(p.materials as unknown as MaterialDefLike[], p.graphs.filter((g) => g.kind === 'material-function') as unknown as MaterialFunctionLike[], p.materialId);
  }, [p.materials, p.graphs, p.materialId]);
  useEffect(() => {
    previewRef.current?.setEnvironment(p.environment);
  }, [p.environment]);
  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return undefined;
    if (shape !== 'model') {
      preview.setShape(shape);
      return undefined;
    }
    const id = modelId !== '' ? modelId : (latest.current.models[0]?.assetId ?? '');
    if (id === '') {
      preview.setShape('sphere');
      return undefined;
    }
    let live = true;
    let loaded: { root: THREE.Object3D; dispose: () => void } | null = null;
    void latest.current.loadModel(id).then((m) => {
      if (!live) {
        m?.dispose();
        return;
      }
      loaded = m;
      preview.setShape(m !== null ? 'model' : 'sphere', m?.root ?? null);
    });
    return () => {
      live = false;
      if (loaded !== null) {
        preview.setShape('sphere');
        loaded.dispose();
      }
    };
  }, [shape, modelId, modelsKey]);
  return (
    <div className="tl-material-preview" aria-label="material preview">
      <div className="tl-subhead">
        Preview
        <select className="tl-input" aria-label="preview shape" value={shape} onChange={(e) => setShape(e.target.value as PreviewShape)}>
          <option value="sphere">sphere</option>
          <option value="plane">plane</option>
          <option value="cube">cube</option>
          <option value="model" disabled={p.models.length === 0}>
            model
          </option>
        </select>
      </div>
      {shape === 'model' && p.models.length > 0 && (
        <select className="tl-input" aria-label="preview model" value={modelId !== '' ? modelId : p.models[0]!.assetId} onChange={(e) => setModelId(e.target.value)}>
          {p.models.map((x) => (
            <option key={x.assetId} value={x.assetId}>
              {x.displayName}
            </option>
          ))}
        </select>
      )}
      <canvas ref={canvasRef} className="tl-material-preview__canvas" aria-label="material preview canvas" />
      <span className="tl-hint tl-material-preview__status" role="status">
        {status}
        {p.environment === null ? ' · neutral backdrop (no project environment)' : ' · project environment'}
      </span>
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
