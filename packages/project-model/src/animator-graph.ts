/**
 * Phase 16.2: an animator controller's graphs (owner kind `animator`).
 *
 * The controller data is unchanged (plus optional editor layout); its graphs
 * are views of it, read and written here:
 *
 * - **a layer** (owner id `<controllerId>` for the base layer,
 *   `<controllerId>@<n>` for override layer n): the fixed nodes `ENTRY` (its
 *   one wire goes to the layer's entry state) and `ANY` (Any State), one node
 *   per state (node id = state id; type `state` = a clip, `blend` = a 1D blend
 *   tree, `empty` = nothing, override layers only; the node fields mirror the
 *   state's fields) and one wire per ordered pair of states that has
 *   transitions (id `T` + a hash of the pair; the pair's transitions — their
 *   conditions, crossfade, exit time, order — stay in the controller, edited
 *   with `setAnimator`). Connecting a new pair adds one transition (exit time
 *   1, crossfade 0.1 s: plays the source to its end, a short blend);
 *   disconnecting a wire removes the pair's transitions.
 * - **a blend tree** (owner id `<controllerId>#<stateId>`): the fixed `OUT`
 *   (Blend) node and one `clip` node per blend child (`C<i>`, in threshold
 *   order), each wired into `OUT`. Every clip node is a child (the wires are
 *   derived: a clip cannot be left unwired).
 *
 * Positions, groups, comments and collapsed nodes are stored in the optional
 * `layout` of the layer / blend motion (and the state / child `position`);
 * data without them opens with an automatic layout (states in columns by
 * their distance from the entry state).
 *
 * The editor may import project-model types only: it has its own copy of
 * the read side (editor/src/graph/animator.ts), kept equal by
 * tests/animator-graph-parity.test.ts.
 */
import {
  canonicalAnimatorController,
  validateAnimatorController,
  type AnimatorClipRef,
  type AnimatorController,
  type AnimatorLayout,
  type AnimatorMotion,
  type AnimatorState,
  type AnimatorTransition,
} from './animator';
import type { ModelErrorV2 } from './errors';
import { canonicalGraphData, type GraphData, type GraphEdge, type GraphNode, type GraphPoint, type GraphPortRef, type GraphValue } from './graph';

export type AnimatorOwnerTarget = { controllerId: string; layer: number } | { controllerId: string; blendState: string };

const ENTRY = 'ENTRY';
const ANY = 'ANY';
const OUT = 'OUT';
const ENTRY_WIRE = 'ENTRY-WIRE';
/** Layout steps (graph units): a column per step from the entry state, a row per state. */
const COLUMN = 260;
const ROW_STEP = 130;
const BLEND_ROW = 110;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `ctrl` → base layer; `ctrl@2` → override layer 2; `ctrl#walk` → the blend tree of state `walk`. */
export function parseAnimatorOwnerId(id: string): AnimatorOwnerTarget | null {
  const hash = id.indexOf('#');
  if (hash >= 0) {
    const controllerId = id.slice(0, hash);
    const blendState = id.slice(hash + 1);
    return ID_RE.test(controllerId) && ID_RE.test(blendState) ? { controllerId, blendState } : null;
  }
  const at = id.indexOf('@');
  if (at >= 0) {
    const controllerId = id.slice(0, at);
    const n = id.slice(at + 1);
    return ID_RE.test(controllerId) && /^[1-9][0-9]?$/.test(n) ? { controllerId, layer: Number(n) } : null;
  }
  return ID_RE.test(id) ? { controllerId: id, layer: 0 } : null;
}

type Layer = { states: AnimatorState[]; transitions: AnimatorTransition[]; entry: string; layout?: AnimatorLayout };

function layerOf(c: AnimatorController, layer: number): Layer | null {
  if (layer === 0) return c;
  return c.layers?.[layer - 1] ?? null;
}

function blendStateOf(c: AnimatorController, stateId: string): AnimatorState | null {
  for (const l of [c, ...(c.layers ?? [])]) {
    const s = l.states.find((x) => x.id === stateId);
    if (s !== undefined) return s.motion.kind === 'blend1d' ? s : null;
  }
  return null;
}

/** 32-bit FNV-1a of a string, 8 hex digits (stable wire ids for state pairs). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A port reference by assignment (a minified `{node: …}` literal would put "node:" into an export bundle). */
function ref(nodeId: string, port: string): GraphPortRef {
  const o = {} as Record<string, string>;
  o['node'] = nodeId;
  o['port'] = port;
  return o as unknown as GraphPortRef;
}
function wire(id: string, from: GraphPortRef, to: GraphPortRef): GraphEdge {
  const e = {} as Record<string, unknown>;
  e['id'] = id;
  e['from'] = from;
  e['to'] = to;
  return e as unknown as GraphEdge;
}

