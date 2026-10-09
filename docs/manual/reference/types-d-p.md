# Types (DialogueSettings to PublishAssetArgs)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The declarations the ops' arguments and the JSON-valued fields name, as the source declares them (doc comments included).

<a id="type-dialogue-settings"></a>
### DialogueSettings

Declared in `packages/project-model/src/dialogue.ts`.

```ts
interface DialogueSettings {
  /** Characters per second of the typewriter reveal; 0 = the whole line at once (absent: 40). */
  textSpeed?: number;
  /** Lines advance by themselves after the voice clip (or the reveal) ends, unless a line says otherwise (absent: false). */
  autoAdvance?: boolean;
  /** Seconds between the end of a line's voice/reveal and an auto-advance (absent: 0.5). */
  autoDelay?: number;
  /** Music and SFX level while a voice line plays (0–1; absent: 0.4; 1 = no ducking). */
  duck?: number;
  /** Lines kept in the backlog (absent: 50). */
  backlog?: number;
  /** The UI document the runner shows (absent: the engine's default dialogue document). */
  document?: string;
  /** A UI theme the engine's default document uses (its styles override the default look). */
  theme?: string;
  /** How late (ms) a line's voice may still start when its file is not ready yet; later it is dropped and the line plays silent (absent: 1000). */
  voiceMaxLateMs?: number;
}
```

<a id="type-dialogue-speaker"></a>
### DialogueSpeaker

Declared in `packages/project-model/src/dialogue.ts`.

```ts
interface DialogueSpeaker {
  speakerId: string;
  /** Shown on the name plate. */
  name: string;
  /** The name plate colour (`#rrggbb`; absent: the document's style). */
  color?: string;
  /** Expression id → texture asset (absent: no portrait). */
  portraits?: Record<string, string>;
  /** The expression a line without one shows (absent: `neutral`, else the first portrait by id). */
  defaultExpression?: string;
  /** A voice profile id (project data, e.g. what a voice pipeline or a script keys on). */
  voiceProfile?: string;
  /** An audio asset played while this speaker's text reveals (not on voiced lines). */
  blip?: string;
  /** Characters between two blips (absent: 2). */
  blipEvery?: number;
  /** Blip volume 0–1 (absent: 0.6). */
  blipVolume?: number;
}
```

<a id="type-edges-edit"></a>
### EdgesEdit

Declared in `packages/project-model/src/block-edges.ts`.

```ts
/** Set the edges at `at` (x, y, z, axis, …) or every edge on or inside `box` (`null` removes); `keep`: only where none stands. */
interface EdgesEdit {
  kind: 'edges';
  at?: number[];
  box?: number[];
  edge: BlockEdge | null;
  mode?: 'set' | 'keep';
}
```

<a id="type-edit-terrain-args"></a>
### EditTerrainArgs

Declared in `packages/commands/src/terrain-ops.ts`.

```ts
/** `editTerrain` args (which keys a kind takes: `EDIT_TERRAIN_KEYS`). */
interface EditTerrainArgs {
  entityId: string;
  kind: EditTerrainKind;
  /** Brush kinds: the stroke's points (world x, z). */
  dabs?: [number, number][];
  /** Metres (a ramp: half its width). */
  radius?: number;
  /** raise, lower, noise: metres at the centre; the others: the blend at the centre (0–1]. */
  strength?: number;
  falloff?: BrushFalloff;
  /** flatten: the world height levelled to. */
  height?: number;
  /** noise: the size of its bumps (metres) and its seed. */
  scale?: number;
  seed?: number;
  /** ramp: its two ends (world x, y, z). */
  from?: [number, number, number];
  to?: [number, number, number];
  /** paint: the material layer painted (0–255). */
  layer?: number;
  /** paint: take hand paint back toward the baked layers; holes: fill holes back; scatter: take the rule's copies off. */
  erase?: boolean;
  /** scatter: the scatter rule whose copies the stroke puts on (or, with erase, takes off). */
  rule?: string;
  /** import: the staged file, its form, (raw16) its size and byte order, the tile it starts at, and the heights its 0 and 65535 stand for (metres above the terrain object; absent: the terrain's range). */
  stageId?: string;
  format?: HeightmapFormat;
  size?: [number, number];
  byteOrder?: 'little' | 'big';
  at?: [number, number];
  range?: [number, number];
  /** fromBlocks: the block layer object converted. */
  source?: string;
  /** bake: the material rules set and baked (absent: the terrain's own baked again — unless only `scatter` is given; empty: none, every sample layer 0 again). */
  rules?: SurfaceRule[];
  /** bake: the scatter rules set and baked (absent: the terrain's own baked again; empty: none, their copies and hand edits gone). */
  scatter?: ScatterRule[];
  /** erode: the erosion layer written (absent: "erosion"), the world box [x0, z0, x1, z1], the runs (and `seed`). */
  layerId?: string;
  rect?: [number, number, number, number];
  hydraulic?: ErosionSettings['hydraulic'];
  thermal?: ErosionSettings['thermal'];
}
```

<a id="type-edit-terrain-kind"></a>
### EditTerrainKind

Declared in `packages/commands/src/terrain-ops.ts`.

```ts
type EditTerrainKind = TerrainSculptKind | 'ramp' | 'paint' | 'holes' | 'import' | 'fromBlocks' | 'bake' | 'scatter' | 'erode';
```

<a id="type-effect-parameter-types"></a>
### EFFECT_PARAMETER_TYPES

Declared in `packages/project-model/src/effects.ts`.

```ts
const EFFECT_PARAMETER_TYPES: readonly ["float", "vec3", "color"];
```

<a id="type-effect-def"></a>
### EffectDef

Declared in `packages/project-model/src/effects.ts`.

```ts
interface EffectDef {
  effectId: string;
  name: string;
  /** Seconds of one cycle (bursts and the effect time refer to it). */
  duration: number;
  /** true: the cycle restarts at the end; false: spawning stops and the effect ends when its particles are gone. */
  loop: boolean;
  /** The random seed (0 – 2^32−1). */
  seed: number;
  /** Culling bounds around the origin (metres, effect space). */
  bounds: { center: [number, number, number]; size: [number, number, number] };
  /** Exposed parameters (absent = none; list order is the Inspector's). */
  parameters?: EffectParameter[];
  /** The particle systems, in evaluation order (events reach later systems in the same step). */
  systems: EffectSystem[];
}
```

<a id="type-effect-parameter"></a>
### EffectParameter

Declared in `packages/project-model/src/effects.ts`.

```ts
/** An exposed parameter of an effect (read by Parameter nodes of its systems). */
interface EffectParameter {
  /** An identifier (Parameter nodes and overrides name it). */
  key: string;
  type: EffectParameterType;
  /** float: a number; vec3: 3 numbers; color: "#rrggbb". */
  default: number | number[] | string;
  min?: number;
  max?: number;
  /** Public (absent) = objects may override it; private = the effect's own value only. */
  visibility?: 'public' | 'private';
  label?: string;
  group?: string;
  tooltip?: string;
}
```

<a id="type-effect-parameter-type"></a>
### EffectParameterType

Declared in `packages/project-model/src/effects.ts`.

```ts
type EffectParameterType = (typeof EFFECT_PARAMETER_TYPES)[number];
```

<a id="type-effect-system"></a>
### EffectSystem

Declared in `packages/project-model/src/effects.ts`.

```ts
interface EffectSystem {
  systemId: string;
  name: string;
  /** Capacity: at most this many living particles (the executor may cap lower, e.g. the CPU fallback). */
  maxParticles: number;
  /** local: particles move with the origin; world: they stay where they were born. */
  space: 'local' | 'world';
  /** The system's graph (kind `effect`). */
  graph: GraphData;
}
```

<a id="type-element-base"></a>
### ElementBase

Declared in `packages/project-model/src/architecture.ts`.

```ts
interface ElementBase {
  id: string;
  /** The material slot (absent: {@link ARCHITECTURE_MATERIAL_SLOT}). */
  material?: string;
  /** Detail: left out of the far level (mouldings, bevels; absent: false). */
  detail?: boolean;
  /** Colliders (absent: true, but false for detail elements). */
  collide?: boolean;
}
```

<a id="type-empty-args"></a>
### EmptyArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** undo/redo args: exactly the empty object (strictly enforced at runtime). */
interface EmptyArgs {
  // intentionally empty — any field is rejected (field_unexpected)
}
```

