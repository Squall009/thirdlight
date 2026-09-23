/**
 * M3 gameplay authoring planning (packet 56; authoring.md §A2/§A3/§A8 rows
 * 1–4/6–10/12/19; commands.md §8.10/§8.11/§8.14).
 *
 * Pure client-side planning + preflight for the gameplay panels: game-config
 * drafting (`setGameConfig`), zone/spawn creation and editing
 * (`createEntity` with `components` / `setComponent` / `deleteEntity`),
 * camera-follow editing (`setComponent cameraFollow`) and the bounded six-key
 * settings panel (`setSettings`). The backend remains the sole authority —
 * every value here is a PREFLIGHT mirror of the contract tables (commands.md
 * §8.11 key registry; project-model §23.3/§23.4 bounds); the planning layer
 * decides WHAT command to issue (or `noop` for a no-change), never whether
 * the edit is legal. No DOM, no I/O, no Node builtins.
 *
 * The editor's boundary row keeps `project-model`/`commands` types-only, so
 * the registry/bounds tables are mirrored here (the same frozen values), and
 * the component value types are imported as types only.
 */

import type { GameZoneComponent, CameraFollowComponent } from '@thirdlight/project-model';
import type { ProjectedEntity } from './projection';

// ---------------------------------------------------------------------------
// Settings (commands.md §8.11 — the fixed six-key registry, mirrored)
// ---------------------------------------------------------------------------

export type SettingsKey =
  | 'gravity_y'
  | 'run_speed'
  | 'jump_velocity'
  | 'max_fall_speed'
  | 'max_slope_climb_deg'
  | 'min_slope_slide_deg';

export interface SettingsKeySpec {
  readonly key: SettingsKey;
  readonly type: 'number';
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly minExclusive?: boolean;
  readonly maxExclusive?: boolean;
  readonly unit: string;
}

/** The six bounded gameplay settings (commands.md §8.11, mirrored verbatim). */
export const GAMEPLAY_SETTINGS_KEYS: readonly SettingsKeySpec[] = [
  { key: 'gravity_y', type: 'number', default: -19.62, min: -100, max: -1, unit: 'm/s²' },
  { key: 'run_speed', type: 'number', default: 4, min: 0, minExclusive: true, max: 50, unit: 'm/s' },
  { key: 'jump_velocity', type: 'number', default: 7, min: 0, max: 50, unit: 'm/s' },
  { key: 'max_fall_speed', type: 'number', default: -30, min: -100, max: 0, maxExclusive: true, unit: 'm/s' },
  { key: 'max_slope_climb_deg', type: 'number', default: 45, min: 0, max: 89.9, unit: 'degrees' },
  { key: 'min_slope_slide_deg', type: 'number', default: 30, min: 0, max: 89.9, unit: 'degrees' },
] as const;

export const SETTINGS_KEY_NAMES: readonly SettingsKey[] = GAMEPLAY_SETTINGS_KEYS.map((s) => s.key);

export interface SettingsFieldError {
  key: SettingsKey;
  message: string;
}

/**
 * Parse the settings form (the touched keys as raw strings) against the
 * registry. `current` is the last-known settings map (tracked from applied
 * `setSettings` changes; `null` when the session has not observed one) — the
 * cross-field rule (`min_slope_slide_deg > max_slope_climb_deg`) is checked
 * against the RESULTING values (commands.md §8.11), so an untouched side of
 * the pair falls back to the current value, then the registry default.
 */
