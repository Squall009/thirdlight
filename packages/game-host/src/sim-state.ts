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
import type { AnimatorPose, DebugCommandState, GameView, Runtime, RuntimeDiagnostics, SceneSetView } from '@thirdlight/runtime';
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
  private view: GameView | null | undefined = undefined;
  private hidden: string[] | null = null;
  private opacityKey = '';
  private posesKey = '';
  private countersKey = '';
  private runSaveKey = '';
  private runSaveStep = -1;
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
    // The committed game view (a new frozen object per committed step).
    const view = rt.peekGameView !== undefined ? rt.peekGameView() : (() => {
      const v = rt.getGameView();
      return v.ok ? v.view : null;
    })();
    if (view !== this.view) {
      this.view = view;
      out.view = view;
    }
    // Hidden and fading entities.
    const hidden = rt.hiddenEntities?.();
    if (hidden !== undefined && !sameSet(hidden, this.hidden)) {
      this.hidden = [...hidden];
      out.hidden = this.hidden;
    }
    const opacity = rt.entityOpacity?.();
    if (opacity !== undefined && (opacity.size > 0 || this.opacityKey !== '')) {
      const entries = [...opacity].map(([id, o]) => [id, o] as const);
      const key = entries.length === 0 ? '' : JSON.stringify(entries);
      if (key !== this.opacityKey) {
        this.opacityKey = key;
        out.opacity = entries;
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
    if (rt.runState !== undefined && out.stepIndex !== this.runSaveStep) {
      this.runSaveStep = out.stepIndex;
      const save = rt.runState();
      const key = JSON.stringify(save);
      if (key !== this.runSaveKey) {
        this.runSaveKey = key;
        out.runSave = save;
      }
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
  view: GameView | null = null;
  hidden: ReadonlySet<string> = new Set();
  opacity: ReadonlyMap<string, number> = new Map();
  poses: ReadonlyMap<string, AnimatorPose> = new Map();
  counters: { counters: Record<string, number>; health: { current: number; max: number } | null } = { counters: {}, health: null };
  runSave: unknown = null;
  sceneSet: SceneSetView | null = null;
  readonly batchEntities = new Map<string, SceneEntities>();
  /** Loaded scenes the runtime refuses to unload, and why. */
  pinned = new Map<string, string>();
  private spawnedByToken = new Map<number, SceneEntities[number]>();
  audio: { assetId: string; volume: number; stepIndex: number }[] = [];
  effects: unknown[] = [];
  diag: RuntimeDiagnostics | null = null;
  memoryBytes = 0;
  debugCommands: DebugCommandState | null = null;
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
    if (s.view !== undefined) this.view = s.view === null ? null : deepFreeze(s.view);
    if (s.hidden !== undefined) this.hidden = new Set(s.hidden);
    if (s.opacity !== undefined) this.opacity = new Map(s.opacity);
    if (s.poses !== undefined) this.poses = new Map(s.poses);
    if (s.counters !== undefined) this.counters = s.counters;
    if (s.runSave !== undefined) this.runSave = s.runSave;
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
    // Phase 21.5: bounded like the runtime's own queues (16 sounds, the newest 256 effect requests): a page
    // that does not take them (scene mode has no game view to drain sounds; headless, no adapter) never grows.
    if (s.audio !== undefined) for (const a of s.audio) if (this.audio.length < MIRROR_AUDIO_LIMIT) this.audio.push(a);
    if (s.effects !== undefined) {
      for (const e of s.effects) this.effects.push(e);
      if (this.effects.length > MIRROR_EFFECT_LIMIT) this.effects.splice(0, this.effects.length - MIRROR_EFFECT_LIMIT);
    }
    if (s.diag !== undefined) this.diag = s.diag;
    if (s.memoryBytes !== undefined) this.memoryBytes = s.memoryBytes;
    if (s.debugCommands !== undefined) this.debugCommands = s.debugCommands;
  }
}

/** Phase 21.5: the runtime's own bounds for queued sound and effect requests (runtime.ts). */
export const MIRROR_AUDIO_LIMIT = 16;
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
