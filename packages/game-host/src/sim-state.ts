/**
 * The per-frame state of the simulation worker, encoded in the
 * worker (`FrameEncoder`) and mirrored in the page (`FrameMirror`).
 *
 * The encoder sends only what changed since the last frame: each entity's
 * last two finished steps as one transferred `Float64Array` (all entities, or
 * only the ones that changed when few did), the committed game view when a step committed a new one, the
 * hidden/fading entities, animator poses, counters and the save state when
 * they differ, the scene set when the runtime rebuilt it (entities only for a
 * batch the page does not have yet), and the queued audio and effect requests.
 * With shared memory (a cross-origin-isolated page) the transforms go through
 * a two-slot SharedArrayBuffer instead: the page has at most one frame in
 * flight, so it reads one slot while the worker writes the other.
 *
 * The page draws a frame behind the worker: it blends each entity's two
 * steps by its own clock (`FrameMirror.present`), from the alpha and rate
 * the worker's tick had, so it never waits for the next frame to draw.
 *
 * Float64 throughout: the page reads exactly the values the simulation has
 * (the MCP observation, bots and the determinism tests compare them).
 */
import { AUDIO_MAX_QUEUED_COMMANDS, clampAlpha, DEFAULT_FIXED_STEP_HZ, EFFECT_MAX_QUEUED_REQUESTS, interpolateTransformInto, materialChangeKey, type TransformState } from '@thirdlight/runtime';
import { applyUiOutputToModel, mergeUiOutput, type DebugCommandState, type AnimatorPose, type AudioCommand, type CameraViewInfo, type Runtime, type RuntimeDiagnostics, type SceneSetView, type PointerSample, type UiOutput, type UiShownDocument, type ModeView } from '@thirdlight/runtime';
import { CAMERA_POSE_FLOATS, STEP_PAIR_STRIDE, TRANSFORM_STRIDE, type FrameState, type SceneEntities, type SceneSetWire } from './sim-protocol';

/** Send every transform when more than this share of the entities moved (the index list would cost more). */
const FULL_SHARE = 0.25;
/** Diagnostics ride along at least this often (frames) even when nothing notable changed. */
const DIAG_EVERY = 60;

type MutableFrame = { -readonly [K in keyof FrameState]: FrameState[K] };

type SharedGlobal = { SharedArrayBuffer?: new (n: number) => SharedArrayBuffer };

/** Worker side: builds one `FrameState` per frame from the real runtime. */
export class FrameEncoder {
  private ids: string[] = [];
  private scratchIds: string[] = [];
  private count = 0;
  private cur = new Float64Array(0);
  private last = new Float64Array(0);
  /** Scratch: the indices that moved this frame. */
  private readonly moved: number[] = [];
  private idsDirty = true;
  private readonly pool: ArrayBuffer[] = [];
  private hidden: string[] | null = null;
  /** The switched-off objects and the light overrides last sent. */
  private inactive: string[] | null = null;
  private lightsRef: unknown = null;
  /** The material swaps last sent ('': none). */
  private swapsKey = '';
  /** The cut-away state last sent (the runtime hands out a new object only when it changes). */
  private cutawaySent: unknown = null;
  /** The look overrides last sent ('': none). */
  private looksKey = '';
  private posesKey = '';
  private countersKey = '';
  /** The objects' health and the listed scene last sent. */
  private healthsKey = '';
  private listedSent = -2;
  /** The frame-rate cap last sent (undefined: none yet, so the first frame carries it). */
  private capSent: number | null | undefined = undefined;
  /** The camera pose scratch and whether a camera went out last frame. */
  private readonly camPos: number[] = [0, 0, 0];
  private readonly camRot: number[] = [0, 0, 0, 1];
  private camSent = false;
  /** The environment blend last sent. */
  private envRef: unknown = null;
  private envKey = '';
  /** The cursor request and the pointer last sent. */
  private cursorSent: 'free' | 'locked' | null = null;
  /** The mode view last sent (the runtime hands out the same object until it changes). */
  private modeSent: ModeView | null | undefined = undefined;
  private pointerSent: unknown = null;
  private sceneSetRef: SceneSetView | null = null;
  private readonly sentBatches = new Map<string, SceneEntities>();
  private readonly spawnTokens = new WeakMap<object, number>();
  private nextToken = 0;
  private framesSinceDiag = DIAG_EVERY;
  private diagState = '';
  private diagErrors = -1;
  private diagWanted = true;
  private memoryBytes = -1;
  private debugRevision = 0;
  /** The socket list last sent (the runtime keeps one array while nothing changes). */
  private socketsRef: readonly unknown[] | null = null;
  /** The timeline view last sent (the runtime keeps one object while nothing changes). */
  private timelineRef: unknown = null;
  /** The scene loading view last sent (the runtime keeps one object while nothing changes). */
  private loadingRef: unknown = null;
  private shared: { sab: SharedArrayBuffer; slotFloats: number; slot: number; fresh: boolean } | null = null;
  private readonly useShared: boolean;
  private readonly visit: (id: string, prev: TransformState, curr: TransformState) => void;
  /** Runtimes without step pairs: the interpolated transform as both steps. */
  private readonly visitOne: (id: string, p: readonly number[], r: readonly number[], s: readonly number[]) => void;

