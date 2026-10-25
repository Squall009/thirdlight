/**
 * The Scene view's transform gizmo. It moves a stand-in whose parent frame is
 * the selection's parent's world matrix (so its pose is the local transform)
 * or the selected instance copy's stand-in. A drag previews the transform
 * locally (the entity drawn where the drag has it) and its release is handed
 * to the caller as one command; Esc during a drag resets it and the release
 * sends nothing.
 *
 * Browser-only (three.js controls).
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { PlaneAxis } from '@thirdlight/project-model';
import type { ProjectedEntity } from '../session/projection';
import { clampScale, getSnapSettings } from '../session/snapping';
import type { CopyTransform } from '../session/instance-copies';
import type { CopySelection } from './copy-selection';
import { frameObject, type CellTopSnap, type SceneQueries } from './scene-queries';
import type { SceneSource } from './scene-source';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface GizmoTransform {
  position: number[];
  rotation: number[];
  scale: number[];
}

/** The gizmo's size (TransformControls' own scale). */
const GIZMO_SIZE = 0.9;

export interface SelectionGizmoHost {
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly root: () => HTMLElement;
  readonly source: SceneSource;
  readonly synced: ReadonlyMap<string, ProjectedEntity>;
  readonly queries: SceneQueries;
  readonly copies: CopySelection;
  readonly mode: () => GizmoMode;
  readonly snapping: () => boolean;
  readonly cellTopSnap: () => CellTopSnap | null;
  readonly gestureBegin: (entityId: string) => void;
  readonly gestureFrame: (entityId: string, t: GizmoTransform) => void;
  readonly gestureEnd: (entityId: string, t: GizmoTransform) => void;
  readonly copyTransform: (entityId: string, index: number, t: CopyTransform) => void;
  readonly requestRender: () => void;
}

export class SelectionGizmo {
  private readonly gizmo: TransformControls;
  private target: string | null = null;
  /** The gizmo moves this stand-in; its parent frame is the selection's parent's world matrix, so its pose is the local transform. */
  private readonly frame = frameObject();
  private readonly proxy = new THREE.Object3D();
  /** A gizmo drag is in flight (between TransformControls mouseDown/mouseUp). */
  private drag = false;
  /** Esc during a gizmo drag: the object is reset and the release commits nothing. */
  private cancelled = false;
  /** Released drags whose entity is drawn where the drag left it until the projection has the result. */
  readonly settling = new Set<string>();
  /** The plane the selection's body is locked to (its normal's axis; null: free). */
  private lockAxis: PlaneAxis | null = null;

  constructor(canvas: HTMLCanvasElement, private readonly host: SelectionGizmoHost) {
    this.frame.add(this.proxy);
    const gizmo = new TransformControls(host.camera, canvas);
    this.gizmo = gizmo;
    gizmo.setSize(GIZMO_SIZE);
    gizmo.addEventListener('change', () => host.requestRender());
    gizmo.addEventListener('dragging-changed', (e) => {
      host.orbit.enabled = !(e as unknown as { value: boolean }).value;
    });
    gizmo.addEventListener('mouseDown', () => {
      const id = this.target;
      if (!id) return;
      this.drag = true;
      this.cancelled = false;
      this.applySnapping();
      // A copy of an instance set previews locally; its release stores one buffer.
      if (gizmo.object === host.copies.proxy) return;
      host.gestureBegin(id);
    });
    gizmo.addEventListener('objectChange', () => {
      const id = this.target;
      if (!this.drag || !id || this.cancelled) return;
      if (gizmo.object === host.copies.proxy && host.copies.selection !== null) {
        host.copies.previewDrag();
        return;
      }
      // A moved object lands on the cell tops under it (translate gestures).
      const cellTopSnap = host.cellTopSnap();
      if (cellTopSnap !== null && host.mode() === 'translate') {
        const o = this.proxy;
        const at = cellTopSnap(id, [o.position.x, o.position.y, o.position.z], [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]);
        if (at !== null) {
          o.position.set(at[0], at[1], at[2]);
          o.updateMatrixWorld(true);
        }
      }
      // The entity is drawn where the drag has it (the adapter places it from this local transform).
      const t = this.read();
      host.source.setOverride(id, t);
      host.gestureFrame(id, t);
    });
    gizmo.addEventListener('mouseUp', () => {
      const id = this.target;
      const cancelled = this.cancelled;
      this.drag = false;
      this.cancelled = false;
      const sel = host.copies.selection;
      if (gizmo.object === host.copies.proxy && sel !== null) {
        if (cancelled) host.copies.sync(true);
        else host.copyTransform(sel.entityId, sel.index, host.copies.read());
        return;
      }
      if (!id) return;
      if (cancelled) {
        host.source.setOverride(id, null);
        host.requestRender();
        return;
      }
      // Drawn where the drag left it until the projection has the stored transform (or the gesture is undone).
      this.settling.add(id);
      host.gestureEnd(id, this.read());
    });
  }

  /** The gizmo's own drawing (added to the view's overlay). */
  helper(): THREE.Object3D {
    return this.gizmo.getHelper();
  }

  /** A drag is in flight. */
  get dragging(): boolean {
    return this.drag;
  }

  /** The axis under the pointer (null: none; a click there is the gizmo's, not a pick). */
  get axis(): string | null {
    return this.gizmo.axis;
  }

  /** The entity the gizmo is on (null: none). */
  get targetId(): string | null {
    return this.target;
  }

  /** The gizmo drags this entity now. */
  holds(id: string): boolean {
    return this.drag && id === this.target;
  }

  /** The gizmo moves the entity's stand-in (not an instance copy's). */
  get onEntity(): boolean {
    return this.gizmo.object === this.proxy;
  }

