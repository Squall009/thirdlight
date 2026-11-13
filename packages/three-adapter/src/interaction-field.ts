/**
 * The interaction field: what moving objects press into, round the camera,
 * for anything drawn there to read (foliage today; fog and water later).
 * Visual only: scripts and the simulation never read it.
 *
 * - A {@link CameraWindow} of `INTERACTION_TEXELS`² cells of
 *   `INTERACTION_CELL_M` (64 m round the camera), two RGBA half-float state
 *   textures ({@link WindowTargets}): A = velocity x, z (m/s), pressed amount,
 *   foot height; B = top height, recovery rate (pressed amount a second),
 *   radius (m), the press as stamped (before it stood up again: its slope
 *   points away from the path's line, where the pressed amount's would also
 *   lean along the path by the age of the press). Heights are kept relative to a base height that
 *   follows the camera in whole metres (half floats hold them to about a
 *   centimetre near the camera wherever the world is); the pass moves the
 *   stored ones when the base moves.
 * - Each frame one compute pass, over every texel: the texel's state moved
 *   with the window by whole cells (texels entering start empty), its pressed
 *   amount lowered by its rate times the frame's time (so what an object
 *   pressed stands up again over its recovery time, linearly, as the old
 *   eased path did), its velocity scaled down with it; then every stamp of
 *   the frame (one per interactor: a soft capsule from where it stood a frame
 *   ago to where it stands now, so a fast mover leaves no gaps) is laid on:
 *   a texel takes a stamp's values where the stamp presses harder than what
 *   is there. The stamps are a storage buffer that grows with their number:
 *   nothing caps how many objects press.
 * - Foliage reads it in its vertex stage ({@link InteractionField.foliageOffset}):
 *   a vertex leans away down the stamped press's slope (away from the body
 *   round a standing object, sideways out of a path behind a moving one), by
 *   the pressed amount times its bend capacity, where its height is inside
 *   the stamp's feet-to-top span (fading out past it over the stamp's
 *   radius); the lean is held under the plant's height and drops the vertex
 *   so its distance from the root stays the same — the steps and weights the
 *   analytic bend used, so the look is the same, now for any number of
 *   objects.
 * - It costs nothing until something presses: no texture reaches the GPU and
 *   no pass runs before the first stamp, and the pass stops (readers skip
 *   their reads) once everything pressed has stood up again. WebGL 2 has no
 *   compute: there the field stays off and foliage does not bend round
 *   objects.
 *
 * The arithmetic of a stamp, the decay and the bend is written once over
 * {@link ScalarOps}: the pass and the shader run it on nodes, the reference
 * (`interaction-field-reference.ts`) and the tests on numbers.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';

import { CameraWindow, scrolledSource, WindowTargets } from './camera-window';
import { releaseStorage } from './dispose';
import type { N } from './effects-tsl';
import type { ScalarOps } from '@thirdlight/shared';
import { TSL_SCALAR_OPS } from './field-ops';
import { untransformedTexture } from './texel-texture-node';

const TSL: N = TSLTyped;

/** Texels a side of the field (256 × 0.25 m: 64 m round the camera). */
export const INTERACTION_TEXELS = 256;
/** Metres a texel spans. */
export const INTERACTION_CELL_M = 0.25;
/** Floats a stamp takes: segment (from x, z, to x, z), (foot, top, radius, strength), (velocity x, z, rate, 0). */
export const STAMP_FLOATS = 12;
/** Below this pressed amount a texel counts as untouched. */
export const PRESSED_EPSILON = 1e-3;
/** The most of its height a vertex leans sideways (nearly flat, never past). */
const BEND_MAX_SHARE = 0.95;
/** A mesh without wind weights bends (in the wind and round interactors) by its height share of this many metres. */
export const FOLIAGE_FALLBACK_HEIGHT_M = 1;
/** Stamps the buffer holds at first (it doubles when a frame has more). */
const STAMP_CAPACITY_START = 16;
/** Threads a workgroup of the pass. */
const WORKGROUP = 64;
/** The pass keeps running this long past the slowest recovery after the last change (s), so nothing is left half pressed. */
const QUIET_MARGIN_S = 0.25;

