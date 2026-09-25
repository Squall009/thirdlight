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
import { canonicalGraphData, nodeFieldValue, validateGraphData, type GraphContext, type GraphData } from './graph';
import { MATERIAL_GRAPH_KIND, MATERIAL_PARAMETER_TYPES, type MaterialParameterType } from './material-graph-kinds';

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
  // COLOR_0 drives the wind (the engine's vertex-colour convention for any
  // swaying mesh — grass, trees, cloth, banners): R bend weight root→tip, G phase,
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
  /**
   * Phase 18.0: the exposed parameters of a graph material (read by its
   * Parameter nodes; objects may override the public ones with the
   * `materialParams` component). Absent = none.
   */
  parameters?: MaterialParameter[];
  /**
   * Phase 18.0: a node graph (graph kind `material`). A material with a graph
   * is a graph material: at render time the graph replaces `shader`, `params`
   * and `textures` (kept as the fallback until the graph compiler lands in
   * 18.3, and for "convert back").
   */
  graph?: GraphData;
}

/** Phase 18.0: an exposed parameter of a graph material. */
export interface MaterialParameter {
  /** The name Parameter nodes and overrides use (an identifier). */
  key: string;
  type: MaterialParameterType;
  /** float: a number; vec2–4: 2–4 numbers; color: "#rrggbb"; texture: a texture asset id or "" (none). */
  default: number | number[] | string;
  /** float / vec2–4: the range the value (every component) stays in. */
  min?: number;
  max?: number;
  /** Like script properties (15.4): public (absent) = objects may override it; private = the material's own value only. */
  visibility?: 'public' | 'private';
  label?: string;
  group?: string;
  tooltip?: string;
}

/** Phase 18.0: the value an object stores to override a public parameter (see `MaterialParameter.default`). */
export type MaterialParameterValue = number | number[] | string;

/** Most exposed parameters of one material. */
export const MAX_MATERIAL_PARAMETERS = 64;
/** Phase 18.0: a parameter key — an identifier (it names the value in the graph and in overrides). */
export const MATERIAL_PARAMETER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const PARAM_BOUND = 1e6;

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

/** The port type a parameter feeds into a graph (`color` is a vec3). */
export function materialParameterPortType(type: string): string | null {
  if (type === 'color') return 'vec3';
  return (MATERIAL_PARAMETER_TYPES as readonly string[]).includes(type) ? type : null;
}

/**
 * Phase 18.1: the context a material's graph validates in — the project's
 * standalone graphs (material-function calls) and its own parameters (the
 * Parameter node's port type).
 */
export function materialGraphContext(parameters: readonly unknown[] | undefined, graphs: GraphContext | undefined): GraphContext {
  return {
    ...(graphs?.graph !== undefined ? { graph: graphs.graph } : {}),
    lookup(name, value) {
      if (name !== 'parameter') return null;
      const p = (parameters ?? []).find((x) => isPlainObject(x) && x['key'] === value) as Record<string, unknown> | undefined;
      return typeof p?.['type'] === 'string' ? materialParameterPortType(p['type']) : null;
    },
  };
}

/** One value against a parameter declaration (null = valid). */
export function materialParameterValueError(p: Pick<MaterialParameter, 'type' | 'min' | 'max'>, v: unknown): string | null {
  const inRange = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= PARAM_BOUND && (p.min === undefined || x >= p.min) && (p.max === undefined || x <= p.max);
  const range = p.min !== undefined || p.max !== undefined ? ` in [${p.min ?? -PARAM_BOUND}, ${p.max ?? PARAM_BOUND}]` : '';
  switch (p.type) {
    case 'float':
      return inRange(v) ? null : `a number${range}`;
    case 'vec2':
    case 'vec3':
    case 'vec4': {
      const n = Number(p.type.slice(3));
      return Array.isArray(v) && v.length === n && v.every(inRange) ? null : `${n} numbers${range}`;
    }
    case 'color':
      return typeof v === 'string' && COLOR_RE.test(v) ? null : 'a colour "#rrggbb" (lowercase hex)';
    case 'texture':
      return typeof v === 'string' && (v === '' || ID_RE.test(v)) ? null : 'a texture asset id (or "" for none)';
    default:
      return `one of ${MATERIAL_PARAMETER_TYPES.join(', ')}`;
  }
}

