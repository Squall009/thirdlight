/**
 * The conditions material and scatter rules share (`RuleConditions`: slope,
 * height, cavity, a noise mask), as rows of a rule's card: each a range
 * slider (any = the condition is off), its softness (how far past an end it
 * fades) once it has an end, and its own settings (the cavity's radius, the
 * noise's size and seed). Then the layer conditions: "only where layer N is
 * between …", each layer picked from the palette.
 *
 * Material rules and scatter rules show the same rows, so a slope reads and
 * edits the same in both.
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';
import { SURFACE_RULE_CAVITY_RADIUS, type RuleRange } from '@thirdlight/runtime';

import { RangeField } from '../brush/RangeField';
import { SliderField } from '../brush/SliderField';
import { Glyph } from '../editmode/glyphs';

type Range = RuleRange & Record<string, number>;

/** One shared condition: its key, label, unit, help, the slider's track and its softness's, its own settings. */
interface ConditionSpec {
  key: 'slope' | 'height' | 'cavity' | 'noise';
  label: string;
  unit: string;
  title: string;
  track: readonly [number, number];
  step: number;
  /** The softness given when an end is first set. */
  fade: number;
  fadeMax: number;
  /** What it adds besides the range, set when the condition is turned on. */
  extra?: Record<string, number>;
}

const CONDITIONS = (height: readonly [number, number]): readonly ConditionSpec[] => [
  { key: 'slope', label: 'Slope', unit: '°', title: 'Degrees from level: 0 is flat, 90 a wall.', track: [0, 90], step: 1, fade: 4, fadeMax: 45 },
  { key: 'height', label: 'Height', unit: 'm', title: 'World height in metres.', track: height, step: 0.5, fade: 2, fadeMax: Math.max(10, (height[1] - height[0]) / 4) },
  { key: 'cavity', label: 'Cavity', unit: 'm', title: 'How far the ground around lies above the point: positive in hollows, negative on ridges.', track: [-2, 2], step: 0.05, fade: 0.2, fadeMax: 2, extra: { radius: SURFACE_RULE_CAVITY_RADIUS } },
  { key: 'noise', label: 'Noise', unit: '', title: 'A noise pattern over the world (0–1): a range of it breaks a rule\'s edge into patches.', track: [0, 1], step: 0.01, fade: 0.1, fadeMax: 0.5, extra: { scale: 8, seed: 0 } },
];

/** A condition after its range changed: off when both ends are open, its softness and settings kept. */
function withRange(spec: ConditionSpec, old: Range | undefined, v: { min?: number; max?: number }): Range | undefined {
  if (v.min === undefined && v.max === undefined) return undefined;
  const out: Range = { ...(spec.extra ?? {}), ...(old ?? {}), fade: old?.fade ?? spec.fade } as Range;
  delete out.min;
  delete out.max;
  if (v.min !== undefined) out.min = v.min;
  if (v.max !== undefined) out.max = v.max;
  return out;
}

export interface RuleConditionsProps {
  /** The rule's prefix for accessible names ("rule 2", "scatter 1"). */
  prefix: string;
  /** The rule as a record of its conditions. */
  rule: Readonly<Record<string, unknown>>;
  /** The height slider's track (world metres). */
  height: readonly [number, number];
  set: (key: string, value: unknown) => void;
  disabled?: boolean;
}

