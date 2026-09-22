/**
 * Byte-input entry points — project-model.md §12.1:
 *
 *   `parseManifest(bytes: Uint8Array)`, `parseScene(bytes: Uint8Array)`
 *
 * Pure byte-input entry points owned by the project-model package. Run
 * §12.3 pass 1 (strict byte parsing: encoding → syntax → duplicates),
 * then the corresponding value validator (passes 2–4). Return the same
 * result shape as `validate*` (§12.5): `{ ok: true, normalized }` or
 * `{ ok: false, errors }`. Do not mutate or consume the caller's bytes;
 * retaining failed source bytes on disk is the caller/workspace's
 * responsibility (packet 07).
 */

import type { ModelResult, ModelResultV2, ModelResultV3 } from './errors';
import type { Manifest, Scene } from './types';
import type { SceneV2 } from './types-v2';
import type { SceneV3 } from './types-v3';
import { parseDocumentBytes } from './parse-bytes';
import { validateManifest, validateScene } from './validate';
import { validateSceneV2 } from './scene-v2';
import { validateSceneV3 } from './scene-v3';
import { validateEnvelopeV3, type EnvelopeV3Load } from './project-v3';

export function parseManifest(bytes: Uint8Array): ModelResult<Manifest> {
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  return validateManifest(parsed.value);
}

export function parseScene(bytes: Uint8Array): ModelResult<Scene> {
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  return validateScene(parsed.value);
}

/**
 * Packet 20: strict byte parse + the embedded schemaVersion 2 scene validator
 * (project-model.md §12.1; there is no standalone v2 interchange file — the
 * v2 scene is the envelope-embedded value).
 */
export function parseSceneV2(bytes: Uint8Array): ModelResultV2<SceneV2> {
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  return validateSceneV2(parsed.value);
}

/**
 * Packet 44: strict byte parse + the embedded schemaVersion 3 scene validator
 * (`project-model.md` §12.1/§23; like v2 there is no standalone v3
 * interchange file, so this parses the embedded scene value).
 */
export function parseSceneV3(bytes: Uint8Array): ModelResultV3<SceneV3> {
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  return validateSceneV3(parsed.value);
}

/**
 * Packet 44: strict byte parse (§12.3 pass 1) + the model-owned v3
 * authoring-envelope branch (`validateEnvelopeV3`). The workspace's v3 load
 * branch (`workspace.md` §16.4) performs the same parse and delegates the
 * model layers to this entry point.
 */
export function parseEnvelopeV3(bytes: Uint8Array): EnvelopeV3Load {
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) return { ok: false, errors: [parsed.error], count: 1 };
  return validateEnvelopeV3(parsed.value);
}