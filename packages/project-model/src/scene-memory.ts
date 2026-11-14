/**
 * The memory budget of a scene's objects. A scene holds as many objects as
 * fit in it, never a count: what is bounded is the bytes of its document (its
 * objects and their components, the cells of its block layers aside: a
 * layer's memory is its own), as the scene file stores it, the backend holds
 * it and a game loads it. A big world is several scenes loaded together.
 */
import { serializeCanonical } from './normalize';

/** A scene document's byte budget (an entry of the memory budget table). */
import { SCENE_OBJECT_BUDGET_BYTES } from './quality-levels';
export { SCENE_OBJECT_BUDGET_BYTES };

const bytesCache = new WeakMap<object, { head: string; bytes: Uint8Array }>();

/**
 * A scene document's canonical bytes with its revision masked and its block
 * cells left out, cached per entity array. Scene documents are immutable
 * values: an edit builds a new entity array, so the scene a command starts
 * from is usually the one the previous command produced (and measured), and
 * its bytes are not built again. The cache key also checks the scene's other
 * fields. Null: a document that does not serialize (never a valid one).
 */
export function sceneDocumentBytes(scene: object): Uint8Array | null {
  const entities = (scene as { entities?: unknown }).entities;
  const cacheable = Array.isArray(entities);
  const head = cacheable ? JSON.stringify({ ...scene, entities: null, blocks: null, revision: 0 }) : '';
  if (cacheable) {
    const hit = bytesCache.get(entities);
    if (hit !== undefined && hit.head === head) return hit.bytes;
  }
  const { blocks: _cells, ...rest } = scene as { blocks?: unknown };
  const s = serializeCanonical({ ...rest, revision: 0 });
  if (!s.ok) return null;
  if (cacheable) bytesCache.set(entities, { head, bytes: s.bytes });
  return s.bytes;
}

/** What a scene's objects take against {@link SCENE_OBJECT_BUDGET_BYTES} (0: a document that does not serialize). */
export function sceneObjectBytes(scene: object): number {
  return sceneDocumentBytes(scene)?.length ?? 0;
}
