/**
 * Phase 23.4: the camera brain — which virtual camera is live, the blend to
 * it, each rig's state (turned, zoomed, riding its path), shake impulses and
 * the resolved view. Pure maths (camera-rig.ts), run by the runtime at the
 * end of every fixed step, after the camera phase: the resolved camera is
 * simulation state, so a replay, a second run and the simulation worker give
 * the same camera bit for bit, and screen rays (`ctx.camera.screenToRay`)
 * replay identically. The renderer only applies the resolved pose,
 * interpolated between the last two steps like every transform.
 *
 * Resolution: the live camera is the enabled virtual camera with the highest
 * priority; on a tie the one activated last (`activate` bumps it), then the
 * first in load order. Without an enabled virtual camera the view is the
 * scene camera's own pose (its `cameraFollow` result, or where it is placed)
 * — so a project without virtual cameras draws exactly what it drew before.
 * When the live camera changes the view blends from what is on screen to the
 * new camera: a cut, a linear or an eased move over the incoming camera's
 * blend time (going back to the scene camera: the outgoing camera's), unless
 * the script that caused it names a blend. A blend interrupted by another
 * change continues from the blended view.
 */
import type { ActionFrame } from './actions';
import {
  applyShake,
  blendPoses,
  clampNum,
  copyPose,
  easeInOut,
  lookAtQuat,
  newPose,
  orbitOffset,
  pointOnPath,
  quatFromYawPitch,
  samplePath,
  screenToRay,
  seedOf,
  slerp,
  worldToScreen,
  yawPitchOf,
  type CameraPose,
  type Q4,
  type SampledPath,
  type ScreenPoint,
  type V3,
} from './camera-rig';

/** The virtualCamera component as the brain reads it (project-model `VirtualCameraComponent`). */
export interface VirtualCameraData {
  readonly rig: 'follow' | 'orbitPoint' | 'topDown' | 'fixed' | 'rail' | 'track';
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly target?: string;
  readonly targetOffset?: readonly number[];
  readonly distance?: number;
  readonly minDistance?: number;
  readonly maxDistance?: number;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly pitchMin?: number;
  readonly pitchMax?: number;
  readonly yawAction?: string;
  readonly pitchAction?: string;
  readonly rotateSpeed?: number;
  readonly zoomAction?: string;
  readonly zoomSpeed?: number;
  readonly turnLeftAction?: string;
  readonly turnRightAction?: string;
  readonly yawStep?: number;
  readonly turnTime?: number;
  readonly point?: readonly number[];
  readonly collision?: boolean;
  readonly collisionRadius?: number;
  readonly damping?: number;
  readonly path?: string;
  readonly progress?: number;
  readonly railSpeed?: number;
  readonly railMode?: 'once' | 'loop' | 'pingpong';
  readonly fovY?: number;
  readonly near?: number;
  readonly far?: number;
  readonly blend?: 'cut' | 'linear' | 'eased';
  readonly blendTime?: number;
  readonly letterbox?: number;
  readonly shakeAmplitude?: number;
  readonly shakeFrequency?: number;
  readonly shakeRotation?: number;
  /** Phase 24.4g (track): the camera's offset from the framed point, the dead zone (w, h, d) and the bounds of the framed point. */
  readonly trackOffset?: readonly number[];
  readonly deadZone?: readonly number[];
  readonly boundsMin?: readonly number[];
  readonly boundsMax?: readonly number[];
  /** Phase 25.14 (track): look-ahead seconds per axis, its cap (m) and smoothing (s). */
  readonly lookAhead?: readonly number[];
  readonly lookAheadMax?: readonly number[];
  readonly lookAheadSmoothing?: number;
}

/** Phase 25.14: the cameraRegion component as the brain reads it (project-model `CameraRegionComponent`). */
export interface CameraRegionData {
  readonly size: readonly number[];
  readonly camera?: string;
  readonly priority?: number;
  readonly deadZone?: readonly number[];
  readonly boundsMin?: readonly number[];
  readonly boundsMax?: readonly number[];
  readonly distance?: number;
  readonly blendTime?: number;
}

/**
 * Phase 25.14: the track settings a region changes — the dead zone's half
 * size, the bounds of the framed point (±Infinity: none) and the distance
 * along the offset (null: the offset as it is).
 */
interface TrackParams {
  readonly half: V3;
  readonly lo: V3;
  readonly hi: V3;
  readonly dist: number | null;
}
/** Where a region blend starts: settings, or a blend frozen where it was interrupted. */
type TrackSource = { readonly p: TrackParams } | { readonly from: TrackSource; readonly to: TrackParams; readonly w: number };

/** The cameraPath component as the brain reads it. */
export interface CameraPathData {
  readonly points: readonly (readonly number[])[];
  readonly closed?: boolean;
  readonly smooth?: boolean;
}

/** The engine defaults (project-model VIRTUAL_CAMERA_DEFAULTS: the same values and reasons). */
const D = {
  priority: 0,
  distance: 5,
  minDistance: 0.5,
  maxDistance: 100,
  yaw: 0,
  pitch: 20,
  pitchMin: -30,
  pitchMax: 80,
  rotateSpeed: 120,
  zoomSpeed: 10,
  yawStep: 90,
  turnTime: 0.25,
  collisionRadius: 0.2,
  damping: 0,
  railSpeed: 0,
  blendTime: 0.5,
  shakeFrequency: 8,
  lookAheadMax: 3,
  lookAheadSmoothing: 0.2,
} as const;

/** Engine limit: live shake impulses at once (the oldest is dropped past it). */
export const MAX_SHAKE_IMPULSES = 16;

export type CameraBlendStyle = 'cut' | 'linear' | 'eased';

/** What the brain reads from the simulation each step. */
export interface CameraWorld {
  /** An entity's world position and rotation (false: not loaded). */
  worldOf(id: string, position: number[], rotation: number[]): boolean;
  /** The nearest collider along a ray (3D projects; absent: no collision pull-in). */
  raycast?(origin: V3, direction: V3, maxDistance: number): { distance: number } | null;
}

/** A virtual camera's live state as scripts read it (`ctx.camera.get`). */
export interface VirtualCameraState {
  readonly rig: VirtualCameraData['rig'];
  readonly enabled: boolean;
  readonly priority: number;
  readonly live: boolean;
  /** The target entity ('' for none). */
  readonly target: string;
  readonly distance: number;
  /** The heading the rig turns to (degrees; a snapped rig's current step). */
  readonly yaw: number;
  readonly pitch: number;
  /** A rail camera's place along its path (0–1). */
  readonly progress: number;
  readonly railSpeed: number;
  readonly fovY: number;
  readonly letterbox: number;
}

