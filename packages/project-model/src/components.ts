/**
 * Component-level validators shared by the v3/v4 scene and content models
 * (model, behavior, prefab provenance, collider/controller and their physics
 * transform rules; the transform/box/camera field rules).
 *
 * Pure and total: same input → same result, never throws, never reads files.
 */
import { ID_RE } from './validate';

import {
  checkFiniteNumber,
  checkQuaternion,
  checkVector,
  canonicalTransform,
  fieldMissing,
  fieldType,
  fieldValue,
  idInvalid,
  isPlainObject,
  isValidName,
  MAX_LEN,
  pointerSegment,
  unexpectedField,
  withFound,
} from './validate';
import type { ModelErrorV2 } from './errors';
import { MAX_COLLIDER_EXTENT, colliderShapeParts, limitsError, validateColliderShape } from './collider-shapes';

export { COLLIDER_3D_LIMITS, COLLIDER_3D_SHAPES, CONVEX_TOL, MAX_COLLIDER_EXTENT, MAX_POLYGON_VERTICES, MIN_POLYGON_AREA, canonicalCollider, canonicalShape, colliderShapeParts, colliderShapePoints, COLLIDER_PRIMITIVE_TYPES, COLLIDER_SHAPE_TYPES } from './collider-shapes';
import type { ColliderShape, ControllerComponent, TransformComponent } from './types-v2';
import { validateLightLayerMask } from './light-layers';

export const ID_RE_V2 = ID_RE;
export const PROPERTY_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const MAX_ENTITIES_V2 = 1024;

const KNOWN_MODEL_FIELDS = new Set(['asset', 'piece', 'castShadow', 'receiveShadow', 'lightLayers']);
const KNOWN_MODEL_ASSET_FIELDS = new Set(['assetId']);
const KNOWN_BEHAVIOR_FIELDS = new Set(['behaviorId', 'values']);
const KNOWN_PREFAB_FIELDS = new Set(['prefabId', 'localId']);
const KNOWN_COLLIDER_FIELDS = new Set(['shape']);

const KNOWN_TRANSFORM_FIELDS = new Set(['position', 'rotation', 'scale']);
const KNOWN_BOX_FIELDS = new Set(['size', 'material', 'castShadow', 'receiveShadow', 'lightLayers']);
const KNOWN_MATERIAL_FIELDS = new Set(['color']);
const KNOWN_CAMERA_FIELDS = new Set(['type', 'fovY', 'near', 'far']);

// ---- small helpers -----------------------------------------------------------


function isPropertyValueShape(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean' || typeof v === 'string') return true;
  if (Array.isArray(v)) {
    return v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  }
  return false;
}

// ---- components --------------------------------------------------------------

export function validateModelComponent(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const asset = c['asset'];
  if (asset === undefined) {
    errors.push(fieldMissing(`${path}/asset`, 'asset'));
  } else if (!isPlainObject(asset)) {
    errors.push(fieldType(`${path}/asset`, asset, 'object'));
  } else {
    const assetId = asset['assetId'];
    if (assetId === undefined) {
      errors.push(fieldMissing(`${path}/asset/assetId`, 'assetId'));
    } else if (typeof assetId !== 'string') {
      errors.push(fieldType(`${path}/asset/assetId`, assetId, 'string'));
    } else if (!ID_RE_V2.test(assetId)) {
      errors.push(idInvalid(`${path}/asset/assetId`, assetId));
    }
    for (const k of Object.keys(asset)) {
      if (!KNOWN_MODEL_ASSET_FIELDS.has(k)) {
        errors.push(unexpectedField(`${path}/asset/${pointerSegment(k)}`, k, 'assetId'));
      }
    }
  }
  validateModelPiece(c['piece'], `${path}/piece`, errors);
  validateShadowFlags(c, path, errors);
  for (const k of Object.keys(c)) {
    if (!KNOWN_MODEL_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'asset, piece, castShadow, receiveShadow, lightLayers'));
  }
}

/**
 * Optional `castShadow` / `receiveShadow` booleans of a visible
 * object (box, model, instance set). Absent = true: solid geometry blocks the
 * light and shows the shadows falling on it in any genre; a decal, a glow or a
 * distant backdrop turns them off.
 */
export function validateShadowFlags(c: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  for (const k of ['castShadow', 'receiveShadow'] as const) {
    if (c[k] !== undefined && typeof c[k] !== 'boolean') errors.push(fieldType(`${path}/${k}`, c[k], 'boolean'));
  }
  // The light layers it is in (light-layers.ts; absent: every layer).
  validateLightLayerMask(c['lightLayers'], `${path}/lightLayers`, errors, 1);
}

/**
 * Optional `piece`: one named piece of a multi-piece GLB (the base name of its
 * `<piece>_LOD<n>`/`<piece>_COL` nodes, or a top-level node name). Absent =
 * the whole file.
 */
export function validateModelPiece(piece: unknown, path: string, errors: ModelErrorV2[]): void {
  if (piece === undefined) return;
  if (typeof piece !== 'string') errors.push(fieldType(path, piece, 'string'));
  else if (!isValidName(piece)) {
    errors.push(fieldValue(path, piece, 'string, 1-128 chars, no control characters', 'piece must be 1-128 characters without control characters'));
  }
}

