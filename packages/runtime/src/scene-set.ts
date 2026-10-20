/**
 * The pure parts of the runtime's scene set — what one loaded
 * scene contributes (its static colliders), the root offset of a load and the
 * live tag index that follows loads and unloads. No I/O, no three.js.
 */
import { character3DSettingsOf, controllerCapsuleOf, fixedStepHzOf, controllerCapsuleOffsetZ, controllerTuningOf, resolveSceneHierarchy, sceneCamerasAsShots, validateSceneV4, type EntityV3, type TagDefinition } from '@thirdlight/project-model';

import type { ModelColliderTable } from '@thirdlight/project-model';

import { colliderSpecs2D, colliderSpecs3D, type ColliderContext } from './collider-specs';
import type { AddedCharacter2D, AddedCharacter3D, CharacterControllerTuning, PhysicsInitConfig3D, StaticColliderSpec, Vec2 } from './ports';

export { colliderRotationZ, colliderShape3DOf, colliderShape2DOf, colliderSpecs2D, colliderSpecs3D, staticColliderOf, staticColliderOf3D, worldTransformsOf, type ColliderContext } from './collider-specs';
import type { BehaviorTagQuery, ModelBounds, PlayerCapsule } from './types';

/** What one scene adds to the running game (its static colliders). */
export interface SceneContribution {
  colliders: StaticColliderSpec[];
}

