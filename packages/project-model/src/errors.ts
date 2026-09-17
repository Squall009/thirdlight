/**
 * Error model and stable constants — project-model.md §12.5/§12.6/§6.
 *
 * `ERROR_CODES` and `KNOWN_VERSIONS` are the single source of truth for
 * consumers (workspace, runtime, exporter, protocol — dependencies.md §3).
 */

/** The stable M1 error code set (project-model.md §12.6, normative). */
export const ERROR_CODES = [
  'encoding_invalid',
  'json_parse_error',
  'duplicate_key',
  'schema_version_unsupported',
  'field_missing',
  'field_unexpected',
  'field_type',
  'field_value',
  'id_invalid',
  'id_duplicate',
  'reference_missing',
  'hierarchy_cycle',
  'order_parent_before_child',
  'number_not_finite',
  'number_out_of_range',
  'quaternion_invalid',
  'component_unknown',
  'component_missing',
  'component_conflict',
  'camera_count_invalid',
  'limits_exceeded',
  'revision_invalid',
  'manifest_scene_mismatch',
  'no_migration_path',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Schema versions known to M1 (project-model.md §6: M1 known versions `[1]`).
 * Unknown (higher OR lower) ⇒ `schema_version_unsupported`.
 */
export const KNOWN_VERSIONS = [1] as const;

/**
 * One validation error (§12.5 shape).
 *
 * - `path` is a JSON Pointer (RFC 6901); `""` for the document root.
 * - `found` is the offending value (present when it exists and is bounded).
 * - `message` is one actionable sentence, safe for logs; it never embeds
 *   unbounded input values (those go in `found`).
 * - `limit` is present only for `limits_exceeded` (which §10.4 limit fired).
 * - `knownVersions` is present only for `schema_version_unsupported`.
 * - `document` is present only on project-level errors from
 *   `validateProject` (§13); single-document errors do not carry it.
 */
export interface ModelError {
  code: ErrorCode;
  path: string;
  message: string;
  found?: unknown;
  expected?: string;
  hint?: string;
  /** `limits_exceeded` only (§10.4): which limit was exceeded. */
  limit?: 'entities' | 'depth';
  /** `schema_version_unsupported` only (§6/§12.5): versions this build knows. */
  knownVersions?: readonly number[];
  /** Project-level (cross-document) errors only (§13). */
  document?: 'manifest' | 'scene';
}

/**
 * Result shape (§12.5) shared by the parse/validate/normalize entry points:
 *
 * ```text
 * { "ok": true,  "normalized": <doc> }
 * { "ok: false, "errors": [ <error>, … ] }
 * ```
 *
 * Success always carries the CANONICAL (normalized, §12.2) document.
 * Validation is pure and total: same input → same result, never throws on
 * malformed data.
 */
export type ModelResult<T = unknown> =
  | { ok: true; normalized: T }
  | { ok: false; errors: readonly ModelError[] };

/**
 * Result of `serializeCanonical`: canonical bytes (§12.2 rule 6) on success;
 * the §12.5 error result on invalid input (contract §12.7 R5: the serializer
 * rejects invalid documents instead of emitting best-effort output).
 */
export type SerializeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; errors: readonly ModelError[] };