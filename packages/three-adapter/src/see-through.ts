/**
 * See-through on the renderer (the settings and their defaults are
 * project-model `see-through.ts`): what stands between the view's camera and
 * a subject thins to the shared dither (`dither-fade.ts`) in a soft circle
 * round the subject.
 *
 * The mask joins every lit or unlit node material's fragment stage where
 * three builds it (`setupDiffuseColor`, beside the material's own mask), for
 * the renderers a view armed: a view arms its renderer by putting itself in
 * `renderer.contextNode` (three merges that context into every build, and
 * its version is part of every draw's program key, so arming builds each
 * program again once, as a fog change would). That reaches every material
 * kind (standard, trim, layered surface, graph, terrain, skinned, instanced,
 * decals, classic materials three converts itself) with no copy mesh, no
 * extra draw and one program per material as before. An unarmed renderer
 * builds exactly what it built without see-through. The shadow pass draws
 * with its own material, which never takes the mask: a faded wall casts its
 * whole shadow. So do colourless draws (depth-only stand-ins) and draws over
 * everything (no depth test): they hide nothing.
 *
 * Only true occluders fade (`see-through-occluders.ts`): per subject, the
 * CPU finds what stands in the volume from the camera to its body (again only
 * when the camera or the subject moved): block pieces as world boxes, placed
 * models by their bounds (a merged or instanced draw by its members'). Each
 * occluder eases in and out over the fade time. A pixel fades for a subject
 * when its draw is an occluder as a whole, or its point (moved a quarter cell
 * against its face's normal) is inside one of the subject's boxes; when it is
 * inside the subject's circle; above half its height; and nearer the camera
 * along its own view ray than the body (the closest point of the ray to the
 * body's axis) by the depth margin. So a wall behind or beside the subject
 * never fades, under any camera pitch.
 *
 * Per view (render-group uniforms written once per render, for the view's
 * camera only; any other camera — a bake, a thumbnail — sees no subject): a
 * fixed array of subjects (`SEE_THROUGH_SUBJECTS`), each its circle's centre
 * and radii in view space at its depth, the plane half its height above its
 * feet, its axis, the depth margin and its fade; and each subject's boxes
 * (`SEE_THROUGH_OCCLUDERS`, merged when more are found, never dropped).
 *
 * Per drawn object (uniforms written per draw, like light layers): as bits,
 * the subjects it is an occluder of as a whole and the boxes its bounds
 * reach, and its own fade as each subject's occluder. An object with
 * `seeThrough: false` has none (no program of its own); a draw with no bit
 * skips the mask. A subject and everything under it in the entity hierarchy
 * (its model, a held item) drop their own subject's bits, so a subject never
 * fades itself, yet still fades for another subject it stands in front of. A
 * subject is an entity, drawn or not: a controller root whose model is a
 * child entity is sized by its capsule, else by what its descendants draw.
 *
 * A host that may turn see-through on in the middle of a run (a game whose
 * project setting is on: its scripts can turn it off and on) arms ahead
 * (`prebuild`): the programs are built with the mask before the first
 * present and skip it while nothing fades (one branch on a per-draw
 * uniform), so the switch rebuilds nothing. A project with the setting off
 * builds without it and pays nothing.
 *
 * Because the bits are per draw, a subject is drawn on its own while it is
 * one ({@link SUBJECT_DRAW_KEY}): a batch or a merged cell is one draw for
 * many objects and would fade the subject with its neighbours. Subjects are
 * few and usually move (static batching leaves them out in other engines
 * too), so this costs a draw or two, where telling instances or merged
 * vertices apart would cost every batch an attribute and its program.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { controllerCapsuleOf, controllerCapsuleOffsetZ, SEE_THROUGH_DEFAULTS, SEE_THROUGH_FIELDS, SEE_THROUGH_OCCLUDERS, SEE_THROUGH_SUBJECTS, seeThroughSettingsOf, type SeeThroughSettings } from '@thirdlight/runtime';

import { ditherKeep } from './dither-fade';
import type { N } from './effects-tsl';
import type { RenderGraph } from './render-graph';
import { layerOccluders, memberOccluders, mergeToFit, readMemberBounds, PieceCache, SEE_THROUGH_MEMBERS_KEY, SEE_THROUGH_PIECES_KEY, sphereMeetsBox, SubjectVolume, type OccluderBox, type OccluderLayer, type PackedBox, type SeeThroughMembers } from './see-through-occluders';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, If, all, cameraWorldMatrix, float, int, max, min, mix, normalViewGeometry, positionView, renderGroup, smoothstep, uniform, uniformArray, vec3, vec4 } = TSL;

/** `object.userData[SEE_THROUGH_KEY] === false`: the drawable never fades (absent: it takes part). */
export const SEE_THROUGH_KEY = '__tlSeeThrough';
/** `mesh.userData[SUBJECT_DRAW_KEY] === true`: its object is a see-through subject now, drawn out of batches and merged cells. */
export const SUBJECT_DRAW_KEY = '__tlSeeThroughSubject';
/** The key a view arms a renderer's context with. */
const CONTEXT_KEY = 'tlSeeThrough';

/** The circle's radius is at least this share of the subject's height (round its middle: past its head and feet). */
const BODY_COVER = 0.75;
/** A pixel this close to the camera plane counts as at it (no division by zero). */
const NEAR_Z = -1e-4;

/** Whether a drawable takes part (`seeThrough: false` opts out). */
export function objectSeeThrough(o: THREE.Object3D): boolean {
  return o.userData[SEE_THROUGH_KEY] !== false;
}

/** Put the flag on every mesh under `root`. Returns whether any mesh's flag changed (its batch must follow). */
export function applyObjectSeeThrough(root: THREE.Object3D, on: boolean): boolean {
  let changed = false;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh !== true || objectSeeThrough(o) === on) return;
    changed = true;
    if (on) delete o.userData[SEE_THROUGH_KEY];
    else o.userData[SEE_THROUGH_KEY] = false;
  });
  return changed;
}

/** Whether an entity's drawables take part: its box, model, instance set, block layer or terrain `seeThrough` (absent: true). */
export function seeThroughOfComponents(components: unknown): boolean {
  const c = components as Record<string, { seeThrough?: unknown } | undefined> | undefined;
  const part = c?.['box'] ?? c?.['model'] ?? c?.['instances'] ?? c?.['blockLayer'] ?? c?.['terrain'];
  return part?.seeThrough !== false;
}

/** Where a subject stands: the middle of its body (world), its feet's height, its height and its body's radius. */
export interface SubjectExtent {
  readonly centre: THREE.Vector3;
  feet: number;
  height: number;
  radius: number;
}

/**
 * A draw's bits: bit `k` (below `SEE_THROUGH_SUBJECTS`) says the draw is slot `k`'s occluder as a whole; the bits
 * after them are each slot's boxes in turn, those the draw's bounds reach. One 32-bit integer holds them all, and
 * a draw's own fade as each slot's occluder rides in one vec4.
 */
const BOX_BIT0 = SEE_THROUGH_SUBJECTS;
if (BOX_BIT0 + SEE_THROUGH_SUBJECTS * SEE_THROUGH_OCCLUDERS > 31 || SEE_THROUGH_SUBJECTS > 4) throw new Error('see-through: the subjects and their boxes must fit one signed 32-bit mask and one vec4');
/** The bit of slot `k`'s box `j`. */
export const seeThroughBoxBit = (k: number, j: number): number => 1 << (BOX_BIT0 + k * SEE_THROUGH_OCCLUDERS + j);
/** Every bit of slot `k` (its whole-draw bit and its boxes'). */
const slotBits = (k: number): number => (1 << k) | (((1 << SEE_THROUGH_OCCLUDERS) - 1) << (BOX_BIT0 + k * SEE_THROUGH_OCCLUDERS));

const _box = new THREE.Box3();
const _part = new THREE.Box3();
const _m = new THREE.Matrix4();
const _eye = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * A subject's extent: a character's controller capsule (its height, its
 * feet at the capsule's bottom; `matrix` is the entity's world matrix),
 * else the bounds of the visible meshes `drawn` for it and the entities
 * below it, else its origin with no height.
 */
export function subjectExtent(matrix: THREE.Matrix4, drawn: readonly THREE.Object3D[], components: unknown, out: SubjectExtent): void {
  const controller = (components as { controller?: unknown } | undefined)?.controller;
  if (controller !== undefined) {
    const cap = controllerCapsuleOf(controller);
    matrix.decompose(_v, _q, _s);
    const h = cap.height * Math.abs(_s.y);
    out.centre.set(cap.offset[0], cap.offset[1], controllerCapsuleOffsetZ(controller)).applyMatrix4(matrix);
    out.feet = out.centre.y - h / 2;
    out.height = h;
    out.radius = cap.radius * Math.max(Math.abs(_s.x), Math.abs(_s.z));
    return;
  }
  _box.makeEmpty();
  for (const root of drawn) {
    // What is hidden (an invisible node and all under it) and what is not a mesh (a line, a helper) does not size it.
    root.traverseVisible((o) => {
      const g = (o as THREE.Mesh).isMesh === true ? (o as THREE.Mesh).geometry : undefined;
      if (g === undefined) return;
      if (g.boundingBox === null) g.computeBoundingBox();
      if (g.boundingBox !== null && !g.boundingBox.isEmpty()) _box.union(_part.copy(g.boundingBox).applyMatrix4(o.matrixWorld));
    });
  }
  if (_box.isEmpty()) {
    out.centre.setFromMatrixPosition(matrix);
    out.feet = out.centre.y;
    out.height = 0;
    out.radius = 0;
    return;
  }
  _box.getCenter(out.centre);
  out.feet = _box.min.y;
  out.height = _box.max.y - _box.min.y;
  out.radius = Math.max(_box.max.x - _box.min.x, _box.max.z - _box.min.z) / 2;
}

