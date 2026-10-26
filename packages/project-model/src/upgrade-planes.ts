/**
 * The schema 8 step that retires the project-wide physics dimension.
 *
 * Every project runs on the one 3D physics backend; "2D" is a plane a body is
 * locked to. A project that was 2D (`physics_dimension` absent or 2) becomes
 * one whose scenes have a default plane (the Z axis at 0, where the 2D plane
 * was), so its bodies stay on the plane they always moved in:
 * - each scene gets `defaultPlane`; a collider or controller without a
 *   `plane` of its own is locked to it (`plane: null` frees one);
 * - its colliders' 2D shapes become their 3D forms (`shape2DTo3D`, the
 *   default depth): a box gets its half depth, a polygon becomes a convex
 *   prism (a concave one a compound of prisms), a circle a cylinder;
 * - its controllers take the `arcade` movement profile, the 2D controller's
 *   behaviour on the 3D controller;
 * - gameplay blocks keep their data (the 3D backend reads their 2D forms);
 *   where the 3D reading differs is noted (`blocks2DTo3D`), as is a block
 *   layer's plane cut, which the 3D backend does not read.
 * A 3D project only loses the setting.
 *
 * Telling the game team what to check: each scene notes what was converted
 * per object (`migratedFrom2D`); the Problems list groups the notes by kind
 * (`migrated2DProblemLines`), and an object's note goes when its component
 * is next saved by an edit (`withMigrationMarksCleared`). Prefabs and the
 * overrides of linked copies are converted too and listed in the upgrade's
 * notes once (a prefab's objects are no scene's).
 *
 * Pure: works on the raw documents before they are validated.
 */
import { blocks2DTo3D } from './block-2d-3d';
import type { PlaneLock } from './plane-lock';
import { colliderDepthOf, DEFAULT_COLLIDER_DEPTH, hasTwoDShape, shape2DTo3D, type Shape3DChange } from './shape-2d-3d';
import { MIGRATED_2D_KINDS, type Migrated2DKind, type Migrated2DMarks } from './migrated-2d';
import { namedList } from './upgrade-linked-copies';
import { createPrefabAssembler } from './prefab-assembly';
import { assemblyPrefabs, linkBodyOverrides3D, prefabLinksConverted } from './upgrade-plane-overrides';
import { isPlainObject } from './validate';

type Obj = Record<string, unknown>;

/** The project setting this step retires. */
export const RETIRED_DIMENSION_SETTING = 'physics_dimension';

/** The plane a 2D project's scenes get: the Z axis at 0, the plane the 2D backend simulated. */
export const UPGRADED_2D_PLANE: Readonly<PlaneLock> = Object.freeze({ axis: 'z', origin: 0 });

const KIND_SET: ReadonlySet<string> = new Set(MIGRATED_2D_KINDS);
const SHAPE_KIND: Readonly<Record<Shape3DChange['to'], Migrated2DKind>> = { box: 'collider:box', prism: 'collider:prism', prisms: 'collider:prisms', cylinder: 'collider:cylinder' };

/** Whether a settings map made the project 2D (the setting absent or anything but 3). */
const was2D = (settings: unknown): boolean => !(isPlainObject(settings) && settings[RETIRED_DIMENSION_SETTING] === 3);

/** A collider in its 3D form (null: unchanged), with its notes. */
function collider3D(collider: unknown, kinds: Migrated2DKind[]): Obj | null {
  if (!isPlainObject(collider)) return null;
  let next: Obj | null = null;
  if (hasTwoDShape(collider['shape'])) {
    const changes: Shape3DChange[] = [];
    const shape = shape2DTo3D(collider['shape'], { depth: colliderDepthOf(collider), plane: 'z' }, changes);
    if (shape !== null) {
      // The depth was what the 2D shapes were made with; the 3D shapes hold it now.
      const { depth: _depth, ...rest } = collider;
      next = { ...rest, shape };
      for (const c of changes) if (!kinds.includes(SHAPE_KIND[c.to])) kinds.push(SHAPE_KIND[c.to]);
    }
  }
  if (collider['oneWay'] === true) kinds.push('collider:one-way');
  return next;
}