/** The resolved view as observers read it (committed at the last step). */
export interface CameraViewInfo {
  /** The live virtual camera, or null: the scene camera's own view. */
  readonly live: string | null;
  /** A blend in progress: from what, how far (0–1). */
  readonly blend: { readonly from: string | null; readonly progress: number; readonly style: CameraBlendStyle } | null;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly fovY: number;
  readonly near: number;
  readonly far: number;
  readonly letterbox: number;
  /** The shake applied this step (m). */
  readonly shake: number;
  /** Phase 25.14: the camera region the live track camera is in (null: none; absent: no region loaded, or not a track camera). */
  readonly region?: string | null;
}

interface CamState {
  readonly id: string;
  readonly order: number;
  readonly data: VirtualCameraData;
  readonly seed: number;
  enabled: boolean;
  priority: number;
  serial: number;
  target: string | null;
  targetOffset: V3;
  point: V3 | null;
  distance: number;
  yaw: number;
  pitch: number;
  turnFrom: number;
  turnTo: number;
  /** Steps into the current snapped turn. */
  turnElapsed: number;
  progress: number;
  railSpeed: number;
  railDir: 1 | -1;
  fovY: number | null;
  letterbox: number;
  pivot: V3 | null;
  /** Phase 24.4g (track): the offset from the framed point (resolved on its first evaluation when not authored). */
  trackOffset: V3 | null;
  /** Phase 25.14 (track): the camera region its target is in, when each region was entered, the settings in force and a blend between them. */
  region: string | null;
  readonly regionEntered: Map<string, number>;
  regionParams: TrackParams | null;
  /** The camera's own settings (its data does not change during a run). */
  ownParams: TrackParams | null;
  regionBlend: { from: TrackSource; steps: number; total: number } | null;
  /** Phase 25.14 (track): the target's last point and its eased velocity (look-ahead). */
  lookLast: V3 | null;
  readonly lookVel: V3;
  readonly pose: CameraPose;
}