const shortText = (v: unknown, max: number): boolean => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** Phase 18.0: a graph material's exposed parameters. */
export function validateMaterialParameters(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value) || value.length > MAX_MATERIAL_PARAMETERS) {
    err(errors, 'field_value', path, `parameters is a list of at most ${MAX_MATERIAL_PARAMETERS}`, Array.isArray(value) ? value.length : value);
    return;
  }
  const keys = new Set<string>();
  value.forEach((p, i) => {
    const pp = `${path}/${i}`;
    if (!isPlainObject(p)) return err(errors, 'field_type', pp, 'a parameter is { key, type, default, min?, max?, visibility?, label?, group?, tooltip? }', p);
    const allowed = ['key', 'type', 'default', 'min', 'max', 'visibility', 'label', 'group', 'tooltip'];
    for (const k of Object.keys(p)) if (!allowed.includes(k)) err(errors, 'field_unexpected', `${pp}/${k}`, `unknown parameter field "${k}"`, k, allowed.join(', '));
    const key = p['key'];
    if (typeof key !== 'string' || !MATERIAL_PARAMETER_KEY_RE.test(key)) err(errors, 'field_value', `${pp}/key`, 'a parameter key is an identifier (a letter or _, then letters, digits or _; 1-32 characters)', key);
    else if (keys.has(key)) err(errors, 'id_duplicate', `${pp}/key`, 'parameter keys are unique in a material', key);
    else keys.add(key);
    const type = p['type'];
    if (typeof type !== 'string' || !(MATERIAL_PARAMETER_TYPES as readonly string[]).includes(type)) {
      err(errors, 'field_value', `${pp}/type`, `type is one of ${MATERIAL_PARAMETER_TYPES.join(', ')}`, type);
      return;
    }
    const numeric = type === 'float' || type.startsWith('vec');
    for (const k of ['min', 'max'] as const) {
      const v = p[k];
      if (v === undefined) continue;
      if (!numeric) err(errors, 'field_unexpected', `${pp}/${k}`, `a ${type} parameter has no ${k}`, k);
      else if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > PARAM_BOUND) err(errors, 'field_value', `${pp}/${k}`, `${k} is a number within ±${PARAM_BOUND}`, v);
    }
    if (typeof p['min'] === 'number' && typeof p['max'] === 'number' && p['min'] > p['max']) err(errors, 'field_value', `${pp}/max`, 'max is at least min', p['max']);
    if (p['default'] === undefined) err(errors, 'field_missing', `${pp}/default`, 'a parameter needs a default', undefined, 'default');
    else {
      const bad = materialParameterValueError({ type: type as MaterialParameterType, ...(typeof p['min'] === 'number' ? { min: p['min'] } : {}), ...(typeof p['max'] === 'number' ? { max: p['max'] } : {}) }, p['default']);
      if (bad !== null) err(errors, 'field_value', `${pp}/default`, `the default is ${bad}`, p['default'], bad);
    }
    if (p['visibility'] !== undefined && p['visibility'] !== 'public' && p['visibility'] !== 'private') err(errors, 'field_value', `${pp}/visibility`, 'visibility is public or private', p['visibility']);
    for (const [k, max] of [['label', 64], ['group', 64], ['tooltip', 256]] as const) {
      if (p[k] !== undefined && !shortText(p[k], max)) err(errors, 'field_value', `${pp}/${k}`, `${k} is 1-${max} characters without control characters`, p[k]);
    }
  });
}

/**
 * Phase 18.0: a material's graph against the material kind (catalogue, port
 * types, cycles, the node budget) in its context, plus the material rule:
 * every Parameter node names a declared parameter.
 */
