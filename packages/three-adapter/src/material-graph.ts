/**
 * Phase 18.3: material graphs → three.js TSL node materials.
 *
 * A graph material (project-model `MaterialDef.graph`, graph kind
 * `material`) is compiled here from its data, in the browser, by the editor
 * (Scene view, preview) and by the runtime (Play, exports) alike — no
 * generated code is stored. Each catalogue node kind (project-model
 * `material-graph-kinds.ts`) becomes TSL nodes (`three/tsl`); the surface
 * output fills a `MeshStandardNodeMaterial` (PBR) or `MeshBasicNodeMaterial`
 * (Unlit) — `colorNode`, `metalnessNode`, `roughnessNode`, `normalNode`,
 * `emissiveNode`, `aoNode`, `opacityNode`, `alphaTestNode` — and a Vertex
 * offset output its `positionNode`; the output's flags set the side, the
 * transparency and shadow casting.
 *
 * - Values: float/vec2/vec3/vec4 with the catalogue's implicit conversions
 *   (a float splats, a wider vector keeps its leading components, a narrower
 *   one pads with 0 and w = 1); a texture wire carries an asset reference.
 * - Two stages: nodes that feed the Vertex offset compile for the vertex
 *   stage (positions, normals and the wind read from the undisplaced
 *   vertex), the others for the fragment stage; a node used by both compiles
 *   once per stage.
 * - Exposed parameters are uniforms. A public parameter reads an object's
 *   override (the `materialParams` component) per drawn object
 *   (`onObjectUpdate`), so one shared material serves every object and no
 *   override ever changes it (phase 9.4 rule); texture overrides need their
 *   own material (the library compiles a variant).
 * - Material functions (standalone graphs of kind `material-function`) are
 *   inlined per call; their Function inputs take the call's wires or their
 *   defaults.
 * - Textures come from the host through `texture(assetId, sampler)` (asset
 *   ids from the content closure, never URLs); one still loading draws as
 *   its fallback until the library recompiles on arrival.
 *
 * The node semantics (ports, types, defaults) are the compiler's own copy of
 * the catalogue (three-adapter does not import project-model;
 * `tests/material-graph-compile-parity.test.ts` keeps them equal).
 *
 * Pure three.js: building the node tree needs no GPU (unit-tested in Node);
 * a renderer turns it into shaders.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';

import { instanceOrigin } from './node-materials';

// TSL's typings do not follow values whose width is known only at run time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
/** TSL, untyped here (see N). */
const T: N = TSL;

// ---- structural data (project-model shapes; three-adapter does not import it) ----------

export interface MaterialGraphNodeLike {
  readonly id: string;
  readonly type: string;
  readonly position?: readonly [number, number] | readonly number[];
  readonly data?: Readonly<Record<string, unknown>>;
}
export interface MaterialGraphEdgeLike {
  readonly id?: string;
  readonly from: { readonly node: string; readonly port: string };
  readonly to: { readonly node: string; readonly port: string };
}
export interface MaterialGraphLike {
  readonly nodes: readonly MaterialGraphNodeLike[];
  readonly edges: readonly MaterialGraphEdgeLike[];
}
export interface MaterialParameterLike {
  readonly key: string;
  readonly type: string;
  readonly default: number | readonly number[] | string;
  readonly visibility?: string;
}
/** A standalone graph document (only `material-function` ones are called). */
export interface MaterialFunctionLike {
  readonly graphId: string;
  readonly kind: string;
  readonly name?: string;
  readonly graph: MaterialGraphLike;
}

export type ValueType = 'float' | 'vec2' | 'vec3' | 'vec4';
export type PortType = ValueType | 'texture';
const VALUE_TYPES: readonly ValueType[] = ['float', 'vec2', 'vec3', 'vec4'];
const WIDTH: Readonly<Record<ValueType, number>> = { float: 1, vec2: 2, vec3: 3, vec4: 4 };

export interface SamplerLike {
  readonly colorSpace: 'srgb' | 'linear';
  readonly wrap: 'repeat' | 'clamp' | 'mirror';
  readonly filter: 'linear' | 'nearest';
}

/** The shared uniforms every graph material reads (the library's clock and wind). */
export interface GraphGlobals {
  readonly time: N;
  readonly windDir: N;
  readonly strength: N;
  readonly gust: N;
  readonly gustFreq: N;
  readonly turb: N;
}

export interface GraphCompileEnv {
  readonly globals: GraphGlobals;
  /**
   * A texture asset prepared for a sampler (colour space, wrapping, filter):
   * the texture, `'loading'` while it is on its way, or null when the
   * project has no such texture.
   */
  texture(assetId: string, sampler: SamplerLike): THREE.Texture | 'loading' | null;
  /** A material function by graph id, or null. */
  fn(graphId: string): MaterialFunctionLike | null;
  /**
   * The key objects store their overrides under (`mesh.userData[OVERRIDES_KEY][paramKey]`);
   * absent = parameters are plain uniforms.
   */
  readonly overrideKey?: string;
}

