# Types (PublishAssetArgs to UpdateEntityArgs)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The declarations the ops' arguments and the JSON-valued fields name, as the source declares them (doc comments included).

<a id="type-publish-asset-args"></a>
### PublishAssetArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** `publishAsset` args. */
interface PublishAssetArgs {
  mode: 'create' | 'reimport';
  assetId: string;
  /** The kind discriminator: required on create; must match the record on reimport. */
  kind?: AssetKind;
  /** Display name; defaults to the assetId on create, unchanged on reimport. */
  displayName?: string;
  /** 64 lowercase hex; stage-free digest-addressed fact. */
  sourceDigest: string;
  sourceByteLength: number;
  /** A file referenced in place: its path relative to the game folder. */
  sourcePath?: string;
  /** The original a converted model was made from (FBX). */
  convertedFrom?: ConvertedFrom;
  /** A texture packed from texture assets (channel by channel, layer by layer). */
  packedFrom?: PackedFrom;
  importRecipe: ImportRecipe | ImportRecipeV3;
  metrics: AssetMetrics;
  /** A project-model timestamp; a prepared fact. */
  importedAt: string;
  /** Atomic version-local role mapping. */
  animation?: PublishAssetAnimation;
  /**
   * Model only: the "extract textures" import setting (true: on; false: off,
   * the extracted textures are forgotten; absent: a create leaves it off, a
   * reimport keeps the record's).
   */
  extractTextures?: boolean;
  /** Model only: the texture asset each image of this version was extracted into (absent: none). */
  textures?: Record<string, string>;
}
```

<a id="type-publish-behavior-args"></a>
### PublishBehaviorArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** `publishBehavior` args. */
interface PublishBehaviorArgs {
  behaviorId: string;
  displayName: string;
  mode: 'declaration-create' | 'declaration-update' | 'source';
  declaration: PropertyDeclaration;
  /** Only with `mode: "source"`. */
  source?: { sourceDigest: string; sourceByteLength: number };
  /** Only with `mode: "declaration-create"` — the new behavior is a visual script with this graph. */
  graph?: GraphData;
}
```

<a id="type-quality-level-config"></a>
### QualityLevelConfig

Declared in `packages/project-model/src/quality-levels.ts`.

```ts
interface QualityLevelConfig {
  id: string;
  /** Shown in the editor and a game's settings screen (absent: the id). */
  name?: string;
  post?: QualityLevelPost;
  /** 0.5–1: the share of the screen's resolution the 3D view is drawn at (FSR 1 upscales). */
  renderScale?: number;
  /** 1–2: the most drawing-buffer pixels per CSS pixel (absent: 1). */
  pixelRatio?: number;
  /** MSAA samples (0 or 4; absent: the renderer's). */
  msaa?: MsaaSamples;
  /** The largest shadow map any light draws (a light's own larger size is lowered to it). */
  shadowMapSize?: number;
  /** How many point and spot lights the loaded scenes draw at once (0 – the scenes' budget). */
  localLights?: number;
  /**
   * How many point and spot lights draw their shadow at once (0 – the scenes'
   * budget; absent: every one that casts, every frame): the ones largest on
   * screen, spot before point, fading out with distance, their maps drawn
   * again only when something in reach changed.
   */
  shadowedLights?: number;
  ambientOcclusion?: AmbientOcclusionKind;
  /** 0.25–4: divides every LOD switch point and cull size (over the project's `lod_bias`). */
  lodBias?: number;
  dynamicResolution?: boolean;
}
```

<a id="type-quality-level-post"></a>
### QualityLevelPost

Declared in `packages/project-model/src/quality-levels.ts`.

```ts
/** A level's post-processing: per effect, the fields it changes (`enabled: false` turns the effect off). */
interface QualityLevelPost {
  bloom?: Partial<NonNullable<PostConfig['bloom']>>;
  ssao?: Partial<NonNullable<PostConfig['ssao']>>;
  dof?: Partial<NonNullable<PostConfig['dof']>>;
  /** The anti-aliasing kind where the scene's look has anti-aliasing ('none': off). */
  antialias?: NonNullable<PostConfig['antialias']>;
}
```

<a id="type-rename-folder-args"></a>
### RenameFolderArgs

Declared in `packages/commands/src/move-ops.ts`.

```ts
/** `renameFolder` args: a folder and its new name (one path segment). */
interface RenameFolderArgs {
  folder: string;
  name: string;
}
```

<a id="type-rule-conditions"></a>
### RuleConditions

Declared in `packages/project-model/src/surface-rules.ts`.

```ts
/** The conditions material and scatter rules share: height, slope, cavity, noise, and on block layers block types and cell metadata. */
interface RuleConditions {
  height?: RuleRange;
  slope?: RuleRange;
  cavity?: RuleRange & { radius?: number };
  noise?: RuleRange & { scale: number; seed?: number };
  blocks?: string[];
  meta?: Record<string, CellMetaValue>;
}
```

<a id="type-rule-range"></a>
### RuleRange

Declared in `packages/project-model/src/surface-rules.ts`.

```ts
/** A condition's range: 1 within [min, max] (an absent end is open), fading to 0 over `fade` beyond each end. */
interface RuleRange {
  min?: number;
  max?: number;
  /** How far past an end the condition fades out (the range's unit; absent or 0: a hard edge). */
  fade?: number;
}
```

<a id="type-save-sections"></a>
### SAVE_SECTIONS

Declared in `packages/project-model/src/save-schema.ts`.

```ts
const SAVE_SECTIONS: readonly ["grid", "materials", "spawned", "storage", "environment", "dialogue", "components", "world"];
```

<a id="type-save-migration"></a>
### SaveMigration

Declared in `packages/project-model/src/save-schema.ts`.

```ts
interface SaveMigration {
  /** The version this migration upgrades from (to `from + 1`). */
  from: number;
  /** The script function registered with `ctx.saves.migration(name, fn)`. */
  name: string;
}
```

