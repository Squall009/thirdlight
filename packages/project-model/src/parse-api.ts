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

import type { ModelResult } from './errors';
import type { Manifest, Scene } from './types';
import { parseDocumentBytes } from './parse-bytes';
import { validateManifest, validateScene } from './validate';

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