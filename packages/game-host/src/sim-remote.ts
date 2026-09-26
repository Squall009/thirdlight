/**
 * Phase 22.0: the page's end of the simulation worker.
 *
 * `startRemoteSimulation` starts the worker's simulation and returns a
 * `Runtime`-shaped mirror of it. The game host presents that mirror exactly
 * as it presents an in-page runtime (HUD, flow, audio, saves, the adapter's
 * per-frame reads — `forEachInterpolated`, the committed view, hidden and
 * fading entities, poses, effect requests), so the observable behaviour is the
 * same in both modes. Reads are answered from the last frame the worker sent;
 * commands (run start/replay, levels, pause, scene loads, the viewport) go to
 * the worker in order and apply at its next step boundary, as in the page.
 *
 * The frame driver stays on the page: with `driver: 'raf'` every animation
 * frame samples the input owner once and sends a tick (the page's clock);
 * the worker's answer is applied and the host's frame (`onFrame`: menus, HUD,
 * audio, render) runs as soon as it arrives. At most one tick is in flight —
 * a slow step never queues frames up, the next tick simply covers more time
 * (the runtime's bounded catch-up applies as in the page). With
 * `driver: 'manual'` (Node, tests) `tick(now)` resolves once the frame is in.
 */
import { debugCallProblem, validateDebugCommandCall } from '@thirdlight/runtime';
import type {
  ActionFrame,
  AnimatorPose,
  CameraInfo,
  DebugCommandCall,
  DebugCommandState,
  GameView,
  InterpolatedState,
  InterpolatedTransform,
  InterpolatedVisitor,
  RunRestore,
  RunSaveState,
  Runtime,
  RuntimeDiagnostics,
  RuntimeError,
  SceneLoadRequest,
  SceneSetView,
} from '@thirdlight/runtime';
import type { GameControlError } from './host';
import { FrameMirror } from './sim-state';
import { TRANSFORM_STRIDE, type FrameState, type MainToWorker, type SceneEntities, type SimCommand, type SimInitMessage, type SimQuery, type SimWorkerHandle, type WorkerToMain } from './sim-protocol';
import type { SimAccess } from './sim-access';

export interface RemoteSimulationOptions {
  readonly worker: SimWorkerHandle;
  readonly init: Omit<SimInitMessage, 't'>;
  /** The live input owner (sampled once per frame); null with a recorded `init.replay`. */
  readonly input: { sample(stepIndex: number): ActionFrame; reset?(reason?: string): void } | null;
  /** Fetch one scene the game asked for (the page's scene catalog). */
  readonly loadScene?: (sceneId: string) => Promise<SceneEntities>;
  readonly driver: 'raf' | 'manual';
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** How long the worker may take to compose the simulation (default 60 s). */
  readonly readyTimeoutMs?: number;
}

export interface RemoteSimulation {
  /** The mirror the host presents. */
  readonly runtime: Runtime;
  /** For `GameHostConfig.runtimeFactory`: hands the mirror to the host and starts the frame driver. */
  readonly runtimeFactory: (onFrame: () => void) => { ok: true; runtime: Runtime };
  /** Manual driver: run one frame at `now` (seconds); resolves when the worker's frame is applied and `onFrame` ran. */
  tick(now: number): Promise<FrameState>;
  /** The async surface (queries, the debugger, the input exercise). */
  readonly access: SimAccess;
  readonly transport: 'shared' | 'message';
  /** Step digests the worker reported (with `init.digestSteps`), in step order. */
  readonly digests: string[];
  /** The fatal error of the worker, if one happened after it was ready. */
  readonly failure: { code: string; message: string } | null;
  dispose(): Promise<void>;
}

const RUN_STATES_REPLAY = new Set(['playing', 'respawning', 'won']);
const NO_DEBUG_STATE: DebugCommandState = Object.freeze({ registered: Object.freeze([]), applied: Object.freeze([]), revision: 0 });

function rtError(code: string, message: string, extra: Partial<RuntimeError> = {}): RuntimeError {
  return { code, message, ...extra } as RuntimeError;
}

