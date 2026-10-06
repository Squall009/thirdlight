/**
 * Project Settings → Quality: the project's quality levels (the
 * environment's `qualityLevels`, lowest first, or the engine's low, medium
 * and high), the level a game starts at (the environment's `quality`: the
 * player's setting, so the project's and not a scene's), and the settings
 * that draw the game (the settings registry's Rendering group: renderer,
 * depth precision, instance chunks, texture budget, AO, render scale). Each
 * level's fields are built from its descriptor; every edit is the same
 * command as before (`setEnvironment` without a scene, a partial
 * `setSettings`).
 */
import { useState, type JSX } from 'react';
import type { DescriptorRegistry, EnvironmentConfig, ObjectFieldDescriptor, QualityLevelConfig } from '@thirdlight/project-model';
import { DEFAULT_QUALITY_LEVELS, qualityLevelsOf, RENDERING_SETTINGS_GROUP } from '@thirdlight/project-model/limits';
import { setAt } from '../../session/descriptor-fields';
import { ObjectFields, type FieldContext } from '../DescriptorFields';
import { SettingsFields, type GameplayBackendError } from '../GameplayPanel';

interface Props {
  registry: DescriptorRegistry | null;
  /** The project's part of the environment (quality levels, the starting level and presets). */
  environment: EnvironmentConfig | null;
  onSaveEnvironment: (environment: EnvironmentConfig) => void;
  environmentError: string | null;
  settings: Record<string, unknown> | null;
  onSaveSettings: (settings: Record<string, number>) => void;
  settingsError: GameplayBackendError | null;
  fieldContext: FieldContext;
}

/** A level id not yet used (`level4`, `level5`, …). */
function freshId(levels: readonly QualityLevelConfig[]): string {
  for (let n = levels.length + 1; ; n += 1) if (!levels.some((l) => l.id === `level${n}`)) return `level${n}`;
}

export function QualityPanel(p: Props): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  if (p.registry === null) return <p className="tl-note">Loading the settings…</p>;
  const desc = p.registry.content.find((b) => b.key === 'environment')?.value;
  const levelsField = desc?.type === 'object' ? desc.fields.find((f) => f.key === 'qualityLevels') : undefined;
  const levelDesc = levelsField?.type === 'list' && levelsField.item.type === 'object' ? (levelsField.item as ObjectFieldDescriptor) : null;
  const env: EnvironmentConfig = p.environment ?? {};
  const own = env.qualityLevels;
  const levels = qualityLevelsOf(env);
  // The level a game starts at: the project's, else the highest.
  const shownLevel = env.quality !== undefined && levels.some((l) => l.id === env.quality) ? env.quality : levels[levels.length - 1]!.id;
  /** Save the levels (and the starting level, kept naming one of them). */
  const saveLevels = (next: QualityLevelConfig[] | undefined, quality: string | undefined = env.quality): void => {
    setError(null);
    const ids = qualityLevelsOf({ ...(next !== undefined ? { qualityLevels: next } : {}) }).map((l) => l.id);
    const rest: EnvironmentConfig = { ...env };
    delete rest.qualityLevels;
    delete rest.quality;
    p.onSaveEnvironment({ ...rest, ...(quality !== undefined && ids.includes(quality) ? { quality } : {}), ...(next !== undefined ? { qualityLevels: next } : {}) });
  };
  const editLevel = (i: number, path: readonly (string | number)[], value: unknown): void => {
    if (own === undefined) return;
    const before = own[i]!;
    const next = own.map((l, j) => (j === i ? (setAt(l, path as (string | number)[], value) as QualityLevelConfig) : l));
    // A renamed level the game starts at stays the one it starts at.
    const renamed = path[0] === 'id' && env.quality === before.id && typeof value === 'string';
    saveLevels(next, renamed ? value : env.quality);
  };
  const move = (i: number, by: -1 | 1): void => {
    if (own === undefined || i + by < 0 || i + by >= own.length) return;
    const next = [...own];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    saveLevels(next);
  };
  return (
    <div className="tl-panel tl-quality">
      <div className="tl-panel__title">Quality</div>
      <section className="tl-quality__level" aria-label="quality level">
        <label className="tl-field">
          <span className="tl-field__label" title="The quality level a game starts at; players change it in their settings.">Starting level</span>
          <select
            className="tl-input"
            aria-label="environment quality"
            value={shownLevel}
            onChange={(e) => {
              if (e.target.value === env.quality) return;
              setError(null);
              p.onSaveEnvironment({ ...env, quality: e.target.value });
            }}
          >
            {levels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name ?? l.id}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section className="tl-quality__levels" aria-label="quality levels">
        <div className="tl-panel__subtitle">Quality levels</div>
        <p className="tl-inspector__hint">
          Lowest first. A level changes each scene's post-processing where the look has an effect on (Off turns it off; a level never turns one on) and the renderer settings it sets; what it leaves out is the project's setting. Players pick a level in their settings; tl_game_control setQuality switches a running Play.
        </p>
        {own === undefined ? (
          <>
            <p className="tl-note" aria-label="engine quality levels">
              The engine's levels: Low (no bloom, ambient occlusion, depth of field, anti-aliasing or MSAA), Medium (no ambient occlusion or depth of field), High (the look as authored).
            </p>
            <button type="button" className="tl-btn" aria-label="customize quality levels" onClick={() => saveLevels(JSON.parse(JSON.stringify(DEFAULT_QUALITY_LEVELS)) as QualityLevelConfig[])}>
              Customize levels
            </button>
          </>
        ) : (
          <>
            {own.map((l, i) => (
              <section key={i} className="tl-quality__card" aria-label={`quality level ${i + 1}`} data-level={l.id}>
                <div className="tl-quality__card-head">
                  <strong>{l.name ?? l.id}</strong>
                  <button type="button" className="tl-btn tl-btn--small" aria-label={`move quality level ${i + 1} lower`} disabled={i === 0} title="Lower (earlier in the list)" onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="tl-btn tl-btn--small" aria-label={`move quality level ${i + 1} higher`} disabled={i === own.length - 1} title="Higher (later in the list)" onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className="tl-btn tl-btn--small" aria-label={`remove quality level ${i + 1}`} disabled={own.length <= 1} title="Remove this level" onClick={() => saveLevels(own.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
                {levelDesc !== null ? (
                  <ObjectFields desc={levelDesc} value={l as unknown as Record<string, unknown>} path={[i]} component="level" ctx={p.fieldContext} onFail={setError} onEdit={(path, next) => editLevel(i, path.slice(1), next)} />
                ) : (
                  <p className="tl-note">The quality level has no description.</p>
                )}
              </section>
            ))}
            <div className="tl-quality__actions">
              <button type="button" className="tl-btn" aria-label="add quality level" onClick={() => saveLevels([...own, { id: freshId(own) }])}>
                + Level
              </button>
              <button type="button" className="tl-btn" aria-label="use the engine quality levels" title="Remove the project's levels: the engine's low, medium and high again" onClick={() => saveLevels(undefined)}>
                Use the engine's levels
              </button>
            </div>
          </>
        )}
        {(error ?? p.environmentError) !== null && (
          <div className="tl-prop__error" role="alert">
            {error ?? p.environmentError}
          </div>
        )}
      </section>
      <SettingsFields
        settings={p.settings}
        backendError={p.settingsError}
        onSaveSettings={p.onSaveSettings}
        registry={p.registry}
        fieldContext={p.fieldContext}
        group={{ only: RENDERING_SETTINGS_GROUP }}
        label="quality settings"
      />
    </div>
  );
}
