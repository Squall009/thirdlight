/**
 * Phase 9.4: project materials, the per-object material assignment and the
 * project environment (global wind).
 *
 * A material is a shader type plus overrides. On a model it starts from the
 * file's own material (its textures and values) and changes only what it sets;
 * on a box it starts from the shader's defaults. The shader types are a
 * closed set, each with a declared parameter schema and texture slots, so the
 * editor can build its inspector from the table and the runtime can build the
 * three.js material from the same names.
 *
 * Pure data rules: no three.js here (three-adapter keeps its own copy of the
 * defaults, like the surface presets).
 */
import type { ModelErrorV2 } from './errors';

export const MATERIAL_SHADERS = ['standard', 'foliage', 'kit', 'unlit', 'water'] as const;
export type MaterialShader = (typeof MATERIAL_SHADERS)[number];

export type MaterialParamType =
  | { readonly kind: 'number'; readonly min: number; readonly max: number; readonly default: number }
  | { readonly kind: 'color'; readonly default: string }
  | { readonly kind: 'bool'; readonly default: boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly default: string }
  | { readonly kind: 'vec2'; readonly min: number; readonly max: number; readonly default: readonly [number, number] };

export type MaterialParamValue = number | boolean | string | [number, number];

const num = (min: number, max: number, d: number): MaterialParamType => ({ kind: 'number', min, max, default: d });
const color = (d: string): MaterialParamType => ({ kind: 'color', default: d });
const bool = (d: boolean): MaterialParamType => ({ kind: 'bool', default: d });
const vec2 = (min: number, max: number, d: [number, number]): MaterialParamType => ({ kind: 'vec2', min, max, default: d });

const SURFACE_PARAMS: Readonly<Record<string, MaterialParamType>> = {
  color: color('#ffffff'),
  roughness: num(0, 1, 0.8),
  metalness: num(0, 1, 0),
  emissive: color('#000000'),
  emissiveIntensity: num(0, 16, 0),
  alphaMode: { kind: 'enum', values: ['opaque', 'cutout', 'blend'], default: 'opaque' },
  alphaCutoff: num(0, 1, 0.5),
  opacity: num(0, 1, 1),
  doubleSided: bool(false),
  tiling: vec2(0.001, 1000, [1, 1]),
  offset: vec2(-1000, 1000, [0, 0]),
  normalScale: num(0, 4, 1),
  aoIntensity: num(0, 2, 1),
};

/** The parameter schema of every shader type (absent in a material = keep the file's value / the default). */
export const MATERIAL_PARAMS: Readonly<Record<MaterialShader, Readonly<Record<string, MaterialParamType>>>> = {
  standard: SURFACE_PARAMS,
  // COLOR_0 drives the wind (Sprout's rule): R bend weight root→tip, G phase,
  // B flutter, A thinness (a cheap subsurface term).
  foliage: {
    ...SURFACE_PARAMS,
    doubleSided: bool(true),
    windBend: num(0, 4, 1),
    windFlutter: num(0, 4, 1),
    flutterFrequency: num(0, 30, 6),
    subsurface: num(0, 1, 0.3),
  },
  // uv0.x += worldX / uvPeriod so the detail atlas flows across joins; a macro
  // normal on UV1 is blended over the detail normal (whiteout).
  kit: {
    ...SURFACE_PARAMS,
    uvPeriod: num(0.25, 64, 4),
    macroNormalScale: num(0, 4, 1),
  },
  unlit: {
    color: color('#ffffff'),
    opacity: num(0, 1, 1),
    alphaMode: { kind: 'enum', values: ['opaque', 'cutout', 'blend'], default: 'opaque' },
    alphaCutoff: num(0, 1, 0.5),
    doubleSided: bool(false),
    tiling: vec2(0.001, 1000, [1, 1]),
    offset: vec2(-1000, 1000, [0, 0]),
    vertexTint: bool(false),
  },
  water: {
    color: color('#1d5f8a'),
    shallowColor: color('#4fb3c9'),
    opacity: num(0, 1, 0.8),
    roughness: num(0, 1, 0.1),
    normalScale: num(0, 4, 0.6),
    flow: vec2(-10, 10, [0.05, 0.02]),
    waveScale: num(0.01, 100, 2),
    fresnel: num(0, 10, 3),
    doubleSided: bool(false),
  },
};

