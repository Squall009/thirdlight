/**
 * Manifest v2 — the immutable runtime-content identity.
 *
 * `captureManifestV2` is the pure derivation of the v2 delivery manifest from
 * ONE already-captured authoring state (the single acknowledged envelope
 * read): the captured v3 scene, the captured content block
 * (resolved settings, the reachable kind-tagged assets),
 * the resolved media identity and the reachable source-bearing behaviors. It
 * has no I/O, no clock and no randomness — the caller supplies `capturedAt` —
 * so two captures of the same state produce byte-identical documents.
 *
 * v2 moves `manifestVersion` 1 → 2: `assets` rows gain a required
 * `kind ∈ {model, audio}`, and six required keys appear (`gameDigest`,
 * `settingsDigest`, `mediaDigest`, `settings`, `game`, `media`). A v1 document
 * remains readable under its own meaning; a v1 reader must reject a v2 document
 * with `manifest_invalid` (`reason: "manifest_version"`), never silently ignore
 * the new keys.
 *
 * `manifestVersion` 3 has no `game`/`gameDigest` keys and no media `cues`
 * slots: `media` is `{ animation }` and the captured content view is
 * `{assets, prefabs, behaviors, settings, behaviorTrust}`.
 *
 * `manifestVersion` 4: the blocks that grow with a
 * project's content — `materials` (only the ones the game uses),
 * `materialFunctions`, `uiDocuments`, `dialogue` and the instance `buffers`
 * table — leave the capped document for their own content files
 * (`content/sha256/<digest>`, the block's canonical bytes), listed in
 * `contentFiles` by key, digest and length and so bound by the `buildId`.
 * A reader verifies each file against its row and puts the block back under
 * its key (`expandManifestContentFiles` in game-host). A reader refuses any
 * other version.
 *
 * **Canonical ordering (normative).** Every block digest and
 * the `buildId` hash `JSON.stringify(value, null, 2) + "\n"` in the owning
 * contract's key order — NOT sorted-key canonicalization. `settings` is in
 * registry order, `media` in its declared order, the content view in `{assets,
 * prefabs, behaviors, settings, behaviorTrust}` order and the manifest in `MANIFEST_KEYS_V2` order
 * (`buildId` last). A `null` block hashes its own four canonical bytes (`null`).
 *
 * This module is in the zero-dependency `project-model` leaf (the single
 * pure owner of the manifest derivation); it reuses the canonical helpers
 * and the `./sha256` digest primitives.
 */
import { canonicalSaveSchema, validateSaveSchema, type SaveSchema } from './save-schema';
import { canonicalBlockTypes, canonicalCellFields, validateBlockTypes, validateCellFields, type BlockType, type CellField } from './block-layers';
import { canonicalEnvironment, canonicalMaterialMapping, canonicalMaterials, validateEnvironment, validateMaterials, type EnvironmentConfig, type MaterialDef, type SceneEnvironment } from './materials';
import { canonicalAnimators, validateAnimators, type AnimatorController } from './animator';
import { validateModelRig, type ModelRig } from './model-rig';
import { validateModelColliderTable, type ModelColliderTable } from './model-collision';
import { canonicalInput, projectInputMaps, validateInput, type InputConfig } from './input';
import { validateCollisionLayers } from './components';
import { canonicalLighting, validateLighting, type LightingMap } from './lighting';
import { sha256Hex, sha256HexOfText } from './sha256';
import { canonicalGraphDocuments, graphDocumentsContext, validateGraphDocuments, type GraphDocument } from './graph';
import { GRAPH_KINDS } from './graph-kinds';
import { canonicalEffects, validateEffects, type EffectDef } from './effects';
import { canonicalUiDocuments, canonicalUiThemes, validateUiDocuments, validateUiThemes, type UiDocument, type UiTheme } from './ui-documents';
import { canonicalModes, validateModes, type GameMode } from './modes';
import { fail, isPlainObject, withFound } from './validate';
import { runtimeDialogueDataProblem, type RuntimeDialogueData } from './dialogue';
import { canonicalTimelines, validateTimelines, type TimelineAsset } from './timelines';
import { canonicalEventCues, validateEventCues, type EventCue } from './event-cues';
import { canonicalShell, validateShell, type GameShell } from './shell';
import { validateMergedSceneV4, validateSceneV3, validateSceneV4 } from './scene-v3';
import { canonicalPrefabs, validateContentV3, validateContentV4, validatePrefabDefinitions, resolveGameplaySettings, validateTagRegistry } from './content';
import { collectAssetRefsV3 } from './capture';
import { knownSceneEntities, rememberSceneEntities, viewDigestOf, viewRowOf } from './view-memo';
import { loadableRowsProblem, type LoadableRow } from './loadable';
import type { ModelErrorV2, ModelResultV2 } from './errors';
import type {
  AssetKind,
  AssetRecordV3,
  ContentCatalogV3,
  SceneV3,
  TagDefinition,
  ContentCatalogV4,
} from './types-v3';
import type { GameplaySettings, PrefabDefinition } from './types-v2';
import {
  buildOptionsRecordBytes,
  M2_ENGINE_PINS,
  M2_MODULE_PACKAGES,
  MANIFEST_CONTENT_FILE_MAX_BYTES,
  RUNTIME_CONTENT_MANIFEST_MAX_BYTES,
  RUNTIME_CONTENT_TYPE,
  type ManifestBehaviorInput,
} from './manifest';
// ---------------------------------------------------------------------------
// Constants (see v1-v2-rules.json)
// ---------------------------------------------------------------------------

/** The manifest shape version (3, without the game block and cue slots; 4, content files). */
export const RUNTIME_CONTENT_MANIFEST_VERSION_4 = 4 as const;

/**
 * The blocks that ride in their own content files, in their
 * `contentFiles` order. Each file is the block's canonical JSON bytes
 * (`JSON.stringify(block, null, 2) + "\n"`) at `content/sha256/<digest>`.
 */
export const MANIFEST_CONTENT_FILE_KEYS = ['materials', 'materialFunctions', 'uiDocuments', 'dialogue', 'buffers'] as const;
export type ManifestContentFileKey = (typeof MANIFEST_CONTENT_FILE_KEYS)[number];

/** One `contentFiles` row. */
export interface ManifestContentFileRow {
  key: ManifestContentFileKey;
  path: string;
  digest: string;
  byteLength: number;
}

/** A content file of a capture (its row and its bytes). */
export interface ManifestContentFile extends ManifestContentFileRow {
  bytes: Uint8Array;
}

export { MANIFEST_CONTENT_FILE_MAX_BYTES };

/**
 * One shared script library module (`libraries/<outputDigest>.js`)
 * the behaviors import by that path; listed so the buildId covers its bytes
 * and hosts serve and ship it.
 */
export interface ManifestLibraryRow {
  libraryId: string;
  sourceDigest: string;
  outputDigest: string;
  outputByteLength: number;
  path: string;
}

/** One scene artifact of a v4 project. */
export interface ManifestSceneRow {
  sceneId: string;
  path: string;
  digest: string;
  byteLength: number;
  /** Loaded when the game starts. */
  start: boolean;
}

/** Keys present only when they apply: tags, scenes, buffers. */
const OPTIONAL_MANIFEST_KEYS = new Set(['tags', 'effects', 'environment', 'lighting', 'animators', 'rigs', 'modelColliders', 'prefabs', 'blockTypes', 'cellFields', 'input', 'collisionLayers', 'saveSchema', 'uiThemes', 'timelines', 'eventCues', 'shell', 'modes', 'scenes', 'contentFiles', 'libraries', 'loadable']);

/** The v2 manifest keys in their exact canonical order (`buildId` last). */
export const MANIFEST_KEYS_V2 = [
  'manifestVersion',
  'type',
  'projectId',
  'revision',
  'snapshotId',
  'capturedAt',
  'sceneDigest',
  'contentDigest',
  'settingsDigest',
  'mediaDigest',
  'settings',
  'tags',
  // Materials and material functions are content files (`contentFiles`).
  // The visual effects (particle system graphs) the game plays.
  'effects',
  'environment',
  'lighting',
  'animators',
  // Model rigs (nodes and node animation channels) sockets are resolved on — only in a project that uses sockets.
  'rigs',
  // The models' `_COL` parts colliders `{type: 'model'}` are made of — only when a collider names its model.
  'modelColliders',
  'prefabs',
  // The block types and the cell metadata schema block layers use.
  'blockTypes',
  'cellFields',
  'input',
  // The named collision layers (3D physics; only when the project names some).
  'collisionLayers',
  // The project save schema (only when the project declares one).
  'saveSchema',
  // The project UI themes the game host draws (the documents are a content file).
  'uiThemes',
  // The game modes (the runtime switches them; the host reads their pause screens).
  'modes',
  // The timelines (sequencer assets) the game plays.
  'timelines',
  // The event → cue table (sounds the host plays for signals and events; only when the project has one).
  'eventCues',
  // The game shell (menus and HUD documents, the ordered scene list; only when the project has one).
  'shell',
  // The scene artifacts (dialogue data is a content file, under `contentFiles`).
  'scenes',
  // The blocks in their own content files (materials, materialFunctions, uiDocuments, dialogue, buffers).
  'contentFiles',
  'assets',
  // The catalog of what scripts may load by address or label (id, kind, address, labels; only when there is some).
  'loadable',
  'media',
  'behaviors',
  // The script libraries as shared modules (`libraries/<outputDigest>.js`) the behaviors import.
  'libraries',
  'modules',
  'enginePins',
  'recipes',
  'toolchain',
  'buildOptionsDigest',
  'buildId',
] as const;