/** A controller on the arcade profile (null: it names a profile already). */
function controllerArcade(controller: unknown, kinds: Migrated2DKind[]): Obj | null {
  if (!isPlainObject(controller) || controller['profile'] !== undefined) return null;
  kinds.push('controller:arcade');
  return { ...controller, profile: 'arcade' };
}

const rules = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isPlainObject) : []);
const scatterCollides = (c: Obj): boolean => rules(c['scatter']).some((r) => r['collide'] === true);

/**
 * The scenery an object holds that the 2D backend never collided with and the
 * one backend does (terrain tiles, spline surfaces, generated architecture,
 * scatter copies), and model colliders, which 2D flattened onto the plane.
 */
function sceneryKinds(components: Obj): Migrated2DKind[] {
  const kinds: Migrated2DKind[] = [];
  const terrain = components['terrain'];
  if (isPlainObject(terrain) && (terrain['collision'] !== false || scatterCollides(terrain))) kinds.push('terrain:collides');
  const spline = components['spline'];
  const mesh = isPlainObject(spline) ? spline['mesh'] : undefined;
  if (isPlainObject(mesh) && (mesh['collision'] === true || (mesh['collision'] === undefined && (mesh['kind'] ?? 'surface') === 'surface'))) kinds.push('spline:collides');
  const arch = components['architecture'];
  if (isPlainObject(arch)) {
    const elementCollides = rules(arch['elements']).some((e) => (e['collide'] ?? (e['detail'] !== true)) === true);
    if (elementCollides || rules(arch['outlines']).length > 0 || rules(arch['buildings']).length > 0 || scatterCollides(arch)) kinds.push('architecture:collides');
  }
  const layer = components['blockLayer'];
  if (isPlainObject(layer) && scatterCollides(layer)) kinds.push('blockLayer:scatter-collides');
  const collider = components['collider'];
  if (isPlainObject(collider) && isPlainObject(collider['shape']) && collider['shape']['type'] === 'model') kinds.push('collider:model-parts');
  return kinds;
}

/**
 * One object's components converted (null: unchanged) and its notes, in a
 * fixed order. A prefab's part (`ownPlane`) is in no scene, so its collider
 * and controller name the plane themselves: a copy a script spawns stays on it.
 */
function convertComponents(components: unknown, ownPlane = false): { components: Obj | null; kinds: Migrated2DKind[] } {
  const kinds: Migrated2DKind[] = [];
  if (!isPlainObject(components)) return { components: null, kinds };
  let next: Obj | null = null;
  const onPlane = (c: Obj): Obj => (ownPlane && c['plane'] === undefined ? { ...c, plane: { ...UPGRADED_2D_PLANE } } : c);
  const col = collider3D(components['collider'], kinds);
  const colPlaned = isPlainObject(components['collider']) ? onPlane(col ?? components['collider']) : null;
  if (colPlaned !== null && colPlaned !== components['collider']) next = { ...components, collider: colPlaned };
  const ctlIn = components['controller'];
  const ctl = controllerArcade(ctlIn, kinds);
  const ctlPlaned = isPlainObject(ctlIn) ? onPlane(ctl ?? ctlIn) : null;
  if (ctlPlaned !== null && ctlPlaned !== ctlIn) next = { ...(next ?? components), controller: ctlPlaned };
  const layer = components['blockLayer'];
  if (isPlainObject(layer) && layer['planeZ'] !== undefined) kinds.push('blockLayer:plane-cut');
  for (const k of sceneryKinds(components)) kinds.push(k);
  for (const n of blocks2DTo3D(components)) {
    const kind = `${n.component}:${n.kind}`;
    if (KIND_SET.has(kind) && !kinds.includes(kind as Migrated2DKind)) kinds.push(kind as Migrated2DKind);
  }
  return { components: next, kinds };
}