export function validateBehaviorComponent(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const behaviorId = c['behaviorId'];
  if (behaviorId === undefined) {
    errors.push(fieldMissing(`${path}/behaviorId`, 'behaviorId'));
  } else if (typeof behaviorId !== 'string') {
    errors.push(fieldType(`${path}/behaviorId`, behaviorId, 'string'));
  } else if (!ID_RE_V2.test(behaviorId)) {
    errors.push(idInvalid(`${path}/behaviorId`, behaviorId));
  }
  const values = c['values'];
  if (values === undefined) {
    errors.push(fieldMissing(`${path}/values`, 'values'));
  } else if (!isPlainObject(values)) {
    errors.push(fieldType(`${path}/values`, values, 'object'));
  } else {
    for (const k of Object.keys(values)) {
      if (!PROPERTY_KEY_RE.test(k)) {
        errors.push(
          fieldValue(
            `${path}/values/${pointerSegment(k)}`,
            k,
            'property key ^[a-z][a-z0-9_]{0,63}$',
            'behavior property keys must match the declared key syntax',
          ),
        );
      }
      const v = values[k];
      if (!isPropertyValueShape(v)) {
        errors.push(
          fieldValue(
            `${path}/values/${pointerSegment(k)}`,
            v,
            'number | boolean | string | [number, number, number] | null',
            'behavior property value does not match the seven-type value vocabulary',
          ),
        );
      }
    }
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_BEHAVIOR_FIELDS.has(k)) {
      errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'behaviorId, values'));
    }
  }
}

export function validatePrefabProvenance(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  for (const field of ['prefabId', 'localId'] as const) {
    const v = c[field];
    if (v === undefined) {
      errors.push(fieldMissing(`${path}/${field}`, field));
    } else if (typeof v !== 'string') {
      errors.push(fieldType(`${path}/${field}`, v, 'string'));
    } else if (!ID_RE_V2.test(v)) {
      errors.push(idInvalid(`${path}/${field}`, v));
    }
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_PREFAB_FIELDS.has(k)) {
      errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'prefabId, localId'));
    }
  }
}

/**
 * Collision layers. A 3D project names up to
 * `MAX_COLLISION_LAYERS` layers in `content.collisionLayers`; together with
 * the implicit "default" layer (every collider without `layers`) they are the
 * 16 membership bits of the physics engine's collision groups. A collider
 * lists the layers it is in; a script query's filter names the layers it
 * sees. The names are identifiers (letters, digits, _; 1–32 characters).
 */
export const DEFAULT_COLLISION_LAYER = 'default';
/** Named layers besides `default`: Rapier's collision groups are 16 bits. */
export const MAX_COLLISION_LAYERS = 15;
const LAYER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/** The project's layer list (`content.collisionLayers`). */
export function validateCollisionLayers(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(v)) {
    errors.push(fieldType(path, v, 'array'));
    return;
  }
  if (v.length > MAX_COLLISION_LAYERS) {
    errors.push(withFound({ code: 'field_value', path, message: `a project names at most ${MAX_COLLISION_LAYERS} collision layers (with "default", 16)`, expected: `at most ${MAX_COLLISION_LAYERS} names` }, v.length));
    return;
  }
  const seen = new Set<string>();
  v.forEach((name, i) => {
    if (typeof name !== 'string' || !LAYER_NAME_RE.test(name)) errors.push(withFound({ code: 'field_value', path: `${path}/${i}`, message: 'a layer name is a letter or _ then up to 31 letters, digits or _', expected: 'an identifier' }, name));
    else if (name === DEFAULT_COLLISION_LAYER) errors.push(withFound({ code: 'field_value', path: `${path}/${i}`, message: '"default" is the implicit layer of every collider without layers; it is not listed', expected: 'another name' }, name));
    else if (seen.has(name)) errors.push(withFound({ code: 'field_value', path: `${path}/${i}`, message: 'layer names are unique', expected: 'a new name' }, name));
    else seen.add(name);
  });
}

/** A collider's `layers` (1–16 unique names; whether they exist is the project composition's check). */
export function validateColliderLayers(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_COLLISION_LAYERS + 1) {
    errors.push(withFound({ code: 'field_value', path, message: `layers lists 1–${MAX_COLLISION_LAYERS + 1} collision layer names`, expected: 'a list of layer names' }, v));
    return;
  }
  const seen = new Set<string>();
  v.forEach((name, i) => {
    if (typeof name !== 'string' || !LAYER_NAME_RE.test(name)) errors.push(withFound({ code: 'field_value', path: `${path}/${i}`, message: 'a layer name is a letter or _ then up to 31 letters, digits or _', expected: 'an identifier' }, name));
    else if (seen.has(name)) errors.push(withFound({ code: 'field_value', path: `${path}/${i}`, message: 'a collider lists each layer once', expected: 'unique names' }, name));
    else seen.add(name);
  });
}

/** The collider value without its v4 extras (`oneWay`, `layers`), for the shape validation. */
export function colliderCore(col: unknown): unknown {
  if (!isPlainObject(col) || (col['oneWay'] === undefined && col['layers'] === undefined)) return col;
  return Object.fromEntries(Object.entries(col).filter(([k]) => k !== 'oneWay' && k !== 'layers'));
}

export function validateColliderComponent(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const shape = c['shape'];
  if (shape === undefined) {
    errors.push(fieldMissing(`${path}/shape`, 'shape'));
  } else {
    validateColliderShape(shape, `${path}/shape`, errors);
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_COLLIDER_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'shape'));
  }
}

/**
 * The default character capsule when a controller carries none —
 * 0.3 m radius and 1.8 m total height (an adult human standing: about 0.6 m
 * across the shoulders, 1.8 m tall), centred on the entity. Every project
 * made before the capsule became data plays with exactly this shape.
 */
