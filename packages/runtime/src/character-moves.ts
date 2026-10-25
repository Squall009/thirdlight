/**
 * What the 3D controller's movement profiles share: the move input turned
 * into a world direction, the climb input, facing, and the one controller
 * interface the module drives (each profile is its own step logic behind it).
 */
import { actionAxis } from './actions';

import type { ControllerIntents } from './intents';
import type { PhysicsVec3 } from './ports';
import type { StepContext } from './types';

/** What the controller reports about itself (the runtime's `characterState` reads it). */
export interface Character3DStatus {
  readonly enabled: boolean;
  readonly climbing: boolean;
  /** The climb volume it holds on to (null: none). */
  readonly climbVolume: string | null;
  /** Radians about +Y, 0 facing +Z. */
  readonly yaw: number;
}

/** One player controller of the module: its controller and transform phases, a run restart, its status. */
export interface ControllerOne {
  readonly id: string;
  controllerStep(ctx: StepContext, intents: ControllerIntents): void;
  transformStep(ctx: StepContext): void;
  restart(): void;
  status(): Character3DStatus;
}

const TAU = Math.PI * 2;

/** How far the climb input must be pushed to take hold of a climb volume (a stick's resting drift or a mostly sideways push does not grab). */
export const CLIMB_GRAB_INPUT = 0.5;

/** The shortest signed angle from `a` to `b` (radians, in (−π, π]). */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** The yaw (about +Y) of an upright rotation quaternion [x, y, z, w]. */
export function yawOf(q: readonly number[]): number {
  const y = q[1] ?? 0;
  const w = q[3] ?? 1;
  return 2 * Math.atan2(y, w);
}

/** Turn `yaw` toward the direction (ux, uz) by at most `turnStep` radians. */
export function turnToward(yaw: number, ux: number, uz: number, turnStep: number): number {
  const want = Math.atan2(ux, uz);
  const d = angleDelta(yaw, want);
  return angleDelta(0, Math.abs(d) <= turnStep ? want : yaw + Math.sign(d) * turnStep);
}

/** Write the facing `yaw` into the character's committed rotation (about +Y only). */
export function writeFacing(ctx: StepContext, charId: string, yaw: number): void {
  const t = ctx.state.curr.get(charId);
  if (t === undefined) return;
  const qy = Math.sin(yaw / 2);
  const qw = Math.cos(yaw / 2);
  if (t.rotation[0] !== 0 || t.rotation[1] !== qy || t.rotation[2] !== 0 || t.rotation[3] !== qw) {
    t.rotation[0] = 0;
    t.rotation[1] = qy;
    t.rotation[2] = 0;
    t.rotation[3] = qw;
  }
}

/** The character's committed origin (the origin of the world before its first step). */
export function originOf(ctx: StepContext, charId: string): PhysicsVec3 {
  const t = ctx.state.curr.get(charId);
  return t !== undefined ? { x: t.position[0], y: t.position[1], z: t.position[2] } : { x: 0, y: 0, z: 0 };
}

/**
 * The step's move as a world direction (x, z; length up to 1 for a full push)
 * and whether it runs: a script's `character_move` direction, else the move
 * input (a `control_move` intent, else the move action) turned by the live
 * camera's yaw when the move frame is `view`, else along the world axes.
 */
export function moveOf(ctx: StepContext, intents: ControllerIntents, names: { readonly move: string; readonly run: string }, moveFrame: 'view' | 'world'): { dx: number; dz: number; run: boolean; inputX: number } {
  const cm = intents.characterMove;
  if (cm !== undefined && cm !== null) return { dx: cm.x, dz: cm.z, run: cm.run, inputX: cm.x };
  const [ax, ay] = actionAxis(ctx.action, names.move);
  const mx = intents.move ?? ax;
  const my = intents.move !== null ? (intents.moveY ?? 0) : ay;
  const camYaw = moveFrame === 'view' && typeof ctx.cameraYaw === 'number' && Number.isFinite(ctx.cameraYaw) ? ctx.cameraYaw : 0;
  const c = Math.cos(camYaw);
  const s = Math.sin(camYaw);
  const r = ctx.action.actions?.[names.run]?.p;
  // right = (cos, 0, −sin), forward = (−sin, 0, −cos): at yaw 0, x → +X and y → −Z.
  return { dx: mx * c - my * s, dz: -mx * s - my * c, run: r === 'pressed' || r === 'held', inputX: mx };
}

/** The climb input — the climb action's value (or y), else the move action's y (a script's control_move: its y). */
export function climbInputOf(ctx: StepContext, intents: ControllerIntents, move: string, climbAction: string | null): number {
  // A cutscene's hold (or a walk) keeps the player's climb input from the character too.
  if (intents.inputHeld === true) return 0;
  if (climbAction === null) return intents.move !== null ? (intents.moveY ?? 0) : actionAxis(ctx.action, move)[1];
  const a = ctx.action.actions?.[climbAction];
  return a === undefined ? 0 : (a.y ?? a.v);
}
