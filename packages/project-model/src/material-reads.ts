/**
 * What a material reads and writes (`MATERIAL_DECLARATIONS` in
 * `materials.ts`): a fixed shader's from that table and its parameters, a
 * graph material's inferred from its nodes. Editors that paint or place ask
 * `materialReads` before they draw, and say so when the material would show
 * nothing of it.
 *
 * Inference walks the graph upstream from where a value is used to where it
 * comes from, through material-function calls (into the function's graph and
 * back out through its inputs):
 * - `layerWeights`: a Height blend or Weighted mix whose weights come from a
 *   vertex colour set or vertex paint — or a Height blend with its weights
 *   unwired, which reads the paint;
 * - `vertexPaint`: a Vertex colour node on the paint set, or such an unwired
 *   Height blend;
 * - `vertexAO`: a surface output's occlusion fed from COLOR_0;
 * - `alphaIsHeight`: a Height blend's heights fed from a texture's alpha;
 * - `alphaIsOpacity`: a surface output's opacity or alpha clip fed from a
 *   texture's alpha;
 * - `writesDecal`: a surface output drawn as a decal;
 * - `trimRows`: never (a graph has no row table).
 * Only nodes that reach an output count. Mix weights select between values
 * and are not the value: a walk for occlusion, height or opacity does not
 * follow them (the layered template's occlusion is mixed by painted weights,
 * yet it is not the vertex occlusion).
 *
 * Pure.
 */
import type { GraphData, GraphDocument, GraphNode } from './graph';
import { MATERIAL_DECLARATIONS, MATERIAL_DECLARATION_KEYS, MATERIAL_PARAMS, resolveMaterial, type MaterialDeclaration, type MaterialDeclarationKey, type MaterialDef, type MaterialParamValue } from './materials';

// The table and the shader types' on-screen names, for packages that may read only this subpath (the editor).
export { MATERIAL_DECLARATIONS, MATERIAL_DECLARATION_KEYS, MATERIAL_SHADER_LABELS, type MaterialDeclaration, type MaterialDeclarationKey, type MaterialDeclarationWhen } from './materials';

/** The outputs a graph draws through (a node upstream of none of them is not compiled). */
const OUTPUT_TYPES: ReadonlySet<string> = new Set(['pbr', 'unlit', 'customLit', 'vertexOffset']);
/** The surface outputs (one per graph). */
const SURFACE_TYPES: ReadonlySet<string> = new Set(['pbr', 'unlit', 'customLit']);
/** Texture reads whose `a` (and `rgba`) output is the texture's alpha. */
const SAMPLE_TYPES: ReadonlySet<string> = new Set(['sampleTexture', 'projectedSample', 'triplanar', 'flipbook']);
/** Inputs that pick between values rather than give one (not followed for occlusion, height or opacity). */
const SELECTOR_INPUTS: ReadonlySet<string> = new Set(['weightedMix:weights', 'heightBlend:weights']);
/** Function calls are followed this deep (the model refuses call cycles; this only bounds a broken project). */
const CALL_DEPTH_MAX = 8;

/** What the walks may look inside: the material functions calls name. */
export interface MaterialReadsContext {
  /** The project's materials (an instance reads as its root draws). */
  readonly materials?: readonly MaterialDef[];
  /** The project's standalone graphs (material functions); absent: calls are opaque. */
  readonly functions?: readonly GraphDocument[];
}

const NONE: MaterialDeclaration = Object.freeze(Object.fromEntries(MATERIAL_DECLARATION_KEYS.map((k) => [k, false])) as Record<MaterialDeclarationKey, boolean>);

/** One graph in a call chain: the graph and, for a function, the call that runs it (in the frame above). */
interface Frame {
  readonly graph: GraphData;
  readonly byId: ReadonlyMap<string, GraphNode>;
  readonly call: { readonly frame: Frame; readonly node: GraphNode } | null;
  readonly depth: number;
  /** The call path (two calls of one function are two frames). */
  readonly key: string;
}

