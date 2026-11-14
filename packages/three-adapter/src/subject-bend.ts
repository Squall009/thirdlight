/**
 * Foliage giving way to the view's subjects on WebGL 2, where the
 * interaction field cannot run (no compute): the analytic push the field
 * replaced on WebGPU, kept so WebGL 2 draws what it drew before. It is a
 * fallback, not a second field: the view's subjects only (the camera's
 * target, or the subjects a script names: see-through's list, whether
 * see-through is on or not), at most `SEE_THROUGH_SUBJECTS` of them, the
 * nearest to the camera kept. An `interactor` component on a subject gives
 * its radius, strength and recovery; other objects with the component do
 * not press here.
 *
 * Per subject the view keeps two points on the ground: its head (where the
 * body stands now) and a tail that follows it, easing toward it over the
 * subject's recovery time. A vertex is pushed away from the nearest point of
 * the segment between them, by a share that falls from the head (all of it)
 * to the tail (none): behind a walking subject a pressed path stands up
 * again over its recovery time, and round a subject standing still the
 * plants stay parted. A subject entering or leaving the list eases in and
 * out over the same time, so nothing springs.
 *
 * The push on one vertex: within `radius` of the segment (horizontally, and
 * vertically outside the body's feet-to-top span), falling smoothly to 0 at
 * the radius; times the subject's strength, its ease and the vertex's bend
 * capacity. The pushes of all subjects add up and are held under the
 * vertex's height with the field's own lean and drop (`bendOffsetSteps`).
 * The subjects reach the shader as a few render-group uniforms written once
 * per frame (no program is built per subject).
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { CPU_SCALAR_OPS, type ScalarOps } from '@thirdlight/shared';
import { interactorOf, SEE_THROUGH_SUBJECTS } from '@thirdlight/project-model';

import type { N } from './effects-tsl';
import { TSL_SCALAR_OPS } from './field-ops';
import { bendCapacity, bendOffsetSteps } from './interaction-field';
import { subjectExtent, type SeeThroughEntities, type SubjectExtent } from './see-through';

const TSL: N = TSLTyped;

/** Floats per subject in the packed uniforms: head (x, feet y, z, radius), tail (x, top y, z, strength × ease). */
export const SUBJECT_BEND_FLOATS = 8;
/** A subject that moved further than this in one frame jumped (a teleport): its path starts again where it is. */
const BEND_JUMP_M = 8;

/** One subject as the steps read it (the packed uniforms' eight floats). */
export interface BendSubject<F> {
  hx: F;
  feet: F;
  hz: F;
  radius: F;
  tx: F;
  top: F;
  tz: F;
  strength: F;
}

/** One subject's push on a vertex at (px, py, pz) of bend capacity `cap` (metres), added into `acc` (x, z). */
export function subjectPushSteps<F, B>(o: ScalarOps<F, B>, px: F, py: F, pz: F, cap: F, s: BendSubject<F>, acc: { x: F; z: F }): void {
  const zero = o.n(0);
  const one = o.n(1);
  const ex = o.sub(s.hx, s.tx);
  const ez = o.sub(s.hz, s.tz);
  const len2 = o.add(o.mul(ex, ex), o.mul(ez, ez));
  const along = o.div(o.add(o.mul(o.sub(px, s.tx), ex), o.mul(o.sub(pz, s.tz), ez)), o.max(len2, o.n(1e-8)));
  const t = o.min(o.max(along, zero), one);
  // A subject standing still has no path: the head's share everywhere.
  const share = o.select(o.lt(len2, o.n(1e-6)), one, t);
  const dx = o.sub(px, o.add(s.tx, o.mul(ex, t)));
  const dz = o.sub(pz, o.add(s.tz, o.mul(ez, t)));
  const d = o.sqrt(o.add(o.mul(dx, dx), o.mul(dz, dz)));
  // Above the body's top or below its feet counts as distance too (a bridge over the grass parts nothing).
  const gap = o.max(o.max(o.sub(py, s.top), o.sub(s.feet, py)), zero);
  const q = o.min(o.div(o.sqrt(o.add(o.mul(d, d), o.mul(gap, gap))), o.max(s.radius, o.n(1e-4))), one);
  const fall = o.mul(o.sub(one, o.mul(q, q)), o.sub(one, o.mul(q, q)));
  const amount = o.mul(o.mul(o.mul(s.strength, fall), share), cap);
  // Straight under the body's axis: away along x (any way is as good, and it is the same for the whole frame).
  const near = o.lt(d, o.n(1e-4));
  const inv = o.div(one, o.max(d, o.n(1e-4)));
  acc.x = o.add(acc.x, o.mul(amount, o.select(near, one, o.mul(dx, inv))));
  acc.z = o.add(acc.z, o.mul(amount, o.select(near, zero, o.mul(dz, inv))));
}

