/**
 * A prefab edit moves the block footprints of its copies in every scene. The
 * command layer writes the cells of the scene the command ran on (and records
 * them for undo); the copies in the project's other scenes would keep the old
 * cells, so the old blocks would still collide and draw until each copy there
 * was touched. Their cells are written here, in the same transaction, from
 * what each scene shows before and after the prefab change. Undo and redo
 * change the prefabs back and forth, and the cells follow again the same way.
 */
import { writeSceneFootprints, type CommandError, type ContentDocument, type FootprintChunks, type SceneDocument } from '@thirdlight/commands';
import { isPrefabLink, type SceneV4 } from '@thirdlight/project-model';

import { sceneV4Of } from './content-shapes';

export type OtherSceneFootprints = { ok: true; scenes: Map<string, SceneV4>; chunks: FootprintChunks[] } | { ok: false; error: CommandError };

/** The other scenes whose linked copies' footprints a prefab change moved, written again. */
export function otherSceneFootprints(
  scenes: ReadonlyMap<string, SceneV4>,
  /** The scenes the command itself wrote (their cells are the command's). */
  skip: ReadonlySet<string>,
  before: ContentDocument | undefined,
  after: ContentDocument | undefined,
  revision: number,
): OtherSceneFootprints {
  const out = new Map<string, SceneV4>();
  const chunks: FootprintChunks[] = [];
  const prefabsOf = (c: ContentDocument | undefined): unknown => (c as { prefabs?: unknown } | undefined)?.prefabs;
  if (prefabsOf(before) === prefabsOf(after)) return { ok: true, scenes: out, chunks };
  for (const [sceneId, scene] of scenes) {
    if (skip.has(sceneId) || !scene.entities.some((e) => e.components.blockLayer !== undefined)) continue;
    if (!scene.entities.some((e) => isPrefabLink((e.components as { prefab?: unknown }).prefab))) continue;
    const doc = { ...scene, revision } as unknown as SceneDocument;
    const fp = writeSceneFootprints(doc, doc, before, after, undefined);
    if (!fp.ok) return fp;
    if (fp.scene === null) continue;
    out.set(sceneId, { ...sceneV4Of(fp.scene), sceneId });
    chunks.push(...fp.chunks);
  }
  return { ok: true, scenes: out, chunks };
}