/**
 * The shared-composition engine pins. The identity values are the pin table
 * for the shared production composition; the closure builder re-derives the
 * emitted set from the real lockfile pin table at build time and passes it
 * explicitly. Ascending by `id`.
 */
export const M3_ENGINE_PINS: ReadonlyArray<{ id: string; version: string; apiVersion: number }> = Object.freeze([
  Object.freeze({ id: '@thirdlight/runtime', version: '0.1.0', apiVersion: 2 }),
  Object.freeze({ id: '@thirdlight/three', version: '0.186.1', apiVersion: 0 }),
]);

/** The package a known module id belongs to (the manifest `modules` rows). */
export const M3_MODULE_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  'thirdlight.character:controller': '@thirdlight/character',
  // The 3D physics backend (physics_dimension 3).
  'thirdlight.physics-rapier:3d': '@thirdlight/physics-rapier',
  // The 3D character controller (a runtime built-in).
  'thirdlight.character3d:controller': '@thirdlight/runtime',
});

/** The engine module IDs this model version knows (ascending). */
export const M3_KNOWN_MODULE_IDS: readonly string[] = Object.freeze(Object.keys(M3_MODULE_PACKAGES).sort());

/** The recipe table: each import profile's version. */
export const M3_RECIPE_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  audio: 1,
  'behavior-source': 1,
  'gltf-glb': 1,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One resolved, kind-tagged asset row of the captured v3 content view. */
export interface CapturedAssetV3 {
  assetId: string;
  kind: AssetKind;
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
  /** The recipe identity `{id, version}` (the deprecated `recipeDigest` derives from it). */
  recipe: { id: string; version: number };
  metricsDigest: string;
  /** Model only: COLOR_0 multiplies the albedo (absent = shader data). */
  vertexColors?: 'tint';
  /** Model only: the default material mapping. */
  materials?: Record<string, string>;
  /** Model only: the texture asset each extracted image became (image index → texture assetId). */
  textures?: Record<string, string>;
  /** Model only: an animation-only file whose clips play on this model asset's rig. */
  clipsFor?: string;
  /** Model only: the version's recorded bounds (absent for versions imported before). */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/** The captured v3 content view (the `contentDigest` preimage). */
export interface CapturedContentViewV3 {
  assets: CapturedAssetV3[];
  prefabs: unknown[];
  behaviors: unknown[];
  /** The resolved six-key gameplay settings, in registry order. */
  settings: GameplaySettings;
  behaviorTrust: unknown;
  /** `sha256(JSON.stringify({assets,prefabs,behaviors,settings,behaviorTrust},null,2)+"\n")`. */
  contentDigest: string;
}

/** One `modelAnimation` entity row of the media identity. */
export interface MediaAnimationRow {
  entityId: string;
  assetId: string;
  version: number;
  /** `sha256(JSON.stringify(roles, null, 2) + "\n")` — the canonical roles bytes. */
  profileDigest: string;
  roles: Record<string, unknown>;
}

/** The resolved media identity block (`media`). */
export interface MediaBlock {
  animation: MediaAnimationRow[];
}

/**
 * One resolved asset row accepted by `captureManifestV2`. The `recipeDigest`
 * is derived from `recipe` when not supplied (the deprecated manifest row
 * carries the digest, not the object); `metricsDigest` is caller-supplied
 * (derived from the asset record's metrics by the captured-view derivation).
 */
export interface ManifestAssetInputV2 {
  assetId: string;
  kind: AssetKind;
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
  recipe?: { id: string; version: number };
  recipeDigest?: string;
  metricsDigest: string;
  /** Model only: COLOR_0 multiplies the albedo (absent = shader data). */
  vertexColors?: 'tint';
  /** Model only: the default material mapping. */
  materials?: Record<string, string>;
  /** Model only: the texture asset each extracted image became (image index → texture assetId). */
  textures?: Record<string, string>;
  /** Model only: an animation-only file whose clips play on this model asset's rig. */
  clipsFor?: string;
  /** Model only: the version's recorded bounds (the runtime's pickups without a size read them). */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  /** Audio: the version's recorded duration, ms (script sounds' ends are computed from it). */
  durationMs?: number;
  /** Audio: how the game holds the file and whether it is read with its scene (defaults applied). */
  loadType?: import('./audio-assets').AudioLoadType;
  preload?: boolean;
  /**
   * Texture: a streamed KTX2's parts (`ktx2-levels.ts`: the head with the
   * mip tail, then one part per larger level), each a file of its own.
   */
  mipParts?: readonly ManifestMipPart[];
}

/** One part of a streamed texture as the catalog lists it (its file by digest, the levels in it). */
export interface ManifestMipPart {
  digest: string;
  byteLength: number;
  /** Where the part starts in the whole KTX2 file. */
  offset: number;
  /** Mip levels (0 = largest) whose data lie in this part. */
  levels: readonly number[];
}

/** The v2 manifest document (field order = `MANIFEST_KEYS_V2`; `buildId` last). */
export interface RuntimeContentManifestV2 {
  manifestVersion: number;
  type: string;
  projectId: string;
  revision: number;
  snapshotId: string;
  capturedAt: string;
  sceneDigest: string;
  contentDigest: string;
  settingsDigest: string;
  mediaDigest: string;
  settings: GameplaySettings;
  /** The tag registry, present only when non-empty. */
  tags?: TagDefinition[];
  /** The visual effects (present only when the project has some). */
  effects?: EffectDef[];
  /** The project UI themes (present only when the project has some). */
  uiThemes?: UiTheme[];
  /** The game modes (present only when the project has some). */
  modes?: GameMode[];
  /** The timelines (present only when the project has some). */
  timelines?: TimelineAsset[];
  /** The event → cue table (present only when the project has one). */
  eventCues?: EventCue[];
  /** The game shell (present only when the project has one). */
  shell?: GameShell;
  /** The prefab definitions scripts spawn. */
  prefabs?: PrefabDefinition[];
  /** A v4 project's scene artifacts. */
  scenes?: ManifestSceneRow[];
  /** The content files (present only when the game has one of their blocks). */
  contentFiles?: ManifestContentFileRow[];
  assets: ReadonlyArray<Record<string, unknown>>;
  /** What scripts may load by address or label. */
  loadable?: ReadonlyArray<LoadableRow>;
  media: MediaBlock;
  behaviors: ReadonlyArray<Record<string, unknown>>;
  /** The shared script library modules (present only when a behavior imports a library). */
  libraries?: ManifestLibraryRow[];
  modules: ReadonlyArray<Record<string, unknown>>;
  enginePins: ReadonlyArray<Record<string, unknown>>;
  recipes: Record<string, number>;
  toolchain: Record<string, unknown>;
  buildOptionsDigest: string;
  buildId: string;
}

export interface ManifestErrorV2 {
  code: string;
  cls: 'validation' | 'conflict' | 'internal' | 'unavailable';
  message: string;
  reason?: string;
  found?: unknown;
  expected?: string;
}

/**
 * A manifest with its content files read back under their keys
 * (what a reader works with after `expandManifestContentFiles`).
 */
export type ExpandedRuntimeContentManifest = RuntimeContentManifestV2 & {
  materials?: MaterialDef[];
  materialFunctions?: GraphDocument[];
  uiDocuments?: UiDocument[];
  dialogue?: RuntimeDialogueData;
  buffers?: { digest: string; byteLength: number }[];
};

export type CaptureManifestV2Result =
  | { ok: true; manifest: RuntimeContentManifestV2; bytes: Uint8Array; buildId: string; contentFiles: ManifestContentFile[] }
  | { ok: false; error: ManifestErrorV2 };

// ---------------------------------------------------------------------------
// Digest primitives
// ---------------------------------------------------------------------------

const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * The block digest: `sha256(JSON.stringify(value,
 * null, 2) + "\n")` in the value's own key order. A `null` value serializes to
 * the four bytes `null`, so a null block hashes `null\n`.
 */
export function blockDigest(value: unknown): string {
  return sha256HexOfText(`${JSON.stringify(value, null, 2)}\n`);
}

/** The `profileDigest` of a canonical roles map (the media animation row). */
export function mediaProfileDigest(roles: Record<string, unknown>): string {
  return blockDigest(roles);
}

function manifestError(code: string, message: string, reason?: string, found?: unknown, expected?: string): ManifestErrorV2 {
  const cls =
    code === 'manifest_invalid' || code === 'asset_kind_mismatch'
      ? 'validation'
      : code === 'internal'
        ? 'internal'
        : 'validation';
  return {
    code,
    cls,
    message: message.slice(0, 256),
    ...(reason !== undefined ? { reason } : {}),
    ...(found !== undefined ? { found } : {}),
    ...(expected !== undefined ? { expected } : {}),
  };
}

/** A copy of recorded model bounds (canonical key order). */
function boundsCopy(b: { min: readonly number[]; max: readonly number[] }): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [b.min[0]!, b.min[1]!, b.min[2]!], max: [b.max[0]!, b.max[1]!, b.max[2]!] };
}