/**
 * The CPU reference: the offset (world metres) of a vertex at `p` standing `height` above its root with bend
 * weight `weight` (null: no COLOR_0), under the packed subjects `packed` (`count` slots) and the rule's `ruleBend`.
 */
export function subjectBendAt(p: readonly [number, number, number], height: number, weight: number | null, packed: ArrayLike<number>, count: number, ruleBend = 1): [number, number, number] {
  const h = Math.max(height, 0);
  const cap = bendCapacity(weight, h) * ruleBend;
  const acc = { x: 0, z: 0 };
  for (let i = 0; i < count; i++) {
    const b = i * SUBJECT_BEND_FLOATS;
    const s: BendSubject<number> = { hx: packed[b]!, feet: packed[b + 1]!, hz: packed[b + 2]!, radius: packed[b + 3]!, tx: packed[b + 4]!, top: packed[b + 5]!, tz: packed[b + 6]!, strength: packed[b + 7]! };
    subjectPushSteps(CPU_SCALAR_OPS, p[0], p[1], p[2], cap, s, acc);
  }
  const off = bendOffsetSteps(CPU_SCALAR_OPS, acc, h);
  return [off.x, off.y, off.z];
}

/** The subjects' uniforms every foliage material reads on WebGL 2: the packed slots and how many are live (0: skipped). */
export class SubjectBend {
  readonly data: THREE.Vector4[] = Array.from({ length: SEE_THROUGH_SUBJECTS * 2 }, () => new THREE.Vector4());
  // Render-group uniforms, one vec4 each: written once per frame for every draw (an object's own uniforms refresh
  // only when its draw does, and a uniform array's values did not reach the draws).
  private readonly slots: N[] = this.data.map((v) => TSL.uniform(v).setGroup(TSL.renderGroup));
  readonly live: N = TSL.uniform(0).setGroup(TSL.renderGroup);

  /** Write the packed slots (`count` of them). */
  set(packed: ArrayLike<number>, count: number): void {
    let on = 0;
    for (let i = 0; i < SEE_THROUGH_SUBJECTS; i++) {
      const b = i * SUBJECT_BEND_FLOATS;
      const used = i < count && packed[b + 7]! > 0;
      this.data[i * 2]!.set(used ? packed[b]! : 0, used ? packed[b + 1]! : 0, used ? packed[b + 2]! : 0, used ? packed[b + 3]! : 1);
      this.data[i * 2 + 1]!.set(used ? packed[b + 4]! : 0, used ? packed[b + 5]! : 0, used ? packed[b + 6]! : 0, used ? packed[b + 7]! : 0);
      if (used) on += 1;
    }
    this.live.value = on > 0 ? count : 0;
  }

  isLive(): boolean {
    return (this.live.value as number) > 0;
  }

  /** The offset (world) of a vertex at `world`, `height` above its root, of bend capacity `cap` (vertex stage). */
  offset(world: N, height: N, cap: N): N {
    const acc = { x: TSL.float(0), z: TSL.float(0) };
    for (let i = 0; i < SEE_THROUGH_SUBJECTS; i++) {
      const a = this.slots[i * 2]!;
      const b = this.slots[i * 2 + 1]!;
      subjectPushSteps(TSL_SCALAR_OPS, world.x, world.y, world.z, cap, { hx: a.x, feet: a.y, hz: a.z, radius: a.w, tx: b.x, top: b.y, tz: b.z, strength: b.w }, acc);
    }
    const o = bendOffsetSteps(TSL_SCALAR_OPS, acc, height);
    return TSL.vec3(o.x, o.y, o.z);
  }
}

/** Where a subject view finds its subjects. */
export interface SubjectBendDeps extends SeeThroughEntities {
  components(id: string): unknown;
  /** The entity the camera follows (the subject when none is named). */
  cameraTarget(): string | null;
  /** The subjects named for the view (see-through's list: a host's or a script's; null: the camera's target). */
  named(): readonly string[] | null;
  /** A subject still eases or a path still recovers: a host drawing on demand draws again. */
  onChange?(): void;
}

interface BendSlot {
  id: string;
  wanted: boolean;
  /** 0 … 1 eased in. */
  ease: number;
  started: boolean;
  readonly ext: SubjectExtent;
  readonly head: THREE.Vector3;
  readonly tail: THREE.Vector3;
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _eye = new THREE.Vector3();

/** One view's subjects as the foliage bends round them on WebGL 2: chosen, measured and eased each frame. */
export class SubjectBendView {
  private readonly slots: (BendSlot | null)[] = new Array<BendSlot | null>(SEE_THROUGH_SUBJECTS).fill(null);
  readonly packed = new Float32Array(SEE_THROUGH_SUBJECTS * SUBJECT_BEND_FLOATS);
  private count = 0;
  private at: number | null = null;