export const DEFAULT_CONTROLLER_CAPSULE: Readonly<{ radius: number; height: number; offset: readonly [number, number] }> = Object.freeze({
  radius: 0.3,
  height: 1.8,
  offset: Object.freeze([0, 0]) as readonly [number, number],
});

/** The capsule ranges (m) — far beyond any character, small enough to keep the solver sane. */
export const CAPSULE_LIMITS = Object.freeze({ minRadius: 0.05, maxRadius: 5, minHeight: 0.1, maxHeight: 20, maxOffset: 5 });

/** The capsule centre's offset along Z (a 3D project; the offset's optional third component, else 0). */
export function controllerCapsuleOffsetZ(controller: unknown): number {
  const c = isPlainObject(controller) ? controller['capsule'] : undefined;
  const o = isPlainObject(c) && Array.isArray(c['offset']) ? (c['offset'] as unknown[]) : [];
  return typeof o[2] === 'number' && Number.isFinite(o[2]) ? o[2] : 0;
}

/** The capsule a controller component describes (the default when it has none). */
export function controllerCapsuleOf(controller: unknown): { radius: number; height: number; offset: [number, number] } {
  const c = isPlainObject(controller) ? controller['capsule'] : undefined;
  if (!isPlainObject(c)) return { radius: DEFAULT_CONTROLLER_CAPSULE.radius, height: DEFAULT_CONTROLLER_CAPSULE.height, offset: [0, 0] };
  const o = Array.isArray(c['offset']) ? (c['offset'] as unknown[]) : [0, 0];
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    radius: num(c['radius'], DEFAULT_CONTROLLER_CAPSULE.radius),
    height: num(c['height'], DEFAULT_CONTROLLER_CAPSULE.height),
    offset: [num(o[0], 0), num(o[1], 0)],
  };
}

/**
 * The character's movement tuning when a controller carries none —
 * exactly the values every project played with before they became data (so
 * recorded replays stay valid). Generic
 * reasons: 40 / 60 m/s² reach a 4 m/s run in 0.1 s and stop in under 0.07 s
 * (responsive but not instant, any walking character); 0.05 s coyote time
 * and a 1/15 s (8 steps at 120 Hz) jump buffer are the usual few-frame
 * forgiveness windows; releasing jump early keeps half the upward speed
 * (variable jump height); a 0.1 m ground snap holds a walker on gentle
 * slopes and small bumps; the 0.01 m skin is the physics gap that keeps the
 * character from resting exactly on surfaces; autostep is off (a side-view character
 * climbs by jumping) and climbs 0.25 m (above a 0.18 m stair step) when on.
 */
export const DEFAULT_CONTROLLER_TUNING: Readonly<{
  acceleration: number;
  deceleration: number;
  coyoteTime: number;
  jumpBuffer: number;
  jumpRelease: number;
  groundSnap: number;
  skin: number;
  autostep: boolean;
  autostepHeight: number;
}> = Object.freeze({
  acceleration: 40,
  deceleration: 60,
  coyoteTime: 0.05,
  jumpBuffer: 8 / 120,
  jumpRelease: 0.5,
  groundSnap: 0.1,
  skin: 0.01,
  autostep: false,
  autostepHeight: 0.25,
});

type TuningNumberKey = 'acceleration' | 'deceleration' | 'coyoteTime' | 'jumpBuffer' | 'jumpRelease' | 'groundSnap' | 'skin' | 'autostepHeight';

/** The tuning ranges — wide enough for any character, narrow enough to keep the solver and the step counters sane. */
export const CONTROLLER_TUNING_LIMITS: Readonly<Record<TuningNumberKey, { readonly min: number; readonly max: number }>> = Object.freeze({
  acceleration: { min: 0.1, max: 1000 },
  deceleration: { min: 0.1, max: 1000 },
  coyoteTime: { min: 0, max: 1 },
  jumpBuffer: { min: 0, max: 1 },
  jumpRelease: { min: 0, max: 1 },
  groundSnap: { min: 0, max: 1 },
  skin: { min: 0.001, max: 0.1 },
  autostepHeight: { min: 0.01, max: 2 },
});

/** The controller's tuning fields, in canonical order. */
export const CONTROLLER_TUNING_FIELDS = ['acceleration', 'deceleration', 'coyoteTime', 'jumpBuffer', 'jumpRelease', 'groundSnap', 'skin', 'autostep', 'autostepHeight'] as const;
/**
 * The 3D character's settings when a controller carries none
 * (read only in a 3D project, physics_dimension 3; a 2D plane ignores them).
 * Genre-neutral reasons: a 2 m/s walk is a brisk human walk (people walk at
 * 1.2–1.5 m/s; a game walks a little faster so a map never drags); half the
 * ground acceleration in the air steers a jump without mid-air U-turns;
 * gravity is the project's (scale 1); most characters can hop, so jumping is
 * on (turn it off for a game that only walks); a 0.3 m step-up climbs a stair
 * riser (0.15–0.2 m) or a kerb without a jump, well below knee height; a
 * ledge climb is off (not every game climbs) and, when on, pulls up onto
 * ledges up to 1.2 m (chest height of the default 1.8 m capsule) in 0.6 s;
 * 720°/s turns a half circle in a quarter second (responsive, never a snap)
 * and the character faces where it moves; the move input is read relative to
 * the live camera's heading (pushing up walks away from the camera, as most
 * third-person controllers do; `world` reads it along the world axes). Run speed, jump speed and the
 * slope limit are absent: the project's `run_speed`, `jump_velocity` and
 * `max_slope_climb_deg` settings apply.
 */