/**
 * A version's metrics digest, once per metrics object: the model's records
 * are frozen and replaced, never changed in place, so a frozen object's
 * digest never changes (a build of 18,000 assets hashes only what changed).
 */
const metricsDigests = new WeakMap<object, string>();
/** `sha256`: a host's native SHA-256 (the same digest as `blockDigest`, made faster: a first build hashes every shipped asset's metrics). */
function metricsDigestOf(metrics: unknown, sha256?: (bytes: Uint8Array) => string): string {
  const digest = (): string => (sha256 !== undefined ? sha256(new TextEncoder().encode(`${JSON.stringify(metrics, null, 2)}\n`)) : blockDigest(metrics));
  if (typeof metrics !== 'object' || metrics === null || !Object.isFrozen(metrics)) return digest();
  let d = metricsDigests.get(metrics);
  if (d === undefined) {
    d = digest();
    metricsDigests.set(metrics, d);
  }
  return d;
}

/** A recipe's digest (`{id, version}`: a handful per engine), once each. */
const recipeDigests = new Map<string, string>();
function recipeDigestOf(recipe: { id: string; version: number }): string {
  const key = `${recipe.id}@${recipe.version}`;
  let d = recipeDigests.get(key);
  if (d === undefined) {
    d = blockDigest({ id: recipe.id, version: recipe.version });
    recipeDigests.set(key, d);
  }
  return d;
}

/** The six resolved settings keys in registry order. */
export const M3_SETTINGS_KEYS = [
  'gravity_y',
  'run_speed',
  'jump_velocity',
  'max_fall_speed',
  'max_slope_climb_deg',
  'min_slope_slide_deg',
] as const;

/**
 * The optional engine settings that may follow the six (only
 * when the project sets them), in registry order — a project that never sets
 * one keeps its exact settings block and digests.
 */
export const M3_OPTIONAL_SETTINGS_KEYS = ['fixed_step_hz', 'audio_voices', 'music_fade_s', 'animation_crossfade_s', 'render_backend', 'physics_dimension', 'sim_thread', 'debug_console', 'random_seed', 'depth_buffer', 'instance_chunk_m', 'audio_spatial', 'texture_budget_mb', 'camera_fov_deg', 'camera_near_m', 'camera_far_m'] as const;

// ---------------------------------------------------------------------------
// Media identity (`media`)
// ---------------------------------------------------------------------------

/**
 * `resolveMediaIdentityV3(scene, content)` — the resolved media identity of ONE
 * captured v3 state (the C35-2 rationale). Pure over the
 * normalized (or raw, validated here) scene + content:
 *
 *   - `animation`: one row per `modelAnimation` entity, ascending by
 *     `entityId` then `assetId`, each carrying the immutable `(assetId,
 *     version)`, the `profileDigest` of its canonical `roles` bytes and the
 *     validated `roles` map.
 *
 * An animation reference that resolves to no catalog record (or a record of
 * the wrong `kind`, or an absent version) fails `asset_reference_missing` /
 * `asset_kind_mismatch` / `asset_version_invalid` before any capture.
 */
/** Every scene's validated entities, in order (a scene validated before with the same frozen fields is not validated again). */
function allSceneEntities(allScenes: readonly unknown[]): { ok: true; entities: SceneV3['entities'] } | { ok: false; errors: ModelErrorV2[] } {
  const entities: SceneV3['entities'] = [];
  for (const doc of allScenes) {
    const known = knownSceneEntities(doc);
    if (known !== null) {
      entities.push(...known);
      continue;
    }
    const r = validateSceneV4(doc);
    if (!r.ok) return { ok: false, errors: r.errors as ModelErrorV2[] };
    rememberSceneEntities(doc, r.normalized.entities as SceneV3['entities']);
    entities.push(...(r.normalized.entities as SceneV3['entities']));
  }
  return { ok: true, entities };
}

export function resolveMediaIdentityV3(scene: unknown, content: unknown, allScenes?: readonly unknown[]): ModelResultV2<MediaBlock> {
  const v4 = (scene as { schemaVersion?: unknown } | null)?.schemaVersion === 4;
  // With the project's scenes given, `scene` is the start scenes
  // merged (what the game starts with): the per-scene limits (colliders,
  // zones, spawns, the entity cap) apply to each scene below, not to their sum.
  const s = v4 ? (allScenes !== undefined ? validateMergedSceneV4(scene) : validateSceneV4(scene)) : validateSceneV3(scene);
  if (!s.ok) return { ok: false, errors: s.errors };
  // A block the model validated before (the workspace's captured state) is not validated again.
  const c = v4 ? validateContentV4(content, content) : validateContentV3(content);
  if (!c.ok) return { ok: false, errors: c.errors };
  let normScene = s.normalized as unknown as SceneV3;
  if (v4 && allScenes !== undefined) {
    const all = allSceneEntities(allScenes);
    if (!all.ok) return { ok: false, errors: all.errors };
    normScene = { ...normScene, entities: all.entities };
  }
  return mediaIdentityFrom(normScene, c.normalized);
}

function mediaIdentityFrom(scene: SceneV3, content: ContentCatalogV3 | ContentCatalogV4): ModelResultV2<MediaBlock> {
  const byId = new Map<string, AssetRecordV3>(content.assets.map((a) => [a.assetId, a]));
  const errors: ModelErrorV2[] = [];

  // animation — one row per modelAnimation entity.
  const rows: MediaAnimationRow[] = [];
  for (const e of scene.entities) {
    const ma = e.components.modelAnimation;
    if (!ma) continue;
    const record = byId.get(ma.assetId);
    if (!record) {
      errors.push(withFound({ code: 'asset_reference_missing', path: `/entities/${e.id}/components/modelAnimation/assetId`, document: 'scene', message: 'a modelAnimation binding resolves to no catalog record', expected: 'an existing model assetId' }, ma.assetId));
      continue;
    }
    if (record.kind !== 'model') {
      errors.push(withFound({ code: 'asset_kind_mismatch', path: `/entities/${e.id}/components/modelAnimation/assetId`, document: 'scene', message: 'a modelAnimation binding must reference a model asset', expected: 'kind "model"' }, record.kind));
      continue;
    }
    const version = record.versions.find((v) => v.version === ma.version);
    if (!version) {
      errors.push(withFound({ code: 'asset_version_invalid', path: `/entities/${e.id}/components/modelAnimation/version`, document: 'scene', message: 'a modelAnimation binding names a version the record does not have', expected: `an existing version 1..${record.currentVersion}` }, ma.version));
      continue;
    }
    rows.push({
      entityId: e.id,
      assetId: ma.assetId,
      version: ma.version,
      profileDigest: mediaProfileDigest(ma.roles),
      roles: ma.roles,
    });
  }
  if (errors.length > 0) return fail(errors);
  rows.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));

  // The media block is the animation rows (the cue slots went with the game block).
  const media: MediaBlock = { animation: rows };
  return { ok: true, normalized: media };
}

// ---------------------------------------------------------------------------
// Captured v3 content view (the `contentDigest` preimage)
// ---------------------------------------------------------------------------

/**
 * `captureContentViewV3(scene, content, ctx)` — the captured v3 content view
 * (the six-key `contentDigest` preimage: `{assets, prefabs, behaviors,
 * settings, behaviorTrust}`). Pure: validates the v3 pair, resolves the
 * reachable kind-tagged asset versions (the v3 capture closure), the
 * resolved six-key settings, and derives the digest.
 */
