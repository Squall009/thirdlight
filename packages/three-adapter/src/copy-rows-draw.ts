/**
 * How a stored copy set's draw reads its copies as a row of the culled-instance table (WebGPU; the table:
 * `occlusion-instances.ts`, the rows: `copy-rows.ts`). The selection pass has already picked the copies the
 * draw draws, so the vertex stage only reads: the instance's place in its pass list (the pyramid's path) or in
 * its list's order, the copy at that place, and the copy's floats; no copy is drawn as nothing.
 *
 * - The view's draw reads its list's order (those in view), through the pass list on the pyramid's path.
 * - Another camera (a shadow map) reads every copy its list holds: the ones in view from the front, then the
 *   rest from the back of the list.
 * - A cached static shadow map reads every copy of the set in place order (its most detailed level's draws).
 *
 * A copy switching levels is drawn by both levels' draws for a moment: each keeps the complementary pixels of
 * one dither (`dither-fade.ts`), as far as the copy's fade has come.
 *
 * Every row draw of every set shares one program per material and vertex layout: what differs per draw is bound
 * per object.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { RenderObjectRefreshType } from 'three';
import { StorageBufferAttribute, type NodeBuilder } from 'three/webgpu';

import { COPY_FADE_FULL } from './copy-rows-rule';
import type { CopyRowBinding } from './occlusion-instances';
import { ditherThreshold } from './dither-fade';
import type { N } from './effects-tsl';
import { setCopyBend, setCopyKeep, setCopyRoot } from './node-materials';
import { addRefreshRule, type NeedsRefresh } from './observer-refresh';

const TSL: N = TSLTyped;

/** The marker attribute of a row draw's geometry: its program is its own (the source's position, never read under this name). */
export const COPY_ROWS_ATTRIBUTE = 'tlCopyRows';

/** `mesh.userData[COPY_ROW_KEY]`: what a row draw binds ({@link CopyRowDraw}). */
export const COPY_ROW_KEY = '__tlCopyRow';

/** A row draw's per-object inputs. */
export interface CopyRowDraw {
  readonly binding: CopyRowBinding;
  /** The mesh's place in the model, and how readily the copies give way to subjects. */
  readonly local: THREE.Matrix4;
  readonly bend: number;
  /** The table's pools and counts it reads now (null: none yet). */
  pools(): { readonly matrices: StorageBufferAttribute; readonly slots: StorageBufferAttribute; readonly lists: StorageBufferAttribute; readonly visible: StorageBufferAttribute; readonly counts: StorageBufferAttribute } | null;
}

const rowOf = (object: THREE.Object3D | null | undefined): CopyRowDraw | undefined => object?.userData[COPY_ROW_KEY] as CopyRowDraw | undefined;

/** Whether a node build draws a row draw (its geometry carries the marker). */
export function buildDrawsCopyRows(builder: NodeBuilder): boolean {
  const g = (builder as unknown as { geometry?: THREE.BufferGeometry | null }).geometry;
  return g !== null && g !== undefined && typeof g.getAttribute === 'function' && g.getAttribute(COPY_ROWS_ATTRIBUTE) !== undefined;
}

const NO_VEC4 = new StorageBufferAttribute(new Float32Array(4), 4);
const NO_UINT = new StorageBufferAttribute(new Uint32Array(4), 1);
const NO_SLOTS = new StorageBufferAttribute(new Uint32Array(4), 1);
const NO_LISTS = new StorageBufferAttribute(new Uint32Array(4), 1);
const NO_COUNTS = new StorageBufferAttribute(new Uint32Array(4), 1);
const rMatrices: N = TSL.storage(NO_VEC4, 'vec4', 1).toReadOnly();
const rSlots: N = TSL.storage(NO_SLOTS, 'uint', 1).toReadOnly();
const rLists: N = TSL.storage(NO_LISTS, 'uint', 1).toReadOnly();
const rState: N = TSL.storage(NO_UINT, 'uint', 1).toReadOnly();
const rCounts: N = TSL.storage(NO_COUNTS, 'uint', 1).toReadOnly();

