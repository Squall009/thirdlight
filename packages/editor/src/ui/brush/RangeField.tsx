/**
 * The slider of a range: SliderField's row with two thumbs, for a condition
 * that holds between a low and a high end ("slope 35–90°"). A thumb dragged
 * to its end of the track leaves that end open ("over 35"); both open is
 * "any". The field takes typing too: "35–90", ">35", "<90" or "any".
 *
 * Browser-only (React).
 */
import { useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react';

import { parseRange, rangeText, stepDecimals, type RangeValue } from '../../session/rule-text';

export interface RangeFieldProps {
  label: string;
  /** The field's accessible name (default: the label in lower case). */
  aria?: string;
  value: RangeValue;
  /** The track's ends. */
  min: number;
  max: number;
  /** A step of the arrow keys and the drag. */
  step: number;
  unit?: string;
  disabled?: boolean;
  hint?: string;
  onChange: (value: RangeValue) => void;
}

export function RangeField(p: RangeFieldProps): JSX.Element {
  const track = useRef<HTMLSpanElement | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [drag, setDrag] = useState<'min' | 'max' | null>(null);
  const decimals = stepDecimals(p.step);
  const span = p.max - p.min;
  const lo = p.value.min ?? p.min;
  const hi = p.value.max ?? p.max;
  const frac = (v: number): number => Math.min(1, Math.max(0, (v - p.min) / span));
  const snap = (v: number): number => Number((Math.round(v / p.step) * p.step).toFixed(decimals + 2));
  const name = p.aria ?? p.label.toLowerCase();
  const set = (end: 'min' | 'max', v: number | undefined): void => {
    if (p.disabled === true) return;
    const next: RangeValue = { ...p.value };
    if (v === undefined) delete next[end];
    else next[end] = v;
    // The ends never cross: the other one moves along.
    if (next.min !== undefined && next.max !== undefined && next.min > next.max) {
      if (end === 'min') next.max = next.min;
      else next.min = next.max;
    }
    if (next.min !== p.value.min || next.max !== p.value.max) p.onChange(next);
  };
  /** A thumb at a value from the pointer: past its end of the track, that end is open. */
  const fromPointer = (end: 'min' | 'max', clientX: number): void => {
    const el = track.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const v = snap(p.min + t * span);
    if (end === 'min') set('min', v <= p.min ? undefined : v);
    else set('max', v >= p.max ? undefined : v);
  };
  const onDown = (e: PointerEvent<HTMLSpanElement>): void => {
    if (p.disabled === true || e.button !== 0) return;
    const el = track.current!;
    const r = el.getBoundingClientRect();
    const v = p.min + ((e.clientX - r.left) / r.width) * span;
    // The thumb nearer the pointer (the high one when they sit together and the pointer is past them).
    const end: 'min' | 'max' = Math.abs(v - lo) < Math.abs(v - hi) || (lo === hi && v < lo) ? 'min' : 'max';
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(end);
    fromPointer(end, e.clientX);
  };
  const onMove = (e: PointerEvent<HTMLSpanElement>): void => {
    if (drag !== null && e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(drag, e.clientX);
  };
  const onKey = (end: 'min' | 'max') => (e: KeyboardEvent<HTMLSpanElement>): void => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
    const at = end === 'min' ? lo : hi;
    if (e.key in steps) {
      const v = snap(Math.min(p.max, Math.max(p.min, at + steps[e.key]! * p.step)));
      set(end, end === 'min' ? (v <= p.min ? undefined : v) : v >= p.max ? undefined : v);
    } else if (e.key === 'Home' || e.key === 'End') set(end, undefined);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const finish = (): void => {
    if (text === null) return;
    const v = parseRange(text);
    setText(null);
    if (v !== null && p.disabled !== true) p.onChange(v);
  };
  const shown = rangeText(p.value, decimals);
  const keysHint = 'Drag a thumb (to the end: open), type 35–90, >35, <90 or any.';
  return (
    <div className={`tl-slider tl-range${p.value.min === undefined && p.value.max === undefined ? ' is-any' : ''}${p.disabled === true ? ' is-disabled' : ''}`} title={p.hint !== undefined ? `${p.hint} ${keysHint}` : keysHint}>
      <span className="tl-slider__label">{p.label}</span>
      <span ref={track} className="tl-slider__track" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => setDrag(null)}>
        <span className="tl-slider__fill" style={{ left: `${frac(lo) * 100}%`, width: `${(frac(hi) - frac(lo)) * 100}%` }} />
        {(['min', 'max'] as const).map((end) => (
          <span
            key={end}
            className={`tl-slider__thumb tl-range__thumb${(end === 'min' ? p.value.min : p.value.max) === undefined ? ' is-open' : ''}`}
            style={{ left: `${frac(end === 'min' ? lo : hi) * 100}%` }}
            role="slider"
            tabIndex={p.disabled === true ? -1 : 0}
            aria-label={`${name} ${end} slider`}
            aria-valuemin={p.min}
            aria-valuemax={p.max}
            aria-valuenow={end === 'min' ? lo : hi}
            aria-valuetext={(end === 'min' ? p.value.min : p.value.max) === undefined ? 'open' : undefined}
            onKeyDown={onKey(end)}
          />
        ))}
      </span>
      <span className="tl-slider__num">
        <input
          aria-label={name}
          type="text"
          disabled={p.disabled === true}
          value={text ?? shown}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              finish();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setText(null);
              e.currentTarget.blur();
              e.stopPropagation();
            }
          }}
        />
        {p.unit !== undefined && p.unit !== '' && <span className="tl-slider__unit">{p.unit}</span>}
      </span>
    </div>
  );
}
