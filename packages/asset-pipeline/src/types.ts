/**
 * Public shapes of the bounded GLB importer (project-model.md §18.5–§18.8;
 * assets.md §8 as promoted into the accepted contract; dependencies.md §3).
 *
 * Everything here is **validated, immutable data only**: no file handle, no
 * URL, no staged bytes, no `three.js` object, and no asset identity. The
 * proposal is explicitly non-authoritative — it is never persisted, and no
 * envelope/scene/catalog/history/export value may reference a proposal id
 * (project-model.md §18.1, §18.4).
 */

import type { AssetMetrics, ImportRecipe } from '@thirdlight/project-model';

export type { AssetMetrics, ImportRecipe };

/**
 * presentation.md §41.4.3: the `pcm-wav` recipe member of `ImportRecipeV3`.
 * `profile`/`recipeVersion`/`toolchain` only — no `extensions` key (a WAV has
 * no glTF extensions).
 */
export interface PcmWavRecipe {
  readonly profile: 'pcm-wav';
  readonly recipeVersion: 1;
  readonly toolchain: Readonly<Record<string, string>>;
}

/** presentation.md §41.4.3: the bounded PCM-WAV metrics member (exact key order). */
export interface PcmWavMetrics {
  readonly container: 'riff-wave';
  readonly encoding: 'pcm-s16le';
  readonly channels: 1;
  readonly sampleRate: 48_000;
  readonly bitsPerSample: 16;
  readonly frames: number;
  readonly durationMs: number;
  readonly pcmBytes: number;
  readonly dataChunkBytes: number;
  readonly riffChunkBytes: number;
}

/** §18.8.2 stable diagnostic code set (closed), plus the packet-47 additions. */
export type ImportDiagnosticCode =
  | 'asset_size_exceeded'
  | 'asset_container_invalid'
  | 'asset_json_invalid'
  | 'asset_version_unsupported'
  | 'asset_uri_rejected'
  | 'asset_extension_unsupported'
  | 'asset_compression_unsupported'
  | 'asset_buffer_invalid'
  | 'asset_accessor_invalid'
  | 'asset_accessor_unsupported'
  | 'asset_mesh_invalid'
  | 'asset_primitive_unsupported'
  | 'asset_material_invalid'
  | 'asset_image_invalid'
  | 'asset_image_mime_mismatch'
  | 'asset_texture_invalid'
  | 'asset_animation_invalid'
  | 'asset_node_invalid'
  | 'asset_scene_invalid'
  | 'asset_limits_exceeded'
  | 'asset_empty_model'
  | 'asset_timeout'
  // presentation.md §41.4.4 (packet 47): the `inspectAudio` rejection codes.
  | 'audio_source_bytes_exceeded'
  | 'audio_container_invalid'
  | 'audio_chunk_invalid'
  | 'audio_format_unsupported'
  | 'audio_channel_unsupported'
  | 'audio_sample_rate_unsupported'
  | 'audio_bit_depth_unsupported'
  | 'audio_data_size_invalid'
  | 'audio_empty'
  // presentation.md §41.7.2 A (packet 47): the §41.3.2 stages 3–6 and the
  // §41.3.3 A1–A6 profile, reported by the role-aware `inspectGlb` proposal.
  | 'animation_role_out_of_range'
  | 'animation_role_duplicate'
  | 'animation_role_mismatch'
  | 'animation_role_ambiguous'
  | 'animation_skin_unsupported'
  | 'animation_root_motion';

/**
 * `limits_exceeded` limit vocabulary (project-model.md §18.9.3), plus the two
 * profile byte caps §18.7.2 steps 4/11 and the workspace.md §14 byte table
 * report (`json_chunk_bytes`, `image_bytes`) — see the packet-24
 * contract-change request C24-3.
 */
export type ImportLimitName =
  | 'entities'
  | 'depth'
  | 'assets'
  | 'asset_versions'
  | 'version_records'
  | 'content_bytes'
  | 'source_bytes'
  | 'json_chunk_bytes'
  | 'image_bytes'
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
  // presentation.md §41.7.1 (packet 47): the animation-profile caps (A1/A3/A4/A5)
  // and the single normative PCM byte bound (§41.4.4 stage 11).
  | 'animation_clips'
  | 'animation_tracks'
  | 'animation_track_times'
  | 'animation_clip_duration'
  | 'audio_pcm_bytes';

