/**
 * The memory budget of a scene's objects. A scene holds as many objects as
 * fit in it, never a count: what is bounded is the bytes of its document (its
 * objects and their components, the cells of its block layers aside: a
 * layer's memory is its own), as the scene file stores it, the backend holds
 * it and a game loads it. A big world is several scenes loaded together.
 */
import { serializeCanonical } from './normalize';

/**
 * The bytes one scene's document may take: about four times what 16,384
 * plain objects take (a box as createEntity makes it is about 530 bytes).
 */
export const SCENE_OBJECT_BUDGET_BYTES = 32 * 1024 * 1024;

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
