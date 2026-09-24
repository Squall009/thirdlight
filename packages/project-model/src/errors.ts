/**
 * Error model and stable constants — project-model.md §12.5/§12.6/§6.
 *
 * `ERROR_CODES` and the schema-version constants are the single source of
 * truth for consumers (workspace, runtime, exporter, protocol —
 * dependencies.md §3).
 *
 * Packet 20 (M2, project-model.md §12.1/§12.6/§18.9.3): `ERROR_CODES` is
 * extended to the full accepted §12.6 stable set and the version knowledge
 * becomes per-document (`SCHEMA_VERSIONS_BY_DOCUMENT`; the accepted contract
 * names this value `KNOWN_VERSIONS` too). `KNOWN_VERSIONS` keeps its
 * historical name as the same per-document value. The M1 standalone
 * interchange validators (`validateScene`/`parseScene`) stay pinned to
 * schemaVersion 1 (§8: "a standalone interchange file remains schemaVersion
 * 1"); the v2 embedded scene is validated by `validateSceneV2` and
 * `validateProjectV2`.
 */

/** Exact limit names carried by a `limits_exceeded` error (§12.6). */
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
  // v3 additions (§23.10)
  | 'zones'
  | 'player_spawns'
  | 'lights_directional'
  | 'lights_ambient'
  | 'lights_local'
  | 'audio_assets'
  | 'audio_versions'
  | 'texture_assets'
  | 'texture_versions'
  | 'music_assets'
  | 'music_versions'
  | 'game_bytes'
  | 'animation_profile_bytes'
  // presentation.md §41.7.1 (packet 47, CC-44-5): the animation/audio media
  // limits the promoted §18.9.3 enum requires.
  | 'animation_clips'
  | 'animation_tracks'
  | 'animation_track_times'
  | 'animation_clip_duration'
  // phase 9.7: skinned model caps
  | 'skins'
  | 'skin_joints'
  | 'morph_targets'
  | 'audio_pcm_bytes'
  | 'audio_cues'
  | 'overrides'
  | 'request_bytes'
  | 'files'
  | 'file_bytes'
  | 'graph_bytes'
  | 'import_depth'
  | 'imports'
  | 'owned_transforms';

/** The stable error code set (project-model.md §12.6, extended by §18.9.3). */
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
  // v3 additions (project-model.md §23.9, extended by the Gate K repair)
  'game_reference_missing',
  'game_reference_in_use',
  'zone_transform_unsupported',
  'spawn_transform_unsupported',
  'zone_checkpoint_count_invalid',
  'zone_goal_missing',
  'asset_kind_mismatch',
  'game_config_invalid',
  // presentation.md §41.7.2 A / §18.9.3 (packet 47, CC-44-5): the rigid-animation
  // role/profile codes. Stages 3–4 are pure from the envelope; stages 5–6 and
  // the §41.3.3 A1–A6 profile are re-checked by `asset-pipeline` at
  // inspect/publish time against the proposal's real clip list.
  'animation_role_out_of_range',
  'animation_role_duplicate',
  'animation_role_mismatch',
  'animation_role_ambiguous',
  'animation_skin_unsupported',
  'animation_root_motion',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The logical `schemaVersion` known for each document type (§6). The manifest
 * stays `1`; the scene gains `2` in M2. `KNOWN_VERSIONS` is the accepted
 * contract's historical name for this same value (§12.1).
 */
export const SCHEMA_VERSIONS_BY_DOCUMENT = {
  manifest: [1],
  scene: [1, 2, 3],
} as const;

/** Accepted contract §12.1 name for the per-document known-version structure. */
export const KNOWN_VERSIONS = SCHEMA_VERSIONS_BY_DOCUMENT;

/** The standalone interchange scene document is `schemaVersion` 1 (§8). */
export const INTERCHANGE_SCENE_VERSIONS = [1] as const;