const ru = (read: (d: CopyRowDraw) => number): N => TSL.uniform(0, 'uint').onObjectUpdate(({ object }: { object: THREE.Object3D }) => {
  const d = rowOf(object);
  return d === undefined ? 0 : read(d);
});
/** The list's order's first place, on the way binding the pools. */
const uListBase: N = TSL.uniform(0, 'uint').onObjectUpdate(({ object }: { object: THREE.Object3D }) => {
  const d = rowOf(object);
  const p = d?.pools() ?? null;
  rMatrices.value = p?.matrices ?? NO_VEC4;
  rSlots.value = p?.slots ?? NO_SLOTS;
  rLists.value = p?.lists ?? NO_LISTS;
  rState.value = p?.visible ?? NO_UINT;
  rCounts.value = p?.counts ?? NO_COUNTS;
  return Math.max(0, d?.binding.row?.base ?? 0);
});
const uCopies: N = ru((d) => Math.max(0, d.binding.row?.copies ?? 0));
const uCap: N = ru((d) => d.binding.row?.cap ?? 0);
const uStateAt: N = ru((d) => Math.max(0, d.binding.row?.stateAt ?? 0));
const uOutput: N = ru((d) => Math.max(0, d.binding.row?.output.index ?? 0));
const uMode: N = ru((d) => d.binding.mode);
const uList: N = ru((d) => d.binding.list);
/** The level the draw draws + 1 (0: none, no fade: ungrouped or near-shadow draws). */
const uLevel: N = ru((d) => (d.binding.row?.level ?? -1) + 1);
const uBend: N = TSL.uniform(1).onObjectUpdate(({ object }: { object: THREE.Object3D }) => rowOf(object)?.bend ?? 1);
const IDENTITY = new THREE.Matrix4();
const uLocal: N = TSL.uniform(new THREE.Matrix4()).onObjectUpdate(({ object }: { object: THREE.Object3D }) => rowOf(object)?.local ?? IDENTITY);

/** This instance's copy (vertex stage): its slot in the set, its four vec4s, and its fade toward this draw's level (x: share, y: +1 keep at or past it, −1 below it). */
function rowNodes(): { slot: N; v: N[]; fade: N } {
  const i = TSL.instanceIndex;
  const front = rCounts.element(uOutput.mul(2));
  // The other cameras' place: those in view from the front, then the rest from the list's back.
  const other = TSL.select(i.lessThan(front), i, uCap.sub(1).sub(i.sub(front)));
  const listed = rLists.element(uList.add(rLists.element(TSL.uint(0)).mul(uCap)).add(i));
  const place = TSL.select(uList.greaterThan(0), listed, TSL.select(uMode.equal(2), other, i));
  const slot = TSL.select(uMode.equal(1), i, rSlots.element(uListBase.add(place))).toVar();
  const at = uCopies.add(slot).mul(4);
  const v = [0, 1, 2, 3].map((k) => rMatrices.element(at.add(k)).toVar());
  const state = rState.element(uStateAt.add(slot)).toVar();
  const level = state.bitAnd(0xff);
  const left = state.shiftRight(8).bitAnd(0xff);
  const done = TSL.float(1).sub(TSL.float(state.shiftRight(16)).div(COPY_FADE_FULL));
  const fading = uMode.equal(0).and(uLevel.greaterThan(0)).and(left.notEqual(0)).and(left.notEqual(level));
  // Coming in (this draw's level is the copy's): keep below the share; going out (the level it left): keep at or past it.
  const fade = TSL.select(fading.and(level.equal(uLevel)), TSL.vec2(done, -1), TSL.select(fading.and(left.equal(uLevel)), TSL.vec2(done, 1), TSL.vec2(0, 1)));
  return { slot, v, fade };
}

/** `v` turned by unit quaternion `q`. */
const rotate = (q: N, v: N): N => {
  const t = TSL.cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(TSL.cross(q.xyz, t));
};

/** A scale safe to divide by (a copy shrunk to nothing draws nothing anyway). */
const safeScale = (s: N): N => TSL.select(TSL.abs(s).lessThan(1e-6), TSL.vec3(1), s);