<a id="type-environment-light-types"></a>
### ENVIRONMENT_LIGHT_TYPES

Declared in `packages/project-model/src/environment-presets.ts`.

```ts
const ENVIRONMENT_LIGHT_TYPES: readonly ["directional", "ambient", "point", "spot", "hemisphere"];
```

<a id="type-environment-config"></a>
### EnvironmentConfig

Declared in `packages/project-model/src/materials.ts`.

```ts
/**
 * The project's part of the environment (`content.environment`): the quality
 * levels and the one a game starts at (the player's setting, so
 * project-wide) and the presets (named looks scripts switch or blend to,
 * laid over the active scene's look).
 */
interface EnvironmentConfig {
  /** The level a game starts at, one of the levels' ids (absent: the highest; players change it in the settings menu). */
  quality?: string;
  /** Named looks scripts switch or blend to at run time (environment-presets.ts). */
  presets?: EnvironmentPreset[];
  /** The project's quality levels, lowest first (quality-levels.ts; absent: the engine's low, medium and high). */
  qualityLevels?: QualityLevelConfig[];
}
```

<a id="type-environment-light-type"></a>
### EnvironmentLightType

Declared in `packages/project-model/src/environment-presets.ts`.

```ts
type EnvironmentLightType = (typeof ENVIRONMENT_LIGHT_TYPES)[number];
```

<a id="type-environment-look-parts"></a>
### EnvironmentLookParts

Declared in `packages/project-model/src/environment-presets.ts`.

```ts
/** The look parts a preset (or a script's patch) sets. */
interface EnvironmentLookParts {
  sky?: SkyConfig;
  fog?: FogConfig;
  heightFog?: HeightFogConfig;
  post?: PostConfig;
  lights?: EnvironmentPresetLight[];
  lightmap?: EnvironmentPresetLightmap;
  /** The scene's wetness under this look (0–1; absent: the base look's). */
  wetness?: number;
}
```

