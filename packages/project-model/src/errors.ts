/**
 * Error model and stable constants.
 *
 * `ERROR_CODES` and the schema-version constants are the single source of
 * truth for consumers (workspace, runtime, exporter, protocol).
 *
 * The version knowledge is per-document (`SCHEMA_VERSIONS_BY_DOCUMENT`;
 * `KNOWN_VERSIONS` is the same value under the contract's name). The error
 * shapes keep their versioned names (`ModelErrorV2`/`V3`) because the v3/v4
 * validators use them.
 */

/** Exact limit names carried by a `limits_exceeded` error. */
export type LimitName =
  | 'entities'
  | 'tags'
  | 'depth'
  | 'assets'
  | 'asset_versions'
  | 'version_records'
  | 'content_bytes'
  | 'source_bytes'
  | 'nodes'
  | 'meshes'
  | 'primitives'
  | 'materials'
  | 'images'
  | 'textures'
  | 'vertices'
  | 'triangles'
  | 'animations'
  | 'animation_channels'
  | 'clip_duration'
  | 'decoded_bytes'
  | 'prefabs'
  | 'prefab_entities'
  | 'prefab_depth'
  | 'prefab_bytes'
  | 'behaviors'
  | 'properties'
  | 'enum_values'
  | 'declaration_bytes'
  | 'settings_keys'
  | 'colliders'
  | 'collider_vertices'
  | 'collider_vertices_total'
  | 'output_bytes'
  | 'trust_entries'
  // v3 additions
  | 'zones'
  | 'player_spawns'
  | 'lights_directional'
  | 'lights_ambient'
  | 'lights_local'
  | 'audio_assets'
  | 'audio_versions'
  | 'texture_assets'
  | 'texture_versions'
  | 'font_assets'
  | 'font_versions'
  | 'game_bytes'
  | 'animation_profile_bytes'
  // The animation/audio media limits.
  | 'animation_clips'
  | 'animation_tracks'
  | 'animation_track_times'
  | 'animation_clip_duration'
  // Skinned model caps
  | 'skins'
  | 'skin_joints'
  | 'morph_targets'
  | 'audio_cues'
  | 'overrides'
  | 'request_bytes'
  | 'files'
  | 'file_bytes'
  | 'graph_bytes'
  | 'import_depth'
  | 'imports'
  | 'owned_transforms';

/** The stable error code set. */
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
  'version_combination_unsupported',
  'asset_reference_missing',
  'digest_invalid',
  'asset_version_invalid',
  'recipe_invalid',
  'prefab_reference_missing',
  'prefab_component_forbidden',
  'behavior_reference_missing',
  'property_unknown',
  'property_type',
  'property_value',
  'setting_unknown',
  'collider_shape_invalid',
  'controller_count_invalid',
  'physics_transform_unsupported',
  'behavior_source_invalid',
  'behavior_source_duplicate',
  'behavior_source_missing',
  'behavior_source_escape',
  'behavior_source_cycle',
  'behavior_import_forbidden',
  'behavior_import_unpinned',
  'behavior_dynamic_code',
  'behavior_source_limits_exceeded',
  'behavior_compile_timeout',
  'behavior_compile_failed',
  'behavior_output_limits_exceeded',
  'behavior_output_forbidden_content',
  'behavior_declaration_mismatch',
  'behavior_trust_unacknowledged',
  // v3 additions
  'spawn_transform_unsupported',
  'asset_kind_mismatch',
  // The rigid-animation role/profile codes. The role checks that need only
  // the envelope run here; the rest and the animation profile are re-checked
  // by `asset-pipeline` at inspect/publish time against the proposal's real
  // clip list.
  'animation_role_out_of_range',
  'animation_role_duplicate',
  'animation_role_mismatch',
  'animation_role_ambiguous',
  'animation_skin_unsupported',
  'animation_root_motion',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The logical `schemaVersion` known for each document type: the v3
 * project manifest (`1`; the v4 manifest `2` has its own validator) and the
 * v3/v4 scenes. `KNOWN_VERSIONS` is the contract's name for this same value.
 */
