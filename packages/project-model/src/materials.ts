/**
 * Project materials, the per-object material assignment and the
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
import { ID_RE } from './validate';
import type { ModelErrorV2 } from './errors';
import { canonicalGraphData, graphAssetRefs, nodeFieldValue, validateGraphData, type GraphContext, type GraphData, type GraphDocument } from './graph';
import { canonicalEnvironmentPresets, validateEnvironmentPresets, type EnvironmentPreset } from './environment-presets';
import { MATERIAL_DATA_MAX, MATERIAL_GRAPH_KIND, MATERIAL_PARAMETER_TYPES, type MaterialParameterType } from './material-graph-kinds';

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
   * The exposed parameters of a graph material (read by its
   * Parameter nodes; objects may override the public ones with the
   * `materialParams` component). Absent = none.
   */
  parameters?: MaterialParameter[];
  /**
   * A node graph (graph kind `material`). A material with a graph
   * is a graph material: at render time the graph replaces `shader`, `params`
   * and `textures` (it compiles to TSL; the shader part stays for "Remove
   * graph").
   */
  graph?: GraphData;
  /**
   * A material instance — this material is its parent's (another
   * material or instance, by materialId) with some values changed: `params`
   * and `textures` over the parent's (a shader material), `values` over the
   * parent's parameter defaults (a graph material). An instance has no graph
   * or parameters of its own and its `shader` is its parent's. Anything that
   * names a material (an object's, a model asset's or a block type's mapping,
   * overrides, effects, timelines) may name an instance; the runtime gets it
   * resolved (`resolveMaterialInstances`).
   */
  instanceOf?: string;
  /** Instances of graph materials: parameter key → value (see `MaterialParameter.default`). */
  values?: Record<string, MaterialParameterValue>;
}

/** An exposed parameter of a graph material. */
export interface MaterialParameter {
  /** The name Parameter nodes and overrides use (an identifier). */
  key: string;
  type: MaterialParameterType;
  /**
   * float: a number; vec2–4: 2–4 numbers; color: "#rrggbb"; texture: a texture asset id or "" (none);
   * data: the RGBA bytes (4 integers 0–255) every cell starts with.
   */
  default: number | number[] | string;
  /** Data only (required there): the grid's cells [width, height], 1–64 each. */
  size?: [number, number];
  /** float / vec2–4: the range the value (every component) stays in. */
  min?: number;
  max?: number;
  /** Like script properties: public (absent) = objects may override it; private = the material's own value only. */
  visibility?: 'public' | 'private';
  label?: string;
  group?: string;
  tooltip?: string;
}

/** The value an object stores to override a public parameter (see `MaterialParameter.default`). */
export type MaterialParameterValue = number | number[] | string;

/** Most exposed parameters of one material. */
export const MAX_MATERIAL_PARAMETERS = 64;
/** A parameter key — an identifier (it names the value in the graph and in overrides). */
export const MATERIAL_PARAMETER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const PARAM_BOUND = 1e6;

/** Most material slots one object or asset maps. */
export const MAX_MATERIAL_SLOTS = 32;
/** The slot key that applies a material to every material of a model (and to a box). */
export const MATERIAL_SLOT_ALL = '*';
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
 * The context a material's graph validates in — the project's
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
    case 'data':
      return Array.isArray(v) && v.length === 4 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? null : '4 integers 0–255 (the RGBA every cell starts with)';
    default:
      return `one of ${MATERIAL_PARAMETER_TYPES.join(', ')}`;
  }
}

