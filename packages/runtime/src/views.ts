/**
 * The views a game draws through, each owned by a camera brain.
 *
 * The engine owns the view: there is no scene camera. Each view's brain picks
 * the live virtual camera (camera-brain.ts) and resolves the pose and lens the
 * renderer draws with; while no camera is live the view holds the engine's
 * default pose (`DEFAULT_VIEW_POSE`) with the project's lens (its camera
 * settings), and the brain warns. Everything that reads or sets a view takes
 * its key: there is one view today (`DEFAULT_VIEW_ID`), so a second one — a
 * split screen, a networked player's — is a new key, not a new API. The
 * shots are the scene's (every loaded virtual camera is a candidate in every
 * view; a camera bound to one view is the field a second view adds).
 *
 * The resolved view is simulation state (stepped at the end of every fixed
 * step), so replays, a second run and the simulation worker see the same view
 * and the same screen rays.
 */
import { DEFAULT_VIEW_ID, DEFAULT_VIEW_POSE } from '@thirdlight/project-model';

import type { ActionFrame } from './actions';
import { CameraBrain, type BaseLens, type CameraViewInfo, type CameraWorld } from './camera-brain';
import { screenToRay as poseScreenToRay, worldToScreen as poseWorldToScreen, type CameraPose } from './camera-rig';
import type { BehaviorCamera, CameraInfo } from './types';

export interface ViewHost extends CameraWorld {
  /** A camera warning for the play log. */
  warn(message: string): void;
}

export class RuntimeViews {
  private readonly brains = new Map<string, CameraBrain>();
  private readonly basePosition = [...DEFAULT_VIEW_POSE.position];
  private readonly baseRotation = [...DEFAULT_VIEW_POSE.rotation];
  readonly control: BehaviorCamera;

  constructor(
    hz: number,
    private readonly lens: BaseLens,
    private readonly host: ViewHost,
  ) {
    this.brains.set(DEFAULT_VIEW_ID, new CameraBrain(hz, lens, (message) => host.warn(message)));
    this.control = this.buildControl();
  }

  /** A view's brain (the main view's when no key is given). */
  brain(view: string = DEFAULT_VIEW_ID): CameraBrain | undefined {
    return this.brains.get(view);
  }

  /** The main view's brain (game modes and timelines drive it). */
  get main(): CameraBrain {
    return this.brains.get(DEFAULT_VIEW_ID)!;
  }

  /** Entities came in (the start set, a scene load, spawns): their shots, paths and regions. */
  add(entities: readonly { id: string; components: unknown }[]): void {
    for (const b of this.brains.values()) b.add(entities);
  }

  /** Entities left. */
  remove(ids: ReadonlySet<string>): void {
    for (const b of this.brains.values()) b.remove(ids);
  }

  /** A new run: every view back to the start. */
  reset(): void {
    for (const b of this.brains.values()) b.reset();
  }

  /** One step of every view on the step's committed transforms. */
  step(action: ActionFrame | null): void {
    const base = { position: this.basePosition, rotation: this.baseRotation };
    for (const b of this.brains.values()) b.step(base, action, this.host);
  }

  /** A view's resolved pose interpolated by `alpha` (its lens returned; the base pose before its first step), or null for an unknown view. */
  readInterpolated(alpha: number, position: number[], rotation: number[], view: string = DEFAULT_VIEW_ID): { fovY: number; near: number; far: number; letterbox: number } | null {
    const b = this.brains.get(view);
    if (b === undefined) return null;
    if (b.hasView()) return b.readInterpolated(alpha, position, rotation);
    for (let k = 0; k < 3; k += 1) position[k] = this.basePosition[k]!;
    for (let k = 0; k < 4; k += 1) rotation[k] = this.baseRotation[k]!;
    return { fovY: this.lens.fovY, near: this.lens.near, far: this.lens.far, letterbox: 0 };
  }

  /** A view's committed state (the live camera, a blend, the pose and lens), or null before its first step. */
  view(view: string = DEFAULT_VIEW_ID): CameraViewInfo | null {
    const b = this.brains.get(view);
    return b === undefined || !b.hasView() ? null : b.view();
  }

  /** The viewport a view is drawn in (its projection's aspect). */
  setViewport(width: number, height: number, view: string = DEFAULT_VIEW_ID): boolean {
    return this.brains.get(view)?.setViewport(width, height) ?? false;
  }

