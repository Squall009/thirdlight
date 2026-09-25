/**
 * Phase 19.0/19.1: the visual-script compiler front end (graph → TypeScript).
 *
 * A behavior graph (project-model `BEHAVIOR_GRAPH_KIND`) with its functions
 * and the shared functions it calls is turned into one TypeScript file,
 * `src/index.ts`, in an ordinary source-graph container; that container goes
 * through the one behavior compiler (`compileBehavior`) like any
 * hand-written source — the same limits, output scan, engine pins, trust
 * gate and publication. The file declares its properties in code
 * (`export const properties`), derived from the graph's variables, so the
 * published declaration always matches the graph (15.4's "code wins"), and
 * its `ownedTransforms` are the objects its Move/Pose nodes move (`@self`
 * for "this object").
 *
 * Execution model of the generated module:
 * - events run in their phase (intent, or transform for scripts that move
 *   objects), in a fixed order each step: the On start nodes (on the first
 *   step of a run in that phase), then every other event and pending Delay
 *   by node id; an event that fires several times in a step (one per trigger
 *   event, message, overlapping entity) runs once per firing, in the order
 *   the runtime reports them;
 * - every firing gets a frame: the outputs of the exec nodes it ran and its
 *   local variables; per-object variables (public/private) live in the
 *   instance state; data nodes are evaluated where they are read;
 * - a function call runs the function's flow with a new frame (its Input
 *   values, its local variables) and returns its Output values;
 * - no clock, no ambient randomness (Random nodes draw from a per-object
 *   seeded sequence that restarts with every run), loops bounded by
 *   `loopIterationsPerStep` per instance and step, lists and maps bounded —
 *   beyond a bound: a script error naming the node.
 *
 * Node ids reach errors in two ways:
 * - compile time: `lineNodes[i]` is the node whose code is on line i + 1, so
 *   a compiler diagnostic with a line maps to a node (`nodeId`);
 * - run time: the generated code keeps the id of the node it is executing
 *   (`r.n`) and tags any error thrown from it with `nodeId`; the runtime's
 *   behavior host copies that id into the script error. A node inside a
 *   function is named `fn:<functionId>/<nodeId>` (`lib:<graphId>/<nodeId>`
 *   for a shared function).
 *
 * Pure: no I/O; identical inputs give byte-identical containers.
 */
import {
  BEHAVIOR_GRAPH_LIMITS,
  axesOptions,
  behaviorApiSpec,
  behaviorFunctionInterface,
  behaviorGraphDeclaration,
  behaviorNodePhases,
  behaviorOwnedTransforms,
  behaviorScriptGraphs,
  calleeScope,
  checkBehaviorGraph,
  enumOptions,
  eventPhase,
  nodeDef,
  parseVariableValue,
  portCompatibility,
  resolveGraphPorts,
  scopedNodeId,
  validateGraphData,
  variableNodesOf,
  variableTypeOf,
  variableVisibility,
  type BehaviorApiArg,
  type BehaviorApiNodeSpec,
  type BehaviorApiValue,
  type BehaviorGraphProblem,
  type BehaviorScriptEnv,
  type BehaviorScriptGraph,
  type BehaviorVariableKind,
  type DeclaredProperty,
  type GraphData,
  type GraphNode,
  type GraphNodeDef,
  type GraphPortDef,
  type GraphValue,
  type ModelErrorV2,
  type PropertyDeclaration,
} from '@thirdlight/project-model';

import { canonicalContainerText } from './container';
import { utf8Encode } from './canonical';
import { ENTRY_PATH } from './limits';
import type { BehaviorCompileFailure, BehaviorCompileInput, BehaviorCompileResult, BehaviorCompiler, CompileDiagnostic, SourceGraphContainer } from './types';

import { GRAPH_SOURCE_BANNER } from './graph-banner';

export { GRAPH_SOURCE_BANNER };