/** One subject packed for the shader (view space of one camera). */
export interface SubjectPack {
  /** The circle's centre (view space, at the subject's depth) and whether the camera is a perspective one (1) or not (0). */
  readonly centre: THREE.Vector4;
  /** Inner and outer radius (metres at the subject's depth), unused, the fade. */
  readonly shape: THREE.Vector4;
  /** World up in view space (the body's axis runs along it through the centre) and the offset that makes `dot(plane.xyz, p) + plane.w` a pixel's height over half the subject's height. */
  readonly plane: THREE.Vector4;
  /** Half the body's height (its axis reaches that far either side of the centre), the metres a pixel must be nearer along its view ray, and the farthest a pixel may lie along its ray and still fade (view depth past it: never). */
  readonly body: THREE.Vector4;
}

/** Vec4s per subject in the packed array (centre, shape, plane, body). */
const PACK_VEC4S = 4;

export function emptyPack(): SubjectPack {
  return { centre: new THREE.Vector4(), shape: new THREE.Vector4(), plane: new THREE.Vector4(), body: new THREE.Vector4() };
}

/** The view's height (metres) at view distance `d` from `camera`. */
function viewHeightAt(camera: THREE.Camera, d: number): number {
  const o = camera as THREE.OrthographicCamera;
  if (o.isOrthographicCamera === true) return (o.top - o.bottom) / o.zoom;
  const p = camera as THREE.PerspectiveCamera;
  return (2 * d * Math.tan(THREE.MathUtils.degToRad(p.fov) / 2)) / p.zoom;
}

/** Pack one subject for `camera` (its world matrices current): the uniforms the mask reads. */
export function packSubject(camera: THREE.Camera, ext: SubjectExtent, s: Readonly<SeeThroughSettings>, fade: number, out: SubjectPack): void {
  const perspective = (camera as THREE.OrthographicCamera).isOrthographicCamera !== true;
  _v.copy(ext.centre).applyMatrix4(camera.matrixWorldInverse);
  const d = -_v.z;
  const outer = Math.max(s.radius * viewHeightAt(camera, Math.max(d, 0)), BODY_COVER * ext.height);
  const inner = Math.min(outer * (1 - s.softness), outer - 1e-4);
  // A subject behind a perspective camera has no circle on screen.
  const f = perspective && d <= 0 ? 0 : fade;
  out.centre.set(_v.x, _v.y, _v.z, perspective ? 1 : 0);
  out.shape.set(inner, outer, 0, f);
  // Along any ray the body is no farther than its centre's distance plus the axis's reach (half its height and the circle).
  const far = (perspective ? _v.length() : -_v.z) + ext.height / 2 + outer - s.depthMargin;
  out.body.set(ext.height / 2, s.depthMargin, far, 0);
  // A pixel's world height is row 1 of the camera's world matrix applied to its view position.
  const e = camera.matrixWorld.elements;
  out.plane.set(e[1]!, e[5]!, e[9]!, e[13]! - (ext.feet + ext.height / 2));
}

/**
 * The operations the mask is written in, once for both places it runs: TSL
 * nodes in the shader ({@link SeeThroughView.keep}), numbers on the CPU
 * ({@link seeThroughFadeAt}, what the tests and the bounds checks read). One
 * set of steps, so the shader and its reference cannot drift apart.
 */
interface FadeOps<F, B> {
  num(x: number): F;
  add(a: F, b: F): F;
  sub(a: F, b: F): F;
  mul(a: F, b: F): F;
  div(a: F, b: F): F;
  neg(a: F): F;
  min(a: F, b: F): F;
  max(a: F, b: F): F;
  sign(a: F): F;
  /** `a·(1−t) + b·t`. */
  mix(a: F, b: F, t: F): F;
  smoothstep(e0: F, e1: F, x: F): F;
  sqrt(a: F): F;
  ge(a: F, b: F): B;
  gt(a: F, b: F): B;
  le(a: F, b: F): B;
  lt(a: F, b: F): B;
  and(a: B, b: B): B;
  or(a: B, b: B): B;
  /** A value worked out once (a shader variable). */
  once(a: F): F;
  /** Run `body` only where `c` holds (a branch in the shader). */
  when(c: B, body: () => void): void;
  /** A variable (`name`: its name in the shader, unique per variable). */
  variable(init: F, name: string): { read(): F; write(v: F): void };
  /** Whether point `p` moved `lo[3]` against normal `n` lies in the box from `lo` to `hi` (xyz). */
  inBox(p: readonly [F, F, F], n: readonly [F, F, F], lo: readonly [F, F, F, F], hi: readonly [F, F, F, F]): B;
}

type Four<F> = readonly [F, F, F, F];
type Three<F> = readonly [F, F, F];

/** What the steps read: the pixel's view position, the box round the circles, and each slot. */
interface FadeInputs<F, B> {
  readonly p: Three<F>;
  /** The box (`circleRect`) and whether the view is perspective (1) or not (0). */
  readonly rect: Four<F>;
  readonly perspective: F;
  /** Whether the draw takes any of slot `k`'s bits and the slot is in use. */
  taken(k: number): B;
  /** Slot `k`'s pack: centre, shape, plane, body. */
  slot(k: number): { readonly c: Four<F>; readonly s: Four<F>; readonly pl: Four<F>; readonly body: Four<F> };
  /** Whether the draw is slot `k`'s occluder as a whole, and its fade as one. */
  whole(k: number): B;
  wholeFade(k: number): F;
  /** The largest fade of slot `k`'s boxes the pixel is in ({@link boxSteps}). */
  boxes(k: number): F;
}

/** What one slot's box steps read: the pixel, whether the draw takes box `j` and the box (min xyz and nudge, max xyz and fade). */
interface BoxInputs<F, B> {
  readonly world: Three<F>;
  readonly normal: Three<F>;
  taken(j: number): B;
  box(j: number): { readonly lo: Four<F>; readonly hi: Four<F> };
}

/**
 * The largest fade of one slot's boxes the draw takes that hold the pixel's point (moved by each box's nudge
 * against its face's normal). In the shader it is one function, built once and called per slot with the slot's
 * boxes as its arguments, so its body reads them with constant indices (a loop over the array cost the mask
 * twice as much on an Iris Xe) and is built once (unrolled per slot, it made every program's build several
 * times slower).
 */
function boxSteps<F, B>(o: FadeOps<F, B>, i: BoxInputs<F, B>, out: { read(): F; write(v: F): void }): void {
  for (let j = 0; j < SEE_THROUGH_OCCLUDERS; j++) {
    o.when(i.taken(j), () => {
      const { lo, hi } = i.box(j);
      o.when(o.inBox(i.world, i.normal, lo, hi), () => out.write(o.max(out.read(), hi[3])));
    });
  }
}

/** Below this, a view ray runs along the body's axis (a camera straight above): its nearest point is the axis's top. */
const PARALLEL = 1e-4;

/**
 * The fade of a pixel (the largest over the slots the draw takes of circle ×
 * occluder × the subject's fade, where the pixel is above half the subject's
 * height and nearer along its view ray than the body by the depth margin),
 * handed to `done` for a pixel inside the box round the circles; a pixel
 * outside it (most of the view) is left after four comparisons. The slots
 * are unrolled with constant indices (a dynamic index into the array cost
 * three times as much on an Iris Xe); a slot's circle is worked out only for
 * pixels it may fade, its boxes ({@link boxSteps}) only for those inside
 * the circle, and the depth along the ray only for those an occluder holds.
 *
 * The body's depth along the pixel's ray: the ray's point nearest the body's
 * axis (the line along world up through the centre): the line-line closest
 * point, the axis parameter kept within the circle's reach past the body's
 * ends; a ray along the axis (a camera straight above) meets it at the top.
 */