export function validateMaterialGraph(material: Record<string, unknown>, path: string, errors: ModelErrorV2[], graphs?: GraphContext): void {
  const parameters = Array.isArray(material['parameters']) ? (material['parameters'] as unknown[]) : [];
  const before = errors.length;
  validateGraphData(MATERIAL_GRAPH_KIND, material['graph'], `${path}/graph`, errors, materialGraphContext(parameters, graphs));
  if (errors.length > before) return;
  const g = material['graph'] as GraphData;
  const keys = new Set(parameters.filter(isPlainObject).map((p) => p['key']));
  const field = MATERIAL_GRAPH_KIND.nodes.find((d) => d.type === 'parameter')!.fields![0]!;
  g.nodes.forEach((n, i) => {
    if (n.type !== 'parameter') return;
    const key = nodeFieldValue(n, field);
    if (!keys.has(key)) err(errors, 'reference_missing', `${path}/graph/nodes/${i}/data/key`, 'the Parameter node names no parameter of this material (declare it first)', key, [...keys].join(', ') || 'a declared parameter key');
  });
}

/** `content.materials`: at most 256 materials, unique ids, known shader params and slots. */
export function validateMaterials(value: unknown, path: string, errors: ModelErrorV2[], graphs?: GraphContext): void {
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
      if (!['materialId', 'name', 'shader', 'params', 'textures', 'parameters', 'graph'].includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown material field "${k}"`, k, 'materialId, name, shader, params, textures, parameters, graph');
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
    // Phase 18.0: a graph material.
    if (m['parameters'] !== undefined) validateMaterialParameters(m['parameters'], `${p}/parameters`, errors);
    // Parameters without a graph are kept (inert) so a graph can be removed and added back.
    if (m['graph'] !== undefined) validateMaterialGraph(m, p, errors, graphs);
  });
}

/** Phase 18.0: parameters in canonical form (list order kept: it is the Inspector's order). */
export function canonicalMaterialParameters(list: readonly MaterialParameter[]): MaterialParameter[] {
  return list.map((p) => ({
    key: p.key,
    type: p.type,
    default: Array.isArray(p.default) ? [...p.default] : typeof p.default === 'string' && p.type === 'color' ? p.default.toLowerCase() : p.default,
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    // Public is the default and omitted (like script properties, 15.4).
    ...(p.visibility === 'private' ? { visibility: 'private' as const } : {}),
    ...(p.label !== undefined ? { label: p.label } : {}),
    ...(p.group !== undefined ? { group: p.group } : {}),
    ...(p.tooltip !== undefined ? { tooltip: p.tooltip } : {}),
  }));
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
      // Phase 18.0: after the 9.4 fields, so a shader material keeps its exact bytes.
      ...(m.parameters !== undefined && m.parameters.length > 0 ? { parameters: canonicalMaterialParameters(m.parameters) } : {}),
      ...(m.graph !== undefined ? { graph: canonicalGraphData(m.graph) } : {}),
    }));
}

/**
 * Phase 18.0: the materials as the runtime gets them until the graph
 * compiler lands (18.3): without `graph` and `parameters` — the renderer
 * draws a graph material with its shader fallback, and editor-only graph
 * text (comments, group titles) never reaches a build.
 */
export function materialsForRuntime(list: readonly MaterialDef[]): MaterialDef[] {
  return list.map(({ graph: _g, parameters: _p, ...rest }) => rest);
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
  /**
   * Colour grading. Phase 14.4: lift (raises the blacks, −0.5–0.5, default 0),
   * gamma (mid-tones, 0.2–5, default 1: >1 brightens) and gain (scales the
   * whites, 0–4, default 1) — the defaults leave the image unchanged.
   */
  grading?: { contrast?: number; saturation?: number; brightness?: number; tint?: string; lut?: string; lift?: number; gamma?: number; gain?: number };
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

/** Phase 15.5: the wind when a project sets none — a light breeze along +X (0.5 with 0.4 gusts every ~3 s, a little turbulence): foliage moves a little in any scene; 0 strength stills it. */
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
  if (value['wind'] !== undefined) validateWind(value['wind'], `${path}/wind`, errors);
}

/**
 * Phase 14.4: a level's look (`flow.levels[].environment`) — the parts of the
 * environment a level may lay over the project's while it plays. Quality is
 * the player's setting and stays project-wide.
 */
export type LevelEnvironment = Pick<EnvironmentConfig, 'sky' | 'fog' | 'post' | 'wind'>;

export function validateLevelEnvironment(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'a level environment is an object { sky?, fog?, post?, wind? }', value);
    return;
  }
  for (const k of Object.keys(value)) if (!['wind', 'sky', 'fog', 'post'].includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown level environment field "${k}"`, k, 'sky, fog, post, wind');
  if (value['sky'] !== undefined) validateSky(value['sky'], `${path}/sky`, errors);
  if (value['fog'] !== undefined) validateFog(value['fog'], `${path}/fog`, errors);
  if (value['post'] !== undefined) validatePost(value['post'], `${path}/post`, errors);
  if (value['wind'] !== undefined) validateWind(value['wind'], `${path}/wind`, errors);
}

