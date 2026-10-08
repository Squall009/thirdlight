/**
 * Every node of the visual-script catalogue compiles and runs.
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
      // The 3D character's state.
      characterState: rec('physics.characterState', { position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 2 }, grounded: true, contacts: { ground: true, wall: false, head: false, steepSlope: false }, supportNormal: { x: 0, y: 1, z: 0 }, groundEntityId: null, enabled: true, climbing: false, facing: 0 }),
      // 3D queries.
      raycast3d: rec('physics.raycast3d', { entityId: 'box-1', point: [0, 1, 0], normal: [0, 1, 0], distance: 4 }),
      overlapSphere: rec('physics.overlapSphere', () => ['crate-1']),
      overlapBox3d: rec('physics.overlapBox3d', () => ['crate-1']),
      overlapCapsule: rec('physics.overlapCapsule', () => ['crate-1']),
      pickAt: rec('physics.pickAt', { entityId: 'box-1', point: [0, 1, 0], normal: [0, 1, 0], distance: 4 }),
      pickAtPointer: rec('physics.pickAtPointer', { entityId: 'box-1', point: [0, 1, 0], normal: [0, 1, 0], distance: 4 }),
    },
    tags: { mask: rec('tags.mask', 1), of: rec('tags.of', 1), has: rec('tags.has', true), query: rec('tags.query', () => ['box-1']) },
    world: { transform: rec('world.transform', { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), worldTransform: rec('world.worldTransform', { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), find: rec('world.find', 'box-2'), findAll: rec('world.findAll', () => ['box-2']), withComponent: rec('world.withComponent', () => ['box-2']) },
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
    scenes: { load: rec('scenes.load'), unload: rec('scenes.unload'), reload: rec('scenes.reload'), status: rec('scenes.status', 'loaded'), loaded: rec('scenes.loaded', () => ['scene-main']), loading: rec('scenes.loading', () => []), transition: rec('scenes.transition', null), active: rec('scenes.active', 'scene-main'), setActive: rec('scenes.setActive') },
    input: { value: rec('input.value', 1), vector: rec('input.vector', () => [1, 0]), pressed: rec('input.pressed', true), released: rec('input.released', true), held: rec('input.held', true), pointer: rec('input.pointer', () => ({ x: 0.5, y: 0.5, dx: 0, dy: 0, wheel: 0, over: true, entered: false, left: false, locked: false })), pointerPressed: rec('input.pointerPressed', true), pointerReleased: rec('input.pointerReleased', false), pointerHeld: rec('input.pointerHeld', true), anyPressed: rec('input.anyPressed', () => ({ device: 'keyboard', code: 'KeyK' })), setCursor: rec('input.setCursor'), usingGamepad: rec('input.usingGamepad', true), glyphLabel: rec('input.glyphLabel', 'A'), glyphIcon: rec('input.glyphIcon', 'pad-south'), rebinding: rec('input.rebinding', () => ({ action: 'jump', index: 0 })), cancelRebind: rec('input.cancelRebind'), resetBindings: rec('input.resetBindings'), useBindingProfile: rec('input.useBindingProfile'), bindingProfile: rec('input.bindingProfile', 'default') },
    animator: (id: string) => {
      calls.push('animator');
      // Per-instance speed and morph weights.
      return id === '' ? null : { set: rec('animator.set', true), trigger: rec('animator.trigger', true), get: rec('animator.get', 1), state: rec('animator.state', 'idle'), play: rec('animator.play', true), setLookTarget: rec('animator.setLookTarget', true), setLookPoint: rec('animator.setLookPoint', true), setLookWeight: rec('animator.setLookWeight', true), setSpeed: rec('animator.setSpeed', true), speed: rec('animator.speed', 1), setMorph: rec('animator.setMorph', true), morph: rec('animator.morph', 0.5) };
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
    // The generic primitives.
    health: { get: rec('health.get', { current: 2, max: 3 }), damage: rec('health.damage', true), heal: rec('health.heal', true), events: rec('health.events', []) },
    patrol: { get: rec('patrol.get', { direction: [1, 0, 0], active: true }), setActive: rec('patrol.setActive', true), turn: rec('patrol.turn', true) },
    hitbox: { setActive: rec('hitbox.setActive', true), touching: rec('hitbox.touching', ['box-2']) },
    collectible: { collected: rec('collectible.collected', false), restore: rec('collectible.restore', true) },
    // The character's impulse and the look overrides.
    character: { impulse: rec('character.impulse', true) },
    look: { set: rec('look.set', true), clear: rec('look.clear', true), get: rec('look.get', { emissive: '#ff0000', emissiveIntensity: 1 }) },
    // Playback handles, music, duck, bus mix.
    audio: {
      play: rec('audio.play', 1),
      stop: rec('audio.stop'),
      fade: rec('audio.fade'),
      setVolume: rec('audio.setVolume'),
      setPitch: rec('audio.setPitch'),
      setLoop: rec('audio.setLoop'),
      playing: rec('audio.playing', true),
      volumeOf: rec('audio.volumeOf', 0.5),
      finished: rec('audio.finished', false),
      events: rec('audio.events', () => []),
      music: rec('audio.music'),
      releaseMusic: rec('audio.releaseMusic'),
      stinger: rec('audio.stinger', 2),
      duck: rec('audio.duck'),
      unduck: rec('audio.unduck'),
      musicState: rec('audio.musicState', () => ({ owner: 'flow', track: null, duck: 1 })),
      setBusVolume: rec('audio.setBusVolume'),
      busVolume: rec('audio.busVolume', 1),
      stopAll: rec('audio.stopAll', 0),
    },
    effects: { play: (...a: unknown[]) => { rec('effects.play')(...a); return 1; }, stop: rec('effects.stop') },
    save: { get: rec('save.get', 4), set: rec('save.set', true), remove: rec('save.remove'), keys: rec('save.keys', () => ['k']) },
    // Block layers.
    grid: {
      layers: rec('grid.layers', () => ['layer-1']),
      get: rec('grid.get', { block: 'stone', rot: 0, variant: 0, meta: { walkable: true } }),
      set: rec('grid.set', true),
      clear: rec('grid.clear', true),
      columnTop: rec('grid.columnTop', 2),
      surface: rec('grid.surface', { layer: 'layer-1', x: 0, y: 1, z: 0, height: 2, point: { x: 0.5, y: 2, z: 0.5 }, normal: { x: 0, y: 1, z: 0 }, slope: 0, walkable: true }),
      columnSurface: rec('grid.columnSurface', { layer: 'layer-1', x: 0, y: 1, z: 0, height: 2, point: { x: 0.5, y: 2, z: 0.5 }, normal: { x: 0, y: 1, z: 0 }, slope: 0, walkable: true }),
      worldToCell: rec('grid.worldToCell', { x: 1, y: 2, z: 3 }),
      cellToWorld: rec('grid.cellToWorld', { x: 1.5, y: 2.5, z: 3.5 }),
      meta: rec('grid.meta', true),
      setMeta: rec('grid.setMeta', true),
      pick: rec('grid.pick', { layer: 'layer-1', x: 1, y: 0, z: 2, normal: { x: 0, y: 1, z: 0 }, distance: 3, point: { x: 1.5, y: 0.5, z: 2.5 } }),
      neighbours: rec('grid.neighbours', () => [{ x: 1, y: 0, z: 0 }]),
      walkNeighbours: rec('grid.walkNeighbours', () => [{ x: 1, y: 0, z: 0, point: { x: 1.5, y: 1, z: 0.5 }, cost: 1 }]),
      path: rec('grid.path', () => [{ x: 0, y: 0, z: 0, point: { x: 0.5, y: 1, z: 0.5 }, cost: 0 }, { x: 1, y: 0, z: 0, point: { x: 1.5, y: 1, z: 0.5 }, cost: 1 }]),
      reachable: rec('grid.reachable', () => [{ x: 0, y: 0, z: 0, point: { x: 0.5, y: 1, z: 0.5 }, cost: 0 }]),
      regions: rec('grid.regions', () => ['zone.a']),
      region: rec('grid.region', () => [{ x: 0, y: 0, z: 0 }]),
      inRegion: rec('grid.inRegion', true),
      setCutaway: rec('grid.setCutaway', true),
      setCutawaySubject: rec('grid.setCutawaySubject', true),
      setCutawayPoint: rec('grid.setCutawayPoint', true),
      setKit: rec('grid.setKit', true),
      kit: rec('grid.kit', 'burnt'),
      setArchitecturePreset: rec('grid.setArchitecturePreset', true),
      architecturePreset: rec('grid.architecturePreset', 'starter-hall'),
      doorLinks: rec('grid.doorLinks', []),
      doorLink: rec('grid.doorLink', null),
      entity: rec('grid.entity', 'layer-1-1_0_2'),
      cellOf: rec('grid.cellOf', { layer: 'layer-1', x: 1, y: 0, z: 2 }),
      edge: rec('grid.edge', { block: 'door', rot: 0, variant: 0, open: false, blocked: true }),
      blocked: rec('grid.blocked', true),
      setEdge: rec('grid.setEdge', true),
      clearEdge: rec('grid.clearEdge', true),
      setEdgeOpen: rec('grid.setEdgeOpen', true),
      edgeEntity: rec('grid.edgeEntity', 'layer-1-1_0_2x'),
      changes: rec('grid.changes', () => []),
      diff: rec('grid.diff', { version: 1, layers: [] }),
      applyDiff: rec('grid.applyDiff', true),
    },
    scatter: {
      near: rec('scatter.near', () => [{ address: 'ground#scatter:trees:1,2', source: 'ground', rule: 'trees', cell: [1, 2], position: [1, 0, 2], rotation: [0, 0, 0, 1], scale: 1, hidden: false }]),
      get: rec('scatter.get', { address: 'ground#scatter:trees:1,2', source: 'ground', rule: 'trees', cell: [1, 2], position: [1, 0, 2], rotation: [0, 0, 0, 1], scale: 1, hidden: false }),
      hide: rec('scatter.hide', true),
      show: rec('scatter.show', true),
      remove: rec('scatter.remove', true),
      changed: rec('scatter.changed', () => []),
    },
    splines: {
      length: rec('splines.length', 40),
      at: rec('splines.at', { distance: 4, position: [4, 0, 0], tangent: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0], width: 4, roll: 0 }),
      nearest: rec('splines.nearest', { distance: 4, position: [4, 0, 0], offset: 1 }),
    },
    surface: {
      at: rec('surface.at', { source: 'terrain', object: 'ground', height: 2, point: [1, 2, 3], normal: [0, 1, 0], slope: 0, layers: [1, 0], weights: [0.75, 0.25], wetness: 0 }),
      top: rec('surface.top', { source: 'blocks', object: 'yard', height: 3, point: [1, 3, 3], normal: [0, 1, 0], slope: 0, layers: [2], weights: [1], wetness: 0.5, cell: [1, 2, 3], block: 'stone' }),
    },
    spawn: rec('spawn', 'spawn-1'),
    destroy: rec('destroy', true),
    emit: rec('emit'),
    log: rec('log'),
    // The virtual cameras.
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
    // Sockets.
    sockets: {
      attach: rec('sockets.attach', true),
      detach: rec('sockets.detach', true),
      attachedTo: rec('sockets.attachedTo', () => ({ target: 'box-2', nodeName: 'hand' })),
      nodePose: rec('sockets.nodePose', () => ({ position: [1, 2, 3], rotation: [0, 0, 0, 1] })),
    },
    // Graph-material parameters per object.
    materials: {
      set: rec('materials.set', true),
      get: rec('materials.get', '#ff0000'),
      reset: rec('materials.reset', true),
      setData: rec('materials.setData', true),
      getData: rec('materials.getData', () => [255, 0, 0, 255]),
    },
    // Project saves.
    saves: {
      version: 2,
      slotCount: 3,
      write: rec('saves.write', true),
      read: rec('saves.read', () => ({ chapter: 1 })),
      save: rec('saves.save', true),
      load: rec('saves.load', true),
      delete: rec('saves.delete', true),
      slots: rec('saves.slots', () => [{ slot: 2, title: 'T', chapter: '', location: '', playSeconds: 1, savedAt: '', version: 2, bytes: 1, thumbnail: false }]),
      ready: rec('saves.ready', true),
      results: rec('saves.results', () => []),
      storage: rec('saves.storage', () => ({ persisted: true, usage: 1024, quota: 1_000_000 })),
      playSeconds: rec('saves.playSeconds', 12),
      migration: rec('saves.migration', true),
      setting: rec('saves.setting', true),
      settings: rec('saves.settings', () => ({ hints: true })),
      setSetting: rec('saves.setSetting', true),
    },
    // The project UI.
    ui: {
      set: rec('ui.set', true),
      get: rec('ui.get', 7),
      clear: rec('ui.clear', true),
      show: rec('ui.show', true),
      hide: rec('ui.hide', true),
      isShown: rec('ui.isShown', true),
      play: rec('ui.play', true),
      focus: rec('ui.focus', true),
      view: rec('ui.view', { width: 1280, height: 720, aspect: 16 / 9, pixelRatio: 1 }),
      events: rec('ui.events', () => [{ kind: 'click', doc: 'hud', widget: 'buy', name: 'buy', value: 1 }]),
      event: rec('ui.event', () => ({ kind: 'click', doc: 'hud', widget: 'buy', name: 'buy', value: 1 })),
    },
    // conversations.
    dialogue: {
      start: rec('dialogue.start', 1),
      stop: rec('dialogue.stop', true),
      isRunning: rec('dialogue.isRunning', true),
      current: rec('dialogue.current', () => ({ conversation: 1, dialogueId: 'talk', node: 'l1', kind: 'line', speaker: 'guide', text: 'Hi', revealed: 1, total: 2, options: [] })),
      advance: rec('dialogue.advance', true),
      choose: rec('dialogue.choose', true),
      resume: rec('dialogue.resume', true),
      setSkip: rec('dialogue.setSkip', undefined),
      setAuto: rec('dialogue.setAuto', undefined),
      setTextSpeed: rec('dialogue.setTextSpeed', undefined),
      events: rec('dialogue.events', () => [{ kind: 'lineStart', conversation: 1, dialogueId: 'talk', node: 'l1', speaker: 'guide', text: 'Hi', name: '', value: '', index: -1 }]),
      event: rec('dialogue.event', () => ({ kind: 'signal', conversation: 1, dialogueId: 'talk', node: 's', speaker: '', text: '', name: 'cue', value: 'x', index: -1 })),
      get: rec('dialogue.get', 3),
      set: rec('dialogue.set', true),
      variables: rec('dialogue.variables', () => ({ a: 1 })),
      seen: rec('dialogue.seen', true),
      history: rec('dialogue.history', () => []),
    },
    // The game modes and the run lifecycle.
    modes: {
      current: rec('modes.current', 'explore'),
      previous: rec('modes.previous', ''),
      is: rec('modes.is', true),
      switch: rec('modes.switch', true),
      events: rec('modes.events', () => [{ kind: 'enter', mode: 'explore', other: '' }]),
      entered: rec('modes.entered', true),
      exited: rec('modes.exited', false),
      time: rec('modes.time', 1.5),
    },
    lifecycle: {
      respawn: rec('lifecycle.respawn', true),
      setSpawn: rec('lifecycle.setSpawn', true),
      spawnPoint: rec('lifecycle.spawnPoint', 'spawn-0001'),
      restart: rec('lifecycle.restart', true),
    },
    // timelines.
    timeline: {
      play: rec('timeline.play', 1),
      pause: rec('timeline.pause', true),
      resume: rec('timeline.resume', true),
      stop: rec('timeline.stop', true),
      skip: rec('timeline.skip', true),
      seek: rec('timeline.seek', true),
      state: rec('timeline.state', 'playing'),
      time: rec('timeline.time', 1.5),
      isPlaying: rec('timeline.isPlaying', true),
      events: rec('timeline.events', () => []),
      ended: rec('timeline.ended', false),
      marker: rec('timeline.marker', true),
    },
    // Asset handles.
    assets: {
      load: rec('assets.load', 1),
      release: rec('assets.release', true),
      state: rec('assets.state', 'ready'),
      ready: rec('assets.ready', true),
      ids: rec('assets.ids', () => ['tex-a']),
      error: rec('assets.error', ''),
    },
    // Environment presets.
    environment: {
      set: rec('environment.set', true),
      blend: rec('environment.blend', true),
      state: rec('environment.state', () => ({ target: 'night', progress: 0.5, blending: true })),
      weight: rec('environment.weight', 0.5),
      presets: rec('environment.presets', () => ['day', 'night']),
    },
    // Generic component access (a handle per object) and the shell's scene list.
    entity: (id: string) => {
      calls.push('entity');
      return id === '' ? null : { get: rec('entity.get', () => ({ intensity: 2 })), set: rec('entity.set', () => ({ ok: true, field: '', code: '', message: '' })) };
    },
    shell: { nextScene: rec('shell.nextScene', true), sceneIndex: rec('shell.sceneIndex', 0), sceneCount: rec('shell.sceneCount', 2) },
    // The frame-rate cap.
    display: { frameRateCap: 60, setFrameRateCap: rec('display.setFrameRateCap', true) },
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

/** A sample event per callback (undefined: a lifecycle callback without one). */
const CALLBACK_SAMPLES: readonly [string, unknown][] = [
  ['onEnable', undefined],
  ['onDisable', undefined],
  ['onDestroy', undefined],
  ['onContact', { type: 'contact', entity: 'box-1', other: 'crate-1', normal: [1, 0, 0], stepIndex: 1 }],
  ['onUiEvent', { kind: 'click', doc: 'hud', widget: 'go', name: 'go', value: 3 }],
];