/** The texture slots of every shader type (values: texture asset ids). */
export const MATERIAL_TEXTURE_SLOTS: Readonly<Record<MaterialShader, readonly string[]>> = {
  standard: ['map', 'normalMap', 'ormMap', 'emissiveMap'],
  foliage: ['map', 'normalMap', 'ormMap', 'emissiveMap'],
  kit: ['map', 'normalMap', 'ormMap', 'emissiveMap', 'macroNormalMap'],
  unlit: ['map'],
  water: ['normalMap'],
};

export interface MaterialDef {
  materialId: string;
  name: string;
  shader: MaterialShader;
  params: Record<string, MaterialParamValue>;
  textures: Record<string, string>;
}

/** Most materials per project. */
export const MAX_MATERIALS = 256;
/** Most material slots one object or asset maps. */
export const MAX_MATERIAL_SLOTS = 32;
/** The slot key that applies a material to every material of a model (and to a box). */
export const MATERIAL_SLOT_ALL = '*';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isName(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}

/** One parameter value against its schema (null = valid). */
export function materialParamError(type: MaterialParamType, v: unknown): string | null {
  switch (type.kind) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && v >= type.min && v <= type.max ? null : `a number in [${type.min}, ${type.max}]`;
    case 'color':
      return typeof v === 'string' && COLOR_RE.test(v) ? null : 'a colour "#rrggbb" (lowercase hex)';
    case 'bool':
      return typeof v === 'boolean' ? null : 'true or false';
    case 'enum':
      return typeof v === 'string' && type.values.includes(v) ? null : `one of ${type.values.join(', ')}`;
    case 'vec2':
      return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= type.min && x <= type.max)
        ? null
        : `two numbers in [${type.min}, ${type.max}]`;
  }
}

/** `content.materials`: at most 256 materials, unique ids, known shader params and slots. */
export function validateMaterials(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) {
    err(errors, 'field_type', path, 'materials must be an array', value, 'array of materials');
    return;
  }
  if (value.length > MAX_MATERIALS) err(errors, 'limits_exceeded', path, `a project has at most ${MAX_MATERIALS} materials`, value.length);
  const seen = new Set<string>();
  value.forEach((m, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(m)) {
      err(errors, 'field_type', p, 'a material is an object', m);
      return;
    }
    for (const k of Object.keys(m)) {
      if (!['materialId', 'name', 'shader', 'params', 'textures'].includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown material field "${k}"`, k, 'materialId, name, shader, params, textures');
    }
    const id = m['materialId'];
    if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${p}/materialId`, 'materialId uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', id);
    else if (seen.has(id)) err(errors, 'id_duplicate', `${p}/materialId`, 'materialId is used twice', id);
    else seen.add(id);
    if (!isName(m['name'])) err(errors, 'field_value', `${p}/name`, 'a material name is 1-128 characters without control characters', m['name']);
    const shader = m['shader'];
    if (typeof shader !== 'string' || !(MATERIAL_SHADERS as readonly string[]).includes(shader)) {
      err(errors, 'field_value', `${p}/shader`, `shader must be one of ${MATERIAL_SHADERS.join(', ')}`, shader);
      return;
    }
    const schema = MATERIAL_PARAMS[shader as MaterialShader];
    const params = m['params'];
    if (!isPlainObject(params)) err(errors, 'field_type', `${p}/params`, 'params is an object', params);
    else {
      for (const [k, v] of Object.entries(params)) {
        const type = schema[k];
        if (type === undefined) {
          err(errors, 'field_unexpected', `${p}/params/${k}`, `shader "${shader}" has no parameter "${k}"`, k, Object.keys(schema).join(', '));
          continue;
        }
        const bad = materialParamError(type, v);
        if (bad !== null) err(errors, 'field_value', `${p}/params/${k}`, `${k} must be ${bad}`, v, bad);
      }
    }
    const textures = m['textures'];
    if (!isPlainObject(textures)) err(errors, 'field_type', `${p}/textures`, 'textures is an object', textures);
    else {
      const slots = MATERIAL_TEXTURE_SLOTS[shader as MaterialShader];
      for (const [k, v] of Object.entries(textures)) {
        if (!slots.includes(k)) err(errors, 'field_unexpected', `${p}/textures/${k}`, `shader "${shader}" has no texture slot "${k}"`, k, slots.join(', '));
        else if (typeof v !== 'string' || !ID_RE.test(v)) err(errors, 'id_invalid', `${p}/textures/${k}`, 'a texture slot names a texture asset id', v);
      }
    }
  });
}