  /** The project's lens and the main view's key (`getCamera`). */
  info(): CameraInfo {
    return { id: DEFAULT_VIEW_ID, fovY: this.lens.fovY, near: this.lens.near, far: this.lens.far };
  }

  /** The base pose (before a view's first step): the default pose with the project's lens. */
  private basePose(): CameraPose {
    const p = this.basePosition;
    const r = this.baseRotation;
    return { position: [p[0]!, p[1]!, p[2]!], rotation: [r[0]!, r[1]!, r[2]!, r[3]!], fovY: this.lens.fovY, near: this.lens.near, far: this.lens.far, letterbox: 0 };
  }

  /** The ray from a view through a screen point (normalized, 0,0 top left). */
  screenRay(x: number, y: number, view: string = DEFAULT_VIEW_ID): { origin: readonly [number, number, number]; direction: readonly [number, number, number] } {
    const b = this.brains.get(view) ?? this.main;
    if (b.hasView()) return b.screenToRay(x, y);
    return poseScreenToRay(this.basePose(), b.viewportSize().aspect, Number.isFinite(x) ? x : 0.5, Number.isFinite(y) ? y : 0.5);
  }

  /** Where a world point shows in a view. */
  worldToScreen(position: readonly number[], view: string = DEFAULT_VIEW_ID): { x: number; y: number; depth: number; onScreen: boolean } {
    const b = this.brains.get(view) ?? this.main;
    if (b.hasView()) return b.worldToScreen(position);
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return poseWorldToScreen(this.basePose(), b.viewportSize().aspect, n(position[0]), n(position[1]), n(position[2]));
  }

  /**
   * A view's yaw for a 3D character's move input — radians about +Y (0
   * looking along −Z) — from its committed view, or undefined (world axes)
   * before its first step or while no camera is live.
   */
  yaw(view: string = DEFAULT_VIEW_ID): number | undefined {
    const b = this.brains.get(view);
    if (b === undefined || !b.hasView() || b.live() === null) return undefined;
    const q = b.view().rotation;
    // The view's forward (−Z turned by the rotation), flattened onto the ground.
    const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
    let fx = -2 * (x * z + w * y);
    let fz = -(1 - 2 * (x * x + y * y));
    if (!(Math.hypot(fx, fz) > 1e-3)) {
      // Looking straight down (or up): the screen's up is the way forward on the ground.
      fx = 2 * (x * y - w * z);
      fz = 2 * (y * z + w * x);
      if (!(Math.hypot(fx, fz) > 1e-9)) return undefined;
    }
    return Math.atan2(-fx, -fz);
  }

  /** `ctx.camera` over the main view (arguments checked here; the brain applies them in order). */
  private buildControl(): BehaviorCamera {
    const brain = this.main;
    const blendOf = (o: unknown): unknown => (typeof o === 'object' && o !== null ? o : undefined);
    return Object.freeze({
      activate: (cameraId: string, options?: unknown): boolean => brain.activate(String(cameraId), blendOf(options)),
      deactivate: (cameraId: string, options?: unknown): boolean => brain.deactivate(String(cameraId), blendOf(options)),
      setPriority: (cameraId: string, priority: number): boolean => brain.setPriority(String(cameraId), Number(priority)),
      setTarget: (cameraId: string, entityId: string): boolean => brain.setTarget(String(cameraId), typeof entityId === 'string' ? entityId : null),
      set: (cameraId: string, params: unknown): boolean => brain.set(String(cameraId), params),
      turn: (cameraId: string, steps: number): boolean => brain.turn(String(cameraId), Number(steps)),
      shake: (amplitude: number, seconds: number, frequency?: number, rotation?: number, seed?: number): void => brain.shake(Number(amplitude), Number(seconds), frequency, rotation, seed),
      live: (): string | null => brain.live(),
      blending: (): boolean => brain.blending(),
      get: (cameraId: string) => brain.get(String(cameraId)),
      worldToScreen: (position: readonly number[]) => this.worldToScreen(Array.isArray(position) ? position : [0, 0, 0]),
      screenToRay: (x: number, y: number) => this.screenRay(Number(x), Number(y)),
    }) as BehaviorCamera;
  }
}