/** A part's components as a prefab's are converted (the copy's side of a body override diff). */
const partBody3D = (components: Obj): Obj => convertComponents(components, true).components ?? components;

export interface PlanesStepResult {
  content: unknown;
  scenes: unknown[];
  changed: boolean;
  notes: string[];
}

/** The step (see the module comment): the documents unchanged (the same objects) when nothing needs it. */
export function upgradeToPlanes(contentIn: unknown, scenesIn: readonly unknown[]): PlanesStepResult {
  const unchanged: PlanesStepResult = { content: contentIn, scenes: [...scenesIn], changed: false, notes: [] };
  if (!isPlainObject(contentIn)) return unchanged;
  const settings = contentIn['settings'];
  const twoD = was2D(settings);
  const hadSetting = isPlainObject(settings) && settings[RETIRED_DIMENSION_SETTING] !== undefined;
  let content: Obj = contentIn;
  if (hadSetting) {
    const { [RETIRED_DIMENSION_SETTING]: _gone, ...rest } = settings as Obj;
    content = { ...content, settings: rest };
  }
  if (!twoD) {
    return hadSetting ? { content, scenes: [...scenesIn], changed: true, notes: [`the project setting ${RETIRED_DIMENSION_SETTING} (3D) was retired: every project runs on the one 3D physics backend, and 2D is a plane a body or a scene is locked to`] } : unchanged;
  }

  // Prefabs first (the overrides of copies are diffed against their converted form), listed once in the notes.
  const prefabsIn = Array.isArray(content['prefabs']) ? (content['prefabs'] as unknown[]) : [];
  const before = createPrefabAssembler(assemblyPrefabs(prefabsIn));
  const prefabNotes = new Map<Migrated2DKind, string[]>();
  let prefabsChanged = false;
  const prefabs3D = prefabsIn.map((p) => {
    if (!isPlainObject(p) || !Array.isArray(p['entities'])) return p;
    let changed = false;
    const entities = (p['entities'] as unknown[]).map((e) => {
      if (!isPlainObject(e)) return e;
      const r = convertComponents(e['components'], true);
      for (const k of r.kinds) {
        const names = prefabNotes.get(k) ?? [];
        const name = `${String(p['prefabId'])}/${String(e['localId'])}`;
        if (!names.includes(name)) names.push(name);
        prefabNotes.set(k, names);
      }
      if (r.components === null) return e;
      changed = true;
      return { ...e, components: r.components };
    });
    if (!changed) return p;
    prefabsChanged = true;
    return { ...p, entities };
  });
  const nested = prefabLinksConverted(prefabs3D, before, partBody3D);
  let overrides = nested.count;
  if (prefabsChanged || nested.changed) content = { ...content, prefabs: nested.prefabs };
  const after = createPrefabAssembler(assemblyPrefabs(nested.prefabs));

  const scenes = scenesIn.map((sceneIn) => {
    if (!isPlainObject(sceneIn) || !Array.isArray(sceneIn['entities'])) return sceneIn;
    const objects: Record<string, Migrated2DKind[]> = {};
    const entities = (sceneIn['entities'] as unknown[]).map((e) => {
      if (!isPlainObject(e)) return e;
      const comps = e['components'];
      const link = isPlainObject(comps) ? linkBodyOverrides3D(comps['prefab'], before, after, partBody3D) : { link: null, count: 0 };
      overrides += link.count;
      const r = convertComponents(comps);
      if (r.kinds.length > 0 && typeof e['id'] === 'string') objects[e['id']] = r.kinds;
      if (r.components === null && link.link === null) return e;
      return { ...e, components: { ...(r.components ?? (comps as Obj)), ...(link.link !== null ? { prefab: link.link } : {}) } };
    });
    const marks: Migrated2DMarks = { ...(sceneIn['defaultPlane'] === undefined ? { plane: true as const } : {}), ...(Object.keys(objects).length > 0 ? { objects } : {}) };
    return {
      ...sceneIn,
      ...(sceneIn['defaultPlane'] === undefined ? { defaultPlane: { ...UPGRADED_2D_PLANE } } : {}),
      entities,
      ...(marks.plane !== undefined || marks.objects !== undefined ? { migratedFrom2D: marks } : {}),
    };
  });

  const sceneCount = scenes.filter((s) => isPlainObject(s) && isPlainObject(s['migratedFrom2D']) && (s['migratedFrom2D'] as Obj)['plane'] === true).length;
  const notes = [
    `a 2D project (${RETIRED_DIMENSION_SETTING} retired) moved to the one 3D physics backend: ${sceneCount} scene${sceneCount === 1 ? '' : 's'} got a default plane (Z at 0), 2D colliders ${DEFAULT_COLLIDER_DEPTH} m deep, controllers the arcade profile; recorded digests change once`,
    ...[...prefabNotes].map(([kind, names]) => `${MIGRATED_2D_TEXT[kind].what}: ${names.length} prefab part${names.length === 1 ? '' : 's'} — check ${MIGRATED_2D_TEXT[kind].check}: ${namedList(names)}`),
    ...(overrides > 0 ? [`${overrides} override${overrides === 1 ? '' : 's'} of linked prefab copies (a collider or controller field) took the 3D form too`] : []),
  ];
  return { content, scenes, changed: true, notes };
}

