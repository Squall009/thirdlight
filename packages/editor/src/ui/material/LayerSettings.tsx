/**
 * The layer table of a layered material (the height-blended layers
 * template): one row per per-layer setting (tiling in metres, normal
 * strength, height contrast and offset), one column per layer. Layers 1-4
 * are the components of the setting's vec4 parameter; a terrain draws any
 * number of layers, and the columns past the fourth ("add layer") are the
 * parameter's `extraLayers` (a layer without its own column takes column
 * L % 4's values). A change is one `setMaterial` of the parameter. Shown when
 * the material has any of the settings as a vec4 parameter (objects and
 * instances override the first four like any public parameter).
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { MaterialDef, MaterialParameter } from '@thirdlight/project-model';
import { MATERIAL_EXTRA_LAYERS_MAX } from '@thirdlight/runtime';

import { LAYER_SETTINGS, TEMPLATE_LAYERS } from '../../session/material-graph';

type Setting = (typeof LAYER_SETTINGS)[number];

/** The material's per-layer parameters (vec4), by setting; none: the table is not shown. */
function layerParams(m: MaterialDef): { setting: Setting; param: MaterialParameter }[] {
  const list = m.parameters ?? [];
  return LAYER_SETTINGS.flatMap((setting) => {
    const param = list.find((p) => p.key === setting.key && p.type === 'vec4' && Array.isArray(p.default));
    return param === undefined ? [] : [{ setting, param }];
  });
}

export function LayerSettings({ material, onSave }: { material: MaterialDef; onSave: (m: MaterialDef) => void }): JSX.Element | null {
  // Cells committed here that the project has not shown back yet: a save starts from the material as
  // shown plus these, so cells committed in quick succession all count.
  const pending = useRef(new Map<string, { key: string; layer: number; value: number }>());
  useEffect(() => {
    for (const [id, e] of pending.current) {
      const p = material.parameters?.find((x) => x.key === e.key);
      if (p !== undefined && Array.isArray(p.default) && layerValue(p, e.layer, Number.NaN) === e.value) pending.current.delete(id);
    }
  }, [material.parameters]);
  const rows = layerParams(material);
  if (rows.length === 0) return null;
  /** The parameter with `layers` columns (new ones take column L % 4's values) and the pending cells written in. */
  const withEdits = (x: MaterialParameter, columns: number): MaterialParameter => {
    if (!Array.isArray(x.default) || !rows.some((r) => r.param.key === x.key)) return x;
    const four = [...(x.default as number[])];
    const extra = [...(x.extraLayers ?? [])];
    while (TEMPLATE_LAYERS + extra.length < columns) extra.push(four[(TEMPLATE_LAYERS + extra.length) % TEMPLATE_LAYERS] ?? 0);
    for (const e of pending.current.values()) {
      if (e.key !== x.key) continue;
      if (e.layer < TEMPLATE_LAYERS) four[e.layer] = e.value;
      else if (e.layer - TEMPLATE_LAYERS < extra.length) extra[e.layer - TEMPLATE_LAYERS] = e.value;
    }
    return { ...trimmed(x, 0), default: four, ...(extra.length > 0 ? { extraLayers: extra } : {}) };
  };
  const columns = TEMPLATE_LAYERS + Math.max(0, ...rows.map((r) => r.param.extraLayers?.length ?? 0));
  const save = (count: number): void => onSave({ ...material, parameters: (material.parameters ?? []).map((x) => withEdits(x, count)) });
  const set = (key: string, layer: number, value: number): void => {
    pending.current.set(`${key}:${layer}`, { key, layer, value });
    save(columns);
  };
  const layers = Array.from({ length: columns }, (_, i) => i);
  return (
    <div className="tl-material-layers">
      <div className="tl-subhead">Layers</div>
      <table className="tl-material-layers__table" aria-label="layer settings">
        <thead>
          <tr>
            <th scope="col" />
            {layers.map((i) => (
              <th key={i} scope="col">
                {i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ setting, param }) => (
            <tr key={setting.key}>
              <th scope="row" title={setting.title}>
                {setting.label}
              </th>
              {layers.map((i) => (
                <td key={i}>
                  <LayerCell label={`layer ${i + 1} ${setting.label}`} title={setting.title} value={layerValue(param, i, setting.fill)} min={setting.min} onCommit={(v) => set(setting.key, i, v)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tl-inspector__modes">
        <button className="tl-btn tl-btn--small" aria-label="add layer column" title="Settings of its own for one more texture-array layer (a terrain draws any number of layers; without its own column, layer L takes column L % 4's)" disabled={columns >= TEMPLATE_LAYERS + MATERIAL_EXTRA_LAYERS_MAX} onClick={() => save(columns + 1)}>
          Add layer
        </button>
        {columns > TEMPLATE_LAYERS && (
          <button className="tl-btn tl-btn--small" aria-label="remove layer column" title="Drop the last layer's own settings (it takes column L % 4's again)" onClick={() => onSave({ ...material, parameters: (material.parameters ?? []).map((x) => (rows.some((r) => r.param.key === x.key) && (x.extraLayers?.length ?? 0) >= columns - TEMPLATE_LAYERS ? trimmed(x, columns - TEMPLATE_LAYERS - 1) : x)) })}>
            Remove layer
          </button>
        )}
      </div>
    </div>
  );
}

/** A per-layer parameter's value for a layer (past its own columns: column L % 4's). */
function layerValue(param: MaterialParameter, layer: number, fill: number): number {
  const four = param.default as number[];
  if (layer < TEMPLATE_LAYERS) return four[layer] ?? fill;
  return param.extraLayers?.[layer - TEMPLATE_LAYERS] ?? four[layer % TEMPLATE_LAYERS] ?? fill;
}

/** A per-layer parameter with only its first `count` extra layers. */
function trimmed(x: MaterialParameter, count: number): MaterialParameter {
  const { extraLayers, ...rest } = x;
  const kept = (extraLayers ?? []).slice(0, count);
  return { ...rest, ...(kept.length > 0 ? { extraLayers: kept } : {}) };
}

/** One number, committed on Enter or blur; a value that is not a number (or under `min`) puts the stored one back. */
function LayerCell({ label, title, value, min, onCommit }: { label: string; title: string; value: number; min: number | null; onCommit: (v: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const v = Number(draft.trim());
    if (draft.trim() === '' || !Number.isFinite(v) || (min !== null && v < min)) {
      setDraft(String(value));
      return;
    }
    if (v !== value) onCommit(v);
  };
  return <input className="tl-input tl-input--num" aria-label={label} title={title} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}