export type GraphSourceResult =
  | {
      ok: true;
      container: SourceGraphContainer;
      /** The canonical container bytes (what the trust acknowledgment and the digest cover). */
      containerBytes: Uint8Array;
      /** The declaration the graph's variables make (what the compiler will derive from the code). */
      declaration: PropertyDeclaration;
      /** The node each line of `src/index.ts` belongs to (null: shared code). */
      lineNodes: (string | null)[];
      /** Warnings (never block a compile). */
      problems: BehaviorGraphProblem[];
    }
  | { ok: false; problems: BehaviorGraphProblem[] };

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** The name prefix of the timers Delay nodes use (a script's own timers should not start with it). */
export const DELAY_TIMER_PREFIX = 'vs.delay.';

/**
 * A literal as TypeScript text. Strings are written with only the escapes
 * the code-declaration reader accepts (\\, \", \uXXXX for control and
 * line-separator characters), so the same text is valid TypeScript and a
 * readable code declaration.
 */
function lit(v: unknown): string {
  if (typeof v === 'string') {
    let out = '"';
    const chars = [...v];
    chars.forEach((ch, i) => {
      const code = ch.charCodeAt(0);
      // The compiler's import scan reads `from"` / `import"` and `import(` / `eval(` /
      // `require(` / `Function(` anywhere in the file: such text gets one escaped character.
      const scanned = (ch === '(' && /(?:import|eval|require|Function)\s*$/.test(chars.slice(0, i).join(''))) || (i === chars.length - 1 && /(?:from|import)$/.test(v));
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (scanned || code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else out += ch;
    });
    return `${out}"`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? '0' : String(v)) : '0';
  if (Array.isArray(v)) return `[${v.map((x) => lit(x)).join(', ')}]`;
  if (v === undefined) return 'undefined';
  return JSON.stringify(v);
}
const q = (s: string): string => lit(s);

/** The expression of a type's zero value (a fresh collection). */
function zero(type: string): string {
  switch (type) {
    case 'number':
      return '0';
    case 'boolean':
      return 'false';
    case 'string':
      return '""';
    case 'vector':
      return '[0, 0, 0]';
    case 'list':
      return '[]';
    case 'map':
      return 'new Map()';
    default:
      return 'undefined';
  }
}

class Emitter {
  readonly lines: string[] = [];
  readonly nodes: (string | null)[] = [];
  line(text: string, nodeId: string | null = null): void {
    this.lines.push(text);
    this.nodes.push(nodeId);
  }
}

class CompileError extends Error {
  constructor(readonly problem: BehaviorGraphProblem) {
    super(problem.message);
  }
}

/** The shared helpers of every generated module (pure, deterministic). */
const RUNTIME_HELPERS = `const CAP = ${BEHAVIOR_GRAPH_LIMITS.loopIterationsPerStep};
const LCAP = ${BEHAVIOR_GRAPH_LIMITS.listItems};
const MCAP = ${BEHAVIOR_GRAPH_LIMITS.mapEntries};
const D2R = Math.PI / 180;
type R = { n: string };
type F = { o: Record<string, any>; a: any[]; v: Record<string, any> };
type S = { st: Record<string, boolean>; k: number; it: number; v: Record<string, any>; g: Record<string, any>; d: Record<string, F | undefined>; rng: number };
function fail(id: string, message: string, detail: string): never {
  throw Object.assign(new Error(message), { nodeId: id, detail });
}
function tag(e: unknown, id: string): unknown {
  if (id === '') return e;
  if (e instanceof Error) {
    if ((e as any).nodeId === undefined) (e as any).nodeId = id;
    return e;
  }
  return Object.assign(new Error(String(e)), { nodeId: id });
}
function loop(s: S, id: string, what: string): void {
  if (++s.it > CAP) fail(id, "the " + what + " loop ran more than " + CAP + " iterations in one step", "iteration_cap");
}
function div(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}
function mod(a: number, b: number): number {
  return b === 0 ? 0 : ((a % b) + b) % b;
}
function fin(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
function rnd0(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}
function num(t: string): number {
  const v = t.trim() === "" ? 0 : Number(t);
  return Number.isFinite(v) ? v : 0;
}
function vs(v: number[]): string {
  return v[0] + ", " + v[1] + ", " + v[2];
}
function cv(x: any, t: string): any {
  if (t === "number") return typeof x === "number" ? fin(x) : typeof x === "boolean" ? (x ? 1 : 0) : typeof x === "string" ? num(x) : 0;
  if (t === "boolean") return x === true || (typeof x === "number" && x !== 0) || x === "true";
  if (t === "string") return typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x) : Array.isArray(x) && x.length === 3 ? vs(cv(x, "vector")) : "";
  if (t === "vector") {
    if (Array.isArray(x)) return [fin(Number(x[0]) || 0), fin(Number(x[1]) || 0), fin(Number(x[2]) || 0)];
    if (x !== null && typeof x === "object" && !(x instanceof Map)) return [fin(Number(x.x) || 0), fin(Number(x.y) || 0), fin(Number(x.z) || 0)];
    return typeof x === "number" && Number.isFinite(x) ? [x, x, x] : [0, 0, 0];
  }
  if (t === "list") return Array.isArray(x) ? x : [];
  if (t === "map") return x instanceof Map ? x : x !== null && typeof x === "object" && !Array.isArray(x) ? new Map(Object.entries(x)) : new Map();
  return x;
}
function plain(x: any): any {
  if (x instanceof Map) {
    const o: Record<string, any> = {};
    for (const [k, v] of x) o[k] = plain(v);
    return o;
  }
  return Array.isArray(x) ? x.map(plain) : x;
}
function pick(x: any, path: string[]): any {
  for (const k of path) x = x === null || x === undefined ? undefined : x[k];
  return x;
}
function selfId(c: any, id: any): any {
  return id === "" || id === null || id === undefined ? c.entityId : id;
}
function split(t: string): string[] {
  return t.split(",").map((x) => x.trim()).filter((x) => x !== "");
}
function eq(a: any, b: any): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  return a === b;
}
function vadd(a: number[], b: number[]): number[] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function vsub(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function vscale(a: number[], k: number): number[] {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function vdot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function vlen(a: number[]): number {
  return Math.sqrt(vdot(a, a));
}
function vnorm(a: number[]): number[] {
  const l = vlen(a);
  return l === 0 ? [0, 0, 0] : vscale(a, 1 / l);
}
function vcross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function lcap(id: string, l: any[]): any[] {
  if (l.length > LCAP) fail(id, "a list holds at most " + LCAP + " items", "list_cap");
  return l;
}
function lidx(l: any[], v: any): number {
  for (let i = 0; i < l.length; i++) if (eq(l[i], v)) return i;
  return -1;
}
function lget(l: any[], i: number, t: string): { item: any; found: boolean } {
  const k = Math.trunc(i);
  return k >= 0 && k < l.length ? { item: cv(l[k], t), found: true } : { item: cv(undefined, t), found: false };
}
function lset(l: any[], i: number, v: any): any[] {
  const k = Math.trunc(i);
  if (k < 0 || k >= l.length) return l;
  const o = l.slice();
  o[k] = v;
  return o;
}
function lrem(l: any[], i: number): any[] {
  const k = Math.trunc(i);
  if (k < 0 || k >= l.length) return l;
  const o = l.slice();
  o.splice(k, 1);
  return o;
}
function mset(id: string, m: Map<string, any>, k: string, v: any): Map<string, any> {
  const o = new Map(m);
  o.set(k, v);
  if (o.size > MCAP) fail(id, "a map holds at most " + MCAP + " entries", "map_cap");
  return o;
}
function mdel(m: Map<string, any>, k: string): Map<string, any> {
  if (!m.has(k)) return m;
  const o = new Map(m);
  o.delete(k);
  return o;
}
function seed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h | 0;
}
function rnd(s: S): number {
  let t = (s.rng = (s.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rint(s: S, a: number, b: number): number {
  const lo = Math.ceil(Math.min(a, b));
  const hi = Math.floor(Math.max(a, b));
  return hi < lo ? lo : lo + Math.floor(rnd(s) * (hi - lo + 1));
}`;

/** The code of one graph (the script, a function or a shared function). */
class GraphCode {
  readonly nodes: GraphNode[];
  readonly byId: Map<string, GraphNode>;
  readonly index: Map<string, number>;
  readonly ports: ReturnType<typeof resolveGraphPorts>;
  readonly incoming = new Map<string, { node: string; port: string }>();
  readonly outgoing = new Map<string, { node: string; port: string }[]>();
  readonly wired = new Set<string>();
  /** Variables of this graph stored in the frame (locals) vs. the instance state. */
  readonly locals = new Map<string, BehaviorVariableKind>();
  readonly declared = new Map<string, GraphNode>();
  readonly inputIndex = new Map<string, number>();
  readonly outputs: { id: string; type: string }[] = [];

  constructor(
    readonly gen: ScriptCode,
    readonly sg: BehaviorScriptGraph,
    readonly prefix: string,
  ) {
    this.nodes = [...sg.graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.index = new Map(this.nodes.map((n, i) => [n.id, i]));
    this.ports = resolveGraphPorts(sg.kind, sg.graph, sg.ctx);
    for (const e of sg.graph.edges) {
      this.incoming.set(`${e.to.node}\u0000${e.to.port}`, e.from);
      this.wired.add(`${e.to.node}\u0000${e.to.port}`);
      const k = `${e.from.node}\u0000${e.from.port}`;
      const l = this.outgoing.get(k) ?? [];
      l.push(e.to);
      this.outgoing.set(k, l);
    }
    const inFunction = sg.scope !== '';
    for (const n of variableNodesOf(sg.graph)) {
      const name = String(this.field(n, 'name', ''));
      if (name === '' || this.declared.has(name)) continue;
      this.declared.set(name, n);
      if (variableVisibility(n, inFunction) === 'local') this.locals.set(name, variableTypeOf(n.type)!);
    }
    if (inFunction) {
      const itf = behaviorFunctionInterface(sg);
      itf.inputs.forEach((p, i) => this.inputIndex.set(p.id, i));
      for (const p of itf.outputs) this.outputs.push({ id: p.id, type: p.type });
    }
  }

  def(n: GraphNode): GraphNodeDef {
    return nodeDef(this.sg.kind, n.type)!;
  }
  field(n: GraphNode, key: string, fallback: GraphValue): GraphValue {
    const v = n.data?.[key];
    if (v !== undefined) return v;
    const f = nodeDef(this.sg.kind, n.type)?.fields?.find((x) => x.key === key);
    return f !== undefined ? f.default : fallback;
  }
  str(n: GraphNode, key: string): string {
    return String(this.field(n, key, ''));
  }
  sid(n: GraphNode | string): string {
    return scopedNodeId(this.sg.scope, typeof n === 'string' ? n : n.id);
  }
  portsOf(n: GraphNode): { inputs: readonly GraphPortDef[]; outputs: readonly GraphPortDef[] } {
    return this.ports.get(n.id) ?? { inputs: [], outputs: [] };
  }
  isEvent(n: GraphNode): boolean {
    return n.type.startsWith('event.');
  }
  isExec(n: GraphNode): boolean {
    return this.def(n).inputs.some((p) => p.type === 'exec');
  }
  /** The base function name of a node. */
  name(n: GraphNode): string {
    return `${this.prefix}${this.isEvent(n) ? 'e' : this.isExec(n) ? 'x' : 'p'}${this.index.get(n.id)}`;
  }
  /** The function that runs a node from one of its exec inputs. */
  execName(n: GraphNode, port: string): string {
    return port === 'in' ? this.name(n) : `${this.name(n)}_${port}`;
  }
  /** Where a variable lives: this frame (a local) or the instance state. */
  varRef(name: string): string {
    return `${this.locals.has(name) ? 'f' : 's'}.v[${q(name)}]`;
  }
  varKind(name: string): BehaviorVariableKind | null {
    const n = this.declared.get(name) ?? this.gen.scriptCode?.declared.get(name);
    return n !== undefined ? variableTypeOf(n.type) : null;
  }
  varDecl(name: string): GraphNode | undefined {
    return this.declared.get(name) ?? this.gen.scriptCode?.declared.get(name);
  }
  fail(n: GraphNode, message: string): never {
    throw new CompileError({ severity: 'error', nodeId: this.sid(n), message });
  }

  /** The expression that reads an output port's value. */
  readOutput(src: GraphNode, port: GraphPortDef): string {
    if (src.type === 'fn.input') return `f.a[${this.inputIndex.get(src.id) ?? 0}]`;
    if (this.isEvent(src) || this.isExec(src) || src.type === 'fn.entry') return `(f.o[${q(`${src.id}.${port.id}`)}] ?? ${zero(port.type)})`;
    const outs = this.portsOf(src).outputs;
    return outs.length === 1 ? `${this.name(src)}(s, c, r, f)` : `${this.name(src)}(s, c, r, f)[${q(port.id)}]`;
  }

  /** The value an input port reads: its wire (converted) or the node's inline value. */
  readInput(n: GraphNode, port: GraphPortDef): string {
    const from = this.incoming.get(`${n.id}\u0000${port.id}`);
    if (from === undefined) return this.inline(n, port);
    const src = this.byId.get(from.node)!;
    const out = this.portsOf(src).outputs.find((p) => p.id === from.port)!;
    const expr = this.readOutput(src, out);
    if (out.type === port.type) return expr;
    if (portCompatibility(this.sg.kind, out.type, port.type) === null) return expr; // refused by the structural check
    if (port.type === 'string') return out.type === 'vector' ? `vs(${expr})` : `String(${expr})`;
    if (out.type === 'boolean' && port.type === 'number') return `(${expr} ? 1 : 0)`;
    if (out.type === 'number' && port.type === 'vector') return `cv(${expr}, "vector")`;
    return expr;
  }

  /** An unwired input's value: the node's field of the same key read as the port's type. */
  inline(n: GraphNode, port: GraphPortDef): string {
    const t = port.type;
    if (n.type === 'var.set' && port.id === 'value') {
      const decl = this.varDecl(this.str(n, 'variable'));
      const k = decl !== undefined ? variableTypeOf(decl.type)! : 'string';
      const parsed = parseVariableValue(k, this.str(n, 'value'), decl !== undefined ? enumOptions(decl) : []);
      if (k === 'list' || k === 'map') return zero(k);
      return lit(parsed.ok ? parsed.value : null);
    }
    if (n.type === 'flow.switch' && port.id === 'value') return t === 'number' ? lit(Number(this.str(n, 'value')) || 0) : q(this.str(n, 'value'));
    const spec = behaviorApiSpec(n.type);
    const arg = spec?.args.find((a) => a.id === port.id);
    if (arg?.type === 'typed') {
      if (t === 'list' || t === 'map') return zero(t);
      const parsed = parseVariableValue(t === 'vector' ? 'vector' : t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string', this.str(n, arg.id));
      return lit(parsed.ok ? parsed.value : null);
    }
    const f = this.def(n).fields?.find((x) => x.key === port.id);
    if (f === undefined || t === 'list' || t === 'map') return zero(t);
    return lit(this.field(n, port.id, f.default));
  }

  /** Calls of the exec nodes an exec output leads to (one wire, or none). */
  follow(n: GraphNode, portId: string, indent: string, em: Emitter, frame = 'f'): void {
    for (const to of this.outgoing.get(`${n.id}\u0000${portId}`) ?? []) em.line(`${indent}${this.execName(this.byId.get(to.node)!, to.port)}(s, c, r, ${frame});`, this.sid(n));
  }

  /** The frame constructor of this graph (its local variables at their defaults). */
  emitFrame(em: Emitter): void {
    em.line('');
    em.line(`function ${this.prefix}L(a: any[]): F {`);
    const vars: string[] = [];
    for (const [name] of this.locals) vars.push(`${q(name)}: ${this.localDefault(this.declared.get(name)!)}`);
    em.line(`  return { o: {}, a, v: { ${vars.join(', ')} } };`);
    em.line('}');
  }
  localDefault(n: GraphNode): string {
    const k = variableTypeOf(n.type)!;
    if (k === 'list' || k === 'map') return zero(k);
    if (k === 'enum') {
      const d = this.str(n, 'default');
      return q(d === '' ? (enumOptions(n)[0] ?? '') : d);
    }
    return lit(this.field(n, 'default', k === 'number' ? 0 : k === 'boolean' ? false : k === 'vector' ? [0, 0, 0] : ''));
  }

  /** Every node function of this graph. */
  emitNodes(em: Emitter): void {
    for (const n of this.nodes) {
      if (variableTypeOf(n.type) !== null || n.type === 'fn.input' || n.type === 'fn.output' || n.type === 'fn.entry') continue;
      if (this.isEvent(n)) this.emitEvent(n, em);
      else if (this.isExec(n)) this.emitExec(n, em);
      else this.emitData(n, em);
    }
  }

  /** The argument locals of a node (`const aN = …`), inputs in order. */
  args(n: GraphNode, em: Emitter, indent = '  '): Map<string, string> {
    const out = new Map<string, string>();
    this.portsOf(n)
      .inputs.filter((p) => p.type !== 'exec')
      .forEach((p, i) => {
        em.line(`${indent}const a${i} = ${this.readInput(n, p)};`, this.sid(n));
        out.set(p.id, `a${i}`);
      });
    return out;
  }

  emitData(n: GraphNode, em: Emitter): void {
    const id = q(this.sid(n));
    em.line('');
    em.line(`function ${this.name(n)}(s: S, c: any, r: R, f: F): any {`, this.sid(n));
    const a = this.args(n, em);
    const A = (k: string): string => a.get(k)!;
    em.line(`  r.n = ${id};`, this.sid(n));
    const outType = (pid: string): string => this.portsOf(n).outputs.find((p) => p.id === pid)?.type ?? 'number';
    let expr: string | null = null;
    switch (n.type) {
      case 'var.get':
        expr = this.varRef(this.str(n, 'variable'));
        break;
      case 'const.number':
      case 'const.boolean':
      case 'const.text':
      case 'const.vector':
        expr = lit(this.field(n, 'value', 0));
        break;
      case 'math.add':
        expr = `${A('a')} + ${A('b')}`;
        break;
      case 'math.subtract':
        expr = `${A('a')} - ${A('b')}`;
        break;
      case 'math.multiply':
        expr = `${A('a')} * ${A('b')}`;
        break;
      case 'math.divide':
        expr = `div(${A('a')}, ${A('b')})`;
        break;
      case 'math.modulo':
        expr = `mod(${A('a')}, ${A('b')})`;
        break;
      case 'math.power':
        expr = `fin(Math.pow(${A('a')}, ${A('b')}))`;
        break;
      case 'math.min':
        expr = `Math.min(${A('a')}, ${A('b')})`;
        break;
      case 'math.max':
        expr = `Math.max(${A('a')}, ${A('b')})`;
        break;
      case 'math.abs':
        expr = `Math.abs(${A('value')})`;
        break;
      case 'math.negate':
        expr = `0 - ${A('value')}`;
        break;
      case 'math.floor':
        expr = `Math.floor(${A('value')})`;
        break;
      case 'math.ceil':
        expr = `Math.ceil(${A('value')})`;
        break;
      case 'math.round':
        expr = `rnd0(${A('value')})`;
        break;
      case 'math.sign':
        expr = `Math.sign(${A('value')})`;
        break;
      case 'math.sqrt':
        expr = `${A('value')} > 0 ? Math.sqrt(${A('value')}) : 0`;
        break;
      case 'math.clamp':
        expr = `Math.min(Math.max(${A('value')}, ${A('min')}), ${A('max')})`;
        break;
      case 'math.lerp':
        expr = `${A('a')} + (${A('b')} - ${A('a')}) * ${A('t')}`;
        break;
      case 'math.sin':
        expr = `Math.sin(${A('degrees')} * D2R)`;
        break;
      case 'math.cos':
        expr = `Math.cos(${A('degrees')} * D2R)`;
        break;
      case 'math.atan2':
        expr = `Math.atan2(${A('y')}, ${A('x')}) / D2R`;
        break;
      case 'math.compare': {
        const ops: Record<string, string> = { '==': '===', '!=': '!==', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
        expr = `${A('a')} ${ops[this.str(n, 'op')] ?? '==='} ${A('b')}`;
        break;
      }
      case 'logic.and':
        expr = `${A('a')} && ${A('b')}`;
        break;
      case 'logic.or':
        expr = `${A('a')} || ${A('b')}`;
        break;
      case 'logic.xor':
        expr = `${A('a')} !== ${A('b')}`;
        break;
      case 'logic.not':
        expr = `!${A('value')}`;
        break;
      case 'text.join':
        expr = `${A('a')} + ${A('b')}`;
        break;
      case 'text.equal':
        expr = `${A('a')} === ${A('b')}`;
        break;
      case 'text.contains':
        expr = `${A('text')}.includes(${A('part')})`;
        break;
      case 'text.length':
        expr = `${A('text')}.length`;
        break;
      case 'text.number':
        expr = `num(${A('text')})`;
        break;
      case 'vec.make':
        expr = `[${A('x')}, ${A('y')}, ${A('z')}]`;
        break;
      case 'vec.break':
        expr = `{ x: ${A('vector')}[0], y: ${A('vector')}[1], z: ${A('vector')}[2] }`;
        break;
      case 'vec.add':
        expr = `vadd(${A('a')}, ${A('b')})`;
        break;
      case 'vec.subtract':
        expr = `vsub(${A('a')}, ${A('b')})`;
        break;
      case 'vec.scale':
        expr = `vscale(${A('vector')}, ${A('factor')})`;
        break;
      case 'vec.length':
        expr = `vlen(${A('vector')})`;
        break;
      case 'vec.distance':
        expr = `vlen(vsub(${A('a')}, ${A('b')}))`;
        break;
      case 'vec.normalize':
        expr = `vnorm(${A('vector')})`;
        break;
      case 'vec.dot':
        expr = `vdot(${A('a')}, ${A('b')})`;
        break;
      case 'vec.cross':
        expr = `vcross(${A('a')}, ${A('b')})`;
        break;
      case 'vec.lerp':
        expr = `vadd(${A('a')}, vscale(vsub(${A('b')}, ${A('a')}), ${A('t')}))`;
        break;
      case 'flow.select':
        expr = `${A('condition')} ? ${A('a')} : ${A('b')}`;
        break;
      case 'list.make': {
        const count = Math.max(0, Math.min(4, Math.trunc(Number(this.field(n, 'count', 0))) || 0));
        expr = `[${['item1', 'item2', 'item3', 'item4'].slice(0, count).map(A).join(', ')}]`;
        break;
      }
      case 'list.length':
        expr = `${A('list')}.length`;
        break;
      case 'list.get':
        expr = `lget(${A('list')}, ${A('index')}, ${q(outType('item'))})`;
        break;
      case 'list.set':
        expr = `lset(${A('list')}, ${A('index')}, ${A('item')})`;
        break;
      case 'list.add':
        expr = `lcap(${id}, [...${A('list')}, ${A('item')}])`;
        break;
      case 'list.remove':
        expr = `lrem(${A('list')}, ${A('index')})`;
        break;
      case 'list.contains':
        expr = `lidx(${A('list')}, ${A('item')}) >= 0`;
        break;
      case 'list.indexOf':
        expr = `lidx(${A('list')}, ${A('item')})`;
        break;
      case 'map.make':
        expr = 'new Map()';
        break;
      case 'map.set':
        expr = `mset(${id}, ${A('map')}, ${A('key')}, ${A('value')})`;
        break;
      case 'map.get':
        expr = `{ value: cv(${A('map')}.get(${A('key')}), ${q(outType('value'))}), found: ${A('map')}.has(${A('key')}) }`;
        break;
      case 'map.has':
        expr = `${A('map')}.has(${A('key')})`;
        break;
      case 'map.remove':
        expr = `mdel(${A('map')}, ${A('key')})`;
        break;
      case 'map.size':
        expr = `${A('map')}.size`;
        break;
      case 'map.keys':
        expr = `[...${A('map')}.keys()]`;
        break;
      case 'random.number':
        expr = `${A('min')} + (${A('max')} - ${A('min')}) * rnd(s)`;
        break;
      case 'random.integer':
        expr = `rint(s, ${A('min')}, ${A('max')})`;
        break;
      case 'random.chance':
        expr = `rnd(s) < ${A('probability')}`;
        break;
      default: {
        const spec = behaviorApiSpec(n.type);
        if (spec !== undefined && !spec.exec) {
          em.line(`  const res = ${this.apiCall(n, spec, a)};`, this.sid(n));
          expr = this.apiResult(n, spec, 'res');
        }
      }
    }
    if (expr === null) this.fail(n, `the compiler has no code for "${n.type}"`);
    em.line(`  return ${expr};`, this.sid(n));
    em.line('}', this.sid(n));
  }

  /** An API node's call expression (`c.game?.add(a0, a1)`). */
  apiCall(n: GraphNode, spec: BehaviorApiNodeSpec, a: Map<string, string>): string {
    const argOf = new Map(spec.args.map((x) => [x.id, x]));
    const value = (v: BehaviorApiValue): string | undefined => {
      if ('const' in v) return lit(v.const);
      if ('rest' in v) return `...split(${a.get(v.rest) ?? '""'})`;
      if ('object' in v) {
        const parts: string[] = [];
        for (const [k, inner] of v.object) {
          if (!IDENT_RE.test(k)) this.fail(n, `internal: "${k}" is not a member name`);
          const e = value(inner);
          if (e !== undefined) parts.push(`${k}: ${e}`);
        }
        return `{ ${parts.join(', ')} }`;
      }
      const arg = argOf.get(v.arg);
      if (arg === undefined) this.fail(n, `internal: no argument "${v.arg}"`);
      return this.argValue(n, arg, a.get(arg.id), v.as);
    };
    let expr = 'c';
    let opt = false;
    for (const step of spec.access) {
      if ('prop' in step) {
        if (!IDENT_RE.test(step.prop)) this.fail(n, `internal: "${step.prop}" is not a member name`);
        expr += `${opt ? '?.' : '.'}${step.prop}`;
        opt = step.optional === true;
      } else {
        const list = step.call.map((v) => value(v));
        // Trailing arguments that are not given are left out.
        while (list.length > 0 && list[list.length - 1] === undefined) list.pop();
        expr += `${opt ? '?.' : ''}(${list.map((x) => x ?? 'undefined').join(', ')})`;
        opt = step.nullable === true;
      }
    }
    return expr;
  }

  /** One argument's value expression, or undefined when it is not given. */
  argValue(n: GraphNode, arg: BehaviorApiArg, local: string | undefined, as?: 'vec2' | 'axes'): string | undefined {
    const wired = this.wired.has(`${n.id}\u0000${arg.id}`);
    if (arg.options !== undefined) return q(this.str(n, arg.id));
    if (!wired) {
      if (arg.default === undefined) return undefined;
      if (arg.omitEmpty === true && this.str(n, arg.id) === '') return undefined;
    }
    if (local === undefined) return undefined;
    if (arg.self === true) return `selfId(c, ${local})`;
    if (arg.type === 'typed') {
      const t = this.portsOf(n).inputs.find((p) => p.id === arg.id)?.type ?? 'number';
      return t === 'list' || t === 'map' ? `plain(${local})` : local;
    }
    if (as === 'vec2') return `{ x: ${local}[0], y: ${local}[1] }`;
    if (as === 'axes' || arg.axes !== undefined) {
      const keys = (arg.axes ?? []).filter((k) => k !== 'none');
      const opts = axesOptions(arg.axes ?? []);
      const chosen = String(this.field(n, `${arg.id}_axes`, opts[0] ?? ''));
      if (chosen === 'none') return undefined;
      const picked = chosen.split(' ').filter((k) => keys.includes(k));
      return `{ ${picked.map((k) => `${k}: ${local}[${keys.indexOf(k)}]`).join(', ')} }`;
    }
    return local;
  }

  /** The outputs of an API call's result `res` (a value, or a record of the outputs). */
  apiResult(n: GraphNode, spec: BehaviorApiNodeSpec, res: string): string {
    const ports = this.portsOf(n).outputs;
    const one = (o: BehaviorApiNodeSpec['outputs'][number]): string => {
      if (o.found === true) return `(${res} !== null && ${res} !== undefined)`;
      const t = ports.find((p) => p.id === o.id)?.type ?? 'number';
      return `cv(${o.path.length === 0 ? res : `pick(${res}, ${lit(o.path)})`}, ${q(t)})`;
    };
    if (spec.outputs.length === 1) return one(spec.outputs[0]!);
    return `{ ${spec.outputs.map((o) => `${o.id}: ${one(o)}`).join(', ')} }`;
  }

  emitExec(n: GraphNode, em: Emitter): void {
    const d = this.def(n);
    const sid = this.sid(n);
    const id = q(sid);
    const execIns = d.inputs.filter((p) => p.type === 'exec');
    const open = (port: string): Map<string, string> => {
      em.line('');
      em.line(`function ${this.execName(n, port)}(s: S, c: any, r: R, f: F): void {`, sid);
      const a = port === 'in' || execIns.length === 1 ? this.args(n, em) : new Map<string, string>();
      em.line(`  r.n = ${id};`, sid);
      return a;
    };
    const close = (): void => em.line('}', sid);
    const store = (port: string, value: string, indent = '  '): void => em.line(`${indent}f.o[${q(`${n.id}.${port}`)}] = ${value};`, sid);
    const g = `s.g[${id}]`;
    switch (n.type) {
      case 'flow.branch': {
        const a = open('in');
        em.line(`  if (${a.get('condition')}) {`, sid);
        this.follow(n, 'true', '    ', em);
        em.line('  } else {', sid);
        this.follow(n, 'false', '    ', em);
        em.line('  }', sid);
        close();
        return;
      }
      case 'flow.sequence':
        open('in');
        for (const p of d.outputs) this.follow(n, p.id, '  ', em);
        close();
        return;
      case 'flow.for': {
        const a = open('in');
        em.line(`  const last = Math.trunc(${a.get('last')});`, sid);
        em.line(`  for (let i = Math.trunc(${a.get('first')}); i <= last; i++) {`, sid);
        em.line(`    r.n = ${id};`, sid);
        em.line(`    loop(s, ${id}, "For");`, sid);
        store('index', 'i', '    ');
        this.follow(n, 'body', '    ', em);
        em.line('  }', sid);
        em.line(`  r.n = ${id};`, sid);
        this.follow(n, 'completed', '  ', em);
        close();
        return;
      }
      case 'flow.foreach': {
        const a = open('in');
        const of = this.portsOf(n).outputs.find((p) => p.id === 'item')?.type ?? 'number';
        em.line(`  const list = ${a.get('list')};`, sid);
        em.line('  for (let i = 0; i < list.length; i++) {', sid);
        em.line(`    r.n = ${id};`, sid);
        em.line(`    loop(s, ${id}, "For each");`, sid);
        store('item', `cv(list[i], ${q(of)})`, '    ');
        store('index', 'i', '    ');
        this.follow(n, 'body', '    ', em);
        em.line('  }', sid);
        em.line(`  r.n = ${id};`, sid);
        this.follow(n, 'completed', '  ', em);
        close();
        return;
      }
      case 'flow.while': {
        open('in');
        const cond = this.portsOf(n).inputs.find((p) => p.id === 'condition')!;
        em.line(`  while (${this.readInput(n, cond)}) {`, sid);
        em.line(`    r.n = ${id};`, sid);
        em.line(`    loop(s, ${id}, "While");`, sid);
        this.follow(n, 'body', '    ', em);
        em.line('  }', sid);
        em.line(`  r.n = ${id};`, sid);
        this.follow(n, 'completed', '  ', em);
        close();
        return;
      }
      case 'flow.gate': {
        const start = this.field(n, 'open', true) === true;
        open('in');
        em.line(`  if (${g} ?? ${start}) {`, sid);
        this.follow(n, 'then', '    ', em);
        em.line('  }', sid);
        close();
        open('open');
        em.line(`  ${g} = true;`, sid);
        close();
        open('close');
        em.line(`  ${g} = false;`, sid);
        close();
        open('toggle');
        em.line(`  ${g} = !(${g} ?? ${start});`, sid);
        close();
        return;
      }
      case 'flow.doonce':
        open('in');
        em.line(`  if (${g} !== true) {`, sid);
        em.line(`    ${g} = true;`, sid);
        this.follow(n, 'then', '    ', em);
        em.line('  }', sid);
        close();
        open('reset');
        em.line(`  ${g} = false;`, sid);
        close();
        return;
      case 'flow.delay': {
        const a = open('in');
        em.line(`  if (s.d[${id}] === undefined) {`, sid);
        em.line(`    s.d[${id}] = f;`, sid);
        em.line(`    c.timers.after(${q(this.gen.delayTimer(n))}, Math.max(0, ${a.get('seconds')}));`, sid);
        em.line('  }', sid);
        close();
        return;
      }
      case 'flow.switch': {
        const a = open('in');
        const int = this.field(n, 'on', 'text') === 'int';
        em.line(`  const v = ${int ? `Math.trunc(${a.get('value')})` : a.get('value')};`, sid);
        let first = true;
        for (let i = 1; i <= BEHAVIOR_GRAPH_LIMITS.switchCases; i++) {
          const c = this.str(n, `case${i}`).trim();
          if (c === '') continue;
          em.line(`  ${first ? 'if' : '} else if'} (v === ${int ? lit(Math.trunc(Number(c)) || 0) : q(this.str(n, `case${i}`))}) {`, sid);
          this.follow(n, `case${i}`, '    ', em);
          first = false;
        }
        if (first) this.follow(n, 'default', '  ', em);
        else {
          em.line('  } else {', sid);
          this.follow(n, 'default', '    ', em);
          em.line('  }', sid);
        }
        close();
        return;
      }
      case 'var.set': {
        const a = open('in');
        em.line(`  ${this.varRef(this.str(n, 'variable'))} = ${a.get('value')};`, sid);
        store('value', a.get('value')!);
        this.follow(n, 'then', '  ', em);
        close();
        return;
      }
      case 'debug.log': {
        const a = open('in');
        em.line(`  c.log(${q(this.str(n, 'level'))}, String(${a.get('message')}));`, sid);
        this.follow(n, 'then', '  ', em);
        close();
        return;
      }
      case 'fn.call':
      case 'fn.library': {
        const a = open('in');
        const callee = calleeScope(n);
        const fn = callee !== null ? this.gen.functionName(callee) : null;
        if (fn === null) this.fail(n, 'the called function does not exist');
        const ins = this.portsOf(n).inputs.filter((p) => p.type !== 'exec');
        const outs = this.portsOf(n).outputs.filter((p) => p.type !== 'exec');
        em.line(`  const out = ${fn}(s, c, r, [${ins.map((p) => a.get(p.id)).join(', ')}]);`, sid);
        em.line(`  r.n = ${id};`, sid);
        outs.forEach((p, i) => store(p.id, `out[${i}]`));
        this.follow(n, 'then', '  ', em);
        close();
        return;
      }
      default: {
        const spec = behaviorApiSpec(n.type);
        if (spec === undefined || !spec.exec) this.fail(n, `the compiler has no code for "${n.type}"`);
        const a = open('in');
        const call = this.apiCall(n, spec, a);
        if (spec.outputs.length === 0) em.line(`  ${call};`, sid);
        else {
          em.line(`  const res = ${call};`, sid);
          const ports = this.portsOf(n).outputs;
          for (const o of spec.outputs) {
            const t = ports.find((p) => p.id === o.id)?.type ?? 'number';
            store(o.id, o.found === true ? '(res !== null && res !== undefined)' : `cv(${o.path.length === 0 ? 'res' : `pick(res, ${lit(o.path)})`}, ${q(t)})`);
          }
        }
        this.follow(n, 'then', '  ', em);
        close();
      }
    }
  }

  /** An event: a function run once per step in its phase; it fires zero or more times. */
  emitEvent(n: GraphNode, em: Emitter): void {
    const sid = this.sid(n);
    const id = q(sid);
    const L = `${this.prefix}L([])`;
    em.line('');
    em.line(`function ${this.name(n)}(s: S, c: any, r: R): void {`, sid);
    em.line(`  r.n = ${id};`, sid);
    const fire = (indent: string, outputs: [string, string][] = []): void => {
      em.line(`${indent}{`, sid);
      em.line(`${indent}  const f = ${L};`, sid);
      for (const [p, v] of outputs) em.line(`${indent}  f.o[${q(`${n.id}.${p}`)}] = ${v};`, sid);
      this.follow(n, 'then', `${indent}  `, em);
      em.line(`${indent}}`, sid);
    };
    const vec = (key: string): number[] => {
      const v = this.field(n, key, [0, 0, 0]);
      return Array.isArray(v) ? (v as number[]) : [0, 0, 0];
    };
    const when = this.str(n, 'when');
    switch (n.type) {
      case 'event.start':
        fire('  ');
        break;
      case 'event.step':
        fire('  ', [['step', 'c.stepIndex']]);
        break;
      case 'event.signal':
        em.line(`  if (c.signals?.on(${q(this.str(n, 'signal'))}) === true) {`, sid);
        fire('    ');
        em.line('  }', sid);
        break;
      case 'event.trigger': {
        const only = this.str(n, 'trigger');
        em.line('  for (const ev of (c.events ?? []) as any[]) {', sid);
        em.line(`    if (ev.type !== ${q(when)}${only !== '' ? ` || ev.trigger !== ${q(only)}` : ''}) continue;`, sid);
        fire('    ', [['trigger', 'ev.trigger']]);
        em.line('  }', sid);
        break;
      }
      case 'event.overlap': {
        const off = vec('offset');
        const size = vec('size');
        em.line('  const me = c.world.transform(c.entityId)?.position ?? [0, 0, 0];', sid);
        em.line(`  const at = { x: me[0] + ${lit(off[0])}, y: me[1] + ${lit(off[1])} };`, sid);
        em.line(
          this.str(n, 'shape') === 'circle'
            ? `  const found: string[] = (c.physics.overlapCircle?.(at, ${lit(size[0])}) ?? []).filter((e: string) => e !== c.entityId);`
            : `  const found: string[] = (c.physics.overlapBox?.(at, { x: ${lit(size[0])}, y: ${lit(size[1])} }) ?? []).filter((e: string) => e !== c.entityId);`,
          sid,
        );
        em.line(`  const before: string[] = s.g[${id}] ?? [];`, sid);
        em.line(`  s.g[${id}] = found;`, sid);
        em.line(`  for (const e of ${when === 'each' ? 'found' : when === 'exit' ? 'before.filter((x) => !found.includes(x))' : 'found.filter((x) => !before.includes(x))'}) {`, sid);
        fire('    ', [['entity', 'e']]);
        em.line('  }', sid);
        break;
      }
      case 'event.raycast': {
        const off = vec('offset');
        const dir = vec('direction');
        em.line('  const me = c.world.transform(c.entityId)?.position ?? [0, 0, 0];', sid);
        em.line(`  const hit = c.physics.raycast?.({ x: me[0] + ${lit(off[0])}, y: me[1] + ${lit(off[1])} }, { x: ${lit(dir[0])}, y: ${lit(dir[1])} }, ${lit(Number(this.field(n, 'distance', 10)))}) ?? null;`, sid);
        em.line('  const now = hit !== null ? String(hit.entityId) : "";', sid);
        em.line(`  const before: string = s.g[${id}] ?? "";`, sid);
        em.line(`  s.g[${id}] = now;`, sid);
        const hitOuts: [string, string][] = [
          ['entity', 'now'],
          ['distance', 'cv(hit?.distance, "number")'],
          ['normal', 'cv(hit?.normal, "vector")'],
        ];
        if (when === 'each') em.line('  if (hit !== null) {', sid);
        else if (when === 'exit') em.line('  if (before !== "" && now !== before) {', sid);
        else em.line('  if (now !== "" && now !== before) {', sid);
        fire('    ', when === 'exit' ? [['entity', 'before'], ['distance', '0'], ['normal', '[0, 0, 0]']] : hitOuts);
        em.line('  }', sid);
        break;
      }
      case 'event.input': {
        const action = q(this.str(n, 'action'));
        const test = when === 'released' ? 'released' : when === 'held' ? 'held' : 'pressed';
        em.line(`  if (c.input.${test}(${action})) {`, sid);
        fire('    ', [['value', `c.input.value(${action})`]]);
        em.line('  }', sid);
        break;
      }
      case 'event.animator': {
        const name = this.str(n, 'event');
        const entity = this.str(n, 'entity');
        em.line('  for (const ev of (c.events ?? []) as any[]) {', sid);
        em.line(`    if (ev.clip === undefined${name !== '' ? ` || ev.name !== ${q(name)}` : ''}${entity !== '' ? ` || ev.entityId !== ${q(entity)}` : ''}) continue;`, sid);
        fire('    ', [
          ['entity', 'ev.entityId'],
          ['name', 'ev.name'],
          ['clip', 'ev.clip'],
        ]);
        em.line('  }', sid);
        break;
      }
      case 'event.timer':
        em.line(`  if (c.timers.fired(${q(this.str(n, 'timer'))})) {`, sid);
        fire('    ');
        em.line('  }', sid);
        break;
      case 'event.message': {
        const t = this.portsOf(n).outputs.find((p) => p.id === 'value')?.type ?? 'number';
        em.line(`  for (const m of (c.messages?.received(${q(this.str(n, 'message'))}) ?? []) as any[]) {`, sid);
        fire('    ', [
          ['value', `cv(m.value, ${q(t)})`],
          ['from', 'String(m.from)'],
        ]);
        em.line('  }', sid);
        break;
      }
      default:
        this.fail(n, `the compiler has no code for "${n.type}"`);
    }
    em.line('}', sid);
  }

  /** A function graph as one TypeScript function: a new frame, the flow from its start, its outputs. */
  emitFunction(em: Emitter, fname: string): void {
    const entry = this.nodes.find((n) => n.type === 'fn.entry');
    em.line('');
    em.line(`function ${fname}(s: S, c: any, r: R, a: any[]): any[] {`);
    em.line(`  const f = ${this.prefix}L(a);`);
    if (entry !== undefined) {
      em.line(`  r.n = ${q(this.sid(entry))};`, this.sid(entry));
      this.follow(entry, 'then', '  ', em);
    }
    const outs = this.outputs.map((o) => {
      const node = this.byId.get(o.id)!;
      const p = this.portsOf(node).inputs.find((x) => x.id === 'value')!;
      return this.readInput(node, p);
    });
    em.line(`  return [${outs.join(', ')}];`);
    em.line('}');
  }
}

/** The whole script: its graphs, function names, delays. */
class ScriptCode {
  readonly graphs: BehaviorScriptGraph[];
  readonly codes: GraphCode[] = [];
  scriptCode: GraphCode | null = null;
  readonly functionNames = new Map<string, string>();
  readonly delayNames = new Map<string, string>();

  constructor(graphs: BehaviorScriptGraph[]) {
    this.graphs = graphs;
    graphs.forEach((sg, i) => {
      const code = new GraphCode(this, sg, i === 0 ? '' : `f${i}_`);
      if (i === 0) this.scriptCode = code;
      else this.functionNames.set(sg.scope, `F${i}`);
      this.codes.push(code);
    });
  }
  functionName(scope: string): string | null {
    return this.functionNames.get(scope) ?? null;
  }
  delayTimer(n: GraphNode): string {
    let name = this.delayNames.get(n.id);
    if (name === undefined) {
      name = `${DELAY_TIMER_PREFIX}${this.delayNames.size}`;
      this.delayNames.set(n.id, name);
    }
    return name;
  }
}

/**
 * Generate the TypeScript container of a behavior graph (with the script's
 * functions and the project's shared functions in `env`). Refuses (with
 * node-attributed problems) a graph that is structurally invalid for its
 * kind or fails the compile checks (`checkBehaviorGraph`).
 */
export function generateGraphSource(graph: GraphData, env: BehaviorScriptEnv = {}): GraphSourceResult {
  const graphs = behaviorScriptGraphs(graph, env);
  const structural: BehaviorGraphProblem[] = [];
  for (const sg of graphs) {
    const errors: ModelErrorV2[] = [];
    validateGraphData(sg.kind, sg.graph, '', errors, sg.ctx);
    const list = Array.isArray((sg.graph as { nodes?: unknown }).nodes) ? (sg.graph.nodes as { id?: unknown }[]) : [];
    for (const e of errors.slice(0, 32)) {
      const m = /^\/nodes\/(\d+)/.exec(e.path ?? '');
      const id = m !== null ? list[Number(m[1])]?.id : undefined;
      structural.push({ severity: 'error', message: `${e.message}${e.path !== undefined && e.path !== '' ? ` (at ${sg.scope === '' ? '' : `${sg.scope} `}${e.path})` : ''}`, ...(typeof id === 'string' ? { nodeId: scopedNodeId(sg.scope, id) } : {}) });
    }
  }
  if (structural.length > 0) return { ok: false, problems: structural.slice(0, 32) };
  const checked = checkBehaviorGraph(graph, env);
  const errors = checked.filter((p) => p.severity === 'error');
  if (errors.length > 0) return { ok: false, problems: errors };

  const script = new ScriptCode(graphs);
  const main = script.scriptCode!;
  const em = new Emitter();
  const declaration = behaviorGraphDeclaration(graph);
  const phases = behaviorNodePhases(graphs);
  try {
    em.line(GRAPH_SOURCE_BANNER);
    em.line('/* eslint-disable */');
    em.line('');
    em.line('export const properties = {');
    for (const p of declaration.properties) em.line(`  ${p.key}: ${propertyCall(p)},`);
    em.line('};');
    em.line('');
    for (const l of RUNTIME_HELPERS.split('\n')) em.line(l);
    for (const code of script.codes) {
      code.emitFrame(em);
      code.emitNodes(em);
      const fname = script.functionName(code.sg.scope);
      if (fname !== null) code.emitFunction(em, fname);
    }

    // The module: per-object variables, and the events of each phase in their fixed order.
    const instanceVars: string[] = [];
    for (const n of variableNodesOf(graph)) {
      const name = String(main.field(n, 'name', ''));
      if (main.declared.get(name) !== n || main.locals.has(name)) continue;
      const k = variableTypeOf(n.type)!;
      if (k === 'list' || k === 'map') instanceVars.push(`${q(name)}: ${zero(k)}`);
      else if (k === 'entity') instanceVars.push(`${q(name)}: inst.properties[${q(name)}] ?? ""`);
      else if (k === 'vector') instanceVars.push(`${q(name)}: cv(inst.properties[${q(name)}], "vector")`);
      else instanceVars.push(`${q(name)}: inst.properties[${q(name)}]`);
    }
    em.line('');
    em.line('export default {');
    em.line('  instantiate(_prepared: unknown, inst: { entityId: string; properties: Record<string, any> }): S {');
    em.line('    return {');
    em.line('      st: {},');
    em.line('      k: -1,');
    em.line('      it: 0,');
    em.line(`      v: { ${instanceVars.join(', ')} },`);
    em.line('      g: {},');
    em.line('      d: {},');
    em.line('      rng: seed(String(inst.entityId)),');
    em.line('    };');
    em.line('  },');
    em.line('  step(s: S, c: any): void {');
    em.line("    if (c.phase !== 'intent' && c.phase !== 'transform') return;");
    em.line('    if (s.k !== c.stepIndex) {');
    em.line('      s.k = c.stepIndex;');
    em.line('      s.it = 0;');
    em.line('    }');
    em.line("    const r: R = { n: '' };");
    em.line('    try {');
    for (const phase of ['intent', 'transform'] as const) {
      const events = main.nodes.filter((n) => main.isEvent(n) && eventPhase(n) === phase);
      const delays = main.nodes.filter((n) => n.type === 'flow.delay' && phases.get(n.id)?.has(phase) === true);
      if (events.length === 0 && delays.length === 0) continue;
      em.line(`      if (c.phase === ${q(phase)}) {`);
      const starts = events.filter((n) => n.type === 'event.start');
      em.line(`        if (s.st[${q(phase)}] !== true) {`);
      em.line(`          s.st[${q(phase)}] = true;`);
      for (const n of starts) em.line(`          ${main.name(n)}(s, c, r);`, n.id);
      em.line('        }');
      const rest = [...events.filter((n) => n.type !== 'event.start'), ...delays].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const n of rest) {
        if (n.type !== 'flow.delay') {
          em.line(`        ${main.name(n)}(s, c, r);`, n.id);
          continue;
        }
        // A pending Delay continues in the step its timer fires, with the frame it kept.
        const key = q(n.id);
        em.line(`        if (s.d[${key}] !== undefined && c.timers.fired(${q(script.delayTimer(n))})) {`, n.id);
        em.line(`          const f = s.d[${key}]!;`, n.id);
        em.line(`          s.d[${key}] = undefined;`, n.id);
        em.line(`          r.n = ${key};`, n.id);
        main.follow(n, 'then', '          ', em);
        em.line('        }', n.id);
      }
      em.line('      }');
    }
    em.line('    } catch (e) {');
    em.line('      throw tag(e, r.n);');
    em.line('    }');
    em.line('  },');
    em.line('};');
    em.line('');
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, problems: [e.problem] };
    throw e;
  }

  const container: SourceGraphContainer = {
    graphVersion: 1,
    entryPath: ENTRY_PATH,
    requiredModules: [],
    ownedTransforms: behaviorOwnedTransforms(graphs),
    files: [{ path: ENTRY_PATH, text: em.lines.join('\n') }],
  };
  return { ok: true, container, containerBytes: utf8Encode(canonicalContainerText(container)), declaration, lineNodes: em.nodes, problems: checked.filter((p) => p.severity === 'warning') };
}

/** `property[.private].<type>(default, { label, values?, group?, tooltip? })` for the code declaration. */
function propertyCall(p: DeclaredProperty): string {
  const opts: string[] = [`label: ${lit(p.label)}`];
  if (p.values !== undefined) opts.push(`values: ${lit(p.values)}`);
  if (p.group !== undefined) opts.push(`group: ${lit(p.group)}`);
  if (p.tooltip !== undefined) opts.push(`tooltip: ${lit(p.tooltip)}`);
  return `property${p.visibility === 'private' ? '.private' : ''}.${p.type}(${lit(p.default as GraphValue | null)}, { ${opts.join(', ')} })`;
}

/** Compile diagnostics with the node of their line (`nodeId`), when the line is a node's code. */
export function diagnosticsWithNodes(diagnostics: readonly CompileDiagnostic[], lineNodes: readonly (string | null)[]): CompileDiagnostic[] {
  return diagnostics.map((d) => {
    const id = d.path === ENTRY_PATH && typeof d.line === 'number' ? lineNodes[d.line - 1] : null;
    return id !== null && id !== undefined ? { ...d, nodeId: id } : { ...d };
  });
}

/** Graph problems (errors) as a compile failure with node-attributed diagnostics. */
export function graphProblemsFailure(problems: readonly BehaviorGraphProblem[]): BehaviorCompileFailure {
  const errors = problems.filter((p) => p.severity === 'error').slice(0, 32);
  return {
    ok: false,
    code: 'behavior_source_invalid',
    reason: 'graph',
    diagnostics: errors.map((p) => ({ code: 'behavior_source_invalid', reason: 'graph', message: p.message.slice(0, 256), ...(p.nodeId !== undefined ? { nodeId: p.nodeId } : {}) })),
  };
}

export type BehaviorGraphCompileResult =
  | { ok: true; result: Extract<BehaviorCompileResult, { ok: true }>; containerBytes: Uint8Array; lineNodes: (string | null)[]; warnings: BehaviorGraphProblem[] }
  | { ok: false; failure: BehaviorCompileFailure; containerBytes: Uint8Array | null; warnings: BehaviorGraphProblem[] };

/**
 * Generate and compile a behavior graph with the given compiler (the
 * backend's check route and tests). A compile failure's diagnostics carry
 * the node of their line.
 */
export async function compileBehaviorGraph(
  compiler: BehaviorCompiler,
  input: { behaviorId: string; graph: GraphData; env?: BehaviorScriptEnv; limits?: BehaviorCompileInput['limits'] },
): Promise<BehaviorGraphCompileResult> {
  const gen = generateGraphSource(input.graph, input.env);
  if (!gen.ok) return { ok: false, failure: graphProblemsFailure(gen.problems), containerBytes: null, warnings: [] };
  const result = await compiler.compile({
    behaviorId: input.behaviorId,
    declaration: gen.declaration,
    containerBytes: gen.containerBytes,
    pinnedModules: compiler.pinnedModules,
    ...(input.limits !== undefined ? { limits: input.limits } : {}),
  });
  if (!result.ok) return { ok: false, failure: { ...result, diagnostics: diagnosticsWithNodes(result.diagnostics, gen.lineNodes) }, containerBytes: gen.containerBytes, warnings: gen.problems };
  return { ok: true, result, containerBytes: gen.containerBytes, lineNodes: gen.lineNodes, warnings: gen.problems };
}
