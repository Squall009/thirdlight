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

import type { AnimatorComponent, AnimatorController } from './animator';
import type { InputConfig } from './input';
import type { GameFlow } from './flow';
import type { GraphDocument } from './graph';
import type { EnemyComponent, HealthComponent, MoverComponent, PickupComponent, SwitchComponent, TriggerComponent } from './blocks';
import type { LightingMap } from './lighting';
import type { EnvironmentConfig, FogVolumeComponent, MaterialDef } from './materials';
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
/** Phase 12 (c), scene schemaVersion 4: the roles a v4 zone may have (adds `exit`). */
export const GAME_ZONE_ROLES_V4 = ['hazard', 'checkpoint', 'goal', 'exit'] as const;
export type GameZoneRole = (typeof GAME_ZONE_ROLES_V4)[number];

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
  /** Phase 9.9, v4 hazards only: the damage it does (absent or 0: instant death). */
  damage?: number;
  /** `[widthX, heightY]` full extents (meters). */
  size: [number, number];
  /** Required iff `role === 'checkpoint'`; resolves to a `playerSpawn` entity. */
  safeSpawnId?: string;
  /** Required iff `role === 'checkpoint'`. */
  activation?: CheckpointActivationAppearance;
  /**
   * Phase 12 (c), `exit` only: the scenes loaded and unloaded when the player
   * enters (at least one of the two non-empty), and the spawn the player is
   * moved to once the scene holding it is loaded.
   */
  load?: string[];
  unload?: string[];
  spawnId?: string;
}

/**
 * Phase 12 (c): an instance set — one entity, many copies of one model placed
 * by a binary buffer of `count` transforms (10 little-endian float32 each:
 * position xyz, rotation quaternion xyzw, scale xyz), stored by SHA-256 like
 * an asset source. Rendered as instanced meshes; the copies have no ids.
 */
export interface InstancesComponent {
  /** `piece`: one named piece of a multi-piece GLB (absent = the whole file). */
  asset: { assetId: string; piece?: string };
  /** SHA-256 (64 lowercase hex) of the buffer bytes; byte length = count × 40. */
  buffer: string;
  count: number;
  /** Phase 17.4: the copies cast the directional light's realtime shadow (absent: true). */
  castShadow?: boolean;
  /** Phase 17.4: the copies show realtime shadows falling on them (absent: true). */
  receiveShadow?: boolean;
}

/** Floats per instance in an instance buffer. */
export const INSTANCE_FLOATS = 10;
/** Most copies in one instance set. */
export const MAX_INSTANCES = 65_536;

/** Phase 15.2: which way the player faces when it starts or respawns at a spawn. */
export const PLAYER_SPAWN_FACINGS = ['none', 'left', 'right'] as const;
export type PlayerSpawnFacing = (typeof PLAYER_SPAWN_FACINGS)[number];

/** §23.3.2 spawn marker; phase 15.2 (v4 scenes) adds an optional `facing` (absent: none). */
export interface PlayerSpawnComponent {
  facing?: PlayerSpawnFacing;
}

/** §23.3.3 camera follow data (presentation math is packet 40's). */
export interface CameraFollowComponent {
  /** Half-extents (meters). */
  deadZone: { x: number; y: number };
  /** [0, 1]; `0` = hard snap. */
  smoothing: number;
  /** Required in v3; optional in v4 (absent: the camera follows anywhere). */
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  /** Phase 15.3 (v4): metres in front of the player plane (absent: where the camera is placed). */
  distance?: number;
  /** Phase 15.3 (v4): the per-axis speed cap while smoothing, m/s (absent: 480). */
  maxSpeed?: number;
}