/** Start the worker's simulation; resolves with the mirror once the worker has composed it. */
export function startRemoteSimulation(opts: RemoteSimulationOptions): Promise<RemoteSimulation> {
  const worker = opts.worker;
  const log = opts.log ?? ((level, message) => (level === 'error' ? console.error(message) : level === 'warn' ? console.warn(message) : console.info(message)));
  const mirror = new FrameMirror();
  let camera: CameraInfo | null = null;
  let hasScenes = false;
  let onFrame: (() => void) | null = null;
  let disposed = false;
  let failure: { code: string; message: string } | null = null;
  let seq = 0;
  let inFlight: { seq: number; resolve: (s: FrameState) => void; reject: (e: Error) => void } | null = null;
  let manualChain: Promise<unknown> = Promise.resolve();
  let rafId: number | null = null;
  let running = false;
  let queryId = 0;
  const queries = new Map<number, (v: unknown) => void>();
  const digests: string[] = [];
  /** Run commands submitted since the last boundary (the runtime's one-pending rule, mirrored). */
  let pendingCmds: { cmd: 'start' | 'replay'; atStep: number }[] = [];
  let relayDone: ((from: number, to: number) => void) | null = null;
  let relayActive = false;
  let disposedAck: (() => void) | null = null;
  let transport: 'shared' | 'message' = opts.init.shared === true ? 'shared' : 'message';

  const post = (m: MainToWorker, transfer?: readonly unknown[]): void => {
    if (!disposed || m.t === 'dispose') worker.post(m, transfer);
  };
  const command = (c: SimCommand): void => post({ t: 'cmd', command: c });
  const ask = (q: SimQuery): Promise<unknown> => {
    if (disposed) return Promise.resolve(null);
    const id = (queryId += 1);
    return new Promise((resolve) => {
      queries.set(id, resolve);
      post({ t: 'query', id, query: q });
    });
  };

  const sendTick = (now: number): number => {
    const s = (seq += 1);
    // The runtime's first frame after start runs no sampled step (settle
    // pre-roll or the clock anchor): no input is sampled for it, as in the page.
    const frame = opts.input !== null && mirror.frameCount > 0 ? opts.input.sample(mirror.stepIndex) : null;
    const give = mirror.spare;
    mirror.spare = null;
    post({ t: 'tick', seq: s, now, frame, ...(give !== null ? { give } : {}) }, give !== null ? [give] : undefined);
    return s;
  };

  const rafLoop = (): void => {
    if (!running || disposed) return;
    rafId = requestAnimationFrame(rafLoop);
    if (inFlight !== null) return; // one frame in flight: this frame renders when it arrives
    const s = sendTick(performance.now() / 1000);
    inFlight = { seq: s, resolve: () => undefined, reject: () => undefined };
  };

  const applyFrame = (state: FrameState): void => {
    mirror.apply(state);
    if (state.digests !== undefined) for (const d of state.digests) digests.push(d);
    if (pendingCmds.length > 0 && pendingCmds.some((p) => mirror.stepIndex > p.atStep)) pendingCmds = pendingCmds.filter((p) => mirror.stepIndex <= p.atStep);
    if (state.tickError !== undefined && failure === null) {
      failure = state.tickError;
      log('error', `[thirdlight] simulation worker: ${state.tickError.code}: ${state.tickError.message}`);
    }
  };

  const onMessage = (raw: unknown): void => {
    const m = raw as WorkerToMain;
    if (typeof m !== 'object' || m === null) return;
    switch (m.t) {
      case 'frame': {
        applyFrame(m.state);
        const f = inFlight;
        if (f !== null && f.seq === m.state.seq) {
          inFlight = null;
          if (!disposed) onFrame?.();
          f.resolve(m.state);
        }
        return;
      }
      case 'scene.request': {
        const sceneId = m.sceneId;
        if (opts.loadScene === undefined) {
          post({ t: 'scene', sceneId, result: { ok: false, message: 'this game page cannot load scenes' } });
          return;
        }
        opts.loadScene(sceneId).then(
          (entities) => post({ t: 'scene', sceneId, result: { ok: true, entities } }),
          (error: unknown) => post({ t: 'scene', sceneId, result: { ok: false, message: error instanceof Error ? error.message : String(error) } }),
        );
        return;
      }
      case 'relay.done': {
        relayActive = false;
        const cb = relayDone;
        relayDone = null;
        cb?.(m.from, m.to);
        return;
      }
      case 'input.reset':
        opts.input?.reset?.(m.reason);
        return;
      case 'query.result': {
        const r = queries.get(m.id);
        queries.delete(m.id);
        r?.(m.result);
        return;
      }
      case 'cmd.error':
        log('warn', `[thirdlight] simulation worker refused ${m.op}: ${m.error.code}: ${m.error.message}`);
        return;
      case 'log':
        log(m.level, m.message);
        return;
      case 'failed':
        failure = m.error;
        log('error', `[thirdlight] simulation worker failed: ${m.error.code}: ${m.error.message}`);
        return;
      case 'disposed':
        disposedAck?.();
        return;
      default:
        return;
    }
  };

  let disposing: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposing !== null) return disposing;
    running = false;
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = null;
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      disposedAck = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    post({ t: 'dispose' });
    disposed = true;
    for (const r of queries.values()) r(null);
    queries.clear();
    inFlight?.reject(new Error('the simulation was disposed'));
    inFlight = null;
    disposing = done.then(() => worker.terminate());
    return disposing;
  };

  // ---- the mirror runtime ------------------------------------------------------

  const position: number[] = [0, 0, 0];
  const rotation: number[] = [0, 0, 0, 1];
  const scale: number[] = [1, 1, 1];
  const readAt = (i: number): void => {
    const o = i * TRANSFORM_STRIDE;
    const x = mirror.xf;
    position[0] = x[o]!;
    position[1] = x[o + 1]!;
    position[2] = x[o + 2]!;
    rotation[0] = x[o + 3]!;
    rotation[1] = x[o + 4]!;
    rotation[2] = x[o + 5]!;
    rotation[3] = x[o + 6]!;
    scale[0] = x[o + 7]!;
    scale[1] = x[o + 8]!;
    scale[2] = x[o + 9]!;
  };
  const gone = (): boolean => disposed || mirror.state === 'disposed';
  const noSession = (): RuntimeError => rtError('game_session_unavailable', 'this runtime has no M3 game session (no selected module declares the gameplay or camera phase)', { reason: 'schedule' });
  const emptySet: SceneSetView = Object.freeze({ revision: 0, batches: Object.freeze([]), status: Object.freeze({}), spawned: Object.freeze([]) }) as unknown as SceneSetView;

  const diagnostics = (): RuntimeDiagnostics => {
    const base = mirror.diag;
    const fields = { state: disposed ? ('disposed' as const) : mirror.state, stepIndex: mirror.stepIndex, simTime: mirror.simTime, frameCount: mirror.frameCount };
    if (base !== null) return { ...base, ...fields, errors: [...base.errors, ...(failure !== null && !base.errors.some((e) => e.code === failure!.code) ? [{ code: failure.code as never, message: failure.message }] : [])] };
    return { ...fields, snapshotId: '', revision: 0, fixedStepHz: opts.init.settings.fixed_step_hz ?? 120, droppedSteps: 0, entityCount: mirror.ids.length, modules: [], clock: 'injected', clockWarningCount: 0, errors: [], errorCount: 0 };
  };

  const mirrorRuntime: Runtime & { behaviorProperties?: (id: string) => unknown[]; animatorPoses(): ReadonlyMap<string, AnimatorPose> } = {
    start: () => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      startDriver();
      return { ok: true };
    },
    stop: () => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      running = false;
      if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = null;
      command({ op: 'stop' });
      return { ok: true };
    },
    startLevel: (level: { scenes: readonly string[]; spawnId: string }, restore?: RunRestore) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      if (!Array.isArray(level.scenes) || level.scenes.length === 0) return { ok: false, error: rtError('scene_invalid', 'a level loads at least one scene', { reason: 'level' }) };
      const status = mirror.sceneSet?.status;
      if (status !== undefined) for (const id of level.scenes) if (!(id in status)) return { ok: false, error: rtError('scene_invalid', `unknown scene ${JSON.stringify(String(id))}`, { reason: 'level' }) };
      command({ op: 'startLevel', level: { scenes: [...level.scenes], spawnId: String(level.spawnId) }, ...(restore !== undefined ? { restore } : {}) });
      return { ok: true };
    },
    runState: (): RunSaveState => (mirror.runSave as RunSaveState | null) ?? { checkpointId: null, counters: {}, collected: [], defeated: [], health: null, values: {} },
    setPaused: (paused: boolean) => {
      mirror.paused = paused === true;
      command({ op: 'setPaused', paused: paused === true });
    },
    get isPaused() {
      return mirror.paused;
    },
    get interpolationAlpha() {
      return mirror.alpha;
    },
    setDebugHold: (hold: boolean) => {
      mirror.debugHeld = hold === true;
      void ask({ op: 'debug.control', command: hold ? 'debugPause' : 'debugResume' });
    },
    get debugHeld() {
      return mirror.debugHeld;
    },
    debugStep: () => void ask({ op: 'debug.control', command: 'debugStep' }),
    // A step watcher runs per step, in the worker: the page cannot install one (the debugger runs there; see `access`).
    setStepWatcher: () => undefined,
    behaviorDebug: () => [],
    hiddenEntities: () => mirror.hidden,
    entityOpacity: () => mirror.opacity,
    animatorPoses: (): ReadonlyMap<string, AnimatorPose> => mirror.poses,
    takeAudioRequests: () => {
      const out = mirror.audio;
      mirror.audio = [];
      return out;
    },
    takeEffectRequests: () => {
      const out = mirror.effects;
      mirror.effects = [];
      return out as ReturnType<NonNullable<Runtime['takeEffectRequests']>>;
    },
    gameCounters: () => mirror.counters,
    tick: () => ({ ok: false, error: rtError('tick_not_allowed', 'the simulation runs in a worker: drive it with the remote simulation (tick is asynchronous there)') }),
    getDiagnostics: () => ({ ok: true, diagnostics: diagnostics() }),
    getInterpolatedState: (): { ok: true; state: InterpolatedState } | { ok: false; error: RuntimeError } => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const transforms: InterpolatedTransform[] = [];
      for (let i = 0; i < mirror.ids.length; i += 1) {
        readAt(i);
        transforms.push({ id: mirror.ids[i]!, position: [position[0]!, position[1]!, position[2]!], rotation: [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!], scale: [scale[0]!, scale[1]!, scale[2]!] });
      }
      return { ok: true, state: { stepIndex: mirror.stepIndex, simTime: mirror.simTime, alpha: mirror.alpha, transforms } };
    },
    forEachInterpolated: (visit: InterpolatedVisitor): boolean => {
      if (gone()) return false;
      const n = Math.min(mirror.ids.length, Math.floor(mirror.xf.length / TRANSFORM_STRIDE));
      for (let i = 0; i < n; i += 1) {
        readAt(i);
        visit(mirror.ids[i]!, position, rotation, scale);
      }
      return true;
    },
    readInterpolated: (id: string, p: number[], r: number[], s: number[]): boolean => {
      if (gone()) return false;
      const i = mirror.index.get(id);
      if (i === undefined || (i + 1) * TRANSFORM_STRIDE > mirror.xf.length) return false;
      readAt(i);
      for (let k = 0; k < 3; k += 1) p[k] = position[k]!;
      for (let k = 0; k < 4; k += 1) r[k] = rotation[k]!;
      for (let k = 0; k < 3; k += 1) s[k] = scale[k]!;
      return true;
    },
    getCamera: () => (gone() ? { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') } : camera !== null ? { ok: true, camera: { ...camera } } : { ok: false, error: rtError('camera_unavailable', 'no camera') }),
    dispose: () => {
      if (disposed) return { ok: true, alreadyDisposed: true };
      void dispose();
      return { ok: true };
    },
    getGameView: (): { ok: true; view: GameView } | { ok: false; error: RuntimeError } => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      return mirror.view !== null ? { ok: true, view: mirror.view } : { ok: false, error: noSession() };
    },
    peekGameView: () => (gone() ? null : mirror.view),
    gameCommand: (cmd: 'start' | 'replay') => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const view = mirror.view;
      if (view === null) return { ok: false, error: noSession() };
      if (mirror.state === 'failed') return { ok: false, error: rtError('runtime_failed', 'the runtime is failed (a failed instance never steps again; the run is frozen at its last committed value)') };
      // The game session's rule (runtime game-session `submit`), on the mirrored state.
      if (pendingCmds.some((p) => p.cmd === cmd)) return { ok: true };
      if (pendingCmds.length > 0) return { ok: false, error: rtError('game_command_invalid', 'a run command is already pending (one pending command per kind; a conflicting submission within the same boundary is rejected)', { reason: 'pending', command: cmd }) };
      if (cmd === 'start' && view.state !== 'awaitingStart') return { ok: false, error: rtError('game_command_invalid', `"start" is valid only in "awaitingStart" (current run state: "${view.state}")`, { reason: 'state', command: cmd, state: view.state }) };
      if (cmd === 'replay' && !RUN_STATES_REPLAY.has(view.state)) return { ok: false, error: rtError('game_command_invalid', `"replay" is valid only in "playing"/"respawning"/"won" (current run state: "${view.state}")`, { reason: 'state', command: cmd, state: view.state }) };
      pendingCmds.push({ cmd, atStep: mirror.stepIndex });
      command({ op: 'gameCommand', cmd });
      return { ok: true };
    },
    setViewport: (width: number, height: number) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      if (mirror.view === null) return { ok: false, error: noSession() };
      const valid = typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384;
      if (!valid) return { ok: false, error: rtError('camera_viewport_invalid', `viewport dimensions must be finite, positive and ≤ 16384 (got ${width}×${height}); the previous record is retained`, { width, height } as Partial<RuntimeError>) };
      command({ op: 'setViewport', width, height });
      return { ok: true };
    },
    // Phase 23.8: debug commands — the worker's registry (mirrored), a call checked here and queued there.
    debugCommandState: (): DebugCommandState => mirror.debugCommands ?? NO_DEBUG_STATE,
    queueDebugCommand: (call: DebugCommandCall) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const checked = validateDebugCommandCall(call);
      if (!checked.ok) return { ok: false, error: rtError('game_command_invalid', `debug command: ${checked.message}`, { reason: 'debug_command' }) };
      const spec = mirror.debugCommands?.registered.find((c) => c.name === checked.call.name);
      if (spec === undefined) return { ok: false, error: rtError('game_command_invalid', `no script declared the debug command "${checked.call.name}"`, { reason: 'debug_command' }) };
      const problem = debugCallProblem(spec, checked.call.args);
      if (problem !== null) return { ok: false, error: rtError('game_command_invalid', problem, { reason: 'debug_command' }) };
      command({ op: 'debugCommand', call: checked.call });
      return { ok: true };
    },
    sceneSet: () => mirror.sceneSet ?? emptySet,
    // The worker hands its scene requests to the page directly (the loader above).
    takeSceneRequests: (): SceneLoadRequest[] => [],
    provideScene: (sceneId, result) => {
      post({ t: 'scene', sceneId, result });
      return { ok: true };
    },
    requestScene: (op: 'load' | 'unload', sceneId: string) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      if (!hasScenes) return { ok: false, error: rtError('scene_invalid', 'this runtime has no scene set', { reason: op }) };
      const status = mirror.sceneSet?.status;
      if (status !== undefined && !(sceneId in status)) return { ok: false, error: rtError('scene_invalid', `unknown scene ${JSON.stringify(String(sceneId))}`, { reason: op }) };
      const pinned = op === 'unload' ? mirror.pinned.get(sceneId) : undefined;
      if (pinned !== undefined) return { ok: false, error: rtError('scene_invalid', pinned, { reason: op }) };
      command({ op: 'requestScene', sceneOp: op, sceneId });
      return { ok: true };
    },
  };

  const startDriver = (): void => {
    if (running || disposed) return;
    running = true;
    if (opts.driver === 'raf' && typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(rafLoop);
  };

  const tick = (now: number): Promise<FrameState> => {
    const run = (): Promise<FrameState> => {
      if (disposed) return Promise.reject(new Error('the simulation was disposed'));
      return new Promise<FrameState>((resolve, reject) => {
        const s = sendTick(now);
        inFlight = { seq: s, resolve, reject };
      });
    };
    const next = manualChain.then(run, run);
    manualChain = next.catch(() => undefined);
    return next;
  };

  const access: SimAccess = {
    mode: 'worker',
    get transport() {
      return transport;
    },
    runtime: mirrorRuntime,
    behaviorProperties: async (entityId) => ((await ask({ op: 'behaviorProperties', entityId })) as unknown[] | null) ?? [],
    debugRequest: (request) => ask({ op: 'debug.request', request }),
    debugControl: async (command2) => {
      await ask({ op: 'debug.control', command: command2 });
    },
    debugObservation: () => ask({ op: 'debug.observation' }),
    diagnostics: async () => ((await ask({ op: 'diagnostics' })) as ReturnType<Runtime['getDiagnostics']> | null) ?? { ok: true, diagnostics: diagnostics() },
    beginInputTest: (frames, onComplete) => {
      if (relayActive || disposed) return false;
      relayActive = true;
      relayDone = (from, to) => {
        if (from < 0) {
          relayActive = false;
          return;
        }
        onComplete(from, to);
      };
      post({ t: 'relay', frames });
      return true;
    },
    get inputTestActive() {
      return relayActive;
    },
    raycast: async (rays) => ((await ask({ op: 'raycast', rays })) as ({ distance: number } | null)[] | null) ?? rays.map(() => null),
    overlap: async (shape, at) => ((await ask({ op: 'overlap', shape, at })) as string[] | null) ?? [],
  };

  return new Promise<RemoteSimulation>((resolve, reject) => {
    const timer = setTimeout(() => {
      failure = { code: 'sim_worker_timeout', message: 'the simulation worker did not start in time' };
      worker.terminate();
      reject(new Error(`${failure.code}: ${failure.message}`));
    }, opts.readyTimeoutMs ?? 60_000);
    let settled = false;
    worker.onError?.((message) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        reject(Object.assign(new Error(`sim_worker_failed: ${message}`), { code: 'sim_worker_failed' }));
        return;
      }
      if (failure === null) failure = { code: 'sim_worker_failed', message };
      log('error', `[thirdlight] simulation worker error: ${message}`);
    });
    worker.listen((raw) => {
      const m = raw as WorkerToMain;
      if (!settled && typeof m === 'object' && m !== null) {
        if (m.t === 'ready') {
          settled = true;
          clearTimeout(timer);
          camera = m.camera;
          hasScenes = m.hasScenes;
          applyFrame(m.state);
          if (m.state.xfShared === undefined && opts.init.shared === true) transport = 'message';
          resolve({
            runtime: mirrorRuntime,
            runtimeFactory: (frameHook) => {
              onFrame = frameHook;
              startDriver();
              return { ok: true, runtime: mirrorRuntime };
            },
            tick,
            access,
            get transport() {
              return transport;
            },
            digests,
            get failure() {
              return failure;
            },
            dispose,
          });
          return;
        }
        if (m.t === 'failed') {
          settled = true;
          clearTimeout(timer);
          worker.terminate();
          reject(Object.assign(new Error(`${m.error.code}: ${m.error.message}`), { code: m.error.code }));
          return;
        }
      }
      onMessage(raw);
    });
    worker.post({ t: 'init', ...opts.init } satisfies MainToWorker);
  });
}

/** For hosts: a `GameControlError` from a failed remote start. */
export function remoteStartError(e: unknown): GameControlError {
  const code = typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'sim_worker_failed';
  return { code, message: e instanceof Error ? e.message : String(e) };
}
