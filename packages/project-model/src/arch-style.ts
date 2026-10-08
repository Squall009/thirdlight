/**
 * Architecture styles and presets evaluated: an `architecture` component's
 * outlines expanded into the elements and profiles the generator makes.
 *
 * - A style (an `architecture-style` graph) is evaluated once per outline:
 *   numbers flow from its Parameter nodes through the maths, paths from the
 *   outline through the path operators, profiles from the profile nodes,
 *   and every element reaching the Output becomes one of the outline's
 *   elements (ids: the outline's id and a hash of the node's id, so they
 *   stay put while the graph is edited elsewhere). Profiles are named by a
 *   hash of their points, so equal profiles are one entry and a chunk's key
 *   changes only when a profile it uses does.
 * - A preset (an `architecture-preset` graph) resolves through the presets
 *   it derives from, root first: the first style named, the values each
 *   sets over its base's, the masks each binds, the sheet each names. A
 *   change to a base reaches every preset derived from it.
 * - A mask drives a parameter by a value read at the outline's middle:
 *   world noise (30.12's lattice noise), the middle's world height, or a
 *   mask painted on the object; from the parameter's value where the mask
 *   is 0 to the binding's `to` where it is 1, within the parameter's range.
 * - A preset naming a trim sheet puts its elements on a material slot of
 *   the sheet's id, mapped to that material (`materials` of the expansion),
 *   so swapping a preset restyles the sheet too. Without one they wear the
 *   object's `architecture` slot.
 * - Swaps (a script's `setArchitecturePreset`) replace a preset by another
 *   wherever an outline names it; a preview (a slider being dragged) puts
 *   values over one preset and everything derived from it.
 *
 * The engine's neutral starters (`arch-style-starters.ts`) are there in
 * every project; a project's graph of the same id replaces one.
 *
 * Pure and deterministic (plain arithmetic, the generator's own trig), so
 * the page, the generator workers, the simulation and an export make the
 * same elements.
 */
import { detSinCos } from './arch-math';
import { hashString, hashText64 } from './arch-math';
import { pathDistanceNear, pathPointAt, samplePath } from './arch-path';
import { ARCHITECTURE_LIMITS, type ArchitectureComponent, type ArchitectureElement, type ArchitectureFill, type ArchitectureOpening, type ArchitectureOutline, type ArchitecturePath, type ArchitectureProfile, type ArchitectureSweep } from './architecture';
import { ARCHITECTURE_PRESET_GRAPH_KIND, ARCHITECTURE_PRESET_KIND, ARCHITECTURE_STYLE_GRAPH_KIND, ARCHITECTURE_STYLE_KIND } from './arch-style-kinds';
import { ARCHITECTURE_STARTER_GRAPHS } from './arch-style-starters';
import type { ModelErrorV2 } from './errors';
import type { GraphData, GraphKindDef, GraphNode, GraphValue } from './graph';
import { ruleNoise } from './surface-rules';

/** A style's exposed parameter. */
export interface ArchitectureStyleParam {
  name: string;
  default: number;
  min: number;
  max: number;
}

/** A style ready to evaluate: its nodes by id, each input's source, its parameters. */
export interface ArchitectureStyleDef {
  id: string;
  nodes: ReadonlyMap<string, GraphNode>;
  /** node id → input port → the output feeding it (multi inputs: every one, in edge order). */
  inputs: ReadonlyMap<string, ReadonlyMap<string, readonly { node: string; port: string }[]>>;
  params: ReadonlyMap<string, ArchitectureStyleParam>;
}

/** A mask binding: drives a parameter from its value to `to` as the mask goes from 0 to 1. */
export interface ArchitectureMaskBinding {
  to: number;
  source: 'noise' | 'height' | 'painted';
  mask: string;
  scale: number;
  seed: number;
  low: number;
  high: number;
}

/** A preset as stored (its own values only). */
export interface ArchitecturePresetDef {
  id: string;
  style: string;
  base: string;
  sheet: string;
  values: ReadonlyMap<string, number>;
  masks: ReadonlyMap<string, ArchitectureMaskBinding>;
}

