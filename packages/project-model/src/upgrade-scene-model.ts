/**
 * `project.json` schemaVersion 7: the engine owns the view; scenes hold shots.
 *
 * Up to schemaVersion 6 a start scene held the one scene `camera` entity the
 * game looked through (its lens, where it was placed), and the runtime never
 * unloaded a scene holding the camera or the player. From 7 the camera brain
 * owns the view: every shot is a `virtualCamera` (with or without a lens of
 * its own; absent: the project's lens settings), and an object that survives
 * scene changes carries the `keepLoaded` flag.
 *
 * The loader upgrades a 6 (pure, on the raw documents before they are
 * validated), so a game that played before plays the same:
 * - each scene `camera` becomes a `fixed` virtual camera at the lowest
 *   priority — the view it drew while no other shot was live, from where it
 *   is placed (a parent still carries it). Its lens becomes the project's
 *   lens settings (only where it differs from the engine default, so a
 *   default project keeps its settings), which the shots that left their lens
 *   to "the scene camera's" read now; a camera with another lens keeps its own.
 * - the camera and the player (each start-scene `controller`) were never
 *   unloaded: the object at the top of each one's hierarchy is marked
 *   `keepLoaded`, so unloading their scene keeps them as it did.
 * - a 3D character read its move input along the world axes unless a virtual
 *   camera was loaded (the scene camera never turned it); the shot the scene
 *   camera became would. A 3D project without any virtual camera (scenes and
 *   prefabs) gets `moveFrame: 'world'` on each controller that has none, so
 *   it moves as before. A project with virtual cameras keeps the camera-relative
 *   default: where one of them is live it moved so before.
 *
 * Later format changes of the same version add their step here.
 */
import { VIEW_LENS_DEFAULTS, VIRTUAL_CAMERA_LIMITS } from './cameras';

