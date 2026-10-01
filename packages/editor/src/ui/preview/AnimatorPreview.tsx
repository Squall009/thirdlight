/**
 * The preview pane's animator controls — the controller runs on its model in
 * the pane (the runtime's own state machine posing it each frame), with the
 * playback speed and the parameters as sliders, checkboxes and trigger
 * buttons (nothing saved). An edited controller restarts the preview with the
 * values kept; the editor-only layout does not restart it. The readout
 * element carries the current states and clip time (tests read them).
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { AnimatorParameter } from '@thirdlight/project-model';

import { ModelSubject } from '../../viewport/preview-subjects';
import type { AnimatorPreview as RunningPreview } from '../animator/parts';
import { useSubject, type PreviewControlsProps } from './use-subject';
import type { PreviewRenderer } from '../../viewport/preview-renderer';

/** How often the readout follows the running controller (ms). */
const READOUT_INTERVAL_MS = 100;

export function AnimatorPreview({ renderer, request, deps }: PreviewControlsProps<'animator'>): JSX.Element {
  const controller = request.controller;
  // The game's view of the controller (the editor-only layout does not restart the preview).
  const contentKey = useMemo(() => JSON.stringify(controller, (k, v: unknown) => (k === 'layout' || k === 'position' ? undefined : v)), [controller]);
  const [values, setValues] = useState<Record<string, number | boolean>>({});
  // The preview's playback speed (kept across restarts, like the parameter values).
  const [speed, setSpeed] = useState(1);
  const live = useRef<RunningPreview | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const set = (name: string, v: number | boolean): void => {
    setValues((x) => ({ ...x, [name]: v }));
    live.current?.set(name, v);
  };
  const valueOf = (x: AnimatorParameter): number | boolean => values[x.name] ?? x.default ?? (x.type === 'bool' ? false : 0);
  return (
    <div className="tl-animator-preview" aria-label="animator preview panel">
      {controller.states.length === 0 ? (
        <p className="tl-hint">Add a state with a clip to preview the controller.</p>
      ) : (
        // A new content key is a new run (the values and speed carry over).
        <Run key={contentKey} renderer={renderer} request={request} deps={deps} live={live} valuesRef={valuesRef} speedRef={speedRef} />
      )}
      <div className="tl-animator__row">
        <span className="tl-animator__param" title="Playback speed of every clip and crossfade (scripts: ctx.animator(id).setSpeed).">
          speed
        </span>
        <input
          type="range"
          aria-label="preview speed"
          min={0}
          max={3}
          step={0.05}
          value={speed}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSpeed(v);
            live.current?.setSpeed?.(v);
          }}
        />
        <small aria-label="preview speed value">×{speed.toFixed(2)}</small>
      </div>
      {controller.parameters.map((x) => (
        <div className="tl-animator__row" key={x.name}>
          <span className="tl-animator__param">{x.name}</span>
          {x.type === 'bool' && <input type="checkbox" aria-label={`preview ${x.name}`} checked={valueOf(x) === true} onChange={(e) => set(x.name, e.target.checked)} />}
          {(x.type === 'float' || x.type === 'int') && (
            <>
              <input type="range" aria-label={`preview ${x.name}`} min={-10} max={10} step={x.type === 'int' ? 1 : 0.1} value={Number(valueOf(x))} onChange={(e) => set(x.name, Number(e.target.value))} />
              <small>{Number(valueOf(x)).toFixed(x.type === 'int' ? 0 : 1)}</small>
            </>
          )}
          {x.type === 'trigger' && (
            <button type="button" className="tl-button" aria-label={`preview ${x.name}`} onClick={() => live.current?.trigger(x.name)}>
              fire
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** One run of the controller on its model (a subject of the pane), and its readout. */
function Run(p: PreviewControlsProps<'animator'> & { renderer: PreviewRenderer; live: { current: RunningPreview | null }; valuesRef: { current: Record<string, number | boolean> }; speedRef: { current: number } }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState('');
  const [layerStates, setLayerStates] = useState<string[]>([]);
  const [clipTime, setClipTime] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const latest = useRef(p);
  latest.current = p;
  useSubject(
    p.renderer,
    () =>
      new ModelSubject(
        `animator:${p.request.controller.controllerId}`,
        async (parent) => latest.current.deps.startAnimator(latest.current.request.controller, parent),
        (r) => {
          if (typeof r === 'string') {
            setError(r);
            return;
          }
          const run = r as RunningPreview;
          for (const [k, v] of Object.entries(latest.current.valuesRef.current)) run.set(k, v);
          run.setSpeed?.(latest.current.speedRef.current);
          latest.current.live.current = run;
        },
      ),
  );
  useEffect(() => {
    let last = '';
    const timer = setInterval(() => {
      const run = latest.current.live.current;
      const s = run?.state() ?? '';
      const ls = run?.layerStates?.() ?? [];
      setState(s);
      setLayerStates(ls);
      setClipTime(run?.clipTime?.() ?? 0);
      setElapsed(run?.elapsed?.() ?? 0);
      const all = ls.length > 0 ? ls : s !== '' ? [s] : [];
      if (all.join('|') !== last) {
        last = all.join('|');
        latest.current.request.onStates?.(all);
      }
    }, READOUT_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      latest.current.live.current = null;
      latest.current.request.onStates?.([]);
    };
  }, []);
  const controller = p.request.controller;
  return (
    <>
      {error !== null && (
        <p className="tl-hint" role="alert">
          {error}
        </p>
      )}
      <div className="tl-hint" aria-label="animator preview" data-state={state} data-layer-states={layerStates.slice(1).join('|')} data-clip-time={clipTime.toFixed(4)} data-elapsed={elapsed.toFixed(4)}>
        state: <b aria-label="preview state">{state}</b>
        {layerStates.slice(1).map((x, i) => (
          <span key={i}>
            {' '}
            · {controller.layers?.[i]?.name ?? `layer ${i + 1}`}: <b aria-label={`preview layer ${i + 1} state`}>{x}</b>
          </span>
        ))}
      </div>
    </>
  );
}