<a id="type-environment-preset"></a>
### EnvironmentPreset

Declared in `packages/project-model/src/environment-presets.ts`.

```ts
interface EnvironmentPreset extends EnvironmentLookParts {
  presetId: string;
  name: string;
}
```

<a id="type-environment-preset-light"></a>
### EnvironmentPresetLight

Declared in `packages/project-model/src/environment-presets.ts`.

```ts
/** One light entry: which lights (one of entity / tag / type; none: every light) and the values it sets. */
interface EnvironmentPresetLight {
  entity?: string;
  tag?: string;
  type?: EnvironmentLightType;
  color?: string;
  intensity?: number;
  /** Directional/spot: where the light points ([x, y, z], not all 0). */
  direction?: [number, number, number];
  /** Hemisphere: the ground colour. */
  groundColor?: string;
}
```

<a id="type-environment-preset-lightmap"></a>
### EnvironmentPresetLightmap

Declared in `packages/project-model/src/environment-presets.ts`.

```ts
interface EnvironmentPresetLightmap {
  /** Multiplies the baked light (absent: 1). */
  intensity?: number;
  /** Tints the baked light (absent: white). */
  tint?: string;
}
```

<a id="type-erosion-settings"></a>
### ErosionSettings

Declared in `packages/project-model/src/terrain-erosion.ts`.

```ts
/** One erosion run: hydraulic first, then thermal (either may be absent, not both). */
interface ErosionSettings {
  hydraulic?: HydraulicErosion;
  thermal?: ThermalErosion;
  seed?: number;
}
```

<a id="type-event-cue-buses"></a>
### EVENT_CUE_BUSES

Declared in `packages/project-model/src/event-cues.ts`.

```ts
const EVENT_CUE_BUSES: readonly ["sfx", "music", "voice", "ui"];
```

<a id="type-event-cue-sources"></a>
### EVENT_CUE_SOURCES

Declared in `packages/project-model/src/event-cues.ts`.

```ts
const EVENT_CUE_SOURCES: readonly ["signal", "event"];
```

<a id="type-event-cue"></a>
### EventCue

Declared in `packages/project-model/src/event-cues.ts`.

```ts
interface EventCue {
  on: (typeof EVENT_CUE_SOURCES)[number];
  /** The signal's name, or the event's type (or an animator clip event's name). */
  name: string;
  /** Only this object's events (`on: "event"`; absent: any object's). */
  entity?: string;
  /** The audio asset played. */
  assetId: string;
  /** 0–1 (absent: 1). */
  volume?: number;
  /** The mixer bus (absent: sfx). */
  bus?: (typeof EVENT_CUE_BUSES)[number];
  /** How late (ms) it may still start when its file is not ready yet; later it is dropped (absent: the engine's default). */
  maxLateMs?: number;
}
```

<a id="type-fog-config"></a>
### FogConfig

Declared in `packages/project-model/src/materials.ts`.

```ts
interface FogConfig {
  mode: 'none' | 'linear' | 'exp2';
  color: string;
  near?: number;
  far?: number;
  density?: number;
}
```

<a id="type-game-mode"></a>
### GameMode

Declared in `packages/project-model/src/modes.ts`.

```ts
interface GameMode {
  /** Stable id (scripts and UI actions name it). */
  modeId: string;
  /** Shown in the editor and the Play toolbar. */
  name: string;
  /** The input maps active in the mode (absent: every map). */
  inputMaps?: string[];
  /** A virtual camera entity that is live while the mode is (over priorities; absent: the priority rule). */
  camera?: string;
  /** UI documents shown while the mode is active (hidden when it ends). */
  ui?: string[];
  /** The behavior groups that tick (absent: every group; the others pause). */
  groups?: string[];
  /** Behaviors without a group: tick (default) or pause. */
  ungrouped?: ModeUngrouped;
  /** The engine pause may be used (default true). */
  pause?: boolean;
  /** A UI document drawn while the game is paused in this mode (absent: the engine's pause panel). */
  pauseScreen?: string;
  /** Simulation speed (0.1–4; default 1): fewer or more fixed steps per second, each step unchanged. */
  timeScale?: number;
  /** Physics, the character controller, movers and triggers step (run, default) or stand still (hold). */
  physics?: ModePhysics;
  /** How entering this mode looks (a script's switch may pass its own). */
  enter?: ModeTransition;
}
```

<a id="type-game-shell"></a>
### GameShell

Declared in `packages/project-model/src/shell.ts`.

```ts
interface GameShell {
  screens?: Partial<Record<ShellScreen, string>>;
  simulate?: Partial<Record<ShellScreen, ShellSimulate>>;
  hud?: string[];
  scenes?: ShellScene[];
  pause?: boolean;
  status?: boolean;
}
```

<a id="type-gltf-glb-recipe-v3"></a>
### GltfGlbRecipeV3

Declared in `packages/project-model/src/types-v3.ts`.

