/**
 * The Gameplay panel (packet 56; phase 24.5: generic) over the projected
 * backend state:
 *  - **Settings** — the project settings (the character's physics and the
 *    engine settings), built from their descriptor; each edit is one partial
 *    `setSettings`;
 *  - **Camera** — points at the camera objects, whose lens and follow settings
 *    are Inspector sections (built from their descriptors);
 *  - **Game session** — only while the project still has a `content.game`
 *    block (a platformer session, removed in phase 24.7): the block built
 *    from its descriptor. A new project has none and none is created here.
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
import type { GameConfigLike } from '../session/gameplay';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { componentPatch, firstReference } from '../session/descriptor-fields';
import { ObjectFields, type FieldContext } from './DescriptorFields';

/** The app's single backend error (the last failed command, explained). */
export interface GameplayBackendError {
  code: string;
  message: string;
}

interface Props {
  entities: readonly ProjectedEntity[];
  gameConfig: GameConfigLike | null;
  settings: Record<string, unknown> | null;
  onSaveGameConfig: (game: Record<string, unknown> | null) => void;
  /** Phase 15.1: select an object (the Camera tab points at the camera's Inspector sections). */
  onSelectEntity: (entityId: string) => void;
  /** Phase 15.1: the descriptors (the settings and the game block are built from them). */
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
// Camera tab (phase 15.1: the camera and its follow settings are Inspector
// sections of the camera object; this tab points there)
// ---------------------------------------------------------------------------

function CameraTab({ entities, onSelectEntity }: { entities: readonly ProjectedEntity[]; onSelectEntity: (id: string) => void }): JSX.Element {
  const cameras = entities.filter((e) => e.kind === 'camera');
  return (
    <div className="tl-gameplay__tab">
      <p className="tl-note">A camera's lens (field of view, near, far) and how it follows the character (dead zone, smoothing, bounds) are sections of the camera object in the Inspector.</p>
      {cameras.length === 0 && <p className="tl-note">No camera in the open scenes (GameObject → Camera).</p>}
      {cameras.map((c) => (
        <div className="tl-gameplay__actions" key={c.id}>
          <span>{c.name}{c.cameraFollow === undefined ? ' (no camera follow)' : ''}</span>
          <button className="tl-btn" onClick={() => onSelectEntity(c.id)}>
            Select
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Game tab, v4 (phase 15.1): the `game` block built from its descriptor
// ---------------------------------------------------------------------------

function GameBlockTab({
  gameConfig,
  backendError,
  onSaveGameConfig,
  registry,
  fieldContext,
}: {
  gameConfig: GameConfigLike;
  backendError: GameplayBackendError | null;
  onSaveGameConfig: (game: Record<string, unknown> | null) => void;
  registry: DescriptorRegistry;
  fieldContext: FieldContext;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const desc = registry.content.find((b) => b.key === 'game')?.value;
  if (desc === undefined || desc.type !== 'object') return <p className="tl-note">The game block has no description.</p>;
  const current = gameConfig as unknown as Record<string, unknown>;
  return (
    <div className="tl-gameplay__tab" aria-label="game block">
      <BackendError error={backendError} />
      {error !== null && (
        <div className="tl-prop__error" role="alert">
          {error}
        </div>
      )}
      <p className="tl-note">This project has a game session block (removed in phase 24.7: build the game's rules as project scripts over the generic components).</p>
      <ObjectFields
        desc={desc}
        value={current}
        path={[]}
        component="game"
        ctx={fieldContext}
        onFail={setError}
        onEdit={(path, next) => {
          setError(null);
          const patch = componentPatch(desc, current, path, next, { pick: (f) => firstReference(f, fieldContext) });
          if (patch !== null) onSaveGameConfig(patch);
        }}
      />
      <div className="tl-gameplay__actions">
        <button className="tl-btn tl-btn--danger" onClick={() => onSaveGameConfig(null)}>
          Remove game block
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

/**
 * The settings built from their descriptor (integration of 15.1 + 15.3):
 * every registry key, the engine settings included (a choice of numbers is a
 * select). Each edit is one partial `setSettings`; a setting cannot be
 * removed (the command has no removal), so an emptied field is refused here.
 */
function SettingsBlockTab({
  settings,
  backendError,
  onSaveSettings,
  registry,
  fieldContext,
}: {
  settings: Record<string, unknown> | null;
  backendError: GameplayBackendError | null;
  onSaveSettings: (settings: Record<string, number>) => void;
  registry: DescriptorRegistry;
  fieldContext: FieldContext;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const desc = registry.content.find((b) => b.key === 'settings')?.value;
  if (desc === undefined || desc.type !== 'object') return <p className="tl-note">The settings have no description.</p>;
  const current = settings ?? {};
  return (
    <div className="tl-gameplay__tab" aria-label="gameplay settings">
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

type Tab = 'settings' | 'camera' | 'game';

export function GameplayPanel(props: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('settings');
  const tabs: Tab[] = props.gameConfig !== null ? ['settings', 'camera', 'game'] : ['settings', 'camera'];
  const shown: Tab = tabs.includes(tab) ? tab : 'settings';
  return (
    <div className="tl-panel tl-gameplay">
      <div className="tl-panel__title">Gameplay</div>
      <div className="tl-gameplay__tabs">
        {tabs.map((t) => (
          <button key={t} className={shown === t ? 'tl-btn is-active' : 'tl-btn'} onClick={() => setTab(t)}>
            {t === 'game' ? 'game session' : t}
          </button>
        ))}
      </div>
      {shown === 'settings' &&
        (props.registry !== null ? (
          <SettingsBlockTab settings={props.settings} backendError={props.backendError} onSaveSettings={props.onSaveSettings} registry={props.registry} fieldContext={props.fieldContext} />
        ) : (
          <p className="tl-note">Loading the settings…</p>
        ))}
      {shown === 'camera' && <CameraTab entities={props.entities} onSelectEntity={props.onSelectEntity} />}
      {shown === 'game' && props.gameConfig !== null && props.registry !== null && (
        <GameBlockTab gameConfig={props.gameConfig} backendError={props.backendError} onSaveGameConfig={props.onSaveGameConfig} registry={props.registry} fieldContext={props.fieldContext} />
      )}
    </div>
  );
}
