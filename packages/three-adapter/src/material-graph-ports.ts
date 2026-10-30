/**
 * The material-graph compiler's copy of the catalogue (ports, types,
 * defaults) and the port resolution built on it: every node's typed ports,
 * a function's interface. The compiler reads ports in this compact form
 * (`t`/`d`, `dyn` widths); `tests/material-graph-compile-parity.test.ts`
 * keeps it equal to project-model's catalogue.
 */

import { decalSortOrder } from './mesh-decals';
import type {
  MaterialFunctionLike,
  MaterialGraphEdgeLike,
  MaterialGraphLike,
  MaterialGraphNodeLike,
  MaterialParameterLike,
  PortType,
  ValueType,
} from './material-graph-types';

const VALUE_TYPES: readonly ValueType[] = ['float', 'vec2', 'vec3', 'vec4'];

// ---- the compiler's copy of the catalogue (ports, types, defaults) -------------------

/** `dyn`: the node's `type` field (auto = the widest wire in). */
type SpecType = PortType | 'dyn';
interface PortSpec {
  readonly id: string;
  readonly t: SpecType;
  readonly d?: number | readonly number[] | string;
}
interface NodeSpec {
  readonly inputs: readonly PortSpec[];
  readonly outputs: readonly PortSpec[];
}
const P = (id: string, t: SpecType, d?: PortSpec['d']): PortSpec => ({ id, t, ...(d !== undefined ? { d } : {}) });
const unary = (d: number = 0): NodeSpec => ({ inputs: [P('in', 'dyn', d)], outputs: [P('out', 'dyn')] });
const binary = (a = 0, b = 0): NodeSpec => ({ inputs: [P('a', 'dyn', a), P('b', 'dyn', b)], outputs: [P('out', 'dyn')] });
const SAMPLE_OUT = [P('rgba', 'vec4'), P('rgb', 'vec3'), P('r', 'float'), P('g', 'float'), P('b', 'float'), P('a', 'float')];

/**
 * Every node type the compiler knows, with its ports as the catalogue
 * declares them (ids, types, defaults). Data-dependent ports (Parameter,
 * Swizzle, Function call / input / output) are resolved in `portsOf`.
 */