/** Canonical order: ascending materialId; params and textures by key. */
export function canonicalMaterials(list: readonly MaterialDef[]): MaterialDef[] {
  const sortKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k] as T]));
  return [...list]
    .sort((a, b) => (a.materialId < b.materialId ? -1 : a.materialId > b.materialId ? 1 : 0))
    .map((m) => ({
      materialId: m.materialId,
      name: m.name,
      shader: m.shader,
      params: sortKeys(Object.fromEntries(Object.entries(m.params).map(([k, v]) => [k, Array.isArray(v) ? [v[0], v[1]] as [number, number] : v]))),
      textures: sortKeys(m.textures),
    }));
}

/**
 * A material mapping (the `materials` component, and an asset's default
 * mapping): source material name (or "*" for all) → materialId.
 */
export function validateMaterialMapping(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'a material mapping is an object { <material name or "*">: materialId }', value);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length < 1 || keys.length > MAX_MATERIAL_SLOTS) err(errors, 'field_value', path, `a material mapping has 1-${MAX_MATERIAL_SLOTS} entries`, keys.length);
  for (const k of keys) {
    if (!isName(k)) err(errors, 'field_value', `${path}/${k}`, 'a slot is a material name (1-128 characters) or "*"', k);
    const v = value[k];
    if (typeof v !== 'string' || !ID_RE.test(v)) err(errors, 'id_invalid', `${path}/${k}`, 'a slot names a materialId', v);
  }
}

export function canonicalMaterialMapping(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k] as string]));
}

// ---- environment (global wind; sky/fog/post arrive in 9.5) ----------------------

export interface WindConfig {
  /** Horizontal direction [x, z] (normalized by the runtime; not both zero). */
  direction: [number, number];
  /** Base strength (0 = still air). */
  strength: number;
  /** Extra strength of gusts. */
  gust: number;
  /** Gusts per second. */
  gustFrequency: number;
  /** Small-scale variation over space (0-1). */
  turbulence: number;
}

/** Phase 9.5: the sky (background + image-based lighting). */
export interface SkyConfig {
  /** procedural: physically based (Preetham); gradient: three colours; texture: an equirect or six-face image; color: solid. */
  mode: 'procedural' | 'gradient' | 'texture' | 'color';
  turbidity?: number;
  rayleigh?: number;
  mieCoefficient?: number;
  mieDirectionalG?: number;
  /** true (default): the sun sits opposite the scene's directional light; false: sunElevation/sunAzimuth. */
  sunFromLight?: boolean;
  sunElevation?: number;
  sunAzimuth?: number;
  topColor?: string;
  horizonColor?: string;
  bottomColor?: string;
  color?: string;
  /** An equirectangular texture asset. */
  texture?: string;
  /** Six texture assets px, nx, py, ny, pz, nz (instead of `texture`). */
  cube?: [string, string, string, string, string, string];
  /** Background brightness. */
  intensity?: number;
  /** Image-based lighting strength from the sky (0 = none). */
  environmentIntensity?: number;
}

