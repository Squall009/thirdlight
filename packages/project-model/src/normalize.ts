/**
 * Canonical serialization — project-model.md §12.1/§12.2.
 *
 * `serializeCanonical` is the single canonical-bytes source consumers
 * compare for byte identity (the workspace envelope's embedded scene,
 * workspace.md §4.4; the export `snapshot.json` scene part, export.md §3;
 * the runtime snapshot-integrity test, runtime.md §2/§4).
 *
 * Output (§12.2 rule 6): UTF-8, LF, 2-space indentation, no trailing
 * spaces, one trailing newline, no BOM. Numbers are serialized with
 * JavaScript `JSON.stringify` shortest round-trip decimal semantics;
 * `JSON.stringify(x, null, 2)` plus a single trailing `\n` is exactly the
 * required layout.
 *
 * The input is validated first (R5, §12.7): a document containing a
 * non-finite number — or failing any value rule — is rejected with the
 * §12.5 error result; the serializer never emits NaN/Infinity tokens, not
 * even as "best effort". Pure and byte-stable (idempotent in the §12.2
 * sense).
 */

import type { ModelErrorV2, SerializeResult } from './errors';
import type { Manifest, Scene } from './types';
import type { ContentCatalog, SceneV2 } from './types-v2';
import type { ContentCatalogV3, SceneV3 } from './types-v3';
import { normalizeManifest, normalizeScene } from './validate';
import { normalizeSceneV2 } from './scene-v2';
import { normalizeSceneV3 } from './scene-v3';
import { normalizeContent, normalizeContentV3 } from './content';

/**
 * Emit the §12.2 canonical byte form of a validated manifest or scene
 * document.
 *
 * Document kind is dispatched on the document's own top-level fields: a
 * value carrying `sceneId`/`entities` is a scene, anything else is
 * validated as a manifest. Every VALID document dispatches correctly (a
 * valid scene always has `sceneId`+`entities`; a valid manifest has
 * neither); invalid documents get a meaningful error either way.
 */
/**
 * Emit the §12.2 canonical byte form of a validated manifest, scene
 * (schemaVersion 1 or the embedded v2 scene) or content block document.
 *
 * Document kind is dispatched on the document's own top-level fields: a
 * value carrying `sceneId`/`entities` is a scene (validated as v2 when its
 * `schemaVersion` is 2, else as the v1 interchange scene); a value carrying
 * content keys is the content block; anything else is validated as a
 * manifest. Every VALID document dispatches correctly; invalid documents
 * get a meaningful error either way.
 */
export function serializeCanonical(doc: unknown): SerializeResult {
  const obj = typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  const isScene =
    obj !== null &&
    (Object.prototype.hasOwnProperty.call(obj, 'sceneId') || Object.prototype.hasOwnProperty.call(obj, 'entities'));
  const isContent =
    obj !== null &&
    !isScene &&
    ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust', 'game'].some((k) =>
      Object.prototype.hasOwnProperty.call(obj, k),
    );
  const res:
    | { ok: true; normalized: Manifest | Scene | SceneV2 | SceneV3 | ContentCatalog | ContentCatalogV3 }
    | { ok: false; errors: readonly ModelErrorV2[] } = isScene
    ? obj['schemaVersion'] === 3
      ? normalizeSceneV3(doc)
      : obj['schemaVersion'] === 2
        ? normalizeSceneV2(doc)
        : normalizeScene(doc)
    : isContent
      ? obj !== null && Object.prototype.hasOwnProperty.call(obj, 'game')
        ? normalizeContentV3(doc)
        : normalizeContent(doc)
      : normalizeManifest(doc);
  if (!res.ok) return { ok: false, errors: res.errors };
  return { ok: true, bytes: canonicalBytes(res.normalized) };
}

/** Canonical bytes (§12.2 rule 6) of a canonical document value. */
function canonicalBytes(doc: Manifest | Scene | SceneV2 | SceneV3 | ContentCatalog | ContentCatalogV3): Uint8Array {
  // The normalized document is a fresh plain-object graph with fixed key
  // order and only finite numbers, so JSON.stringify is total here.
  return new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
}