/** §23.3.4 one directional key light or one ambient fill. */
export interface LightComponent {
  /** Phase 9.5 (v4) adds point, spot and hemisphere. */
  type: 'directional' | 'ambient' | 'point' | 'spot' | 'hemisphere';
  /** `^#[0-9a-f]{6}$`; canonical lowercase. */
  color: string;
  /** [0, 8]. */
  intensity: number;
  /** Required iff `type === 'directional'`; each `|v| <= 1`, `||v|| >= 1e-6`. */
  direction?: Vec3;
  /** Directional only; defaulted to `false` by the §23.7 normalizer. */
  castShadow?: boolean;
  /** Phase 17.4 (directional): shadow map width = height in texels (absent: 1024). */
  shadowMapSize?: number;
  /** Phase 17.4 (directional): depth bias of the shadow test (absent: -0.0005). */
  shadowBias?: number;
  /** Phase 17.4 (directional): offset along the surface normal in metres (absent: 0.02). */
  shadowNormalBias?: number;
  /** Phase 17.4 (directional): half the side of the shadowed square around the camera, metres (v4 games; absent: 24). */
  shadowExtent?: number;
  /** Phase 9.5, point/spot: the reach in meters (0 = unlimited). */
  range?: number;
  /** Phase 9.5, point/spot: light falloff (2 = physical). */
  decay?: number;
  /** Phase 9.5, spot: the cone half-angle in degrees. */
  angle?: number;
  /** Phase 9.5, spot: the soft edge (0-1). */
  penumbra?: number;
  /** Phase 9.5, hemisphere: the ground colour (`color` is the sky). */
  groundColor?: string;
  /** Phase 9.5/9.6: `baked` lights only feed light baking; `mixed` bakes indirect light (absent = realtime). */
  mode?: 'baked' | 'mixed';
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
  /** Phase 9.4, v4 only: source material name (or "*") → materialId. */
  materials?: Record<string, string>;
  /** Phase 18.0, v4 only: overrides of graph-material parameters (materialId → parameter → value). */
  materialParams?: Record<string, Record<string, number | number[] | string>>;
  /** Phase 9.5, v4 only: a box of fog around the entity. */
  fogVolume?: FogVolumeComponent;
  /** Phase 20.0, v4 only: a visual effect played from the entity. */
  effect?: import('./effects').EffectComponent;
  /** Phase 9.7, v4 only: the animator controller that plays the model's clips. */
  animator?: AnimatorComponent;
  /** Phase 9.9, v4 only: gameplay building blocks. */
  mover?: MoverComponent;
  trigger?: TriggerComponent;
  switch?: SwitchComponent;
  health?: HealthComponent;
  pickup?: PickupComponent;
  enemy?: EnemyComponent;
  gameZone?: GameZoneComponent;
  playerSpawn?: PlayerSpawnComponent;
  cameraFollow?: CameraFollowComponent;
  light?: LightComponent;
  surface?: SurfaceComponent;
  modelAnimation?: ModelAnimationComponent;
  /** Phase 12 (c), scene schemaVersion 4 only: an instance set. */
  instances?: InstancesComponent;
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
  /**
   * Phase 12 (b): the entity's own tag bits (unsigned 32-bit mask; bit i =
   * the tag with `bit: i` in `content.tags`). Stored only when non-zero. The
   * effective mask is this OR the masks of every folder above it.
   */
  tags?: number;
}

/** Phase 12 (b): one named tag; `bit` (0–31) is fixed for the tag's life. */
export interface TagDefinition {
  bit: number;
  name: string;
}

/** At most this many tags per project (one per mask bit). */
export const MAX_TAGS = 32;

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
 * Phase 12 (c): a scene document of schemaVersion 4 — one file per scene in a
 * project (`scenes/<sceneId>.json`). Same entities as v3 (plus instance sets
 * and exit zones) and at most one camera; its display name is in the
 * project's scene index (`content.scenes`).
 */
export interface SceneV4 {
  schemaVersion: 4;
  sceneId: string;
  revision: number;
  entities: SceneEntityV3[];
}

/**
 * A scene as the game loads it (`resolveSceneHierarchy`): no folders, no
 * inactive entities; every entity carries its effective flags.
 */
export interface ResolvedSceneV3 {
  /** 3, or 4 for a scene of a v4 project (the runtime treats both alike). */
  schemaVersion: 3 | 4;
  sceneId: string;
  revision: number;
  entities: EntityV3[];
}

// ---- content: audio kind and content.game (§23.3.7/§23.4) ---------------------