<a id="type-save-schema"></a>
### SaveSchema

Declared in `packages/project-model/src/save-schema.ts`.

```ts
interface SaveSchema {
  version: number;
  slots: number;
  migrations?: SaveMigration[];
  sections?: SaveSection[];
  /** `false`: without `world` in `sections` a save keeps no world (absent: the deprecated always-on world). */
  legacyWorld?: boolean;
  thumbnail?: SaveThumbnail;
  settings?: SettingsField[];
}
```

<a id="type-save-section"></a>
### SaveSection

Declared in `packages/project-model/src/save-schema.ts`.

```ts
type SaveSection = (typeof SAVE_SECTIONS)[number];
```

<a id="type-save-thumbnail"></a>
### SaveThumbnail

Declared in `packages/project-model/src/save-schema.ts`.

```ts
interface SaveThumbnail {
  width: number;
  height: number;
  format: 'jpeg' | 'webp';
  /** Encoder quality 0.1–1 (absent: 0.8). */
  quality?: number;
}
```

<a id="type-scatter-layer-condition"></a>
### ScatterLayerCondition

Declared in `packages/project-model/src/scatter.ts`.

```ts
/** A layer-share condition: the share (0-1) the ground shows of material `layer`. */
interface ScatterLayerCondition extends RuleRange {
  layer: number;
}
```

<a id="type-scatter-rule"></a>
### ScatterRule

Declared in `packages/project-model/src/scatter.ts`.

```ts
interface ScatterRule extends RuleConditions {
  /** Names the rule: its copies, hand edits and stored entries (1-32 of A-Z a-z 0-9 _ -). Part of its jitter, so two rules never share candidates. */
  id: string;
  /** The model placed (a model asset, one piece of it optionally). */
  asset: { assetId: string; piece?: string };
  /** Candidates per m² (each kept where the conditions hold fully). */
  density: number;
  /** No two of the rule's copies closer than this across the ground (m; absent: 0). */
  spacing?: number;
  /** Random uniform scale between these (absent: [1, 1]). */
  scale?: [number, number];
  /** Random turn about up, 0 to this many degrees (absent: 360). */
  yaw?: number;
  /** How far each copy leans to the ground's normal: 0 upright, 1 along it (absent: 0). */
  align?: number;
  /** Metres each copy is lowered into the ground (absent: 0). */
  sink?: number;
  /** Picks the jitter, scale and turn with the id (absent: 0). */
  seed?: number;
  /** Every listed layer's share must hold (absent: any ground). */
  layers?: ScatterLayerCondition[];
  /** Named block-layer regions kept clear (their columns, across the ground). */
  exclude?: string[];
  /** Drawing, as an instance set's: the copies cast the key light's shadow (absent: false — the foliage policy's default). */
  castShadow?: boolean;
  /**
   * With `castShadow`: only copies within this many metres of the camera
   * cast, into the moving shadow map (absent: every copy casts, into the
   * cached static map).
   */
  shadowDistance?: number;
  /** A soft dark disc of this radius (m, at the copy's scale) on the ground under each copy, near the camera: a contact shadow without a shadow map (absent: none). */
  blobShadow?: number;
  /** Drawing: the chunk size (m) the copies are culled and given levels of detail by (absent: {@link SCATTER_CHUNK_METERS_DEFAULT}). */
  chunkSize?: number;
  /** Drawing: the density falloff by screen size (as an instance set's; absent: none). */
  densityStart?: number;
  densityEnd?: number;
  densityMin?: number;
  /** Drawing: each copy picks its own level of detail (absent: true for scatter, whose chunks are large). */
  lodPerCopy?: boolean;
  /**
   * Drawing: a copy smaller on screen than this (the share of the view's
   * height its model covers, as the model's own levels switch: a larger copy
   * switches that much farther) is an octahedral impostor — one quad showing
   * the model from the side it is seen from, baked from the model once per
   * page — instead of its meshes (absent: its meshes all the way).
   */
  impostorSize?: number;
  /** Each copy carries the colliders of its model's `_COL` (absent: false; not with `cover`). */
  collide?: boolean;
  /**
   * Ground cover (grass, pebbles, small flowers): never stored — made near
   * the camera while the game runs, from the same rule and ground, thinning
   * out to nothing at `coverDistance` (absent: false, stored copies).
   */
  cover?: boolean;
  /** Ground cover: metres from the camera it reaches (absent: {@link SCATTER_COVER_DISTANCE_DEFAULT}). */
  coverDistance?: number;
}
```

<a id="type-scene-environment"></a>
### SceneEnvironment

Declared in `packages/project-model/src/materials.ts`.

```ts
/**
 * A scene's look (sky, fog, post-processing, wind): each scene document
 * carries its own (`SceneV4.environment`). With several scenes loaded the
 * active scene's applies.
 */
interface SceneEnvironment {
  wind?: WindConfig;
  sky?: SkyConfig;
  fog?: FogConfig;
  /** Exponential height fog over the distance fog (absent: none). */
  heightFog?: HeightFogConfig;
  post?: PostConfig;
  /**
   * How wet the scene is (0 dry – 1 soaked; rain): materials that read the
   * Scene wetness node (the height-blended layers template) add it to their
   * painted wetness. Presets blend it (absent: 0).
   */
  wetness?: number;
}
```

<a id="type-scene-index-args"></a>
### SceneIndexArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** The args of the four scene-index ops, tagged with the op. */
type SceneIndexArgs =
  /** `environmentFrom`: a scene whose look the new scene copies (absent: the engine defaults). */
  | { op: 'createScene'; sceneId?: string; name: string; environmentFrom?: string }
  | { op: 'renameScene'; sceneId: string; name: string }
  | { op: 'deleteScene'; sceneId: string }
  | { op: 'setStartScenes'; sceneIds: string[] };
