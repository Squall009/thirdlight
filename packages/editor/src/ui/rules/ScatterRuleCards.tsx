/**
 * Scatter rules as cards (a terrain's or a block layer's, `scatter.ts`): each
 * rule a card with its name, its model and a summary line; the picked card
 * opens every field the rule has, in three groups:
 *
 * - Placement: the model (and a piece of it), density, spacing, the random
 *   scale, turn and lean, how far each copy sinks, the seed;
 * - Where: the conditions material rules have (slope, height, cavity,
 *   noise), the layers the ground must show (each picked from the palette),
 *   block types on a block layer, regions kept clear;
 * - Drawing: shadows (cast within a distance, a blob under each copy),
 *   ground cover (made near the camera, never stored) or colliders, far
 *   copies as impostors, the chunk size, thinning out far copies, a level of
 *   detail per copy.
 *
 * The cards edit a draft their owner holds and bakes in one step;
 * `ScatterRulesEditor` is the draft with Apply and Revert.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import { INSTANCE_DENSITY_END_DEFAULT, INSTANCE_DENSITY_MIN_DEFAULT, INSTANCE_DENSITY_START_DEFAULT } from '@thirdlight/project-model/limits';
import { FOLIAGE_NEAR_METRES, SCATTER_CHUNK_METERS_DEFAULT, SCATTER_COVER_DISTANCE_DEFAULT, SCATTER_LIMITS, SURFACE_RULE_BLOCK_LAYERS, TERRAIN_LAYER_MAX, type ScatterRule } from '@thirdlight/runtime';

import { scatterRuleSummary } from '../../session/rule-text';
import { SliderField } from '../brush/SliderField';
import { MODEL_KINDS, RefPicker, useEntryName } from '../catalog/RefPicker';
import { Toggle } from '../editmode/controls';
import { Glyph } from '../editmode/glyphs';
import { ChipsField } from './ChipsField';
import type { LayerField } from './MaterialRuleCards';
import { useRuleDraft } from './MaterialRuleCards';
import { LayerConditions, RuleConditions, SeedField } from './RuleConditions';

/** A new rule: copies on gentle ground, 4 m apart. */
export const NEW_SCATTER_RULE: Omit<ScatterRule, 'id' | 'asset'> = Object.freeze({ density: 0.02, spacing: 4, scale: [0.8, 1.2], slope: { max: 25, fade: 5 } }) as Omit<ScatterRule, 'id' | 'asset'>;

/** A new rule on a model or architecture: ground cover, 2 copies a m² on gentle faces. */
const NEW_COVER_RULE: Omit<ScatterRule, 'id' | 'asset'> = Object.freeze({ density: 2, scale: [0.8, 1.2], slope: { max: 25, fade: 5 }, cover: true }) as Omit<ScatterRule, 'id' | 'asset'>;

/** A free rule name ("rule-3"). */
export function freeScatterId(rules: readonly ScatterRule[]): string {
  for (let n = rules.length + 1; ; n++) if (!rules.some((r) => r.id === `rule-${n}`)) return `rule-${n}`;
}

export interface ScatterRuleCardsProps {
  rules: readonly ScatterRule[];
  onChange: (rules: ScatterRule[]) => void;
  selected: number | null;
  onSelect: (index: number | null) => void;
  blocks: boolean;
  layerField: LayerField;
  layerName: (index: number) => string;
  height: readonly [number, number];
  disabled?: boolean;
  /** A model's or architecture's rules: ground cover only, on faces with no layers or regions. */
  coverOnly?: boolean;
}

const L = SCATTER_LIMITS;