export interface FogConfig {
  mode: 'none' | 'linear' | 'exp2';
  color: string;
  near?: number;
  far?: number;
  density?: number;
}

export interface PostConfig {
  toneMapping?: 'none' | 'aces' | 'agx' | 'neutral';
  exposure?: number;
  bloom?: { enabled: boolean; strength?: number; radius?: number; threshold?: number };
  grading?: { contrast?: number; saturation?: number; brightness?: number; tint?: string; lut?: string };
  vignette?: { enabled: boolean; darkness?: number; offset?: number };
  ssao?: { enabled: boolean; radius?: number; intensity?: number };
  dof?: { enabled: boolean; focus?: number; aperture?: number; maxBlur?: number };
  antialias?: 'none' | 'fxaa' | 'smaa';
}

export interface EnvironmentConfig {
  wind?: WindConfig;
  sky?: SkyConfig;
  fog?: FogConfig;
  post?: PostConfig;
  /** The project's default quality level (players can change it in the settings menu). */
  quality?: 'low' | 'medium' | 'high';
}

export const DEFAULT_WIND: Readonly<WindConfig> = Object.freeze({ direction: [1, 0] as [number, number], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 });

export function validateEnvironment(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'environment is an object', value);
    return;
  }
  for (const k of Object.keys(value)) if (!['wind', 'sky', 'fog', 'post', 'quality'].includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown environment field "${k}"`, k, 'wind, sky, fog, post, quality');
  if (value['sky'] !== undefined) validateSky(value['sky'], `${path}/sky`, errors);
  if (value['fog'] !== undefined) validateFog(value['fog'], `${path}/fog`, errors);
  if (value['post'] !== undefined) validatePost(value['post'], `${path}/post`, errors);
  if (value['quality'] !== undefined && !['low', 'medium', 'high'].includes(value['quality'] as string)) err(errors, 'field_value', `${path}/quality`, 'quality is low, medium or high', value['quality']);
  const w = value['wind'];
  if (w === undefined) return;
  if (!isPlainObject(w)) {
    err(errors, 'field_type', `${path}/wind`, 'wind is an object', w);
    return;
  }
  const d = w['direction'];
  if (!Array.isArray(d) || d.length !== 2 || !d.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1) || (d[0] === 0 && d[1] === 0)) {
    err(errors, 'field_value', `${path}/wind/direction`, 'direction is [x, z], each in [-1, 1], not both 0', d);
  }
  const range: Record<string, [number, number]> = { strength: [0, 10], gust: [0, 10], gustFrequency: [0, 10], turbulence: [0, 1] };
  for (const [k, [lo, hi]] of Object.entries(range)) {
    const v = w[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) err(errors, 'field_value', `${path}/wind/${k}`, `${k} must be a number in [${lo}, ${hi}]`, v);
  }
  for (const k of Object.keys(w)) if (k !== 'direction' && !(k in range)) err(errors, 'field_unexpected', `${path}/wind/${k}`, `unknown wind field "${k}"`, k, 'direction, strength, gust, gustFrequency, turbulence');
}

/** Keys in a fixed order, colours lowercase (values were validated). */
function canonicalObject<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    const v = (o as Record<string, unknown>)[k];
    if (v === undefined) continue;
    out[k] = typeof v === 'string' && COLOR_RE.test(v.toLowerCase()) ? v.toLowerCase() : Array.isArray(v) ? [...v] : typeof v === 'object' && v !== null ? canonicalObject(v as object) : v;
  }
  return out as T;
}

export function canonicalEnvironment(e: EnvironmentConfig): EnvironmentConfig {
  return {
    ...(e.wind !== undefined
      ? { wind: { direction: [e.wind.direction[0], e.wind.direction[1]], strength: e.wind.strength, gust: e.wind.gust, gustFrequency: e.wind.gustFrequency, turbulence: e.wind.turbulence } }
      : {}),
    ...(e.sky !== undefined ? { sky: canonicalObject(e.sky) } : {}),
    ...(e.fog !== undefined ? { fog: canonicalObject(e.fog) } : {}),
    ...(e.post !== undefined ? { post: canonicalObject(e.post) } : {}),
    ...(e.quality !== undefined ? { quality: e.quality } : {}),
  };
}

// ---- phase 9.5: sky, fog, post-processing ----------------------------------------

/** `other`: a known field the caller checks itself (arrays, nested shapes). */
type FieldRule = { kind: 'num'; min: number; max: number } | { kind: 'color' } | { kind: 'bool' } | { kind: 'enum'; values: readonly string[] } | { kind: 'id' } | { kind: 'other' };

function checkFields(value: unknown, path: string, rules: Record<string, FieldRule>, required: readonly string[], errors: ModelErrorV2[]): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'an object is expected', value);
    return null;
  }
  for (const k of required) if (value[k] === undefined) err(errors, 'field_missing', `${path}/${k}`, `"${k}" is required`, undefined, k);
  for (const [k, v] of Object.entries(value)) {
    const rule = rules[k];
    if (rule === undefined) {
      err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, Object.keys(rules).join(', '));
      continue;
    }
    if (rule.kind === 'other') continue;
    const bad =
      rule.kind === 'num'
        ? typeof v !== 'number' || !Number.isFinite(v) || v < rule.min || v > rule.max
          ? `a number in [${rule.min}, ${rule.max}]`
          : null
        : rule.kind === 'color'
          ? typeof v !== 'string' || !COLOR_RE.test(v.toLowerCase())
            ? 'a colour "#rrggbb"'
            : null
          : rule.kind === 'bool'
            ? typeof v !== 'boolean'
              ? 'true or false'
              : null
            : rule.kind === 'enum'
              ? typeof v !== 'string' || !rule.values.includes(v)
                ? `one of ${rule.values.join(', ')}`
                : null
              : typeof v !== 'string' || !ID_RE.test(v)
                ? 'a texture asset id'
                : null;
    if (bad !== null) err(errors, 'field_value', `${path}/${k}`, `${k} must be ${bad}`, v, bad);
  }
  return value;
}

export function validateSky(value: unknown, path: string, errors: ModelErrorV2[]): void {
  const checked = checkFields(
    value,
    path,
    {
      cube: { kind: 'other' },
      mode: { kind: 'enum', values: ['procedural', 'gradient', 'texture', 'color'] },
      turbidity: { kind: 'num', min: 1, max: 20 },
      rayleigh: { kind: 'num', min: 0, max: 4 },
      mieCoefficient: { kind: 'num', min: 0, max: 0.1 },
      mieDirectionalG: { kind: 'num', min: 0, max: 1 },
      sunFromLight: { kind: 'bool' },
      sunElevation: { kind: 'num', min: -10, max: 90 },
      sunAzimuth: { kind: 'num', min: -180, max: 180 },
      topColor: { kind: 'color' },
      horizonColor: { kind: 'color' },
      bottomColor: { kind: 'color' },
      color: { kind: 'color' },
      texture: { kind: 'id' },
      intensity: { kind: 'num', min: 0, max: 8 },
      environmentIntensity: { kind: 'num', min: 0, max: 8 },
    },
    ['mode'],
    errors,
  );
  if (checked === null || !isPlainObject(value)) return;
  const v = value;
  const cube = v['cube'];
  if (cube !== undefined && (!Array.isArray(cube) || cube.length !== 6 || !cube.every((c) => typeof c === 'string' && ID_RE.test(c)))) {
    err(errors, 'field_value', `${path}/cube`, 'cube is six texture asset ids (px, nx, py, ny, pz, nz)', cube);
  }
  if (v['mode'] === 'texture' && v['texture'] === undefined && v['cube'] === undefined) err(errors, 'field_missing', `${path}/texture`, 'a texture sky needs "texture" or "cube"', undefined, 'texture');
}

export function validateFog(value: unknown, path: string, errors: ModelErrorV2[]): void {
  checkFields(
    value,
    path,
    { mode: { kind: 'enum', values: ['none', 'linear', 'exp2'] }, color: { kind: 'color' }, near: { kind: 'num', min: 0, max: 10000 }, far: { kind: 'num', min: 0, max: 10000 }, density: { kind: 'num', min: 0, max: 1 } },
    ['mode', 'color'],
    errors,
  );
}

export function validatePost(value: unknown, path: string, errors: ModelErrorV2[]): void {
  const nested: FieldRule = { kind: 'other' };
  const v = checkFields(
    value,
    path,
    {
      toneMapping: { kind: 'enum', values: ['none', 'aces', 'agx', 'neutral'] },
      exposure: { kind: 'num', min: 0, max: 8 },
      antialias: { kind: 'enum', values: ['none', 'fxaa', 'smaa'] },
      bloom: nested,
      grading: nested,
      vignette: nested,
      ssao: nested,
      dof: nested,
    },
    [],
    errors,
  );
  if (v === null) return;
  const sub: Record<string, Record<string, FieldRule>> = {
    bloom: { enabled: { kind: 'bool' }, strength: { kind: 'num', min: 0, max: 3 }, radius: { kind: 'num', min: 0, max: 1 }, threshold: { kind: 'num', min: 0, max: 2 } },
    grading: { contrast: { kind: 'num', min: -1, max: 1 }, saturation: { kind: 'num', min: -1, max: 1 }, brightness: { kind: 'num', min: -1, max: 1 }, tint: { kind: 'color' }, lut: { kind: 'id' } },
    vignette: { enabled: { kind: 'bool' }, darkness: { kind: 'num', min: 0, max: 1 }, offset: { kind: 'num', min: 0, max: 2 } },
    ssao: { enabled: { kind: 'bool' }, radius: { kind: 'num', min: 0.01, max: 4 }, intensity: { kind: 'num', min: 0, max: 4 } },
    dof: { enabled: { kind: 'bool' }, focus: { kind: 'num', min: 0.1, max: 1000 }, aperture: { kind: 'num', min: 0, max: 0.1 }, maxBlur: { kind: 'num', min: 0, max: 0.05 } },
  };
  for (const [k, rules] of Object.entries(sub)) {
    if (v[k] !== undefined) checkFields(v[k], `${path}/${k}`, rules, k === 'grading' ? [] : ['enabled'], errors);
  }
}

/** Phase 9.5: a fog volume (box) the post pass fills with fog. */
export interface FogVolumeComponent {
  size: [number, number, number];
  density: number;
  color: string;
  /** Soft edges: 0 = hard box, 1 = fades from the centre. */
  falloff?: number;
}

export const MAX_FOG_VOLUMES = 16;

export function validateFogVolumeComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  const v = checkFields(value, path, { size: { kind: 'other' }, density: { kind: 'num', min: 0, max: 1 }, color: { kind: 'color' }, falloff: { kind: 'num', min: 0, max: 1 } }, ['size', 'density', 'color'], errors);
  if (v === null) return;
  const size = v['size'];
  if (!Array.isArray(size) || size.length !== 3 || !size.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1000)) {
    err(errors, 'field_value', `${path}/size`, 'size is [x, y, z] in meters, each 0 < v <= 1000', size);
  }
}

export function canonicalFogVolume(v: FogVolumeComponent): FogVolumeComponent {
  return { size: [v.size[0], v.size[1], v.size[2]], density: v.density, color: v.color.toLowerCase(), ...(v.falloff !== undefined ? { falloff: v.falloff } : {}) };
}