export const SCHEMA_VERSIONS_BY_DOCUMENT = {
  manifest: [1],
  scene: [3, 4],
} as const;

/** The contract's name for the per-document known-version structure. */
export const KNOWN_VERSIONS = SCHEMA_VERSIONS_BY_DOCUMENT;

/** One validation error (the base error shape). */
export interface ModelError {
  code: ErrorCode;
  path: string;
  message: string;
  found?: unknown;
  expected?: string;
  hint?: string;
  /** `limits_exceeded` only: which base limit fired. */
  limit?: 'entities' | 'depth';
  /** `schema_version_unsupported` only: versions this build knows. */
  knownVersions?: readonly number[];
  /** Project-level (cross-document) errors only. */
  document?: 'manifest' | 'scene';
}

/**
 * The v2 error shape: the base fields with the full `limit` vocabulary, the
 * `physics_transform_unsupported`/`behavior_*` `reason`, the `current`/`max`
 * limit details and the `content` cross-block document discriminator.
 *
 * A v2 error is a structural superset of {@link ModelError}, so base errors
 * flow into v2 error lists unchanged; the reverse is deliberately not
 * assignable, which keeps consumers of the narrow shape on it.
 */
export type ModelErrorV2 = Omit<ModelError, 'limit' | 'document'> & {
  limit?: LimitName;
  current?: number;
  max?: number;
  reason?: string;
  document?: 'manifest' | 'scene' | 'content';
};

/**
 * The v3 error shape: the v2 shape plus the carry fields a v3 validation or
 * reference check reports. All additive; a v2
 * error is assignable into it unchanged.
 */
export type ModelErrorV3 = ModelErrorV2 & {
  /** The scene a v4 project error belongs to. */
  sceneId?: string;
};

/**
 * The v3 authoring-envelope codes. `envelope_invalid` and
 * `storage_version_unsupported` are the envelope-level reasons the model's
 * v3 envelope composition reports for the layers it performs (in order:
 * `storageVersion` known → combination check → envelope/content key set).
 * They are deliberately kept out of the stable model {@link ERROR_CODES} set.
 */
export type EnvelopeV3ErrorCode = ErrorCode | 'envelope_invalid' | 'storage_version_unsupported';

/** One v3 authoring-envelope error (the model error shape, widened codes). */
export type EnvelopeV3Error = Omit<ModelErrorV3, 'code'> & { code: EnvelopeV3ErrorCode };

/**
 * Result shape shared by the parse/validate/normalize entry points:
 *
 * ```text
 * { "ok": true,  "normalized": <doc> }
 * { "ok": false, "errors": [ <error>, … ] }
 * ```
 *
 * Success always carries the CANONICAL (normalized) document.
 * Validation is pure and total: same input → same result, never throws on
 * malformed data.
 */
export type ModelResult<T = unknown> =
  | { ok: true; normalized: T }
  | { ok: false; errors: readonly ModelError[] };

/** The result shape with the v2 {@link ModelErrorV2} error list. */
export type ModelResultV2<T = unknown> =
  | { ok: true; normalized: T }
  | { ok: false; errors: readonly ModelErrorV2[] };

/** The result shape with the v3 {@link ModelErrorV3} error list. */
export type ModelResultV3<T = unknown> =
  | { ok: true; normalized: T }
  | { ok: false; errors: readonly ModelErrorV3[] };

/**
 * Result of `serializeCanonical`: canonical bytes on success; the error
 * result on invalid input (the serializer rejects invalid documents instead
 * of emitting best-effort output). The error list is the v2 shape so v2
 * documents report their full limit vocabulary; base errors are assignable
 * into it unchanged.
 */
export type SerializeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; errors: readonly ModelErrorV2[] };
