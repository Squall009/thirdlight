/**
 * A layered material's per-layer settings (the height-blended layers
 * template's tiling in metres, normal strength, height contrast and offset,
 * projection), edited two ways from one set of rules (`layer-palette.ts`):
 *
 * - `LayerSettings`: the material document's table — one row per setting,
 *   one column per layer. Layers 1-4 are the components of the setting's
 *   vec4 parameter; a terrain draws any number of layers, and the columns
 *   past the fourth ("add layer") are the parameter's `extraLayers` (a layer
 *   without its own column takes column L % 4's values). Shown when the
 *   material has any of the settings as a vec4 parameter.
 * - `LayerFields`: one layer's settings and its palette name, as the layer
 *   palette's popover shows them in the edit modes.
 *
 * A change is one `setMaterial` (objects and instances override the first
 * four like any public parameter).
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { MaterialDef, MaterialParameter } from '@thirdlight/project-model';
import { MATERIAL_LAYER_NAME_MAX } from '@thirdlight/project-model/limits';
import { MATERIAL_EXTRA_LAYERS_MAX } from '@thirdlight/runtime';

import { layerSetting, layerSettingValue, withLayerName, withLayerSetting } from '../../session/layer-palette';
import { BIPLANAR_DISTANCE, BIPLANAR_EXTRA_READS, LAYER_SETTINGS, TEMPLATE_LAYERS, TEMPLATE_READS } from '../../session/material-graph';
import { useSettledEdits } from '../brush/settle';
import { SliderField } from '../brush/SliderField';
import { Segmented } from '../editmode/controls';

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
                  {'options' in setting ? (
                    <select aria-label={`layer ${i + 1} ${setting.label}`} title={setting.title} value={layerValue(param, i, setting.fill)} onChange={(e) => set(setting.key, i, Number(e.target.value))}>
                      {setting.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <LayerCell label={`layer ${i + 1} ${setting.label}`} title={setting.title} value={layerValue(param, i, setting.fill)} min={setting.min} onCommit={(v) => set(setting.key, i, v)} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ReadCost material={material} columns={columns} />
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

/** The texture reads a pixel costs: the template's, and what its biplanar layers add near the camera. */
function ReadCost({ material, columns }: { material: MaterialDef; columns: number }): JSX.Element | null {
  const projection = material.parameters?.find((p) => p.key === 'layerProjection' && p.type === 'vec4' && Array.isArray(p.default));
  if (projection === undefined) return null;
  const biplanar = Array.from({ length: columns }, (_, i) => layerValue(projection, i, 0)).filter((v) => v === 2).length;
  const near = material.parameters?.find((p) => p.key === 'biplanarDistance')?.default;
  const metres = typeof near === 'number' ? near : BIPLANAR_DISTANCE;
  return (
    <p className="tl-inspector__hint" aria-label="texture reads">
      {biplanar === 0
        ? `Texture reads a pixel: ${TEMPLATE_READS}.`
        : `Texture reads a pixel: ${TEMPLATE_READS}; where a biplanar layer shows both planes within ${metres} m, ${BIPLANAR_EXTRA_READS} more for it (${biplanar} biplanar layer${biplanar === 1 ? '' : 's'}: up to ${TEMPLATE_READS + BIPLANAR_EXTRA_READS * Math.min(biplanar, TEMPLATE_LAYERS)}).`}
    </p>
  );
}

/** A per-layer parameter's value for a layer (past its own columns: column L % 4's). */
const layerValue = layerSettingValue;

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

/** How each setting's slider runs in the popover (its own units; typing may go past the track to the setting's limits). */
const FIELD_RANGES: Readonly<Record<(typeof LAYER_SETTINGS)[number]['key'], { min: number; max: number; step: number; unit?: string; log?: boolean; limit?: [number, number] }>> = {
  layerTiling: { min: 0.25, max: 64, step: 0.05, unit: 'm', log: true, limit: [LAYER_SETTINGS[0].min, 10_000] },
  layerNormalStrength: { min: 0, max: 2, step: 0.05, limit: [-10, 10] },
  layerContrast: { min: 0, max: 4, step: 0.05, limit: [-100, 100] },
  layerOffset: { min: -1, max: 1, step: 0.01, limit: [-100, 100] },
  layerProjection: { min: 0, max: 2, step: 1 },
};

/**
 * One layer's settings and palette name. Values show at once and are stored
 * as one `setMaterial` once the control rests (`useSettledEdits`).
 */
export function LayerFields({ material, layer, textureName, onSave }: { material: MaterialDef; layer: number; textureName: string | null; onSave: (m: MaterialDef) => void }): JSX.Element {
  const edits = useSettledEdits(material, (m) => onSave(m));
  const shownMaterial = edits.value;
  // The name as typed, stored when the field is left.
  const [typed, setTyped] = useState<string | null>(null);
  const set = (key: Setting['key'], value: number, now = false): void => edits.edit(key, key, (m) => withLayerSetting(m, key, layer, value), now);
  const name = typed ?? shownMaterial.layerNames?.[layer] ?? '';
  return (
    <div className="tl-layer-fields" role="group" aria-label={`layer ${layer + 1} settings`}>
      <label className="tl-slider tl-slider--text" title="The layer's name in the palette (empty: its texture's name).">
        <span className="tl-slider__label">Name</span>
        <input
          className="tl-input"
          aria-label={`layer ${layer + 1} name`}
          maxLength={MATERIAL_LAYER_NAME_MAX}
          placeholder={textureName ?? `Layer ${layer + 1}`}
          value={name}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={(e) => {
            const v = e.target.value.trim();
            setTyped(null);
            if (v !== (shownMaterial.layerNames?.[layer] ?? '')) edits.edit('name', 'name', (m) => withLayerName(m, layer, v), true);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </label>
      {LAYER_SETTINGS.map((s) => {
        const shown = layerSetting(shownMaterial, s.key, layer);
        if (shown === null) return null;
        const value = Number(shown);
        if ('options' in s) {
          return (
            <div key={s.key} className="tl-slider" title={s.title}>
              <span className="tl-slider__label">Projection</span>
              <Segmented small aria={`layer ${layer + 1} projection`} value={value} options={s.options.map((o) => ({ id: o.value, label: o.label }))} onChange={(v) => set(s.key, v, true)} />
            </div>
          );
        }
        const r = FIELD_RANGES[s.key];
        const label = s.label.replace(/ \(m\)$/, '');
        return <SliderField key={s.key} label={label.charAt(0).toUpperCase() + label.slice(1)} aria={`layer ${layer + 1} ${s.label}`} value={value} min={r.min} max={r.max} step={r.step} {...(r.unit !== undefined ? { unit: r.unit } : {})} {...(r.log === true ? { log: true } : {})} {...(r.limit !== undefined ? { limit: r.limit } : {})} hint={s.title} onChange={(v) => set(s.key, v)} />;
      })}
    </div>
  );
}
