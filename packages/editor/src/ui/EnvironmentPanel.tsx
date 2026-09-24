/**
 * Phase 9.4: the Environment tab — the project's global wind (the foliage
 * shader bends by it in the editor, Play and export). Sky, fog and
 * post-processing join it in phase 9.5. Each control commits on release as one
 * `setEnvironment` (one undo).
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { EnvironmentConfig, WindConfig } from '@thirdlight/project-model';
import { DEFAULT_WIND } from '../session/material-schema';

interface Props {
  environment: EnvironmentConfig | null;
  onSave: (environment: EnvironmentConfig) => void;
  error: string | null;
}

const round = (v: number, d = 3): number => Number(v.toFixed(d));

export function EnvironmentPanel(p: Props): JSX.Element {
  const wind: WindConfig = p.environment?.wind ?? { ...DEFAULT_WIND, direction: [...DEFAULT_WIND.direction] as [number, number] };
  const [draft, setDraft] = useState<WindConfig>(wind);
  useEffect(() => setDraft(wind), [JSON.stringify(wind)]); // eslint-disable-line react-hooks/exhaustive-deps
  const angle = Math.round((Math.atan2(draft.direction[1], draft.direction[0]) * 180) / Math.PI);
  const commit = (next: WindConfig): void => {
    if (JSON.stringify(next) === JSON.stringify(p.environment?.wind)) return;
    p.onSave({ ...(p.environment ?? {}), wind: next });
  };
  const slider = (key: 'strength' | 'gust' | 'gustFrequency' | 'turbulence', label: string, max: number, step: number): JSX.Element => (
    <label className="tl-field" key={key}>
      <span className="tl-field__label">{label}</span>
      <span className="tl-param__number">
        <input
          type="range"
          aria-label={`wind ${key}`}
          min={0}
          max={max}
          step={step}
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
          onPointerUp={() => commit(draft)}
          onKeyUp={() => commit(draft)}
        />
        <span className="tl-param__value">{draft[key].toFixed(2)}</span>
      </span>
    </label>
  );
  return (
    <div className="tl-panel tl-environment">
      <div className="tl-panel__title">Environment</div>
      <div className="tl-inspector__section" aria-label="wind">
        <div className="tl-subhead">Wind (bends foliage materials by their vertex colour)</div>
        <label className="tl-field">
          <span className="tl-field__label">direction</span>
          <span className="tl-param__number">
            <input
              type="range"
              aria-label="wind direction"
              min={-180}
              max={180}
              step={5}
              value={angle}
              onChange={(e) => {
                const a = (Number(e.target.value) * Math.PI) / 180;
                setDraft({ ...draft, direction: [round(Math.cos(a)), round(Math.sin(a))] });
              }}
              onPointerUp={() => commit(draft)}
              onKeyUp={() => commit(draft)}
            />
            <span className="tl-param__value">{angle}°</span>
          </span>
        </label>
        {slider('strength', 'strength', 10, 0.05)}
        {slider('gust', 'gusts', 10, 0.05)}
        {slider('gustFrequency', 'gusts per second', 10, 0.05)}
        {slider('turbulence', 'turbulence', 1, 0.01)}
        {p.error !== null && <div className="tl-assets__error" role="alert">{p.error}</div>}
      </div>
    </div>
  );
}
