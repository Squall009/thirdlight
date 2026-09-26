/**
 * Manifest v2 — the immutable M3 runtime-content identity (delivery.md §2,
 * sessions.md §17.1.1, packet 58).
 *
 * `captureManifestV2` is the pure derivation of the v2 delivery manifest from
 * ONE already-captured authoring state (the single acknowledged envelope read,
 * delivery.md §2.6): the captured v3 scene, the captured content block
 * (resolved settings, the frozen `game`, the reachable kind-tagged assets),
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
 * **Canonical ordering (normative, delivery.md §2.4).** Every block digest and
 * the `buildId` hash `JSON.stringify(value, null, 2) + "\n"` in the owning
 * contract's key order — NOT sorted-key canonicalization. `settings` is in
 * registry order, `game` in canonical `GameConfig` order, `media` in the §2.2
 * order, the content view in `{assets, prefabs, behaviors, settings,
 * behaviorTrust, game}` order and the manifest in `MANIFEST_KEYS_V2` order
 * (`buildId` last). A `null` block hashes its own four canonical bytes (`null`).
 *
 * This module lives in the zero-dependency `project-model` leaf (the single
 * pure owner of the manifest derivation, C36-2); it reuses the M2 canonical
 * helpers and the `./sha256` digest primitives.
 */
import { canonicalEnvironment, canonicalMaterialMapping, canonicalMaterials, validateEnvironment, validateMaterials, type EnvironmentConfig, type MaterialDef } from './materials';
import { canonicalAnimators, validateAnimators, type AnimatorController } from './animator';
import { canonicalInput, validateInput, type InputConfig } from './input';
import { canonicalFlow, validateFlow, type GameFlow } from './flow';
import { canonicalLighting, validateLighting, type LightingMap } from './lighting';
import { sha256Hex, sha256HexOfText } from './sha256';
import { canonicalGraphDocuments, graphDocumentsContext, validateGraphDocuments, type GraphDocument } from './graph';
import { GRAPH_KINDS } from './graph-kinds';
import { canonicalEffects, validateEffects, type EffectDef } from './effects';
import { fail, isPlainObject, withFound } from './validate';
import { validateMergedSceneV4, validateSceneV3, validateSceneV4 } from './scene-v3';
import { canonicalPrefabs, validateContentV3, validateContentV4, validatePrefabDefinitions, resolveGameplaySettings, validateTagRegistry } from './content';
import { collectAssetRefsV3 } from './capture';
import type { ModelErrorV2, ModelResultV2 } from './errors';
import type {
  AssetKind,
  AssetRecordV3,
  ContentCatalogV3,
  GameConfig,
  SceneV3,
  TagDefinition,
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

/** The v2 manifest shape version (delivery.md §2.1). */
export const RUNTIME_CONTENT_MANIFEST_VERSION_2 = 2 as const;

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
const OPTIONAL_MANIFEST_KEYS = new Set(['tags', 'materials', 'materialFunctions', 'effects', 'environment', 'lighting', 'animators', 'prefabs', 'input', 'flow', 'scenes', 'buffers']);

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
  'gameDigest',
  'settingsDigest',
  'mediaDigest',
  'settings',
  'game',
  'tags',
  'materials',
  // Phase 18.3: the material functions graph materials call (standalone graphs of kind material-function).
  'materialFunctions',
  // Phase 20.2: the visual effects (particle system graphs) the game plays.
  'effects',
  'environment',
  'lighting',
  'animators',
  'prefabs',
  'input',
  'flow',
  'scenes',
  'buffers',
  'assets',
  'media',
  'behaviors',
  'modules',
  'enginePins',
  'recipes',
  'toolchain',
  'buildOptionsDigest',
  'buildId',
] as const;

/** The five game cue slots, in the §2.2 ascending key order. */
export const CUE_SLOTS = ['start', 'jump', 'checkpoint', 'death', 'goal'] as const;
export type CueSlot = (typeof CUE_SLOTS)[number];

