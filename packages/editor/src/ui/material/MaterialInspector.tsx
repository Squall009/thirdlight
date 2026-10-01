/**
 * A material in the Inspector (chosen in the project window): a shader
 * material's values, built from the shader-type table (project-model
 * `MATERIAL_PARAMS` / `MATERIAL_TEXTURE_SLOTS`) — a parameter that is not set
 * keeps the file's value (on a model) or the shader default; "reset" removes
 * the override — "Convert to graph" (a standard or unlit material as an
 * equivalent graph, opened in the editor window), a graph material's summary
 * with "Open graph", and a material instance's parent and changed values
 * (its parent's look with some values changed; an instance is a material
 * like any other: object, model-asset and block-type mappings may name it).
 * "+ new instance" makes an instance of the material shown. Every edit is one
 * `setMaterial` (committed when the control is released), so each is one
 * undo.
 *
 * Also the reusable material mapping editor (object and model inspectors):
 * each of a model's materials, or "*" for all of them, can use a project
 * material.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type DragEvent, type JSX } from 'react';
import type { MaterialDef, MaterialParameterValue, MaterialParamType, MaterialParamValue, MaterialShader } from '@thirdlight/project-model';
import { ParameterValue } from './MaterialDocument';
import { MATERIAL_PARAMS, MATERIAL_SHADERS, MATERIAL_TEXTURE_SLOTS } from '../../session/material-schema';
import { resolveMaterialInstancesLike, type MaterialDefLike } from '@thirdlight/three-adapter';

import { ASSET_DRAG_TYPE, parseAssetDrag } from '../../session/placement';
import { CONVERTIBLE_SHADERS, convertToGraph } from '../../session/material-graph';
import { RefPicker, TEXTURE_KINDS, useEntryName } from '../catalog/RefPicker';
import { OpenItemButton } from '../catalog/item-opener';

/** The DataTransfer type a dragged material carries (dropped onto an object in the Scene view). */
export const MATERIAL_DRAG_TYPE = 'application/x-thirdlight-material';

interface Props {
  onSave: (material: MaterialDef) => void;
  onDelete: (materialId: string) => void;
  /** Open a graph material in the editor window. */
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

/** Every material as it draws (instances resolved against their parents). */
function resolvedMaterials(list: readonly MaterialDef[]): MaterialDef[] {
  return resolveMaterialInstancesLike(list as unknown as MaterialDefLike[]) as unknown as MaterialDef[];
}

/** `id` and every instance below it (a parent may not be one of them: that would loop). */
function selfAndDescendants(list: readonly MaterialDef[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of list) if (m.instanceOf !== undefined && out.has(m.instanceOf) && !out.has(m.materialId)) (out.add(m.materialId), (grew = true));
  }
  return out;
}

/**
 * A material chosen in the project window, in the Inspector: a shader
 * material's or an instance's values, a graph material's summary with "Open
 * graph"; "New instance" makes an instance of it and shows that.
 */
export function MaterialItemInspector(p: { materialId: string; materials: readonly MaterialDef[]; onSave: Props['onSave']; onDelete: Props['onDelete']; onOpen: Props['onOpen']; onShow: (materialId: string) => void }): JSX.Element {
  const selected = p.materials.find((m) => m.materialId === p.materialId) ?? null;
  if (selected === null) return <p className="tl-inspector__hint">Reading the material…</p>;
  const resolved = resolvedMaterials(p.materials);
  const createInstance = (): void => {
    const name = `${selected.name} instance`.slice(0, 128);
    const def: MaterialDef = { materialId: newMaterialId(p.materials, name), name, shader: (resolved.find((r) => r.materialId === selected.materialId) ?? selected).shader, params: {}, textures: {}, instanceOf: selected.materialId };
    p.onSave(def);
    p.onShow(def.materialId);
  };
  return (
    <div className="tl-material-item" data-material-id={selected.materialId}>
      {selected.instanceOf !== undefined ? (
        <InstanceInspector key={selected.materialId} instance={selected} materials={p.materials} onSave={p.onSave} onDelete={p.onDelete} />
      ) : selected.graph !== undefined ? (
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
        <MaterialInspector key={selected.materialId} material={selected} onSave={p.onSave} onDelete={p.onDelete} onOpen={p.onOpen} />
      )}
      <button className="tl-btn tl-btn--small" onClick={createInstance} title="A material instance of this material: its look, with the values you change in it">
        + new instance
      </button>
    </div>
  );
}

