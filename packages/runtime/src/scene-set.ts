/**
 * The pure parts of the runtime's scene set — what one loaded
 * scene contributes (its static colliders), the root offset of a load and the
 * live tag index that follows loads and unloads. No I/O, no three.js.
 */
import { character3DSettingsOf, controllerCapsuleOf, controllerCapsuleOffsetZ, controllerTuningOf, resolveSceneHierarchy, sceneCamerasAsShots, validateSceneV4, type EntityV3, type TagDefinition } from '@thirdlight/project-model';

import type { ColliderShape3D, PhysicsInitConfig3D, StaticColliderSpec, StaticColliderSpec3D, Vec2 } from './ports';
import type { BehaviorTagQuery, ModelBounds, PlayerCapsule } from './types';

/** What one scene adds to the running game (its static colliders). */
export interface SceneContribution {
  colliders: StaticColliderSpec[];
}

/** The static colliders of a list of (resolved) entities. */
export function sceneContribution(entities: readonly EntityV3[]): SceneContribution {
  const out: SceneContribution = { colliders: [] };
  for (const e of entities) {
    const c = e.components as unknown as Record<string, unknown>;
    if (c['controller'] === undefined) {
      const spec = staticColliderOf(e.id, c);
      if (spec !== null) out.colliders.push(spec);
    }
  }
  return out;
}

/**
 * The angle about Z (radians) of a transform's `[x, y, z, w]`
 * quaternion — the one rotation a 2D-plane collider takes (the project model
 * keeps a physics entity's rotation about Z only). Exactly 0 for the
 * identity (either sign of `w`), so an unrotated collider gets rotationZ 0.
 */
export function colliderRotationZ(rotation: readonly number[] | undefined): number {
  if (rotation === undefined) return 0;
  const z = rotation[2] ?? 0;
  const w = rotation[3] ?? 1;
  return z === 0 ? 0 : 2 * Math.atan2(z, w);
}

/**
 * The static collider spec of one entity's `collider` component
 * (null without one) — its world XY, the entity's rotation about Z (the
 * editor draws the collider rotated with the entity, so physics must too),
 * kinematic for a mover, one-way when set. The single place the
 * runtime, the Play preview, the export and the perf harness derive it.
 */
export function staticColliderOf(entityId: string, components: Readonly<Record<string, unknown>>): StaticColliderSpec | null {
  const collider = components['collider'] as { shape?: unknown; oneWay?: boolean } | undefined;
  if (collider === undefined) return null;
  const t = components['transform'] as { position?: readonly number[]; rotation?: readonly number[] } | undefined;
  const position = t?.position ?? [0, 0, 0];
  // A box's depth (`hz`, for a 3D project) is not part of a 2D-plane shape.
  const shape = collider.shape as { type?: unknown; hx?: unknown; hy?: unknown; hz?: unknown } | undefined;
  return {
    entityId,
    shape: shape !== undefined && shape !== null && shape.type === 'box' && shape.hz !== undefined ? { type: 'box', hx: shape.hx, hy: shape.hy } : collider.shape,
    position: { x: position[0] ?? 0, y: position[1] ?? 0 },
    rotationZ: colliderRotationZ(t?.rotation),
    ...(components['mover'] !== undefined ? { kinematic: true } : {}),
    ...(collider.oneWay === true ? { oneWay: true } : {}),
  };
}

/** The entities with `at` added to every root entity's position (children follow their parent). */
export function offsetEntities(entities: readonly EntityV3[], at: readonly [number, number, number] | undefined): EntityV3[] {
  if (at === undefined || (at[0] === 0 && at[1] === 0 && at[2] === 0)) return [...entities];
  return entities.map((e) => {
    if (e.parentId !== undefined) return e;
    const t = e.components.transform;
    return {
      ...e,
      components: {
        ...e.components,
        transform: { ...t, position: [t.position[0] + at[0], t.position[1] + at[1], t.position[2] + at[2]] },
      },
    } as EntityV3;
  });
}


/** Round to the nanometre (keeps a derived length equal to the constant it replaced: 1.8 / 2 − 0.3 is exactly 0.6). */
const nano = (v: number): number => Math.round(v * 1e9) / 1e9;

/**
 * The player capsule a `controller` component describes (the
 * project-model default when it carries none), in the runtime's form.
 */
export function playerCapsuleOf(controller: unknown): PlayerCapsule {
  const c = controllerCapsuleOf(controller);
  return Object.freeze({
    radius: c.radius,
    halfHeight: Math.max(0, nano(c.height / 2 - c.radius)),
    offset: Object.freeze({ x: c.offset[0], y: c.offset[1] }),
  });
}