export const DEFAULT_CHARACTER_3D: Readonly<{
  walkSpeed: number;
  airControl: number;
  gravityScale: number;
  jump: boolean;
  stepHeight: number;
  ledgeClimb: boolean;
  ledgeHeight: number;
  ledgeClimbTime: number;
  turnSpeed: number;
  faceMovement: boolean;
  moveFrame: CharacterMoveFrame;
}> = Object.freeze({
  walkSpeed: 2,
  airControl: 0.5,
  gravityScale: 1,
  jump: true,
  stepHeight: 0.3,
  ledgeClimb: false,
  ledgeHeight: 1.2,
  ledgeClimbTime: 0.6,
  turnSpeed: 720,
  faceMovement: true,
  moveFrame: 'view',
});

/**
 * What the 3D character's move input is relative to: `view` — the heading of
 * the live camera of the view (world axes while no camera is live); `world` —
 * the world axes (up pushes along −Z, right along +X) whatever the camera does.
 */
export const CHARACTER_MOVE_FRAMES = ['view', 'world'] as const;
export type CharacterMoveFrame = (typeof CHARACTER_MOVE_FRAMES)[number];

type Character3DNumberKey = 'walkSpeed' | 'runSpeed' | 'airControl' | 'gravityScale' | 'jumpSpeed' | 'slopeLimit' | 'stepHeight' | 'ledgeHeight' | 'ledgeClimbTime' | 'turnSpeed';

/** The 3D settings' ranges (a step-up below 0.01 m is off; a turn speed of 0 turns at once). */
export const CHARACTER_3D_LIMITS: Readonly<Record<Character3DNumberKey, { readonly min: number; readonly max: number }>> = Object.freeze({
  walkSpeed: { min: 0, max: 50 },
  runSpeed: { min: 0, max: 50 },
  airControl: { min: 0, max: 1 },
  gravityScale: { min: 0, max: 10 },
  jumpSpeed: { min: 0, max: 50 },
  slopeLimit: { min: 1, max: 89 },
  stepHeight: { min: 0, max: 1 },
  ledgeHeight: { min: 0.1, max: 5 },
  ledgeClimbTime: { min: 0.05, max: 5 },
  turnSpeed: { min: 0, max: 36000 },
});

/** The 3D character fields, in canonical order (after the tuning fields). */
export const CONTROLLER_3D_FIELDS = ['walkSpeed', 'runSpeed', 'airControl', 'gravityScale', 'jump', 'jumpSpeed', 'slopeLimit', 'stepHeight', 'ledgeClimb', 'ledgeHeight', 'ledgeClimbTime', 'turnSpeed', 'faceMovement', 'moveFrame'] as const;
const CONTROLLER_3D_BOOLEANS: readonly string[] = ['jump', 'ledgeClimb', 'faceMovement'];

/**
 * The input actions the controller reads (frame version 2 has no
 * fixed move/jump channels). Defaults `move` and `jump`: the names of the
 * default input actions every new project has (any genre's walking
 * character moves and jumps with them); a project may point its character at
 * other actions. Several player controllers (local co-op) each name their
 * own (`move_p2`, …), bound to that player's keys or gamepad (a binding's
 * `pad`). `runAction` (3D: held, it runs) defaults to `run`.
 */
export const CONTROLLER_ACTION_FIELDS = ['moveAction', 'jumpAction', 'runAction'] as const;
export const CONTROLLER_ACTION_DEFAULTS = Object.freeze({ moveAction: 'move', jumpAction: 'jump', runAction: 'run' });
const CONTROLLER_ACTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/** The action names a controller reads (each absent field at its default). */
export function controllerActionsOf(controller: unknown): { move: string; jump: string; run: string } {
  const c = isPlainObject(controller) ? controller : {};
  const name = (k: (typeof CONTROLLER_ACTION_FIELDS)[number]): string => (typeof c[k] === 'string' && CONTROLLER_ACTION_RE.test(c[k] as string) ? (c[k] as string) : CONTROLLER_ACTION_DEFAULTS[k]);
  return { move: name('moveAction'), jump: name('jumpAction'), run: name('runAction') };
}

/**
 * Climbing and walls (both dimensions). Climbing needs no switch:
 * a character climbs only inside a `climbVolume` (a scene without one plays
 * as before). Wall slide and wall jump are off by default (not every game
 * clings to walls). Genre-neutral reasons: a 2 m/s climb is the default 3D
 * walk (half the default run: a ladder or a net is slower than running on the
 * ground); a 2 m/s wall slide is a controlled slip, a fifteenth of the
 * default 30 m/s fall cap; a wall jump leaves at the run speed and the jump
 * speed (absent: the character's own, so it matches its normal jump).
 */
export const DEFAULT_CONTROLLER_MOVEMENT: Readonly<{ climbSpeed: number; wallSlide: boolean; wallSlideSpeed: number; wallJump: boolean }> = Object.freeze({
  climbSpeed: 2,
  wallSlide: false,
  wallSlideSpeed: 2,
  wallJump: false,
});
/** The climb and wall fields' ranges (m/s). */
export const CONTROLLER_MOVEMENT_LIMITS: Readonly<Record<'climbSpeed' | 'wallSlideSpeed' | 'wallJumpAway' | 'wallJumpUp' | 'wallJumpLock', { readonly min: number; readonly max: number }>> = Object.freeze({
  climbSpeed: { min: 0.1, max: 50 },
  wallSlideSpeed: { min: 0, max: 50 },
  wallJumpAway: { min: 0, max: 50 },
  wallJumpUp: { min: 0, max: 50 },
  /** s: how long a wall jump keeps the input from steering (absent: until the top of the jump). */
  wallJumpLock: { min: 0, max: 5 },
});
/** The climb and wall fields, in canonical order (after the action names). */
export const CONTROLLER_MOVEMENT_FIELDS = ['climbSpeed', 'climbAction', 'wallSlide', 'wallSlideSpeed', 'wallJump', 'wallJumpAway', 'wallJumpUp', 'wallJumpLock'] as const;
const CONTROLLER_MOVEMENT_BOOLEANS: readonly string[] = ['wallSlide', 'wallJump'];

