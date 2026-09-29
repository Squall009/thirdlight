/**
 * Manifest v2 — the immutable M3 runtime-content identity (delivery.md §2,
 * sessions.md §17.1.1, packet 58).
 *
 * `captureManifestV2` is the pure derivation of the v2 delivery manifest from
 * ONE already-captured authoring state (the single acknowledged envelope read,
 * delivery.md §2.6): the captured v3 scene, the captured content block
 * (resolved settings, the reachable kind-tagged assets),
 * the resolved media identity and the reachable source-bearing behaviors. It
 * has no I/O, no clock and no randomness — the caller supplies `capturedAt` —
 * so two captures of the same state produce byte-identical documents.
 *
 * v2 moves `manifestVersion` 1 → 2: `assets` rows gain a required
 * `kind ∈ {model, audio}`, and six required keys appear (`gameDigest`,
 * `settingsDigest`, `mediaDigest`, `settings`, `game`, `media`). A v1 document
 * remains readable under its old meaning; a v1 reader must reject a v2 document
 * with `manifest_invalid` (`reason: "manifest_version"`), never silently ignore
 * the new keys.
 *
 * Phase 24.8 moves `manifestVersion` 2 → 3: the deleted game block's `game`
 * and `gameDigest` keys and the media block's five `cues` slots (all null
 * since phase 24.7) are gone; `media` is `{ animation }` and the captured
 * content view is `{assets, prefabs, behaviors, settings, behaviorTrust}`.
 *
 * Phase 25.7b moves `manifestVersion` 3 → 4: the blocks that grow with a
 * project's content — `materials` (only the ones the game uses),
 * `materialFunctions`, `uiDocuments`, `dialogue` and the instance `buffers`
 * table — leave the capped document for their own content files
 * (`content/sha256/<digest>`, the block's canonical bytes), listed in
 * `contentFiles` by key, digest and length and so bound by the `buildId`.
 * A reader verifies each file against its row and puts the block back under
 * its key (`expandManifestContentFiles` in game-host). A reader refuses any
 * other version.
 *
 * **Canonical ordering (normative, delivery.md §2.4).** Every block digest and
 * the `buildId` hash `JSON.stringify(value, null, 2) + "\n"` in the owning
 * contract's key order — NOT sorted-key canonicalization. `settings` is in
 * registry order, `media` in the §2.2 order, the content view in `{assets,
 * prefabs, behaviors, settings, behaviorTrust}` order and the manifest in `MANIFEST_KEYS_V2` order
 * (`buildId` last). A `null` block hashes its own four canonical bytes (`null`).
 *
 * This module is in the zero-dependency `project-model` leaf (the single
 * pure owner of the manifest derivation, C36-2); it reuses the M2 canonical
 * helpers and the `./sha256` digest primitives.
 */
import { canonicalSaveSchema, validateSaveSchema, type SaveSchema } from './save-schema';
import { canonicalBlockTypes, canonicalCellFields, validateBlockTypes, validateCellFields, type BlockType, type CellField } from './block-layers';
import { canonicalEnvironment, canonicalMaterialMapping, canonicalMaterials, validateEnvironment, validateMaterials, type EnvironmentConfig, type MaterialDef } from './materials';
import { canonicalAnimators, validateAnimators, type AnimatorController } from './animator';
import { validateModelRig, type ModelRig } from './model-rig';
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
  RUNTIME_CONTENT_MANIFEST_MAX_BYTES,
  RUNTIME_CONTENT_TYPE,
  type ManifestBehaviorInput,
} from './manifest';
// ---------------------------------------------------------------------------
// Constants (delivery.md §2.2 / v1-v2-rules.json)
// ---------------------------------------------------------------------------

/** The manifest shape version (delivery.md §2.1; phase 24.8: 3, without the game block and cue slots; phase 25.7b: 4, content files). */
export const RUNTIME_CONTENT_MANIFEST_VERSION_4 = 4 as const;

/**
 * Phase 25.7b: the blocks that ride in their own content files, in their
 * `contentFiles` order. Each file is the block's canonical JSON bytes
 * (`JSON.stringify(block, null, 2) + "\n"`) at `content/sha256/<digest>`.
 */
export const MANIFEST_CONTENT_FILE_KEYS = ['materials', 'materialFunctions', 'uiDocuments', 'dialogue', 'buffers'] as const;
export type ManifestContentFileKey = (typeof MANIFEST_CONTENT_FILE_KEYS)[number];

/** Phase 25.7b: one `contentFiles` row. */
export interface ManifestContentFileRow {
  key: ManifestContentFileKey;
  path: string;
  digest: string;
  byteLength: number;
}

/** Phase 25.7b: a content file of a capture (its row and its bytes). */
export interface ManifestContentFile extends ManifestContentFileRow {
  bytes: Uint8Array;
}

/**
 * The most bytes one content file may hold; the play content store takes it
 * as its single-artifact cap.
 */