/** What a line says per kind: what happened to the objects and the field to check. */
export const MIGRATED_2D_TEXT: Readonly<Record<Migrated2DKind, { readonly what: string; readonly check: string }>> = Object.freeze({
  'collider:box': { what: `2D box colliders became 3D boxes ${DEFAULT_COLLIDER_DEPTH} m deep`, check: '`collider.shape.hz` (half the depth)' },
  'collider:prism': { what: `polygon colliders became convex prisms ${DEFAULT_COLLIDER_DEPTH} m deep`, check: '`collider.shape.points`' },
  'collider:prisms': { what: `concave polygon colliders became compounds of convex prisms ${DEFAULT_COLLIDER_DEPTH} m deep`, check: '`collider.shape.shapes`' },
  'collider:cylinder': { what: `circle colliders became cylinders ${DEFAULT_COLLIDER_DEPTH} m long across the plane`, check: '`collider.shape.height`' },
  'collider:one-way': { what: 'one-way platforms are filtered by the 3D backend (a body lands from above, passes from below and the sides)', check: '`collider.oneWay`' },
  'controller:arcade': { what: 'controllers took the arcade movement profile (the 2D controller\'s behaviour on the 3D controller)', check: '`controller.profile`' },
  'blockLayer:plane-cut': { what: 'block layers collide as 3D blocks: their plane cut is no longer read', check: '`blockLayer.planeZ`' },
  'trigger:trigger-circle': { what: 'circle triggers are the sphere of their radius', check: '`trigger.radius`' },
  'trigger:area-depth': { what: '[w, h] triggers are as deep as they are wide', check: '`trigger.size`' },
  'switch:area-depth': { what: '[w, h] switches are as deep as they are wide', check: '`switch.size`' },
  'hitbox:area-depth': { what: '[w, h] hitboxes are as deep as they are wide', check: '`hitbox.size`' },
  'collectible:area-depth': { what: '[w, h] collectibles are as deep as they are wide', check: '`collectible.size`' },
  'climbVolume:area-depth': { what: '[w, h] climb volumes are as deep as they are wide', check: '`climbVolume.size`' },
  'patrol:area-depth': { what: '[w, h] patrol areas are as deep as they are wide', check: '`patrol.size`' },
  'gravity:area-depth': { what: '[w, h] gravity areas are as deep as they are wide', check: '`gravity.size`' },
  'trigger:capsule-test': { what: 'box triggers test the player\'s capsule, not its bounding box (a corner is reached up to 9 cm later)', check: '`trigger.size`' },
  'switch:capsule-test': { what: 'switches test the player\'s capsule, not its bounding box (a corner is reached up to 9 cm later)', check: '`switch.size`' },
  'trigger:turned-area': { what: 'trigger boxes on turned objects turn with them (2D kept them axis-aligned)', check: '`transform.rotation`' },
  'switch:turned-area': { what: 'switch boxes on turned objects turn with them (2D kept them axis-aligned)', check: '`transform.rotation`' },
  'hitbox:turned-area': { what: 'hitboxes on turned objects turn with them (2D kept them axis-aligned)', check: '`transform.rotation`' },
  'collectible:turned-area': { what: 'collectible areas on turned objects turn with them (2D kept them axis-aligned)', check: '`transform.rotation`' },
  'mover:depth-motion': { what: 'mover waypoints with a z offset move the collision in depth too', check: '`mover.waypoints`' },
  'patrol:depth-motion': { what: 'patrols with a z part move in depth too', check: '`patrol.waypoints` / `patrol.direction`' },
  'terrain:collides': { what: 'terrain collides now (the 2D backend never did): tiles that cross the play plane are solid there', check: '`terrain.collision` (false: scenery only) and its scatter rules\' `collide`' },
  'spline:collides': { what: 'spline surfaces collide now (the 2D backend never did)', check: '`spline.mesh.collision` (false: scenery only)' },
  'architecture:collides': { what: 'generated architecture collides now (the 2D backend never did)', check: 'the elements\' `collide` (false: scenery only)' },
  'blockLayer:scatter-collides': { what: 'block layers\' scatter copies collide now (the 2D backend never did)', check: 'the scatter rules\' `collide` (false: scenery only)' },
  'collider:model-parts': { what: 'model colliders are their model\'s `_COL` parts in 3D (2D flattened them onto the plane): parts off the plane no longer reach it', check: '`collider.shape` and the object\'s depth' },
});

