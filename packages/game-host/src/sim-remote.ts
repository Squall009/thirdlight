/**
 * The page's end of the simulation worker.
 *
 * `startRemoteSimulation` starts the worker's simulation and returns a
 * `Runtime`-shaped mirror of it. The game host presents that mirror exactly
 * as it presents an in-page runtime (UI, shell, audio, saves, the adapter's
 * per-frame reads — `forEachInterpolated`, hidden entities, look overrides,
 * poses, effect requests), so the observable behaviour is the
 * same in both modes. Reads are answered from the last frame the worker sent;
 * commands (pause, scene loads, UI events, the camera viewport) go to
 * the worker in order and apply at its next step boundary, as in the page.
 *
 * The frame driver stays on the page and never waits for the worker. With
 * `driver: 'raf'` every animation frame (1) applies the worker's newest
 * finished frame if one arrived, (2) sends the next tick with this frame's
 * input sample (the page's clock) unless one is still in flight, and (3) runs
 * the host's frame (`onFrame`: menus, HUD, audio, render) straight away,
 * drawing each entity between its last two finished steps by the page's clock
 * (`FrameMirror.present`). The worker steps in parallel and its answer is drawn
 * from the next animation frame on: the page draws one frame behind the
 * simulation. At most one tick is in flight — a slow worker never queues
 * ticks up, the next tick simply covers more time (the runtime's bounded
 * catch-up applies as in the page), and the page keeps drawing at the
 * display's rate meanwhile. Under the game's frame-rate cap an animation
 * frame that comes early for it draws nothing; the tick for the next drawn
 * frame goes out on the animation frame just before it, so the input it
 * samples is a display refresh old when drawn (not a cap's interval), and the
 * worker computes one frame per drawn frame. With `driver: 'manual'` (Node,
 * tests) `tick(now)` resolves once the frame is applied and `onFrame` ran.
 */
import { debugCallRefusal, ENGINE_DEBUG_COMMANDS, FramePacer, frameRateCapOf, projectFrameRateCap, validateAssetAnswers, validateDebugCommandCall, validateSaveEvents, type AssetHandleAnswer, type SaveEvent, type TerrainSimData } from '@thirdlight/runtime';
import { cameraBlendOf, engineStatsOf, fixedStepHzOf, interpolateCameraPose, uiViewOf, validateDialogueInput, validateUiEvent, type DialogueInputRecord } from '@thirdlight/runtime';
import type {
  UiEventRecord,
  UiOutput,
  UiStateView,
  ActionFrame,
  AnimatorPose,
  CameraInfo,
  DebugCommandCall,
  DebugCommandState,
  InterpolatedState,
  InterpolatedTransform,
  InterpolatedVisitor,
  Runtime,
  RuntimeDiagnostics,
  RuntimeError,
  SceneLoadRequest,
  SceneSetView,
} from '@thirdlight/runtime';
import type { GameControlError } from './host';
import { FrameMirror } from './sim-state';
import { CAMERA_POSE_FLOATS, type FrameState, type MainToWorker, type SceneEntities, type SimCommand, type SimInitMessage, type SimQuery, type SimWorkerHandle, type WorkerToMain } from './sim-protocol';
import type { RelayPage, SimAccess } from './sim-access';
import type { UiHitTarget } from './ui-hit';
import type { RunDigests, RunNow } from './run-probe';

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
  /** Debugging and tests only: the worker busies itself this long per frame (a slow simulation). */
  readonly workerDelayMs?: number;
}