export function captureContentViewV3(
  scene: unknown,
  content: unknown,
  ctx: { projectId: string; revision: number },
  /** v4: every scene of the project (the view covers them all). */
  allScenes?: readonly unknown[],
  /** Assets the view holds though nothing references them (the loadable ones). */
  include?: readonly string[],
  /** SHA-256 (lowercase hex) for the view's digest (a host's native one; the same digest). */
  sha256?: (bytes: Uint8Array) => string,
): ModelResultV2<CapturedContentViewV3> {
  const v4 = (scene as { schemaVersion?: unknown } | null)?.schemaVersion === 4;
  // With the project's scenes given, `scene` is the start scenes
  // merged (what the game starts with): the per-scene limits (colliders,
  // zones, spawns, the entity cap) apply to each scene below, not to their sum.
  const s = v4 ? (allScenes !== undefined ? validateMergedSceneV4(scene) : validateSceneV4(scene)) : validateSceneV3(scene);
  if (!s.ok) return fail(s.errors);
  // A block the model validated before (the workspace's captured state) is not validated again.
  const c = v4 ? validateContentV4(content, content) : validateContentV3(content);
  if (!c.ok) return fail(c.errors);
  let normScene = s.normalized as unknown as SceneV3;
  const normContent = c.normalized as ContentCatalogV3;
  if (v4 && allScenes !== undefined) {
    const all = allSceneEntities(allScenes);
    if (!all.ok) return fail(all.errors);
    const entities = all.entities;
    // The references of every scene (a scene loaded later needs its assets too).
    normScene = { ...normScene, entities };
  }

  const settingsRes = resolveGameplaySettings(normContent.settings);
  if (!settingsRes.ok) return fail(settingsRes.errors);

  const byId = new Map<string, AssetRecordV3>(normContent.assets.map((a) => [a.assetId, a]));
  const errors: ModelErrorV2[] = [];
  const assets: CapturedAssetV3[] = [];
  // Every scene's look names its images (a scene loaded later needs them too).
  const looks = v4 && allScenes !== undefined ? allScenes.map((sc) => (sc as { environment?: SceneEnvironment } | null)?.environment) : undefined;
  const refs = collectAssetRefsV3(normScene, normContent, looks);
  if (include !== undefined && include.length > 0) {
    const named = new Set(refs.map((r) => r.assetId));
    for (const assetId of include) {
      if (named.has(assetId) || !byId.has(assetId)) continue;
      named.add(assetId);
      refs.push({ assetId, version: null });
      // A loadable model's extracted textures come with it.
      for (const id of Object.values(byId.get(assetId)!.textures ?? {})) {
        if (named.has(id) || !byId.has(id)) continue;
        named.add(id);
        refs.push({ assetId: id, version: null });
      }
    }
  }
  for (const ref of refs) {
    const record = byId.get(ref.assetId);
    if (!record) {
      errors.push(withFound({ code: 'asset_reference_missing', path: '', document: 'scene', message: 'a captured scene reference resolves to no catalog record', expected: 'an existing assetId in content.assets' }, ref.assetId));
      continue;
    }
    const wanted = ref.version ?? record.currentVersion;
    const version = record.versions.find((v) => v.version === wanted);
    if (!version) {
      errors.push(withFound({ code: 'asset_version_invalid', path: '', document: 'scene', message: 'a captured modelAnimation binding names a version the record does not have', expected: `an existing version 1..${record.currentVersion}` }, wanted));
      continue;
    }
    const importRecipe = version.importRecipe as { profile: string; recipeVersion: number };
    // The row of an unchanged record and version is the one made before (with its text for the digest).
    assets.push(viewRowOf<CapturedAssetV3>(record, version, () => ({
      assetId: record.assetId,
      kind: record.kind,
      version: version.version,
      sourceDigest: version.sourceDigest,
      sourceByteLength: version.sourceByteLength,
      recipe: { id: importRecipe.profile, version: importRecipe.recipeVersion },
      metricsDigest: metricsDigestOf(version.metrics, sha256),
      ...(record.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
      ...(record.materials !== undefined ? { materials: { ...record.materials } } : {}),
      ...(record.textures !== undefined ? { textures: { ...record.textures } } : {}),
      ...(record.clipsFor !== undefined ? { clipsFor: record.clipsFor } : {}),
      // A model version's recorded bounds (absent before; the digests of older captures are unchanged).
      ...(record.kind === 'model' && (version.metrics as { bounds?: CapturedAssetV3['bounds'] }).bounds !== undefined ? { bounds: boundsCopy((version.metrics as { bounds: NonNullable<CapturedAssetV3['bounds']> }).bounds) } : {}),
    })));
  }
  if (errors.length > 0) return fail(errors);
  assets.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : a.version - b.version));

  const withoutDigest = {
    assets,
    prefabs: normContent.prefabs,
    behaviors: normContent.behaviors,
    settings: settingsRes.normalized,
    behaviorTrust: normContent.behaviorTrust,
  };
  // The digest of `JSON.stringify(withoutDigest, null, 2)`, made from the parts' remembered texts (or remembered whole).
  const contentDigest = viewDigestOf(normContent, withoutDigest, (text) => (sha256 !== undefined ? sha256(new TextEncoder().encode(text)) : sha256HexOfText(text)));
  return { ok: true, normalized: { ...withoutDigest, contentDigest } as CapturedContentViewV3 };
}

// ---------------------------------------------------------------------------
// Manifest v2 capture (the pure assembly)
// ---------------------------------------------------------------------------

export interface CaptureManifestV2Input {
  projectId: string;
  revision: number;
  /** UTC second at capture, `YYYY-MM-DDThh:mm:ssZ`. */
  capturedAt: string;
  /** The captured v3 scene document, or a precomputed `sceneDigest`. */
  scene?: unknown;
  sceneDigest?: string;
  /** The resolved kind-tagged asset rows (from `captureContentViewV3`). */
  assets: readonly ManifestAssetInputV2[];
  /** The loadable assets and resources the build holds (by address or label; absent or empty = none). */
  loadable?: readonly LoadableRow[];
  /** The reachable source-bearing behaviors (the v1 manifest's row shape). */
  behaviors: readonly ManifestBehaviorInput[];
  /** The shared library modules the behaviors import (only when there are some). */
  libraries?: readonly Omit<ManifestLibraryRow, 'path'>[];
  /** The resolved six-key settings, in registry order. */
  settings: GameplaySettings;
  /** The project tag registry; the manifest carries it only when non-empty. */
  tags?: readonly TagDefinition[];
  /** The project materials (only when non-empty) and the environment (only when set). */
  materials?: readonly MaterialDef[];
  /** The material functions the graph materials call (only when some are called). */
  materialFunctions?: readonly GraphDocument[];
  /** The visual effects (only when the project has some; `effectsForRuntime`). */
  effects?: readonly EffectDef[];
  /** The project UI themes and documents (only when the project has some). */
  uiThemes?: readonly UiTheme[];
  uiDocuments?: readonly UiDocument[];
  /** The dialogue runner's data (`dialogueForRuntime`; only when the project has conversations). */
  dialogue?: RuntimeDialogueData | null;
  /** The game modes (only when the project has some). */
  modes?: readonly GameMode[];
  /** The timelines (only when the project has some). */
  timelines?: readonly TimelineAsset[];
  /** The event → cue table (only when the project has one). */
  eventCues?: readonly EventCue[];
  /** The game shell (only when the project has one). */
  shell?: GameShell;
  environment?: EnvironmentConfig;
  /** The scenes' bakes (only when some scene has one). */
  lighting?: LightingMap;
  /** The animator controllers (only when there are some). */
  animators?: readonly AnimatorController[];
  /** Model assetId -> its rig (only when the project uses sockets). */
  rigs?: Readonly<Record<string, ModelRig>>;
  /** Model assetId -> piece -> its `_COL` parts (only when a collider is `{type: 'model'}`). */
  modelColliders?: ModelColliderTable;
  /** The prefab definitions scripts spawn (only when there are some). */
  prefabs?: readonly PrefabDefinition[];
  /** The block types and cell fields (only when there are some). */
  blockTypes?: readonly BlockType[];
  cellFields?: readonly CellField[];
  /** The project's input actions (only when it has its own). */
  input?: InputConfig;
  /** The project's named collision layers (only when it names some). */
  collisionLayers?: readonly string[];
  /** The project save schema (only when the project declares one). */
  saveSchema?: SaveSchema;
  /**
   * A v4 project's scenes — one artifact each, loaded at start
   * (`start`) or on demand by the game; present only for a v4 project.
   */
  scenes?: readonly ManifestSceneRow[];
  /** Instance-set transform buffers (artifacts `content/sha256/<digest>`). */
  buffers?: readonly { digest: string; byteLength: number }[];
  /** The resolved media identity (from `resolveMediaIdentityV3`). */
  media: MediaBlock;
  /** The required engine module IDs (the shared-composition set). */
  moduleIds: readonly string[];
  /** The captured-view digest (from `captureContentViewV3`) — required for v2. */
  contentDigest?: string;
  /** The emitted engine pins (defaults to {@link M3_ENGINE_PINS}). */
  enginePins?: readonly { id: string; version: string; apiVersion: number }[];
  /** The recipe table (defaults to {@link M3_RECIPE_VERSIONS}). */
  recipes?: Record<string, number>;
}

/** `M2_MODULE_PACKAGES` and `M3_MODULE_PACKAGES` combined (the latter wins on overlap). */
const MODULE_PACKAGE_LOOKUP: Readonly<Record<string, string>> = {
  ...M2_MODULE_PACKAGES,
  ...M3_MODULE_PACKAGES,
};

