/**
 * The 3D kinematic character controller — the simulation module
 * `thirdlight.character3d:controller` of a project whose `physics_dimension`
 * is 3 (the 2D plane keeps `@thirdlight/character` exactly as it was).
 *
 * Pure fixed-step logic over the injected ports, like the character controller module:
 * in the `controller` phase it turns the step's move vector (its controller's
 * move action: x, y), read relative to the active camera's yaw when a camera
 * provides one and the controller's `moveFrame` is `view`, else world axes; or a script's `control_move` /
 * `character_move` intent) into a velocity (walk or run speed, acceleration
 * and deceleration, less of both in the air), adds gravity and jumps, and
 * stages one move; the 3D port sweeps the capsule with Rapier's kinematic
 * character controller (walls block, slopes steeper than the limit are not
 * climbed, steps up to the step-up height are climbed and the snap walks it
 * down them). A ledge higher than a step (up to `ledgeHeight`) is climbed
 * over `ledgeClimbTime` when enabled: up alongside the wall, then onto the
 * top — only when the top is walkable and the capsule fits there. In the
 * `transform` phase it reads the port's result and turns the character about
 * +Y to face where it moves (its +Z forward, the glTF forward).
 *
 * Every counter is whole steps and every value comes from the simulation
 * (frame, intents, the previous result), so a recorded input run replays the
 * same positions in the page, the simulation worker and the export.
 */
import { CONTROLLER_ACTION_DEFAULTS, character3DSettingsOf, controllerActionsOf, controllerCapsuleOf, controllerCapsuleOffsetZ, controllerMovementOf } from '@thirdlight/project-model';
import { actionAxis, actionPhase } from './actions';

import type { ControllerIntents } from './intents';
import type { CharacterMoveResult3D, PhysicsVec3 } from './ports';
import type { ModuleConfig, RuntimeSnapshot, SimulationModuleSpec, SimulationPhaseModule, StepContext } from './types';

/** The module id (project-model's engine module table names it too). */
export const CHARACTER_3D_MODULE_ID = 'thirdlight.character3d:controller';

/** The name of the input action that switches walking to running while held (a controller's `runAction` default). */
export const RUN_ACTION = CONTROLLER_ACTION_DEFAULTS.runAction;

/** What the controller reports about itself (the runtime's `characterState` reads it). */
export interface Character3DStatus {
  readonly enabled: boolean;
  readonly climbing: boolean;
  /** The climb volume it holds on to (null: none). */
  readonly climbVolume: string | null;
  /** Radians about +Y, 0 facing +Z. */
  readonly yaw: number;
}

interface Climb {
  /** Planned origins: start, the top of the rise, the end on the ledge. */
  readonly from: PhysicsVec3;
  readonly top: PhysicsVec3;
  readonly to: PhysicsVec3;
  readonly steps: number;
  readonly riseSteps: number;
  step: number;
}

const TAU = Math.PI * 2;

/** How far the climb input must be pushed to take hold of a climb volume (the 2D controller's `CLIMB_GRAB_INPUT`). */
const CLIMB_GRAB_INPUT = 0.5;

/** The shortest signed angle from `a` to `b` (radians, in (−π, π]). */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Move the 2D vector `v` toward `t` by at most `maxDelta` (never overshoots). */
function approach2(vx: number, vz: number, tx: number, tz: number, maxDelta: number): [number, number] {
  const dx = tx - vx;
  const dz = tz - vz;
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d === 0) return [tx, tz];
  return [vx + (dx / d) * maxDelta, vz + (dz / d) * maxDelta];
}

/** The yaw (about +Y) of an upright rotation quaternion [x, y, z, w]. */
function yawOf(q: readonly number[]): number {
  const y = q[1] ?? 0;
  const w = q[3] ?? 1;
  return 2 * Math.atan2(y, w);
}

