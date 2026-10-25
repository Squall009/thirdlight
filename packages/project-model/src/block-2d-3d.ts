/**
 * What a 2D-plane project's gameplay blocks read as on the one 3D physics
 * backend, for the upgrade's Problems list.
 *
 * No block's data moves: the 3D backend reads each 2D form as is. A circle
 * trigger is the sphere of its radius, and an area written `[w, h]` is as
 * deep as it is wide, so on a plane through it the area is the one the 2D
 * plane had. What a game team may want to check is where the 3D reading
 * differs: box triggers and switches test the player's capsule itself (2D
 * tested its bounding box: a corner is reached a little later), an area on
 * a turned object turns with it (2D kept it axis-aligned), and a mover's or
 * patrol's z offsets now move its collision in depth too (2D moved only its
 * look). Each item names its component and the field to check.
 *
 * Pure and total: same input → same output, never throws.
 */
import { isPlainObject } from './validate';

/** The kinds of note, one Problems group each. */
export const BLOCK_3D_CHANGE_KINDS = ['trigger-circle', 'area-depth', 'capsule-test', 'turned-area', 'depth-motion'] as const;
export type Block3DChangeKind = (typeof BLOCK_3D_CHANGE_KINDS)[number];

/** One note: the component, the field (a JSON pointer below the entity) and what it reads as now. */
export interface Block3DChange {
  readonly kind: Block3DChangeKind;
  readonly component: string;
  readonly field: string;
  readonly detail: string;
}

/** The components whose `size` is an area tested against the player (or other bodies). */
const AREA_COMPONENTS = ['trigger', 'switch', 'hitbox', 'collectible', 'climbVolume', 'patrol', 'gravity'] as const;
/** The areas whose box turns with its object in 3D (the 2D plane kept them axis-aligned). */
const TURNING_AREAS = ['trigger', 'switch', 'hitbox', 'collectible'] as const;

const obj = (v: unknown): Record<string, unknown> | null => (isPlainObject(v) ? v : null);
const isBox = (name: string, c: Record<string, unknown>): boolean => (name === 'trigger' ? c['shape'] === undefined || c['shape'] === 'box' : name === 'hitbox' ? c['shape'] !== 'sphere' : true);
const anyDepth = (points: unknown): boolean => Array.isArray(points) && points.some((p) => Array.isArray(p) && typeof p[2] === 'number' && p[2] !== 0);

/** The notes for one entity's components (in a fixed order; a turn is read from its transform). */
export function blocks2DTo3D(components: unknown): Block3DChange[] {
  const comps = obj(components);
  if (comps === null) return [];
  const out: Block3DChange[] = [];
  const q = obj(comps['transform'])?.['rotation'];
  const turned = Array.isArray(q) && !(q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1);
  const trigger = obj(comps['trigger']);
  if (trigger !== null && trigger['shape'] === 'circle') out.push({ kind: 'trigger-circle', component: 'trigger', field: '/components/trigger/shape', detail: `a circle trigger is the sphere of its radius (${String(trigger['radius'] ?? 0.5)} m)` });
  for (const name of AREA_COMPONENTS) {
    const c = obj(comps[name]);
    const size = c?.['size'];
    if (c !== null && Array.isArray(size) && size.length === 2 && isBox(name, c)) out.push({ kind: 'area-depth', component: name, field: `/components/${name}/size`, detail: `[w, h] is as deep as it is wide (${String(size[0])} m)` });
  }
  for (const name of ['trigger', 'switch'] as const) {
    const c = obj(comps[name]);
    if (c !== null && isBox(name, c)) out.push({ kind: 'capsule-test', component: name, field: `/components/${name}/size`, detail: "the box tests the player's capsule, not its bounding box (a corner is reached up to 9 cm later at the default radius)" });
  }
  if (turned) {
    for (const name of TURNING_AREAS) {
      const c = obj(comps[name]);
      if (c !== null && isBox(name, c)) out.push({ kind: 'turned-area', component: name, field: '/components/transform/rotation', detail: `the ${name}'s box turns with the object (the 2D plane kept it axis-aligned)` });
    }
  }
  const mover = obj(comps['mover']);
  if (mover !== null && anyDepth(mover['waypoints'])) out.push({ kind: 'depth-motion', component: 'mover', field: '/components/mover/waypoints', detail: 'a waypoint with a z offset now moves its collision in depth too' });
  const patrol = obj(comps['patrol']);
  if (patrol !== null && (anyDepth(patrol['waypoints']) || anyDepth([patrol['direction']]))) {
    out.push({ kind: 'depth-motion', component: 'patrol', field: anyDepth(patrol['waypoints']) ? '/components/patrol/waypoints' : '/components/patrol/direction', detail: 'a z part now moves it in depth too' });
  }
  return out;
}