/** The placement every row draw shares (cover-gpu.ts's placement hook applies it). */
export const rowsPlacement = {
  place: TSL.Fn((builder: NodeBuilder) => {
    const c = rowNodes();
    const pos = c.v[0]!.xyz;
    const quat = c.v[1]!;
    const scale = c.v[2]!.xyz;
    setCopyRoot(builder, pos);
    setCopyBend(builder, uBend);
    const fade = TSL.varying(c.fade, 'tlCopyFade');
    setCopyKeep(builder, TSL.select(fade.y.greaterThan(0), ditherThreshold.greaterThanEqual(fade.x), ditherThreshold.lessThan(fade.x)));
    const p = uLocal.mul(TSL.vec4(TSL.positionLocal, 1)).xyz;
    TSL.positionLocal.assign(rotate(quat, p.mul(scale)).add(pos));
    const b = builder as unknown as { needsPreviousData?: () => boolean; hasGeometryAttribute?: (name: string) => boolean };
    // Velocity passes: the copies stand still (their previous place is this one).
    if (b.needsPreviousData?.() === true) TSL.positionPrevious.assign(rotate(quat, uLocal.mul(TSL.vec4(TSL.positionPrevious, 1)).xyz.mul(scale)).add(pos));
    if (b.hasGeometryAttribute?.('normal') !== false) TSL.normalLocal.assign(TSL.normalize(rotate(quat, TSL.normalize(uLocal.mul(TSL.vec4(TSL.normalLocal, 0)).xyz).div(safeScale(scale)))));
  }, 'void') as unknown as () => void,
};

/** Column `i` of a row draw's copy's matrix as instance columns hold it (column 0's w: the paint slot). */
export function rowsColumn(i: number): N {
  const c = rowNodes();
  const quat = c.v[1]!;
  const scale = c.v[2]!;
  if (i === 3) return TSL.vec4(c.v[0]!.xyz, 1);
  const axis = i === 0 ? TSL.vec3(scale.x, 0, 0) : i === 1 ? TSL.vec3(0, scale.y, 0) : TSL.vec3(0, 0, scale.z);
  return TSL.vec4(rotate(quat, axis), i === 0 ? scale.w : TSL.float(0));
}

/** A row draw's copy's slot in its set (its identity for a material's per-copy variation). */
export function rowsIndex(): N {
  return rowNodes().slot;
}

/** What a row draw's render object last bound (the pools by identity, then its places and pass). */
interface Bound {
  matrices: unknown;
  slots: unknown;
  lists: unknown;
  visible: unknown;
  counts: unknown;
  base: number;
  copies: number;
  list: number;
  mode: number;
  output: number;
  stateAt: number;
}
const seen = new WeakMap<object, Bound>();

/** A full refresh whenever what a row draw binds changed since its last draw (three refreshes per-object values only on changes it knows of). */
function refreshOnRowChange(base: NeedsRefresh): NeedsRefresh {
  return (renderObject, frame) => {
    const refresh = base(renderObject, frame);
    const d = rowOf(renderObject.object);
    if (d === undefined) return refresh;
    const r = d.binding.row;
    const p = d.pools();
    const was = seen.get(renderObject);
    const base0 = r?.base ?? -1;
    const copies = r?.copies ?? -1;
    const output = r?.output.index ?? -1;
    const stateAt = r?.stateAt ?? -1;
    const same =
      was !== undefined && was.matrices === (p?.matrices ?? null) && was.slots === (p?.slots ?? null) && was.lists === (p?.lists ?? null) && was.visible === (p?.visible ?? null) && was.counts === (p?.counts ?? null) &&
      was.base === base0 && was.copies === copies && was.list === d.binding.list && was.mode === d.binding.mode && was.output === output && was.stateAt === stateAt;
    if (same) return refresh;
    const now: Bound = { matrices: p?.matrices ?? null, slots: p?.slots ?? null, lists: p?.lists ?? null, visible: p?.visible ?? null, counts: p?.counts ?? null, base: base0, copies, list: d.binding.list, mode: d.binding.mode, output, stateAt };
    if (was === undefined) seen.set(renderObject, now);
    else Object.assign(was, now);
    return RenderObjectRefreshType.FULL;
  };
}

let installed = false;

/** Teach the node materials to refresh row draws (idempotent; the placement hook is cover-gpu.ts's). */
export function installCopyRows(): void {
  if (installed) return;
  installed = true;
  addRefreshRule('copy-rows', (needs, builder) => (buildDrawsCopyRows(builder as unknown as NodeBuilder) ? refreshOnRowChange(needs) : null));
}
