/**
 * Phase 19.1: every node of the visual-script catalogue compiles and runs.
 *
 * Generated over the whole catalogue (core nodes and the API nodes generated
 * from the runtime typings): for each node type a minimal script uses it —
 * an exec node reached from an event of the phase it may run in, a data
 * node whose outputs are stored in variables of their types, an event node
 * alone — plus a script function and a shared function for the call nodes.
 * Each script goes through the real generator and the one behavior compiler
 * (esbuild, output scan, pins), is evaluated in a bounded `node:vm` context
 * and stepped through both phases against a context whose every member
 * records its calls; an API exec node must have called its `ctx` member.
 */
import { createContext, runInContext, Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  BEHAVIOR_API_NODES,
  BEHAVIOR_API_SKIPPED,
  BEHAVIOR_FUNCTION_GRAPH_KIND,
  BEHAVIOR_GRAPH_KIND,
  REQUIRED_CORE_FIELDS,
  staticNodePorts,
  type BehaviorApiNodeSpec,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type GraphNodeDef,
} from '@thirdlight/project-model';

import { compileBehaviorGraph, createBehaviorCompiler } from '../../packages/behavior-build/src/index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const compiler = createBehaviorCompiler();

export function evaluate(outputBytes: Uint8Array): Any {
  const source = new TextDecoder().decode(outputBytes);
  const match = /export\s*\{([^}]*)\};?\s*$/.exec(source);
  const def = match !== null ? /([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+default/.exec(match[1]!) : null;
  if (match === null || def === null) throw new Error('the compiled artifact has no default export');
  const body = `${source.slice(0, match.index)}globalThis.__artifact = ${def[1]};`;
  const context = createContext({}, { name: 'visual-script', codeGeneration: { strings: false, wasm: false } });
  new Script(body, { filename: 'behavior-output.js' }).runInContext(context, { timeout: 1000 });
  return runInContext('globalThis.__artifact', context, { timeout: 1000 });
}

/** A behavior context whose members record their calls (`game.add`, `animator.set`, `emit`…). */
export function recordingContext(calls: string[], phase: 'intent' | 'transform', stepIndex: number): Any {
  const rec =
    (name: string, value: unknown = undefined) =>
    (..._args: unknown[]): unknown => {
      calls.push(name);
      return typeof value === 'function' ? (value as () => unknown)() : value;
    };
  return {
    behaviorId: 'script',
    entityId: 'box-1',
    stepIndex,
    phase,
    properties: { v: 1 },
    action: { stepIndex, moveX: 0.5, jump: 'none', actions: { fire: { v: 1, p: 'pressed' } } },
    intents: { stepIndex, move: null, jump: null, moveWriter: null, jumpWriter: null, transformWrites: [] },
    settings: { gravity_y: -20, run_speed: 5, jump_velocity: 8, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 },
    physics: {
      stageCharacterMove: rec('physics.stageCharacterMove'),
      characterResult: rec('physics.characterResult', { requested: { x: 0, y: 0 }, applied: { x: 0, y: 0 }, position: { x: 1, y: 2 }, grounded: true, supportNormal: { x: 0, y: 1 }, contacts: { ground: true, wall: false, head: false, steepSlope: false }, snapped: false }),
      raycast: rec('physics.raycast', { entityId: 'wall-1', distance: 2, normal: { x: -1, y: 0 } }),
      overlapBox: rec('physics.overlapBox', () => ['crate-1']),
      overlapCircle: rec('physics.overlapCircle', () => ['crate-1']),
      // Phase 23.2: the 3D character's state.
      characterState: rec('physics.characterState', { position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 2 }, grounded: true, contacts: { ground: true, wall: false, head: false, steepSlope: false }, supportNormal: { x: 0, y: 1, z: 0 }, groundEntityId: null, enabled: true, climbing: false, facing: 0 }),
      // Phase 23.3: 3D queries.
      raycast3d: rec('physics.raycast3d', { entityId: 'box-1', point: [0, 1, 0], normal: [0, 1, 0], distance: 4 }),
      overlapSphere: rec('physics.overlapSphere', () => ['crate-1']),
      overlapBox3d: rec('physics.overlapBox3d', () => ['crate-1']),
      overlapCapsule: rec('physics.overlapCapsule', () => ['crate-1']),
      pickAt: rec('physics.pickAt', { entityId: 'box-1', point: [0, 1, 0], normal: [0, 1, 0], distance: 4 }),
      pickAtPointer: rec('physics.pickAtPointer', { entityId: 'box-1', point: [0, 1, 0], normal: [0, 1, 0], distance: 4 }),
    },
    tags: { mask: rec('tags.mask', 1), of: rec('tags.of', 1), has: rec('tags.has', true), query: rec('tags.query', () => ['box-1']) },
    world: { transform: rec('world.transform', { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), find: rec('world.find', 'box-2'), findAll: rec('world.findAll', () => ['box-2']), withComponent: rec('world.withComponent', () => ['box-2']) },
    random: {
      next: rec('random.next', 0.25),
      range: rec('random.range', 1.5),
      int: rec('random.int', 3),
      chance: rec('random.chance', true),
      pick: rec('random.pick', 'a'),
      stream: (name: string) => {
        calls.push('random.stream');
        return { name, next: rec('random.stream.next', 0.5), range: rec('random.stream.range', 2.5), int: rec('random.stream.int', 4), chance: rec('random.stream.chance', false), pick: rec('random.stream.pick', 'b') };
      },
    },
    scenes: { load: rec('scenes.load'), unload: rec('scenes.unload'), status: rec('scenes.status', 'loaded'), loaded: rec('scenes.loaded', () => ['scene-main']) },
    input: { value: rec('input.value', 1), vector: rec('input.vector', () => [1, 0]), pressed: rec('input.pressed', true), released: rec('input.released', true), held: rec('input.held', true), pointer: rec('input.pointer', () => ({ x: 0.5, y: 0.5, dx: 0, dy: 0, wheel: 0, over: true, entered: false, left: false, locked: false })), pointerPressed: rec('input.pointerPressed', true), pointerReleased: rec('input.pointerReleased', false), pointerHeld: rec('input.pointerHeld', true), setCursor: rec('input.setCursor') },
    animator: (id: string) => {
      calls.push('animator');
      // Phase 23.11: per-instance speed and morph weights.
      return id === '' ? null : { set: rec('animator.set', true), trigger: rec('animator.trigger', true), get: rec('animator.get', 1), state: rec('animator.state', 'idle'), setSpeed: rec('animator.setSpeed', true), speed: rec('animator.speed', 1), setMorph: rec('animator.setMorph', true), morph: rec('animator.morph', 0.5) };
    },
    events: [
      { type: 'enter', trigger: 'trigger-1', stepIndex: stepIndex - 1 },
      { type: 'exit', trigger: 'trigger-1', stepIndex: stepIndex - 1 },
      { entityId: 'box-1', name: 'step', clip: 'walk', stepIndex: stepIndex - 1 },
    ],
    timers: { after: rec('timers.after', true), every: rec('timers.every', true), fired: rec('timers.fired', true), cancel: rec('timers.cancel', true) },
    signals: { emit: rec('signals.emit'), on: rec('signals.on', true) },
    messages: { send: rec('messages.send', true), received: rec('messages.received', () => [{ name: 'x', value: 2, from: 'box-2', stepIndex: stepIndex - 1 }]) },
    game: { counter: rec('game.counter', 3), add: rec('game.add'), health: rec('game.health', { current: 2, max: 3 }), setVisible: rec('game.setVisible') },
    audio: { play: rec('audio.play') },
    effects: { play: (...a: unknown[]) => { rec('effects.play')(...a); return 1; }, stop: rec('effects.stop') },
    save: { get: rec('save.get', 4), set: rec('save.set', true), remove: rec('save.remove'), keys: rec('save.keys', () => ['k']) },
    // Phase 23.5: block layers.
    grid: {
      layers: rec('grid.layers', () => ['layer-1']),
      get: rec('grid.get', { block: 'stone', rot: 0, variant: 0, meta: { walkable: true } }),
      set: rec('grid.set', true),
      clear: rec('grid.clear', true),
      columnTop: rec('grid.columnTop', 2),
      worldToCell: rec('grid.worldToCell', { x: 1, y: 2, z: 3 }),
      cellToWorld: rec('grid.cellToWorld', { x: 1.5, y: 2.5, z: 3.5 }),
      meta: rec('grid.meta', true),
      setMeta: rec('grid.setMeta', true),
      pick: rec('grid.pick', { layer: 'layer-1', x: 1, y: 0, z: 2, normal: { x: 0, y: 1, z: 0 }, distance: 3, point: { x: 1.5, y: 0.5, z: 2.5 } }),
      neighbours: rec('grid.neighbours', () => [{ x: 1, y: 0, z: 0 }]),
      regions: rec('grid.regions', () => ['zone.a']),
      region: rec('grid.region', () => [{ x: 0, y: 0, z: 0 }]),
      inRegion: rec('grid.inRegion', true),
      changes: rec('grid.changes', () => []),
      diff: rec('grid.diff', { version: 1, layers: [] }),
      applyDiff: rec('grid.applyDiff', true),
    },
    spawn: rec('spawn', 'spawn-1'),
    destroy: rec('destroy', true),
    emit: rec('emit'),
    log: rec('log'),
    // Phase 23.4: the virtual cameras.
    camera: {
      activate: rec('camera.activate', true),
      deactivate: rec('camera.deactivate', true),
      setPriority: rec('camera.setPriority', true),
      setTarget: rec('camera.setTarget', true),
      set: rec('camera.set', true),
      turn: rec('camera.turn', true),
      shake: rec('camera.shake'),
      live: rec('camera.live', 'cam-1'),
      blending: rec('camera.blending', false),
      get: rec('camera.get', () => ({ rig: 'follow', enabled: true, priority: 0, live: true, target: 'box-1', distance: 5, yaw: 0, pitch: 20, progress: 0, railSpeed: 0, fovY: 60, letterbox: 0 })),
      worldToScreen: rec('camera.worldToScreen', () => ({ x: 0.5, y: 0.5, depth: 5, onScreen: true })),
      screenToRay: rec('camera.screenToRay', () => ({ origin: [0, 0, 5], direction: [0, 0, -1] })),
    },
    // Phase 23.11: sockets.
    sockets: {
      attach: rec('sockets.attach', true),
      detach: rec('sockets.detach', true),
      attachedTo: rec('sockets.attachedTo', () => ({ target: 'box-2', nodeName: 'hand' })),
      nodePose: rec('sockets.nodePose', () => ({ position: [1, 2, 3], rotation: [0, 0, 0, 1] })),
    },
    // Phase 23.12: graph-material parameters per object.
    materials: {
      set: rec('materials.set', true),
      get: rec('materials.get', '#ff0000'),
      reset: rec('materials.reset', true),
      setData: rec('materials.setData', true),
      getData: rec('materials.getData', () => [255, 0, 0, 255]),
    },
    // Phase 23.9a: the project UI.
    ui: {
      set: rec('ui.set', true),
      get: rec('ui.get', 7),
      clear: rec('ui.clear', true),
      show: rec('ui.show', true),
      hide: rec('ui.hide', true),
      isShown: rec('ui.isShown', true),
      play: rec('ui.play', true),
      focus: rec('ui.focus', true),
      events: rec('ui.events', () => [{ kind: 'click', doc: 'hud', widget: 'buy', name: 'buy', value: 1 }]),
      event: rec('ui.event', () => ({ kind: 'click', doc: 'hud', widget: 'buy', name: 'buy', value: 1 })),
    },
  };
}

/** The member a spec calls or reads (`game.add`, `animator.set`, `emit`). */
function memberOf(spec: BehaviorApiNodeSpec): string {
  return spec.access
    .filter((s): s is { prop: string } => 'prop' in s)
    .map((s) => s.prop)
    .join('.');
}

const VAR_FOR: Record<string, string> = { number: 'var.number', boolean: 'var.boolean', string: 'var.string', vector: 'var.vector', list: 'var.list', map: 'var.map' };

/** Fill a node's required texts. */
function requiredData(type: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of REQUIRED_CORE_FIELDS[type] ?? []) out[k] = 'x';
  const spec = BEHAVIOR_API_NODES.find((s) => s.type === type);
  for (const a of spec?.args ?? []) if (a.required === true) out[a.id] = 'x';
  if (type === 'var.get' || type === 'var.set') out['variable'] = 'v';
  if (type === 'fn.call') out['function'] = 'helper';
  if (type === 'fn.library') out['function'] = 'shared-helper';
  if (type === 'flow.switch') Object.assign(out, { cases: 'x, y' });
  if (/^var\.(number|boolean|string|vector|entity|enum|list|map)$/.test(type)) out['name'] = 'w';
  if (type === 'var.enum') out['options'] = 'low, high';
  return out;
}

