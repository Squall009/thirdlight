/**
 * The pure parts of `ctx.spawn` / `ctx.destroy` — the engine
 * limits, the spawn options a script passes, and the expansion of a project
 * prefab definition into fresh runtime entities. A spawned copy is in the
 * running game only (never in the project, never in a save). No I/O.
 */
import { MAX_ENTITIES_V4, type EntityV3, type PrefabDefinition } from '@thirdlight/project-model';

/**
 * Engine limit: spawns one step may request (every script together), a
 * runtime budget: a spawn costs about 0.1 ms (measured with 16,384 alive), so
 * 64 keep a burst to a few milliseconds of the step; a game that fires more
 * spreads them over steps.
 */
export const MAX_SPAWNS_PER_STEP = 64;
/**
 * Engine limit: spawned entities alive at once (prefab children count): as
 * many as one scene holds, since spawned copies live and draw like a scene's
 * own entities.
 */
export const MAX_LIVE_SPAWNED = MAX_ENTITIES_V4;
/** Runtime ids of spawned entities: `spawn-<n>`, n counting from 1 for the whole game (never reused). */
export const SPAWN_ID_PREFIX = 'spawn-';

/** Where a copy goes (`ctx.spawn(prefabId, options)`). */
export interface SpawnOptions {
  /** World position of the prefab root: `[x, y]` (the root keeps its authored z) or `[x, y, z]`. */
  position: readonly number[];
  /** Root rotation as a quaternion `[x, y, z, w]` (normalized); default: the prefab root's. */
  rotation?: readonly number[];
  /** Root scale, uniform or `[x, y, z]`; default: the prefab root's. */
  scale?: number | readonly number[];
  /** Property values of this copy's root script, over the prefab's own (keys its declaration has). */
  properties?: Readonly<Record<string, unknown>>;
}

/** Resolved root placement. */
export interface SpawnPlacement {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  /** The copy survives scene changes (`keepLoaded` on its root). */
  keepLoaded?: true;
  /** Property values of the root's script for this copy only (checked against its declaration by the caller). */
  properties?: Readonly<Record<string, unknown>>;
}

const LIMIT = 1e6;
const finite = (v: unknown, max = LIMIT): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;

/** Parse a script's spawn options against the definition (null message: ok). */
export function parseSpawnOptions(def: PrefabDefinition, options: unknown): { ok: true; placement: SpawnPlacement } | { ok: false; message: string } {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return { ok: false, message: 'options must be { position, rotation?, scale?, keepLoaded?, properties? }' };
  const o = options as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'position' && k !== 'rotation' && k !== 'scale' && k !== 'keepLoaded' && k !== 'properties') return { ok: false, message: `unknown option "${k}" (position, rotation, scale, keepLoaded, properties)` };
  if (o['keepLoaded'] !== undefined && typeof o['keepLoaded'] !== 'boolean') return { ok: false, message: 'keepLoaded must be true or false' };
  let properties: Record<string, unknown> | undefined;
  if (o['properties'] !== undefined) {
    const p = o['properties'];
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return { ok: false, message: 'properties must be an object of property values ({ key: value })' };
    if (def.entities[0]!.components.behavior === undefined) return { ok: false, message: `prefab "${def.prefabId}" has no script on its root to take properties` };
    // A copy of plain data: the script keeps no handle on what the copy reads.
    properties = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) properties[k] = Array.isArray(v) ? [...(v as unknown[])] : v;
  }
  const root = def.entities[0]!.components.transform;
  const p = o['position'];
  if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3) || !p.every((v) => finite(v))) {
    return { ok: false, message: 'position must be [x, y] or [x, y, z] (finite, |v| <= 1e6)' };
  }
  const position: [number, number, number] = [p[0] as number, p[1] as number, p.length === 3 ? (p[2] as number) : root.position[2]];
  let rotation: [number, number, number, number] = [root.rotation[0], root.rotation[1], root.rotation[2], root.rotation[3]];
  if (o['rotation'] !== undefined) {
    const r = o['rotation'];
    if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => finite(v))) return { ok: false, message: 'rotation must be a quaternion [x, y, z, w]' };
    const n = Math.hypot(r[0] as number, r[1] as number, r[2] as number, r[3] as number);
    if (n < 1e-6) return { ok: false, message: 'rotation must be a non-zero quaternion [x, y, z, w]' };
    rotation = [(r[0] as number) / n, (r[1] as number) / n, (r[2] as number) / n, (r[3] as number) / n];
  }
  let scale: [number, number, number] = [root.scale[0], root.scale[1], root.scale[2]];
  if (o['scale'] !== undefined) {
    const s = o['scale'];
    const ok = (v: unknown): v is number => finite(v, 1e4) && (v as number) > 0;
    if (ok(s)) scale = [s, s, s];
    else if (Array.isArray(s) && s.length === 3 && s.every(ok)) scale = [s[0] as number, s[1] as number, s[2] as number];
    else return { ok: false, message: 'scale must be a positive number or [x, y, z] (<= 1e4)' };
  }
  // A collider needs what the scene rules ask of a physics entity.
  if (def.entities[0]!.components.collider !== undefined) {
    if (Math.abs(rotation[0]) > 1e-6 || Math.abs(rotation[1]) > 1e-6) return { ok: false, message: `prefab "${def.prefabId}" has a collider: rotate it about Z only` };
    if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1) return { ok: false, message: `prefab "${def.prefabId}" has a collider: its scale stays [1, 1, 1]` };
  }
  return { ok: true, placement: { position, rotation, scale, ...(o['keepLoaded'] === true ? { keepLoaded: true as const } : {}), ...(properties !== undefined ? { properties } : {}) } };
}