function fadeSteps<F, B>(o: FadeOps<F, B>, i: FadeInputs<F, B>, done: (fade: F) => void): void {
  const [px, py, pz] = i.p;
  const [rx0, ry0, rx1, ry1] = i.rect;
  const fade = o.variable(o.num(0), 'seeThroughFade');
  const invZ = o.once(o.div(o.num(1), o.min(pz, o.num(NEAR_Z))));
  const k = o.mix(o.num(1), o.neg(invZ), i.perspective);
  const ax = o.mul(px, k);
  const ay = o.mul(py, k);
  o.when(o.and(o.and(o.ge(ax, rx0), o.ge(ay, ry0)), o.and(o.le(ax, rx1), o.le(ay, ry1))), () => {
    // First what each slot would fade the pixel by as an occluder (the cheap tests: above half height, not past the
    // body's farthest reach, inside the circle, then in one of its boxes); the depth along the ray only after, for
    // the slots left: most pixels in a circle are in no occluder.
    const want: { read(): F; write(v: F): void }[] = [];
    let any: B | null = null;
    for (let n = 0; n < SEE_THROUGH_SUBJECTS; n++) {
      const w = o.variable(o.num(0), `seeThroughWant${n}`);
      want.push(w);
      o.when(i.taken(n), () => {
        const { c, s, pl, body } = i.slot(n);
        const height = o.add(o.add(o.add(o.mul(pl[0], px), o.mul(pl[1], py)), o.mul(pl[2], pz)), pl[3]);
        const m = o.mix(o.num(1), o.mul(c[2], invZ), c[3]);
        const qx = o.sub(o.mul(px, m), c[0]);
        const qy = o.sub(o.mul(py, m), c[1]);
        const d2 = o.once(o.add(o.mul(qx, qx), o.mul(qy, qy)));
        o.when(o.and(o.and(o.ge(height, o.num(0)), o.le(o.neg(pz), body[2])), o.lt(d2, o.mul(s[1], s[1]))), () => {
          // As an occluder: the draw as a whole, or the boxes its point is in.
          const occ = o.variable(i.boxes(n), `seeThroughOccluder${n}`);
          o.when(i.whole(n), () => occ.write(o.max(occ.read(), i.wholeFade(n))));
          w.write(o.mul(o.mul(s[3], occ.read()), o.sub(o.num(1), o.smoothstep(s[0], s[1], o.sqrt(d2)))));
        });
      });
      const more = o.gt(w.read(), o.num(0));
      any = any === null ? more : o.or(any, more);
    }
    o.when(any!, () => {
      // The pixel's view ray: from the eye (perspective) or from its own place on the view plane (orthographic), and
      // how far along it the pixel lies.
      const len = o.once(o.sqrt(o.add(o.add(o.mul(px, px), o.mul(py, py)), o.mul(pz, pz))));
      const flat = o.sub(o.num(1), i.perspective);
      const reach = o.once(o.mix(o.neg(pz), len, i.perspective));
      const dx = o.once(o.mul(o.div(px, len), i.perspective));
      const dy = o.once(o.mul(o.div(py, len), i.perspective));
      const dz = o.once(o.mix(o.num(-1), o.div(pz, len), i.perspective));
      const ox = o.once(o.mul(px, flat));
      const oy = o.once(o.mul(py, flat));
      for (let n = 0; n < SEE_THROUGH_SUBJECTS; n++) {
        const w = want[n]!;
        // A slot that would fade the pixel no more than one already passed needs no depth test (the fade is the largest).
        o.when(o.gt(w.read(), fade.read()), () => {
          const { c, s, pl, body } = i.slot(n);
          // From the body's centre to the ray's origin; the ray and the axis (world up in view space).
          const wx = o.sub(ox, c[0]);
          const wy = o.sub(oy, c[1]);
          const wz = o.neg(c[2]);
          const b = o.once(o.add(o.add(o.mul(dx, pl[0]), o.mul(dy, pl[1])), o.mul(dz, pl[2])));
          const dd = o.once(o.add(o.add(o.mul(dx, wx), o.mul(dy, wy)), o.mul(dz, wz)));
          const e = o.add(o.add(o.mul(pl[0], wx), o.mul(pl[1], wy)), o.mul(pl[2], wz));
          const det = o.once(o.sub(o.num(1), o.mul(b, b)));
          const along = o.variable(o.mul(o.neg(o.sign(b)), body[0]), `seeThroughAxis${n}`);
          o.when(o.gt(det, o.num(PARALLEL)), () => along.write(o.div(o.sub(e, o.mul(b, dd)), det)));
          // Along the axis line as far as the circle reaches past the body's ends: a ray over the head passes the
          // subject where it crosses the line, not where it is nearest the top of the head.
          const lim = o.add(body[0], s[1]);
          const t = o.min(o.max(along.read(), o.neg(lim)), lim);
          // How far along the ray the body is.
          const bodyAt = o.sub(o.mul(t, b), dd);
          o.when(o.le(reach, o.sub(bodyAt, body[1])), () => fade.write(w.read()));
        });
      }
    });
    done(fade.read());
  });
}

const CPU_OPS: FadeOps<number, boolean> = {
  num: (x) => x,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  neg: (a) => -a,
  min: Math.min,
  max: Math.max,
  sign: Math.sign,
  mix: (a, b, t) => a * (1 - t) + b * t,
  smoothstep: (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  },
  sqrt: Math.sqrt,
  ge: (a, b) => a >= b,
  gt: (a, b) => a > b,
  le: (a, b) => a <= b,
  lt: (a, b) => a < b,
  and: (a, b) => a && b,
  or: (a, b) => a || b,
  once: (a) => a,
  when: (c, body) => {
    if (c) body();
  },
  variable: (init) => {
    let v = init;
    return { read: () => v, write: (x) => void (v = x) };
  },
  inBox: (p, n, lo, hi) => {
    for (let a = 0; a < 3; a++) {
      const q = p[a]! - n[a]! * lo[3];
      if (q < lo[a]! || q > hi[a]!) return false;
    }
    return true;
  },
};

const TSL_OPS: FadeOps<N, N> = {
  num: (x) => float(x),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  neg: (a) => a.negate(),
  min: (a, b) => min(a, b),
  max: (a, b) => max(a, b),
  sign: (a) => a.sign(),
  mix: (a, b, t) => mix(a, b, t),
  smoothstep: (e0, e1, x) => smoothstep(e0, e1, x),
  sqrt: (a) => a.sqrt(),
  ge: (a, b) => a.greaterThanEqual(b),
  gt: (a, b) => a.greaterThan(b),
  le: (a, b) => a.lessThanEqual(b),
  lt: (a, b) => a.lessThan(b),
  and: (a, b) => a.and(b),
  or: (a, b) => a.or(b),
  once: (a) => a.toVar(),
  when: (c, body) => void If(c, body),
  variable: (init, name) => {
    const v = init.toVar(name);
    return { read: () => v, write: (x) => void v.assign(x) };
  },
  // One vector test (a handful of nodes): the boxes are unrolled for every slot, and node count is build time.
  inBox: (p, n, lo, hi) => {
    const q = vec3(p[0], p[1], p[2]).sub(vec3(n[0], n[1], n[2]).mul(lo[3]));
    return all(q.greaterThanEqual(vec3(lo[0], lo[1], lo[2]))).and(all(q.lessThanEqual(vec3(hi[0], hi[1], hi[2]))));
  },
};

const _rect = new THREE.Vector4();
const _lo = new THREE.Vector3();
const _hi = new THREE.Vector3();
/** A draw that is no subject's occluder as a whole. */
const NO_FADES = new THREE.Vector4();
/** Metres the eye or a subject must move (or a subject's size change) before its occluders are searched again. */
const SEARCH_GRAIN = 0.05;
/**
 * Metres the eye or a subject may move before every draw's bits are worked out again: a draw's bounds are tested
 * grown by it, so bits worked out a little earlier still hold every pixel that may fade (the mask tests each pixel).
 */
const DRAW_GRAIN = 0.1;
/** How far a column of the camera's rotation may change (about half a degree) before the draws' bits are worked out again. */
const TURN_GRAIN = 0.008;
/** The settings the draws' bits depend on. */
const SETTING_KEYS = ['radius', 'depthMargin', 'padding'] as const;
/** Frames a draw of many members stays searched after it was last drawn. */
const MEMBER_DRAW_FRAMES = 30;
const four = (v: THREE.Vector4): Four<number> => [v.x, v.y, v.z, v.w];

/** What a draw takes beside its bits, for the CPU reference: the pixel's world place and face normal, its whole-draw fades and the slots' boxes. */
export interface SeeThroughDrawInputs {
  /** The pixel's world position and its face's normal toward the camera (only read for boxes). */
  readonly world?: readonly [number, number, number];
  readonly normal?: readonly [number, number, number];
  /** The draw's fade as each slot's occluder as a whole (absent: 1). */
  readonly whole?: readonly number[];
  /** The view's boxes as packed (`SeeThroughView.packedBoxes`). */
  readonly boxes?: readonly THREE.Vector4[];
}

const ZERO3 = [0, 0, 0] as const;

/**
 * The fade of a pixel at view position `p`: the shader's own steps
 * ({@link fadeSteps}) run on numbers, for the first `count` subjects, with
 * the draw's bits `bits` (bit `k`: slot `k`'s occluder as a whole; then the
 * boxes, {@link seeThroughBoxBit}).
 */
export function seeThroughFadeAt(p: readonly [number, number, number], packs: readonly SubjectPack[], count: number, bits: number, draw: SeeThroughDrawInputs = {}): number {
  if (bits === 0) return 0;
  const perspective = circleRect(packs, count, _rect) ? 1 : 0;
  let out = 0;
  const box = (k: number, j: number): THREE.Vector4 => draw.boxes?.[(k * SEE_THROUGH_OCCLUDERS + j) * 2] ?? new THREE.Vector4();
  const boxHi = (k: number, j: number): THREE.Vector4 => draw.boxes?.[(k * SEE_THROUGH_OCCLUDERS + j) * 2 + 1] ?? new THREE.Vector4();
  const boxes = (k: number): number => {
    const v = CPU_OPS.variable(0, '');
    boxSteps(CPU_OPS, { world: draw.world ?? ZERO3, normal: draw.normal ?? ZERO3, taken: (j) => (bits & seeThroughBoxBit(k, j)) !== 0, box: (j) => ({ lo: four(box(k, j)), hi: four(boxHi(k, j)) }) }, v);
    return v.read();
  };
  fadeSteps(
    CPU_OPS,
    {
      p,
      rect: four(_rect),
      perspective,
      taken: (k) => (bits & slotBits(k)) !== 0 && k < count,
      slot: (k) => ({ c: four(packs[k]!.centre), s: four(packs[k]!.shape), pl: four(packs[k]!.plane), body: four(packs[k]!.body) }),
      whole: (k) => ((bits >> k) & 1) === 1,
      wholeFade: (k) => draw.whole?.[k] ?? 1,
      boxes,
    },
    (f) => (out = f),
  );
  return out;
}

/** Metres a draw's bounds are grown by for the test (a wind or a vertex offset past them). */
const BOUNDS_MARGIN = 0.5;
const _sphere = new THREE.Sphere();

const _c = new THREE.Vector3();

/**
 * Whether any point of a sphere (centre in view space, radius) may be faded by one subject: some of it not past
 * the subject's depth reach, above its half-height plane and, projected to the subject's depth, inside its outer
 * circle. Conservative: a sphere reaching the camera plane always may.
 */
