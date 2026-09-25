/**
 * Phase 19.0: visual scripts run like TypeScript behaviors — compiled by the
 * one compiler, executed by the real behavior host inside the production
 * composition (game host, platformer controller, Rapier), with neutral
 * fixtures.
 *
 * - Determinism: a graph and the hand-written equivalent TypeScript give the
 *   same per-step trace (counters, log count, the player's position) over a
 *   run, a replay and a second run of the graph.
 * - Every run starts fresh: On start runs again after a replay (the behavior
 *   host re-instantiates script state at the start of each run).
 * - The loop bound: a runaway For loop is a script error naming its node
 *   (`nodeId`, detail `iteration_cap`) in the runtime diagnostics.
 *
 * The compiled module is evaluated in a bounded `node:vm` context (no code
 * generation), as in tests/browser/m2-behaviors/behavior-host.test.ts.
 */
import { createContext, runInContext, Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { createBehaviorModuleSpec } from '@thirdlight/runtime';
import type { GraphData, GraphNode } from '@thirdlight/project-model';

import { canonicalContainerText, compileBehaviorGraph, createBehaviorCompiler, type BehaviorCompileResult } from '../../packages/behavior-build/src/index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const compiler = createBehaviorCompiler();

class FakeNode {
  textContent = '';
  children: Any[] = [];
  appendChild(c: Any): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function evaluate(outputBytes: Uint8Array): unknown {
  const source = new TextDecoder().decode(outputBytes);
  // The module ends with one export list (`export { properties, x as default };`).
  const match = /export\s*\{([^}]*)\};?\s*$/.exec(source);
  const def = match !== null ? /([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+default/.exec(match[1]!) : null;
  if (match === null || def === null) throw new Error('the compiled artifact has no default export');
  const body = `${source.slice(0, match.index)}globalThis.__artifact = ${def[1]};`;
  const context = createContext({}, { name: 'visual-script', codeGeneration: { strings: false, wasm: false } });
  new Script(body, { filename: 'behavior-output.js' }).runInContext(context, { timeout: 1000 });
  return runInContext('globalThis.__artifact', context, { timeout: 1000 });
}

type Compiled = Extract<BehaviorCompileResult, { ok: true }>;

async function compileGraph(graph: GraphData): Promise<Compiled> {
  const r = await compileBehaviorGraph(compiler, { behaviorId: 'director', graph, limits: { timeoutMs: 30_000 } });
  if (!r.ok) throw new Error(JSON.stringify(r.failure));
  return r.result;
}
async function compileTs(text: string): Promise<Compiled> {
  const bytes = new TextEncoder().encode(canonicalContainerText({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text }] }));
  const r = await compiler.compile({ behaviorId: 'director', declaration: { properties: [] }, containerBytes: bytes, pinnedModules: compiler.pinnedModules, limits: { timeoutMs: 30_000 } });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r;
}

/** A neutral level: a floor, the player walking right, a marker box carrying the compiled script. */
async function level(compiled: Compiled) {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
    { id: 'player-0001', components: { transform: at(0, 0.91), controller: {} } },
    { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(10, -0.5), box: { size: [60, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 30, hy: 0.5 } } } },
    { id: 'goal-0001', components: { transform: at(38, 1), gameZone: { role: 'goal', size: [1, 2] } } },
    { id: 'box-director', components: { transform: at(0, -5), box: { size: [0.2, 0.2, 0.2], material: { color: '#ffffff' } }, behavior: { behaviorId: 'director', values: {} } } },
  ];
  const physics = await createPhysicsPort({
    character: { x: 0, y: 0.91 },
    statics: [{ entityId: 'floor-0001', shape: { type: 'box', hx: 30, hy: 0.5 }, position: { x: 10, y: -0.5 }, rotationZ: 0 }],
    solver: { hz: 120, gravityY: SETTINGS.gravity_y },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  } as Any);
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  const m = compiled.manifest;
  const director = createBehaviorModuleSpec({
    declaration: m.declaration as Any,
    artifact: {
      behaviorId: 'director',
      sourceDigest: m.sourceDigest,
      manifestDigest: compiled.manifestDigest,
      outputDigest: compiled.outputDigest,
      ownedTransforms: m.ownedTransforms,
      requiredModules: m.requiredModules,
      enginePins: m.enginePins,
      namespace: { default: evaluate(compiled.outputBytes) },
    },
  });
  const host = createGameHost({
    snapshot: {
      snapshotId: 'visual@r1',
      projectId: 'visual',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
      game: { configVersion: 2, title: 'Visual', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
      prefabs: [],
    },
    settings: SETTINGS,
    physics: physics.port,
    behaviorModules: [director],
    adapter: () => null,
    input: {
      sample: (stepIndex: number) => ({ stepIndex, moveX: 1, jump: 'none' }),
      sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
      markConfirmConsumed: () => undefined,
      dispose: () => undefined,
    },
    audio: createGameAudioOwner({ contextFactory: () => null } as Any),
    readArtifact: async () => new ArrayBuffer(0),
    container: new FakeNode(),
    buildId: 'b',
    assetPaths: {},
    document: { createElement: () => new FakeNode() },
  } as Any);
  const mounted = host.mount();
  if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
  const rt: Any = host.runtime;
  let now = 0;
  /** One step; its trace line (counters, log count, player x), or the failure. */
  const tick = (): string => {
    now += DT;
    const r = rt.tick(now);
    if (!r.ok) return `tick failed: ${JSON.stringify(r.error)}`;
    const d = rt.getDiagnostics().diagnostics;
    const x = rt.getInterpolatedState().state.transforms.find((t: Any) => t.id === 'player-0001').position[0];
    return JSON.stringify([rt.gameCounters().counters, d.logCount, Math.round(x * 1e6), d.failed === true]);
  };
  return { rt, tick };
}

