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
 * has none (no program of its own); a subject and everything under it drop
 * their own bit, so a subject never fades itself, yet still fades for
 * another subject it stands in front of.
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
import { controllerCapsuleOf, SEE_THROUGH_DEFAULTS, SEE_THROUGH_SUBJECTS, seeThroughSettingsOf, type SeeThroughSettings } from '@thirdlight/runtime';

import { ditherKeep } from './dither-fade';
import type { N } from './effects-tsl';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, If, float, int, max, min, mix, positionView, renderGroup, smoothstep, uniform, uniformArray } = TSL;

/** `object.userData[SEE_THROUGH_KEY] === false`: the drawable never fades (absent: it takes part). */
export const SEE_THROUGH_KEY = '__tlSeeThrough';
/** `object.userData[SELF_KEY]`: the subjects it belongs to this frame (it never fades for them). */
const SELF_KEY = '__tlSeeThroughSelf';
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
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * A subject's extent: a character's controller capsule (its height, its
 * feet at the capsule's bottom), else the bounds of the meshes under it,
 * else its origin with no height. False: nothing to measure (no object).
 */
export function subjectExtent(object: THREE.Object3D, components: unknown, out: SubjectExtent): boolean {
  const controller = (components as { controller?: unknown } | undefined)?.controller;
  if (controller !== undefined) {
    const cap = controllerCapsuleOf(controller);
    object.matrixWorld.decompose(_v, _q, _s);
    const h = cap.height * Math.abs(_s.y);
    object.localToWorld(out.centre.set(cap.offset[0], cap.offset[1], 0));
    out.feet = out.centre.y - h / 2;
    out.height = h;
    return true;
  }
  _box.makeEmpty();
  object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh === true && o.visible) _box.expandByObject(o, false);
  });
  if (_box.isEmpty()) {
    object.getWorldPosition(out.centre);
    out.feet = out.centre.y;
    out.height = 0;
    return true;
  }
  _box.getCenter(out.centre);
  out.feet = _box.min.y;
  out.height = _box.max.y - _box.min.y;
  return true;
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

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The fade of a pixel at view position `p` (the CPU reference of the shader:
 * the same terms; the shader skips the circle where a term is already 0): the largest over the first `count`
 * subjects whose bit `bits` has of circle × in front × above half height ×
 * the subject's fade.
 */
