/**
 * The arcade movement profile of the character controller: the rules of
 * the side-view controller 2D projects had, free in 3D or locked to a plane.
 *
 * The rules are that controller's, in its order, so a character upgraded
 * from a 2D project keeps its feel (its tuning fields mean what they meant
 * there):
 * - one jump per press from the ground or inside the coyote window, a press
 *   buffered until it lands, and releasing jump while rising keeps
 *   `jumpRelease` of the upward speed and ends the rise (no second cut);
 * - grounded means a support no steeper than the slope limit; a character at
 *   rest on a slope steeper than the slide angle slides down it at the run
 *   speed (the port never slides a resting character by itself);
 * - one speed (the run speed), reached at `acceleration` while the velocity
 *   is below the target along an axis and left at `deceleration` above it,
 *   on the ground and in the air alike, arriving exactly;
 * - a wall it pushes into in the air holds its fall to the wall slide speed,
 *   a jump there pushes it off (wall jump), and the push away is not steered
 *   until the top of the jump (or `wallJumpLock`);
 * - in a climb volume the climb input moves it along the volume and the move
 *   input across it, without gravity, until it jumps off or leaves.
 * The horizontal rule works per world axis (+X, and −Z: right on an X
 * plane), so the same character on a Z plane and on an X plane moves alike.
 * Steps are climbed by the port's autostep (`autostep`) by the arcade rule
 * (`autostepRide`: it rides up over the edge, losing speed), and one-way
 * platforms, drop-through and what it stands on carrying it are the
 * runtime's and the port's, as for every controller.
 */
import { character3DSettingsOf, controllerActionsOf, controllerMovementOf } from '@thirdlight/project-model';

import { actionPhase } from './actions';
import { CLIMB_GRAB_INPUT, climbInputOf, moveOf, turnToward, writeFacing, yawOf, type ControllerOne } from './character-moves';

import type { ControllerIntents } from './intents';
import type { CharacterMoveResult3D, PhysicsVec3 } from './ports';
import type { ModuleConfig, StepContext } from './types';

/** The tolerance of the grounding and slide tests (a support normal against an angle's cosine). */
const NORMAL_TOLERANCE = 1e-6;

/** Move `v` toward `target` by `up` while below it and `down` while above it, never past it. */
export function approachAxis(v: number, target: number, up: number, down: number): number {
  if (Math.abs(target - v) <= 1e-9) return target;
  if (v < target) return Math.min(target, v + up);
  return Math.max(target, v - down);
}

/** The in-plane "right" of a plane (x, z): +X on a Z plane, −Z on an X plane; null: free. */
function rightOf(plane: { readonly axis: 'x' | 'z' } | null): { x: number; z: number } | null {
  if (plane === null) return null;
  return plane.axis === 'z' ? { x: 1, z: 0 } : { x: 0, z: -1 };
}

/**
 * The downhill direction (x, z) a character at rest slides on a slope
 * steeper than the slide angle, or null. A support normal at or below the
 * slide angle's cosine, or a ground-snap correction that dropped it at least
 * the slide angle's slope over the way it moved (a flat support's snap
 * carries only rounding, so it never fires there).
 */
export function slideDirection3D(p: CharacterMoveResult3D | undefined, cosSlide: number, tanSlide: number): { x: number; z: number } | null {
  if (p === undefined || !p.grounded) return null;
  const n = p.supportNormal;
  const steep = n.y < cosSlide + NORMAL_TOLERANCE;
  const drop = p.requested.y - p.applied.y;
  const moved = Math.hypot(p.applied.x, p.applied.z);
  const descending = p.snapped && drop > 1e-6 && moved > 1e-9 && drop >= moved * tanSlide - NORMAL_TOLERANCE;
  if (!steep && !descending) return null;
  const h = Math.hypot(n.x, n.z);
  if (h > 0) return { x: n.x / h, z: n.z / h };
  if (moved > 0) return { x: p.applied.x / moved, z: p.applied.z / moved };
  return null;
}

