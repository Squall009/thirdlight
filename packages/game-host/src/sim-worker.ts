/**
 * Phase 22.0: the simulation worker — the game's deterministic simulation
 * (runtime + physics + gameplay blocks + animators + timers, spawns, effect
 * and audio requests + the project's scripts) composed by the same
 * `composeGameRuntime` as the in-page host, driven by the page's frames.
 *
 * Environment-agnostic: it talks through a `SimEndpoint` (a browser worker's
 * `self`, a Node worker_threads `parentPort`) and gets its two platform
 * pieces injected — the physics port factory (physics-rapier; the Rapier WASM
 * comes inside the worker bundle) and the module importer for the compiled
 * scripts. It never touches the DOM, audio, storage or the network.
 *
 * One frame: the page sends `tick` (its clock and one input sample); the
 * worker runs the runtime's frame (`tick(now)`: the fixed steps the time
 * allows, exactly as the page's runtime would), hands out its scene-load
 * requests, and answers with the frame's state (sim-state.ts). Commands
 * (run start/replay, level switches, pause, scene loads, the viewport) arrive
 * between frames, in order, and apply at the next step boundary — the same
 * boundary they reach in single-thread mode.
 */
import { createRecordedActionSource, type ActionSource, type PhysicsPort, type Runtime } from '@thirdlight/runtime';
import { composeGameRuntime, linkBehaviorModules } from './host';
import { PlayDebugger, type DebugRequest, type DebugRuntime } from './play-debug';
import { RelayActionSource } from './relay-input';
import { FrameEncoder } from './sim-state';
import { PHYSICS_MEMORY_CAP_BYTES, type MainToWorker, type SimCommand, type SimEndpoint, type SimInitMessage, type SimQuery, type WorkerToMain } from './sim-protocol';
import { stepDigest } from './step-digest';
import { TickInputSource } from './tick-input';

/** The platform pieces a worker entry injects. */
export interface SimWorkerDeps {
  /** physics-rapier's `createPhysicsPort` (the entry imports it; the WASM is in its bundle). */
  createPhysicsPort(config: never): Promise<{ ok: true; port: PhysicsPort } | { ok: false; error: { code: string; message?: string } }>;
  /** Import one compiled script module by URL. */
  importModule(url: string): Promise<unknown>;
  /** The physics engine's WebAssembly memory in bytes (null: unknown). */
  physicsMemoryBytes?(): number | null;
}

interface PhysicsQueries {
  raycast?(origin: { x: number; y: number }, dir: { x: number; y: number }, maxDistance: number): unknown;
  overlap?(shape: unknown, center: { x: number; y: number }): string[];
}

