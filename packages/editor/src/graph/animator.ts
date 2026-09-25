/**
 * Phase 16.2: the editor's copy of the animator controller → graph read
 * (project-model animator-graph.ts; the editor may import project-model
 * types only). The Animator tab shows a controller's layer or blend tree
 * through this; edits go to the backend as `graphEdit` on owner kind
 * `animator`, which applies them to the same graph and writes the result
 * back into the controller (the change is a `setAnimators`, from which this
 * view is read again). Kept equal to the backend by
 * tests/animator-graph-parity.test.ts.
 *
 * Pure: no DOM, no I/O.
 */
import type { AnimatorClipRef, AnimatorController, AnimatorLayout, AnimatorState, AnimatorTransition, GraphData, GraphEdge, GraphNode, GraphPoint, GraphValue } from '@thirdlight/project-model';

import { canonicalGraph } from './model';

export type AnimatorOwnerTarget = { controllerId: string; layer: number } | { controllerId: string; blendState: string };

export const ANIMATOR_ENTRY = 'ENTRY';
export const ANIMATOR_ANY = 'ANY';
export const ANIMATOR_OUT = 'OUT';
export const ANIMATOR_ENTRY_WIRE = 'ENTRY-WIRE';
const ENTRY = ANIMATOR_ENTRY;
const ANY = ANIMATOR_ANY;
const OUT = ANIMATOR_OUT;
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

/** The owner id of a target (the inverse of parseAnimatorOwnerId). */
export function animatorOwnerId(t: AnimatorOwnerTarget): string {
  return 'blendState' in t ? `${t.controllerId}#${t.blendState}` : t.layer === 0 ? t.controllerId : `${t.controllerId}@${t.layer}`;
}

type Layer = { states: AnimatorState[]; transitions: AnimatorTransition[]; entry: string; layout?: AnimatorLayout };

export function animatorLayerOf(c: AnimatorController, layer: number): Layer | null {
  if (layer === 0) return c;
  return c.layers?.[layer - 1] ?? null;
}

export function animatorBlendStateOf(c: AnimatorController, stateId: string): AnimatorState | null {
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

function wire(id: string, from: string, fromPort: string, to: string, toPort: string): GraphEdge {
  return { id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } };
}

export interface TransitionPair {
  /** The wire's id. */
  id: string;
  /** Graph node ids ("ANY" for Any State). */
  from: string;
  to: string;
  /** Indices of the pair's transitions in the layer's list (their order = their priority). */
  indices: number[];
}

/** The transition wires of a layer: one per ordered pair (graph node ids), with the transitions' indices. */
export function animatorTransitionPairs(transitions: readonly AnimatorTransition[]): TransitionPair[] {
  const pairs: TransitionPair[] = [];
  const byKey = new Map<string, TransitionPair>();
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
    const s = animatorBlendStateOf(c, target.blendState);
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
    const edges = m.children.map((_, i) => wire(`W${i}`, `C${i}`, 'motion', OUT, 'motions'));
    return { kindId: 'animator-blend', graph: canonicalGraph({ nodes, edges, ...layoutExtras(m.layout) }) };
  }
  const l = animatorLayerOf(c, target.layer);
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
  const edges: GraphEdge[] = [wire(ANIMATOR_ENTRY_WIRE, ENTRY, 'out', l.entry, 'in')];
  for (const p of animatorTransitionPairs(l.transitions)) edges.push(wire(p.id, p.from, 'out', p.to, 'in'));
  return { kindId: target.layer === 0 ? 'animator' : 'animator-layer', graph: canonicalGraph({ nodes, edges, ...layoutExtras(l.layout) }) };
}
