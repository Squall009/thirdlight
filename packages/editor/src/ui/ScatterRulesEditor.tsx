/**
 * Scatter rules of a terrain or a block layer (`scatter.ts`): a list of
 * rules, each a model placed by density where its conditions hold — height,
 * slope, cavity and noise (the material rules' conditions), the share of a
 * material layer, and on a block layer its block types — no two closer
 * than the spacing, with a random scale and turn, kept off named regions.
 * Drawing settings: the shadow it casts, the collider each copy carries. A
 * ground cover rule is never stored: it is made near the camera at run time.
 *
 * Rules are edited as a draft and applied in one step: a terrain bakes them
 * into its tiles' scatter (`editTerrain` bake); a block layer stores them on
 * its component and bakes its chunks (`editBlocks` bakeScatter). Hand edits
 * with the scatter brush stay over the rules.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import { FOLIAGE_NEAR_METRES, SCATTER_COVER_DISTANCE_DEFAULT, SCATTER_LIMITS, SURFACE_RULE_BLOCK_LAYERS, SURFACE_RULE_LAYER_MAX, type RuleRange, type ScatterRule } from '@thirdlight/runtime';

import { RefPicker } from './catalog/RefPicker';
import { ConditionField, SHARED_CONDITIONS, num } from './SurfaceRulesEditor';

interface Props {
  /** The rules stored now. */
  rules: readonly ScatterRule[];
  /** A block layer's rules (layers 0-3, block types). */
  blocks: boolean;
  /** Store the draft (true: stored). */
  onApply: (rules: ScatterRule[]) => Promise<boolean>;
  disabled?: boolean;
}

/** A new rule: trees on gentle ground, 8 m apart. */
const NEW_RULE: Omit<ScatterRule, 'id' | 'asset'> = { density: 0.02, spacing: 4, scale: [0.8, 1.2], slope: { max: 25, fade: 5 } };

/** The layer-share condition the editor shows: the first of the rule's list. */
const LAYER_CONDITION = { key: 'layers', label: 'Layer share', unit: '', title: 'How much (0-1) of a material layer the ground shows there ("where grass is over 0.5").', start: { min: 0.5, fade: 0.1, layer: 0 }, extra: [{ key: 'layer', label: 'of layer', title: 'The layer whose share is read.', int: true }] };