/** The styles and presets of a project (with the engine's starters), by id. */
export interface ArchitectureStyles {
  readonly styles: ReadonlyMap<string, ArchitectureStyleDef>;
  readonly presets: ReadonlyMap<string, ArchitecturePresetDef>;
}

/** A preset resolved through its bases. */
export interface ResolvedArchitecturePreset {
  id: string;
  style: ArchitectureStyleDef | null;
  /** The trim sheet material (null: the object's `architecture` slot). */
  sheet: string | null;
  values: Readonly<Record<string, number>>;
  masks: Readonly<Record<string, ArchitectureMaskBinding>>;
  /** The chain, the preset first. */
  chain: readonly string[];
  problem: string | null;
}

/** A slider being dragged: values over one preset (and every preset derived from it). */
export interface ArchitecturePreview {
  preset: string;
  values: Readonly<Record<string, number>>;
}

/** What expanding a component gives: the component the generator makes, extra slot materials, problems. */
export interface ArchitectureExpansion {
  component: ArchitectureComponent;
  /** Slot → material: the trim sheets the presets name. */
  materials: Readonly<Record<string, string>>;
  problems: readonly string[];
  /** The presets the outlines resolved through (the chains, after swaps). */
  presets: ReadonlySet<string>;
  /** Each room's storeys' floor plans (object frame; `arch-rooms.ts`). */
  rooms: readonly ArchitectureRoomPlan[];
}

/** A room storey's floor plan (object frame): what a block layer's regions and grid walks read. */
export interface ArchitectureRoomPlan {
  /** The region id: the outline's id, and `-s<storey>` above the ground storey. */
  id: string;
  outline: string;
  storey: number;
  /** The outline's corners on the ground (x, z). */
  points: [number, number][];
  /** The storey's floor and the top of its walls (metres, object frame). */
  floor: number;
  top: number;
  /**
   * The holes its walls' openings make (object frame): the stretch of the
   * outline each spans on the ground and its sill and head heights. Only the
   * openings the room itself lists (one cut through a shared wall is listed
   * by one of the two rooms): what the rooms see each other through.
   */
  openings: ArchitectureRoomOpening[];
  /** Something closes the room overhead: its style's ceiling or roof, or the floor of the storey above. */
  covered: boolean;
  /** Holes in its floor (corners on the ground; stairs' footprints included): what it sees the storey below through. */
  holes: [number, number][][];
}

/** An opening in a room's walls as the rooms' portals read it. */
export interface ArchitectureRoomOpening {
  id: string;
  /** Its ends along the outline (x, z). */
  from: [number, number];
  to: [number, number];
  /** Sill and head (metres, object frame). */
  bottom: number;
  top: number;
}