/** One stamp as the steps read it. */
export interface StampShape<F> {
  ax: F;
  az: F;
  bx: F;
  bz: F;
  radius: F;
  strength: F;
}

/** A stamp's press at a ground point (px, pz): the pressed amount (0 past its radius) and the distance from its segment. */
export function stampSteps<F, B>(o: ScalarOps<F, B>, px: F, pz: F, s: StampShape<F>): { value: F; d: F } {
  const zero = o.n(0);
  const one = o.n(1);
  const ex = o.sub(s.bx, s.ax);
  const ez = o.sub(s.bz, s.az);
  const len2 = o.add(o.mul(ex, ex), o.mul(ez, ez));
  const along = o.div(o.add(o.mul(o.sub(px, s.ax), ex), o.mul(o.sub(pz, s.az), ez)), o.max(len2, o.n(1e-8)));
  const t = o.min(o.max(along, zero), one);
  const dx = o.sub(px, o.add(s.ax, o.mul(ex, t)));
  const dz = o.sub(pz, o.add(s.az, o.mul(ez, t)));
  const d = o.sqrt(o.add(o.mul(dx, dx), o.mul(dz, dz)));
  return { value: o.mul(s.strength, fallSteps(o, o.div(d, o.max(s.radius, o.n(1e-4))))), d };
}

/** (1 − q²)², 0 from q = 1 on: the press's falloff from the body to its radius. */
export function fallSteps<F, B>(o: ScalarOps<F, B>, q: F): F {
  const c = o.min(q, o.n(1));
  const k = o.sub(o.n(1), o.mul(c, c));
  return o.mul(k, k);
}

/** A texel's pressed amount after `dt` seconds at its rate (never below 0). */
export function decaySteps<F, B>(o: ScalarOps<F, B>, pressed: F, rate: F, dt: F): F {
  return o.max(o.sub(pressed, o.mul(rate, dt)), o.n(0));
}

/** What the field holds where a vertex stands, as the bend reads it. */
export interface FieldRead<F> {
  /** The pressed amount (bilinear). */
  pressed: F;
  /** The stamped press's slope across x and z (central differences one texel apart, either side). */
  gx: F;
  gz: F;
  /** The stamp's feet and top (relative to the field's base), and its radius. */
  foot: F;
  top: F;
  radius: F;
}

/**
 * The push (x, z) on a vertex at height `py` (relative to the field's base) whose bend capacity (weight² × height
 * × rule) is `cap`: down the stamped press's slope (straight under a body, where it has none: along x), by the
 * pressed amount times the capacity, fading out above the stamp's top and below its feet over its radius.
 */
export function bendPushSteps<F, B>(o: ScalarOps<F, B>, f: FieldRead<F>, py: F, cap: F): { x: F; z: F } {
  const zero = o.n(0);
  const one = o.n(1);
  const slope = o.sqrt(o.add(o.mul(f.gx, f.gx), o.mul(f.gz, f.gz)));
  const flat = o.lt(slope, o.n(1e-5));
  const inv = o.div(one, o.max(slope, o.n(1e-5)));
  // Above the body's top or below its feet counts as distance too (a bridge over the grass parts nothing).
  const gap = o.max(o.max(o.sub(py, f.top), o.sub(f.foot, py)), zero);
  const vertical = fallSteps(o, o.div(gap, o.max(f.radius, o.n(1e-4))));
  const amount = o.mul(o.mul(f.pressed, vertical), cap);
  return { x: o.mul(amount, o.select(flat, one, o.mul(o.sub(zero, f.gx), inv))), z: o.mul(amount, o.select(flat, zero, o.mul(o.sub(zero, f.gz), inv))) };
}

/** The push held under the vertex's height `h` above its root, and its drop: the offset (x, y, z). */
export function bendOffsetSteps<F, B>(o: ScalarOps<F, B>, acc: { x: F; z: F }, h: F): { x: F; y: F; z: F } {
  const total = o.sqrt(o.add(o.mul(acc.x, acc.x), o.mul(acc.z, acc.z)));
  const lean = o.min(total, o.mul(h, o.n(BEND_MAX_SHARE)));
  const k = o.div(lean, o.max(total, o.n(1e-6)));
  const drop = o.sub(h, o.sqrt(o.max(o.sub(o.mul(h, h), o.mul(lean, lean)), o.n(0))));
  return { x: o.mul(acc.x, k), y: o.sub(o.n(0), drop), z: o.mul(acc.z, k) };
}

