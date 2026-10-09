/**
 * Material rules of a terrain or a block layer (`surface-rules.ts`): a list
 * of rules, each a material layer and the conditions under which it covers
 * the surface — height, slope, cavity, a noise mask, how much of another
 * layer the rules before it left, top or wall faces, and on a block layer
 * its block types. Every condition is a range (min, max, either may be
 * empty) with a fade beyond its ends.
 *
 * Rules are edited as a draft and applied in one step: a terrain bakes them
 * into its tiles (`editTerrain` bake), a block layer stores them on its
 * component (its chunks are painted again in the mesh workers). One undo
 * step either way; hand paint stays over the rules.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import { SURFACE_RULE_BLOCK_LAYERS, SURFACE_RULE_CAVITY_RADIUS, TERRAIN_LAYER_MAX, type RuleRange, type SurfaceRule } from '@thirdlight/runtime';

/** The conditions material and scatter rules share (`RuleConditions`). */
export const SHARED_CONDITIONS: readonly ConditionSpec[] = [
  { key: 'height', label: 'Height', unit: 'm', title: 'World height in metres.', start: { min: 0, fade: 1 } },
  { key: 'slope', label: 'Slope', unit: '°', title: 'Degrees from level: 0 flat, 90 a wall.', start: { min: 35, fade: 5 } },
  { key: 'cavity', label: 'Cavity', unit: 'm', title: 'How far the ground around (the radius away) lies above the point: positive in hollows, negative on ridges.', start: { min: 0.2, fade: 0.2, radius: SURFACE_RULE_CAVITY_RADIUS }, extra: [{ key: 'radius', label: 'radius', title: 'Metres around the point the ground is measured.' }] },
  {
    key: 'noise',
    label: 'Noise',
    unit: '',
    title: 'A noise mask (0-1) over world space; its bumps the size apart.',
    start: { min: 0.5, fade: 0.1, scale: 8, seed: 0 },
    extra: [
      { key: 'scale', label: 'size', title: "Metres between the noise's bumps." },
      { key: 'seed', label: 'seed', title: 'Another seed, another pattern.', int: true },
    ],
  },
];
const CONDITIONS: readonly ConditionSpec[] = [
  ...SHARED_CONDITIONS,
  { key: 'weight', label: 'Layer share', unit: '', title: 'How much (0-1) of a layer the rules before this one left there ("where rock is below 0.3").', start: { max: 0.3, fade: 0.1, layer: 1 }, extra: [{ key: 'layer', label: 'of layer', title: 'The layer whose share is read.', int: true }] },
];

interface Props {
  /** The rules stored now. */
  rules: readonly SurfaceRule[];
  /** A block layer's rules (layers 0-3, block types). */
  blocks: boolean;
  /** Store the draft (true: stored). */
  onApply: (rules: SurfaceRule[]) => Promise<boolean>;
  disabled?: boolean;
}

