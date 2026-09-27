/**
 * Phase 22.0: run a game through the production game host in either
 * threading mode, from Node:
 *
 * - `single`: the page composition — the host composes the runtime with a
 *   Rapier port made here (as Play did before phase 22);
 * - `worker`: the simulation worker — the same game-host worker core the
 *   browser bundles run, in a Node worker_threads Worker (the integration
 *   suites need no browser); the host presents the worker's mirror.
 *
 * Both are driven by a manual clock (`tick(now)`, async in both so a test is
 * written once) and expose the same surfaces: the host, its runtime (real or
 * mirror), the async access (physics queries, script values) and, with
 * `digestSteps`, a digest of every executed step's committed state.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { build } from 'esbuild';

import {
  createGameAudioOwner,
  createGameHost,
  createLocalSimAccess,
  linkBehaviorModules,
  startRemoteSimulation,
  stepDigest,
  type GameHost,
  type ManifestBehaviorRow,
  type SimAccess,
  type SimWorkerHandle,
} from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { createPhysicsPort3D } from '@thirdlight/physics-rapier/3d';
import { createRecordedActionSource, type ActionFrame, type Runtime } from '@thirdlight/runtime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export type Mode = 'single' | 'worker';
export const MODES: readonly Mode[] = ['single', 'worker'];

const HERE = dirname(fileURLToPath(import.meta.url));
let workerCode: Promise<string> | null = null;

/** The Node worker entry, bundled once per test process (kept in memory; no file). */
export function nodeWorkerCode(): Promise<string> {
  workerCode ??= build({
    entryPoints: [join(HERE, 'node-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'error',
  }).then((r) => new TextDecoder().decode(r.outputFiles[0]!.contents));
  return workerCode;
}

/** Start the Node simulation worker (the browser's `createBrowserSimWorker` counterpart). */
export async function startNodeSimWorker(): Promise<SimWorkerHandle> {
  const w = new Worker(await nodeWorkerCode(), { eval: true, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  return {
    post: (message, transfer) => w.postMessage(message, (transfer ?? []) as never),
    listen: (onMessage) => w.on('message', onMessage),
    terminate: () => void w.terminate(),
    onError: (handler) => w.on('error', (e) => handler(e instanceof Error ? e.message : String(e))),
  };
}

export class FakeNode {
  textContent = '';
  children: Any[] = [];
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  appendChild(c: Any): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** A compiled-script stand-in: an ES module source (`export default { instantiate, step }`) as a data: URL. */
export function behaviorModule(behaviorId: string, source: string, declaration: Any = { properties: [] }): { row: ManifestBehaviorRow; url: string } {
  return {
    row: { behaviorId, sourceDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64), declaration, ownedTransforms: [], requiredModules: [], path: behaviorId },
    url: `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
  };
}

export interface HarnessConfig {
  readonly snapshot: Any;
  readonly settings: Any;
  /** The Rapier init config (plain data; the worker makes its own port from it). */
  readonly physics: Any | null;
  /** The live input owner (sampled per step in single mode, per frame in worker mode). */
  readonly input?: Any;
  /** A recorded input (per step) — replayed exactly in both modes. */
  readonly replay?: readonly ActionFrame[];
  readonly behaviors?: readonly { row: ManifestBehaviorRow; url: string }[];
  readonly enginePins?: readonly { id: string; version: string; apiVersion: number }[];
  readonly loadScene?: (sceneId: string) => Promise<Any>;
  readonly digestSteps?: boolean;
  /** Extra host config (flow, audio, …). */
  readonly host?: Record<string, unknown>;
  /** Phase 23.8: script variables injected at the start (ctx.save from step 0), in both modes. */
  readonly variables?: Record<string, unknown>;
}

export interface Harness {
  readonly mode: Mode;
  readonly host: GameHost;
  readonly rt: Runtime & Any;
  readonly access: SimAccess;
  readonly digests: string[];
  /** Sounds the host played (script `ctx.audio`), in order. */
  readonly sounds: string[];
  /** One frame at `now` seconds. */
  tick(now: number): Promise<void>;
  dispose(): Promise<void>;
}

const NEUTRAL_INPUT = {
  sample: (stepIndex: number) => ({ stepIndex, moveX: 0, jump: 'none' }),
  sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
  markConfirmConsumed: () => undefined,
  dispose: () => undefined,
};

export async function startHarness(mode: Mode, cfg: HarnessConfig): Promise<Harness> {
  const rows = (cfg.behaviors ?? []).map((b) => b.row);
  const urls = Object.fromEntries((cfg.behaviors ?? []).map((b) => [b.row.path, b.url]));
  const pins = cfg.enginePins ?? [];
  const recorded = cfg.replay !== undefined ? createRecordedActionSource(cfg.replay) : null;
  const liveInput = cfg.input ?? NEUTRAL_INPUT;
  const hostInput = recorded !== null ? { ...liveInput, sample: (s: number) => recorded.sample(s) } : liveInput;
  const sounds: string[] = [];
  const audio: Any = createGameAudioOwner({ contextFactory: () => null } as Any);
  audio.playSound = (assetId: string) => sounds.push(assetId);
  const baseConfig: Any = {
    snapshot: cfg.snapshot,
    settings: cfg.settings,
    adapter: () => null,
    input: hostInput,
    audio,
    readArtifact: async () => new ArrayBuffer(0),
    container: new FakeNode(),
    buildId: 'b',
    assetPaths: {},
    document: { createElement: () => new FakeNode() },
    ...(cfg.loadScene !== undefined ? { loadScene: cfg.loadScene } : {}),
    ...(cfg.variables !== undefined ? { variables: cfg.variables } : {}),
    ...(cfg.host ?? {}),
  };
  if (mode === 'single') {
    let physics: Any;
    if (cfg.physics !== null) {
      // Phase 23.0: a 3D config (dimension 3) makes the 3D port.
      const made = cfg.physics.dimension === 3 ? await createPhysicsPort3D(cfg.physics) : await createPhysicsPort(cfg.physics);
      if (!made.ok) throw new Error(JSON.stringify(made.error));
      physics = made.port;
    }
    const behaviorModules = await linkBehaviorModules(rows, pins, (path) => import(/* @vite-ignore */ urls[path]!));
    const host = createGameHost({ ...baseConfig, behaviorModules, ...(physics !== undefined ? { physics } : {}) });
    const mounted = host.mount();
    if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
    const rt = host.runtime;
    const digests: string[] = [];
    if (cfg.digestSteps === true) rt.setStepWatcher?.(() => {
      digests.push(stepDigest(rt));
      return false;
    });
    return {
      mode,
      host,
      rt,
      access: createLocalSimAccess({ runtime: rt, ...(physics !== undefined ? { physics } : {}), stepHz: cfg.settings.fixed_step_hz ?? 120 }),
      digests,
      sounds,
      tick: async (now) => {
        const r = rt.tick(now);
        if (!r.ok) throw new Error(JSON.stringify(r.error));
      },
      dispose: async () => host.dispose(),
    };
  }
  const worker = await startNodeSimWorker();
  const remote = await startRemoteSimulation({
    worker,
    init: {
      snapshot: cfg.snapshot,
      settings: cfg.settings,
      physics: cfg.physics,
      behaviors: { rows, urls, enginePins: pins },
      ...(cfg.replay !== undefined ? { replay: cfg.replay } : {}),
      ...(cfg.digestSteps === true ? { digestSteps: true } : {}),
      ...(cfg.variables !== undefined ? { variables: cfg.variables } : {}),
    },
    input: recorded !== null ? null : liveInput,
    ...(cfg.loadScene !== undefined ? { loadScene: cfg.loadScene } : {}),
    driver: 'manual',
    log: (level, message) => {
      if (level !== 'info') process.stderr.write(`${message}\n`);
    },
  });
  const host = createGameHost({ ...baseConfig, runtimeFactory: remote.runtimeFactory });
  const mounted = host.mount();
  if (!mounted.ok) {
    await remote.dispose();
    throw new Error(JSON.stringify(mounted.error));
  }
  return {
    mode,
    host,
    rt: host.runtime,
    access: remote.access,
    digests: remote.digests,
    sounds,
    tick: async (now) => {
      await remote.tick(now);
      if (remote.failure !== null) throw new Error(JSON.stringify(remote.failure));
    },
    dispose: async () => {
      host.dispose();
      await remote.dispose();
    },
  };
}
