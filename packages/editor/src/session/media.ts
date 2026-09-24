/**
 * M3 media/lighting/animation authoring planning (packet 57; authoring.md
 * §A8 rows 5/11/13/14/15/16/17/18/21).
 *
 * Pure: no DOM, no I/O, no Node builtins. The planning layer decides WHAT
 * command to issue (or `noop`); the backend remains the sole authority. The
 * bounds tables are local mirrors of the accepted contract values
 * (project-model §23.3.4/§23.3.5/§23.10; commands.md §3.1.9/§3.1.10/§8.5.1) —
 * the editor's boundary row keeps project-model types-only, so the frozen
 * numbers are mirrored here exactly as in `session/gameplay.ts` (packet 56).
 */
import type { GameConfigLike } from './gameplay';
import type { ProjectedEntity } from './projection';
import { CONTENT_STAGE_MAX } from '@thirdlight/protocol';

// ---------------------------------------------------------------------------
// Drop validation (row 18/21: `.glb` model, `.wav` audio)
// ---------------------------------------------------------------------------

export const MODEL_DROP_EXTENSION = '.glb';
/** An FBX is converted to GLB by the backend (headless Blender) at import. */
export const FBX_DROP_EXTENSION = '.fbx';
export const AUDIO_DROP_EXTENSION = '.wav';
/** Phase 9.4: standalone textures (the magic bytes are checked again at import). */
export const TEXTURE_DROP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
/** Phase 9.10: music (Ogg Vorbis/Opus, MP3; a long WAV imports with kind "music" through MCP). */
export const MUSIC_DROP_EXTENSIONS = ['.ogg', '.opus', '.mp3'] as const;

export type AssetKind = 'model' | 'audio' | 'texture' | 'music';

export interface MediaDropVerdict {
  ok: true;
  kind: AssetKind;
  displayName: string;
}

/**
 * Validate a dropped/selected media file BEFORE any network call (the
 * packet's "invalid drop" failure mode): the extension decides the kind,
 * 1 … 32 MiB (the stage bound). An invalid drop creates no stage and no job.
 */
export function validateMediaDrop(name: string, byteLength: number): MediaDropVerdict | { ok: false; error: { code: string; message: string } } {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  let kind: AssetKind | null = null;
  let ext = '';
  if (lower.endsWith(MODEL_DROP_EXTENSION)) {
    kind = 'model';
    ext = MODEL_DROP_EXTENSION;
  } else if (lower.endsWith(FBX_DROP_EXTENSION)) {
    kind = 'model';
    ext = FBX_DROP_EXTENSION;
  } else if (lower.endsWith(AUDIO_DROP_EXTENSION)) {
    kind = 'audio';
    ext = AUDIO_DROP_EXTENSION;
  } else {
    const t = TEXTURE_DROP_EXTENSIONS.find((e) => lower.endsWith(e));
    const m = MUSIC_DROP_EXTENSIONS.find((e) => lower.endsWith(e));
    if (t !== undefined) {
      kind = 'texture';
      ext = t;
    } else if (m !== undefined) {
      kind = 'music';
      ext = m;
    }
  }
  if (kind === null) {
    return {
      ok: false,
      error: { code: 'import_rejected', message: `only ${MODEL_DROP_EXTENSION} (glTF binary), ${FBX_DROP_EXTENSION} (converted to glTF), ${AUDIO_DROP_EXTENSION} (PCM WAV) and .png/.jpg/.webp (texture) and .ogg/.mp3 (music) files can be imported` },
    };
  }
  if (!Number.isInteger(byteLength) || byteLength < 1) {
    return { ok: false, error: { code: 'import_rejected', message: 'the dropped file is empty' } };
  }
  if (byteLength > CONTENT_STAGE_MAX) {
    return {
      ok: false,
      error: { code: 'stage_limits_exceeded', message: `the file is ${byteLength} bytes; the stage bound is ${CONTENT_STAGE_MAX}` },
    };
  }
  const displayName = trimmed.slice(0, trimmed.length - ext.length).slice(0, 128) || trimmed.slice(0, 128);
  return { ok: true, kind, displayName };
}