  constructor(opts: { shared: boolean }) {
    this.useShared = opts.shared && typeof (globalThis as SharedGlobal).SharedArrayBuffer === 'function';
    const row = (id: string): number => {
      const i = this.count;
      if (this.scratchIds.length <= i) this.scratchIds.push(id);
      else this.scratchIds[i] = id;
      if (!this.idsDirty && this.ids[i] !== id) this.idsDirty = true;
      const need = (i + 1) * STEP_PAIR_STRIDE;
      if (this.cur.length < need) {
        const grown = new Float64Array(Math.max(need, this.cur.length * 2, 64 * STEP_PAIR_STRIDE));
        grown.set(this.cur);
        this.cur = grown;
      }
      this.count = i + 1;
      return i * STEP_PAIR_STRIDE;
    };
    this.visit = (id, prev, curr) => {
      const o = row(id);
      writeTransform(this.cur, o, prev.position, prev.rotation, prev.scale);
      writeTransform(this.cur, o + TRANSFORM_STRIDE, curr.position, curr.rotation, curr.scale);
    };
    this.visitOne = (id, p, r, s) => {
      const o = row(id);
      writeTransform(this.cur, o, p, r, s);
      writeTransform(this.cur, o + TRANSFORM_STRIDE, p, r, s);
    };
  }

  /** The page returned a transform buffer it no longer reads. */
  give(buffer: ArrayBuffer): void {
    if (this.pool.length < 4) this.pool.push(buffer);
  }

  /** Include diagnostics in the next frame. */
  wantDiagnostics(): void {
    this.diagWanted = true;
  }

  get transport(): 'shared' | 'message' {
    return this.useShared ? 'shared' : 'message';
  }