/** Settle, start, 60 steps, replay, 60 steps: the trace of every step. */
async function trace(compiled: Compiled): Promise<string[]> {
  const L = await level(compiled);
  const out: string[] = [L.tick()];
  expect(L.rt.gameCommand('start').ok).toBe(true);
  for (let i = 0; i < 60; i++) out.push(L.tick());
  expect(L.rt.gameCommand('replay').ok).toBe(true);
  for (let i = 0; i < 60; i++) out.push(L.tick());
  return out;
}

const node = (id: string, type: string, data?: GraphNode['data']): GraphNode => ({ id, type, position: [0, 0], ...(data !== undefined ? { data } : {}) });
const wire = (id: string, a: string, ap: string, b: string, bp: string) => ({ id, from: { node: a, port: ap }, to: { node: b, port: bp } });

/**
 * On start: add `amount` coins, emit "go". On step: a sequence of (1) count
 * "heard" when "go" was received, (2) ticks += 1, then "late" once ticks ≥ 5
 * else log the tick count, (3) a For loop 1..3 adding the index to "loops".
 */
const GRAPH: GraphData = {
  nodes: [
    { ...node('amount', 'var.number', { name: 'amount', default: 2 }), position: [0, -300] },
    { ...node('ticks', 'var.number', { name: 'ticks', visibility: 'private' }), position: [0, -200] },
    node('start', 'event.start'),
    node('coins', 'api.game.add', { name: 'coins' }),
    node('get-amount', 'get.number', { variable: 'amount' }),
    node('go', 'api.signals.emit', { name: 'go' }),
    node('step', 'event.step'),
    node('seq', 'flow.sequence'),
    node('heard-branch', 'flow.branch'),
    node('go-on', 'api.signals.on', { name: 'go' }),
    node('heard', 'api.game.add', { name: 'heard' }),
    node('set-ticks', 'set.number', { variable: 'ticks' }),
    node('get-ticks', 'get.number', { variable: 'ticks' }),
    node('plus-one', 'math.add', { b: 1 }),
    node('late-test', 'math.compare', { op: '>=', b: 5 }),
    node('late-branch', 'flow.branch'),
    node('late', 'api.game.add', { name: 'late' }),
    node('log', 'debug.log'),
    node('loop', 'flow.for', { first: 1, last: 3 }),
    node('loops', 'api.game.add', { name: 'loops' }),
  ],
  edges: [
    wire('w1', 'start', 'then', 'coins', 'in'),
    wire('w2', 'get-amount', 'value', 'coins', 'amount'),
    wire('w3', 'coins', 'then', 'go', 'in'),
    wire('w4', 'step', 'then', 'seq', 'in'),
    wire('w5', 'seq', 'then1', 'heard-branch', 'in'),
    wire('w6', 'go-on', 'on', 'heard-branch', 'condition'),
    wire('w7', 'heard-branch', 'true', 'heard', 'in'),
    wire('w8', 'seq', 'then2', 'set-ticks', 'in'),
    wire('w9', 'get-ticks', 'value', 'plus-one', 'a'),
    wire('w10', 'plus-one', 'result', 'set-ticks', 'value'),
    wire('w11', 'set-ticks', 'then', 'late-branch', 'in'),
    wire('w12', 'set-ticks', 'value', 'late-test', 'a'),
    wire('w13', 'late-test', 'result', 'late-branch', 'condition'),
    wire('w14', 'late-branch', 'true', 'late', 'in'),
    wire('w15', 'late-branch', 'false', 'log', 'in'),
    wire('w16', 'get-ticks', 'value', 'log', 'message'),
    wire('w17', 'seq', 'then3', 'loop', 'in'),
    wire('w18', 'loop', 'body', 'loops', 'in'),
    wire('w19', 'loop', 'index', 'loops', 'amount'),
  ],
};