```ts
/**
 * The `gltf-glb` recipe member (the v2 shape). `extensions` is present iff `profile === 'gltf-glb'`.
 */
interface GltfGlbRecipeV3 {
  profile: 'gltf-glb';
  recipeVersion: 1;
  toolchain: Record<string, string>;
  extensions: string[];
}
```

<a id="type-graph-comment"></a>
### GraphComment

Declared in `packages/project-model/src/graph.ts`.

```ts
interface GraphComment {
  id: string;
  text: string;
  position: GraphPoint;
  /** width, height in graph units (absent = sized to the text). */
  size?: [number, number];
}
```

<a id="type-graph-data"></a>
### GraphData

Declared in `packages/project-model/src/graph.ts`.

```ts
interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups?: GraphGroup[];
  comments?: GraphComment[];
}
```

<a id="type-graph-document"></a>
### GraphDocument

Declared in `packages/project-model/src/graph.ts`.

```ts
/**
 * A graph stored as its own content record (owner kind `graph`). Graphs that
 * belong to another document (an animator controller, a material, a
 * behavior, an effect) are stored inside that document instead; the graph
 * edit command reaches them through the owner kind.
 */
interface GraphDocument {
  graphId: string;
  /** The graph kind (a key of GRAPH_KINDS). */
  kind: string;
  name: string;
  graph: GraphData;
}
```

<a id="type-graph-edge"></a>
### GraphEdge

Declared in `packages/project-model/src/graph.ts`.

```ts
interface GraphEdge {
  id: string;
  /** An output port. */
  from: GraphPortRef;
  /** An input port. */
  to: GraphPortRef;
  /** Reroute points the wire passes through, in order (graph units). */
  reroutes?: GraphPoint[];
}
```

<a id="type-graph-group"></a>
### GraphGroup

Declared in `packages/project-model/src/graph.ts`.

```ts
/** A titled, coloured frame; nodes inside its rectangle move with it in the editor. */
interface GraphGroup {
  id: string;
  title: string;
  /** `#rrggbb`. */
  color: string;
  /** x, y, width, height in graph units. */
  rect: [number, number, number, number];
}
```

<a id="type-graph-node"></a>
### GraphNode

Declared in `packages/project-model/src/graph.ts`.

```ts
interface GraphNode {
  id: string;
  /** The node type (an entry of the graph kind's catalogue). */
  type: string;
  /** Top-left corner in graph units. */
  position: GraphPoint;
  /** Drawn as its title bar only (edges attach to it). Absent = expanded. */
  collapsed?: true;
  /** Values of the node type's fields (absent keys use the field default). */
  data?: Record<string, GraphValue>;
}
```

<a id="type-graph-op"></a>
### GraphOp

Declared in `packages/project-model/src/graph.ts`.

```ts
type GraphOp =
  | { op: 'addNodes'; nodes: GraphNode[] }
  | { op: 'removeNodes'; ids: string[] }
  /** Moves nodes, comments and groups (a group's position is its rect's corner). */
  | { op: 'moveNodes'; moves: { id: string; position: GraphPoint }[] }
  | { op: 'setNodeData'; id: string; data: Record<string, GraphValue> }
  | { op: 'setCollapsed'; ids: string[]; collapsed: boolean }
  | { op: 'connect'; edges: GraphEdge[] }
  | { op: 'disconnect'; ids: string[] }
  | { op: 'setReroutes'; id: string; reroutes: GraphPoint[] }
  | { op: 'setGroups'; groups: GraphGroup[] }
  | { op: 'removeGroups'; ids: string[] }
  | { op: 'setComments'; comments: GraphComment[] }
  | { op: 'removeComments'; ids: string[] };
```

<a id="type-graph-point"></a>
### GraphPoint

Declared in `packages/project-model/src/graph.ts`.

```ts
type GraphPoint = [number, number];
```

<a id="type-graph-port-ref"></a>
### GraphPortRef

Declared in `packages/project-model/src/graph.ts`.

```ts
interface GraphPortRef {
  node: string;
  port: string;
}
```

<a id="type-graph-value"></a>
### GraphValue

Declared in `packages/project-model/src/graph.ts`.

```ts
/** A node data value: a number, a string, a boolean or a short number vector. */
type GraphValue = number | string | boolean | number[];
```

<a id="type-height-fog-config"></a>
### HeightFogConfig

Declared in `packages/project-model/src/materials.ts`.

```ts
/**
 * Exponential height fog (`heightFog` of a scene's look or a preset): fog of
 * `density` per metre at world height `height`, thinning by e^(−falloff) per
 * metre above it (thickening below), from `start` metres away from the
 * camera, in `color`; `inscatterColor` adds a glow towards the sun, narrowed
 * by `inscatterExponent`. It fogs the sky towards the horizon too, so the far
 * edge of a level fades into it.
 */