/**
 * The M3 shared-composition engine pins (delivery.md §2.2 / K-5). The
 * identity values are the accepted pin table for the shared production
 * composition; the closure builder re-derives the emitted set from the real
 * lockfile pin table at build time and passes it explicitly (K-5/FU-5).
 * Ascending by `id`.
 */
export const M3_ENGINE_PINS: ReadonlyArray<{ id: string; version: string; apiVersion: number }> = Object.freeze([
  Object.freeze({ id: '@thirdlight/platformer-game', version: '0.1.0', apiVersion: 1 }),
  Object.freeze({ id: '@thirdlight/runtime', version: '0.1.0', apiVersion: 2 }),
  Object.freeze({ id: '@thirdlight/three', version: '0.186.0', apiVersion: 0 }),
]);

/** The package a known M3 module id belongs to (the manifest `modules` rows). */
export const M3_MODULE_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  'thirdlight.platformer-game:camera': '@thirdlight/platformer-game',
  'thirdlight.platformer-game:session': '@thirdlight/platformer-game',
  'thirdlight.platformer:controller': '@thirdlight/platformer',
  // Phase 23.0: the 3D physics backend (physics_dimension 3).
  'thirdlight.physics-rapier:3d': '@thirdlight/physics-rapier',
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
  game: GameConfig | null;
  /** `sha256(JSON.stringify({assets,prefabs,behaviors,settings,behaviorTrust,game},null,2)+"\n")`. */
  contentDigest: string;
}