/** A graph as the table reads it (a content graph document or a shipped one). */
export interface ArchitectureGraphLike {
  graphId: string;
  kind: string;
  graph: GraphData;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function fieldOf(kind: GraphKindDef, node: GraphNode, key: string): GraphValue | undefined {
  const v = node.data?.[key];
  if (v !== undefined) return v;
  return kind.nodes.find((d) => d.type === node.type)?.fields?.find((f) => f.key === key)?.default;
}
const str = (kind: GraphKindDef, n: GraphNode, key: string): string => {
  const v = fieldOf(kind, n, key);
  return typeof v === 'string' ? v : '';
};
const numField = (kind: GraphKindDef, n: GraphNode, key: string): number => {
  const v = fieldOf(kind, n, key);
  return isNum(v) ? v : 0;
};

function styleDef(id: string, graph: GraphData): ArchitectureStyleDef {
  const K = ARCHITECTURE_STYLE_GRAPH_KIND;
  const nodes = new Map<string, GraphNode>();
  for (const n of graph.nodes ?? []) if (typeof n?.id === 'string' && typeof n.type === 'string') nodes.set(n.id, n);
  const inputs = new Map<string, Map<string, { node: string; port: string }[]>>();
  for (const e of graph.edges ?? []) {
    if (!nodes.has(e.from.node) || !nodes.has(e.to.node)) continue;
    let m = inputs.get(e.to.node);
    if (m === undefined) inputs.set(e.to.node, (m = new Map()));
    const list = m.get(e.to.port) ?? [];
    list.push({ node: e.from.node, port: e.from.port });
    m.set(e.to.port, list);
  }
  const params = new Map<string, ArchitectureStyleParam>();
  for (const n of [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (n.type !== 'parameter') continue;
    const name = str(K, n, 'name');
    if (name === '' || params.has(name)) continue;
    let lo = numField(K, n, 'min');
    let hi = numField(K, n, 'max');
    if (lo > hi) [lo, hi] = [hi, lo];
    params.set(name, { name, default: clamp(numField(K, n, 'default'), lo, hi), min: lo, max: hi });
  }
  return { id, nodes, inputs, params };
}

function presetDef(id: string, graph: GraphData): ArchitecturePresetDef {
  const K = ARCHITECTURE_PRESET_GRAPH_KIND;
  const sorted = [...(graph.nodes ?? [])].filter((n) => typeof n?.id === 'string').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const head = sorted.find((n) => n.type === 'preset');
  const values = new Map<string, number>();
  const masks = new Map<string, ArchitectureMaskBinding>();
  for (const n of sorted) {
    if (n.type === 'value') {
      const p = str(K, n, 'parameter');
      if (p !== '' && !values.has(p)) values.set(p, numField(K, n, 'value'));
    } else if (n.type === 'mask') {
      const p = str(K, n, 'parameter');
      const source = str(K, n, 'source');
      if (p === '' || masks.has(p)) continue;
      masks.set(p, { to: numField(K, n, 'to'), source: source === 'height' || source === 'painted' ? source : 'noise', mask: str(K, n, 'mask'), scale: Math.max(0.01, numField(K, n, 'scale')), seed: numField(K, n, 'seed'), low: numField(K, n, 'low'), high: numField(K, n, 'high') });
    }
  }
  return { id, style: head !== undefined ? str(K, head, 'style') : '', base: head !== undefined ? str(K, head, 'base') : '', sheet: head !== undefined ? str(K, head, 'sheet') : '', values, masks };
}

const STARTERS: { styles: Map<string, ArchitectureStyleDef>; presets: Map<string, ArchitecturePresetDef> } = (() => {
  const styles = new Map<string, ArchitectureStyleDef>();
  const presets = new Map<string, ArchitecturePresetDef>();
  for (const g of ARCHITECTURE_STARTER_GRAPHS) {
    if (g.kind === ARCHITECTURE_STYLE_KIND) styles.set(g.graphId, styleDef(g.graphId, g.graph));
    else presets.set(g.graphId, presetDef(g.graphId, g.graph));
  }
  return { styles, presets };
})();

const tables = new WeakMap<readonly unknown[], ArchitectureStyles>();

/**
 * The styles and presets among `graphs` over the engine's starters (a
 * project's graph replaces a starter of its id). Kept per list.
 */
export function architectureStylesOf(graphs: readonly ArchitectureGraphLike[] | undefined): ArchitectureStyles {
  const list = graphs ?? [];
  const known = tables.get(list);
  if (known !== undefined) return known;
  const styles = new Map(STARTERS.styles);
  const presets = new Map(STARTERS.presets);
  for (const g of list) {
    if (g === null || typeof g !== 'object' || typeof g.graphId !== 'string' || typeof g.graph !== 'object' || g.graph === null) continue;
    if (g.kind === ARCHITECTURE_STYLE_KIND) styles.set(g.graphId, styleDef(g.graphId, g.graph));
    else if (g.kind === ARCHITECTURE_PRESET_KIND) presets.set(g.graphId, presetDef(g.graphId, g.graph));
  }
  const out: ArchitectureStyles = { styles, presets };
  tables.set(list, out);
  return out;
}

/** The style and preset graphs a game ships: those of the project (the starters are in the engine). */
export function architectureGraphsOf<T extends { kind: string }>(graphs: readonly T[] | undefined): T[] {
  return (graphs ?? []).filter((g) => g.kind === ARCHITECTURE_STYLE_KIND || g.kind === ARCHITECTURE_PRESET_KIND);
}

const resolved = new WeakMap<ArchitectureStyles, Map<string, ResolvedArchitecturePreset>>();

/** A preset through its bases (the preview's values over its preset, reaching every preset derived from it). */
export function resolveArchitecturePreset(table: ArchitectureStyles, id: string, preview?: ArchitecturePreview | null): ResolvedArchitecturePreset {
  const memo = preview === undefined || preview === null ? resolved.get(table) ?? new Map<string, ResolvedArchitecturePreset>() : null;
  if (memo !== null) {
    resolved.set(table, memo);
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
  }
  const chain: ArchitecturePresetDef[] = [];
  const seen = new Set<string>();
  let problem: string | null = null;
  for (let cur: string = id; cur !== ''; ) {
    if (seen.has(cur)) {
      problem = `preset "${id}" derives from itself (${[...seen, cur].join(' → ')})`;
      break;
    }
    seen.add(cur);
    const p = table.presets.get(cur);
    if (p === undefined) {
      problem = cur === id ? `preset "${id}" is not in the project` : `preset "${id}" derives from "${cur}", which is not in the project`;
      break;
    }
    chain.push(p);
    cur = p.base;
  }
  const values: Record<string, number> = {};
  const masks: Record<string, ArchitectureMaskBinding> = {};
  let styleId = '';
  let sheet = '';
  // Root first: each preset's own values over its base's.
  for (let i = chain.length - 1; i >= 0; i--) {
    const p = chain[i]!;
    if (p.style !== '') styleId = p.style;
    if (p.sheet !== '') sheet = p.sheet;
    for (const [k, v] of p.values) values[k] = v;
    for (const [k, m] of p.masks) masks[k] = m;
    if (preview !== undefined && preview !== null && p.id === preview.preset) for (const [k, v] of Object.entries(preview.values)) if (isNum(v)) values[k] = v;
  }
  const style = styleId !== '' ? table.styles.get(styleId) ?? null : null;
  if (problem === null && style === null) problem = styleId === '' ? `preset "${id}" names no style` : `preset "${id}": style "${styleId}" is not in the project`;
  const out: ResolvedArchitecturePreset = { id, style, sheet: sheet === '' ? null : sheet, values, masks, chain: chain.map((p) => p.id), problem };
  memo?.set(id, out);
  return out;
}

/** A parameter's value for one outline: the preset's (else the style's default), driven by its mask, within its range. */
export function paramValue(p: ArchitectureStyleParam, r: ResolvedArchitecturePreset, at: readonly number[], c: ArchitectureComponent, origin: readonly number[]): number {
  const own = r.values[p.name];
  let v = isNum(own) ? own : p.default;
  const m = r.masks[p.name];
  if (m !== undefined) {
    const t = maskWeight(m, at, c, origin);
    v = v + (m.to - v) * t;
  }
  return clamp(v, p.min, p.max);
}

/** A mask's weight (0-1) at an outline's middle (object frame `at`; the object at `origin`). */
export function maskWeight(m: ArchitectureMaskBinding, at: readonly number[], c: Pick<ArchitectureComponent, 'masks'>, origin: readonly number[]): number {
  let v: number;
  if (m.source === 'noise') v = ruleNoise((origin[0]! + at[0]!) / m.scale, 0, (origin[2]! + at[2]!) / m.scale, m.seed);
  else if (m.source === 'height') v = origin[1]! + at[1]!;
  else v = paintedMaskAt(c.masks?.[m.mask]?.points, at[0]!, at[2]!);
  if (m.high === m.low) return v >= m.high ? 1 : 0;
  return clamp((v - m.low) / (m.high - m.low), 0, 1);
}

/** A painted mask's value at a point (object frame): the strongest dab there, full within half its radius and easing out to its edge. */
export function paintedMaskAt(points: readonly (readonly number[])[] | undefined, x: number, z: number): number {
  let best = 0;
  for (const q of points ?? []) {
    const dx = x - q[0]!;
    const dz = z - q[1]!;
    const r = q[2]!;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    const d = Math.sqrt(d2);
    const t = d <= r / 2 ? 1 : 1 - (d - r / 2) / (r / 2);
    const w = q[3]! * t * t * (3 - 2 * t);
    if (w > best) best = w;
  }
  return best;
}

/** An outline's middle (object frame): the mean of its points. */
export function middleOf(p: ArchitecturePath): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const q of p.points) {
    x += q[0];
    y += q[1];
    z += q[2];
  }
  const n = Math.max(1, p.points.length);
  return [x / n, y / n, z / n];
}