  encode(rt: Runtime, seq: number, extra: { digests?: string[]; tickError?: { code: string; message: string }; memoryBytes?: number | null }): { state: FrameState; transfer: ArrayBuffer[] } {
    const transfer: ArrayBuffer[] = [];
    const d = rt.getDiagnostics();
    const diag = d.ok ? d.diagnostics : null;
    const out: MutableFrame = {
      seq,
      stepIndex: diag?.stepIndex ?? 0,
      simTime: diag?.simTime ?? 0,
      alpha: 0,
      rate: 0,
      frameCount: diag?.frameCount ?? 0,
      state: diag?.state ?? 'disposed',
      paused: rt.isPaused === true,
      debugHeld: rt.debugHeld === true,
    };
    // Transforms.
    this.count = 0;
    this.idsDirty = false;
    if (rt.forEachStepPair !== undefined) rt.forEachStepPair(this.visit);
    else if (rt.forEachInterpolated !== undefined) rt.forEachInterpolated(this.visitOne);
    else {
      const s = rt.getInterpolatedState();
      if (s.ok) for (const t of s.state.transforms) this.visitOne(t.id, t.position, t.rotation, t.scale);
    }
    const n = this.count;
    if (n !== this.ids.length) this.idsDirty = true;
    out.alpha = rt.interpolationAlpha ?? alphaOf(rt);
    out.rate = rt.forEachStepPair !== undefined ? (rt.interpolationRate ?? 0) : 0;
    if (this.idsDirty) {
      this.ids = this.scratchIds.slice(0, n);
      out.ids = this.ids;
    }
    const floats = n * STEP_PAIR_STRIDE;
    if (this.useShared) {
      if (this.shared === null || this.shared.slotFloats < floats) {
        const slotFloats = Math.max(floats, 64 * STEP_PAIR_STRIDE) * 2;
        const Sab = (globalThis as SharedGlobal).SharedArrayBuffer!;
        this.shared = { sab: new Sab(slotFloats * 2 * 8), slotFloats, slot: 1, fresh: true };
      }
      const sh = this.shared;
      sh.slot = 1 - sh.slot;
      new Float64Array(sh.sab, sh.slot * sh.slotFloats * 8, floats).set(this.cur.subarray(0, floats));
      out.xfShared = { slot: sh.slot, count: n, slotFloats: sh.slotFloats, ...(sh.fresh ? { buffer: sh.sab } : {}) };
      sh.fresh = false;
    }
    // Which entities moved since the last frame (the page places only those): known unless the order changed.
    const known = !this.idsDirty && this.last.length >= floats;
    const moved = this.moved;
    let changed = 0;
    if (known) {
      const c = this.cur;
      const l = this.last;
      for (let i = 0; i < n; i += 1) {
        const o = i * STEP_PAIR_STRIDE;
        for (let k = 0; k < STEP_PAIR_STRIDE; k += 1) {
          if (!Object.is(c[o + k], l[o + k])) {
            if (moved.length <= changed) moved.push(i);
            else moved[changed] = i;
            changed += 1;
            break;
          }
        }
      }
    }
    const movedList = (): Uint32Array => {
      const idx = new Uint32Array(changed);
      for (let j = 0; j < changed; j += 1) idx[j] = moved[j]!;
      transfer.push(idx.buffer as ArrayBuffer);
      return idx;
    };
    if (this.useShared) {
      if (known) out.xfMoved = movedList();
    } else {
      if (!known || changed > n * FULL_SHARE) {
        const buf = this.takeBuffer(floats * 8);
        const arr = new Float64Array(buf, 0, floats);
        arr.set(this.cur.subarray(0, floats));
        out.xf = arr;
        transfer.push(buf);
        if (known) out.xfMoved = movedList();
      } else if (changed > 0) {
        const idx = new Uint32Array(changed);
        const val = new Float64Array(changed * STEP_PAIR_STRIDE);
        for (let j = 0; j < changed; j += 1) {
          const i = moved[j]!;
          idx[j] = i;
          val.set(this.cur.subarray(i * STEP_PAIR_STRIDE, (i + 1) * STEP_PAIR_STRIDE), j * STEP_PAIR_STRIDE);
        }
        out.xfIdx = idx;
        out.xfVal = val;
        transfer.push(idx.buffer as ArrayBuffer, val.buffer as ArrayBuffer);
      }
    }
    if (this.last.length < floats) this.last = new Float64Array(Math.max(floats, this.cur.length));
    this.last.set(this.cur.subarray(0, floats));
    // Hidden entities.
    const hidden = rt.hiddenEntities?.();
    if (hidden !== undefined && !sameSet(hidden, this.hidden)) {
      this.hidden = [...hidden];
      out.hidden = this.hidden;
    }
    // The switched-off objects (audio sources go silent) and the light values scripts wrote.
    const inactive = rt.inactiveEntities?.();
    if (inactive !== undefined && !sameSet(inactive, this.inactive ?? [])) {
      this.inactive = [...inactive];
      out.inactive = this.inactive;
    }
    const lights = rt.lightOverrides?.();
    if (lights !== undefined && (lights.size > 0 || this.lightsRef !== null)) {
      const key = lights.size === 0 ? null : JSON.stringify([...lights]);
      if (key !== this.lightsRef) {
        this.lightsRef = key;
        out.lights = [...lights].map(([id, l]) => [id, { ...l }] as const);
      }
    }
    // The material swaps (only when they changed; never for a game that made none).
    const swapEntities = rt.materialSwaps?.();
    const swapBlocks = rt.blockMaterialSwaps?.();
    if ((swapEntities !== undefined && swapEntities.size > 0) || (swapBlocks !== undefined && swapBlocks.size > 0) || this.swapsKey !== '') {
      const swaps = { entities: [...(swapEntities ?? [])].map(([id, m]) => [id, { ...m }] as const), blocks: [...(swapBlocks ?? [])].map(([id, m]) => [id, { ...m }] as const) };
      const key = swaps.entities.length === 0 && swaps.blocks.length === 0 ? '' : JSON.stringify(swaps);
      if (key !== this.swapsKey) {
        this.swapsKey = key;
        out.swaps = swaps;
      }
    }
    // What scripts set for the cut-aways (only when it changed).
    const cutaway = rt.blockCutaways?.();
    if (cutaway !== undefined && cutaway !== this.cutawaySent) {
      if (this.cutawaySent !== null || cutaway.subject !== null || cutaway.forced.length > 0) out.cutaway = cutaway;
      this.cutawaySent = cutaway;
    }
    // The look overrides (only when they changed; never for a game that set none).
    const looks = rt.entityLooks?.();
    if (looks !== undefined && (looks.size > 0 || this.looksKey !== '')) {
      const entries = [...looks].map(([id, l]) => [id, { ...l }] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const key = entries.length === 0 ? '' : JSON.stringify(entries);
      if (key !== this.looksKey) {
        this.looksKey = key;
        out.looks = entries;
      }
    }
    const posesMap = (rt as { animatorPoses?: () => ReadonlyMap<string, AnimatorPose> }).animatorPoses?.();
    if (posesMap !== undefined && (posesMap.size > 0 || this.posesKey !== '')) {
      const poses = [...posesMap].map(([id, p]) => [id, p] as const);
      const key = poses.length === 0 ? '' : JSON.stringify(poses);
      if (key !== this.posesKey) {
        this.posesKey = key;
        out.poses = poses;
      }
    }
    const counters = rt.gameCounters?.();
    if (counters !== undefined) {
      const key = JSON.stringify(counters);
      if (key !== this.countersKey) {
        this.countersKey = key;
        out.counters = counters;
      }
    }
    const healths = rt.healthsView?.();
    if (healths !== undefined) {
      const key = JSON.stringify(healths);
      if (key !== this.healthsKey) {
        this.healthsKey = key;
        out.healths = healths;
      }
    }
    const listed = rt.listedSceneIndex?.();
    if (listed !== undefined && listed !== this.listedSent) {
      this.listedSent = listed;
      out.listed = listed;
    }
    const cap = rt.frameRateCap?.();
    if (cap !== undefined && cap !== this.capSent) {
      this.capSent = cap;
      out.frameRateCap = cap;
    }
    // The scene set (loaded batches, statuses, spawned entities).
    const set = rt.sceneSet?.();
    if (set !== undefined && set !== this.sceneSetRef) {
      this.sceneSetRef = set;
      const batches: SceneSetWire['batches'][number][] = [];
      const present = new Set<string>();
      for (const b of set.batches) {
        present.add(b.sceneId);
        const sent = this.sentBatches.get(b.sceneId);
        // The runtime's own refusal of an unload (the page's mirror refuses it the same way).
        const pinned = rt.sceneRequestProblem?.('unload', b.sceneId) ?? null;
        const head = { sceneId: b.sceneId, start: b.start, ...(pinned !== null ? { pinned } : {}) };
        if (sent === b.entities) batches.push(head);
        else {
          this.sentBatches.set(b.sceneId, b.entities);
          batches.push({ ...head, entities: b.entities });
        }
      }
      for (const id of [...this.sentBatches.keys()]) if (!present.has(id)) this.sentBatches.delete(id);
      const spawned = set.spawned.map((e) => {
        const known = this.spawnTokens.get(e);
        if (known !== undefined) return { k: known };
        const k = (this.nextToken += 1);
        this.spawnTokens.set(e, k);
        return { k, e };
      });
      out.sceneSet = { revision: set.revision, status: set.status, batches, spawned };
    }
    const audio = rt.takeAudioRequests?.() ?? [];
    if (audio.length > 0) out.audio = audio;
    const effects = rt.takeEffectRequests?.() ?? [];
    if (effects.length > 0) out.effects = effects;
    // The main view as the camera brain resolved it (from the first step on).
    const camView = rt.cameraView?.() ?? null;
    if (camView !== null) {
      // The view at both steps (a runtime without them: its interpolated view twice).
      const pose: number[] = [];
      for (const alpha of [0, 1]) {
        const lens = rt.readCameraViewAt !== undefined ? rt.readCameraViewAt(alpha, this.camPos, this.camRot) : (rt.readCameraView?.(this.camPos, this.camRot) ?? null);
        if (lens === null) break;
        pose.push(...this.camPos, ...this.camRot, lens.fovY, lens.near, lens.far, lens.letterbox);
      }
      if (pose.length === 2 * CAMERA_POSE_FLOATS) out.cam = { pose, view: camView };
    } else if (this.camSent) out.cam = null;
    this.camSent = camView !== null;
    // Project save requests (the page carries them out).
    const saveReq = rt.takeSaveRequests?.() ?? [];
    if (saveReq.length > 0) out.saveReq = saveReq;
    // Problems for the author (the page relays them to Play's Problems).
    const problems = rt.takeProblems?.() ?? [];
    if (problems.length > 0) out.problems = problems;
    // Scripts' asset loads and releases (the page holds the assets).
    const assetReq = rt.takeAssetRequests?.() ?? [];
    if (assetReq.length > 0) out.assetReq = assetReq;
    // Block-layer chunks the simulation changed.
    const grid = rt.takeGridChanges?.() ?? [];
    if (grid.length > 0) out.grid = grid;
    // Material parameters scripts changed (a data grid's bytes travel as a transfer).
    const mat = rt.takeMaterialChanges?.() ?? [];
    if (mat.length > 0) {
      out.mat = mat;
      for (const c of mat) if (c.op === 'data') transfer.push(c.bytes.buffer as ArrayBuffer);
    }
    // The environment blend (when it changed since the last frame).
    const env = rt.readEnvironmentBlend?.() ?? null;
    if (env !== this.envRef) {
      this.envRef = env;
      const key = env === null ? '' : JSON.stringify(env);
      if (key !== this.envKey) {
        this.envKey = key;
        out.env = env;
      }
    }
    // The scripts' binding requests (the page's host carries them out).
    const rb = rt.takeBindingRequests?.();
    if (rb !== undefined && (rb.requests.length > 0 || rb.dropped > 0)) out.rb = rb;
    // The project UI's diff of the steps since the last frame.
    const ui = rt.takeUiOutput?.() ?? null;
    if (ui !== null) out.ui = ui;
    // The game modes (when they changed).
    const mode = rt.modeView?.() ?? null;
    if (mode !== this.modeSent) {
      out.mode = mode;
      this.modeSent = mode;
    }
    // The cursor a script asked for, and the pointer state (each when it changed).
    const cursor = rt.cursorRequest?.() ?? null;
    if (cursor !== this.cursorSent) {
      out.cursor = cursor;
      this.cursorSent = cursor;
    }
    const pointer = rt.readPointer?.() ?? null;
    if (pointer !== this.pointerSent) {
      out.pointer = pointer;
      this.pointerSent = pointer;
    }
    // Diagnostics: on a change of state or error count, on request, and now and then.
    this.framesSinceDiag += 1;
    if (diag !== null && (this.diagWanted || diag.state !== this.diagState || diag.errorCount !== this.diagErrors || this.framesSinceDiag >= DIAG_EVERY)) {
      this.diagWanted = false;
      this.diagState = diag.state;
      this.diagErrors = diag.errorCount;
      this.framesSinceDiag = 0;
      out.diag = diag;
    }
    if (extra.digests !== undefined && extra.digests.length > 0) out.digests = extra.digests;
    if (extra.tickError !== undefined) out.tickError = extra.tickError;
    // The debug commands, when a script declared one or a call ran.
    const dbg = rt.debugCommandState?.();
    if (dbg !== undefined && dbg.revision !== this.debugRevision) {
      this.debugRevision = dbg.revision;
      out.debugCommands = dbg;
    }
    // The objects riding on sockets (only when the list changed; never for a game without them).
    const sockets = rt.socketAttachments?.();
    if (sockets !== undefined && sockets !== this.socketsRef && (sockets.length > 0 || this.socketsRef !== null)) {
      this.socketsRef = sockets;
      out.sockets = sockets;
    }
    // The timelines' view (only when it changed; never for a game that played none).
    const tl = rt.timelineView?.() ?? null;
    if (tl !== this.timelineRef) {
      this.timelineRef = tl;
      out.tl = tl;
    }
    // Scene loading (the scenes loading, a transition waiting, its swap) when it changed.
    const sl = rt.sceneLoadingView?.();
    if (sl !== undefined && sl !== this.loadingRef) {
      this.loadingRef = sl;
      out.sl = sl;
    }
    if (typeof extra.memoryBytes === 'number' && extra.memoryBytes !== this.memoryBytes) {
      this.memoryBytes = extra.memoryBytes;
      out.memoryBytes = extra.memoryBytes;
    }
    return { state: out, transfer };
  }

  private takeBuffer(bytes: number): ArrayBuffer {
    for (let i = 0; i < this.pool.length; i += 1) {
      const b = this.pool[i]!;
      if (b.byteLength >= bytes && b.byteLength <= bytes * 2) {
        this.pool.splice(i, 1);
        return b;
      }
    }
    return new ArrayBuffer(bytes);
  }
}

function writeTransform(out: Float64Array, o: number, p: readonly number[], r: readonly number[], s: readonly number[]): void {
  out[o] = p[0]!;
  out[o + 1] = p[1]!;
  out[o + 2] = p[2]!;
  out[o + 3] = r[0]!;
  out[o + 4] = r[1]!;
  out[o + 5] = r[2]!;
  out[o + 6] = r[3]!;
  out[o + 7] = s[0]!;
  out[o + 8] = s[1]!;
  out[o + 9] = s[2]!;
}

function sameSet(set: ReadonlySet<string>, arr: readonly string[] | null): boolean {
  if (arr === null) return false;
  if (set.size !== arr.length) return false;
  for (const id of arr) if (!set.has(id)) return false;
  return true;
}

/** The interpolation alpha of the last frame (from the interpolated state; 0 when unavailable). */
function alphaOf(rt: Runtime): number {
  const s = rt.getInterpolatedState();
  return s.ok ? s.state.alpha : 0;
}

/** Page side: the mirrored state the page's runtime view reads. */
export class FrameMirror {
  seq = 0;
  stepIndex = 0;
  simTime = 0;
  /** The alpha the page draws with now (`present`): where its clock falls between the last two steps. */
  alpha = 0;
  /** The fixed step's length (seconds): how far a wall second moves the alpha. */
  stepSeconds = 1 / DEFAULT_FIXED_STEP_HZ;
  /** The applied frame's tick alpha and rate, and the page time (seconds) it was applied at. */
  private tickAlpha = 0;
  private rate = 0;
  private appliedAt = 0;
  frameCount = 0;
  state: RuntimeDiagnostics['state'] = 'running';
  paused = false;
  debugHeld = false;
  /**
   * A pause or hold the page set that frames already computed cannot show:
   * the worker takes the command after the ticks sent before it, so frames
   * answering those ticks (seq ≤ `untilSeq`) still carry the old value and
   * must not overwrite the page's.
   */
  private pausedSet: { value: boolean; untilSeq: number } | null = null;
  private heldSet: { value: boolean; untilSeq: number } | null = null;
  ids: readonly string[] = [];
  index = new Map<string, number>();
  xf: Float64Array<ArrayBufferLike> = new Float64Array(0);
  hidden: ReadonlySet<string> = new Set();
  /** The switched-off objects and the light values scripts wrote. */
  inactive: ReadonlySet<string> = new Set();
  lights: ReadonlyMap<string, import('@thirdlight/runtime').LightOverride> = new Map();
  /** The material swaps of objects and of block types. */
  swapEntities: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map();
  swapBlocks: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map();
  /** What scripts set for the block layers' cut-aways. */
  cutaway: import('@thirdlight/runtime').GridCutawayState = { subject: null, forced: [] };
  /** The look overrides. */
  looks: ReadonlyMap<string, { readonly emissive?: string; readonly emissiveIntensity?: number; readonly tint?: string }> = new Map();
  poses: ReadonlyMap<string, AnimatorPose> = new Map();
  counters: { counters: Record<string, number>; health: { current: number; max: number } | null } = { counters: {}, health: null };
  /** Every object's health; the listed scene entry. */
  healths: Readonly<Record<string, { readonly current: number; readonly max: number }>> = {};
  listed = -1;
  sceneSet: SceneSetView | null = null;
  readonly batchEntities = new Map<string, SceneEntities>();
  /** Loaded scenes the runtime refuses to unload, and why. */
  pinned = new Map<string, string>();
  private spawnedByToken = new Map<number, SceneEntities[number]>();
  audio: AudioCommand[] = [];
  effects: unknown[] = [];
  /** The resolved camera of the last frame (null: no virtual camera). */
  cam: { readonly pose: readonly number[]; readonly view: CameraViewInfo } | null = null;
  /** Block-layer chunk changes not taken yet, the latest per chunk (bounded by the chunks). */
  grid = new Map<string, import('@thirdlight/runtime').GridRenderChange>();
  /** The latest material change per object, material and parameter, until the adapter takes them. */
  mat = new Map<string, import('@thirdlight/runtime').MaterialRenderChange>();
  /** The environment blend of the last frame that carried one (null: none yet). */
  env: import('@thirdlight/runtime').EnvironmentBlendView | null = null;
  /** Project save requests not carried out yet (the host takes them every frame). */
  saveReq: import('@thirdlight/runtime').SaveRequest[] = [];
  /** Asset loads and releases not carried out yet (the host takes them every frame). */
  assetReq: import('@thirdlight/runtime').AssetHandleRequest[] = [];
  /** Problems the simulation raised, not relayed yet. */
  problems: { code: string; message: string }[] = [];
  /** Binding requests not taken by the host yet (at most 32 wait). */
  bindingRequests: import('@thirdlight/runtime').InputBindingRequest[] = [];
  bindingDropped = 0;
  /** The project UI's changes the page host has not taken yet, and the mirrored view model and shown documents. */
  ui: UiOutput | null = null;
  uiModel: Record<string, unknown> = {};
  uiShown: readonly UiShownDocument[] = [];
  /** The worker's cursor request and pointer. */
  cursor: 'free' | 'locked' | null = null;
  pointer: PointerSample | null = null;
  diag: RuntimeDiagnostics | null = null;
  memoryBytes = 0;
  debugCommands: DebugCommandState | null = null;
  /** The game modes as of the last frame (null: none). */
  mode: ModeView | null = null;
  /** The objects riding on sockets. */
  sockets: readonly { readonly entityId: string; readonly target: string; readonly node: string }[] = Object.freeze([]);
  /** The timelines' view. */
  timeline: import('@thirdlight/runtime').TimelineView | null = null;
  /** Scene loading (absent until the worker sent it). */
  loading: import('@thirdlight/runtime').SceneLoadingView | undefined = undefined;
  private sharedSab: SharedArrayBuffer | null = null;
  /** The previous full transform buffer (returned to the worker for reuse). */
  spare: ArrayBuffer | null = null;
  /** The transform indices that changed since the presenter last read them (or every one). */
  private movedRows = new Uint8Array(0);
  private movedList: number[] = [];
  private allMoved = true;
  /** The rows whose two steps differ: they move between draws as the alpha moves. */
  private motionRows = new Uint8Array(0);
  private motionList: number[] = [];
  /** The alpha the presenter last read the moving rows at. */
  private alphaTaken = Number.NaN;
  /** Per-row marks of the rows one `takeMoved` call visited (no row twice). */
  private visitedAt = new Uint32Array(0);
  private visitRound = 0;
  private readonly scratchPrev = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
  private readonly scratchCurr = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