export interface GraphProblem {
  /** The node of the material graph (a problem inside a function names the call node). */
  readonly nodeId?: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface CompiledMaterialGraph {
  /** The surface output kind (null: none — the material draws as a plain white PBR surface). */
  readonly surface: 'pbr' | 'unlit' | null;
  readonly slots: {
    readonly color: N | null;
    readonly metalness: N | null;
    readonly roughness: N | null;
    readonly normal: N | null;
    readonly emissive: N | null;
    readonly ao: N | null;
    readonly opacity: N | null;
    readonly alphaTest: N | null;
    readonly position: N | null;
  };
  readonly flags: { readonly doubleSided: boolean; readonly transparent: boolean; readonly castShadows: boolean };
  /** Reads the clock or the wind (the host keeps rendering). */
  readonly animated: boolean;
  /** Texture assets it samples (loaded or not). */
  readonly textures: readonly string[];
  /** Textures still loading (a recompile after they arrive draws them). */
  readonly pending: readonly string[];
  readonly problems: readonly GraphProblem[];
  /** The number of catalogue nodes compiled (function bodies once per call). */
  readonly nodeCount: number;
}

/** Where objects keep their parameter overrides for the graph materials they wear. */
export const OVERRIDES_KEY = '__tlMaterialParams';

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
  position: { inputs: [], outputs: [P('position', 'vec3')] },
  normal: { inputs: [], outputs: [P('normal', 'vec3')] },
  viewDirection: { inputs: [], outputs: [P('direction', 'vec3')] },
  objectPosition: { inputs: [], outputs: [P('position', 'vec3')] },
  cameraDistance: { inputs: [], outputs: [P('distance', 'float')] },
  screenUV: { inputs: [], outputs: [P('uv', 'vec2')] },
  instanceIndex: { inputs: [], outputs: [P('index', 'float')] },
  wind: { inputs: [], outputs: [P('direction', 'vec3'), P('strength', 'float'), P('turbulence', 'float')] },
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
  remap: { inputs: [P('in', 'dyn', 0), P('inMin', 'dyn', 0), P('inMax', 'dyn', 1), P('outMin', 'dyn', 0), P('outMax', 'dyn', 1)], outputs: [P('out', 'dyn')] },
  split: { inputs: [P('in', 'vec4', [0, 0, 0, 0])], outputs: [P('x', 'float'), P('y', 'float'), P('z', 'float'), P('w', 'float')] },
  combine: { inputs: [P('x', 'float', 0), P('y', 'float', 0), P('z', 'float', 0), P('w', 'float', 1)], outputs: [P('xyzw', 'vec4'), P('xyz', 'vec3'), P('xy', 'vec2')] },
  swizzle: { inputs: [P('in', 'vec4', [0, 0, 0, 0])], outputs: [P('out', 'vec3')] },
  sampleTexture: { inputs: [P('tex', 'texture'), P('uv', 'vec2', 'uv0')], outputs: SAMPLE_OUT },
  normalMap: { inputs: [P('tex', 'texture'), P('uv', 'vec2', 'uv0'), P('strength', 'float', 1)], outputs: [P('normal', 'vec3')] },
  triplanar: { inputs: [P('tex', 'texture'), P('position', 'vec3', 'positionWorld'), P('normal', 'vec3', 'normalWorld'), P('scale', 'float', 1), P('sharpness', 'float', 4)], outputs: [P('rgba', 'vec4'), P('rgb', 'vec3')] },
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
    inputs: [P('baseColor', 'vec3', [1, 1, 1]), P('metalness', 'float', 0), P('roughness', 'float', 0.8), P('normal', 'vec3', [0, 0, 1]), P('emissive', 'vec3', [0, 0, 0]), P('ao', 'float', 1), P('opacity', 'float', 1), P('alphaClip', 'float', 0)],
    outputs: [],
  },
  unlit: { inputs: [P('color', 'vec3', [1, 1, 1]), P('opacity', 'float', 1), P('alphaClip', 'float', 0)], outputs: [] },
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
  vertexColor: { absent: 'white' },
  position: { space: 'world' },
  normal: { space: 'world' },
  viewDirection: { space: 'world' },
  swizzle: { mask: 'xyz' },
  sampleTexture: { texture: '', wrap: 'repeat', filter: 'linear', colorSpace: 'srgb' },
  normalMap: { texture: '', wrap: 'repeat', filter: 'linear' },
  triplanar: { texture: '', wrap: 'repeat', filter: 'linear', colorSpace: 'srgb' },
  flipbook: { columns: 4, rows: 4 },
  noise: { noise: 'gradient' },
  gradient: { shape: 'linear' },
  colorRamp: { from: '#000000', to: '#ffffff', interpolation: 'linear' },
  dither: { pattern: 'bayer4' },
  worldUV: { plane: 'xz' },
  call: { function: '' },
  pbr: { doubleSided: false, transparent: false, castShadows: true },
  unlit: { doubleSided: false, transparent: false, castShadows: true },
  vertexOffset: { space: 'object' },
  functionInput: { name: '', type: 'float', default: [0, 0, 0, 0] },
  functionOutput: { name: '', type: 'float' },
};

const MATH_TYPED = new Set(Object.entries(COMPILER_NODES).filter(([, s]) => s.inputs.some((p) => p.t === 'dyn') || s.outputs.some((p) => p.t === 'dyn')).map(([k]) => k));

function field(node: MaterialGraphNodeLike, key: string): unknown {
  const v = node.data?.[key];
  return v !== undefined ? v : COMPILER_FIELD_DEFAULTS[node.type]?.[key];
}
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const numOf = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isValueType = (t: unknown): t is ValueType => typeof t === 'string' && (VALUE_TYPES as readonly string[]).includes(t);

/** A parameter's port type (a colour is a vec3). */
export function parameterPortType(type: string): PortType | null {
  if (type === 'color') return 'vec3';
  return isValueType(type) || type === 'texture' ? (type as PortType) : null;
}

