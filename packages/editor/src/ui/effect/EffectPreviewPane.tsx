/**
 * Phase 20.3: the Effect tab's preview pane (right column) — the looping
 * preview canvas (`viewport/effect-preview.ts`), its timeline (play/pause,
 * restart, scrub, preview length), the spawn counters per system, the frame
 * cost (GPU timestamps or CPU frame time, labelled) and sliders for
 * preview-only parameter values (never saved: the Inspector's Effect
 * component sets an object's values).
 *
 * The preview is created when the tab opens and disposed when it closes (or
 * another tab becomes active). Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { EffectDef, EffectParameter } from '@thirdlight/project-model';
import type { EnvironmentLike, WindLike } from '@thirdlight/three-adapter';
import type * as THREE from 'three';

import { EffectPreview, PREVIEW_MAX_LENGTH, type EffectPreviewStats, type PreviewParamValue } from '../../viewport/effect-preview';

export interface EffectPreviewPaneProps {
  effect: EffectDef;
  /** The project environment with its wind (null: a neutral dark backdrop). */
  environment: (EnvironmentLike & { wind?: WindLike }) | null;
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  /** A model asset's scene for mesh particles and mesh-surface shapes (null: unavailable). */
  loadModel?: (assetId: string) => Promise<THREE.Object3D | null>;
}

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

export function EffectPreviewPane(p: EffectPreviewPaneProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<EffectPreview | null>(null);
  const [stats, setStats] = useState<EffectPreviewStats | null>(null);
  const [playing, setPlaying] = useState(true);
  const [scrub, setScrub] = useState<number | null>(null);
  const lengthKey = `${p.effect.duration}|${p.effect.loop}`;
  const [length, setLength] = useState(() => defaultPreviewLength(p.effect));
  const [overrides, setOverrides] = useState<Record<string, PreviewParamValue>>({});
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const preview = new EffectPreview(canvas, {
      loadTexture: (id) => latest.current.loadTexture(id),
      loadModel: (id) => latest.current.loadModel?.(id) ?? Promise.resolve(null),
      onStats: (s) => {
        setStats(s);
        // A scrub shows its own value until the preview reports the time it re-simulated to.
        setScrub(null);
      },
    });
    previewRef.current = preview;
    preview.setEnvironment(latest.current.environment);
    preview.setEffect(latest.current.effect as never);
    return () => {
      preview.dispose();
      previewRef.current = null;
    };
  }, []);
  useEffect(() => previewRef.current?.setEffect(p.effect as never), [p.effect]);
  useEffect(() => previewRef.current?.setEnvironment(p.environment), [p.environment]);
  useEffect(() => previewRef.current?.setOverrides(overrides), [overrides]);
  // A new duration or loop setting: the default length follows it.
  useEffect(() => setLength(defaultPreviewLength(latest.current.effect)), [lengthKey]);
  useEffect(() => previewRef.current?.setLength(length), [length]);
  // Overrides of parameters that no longer exist (or changed type) are dropped.
  const params = p.effect.parameters ?? [];
  const paramsKey = params.map((x) => `${x.key}:${x.type}`).join(',');
  useEffect(() => {
    setOverrides((o) => {
      const keep = Object.fromEntries(Object.entries(o).filter(([k]) => params.some((x) => x.key === k)));
      return Object.keys(keep).length === Object.keys(o).length ? o : keep;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  const time = scrub ?? stats?.time ?? 0;
  const togglePlay = (): void => {
    const pv = previewRef.current;
    if (pv === null) return;
    if (playing) pv.pause();
    else pv.play();
    setPlaying(!playing);
  };
  const cost = stats?.cost ?? null;
  return (
    <div className="tl-effect-preview" aria-label="effect preview">
      <div className="tl-subhead">Preview</div>
      <canvas ref={canvasRef} className="tl-effect-preview__canvas" aria-label="effect preview canvas" />
      <span className="tl-hint tl-effect-preview__status" role="status" aria-label="preview status">
        {stats === null || stats.backend === null ? 'starting…' : `${stats.backend} · ${stats.executor === 'webgpu' ? 'WebGPU compute' : stats.executor === 'cpu' ? 'CPU executor' : 'no systems'}`}
        {stats?.reason != null ? ` (${stats.reason})` : ''}
        {p.environment === null ? ' · neutral backdrop' : ' · project environment'}
        {stats !== null && stats.errors > 0 ? ` · ${stats.errors} graph error${stats.errors === 1 ? '' : 's'}` : ''}
      </span>
      <div className="tl-effect-preview__timeline" role="group" aria-label="preview timeline">
        <button type="button" className="tl-btn tl-btn--small" aria-label={playing ? 'pause preview' : 'play preview'} title={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button type="button" className="tl-btn tl-btn--small" aria-label="restart preview" title="Restart from the seed" onClick={() => previewRef.current?.restart()}>
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
            previewRef.current?.seek(t);
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