function MaterialInspector(props: { material: MaterialDef; onSave: Props['onSave']; onDelete: Props['onDelete']; onOpen: Props['onOpen'] }): JSX.Element {
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
            if (payload !== null && payload.kind === 'texture') {
              ev.preventDefault();
              setTexture(slot, payload.assetId);
            }
          }}
        >
          <span className="tl-field__label">{SLOT_LABEL[slot] ?? slot}</span>
          <RefPicker aria={`texture ${slot}`} kinds={TEXTURE_KINDS} value={m.textures[slot] ?? ''} none="— none —" onPick={(id) => setTexture(slot, id === '' ? null : id)} />
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

/**
 * A material instance — its parent, and the values it changes:
 * a graph material's parameters, or a shader material's parameters and
 * texture slots. Unset = the parent's value (shown); "↺" goes back to it.
 */
/** An instance's texture slot: its own texture, or empty for the parent's (named in the empty choice). */
function InheritedTexture(p: { aria: string; value: string; inherited: string | undefined; onPick: (id: string) => void }): JSX.Element {
  const parent = useEntryName(p.inherited ?? null, TEXTURE_KINDS);
  const named = p.inherited === undefined ? '' : ` (${parent !== null && parent !== undefined ? parent.name : p.inherited})`;
  return <RefPicker aria={p.aria} kinds={TEXTURE_KINDS} value={p.value} none={`— the parent's${named} —`} onPick={p.onPick} />;
}