```

<a id="type-script-library"></a>
### ScriptLibrary

Declared in `packages/project-model/src/script-libraries.ts`.

```ts
interface ScriptLibrary {
  /** The id behaviors import it by (`@lib/<libraryId>`). */
  libraryId: string;
  /** Shown in the editor. */
  name: string;
  /** Its files; `src/index.ts` is the module an import names. */
  files: ScriptLibraryFile[];
}
```

<a id="type-script-library-file"></a>
### ScriptLibraryFile

Declared in `packages/project-model/src/script-libraries.ts`.

```ts
interface ScriptLibraryFile {
  /** A container path, e.g. `src/index.ts` or `src/data/items.json`. */
  path: string;
  text: string;
}
```

<a id="type-script-library-patch"></a>
### ScriptLibraryPatch

Declared in `packages/project-model/src/script-libraries.ts`.

```ts
/** The `setScriptLibrary` args: a patch (unmentioned files are kept; `text: null` removes one). */
interface ScriptLibraryPatch {
  libraryId: string;
  /** Required when the library is new. */
  name?: string;
  files?: { path: string; text: string | null }[];
}
```

<a id="type-sculpt-op"></a>
### SculptOp

Declared in `packages/project-model/src/block-sculpt.ts`.

```ts
type SculptOp = 'raise' | 'lower' | 'smooth' | 'flatten';
```

<a id="type-set-address-args"></a>
### SetAddressArgs

Declared in `packages/commands/src/loadable-ops.ts`.

```ts
/** `setAddress` args: one item's address (null: none). */
interface SetAddressArgs {
  kind: string;
  id: string;
  address: string | null;
}
```

<a id="type-set-asset-options-args"></a>
### SetAssetOptionsArgs

Declared in `packages/commands/src/types.ts`.

```ts
interface SetAssetOptionsArgs {
  assetId: string;
  vertexColors?: 'data' | 'tint';
  /** The default material mapping of every placement (null = none). */
  materials?: Record<string, string> | null;
  /** An animation-only file whose clips play on this model asset's rig (null = its clips are its own). */
  clipsFor?: string | null;
  /** The asset file's path in the game folder (any kind): a file moved there keeps its asset and every reference to it. */
  sourcePath?: string;
  /** Audio only: how the game holds the file (null = the default for its length). */
  loadType?: 'decode-on-load' | 'decode-while-playing' | 'stream' | null;
  /** Audio only: read with the scene that uses it (true, the default) or only when played. */
  preload?: boolean;
  /** Texture only: stream its mips (null = the default: on for a KTX2 texture over 1024 px). */
  streaming?: boolean | null;
  /** Model only: its LOD group settings — switch points and cull size (null = the defaults). */
  lod?: ModelLodSettings | null;
}
```

<a id="type-set-behavior-properties-args"></a>
### SetBehaviorPropertiesArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** `setBehaviorProperties` args. */
interface SetBehaviorPropertiesArgs {
  entityId: string;
  /** `null` removes the component. */
  behaviorId: string | null;
  /** Partial map of declared keys; omitted keys take their declaration default. */
  values?: Record<string, PropertyValue>;
}
```

<a id="type-set-component-args"></a>
### SetComponentArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** `setComponent` args. */
interface SetComponentArgs {
  entityId: string;
  component: OwnedComponent;
  /** Non-empty partial object of that component's fields; `null` removes an
   *  add-capable component (the collider/controller pair and the six v3 ones) and is
   *  never a removal for `box`/`camera`/`model`. */
  value: Record<string, unknown> | null;
}
```

<a id="type-set-labels-args"></a>
### SetLabelsArgs

Declared in `packages/commands/src/loadable-ops.ts`.

```ts
/** `setLabels` args: labels added to and removed from every item named. */
interface SetLabelsArgs {
  items: LoadableItemRef[];
  add?: string[];
  remove?: string[];
}
```

<a id="type-set-settings-args"></a>
### SetSettingsArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** `setSettings` args. */
interface SetSettingsArgs {
  /** Non-empty partial map over the declared keys. */
  settings: SettingsMap;
}
```

<a id="type-set-tags-args"></a>
### SetTagsArgs

Declared in `packages/commands/src/types.ts`.

```ts
/**
 * `setTags`: the whole tag registry. An entry with `bit` keeps
 * that bit (a rename keeps the bit); an entry without one gets the lowest
 * free bit. A tag an entity still carries cannot be left out.
 */
interface SetTagsArgs {
  tags: { bit?: number; name: string }[];
}
```

<a id="type-settings-engine-bindings"></a>
### SETTINGS_ENGINE_BINDINGS

Declared in `packages/project-model/src/save-schema.ts`.

```ts
/** Engine settings a settings field may drive (the host applies them). */
const SETTINGS_ENGINE_BINDINGS: readonly ["music", "sfx", "ui", "quality", "frameRateCap", "ambientOcclusion", "renderScale", "dynamicResolution"];
```

<a id="type-settings-engine-binding"></a>
### SettingsEngineBinding

Declared in `packages/project-model/src/save-schema.ts`.

```ts
type SettingsEngineBinding = (typeof SETTINGS_ENGINE_BINDINGS)[number];
```

<a id="type-settings-field"></a>
### SettingsField

Declared in `packages/project-model/src/save-schema.ts`.

```ts
interface SettingsField {
  key: string;
  type: 'bool' | 'number' | 'string' | 'enum';
  default: SettingsFieldValue;
  label?: string;
  min?: number;
  max?: number;
  /** enum: the choices. */
  values?: string[];
  /**
   * An engine setting this field drives (music/sfx/ui: a number 0–1; quality: an enum of the project's quality level ids (low/medium/high unless it lists its own); frameRateCap: an enum of 30/60/120/none;
   * ambientOcclusion: an enum of off/ssao/gtao; renderScale: a number within 0.5–1; dynamicResolution: a bool).
   */
  engine?: SettingsEngineBinding;
}
```

<a id="type-settings-field-value"></a>
### SettingsFieldValue

Declared in `packages/project-model/src/save-schema.ts`.

