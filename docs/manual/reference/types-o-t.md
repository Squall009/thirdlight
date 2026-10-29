# Types (OCCLUSION_CULLING_MODES to TimelineEasing)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The declarations the ops' arguments and the JSON-valued fields name, as the source declares them (doc comments included).

<a id="type-occlusion-culling-modes"></a>
### OCCLUSION_CULLING_MODES

Declared in `packages/project-model/src/render-settings.ts`.

```ts
/**
 * Occlusion culling: what solid things in front hide is not drawn. `on`
 * culls with a depth pyramid on WebGPU (WebGL 2 has no culling path and
 * draws everything); `auto` (and a project that does not set it) culls
 * nothing for now: the depth pyramid's two-pass frame costs an open view more
 * than it saves at the sizes measured; `off` draws everything in view.
 * Culling draws the same picture as without it, so `on` changes cost, never
 * the look.
 */
const OCCLUSION_CULLING_MODES: readonly ["off", "auto", "on"];
```

<a id="type-occlusion-culling"></a>
### OcclusionCulling

Declared in `packages/project-model/src/render-settings.ts`.

```ts
type OcclusionCulling = (typeof OCCLUSION_CULLING_MODES)[number];
```

<a id="type-owned-component"></a>
### OwnedComponent

Declared in `packages/commands/src/types.ts`.

```ts
/** Every `setComponent`-owned component (the base five plus the six v3 ones). */
type OwnedComponent =
  | 'box'
  | 'camera'
  | 'model'
  | 'collider'
  | 'controller'
  | V3OwnedComponent;
```

<a id="type-packed-channel"></a>
### PackedChannel

Declared in `packages/project-model/src/types-v2.ts`.

```ts
/** One channel of a packed texture: a channel of a texture asset's version, or a constant. */
type PackedChannel = { assetId: string; digest: string; channel: 'r' | 'g' | 'b' | 'a' } | { value: number };
```

<a id="type-packed-from"></a>
### PackedFrom

Declared in `packages/project-model/src/types-v2.ts`.

```ts
/**
 * A KTX2 texture (an array when it has several layers) packed at
 * import from texture assets, channel by channel: per layer its R, G, B and A
 * sources.
 */
interface PackedFrom {
  layers: PackedChannel[][];
  converter: { name: 'ktx2-encoder'; version: string };
  encoding: 'color' | 'normal' | 'data';
  /**
   * Per layer: made from texels transcoded out of a lossy KTX2 and encoded
   * again (false: joined as stored, or encoded from a lossless image).
   * Absent on textures packed before KTX2 sources were taken.
   */
  reencoded?: boolean[];
}
```

<a id="type-paint-instances-args"></a>
### PaintInstancesArgs

Declared in `packages/commands/src/instance-stroke-ops.ts`.

```ts
/** `paintInstances` args: the instance set and one stroke. */
interface PaintInstancesArgs extends InstanceStroke {
  entityId: string;
}
```

<a id="type-paint-target"></a>
### PaintTarget

Declared in `packages/project-model/src/block-grid.ts`.

```ts
/** What a paint dab paints: the tops' lattice, the walls' points (a layer with wall paint), or both. */
type PaintTarget = 'tops' | 'walls' | 'both';
```

<a id="type-paint-vec3"></a>
### PaintVec3

Declared in `packages/project-model/src/vertex-paint-stroke.ts`.

```ts
type PaintVec3 = [number, number, number];
```

<a id="type-paint-vertices-args"></a>
### PaintVerticesArgs

Declared in `packages/commands/src/vertex-paint-ops.ts`.

```ts
/** `paintVertices` args: the object and one stroke. */
interface PaintVerticesArgs extends VertexPaintStroke {
  entityId: string;
}
```

<a id="type-partial-transform-args"></a>
### PartialTransformArgs

Declared in `packages/commands/src/entity-types.ts`.