/**
 * The character-controller tuning the physics port takes from the
 * player's `controller` (its skin, ground snap and autostep; each absent
 * field at its default: 0.01 m, 0.1 m, off). The preview and export hosts
 * build the port's `controller` config from it.
 */
export function playerPhysicsOf(controller: unknown): { offsetSkin: number; groundSnap: number; autostep: boolean; autostepHeight: number } {
  const t = controllerTuningOf(controller);
  return { offsetSkin: t.skin, groundSnap: t.groundSnap, autostep: t.autostep, autostepHeight: t.autostepHeight };
}

/**
 * The shape a 3D port builds from an authored collider shape and
 * the entity's scale (the project model allows a positive scale per axis for
 * a box, hull or mesh and a uniform one for a sphere or capsule): a box's
 * half extents and a hull's or mesh's points scale along the entity's axes;
 * a capsule's authored total `height` (end caps included) becomes the port's
 * centre-segment `halfHeight`; point lists are flattened. Null for a shape a
 * 3D port does not take (a polygon — the model refuses it in 3D).
 */
export function colliderShape3DOf(shape: unknown, scale: readonly number[] = [1, 1, 1]): ColliderShape3D | null {
  if (typeof shape !== 'object' || shape === null) return null;
  const s = shape as Record<string, unknown>;
  const sx = scale[0] ?? 1;
  const sy = scale[1] ?? 1;
  const sz = scale[2] ?? 1;
  const n = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
  const flat = (list: unknown): number[] => {
    const out: number[] = [];
    if (Array.isArray(list)) for (const q of list as unknown[][]) out.push(n(q[0]) * sx, n(q[1]) * sy, n(q[2]) * sz);
    return out;
  };
  switch (s['type']) {
    case 'box':
      return { type: 'box', hx: n(s['hx']) * sx, hy: n(s['hy']) * sy, hz: n(s['hz']) * sz };
    case 'sphere':
      return { type: 'sphere', radius: n(s['radius']) * sx };
    case 'capsule': {
      const r = n(s['radius']);
      return { type: 'capsule', radius: r * sx, halfHeight: Math.max(0, n(s['height']) / 2 - r) * sx };
    }
    case 'convex':
      return { type: 'convex', points: flat(s['points']) };
    case 'mesh': {
      const indices: number[] = [];
      if (Array.isArray(s['triangles'])) for (const t of s['triangles'] as unknown[][]) indices.push(n(t[0]), n(t[1]), n(t[2]));
      return { type: 'mesh', vertices: flat(s['vertices']), indices };
    }
    default:
      return null;
  }
}

/**
 * The 3D static collider spec of one entity's `collider` (null
 * without one): its world position and full rotation (a 3D collider turns on
 * any axis; the project model keeps it a root), the shape resolved for the
 * port (the entity's scale applied, `colliderShape3DOf`); a
 * mover's collider is kinematic, as is a collider a script
 * drives (`kinematic`).
 */
export function staticColliderOf3D(entityId: string, components: Readonly<Record<string, unknown>>, kinematic = false): StaticColliderSpec3D | null {
  const collider = components['collider'] as { shape?: unknown; layers?: unknown } | undefined;
  if (collider === undefined) return null;
  const t = components['transform'] as { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] } | undefined;
  const p = t?.position ?? [0, 0, 0];
  const q = t?.rotation ?? [0, 0, 0, 1];
  const resolved = colliderShape3DOf(collider.shape, t?.scale ?? [1, 1, 1]);
  return {
    entityId,
    shape: resolved ?? collider.shape,
    position: { x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0 },
    rotation: { x: q[0] ?? 0, y: q[1] ?? 0, z: q[2] ?? 0, w: q[3] ?? 1 },
    ...(kinematic || components['mover'] !== undefined ? { kinematic: true } : {}),
    // The collision layers it is in (absent: "default").
    ...(Array.isArray(collider.layers) ? { layers: [...(collider.layers as string[])] } : {}),
  };
}

/**
 * The 3D physics init config of a scene's (resolved) entities —
 * every collider but the player's as a static, the controller entity as the
 * character with its capsule (the offset's z included) and its tuning, the
 * project's step rate and gravity along −Y, the slope angles. The one
 * builder the Play preview, the export, the simulation worker's host and the
 * tests use. `options.layers` — the project's named collision
 * layers; without a controller entity the world has no character
 * (`noCharacter`: its colliders answer queries and carry movers — a scene
 * picked with the pointer need not have a player); it was null before, so a
 * 3D scene without a player had no physics at all. Null with neither a
 * controller nor a collider.
 */