/** Every player controller of the snapshot, in its order (several share a view in local co-op). */
function findControllers(snapshot: RuntimeSnapshot): { id: string; controller: unknown; rotation: readonly number[] }[] {
  const found = snapshot.scene.entities.filter((e) => (e.components as { controller?: unknown }).controller !== undefined);
  if (found.length === 0) throw new Error(`${CHARACTER_3D_MODULE_ID} requires a components.controller entity (found 0)`);
  return found.map((e) => {
    const t = e.components.transform;
    if (t === undefined) throw new Error(`${CHARACTER_3D_MODULE_ID} entity "${e.id}" has no transform component`);
    return { id: e.id, controller: (e.components as { controller?: unknown }).controller, rotation: t.rotation };
  });
}

/** One controller's channels when nothing was asked of it this step. */
const NO_INTENTS: ControllerIntents = Object.freeze({ move: null, jump: null });

/**
 * Build a 3D character controller instance: one controller per player
 * controller of the snapshot, each with its own state, tuning and input
 * actions; a further controller reads its intents under `intents.controllers`.
 */
export function createCharacter3DModule(snapshot: RuntimeSnapshot, cfg: ModuleConfig): SimulationPhaseModule & { character3DStatus(id?: string): Character3DStatus | null } {
  if (cfg.physicsDimension !== 3) throw new Error(`${CHARACTER_3D_MODULE_ID} runs in a 3D project (physics_dimension 3)`);
  if (!(cfg.fixedStepHz > 0) || !Number.isFinite(cfg.fixedStepHz)) throw new Error(`${CHARACTER_3D_MODULE_ID} requires a positive fixedStepHz`);
  const all = findControllers(snapshot).map((found) => createOne(found, cfg));
  return {
    transformOwners: all.map((one) => one.id),
    step(phase, ctx): void {
      all.forEach((one, i) => {
        // A further controller whose object is not in the game (its scene is not loaded) does not move.
        if (i > 0 && !ctx.state.curr.has(one.id)) return;
        const intents = i === 0 ? ctx.intents : (ctx.intents.controllers?.[one.id] ?? NO_INTENTS);
        if (phase === 'controller') one.controllerStep(ctx, intents);
        else if (phase === 'transform') one.transformStep(ctx);
      });
    },
    /**
     * The reset hook. A run restart starts every controller over as it was
     * created, so a restarted run repeats the first start; a placement (a
     * respawn, an arrival) reaches the controller as its `characterPlace`.
     */
    reset(ctx): void {
      if (ctx.characterId === undefined) for (const one of all) one.restart();
    },
    character3DStatus(id?: string): Character3DStatus | null {
      const one = id === undefined ? all[0] : all.find((x) => x.id === id);
      return one?.status() ?? null;
    },
    dispose(): void {
      /* plain data only */
    },
  };
}