/** How the page's frames met the worker's (Play diagnostics). */
export interface SimPipelineStats {
  /** Frames the page drew (animation frames early for the frame-rate cap are not drawn: `framePacing`). */
  readonly frames: number;
  /**
   * Time from an animation frame to its draw (ms, all frames): what the draw
   * was held back by the worker. Applying the worker's frame and sending the
   * tick are all that run there (hundredths of a millisecond); the draw never
   * waits for the worker's answer.
   */
  readonly blockedMs: number;
  /** The longest such delay in one frame (ms). */
  readonly blockedMaxMs: number;
  /** Frames drawn with no new step since the frame before (blended by the clock, or standing still). */
  readonly framesWithoutStep: number;
  /** Frames drawn with no new worker frame (the worker was still computing). */
  readonly framesWithoutWorkerFrame: number;
  /** Ticks not sent because the last one was still in flight (the worker slower than the display). */
  readonly ticksSkipped: number;
  /** From sending a tick to its frame arriving (ms): the average and the longest. */
  readonly workerRoundTripMs: { readonly avg: number; readonly max: number };
  /**
   * From sampling a frame's input (its tick sent) to the first draw that
   * shows the steps it drove (ms): the input-to-screen time the pipeline
   * adds over drawing in the same frame, about one display frame.
   */
  readonly inputToDrawMs: { readonly avg: number; readonly max: number };
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
  /** How the page's frames met the worker's. */
  pipeline(): SimPipelineStats;
  dispose(): Promise<void>;
}