/** Run the simulation worker on this endpoint (call once, at the worker's start). */
export function runSimWorker(endpoint: SimEndpoint, deps: SimWorkerDeps): void {
  const post = (m: WorkerToMain, transfer?: readonly unknown[]): void => endpoint.post(m, transfer);
  let runtime: Runtime | null = null;
  let physics: (PhysicsPort & PhysicsQueries) | null = null;
  let tickInput: TickInputSource | null = null;
  let relay: RelayActionSource | null = null;
  let encoder: FrameEncoder | null = null;
  let debug: PlayDebugger | null = null;
  let stepHz = 120;
  let memoryCap = PHYSICS_MEMORY_CAP_BYTES;
  let memoryStopped = false;
  let digestOn = false;
  let digests: string[] = [];
  let debugWatcher: ((stepIndex: number) => boolean) | null = null;
  let phase: 'idle' | 'starting' | 'ready' | 'disposed' = 'idle';
  const waiting: MainToWorker[] = [];

  const installWatcher = (): void => {
    const rt = runtime;
    if (rt === null) return;
    if (!digestOn && debugWatcher === null) {
      rt.setStepWatcher?.(null);
      return;
    }
    rt.setStepWatcher?.((stepIndex) => {
      if (digestOn) digests.push(stepDigest(rt));
      return debugWatcher !== null ? debugWatcher(stepIndex) : false;
    });
  };

  const debuggerOf = (): PlayDebugger | null => {
    const rt = runtime;
    if (rt === null) return null;
    if (debug === null) {
      // The debugger arms its breakpoints through this runtime view: its
      // watcher shares the step hook with the digest.
      const view: DebugRuntime = {
        get debugHeld() {
          return rt.debugHeld;
        },
        setDebugHold: (h) => rt.setDebugHold?.(h),
        debugStep: () => rt.debugStep?.(),
        setStepWatcher: (w) => {
          debugWatcher = w;
          installWatcher();
        },
        behaviorDebug: (f) => rt.behaviorDebug?.(f) ?? [],
        getDiagnostics: () => rt.getDiagnostics(),
      };
      debug = new PlayDebugger(view, Math.max(1, Math.round(stepHz / 2)));
    }
    return debug;
  };

  const memoryNow = (): number | null => {
    try {
      return deps.physicsMemoryBytes?.() ?? null;
    } catch {
      return null;
    }
  };

  const sendFrame = (seq: number, tickError?: { code: string; message: string }): void => {
    if (runtime === null || encoder === null) return;
    const memory = memoryNow();
    if (memory !== null && memory > memoryCap && !memoryStopped) {
      // 22.3: a physics memory past the cap stops the simulation (it never grows without bound).
      memoryStopped = true;
      runtime.stop();
      tickError = { code: 'physics_memory_limit', message: `the physics memory grew to ${Math.round(memory / 1048576)} MiB, past the ${Math.round(memoryCap / 1048576)} MiB limit: the simulation stopped` };
      post({ t: 'log', level: 'error', message: `[sim-worker] ${tickError.message}` });
    }
    const out = digests;
    digests = [];
    const { state, transfer } = encoder.encode(runtime, seq, { digests: out, ...(tickError !== undefined ? { tickError } : {}), memoryBytes: memory });
    post({ t: 'frame', state }, transfer);
  };

  const init = async (m: SimInitMessage): Promise<void> => {
    phase = 'starting';
    stepHz = m.settings.fixed_step_hz ?? 120;
    memoryCap = typeof m.memoryCapBytes === 'number' && m.memoryCapBytes > 0 ? m.memoryCapBytes : PHYSICS_MEMORY_CAP_BYTES;
    try {
      let port: PhysicsPort | undefined;
      if (m.physics !== null && m.physics !== undefined) {
        const made = await deps.createPhysicsPort(m.physics as never);
        if (!made.ok) {
          post({ t: 'failed', error: { code: 'physics_init_failed', message: `physics init failed: ${made.error.code}${made.error.message !== undefined ? ` (${made.error.message})` : ''}` } });
          phase = 'idle';
          return;
        }
        port = made.port;
        physics = made.port as PhysicsPort & PhysicsQueries;
      }
      const behaviorModules = await linkBehaviorModules(m.behaviors.rows, m.behaviors.enginePins, (path) => deps.importModule(m.behaviors.urls[path] ?? path));
      let base: ActionSource & { reset?: (reason?: string) => void };
      if (m.replay !== undefined) base = createRecordedActionSource(m.replay);
      else {
        tickInput = new TickInputSource((reason) => post({ t: 'input.reset', ...(reason !== undefined ? { reason } : {}) }));
        base = tickInput;
      }
      relay = new RelayActionSource(base);
      const composed = composeGameRuntime({
        snapshot: m.snapshot,
        settings: m.settings,
        ...(port !== undefined ? { physics: port } : {}),
        behaviorModules,
        ...(m.modules !== undefined ? { modules: m.modules } : {}),
        actions: relay,
        driver: { kind: 'manual' },
      });
      if (!composed.ok) {
        port?.dispose?.();
        physics = null;
        post({ t: 'failed', error: { code: composed.error.code, message: composed.error.message } });
        phase = 'idle';
        return;
      }
      runtime = composed.runtime;
      encoder = new FrameEncoder({ shared: m.shared === true });
      digestOn = m.digestSteps === true;
      installWatcher();
      phase = 'ready';
      const cam = runtime.getCamera();
      const { state, transfer } = encoder.encode(runtime, 0, { memoryBytes: memoryNow() });
      post({ t: 'ready', state, camera: cam.ok ? cam.camera : null, hasScenes: Object.keys(runtime.sceneSet?.().status ?? {}).length > 0 }, transfer);
      post({ t: 'log', level: 'info', message: `[sim-worker] simulation composed (transforms by ${encoder.transport === 'shared' ? 'shared memory' : 'messages'}${m.replay !== undefined ? '; recorded input' : ''})` });
      for (const w of waiting.splice(0)) handle(w);
    } catch (e) {
      phase = 'idle';
      post({ t: 'failed', error: { code: 'sim_init_failed', message: e instanceof Error ? e.message : String(e) } });
    }
  };

  const command = (c: SimCommand): void => {
    const rt = runtime;
    if (rt === null) return;
    let r: { ok: true } | { ok: false; error: { code: string; message: string } } = { ok: true };
    switch (c.op) {
      case 'gameCommand':
        r = rt.gameCommand(c.cmd);
        break;
      case 'startLevel':
        r = rt.startLevel?.(c.level, c.restore as never) ?? { ok: false, error: { code: 'scene_invalid', message: 'this runtime has no levels' } };
        break;
      case 'setPaused':
        rt.setPaused?.(c.paused);
        break;
      case 'requestScene':
        r = rt.requestScene?.(c.sceneOp, c.sceneId) ?? { ok: false, error: { code: 'scene_invalid', message: 'this runtime has no scene set' } };
        break;
      case 'setViewport':
        r = rt.setViewport(c.width, c.height);
        break;
      case 'stop':
        rt.stop();
        break;
    }
    if (!r.ok) post({ t: 'cmd.error', op: c.op, error: { code: r.error.code, message: r.error.message } });
  };

  const query = (q: SimQuery): unknown => {
    const rt = runtime;
    if (rt === null) return null;
    switch (q.op) {
      case 'raycast':
        return q.rays.map((ray) => physics?.raycast?.(ray.origin, ray.dir, ray.maxDistance) ?? null);
      case 'overlap':
        return physics?.overlap?.(q.shape, q.at) ?? [];
      case 'behaviorProperties':
        return (rt as { behaviorProperties?: (id: string) => unknown }).behaviorProperties?.(q.entityId) ?? [];
      case 'diagnostics':
        return rt.getDiagnostics();
      case 'debug.request':
        return debuggerOf()?.request(q.request as DebugRequest) ?? null;
      case 'debug.control':
        debuggerOf()?.control(q.command);
        return { ok: true };
      case 'debug.observation':
        return (debug ?? (rt.debugHeld === true ? debuggerOf() : null))?.observation() ?? null;
    }
  };

  const dispose = (): void => {
    if (phase === 'disposed') return;
    phase = 'disposed';
    const rt = runtime;
    runtime = null;
    if (rt !== null) {
      try {
        rt.stop();
      } catch {
        /* already stopped or failed */
      }
      // 22.3: the runtime disposes its physics port (the Rapier world is freed).
      rt.dispose();
    } else {
      physics?.dispose?.();
    }
    physics = null;
    encoder = null;
    debug = null;
    post({ t: 'disposed' });
  };

  const handle = (m: MainToWorker): void => {
    if (phase === 'disposed') return;
    if (m.t === 'init') {
      if (phase === 'idle') void init(m);
      return;
    }
    if (phase !== 'ready') {
      if (m.t === 'dispose' && phase === 'idle') {
        phase = 'disposed';
        post({ t: 'disposed' });
        return;
      }
      waiting.push(m);
      return;
    }
    const rt = runtime!;
    switch (m.t) {
      case 'tick': {
        if (m.give !== undefined) encoder?.give(m.give);
        tickInput?.push(m.frame);
        let tickError: { code: string; message: string } | undefined;
        if (!memoryStopped) {
          const r = rt.tick(m.now);
          if (!r.ok && r.error.code !== 'runtime_not_running') tickError = { code: r.error.code, message: r.error.message };
        }
        for (const req of rt.takeSceneRequests?.() ?? []) post({ t: 'scene.request', sceneId: req.sceneId });
        sendFrame(m.seq, tickError);
        return;
      }
      case 'cmd':
        command(m.command);
        return;
      case 'scene':
        rt.provideScene?.(m.sceneId, m.result);
        return;
      case 'relay': {
        const d = rt.getDiagnostics();
        const first = (d.ok ? d.diagnostics.stepIndex : 0) + 1;
        const accepted = relay?.beginTest(m.frames, first, (from, to) => post({ t: 'relay.done', from, to })) ?? false;
        if (!accepted) post({ t: 'relay.done', from: -1, to: -1 });
        return;
      }
      case 'query':
        post({ t: 'query.result', id: m.id, result: query(m.query) });
        return;
      case 'dispose':
        dispose();
        return;
    }
  };

  endpoint.listen((raw) => {
    const m = raw as MainToWorker;
    if (typeof m !== 'object' || m === null || typeof (m as { t?: unknown }).t !== 'string') return;
    try {
      handle(m);
    } catch (e) {
      post({ t: 'log', level: 'error', message: `[sim-worker] ${m.t} failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
}