```ts
type SettingsFieldValue = boolean | number | string;
```

<a id="type-settings-map"></a>
### SettingsMap

Declared in `packages/project-model/src/types-v2.ts`.

```ts
type SettingsMap = Record<string, SettingsValue>;
```

<a id="type-settings-value"></a>
### SettingsValue

Declared in `packages/project-model/src/types-v2.ts`.

```ts
type SettingsValue = number | boolean | string;
```

<a id="type-set-transform-args"></a>
### SetTransformArgs

Declared in `packages/commands/src/types.ts`.

```ts
interface SetTransformArgs {
  entityId: string;
  transform: PartialTransformArgs;
}
```

<a id="type-shell-screens"></a>
### SHELL_SCREENS

Declared in `packages/project-model/src/shell.ts`.

```ts
/** The shell's screens a project draws with its own UI documents. */
const SHELL_SCREENS: readonly ["title", "pause", "settings", "controls", "save", "load"];
```

<a id="type-shell-scene"></a>
### ShellScene

Declared in `packages/project-model/src/shell.ts`.

```ts
interface ShellScene {
  /** A scene of the project. */
  scene: string;
  /** The player spawn the character starts at (a playerSpawn object in that scene; absent: it stays where it is). */
  spawn?: string;
  /** Seconds the view fades out before a move to this scene and back in after it (0–5; absent: no fade). */
  fade?: number;
  /** The fade's colour (#rrggbb; absent: black). */
  fadeColor?: string;
}
```

<a id="type-shell-screen"></a>
### ShellScreen

Declared in `packages/project-model/src/shell.ts`.

```ts
type ShellScreen = (typeof SHELL_SCREENS)[number];
```

<a id="type-shell-simulate"></a>
### ShellSimulate

Declared in `packages/project-model/src/shell.ts`.

```ts
/** What runs while a shell screen shows. */
type ShellSimulate = 'pause' | 'scripts';
```

<a id="type-sky-config"></a>
### SkyConfig

Declared in `packages/project-model/src/materials.ts`.

```ts
/** The sky (background + image-based lighting). */
interface SkyConfig {
  /** procedural: physically based (Preetham); gradient: three colours; texture: an equirect or six-face image; color: solid. */
  mode: 'procedural' | 'gradient' | 'texture' | 'color';
  turbidity?: number;
  rayleigh?: number;
  mieCoefficient?: number;
  mieDirectionalG?: number;
  /** true (default): the sun sits opposite the scene's directional light; false: sunElevation/sunAzimuth. */
  sunFromLight?: boolean;
  sunElevation?: number;
  sunAzimuth?: number;
  topColor?: string;
  horizonColor?: string;
  bottomColor?: string;
  color?: string;
  /** An equirectangular texture asset. */
  texture?: string;
  /** Six texture assets px, nx, py, ny, pz, nz (instead of `texture`). */
  cube?: [string, string, string, string, string, string];
  /**
   * A texture sky's turn about +Y in degrees (absent: 0), counter-clockwise
   * seen from above: the background and the image-based lighting turn
   * together, so a painted sun can be lined up with the key light.
   */
  rotation?: number;
  /** Background brightness. */
  intensity?: number;
  /** Image-based lighting strength from the sky (0 = none). */
  environmentIntensity?: number;
}
```

<a id="type-stroke-surface-sample"></a>
### StrokeSurfaceSample

Declared in `packages/project-model/src/instance-brush.ts`.

```ts
/** The surface under one candidate: its height and the normal's X and Z (Y follows); null: nothing there. */
type StrokeSurfaceSample = [number, number, number] | null;
```

<a id="type-surface-preset-name"></a>
### SurfacePresetName

Declared in `packages/commands/src/types.ts`.

```ts
/** The three built-in surface-preset names. */
type SurfacePresetName = 'matte-ground' | 'signal-red' | 'emissive-accent';
```

<a id="type-surface-rule"></a>
### SurfaceRule

Declared in `packages/project-model/src/surface-rules.ts`.

```ts
interface SurfaceRule {
  /** The material layer it paints (block layers: 0-3, the four their paint carries). */
  layer: number;
  /** How much of its layer it gives where every condition holds (0-1; absent: 1). */
  strength?: number;
  /** Only tops or only walls (a face whose box-mapping projection is sideways; terrain is all tops); absent: both. */
  face?: 'top' | 'wall';
  /** World height (metres). */
  height?: RuleRange;
  /** Slope from level (degrees: 0 flat, 90 a wall). */
  slope?: RuleRange;
  /** Cavity (metres): how far the ground `radius` metres around lies above the point — positive in hollows, negative on ridges. */
  cavity?: RuleRange & { radius?: number };
  /** A noise mask (0-1) over world space, its bumps `scale` metres apart. */
  noise?: RuleRange & { scale: number; seed?: number };
  /** The share (0-1) the rules before this one left to `layer` ("where rock is below 0.3"). */
  weight?: RuleRange & { layer: number };
  /** Block layers only: the block types it paints (terrain never matches a rule that names them). */
  blocks?: string[];
  /** Block layers only: cell metadata the cell must hold (its own value or its block type's). */
  meta?: Record<string, CellMetaValue>;
}
```

<a id="type-terrain-blocks-layer"></a>
### TerrainBlocksLayer

Declared in `packages/project-model/src/terrain-layers.ts`.

```ts
/** Block layers standing on the terrain (`terrain-blocks.ts`). */
interface TerrainBlocksLayer extends LayerCommon {
  kind: 'blocks';
  /** The block layer objects the ground meets (absent: every block layer of the scene). */
  blockLayers?: string[];
  /** cut (absent): holes under the blocks; flatten: the ground kept, just under them. */
  mode?: TerrainBlocksMode;
  /** Metres over which the ground round them fades from their border's height and paint to its own (absent: `TERRAIN_BLOCKS_BLEND_DEFAULT`). */
  blend?: number;
  /** Stored only when false: the blocks' paint does not carry across the border. */
  paint?: boolean;
}
```

