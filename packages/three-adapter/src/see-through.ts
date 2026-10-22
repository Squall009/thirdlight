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
 * Per view (render-group uniforms written once per render, for the view's
 * camera only; any other camera — a bake, a thumbnail — sees no subject): a
 * fixed array of subjects (`SEE_THROUGH_SUBJECTS`), each its circle's centre
 * and radii in view space at its depth, the depth a pixel must be nearer
 * than, the plane half its height above its feet, and its fade.
 *
 * Per drawn object (a uniform written per draw, like light layers): the
 * subjects that may fade it, as bits. An object with `seeThrough: false`
 * has none (no program of its own); a subject and everything under it in
 * the entity hierarchy (its model, a held item) drop their own bit, so a
 * subject never fades itself, yet still fades for another subject it stands
 * in front of. A subject is an entity, drawn or not: a controller root whose
 * model is a child entity is sized by its capsule, else by what its
 * descendants draw.
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
import { controllerCapsuleOf, controllerCapsuleOffsetZ, SEE_THROUGH_DEFAULTS, SEE_THROUGH_FIELDS, SEE_THROUGH_SUBJECTS, seeThroughSettingsOf, type SeeThroughSettings } from '@thirdlight/runtime';

import { ditherKeep } from './dither-fade';
import type { N } from './effects-tsl';
import type { RenderGraph } from './render-graph';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, If, float, int, max, min, mix, positionView, renderGroup, smoothstep, uniform, uniformArray } = TSL;

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

/** Where a subject stands: the middle of its body (world), its feet's height and its height. */
export interface SubjectExtent {
  readonly centre: THREE.Vector3;
  feet: number;
  height: number;
}

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
    return;
  }
  _box.getCenter(out.centre);
  out.feet = _box.min.y;
  out.height = _box.max.y - _box.min.y;
}

/** One subject packed for the shader (view space of one camera). */
export interface SubjectPack {
  /** The circle's centre (view space, at the subject's depth) and whether the camera is a perspective one (1) or not (0). */
  readonly centre: THREE.Vector4;
  /** Inner and outer radius (metres at the subject's depth), the view z a pixel must be above to be in front, the fade. */
  readonly shape: THREE.Vector4;
  /** World up in view space and the offset that makes `dot(plane.xyz, p) + plane.w` a pixel's height over half the subject's height. */
  readonly plane: THREE.Vector4;
}

export function emptyPack(): SubjectPack {
  return { centre: new THREE.Vector4(), shape: new THREE.Vector4(), plane: new THREE.Vector4() };
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
  out.shape.set(inner, outer, _v.z + s.depthMargin, f);
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
  /** `a·(1−t) + b·t`. */
  mix(a: F, b: F, t: F): F;
  smoothstep(e0: F, e1: F, x: F): F;
  sqrt(a: F): F;
  ge(a: F, b: F): B;
  le(a: F, b: F): B;
  lt(a: F, b: F): B;
  and(a: B, b: B): B;
  /** A value worked out once (a shader variable). */
  once(a: F): F;
  /** Run `body` only where `c` holds (a branch in the shader). */
  when(c: B, body: () => void): void;
  variable(init: F): { read(): F; write(v: F): void };
}

type Four<F> = readonly [F, F, F, F];

/** What the steps read: the pixel's view position, the box round the circles, and each slot. */
interface FadeInputs<F, B> {
  readonly p: readonly [F, F, F];
  /** The box (`circleRect`) and whether the view is perspective (1) or not (0). */
  readonly rect: Four<F>;
  readonly perspective: F;
  /** Whether the draw takes slot `k`'s subject and the slot is in use. */
  taken(k: number): B;
  /** Slot `k`'s pack: centre, shape, plane. */
  slot(k: number): { readonly c: Four<F>; readonly s: Four<F>; readonly pl: Four<F> };
}

/**
 * The fade of a pixel (the largest over the slots the draw takes of circle ×
 * in front × above half height × the subject's fade), handed to `done` for
 * a pixel inside the box round the circles; a pixel outside it (most of the
 * view) is left after four comparisons. The slots are unrolled with
 * constant indices (a dynamic index into the array cost three times as much
 * on an Iris Xe), and a slot's circle is worked out only for pixels in front
 * of its subject, above half its height and inside its outer radius.
 */