  private read(): GizmoTransform {
    const t = this.proxy;
    return {
      position: [t.position.x, t.position.y, t.position.z],
      rotation: [t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w],
      scale: [clampScale(t.scale.x), clampScale(t.scale.y), clampScale(t.scale.z)],
    };
  }

  /** Grid snapping for the current drag (default on; Shift disables it). */
  applySnapping(): void {
    const on = this.host.snapping();
    const s = getSnapSettings();
    this.gizmo.setTranslationSnap(on ? s.translateM : null);
    this.gizmo.setRotationSnap(on ? (s.rotateDeg * Math.PI) / 180 : null);
    this.gizmo.setScaleSnap(on ? s.scale : null);
    // The step in force (tests read it).
    this.host.root().setAttribute('data-snap-step', on ? String(s.translateM) : '');
  }

  /** Esc during a drag: the object is reset and the release sends nothing. False when no drag is in flight. */
  cancel(): boolean {
    if (!this.drag || this.cancelled) return false;
    this.gizmo.reset();
    this.cancelled = true;
    if (this.target !== null && this.onEntity) this.host.source.setOverride(this.target, null);
    return true;
  }

  /** The stand-in at the entity's local transform, in its parent's world frame. */
  placeFrame(id: string | null): void {
    if (id === null) return;
    const e = this.host.synced.get(id);
    const parent = e?.parentId !== null && e?.parentId !== undefined ? this.host.queries.worldOf(e.parentId) : null;
    this.frame.matrix.copy(parent ?? new THREE.Matrix4());
    this.frame.matrixWorld.copy(this.frame.matrix);
    const t = this.host.source.localOf(id);
    if (t !== null) {
      this.proxy.position.set(t.position[0] ?? 0, t.position[1] ?? 0, t.position[2] ?? 0);
      this.proxy.quaternion.set(t.rotation[0] ?? 0, t.rotation[1] ?? 0, t.rotation[2] ?? 0, t.rotation[3] ?? 1);
      this.proxy.scale.set(t.scale[0] ?? 1, t.scale[1] ?? 1, t.scale[2] ?? 1);
    }
    this.proxy.updateMatrixWorld(true);
  }

  /**
   * Put the gizmo on the selection: the selected copy's stand-in, the
   * entity's (when it can move), or nowhere (`copy` / `entity` false).
   */
  aim(id: string | null, take: { copy: boolean; entity: boolean } | null, mode: GizmoMode, lock: PlaneAxis | null = null): void {
    const target = take === null ? null : take.copy ? this.host.copies.proxy : id && take.entity ? this.proxy : null;
    if (id && target) {
      if (!this.drag) this.placeFrame(id);
      if (this.gizmo.object !== target) this.gizmo.attach(target);
      this.gizmo.setMode(mode);
      this.lockTo(target === this.proxy ? lock : null, mode);
      this.target = id;
    } else {
      this.gizmo.detach();
      this.target = null;
      if (this.lockAxis !== null) this.lockTo(null, mode);
    }
  }

  /**
   * A body locked to a plane is moved in the plane and turned about its
   * normal only, as the game will hold it: no arrow or square along the
   * normal, only the normal's ring. World axes (the gizmo's space), so a
   * turned parent does not tilt the plane. Scaling stays free.
   */
  private lockTo(axis: PlaneAxis | null, mode: GizmoMode): void {
    this.lockAxis = axis;
    const g = this.gizmo;
    const free = axis === null || mode === 'scale';
    if (free) {
      g.showX = g.showY = g.showZ = true;
    } else if (mode === 'translate') {
      g.showX = axis !== 'x';
      g.showY = true;
      g.showZ = axis !== 'z';
    } else {
      g.showX = axis === 'x';
      g.showY = false;
      g.showZ = axis === 'z';
    }
    // The lock in force (tests read it).
    this.host.root().setAttribute('data-gizmo-plane', axis ?? '');
  }

  /** The plane the gizmo keeps the selection on (its normal's axis; null: free). */
  get planeAxis(): PlaneAxis | null {
    return this.lockAxis;
  }

  /** The gizmo's centre and points on its X and Z arrows, on screen (null: no gizmo). */
  grab(): { x: number; y: number; ax: number; ay: number; zx: number; zy: number } | null {
    const target = this.gizmo.object;
    if (target === undefined || this.target === null) return null;
    const camera = this.host.camera;
    const rect = this.host.root().getBoundingClientRect();
    const at = target.getWorldPosition(new THREE.Vector3());
    // TransformControls' own size: distance × min(1.9 tan(fov/2), 7) × size / 4; its arrows run about 0.5 of that.
    const factor = (at.distanceTo(camera.position) * Math.min(1.9 * Math.tan((Math.PI * camera.fov) / 360), 7) * GIZMO_SIZE) / 4;
    const toScreen = (v: THREE.Vector3): { x: number; y: number } => {
      const p = v.clone().project(camera);
      return { x: Math.round(rect.left + ((p.x + 1) / 2) * rect.width), y: Math.round(rect.top + ((1 - p.y) / 2) * rect.height) };
    };
    const c = toScreen(at);
    const a = toScreen(at.clone().add(new THREE.Vector3(0.3 * factor, 0, 0)));
    const z = toScreen(at.clone().add(new THREE.Vector3(0, 0, 0.3 * factor)));
    return { x: c.x, y: c.y, ax: a.x, ay: a.y, zx: z.x, zy: z.y };
  }

  /** The canvas was replaced (another renderer). */
  reconnect(canvas: HTMLCanvasElement): void {
    this.gizmo.disconnect();
    this.gizmo.connect(canvas);
  }

  dispose(): void {
    this.gizmo.detach();
    this.gizmo.dispose();
  }
}
