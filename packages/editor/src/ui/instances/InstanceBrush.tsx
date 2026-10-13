/**
 * The instance brush in the Inspector of a selected instance set: Paint or
 * Erase in the Scene view, on the shared brush kit — the brush panel's size
 * (and X switching paint and erase, Ctrl held erasing one stroke, F then a
 * drag resizing in the view, the shared cursor) — and the copies' own
 * settings on the shared sliders (density, spacing, random scale and turn,
 * alignment to the surface, seed). The settings are remembered per browser;
 * the brush goes off with another selection.
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import type { InstanceBrush } from '@thirdlight/project-model';
import { INSTANCE_BRUSH_DEFAULTS, INSTANCE_BRUSH_LIMITS, instanceStrokeError } from '@thirdlight/runtime';

import type { BrushStore } from '../../session/brush';
import { INSTANCE_BRUSH_USES, instanceBrushStore } from '../../session/instance-brush';
import { BrushPanel } from '../brush/BrushPanel';
import { SliderField } from '../brush/SliderField';
import { useBrush } from '../brush/useBrush';
import { SeedField } from '../rules/RuleConditions';

export type InstanceBrushModeState = 'off' | 'paint' | 'erase';

const KEY = 'thirdlight.instanceBrush.v1';

/** The copies' own settings remembered (the footprint is the shared brush's size). */
function stored(): InstanceBrush {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as unknown;
    const b = { ...INSTANCE_BRUSH_DEFAULTS, ...(typeof v === 'object' && v !== null ? v : {}) } as InstanceBrush;
    return instanceStrokeError({ mode: 'paint', dabs: [[0, 0, 0]], brush: b }) === null ? b : { ...INSTANCE_BRUSH_DEFAULTS };
  } catch {
    return { ...INSTANCE_BRUSH_DEFAULTS };
  }
}

/** The brush for the selected set (`selectedId`): on or off, paint or erase (the shared brush's invert), its settings. */
export function useInstanceBrush(selectedId: string | null): { mode: InstanceBrushModeState; setMode: (m: InstanceBrushModeState) => void; brush: InstanceBrush; setBrush: (b: InstanceBrush) => void; store: BrushStore } {
  const store = instanceBrushStore();
  const settings = useBrush(store);
  const [on, setOn] = useState(false);
  const [brush, setBrushState] = useState<InstanceBrush>(stored);
  useEffect(() => setOn(false), [selectedId]);
  const setBrush = useCallback((b: InstanceBrush) => {
    setBrushState(b);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(b));
    } catch {
      // A browser without storage keeps the settings for this page only.
    }
  }, []);
  const setMode = useCallback(
    (m: InstanceBrushModeState) => {
      setOn(m !== 'off');
      if (m !== 'off') store.set({ invert: m === 'erase' });
    },
    [store],
  );
  const mode: InstanceBrushModeState = !on ? 'off' : settings.invert ? 'erase' : 'paint';
  return { mode, setMode, brush, setBrush, store };
}

const L = INSTANCE_BRUSH_LIMITS;

/** The brush controls: Paint / Erase, the shared brush panel (size), the copies' settings. */
export function InstanceBrushPanel(props: { mode: InstanceBrushModeState; setMode: (m: InstanceBrushModeState) => void; brush: InstanceBrush; setBrush: (b: InstanceBrush) => void; store: BrushStore }): JSX.Element {
  const { mode, setMode, brush, setBrush, store } = props;
  const settings = useBrush(store);
  /** The brush with some fields changed, when it is still one the command takes. */
  const set = (patch: Partial<InstanceBrush>): void => {
    const next = { ...brush, ...patch };
    if (instanceStrokeError({ mode: 'paint', dabs: [[0, 0, 0]], brush: next }) === null) setBrush(next);
  };
  return (
    <div className="tl-instance-brush" data-mode={mode}>
      <div className="tl-inspector__modes" role="group" aria-label="instance brush">
        <button className="tl-btn" aria-pressed={mode === 'paint'} title="Drag in the Scene view to paint copies onto block layers and objects with a collider; each stroke is one undo step" onClick={() => setMode(mode === 'paint' ? 'off' : 'paint')}>
          Paint
        </button>
        <button className="tl-btn" aria-pressed={mode === 'erase'} title="Drag in the Scene view to erase the copies under the brush (X switches; Ctrl held erases one stroke); each stroke is one undo step" onClick={() => setMode(mode === 'erase' ? 'off' : 'erase')}>
          Erase
        </button>
      </div>
      <BrushPanel settings={settings} store={store} uses={INSTANCE_BRUSH_USES.filter((u) => u !== 'invert')} />
      <div className="tl-instance-brush__fields" aria-label="copies">
        <SliderField label="Density" aria="instance brush density" value={brush.density} min={0.05} max={20} log limit={[L.density.min, L.density.max]} step={0.01} unit="/m²" hint="Copies per square metre the brush aims for." onChange={(v) => set({ density: v })} />
        <SliderField label="Spacing" aria="instance brush spacing" value={brush.spacing} min={0} max={5} limit={[L.spacing.min, L.spacing.max]} step={0.05} unit="m" hint="No two copies closer than this across the ground." onChange={(v) => set({ spacing: v })} />
        <SliderField label="Scale min" aria="instance brush scale min" value={brush.scale[0]} min={0.1} max={4} log limit={[L.scale.min, L.scale.max]} step={0.01} hint="Each copy gets a random size between min and max." onChange={(v) => set({ scale: [v, Math.max(v, brush.scale[1])] })} />
        <SliderField label="Scale max" aria="instance brush scale max" value={brush.scale[1]} min={0.1} max={4} log limit={[L.scale.min, L.scale.max]} step={0.01} hint="Each copy gets a random size between min and max." onChange={(v) => set({ scale: [Math.min(brush.scale[0], v), v] })} />
        <SliderField label="Rotation" aria="instance brush rotation" value={brush.yaw} min={L.yaw.min} max={L.yaw.max} step={15} unit="°" hint="Each copy turns about its up axis by a random angle from 0 to this." onChange={(v) => set({ yaw: v })} />
        <SliderField label="Align" aria="instance brush align" value={brush.align} min={L.align.min} max={L.align.max} step={1} scale={100} unit="%" hint="How far copies lean to the surface: 0 upright, 100 % along its normal." onChange={(v) => set({ align: v })} />
        <SeedField aria="instance brush seed" value={brush.seed} onChange={(n) => set({ seed: n })} />
      </div>
      {mode !== 'off' && (
        <p className="tl-inspector__hint">
          Scene view: drag to {mode} (X switches, Alt+drag orbits, [ ] size, F then drag resizes); Esc drops the stroke. At most {L.samples} places a stroke: a longer drag goes on as the next stroke.
        </p>
      )}
    </div>
  );
}