interface HeightFogConfig {
  density: number;
  color: string;
  height?: number;
  falloff?: number;
  start?: number;
  inscatterColor?: string;
  inscatterExponent?: number;
}
```

<a id="type-heightmap-format"></a>
### HeightmapFormat

Declared in `packages/project-model/src/terrain-import.ts`.

```ts
type HeightmapFormat = 'png16' | 'raw16';
```

<a id="type-hydraulic-erosion"></a>
### HydraulicErosion

Declared in `packages/project-model/src/terrain-erosion.ts`.

```ts
/** Hydraulic erosion's settings (absent fields take {@link HYDRAULIC_DEFAULTS}). */
interface HydraulicErosion {
  /** Droplets per sample of the rectangle. */
  droplets?: number;
  /** How fast a droplet takes up ground it can carry (0–1]. */
  erosion?: number;
  /** How fast it drops what it carries past its capacity (0–1]. */
  deposition?: number;
  /** Sediment a droplet carries per unit of speed, water and slope. */
  capacity?: number;
  /** Water lost a step (0–0.5). */
  evaporation?: number;
  /** How much of its direction a droplet keeps against the slope [0–0.95]. */
  inertia?: number;
  /** Steps a droplet runs before it stops. */
  lifetime?: number;
  /** Samples round a droplet it erodes from (a wider radius cuts smoother channels). */
  radius?: number;
}
```

<a id="type-import-assets-args"></a>
### ImportAssetsArgs

Declared in `packages/commands/src/import-assets.ts`.

```ts
/** `importAssets` args. */
interface ImportAssetsArgs {
  /** The folder, relative to the game folder (forward slashes). */
  folder: string;
  /** Labels every imported asset gets (besides those its own sidecar names). */
  labels?: string[];
  /** How PNG/JPEG textures in the folder are imported: encoded to KTX2 with this encoding (absent: as they are). */
  ktx2?: 'color' | 'normal' | 'data';
  /** Whether new models' images are extracted into texture assets (absent: yes; read by the host that prepares the files). */
  extractTextures?: boolean;
  /** Whether new GLB models without authored levels get generated ones (absent: no; read by the host that prepares the files). */
  generateLods?: boolean;
}
```

<a id="type-import-recipe"></a>
### ImportRecipe

Declared in `packages/project-model/src/types-v2.ts`.

```ts
/** The import recipe (recorded per version; part of the derived-cache key). */
interface ImportRecipe {
  profile: 'gltf-glb';
  recipeVersion: 1;
  toolchain: Record<string, string>;
  extensions: string[];
}
```

<a id="type-import-recipe-v3"></a>
### ImportRecipeV3

Declared in `packages/project-model/src/types-v3.ts`.

```ts
/**
 * A v3 import recipe: the `gltf-glb` member for a
 * `model` version, the `audio` member for an `audio` version.
 */
type ImportRecipeV3 = GltfGlbRecipeV3 | AudioRecipe;
```

<a id="type-import-resources-args"></a>
### ImportResourcesArgs

Declared in `packages/commands/src/import-resources.ts`.

```ts
/** `importResources` takes no args: the host prepared what the files hold. */
type ImportResourcesArgs = Record<string, never>;
```

<a id="type-input-action"></a>
### InputAction

Declared in `packages/project-model/src/input.ts`.

```ts
interface InputAction {
  name: string;
  type: InputActionType;
  /** The map it belongs to: gameplay, ui, or one of the project's `maps`. */
  map: InputMapName;
  bindings: InputBinding[];
  /** Axis values within this are 0 (then rescaled); default 0.2 for stick axes. */
  deadZone?: number;
  invert?: boolean;
  scale?: number;
}
```

<a id="type-input-action-type"></a>
### InputActionType

Declared in `packages/project-model/src/input.ts`.

```ts
type InputActionType = 'button' | 'axis1d' | 'axis2d';
```

<a id="type-input-binding"></a>
### InputBinding

Declared in `packages/project-model/src/input.ts`.

```ts
type InputBinding =
  | { kind: 'key'; code: string; hold?: number }
  | { kind: 'gamepadButton'; button: number; hold?: number; pad?: number }
  | { kind: 'gamepadAxis'; axis: number; pad?: number }
  | { kind: 'keys1d'; negative: string; positive: string }
  | { kind: 'keys2d'; up: string; down: string; left: string; right: string }
  | { kind: 'gamepadButtons1d'; negative: number; positive: number; pad?: number }
  | { kind: 'gamepadStick'; x: number; y: number; pad?: number }
  // The pointer (mouse, pen or touch). A button, the position in
  // the view (x, y 0–1 from the top left), the movement this step (a 2D axis,
  // up positive like a stick) or one axis of it (x, y up positive, or the wheel).
  | { kind: 'pointerButton'; button: PointerButtonName; hold?: number }
  | { kind: 'pointerPosition' }
  | { kind: 'pointerDelta' }
  | { kind: 'pointerAxis'; axis: PointerAxisName };
