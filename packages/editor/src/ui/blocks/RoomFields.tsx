/**
 * The small fields of Rooms & buildings' column: a number committed on
 * Enter or blur (empty: the default, shown as its placeholder), a text, and
 * a picker that keeps showing a value no longer offered ("(missing)") and
 * lists grouped choices under their headings.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';

import type { PickOption } from '../architecture/preset-choices';

export function Num(props: { label: string; value: number | undefined; min?: number; max?: number; step?: number; placeholder?: string; onCommit: (v: number | undefined) => void }): JSX.Element {
  const [draft, setDraft] = useState(props.value === undefined ? '' : String(props.value));
  useEffect(() => setDraft(props.value === undefined ? '' : String(props.value)), [props.value]);
  const commit = (): void => {
    const v = draft.trim() === '' ? undefined : Number(draft);
    if (v !== undefined && !Number.isFinite(v)) return setDraft(props.value === undefined ? '' : String(props.value));
    const c = v === undefined ? undefined : Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
    if (c !== props.value) props.onCommit(c);
  };
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <input className="tl-input tl-input--num" aria-label={props.label} type="number" step={props.step ?? 0.1} placeholder={props.placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

export function Text(props: { label: string; value: string; placeholder?: string; onCommit: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = (): void => {
    if (draft.trim() !== props.value) props.onCommit(draft.trim());
  };
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <input className="tl-input" aria-label={props.label} placeholder={props.placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

/** Consecutive choices of one group, under its heading (null: ungrouped). */
function runsOf(options: readonly PickOption[]): { group: string | null; options: PickOption[] }[] {
  const runs: { group: string | null; options: PickOption[] }[] = [];
  for (const o of options) {
    const group = o[2] ?? null;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.group === group) last.options.push(o);
    else runs.push({ group, options: [o] });
  }
  return runs;
}

/** A native picker; choices with a group are listed under its heading (an optgroup). */
export function Pick(props: { label: string; value: string; options: readonly PickOption[]; onCommit: (v: string) => void }): JSX.Element {
  const item = ([v, text]: PickOption): JSX.Element => (
    <option key={v} value={v}>
      {text}
    </option>
  );
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <select className="tl-input" aria-label={props.label} value={props.value} onChange={(e) => props.onCommit(e.target.value)}>
        {!props.options.some(([v]) => v === props.value) && <option value={props.value}>{props.value} (missing)</option>}
        {runsOf(props.options).map((r, i) =>
          r.group === null ? (
            r.options.map(item)
          ) : (
            <optgroup key={`${i}:${r.group}`} label={r.group}>
              {r.options.map(item)}
            </optgroup>
          ),
        )}
      </select>
    </label>
  );
}