export function parseSettingsDraft(
  raw: Record<string, string>,
  current: Record<string, unknown> | null,
): { ok: true; values: Partial<Record<SettingsKey, number>> } | { ok: false; errors: SettingsFieldError[] } {
  const errors: SettingsFieldError[] = [];
  const values: Partial<Record<SettingsKey, number>> = {};
  for (const spec of GAMEPLAY_SETTINGS_KEYS) {
    const rawValue = raw[spec.key];
    if (rawValue === undefined) continue; // untouched key — never submitted
    const num = Number(rawValue);
    if (rawValue.trim() === '' || !Number.isFinite(num)) {
      errors.push({ key: spec.key, message: `${spec.key} must be a finite number` });
      continue;
    }
    let inRange = num >= spec.min && num <= spec.max;
    if (spec.minExclusive && num === spec.min) inRange = false;
    if (spec.maxExclusive && num === spec.max) inRange = false;
    if (!inRange) {
      errors.push({ key: spec.key, message: `${spec.key} must be within [${spec.min}, ${spec.max}]${spec.minExclusive ? ' (exclusive min)' : ''}${spec.maxExclusive ? ' (exclusive max)' : ''} ${spec.unit}` });
      continue;
    }
    values[spec.key] = num;
  }
  // The cross-field rule against the resulting map (untouched side ⇒ current
  // value ⇒ registry default).
  const slideRaw = values['min_slope_slide_deg'];
  const climbRaw = values['max_slope_climb_deg'];
  if (slideRaw !== undefined && climbRaw !== undefined && slideRaw > climbRaw) {
    errors.push({ key: 'min_slope_slide_deg', message: 'min_slope_slide_deg must not exceed max_slope_climb_deg' });
  } else if (slideRaw !== undefined) {
    const climb = climbRaw ?? (typeof current?.['max_slope_climb_deg'] === 'number' ? (current['max_slope_climb_deg'] as number) : GAMEPLAY_SETTINGS_KEYS[4]!.default);
    if (slideRaw > climb) errors.push({ key: 'min_slope_slide_deg', message: 'min_slope_slide_deg must not exceed max_slope_climb_deg' });
  } else if (climbRaw !== undefined) {
    const slide = (typeof current?.['min_slope_slide_deg'] === 'number' ? (current['min_slope_slide_deg'] as number) : GAMEPLAY_SETTINGS_KEYS[5]!.default);
    if (slide > climbRaw) errors.push({ key: 'max_slope_climb_deg', message: 'max_slope_climb_deg must not be below min_slope_slide_deg' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, values };
}

/**
 * The `setSettings` args for a parsed draft against the current map: only the
 * keys that actually change are submitted (a present key replaces its value;
 * absent keys are unchanged — commands.md §8.11). `noop` when nothing
 * differs (the backend would report `no_change`).
 */
export function planSetSettings(
  values: Partial<Record<SettingsKey, number>>,
  current: Record<string, unknown> | null,
): { kind: 'noop' } | { kind: 'commit'; args: { settings: Record<string, number> } } {
  const settings: Record<string, number> = {};
  for (const [key, value] of Object.entries(values) as [SettingsKey, number][]) {
    const prev = current?.[key];
    if (prev !== value) settings[key] = value;
  }
  if (Object.keys(settings).length === 0) return { kind: 'noop' };
  return { kind: 'commit', args: { settings } };
}

// ---------------------------------------------------------------------------
// Game config (authoring.md §A3.4; project-model §23.4 bounds, mirrored)
// ---------------------------------------------------------------------------

/** The §23.4 string bounds (title/objective/instructions). */
export const GAME_STRING_BOUNDS = { title: 64, objective: 160, instructions: 320 } as const;
/** The §23.10/§10.1 numeric length bound (meters) for level/killY. */
export const GAME_NUMBER_BOUND = 1e6;

export interface GameConfigDraft {
  title: string;
  objective: string;
  instructions: string;
  playerId: string;
  cameraId: string;
  spawnId: string;
  /** v3 only (phase 12 c: a v4 game has no level bounds or kill height — falls are script rules). */
  level?: { minX: number; maxX: number; minY: number; maxY: number };
  killY?: number;
}

/** The form's raw string fields (the panel's controlled inputs). */
export interface GameConfigForm {
  title: string;
  objective: string;
  instructions: string;
  playerId: string;
  cameraId: string;
  spawnId: string;
  minX: string;
  maxX: string;
  minY: string;
  maxY: string;
  killY: string;
}

export interface GameConfigFieldError {
  field: string;
  message: string;
}

function hasControlChars(s: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(s);
}

/**
 * Parse + preflight the game-config form (string bounds, ID syntax, finite
 * numbers, `minX < maxX`, `minY < maxY`, `killY < maxY`, `|v| <= 1e6`). The
 * reference ROLE rules (controller/camera/cameraFollow/spawn/goal) are
 * checked against the entities by {@link validateGameConfigReferences}.
 */
export function parseGameConfigForm(
  form: GameConfigForm,
  opts: { level: boolean } = { level: true },
): { ok: true; draft: GameConfigDraft } | { ok: false; errors: GameConfigFieldError[] } {
  const errors: GameConfigFieldError[] = [];
  for (const field of ['title', 'objective', 'instructions'] as const) {
    const max = GAME_STRING_BOUNDS[field];
    const v = form[field];
    if (v.length < 1 || v.length > max) errors.push({ field, message: `${field} must be 1-${max} characters of plain text` });
    else if (hasControlChars(v)) errors.push({ field, message: `${field} must not contain control characters` });
  }
  for (const field of ['playerId', 'cameraId', 'spawnId'] as const) {
    const v = form[field];
    if (v.length < 1 || v.length > 64 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v)) {
      errors.push({ field, message: `${field} must match the ID syntax (^[a-z0-9][a-z0-9_-]{0,63}$)` });
    }
  }
  const nums: Record<'minX' | 'maxX' | 'minY' | 'maxY' | 'killY', number | null> = { minX: null, maxX: null, minY: null, maxY: null, killY: null };
  for (const field of opts.level ? (['minX', 'maxX', 'minY', 'maxY', 'killY'] as const) : []) {
    const raw = form[field];
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) {
      nums[field] = null;
      errors.push({ field, message: `${field} must be a finite number` });
    } else if (Math.abs(n) > GAME_NUMBER_BOUND) {
      nums[field] = null;
      errors.push({ field, message: `${field} must satisfy |v| <= ${GAME_NUMBER_BOUND}` });
    } else {
      nums[field] = n;
    }
  }
  const minX = nums['minX'];
  const maxX = nums['maxX'];
  const minY = nums['minY'];
  const maxY = nums['maxY'];
  const killY = nums['killY'];
  if (minX !== null && maxX !== null && !(minX < maxX)) errors.push({ field: 'level', message: 'level must satisfy minX < maxX' });
  if (minY !== null && maxY !== null && !(minY < maxY)) errors.push({ field: 'level', message: 'level must satisfy minY < maxY' });
  if (killY !== null && maxY !== null && !(killY < maxY)) errors.push({ field: 'killY', message: 'killY must be strictly below level.maxY' });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      title: form.title,
      objective: form.objective,
      instructions: form.instructions,
      playerId: form.playerId,
      cameraId: form.cameraId,
      spawnId: form.spawnId,
      ...(opts.level ? { level: { minX: minX!, maxX: maxX!, minY: minY!, maxY: maxY! }, killY: killY! } : {}),
    },
  };
}