const FUNCTION_GRAPH = (): GraphData => ({
  nodes: [
    { id: 'start', type: 'fn.entry', position: [0, 0], data: { name: 'helper' } },
    { id: 'arg', type: 'fn.input', position: [0, 100], data: { name: 'amount', type: 'number' } },
    { id: 'twice', type: 'math.multiply', position: [200, 100], data: { b: 2 } },
    { id: 'result', type: 'fn.output', position: [400, 100], data: { name: 'result', type: 'number' } },
    { id: 'log', type: 'debug.log', position: [200, 0] },
  ],
  edges: [
    { id: 'w1', from: { node: 'arg', port: 'value' }, to: { node: 'twice', port: 'a' } },
    { id: 'w2', from: { node: 'twice', port: 'result' }, to: { node: 'result', port: 'value' } },
    { id: 'w3', from: { node: 'start', port: 'then' }, to: { node: 'log', port: 'in' } },
    { id: 'w4', from: { node: 'arg', port: 'value' }, to: { node: 'log', port: 'message' } },
  ],
});
const ENV = {
  functions: [{ functionId: 'helper', graph: FUNCTION_GRAPH() }],
  graphs: [{ graphId: 'shared-helper', kind: 'behavior-library', name: 'Shared helper', graph: FUNCTION_GRAPH() }],
};