/** One player controller of the module: its state between steps, and its controller and transform phases. */
function createOne(
  found: { id: string; controller: unknown; rotation: readonly number[] },
  cfg: ModuleConfig,
): { id: string; controllerStep(ctx: StepContext, intents: ControllerIntents): void; transformStep(ctx: StepContext): void; restart(): void; status(): Character3DStatus } {
  const { id: charId, controller, rotation } = found;
  const hz = cfg.fixedStepHz;
  const dt = 1 / hz;
  const S = character3DSettingsOf(controller, cfg.settings);
  // The input actions it reads (frame version 2 has no fixed channels).
  const names = controllerActionsOf(controller);
  const capsule = controllerCapsuleOf(controller);
  const radius = capsule.radius;
  const halfHeight = Math.max(0, capsule.height / 2 - capsule.radius);
  const offset = { x: capsule.offset[0], y: capsule.offset[1], z: controllerCapsuleOffsetZ(controller) };
  /** From the origin down to the capsule's lowest point. */
  const feetBelowOrigin = halfHeight + radius - offset.y;
  const coyoteSteps = Math.max(0, Math.round(S.coyoteTime * hz));
  const bufferSteps = Math.max(0, Math.round(S.jumpBuffer * hz));
  const climbCos = Math.cos((S.slopeLimit * Math.PI) / 180);
  const turnStep = S.turnSpeed > 0 ? ((S.turnSpeed * Math.PI) / 180) * dt : Infinity;
  const queries = cfg.character3D;
  // Climbing and walls (wall jump away/up absent: the run and jump speeds).
  const M = controllerMovementOf(controller);
  const wallJumpAway = M.wallJumpAway ?? S.runSpeed;
  const wallJumpUp = M.wallJumpUp ?? S.jumpSpeed;
  let climbing: string | null = null;
  /** The last wall touched in the air: its outward normal (horizontal) and the steps it still counts for a wall jump. */
  let wallNormal: { x: number; z: number } | null = null;
  let wallCoyote = 0;
  /** After a wall jump the input does not steer: until the top of the jump, or for `wallJumpLock` (steps left). */
  let wallJumped = false;
  let wallLockSteps = 0;
  const wallLockTotal = M.wallJumpLock === null ? null : Math.round(M.wallJumpLock * hz);

  let vx = 0;
  let vz = 0;
  let vy = 0;
  let yaw = yawOf(rotation);
  let coyote = coyoteSteps;
  let buffer = 0;
  /** Rising from a jump (the release cut applies once). */
  let jumping = false;
  let enabled = true;
  let climb: Climb | null = null;
  let prev: CharacterMoveResult3D | undefined;

  const originOf = (ctx: StepContext): PhysicsVec3 => {
    const t = ctx.state.curr.get(charId);
    return t !== undefined ? { x: t.position[0], y: t.position[1], z: t.position[2] } : { x: 0, y: 0, z: 0 };
  };

  /** A ledge in `dir` (unit, horizontal) the character can climb from `o`, or null. */
  const findLedge = (o: PhysicsVec3, dir: { x: number; z: number }): Climb | null => {
    if (queries === undefined) return null;
    const feetY = o.y - feetBelowOrigin;
    // Probe where the capsule would stand on the ledge: one capsule width ahead of its centre.
    const reach = 2 * radius + S.skin;
    const px = o.x + offset.x + dir.x * reach;
    const pz = o.z + offset.z + dir.z * reach;
    const margin = 0.05;
    const startY = feetY + S.ledgeHeight + margin;
    const hit = queries.raycast({ x: px, y: startY, z: pz }, { x: 0, y: -1, z: 0 }, S.ledgeHeight + margin);
    if (hit === null) return null;
    const h = startY - hit.distance - feetY;
    // Above what a plain step (or the snap) handles, at most the ledge height, and a walkable top.
    if (!(h > Math.max(S.stepHeight, margin)) || h > S.ledgeHeight || hit.distance <= 1e-6) return null;
    if (!(hit.normal.y >= climbCos - 1e-6)) return null;
    const lift = h + 2 * S.skin + 0.01;
    const top = { x: o.x, y: o.y + lift, z: o.z };
    const to = { x: o.x + dir.x * reach, y: o.y + lift, z: o.z + dir.z * reach };
    // Room to rise alongside the wall, and for the whole capsule on top.
    const rise = queries.clearance(top);
    if (rise === null || rise.reason === 'blocked') return null;
    const land = queries.clearance(to);
    if (land === null || !land.ok) return null;
    const steps = Math.max(2, Math.round(S.ledgeClimbTime * hz));
    return { from: o, top, to, steps, riseSteps: Math.max(1, Math.round(steps * 0.6)), step: 0 };
  };

  /** The planned origin of a climb after `k` of its steps. */
  const climbAt = (c: Climb, k: number): PhysicsVec3 => {
    if (k <= c.riseSteps) {
      const f = k / c.riseSteps;
      return { x: c.from.x, y: c.from.y + (c.top.y - c.from.y) * f, z: c.from.z };
    }
    const f = (k - c.riseSteps) / (c.steps - c.riseSteps);
    return { x: c.top.x + (c.to.x - c.top.x) * f, y: c.top.y, z: c.top.z + (c.to.z - c.top.z) * f };
  };

  /** The climb input — the climb action's value (or y), else the move action's y (a script's control_move: its y). */
  const climbInputOf = (ctx: StepContext, intents: ControllerIntents): number => {
    if (M.climbAction === null) return intents.move !== null ? (intents.moveY ?? 0) : actionAxis(ctx.action, names.move)[1];
    const a = ctx.action.actions?.[M.climbAction];
    return a === undefined ? 0 : (a.y ?? a.v);
  };

  const controllerStep = (ctx: StepContext, intents: ControllerIntents): void => {
    if (intents.characterEnabled !== undefined && intents.characterEnabled !== null) enabled = intents.characterEnabled;
    if (intents.characterPlace !== undefined && intents.characterPlace !== null) {
      // The runtime has placed the character: it starts from rest there.
      vx = 0;
      vz = 0;
      vy = 0;
      jumping = false;
      climb = null;
      buffer = 0;
      coyote = 0;
      prev = undefined;
      climbing = null;
      wallNormal = null;
      wallCoyote = 0;
      wallJumped = false;
      wallLockSteps = 0;
    }
    // A placement that faces a spawn's yaw.
    if (typeof intents.characterYaw === 'number' && Number.isFinite(intents.characterYaw)) yaw = intents.characterYaw;
    const o = originOf(ctx);
    if (!enabled) {
      // Switched off: it stays where it is (no input, no gravity); what it stands on still carries it.
      vx = 0;
      vz = 0;
      vy = 0;
      climb = null;
      climbing = null;
      ctx.physics.stageCharacterMove(charId, { x: 0, y: 0, z: 0 } as PhysicsVec3);
      return;
    }
    if (climb !== null) {
      climb.step += 1;
      const target = climbAt(climb, climb.step);
      const done = climb.step >= climb.steps;
      if (done) climb = null;
      ctx.physics.stageCharacterMove(charId, { x: target.x - o.x, y: target.y - o.y, z: target.z - o.z } as PhysicsVec3);
      return;
    }

    // The move: a script's world direction, else the input vector turned by the camera's yaw.
    const action = ctx.action;
    let dx: number;
    let dz: number;
    let run: boolean;
    const cm = intents.characterMove;
    if (cm !== undefined && cm !== null) {
      dx = cm.x;
      dz = cm.z;
      run = cm.run;
    } else {
      const [ax, ay] = actionAxis(action, names.move);
      const mx = intents.move ?? ax;
      const my = intents.move !== null ? (intents.moveY ?? 0) : ay;
      const camYaw = S.moveFrame === 'view' && typeof ctx.cameraYaw === 'number' && Number.isFinite(ctx.cameraYaw) ? ctx.cameraYaw : 0;
      const c = Math.cos(camYaw);
      const s = Math.sin(camYaw);
      // right = (cos, 0, −sin), forward = (−sin, 0, −cos): at yaw 0, x → +X and y → −Z.
      dx = mx * c - my * s;
      dz = -mx * s - my * c;
      const r = action.actions?.[names.run]?.p;
      run = r === 'pressed' || r === 'held';
    }
    // Climbing — inside a climb volume the climb input moves it along the volume's up axis and the
    // move input across it (its part along the volume's across axis), at the climb speed, without gravity; a
    // jump press leaves (with a jump when it can jump), and so does moving out of the volume.
    const vol = ctx.climb?.volume(charId) ?? null;
    const climbY = climbInputOf(ctx, intents);
    const jumpPhase = intents.jump ?? actionPhase(action, names.jump);
    let leapt = false;
    if (climbing !== null && vol === null) climbing = null;
    else if (climbing !== null && jumpPhase === 'pressed') {
      climbing = null;
      vy = S.jump ? S.jumpSpeed : 0;
      jumping = S.jump;
      buffer = 0;
      coyote = 0;
      leapt = true;
    } else if (vol !== null && (climbing !== null || (Math.abs(climbY) >= CLIMB_GRAB_INPUT && !(jumping && vy > 0)))) {
      climbing = vol.id;
      jumping = false;
      buffer = 0;
      coyote = 0;
      wallCoyote = 0;
      const along = Math.max(-1, Math.min(1, climbY));
      const across = Math.max(-1, Math.min(1, dx * vol.across[0] + dz * vol.across[2]));
      vx = (vol.up[0] * along + vol.across[0] * across) * M.climbSpeed;
      vy = (vol.up[1] * along + vol.across[1] * across) * M.climbSpeed;
      vz = (vol.up[2] * along + vol.across[2] * across) * M.climbSpeed;
      ctx.physics.stageCharacterMove(charId, { x: vx * dt, y: vy * dt, z: vz * dt } as PhysicsVec3);
      return;
    }
    const len = Math.hypot(dx, dz);
    const mag = Math.min(1, len);
    const ux = len > 1e-9 ? dx / len : 0;
    const uz = len > 1e-9 ? dz / len : 0;
    const speed = (run ? S.runSpeed : S.walkSpeed) * mag;
    const tx = ux * speed;
    const tz = uz * speed;

    const onGround = prev?.grounded === true;
    const walkable = onGround && prev?.contacts.steepSlope !== true;
    // Acceleration while speeding up along the way it goes, deceleration otherwise; the air takes a share.
    const cur = Math.hypot(vx, vz);
    const speedingUp = speed > 1e-9 && vx * tx + vz * tz >= 0 && speed >= cur;
    const rate = (speedingUp ? S.acceleration : S.deceleration) * (walkable ? 1 : S.airControl);
    // A wall jump keeps its push away from the wall until the top of the jump, or for
    // `wallJumpLock` (a landing ends it either way).
    if (wallJumped) {
      if (walkable || (wallLockTotal === null ? vy <= 0 : wallLockSteps <= 0)) wallJumped = false;
      else if (wallLockTotal !== null) wallLockSteps -= 1;
    }
    if (!wallJumped) [vx, vz] = approach2(vx, vz, tx, tz, rate * dt);

    // The wall it touches in the air (a move the wall took part of; wall slide and wall jump only).
    let wallNow: { x: number; z: number } | null = null;
    if ((M.wallSlide || M.wallJump) && prev !== undefined && !walkable && prev.contacts.wall) {
      const bx = prev.requested.x - prev.applied.x;
      const bz = prev.requested.z - prev.applied.z;
      const b = Math.hypot(bx, bz);
      if (b > 1e-7) wallNow = { x: -bx / b, z: -bz / b };
    }
    if (wallNow !== null) {
      wallNormal = wallNow;
      wallCoyote = coyoteSteps + 1;
    } else if (walkable) wallCoyote = 0;
    else wallCoyote = Math.max(0, wallCoyote - 1);
    // Jumping (the character controller's windows: coyote time after an edge, a buffered press, a release cut).
    const jump = leapt ? 'none' : jumpPhase;
    if (jump === 'pressed') buffer = bufferSteps + 1;
    let jumped = leapt;
    if (leapt) {
      // Left a climb volume with a jump (its speed is set above).
    } else if (S.jump && buffer > 0 && (walkable || coyote > 0) && S.jumpSpeed > 0) {
      vy = S.jumpSpeed;
      jumping = true;
      jumped = true;
      buffer = 0;
      coyote = 0;
    } else if (M.wallJump && buffer > 0 && !walkable && wallCoyote > 0 && wallNormal !== null) {
      // A wall jump — off the wall it touches (or just touched), away from it and up.
      vx = wallNormal.x * wallJumpAway;
      vz = wallNormal.z * wallJumpAway;
      vy = wallJumpUp;
      jumping = true;
      jumped = true;
      buffer = 0;
      coyote = 0;
      wallCoyote = 0;
      wallJumped = true;
      wallLockSteps = wallLockTotal ?? 0;
    } else if (jump === 'released' && jumping && vy > 0) {
      vy *= S.jumpRelease;
      jumping = false;
    }
    if (walkable && !jumped && vy <= 0) {
      vy = 0;
      jumping = false;
    }
    if (!jumped) vy = Math.max(S.maxFallSpeed, vy + S.gravityY * dt);
    // A wall slide — falling in the air while pushing into the wall it touches: no faster than the slide speed.
    if (M.wallSlide && wallNow !== null && tx * wallNow.x + tz * wallNow.z < -1e-9 && vy < -M.wallSlideSpeed) vy = -M.wallSlideSpeed;
    // A slope too steep to stand on slides the character down it (gravity along the surface, its horizontal part).
    if (onGround && !walkable && prev !== undefined) {
      const n = prev.supportNormal;
      const g = -S.gravityY * dt;
      vx += n.y * n.x * g;
      vz += n.y * n.z * g;
    }
    coyote = walkable ? coyoteSteps : Math.max(0, coyote - 1);
    if (buffer > 0) buffer -= 1;
    // scripts' impulses add to the velocity (the acceleration brings it back to the input's; up lifts it off the ground).
    const imp = intents.impulse;
    if (imp !== undefined) {
      vx += imp.x;
      vy += imp.y;
      vz += imp.z;
      if (imp.y > 0) {
        jumping = false;
        coyote = 0;
        buffer = 0;
      }
    }

    // Facing: turn toward the way it is pushed.
    if (S.faceMovement && mag > 1e-3) {
      const want = Math.atan2(ux, uz);
      const d = angleDelta(yaw, want);
      yaw = Math.abs(d) <= turnStep ? want : yaw + Math.sign(d) * turnStep;
      yaw = angleDelta(0, yaw);
    }

    // A ledge: pushing into a wall (the last step blocked the way it goes) with a climbable top ahead.
    if (S.ledgeClimb && mag > 0.1 && prev !== undefined && prev.contacts.wall && !jumped) {
      const wanted = Math.hypot(prev.requested.x, prev.requested.z);
      const got = Math.hypot(prev.applied.x, prev.applied.z);
      if (wanted > 1e-6 && got < wanted * 0.5) {
        const found = findLedge(o, { x: ux, z: uz });
        if (found !== null) {
          climb = found;
          vx = 0;
          vz = 0;
          vy = 0;
          jumping = false;
          climb.step = 1;
          const target = climbAt(climb, 1);
          ctx.physics.stageCharacterMove(charId, { x: target.x - o.x, y: target.y - o.y, z: target.z - o.z } as PhysicsVec3);
          return;
        }
      }
    }
    ctx.physics.stageCharacterMove(charId, { x: vx * dt, y: vy * dt, z: vz * dt } as PhysicsVec3);
  };

  const transformStep = (ctx: StepContext): void => {
    const result = ctx.physics.characterResult(charId) as unknown as CharacterMoveResult3D | undefined;
    if (result !== undefined) {
      prev = result;
      if (climb === null && enabled) {
        // A wall took some of the move: keep only the speed it really had (no speed builds up against a wall).
        if (result.contacts.wall) {
          const ax = result.applied.x / dt;
          const az = result.applied.z / dt;
          if (Math.hypot(ax, az) < Math.hypot(vx, vz)) {
            vx = ax;
            vz = az;
          }
        }
        if (result.contacts.head && vy > 0) {
          vy = 0;
          jumping = false;
        }
      }
    }
    if (S.faceMovement) {
      const t = ctx.state.curr.get(charId);
      if (t !== undefined) {
        const qy = Math.sin(yaw / 2);
        const qw = Math.cos(yaw / 2);
        if (t.rotation[0] !== 0 || t.rotation[1] !== qy || t.rotation[2] !== 0 || t.rotation[3] !== qw) {
          t.rotation[0] = 0;
          t.rotation[1] = qy;
          t.rotation[2] = 0;
          t.rotation[3] = qw;
        }
      }
    }
  };

  /** A run restart: everything as when the module was created (the authored facing, the coyote window full, switched on). */
  const restart = (): void => {
    vx = 0;
    vz = 0;
    vy = 0;
    yaw = yawOf(rotation);
    coyote = coyoteSteps;
    buffer = 0;
    jumping = false;
    enabled = true;
    climb = null;
    prev = undefined;
    climbing = null;
    wallNormal = null;
    wallCoyote = 0;
    wallJumped = false;
    wallLockSteps = 0;
  };

  return {
    id: charId,
    controllerStep,
    transformStep,
    restart,
    status: (): Character3DStatus => ({ enabled, climbing: climb !== null, climbVolume: climbing, yaw }),
  };
}

/** The registered spec: phases controller and transform, every controller entity as its transform owner. */
export const character3DSpec: SimulationModuleSpec = {
  id: CHARACTER_3D_MODULE_ID,
  phases: ['controller', 'transform'],
  excludes: ['thirdlight.demo:box-motion', 'thirdlight.character:controller'],
  requiresPhysicsPort: true,
  create: createCharacter3DModule,
};
