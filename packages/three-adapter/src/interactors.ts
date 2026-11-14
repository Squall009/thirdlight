/**
 * The objects that press into the interaction field, gathered each frame
 * into its stamps (`interaction-field.ts`).
 *
 * Every object with an `interactor` component presses, however many there
 * are, and so does each of the view's subjects (the camera's target, or the
 * subjects a script names: see-through's list, whether see-through is on or
 * not) with the defaults when it has no component. An object's stamp is its
 * body's footprint (a controller's capsule, else the bounds of what it
 * draws: `subjectExtent`) grown to its radius, swept from where it stood a
 * frame ago to where it stands now; its strength eases in over its recovery
 * time when it starts pressing, so nothing springs. One that stops pressing
 * leaves the field to stand up again over its recovery time; one that jumped
 * (a teleport) starts again where it lands, leaving no streak.
 *
 * On WebGL 2 (no compute, no field) the view's subjects alone bend the
 * foliage through the analytic push it drew before the field
 * (`subject-bend.ts`); objects that only carry the component do not.
 */
import * as THREE from 'three';
import { interactorOf } from '@thirdlight/project-model';

import { STAMP_FLOATS, type InteractionField, type InteractionStamps } from './interaction-field';
import { subjectExtent, type SeeThroughEntities, type SubjectExtent } from './see-through';
import { SubjectBendView } from './subject-bend';

/** An object that moved further than this in one frame jumped (a teleport): its sweep starts again where it is. */
const JUMP_M = 8;

/** Where the view finds what presses. */
export interface InteractorDeps extends SeeThroughEntities {
  components(id: string): unknown;
  /** The entity the camera follows (pressing with the defaults when no subject is named). */
  cameraTarget(): string | null;
  /** The subjects named for the view (see-through's list: a host's or a script's; null: the camera's target). */
  named(): readonly string[] | null;
  /** Every object with an `interactor` component now. */
  interactors(): Iterable<string>;
  /** The field still changes: a host drawing on demand draws again. */
  onChange?(): void;
}

interface Pressing {
  ease: number;
  x: number;
  z: number;
  /** The frame it was last gathered in. */
  frame: number;
  readonly ext: SubjectExtent;
}

/** The renderer the field runs its pass with. */
type FieldRenderer = Parameters<InteractionField['update']>[0];

const _m = new THREE.Matrix4();

/** One view's pressing objects: gathered, eased and stamped each frame. */
export class InteractorView {
  private readonly pressing = new Map<string, Pressing>();
  private packed = new Float32Array(16 * STAMP_FLOATS);
  private count = 0;
  private longest = 0;
  private frame = 0;
  private at: number | null = null;
  /** WebGL 2's subjects (updated only there). */
  private readonly subjectBend: SubjectBendView;
  /** A GPU measurement hides the field: its pass is not run (foliage reads the field as it last was). */
  gpuHidden = false;

  constructor(
    private readonly d: InteractorDeps,
    private readonly field: InteractionField | null,
  ) {
    this.subjectBend = new SubjectBendView(d, field?.subjects ?? null);
  }

  /** The objects pressing now, with their ease (diagnostics; on WebGL 2 the subjects bent round). */
  objects(): { id: string; ease: number }[] {
    return [...[...this.pressing.entries()].map(([id, p]) => ({ id, ease: p.ease })), ...this.subjectBend.subjects()];
  }

  /** Whether the field's pass runs (WebGPU, something read it). */
  fieldLive(): boolean {
    return this.field?.isLive() === true;
  }

  /** This frame's stamps (after `update`). */
  stamps(): InteractionStamps {
    return { packed: this.packed, count: this.count, longestRecovery: this.longest };
  }

  /** Before the frame's draw (world matrices current): gather the stamps and run the field's pass. */
  update(renderer: FieldRenderer, camera: THREE.Camera, now: number = performance.now()): void {
    const dt = this.at === null ? 0 : Math.min(0.1, Math.max(0, (now - this.at) / 1000));
    this.at = now;
    if (renderer.backend?.isWebGLBackend === true) {
      this.subjectBend.update(camera, now);
      return;
    }
    this.gather(dt);
    if (this.field === null || this.gpuHidden) return;
    const e = camera.matrixWorld.elements;
    if (this.field.update(renderer, this.stamps(), [e[12]!, e[13]!, e[14]!], now / 1000, dt)) this.d.onChange?.();
  }

  /** Every pressing object's stamp into `packed`. */
  gather(dt: number): void {
    this.frame += 1;
    this.count = 0;
    this.longest = 0;
    const target = this.d.cameraTarget();
    const subjects = this.d.named() ?? (target !== null ? [target] : []);
    const seen = new Set<string>();
    for (const id of subjects) this.stamp(id, dt, seen);
    for (const id of this.d.interactors()) this.stamp(id, dt, seen);
    // One that stopped pressing leaves its press to the field; it eases in again if it comes back.
    for (const [id, p] of this.pressing) if (p.frame !== this.frame) this.pressing.delete(id);
  }

  private stamp(id: string, dt: number, seen: Set<string>): void {
    if (seen.has(id) || !this.d.matrix(id, _m)) return;
    seen.add(id);
    const comps = this.d.components(id);
    let p = this.pressing.get(id);
    if (p === undefined) {
      p = { ease: 0, x: NaN, z: NaN, frame: 0, ext: { centre: new THREE.Vector3(), feet: 0, height: 0, radius: 0 } };
      this.pressing.set(id, p);
    }
    p.frame = this.frame;
    subjectExtent(_m, this.d.drawn(id), comps, p.ext);
    const v = interactorOf((comps as { interactor?: unknown } | undefined)?.interactor, p.ext.radius);
    p.ease = v.recovery > 0 ? Math.min(1, p.ease + dt / v.recovery) : 1;
    const x = p.ext.centre.x;
    const z = p.ext.centre.z;
    const jumped = Number.isNaN(p.x) || Math.hypot(x - p.x, z - p.z) > JUMP_M;
    const fromX = jumped ? x : p.x;
    const fromZ = jumped ? z : p.z;
    const vx = jumped || dt <= 0 ? 0 : (x - p.x) / dt;
    const vz = jumped || dt <= 0 ? 0 : (z - p.z) / dt;
    p.x = x;
    p.z = z;
    const strength = v.strength * p.ease;
    if (strength <= 0) return;
    if ((this.count + 1) * STAMP_FLOATS > this.packed.length) {
      const grown = new Float32Array(this.packed.length * 2);
      grown.set(this.packed);
      this.packed = grown;
    }
    const at = this.count * STAMP_FLOATS;
    const rate = v.recovery > 0 ? 1 / v.recovery : 1e4;
    this.packed.set([fromX, fromZ, x, z, p.ext.feet, p.ext.feet + p.ext.height, v.radius, strength, vx, vz, rate, 0], at);
    this.count += 1;
    this.longest = Math.max(this.longest, v.recovery);
  }
}