export interface UpgradeSceneModelResult {
  /** The upgraded documents (deep copies; the inputs are untouched). */
  content: unknown;
  scenes: unknown[];
  /** What the upgrade changed (for the upgrade notes). */
  notes: string[];
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A scene camera's lens, inside a virtual camera's lens limits (a value it lacks: the engine default). */
function lensOf(camera: Obj): { fovY: number; near: number; far: number } {
  const L = VIRTUAL_CAMERA_LIMITS;
  const num = (k: string, d: number): number => (typeof camera[k] === 'number' && Number.isFinite(camera[k]) ? (camera[k] as number) : d);
  const fovY = clamp(num('fovY', VIEW_LENS_DEFAULTS.fovY), L.fovY.min, L.fovY.max);
  const near = clamp(num('near', VIEW_LENS_DEFAULTS.near), L.near.min, L.near.max);
  const far = clamp(num('far', VIEW_LENS_DEFAULTS.far), L.far.min, L.far.max);
  return { fovY, near, far: far > near ? far : Math.min(L.far.max, near * 1000) };
}

/**
 * The shot a scene camera becomes: a `fixed` virtual camera at the lowest
 * priority (the view while no other camera is live, from where it is placed),
 * with the camera's lens where it differs from `projectLens` (absent: always).
 */
export function sceneCameraAsShot(camera: unknown, projectLens?: { fovY: number; near: number; far: number }): { rig: 'fixed'; priority: number; fovY?: number; near?: number; far?: number } {
  const lens = lensOf(isObject(camera) ? camera : {});
  return {
    rig: 'fixed',
    priority: VIRTUAL_CAMERA_LIMITS.priority.min,
    ...(projectLens === undefined || lens.fovY !== projectLens.fovY ? { fovY: lens.fovY } : {}),
    ...(projectLens === undefined || lens.near !== projectLens.near ? { near: lens.near } : {}),
    ...(projectLens === undefined || lens.far !== projectLens.far ? { far: lens.far } : {}),
  };
}

/**
 * A scene's entities with every scene camera read as its shot, its lens kept
 * and kept loaded as the scene camera was (a build or a scene document made
 * before the engine owned the view, as the runtime plays it). Entities
 * without one are returned as they are.
 */
export function sceneCamerasAsShots<T>(entities: readonly T[]): T[] {
  let changed = false;
  const out = entities.map((e) => {
    if (!isObject(e) || !isObject(e['components']) || e['components']['camera'] === undefined || e['components']['virtualCamera'] !== undefined) return e;
    changed = true;
    const { camera, ...rest } = e['components'];
    return { ...e, keepLoaded: true, components: { ...rest, virtualCamera: sceneCameraAsShot(camera) } } as T;
  });
  return changed ? out : [...entities];
}

/** The object at the top of an entity's hierarchy (folders are not objects: they carry nothing). */
function topObject(byId: ReadonlyMap<string, Obj>, e: Obj): Obj {
  let top = e;
  for (let guard = 0; guard < byId.size; guard += 1) {
    const pid = top['parentId'];
    const parent = typeof pid === 'string' ? byId.get(pid) : undefined;
    if (parent === undefined || (isObject(parent['components']) && parent['components']['folder'] !== undefined)) break;
    top = parent;
  }
  return top;
}

/** Upgrade a schemaVersion 6 project's documents to 7 (scene cameras become shots; what was never unloaded keeps loaded). Pure. */
export function upgradeSceneModel(contentIn: unknown, scenesIn: readonly unknown[]): UpgradeSceneModelResult {
  const content = JSON.parse(JSON.stringify(contentIn ?? null)) as unknown;
  const scenes = scenesIn.map((s) => JSON.parse(JSON.stringify(s ?? null)) as unknown);
  const notes: string[] = [];
  const start = new Set(isObject(content) && Array.isArray(content['startScenes']) ? (content['startScenes'] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  // The scene cameras, start scenes first (the one the game looked through decides the project's lens).
  const cameras: { scene: Obj; entity: Obj; inStart: boolean }[] = [];
  for (const s of scenes) {
    if (!isObject(s) || !Array.isArray(s['entities'])) continue;
    for (const e of s['entities'] as unknown[]) {
      if (isObject(e) && isObject(e['components']) && e['components']['camera'] !== undefined) cameras.push({ scene: s, entity: e, inStart: start.has(String(s['sceneId'])) });
    }
  }
  cameras.sort((a, b) => Number(b.inStart) - Number(a.inStart));
  // The project's lens: the first camera's, where it is not the engine default.
  let projectLens: { fovY: number; near: number; far: number } = { ...VIEW_LENS_DEFAULTS };
  const first = cameras[0];
  if (first !== undefined && isObject(content)) {
    const lens = lensOf((first.entity['components'] as Obj)['camera'] as Obj);
    const settings: Obj = isObject(content['settings']) ? (content['settings'] as Obj) : {};
    const set: string[] = [];
    if (lens.fovY !== VIEW_LENS_DEFAULTS.fovY) {
      settings['camera_fov_deg'] = lens.fovY;
      set.push(`field of view ${lens.fovY}°`);
    }
    if (lens.near !== VIEW_LENS_DEFAULTS.near) {
      settings['camera_near_m'] = lens.near;
      set.push(`near ${lens.near} m`);
    }
    if (lens.far !== VIEW_LENS_DEFAULTS.far) {
      settings['camera_far_m'] = lens.far;
      set.push(`far ${lens.far} m`);
    }
    if (set.length > 0) {
      content['settings'] = settings;
      notes.push(`the scene camera's lens became the project's camera settings (${set.join(', ')}), which every camera without a lens of its own uses`);
    }
    projectLens = lens;
  }
  // Whether any virtual camera existed before the scene cameras became shots (a prefab may bring one).
  const hadVirtualCamera = scenes.some((sc) => isObject(sc) && Array.isArray(sc['entities']) && (sc['entities'] as unknown[]).some((e) => isObject(e) && isObject(e['components']) && e['components']['virtualCamera'] !== undefined))
    || (isObject(content) && holdsComponent(content['prefabs'], 'virtualCamera'));
  const turned = cameras.filter((c) => headingTurned(c.entity)).map((c) => `"${String(c.entity['id'])}"`);
  const kept = new Set<Obj>();
  for (const { scene, entity, inStart } of cameras) {
    const comps = entity['components'] as Obj;
    comps['virtualCamera'] = sceneCameraAsShot(comps['camera'], projectLens);
    delete comps['camera'];
    notes.push(`the scene camera "${String(entity['id'])}" (scene "${String(scene['sceneId'])}") became a fixed virtual camera at the lowest priority: the view while no other camera is live, as before`);
    if (inStart) kept.add(topObject(byIdOf(scene), entity));
  }
  // The player: each start scene's controller (the runtime never unloaded it).
  for (const s of scenes) {
    if (!isObject(s) || !Array.isArray(s['entities']) || !start.has(String(s['sceneId']))) continue;
    for (const e of s['entities'] as unknown[]) {
      if (isObject(e) && isObject(e['components']) && e['components']['controller'] !== undefined) kept.add(topObject(byIdOf(s), e));
    }
  }
  const keptIds: string[] = [];
  for (const e of kept) {
    if (e['keepLoaded'] === true) continue;
    e['keepLoaded'] = true;
    keptIds.push(String(e['id']));
  }
  // The move frame: a 3D project's characters read their input as they did.
  if (isObject(content) && isObject(content['settings']) && content['settings']['physics_dimension'] === 3) {
    if (!hadVirtualCamera) {
      const world: string[] = [];
      for (const sc of scenes) {
        if (!isObject(sc) || !Array.isArray(sc['entities'])) continue;
        for (const e of sc['entities'] as unknown[]) {
          if (!isObject(e) || !isObject(e['components']) || !isObject(e['components']['controller'])) continue;
          const c = e['components']['controller'] as Obj;
          if (c['moveFrame'] !== undefined) continue;
          c['moveFrame'] = 'world';
          world.push(`"${String(e['id'])}"`);
        }
      }
      if (world.length > 0) notes.push(`the character${world.length === 1 ? '' : 's'} ${world.join(', ')} move${world.length === 1 ? 's' : ''} along the world axes as before (controller moveFrame "world"; the project had no virtual camera, so the camera never turned the move input)`);
    } else if (turned.length > 0) {
      notes.push(`where no other camera is live, a character now moves relative to the heading of ${turned.join(', ')} (before: along the world axes); set the controller's moveFrame to "world" if that scene needs the old input`);
    }
  }
  if (keptIds.length > 0) notes.push(`${keptIds.map((id) => `"${id}"`).join(', ')} keep${keptIds.length === 1 ? 's' : ''} loaded when ${keptIds.length === 1 ? 'its' : 'their'} scene unloads (the camera and the player were never unloaded before; clear the flag to let them go with their scene)`);
  return { content, scenes, notes };
}

/** Whether a document tree holds an entity with the named component (a prefab's entities, at any depth). */
function holdsComponent(v: unknown, name: string): boolean {
  if (Array.isArray(v)) return v.some((x) => holdsComponent(x, name));
  if (!isObject(v)) return false;
  if (isObject(v['components']) && v['components'][name] !== undefined) return true;
  return Object.values(v).some((x) => typeof x === 'object' && x !== null && holdsComponent(x, name));
}

/** Whether a scene camera looks along any heading but −Z (its view, flattened onto the ground, is turned about Y). */
function headingTurned(entity: Obj): boolean {
  const t = isObject(entity['components']) ? (entity['components'] as Obj)['transform'] : undefined;
  const q = isObject(t) && Array.isArray(t['rotation']) ? (t['rotation'] as unknown[]) : [];
  const [x, y, z, w] = [0, 1, 2, 3].map((i) => (typeof q[i] === 'number' && Number.isFinite(q[i]) ? (q[i] as number) : i === 3 ? 1 : 0)) as [number, number, number, number];
  let fx = -2 * (x * z + w * y);
  let fz = -(1 - 2 * (x * x + y * y));
  if (!(Math.hypot(fx, fz) > 1e-3)) {
    // Looking straight down (or up): the screen's up is the way forward on the ground, as the view reads it.
    fx = 2 * (x * y - w * z);
    fz = 2 * (y * z + w * x);
  }
  return Math.hypot(fx, fz) > 1e-9 && Math.abs(Math.atan2(-fx, -fz)) > 1e-6;
}

const byIdCache = new WeakMap<Obj, Map<string, Obj>>();
function byIdOf(scene: Obj): Map<string, Obj> {
  let m = byIdCache.get(scene);
  if (m === undefined) {
    m = new Map();
    for (const e of scene['entities'] as unknown[]) if (isObject(e) && typeof e['id'] === 'string') m.set(e['id'], e);
    byIdCache.set(scene, m);
  }
  return m;
}