type Value = number | ArchitecturePath | ArchitectureProfile | ElementSpec | null;
/** An element before its id: the node it came from and what it is. */
interface ElementSpec {
  readonly node: string;
  readonly element: Omit<ArchitectureSweep, 'id'> | Omit<ArchitectureFill, 'id'> | Omit<Extract<ArchitectureElement, { kind: 'repeat' }>, 'id'>;
}
const isPath = (v: Value): v is ArchitecturePath => v !== null && typeof v === 'object' && 'points' in v && !('slots' in v);
const isProfile = (v: Value): v is ArchitectureProfile => v !== null && typeof v === 'object' && 'slots' in v;
const isSpec = (v: Value): v is ElementSpec => v !== null && typeof v === 'object' && 'element' in v;

/** The short, stable id part a node gives its element (lower-case base 36 of its id's hash). */
const nodeTag = (nodeId: string): string => hashString(nodeId).toString(36);

/** Rounds away floating noise so equal inputs from different sums name the same profile. */
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * A profile's name among the expansion's profiles: a hash of its fields, so
 * equal profiles are one entry. Profiles named here are built by the
 * expansion's own code (fields always in one order), so the native
 * serializer is canonical for them.
 */
export function architectureProfileName(p: ArchitectureProfile): string {
  return `p${hashText64(JSON.stringify(p))}`;
}