<a id="type-terrain-blocks-mode"></a>
### TerrainBlocksMode

Declared in `packages/project-model/src/terrain-blocks.ts`.

```ts
type TerrainBlocksMode = 'cut' | 'flatten';
```

<a id="type-terrain-erosion-layer"></a>
### TerrainErosionLayer

Declared in `packages/project-model/src/terrain-layers.ts`.

```ts
interface TerrainErosionLayer extends LayerCommon {
  kind: 'erosion';
  /** What its runs changed, per tile (absent tiles: nothing). */
  tiles?: TerrainLayerTileRef[];
  /** The settings it last ran with (the tools offer them again). */
  settings?: ErosionSettings;
}
```

<a id="type-terrain-layer"></a>
### TerrainLayer

Declared in `packages/project-model/src/terrain-layers.ts`.

```ts
type TerrainLayer = TerrainStampsLayer | TerrainErosionLayer | TerrainSplinesLayer | TerrainBlocksLayer;
```

<a id="type-terrain-layer-tile-ref"></a>
### TerrainLayerTileRef

Declared in `packages/project-model/src/terrain-layers.ts`.

```ts
/** One tile's stored erosion difference (a blob named by digest). */
interface TerrainLayerTileRef {
  x: number;
  z: number;
  data: string;
}
```

<a id="type-terrain-sculpt-kind"></a>
### TerrainSculptKind

Declared in `packages/project-model/src/terrain-edit.ts`.

```ts
type TerrainSculptKind = 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise';
```

<a id="type-terrain-splines-layer"></a>
### TerrainSplinesLayer

Declared in `packages/project-model/src/terrain-layers.ts`.

```ts
interface TerrainSplinesLayer extends LayerCommon {
  kind: 'splines';
}
```

<a id="type-terrain-stamp"></a>
### TerrainStamp

Declared in `packages/project-model/src/terrain-layers.ts`.

```ts
/** One heightmap brush placed on the terrain. */
interface TerrainStamp {
  /** The texture asset whose first channel (16- or 8-bit PNG) is the shape. */
  asset: string;
  /** World centre (x, z). */
  at: [number, number];
  /** Metres along a side (the image is square on the ground whatever its pixels). */
  size: number;
  /** Degrees about +y (as an object's yaw; absent: 0). */
  rotation?: number;
  /** Metres the image's white stands for (negative digs); black is 0. */
  height: number;
  /** add (absent): raised by the shape; max: raised up to it; min: cut down to it. */
  mode?: TerrainStampMode;
  /** max/min: the world height of the shape's 0 (absent: the terrain object's y). */
  y?: number;
  /** The share of the side (0–0.5) over which the stamp fades in from its edges (absent: 0.15). */
  falloff?: number;
}
```

<a id="type-terrain-stamp-mode"></a>
### TerrainStampMode

Declared in `packages/project-model/src/terrain-layers.ts`.

```ts
type TerrainStampMode = 'add' | 'max' | 'min';
```

<a id="type-terrain-stamps-layer"></a>
### TerrainStampsLayer

Declared in `packages/project-model/src/terrain-layers.ts`.

```ts
interface TerrainStampsLayer extends LayerCommon {
  kind: 'stamps';
  /** Applied in order. */
  stamps: TerrainStamp[];
}
```

<a id="type-terrain-tile-ref"></a>
### TerrainTileRef

Declared in `packages/project-model/src/terrain.ts`.

```ts
/** One tile of the grid: its coordinates and, when it is not flat and bare, its data blob's digest. */
interface TerrainTileRef {
  x: number;
  z: number;
  /** SHA-256 of the tile's blob (absent: flat at 0 m, unpainted, no holes). */
  data?: string;
  /** SHA-256 of the tile's scatter blob: the scatter rules' copies on it and their hand edits (`terrain-scatter.ts`; absent: none). */
  scatter?: string;
  /**
   * SHA-256 of the tile as sculpted and painted by hand, before the splines
   * that reach it carved, flattened and painted it (`terrain-splines.ts`;
   * absent: no spline or edit layer reaches it, `data` is the hand-made
   * tile). Kept so a spline moved or a layer changed gives the ground back;
   * never drawn or shipped.
   */
  base?: string;
}
```

<a id="type-thermal-erosion"></a>
### ThermalErosion

Declared in `packages/project-model/src/terrain-erosion.ts`.

```ts
/** Thermal erosion's settings (absent fields take {@link THERMAL_DEFAULTS}). */
interface ThermalErosion {
  /** Passes over the rectangle. */
  iterations?: number;
  /** The angle of repose (degrees): steeper slopes shed ground. */
  talus?: number;
  /** The share of the excess a pass moves (0–1]. */
  amount?: number;
}
```

<a id="type-timeline-easings"></a>
### TIMELINE_EASINGS

Declared in `packages/project-model/src/timelines.ts`.

```ts
/** How a value moves from the previous key to this one (`step`: holds the previous value, then jumps). */
const TIMELINE_EASINGS: readonly ["linear", "step", "easeIn", "easeOut", "easeInOut"];
```

<a id="type-timeline-track-types"></a>
### TIMELINE_TRACK_TYPES

Declared in `packages/project-model/src/timelines.ts`.

```ts
const TIMELINE_TRACK_TYPES: readonly ["camera", "transform", "animator", "audio", "dialogue", "effect", "activation", "signal", "fade", "letterbox", "wait", "material", "materialSwap", "environment", "mode"];
```

<a id="type-timeline-asset"></a>
### TimelineAsset

Declared in `packages/project-model/src/timelines.ts`.

```ts
interface TimelineAsset {
  timelineId: string;
  name: string;
  duration: number;
  slots?: TimelineSlot[];
  markers?: TimelineMarker[];
  tracks: TimelineTrack[];
  /** An input action that skips the timeline while it plays. */
  skipAction?: string;
  /** Plays when a run starts (default bindings). */
  playOnStart?: boolean;
  /** Plays when this signal fires (default bindings). */
  playOnSignal?: string;
}
```

