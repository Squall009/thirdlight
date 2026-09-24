/**
 * Gameplay authoring panel (packet 56; authoring.md §A8 rows 1–4/6–10/12/19).
 *
 * Four tabs over the projected backend state:
 *  - **Game** — the `content.game` block (phase 15.1, v4: built from its
 *    descriptor like an Inspector section, cues included, one `setGameConfig`
 *    per edit; the form below stays for v3 blocks): title/objective/instructions, the
 *    typed player/camera/spawn reference pickers, the level bounds + `killY`
 *    (one `setGameConfig` per save — create is the complete block, edit is
 *    the changed top-level fields only, removal is `null`);
 *  - **Zones** — the `gameZone` entities (role/size; the checkpoint's
 *    safe-spawn reference + its default activation) + the `playerSpawn`
 *    markers (add at origin, place in the viewport with the zone tool,
 *    edit, remove — one command each; a checkpoint role switch is the
 *    two-step remove-then-re-add the merge semantics require);
 *  - **Camera** — phase 15.1: points at the camera object, whose lens and
 *    follow settings are Inspector sections (built from their descriptors);
 *  - **Settings** — the bounded six-key gameplay settings (seeded from the
 *    tracked map, or the registry defaults when the session has not observed
 *    a `setSettings` change — no accepted query returns settings values;
 *    only the touched keys are submitted).
 *
 * The backend projection is authoritative: every value renders from the
 * projection/client state; the panel PREFLIGHTS (the planning layer) and
 * surfaces its own preflight errors inline; every accepted edit issues a
 * typed command through the app's actions, and the app's single
 * `backendError` (the last failed command, explained) is shown at the top of
 * the active tab. Plain DOM text/inputs only (no project-supplied HTML).
 */
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ProjectedEntity } from '../session/projection';
import {
  GAMEPLAY_SETTINGS_KEYS,
  ZONE_ROLES,
  DEFAULT_ZONE_SIZE,
  MIN_ZONE_SPAN_UI,
  parseGameConfigForm,
  validateGameConfigReferences,
  planSetGameConfig,
  parseSettingsDraft,
  planSetSettings,
  planEditZone,
  type GameConfigLike,
  type GameConfigForm,
  type ZoneRole,
} from '../session/gameplay';
import type { ZoneTool } from '../viewport/zone-overlay';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { componentPatch, firstReference, normalize } from '../session/descriptor-fields';
import { ObjectFields, type FieldContext } from './DescriptorFields';

/** The app's single backend error (the last failed command, explained). */
export interface GameplayBackendError {
  code: string;
  message: string;
}

interface Props {
  entities: readonly ProjectedEntity[];
  gameConfig: GameConfigLike | null;
  gameConfigLoaded: boolean;
  settings: Record<string, unknown> | null;
  tool: ZoneTool | null;
  onArmTool: (tool: ZoneTool | null) => void;
  onSaveGameConfig: (game: Record<string, unknown> | null) => void;
  onAddZone: (role: ZoneRole, safeSpawnId: string | null) => void;
  onEditZone: (entityId: string, next: { role?: ZoneRole; size?: [number, number]; safeSpawnId?: string }) => void;
  onDeleteZone: (entityId: string) => void;
  onAddSpawn: () => void;
  onDeleteSpawn: (entityId: string) => void;
  /** Phase 15.1: select an object (the Camera tab points at the camera's Inspector sections). */
  onSelectEntity: (entityId: string) => void;
  /** Phase 15.1: the descriptors (the v4 game block form is built from its descriptor). */
  registry: DescriptorRegistry | null;
  fieldContext: FieldContext;
  onSaveSettings: (settings: Record<string, number>) => void;
  backendError: GameplayBackendError | null;
  /**
   * Phase 12 (c): a v4 project — the game block has no level bounds or kill
   * height (falls and deaths are script rules) and camera bounds are optional.
   */
  v4?: boolean;
}