export const num = (v: string): number | undefined => {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

/** A condition the rule editors show: its key, label, unit, help and the range it starts from when ticked; `extra` its own fields. */
export interface ConditionSpec {
  key: string;
  label: string;
  unit: string;
  title: string;
  start: RuleRange & Record<string, number>;
  extra?: readonly { key: string; label: string; title: string; int?: boolean }[];
}

/** One range condition of a rule: a tick to have it, its min, max and fade, and its own fields (material and scatter rules alike). */
export function ConditionField(p: { condition: ConditionSpec; prefix: string; value: (RuleRange & Record<string, number>) | undefined; onChange: (v: (RuleRange & Record<string, number>) | undefined) => void }): JSX.Element {
  const c = p.condition;
  const v = p.value;
  const set = (k: string, n: number | undefined): void => {
    const range = { ...v } as Record<string, number>;
    if (n === undefined) delete range[k];
    else range[k] = n;
    p.onChange(range as RuleRange & Record<string, number>);
  };
  return (
    <span className="tl-blocks__opts">
      <label title={c.title}>
        <input type="checkbox" aria-label={`${p.prefix} ${c.key}`} checked={v !== undefined} onChange={(e) => p.onChange(e.target.checked ? { ...c.start } : undefined)} /> {c.label}
      </label>
      {v !== undefined &&
        (['min', 'max', 'fade'] as const).map((k) => (
          <label key={k} title={k === 'fade' ? 'How far past an end the rule fades out.' : `The range's ${k === 'min' ? 'low' : 'high'} end (empty: open).`}>
            {k}{' '}
            <input aria-label={`${p.prefix} ${c.key} ${k}`} type="number" className="tl-blocks__num" step="any" value={v[k] ?? ''} onChange={(e) => {
              const n = num(e.target.value);
              set(k, n === undefined || (k === 'fade' && n <= 0) ? undefined : k === 'fade' ? Math.max(0, n) : n);
            }} />
            {k !== 'fade' && c.unit}
          </label>
        ))}
      {v !== undefined &&
        (c.extra ?? []).map((f) => (
          <label key={f.key} title={f.title}>
            {f.label}{' '}
            <input aria-label={`${p.prefix} ${c.key} ${f.label}`} type="number" className="tl-blocks__num" step={f.int === true ? 1 : 'any'} value={v[f.key] ?? ''} onChange={(e) => {
              const n = num(e.target.value);
              set(f.key, n === undefined ? undefined : f.int === true ? Math.round(n) : n);
            }} />
          </label>
        ))}
    </span>
  );
}

export function SurfaceRulesEditor(p: Props): JSX.Element {
  const stored = JSON.stringify(p.rules);
  const [draft, setDraft] = useState<SurfaceRule[]>(() => structuredClone([...p.rules]));
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(structuredClone(JSON.parse(stored) as SurfaceRule[])), [stored]);
  const layerMax = p.blocks ? SURFACE_RULE_BLOCK_LAYERS - 1 : TERRAIN_LAYER_MAX;
  const changed = JSON.stringify(draft) !== stored;
  const update = (i: number, patch: (r: SurfaceRule) => SurfaceRule): void => setDraft((d) => d.map((r, k) => (k === i ? patch(structuredClone(r)) : r)));
  const move = (i: number, by: number): void =>
    setDraft((d) => {
      const j = i + by;
      if (j < 0 || j >= d.length) return d;
      const out = [...d];
      [out[i], out[j]] = [out[j]!, out[i]!];
      return out;
    });
  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      await p.onApply(draft);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tl-blocks__form" role="group" aria-label="material rules">
      <div className="tl-panel__title">Material rules</div>
      <p className="tl-inspector__hint">
        {p.blocks
          ? 'Layers 0-3 by slope, height, cavity, noise and block type, painted at every vertex when chunks are meshed. Applied in order; where none applies, layer 0. Hand paint stays over them.'
          : 'Layers by slope, height, cavity and noise, baked into the tiles; a sculpt bakes them again where it moves the ground. Applied in order; where none applies, layer 0. Hand paint stays over them.'}
      </p>
      {draft.map((r, i) => (
        <fieldset key={i} className="tl-blocks__opts" aria-label={`rule ${i + 1}`}>
          <label title="The material layer the rule paints.">
            Layer <input aria-label={`rule ${i + 1} layer`} type="number" className="tl-blocks__num" min={0} max={layerMax} step={1} value={r.layer} onChange={(e) => update(i, (x) => ({ ...x, layer: Math.max(0, Math.min(layerMax, Math.round(num(e.target.value) ?? 0))) }))} />
          </label>
          <label title="How much of its layer it gives where every condition holds (0-1).">
            Strength <input aria-label={`rule ${i + 1} strength`} type="number" className="tl-blocks__num" min={0} max={1} step={0.05} value={r.strength ?? 1} onChange={(e) => update(i, (x) => ({ ...x, strength: Math.max(0, Math.min(1, num(e.target.value) ?? 1)) }))} />
          </label>
          <label title="Only tops, only walls (faces mapped from the side), or both.">
            Faces{' '}
            <select aria-label={`rule ${i + 1} faces`} value={r.face ?? ''} onChange={(e) => update(i, (x) => {
              const { face: _f, ...rest } = x;
              return e.target.value === '' ? rest : { ...rest, face: e.target.value as 'top' | 'wall' };
            })}>
              <option value="">tops and walls</option>
              <option value="top">tops</option>
              <option value="wall">walls</option>
            </select>
          </label>
          {CONDITIONS.map((c) => (
            <ConditionField key={c.key} condition={c} prefix={`rule ${i + 1}`} value={(r as unknown as Record<string, unknown>)[c.key] as (RuleRange & Record<string, number>) | undefined} onChange={(v) => update(i, (x) => {
              const out = { ...x } as Record<string, unknown>;
              if (v === undefined) delete out[c.key];
              else out[c.key] = v;
              return out as unknown as SurfaceRule;
            })} />
          ))}
          {p.blocks && (
            <label title="Only these block types (ids, comma-separated; empty: any).">
              Block types{' '}
              <input aria-label={`rule ${i + 1} block types`} className="tl-input" value={(r.blocks ?? []).join(', ')} onChange={(e) => update(i, (x) => {
                const ids = e.target.value.split(',').map((t) => t.trim()).filter((t) => t !== '');
                const { blocks: _b, ...rest } = x;
                return ids.length > 0 ? { ...rest, blocks: ids } : rest;
              })} />
            </label>
          )}
          <span className="tl-inspector__modes">
            <button className="tl-btn tl-btn--small" aria-label={`rule ${i + 1} up`} title="Earlier (later rules paint over it)" disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button className="tl-btn tl-btn--small" aria-label={`rule ${i + 1} down`} title="Later (it paints over the earlier ones)" disabled={i === draft.length - 1} onClick={() => move(i, 1)}>
              ↓
            </button>
            <button className="tl-btn tl-btn--small" aria-label={`rule ${i + 1} remove`} onClick={() => setDraft((d) => d.filter((_x, k) => k !== i))}>
              Remove
            </button>
          </span>
        </fieldset>
      ))}
      <div className="tl-inspector__modes">
        <button className="tl-btn tl-btn--small" aria-label="add rule" onClick={() => setDraft((d) => [...d, { layer: Math.min(layerMax, 1), slope: { min: 35, fade: 5 } }])}>
          Add rule
        </button>
        <button className="tl-btn tl-btn--small" aria-label="apply rules" disabled={!changed || busy || p.disabled === true} onClick={() => void apply()}>
          {busy ? 'Applying…' : 'Apply'}
        </button>
        <button className="tl-btn tl-btn--small" aria-label="revert rules" disabled={!changed || busy} onClick={() => setDraft(structuredClone(JSON.parse(stored) as SurfaceRule[]))}>
          Revert
        </button>
      </div>
    </div>
  );
}
