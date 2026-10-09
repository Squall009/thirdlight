/**
 * Environment presets — named snapshots of the look a
 * game can switch or blend to at run time (`environment.presets`, project
 * content):
 *
 * - `sky`, `fog`, `heightFog`: a whole sky / fog (the environment's own
 *   shapes; a preset without one keeps the base's — the active scene's look);
 * - `post`: merged per effect over the base's post (exposure, tone mapping,
 *   grading, bloom, vignette, …);
 * - `lights`: colour / intensity / direction / ground colour for the scene
 *   lights an entry matches — by `entity` id, by `tag` name or by light
 *   `type` (e.g. every ambient or hemisphere light), or every light when it
 *   names none; later entries win per
 *   field; a light no entry matches keeps its authored values;
 * - `lightmap`: an intensity and tint multiplier on baked lightmaps: a bake
 *   holds the light of the moment it was baked, so a preset
 *   that darkens the lights darkens the baked surfaces with this;
 * - `wetness`: the scene's wetness (rain) under this look.
 *
 * A patch (`ctx.environment.set(id, { override })`) is the same shape
 * without id and name; its parts merge one level deep over the preset's.
 *
 * Pure: no I/O.
 */
import { ID_RE } from './validate';
import type { ModelErrorV2 } from './errors';
import { canonicalSceneEnvironment, validateFog, validateHeightFog, validatePost, validateSky, validateWetness, type FogConfig, type HeightFogConfig, type PostConfig, type SkyConfig } from './materials';

/** Engine limits of environment presets (documented in docs/manual/features/environment.md). */
export const ENVIRONMENT_PRESET_LIMITS = Object.freeze({
  /** Light entries per preset. */
  lights: 32,
  /** A light entry's intensity (three's units: candela for point/spot lights). */
  intensity: 1000,
  /** Lightmap intensity multiplier. */
  lightmapIntensity: 8,
});

export const ENVIRONMENT_LIGHT_TYPES = ['directional', 'ambient', 'point', 'spot', 'hemisphere'] as const;
export type EnvironmentLightType = (typeof ENVIRONMENT_LIGHT_TYPES)[number];

/** One light entry: which lights (one of entity / tag / type; none: every light) and the values it sets. */
export interface EnvironmentPresetLight {
  entity?: string;
  tag?: string;
  type?: EnvironmentLightType;
  color?: string;
  intensity?: number;
  /** Directional/spot: where the light points ([x, y, z], not all 0). */
  direction?: [number, number, number];
  /** Hemisphere: the ground colour. */
  groundColor?: string;
}

export interface EnvironmentPresetLightmap {
  /** Multiplies the baked light (absent: 1). */
  intensity?: number;
  /** Tints the baked light (absent: white). */
  tint?: string;
}

/** The look parts a preset (or a script's patch) sets. */
export interface EnvironmentLookParts {
  sky?: SkyConfig;
  fog?: FogConfig;
  heightFog?: HeightFogConfig;
  post?: PostConfig;
  lights?: EnvironmentPresetLight[];
  lightmap?: EnvironmentPresetLightmap;
  /** The scene's wetness under this look (0–1; absent: the base look's). */
  wetness?: number;
}