```

<a id="type-input-config"></a>
### InputConfig

Declared in `packages/project-model/src/input.ts`.

```ts
interface InputConfig {
  actions: InputAction[];
  /**
   * The project's own input maps besides gameplay and ui (a
   * game mode activates maps; absent: none). A map name is a letter or _,
   * then up to 31 letters, digits or _.
   */
  maps?: string[];
  /**
   * The project's own glyph images — a glyph key (an icon id of
   * the engine's generic set such as `pad-south`, `mouse-left` or `key`,
   * optionally for one gamepad family `xbox:pad-south` or one key
   * `key:Space`) → a texture asset shown instead of the generic icon.
   */
  glyphs?: Record<string, string>;
  /**
   * The cursor while each map is active (absent: free —
   * a pointer-driven game needs a visible cursor; mouse-look opts in to locked).
   * Keyed by any map — gameplay, ui or one of `maps`.
   */
  cursor?: { gameplay?: CursorMode; ui?: CursorMode; [map: string]: CursorMode | undefined };
}
```

<a id="type-input-map-name"></a>
### InputMapName

Declared in `packages/project-model/src/input.ts`.

```ts
/** An input map name — the engine's gameplay and ui, or one the project declares in `input.maps`. */
type InputMapName = 'gameplay' | 'ui' | (string & {});
```

<a id="type-instance-brush"></a>
### InstanceBrush

Declared in `packages/project-model/src/instance-brush.ts`.

```ts
/** The brush settings one stroke carries. */
interface InstanceBrush {
  /** Dab radius (m). */
  radius: number;
  /** Copies per square metre the stroke aims for. */
  density: number;
  /** No two copies closer than this across the ground (m; 0: only exact repeats are skipped). */
  spacing: number;
  /** Random uniform scale between these (inclusive). */
  scale: [number, number];
  /** Random turn about the up axis, 0 to this many degrees. */
  yaw: number;
  /** How far each copy leans to the surface normal: 0 upright, 1 along it. */
  align: number;
  /** Picks the jitter, scale and turn: the same seed gives the same copies. */
  seed: number;
}
```

<a id="type-instance-stroke"></a>
### InstanceStroke

Declared in `packages/project-model/src/instance-brush.ts`.

```ts
interface InstanceStroke {
  mode: InstanceStrokeMode;
  dabs: BrushVec3[];
  brush: InstanceBrush;
  /** Per candidate (in `strokeCandidates` order), the surface under it. */
  surface?: StrokeSurfaceSample[];
}
```

<a id="type-instance-stroke-mode"></a>
### InstanceStrokeMode

Declared in `packages/project-model/src/instance-brush.ts`.

```ts
type InstanceStrokeMode = 'paint' | 'erase';
```

<a id="type-instantiate-prefab-args"></a>
### InstantiatePrefabArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** `instantiatePrefab` args. */
interface InstantiatePrefabArgs {
  /** Existing definition. */
  prefabId: string;
  /** Existing entity ID or `null` (default `null`). */
  parentId?: string | null;
  /** Partial transform applied to the instance root only. */
  transform?: PartialTransformArgs;
  /** ≤ 64 `{ localId, key, value }`; `(localId, key)` unique. */
  overrides?: readonly PropertyOverride[];
}
```

<a id="type-layer-common"></a>
### LayerCommon

Declared in `packages/project-model/src/terrain-layers.ts`.

```ts
interface LayerCommon {
  /** Unique within the terrain. */
  id: string;
  name?: string;
  /** Stored only when false: the layer changes nothing until switched on again. */
  enabled?: boolean;
  /** 0–1, the share of the layer's change kept (absent: 1). */
  strength?: number;
}
```

<a id="type-lighting-bake"></a>
### LightingBake

Declared in `packages/project-model/src/lighting.ts`.

```ts
interface LightingBake {
  bakeId: string;
  /** ISO-8601 time of the bake. */
  createdAt: string;
  source: 'browser' | 'blender';
  /** Irradiance at texel value 1.0. */
  range: number;
  texelsPerMeter: number;
  samples: number;
  bounces: number;
  /** Texture asset ids, one per atlas. */
  atlases: string[];
  entries: LightingEntry[];
  /**
   * The light entities baked in full (mode "baked"): they are not realtime
   * while this bake is used; baked ambient/hemisphere lights still light
   * dynamic objects, lightmapped surfaces ignore them.
   */
  bakedLights: string[];
  /** Hashes of the baked/mixed lights and of the static objects at bake time. */
  lightsHash: string;
  staticsHash: string;
  /** The scene's baked probe grids (absent: none). */
  probes?: ProbeBake;
}
```

<a id="type-lighting-entry"></a>
### LightingEntry

Declared in `packages/project-model/src/lighting.ts`.

```ts
interface LightingEntry {
  entityId: string;
  /**
   * A block layer's chunk [cx, cz]: the entry is that chunk's lightmap (the
   * entity is the layer). Its UV1 is the chunk's lightmap layout
   * (`chunkLightmapLayout`), and `layout` is that layout's digest at bake
   * time: a chunk whose geometry changed since is drawn without it.
   */
  chunk?: [number, number];
  layout?: string;
  /** Index into `atlases`. */
  atlas: number;
  /**
   * UV1 → atlas: `uv * [sx, sy] + [ox, oy]` (the object's UV1 bounding box
   * onto its rectangle, so a piece using part of a shared UV1 atlas scales up).
   */
  scaleOffset: [number, number, number, number];
}
```

<a id="type-loadable-item-ref"></a>
### LoadableItemRef

Declared in `packages/commands/src/loadable-ops.ts`.

