/**
 * Phase 20.1: compiling an effect's system graphs for evaluation.
 *
 * A system graph (kind `effect`) becomes: the four context chains (the
 * blocks in execution order, walked from each context's `then` output), each
 * block's field values (stored or default) and wired inputs (the source node
 * and port with both resolved types, so values convert on the way), and the
 * value nodes the inputs read. Semantic problems that depend on node data
 * are diagnostics here, never refusals: a graph is edited through
 * incomplete states (a Parameter naming no declared parameter reads its
 * zero, a block off every chain does nothing, …).
 */
import {
  EFFECT_CONTEXTS,
  EFFECT_GRAPH_KIND,
  effectGraphContext,
  nodeDef,
  resolveGraphPorts,
  type EffectContext,
  type EffectDef,
  type EffectSystem,
  type GraphNode,
  type GraphNodeDef,
  type GraphNodePorts,
  type GraphValue,
} from '@thirdlight/project-model';

import { hashString } from './rng';

export interface EffectDiagnostic {
  systemId: string;
  nodeId?: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** Where a wired input reads from, with the types at both ends. */
export interface WireSource {
  /** The source node and output port (not named `node`: a minified `{node:…}` would trip the export scan). */
  nodeId: string;
  portId: string;
  /** The source output's resolved type. */
  fromType: string;
  /** The input's resolved type. */
  toType: string;
}

export interface CompiledNode {
  id: string;
  type: string;
  def: GraphNodeDef;
  /** Every field of the type: the stored value or the default. */
  fields: Record<string, GraphValue>;
  /** Wired inputs by port id. */
  wired: Record<string, WireSource>;
  ports: GraphNodePorts;
  /** A stable 32-bit key of the node id (per-node random streams). */
  key: number;
}

export interface TrailSpec {
  segments: number;
  length: number;
}

export interface SystemProgram {
  systemId: string;
  index: number;
  name: string;
  space: 'local' | 'world';
  /** maxParticles, capped by the executor's limit. */
  capacity: number;
  chains: Record<EffectContext, CompiledNode[]>;
  nodes: ReadonlyMap<string, CompiledNode>;
  /** The trail kept per particle when an Output ribbon draws trails (the longest asked for). */
  trail: TrailSpec | null;
}

export interface EffectProgram {
  effect: EffectDef;
  systems: SystemProgram[];
  diagnostics: EffectDiagnostic[];
}

export interface CompileOptions {
  /** The executor's particle cap per system (e.g. the CPU fallback's lower cap); absent = maxParticles. */
  capacityLimit?: number;
}

/** Update blocks that run after the position moved (collisions and kills), in chain order. */
export const POST_INTEGRATION_BLOCKS: ReadonlySet<string> = new Set(['update.collide.plane', 'update.collide.depth', 'update.kill.plane', 'update.kill.sphere', 'update.kill.box', 'update.kill.speed']);

function compileSystem(effect: EffectDef, system: EffectSystem, index: number, options: CompileOptions, diagnostics: EffectDiagnostic[]): SystemProgram {
  const kind = EFFECT_GRAPH_KIND;
  const graph = system.graph;
  const ctx = effectGraphContext(effect.parameters);
  const resolved = resolveGraphPorts(kind, graph, ctx);
  const warn = (severity: EffectDiagnostic['severity'], message: string, nodeId?: string): void => {
    diagnostics.push({ systemId: system.systemId, ...(nodeId !== undefined ? { nodeId } : {}), severity, message });
  };
  const nodes = new Map<string, CompiledNode>();
  for (const n of graph.nodes) {
    const def = nodeDef(kind, n.type);
    if (def === undefined) continue;
    const fields: Record<string, GraphValue> = {};
    for (const f of def.fields ?? []) fields[f.key] = (n as GraphNode).data?.[f.key] ?? f.default;
    nodes.set(n.id, { id: n.id, type: n.type, def, fields, wired: {}, ports: resolved.get(n.id) ?? { inputs: [], outputs: [] }, key: hashString(n.id) });
  }
  const next = new Map<string, string>();
  for (const e of graph.edges) {
    const to = nodes.get(e.to.node);
    const from = nodes.get(e.from.node);
    if (to === undefined || from === undefined) continue;
    const inPort = to.ports.inputs.find((p) => p.id === e.to.port);
    const outPort = from.ports.outputs.find((p) => p.id === e.from.port);
    if (inPort === undefined || outPort === undefined) continue;
    if (e.to.port === 'in' && e.from.port === 'then') next.set(e.from.node, e.to.node);
    else to.wired[e.to.port] = { nodeId: e.from.node, portId: e.from.port, fromType: outPort.type, toType: inPort.type };
  }
  const chains = {} as Record<EffectContext, CompiledNode[]>;
  const onChain = new Set<string>();
  for (const c of EFFECT_CONTEXTS) {
    const list: CompiledNode[] = [];
    let at = next.get(c);
    while (at !== undefined && !onChain.has(at)) {
      onChain.add(at);
      const n = nodes.get(at);
      if (n !== undefined) list.push(n);
      at = next.get(at);
    }
    chains[c] = list;
  }
  // Diagnostics.
  const params = new Set((effect.parameters ?? []).map((p) => p.key));
  const systemIds = new Set(effect.systems.map((s) => s.systemId));
  for (const n of nodes.values()) {
    const isBlock = n.def.outputs.some((p) => p.id === 'then') && !(EFFECT_CONTEXTS as readonly string[]).includes(n.type);
    if (isBlock && !onChain.has(n.id)) warn('warning', `"${n.def.label}" is not on its context's chain: it does nothing`, n.id);
    if (n.type === 'value.parameter' && !params.has(String(n.fields['key']))) warn('error', `the Parameter node names no parameter of this effect ("${String(n.fields['key'])}"): it reads 0`, n.id);
    if (n.type === 'spawn.event') {
      const src = String(n.fields['system']);
      if (!systemIds.has(src)) warn('warning', `"From event" names no system of this effect ("${src}"): it spawns nothing`, n.id);
    }
    if (n.type === 'update.collide.depth' && onChain.has(n.id)) warn('info', 'scene-depth collision is honoured only by the WebGPU executor; the CPU fallback ignores it', n.id);
  }
  for (const b of chains.spawn) {
    if (readsAttribute(b, nodes, new Set())) warn('warning', `"${b.def.label}" reads a particle attribute in Spawn (there is no particle there: it reads 0)`, b.id);
  }
  if (chains.output.length === 0) warn('warning', 'the Output chain has no renderer: the system simulates but draws nothing');
  if (chains.initialize.every((b) => b.type !== 'init.lifetime')) warn('info', 'no Lifetime block: particles live 1 s');
  let trail: TrailSpec | null = null;
  for (const b of chains.output) {
    if (b.type === 'output.ribbon' && b.fields['mode'] === 'trail') {
      const segments = Math.round(Number(b.fields['segments']));
      const length = Number(b.fields['trailLength']);
      trail = trail === null ? { segments, length } : { segments: Math.max(trail.segments, segments), length: Math.max(trail.length, length) };
    }
  }
  const capacity = Math.max(1, Math.min(system.maxParticles, options.capacityLimit ?? system.maxParticles));
  if (capacity < system.maxParticles) warn('info', `capacity capped at ${capacity} particles by this executor (maxParticles ${system.maxParticles})`);
  return { systemId: system.systemId, index, name: system.name, space: system.space, capacity, chains, nodes, trail };
}

function readsAttribute(n: CompiledNode, nodes: ReadonlyMap<string, CompiledNode>, seen: Set<string>): boolean {
  if (seen.has(n.id)) return false;
  seen.add(n.id);
  for (const w of Object.values(n.wired)) {
    const src = nodes.get(w.nodeId);
    if (src === undefined) continue;
    if (src.type === 'value.attribute') return true;
    if (readsAttribute(src, nodes, seen)) return true;
  }
  return false;
}

/** Compile every system of an effect (the diagnostics list every system's problems). */
export function compileEffect(effect: EffectDef, options: CompileOptions = {}): EffectProgram {
  const diagnostics: EffectDiagnostic[] = [];
  const systems = effect.systems.map((s, i) => compileSystem(effect, s, i, options, diagnostics));
  return { effect, systems, diagnostics };
}