const shortText = (v: unknown, max: number): boolean => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** A graph material's exposed parameters. */
export function validateMaterialParameters(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value) || value.length > MAX_MATERIAL_PARAMETERS) {
    err(errors, 'field_value', path, `parameters is a list of at most ${MAX_MATERIAL_PARAMETERS}`, Array.isArray(value) ? value.length : value);
    return;
  }
  const keys = new Set<string>();
  value.forEach((p, i) => {
    const pp = `${path}/${i}`;
    if (!isPlainObject(p)) return err(errors, 'field_type', pp, 'a parameter is { key, type, default, min?, max?, size?, visibility?, label?, group?, tooltip? }', p);
    const allowed = ['key', 'type', 'default', 'min', 'max', 'size', 'visibility', 'label', 'group', 'tooltip'];
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
    // A data parameter's grid size (and only there).
    if (type === 'data') {
      const size = p['size'];
      if (size === undefined) err(errors, 'field_missing', `${pp}/size`, 'a data parameter needs its size [width, height]', undefined, 'size');
      else if (!Array.isArray(size) || size.length !== 2 || !size.every((x) => Number.isInteger(x) && x >= 1 && x <= MATERIAL_DATA_MAX)) err(errors, 'field_value', `${pp}/size`, `size is [width, height], integers 1-${MATERIAL_DATA_MAX}`, size);
    } else if (p['size'] !== undefined) err(errors, 'field_unexpected', `${pp}/size`, `a ${type} parameter has no size`, 'size');
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
 * A material's graph against the material kind (catalogue, port
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

/** `content.materials`: unique ids, known shader params and slots (a project has as many materials as it needs). */
export function validateMaterials(value: unknown, path: string, errors: ModelErrorV2[], graphs?: GraphContext, trusted?: ReadonlySet<unknown>): void {
  if (!Array.isArray(value)) {
    err(errors, 'field_type', path, 'materials must be an array', value, 'array of materials');
    return;
  }
  const seen = new Set<string>();
  value.forEach((m, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(m)) {
      err(errors, 'field_type', p, 'a material is an object', m);
      return;
    }
    // A record validated before (the same object, with the same graphs) needs only its id checked against the list.
    if (trusted?.has(m)) {
      const tid = m['materialId'];
      if (typeof tid === 'string' && seen.has(tid)) err(errors, 'id_duplicate', `${p}/materialId`, 'materialId is used twice', tid);
      else if (typeof tid === 'string') seen.add(tid);
      return;
    }
    for (const k of Object.keys(m)) {
      if (!['materialId', 'name', 'shader', 'params', 'textures', 'parameters', 'graph', 'instanceOf', 'values'].includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown material field "${k}"`, k, 'materialId, name, shader, params, textures, parameters, graph, instanceOf, values');
    }
    // A material instance (its parent is checked with the whole list, `validateMaterialInstances`).
    if (m['instanceOf'] !== undefined) {
      if (typeof m['instanceOf'] !== 'string' || !ID_RE.test(m['instanceOf'])) err(errors, 'id_invalid', `${p}/instanceOf`, 'instanceOf names the parent materialId', m['instanceOf']);
      for (const k of ['graph', 'parameters'] as const) if (m[k] !== undefined) err(errors, 'field_unexpected', `${p}/${k}`, `a material instance has no ${k} of its own (it uses its parent's)`, k, 'instanceOf, values');
    }
    // Shape here; "values only on an instance" with the whole list (validateMaterialInstances).
    if (m['values'] !== undefined) validateMaterialInstanceValues(m['values'], `${p}/values`, errors);
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
    // A graph material.
    if (m['parameters'] !== undefined) validateMaterialParameters(m['parameters'], `${p}/parameters`, errors);
    // Parameters without a graph are kept (inert) so a graph can be removed and added back.
    if (m['graph'] !== undefined) validateMaterialGraph(m, p, errors, graphs);
  });
}

/** The longest chain of instances (an instance of an instance of … a material), resolved at build and in the renderer per material. */
export const MAX_MATERIAL_INSTANCE_DEPTH = 8;

function validateMaterialInstanceValues(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value) || Object.keys(value).length > MAX_MATERIAL_PARAMETERS) {
    err(errors, 'field_value', path, `values is an object of at most ${MAX_MATERIAL_PARAMETERS} parameter values`, value);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (!MATERIAL_PARAMETER_KEY_RE.test(k)) err(errors, 'field_value', `${path}/${k}`, 'a parameter key is an identifier', k);
    const ok = (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string' || (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x)));
    if (!ok) err(errors, 'field_type', `${path}/${k}`, 'a parameter value is a number, 2-4 numbers or a string', v);
  }
}

type MaterialLike = Record<string, unknown>;

/**
 * The chain from an instance up to its root material (the
 * instance first), or why it has none.
 */
function instanceChain(byId: ReadonlyMap<unknown, MaterialLike>, start: MaterialLike): { chain: MaterialLike[] } | { problem: 'missing' | 'loop' | 'depth'; at: unknown } {
  const chain: MaterialLike[] = [start];
  let cur = start;
  while (cur['instanceOf'] !== undefined) {
    const next = byId.get(cur['instanceOf']);
    if (next === undefined) return { problem: 'missing', at: cur['instanceOf'] };
    if (chain.includes(next)) return { problem: 'loop', at: cur['instanceOf'] };
    chain.push(next);
    if (chain.length > MAX_MATERIAL_INSTANCE_DEPTH + 1) return { problem: 'depth', at: cur['instanceOf'] };
    cur = next;
  }
  return { chain };
}

/**
 * The rules between materials and their instances (the whole
 * list): the parent exists, the chain ends at a material within
 * `MAX_MATERIAL_INSTANCE_DEPTH` steps without a loop, the instance's shader is
 * its root's, and its `values` name the root graph material's parameters with
 * values that fit them (a shader material's instance changes `params` and
 * `textures` instead).
 */
export function validateMaterialInstances(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return;
  const list = value.filter(isPlainObject);
  const byId = new Map(list.map((m) => [m['materialId'], m]));
  value.forEach((m, i) => {
    if (!isPlainObject(m)) return;
    const p = `${path}/${i}`;
    if (m['instanceOf'] === undefined) {
      if (m['values'] !== undefined) err(errors, 'field_unexpected', `${p}/values`, 'values belong to a material instance (instanceOf names its parent)', 'values', 'instanceOf');
      return;
    }
    if (m['instanceOf'] === m['materialId']) return err(errors, 'field_value', `${p}/instanceOf`, 'a material instance cannot be its own parent', m['instanceOf']);
    const found = instanceChain(byId, m);
    if ('problem' in found) {
      if (found.problem === 'missing') return err(errors, 'reference_missing', `${p}/instanceOf`, 'instanceOf names no material of this project', found.at, 'a materialId in content.materials');
      if (found.problem === 'loop') return err(errors, 'field_value', `${p}/instanceOf`, 'the instance chain loops back to itself', found.at, 'a chain that ends at a material');
      return err(errors, 'limits_exceeded', `${p}/instanceOf`, `an instance chain is at most ${MAX_MATERIAL_INSTANCE_DEPTH} instances long`, found.at);
    }
    const root = found.chain[found.chain.length - 1]!;
    if (m['shader'] !== root['shader']) err(errors, 'field_value', `${p}/shader`, `a material instance has its parent's shader ("${String(root['shader'])}")`, m['shader'], String(root['shader']));
    const values = m['values'];
    if (!isPlainObject(values)) return;
    if (root['graph'] === undefined) {
      if (Object.keys(values).length > 0) err(errors, 'field_value', `${p}/values`, 'only an instance of a graph material has parameter values (an instance of a shader material changes params and textures)', Object.keys(values)[0]);
      return;
    }
    const declared = Array.isArray(root['parameters']) ? (root['parameters'] as unknown[]).filter(isPlainObject) : [];
    for (const [k, v] of Object.entries(values)) {
      const decl = declared.find((d) => d['key'] === k);
      if (decl === undefined) {
        err(errors, 'reference_missing', `${p}/values/${k}`, `material "${String(root['name'])}" has no parameter "${k}"`, k, declared.map((d) => String(d['key'])).join(', ') || 'a declared parameter');
        continue;
      }
      const bad = materialParameterValueError(decl as unknown as MaterialParameter, v);
      if (bad !== null) err(errors, 'field_value', `${p}/values/${k}`, `${k} must be ${bad}`, v, bad);
    }
  });
}

/**
 * One material as it draws — an instance resolved against its
 * chain (the root's shader, graph and parameters; the parents' params and
 * textures under the instance's own; each level's `values` as the parameter
 * defaults), a material unchanged. Null when the id names nothing or the
 * chain is broken (the project rules refuse that).
 */
export function resolveMaterial(list: readonly MaterialDef[], materialId: string): MaterialDef | null {
  const byId = new Map(list.map((m) => [m.materialId as unknown, m as unknown as MaterialLike]));
  const start = byId.get(materialId);
  if (start === undefined) return null;
  return resolveFrom(byId, start);
}

function resolveFrom(byId: ReadonlyMap<unknown, MaterialLike>, start: MaterialLike): MaterialDef | null {
  if (start['instanceOf'] === undefined) return start as unknown as MaterialDef;
  const found = instanceChain(byId, start);
  if ('problem' in found) return null;
  const chain = found.chain as unknown as MaterialDef[];
  const root = chain[chain.length - 1]!;
  const self = chain[0]!;
  const params: Record<string, MaterialParamValue> = {};
  const textures: Record<string, string> = {};
  const values: Record<string, MaterialParameterValue> = {};
  // From the root down to the instance: the nearer level wins.
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!;
    Object.assign(params, m.params ?? {});
    Object.assign(textures, m.textures ?? {});
    if (i < chain.length - 1) Object.assign(values, m.values ?? {});
  }
  return {
    materialId: self.materialId,
    name: self.name,
    shader: root.shader,
    params,
    textures,
    ...(root.parameters !== undefined ? { parameters: root.parameters.map((p) => (values[p.key] !== undefined ? { ...p, default: values[p.key]! } : p)) } : {}),
    ...(root.graph !== undefined ? { graph: root.graph } : {}),
  };
}

/**
 * Every material as it draws (`resolveMaterial`), in list order;
 * an instance whose chain is broken is left out. The editor's views, Play and
 * the export draw from this list: the runtime never sees an instance.
 */
export function resolveMaterialInstances(list: readonly MaterialDef[]): MaterialDef[] {
  if (!list.some((m) => m.instanceOf !== undefined)) return [...list];
  const byId = new Map(list.map((m) => [m.materialId as unknown, m as unknown as MaterialLike]));
  const out: MaterialDef[] = [];
  for (const m of list) {
    const r = resolveFrom(byId, m as unknown as MaterialLike);
    if (r !== null) out.push(r);
  }
  return out;
}

/** Parameters in canonical form (list order kept: it is the Inspector's order). */
export function canonicalMaterialParameters(list: readonly MaterialParameter[]): MaterialParameter[] {
  return list.map((p) => ({
    key: p.key,
    type: p.type,
    default: Array.isArray(p.default) ? [...p.default] : typeof p.default === 'string' && p.type === 'color' ? p.default.toLowerCase() : p.default,
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.size !== undefined ? { size: [p.size[0], p.size[1]] as [number, number] } : {}),
    // Public is the default and omitted (like script properties).
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
      // After the 9.4 fields, so a shader material keeps its exact bytes.
      ...(m.parameters !== undefined && m.parameters.length > 0 ? { parameters: canonicalMaterialParameters(m.parameters) } : {}),
      ...(m.graph !== undefined ? { graph: canonicalGraphData(m.graph) } : {}),
      // Last, so every other material keeps its exact bytes.
      ...(m.instanceOf !== undefined ? { instanceOf: m.instanceOf } : {}),
      ...(m.instanceOf !== undefined && m.values !== undefined && Object.keys(m.values).length > 0
        ? { values: Object.fromEntries(Object.keys(m.values).sort().map((k) => { const v = m.values![k]!; return [k, Array.isArray(v) ? [...v] : typeof v === 'string' && COLOR_RE.test(v.toLowerCase()) ? v.toLowerCase() : v]; })) }
        : {}),
    }));
}