/** One manifest asset row (v4 `assets`, v5 catalog entries) from its captured input. */
export function manifestAssetRow(a: ManifestAssetInputV2): Record<string, unknown> & { assetId: string; version: number } {
  return {
    assetId: a.assetId,
    kind: a.kind,
    version: a.version,
    sourceDigest: a.sourceDigest,
    sourceByteLength: a.sourceByteLength,
    recipeDigest: a.recipeDigest ?? recipeDigestOf(a.recipe ?? { id: 'unknown', version: 0 }),
    metricsDigest: a.metricsDigest,
    path: `content/sha256/${a.sourceDigest}`,
    ...(a.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
    ...(a.materials !== undefined ? { materials: canonicalMaterialMapping(a.materials) } : {}),
    ...(a.textures !== undefined ? { textures: { ...a.textures } } : {}),
    ...(a.clipsFor !== undefined ? { clipsFor: a.clipsFor } : {}),
    ...(a.bounds !== undefined ? { bounds: boundsCopy(a.bounds) } : {}),
    ...(a.durationMs !== undefined && a.kind === 'audio' ? { durationMs: a.durationMs } : {}),
    ...(a.loadType !== undefined && a.kind === 'audio' ? { loadType: a.loadType, preload: a.preload !== false } : {}),
    ...(a.mipParts !== undefined && a.kind === 'texture'
      ? { mipParts: a.mipParts.map((p) => ({ path: `content/sha256/${p.digest}`, digest: p.digest, byteLength: p.byteLength, offset: p.offset, levels: [...p.levels] })) }
      : {}),
  };
}

/** Asset rows in the manifest's order (ascending id, then version). */
export function sortedAssetRows(assets: readonly ManifestAssetInputV2[]): Array<Record<string, unknown> & { assetId: string; version: number }> {
  return assets.map(manifestAssetRow).sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : a.version - b.version));
}

/** The behavior rows in the manifest's order (ascending id). */
export function sortedBehaviorRows(behaviors: readonly ManifestBehaviorInput[]): Array<Record<string, unknown> & { behaviorId: string }> {
  return behaviors
    .map((b) => ({
      behaviorId: b.behaviorId,
      sourceDigest: b.sourceDigest,
      sourceByteLength: b.sourceByteLength,
      manifestDigest: b.manifestDigest,
      outputDigest: b.outputDigest,
      outputByteLength: b.outputByteLength,
      apiVersion: b.apiVersion,
      declaration: b.declaration,
      ownedTransforms: [...b.ownedTransforms],
      requiredModules: [...b.requiredModules],
      path: `behaviors/${b.outputDigest}.js`,
    }))
    .sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));
}

/** The `modules` rows of a module id set (ascending, each with its package and pin). */
export function manifestModuleRows(moduleIds: readonly string[]): Array<{ id: string; apiVersion: number; package: string; version: string }> {
  return [...new Set(moduleIds)].sort().map((id) => {
    const pkg = MODULE_PACKAGE_LOOKUP[id];
    const pin = pkg !== undefined ? M3_ENGINE_PINS.find((p) => p.id === pkg) ?? M2_ENGINE_PINS.find((p) => p.id === pkg) : undefined;
    return { id, apiVersion: pin?.apiVersion ?? 1, package: pkg ?? '@thirdlight/runtime', version: pin?.version ?? '0.1.0' };
  });
}

/** The `libraries` rows (ascending id, digest-named paths). */
export function manifestLibraryRows(libraries: readonly Omit<ManifestLibraryRow, 'path'>[]): ManifestLibraryRow[] {
  return [...libraries]
    .map((l) => ({ libraryId: l.libraryId, sourceDigest: l.sourceDigest, outputDigest: l.outputDigest, outputByteLength: l.outputByteLength, path: `libraries/${l.outputDigest}.js` }))
    .sort((a, b) => (a.libraryId < b.libraryId ? -1 : a.libraryId > b.libraryId ? 1 : 0));
}

/** The toolchain block every manifest carries (the compiler versions and the build options digest). */
export function manifestToolchain(): { toolchain: Record<string, unknown>; buildOptionsDigest: string } {
  const buildOptionsDigest = sha256Hex(buildOptionsRecordBytes());
  return { toolchain: { esbuild: '0.28.2', typescript: '5.9.3', optionsDigest: buildOptionsDigest }, buildOptionsDigest };
}

/**
 * The manifest's project-wide blocks in their canonical runtime form, from a
 * capture's inputs: the ones a v4 manifest holds inline (`inline`, only the
 * ones that apply) and the ones in content files (`files`). A v5 catalog
 * writes the same blocks to its files.
 */
export function canonicalManifestBlocks(input: Omit<CaptureManifestV2Input, 'assets' | 'behaviors' | 'media' | 'moduleIds' | 'projectId' | 'revision' | 'capturedAt' | 'settings'>): { inline: Record<string, unknown>; files: Partial<Record<ManifestContentFileKey, unknown>> } {
  const inline: Record<string, unknown> = {
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags.map((t) => ({ bit: t.bit, name: t.name })) } : {}),
    ...(input.effects !== undefined && input.effects.length > 0 ? { effects: canonicalEffects(input.effects) } : {}),
    ...(input.environment !== undefined ? { environment: canonicalEnvironment(input.environment) } : {}),
    ...(input.lighting !== undefined && Object.keys(input.lighting).length > 0 ? { lighting: canonicalLighting(input.lighting) } : {}),
    ...(input.animators !== undefined && input.animators.length > 0 ? { animators: canonicalAnimators(input.animators) } : {}),
    ...(input.rigs !== undefined && Object.keys(input.rigs).length > 0 ? { rigs: Object.fromEntries(Object.keys(input.rigs).sort().map((k) => [k, input.rigs![k]!])) } : {}),
    ...(input.modelColliders !== undefined && Object.keys(input.modelColliders).length > 0 ? { modelColliders: Object.fromEntries(Object.keys(input.modelColliders).sort().map((k) => [k, Object.fromEntries(Object.keys(input.modelColliders![k]!).sort().map((piece) => [piece, input.modelColliders![k]![piece]!]))])) } : {}),
    ...(input.prefabs !== undefined && input.prefabs.length > 0 ? { prefabs: canonicalPrefabs(input.prefabs) } : {}),
    ...(input.blockTypes !== undefined && input.blockTypes.length > 0 ? { blockTypes: canonicalBlockTypes(input.blockTypes) } : {}),
    ...(input.cellFields !== undefined && input.cellFields.length > 0 ? { cellFields: canonicalCellFields(input.cellFields) } : {}),
    ...(input.input !== undefined ? { input: canonicalInput(input.input) } : {}),
    ...(input.collisionLayers !== undefined && input.collisionLayers.length > 0 ? { collisionLayers: [...input.collisionLayers] } : {}),
    ...(input.saveSchema !== undefined ? { saveSchema: canonicalSaveSchema(input.saveSchema) } : {}),
    ...(input.uiThemes !== undefined && input.uiThemes.length > 0 ? { uiThemes: canonicalUiThemes(input.uiThemes) } : {}),
    ...(input.modes !== undefined && input.modes.length > 0 ? { modes: canonicalModes(input.modes) } : {}),
    ...(input.timelines !== undefined && input.timelines.length > 0 ? { timelines: canonicalTimelines(input.timelines) } : {}),
    ...(input.eventCues !== undefined && input.eventCues.length > 0 ? { eventCues: canonicalEventCues(input.eventCues) } : {}),
    ...(input.shell !== undefined ? { shell: canonicalShell(input.shell) } : {}),
  };
  const files: Partial<Record<ManifestContentFileKey, unknown>> = {
    ...(input.materials !== undefined && input.materials.length > 0 ? { materials: canonicalMaterials(input.materials) } : {}),
    ...(input.materialFunctions !== undefined && input.materialFunctions.length > 0 ? { materialFunctions: canonicalGraphDocuments(input.materialFunctions) } : {}),
    ...(input.uiDocuments !== undefined && input.uiDocuments.length > 0 ? { uiDocuments: canonicalUiDocuments(input.uiDocuments) } : {}),
    ...(input.dialogue !== undefined && input.dialogue !== null ? { dialogue: JSON.parse(JSON.stringify(input.dialogue)) as RuntimeDialogueData } : {}),
    ...(input.buffers !== undefined && input.buffers.length > 0 ? { buffers: input.buffers.map((b) => ({ digest: b.digest, byteLength: b.byteLength })) } : {}),
  };
  return { inline, files };
}

/**
 * `captureManifestV2(input)` — the pure v2 manifest derivation. Every field is
 * derived from the arguments; `capturedAt` is caller-supplied. The block
 * digests and `buildId` use the canonical ordering (owning-contract key
 * order, not sorted keys).
 */