/** The resolved climb and wall settings (`wallJumpAway`/`wallJumpUp` absent: the caller's run and jump speeds). */
export interface ControllerMovementSettings {
  climbSpeed: number;
  /** The input action whose value (an axis1d) or y (an axis2d) climbs; null: the move action's y. */
  climbAction: string | null;
  wallSlide: boolean;
  wallSlideSpeed: number;
  wallJump: boolean;
  wallJumpAway: number | null;
  wallJumpUp: number | null;
  /** Seconds the input does not steer after a wall jump (null: until the top of the jump). A landing always ends it. */
  wallJumpLock: number | null;
}

/** The climb and wall settings a controller describes (each absent field at its default). */
export function controllerMovementOf(controller: unknown): ControllerMovementSettings {
  const c = isPlainObject(controller) ? controller : {};
  const d = DEFAULT_CONTROLLER_MOVEMENT;
  const num = (k: string): number | null => (typeof c[k] === 'number' && Number.isFinite(c[k]) ? (c[k] as number) : null);
  const bool = (k: string, fallback: boolean): boolean => (typeof c[k] === 'boolean' ? (c[k] as boolean) : fallback);
  return {
    climbSpeed: num('climbSpeed') ?? d.climbSpeed,
    climbAction: typeof c['climbAction'] === 'string' && CONTROLLER_ACTION_RE.test(c['climbAction'] as string) ? (c['climbAction'] as string) : null,
    wallSlide: bool('wallSlide', d.wallSlide),
    wallSlideSpeed: num('wallSlideSpeed') ?? d.wallSlideSpeed,
    wallJump: bool('wallJump', d.wallJump),
    wallJumpAway: num('wallJumpAway'),
    wallJumpUp: num('wallJumpUp'),
    wallJumpLock: num('wallJumpLock'),
  };
}

/** Every v4 controller field, in canonical order. */
export const CONTROLLER_FIELDS: readonly string[] = ['capsule', ...CONTROLLER_TUNING_FIELDS, ...CONTROLLER_3D_FIELDS, ...CONTROLLER_ACTION_FIELDS, ...CONTROLLER_MOVEMENT_FIELDS];

/** The resolved 3D character settings (the controller's data, else the defaults and the project settings). */
export interface Character3DSettings {
  walkSpeed: number;
  runSpeed: number;
  acceleration: number;
  deceleration: number;
  airControl: number;
  /** m/s² along Y (negative: down) — the project's `gravity_y` × `gravityScale`. */
  gravityY: number;
  /** m/s (negative), the project's `max_fall_speed`. */
  maxFallSpeed: number;
  jump: boolean;
  jumpSpeed: number;
  coyoteTime: number;
  jumpBuffer: number;
  jumpRelease: number;
  /** Degrees: the steepest walkable slope. */
  slopeLimit: number;
  /** m: the ground snap distance the port uses — at least the step-up height (a character that climbs a riser walks down it too). */
  groundSnap: number;
  skin: number;
  /** m, 0 = off. */
  stepHeight: number;
  ledgeClimb: boolean;
  ledgeHeight: number;
  ledgeClimbTime: number;
  /** Degrees per second, 0 = at once. */
  turnSpeed: number;
  faceMovement: boolean;
  moveFrame: CharacterMoveFrame;
}

/**
 * The 3D character settings a controller describes, with the
 * project settings it defers to (`run_speed`, `jump_velocity`, `gravity_y`,
 * `max_fall_speed`, `max_slope_climb_deg`).
 */