const byPosition = (a: MaterialGraphNodeLike, b: MaterialGraphNodeLike): number => {
  const pa = a.position ?? [0, 0];
  const pb = b.position ?? [0, 0];
  return (pa[1] ?? 0) - (pb[1] ?? 0) || (pa[0] ?? 0) - (pb[0] ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

interface ResolvedPort {
  readonly id: string;
  readonly t: PortType;
  readonly d?: PortSpec['d'];
}
interface ResolvedPorts {
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
          if (src === undefined || src.t === 'texture') continue;
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

// ---- values ---------------------------------------------------------------------------

type Val = { readonly t: ValueType; readonly n: N } | { readonly t: 'texture'; readonly asset: string };
type Stage = 'vertex' | 'fragment';

const TAU = 6.2831853;

/** A value converted to another width (the catalogue's implicit conversions). */
function convert(v: { t: ValueType; n: N }, to: ValueType): N {
  if (v.t === to) return v.n;
  const a = WIDTH[v.t];
  const b = WIDTH[to];
  if (a === 1) return to === 'vec2' ? T.vec2(v.n) : to === 'vec3' ? T.vec3(v.n) : T.vec4(v.n);
  if (b < a) return b === 1 ? v.n.x : b === 2 ? v.n.xy : v.n.xyz;
  // Pad: 0 for y/z, 1 for w.
  if (to === 'vec3') return T.vec3(v.n, 0);
  return a === 2 ? T.vec4(v.n, 0, 1) : T.vec4(v.n, 1);
}

/** A constant of a port type from a number or a number list (padded like a conversion). */
function constant(d: number | readonly number[], t: ValueType): N {
  if (typeof d === 'number') return t === 'float' ? T.float(d) : t === 'vec2' ? T.vec2(d, d) : t === 'vec3' ? T.vec3(d, d, d) : T.vec4(d, d, d, d);
  const c = [0, 1, 2, 3].map((i) => (i < d.length ? (d[i] ?? 0) : i === 3 ? 1 : 0));
  return t === 'float' ? T.float(c[0]) : t === 'vec2' ? T.vec2(c[0], c[1]) : t === 'vec3' ? T.vec3(c[0], c[1], c[2]) : T.vec4(c[0], c[1], c[2], c[3]);
}

/** A `#rrggbb` colour (sRGB) as linear working-space components. */
function linearColor(hex: string): [number, number, number] {
  const c = new THREE.Color();
  try {
    c.set(hex);
  } catch {
    c.set('#ffffff');
  }
  return [c.r, c.g, c.b];
}

// ---- the compiler ----------------------------------------------------------------------

interface Scope {
  readonly graph: MaterialGraphLike;
  readonly ports: Map<string, ResolvedPorts>;
  readonly byId: Map<string, MaterialGraphNodeLike>;
  readonly incoming: Map<string, Map<string, MaterialGraphEdgeLike>>;
  /** A function call's bound inputs (by Function input node id); null at the material level. */
  readonly bound: Map<string, () => Val> | null;
  /** The material-level node problems inside a function are reported on. */
  readonly reportAt: string | null;
  readonly key: string;
  readonly depth: number;
}

function scopeOf(graph: MaterialGraphLike, ports: Map<string, ResolvedPorts>, bound: Scope['bound'], reportAt: string | null, key: string, depth: number): Scope {
  const incoming = new Map<string, Map<string, MaterialGraphEdgeLike>>();
  for (const e of graph.edges) {
    let m = incoming.get(e.to.node);
    if (m === undefined) incoming.set(e.to.node, (m = new Map()));
    m.set(e.to.port, e);
  }
  return { graph, ports, byId: new Map(graph.nodes.map((n) => [n.id, n])), incoming, bound, reportAt, key, depth };
}

/** How deep function calls may nest (validation refuses cycles; this guards malformed data). */
const MAX_CALL_DEPTH = 16;

/**
 * Compile a material graph to TSL slot nodes. Pure (no GPU): the result's
 * nodes go on a node material (`buildGraphMaterial`) or are inspected by tests.
 */
export function compileMaterialGraph(input: { graph: MaterialGraphLike; parameters?: readonly MaterialParameterLike[] }, env: GraphCompileEnv): CompiledMaterialGraph {
  const parameters = input.parameters ?? [];
  const problems: GraphProblem[] = [];
  const textures = new Set<string>();
  const pending = new Set<string>();
  let animated = false;
  let nodeCount = 0;
  const problem = (scope: Scope, nodeId: string | undefined, severity: GraphProblem['severity'], message: string): void => {
    const at = scope.reportAt ?? nodeId;
    const text = scope.reportAt !== null ? `in the function: ${message}` : message;
    if (problems.some((p) => p.nodeId === at && p.message === text)) return;
    problems.push({ ...(at !== undefined ? { nodeId: at } : {}), severity, message: text });
  };
  const fnOf = (id: string): MaterialFunctionLike | null => {
    const f = env.fn(id);
    return f !== null && f.kind === 'material-function' ? f : null;
  };

  // Parameter uniforms, one per key (shared by every Parameter node reading it).
  const uniforms = new Map<string, Val>();
  const parameterValue = (key: string): Val | null => {
    const have = uniforms.get(key);
    if (have !== undefined) return have;
    const p = parameters.find((x) => x.key === key);
    if (p === undefined) return null;
    let v: Val;
    if (p.type === 'texture') v = { t: 'texture', asset: typeof p.default === 'string' ? p.default : '' };
    else {
      const t = parameterPortType(p.type) as ValueType;
      const base: number[] = p.type === 'color' ? linearColor(typeof p.default === 'string' ? p.default : '#ffffff') : typeof p.default === 'number' ? [p.default] : Array.isArray(p.default) ? [...(p.default as number[])] : [0];
      const value = t === 'float' ? (base[0] ?? 0) : t === 'vec2' ? new THREE.Vector2(base[0] ?? 0, base[1] ?? 0) : t === 'vec3' ? new THREE.Vector3(base[0] ?? 0, base[1] ?? 0, base[2] ?? 0) : new THREE.Vector4(base[0] ?? 0, base[1] ?? 0, base[2] ?? 0, base[3] ?? 0);
      const u = T.uniform(value as never);
      if (env.overrideKey !== undefined && p.visibility !== 'private') {
        const okey = env.overrideKey;
        const isColor = p.type === 'color';
        (u as N).onObjectUpdate(({ object }: { object: THREE.Object3D | null }) => {
          const all = object?.userData?.[OVERRIDES_KEY] as Record<string, Record<string, unknown>> | undefined;
          const o = all?.[okey]?.[key];
          const src: number[] | null = o === undefined ? null : isColor && typeof o === 'string' ? linearColor(o) : typeof o === 'number' ? [o] : Array.isArray(o) ? (o as number[]) : null;
          const vals = src ?? base;
          if (t === 'float') return vals[0] ?? 0;
          (u as N).value.fromArray([vals[0] ?? 0, vals[1] ?? 0, vals[2] ?? 0, vals[3] ?? 0]);
          return undefined;
        });
      }
      v = { t, n: u };
    }
    uniforms.set(key, v);
    return v;
  };

  const texNode = (scope: Scope, nodeId: string, asset: string, sampler: SamplerLike): THREE.Texture | null => {
    if (asset === '') return null;
    textures.add(asset);
    const t = env.texture(asset, sampler);
    if (t === 'loading') {
      pending.add(asset);
      return null;
    }
    if (t === null) {
      problem(scope, nodeId, 'error', `texture "${asset}" is not available`);
      return null;
    }
    return t;
  };

  const memo = new Map<string, Record<string, Val>>();
  const visiting = new Set<string>();

  const posWorld = (stage: Stage): N => (stage === 'vertex' ? T.modelWorldMatrix.mul(T.vec4(T.positionLocal, 1)).xyz : T.positionWorld);
  const builtin = (scope: Scope, nodeId: string, name: string, stage: Stage): N => {
    switch (name) {
      case 'uv0':
        return T.uv(0);
      case 'uv1':
        return T.uv(1);
      case 'positionWorld':
        return posWorld(stage);
      case 'positionObject':
        return T.positionLocal;
      case 'normalWorld':
        return stage === 'vertex' ? T.normalize(T.modelWorldMatrix.mul(T.vec4(T.normalLocal, 0)).xyz) : T.normalWorldGeometry;
      case 'normalObject':
        return T.normalLocal;
      case 'viewDirWorld':
        return T.normalize(T.cameraPosition.sub(posWorld(stage)));
      case 'viewDirTangent':
        if (stage === 'vertex') {
          problem(scope, nodeId, 'warning', 'the tangent-space view direction exists only for pixels (not in a vertex offset); (0, 0, 1) is used');
          return T.vec3(0, 0, 1);
        }
        return T.normalize(T.positionViewDirection.mul(T.TBNViewMatrix));
      case 'screenUV':
        if (stage === 'vertex') {
          problem(scope, nodeId, 'warning', 'the screen position exists only for pixels (not in a vertex offset); (0.5, 0.5) is used');
          return T.vec2(0.5, 0.5);
        }
        return T.screenUV;
      case 'time':
        animated = true;
        return env.globals.time;
      default:
        problem(scope, nodeId, 'error', `unknown built-in input "${name}"`);
        return T.float(0);
    }
  };

  /** The value an input port reads: its wire (converted), else its default. */
  const inputOf = (scope: Scope, node: MaterialGraphNodeLike, port: ResolvedPort, stage: Stage): Val => {
    const e = scope.incoming.get(node.id)?.get(port.id);
    if (e !== undefined) {
      const src = outputsOf(scope, e.from.node, stage)?.[e.from.port];
      if (src !== undefined) {
        if (port.t === 'texture') return src.t === 'texture' ? src : { t: 'texture', asset: '' };
        if (src.t !== 'texture') return { t: port.t, n: convert(src, port.t) };
      }
    }
    if (port.t === 'texture') return { t: 'texture', asset: '' };
    const d = port.d;
    if (typeof d === 'string') {
      const b = builtin(scope, node.id, d, stage);
      const w: ValueType = d === 'uv0' || d === 'uv1' || d === 'screenUV' ? 'vec2' : d === 'time' ? 'float' : 'vec3';
      return { t: port.t, n: convert({ t: w, n: b }, port.t) };
    }
    return { t: port.t, n: constant(d ?? 0, port.t) };
  };
  const connected = (scope: Scope, nodeId: string, portId: string): boolean => scope.incoming.get(nodeId)?.has(portId) === true;

  const outputsOf = (scope: Scope, nodeId: string, stage: Stage): Record<string, Val> | undefined => {
    const key = `${scope.key}|${stage}|${nodeId}`;
    const have = memo.get(key);
    if (have !== undefined) return have;
    const node = scope.byId.get(nodeId);
    const ports = scope.ports.get(nodeId);
    if (node === undefined || ports === undefined) return undefined;
    if (visiting.has(key)) {
      problem(scope, nodeId, 'error', 'a value depends on itself (a cycle)');
      return undefined;
    }
    visiting.add(key);
    const inp: Record<string, Val> = {};
    for (const p of ports.inputs) {
      if (p.t === 'texture' && !connected(scope, nodeId, p.id)) {
        inp[p.id] = { t: 'texture', asset: '' };
        continue;
      }
      // Inputs are read lazily through `get` so a call's unused ports compile nothing.
      Object.defineProperty(inp, p.id, { enumerable: true, configurable: true, get: () => inputOf(scope, node, p, stage) });
    }
    let result: Record<string, Val>;
    try {
      nodeCount += 1;
      result = compileNode(scope, node, ports, inp, stage);
    } finally {
      visiting.delete(key);
    }
    memo.set(key, result);
    return result;
  };

  const v = (x: Val | undefined): N => (x !== undefined && x.t !== 'texture' ? x.n : T.float(0));
  const texOf = (x: Val | undefined): string => (x !== undefined && x.t === 'texture' ? x.asset : '');

  const samplerOf = (node: MaterialGraphNodeLike, colour: boolean): SamplerLike => ({
    colorSpace: colour ? (str(field(node, 'colorSpace'), 'srgb') === 'linear' ? 'linear' : 'srgb') : 'linear',
    wrap: ((w) => (w === 'clamp' || w === 'mirror' ? w : 'repeat'))(str(field(node, 'wrap'), 'repeat')),
    filter: str(field(node, 'filter'), 'linear') === 'nearest' ? 'nearest' : 'linear',
  });
  /** The texture a sampling node reads: its texture wire, else its own field. */
  const textureFor = (scope: Scope, node: MaterialGraphNodeLike, inp: Record<string, Val>, colour: boolean): THREE.Texture | null => {
    const wired = texOf(inp['tex']);
    const asset = wired !== '' ? wired : str(field(node, 'texture'), '');
    if (asset === '') {
      problem(scope, node.id, 'warning', 'no texture (set its Texture field or wire a texture in); it reads white');
      return null;
    }
    return texNode(scope, node.id, asset, samplerOf(node, colour));
  };
  const sample = (t: THREE.Texture, uv: N, stage: Stage): N => {
    const s = T.texture(t, uv);
    return stage === 'vertex' ? s.level(0) : s;
  };

  const windStrength = (stage: Stage): N => {
    const g = env.globals;
    animated = true;
    const world = posWorld(stage);
    const gust = T.sin(g.time.mul(g.gustFreq).mul(TAU).sub(world.x.mul(0.08).mul(g.turb.mul(3).add(1)))).mul(0.5).add(0.5);
    return g.strength.add(g.gust.mul(gust));
  };

  const valueNoise = (p: N): N => {
    const i = T.floor(p);
    const f = T.fract(p);
    const u = f.mul(f).mul(T.float(3).sub(f.mul(2)));
    const h = (ox: number, oy: number): N => T.mx_cell_noise_float(i.add(T.vec2(ox, oy)));
    return T.mix(T.mix(h(0, 0), h(1, 0), u.x), T.mix(h(0, 1), h(1, 1), u.x), u.y);
  };
  const voronoi = (p: N): { d: N; cell: N } => {
    const base = T.floor(p);
    let best: N = T.float(8);
    let cell: N = T.float(0);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const c = base.add(T.vec2(ox, oy));
        const jitter = T.mx_cell_noise_vec3(T.vec3(c, 0)).xy;
        const d = T.length(c.add(jitter).sub(p));
        const closer = d.lessThan(best);
        cell = T.select(closer, T.mx_cell_noise_float(c), cell);
        best = T.min(best, d);
      }
    }
    return { d: best, cell };
  };
  const bayer2 = (a: N): N => {
    const f = T.floor(a);
    return T.fract(f.x.div(2).add(f.y.mul(f.y).mul(0.75)));
  };
  const bayer4 = (a: N): N => bayer2(a.mul(0.5)).mul(0.25).add(bayer2(a));
  const bayer8 = (a: N): N => bayer4(a.mul(0.5)).mul(0.25).add(bayer2(a));

  function compileNode(scope: Scope, node: MaterialGraphNodeLike, ports: ResolvedPorts, inp: Record<string, Val>, stage: Stage): Record<string, Val> {
    const outT = (id: string): ValueType => {
      const t = ports.outputs.find((p) => p.id === id)?.t;
      return isValueType(t) ? t : 'float';
    };
    const one = (id: string, n: N): Record<string, Val> => ({ [id]: { t: outT(id), n } });
    const g = env.globals;
    switch (node.type) {
      // ---- inputs
      case 'float':
        return one('value', T.float(numOf(field(node, 'value'), 0)));
      case 'vec2':
      case 'vec3':
      case 'vec4': {
        const t = node.type as ValueType;
        const raw = field(node, 'value');
        return one('value', constant(Array.isArray(raw) ? (raw as number[]) : [0, 0, 0, 0], t));
      }
      case 'color': {
        const [r, gg, b] = linearColor(str(field(node, 'color'), '#ffffff'));
        const a = numOf(field(node, 'alpha'), 1);
        const rgb = T.vec3(r, gg, b);
        return { rgb: { t: 'vec3', n: rgb }, alpha: { t: 'float', n: T.float(a) }, rgba: { t: 'vec4', n: T.vec4(r, gg, b, a) } };
      }
      case 'parameter': {
        const key = str(field(node, 'key'), '');
        const p = parameterValue(key);
        if (p === null) {
          problem(scope, node.id, 'error', `the material has no parameter "${key}"`);
          return one('value', T.float(0));
        }
        return { value: p };
      }
      case 'time':
        animated = true;
        return one('time', g.time);
      case 'uv':
        return one('uv', T.uv(str(field(node, 'set'), 'uv0') === 'uv1' ? 1 : 0));
      case 'vertexColor': {
        const zero = str(field(node, 'absent'), 'white') === 'zero';
        const c = T.Fn((builder: { geometry?: THREE.BufferGeometry }) => (builder.geometry?.hasAttribute('color') === true ? T.attribute('color', 'vec4') : zero ? T.vec4(0, 0, 0, 1) : T.vec4(1, 1, 1, 1)))();
        return { rgba: { t: 'vec4', n: c }, rgb: { t: 'vec3', n: c.xyz }, alpha: { t: 'float', n: c.w } };
      }
      case 'position': {
        const space = str(field(node, 'space'), 'world');
        if (space === 'object') return one('position', T.positionLocal);
        if (space === 'view') return one('position', stage === 'vertex' ? T.modelViewMatrix.mul(T.vec4(T.positionLocal, 1)).xyz : T.positionView);
        return one('position', posWorld(stage));
      }
      case 'normal': {
        const space = str(field(node, 'space'), 'world');
        if (space === 'object') return one('normal', T.normalLocal);
        if (space === 'view') return one('normal', stage === 'vertex' ? T.transformNormalToView(T.normalLocal) : T.normalViewGeometry);
        return one('normal', builtin(scope, node.id, 'normalWorld', stage));
      }
      case 'viewDirection': {
        if (str(field(node, 'space'), 'world') === 'view') {
          return one('direction', stage === 'vertex' ? T.normalize(T.modelViewMatrix.mul(T.vec4(T.positionLocal, 1)).xyz.negate()) : T.positionViewDirection);
        }
        return one('direction', builtin(scope, node.id, 'viewDirWorld', stage));
      }
      case 'objectPosition': {
        const origin = T.modelWorldMatrix.mul(T.vec4(instanceOrigin(), 1)).xyz;
        return one('position', stage === 'vertex' ? origin : T.varying(origin));
      }
      case 'cameraDistance':
        return one('distance', T.length(T.cameraPosition.sub(posWorld(stage))));
      case 'screenUV':
        return one('uv', builtin(scope, node.id, 'screenUV', stage));
      case 'instanceIndex': {
        const i = T.float(T.instanceIndex);
        return one('index', stage === 'vertex' ? i : T.varying(i));
      }
      case 'wind': {
        const dir = T.length(g.windDir).greaterThan(0).select(T.normalize(g.windDir), T.vec2(1, 0));
        animated = true;
        return { direction: { t: 'vec3', n: T.vec3(dir.x, 0, dir.y) }, strength: { t: 'float', n: windStrength(stage) }, turbulence: { t: 'float', n: g.turb } };
      }
      // ---- maths
      case 'add':
        return one('out', v(inp['a']).add(v(inp['b'])));
      case 'subtract':
        return one('out', v(inp['a']).sub(v(inp['b'])));
      case 'multiply':
        return one('out', v(inp['a']).mul(v(inp['b'])));
      case 'divide':
        return one('out', v(inp['a']).div(v(inp['b'])));
      case 'min':
        return one('out', T.min(v(inp['a']), v(inp['b'])));
      case 'max':
        return one('out', T.max(v(inp['a']), v(inp['b'])));
      case 'power':
        return one('out', T.pow(v(inp['a']), v(inp['b'])));
      case 'dot': {
        const t = (inp['a'] as { t: ValueType }).t;
        return one('out', t === 'float' ? v(inp['a']).mul(v(inp['b'])) : T.dot(v(inp['a']), v(inp['b'])));
      }
      case 'cross':
        return one('out', T.cross(v(inp['a']), v(inp['b'])));
      case 'normalize':
        return one('out', outT('out') === 'float' ? T.sign(v(inp['in'])) : T.normalize(v(inp['in'])));
      case 'length': {
        const t = (inp['in'] as { t: ValueType }).t;
        return one('out', t === 'float' ? T.abs(v(inp['in'])) : T.length(v(inp['in'])));
      }
      case 'lerp':
        return one('out', T.mix(v(inp['a']), v(inp['b']), v(inp['t'])));
      case 'clamp':
        return one('out', T.clamp(v(inp['in']), v(inp['min']), v(inp['max'])));
      case 'saturate':
        return one('out', T.clamp(v(inp['in']), 0, 1));
      case 'smoothstep':
        return one('out', T.smoothstep(v(inp['edge0']), v(inp['edge1']), v(inp['x'])));
      case 'step':
        return one('out', T.step(v(inp['edge']), v(inp['x'])));
      case 'abs':
        return one('out', T.abs(v(inp['in'])));
      case 'floor':
        return one('out', T.floor(v(inp['in'])));
      case 'fract':
        return one('out', T.fract(v(inp['in'])));
      case 'sin':
        return one('out', T.sin(v(inp['in'])));
      case 'cos':
        return one('out', T.cos(v(inp['in'])));
      case 'oneMinus':
        return one('out', T.float(1).sub(v(inp['in'])));
      case 'remap': {
        const x = v(inp['in']);
        const a = v(inp['inMin']);
        const b = v(inp['inMax']);
        const c = v(inp['outMin']);
        const d = v(inp['outMax']);
        return one('out', c.add(x.sub(a).mul(d.sub(c)).div(b.sub(a))));
      }
      // ---- vectors
      case 'split': {
        const x = v(inp['in']);
        return { x: { t: 'float', n: x.x }, y: { t: 'float', n: x.y }, z: { t: 'float', n: x.z }, w: { t: 'float', n: x.w } };
      }
      case 'combine': {
        const x = v(inp['x']);
        const y = v(inp['y']);
        const z = v(inp['z']);
        const w = v(inp['w']);
        return { xyzw: { t: 'vec4', n: T.vec4(x, y, z, w) }, xyz: { t: 'vec3', n: T.vec3(x, y, z) }, xy: { t: 'vec2', n: T.vec2(x, y) } };
      }
      case 'swizzle': {
        const raw = str(field(node, 'mask'), 'xyz');
        const mask = /^[xyzw]{1,4}$/.test(raw) ? raw : /^[rgba]{1,4}$/.test(raw) ? raw.replace(/r/g, 'x').replace(/g/g, 'y').replace(/b/g, 'z').replace(/a/g, 'w') : 'xyz';
        return one('out', v(inp['in'])[mask]);
      }
      // ---- textures
      case 'sampleTexture': {
        const t = textureFor(scope, node, inp, true);
        const s = t !== null ? sample(t, v(inp['uv']), stage) : T.vec4(1, 1, 1, 1);
        return { rgba: { t: 'vec4', n: s }, rgb: { t: 'vec3', n: s.xyz }, r: { t: 'float', n: s.x }, g: { t: 'float', n: s.y }, b: { t: 'float', n: s.z }, a: { t: 'float', n: s.w } };
      }
      case 'normalMap': {
        const t = textureFor(scope, node, inp, false);
        if (t === null) return one('normal', T.vec3(0, 0, 1));
        // As three's normal map: decode, scale xy by the strength (tangent space).
        const n = sample(t, v(inp['uv']), stage).xyz.mul(2).sub(1);
        return one('normal', T.vec3(n.xy.mul(v(inp['strength'])), n.z));
      }
      case 'triplanar': {
        const t = textureFor(scope, node, inp, true);
        if (t === null) return { rgba: { t: 'vec4', n: T.vec4(1, 1, 1, 1) }, rgb: { t: 'vec3', n: T.vec3(1, 1, 1) } };
        const p = v(inp['position']).mul(v(inp['scale']));
        const w0 = T.pow(T.abs(T.normalize(v(inp['normal']))), T.vec3(v(inp['sharpness'])));
        const w = w0.div(w0.x.add(w0.y).add(w0.z).add(1e-5));
        const s = sample(t, p.zy, stage).mul(w.x).add(sample(t, p.xz, stage).mul(w.y)).add(sample(t, p.xy, stage).mul(w.z));
        return { rgba: { t: 'vec4', n: s }, rgb: { t: 'vec3', n: s.xyz } };
      }
      case 'flipbook': {
        const cols = Math.max(1, Math.round(numOf(field(node, 'columns'), 4)));
        const rows = Math.max(1, Math.round(numOf(field(node, 'rows'), 4)));
        const f = T.floor(T.mod(T.floor(v(inp['frame'])), cols * rows));
        const col = T.mod(f, cols);
        const row = T.floor(f.div(cols));
        return one('uv', v(inp['uv']).add(T.vec2(col, row)).div(T.vec2(cols, rows)));
      }
      case 'noise': {
        const p = v(inp['uv']).mul(v(inp['scale']));
        const kind = str(field(node, 'noise'), 'gradient');
        if (kind === 'voronoi') {
          const r = voronoi(p);
          return { value: { t: 'float', n: r.d }, cell: { t: 'float', n: r.cell } };
        }
        const value = kind === 'value' ? valueNoise(p) : T.mx_noise_float(p).mul(0.5).add(0.5);
        return { value: { t: 'float', n: value }, cell: { t: 'float', n: T.mx_cell_noise_float(T.floor(p)) } };
      }
      case 'gradient': {
        const uv = v(inp['uv']);
        const shape = str(field(node, 'shape'), 'linear');
        const c = uv.sub(0.5);
        const n = shape === 'radial' ? T.clamp(T.length(c).mul(2), 0, 1) : shape === 'angular' ? T.atan(c.y, c.x).div(TAU).add(0.5) : T.clamp(uv.x, 0, 1);
        return one('value', n);
      }
      case 'colorRamp': {
        const a = linearColor(str(field(node, 'from'), '#000000'));
        const b = linearColor(str(field(node, 'to'), '#ffffff'));
        const t = T.clamp(v(inp['t']), 0, 1);
        const mode = str(field(node, 'interpolation'), 'linear');
        const k = mode === 'smooth' ? T.smoothstep(0, 1, t) : mode === 'constant' ? T.step(0.5, t) : t;
        return one('rgb', T.mix(T.vec3(...a), T.vec3(...b), k));
      }
      // ---- utility
      case 'fresnel': {
        const ndv = T.clamp(T.abs(T.dot(T.normalize(v(inp['view'])), T.normalize(v(inp['normal'])))), 0, 1);
        return one('out', T.pow(T.float(1).sub(ndv), v(inp['power'])));
      }
      case 'rim': {
        const ndv = T.clamp(T.abs(T.dot(T.normalize(v(inp['view'])), T.normalize(v(inp['normal'])))), 0, 1);
        const edge = T.float(1).sub(v(inp['width']));
        return one('out', T.smoothstep(edge, edge.add(T.max(v(inp['softness']), 1e-4)), T.float(1).sub(ndv)));
      }
      case 'posterize': {
        const steps = T.max(v(inp['steps']), 1);
        return one('out', T.floor(v(inp['in']).mul(steps)).div(steps));
      }
      case 'dither': {
        if (stage === 'vertex') {
          problem(scope, node.id, 'warning', 'dithering works on pixels only (not in a vertex offset); it passes 1');
          return one('out', T.float(1));
        }
        const eight = str(field(node, 'pattern'), 'bayer4') === 'bayer8';
        const pixel = v(inp['screen']).mul(T.screenSize);
        const threshold = (eight ? bayer8(pixel) : bayer4(pixel)).add(eight ? 0.5 / 64 : 0.5 / 16);
        return one('out', T.step(threshold, v(inp['in'])));
      }
      case 'worldUV': {
        const p = v(inp['position']).mul(v(inp['scale']));
        const plane = str(field(node, 'plane'), 'xz');
        return one('uv', plane === 'xy' ? p.xy : plane === 'zy' ? p.zy : p.xz);
      }
      case 'parallax': {
        const view = T.normalize(v(inp['view']));
        return one('uv', v(inp['uv']).add(view.xy.div(view.z.add(0.42)).mul(v(inp['height']).mul(v(inp['scale'])))));
      }
      case 'displace':
        return one('offset', v(inp['direction']).mul(v(inp['height'])).mul(v(inp['scale'])));
      case 'alphaClip': {
        const a = v(inp['alpha']);
        if (stage === 'vertex') return one('alpha', a);
        const th = v(inp['threshold']);
        const clipped = T.Fn(() => {
          T.Discard(a.lessThan(th));
          return a;
        })();
        return one('alpha', clipped);
      }
      // ---- sub-graphs
      case 'call':
        return compileCall(scope, node, ports, inp, stage);
      case 'functionInput': {
        const b = scope.bound?.get(node.id);
        if (b !== undefined) return { value: b() };
        const t = ports.outputs[0]?.t ?? 'float';
        if (t === 'texture') return { value: { t: 'texture', asset: '' } };
        const d = field(node, 'default');
        return { value: { t, n: constant(Array.isArray(d) ? (d as number[]) : [0, 0, 0, 0], t) } };
      }
      default:
        problem(scope, node.id, 'error', `unknown node type "${node.type}"`);
        return Object.fromEntries(ports.outputs.map((p) => [p.id, p.t === 'texture' ? { t: 'texture', asset: '' } : { t: p.t, n: constant(0, p.t) }]));
    }
  }

  function compileCall(scope: Scope, node: MaterialGraphNodeLike, ports: ResolvedPorts, inp: Record<string, Val>, stage: Stage): Record<string, Val> {
    const id = str(field(node, 'function'), '');
    const f = fnOf(id);
    const fallback = (): Record<string, Val> => Object.fromEntries(ports.outputs.map((p) => [p.id, p.t === 'texture' ? { t: 'texture', asset: '' } : { t: p.t, n: constant(0, p.t) }]));
    if (f === null) {
      problem(scope, node.id, 'error', id === '' ? 'no function chosen' : `no material function "${id}"`);
      return fallback();
    }
    if (scope.depth >= MAX_CALL_DEPTH) {
      problem(scope, node.id, 'error', 'functions call each other too deeply');
      return fallback();
    }
    const bound = new Map<string, () => Val>();
    for (const p of ports.inputs) if (connected(scope, node.id, p.id)) bound.set(p.id, () => inp[p.id]!);
    const inner = scopeOf(f.graph, resolveMaterialGraphPorts(f.graph, [], fnOf), bound, scope.reportAt ?? node.id, `${scope.key}/${node.id}`, scope.depth + 1);
    const out: Record<string, Val> = {};
    for (const p of ports.outputs) {
      const o = inner.byId.get(p.id);
      const oports = inner.ports.get(p.id);
      if (o === undefined || oports === undefined || oports.inputs[0] === undefined) {
        out[p.id] = p.t === 'texture' ? { t: 'texture', asset: '' } : { t: p.t, n: constant(0, p.t) };
        continue;
      }
      nodeCount += 1;
      out[p.id] = inputOf(inner, o, oports.inputs[0], stage);
    }
    return out;
  }

  // ---- the outputs
  const top = scopeOf(input.graph, resolveMaterialGraphPorts(input.graph, parameters, fnOf), null, null, '', 0);
  const surfaces = input.graph.nodes.filter((n) => n.type === 'pbr' || n.type === 'unlit');
  const surfaceNode = surfaces[0] ?? null;
  if (surfaceNode === null) problems.push({ severity: 'warning', message: 'no surface output (add a PBR or Unlit output); it draws as a plain white surface' });
  const slot = (portId: string, onlyConnected: boolean): N | null => {
    if (surfaceNode === null) return null;
    if (onlyConnected && !connected(top, surfaceNode.id, portId)) return null;
    const port = top.ports.get(surfaceNode.id)?.inputs.find((p) => p.id === portId);
    return port === undefined ? null : v(inputOf(top, surfaceNode, port, 'fragment'));
  };
  const surface = surfaceNode === null ? null : (surfaceNode.type as 'pbr' | 'unlit');
  const pbr = surface === 'pbr';
  const colorNode = slot(pbr ? 'baseColor' : 'color', false);
  const normalIn = pbr ? slot('normal', true) : null;
  const emissiveIn = pbr ? slot('emissive', true) : null;
  const vertex = input.graph.nodes.find((n) => n.type === 'vertexOffset');
  let position: N | null = null;
  if (vertex !== undefined && connected(top, vertex.id, 'offset')) {
    const port = top.ports.get(vertex.id)!.inputs[0]!;
    const offset = v(inputOf(top, vertex, port, 'vertex'));
    position = str(field(vertex, 'space'), 'object') === 'world' ? T.positionLocal.add(T.modelWorldMatrixInverse.mul(T.vec4(offset, 0)).xyz) : T.positionLocal.add(offset);
  }
  const slots = {
    color: colorNode !== null ? T.vec4(colorNode, 1) : null,
    metalness: pbr ? slot('metalness', false) : null,
    roughness: pbr ? slot('roughness', false) : null,
    // A tangent-space normal to view space, as three's normal map does.
    normal: normalIn !== null ? T.TBNViewMatrix.mul(normalIn).normalize() : null,
    // The material's own emissive stays added: the selection tint and the checkpoint glow write it (per-mesh copies).
    emissive: emissiveIn !== null ? emissiveIn.add(T.materialEmissive) : null,
    ao: pbr ? slot('ao', true) : null,
    opacity: slot('opacity', true),
    alphaTest: slot('alphaClip', true),
    position,
  };
  const flag = (key: string, d: boolean): boolean => (surfaceNode === null ? d : ((x) => (typeof x === 'boolean' ? x : d))(field(surfaceNode, key)));
  return {
    surface,
    slots,
    flags: { doubleSided: flag('doubleSided', false), transparent: flag('transparent', false), castShadows: flag('castShadows', true) },
    animated,
    textures: [...textures].sort(),
    pending: [...pending].sort(),
    problems,
    nodeCount,
  };
}

/** Uniforms standing in for the library's clock and wind (a compile for its problems only). */
function detachedGlobals(): GraphGlobals {
  return { time: T.uniform(0), windDir: T.uniform(new THREE.Vector2(1, 0)), strength: T.uniform(0), gust: T.uniform(0), gustFreq: T.uniform(0), turb: T.uniform(0) };
}

/**
 * A graph material's compile problems without loading anything (the
 * editor's node badges and Problems tab): `textureIds` are the project's
 * texture assets (any other named texture is a problem).
 */
export function materialGraphProblems(def: { graph: MaterialGraphLike; parameters?: readonly MaterialParameterLike[] }, functions: readonly MaterialFunctionLike[], textureIds: ReadonlySet<string>): readonly GraphProblem[] {
  const byId = new Map(functions.filter((f) => f.kind === 'material-function').map((f) => [f.graphId, f]));
  return compileMaterialGraph(def, { globals: detachedGlobals(), texture: (id) => (textureIds.has(id) ? 'loading' : null), fn: (id) => byId.get(id) ?? null }).problems;
}

/** A node material for a compiled graph (PBR → standard, Unlit → basic). */
export function buildGraphMaterial(c: CompiledMaterialGraph, name: string): THREE.Material {
  const m = c.surface === 'unlit' ? new MeshBasicNodeMaterial() : new MeshStandardNodeMaterial();
  applyGraphNodes(m, c);
  m.name = name;
  return m as unknown as THREE.Material;
}

/** Put a compiled graph's nodes and flags on a node material (a recompile reuses the object). */
export function applyGraphNodes(material: MeshBasicNodeMaterial | MeshStandardNodeMaterial, c: CompiledMaterialGraph): void {
  const m = material as N;
  m.colorNode = c.slots.color;
  m.opacityNode = c.slots.opacity;
  m.alphaTestNode = c.slots.alphaTest;
  m.positionNode = c.slots.position;
  if ((material as MeshStandardNodeMaterial).isMeshStandardNodeMaterial === true) {
    m.metalnessNode = c.slots.metalness;
    m.roughnessNode = c.slots.roughness;
    m.normalNode = c.slots.normal;
    m.emissiveNode = c.slots.emissive;
    m.aoNode = c.slots.ao;
  }
  m.vertexColors = false; // COLOR_0 is read by Vertex colour nodes only
  m.side = c.flags.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  m.transparent = c.flags.transparent;
  m.needsUpdate = true;
}

// ---- the digest (the compile cache key) ---------------------------------------------

/** Canonical JSON: object keys sorted, arrays in order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** What of a graph a compile reads: node types and data, and the wires (not positions, groups or comments). */
function compileView(g: MaterialGraphLike): unknown {
  return {
    nodes: [...g.nodes].map((n) => ({ id: n.id, type: n.type, data: n.data ?? {} })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: g.edges.map((e) => [e.from.node, e.from.port, e.to.node, e.to.port].join('\u0000')).sort(),
  };
}

/**
 * The canonical text a compile depends on: the graph (node types, data and
 * wires — moving a node changes nothing), the parameters, and every material
 * function it reaches (with their interface order, which is by position).
 */
export function materialGraphCanonical(def: { graph: MaterialGraphLike; parameters?: readonly MaterialParameterLike[] }, fn: (id: string) => MaterialFunctionLike | null): string {
  const reached = new Map<string, unknown>();
  const walk = (g: MaterialGraphLike, depth: number): void => {
    if (depth > MAX_CALL_DEPTH) return;
    for (const n of g.nodes) {
      if (n.type !== 'call') continue;
      const id = str(n.data?.['function'], '');
      if (id === '' || reached.has(id)) continue;
      const f = fn(id);
      if (f === null || f.kind !== 'material-function') {
        reached.set(id, null);
        continue;
      }
      const itf = functionInterface(f.graph);
      reached.set(id, { graph: compileView(f.graph), inputs: itf.inputs.map((p) => p.id), outputs: itf.outputs.map((p) => p.id) });
      walk(f.graph, depth + 1);
    }
  };
  walk(def.graph, 0);
  return canonical({ graph: compileView(def.graph), parameters: def.parameters ?? [], functions: Object.fromEntries(reached) });
}

/** A short digest of a canonical text (FNV-1a, two 32-bit lanes, hex). */
export function digestOf(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
