/**
 * Explicitly versioned v3 logical types (scene `schemaVersion` 3, the six
 * appended components, the bounded `content.game` block and the `audio`
 * asset kind), built on `types.ts` and `types-v2.ts`.
 *
 * These describe the STRICT canonical output of the v3 normalizers: only
 * the v3 defaults are filled, component/field order is the v3 registry
 * order, and only present fields are emitted. Inputs to the entry points
 * are `unknown`; the boundary re-checks every rule.
 */

import type { AnimatorComponent, AnimatorController } from './animator';
import type { InputConfig } from './input';
import type { GraphDocument } from './graph';
import type { HealthComponent, MoverComponent, SwitchComponent, TriggerComponent } from './blocks';
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

// ---- scene schemaVersion 3 registry ----------------------------------

/** The v3 registry, in canonical order (v2 registry plus six). */
export const V3_REGISTRY = [
  'transform',
  'model',
  'box',
  'camera',
  'behavior',
  'prefab',
  'collider',
  'controller',
  'playerSpawn',
  'light',
  'surface',
  'modelAnimation',
  'folder',
] as const;
export type ComponentV3 = (typeof V3_REGISTRY)[number];

/**
 * An instance set — one entity, many copies of one model placed
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
  /** The copies cast the directional light's realtime shadow (absent: true). */
  castShadow?: boolean;
  /** The copies show realtime shadows falling on them (absent: true). */
  receiveShadow?: boolean;
  /** This set's chunk size (m), 1–4096 (absent: the project's `instance_chunk_m`, else 32). */
  chunkSize?: number;
}

/** Floats per instance in an instance buffer. */
export const INSTANCE_FLOATS = 10;
/** Most copies in one instance set. */
export const MAX_INSTANCES = 65_536;

/** Spawn marker. A left/right `facing` is upgraded to `yaw` by the loader. */
export interface PlayerSpawnComponent {
  /** v4: the character's yaw on arrival, degrees about +Y (0: facing +Z). */
  yaw?: number;
}

/** One directional key light or one ambient fill. */
export interface LightComponent {
  /** v4 adds point, spot and hemisphere. */
  type: 'directional' | 'ambient' | 'point' | 'spot' | 'hemisphere';
  /** `^#[0-9a-f]{6}$`; canonical lowercase. */
  color: string;
  /** [0, 8]. */
  intensity: number;
  /** Required iff `type === 'directional'`; each `|v| <= 1`, `||v|| >= 1e-6`. */
  direction?: Vec3;
  /** Directional only; defaulted to `false` by the normalizer. */
  castShadow?: boolean;
  /** Directional: shadow map width = height in texels (absent: 1024). */
  shadowMapSize?: number;
  /** Directional: depth bias of the shadow test (absent: -0.0005). */
  shadowBias?: number;
  /** Directional: offset along the surface normal in metres (absent: 0.02). */
  shadowNormalBias?: number;
  /** Directional: half the side of the shadowed square around the camera, metres (v4 games; absent: 24). */
  shadowExtent?: number;
  /** Point/spot: the reach in meters (0 = unlimited). */
  range?: number;
  /** Point/spot: light falloff (2 = physical). */
  decay?: number;
  /** Spot: the cone half-angle in degrees. */
  angle?: number;
  /** Spot: the soft edge (0-1). */
  penumbra?: number;
  /** Hemisphere: the ground colour (`color` is the sky). */
  groundColor?: string;
  /** `baked` lights only feed light baking; `mixed` bakes indirect light (absent = realtime). */
  mode?: 'baked' | 'mixed';
  /** Spot only: a texture asset projected through the cone (three's `SpotLight.map`). */
  cookie?: string;
}

/** A copied surface value row (never a linked resource). */
export interface SurfaceComponent {
  /** `^#[0-9a-f]{6}$`; canonical lowercase. No default (present component fills `#b0b0b0`). */
  color: string;
  roughness: number;
  metalness: number;
  emissive: string;
  emissiveIntensity: number;
}

