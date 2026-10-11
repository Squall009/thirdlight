/**
 * Scripts' requests to the renderer that the simulation never reads back:
 * visual effects (`ctx.effects`, the `effect` component's signals) and
 * decals (`ctx.decals`: bullet holes, footprints, scorch marks). They are
 * recorded in step order and taken by the adapter each frame; nothing in the
 * simulation depends on them, so they are not part of its digest and a
 * replay is the same with or without a renderer taking them. Handles count
 * from 1 in every run: a script may keep one in its state, and a restarted
 * run must compute what the first one did. The restart's own request (a
 * clear, a stop of every script effect) comes first in the queue, so the
 * renderer has let go of the old run's handles before a new one arrives.
 *
 * A spawned decal is the decal of a prefab (its first object carrying a
 * `decal` component), resolved here so the page needs no prefab table: the
 * request carries the component, its box scaled, and where it goes. A run
 * restart clears the decals the run left.
 */
import { type DecalComponent, type PrefabDefinition, type Vec3 } from '@thirdlight/project-model';

import type { BehaviorDecals, BehaviorEffects, DecalRequest, EffectRequest } from './types-behavior';

/** Requests kept for a renderer that does not take them (headless): the newest this many of each kind. */
export const EFFECT_MAX_QUEUED_REQUESTS = 256;
/** Effect plays and decal spawns a script may ask for in one step, each (more are refused: a loop gone wrong never floods the renderer). */
export const PRESENTATION_MAX_REQUESTS_PER_STEP = 32;
/** A spawned decal's scale and lifetime (seconds) are clamped to these. */
export const DECAL_SPAWN_LIMITS = { scaleMin: 0.01, scaleMax: 100, lifetimeMax: 3600 } as const;

const EFFECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The problem a script's refused plays and spawns report. */
export const PRESENTATION_REFUSED = 'presentation_requests_refused';

/** A stop of every script effect (a run restart's): no handle, no entity. */
export const isStopAll = (r: Pick<EffectRequest, 'op' | 'handle' | 'entityId'>): boolean => r.op === 'stop' && r.handle === 0 && r.entityId === null;

const finite3 = (v: readonly unknown[] | undefined, d: Vec3): [number, number, number] => {
  const out: [number, number, number] = [d[0], d[1], d[2]];
  for (let k = 0; k < 3; k++) {
    const x = Number(v?.[k] ?? d[k]);
    out[k] = Number.isFinite(x) ? x : d[k]!;
  }
  return out;
};

/** The rotation taking the box's +Z (the side it projects from) onto the unit `n`, then `angle` degrees about it. */
function facing(n: [number, number, number], angle: number): [number, number, number, number] {
  const l = Math.hypot(n[0], n[1], n[2]);
  const [x, y, z] = l > 1e-9 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 1, 0];
  // Half-way quaternion from +Z to n (axis +Z × n); straight back: half a turn about +Y.
  let a: [number, number, number, number] = z < -0.999999 ? [0, 1, 0, 0] : [-y, x, 0, 1 + z];
  const la = Math.hypot(...a);
  a = [a[0] / la, a[1] / la, a[2] / la, a[3] / la];
  const h = (angle * Math.PI) / 360;
  const s = Math.sin(h);
  // Spun about the box's own Z first (the image turns on the surface), then turned onto the normal.
  const b: [number, number, number, number] = [0, 0, s, Math.cos(h)];
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}

/** The decal a prefab leaves: its first object's `decal` (null: none). */
export function prefabDecal(prefab: PrefabDefinition | undefined): DecalComponent | null {
  for (const e of prefab?.entities ?? []) {
    const d = (e.components as { decal?: DecalComponent }).decal;
    if (d !== undefined) return d;
  }
  return null;
}

export class PresentationRequests {
  private effectQueue: EffectRequest[] = [];
  private decalQueue: DecalRequest[] = [];
  /** The last handles handed out in this run. */
  private effectHandle = 0;
  private decalHandle = 0;
  /** The step the per-step counts are for, and the counts. */
  private countedStep = -1;
  private plays = 0;
  private spawns = 0;

  constructor(private readonly host: { readonly stepIndex: () => number; readonly prefab: (id: string) => PrefabDefinition | undefined; readonly problem?: (code: string, message: string) => void }) {}

  /** Keep the newest of a queue nobody takes; a run's first request (what clears the last run's) stays first. */
  private static trim<T extends { readonly op: string; readonly handle: number; readonly entityId: string | null }>(q: T[], isReset: (r: T) => boolean): void {
    if (q.length <= EFFECT_MAX_QUEUED_REQUESTS) return;
    const cut = q.splice(0, q.length - EFFECT_MAX_QUEUED_REQUESTS);
    for (let k = cut.length - 1; k >= 0; k--) {
      if (!isReset(cut[k]!)) continue;
      q.unshift(cut[k]!);
      break;
    }
  }

  /** Record an effect request (a script's, an effect component's signal); returns a play's handle. */
  pushEffect(r: Omit<EffectRequest, 'stepIndex' | 'handle'> & { handle?: number }): number {
    const handle = r.op === 'play' ? ++this.effectHandle : (r.handle ?? 0);
    const req: EffectRequest = Object.freeze({ ...r, handle, stepIndex: this.host.stepIndex() + 1, position: Object.freeze([r.position[0], r.position[1], r.position[2]]) as unknown as readonly [number, number, number] });
    this.effectQueue.push(req);
    // Nobody takes them (no renderer, e.g. a headless run): keep only the newest.
    PresentationRequests.trim(this.effectQueue, isStopAll);
    return handle;
  }

