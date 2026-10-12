/**
 * Material rules as cards (a terrain's or a block layer's, `surface-rules.ts`):
 * each rule a card with its grip, its name, the layer it paints (picked from
 * the palette by its picture) and a one-line summary of where it applies.
 * The picked card opens: its name, strength, conditions (slope, height,
 * cavity, noise as range sliders, each with its softness), "only where"
 * another layer's share holds and, on a block layer, its faces and block
 * types. Cards reorder by dragging the grip (later rules paint over earlier
 * ones) or with the arrows of the open card.
 *
 * The cards edit a draft their owner holds: the terrain editor previews it
 * live and bakes it in one step; `MaterialRulesEditor` is the draft with
 * Apply and Revert, for owners without a preview (a block layer).
 *
 * Browser-only (React).
 */
import { useEffect, useState, type DragEvent, type JSX, type ReactNode } from 'react';
import { SURFACE_RULE_BLOCK_LAYERS, TERRAIN_LAYER_MAX, type SurfaceRule } from '@thirdlight/runtime';

import { surfaceRuleSummary, surfaceRuleTitle } from '../../session/rule-text';
import { SliderField } from '../brush/SliderField';
import { Segmented } from '../editmode/controls';
import { Glyph } from '../editmode/glyphs';
import { ChipsField } from './ChipsField';
import { LayerConditions, RuleConditions } from './RuleConditions';

/** The layer field of a rule (a terrain: the palette's picker; a block layer: its four layers). */
export type LayerField = (value: number, onChange: (layer: number) => void, aria: string) => ReactNode;

export interface MaterialRuleCardsProps {
  rules: readonly SurfaceRule[];
  onChange: (rules: SurfaceRule[]) => void;
  /** The open card (null: none). */
  selected: number | null;
  onSelect: (index: number | null) => void;
  /** A block layer's rules (layers 0-3, faces and block types). */
  blocks: boolean;
  layerField: LayerField;
  /** A layer's name (the summaries). */
  layerName: (index: number) => string;
  /** The height slider's track (world metres). */
  height: readonly [number, number];
  disabled?: boolean;
}

/** A new rule: the next layer on steep ground. */
export function newSurfaceRule(rules: readonly SurfaceRule[], layerMax: number): SurfaceRule {
  return { layer: Math.min(layerMax, rules.length === 0 ? 1 : Math.max(...rules.map((r) => r.layer)) + 1), slope: { min: 35, fade: 5 } };
}

const DRAG_TYPE = 'application/x-thirdlight-rule';

/** Move entry `from` to `to` (both indices of the list before the move). */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to > from ? to - 1 : to, 0, x!);
  return out;
}