export interface EnvironmentPreset extends EnvironmentLookParts {
  presetId: string;
  name: string;
}
const COLOR_RE = /^#[0-9a-f]{6}$/;
/** A tag name (content.ts TAG_NAME_RE). */
const TAG_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PART_KEYS = ['sky', 'fog', 'heightFog', 'post', 'lights', 'lightmap', 'wetness'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
const isColor = (v: unknown): boolean => typeof v === 'string' && COLOR_RE.test(v.toLowerCase());
const num = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function validateLight(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'a preset light is an object { entity | tag | type, color?, intensity?, direction?, groundColor? }', value);
    return;
  }
  const allowed = ['entity', 'tag', 'type', 'color', 'intensity', 'direction', 'groundColor'];
  for (const k of Object.keys(value)) if (!allowed.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown preset light field "${k}"`, k, allowed.join(', '));
  const targets = ['entity', 'tag', 'type'].filter((k) => value[k] !== undefined);
  if (targets.length > 1) err(errors, 'field_value', path, 'a preset light names at most one of entity, tag or type (none: every light)', targets.join(', '), 'one of entity, tag, type');
  if (value['entity'] !== undefined && (typeof value['entity'] !== 'string' || !ID_RE.test(value['entity']))) err(errors, 'id_invalid', `${path}/entity`, 'entity is an entity id', value['entity']);
  if (value['tag'] !== undefined && (typeof value['tag'] !== 'string' || !TAG_RE.test(value['tag']))) err(errors, 'field_value', `${path}/tag`, 'tag is a tag name (a letter, then letters, digits, _ or -; 1-32 characters)', value['tag']);
  if (value['type'] !== undefined && !(ENVIRONMENT_LIGHT_TYPES as readonly unknown[]).includes(value['type'])) err(errors, 'field_value', `${path}/type`, `type is one of ${ENVIRONMENT_LIGHT_TYPES.join(', ')}`, value['type']);
  if (value['color'] !== undefined && !isColor(value['color'])) err(errors, 'field_value', `${path}/color`, 'color must be a colour "#rrggbb"', value['color']);
  if (value['groundColor'] !== undefined && !isColor(value['groundColor'])) err(errors, 'field_value', `${path}/groundColor`, 'groundColor must be a colour "#rrggbb"', value['groundColor']);
  if (value['intensity'] !== undefined && !num(value['intensity'], 0, ENVIRONMENT_PRESET_LIMITS.intensity)) err(errors, 'field_value', `${path}/intensity`, `intensity must be a number in [0, ${ENVIRONMENT_PRESET_LIMITS.intensity}]`, value['intensity']);
  const d = value['direction'];
  if (d !== undefined && (!Array.isArray(d) || d.length !== 3 || !d.every((x) => num(x, -1, 1)) || Math.hypot(d[0] as number, d[1] as number, d[2] as number) < 1e-6)) {
    err(errors, 'field_value', `${path}/direction`, 'direction is [x, y, z], each in [-1, 1], not all 0', d);
  }
}

/** The look parts of a preset or a patch (`path` = the object's pointer). */
function validateParts(value: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  if (value['sky'] !== undefined) validateSky(value['sky'], `${path}/sky`, errors);
  if (value['fog'] !== undefined) validateFog(value['fog'], `${path}/fog`, errors);
  if (value['heightFog'] !== undefined) validateHeightFog(value['heightFog'], `${path}/heightFog`, errors);
  if (value['post'] !== undefined) validatePost(value['post'], `${path}/post`, errors);
  validateWetness(value['wetness'], `${path}/wetness`, errors);
  const lights = value['lights'];
  if (lights !== undefined) {
    if (!Array.isArray(lights) || lights.length > ENVIRONMENT_PRESET_LIMITS.lights) err(errors, 'field_value', `${path}/lights`, `lights is a list of at most ${ENVIRONMENT_PRESET_LIMITS.lights} entries`, Array.isArray(lights) ? lights.length : lights);
    else lights.forEach((l, i) => validateLight(l, `${path}/lights/${i}`, errors));
  }
  const lm = value['lightmap'];
  if (lm !== undefined) {
    if (!isPlainObject(lm)) err(errors, 'field_type', `${path}/lightmap`, 'lightmap is an object { intensity?, tint? }', lm);
    else {
      for (const k of Object.keys(lm)) if (k !== 'intensity' && k !== 'tint') err(errors, 'field_unexpected', `${path}/lightmap/${k}`, `unknown lightmap field "${k}"`, k, 'intensity, tint');
      if (lm['intensity'] !== undefined && !num(lm['intensity'], 0, ENVIRONMENT_PRESET_LIMITS.lightmapIntensity)) err(errors, 'field_value', `${path}/lightmap/intensity`, `intensity must be a number in [0, ${ENVIRONMENT_PRESET_LIMITS.lightmapIntensity}]`, lm['intensity']);
      if (lm['tint'] !== undefined && !isColor(lm['tint'])) err(errors, 'field_value', `${path}/lightmap/tint`, 'tint must be a colour "#rrggbb"', lm['tint']);
    }
  }
}

/** `environment.presets`: presets with unique ids. */
export function validateEnvironmentPresets(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) {
    err(errors, 'field_value', path, 'presets is a list of presets', value);
    return;
  }
  const seen = new Set<string>();
  value.forEach((p, i) => {
    const at = `${path}/${i}`;
    if (!isPlainObject(p)) {
      err(errors, 'field_type', at, 'a preset is an object { presetId, name, sky?, fog?, heightFog?, post?, lights?, lightmap?, wetness? }', p);
      return;
    }
    for (const k of Object.keys(p)) if (k !== 'presetId' && k !== 'name' && !(PART_KEYS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${at}/${k}`, `unknown preset field "${k}"`, k, `presetId, name, ${PART_KEYS.join(', ')}`);
    const id = p['presetId'];
    if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${at}/presetId`, 'presetId is an id (a-z, 0-9, _ -; 1-64 characters)', id);
    else if (seen.has(id)) err(errors, 'id_duplicate', `${at}/presetId`, `duplicate preset "${id}"`, id);
    else seen.add(id);
    const name = p['name'];
    if (typeof name !== 'string' || name.length < 1 || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) err(errors, 'field_value', `${at}/name`, 'name is 1-128 characters', name);
    validateParts(p, at, errors);
  });
}

/** A script's patch over a preset (`ctx.environment.set(id, { override })`). */
export function validateEnvironmentPatch(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, `an override is an object { ${PART_KEYS.join(', ')} } (each optional)`, value);
    return;
  }
  for (const k of Object.keys(value)) if (!(PART_KEYS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown override field "${k}"`, k, PART_KEYS.join(', '));
  // A patch's sky / fog merge over the preset's, so their required fields may be absent: check them on a filled-in copy.
  const filled: Record<string, unknown> = { ...value };
  if (isPlainObject(value['sky'])) filled['sky'] = { mode: 'gradient', ...value['sky'] };
  if (isPlainObject(value['fog'])) filled['fog'] = { mode: 'linear', color: '#ffffff', ...value['fog'] };
  if (isPlainObject(value['heightFog'])) filled['heightFog'] = { density: 0, color: '#ffffff', ...value['heightFog'] };
  validateParts(filled, path, errors);
}