/** The shared conditions' rows. */
export function RuleConditions(p: RuleConditionsProps): JSX.Element {
  return (
    <>
      {CONDITIONS(p.height).map((c) => {
        const v = p.rule[c.key] as Range | undefined;
        const name = `${p.prefix} ${c.key}`;
        const on = v !== undefined && (v.min !== undefined || v.max !== undefined);
        const patch = (k: string, n: number): void => p.set(c.key, { ...v, [k]: n });
        return (
          <div key={c.key} className="tl-cond" role="group" aria-label={`${name} condition`}>
            <RangeField label={c.label} aria={name} value={{ ...(v?.min !== undefined ? { min: v.min } : {}), ...(v?.max !== undefined ? { max: v.max } : {}) }} min={c.track[0]} max={c.track[1]} step={c.step} unit={c.unit} hint={c.title} disabled={p.disabled} onChange={(r) => p.set(c.key, withRange(c, v, r))} />
            {on && (
              <SliderField label="softness" aria={`${name} softness`} value={v.fade ?? 0} min={0} max={c.fadeMax} limit={[0, 100_000]} step={c.step} unit={c.unit} hint="How far past an end the rule fades out (0: a hard edge)." disabled={p.disabled} onChange={(n) => patch('fade', n)} />
            )}
            {on && c.key === 'cavity' && (
              <SliderField label="measured over" aria={`${name} radius`} value={v.radius ?? SURFACE_RULE_CAVITY_RADIUS} min={0.5} max={32} limit={[0.05, 64]} step={0.5} unit="m" hint="Metres around the point the ground is compared over." disabled={p.disabled} onChange={(n) => patch('radius', n)} />
            )}
            {on && c.key === 'noise' && (
              <>
                <SliderField label="patch size" aria={`${name} size`} value={v.scale ?? 8} min={0.5} max={256} log limit={[0.01, 100_000]} step={0.5} unit="m" hint="Metres between the noise's patches." disabled={p.disabled} onChange={(n) => patch('scale', n)} />
                <SeedField aria={`${name} seed`} value={v.seed ?? 0} disabled={p.disabled} onChange={(n) => patch('seed', n)} />
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

/** A whole-number seed with a die that rolls a new one. */
export function SeedField({ aria, value, onChange, disabled, label = 'seed' }: { aria: string; value: number; onChange: (n: number) => void; disabled?: boolean; label?: string }): JSX.Element {
  return (
    <div className="tl-frow">
      <span className="tl-frow__label">{label}</span>
      <input
        className="tl-num"
        aria-label={aria}
        type="text"
        inputMode="numeric"
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isSafeInteger(n)) onChange(n);
        }}
      />
      <button type="button" className="tl-iconbtn" aria-label={`new ${aria}`} title="A new seed: another pattern" disabled={disabled} onClick={() => onChange(Math.floor(Math.random() * 100_000))}>
        <Glyph name="dice" size={16} />
      </button>
    </div>
  );
}

/** One layer condition: a layer and the share of it the ground shows. */
export interface LayerCondition extends RuleRange {
  layer: number;
}

/**
 * Layer conditions: each a layer (picked from the palette by `layerField`)
 * and the share (0–1) of it, with a way to add and remove them. `single`:
 * at most one (a material rule's "weight").
 */
export function LayerConditions(p: { prefix: string; list: readonly LayerCondition[]; onChange: (list: LayerCondition[]) => void; layerField: (value: number, onChange: (layer: number) => void, aria: string) => ReactNode; single?: boolean; title: string; disabled?: boolean }): JSX.Element {
  const put = (i: number, c: LayerCondition | null): void => p.onChange(c === null ? p.list.filter((_x, k) => k !== i) : p.list.map((x, k) => (k === i ? c : x)));
  return (
    <div className="tl-cond" role="group" aria-label={`${p.prefix} layers`}>
      {p.list.map((c, i) => {
        const name = `${p.prefix} layers ${i + 1}`;
        return (
          <div key={i} className="tl-layercond">
            <div className="tl-frow">
              <span className="tl-frow__label">{p.title}</span>
              {p.layerField(c.layer, (layer) => put(i, { ...c, layer }), `${name} layer`)}
              <button type="button" className="tl-iconbtn" aria-label={`remove ${name}`} title="Remove the condition" disabled={p.disabled} onClick={() => put(i, null)}>
                <Glyph name="trash" size={15} />
              </button>
            </div>
            <RangeField label="share" aria={`${name} share`} value={{ ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) }} min={0} max={1} step={0.05} hint="How much of the layer the ground shows there (0–1)." disabled={p.disabled} onChange={(r) => put(i, { layer: c.layer, ...r, ...(c.fade !== undefined ? { fade: c.fade } : {}) })} />
            <SliderField label="softness" aria={`${name} softness`} value={c.fade ?? 0} min={0} max={0.5} step={0.05} hint="How far past an end it fades out." disabled={p.disabled} onChange={(n) => put(i, { ...c, fade: n })} />
          </div>
        );
      })}
      {(p.single !== true || p.list.length === 0) && (
        <button type="button" className="tl-addrow" aria-label={`${p.prefix} add layer condition`} disabled={p.disabled} onClick={() => p.onChange([...p.list, { layer: 0, min: 0.5, fade: 0.1 }])}>
          <Glyph name="plus" size={14} /> Layer condition
        </button>
      )}
    </div>
  );
}