export const MANIFEST_CONTENT_FILE_MAX_BYTES = 33_554_432;

/**
 * Phase 25.9: one shared script library module (`libraries/<outputDigest>.js`)
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

/** Phase 12 (c): one scene artifact of a v4 project. */
export interface ManifestSceneRow {
  sceneId: string;
  path: string;
  digest: string;
  byteLength: number;
  /** Loaded when the game starts. */
  start: boolean;
}

/** Keys present only when they apply (phase 12): tags, scenes, buffers. */
const OPTIONAL_MANIFEST_KEYS = new Set(['tags', 'effects', 'environment', 'lighting', 'animators', 'rigs', 'prefabs', 'blockTypes', 'cellFields', 'input', 'collisionLayers', 'saveSchema', 'uiThemes', 'timelines', 'eventCues', 'shell', 'modes', 'scenes', 'contentFiles', 'libraries']);

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
  // Phase 25.7b: materials (9.4) and material functions (18.3) are content files (`contentFiles`).
  // Phase 20.2: the visual effects (particle system graphs) the game plays.
  'effects',
  'environment',
  'lighting',
  'animators',
  // Phase 23.11: model rigs (nodes and node animation channels) sockets are resolved on — only in a project that uses sockets.
  'rigs',
  'prefabs',
  // Phase 23.5: the block types and the cell metadata schema block layers use.
  'blockTypes',
  'cellFields',
  'input',
  // Phase 23.3: the named collision layers (3D physics; only when the project names some).
  'collisionLayers',
  // Phase 23.19: the project save schema (only when the project declares one).
  'saveSchema',
  // Phase 23.9a: the project UI themes the game host draws (phase 25.7b: the documents are a content file).
  'uiThemes',
  // Phase 23.10: the game modes (the runtime switches them; the host reads their pause screens).
  'modes',
  // Phase 23.17: the timelines (sequencer assets) the game plays.
  'timelines',
  // Phase 24.4i: the event → cue table (sounds the host plays for signals and events; only when the project has one).
  'eventCues',
  // Phase 24.4j: the game shell (menus and HUD documents, the ordered scene list; only when the project has one).
  'shell',
  // Phase 23.16's dialogue data is a content file since phase 25.7b.
  'scenes',
  // Phase 25.7b: the blocks in their own content files (materials, materialFunctions, uiDocuments, dialogue, buffers).
  'contentFiles',
  'assets',
  'media',
  'behaviors',
  // Phase 25.9: the script libraries as shared modules (`libraries/<outputDigest>.js`) the behaviors import.
  'libraries',
  'modules',
  'enginePins',
  'recipes',
  'toolchain',
  'buildOptionsDigest',
  'buildId',
] as const;


/**
 * The M3 shared-composition engine pins (delivery.md §2.2 / K-5). The
 * identity values are the accepted pin table for the shared production
 * composition; the closure builder re-derives the emitted set from the real
 * lockfile pin table at build time and passes it explicitly (K-5/FU-5).
 * Ascending by `id`.
 */
export const M3_ENGINE_PINS: ReadonlyArray<{ id: string; version: string; apiVersion: number }> = Object.freeze([
  Object.freeze({ id: '@thirdlight/runtime', version: '0.1.0', apiVersion: 2 }),
  Object.freeze({ id: '@thirdlight/three', version: '0.186.1', apiVersion: 0 }),
]);

/** The package a known M3 module id belongs to (the manifest `modules` rows). */
export const M3_MODULE_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  'thirdlight.character:controller': '@thirdlight/character',
  // Phase 23.0: the 3D physics backend (physics_dimension 3).
  'thirdlight.physics-rapier:3d': '@thirdlight/physics-rapier',
  // Phase 23.2: the 3D character controller (a runtime built-in).
  'thirdlight.character3d:controller': '@thirdlight/runtime',
});

/** The engine module IDs this model version knows for M3 (ascending). */
export const M3_KNOWN_MODULE_IDS: readonly string[] = Object.freeze(Object.keys(M3_MODULE_PACKAGES).sort());

/** The v2 recipe table (delivery.md §2.3: `pcm-wav` is added for M3). */
export const M3_RECIPE_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  'behavior-source': 1,
  'gltf-glb': 1,
  'pcm-wav': 1,
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
  /** Model only (phase 9.4): the default material mapping. */
  materials?: Record<string, string>;
  /** Model only (phase 14.6): an animation-only file whose clips play on this model asset's rig. */
  clipsFor?: string;
  /** Model only (phase 15.3): the version's recorded bounds (absent for versions imported before). */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/** The captured v3 content view (delivery.md §2.3 `contentDigest` preimage). */
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