// ---------------------------------------------------------------------------
// Cue assignment (row 5): `setGameConfig` partial edit — the `cues` field
// replaces WHOLE (each present top-level field replaces the whole field), so
// the draft sends the full merged block with only the picked slots changed.
// ---------------------------------------------------------------------------

export const CUE_SLOTS = ['start', 'jump', 'checkpoint', 'death', 'goal'] as const;
export type CueSlot = (typeof CUE_SLOTS)[number];

/**
 * Plan the `setGameConfig` partial edit for the cue picker. `picks` maps each
 * slot to an assetId or `null`; slots absent from `picks` keep the current
 * value (a missing current block = all null). `noop` when nothing changes.
 */
export function planCueEdit(
  current: Pick<GameConfigLike, 'cues'> | null,
  picks: Partial<Record<CueSlot, string | null>>,
): { kind: 'noop' } | { kind: 'commit'; args: { cues: Record<CueSlot, string | null> } } {
  const before = current?.cues ?? { start: null, jump: null, checkpoint: null, death: null, goal: null };
  const next: Record<CueSlot, string | null> = {
    start: before.start,
    jump: before.jump,
    checkpoint: before.checkpoint,
    death: before.death,
    goal: before.goal,
  };
  for (const slot of CUE_SLOTS) {
    const pick = picks[slot];
    if (pick !== undefined) next[slot] = pick;
  }
  let changed = false;
  for (const slot of CUE_SLOTS) if (next[slot] !== before[slot]) changed = true;
  if (!changed) return { kind: 'noop' };
  return { kind: 'commit', args: { cues: next } };
}

// ---------------------------------------------------------------------------
// Light components (rows 13/14/16: the §23.3.4 rules)
// ---------------------------------------------------------------------------

export const LIGHT_INTENSITY_MAX = 8; // §23.3.4
export const LIGHT_DIRECTION_ABS_MAX = 1;
export const LIGHT_DIRECTION_MIN_NORM = 1e-6;

export interface LightView {
  type: 'directional' | 'ambient';
  color: string;
  intensity: number;
  direction?: [number, number, number];
  castShadow?: boolean;
}

