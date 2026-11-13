/**
 * The schema 8 step that renames the `foliageBend` component to `interactor`.
 *
 * The component's fields (radius, strength, recovery) keep their meaning; the
 * renderer now stamps every object that has it into the interaction field,
 * not only the view's subjects (`interactor.ts`). The rename is made on every
 * object of every scene, on every part of every prefab, and in the overrides
 * of linked copies that change or remove it (`components/foliageBend…`
 * paths). An object that somehow holds both keeps its `interactor` and drops
 * the old one, with a note.
 *
 * Pure: works on the raw documents before they are validated; a project that
 * never used the component is returned as it was.
 */
import { isPlainObject } from './validate';

type Obj = Record<string, unknown>;

const OLD = 'foliageBend';
const NEW = 'interactor';
const OLD_PATH = `components/${OLD}`;

/** An override path with the old component's name replaced (null: it does not name it). */
function renamedPath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  if (path === OLD_PATH) return `components/${NEW}`;
  return path.startsWith(`${OLD_PATH}/`) ? `components/${NEW}${path.slice(OLD_PATH.length)}` : null;
}

/** A linked copy's component with its overrides' paths renamed (null: none named the old component). */
function renamedLink(link: unknown): Obj | null {
  if (!isPlainObject(link) || !Array.isArray(link['overrides'])) return null;
  let changed = false;
  const overrides = (link['overrides'] as unknown[]).map((o) => {
    if (!isPlainObject(o)) return o;
    const path = renamedPath(o['path']);
    if (path === null) return o;
    changed = true;
    return { ...o, path };
  });
  return changed ? { ...link, overrides } : null;
}

/** One object's components with the old component renamed and its copy link's overrides too (null: unchanged). */
function renamedComponents(components: unknown, where: () => string, notes: string[]): Obj | null {
  if (!isPlainObject(components)) return null;
  const link = renamedLink(components['prefab']);
  const has = Object.prototype.hasOwnProperty.call(components, OLD);
  if (!has && link === null) return null;
  const out: Obj = {};
  for (const [k, v] of Object.entries(components)) {
    if (k === OLD) {
      if (Object.prototype.hasOwnProperty.call(components, NEW)) notes.push(`${where()}: had both ${OLD} and ${NEW}; ${NEW} kept, ${OLD} dropped`);
      else out[NEW] = v;
    } else out[k] = k === 'prefab' && link !== null ? link : v;
  }
  return out;
}

/** The entity list with every object's components renamed (null: unchanged). */
function renamedEntities(entities: unknown, where: (e: Obj) => string, notes: string[]): unknown[] | null {
  if (!Array.isArray(entities)) return null;
  let changed = false;
  const out = entities.map((e) => {
    if (!isPlainObject(e)) return e;
    const c = renamedComponents(e['components'], () => where(e), notes);
    if (c === null) return e;
    changed = true;
    return { ...e, components: c };
  });
  return changed ? out : null;
}

/** Rename `foliageBend` to `interactor` everywhere a component is kept (see the file comment). */
export function upgradeInteractor(contentIn: unknown, scenesIn: readonly unknown[]): { content: unknown; scenes: unknown[]; changed: boolean; notes: string[] } {
  const notes: string[] = [];
  let changed = false;
  let renamed = 0;
  let content = contentIn;
  if (isPlainObject(contentIn) && Array.isArray(contentIn['prefabs'])) {
    let prefabsChanged = false;
    const prefabs = (contentIn['prefabs'] as unknown[]).map((p) => {
      if (!isPlainObject(p)) return p;
      const entities = renamedEntities(p['entities'], (e) => `prefab ${String(p['prefabId'] ?? '?')}/${String(e['localId'] ?? '?')}`, notes);
      if (entities === null) return p;
      prefabsChanged = true;
      renamed += 1;
      return { ...p, entities };
    });
    if (prefabsChanged) {
      content = { ...contentIn, prefabs };
      changed = true;
    }
  }
  const scenes = scenesIn.map((scene) => {
    if (!isPlainObject(scene)) return scene;
    const entities = renamedEntities(scene['entities'], (e) => `scene ${String(scene['sceneId'] ?? '?')} object ${String(e['id'] ?? '?')}`, notes);
    if (entities === null) return scene;
    changed = true;
    renamed += 1;
    return { ...scene, entities };
  });
  if (changed) notes.unshift(`the ${OLD} component is now ${NEW} (same fields; every object with it presses foliage, not only the camera's target), renamed in ${renamed} scene or prefab document${renamed === 1 ? '' : 's'}`);
  return { content, scenes: changed ? scenes : [...scenesIn], changed, notes };
}