```ts
/**
 * Partial transform args: any non-empty subset; a present field replaces the
 * whole field (arrays are never merged component-wise). Element values
 * (length, finiteness, ranges, quaternion norm) are re-checked by the
 * project-model validation of the resulting scene.
 */
interface PartialTransformArgs {
  position?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
}
```

<a id="type-paste-entities-args"></a>
### PasteEntitiesArgs

Declared in `packages/commands/src/types.ts`.

```ts
/**
 * `pasteEntities`: create copies of full entity values in one transaction
 * (Duplicate, Copy/Paste — also across scenes). See `paste-ops.ts`.
 */
interface PasteEntitiesArgs {
  entities: { id: string; parentId?: string; components: Record<string, unknown> }[];
  /** The parent of the pasted roots (null = scene root); absent = each root's own parentId. */
  parentId?: string | null;
  /** Added to the positions of the copies placed in world space. */
  offset?: [number, number, number];
}
```

<a id="type-path-paint-sides"></a>
### PATH_PAINT_SIDES

Declared in `packages/project-model/src/vertex-paint.ts`.

```ts
/** The sides of a path its paint is kept for: the faces to the left and right of travel, and the faces looking up or down. */
const PATH_PAINT_SIDES: readonly ["left", "right", "top"];
```

<a id="type-path-paint-grid"></a>
### PathPaintGrid

Declared in `packages/project-model/src/vertex-paint.ts`.

```ts
/** One side of one path's paint: a grid of points {@link PATH_PAINT_CELL} m apart. */
interface PathPaintGrid {
  /** The path: `outline:<id>`, `building:<id>`, `element:<id>` (architecture) or `spline`. */
  path: string;
  side: PathPaintSide;
  /** The grid's first point, in cells: along the path, and up (left/right) or across (top). */
  origin: [number, number];
  /** Points along and up/across. */
  size: [number, number];
  /** SHA-256 of the grid: 4 bytes a point, rows (up/across) of points along. */
  paint: string;
}
```

<a id="type-path-paint-side"></a>
### PathPaintSide

Declared in `packages/project-model/src/vertex-paint.ts`.

```ts
type PathPaintSide = (typeof PATH_PAINT_SIDES)[number];
```

<a id="type-plane-axes"></a>
### PLANE_AXES

Declared in `packages/project-model/src/plane-lock.ts`.

```ts
/** The world axes a plane's normal may lie along (Y is "up", so a plane through it would be a floor). */
const PLANE_AXES: readonly ["x", "z"];
```

<a id="type-plane-axis"></a>
### PlaneAxis

Declared in `packages/project-model/src/plane-lock.ts`.

```ts
type PlaneAxis = (typeof PLANE_AXES)[number];
```

<a id="type-plane-lock"></a>
### PlaneLock

Declared in `packages/project-model/src/plane-lock.ts`.

```ts
/** A plane: its normal's world axis and where it lies along that axis (m). */
interface PlaneLock {
  axis: PlaneAxis;
  origin: number;
}
```

<a id="type-pointer-axis-name"></a>
### PointerAxisName

Declared in `packages/project-model/src/input.ts`.

```ts
/** One axis of the pointer's movement (x, y) or the wheel. */
type PointerAxisName = 'x' | 'y' | 'wheel';
```

<a id="type-pointer-button-name"></a>
### PointerButtonName

Declared in `packages/project-model/src/input.ts`.

```ts
/** The pointer buttons an action binds. */
type PointerButtonName = 'left' | 'right' | 'middle';
```

<a id="type-post-config"></a>
### PostConfig

Declared in `packages/project-model/src/materials.ts`.