/** A vertex's bend capacity (metres): its weight squared times its height above its root; without weights, its height share of the first metre squared times its height. */
export function bendCapacity(weight: number | null, height: number): number {
  const w = weight ?? Math.min(Math.max(height / FOLIAGE_FALLBACK_HEIGHT_M, 0), 1);
  return w * w * Math.max(height, 0);
}

/** The frame's stamps: `count` of them packed `STAMP_FLOATS` each (heights absolute). */
export interface InteractionStamps {
  readonly packed: Float32Array;
  readonly count: number;
  /** The slowest recovery among them (s): how long the field must keep running after they stop. */
  readonly longestRecovery: number;
}

/** What of a renderer the field uses. */
interface FieldRenderer {
  readonly backend?: { readonly isWebGLBackend?: boolean };
  compute(nodes: N): unknown;
  copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture): void;
}

export class InteractionField {
  readonly window = new CameraWindow({ texels: INTERACTION_TEXELS, cellM: INTERACTION_CELL_M });
  /** The state textures (JS objects only until the first pass). */
  private readonly targets = new WindowTargets(INTERACTION_TEXELS, 2);
  /** What readers sample: A (velocity, pressed, foot) and B (top, rate, radius, press as stamped). */
  private readonly motion: N = untransformedTexture(this.targets.read[0]!);
  private readonly span: N = untransformedTexture(this.targets.read[1]!);
  /** Render-group uniforms readers take: 1 while the field holds something; the base height. */
  readonly live: N = TSL.uniform(0).setGroup(TSL.renderGroup);
  private readonly base: N = TSL.uniform(0).setGroup(TSL.renderGroup);
  /** The pass's inputs. */
  private readonly u = { moved: TSL.uniform(new THREE.Vector2()), dt: TSL.uniform(0), shift: TSL.uniform(0), count: TSL.uniform(0, 'int') };
  private stamps: N = null;
  private capacity = 0;
  private pass: N = null;
  private baseHeight: number | null = null;
  /** The field changes until then (seconds): the last change plus the slowest recovery. */
  private settleUntil = -Infinity;
  private lastLongest = 0;
  private readonly last = { packed: new Float32Array(0), count: 0 };
  private stampCount = 0;
  /** The renderer the pass last ran on (its storage is released there). */
  private renderer: FieldRenderer | null = null;
  /** Passes run so far (diagnostics, tests). */
  passes = 0;

  /** Whether the field holds something this frame (readers read it). */
  isLive(): boolean {
    return (this.live.value as number) > 0;
  }

  /**
   * The frame's update, before its draw: the stamps (`stamps.count` 0: none this frame), the eye (world), the
   * frame's time (`now` and `dt`, seconds). A pass runs while anything in the field still changes (a stamp moved,
   * eased or left, and for the slowest recovery after) and when the window must follow the eye; a field that only
   * holds objects standing still is left as it is. Returns whether the field still changes (a host drawing on
   * demand draws again).
   */
  update(renderer: FieldRenderer, stamps: InteractionStamps, eye: readonly [number, number, number], now: number, dt: number): boolean {
    if (renderer.backend?.isWebGLBackend === true) return false;
    if (this.differs(stamps)) this.settleUntil = now + Math.max(stamps.longestRecovery, this.lastLongest) + QUIET_MARGIN_S;
    this.lastLongest = stamps.longestRecovery;
    this.stampCount = stamps.count;
    const base = Math.round(eye[1]);
    const active = now <= this.settleUntil;
    const follow = stamps.count > 0 && (this.window.wouldMove(eye[0], eye[2]) || base !== this.baseHeight);
    if (!active && !follow) {
      // Nothing presses and everything stood up again: readers skip the field.
      if (stamps.count === 0 && this.isLive()) {
        this.live.value = 0;
        this.window.setOn(false);
      }
      return false;
    }
    this.window.follow(eye[0], eye[2]);
    // A move past the window clears it all: kept in a range an int holds.
    (this.u.moved.value as THREE.Vector2).set(clampMove(this.window.moved[0]), clampMove(this.window.moved[1]));
    this.u.shift.value = this.baseHeight === null ? 0 : this.baseHeight - base;
    this.baseHeight = base;
    this.base.value = base;
    this.u.dt.value = Math.max(0, dt);
    this.upload(renderer, stamps, base);
    this.u.count.value = stamps.count;
    this.renderer = renderer;
    void renderer.compute(this.pass);
    this.targets.commit(renderer);
    this.passes += 1;
    this.live.value = 1;
    this.window.setOn(true);
    return active;
  }