  /**
   * Draw at page time `now` (seconds): the alpha moves on from the applied
   * frame's by the wall time since it was applied, at its rate, and stops at
   * the last finished step (the page never draws a step the worker has not
   * finished: the alpha stays below 1, the runtime's invariant). At the
   * frame's own time it is the worker's alpha exactly.
   */
  present(now: number): void {
    const moved = this.rate > 0 && now > this.appliedAt ? ((now - this.appliedAt) * this.rate) / this.stepSeconds : 0;
    this.alpha = clampAlpha(this.tickAlpha + moved);
  }

  /** The page paused or resumed the game; `lastTickSeq` is the newest tick sent before the command. */
  setPaused(paused: boolean, lastTickSeq: number): void {
    this.paused = paused;
    this.pausedSet = { value: paused, untilSeq: lastTickSeq };
  }

  /** The page held or released the game for the debugger (as `setPaused`). */
  setDebugHeld(held: boolean, lastTickSeq: number): void {
    this.debugHeld = held;
    this.heldSet = { value: held, untilSeq: lastTickSeq };
  }

  /** The number of rows the transform array holds. */
  rowCount(): number {
    return Math.min(this.ids.length, Math.floor(this.xf.length / STEP_PAIR_STRIDE));
  }

  /** Row `i` at the draw alpha into the caller's arrays (the runtime's interpolation rule). */
  readRow(i: number, position: number[], rotation: number[], scale: number[]): void {
    const o = i * STEP_PAIR_STRIDE;
    readTransform(this.xf, o, this.scratchPrev);
    readTransform(this.xf, o + TRANSFORM_STRIDE, this.scratchCurr);
    interpolateTransformInto(position, rotation, scale, this.scratchPrev, this.scratchCurr, this.alpha);
  }