/** The transition wires of a layer: one per ordered pair (graph node ids), with the transitions' indices. */
export function animatorTransitionPairs(transitions: readonly AnimatorTransition[]): { id: string; from: string; to: string; indices: number[] }[] {
  const pairs: { id: string; from: string; to: string; indices: number[] }[] = [];
  const byKey = new Map<string, { id: string; from: string; to: string; indices: number[] }>();
  const used = new Set<string>();
  transitions.forEach((t, i) => {
    const from = t.from === '*' ? ANY : t.from;
    const key = `${from}>${t.to}`;
    let p = byKey.get(key);
    if (p === undefined) {
      const base = `T${fnv(key)}`;
      let id = base;
      for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      p = { id, from, to: t.to, indices: [] };
      byKey.set(key, p);
      pairs.push(p);
    }
    p.indices.push(i);
  });
  return pairs;
}

/** Automatic positions of states: columns by the distance from the entry state (transitions followed), rows in state order. */
function autoLayout(l: Layer): Map<string, GraphPoint> {
  const depth = new Map<string, number>([[l.entry, 0]]);
  const queue = [l.entry];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const t of l.transitions) {
      if (t.from === id && !depth.has(t.to)) {
        depth.set(t.to, depth.get(id)! + 1);
        queue.push(t.to);
      }
    }
  }
  const deepest = Math.max(0, ...depth.values());
  const rows = new Map<number, number>();
  const out = new Map<string, GraphPoint>();
  for (const s of l.states) {
    const d = depth.get(s.id) ?? deepest + 1;
    const r = rows.get(d) ?? 0;
    rows.set(d, r + 1);
    out.set(s.id, [240 + d * COLUMN, 20 + r * ROW_STEP]);
  }
  return out;
}

const clipData = (c: AnimatorClipRef): Record<string, GraphValue> => ({ clip: c.clip, asset: c.assetId, ...(c.duration !== 1 ? { duration: c.duration } : {}) });

function stateNode(s: AnimatorState, position: GraphPoint, collapsed: boolean): GraphNode {
  const data: Record<string, GraphValue> = { name: s.name };
  if (s.speed !== 1) data['speed'] = s.speed;
  if (!s.loop) data['loop'] = false;
  if (s.speedParameter !== undefined) data['speedParameter'] = s.speedParameter;
  if (s.motion.kind === 'clip') Object.assign(data, clipData(s.motion.clip));
  if (s.motion.kind === 'blend1d') data['parameter'] = s.motion.parameter;
  return { id: s.id, type: s.motion.kind === 'clip' ? 'state' : s.motion.kind === 'blend1d' ? 'blend' : 'empty', position, ...(collapsed ? { collapsed: true as const } : {}), data };
}

function layoutExtras(l: AnimatorLayout | undefined): Pick<GraphData, 'groups' | 'comments'> {
  return {
    ...(l?.groups !== undefined && l.groups.length > 0 ? { groups: l.groups.map((g) => ({ ...g, rect: [...g.rect] as [number, number, number, number] })) } : {}),
    ...(l?.comments !== undefined && l.comments.length > 0 ? { comments: l.comments.map((c) => ({ ...c, position: [c.position[0], c.position[1]] as GraphPoint, ...(c.size !== undefined ? { size: [c.size[0], c.size[1]] as [number, number] } : {}) })) } : {}),
  };
}

/**
 * A controller's graph for an owner target, with the graph kind id
 * (`animator` for the base layer, `animator-layer` for an override layer,
 * `animator-blend` for a blend tree), or null when the target is not there.
 */