export const COMPILER_NODES: Readonly<Record<string, NodeSpec>> = {
  float: { inputs: [], outputs: [P('value', 'float')] },
  vec2: { inputs: [], outputs: [P('value', 'vec2')] },
  vec3: { inputs: [], outputs: [P('value', 'vec3')] },
  vec4: { inputs: [], outputs: [P('value', 'vec4')] },
  color: { inputs: [], outputs: [P('rgb', 'vec3'), P('alpha', 'float'), P('rgba', 'vec4')] },
  parameter: { inputs: [], outputs: [P('value', 'float')] },
  time: { inputs: [], outputs: [P('time', 'float')] },
  uv: { inputs: [], outputs: [P('uv', 'vec2')] },
  vertexColor: { inputs: [], outputs: [P('rgba', 'vec4'), P('rgb', 'vec3'), P('alpha', 'float')] },
  layerWeights: { inputs: [], outputs: [P('weights', 'vec4'), P('wetness', 'float'), P('occlusion', 'float')] },
  position: { inputs: [], outputs: [P('position', 'vec3')] },
  normal: { inputs: [], outputs: [P('normal', 'vec3')] },
  viewDirection: { inputs: [], outputs: [P('direction', 'vec3')] },
  objectPosition: { inputs: [], outputs: [P('position', 'vec3')] },
  cameraDistance: { inputs: [], outputs: [P('distance', 'float')] },
  screenUV: { inputs: [], outputs: [P('uv', 'vec2')] },
  instanceIndex: { inputs: [], outputs: [P('index', 'float')] },
  wind: { inputs: [], outputs: [P('direction', 'vec3'), P('strength', 'float'), P('turbulence', 'float')] },
  sceneWetness: { inputs: [], outputs: [P('wetness', 'float')] },
  sceneDepth: { inputs: [], outputs: [P('depth', 'float'), P('behind', 'float')] },
  mainLight: { inputs: [], outputs: [P('direction', 'vec3'), P('color', 'vec3'), P('ndotl', 'float')] },
  lightShadow: { inputs: [], outputs: [P('shadow', 'float')] },
  diffuseLight: { inputs: [], outputs: [P('total', 'vec3'), P('luminance', 'float'), P('direct', 'vec3')] },
  ambientLight: { inputs: [], outputs: [P('ambient', 'vec3'), P('environment', 'vec3'), P('lightmap', 'vec3')] },
  add: binary(),
  subtract: binary(),
  multiply: binary(1, 1),
  divide: binary(1, 1),
  min: binary(),
  max: binary(),
  power: binary(1, 1),
  dot: { inputs: [P('a', 'dyn', 0), P('b', 'dyn', 0)], outputs: [P('out', 'float')] },
  cross: { inputs: [P('a', 'vec3', [1, 0, 0]), P('b', 'vec3', [0, 1, 0])], outputs: [P('out', 'vec3')] },
  normalize: unary(),
  length: { inputs: [P('in', 'dyn', 0)], outputs: [P('out', 'float')] },
  lerp: { inputs: [P('a', 'dyn', 0), P('b', 'dyn', 1), P('t', 'dyn', 0.5)], outputs: [P('out', 'dyn')] },
  clamp: { inputs: [P('in', 'dyn', 0), P('min', 'dyn', 0), P('max', 'dyn', 1)], outputs: [P('out', 'dyn')] },
  saturate: unary(),
  smoothstep: { inputs: [P('edge0', 'dyn', 0), P('edge1', 'dyn', 1), P('x', 'dyn', 0.5)], outputs: [P('out', 'dyn')] },
  step: { inputs: [P('edge', 'dyn', 0.5), P('x', 'dyn', 0)], outputs: [P('out', 'dyn')] },
  abs: unary(),
  floor: unary(),
  fract: unary(),
  sin: unary(),
  cos: unary(),
  oneMinus: unary(),
  weightedMix: { inputs: [P('a', 'dyn', 0), P('b', 'dyn', 0), P('c', 'dyn', 0), P('d', 'dyn', 0), P('weights', 'vec4', [1, 0, 0, 0])], outputs: [P('out', 'dyn')] },
  remap: { inputs: [P('in', 'dyn', 0), P('inMin', 'dyn', 0), P('inMax', 'dyn', 1), P('outMin', 'dyn', 0), P('outMax', 'dyn', 1)], outputs: [P('out', 'dyn')] },
  split: { inputs: [P('in', 'vec4', [0, 0, 0, 0])], outputs: [P('x', 'float'), P('y', 'float'), P('z', 'float'), P('w', 'float')] },
  combine: { inputs: [P('x', 'float', 0), P('y', 'float', 0), P('z', 'float', 0), P('w', 'float', 1)], outputs: [P('xyzw', 'vec4'), P('xyz', 'vec3'), P('xy', 'vec2')] },
  swizzle: { inputs: [P('in', 'vec4', [0, 0, 0, 0])], outputs: [P('out', 'vec3')] },
  sampleTexture: { inputs: [P('tex', 'texture'), P('uv', 'vec2', 'uv0'), P('layer', 'float', 0)], outputs: SAMPLE_OUT },
  sampleData: { inputs: [P('data', 'data'), P('uv', 'vec2', 'uv0'), P('cell', 'vec2', [0, 0])], outputs: SAMPLE_OUT },
  normalMap: { inputs: [P('tex', 'texture'), P('uv', 'vec2', 'uv0'), P('strength', 'float', 1), P('layer', 'float', 0)], outputs: [P('normal', 'vec3')] },
  triplanar: { inputs: [P('tex', 'texture'), P('position', 'vec3', 'positionWorld'), P('normal', 'vec3', 'normalWorld'), P('scale', 'float', 1), P('sharpness', 'float', 4), P('layer', 'float', 0)], outputs: [P('rgba', 'vec4'), P('rgb', 'vec3')] },
  projectedSample: {
    inputs: [P('tex', 'texture'), P('uv', 'vec2', 'uv0'), P('scale', 'float', 1), P('mode', 'float', 0), P('sharpness', 'float', 4), P('near', 'float', 60), P('strength', 'float', 1), P('position', 'vec3', 'positionWorld'), P('normal', 'vec3', 'normalWorld'), P('layer', 'float', 0)],
    outputs: [...SAMPLE_OUT, P('normal', 'vec3')],
  },
  heightBlend: { inputs: [P('weights', 'vec4', [1, 0, 0, 0]), P('heights', 'vec4', [0, 0, 0, 0]), P('depth', 'float', 0.2), P('contrast', 'vec4', [1, 1, 1, 1]), P('offset', 'vec4', [0, 0, 0, 0])], outputs: [P('weights', 'vec4')] },
  flipbook: { inputs: [P('uv', 'vec2', 'uv0'), P('frame', 'float', 0)], outputs: [P('uv', 'vec2')] },
  noise: { inputs: [P('uv', 'vec2', 'uv0'), P('scale', 'float', 10)], outputs: [P('value', 'float'), P('cell', 'float')] },
  gradient: { inputs: [P('uv', 'vec2', 'uv0')], outputs: [P('value', 'float')] },
  colorRamp: { inputs: [P('t', 'float', 0.5)], outputs: [P('rgb', 'vec3')] },
  fresnel: { inputs: [P('normal', 'vec3', 'normalWorld'), P('view', 'vec3', 'viewDirWorld'), P('power', 'float', 5)], outputs: [P('out', 'float')] },
  rim: { inputs: [P('normal', 'vec3', 'normalWorld'), P('view', 'vec3', 'viewDirWorld'), P('width', 'float', 0.3), P('softness', 'float', 0.1)], outputs: [P('out', 'float')] },
  posterize: { inputs: [P('in', 'dyn', 0), P('steps', 'dyn', 4)], outputs: [P('out', 'dyn')] },
  dither: { inputs: [P('in', 'float', 0.5), P('screen', 'vec2', 'screenUV')], outputs: [P('out', 'float')] },
  worldUV: { inputs: [P('position', 'vec3', 'positionWorld'), P('scale', 'float', 1)], outputs: [P('uv', 'vec2')] },
  parallax: { inputs: [P('uv', 'vec2', 'uv0'), P('height', 'float', 0), P('scale', 'float', 0.05), P('view', 'vec3', 'viewDirTangent')], outputs: [P('uv', 'vec2')] },
  displace: { inputs: [P('height', 'float', 0), P('scale', 'float', 1), P('direction', 'vec3', 'normalObject')], outputs: [P('offset', 'vec3')] },
  alphaClip: { inputs: [P('alpha', 'float', 1), P('threshold', 'float', 0.5)], outputs: [P('alpha', 'float')] },
  call: { inputs: [], outputs: [] },
  pbr: {
    inputs: [P('baseColor', 'vec3', [1, 1, 1]), P('metalness', 'float', 0), P('roughness', 'float', 0.8), P('normal', 'vec3', [0, 0, 1]), P('emissive', 'vec3', [0, 0, 0]), P('ao', 'float', 1), P('opacity', 'float', 1), P('alphaClip', 'float', 0), P('specularIntensity', 'float', 1), P('specularColor', 'vec3', [1, 1, 1])],
    outputs: [],
  },
  unlit: { inputs: [P('color', 'vec3', [1, 1, 1]), P('opacity', 'float', 1), P('alphaClip', 'float', 0)], outputs: [] },
  customLit: { inputs: [P('color', 'vec3', [1, 1, 1]), P('emissive', 'vec3', [0, 0, 0]), P('normal', 'vec3', [0, 0, 1]), P('opacity', 'float', 1), P('alphaClip', 'float', 0)], outputs: [] },
  vertexOffset: { inputs: [P('offset', 'vec3', [0, 0, 0])], outputs: [] },
  functionInput: { inputs: [], outputs: [P('value', 'float')] },
  functionOutput: { inputs: [P('value', 'float', 0)], outputs: [] },
};