  /** Row `i`'s last finished step (not blended). */
  readCommittedRow(i: number, position: number[], rotation: number[], scale: number[]): void {
    readTransform(this.xf, i * STEP_PAIR_STRIDE + TRANSFORM_STRIDE, this.scratchCurr);
    interpolateTransformInto(position, rotation, scale, this.scratchCurr, this.scratchCurr, 0);
  }

  /**
   * Visit the indices whose transform changed since the last call (every
   * index after the entity order changed), then forget them.
   */
  takeMoved(visit: (index: number) => void, count: number): void {
    const alphaMoved = !Object.is(this.alpha, this.alphaTaken);
    this.alphaTaken = this.alpha;
    if (this.allMoved) {
      this.allMoved = false;
      for (const i of this.movedList) this.movedRows[i] = 0;
      this.movedList.length = 0;
      for (let i = 0; i < count; i += 1) visit(i);
      return;
    }
    if (this.visitedAt.length < count) this.visitedAt = new Uint32Array(Math.max(count, this.visitedAt.length * 2, 64));
    const round = (this.visitRound = (this.visitRound + 1) >>> 0 || 1);
    const list = this.movedList;
    for (let k = 0; k < list.length; k += 1) {
      const i = list[k]!;
      this.movedRows[i] = 0;
      if (i < count) {
        this.visitedAt[i] = round;
        visit(i);
      }
    }
    list.length = 0;
    // The rows between two different steps move with the alpha; the others stand still.
    const motion = this.motionList;
    let kept = 0;
    for (let k = 0; k < motion.length; k += 1) {
      const i = motion[k]!;
      if (this.motionRows[i] !== 1) continue;
      motion[kept++] = i;
      if (alphaMoved && i < count && this.visitedAt[i] !== round) visit(i);
    }
    motion.length = kept;
  }

