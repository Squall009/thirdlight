/**
 * Phase 9.4: the Materials tab — project materials as tiles plus a material
 * inspector built from the shader-type table (project-model
 * `MATERIAL_PARAMS` / `MATERIAL_TEXTURE_SLOTS`). A parameter that is not set
 * keeps the file's value (on a model) or the shader default; "reset" removes
 * the override. Every edit is one `setMaterial` (committed when the control is
 * released), so each is one undo.
 *
 * Also the reusable material mapping editor (object inspector and asset
 * panel): each of a model's materials, or "*" for all of them, can use a
 * project material.
 *
 * Phase 18.0: graph materials — "+ new graph material" (a PBR output graph),
 * "Convert to graph" (a standard or unlit material as an equivalent graph),
 * and a graph material opens as a "Material: <name>" centre tab (double-click
 * its tile or "Open graph").
 *
 * Browser-only (React).
 */
import { useEffect, useState, type DragEvent, type JSX } from 'react';
import type { MaterialDef, MaterialParameterValue, MaterialParamType, MaterialParamValue, MaterialShader } from '@thirdlight/project-model';
import { ParameterValue } from './material/MaterialDocument';
import { MATERIAL_PARAMS, MATERIAL_SHADERS, MATERIAL_TEXTURE_SLOTS } from '../session/material-schema';

import { ASSET_DRAG_TYPE, parseAssetDrag } from '../session/placement';
import { CONVERTIBLE_SHADERS, convertToGraph, newMaterialGraph, templateMaterial } from '../session/material-graph';

/** The DataTransfer type a material tile drags (onto an object in the Scene view). */
export const MATERIAL_DRAG_TYPE = 'application/x-thirdlight-material';

interface TextureOption {
  assetId: string;
  displayName: string;
}

interface Props {
  materials: readonly MaterialDef[];
  textures: readonly TextureOption[];
  selectedId: string | null;
  onSelect: (materialId: string | null) => void;
  onSave: (material: MaterialDef) => void;
  onDelete: (materialId: string) => void;
  error: string | null;
  /** Phase 18.0: open a graph material's tab. */
  onOpen: (materialId: string) => void;
}

const SLOT_LABEL: Record<string, string> = {
  map: 'albedo',
  normalMap: 'normal',
  ormMap: 'ORM (AO/rough/metal)',
  emissiveMap: 'emissive',
  macroNormalMap: 'macro normal (UV1)',
};

function newMaterialId(existing: readonly MaterialDef[], name: string): string {
  const base = `mat-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'material'}`;
  let id = base;
  for (let n = 2; existing.some((m) => m.materialId === id); n += 1) id = `${base}-${n}`;
  return id;
}

function swatch(m: MaterialDef): string {
  const c = m.params['color'];
  return typeof c === 'string' ? c : m.shader === 'water' ? '#1d5f8a' : '#c8c8c8';
}

/** Phase 18.2: what "+ new graph material" starts from — an empty PBR output or a shader type's built-in template. */
const GRAPH_TEMPLATES: readonly { value: string; label: string }[] = [
  { value: '', label: 'empty (PBR output)' },
  { value: 'standard', label: 'template: standard' },
  { value: 'foliage', label: 'template: foliage wind' },
  { value: 'kit', label: 'template: world-aligned kit' },
  { value: 'unlit', label: 'template: unlit' },
  { value: 'water', label: 'template: water' },
];

