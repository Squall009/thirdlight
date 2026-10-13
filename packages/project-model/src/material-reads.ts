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
 *   vertex colour set, vertex paint or the Layer weights node (not a Height
 *   blend with its weights unwired: it takes the paint's four bytes as four
 *   layers' weights as they are, R to A, which is not the layered meaning of
 *   base, layers 2–4 and wetness that `layerWeights` promises the editors);
 * - `vertexPaint`: a Vertex colour node on the paint set, the Layer weights
 *   node (it reads the paint where a mesh stores no weights), a Vertex colour
 *   node that is layer weights ("first") or their wetness (COLOR_1 "zero") —
 *   both read the paint where a mesh stores none — or an unwired Height blend;
 * - `vertexAO`: a surface output's occlusion fed from COLOR_0, trim data or
 *   the Layer weights' occlusion;
 * - `alphaIsHeight`: a Height blend's heights fed from a texture's alpha;
 * - `alphaIsOpacity`: a surface output's opacity or alpha clip fed from a
 *   texture's alpha;
 * - `writesDecal`: a surface output drawn as a decal;
 * - `trimRows`: a layered material naming trim sheets (`layerSheets`).
 * Only nodes that reach an output count. Mix weights select between values
 * and are not the value: a walk for occlusion, height or opacity does not
 * follow them (the layered template's occlusion is mixed by painted weights,
 * yet it is not the vertex occlusion).
 *
 * Pure.
 */
import type { GraphData, GraphDocument, GraphNode } from './graph';
import { MATERIAL_DECLARATIONS, MATERIAL_DECLARATION_KEYS, MATERIAL_PARAMS, resolveMaterial, type MaterialDeclaration, type MaterialDeclarationKey, type MaterialDef, type MaterialParamValue } from './materials';

// The table, the shader types' on-screen names and the instance resolver, for packages that may read only this subpath (the editor).
export { MATERIAL_DECLARATIONS, MATERIAL_DECLARATION_KEYS, MATERIAL_SHADER_LABELS, resolveMaterial, type MaterialDeclaration, type MaterialDeclarationKey, type MaterialDeclarationWhen } from './materials';

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

/** Nothing read (made per call: `texture-slots.ts` reaches this module while `materials.ts` is still loading, so the key list is not there yet at load). */
const none = (): Record<MaterialDeclarationKey, boolean> => Object.fromEntries(MATERIAL_DECLARATION_KEYS.map((k) => [k, false])) as Record<MaterialDeclarationKey, boolean>;

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
const isVertexData: Source = (n) => n.type === 'vertexColor' || n.type === 'layerWeights';
const isColour0: Source = (n, port) => (n.type === 'vertexColor' && (vertexColourSet(n) === 'COLOR_0' || vertexColourSet(n) === 'trim')) || (n.type === 'layerWeights' && port === 'occlusion');
/** A Vertex colour node that reads the paint where the mesh stores none: layer weights ("first") and the wetness beside them (COLOR_1 "zero"). */
const readsPaintWhereUnstored = (n: GraphNode): boolean => {
  const absent = String(n.data?.['absent'] ?? 'white');
  const set = vertexColourSet(n);
  return (set === 'COLOR_0' && absent === 'first') || (set === 'COLOR_1' && absent === 'zero');
};
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
  const d: Record<MaterialDeclarationKey, boolean> = none();
  for (const { frame, node } of live) {
    if (node.type === 'vertexColor' && (vertexColourSet(node) === 'paint' || readsPaintWhereUnstored(node))) d.vertexPaint = true;
    if (node.type === 'layerWeights') d.vertexPaint = true;
    if (node.type === 'heightBlend' || node.type === 'weightedMix') {
      if (unwiredWeights(frame, node)) d.vertexPaint = true;
      else if (reaches(frame, node, 'weights', isVertexData, true, functions, new Set())) d.layerWeights = true;
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

/**
 * The texture parameters whose alpha is a height: read into a Height blend's
 * heights, in a material whose alpha is never opacity and that draws no decal
 * (a cut-out, transparent or decal material keeps A as opacity throughout).
 * The backend checks these textures for a height in A, and an array of them
 * gets a height from brightness for a layer whose texture has none
 * (`TextureSlotSet.height`). Only reads in the graph itself count (a texture
 * handed into a material function is the function's business).
 */
export function heightAlphaParams(graph: GraphData, functions?: readonly GraphDocument[]): ReadonlySet<string> {
  const d = graphDeclaration(graph, functions);
  if (!d.alphaIsHeight || d.alphaIsOpacity || d.writesDecal) return new Set();
  const root = frameOf(graph, null, 0);
  const keys = new Set(graph.nodes.filter((n) => n.type === 'parameter').map((n) => String(n.data?.['key'] ?? '')));
  const out = new Set<string>();
  const blends = liveNodes(root, functions).filter((x) => x.frame === root && x.node.type === 'heightBlend');
  for (const key of keys) {
    const fromKey: Source = (n, port) => {
      if (!isAlpha(n, port)) return false;
      const tex = graph.edges.find((e) => e.to.node === n.id && e.to.port === 'tex');
      const p = tex === undefined ? undefined : root.byId.get(tex.from.node);
      return p?.type === 'parameter' && String(p.data?.['key'] ?? '') === key;
    };
    if (blends.some(({ node }) => reaches(root, node, 'heights', fromKey, false, functions, new Set()))) out.add(key);
  }
  return out;
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
  const d: Record<MaterialDeclarationKey, boolean> = none();
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
  if (m.graph === undefined) return shaderDeclaration(m);
  // A layered material naming trim sheets reads their rows.
  const d = graphDeclaration(m.graph, context.functions);
  return (m.layerSheets ?? []).some((id) => id !== '') ? { ...d, trimRows: true } : d;
}

/** Whether a material reads (or writes) one of its declarations — the check editors make before they paint or place. */
export function materialReads(material: MaterialDef, input: MaterialDeclarationKey, context: MaterialReadsContext = {}): boolean {
  return materialDeclaration(material, context)[input];
}
