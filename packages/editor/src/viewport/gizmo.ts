/**
 * Transform gizmo (packet 10) — imperative three.js, framework-free.
 *
 * A minimal, practical translate/rotate/scale gizmo. A drag PREVIEWs locally
 * (the target Object3D's transform is updated live — no network traffic) and
 * the gesture COMMITs as one command on release (the caller issues the single
 * `setTransform`). The gizmo reports the current transform on every frame
 * (for the projection's local preview + the inspector readout) and the final
 * transform on end.
 *
 * The screen-space drag model (framework-free, no per-frame traffic):
 *  - translate: pointer delta mapped to a camera-aligned screen plane
 *    (dx → camera right, dy → camera up);
 *  - rotate: horizontal delta → accumulated yaw about +Y, vertical delta →
 *    accumulated pitch about +X (each snapped to 15° and the composed
 *    quaternion re-normalized — sessions.md §9); the helper shows both axes;
 *  - scale: horizontal delta → uniform multiplicative scale.
 */

import * as THREE from 'three';
import { snapScaleFactor, snapTranslateDelta, snapRotationAngle } from '../session/snapping';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface GizmoTransform {
  position: number[];
  rotation: number[];
  scale: number[];
}

export interface GizmoCallbacks {
  onFrame: (t: GizmoTransform) => void;
  onEnd: (t: GizmoTransform) => void;
}

/** The local snapping option (sessions.md §9): a gesture option, never persisted. */
export interface GizmoOptions {
  /** Whether snapping is active for the CURRENT gesture (Shift disables it). */
  snapping?: () => boolean;
}

const AXIS_COLORS = { x: 0xff5252, y: 0x52d273, z: 0x5299ff } as const;

/** Safe numeric component read (transforms are always 3/4-element). */
const N = (v: number | undefined): number => v ?? 0;

/**
 * One gizmo, attached to a target Object3D. `attach` captures the target's
 * current transform as the gesture base; `pointerDown/Move/Up` drive the
 * local preview; the transform is always reported in world space (canonical
 * position / quaternion / scale).
 */