export function canonicalLevelEnvironment(e: LevelEnvironment): LevelEnvironment {
  const { quality: _q, ...rest } = canonicalEnvironment(e);
  return rest;
}

/** The texture assets a level look names (sky images, the grading LUT). */
export function environmentTextureRefs(e: Pick<EnvironmentConfig, 'sky' | 'post'>): string[] {
  const out: string[] = [];
  if (e.sky?.texture !== undefined) out.push(e.sky.texture);
  for (const id of e.sky?.cube ?? []) out.push(id);
  if (e.post?.grading?.lut !== undefined) out.push(e.post.grading.lut);
  return out;
}

function validateWind(w: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(w)) {
    err(errors, 'field_type', path, 'wind is an object', w);
    return;
  }
  const d = w['direction'];
  if (!Array.isArray(d) || d.length !== 2 || !d.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1) || (d[0] === 0 && d[1] === 0)) {
    err(errors, 'field_value', `${path}/direction`, 'direction is [x, z], each in [-1, 1], not both 0', d);
  }
  const range: Record<string, [number, number]> = { strength: [0, 10], gust: [0, 10], gustFrequency: [0, 10], turbulence: [0, 1] };
  for (const [k, [lo, hi]] of Object.entries(range)) {
    const v = w[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) err(errors, 'field_value', `${path}/${k}`, `${k} must be a number in [${lo}, ${hi}]`, v);
  }
  for (const k of Object.keys(w)) if (k !== 'direction' && !(k in range)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown wind field "${k}"`, k, 'direction, strength, gust, gustFrequency, turbulence');
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
    grading: {
      contrast: { kind: 'num', min: -1, max: 1 },
      saturation: { kind: 'num', min: -1, max: 1 },
      brightness: { kind: 'num', min: -1, max: 1 },
      tint: { kind: 'color' },
      lut: { kind: 'id' },
      lift: { kind: 'num', min: -0.5, max: 0.5 },
      gamma: { kind: 'num', min: 0.2, max: 5 },
      gain: { kind: 'num', min: 0, max: 4 },
    },
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
  /**
   * Phase 14.4: how fast the density fades with height above the box's
   * bottom, per metre (density × e^(−heightFalloff × height); 0–10). Absent
   * or 0: the same density at every height, as before.
   */
  heightFalloff?: number;
}

export const MAX_FOG_VOLUMES = 16;

export function validateFogVolumeComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  const v = checkFields(value, path, { size: { kind: 'other' }, density: { kind: 'num', min: 0, max: 1 }, color: { kind: 'color' }, falloff: { kind: 'num', min: 0, max: 1 }, heightFalloff: { kind: 'num', min: 0, max: 10 } }, ['size', 'density', 'color'], errors);
  if (v === null) return;
  const size = v['size'];
  if (!Array.isArray(size) || size.length !== 3 || !size.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1000)) {
    err(errors, 'field_value', `${path}/size`, 'size is [x, y, z] in meters, each 0 < v <= 1000', size);
  }
}

export function canonicalFogVolume(v: FogVolumeComponent): FogVolumeComponent {
  return { size: [v.size[0], v.size[1], v.size[2]], density: v.density, color: v.color.toLowerCase(), ...(v.falloff !== undefined ? { falloff: v.falloff } : {}), ...(v.heightFalloff !== undefined ? { heightFalloff: v.heightFalloff } : {}) };
}

// ---- phase 18.0: per-object overrides of exposed parameters -------------------------

/**
 * The `materialParams` component: overrides of graph-material parameters on
 * one object, `{ <materialId>: { <parameter key>: value } }`. It extends the
 * object's material mapping (the `materials` component, or its model asset's
 * default mapping): the mapping chooses the materials, this sets their public
 * parameters for this object only. Values are checked against the material's
 * declarations by the project rules (`materialOverrideErrors`).
 */
export type MaterialParamsComponent = Record<string, Record<string, MaterialParameterValue>>;

export function validateMaterialParamsComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'material parameter overrides are an object { <materialId>: { <parameter>: value } }', value);
    return;
  }
  const ids = Object.keys(value);
  if (ids.length < 1 || ids.length > MAX_MATERIAL_SLOTS) err(errors, 'field_value', path, `material parameter overrides name 1-${MAX_MATERIAL_SLOTS} materials`, ids.length);
  for (const id of ids) {
    if (!ID_RE.test(id)) err(errors, 'id_invalid', `${path}/${id}`, 'a key is a materialId', id);
    const o = value[id];
    if (!isPlainObject(o) || Object.keys(o).length < 1 || Object.keys(o).length > MAX_MATERIAL_PARAMETERS) {
      err(errors, 'field_value', `${path}/${id}`, `a material's overrides are an object of 1-${MAX_MATERIAL_PARAMETERS} parameter values`, o);
      continue;
    }
    for (const [k, v] of Object.entries(o)) {
      if (!MATERIAL_PARAMETER_KEY_RE.test(k)) err(errors, 'field_value', `${path}/${id}/${k}`, 'a parameter key is an identifier', k);
      const ok = (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string' || (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x)));
      if (!ok) err(errors, 'field_type', `${path}/${id}/${k}`, 'a parameter value is a number, 2-4 numbers or a string', v);
    }
  }
}