export function character3DSettingsOf(controller: unknown, settings: { run_speed: number; jump_velocity: number; gravity_y: number; max_fall_speed: number; max_slope_climb_deg: number }): Character3DSettings {
  const c = isPlainObject(controller) ? controller : {};
  const t = controllerTuningOf(controller);
  const d = DEFAULT_CHARACTER_3D;
  const num = (k: string, fallback: number): number => {
    const v = c[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const bool = (k: string, fallback: boolean): boolean => (typeof c[k] === 'boolean' ? (c[k] as boolean) : fallback);
  const stepHeight = num('stepHeight', d.stepHeight);
  return {
    walkSpeed: num('walkSpeed', d.walkSpeed),
    runSpeed: num('runSpeed', settings.run_speed),
    acceleration: t.acceleration,
    deceleration: t.deceleration,
    airControl: num('airControl', d.airControl),
    gravityY: settings.gravity_y * num('gravityScale', d.gravityScale),
    maxFallSpeed: settings.max_fall_speed,
    jump: bool('jump', d.jump),
    jumpSpeed: num('jumpSpeed', settings.jump_velocity),
    coyoteTime: t.coyoteTime,
    jumpBuffer: t.jumpBuffer,
    jumpRelease: t.jumpRelease,
    slopeLimit: num('slopeLimit', settings.max_slope_climb_deg),
    groundSnap: Math.min(1, Math.max(t.groundSnap, stepHeight)),
    skin: t.skin,
    stepHeight: stepHeight >= 0.01 ? stepHeight : 0,
    ledgeClimb: bool('ledgeClimb', d.ledgeClimb),
    ledgeHeight: num('ledgeHeight', d.ledgeHeight),
    ledgeClimbTime: num('ledgeClimbTime', d.ledgeClimbTime),
    turnSpeed: num('turnSpeed', d.turnSpeed),
    faceMovement: bool('faceMovement', d.faceMovement),
    moveFrame: (CHARACTER_MOVE_FRAMES as readonly unknown[]).includes(c['moveFrame']) ? (c['moveFrame'] as CharacterMoveFrame) : d.moveFrame,
  };
}

/** The tuning a controller component describes (each absent field at its default). */
export function controllerTuningOf(controller: unknown): { -readonly [K in keyof typeof DEFAULT_CONTROLLER_TUNING]: (typeof DEFAULT_CONTROLLER_TUNING)[K] } {
  const c = isPlainObject(controller) ? controller : {};
  const d = DEFAULT_CONTROLLER_TUNING;
  const num = (k: TuningNumberKey): number => {
    const v = c[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d[k];
  };
  return {
    acceleration: num('acceleration'),
    deceleration: num('deceleration'),
    coyoteTime: num('coyoteTime'),
    jumpBuffer: num('jumpBuffer'),
    jumpRelease: num('jumpRelease'),
    groundSnap: num('groundSnap'),
    skin: num('skin'),
    autostep: typeof c['autostep'] === 'boolean' ? (c['autostep'] as boolean) : d.autostep,
    autostepHeight: num('autostepHeight'),
  };
}

/** The canonical controller, rebuilt field by field (the capsule's radius, height and optional offset, then the tuning fields present). */
export function canonicalController(controller: unknown): ControllerComponent {
  const src = isPlainObject(controller) ? controller : {};
  const c = src['capsule'];
  const out: Record<string, unknown> = {};
  if (isPlainObject(c)) {
    const o = c['offset'];
    out['capsule'] = {
      radius: c['radius'] as number,
      height: c['height'] as number,
      ...(Array.isArray(o) ? { offset: (o.length === 3 ? [o[0] as number, o[1] as number, o[2] as number] : [o[0] as number, o[1] as number]) as [number, number] } : {}),
    };
  }
  for (const k of CONTROLLER_TUNING_FIELDS) if (src[k] !== undefined) out[k] = src[k];
  // The 3D character fields (absent keeps the old canonical bytes).
  for (const k of CONTROLLER_3D_FIELDS) if (src[k] !== undefined) out[k] = src[k];
  // The action names (absent keeps the old canonical bytes).
  for (const k of CONTROLLER_ACTION_FIELDS) if (src[k] !== undefined) out[k] = src[k];
  // Climbing and walls (absent keeps the old canonical bytes).
  for (const k of CONTROLLER_MOVEMENT_FIELDS) if (src[k] !== undefined) out[k] = src[k];
  return out as ControllerComponent;
}

export function validateControllerComponent(c: unknown, path: string, errors: ModelErrorV2[], version: 2 | 3 | 4 = 2): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  for (const k of Object.keys(c)) {
    if (CONTROLLER_FIELDS.includes(k) && version === 4) continue;
    errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, version === 4 ? CONTROLLER_FIELDS.join(', ') : '{} (no fields before v4)'));
  }
  if (version !== 4) return;
  // The movement tuning.
  for (const [key, lim] of Object.entries(CONTROLLER_TUNING_LIMITS)) {
    const v = c[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lim.min || v > lim.max) {
      errors.push(fieldValue(`${path}/${key}`, v, `a number ${lim.min}-${lim.max}`, `controller ${key} must be ${lim.min}-${lim.max}`));
    }
  }
  if (c['autostep'] !== undefined && typeof c['autostep'] !== 'boolean') errors.push(fieldType(`${path}/autostep`, c['autostep'], 'boolean'));
  // The 3D character settings (validated in every project; only a 3D project reads them).
  for (const [key, lim] of Object.entries(CHARACTER_3D_LIMITS)) {
    const v = c[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lim.min || v > lim.max) {
      errors.push(fieldValue(`${path}/${key}`, v, `a number ${lim.min}-${lim.max}`, `controller ${key} must be ${lim.min}-${lim.max}`));
    }
  }
  for (const key of CONTROLLER_3D_BOOLEANS) if (c[key] !== undefined && typeof c[key] !== 'boolean') errors.push(fieldType(`${path}/${key}`, c[key], 'boolean'));
  if (c['moveFrame'] !== undefined && !(CHARACTER_MOVE_FRAMES as readonly unknown[]).includes(c['moveFrame'])) errors.push(fieldValue(`${path}/moveFrame`, c['moveFrame'], CHARACTER_MOVE_FRAMES.join(' | '), 'controller moveFrame is view or world'));
  // Climbing and walls.
  for (const [key, lim] of Object.entries(CONTROLLER_MOVEMENT_LIMITS)) {
    const v = c[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lim.min || v > lim.max) {
      errors.push(fieldValue(`${path}/${key}`, v, `a number ${lim.min}-${lim.max}`, `controller ${key} must be ${lim.min}-${lim.max}`));
    }
  }
  for (const key of CONTROLLER_MOVEMENT_BOOLEANS) if (c[key] !== undefined && typeof c[key] !== 'boolean') errors.push(fieldType(`${path}/${key}`, c[key], 'boolean'));
  if (c['climbAction'] !== undefined && (typeof c['climbAction'] !== 'string' || !CONTROLLER_ACTION_RE.test(c['climbAction']))) errors.push(fieldValue(`${path}/climbAction`, c['climbAction'], 'an input action name (a letter or _, then up to 31 letters, digits or _)', 'controller climbAction names an input action'));
  // The input actions it reads.
  for (const key of CONTROLLER_ACTION_FIELDS) {
    const v = c[key];
    if (v !== undefined && (typeof v !== 'string' || !CONTROLLER_ACTION_RE.test(v))) errors.push(fieldValue(`${path}/${key}`, v, 'an input action name (a letter or _, then up to 31 letters, digits or _)', `controller ${key} names an input action`));
  }
  const capsule = c['capsule'];
  if (capsule === undefined) return;
  const cp = `${path}/capsule`;
  if (!isPlainObject(capsule)) {
    errors.push(fieldType(cp, capsule, 'object { radius, height, offset? }'));
    return;
  }
  for (const k of Object.keys(capsule)) {
    if (k !== 'radius' && k !== 'height' && k !== 'offset') errors.push(unexpectedField(`${cp}/${pointerSegment(k)}`, k, 'radius, height, offset'));
  }
  const L = CAPSULE_LIMITS;
  const range = (key: 'radius' | 'height', min: number, max: number): number | null => {
    const v = capsule[key];
    if (v === undefined) {
      errors.push(fieldMissing(`${cp}/${key}`, key));
      return null;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      errors.push(fieldValue(`${cp}/${key}`, v, `a number ${min}-${max} (m)`, `capsule ${key} must be ${min}-${max} m`));
      return null;
    }
    return v;
  };
  const radius = range('radius', L.minRadius, L.maxRadius);
  const height = range('height', L.minHeight, L.maxHeight);
  if (radius !== null && height !== null && height < 2 * radius) {
    errors.push(fieldValue(`${cp}/height`, height, `>= 2 x radius (${2 * radius})`, 'the capsule height includes both end caps, so it is at least twice the radius'));
  }
  const offset = capsule['offset'];
  if (offset !== undefined) {
    // An optional third component (z) for a 3D project; a 2D plane ignores it.
    const ok = Array.isArray(offset) && (offset.length === 2 || offset.length === 3) && offset.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= L.maxOffset);
    if (!ok) errors.push(fieldValue(`${cp}/offset`, offset, `[x, y] or [x, y, z], each within ±${L.maxOffset} m`, 'capsule offset is [x, y] (or [x, y, z]) in metres from the entity origin'));
  }
}