async function run(graph: GraphData, steps = 3): Promise<{ calls: string[]; error: unknown }> {
  const r = await compileBehaviorGraph(compiler, { behaviorId: 'script', graph, env: ENV, limits: { timeoutMs: 30_000 } });
  if (!r.ok) throw new Error(JSON.stringify(r.failure.diagnostics));
  const spec = evaluate(r.result.outputBytes);
  const calls: string[] = [];
  const state = spec.instantiate(undefined, { entityId: 'box-1', properties: { v: 1 } });
  try {
    for (let i = 1; i <= steps; i++) {
      // The callbacks a script has run in the intent phase, before its step.
      for (const [cb, ev] of CALLBACK_SAMPLES) if (typeof spec[cb] === 'function') (ev === undefined ? spec[cb](state, recordingContext(calls, 'intent', i)) : spec[cb](state, ev, recordingContext(calls, 'intent', i)));
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
    for (const m of ['game.add', 'game.counter', 'game.health', 'game.setVisible', 'signals.emit', 'signals.on', 'messages.send', 'messages.received', 'timers.after', 'timers.every', 'timers.fired', 'timers.cancel', 'physics.raycast', 'physics.overlapBox', 'physics.overlapCircle', 'physics.characterResult', 'tags.mask', 'tags.has', 'tags.query', 'tags.of', 'world.transform', 'world.find', 'world.findAll', 'world.withComponent', 'random.next', 'random.range', 'random.int', 'random.chance', 'random.stream.next', 'random.stream.range', 'random.stream.int', 'random.stream.chance', 'scenes.load', 'scenes.unload', 'scenes.reload', 'scenes.status', 'scenes.loaded', 'scenes.loading', 'scenes.transition', 'scenes.active', 'scenes.setActive', 'input.pressed', 'input.released', 'input.held', 'input.value', 'input.vector', 'animator.set', 'animator.trigger', 'animator.get', 'animator.state', 'audio.play', 'audio.stop', 'audio.fade', 'audio.setPitch', 'audio.finished', 'audio.music', 'audio.stinger', 'audio.duck', 'save.get', 'save.set', 'save.remove', 'save.keys', 'spawn', 'destroy', 'emit', 'entityId', 'stepIndex']) {
      expect(members, m).toContain(m);
    }
    // Pick (a list's random item is Seeded random integer + Get item) and the
    // script-only rotation forms of the intents (the nodes keep their inputs).
    // Debug commands are declared and received in code (a typed spec, an optional handler).
    // The bindings list, the device record, the glyph object, rebind (an options object) and its events are read in code.
    expect(BEHAVIOR_API_SKIPPED.map((s) => s.path).sort()).toEqual([
      // The answers to asset loads arrive with the input (scripts read a handle with ctx.assets.state).
      'action.assets',
      'action.commands',
      // A frame's dialogue inputs (scripts drive conversations with ctx.dialogue); the variable map and the backlog records are read in code.
      'action.dialogue',
      'action.input',
      // The first key or pad button of a step is read with ctx.input.anyPressed.
      'action.press',
      // storage's answers arrive with the input; a migration is a function.
      'action.saves',
      // A frame's UI events are read with ctx.ui.events / ctx.ui.event.
      'action.ui',
      // The ids a handle loaded, as a list (Assets ready says when they are there).
      'assets.ids',
      // The finished events as a list (the Sound finished node checks one handle).
      'audio.events',
      'debug.command',
      'dialogue.history',
      'dialogue.variables',
      // A player controller intent's object is script-only (a node drives the first player controller).
      'emit(character_enable).entityId',
      'emit(character_move).entityId',
      'emit(character_place).entityId',
      'emit(control_jump).entityId',
      // control_move's second axis is script-only (the node keeps its one input).
      'emit(control_move).entityId',
      'emit(control_move).y',
      'emit(pose).facing',
      'emit(pose).quaternion',
      'emit(pose).up',
      'emit(respawn).entityId',
      'emit(transform).facing',
      'emit(transform).quaternion',
      'emit(transform).up',
      'events',
      // The grid's change list and save diff are read as data by scripts.
      'grid.applyDiff',
      'grid.changes',
      'grid.diff',
      // The door links are a list scripts walk (graphs take the nearest).
      'grid.doorLinks',
      // A block type's slot map is written and read in code.
      'grid.setTypeMaterials',
      'grid.typeMaterials',
      'input.bindings',
      'input.device',
      'input.glyph',
      'input.rebind',
      'input.rebindEvents',
      'log',
      'physics.stageCharacterMove',
      'random.pick',
      'random.stream().pick',
      'saves.migration',
      // The scatter copies scripts hid or removed are read as data (a save keeps them).
      'scatter.changed',
      // The timeline events as a list (Timeline ended / marker check one).
      'timeline.events',
    ]);
    // Intents: one node per kind, with its phase.
    const emit = BEHAVIOR_API_NODES.filter((s) => s.type.startsWith('api.emit.'));
    expect(emit.map((s) => [s.type, s.phase])).toEqual([
      ['api.emit.control_move', 'intent'],
      ['api.emit.control_jump', 'intent'],
      ['api.emit.transform', 'transform'],
      ['api.emit.pose', 'transform'],
      ['api.emit.respawn', 'intent'],
      // The 3D character intents.
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