const EQUIVALENT_TS = `
import type { BehaviorContext } from '@thirdlight/runtime';

export const properties = {
  amount: property.number(2),
  ticks: property.private.number(0),
};

type State = { started: boolean; amount: number; ticks: number };

export default {
  instantiate(_p: unknown, inst: { properties: Record<string, any> }): State {
    return { started: false, amount: inst.properties.amount, ticks: inst.properties.ticks };
  },
  step(s: State, ctx: BehaviorContext): void {
    if (ctx.phase !== 'intent') return;
    if (!s.started) {
      s.started = true;
      ctx.game?.add('coins', s.amount);
      ctx.signals?.emit('go');
    }
    if (ctx.signals?.on('go') ?? false) ctx.game?.add('heard', 1);
    s.ticks = s.ticks + 1;
    if (s.ticks >= 5) ctx.game?.add('late', 1);
    else ctx.log('info', String(s.ticks));
    for (let i = 1; i <= 3; i++) ctx.game?.add('loops', i);
  },
};
`;

describe('visual scripts in the running game', () => {
  it('a graph and the equivalent TypeScript give the same replay, step by step', async () => {
    const [graphRun, tsRun, graphAgain] = [await trace(await compileGraph(GRAPH)), await trace(await compileTs(EQUIVALENT_TS)), await trace(await compileGraph(GRAPH))];
    expect(graphRun).toHaveLength(121);
    expect(graphRun).toEqual(tsRun);
    expect(graphRun).toEqual(graphAgain);
    // What the script did: coins once per run start (the amount), loops 1+2+3 per step, late from the 5th step.
    const afterStart = JSON.parse(graphRun[1]!) as [Record<string, number>, number];
    expect(afterStart[0]['coins']).toBe(2);
    expect(afterStart[0]['loops']).toBe(6);
    const endOfRun = JSON.parse(graphRun[60]!) as [Record<string, number>, number, number, boolean];
    expect(endOfRun[0]['loops']).toBe(360);
    expect(endOfRun[0]['late']).toBe(56);
    expect(endOfRun[3]).toBe(false);
    // The replay starts fresh: On start ran again (coins = amount) and the ticks restarted (late counts from 5 again).
    const afterReplay = JSON.parse(graphRun[61]!) as [Record<string, number>];
    expect(afterReplay[0]['coins']).toBe(2);
    expect(afterReplay[0]['late']).toBeUndefined();
    expect(JSON.parse(graphRun[120]!)[0]).toEqual(endOfRun[0]);
  });

  it('a runaway loop is a script error naming the loop node (iteration cap per step)', async () => {
    const compiled = await compileGraph({
      nodes: [{ ...node('v', 'var.number', { name: 'value' }), position: [0, -100] }, node('step', 'event.step'), node('runaway', 'flow.for', { first: 0, last: 1e9 }), node('count', 'api.game.add', { name: 'spins' })],
      edges: [wire('a', 'step', 'then', 'runaway', 'in'), wire('b', 'runaway', 'body', 'count', 'in')],
    });
    const L = await level(compiled);
    const line = L.tick();
    expect(JSON.parse(line)[3]).toBe(true);
    const d = L.rt.getDiagnostics().diagnostics;
    const err = d.errors[d.errors.length - 1];
    expect(err).toMatchObject({ code: 'module_error', reason: 'behavior_step_failed', nodeId: 'runaway', detail: 'iteration_cap' });
    expect(err.message).toContain('10000 iterations');
  });

  it('a bounded loop under the cap runs its whole range in one step', async () => {
    const compiled = await compileGraph({
      nodes: [{ ...node('v', 'var.number', { name: 'value' }), position: [0, -100] }, node('start', 'event.start'), node('loop', 'flow.for', { first: 1, last: 10_000 }), node('count', 'api.game.add', { name: 'spins' })],
      edges: [wire('a', 'start', 'then', 'loop', 'in'), wire('b', 'loop', 'body', 'count', 'in')],
    });
    const L = await level(compiled);
    L.tick();
    expect(L.rt.gameCommand('start').ok).toBe(true);
    const line = JSON.parse(L.tick());
    expect(line[3]).toBe(false);
    expect(line[0]).toEqual({ spins: 10_000 });
  });
});
