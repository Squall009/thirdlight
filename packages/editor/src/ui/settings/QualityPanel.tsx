/**
 * Project Settings → Quality: the project's default quality level (the
 * environment's quality, the player's setting, so the project's and not a
 * scene's) and the settings that draw the game (the settings registry's
 * Rendering group: renderer, depth precision, instance chunks, texture
 * budget). Both are built from their descriptors; each edit is the same
 * command as before (`setEnvironment` without a scene, a partial
 * `setSettings`).
 */
import { useState, type JSX } from 'react';
import type { DescriptorRegistry, EnvironmentConfig } from '@thirdlight/project-model';
import { RENDERING_SETTINGS_GROUP } from '@thirdlight/project-model/limits';
import { ObjectFields, type FieldContext } from '../DescriptorFields';
import { SettingsFields, type GameplayBackendError } from '../GameplayPanel';

interface Props {
  registry: DescriptorRegistry | null;
  /** The project's part of the environment (quality and presets). */
  environment: EnvironmentConfig | null;
  onSaveEnvironment: (environment: EnvironmentConfig) => void;
  environmentError: string | null;
  settings: Record<string, unknown> | null;
  onSaveSettings: (settings: Record<string, number>) => void;
  settingsError: GameplayBackendError | null;
  fieldContext: FieldContext;
}

export function QualityPanel(p: Props): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  if (p.registry === null) return <p className="tl-note">Loading the settings…</p>;
  const desc = p.registry.content.find((b) => b.key === 'environment')?.value;
  const env: EnvironmentConfig = p.environment ?? {};
  // An unset quality shows as the descriptor's default, the level the game runs at.
  const levelField = desc?.type === 'object' ? desc.fields.find((f) => f.key === 'quality') : undefined;
  const shownLevel = env.quality ?? (levelField !== undefined && 'default' in levelField ? levelField.default : undefined);
  return (
    <div className="tl-panel tl-quality">
      <div className="tl-panel__title">Quality</div>
      <section className="tl-quality__level" aria-label="quality level">
        {desc !== undefined && desc.type === 'object' ? (
          <ObjectFields
            desc={desc}
            value={{ quality: shownLevel }}
            path={[]}
            component="environment"
            ctx={p.fieldContext}
            // The presets are named looks, edited with a scene's look in the Environment window.
            skip={desc.fields.filter((f) => f.key !== 'quality').map((f) => f.key)}
            onFail={setError}
            onEdit={(path, next) => {
              if (path[0] !== 'quality' || typeof next !== 'string' || env.quality === next) return;
              setError(null);
              p.onSaveEnvironment({ ...env, quality: next as EnvironmentConfig['quality'] });
            }}
          />
        ) : (
          <p className="tl-note">The environment has no description.</p>
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