/**
 * The reference role rules against the projected scene (project-model §23.8
 * step 8, mirrored as preflight): `playerId` names the scene's controller
 * entity; `cameraId` names the camera entity, which must carry
 * `cameraFollow` while `content.game` is non-null; `spawnId` names a
 * `playerSpawn` entity; the scene needs at least one `role: "goal"` zone
 * (and at most one checkpoint).
 */
export function validateGameConfigReferences(draft: GameConfigDraft, entities: readonly ProjectedEntity[]): string[] {
  const out: string[] = [];
  const byId = new Map<string, ProjectedEntity>(entities.map((e) => [e.id, e]));
  const controllers = entities.filter((e) => e.controller === true);
  const player = byId.get(draft.playerId);
  if (!player) out.push('playerId must name an existing entity');
  else if (player.controller !== true) out.push('playerId must name the entity carrying the controller component');
  else if (controllers.length !== 1) out.push('the scene must carry exactly one controller entity');
  const camera = byId.get(draft.cameraId);
  if (!camera) out.push('cameraId must name an existing entity');
  else if (camera.kind !== 'camera') out.push('cameraId must name the camera entity');
  else if (camera.cameraFollow === undefined) out.push('the camera entity must carry cameraFollow while the game config is present');
  const spawn = byId.get(draft.spawnId);
  if (!spawn) out.push('spawnId must name an existing entity');
  else if (spawn.playerSpawn !== true) out.push('spawnId must name an entity carrying playerSpawn');
  const goals = entities.filter((e) => e.gameZone?.role === 'goal');
  if (goals.length < 1) out.push('the scene needs at least one goal zone');
  const checkpoints = entities.filter((e) => e.gameZone?.role === 'checkpoint');
  if (checkpoints.length > 1) out.push('the scene may carry at most one checkpoint zone');
  return out;
}