export function ScatterRuleCards(p: ScatterRuleCardsProps): JSX.Element {
  const layerMax = p.blocks ? SURFACE_RULE_BLOCK_LAYERS - 1 : TERRAIN_LAYER_MAX;
  const update = (i: number, patch: (r: ScatterRule) => ScatterRule): void => p.onChange(p.rules.map((r, k) => (k === i ? patch(structuredClone(r)) : r)));
  const set = (i: number) => (key: string, v: unknown): void =>
    update(i, (r) => {
      const out = { ...r } as Record<string, unknown>;
      if (v === undefined || v === null) delete out[key];
      else out[key] = v;
      return out as unknown as ScatterRule;
    });
  return (
    <div className="tl-rules" role="list" aria-label="scatter rules list">
      {p.rules.map((r, i) => (
        <ScatterCard key={i} {...p} rule={r} index={i} layerMax={layerMax} set={set(i)} update={(f) => update(i, f)} />
      ))}
      <button
        type="button"
        className="tl-addrow tl-addrow--wide"
        aria-label="add scatter rule"
        disabled={p.disabled}
        onClick={() => {
          p.onChange([...p.rules, { id: freeScatterId(p.rules), asset: { assetId: '' }, ...structuredClone(p.coverOnly === true ? NEW_COVER_RULE : NEW_SCATTER_RULE), seed: p.rules.length + 1 } as ScatterRule]);
          p.onSelect(p.rules.length);
        }}
      >
        <Glyph name="plus" size={14} /> Add rule
      </button>
    </div>
  );
}

