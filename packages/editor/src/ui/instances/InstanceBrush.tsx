/**
 * The instance brush in the Inspector of a selected instance set: Paint or
 * Erase in the Scene view, and the brush's settings (radius, density,
 * spacing, random scale and turn, alignment to the surface, seed). The
 * settings are remembered per browser; the mode goes off with another
 * selection.
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { InstanceBrush } from '@thirdlight/project-model';
import { INSTANCE_BRUSH_DEFAULTS, INSTANCE_BRUSH_LIMITS, instanceStrokeError } from '@thirdlight/runtime';

export type InstanceBrushModeState = 'off' | 'paint' | 'erase';

const KEY = 'thirdlight.instanceBrush.v1';

function stored(): InstanceBrush {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as unknown;
    const b = { ...INSTANCE_BRUSH_DEFAULTS, ...(typeof v === 'object' && v !== null ? v : {}) } as InstanceBrush;
    return instanceStrokeError({ mode: 'paint', dabs: [[0, 0, 0]], brush: b }) === null ? b : { ...INSTANCE_BRUSH_DEFAULTS };
  } catch {
    return { ...INSTANCE_BRUSH_DEFAULTS };
  }
}

/** The brush's mode and settings for the selected set (`selectedId`). */
export function useInstanceBrush(selectedId: string | null): { mode: InstanceBrushModeState; setMode: (m: InstanceBrushModeState) => void; brush: InstanceBrush; setBrush: (b: InstanceBrush) => void } {
  const [mode, setMode] = useState<InstanceBrushModeState>('off');
  const [brush, setBrushState] = useState<InstanceBrush>(stored);
  useEffect(() => setMode('off'), [selectedId]);
  const setBrush = useCallback((b: InstanceBrush) => {
    setBrushState(b);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(b));
    } catch {
      // A browser without storage keeps the settings for this page only.
    }
  }, []);
  return { mode, setMode, brush, setBrush };
}

type FieldKey = 'radius' | 'density' | 'spacing' | 'yaw' | 'align' | 'scaleMin' | 'scaleMax' | 'seed';
const FIELDS: { key: FieldKey; label: string; title: string; step: number }[] = [
  { key: 'radius', label: 'Radius', title: 'The brush radius in metres.', step: 0.25 },
  { key: 'density', label: 'Density', title: 'Copies per square metre the brush aims for.', step: 0.1 },
  { key: 'spacing', label: 'Spacing', title: 'No two copies closer than this across the ground (metres).', step: 0.1 },
  { key: 'scaleMin', label: 'Scale min', title: 'Each copy gets a random size between min and max.', step: 0.05 },
  { key: 'scaleMax', label: 'Scale max', title: 'Each copy gets a random size between min and max.', step: 0.05 },
  { key: 'yaw', label: 'Rotation', title: 'Each copy turns about its up axis by a random angle from 0 to this many degrees.', step: 15 },
  { key: 'align', label: 'Align', title: 'How far copies lean to the surface: 0 upright, 1 along its normal.', step: 0.1 },
  { key: 'seed', label: 'Seed', title: 'The same stroke with the same seed gives the same copies; another seed other places, sizes and turns.', step: 1 },
];

/** The brush controls (Paint / Erase and the settings). */
export function InstanceBrushPanel(props: { mode: InstanceBrushModeState; setMode: (m: InstanceBrushModeState) => void; brush: InstanceBrush; setBrush: (b: InstanceBrush) => void }): JSX.Element {
  const { mode, setMode, brush, setBrush } = props;
  const valueOf = (key: FieldKey): number => (key === 'scaleMin' ? brush.scale[0] : key === 'scaleMax' ? brush.scale[1] : brush[key]);
  /** The brush with one field changed (null: not a value the brush takes). */
  const withValue = (key: FieldKey, v: number): InstanceBrush | null => {
    const next: InstanceBrush =
      key === 'scaleMin' ? { ...brush, scale: [v, Math.max(v, brush.scale[1])] } : key === 'scaleMax' ? { ...brush, scale: [Math.min(brush.scale[0], v), v] } : { ...brush, [key]: v };
    return instanceStrokeError({ mode: 'paint', dabs: [[0, 0, 0]], brush: next }) === null ? next : null;
  };
  return (
    <div className="tl-instance-brush" data-mode={mode}>
      <div className="tl-inspector__modes" role="group" aria-label="instance brush">
        <button className="tl-btn" aria-pressed={mode === 'paint'} title="Drag in the Scene view to paint copies onto block layers and objects with a collider; each stroke is one undo step" onClick={() => setMode(mode === 'paint' ? 'off' : 'paint')}>
          Paint
        </button>
        <button className="tl-btn" aria-pressed={mode === 'erase'} title="Drag in the Scene view to erase the copies under the brush; each stroke is one undo step" onClick={() => setMode(mode === 'erase' ? 'off' : 'erase')}>
          Erase
        </button>
      </div>
      <div className="tl-instance-brush__fields">
        {FIELDS.map((f) => (
          <BrushNumber key={f.key} field={f} value={valueOf(f.key)} accept={(v) => withValue(f.key, v)} onValue={setBrush} />
        ))}
      </div>
      {mode !== 'off' && <p className="tl-inspector__hint">Scene view: drag to {mode} (Alt+drag orbits); Esc drops the stroke. At most {INSTANCE_BRUSH_LIMITS.samples} places a stroke: a longer drag goes on as the next stroke.</p>}
    </div>
  );
}

/** One setting: typed freely, taken when it is a value the brush accepts, shown as stored when left. */
function BrushNumber(props: { field: (typeof FIELDS)[number]; value: number; accept: (v: number) => InstanceBrush | null; onValue: (b: InstanceBrush) => void }): JSX.Element {
  const { field, value, accept, onValue } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const bad = draft !== null && (draft.trim() === '' || !Number.isFinite(Number(draft)) || accept(Number(draft)) === null);
  return (
    <label title={field.title}>
      {field.label}{' '}
      <input
        aria-label={`instance brush ${field.label.toLowerCase()}`}
        aria-invalid={bad}
        type="number"
        className="tl-blocks__num"
        step={field.step}
        value={draft ?? String(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          const next = e.target.value.trim() === '' ? null : accept(Number(e.target.value));
          if (next !== null) onValue(next);
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}
