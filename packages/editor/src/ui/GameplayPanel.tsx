/**
 * The Gameplay panel (generic) over the projected
 * backend state:
 *  - **Settings** — the project settings (the character's physics and the
 *    engine settings; the Rendering group shows under Project Settings →
 *    Quality), built from their descriptor; each edit is one partial
 *    `setSettings`;
 *  - **Camera** — points at the camera objects, whose lens and rig (a
 *    virtual camera's `track` follows a target) are Inspector sections
 *    (built from their descriptors).
 *
 * The backend projection is authoritative: every value renders from the
 * projection/client state; every edit issues a typed command through the
 * app's actions, and the app's single `backendError` (the last failed
 * command, explained) is shown at the top of the active tab. Plain DOM
 * text/inputs only (no project-supplied HTML).
 */
import { useState } from 'react';
import type { JSX } from 'react';
import type { ProjectedEntity } from '../session/projection';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { RENDERING_SETTINGS_GROUP } from '@thirdlight/project-model/limits';
import { ObjectFields, type FieldContext } from './DescriptorFields';

/** The app's single backend error (the last failed command, explained). */
export interface GameplayBackendError {
  code: string;
  message: string;
}

interface Props {
  entities: readonly ProjectedEntity[];
  settings: Record<string, unknown> | null;
  /** Select an object (the Camera tab points at the camera's Inspector sections). */
  onSelectEntity: (entityId: string) => void;
  /** The descriptors (the settings are built from them). */
  registry: DescriptorRegistry | null;
  fieldContext: FieldContext;
  onSaveSettings: (settings: Record<string, number>) => void;
  backendError: GameplayBackendError | null;
}

function BackendError({ error }: { error: GameplayBackendError | null }): JSX.Element | null {
  if (error === null) return null;
  return (
    <div className="tl-gameplay__errors" role="alert">
      <div className="tl-gameplay__errors-title">{error.code}</div>
      <ul>
        <li>{error.message}</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Camera tab (the camera and its rig are Inspector sections of
// the camera object; this tab points there)
// ---------------------------------------------------------------------------

function CameraTab({ entities, onSelectEntity }: { entities: readonly ProjectedEntity[]; onSelectEntity: (id: string) => void }): JSX.Element {
  const cameras = entities.filter((e) => e.kind === 'camera');
  return (
    <div className="tl-gameplay__tab">
      <p className="tl-note">A camera's lens (field of view, near, far) and its rig (a virtual camera that tracks a target, with a dead zone) are sections of the camera object in the Inspector.</p>
      {cameras.length === 0 && <p className="tl-note">No camera in the open scenes (GameObject → Camera).</p>}
      {cameras.map((c) => (
        <div className="tl-gameplay__actions" key={c.id}>
          <span>{c.name}</span>
          <button className="tl-btn" onClick={() => onSelectEntity(c.id)}>
            Select
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

/**
 * The settings built from their descriptor: the registry's keys, the engine
 * settings included (a choice of numbers is a select). Each edit is one
 * partial `setSettings`; a setting cannot be removed (the command has no
 * removal), so an emptied field is refused here. `group` picks the fields of
 * one settings group (`only`) or all but one (`except`): the Rendering group
 * shows with the quality, the rest under Gameplay.
 */
export function SettingsFields({
  settings,
  backendError,
  onSaveSettings,
  registry,
  fieldContext,
  group,
  label,
}: {
  settings: Record<string, unknown> | null;
  backendError: GameplayBackendError | null;
  onSaveSettings: (settings: Record<string, number>) => void;
  registry: DescriptorRegistry;
  fieldContext: FieldContext;
  group: { only: string } | { except: string };
  label: string;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const desc = registry.content.find((b) => b.key === 'settings')?.value;
  if (desc === undefined || desc.type !== 'object') return <p className="tl-note">The settings have no description.</p>;
  const current = settings ?? {};
  const skip = desc.fields.filter((f) => ('only' in group ? f.group !== group.only : f.group === group.except)).map((f) => f.key);
  return (
    <div className="tl-gameplay__tab" aria-label={label}>
      <BackendError error={backendError} />
      {error !== null && (
        <div className="tl-prop__error" role="alert">
          {error}
        </div>
      )}
      {settings === null && <p className="tl-note">Values shown are the defaults until the project's settings are known; only the field you change is sent.</p>}
      <ObjectFields
        desc={desc}
        value={current}
        path={[]}
        component="settings"
        ctx={fieldContext}
        skip={skip}
        onFail={setError}
        onEdit={(path, next) => {
          const key = String(path[0]);
          if (typeof next !== 'number') return setError(`${key}: a setting keeps a value (it cannot be removed)`);
          if (current[key] === next) return;
          setError(null);
          onSaveSettings({ [key]: next });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

type Tab = 'settings' | 'camera';
const TABS: readonly Tab[] = ['settings', 'camera'];

export function GameplayPanel(props: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('settings');
  const shown = tab;
  return (
    <div className="tl-panel tl-gameplay">
      <div className="tl-panel__title">Gameplay</div>
      <div className="tl-gameplay__tabs">
        {TABS.map((t) => (
          <button key={t} className={shown === t ? 'tl-btn is-active' : 'tl-btn'} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {shown === 'settings' &&
        (props.registry !== null ? (
          <SettingsFields settings={props.settings} backendError={props.backendError} onSaveSettings={props.onSaveSettings} registry={props.registry} fieldContext={props.fieldContext} group={{ except: RENDERING_SETTINGS_GROUP }} label="gameplay settings" />
        ) : (
          <p className="tl-note">Loading the settings…</p>
        ))}
      {shown === 'camera' && <CameraTab entities={props.entities} onSelectEntity={props.onSelectEntity} />}
    </div>
  );
}