export function mayFade(c: THREE.Vector3, r: number, p: SubjectPack): boolean {
  const { centre, shape, plane, body } = p;
  if (shape.w <= 0) return false;
  if (-(c.z + r) > body.z) return false;
  if (plane.x * c.x + plane.y * c.y + plane.z * c.z + plane.w + r < 0) return false;
  if (centre.w === 0) return Math.hypot(c.x - centre.x, c.y - centre.y) < shape.y + r;
  const near = c.z + r;
  if (near >= NEAR_Z) return true;
  // Projected to the subject's depth, the sphere's centre line runs from where its nearest depth puts it to where
  // its farthest does, and no part lies farther from that line than its radius at its nearest depth.
  const kn = centre.z / near;
  const kf = centre.z / (c.z - r);
  const ax = c.x * kf - centre.x;
  const ay = c.y * kf - centre.y;
  const dx = c.x * (kn - kf);
  const dy = c.y * (kn - kf);
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t) < shape.y + r * kn;
}

/** A draw's culling bounds in world space (null: it has none, {@link drawBounds}); one shared sphere, valid until the next call. */
function drawSphere(o: THREE.Object3D): THREE.Sphere | null {
  const b = drawBounds(o);
  return b === null ? null : _sphere.copy(b).applyMatrix4(o.matrixWorld);
}

/** The bounds a draw is culled by, when they are its geometry's (null: an instanced, batched or skinned draw, or one never culled). */
function drawBounds(o: THREE.Object3D): THREE.Sphere | null {
  const m = o as THREE.Mesh & { isInstancedMesh?: boolean; isBatchedMesh?: boolean; isSkinnedMesh?: boolean };
  if (m.isMesh !== true || m.frustumCulled === false || m.isInstancedMesh === true || m.isBatchedMesh === true || m.isSkinnedMesh === true) return null;
  const g = m.geometry;
  if (g === undefined || g === null) return null;
  if (g.boundingSphere === null) g.computeBoundingSphere();
  const b = g.boundingSphere;
  return b !== null && Number.isFinite(b.radius) ? b : null;
}

/**
 * The screen box round every live subject's outer circle, in the coordinates the mask tests a pixel in first:
 * a perspective view's `x / −z, y / −z` (the pixel's view position, its depth clamped as the mask clamps it), an
 * orthographic view's `x, y`. Empty (min past max) when nothing fades. Returns whether the view is perspective.
 */
export function circleRect(packs: readonly SubjectPack[], count: number, out: THREE.Vector4): boolean {
  out.set(Infinity, Infinity, -Infinity, -Infinity);
  let perspective = true;
  for (let i = 0; i < count; i++) {
    const { centre: c, shape } = packs[i]!;
    if (shape.w <= 0) continue;
    perspective = c.w !== 0;
    const k = perspective ? 1 / Math.max(-c.z, -NEAR_Z) : 1;
    const r = shape.y * k;
    out.set(Math.min(out.x, c.x * k - r), Math.min(out.y, c.y * k - r), Math.max(out.z, c.x * k + r), Math.max(out.w, c.y * k + r));
  }
  return perspective;
}

/** Diagnostics of a view's see-through. */
export interface SeeThroughDiagnostics {
  readonly enabled: boolean;
  /** Whether the view's renderer builds the mask. */
  readonly armed: boolean;
  /** The subjects in its slots, how far each has faded in (0 … 1, before the max fade) and its occluder boxes (found, fading out too). */
  readonly subjects: readonly { readonly id: string; readonly slot: number; readonly fade: number; readonly occluders: number }[];
  /** Subjects asked for past the array size, last frame (the farthest left out). */
  readonly leftOut: number;
  /** Main-thread milliseconds the occluder search took last frame (0: nothing moved). */
  readonly searchMs: number;
}

/**
 * What a host changes: the settings, and the subjects (entity ids; null: the
 * camera's target; an empty list: none, nothing fades — a script's empty list
 * is turned into null, the camera's target, before it gets here).
 */
export interface SeeThroughPatch extends Partial<SeeThroughSettings> {
  readonly subjects?: readonly string[] | null;
}

/** What the game's scripts set, as the runtime's view carries it (`ctx.camera.setSeeThrough`): whole settings and the subjects. */
export interface SeeThroughScripted {
  readonly settings: Readonly<SeeThroughSettings>;
  readonly subjects: readonly string[] | null;
}

/** Whether two scripted states say the same (the worker's view arrives as a new object every step). */
function sameScripted(a: SeeThroughScripted | null, b: SeeThroughScripted | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (SEE_THROUGH_FIELDS.some((k) => a.settings[k] !== b.settings[k])) return false;
  const x = a.subjects;
  const y = b.subjects;
  return x === y || (x !== null && y !== null && x.length === y.length && x.every((id, i) => id === y[i]));
}

/** A view's see-through, for its host (the project settings, a game's script, the editor's preview). */
export interface SeeThroughControl {
  set(patch: SeeThroughPatch): void;
  settings(): Readonly<SeeThroughSettings>;
  subjects(): readonly string[] | null;
  diagnostics(): SeeThroughDiagnostics;
}

/** Where a view finds its subjects: entities, through the engine's entity hierarchy. */
export interface SeeThroughEntities {
  /** An entity's world matrix into `out` (false: it is not realized). */
  matrix(id: string, out: THREE.Matrix4): boolean;
  /** What draws for the entity and for every entity below it (empty: nothing). */
  drawn(id: string): readonly THREE.Object3D[];
}

/** The render graph's entities as a view's subjects (what the adapter hands its view). */
export function seeThroughEntitiesOf(graph: RenderGraph): SeeThroughEntities {
  return { matrix: (id, out) => graph.worldMatrixOf(id, out), drawn: (id) => graph.subtreeNodes(id) };
}

export interface SeeThroughDeps extends SeeThroughEntities {
  /** An entity's components (a controller's capsule sizes a character). */
  components(id: string): unknown;
  /** The entity the camera follows (the subject when none is named). */
  cameraTarget(): string | null;
  /** What the game's scripts set (null: nothing yet; the host's settings stand). */
  scripted?(): SeeThroughScripted | null;
  /** On or off whatever the host or a script says (absent: as they say). */
  readonly pinned?: boolean;
  /**
   * Arm the renderer from the first frame, while off too: its programs are built with the mask (skipped
   * per draw while nothing fades) before the first present, so turning see-through on later changes only
   * uniforms and never rebuilds a program in the middle of a game (a game page: when the project's setting
   * is on). Absent: armed when first turned on, every program built again then (a script doing that is
   * reported, `see_through_rebuild`).
   */
  readonly prebuild?: boolean;
  /** Programs will be built again (the renderer armed): build them ahead of the next present. */
  requestPrecompile?(): void;
  /** A fade still eases: a host drawing on demand draws again. */
  onChange?(): void;
  /** More subjects than the arrays hold (once until it fits again). */
  onProblem?(code: string, message: string): void;
  /** The meshes under `root` became or stopped being a subject's: group them again (the batcher's `touch`). */
  regroup?(root: THREE.Object3D): void;
  /** The block layers drawn (their pieces are occluders). */
  occluderLayers?(): readonly OccluderLayer[];
}

/** A subject's occluder box as it eases in and out. */
interface TrackedBox extends PackedBox {
  /** Found by the last search. */
  wanted: boolean;
}

interface Slot {
  id: string;
  /** 0 … 1 eased in (times the max fade on the GPU). */
  fade: number;
  /** Whether it was asked for this frame. */
  wanted: boolean;
  readonly ext: SubjectExtent;
  /** The volume from the camera to its body, and what it was searched for last (the search runs again when that changes). */
  readonly vol: SubjectVolume;
  searched: string | null;
  /** Its occluder boxes by key. */
  readonly boxes: Map<string, TrackedBox>;
  /** A box eased last frame (its boxes are packed again while one does, or after a search). */
  easing: boolean;
}

/** A draw's members' world bounds as read (`readMemberBounds`), and what they were read for. */
interface MemberBounds {
  members: SeeThroughMembers;
  stamp: unknown;
  frame: number;
  readonly matrix: THREE.Matrix4;
  count: number;
  bounds: Float64Array;
  /** The draw's own bounds (world; radius −1: none), tested first. */
  readonly sphere: THREE.Sphere;
}

/** A draw's bits and its fade as each slot's occluder as a whole, worked out once a frame. */
interface DrawState {
  frame: number;
  bits: number;
  readonly whole: THREE.Vector4;
  /** What it was worked out from: the view's inputs, the slots asked for and its world matrix; and whether a fade still eases. */
  inputs: number;
  slots: number;
  readonly matrix: THREE.Matrix4;
  geometry: unknown;
  easing: boolean;
}

interface ArmedRenderer {
  contextNode: { value: Record<string, unknown>; needsUpdate: boolean };
}


/** The same objects in the same order. */
const sameList = (a: readonly THREE.Object3D[], b: readonly THREE.Object3D[]): boolean => a.length === b.length && a.every((o, i) => o === b[i]);