  /** Whether the frame's stamps differ from the last frame's (kept for the next comparison). */
  private differs(stamps: InteractionStamps): boolean {
    const n = stamps.count * STAMP_FLOATS;
    let same = this.last.count === stamps.count;
    for (let k = 0; same && k < n; k++) same = this.last.packed[k] === stamps.packed[k];
    if (same) return false;
    if (this.last.packed.length < n) this.last.packed = new Float32Array(n * 2);
    this.last.packed.set(stamps.packed.subarray(0, n));
    this.last.count = stamps.count;
    return true;
  }

  /** The most a vertex `tall` metres above its root may be pushed now (what culling bounds grow by). */
  reach(tall: number): number {
    return this.isLive() ? Math.max(0, tall) : 0;
  }

  /** GPU bytes the field holds (0 until its first pass). */
  bytes(): number {
    return this.targets.bytes() + this.capacity * STAMP_FLOATS * 4;
  }

  /** What the field holds now (diagnostics). */
  state(): { live: boolean; stamps: number; passes: number; centre: [number, number] | null; bytes: number } {
    return { live: this.isLive(), stamps: this.stampCount, passes: this.passes, centre: Number.isNaN(this.window.originX) ? null : this.window.centre(), bytes: this.bytes() };
  }

  /**
   * The bend's offset (world) of a foliage vertex at `world`, `height` above its root, of bend capacity `cap`
   * (vertex stage; call only where {@link live} is on).
   */
  foliageOffset(world: N, height: N, cap: N): N {
    const out = TSL.vec3(0).toVar();
    const uv = this.window.uvNode(TSL.vec2(world.x, world.z)).toVar();
    TSL.If(this.window.edgeNode(uv).greaterThan(1), () => {
      const here = this.motion.sample(uv).level(0).toVar();
      TSL.If(here.z.greaterThan(PRESSED_EPSILON), () => {
        const e = 1 / INTERACTION_TEXELS;
        const at = (dx: number, dz: number): N => this.span.sample(uv.add(TSL.vec2(dx, dz))).level(0).w;
        const span = this.span.sample(uv).level(0);
        const read: FieldRead<N> = { pressed: here.z, gx: at(e, 0).sub(at(-e, 0)), gz: at(0, e).sub(at(0, -e)), foot: here.w, top: span.x, radius: span.z };
        const push = bendPushSteps(TSL_SCALAR_OPS, read, world.y.sub(this.base), cap);
        const o = bendOffsetSteps(TSL_SCALAR_OPS, push, height);
        out.assign(TSL.vec3(o.x, o.y, o.z));
      });
    });
    return out;
  }

  dispose(): void {
    this.pass?.dispose?.();
    this.pass = null;
    if (this.stamps !== null) releaseStorage(this.renderer, [this.stamps.value]);
    this.renderer = null;
    this.stamps = null;
    this.capacity = 0;
    this.targets.dispose();
  }