function fadeSteps<F, B>(o: FadeOps<F, B>, i: FadeInputs<F, B>, done: (fade: F) => void): void {
  const [px, py, pz] = i.p;
  const [rx0, ry0, rx1, ry1] = i.rect;
  const fade = o.variable(o.num(0));
  const invZ = o.once(o.div(o.num(1), o.min(pz, o.num(NEAR_Z))));
  const k = o.mix(o.num(1), o.neg(invZ), i.perspective);
  const ax = o.mul(px, k);
  const ay = o.mul(py, k);
  o.when(o.and(o.and(o.ge(ax, rx0), o.ge(ay, ry0)), o.and(o.le(ax, rx1), o.le(ay, ry1))), () => {
    for (let n = 0; n < SEE_THROUGH_SUBJECTS; n++) {
      o.when(i.taken(n), () => {
        const { c, s, pl } = i.slot(n);
        const height = o.add(o.add(o.add(o.mul(pl[0], px), o.mul(pl[1], py)), o.mul(pl[2], pz)), pl[3]);
        o.when(o.and(o.ge(pz, s[2]), o.ge(height, o.num(0))), () => {
          const m = o.mix(o.num(1), o.mul(c[2], invZ), c[3]);
          const qx = o.sub(o.mul(px, m), c[0]);
          const qy = o.sub(o.mul(py, m), c[1]);
          const d2 = o.add(o.mul(qx, qx), o.mul(qy, qy));
          o.when(o.lt(d2, o.mul(s[1], s[1])), () => {
            fade.write(o.max(fade.read(), o.mul(s[3], o.sub(o.num(1), o.smoothstep(s[0], s[1], o.sqrt(d2))))));
          });
        });
      });
    }
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
  mix: (a, b, t) => a * (1 - t) + b * t,
  smoothstep: (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  },
  sqrt: Math.sqrt,
  ge: (a, b) => a >= b,
  le: (a, b) => a <= b,
  lt: (a, b) => a < b,
  and: (a, b) => a && b,
  once: (a) => a,
  when: (c, body) => {
    if (c) body();
  },
  variable: (init) => {
    let v = init;
    return { read: () => v, write: (x) => void (v = x) };
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
  mix: (a, b, t) => mix(a, b, t),
  smoothstep: (e0, e1, x) => smoothstep(e0, e1, x),
  sqrt: (a) => a.sqrt(),
  ge: (a, b) => a.greaterThanEqual(b),
  le: (a, b) => a.lessThanEqual(b),
  lt: (a, b) => a.lessThan(b),
  and: (a, b) => a.and(b),
  once: (a) => a.toVar(),
  when: (c, body) => void If(c, body),
  variable: (init) => {
    const v = init.toVar('seeThroughFade');
    return { read: () => v, write: (x) => void v.assign(x) };
  },
};

const _rect = new THREE.Vector4();
const four = (v: THREE.Vector4): Four<number> => [v.x, v.y, v.z, v.w];

/**
 * The fade of a pixel at view position `p`: the shader's own steps
 * ({@link fadeSteps}) run on numbers, for the first `count` subjects whose
 * bit `bits` has.
 */
export function seeThroughFadeAt(p: readonly [number, number, number], packs: readonly SubjectPack[], count: number, bits: number): number {
  if (bits === 0) return 0;
  const perspective = circleRect(packs, count, _rect) ? 1 : 0;
  let out = 0;
  fadeSteps(CPU_OPS, { p, rect: four(_rect), perspective, taken: (k) => ((bits >> k) & 1) === 1 && k < count, slot: (k) => ({ c: four(packs[k]!.centre), s: four(packs[k]!.shape), pl: four(packs[k]!.plane) }) }, (f) => (out = f));
  return out;
}

/** Metres a draw's bounds are grown by for the test (a wind or a vertex offset past them). */
const BOUNDS_MARGIN = 0.5;
const _sphere = new THREE.Sphere();

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
 * Whether any point of a sphere (centre in view space, radius) may be faded by one subject: some of it in
 * front of the subject's depth limit, above its half-height plane and, projected to the subject's depth, inside
 * its outer circle. Conservative: a sphere reaching the camera plane always may.
 */
export function mayFade(c: THREE.Vector3, r: number, p: SubjectPack): boolean {
  const { centre, shape, plane } = p;
  if (shape.w <= 0) return false;
  if (c.z + r < shape.z) return false;
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
  /** The subjects in its slots and how far each has faded in (0 … 1, before the max fade). */
  readonly subjects: readonly { readonly id: string; readonly slot: number; readonly fade: number }[];
  /** Subjects asked for past the array size, last frame (the farthest left out). */
  readonly leftOut: number;
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
}

interface Slot {
  id: string;
  /** 0 … 1 eased in (times the max fade on the GPU). */
  fade: number;
  /** Whether it was asked for this frame. */
  wanted: boolean;
  readonly ext: SubjectExtent;
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
  /** The box round the circles (`circleRect`) and whether the view is perspective (1) or not (0). */
  private readonly rect = new THREE.Vector4();
  private perspective = 1;
  private armed: ArmedRenderer | null = null;
  private readonly ahead: boolean;
  private camera: THREE.Camera | null = null;
  private frame = 0;
  /** The frame the packs were last filled for. */
  private filled = -1;
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
  /** The bits each draw (render object) was last refreshed with. */
  private readonly uploaded = new WeakMap<object, number>();

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
    const subjects: { id: string; slot: number; fade: number }[] = [];
    this.slots.forEach((sl, i) => {
      if (sl !== null) subjects.push({ id: sl.id, slot: i, fade: sl.fade });
    });
    return { enabled: this.s.enabled, armed: this.armed !== null, subjects, leftOut: this.leftOut };
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
    if (!this.s.enabled && this.armed === null && !ahead) return;
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
      return;
    }
    this.frame += 1;
    // A host that groups no batches (or a frame before its first) chooses the slots here.
    if (!followed) this.follow(camera);
    const step = this.s.fadeTime > 0 ? dt / this.s.fadeTime : 1;
    let easing = false;
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
    }
    if (easing) this.d.onChange?.();
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
        sl = { id: f.id, fade: 0, wanted: false, ext: { centre: new THREE.Vector3(), feet: 0, height: 0 } };
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
   * The subjects that may fade `object` in this frame's draw: not its own, and (a draw with bounds three culls
   * by) only those whose circle its bounds reach in front of them and above half their height. A draw left
   * with none skips the mask, so a draw pays only for the circles near it.
   */
  bitsFor(object: THREE.Object3D, camera?: THREE.Camera): number {
    if (this.live === 0 || !objectSeeThrough(object)) return 0;
    const m = this.self.get(object);
    let bits = m !== undefined && m.frame === this.frame ? this.live & ~m.bits : this.live;
    if (bits === 0 || camera === undefined || camera !== this.camera) return bits;
    const sphere = drawBounds(object);
    if (sphere === null) return bits;
    this.ensureFilled(camera);
    _sphere.copy(sphere).applyMatrix4(object.matrixWorld);
    _v.copy(_sphere.center).applyMatrix4(camera.matrixWorldInverse);
    const r = _sphere.radius + BOUNDS_MARGIN;
    for (let i = 0; i < this.count; i++) if ((bits >> i) & 1 && !mayFade(_v, r, this.packs[i]!)) bits &= ~(1 << i);
    return bits;
  }

  /** Whether the bits `bitsFor` gives a draw (one render object: an object for a camera) differ from those it last uploaded. */
  bitsChanged(draw: object, object: THREE.Object3D, camera: THREE.Camera): boolean {
    const bits = this.bitsFor(object, camera);
    if (this.uploaded.get(draw) === bits) return false;
    this.uploaded.set(draw, bits);
    return true;
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
    return this.count;
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
    // One array (each subject's centre, shape and plane in turn): one uniform buffer bound per draw, not three.
    const packed = uniformArray(this.packs.flatMap((p) => [p.centre, p.shape, p.plane]), 'vec4')
      .setGroup(renderGroup)
      .onRenderUpdate((f: { camera: THREE.Camera }) => void filled(f));
    const count = uniform(0, 'int').setGroup(renderGroup).onRenderUpdate(filled);
    const rect = uniform(this.rect, 'vec4')
      .setGroup(renderGroup)
      .onRenderUpdate((f: { camera: THREE.Camera }) => (filled(f), this.rect));
    const perspective = uniform(0)
      .setGroup(renderGroup)
      .onRenderUpdate((f: { camera: THREE.Camera }) => (filled(f), this.perspective));
    const bits = uniform(0, 'int').onObjectUpdate(({ object, camera }: { object: THREE.Object3D; camera: THREE.Camera }) => this.bitsFor(object, camera));
    const vec = (v: N): Four<N> => [v.x, v.y, v.z, v.w];
    // Built inside each program's build (a loop and a branch need the build's stack).
    const mask = Fn(() => {
      // Kept unless a subject fades it: a draw without a subject's bit never reads the dither.
      const keep = TSL.bool(true).toVar('seeThroughKeep');
      If(bits.notEqual(int(0)), () => {
        const p = positionView;
        fadeSteps(
          TSL_OPS,
          {
            p: [p.x, p.y, p.z],
            rect: vec(rect),
            perspective,
            taken: (k) => bits.bitAnd(int(1 << k)).notEqual(int(0)).and(count.greaterThan(int(k))),
            slot: (k) => ({ c: vec(packed.element(int(k * 3))), s: vec(packed.element(int(k * 3 + 1))), pl: vec(packed.element(int(k * 3 + 2))) }),
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