export function physics3DConfigOf(
  entities: readonly { id: string; components?: unknown }[],
  settings: { gravity_y: number; max_slope_climb_deg: number; min_slope_slide_deg: number; fixed_step_hz?: number },
  options: { layers?: readonly string[] } = {},
): PhysicsInitConfig3D | null {
  const statics: StaticColliderSpec3D[] = [];
  let character: PhysicsInitConfig3D['character'] | null = null;
  let controller: unknown = undefined;
  for (const e of entities) {
    const c = (e.components ?? {}) as Record<string, unknown>;
    if (c['controller'] !== undefined) {
      const t = c['transform'] as { position?: readonly number[] } | undefined;
      const p = t?.position ?? [0, 0, 0];
      const capsule = playerCapsuleOf(c['controller']);
      controller = c['controller'];
      character = {
        position: { x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0 },
        radius: capsule.radius,
        halfHeight: capsule.halfHeight,
        offset: { x: capsule.offset.x, y: capsule.offset.y, z: controllerCapsuleOffsetZ(c['controller']) },
      };
      continue;
    }
    const spec = staticColliderOf3D(e.id, c);
    if (spec !== null) statics.push(spec);
  }
  const noCharacter = character === null;
  // Nothing to simulate or query: no physics (the module resolution then needs no 3D backend either).
  // A block layer's chunks become colliders at run time, so it needs a world too.
  if (character === null && statics.length === 0 && !entities.some((e) => (e.components as Record<string, unknown> | undefined)?.['blockLayer'] !== undefined)) return null;
  if (character === null) {
    // A placeholder the port ignores (the default capsule at the origin).
    const capsule = playerCapsuleOf(undefined);
    character = { position: { x: 0, y: 0, z: 0 }, radius: capsule.radius, halfHeight: capsule.halfHeight, offset: { x: 0, y: 0, z: 0 } };
  }
  // The 3D character's settings — its step-up height (0: off) is
  // the port's autostep, its ground snap at least that height, its slope limit
  // (else the project's) the steepest climb.
  const c3 = character3DPhysicsOf(controller, settings.max_slope_climb_deg);
  return {
    dimension: 3,
    character,
    statics,
    ...(options.layers !== undefined && options.layers.length > 0 ? { layers: [...options.layers] } : {}),
    ...(noCharacter ? { noCharacter: true as const } : {}),
    solver: { hz: settings.fixed_step_hz ?? 120, gravityY: settings.gravity_y },
    controller: {
      offsetSkin: c3.skin,
      groundSnap: c3.groundSnap,
      maxSlopeClimbRad: (c3.slopeLimit * Math.PI) / 180,
      minSlopeSlideRad: (Math.min(settings.min_slope_slide_deg, c3.slopeLimit) * Math.PI) / 180,
      autostep: c3.stepHeight > 0,
      ...(c3.stepHeight > 0 ? { autostepHeight: c3.stepHeight } : {}),
    },
  };
}

/**
 * The parts of a 3D character's settings the physics port and the
 * runtime's result check use (skin, ground snap, step-up height, slope limit).
 */
export function character3DPhysicsOf(controller: unknown, maxSlopeClimbDeg: number): { skin: number; groundSnap: number; stepHeight: number; slopeLimit: number } {
  // run speed, jump and gravity do not reach the port (placeholders for the resolver's other fields).
  const s = character3DSettingsOf(controller, { run_speed: 0, jump_velocity: 0, gravity_y: 0, max_fall_speed: 0, max_slope_climb_deg: maxSlopeClimbDeg });
  return { skin: s.skin, groundSnap: s.groundSnap, stepHeight: s.stepHeight, slopeLimit: s.slopeLimit };
}

/**
 * The model bounds a manifest's asset rows carry (model rows with
 * recorded `bounds`; the last version per asset), for `RuntimeSnapshot.modelBounds`
 * — `undefined` when none has any (the snapshot stays as it was).
 */
export function modelBoundsFromAssetRows(rows: readonly { assetId: string; kind?: string; bounds?: unknown }[] | undefined): Record<string, ModelBounds> | undefined {
  const out: Record<string, ModelBounds> = {};
  let any = false;
  for (const r of rows ?? []) {
    const b = r.bounds as { min?: unknown; max?: unknown } | undefined;
    const vec = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (r.kind !== 'model' || b === undefined || !vec(b.min) || !vec(b.max)) continue;
    out[r.assetId] = { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
    any = true;
  }
  return any ? out : undefined;
}

/**
 * The recorded durations a manifest's audio rows
 * carry (`durationMs`), for `RuntimeSnapshot.audioDurations` — `undefined`
 * when none has one (the snapshot stays as it was).
 */
export function audioDurationsFromAssetRows(rows: readonly { assetId: string; kind?: string; durationMs?: unknown }[] | undefined): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  let any = false;
  for (const r of rows ?? []) {
    const ms = r.durationMs;
    if (r.kind !== 'audio' || typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 1) continue;
    out[r.assetId] = ms;
    any = true;
  }
  return any ? out : undefined;
}

