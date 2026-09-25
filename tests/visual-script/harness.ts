/**
 * Phase 19.0/19.1: the test harness of visual scripts in the running game —
 * the one compiler, a bounded `node:vm` evaluator (no code generation, as in
 * tests/browser/m2-behaviors/behavior-host.test.ts) and a neutral level in
 * the production composition (game host, platformer controller, Rapier):
 * a floor, the player walking right, a marker box carrying the script.
 */
import { createContext, runInContext, Script } from 'node:vm';

import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { createBehaviorModuleSpec } from '@thirdlight/runtime';
import type { BehaviorScriptEnv, GraphData, GraphNode } from '@thirdlight/project-model';

import { canonicalContainerText, compileBehaviorGraph, createBehaviorCompiler, type BehaviorCompileResult } from '../../packages/behavior-build/src/index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;
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

export function evaluate(outputBytes: Uint8Array): unknown {
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

export type Compiled = Extract<BehaviorCompileResult, { ok: true }>;

export async function compileGraph(graph: GraphData, env?: BehaviorScriptEnv): Promise<Compiled> {
  const r = await compileBehaviorGraph(compiler, { behaviorId: 'director', graph, ...(env !== undefined ? { env } : {}), limits: { timeoutMs: 30_000 } });
  if (!r.ok) throw new Error(JSON.stringify(r.failure));
  return r.result;
}
export async function compileTs(text: string, ownedTransforms: string[] = []): Promise<Compiled> {
  const bytes = new TextEncoder().encode(canonicalContainerText({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms, files: [{ path: 'src/index.ts', text }] }));
  const r = await compiler.compile({ behaviorId: 'director', declaration: { properties: [] }, containerBytes: bytes, pinnedModules: compiler.pinnedModules, limits: { timeoutMs: 30_000 } });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r;
}

export interface LevelOptions {
  /** Where the box carrying the script stands (default: below the floor, out of the way). */
  director?: [number, number, number];
  /** More components of that box (e.g. a trigger it owns). */
  directorComponents?: Record<string, unknown>;
  /** Property values of the script on the box. */
  values?: Record<string, unknown>;
  /** More entities. */
  entities?: Any[];
}

/** A neutral level: a floor, the player walking right, a marker box carrying the compiled script. */
export async function level(compiled: Compiled, opts: LevelOptions = {}) {
  const d = opts.director ?? [0, -5, 0];
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
    { id: 'player-0001', components: { transform: at(0, 0.91), controller: {} } },
    { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(10, -0.5), box: { size: [60, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 30, hy: 0.5 } } } },
    { id: 'goal-0001', components: { transform: at(38, 1), gameZone: { role: 'goal', size: [1, 2] } } },
    { id: 'box-director', components: { transform: at(d[0], d[1], d[2]), box: { size: [0.2, 0.2, 0.2], material: { color: '#ffffff' } }, behavior: { behaviorId: 'director', values: opts.values ?? {} }, ...(opts.directorComponents ?? {}) } },
    ...(opts.entities ?? []),
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
  /** One step; its trace line (counters, log count, player x, failed, the script box's position), or the failure. */
  const tick = (): string => {
    now += DT;
    const r = rt.tick(now);
    if (!r.ok) return `tick failed: ${JSON.stringify(r.error)}`;
    const dg = rt.getDiagnostics().diagnostics;
    const transforms = rt.getInterpolatedState().state.transforms;
    const x = transforms.find((t: Any) => t.id === 'player-0001').position[0];
    const box = transforms.find((t: Any) => t.id === 'box-director')?.position ?? [];
    return JSON.stringify([rt.gameCounters().counters, dg.logCount, Math.round(x * 1e6), dg.failed === true, box.map((v: number) => Math.round(v * 1e6))]);
  };
  return { rt, tick };
}

/** Settle, start, 60 steps, replay, 60 steps: the trace of every step. */
export async function trace(compiled: Compiled, opts: LevelOptions = {}, steps = 60): Promise<string[]> {
  const L = await level(compiled, opts);
  const out: string[] = [L.tick()];
  if (!L.rt.gameCommand('start').ok) throw new Error('start refused');
  for (let i = 0; i < steps; i++) out.push(L.tick());
  if (!L.rt.gameCommand('replay').ok) throw new Error('replay refused');
  for (let i = 0; i < steps; i++) out.push(L.tick());
  return out;
}

export const node = (id: string, type: string, data?: GraphNode['data'], position: [number, number] = [0, 0]): GraphNode => ({ id, type, position, ...(data !== undefined ? { data } : {}) });
export const wire = (id: string, a: string, ap: string, b: string, bp: string) => ({ id, from: { node: a, port: ap }, to: { node: b, port: bp } });