const sameNumbers = (a: readonly number[] | undefined, b: readonly number[] | undefined): boolean => a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]));

/** Whether two paths are the same path (an element drawn on the outline itself). */
function samePath(a: ArchitecturePath, b: ArchitecturePath): boolean {
  if (a === b) return true;
  if (a.points.length !== b.points.length || (a.closed === true) !== (b.closed === true) || (a.curve === true) !== (b.curve === true)) return false;
  if ((a.offset ?? 0) !== (b.offset ?? 0) || (a.chamfer ?? 0) !== (b.chamfer ?? 0) || a.step !== b.step || !sameNumbers(a.bulges, b.bulges)) return false;
  return a.points.every((q, i) => sameNumbers(q, b.points[i]));
}

/**
 * Openings given along `outline` placed along `path` (a moulding inset from
 * a room's walls): each at the point of the path nearest its middle.
 */
function openingsAlong(openings: readonly ArchitectureOpening[], outline: ArchitecturePath, path: ArchitecturePath): ArchitectureOpening[] {
  if (openings.length === 0 || samePath(outline, path)) return [...openings];
  const from = samplePath(outline);
  const to = samplePath(path);
  const p = [0, 0, 0];
  const t = [0, 0, 0];
  return openings.map((o) => {
    pathPointAt(from, o.at, p, t);
    return { ...o, at: r6(pathDistanceNear(to, p[0]!, p[2]!)) };
  });
}

/**
 * One outline through its style: the elements (ids from the outline's) and
 * the profiles they use, into `elements`/`profiles`; problems into `problems`.
 */
