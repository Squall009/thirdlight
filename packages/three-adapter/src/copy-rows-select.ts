/**
 * The compute passes that pick stored copies for the culled-instance table
 * (`occlusion-instances.ts`; the rule and its CPU reference:
 * `copy-rows-rule.ts`). Three dispatches, run once a frame before the view
 * draws, in one compute call:
 *
 * 1. **Select**: a thread per copy (a workgroup per run of 64 copies of one
 *    set) picks its level (the shared screen-size rule, with hysteresis and
 *    a cross-fade remembered per copy), thins it, writes its world sphere and
 *    tests it against the frustum, then appends it to its draws' lists (in
 *    view from the front, the rest from the back) with an atomic counter
 *    each. The order inside a list is the order the copies arrived in.
 * 2. **Outputs**: each list's two counts kept for the frame's draws (the
 *    counters zeroed for the next frame).
 * 3. **Rows**: each table row a list feeds gets its indirect arguments: the
 *    view's (the copies in view) and the other cameras' (every copy listed).
 *    On the depth pyramid's path the table's own dispatches then compact the
 *    view's lists by last frame's visibility and by the pyramid.
 */
import * as TSLTyped from 'three/tsl';
import { lodLevelStep, lodSwitchMargin, type LodLevelAcc } from '@thirdlight/shared';
import type { StorageBufferAttribute } from 'three/webgpu';

import { copyDensitySteps } from './copies-prepare';
import { COPY_FADE_FULL } from './copy-rows-rule';
import type { N } from './effects-tsl';
import { TSL_SCALAR_OPS } from './field-ops';

const TSL: N = TSLTyped;

/** Threads a workgroup runs (copies of one set a workgroup takes). */
export const SELECT_WORKGROUP = 64;
/** Workgroups a dispatch row holds (WebGPU's guaranteed largest dispatch side). */
export const SELECT_DISPATCH_ROW = 65535;
/** An output index naming no list. */
export const NO_OUTPUT = 0xffffffff;

/**
 * u32 a selection's header takes in the selection data: its copies' first place in the pools, their count, where
 * its state starts, its level count, its flags, where its floats start, where its level outputs start, its
 * ungrouped output, its near output, and where its blocks' levels start (a set whose copies take their block's
 * level, picked on the page; {@link NO_OUTPUT}: each copy picks its own).
 */
export const SELECTION_U32 = 10;
/** Selection flags: the last level is the cull size; the set thins by distance. */
export const SELECT_CULLS = 1;
export const SELECT_THINS = 2;
/**
 * Floats a selection's parameters take before its switch distances: the set's world matrix (16), its largest
 * world scale, metres → level units, the hysteresis share, the model's reach from its origin (scale 1), how far
 * its vertices move (m; huge: no bound), the near list's reach (m), the falloff's start, end and least share.
 */
export const SELECTION_F32 = 25;
const F_WORLD = 0;
const F_SCALE = 16;
const F_TO_DISTANCE = 17;
const F_HYSTERESIS = 18;
const F_MODEL_REACH = 19;
const F_VERTEX_REACH = 20;
const F_NEAR = 21;
const F_DENSITY = 22;

/** What the passes read and write (the table's pools and buffers). */
export interface SelectBuffers {
  readonly matrices: StorageBufferAttribute;
  readonly spheres: StorageBufferAttribute;
  readonly visible: StorageBufferAttribute;
  readonly slots: StorageBufferAttribute;
  readonly data: StorageBufferAttribute;
  readonly floats: StorageBufferAttribute;
  readonly tally: StorageBufferAttribute;
  readonly counts: StorageBufferAttribute;
  readonly table: StorageBufferAttribute;
  readonly args: StorageBufferAttribute;
}

/** The frame's view as the select pass reads it (uniform nodes, set by the table each frame). */
export interface SelectView {
  readonly eye: N;
  /** The frustum's six planes (normal, constant), pointing inwards. */
  readonly planes: N;
  /** How far a fade runs down since the last select (`copyFadeStep`, a uint). */
  readonly fadeStep: N;
  readonly rowCount: N;
  /**
   * The selection data's layout (u32): the chunks (selection, first copy) from 0, `chunkCount` of them; the
   * selections' headers from `headersAt`; each output's list (its first place in the pools, its capacity) from
   * `outsAt`, `outputCount` of them.
   */
  readonly chunkCount: N;
  readonly headersAt: N;
  readonly outsAt: N;
  readonly outputCount: N;
}

