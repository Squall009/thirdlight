/**
 * Phase 19.0: the visual-script compiler front end (graph → TypeScript).
 *
 * A behavior graph (project-model `BEHAVIOR_GRAPH_KIND`) is turned into one
 * TypeScript file, `src/index.ts`, in an ordinary source-graph container;
 * that container goes through the one behavior compiler (`compileBehavior`)
 * like any hand-written source — the same limits, output scan, engine pins,
 * trust gate and publication. The file declares its properties in code
 * (`export const properties`), derived from the graph's variables, so the
 * published declaration always matches the graph (15.4's "code wins").
 *
 * Node ids reach errors in two ways:
 * - compile time: `lineNodes[i]` is the node whose code is on line i + 1, so
 *   a compiler diagnostic with a line maps to a node (`nodeId`);
 * - run time: the generated code keeps the id of the node it is executing
 *   (`r.n`) and tags any error thrown from it with `nodeId`; the runtime's
 *   behavior host copies that id into the script error (diagnostics and
 *   Play), so a failure points at a node.
 *
 * Determinism: events run in a fixed order each step (the On start nodes on
 * the script's first step and on the first step of every run, then the On
 * step nodes; nodes of one kind in id order), there is no clock and no
 * randomness, and loops are bounded by `BEHAVIOR_GRAPH_LIMITS
 * .loopIterationsPerStep` per instance and step (beyond it: a script error
 * naming the loop node).
 *
 * Pure: no I/O; identical graphs give byte-identical containers.
 */