export function captureManifestV2(input: CaptureManifestV2Input): CaptureManifestV2Result {
  if (input.contentDigest === undefined) {
    return { ok: false, error: manifestError('internal', 'contentDigest is required for a v2 manifest capture (derive it with captureContentViewV3)') };
  }
  if (input.scene === undefined && input.sceneDigest === undefined) {
    return { ok: false, error: manifestError('internal', 'scene or sceneDigest is required for a v2 manifest capture') };
  }
  const sceneDigest = input.sceneDigest ?? blockDigest(input.scene);
  const contentDigest = input.contentDigest;
  for (const [name, value] of [
    ['sceneDigest', sceneDigest],
    ['contentDigest', contentDigest],
  ] as const) {
    if (!DIGEST_RE.test(value)) return { ok: false, error: manifestError('field_value', `${name} must be 64 lowercase hex`) };
  }

  const assets = sortedAssetRows(input.assets);
  const behaviors = sortedBehaviorRows(input.behaviors);
  const modules = manifestModuleRows(input.moduleIds);
  const enginePins = (input.enginePins ?? M3_ENGINE_PINS).map((p) => ({ id: p.id, version: p.version, apiVersion: p.apiVersion }));
  const recipes = { ...(input.recipes ?? M3_RECIPE_VERSIONS) };

  const settingsDigest = blockDigest(input.settings);
  const mediaDigest = blockDigest(input.media);
  const { toolchain, buildOptionsDigest } = manifestToolchain();

  // The blocks that grow with the content go to their own files (canonical bytes, by digest).
  const { inline, files: fileBlocks } = canonicalManifestBlocks(input);
  const contentFiles: ManifestContentFile[] = [];
  for (const key of MANIFEST_CONTENT_FILE_KEYS) {
    if (!(key in fileBlocks)) continue;
    const bytes = new TextEncoder().encode(`${JSON.stringify(fileBlocks[key], null, 2)}\n`);
    if (bytes.length > MANIFEST_CONTENT_FILE_MAX_BYTES) {
      return { ok: false, error: manifestError('limits_exceeded', `the manifest's ${key} content file exceeds ${MANIFEST_CONTENT_FILE_MAX_BYTES} bytes`) };
    }
    const digest = sha256Hex(bytes);
    contentFiles.push({ key, path: `content/sha256/${digest}`, digest, byteLength: bytes.length, bytes });
  }

  const withoutBuildId: Record<string, unknown> = {
    manifestVersion: RUNTIME_CONTENT_MANIFEST_VERSION_4,
    type: RUNTIME_CONTENT_TYPE,
    projectId: input.projectId,
    revision: input.revision,
    snapshotId: `${input.projectId}@r${input.revision}`,
    capturedAt: input.capturedAt,
    sceneDigest,
    contentDigest,
    settingsDigest,
    mediaDigest,
    settings: input.settings,
    ...inline,
    ...(input.scenes !== undefined ? { scenes: input.scenes.map((r) => ({ sceneId: r.sceneId, path: r.path, digest: r.digest, byteLength: r.byteLength, start: r.start })) } : {}),
    ...(contentFiles.length > 0 ? { contentFiles: contentFiles.map((f) => ({ key: f.key, path: f.path, digest: f.digest, byteLength: f.byteLength })) } : {}),
    assets,
    ...(input.loadable !== undefined && input.loadable.length > 0 ? { loadable: input.loadable.map((r) => ({ kind: r.kind, id: r.id, ...(r.address !== undefined ? { address: r.address } : {}), ...(r.labels !== undefined ? { labels: [...r.labels] } : {}) })) } : {}),
    media: input.media,
    behaviors,
    ...(input.libraries !== undefined && input.libraries.length > 0 ? { libraries: manifestLibraryRows(input.libraries) } : {}),
    modules,
    enginePins,
    recipes,
    toolchain,
    buildOptionsDigest,
  };
  const preimage = manifestBuildIdInputV2(withoutBuildId);
  if (preimage === null) {
    return { ok: false, error: manifestError('internal', 'the v2 manifest document could not be serialized') };
  }
  const buildId = sha256Hex(preimage);
  // The document itself follows MANIFEST_KEYS_V2 (the literal above had dialogue before modes).
  const ordered: Record<string, unknown> = {};
  for (const key of MANIFEST_KEYS_V2) if (key !== 'buildId' && key in withoutBuildId) ordered[key] = withoutBuildId[key];
  const manifest = { ...ordered, buildId } as unknown as RuntimeContentManifestV2;
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  if (bytes.length > RUNTIME_CONTENT_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      error: manifestError('limits_exceeded', `the v2 manifest document exceeds ${RUNTIME_CONTENT_MANIFEST_MAX_BYTES} bytes`),
    };
  }
  return { ok: true, manifest, bytes, buildId, contentFiles };
}

/**
 * The exact bytes `buildId` covers for a v2 manifest:
 * the document serialization of the manifest without `buildId`, key order
 * exactly `MANIFEST_KEYS_V2` with `buildId` last (excluded). Returns `null` if
 * any non-`buildId` key is absent.
 */