/** The resolved media identity block (delivery.md §2.3 `media`). */
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
  /** Model only (phase 9.4): the default material mapping. */
  materials?: Record<string, string>;
  /** Model only (phase 14.6): an animation-only file whose clips play on this model asset's rig. */
  clipsFor?: string;
  /** Model only (phase 15.3): the version's recorded bounds (the runtime's pickups without a size read them). */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  /** Audio and music (phase 23.13): the version's recorded duration, ms (script sounds' ends are computed from it). */
  durationMs?: number;
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
  /** Phase 12 (b): the tag registry, present only when non-empty. */
  tags?: TagDefinition[];
  /** Phase 20.2: the visual effects (present only when the project has some). */
  effects?: EffectDef[];
  /** Phase 23.9a: the project UI themes (present only when the project has some). */
  uiThemes?: UiTheme[];
  /** Phase 23.10: the game modes (present only when the project has some). */
  modes?: GameMode[];
  /** Phase 23.17: the timelines (present only when the project has some). */
  timelines?: TimelineAsset[];
  /** Phase 24.4i: the event → cue table (present only when the project has one). */
  eventCues?: EventCue[];
  /** Phase 24.4j: the game shell (present only when the project has one). */
  shell?: GameShell;
  /** Phase 14.1: the prefab definitions scripts spawn. */
  prefabs?: PrefabDefinition[];
  /** Phase 12 (c): a v4 project's scene artifacts. */
  scenes?: ManifestSceneRow[];
  /** Phase 25.7b: the content files (present only when the game has one of their blocks). */
  contentFiles?: ManifestContentFileRow[];
  assets: ReadonlyArray<Record<string, unknown>>;
  media: MediaBlock;
  behaviors: ReadonlyArray<Record<string, unknown>>;
  /** Phase 25.9: the shared script library modules (present only when a behavior imports a library). */
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
 * Phase 25.7b: a manifest with its content files read back under their keys
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
 * delivery.md §2.4 rule 1 — the block digest: `sha256(JSON.stringify(value,
 * null, 2) + "\n")` in the value's own key order. A `null` value serializes to
 * the four bytes `null`, so a null block hashes `null\n`.
 */
export function blockDigest(value: unknown): string {
  return sha256HexOfText(`${JSON.stringify(value, null, 2)}\n`);
}

/** The `profileDigest` of a canonical roles map (the §2.3 media animation row). */
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

/** Phase 15.3: a copy of recorded model bounds (canonical key order). */
function boundsCopy(b: { min: readonly number[]; max: readonly number[] }): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [b.min[0]!, b.min[1]!, b.min[2]!], max: [b.max[0]!, b.max[1]!, b.max[2]!] };
}

/** The six resolved settings keys in registry order (delivery.md §2.3). */
export const M3_SETTINGS_KEYS = [
  'gravity_y',
  'run_speed',
  'jump_velocity',
  'max_fall_speed',
  'max_slope_climb_deg',
  'min_slope_slide_deg',
] as const;

/**
 * Phase 15.3: the optional engine settings that may follow the six (only
 * when the project sets them), in registry order — a project that never sets
 * one keeps its exact settings block and digests.
 */
export const M3_OPTIONAL_SETTINGS_KEYS = ['fixed_step_hz', 'audio_voices', 'music_fade_s', 'animation_crossfade_s', 'render_backend', 'physics_dimension', 'sim_thread', 'debug_console', 'random_seed', 'depth_buffer', 'audio_spatial'] as const;

// ---------------------------------------------------------------------------
// Media identity (delivery.md §2.3 `media`)
// ---------------------------------------------------------------------------

/**
 * `resolveMediaIdentityV3(scene, content)` — the resolved media identity of ONE
 * captured v3 state (delivery.md §2.3, the C35-2 rationale). Pure over the
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
export function resolveMediaIdentityV3(scene: unknown, content: unknown, allScenes?: readonly unknown[]): ModelResultV2<MediaBlock> {
  const v4 = (scene as { schemaVersion?: unknown } | null)?.schemaVersion === 4;
  // Phase 21.2: with the project's scenes given, `scene` is the start scenes
  // merged (what the game starts with): the per-scene limits (colliders,
  // zones, spawns, the entity cap) apply to each scene below, not to their sum.
  const s = v4 ? (allScenes !== undefined ? validateMergedSceneV4(scene) : validateSceneV4(scene)) : validateSceneV3(scene);
  if (!s.ok) return { ok: false, errors: s.errors };
  const c = v4 ? validateContentV4(content) : validateContentV3(content);
  if (!c.ok) return { ok: false, errors: c.errors };
  let normScene = s.normalized as unknown as SceneV3;
  if (v4 && allScenes !== undefined) {
    const entities: SceneV3['entities'] = [];
    for (const doc of allScenes) {
      const r = validateSceneV4(doc);
      if (!r.ok) return { ok: false, errors: r.errors };
      entities.push(...(r.normalized.entities as SceneV3['entities']));
    }
    normScene = { ...normScene, entities };
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

  // Phase 24.8: the media block is the animation rows (the cue slots went with the game block).
  const media: MediaBlock = { animation: rows };
  return { ok: true, normalized: media };
}

// ---------------------------------------------------------------------------
// Captured v3 content view (delivery.md §2.3 `contentDigest` preimage)
// ---------------------------------------------------------------------------

/**
 * `captureContentViewV3(scene, content, ctx)` — the captured v3 content view
 * (the six-key `contentDigest` preimage: `{assets, prefabs, behaviors,
 * settings, behaviorTrust}`). Pure: validates the v3 pair, resolves the
 * reachable kind-tagged asset versions (project-model §19 v3 closure), the
 * resolved six-key settings, and derives the digest.
 */