/** The static colliders of a list of (resolved) entities (on the 2D plane, each where it is in the world). */
export function sceneContribution(entities: readonly EntityV3[], ctx?: ColliderContext): SceneContribution {
  return { colliders: colliderSpecs2D(entities, ctx) };
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
 * The 3D physics init config of a scene's (resolved) entities —
 * every collider but the players' as a static, the controller entities as
 * the characters (the first as `character`, the others as `characters`, by
 * object) each with its capsule (the offset's z included) and tuning, the
 * project's step rate and gravity along −Y, the slope angles. The one
 * builder the Play preview, the export, the simulation worker's host and the
 * tests use. `options.layers` — the project's named collision
 * layers; without a controller entity the world has no character
 * (`noCharacter`: its colliders answer queries and carry movers — a scene
 * picked with the pointer need not have a player); it was null before, so a
 * 3D scene without a player had no physics at all. Null with neither a
 * controller nor a collider, unless `options.required`: the project's
 * modules name the 3D backend (a scene loaded later, a prefab or a script
 * needs it), so the host must inject a port even for an empty start scene.
 * The world is made for a runtime (`buildAtRunStart`).
 */
export function physics3DConfigOf(
  entities: readonly { id: string; components?: unknown }[],
  settings: CharacterSettings & { gravity_y: number; fixed_step_hz?: number },
  options: { layers?: readonly string[]; modelColliders?: ModelColliderTable; required?: boolean } = {},
): PhysicsInitConfig3D | null {
  const statics = colliderSpecs3D(entities as readonly { id: string; parentId?: string | null; components?: unknown }[], options.modelColliders !== undefined ? { modelColliders: options.modelColliders } : undefined);
  // Every player controller: the first is the port's character, the others its further characters.
  const players = entities.filter((e) => (e.components as Record<string, unknown> | undefined)?.['controller'] !== undefined).map((e) => character3DOf(e, settings));
  const first = players[0];
  // Nothing to simulate or query: no physics. The required modules come from every scene, so when they
  // name the 3D backend an empty world is made anyway (a later scene's colliders and players are added to it).
  // A block layer's chunks become colliders at run time, so it needs a world too.
  if (options.required !== true && first === undefined && statics.length === 0 && !entities.some((e) => (e.components as Record<string, unknown> | undefined)?.['blockLayer'] !== undefined)) return null;
  // Without a player the character is a placeholder the port ignores (the default capsule at the origin).
  const placeholder = first ?? { ...character3DOf({ id: '', components: { transform: { position: [0, 0, 0] } } }, settings), offset: { x: 0, y: 0, z: 0 } };
  return {
    dimension: 3,
    character: { position: placeholder.position, radius: placeholder.radius, halfHeight: placeholder.halfHeight, offset: placeholder.offset },
    ...(players.length > 1 ? { characters: players.slice(1) } : {}),
    statics,
    ...(options.layers !== undefined && options.layers.length > 0 ? { layers: [...options.layers] } : {}),
    ...(first === undefined ? { noCharacter: true as const } : {}),
    solver: { hz: fixedStepHzOf(settings), gravityY: settings.gravity_y },
    controller: placeholder.controller,
    // A runtime starts every run with a rebuilt world: the statics are built then, once.
    buildAtRunStart: true,
  };
}

/** The project settings a player character's physics reads. */
export interface CharacterSettings {
  max_slope_climb_deg: number;
  min_slope_slide_deg: number;
}

/**
 * A player controller's 3D character for the port — its origin, its capsule
 * (the offset's z included) and its tuning: its step-up height (0: off) is
 * the port's autostep, its ground snap at least that height, its slope limit
 * (else the project's) the steepest climb. The one builder for a world's
 * players at creation and a player added while it runs.
 */
export function character3DOf(entity: { id: string; components?: unknown }, settings: CharacterSettings): AddedCharacter3D & { controller: CharacterControllerTuning } {
  const c = (entity.components ?? {}) as Record<string, unknown>;
  const p = (c['transform'] as { position?: readonly number[] } | undefined)?.position ?? [0, 0, 0];
  const capsule = playerCapsuleOf(c['controller']);
  const c3 = character3DPhysicsOf(c['controller'], settings.max_slope_climb_deg);
  return {
    id: entity.id,
    position: { x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0 },
    radius: capsule.radius,
    halfHeight: capsule.halfHeight,
    offset: { x: capsule.offset.x, y: capsule.offset.y, z: controllerCapsuleOffsetZ(c['controller']) },
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

/** A 2D-plane player character with the authored transform the port checks (parented, scaled or tilted ones are refused). */
export interface Character2D extends AddedCharacter2D {
  parentId: string | null;
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

/**
 * A player controller's 2D-plane character for the port — its centre, its
 * capsule, skin, ground snap and autostep (else the defaults) and the
 * project's slope angles. The one builder for a world's players at creation
 * and a player added while it runs.
 */
export function character2DOf(entity: { id: string; parentId?: string | null; components?: unknown }, settings: CharacterSettings): Character2D {
  const c = (entity.components ?? {}) as Record<string, unknown>;
  const transform = c['transform'] as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
  const position = transform?.position ?? [0, 0, 0];
  const capsule = playerCapsuleOf(c['controller']);
  const tuning = playerPhysicsOf(c['controller']);
  return {
    id: entity.id,
    x: position[0] ?? 0,
    y: position[1] ?? 0,
    radius: capsule.radius,
    halfHeight: capsule.halfHeight,
    offset: { x: capsule.offset.x, y: capsule.offset.y },
    parentId: entity.parentId ?? null,
    rotation: (transform?.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
    scale: (transform?.scale ?? [1, 1, 1]) as [number, number, number],
    controller: {
      offsetSkin: tuning.offsetSkin,
      groundSnap: tuning.groundSnap,
      maxSlopeClimbRad: (settings.max_slope_climb_deg * Math.PI) / 180,
      minSlopeSlideRad: (settings.min_slope_slide_deg * Math.PI) / 180,
      autostep: tuning.autostep,
      ...(tuning.autostep ? { autostepHeight: tuning.autostepHeight } : {}),
    },
  };
}

/** What a 2D-plane port is created from (the physics-rapier init config's shape). */
export interface PhysicsInitConfig2D {
  character: Omit<Character2D, 'id' | 'controller'>;
  characters?: readonly Character2D[];
  statics: StaticColliderSpec[];
  solver: { hz: number; gravityY: number };
  controller: CharacterControllerTuning;
  noCharacter?: true;
}

/**
 * The 2D-plane init config of a scene's (resolved) entities — its static
 * colliders (each where it is in the world, turned about Z with it; movers
 * kinematic; one-way platforms) and the player controllers (the first as the
 * port's character, the others as its further characters), with the
 * project's step rate and gravity. Null without a player, unless
 * `options.required`: the project's modules name the 2D backend (a scene
 * loaded later, a prefab or a script brings a player), and the world then
 * starts without a character.
 */
export function physics2DConfigOf(
  entities: readonly EntityV3[],
  settings: CharacterSettings & { gravity_y: number; fixed_step_hz?: number },
  options: { modelColliders?: ModelColliderTable; required?: boolean } = {},
): PhysicsInitConfig2D | null {
  const statics = colliderSpecs2D(entities, options.modelColliders !== undefined ? { modelColliders: options.modelColliders } : undefined);
  const players = entities.filter((e) => (e.components as unknown as Record<string, unknown>)['controller'] !== undefined).map((e) => character2DOf(e, settings));
  const first = players[0];
  if (first === undefined && options.required !== true) return null;
  const placeholder = first ?? character2DOf({ id: '', components: { transform: { position: [0, 0, 0] } } }, settings);
  const { x, y, radius, halfHeight, offset, parentId, rotation, scale, controller } = placeholder;
  return {
    character: { x, y, radius, halfHeight, offset, parentId, rotation, scale },
    ...(players.length > 1 ? { characters: players.slice(1) } : {}),
    statics,
    solver: { hz: fixedStepHzOf(settings), gravityY: settings.gravity_y },
    controller,
    ...(first === undefined ? { noCharacter: true as const } : {}),
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