export function animatorGraphOf(c: AnimatorController, target: AnimatorOwnerTarget): { kindId: string; graph: GraphData } | null {
  if ('blendState' in target) {
    const s = blendStateOf(c, target.blendState);
    if (s === null || s.motion.kind !== 'blend1d') return null;
    const m = s.motion;
    const collapsed = new Set(m.layout?.collapsed ?? []);
    const positions = m.children.map((k, i): GraphPoint => (k.position !== undefined ? [k.position[0], k.position[1]] : [0, i * BLEND_ROW]));
    const nodes: GraphNode[] = m.children.map((k, i) => ({
      id: `C${i}`,
      type: 'clip',
      position: positions[i]!,
      ...(collapsed.has(`C${i}`) ? { collapsed: true as const } : {}),
      data: { ...(k.threshold !== 0 ? { threshold: k.threshold } : {}), ...clipData(k.clip) },
    }));
    const maxX = Math.max(...positions.map((p) => p[0]));
    const midY = positions.reduce((a, p) => a + p[1], 0) / Math.max(1, positions.length);
    const out: GraphPoint = m.layout?.output !== undefined ? [m.layout.output[0], m.layout.output[1]] : [maxX + COLUMN + 40, Math.round(midY)];
    nodes.push({ id: OUT, type: 'output', position: out, ...(collapsed.has(OUT) ? { collapsed: true as const } : {}) });
    const edges = m.children.map((_, i) => wire(`W${i}`, ref(`C${i}`, 'motion'), ref(OUT, 'motions')));
    return { kindId: 'animator-blend', graph: canonicalGraphData({ nodes, edges, ...layoutExtras(m.layout) }) };
  }
  const l = layerOf(c, target.layer);
  if (l === null) return null;
  const auto = autoLayout(l);
  const collapsed = new Set(l.layout?.collapsed ?? []);
  const positions = l.states.map((s): GraphPoint => (s.position !== undefined ? [s.position[0], s.position[1]] : auto.get(s.id)!));
  const minX = Math.min(...positions.map((p) => p[0]));
  const minY = Math.min(...positions.map((p) => p[1]));
  const nodes: GraphNode[] = [
    { id: ENTRY, type: 'entry', position: l.layout?.entry !== undefined ? [l.layout.entry[0], l.layout.entry[1]] : [minX - COLUMN, minY], ...(collapsed.has(ENTRY) ? { collapsed: true as const } : {}) },
    { id: ANY, type: 'any', position: l.layout?.any !== undefined ? [l.layout.any[0], l.layout.any[1]] : [minX - COLUMN, minY + ROW_STEP], ...(collapsed.has(ANY) ? { collapsed: true as const } : {}) },
    ...l.states.map((s, i) => stateNode(s, positions[i]!, collapsed.has(s.id))),
  ];
  const edges: GraphEdge[] = [wire(ENTRY_WIRE, ref(ENTRY, 'out'), ref(l.entry, 'in'))];
  for (const p of animatorTransitionPairs(l.transitions)) edges.push(wire(p.id, ref(p.from, 'out'), ref(p.to, 'in')));
  return { kindId: target.layer === 0 ? 'animator' : 'animator-layer', graph: canonicalGraphData({ nodes, edges, ...layoutExtras(l.layout) }) };
}

// ---- write -------------------------------------------------------------------------------

export type AnimatorGraphWrite = { ok: true; controller: AnimatorController } | { ok: false; message: string };

const str = (v: GraphValue | undefined): string => (typeof v === 'string' ? v : '');
const numOr = (v: GraphValue | undefined, d: number): number => (typeof v === 'number' ? v : d);

/** The first clip the controller plays (a new state or blend clip starts with it until one is picked). */
function firstClip(c: AnimatorController): AnimatorClipRef | null {
  for (const l of [c, ...(c.layers ?? [])]) {
    for (const s of l.states) {
      if (s.motion.kind === 'clip') return s.motion.clip;
      if (s.motion.kind === 'blend1d' && s.motion.children[0] !== undefined) return s.motion.children[0].clip;
    }
  }
  return null;
}

/** A clip from node fields: the picked clip, else `fallback`. */
function clipFrom(d: Record<string, GraphValue>, fallback: AnimatorClipRef | null): AnimatorClipRef | null {
  const clip = str(d['clip']);
  if (clip === '') return fallback;
  const assetId = str(d['asset']) || fallback?.assetId || '';
  if (assetId === '') return null;
  return { assetId, clip, duration: numOr(d['duration'], 1) };
}

function layoutOf(graph: GraphData, fixed: Partial<Record<'entry' | 'any' | 'output', GraphPoint>>, collapsed: string[]): AnimatorLayout | undefined {
  const l: AnimatorLayout = {
    ...(fixed.entry !== undefined ? { entry: [fixed.entry[0], fixed.entry[1]] as [number, number] } : {}),
    ...(fixed.any !== undefined ? { any: [fixed.any[0], fixed.any[1]] as [number, number] } : {}),
    ...(fixed.output !== undefined ? { output: [fixed.output[0], fixed.output[1]] as [number, number] } : {}),
    ...(graph.groups !== undefined && graph.groups.length > 0 ? { groups: graph.groups } : {}),
    ...(graph.comments !== undefined && graph.comments.length > 0 ? { comments: graph.comments } : {}),
    ...(collapsed.length > 0 ? { collapsed } : {}),
  };
  return Object.keys(l).length > 0 ? l : undefined;
}

