/**
 * Phase 20.1: the editor widgets of the framework's `curve` and `gradient`
 * field types (GraphInspector uses them for any graph kind).
 *
 * - Curve: keys [t0, v0, t1, v1, …] (t 0–1 ascending, values within the
 *   field's range): a plot where keys are dragged (one edit on release), and
 *   a row per key (time, value, remove) plus "+ key" (a new key in the
 *   widest gap, on the line).
 * - Gradient: stops [t, r, g, b, a, …] (0–1): a preview bar over a checker
 *   (alpha shows), and a row per stop (time, colour, alpha, remove) plus
 *   "+ stop".
 *
 * Every change is one call of `onCommit` with the whole new value (the
 * host sends one `setNodeData`). Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';

const round = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Keys as pairs, sorted by time (stable). */
function pairs(v: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i]!, v[i + 1]!]);
  return out;
}
const flat = (ps: readonly [number, number][]): number[] => [...ps].sort((a, b) => a[0] - b[0]).flatMap(([t, y]) => [round(t), round(y)]);

export function CurveField({ label, value, min, max, onCommit }: { label: string; value: readonly number[]; min?: number; max?: number; onCommit: (v: number[]) => void }): JSX.Element {
  const keys = pairs(value);
  const [drag, setDrag] = useState<{ i: number; t: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const shown = drag === null ? keys : keys.map((k, i) => (i === drag.i ? ([drag.t, drag.y] as [number, number]) : k));
  // The plot's value range: the data, widened to 0–1 and clamped to the field's range.
  const ys = shown.map((k) => k[1]);
  let lo = Math.min(0, ...ys);
  let hi = Math.max(1, ...ys);
  if (min !== undefined) lo = Math.max(lo, min);
  if (max !== undefined) hi = Math.min(hi, max);
  if (hi - lo < 1e-6) hi = lo + 1;
  const W = 180;
  const H = 64;
  const px = (t: number): number => 4 + t * (W - 8);
  const py = (y: number): number => H - 4 - ((y - lo) / (hi - lo)) * (H - 8);
  const clampY = (y: number): number => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, y));
  const fromPointer = (e: ReactPointerEvent<SVGElement>): { t: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left - 4) / (r.width - 8)));
    const y = clampY(lo + ((r.height - 4 - (e.clientY - r.top)) / (r.height - 8)) * (hi - lo));
    return { t, y };
  };
  const commit = (ps: [number, number][]): void => onCommit(flat(ps));
  const addKey = (): void => {
    // The widest gap between keys (or after the last / before the first) gets a key on the line.
    const sorted = [...keys].sort((a, b) => a[0] - b[0]);
    let best = { gap: -1, t: 0.5, y: 0 };
    const bounds: [number, number][] = [[0, sorted[0]?.[1] ?? 0], ...sorted, [1, sorted[sorted.length - 1]?.[1] ?? 0]];
    for (let i = 1; i < bounds.length; i++) {
      const gap = bounds[i]![0] - bounds[i - 1]![0];
      if (gap > best.gap) best = { gap, t: (bounds[i]![0] + bounds[i - 1]![0]) / 2, y: (bounds[i]![1] + bounds[i - 1]![1]) / 2 };
    }
    commit([...keys, [best.t, clampY(best.y)]]);
  };
  return (
    <div className="tl-curve" aria-label={`${label} curve`}>
      <svg
        ref={svgRef}
        className="tl-curve__plot"
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`${label} plot`}
        onPointerMove={(e) => drag !== null && setDrag({ i: drag.i, ...fromPointer(e) })}
        onPointerUp={() => {
          if (drag === null) return;
          const next = keys.map((k, i) => (i === drag.i ? ([drag.t, drag.y] as [number, number]) : k));
          setDrag(null);
          commit(next);
        }}
      >
        <rect x={0} y={0} width={W} height={H} className="tl-curve__bg" />
        {lo < 0 && hi > 0 && <line x1={4} x2={W - 4} y1={py(0)} y2={py(0)} className="tl-curve__axis" />}
        <polyline className="tl-curve__line" fill="none" points={[...shown].sort((a, b) => a[0] - b[0]).map(([t, y]) => `${px(t)},${py(y)}`).join(' ')} />
        {shown.map(([t, y], i) => (
          <circle
            key={i}
            cx={px(t)}
            cy={py(y)}
            r={4}
            className="tl-curve__key"
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setDrag({ i, t, y });
            }}
          />
        ))}
      </svg>
      {keys.map(([t, y], i) => (
        <div className="tl-curve__row" key={i}>
          <Num label={`${label} key ${i + 1} time`} value={t} min={0} max={1} onCommit={(n) => commit(keys.map((k, j) => (j === i ? [n, k[1]] : k)))} />
          <Num label={`${label} key ${i + 1} value`} value={y} {...(min !== undefined ? { min } : {})} {...(max !== undefined ? { max } : {})} onCommit={(n) => commit(keys.map((k, j) => (j === i ? [k[0], n] : k)))} />
          {keys.length > 2 && (
            <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${label} key ${i + 1}`} onClick={() => commit(keys.filter((_, j) => j !== i))}>
              ✕
            </button>
          )}
        </div>
      ))}
      {keys.length < 16 && (
        <button type="button" className="tl-btn tl-btn--small" aria-label={`add ${label} key`} onClick={addKey}>
          + key
        </button>
      )}
    </div>
  );
}

const hex2 = (x: number): string => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
const toHex = (r: number, g: number, b: number): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const fromHex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

type Stop = [number, number, number, number, number];
function stopsOf(v: readonly number[]): Stop[] {
  const out: Stop[] = [];
  for (let i = 0; i + 4 < v.length; i += 5) out.push([v[i]!, v[i + 1]!, v[i + 2]!, v[i + 3]!, v[i + 4]!]);
  return out;
}

export function GradientField({ label, value, onCommit }: { label: string; value: readonly number[]; onCommit: (v: number[]) => void }): JSX.Element {
  const stops = stopsOf(value);
  const commit = (s: Stop[]): void => onCommit([...s].sort((a, b) => a[0] - b[0]).flatMap((x) => x.map(round)));
  const css = stops.length === 1 ? `rgba(${stops[0]!.slice(1, 4).map((c) => Math.round(c * 255)).join(',')},${stops[0]![4]})` : `linear-gradient(to right, ${stops.map((s) => `rgba(${Math.round(s[1] * 255)},${Math.round(s[2] * 255)},${Math.round(s[3] * 255)},${s[4]}) ${round(s[0] * 100)}%`).join(', ')})`;
  const addStop = (): void => {
    const sorted = [...stops].sort((a, b) => a[0] - b[0]);
    let best: Stop = [0.5, 1, 1, 1, 1];
    let gap = -1;
    for (let i = 1; i < sorted.length; i++) {
      const g = sorted[i]![0] - sorted[i - 1]![0];
      if (g > gap) {
        gap = g;
        const a = sorted[i - 1]!;
        const b = sorted[i]!;
        best = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, (a[3] + b[3]) / 2, (a[4] + b[4]) / 2];
      }
    }
    if (sorted.length === 1) best = [sorted[0]![0] < 0.5 ? 1 : 0, sorted[0]![1], sorted[0]![2], sorted[0]![3], sorted[0]![4]];
    commit([...stops, best]);
  };
  return (
    <div className="tl-gradient" aria-label={`${label} gradient`}>
      <div className="tl-gradient__bar" role="img" aria-label={`${label} preview`}>
        <div style={{ background: css }} />
      </div>
      {stops.map((s, i) => (
        <div className="tl-curve__row" key={i}>
          <Num label={`${label} stop ${i + 1} time`} value={s[0]} min={0} max={1} onCommit={(n) => commit(stops.map((x, j) => (j === i ? [n, x[1], x[2], x[3], x[4]] : x)))} />
          <input type="color" aria-label={`${label} stop ${i + 1} colour`} value={toHex(s[1], s[2], s[3])} onChange={(e) => commit(stops.map((x, j) => (j === i ? [x[0], ...fromHex(e.target.value), x[4]] : x)))} />
          <Num label={`${label} stop ${i + 1} alpha`} value={s[4]} min={0} max={1} onCommit={(n) => commit(stops.map((x, j) => (j === i ? [x[0], x[1], x[2], x[3], n] : x)))} />
          {stops.length > 1 && (
            <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${label} stop ${i + 1}`} onClick={() => commit(stops.filter((_, j) => j !== i))}>
              ✕
            </button>
          )}
        </div>
      ))}
      {stops.length < 8 && (
        <button type="button" className="tl-btn tl-btn--small" aria-label={`add ${label} stop`} onClick={addStop}>
          + stop
        </button>
      )}
    </div>
  );
}

/** A number input committed on Enter or blur (refused values snap back). */
function Num({ label, value, min, max, onCommit }: { label: string; value: number; min?: number; max?: number; onCommit: (v: number) => void }): JSX.Element {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
      setText(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return <input className="tl-input tl-input--num" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}