export function seeThroughFadeAt(p: readonly [number, number, number], packs: readonly SubjectPack[], count: number, bits: number): number {
  let fade = 0;
  if (bits === 0) return 0;
  for (let i = 0; i < count; i++) {
    const { centre: c, shape: s, plane: pl } = packs[i]!;
    const on = (bits >> i) & 1;
    const z = Math.min(p[2], NEAR_Z);
    const k = 1 + (c.z / z - 1) * c.w;
    const dx = p[0] * k - c.x;
    const dy = p[1] * k - c.y;
    const circle = 1 - smooth(s.x, s.y, Math.hypot(dx, dy));
    const front = p[2] >= s.z ? 1 : 0;
    const above = pl.x * p[0] + pl.y * p[1] + pl.z * p[2] + pl.w >= 0 ? 1 : 0;
    fade = Math.max(fade, s.w * circle * front * above * on);
  }
  return fade;
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

/** What a host changes: the settings, and the subjects (entity ids; null: the camera's target). */
export interface SeeThroughPatch extends Partial<SeeThroughSettings> {
  readonly subjects?: readonly string[] | null;
}

/** What the game's scripts set, as the runtime's view carries it (`ctx.camera.setSeeThrough`): whole settings and the subjects. */
export interface SeeThroughScripted {
  readonly settings: Readonly<SeeThroughSettings>;
  readonly subjects: readonly string[] | null;
}

const SETTING_FIELDS = ['enabled', 'radius', 'softness', 'maxFade', 'depthMargin', 'fadeTime'] as const;

/** Whether two scripted states say the same (the worker's view arrives as a new object every step). */
function sameScripted(a: SeeThroughScripted | null, b: SeeThroughScripted | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (SETTING_FIELDS.some((k) => a.settings[k] !== b.settings[k])) return false;
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

export interface SeeThroughDeps {
  /** An entity's drawn object (undefined: none drawn). */
  object(id: string): THREE.Object3D | undefined;
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
  /** Measured this frame (else it keeps its last place while it fades out). */
  measured: boolean;
  readonly ext: SubjectExtent;
}

interface ArmedRenderer {
  contextNode: { value: Record<string, unknown>; needsUpdate: boolean };
}

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
  private camera: THREE.Camera | null = null;
  private frame = 0;
  /** The frame the packs were last filled for. */
  private filled = -1;
  /** Bits of the slots with a fade this frame. */
  private live = 0;
  private count = 0;
  private leftOut = 0;
  private reported = false;
  private at: number | null = null;
  private nodes: { mask: N } | null = null;
  /** The subjects' objects whose meshes are marked to draw on their own. */
  private readonly alone = new Map<string, THREE.Object3D>();

  constructor(
    private readonly d: SeeThroughDeps,
    settings?: Partial<SeeThroughSettings>,
  ) {
    this.base = seeThroughSettingsOf(settings ?? {}, SEE_THROUGH_DEFAULTS);
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
   * Before the frame's batches are grouped: the objects of the subjects asked
   * for (and those still fading out) draw on their own, the others go back.
   * Every mesh is checked, so one loaded under a subject later follows.
   */
  beforeBatch(): void {
    this.followScript();
    const want = new Set<string>();
    if (this.s.enabled) {
      const target = this.d.cameraTarget();
      for (const id of this.named ?? (target !== null ? [target] : [])) want.add(id);
    }
    for (const sl of this.slots) if (sl !== null) want.add(sl.id);
    for (const [id, node] of this.alone) {
      if (want.has(id) && this.d.object(id) === node) continue;
      this.drawAlone(node, false);
      this.alone.delete(id);
    }
    for (const id of want) {
      const node = this.d.object(id);
      if (node === undefined) continue;
      this.drawAlone(node, true);
      this.alone.set(id, node);
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
   * see-through is on, follow the subjects and ease their fades. Off and
   * never on: nothing at all.
   */
  update(renderer: unknown, camera: THREE.Camera, now: number = performance.now()): void {
    const r = renderer as Partial<ArmedRenderer>;
    this.followScript();
    const ahead = this.d.prebuild === true && this.d.pinned !== false;
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
    this.follow();
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
      // The subject and everything under it never fade for it.
      const o = this.d.object(sl.id);
      if (o !== undefined) this.markSelf(o, i);
    }
    if (easing) this.d.onChange?.();
  }

  /** The subjects asked for this frame into slots (the nearest kept when there are more than slots). */
  private follow(): void {
    for (const sl of this.slots) if (sl !== null) sl.wanted = sl.measured = false;
    const target = this.d.cameraTarget();
    const ids = this.named ?? (target !== null ? [target] : []);
    const found: { id: string; ext: SubjectExtent; dist: number }[] = [];
    const eye = this.camera!.getWorldPosition(new THREE.Vector3());
    for (const id of new Set(ids)) {
      const o = this.d.object(id);
      if (o === undefined) continue;
      const ext: SubjectExtent = { centre: new THREE.Vector3(), feet: 0, height: 0 };
      if (!subjectExtent(o, this.d.components(id), ext)) continue;
      found.push({ id, ext, dist: ext.centre.distanceToSquared(eye) });
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
        sl = { id: f.id, fade: 0, wanted: false, measured: false, ext: { centre: new THREE.Vector3(), feet: 0, height: 0 } };
        this.slots[at] = sl;
      }
      sl.wanted = true;
      sl.measured = true;
      sl.ext.centre.copy(f.ext.centre);
      sl.ext.feet = f.ext.feet;
      sl.ext.height = f.ext.height;
    }
  }

  private markSelf(root: THREE.Object3D, slot: number): void {
    const frame = this.frame;
    root.traverse((o) => {
      const m = o.userData[SELF_KEY] as { view: SeeThroughView; frame: number; bits: number } | undefined;
      if (m !== undefined && m.view === this && m.frame === frame) m.bits |= 1 << slot;
      else o.userData[SELF_KEY] = { view: this, frame, bits: 1 << slot };
    });
  }

  /**
   * The subjects that may fade `object` in this frame's draw: not its own, and (a draw with bounds three culls
   * by) only those whose circle its bounds reach in front of them and above half their height. A draw left
   * with none skips the mask, so a draw pays only for the circles near it.
   */
  bitsFor(object: THREE.Object3D, camera?: THREE.Camera): number {
    if (this.live === 0 || !objectSeeThrough(object)) return 0;
    const m = object.userData[SELF_KEY] as { view: SeeThroughView; frame: number; bits: number } | undefined;
    let bits = m !== undefined && m.view === this && m.frame === this.frame ? this.live & ~m.bits : this.live;
    if (bits === 0 || camera === undefined || camera !== this.camera) return bits;
    const sphere = drawBounds(object);
    if (sphere === null) return bits;
    if (this.filled !== this.frame) this.fill(camera);
    _sphere.copy(sphere).applyMatrix4(object.matrixWorld);
    _v.copy(_sphere.center).applyMatrix4(camera.matrixWorldInverse);
    const r = _sphere.radius + BOUNDS_MARGIN;
    for (let i = 0; i < this.count; i++) if ((bits >> i) & 1 && !mayFade(_v, r, this.packs[i]!)) bits &= ~(1 << i);
    return bits;
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
    // One array (each subject's centre, shape and plane in turn): one uniform buffer bound per draw, not three.
    const packed = uniformArray(this.packs.flatMap((p) => [p.centre, p.shape, p.plane]), 'vec4').setGroup(renderGroup);
    // Written first each render: the arrays beside it are filled here, before the group uploads.
    const count = uniform(0, 'int')
      .setGroup(renderGroup)
      .onRenderUpdate(({ camera }: { camera: THREE.Camera }) => this.fill(camera));
    // Filled with the packs (the count's update runs first in the group).
    const rect = uniform(this.rect, 'vec4').setGroup(renderGroup);
    const perspective = uniform(0).setGroup(renderGroup).onRenderUpdate(() => this.perspective);
    const bits = uniform(0, 'int').onObjectUpdate(({ object, camera }: { object: THREE.Object3D; camera: THREE.Camera }) => this.bitsFor(object, camera));
    // Built inside each program's build (a loop and a branch need the build's stack).
    const mask = Fn(() => {
      const fade = float(0).toVar('seeThroughFade');
      // Kept unless a subject fades it: a draw without a subject's bit never reads the dither.
      const keep = TSL.bool(true).toVar('seeThroughKeep');
      If(bits.notEqual(int(0)), () => {
        const p = positionView;
        const invZ = float(1).div(min(p.z, float(NEAR_Z))).toVar();
        // A pixel outside the box round every circle (most of the view) is done after four comparisons.
        const at = p.xy.mul(mix(float(1), invZ.negate(), perspective));
        If(at.x.greaterThanEqual(rect.x).and(at.y.greaterThanEqual(rect.y)).and(at.x.lessThanEqual(rect.z)).and(at.y.lessThanEqual(rect.w)), () => {
          // Unrolled over the fixed slots with constant indices (a dynamic index into the array cost three times as
          // much on an Iris Xe), each skipped unless the draw takes its subject, and its circle worked out only for
          // pixels in front of the subject and above half its height, and inside its outer radius.
          for (let k = 0; k < SEE_THROUGH_SUBJECTS; k++) {
            If(bits.bitAnd(int(1 << k)).notEqual(int(0)).and(count.greaterThan(int(k))), () => {
              const s = packed.element(int(k * 3 + 1));
              const pl = packed.element(int(k * 3 + 2));
              If(p.z.greaterThanEqual(s.z).and(pl.xyz.dot(p).add(pl.w).greaterThanEqual(float(0))), () => {
                const c = packed.element(int(k * 3));
                const q = p.xy.mul(mix(float(1), c.z.mul(invZ), c.w)).sub(c.xy);
                const d2 = q.dot(q);
                If(d2.lessThan(s.y.mul(s.y)), () => {
                  fade.assign(max(fade, s.w.mul(float(1).sub(smoothstep(s.x, s.y, d2.sqrt())))));
                });
              });
            });
          }
          keep.assign(ditherKeep(fade));
        });
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
    for (const node of this.alone.values()) this.drawAlone(node, false);
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
  type Step = (this: THREE.NodeMaterial, builder: { context: Record<string, unknown> }) => unknown;
  const proto = THREE.NodeMaterial.prototype as unknown as { setupDiffuseColor: Step };
  const diffuse = proto.setupDiffuseColor;
  proto.setupDiffuseColor = function setupDiffuseColorWithSeeThrough(builder) {
    const view = builder.context[CONTEXT_KEY] as SeeThroughView | undefined;
    // Beside the material's own mask (three discards on it next): a pixel goes when either says so.
    if (view !== undefined && takesPart(this)) view.keep().not().discard();
    return diffuse.call(this, builder);
  };
}