/**
 * One import diagnostic. `path` is a JSON Pointer into the GLB JSON chunk
 * (`""` for container-level facts); diagnostics never contain file paths,
 * staged bytes or credentials (§18.8.2).
 *
 * The media carry fields below are the documented ones of presentation.md
 * §41.3.2/§41.7.2 A — `animation_role_*` carries `role`/`clipIndex`/`clips`/
 * `matches`, `animation_root_motion` carries `role`/`nodeIndex`/`nodeName`.
 */
export interface ImportDiagnostic {
  readonly code: ImportDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly found?: unknown;
  readonly expected?: string;
  readonly limit?: ImportLimitName;
  /** `animation_role_*`/`animation_root_motion`: the offending role key. */
  readonly role?: string;
  /** `animation_role_out_of_range`: the rejected binding index. */
  readonly clipIndex?: number;
  /** `animation_role_out_of_range`: the version's real clip count. */
  readonly clips?: number;
  /** `animation_role_duplicate`: the two roles sharing the index. */
  readonly roles?: readonly string[];
  /** `animation_role_ambiguous`: how many clips carry the name. */
  readonly matches?: number;
  /** `animation_root_motion`: the offending scene-root node index. */
  readonly nodeIndex?: number;
  /** `animation_root_motion`: that node's name (`""` when unnamed). */
  readonly nodeName?: string;
}

/** The bounded, explicitly non-persistent display summary (§8 `inspection`). */
export interface ImportInspection {
  readonly nodeNames: readonly string[];
  readonly materialNames: readonly string[];
  readonly clipNames: readonly string[];
  readonly sceneCount: number;
  readonly truncated: boolean;
}

/** The caps that were applied to this proposal (§8 `limits`). */
export interface ImportLimits {
  readonly profile: 'gltf-glb';
  readonly recipeVersion: 1;
  readonly sourceBytes: number;
  readonly jsonChunkBytes: number;
  readonly imageBytes: number;
  readonly timeoutMs: number;
  readonly caps: Readonly<Record<string, number>>;
}

/**
 * The bounded result of inspecting staged bytes (assets.md §8). Transient,
 * non-authoritative and never persisted.
 */
export interface ImportProposal {
  /** `p-` + 32 lowercase hex; identifies the proposal for the caller's UI. */
  readonly proposalId: string;
  /** The staged source this proposal describes (`""` in pure inspection mode). */
  readonly stageId: string;
  /** 64 lowercase hex SHA-256 of the supplied bytes. */
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly status: 'ok' | 'rejected';
  /** Present exactly when `status === 'ok'`. */
  readonly kind?: 'model';
  readonly importRecipe: ImportRecipe;
  /** Present exactly when `status === 'ok'`. */
  readonly metrics?: AssetMetrics;
  /** 1–128 characters, no control characters, never an identity. */
  readonly suggestedDisplayName: string;
  readonly inspection: ImportInspection;
  /** At most `M2_GLTF_MAX_DIAGNOSTICS` entries. */
  readonly diagnostics: readonly ImportDiagnostic[];
  /** The true diagnostic count (may exceed `diagnostics.length`). */
  readonly diagnosticCount: number;
  /** Stage TTL expiry; `""` in pure inspection mode (no staged source). */
  readonly expiresAt: string;
  readonly limits: ImportLimits;
}

/**
 * Injected job port (packet 24: "over bytes and injected job ports"). The
 * caller — the workspace service — owns the clock, the proposal identity and
 * cancellation; the importer never reads a clock, a PRNG or an environment
 * variable itself (§18.8.3). Wall time appears only in the bounded timeout
 * and is never persisted.
 */
export interface ImportJobPort {
  /** Monotonic millisecond clock, injected by the caller. */
  now(): number;
  /** True once the caller has cancelled the job. */
  isCancelled(): boolean;
  /** `p-` + 32 lowercase hex, unique per job. */
  proposalId(): string;
  /** The staged source this job describes. */
  stageId(): string;
  /** The stage TTL expiry timestamp for this proposal. */
  expiresAt(): string;
  /** Bounded inspection budget in milliseconds (default 30 000). */
  timeoutMs?: number;
  /** Caller display name to sanitize for `suggestedDisplayName`. */
  suggestedDisplayName?: string;
}

/** presentation.md §41.3.1: one requested role binding (the input shape). */
export interface AnimationRoleBindingInput {
  readonly clipIndex: number;
  readonly clipName: string;
}