/**
 * The Problems lines of the scenes' open upgrade notes, one per kind (and one
 * for the scenes whose default plane came from the upgrade), each naming the
 * objects (scene ids after them) and the field to check, in a fixed order.
 */
export function migrated2DProblemLines(scenes: readonly unknown[]): string[] {
  const byKind = new Map<Migrated2DKind, string[]>();
  const planes: string[] = [];
  for (const sc of scenes) {
    if (!isPlainObject(sc) || !isPlainObject(sc['migratedFrom2D'])) continue;
    const m = sc['migratedFrom2D'] as Migrated2DMarks;
    const sceneId = String(sc['sceneId']);
    if (m.plane === true) planes.push(sceneId);
    for (const [id, kinds] of Object.entries(m.objects ?? {})) {
      for (const k of kinds) {
        const list = byKind.get(k) ?? [];
        list.push(`${id} (${sceneId})`);
        byKind.set(k, list);
      }
    }
  }
  const lines: string[] = [];
  if (planes.length > 0) lines.push(`${planes.length} scene${planes.length === 1 ? '' : 's'} of a former 2D project (${RETIRED_DIMENSION_SETTING} retired) got a default plane, the Z axis at 0 — check the scene's \`defaultPlane\`: ${namedList(planes)}`);
  for (const kind of MIGRATED_2D_KINDS) {
    const list = byKind.get(kind);
    if (list === undefined) continue;
    const t = MIGRATED_2D_TEXT[kind];
    // The field comes before the names: the Problems log keeps a line's first 256 characters.
    lines.push(`${t.what}: ${list.length} object${list.length === 1 ? '' : 's'} — check ${t.check}: ${namedList(list)}`);
  }
  return lines;
}
