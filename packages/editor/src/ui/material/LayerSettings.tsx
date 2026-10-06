/**
 * The layer table of a layered material (the height-blended layers
 * template): one row per per-layer setting (tiling in metres, normal
 * strength, height contrast and offset), one column per layer. Each cell is
 * one component of the setting's vec4 parameter; a change is one
 * `setMaterial` of that parameter's default. Shown when the material has any
 * of the settings as a vec4 parameter (objects and instances override them
 * like any public parameter).
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { MaterialDef, MaterialParameter } from '@thirdlight/project-model';

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
      if (Array.isArray(p?.default) && p.default[e.layer] === e.value) pending.current.delete(id);
    }
  }, [material.parameters]);
  const rows = layerParams(material);
  if (rows.length === 0) return null;
  const set = (key: string, layer: number, value: number): void => {
    pending.current.set(`${key}:${layer}`, { key, layer, value });
    const parameters = (material.parameters ?? []).map((x) => {
      const edits = [...pending.current.values()].filter((e) => e.key === x.key);
      if (edits.length === 0 || !Array.isArray(x.default)) return x;
      const next = [...(x.default as number[])];
      for (const e of edits) next[e.layer] = e.value;
      return { ...x, default: next };
    });
    onSave({ ...material, parameters });
  };
  const layers = Array.from({ length: TEMPLATE_LAYERS }, (_, i) => i);
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
                  <LayerCell label={`layer ${i + 1} ${setting.label}`} title={setting.title} value={(param.default as number[])[i] ?? setting.fill} min={setting.min} onCommit={(v) => set(setting.key, i, v)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