/** The field defaults the compiler reads (the catalogue's). */
export const COMPILER_FIELD_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  float: { value: 0 },
  vec2: { value: [0, 0] },
  vec3: { value: [0, 0, 0] },
  vec4: { value: [0, 0, 0, 0] },
  color: { color: '#ffffff', alpha: 1 },
  parameter: { key: '' },
  uv: { set: 'uv0' },
  vertexColor: { absent: 'white', set: 'COLOR_0' },
  position: { space: 'world' },
  normal: { space: 'world' },
  viewDirection: { space: 'world' },
  swizzle: { mask: 'xyz' },
  sampleTexture: { texture: '', wrap: 'repeat', filter: 'linear', colorSpace: 'srgb', absent: 'white' },
  sampleData: { address: 'uv' },
  normalMap: { texture: '', wrap: 'repeat', filter: 'linear' },
  triplanar: { texture: '', wrap: 'repeat', filter: 'linear', colorSpace: 'srgb', absent: 'white' },
  projectedSample: { texture: '', wrap: 'repeat', filter: 'linear', colorSpace: 'srgb', decode: 'color', absent: 'white' },
  flipbook: { columns: 4, rows: 4 },
  noise: { noise: 'gradient' },
  gradient: { shape: 'linear' },
  colorRamp: { from: '#000000', to: '#ffffff', interpolation: 'linear' },
  dither: { pattern: 'bayer4' },
  worldUV: { plane: 'xz' },
  call: { function: '' },
  pbr: { doubleSided: false, transparent: false, castShadows: true, decal: 'off', decalSortOrder: 0, localLights: 'object' },
  unlit: { doubleSided: false, transparent: false, castShadows: true, decal: 'off', decalSortOrder: 0 },
  customLit: { doubleSided: false, transparent: false, castShadows: true, decal: 'off', decalSortOrder: 0, localLights: 'object' },
  vertexOffset: { space: 'object' },
  functionInput: { name: '', type: 'float', default: [0, 0, 0, 0] },
  functionOutput: { name: '', type: 'float' },
};