/** One resolved cue reference of the media identity. */
export interface MediaCueRef {
  assetId: string;
  version: number;
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
  cues: Record<CueSlot, MediaCueRef | null>;
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
  gameDigest: string;
  settingsDigest: string;
  mediaDigest: string;
  settings: GameplaySettings;
  game: GameConfig | null;
  /** Phase 12 (b): the tag registry, present only when non-empty. */
  tags?: TagDefinition[];
  /** Phase 18.3: the material functions graph materials call. */
  materialFunctions?: GraphDocument[];
  /** Phase 20.2: the visual effects (present only when the project has some). */
  effects?: EffectDef[];
  /** Phase 14.1: the prefab definitions scripts spawn. */
  prefabs?: PrefabDefinition[];
  /** Phase 12 (c): a v4 project's scene artifacts. */
  scenes?: ManifestSceneRow[];
  /** Phase 12 (c): instance-set buffers. */
  buffers?: { digest: string; byteLength: number }[];
  assets: ReadonlyArray<Record<string, unknown>>;
  media: MediaBlock;
  behaviors: ReadonlyArray<Record<string, unknown>>;
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

export type CaptureManifestV2Result =
  | { ok: true; manifest: RuntimeContentManifestV2; bytes: Uint8Array; buildId: string }
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
export const M3_OPTIONAL_SETTINGS_KEYS = ['fixed_step_hz', 'audio_voices', 'music_fade_s', 'animation_crossfade_s', 'render_backend', 'physics_dimension', 'sim_thread', 'debug_console', 'random_seed', 'depth_buffer'] as const;

// ---------------------------------------------------------------------------
// Media identity (delivery.md §2.3 `media`)
// ---------------------------------------------------------------------------

/**
 * `resolveMediaIdentityV3(scene, content)` — the resolved media identity of ONE
 * captured v3 state (delivery.md §2.3, the C35-2 rationale). Pure over the
 * normalized (or raw, validated here) scene + content:
 *
 *   - `cues`: the five `content.game.cues` slots resolved to `{assetId,
 *     version}` (the record's `currentVersion` — a cue reference carries no
 *     explicit version pin) or `null`, ascending `CUE_SLOTS` order;
 *   - `animation`: one row per `modelAnimation` entity, ascending by
 *     `entityId` then `assetId`, each carrying the immutable `(assetId,
 *     version)`, the `profileDigest` of its canonical `roles` bytes and the
 *     validated `roles` map.
 *
 * A cue/animation reference that resolves to no catalog record (or a record of
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

function mediaIdentityFrom(scene: SceneV3, content: ContentCatalogV3): ModelResultV2<MediaBlock> {
  const byId = new Map<string, AssetRecordV3>(content.assets.map((a) => [a.assetId, a]));
  const errors: ModelErrorV2[] = [];

  // cues — the five game slots (ascending CUE_SLOTS order).
  const cues = {} as Record<CueSlot, MediaCueRef | null>;
  const game = content.game;
  for (const slot of CUE_SLOTS) {
    if (game === null) {
      cues[slot] = null;
      continue;
    }
    const ref = game.cues[slot];
    if (ref === null || ref === undefined) {
      cues[slot] = null;
      continue;
    }
    const record = byId.get(ref);
    if (!record) {
      errors.push(withFound({ code: 'asset_reference_missing', path: `/game/cues/${slot}`, document: 'content', message: 'a game cue resolves to no catalog record', expected: 'an existing audio assetId' }, ref));
      cues[slot] = null;
      continue;
    }
    if (record.kind !== 'audio') {
      errors.push(withFound({ code: 'asset_kind_mismatch', path: `/game/cues/${slot}`, document: 'content', message: 'a game cue must reference an audio asset', expected: 'kind "audio"' }, record.kind));
      cues[slot] = null;
      continue;
    }
    cues[slot] = { assetId: record.assetId, version: record.currentVersion };
  }

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

  // Build the media block in the §2.2 key order (cues before animation; cues in
  // CUE_SLOTS order) so its canonical serialization is deterministic.
  const media: MediaBlock = { cues, animation: rows };
  return { ok: true, normalized: media };
}

// ---------------------------------------------------------------------------
// Captured v3 content view (delivery.md §2.3 `contentDigest` preimage)
// ---------------------------------------------------------------------------

/**
 * `captureContentViewV3(scene, content, ctx)` — the captured v3 content view
 * (the six-key `contentDigest` preimage: `{assets, prefabs, behaviors,
 * settings, behaviorTrust, game}`). Pure: validates the v3 pair, resolves the
 * reachable kind-tagged asset versions (project-model §19 v3 closure), the
 * resolved six-key settings and the frozen `game`, and derives the digest.
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
    game: normContent.game,
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
  /** The resolved six-key settings, in registry order. */
  settings: GameplaySettings;
  /** The frozen `content.game` value (canonical `GameConfig` order) or `null`. */
  game: GameConfig | null;
  /** Phase 12 (b): the project tag registry; the manifest carries it only when non-empty. */
  tags?: readonly TagDefinition[];
  /** Phase 9.4: the project materials (only when non-empty) and the environment (only when set). */
  materials?: readonly MaterialDef[];
  /** Phase 18.3: the material functions the graph materials call (only when some are called). */
  materialFunctions?: readonly GraphDocument[];
  /** Phase 20.2: the visual effects (only when the project has some; `effectsForRuntime`). */
  effects?: readonly EffectDef[];
  environment?: EnvironmentConfig;
  /** Phase 9.6: the scenes' bakes (only when some scene has one). */
  lighting?: LightingMap;
  /** Phase 9.7: the animator controllers (only when there are some). */
  animators?: readonly AnimatorController[];
  /** Phase 14.1: the prefab definitions scripts spawn (only when there are some). */
  prefabs?: readonly PrefabDefinition[];
  /** Phase 9.8: the project's input actions (only when it has its own). */
  input?: InputConfig;
  /** Phase 9.10: the game flow (only when the project has one). */
  flow?: GameFlow;
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

  const gameDigest = blockDigest(input.game);
  const settingsDigest = blockDigest(input.settings);
  const mediaDigest = blockDigest(input.media);
  const buildOptionsDigest = sha256Hex(buildOptionsRecordBytes());

