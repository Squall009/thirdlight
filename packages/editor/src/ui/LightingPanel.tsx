/**
 * Phase 9.6: the Lighting window — bake the active scene's lightmaps.
 *
 * "Bake preview" runs in this browser (direct light and sky occlusion from
 * the lights set to "baked"; no bounce light). "Bake final" sends the scene
 * to Blender Cycles on the bake host (bounce light from baked and mixed
 * lights). Both replace the scene's bake in one step; Clear removes it. A
 * bake whose static objects or baked lights changed since is marked stale
 * (it is still used until it is baked again or cleared).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { LightingBake } from '@thirdlight/project-model';

import type { BakeSettings } from '../viewport/bake-run';

interface Props {
  sceneName: string;
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
  return (
    <div className="tl-panel tl-lighting" aria-label="lighting">
      <div className="tl-panel__title">Lighting — {p.sceneName}</div>
      <p className="tl-hint">
        Static objects (Inspector → Static) get lightmaps from the lights set to <b>baked</b> or <b>mixed</b>. Baked lights are then no longer
        realtime; mixed lights stay realtime and add their bounce light in the final bake.
      </p>
      <div className="tl-lighting__status" aria-label="bake status">
        {p.bake === null ? (
          <span>No bake for this scene.</span>
        ) : (
          <span>
            {p.bake.source === 'blender' ? 'Final (Blender)' : 'Preview (browser)'} bake from {p.bake.createdAt.replace('T', ' ').slice(0, 16)} — {p.bake.entries.length} objects,{' '}
            {p.bake.atlases.length} lightmap{p.bake.atlases.length === 1 ? '' : 's'}
            {p.stale && <b className="tl-lighting__stale"> — stale: static objects or baked lights changed; bake again</b>}
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
        </div>
      )}
      <div className="tl-lighting__actions">
        <button type="button" className="tl-button" disabled={p.busy !== null} onClick={p.onBakePreview}>
          Bake preview (browser)
        </button>
        <button type="button" className="tl-button" disabled={p.busy !== null || p.finalUnavailable !== null} title={p.finalUnavailable ?? 'Blender Cycles on the bake host'} onClick={p.onBakeFinal}>
          Bake final (Blender)
        </button>
        {p.busy !== null && (
          <button type="button" className="tl-button" onClick={p.onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="tl-button" disabled={p.busy !== null || p.bake === null} onClick={p.onClear}>
          Clear bake
        </button>
      </div>
      {p.busy !== null && (
        <div className="tl-lighting__progress" role="progressbar" aria-label="bake progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.busy.fraction * 100)}>
          <div className="tl-lighting__bar" style={{ width: `${Math.round(p.busy.fraction * 100)}%` }} />
          <span>{p.busy.text}</span>
        </div>
      )}
      {p.finalUnavailable !== null && <p className="tl-hint">Final bake: {p.finalUnavailable}</p>}
      {p.message !== null && (
        <p className="tl-lighting__message" role="status">
          {p.message}
        </p>
      )}
    </div>
  );
}