<a id="type-timeline-easing"></a>
### TimelineEasing

Declared in `packages/project-model/src/timelines.ts`.

```ts
type TimelineEasing = (typeof TIMELINE_EASINGS)[number];
```

<a id="type-timeline-key"></a>
### TimelineKey

Declared in `packages/project-model/src/timelines.ts`.

```ts
interface TimelineKey {
  /** Seconds from the timeline's start (0 – duration). */
  time: number;
  /** A clip's length (seconds): effect, sfx. */
  duration?: number;
  easing?: TimelineEasing;
  // camera
  camera?: string;
  release?: boolean;
  blend?: 'cut' | 'linear' | 'eased';
  blendTime?: number;
  progress?: [number, number];
  // transform
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  // animator / audio
  kind?: 'set' | 'trigger' | 'play' | 'music' | 'release' | 'stinger' | 'sfx';
  name?: string;
  value?: TimelineValue | boolean;
  fade?: number;
  layer?: number;
  asset?: string;
  volume?: number;
  loop?: boolean;
  at?: string;
  /** Stinger / sfx: how late (ms) it may still start when its file is not ready yet (absent: the engine's default). */
  maxLateMs?: number;
  // dialogue
  dialogue?: string;
  node?: string;
  wait?: boolean;
  // effect
  effect?: string;
  params?: Record<string, number | number[] | string>;
  // activation
  active?: boolean;
  // materialSwap: slot (a model's material name, or "*") → materialId; null: the authored material again
  materials?: Record<string, string | null>;
  // signal
  onSkip?: 'fire' | 'drop';
  // fade
  color?: string;
  // wait
  action?: string;
  timeout?: number;
  // environment
  preset?: string;
  // mode
  mode?: string;
}
```

<a id="type-timeline-marker"></a>
### TimelineMarker

Declared in `packages/project-model/src/timelines.ts`.

```ts
interface TimelineMarker {
  name: string;
  time: number;
}
```

<a id="type-timeline-slot"></a>
### TimelineSlot

Declared in `packages/project-model/src/timelines.ts`.

```ts
interface TimelineSlot {
  /** The name tracks use (`[A-Za-z_][A-Za-z0-9_]{0,31}`). */
  name: string;
  /** The default binding (an entity id); a play call may bind another. */
  entity?: string;
}
```

<a id="type-timeline-track"></a>
### TimelineTrack

Declared in `packages/project-model/src/timelines.ts`.

```ts
interface TimelineTrack {
  /** Unique in the timeline. */
  trackId: string;
  type: TimelineTrackType;
  name?: string;
  /** A muted track does nothing (editing aid). */
  muted?: boolean;
  /** The bound object (a slot name): transform, animator, activation, material. */
  target?: string;
  keys: TimelineKey[];
  /** camera: what happens at the end (absent: release). */
  end?: 'release' | 'keep';
  endBlend?: 'cut' | 'linear' | 'eased';
  endBlendTime?: number;
  /** fade / letterbox: keep the last value after the timeline ends (absent: cleared). */
  hold?: boolean;
  /** audio: give the music back to the game flow when the timeline ends. */
  releaseMusic?: boolean;
  /** material: the parameter key and, optionally, the one material. */
  param?: string;
  material?: string;
}
```

<a id="type-timeline-track-type"></a>
### TimelineTrackType

Declared in `packages/project-model/src/timelines.ts`.

```ts
type TimelineTrackType = (typeof TIMELINE_TRACK_TYPES)[number];
```

<a id="type-timeline-value"></a>
### TimelineValue

Declared in `packages/project-model/src/timelines.ts`.

```ts
type TimelineValue = number | number[] | string;
```

<a id="type-trim-cell"></a>
### TrimCell

Declared in `packages/project-model/src/trim-sheet.ts`.

```ts
/** A decal cell's place on the sheet: a named rectangle in pixels, [x, y] its top-left corner counted from the image's top-left. */
interface TrimCell {
  /** The cell's name (an id), unique among the sheet's cells; decal materials name it. */
  name: string;
  /** [x, y, width, height] in pixels, inside the sheet. */
  rect: [number, number, number, number];
}
```

<a id="type-trim-row"></a>
### TrimRow

Declared in `packages/project-model/src/trim-sheet.ts`.

```ts
/** A row's place on the sheet: pixel rows `top` (inclusive) to `bottom` (exclusive), counted from the image's top. */
interface TrimRow {
  /** The semantic slot the row fills (an id: `floor`, `lower_wall`, …); unique on the sheet. */
  slot: string;
  top: number;
  bottom: number;
  /** Pixels per metre along u for this row (absent: the sheet's). */
  texelDensity?: number;
  /** The row tiles in v too (its padding continues its wrap, and strips may stack it up a wall). */
  tileV?: boolean;
}
```

<a id="type-trim-sheet"></a>
### TrimSheet

Declared in `packages/project-model/src/trim-sheet.ts`.

```ts
/** A trim sheet's row table (a trim material's `trim`). */
interface TrimSheet {
  /** The sheet's size in pixels [width, height] (level 0 of its textures). */
  size: [number, number];
  /** Pixels per metre along u (each row may set its own). */
  texelDensity: number;
  /** Pixels above and below every row that repeat its edge (or continue its wrap). */
  padding: number;
  rows: TrimRow[];
  /** Decal cells (absent: none). */
  cells?: TrimCell[];
}
```