export function manifestBuildIdInputV2(manifest: Record<string, unknown>): Uint8Array | null {
  const without: Record<string, unknown> = {};
  for (const key of MANIFEST_KEYS_V2) {
    if (key === 'buildId') continue;
    if (OPTIONAL_MANIFEST_KEYS.has(key) && !(key in manifest)) continue; // optional
    if (!(key in manifest)) return null;
    without[key] = manifest[key];
  }
  return new TextEncoder().encode(`${JSON.stringify(without, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Validation (strict v2 reader) + version-compat
// ---------------------------------------------------------------------------

export interface ValidateManifestV2Options {
  /** The captured v3 scene (re-derives `sceneDigest` and the media identity). */
  scene?: unknown;
  /** The captured v3 content block (re-derives the media identity and asset kinds). */
  content?: unknown;
  /**
   * The content files' blocks by key (parsed from their bytes).
   * Given, each must match its row's digest and validate as its block does
   * (materials with the material functions, UI documents with the input
   * maps, the dialogue data, the buffer rows); a row without a block here is
   * refused.
   */
  contentFiles?: Partial<Record<ManifestContentFileKey, unknown>>;
}

export type ValidateManifestV2Result =
  | { ok: true; manifest: RuntimeContentManifestV2 }
  | { ok: false; error: ManifestErrorV2 };

const ASSET_KINDS = ['model', 'audio', 'texture', 'font'] as const;

function isDigest(v: unknown): v is string {
  return typeof v === 'string' && DIGEST_RE.test(v);
}

/**
 * `validateManifestV2(doc, opts?)` — the strict v2 reader.
 * Rejects a v1 document (`manifest_version`), unknown/missing keys
 * (`manifest_invalid`), a digest/`buildId` mismatch (`manifest_invalid`), a
 * non-registry settings order or a non-`{model,audio}` kind
 * (`manifest_invalid`), and — when the captured `scene`+`content` are supplied
 * — a media-identity disagreement (`manifest_invalid` reason `media_identity`)
 * or an asset kind that disagrees with the captured record
 * (`asset_kind_mismatch`).
 */
export function validateManifestV2(doc: unknown, opts?: ValidateManifestV2Options): ValidateManifestV2Result {
  if (!isPlainObject(doc)) return { ok: false, error: manifestError('manifest_invalid', 'the manifest is not an object') };
  const d = doc as Record<string, unknown>;

  // Version gate: a v1 (or unknown) document is not a v2 document.
  if (d['manifestVersion'] !== RUNTIME_CONTENT_MANIFEST_VERSION_4) {
    return { ok: false, error: manifestError('manifest_invalid', 'manifestVersion is not 4 (materials, UI documents, dialogue and buffers in content files)', 'manifest_version', d['manifestVersion'], '4') };
  }

  // Key set: exactly MANIFEST_KEYS_V2 (unknown or missing ⇒ manifest_invalid).
  for (const key of Object.keys(d)) {
    if (!(MANIFEST_KEYS_V2 as readonly string[]).includes(key)) {
      return { ok: false, error: manifestError('manifest_invalid', `unknown manifest key "${key}"`, 'unknown_key', key) };
    }
  }
  for (const key of MANIFEST_KEYS_V2) {
    if (OPTIONAL_MANIFEST_KEYS.has(key)) continue; // optional
    if (!(key in d)) return { ok: false, error: manifestError('manifest_invalid', `missing manifest key "${key}"`, 'missing_key', undefined, key) };
  }
  const blocks = manifestBlocksProblem(d);
  if (blocks !== null) return { ok: false, error: blocks };
  // The content file rows (and, when given, their blocks).
  if (d['contentFiles'] !== undefined) {
    const rowsRes = contentFileRowsProblem(d['contentFiles']);
    if (rowsRes !== null) return { ok: false, error: manifestError('manifest_invalid', `contentFiles: ${rowsRes}`.slice(0, 256), 'field_value') };
  }
  if (opts?.contentFiles !== undefined) {
    const blocksRes = contentFileBlocksProblem((d['contentFiles'] as ManifestContentFileRow[] | undefined) ?? [], opts.contentFiles, d['input']);
    if (blocksRes !== null) return { ok: false, error: manifestError('manifest_invalid', blocksRes.slice(0, 256), 'content_file') };
  }
  if (d['type'] !== RUNTIME_CONTENT_TYPE) {
    return { ok: false, error: manifestError('manifest_invalid', 'type is not the runtime-content discriminator', 'field_value', d['type'], RUNTIME_CONTENT_TYPE) };
  }
  const projectId = d['projectId'];
  const revision = d['revision'];
  if (typeof projectId !== 'string' || typeof revision !== 'number' || !Number.isInteger(revision)) {
    return { ok: false, error: manifestError('manifest_invalid', 'projectId/revision must be a string/integer', 'field_value') };
  }
  if (d['snapshotId'] !== `${projectId}@r${revision}`) {
    return { ok: false, error: manifestError('manifest_invalid', 'snapshotId does not match <projectId>@r<revision>', 'field_value', d['snapshotId'], `${projectId}@r${revision}`) };
  }
  for (const key of ['sceneDigest', 'contentDigest', 'settingsDigest', 'mediaDigest', 'buildOptionsDigest', 'buildId'] as const) {
    if (!isDigest(d[key])) return { ok: false, error: manifestError('manifest_invalid', `${key} must be 64 lowercase hex`, 'field_value', d[key]) };
  }

  // settings — exactly the six registry keys, in order, numeric.
  const settings = d['settings'];
  if (!isPlainObject(settings)) return { ok: false, error: manifestError('manifest_invalid', 'settings must be an object', 'field_value') };
  const settingsKeys = Object.keys(settings);
  const extraKeys = settingsKeys.slice(M3_SETTINGS_KEYS.length);
  const optionalOrder = extraKeys.map((k) => (M3_OPTIONAL_SETTINGS_KEYS as readonly string[]).indexOf(k));
  if (
    settingsKeys.length < M3_SETTINGS_KEYS.length ||
    !M3_SETTINGS_KEYS.every((k, i) => settingsKeys[i] === k) ||
    optionalOrder.some((i, n) => i < 0 || (n > 0 && i <= optionalOrder[n - 1]!))
  ) {
    return { ok: false, error: manifestError('manifest_invalid', 'settings must carry the six registry keys in registry order, then only the optional engine settings the project sets, in registry order', 'field_value', settingsKeys) };
  }
  for (const k of settingsKeys) {
    if (typeof (settings as Record<string, unknown>)[k] !== 'number') {
      return { ok: false, error: manifestError('manifest_invalid', `settings.${k} must be a number`, 'field_value') };
    }
  }

  // Block digests — re-derived against the declared blocks.
  const media = d['media'];
  if (!isPlainObject(media)) return { ok: false, error: manifestError('manifest_invalid', 'media must be an object', 'field_value') };
  if (blockDigest(settings) !== d['settingsDigest']) {
    return { ok: false, error: manifestError('manifest_invalid', 'settingsDigest does not match the settings block', 'digest_mismatch', d['settingsDigest'], blockDigest(settings)) };
  }
  if (blockDigest(media) !== d['mediaDigest']) {
    return { ok: false, error: manifestError('manifest_invalid', 'mediaDigest does not match the media block', 'digest_mismatch', d['mediaDigest'], blockDigest(media)) };
  }

  // media shape — exactly the animation rows (no cue slots).
  const mediaKeys = Object.keys(media);
  if (mediaKeys.length !== 1 || !Array.isArray((media as Record<string, unknown>)['animation'])) {
    return { ok: false, error: manifestError('manifest_invalid', 'media must carry exactly the animation rows', 'field_value', mediaKeys) };
  }

  // assets — kind, path and ordering.
  const assets = d['assets'];
  if (!Array.isArray(assets)) return { ok: false, error: manifestError('manifest_invalid', 'assets must be an array', 'field_value') };
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i] as Record<string, unknown>;
    if (!isPlainObject(a)) return { ok: false, error: manifestError('manifest_invalid', `assets[${i}] must be an object`, 'field_value') };
    if (!ASSET_KINDS.includes(a['kind'] as (typeof ASSET_KINDS)[number])) {
      return { ok: false, error: manifestError('manifest_invalid', `assets[${i}].kind must be "model", "audio", "texture" or "font"`, 'field_value', a['kind']) };
    }
    if (typeof a['sourceDigest'] === 'string' && a['path'] !== `content/sha256/${a['sourceDigest']}`) {
      return { ok: false, error: manifestError('manifest_invalid', `assets[${i}].path does not match its sourceDigest`, 'field_value', a['path']) };
    }
    if (i > 0) {
      const prev = assets[i - 1] as Record<string, unknown>;
      if (typeof a['assetId'] === 'string' && typeof prev['assetId'] === 'string' && a['assetId'] < prev['assetId']) {
        return { ok: false, error: manifestError('manifest_invalid', 'assets are not in ascending assetId order', 'field_value') };
      }
    }
  }

  // The shared library rows (ascending ids, digest-named paths).
  if (d['libraries'] !== undefined) {
    const why = libraryRowsProblem(d['libraries']);
    if (why !== null) return { ok: false, error: manifestError('manifest_invalid', `libraries: ${why}`.slice(0, 256), 'field_value') };
  }

  // buildId — re-derived over the document without buildId.
  const withoutBuildId = { ...d, buildId: undefined };
  const preimage = manifestBuildIdInputV2(withoutBuildId);
  if (preimage === null || sha256Hex(preimage) !== d['buildId']) {
    return { ok: false, error: manifestError('manifest_invalid', 'buildId does not match the manifest document', 'digest_mismatch', d['buildId']) };
  }

  // Optional: captured-state re-derivation (media identity, asset kind, sceneDigest).
  if (opts?.scene !== undefined && opts?.content !== undefined) {
    const sceneDigest = blockDigest(opts.scene);
    if (sceneDigest !== d['sceneDigest']) {
      return { ok: false, error: manifestError('manifest_invalid', 'sceneDigest does not match the captured scene', 'digest_mismatch', d['sceneDigest'], sceneDigest) };
    }
    const mediaRes = resolveMediaIdentityV3(opts.scene, opts.content);
    if (!mediaRes.ok) {
      return { ok: false, error: manifestError('manifest_invalid', 'the captured media identity could not be derived', 'media_identity') };
    }
    if (JSON.stringify(mediaRes.normalized) !== JSON.stringify(media)) {
      return { ok: false, error: manifestError('manifest_invalid', 'the media identity disagrees with the captured content', 'media_identity') };
    }
    // asset kind vs the captured records (the content is already v3-validated
    // by the successful `resolveMediaIdentityV3` above).
    const contentRes = validateContentV3(opts.content);
    if (contentRes.ok) {
      const byId = new Map(contentRes.normalized.assets.map((a) => [a.assetId, a]));
      for (const a of assets as readonly Record<string, unknown>[]) {
        const record = byId.get(a['assetId'] as string);
        if (record !== undefined && record.kind !== a['kind']) {
          return { ok: false, error: manifestError('asset_kind_mismatch', `asset "${a['assetId']}" kind disagrees with the captured record`, 'kind_mismatch', a['kind'], record.kind) };
        }
      }
    }
  }

  return { ok: true, manifest: doc as unknown as RuntimeContentManifestV2 };
}

/**
 * Why a manifest's project-wide blocks do not validate (null: they do): each
 * block by its own content rules (rigs, tags, timelines, event cues, shell,
 * effects, environment, lighting, animators, prefabs, input, collision
 * layers, UI themes, modes, block types, cell fields, loadable rows, save
 * schema). A v4 manifest holds them inline; a v5 catalog in its files.
 */
export function manifestBlocksProblem(d: Readonly<Record<string, unknown>>): ManifestErrorV2 | null {
  if (d['rigs'] !== undefined) {
    const r = d['rigs'];
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return manifestError('manifest_invalid', 'rigs maps model asset ids to rigs', 'field_value');
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      const why = validateModelRig(v);
      if (why !== null) return manifestError('manifest_invalid', `rigs["${k}"]: ${why}`.slice(0, 256), 'field_value');
    }
  }
  if (d['modelColliders'] !== undefined) {
    const why = validateModelColliderTable(d['modelColliders']);
    if (why !== null) return manifestError('manifest_invalid', `modelColliders: ${why}`.slice(0, 256), 'field_value');
  }
  if (d['tags'] !== undefined) {
    const tagErrors: ModelErrorV2[] = [];
    validateTagRegistry(d['tags'], '/tags', tagErrors);
    if (tagErrors.length > 0) return manifestError('manifest_invalid', 'tags is not a valid tag registry', 'field_value');
  }
  // The timelines validate as content.timelines does (their own rules).
  if (d['timelines'] !== undefined) {
    const tlErrors: ModelErrorV2[] = [];
    validateTimelines(d['timelines'], '/timelines', tlErrors);
    if (tlErrors.length > 0) return manifestError('manifest_invalid', 'timelines are not valid', 'field_value');
  }
  // The event → cue table validates as content.eventCues does.
  if (d['eventCues'] !== undefined) {
    const ecErrors: ModelErrorV2[] = [];
    validateEventCues(d['eventCues'], '/eventCues', ecErrors);
    if (ecErrors.length > 0) return manifestError('manifest_invalid', 'eventCues are not valid', 'field_value');
  }
  // The game shell validates as content.shell does.
  if (d['shell'] !== undefined) {
    const shErrors: ModelErrorV2[] = [];
    validateShell(d['shell'], '/shell', shErrors);
    if (shErrors.length > 0) return manifestError('manifest_invalid', 'shell is not valid', 'field_value');
  }
  if (d['effects'] !== undefined || d['environment'] !== undefined || d['lighting'] !== undefined || d['animators'] !== undefined || d['prefabs'] !== undefined || d['input'] !== undefined || d['collisionLayers'] !== undefined || d['uiThemes'] !== undefined || d['modes'] !== undefined) {
    const matErrors: ModelErrorV2[] = [];
    // The effects validate as content.effects does.
    if (d['effects'] !== undefined) validateEffects(d['effects'], '/effects', matErrors);
    if (d['environment'] !== undefined) validateEnvironment(d['environment'], '/environment', matErrors);
    if (d['lighting'] !== undefined) validateLighting(d['lighting'], '/lighting', matErrors);
    if (d['animators'] !== undefined) validateAnimators(d['animators'], '/animators', matErrors);
    if (d['prefabs'] !== undefined) validatePrefabDefinitions(d['prefabs'], '/prefabs', matErrors, 4);
    if (d['input'] !== undefined) validateInput(d['input'], '/input', matErrors);
    if (d['collisionLayers'] !== undefined) validateCollisionLayers(d['collisionLayers'], '/collisionLayers', matErrors);
    // The UI themes validate as content.uiThemes does (the documents are a content file).
    if (d['uiThemes'] !== undefined) validateUiThemes(d['uiThemes'], '/uiThemes', matErrors);
    // The game modes validate as content.modes does.
    if (d['modes'] !== undefined) validateModes(d['modes'], '/modes', matErrors);
    if (matErrors.length > 0) return manifestError('manifest_invalid', 'effects/environment/lighting are not valid', 'field_value');
  }

  if (d['blockTypes'] !== undefined || d['cellFields'] !== undefined) {
    const blockErrors: ModelErrorV2[] = [];
    if (d['blockTypes'] !== undefined) validateBlockTypes(d['blockTypes'], '/blockTypes', blockErrors);
    if (d['cellFields'] !== undefined) validateCellFields(d['cellFields'], '/cellFields', blockErrors);
    if (blockErrors.length > 0) return manifestError('manifest_invalid', 'blockTypes/cellFields are not valid', 'field_value');
  }
  if (d['loadable'] !== undefined) {
    const why = loadableRowsProblem(d['loadable']);
    if (why !== null) return manifestError('manifest_invalid', why.slice(0, 256), 'field_value');
  }
  if (d['saveSchema'] !== undefined) {
    const saveErrors: ModelErrorV2[] = [];
    validateSaveSchema(d['saveSchema'], '/saveSchema', saveErrors);
    if (saveErrors.length > 0) return manifestError('manifest_invalid', 'saveSchema is not valid', 'field_value');
  }

  return null;
}

/** Why a `libraries` value is not a list of shared library rows (null: it is). */
export function libraryRowsProblem(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return 'a non-empty list of rows';
  let last = '';
  for (const [i, raw] of v.entries()) {
    if (!isPlainObject(raw)) return `row ${i} is not an object`;
    const r = raw as Record<string, unknown>;
    const keys = Object.keys(r).join(',');
    if (keys !== 'libraryId,sourceDigest,outputDigest,outputByteLength,path') return `row ${i} must carry libraryId, sourceDigest, outputDigest, outputByteLength, path`;
    if (typeof r['libraryId'] !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(r['libraryId'])) return `row ${i} has no valid libraryId`;
    if (!isDigest(r['sourceDigest']) || !isDigest(r['outputDigest'])) return `row ${i} digests must be 64 lowercase hex`;
    if (typeof r['outputByteLength'] !== 'number' || !Number.isInteger(r['outputByteLength']) || r['outputByteLength'] < 1) return `row ${i} outputByteLength must be a positive integer`;
    if (r['path'] !== `libraries/${r['outputDigest']}.js`) return `row ${i} path must be libraries/<outputDigest>.js`;
    if (i > 0 && !(last < r['libraryId'])) return 'rows are not in ascending libraryId order';
    last = r['libraryId'];
  }
  return null;
}

/** Why a `contentFiles` value is not a list of rows in key order (null: it is). */
function contentFileRowsProblem(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return 'a non-empty list of rows';
  let last = -1;
  for (let i = 0; i < v.length; i += 1) {
    const r = v[i] as Record<string, unknown>;
    if (!isPlainObject(r)) return `row ${i} is not an object`;
    const keys = Object.keys(r);
    if (keys.join(',') !== 'key,path,digest,byteLength') return `row ${i} has the keys ${keys.join(', ')} (key, path, digest, byteLength)`;
    const at = (MANIFEST_CONTENT_FILE_KEYS as readonly unknown[]).indexOf(r['key']);
    if (at < 0) return `row ${i} names no content file block (${MANIFEST_CONTENT_FILE_KEYS.join(', ')})`;
    if (at <= last) return 'rows are not in the content file key order, or a key repeats';
    last = at;
    if (!isDigest(r['digest']) || r['path'] !== `content/sha256/${String(r['digest'])}`) return `row ${i}: path is content/sha256/<digest>`;
    const n = r['byteLength'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MANIFEST_CONTENT_FILE_MAX_BYTES) return `row ${i}: byteLength is 1..${MANIFEST_CONTENT_FILE_MAX_BYTES}`;
  }
  return null;
}

/** Why the content files' blocks do not match their rows or do not validate (null: they do). */
function contentFileBlocksProblem(rows: readonly ManifestContentFileRow[], blocks: Partial<Record<ManifestContentFileKey, unknown>>, input: unknown): string | null {
  for (const key of Object.keys(blocks)) {
    if (!rows.some((r) => r.key === key)) return `content file ${key} is not listed in contentFiles`;
  }
  for (const row of rows) {
    if (!(row.key in blocks)) return `content file ${row.key} is missing`;
    const block = blocks[row.key];
    const bytes = new TextEncoder().encode(`${JSON.stringify(block, null, 2)}\n`);
    if (bytes.length !== row.byteLength || sha256Hex(bytes) !== row.digest) return `content file ${row.key} does not match its digest`;
    const why = contentFileBlockProblem(row.key, block, { materialFunctions: blocks.materialFunctions, input });
    if (why !== null) return why;
  }
  return null;
}

/**
 * Why one content file block does not validate (null: it does): the
 * materials with the material functions they call, the functions as graph
 * documents, the UI documents with the input maps, the dialogue data, the
 * instance buffer rows.
 */
export function contentFileBlockProblem(key: ManifestContentFileKey, block: unknown, ctx: { readonly materialFunctions?: unknown; readonly input?: unknown }): string | null {
  const errors: ModelErrorV2[] = [];
  switch (key) {
    case 'materialFunctions':
      // The functions validate as graph documents (kind material-function only); graph materials call them.
      validateGraphDocuments(GRAPH_KINDS, block, '/materialFunctions', errors);
      if (Array.isArray(block) && (block as unknown[]).some((g) => (g as { kind?: unknown } | null)?.kind !== 'material-function')) {
        errors.push({ code: 'field_value', path: '/materialFunctions', message: 'materialFunctions holds material functions only' } as ModelErrorV2);
      }
      break;
    case 'materials':
      validateMaterials(block, '/materials', errors, graphDocumentsContext(GRAPH_KINDS, ctx.materialFunctions));
      break;
    case 'uiDocuments':
      validateUiDocuments(block, '/uiDocuments', errors, projectInputMaps(ctx.input));
      break;
    case 'dialogue': {
      const why = runtimeDialogueDataProblem(block);
      if (why !== null) return `dialogue: ${why}`;
      break;
    }
    case 'buffers':
      if (!Array.isArray(block) || block.length === 0 || block.some((b) => !isPlainObject(b) || Object.keys(b).join(',') !== 'digest,byteLength' || !isDigest((b as Record<string, unknown>)['digest']) || !Number.isInteger((b as Record<string, unknown>)['byteLength']))) {
        return 'buffers is a list of {digest, byteLength} rows';
      }
      break;
  }
  if (errors.length > 0) return `content file ${key} is not valid: ${errors[0]!.message}`;
  return null;
}

/**
 * The version-compatibility rule. A v1 reader must reject a
 * v2 document with `manifest_invalid` (`reason: "manifest_version"`) and a v2
 * reader must reject a v1 document; an in-place upgrade is forbidden. Phase
 * The reader was v3; It is v4 (it refuses v1–v3 alike).
 */
export function manifestVersionCompat(
  doc: unknown,
  reader: 1 | 4,
): { ok: true; version: 1 | 4 } | { ok: false; error: ManifestErrorV2 } {
  const version = isPlainObject(doc) ? (doc as Record<string, unknown>)['manifestVersion'] : undefined;
  if (version === reader) return { ok: true, version: reader };
  return { ok: false, error: manifestError('manifest_invalid', `a v${reader} reader cannot load a v${typeof version === 'number' ? version : 'unknown'} manifest document`, 'manifest_version', version, String(reader)) };
}