function ScatterCard(p: ScatterRuleCardsProps & { rule: ScatterRule; index: number; layerMax: number; set: (key: string, v: unknown) => void; update: (f: (r: ScatterRule) => ScatterRule) => void }): JSX.Element {
  const r = p.rule;
  const i = p.index;
  const open = p.selected === i;
  const pre = `scatter ${i + 1}`;
  const model = useEntryName(r.asset.assetId === '' ? null : r.asset.assetId, MODEL_KINDS);
  const off = p.disabled;
  const scale = r.scale ?? [1, 1];
  const thinning = r.densityStart !== undefined || r.densityEnd !== undefined || r.densityMin !== undefined;
  return (
    <div role="listitem" aria-label={`scatter rule ${i + 1}`} className={`tl-rule${open ? ' is-active' : ''}`}>
      <div className="tl-rule__head" onClick={() => p.onSelect(open ? null : i)}>
        <Glyph name="scatter" size={16} />
        <span className="tl-rule__name">{r.id}</span>
        <span className={`tl-tag${r.asset.assetId === '' ? ' tl-tag--warn' : ''}`}>{r.asset.assetId === '' ? 'no model' : (model?.name ?? r.asset.assetId)}</span>
      </div>
      {!open && <div className="tl-rule__sum">{scatterRuleSummary(r, p.layerName)}</div>}
      {open && (
        <div className="tl-rule__body">
          <div className="tl-subhead">Placement</div>
          <div className="tl-frow">
            <span className="tl-frow__label">Name</span>
            <input className="tl-input" aria-label={`${pre} name`} value={r.id} maxLength={L.idLength} disabled={off} title="Names the rule (its copies and hand edits): letters, digits, _ and -." onChange={(e) => p.update((x) => ({ ...x, id: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') }))} />
          </div>
          <div className="tl-frow">
            <span className="tl-frow__label">Model</span>
            <RefPicker aria={`${pre} model`} kinds={MODEL_KINDS} value={r.asset.assetId} none={null} disabled={off} onPick={(v) => p.update((x) => ({ ...x, asset: { ...x.asset, assetId: v } }))} />
          </div>
          <div className="tl-frow">
            <span className="tl-frow__label">Piece</span>
            <input className="tl-input" aria-label={`${pre} piece`} placeholder="the whole model" value={r.asset.piece ?? ''} maxLength={128} disabled={off} title="One piece of the model (its node name); empty: the whole model." onChange={(e) => p.update((x) => ({ ...x, asset: { assetId: x.asset.assetId, ...(e.target.value !== '' ? { piece: e.target.value } : {}) } }))} />
          </div>
          <SliderField label="Density" aria={`${pre} density`} value={r.density} min={0.001} max={10} log limit={[L.density.min, L.density.max]} step={0.001} decimals={r.density < 0.1 ? 3 : 2} unit="/m²" hint="Copies per square metre where every condition holds fully (0.01: one per 100 m²)." disabled={off} onChange={(v) => p.set('density', v)} />
          <SliderField label="Spacing" aria={`${pre} spacing`} value={r.spacing ?? 0} min={0} max={20} limit={[0, L.spacingMax]} step={0.1} unit="m" hint="No two copies closer than this." disabled={off} onChange={(v) => p.set('spacing', v > 0 ? v : undefined)} />
          <SliderField label="Smallest" aria={`${pre} scale min`} value={scale[0]} min={0.1} max={4} log limit={[L.scale.min, L.scale.max]} step={0.01} hint="Each copy's scale is random between the smallest and the largest." disabled={off} onChange={(v) => p.set('scale', [v, Math.max(v, scale[1])])} />
          <SliderField label="Largest" aria={`${pre} scale max`} value={scale[1]} min={0.1} max={4} log limit={[L.scale.min, L.scale.max]} step={0.01} disabled={off} onChange={(v) => p.set('scale', [Math.min(scale[0], v), v])} />
          <SliderField label="Random turn" aria={`${pre} yaw`} value={r.yaw ?? 360} min={0} max={360} step={1} unit="°" hint="Each copy turns about up by a random angle up to this (0: all face the same way)." disabled={off} onChange={(v) => p.set('yaw', v === 360 ? undefined : v)} />
          <SliderField label="Lean" aria={`${pre} align`} value={r.align ?? 0} min={0} max={1} step={1} scale={100} unit="%" hint="How far each copy leans with the ground's slope: 0 upright, 100 % along it." disabled={off} onChange={(v) => p.set('align', v > 0 ? v : undefined)} />
          <SliderField label="Sink" aria={`${pre} sink`} value={r.sink ?? 0} min={-2} max={2} limit={[-L.sinkMax, L.sinkMax]} step={0.05} unit="m" hint="Metres each copy is lowered into the ground (roots, rocks bedded in)." disabled={off} onChange={(v) => p.set('sink', v !== 0 ? v : undefined)} />
          <SeedField aria={`${pre} seed`} value={r.seed ?? 0} disabled={off} onChange={(n) => p.set('seed', n !== 0 ? n : undefined)} />

          <div className="tl-subhead">Where</div>
          <RuleConditions prefix={pre} rule={r as unknown as Record<string, unknown>} height={p.height} set={p.set} disabled={off} />
          {p.coverOnly !== true && <LayerConditions prefix={pre} title="On layer" list={r.layers ?? []} layerField={p.layerField} disabled={off} onChange={(list) => p.set('layers', list.length > 0 ? list.map((c) => ({ ...c, layer: Math.max(0, Math.min(p.layerMax, c.layer)) })) : undefined)} />}
          {p.blocks && <ChipsField label="Block types" aria={`${pre} block types`} values={r.blocks ?? []} placeholder="any block type" disabled={off} onChange={(ids) => p.set('blocks', ids.length > 0 ? ids : undefined)} />}
          {p.coverOnly !== true && <ChipsField label="Keep clear" aria={`${pre} exclude`} values={r.exclude ?? []} placeholder="block-layer region names" maxLength={L.regionName} disabled={off} onChange={(names) => p.set('exclude', names.length > 0 ? names : undefined)} />}

          <div className="tl-subhead">Drawing</div>
          {p.coverOnly !== true && <Toggle label="Ground cover" aria={`${pre} cover`} hint="Grass, pebbles, small flowers: never stored, made near the camera while the game runs, thinning out to nothing at its reach; no colliders, no hand edits." on={r.cover === true} disabled={off} onChange={(on) => p.update((x) => {
            const { cover: _c, coverDistance: _d, collide: _k, impostorSize: _i, ...rest } = x;
            return on ? { ...rest, cover: true } : rest;
          })} />}
          {r.cover === true ? (
            <SliderField label="Reach" aria={`${pre} cover distance`} value={r.coverDistance ?? SCATTER_COVER_DISTANCE_DEFAULT} min={L.coverDistance.min} max={200} limit={[L.coverDistance.min, L.coverDistance.max]} step={1} unit="m" hint="Metres from the camera the cover reaches (it thins out over the last part)." disabled={off} onChange={(v) => p.set('coverDistance', v)} />
          ) : (
            <>
              <Toggle label="Collides" aria={`${pre} collide`} hint="Each copy carries its model's colliders (_COL) in the game." on={r.collide === true} disabled={off} onChange={(on) => p.set('collide', on ? true : undefined)} />
              <Toggle label="Far copies as impostors" aria={`${pre} impostor`} hint="Copies smaller on screen than the size draw as one baked quad instead of their meshes." on={r.impostorSize !== undefined} disabled={off} onChange={(on) => p.set('impostorSize', on ? 0.02 : undefined)} />
              {r.impostorSize !== undefined && (
                <SliderField label="below" aria={`${pre} impostor size`} value={r.impostorSize} min={0.001} max={0.5} log limit={[L.impostorSize.min, L.impostorSize.max]} step={0.001} decimals={3} unit="of view" hint="The share of the view's height under which a copy is an impostor." disabled={off} onChange={(v) => p.set('impostorSize', v)} />
              )}
            </>
          )}
          <Toggle label="Casts shadow" aria={`${pre} cast shadow`} hint="The copies cast the key light's shadow (rarely worth it for foliage)." on={r.castShadow === true} disabled={off} onChange={(on) => p.update((x) => {
            const { castShadow: _c, shadowDistance: _d, ...rest } = x;
            return on ? { ...rest, castShadow: true, shadowDistance: FOLIAGE_NEAR_METRES } : rest;
          })} />
          {r.castShadow === true && (
            <SliderField label="within" aria={`${pre} shadow distance`} value={r.shadowDistance ?? L.shadowDistance.max} min={L.shadowDistance.min} max={500} log limit={[L.shadowDistance.min, L.shadowDistance.max]} step={1} unit="m" hint="Only copies this close to the camera cast (into the moving shadow map)." disabled={off} onChange={(v) => p.set('shadowDistance', v)} />
          )}
          <Toggle label="Blob shadow" aria={`${pre} blob`} hint="A soft dark disc under each copy near the camera: a contact shadow without a shadow map." on={r.blobShadow !== undefined} disabled={off} onChange={(on) => p.set('blobShadow', on ? 0.6 : undefined)} />
          {r.blobShadow !== undefined && (
            <SliderField label="radius" aria={`${pre} blob shadow`} value={r.blobShadow} min={L.blobShadow.min} max={8} log limit={[L.blobShadow.min, L.blobShadow.max]} step={0.05} unit="m" disabled={off} onChange={(v) => p.set('blobShadow', v)} />
          )}
          <Toggle label="See-through" aria={`${pre} see through`} hint="The copies thin to a dither round a subject behind them (the project's see-through; off: they always stay solid)." on={r.seeThrough !== false} disabled={off} onChange={(on) => p.set('seeThrough', on ? undefined : false)} />
          {r.cover !== true && (
            <>
              <Toggle label="Thin out far copies" aria={`${pre} density falloff`} hint="Far copies, small on screen, are drawn fewer: from the start size down to the end size, where the least share is drawn." on={thinning} disabled={off} onChange={(on) => p.update((x) => {
                const { densityStart: _s, densityEnd: _e, densityMin: _m, ...rest } = x;
                return on ? { ...rest, densityStart: INSTANCE_DENSITY_START_DEFAULT, densityEnd: INSTANCE_DENSITY_END_DEFAULT, densityMin: INSTANCE_DENSITY_MIN_DEFAULT } : rest;
              })} />
              {thinning && (
                <>
                  <SliderField label="from size" aria={`${pre} density start`} value={r.densityStart ?? INSTANCE_DENSITY_START_DEFAULT} min={0.001} max={1} log step={0.001} decimals={3} hint="The screen size (share of the view's height) where thinning begins." disabled={off} onChange={(v) => p.set('densityStart', v)} />
                  <SliderField label="to size" aria={`${pre} density end`} value={r.densityEnd ?? INSTANCE_DENSITY_END_DEFAULT} min={0.0001} max={1} log step={0.0001} decimals={4} hint="The screen size where the least share is drawn." disabled={off} onChange={(v) => p.set('densityEnd', v)} />
                  <SliderField label="least drawn" aria={`${pre} density min`} value={r.densityMin ?? INSTANCE_DENSITY_MIN_DEFAULT} min={0} max={1} step={1} scale={100} unit="%" disabled={off} onChange={(v) => p.set('densityMin', v)} />
                </>
              )}
              <Toggle label="Detail level per copy" aria={`${pre} lod per copy`} hint="Each copy picks its own level of detail (off: a block of copies switches together)." on={r.lodPerCopy !== false} disabled={off} onChange={(on) => p.set('lodPerCopy', on ? undefined : false)} />
              <SliderField label="Chunk size" aria={`${pre} chunk size`} value={r.chunkSize ?? SCATTER_CHUNK_METERS_DEFAULT} min={16} max={4096} log limit={[1, 4096]} step={1} unit="m" hint="The squares copies are culled by (no block of copies spans two)." disabled={off} onChange={(v) => p.set('chunkSize', v === SCATTER_CHUNK_METERS_DEFAULT ? undefined : v)} />
            </>
          )}
          <div className="tl-rule__foot">
            <span className="tl-emh__spacer" />
            <button type="button" className="tl-btn tl-btn--small" aria-label={`${pre} remove`} disabled={off} onClick={() => {
              p.onChange(p.rules.filter((_x, k) => k !== i));
              p.onSelect(null);
            }}>
              <Glyph name="trash" size={14} /> Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The cards with Apply and Revert (a block layer's scatter; with `coverOnly`, a model's or architecture's ground cover). */
export function ScatterRulesEditor(p: { rules: readonly ScatterRule[]; blocks: boolean; onApply: (rules: ScatterRule[]) => Promise<boolean>; disabled?: boolean; height: readonly [number, number]; layerField: LayerField; coverOnly?: boolean }): JSX.Element {
  const { draft, setDraft, changed, revert } = useRuleDraft(p.rules);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = draft.every((r) => r.asset.assetId !== '');
  return (
    <div className="tl-blocks__form" role="group" aria-label="scatter rules">
      <div className="tl-panel__title">{p.coverOnly === true ? 'Ground cover' : 'Scatter rules'}</div>
      <p className="tl-hint">{p.coverOnly === true ? 'Grass, moss, pebbles on the faces that look up (a model\'s, generated floors): made near the camera while the game runs, never stored.' : 'Models placed where the conditions hold, baked into the chunks; an edit bakes them again around itself. The Scatter brush adds or takes copies by hand; those stay over the rules.'}</p>
      <ScatterRuleCards rules={draft} onChange={setDraft} selected={selected} onSelect={setSelected} blocks={p.blocks} layerField={p.layerField} layerName={(k) => `layer ${k + 1}`} height={p.height} disabled={p.disabled} {...(p.coverOnly === true ? { coverOnly: true } : {})} />
      <div className="tl-inspector__modes">
        <button className="tl-btn tl-btn--small" aria-label="apply scatter rules" disabled={!changed || !ready || busy || p.disabled === true} title={ready ? undefined : 'Every rule needs a model'} onClick={() => {
          setBusy(true);
          void p.onApply(draft).finally(() => setBusy(false));
        }}>
          {busy ? 'Applying…' : 'Apply'}
        </button>
        <button className="tl-btn tl-btn--small" aria-label="revert scatter rules" disabled={!changed || busy} onClick={revert}>
          Revert
        </button>
      </div>
    </div>
  );
}