// ---- component registry, conflicts, physics transforms -----------------------

function effectiveTransform(comps: Record<string, unknown>): TransformComponent {
  return canonicalTransform(comps['transform']);
}

export function validatePhysicsTransform(
  comps: Record<string, unknown>,
  parentId: unknown,
  path: string,
  hasController: boolean,
  errors: ModelErrorV2[],
  /**
   * `false` defers the rotation rules to the project level
   * (`physicsRotationErrors` with the project's `physics_dimension`), so a v4
   * scene's collider may turn freely in a 3D project. v2/v3 documents (2D
   * only) keep the rules here.
   */
  checkRotation = true,
  /**
   * `false` defers the scale rule to the project level too
   * (`physicsScaleErrors`): a 3D collider may be scaled where its shape can
   * take it. Defaults to `checkRotation` (v4 defers both).
   */
  checkScale = checkRotation,
): void {
  // A collider may sit on a child and follows its parent; the character's
  // body and a mover's are posed in world space by their own systems, so
  // those stay roots.
  if (typeof parentId === 'string' && (hasController || comps['mover'] !== undefined)) {
    errors.push(
      withFound(
        {
          code: 'physics_transform_unsupported',
          path: `${path}`,
          message: hasController ? 'the controller entity must be a root (parentId absent or null)' : "a mover's collider entity must be a root (parentId absent or null); a collider on its child follows it",
          reason: 'parented',
          expected: 'parentId absent or null',
        },
        parentId,
      ),
    );
  }
  if (checkScale) physicsScaleErrors(comps, path, hasController, 2, errors);
  if (checkRotation) physicsRotationErrors(comps, path, hasController, 2, errors);
}

/**
 * The scale rule of a physics-bearing entity for the project's
 * physics dimension. A 2D plane (and every controller): unit scale, as
 * before. 3D: a box, hull or mesh collider takes any positive scale per axis
 * (applied to its shape along the entity's axes), a sphere or capsule a
 * positive uniform one (a non-uniformly scaled sphere is no sphere).
 */
export function physicsScaleErrors(comps: Record<string, unknown>, path: string, hasController: boolean, dimension: 2 | 3, errors: ModelErrorV2[]): void {
  const t = effectiveTransform(comps);
  const [sx, sy, sz] = t.scale;
  if (sx === 1 && sy === 1 && sz === 1) return;
  const shape = isPlainObject(comps['collider']) ? (comps['collider'] as Record<string, unknown>)['shape'] : undefined;
  const roundPart = colliderShapeParts(shape).find((p) => p['type'] === 'sphere' || p['type'] === 'capsule');
  const type = roundPart !== undefined ? roundPart['type'] : isPlainObject(shape) ? shape['type'] : undefined;
  if (dimension === 3 && !hasController) {
    // A compound holding a sphere or a capsule scales uniformly too.
    const round = roundPart !== undefined;
    const positive = sx > 0 && sy > 0 && sz > 0;
    if (positive && (!round || (sx === sy && sy === sz))) return;
    errors.push(
      withFound(
        {
          code: 'physics_transform_unsupported',
          path: `${path}/transform/scale`,
          message: round ? `a ${String(type)} collider takes a positive uniform scale [s, s, s]` : 'a collider takes a positive scale on every axis',
          reason: 'scale',
          expected: round ? '[s, s, s], s > 0' : '[x, y, z], each > 0',
        },
        t.scale,
      ),
    );
    return;
  }
  errors.push(
    withFound(
      {
        code: 'physics_transform_unsupported',
        path: `${path}/transform/scale`,
        message: 'a physics-bearing entity must be at unit scale [1, 1, 1]',
        reason: 'scale',
        expected: '[1, 1, 1]',
      },
      t.scale,
    ),
  );
}