/** A minimal script that uses one node of type `def`. */
function scriptFor(def: GraphNodeDef): GraphData {
  const spec = BEHAVIOR_API_NODES.find((s) => s.type === def.type);
  const nodes: GraphNode[] = [{ id: 'v', type: 'var.number', position: [0, -500], data: { name: 'v' } }];
  const edges: GraphEdge[] = [];
  const subject: GraphNode = { id: 'subject', type: def.type, position: [300, 0], data: requiredData(def.type) };
  nodes.push(subject);
  const ports = staticNodePorts(BEHAVIOR_GRAPH_KIND, subject, { lookup: (_l, name) => (name === 'v' ? 'number' : null), graph: () => ({ kind: BEHAVIOR_FUNCTION_GRAPH_KIND, graph: FUNCTION_GRAPH() }) });
  // `head`: the exec output the readers of the node's outputs follow.
  let head: { node: string; port: string } | null = null;
  if (def.type.startsWith('event.')) {
    // An event, followed by a Log so its flow is compiled too.
    nodes.push({ id: 'after', type: 'debug.log', position: [600, 0] });
    edges.push({ id: 'e-then', from: { node: 'subject', port: 'then' }, to: { node: 'after', port: 'in' } });
    head = { node: 'after', port: 'then' };
  } else if (def.inputs.some((p) => p.type === 'exec')) {
    nodes.push({ id: 'ev', type: 'event.step', position: [0, 0], data: { phase: spec?.phase ?? 'intent' } });
    edges.push({ id: 'e-in', from: { node: 'ev', port: 'then' }, to: { node: 'subject', port: 'in' } });
    const execOut = ports.outputs.find((x) => x.type === 'exec');
    head = execOut !== undefined ? { node: 'subject', port: execOut.id } : null;
  }
  // Store every data output in a local variable of its type (so the node is read).
  const outs = ports.outputs.filter((p) => p.type !== 'exec' && VAR_FOR[p.type] !== undefined);
  if (outs.length > 0 && head === null) {
    nodes.push({ id: 'reader', type: 'event.step', position: [0, 400], data: { phase: spec?.phase ?? 'intent' } });
    head = { node: 'reader', port: 'then' };
  }
  outs.forEach((p, i) => {
    const vname = `out_${i}`;
    nodes.push({ id: `decl-${i}`, type: VAR_FOR[p.type]!, position: [0, -400 + i * 40], data: { name: vname, visibility: 'local' } });
    nodes.push({ id: `set-${i}`, type: 'var.set', position: [700, 100 * i], data: { variable: vname } });
    edges.push({ id: `o-${i}`, from: { node: 'subject', port: p.id }, to: { node: `set-${i}`, port: 'value' } });
    edges.push({ id: `x-${i}`, from: head!, to: { node: `set-${i}`, port: 'in' } });
    head = { node: `set-${i}`, port: 'then' };
  });
  return { nodes, edges };
}

