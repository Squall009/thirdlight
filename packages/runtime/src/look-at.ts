/**
 * The animator's look-at constraint (head, optionally neck and chest,
 * turned toward a target after the clip pose — Unity's Animation Rigging
 * multi-aim, Godot's LookAtModifier3D).
 *
 * Angles are measured in the model's own space: yaw about its +Y, pitch
 * about its +X, from its +Z (the glTF front, the character's forward), from
 * the head bone's posed position to the target. The wanted angles are
 * clamped to the sum of the bones' limits, scaled by the weight, and the
 * current angles move toward them at the turn speed (degrees a second, as
 * one step in yaw–pitch space), so a target that jumps, a weight that drops
 * to 0 and a target that goes all turn the head smoothly. The current angles
 * are split over the chain in proportion to each bone's limit (so every bone
 * stays within its own), root first; bone i gets the model-space rotation
 * Q(i)·Q(i−1)⁻¹ where Q(i) = yaw(Σ yaws to i)·pitch(Σ pitches to i), applied
 * about its own pivot on top of its parents', so the head ends turned by
 * exactly yaw(Y)·pitch(P).
 *
 * Simulation state: stepped with the fixed step (a replay turns the head the
 * same way), carried in the pose (`look`) for the renderer and the socket
 * poser to apply after the clips. Pure (no three.js).
 */
import type { Mat4 } from './rig-pose';

export interface LookAtBoneLike {
  readonly bone: string;
  /** Degrees each way. */
  readonly yaw: number;
  readonly pitch: number;
}

export interface LookAtLike {
  readonly head: LookAtBoneLike;
  readonly neck?: LookAtBoneLike;
  readonly chest?: LookAtBoneLike;
  /** An entity to look at (its origin). */
  readonly target?: string;
  /** A world point to look at (when there is no target entity). */
  readonly point?: readonly number[];
  readonly weight?: number;
  readonly weightParameter?: string;
  /** Degrees a second. */
  readonly turnSpeed?: number;
}

/** One bone's turn: a model-space rotation applied about the bone's pivot, after its parents'. */
export interface LookBonePose {
  readonly node: string;
  readonly rotation: readonly [number, number, number, number];
}

/** The constraint's part of a pose: the current angles (degrees) and the bones' turns, root first. */
export interface LookPose {
  readonly yaw: number;
  readonly pitch: number;
  readonly bones: readonly LookBonePose[];
}

const DEG = Math.PI / 180;

/** yaw about +Y then pitch (up positive: about −X) as a quaternion [x, y, z, w]. */
export function yawPitchQuat(yawDeg: number, pitchDeg: number): [number, number, number, number] {
  const hy = (yawDeg * DEG) / 2;
  const hp = (-pitchDeg * DEG) / 2;
  const cy = Math.cos(hy), sy = Math.sin(hy), cp = Math.cos(hp), sp = Math.sin(hp);
  // q = qy · qx, qy = (0, sy, 0, cy), qx = (sp, 0, 0, cp).
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}

/** a · b (quaternions [x, y, z, w]). */
export function quatMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, aw = a[3]!;
  const bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!;
  return [ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz];
}

export const quatConj = (q: readonly number[]): [number, number, number, number] => [-q[0]!, -q[1]!, -q[2]!, q[3]!];

/** The chain, root first (chest, neck, head — the ones present). */
export function lookChain(c: LookAtLike): LookAtBoneLike[] {
  return [c.chest, c.neck, c.head].filter((b): b is LookAtBoneLike => b !== undefined);
}

/** One animator's look-at state: the current angles and what scripts set. */
export class LookAtState {
  yaw = 0;
  pitch = 0;
  /** A script's target (undefined: the authored one; null: none). */
  target: string | readonly [number, number, number] | null | undefined = undefined;
  /** A script's weight (undefined: the authored one). */
  weight: number | undefined = undefined;

  constructor(readonly config: LookAtLike) {}

  /** The total limits of the chain (degrees). */
  limits(): { yaw: number; pitch: number } {
    let yaw = 0;
    let pitch = 0;
    for (const b of lookChain(this.config)) {
      yaw += b.yaw;
      pitch += b.pitch;
    }
    return { yaw, pitch };
  }

  /**
   * One step: `wanted` the angles toward the target (degrees, model space;
   * null: nothing to look at), `weight` 0–1, `dt` seconds.
   */
  step(wanted: { yaw: number; pitch: number } | null, weight: number, dt: number): void {
    const lim = this.limits();
    const w = wanted === null ? 0 : Math.min(1, Math.max(0, weight));
    const gy = w === 0 ? 0 : Math.min(lim.yaw, Math.max(-lim.yaw, wanted!.yaw)) * w;
    const gp = w === 0 ? 0 : Math.min(lim.pitch, Math.max(-lim.pitch, wanted!.pitch)) * w;
    const dy = gy - this.yaw;
    const dp = gp - this.pitch;
    const dist = Math.hypot(dy, dp);
    const max = (this.config.turnSpeed ?? LOOK_TURN_SPEED_DEFAULT) * dt;
    if (dist <= max || dist === 0) {
      this.yaw = gy;
      this.pitch = gp;
    } else {
      this.yaw += (dy / dist) * max;
      this.pitch += (dp / dist) * max;
    }
  }

  /** The pose part (null while the head is straight). */
  pose(): LookPose | null {
    if (this.yaw === 0 && this.pitch === 0) return null;
    const chain = lookChain(this.config);
    const lim = this.limits();
    let cy = 0;
    let cp = 0;
    let prev: [number, number, number, number] = [0, 0, 0, 1];
    const bones: LookBonePose[] = [];
    for (const b of chain) {
      cy += lim.yaw > 0 ? (this.yaw * b.yaw) / lim.yaw : 0;
      cp += lim.pitch > 0 ? (this.pitch * b.pitch) / lim.pitch : 0;
      const q = yawPitchQuat(cy, cp);
      bones.push({ node: b.bone, rotation: quatMul(q, quatConj(prev)) });
      prev = q;
    }
    return { yaw: this.yaw, pitch: this.pitch, bones };
  }
}

/** The turn speed when none is authored (degrees a second): a quick, natural head turn. */
export const LOOK_TURN_SPEED_DEFAULT = 360;

/**
 * The angles from `from` (model space) toward `to` (model space): yaw about
 * +Y from +Z, pitch up from the horizontal (degrees); null when they meet.
 */
export function anglesToward(from: readonly number[], to: readonly number[]): { yaw: number; pitch: number } | null {
  const dx = to[0]! - from[0]!, dy = to[1]! - from[1]!, dz = to[2]! - from[2]!;
  const h = Math.hypot(dx, dz);
  if (h + Math.abs(dy) < 1e-9) return null;
  return { yaw: Math.atan2(dx, dz) / DEG, pitch: Math.atan2(dy, h) / DEG };
}

/** p := m · p (a point). */
export function transformPoint(m: Mat4, p: readonly number[]): [number, number, number] {
  const x = p[0]!, y = p[1]!, z = p[2]!;
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}