/** One validation error (§12.5 shape, M1-compatible). */
export interface ModelError {
  code: ErrorCode;
  path: string;
  message: string;
  found?: unknown;
  expected?: string;
  hint?: string;
  /** `limits_exceeded` only (§10.4): which M1 limit fired. */
  limit?: 'entities' | 'depth';
  /** `schema_version_unsupported` only (§6/§12.5): versions this build knows. */
  knownVersions?: readonly number[];
  /** Project-level (cross-document) errors only (§13). */
  document?: 'manifest' | 'scene';
}

/**
 * The packet-20 v2 error shape: the same §12.5 fields with the full §12.6
 * `limit` vocabulary, the `physics_transform_unsupported`/`behavior_*`
 * `reason`, the §20.3 `current`/`max` limit details and the `content`
 * cross-block document discriminator.
 *
 * A v2 error is a structural superset of the M1 {@link ModelError}, so M1
 * errors flow into v2 error lists unchanged; the reverse is deliberately
 * not assignable, which keeps the M1 consumers (workspace/runtime/exporter)
 * on their accepted narrow shape without any out-of-packet edit.
 */
export type ModelErrorV2 = Omit<ModelError, 'limit' | 'document'> & {
  limit?: LimitName;
  current?: number;
  max?: number;
  reason?: string;
  document?: 'manifest' | 'scene' | 'content';
};

/**
 * The packet-44 v3 error shape: the v2 shape plus the §23.6/§23.9 carry
 * fields a v3 validation or reference check reports. All additive; a v2
 * error is assignable into it unchanged.
 */
export type ModelErrorV3 = ModelErrorV2 & {
  /** `game_reference_in_use` only (§23.6): the deleting/removed closure. */
  entityIds?: string[];
  /** `game_reference_in_use` only (§23.6): JSON Pointer paths, ascending. */
  references?: string[];
  /** `zone_checkpoint_count_invalid` only (§23.9): the offending zone ids. */
  zoneIds?: string[];
  /** Phase 12 (c): the scene a v4 project error belongs to. */
  sceneId?: string;
};

/**
 * The v3 authoring-envelope codes. `envelope_invalid` and
 * `storage_version_unsupported` are the envelope-level reasons of
 * `workspace.md` §§4.3/16.2/16.3 that the model's v3 envelope composition
 * reports for the layers it performs (§23.8 "effective per-document order":
 * `storageVersion` known → combination check → envelope/content key set).
 * They are deliberately kept out of the stable model {@link ERROR_CODES} set
 * (which is the `project-model.md` §12.6 set) — see the packet-44 handoff,
 * contract-change request CC-44-1.
 */
export type EnvelopeV3ErrorCode = ErrorCode | 'envelope_invalid' | 'storage_version_unsupported';

/** One v3 authoring-envelope error (the model error shape, widened codes). */
export type EnvelopeV3Error = Omit<ModelErrorV3, 'code'> & { code: EnvelopeV3ErrorCode };

/**
 * Result shape (§12.5) shared by the parse/validate/normalize entry points:
 *
 * ```text
 * { "ok": true,  "normalized": <doc> }
 * { "ok": false, "errors": [ <error>, … ] }
 * ```
 *
 * Success always carries the CANONICAL (normalized, §12.2) document.
 * Validation is pure and total: same input → same result, never throws on
 * malformed data.
 */
export type ModelResult<T = unknown> =
  | { ok: true; normalized: T }
  | { ok: false; errors: readonly ModelError[] };

/** §12.5 result shape with the v2 {@link ModelErrorV2} error list. */
export type ModelResultV2<T = unknown> =
  | { ok: true; normalized: T }
  | { ok: false; errors: readonly ModelErrorV2[] };

/** §12.5 result shape with the v3 {@link ModelErrorV3} error list. */
export type ModelResultV3<T = unknown> =
  | { ok: true; normalized: T }
  | { ok: false; errors: readonly ModelErrorV3[] };

/**
 * Result of `serializeCanonical`: canonical bytes (§12.2 rule 6) on success;
 * the §12.5 error result on invalid input (contract §12.7 R5: the serializer
 * rejects invalid documents instead of emitting best-effort output). The
 * error list is the v2 shape so v2 documents report their full limit
 * vocabulary; M1 errors are assignable into it unchanged.
 */
export type SerializeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; errors: readonly ModelErrorV2[] };