export function MaterialsPanel(p: Props): JSX.Element {
  const selected = p.materials.find((m) => m.materialId === p.selectedId) ?? null;
  const [template, setTemplate] = useState('');
  const create = (): void => {
    const name = `Material ${p.materials.length + 1}`;
    const def: MaterialDef = { materialId: newMaterialId(p.materials, name), name, shader: 'standard', params: {}, textures: {} };
    p.onSave(def);
    p.onSelect(def.materialId);
  };
  const createGraph = (): void => {
    const name = `Graph material ${p.materials.filter((m) => m.graph !== undefined).length + 1}`;
    const materialId = newMaterialId(p.materials, name);
    const def: MaterialDef = template === '' ? { materialId, name, shader: 'standard', params: {}, textures: {}, graph: newMaterialGraph() } : templateMaterial(template, materialId, name);
    p.onSave(def);
    p.onSelect(def.materialId);
    p.onOpen(def.materialId);
  };
  return (
    <div className="tl-panel tl-materials">
      <div className="tl-panel__title">
        Materials
        <button className="tl-btn tl-btn--small" onClick={create} title="A new standard material (then pick a shader type)">
          + new material
        </button>
        <button className="tl-btn tl-btn--small" onClick={createGraph} title="A new material built as a node graph (opens its tab)">
          + new graph material
        </button>
        <select className="tl-input tl-input--small" aria-label="graph material template" value={template} onChange={(e) => setTemplate(e.target.value)} title="What a new graph material starts from: an empty PBR output, or a shader type as a graph (the same look)">
          {GRAPH_TEMPLATES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="tl-assets__body">
        <div className="tl-assets__main">
          <ul className="tl-tiles" aria-label="materials">
            {p.materials.map((m) => (
              <li
                key={m.materialId}
                className={m.materialId === p.selectedId ? 'tl-tile is-selected' : 'tl-tile'}
                data-material-id={m.materialId}
                title={`${m.name} (${m.shader}) — drag onto an object in the Scene view`}
                onClick={() => p.onSelect(m.materialId)}
                onDoubleClick={() => m.graph !== undefined && p.onOpen(m.materialId)}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(MATERIAL_DRAG_TYPE, m.materialId);
                  ev.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <span className="tl-tile__icon" aria-hidden="true">
                  <span className="tl-material-swatch" style={{ background: swatch(m) }} />
                </span>
                <span className="tl-tile__name">{m.name}</span>
                <span className="tl-tile__meta">{m.graph !== undefined ? 'graph' : m.shader}</span>
              </li>
            ))}
            {p.materials.length === 0 && <li className="tl-row tl-row--empty">no materials yet</li>}
          </ul>
          {p.error !== null && <div className="tl-assets__error" role="alert">{p.error}</div>}
        </div>
        <div className="tl-assets__side">
          {selected !== null ? (
            selected.graph !== undefined ? (
              <div className="tl-material-inspector" aria-label={`material ${selected.name}`}>
                <p className="tl-hint">
                  “{selected.name}” is a graph material ({selected.graph.nodes.length} node{selected.graph.nodes.length === 1 ? '' : 's'}, {(selected.parameters ?? []).length} exposed parameter{(selected.parameters ?? []).length === 1 ? '' : 's'}).
                </p>
                <button className="tl-btn tl-btn--small" onClick={() => p.onOpen(selected.materialId)}>
                  Open graph
                </button>
                <button className="tl-btn tl-btn--small tl-btn--danger" onClick={() => p.onDelete(selected.materialId)} title="Delete (refused while an object or an asset uses it)">
                  delete material
                </button>
              </div>
            ) : (
              <MaterialInspector key={selected.materialId} material={selected} textures={p.textures} onSave={p.onSave} onDelete={p.onDelete} onOpen={p.onOpen} />
            )
          ) : (
            <p className="tl-inspector__hint">Select a material to edit it.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MaterialInspector(props: { material: MaterialDef; textures: readonly TextureOption[]; onSave: Props['onSave']; onDelete: Props['onDelete']; onOpen: Props['onOpen'] }): JSX.Element {
  const m = props.material;
  const schema = MATERIAL_PARAMS[m.shader];
  const slots = MATERIAL_TEXTURE_SLOTS[m.shader];
  const [name, setName] = useState(m.name);
  useEffect(() => setName(m.name), [m.name]);
  const save = (patch: Partial<MaterialDef>): void => props.onSave({ ...m, ...patch });
  const setParam = (key: string, value: MaterialParamValue | undefined): void => {
    const params = { ...m.params };
    if (value === undefined) delete params[key];
    else params[key] = value;
    save({ params });
  };
  const setTexture = (slot: string, assetId: string | null): void => {
    const textures = { ...m.textures };
    if (assetId === null) delete textures[slot];
    else textures[slot] = assetId;
    save({ textures });
  };
  return (
    <div className="tl-material-inspector" aria-label={`material ${m.name}`}>
      <label className="tl-field">
        <span className="tl-field__label">name</span>
        <input
          className="tl-input"
          aria-label="material name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() !== '' && name !== m.name && save({ name: name.trim().slice(0, 128) })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <label className="tl-field">
        <span className="tl-field__label">shader</span>
        <select
          className="tl-input"
          aria-label="shader"
          value={m.shader}
          onChange={(e) => {
            // Keep only the parameters and slots the new shader type has.
            const shader = e.target.value as MaterialShader;
            const params = Object.fromEntries(Object.entries(m.params).filter(([k]) => MATERIAL_PARAMS[shader][k] !== undefined));
            const textures = Object.fromEntries(Object.entries(m.textures).filter(([k]) => MATERIAL_TEXTURE_SLOTS[shader].includes(k)));
            save({ shader, params, textures });
          }}
        >
          {MATERIAL_SHADERS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="tl-subhead">Parameters (unset = the file's value or the default)</div>
      {Object.entries(schema).map(([key, type]) => (
        <ParamRow key={key} name={key} type={type} value={m.params[key]} onCommit={(v) => setParam(key, v)} />
      ))}
      <div className="tl-subhead">Textures (empty = the file's own)</div>
      {slots.map((slot) => (
        <label
          key={slot}
          className="tl-field"
          onDragOver={(ev) => {
            if (ev.dataTransfer.types.includes(ASSET_DRAG_TYPE)) ev.preventDefault();
          }}
          onDrop={(ev: DragEvent) => {
            const payload = parseAssetDrag(ev.dataTransfer.getData(ASSET_DRAG_TYPE));
            if (payload !== null && props.textures.some((t) => t.assetId === payload.assetId)) {
              ev.preventDefault();
              setTexture(slot, payload.assetId);
            }
          }}
        >
          <span className="tl-field__label">{SLOT_LABEL[slot] ?? slot}</span>
          <select className="tl-input" aria-label={`texture ${slot}`} value={m.textures[slot] ?? ''} onChange={(e) => setTexture(slot, e.target.value === '' ? null : e.target.value)}>
            <option value="">— none —</option>
            {props.textures.map((t) => (
              <option key={t.assetId} value={t.assetId}>
                {t.displayName}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button
        className="tl-btn tl-btn--small"
        disabled={!CONVERTIBLE_SHADERS.includes(m.shader)}
        title="Rebuild this material as a node graph that looks the same (its values, textures and — for wind, kit and water — public parameters; one undo)"
        onClick={() => {
          const r = convertToGraph(m);
          if (r.ok) {
            props.onSave(r.material);
            props.onOpen(m.materialId);
          }
        }}
      >
        Convert to graph
      </button>
      <button className="tl-btn tl-btn--small tl-btn--danger" onClick={() => props.onDelete(m.materialId)} title="Delete (refused while an object or an asset uses it)">
        delete material
      </button>
    </div>
  );
}

/** One parameter: its control, committed on release; "↺" removes the override. */
function ParamRow(props: { name: string; type: MaterialParamType; value: MaterialParamValue | undefined; onCommit: (v: MaterialParamValue | undefined) => void }): JSX.Element {
  const { name, type, value } = props;
  const set = value !== undefined;
  const shown = value ?? (type.default as MaterialParamValue);
  const [draft, setDraft] = useState<MaterialParamValue>(shown);
  useEffect(() => setDraft(value ?? (type.default as MaterialParamValue)), [value, type.default]);
  const commit = (v: MaterialParamValue): void => {
    if (JSON.stringify(v) !== JSON.stringify(value)) props.onCommit(v);
  };
  let control: JSX.Element;
  switch (type.kind) {
    case 'number': {
      const step = type.max - type.min > 50 ? 0.1 : 0.01;
      control = (
        <span className="tl-param__number">
          <input
            type="range"
            aria-label={`${name} slider`}
            min={type.min}
            max={type.max}
            step={step}
            value={Number(draft)}
            onChange={(e) => setDraft(Number(e.target.value))}
            onPointerUp={() => commit(Number(draft))}
            onKeyUp={() => commit(Number(draft))}
          />
          <input
            className="tl-input tl-input--num"
            aria-label={name}
            type="number"
            min={type.min}
            max={type.max}
            step={step}
            value={Number(draft)}
            onChange={(e) => setDraft(Number(e.target.value))}
            onBlur={() => commit(Math.min(type.max, Math.max(type.min, Number(draft))))}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </span>
      );
      break;
    }
    case 'color':
      control = <input type="color" aria-label={name} value={String(draft)} onChange={(e) => setDraft(e.target.value)} onBlur={() => commit(String(draft))} />;
      break;
    case 'bool':
      control = <input type="checkbox" aria-label={name} checked={draft === true} onChange={(e) => commit(e.target.checked)} />;
      break;
    case 'enum':
      control = (
        <select className="tl-input" aria-label={name} value={String(draft)} onChange={(e) => commit(e.target.value)}>
          {type.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
      break;
    case 'vec2': {
      const v = (Array.isArray(draft) ? draft : [0, 0]) as [number, number];
      control = (
        <span className="tl-param__vec2">
          {[0, 1].map((i) => (
            <input
              key={i}
              className="tl-input tl-input--num"
              aria-label={`${name} ${i === 0 ? 'x' : 'y'}`}
              type="number"
              step={0.1}
              value={v[i]}
              onChange={(e) => setDraft(i === 0 ? [Number(e.target.value), v[1]] : [v[0], Number(e.target.value)])}
              onBlur={() => commit(v)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ))}
        </span>
      );
      break;
    }
  }
  return (
    <div className={set ? 'tl-param is-set' : 'tl-param'} data-param={name}>
      <span className="tl-field__label">{name}</span>
      {control}
      <button className="tl-btn tl-btn--small tl-param__reset" disabled={!set} aria-label={`reset ${name}`} title="Keep the file's value / the default" onClick={() => props.onCommit(undefined)}>
        ↺
      </button>
    </div>
  );
}

/**
 * A material mapping editor: "all materials" plus one row per material the
 * file has. Absent entries use the file's own material.
 */
export function MaterialMappingEditor(props: {
  label: string;
  sourceNames: readonly string[];
  mapping: Readonly<Record<string, string>> | null;
  materials: readonly MaterialDef[];
  onChange: (mapping: Record<string, string> | null) => void;
  /**
   * Phase 18.0: the object's overrides of its graph materials' public
   * parameters (the `materialParams` component) — shown for the graph
   * materials the mapping (or `inherited`, the model asset's default
   * mapping) uses; absent = no override section (e.g. an asset's defaults).
   */
  overrides?: { value: Readonly<Record<string, Readonly<Record<string, MaterialParameterValue>>>> | null; inherited: Readonly<Record<string, string>> | null; textures: readonly TextureOption[]; onChange: (next: Record<string, Record<string, MaterialParameterValue>> | null) => void };
}): JSX.Element {
  const rows = ['*', ...props.sourceNames];
  const current = props.mapping ?? {};
  const set = (slot: string, materialId: string): void => {
    const next: Record<string, string> = { ...current };
    if (materialId === '') delete next[slot];
    else next[slot] = materialId;
    props.onChange(Object.keys(next).length > 0 ? next : null);
  };
  return (
    <div className="tl-inspector__section" aria-label={props.label}>
      <div className="tl-panel__title">{props.label}</div>
      {props.materials.length === 0 && <p className="tl-inspector__hint">No project materials yet (bottom dock → Materials).</p>}
      {rows.map((slot) => (
        <label key={slot} className="tl-field">
          <span className="tl-field__label">{slot === '*' ? 'all materials' : slot}</span>
          <select className="tl-input" aria-label={`material for ${slot === '*' ? 'all' : slot}`} value={current[slot] ?? ''} onChange={(e) => set(slot, e.target.value)}>
            <option value="">{slot === '*' ? '— the file’s own —' : '— as above —'}</option>
            {props.materials.map((m) => (
              <option key={m.materialId} value={m.materialId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      ))}
      {props.overrides !== undefined && <ParameterOverrides mapping={current} materials={props.materials} {...props.overrides} />}
    </div>
  );
}

/** Phase 18.0: per-object values for the public parameters of the graph materials an object uses. */
function ParameterOverrides(p: { mapping: Readonly<Record<string, string>>; materials: readonly MaterialDef[]; value: Readonly<Record<string, Readonly<Record<string, MaterialParameterValue>>>> | null; inherited: Readonly<Record<string, string>> | null; textures: readonly TextureOption[]; onChange: (next: Record<string, Record<string, MaterialParameterValue>> | null) => void }): JSX.Element | null {
  const used = [...new Set([...Object.values(p.inherited ?? {}), ...Object.values(p.mapping)])];
  const graphs = used.map((id) => p.materials.find((m) => m.materialId === id)).filter((m): m is MaterialDef => m !== undefined && m.graph !== undefined && (m.parameters ?? []).some((x) => x.visibility !== 'private'));
  if (graphs.length === 0) return null;
  const set = (materialId: string, key: string, v: MaterialParameterValue | undefined): void => {
    const next: Record<string, Record<string, MaterialParameterValue>> = Object.fromEntries(Object.entries(p.value ?? {}).map(([k, o]) => [k, { ...o }]));
    const own = next[materialId] ?? {};
    if (v === undefined) delete own[key];
    else own[key] = v;
    if (Object.keys(own).length > 0) next[materialId] = own;
    else delete next[materialId];
    p.onChange(Object.keys(next).length > 0 ? next : null);
  };
  return (
    <div className="tl-material-overrides" aria-label="material parameter overrides">
      {graphs.map((m) => (
        <div key={m.materialId}>
          <div className="tl-subhead">{m.name}: parameters</div>
          {(m.parameters ?? [])
            .filter((x) => x.visibility !== 'private')
            .map((x) => {
              const over = p.value?.[m.materialId]?.[x.key];
              return (
                <div key={x.key} className={over !== undefined ? 'tl-param is-set' : 'tl-param'} data-param={x.key}>
                  <span className="tl-field__label" title={x.tooltip}>{x.label ?? x.key}</span>
                  <ParameterValue key={JSON.stringify(over ?? x.default)} param={{ ...x, default: over ?? x.default }} textures={p.textures} label={`${m.name} ${x.key}`} onCommit={(v) => set(m.materialId, x.key, v)} />
                  <button className="tl-btn tl-btn--small tl-param__reset" disabled={over === undefined} aria-label={`reset ${m.name} ${x.key}`} title="Use the material's value" onClick={() => set(m.materialId, x.key, undefined)}>
                    ↺
                  </button>
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}