/** §23.3.7 the v3 asset-kind discriminator. */
/** Phase 9.4 adds `texture` (a standalone PNG/JPEG/WebP image). */
export type AssetKind = 'model' | 'audio' | 'texture' | 'music';

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
  /**
   * Model only: how COLOR_0 is used. Absent = `data` (the attribute is shader
   * data such as foliage bend weights, never multiplied into the albedo);
   * `tint` = the glTF default (vertex colour multiplies the base colour).
   */
  vertexColors?: 'tint';
  /** Model only (phase 9.4): the default material mapping of every placement (source material name or "*" → materialId). */
  materials?: Record<string, string>;
  /**
   * Model only (phase 14.6, v4): an animation-only file — its clips play on
   * the model asset named here (matched by bone names). Absent = the file's
   * clips are for its own nodes.
   */
  clipsFor?: string;
}

/** §23.4 a cue reference: an audio `assetId` or `null`. */
export type CueRef = string | null;

/** §23.4 the bounded game-configuration block. */
export interface GameConfig {
  /** 1: scene schemaVersion 3 (with `level`/`killY`); 2: schemaVersion 4 (without). */
  configVersion: 1 | 2;
  title: string;
  objective: string;
  instructions: string;
  playerId: string;
  cameraId: string;
  spawnId: string;
  /** v3 only (configVersion 1). v4 has no level bounds: game rules like these belong in scripts. */
  level?: { minX: number; maxX: number; minY: number; maxY: number };
  /** v3 only (configVersion 1). v4 has no kill height: falls are hazard zones or script logic. */
  killY?: number;
  cues: {
    start: CueRef;
    jump: CueRef;
    checkpoint: CueRef;
    death: CueRef;
    goal: CueRef;
  };
  /** Phase 15.3 (v4 only): seconds between a death and the respawn (absent: 0.25). */
  respawnDelay?: number;
  /** Phase 15.3 (v4 only): seconds a one-way platform ignores the player dropping through it (absent: 0.125). */
  dropThroughTime?: number;
  /** Phase 15.3 (v4 only): seconds the world settles before the first frame (absent: 0.1). */
  settleTime?: number;
}

/** The v3 content block: the accepted five keys plus the required `game`. */
export interface ContentCatalogV3 {
  assets: AssetRecordV3[];
  prefabs: PrefabDefinition[];
  behaviors: BehaviorRecord[];
  settings: SettingsMap;
  behaviorTrust: BehaviorTrust;
  game: GameConfig | null;
  /** Phase 12 (b): the project tag registry, ascending `bit`; absent = no tags. */
  tags?: TagDefinition[];
}

/**
 * Phase 12 (c): the v4 project content block (`content.json`) — v3's plus the
 * scenes the game starts with; `game` is configVersion 2 (no level, no killY).
 */
export interface ContentCatalogV4 extends ContentCatalogV3 {
  /** The project's scenes, in the order the editor lists them (one file each). */
  scenes: SceneIndexEntry[];
  /** The scenes loaded when the game starts (a subset of `scenes`). */
  startScenes: string[];
  /** Phase 9.4: the project materials (absent = none). */
  materials?: MaterialDef[];
  /** Phase 9.4: the environment (global wind; sky/fog/post in 9.5). */
  environment?: EnvironmentConfig;
  /** Phase 9.6: baked lighting per scene (absent = no bakes). */
  lighting?: LightingMap;
  /** Phase 9.7: animator controllers (absent = none). */
  animators?: AnimatorController[];
  /** Phase 9.8: input actions and bindings (absent = the defaults). */
  input?: InputConfig;
  /** Phase 9.10: levels, lives, title screen, HUD, menus (absent = one level, as before). */
  flow?: GameFlow;
  /** Phase 16.1: standalone graph documents (absent = none). */
  graphs?: GraphDocument[];
  /** Phase 20.0: visual effects (absent = none). */
  effects?: import('./effects').EffectDef[];
}

/** Phase 12 (c): one scene in the project's scene index. */
export interface SceneIndexEntry {
  sceneId: string;
  name: string;
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
