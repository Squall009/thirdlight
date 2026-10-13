/**
 * The small fields of Rooms & buildings' column: a number committed on
 * Enter or blur (empty: the default, shown as its placeholder), a text, and
 * a picker that keeps showing a value no longer offered ("(missing)").
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';

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

export function Pick(props: { label: string; value: string; options: readonly (readonly [string, string])[]; onCommit: (v: string) => void }): JSX.Element {
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <select className="tl-input" aria-label={props.label} value={props.value} onChange={(e) => props.onCommit(e.target.value)}>
        {!props.options.some(([v]) => v === props.value) && <option value={props.value}>{props.value} (missing)</option>}
        {props.options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
