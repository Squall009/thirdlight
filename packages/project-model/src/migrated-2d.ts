/**
 * A scene's notes of what the upgrade of a former 2D project converted
 * (`migratedFrom2D`, written by `upgrade-planes.ts`), kept until the game team
 * has looked at each item: the Problems list shows them grouped by kind, and
 * an object's note for a component goes when an edit saves that component
 * again (`withMigrationMarksCleared`), as does the scene's plane note when its
 * default plane is set.
 */
import type { ModelErrorV2 } from './errors';
import { fieldType, fieldValue, isPlainObject, pointerSegment, unexpectedField } from './validate';

/**
 * What one object's upgrade note says, `<component>:<kind>`: the component
 * whose next edit clears it and the kind of conversion (one Problems line per
 * kind). The block kinds are `blocks2DTo3D`'s.
 */
export const MIGRATED_2D_KINDS = [
  'collider:box',
  'collider:prism',
  'collider:prisms',
  'collider:cylinder',
  'collider:one-way',
  'controller:arcade',
  'blockLayer:plane-cut',
  'trigger:trigger-circle',
  'trigger:area-depth',
  'switch:area-depth',
  'hitbox:area-depth',
  'collectible:area-depth',
  'climbVolume:area-depth',
  'patrol:area-depth',
  'gravity:area-depth',
  'trigger:capsule-test',
  'switch:capsule-test',
  'trigger:turned-area',
  'switch:turned-area',
  'hitbox:turned-area',
  'collectible:turned-area',
  'mover:depth-motion',
  'patrol:depth-motion',
  'terrain:collides',
  'spline:collides',
  'architecture:collides',
  'blockLayer:scatter-collides',
  'collider:model-parts',
] as const;
export type Migrated2DKind = (typeof MIGRATED_2D_KINDS)[number];

/** A scene's upgrade notes: its default plane came from the upgrade (`plane`), and each object's open notes. */
export interface Migrated2DMarks {
  plane?: true;
  objects?: Record<string, Migrated2DKind[]>;
}

/** The Problems code of the upgrade's per-object lines. */
export const MIGRATED_2D_PROBLEM = 'migrated_from_2d';

/** The component a kind's note belongs to (its next edit clears the note). */
export const migratedComponentOf = (kind: Migrated2DKind): string => kind.slice(0, kind.indexOf(':'));

/**
 * The field besides its component whose edit also settles a kind's note: a
 * turned area's note asks for the rotation to be checked, so turning the
 * object settles it too.
 */
const settledAlsoBy = (kind: Migrated2DKind): readonly [string, string] | null => (kind.endsWith(':turned-area') ? ['transform', 'rotation'] : null);

const KINDS: ReadonlySet<string> = new Set(MIGRATED_2D_KINDS);

/** The `migratedFrom2D` field's errors (absent: no notes). */
export function validateMigrated2DMarks(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) {
    errors.push(fieldType(path, v, 'object { plane?: true, objects?: { <entity id>: [kind, …] } }'));
    return;
  }
  for (const k of Object.keys(v)) if (k !== 'plane' && k !== 'objects') errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'plane, objects'));
  if (v['plane'] !== undefined && v['plane'] !== true) errors.push(fieldValue(`${path}/plane`, v['plane'], 'true', 'the scene\'s default plane came from the upgrade'));
  const objects = v['objects'];
  if (objects === undefined) return;
  if (!isPlainObject(objects)) {
    errors.push(fieldType(`${path}/objects`, objects, 'object'));
    return;
  }
  for (const [id, kinds] of Object.entries(objects)) {
    const p = `${path}/objects/${pointerSegment(id)}`;
    if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((k) => typeof k === 'string' && KINDS.has(k)) || new Set(kinds).size !== kinds.length) {
      errors.push(fieldValue(p, kinds, `distinct kinds of ${MIGRATED_2D_KINDS.join(', ')}`, 'an object\'s open upgrade notes'));
    }
  }
}

/** The marks in canonical form (objects by id, kinds in the list's order; empty parts dropped), or null for none. */
export function canonicalMigrated2DMarks(v: unknown): Migrated2DMarks | null {
  if (!isPlainObject(v)) return null;
  const out: Migrated2DMarks = {};
  if (v['plane'] === true) out.plane = true;
  const objects = isPlainObject(v['objects']) ? v['objects'] : {};
  const ids = Object.keys(objects).sort();
  if (ids.length > 0) {
    out.objects = {};
    for (const id of ids) out.objects[id] = MIGRATED_2D_KINDS.filter((k) => (objects[id] as unknown[]).includes(k));
  }
  return out.plane === undefined && out.objects === undefined ? null : out;
}

type Entityish = { id?: unknown; components?: unknown };
type Sceneish = { entities?: readonly unknown[]; defaultPlane?: unknown; migratedFrom2D?: Migrated2DMarks };

const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The scene after an edit, with the notes the edit settled taken off: an
 * object's note for a component whose value the edit changed (or that the
 * edit removed, with the object, or a field `settledAlsoBy` names), and the plane note when the default plane
 * changed. The same scene when nothing was settled. Cost: the marked objects
 * only.
 */
export function withMigrationMarksCleared<S extends Sceneish>(before: Sceneish, after: S): S {
  const marks = after.migratedFrom2D;
  if (marks === undefined) return after;
  let plane = marks.plane;
  if (plane === true && !sameJson(before.defaultPlane, after.defaultPlane)) plane = undefined;
  let objects = marks.objects;
  if (objects !== undefined) {
    const find = (list: readonly unknown[] | undefined, ids: ReadonlySet<string>): Map<string, Entityish> => {
      const m = new Map<string, Entityish>();
      for (const e of list ?? []) if (isPlainObject(e) && typeof e['id'] === 'string' && ids.has(e['id'])) m.set(e['id'], e as Entityish);
      return m;
    };
    const ids = new Set(Object.keys(objects));
    const was = find(before.entities, ids);
    const now = find(after.entities, ids);
    let next: Record<string, Migrated2DKind[]> | null = null;
    for (const [id, kinds] of Object.entries(objects)) {
      const a = now.get(id);
      const b = was.get(id);
      const kept = a === undefined ? [] : kinds.filter((k) => {
        const c = migratedComponentOf(k);
        const ca = isPlainObject(a.components) ? a.components[c] : undefined;
        const cb = b !== undefined && isPlainObject(b.components) ? b.components[c] : undefined;
        if (ca === undefined || !sameJson(ca, cb)) return false;
        const also = settledAlsoBy(k);
        if (also === null) return true;
        const field = (e: Entityish | undefined): unknown => (e !== undefined && isPlainObject(e.components) && isPlainObject(e.components[also[0]]) ? (e.components[also[0]] as Record<string, unknown>)[also[1]] : undefined);
        return sameJson(field(a), field(b));
      });
      if (kept.length === kinds.length) continue;
      next ??= { ...objects };
      if (kept.length === 0) delete next[id];
      else next[id] = kept;
    }
    if (next !== null) objects = Object.keys(next).length > 0 ? next : undefined;
  }
  if (plane === marks.plane && objects === marks.objects) return after;
  const { migratedFrom2D: _old, ...rest } = after;
  const m: Migrated2DMarks = { ...(plane !== undefined ? { plane } : {}), ...(objects !== undefined ? { objects } : {}) };
  return (m.plane !== undefined || m.objects !== undefined ? { ...rest, migratedFrom2D: m } : rest) as S;
}