  const withoutBuildId: Record<string, unknown> = {
    manifestVersion: RUNTIME_CONTENT_MANIFEST_VERSION_2,
    type: RUNTIME_CONTENT_TYPE,
    projectId: input.projectId,
    revision: input.revision,
    snapshotId: `${input.projectId}@r${input.revision}`,
    capturedAt: input.capturedAt,
    sceneDigest,
    contentDigest,
    gameDigest,
    settingsDigest,
    mediaDigest,
    settings: input.settings,
    game: input.game,
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags.map((t) => ({ bit: t.bit, name: t.name })) } : {}),
    ...(input.materials !== undefined && input.materials.length > 0 ? { materials: canonicalMaterials(input.materials) } : {}),
    ...(input.materialFunctions !== undefined && input.materialFunctions.length > 0 ? { materialFunctions: canonicalGraphDocuments(input.materialFunctions) } : {}),
    ...(input.effects !== undefined && input.effects.length > 0 ? { effects: canonicalEffects(input.effects) } : {}),
    ...(input.environment !== undefined ? { environment: canonicalEnvironment(input.environment) } : {}),
    ...(input.lighting !== undefined && Object.keys(input.lighting).length > 0 ? { lighting: canonicalLighting(input.lighting) } : {}),
    ...(input.animators !== undefined && input.animators.length > 0 ? { animators: canonicalAnimators(input.animators) } : {}),
    ...(input.prefabs !== undefined && input.prefabs.length > 0 ? { prefabs: canonicalPrefabs(input.prefabs) } : {}),
    ...(input.input !== undefined ? { input: canonicalInput(input.input) } : {}),
    ...(input.flow !== undefined ? { flow: canonicalFlow(input.flow) } : {}),
    ...(input.scenes !== undefined ? { scenes: input.scenes.map((r) => ({ sceneId: r.sceneId, path: r.path, digest: r.digest, byteLength: r.byteLength, start: r.start })) } : {}),
    ...(input.buffers !== undefined && input.buffers.length > 0 ? { buffers: input.buffers.map((b) => ({ digest: b.digest, byteLength: b.byteLength })) } : {}),
    assets,
    media: input.media,
    behaviors,
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
  const manifest = { ...withoutBuildId, buildId } as unknown as RuntimeContentManifestV2;
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  if (bytes.length > RUNTIME_CONTENT_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      error: manifestError('limits_exceeded', `the v2 manifest document exceeds ${RUNTIME_CONTENT_MANIFEST_MAX_BYTES} bytes`),
    };
  }
  return { ok: true, manifest, bytes, buildId };
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
}

export type ValidateManifestV2Result =
  | { ok: true; manifest: RuntimeContentManifestV2 }
  | { ok: false; error: ManifestErrorV2 };