/**
 * A graph as the runtime compiles it: nodes (with positions — a function's
 * ports are ordered by them) and wires, without the editor-only parts
 * (groups, comments, reroute points, collapsed flags).
 */
export function graphForRuntime(g: GraphData): GraphData {
  return {
    nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, position: [n.position[0], n.position[1]], ...(n.data !== undefined ? { data: n.data } : {}) })),
    edges: g.edges.map((e) => ({ id: e.id, from: { node: e.from.node, port: e.from.port }, to: { node: e.to.node, port: e.to.port } })),
  };
}

/**
 * The materials as the runtime gets them. A graph material carries its
 * graph (the runtime compiles it to TSL) and its parameters, without the
 * editor-only graph text (comments, group titles).
 */
export function materialsForRuntime(list: readonly MaterialDef[]): MaterialDef[] {
  return list.map((m) => (m.graph !== undefined ? { ...m, graph: graphForRuntime(m.graph) } : m));
}

/**
 * The material functions (standalone graphs of kind
 * `material-function`) the graph materials call, directly or through other
 * functions, as the runtime gets them (`graphForRuntime`).
 */
export function materialFunctionsForRuntime(materials: readonly MaterialDef[], graphs: readonly GraphDocument[]): GraphDocument[] {
  const byId = new Map(graphs.filter((g) => g.kind === 'material-function').map((g) => [g.graphId, g]));
  const reached = new Map<string, GraphDocument>();
  const walk = (g: GraphData): void => {
    for (const n of g.nodes) {
      const id = n.type === 'call' ? n.data?.['function'] : undefined;
      if (typeof id !== 'string' || reached.has(id)) continue;
      const doc = byId.get(id);
      if (doc === undefined) continue;
      reached.set(id, { graphId: doc.graphId, kind: doc.kind, name: doc.name, graph: graphForRuntime(doc.graph) });
      walk(doc.graph);
    }
  };
  for (const m of materials) if (m.graph !== undefined) walk(m.graph);
  return [...reached.values()].sort((a, b) => (a.graphId < b.graphId ? -1 : a.graphId > b.graphId ? 1 : 0));
}