/**
 * The `setGameConfig` args for a draft (authoring.md §A3.4): a CREATE (the
 * block is absent) sends the COMPLETE canonical block — the §26/§23.4 fields
 * plus `cues` (all `null` at creation; the cue pickers are packet 57's and
 * edit the block partially later). An EDIT sends only the changed top-level
 * fields (each present field replaces the whole field; `level` replaces
 * whole when any bound changed). `noop` when the draft equals the current
 * block on every 56-owned field.
 */
export function planSetGameConfig(
  draft: GameConfigDraft,
  current: GameConfigLike | null,
): { kind: 'noop' } | { kind: 'commit'; args: { game: Record<string, unknown> } } {
  if (current === null) {
    return {
      kind: 'commit',
      args: {
        game: {
          // v3 carries level + killY (configVersion 1); v4 has neither (configVersion 2).
          configVersion: draft.level !== undefined ? 1 : 2,
          title: draft.title,
          objective: draft.objective,
          instructions: draft.instructions,
          playerId: draft.playerId,
          cameraId: draft.cameraId,
          spawnId: draft.spawnId,
          ...(draft.level !== undefined ? { level: { ...draft.level }, killY: draft.killY } : {}),
          cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
        },
      },
    };
  }
  const game: Record<string, unknown> = {};
  if (current.title !== draft.title) game['title'] = draft.title;
  if (current.objective !== draft.objective) game['objective'] = draft.objective;
  if (current.instructions !== draft.instructions) game['instructions'] = draft.instructions;
  if (current.playerId !== draft.playerId) game['playerId'] = draft.playerId;
  if (current.cameraId !== draft.cameraId) game['cameraId'] = draft.cameraId;
  if (current.spawnId !== draft.spawnId) game['spawnId'] = draft.spawnId;
  const l = current.level;
  const d = draft.level;
  if (d !== undefined && (l === undefined || l.minX !== d.minX || l.maxX !== d.maxX || l.minY !== d.minY || l.maxY !== d.maxY)) {
    game['level'] = { ...d };
  }
  if (draft.killY !== undefined && current.killY !== draft.killY) game['killY'] = draft.killY;
  if (Object.keys(game).length === 0) return { kind: 'noop' };
  return { kind: 'commit', args: { game } };
}

/**
 * The editor's structural view of the `GameConfig` block (the `queryGameConfig`
 * result). Structurally compatible with project-model's `GameConfig`; declared
 * locally because the boundary row keeps project-model types-only AND the
 * block arrives over the wire (the client never trusts its own types).
 */
export interface GameConfigLike {
  /** 1: v3 (level + killY); 2: v4 (neither). */
  configVersion: 1 | 2;
  title: string;
  objective: string;
  instructions: string;
  playerId: string;
  cameraId: string;
  spawnId: string;
  level?: { minX: number; maxX: number; minY: number; maxY: number };
  killY?: number;
  cues: { start: string | null; jump: string | null; checkpoint: string | null; death: string | null; goal: string | null };
}

// ---------------------------------------------------------------------------
// Zones + spawns (authoring.md §A3.1/§A3.2 rows 6–10; project-model §23.3.1)
// ---------------------------------------------------------------------------

export const ZONE_ROLES = ['hazard', 'checkpoint', 'goal', 'exit'] as const;
export type ZoneRole = (typeof ZONE_ROLES)[number];

/** UI placement defaults (not contract values; the sizes are within §23.3.1). */
export const DEFAULT_ZONE_SIZE: Record<ZoneRole, [number, number]> = {
  hazard: [1.5, 0.5],
  checkpoint: [1.5, 1.5],
  goal: [2, 2],
  exit: [1.5, 2.5],
};
/** The §23.3.1 span bound (0 < v <= 1e6); the UI keeps a 0.1 m drag floor. */
export const MAX_ZONE_SPAN = 1e6;
export const MIN_ZONE_SPAN_UI = 0.1;
/**
 * The default checkpoint activation appearance (project-model §23.3.1a):
 * `cueAssetId: null` = "use `content.game.cues.checkpoint`". The appearance
 * EDIT is packet 57's; a checkpoint add requires the fields in the same value
 * (authoring.md §A3.2), so the UI supplies these defaults.
 */
