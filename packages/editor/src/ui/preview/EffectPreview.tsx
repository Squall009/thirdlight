/**
 * The preview pane's effect controls — the effect looping on its timeline
 * (play/pause, restart, scrub, preview length), the spawn counters per
 * system, the frame cost (GPU timestamps or CPU frame time, labelled) and
 * sliders for preview-only parameter values (never saved: the Inspector's
 * Effect component sets an object's values).
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { EffectDef, EffectParameter } from '@thirdlight/project-model';

import { EffectSubject, PREVIEW_MAX_LENGTH, type EffectPreviewStats, type PreviewParamValue } from '../../viewport/preview-effect';
import { useSubject, type PreviewControlsProps } from './use-subject';

/** The default preview length: two cycles of a looping effect (the second shows the steady state), one cycle plus a second for a one-shot (its last particles fade). */
export function defaultPreviewLength(fx: Pick<EffectDef, 'duration' | 'loop'>): number {
  return Math.min(PREVIEW_MAX_LENGTH, Math.max(0.1, fx.loop ? fx.duration * 2 : fx.duration + 1));
}

/** A float parameter's slider range: its declared min/max, else around its default. */
export function sliderRange(p: Pick<EffectParameter, 'min' | 'max' | 'default'>, axis = 0): { min: number; max: number } {
  const d = Array.isArray(p.default) ? Number(p.default[axis] ?? 0) : Number(p.default);
  const span = Math.max(1, Math.abs(d) * 2);
  const min = p.min ?? (d >= 0 ? 0 : -span);
  const max = p.max ?? span;
  return { min, max: max > min ? max : min + 1 };
}

const fmt = (n: number, digits = 2): string => n.toFixed(digits);

/** The frame cost line: each part says how it was measured (GPU timestamp queries or CPU time). */
export function costText(cost: EffectPreviewStats['cost']): string {
  if (cost === null) return 'Frame cost: measuring…';
  if (cost.simulationBy === 'gpu' && cost.drawBy === 'gpu') return `GPU time (timestamp queries): simulation ${fmt(cost.simulation, 3)} ms · draw ${fmt(cost.draw, 3)} ms per frame`;
  if (cost.drawBy === 'gpu') return `Simulation (CPU executor): ${fmt(cost.simulation, 3)} ms CPU time · draw ${fmt(cost.draw, 3)} ms GPU time (timestamp queries) per frame`;
  return `CPU frame time (no GPU timestamp queries on this device): simulation ${fmt(cost.simulation, 3)} ms · draw ${fmt(cost.draw, 3)} ms per frame`;
}