/** A view's subjects and the uniforms its renderer's programs read. */
export class SeeThroughView implements SeeThroughControl {
  /** What draws: the host's settings, or a script's over them, with the pin over either. */
  private s: SeeThroughSettings;
  private named: readonly string[] | null = null;
  /** The host's (the project's, an editor preview's). */
  private base: SeeThroughSettings;
  private baseNamed: readonly string[] | null = null;
  private script: SeeThroughScripted | null = null;
  private readonly slots: (Slot | null)[] = new Array<Slot | null>(SEE_THROUGH_SUBJECTS).fill(null);
  private readonly packs: SubjectPack[] = Array.from({ length: SEE_THROUGH_SUBJECTS }, emptyPack);
  /** Each slot's boxes as packed for the shader (min xyz + nudge, max xyz + fade), and how many each holds. */
  private readonly boxes: THREE.Vector4[] = Array.from({ length: SEE_THROUGH_SUBJECTS * SEE_THROUGH_OCCLUDERS * 2 }, () => new THREE.Vector4());
  private readonly boxCount: number[] = new Array<number>(SEE_THROUGH_SUBJECTS).fill(0);
  /** The step a fade eases by this frame (0 … 1). */
  private step = 1;
  /** Each draw's bits and whole-draw fades this frame. */
  private readonly draws = new WeakMap<THREE.Object3D, DrawState>();
  /** Draws of many members seen lately (their members are searched), by the frame they were last drawn. */
  private readonly memberDraws = new Map<THREE.Object3D, number>();
  private membersChanged = false;
  /** Draws' members' bounds as the search read them. */
  private readonly memberBounds = new WeakMap<THREE.Object3D, MemberBounds>();
  /** The block layers' pieces found so far (shared by the slots and kept across frames). */
  private readonly pieces = new PieceCache();
  /** The time the search took last frame (ms, main thread). */
  private searchMs = 0;
  /** The box round the circles (`circleRect`) and whether the view is perspective (1) or not (0). */
  private readonly rect = new THREE.Vector4();
  private perspective = 1;
  private armed: ArmedRenderer | null = null;
  private readonly ahead: boolean;
  private camera: THREE.Camera | null = null;
  private frame = 0;
  /** The frame the packs were last filled for. */
  private filled = -1;
  /** Bumped when what every draw's state is worked out from changed (the camera, the packs, the boxes, the slots in use), and those as they stood. */
  private inputs = 0;
  private readonly lastInputs = new Float64Array(9 + 16 + 2 + SETTING_KEYS.length + SEE_THROUGH_SUBJECTS * 7 + SEE_THROUGH_SUBJECTS * SEE_THROUGH_OCCLUDERS * 2 * 4).fill(NaN);
  /** The slots were chosen before this frame's batches were grouped (`beforeBatch`). */
  private followed = false;
  /** Bits of the slots with a fade this frame. */
  private live = 0;
  private count = 0;
  private leftOut = 0;
  private reported = false;
  private at: number | null = null;
  private nodes: { mask: N } | null = null;
  /** The slots' subjects whose drawn objects are marked to draw on their own, and those objects. */
  private readonly alone = new Map<string, readonly THREE.Object3D[]>();
  /** What belongs to a subject this frame, and to which slots' (it never fades for them). Kept here, not on the object, so nothing of the view rides along when an object is cloned or saved. */
  private readonly self = new WeakMap<THREE.Object3D, { frame: number; bits: number }>();
  /** The bits and whole-draw fades each draw (render object) was last refreshed with. */
  private readonly uploaded = new WeakMap<object, { bits: number; whole: THREE.Vector4 }>();

  constructor(
    private readonly d: SeeThroughDeps,
    settings?: Partial<SeeThroughSettings>,
  ) {
    this.base = seeThroughSettingsOf(settings ?? {}, SEE_THROUGH_DEFAULTS);
    this.ahead = d.prebuild === true;
    this.s = this.resolved();
  }

  set(patch: SeeThroughPatch): void {
    this.base = seeThroughSettingsOf(patch, this.base);
    if (patch.subjects !== undefined) this.baseNamed = patch.subjects === null ? null : [...patch.subjects];
    this.s = this.resolved();
    this.d.onChange?.();
  }

  /** The settings that draw, and the subjects named with them. */
  private resolved(): SeeThroughSettings {
    const sc = this.script;
    this.named = sc !== null ? sc.subjects : this.baseNamed;
    const s = sc !== null ? seeThroughSettingsOf(sc.settings) : { ...this.base };
    if (this.d.pinned !== undefined) s.enabled = this.d.pinned;
    return s;
  }

  /** Follow what the game's scripts set (each change once). */
  private followScript(): void {
    const sc = this.d.scripted?.() ?? null;
    if (sameScripted(sc, this.script)) return;
    this.script = sc;
    this.s = this.resolved();
  }

  settings(): Readonly<SeeThroughSettings> {
    return this.s;
  }

  subjects(): readonly string[] | null {
    return this.named;
  }

  diagnostics(): SeeThroughDiagnostics {
    const subjects: { id: string; slot: number; fade: number; occluders: number }[] = [];
    this.slots.forEach((sl, i) => {
      if (sl !== null) subjects.push({ id: sl.id, slot: i, fade: sl.fade, occluders: sl.boxes.size });
    });
    return { enabled: this.s.enabled, armed: this.armed !== null, subjects, leftOut: this.leftOut, searchMs: this.searchMs };
  }

  /**
   * Before the frame's batches are grouped (the entities' world matrices
   * composed): the subjects asked for go into the slots (the nearest kept),
   * and what the slots' subjects draw (those fading out too) draws on its
   * own, the rest goes back. Only a subject that holds a slot leaves its
   * batch. Every mesh is checked, so one loaded under a subject later
   * follows.
   */
  beforeBatch(camera?: THREE.Camera): void {
    this.followScript();
    if (this.s.enabled || this.slots.some((sl) => sl !== null)) {
      this.follow(camera ?? this.camera);
      this.followed = true;
    }
    const want = new Map<string, readonly THREE.Object3D[]>();
    for (const sl of this.slots) if (sl !== null) want.set(sl.id, this.d.drawn(sl.id));
    for (const [id, objects] of this.alone) {
      const now = want.get(id);
      if (now !== undefined && sameList(now, objects)) continue;
      for (const o of objects) this.drawAlone(o, false);
      this.alone.delete(id);
    }
    for (const [id, objects] of want) {
      for (const o of objects) this.drawAlone(o, true);
      this.alone.set(id, objects);
    }
  }

