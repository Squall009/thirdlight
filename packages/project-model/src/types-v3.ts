/**
 * Explicitly versioned v3 logical types — project-model.md §23
 * (scene `schemaVersion` 3, the six appended components, the bounded
 * `content.game` block and the `audio` asset kind).
 *
 * The M1 (`types.ts`) and M2 (`types-v2.ts`) types are unchanged. These
 * describe the STRICT canonical output of the v3 normalizers (§12.2/§23.7):
 * only the §23.7 defaults are filled, component/field order is the §23.3
 * registry order, and only present fields are emitted. Inputs to the entry
 * points are `unknown`; the boundary re-checks every rule.
 *
 * Packet 41 owns `AnimationRoleBinding`'s media fields and the WAV
 * `importRecipe`/`AssetMetrics` vocabulary; this module fixes only the
 * container shapes 39 owns (the three role keys, the asset/version binding,
 * the `audio` discriminator) — see §23.3.6/§23.3.7.
 */

import type {
  AssetMetrics,
  AssetVersion,
  BehaviorRecord,
  BehaviorTrust,
  EntityComponentsV2,
  PrefabDefinition,
  SettingsMap,
} from './types-v2';
import type { Vec3 } from './types';

// ---- scene schemaVersion 3 registry (§23.3) ----------------------------------

/** The §23.3 v3 registry, in canonical order (v2 registry plus six). */
export const V3_REGISTRY = [
  'transform',
  'model',
  'box',
  'camera',
  'behavior',
  'prefab',
  'collider',
  'controller',
  'gameZone',
  'playerSpawn',
  'cameraFollow',
  'light',
  'surface',
  'modelAnimation',
  'folder',
] as const;
export type ComponentV3 = (typeof V3_REGISTRY)[number];

/** §23.3.1 game-zone roles (the closed set). */
export const GAME_ZONE_ROLES = ['hazard', 'checkpoint', 'goal'] as const;
export type GameZoneRole = (typeof GAME_ZONE_ROLES)[number];

/** §23.3.1a checkpoint activation appearance (all three fields explicit). */
export interface CheckpointActivationAppearance {
  /** `^#[0-9a-f]{6}$`; canonical lowercase. */
  emissive: string;
  /** [0, 4]. */
  emissiveIntensity: number;
  /** `null` = use `content.game.cues.checkpoint`. */
  cueAssetId: string | null;
}

/** §23.3.1 axis-aligned XY game zone. */
export interface GameZoneComponent {
  role: GameZoneRole;
  /** `[widthX, heightY]` full extents (meters). */
  size: [number, number];
  /** Required iff `role === 'checkpoint'`; resolves to a `playerSpawn` entity. */
  safeSpawnId?: string;
  /** Required iff `role === 'checkpoint'`. */
  activation?: CheckpointActivationAppearance;
}

/** §23.3.2 field-less spawn marker. */
export type PlayerSpawnComponent = Record<string, never>;