function frameOf(graph: GraphData, call: Frame['call'], depth: number): Frame {
  return { graph, byId: new Map(graph.nodes.map((n) => [n.id, n])), call, depth, key: call === null ? '' : `${call.frame.key}/${call.node.id}` };
}

/** A source a walk looks for, given the node a wire comes from and its port. */
type Source = (node: GraphNode, port: string) => boolean;

const vertexColourSet = (n: GraphNode): string => String(n.data?.['set'] ?? 'COLOR_0');
const isVertexData: Source = (n) => n.type === 'vertexColor';
const isColour0: Source = (n) => n.type === 'vertexColor' && vertexColourSet(n) === 'COLOR_0';
const isAlpha: Source = (n, port) => SAMPLE_TYPES.has(n.type) && (port === 'a' || port === 'rgba');

/** A Height blend with nothing wired into its weights: it reads the object's paint itself. */
function unwiredWeights(f: Frame, n: GraphNode): boolean {
  return n.type === 'heightBlend' && !f.graph.edges.some((e) => e.to.node === n.id && e.to.port === 'weights');
}

/**
 * Whether a value wired into `port` of `node` comes, through any chain of
 * nodes, from a source. `selectors`: also follow the inputs that pick
 * between values.
 */
function reaches(f: Frame, node: GraphNode, port: string, source: Source, selectors: boolean, functions: readonly GraphDocument[] | undefined, seen: Set<string>): boolean {
  const key = `${f.key}:${node.id}:${port}`;
  if (seen.has(key)) return false;
  seen.add(key);
  for (const e of f.graph.edges) {
    if (e.to.node !== node.id || e.to.port !== port) continue;
    const from = f.byId.get(e.from.node);
    if (from === undefined) continue;
    if (source(from, e.from.port)) return true;
    if (from.type === 'functionInput') {
      // Out of the function: on to what the call wires into that input.
      if (f.call !== null && reaches(f.call.frame, f.call.node, from.id, source, selectors, functions, seen)) return true;
      continue;
    }
    if (from.type === 'call') {
      const inner = calledFrame(f, from, functions);
      const out = inner?.graph.nodes.find((x) => x.type === 'functionOutput' && x.id === e.from.port);
      if (inner !== null && out !== undefined && reaches(inner, out, 'value', source, selectors, functions, seen)) return true;
      continue;
    }
    for (const inPort of inputPortsOf(f, from)) {
      if (!selectors && SELECTOR_INPUTS.has(`${from.type}:${inPort}`)) continue;
      if (reaches(f, from, inPort, source, selectors, functions, seen)) return true;
    }
  }
  return false;
}

/** The input ports of a node that something is wired into. */
function inputPortsOf(f: Frame, n: GraphNode): string[] {
  return [...new Set(f.graph.edges.filter((e) => e.to.node === n.id).map((e) => e.to.port))];
}

function calledFrame(f: Frame, call: GraphNode, functions: readonly GraphDocument[] | undefined): Frame | null {
  if (f.depth >= CALL_DEPTH_MAX || functions === undefined) return null;
  const id = call.data?.['function'];
  const doc = functions.find((g) => g.graphId === id);
  return doc === undefined ? null : frameOf(doc.graph, { frame: f, node: call }, f.depth + 1);
}

