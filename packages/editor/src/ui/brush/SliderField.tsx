/**
 * The one slider of the edit modes: a label, a track with its fill and
 * thumb, and a number field with the unit. Typing, dragging the track, the
 * mouse wheel over it and the arrow keys all edit it; the tooltip says how.
 *
 * The value is the setting's own (a strength 0–1); `scale` shows it in the
 * field's unit (100: a percentage). The track spans `min`–`max` (on a log
 * scale for sizes, where small and large both need room); typed values may
 * go to `limit`, past the track.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react';

export interface SliderFieldProps {
  label: string;
  /** The field's accessible name (default: the label in lower case). */
  aria?: string;
  value: number;
  /** The track's ends (the setting's own units). */
  min: number;
  max: number;
  /** A step of the arrow keys and the wheel, in the field's units (after `scale`). */
  step: number;
  /** What typing may reach (default: the track's ends). */
  limit?: readonly [number, number];
  /** The field's unit ("m", "%"). */
  unit?: string;
  /** Field units per setting unit (100: a 0–1 setting shown as a percentage). */
  scale?: number;
  /** Decimals the field shows (default: from the step). */
  decimals?: number;
  /** The track on a log scale (sizes). */
  log?: boolean;
  /** The brush colour on the fill (the brush's size and strength). */
  accent?: boolean;
  disabled?: boolean;
  /** The tooltip: what the setting does and its keys. */
  hint?: string;
  onChange: (value: number) => void;
}

const decimalsOf = (step: number): number => (Number.isInteger(step) ? 0 : Math.min(4, String(step).split('.')[1]?.length ?? 1));

export function SliderField(p: SliderFieldProps): JSX.Element {
  const scale = p.scale ?? 1;
  const [lo, hi] = p.limit ?? [p.min, p.max];
  const decimals = p.decimals ?? decimalsOf(p.step);
  const [text, setText] = useState<string | null>(null);
  const track = useRef<HTMLSpanElement | null>(null);
  const latest = useRef(p);
  latest.current = p;

  const clampV = (v: number): number => Math.min(hi, Math.max(lo, v));
  const toFrac = (v: number): number => {
    const t = p.log === true ? Math.log(Math.max(v, p.min) / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min);
    return Math.min(1, Math.max(0, t));
  };
  const fromFrac = (t: number): number => (p.log === true ? p.min * Math.pow(p.max / p.min, t) : p.min + t * (p.max - p.min));
  // On the field's step grid, so a drag lands on values the field shows.
  const snap = (v: number): number => {
    const shown = Math.round((v * scale) / p.step) * p.step;
    return clampV(Number((shown / scale).toFixed(decimals + 3)));
  };
  const commit = (v: number): void => {
    if (!Number.isFinite(v) || p.disabled === true) return;
    const next = clampV(v);
    if (next !== p.value) p.onChange(next);
  };
  const nudge = (steps: number): void => commit(snap(p.value + (steps * p.step) / scale));

  // The wheel over the slider nudges it (a native listener: React's wheel is passive and may not hold the page still).
  const row = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = row.current;
    if (el === null) return undefined;
    const onWheel = (e: WheelEvent): void => {
      const q = latest.current;
      if (q.disabled === true || e.deltaY === 0) return;
      e.preventDefault();
      const s = q.scale ?? 1;
      const [a, b] = q.limit ?? [q.min, q.max];
      const v = q.value + (Math.sign(-e.deltaY) * q.step) / s;
      const next = Math.min(b, Math.max(a, Number((Math.round((v * s) / q.step) * q.step / s).toFixed(8))));
      if (next !== q.value) q.onChange(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const fromPointer = (clientX: number): void => {
    const el = track.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    commit(snap(fromFrac(Math.min(1, Math.max(0, (clientX - r.left) / r.width)))));
  };
  const onPointerDown = (e: PointerEvent<HTMLSpanElement>): void => {
    if (p.disabled === true || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    fromPointer(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.clientX);
  };
  const onKey = (e: KeyboardEvent<HTMLSpanElement>): void => {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
    if (e.key in steps) nudge(steps[e.key]!);
    else if (e.key === 'Home') commit(p.min);
    else if (e.key === 'End') commit(p.max);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const name = p.aria ?? p.label.toLowerCase();
  const shown = (p.value * scale).toFixed(decimals);
  const frac = toFrac(p.value);
  const keysHint = 'Drag, type, scroll or use the arrow keys.';
  const finish = (): void => {
    if (text === null) return;
    const v = Number(text.replace(',', '.'));
    setText(null);
    if (text.trim() !== '' && Number.isFinite(v)) commit(v / scale);
  };
  return (
    <div ref={row} className={`tl-slider${p.accent === true ? ' is-accent' : ''}${p.disabled === true ? ' is-disabled' : ''}`} title={p.hint !== undefined ? `${p.hint} ${keysHint}` : keysHint}>
      <span className="tl-slider__label">{p.label}</span>
      <span
        ref={track}
        className="tl-slider__track"
        role="slider"
        tabIndex={p.disabled === true ? -1 : 0}
        aria-label={`${name} slider`}
        aria-valuemin={p.min * scale}
        aria-valuemax={p.max * scale}
        aria-valuenow={Number(shown)}
        aria-disabled={p.disabled === true}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKey}
      >
        <span className="tl-slider__fill" style={{ width: `${frac * 100}%` }} />
        <span className="tl-slider__thumb" style={{ left: `${frac * 100}%` }} />
      </span>
      <span className="tl-slider__num">
        <input
          aria-label={name}
          type="text"
          inputMode="decimal"
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
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              setText(null);
              nudge(e.key === 'ArrowUp' ? 1 : -1);
            }
          }}
        />
        {p.unit !== undefined && <span className="tl-slider__unit">{p.unit}</span>}
      </span>
    </div>
  );
}