/** One player controller of the arcade profile. */
export function createArcadeOne(found: { id: string; controller: unknown; rotation: readonly number[] }, cfg: ModuleConfig): ControllerOne {
  const { id: charId, controller, rotation } = found;
  const hz = cfg.fixedStepHz;
  const dt = 1 / hz;
  const S = character3DSettingsOf(controller, cfg.settings);
  const M = controllerMovementOf(controller);
  const names = controllerActionsOf(controller);
  const coyoteSteps = Math.max(0, Math.round(S.coyoteTime * hz));
  const bufferSteps = Math.max(0, Math.round(S.jumpBuffer * hz));
  const cosClimb = Math.cos((S.slopeLimit * Math.PI) / 180);
  const slideRad = (cfg.settings.min_slope_slide_deg * Math.PI) / 180;
  const cosSlide = Math.cos(slideRad);
  const tanSlide = Math.tan(slideRad);
  const turnStep = S.turnSpeed > 0 ? ((S.turnSpeed * Math.PI) / 180) * dt : Infinity;
  const wallJumpAway = M.wallJumpAway ?? S.runSpeed;
  const wallJumpUp = M.wallJumpUp ?? S.jumpSpeed;
  const up = S.acceleration * dt;
  const down = S.deceleration * dt;

  let vx = 0;
  let vy = 0;
  let vz = 0;
  /** Between a jump start and its landing or release. */
  let airborne = false;
  let coyote = coyoteSteps;
  let buffer = 0;
  /** This step started a jump (a consumed press is not counted down). */
  let jumpStarted = false;
  let prev: CharacterMoveResult3D | undefined;
  let climbing: string | null = null;
  /** The outward normal (x, z) of the wall it last touched in the air, and the steps that touch still counts for a wall jump. */
  let wallNormal: { x: number; z: number } | null = null;
  let wallCoyote = 0;
  let wallJumped = false;
  let wallLockSteps = 0;
  let enabled = true;
  let yaw = yawOf(rotation);

  /** From rest, with nothing left of an earlier step (a placement; a restart then refills the coyote window). */
  const rest = (): void => {
    vx = 0;
    vy = 0;
    vz = 0;
    airborne = false;
    coyote = 0;
    buffer = 0;
    jumpStarted = false;
    prev = undefined;
    climbing = null;
    wallNormal = null;
    wallCoyote = 0;
    wallJumped = false;
    wallLockSteps = 0;
  };

  /**
   * Stage the step's move. Free in 3D, resting on the ground it still presses
   * down by one step of gravity (its velocity stays 0), as the character
   * profile does: without it a free character running on flat ground sank
   * 3.7 cm into the floor (measured). On a plane the port holds it on the
   * ground without one, and the press would pull it down a ledge's edge or a
   * stair's riser earlier than the arcade rules do (measured: up to
   * 0.9 m apart on a stair), so there it stages none.
   */
  const stage = (ctx: StepContext, right: { x: number; z: number } | null, resting = false): void => {
    // On a plane no speed is kept along its normal (none is left for when it is freed).
    if (right !== null && right.x === 0) vx = 0;
    else if (right !== null && right.z === 0) vz = 0;
    const y = resting && vy === 0 ? S.gravityY * dt : vy;
    ctx.physics.stageCharacterMove(charId, { x: vx * dt, y: y * dt, z: vz * dt } as PhysicsVec3);
  };

  const controllerStep = (ctx: StepContext, intents: ControllerIntents): void => {
    if (intents.characterEnabled !== undefined && intents.characterEnabled !== null) enabled = intents.characterEnabled;
    if (intents.characterPlace !== undefined && intents.characterPlace !== null) rest();
    if (typeof intents.characterYaw === 'number' && Number.isFinite(intents.characterYaw)) yaw = intents.characterYaw;
    if (!enabled) {
      // Switched off: it stays where it is (no input, no gravity); what it stands on still carries it.
      vx = 0;
      vy = 0;
      vz = 0;
      climbing = null;
      ctx.physics.stageCharacterMove(charId, { x: 0, y: 0, z: 0 } as PhysicsVec3);
      return;
    }
    const right = rightOf(ctx.physics.planeOf?.(charId) ?? null);
    // The input direction (x, z): on a plane the move input's x along the plane's right, else the move turned by the camera or the world axes.
    const move = moveOf(ctx, intents, names, S.moveFrame);
    let ix: number;
    let iz: number;
    if (right !== null) {
      const cm = intents.characterMove;
      const along = cm !== undefined && cm !== null ? cm.x * right.x + cm.z * right.z : move.inputX;
      ix = along * right.x;
      iz = along * right.z;
    } else {
      const len = Math.hypot(move.dx, move.dz);
      const k = len > 1 ? 1 / len : 1;
      ix = move.dx * k;
      iz = move.dz * k;
    }
    const p = prev;
    const groundedPrev = p !== undefined && p.grounded && p.supportNormal.y >= cosClimb - NORMAL_TOLERANCE;
    const jump = intents.jump ?? actionPhase(ctx.action, names.jump);

    // Climbing: inside a climb volume up/down (and across) move it at the climb speed without gravity;
    // a jump press leaves with a jump, and so does moving out of the volume (it keeps its speed and falls).
    const vol = ctx.climb?.volume(charId) ?? null;
    const climbY = climbInputOf(ctx, intents, names.move, M.climbAction);
    let leapt = false;
    if (climbing !== null && vol === null) climbing = null;
    else if (climbing !== null && jump === 'pressed') {
      climbing = null;
      vy = S.jumpSpeed;
      airborne = true;
      buffer = 0;
      coyote = 0;
      leapt = true;
    }
    if (vol !== null && !leapt && (climbing !== null || (Math.abs(climbY) >= CLIMB_GRAB_INPUT && !(airborne && vy > 0)))) {
      if (climbing === null) airborne = false;
      climbing = vol.id;
      const along = Math.max(-1, Math.min(1, climbY));
      const across = Math.max(-1, Math.min(1, ix * vol.across[0] + iz * vol.across[2]));
      vx = (vol.up[0] * along + vol.across[0] * across) * M.climbSpeed;
      vy = (vol.up[1] * along + vol.across[1] * across) * M.climbSpeed;
      vz = (vol.up[2] * along + vol.across[2] * across) * M.climbSpeed;
      buffer = 0;
      coyote = 0;
      jumpStarted = false;
      wallCoyote = 0;
      stage(ctx, right);
      return;
    }

    // The wall it pushes into in the air (wall slide and wall jump only; a touch counts for the coyote window).
    let wallNow: { x: number; z: number } | null = null;
    if (M.wallSlide || M.wallJump) {
      if (p !== undefined && !groundedPrev && p.contacts.wall && Math.hypot(p.requested.x, p.requested.z) - Math.hypot(p.applied.x, p.applied.z) > 1e-7) {
        const bx = p.requested.x - p.applied.x;
        const bz = p.requested.z - p.applied.z;
        const b = Math.hypot(bx, bz);
        if (b > 1e-12) wallNow = { x: -bx / b, z: -bz / b };
      }
      if (wallNow !== null) {
        wallNormal = wallNow;
        wallCoyote = coyoteSteps + 1;
      } else if (groundedPrev) wallCoyote = 0;
      else wallCoyote = Math.max(0, wallCoyote - 1);
    }

    if (leapt) jumpStarted = true;
    else {
      // A press refreshes the buffer; a grounded step refreshes the coyote window; one jump per press, never in the air.
      if (jump === 'pressed') buffer = bufferSteps;
      if (groundedPrev) coyote = coyoteSteps;
      if (S.jump && buffer > 0 && (groundedPrev || coyote > 0) && !airborne) {
        vy = S.jumpSpeed;
        airborne = true;
        buffer = 0;
        coyote = 0;
        jumpStarted = true;
      } else if (M.wallJump && buffer > 0 && !groundedPrev && wallCoyote > 0 && wallNormal !== null) {
        // A wall jump: off the wall it touches (or just touched), away from it and up.
        vx = wallNormal.x * wallJumpAway;
        vz = wallNormal.z * wallJumpAway;
        vy = wallJumpUp;
        airborne = true;
        buffer = 0;
        coyote = 0;
        wallCoyote = 0;
        wallJumped = true;
        wallLockSteps = M.wallJumpLock === null ? 0 : Math.round(M.wallJumpLock / dt);
        jumpStarted = true;
      } else jumpStarted = false;
    }
    // A script's impulse adds to the velocity (up lifts it into an airborne arc).
    const imp = intents.impulse;
    if (imp !== undefined) {
      vx += imp.x;
      vz += imp.z;
      if (imp.y !== 0) {
        vy = (airborne || !groundedPrev ? vy : 0) + imp.y;
        if (imp.y > 0) {
          airborne = true;
          buffer = 0;
          coyote = 0;
        }
      }
    }
    // Lifted by what it touches (a rising mover under its edge), its fall was taken out of the last
    // move (the runtime cancels it): it rests on it as on the ground, so it leaves the mover from rest
    // (the side-view controller's rule: the mover's push held it grounded there).
    const lifted = !groundedPrev && !airborne && p !== undefined && p.grounded && p.requested.y > 0 && vy <= 0;
    // Resting on the ground, or falling under gravity (no faster than the fall cap).
    if ((groundedPrev || lifted) && !airborne) vy = 0;
    else vy = Math.max(vy + S.gravityY * dt, S.maxFallSpeed);
    // A wall slide: falling while pushing into the wall it touches, no faster than the slide speed.
    if (M.wallSlide && wallNow !== null && ix * wallNow.x + iz * wallNow.z < -1e-9 && vy < -M.wallSlideSpeed) vy = -M.wallSlideSpeed;
    // A head bump stops the rise.
    if (p !== undefined && p.contacts.head && vy > 0) vy = 0;
    // Releasing jump while rising cuts the upward speed once and ends the jump.
    if (jump === 'released' && airborne) {
      if (vy > 0) vy *= S.jumpRelease;
      airborne = false;
    }
    if (airborne && groundedPrev && vy <= 0) airborne = false;
    if (wallJumped) {
      const landed = groundedPrev && !jumpStarted;
      if (landed || (M.wallJumpLock === null ? vy <= 0 : wallLockSteps <= 0)) wallJumped = false;
      else if (M.wallJumpLock !== null) wallLockSteps -= 1;
    }
    // The run (or, at rest on a slope steeper than the slide angle, a slide down it).
    let tx = ix * S.runSpeed;
    let tz = iz * S.runSpeed;
    if (groundedPrev && !airborne && ix === 0 && iz === 0) {
      const slide = slideDirection3D(p, cosSlide, tanSlide);
      if (slide !== null) {
        tx = slide.x * S.runSpeed;
        tz = slide.z * S.runSpeed;
      }
    }
    if (!wallJumped) {
      vx = approachAxis(vx, tx, up, down);
      vz = -approachAxis(-vz, -tz, up, down);
    }
    if (S.faceMovement && Math.hypot(ix, iz) > 1e-3) yaw = turnToward(yaw, ix, iz, turnStep);
    stage(ctx, right, right === null && groundedPrev && !airborne);
    if (!groundedPrev) coyote = Math.max(0, coyote - 1);
    if (!jumpStarted) buffer = Math.max(0, buffer - 1);
  };

  return {
    id: charId,
    controllerStep,
    transformStep(ctx: StepContext): void {
      const result = ctx.physics.characterResult(charId) as unknown as CharacterMoveResult3D | undefined;
      if (result !== undefined) prev = result;
      if (S.faceMovement) writeFacing(ctx, charId, yaw);
    },
    restart(): void {
      rest();
      coyote = coyoteSteps;
      enabled = true;
      yaw = yawOf(rotation);
    },
    status: () => ({ enabled, climbing: climbing !== null, climbVolume: climbing, yaw }),
  };
}