export function evaluateStyle(style: ArchitectureStyleDef, value: (name: string) => number, outline: ArchitectureOutline, sheet: string | null, elements: ArchitectureElement[], profiles: Record<string, ArchitectureProfile>, problems: string[]): void {
  const K = ARCHITECTURE_STYLE_GRAPH_KIND;
  const L = ARCHITECTURE_LIMITS;
  const memo = new Map<string, Value>();
  const visiting = new Set<string>();
  const profileName = (p: ArchitectureProfile): string => {
    const name = architectureProfileName(p);
    profiles[name] ??= p;
    return name;
  };
  const source = (n: GraphNode, port: string): readonly { node: string; port: string }[] => style.inputs.get(n.id)?.get(port) ?? [];
  const input = (n: GraphNode, port: string): Value => {
    const s = source(n, port)[0];
    return s === undefined ? null : evaluate(s.node);
  };
  // A number input: the wire's value, else the field's; within the field's range.
  const num = (n: GraphNode, key: string): number => {
    const def = K.nodes.find((d) => d.type === n.type)?.fields?.find((f) => f.key === key);
    const wiredValue = input(n, key);
    const v = typeof wiredValue === 'number' ? wiredValue : numField(K, n, key);
    return clamp(v, def?.min ?? -Infinity, def?.max ?? Infinity);
  };
  const flag = (n: GraphNode, key: string): boolean => fieldOf(K, n, key) === true;
  const base = (n: GraphNode): { detail?: boolean; collide?: boolean; material?: string } => {
    const collide = str(K, n, 'collide');
    const material = str(K, n, 'material');
    return {
      ...(flag(n, 'detail') ? { detail: true } : {}),
      ...(collide === 'yes' ? { collide: true } : collide === 'no' ? { collide: false } : {}),
      ...(material !== '' ? { material } : sheet !== null ? { material: sheet } : {}),
    };
  };
  const evaluate = (id: string): Value => {
    if (memo.has(id)) return memo.get(id)!;
    const n = style.nodes.get(id);
    if (n === undefined || visiting.has(id)) return null;
    visiting.add(id);
    const v = evaluateNode(n);
    visiting.delete(id);
    memo.set(id, v);
    return v;
  };
  const evaluateNode = (n: GraphNode): Value => {
    switch (n.type) {
      case 'outline': {
        const { points, closed, bulges, curve, step, offset, chamfer } = outline.path;
        return { points, ...(closed !== undefined ? { closed } : {}), ...(bulges !== undefined ? { bulges } : {}), ...(curve !== undefined ? { curve } : {}), ...(step !== undefined ? { step } : {}), ...(offset !== undefined ? { offset } : {}), ...(chamfer !== undefined ? { chamfer } : {}) };
      }
      case 'parameter':
        return value(str(K, n, 'name'));
      case 'constant':
        return num(n, 'value');
      case 'add':
        return num(n, 'a') + num(n, 'b');
      case 'multiply':
        return num(n, 'a') * num(n, 'b');
      case 'mix': {
        const a = num(n, 'a');
        return a + (num(n, 'b') - a) * num(n, 't');
      }
      case 'offset':
      case 'raise':
      case 'chamfer': {
        const p = input(n, 'path');
        if (!isPath(p)) return null;
        if (n.type === 'raise') {
          const h = num(n, 'height');
          return { ...p, points: p.points.map((q) => [q[0], r6(q[1] + h), q[2]] as [number, number, number]) };
        }
        const key = n.type === 'offset' ? 'offset' : 'chamfer';
        const v = r6((p[key] ?? 0) + num(n, n.type === 'offset' ? 'distance' : 'size'));
        const { [key]: _old, ...rest } = p;
        return v === 0 ? rest : { ...rest, [key]: v };
      }
      case 'square': {
        const s = r6(num(n, 'size') / 2);
        return { points: [[-s, 0, -s], [s, 0, -s], [s, 0, s], [-s, 0, s]], closed: true };
      }
      case 'wall': {
        const t = r6(num(n, 'thickness') / 2);
        const h = num(n, 'height');
        const d = num(n, 'dado');
        const chamfer = num(n, 'chamfer');
        const [inside, outside, lower, top] = [str(K, n, 'inside'), str(K, n, 'outside'), str(K, n, 'lower'), str(K, n, 'top')];
        const split = d > 0 && d < h;
        const points: [number, number][] = split ? [[t, 0], [t, d], [t, h], [-t, h], [-t, d], [-t, 0]] : [[t, 0], [t, h], [-t, h], [-t, 0]];
        const slots = split ? [lower, inside, top, outside, lower] : [inside, top, outside];
        return { points, slots, ...(chamfer > 0 ? { chamfer } : {}) };
      }
      case 'band': {
        const h = num(n, 'height');
        const d = num(n, 'depth');
        const b = num(n, 'base');
        if (h <= 0.001 || d <= 0.001) return null;
        const s = str(K, n, 'slot');
        return { points: [[d, b], [d, r6(b + h)], [0, r6(b + h)]], slots: [s, s] };
      }
      case 'cove': {
        const size = num(n, 'size');
        const depth = num(n, 'depth');
        const top = num(n, 'top');
        if (size <= 0.001 || depth <= 0.001) return null;
        const s = str(K, n, 'slot');
        // A quarter round from the face out to the depth over three quarters of the size, then a fillet up to the top.
        const points: [number, number][] = [];
        const sc: [number, number] = [0, 0];
        for (let k = 0; k <= 4; k++) {
          detSinCos((k / 4) * (Math.PI / 2), sc);
          points.push([r6(depth * (1 - sc[1])), r6(top - size + size * 0.75 * sc[0])]);
        }
        points.push([depth, top]);
        return { points, slots: points.slice(1).map(() => s), smooth: true };
      }
      case 'shaft':
        return { points: [[0, num(n, 'height')], [0, 0]], slots: [str(K, n, 'slot')] };
      case 'round': {
        const radius = num(n, 'radius');
        const lift = num(n, 'height');
        const sides = Math.round(num(n, 'sides'));
        const sl = str(K, n, 'slot');
        // Counter-clockwise in (across, up): faces look right of each segment's direction, so out of the section.
        const points: [number, number][] = [];
        const sc: [number, number] = [0, 0];
        for (let k = 0; k < sides; k++) {
          detSinCos((k / sides) * Math.PI * 2, sc);
          points.push([r6(radius * sc[1]), r6(lift + radius * sc[0])]);
        }
        return { points, slots: points.map(() => sl), closed: true, smooth: true, ...(sl !== '' ? { cap: sl } : {}) };
      }
      case 'frame': {
        const w = num(n, 'width');
        const d = num(n, 'depth');
        const s = str(K, n, 'slot');
        return { points: [[w, 0], [w, d], [0, d], [0, 0]], slots: [s, s, s] };
      }
      case 'sweep': {
        const path = input(n, 'path');
        const profile = input(n, 'profile');
        if (!isPath(path) || !isProfile(profile)) return null;
        const frame = input(n, 'frame');
        const frameName = isProfile(frame) ? profileName(frame) : undefined;
        const openings = flag(n, 'openings') ? openingsAlong(outline.openings ?? [], outline.path, path).map((o) => ({ ...o, ...(o.frame === undefined && frameName !== undefined ? { frame: frameName } : {}) })) : [];
        return { node: n.id, element: { kind: 'sweep', path, profile: profileName(profile), ...(openings.length > 0 ? { openings } : {}), ...(flag(n, 'wall') ? { wall: true } : {}), ...base(n) } };
      }
      case 'fill': {
        const path = input(n, 'path');
        if (!isPath(path)) return null;
        if (path.closed !== true || path.points.length < 3) {
          problems.push(`outline ${outline.id}: a fill needs a closed outline`);
          return null;
        }
        const shape = str(K, n, 'shape') as ArchitectureFill['shape'];
        const height = num(n, 'height');
        const rise = num(n, 'rise');
        const face = str(K, n, 'face');
        const trimSlot = str(K, n, 'trimSlot');
        const roof = shape === 'gable' || shape === 'hip' || shape === 'mansard';
        const overhang = num(n, 'overhang');
        return {
          node: n.id,
          element: {
            kind: 'fill',
            path,
            shape,
            slot: str(K, n, 'slot') || 'floor',
            ...(trimSlot !== '' ? { trimSlot } : {}),
            ...(height !== 0 ? { height } : {}),
            ...(rise > 0 && shape !== 'flat' && shape !== 'coffered' ? { rise } : {}),
            ...(face === 'up' || face === 'down' ? { face } : {}),
            ...(str(K, n, 'axis') === 'short' ? { axis: 'short' as const } : {}),
            ...(shape === 'coffered' ? { cell: num(n, 'cell'), depth: num(n, 'depth') } : {}),
            ...(roof && overhang > 0 ? { overhang } : {}),
            ...base(n),
          },
        };
      }
      case 'repeat': {
        const path = input(n, 'path');
        if (!isPath(path)) return null;
        const pieces: (ArchitectureSweep | ArchitectureFill)[] = [];
        const used = new Set<string>();
        for (const s of source(n, 'piece')) {
          const v = evaluate(s.node);
          if (!isSpec(v)) continue;
          if (v.element.kind === 'repeat') {
            problems.push(`outline ${outline.id}: a repeat's piece is made of sweeps and fills`);
            continue;
          }
          if (pieces.length >= L.pieceElements) {
            problems.push(`outline ${outline.id}: a repeat's piece has at most ${L.pieceElements} elements`);
            break;
          }
          let id = `n${nodeTag(v.node)}`;
          while (used.has(id)) id = `${id}x`;
          used.add(id);
          pieces.push({ ...v.element, id } as ArchitectureSweep | ArchitectureFill);
        }
        if (pieces.length === 0) return null;
        const start = num(n, 'start');
        const jy = num(n, 'jitterYaw');
        const ja = num(n, 'jitterAlong');
        return {
          node: n.id,
          element: {
            kind: 'repeat',
            path,
            spacing: num(n, 'spacing'),
            ...(start > 0 ? { start } : {}),
            ...(flag(n, 'corners') ? { corners: true } : {}),
            ...(fieldOf(K, n, 'align') === false ? { align: false } : {}),
            ...(jy > 0 || ja > 0 ? { jitter: { ...(jy > 0 ? { yaw: jy } : {}), ...(ja > 0 ? { along: ja } : {}) } } : {}),
            piece: { elements: pieces },
            ...base(n),
          },
        };
      }
      default:
        return null;
    }
  };
  const out = [...style.nodes.values()].find((n) => n.type === 'output');
  if (out === undefined) {
    problems.push(`outline ${outline.id}: style "${style.id}" has no Output`);
    return;
  }
  const used = new Set<string>();
  for (const s of source(out, 'elements')) {
    const v = evaluate(s.node);
    if (!isSpec(v)) continue;
    let id = `${outline.id}-${nodeTag(v.node)}`;
    if (used.has(v.node)) continue;
    used.add(v.node);
    while (elements.some((e) => e.id === id)) id = `${id}x`;
    elements.push({ ...v.element, id } as ArchitectureElement);
  }
}

/**
 * Presets that derive from each other in a cycle are refused (a project's
 * graphs over the starters): validated with the content's graphs.
 */
export function validateArchitectureGraphs(graphs: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(graphs)) return;
  const list = graphs.filter((g): g is ArchitectureGraphLike => typeof g === 'object' && g !== null && (g as { kind?: unknown }).kind === ARCHITECTURE_PRESET_KIND && typeof (g as { graphId?: unknown }).graphId === 'string' && typeof (g as { graph?: unknown }).graph === 'object' && (g as { graph?: unknown }).graph !== null && Array.isArray((g as { graph: { nodes?: unknown } }).graph.nodes));
  if (list.length === 0) return;
  const table = architectureStylesOf(list.map((g) => ({ graphId: g.graphId, kind: g.kind, graph: { nodes: g.graph.nodes, edges: [] } })));
  for (const g of list) {
    const r = resolveArchitecturePreset(table, g.graphId);
    if (r.problem !== null && r.problem.includes('derives from itself')) {
      const i = graphs.indexOf(g);
      errors.push({ code: 'hierarchy_cycle', path: `${path}/${i}`, message: r.problem, found: g.graphId } as ModelErrorV2);
    }
  }
}