<a id="type-ui-action"></a>
### UiAction

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
/** What a button click (or an input submit, a cancel, a focus) does. */
type UiAction =
  /** Raise a UI event to scripts (on the next input frame). */
  | { do: 'event'; name: string; value?: UiScalar | UiBinding }
  /** An engine action of the game shell (resume, quit to title, save, load, set a setting, …). */
  | { do: 'engine'; action: UiEngineAction; screen?: 'title' | 'pause' | 'settings' | 'controls' | 'save' | 'load'; scene?: string; slot?: string; setting?: SettingsEngineBinding; value?: number | string; step?: number; input?: string; device?: 'keyboardMouse' | 'gamepad'; index?: number; part?: 'negative' | 'positive' | 'up' | 'down' | 'left' | 'right'; policy?: 'swap' | 'refuse' | 'allow' }
  /** Show / hide / toggle a UI document (through the input frame, so replays hold). */
  | { do: 'show' | 'hide' | 'toggle'; doc: string }
  /** Play a tween of this document (presentation only). */
  | { do: 'play'; tween: string; widget?: string }
  /** Switch to a game mode (through the input frame, so replays hold). */
  | { do: 'mode'; mode: string }
  /**
   * A dialogue input (on the next input frame, so replays hold):
   * advance (or reveal the rest of the line), choose (the list item's index,
   * or `value`), skip (toggle skipping seen lines), auto (toggle
   * auto-advance), backlog (toggle the backlog view).
   */
  | { do: 'dialogue'; input: UiDialogueInput; value?: number };
```

<a id="type-ui-bindable"></a>
### UiBindable

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
type UiBindable<T> = T | UiBinding;
```

<a id="type-ui-binding"></a>
### UiBinding

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
/** A value from the view model: `{ "bind": "path" }` (`"!path"` negates a boolean). */
interface UiBinding {
  bind: string;
}
```

<a id="type-ui-color"></a>
### UiColor

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
/** A colour: `#rgb`, `#rrggbb` or `#rrggbbaa`. */
type UiColor = string;
```

<a id="type-ui-dialogue-input"></a>
### UiDialogueInput

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
type UiDialogueInput = 'advance' | 'choose' | 'skip' | 'auto' | 'backlog';
```

<a id="type-ui-document"></a>
### UiDocument

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
interface UiDocument {
  uiDocumentId: string;
  name: string;
  /** Z-order layer (−100–100, higher on top; absent 0). Documents of one layer stack in show order. */
  layer?: number;
  /** A modal document blocks the documents under it and takes the focus (absent false). */
  modal?: boolean;
  /** Take the keyboard/gamepad focus when shown (absent: `modal`). */
  focus?: boolean;
  /** The input action map active while it has the focus (absent: every map stays active). */
  actionMap?: string;
  theme?: string;
  /**
   * Scale with the view: `reference` [w, h] px drawn to fit the view
   * (`fit`), its width or its height, to cover it (`cover`: the box larger
   * than the view, centred) or to fit and grow the box to the view's aspect
   * (`expand`: anchors 0 and 1 are the view's edges).
   */
  scale?: { reference: [number, number]; mode: UiScaleMode };
  styles?: Record<string, UiStyle>;
  icons?: Record<string, UiIcon>;
  tweens?: Record<string, UiTween>;
  showTween?: string;
  hideTween?: string;
  initialFocus?: string;
  /** What the cancel input (Back, pad B) does while it has the focus. */
  onCancel?: UiAction | UiAction[];
  /** The sounds of every widget that takes the pointer or the focus, unless its style or itself names one. */
  sounds?: UiSounds;
  root: UiWidget;
}
```

<a id="type-ui-easing"></a>
### UiEasing

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
type UiEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'back';
```

<a id="type-ui-engine-action"></a>
### UiEngineAction

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
type UiEngineAction =
  | 'resume'
  | 'pause'
  | 'restartLevel'
  | 'newGame'
  | 'continue'
  | 'quitToTitle'
  | 'settings'
  | 'load'
  | 'save'
  | 'back'
  | 'setSetting'
  | 'mute'
  | 'unmute'
  // Rebinding (the host's bindings API): listen for an action's input, stop listening, reset one action or all.
  | 'rebind'
  | 'cancelRebind'
  | 'resetBindings'
  // The game shell — open one of its screens (`screen`), move on to the next listed scene.
  | 'open'
  | 'nextScene'
  // A scene's objects as authored again (`scene`; absent: the active scene) — `ctx.scenes.reload`.
  | 'reloadScene'
  // Load or unload the scene named by `scene` — `ctx.scenes.load` / `ctx.scenes.unload` for a button.
  | 'loadScene'
  | 'unloadScene';
```

<a id="type-ui-icon"></a>
### UiIcon

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
/** An icon glyph for rich text (`[icon=name]`): a texture, or a part of it. */
interface UiIcon {
  asset: string;
  /** [x, y, width, height] in image pixels (absent: the whole image). */
  rect?: [number, number, number, number];
}
```

<a id="type-ui-scalar"></a>
### UiScalar

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
type UiScalar = number | string | boolean | null;
```

<a id="type-ui-scale-mode"></a>
### UiScaleMode

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
type UiScaleMode = 'fit' | 'width' | 'height' | 'cover' | 'expand';
```

<a id="type-ui-sounds"></a>
### UiSounds

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
/** Sounds a widget plays on the `ui` bus (audio assets): a click (any activation), the pointer coming over it, the focus moving to it. */
interface UiSounds {
  click?: string;
  hover?: string;
  focus?: string;
}
```

<a id="type-ui-style"></a>
### UiStyle

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
interface UiStyle extends UiStyleValues {
  /** The sounds of the widgets in this style (under a widget's own). */
  sounds?: UiSounds;
  hover?: UiStyleValues;
  focus?: UiStyleValues;
  pressed?: UiStyleValues;
  disabled?: UiStyleValues;
}
```