/**
 * One rigid animation role binding. This type fixes the role key set,
 * all-three-required, that each binding is a non-empty JSON object owned by
 * the version, and the byte bound; the binding's media fields are checked
 * against the asset.
 */
export type AnimationRoleBinding = Record<string, unknown>;

/** Animated model instance. */
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
  /** v4 only: source material name (or "*") → materialId. */
  materials?: Record<string, string>;
  /** v4 only: overrides of graph-material parameters (materialId → parameter → value). */
  materialParams?: Record<string, Record<string, number | number[] | string>>;
  /** v4 only: a box of fog around the entity. */
  fogVolume?: FogVolumeComponent;
  /** v4 only: a visual effect played from the entity. */
  effect?: import('./effects').EffectComponent;
  /** v4 only: a virtual camera shot the camera brain can cut or blend to. */
  virtualCamera?: import('./cameras').VirtualCameraComponent;
  /** v4 only: a path rail cameras ride (offsets from the entity). */
  cameraPath?: import('./cameras').CameraPathComponent;
  /** v4 only: a camera region (a track camera's dead zone, bounds and distance while its target is inside). */
  cameraRegion?: import('./cameras').CameraRegionComponent;
  /** v4 only: rides on a named node of another entity's model (with an offset). */
  socketAttach?: import('./sockets').SocketAttachComponent;
  /** v4 only: the animator controller that plays the model's clips. */
  animator?: AnimatorComponent;
  /** v4 only: gameplay building blocks. */
  mover?: MoverComponent;
  trigger?: TriggerComponent;
  switch?: SwitchComponent;
  health?: HealthComponent;
  /** v4 only: generic primitives (a collectible, a patrol walker, a hitbox). */
  collectible?: import('./blocks').CollectibleComponent;
  patrol?: import('./blocks').PatrolComponent;
  hitbox?: import('./blocks').HitboxComponent;
  /** v4 only: a volume the character climbs in, and a body that falls. */
  climbVolume?: import('./blocks').ClimbVolumeComponent;
  gravity?: import('./blocks').GravityComponent;
  playerSpawn?: PlayerSpawnComponent;
  light?: LightComponent;
  surface?: SurfaceComponent;
  modelAnimation?: ModelAnimationComponent;
  /** Scene schemaVersion 4 only: an instance set. */
  instances?: InstancesComponent;
  /** v4 only: a grid of blocks (its cells are the scene's `blocks`). */
  blockLayer?: import('./block-layers').BlockLayerComponent;
  /** v4 only: the metadata a prop writes into the block cells beneath it. */
  blockFootprint?: import('./block-layers').BlockFootprintComponent;
  /** v4 only: the behavior group the entity's behavior belongs to (game modes tick groups). */
  behaviorGroup?: import('./modes').BehaviorGroupComponent;
}

/**
 * Hierarchy flags every entity may carry. Only non-default values
 * are stored: `active: false` (the entity and its subtree are left out of the
 * game and hidden in the editor), `locked: true` (editor only: not pickable
 * or movable in the viewport), `static: true` (the object does not move).
 * A folder passes all three down to its whole subtree; any inactive ancestor
 * makes its subtree inactive.
 */
export interface EntityFlagsV3 {
  active?: false;
  /**
   * The object starts hidden: loaded, simulated and colliding, but not drawn
   * (with its children) until a script or a timeline shows it. Not on folders
   * (they are not in the game).
   */
  visible?: false;
  locked?: true;
  static?: true;
  /**
   * The entity's own tag bits (unsigned 32-bit mask; bit i =
   * the tag with `bit: i` in `content.tags`). Stored only when non-zero. The
   * effective mask is this OR the masks of every folder above it.
   */
  tags?: number;
}

/** One named tag; `bit` (0–31) is fixed for the tag's life. */
export interface TagDefinition {
  bit: number;
  name: string;
}

/** At most this many tags per project: one per bit of the 32-bit tag mask queries filter by. */
export const MAX_TAGS = 32;

export interface EntityV3 extends EntityFlagsV3 {
  id: string;
  name?: string;
  parentId?: string;
  components: EntityComponentsV3;
}

