/**
 * The Lighting window's panel — bake the active scene's lightmaps (the
 * window names the scene).
 *
 * "Bake preview" runs in this browser (direct light and sky occlusion from
 * the lights set to "baked"; no bounce light). "Bake final" sends the scene
 * to Blender Cycles on the bake host (bounce light from baked and mixed
 * lights). Both replace the scene's bake in one step; Clear removes it. A
 * bake whose static objects or baked lights changed since is marked stale
 * (it is still used until it is baked again or cleared).
 *
 * "Bake probes" bakes the scene's probe grids (indirect light for every 3D
 * object) on this view's renderer: WebGPU only, the window says so on WebGL 2
 * (baked probes still draw there). They are cleared on their own.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { LightingBake } from '@thirdlight/project-model';
import { MAX_PROBE_BOUNCES, PROBE_SPACING_MAX, PROBE_SPACING_MIN } from '@thirdlight/runtime';

import type { BakeSettings } from '../viewport/bake-run';
import type { ProbeBakeSettings } from '../viewport/probe-bake-run';

interface Props {
  bake: LightingBake | null;
  stale: boolean;
  settings: BakeSettings;
  onSettings: (s: BakeSettings) => void;
  busy: { text: string; fraction: number } | null;
  /** Why the Blender bake is unavailable (null = available). */
  finalUnavailable: string | null;
  message: string | null;
  onBakePreview: () => void;
  onBakeFinal: () => void;
  onCancel: () => void;
  onClear: () => void;
  probeSettings: ProbeBakeSettings;
  onProbeSettings: (s: ProbeBakeSettings) => void;
  /** Why probes cannot be baked here (null = they can). */
  probeUnavailable: string | null;
  probesStale: boolean;
  onBakeProbes: () => void;
  onClearProbes: () => void;
}

export function LightingPanel(p: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const s = p.settings;
  const num = (key: keyof BakeSettings, label: string, min: number, max: number, step: number): JSX.Element => (
    <label className="tl-field">
      <span className="tl-field__label">{label}</span>
      <input
        className="tl-input tl-input--num"
        type="number"
        aria-label={`bake ${key}`}
        min={min}
        max={max}
        step={step}
        value={s[key]}
        disabled={p.busy !== null}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) p.onSettings({ ...s, [key]: Math.min(max, Math.max(min, v)) });
        }}
      />
    </label>
  );
  const probeNum = (key: keyof ProbeBakeSettings, label: string, min: number, max: number, step: number): JSX.Element => (
    <label className="tl-field">
      <span className="tl-field__label">{label}</span>
      <input
        className="tl-input tl-input--num"
        type="number"
        aria-label={`probe ${key}`}
        min={min}
        max={max}
        step={step}
        value={p.probeSettings[key]}
        disabled={p.busy !== null}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) p.onProbeSettings({ ...p.probeSettings, [key]: Math.min(max, Math.max(min, key === 'bounces' ? Math.round(v) : v)) });
        }}
      />
    </label>
  );
  return (
    <div className="tl-panel tl-lighting" aria-label="lighting">
      <p className="tl-hint">
        Static objects (Inspector → Static) get lightmaps from the lights set to <b>baked</b> or <b>mixed</b>. Baked lights are then no longer
        realtime; mixed lights stay realtime and add their bounce light in the final bake.
      </p>
      <div className="tl-lighting__status" aria-label="bake status">
        {p.bake === null || p.bake.atlases.length === 0 ? (
          <span>No bake for this scene.</span>
        ) : (
          <span>
            {p.bake.source === 'blender' ? 'Final (Blender)' : 'Preview (browser)'} bake from {p.bake.createdAt.replace('T', ' ').slice(0, 16)} — {p.bake.entries.length} objects,{' '}
            {p.bake.atlases.length} lightmap{p.bake.atlases.length === 1 ? '' : 's'}
            {p.stale && <b className="tl-lighting__stale"> — stale: static objects or baked lights changed; bake again</b>}
          </span>
        )}
      </div>
      <div className="tl-lighting__status" aria-label="probe status">
        {p.bake?.probes === undefined ? (
          <span>No probes for this scene.</span>
        ) : (
          <span>
            Probes from {p.bake.probes.createdAt.replace('T', ' ').slice(0, 16)} — {p.bake.probes.probes} probes in {p.bake.probes.grids.length} tile{p.bake.probes.grids.length === 1 ? '' : 's'},{' '}
            {(p.bake.probes.gpuBytes / 1048576).toFixed(1)} MB GPU, {p.bake.probes.spacing} m apart
            {p.probesStale && <b className="tl-lighting__stale"> — stale: static objects or baked lights changed; bake again</b>}
          </span>
        )}
      </div>
      <button type="button" className="tl-button tl-button--link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} settings
      </button>
      {open && (
        <div className="tl-environment__grid">
          {num('texelsPerMeter', 'texels per meter', 1, 128, 1)}
          {num('samples', 'preview samples', 1, 4096, 1)}
          {num('finalSamples', 'final samples', 16, 16384, 16)}
          {num('bounces', 'final bounces', 0, 8, 1)}
          {num('range', 'brightest value', 0.5, 32, 0.5)}
          {probeNum('spacing', 'probe spacing (m)', PROBE_SPACING_MIN, PROBE_SPACING_MAX, 0.25)}
          {probeNum('bounces', 'probe bounces', 0, MAX_PROBE_BOUNCES, 1)}
        </div>
      )}
      <div className="tl-lighting__actions">
        <button type="button" className="tl-button" disabled={p.busy !== null} onClick={p.onBakePreview}>
          Bake preview (browser)
        </button>
        <button type="button" className="tl-button" disabled={p.busy !== null || p.finalUnavailable !== null} title={p.finalUnavailable ?? 'Blender Cycles on the bake host'} onClick={p.onBakeFinal}>
          Bake final (Blender)
        </button>
        <button type="button" className="tl-button" disabled={p.busy !== null || p.probeUnavailable !== null} title={p.probeUnavailable ?? 'Probe grids over the static objects or the probe volumes (WebGPU, in this browser)'} onClick={p.onBakeProbes}>
          Bake probes
        </button>
        {p.busy !== null && (
          <button type="button" className="tl-button" onClick={p.onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="tl-button" disabled={p.busy !== null || p.bake === null || p.bake.atlases.length === 0} onClick={p.onClear}>
          Clear bake
        </button>
        <button type="button" className="tl-button" disabled={p.busy !== null || p.bake?.probes === undefined} onClick={p.onClearProbes}>
          Clear probes
        </button>
      </div>
      {p.busy !== null && (
        <div className="tl-lighting__progress" role="progressbar" aria-label="bake progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.busy.fraction * 100)}>
          <div className="tl-lighting__bar" style={{ width: `${Math.round(p.busy.fraction * 100)}%` }} />
          <span>{p.busy.text}</span>
        </div>
      )}
      {p.finalUnavailable !== null && <p className="tl-hint">Final bake: {p.finalUnavailable}</p>}
      {p.probeUnavailable !== null && (
        <p className="tl-hint" aria-label="probe bake unavailable">
          Probes: {p.probeUnavailable}.
        </p>
      )}
      {p.message !== null && (
        <p className="tl-lighting__message" role="status">
          {p.message}
        </p>
      )}
    </div>
  );
}
