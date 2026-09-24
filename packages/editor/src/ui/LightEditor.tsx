/**
 * Phase 9.5: the light section of the Inspector, for every light type
 * (directional, ambient, point, spot, hemisphere). Each control commits on
 * release as one `setComponent "light"` (one undo); fields a type does not
 * have are not shown.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { LightComponent } from '@thirdlight/project-model';

interface Props {
  light: LightComponent;
  /** A partial light value; `null` removes an optional field. */
  onSave: (patch: Record<string, unknown>) => void;
}

const INTENSITY_MAX: Record<LightComponent['type'], number> = { directional: 8, ambient: 8, hemisphere: 8, point: 1000, spot: 1000 };

export function LightEditor({ light, onSave }: Props): JSX.Element {
  const [draft, setDraft] = useState<LightComponent>(light);
  useEffect(() => setDraft(light), [JSON.stringify(light)]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (patch: Record<string, unknown>): void => onSave(patch);
  const t = light.type;
  const num = (key: 'intensity' | 'range' | 'decay' | 'angle' | 'penumbra', label: string, min: number, max: number, step: number, fallback: number): JSX.Element => (
    <label className="tl-field" key={key}>
      <span className="tl-field__label">{label}</span>
      <span className="tl-param__number">
        <input
          type="range"
          aria-label={`light ${key}`}
          min={min}
          max={max}
          step={step}
          value={(draft[key] as number | undefined) ?? fallback}
          onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
          onPointerUp={() => commit({ [key]: (draft[key] as number | undefined) ?? fallback })}
          onKeyUp={() => commit({ [key]: (draft[key] as number | undefined) ?? fallback })}
        />
        <span className="tl-param__value">{((draft[key] as number | undefined) ?? fallback).toFixed(step < 1 ? 2 : 0)}</span>
      </span>
    </label>
  );
  return (
    <div className="tl-inspector__section" aria-label="light">
      <div className="tl-panel__title">Light · {t}</div>
      <label className="tl-field">
        <span className="tl-field__label">{t === 'hemisphere' ? 'sky colour' : 'colour'}</span>
        <input type="color" aria-label="light colour" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} onBlur={() => draft.color !== light.color && commit({ color: draft.color })} />
      </label>
      {t === 'hemisphere' && (
        <label className="tl-field">
          <span className="tl-field__label">ground colour</span>
          <input
            type="color"
            aria-label="light ground colour"
            value={draft.groundColor ?? '#444444'}
            onChange={(e) => setDraft({ ...draft, groundColor: e.target.value })}
            onBlur={() => draft.groundColor !== light.groundColor && commit({ groundColor: draft.groundColor ?? '#444444' })}
          />
        </label>
      )}
      {num('intensity', t === 'point' || t === 'spot' ? 'intensity (cd)' : 'intensity', 0, INTENSITY_MAX[t], t === 'point' || t === 'spot' ? 1 : 0.05, light.intensity)}
      {(t === 'point' || t === 'spot') && num('range', 'range (m, 0 = no limit)', 0, 100, 0.5, 0)}
      {(t === 'point' || t === 'spot') && num('decay', 'decay', 0, 4, 0.1, 2)}
      {t === 'spot' && num('angle', 'cone angle (°)', 1, 89, 1, 30)}
      {t === 'spot' && num('penumbra', 'soft edge', 0, 1, 0.05, 0.2)}
      {(t === 'directional' || t === 'spot') && (
        <label className="tl-field">
          <span className="tl-field__label">direction</span>
          <span className="tl-param__vec2">
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                className="tl-input tl-input--num"
                aria-label={`light direction ${'xyz'[i]}`}
                type="number"
                min={-1}
                max={1}
                step={0.05}
                value={(draft.direction ?? [0, -1, 0])[i]}
                onChange={(e) => {
                  const d = [...(draft.direction ?? [0, -1, 0])] as [number, number, number];
                  d[i] = Math.max(-1, Math.min(1, Number(e.target.value)));
                  setDraft({ ...draft, direction: d });
                }}
                onBlur={() => JSON.stringify(draft.direction) !== JSON.stringify(light.direction) && commit({ direction: draft.direction })}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
            ))}
          </span>
        </label>
      )}
      {(t === 'directional' || t === 'point' || t === 'spot') && (
        <label className="tl-flag">
          <input type="checkbox" aria-label="light casts shadows" checked={light.castShadow === true} onChange={(e) => commit({ castShadow: e.target.checked })} />
          casts shadows
        </label>
      )}
      <label className="tl-field">
        <span className="tl-field__label">mode</span>
        <select className="tl-input" aria-label="light mode" value={light.mode ?? 'realtime'} onChange={(e) => commit({ mode: e.target.value === 'realtime' ? null : e.target.value })}>
          <option value="realtime">realtime</option>
          <option value="mixed">mixed (direct realtime + baked bounce)</option>
          <option value="baked">baked only</option>
        </select>
      </label>
    </div>
  );
}