export class Gizmo {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly cb: GizmoCallbacks;
  private target: THREE.Object3D | null = null;
  private mode: GizmoMode = 'translate';
  private active = false;
  private base: GizmoTransform | null = null;
  /** Accumulated gesture delta since pointer down (per-gesture, snap-stable). */
  private accumDx = 0;
  private accumDy = 0;
  /** Visual gizmo helpers (rebuilt per attach). */
  private helpers: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, _renderer: THREE.WebGLRenderer, cb: GizmoCallbacks, options: GizmoOptions = {}) {
    this.scene = scene;
    this.camera = camera;
    this.cb = cb;
    this.snapping = options.snapping ?? (() => false);
  }

  private readonly snapping: () => boolean;

  /** Whether snapping applies to the current preview (local option only). */
  private snapActive(): boolean {
    return this.snapping();
  }

  get targetId(): string | null {
    return (this.target as { entityId?: string } | null)?.entityId ?? null;
  }

  /** Attach to a target at `mode`; captures the base transform. */
  attach(target: THREE.Object3D, mode: GizmoMode): void {
    this.target = target;
    this.mode = mode;
    this.base = this.readTransform();
    this.buildHelpers();
  }

  detach(): void {
    this.target = null;
    this.active = false;
    this.base = null;
    this.clearHelpers();
  }

  setMode(mode: GizmoMode): void {
    if (!this.target) return;
    this.mode = mode;
    this.base = this.readTransform();
    this.clearHelpers();
    this.buildHelpers();
  }

  private readTransform(): GizmoTransform {
    const t = this.target as THREE.Object3D;
    return {
      position: [t.position.x, t.position.y, t.position.z],
      rotation: [t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w],
      scale: [t.scale.x, t.scale.y, t.scale.z],
    };
  }

  private writeTransform(t: GizmoTransform): void {
    const o = this.target as THREE.Object3D;
    o.position.set(N(t.position[0]), N(t.position[1]), N(t.position[2]));
    o.quaternion.set(N(t.rotation[0]), N(t.rotation[1]), N(t.rotation[2]), N(t.rotation[3]));
    o.scale.set(N(t.scale[0]), N(t.scale[1]), N(t.scale[2]));
  }

  /** Begin a gesture (pointer down on the gizmo). Returns true if consumed. */
  pointerDown(_e: PointerEvent): boolean {
    if (!this.target || !this.base) return false;
    this.active = true;
    this.accumDx = 0;
    this.accumDy = 0;
    return true;
  }

  /** Advance the local preview (pointer delta). No commit. */
  pointerMove(dx: number, dy: number): void {
    if (!this.active || !this.target || !this.base) return;
    // The gesture ACCUMULATES its delta from pointer-down (so a drag is a drag,
    // and snapping the accumulated delta cannot drift — sessions.md §9).
    this.accumDx += dx;
    this.accumDy += dy;
    const t = this.step(this.base, this.accumDx, this.accumDy);
    this.writeTransform(t);
    this.cb.onFrame(t);
  }

  /** End the gesture (pointer up). Reports the final transform once. */
  pointerUp(): void {
    if (!this.active || !this.target) return;
    this.active = false;
    this.cb.onEnd(this.readTransform());
  }

  /**
   * Cancel the gesture (Esc / cancel control): revert the target to the base
   * transform captured at pointer-down and report nothing. No command is
   * issued, no revision moves, nothing is observable to another client
   * (sessions.md §9).
   */
  cancel(): boolean {
    if (!this.active || !this.target || !this.base) return false;
    this.active = false;
    this.accumDx = 0;
    this.accumDy = 0;
    this.writeTransform(this.base);
    return true;
  }

  private step(base: GizmoTransform, dx: number, dy: number): GizmoTransform {
    const pos = [...base.position];
    const quat = new THREE.Quaternion(base.rotation[0], base.rotation[1], base.rotation[2], base.rotation[3]);
    const scl = [...base.scale];
    const SENS = 0.01; // pixels → world units
    const snap = this.snapActive();
    if (this.mode === 'translate') {
      // Camera-aligned screen plane: dx → right, dy → up.
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const delta = new THREE.Vector3().addScaledVector(right, dx * SENS).addScaledVector(up, -dy * SENS);
      // Snapping is applied to the accumulated WORLD-AXIS delta (never the
      // absolute position), so repeated moves cannot accumulate drift.
      const snapped = snap ? snapTranslateDelta([delta.x, delta.y, delta.z]) : [delta.x, delta.y, delta.z];
      pos[0] = N(pos[0]) + (snapped[0] ?? 0);
      pos[1] = N(pos[1]) + (snapped[1] ?? 0);
      pos[2] = N(pos[2]) + (snapped[2] ?? 0);
    } else if (this.mode === 'rotate') {
      const yaw = dx * SENS * 0.5;
      const pitch = -dy * SENS * 0.5;
      const snappedYaw = snap ? snapRotationAngle(yaw, [0, 1, 0]).angleRad : yaw;
      const snappedPitch = snap ? snapRotationAngle(pitch, [1, 0, 0]).angleRad : pitch;
      const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), snappedYaw);
      const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), snappedPitch);
      const nq = new THREE.Quaternion().multiply(qy).multiply(qx).multiply(quat);
      nq.normalize();
      return {
        position: pos,
        rotation: [nq.x, nq.y, nq.z, nq.w],
        scale: scl,
      };
    } else {
      // scale: horizontal delta → uniform multiplicative factor (snapped on the
      // uniform factor and clamped to the accepted scale range).
      const rawFactor = Math.max(0.05, 1 + dx * SENS * 0.5);
      const f = snap ? snapScaleFactor(rawFactor) : rawFactor;
      scl[0] = N(base.scale[0]) * f;
      scl[1] = N(base.scale[1]) * f;
      scl[2] = N(base.scale[2]) * f;
    }
    return { position: pos, rotation: [quat.x, quat.y, quat.z, quat.w], scale: scl };
  }

  /** Build the visual gizmo helpers for the current mode. */
  private buildHelpers(): void {
    this.clearHelpers();
    if (!this.target) return;
    const group = new THREE.Group();
    const p = this.base?.position ?? [0, 0, 0];
    group.position.set(N(p[0]), N(p[1]), N(p[2]));
    if (this.mode === 'translate') {
      const axes: Array<[THREE.Vector3, number]> = [
        [new THREE.Vector3(1, 0, 0), AXIS_COLORS.x],
        [new THREE.Vector3(0, 1, 0), AXIS_COLORS.y],
        [new THREE.Vector3(0, 0, 1), AXIS_COLORS.z],
      ];
      for (const [dir, color] of axes) {
        const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), 1.2, color, 0.18, 0.1);
        group.add(arrow);
      }
    } else if (this.mode === 'scale') {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(1.3, 1.3, 1.3),
        new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true }),
      );
      group.add(box);
    } else {
      // rotate: two rings — yaw about +Y and pitch about +X (the two
      // accumulated axes sessions.md §9 names and the step() math applies).
      const ringY = new THREE.Mesh(
        new THREE.TorusGeometry(0.9, 0.03, 8, 32),
        new THREE.MeshBasicMaterial({ color: 0xffd166 }),
      );
      ringY.rotation.x = Math.PI / 2;
      group.add(ringY);
      const ringX = new THREE.Mesh(
        new THREE.TorusGeometry(0.9, 0.03, 8, 32),
        new THREE.MeshBasicMaterial({ color: 0x5299ff }),
      );
      ringX.rotation.y = Math.PI / 2;
      group.add(ringX);
    }
    this.scene.add(group);
    this.helpers.push(group);
  }

  private clearHelpers(): void {
    for (const h of this.helpers) {
      this.scene.remove(h);
      h.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as { material?: THREE.Material | THREE.Material[] }).material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) mat.dispose();
      });
    }
    this.helpers = [];
  }

  dispose(): void {
    this.clearHelpers();
    this.target = null;
  }
}