const MATH_TYPED = new Set(Object.entries(COMPILER_NODES).filter(([, s]) => s.inputs.some((p) => p.t === 'dyn') || s.outputs.some((p) => p.t === 'dyn')).map(([k]) => k));

export function field(node: MaterialGraphNodeLike, key: string): unknown {
  const v = node.data?.[key];
  return v !== undefined ? v : COMPILER_FIELD_DEFAULTS[node.type]?.[key];
}
export const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
export const numOf = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const isValueType = (t: unknown): t is ValueType => typeof t === 'string' && (VALUE_TYPES as readonly string[]).includes(t);

/** A parameter's port type (a colour is a vec3). */
export function parameterPortType(type: string): PortType | null {
  if (type === 'color') return 'vec3';
  return isValueType(type) || type === 'texture' || type === 'data' ? (type as PortType) : null;
}

const byPosition = (a: MaterialGraphNodeLike, b: MaterialGraphNodeLike): number => {
  const pa = a.position ?? [0, 0];
  const pb = b.position ?? [0, 0];
  return (pa[1] ?? 0) - (pb[1] ?? 0) || (pa[0] ?? 0) - (pb[0] ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

export interface ResolvedPort {
  readonly id: string;
  readonly t: PortType;
  readonly d?: PortSpec['d'];
}
export interface ResolvedPorts {
  readonly inputs: readonly ResolvedPort[];
  readonly outputs: readonly ResolvedPort[];
}

/**
 * Every node's ports with their types (project-model `resolveGraphPorts` for
 * the material catalogue): static ports, parameter types, swizzle widths,
 * a call's function interface, and `auto` widths from the wires.
 */
export function resolveMaterialGraphPorts(graph: MaterialGraphLike, parameters: readonly MaterialParameterLike[], fn: (id: string) => MaterialFunctionLike | null): Map<string, ResolvedPorts> {
  const out = new Map<string, ResolvedPorts>();
  const incoming = new Map<string, MaterialGraphEdgeLike[]>();
  for (const e of graph.edges) incoming.set(e.to.node, [...(incoming.get(e.to.node) ?? []), e]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const visiting = new Set<string>();
  const resolve = (id: string): ResolvedPorts | undefined => {
    const have = out.get(id);
    if (have !== undefined) return have;
    const node = byId.get(id);
    const spec = node !== undefined ? COMPILER_NODES[node.type] : undefined;
    if (node === undefined || spec === undefined || visiting.has(id)) return undefined;
    visiting.add(id);
    const fixed = (p: PortSpec): ResolvedPort => ({ id: p.id, t: p.t as PortType, ...(p.d !== undefined ? { d: p.d } : {}) });
    let r: ResolvedPorts;
    if (node.type === 'parameter') {
      const p = parameters.find((x) => x.key === field(node, 'key'));
      r = { inputs: [], outputs: [{ id: 'value', t: (p !== undefined ? parameterPortType(p.type) : null) ?? 'float' }] };
    } else if (node.type === 'swizzle') {
      const mask = str(field(node, 'mask'), 'xyz');
      r = { inputs: spec.inputs.map(fixed), outputs: [{ id: 'out', t: VALUE_TYPES[mask.length - 1] ?? 'vec3' }] };
    } else if (node.type === 'functionInput') {
      const t = str(field(node, 'type'), 'float');
      r = { inputs: [], outputs: [{ id: 'value', t: isValueType(t) || t === 'texture' ? (t as PortType) : 'float' }] };
    } else if (node.type === 'functionOutput') {
      const t = str(field(node, 'type'), 'float');
      r = { inputs: [{ id: 'value', t: isValueType(t) ? t : 'float', d: 0 }], outputs: [] };
    } else if (node.type === 'call') {
      const f = fn(str(field(node, 'function'), ''));
      const itf = f !== null ? functionInterface(f.graph) : { inputs: [], outputs: [] };
      r = itf;
    } else if (MATH_TYPED.has(node.type)) {
      const chosen = str(field(node, 'type'), 'auto');
      let t: ValueType;
      if (isValueType(chosen)) t = chosen;
      else {
        let widest = -1;
        for (const e of incoming.get(id) ?? []) {
          const port = spec.inputs.find((p) => p.id === e.to.port);
          if (port === undefined || port.t !== 'dyn') continue;
          const src = resolve(e.from.node)?.outputs.find((p) => p.id === e.from.port);
          if (src === undefined || src.t === 'texture' || src.t === 'data') continue;
          widest = Math.max(widest, VALUE_TYPES.indexOf(src.t));
        }
        t = widest >= 0 ? VALUE_TYPES[widest]! : 'float';
      }
      const typed = (p: PortSpec): ResolvedPort => ({ id: p.id, t: p.t === 'dyn' ? t : (p.t as PortType), ...(p.d !== undefined ? { d: p.d } : {}) });
      r = { inputs: spec.inputs.map(typed), outputs: spec.outputs.map(typed) };
    } else r = { inputs: spec.inputs.map(fixed), outputs: spec.outputs.map(fixed) };
    visiting.delete(id);
    out.set(id, r);
    return r;
  };
  for (const n of graph.nodes) resolve(n.id);
  return out;
}

/** A function's ports: its Function input / output nodes, top to bottom (port id = node id). */
export function functionInterface(graph: MaterialGraphLike): ResolvedPorts {
  const side = (type: string): ResolvedPort[] =>
    graph.nodes
      .filter((n) => n.type === type)
      .sort(byPosition)
      .map((n) => {
        const t = str(field(n, 'type'), 'float');
        return { id: n.id, t: isValueType(t) || (t === 'texture' && type === 'functionInput') ? (t as PortType) : 'float' };
      });
  return { inputs: side('functionInput'), outputs: side('functionOutput') };
}