/**
 * The texture assets a material uses — its slots, and for a
 * graph material its graph's texture fields and its texture parameters'
 * defaults (the functions it calls are counted with the graphs).
 */
export function materialTextureRefs(m: MaterialDef): string[] {
  const out = new Set(Object.values(m.textures));
  if (m.graph !== undefined) for (const r of graphAssetRefs(MATERIAL_GRAPH_KIND, m.graph)) if (r.asset === 'texture') out.add(r.id);
  for (const p of m.parameters ?? []) if (p.type === 'texture' && typeof p.default === 'string' && p.default !== '') out.add(p.default);
  return [...out].sort();
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

// ---- environment (global wind, sky, fog, post) ----------------------

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

/** The sky (background + image-based lighting). */
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
   * Colour grading. Lift (raises the blacks, −0.5–0.5, default 0),
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
  /** Named looks scripts switch or blend to at run time (environment-presets.ts). */
  presets?: EnvironmentPreset[];
}

/** The wind when a project sets none — a light breeze along +X (0.5 with 0.4 gusts every ~3 s, a little turbulence): foliage moves a little in any scene; 0 strength stills it. */
export const DEFAULT_WIND: Readonly<WindConfig> = Object.freeze({ direction: [1, 0] as [number, number], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 });

export function validateEnvironment(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'environment is an object', value);
    return;
  }
  for (const k of Object.keys(value)) if (!['wind', 'sky', 'fog', 'post', 'quality', 'presets'].includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown environment field "${k}"`, k, 'wind, sky, fog, post, quality, presets');
  if (value['presets'] !== undefined) validateEnvironmentPresets(value['presets'], `${path}/presets`, errors);
  if (value['sky'] !== undefined) validateSky(value['sky'], `${path}/sky`, errors);
  if (value['fog'] !== undefined) validateFog(value['fog'], `${path}/fog`, errors);
  if (value['post'] !== undefined) validatePost(value['post'], `${path}/post`, errors);
  if (value['quality'] !== undefined && !['low', 'medium', 'high'].includes(value['quality'] as string)) err(errors, 'field_value', `${path}/quality`, 'quality is low, medium or high', value['quality']);
  if (value['wind'] !== undefined) validateWind(value['wind'], `${path}/wind`, errors);
}

/**
 * A level's look (`flow.levels[].environment`) — the parts of the
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
  const { quality: _q, presets: _p, ...rest } = canonicalEnvironment(e);
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
    // Last, so an environment without presets keeps its exact bytes.
    ...(e.presets !== undefined && e.presets.length > 0 ? { presets: canonicalEnvironmentPresets(e.presets) } : {}),
  };
}

// ---- Sky, fog, post-processing ----------------------------------------

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

/** A fog volume (box) the post pass fills with fog. */
export interface FogVolumeComponent {
  size: [number, number, number];
  density: number;
  color: string;
  /** Soft edges: 0 = hard box, 1 = fades from the centre. */
  falloff?: number;
  /**
   * How fast the density fades with height above the box's
   * bottom, per metre (density × e^(−heightFalloff × height); 0–10). Absent
   * or 0: the same density at every height, as before.
   */
  heightFalloff?: number;
}

/** Fog volumes per scene: the fog shader reads them from a fixed-size uniform array. */
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

// ---- Per-object overrides of exposed parameters -------------------------

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
    // An instance's parameters are its root graph material's.
    const m = materials.some((x) => x.materialId === id) ? (resolveMaterial(materials, id) ?? materials.find((x) => x.materialId === id)) : undefined;
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
      // A data parameter's cells are written by scripts while the game runs.
      else if (p.type === 'data') out.push({ path: `/${id}/${k}`, code: 'field_value', message: `parameter "${k}" of material "${m.name}" is a data parameter: scripts write its cells while the game runs (ctx.materials.setData)`, found: k });
      else {
        const bad = materialParameterValueError(p, v);
        if (bad !== null) out.push({ path: `/${id}/${k}`, code: 'field_value', message: `${k} must be ${bad}`, found: v });
      }
    }
  }
  return out;
}