/**
 * The runtime entities of one copy: `ids[i]` for `def.entities[i]` (document
 * order, parents first), the root placed, children keeping their local
 * transforms. Behavior values naming a localId of the definition (entity
 * references inside the prefab) are remapped to the copy's ids, as the
 * editor's `instantiatePrefab` does. Each carries `prefab` provenance.
 *
 * Typed — with `entityRefKeys` (a behavior's `entityRef`
 * property keys, from its declaration) only those values are remapped, so a
 * text property that happens to spell a localId stays as written. Without
 * it (a behavior the game does not know) every value naming a localId is,
 * as before. The root's script takes the copy's own `properties` over the
 * prefab's values (runtime values: an object property names a live id).
 */
export function expandPrefab(def: PrefabDefinition, ids: readonly string[], placement: SpawnPlacement, entityRefKeys?: (behaviorId: string) => readonly string[] | undefined): EntityV3[] {
  const mapping = new Map<string, string>();
  def.entities.forEach((de, i) => mapping.set(de.localId, ids[i]!));
  return def.entities.map((de, i) => {
    const components = structuredClone(de.components) as unknown as Record<string, unknown>;
    const t = de.components.transform;
    components['transform'] = i === 0
      ? { position: [...placement.position], rotation: [...placement.rotation], scale: [...placement.scale] }
      : { position: [t.position[0], t.position[1], t.position[2]], rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]], scale: [t.scale[0], t.scale[1], t.scale[2]] };
    const behavior = de.components.behavior;
    if (behavior !== undefined) {
      const values: Record<string, unknown> = {};
      const refs = entityRefKeys?.(behavior.behaviorId);
      for (const [k, v] of Object.entries(behavior.values)) values[k] = typeof v === 'string' && mapping.has(v) && (refs === undefined || refs.includes(k)) ? mapping.get(v) : structuredClone(v);
      if (i === 0 && placement.properties !== undefined) for (const [k, v] of Object.entries(placement.properties)) values[k] = structuredClone(v);
      components['behavior'] = { behaviorId: behavior.behaviorId, values };
    }
    components['prefab'] = { prefabId: def.prefabId, localId: de.localId };
    const parentId = de.parentLocalId !== undefined ? mapping.get(de.parentLocalId) : undefined;
    return {
      id: ids[i]!,
      ...(de.name !== undefined ? { name: de.name } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      // Kept: the root carries the flag (its children are kept with it).
      ...(i === 0 && placement.keepLoaded === true ? { keepLoaded: true } : {}),
      components,
    } as unknown as EntityV3;
  });
}