  private drawAlone(root: THREE.Object3D, on: boolean): void {
    let changed = false;
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh !== true || (o.userData[SUBJECT_DRAW_KEY] === true) === on) return;
      changed = true;
      if (on) o.userData[SUBJECT_DRAW_KEY] = true;
      else delete o.userData[SUBJECT_DRAW_KEY];
    });
    if (changed) this.d.regroup?.(root);
  }

  /**
   * Before the frame's draw (world matrices current): arm the renderer once
   * see-through is on, measure the subjects and ease their fades. Off and
   * never on: nothing at all.
   */
  update(renderer: unknown, camera: THREE.Camera, now: number = performance.now()): void {
    const r = renderer as Partial<ArmedRenderer>;
    const followed = this.followed;
    this.followed = false;
    this.followScript();
    const ahead = this.ahead && this.d.pinned !== false;
    if (!this.s.enabled && this.armed === null && !ahead) {
      this.forgetMemberDraws();
      return;
    }
    if ((this.s.enabled || ahead) && this.armed !== r && r.contextNode !== undefined) {
      // A script turned it on in a page that did not build the mask ahead: every program is built again now.
      if (!ahead && this.armed === null && this.script?.settings.enabled === true && this.d.pinned === undefined) {
        this.d.onProblem?.('see_through_rebuild', 'A script turned see-through on while the project\'s Rendering → See-through setting is off, so every shader was built again in the middle of the game (the picture holds until they are ready). Turn on Rendering → See-through so the mask is built at load, and turn it off from a script at the start if the game wants it only in places.');
      }
      this.arm(r as ArmedRenderer);
    }
    this.camera = camera;
    const dt = this.at === null ? 0 : Math.min(0.1, Math.max(0, (now - this.at) / 1000));
    this.at = now;
    // Off with nothing fading out: no subject is followed (an armed renderer's programs skip the mask).
    if (!this.s.enabled && this.slots.every((sl) => sl === null)) {
      this.live = 0;
      this.count = 0;
      this.forgetMemberDraws();
      return;
    }
    this.frame += 1;
    // A host that groups no batches (or a frame before its first) chooses the slots here.
    if (!followed) this.follow(camera);
    const step = this.s.fadeTime > 0 ? dt / this.s.fadeTime : 1;
    this.step = step;
    let easing = false;
    const t0 = performance.now();
    let searched = false;
    _eye.setFromMatrixPosition(camera.matrixWorld);
    const layers = this.d.occluderLayers?.() ?? [];
    this.pieces.keep(new Set(layers.map((l) => l.id)));
    this.pruneMemberDraws();
    this.memberStamps();
    this.live = 0;
    this.count = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const sl = this.slots[i];
      if (sl === null || sl === undefined) continue;
      const target = sl.wanted && this.s.enabled ? 1 : 0;
      sl.fade = target > sl.fade ? Math.min(target, sl.fade + step) : Math.max(target, sl.fade - step);
      if (sl.fade !== target) easing = true;
      if (sl.fade <= 0 && target === 0) {
        this.slots[i] = null;
        continue;
      }
      if (sl.fade > 0) this.live |= 1 << i;
      this.count = i + 1;
      // Measured where it stands now (one gone keeps its last place while it fades out); it and everything under it never fade for it.
      const drawn = this.d.drawn(sl.id);
      if (this.d.matrix(sl.id, _m)) subjectExtent(_m, drawn, this.d.components(sl.id), sl.ext);
      for (const o of drawn) this.markSelf(o, i);
      const found = this.search(sl, layers);
      if (found) searched = true;
      // Boxes neither found again nor easing pack as they stood.
      if ((found || sl.easing) && this.easeBoxes(sl, i, step)) easing = true;
    }
    this.membersChanged = false;
    this.searchMs = searched ? performance.now() - t0 : 0;
    if (easing) this.d.onChange?.();
  }

  /** Off: hold no draws (an unloaded instanced draw is let go now, not when see-through comes back on). */
  private forgetMemberDraws(): void {
    if (this.memberDraws.size === 0) return;
    this.memberDraws.clear();
    this.membersChanged = true;
  }

  /**
   * A member draw whose members moved since the search read them (its stamp, or the draw itself): search again,
   * though the camera and the subjects stand still (a script moving instances). A draw without a stamp is read
   * again with each search only.
   */
  private memberStamps(): void {
    if (this.membersChanged) return;
    for (const draw of this.memberDraws.keys()) {
      const m = this.memberBounds.get(draw);
      const members = draw.userData[SEE_THROUGH_MEMBERS_KEY] as SeeThroughMembers | undefined;
      if (m === undefined || members === undefined || m.stamp === undefined) continue;
      if (m.members !== members || m.stamp !== members.stamp?.() || !m.matrix.equals(draw.matrixWorld)) {
        this.membersChanged = true;
        return;
      }
    }
  }

  /** Drop the member draws not drawn for a while (gone, or out of view). */
  private pruneMemberDraws(): void {
    for (const [o, at] of this.memberDraws) {
      if (this.frame - at <= MEMBER_DRAW_FRAMES) continue;
      this.memberDraws.delete(o);
      this.membersChanged = true;
    }
  }

  /**
   * Find a slot's occluders again when the eye, its body, the padding, a block layer or the draws of many members
   * changed since the last search (true: it ran). Boxes found keep their fade by their key; a box new where one of
   * the slot's stood (a piece found from another cell) starts at that one's fade, so nothing flickers.
   */
  private search(sl: Slot, layers: readonly OccluderLayer[]): boolean {
    const e = sl.ext;
    let key = `${this.s.padding}`;
    for (const l of layers) key += `|${l.id}:${l.version}:${l.origin.join(',')}`;
    // Within the search's grain of where the last search stood (an animated body's bounds, a camera settling, a
    // subject bobbing): the same occluders.
    const v = sl.vol;
    const still = v.eye.distanceTo(_eye) <= SEARCH_GRAIN && v.centre.distanceTo(e.centre) <= SEARCH_GRAIN && Math.abs(v.height - e.height) <= SEARCH_GRAIN && Math.abs(v.radius - e.radius) <= SEARCH_GRAIN;
    if (still && key === sl.searched && !this.membersChanged) return false;
    const fresh = sl.searched === null;
    sl.searched = key;
    const vol = sl.vol.set(_eye, e, this.s.padding);
    const found: OccluderBox[] = [];
    for (const l of layers) layerOccluders(l, vol, found, this.pieces.of(l));
    for (const draw of this.memberDraws.keys()) {
      const members = draw.userData[SEE_THROUGH_MEMBERS_KEY] as SeeThroughMembers | undefined;
      if (members === undefined) continue;
      const m = this.membersOf(draw, members);
      if (m.sphere.radius >= 0 && !vol.meetsSphere(m.sphere.center, m.sphere.radius + BOUNDS_MARGIN)) continue;
      memberOccluders(draw, m.bounds, m.count, vol, found);
    }
    for (const b of sl.boxes.values()) b.wanted = false;
    for (const f of found) {
      const had = sl.boxes.get(f.key);
      if (had !== undefined) {
        had.wanted = true;
        continue;
      }
      // A slot's first boxes come in with the slot's own fade; a box where others stand starts at theirs.
      let start = fresh ? 1 : 0;
      for (const b of sl.boxes.values()) if (b.fade > start && f.min.x <= b.max.x && f.max.x >= b.min.x && f.min.y <= b.max.y && f.max.y >= b.min.y && f.min.z <= b.max.z && f.max.z >= b.min.z) start = b.fade;
      sl.boxes.set(f.key, { min: f.min, max: f.max, nudge: f.nudge, fade: start, wanted: true });
    }
    return true;
  }

  /** A draw's members' bounds, read again only when its stamp or world matrix changed (without a stamp: once a frame). */
  private membersOf(draw: THREE.Object3D, members: SeeThroughMembers): MemberBounds {
    const stamp = members.stamp?.();
    let m = this.memberBounds.get(draw);
    if (m !== undefined && m.members === members && (stamp === undefined ? m.frame === this.frame : m.stamp === stamp && m.matrix.equals(draw.matrixWorld))) return m;
    if (m === undefined) this.memberBounds.set(draw, (m = { members, stamp, frame: this.frame, matrix: draw.matrixWorld.clone(), count: 0, bounds: new Float64Array(0), sphere: new THREE.Sphere() }));
    m.members = members;
    m.stamp = stamp;
    m.frame = this.frame;
    m.matrix.copy(draw.matrixWorld);
    m.count = members.count();
    m.bounds = readMemberBounds(members, m.bounds);
    const sphere = drawSphere(draw);
    if (sphere === null) m.sphere.radius = -1;
    else m.sphere.copy(sphere);
    return m;
  }

  /** Ease a slot's boxes toward found or gone and pack them for the shader (merged when more than fit); true while one eases. */
  private easeBoxes(sl: Slot, k: number, step: number): boolean {
    let easing = false;
    const live: PackedBox[] = [];
    for (const [key, b] of sl.boxes) {
      const target = b.wanted ? 1 : 0;
      b.fade = target > b.fade ? Math.min(target, b.fade + step) : Math.max(target, b.fade - step);
      if (b.fade !== target) easing = true;
      if (b.fade <= 0 && !b.wanted) {
        sl.boxes.delete(key);
        continue;
      }
      if (b.fade > 0) live.push({ min: b.min.clone(), max: b.max.clone(), nudge: b.nudge, fade: b.fade });
    }
    mergeToFit(live, SEE_THROUGH_OCCLUDERS);
    for (let j = 0; j < SEE_THROUGH_OCCLUDERS; j++) {
      const lo = this.boxes[(k * SEE_THROUGH_OCCLUDERS + j) * 2]!;
      const hi = this.boxes[(k * SEE_THROUGH_OCCLUDERS + j) * 2 + 1]!;
      const b = live[j];
      if (b === undefined) {
        lo.set(0, 0, 0, 0);
        hi.set(0, 0, 0, 0);
        continue;
      }
      lo.set(b.min.x, b.min.y, b.min.z, b.nudge);
      hi.set(b.max.x, b.max.y, b.max.z, b.fade);
    }
    this.boxCount[k] = live.length;
    sl.easing = easing;
    return easing;
  }

  /** The subjects asked for this frame into slots (the nearest to the camera kept when there are more than slots). */
  private follow(camera: THREE.Camera | null): void {
    for (const sl of this.slots) if (sl !== null) sl.wanted = false;
    if (!this.s.enabled) return;
    const target = this.d.cameraTarget();
    const ids = this.named ?? (target !== null ? [target] : []);
    if (camera !== null) _eye.setFromMatrixPosition(camera.matrixWorld);
    else _eye.set(0, 0, 0);
    const found: { id: string; dist: number }[] = [];
    for (const id of new Set(ids)) {
      if (!this.d.matrix(id, _m)) continue;
      found.push({ id, dist: _v.setFromMatrixPosition(_m).distanceToSquared(_eye) });
    }
    this.leftOut = Math.max(0, found.length - this.slots.length);
    if (this.leftOut > 0) {
      found.sort((a, b) => a.dist - b.dist);
      found.length = this.slots.length;
      if (!this.reported) {
        this.reported = true;
        this.d.onProblem?.('see_through_subjects', `See-through fades round at most ${SEE_THROUGH_SUBJECTS} subjects per view; ${this.leftOut} more were asked for and the farthest from the camera are left out.`);
      }
    } else this.reported = false;
    for (const f of found) {
      let sl = this.slots.find((x) => x !== null && x.id === f.id) ?? null;
      if (sl === null) {
        // A free slot, else the one fading out that has faded most.
        let at = this.slots.indexOf(null);
        if (at < 0) {
          let low = Infinity;
          this.slots.forEach((x, i) => {
            if (x !== null && !x.wanted && x.fade < low) {
              low = x.fade;
              at = i;
            }
          });
        }
        if (at < 0) continue;
        sl = { id: f.id, fade: 0, wanted: false, ext: { centre: new THREE.Vector3(), feet: 0, height: 0, radius: 0 }, vol: new SubjectVolume(), searched: null, boxes: new Map(), easing: false };
        this.slots[at] = sl;
      }
      sl.wanted = true;
    }
  }

  private markSelf(root: THREE.Object3D, slot: number): void {
    const frame = this.frame;
    root.traverse((o) => {
      const m = this.self.get(o);
      if (m !== undefined && m.frame === frame) m.bits |= 1 << slot;
      else if (m !== undefined) {
        m.frame = frame;
        m.bits = 1 << slot;
      } else this.self.set(o, { frame, bits: 1 << slot });
    });
  }

  /**
   * A draw's bits this frame (see {@link seeThroughBoxBit}): for each slot whose subject is not its own, whether it
   * is that subject's occluder as a whole (its bounds meet the subject's volume: a draw of block pieces or of
   * many members never is), and the slot's boxes its bounds reach. A draw left with none skips the mask, so a
   * draw pays only for the occluders near it. A draw three does not cull by bounds is every live slot's
   * occluder as a whole (the depth guard still keeps what is behind).
   */
  bitsFor(object: THREE.Object3D, camera?: THREE.Camera): number {
    if (this.live === 0 || !objectSeeThrough(object)) return 0;
    const m = this.self.get(object);
    const mine = m !== undefined && m.frame === this.frame ? this.live & ~m.bits : this.live;
    if (mine === 0) return 0;
    if (camera === undefined || camera !== this.camera) return mine;
    return this.drawState(object, mine).bits;
  }

  /** A draw's bits and whole-draw fades, worked out once a frame for the view's camera (the fades eased then). */
  private drawState(object: THREE.Object3D, slots: number): DrawState {
    let st = this.draws.get(object);
    if (st !== undefined && st.frame === this.frame) return st;
    // A draw not drawn last frame takes its fades as they stand now: nothing eased while it was out of view.
    const fresh = st === undefined || st.frame !== this.frame - 1;
    if (this.camera !== null) this.ensureFilled(this.camera);
    // Drawn last frame, settled, unmoved and the view's inputs as they were: the same bits (most draws, most frames).
    if (!fresh && !st!.easing && st!.inputs === this.inputs && st!.slots === slots && st!.matrix.equals(object.matrixWorld) && st!.geometry === (object as THREE.Mesh).geometry) {
      st!.frame = this.frame;
      if (object.userData[SEE_THROUGH_MEMBERS_KEY] !== undefined) this.memberDraws.set(object, this.frame);
      return st!;
    }
    if (st === undefined) {
      st = { frame: this.frame, bits: 0, whole: new THREE.Vector4(), inputs: -1, slots: 0, matrix: new THREE.Matrix4(), geometry: null, easing: false };
      this.draws.set(object, st);
    }
    st.frame = this.frame;
    st.inputs = this.inputs;
    st.slots = slots;
    st.matrix.copy(object.matrixWorld);
    st.geometry = (object as THREE.Mesh).geometry;
    st.easing = false;
    const members = object.userData[SEE_THROUGH_MEMBERS_KEY] as SeeThroughMembers | undefined;
    if (members !== undefined && !this.memberDraws.has(object)) this.membersChanged = true;
    if (members !== undefined) this.memberDraws.set(object, this.frame);
    const pieces = members !== undefined || object.userData[SEE_THROUGH_PIECES_KEY] === true;
    const sphere = drawSphere(object);
    // The sphere's centre in view space, once for every slot.
    const view = sphere !== null && this.camera !== null && this.filled === this.frame ? _c.copy(sphere.center).applyMatrix4(this.camera.matrixWorldInverse) : null;
    let bits = 0;
    for (let k = 0; k < this.count; k++) {
      const sl = this.slots[k];
      let target = 0;
      if (((slots >> k) & 1) === 1 && sl !== null && sl !== undefined) {
        if (sphere === null) target = pieces ? 0 : 1;
        else if (view === null ? this.mayFadeSphere(sphere, k) : mayFade(view, sphere.radius + BOUNDS_MARGIN + DRAW_GRAIN, this.packs[k]!)) {
          const r = sphere.radius + BOUNDS_MARGIN;
          if (!pieces && sl.vol.meetsSphere(sphere.center, r + DRAW_GRAIN)) target = 1;
          for (let j = 0; j < this.boxCount[k]!; j++) {
            const lo = this.boxes[(k * SEE_THROUGH_OCCLUDERS + j) * 2]!;
            const hi = this.boxes[(k * SEE_THROUGH_OCCLUDERS + j) * 2 + 1]!;
            _lo.set(lo.x, lo.y, lo.z);
            _hi.set(hi.x, hi.y, hi.z);
            if (sphereMeetsBox(sphere.center, r + lo.w, _lo, _hi)) bits |= seeThroughBoxBit(k, j);
          }
        }
      }
      const f = st.whole.getComponent(k);
      const next = fresh ? target : target > f ? Math.min(target, f + this.step) : Math.max(target, f - this.step);
      st.whole.setComponent(k, next);
      if (next !== target) st.easing = true;
      if (next > 0) bits |= 1 << k;
    }
    for (let k = this.count; k < SEE_THROUGH_SUBJECTS; k++) st.whole.setComponent(k, 0);
    st.bits = bits;
    return st;
  }

  /** Whether any point of a world sphere may fade for slot `k` at all (its circle, depth reach and half height; the packs filled for the view's camera). */
  private mayFadeSphere(sphere: THREE.Sphere, k: number): boolean {
    if (this.camera === null || this.ensureFilled(this.camera) <= k) return true;
    _c.copy(sphere.center).applyMatrix4(this.camera.matrixWorldInverse);
    return mayFade(_c, sphere.radius + BOUNDS_MARGIN + DRAW_GRAIN, this.packs[k]!);
  }

  /** A draw's fade as each slot's occluder as a whole (its bits worked out first). */
  wholeFadesFor(object: THREE.Object3D, camera: THREE.Camera): THREE.Vector4 {
    if (this.bitsFor(object, camera) === 0) return NO_FADES;
    return this.draws.get(object)?.whole ?? NO_FADES;
  }

  /** Whether the bits or whole-draw fades `bitsFor` gives a draw (one render object: an object for a camera) differ from those it last uploaded. */
  bitsChanged(draw: object, object: THREE.Object3D, camera: THREE.Camera): boolean {
    const bits = this.bitsFor(object, camera);
    const w = bits === 0 ? NO_FADES : (this.draws.get(object)?.whole ?? NO_FADES);
    let up = this.uploaded.get(draw);
    if (up !== undefined && up.bits === bits && up.whole.equals(w)) return false;
    if (up === undefined) this.uploaded.set(draw, (up = { bits, whole: new THREE.Vector4() }));
    up.bits = bits;
    up.whole.copy(w);
    return true;
  }

  /** The view's boxes as packed for the shader (tests run them through the CPU reference). */
  packedBoxes(): readonly THREE.Vector4[] {
    return this.boxes;
  }

  /** The packs filled once per frame for the view's camera (whichever uniform or draw asks first); the slots in use. */
  private ensureFilled(camera: THREE.Camera): number {
    if (camera !== this.camera || this.live === 0) return 0;
    return this.filled === this.frame ? this.count : this.fill(camera);
  }

  /** Fill the packs for the render's camera; the number of slots in use (0 for any camera but the view's). */
  fill(camera: THREE.Camera): number {
    if (camera !== this.camera || this.live === 0) return 0;
    this.filled = this.frame;
    for (let i = 0; i < this.count; i++) {
      const sl = this.slots[i];
      const p = this.packs[i]!;
      if (sl === null || sl === undefined || sl.fade <= 0) {
        p.shape.w = 0;
        continue;
      }
      const t = sl.fade;
      packSubject(camera, sl.ext, this.s, t * t * (3 - 2 * t) * this.s.maxFade, p);
    }
    this.perspective = circleRect(this.packs, this.count, this.rect) ? 1 : 0;
    this.noteInputs(camera);
    return this.count;
  }

  /**
   * Bump {@link inputs} when what the draws' bits are worked out from moved past what their tests allow for
   * ({@link DRAW_GRAIN}): the eye or a subject moved half the grain from where they stood then, the camera turned
   * or its projection, the settings, the slots in use or a box changed (a box's fade alone does not count).
   */
  private noteInputs(camera: THREE.Camera): void {
    const a = this.lastInputs;
    let changed = false;
    let i = 0;
    const same = (v: number): void => {
      if (a[i++] !== v) changed = true;
    };
    const near = (v: number): void => {
      if (!(Math.abs(a[i++]! - v) <= DRAW_GRAIN / 2)) changed = true;
    };
    const e = camera.matrixWorld.elements;
    near(e[12]!);
    near(e[13]!);
    near(e[14]!);
    // The view's direction and up: a turn of about half a degree.
    for (const k of [4, 5, 6, 8, 9, 10]) if (!(Math.abs(a[i++]! - e[k]!) <= TURN_GRAIN)) changed = true;
    for (const v of camera.projectionMatrix.elements) same(v);
    same(this.count);
    same(this.live);
    for (const k of SETTING_KEYS) same(this.s[k]);
    for (let k = 0; k < SEE_THROUGH_SUBJECTS; k++) {
      const ext = this.slots[k]?.ext;
      near(ext?.centre.x ?? 0);
      near(ext?.centre.y ?? 0);
      near(ext?.centre.z ?? 0);
      near(ext?.feet ?? 0);
      near(ext?.height ?? 0);
      near(ext?.radius ?? 0);
      same(this.boxCount[k]!);
    }
    for (let j = 0; j < this.boxes.length; j++) {
      const v = this.boxes[j]!;
      same(v.x);
      same(v.y);
      same(v.z);
      // The max's fourth is its fade.
      if (j % 2 === 0) same(v.w);
      else i += 1;
    }
    if (!changed) return;
    this.inputs += 1;
    // Where things stood for the draws worked out from now on.
    i = 0;
    const put = (v: number): void => void (a[i++] = v);
    for (const k of [12, 13, 14, 4, 5, 6, 8, 9, 10]) put(e[k]!);
    for (const v of camera.projectionMatrix.elements) put(v);
    put(this.count);
    put(this.live);
    for (const k of SETTING_KEYS) put(this.s[k]);
    for (let k = 0; k < SEE_THROUGH_SUBJECTS; k++) {
      const ext = this.slots[k]?.ext;
      for (const v of [ext?.centre.x ?? 0, ext?.centre.y ?? 0, ext?.centre.z ?? 0, ext?.feet ?? 0, ext?.height ?? 0, ext?.radius ?? 0, this.boxCount[k]!]) put(v);
    }
    for (const v of this.boxes) (put(v.x), put(v.y), put(v.z), put(v.w));
  }

  /** The packs as filled last (tests read them against the CPU reference). */
  packed(): readonly SubjectPack[] {
    return this.packs;
  }

  /** The keep test this view's programs AND into their mask (made once per view). */
  keep(): N {
    if (this.nodes !== null) return this.nodes.mask;
    // Each render-group uniform fills the packs for the render's camera when it is updated, whichever three updates first.
    const filled = ({ camera }: { camera: THREE.Camera }): number => this.ensureFilled(camera);
    // One array (each subject's centre, shape, plane and body in turn, then every slot's boxes): one uniform buffer bound per draw.
    const packed = uniformArray([...this.packs.flatMap((p) => [p.centre, p.shape, p.plane, p.body]), ...this.boxes], 'vec4')
      .setGroup(renderGroup)
      .onRenderUpdate((f: { camera: THREE.Camera }) => void filled(f));
    const boxAt = SEE_THROUGH_SUBJECTS * PACK_VEC4S;
    const count = uniform(0, 'int').setGroup(renderGroup).onRenderUpdate(filled);
    const rect = uniform(this.rect, 'vec4')
      .setGroup(renderGroup)
      .onRenderUpdate((f: { camera: THREE.Camera }) => (filled(f), this.rect));
    const perspective = uniform(0)
      .setGroup(renderGroup)
      .onRenderUpdate((f: { camera: THREE.Camera }) => (filled(f), this.perspective));
    const bits = uniform(0, 'int').onObjectUpdate(({ object, camera }: { object: THREE.Object3D; camera: THREE.Camera }) => this.bitsFor(object, camera));
    const whole = uniform(new THREE.Vector4()).onObjectUpdate(({ object, camera }: { object: THREE.Object3D; camera: THREE.Camera }) => this.wholeFadesFor(object, camera));
    const vec = (v: N): Four<N> => [v.x, v.y, v.z, v.w];
    const at = (k: number): N => int(k);
    // One slot's boxes as one shader function (built once per program, called per slot with the slot's boxes).
    // Everything it reads comes in as arguments: a uniform named inside a function's own build need not match the program's.
    const boxInputs = [{ name: 'taken', type: 'int' }, { name: 'pv', type: 'vec3' }, { name: 'face', type: 'vec3' }, { name: 'cw', type: 'mat4' }, { name: 'persp', type: 'float' }, ...Array.from({ length: SEE_THROUGH_OCCLUDERS * 2 }, (_, k) => ({ name: `b${k}`, type: 'vec4' }))];
    const slotBoxesFn = Fn(([taken, pv, face, cw, persp, ...b]: N[]) => {
      const out = float(0).toVar('seeThroughBoxFade');
      // The pixel in the world and its face's normal turned toward the camera (along the view ray: from the origin
      // in a perspective view, along −z in an orthographic one).
      const nv = face.toVar('seeThroughNormal');
      nv.assign(nv.div(max(nv.length(), float(1e-12))).mul(nv.dot(mix(vec3(0, 0, -1), pv, persp)).sign().negate()));
      const wp = cw.mul(vec4(pv, 1)).xyz.toVar('seeThroughWorld');
      const wn = cw.mul(vec4(nv, 0)).xyz.toVar('seeThroughWorldNormal');
      boxSteps(
        TSL_OPS,
        {
          world: [wp.x, wp.y, wp.z],
          normal: [wn.x, wn.y, wn.z],
          taken: (j) => taken.bitAnd(int(1 << j)).notEqual(int(0)),
          box: (j) => ({ lo: vec(b[j * 2]!), hi: vec(b[j * 2 + 1]!) }),
        },
        { read: () => out, write: (v) => void out.assign(v) },
      );
      return out;
    }).setLayout({ name: 'seeThroughBoxes', type: 'float', inputs: boxInputs });
    const slotBoxes = (k: number, pv: N, face: N): N =>
      slotBoxesFn(bits.shiftRight(int(BOX_BIT0 + k * SEE_THROUGH_OCCLUDERS)), pv, face, cameraWorldMatrix, perspective, ...Array.from({ length: SEE_THROUGH_OCCLUDERS * 2 }, (_, e) => packed.element(at(boxAt + k * SEE_THROUGH_OCCLUDERS * 2 + e))));
    // Built inside each program's build (a loop and a branch need the build's stack).
    const mask = Fn((builder: { geometry?: { hasAttribute?(name: string): boolean } | null; isFlatShading(): boolean }) => {
      // Kept unless a subject fades it: a draw without a subject's bit never reads the dither.
      const keep = TSL.bool(true).toVar('seeThroughKeep');
      // The face's normal (view space, toward either side): the geometry's own where it has one. three keeps that in
      // a shader variable its lighting reads too, set where it is first used: here, before the branch, or every
      // pixel of a draw outside the branch would be lit with a zero normal.
      const own = builder.geometry?.hasAttribute?.('normal') === true && !builder.isFlatShading();
      const geometryNormal = own ? normalViewGeometry.toVar('seeThroughNormalView') : null;
      If(bits.notEqual(int(0)), () => {
        const p = positionView;
        // Else the cross of the view position's screen derivatives, taken here, in control flow uniform per draw, as
        // derivatives must be. Everything else about the face is worked out only inside the boxes.
        const faceNormal = geometryNormal ?? p.dFdx().cross(p.dFdy()).toVar('seeThroughFace');
        const words = [whole.x, whole.y, whole.z, whole.w];
        fadeSteps(
          TSL_OPS,
          {
            p: [p.x, p.y, p.z],
            rect: vec(rect),
            perspective,
            taken: (k) => bits.bitAnd(int(slotBits(k))).notEqual(int(0)).and(count.greaterThan(int(k))),
            slot: (k) => ({ c: vec(packed.element(at(k * PACK_VEC4S))), s: vec(packed.element(at(k * PACK_VEC4S + 1))), pl: vec(packed.element(at(k * PACK_VEC4S + 2))), body: vec(packed.element(at(k * PACK_VEC4S + 3))) }),
            whole: (k) => bits.bitAnd(int(1 << k)).notEqual(int(0)),
            wholeFade: (k) => words[k]!,
            boxes: (k) => slotBoxes(k, p, faceNormal),
          },
          (fade) => keep.assign(ditherKeep(fade)),
        );
      });
      return keep;
    });
    this.nodes = { mask: mask() };
    return this.nodes.mask;
  }

  private arm(r: ArmedRenderer): void {
    this.disarm();
    installSeeThroughStep();
    r.contextNode.value[CONTEXT_KEY] = this;
    // Its version is part of every draw's program key: each program is built again once, with the mask.
    r.contextNode.needsUpdate = true;
    this.armed = r;
    this.d.requestPrecompile?.();
  }

  private disarm(): void {
    const r = this.armed;
    if (r === null) return;
    this.armed = null;
    if (r.contextNode.value[CONTEXT_KEY] !== this) return;
    delete r.contextNode.value[CONTEXT_KEY];
    r.contextNode.needsUpdate = true;
  }

  /** The view goes (its renderer, if alive, builds without the mask again). */
  dispose(): void {
    this.disarm();
    for (const objects of this.alone.values()) for (const o of objects) this.drawAlone(o, false);
    this.alone.clear();
    this.slots.fill(null);
    this.memberDraws.clear();
    this.live = 0;
  }
}