interface Impulse {
  amplitude: number;
  /** Steps it lasts and has run (counted in whole steps: exact and replayable). */
  total: number;
  steps: number;
  frequency: number;
  rotation: number;
  seed: number;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Scene camera lens (the base view's). */
export interface BaseLens {
  fovY: number;
  near: number;
  far: number;
}

export class CameraBrain {
  private readonly dt: number;
  private readonly hz: number;
  private stepCount = 0;
  private readonly cams = new Map<string, CamState>();
  /** Phase 25.14: the loaded camera regions, in load order. */
  private readonly regions = new Map<string, CameraRegionData>();
  private regionSerial = 0;
  private readonly regionPos: number[] = [0, 0, 0];
  private readonly regionRot: number[] = [0, 0, 0, 1];
  private readonly aimAt: V3 = [0, 0, 0];
  private readonly paths = new Map<string, { data: CameraPathData; sampled: SampledPath }>();
  private order = 0;
  private serialCounter = 0;
  private liveId: string | null = null;
  /** Phase 23.17: the camera a timeline forces live (null: none); it wins over a game mode's camera. */
  private timelineOverrideId: string | null = null;
  private blend: { from: CameraPose; fromId: string | null; fromLive: boolean; steps: number; total: number; style: CameraBlendStyle } | null = null;
  /** A blend a script asked for with the change it made (used by the next switch). */
  private pendingBlend: { style: CameraBlendStyle; seconds: number } | null = null;
  private impulses: Impulse[] = [];
  private impulseSerial = 0;
  private started = false;
  private time = 0;
  private aspect = 16 / 9;
  private viewport = { width: 0, height: 0 };
  private readonly basePose: CameraPose = newPose();
  private readonly out: CameraPose = newPose();
  private readonly unshaken: CameraPose = newPose();
  private readonly prev: CameraPose = newPose();
  private readonly curr: CameraPose = newPose();
  private lastShake = 0;
  private readonly tmpPos: number[] = [0, 0, 0];
  private readonly tmpRot: number[] = [0, 0, 0, 1];
  private readonly tmpQ: Q4 = [0, 0, 0, 1];
  private readonly selfPos: number[] = [0, 0, 0];
  private readonly selfRot: number[] = [0, 0, 0, 1];
  private readonly targetAt: V3 = [0, 0, 0];
  private readonly pivotAt: V3 = [0, 0, 0];
  private readonly pathAt: V3 = [0, 0, 0];
  private readonly pathTan: V3 = [0, 0, 0];
  private readonly originPos: number[] = [0, 0, 0];
  private readonly originRot: number[] = [0, 0, 0, 1];
  private readonly offAt: V3 = [0, 0, 0];
  private readonly lensOut = { fovY: 60, near: 0.1, far: 100, letterbox: 0 };
  /** Warnings for missing targets or paths (reported once per camera). */
  private readonly warned = new Set<string>();
  /**
   * Phase 23.10: the game mode's camera — live over every priority while the
   * mode is active (null: the priority rule). Set by the mode switch.
   */
  private overrideId: string | null = null;

  constructor(
    hz: number,
    private readonly baseLens: BaseLens,
    private readonly warn: (message: string) => void = () => undefined,
  ) {
    this.dt = 1 / hz;
    this.hz = hz;
  }

  /** Any virtual camera loaded (the runtime steps the brain only then; regions alone do nothing). */
  get active(): boolean {
    return this.cams.size > 0;
  }

  /** Entities came in (scene loads, the start set): their cameras and paths. */
  add(entities: readonly { id: string; components: unknown }[]): void {
    for (const e of entities) {
      const c = e.components as { virtualCamera?: VirtualCameraData; cameraPath?: CameraPathData; cameraRegion?: CameraRegionData };
      if (c.cameraRegion !== undefined && Array.isArray(c.cameraRegion.size) && c.cameraRegion.size.length >= 2) this.regions.set(e.id, c.cameraRegion);
      if (c.cameraPath !== undefined && Array.isArray(c.cameraPath.points) && c.cameraPath.points.length >= 2) {
        this.paths.set(e.id, { data: c.cameraPath, sampled: samplePath(c.cameraPath.points, c.cameraPath.closed === true, c.cameraPath.smooth !== false) });
      }
      if (c.virtualCamera !== undefined && !this.cams.has(e.id)) this.cams.set(e.id, this.fresh(e.id, c.virtualCamera, this.order++));
    }
  }

  /** Entities left: a live camera that leaves hands over like a deactivation. */
  remove(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.cams.delete(id);
      this.paths.delete(id);
      this.regions.delete(id);
    }
  }

  /** A new run: every camera back to its data, the view back to the start. */
  reset(): void {
    for (const [id, s] of this.cams) this.cams.set(id, this.fresh(id, s.data, s.order));
    this.liveId = null;
    this.blend = null;
    this.pendingBlend = null;
    this.timelineOverrideId = null;
    this.impulses = [];
    this.started = false;
    this.serialCounter = 0;
    this.impulseSerial = 0;
    this.regionSerial = 0;
    this.stepCount = 0;
    this.time = 0;
    this.overrideId = null;
  }

  /**
   * Phase 23.10: a game mode's camera (null: back to the priority rule) and
   * the blend into it (the incoming camera's own when absent). A camera that
   * is not loaded is warned once and the priority rule applies.
   */
  setOverride(id: string | null, options?: unknown): void {
    this.overrideId = id;
    if (id !== null && !this.cams.has(id)) this.warnOnce(`override:${id}`, `the game mode's camera "${id}" is not a loaded virtual camera; the priority rule applies`);
    this.noteBlend(options);
  }

  /** Phase 23.10: the game mode's camera (null: none). */
  get override(): string | null {
    return this.overrideId;
  }

  private fresh(id: string, d: VirtualCameraData, order: number): CamState {
    const yaw = num(d.yaw, D.yaw);
    const pitchMin = num(d.pitchMin, D.pitchMin);
    const pitchMax = num(d.pitchMax, D.pitchMax);
    const orbit = d.rig === 'follow' || d.rig === 'orbitPoint';
    const pitch = orbit ? clampNum(num(d.pitch, D.pitch), pitchMin, Math.max(pitchMin, pitchMax)) : num(d.pitch, D.pitch);
    const off = d.targetOffset;
    return {
      id,
      order,
      data: d,
      seed: seedOf(id),
      enabled: d.enabled !== false,
      priority: num(d.priority, D.priority),
      serial: 0,
      target: typeof d.target === 'string' && d.target !== '' ? d.target : null,
      targetOffset: [num(off?.[0], 0), num(off?.[1], 0), num(off?.[2], 0)],
      point: Array.isArray(d.point) && d.point.length === 3 ? [num(d.point[0], 0), num(d.point[1], 0), num(d.point[2], 0)] : null,
      distance: num(d.distance, D.distance),
      yaw,
      pitch,
      turnFrom: yaw,
      turnTo: yaw,
      turnElapsed: 0,
      progress: clampNum(num(d.progress, 0), 0, 1),
      railSpeed: num(d.railSpeed, D.railSpeed),
      railDir: 1,
      fovY: typeof d.fovY === 'number' ? d.fovY : null,
      letterbox: num(d.letterbox, 0),
      pivot: null,
      trackOffset: Array.isArray(d.trackOffset) && d.trackOffset.length === 3 ? [num(d.trackOffset[0], 0), num(d.trackOffset[1], 0), num(d.trackOffset[2], 0)] : null,
      region: null,
      regionEntered: new Map(),
      regionParams: null,
      ownParams: null,
      regionBlend: null,
      lookLast: null,
      lookVel: [0, 0, 0],
      pose: newPose(),
    };
  }

  // ---- the script surface (ctx.camera) -------------------------------------------

  private noteBlend(options: unknown): void {
    if (typeof options !== 'object' || options === null) return;
    const o = options as { blend?: unknown; time?: unknown };
    const style = o.blend === 'cut' || o.blend === 'linear' || o.blend === 'eased' ? o.blend : null;
    const seconds = typeof o.time === 'number' && Number.isFinite(o.time) ? clampNum(o.time, 0, 30) : null;
    if (style === null && seconds === null) return;
    this.pendingBlend = { style: style ?? 'eased', seconds: seconds ?? D.blendTime };
  }

  activate(id: string, options?: unknown): boolean {
    const s = this.cams.get(String(id));
    if (s === undefined) return false;
    s.enabled = true;
    s.serial = ++this.serialCounter;
    this.noteBlend(options);
    return true;
  }

  deactivate(id: string, options?: unknown): boolean {
    const s = this.cams.get(String(id));
    if (s === undefined) return false;
    s.enabled = false;
    this.noteBlend(options);
    return true;
  }

  setPriority(id: string, priority: number): boolean {
    const s = this.cams.get(String(id));
    if (s === undefined || typeof priority !== 'number' || !Number.isFinite(priority)) return false;
    s.priority = clampNum(Math.round(priority), -1000, 1000);
    return true;
  }

  setTarget(id: string, entityId: string | null | undefined): boolean {
    const s = this.cams.get(String(id));
    if (s === undefined) return false;
    if (entityId === null || entityId === undefined || entityId === '') s.target = null;
    else if (typeof entityId === 'string' && entityId.length <= 64) s.target = entityId;
    else return false;
    s.pivot = null;
    this.warned.delete(`target:${s.id}`);
    return true;
  }

  set(id: string, params: unknown): boolean {
    const s = this.cams.get(String(id));
    if (s === undefined || typeof params !== 'object' || params === null) return false;
    const p = params as Record<string, unknown>;
    const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (fin(p['distance'])) s.distance = clampNum(p['distance'], 0.1, 10000);
    if (fin(p['yaw'])) {
      s.yaw = p['yaw'];
      s.turnFrom = s.yaw;
      s.turnTo = s.yaw;
      s.turnElapsed = 0;
    }
    if (fin(p['pitch'])) {
      const orbit = s.data.rig === 'follow' || s.data.rig === 'orbitPoint';
      const lo = num(s.data.pitchMin, D.pitchMin);
      s.pitch = orbit ? clampNum(p['pitch'], lo, Math.max(lo, num(s.data.pitchMax, D.pitchMax))) : clampNum(p['pitch'], -89, 90);
    }
    if (fin(p['progress'])) s.progress = clampNum(p['progress'], 0, 1);
    if (fin(p['railSpeed'])) s.railSpeed = clampNum(p['railSpeed'], -1000, 1000);
    if (fin(p['fovY'])) s.fovY = clampNum(p['fovY'], 1, 179);
    if (fin(p['letterbox'])) s.letterbox = clampNum(p['letterbox'], 0, 0.5);
    const pt = p['point'];
    if (Array.isArray(pt) && pt.length === 3 && pt.every(fin)) s.point = [pt[0] as number, pt[1] as number, pt[2] as number];
    const off = p['targetOffset'];
    if (Array.isArray(off) && off.length === 3 && off.every(fin)) s.targetOffset = [off[0] as number, off[1] as number, off[2] as number];
    return true;
  }

  /** Turn a snapped rig by whole steps (orbitPoint: its `yawStep`; others: 90°). */
  turn(id: string, steps: number): boolean {
    const s = this.cams.get(String(id));
    if (s === undefined || typeof steps !== 'number' || !Number.isFinite(steps)) return false;
    this.turnBy(s, Math.round(steps));
    return true;
  }

  private turnBy(s: CamState, steps: number): void {
    if (steps === 0) return;
    const step = num(s.data.yawStep, D.yawStep);
    s.turnFrom = s.yaw;
    s.turnTo += steps * step;
    s.turnElapsed = 0;
  }

  /** A shake impulse (a seed of 0 or none: the impulse's serial number, so each differs yet replays alike). */
  shake(amplitude: number, seconds: number, frequency?: number, rotation?: number, seed?: number): void {
    if (typeof amplitude !== 'number' || !Number.isFinite(amplitude) || !(amplitude > 0)) return;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || !(seconds > 0)) return;
    const serial = ++this.impulseSerial;
    this.impulses.push({
      amplitude: clampNum(amplitude, 0, 10),
      total: Math.max(1, Math.round(clampNum(seconds, 0, 30) * this.hz)),
      steps: 0,
      frequency: clampNum(num(frequency, D.shakeFrequency), 0.1, 60),
      rotation: clampNum(num(rotation, 0), 0, 45),
      seed: typeof seed === 'number' && Number.isFinite(seed) && Math.trunc(seed) !== 0 ? Math.trunc(seed) : serial,
    });
    if (this.impulses.length > MAX_SHAKE_IMPULSES) this.impulses.splice(0, this.impulses.length - MAX_SHAKE_IMPULSES);
  }