```ts
/** An asset or a resource, by kind and id. */
interface LoadableItemRef {
  kind: string;
  id: string;
}
```

<a id="type-material-parameter-types"></a>
### MATERIAL_PARAMETER_TYPES

Declared in `packages/project-model/src/material-graph-kinds.ts`.

```ts
/**
 * The types an exposed material parameter may have (`color` is a vec3 edited
 * as a colour). `data` is a small grid of RGBA8 cells (at most
 * {@link MATERIAL_DATA_MAX} × {@link MATERIAL_DATA_MAX}) that scripts write
 * per object at run time and Sample data nodes read — appended last so every
 * existing list keeps its order.
 */
const MATERIAL_PARAMETER_TYPES: readonly ["float", "vec2", "vec3", "vec4", "color", "texture", "data"];
```

<a id="type-material-shaders"></a>
### MATERIAL_SHADERS

Declared in `packages/project-model/src/materials.ts`.

```ts
const MATERIAL_SHADERS: readonly ["standard", "foliage", "kit", "unlit", "water", "trim"];
```

<a id="type-material-def"></a>
### MaterialDef

Declared in `packages/project-model/src/materials.ts`.

```ts
interface MaterialDef {
  materialId: string;
  name: string;
  shader: MaterialShader;
  params: Record<string, MaterialParamValue>;
  textures: Record<string, string>;
  /**
   * The exposed parameters of a graph material (read by its
   * Parameter nodes; objects may override the public ones with the
   * `materialParams` component). Absent = none.
   */
  parameters?: MaterialParameter[];
  /**
   * A node graph (graph kind `material`). A material with a graph
   * is a graph material: at render time the graph replaces `shader`, `params`
   * and `textures` (it compiles to TSL; the shader part stays for "Remove
   * graph").
   */
  graph?: GraphData;
  /**
   * A material instance — this material is its parent's (another
   * material or instance, by materialId) with some values changed: `params`
   * and `textures` over the parent's (a shader material), `values` over the
   * parent's parameter defaults (a graph material). An instance has no graph
   * or parameters of its own and its `shader` is its parent's. Anything that
   * names a material (an object's, a model asset's or a block type's mapping,
   * overrides, effects, timelines) may name an instance; the runtime gets it
   * resolved (`resolveMaterialInstances`).
   */
  instanceOf?: string;
  /** Instances of graph materials: parameter key → value (see `MaterialParameter.default`). */
  values?: Record<string, MaterialValue>;
  /**
   * A trim material's row table (`shader: 'trim'`, required there and only there; `trim-sheet.ts`). An
   * instance uses its root's table: a sheet laid out differently is a material of its own.
   */
  trim?: TrimSheet;
}
```

<a id="type-material-parameter"></a>
### MaterialParameter

Declared in `packages/project-model/src/materials.ts`.

```ts
/** An exposed parameter of a graph material. */
interface MaterialParameter {
  /** The name Parameter nodes and overrides use (an identifier). */
  key: string;
  type: MaterialParameterType;
  /**
   * float: a number; vec2–4: 2–4 numbers; color: "#rrggbb"; texture: a texture asset id or "" (none),
   * or per-layer slots — one single-layer texture asset id per array layer (`texture-slots.ts`);
   * data: the RGBA bytes (4 integers 0–255) every cell starts with.
   */
  default: MaterialValue;
  /** Data only (required there): the grid's cells [width, height], 1–64 each. */
  size?: [number, number];
  /** float / vec2–4: the range the value (every component) stays in. */
  min?: number;
  max?: number;
  /** Like script properties: public (absent) = objects may override it; private = the material's own value only. */
  visibility?: 'public' | 'private';
  /**
   * vec4 only, a per-layer setting (one component per layer of a layered
   * material): the values of texture-array layers 4, 5, … — a terrain draws
   * any number of layers through four slots and reads each layer's own value
   * (absent, or past its end: layer L takes component L % 4).
   */
  extraLayers?: number[];
  label?: string;
  group?: string;
  tooltip?: string;
}
```

<a id="type-material-parameter-type"></a>
### MaterialParameterType

Declared in `packages/project-model/src/material-graph-kinds.ts`.

```ts
type MaterialParameterType = (typeof MATERIAL_PARAMETER_TYPES)[number];
```

<a id="type-material-parameter-value"></a>
### MaterialParameterValue

Declared in `packages/project-model/src/materials.ts`.

```ts
/** The value an object stores to override a public parameter (see `MaterialParameter.default`; never per-layer slots). */
type MaterialParameterValue = number | number[] | string;
```

<a id="type-material-param-value"></a>
### MaterialParamValue

Declared in `packages/project-model/src/materials.ts`.

```ts
type MaterialParamValue = number | boolean | string | [number, number];
```

<a id="type-material-shader"></a>
### MaterialShader

Declared in `packages/project-model/src/materials.ts`.

```ts
type MaterialShader = (typeof MATERIAL_SHADERS)[number];
```

<a id="type-material-value"></a>
### MaterialValue

Declared in `packages/project-model/src/materials.ts`.