/**
 * The rotation rules of a physics-bearing entity for the
 * project's physics dimension. A 2D-plane project (2): rotated about Z only
 * and the controller upright (identity). A 3D project (3): a collider takes
 * any rotation; the controller stays upright (identity: the capsule stands
 * along Y).
 */
export function physicsRotationErrors(comps: Record<string, unknown>, path: string, hasController: boolean, dimension: 2 | 3, errors: ModelErrorV2[]): void {
  const t = effectiveTransform(comps);
  const [qx, qy, qz, qw] = t.rotation;
  if (dimension === 3) {
    if (hasController && !(qx === 0 && qy === 0 && qz === 0 && qw === 1)) {
      errors.push(
        withFound(
          {
            code: 'physics_transform_unsupported',
            path: `${path}/transform/rotation`,
            message: 'the controller entity must be upright (identity rotation)',
            reason: 'upright',
            expected: '[0, 0, 0, 1]',
          },
          t.rotation,
        ),
      );
    }
    return;
  }
  const zOnly = Math.abs(qx) <= 1e-6 && Math.abs(qy) <= 1e-6;
  if (!zOnly) {
    errors.push(
      withFound(
        {
          code: 'physics_transform_unsupported',
          path: `${path}/transform/rotation`,
          message: 'a physics-bearing entity may be rotated about the Z axis only',
          reason: 'rotation',
          expected: '[x, y, z, w] with |x| <= 1e-6 and |y| <= 1e-6',
        },
        t.rotation,
      ),
    );
  } else if (hasController && !(qz === 0 && qw === 1)) {
    errors.push(
      withFound(
        {
          code: 'physics_transform_unsupported',
          path: `${path}/transform/rotation`,
          message: 'the controller entity must be upright (identity rotation)',
          reason: 'upright',
          expected: '[0, 0, 0, 1]',
        },
        t.rotation,
      ),
    );
  }
}

/** `transform` field validation for the v2 registry (the same rules as the scene transform). */
export function validateTransformV2(t: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(t)) {
    errors.push(fieldType(path, t, 'object'));
    return;
  }
  checkVector(t['position'], `${path}/position`, 3, { absMax: MAX_LEN }, `each |v| <= ${MAX_LEN} meters`, errors);
  checkQuaternion(t['rotation'], `${path}/rotation`, errors);
  checkVector(t['scale'], `${path}/scale`, 3, { positive: true, absMax: MAX_LEN }, `each 0 < v <= ${MAX_LEN}`, errors);
  for (const k of Object.keys(t)) {
    if (!KNOWN_TRANSFORM_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'position, rotation, scale'));
  }
}

export function validateBoxV2(b: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(b)) {
    errors.push(fieldType(path, b, 'object'));
    return;
  }
  checkVector(b['size'], `${path}/size`, 3, { positive: true, absMax: MAX_LEN }, `each 0 < v <= ${MAX_LEN} meters`, errors);
  const mat = b['material'];
  if (mat !== undefined) {
    if (!isPlainObject(mat)) {
      errors.push(fieldType(`${path}/material`, mat, 'object'));
    } else {
      const color = mat['color'];
      if (color !== undefined) {
        if (typeof color !== 'string') errors.push(fieldType(`${path}/material/color`, color, 'string'));
        else if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
          errors.push(
            fieldValue(`${path}/material/color`, color, '#rrggbb (6 hex digits)', 'material color must be #rrggbb (case-insensitive; canonical form is lowercase)'),
          );
        }
      }
      for (const k of Object.keys(mat)) {
        if (!KNOWN_MATERIAL_FIELDS.has(k)) errors.push(unexpectedField(`${path}/material/${pointerSegment(k)}`, k, 'color'));
      }
    }
  }
  validateShadowFlags(b, path, errors);
  for (const k of Object.keys(b)) {
    if (!KNOWN_BOX_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'size, material, castShadow, receiveShadow, lightLayers'));
  }
}

export function validateCameraV2(c: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(c)) {
    errors.push(fieldType(path, c, 'object'));
    return;
  }
  const type = c['type'];
  if (type !== undefined) {
    if (typeof type !== 'string') errors.push(fieldType(`${path}/type`, type, 'string'));
    else if (type !== 'perspective') errors.push(fieldValue(`${path}/type`, type, '"perspective" (only M1 value)', 'camera type must be "perspective"'));
  }
  if (c['fovY'] !== undefined) checkFiniteNumber(c['fovY'], `${path}/fovY`, { positive: true, maxExcl: 180 }, '0 < v < 180 degrees', errors);
  const near = c['near'];
  if (near !== undefined) checkFiniteNumber(near, `${path}/near`, { positive: true, absMax: MAX_LEN }, `0 < v <= ${MAX_LEN} meters`, errors);
  const effectiveNear = typeof near === 'number' && Number.isFinite(near) ? (near as number) : 0.1;
  if (c['far'] !== undefined) checkFiniteNumber(c['far'], `${path}/far`, { minExcl: effectiveNear, absMax: MAX_LEN }, `near < v <= ${MAX_LEN} meters`, errors);
  for (const k of Object.keys(c)) {
    if (!KNOWN_CAMERA_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'type, fovY, near, far'));
  }
}