  /** Note whether row `i`'s two steps differ (it moves between draws). */
  private noteMotion(i: number): void {
    if (i >= this.motionRows.length) {
      const grown = new Uint8Array(Math.max(i + 1, this.motionRows.length * 2, 64));
      grown.set(this.motionRows);
      this.motionRows = grown;
    }
    const o = i * STEP_PAIR_STRIDE;
    const x = this.xf;
    let differs = false;
    for (let k = 0; k < TRANSFORM_STRIDE; k += 1) {
      if (!Object.is(x[o + k], x[o + TRANSFORM_STRIDE + k])) {
        differs = true;
        break;
      }
    }
    if (differs && this.motionRows[i] !== 1) this.motionList.push(i);
    this.motionRows[i] = differs ? 1 : 0;
  }

  private noteMoved(indices: Uint32Array): void {
    if (this.allMoved) return;
    for (let k = 0; k < indices.length; k += 1) {
      const i = indices[k]!;
      if (i >= this.movedRows.length) {
        const grown = new Uint8Array(Math.max(i + 1, this.movedRows.length * 2, 64));
        grown.set(this.movedRows);
        this.movedRows = grown;
      }
      if (this.movedRows[i] === 1) continue;
      this.movedRows[i] = 1;
      this.movedList.push(i);
    }
  }