```ts
interface PostConfig {
  toneMapping?: 'none' | 'aces' | 'agx' | 'neutral';
  exposure?: number;
  bloom?: { enabled: boolean; strength?: number; radius?: number; threshold?: number };
  /**
   * Colour grading. Lift (raises the blacks, −0.5–0.5, default 0),
   * gamma (mid-tones, 0.2–5, default 1: >1 brightens) and gain (scales the
   * whites, 0–4, default 1) — the defaults leave the image unchanged.
   */
  grading?: { contrast?: number; saturation?: number; brightness?: number; tint?: string; lut?: string; lift?: number; gamma?: number; gain?: number };
  vignette?: { enabled: boolean; darkness?: number; offset?: number };
  ssao?: { enabled: boolean; radius?: number; intensity?: number };
  dof?: { enabled: boolean; focus?: number; aperture?: number; maxBlur?: number };
  /** `taau`: temporal upscaling (WebGPU in Play and exports; SMAA in its place elsewhere). */
  antialias?: AntialiasKind;
}
```

<a id="type-prefab-field-override"></a>
### PrefabFieldOverride

Declared in `packages/project-model/src/prefab-links.ts`.

```ts
/**
 * A changed or added field: `path` is `/`-separated from the part —
 * `name`, `tags`, `components/<component>` (an added or replaced component),
 * or deeper, `components/<component>/<field>/…` (one changed field; arrays
 * are replaced whole). The copy root's transform is the copy's own and is
 * never an override.
 */
interface PrefabFieldOverride {
  part: string;
  path: string;
  value: unknown;
}
```

<a id="type-prefab-field-removal"></a>
### PrefabFieldRemoval

Declared in `packages/project-model/src/prefab-links.ts`.

```ts
/** A removed component or field (`path` as above). */
interface PrefabFieldRemoval {
  part: string;
  path: string;
  remove: true;
}
```

<a id="type-prefab-override"></a>
### PrefabOverride

Declared in `packages/project-model/src/prefab-links.ts`.

```ts
/** One difference a copy keeps from its prefab, on the part `part` names. */
type PrefabOverride = PrefabFieldOverride | PrefabFieldRemoval | PrefabPartRemoval;
```

<a id="type-prefab-override-target-args"></a>
### PrefabOverrideTargetArgs

Declared in `packages/commands/src/prefab-link-types.ts`.

```ts
/**
 * Names the overrides of one copy: `entityId` is the copy (its root) or one
 * of its parts. `part` names a part of the copy by its part path (a removed
 * part has no object to name); `path` one field of that part (`name`,
 * `tags`, `components/<component>[/<field>…]`). `all` names every override
 * of the copy (and, to apply, the objects added to it). To apply, `entityId`
 * may also name an object added to a copy, alone: it becomes a part of that
 * copy's prefab (a linked copy added so nests in it).
 */
interface PrefabOverrideTargetArgs {
  entityId: string;
  part?: string;
  path?: string;
  all?: boolean;
}
```

<a id="type-prefab-part-removal"></a>
### PrefabPartRemoval

Declared in `packages/project-model/src/prefab-links.ts`.

```ts
/** A removed part, with every part under it. Never the root. */
interface PrefabPartRemoval {
  part: string;
  remove: true;
}
```

<a id="type-probe-bake"></a>
### ProbeBake

Declared in `packages/project-model/src/probe-grids.ts`.

```ts
interface ProbeBake {
  /** ISO-8601 time of the bake. */
  createdAt: string;
  /** The horizontal spacing the bake used where no volume set its own (the scene's probe spacing for the next bake). */
  spacing: number;
  bounces: number;
  grids: ProbeGridRecord[];
  /** Probes baked in all tiles; of those, moved out of geometry and filled from neighbours. */
  probes: number;
  moved: number;
  filled: number;
  /** GPU memory of the tiles' 3D textures (bytes). */
  gpuBytes: number;
  /** Hashes of the baked/mixed lights and the static objects at bake time (stale check). */
  lightsHash: string;
  staticsHash: string;
  /** The texture sky's turn the probes saw (degrees; absent: 0): another turn makes them stale. */
  skyRotation?: number;
}
```

<a id="type-probe-grid-box"></a>
### ProbeGridBox

Declared in `packages/project-model/src/probe-grids.ts`.

```ts
/** A tile: its world box and its probes per axis (probes sit on the box's corners and every spacing between). */
interface ProbeGridBox {
  min: Vec3;
  max: Vec3;
  resolution: Vec3;
}
```

