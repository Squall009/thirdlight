/**
 * Phase 22.0: the per-frame state of the simulation worker, encoded in the
 * worker (`FrameEncoder`) and mirrored in the page (`FrameMirror`).
 *
 * The encoder sends only what changed since the last frame: transforms as one
 * transferred `Float64Array` (all entities, or only the ones that moved when
 * few did), the committed game view when a step committed a new one, the
 * hidden/fading entities, animator poses, counters and the save state when
 * they differ, the scene set when the runtime rebuilt it (entities only for a
 * batch the page does not have yet), and the queued audio and effect requests.
 * With shared memory (a cross-origin-isolated page) the transforms go through
 * a two-slot SharedArrayBuffer instead: the page has at most one frame in
 * flight, so it reads one slot while the worker writes the other.
 *
 * Float64 throughout: the page reads exactly the values the simulation has
 * (the MCP observation, bots and the determinism tests compare them).
 */
import { materialChangeKey } from '@thirdlight/runtime';
import { applyUiOutputToModel, mergeUiOutput, type DebugCommandState, type AnimatorPose, type AudioCommand, type CameraViewInfo, type Runtime, type RuntimeDiagnostics, type SceneSetView, type PointerSample, type UiOutput, type UiShownDocument, type ModeView } from '@thirdlight/runtime';
import { TRANSFORM_STRIDE, type FrameState, type SceneEntities, type SceneSetWire } from './sim-protocol';

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
  private idsDirty = true;
  private readonly pool: ArrayBuffer[] = [];
  private hidden: string[] | null = null;
  /** Phase 24.4h: the look overrides last sent ('' : none). */
  private looksKey = '';
  private posesKey = '';
  private countersKey = '';
  /** Phase 24.4j: the objects' health and the listed scene last sent. */
  private healthsKey = '';
  private listedSent = -2;
  /** Phase 23.4: the camera pose scratch and whether a camera went out last frame. */
  private readonly camPos: number[] = [0, 0, 0];
  private readonly camRot: number[] = [0, 0, 0, 1];
  private camSent = false;
  /** Phase 23.18: the environment blend last sent. */
  private envRef: unknown = null;
  private envKey = '';
  /** Phase 23.3: the cursor request and the pointer last sent. */
  private cursorSent: 'free' | 'locked' | null = null;
  /** Phase 23.10: the mode view last sent (the runtime hands out the same object until it changes). */
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
  /** Phase 23.11: the socket list last sent (the runtime keeps one array while nothing changes). */
  private socketsRef: readonly unknown[] | null = null;
  /** Phase 23.17: the timeline view last sent (the runtime keeps one object while nothing changes). */
  private timelineRef: unknown = null;
  /** Phase 25.24e: the scene loading view last sent (the runtime keeps one object while nothing changes). */
  private loadingRef: unknown = null;
  private shared: { sab: SharedArrayBuffer; slotFloats: number; slot: number; fresh: boolean } | null = null;
  private readonly useShared: boolean;
  private readonly visit: (id: string, p: readonly number[], r: readonly number[], s: readonly number[]) => void;

  constructor(opts: { shared: boolean }) {
    this.useShared = opts.shared && typeof (globalThis as SharedGlobal).SharedArrayBuffer === 'function';
    this.visit = (id, p, r, s) => {
      const i = this.count;
      if (this.scratchIds.length <= i) this.scratchIds.push(id);
      else this.scratchIds[i] = id;
      if (!this.idsDirty && this.ids[i] !== id) this.idsDirty = true;
      const need = (i + 1) * TRANSFORM_STRIDE;
      if (this.cur.length < need) {
        const grown = new Float64Array(Math.max(need, this.cur.length * 2, 64 * TRANSFORM_STRIDE));
        grown.set(this.cur);
        this.cur = grown;
      }
      const o = i * TRANSFORM_STRIDE;
      const c = this.cur;
      c[o] = p[0]!;
      c[o + 1] = p[1]!;
      c[o + 2] = p[2]!;
      c[o + 3] = r[0]!;
      c[o + 4] = r[1]!;
      c[o + 5] = r[2]!;
      c[o + 6] = r[3]!;
      c[o + 7] = s[0]!;
      c[o + 8] = s[1]!;
      c[o + 9] = s[2]!;
      this.count = i + 1;
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
      frameCount: diag?.frameCount ?? 0,
      state: diag?.state ?? 'disposed',
      paused: rt.isPaused === true,
      debugHeld: rt.debugHeld === true,
    };
    // Transforms.
    this.count = 0;
    this.idsDirty = false;
    if (rt.forEachInterpolated !== undefined) rt.forEachInterpolated(this.visit);
    else {
      const s = rt.getInterpolatedState();
      if (s.ok) for (const t of s.state.transforms) this.visit(t.id, t.position, t.rotation, t.scale);
    }
    const n = this.count;
    if (n !== this.ids.length) this.idsDirty = true;
    out.alpha = rt.interpolationAlpha ?? alphaOf(rt);
    if (this.idsDirty) {
      this.ids = this.scratchIds.slice(0, n);
      out.ids = this.ids;
    }
    const floats = n * TRANSFORM_STRIDE;
    if (this.useShared) {
      if (this.shared === null || this.shared.slotFloats < floats) {
        const slotFloats = Math.max(floats, 64 * TRANSFORM_STRIDE) * 2;
        const Sab = (globalThis as SharedGlobal).SharedArrayBuffer!;
        this.shared = { sab: new Sab(slotFloats * 2 * 8), slotFloats, slot: 1, fresh: true };
      }
      const sh = this.shared;
      sh.slot = 1 - sh.slot;
      new Float64Array(sh.sab, sh.slot * sh.slotFloats * 8, floats).set(this.cur.subarray(0, floats));
      out.xfShared = { slot: sh.slot, count: n, slotFloats: sh.slotFloats, ...(sh.fresh ? { buffer: sh.sab } : {}) };
      sh.fresh = false;
    } else {
      let changed = 0;
      const moved: number[] = [];
      if (!this.idsDirty && this.last.length >= floats) {
        const c = this.cur;
        const l = this.last;
        for (let i = 0; i < n; i += 1) {
          const o = i * TRANSFORM_STRIDE;
          for (let k = 0; k < TRANSFORM_STRIDE; k += 1) {
            if (!Object.is(c[o + k], l[o + k])) {
              moved.push(i);
              changed += 1;
              break;
            }
          }
          if (changed > n * FULL_SHARE) break;
        }
      }
      if (this.idsDirty || this.last.length < floats || changed > n * FULL_SHARE) {
        const buf = this.takeBuffer(floats * 8);
        const arr = new Float64Array(buf, 0, floats);
        arr.set(this.cur.subarray(0, floats));
        out.xf = arr;
        transfer.push(buf);
      } else if (changed > 0) {
        const idx = new Uint32Array(changed);
        const val = new Float64Array(changed * TRANSFORM_STRIDE);
        for (let j = 0; j < changed; j += 1) {
          const i = moved[j]!;
          idx[j] = i;
          val.set(this.cur.subarray(i * TRANSFORM_STRIDE, (i + 1) * TRANSFORM_STRIDE), j * TRANSFORM_STRIDE);
        }
        out.xfIdx = idx;
        out.xfVal = val;
        transfer.push(idx.buffer as ArrayBuffer, val.buffer as ArrayBuffer);
      }
      if (this.last.length < floats) this.last = new Float64Array(Math.max(floats, this.cur.length));
      this.last.set(this.cur.subarray(0, floats));
    }
    // Hidden entities.
    const hidden = rt.hiddenEntities?.();
    if (hidden !== undefined && !sameSet(hidden, this.hidden)) {
      this.hidden = [...hidden];
      out.hidden = this.hidden;
    }
    // Phase 24.4h: the look overrides (only when they changed; never for a game that set none).
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
    // Phase 23.4: the resolved camera (only while the game has a virtual camera).
    const camView = rt.cameraView?.() ?? null;
    if (camView !== null) {
      const lens = rt.readCameraView?.(this.camPos, this.camRot) ?? null;
      if (lens !== null) out.cam = { pose: [...this.camPos, ...this.camRot, lens.fovY, lens.near, lens.far, lens.letterbox], view: camView };
    } else if (this.camSent) out.cam = null;
    this.camSent = camView !== null;
    // Phase 23.19: project save requests (the page carries them out).
    const saveReq = rt.takeSaveRequests?.() ?? [];
    if (saveReq.length > 0) out.saveReq = saveReq;
    // Phase 23.5: block-layer chunks the simulation changed.
    const grid = rt.takeGridChanges?.() ?? [];
    if (grid.length > 0) out.grid = grid;
    // Phase 23.12: material parameters scripts changed (a data grid's bytes travel as a transfer).
    const mat = rt.takeMaterialChanges?.() ?? [];
    if (mat.length > 0) {
      out.mat = mat;
      for (const c of mat) if (c.op === 'data') transfer.push(c.bytes.buffer as ArrayBuffer);
    }
    // Phase 23.18: the environment blend (when it changed since the last frame).
    const env = rt.readEnvironmentBlend?.() ?? null;
    if (env !== this.envRef) {
      this.envRef = env;
      const key = env === null ? '' : JSON.stringify(env);
      if (key !== this.envKey) {
        this.envKey = key;
        out.env = env;
      }
    }
    // Phase 23.14: the scripts' binding requests (the page's host carries them out).
    const rb = rt.takeBindingRequests?.();
    if (rb !== undefined && (rb.requests.length > 0 || rb.dropped > 0)) out.rb = rb;
    // Phase 23.9a: the project UI's diff of the steps since the last frame.
    const ui = rt.takeUiOutput?.() ?? null;
    if (ui !== null) out.ui = ui;
    // Phase 23.10: the game modes (when they changed).
    const mode = rt.modeView?.() ?? null;
    if (mode !== this.modeSent) {
      out.mode = mode;
      this.modeSent = mode;
    }
    // Phase 23.3: the cursor a script asked for, and the pointer state (each when it changed).
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
    // Phase 23.8: the debug commands, when a script declared one or a call ran.
    const dbg = rt.debugCommandState?.();
    if (dbg !== undefined && dbg.revision !== this.debugRevision) {
      this.debugRevision = dbg.revision;
      out.debugCommands = dbg;
    }
    // Phase 23.11: the objects riding on sockets (only when the list changed; never for a game without them).
    const sockets = rt.socketAttachments?.();
    if (sockets !== undefined && sockets !== this.socketsRef && (sockets.length > 0 || this.socketsRef !== null)) {
      this.socketsRef = sockets;
      out.sockets = sockets;
    }
    // Phase 23.17: the timelines' view (only when it changed; never for a game that played none).
    const tl = rt.timelineView?.() ?? null;
    if (tl !== this.timelineRef) {
      this.timelineRef = tl;
      out.tl = tl;
    }
    // Phase 25.24e: scene loading (the scenes loading, a transition waiting, its swap) when it changed.
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
  alpha = 0;
  frameCount = 0;
  state: RuntimeDiagnostics['state'] = 'running';
  paused = false;
  debugHeld = false;
  ids: readonly string[] = [];
  index = new Map<string, number>();
  xf: Float64Array<ArrayBufferLike> = new Float64Array(0);
  hidden: ReadonlySet<string> = new Set();
  /** Phase 24.4h: the look overrides. */
  looks: ReadonlyMap<string, { readonly emissive?: string; readonly emissiveIntensity?: number; readonly tint?: string }> = new Map();
  poses: ReadonlyMap<string, AnimatorPose> = new Map();
  counters: { counters: Record<string, number>; health: { current: number; max: number } | null } = { counters: {}, health: null };
  /** Phase 24.4j: every object's health; the listed scene entry. */
  healths: Readonly<Record<string, { readonly current: number; readonly max: number }>> = {};
  listed = -1;
  sceneSet: SceneSetView | null = null;
  readonly batchEntities = new Map<string, SceneEntities>();
  /** Loaded scenes the runtime refuses to unload, and why. */
  pinned = new Map<string, string>();
  private spawnedByToken = new Map<number, SceneEntities[number]>();
  audio: AudioCommand[] = [];
  effects: unknown[] = [];
  /** Phase 23.4: the resolved camera of the last frame (null: no virtual camera). */
  cam: { readonly pose: readonly number[]; readonly view: CameraViewInfo } | null = null;
  /** Phase 23.5: block-layer chunk changes not taken yet, the latest per chunk (bounded by the chunks). */
  grid = new Map<string, import('@thirdlight/runtime').GridRenderChange>();
  /** Phase 23.12: the latest material change per object, material and parameter, until the adapter takes them. */
  mat = new Map<string, import('@thirdlight/runtime').MaterialRenderChange>();
  /** Phase 23.18: the environment blend of the last frame that carried one (null: none yet). */
  env: import('@thirdlight/runtime').EnvironmentBlendView | null = null;
  /** Phase 23.19: project save requests not carried out yet (the host takes them every frame). */
  saveReq: import('@thirdlight/runtime').SaveRequest[] = [];
  /** Phase 23.14: binding requests not taken by the host yet (at most 32 wait). */
  bindingRequests: import('@thirdlight/runtime').InputBindingRequest[] = [];
  bindingDropped = 0;
  /** Phase 23.9a: the project UI's changes the page host has not taken yet, and the mirrored view model and shown documents. */
  ui: UiOutput | null = null;
  uiModel: Record<string, unknown> = {};
  uiShown: readonly UiShownDocument[] = [];
  /** Phase 23.3: the worker's cursor request and pointer. */
  cursor: 'free' | 'locked' | null = null;
  pointer: PointerSample | null = null;
  diag: RuntimeDiagnostics | null = null;
  memoryBytes = 0;
  debugCommands: DebugCommandState | null = null;
  /** Phase 23.10: the game modes as of the last frame (null: none). */
  mode: ModeView | null = null;
  /** Phase 23.11: the objects riding on sockets. */
  sockets: readonly { readonly entityId: string; readonly target: string; readonly node: string }[] = Object.freeze([]);
  /** Phase 23.17: the timelines' view. */
  timeline: import('@thirdlight/runtime').TimelineView | null = null;
  /** Phase 25.24e: scene loading (absent until the worker sent it). */
  loading: import('@thirdlight/runtime').SceneLoadingView | undefined = undefined;
  private sharedSab: SharedArrayBuffer | null = null;
  /** The previous full transform buffer (returned to the worker for reuse). */
  spare: ArrayBuffer | null = null;

  apply(s: FrameState): void {
    this.seq = s.seq;
    this.stepIndex = s.stepIndex;
    this.simTime = s.simTime;
    this.alpha = s.alpha;
    this.frameCount = s.frameCount;
    this.state = s.state;
    this.paused = s.paused;
    this.debugHeld = s.debugHeld;
    if (s.ids !== undefined) {
      this.ids = s.ids;
      this.index = new Map(s.ids.map((id, i) => [id, i]));
    }
    if (s.xf !== undefined) {
      // The replaced buffer goes back to the worker with the next tick (no garbage per frame).
      if (this.xf.byteLength > 0 && this.spare === null && !isShared(this.xf.buffer)) this.spare = this.xf.buffer as ArrayBuffer;
      this.xf = s.xf;
    } else if (s.xfIdx !== undefined && s.xfVal !== undefined) {
      const xf = this.xf;
      for (let j = 0; j < s.xfIdx.length; j += 1) xf.set(s.xfVal.subarray(j * TRANSFORM_STRIDE, (j + 1) * TRANSFORM_STRIDE), s.xfIdx[j]! * TRANSFORM_STRIDE);
    } else if (s.xfShared !== undefined) {
      if (s.xfShared.buffer !== undefined) this.sharedSab = s.xfShared.buffer;
      if (this.sharedSab !== null) this.xf = new Float64Array(this.sharedSab, s.xfShared.slot * s.xfShared.slotFloats * 8, s.xfShared.count * TRANSFORM_STRIDE);
    }
    if (s.hidden !== undefined) this.hidden = new Set(s.hidden);
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
    // Phase 21.5: bounded like the runtime's own queues (phase 23.13: the newest 256 audio commands, the newest
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

/** Phase 21.5: the runtime's own bounds for queued sound and effect requests (runtime.ts). */
export const MIRROR_AUDIO_LIMIT = 256;
export const MIRROR_EFFECT_LIMIT = 256;

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