function canonicalLight(l: EnvironmentPresetLight): EnvironmentPresetLight {
  return {
    ...(l.entity !== undefined ? { entity: l.entity } : {}),
    ...(l.tag !== undefined ? { tag: l.tag } : {}),
    ...(l.type !== undefined ? { type: l.type } : {}),
    ...(l.color !== undefined ? { color: l.color.toLowerCase() } : {}),
    ...(l.intensity !== undefined ? { intensity: l.intensity } : {}),
    ...(l.direction !== undefined ? { direction: [l.direction[0], l.direction[1], l.direction[2]] as [number, number, number] } : {}),
    ...(l.groundColor !== undefined ? { groundColor: l.groundColor.toLowerCase() } : {}),
  };
}

function canonicalParts(p: EnvironmentLookParts): EnvironmentLookParts {
  const look = canonicalSceneEnvironment({ ...(p.sky !== undefined ? { sky: p.sky } : {}), ...(p.fog !== undefined ? { fog: p.fog } : {}), ...(p.heightFog !== undefined ? { heightFog: p.heightFog } : {}), ...(p.post !== undefined ? { post: p.post } : {}) });
  return {
    ...(look.sky !== undefined ? { sky: look.sky } : {}),
    ...(look.fog !== undefined ? { fog: look.fog } : {}),
    ...(look.heightFog !== undefined ? { heightFog: look.heightFog } : {}),
    ...(look.post !== undefined ? { post: look.post } : {}),
    ...(p.lights !== undefined ? { lights: p.lights.map(canonicalLight) } : {}),
    ...(p.lightmap !== undefined
      ? { lightmap: { ...(p.lightmap.intensity !== undefined ? { intensity: p.lightmap.intensity } : {}), ...(p.lightmap.tint !== undefined ? { tint: p.lightmap.tint.toLowerCase() } : {}) } }
      : {}),
    ...(p.wetness !== undefined ? { wetness: p.wetness } : {}),
  };
}

/** Canonical order: the list's own order (it is the editor's order); fields in a fixed order. */
export function canonicalEnvironmentPresets(list: readonly EnvironmentPreset[]): EnvironmentPreset[] {
  return list.map((p) => ({ presetId: p.presetId, name: p.name, ...canonicalParts(p) }));
}

/** The texture assets presets name (sky images, grading LUTs). */
export function environmentPresetTextureRefs(list: readonly EnvironmentPreset[] | undefined): string[] {
  const out = new Set<string>();
  for (const p of list ?? []) {
    if (p.sky?.texture !== undefined) out.add(p.sky.texture);
    for (const id of p.sky?.cube ?? []) out.add(id);
    if (p.post?.grading?.lut !== undefined) out.add(p.post.grading.lut);
  }
  return [...out].sort();
}