/** Every node that reaches an output (or, in a function, a function output), with the frame it is in; called functions' too. */
function liveNodes(root: Frame, functions: readonly GraphDocument[] | undefined): { frame: Frame; node: GraphNode }[] {
  const out: { frame: Frame; node: GraphNode }[] = [];
  const visit = (f: Frame, ends: readonly GraphNode[]): void => {
    const live = new Set<string>();
    const stack = ends.map((n) => n.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (live.has(id)) continue;
      live.add(id);
      for (const e of f.graph.edges) if (e.to.node === id) stack.push(e.from.node);
    }
    for (const id of live) {
      const n = f.byId.get(id);
      if (n === undefined) continue;
      out.push({ frame: f, node: n });
      if (n.type === 'call') {
        const inner = calledFrame(f, n, functions);
        if (inner !== null) visit(inner, inner.graph.nodes.filter((x) => x.type === 'functionOutput'));
      }
    }
  };
  visit(root, root.graph.nodes.filter((n) => OUTPUT_TYPES.has(n.type)));
  return out;
}

/** A graph material's declarations, inferred from its nodes (see the file comment). */
export function graphDeclaration(graph: GraphData, functions?: readonly GraphDocument[]): MaterialDeclaration {
  const root = frameOf(graph, null, 0);
  const live = liveNodes(root, functions);
  const d: Record<MaterialDeclarationKey, boolean> = { ...NONE };
  for (const { frame, node } of live) {
    if (node.type === 'vertexColor' && vertexColourSet(node) === 'paint') d.vertexPaint = true;
    if (node.type === 'heightBlend' || node.type === 'weightedMix') {
      if (unwiredWeights(frame, node)) {
        d.layerWeights = true;
        d.vertexPaint = true;
      } else if (reaches(frame, node, 'weights', isVertexData, true, functions, new Set())) d.layerWeights = true;
    }
    if (node.type === 'heightBlend' && reaches(frame, node, 'heights', isAlpha, false, functions, new Set())) d.alphaIsHeight = true;
    if (frame.depth === 0 && SURFACE_TYPES.has(node.type)) {
      const decal = node.data?.['decal'];
      if (typeof decal === 'string' && decal !== 'off') d.writesDecal = true;
      if (node.type === 'pbr' && reaches(frame, node, 'ao', isColour0, false, functions, new Set())) d.vertexAO = true;
      if (reaches(frame, node, 'opacity', isAlpha, false, functions, new Set()) || reaches(frame, node, 'alphaClip', isAlpha, false, functions, new Set())) d.alphaIsOpacity = true;
    }
  }
  return d;
}

/** A parameter's value as the material draws it (its own, else the shader's default). */
function paramValue(m: Pick<MaterialDef, 'shader' | 'params'>, key: string): MaterialParamValue | readonly [number, number] | undefined {
  const own = m.params[key];
  if (own !== undefined) return own;
  const type = MATERIAL_PARAMS[m.shader]?.[key];
  return type === undefined ? undefined : type.default;
}

/** A fixed shader's declarations for its parameter values. */
export function shaderDeclaration(m: Pick<MaterialDef, 'shader' | 'params'>): MaterialDeclaration {
  const table = MATERIAL_DECLARATIONS[m.shader] ?? {};
  const d: Record<MaterialDeclarationKey, boolean> = { ...NONE };
  for (const key of MATERIAL_DECLARATION_KEYS) {
    const rule = table[key];
    if (rule === undefined) continue;
    if (rule === true) d[key] = true;
    else {
      const v = paramValue(m, rule.param);
      d[key] = rule.in.some((x) => x === v);
    }
  }
  return d;
}

/** What a material reads and writes: its graph's (inferred) or its shader's (the table); an instance as its root draws. */
export function materialDeclaration(material: MaterialDef, context: MaterialReadsContext = {}): MaterialDeclaration {
  const m = material.instanceOf !== undefined && context.materials !== undefined ? (resolveMaterial(context.materials, material.materialId) ?? material) : material;
  return m.graph !== undefined ? graphDeclaration(m.graph, context.functions) : shaderDeclaration(m);
}

/** Whether a material reads (or writes) one of its declarations — the check editors make before they paint or place. */
export function materialReads(material: MaterialDef, input: MaterialDeclarationKey, context: MaterialReadsContext = {}): boolean {
  return materialDeclaration(material, context)[input];
}