/** The capsule's half extent along Y (end caps included), nanometre-rounded (0.9 for the default). */
export function capsuleHalfTotal(capsule: PlayerCapsule): number {
  return nano(capsule.halfHeight + capsule.radius);
}


/**
 * `ctx.tags` over the loaded entities. Loads add masks, unloads remove them;
 * query results are cached per mask until the next change.
 */
export class LiveTagIndex implements BehaviorTagQuery {
  private readonly bitByName = new Map<string, number>();
  private readonly masks = new Map<string, number>();
  private order: string[] = [];
  private readonly cache = new Map<string, readonly string[]>();

  /** `makeError` builds the error a bad call throws (the behavior host's `module_error`). */
  constructor(
    tags: readonly TagDefinition[],
    entities: readonly { id: string; tags?: number }[],
    private readonly makeError: (reason: string, message: string) => Error,
  ) {
    for (const t of tags) this.bitByName.set(t.name.toLowerCase(), t.bit);
    this.add(entities);
  }

  add(entities: readonly { id: string; tags?: number }[]): void {
    for (const e of entities) {
      if (!this.masks.has(e.id)) this.order.push(e.id);
      this.masks.set(e.id, (e.tags ?? 0) >>> 0);
    }
    this.cache.clear();
  }

  remove(ids: ReadonlySet<string>): void {
    for (const id of ids) this.masks.delete(id);
    this.order = this.order.filter((id) => !ids.has(id));
    this.cache.clear();
  }

  mask(...names: string[]): number {
    let m = 0;
    for (const name of names) {
      const bit = typeof name === 'string' ? this.bitByName.get(name.toLowerCase()) : undefined;
      if (bit === undefined) {
        throw this.makeError('behavior_tag_unknown', `ctx.tags.mask: unknown tag "${String(name)}" (known: ${[...this.bitByName.keys()].join(', ') || 'none'})`);
      }
      m = (m | (1 << bit)) >>> 0;
    }
    return m;
  }

  of(entityId: string): number {
    return this.masks.get(entityId) ?? 0;
  }

  has(entityId: string, mask: number, match?: 'any' | 'all'): boolean {
    return matches(this.masks.get(entityId) ?? 0, mask >>> 0, this.checkMatch(match));
  }

  private checkMatch(match: unknown): 'any' | 'all' {
    if (match === undefined || match === 'any') return 'any';
    if (match === 'all') return 'all';
    throw this.makeError('behavior_tag_query_invalid', 'ctx.tags match must be "any" or "all"');
  }

  query(mask: number, match?: 'any' | 'all'): readonly string[] {
    const mode = this.checkMatch(match);
    const key = `${mode}:${mask >>> 0}`;
    let hit = this.cache.get(key);
    if (hit === undefined) {
      hit = Object.freeze(this.order.filter((id) => matches(this.masks.get(id) ?? 0, mask >>> 0, mode)));
      this.cache.set(key, hit);
    }
    return hit;
  }
}

function matches(m: number, mask: number, match: 'any' | 'all'): boolean {
  return match === 'all' ? ((m & mask) >>> 0) === mask >>> 0 : (m & mask) !== 0;
}


/**
 * A fetched scene document (`scenes/<sceneId>.json` of a Play/export build)
 * as the runtime loads it: validated as a schemaVersion 4 scene of the
 * expected id, folders and inactive entities resolved away.
 */
export function sceneEntitiesFromDocument(
  doc: unknown,
  sceneId: string,
): { ok: true; entities: EntityV3[] } | { ok: false; message: string } {
  // A scene file made before the engine owned the view holds a scene camera: it plays as its shot.
  const entities = typeof doc === 'object' && doc !== null ? (doc as { entities?: unknown }).entities : undefined;
  const res = validateSceneV4(Array.isArray(entities) ? { ...(doc as object), entities: sceneCamerasAsShots(entities) } : doc);
  if (!res.ok) {
    const first = res.errors[0];
    return { ok: false, message: `scene "${sceneId}" is invalid: ${res.errors.length} error(s)${first ? `; first: ${first.code} at ${first.path}` : ''}` };
  }
  if (res.normalized.sceneId !== sceneId) return { ok: false, message: `the document holds scene "${res.normalized.sceneId}", not "${sceneId}"` };
  return { ok: true, entities: resolveSceneHierarchy(res.normalized).entities as EntityV3[] };
}