import {
  BEHAVIOR_API_NODES,
  BEHAVIOR_GRAPH_KIND,
  BEHAVIOR_GRAPH_LIMITS,
  behaviorGraphDeclaration,
  checkBehaviorGraph,
  nodeDef,
  portCompatibility,
  validateGraphData,
  variableTypeOf,
  type BehaviorGraphProblem,
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
const TYPE_DEFAULT: Record<string, string> = { number: '0', boolean: 'false', string: '""' };

/**
 * A literal as TypeScript text. Strings are written with only the escapes
 * the code-declaration reader accepts (\\, \", \uXXXX for control and
 * line-separator characters), so the same text is valid TypeScript and a
 * readable code declaration.
 */
function lit(v: GraphValue | null): string {
  if (typeof v === 'string') {
    let out = '"';
    for (const ch of v) {
      const code = ch.charCodeAt(0);
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else out += ch;
    }
    return `${out}"`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? '0' : String(v)) : '0';
  return JSON.stringify(v);
}

class Emitter {
  readonly lines: string[] = [];
  readonly nodes: (string | null)[] = [];
  line(text: string, nodeId: string | null = null): void {
    this.lines.push(text);
    this.nodes.push(nodeId);
  }
}

/**
 * Generate the TypeScript container of a behavior graph. Refuses (with
 * node-attributed problems) a graph that is structurally invalid for the
 * kind or fails the compile checks (`checkBehaviorGraph`).
 */
export function generateGraphSource(graph: GraphData): GraphSourceResult {
  const structural: ModelErrorV2[] = [];
  validateGraphData(BEHAVIOR_GRAPH_KIND, graph, '', structural);
  if (structural.length > 0) {
    const list = Array.isArray((graph as { nodes?: unknown }).nodes) ? (graph.nodes as { id?: unknown }[]) : [];
    return {
      ok: false,
      problems: structural.slice(0, 32).map((e) => {
        const m = /^\/nodes\/(\d+)/.exec(e.path ?? '');
        const id = m !== null ? list[Number(m[1])]?.id : undefined;
        return { severity: 'error' as const, message: `${e.message}${e.path !== undefined && e.path !== '' ? ` (at ${e.path})` : ''}`, ...(typeof id === 'string' ? { nodeId: id } : {}) };
      }),
    };
  }
  const checked = checkBehaviorGraph(graph);
  const errors = checked.filter((p) => p.severity === 'error');
  if (errors.length > 0) return { ok: false, problems: errors };

  const nodes = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const defOf = (n: GraphNode): GraphNodeDef => nodeDef(BEHAVIOR_GRAPH_KIND, n.type)!;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const isExec = (d: GraphNodeDef): boolean => d.inputs.some((p) => p.type === 'exec');
  const isEvent = (n: GraphNode): boolean => n.type.startsWith('event.');
  const incoming = new Map<string, { node: string; port: string }>();
  const outgoing = new Map<string, string[]>();
  for (const e of graph.edges) {
    incoming.set(`${e.to.node}\u0000${e.to.port}`, e.from);
    const k = `${e.from.node}\u0000${e.from.port}`;
    const l = outgoing.get(k) ?? [];
    l.push(e.to.node);
    outgoing.set(k, l);
  }
  const field = (n: GraphNode, key: string, fallback: GraphValue): GraphValue => {
    const v = n.data?.[key];
    if (v !== undefined) return v;
    const f = defOf(n).fields?.find((x) => x.key === key);
    return f !== undefined ? f.default : fallback;
  };
  const q = (s: string): string => JSON.stringify(s);
  const fnName = (n: GraphNode): string => `${isEvent(n) ? 'e' : isExec(defOf(n)) ? 'x' : 'p'}${index.get(n.id)}`;
  const problems: BehaviorGraphProblem[] = [];

  /** The expression that reads an output port's value. */
  const readOutput = (src: GraphNode, port: GraphPortDef): string => {
    const d = defOf(src);
    if (isEvent(src) || isExec(d)) return `(r.o[${q(`${src.id}.${port.id}`)}] ?? ${TYPE_DEFAULT[port.type] ?? 'undefined'})`;
    return `${fnName(src)}(s, c, r)`;
  };
  /** The value an input port reads: its wire (converted) or the node's inline field. */
  const readInput = (n: GraphNode, port: GraphPortDef): string => {
    const from = incoming.get(`${n.id}\u0000${port.id}`);
    if (from === undefined) {
      const v = field(n, port.id, port.type === 'number' ? 0 : port.type === 'boolean' ? false : '');
      return lit(v);
    }
    const src = byId.get(from.node)!;
    const out = defOf(src).outputs.find((p) => p.id === from.port)!;
    const expr = readOutput(src, out);
    if (out.type === port.type) return expr;
    const conv = portCompatibility(BEHAVIOR_GRAPH_KIND, out.type, port.type);
    if (conv === null) return expr; // refused by the structural check above
    if (port.type === 'string') return `String(${expr})`;
    if (out.type === 'boolean' && port.type === 'number') return `(${expr} ? 1 : 0)`;
    return expr;
  };
  /** Calls of the exec nodes an exec output leads to (one wire, or none). */
  const follow = (n: GraphNode, portId: string, indent: string, em: Emitter): void => {
    for (const to of outgoing.get(`${n.id}\u0000${portId}`) ?? []) em.line(`${indent}${fnName(byId.get(to)!)}(s, c, r);`, n.id);
  };
  const callPath = (path: readonly string[], optional: readonly string[]): string | null => {
    if (path.length === 0 || !path.every((seg) => IDENT_RE.test(seg))) return null;
    let out = 'c';
    path.forEach((seg, i) => {
      // A segment after one that may be absent on ctx is read with `?.`.
      out += i > 0 && optional.includes(path[i - 1]!) ? `?.${seg}` : `.${seg}`;
    });
    return out;
  };

  const em = new Emitter();
  const declaration = behaviorGraphDeclaration(graph);
  em.line(GRAPH_SOURCE_BANNER);
  em.line('/* eslint-disable */');
  em.line('');
  em.line('export const properties = {');
  for (const p of declaration.properties) em.line(`  ${p.key}: ${propertyCall(p)},`);
  em.line('};');
  em.line('');
  em.line(`const CAP = ${BEHAVIOR_GRAPH_LIMITS.loopIterationsPerStep};`);
  em.line('type R = { n: string; it: number; o: Record<string, any> };');
  em.line('type S = { started: boolean; v: Record<string, any> };');
  em.line('function fail(id: string, message: string, detail: string): never {');
  em.line('  throw Object.assign(new Error(message), { nodeId: id, detail });');
  em.line('}');
  em.line('function tag(e: unknown, id: string): unknown {');
  em.line("  if (id === '') return e;");
  em.line('  if (e instanceof Error) {');
  em.line('    if ((e as any).nodeId === undefined) (e as any).nodeId = id;');
  em.line('    return e;');
  em.line('  }');
  em.line('  return Object.assign(new Error(String(e)), { nodeId: id });');
  em.line('}');
  em.line('function div(a: number, b: number): number {');
  em.line('  return b === 0 ? 0 : a / b;');
  em.line('}');

  for (const n of nodes) {
    const d = defOf(n);
    const vt = variableTypeOf(n.type);
    if (vt?.role === 'var') continue;
    const name = fnName(n);
    const id = q(n.id);
    em.line('');
    if (!isEvent(n) && !isExec(d)) {
      // A data node: evaluated where it is read (inputs first, then this node).
      if (d.outputs.length !== 1) return { ok: false, problems: [{ severity: 'error', nodeId: n.id, message: `internal: a data node has one output ("${n.type}")` }] };
      em.line(`function ${name}(s: S, c: any, r: R): any {`, n.id);
      const args = d.inputs.map((p, i) => {
        em.line(`  const a${i} = ${readInput(n, p)};`, n.id);
        return `a${i}`;
      });
      em.line(`  r.n = ${id};`, n.id);
      let expr: string | null = null;
      if (vt?.role === 'get') expr = `s.v[${q(String(field(n, 'variable', '')))}]`;
      else if (n.type === 'math.add') expr = `${args[0]} + ${args[1]}`;
      else if (n.type === 'math.subtract') expr = `${args[0]} - ${args[1]}`;
      else if (n.type === 'math.multiply') expr = `${args[0]} * ${args[1]}`;
      else if (n.type === 'math.divide') expr = `div(${args[0]}, ${args[1]})`;
      else if (n.type === 'math.compare') {
        const ops: Record<string, string> = { '==': '===', '!=': '!==', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
        expr = `${args[0]} ${ops[String(field(n, 'op', '=='))] ?? '==='} ${args[1]}`;
      } else if (n.type === 'logic.and') expr = `${args[0]} && ${args[1]}`;
      else if (n.type === 'logic.or') expr = `${args[0]} || ${args[1]}`;
      else if (n.type === 'logic.not') expr = `!${args[0]}`;
      else {
        const api = BEHAVIOR_API_NODES.find((s) => s.type === n.type);
        const call = api !== undefined ? callPath(api.path, api.optional ?? []) : null;
        if (api !== undefined && call !== null && api.returns !== undefined) expr = `${call}(${args.join(', ')}) ?? ${lit(api.returns.fallback)}`;
      }
      if (expr === null) return { ok: false, problems: [{ severity: 'error', nodeId: n.id, message: `the compiler has no code for "${n.type}"` }] };
      em.line(`  return ${expr};`, n.id);
      em.line('}', n.id);
      continue;
    }
    // An event or exec node: a function run by the flow.
    em.line(`function ${name}(s: S, c: any, r: R): void {`, n.id);
    const args = d.inputs
      .filter((p) => p.type !== 'exec')
      .map((p, i) => {
        em.line(`  const a${i} = ${readInput(n, p)};`, n.id);
        return `a${i}`;
      });
    em.line(`  r.n = ${id};`, n.id);
    const store = (port: string, value: string): void => em.line(`  r.o[${q(`${n.id}.${port}`)}] = ${value};`, n.id);
    if (n.type === 'event.start') follow(n, 'then', '  ', em);
    else if (n.type === 'event.step') {
      store('step', 'c.stepIndex');
      follow(n, 'then', '  ', em);
    } else if (n.type === 'flow.branch') {
      em.line(`  if (${args[0]}) {`, n.id);
      follow(n, 'true', '    ', em);
      em.line('  } else {', n.id);
      follow(n, 'false', '    ', em);
      em.line('  }', n.id);
    } else if (n.type === 'flow.sequence') {
      for (const p of d.outputs) follow(n, p.id, '  ', em);
    } else if (n.type === 'flow.for') {
      em.line(`  const last = Math.trunc(${args[1]});`, n.id);
      em.line(`  for (let i = Math.trunc(${args[0]}); i <= last; i++) {`, n.id);
      em.line(`    r.n = ${id};`, n.id);
      em.line(`    if (++r.it > CAP) fail(${id}, ${q(`the For loop ran more than ${BEHAVIOR_GRAPH_LIMITS.loopIterationsPerStep} iterations in one step`)}, "iteration_cap");`, n.id);
      em.line(`    r.o[${q(`${n.id}.index`)}] = i;`, n.id);
      follow(n, 'body', '    ', em);
      em.line('  }', n.id);
      em.line(`  r.n = ${id};`, n.id);
      follow(n, 'completed', '  ', em);
    } else if (vt?.role === 'set') {
      const key = q(String(field(n, 'variable', '')));
      em.line(`  s.v[${key}] = ${args[0]};`, n.id);
      store('value', `${args[0]}`);
      follow(n, 'then', '  ', em);
    } else if (n.type === 'debug.log') {
      em.line(`  c.log(${q(String(field(n, 'level', 'info')))}, String(${args[0]}));`, n.id);
      follow(n, 'then', '  ', em);
    } else {
      const api = BEHAVIOR_API_NODES.find((s) => s.type === n.type);
      const call = api !== undefined && api.exec ? callPath(api.path, api.optional ?? []) : null;
      if (api === undefined || call === null) return { ok: false, problems: [{ severity: 'error', nodeId: n.id, message: `the compiler has no code for "${n.type}"` }] };
      if (api.returns !== undefined) store(api.returns.id, `${call}(${args.join(', ')}) ?? ${lit(api.returns.fallback)}`);
      else em.line(`  ${call}(${args.join(', ')});`, n.id);
      follow(n, 'then', '  ', em);
    }
    em.line('}', n.id);
  }

  // The module: per-instance variables, and the events in their fixed order.
  const starts = nodes.filter((n) => n.type === 'event.start');
  const steps = nodes.filter((n) => n.type === 'event.step');
  em.line('');
  em.line('export default {');
  em.line('  instantiate(_prepared: unknown, inst: { properties: Record<string, any> }): S {');
  em.line('    return {');
  em.line('      started: false,');
  em.line('      v: {');
  for (const p of declaration.properties) em.line(`        ${q(p.key)}: inst.properties[${q(p.key)}],`);
  em.line('      },');
  em.line('    };');
  em.line('  },');
  em.line('  step(s: S, c: any): void {');
  // Every event runs in the intent phase (a visual script owns no transforms yet).
  em.line("    if (c.phase !== 'intent') return;");
  em.line("    const r: R = { n: '', it: 0, o: {} };");
  em.line('    try {');
  if (starts.length > 0) {
    em.line('      if (!s.started) {');
    em.line('        s.started = true;');
    for (const n of starts) em.line(`        ${fnName(n)}(s, c, r);`, n.id);
    em.line('      }');
  } else em.line('      s.started = true;');
  for (const n of steps) em.line(`      ${fnName(n)}(s, c, r);`, n.id);
  em.line('    } catch (e) {');
  em.line('      throw tag(e, r.n);');
  em.line('    }');
  em.line('  },');
  em.line('};');
  em.line('');

  const container: SourceGraphContainer = {
    graphVersion: 1,
    entryPath: ENTRY_PATH,
    requiredModules: [],
    ownedTransforms: [],
    files: [{ path: ENTRY_PATH, text: em.lines.join('\n') }],
  };
  problems.push(...checked.filter((p) => p.severity === 'warning'));
  return { ok: true, container, containerBytes: utf8Encode(canonicalContainerText(container)), declaration, lineNodes: em.nodes, problems };
}

/** `property[.private].<type>(default, { label, group?, tooltip? })` for the code declaration. */
function propertyCall(p: DeclaredProperty): string {
  const opts: string[] = [`label: ${lit(p.label)}`];
  if (p.group !== undefined) opts.push(`group: ${lit(p.group)}`);
  if (p.tooltip !== undefined) opts.push(`tooltip: ${lit(p.tooltip)}`);
  return `property${p.visibility === 'private' ? '.private' : ''}.${p.type}(${lit(p.default as GraphValue)}, { ${opts.join(', ')} })`;
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
  input: { behaviorId: string; graph: GraphData; limits?: BehaviorCompileInput['limits'] },
): Promise<BehaviorGraphCompileResult> {
  const gen = generateGraphSource(input.graph);
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