export function ScatterRulesEditor(p: Props): JSX.Element {
  const stored = JSON.stringify(p.rules);
  const [draft, setDraft] = useState<ScatterRule[]>(() => structuredClone([...p.rules]));
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(structuredClone(JSON.parse(stored) as ScatterRule[])), [stored]);
  const layerMax = p.blocks ? SURFACE_RULE_BLOCK_LAYERS - 1 : SURFACE_RULE_LAYER_MAX;
  const changed = JSON.stringify(draft) !== stored;
  const ready = draft.every((r) => r.asset.assetId !== '');
  const update = (i: number, patch: (r: ScatterRule) => ScatterRule): void => setDraft((d) => d.map((r, k) => (k === i ? patch(structuredClone(r)) : r)));
  const field = (i: number, key: keyof ScatterRule, v: unknown): void =>
    update(i, (x) => {
      const out = { ...x } as Record<string, unknown>;
      if (v === undefined) delete out[key];
      else out[key] = v;
      return out as unknown as ScatterRule;
    });
  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      await p.onApply(draft);
    } finally {
      setBusy(false);
    }
  };
  const freeId = (): string => {
    for (let n = draft.length + 1; ; n++) if (!draft.some((r) => r.id === `rule-${n}`)) return `rule-${n}`;
  };
  return (
    <div className="tl-blocks__form" role="group" aria-label="scatter rules">
      <div className="tl-panel__title">Scatter rules</div>
      <p className="tl-inspector__hint">
        {p.blocks
          ? 'Models placed on the tops where the conditions hold, baked into the chunks; an edit bakes them again around itself. The Scatter brush adds or takes copies by hand; those stay over the rules.'
          : 'Models placed where the conditions hold, baked into the tiles; a sculpt or paint bakes them again around itself. The Scatter brush adds or takes copies by hand; those stay over the rules.'}
      </p>
      {draft.map((r, i) => {
        const pre = `scatter ${i + 1}`;
        return (
          <fieldset key={i} className="tl-blocks__opts" aria-label={`scatter rule ${i + 1}`}>
            <label title="Names the rule (its copies and hand edits): letters, digits, _ and -.">
              Name{' '}
              <input aria-label={`${pre} name`} className="tl-input" value={r.id} maxLength={32} onChange={(e) => update(i, (x) => ({ ...x, id: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') }))} />
            </label>
            <label title="The model placed.">
              Model <RefPicker aria={`${pre} model`} kinds={['model']} value={r.asset.assetId} none={null} onPick={(v) => update(i, (x) => ({ ...x, asset: { assetId: v } }))} />
            </label>
            <label title="Places per square metre where every condition holds fully (0.01: one per 100 m²).">
              Density <input aria-label={`${pre} density`} type="number" className="tl-blocks__num" min={0.0001} max={100} step="any" value={r.density} onChange={(e) => field(i, 'density', Math.max(0.0001, Math.min(100, num(e.target.value) ?? r.density)))} />
            </label>
            <label title="No two copies of the rule closer than this across the ground (m).">
              Spacing <input aria-label={`${pre} spacing`} type="number" className="tl-blocks__num" min={0} max={100} step="any" value={r.spacing ?? 0} onChange={(e) => field(i, 'spacing', (num(e.target.value) ?? 0) > 0 ? Math.min(100, num(e.target.value)!) : undefined)} />
            </label>
            <label title="Each copy's scale, random between these.">
              Scale <input aria-label={`${pre} scale min`} type="number" className="tl-blocks__num" min={0.01} step="any" value={r.scale?.[0] ?? 1} onChange={(e) => field(i, 'scale', [Math.max(0.01, num(e.target.value) ?? 1), Math.max(Math.max(0.01, num(e.target.value) ?? 1), r.scale?.[1] ?? 1)])} />
              –<input aria-label={`${pre} scale max`} type="number" className="tl-blocks__num" min={0.01} step="any" value={r.scale?.[1] ?? 1} onChange={(e) => field(i, 'scale', [Math.min(r.scale?.[0] ?? 1, Math.max(0.01, num(e.target.value) ?? 1)), Math.max(0.01, num(e.target.value) ?? 1)])} />
            </label>
            <label title="How far each copy leans to the ground's slope: 0 upright, 1 along it.">
              Align <input aria-label={`${pre} align`} type="number" className="tl-blocks__num" min={0} max={1} step={0.1} value={r.align ?? 0} onChange={(e) => field(i, 'align', Math.max(0, Math.min(1, num(e.target.value) ?? 0)) || undefined)} />
            </label>
            {SHARED_CONDITIONS.map((c) => (
              <ConditionField key={c.key} condition={c} prefix={pre} value={r[c.key as 'height'] as (RuleRange & Record<string, number>) | undefined} onChange={(v) => field(i, c.key as keyof ScatterRule, v)} />
            ))}
            <ConditionField condition={{ ...LAYER_CONDITION, start: { ...LAYER_CONDITION.start, layer: Math.min(layerMax, LAYER_CONDITION.start.layer) } }} prefix={pre} value={r.layers?.[0] as (RuleRange & Record<string, number>) | undefined} onChange={(v) => field(i, 'layers', v === undefined ? undefined : [{ ...v, layer: Math.max(0, Math.min(layerMax, Math.round(v['layer'] ?? 0))) }, ...(r.layers ?? []).slice(1)])} />
            {p.blocks && (
              <label title="Only on these block types (ids, comma-separated; empty: any).">
                Block types{' '}
                <input aria-label={`${pre} block types`} className="tl-input" value={(r.blocks ?? []).join(', ')} onChange={(e) => {
                  const ids = e.target.value.split(',').map((t) => t.trim()).filter((t) => t !== '');
                  field(i, 'blocks', ids.length > 0 ? ids : undefined);
                }} />
              </label>
            )}
            <label title="Block-layer regions kept clear (names, comma-separated).">
              Keep clear{' '}
              <input aria-label={`${pre} exclude`} className="tl-input" value={(r.exclude ?? []).join(', ')} onChange={(e) => {
                const names = e.target.value.split(',').map((t) => t.trim()).filter((t) => t !== '');
                field(i, 'exclude', names.length > 0 ? names : undefined);
              }} />
            </label>
            <label title="The copies cast the key light's shadow (the foliage policy: rarely, and only near the camera).">
              <input type="checkbox" aria-label={`${pre} cast shadow`} checked={r.castShadow === true} onChange={(e) => update(i, (x) => {
                const { castShadow: _c, shadowDistance: _d, ...rest } = x;
                return e.target.checked ? { ...rest, castShadow: true, shadowDistance: FOLIAGE_NEAR_METRES } : rest;
              })} /> Casts shadow
            </label>
            {r.castShadow === true && (
              <label title="Only copies within this many metres of the camera cast (into the moving shadow map); empty: every copy (into the cached static map).">
                within <input aria-label={`${pre} shadow distance`} type="number" className="tl-blocks__num" min={SCATTER_LIMITS.shadowDistance.min} max={SCATTER_LIMITS.shadowDistance.max} step={5} value={r.shadowDistance ?? ''} onChange={(e) => field(i, 'shadowDistance', num(e.target.value) === undefined ? undefined : Math.max(SCATTER_LIMITS.shadowDistance.min, Math.min(SCATTER_LIMITS.shadowDistance.max, num(e.target.value)!)))} /> m
              </label>
            )}
            <label title="A soft dark disc of this radius (m, at the copy's scale) under each copy near the camera: a contact shadow without a shadow map. Empty: none.">
              Blob <input aria-label={`${pre} blob shadow`} type="number" className="tl-blocks__num" min={SCATTER_LIMITS.blobShadow.min} max={SCATTER_LIMITS.blobShadow.max} step={0.1} value={r.blobShadow ?? ''} onChange={(e) => field(i, 'blobShadow', num(e.target.value) === undefined ? undefined : Math.max(SCATTER_LIMITS.blobShadow.min, Math.min(SCATTER_LIMITS.blobShadow.max, num(e.target.value)!)))} /> m
            </label>
            <label title="Ground cover (grass, pebbles, small flowers): never stored, made near the camera while the game runs, thinning out to nothing at its reach; no colliders, no hand edits.">
              <input type="checkbox" aria-label={`${pre} cover`} checked={r.cover === true} onChange={(e) => update(i, (x) => {
                const { cover: _c, coverDistance: _d, collide: _k, ...rest } = x;
                return e.target.checked ? { ...rest, cover: true } : rest;
              })} /> Ground cover
            </label>
            {r.cover === true ? (
              <label title="Metres from the camera the cover reaches (it thins out over the last part).">
                Reach <input aria-label={`${pre} cover distance`} type="number" className="tl-blocks__num" min={SCATTER_LIMITS.coverDistance.min} max={SCATTER_LIMITS.coverDistance.max} step={1} value={r.coverDistance ?? SCATTER_COVER_DISTANCE_DEFAULT} onChange={(e) => field(i, 'coverDistance', Math.max(SCATTER_LIMITS.coverDistance.min, Math.min(SCATTER_LIMITS.coverDistance.max, num(e.target.value) ?? SCATTER_COVER_DISTANCE_DEFAULT)))} /> m
              </label>
            ) : (
              <label title="Each copy carries its model's colliders (`_COL`) in the game.">
                <input type="checkbox" aria-label={`${pre} collide`} checked={r.collide === true} onChange={(e) => field(i, 'collide', e.target.checked ? true : undefined)} /> Collides
              </label>
            )}
            <span className="tl-inspector__modes">
              <button className="tl-btn tl-btn--small" aria-label={`${pre} remove`} onClick={() => setDraft((d) => d.filter((_x, k) => k !== i))}>
                Remove
              </button>
            </span>
          </fieldset>
        );
      })}
      <div className="tl-inspector__modes">
        <button className="tl-btn tl-btn--small" aria-label="add scatter rule" onClick={() => setDraft((d) => [...d, { id: freeId(), asset: { assetId: '' }, ...structuredClone(NEW_RULE), seed: d.length + 1 }])}>
          Add rule
        </button>
        <button className="tl-btn tl-btn--small" aria-label="apply scatter rules" disabled={!changed || !ready || busy || p.disabled === true} title={ready ? undefined : 'Every rule needs a model'} onClick={() => void apply()}>
          {busy ? 'Applying…' : 'Apply'}
        </button>
        <button className="tl-btn tl-btn--small" aria-label="revert scatter rules" disabled={!changed || busy} onClick={() => setDraft(structuredClone(JSON.parse(stored) as ScatterRule[]))}>
          Revert
        </button>
      </div>
    </div>
  );
}