export function MaterialRuleCards(p: MaterialRuleCardsProps): JSX.Element {
  const [over, setOver] = useState<number | null>(null);
  const layerMax = p.blocks ? SURFACE_RULE_BLOCK_LAYERS - 1 : TERRAIN_LAYER_MAX;
  const update = (i: number, patch: (r: SurfaceRule) => SurfaceRule): void => p.onChange(p.rules.map((r, k) => (k === i ? patch(structuredClone(r)) : r)));
  const set = (i: number) => (key: string, v: unknown): void =>
    update(i, (r) => {
      const out = { ...r } as Record<string, unknown>;
      if (v === undefined || v === null || v === '') delete out[key];
      else out[key] = v;
      return out as unknown as SurfaceRule;
    });
  const drop = (to: number) => (e: DragEvent): void => {
    setOver(null);
    const from = Number(e.dataTransfer.getData(DRAG_TYPE));
    if (!Number.isInteger(from) || from === to || from + 1 === to) return;
    e.preventDefault();
    p.onChange(moved(p.rules, from, to));
    p.onSelect(to > from ? to - 1 : to);
  };
  return (
    <div className="tl-rules" role="list" aria-label="material rules list">
      {p.rules.map((r, i) => {
        const open = p.selected === i;
        const pre = `rule ${i + 1}`;
        return (
          <div
            key={i}
            role="listitem"
            aria-label={pre}
            className={`tl-rule${open ? ' is-active' : ''}${over === i ? ' is-drop' : ''}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              setOver(i);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={drop(i)}
          >
            <div className="tl-rule__head" onClick={() => p.onSelect(open ? null : i)}>
              <span className="tl-rule__grip" draggable={p.disabled !== true} title="Drag to reorder: later rules paint over earlier ones" onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, String(i))} aria-hidden="true">
                ⋮⋮
              </span>
              <span className="tl-rule__name">{surfaceRuleTitle(r, p.layerName)}</span>
              <span onClick={(e) => e.stopPropagation()}>{p.layerField(r.layer, (layer) => update(i, (x) => ({ ...x, layer: Math.max(0, Math.min(layerMax, layer)) })), `${pre} layer`)}</span>
            </div>
            {!open && <div className="tl-rule__sum">{surfaceRuleSummary(r, p.layerName)}</div>}
            {open && (
              <div className="tl-rule__body">
                <div className="tl-frow">
                  <span className="tl-frow__label">Name</span>
                  <input className="tl-input" aria-label={`${pre} name`} placeholder={surfaceRuleTitle({ ...r, name: undefined }, p.layerName)} value={r.name ?? ''} maxLength={64} disabled={p.disabled} onChange={(e) => set(i)('name', e.target.value)} />
                </div>
                <SliderField label="Strength" aria={`${pre} strength`} value={r.strength ?? 1} min={0} max={1} step={1} scale={100} unit="%" hint="How much of its layer it gives where every condition holds." disabled={p.disabled} onChange={(v) => set(i)('strength', v === 1 ? undefined : v)} />
                <RuleConditions prefix={pre} rule={r as unknown as Record<string, unknown>} height={p.height} set={set(i)} disabled={p.disabled} />
                <LayerConditions
                  prefix={pre}
                  title="Only where"
                  single
                  list={r.weight !== undefined ? [r.weight] : []}
                  layerField={p.layerField}
                  disabled={p.disabled}
                  onChange={(list) => set(i)('weight', list[0])}
                />
                {p.blocks && (
                  <>
                    <div className="tl-frow">
                      <span className="tl-frow__label">Faces</span>
                      <Segmented small aria={`${pre} faces`} value={r.face ?? 'both'} options={[{ id: 'both', label: 'Tops and walls' }, { id: 'top', label: 'Tops' }, { id: 'wall', label: 'Walls' }]} onChange={(f) => set(i)('face', f === 'both' ? undefined : f)} />
                    </div>
                    <ChipsField label="Block types" aria={`${pre} block types`} values={r.blocks ?? []} placeholder="any block type" disabled={p.disabled} onChange={(ids) => set(i)('blocks', ids.length > 0 ? ids : undefined)} />
                  </>
                )}
                <div className="tl-rule__foot">
                  <button type="button" className="tl-iconbtn" aria-label={`${pre} up`} title="Earlier (later rules paint over it)" disabled={p.disabled === true || i === 0} onClick={() => (p.onChange(moved(p.rules, i, i - 1)), p.onSelect(i - 1))}>
                    <Glyph name="up" size={16} />
                  </button>
                  <button type="button" className="tl-iconbtn" aria-label={`${pre} down`} title="Later (it paints over the earlier ones)" disabled={p.disabled === true || i === p.rules.length - 1} onClick={() => (p.onChange(moved(p.rules, i, i + 2)), p.onSelect(i + 1))}>
                    <Glyph name="down" size={16} />
                  </button>
                  <span className="tl-emh__spacer" />
                  <button type="button" className="tl-btn tl-btn--small" aria-label={`${pre} remove`} disabled={p.disabled} onClick={() => (p.onChange(p.rules.filter((_x, k) => k !== i)), p.onSelect(null))}>
                    <Glyph name="trash" size={14} /> Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="tl-addrow tl-addrow--wide"
        aria-label="add rule"
        disabled={p.disabled}
        onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && e.preventDefault()}
        onDrop={drop(p.rules.length)}
        onClick={() => {
          p.onChange([...p.rules, newSurfaceRule(p.rules, layerMax)]);
          p.onSelect(p.rules.length);
        }}
      >
        <Glyph name="plus" size={14} /> Add rule
      </button>
    </div>
  );
}

/** A draft of stored rules: edited freely, compared with what is stored, put back on Revert, refreshed when the stored rules change. */
export function useRuleDraft<T>(stored: readonly T[]): { draft: T[]; setDraft: (d: T[]) => void; changed: boolean; revert: () => void } {
  const key = JSON.stringify(stored);
  const [draft, setDraft] = useState<T[]>(() => structuredClone([...stored]));
  useEffect(() => setDraft(structuredClone(JSON.parse(key) as T[])), [key]);
  return { draft, setDraft, changed: JSON.stringify(draft) !== key, revert: () => setDraft(structuredClone(JSON.parse(key) as T[])) };
}

/** The cards with Apply and Revert (a block layer's rules, stored on its component). */
export function MaterialRulesEditor(p: { rules: readonly SurfaceRule[]; blocks: boolean; onApply: (rules: SurfaceRule[]) => Promise<boolean>; disabled?: boolean; height: readonly [number, number] }): JSX.Element {
  const { draft, setDraft, changed, revert } = useRuleDraft(p.rules);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const four = (value: number, onChange: (layer: number) => void, aria: string): ReactNode => (
    <Segmented small aria={aria} value={value} options={Array.from({ length: SURFACE_RULE_BLOCK_LAYERS }, (_x, k) => ({ id: k, label: String(k + 1), hint: `Layer ${k + 1}` }))} onChange={onChange} />
  );
  return (
    <div className="tl-blocks__form" role="group" aria-label="material rules">
      <div className="tl-panel__title">Material rules</div>
      <p className="tl-hint">Rules apply top to bottom; a later rule paints over the ones above it. Where none applies, layer 1. Hand paint stays over them.</p>
      <MaterialRuleCards rules={draft} onChange={setDraft} selected={selected} onSelect={setSelected} blocks={p.blocks} layerField={four} layerName={(k) => `layer ${k + 1}`} height={p.height} disabled={p.disabled} />
      <div className="tl-inspector__modes">
        <button
          className="tl-btn tl-btn--small"
          aria-label="apply rules"
          disabled={!changed || busy || p.disabled === true}
          onClick={() => {
            setBusy(true);
            void p.onApply(draft).finally(() => setBusy(false));
          }}
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
        <button className="tl-btn tl-btn--small" aria-label="revert rules" disabled={!changed || busy} onClick={revert}>
          Revert
        </button>
      </div>
    </div>
  );
}