/** presentation.md §41.3.1: the three required role bindings, in fixed key order. */
export interface AnimationRolesInput {
  readonly idle: AnimationRoleBindingInput;
  readonly run: AnimationRoleBindingInput;
  readonly airborne: AnimationRoleBindingInput;
}

/**
 * presentation.md §41.3.4: the animated-profile request. The caller supplies
 * the new version-local mapping; the proposal validates it against the real
 * clip list (stages 3–6 of §41.3.2) and then applies the §41.3.3 A1–A6 GLB
 * profile. `entityId` is carried for the caller's reimport context and never
 * interpreted here.
 */
export interface AnimationProfileRequest {
  readonly entityId?: string;
  readonly roles: AnimationRolesInput;
}

/** Options of `inspectGlb`/`prepareImport`. */
export interface ImportOptions {
  readonly profile: 'gltf-glb';
  readonly recipeVersion: 1;
  /** The tools whose version can change the decoded result (§18.5). */
  readonly toolchain: Readonly<Record<string, string>>;
  /** Injected job port. */
  readonly job?: ImportJobPort;
  /** Caller display name used when the job port does not supply one. */
  readonly displayName?: string;
  /**
   * presentation.md §41.3.3: request the animated-model profile. When absent
   * the accepted M2 GLB proposal shape and its `gltf-glb` recipe are
   * byte-unchanged (no role or profile diagnostics are produced).
   */
  readonly animation?: AnimationProfileRequest;
}

/** `prepareImport` always has a job port; the safe independent path does not. */
export type PrepareImportOptions = ImportOptions & { readonly job: ImportJobPort };

/**
 * The persistable proposal facts the metadata digest is taken over — the same
 * shape for a `gltf-glb` and a `pcm-wav` proposal
 * (project-model.md §18.5, presentation.md §41.4.3). Job identity, stage id,
 * expiry, display name and the non-persistent `inspection` lists are excluded.
 */
export interface ImportMetadataFacts {
  readonly status: 'ok' | 'rejected';
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly importRecipe: ImportRecipe | PcmWavRecipe;
  readonly kind?: string;
  readonly metrics?: unknown;
}

// --- audio (`inspectAudio`, presentation.md §41.4) -----------------------------

/** §41.4.4 stage 12: the bounded inspection summary (no sample data). */
export interface AudioImportInspection {
  readonly container: 'riff-wave';
  readonly encoding: 'pcm-s16le';
  /** The two accepted chunk ids, in order (`fmt `, `data`). */
  readonly chunkIds: readonly string[];
  readonly frames: number;
  readonly durationMs: number;
}

/** §41.4.2 caps applied to this proposal, plus the injected job budget. */
export interface AudioImportLimits {
  readonly profile: 'pcm-wav';
  readonly recipeVersion: 1;
  readonly sourceFileBytes: number;
  readonly pcmBytes: number;
  readonly timeoutMs: number;
  readonly caps: Readonly<Record<string, number>>;
}

/**
 * The bounded result of `inspectAudio` (presentation.md §41.4.4). Transient,
 * non-authoritative and never persisted — bytes in, a proposal out.
 */
export interface AudioImportProposal {
  readonly proposalId: string;
  readonly stageId: string;
  /** 64 lowercase hex SHA-256 of the supplied bytes. */
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly status: 'ok' | 'rejected';
  /** Present exactly when `status === 'ok'` (the bytes alone decide). */
  readonly kind?: 'audio';
  readonly importRecipe: PcmWavRecipe;
  /** Present exactly when `status === 'ok'`. */
  readonly metrics?: PcmWavMetrics;
  readonly suggestedDisplayName: string;
  readonly inspection: AudioImportInspection;
  /** At most `M2_GLTF_MAX_DIAGNOSTICS` entries. */
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly diagnosticCount: number;
  readonly expiresAt: string;
  readonly limits: AudioImportLimits;
}

/** Options of `inspectAudio` (mirrors {@link ImportOptions} for the WAV profile). */
export interface AudioImportOptions {
  readonly profile: 'pcm-wav';
  readonly recipeVersion: 1;
  /** Exactly `{ "asset-pipeline": "<the repository pin>" }` (§41.4.3). */
  readonly toolchain: Readonly<Record<string, string>>;
  /** Injected job port (cancellation/deadline); optional in pure mode. */
  readonly job?: ImportJobPort;
  readonly displayName?: string;
}