  live(): string | null {
    return this.liveId;
  }

  blending(): boolean {
    return this.blend !== null;
  }

  get(id: string): VirtualCameraState | null {
    const s = this.cams.get(String(id));
    if (s === undefined) return null;
    const rig = s.data.rig;
    const yaw = rig === 'orbitPoint' ? s.turnTo : s.yaw;
    return Object.freeze({
      rig,
      enabled: s.enabled,
      priority: s.priority,
      live: this.liveId === s.id,
      target: s.target ?? '',
      distance: s.distance,
      yaw,
      pitch: rig === 'topDown' ? 90 : s.pitch,
      progress: s.progress,
      railSpeed: s.railSpeed,
      fovY: s.fovY ?? this.baseLens.fovY,
      letterbox: s.letterbox,
    });
  }

  setViewport(width: number, height: number): boolean {
    if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384)) return false;
    this.viewport = { width, height };
    this.aspect = width / height;
    return true;
  }

  worldToScreen(position: readonly number[]): ScreenPoint {
    return worldToScreen(this.curr, this.aspect, num(position?.[0], 0), num(position?.[1], 0), num(position?.[2], 0));
  }

  screenToRay(x: number, y: number): { origin: V3; direction: V3 } {
    return screenToRay(this.curr, this.aspect, num(x, 0.5), num(y, 0.5));
  }

  // ---- the step ------------------------------------------------------------------

  /**
   * Phase 23.17: the camera a timeline forces live (over priorities and over
   * a game mode's camera while the timeline shows it), with the blend of the
   * change; null gives the view back (to the mode's camera, else the
   * priorities). Inert unless a timeline uses it.
   */
  setTimelineOverride(id: string | null, options?: unknown): boolean {
    if (id !== null && !this.cams.has(id)) return false;
    if (id === this.timelineOverrideId) return true;
    this.timelineOverrideId = id;
    this.noteBlend(options);
    return true;
  }

  timelineOverride(): string | null {
    return this.timelineOverrideId;
  }

  private best(): CamState | null {
    // Phase 23.17: a timeline's camera wins while the timeline shows one.
    if (this.timelineOverrideId !== null) {
      const t = this.cams.get(this.timelineOverrideId);
      if (t !== undefined) return t;
    }
    // Phase 23.10: a game mode's camera is live over every priority.
    if (this.overrideId !== null) {
      const o = this.cams.get(this.overrideId);
      if (o !== undefined) return o;
    }
    let best: CamState | null = null;
    for (const s of this.cams.values()) {
      if (!s.enabled) continue;
      if (best === null || s.priority > best.priority || (s.priority === best.priority && (s.serial > best.serial || (s.serial === best.serial && s.order < best.order)))) best = s;
    }
    return best;
  }

  /**
   * One fixed step: the base view (the scene camera's committed pose), the
   * step's input, then resolve, advance and blend. `stepIndex` is the step
   * just executed (shake time).
   */
  step(base: { position: readonly number[]; rotation: readonly number[] }, action: ActionFrame | null, world: CameraWorld): void {
    const dt = this.dt;
    this.stepCount += 1;
    this.time = this.stepCount / this.hz;
    const bp = this.basePose;
    bp.position[0] = base.position[0]!;
    bp.position[1] = base.position[1]!;
    bp.position[2] = base.position[2]!;
    bp.rotation[0] = base.rotation[0]!;
    bp.rotation[1] = base.rotation[1]!;
    bp.rotation[2] = base.rotation[2]!;
    bp.rotation[3] = base.rotation[3]!;
    bp.fovY = this.baseLens.fovY;
    bp.near = this.baseLens.near;
    bp.far = this.baseLens.far;
    bp.letterbox = 0;

    const next = this.best();
    const nextId = next?.id ?? null;
    let cut = !this.started;
    if (this.started && nextId !== this.liveId) {
      // The camera changes: blend from what is on screen now.
      const leaving = this.liveId !== null ? this.cams.get(this.liveId) : undefined;
      const style: CameraBlendStyle = this.pendingBlend?.style ?? (next !== null ? (next.data.blend ?? 'eased') : (leaving?.data.blend ?? 'eased'));
      const seconds = this.pendingBlend?.seconds ?? num(next !== null ? next.data.blendTime : leaving?.data.blendTime, D.blendTime);
      if (style === 'cut' || !(seconds > 0)) {
        this.blend = null;
        cut = true;
      } else if (this.blend === null && (leaving !== undefined || this.liveId === null)) {
        // From the camera that was live, still moving (or the scene camera's live view).
        this.blend = { from: newPose(), fromId: this.liveId, fromLive: true, steps: 0, total: Math.max(1, Math.round(seconds * this.hz)), style };
      } else {
        // Interrupted blend (or a camera that left): from the blended view, frozen.
        this.blend = { from: copyPose(this.unshaken, newPose()), fromId: null, fromLive: false, steps: 0, total: Math.max(1, Math.round(seconds * this.hz)), style };
      }
      // A camera going live starts from where its rig is now (no damping lag from an old pivot).
      if (next !== null) next.pivot = null;
    }
    this.pendingBlend = null;
    this.liveId = nextId;
    this.started = true;

    // Advance and evaluate the live camera (it alone reads input and rides its rail).
    if (next !== null) {
      this.advance(next, action, dt);
      this.evaluate(next, world, dt);
    }
    // A blend source that is a live camera keeps moving while the view leaves it.
    const b = this.blend;
    let fromPose: CameraPose | null = null;
    if (b !== null) {
      if (b.fromLive) {
        const src = b.fromId !== null ? this.cams.get(b.fromId) : undefined;
        if (b.fromId === null) fromPose = bp;
        else if (src !== undefined) {
          this.evaluate(src, world, dt);
          fromPose = src.pose;
        } else {
          // The source left mid-blend: continue from where it was.
          b.fromLive = false;
          copyPose(this.unshaken, b.from);
          fromPose = b.from;
        }
      } else fromPose = b.from;
    }
    const target = next !== null ? next.pose : bp;
    if (b !== null && fromPose !== null) {
      b.steps += 1;
      const t = clampNum(b.steps / b.total, 0, 1);
      const w = b.style === 'eased' ? easeInOut(t) : t;
      blendPoses(fromPose, target, w, this.unshaken);
      if (t >= 1) this.blend = null;
    } else copyPose(target, this.unshaken);

    // Shake: the live camera's constant shake (weighted by the blend) and the impulses.
    copyPose(this.unshaken, this.out);
    let amp = 0;
    let rot = 0;
    let freq: number = D.shakeFrequency;
    let seed = 0;
    if (next !== null) {
      const w = this.blend === null ? 1 : easeInOut(this.blend.steps / this.blend.total);
      amp = num(next.data.shakeAmplitude, 0) * w;
      rot = num(next.data.shakeRotation, 0) * w;
      freq = num(next.data.shakeFrequency, D.shakeFrequency);
      seed = next.seed;
    }
    let shakeTotal = 0;
    if (amp > 0 || rot > 0) {
      applyShake(this.out, seed, this.time, freq, amp, rot);
      shakeTotal += amp;
    }
    if (this.impulses.length > 0) {
      const keep: Impulse[] = [];
      for (const im of this.impulses) {
        im.steps += 1;
        const left = 1 - im.steps / im.total;
        if (left <= 0) continue;
        const k = left * left;
        applyShake(this.out, im.seed, im.steps / this.hz, im.frequency, im.amplitude * k, im.rotation * k);
        shakeTotal += im.amplitude * k;
        keep.push(im);
      }
      this.impulses = keep;
    }
    this.lastShake = shakeTotal;

    // Commit: prev := curr (a cut: the new pose on both, so nothing streaks).
    if (cut) copyPose(this.out, this.prev);
    else copyPose(this.curr, this.prev);
    copyPose(this.out, this.curr);
  }

  /** The live camera's input and motion for one step. */
  private advance(s: CamState, action: ActionFrame | null, dt: number): void {
    const d = s.data;
    const acts = action?.actions;
    const axis = (name: string | undefined, which: 'x' | 'y' | 'v'): number => {
      if (name === undefined || acts === undefined) return 0;
      const a = acts[name];
      if (a === undefined) return 0;
      if (which === 'x') return num(a.x, a.v);
      if (which === 'y') return num(a.y, a.v);
      return a.v;
    };
    const pressed = (name: string | undefined): boolean => name !== undefined && acts?.[name]?.p === 'pressed';
    if (d.rig === 'follow' || d.rig === 'orbitPoint') {
      const speed = num(d.rotateSpeed, D.rotateSpeed);
      if (d.rig === 'follow') {
        // A 2D axis on the turn action: x turns, y tilts (unless a tilt action is named).
        const two = d.yawAction !== undefined && acts?.[d.yawAction]?.x !== undefined;
        s.yaw -= axis(d.yawAction, two ? 'x' : 'v') * speed * dt;
        const tilt = d.pitchAction !== undefined ? axis(d.pitchAction, 'v') : two ? axis(d.yawAction, 'y') : 0;
        if (tilt !== 0) s.pitch += tilt * speed * dt;
      } else {
        if (pressed(d.turnLeftAction)) this.turnBy(s, 1);
        if (pressed(d.turnRightAction)) this.turnBy(s, -1);
        const tt = num(d.turnTime, D.turnTime);
        if (s.turnTo !== s.yaw || s.turnElapsed > 0) {
          s.turnElapsed += 1;
          const total = Math.round(tt * this.hz);
          const t = total > 0 ? clampNum(s.turnElapsed / total, 0, 1) : 1;
          s.yaw = s.turnFrom + (s.turnTo - s.turnFrom) * easeInOut(t);
          if (t >= 1) {
            s.yaw = s.turnTo;
            s.turnFrom = s.turnTo;
            s.turnElapsed = 0;
          }
        }
        const tilt = axis(d.pitchAction, 'v');
        if (tilt !== 0) s.pitch += tilt * speed * dt;
      }
      const lo = num(d.pitchMin, D.pitchMin);
      s.pitch = clampNum(s.pitch, lo, Math.max(lo, num(d.pitchMax, D.pitchMax)));
      const zoom = axis(d.zoomAction, 'v');
      if (zoom !== 0) {
        const zlo = num(d.minDistance, D.minDistance);
        s.distance = clampNum(s.distance + zoom * num(d.zoomSpeed, D.zoomSpeed) * dt, Math.max(0.1, zlo), Math.max(zlo, num(d.maxDistance, D.maxDistance)));
      }
    } else if (d.rig === 'rail' && s.railSpeed !== 0) {
      const path = d.path !== undefined ? this.paths.get(d.path) : undefined;
      if (path !== undefined && path.sampled.length > 0) {
        let p = s.progress + (s.railSpeed * s.railDir * dt) / path.sampled.length;
        const mode = d.railMode ?? 'once';
        if (mode === 'loop') p -= Math.floor(p);
        else if (mode === 'pingpong') {
          if (p > 1) {
            p = 2 - p;
            s.railDir = s.railDir === 1 ? -1 : 1;
          } else if (p < 0) {
            p = -p;
            s.railDir = s.railDir === 1 ? -1 : 1;
          }
        }
        s.progress = clampNum(p, 0, 1);
      }
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  /** The target's world position plus the offset into `out` (false: none or not loaded). */
  private targetPoint(s: CamState, world: CameraWorld, out: V3): boolean {
    if (s.target === null) return false;
    if (!world.worldOf(s.target, this.tmpPos, this.tmpRot)) {
      this.warnOnce(`target:${s.id}`, `virtual camera "${s.id}": its target "${s.target}" is not loaded; it centres on itself`);
      return false;
    }
    out[0] = this.tmpPos[0]! + s.targetOffset[0];
    out[1] = this.tmpPos[1]! + s.targetOffset[1];
    out[2] = this.tmpPos[2]! + s.targetOffset[2];
    return true;
  }

  /** The camera entity's own world pose into `pos`/`rot` (false: not loaded). */
  private selfPose(s: CamState, world: CameraWorld, pos: number[], rot: number[]): boolean {
    return world.worldOf(s.id, pos, rot);
  }

  /** Compute the camera's pose for this step from its rig state. */
  evaluate(s: CamState, world: CameraWorld, dt: number): void {
    const d = s.data;
    const pose = s.pose;
    pose.fovY = s.fovY ?? this.baseLens.fovY;
    pose.near = num(d.near, this.baseLens.near);
    pose.far = num(d.far, this.baseLens.far);
    if (!(pose.far > pose.near)) pose.far = pose.near * 1000;
    pose.letterbox = s.letterbox;
    const selfPos = this.selfPos;
    const selfRot = this.selfRot;
    const haveSelf = this.selfPose(s, world, selfPos, selfRot);
    const target = this.targetAt;
    const haveTarget = this.targetPoint(s, world, target);
    if (d.rig === 'fixed') {
      pose.position[0] = selfPos[0]!;
      pose.position[1] = selfPos[1]!;
      pose.position[2] = selfPos[2]!;
      if (haveTarget) lookAtQuat(pose.position, target, selfRot, pose.rotation);
      else for (let k = 0; k < 4; k += 1) pose.rotation[k] = selfRot[k]!;
      return;
    }
    if (d.rig === 'rail') {
      const path = d.path !== undefined ? this.paths.get(d.path) : undefined;
      const origin = this.originPos;
      const originRot = this.originRot;
      if (path === undefined || d.path === undefined || !world.worldOf(d.path, origin, originRot)) {
        this.warnOnce(`path:${s.id}`, `virtual camera "${s.id}": its path "${d.path ?? ''}" is not loaded (or carries no cameraPath); it stays where it is placed`);
        pose.position[0] = selfPos[0]!;
        pose.position[1] = selfPos[1]!;
        pose.position[2] = selfPos[2]!;
        if (haveTarget) lookAtQuat(pose.position, target, selfRot, pose.rotation);
        else for (let k = 0; k < 4; k += 1) pose.rotation[k] = selfRot[k]!;
        return;
      }
      const p = this.pathAt;
      const tan = this.pathTan;
      pointOnPath(path.sampled, s.progress, p, tan);
      pose.position[0] = origin[0]! + p[0];
      pose.position[1] = origin[1]! + p[1];
      pose.position[2] = origin[2]! + p[2];
      if (haveTarget) lookAtQuat(pose.position, target, selfRot, pose.rotation);
      else {
        const k = s.railDir * (s.railSpeed < 0 ? -1 : 1);
        const yp = yawPitchOf(tan[0] * k, tan[1] * k, tan[2] * k);
        if (yp !== null) quatFromYawPitch(yp.yaw, yp.pitch, pose.rotation);
        else for (let j = 0; j < 4; j += 1) pose.rotation[j] = selfRot[j]!;
      }
      return;
    }
    if (d.rig === 'track') {
      this.evaluateTrack(s, haveTarget, target, haveSelf, selfPos, selfRot, world, dt);
      return;
    }
    // follow / orbitPoint / topDown: around a pivot.
    const pivot = this.pivotAt;
    pivot[0] = 0;
    pivot[1] = 0;
    pivot[2] = 0;
    if (d.rig === 'orbitPoint' && s.point !== null) {
      pivot[0] = s.point[0];
      pivot[1] = s.point[1];
      pivot[2] = s.point[2];
    } else if (haveTarget) {
      pivot[0] = target[0];
      pivot[1] = target[1];
      pivot[2] = target[2];
    } else if (haveSelf) {
      pivot[0] = selfPos[0]! + s.targetOffset[0];
      pivot[1] = selfPos[1]! + s.targetOffset[1];
      pivot[2] = selfPos[2]! + s.targetOffset[2];
    }
    const damping = num(d.damping, D.damping);
    if (damping > 0 && s.pivot !== null) {
      const k = 1 - Math.exp(-dt / damping);
      s.pivot[0] += (pivot[0] - s.pivot[0]) * k;
      s.pivot[1] += (pivot[1] - s.pivot[1]) * k;
      s.pivot[2] += (pivot[2] - s.pivot[2]) * k;
    } else s.pivot = [pivot[0], pivot[1], pivot[2]];
    const pv = s.pivot;
    const pitch = d.rig === 'topDown' ? 90 : s.pitch;
    let dist = s.distance;
    const off = orbitOffset(s.yaw, pitch, 1, this.offAt);
    if (d.rig === 'follow' && d.collision !== false && world.raycast !== undefined && dist > 0) {
      const radius = num(d.collisionRadius, D.collisionRadius);
      const hit = world.raycast([pv[0], pv[1], pv[2]], [off[0], off[1], off[2]], dist + radius);
      if (hit !== null && Number.isFinite(hit.distance)) dist = Math.max(Math.min(num(d.minDistance, D.minDistance), dist), Math.min(dist, hit.distance - radius));
    }
    pose.position[0] = pv[0] + off[0] * dist;
    pose.position[1] = pv[1] + off[1] * dist;
    pose.position[2] = pv[2] + off[2] * dist;
    quatFromYawPitch(s.yaw, pitch, pose.rotation);
  }

  /**
   * Phase 24.4g: the track rig — a standalone follow that keeps the camera's
   * placed rotation. The framed point (`pivot`) moves only when the target
   * (plus `targetOffset`) leaves the dead zone around it (per world axis: the
   * point follows the target's overflow past the half size), eased by
   * `damping` (an exponential lag; 0: at once), then kept inside the bounds
   * (per axis, each optional). The camera sits at the framed point plus its
   * offset — authored, else where it was placed relative to the target when
   * it first evaluated (so a camera placed 12 m in front of a character keeps
   * that framing, whatever the depth). Without a target it stays where it is
   * placed.
   *
   * Phase 25.14: with `lookAhead` the dead zone follows a point ahead of the
   * target — its velocity (eased over `lookAheadSmoothing`) times the
   * look-ahead seconds, per axis, capped at `lookAheadMax`. A camera region
   * the target is in replaces the dead zone, the bounds and the distance
   * along the offset; entering or leaving one blends the old settings into
   * the new (eased over the region's blend time: the entered region's, or
   * the left one's when entering none). Bounds blend as the two clamped
   * points, so a bound that appears or goes away moves the view smoothly.
   * Without look-ahead and regions the maths is the 24.4g rig's, bit for bit.
   */
  private evaluateTrack(s: CamState, haveTarget: boolean, target: V3, haveSelf: boolean, selfPos: readonly number[], selfRot: readonly number[], world: CameraWorld, dt: number): void {
    const d = s.data;
    const pose = s.pose;
    for (let k = 0; k < 4; k += 1) pose.rotation[k] = selfRot[k]!;
    if (!haveTarget) {
      pose.position[0] = selfPos[0]!;
      pose.position[1] = selfPos[1]!;
      pose.position[2] = selfPos[2]!;
      return;
    }
    if (s.trackOffset === null) s.trackOffset = haveSelf ? [selfPos[0]! - target[0], selfPos[1]! - target[1], selfPos[2]! - target[2]] : [0, 0, D.distance];
    // Going live (or the first step, or an editor preview): frame the target at once, no blend.
    const going = s.pivot === null;
    // The region the target is in, and the settings in force.
    const rid = this.regions.size > 0 ? this.regionFor(s, target, world) : null;
    if (rid !== s.region) {
      const left = s.region;
      s.region = rid;
      const bt = num((rid !== null ? this.regions.get(rid) : left !== null ? this.regions.get(left) : undefined)?.blendTime, D.blendTime);
      const total = Math.round(Math.max(0, bt) * this.hz);
      s.regionBlend = going || total <= 0 || s.regionParams === null ? null : { from: this.freezeSource(s), steps: 0, total };
    }
    const to = this.trackParams(s, rid, world);
    s.regionParams = to;
    let src: TrackSource = { p: to };
    const rb = s.regionBlend;
    if (rb !== null) {
      rb.steps += 1;
      const t = clampNum(rb.steps / rb.total, 0, 1);
      if (t >= 1) s.regionBlend = null;
      else src = { from: rb.from, to, w: easeInOut(t) };
    }
    // Look-ahead: the point the dead zone follows.
    const aim = this.aimAt;
    aim[0] = target[0];
    aim[1] = target[1];
    aim[2] = target[2];
    const la = d.lookAhead;
    if (Array.isArray(la) && la.length === 3 && (num(la[0], 0) > 0 || num(la[1], 0) > 0 || num(la[2], 0) > 0)) {
      if (going || s.lookLast === null) {
        s.lookLast = [target[0], target[1], target[2]];
        s.lookVel[0] = 0;
        s.lookVel[1] = 0;
        s.lookVel[2] = 0;
      } else {
        const sm = num(d.lookAheadSmoothing, D.lookAheadSmoothing);
        const k = sm > 0 ? 1 - Math.exp(-dt / sm) : 1;
        for (let i = 0; i < 3; i += 1) {
          const raw = (target[i]! - s.lookLast[i]!) / dt;
          s.lookVel[i] = s.lookVel[i]! + (raw - s.lookVel[i]!) * k;
          s.lookLast[i] = target[i]!;
        }
      }
      const mx = d.lookAheadMax;
      for (let i = 0; i < 3; i += 1) {
        const cap = Array.isArray(mx) && mx.length === 3 ? Math.max(0, num(mx[i], D.lookAheadMax)) : D.lookAheadMax;
        aim[i] = target[i]! + clampNum(s.lookVel[i]! * Math.max(0, num(la[i], 0)), -cap, cap);
      }
    } else s.lookLast = null;
    if (going) {
      s.pivot = [this.clampSource(src, aim[0], 0), this.clampSource(src, aim[1], 1), this.clampSource(src, aim[2], 2)];
    } else {
      const damping = num(d.damping, D.damping);
      const k = damping > 0 ? 1 - Math.exp(-dt / damping) : 1;
      const pv = s.pivot!;
      for (let i = 0; i < 3; i += 1) {
        const half = this.halfSource(src, i);
        const off = aim[i]! - pv[i]!;
        const want = off > half ? aim[i]! - half : off < -half ? aim[i]! + half : pv[i]!;
        pv[i] = this.clampSource(src, pv[i]! + (want - pv[i]!) * k, i);
      }
    }
    const o = s.trackOffset;
    const pv = s.pivot!;
    const dist = this.distSource(src, o);
    if (dist === null) {
      pose.position[0] = pv[0]! + o[0];
      pose.position[1] = pv[1]! + o[1];
      pose.position[2] = pv[2]! + o[2];
    } else {
      // Along the offset's direction (straight back along +Z for a camera placed on its target).
      const len = Math.hypot(o[0], o[1], o[2]);
      const u0 = len > 1e-9 ? o[0] / len : 0;
      const u1 = len > 1e-9 ? o[1] / len : 0;
      const u2 = len > 1e-9 ? o[2] / len : 1;
      pose.position[0] = pv[0]! + u0 * dist;
      pose.position[1] = pv[1]! + u1 * dist;
      pose.position[2] = pv[2]! + u2 * dist;
    }
  }

  /**
   * Phase 25.14: the region a track camera's target point is in — among the
   * regions for this camera (or for every track camera), the highest
   * priority, then the one entered last, then the first loaded. Entering is
   * noted per camera, so a region re-entered counts as entered last again.
   */
  private regionFor(s: CamState, target: V3, world: CameraWorld): string | null {
    let best: string | null = null;
    let bestPriority = -Infinity;
    let bestSerial = -1;
    const pos = this.regionPos;
    for (const [id, r] of this.regions) {
      if (r.camera !== undefined && r.camera !== s.id) continue;
      let inside = world.worldOf(id, pos, this.regionRot);
      if (inside) {
        for (let i = 0; i < 3 && inside; i += 1) {
          const size = r.size[i];
          // A region without a depth holds every depth.
          if (i === 2 && typeof size !== 'number') break;
          inside = Math.abs(target[i]! - pos[i]!) <= Math.max(0, num(size, 0)) / 2;
        }
      }
      if (!inside) {
        s.regionEntered.delete(id);
        continue;
      }
      let serial = s.regionEntered.get(id);
      if (serial === undefined) {
        serial = ++this.regionSerial;
        s.regionEntered.set(id, serial);
      }
      const pr = num(r.priority, 0);
      if (pr > bestPriority || (pr === bestPriority && serial > bestSerial)) {
        best = id;
        bestPriority = pr;
        bestSerial = serial;
      }
    }
    for (const id of s.regionEntered.keys()) if (!this.regions.has(id)) s.regionEntered.delete(id);
    return best;
  }

  /** Phase 25.14: the camera's own track settings, with a region's in their place (its bounds from where it is now). */
  private trackParams(s: CamState, rid: string | null, world: CameraWorld): TrackParams {
    const d = s.data;
    const r = rid !== null ? this.regions.get(rid) : undefined;
    if (r === undefined && s.ownParams !== null) return s.ownParams;
    const v3 = (v: readonly number[] | undefined): readonly number[] | null => (Array.isArray(v) && v.length === 3 ? v : null);
    const dz = v3(r?.deadZone) ?? v3(d.deadZone);
    const half: V3 = [0, 0, 0];
    for (let i = 0; i < 3; i += 1) half[i] = dz !== null ? Math.max(0, num(dz[i], 0)) / 2 : 0;
    const lo: V3 = [-Infinity, -Infinity, -Infinity];
    const hi: V3 = [Infinity, Infinity, Infinity];
    const at = this.regionPos;
    const haveAt = r !== undefined && rid !== null && world.worldOf(rid, at, this.regionRot);
    const fill = (out: V3, own: readonly number[] | null, region: readonly number[] | null): void => {
      for (let i = 0; i < 3; i += 1) {
        if (region !== null && haveAt) out[i] = Number.isFinite(region[i]) ? at[i]! + region[i]! : out[i]!;
        else if (own !== null && Number.isFinite(own[i])) out[i] = own[i]!;
      }
    };
    fill(lo, v3(d.boundsMin), v3(r?.boundsMin));
    fill(hi, v3(d.boundsMax), v3(r?.boundsMax));
    const dist = r !== undefined && typeof r.distance === 'number' && Number.isFinite(r.distance) ? Math.max(0.1, r.distance) : null;
    const out = { half, lo, hi, dist };
    if (r === undefined) s.ownParams = out;
    return out;
  }

  /** Phase 25.14: where a new region blend starts — what is in force now (a blend in flight frozen where it is; at most two deep). */
  private freezeSource(s: CamState): TrackSource {
    const rb = s.regionBlend;
    const now = s.regionParams!;
    if (rb === null) return { p: now };
    const w = easeInOut(clampNum(rb.steps / rb.total, 0, 1));
    const from: TrackSource = 'from' in rb.from ? { p: rb.from.to } : rb.from;
    return { from, to: now, w };
  }

  private clampSource(src: TrackSource, v: number, i: number): number {
    if ('p' in src) {
      const a = src.p.lo[i]!;
      const b = src.p.hi[i]!;
      return v < a ? a : v > b ? b : v;
    }
    const x = this.clampSource(src.from, v, i);
    const a = src.to.lo[i]!;
    const b = src.to.hi[i]!;
    const y = v < a ? a : v > b ? b : v;
    return x + (y - x) * src.w;
  }

  private halfSource(src: TrackSource, i: number): number {
    if ('p' in src) return src.p.half[i]!;
    const x = this.halfSource(src.from, i);
    return x + (src.to.half[i]! - x) * src.w;
  }

  /** The distance along the offset (null: the offset itself, as authored or placed). */
  private distSource(src: TrackSource, o: V3): number | null {
    if ('p' in src) return src.p.dist;
    const x = this.distSource(src.from, o);
    const y = src.to.dist;
    if (x === null && y === null) return null;
    const len = Math.hypot(o[0], o[1], o[2]);
    const a = x ?? len;
    return a + ((y ?? len) - a) * src.w;
  }

  /**
   * The pose a camera's rig gives from the world as it is, without input or
   * damping (the editor's frustum preview uses the same maths as Play); null
   * when there is no such camera.
   */
  previewPose(id: string, world: CameraWorld): CameraPose | null {
    const s = this.cams.get(String(id));
    if (s === undefined) return null;
    s.pivot = null;
    this.evaluate(s, world, this.dt);
    return copyPose(s.pose, newPose());
  }

  /** The resolved view between the last two steps (`alpha` 0–1) into `position`/`rotation`; its lens. */
  readInterpolated(alpha: number, position: number[], rotation: number[]): { fovY: number; near: number; far: number; letterbox: number } {
    const a = this.prev;
    const b = this.curr;
    const t = clampNum(alpha, 0, 1);
    for (let k = 0; k < 3; k += 1) position[k] = a.position[k]! + (b.position[k]! - a.position[k]!) * t;
    slerp(a.rotation, b.rotation, t, this.tmpQ);
    for (let k = 0; k < 4; k += 1) rotation[k] = this.tmpQ[k]!;
    const l = this.lensOut;
    l.fovY = a.fovY + (b.fovY - a.fovY) * t;
    l.near = a.near + (b.near - a.near) * t;
    l.far = a.far + (b.far - a.far) * t;
    l.letterbox = a.letterbox + (b.letterbox - a.letterbox) * t;
    return l;
  }

  /** Whether the brain has resolved a view yet (it has stepped once). */
  hasView(): boolean {
    return this.started;
  }

  /** The committed view (observers, digests). */
  view(): CameraViewInfo {
    const c = this.curr;
    const b = this.blend;
    return {
      live: this.liveId,
      blend: b === null ? null : { from: b.fromLive ? b.fromId : null, progress: clampNum(b.steps / b.total, 0, 1), style: b.style },
      position: [c.position[0], c.position[1], c.position[2]],
      rotation: [c.rotation[0], c.rotation[1], c.rotation[2], c.rotation[3]],
      fovY: c.fovY,
      near: c.near,
      far: c.far,
      letterbox: c.letterbox,
      shake: this.lastShake,
      ...this.regionView(),
    };
  }

  /** Phase 25.14: the live track camera's region, while regions are loaded. */
  private regionView(): { region?: string | null } {
    if (this.regions.size === 0 || this.liveId === null) return {};
    const s = this.cams.get(this.liveId);
    return s !== undefined && s.data.rig === 'track' ? { region: s.region } : {};
  }

  /** The viewport the host reported (0 × 0 until it does). */
  viewportSize(): { width: number; height: number; aspect: number } {
    return { width: this.viewport.width, height: this.viewport.height, aspect: this.aspect };
  }
}