export function EffectPreview({ renderer, request, deps }: PreviewControlsProps<'effect'>): JSX.Element {
  const [stats, setStats] = useState<EffectPreviewStats | null>(null);
  const [playing, setPlaying] = useState(true);
  const [scrub, setScrub] = useState<number | null>(null);
  const effect = request.effect;
  const lengthKey = `${effect.duration}|${effect.loop}`;
  const [length, setLength] = useState(() => defaultPreviewLength(effect));
  const [overrides, setOverrides] = useState<Record<string, PreviewParamValue>>({});
  const latest = useRef(deps);
  latest.current = deps;
  const subject = useSubject(
    renderer,
    () =>
      new EffectSubject(effect.effectId, {
        loadTexture: (id) => latest.current.loadTexture(id),
        loadModel: (id) => latest.current.loadEffectModel(id),
        onStats: (s) => {
          setStats(s);
          // A scrub shows its own value until the preview reports the time it re-simulated to.
          setScrub(null);
        },
      }),
  );
  useEffect(() => subject?.setEffect(effect as never), [subject, effect]);
  useEffect(() => subject?.setOverrides(overrides), [subject, overrides]);
  // A new duration or loop setting: the default length follows it.
  useEffect(() => setLength(defaultPreviewLength(effect)), [lengthKey]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by duration and loop only
  useEffect(() => subject?.setLength(length), [subject, length]);
  // Overrides of parameters that no longer exist (or changed type) are dropped.
  const params = effect.parameters ?? [];
  const paramsKey = params.map((x) => `${x.key}:${x.type}`).join(',');
  useEffect(() => {
    setOverrides((o) => {
      const keep = Object.fromEntries(Object.entries(o).filter(([k]) => params.some((x) => x.key === k)));
      return Object.keys(keep).length === Object.keys(o).length ? o : keep;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params is keyed by paramsKey so a new array with the same params keeps the overrides
  }, [paramsKey]);

  const time = scrub ?? stats?.time ?? 0;
  const togglePlay = (): void => {
    if (subject === null) return;
    if (playing) subject.pause();
    else subject.play();
    setPlaying(!playing);
  };
  const cost = stats?.cost ?? null;
  const summary = stats === null ? null : { executor: stats.executor, time: Math.round(stats.time * 1000) / 1000, steps: stats.steps, playing: stats.playing, systems: stats.systems.map((x) => ({ id: x.systemId, spawned: x.spawned, living: x.living })), cost: stats.cost === null ? null : `${stats.cost.simulationBy}/${stats.cost.drawBy}` };
  return (
    <div className="tl-effect-preview" aria-label="effect preview" data-tl-effect-preview={summary === null ? undefined : JSON.stringify(summary)}>
      <span className="tl-hint tl-effect-preview__status" role="status" aria-label="preview status">
        {stats === null || stats.backend === null ? 'starting…' : `${stats.backend} · ${stats.executor === 'webgpu' ? 'WebGPU compute' : stats.executor === 'cpu' ? 'CPU executor' : 'no systems'}`}
        {stats?.reason != null ? ` (${stats.reason})` : ''}
        {deps.environment === null ? ' · neutral backdrop' : " · the active scene's look"}
        {stats !== null && stats.errors > 0 ? ` · ${stats.errors} graph error${stats.errors === 1 ? '' : 's'}` : ''}
      </span>
      <div className="tl-effect-preview__timeline" role="group" aria-label="preview timeline">
        <button type="button" className="tl-btn tl-btn--small" aria-label={playing ? 'pause preview' : 'play preview'} title={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button type="button" className="tl-btn tl-btn--small" aria-label="restart preview" title="Restart from the seed" onClick={() => subject?.restart()}>
          ⟲
        </button>
        <input
          type="range"
          className="tl-effect-preview__scrub"
          aria-label="preview time"
          min={0}
          max={length}
          step={1 / 60}
          value={Math.min(time, length)}
          onChange={(e) => {
            const t = Number(e.target.value);
            setScrub(t);
            subject?.seek(t);
          }}
        />
        <span className="tl-effect-preview__time" aria-label="preview time readout">
          {fmt(time)} / {fmt(length)} s
        </span>
      </div>
      <label className="tl-effect-preview__length">
        <span>Preview length (s)</span>
        <input
          className="tl-input tl-input--num"
          aria-label="preview length"
          type="number"
          min={0.1}
          max={PREVIEW_MAX_LENGTH}
          step={0.1}
          value={length}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 0.1 && n <= PREVIEW_MAX_LENGTH) setLength(n);
          }}
        />
      </label>
      <table className="tl-effect-preview__counters" aria-label="spawn counters">
        <thead>
          <tr>
            <th>System</th>
            <th title="Particles born since the start (the timeline's time 0)">Spawned</th>
            <th title="Particles alive now (read back from the GPU a few times a second on WebGPU)">Living</th>
          </tr>
        </thead>
        <tbody>
          {(stats?.systems ?? []).map((s) => (
            <tr key={s.systemId} data-system-id={s.systemId}>
              <td>{s.name}</td>
              <td data-counter="spawned">{s.spawned}</td>
              <td data-counter="living">{s.living ?? '…'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tl-hint tl-effect-preview__cost" aria-label="frame cost">
        {costText(cost)}
      </p>
      {params.length > 0 && (
        <div className="tl-effect-preview__params" aria-label="preview parameters">
          <div className="tl-subhead">
            Preview parameters
            <button type="button" className="tl-btn tl-btn--small" aria-label="reset preview parameters" title="Back to the effect's values" onClick={() => setOverrides({})} disabled={Object.keys(overrides).length === 0}>
              reset
            </button>
          </div>
          <p className="tl-hint">Preview only (not saved). Objects set their values in the Inspector (Effect component).</p>
          {params.map((x) => (
            <ParamSlider key={`${x.key}:${x.type}`} param={x} value={overrides[x.key] ?? x.default} onChange={(v) => setOverrides((o) => ({ ...o, [x.key]: v }))} />
          ))}
        </div>
      )}
    </div>
  );
}

function ParamSlider({ param, value, onChange }: { param: EffectParameter; value: PreviewParamValue; onChange: (v: PreviewParamValue) => void }): JSX.Element {
  if (param.type === 'color') {
    return (
      <label className="tl-effect-preview__param" data-parameter={param.key}>
        <span>{param.key}</span>
        <input type="color" aria-label={`preview parameter ${param.key}`} value={typeof value === 'string' ? value : '#ffffff'} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  if (param.type === 'vec3') {
    const v = Array.isArray(value) ? value.map(Number) : [0, 0, 0];
    return (
      <div className="tl-effect-preview__param" data-parameter={param.key}>
        <span>{param.key}</span>
        {['x', 'y', 'z'].map((axis, i) => {
          const r = sliderRange(param, i);
          return (
            <input
              key={axis}
              type="range"
              aria-label={`preview parameter ${param.key} ${axis}`}
              min={r.min}
              max={r.max}
              step={(r.max - r.min) / 200}
              value={v[i] ?? 0}
              onChange={(e) => onChange(v.map((c, j) => (j === i ? Number(e.target.value) : c)))}
            />
          );
        })}
        <span className="tl-hint">{v.map((c) => fmt(c)).join(', ')}</span>
      </div>
    );
  }
  const r = sliderRange(param);
  const n = Number(value);
  return (
    <label className="tl-effect-preview__param" data-parameter={param.key}>
      <span>{param.key}</span>
      <input type="range" aria-label={`preview parameter ${param.key}`} min={r.min} max={r.max} step={(r.max - r.min) / 200} value={n} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="tl-hint">{fmt(n)}</span>
    </label>
  );
}