function finish(next: AnimatorController): AnimatorGraphWrite {
  const errors: ModelErrorV2[] = [];
  validateAnimatorController(next, '', errors);
  if (errors.length > 0) return { ok: false, message: `${errors[0]!.message} (at ${errors[0]!.path ?? ''})` };
  return { ok: true, controller: canonicalAnimatorController(next) };
}

/**
 * Write a graph (already validated against its kind) back into the
 * controller: the states, entry state and transition pairs of a layer, or
 * the clips of a blend tree, plus the layout. Returns the new controller
 * (validated) or why the graph does not fit the controller.
 */
export function applyAnimatorGraph(c: AnimatorController, target: AnimatorOwnerTarget, graph: GraphData): AnimatorGraphWrite {
  return 'blendState' in target ? writeBlend(c, target.blendState, graph) : writeLayer(c, target.layer, graph);
}

function writeLayer(c: AnimatorController, layer: number, graph: GraphData): AnimatorGraphWrite {
  const l = layerOf(c, layer);
  if (l === null) return { ok: false, message: `the controller has no layer ${layer}` };
  const entryNode = graph.nodes.find((n) => n.type === 'entry');
  const anyNode = graph.nodes.find((n) => n.type === 'any');
  if (entryNode === undefined || anyNode === undefined) return { ok: false, message: 'a layer graph keeps its Entry and Any State nodes' };
  const stateNodes = graph.nodes.filter((n) => n.type === 'state' || n.type === 'blend' || n.type === 'empty');
  if (stateNodes.length === 0) return { ok: false, message: 'a layer keeps at least one state' };
  const bad = stateNodes.find((n) => !ID_RE.test(n.id));
  if (bad !== undefined) return { ok: false, message: `a state id is lower-case letters, digits, _ and - (starting with a letter or digit): "${bad.id}"` };
  const reroute = graph.edges.find((e) => (e.reroutes ?? []).length > 0);
  if (reroute !== undefined) return { ok: false, message: 'animator transition wires have no reroute points' };

  const first = firstClip(c);
  const numeric = c.parameters.find((p) => p.type === 'float' || p.type === 'int');
  const old = new Map(l.states.map((s) => [s.id, s]));
  const present = new Set(stateNodes.map((n) => n.id));
  const ordered = [...l.states.filter((s) => present.has(s.id)).map((s) => stateNodes.find((n) => n.id === s.id)!), ...stateNodes.filter((n) => !old.has(n.id))];
  const states: AnimatorState[] = [];
  for (const n of ordered) {
    const d = n.data ?? {};
    const prev = old.get(n.id);
    let motion: AnimatorMotion;
    if (n.type === 'state') {
      const clip = clipFrom(d, prev?.motion.kind === 'clip' ? prev.motion.clip : first);
      if (clip === null) return { ok: false, message: `state "${n.id}" needs a clip (set its Clip and Model asset fields)` };
      motion = { kind: 'clip', clip };
    } else if (n.type === 'blend') {
      if (prev?.motion.kind === 'blend1d') motion = { ...prev.motion, parameter: str(d['parameter']) || prev.motion.parameter };
      else {
        const parameter = str(d['parameter']) || numeric?.name || '';
        if (parameter === '') return { ok: false, message: 'a blend tree needs a float or int parameter; add one first' };
        if (first === null) return { ok: false, message: 'a blend tree needs a clip; give a state a clip first' };
        motion = { kind: 'blend1d', parameter, children: [{ threshold: 0, clip: first }, { threshold: 1, clip: first }] };
      }
    } else motion = { kind: 'empty' };
    const name = str(d['name']) || prev?.name || (motion.kind === 'clip' ? motion.clip.clip : motion.kind === 'blend1d' ? 'Blend tree' : 'Empty');
    const speedParameter = str(d['speedParameter']);
    states.push({ id: n.id, name, motion, speed: numOr(d['speed'], 1), ...(speedParameter !== '' ? { speedParameter } : {}), loop: d['loop'] !== false, position: [n.position[0], n.position[1]] });
  }

  // Transition pairs: kept transitions in their order, then one new transition per new pair.
  const fromId = (nodeId: string): string => (nodeId === anyNode.id ? '*' : nodeId);
  const wires = graph.edges.filter((e) => e.from.node !== entryNode.id);
  const pairs = new Set(wires.map((e) => `${fromId(e.from.node)}>${e.to.node}`));
  const transitions = l.transitions.filter((t) => pairs.has(`${t.from}>${t.to}`)).map((t) => ({ ...t, conditions: t.conditions.map((x) => ({ ...x })) }));
  const had = new Set(transitions.map((t) => `${t.from}>${t.to}`));
  for (const e of wires) {
    const key = `${fromId(e.from.node)}>${e.to.node}`;
    if (had.has(key)) continue;
    had.add(key);
    // A new wire: play the source to its end (exit time 1), then a short 0.1 s crossfade — a
    // neutral start the Inspector refines with conditions.
    transitions.push({ from: fromId(e.from.node), to: e.to.node, conditions: [], duration: 0.1, exitTime: 1 });
  }

  const entryWire = graph.edges.find((e) => e.from.node === entryNode.id);
  let entry: string;
  if (entryWire !== undefined) entry = entryWire.to.node;
  else if (present.has(l.entry)) return { ok: false, message: 'the Entry node needs its wire (drag a new wire from Entry to change the first state)' };
  else entry = states[0]!.id;

  const collapsed = graph.nodes.filter((n) => n.collapsed === true).map((n) => (n.id === entryNode.id ? ENTRY : n.id === anyNode.id ? ANY : n.id));
  const layout = layoutOf(graph, { entry: entryNode.position, any: anyNode.position }, collapsed);
  const nextLayer = { states, transitions, entry, ...(layout !== undefined ? { layout } : {}) };
  if (layer === 0) {
    const { layout: _drop, ...rest } = c;
    return finish({ ...rest, ...nextLayer });
  }
  return finish({
    ...c,
    layers: (c.layers ?? []).map((x, i) => {
      if (i !== layer - 1) return x;
      const { layout: _drop, ...rest } = x;
      return { ...rest, ...nextLayer };
    }),
  });
}

