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
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { controllerCapsuleOf, SEE_THROUGH_DEFAULTS, SEE_THROUGH_SUBJECTS, seeThroughSettingsOf, type SeeThroughSettings } from '@thirdlight/runtime';

import { ditherKeep } from './dither-fade';
import type { N } from './effects-tsl';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, If, Loop, float, int, max, min, mix, positionView, renderGroup, smoothstep, step, uniform, uniformArray } = TSL;

/** `object.userData[SEE_THROUGH_KEY] === false`: the drawable never fades (absent: it takes part). */
export const SEE_THROUGH_KEY = '__tlSeeThrough';
/** `object.userData[SELF_KEY]`: the subjects it belongs to this frame (it never fades for them). */
const SELF_KEY = '__tlSeeThroughSelf';
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
 * the same steps, the same order): the largest over the first `count`
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
  /** Programs will be built again (the renderer armed): build them ahead of the next present. */
  requestPrecompile?(): void;
  /** A fade still eases: a host drawing on demand draws again. */
  onChange?(): void;
  /** More subjects than the arrays hold (once until it fits again). */
  onProblem?(code: string, message: string): void;
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
  private armed: ArmedRenderer | null = null;
  private camera: THREE.Camera | null = null;
  private frame = 0;
  /** Bits of the slots with a fade this frame. */
  private live = 0;
  private count = 0;
  private leftOut = 0;
  private reported = false;
  private at: number | null = null;
  private nodes: { mask: N } | null = null;

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
   * Before the frame's draw (world matrices current): arm the renderer once
   * see-through is on, follow the subjects and ease their fades. Off and
   * never on: nothing at all.
   */
  update(renderer: unknown, camera: THREE.Camera, now: number = performance.now()): void {
    const r = renderer as Partial<ArmedRenderer>;
    this.followScript();
    if (!this.s.enabled && this.armed === null) return;
    if (this.s.enabled && this.armed !== r && r.contextNode !== undefined) this.arm(r as ArmedRenderer);
    this.camera = camera;
    const dt = this.at === null ? 0 : Math.min(0.1, Math.max(0, (now - this.at) / 1000));
    this.at = now;
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

  /** The subjects that may fade `object` in this frame's draw. */
  bitsFor(object: THREE.Object3D): number {
    if (this.live === 0 || !objectSeeThrough(object)) return 0;
    const m = object.userData[SELF_KEY] as { view: SeeThroughView; frame: number; bits: number } | undefined;
    return m !== undefined && m.view === this && m.frame === this.frame ? this.live & ~m.bits : this.live;
  }

  /** Fill the packs for the render's camera; the number of slots in use (0 for any camera but the view's). */
  fill(camera: THREE.Camera): number {
    if (camera !== this.camera || this.live === 0) return 0;
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
    return this.count;
  }

  /** The packs as filled last (tests read them against the CPU reference). */
  packed(): readonly SubjectPack[] {
    return this.packs;
  }

  /** The keep test this view's programs AND into their mask (made once per view). */
  keep(): N {
    if (this.nodes !== null) return this.nodes.mask;
    const centres = uniformArray(this.packs.map((p) => p.centre), 'vec4').setGroup(renderGroup);
    const shapes = uniformArray(this.packs.map((p) => p.shape), 'vec4').setGroup(renderGroup);
    const planes = uniformArray(this.packs.map((p) => p.plane), 'vec4').setGroup(renderGroup);
    // Written first each render: the arrays beside it are filled here, before the group uploads.
    const count = uniform(0, 'int')
      .setGroup(renderGroup)
      .onRenderUpdate(({ camera }: { camera: THREE.Camera }) => this.fill(camera));
    const bits = uniform(0, 'int').onObjectUpdate(({ object }: { object: THREE.Object3D }) => this.bitsFor(object));
    // Built inside each program's build (a loop and a branch need the build's stack).
    const mask = Fn(() => {
      const fade = float(0).toVar('seeThroughFade');
      If(bits.notEqual(int(0)), () => {
        Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
          const c = centres.element(i);
          const s = shapes.element(i);
          const pl = planes.element(i);
          const on = float(bits.shiftRight(i).bitAnd(int(1)));
          const z = min(positionView.z, float(NEAR_Z));
          const q = positionView.xy.mul(mix(float(1), c.z.div(z), c.w));
          const circle = float(1).sub(smoothstep(s.x, s.y, q.sub(c.xy).length()));
          const front = step(s.z, positionView.z);
          const above = step(float(0), pl.xyz.dot(positionView).add(pl.w));
          fade.assign(max(fade, s.w.mul(circle).mul(front).mul(above).mul(on)));
        });
      });
      return ditherKeep(fade);
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