export const DEFAULT_CHECKPOINT_ACTIVATION = Object.freeze({
  emissive: '#1bc8ff',
  emissiveIntensity: 1.2,
  cueAssetId: null,
}) as { readonly emissive: string; readonly emissiveIntensity: number; readonly cueAssetId: string | null };

/** The projected view of a `gameZone` component (wire shape). */
export interface GameZoneView {
  role: ZoneRole;
  size: [number, number];
  safeSpawnId?: string;
  activation?: { emissive: string; emissiveIntensity: number; cueAssetId: string | null };
  /** Phase 12 (c) exit zones: scenes loaded / unloaded, and the spawn to move to. */
  load?: string[];
  unload?: string[];
  spawnId?: string;
}

export interface ZonePlanError {
  code: string;
  message: string;
}

/** The `createEntity` args that create a zone (authoring.md §A3.1 row 6–8). */
export interface ZoneCreateArgs {
  kind: 'group';
  name: string;
  transform: { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] };
  components: { gameZone: Record<string, unknown> };
}

/**
 * Plan a zone creation. A `checkpoint` requires `safeSpawnId` in the same
 * value (authoring.md §A3.2) and carries the default activation appearance.
 * The entity is a root `group` (no parent, unit scale, no rotation) so
 * `zone_transform_unsupported` cannot trigger on the authored transform.
 */