function writeBlend(c: AnimatorController, stateId: string, graph: GraphData): AnimatorGraphWrite {
  const s = blendStateOf(c, stateId);
  if (s === null || s.motion.kind !== 'blend1d') return { ok: false, message: `no blend tree state "${stateId}" in this controller` };
  const m = s.motion;
  const outNode = graph.nodes.find((n) => n.type === 'output');
  if (outNode === undefined) return { ok: false, message: 'a blend tree graph keeps its Blend node' };
  const clipNodes = graph.nodes.filter((n) => n.type === 'clip');
  const fallback = m.children[0]?.clip ?? firstClip(c);
  const items: { id: string; child: { threshold: number; clip: AnimatorClipRef; position: [number, number] } }[] = [];
  for (const n of clipNodes) {
    const d = n.data ?? {};
    const i = /^C[0-9]+$/.test(n.id) ? Number(n.id.slice(1)) : -1;
    const prev = i >= 0 ? m.children[i] : undefined;
    const clip = clipFrom(d, prev?.clip ?? fallback);
    if (clip === null) return { ok: false, message: `blend clip "${n.id}" needs a clip` };
    items.push({ id: n.id, child: { threshold: numOr(d['threshold'], 0), clip, position: [n.position[0], n.position[1]] } });
  }
  if (items.length < 2) return { ok: false, message: 'a blend tree has at least two clips' };
  // Children in threshold order (the stored order); equal thresholds are refused by validation.
  items.sort((a, b) => a.child.threshold - b.child.threshold);
  const newId = new Map(items.map((x, i) => [x.id, `C${i}`]));
  const collapsed = graph.nodes.filter((n) => n.collapsed === true).map((n) => (n.id === outNode.id ? OUT : newId.get(n.id) ?? n.id));
  const layout = layoutOf(graph, { output: outNode.position }, collapsed);
  const { layout: _drop, ...motionRest } = m;
  const motion: AnimatorMotion = { ...motionRest, children: items.map((x) => x.child), ...(layout !== undefined ? { layout } : {}) };
  const put = (list: AnimatorState[]): AnimatorState[] => list.map((x) => (x.id === stateId ? { ...x, motion } : x));
  return finish({ ...c, states: put(c.states), ...(c.layers !== undefined ? { layers: c.layers.map((l) => ({ ...l, states: put(l.states) })) } : {}) });
}