  /** Apply one frame of the worker at page time `now` (seconds; the draw clock starts there). */
  apply(s: FrameState, now = 0): void {
    this.seq = s.seq;
    this.stepIndex = s.stepIndex;
    this.simTime = s.simTime;
    this.tickAlpha = s.alpha;
    this.rate = s.rate;
    this.appliedAt = now;
    this.alpha = s.alpha;
    this.frameCount = s.frameCount;
    this.state = s.state;
    if (this.pausedSet !== null && s.seq <= this.pausedSet.untilSeq) this.paused = this.pausedSet.value;
    else {
      this.pausedSet = null;
      this.paused = s.paused;
    }
    if (this.heldSet !== null && s.seq <= this.heldSet.untilSeq) this.debugHeld = this.heldSet.value;
    else {
      this.heldSet = null;
      this.debugHeld = s.debugHeld;
    }
    if (s.ids !== undefined) {
      this.ids = s.ids;
      this.index = new Map(s.ids.map((id, i) => [id, i]));
    }
    // What moved since the presenter last read it (`takeMoved`).
    if (s.xfIdx !== undefined) this.noteMoved(s.xfIdx);
    else if (s.xf !== undefined || s.xfShared !== undefined) {
      if (s.xfMoved !== undefined && s.ids === undefined) this.noteMoved(s.xfMoved);
      else this.allMoved = true;
    }
    if (s.xf !== undefined) {
      // The replaced buffer goes back to the worker with the next tick (no garbage per frame).
      if (this.xf.byteLength > 0 && this.spare === null && !isShared(this.xf.buffer)) this.spare = this.xf.buffer as ArrayBuffer;
      this.xf = s.xf;
    } else if (s.xfIdx !== undefined && s.xfVal !== undefined) {
      const xf = this.xf;
      for (let j = 0; j < s.xfIdx.length; j += 1) xf.set(s.xfVal.subarray(j * STEP_PAIR_STRIDE, (j + 1) * STEP_PAIR_STRIDE), s.xfIdx[j]! * STEP_PAIR_STRIDE);
    } else if (s.xfShared !== undefined) {
      if (s.xfShared.buffer !== undefined) this.sharedSab = s.xfShared.buffer;
      if (this.sharedSab !== null) this.xf = new Float64Array(this.sharedSab, s.xfShared.slot * s.xfShared.slotFloats * 8, s.xfShared.count * STEP_PAIR_STRIDE);
    }
    // Which rows move between draws: the changed ones again, every one when the order or all of them changed.
    const rows = this.rowCount();
    const changed = s.xfIdx ?? (s.ids === undefined ? s.xfMoved : undefined);
    if (changed !== undefined) {
      for (let k = 0; k < changed.length; k += 1) if (changed[k]! < rows) this.noteMotion(changed[k]!);
    } else if (s.xf !== undefined || s.xfShared !== undefined || s.ids !== undefined) {
      this.motionRows.fill(0);
      this.motionList.length = 0;
      for (let i = 0; i < rows; i += 1) this.noteMotion(i);
    }
    if (s.hidden !== undefined) this.hidden = new Set(s.hidden);
    if (s.inactive !== undefined) this.inactive = new Set(s.inactive);
    if (s.lights !== undefined) this.lights = new Map(s.lights);
    if (s.swaps !== undefined) {
      this.swapEntities = new Map(s.swaps.entities);
      this.swapBlocks = new Map(s.swaps.blocks);
    }
    if (s.cutaway !== undefined) this.cutaway = s.cutaway;
    if (s.looks !== undefined) this.looks = new Map(s.looks);
    if (s.poses !== undefined) this.poses = new Map(s.poses);
    if (s.counters !== undefined) this.counters = s.counters;
    if (s.healths !== undefined) this.healths = s.healths;
    if (s.listed !== undefined) this.listed = s.listed;
    if (s.sceneSet !== undefined) {
      const w = s.sceneSet;
      const present = new Set<string>();
      this.pinned = new Map(w.batches.filter((b) => b.pinned !== undefined).map((b) => [b.sceneId, b.pinned!]));
      const batches = w.batches.map((b) => {
        present.add(b.sceneId);
        if (b.entities !== undefined) this.batchEntities.set(b.sceneId, b.entities);
        return Object.freeze({ sceneId: b.sceneId, start: b.start, entities: this.batchEntities.get(b.sceneId) ?? [] });
      });
      for (const id of [...this.batchEntities.keys()]) if (!present.has(id)) this.batchEntities.delete(id);
      const tokens = new Map<number, SceneEntities[number]>();
      const spawned: SceneEntities[number][] = [];
      for (const s of w.spawned) {
        const e = s.e !== undefined ? deepFreeze(s.e) : this.spawnedByToken.get(s.k);
        if (e === undefined) continue;
        tokens.set(s.k, e);
        spawned.push(e);
      }
      this.spawnedByToken = tokens;
      this.sceneSet = Object.freeze({ revision: w.revision, batches: Object.freeze(batches), status: Object.freeze({ ...w.status }), spawned: Object.freeze(spawned) }) as unknown as SceneSetView;
    }
    // Bounded like the runtime's own queues (the newest 256 audio commands, the newest
    // 256 effect requests): a page that does not take them (headless, no adapter) never grows.
    if (s.audio !== undefined) {
      for (const a of s.audio) this.audio.push(a);
      if (this.audio.length > MIRROR_AUDIO_LIMIT) this.audio.splice(0, this.audio.length - MIRROR_AUDIO_LIMIT);
    }
    if (s.effects !== undefined) {
      for (const e of s.effects) this.effects.push(e);
      if (this.effects.length > MIRROR_EFFECT_LIMIT) this.effects.splice(0, this.effects.length - MIRROR_EFFECT_LIMIT);
    }
    if (s.cam !== undefined) this.cam = s.cam;
    if (s.env !== undefined) this.env = s.env;
    if (s.saveReq !== undefined) for (const r of s.saveReq) this.saveReq.push(r);
    if (s.assetReq !== undefined) for (const r of s.assetReq) this.assetReq.push(r);
    if (s.problems !== undefined) for (const p of s.problems) this.problems.push(p);
    if (s.grid !== undefined) for (const g of s.grid) this.grid.set(`${g.entityId}|${g.cx},${g.cz}`, g);
    if (s.mat !== undefined) {
      for (const c of s.mat) {
        const k = materialChangeKey(c);
        this.mat.delete(k);
        this.mat.set(k, c);
      }
    }
    if (s.rb !== undefined) {
      for (const r of s.rb.requests) {
        if (this.bindingRequests.length < 32) this.bindingRequests.push(r);
        else this.bindingDropped += 1;
      }
      this.bindingDropped += s.rb.dropped;
    }
    if (s.ui !== undefined) {
      this.ui = mergeUiOutput(this.ui, s.ui);
      this.uiModel = applyUiOutputToModel(this.uiModel, s.ui);
      if (s.ui.shown !== undefined) this.uiShown = s.ui.shown;
    }
    if (s.cursor !== undefined) this.cursor = s.cursor;
    if (s.pointer !== undefined) this.pointer = s.pointer;
    if (s.diag !== undefined) this.diag = s.diag;
    if (s.memoryBytes !== undefined) this.memoryBytes = s.memoryBytes;
    if (s.debugCommands !== undefined) this.debugCommands = s.debugCommands;
    if (s.mode !== undefined) this.mode = s.mode;
    if (s.sockets !== undefined) this.sockets = deepFreeze(s.sockets);
    if (s.tl !== undefined) this.timeline = s.tl === null ? null : deepFreeze(s.tl);
    if (s.sl !== undefined) this.loading = deepFreeze(s.sl);
  }
}

/** The runtime's own bounds for queued sound and effect requests. */
export const MIRROR_AUDIO_LIMIT = AUDIO_MAX_QUEUED_COMMANDS;
export const MIRROR_EFFECT_LIMIT = EFFECT_MAX_QUEUED_REQUESTS;

function readTransform(x: ArrayLike<number>, o: number, out: { position: number[]; rotation: number[]; scale: number[] }): void {
  out.position[0] = x[o]!;
  out.position[1] = x[o + 1]!;
  out.position[2] = x[o + 2]!;
  out.rotation[0] = x[o + 3]!;
  out.rotation[1] = x[o + 4]!;
  out.rotation[2] = x[o + 5]!;
  out.rotation[3] = x[o + 6]!;
  out.scale[0] = x[o + 7]!;
  out.scale[1] = x[o + 8]!;
  out.scale[2] = x[o + 9]!;
}

function isShared(b: ArrayBufferLike): boolean {
  const Sab = (globalThis as SharedGlobal).SharedArrayBuffer;
  return typeof Sab === 'function' && b instanceof Sab;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}