export interface LightForm {
  type: 'directional' | 'ambient';
  color: string;
  intensity: string;
  directionX: string;
  directionY: string;
  directionZ: string;
  castShadow: boolean;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Normalize a `#rrggbb` color to the canonical lowercase form. */
export function canonicalColor(raw: string): string | null {
  if (!COLOR_RE.test(raw)) return null;
  return raw.toLowerCase();
}

/**
 * Parse + validate the light form (the §23.3.4 table): `#hex` color (canonical
 * lowercase), `0 <= intensity <= 8`; a directional light requires a direction
 * with each `|v| <= 1` and `||v|| >= 1e-6`; an ambient light carries neither a
 * direction nor `castShadow`. The directional default `castShadow` is `false`.
 */
export function parseLightForm(form: LightForm): { ok: true; value: LightView } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const color = canonicalColor(form.color);
  if (color === null) errors.push(`color must be #rrggbb (got "${form.color}")`);
  const intensity = Number(form.intensity);
  if (form.intensity.trim() === '' || !Number.isFinite(intensity) || intensity < 0 || intensity > LIGHT_INTENSITY_MAX) {
    errors.push(`intensity must be a finite number in [0, ${LIGHT_INTENSITY_MAX}]`);
  }
  if (form.type === 'directional') {
    const dx = Number(form.directionX);
    const dy = Number(form.directionY);
    const dz = Number(form.directionZ);
    const nums = [dx, dy, dz];
    if (!nums.every((n) => Number.isFinite(n))) {
      errors.push('direction must be three finite numbers [x, y, z]');
    } else {
      if (nums.some((n) => Math.abs(n) > LIGHT_DIRECTION_ABS_MAX)) {
        errors.push('each direction component must satisfy |v| <= 1');
      } else {
        const norm = Math.hypot(dx, dy, dz);
        if (norm < LIGHT_DIRECTION_MIN_NORM) {
          errors.push(`the direction norm must be >= ${LIGHT_DIRECTION_MIN_NORM}`);
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const value: LightView = {
    type: form.type,
    color: color as string,
    intensity,
  };
  if (form.type === 'directional') {
    value.direction = [Number(form.directionX), Number(form.directionY), Number(form.directionZ)];
    value.castShadow = form.castShadow;
  }
  return { ok: true, value };
}

function lightEquals(a: LightView, b: LightView): boolean {
  if (a.type !== b.type) return false;
  if (a.color !== b.color || a.intensity !== b.intensity) return false;
  const ad = a.direction ?? [0, 0, 0];
  const bd = b.direction ?? [0, 0, 0];
  if (ad[0] !== bd[0] || ad[1] !== bd[1] || ad[2] !== bd[2]) return false;
  return (a.castShadow ?? false) === (b.castShadow ?? false);
}

/**
 * Plan the `setComponent(light, …)` for the light form: an ADD sends the
 * complete value; an EDIT sends the changed fields only — a TYPE switch
 * sends the complete value (the directional-only fields appear/disappear).
 */
export function planSetLight(
  entityId: string,
  current: LightView | null,
  form: LightForm,
): { kind: 'noop' } | { kind: 'commit'; args: { entityId: string; component: 'light'; value: Partial<LightView> } } {
  const parsed = parseLightForm(form);
  if (!parsed.ok) return { kind: 'noop' };
  const next = parsed.value;
  if (current === null) {
    return { kind: 'commit', args: { entityId, component: 'light', value: next } };
  }
  if (lightEquals(current, next)) return { kind: 'noop' };
  const value: Record<string, unknown> = {};
  if (current.type !== next.type) {
    // A type switch replaces the whole field-dependent shape.
    return { kind: 'commit', args: { entityId, component: 'light', value: next } };
  }
  if (current.color !== next.color) value['color'] = next.color;
  if (current.intensity !== next.intensity) value['intensity'] = next.intensity;
  if (next.type === 'directional') {
    const cd = current.direction ?? [0, 0, 0];
    const nd = next.direction ?? [0, 0, 0];
    if (cd[0] !== nd[0] || cd[1] !== nd[1] || cd[2] !== nd[2]) value['direction'] = nd;
    if ((current.castShadow ?? false) !== (next.castShadow ?? false)) value['castShadow'] = next.castShadow;
  }
  if (Object.keys(value).length === 0) return { kind: 'noop' };
  return { kind: 'commit', args: { entityId, component: 'light', value: value as Partial<LightView> } };
}

/** The scene limit is one directional + one ambient light (§23.10). */
export function lightCounts(entities: readonly ProjectedEntity[]): { directional: number; ambient: number } {
  let directional = 0;
  let ambient = 0;
  for (const e of entities) {
    if (e.light?.type === 'directional') directional += 1;
    else if (e.light?.type === 'ambient') ambient += 1;
  }
  return { directional, ambient };
}

// ---------------------------------------------------------------------------
// Surface components + presets (rows 15/16: the §23.3.5 rules)
// ---------------------------------------------------------------------------

export const SURFACE_ROUGHNESS_MAX = 1;
export const SURFACE_METALNESS_MAX = 1;
export const SURFACE_EMISSIVE_INTENSITY_MAX = 4; // §23.3.1a/§23.3.5

export interface SurfaceView {
  color: string;
  roughness: number;
  metalness: number;
  emissive: string;
  emissiveIntensity: number;
}

export interface SurfaceForm {
  color: string;
  roughness: string;
  metalness: string;
  emissive: string;
  emissiveIntensity: string;
}

/** The three built-in preset names (§3.1.9, commands.md). */
export const SURFACE_PRESET_NAMES = ['matte-ground', 'hazard', 'beacon'] as const;
export type SurfacePresetName = (typeof SURFACE_PRESET_NAMES)[number];

/**
 * The frozen preset rows (a display mirror of project-model §23.3.1a's
 * `SURFACE_PRESETS` — the backend applies the authoritative row on
 * `applySurfacePreset`; the panel shows what will be applied).
 */
export const SURFACE_PRESETS: Readonly<Record<SurfacePresetName, SurfaceView>> = Object.freeze({
  'matte-ground': Object.freeze({ color: '#8a8f98', roughness: 0.95, metalness: 0, emissive: '#000000', emissiveIntensity: 0 }),
  hazard: Object.freeze({ color: '#d42a1e', roughness: 0.6, metalness: 0, emissive: '#400a06', emissiveIntensity: 0.6 }),
  beacon: Object.freeze({ color: '#1bc8ff', roughness: 0.4, metalness: 0, emissive: '#1bc8ff', emissiveIntensity: 1.4 }),
});

/**
 * Parse + validate the surface form (the §23.3.5 table): two `#hex` colors,
 * `0 <= roughness <= 1`, `0 <= metalness <= 1`, `0 <= emissiveIntensity <= 4`.
 */
export function parseSurfaceForm(form: SurfaceForm): { ok: true; value: SurfaceView } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const color = canonicalColor(form.color);
  if (color === null) errors.push(`color must be #rrggbb (got "${form.color}")`);
  const emissive = canonicalColor(form.emissive);
  if (emissive === null) errors.push(`emissive must be #rrggbb (got "${form.emissive}")`);
  const roughness = Number(form.roughness);
  const metalness = Number(form.metalness);
  const emissiveIntensity = Number(form.emissiveIntensity);
  if (!Number.isFinite(roughness) || roughness < 0 || roughness > SURFACE_ROUGHNESS_MAX) {
    errors.push(`roughness must be a finite number in [0, ${SURFACE_ROUGHNESS_MAX}]`);
  }
  if (!Number.isFinite(metalness) || metalness < 0 || metalness > SURFACE_METALNESS_MAX) {
    errors.push(`metalness must be a finite number in [0, ${SURFACE_METALNESS_MAX}]`);
  }
  if (!Number.isFinite(emissiveIntensity) || emissiveIntensity < 0 || emissiveIntensity > SURFACE_EMISSIVE_INTENSITY_MAX) {
    errors.push(`emissiveIntensity must be a finite number in [0, ${SURFACE_EMISSIVE_INTENSITY_MAX}]`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { color: color as string, roughness, metalness, emissive: emissive as string, emissiveIntensity } };
}

/**
 * Plan the `setComponent(surface, …)`: an ADD sends the complete value (the
 * §23.7 normalizer would fill defaults, but the panel always carries all five);
 * an EDIT sends the changed fields only.
 */
export function planSetSurface(
  entityId: string,
  current: SurfaceView | null,
  form: SurfaceForm,
): { kind: 'noop' } | { kind: 'commit'; args: { entityId: string; component: 'surface'; value: Partial<SurfaceView> } } {
  const parsed = parseSurfaceForm(form);
  if (!parsed.ok) return { kind: 'noop' };
  const next = parsed.value;
  if (current === null) {
    return { kind: 'commit', args: { entityId, component: 'surface', value: next } };
  }
  const value: Record<string, unknown> = {};
  if (current.color !== next.color) value['color'] = next.color;
  if (current.roughness !== next.roughness) value['roughness'] = next.roughness;
  if (current.metalness !== next.metalness) value['metalness'] = next.metalness;
  if (current.emissive !== next.emissive) value['emissive'] = next.emissive;
  if (current.emissiveIntensity !== next.emissiveIntensity) value['emissiveIntensity'] = next.emissiveIntensity;
  if (Object.keys(value).length === 0) return { kind: 'noop' };
  return { kind: 'commit', args: { entityId, component: 'surface', value: value as Partial<SurfaceView> } };
}

// ---------------------------------------------------------------------------
// Model animation profiles (rows 17/21: the §23.3.6 + §8.5.1 rules)
// ---------------------------------------------------------------------------

export const ANIMATION_ROLE_KEYS = ['idle', 'run', 'airborne'] as const;
export type AnimationRoleKey = (typeof ANIMATION_ROLE_KEYS)[number];
export const ANIMATION_PROFILE_BYTES_MAX = 4096; // §23.10

export interface AnimationRoleBinding {
  clipIndex: number;
  clipName: string;
}

export interface ModelAnimationForm {
  version: string;
  roles: Record<AnimationRoleKey, { clipIndex: string; clipName: string }>;
}

/**
 * Parse + validate the animation profile form: an integer `1 <= version <=
 * maxVersion`; each role binds `clipIndex` (a non-negative integer) + a
 * non-empty `clipName`; the serialized `roles` object stays within the
 * §23.10 `animation_profile_bytes` bound.
 */
export function parseModelAnimationForm(
  form: ModelAnimationForm,
  maxVersion: number,
): { ok: true; roles: Record<AnimationRoleKey, AnimationRoleBinding>; version: number } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const version = Number(form.version);
  if (!Number.isSafeInteger(version) || version < 1 || version > maxVersion) {
    errors.push(`version must be an integer in [1, ${maxVersion}]`);
  }
  const roles = {} as Record<AnimationRoleKey, AnimationRoleBinding>;
  for (const key of ANIMATION_ROLE_KEYS) {
    const b = form.roles[key];
    const clipIndex = Number(b.clipIndex);
    const clipName = b.clipName.trim();
    if (!Number.isSafeInteger(clipIndex) || clipIndex < 0) {
      errors.push(`${key}.clipIndex must be a non-negative integer`);
      continue;
    }
    if (clipName.length === 0) {
      errors.push(`${key}.clipName must name a clip of the version`);
      continue;
    }
    roles[key] = { clipIndex, clipName };
  }
  if (errors.length === 0) {
    const bytes = new TextEncoder().encode(JSON.stringify(roles)).length;
    if (bytes > ANIMATION_PROFILE_BYTES_MAX) {
      errors.push(`the serialized roles exceed the ${ANIMATION_PROFILE_BYTES_MAX}-byte bound`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, roles, version };
}

/**
 * Plan the `setComponent(modelAnimation, …)` for a model entity. The
 * `assetId` is fixed to the entity's model asset (the §23.8 step-5 conflict
 * rule — a mismatch is an `noop` here; the backend raises
 * `component_conflict/animation_asset`). The value is always the complete
 * component (three canonical fields).
 */
export function planSetModelAnimation(
  entityId: string,
  entity: ProjectedEntity,
  form: ModelAnimationForm,
  maxVersion: number,
): { kind: 'noop' } | { kind: 'commit'; args: { entityId: string; component: 'modelAnimation'; value: { assetId: string; version: number; roles: Record<AnimationRoleKey, AnimationRoleBinding> } } } {
  // The component sits only on a model entity and its assetId is fixed to the
  // entity's model asset (the §23.8 step-5 conflict rule — a non-model entity
  // is an `noop` here; the backend raises the structured conflict).
  const modelAssetId = entity.kind === 'model' ? entity.assetId ?? null : null;
  if (modelAssetId === null) return { kind: 'noop' };
  const parsed = parseModelAnimationForm(form, maxVersion);
  if (!parsed.ok) return { kind: 'noop' };
  const value = { assetId: modelAssetId, version: parsed.version, roles: parsed.roles };
  const current = entity.modelAnimation;
  if (
    current !== undefined &&
    current.assetId === value.assetId &&
    current.version === value.version &&
    JSON.stringify(current.roles) === JSON.stringify(value.roles)
  ) {
    return { kind: 'noop' };
  }
  return { kind: 'commit', args: { entityId, component: 'modelAnimation', value } };
}

/**
 * The §8.5.1 atomic animated reimport args: when the asset being reimported
 * is referenced by modelAnimation components, the `publishAsset` command
 * carries `animation: { entityId, roles }` for ONE of the referencing
 * entities (the command moves that entity's full component to the new
 * version + the new role bindings). A rejected reimport preserves the old
 * version AND the old component (the command is all-or-nothing).
 */
export function planAnimatedReimport(
  referencingEntityIds: readonly string[],
  chosenEntityId: string,
  roles: Record<AnimationRoleKey, AnimationRoleBinding>,
): { entityId: string; roles: Record<AnimationRoleKey, AnimationRoleBinding> } | null {
  if (referencingEntityIds.length === 0) return null;
  if (!referencingEntityIds.includes(chosenEntityId)) return null;
  return { entityId: chosenEntityId, roles };
}

// ---------------------------------------------------------------------------
// Checkpoint activation appearance (row 11: the §23.3.2 rules)
// ---------------------------------------------------------------------------

export const ACTIVATION_INTENSITY_MAX = 4;

export interface ActivationView {
  emissive: string;
  emissiveIntensity: number;
  cueAssetId: string | null;
}

export interface ActivationForm {
  emissive: string;
  emissiveIntensity: string;
  cueAssetId: string; // '' = null (use content.game.cues.checkpoint)
}

/**
 * Parse + validate the activation appearance form: a `#hex` emissive (canonical
 * lowercase), `0 <= intensity <= 4`, a cue reference that is either empty
 * (null — the run uses `content.game.cues.checkpoint`) or an asset ID. The
 * reference's audio-kind resolution is the backend's (the preflight below
 * checks it against the catalog view).
 */
export function parseActivationForm(form: ActivationForm): { ok: true; value: ActivationView } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const emissive = canonicalColor(form.emissive);
  if (emissive === null) errors.push(`emissive must be #rrggbb (got "${form.emissive}")`);
  const intensity = Number(form.emissiveIntensity);
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > ACTIVATION_INTENSITY_MAX) {
    errors.push(`emissiveIntensity must be a finite number in [0, ${ACTIVATION_INTENSITY_MAX}]`);
  }
  const cueAssetId = form.cueAssetId.trim();
  if (cueAssetId !== '' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(cueAssetId)) {
    errors.push('the cue reference must be empty or an asset ID');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { emissive: emissive as string, emissiveIntensity: intensity, cueAssetId: cueAssetId === '' ? null : cueAssetId } };
}

/**
 * The activation preflight against the catalog view: a non-null cue reference
 * must resolve to an `audio`-kind record (the `asset_reference_missing` /
 * `asset_kind_mismatch` the backend raises, mirrored as a panel error before
 * the command is sent).
 */
export function validateActivationCue(
  cueAssetId: string | null,
  assets: readonly { assetId: string; kind: string }[],
): string[] {
  if (cueAssetId === null) return [];
  const record = assets.find((a) => a.assetId === cueAssetId);
  if (record === undefined) return [`the cue reference "${cueAssetId}" resolves to no catalog record`];
  if (record.kind !== 'audio') return [`the cue reference "${cueAssetId}" must resolve to a kind "audio" asset (found ${record.kind})`];
  return [];
}

/**
 * Plan the `setComponent(gameZone, { activation })` partial edit (the merge
 * keeps the zone's role/size/safeSpawnId). `noop` when the form equals the
 * current activation.
 */
export function planSetActivation(
  entityId: string,
  current: ActivationView | null,
  form: ActivationForm,
): { kind: 'noop' } | { kind: 'commit'; args: { entityId: string; component: 'gameZone'; value: { activation: ActivationView } } } {
  const parsed = parseActivationForm(form);
  if (!parsed.ok) return { kind: 'noop' };
  const next = parsed.value;
  if (
    current !== null &&
    current.emissive === next.emissive &&
    current.emissiveIntensity === next.emissiveIntensity &&
    current.cueAssetId === next.cueAssetId
  ) {
    return { kind: 'noop' };
  }
  return { kind: 'commit', args: { entityId, component: 'gameZone', value: { activation: next } } };
}