/**
 * Folder marker: organisation only. A folder carries no transform
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
 * A scene document of schemaVersion 4 — one file per scene in a
 * project (`scenes/<sceneId>.json`). Same entities as v3 (plus instance sets
 * and exit zones) and at most one camera; its display name is in the
 * project's scene index (`content.scenes`).
 */
export interface SceneV4 {
  schemaVersion: 4;
  sceneId: string;
  revision: number;
  entities: SceneEntityV3[];
  /** The block layers' cells and regions (one entry per layer holding any; absent = none). */
  blocks?: import('./block-layers').BlockLayerData[];
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

// ---- content: audio kind and content.game ---------------------

/** The v3 asset-kind discriminator. */
/** `texture`: a standalone PNG/JPEG/WebP image. */
/** `font`: a TTF/OTF/WOFF2/WOFF for the project UI. */
export type AssetKind = 'model' | 'audio' | 'texture' | 'music' | 'font';

/**
 * The `gltf-glb` recipe member (the v2 shape). `extensions` is present iff `profile === 'gltf-glb'`.
 */
export interface GltfGlbRecipeV3 {
  profile: 'gltf-glb';
  recipeVersion: 1;
  toolchain: Record<string, string>;
  extensions: string[];
}

/**
 * The `pcm-wav` recipe. The `toolchain` names exactly
 * `asset-pipeline` (the bounded pure inspector); there is no `extensions` key
 * because a WAV has no glTF extensions.
 */
export interface PcmWavRecipe {
  profile: 'pcm-wav';
  recipeVersion: 1;
  toolchain: Record<string, string>;
}

/**
 * A v3 import recipe: the `gltf-glb` member for a
 * `model` version, the `pcm-wav` member for an `audio` version.
 */
export type ImportRecipeV3 = GltfGlbRecipeV3 | PcmWavRecipe;

/**
 * The bounded PCM-WAV metrics member for an
 * `kind: "audio"` version. Canonical key order is exactly the field order
 * below. Every field is an integer re-derivable from the WAV bytes.
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
 * The metrics member depends on the record's `kind` — the GLB
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
  /** Model only: the default material mapping of every placement (source material name or "*" → materialId). */
  materials?: Record<string, string>;
  /**
   * Model only (v4): an animation-only file — its clips play on
   * the model asset named here (matched by bone names). Absent = the file's
   * clips are for its own nodes.
   */
  clipsFor?: string;
  /** The labels a script may load the asset by (ascending, unique; absent = none). */
  labels?: string[];
}

/** The v3 content block: the accepted five keys plus the required `game`. */
export interface ContentCatalogV3 {
  assets: AssetRecordV3[];
  prefabs: PrefabDefinition[];
  behaviors: BehaviorRecord[];
  settings: SettingsMap;
  behaviorTrust: BehaviorTrust;
  /** The v3 envelope's game block (always null; v4 content has no such key). */
  game: null;
  /** The project tag registry, ascending `bit`; absent = no tags. */
  tags?: TagDefinition[];
}

/**
 * The v4 project content block (`content.json`) — v3's plus the
 * scenes the game starts with (without the v3 `game` key).
 */