  private pushDecal(r: Omit<DecalRequest, 'stepIndex'>): void {
    this.decalQueue.push(Object.freeze({ ...r, stepIndex: this.host.stepIndex() + 1 }));
    PresentationRequests.trim(this.decalQueue, (q) => q.op === 'clear');
  }

  /** Whether one more request of a kind fits this step (and counts it). */
  private allow(kind: 'plays' | 'spawns'): boolean {
    const step = this.host.stepIndex();
    if (this.countedStep !== step) {
      this.countedStep = step;
      this.plays = 0;
      this.spawns = 0;
    }
    if (this[kind] >= PRESENTATION_MAX_REQUESTS_PER_STEP) {
      // Once a Play (the host keeps one line per code): a loop asking for more than a step allows is told, not ignored.
      if (this[kind] === PRESENTATION_MAX_REQUESTS_PER_STEP) this.host.problem?.(PRESENTATION_REFUSED, `more than ${PRESENTATION_MAX_REQUESTS_PER_STEP} ${kind === 'plays' ? 'ctx.effects.play' : 'ctx.decals.spawn'} calls in one step (step ${step}): the rest returned 0 and were not shown`);
      this[kind] += 1;
      return false;
    }
    this[kind] += 1;
    return true;
  }

  /** `ctx.effects`. */
  readonly effects: BehaviorEffects = Object.freeze({
    play: (effectId: string, options?: { position?: readonly number[]; entityId?: string; params?: Readonly<Record<string, number | readonly number[] | string>> }): number => {
      if (typeof effectId !== 'string' || !EFFECT_ID_RE.test(effectId)) return 0;
      if (!this.allow('plays')) return 0;
      const position = finite3(options?.position, [0, 0, 0]);
      const entityId = typeof options?.entityId === 'string' && options.entityId !== '' ? options.entityId : null;
      let params: Record<string, number | readonly number[] | string> | null = null;
      if (options?.params !== undefined && options.params !== null && typeof options.params === 'object') {
        params = {};
        for (const [k, v] of Object.entries(options.params).slice(0, 32)) {
          if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
          else if (typeof v === 'string' && v.length <= 16) params[k] = v;
          else if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) params[k] = Object.freeze([...v]);
        }
        params = Object.freeze(params);
      }
      return this.pushEffect({ op: 'play', effectId, entityId, position, params, source: 'script' });
    },
    stop: (target: number | string): void => {
      if (typeof target === 'number' && Number.isInteger(target) && target > 0) this.pushEffect({ op: 'stop', effectId: '', handle: target, entityId: null, position: [0, 0, 0], params: null, source: 'script' });
      else if (typeof target === 'string' && target !== '') this.pushEffect({ op: 'stop', effectId: '', handle: 0, entityId: target, position: [0, 0, 0], params: null, source: 'script' });
    },
  });

  /** `ctx.decals`. */
  readonly decals: BehaviorDecals = Object.freeze({
    spawn: (prefabId: string, options?: { position?: readonly number[]; normal?: readonly number[]; angle?: number; scale?: number; lifetime?: number; entityId?: string }): number => {
      if (typeof prefabId !== 'string') return 0;
      const decal = prefabDecal(this.host.prefab(prefabId));
      if (decal === null || (decal.mode !== undefined && decal.mode !== 'projected')) return 0;
      if (!this.allow('spawns')) return 0;
      const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
      const scale = Math.min(DECAL_SPAWN_LIMITS.scaleMax, Math.max(DECAL_SPAWN_LIMITS.scaleMin, num(options?.scale, 1)));
      const lifetime = Math.min(DECAL_SPAWN_LIMITS.lifetimeMax, Math.max(0, num(options?.lifetime, 0)));
      const entityId = typeof options?.entityId === 'string' && options.entityId !== '' ? options.entityId : null;
      const size = decal.size.map((v) => v * scale) as Vec3;
      const handle = ++this.decalHandle;
      this.pushDecal({
        op: 'spawn',
        handle,
        prefabId,
        entityId,
        decal: Object.freeze({ ...decal, size }),
        position: Object.freeze(finite3(options?.position, [0, 0, 0])),
        rotation: Object.freeze(facing(finite3(options?.normal, [0, 1, 0]), num(options?.angle, 0))),
        lifetime,
      });
      return handle;
    },
    remove: (target: number | string): void => {
      if (typeof target === 'number' && Number.isInteger(target) && target > 0) this.pushDecal({ op: 'remove', handle: target, prefabId: '', entityId: null, decal: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], lifetime: 0 });
      else if (typeof target === 'string' && target !== '') this.pushDecal({ op: 'remove', handle: 0, prefabId: '', entityId: target, decal: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], lifetime: 0 });
    },
  });

  /**
   * A new run: the decals the last one left are cleared and its script
   * effects stopped (its scripts hold no handle to them), and handles count
   * from 1 again.
   */
  restartRun(): void {
    this.decalQueue = [];
    this.effectQueue = [];
    this.decalHandle = 0;
    this.effectHandle = 0;
    this.pushDecal({ op: 'clear', handle: 0, prefabId: '', entityId: null, decal: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], lifetime: 0 });
    this.pushEffect({ op: 'stop', effectId: '', handle: 0, entityId: null, position: [0, 0, 0], params: null, source: 'script' });
  }

  /** The effect requests since the last call, in the order they were made. */
  takeEffects(): EffectRequest[] {
    const out = this.effectQueue;
    this.effectQueue = [];
    return out;
  }

  /** The decal requests since the last call, in the order they were made. */
  takeDecals(): DecalRequest[] {
    const out = this.decalQueue;
    this.decalQueue = [];
    return out;
  }
}