<a id="type-ui-style-values"></a>
### UiStyleValues

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
/** The closed set of style properties (never raw CSS). */
interface UiStyleValues {
  color?: UiColor;
  background?: UiColor;
  /** A texture asset drawn behind the widget (stretched, or 9-sliced with `slice`). */
  backgroundImage?: string;
  /** 9-slice insets of `backgroundImage` in image pixels: [top, right, bottom, left]. */
  slice?: [number, number, number, number];
  opacity?: number;
  /** A font asset of the project, or a generic family: sans, serif, mono, rounded. */
  font?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  letterSpacing?: number;
  /** One number (all sides) or [top, right, bottom, left], px. */
  padding?: number | [number, number, number, number];
  radius?: number;
  borderWidth?: number;
  borderColor?: UiColor;
  /** A text shadow colour (1 px down, 2 px blur). */
  textShadow?: UiColor;
  /** A box shadow colour (4 px down, 12 px blur). */
  shadow?: UiColor;
}
```

<a id="type-ui-theme"></a>
### UiTheme

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
interface UiTheme {
  uiThemeId: string;
  name: string;
  styles: Record<string, UiStyle>;
  icons?: Record<string, UiIcon>;
}
```

<a id="type-ui-tween"></a>
### UiTween

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
interface UiTween {
  kind: UiTweenKind;
  /** Seconds. */
  duration: number;
  delay?: number;
  easing?: UiEasing;
  /** fade: opacity; scale/stamp: scale; slide: progress (1 = `distance` away, 0 = in place). */
  from?: number;
  to?: number;
  /** slide: where it comes from. */
  direction?: 'left' | 'right' | 'up' | 'down';
  /** slide: px. */
  distance?: number;
}
```

<a id="type-ui-tween-kind"></a>
### UiTweenKind

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
type UiTweenKind = 'fade' | 'slide' | 'scale' | 'stamp';
```

<a id="type-ui-widget"></a>
### UiWidget

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
interface UiWidget {
  id?: string;
  type: UiWidgetType;
  // Placement in a panel (a stack/grid/list parent flows its children; only `size` and `grow` apply there).
  anchor?: [number, number];
  pivot?: [number, number];
  /** Px from the anchor; each axis a number or a view-model binding. */
  offset?: [UiBindable<number>, UiBindable<number>];
  /** Each axis a number, null (sized to the content) or a view-model binding. */
  size?: [UiBindable<number> | null, UiBindable<number> | null];
  stretch?: 'x' | 'y' | 'both';
  margin?: [number, number, number, number];
  grow?: number;
  style?: string | string[];
  css?: UiStyle;
  visible?: UiBindable<boolean>;
  enabled?: UiBindable<boolean>;
  /** How opaque the widget and its children are (0–1), over its style's opacity; a number or a binding. */
  opacity?: UiBindable<number>;
  /** Degrees clockwise about the widget's pivot (its centre in a stack, grid or list); a number or a binding. */
  rotation?: UiBindable<number>;
  focusable?: boolean;
  /** This widget's sounds (over its styles' and the document's). */
  sounds?: UiSounds;
  nav?: { up?: string; down?: string; left?: string; right?: string; next?: string; prev?: string };
  worldAnchor?: UiWorldAnchor;
  onFocus?: UiAction | UiAction[];
  // Containers.
  children?: UiWidget[];
  direction?: 'row' | 'column' | 'grid' | 'right' | 'left' | 'up' | 'down';
  gap?: number;
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  columns?: number;
  cellSize?: [number, number];
  // text / button / input
  text?: string;
  /**
   * Text: the widget's text is the rich text at this view-model
   * path (markup parsed, braces are plain text) instead of `text`.
   */
  content?: UiBinding;
  /** Text: only the first N visible characters show (a typewriter; the rest keeps its place, hidden). */
  reveal?: UiBindable<number>;
  // image
  image?: UiBindable<string>;
  /** Show a save slot's picture instead of a texture (a slot number or a binding to one; nothing while it has none). */
  saveSlot?: UiBindable<number>;
  slice?: [number, number, number, number];
  fit?: 'stretch' | 'contain' | 'cover';
  tint?: UiColor;
  // bar
  value?: UiBindable<number> | UiBinding;
  min?: UiBindable<number>;
  max?: UiBindable<number>;
  shape?: 'linear' | 'radial';
  fillColor?: UiColor;
  fillStyle?: string;
  /** A number or a view-model binding (degrees, 0 = up). */
  startAngle?: UiBindable<number>;
  // button
  onClick?: UiAction | UiAction[];
  // list
  items?: UiBinding;
  template?: UiWidget;
  /**
   * The field of each item naming it (`id`): an item keeps its widgets, and
   * the focus, while its key stays in the array, wherever it moves. Absent:
   * items are kept by their index.
   */
  itemKey?: string;
  // input
  placeholder?: string;
  maxLength?: number;
  onSubmit?: UiAction | UiAction[];
}
```

<a id="type-ui-widget-type"></a>
### UiWidgetType

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
type UiWidgetType = 'panel' | 'stack' | 'grid' | 'text' | 'image' | 'bar' | 'button' | 'list' | 'input';
```

<a id="type-ui-world-anchor"></a>
### UiWorldAnchor

Declared in `packages/project-model/src/ui-documents.ts`.

```ts
/** Follow a world point or an entity (projected through the rendered camera each frame). */
interface UiWorldAnchor {
  entity?: UiBindable<string>;
  point?: [number, number, number];
  /** World offset from the entity or point (m). */
  offset?: [number, number, number];
  /** Keep it on screen at the edge while the target is off screen (else it hides). */
  clamp?: boolean;
  /** px from the screen edge when clamped. */
  margin?: number;
  /** A child widget shown only while clamped, turned towards the target (`--tl-angle`). */
  indicator?: string;
}
```

<a id="type-update-entity-args"></a>
### UpdateEntityArgs

Declared in `packages/commands/src/entity-types.ts`.

```ts
/** `updateEntity` args: at least one field besides `entityId` (`parentId` null = make root). */
interface UpdateEntityArgs {
  entityId: string;
  name?: string;
  parentId?: string | null;
  active?: boolean;
  visible?: boolean;
  locked?: boolean;
  static?: boolean;
  /** The object (with its children and scripts) survives scene loads, unloads and reloads. */
  keepLoaded?: boolean;
  /** The entity's own tags, by name (replaces the whole set; [] clears). */
  tags?: string[];
}
```