<a id="type-probe-grid-record"></a>
### ProbeGridRecord

Declared in `packages/project-model/src/probe-grids.ts`.

```ts
interface ProbeGridRecord extends ProbeGridBox {
  /** The texture asset holding this tile's probes. */
  asset: string;
}
```

<a id="type-property-bounds"></a>
### PropertyBounds

Declared in `packages/project-model/src/types-v2.ts`.

```ts
interface PropertyBounds {
  min: Vec3;
  max: Vec3;
}
```

<a id="type-property-declaration"></a>
### PropertyDeclaration

Declared in `packages/project-model/src/types-v2.ts`.

```ts
interface PropertyDeclaration {
  properties: DeclaredProperty[];
}
```

<a id="type-property-override"></a>
### PropertyOverride

Declared in `packages/commands/src/types.ts`.

```ts
/** One declared-property override at instantiation. */
interface PropertyOverride {
  localId: string;
  key: string;
  value: PropertyValue;
}
```

<a id="type-property-type"></a>
### PropertyType

Declared in `packages/project-model/src/types-v2.ts`.

```ts
type PropertyType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'enum'
  | 'vec3'
  | 'entityRef'
  | 'assetRef';
```

<a id="type-property-value"></a>
### PropertyValue

Declared in `packages/project-model/src/types-v2.ts`.

```ts
/** Seven-type property value vocabulary. */
type PropertyValue =
  | number
  | boolean
  | string
  | [number, number, number]
  | null;
```

<a id="type-property-visibility"></a>
### PropertyVisibility

Declared in `packages/project-model/src/types-v2.ts`.

```ts
/** Declared-property visibility (Unity-like public/private). */
type PropertyVisibility = 'public' | 'private';
```

<a id="type-publish-asset-animation"></a>
### PublishAssetAnimation

Declared in `packages/commands/src/types.ts`.

```ts
/** The version-local mapping moved with a reimport. */
interface PublishAssetAnimation {
  entityId: string;
  roles: ModelAnimationRolesValue;
}
```

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
  /**
   * Model create only ("Bake to model"): the object whose clipped decal this
   * model was cut from. In the same change (one undo) the asset's material
   * map names the decal's material for the file's `<material>_decal`
   * material, and the object's `decal` component is replaced by a `model` of
   * this asset. Refused unless the object carries a clipped decal and no model.
   */
  bakeDecal?: { entityId: string };
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
  ambientOcclusion?: AmbientOcclusionKind;
  /** 0.25–4: divides every LOD switch point and cull size (over the project's `lod_bias`). */
  lodBias?: number;
  dynamicResolution?: boolean;
  /** Occlusion culling at this level (absent: the project's `occlusion_culling`). */
  occlusionCulling?: OcclusionCulling;
  /** The lighting tier (absent: `DEFAULT_LIGHTING_TIER`): sets the five settings below where the level leaves them out. */
  lighting?: LightingTier;
  /** 16–2048: the surface cache's memory budget in MiB (absent: the tier's). */
  surfaceCacheMiB?: number;
  /** 0–8: the GPU time a frame may spend lighting stale surface-cache texels, ms (absent: the tier's; 0: saved light only). */
  surfaceLightMs?: number;
  /** Screen-space contact shadows on the sun's light (absent: the tier's). */
  contactShadows?: boolean;
  /** Reflections on glossy surfaces (absent: the tier's). */
  reflections?: ReflectionQuality;
  /** The shadow atlas's side in texels, one of `SHADOW_ATLAS_SIZES` (absent: the tier's). */
  shadowAtlas?: number;
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

<a id="type-reflection-qualities"></a>
### REFLECTION_QUALITIES

Declared in `packages/project-model/src/quality-levels.ts`.

```ts
/** A level's reflections: none, or screen-space rays with traced fallback at a quality. */
const REFLECTION_QUALITIES: readonly ["off", "medium", "high"];
```

<a id="type-reflection-quality"></a>
### ReflectionQuality