export function canonicalMaterialParams(c: MaterialParamsComponent): MaterialParamsComponent {
  return Object.fromEntries(
    Object.keys(c)
      .sort()
      .map((id) => [id, Object.fromEntries(Object.keys(c[id]!).sort().map((k) => { const v = c[id]![k]!; return [k, Array.isArray(v) ? [...v] : typeof v === 'string' && COLOR_RE.test(v.toLowerCase()) ? v.toLowerCase() : v]; }))]),
  );
}

/**
 * The project rule for one object's overrides: each names a graph material
 * of the project and one of its public parameters, with a value that fits
 * the declaration. Returns [relative path, code, message, found] tuples.
 */
export function materialOverrideErrors(overrides: MaterialParamsComponent, materials: readonly MaterialDef[]): { path: string; code: string; message: string; found: unknown }[] {
  const out: { path: string; code: string; message: string; found: unknown }[] = [];
  for (const [id, values] of Object.entries(overrides)) {
    const m = materials.find((x) => x.materialId === id);
    if (m === undefined) {
      out.push({ path: `/${id}`, code: 'reference_missing', message: 'the overrides name no material of this project', found: id });
      continue;
    }
    if (m.graph === undefined) {
      out.push({ path: `/${id}`, code: 'field_value', message: 'only a graph material has parameters to override', found: id });
      continue;
    }
    for (const [k, v] of Object.entries(values)) {
      const p = (m.parameters ?? []).find((x) => x.key === k);
      if (p === undefined) out.push({ path: `/${id}/${k}`, code: 'reference_missing', message: `material "${m.name}" has no parameter "${k}"`, found: k });
      else if (p.visibility === 'private') out.push({ path: `/${id}/${k}`, code: 'field_value', message: `parameter "${k}" of material "${m.name}" is private: objects cannot override it`, found: k });
      else {
        const bad = materialParameterValueError(p, v);
        if (bad !== null) out.push({ path: `/${id}/${k}`, code: 'field_value', message: `${k} must be ${bad}`, found: v });
      }
    }
  }
  return out;
}
