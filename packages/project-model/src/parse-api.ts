/**
 * Byte-input entry points — project-model.md §12.1:
 *
 *   `parseManifest`, `parseSceneV3`, `parseEnvelopeV3` (bytes: Uint8Array)
 *
 * Pure byte-input entry points owned by the project-model package. Run
 * §12.3 pass 1 (strict byte parsing: encoding → syntax → duplicates),
 * then the corresponding value validator (passes 2–4). Return the same
 * result shape as `validate*` (§12.5): `{ ok: true, normalized }` or
 * `{ ok: false, errors }`. Do not mutate or consume the caller's bytes;
 * retaining failed source bytes on disk is the caller/workspace's
 * responsibility (packet 07).
 */

import type { ModelResult, ModelResultV3 } from './errors';
import type { Manifest } from './types';
import type { SceneV3 } from './types-v3';
import { parseDocumentBytes } from './parse-bytes';
import { validateManifest } from './validate';
import { validateSceneV3 } from './scene-v3';
import { validateEnvelopeV3, type EnvelopeV3Load } from './project-v3';

export function parseManifest(bytes: Uint8Array): ModelResult<Manifest> {
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  return validateManifest(parsed.value);
}

/**
 * Packet 44: strict byte parse + the embedded schemaVersion 3 scene validator
 * (`project-model.md` §12.1/§23; there is no standalone v3 interchange
 * file, so this parses the embedded scene value).
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