export function planCreateZone(
  opts: { role: ZoneRole; size: [number, number]; position: [number, number, number]; safeSpawnId?: string; name?: string },
): { ok: true; args: ZoneCreateArgs } | { ok: false; error: ZonePlanError } {
  if (!ZONE_ROLES.includes(opts.role)) return { ok: false, error: { code: 'field_value', message: 'role must be hazard | checkpoint | goal' } };
  const [w, h] = opts.size;
  for (const v of [w, h]) {
    if (!Number.isFinite(v) || v <= 0 || v > MAX_ZONE_SPAN) {
      return { ok: false, error: { code: 'field_value', message: `zone size must satisfy 0 < v <= ${MAX_ZONE_SPAN} meters` } };
    }
  }
  for (const v of opts.position) {
    if (!Number.isFinite(v)) return { ok: false, error: { code: 'field_value', message: 'zone position must hold finite numbers' } };
  }
  const gameZone: Record<string, unknown> = { role: opts.role, size: [w, h] };
  if (opts.role === 'checkpoint') {
    if (typeof opts.safeSpawnId !== 'string' || opts.safeSpawnId.length === 0) {
      return { ok: false, error: { code: 'field_missing', message: 'a checkpoint zone requires a safeSpawnId reference in the same edit' } };
    }
    gameZone['safeSpawnId'] = opts.safeSpawnId;
    gameZone['activation'] = { ...DEFAULT_CHECKPOINT_ACTIVATION };
  }
  return {
    ok: true,
    args: {
      kind: 'group',
      name: opts.name ?? `zone-${opts.role}`,
      transform: { position: [opts.position[0], opts.position[1], opts.position[2] ?? 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: { gameZone },
    },
  };
}

/** A single planned `setComponent` step for a zone edit. */
export interface ZoneEditStep {
  op: 'setComponent';
  entityId: string;
  args: { entityId: string; component: 'gameZone'; value: Record<string, unknown> | null };
}

/**
 * Plan a zone edit (authoring.md §A3.2). The merge semantics are the
 * backend's (a present field replaces the whole field; absent fields are
 * unchanged), so:
 *  - a switch TO checkpoint in one edit carries `safeSpawnId` + `activation`
 *    (required in the same value);
 *  - a switch AWAY from checkpoint cannot drop the checkpoint fields in one
 *    edit (the merge keeps them; the resulting state is
 *    `field_unexpected`) — the plan is the two-step remove-then-re-add
 *    (two commands, two revisions, two undo entries);
 *  - otherwise the plan is the partial value of the changed fields only.
 */
export function planEditZone(
  entityId: string,
  current: GameZoneView,
  next: { role?: ZoneRole; size?: [number, number]; safeSpawnId?: string },
): { kind: 'noop' } | { kind: 'edit'; steps: ZoneEditStep[] } {
  const role = next.role ?? current.role;
  const size = next.size ?? current.size;
  const safeSpawnId = next.safeSpawnId ?? current.safeSpawnId;
  const sizeChanged = next.size !== undefined && (next.size[0] !== current.size[0] || next.size[1] !== current.size[1]);
  const roleChanged = role !== current.role;
  const safeChanged = next.safeSpawnId !== undefined && next.safeSpawnId !== current.safeSpawnId;
  if (!roleChanged && !sizeChanged && !safeChanged) return { kind: 'noop' };
  for (const v of size) {
    if (!Number.isFinite(v) || v <= 0 || v > MAX_ZONE_SPAN) {
      return { kind: 'noop' }; // the backend reports field_value; the UI preflights first
    }
  }
  if (roleChanged && current.role === 'checkpoint') {
    // Two-step: remove the component, then re-add with the new role.
    const value: Record<string, unknown> = { role, size: [size[0], size[1]] };
    if (role === 'checkpoint') {
      if (!safeSpawnId) return { kind: 'noop' };
      value['safeSpawnId'] = safeSpawnId;
      value['activation'] = current.activation ? { ...current.activation } : { ...DEFAULT_CHECKPOINT_ACTIVATION };
    }
    return {
      kind: 'edit',
      steps: [
        { op: 'setComponent', entityId, args: { entityId, component: 'gameZone', value: null } },
        { op: 'setComponent', entityId, args: { entityId, component: 'gameZone', value } },
      ],
    };
  }
  const value: Record<string, unknown> = {};
  if (roleChanged) value['role'] = role;
  if (sizeChanged) value['size'] = [size[0], size[1]];
  if (role === 'checkpoint') {
    // Switching to checkpoint must carry the checkpoint fields in the same
    // value; a new reference on an existing checkpoint replaces it.
    if (current.role !== 'checkpoint' || safeChanged) {
      if (!safeSpawnId) return { kind: 'noop' };
      value['safeSpawnId'] = safeSpawnId;
      value['activation'] = current.activation ? { ...current.activation } : { ...DEFAULT_CHECKPOINT_ACTIVATION };
    }
  } else {
    // Non-checkpoint roles carry no safeSpawnId; a reference "change" alone
    // is a no-op (the size change, if any, still commits).
    if (!sizeChanged && !roleChanged) return { kind: 'noop' };
  }
  if (Object.keys(value).length === 0) return { kind: 'noop' };
  return { kind: 'edit', steps: [{ op: 'setComponent', entityId, args: { entityId, component: 'gameZone', value } }] };
}

/** The `createEntity` args that create a spawn marker (authoring.md row 10). */
export function planCreateSpawn(
  position: [number, number, number],
  name = 'spawn',
): { kind: 'group'; name: string; transform: { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] }; components: Record<string, unknown> } {
  return {
    kind: 'group',
    name,
    transform: { position: [position[0], position[1], position[2] ?? 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: { playerSpawn: {} },
  };
}

// ---------------------------------------------------------------------------
// Camera follow (authoring.md row 12; project-model §23.3.3 bounds, mirrored)
// ---------------------------------------------------------------------------

/** The §23.3.3 cameraFollow bounds (deadZone 0..1e6, smoothing 0..1, |bounds| <= 1e6, span >= 1e-6). */
export const CAMERA_FOLLOW_BOUNDS = { absMax: 1e6, minSpan: 1e-6 } as const;

export interface CameraFollowDraft {
  deadZone: { x: number; y: number };
  smoothing: number;
  /** Absent: the camera follows anywhere (v4). */
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface CameraFollowForm {
  deadZoneX: string;
  deadZoneY: string;
  smoothing: string;
  minX: string;
  maxX: string;
  minY: string;
  maxY: string;
}

export interface CameraFollowFieldError {
  field: string;
  message: string;
}

/** Parse + preflight the camera-follow form (the §23.3.3 bounds). */
export function parseCameraFollowForm(
  form: CameraFollowForm,
  opts: { bounded: boolean } = { bounded: true },
): { ok: true; draft: CameraFollowDraft } | { ok: false; errors: CameraFollowFieldError[] } {
  const errors: CameraFollowFieldError[] = [];
  const num = (field: string, raw: string, check: (n: number) => boolean, what: string): number | null => {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || !check(n)) {
      errors.push({ field, message: `${field} must be ${what}` });
      return null;
    }
    return n;
  };
  const abs = CAMERA_FOLLOW_BOUNDS.absMax;
  const span = CAMERA_FOLLOW_BOUNDS.minSpan;
  const dx = num('deadZoneX', form.deadZoneX, (n) => n >= 0 && n <= abs, `0 <= v <= ${abs}`);
  const dy = num('deadZoneY', form.deadZoneY, (n) => n >= 0 && n <= abs, `0 <= v <= ${abs}`);
  const sm = num('smoothing', form.smoothing, (n) => n >= 0 && n <= 1, '0 <= v <= 1');
  const bnum = (field: string, raw: string): number | null => (opts.bounded ? num(field, raw, (n) => Math.abs(n) <= abs, `|v| <= ${abs}`) : null);
  const minX = bnum('minX', form.minX);
  const maxX = bnum('maxX', form.maxX);
  const minY = bnum('minY', form.minY);
  const maxY = bnum('maxY', form.maxY);
  if (minX !== null && maxX !== null && (!(minX < maxX) || maxX - minX < span)) {
    errors.push({ field: 'bounds', message: `bounds must satisfy minX < maxX and maxX - minX >= ${span}` });
  }
  if (minY !== null && maxY !== null && (!(minY < maxY) || maxY - minY < span)) {
    errors.push({ field: 'bounds', message: `bounds must satisfy minY < maxY and maxY - minY >= ${span}` });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      deadZone: { x: dx!, y: dy! },
      smoothing: sm!,
      ...(opts.bounded ? { bounds: { minX: minX!, maxX: maxX!, minY: minY!, maxY: maxY! } } : {}),
    },
  };
}

/** The projected view of a `cameraFollow` component (wire shape). */
export type CameraFollowView = CameraFollowComponent;

/**
 * The `setComponent cameraFollow` args for a draft (row 12): an ADD (the
 * camera carries no cameraFollow yet) sends the complete value; an EDIT sends
 * the changed fields only (`deadZone`/`bounds` replace whole when any part
 * changed).
 */
export function planSetCameraFollow(
  entityId: string,
  current: CameraFollowView | null,
  draft: CameraFollowDraft,
): { kind: 'noop' } | { kind: 'commit'; args: { entityId: string; component: 'cameraFollow'; value: Record<string, unknown> } } {
  if (current === null) {
    return {
      kind: 'commit',
      args: {
        entityId,
        component: 'cameraFollow',
        value: {
          deadZone: { ...draft.deadZone },
          smoothing: draft.smoothing,
          ...(draft.bounds !== undefined ? { bounds: { ...draft.bounds } } : {}),
        },
      },
    };
  }
  const value: Record<string, unknown> = {};
  if (current.deadZone.x !== draft.deadZone.x || current.deadZone.y !== draft.deadZone.y) {
    value['deadZone'] = { ...draft.deadZone };
  }
  if (current.smoothing !== draft.smoothing) value['smoothing'] = draft.smoothing;
  const b = current.bounds;
  const d = draft.bounds;
  if (d !== undefined && (b === undefined || b.minX !== d.minX || b.maxX !== d.maxX || b.minY !== d.minY || b.maxY !== d.maxY)) value['bounds'] = { ...d };
  // Phase 12 (c): `null` removes the bounds (the camera then follows anywhere).
  if (d === undefined && b !== undefined) value['bounds'] = null;
  if (Object.keys(value).length === 0) return { kind: 'noop' };
  return { kind: 'commit', args: { entityId, component: 'cameraFollow', value } };
}

/**
 * The structural `GameZoneComponent`/`CameraFollowComponent` wire views used
 * by the planning layer are exported above; the projection stores the same
 * shapes. Re-exported for the panels:
 */
export type { GameZoneComponent, CameraFollowComponent };