/** §23.3.3 camera follow data (presentation math is packet 40's). */
export interface CameraFollowComponent {
  /** Half-extents (meters). */
  deadZone: { x: number; y: number };
  /** [0, 1]; `0` = hard snap. */
  smoothing: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

/** §23.3.4 one directional key light or one ambient fill. */
export interface LightComponent {
  type: 'directional' | 'ambient';
  /** `^#[0-9a-f]{6}$`; canonical lowercase. */
  color: string;
  /** [0, 8]. */
  intensity: number;
  /** Required iff `type === 'directional'`; each `|v| <= 1`, `||v|| >= 1e-6`. */
  direction?: Vec3;
  /** Directional only; defaulted to `false` by the §23.7 normalizer. */
  castShadow?: boolean;
}

/** §23.3.5 copied surface value row (never a linked resource). */
export interface SurfaceComponent {
  /** `^#[0-9a-f]{6}$`; canonical lowercase. No default (present component fills `#b0b0b0`). */
  color: string;
  roughness: number;
  metalness: number;
  emissive: string;
  emissiveIntensity: number;
}

/**
 * §23.3.6 one rigid animation role binding. Packet 41 owns the binding's
 * fields; 39 fixes the role key set, all-three-required, that each binding
 * is a non-empty JSON object owned by the version, and the byte bound.
 */
export type AnimationRoleBinding = Record<string, unknown>;

/** §23.3.6 animated model instance. */
export interface ModelAnimationComponent {
  /** Resolves in `content.assets` with `kind === 'model'`. */
  assetId: string;
  /** `1 <= version <= that record's currentVersion`. */
  version: number;
  roles: {
    idle: AnimationRoleBinding;
    run: AnimationRoleBinding;
    airborne: AnimationRoleBinding;
  };
}

/** v3 component set (canonical order = {@link V3_REGISTRY}). */
export interface EntityComponentsV3 extends EntityComponentsV2 {
  gameZone?: GameZoneComponent;
  playerSpawn?: PlayerSpawnComponent;
  cameraFollow?: CameraFollowComponent;
  light?: LightComponent;
  surface?: SurfaceComponent;
  modelAnimation?: ModelAnimationComponent;
}

/**
 * Hierarchy flags every entity may carry (phase 12). Only non-default values
 * are stored: `active: false` (the entity and its subtree are left out of the
 * game and hidden in the editor), `locked: true` (editor only: not pickable
 * or movable in the viewport), `static: true` (the object does not move).
 * A folder passes all three down to its whole subtree; any inactive ancestor
 * makes its subtree inactive.
 */
export interface EntityFlagsV3 {
  active?: false;
  locked?: true;
  static?: true;
}

export interface EntityV3 extends EntityFlagsV3 {
  id: string;
  name?: string;
  parentId?: string;
  components: EntityComponentsV3;
}

/**
 * Phase 12 folder marker: organisation only. A folder carries no transform
 * and no other component, and sits at the root or inside another folder, so
 * it never moves what is filed in it.
 */
export type FolderComponent = Record<string, never>;

/** A folder's components: the marker and nothing else. */
export type FolderComponentsV3 = { folder: FolderComponent } & {
  [K in keyof EntityComponentsV3]?: undefined;
};

export interface FolderEntityV3 extends EntityFlagsV3 {
  id: string;
  name?: string;
  parentId?: string;
  components: FolderComponentsV3;
}

/** An authored scene entity: an object (with a transform) or a folder. */
export type SceneEntityV3 = EntityV3 | FolderEntityV3;

export function isFolderEntity(e: { components: object }): e is FolderEntityV3 {
  return (e.components as { folder?: unknown }).folder !== undefined;
}

/** The authored scene: objects and folders. */
export interface SceneV3 {
  schemaVersion: 3;
  sceneId: string;
  revision: number;
  entities: SceneEntityV3[];
}

/**
 * A scene as the game loads it (`resolveSceneHierarchy`): no folders, no
 * inactive entities; every entity carries its effective flags.
 */
export interface ResolvedSceneV3 {
  schemaVersion: 3;
  sceneId: string;
  revision: number;
  entities: EntityV3[];
}

// ---- content: audio kind and content.game (§23.3.7/§23.4) ---------------------

/** §23.3.7 the v3 asset-kind discriminator. */
export type AssetKind = 'model' | 'audio';

/**
 * presentation.md §41.4.3: the `gltf-glb` recipe member (the accepted M2
 * shape). `extensions` is present iff `profile === 'gltf-glb'` (§18.5).
 */
export interface GltfGlbRecipeV3 {
  profile: 'gltf-glb';
  recipeVersion: 1;
  toolchain: Record<string, string>;
  extensions: string[];
}

/**
 * presentation.md §41.4.3: the `pcm-wav` recipe. The `toolchain` names exactly
 * `asset-pipeline` (the bounded pure inspector); there is no `extensions` key
 * because a WAV has no glTF extensions.
 */
export interface PcmWavRecipe {
  profile: 'pcm-wav';
  recipeVersion: 1;
  toolchain: Record<string, string>;
}

/**
 * A v3 import recipe (`project-model.md` §18.5): the `gltf-glb` member for a
 * `model` version, the `pcm-wav` member for an `audio` version (packet 41/47).
 */
export type ImportRecipeV3 = GltfGlbRecipeV3 | PcmWavRecipe;

/**
 * presentation.md §41.4.3: the bounded PCM-WAV metrics member for an
 * `kind: "audio"` version. Canonical key order is exactly the field order
 * below. Every field is a re-derivable integer of §41.4.2.
 */
export interface PcmWavMetrics {
  container: 'riff-wave';
  encoding: 'pcm-s16le';
  channels: 1;
  sampleRate: 48000;
  bitsPerSample: 16;
  /** 1..96000 (`== pcmBytes / 2`). */
  frames: number;
  /** `floor(frames / 48)`, ≤ 2000. */
  durationMs: number;
  /** `== frames * 2`, ≤ 192000 (the single normative PCM bound). */
  pcmBytes: number;
  /** `== pcmBytes`. */
  dataChunkBytes: number;
  /** `== 36 + pcmBytes`. */
  riffChunkBytes: number;
}

/**
 * §18.6: the metrics member depends on the record's `kind` — the GLB
 * decoded-resource member for `model`, {@link PcmWavMetrics} for `audio`.
 */
export type AssetMetricsV3 = AssetMetrics | PcmWavMetrics;

export interface AssetVersionV3 extends Omit<AssetVersion, 'importRecipe' | 'metrics'> {
  importRecipe: ImportRecipeV3;
  metrics: AssetMetricsV3;
}

export interface AssetRecordV3 {
  assetId: string;
  kind: AssetKind;
  displayName: string;
  currentVersion: number;
  versions: AssetVersionV3[];
}

/** §23.4 a cue reference: an audio `assetId` or `null`. */
export type CueRef = string | null;

/** §23.4 the bounded game-configuration block. */
export interface GameConfig {
  configVersion: 1;
  title: string;
  objective: string;
  instructions: string;
  playerId: string;
  cameraId: string;
  spawnId: string;
  level: { minX: number; maxX: number; minY: number; maxY: number };
  killY: number;
  cues: {
    start: CueRef;
    jump: CueRef;
    checkpoint: CueRef;
    death: CueRef;
    goal: CueRef;
  };
}

/** The v3 content block: the accepted five keys plus the required `game`. */
export interface ContentCatalogV3 {
  assets: AssetRecordV3[];
  prefabs: PrefabDefinition[];
  behaviors: BehaviorRecord[];
  settings: SettingsMap;
  behaviorTrust: BehaviorTrust;
  game: GameConfig | null;
}

/**
 * The model-owned v3 authoring envelope (§23.8's effective order;
 * `workspace.md` §16.3). `retry` is workspace-owned (§4.6): it is required
 * present and carried through unchanged — the model never rewrites it.
 */
export interface AuthoringEnvelopeV3 {
  storageVersion: 3;
  type: 'authoring-state';
  projectId: string;
  scene: SceneV3;
  content: ContentCatalogV3;
  retry: unknown;
}

/** §23.3.5 the three built-in surface presets, as frozen value rows. */
export const SURFACE_PRESETS: Readonly<Record<'matte-ground' | 'hazard' | 'beacon', SurfaceComponent>> =
  Object.freeze({
    'matte-ground': Object.freeze({
      color: '#6f6f6f',
      roughness: 0.95,
      metalness: 0,
      emissive: '#000000',
      emissiveIntensity: 0,
    }),
    hazard: Object.freeze({
      color: '#d42a1e',
      roughness: 0.55,
      metalness: 0,
      emissive: '#3a0703',
      emissiveIntensity: 0.35,
    }),
    beacon: Object.freeze({
      color: '#2f7fd4',
      roughness: 0.4,
      metalness: 0.1,
      emissive: '#1bc8ff',
      emissiveIntensity: 1.2,
    }),
  }) as Readonly<Record<'matte-ground' | 'hazard' | 'beacon', SurfaceComponent>>;

/** §23.10 the v3 limit values (contract material: fixtures reference them). */
export const GAME_ZONE_LIMITS = Object.freeze({
  zones: 64,
  checkpointZones: 1,
  playerSpawns: 16,
  lightsDirectional: 1,
  lightsAmbient: 1,
  entities: 1024,
  audioAssets: 16,
  audioVersions: 8,
  gameBytes: 16_384,
  animationProfileBytes: 4_096,
});

/**
 * presentation.md §41.4.2/§41.4.3: the frozen PCM-WAV profile constants. They
 * live here (not imported from `asset-pipeline`) because `project-model` has no
 * dependency on the inspector (`dependencies.md` §4.1); §18.6 defines the same
 * exact arithmetic on load. `audioPipelineVersion` is the repository pin of
 * `@thirdlight/asset-pipeline` (`packages/asset-pipeline/package.json`), the
 * only tool whose version can change an inspected WAV.
 */
export const AUDIO_PCM_WAV_PROFILE = Object.freeze({
  headerBytes: 44,
  channels: 1,
  sampleRate: 48_000,
  bitsPerSample: 16,
  byteRate: 96_000,
  blockAlign: 2,
  maxPcmBytes: 192_000,
  maxFrames: 96_000,
  maxDurationMs: 2_000,
  maxSourceBytes: 192_044,
  /** presentation.md §41.4.4 stage 1: the hard source-file bound, before any profile cap. */
  maxSourceFileBytes: 196_608,
  recipeVersion: 1,
  audioPipelineVersion: '0.1.0',
});