export function captureContentViewV3(
  scene: unknown,
  content: unknown,
  ctx: { projectId: string; revision: number },
  /** Phase 12 (c), v4: every scene of the project (the view covers them all). */
  allScenes?: readonly unknown[],
): ModelResultV2<CapturedContentViewV3> {
  const v4 = (scene as { schemaVersion?: unknown } | null)?.schemaVersion === 4;
  // Phase 21.2: with the project's scenes given, `scene` is the start scenes
  // merged (what the game starts with): the per-scene limits (colliders,
  // zones, spawns, the entity cap) apply to each scene below, not to their sum.
  const s = v4 ? (allScenes !== undefined ? validateMergedSceneV4(scene) : validateSceneV4(scene)) : validateSceneV3(scene);
  if (!s.ok) return fail(s.errors);
  const c = v4 ? validateContentV4(content) : validateContentV3(content);
  if (!c.ok) return fail(c.errors);
  let normScene = s.normalized as unknown as SceneV3;
  const normContent = c.normalized as ContentCatalogV3;
  if (v4 && allScenes !== undefined) {
    const entities: SceneV3['entities'] = [];
    for (const doc of allScenes) {
      const r = validateSceneV4(doc);
      if (!r.ok) return fail(r.errors);
      entities.push(...(r.normalized.entities as SceneV3['entities']));
    }
    // The references of every scene (a scene loaded later needs its assets too).
    normScene = { ...normScene, entities };
  }

  const settingsRes = resolveGameplaySettings(normContent.settings);
  if (!settingsRes.ok) return fail(settingsRes.errors);

  const byId = new Map<string, AssetRecordV3>(normContent.assets.map((a) => [a.assetId, a]));
  const errors: ModelErrorV2[] = [];
  const assets: CapturedAssetV3[] = [];
  for (const ref of collectAssetRefsV3(normScene, normContent)) {
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
    assets.push({
      assetId: record.assetId,
      kind: record.kind,
      version: version.version,
      sourceDigest: version.sourceDigest,
      sourceByteLength: version.sourceByteLength,
      recipe: { id: importRecipe.profile, version: importRecipe.recipeVersion },
      metricsDigest: blockDigest(version.metrics),
      ...(record.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
      ...(record.materials !== undefined ? { materials: { ...record.materials } } : {}),
      ...(record.clipsFor !== undefined ? { clipsFor: record.clipsFor } : {}),
      // Phase 15.3: a model version's recorded bounds (absent before; the digests of older captures are unchanged).
      ...(record.kind === 'model' && (version.metrics as { bounds?: CapturedAssetV3['bounds'] }).bounds !== undefined ? { bounds: boundsCopy((version.metrics as { bounds: NonNullable<CapturedAssetV3['bounds']> }).bounds) } : {}),
    });
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
  const contentDigest = blockDigest(withoutDigest);
  return { ok: true, normalized: { ...withoutDigest, contentDigest } as CapturedContentViewV3 };
}

// ---------------------------------------------------------------------------
// Manifest v2 capture (the pure assembly)
// ---------------------------------------------------------------------------

export interface CaptureManifestV2Input {
  projectId: string;
  revision: number;
  /** UTC second at capture (project-model §7.2), e.g. `2026-09-19T10:00:00Z`. */
  capturedAt: string;
  /** The captured v3 scene document, or a precomputed `sceneDigest`. */
  scene?: unknown;
  sceneDigest?: string;
  /** The resolved kind-tagged asset rows (from `captureContentViewV3`). */
  assets: readonly ManifestAssetInputV2[];
  /** The reachable source-bearing behaviors (M2 row shape). */
  behaviors: readonly ManifestBehaviorInput[];
  /** Phase 25.9: the shared library modules the behaviors import (only when there are some). */
  libraries?: readonly Omit<ManifestLibraryRow, 'path'>[];
  /** The resolved six-key settings, in registry order. */
  settings: GameplaySettings;
  /** Phase 12 (b): the project tag registry; the manifest carries it only when non-empty. */
  tags?: readonly TagDefinition[];
  /** Phase 9.4: the project materials (only when non-empty) and the environment (only when set). */
  materials?: readonly MaterialDef[];
  /** Phase 18.3: the material functions the graph materials call (only when some are called). */
  materialFunctions?: readonly GraphDocument[];
  /** Phase 20.2: the visual effects (only when the project has some; `effectsForRuntime`). */
  effects?: readonly EffectDef[];
  /** Phase 23.9a: the project UI themes and documents (only when the project has some). */
  uiThemes?: readonly UiTheme[];
  uiDocuments?: readonly UiDocument[];
  /** Phase 23.16: the dialogue runner's data (`dialogueForRuntime`; only when the project has conversations). */
  dialogue?: RuntimeDialogueData | null;
  /** Phase 23.10: the game modes (only when the project has some). */
  modes?: readonly GameMode[];
  /** Phase 23.17: the timelines (only when the project has some). */
  timelines?: readonly TimelineAsset[];
  /** Phase 24.4i: the event → cue table (only when the project has one). */
  eventCues?: readonly EventCue[];
  /** Phase 24.4j: the game shell (only when the project has one). */
  shell?: GameShell;
  environment?: EnvironmentConfig;
  /** Phase 9.6: the scenes' bakes (only when some scene has one). */
  lighting?: LightingMap;
  /** Phase 9.7: the animator controllers (only when there are some). */
  animators?: readonly AnimatorController[];
  /** Phase 23.11: model assetId -> its rig (only when the project uses sockets). */
  rigs?: Readonly<Record<string, ModelRig>>;
  /** Phase 14.1: the prefab definitions scripts spawn (only when there are some). */
  prefabs?: readonly PrefabDefinition[];
  /** Phase 23.5: the block types and cell fields (only when there are some). */
  blockTypes?: readonly BlockType[];
  cellFields?: readonly CellField[];
  /** Phase 9.8: the project's input actions (only when it has its own). */
  input?: InputConfig;
  /** Phase 23.3: the project's named collision layers (only when it names some). */
  collisionLayers?: readonly string[];
  /** Phase 23.19: the project save schema (only when the project declares one). */
  saveSchema?: SaveSchema;
  /**
   * Phase 12 (c): a v4 project's scenes — one artifact each, loaded at start
   * (`start`) or on demand by the game; present only for a v4 project.
   */
  scenes?: readonly ManifestSceneRow[];
  /** Phase 12 (c): instance-set transform buffers (artifacts `content/sha256/<digest>`). */
  buffers?: readonly { digest: string; byteLength: number }[];
  /** The resolved media identity (from `resolveMediaIdentityV3`). */
  media: MediaBlock;
  /** The required engine module IDs (the M3 shared-composition set). */
  moduleIds: readonly string[];
  /** The captured-view digest (from `captureContentViewV3`) — required for v2. */
  contentDigest?: string;
  /** The emitted engine pins (defaults to {@link M3_ENGINE_PINS}). */
  enginePins?: readonly { id: string; version: string; apiVersion: number }[];
  /** The recipe table (defaults to {@link M3_RECIPE_VERSIONS}). */
  recipes?: Record<string, number>;
}

/** The combined M2+M3 module → package table (M3 ids win on overlap). */
const MODULE_PACKAGE_LOOKUP: Readonly<Record<string, string>> = {
  ...M2_MODULE_PACKAGES,
  ...M3_MODULE_PACKAGES,
};

/**
 * `captureManifestV2(input)` — the pure v2 manifest derivation. Every field is
 * derived from the arguments; `capturedAt` is caller-supplied. The block
 * digests and `buildId` use the §2.4 canonical ordering (owning-contract key
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

  const assets = [...input.assets]
    .map((a) => ({
      assetId: a.assetId,
      kind: a.kind,
      version: a.version,
      sourceDigest: a.sourceDigest,
      sourceByteLength: a.sourceByteLength,
      recipeDigest: a.recipeDigest ?? blockDigest(a.recipe ?? { id: 'unknown', version: 0 }),
      metricsDigest: a.metricsDigest,
      path: `content/sha256/${a.sourceDigest}`,
      ...(a.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
      ...(a.materials !== undefined ? { materials: canonicalMaterialMapping(a.materials) } : {}),
      ...(a.clipsFor !== undefined ? { clipsFor: a.clipsFor } : {}),
      ...(a.bounds !== undefined ? { bounds: boundsCopy(a.bounds) } : {}),
      ...(a.durationMs !== undefined && (a.kind === 'audio' || a.kind === 'music') ? { durationMs: a.durationMs } : {}),
    }))
    .sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : a.version - b.version));
  const behaviors = [...input.behaviors]
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

  const moduleIds = [...new Set(input.moduleIds)].sort();
  const modules = moduleIds.map((id) => {
    const pkg = MODULE_PACKAGE_LOOKUP[id];
    const pin = pkg !== undefined ? M3_ENGINE_PINS.find((p) => p.id === pkg) ?? M2_ENGINE_PINS.find((p) => p.id === pkg) : undefined;
    return { id, apiVersion: pin?.apiVersion ?? 1, package: pkg ?? '@thirdlight/runtime', version: pin?.version ?? '0.1.0' };
  });
  const enginePins = (input.enginePins ?? M3_ENGINE_PINS).map((p) => ({ id: p.id, version: p.version, apiVersion: p.apiVersion }));
  const recipes = { ...M3_RECIPE_VERSIONS, ...(input.recipes ?? {}) };

  const settingsDigest = blockDigest(input.settings);
  const mediaDigest = blockDigest(input.media);
  const buildOptionsDigest = sha256Hex(buildOptionsRecordBytes());

  // Phase 25.7b: the blocks that grow with the content go to their own files (canonical bytes, by digest).
  const fileBlocks: Partial<Record<ManifestContentFileKey, unknown>> = {
    ...(input.materials !== undefined && input.materials.length > 0 ? { materials: canonicalMaterials(input.materials) } : {}),
    ...(input.materialFunctions !== undefined && input.materialFunctions.length > 0 ? { materialFunctions: canonicalGraphDocuments(input.materialFunctions) } : {}),
    ...(input.uiDocuments !== undefined && input.uiDocuments.length > 0 ? { uiDocuments: canonicalUiDocuments(input.uiDocuments) } : {}),
    ...(input.dialogue !== undefined && input.dialogue !== null ? { dialogue: JSON.parse(JSON.stringify(input.dialogue)) as RuntimeDialogueData } : {}),
    ...(input.buffers !== undefined && input.buffers.length > 0 ? { buffers: input.buffers.map((b) => ({ digest: b.digest, byteLength: b.byteLength })) } : {}),
  };
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
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags.map((t) => ({ bit: t.bit, name: t.name })) } : {}),
    ...(input.effects !== undefined && input.effects.length > 0 ? { effects: canonicalEffects(input.effects) } : {}),
    ...(input.environment !== undefined ? { environment: canonicalEnvironment(input.environment) } : {}),
    ...(input.lighting !== undefined && Object.keys(input.lighting).length > 0 ? { lighting: canonicalLighting(input.lighting) } : {}),
    ...(input.animators !== undefined && input.animators.length > 0 ? { animators: canonicalAnimators(input.animators) } : {}),
    ...(input.rigs !== undefined && Object.keys(input.rigs).length > 0 ? { rigs: Object.fromEntries(Object.keys(input.rigs).sort().map((k) => [k, input.rigs![k]!])) } : {}),
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
    ...(input.scenes !== undefined ? { scenes: input.scenes.map((r) => ({ sceneId: r.sceneId, path: r.path, digest: r.digest, byteLength: r.byteLength, start: r.start })) } : {}),
    ...(contentFiles.length > 0 ? { contentFiles: contentFiles.map((f) => ({ key: f.key, path: f.path, digest: f.digest, byteLength: f.byteLength })) } : {}),
    assets,
    media: input.media,
    behaviors,
    ...(input.libraries !== undefined && input.libraries.length > 0
      ? {
          libraries: [...input.libraries]
            .map((l) => ({ libraryId: l.libraryId, sourceDigest: l.sourceDigest, outputDigest: l.outputDigest, outputByteLength: l.outputByteLength, path: `libraries/${l.outputDigest}.js` }))
            .sort((a, b) => (a.libraryId < b.libraryId ? -1 : a.libraryId > b.libraryId ? 1 : 0)),
        }
      : {}),
    modules,
    enginePins,
    recipes,
    toolchain: { esbuild: '0.28.2', typescript: '5.9.3', optionsDigest: buildOptionsDigest },
    buildOptionsDigest,
  };
  const preimage = manifestBuildIdInputV2(withoutBuildId);
  if (preimage === null) {
    return { ok: false, error: manifestError('internal', 'the v2 manifest document could not be serialized') };
  }
  const buildId = sha256Hex(preimage);
  // Phase 25.1 (D45): the document itself follows MANIFEST_KEYS_V2 (the literal above had dialogue before modes).
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
 * The exact bytes `buildId` covers for a v2 manifest (delivery.md §2.4 rule 2):
 * the document serialization of the manifest without `buildId`, key order
 * exactly `MANIFEST_KEYS_V2` with `buildId` last (excluded). Returns `null` if
 * any non-`buildId` key is absent.
 */
export function manifestBuildIdInputV2(manifest: Record<string, unknown>): Uint8Array | null {
  const without: Record<string, unknown> = {};
  for (const key of MANIFEST_KEYS_V2) {
    if (key === 'buildId') continue;
    if (OPTIONAL_MANIFEST_KEYS.has(key) && !(key in manifest)) continue; // phase 12: optional
    if (!(key in manifest)) return null;
    without[key] = manifest[key];
  }
  return new TextEncoder().encode(`${JSON.stringify(without, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Validation (strict v2 reader) + version-compat (delivery.md §2.1)
// ---------------------------------------------------------------------------

export interface ValidateManifestV2Options {
  /** The captured v3 scene (re-derives `sceneDigest` and the media identity). */
  scene?: unknown;
  /** The captured v3 content block (re-derives the media identity and asset kinds). */
  content?: unknown;
  /**
   * Phase 25.7b: the content files' blocks by key (parsed from their bytes).
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

const ASSET_KINDS = ['model', 'audio', 'texture', 'music', 'font'] as const;

function isDigest(v: unknown): v is string {
  return typeof v === 'string' && DIGEST_RE.test(v);
}

/**
 * `validateManifestV2(doc, opts?)` — the strict v2 reader (delivery.md §2).
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
    return { ok: false, error: manifestError('manifest_invalid', 'manifestVersion is not 4 (phase 25.7b: materials, UI documents, dialogue and buffers in content files)', 'manifest_version', d['manifestVersion'], '4') };
  }

  // Key set: exactly MANIFEST_KEYS_V2 (unknown or missing ⇒ manifest_invalid).
  for (const key of Object.keys(d)) {
    if (!(MANIFEST_KEYS_V2 as readonly string[]).includes(key)) {
      return { ok: false, error: manifestError('manifest_invalid', `unknown manifest key "${key}"`, 'unknown_key', key) };
    }
  }
  for (const key of MANIFEST_KEYS_V2) {
    if (OPTIONAL_MANIFEST_KEYS.has(key)) continue; // phase 12: optional
    if (!(key in d)) return { ok: false, error: manifestError('manifest_invalid', `missing manifest key "${key}"`, 'missing_key', undefined, key) };
  }
  if (d['rigs'] !== undefined) {
    const r = d['rigs'];
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return { ok: false, error: manifestError('manifest_invalid', 'rigs maps model asset ids to rigs', 'field_value') };
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      const why = validateModelRig(v);
      if (why !== null) return { ok: false, error: manifestError('manifest_invalid', `rigs["${k}"]: ${why}`.slice(0, 256), 'field_value') };
    }
  }
  if (d['tags'] !== undefined) {
    const tagErrors: ModelErrorV2[] = [];
    validateTagRegistry(d['tags'], '/tags', tagErrors);
    if (tagErrors.length > 0) return { ok: false, error: manifestError('manifest_invalid', 'tags is not a valid tag registry', 'field_value') };
  }
  // Phase 23.17: the timelines validate as content.timelines does (their own rules).
  if (d['timelines'] !== undefined) {
    const tlErrors: ModelErrorV2[] = [];
    validateTimelines(d['timelines'], '/timelines', tlErrors);
    if (tlErrors.length > 0) return { ok: false, error: manifestError('manifest_invalid', 'timelines are not valid', 'field_value') };
  }
  // Phase 24.4i: the event → cue table validates as content.eventCues does.
  if (d['eventCues'] !== undefined) {
    const ecErrors: ModelErrorV2[] = [];
    validateEventCues(d['eventCues'], '/eventCues', ecErrors);
    if (ecErrors.length > 0) return { ok: false, error: manifestError('manifest_invalid', 'eventCues are not valid', 'field_value') };
  }
  // Phase 24.4j: the game shell validates as content.shell does.
  if (d['shell'] !== undefined) {
    const shErrors: ModelErrorV2[] = [];
    validateShell(d['shell'], '/shell', shErrors);
    if (shErrors.length > 0) return { ok: false, error: manifestError('manifest_invalid', 'shell is not valid', 'field_value') };
  }
  if (d['effects'] !== undefined || d['environment'] !== undefined || d['lighting'] !== undefined || d['animators'] !== undefined || d['prefabs'] !== undefined || d['input'] !== undefined || d['collisionLayers'] !== undefined || d['uiThemes'] !== undefined || d['modes'] !== undefined) {
    const matErrors: ModelErrorV2[] = [];
    // Phase 20.2: the effects validate as content.effects does.
    if (d['effects'] !== undefined) validateEffects(d['effects'], '/effects', matErrors);
    if (d['environment'] !== undefined) validateEnvironment(d['environment'], '/environment', matErrors);
    if (d['lighting'] !== undefined) validateLighting(d['lighting'], '/lighting', matErrors);
    if (d['animators'] !== undefined) validateAnimators(d['animators'], '/animators', matErrors);
    if (d['prefabs'] !== undefined) validatePrefabDefinitions(d['prefabs'], '/prefabs', matErrors, 4);
    if (d['input'] !== undefined) validateInput(d['input'], '/input', matErrors);
    if (d['collisionLayers'] !== undefined) validateCollisionLayers(d['collisionLayers'], '/collisionLayers', matErrors);
    // Phase 23.9a: the UI themes validate as content.uiThemes does (the documents are a content file).
    if (d['uiThemes'] !== undefined) validateUiThemes(d['uiThemes'], '/uiThemes', matErrors);
    // Phase 23.10: the game modes validate as content.modes does.
    if (d['modes'] !== undefined) validateModes(d['modes'], '/modes', matErrors);
    if (matErrors.length > 0) return { ok: false, error: manifestError('manifest_invalid', 'effects/environment/lighting are not valid', 'field_value') };
  }

  if (d['blockTypes'] !== undefined || d['cellFields'] !== undefined) {
    const blockErrors: ModelErrorV2[] = [];
    if (d['blockTypes'] !== undefined) validateBlockTypes(d['blockTypes'], '/blockTypes', blockErrors);
    if (d['cellFields'] !== undefined) validateCellFields(d['cellFields'], '/cellFields', blockErrors);
    if (blockErrors.length > 0) return { ok: false, error: manifestError('manifest_invalid', 'blockTypes/cellFields are not valid', 'field_value') };
  }
  // Phase 25.7b: the content file rows (and, when given, their blocks).
  if (d['contentFiles'] !== undefined) {
    const rowsRes = contentFileRowsProblem(d['contentFiles']);
    if (rowsRes !== null) return { ok: false, error: manifestError('manifest_invalid', `contentFiles: ${rowsRes}`.slice(0, 256), 'field_value') };
  }
  if (opts?.contentFiles !== undefined) {
    const blocksRes = contentFileBlocksProblem((d['contentFiles'] as ManifestContentFileRow[] | undefined) ?? [], opts.contentFiles, d['input']);
    if (blocksRes !== null) return { ok: false, error: manifestError('manifest_invalid', blocksRes.slice(0, 256), 'content_file') };
  }
  if (d['saveSchema'] !== undefined) {
    const saveErrors: ModelErrorV2[] = [];
    validateSaveSchema(d['saveSchema'], '/saveSchema', saveErrors);
    if (saveErrors.length > 0) return { ok: false, error: manifestError('manifest_invalid', 'saveSchema is not valid', 'field_value') };
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

  // media shape — exactly the animation rows (phase 24.8: no cue slots).
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
      return { ok: false, error: manifestError('manifest_invalid', `assets[${i}].kind must be "model" or "audio"`, 'field_value', a['kind']) };
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

  // Phase 25.9: the shared library rows (ascending ids, digest-named paths).
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

/** Phase 25.9: why a `libraries` value is not a list of shared library rows (null: it is). */
function libraryRowsProblem(v: unknown): string | null {
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

/** Phase 25.7b: why a `contentFiles` value is not a list of rows in key order (null: it is). */
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

/** Phase 25.7b: why the content files' blocks do not match their rows or do not validate (null: they do). */
function contentFileBlocksProblem(rows: readonly ManifestContentFileRow[], blocks: Partial<Record<ManifestContentFileKey, unknown>>, input: unknown): string | null {
  for (const key of Object.keys(blocks)) {
    if (!rows.some((r) => r.key === key)) return `content file ${key} is not listed in contentFiles`;
  }
  const errors: ModelErrorV2[] = [];
  for (const row of rows) {
    if (!(row.key in blocks)) return `content file ${row.key} is missing`;
    const block = blocks[row.key];
    const bytes = new TextEncoder().encode(`${JSON.stringify(block, null, 2)}\n`);
    if (bytes.length !== row.byteLength || sha256Hex(bytes) !== row.digest) return `content file ${row.key} does not match its digest`;
    switch (row.key) {
      case 'materialFunctions':
        // Phase 18.3: the functions validate as graph documents (kind material-function only); graph materials call them.
        validateGraphDocuments(GRAPH_KINDS, block, '/materialFunctions', errors);
        if (Array.isArray(block) && (block as unknown[]).some((g) => (g as { kind?: unknown } | null)?.kind !== 'material-function')) {
          errors.push({ code: 'field_value', path: '/materialFunctions', message: 'materialFunctions holds material functions only' } as ModelErrorV2);
        }
        break;
      case 'materials':
        validateMaterials(block, '/materials', errors, graphDocumentsContext(GRAPH_KINDS, blocks.materialFunctions));
        break;
      case 'uiDocuments':
        validateUiDocuments(block, '/uiDocuments', errors, projectInputMaps(input));
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
    if (errors.length > 0) return `content file ${row.key} is not valid: ${errors[0]!.message}`;
  }
  return null;
}

/**
 * delivery.md §2.1 — the version-compatibility rule. A v1 reader must reject a
 * v2 document with `manifest_invalid` (`reason: "manifest_version"`) and a v2
 * reader must reject a v1 document; an in-place upgrade is forbidden. Phase
 * 24.8: the reader was v3; phase 25.7b: it is v4 (it refuses v1–v3 alike).
 */
export function manifestVersionCompat(
  doc: unknown,
  reader: 1 | 4,
): { ok: true; version: 1 | 4 } | { ok: false; error: ManifestErrorV2 } {
  const version = isPlainObject(doc) ? (doc as Record<string, unknown>)['manifestVersion'] : undefined;
  if (version === reader) return { ok: true, version: reader };
  return { ok: false, error: manifestError('manifest_invalid', `a v${reader} reader cannot load a v${typeof version === 'number' ? version : 'unknown'} manifest document`, 'manifest_version', version, String(reader)) };
}