  constructor(
    private readonly d: SubjectBendDeps,
    private readonly target: SubjectBend | null,
  ) {}

  /** Live slots this frame. */
  live(): number {
    return this.count;
  }

  /** The subjects bent round now, with their ease (diagnostics). */
  subjects(): { id: string; ease: number }[] {
    return this.slots.filter((s): s is BendSlot => s !== null).map((s) => ({ id: s.id, ease: s.ease }));
  }

  /** Before the frame's draw (world matrices current). */
  update(camera: THREE.Camera, now: number = performance.now()): void {
    const dt = this.at === null ? 0 : Math.min(0.1, Math.max(0, (now - this.at) / 1000));
    this.at = now;
    this.choose(camera);
    let moving = false;
    this.count = 0;
    this.packed.fill(0);
    for (let i = 0; i < this.slots.length; i++) {
      const sl = this.slots[i];
      if (sl === null || sl === undefined) continue;
      const comps = this.d.components(sl.id);
      if (sl.wanted && this.d.matrix(sl.id, _m)) subjectExtent(_m, this.d.drawn(sl.id), comps, sl.ext);
      const v = interactorOf((comps as { interactor?: unknown } | undefined)?.interactor, sl.ext.radius);
      const step = v.recovery > 0 ? dt / v.recovery : 1;
      const aim = sl.wanted ? 1 : 0;
      sl.ease = aim > sl.ease ? Math.min(aim, sl.ease + step) : Math.max(aim, sl.ease - step);
      if (sl.ease <= 0 && !sl.wanted) {
        this.slots[i] = null;
        continue;
      }
      _v.copy(sl.head);
      sl.head.set(sl.ext.centre.x, sl.ext.feet, sl.ext.centre.z);
      if (!sl.started || _v.distanceTo(sl.head) > BEND_JUMP_M) {
        sl.tail.copy(sl.head);
        sl.started = true;
      } else {
        const k = v.recovery > 0 ? 1 - Math.exp(-dt / v.recovery) : 1;
        sl.tail.lerp(sl.head, k);
        if (sl.tail.distanceToSquared(sl.head) < 1e-6) sl.tail.copy(sl.head);
      }
      if (sl.ease !== aim || !sl.tail.equals(sl.head)) moving = true;
      const b = i * SUBJECT_BEND_FLOATS;
      this.packed.set([sl.head.x, sl.ext.feet, sl.head.z, v.radius, sl.tail.x, sl.ext.feet + sl.ext.height, sl.tail.z, v.strength * sl.ease], b);
      this.count = i + 1;
    }
    this.target?.set(this.packed, this.count);
    if (moving) this.d.onChange?.();
  }

  /** The subjects asked for this frame into slots (the nearest to the camera kept when there are more). */
  private choose(camera: THREE.Camera): void {
    for (const sl of this.slots) if (sl !== null) sl.wanted = false;
    const target = this.d.cameraTarget();
    const ids = this.d.named() ?? (target !== null ? [target] : []);
    if (ids.length === 0) return;
    _eye.setFromMatrixPosition(camera.matrixWorld);
    const found: { id: string; dist: number }[] = [];
    for (const id of new Set(ids)) {
      if (!this.d.matrix(id, _m)) continue;
      found.push({ id, dist: _v.setFromMatrixPosition(_m).distanceToSquared(_eye) });
    }
    if (found.length > this.slots.length) {
      found.sort((a, b) => a.dist - b.dist);
      found.length = this.slots.length;
    }
    for (const f of found) {
      let sl = this.slots.find((x) => x !== null && x.id === f.id) ?? null;
      if (sl === null) {
        // A free slot, else the one leaving that has eased out most.
        let at = this.slots.indexOf(null);
        if (at < 0) {
          let low = Infinity;
          this.slots.forEach((x, i) => {
            if (x !== null && !x.wanted && x.ease < low) {
              low = x.ease;
              at = i;
            }
          });
        }
        if (at < 0) continue;
        sl = { id: f.id, wanted: false, ease: 0, started: false, ext: { centre: new THREE.Vector3(), feet: 0, height: 0, radius: 0 }, head: new THREE.Vector3(), tail: new THREE.Vector3() };
        this.slots[at] = sl;
      }
      sl.wanted = true;
    }
  }
}