function ErrorList({ title, errors, onDismiss }: { title?: string; errors: string[]; onDismiss: () => void }): JSX.Element | null {
  if (errors.length === 0) return null;
  return (
    <div className="tl-gameplay__errors" role="alert">
      {title && <div className="tl-gameplay__errors-title">{title}</div>}
      <ul>
        {errors.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
      <button className="tl-btn" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  );
}

/** A numeric form field (string state; parsed on save). */
function NumField({
  label,
  value,
  onChange,
  step = 0.5,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  step?: number;
}): JSX.Element {
  return (
    <label className="tl-field">
      <span className="tl-field__label">{label}</span>
      <input className="tl-input" type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Game tab
// ---------------------------------------------------------------------------

function seededForm(entities: readonly ProjectedEntity[]): GameConfigForm {
  let minX = -10;
  let maxX = 10;
  let minY = -4;
  let maxY = 8;
  let have = false;
  for (const e of entities) {
    if (e.kind === 'model' || e.kind === 'box') {
      have = true;
      minX = Math.min(minX, e.position[0] ?? 0) - 4;
      maxX = Math.max(maxX, e.position[0] ?? 0) + 4;
      minY = Math.min(minY, e.position[1] ?? 0) - 4;
      maxY = Math.max(maxY, e.position[1] ?? 0) + 4;
    }
  }
  void have;
  const playerCandidates = entities.filter((e) => e.controller === true);
  const cameraCandidates = entities.filter((e) => e.kind === 'camera');
  const spawnCandidates = entities.filter((e) => e.playerSpawn === true);
  return {
    title: 'Untitled game',
    objective: 'Reach the goal.',
    // Phase 15.5: the descriptor's neutral text (the old one named a W / Up jump no default binding has, and goes stale when the input is rebound).
    instructions: 'Move and jump.',
    playerId: playerCandidates[0]?.id ?? '',
    cameraId: cameraCandidates[0]?.id ?? '',
    spawnId: spawnCandidates[0]?.id ?? '',
    minX: String(minX),
    maxX: String(maxX),
    minY: String(minY),
    maxY: String(maxY),
    killY: String(minY - 2),
  };
}

function formFromConfig(g: GameConfigLike): GameConfigForm {
  return {
    title: g.title,
    objective: g.objective,
    instructions: g.instructions,
    playerId: g.playerId,
    cameraId: g.cameraId,
    spawnId: g.spawnId,
    minX: String(g.level?.minX ?? -10),
    maxX: String(g.level?.maxX ?? 10),
    minY: String(g.level?.minY ?? -4),
    maxY: String(g.level?.maxY ?? 8),
    killY: String(g.killY ?? -6),
  };
}

function GameTab({
  entities,
  gameConfig,
  gameConfigLoaded,
  backendError,
  onSaveGameConfig,
  v4,
}: {
  entities: readonly ProjectedEntity[];
  gameConfig: GameConfigLike | null;
  gameConfigLoaded: boolean;
  backendError: GameplayBackendError | null;
  onSaveGameConfig: (game: Record<string, unknown> | null) => void;
  v4: boolean;
}): JSX.Element {
  // v3 games carry level bounds + killY; v4 games have neither.
  const hasLevel = gameConfig !== null ? gameConfig.configVersion === 1 : !v4;
  const playerCandidates = entities.filter((e) => e.controller === true);
  const cameraCandidates = entities.filter((e) => e.kind === 'camera');
  const spawnCandidates = entities.filter((e) => e.playerSpawn === true);
  const [form, setForm] = useState<GameConfigForm>(() => (gameConfig !== null ? formFromConfig(gameConfig) : seededForm(entities)));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Re-sync the form when the backend block changes and the form is clean
  // (an MCP-origin edit converges without a reload — sessions.md §6.2).
  useEffect(() => {
    if (dirty) return;
    if (gameConfig !== null) setForm(formFromConfig(gameConfig));
  }, [gameConfig, dirty]);

  const set = (field: keyof GameConfigForm, v: string): void => {
    setForm((f) => ({ ...f, [field]: v }));
    setDirty(true);
  };

  const save = (): void => {
    const parsed = parseGameConfigForm(form, { level: hasLevel });
    if (!parsed.ok) {
      setErrors(parsed.errors.map((e) => `${e.field}: ${e.message}`));
      return;
    }
    const refErrors = validateGameConfigReferences(parsed.draft, entities);
    if (refErrors.length > 0) {
      setErrors(refErrors);
      return;
    }
    const plan = planSetGameConfig(parsed.draft, gameConfig);
    if (plan.kind === 'noop') {
      setErrors([]);
      return;
    }
    setErrors([]);
    onSaveGameConfig(plan.args.game);
  };

  return (
    <div className="tl-gameplay__tab">
      {backendError !== null && (
        <div className="tl-gameplay__errors" role="alert">
          <div className="tl-gameplay__errors-title">
            {backendError.code}
          </div>
          <ul>
            <li>{backendError.message}</li>
          </ul>
        </div>
      )}
      {gameConfigLoaded && gameConfig === null && (
        <p className="tl-note">No game config yet — saving creates the complete block (cues are assigned in the media panel).</p>
      )}
      <ErrorList errors={errors} onDismiss={() => setErrors([])} />
      <label className="tl-field">
        <span className="tl-field__label">Title</span>
        <input className="tl-input" value={form.title} maxLength={64} onChange={(e) => set('title', e.target.value)} />
      </label>
      <label className="tl-field">
        <span className="tl-field__label">Objective</span>
        <textarea className="tl-input" value={form.objective} maxLength={160} onChange={(e) => set('objective', e.target.value)} />
      </label>
      <label className="tl-field">
        <span className="tl-field__label">Instructions (rendered by the play HUD as a text node)</span>
        <textarea className="tl-input" value={form.instructions} maxLength={320} onChange={(e) => set('instructions', e.target.value)} />
      </label>
      <label className="tl-field">
        <span className="tl-field__label">Player (the controller entity)</span>
        <select className="tl-input" value={form.playerId} onChange={(e) => set('playerId', e.target.value)}>
          <option value="">— select —</option>
          {playerCandidates.map((e) => (
            <option key={e.id} value={e.id}>
              {e.id}
            </option>
          ))}
        </select>
      </label>
      <label className="tl-field">
        <span className="tl-field__label">Camera (must carry cameraFollow)</span>
        <select className="tl-input" value={form.cameraId} onChange={(e) => set('cameraId', e.target.value)}>
          <option value="">— select —</option>
          {cameraCandidates.map((e) => (
            <option key={e.id} value={e.id}>
              {e.id}
              {e.cameraFollow === undefined ? ' (no cameraFollow)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="tl-field">
        <span className="tl-field__label">Start spawn (a playerSpawn entity)</span>
        <select className="tl-input" value={form.spawnId} onChange={(e) => set('spawnId', e.target.value)}>
          <option value="">— select —</option>
          {spawnCandidates.map((e) => (
            <option key={e.id} value={e.id}>
              {e.id}
            </option>
          ))}
        </select>
      </label>
      {hasLevel ? (
        <div className="tl-gameplay__grid">
          <NumField label="Level minX" value={form.minX} onChange={(v) => set('minX', v)} />
          <NumField label="Level maxX" value={form.maxX} onChange={(v) => set('maxX', v)} />
          <NumField label="Level minY" value={form.minY} onChange={(v) => set('minY', v)} />
          <NumField label="Level maxY" value={form.maxY} onChange={(v) => set('maxY', v)} />
          <NumField label="killY (below maxY)" value={form.killY} onChange={(v) => set('killY', v)} />
        </div>
      ) : (
        <p className="tl-note">No level bounds or kill height: a fall is a hazard zone or a script rule (a script can read positions with ctx.world and emit a respawn intent).</p>
      )}
      <div className="tl-gameplay__actions">
        <button className="tl-btn" onClick={save}>
          Save game config
        </button>
        {gameConfig !== null && (
          <button
            className="tl-btn tl-btn--danger"
            onClick={() => {
              setDirty(false);
              onSaveGameConfig(null);
            }}
          >
            Remove game config
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zones tab (zones + spawns)
// ---------------------------------------------------------------------------

interface ZoneRowState {
  role: ZoneRole;
  sizeX: string;
  sizeY: string;
  safeSpawnId: string;
}

function ZonesTab({
  entities,
  tool,
  backendError,
  onArmTool,
  onAddZone,
  onEditZone,
  onDeleteZone,
  onAddSpawn,
  onDeleteSpawn,
}: {
  entities: readonly ProjectedEntity[];
  tool: ZoneTool | null;
  backendError: GameplayBackendError | null;
  onArmTool: (tool: ZoneTool | null) => void;
  onAddZone: (role: ZoneRole, safeSpawnId: string | null) => void;
  onEditZone: (entityId: string, next: { role?: ZoneRole; size?: [number, number]; safeSpawnId?: string }) => void;
  onDeleteZone: (entityId: string) => void;
  onAddSpawn: () => void;
  onDeleteSpawn: (entityId: string) => void;
}): JSX.Element {
  const zones = entities.filter((e) => e.gameZone !== undefined);
  const spawns = entities.filter((e) => e.playerSpawn === true);
  const [newRole, setNewRole] = useState<ZoneRole>('hazard');
  const [newSafeSpawn, setNewSafeSpawn] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, ZoneRowState>>(() =>
    Object.fromEntries(
      zones.map((z) => {
        const gz = z.gameZone!;
        return [z.id, { role: gz.role, sizeX: String(gz.size[0]), sizeY: String(gz.size[1]), safeSpawnId: gz.safeSpawnId ?? '' }];
      }),
    ),
  );

  // Re-sync the row drafts when the scene changes (MCP convergence, undo).
  useEffect(() => {
    setRows(
      Object.fromEntries(
        zones.map((z) => {
          const gz = z.gameZone!;
          return [z.id, { role: gz.role, sizeX: String(gz.size[0]), sizeY: String(gz.size[1]), safeSpawnId: gz.safeSpawnId ?? '' }];
        }),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities]);

  const setRow = (id: string, patch: Partial<ZoneRowState>): void => {
    setRows((r) => ({ ...r, [id]: { ...r[id]!, ...patch } }));
  };

  const saveRow = (id: string): void => {
    const row = rows[id];
    const zone = zones.find((z) => z.id === id);
    if (!row || !zone?.gameZone) return;
    const pw = Number(row.sizeX);
    const ph = Number(row.sizeY);
    if (!Number.isFinite(pw) || pw < MIN_ZONE_SPAN_UI || pw > 1e6 || !Number.isFinite(ph) || ph < MIN_ZONE_SPAN_UI || ph > 1e6) {
      setErrors([`${id}: zone size must be finite in [${MIN_ZONE_SPAN_UI}, 1e6] meters`]);
      return;
    }
    if (row.role === 'checkpoint' && row.safeSpawnId.length === 0) {
      setErrors([`${id}: a checkpoint zone requires a safe-spawn reference`]);
      return;
    }
    const plan = planEditZone(id, zone.gameZone, { role: row.role, size: [pw, ph], safeSpawnId: row.safeSpawnId || undefined });
    if (plan.kind === 'noop') {
      setErrors([]);
      return;
    }
    setErrors([]);
    onEditZone(id, { role: row.role, size: [pw, ph], safeSpawnId: row.safeSpawnId || undefined });
  };

  const addZone = (): void => {
    if (newRole === 'checkpoint' && newSafeSpawn.length === 0) {
      setErrors(['a checkpoint zone requires a safe-spawn reference']);
      return;
    }
    setErrors([]);
    onAddZone(newRole, newSafeSpawn || null);
  };

  const checkpoints = zones.filter((z) => z.gameZone?.role === 'checkpoint');

  return (
    <div className="tl-gameplay__tab">
      {backendError !== null && (
        <div className="tl-gameplay__errors" role="alert">
          <div className="tl-gameplay__errors-title">
            {backendError.code}
          </div>
          <ul>
            <li>{backendError.message}</li>
          </ul>
        </div>
      )}
      <ErrorList errors={errors} onDismiss={() => setErrors([])} />
      <h3 className="tl-subhead">Zones</h3>
      {checkpoints.length > 1 && <p className="tl-note tl-note--warn">The scene may carry at most one checkpoint zone.</p>}
      {zones.length === 0 && <p className="tl-note">No zones yet. The scene needs at least one goal zone to save a game config.</p>}
      {zones.map((z) => {
        const row =
          rows[z.id] ?? { role: z.gameZone!.role, sizeX: String(z.gameZone!.size[0]), sizeY: String(z.gameZone!.size[1]), safeSpawnId: z.gameZone!.safeSpawnId ?? '' };
        return (
          <div className="tl-zone-row" key={z.id}>
            <span className="tl-zone-row__id" title={z.id}>
              {z.id}
            </span>
            <select className="tl-input" value={row.role} onChange={(e) => setRow(z.id, { role: e.target.value as ZoneRole })}>
              {ZONE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input
              className="tl-input tl-input--num"
              type="number"
              step={0.1}
              min={MIN_ZONE_SPAN_UI}
              title="width (m)"
              value={row.sizeX}
              onChange={(e) => setRow(z.id, { sizeX: e.target.value })}
            />
            <input
              className="tl-input tl-input--num"
              type="number"
              step={0.1}
              min={MIN_ZONE_SPAN_UI}
              title="height (m)"
              value={row.sizeY}
              onChange={(e) => setRow(z.id, { sizeY: e.target.value })}
            />
            {row.role === 'checkpoint' && (
              <select className="tl-input" title="safe spawn" value={row.safeSpawnId} onChange={(e) => setRow(z.id, { safeSpawnId: e.target.value })}>
                <option value="">— safe spawn —</option>
                {spawns.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                  </option>
                ))}
              </select>
            )}
            {row.role === 'checkpoint' && z.gameZone?.activation !== undefined && (
              <span className="tl-note" title="The activation appearance is edited in the media panel (packet 57)">
                activation {z.gameZone.activation.emissive} ×{z.gameZone.activation.emissiveIntensity}
                {z.gameZone.activation.cueAssetId ? ` cue:${z.gameZone.activation.cueAssetId}` : ''}
              </span>
            )}
            <button className="tl-btn" onClick={() => saveRow(z.id)}>
              Save
            </button>
            <button
              className="tl-btn tl-btn--danger"
              onClick={() => {
                setErrors([]);
                onDeleteZone(z.id);
              }}
            >
              Delete
            </button>
          </div>
        );
      })}
      <div className="tl-gameplay__add">
        <select className="tl-input" value={newRole} onChange={(e) => setNewRole(e.target.value as ZoneRole)}>
          {ZONE_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {newRole === 'checkpoint' && (
          <select className="tl-input" value={newSafeSpawn} onChange={(e) => setNewSafeSpawn(e.target.value)} title="safe spawn (required for a checkpoint)">
            <option value="">— safe spawn —</option>
            {spawns.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        )}
        <button className="tl-btn" onClick={addZone}>
          Add at origin
        </button>
        <button
          className={tool !== null ? 'tl-btn is-active' : 'tl-btn'}
          disabled={newRole === 'checkpoint' && newSafeSpawn.length === 0}
          onClick={() => onArmTool(tool !== null ? null : { kind: 'zone', role: newRole, safeSpawnId: newRole === 'checkpoint' ? newSafeSpawn : undefined })}
          title="Drag in the viewport to place the zone (Esc cancels; a plain click places the default size)"
        >
          Place in viewport
        </button>
        {tool !== null && <span className="tl-note">Placement armed — drag in the viewport (Esc cancels).</span>}
      </div>
      <h3 className="tl-subhead">Spawns</h3>
      {spawns.length === 0 && <p className="tl-note">No spawn markers yet. A game config needs a start spawn; checkpoints reference a safe spawn.</p>}
      {spawns.map((s) => (
        <div className="tl-zone-row" key={s.id}>
          <span className="tl-zone-row__id" title={s.id}>
            {s.id}
          </span>
          <span className="tl-note">playerSpawn marker</span>
          <button
            className="tl-btn tl-btn--danger"
            onClick={() => {
              setErrors([]);
              onDeleteSpawn(s.id);
            }}
          >
            Delete
          </button>
        </div>
      ))}
      <div className="tl-gameplay__add">
        <button
          className="tl-btn"
          onClick={() => {
            setErrors([]);
            onAddSpawn();
          }}
        >
          Add spawn at origin
        </button>
        <button
          className={tool !== null ? 'tl-btn is-active' : 'tl-btn'}
          onClick={() => onArmTool(tool !== null ? null : { kind: 'spawn' })}
          title="Click in the viewport to place the spawn (Esc cancels)"
        >
          Place in viewport
        </button>
      </div>
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
      <p className="tl-note">A camera's lens (field of view, near, far) and how it follows the player (dead zone, smoothing, bounds) are sections of the camera object in the Inspector.</p>
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
  entities,
  gameConfig,
  gameConfigLoaded,
  backendError,
  onSaveGameConfig,
  registry,
  fieldContext,
}: {
  entities: readonly ProjectedEntity[];
  gameConfig: GameConfigLike | null;
  gameConfigLoaded: boolean;
  backendError: GameplayBackendError | null;
  onSaveGameConfig: (game: Record<string, unknown> | null) => void;
  registry: DescriptorRegistry;
  fieldContext: FieldContext;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const desc = registry.content.find((b) => b.key === 'game')?.value;
  if (desc === undefined || desc.type !== 'object') return <p className="tl-note">The game block has no description.</p>;
  const current = gameConfig as unknown as Record<string, unknown> | null;
  const create = (): void => {
    // A complete block: the descriptor's starting values and the first player, camera and spawn.
    const first = (component: string): string | undefined => entities.find((e) => e.components[component] !== undefined)?.id;
    // The game camera is the one that follows the player (the game rules want camera follow on it).
    const picks = { playerId: first('controller'), cameraId: first('cameraFollow') ?? first('camera'), spawnId: first('playerSpawn') };
    const missing = Object.entries(picks).filter(([, v]) => v === undefined).map(([k]) => k.replace(/Id$/, ''));
    if (missing.length > 0) return setError(`the game needs a ${missing.join(', a ')} first (GameObject menu)`);
    setError(null);
    onSaveGameConfig(normalize(desc, { ...picks }));
  };
  return (
    <div className="tl-gameplay__tab" aria-label="game block">
      {backendError !== null && (
        <div className="tl-gameplay__errors" role="alert">
          <div className="tl-gameplay__errors-title">{backendError.code}</div>
          <ul>
            <li>{backendError.message}</li>
          </ul>
        </div>
      )}
      {error !== null && (
        <div className="tl-prop__error" role="alert">
          {error}
        </div>
      )}
      {gameConfigLoaded && current === null ? (
        <>
          <p className="tl-note">{desc.tooltip} This project has none yet.</p>
          <button className="tl-btn" onClick={create}>
            Create game block
          </button>
        </>
      ) : current !== null ? (
        <>
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
        </>
      ) : null}
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
      {backendError !== null && (
        <div className="tl-gameplay__errors" role="alert">
          <div className="tl-gameplay__errors-title">{backendError.code}</div>
          <ul>
            <li>{backendError.message}</li>
          </ul>
        </div>
      )}
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

function SettingsTab({
  settings,
  backendError,
  onSaveSettings,
}: {
  settings: Record<string, unknown> | null;
  backendError: GameplayBackendError | null;
  onSaveSettings: (settings: Record<string, number>) => void;
}): JSX.Element {
  const [raw, setRaw] = useState<Record<string, string>>(() =>
    Object.fromEntries(GAMEPLAY_SETTINGS_KEYS.map((s) => [s.key, settings !== null && s.key in settings ? String(settings[s.key] as number) : String(s.default)])),
  );
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    if (settings === null) return; // a fresh session seeds from the defaults
    setRaw(Object.fromEntries(GAMEPLAY_SETTINGS_KEYS.map((s) => [s.key, s.key in settings ? String(settings[s.key] as number) : String(s.default)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const save = (): void => {
    // The touched keys are the fields whose text differs from the SEED value
    // (the tracked value or the registry default) — untouched keys are never
    // submitted (the partial `setSettings` semantics preserve them).
    const seed = (key: (typeof GAMEPLAY_SETTINGS_KEYS)[number]['key']): string =>
      settings !== null && key in settings ? String(settings[key] as number) : String(GAMEPLAY_SETTINGS_KEYS.find((s) => s.key === key)!.default);
    const touched: Record<string, string> = {};
    for (const spec of GAMEPLAY_SETTINGS_KEYS) {
      const v = raw[spec.key];
      if (v !== undefined && v !== seed(spec.key)) touched[spec.key] = v;
    }
    const parsed = parseSettingsDraft(touched, settings);
    if (!parsed.ok) {
      setErrors(parsed.errors.map((e) => `${e.key}: ${e.message}`));
      return;
    }
    const plan = planSetSettings(parsed.values, settings);
    if (plan.kind === 'noop') {
      setErrors([]);
      return;
    }
    setErrors([]);
    onSaveSettings(plan.args.settings);
  };

  return (
    <div className="tl-gameplay__tab">
      {backendError !== null && (
        <div className="tl-gameplay__errors" role="alert">
          <div className="tl-gameplay__errors-title">
            {backendError.code}
          </div>
          <ul>
            <li>{backendError.message}</li>
          </ul>
        </div>
      )}
      {settings === null && (
        <p className="tl-note">
          Values seeded from the registry defaults — no accepted query returns settings values, so a fresh session cannot read the project's
          current settings. Only the fields you change are submitted (the rest are preserved).
        </p>
      )}
      <ErrorList errors={errors} onDismiss={() => setErrors([])} />
      <div className="tl-gameplay__grid">
        {GAMEPLAY_SETTINGS_KEYS.map((spec) => (
          <NumField key={spec.key} label={`${spec.key} (${spec.unit})`} value={raw[spec.key] ?? ''} onChange={(v) => setRaw((r) => ({ ...r, [spec.key]: v }))} />
        ))}
      </div>
      <div className="tl-gameplay__actions">
        <button className="tl-btn" onClick={save}>
          Save settings
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

type Tab = 'game' | 'zones' | 'camera' | 'settings';

export function GameplayPanel(props: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('game');
  return (
    <div className="tl-panel tl-gameplay">
      <div className="tl-panel__title">Gameplay</div>
      <div className="tl-gameplay__tabs">
        {(['game', 'zones', 'camera', 'settings'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'tl-btn is-active' : 'tl-btn'} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'game' && props.v4 === true && props.registry !== null && (
        <GameBlockTab
          entities={props.entities}
          gameConfig={props.gameConfig}
          gameConfigLoaded={props.gameConfigLoaded}
          backendError={props.backendError}
          onSaveGameConfig={props.onSaveGameConfig}
          registry={props.registry}
          fieldContext={props.fieldContext}
        />
      )}
      {tab === 'game' && !(props.v4 === true && props.registry !== null) && (
        <GameTab
          entities={props.entities}
          gameConfig={props.gameConfig}
          gameConfigLoaded={props.gameConfigLoaded}
          backendError={props.backendError}
          onSaveGameConfig={props.onSaveGameConfig}
          v4={props.v4 === true}
        />
      )}
      {tab === 'zones' && (
        <ZonesTab
          entities={props.entities}
          tool={props.tool}
          backendError={props.backendError}
          onArmTool={props.onArmTool}
          onAddZone={props.onAddZone}
          onEditZone={props.onEditZone}
          onDeleteZone={props.onDeleteZone}
          onAddSpawn={props.onAddSpawn}
          onDeleteSpawn={props.onDeleteSpawn}
        />
      )}
      {tab === 'camera' && <CameraTab entities={props.entities} onSelectEntity={props.onSelectEntity} />}
      {tab === 'settings' && props.registry !== null && (
        <SettingsBlockTab settings={props.settings} backendError={props.backendError} onSaveSettings={props.onSaveSettings} registry={props.registry} fieldContext={props.fieldContext} />
      )}
      {tab === 'settings' && props.registry === null && <SettingsTab settings={props.settings} backendError={props.backendError} onSaveSettings={props.onSaveSettings} />}
    </div>
  );
}

/** The zone tool's default size for a role (the placement fallback). */
export function defaultZoneSize(role: ZoneRole): [number, number] {
  return [...DEFAULT_ZONE_SIZE[role]] as [number, number];
}