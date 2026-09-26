/**
 * Phase 12 (c): the pure parts of the runtime's scene set — what one loaded
 * scene contributes (gameplay zones, spawn markers, static colliders), the
 * root offset of a load, the live tag index that follows loads and unloads,
 * and the exit-zone entry test. No I/O, no three.js.
 */
import { controllerCapsuleOf, controllerTuningOf, resolveSceneHierarchy, validateSceneV4, type CheckpointActivationAppearance, type EntityV3, type TagDefinition } from '@thirdlight/project-model';

import type { StaticColliderSpec, Vec2 } from './ports';
import type { BehaviorTagQuery, GameZoneRole, GameZoneSpec, ModelBounds, PlayerCapsule } from './types';

/** What one scene adds to the running game. */
export interface SceneContribution {
  zones: GameZoneSpec[];
  spawns: { entityId: string; center: Vec2; facing?: 'left' | 'right' }[];
  colliders: StaticColliderSpec[];
}

interface ZoneComponentView {
  role: GameZoneRole;
  size: [number, number];
  safeSpawnId?: string;
  activation?: CheckpointActivationAppearance;
  load?: string[];
  unload?: string[];
  spawnId?: string;
}

/** The zones, spawns and static colliders of a list of (resolved) entities. */
export function sceneContribution(entities: readonly EntityV3[]): SceneContribution {
  const out: SceneContribution = { zones: [], spawns: [], colliders: [] };
  for (const e of entities) {
    const c = e.components as unknown as Record<string, unknown>;
    const t = e.components.transform;
    const zone = c['gameZone'] as ZoneComponentView | undefined;
    if (zone !== undefined) {
      out.zones.push({
        entityId: e.id,
        role: zone.role,
        center: { x: t.position[0], y: t.position[1] },
        half: { x: zone.size[0] / 2, y: zone.size[1] / 2 },
        ...(zone.safeSpawnId !== undefined ? { safeSpawnId: zone.safeSpawnId } : {}),
        ...(zone.activation !== undefined ? { activation: zone.activation } : {}),
        ...(zone.load !== undefined ? { load: Object.freeze([...zone.load]) } : {}),
        ...(zone.unload !== undefined ? { unload: Object.freeze([...zone.unload]) } : {}),
        ...(zone.spawnId !== undefined ? { spawnId: zone.spawnId } : {}),
      });
    }
    if (c['playerSpawn'] !== undefined) {
      // Phase 15.2: the facing travels only when set (left/right).
      const facing = (c['playerSpawn'] as { facing?: string }).facing;
      out.spawns.push({ entityId: e.id, center: { x: t.position[0], y: t.position[1] }, ...(facing === 'left' || facing === 'right' ? { facing } : {}) });
    }
    if (c['controller'] === undefined) {
      const spec = staticColliderOf(e.id, c);
      if (spec !== null) out.colliders.push(spec);
    }
  }
  return out;
}

/**
 * Phase 23.0: the angle about Z (radians) of a transform's `[x, y, z, w]`
 * quaternion — the one rotation a 2D-plane collider takes (the project model
 * keeps a physics entity's rotation about Z only). Exactly 0 for the
 * identity (either sign of `w`), so an unrotated collider keeps its old spec.
 */
export function colliderRotationZ(rotation: readonly number[] | undefined): number {
  if (rotation === undefined) return 0;
  const z = rotation[2] ?? 0;
  const w = rotation[3] ?? 1;
  return z === 0 ? 0 : 2 * Math.atan2(z, w);
}

/**
 * Phase 23.0: the static collider spec of one entity's `collider` component
 * (null without one) — its world XY, the entity's rotation about Z (the
 * editor draws the collider rotated with the entity; before 23.0 every host
 * read a `collider.rotationZ` field the model never had, so physics always
 * got 0), kinematic for a mover, one-way when set. The single place the
 * runtime, the Play preview, the export and the perf harness derive it.
 */
export function staticColliderOf(entityId: string, components: Readonly<Record<string, unknown>>): StaticColliderSpec | null {
  const collider = components['collider'] as { shape?: unknown; oneWay?: boolean } | undefined;
  if (collider === undefined) return null;
  const t = components['transform'] as { position?: readonly number[]; rotation?: readonly number[] } | undefined;
  const position = t?.position ?? [0, 0, 0];
  return {
    entityId,
    shape: collider.shape,
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

/** Ascending entity-id codepoint order (the zone projection order). */
export function byEntityId(a: { entityId: string }, b: { entityId: string }): number {
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

/** Round to the nanometre (keeps a derived length equal to the constant it replaced: 1.8 / 2 − 0.3 is exactly 0.6). */
const nano = (v: number): number => Math.round(v * 1e9) / 1e9;

/**
 * Phase 14.0: the player capsule a `controller` component describes (the
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
 * Phase 15.3: the character-controller tuning the physics port takes from the
 * player's `controller` (its skin, ground snap and autostep; each absent
 * field at its default: 0.01 m, 0.1 m, off). The preview and export hosts
 * build the port's `controller` config from it.
 */
export function playerPhysicsOf(controller: unknown): { offsetSkin: number; groundSnap: number; autostep: boolean; autostepHeight: number } {
  const t = controllerTuningOf(controller);
  return { offsetSkin: t.skin, groundSnap: t.groundSnap, autostep: t.autostep, autostepHeight: t.autostepHeight };
}

/**
 * Phase 15.3: the model bounds a manifest's asset rows carry (model rows with
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

/** Phase 14.0: the capsule's half extent along Y (end caps included), nanometre-rounded (0.9 for the default). */
export function capsuleHalfTotal(capsule: PlayerCapsule): number {
  return nano(capsule.halfHeight + capsule.radius);
}

/**
 * Whether an upright capsule centred at `p` overlaps a zone rectangle (the
 * gameplay §4.2 closed form over a zero-length segment).
 */
export function capsuleInZone(p: Vec2, zone: { center: Vec2; half: Vec2 }, radius: number, halfHeight: number, eps: number): boolean {
  const zx0 = zone.center.x - zone.half.x;
  const zx1 = zone.center.x + zone.half.x;
  const zy0 = zone.center.y - zone.half.y;
  const zy1 = zone.center.y + zone.half.y;
  const dx = Math.max(0, p.x - zx1, zx0 - p.x);
  const dy = Math.max(0, p.y - halfHeight - zy1, zy0 - (p.y + halfHeight));
  const limit = radius - eps;
  return dx * dx + dy * dy < limit * limit;
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
  const res = validateSceneV4(doc);
  if (!res.ok) {
    const first = res.errors[0];
    return { ok: false, message: `scene "${sceneId}" is invalid: ${res.errors.length} error(s)${first ? `; first: ${first.code} at ${first.path}` : ''}` };
  }
  if (res.normalized.sceneId !== sceneId) return { ok: false, message: `the document holds scene "${res.normalized.sceneId}", not "${sceneId}"` };
  return { ok: true, entities: resolveSceneHierarchy(res.normalized).entities as EntityV3[] };
}