async function run(graph: GraphData, steps = 3): Promise<{ calls: string[]; error: unknown }> {
  const r = await compileBehaviorGraph(compiler, { behaviorId: 'script', graph, env: ENV, limits: { timeoutMs: 30_000 } });
  if (!r.ok) throw new Error(JSON.stringify(r.failure.diagnostics));
  const spec = evaluate(r.result.outputBytes);
  const calls: string[] = [];
  const state = spec.instantiate(undefined, { entityId: 'box-1', properties: { v: 1 } });
  try {
    for (let i = 1; i <= steps; i++) {
      for (const phase of ['intent', 'transform'] as const) spec.step(state, recordingContext(calls, phase, i));
    }
  } catch (e) {
    return { calls, error: e };
  }
  return { calls, error: null };
}

const CATALOGUE = [...BEHAVIOR_GRAPH_KIND.nodes.filter((d) => !d.type.startsWith('var.') || d.type === 'var.get' || d.type === 'var.set'), ...BEHAVIOR_GRAPH_KIND.nodes.filter((d) => /^var\.(number|boolean|string|vector|entity|enum|list|map)$/.test(d.type))];

describe('the visual-script catalogue (every node type compiles and runs)', () => {
  it('covers every ctx member of the runtime typings (generated), except the documented skips', () => {
    const members = new Set(BEHAVIOR_API_NODES.map(memberOf));
    for (const m of ['game.add', 'game.counter', 'game.health', 'game.setVisible', 'signals.emit', 'signals.on', 'messages.send', 'messages.received', 'timers.after', 'timers.every', 'timers.fired', 'timers.cancel', 'physics.raycast', 'physics.overlapBox', 'physics.overlapCircle', 'physics.characterResult', 'tags.mask', 'tags.has', 'tags.query', 'tags.of', 'world.transform', 'world.find', 'world.findAll', 'world.withComponent', 'random.next', 'random.range', 'random.int', 'random.chance', 'random.stream.next', 'random.stream.range', 'random.stream.int', 'random.stream.chance', 'scenes.load', 'scenes.unload', 'scenes.status', 'scenes.loaded', 'input.pressed', 'input.released', 'input.held', 'input.value', 'input.vector', 'animator.set', 'animator.trigger', 'animator.get', 'animator.state', 'audio.play', 'save.get', 'save.set', 'save.remove', 'save.keys', 'spawn', 'destroy', 'emit', 'entityId', 'stepIndex']) {
      expect(members, m).toContain(m);
    }
    // Phase 23.7: pick (a list's random item is Seeded random integer + Get item) and the
    // script-only rotation forms of the intents (the nodes keep their inputs).
    // Phase 23.8: debug commands are declared and received in code (a typed spec, an optional handler).
    expect(BEHAVIOR_API_SKIPPED.map((s) => s.path).sort()).toEqual([
      'action.commands',
      // Phase 23.9a: a frame's UI events are read with ctx.ui.events / ctx.ui.event.
      'action.ui',
      'debug.command',
      // Phase 23.2: control_move's second axis is script-only (the node keeps its one input).
      'emit(control_move).y',
      'emit(pose).facing',
      'emit(pose).quaternion',
      'emit(pose).up',
      'emit(transform).facing',
      'emit(transform).quaternion',
      'emit(transform).up',
      'events',
      // Phase 23.5: the grid's change list and save diff are read as data by scripts.
      'grid.applyDiff',
      'grid.changes',
      'grid.diff',
      'log',
      'physics.stageCharacterMove',
      'random.pick',
      'random.stream().pick',
    ]);
    // Intents: one node per kind, with its phase.
    const emit = BEHAVIOR_API_NODES.filter((s) => s.type.startsWith('api.emit.'));
    expect(emit.map((s) => [s.type, s.phase])).toEqual([
      ['api.emit.control_move', 'intent'],
      ['api.emit.control_jump', 'intent'],
      ['api.emit.transform', 'transform'],
      ['api.emit.pose', 'transform'],
      ['api.emit.respawn', 'intent'],
      // Phase 23.2: the 3D character intents.
      ['api.emit.character_move', 'intent'],
      ['api.emit.character_place', 'intent'],
      ['api.emit.character_enable', 'intent'],
    ]);
  });

  for (const def of CATALOGUE) {
    it(`${def.type} (${def.label})`, async () => {
      const graph = scriptFor(def);
      const { calls, error } = await run(graph);
      expect(error, String((error as Error | null)?.stack ?? '')).toBeNull();
      const spec = BEHAVIOR_API_NODES.find((s) => s.type === def.type);
      // A call node called its ctx member (a value node only reads a property).
      if (spec !== undefined && spec.access.some((s) => 'call' in s)) expect(calls, memberOf(spec)).toContain(memberOf(spec));
    });
  }
});