const NO_DEBUG_STATE: DebugCommandState = Object.freeze({ registered: ENGINE_DEBUG_COMMANDS, applied: Object.freeze([]), revision: 0 });

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
  let inFlight: { seq: number; sentAt: number; resolve: (s: FrameState) => void; reject: (e: Error) => void } | null = null;
  /** Frames of the worker that arrived since the last animation frame (applied, in order, at the next one). */
  const arrived: { state: FrameState; sentAt: number | null }[] = [];
  const stats = { frames: 0, blockedMs: 0, blockedMaxMs: 0, framesWithoutStep: 0, framesWithoutWorkerFrame: 0, ticksSkipped: 0, trips: 0, tripSum: 0, tripMax: 0, draws: 0, drawSum: 0, drawMax: 0 };
  let drawnStep = -1;
  /** The page's pacing under the game's frame-rate cap (the worker's runtime holds the cap scripts read). */
  const pacer = new FramePacer(projectFrameRateCap(opts.init.settings));
  /** When the oldest tick whose frame was applied but not yet drawn was sent (seconds; null: none). */
  let undrawnSentAt: number | null = null;
  /** A worker frame was applied since the last draw. */
  let freshSinceDraw = false;
  /** A tick went out after the last draw's frame was applied (the next draw has an answer coming). */
  let tickedSinceDraw = false;
  let manualChain: Promise<unknown> = Promise.resolve();
  let rafId: number | null = null;
  let running = false;
  /** Stopped (or disposed): a frame that lands now is applied at once, there is no next animation frame. */
  let stopped = false;
  /** Waiting for the frame of the last tick sent (`settled`). */
  const settleWaiters: (() => void)[] = [];
  const settleNow = (): void => {
    for (const w of settleWaiters.splice(0)) w();
  };
  let queryId = 0;
  const queries = new Map<number, (v: unknown) => void>();
  const digests: string[] = [];
  /** Run commands submitted since the last boundary (the runtime's one-pending rule, mirrored). */
  let relayDone: ((from: number, to: number) => void) | null = null;
  let relayActive = false;
  /**
   * A finished input exercise waits for the worker's frame that followed it
   * (`seq`, null until it arrived) to be drawn, and for a draw that shows its
   * last step whole: after step `to` the step count is `to + 1`, drawn exactly
   * at alpha 0 (a held game) and blended towards it before, so a running game
   * answers once a later step is drawn. A screenshot asked next shows the
   * last step, not a blend of it with the one before.
   */
  let relayFinished: { from: number; to: number; seq: number | null } | null = null;
  const answerRelayWhenDrawn = (): void => {
    const f = relayFinished;
    if (f === null || f.seq === null || mirror.seq < f.seq) return;
    if (!(mirror.stepIndex >= f.to + 2 || (mirror.stepIndex >= f.to + 1 && mirror.alpha === 0))) return;
    relayFinished = null;
    relayActive = false;
    const cb = relayDone;
    relayDone = null;
    cb?.(f.from, f.to);
  };
  /** The page's UI for the input exercise, and the targets last sent to the worker. */
  let relayPage: RelayPage | null = null;
  let sentTargets = '';
  const targetsNow = (): readonly UiHitTarget[] | undefined => {
    if (relayPage === null) return undefined;
    const t = relayPage.targets();
    const key = JSON.stringify(t);
    if (key === sentTargets) return undefined;
    sentTargets = key;
    return t;
  };
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
    const uiTargets = relayActive ? targetsNow() : undefined;
    const delay = opts.workerDelayMs !== undefined && opts.workerDelayMs > 0 ? { delayMs: opts.workerDelayMs } : {};
    post({ t: 'tick', seq: s, now, frame, ...(give !== null ? { give } : {}), ...(uiTargets !== undefined ? { uiTargets } : {}), ...delay }, give !== null ? [give] : undefined);
    return s;
  };

  const rafLoop = (frameTime?: number): void => {
    if (!running || disposed) return;
    rafId = requestAnimationFrame(rafLoop);
    const startMs = performance.now();
    const now = startMs / 1000;
    // Whether this animation frame draws (not early for the frame-rate cap), and whether the next one will.
    const t = typeof frameTime === 'number' ? frameTime : startMs;
    const draws = pacer.frame(t);
    // (1) The newest finished frame of the worker, if one arrived.
    if (arrived.length > 0) freshSinceDraw = true;
    for (const a of arrived.splice(0)) {
      applyFrame(a.state, now);
      if (a.sentAt !== null && undrawnSentAt === null) undrawnSentAt = a.sentAt;
    }
    // (2) The next tick, with this frame's input, unless the last one is still being computed. Under a cap
    // only on the frame before a draw (its answer is that draw's: input a refresh old, one worker frame per
    // draw), and on a draw no frame before it ticked for (irregular callbacks): game time never waits on it.
    let ticked = false;
    if (pacer.drawsNext(t) || (draws && !tickedSinceDraw)) {
      if (inFlight === null) {
        inFlight = { seq: sendTick(now), sentAt: now, resolve: () => undefined, reject: () => undefined };
        ticked = true;
        tickedSinceDraw = true;
      } else stats.ticksSkipped += 1;
    }
    if (!draws) return;
    tickedSinceDraw = ticked;
    if (undrawnSentAt !== null) {
      const ms = (now - undrawnSentAt) * 1000;
      undrawnSentAt = null;
      stats.draws += 1;
      stats.drawSum += ms;
      stats.drawMax = Math.max(stats.drawMax, ms);
    }
    // (3) Draw now, between the last two finished steps by the page's clock: nothing here waits for the worker.
    mirror.present(now);
    stats.frames += 1;
    if (!freshSinceDraw) stats.framesWithoutWorkerFrame += 1;
    freshSinceDraw = false;
    if (mirror.stepIndex === drawnStep) stats.framesWithoutStep += 1;
    drawnStep = mirror.stepIndex;
    const held = performance.now() - startMs;
    stats.blockedMs += held;
    stats.blockedMaxMs = Math.max(stats.blockedMaxMs, held);
    if (!disposed) onFrame?.();
    answerRelayWhenDrawn();
  };

  const applyFrame = (state: FrameState, now: number): void => {
    mirror.apply(state, now);
    // A cap a script set (or the page's own, echoed back once the worker took it).
    if (state.frameRateCap !== undefined) pacer.setCap(state.frameRateCap);
    if (state.digests !== undefined) for (const d of state.digests) digests.push(d);
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
        if (relayFinished !== null && relayFinished.seq === null) relayFinished.seq = m.state.seq;
        const f = inFlight;
        const answers = f !== null && f.seq === m.state.seq;
        if (answers) {
          inFlight = null;
          const trip = (performance.now() / 1000 - f.sentAt) * 1000;
          stats.trips += 1;
          stats.tripSum += trip;
          stats.tripMax = Math.max(stats.tripMax, trip);
        }
        if (opts.driver === 'raf') {
          if (stopped) {
            // No animation frame comes after a stop: the last steps' saves, problems, digests and errors land now.
            applyFrame(m.state, performance.now() / 1000);
            if (m.state.seq >= seq) settleNow();
            return;
          }
          // Drawn from the next animation frame on (the frame driver applies it there).
          arrived.push({ state: m.state, sentAt: answers ? f.sentAt : null });
          return;
        }
        const now = performance.now() / 1000;
        applyFrame(m.state, now);
        if (answers) {
          mirror.present(now);
          if (!disposed) onFrame?.();
          answerRelayWhenDrawn();
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
        if (m.from < 0) {
          relayActive = false;
          const cb = relayDone;
          relayDone = null;
          cb?.(m.from, m.to);
          return;
        }
        relayFinished = { from: m.from, to: m.to, seq: null };
        return;
      }
      case 'relay.effect':
        relayPage?.effect(m.effect);
        return;
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
  /** Stop the frame driver; frames that arrived and were not drawn yet are applied (nothing they carry is lost). */
  const halt = (): void => {
    running = false;
    stopped = true;
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = null;
    const now = performance.now() / 1000;
    for (const a of arrived.splice(0)) applyFrame(a.state, now);
    if (inFlight === null || mirror.seq >= seq) settleNow();
  };

  const dispose = (): Promise<void> => {
    if (disposing !== null) return disposing;
    halt();
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      disposedAck = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    // The worker answers `disposed` after the frame of its last tick: whatever happens, waiting ends here.
    void done.then(settleNow);
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
  const camLens = { fovY: 60, near: 0.1, far: 100, letterbox: 0 };
  const rotation: number[] = [0, 0, 0, 1];
  const scale: number[] = [1, 1, 1];
  const readAt = (i: number): void => mirror.readRow(i, position, rotation, scale);
  /** The camera's two step poses (scratch, filled from the frame's pose array). */
  const camA = { position: [0, 0, 0], rotation: [0, 0, 0, 1], fovY: 60, near: 0.1, far: 100, letterbox: 0 };
  const camB = { position: [0, 0, 0], rotation: [0, 0, 0, 1], fovY: 60, near: 0.1, far: 100, letterbox: 0 };
  const camPose = (out: typeof camA, pose: readonly number[], o: number): void => {
    for (let k = 0; k < 3; k += 1) out.position[k] = pose[o + k]!;
    for (let k = 0; k < 4; k += 1) out.rotation[k] = pose[o + 3 + k]!;
    out.fovY = pose[o + 7]!;
    out.near = pose[o + 8]!;
    out.far = pose[o + 9]!;
    out.letterbox = pose[o + 10]!;
  };
  const gone = (): boolean => disposed || mirror.state === 'disposed';
  const NO_LOADING: import('@thirdlight/runtime').SceneLoadingView = Object.freeze({ loading: Object.freeze([]), transition: null, swap: null });
  const emptySet: SceneSetView = Object.freeze({ revision: 0, batches: Object.freeze([]), status: Object.freeze({}), spawned: Object.freeze([]) }) as unknown as SceneSetView;

  const diagnostics = (): RuntimeDiagnostics => {
    const base = mirror.diag;
    const fields = { state: disposed ? ('disposed' as const) : mirror.state, stepIndex: mirror.stepIndex, simTime: mirror.simTime, frameCount: mirror.frameCount };
    if (base !== null) return { ...base, ...fields, errors: [...base.errors, ...(failure !== null && !base.errors.some((e) => e.code === failure!.code) ? [{ code: failure.code as never, message: failure.message }] : [])] };
    return { ...fields, snapshotId: '', revision: 0, fixedStepHz: fixedStepHzOf(opts.init.settings), droppedSteps: 0, entityCount: mirror.ids.length, modules: [], clock: 'injected', clockWarningCount: 0, errors: [], errorCount: 0 };
  };

  const mirrorRuntime: Runtime & { behaviorProperties?: (id: string) => unknown[]; animatorPoses(): ReadonlyMap<string, AnimatorPose> } = {
    start: () => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      startDriver();
      return { ok: true };
    },
    stop: () => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      halt();
      command({ op: 'stop' });
      return { ok: true };
    },
    // The frame of the last tick sent before the stop (a worker's steps the page has not seen yet).
    settled: (): Promise<void> => {
      if (!stopped || inFlight === null || mirror.seq >= seq) return Promise.resolve();
      return new Promise<void>((resolve) => settleWaiters.push(resolve));
    },
    setPaused: (paused: boolean) => {
      mirror.setPaused(paused === true, seq);
      command({ op: 'setPaused', paused: paused === true });
    },
    get isPaused() {
      return mirror.paused;
    },
    get interpolationAlpha() {
      return mirror.alpha;
    },
    setDebugHold: (hold: boolean) => {
      mirror.setDebugHeld(hold === true, seq);
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
    // The switched-off objects and the light values scripts wrote.
    inactiveEntities: () => mirror.inactive,
    lightOverrides: () => mirror.lights,
    materialSwaps: () => mirror.swapEntities,
    blockMaterialSwaps: () => mirror.swapBlocks,
    blockCutaways: () => mirror.cutaway,
    // The look overrides (ctx.look).
    entityLooks: () => mirror.looks,
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
    // The block-layer chunks the worker changed, in arrival order per chunk.
    takeGridChanges: () => {
      const out = [...mirror.grid.values()];
      mirror.grid.clear();
      return out;
    },
    // The worker's environment blend (interpolated there with the frame's alpha).
    readEnvironmentBlend: () => (gone() ? null : mirror.env),
    // The material parameters the worker's scripts changed (the latest per parameter).
    takeMaterialChanges: () => {
      const out = [...mirror.mat.values()];
      mirror.mat.clear();
      return out;
    },
    // Project saves — the worker's requests (the page owns storage), storage's answers queued there.
    takeSaveRequests: () => {
      const out = mirror.saveReq;
      mirror.saveReq = [];
      return out;
    },
    takeProblems: () => {
      const out = mirror.problems;
      mirror.problems = [];
      return out;
    },
    queueSaveEvent: (event: SaveEvent) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const checked = validateSaveEvents([event]);
      if (!checked.ok) return { ok: false, error: rtError('game_command_invalid', `save entry: ${checked.message}`, { reason: 'saves' }) };
      command({ op: 'saveEvent', event: checked.events[0]! });
      return { ok: true };
    },
    // Scripts' asset handles — the worker's loads and releases (the page holds the assets), the answers queued there.
    takeAssetRequests: () => {
      const out = mirror.assetReq;
      mirror.assetReq = [];
      return out;
    },
    queueAssetAnswer: (answer: AssetHandleAnswer) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const checked = validateAssetAnswers([answer]);
      if (!checked.ok) return { ok: false, error: rtError('game_command_invalid', `assets answer: ${checked.message}`, { reason: 'assets' }) };
      command({ op: 'assetAnswer', answer: checked.answers[0]! });
      return { ok: true };
    },
    gameCounters: () => mirror.counters,
    // The objects' health and the listed scene (mirrored); the shell's save is made in the worker.
    healthsView: () => mirror.healths,
    listedSceneIndex: () => mirror.listed,
    requestSave: (slot: number, meta?: import('@thirdlight/runtime').SaveMeta) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      command({ op: 'requestSave', slot, ...(meta !== undefined ? { meta } : {}) });
      return { ok: true };
    },
    // The worker's resolved camera (interpolated there with the frame's alpha).
    readCameraView: (p: number[], r: number[]) => {
      const c = mirror.cam;
      if (gone() || c === null) return null;
      // Between the two steps by the page's clock, as the transforms.
      camPose(camA, c.pose, 0);
      camPose(camB, c.pose, CAMERA_POSE_FLOATS);
      return interpolateCameraPose(camA, camB, cameraBlendOf(mirror.alpha), p, r, camLens);
    },
    cameraView: () => (gone() ? null : (mirror.cam?.view ?? null)),
    // The objects riding on sockets (the worker's list).
    socketAttachments: () => mirror.sockets,
    // The worker's timeline view (screen overlay, plays, last events).
    timelineView: () => (gone() ? null : mirror.timeline),
    // The worker's scene loading view.
    sceneLoadingView: () => mirror.loading ?? NO_LOADING,
    // The project UI — events go to the worker's runtime (its next sampled frame); its diffs arrive with the frames.
    queueUiEvent: (event: UiEventRecord) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const checked = validateUiEvent(event);
      if (!checked.ok) return { ok: false, error: rtError('game_command_invalid', `UI event: ${checked.message}`, { reason: 'ui_event' }) };
      command({ op: 'uiEvent', event: checked.event });
      return { ok: true };
    },
    // Dialogue inputs go to the worker's runtime (its next sampled frame).
    queueDialogueInput: (input: DialogueInputRecord) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const checked = validateDialogueInput(input);
      if (!checked.ok) return { ok: false, error: rtError('game_command_invalid', `dialogue input: ${checked.message}`, { reason: 'dialogue' }) };
      command({ op: 'dialogueInput', input: checked.input });
      return { ok: true };
    },
    takeUiOutput: (): UiOutput | null => {
      const out = mirror.ui;
      mirror.ui = null;
      return out;
    },
    uiView: (): UiStateView => ({ model: mirror.uiModel, shown: mirror.uiShown }),
    // The game modes as the worker's last frame had them.
    modeView: () => (gone() ? null : mirror.mode),
    // The worker's cursor request and pointer (the host applies the cursor; observers read the pointer).
    cursorRequest: () => (gone() ? null : mirror.cursor),
    // The scripts' binding requests the worker sent (taken by the page's host).
    takeBindingRequests: () => {
      const out = { requests: mirror.bindingRequests, dropped: mirror.bindingDropped };
      mirror.bindingRequests = [];
      mirror.bindingDropped = 0;
      return out;
    },
    readPointer: () => (gone() ? null : mirror.pointer),
    setCameraViewport: (width: number, height: number): boolean => {
      if (gone()) return false;
      const valid = typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384;
      if (!valid) return false;
      command({ op: 'setCameraViewport', width, height });
      return true;
    },
    setUiView: (width: number, height: number, pixelRatio: number): boolean => {
      if (gone() || uiViewOf(width, height, pixelRatio) === null) return false;
      command({ op: 'setUiView', width, height, pixelRatio });
      return true;
    },
    // The frame-rate cap: paced here, held for scripts by the worker's runtime (a change on the page goes there too).
    frameRateCap: () => pacer.frameRateCap,
    setFrameRateCap: (fps: unknown): boolean => {
      const cap = frameRateCapOf(fps);
      if (gone() || cap === undefined) return false;
      pacer.setCap(cap);
      command({ op: 'setFrameRateCap', fps: cap });
      return true;
    },
    pinFrameRateCap: (fps: unknown): boolean => !gone() && pacer.pinCap(fps),
    // Only what collision reads (heights, holes; a scatter blob's copies; what a spline made), copied: the page keeps its tiles for drawing.
    addTerrainTiles: (tiles: readonly TerrainSimData[]): void => {
      if (!gone() && tiles.length > 0) command({ op: 'terrainTiles', tiles: tiles.map((t) => ('scatter' in t ? { digest: t.digest, scatter: t.scatter } : 'spline' in t ? { digest: t.digest, spline: t.spline } : { digest: t.digest, samples: t.samples, heights: t.heights, holes: t.holes })) });
    },
    framePacing: () => pacer.stats(),
    setStats: (stats: unknown): boolean => {
      const s = engineStatsOf(stats);
      if (gone() || s === null) return false;
      command({ op: 'setStats', stats: s });
      return true;
    },
    tick: () => ({ ok: false, error: rtError('tick_not_allowed', 'the simulation runs in a worker: drive it with the remote simulation (tick is asynchronous there)') }),
    getDiagnostics: () => ({ ok: true, diagnostics: diagnostics() }),
    getInterpolatedState: (): { ok: true; state: InterpolatedState } | { ok: false; error: RuntimeError } => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const transforms: InterpolatedTransform[] = [];
      for (let i = 0; i < mirror.rowCount(); i += 1) {
        readAt(i);
        transforms.push({ id: mirror.ids[i]!, position: [position[0]!, position[1]!, position[2]!], rotation: [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!], scale: [scale[0]!, scale[1]!, scale[2]!] });
      }
      return { ok: true, state: { stepIndex: mirror.stepIndex, simTime: mirror.simTime, alpha: mirror.alpha, transforms } };
    },
    forEachInterpolated: (visit: InterpolatedVisitor): boolean => {
      if (gone()) return false;
      const n = mirror.rowCount();
      for (let i = 0; i < n; i += 1) {
        readAt(i);
        visit(mirror.ids[i]!, position, rotation, scale);
      }
      return true;
    },
    // The last finished step, not blended (what digests and observers compare).
    forEachCommitted: (visit: InterpolatedVisitor): boolean => {
      if (gone()) return false;
      const n = mirror.rowCount();
      for (let i = 0; i < n; i += 1) {
        mirror.readCommittedRow(i, position, rotation, scale);
        visit(mirror.ids[i]!, position, rotation, scale);
      }
      return true;
    },
    forEachMoved: (visit: InterpolatedVisitor): boolean => {
      if (gone()) return false;
      mirror.takeMoved((i) => {
        readAt(i);
        visit(mirror.ids[i]!, position, rotation, scale);
      }, mirror.rowCount());
      return true;
    },
    readInterpolated: (id: string, p: number[], r: number[], s: number[]): boolean => {
      if (gone()) return false;
      const i = mirror.index.get(id);
      if (i === undefined || i >= mirror.rowCount()) return false;
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
    // Debug commands — the worker's registry (mirrored), a call checked here and queued there.
    debugCommandState: (): DebugCommandState => mirror.debugCommands ?? NO_DEBUG_STATE,
    queueDebugCommand: (call: DebugCommandCall) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const checked = validateDebugCommandCall(call);
      if (!checked.ok) return { ok: false, error: rtError('game_command_invalid', `debug command: ${checked.message}`, { reason: 'debug_command' }) };
      const problem = debugCallRefusal((mirror.debugCommands ?? NO_DEBUG_STATE).registered, checked.call);
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
    requestArrival: (sceneId: string, spawnId: string) => {
      if (gone()) return { ok: false, error: rtError('runtime_disposed', 'runtime is disposed') };
      const status = mirror.sceneSet?.status;
      if (!hasScenes || (status !== undefined && !(sceneId in status))) return { ok: false, error: rtError('scene_invalid', `unknown scene ${JSON.stringify(String(sceneId))}`, { reason: 'transfer' }) };
      command({ op: 'requestArrival', sceneId, spawnId });
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
        inFlight = { seq: s, sentAt: performance.now() / 1000, resolve, reject };
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
    beginInputTest: (frames, onComplete, options) => {
      if (relayActive || disposed) return false;
      relayActive = true;
      relayDone = (from, to) => {
        if (from < 0) {
          relayActive = false;
          return;
        }
        onComplete(from, to);
      };
      sentTargets = '';
      const uiTargets = targetsNow();
      post({ t: 'relay', frames, ...(uiTargets !== undefined ? { uiTargets } : {}), ...(options?.restart === true ? { restart: true } : {}), ...(options?.hold === true ? { hold: true } : {}) });
      return true;
    },
    get inputTestActive() {
      return relayActive;
    },
    runDigests: async () => ((await ask({ op: 'runDigests' })) as RunDigests | null) ?? null,
    runNow: async () => ((await ask({ op: 'runNow' })) as RunNow | null) ?? null,
    relayIdle: () => {
      if (relayActive) post({ t: 'relay.idle' });
    },
    setRelayPage: (page) => {
      relayPage = page;
      sentTargets = '';
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
          mirror.stepSeconds = 1 / fixedStepHzOf(opts.init.settings);
          applyFrame(m.state, performance.now() / 1000);
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
            pipeline: () => ({
              frames: stats.frames,
              blockedMs: Math.round(stats.blockedMs * 100) / 100,
              blockedMaxMs: Math.round(stats.blockedMaxMs * 100) / 100,
              framesWithoutStep: stats.framesWithoutStep,
              framesWithoutWorkerFrame: stats.framesWithoutWorkerFrame,
              ticksSkipped: stats.ticksSkipped,
              workerRoundTripMs: { avg: stats.trips > 0 ? Math.round((stats.tripSum / stats.trips) * 100) / 100 : 0, max: Math.round(stats.tripMax * 100) / 100 },
              inputToDrawMs: { avg: stats.draws > 0 ? Math.round((stats.drawSum / stats.draws) * 100) / 100 : 0, max: Math.round(stats.drawMax * 100) / 100 },
            }),
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