Declared in `packages/project-model/src/quality-levels.ts`.

```ts
type ReflectionQuality = (typeof REFLECTION_QUALITIES)[number];
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
  /** Drawing: the copies thin to a dither round a subject behind them (see-through.ts; absent: true). */
  seeThrough?: boolean;
  /**
   * Drawing: how readily the copies give way to the view's subjects as they
   * pass (foliage-bend.ts; a factor on each subject's strength, 0: never;
   * absent: 1). Only a foliage material bends.
   */
  bendAway?: number;
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
  vertexColors?: 'data' | StoredVertexColors;
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
  /** Model only: what of it counts as an occluder — auto (its `_OCC` nodes, else its opaque surfaces; stored as absence), occ or none. */
  occluder?: ModelOccluderMode;
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
  /**
   * More objects that take the same `value` (each merged into its own
   * component, as `entityId`'s is), in the same transaction: one revision,
   * one undo — an edit of a multi-selection. Distinct, without `entityId`.
   */
  entityIds?: string[];
  /**
   * With `entityIds`: each further object's own partial value, in the same
   * order (absent: `value` for each) — a field edited on a multi-selection
   * whose other parts differ per object (one decal's width among sizes).
   */
  values?: Record<string, unknown>[];
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
  /** The physical sky's clouds: the share of the sky they cover (0: clear) and how solid they are (0: none). They drift along the scene's global wind. */
  cloudCoverage?: number;
  cloudDensity?: number;
  /** Seconds of drift behind the clouds when the clock starts: every run (and replay) starts on the same sky. */
  cloudTime?: number;
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

<a id="type-stored-vertex-colors"></a>
### StoredVertexColors

Declared in `packages/project-model/src/types-v3.ts`.

```ts
/** A model's stored COLOR_0 setting (absent: data); see `AssetRecordV3.vertexColors`. */
type StoredVertexColors = 'tint' | 'trim';
```

<a id="type-stroke-surface-sample"></a>
### StrokeSurfaceSample

Declared in `packages/project-model/src/instance-brush.ts`.

```ts
/** The surface under one candidate: its height and the normal's X and Z (Y follows); null: nothing there. */
type StrokeSurfaceSample = [number, number, number] | null;
```

<a id="type-surface-bake"></a>
### SurfaceBake

Declared in `packages/project-model/src/lighting.ts`.

```ts
/**
 * The saved result of the live lighting: what WebGL 2, the low tier and
 * exports draw, and what live tiers start from.
 *
 * `files` are texture assets, each a 16-bit RGBA PNG used as a byte
 * container (the three-adapter's `surface-bake-file.ts` writes and reads
 * it): concatenated, their bytes are one saved file holding the tiles'
 * places, the cache's pages (RGBA half floats) and the probes' tiles as the
 * probe lighting draws them. The rest is a summary for the editor and the
 * stale check.
 */
interface SurfaceBake {
  /** ISO-8601 time of the bake. */
  createdAt: string;
  files: string[];
  /** The cache level its tiles were saved at (0: 10 cm texels, each level doubles). */
  level: number;
  /** Cache tiles, pages and texels saved, probes saved, and the files' bytes. */
  tiles: number;
  pages: number;
  probes: number;
  bytes: number;
  /** The run's time to settle (ms). */
  millis: number;
  /** Hashes of the baked/mixed lights and the static objects at bake time (stale check). */
  lightsHash: string;
  staticsHash: string;
  /** The texture sky's turn the probes saw (degrees; absent: 0). */
  skyRotation?: number;
  /** Terrain rings saved (absent: none, or a bake made before terrain was saved). */
  rings?: number;
}
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
  /** What the rule is called in the editor ("Rock on steep slopes"; absent: a summary of its conditions). Paints nothing. */
  name?: string;
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
const TIMELINE_TRACK_TYPES: readonly ["camera", "transform", "animator", "audio", "dialogue", "effect", "activation", "signal", "fade", "letterbox", "wait", "material", "materialSwap", "environment", "mode", "character"];
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