/** The table's row layout as the rows pass reads it (`occlusion-instances.ts` owns it). */
export interface SelectTableLayout {
  readonly stride: number;
  readonly argsStride: number;
  readonly argsOther: number;
  readonly flagSelected: number;
  readonly outputField: number;
}

/** The three dispatches (see the module's header). */
export function copySelectKernels(b: SelectBuffers, v: SelectView, t: SelectTableLayout): { select: N; outputs: N; rows: N } {
  const matrices: N = TSL.storage(b.matrices, 'vec4', b.matrices.count).toReadOnly();
  const spheres: N = TSL.storage(b.spheres, 'vec4', b.spheres.count);
  const state: N = TSL.storage(b.visible, 'uint', b.visible.count);
  const slots: N = TSL.storage(b.slots, 'uint', b.slots.count);
  const data: N = TSL.storage(b.data, 'uint', b.data.count).toReadOnly();
  const floats: N = TSL.storage(b.floats, 'float', b.floats.count).toReadOnly();
  const tally: N = TSL.storage(b.tally, 'uint', b.tally.count).toAtomic();
  const counts: N = TSL.storage(b.counts, 'uint', b.counts.count);
  const table: N = TSL.storage(b.table, 'uint', b.table.count).toReadOnly();
  const args: N = TSL.storage(b.args, 'uint', b.args.count);
  const o = TSL_SCALAR_OPS;

  const select = TSL.Fn(() => {
    const wg = TSL.workgroupId.x.add(TSL.workgroupId.y.mul(SELECT_DISPATCH_ROW));
    TSL.If(wg.lessThan(v.chunkCount), () => {
      const sel = data.element(wg.mul(2)).toVar();
      const c = data.element(wg.mul(2).add(1)).add(TSL.localId.x).toVar();
      const h = sel.mul(SELECTION_U32).add(v.headersAt).toVar();
      const copies = data.element(h).toVar();
      const count = data.element(h.add(1));
      TSL.If(c.lessThan(count), () => {
        const stateAt = data.element(h.add(2)).add(c).toVar();
        const levels = data.element(h.add(3)).toVar();
        const flags = data.element(h.add(4)).toVar();
        const f = data.element(h.add(5)).toVar();
        const outAt = data.element(h.add(6)).toVar();
        const fl = (i: number): N => floats.element(f.add(i));
        const at = copies.add(c).mul(4).toVar();
        const v0 = matrices.element(at).toVar();
        const v3 = matrices.element(at.add(3)).toVar();
        const world = TSL.mat4(...Array.from({ length: 16 }, (_, i) => fl(F_WORLD + i))).toVar();
        const wp = world.mul(TSL.vec4(v0.xyz, 1)).xyz.toVar();
        const s = v3.x.mul(fl(F_SCALE)).toVar();
        const metres = TSL.length(wp.sub(v.eye)).toVar();
        const d = metres.mul(fl(F_TO_DISTANCE)).toVar();
        // The level: the shared rule, step by step over the group's switches (state: level + 1, left + 1, fade left).
        const was = state.element(stateAt).toVar();
        const cur = was.bitAnd(0xff).toVar();
        const fade = was.shiftRight(16).toVar();
        const curF = TSL.float(cur).sub(1).toVar();
        const level = TSL.float(0).toVar();
        const open = TSL.float(1).toVar();
        TSL.Loop({ start: TSL.uint(1), end: levels, type: 'uint', condition: '<', name: 'k' }, ({ k }: { k: N }) => {
          const acc: LodLevelAcc<N> = lodLevelStep(o, { level, open }, d, floats.element(f.add(SELECTION_F32).add(k)).mul(s), lodSwitchMargin(o, curF, TSL.float(k), fl(F_HYSTERESIS)));
          level.assign(acc.level);
          open.assign(acc.open);
        });
        const target = TSL.uint(level).toVar();
        // A set whose blocks each draw one level: the page's pick for the copy's block (its index rides in the copy's floats).
        const blocks = data.element(h.add(9)).toVar();
        TSL.If(blocks.notEqual(NO_OUTPUT), () => {
          target.assign(data.element(blocks.add(TSL.uint(v3.y))));
        });
        // `nextCopyState` (copy-rows-rule.ts).
        const nextLeft = was.shiftRight(8).bitAnd(0xff).toVar();
        const nextFade = fade.toVar();
        TSL.If(cur.equal(0), () => {
          nextLeft.assign(0);
          nextFade.assign(0);
        })
          .ElseIf(target.add(1).notEqual(cur), () => {
            nextLeft.assign(cur);
            nextFade.assign(COPY_FADE_FULL);
          })
          .Else(() => {
            nextFade.assign(fade.sub(TSL.min(fade, v.fadeStep)));
          });
        TSL.If(nextFade.equal(0), () => {
          nextLeft.assign(0);
        });
        state.element(stateAt).assign(target.add(1).bitOr(nextLeft.shiftLeft(8)).bitOr(nextFade.shiftLeft(16)));
        // Its world sphere (the late pass tests the pyramid with it) and the frustum.
        const r = fl(F_MODEL_REACH).mul(s).add(fl(F_VERTEX_REACH)).toVar();
        spheres.element(copies.add(c)).assign(TSL.vec4(wp, r));
        const inView = TSL.bool(true).toVar();
        for (let p = 0; p < 6; p += 1) {
          const plane = v.planes.element(p);
          inView.assign(inView.and(plane.xyz.dot(wp).add(plane.w).greaterThanEqual(r.negate())));
        }
        const thins = flags.bitAnd(SELECT_THINS).notEqual(0);
        const share = copyDensitySteps(o, d, fl(F_DENSITY).mul(s), fl(F_DENSITY + 1).mul(s), fl(F_DENSITY + 2));
        const kept = s.greaterThan(0).and(thins.not().or(v0.w.lessThan(share))).toVar();
        const last = levels.sub(1);
        const culls = flags.bitAnd(SELECT_CULLS).notEqual(0);
        const culled = culls.and(target.equal(last)).toVar();
        const emit = (out: N, front: N): void => {
          TSL.If(out.notEqual(NO_OUTPUT), () => {
            const o2 = out.mul(2);
            const n = TSL.atomicAdd(tally.element(o2.add(TSL.select(front, TSL.uint(0), TSL.uint(1)))), TSL.uint(1)).toVar();
            const list = data.element(v.outsAt.add(o2)).toVar();
            const cap = data.element(v.outsAt.add(o2).add(1));
            slots.element(list.add(TSL.select(front, n, cap.sub(1).sub(n)))).assign(c);
          });
        };
        TSL.If(kept.and(culled.not()), () => {
          emit(data.element(outAt.add(target)), inView);
          emit(data.element(h.add(7)), inView);
          TSL.If(metres.lessThanEqual(fl(F_NEAR)), () => {
            emit(data.element(h.add(8)), TSL.bool(false));
          });
        });
        // A copy fading out of the level it left: listed there for the view too, until its fade is done.
        const leftLevel = nextLeft.sub(1);
        TSL.If(kept.and(inView).and(nextLeft.notEqual(0)).and(leftLevel.notEqual(target)).and(culls.and(leftLevel.equal(last)).not()), () => {
          emit(data.element(outAt.add(leftLevel)), TSL.bool(true));
        });
      });
    });
  })().compute([1, 1, 1], [SELECT_WORKGROUP]);

  // Dispatched by size and bounded by their own uniforms: a compute node made with a thread count bakes an early return
  // at that count.
  const outputs = TSL.Fn(() => {
    const i = TSL.instanceIndex;
    TSL.If(i.lessThan(v.outputCount.mul(2)), () => {
      counts.element(i).assign(TSL.atomicLoad(tally.element(i)));
      TSL.atomicStore(tally.element(i), TSL.uint(0));
    });
  })().compute([1, 1, 1], [SELECT_WORKGROUP]);

  const rows = TSL.Fn(() => {
    const r = TSL.instanceIndex;
    TSL.If(r.lessThan(v.rowCount), () => {
      const row = r.mul(t.stride).toVar();
      TSL.If(table.element(row.add(3)).bitAnd(t.flagSelected).notEqual(0), () => {
        const out = table.element(row.add(t.outputField)).mul(2).toVar();
        const front = counts.element(out).toVar();
        const all = front.add(counts.element(out.add(1)));
        const a = r.mul(t.argsStride).toVar();
        for (const [at, n] of [[0, front], [t.argsOther, all]] as const) {
          args.element(a.add(at)).assign(table.element(row.add(4)));
          args.element(a.add(at + 1)).assign(n);
          args.element(a.add(at + 2)).assign(table.element(row.add(5)));
          args.element(a.add(at + 3)).assign(TSL.uint(0));
          args.element(a.add(at + 4)).assign(TSL.uint(0));
        }
      });
    });
  })().compute([1, 1, 1], [SELECT_WORKGROUP]);

  return { select, outputs, rows };
}
