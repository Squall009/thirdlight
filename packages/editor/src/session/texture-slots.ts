/**
 * Per-layer texture slots in the editor's views (the Scene view, the
 * material preview, the graph's problems).
 *
 * The renderer samples arrays only, so a material's slot list is handed to
 * it as one texture key naming the layers and the encoding (`slots:…`, never
 * an asset id), and the view's texture loader fetches that key's array from
 * the backend, which assembles it once and caches it like Play and the
 * export do (`POST …/content/textures/slots`).
 */
import type { MaterialDef } from '@thirdlight/project-model';
import { hasTextureSlots, parseTextureSlotSetKey, textureSlotSetKey, withAssembledSlots, type TextureSlotSet } from '@thirdlight/project-model/texture-slots';
import { resolveMaterialInstancesLike } from '@thirdlight/three-adapter';

/** Marks a view texture key as a slot list's, apart from asset ids (which hold no ':'). */
const PREFIX = 'slots:';

/** The texture key the views know a slot list's array by. */
export function slotTextureKey(set: TextureSlotSet): string {
  return PREFIX + textureSlotSetKey(set);
}

/** A slot list's layers and encoding from its key (null: an ordinary texture asset id). */
export function parseSlotTextureKey(id: string): TextureSlotSet | null {
  return id.startsWith(PREFIX) ? parseTextureSlotSetKey(id.slice(PREFIX.length)) : null;
}

/**
 * The materials as the views draw them: instances resolved and each slot
 * list replaced by its texture key. Without slots, the list itself (the
 * views resolve instances on their own).
 */
export function withSlotTextureKeys<M extends MaterialDef>(materials: readonly M[]): readonly MaterialDef[] {
  const resolved = resolveMaterialInstancesLike(materials as never) as unknown as MaterialDef[];
  if (!hasTextureSlots(resolved)) return materials;
  return withAssembledSlots(resolved, slotTextureKey);
}

/**
 * A graph material's parameters and the textures there are, as its compile
 * problems are checked: slot lists as their keys, a key there when every
 * slot names a texture of the project.
 */
export function slotProblemInput(m: MaterialDef, textureIds: ReadonlySet<string>): { parameters: MaterialDef['parameters']; textureIds: ReadonlySet<string> } {
  const drawn = withSlotTextureKeys([m])[0]!;
  if (drawn === m) return { parameters: m.parameters, textureIds };
  const ids = new Set(textureIds);
  for (const x of drawn.parameters ?? []) {
    const set = typeof x.default === 'string' ? parseSlotTextureKey(x.default) : null;
    if (set !== null && set.layers.every((id) => textureIds.has(id))) ids.add(x.default as string);
  }
  return { parameters: drawn.parameters, textureIds: ids };
}