  /** The frame's stamps into the buffer (grown, and the pass made again, when they do not fit), heights made relative. */
  private upload(renderer: FieldRenderer, stamps: InteractionStamps, base: number): void {
    if (this.pass === null || stamps.count > this.capacity) {
      let cap = Math.max(STAMP_CAPACITY_START, this.capacity);
      while (cap < stamps.count) cap *= 2;
      this.pass?.dispose?.();
      if (this.stamps !== null) releaseStorage(this.renderer ?? renderer, [this.stamps.value]);
      this.capacity = cap;
      this.stamps = TSL.instancedArray(new Float32Array(cap * STAMP_FLOATS), 'vec4');
      this.pass = this.makePass();
    }
    const attr = this.stamps.value as THREE.BufferAttribute;
    const dst = attr.array as Float32Array;
    const n = stamps.count * STAMP_FLOATS;
    dst.set(stamps.packed.subarray(0, n));
    for (let k = 0; k < stamps.count; k++) {
      dst[k * STAMP_FLOATS + 4]! -= base;
      dst[k * STAMP_FLOATS + 5]! -= base;
    }
    if (n > 0) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n);
      attr.needsUpdate = true;
    }
  }

  private makePass(): N {
    const T = INTERACTION_TEXELS;
    const readA = untransformedTexture(this.targets.read[0]!);
    const readB = untransformedTexture(this.targets.read[1]!);
    const [writeA, writeB] = this.targets.write;
    const stamps = this.stamps;
    const { moved, dt, shift, count } = this.u;
    const win = this.window;
    return TSL.Fn(() => {
      const index = TSL.instanceIndex;
      const x = index.mod(T);
      const y = index.div(T);
      const texel = TSL.ivec2(x, y);
      const a = TSL.vec4(0).toVar();
      const b = TSL.vec4(0).toVar();
      const { source, inside } = scrolledSource(texel, TSL.ivec2(moved), T);
      // What the texel held, moved with the window and standing up again at its rate; entering texels start empty.
      TSL.If(inside, () => {
        const sa = readA.load(source).toVar();
        const sb = readB.load(source).toVar();
        const left = decaySteps(TSL_SCALAR_OPS, sa.z, sb.y, dt).toVar();
        const keep = TSL.select(sa.z.greaterThan(PRESSED_EPSILON), left.div(TSL.max(sa.z, PRESSED_EPSILON)), 0);
        a.assign(TSL.vec4(sa.xy.mul(keep), left, sa.w.add(shift)));
        b.assign(TSL.vec4(sb.x.add(shift), sb.y, sb.z, sb.w));
      });
      const p = win.texelCentreNode(texel);
      TSL.Loop({ start: TSL.int(0), end: count, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const s0 = stamps.element(i.mul(3)).toVar();
        const s1 = stamps.element(i.mul(3).add(1)).toVar();
        // Most stamps lie far from a texel: their box is all that is read for it.
        const ring = s1.z.add(INTERACTION_CELL_M * 2);
        const lo = TSL.min(s0.xy, s0.zw).sub(ring);
        const hi = TSL.max(s0.xy, s0.zw).add(ring);
        TSL.If(p.x.greaterThanEqual(lo.x).and(p.y.greaterThanEqual(lo.y)).and(p.x.lessThanEqual(hi.x)).and(p.y.lessThanEqual(hi.y)), () => {
          const s2 = stamps.element(i.mul(3).add(2));
          const st = stampSteps(TSL_SCALAR_OPS, p.x, p.y, { ax: s0.x, az: s0.y, bx: s0.z, bz: s0.w, radius: s1.z, strength: s1.w });
          const value = st.value.toVar();
          TSL.If(value.greaterThan(a.z), () => {
            a.assign(TSL.vec4(s2.x, s2.y, value, s1.x));
            b.assign(TSL.vec4(s1.y, value.mul(s2.z), s1.z, value));
          }).ElseIf(a.z.lessThan(PRESSED_EPSILON).and(st.d.lessThan(ring)), () => {
            // A ring past the press keeps the stamp's span, so a read between texels at its rim never mixes in an empty texel's heights.
            a.assign(TSL.vec4(a.x, a.y, a.z, s1.x));
            b.assign(TSL.vec4(s1.y, b.y, s1.z, b.w));
          });
        });
      });
      TSL.textureStore(writeA, TSL.uvec2(x, y), a);
      TSL.textureStore(writeB, TSL.uvec2(x, y), b);
    })().compute(T * T, [WORKGROUP]);
  }
}

const clampMove = (cells: number): number => Math.max(-INTERACTION_TEXELS - 1, Math.min(INTERACTION_TEXELS + 1, cells));