function InstanceInspector(props: { instance: MaterialDef; materials: readonly MaterialDef[]; onSave: Props['onSave']; onDelete: Props['onDelete'] }): JSX.Element {
  const m = props.instance;
  const [name, setName] = useState(m.name);
  useEffect(() => setName(m.name), [m.name]);
  const resolved = resolvedMaterials(props.materials);
  const parent = resolved.find((x) => x.materialId === m.instanceOf) ?? null;
  const excluded = selfAndDescendants(props.materials, m.materialId);
  const save = (patch: Partial<MaterialDef>): void => {
    const next: MaterialDef = { ...m, ...patch };
    if (next.values !== undefined && Object.keys(next.values).length === 0) delete next.values;
    props.onSave(next);
  };
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
  const setValue = (key: string, value: MaterialParameterValue | undefined): void => {
    const values = { ...(m.values ?? {}) };
    if (value === undefined) delete values[key];
    else values[key] = value;
    save({ values });
  };
  const reparent = (parentId: string): void => {
    const np = resolved.find((x) => x.materialId === parentId);
    if (np === undefined) return;
    // Keep only what the new parent's look has.
    const params = Object.fromEntries(Object.entries(m.params).filter(([k]) => MATERIAL_PARAMS[np.shader][k] !== undefined));
    const textures = Object.fromEntries(Object.entries(m.textures).filter(([k]) => MATERIAL_TEXTURE_SLOTS[np.shader].includes(k)));
    const values = Object.fromEntries(Object.entries(m.values ?? {}).filter(([k]) => (np.parameters ?? []).some((x) => x.key === k)));
    save({ instanceOf: parentId, shader: np.shader, params, textures, values: np.graph !== undefined ? values : {} });
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
        <span className="tl-field__label">instance of</span>
        <select className="tl-input" aria-label="instance parent" value={m.instanceOf ?? ''} onChange={(e) => reparent(e.target.value)}>
          {props.materials
            .filter((x) => !excluded.has(x.materialId))
            .map((x) => (
              <option key={x.materialId} value={x.materialId}>
                {x.name}
              </option>
            ))}
        </select>
      </label>
      {parent === null ? (
        <p className="tl-inspector__hint">The parent material is missing.</p>
      ) : parent.graph !== undefined ? (
        <>
          <div className="tl-subhead">Parameters (unset = the parent's value)</div>
          {(parent.parameters ?? []).length === 0 && <p className="tl-inspector__hint">The parent graph material exposes no parameters.</p>}
          {(parent.parameters ?? []).map((x) => {
            const own = m.values?.[x.key];
            return (
              <div key={x.key} className={own !== undefined ? 'tl-param is-set' : 'tl-param'} data-param={x.key}>
                <span className="tl-field__label" title={x.tooltip}>{x.label ?? x.key}</span>
                <ParameterValue key={JSON.stringify(own ?? x.default)} param={{ ...x, default: own ?? x.default }} label={`instance ${x.key}`} onCommit={(v) => setValue(x.key, v)} />
                <button className="tl-btn tl-btn--small tl-param__reset" disabled={own === undefined} aria-label={`reset ${x.key}`} title="Use the parent's value" onClick={() => setValue(x.key, undefined)}>
                  ↺
                </button>
              </div>
            );
          })}
        </>
      ) : (
        <>
          <div className="tl-subhead">Parameters (unset = the parent's value)</div>
          {Object.entries(MATERIAL_PARAMS[parent.shader]).map(([key, type]) => {
            const inherited = parent.params[key];
            const shownType = (inherited !== undefined ? { ...type, default: inherited } : type) as MaterialParamType;
            return <ParamRow key={key} name={key} type={shownType} value={m.params[key]} onCommit={(v) => setParam(key, v)} />;
          })}
          <div className="tl-subhead">Textures (empty = the parent's)</div>
          {MATERIAL_TEXTURE_SLOTS[parent.shader].map((slot) => (
            <label key={slot} className="tl-field">
              <span className="tl-field__label">{SLOT_LABEL[slot] ?? slot}</span>
              <InheritedTexture aria={`texture ${slot}`} value={m.textures[slot] ?? ''} inherited={parent.textures[slot]} onPick={(id) => setTexture(slot, id === '' ? null : id)} />
            </label>
          ))}
        </>
      )}
      <button className="tl-btn tl-btn--small tl-btn--danger" onClick={() => props.onDelete(m.materialId)} title="Delete (refused while an object, an asset or another instance uses it)">
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
   * The object's overrides of its graph materials' public
   * parameters (the `materialParams` component) — shown for the graph
   * materials the mapping (or `inherited`, the model asset's default
   * mapping) uses; absent = no override section (e.g. an asset's defaults).
   */
  overrides?: { value: Readonly<Record<string, Readonly<Record<string, MaterialParameterValue>>>> | null; inherited: Readonly<Record<string, string>> | null; onChange: (next: Record<string, Record<string, MaterialParameterValue>> | null) => void };
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
          <OpenItemButton kind="material" id={current[slot] ?? ''} aria={`material for ${slot === '*' ? 'all' : slot}`} />
        </label>
      ))}
      {props.overrides !== undefined && <ParameterOverrides mapping={current} materials={props.materials} {...props.overrides} />}
    </div>
  );
}

/** Per-object values for the public parameters of the graph materials an object uses. */
function ParameterOverrides(p: { mapping: Readonly<Record<string, string>>; materials: readonly MaterialDef[]; value: Readonly<Record<string, Readonly<Record<string, MaterialParameterValue>>>> | null; inherited: Readonly<Record<string, string>> | null; onChange: (next: Record<string, Record<string, MaterialParameterValue>> | null) => void }): JSX.Element | null {
  const used = [...new Set([...Object.values(p.inherited ?? {}), ...Object.values(p.mapping)])];
  // A data parameter's cells are written by scripts at run time, never overridden per object here.
  const overridable = (x: { visibility?: string; type: string }): boolean => x.visibility !== 'private' && x.type !== 'data';
  // An instance's parameters are its root graph material's (with the instance's values).
  const resolved = resolvedMaterials(p.materials);
  const graphs = used.map((id) => resolved.find((m) => m.materialId === id)).filter((m): m is MaterialDef => m !== undefined && m.graph !== undefined && (m.parameters ?? []).some(overridable));
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
            .filter(overridable)
            .map((x) => {
              const over = p.value?.[m.materialId]?.[x.key];
              return (
                <div key={x.key} className={over !== undefined ? 'tl-param is-set' : 'tl-param'} data-param={x.key}>
                  <span className="tl-field__label" title={x.tooltip}>{x.label ?? x.key}</span>
                  <ParameterValue key={JSON.stringify(over ?? x.default)} param={{ ...x, default: over ?? x.default }} label={`${m.name} ${x.key}`} onCommit={(v) => set(m.materialId, x.key, v)} />
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