/** The page flag that turns see-through on or off over the project's setting (`?seethrough=on`: its look and cost, by comparison). */
export const SEE_THROUGH_URL_PARAM = 'seethrough';

/** A page's see-through over the project's (true: on, false: off, null: as the project says). */
export function seeThroughFromUrl(search: string): boolean | null {
  const v = new URLSearchParams(search).get(SEE_THROUGH_URL_PARAM);
  if (v === null) return null;
  return v === 'on' || v === '1' || v === 'true';
}

/** Whether a material's draws can hide a subject: colour written, depth tested, not the shadow pass's. */
function takesPart(m: THREE.Material): boolean {
  return (m as { isShadowPassMaterial?: boolean }).isShadowPassMaterial !== true && m.colorWrite !== false && m.depthTest !== false;
}

let installed = false;

/** Put the mask step on three's node materials (once per page; it adds nothing to a build whose renderer no view armed). */
export function installSeeThroughStep(): void {
  if (installed) return;
  installed = true;
  type Builder = { context: Record<string, unknown> };
  type Step = (this: THREE.NodeMaterial, builder: Builder) => unknown;
  type Draw = { readonly object: THREE.Object3D; readonly camera: THREE.Camera };
  type Observer = { needsRefresh(renderObject: Draw, frame: unknown): number };
  const proto = THREE.NodeMaterial.prototype as unknown as { setupDiffuseColor: Step; setupObserver: (this: THREE.NodeMaterial, builder: Builder) => Observer };
  const diffuse = proto.setupDiffuseColor;
  proto.setupDiffuseColor = function setupDiffuseColorWithSeeThrough(builder) {
    const view = builder.context[CONTEXT_KEY] as SeeThroughView | undefined;
    // Beside the material's own mask (three discards on it next): a pixel goes when either says so.
    if (view !== undefined && takesPart(this)) view.keep().not().discard();
    return diffuse.call(this, builder);
  };
  const observe = proto.setupObserver;
  proto.setupObserver = function setupObserverWithSeeThrough(builder) {
    const observer = observe.call(this, builder);
    const view = builder.context[CONTEXT_KEY] as SeeThroughView | undefined;
    if (view === undefined || !takesPart(this)) return observer;
    // A draw's subject bits change while its object, material and lights stay as they are, and three refreshes such
    // an unchanged draw's own uniforms only when its material has nodes of its own (a classic material three
    // converts has none): such a draw is refreshed in the frames its bits change, not every frame.
    const needs = observer.needsRefresh.bind(observer);
    observer.needsRefresh = (renderObject, frame) => {
      const kind = needs(renderObject, frame);
      if (kind === THREE.RenderObjectRefreshType.FULL) return kind;
      return view.bitsChanged(renderObject, renderObject.object, renderObject.camera) ? THREE.RenderObjectRefreshType.FULL : kind;
    };
    return observer;
  };
}
