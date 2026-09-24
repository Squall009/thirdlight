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
import type { Manifest } from './types';
import type { ContentCatalogV3, ContentCatalogV4, SceneV3, SceneV4 } from './types-v3';
import { normalizeManifest } from './validate';
import { normalizeSceneV3, validateSceneV4 } from './scene-v3';
import { normalizeContentV3, validateContentV4 } from './content';

/**
 * Emit the §12.2 canonical byte form of a validated manifest (schemaVersion
 * 1, the v3 project manifest), scene (schemaVersion 3 or 4) or content block
 * (v3, or v4 with `startScenes`). The v4 project manifest (schemaVersion 2)
 * has its own writer in the workspace.
 *
 * Document kind is dispatched on the document's own top-level fields: a
 * value carrying `sceneId`/`entities` is a scene (validated as v4 when its
 * `schemaVersion` is 4, else as v3); a value carrying content keys is the
 * content block; anything else is validated as a manifest. Every VALID
 * document dispatches correctly; invalid documents get a meaningful error
 * either way.
 */
export function serializeCanonical(doc: unknown): SerializeResult {
  const obj = typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  const isScene =
    obj !== null &&
    (Object.prototype.hasOwnProperty.call(obj, 'sceneId') || Object.prototype.hasOwnProperty.call(obj, 'entities'));
  const isContent =
    obj !== null &&
    !isScene &&
    ['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust', 'game', 'startScenes'].some((k) =>
      Object.prototype.hasOwnProperty.call(obj, k),
    );
  const res:
    | { ok: true; normalized: Manifest | SceneV3 | SceneV4 | ContentCatalogV3 | ContentCatalogV4 }
    | { ok: false; errors: readonly ModelErrorV2[] } = isScene
    ? obj['schemaVersion'] === 4
      ? validateSceneV4(doc)
      : normalizeSceneV3(doc)
    : isContent
      ? obj !== null && Object.prototype.hasOwnProperty.call(obj, 'startScenes')
        ? validateContentV4(doc)
        : normalizeContentV3(doc)
      : normalizeManifest(doc);
  if (!res.ok) return { ok: false, errors: res.errors };
  return { ok: true, bytes: canonicalBytes(res.normalized) };
}

/** Canonical bytes (§12.2 rule 6) of a canonical document value. */
function canonicalBytes(doc: Manifest | SceneV3 | SceneV4 | ContentCatalogV3 | ContentCatalogV4): Uint8Array {
  // The normalized document is a fresh plain-object graph with fixed key
  // order and only finite numbers, so JSON.stringify is total here.
  return new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
}