export interface ContentCatalogV4 extends Omit<ContentCatalogV3, 'game'> {
  /** The project's scenes, in the order the editor lists them (one file each). */
  scenes: SceneIndexEntry[];
  /** The scenes loaded when the game starts (a subset of `scenes`). */
  startScenes: string[];
  /** The project materials (absent = none). */
  materials?: MaterialDef[];
  /** The environment (global wind, sky, fog, post). */
  environment?: EnvironmentConfig;
  /** Baked lighting per scene (absent = no bakes). */
  lighting?: LightingMap;
  /** Animator controllers (absent = none). */
  animators?: AnimatorController[];
  /** Input actions and bindings (absent = the defaults). */
  input?: InputConfig;
  /** Standalone graph documents (absent = none). */
  graphs?: GraphDocument[];
  /** Visual effects (absent = none). */
  effects?: import('./effects').EffectDef[];
  /** Shared script libraries behaviors import as `@lib/<id>` (absent = none). */
  scriptLibraries?: import('./script-libraries').ScriptLibrary[];
  /** Block definitions for block layers (absent = none). */
  blockTypes?: import('./block-layers').BlockType[];
  /** The cell metadata schema (absent = none). */
  cellFields?: import('./block-layers').CellField[];
  /** Saved cell patterns (absent = none). */
  blockStamps?: import('./block-layers').BlockStamp[];
  /** Project UI documents drawn by the game host (absent = none). */
  uiDocuments?: import('./ui-documents').UiDocument[];
  /** UI themes (named styles and icons documents share; absent = none). */
  uiThemes?: import('./ui-documents').UiTheme[];
  /** Game modes (the first is the start mode; absent = none). */
  modes?: import('./modes').GameMode[];
  /** The behavior group names entities may carry (absent = none). */
  behaviorGroups?: string[];
  /** The event → cue table (sounds the host plays for signals and events; absent = none). */
  eventCues?: import('./event-cues').EventCue[];
  /** The game shell (menus and HUD as UI documents, the ordered scene list). */
  shell?: import('./shell').GameShell;
  /** Timelines (sequencer assets; absent = none). */
  timelines?: import('./timelines').TimelineAsset[];
  /**
   * The project's named collision layers (absent = only the
   * implicit "default" layer). A collider lists the layers it is in (absent:
   * "default"); script queries filter by layer. 3D physics only.
   */
  collisionLayers?: string[];
  /** The project save document and settings document schema (absent = no project saves). */
  saveSchema?: import('./save-schema').SaveSchema;
  /** Conversations (node graphs of kind `dialogue`; absent = none). */
  dialogues?: import('./dialogue').DialogueDocument[];
  /** The speaker registry (absent = none). */
  speakers?: import('./dialogue').DialogueSpeaker[];
  /** Dialogue engine settings (absent = the defaults). */
  dialogueSettings?: import('./dialogue').DialogueSettings;
}

/** One scene in the project's scene index. */
export interface SceneIndexEntry {
  sceneId: string;
  name: string;
}

/**
 * The model-owned v3 authoring envelope. `retry` is workspace-owned: it is required
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

/**
 * The built-in surface presets, as frozen value rows.
 */
export const SURFACE_PRESET_NAMES = ['matte-ground', 'signal-red', 'emissive-accent'] as const;
export type SurfacePresetName = (typeof SURFACE_PRESET_NAMES)[number];
export const SURFACE_PRESETS: Readonly<Record<SurfacePresetName, SurfaceComponent>> =
  Object.freeze({
    'matte-ground': Object.freeze({
      color: '#6f6f6f',
      roughness: 0.95,
      metalness: 0,
      emissive: '#000000',
      emissiveIntensity: 0,
    }),
    'signal-red': Object.freeze({
      color: '#d42a1e',
      roughness: 0.55,
      metalness: 0,
      emissive: '#3a0703',
      emissiveIntensity: 0.35,
    }),
    'emissive-accent': Object.freeze({
      color: '#2f7fd4',
      roughness: 0.4,
      metalness: 0.1,
      emissive: '#1bc8ff',
      emissiveIntensity: 1.2,
    }),
  }) as Readonly<Record<SurfacePresetName, SurfaceComponent>>;

/** The v3/v4 scene limit values (contract material: fixtures reference them). */
export const SCENE_LIMITS_V3 = Object.freeze({
  playerSpawns: 16,
  lightsDirectional: 1,
  lightsAmbient: 1,
  entities: 1024,
  audioVersions: 8,
  animationProfileBytes: 4_096,
});

/**
 * The frozen PCM-WAV profile constants. They
 * live here (not imported from `asset-pipeline`) because `project-model` has no
 * dependency on the inspector; the importer applies the same exact
 * arithmetic. `audioPipelineVersion` is the repository pin of
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
  /** The hard source-file bound, checked before any profile cap. */
  maxSourceFileBytes: 196_608,
  recipeVersion: 1,
  audioPipelineVersion: '0.1.0',
});