const ASSET_KINDS = ['model', 'audio', 'texture', 'music'] as const;

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
  if (d['manifestVersion'] !== RUNTIME_CONTENT_MANIFEST_VERSION_2) {
    return { ok: false, error: manifestError('manifest_invalid', 'manifestVersion is not 2', 'manifest_version', d['manifestVersion'], '2') };
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
  if (d['tags'] !== undefined) {
    const tagErrors: ModelErrorV2[] = [];
    validateTagRegistry(d['tags'], '/tags', tagErrors);
    if (tagErrors.length > 0) return { ok: false, error: manifestError('manifest_invalid', 'tags is not a valid tag registry', 'field_value') };
  }
  if (d['materials'] !== undefined || d['materialFunctions'] !== undefined || d['effects'] !== undefined || d['environment'] !== undefined || d['lighting'] !== undefined || d['animators'] !== undefined || d['prefabs'] !== undefined || d['input'] !== undefined || d['flow'] !== undefined) {
    const matErrors: ModelErrorV2[] = [];
    // Phase 18.3: the functions validate as graph documents (kind material-function only); graph materials call them.
    if (d['materialFunctions'] !== undefined) {
      validateGraphDocuments(GRAPH_KINDS, d['materialFunctions'], '/materialFunctions', matErrors);
      if (Array.isArray(d['materialFunctions']) && (d['materialFunctions'] as unknown[]).some((g) => (g as { kind?: unknown } | null)?.kind !== 'material-function')) {
        matErrors.push({ code: 'field_value', path: '/materialFunctions', message: 'materialFunctions holds material functions only' } as ModelErrorV2);
      }
    }
    if (d['materials'] !== undefined) validateMaterials(d['materials'], '/materials', matErrors, graphDocumentsContext(GRAPH_KINDS, d['materialFunctions']));
    // Phase 20.2: the effects validate as content.effects does.
    if (d['effects'] !== undefined) validateEffects(d['effects'], '/effects', matErrors);
    if (d['environment'] !== undefined) validateEnvironment(d['environment'], '/environment', matErrors);
    if (d['lighting'] !== undefined) validateLighting(d['lighting'], '/lighting', matErrors);
    if (d['animators'] !== undefined) validateAnimators(d['animators'], '/animators', matErrors);
    if (d['prefabs'] !== undefined) validatePrefabDefinitions(d['prefabs'], '/prefabs', matErrors, 4);
    if (d['input'] !== undefined) validateInput(d['input'], '/input', matErrors);
    if (d['flow'] !== undefined) validateFlow(d['flow'], '/flow', matErrors);
    if (matErrors.length > 0) return { ok: false, error: manifestError('manifest_invalid', 'materials/environment/lighting are not valid', 'field_value') };
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
  for (const key of ['sceneDigest', 'contentDigest', 'gameDigest', 'settingsDigest', 'mediaDigest', 'buildOptionsDigest', 'buildId'] as const) {
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
  const game = d['game'];
  if (game !== null && !isPlainObject(game)) return { ok: false, error: manifestError('manifest_invalid', 'game must be an object or null', 'field_value') };
  const media = d['media'];
  if (!isPlainObject(media)) return { ok: false, error: manifestError('manifest_invalid', 'media must be an object', 'field_value') };
  if (blockDigest(settings) !== d['settingsDigest']) {
    return { ok: false, error: manifestError('manifest_invalid', 'settingsDigest does not match the settings block', 'digest_mismatch', d['settingsDigest'], blockDigest(settings)) };
  }
  if (blockDigest(game) !== d['gameDigest']) {
    return { ok: false, error: manifestError('manifest_invalid', 'gameDigest does not match the game block', 'digest_mismatch', d['gameDigest'], blockDigest(game)) };
  }
  if (blockDigest(media) !== d['mediaDigest']) {
    return { ok: false, error: manifestError('manifest_invalid', 'mediaDigest does not match the media block', 'digest_mismatch', d['mediaDigest'], blockDigest(media)) };
  }

  // media shape — five cue slots in order + animation rows.
  const cues = (media as Record<string, unknown>)['cues'];
  const animation = (media as Record<string, unknown>)['animation'];
  if (!isPlainObject(cues) || !Array.isArray(animation)) {
    return { ok: false, error: manifestError('manifest_invalid', 'media must carry cues and animation', 'field_value') };
  }
  const cueKeys = Object.keys(cues);
  if (cueKeys.length !== CUE_SLOTS.length || !cueKeys.every((k, i) => k === CUE_SLOTS[i])) {
    return { ok: false, error: manifestError('manifest_invalid', 'media.cues must carry the five slots in order', 'field_value', cueKeys) };
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
 * delivery.md §2.1 — the version-compatibility rule. A v1 reader must reject a
 * v2 document with `manifest_invalid` (`reason: "manifest_version"`) and a v2
 * reader must reject a v1 document; an in-place upgrade is forbidden.
 */
export function manifestVersionCompat(
  doc: unknown,
  reader: 1 | 2,
): { ok: true; version: 1 | 2 } | { ok: false; error: ManifestErrorV2 } {
  const version = isPlainObject(doc) ? (doc as Record<string, unknown>)['manifestVersion'] : undefined;
  if (version === reader) return { ok: true, version: reader as 1 | 2 };
  return { ok: false, error: manifestError('manifest_invalid', `a v${reader} reader cannot load a v${typeof version === 'number' ? version : 'unknown'} manifest document`, 'manifest_version', version, String(reader)) };
}