```ts
/** A material's or an instance's value of a parameter: an override's, or per-layer texture slots (`texture-slots.ts`). */
type MaterialValue = MaterialParameterValue | string[];
```

<a id="type-mode-blend"></a>
### ModeBlend

Declared in `packages/project-model/src/modes.ts`.

```ts
type ModeBlend = 'cut' | 'linear' | 'eased';
```

<a id="type-model-animation-roles-value"></a>
### ModelAnimationRolesValue

Declared in `packages/commands/src/types.ts`.

```ts
/** The three role keys, all required, in canonical order. */
interface ModelAnimationRolesValue {
  idle: AnimationRoleBindingValue;
  run: AnimationRoleBindingValue;
  airborne: AnimationRoleBindingValue;
}
```

<a id="type-model-args"></a>
### ModelArgs

Declared in `packages/commands/src/entity-types.ts`.

```ts
/** Model args for createEntity: only when `kind` is `"model"`. */
interface ModelArgs {
  asset: { assetId: string };
  /** One named piece of a multi-piece GLB (absent = the whole file). */
  piece?: string;
}
```

<a id="type-model-collider-kind"></a>
### ModelColliderKind

Declared in `packages/project-model/src/model-collision.ts`.

```ts
/**
 * What a conversion makes: a box around the render geometry; in 3D a hull
 * or mesh of the collision node (else the geometry), on a 2D plane its
 * polygon; or a compound of the collision node's convex parts.
 */
type ModelColliderKind = 'box' | 'convex' | 'mesh' | 'polygon' | 'compound';
```

<a id="type-model-lod-settings"></a>
### ModelLodSettings

Declared in `packages/project-model/src/model-lod.ts`.

```ts
/** A model's LOD group settings (its import settings). */
interface ModelLodSettings {
  /** Below `screenSizes[i]` level i+1 takes over (decreasing, each in (0, 1]). */
  screenSizes?: number[];
  /** Below this screen size the model is not drawn (0: always drawn). */
  cullSize?: number;
}
```

<a id="type-mode-physics"></a>
### ModePhysics

Declared in `packages/project-model/src/modes.ts`.

```ts
type ModePhysics = 'run' | 'hold';
```

<a id="type-mode-transition"></a>
### ModeTransition

Declared in `packages/project-model/src/modes.ts`.

```ts
/**
 * How a switch looks: the camera blend into the mode's camera and an
 * optional overlay document (a fade panel: its own show/hide tweens are the
 * fade) shown for `fadeTime` seconds from the switch.
 */
interface ModeTransition {
  /** The camera blend (absent: the incoming camera's own blend). */
  blend?: ModeBlend;
  /** Seconds of the camera blend (0–30; absent: the camera's own). */
  blendTime?: number;
  /** A UI document shown for `fadeTime` seconds from the switch (its show/hide tweens make the fade). */
  fade?: string;
  /** Seconds the fade document stays (0.05–10; default 0.5). */
  fadeTime?: number;
}
```

<a id="type-mode-ungrouped"></a>
### ModeUngrouped

Declared in `packages/project-model/src/modes.ts`.

```ts
type ModeUngrouped = 'tick' | 'pause';
```

<a id="type-move-entities-args"></a>
### MoveEntitiesArgs

Declared in `packages/commands/src/types.ts`.

```ts
/**
 * `moveEntities`: up to 64 entities, moved with their subtrees
 * under `parentId` (null = root), just before the sibling `beforeId` or
 * (absent/null) after the parent's last child. World transforms are kept.
 */
interface MoveEntitiesArgs {
  entityIds: string[];
  parentId: string | null;
  beforeId?: string | null;
  /** Another scene to move them into (the host gives the command that scene as `otherScene`). */
  sceneId?: string;
}
```

<a id="type-move-item-ref"></a>
### MoveItemRef

Declared in `packages/commands/src/move-ops.ts`.

```ts
/** An item a move names: an asset (`asset` or its own kind), a resource kind, or `scene`. */
interface MoveItemRef {
  kind: string;
  id: string;
}
```

<a id="type-move-resources-args"></a>
### MoveResourcesArgs

Declared in `packages/commands/src/move-ops.ts`.

```ts
/** `moveResources` args: the items and folders moved into `to` (a folder of the game folder; `""`: its top). */
interface MoveResourcesArgs {
  items?: MoveItemRef[];
  folders?: string[];
  to: string;
}
```

<a id="type-msaa-sample-counts"></a>
### MSAA_SAMPLE_COUNTS

Declared in `packages/project-model/src/quality-levels.ts`.

```ts
/**
 * MSAA sample counts a level may ask for. WebGPU multisamples only at 1 or 4
 * samples (its render targets take no other count), so 4 is the one count
 * both renderers draw; 0 draws without MSAA.
 */
const MSAA_SAMPLE_COUNTS: readonly [0, 4];
```

<a id="type-msaa-samples"></a>
### MsaaSamples

Declared in `packages/project-model/src/quality-levels.ts`.

```ts
type MsaaSamples = (typeof MSAA_SAMPLE_COUNTS)[number];
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
  antialias?: 'none' | 'fxaa' | 'smaa';
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
}
```
