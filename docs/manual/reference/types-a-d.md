# Types (AcknowledgeBehaviorTrustArgs to DialogueDocument)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The declarations the ops' arguments and the JSON-valued fields name, as the source declares them (doc comments included).

<a id="type-acknowledge-behavior-trust-args"></a>
### AcknowledgeBehaviorTrustArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** `acknowledgeBehaviorTrust` args. */
interface AcknowledgeBehaviorTrustArgs {
  sourceDigest: string;
}
```

<a id="type-ambient-occlusion-kinds"></a>
### AMBIENT_OCCLUSION_KINDS

Declared in `packages/project-model/src/render-settings.ts`.

```ts
/**
 * The kinds of ambient occlusion. `ssao`: fast screen-space occlusion at half
 * resolution (what new projects are made with); `gtao`: ground-truth AO,
 * darker and more exact in creases, about twice the cost (what a project that
 * does not set the kind draws, as every project did before the setting
 * existed); `off`: none. Either darkens only the indirect light (ambient, sky
 * and probe light, and per-vertex local light, which joins it), never the
 * direct light of the sun and per-pixel lamps, and only where a scene's look
 * turns ambient occlusion on.
 */
const AMBIENT_OCCLUSION_KINDS: readonly ["off", "ssao", "gtao"];
```

<a id="type-ambient-occlusion-kind"></a>
### AmbientOcclusionKind

Declared in `packages/project-model/src/render-settings.ts`.

```ts
type AmbientOcclusionKind = (typeof AMBIENT_OCCLUSION_KINDS)[number];
```

<a id="type-animation-role-binding-value"></a>
### AnimationRoleBindingValue

Declared in `packages/commands/src/types.ts`.

```ts
/** One rigid animation role binding. */
interface AnimationRoleBindingValue {
  clipIndex: number;
  clipName: string;
}
```

<a id="type-animator-condition-ops"></a>
### ANIMATOR_CONDITION_OPS

Declared in `packages/project-model/src/animator.ts`.

```ts
const ANIMATOR_CONDITION_OPS: readonly ["greater", "less", "equals", "notEquals", "true", "false", "trigger"];
```

<a id="type-animator-parameter-types"></a>
### ANIMATOR_PARAMETER_TYPES

Declared in `packages/project-model/src/animator.ts`.

```ts
const ANIMATOR_PARAMETER_TYPES: readonly ["float", "int", "bool", "trigger"];
```

<a id="type-animator-blend-child"></a>
### AnimatorBlendChild

Declared in `packages/project-model/src/animator.ts`.

```ts
/** One clip of a 1D blend tree. */
interface AnimatorBlendChild {
  threshold: number;
  clip: AnimatorClipRef;
  /**
   * The ground speed (m/s) the clip was authored for. The tree matches its
   * parameter only when every child has one (a tree being filled in clip by
   * clip plays as authored until then).
   */
  speed?: number;
  position?: [number, number];
}
```

<a id="type-animator-clip-ref"></a>
### AnimatorClipRef

Declared in `packages/project-model/src/animator.ts`.

```ts
interface AnimatorClipRef {
  assetId: string;
  clip: string;
  /** Seconds (the clip's length in the file). */
  duration: number;
}
```

<a id="type-animator-condition"></a>
### AnimatorCondition

Declared in `packages/project-model/src/animator.ts`.

```ts
interface AnimatorCondition {
  parameter: string;
  op: AnimatorConditionOp;
  value?: number;
}
```

<a id="type-animator-condition-op"></a>
### AnimatorConditionOp

Declared in `packages/project-model/src/animator.ts`.

```ts
type AnimatorConditionOp = (typeof ANIMATOR_CONDITION_OPS)[number];
```

<a id="type-animator-controller"></a>
### AnimatorController

Declared in `packages/project-model/src/animator.ts`.

```ts
interface AnimatorController {
  controllerId: string;
  name: string;
  parameters: AnimatorParameter[];
  /** The base layer's states, transitions and entry state. */
  states: AnimatorState[];
  transitions: AnimatorTransition[];
  entry: string;
  events: AnimatorEvent[];
  /** Override layers over the base layer (absent = the base layer only). */
  layers?: AnimatorLayer[];
  /**
   * Morph targets (blend shapes) whose weight follows a float
   * parameter, clamped to 0–1 (absent = none; scripts may set others).
   */
  morphs?: AnimatorMorphBinding[];
  /** The base layer's graph layout (editor-only). */
  layout?: AnimatorLayout;
}
```

<a id="type-animator-event"></a>
### AnimatorEvent

Declared in `packages/project-model/src/animator.ts`.

```ts
interface AnimatorEvent {
  /** The clip (by asset and name) and the time in it (seconds). */
  assetId: string;
  clip: string;
  time: number;
  name: string;
}
```

<a id="type-animator-layer"></a>
### AnimatorLayer

Declared in `packages/project-model/src/animator.ts`.

```ts
/** An override layer (drawn over the base layer and the layers before it). */
interface AnimatorLayer {
  name: string;
  /** The bone (node) names this layer drives, as the model's skeleton names them; empty = every bone. */
  mask: string[];
  /** 0–1: how much the layer replaces the layers under it on its bones. */
  weight: number;
  /** A float parameter (clamped to 0–1) the weight is multiplied by. */
  weightParameter?: string;
  states: AnimatorState[];
  transitions: AnimatorTransition[];
  entry: string;
  /** This layer's graph layout (editor-only). */
  layout?: AnimatorLayout;
}
```

<a id="type-animator-layout"></a>
### AnimatorLayout

Declared in `packages/project-model/src/animator.ts`.

```ts
/**
 * Editor-only layout of one graph of a controller (a layer's
 * state machine or a blend tree's clips) in the graph editor: where its
 * fixed nodes sit, its groups and comments, and its collapsed nodes. Optional
 * (absent = auto-layout); the game never reads it and exports drop it.
 */
interface AnimatorLayout {
  /** The Entry node's top-left (graph units). */
  entry?: [number, number];
  /** The Any State node's top-left. */
  any?: [number, number];
  /** A blend tree's Blend node's top-left. */
  output?: [number, number];
  groups?: GraphGroup[];
  comments?: GraphComment[];
  /** Ids of collapsed nodes (states, blend clips "C<i>", or "ENTRY"/"ANY"/"OUT"). */
  collapsed?: string[];
}
```

<a id="type-animator-morph-binding"></a>
### AnimatorMorphBinding

Declared in `packages/project-model/src/animator.ts`.

```ts
/** One morph target driven by a parameter. */
interface AnimatorMorphBinding {
  /** The morph target's name in the model's meshes. */
  target: string;
  /** A float parameter of the controller (its value, clamped to 0–1, is the weight). */
  parameter: string;
}
```

<a id="type-animator-motion"></a>
### AnimatorMotion

Declared in `packages/project-model/src/animator.ts`.

```ts
type AnimatorMotion =
  | { kind: 'clip'; clip: AnimatorClipRef }
  | {
      kind: 'blend1d';
      parameter: string;
      /**
       * `speed`: the ground speed (m/s) the clip was authored for. When every
       * child has one, the tree reads its parameter as a ground speed and
       * scales time so the blended speed matches it (Unity's homogeneous
       * speed): feet stay planted across the whole range, not only at the
       * thresholds. `position`: where the graph editor draws the clip
       * (editor-only).
       */
      children: AnimatorBlendChild[];
      /** The blend tree graph's layout (editor-only). */
      layout?: AnimatorLayout;
    }
  /** Override layers only: nothing plays (the layers under it show through). */
  | { kind: 'empty' };
```

<a id="type-animator-parameter"></a>
### AnimatorParameter

Declared in `packages/project-model/src/animator.ts`.

```ts
interface AnimatorParameter {
  name: string;
  type: AnimatorParameterType;
  /** Number for float/int, boolean for bool; triggers start unset. */
  default?: number | boolean;
}
```

<a id="type-animator-parameter-type"></a>
### AnimatorParameterType

Declared in `packages/project-model/src/animator.ts`.

```ts
type AnimatorParameterType = (typeof ANIMATOR_PARAMETER_TYPES)[number];
```

<a id="type-animator-state"></a>
### AnimatorState

Declared in `packages/project-model/src/animator.ts`.

```ts
interface AnimatorState {
  id: string;
  name: string;
  motion: AnimatorMotion;
  /** Playback speed (× the speed parameter when there is one). */
  speed: number;
  speedParameter?: string;
  loop: boolean;
  /** Where the editor draws the state. */
  position?: [number, number];
}
```

<a id="type-animator-transition"></a>
### AnimatorTransition

Declared in `packages/project-model/src/animator.ts`.

```ts
interface AnimatorTransition {
  /** A state id, or "*" (any state). */
  from: string;
  to: string;
  conditions: AnimatorCondition[];
  /** Crossfade in seconds. */
  duration: number;
  /** Normalized time of the source state after which the transition may fire (absent = any time). */
  exitTime?: number;
  /** "source": a newer transition from the current state may cut in during the crossfade. */
  interruption?: 'none' | 'source';
}
```

<a id="type-apply-surface-preset-args"></a>
### ApplySurfacePresetArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** `applySurfacePreset` args. */
interface ApplySurfacePresetArgs {
  entityId: string;
  preset: SurfacePresetName;
}
```

<a id="type-architecture-fill-shapes"></a>
### ARCHITECTURE_FILL_SHAPES

Declared in `packages/project-model/src/architecture.ts`.

```ts
const ARCHITECTURE_FILL_SHAPES: readonly ["flat", "coffered", "barrel", "groin", "gable", "hip", "mansard"];
```

<a id="type-architecture-roof-shapes"></a>
### ARCHITECTURE_ROOF_SHAPES

Declared in `packages/project-model/src/architecture.ts`.

```ts
const ARCHITECTURE_ROOF_SHAPES: readonly ["flat", "gable", "hip", "mansard"];
```

<a id="type-architecture-building"></a>
### ArchitectureBuilding

Declared in `packages/project-model/src/architecture.ts`.

```ts
/**
 * A building: a room outline (its footprint, drawn with the inside to the
 * right of travel) with storeys, an inside preset (`preset`), a facade
 * (`outside`), doors and windows (`openings`), stairs and floor holes, plus
 * a roof over its top storey. One definition makes the exterior and the
 * interior, so windows, doors and storey heights match on both sides. The
 * interior is made in place (absent `interior`: cut-aways show it) or in a
 * scene of its own, its doors linked to the exterior's both ways.
 */
interface ArchitectureBuilding extends ArchitectureOutline {
  /** The roof over the top storey (absent: none). */
  roof?: ArchitectureRoof;
  /** The interior is a scene of its own (absent: in place). */
  interior?: ArchitectureBuildingInterior;
  /** A room program (a `room-program` graph) splitting the footprint into rooms at load (absent: one room; outlines naming the building as theirs replace it). */
  program?: string;
  /** A furnishing set (a `furnishing-set` graph) placing props and lights in the building's rooms at load (absent: none). */
  furnishing?: string;
  /** The seed of the floor plan and the furnishing (absent: 0). */
  layoutSeed?: number;
  /** Props pinned by hand: they stay where they are when the plan or furnishing is made again (absent: none). */
  pins?: ArchitecturePin[];
}
```

<a id="type-architecture-building-interior"></a>
### ArchitectureBuildingInterior

Declared in `packages/project-model/src/architecture.ts`.

```ts
/**
 * Where a building's interior is made when it is a scene of its own: that
 * scene (not the building's) gets the interior at the building's place
 * moved by `offset`, made by the build from this definition, so its walls,
 * openings and storeys are the exterior's.
 */
interface ArchitectureBuildingInterior {
  scene: string;
  /** Metres from the building's place to its interior's (absent: none: the interior stands where the building does). */
  offset?: [number, number, number];
}
```

<a id="type-architecture-element"></a>
### ArchitectureElement

Declared in `packages/project-model/src/architecture.ts`.

```ts
type ArchitectureElement = ArchitectureSweep | ArchitectureRepeat | ArchitectureFill;
```

<a id="type-architecture-fill"></a>
### ArchitectureFill

Declared in `packages/project-model/src/architecture.ts`.

```ts
interface ArchitectureFill extends ElementBase {
  kind: 'fill';
  /** A closed path (its points' heights are averaged into the fill's base). */
  path: ArchitecturePath;
  shape: ArchitectureFillShape;
  /** The slot the surface wears. */
  slot: string;
  /** The slot beams, ridges and gable ends wear (absent: `slot`). */
  trimSlot?: string;
  /** Metres above the path the surface (a ceiling's, a vault's springing, a roof's eaves) lies (absent: 0). */
  height?: number;
  /** Metres a vault or roof rises above `height` (absent: half the span for a vault, a quarter for a roof). */
  rise?: number;
  /** Which way a flat or coffered surface faces (absent: up for flat, down for coffered and vaults; roofs face out). */
  face?: 'up' | 'down';
  /** The vault's or ridge's axis: along the longer or the shorter side (absent: long). */
  axis?: 'long' | 'short';
  /** Metres between coffer beams (absent: 1.5) and their depth (absent: 0.2). */
  cell?: number;
  depth?: number;
  /** Metres a roof's eaves reach past the path (absent: 0). */
  overhang?: number;
  /** Mansard: the lower slope's height share of the rise (absent: 0.7) and metres it steps in (absent: a sixth of the span). */
  breakRise?: number;
  inset?: number;
  /** Closed paths cut out of a flat or coffered fill (stairwells; absent: none). */
  holes?: ArchitecturePath[];
}
```

<a id="type-architecture-fill-shape"></a>
### ArchitectureFillShape

Declared in `packages/project-model/src/architecture.ts`.

```ts
type ArchitectureFillShape = (typeof ARCHITECTURE_FILL_SHAPES)[number];
```

<a id="type-architecture-floor-hole"></a>
### ArchitectureFloorHole

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** A hole in a room's floor slab (a stairwell, a shaft). */
interface ArchitectureFloorHole {
  /** The storey whose floor it is cut in (absent: 0). */
  storey?: number;
  /** A closed path (metres from the object; heights ignored). */
  path: ArchitecturePath;
}
```

<a id="type-architecture-mask"></a>
### ArchitectureMask

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** A painted world mask: soft dabs [x, z, radius, weight] in metres from the object (its value at a point: the strongest dab there). */
interface ArchitectureMask {
  points: [number, number, number, number][];
}
```

<a id="type-architecture-model-ref"></a>
### ArchitectureModelRef

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** A kit model placed by the generator (copies of it are instances). */
interface ArchitectureModelRef {
  assetId: string;
  piece?: string;
}
```

<a id="type-architecture-opening"></a>
### ArchitectureOpening

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** An opening cut through a sweep: a door, window or arch. */
interface ArchitectureOpening {
  id: string;
  /** Metres along the path to the opening's middle. */
  at: number;
  width: number;
  /** Heights (m, in the profile's up) of the opening's sill and head. */
  bottom: number;
  top: number;
  /** The slot the reveals wear (absent: `frame`). */
  reveal?: string;
  /** A profile swept round the opening on the outer face, mitred at its corners (absent: none). */
  frame?: string;
  /** Faces the frame goes on (absent: outer). */
  frameSides?: 'outer' | 'inner' | 'both';
  /** A kit model placed at the opening instead of its reveals and frame (the hole is still cut). */
  model?: ArchitectureModelRef;
  /** A room's storey the opening is in (outlines only; absent: 0, the ground storey). */
  storey?: number;
  /** A pane (glass) fills the hole, on the {@link ARCHITECTURE_PANE_MATERIAL_SLOT} material slot (absent: false). */
  pane?: boolean;
}
```

<a id="type-architecture-outline"></a>
### ArchitectureOutline

Declared in `packages/project-model/src/architecture.ts`.

```ts
/**
 * An outline drawn on the object and the preset that styles it: the preset's
 * style graph makes its elements from the outline at load (`arch-style.ts`),
 * so restyling swaps the preset and never touches the outline.
 *
 * A closed outline is a room (drawn with its inside to the right of travel):
 * its walls (the style's sweeps marked `wall`) are shared with the rooms
 * beside it, each side styled by its own room; the room may have storeys,
 * an outside preset, holes in its floors and stairs (`arch-rooms.ts`). An
 * open outline is a run: a rail, a fence, a pipe.
 */
interface ArchitectureOutline {
  /** Unique among the component's outlines; the generated elements' ids start with it. */
  id: string;
  path: ArchitecturePath;
  /** An architecture preset (a project's graph or one of the engine's starters): a room's inside. */
  preset: string;
  /** Doors, windows and arches the style's sweeps that take openings cut (their frames: the style's, unless named). */
  openings?: ArchitectureOpening[];
  /** A room's outside: the preset whose wall faces and trims dress the walls' outer side (absent: the inside preset's own). */
  outside?: string;
  /** A room's storeys, stacked (absent: 1). */
  storeys?: number;
  /** Metres from one storey's floor to the next (absent: the top of the room's walls). */
  storeyHeight?: number;
  /** Holes in the room's floors (absent: none; stairs cut their own). */
  holes?: ArchitectureFloorHole[];
  /** Stairs in the room (absent: none). */
  stairs?: ArchitectureStair[];
  /** A room of a building (its id): its walls on the footprint are the building's, and the building furnishes it (absent: none). */
  building?: string;
  /** The room's type a building's furnishing set places props by (absent: none). */
  roomType?: string;
}
```

<a id="type-architecture-override"></a>
### ArchitectureOverride

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** A segment or corner of a sweep (or a repeat's copy) made by a kit model instead. */
interface ArchitectureOverride {
  /** The element's id. */
  element: string;
  /** The path segment (point i to i+1) replaced; or */
  segment?: number;
  /** the corner at point i, replaced `reach` metres either side (absent: 0.5). */
  corner?: number;
  reach?: number;
  model: ArchitectureModelRef;
  /** A segment's model is stretched along to the segment's length (made 1 m long along +X; absent: true). */
  stretch?: boolean;
}
```

<a id="type-architecture-path"></a>
### ArchitecturePath

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** A path: points with straight segments, arcs or a smooth curve; open or closed. */
interface ArchitecturePath {
  /** Metres from the object's position. */
  points: [number, number, number][];
  /** Back from the last point to the first (absent: false). */
  closed?: boolean;
  /** Per segment (point i to i+1; closed: also last to first): an arc bulging to the right of travel when positive, the left when negative, as tan of a quarter of its angle (1 = a half circle; absent or 0: straight). */
  bulges?: number[];
  /** A smooth curve through the points (Hermite with Catmull-Rom tangents, as a spline) instead of straight segments (absent: false; bulges are then ignored). */
  curve?: boolean;
  /** Metres between samples on arcs and the curve (absent: {@link ARCHITECTURE_STEP_DEFAULT}). */
  step?: number;
  /** The offset operator: metres to the right of travel, corners mitred (absent: 0). */
  offset?: number;
  /** The chamfer operator: metres cut off each sharp corner (absent: 0). */
  chamfer?: number;
}
```

<a id="type-architecture-pin"></a>
### ArchitecturePin

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** A prop pinned in a building: a generated prop kept (same id) or one put there by hand. */
interface ArchitecturePin {
  id: string;
  model: ArchitectureModelRef;
  /** Its foot (metres from the object). */
  position: [number, number, number];
  /** Degrees about +Y turning its front (+Z) toward +X. */
  facing: number;
  /** Its footprint, width along its X and depth along its Z (metres; absent: half a metre square). */
  size?: [number, number];
}
```

<a id="type-architecture-profile"></a>
### ArchitectureProfile

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** A 2D cross-section: [across, up] metres in the path's frame, across to the right of travel. */
interface ArchitectureProfile {
  /** Faces look to the right of the direction from one point to the next (a wall drawn bottom to top faces +across). */
  points: [number, number][];
  /** The trim row slot each segment wears (one per segment; "" leaves the segment open). */
  slots: string[];
  /** Back from the last point to the first (absent: false). */
  closed?: boolean;
  /** Normals averaged at inner points, for round mouldings drawn with many points (absent: false, hard edges). */
  smooth?: boolean;
  /** The chamfer operator: metres cut off each corner (absent: 0; the far level keeps the sharp corners). */
  chamfer?: number;
  /** A closed profile swept along an open path is closed at both ends with faces of this slot (absent: open ends). */
  cap?: string;
}
```

<a id="type-architecture-repeat"></a>
### ArchitectureRepeat

Declared in `packages/project-model/src/architecture.ts`.

```ts
interface ArchitectureRepeat extends ElementBase {
  kind: 'repeat';
  path: ArchitecturePath;
  /** Metres between copies along the path. */
  spacing: number;
  /** Metres from the path's start to the first copy (absent: 0) and the last place one may stand (absent: the end). */
  start?: number;
  end?: number;
  /** Also a copy at every sharp corner of the path (absent: false). */
  corners?: boolean;
  /** Copies turn to face along the path, their +X along it (absent: true). */
  align?: boolean;
  /** [across, up] metres from the path (absent: on it). */
  offset?: [number, number];
  /** Degrees each copy turns about up past facing along (absent: 0). */
  yaw?: number;
  /** Seeded variation per copy: degrees of turn and metres of shift along, either way (absent: none). */
  jitter?: { yaw?: number; along?: number };
  /** What is repeated: elements made once in the copy's frame and stamped, or a kit model's copies. */
  piece: { elements: (ArchitectureSweep | ArchitectureFill)[] } | { model: ArchitectureModelRef };
}
```

<a id="type-architecture-roof"></a>
### ArchitectureRoof

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** A building's roof over its top storey, on its footprint. */
interface ArchitectureRoof {
  shape: ArchitectureRoofShape;
  /** The slot the roof wears (absent: {@link ARCHITECTURE_ROOF_SLOT_DEFAULT}) and its gable ends (absent: `slot`). */
  slot?: string;
  trimSlot?: string;
  /** Metres the roof rises over its eaves (absent: half the footprint's deepest inset, a quarter of a rectangle's width). */
  rise?: number;
  /** Metres the eaves reach past the walls (absent: {@link ARCHITECTURE_ROOF_OVERHANG_DEFAULT}). */
  overhang?: number;
  /** The ridge along the longer or shorter side (absent: long). */
  axis?: 'long' | 'short';
  /** Mansard: the lower slope's share of the rise and metres it steps in. */
  breakRise?: number;
  inset?: number;
}
```

<a id="type-architecture-roof-shape"></a>
### ArchitectureRoofShape

Declared in `packages/project-model/src/architecture.ts`.

```ts
type ArchitectureRoofShape = (typeof ARCHITECTURE_ROOF_SHAPES)[number];
```

<a id="type-architecture-stair"></a>
### ArchitectureStair

Declared in `packages/project-model/src/architecture.ts`.

```ts
/** A flight of stairs in a room: steps from the foot's middle to the head's (object frame), as wide as given. */
interface ArchitectureStair {
  id: string;
  /** The middle of the bottom step's front edge and of the top step's back edge (metres from the object). */
  from: [number, number, number];
  to: [number, number, number];
  width: number;
  /** How many steps (absent: the rise in steps of about {@link ARCHITECTURE_STAIR_RISER} m). */
  steps?: number;
}
```

<a id="type-architecture-sweep"></a>
### ArchitectureSweep

Declared in `packages/project-model/src/architecture.ts`.

```ts
interface ArchitectureSweep extends ElementBase {
  kind: 'sweep';
  path: ArchitecturePath;
  /** A profile name from the component's `profiles`. */
  profile: string;
  openings?: ArchitectureOpening[];
  /**
   * A room's wall (absent: false): where rooms on one outline set share a
   * wall it is made once, and on a block layer (`layer`) it blocks grid
   * walks across the cell edges it stands on and takes the layer's wall paint.
   */
  wall?: boolean;
  /** Colliders: a box under each level face of the profile (stairs, terraces) instead of the profile's bounds (absent: false). */
  stepped?: boolean;
  /** Per path segment (its index as text): the profile's slots worn along it instead (one per profile segment; absent: the profile's). */
  segmentSlots?: Record<string, string[]>;
}
```

<a id="type-asset-kind"></a>
### AssetKind

Declared in `packages/project-model/src/types-v3.ts`.

```ts
/** `audio`: any Ogg Vorbis/Opus, MP3, WAV or FLAC file (`audio-assets.ts`). */
type AssetKind = 'model' | 'audio' | 'texture' | 'font';
```

<a id="type-asset-metrics"></a>
### AssetMetrics

Declared in `packages/project-model/src/types-v2.ts`.

```ts
/** The bounded decoded-resource metrics. */
interface AssetMetrics {
  nodes: number;
  meshes: number;
  primitives: number;
  materials: number;
  images: number;
  textures: number;
  vertices: number;
  triangles: number;
  animations: number;
  animationChannels: number;
  clipDurationMs: number;
  decodedGeometryBytes: number;
  decodedImageBytes: number;
  /**
   * The axis-aligned box of the model's vertices in its own space
   * (metres, node transforms applied), recorded at import; absent for
   * versions imported before.
   */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}
```

<a id="type-audio-recipe"></a>
### AudioRecipe

Declared in `packages/project-model/src/audio-assets.ts`.

```ts
interface AudioRecipe {
  profile: 'audio';
  recipeVersion: 1;
  toolchain: Record<string, string>;
}
```

<a id="type-block-connect-pieces"></a>
### BLOCK_CONNECT_PIECES

Declared in `packages/project-model/src/block-connect.ts`.

```ts
/** The pieces a connected type can name. */
const BLOCK_CONNECT_PIECES: readonly ["single", "end", "straight", "corner", "t", "cross", "base", "cap"];
```

<a id="type-block-cell"></a>
### BlockCell

Declared in `packages/project-model/src/block-layers.ts`.

```ts
/** One cell's value. At least one of `block` / `meta`. */
interface BlockCell {
  /** The block type (`content.blockTypes[].blockId`); absent = a metadata-only cell. */
  block?: string;
  /** Degrees about +Y (counter-clockwise seen from above): 90, 180 or 270; absent = 0. */
  rot?: 90 | 180 | 270;
  /** The variant index; absent = picked from the weights by the cell coordinates. */
  variant?: number;
  /**
   * The heights of the block's top corners — −x−z, +x−z, +x+z, −x+z in the
   * layer's axes, whatever the rotation — in cell heights above the cell's
   * bottom, 0–4 in steps of 1/64 (absent: a flat full top, all 1). A
   * single-cell `full` block only: sloped terrain. Above 1, so a slope that
   * crosses row boundaries inside one column stays one smooth surface (the
   * cell reaches into the cells above it, which then stay empty). The top is
   * two triangles split along one diagonal (`splitsMainDiagonal`); the sides
   * follow the corners.
   */
  corners?: [number, number, number, number];
  /** Metadata overrides (field key → value); the block's defaults and the schema's fill the rest. */
  meta?: Record<string, CellMetaValue>;
}
```

<a id="type-block-connect"></a>
### BlockConnect

Declared in `packages/project-model/src/block-connect.ts`.

```ts
/** A block type's connection rules. */
interface BlockConnect {
  /** Other block types of the same placement that count as connected (the type itself always does). */
  with?: string[];
  /** The look per piece; a piece not named keeps the ordinary look. */
  pieces: Partial<Record<BlockConnectPiece, BlockConnectLook>>;
}
```

<a id="type-block-connect-look"></a>
### BlockConnectLook

Declared in `packages/project-model/src/block-connect.ts`.

```ts
/** One piece's look: a variant of the type, turned a further `rot` degrees (an edge piece: 0 or 180). */
interface BlockConnectLook {
  variant: number;
  rot?: number;
}
```

<a id="type-block-connect-piece"></a>
### BlockConnectPiece

Declared in `packages/project-model/src/block-connect.ts`.

```ts
type BlockConnectPiece = (typeof BLOCK_CONNECT_PIECES)[number];
```

<a id="type-block-edge"></a>
### BlockEdge

Declared in `packages/project-model/src/block-edges.ts`.

```ts
/** One edge piece. */
interface BlockEdge {
  /** The edge block type (`placement: 'edge'`). */
  block: string;
  /** 180: it faces the other way (−x or −z); absent: +x for an x-line edge, +z for a z-line one. */
  rot?: 180;
  /** The look (variant index); absent: picked from the weights by the edge's place. */
  variant?: number;
  /** Open (a door): it lets passage through and has no collider. Absent: closed; stored only when true. */
  open?: boolean;
}
```

<a id="type-block-edit"></a>
### BlockEdit

Declared in `packages/project-model/src/block-grid.ts`.

```ts
/** One bulk edit of `editBlocks` (boxes are `[x0, y0, z0, x1, y1, z1]`, max exclusive). */
type BlockEdit =
  /** Set every cell of a box (`cell: null` erases); `keep`: only empty cells; `replace`: only occupied cells. */
  | { kind: 'fill'; box: number[]; cell: BlockCell | null; mode?: 'set' | 'keep' | 'replace' }
  /** Set listed cells (`at` = x, y, z, x, y, z, …). */
  | { kind: 'cells'; at: number[]; cell: BlockCell | null }
  /**
   * Set cells from an array: `size` cells from `origin`, x fastest, then z,
   * then y; `data` = run-length pairs [count, index, …] into `palette`
   * (null entries erase; index −1 leaves a cell as it is).
   */
  | { kind: 'array'; origin: number[]; size: number[]; palette: (BlockCell | null)[]; data: number[]; edgePalette?: BlockEdge[]; edges?: number[][] }
  /** Replace the block of every cell matching `match` (metadata overrides kept); in `box` or the whole layer. */
  | { kind: 'replace'; match: { block: string | null; rot?: BlockRotation; variant?: number }; cell: BlockCell | null; box?: number[] }
  /** Paint metadata: set (or remove with null) fields on cells of `box` / `at`; empty cells become metadata-only cells unless `occupiedOnly`. */
  | { kind: 'meta'; set: Record<string, CellMetaValue | null>; box?: number[]; at?: number[]; occupiedOnly?: boolean }
  /** Flood fill from `at`: the connected cells equal to it (4-connected in its xz plane, or 6-connected with `xyz`). */
  | { kind: 'flood'; at: number[]; cell: BlockCell | null; connectivity?: 'xz' | 'xyz' }
  /** Raise (delta > 0: add `cell`, default a copy of the top block) or lower (delta < 0: remove top blocks) columns (`at` = x, z, …). */
  | { kind: 'column'; at: number[]; delta: number; cell?: BlockCell }
  /** Place a stamp with its min corner at `at` (turned, mirrored); `keep`: only into empty cells. */
  | { kind: 'stamp'; stampId: string; at: number[]; rot?: BlockRotation; mirror?: 'x' | 'z'; mode?: 'set' | 'keep' }
  /** Copy (or move) the cells of `box` so its min corner lands at `to`, turned and mirrored about the box. */
  | { kind: 'copy'; box: number[]; to: number[]; rot?: BlockRotation; mirror?: 'x' | 'z'; move?: boolean; mode?: 'set' | 'keep' }
  /** Region CRUD: set / add / remove (subtract) boxes, delete, or rename to `to`. */
  | { kind: 'region'; regionId: string; op: 'set' | 'add' | 'remove' | 'delete' | 'rename'; boxes?: number[][]; to?: string }
  /**
   * Import a heightmap: a greyscale PNG (base64) sets column heights from
   * `origin` (x, z; image x → +x, image rows → +z): `round(value / 255 ×
   * scale)` cells of `cell` from `y` up (above cleared unless `keepAbove`).
   * An optional colour PNG of the same size picks each column's cell by the
   * nearest colour of `colors.map`.
   */
  | { kind: 'heightmap'; png: string; origin: number[]; y: number; scale: number; cell: BlockCell; keepAbove?: boolean; colors?: { png: string; map: { color: string; cell: BlockCell }[] } }
  /**
   * Set column top surfaces: `columns` = x, z, then the four corner heights
   * (−x−z, +x−z, +x+z, −x+z) in rows of the layer (3.25: a quarter cell over
   * row 3's bottom), per column. The column grows (with `cell`, else its top
   * block) or shrinks to it; its top cell holds the corners.
   */
  | { kind: 'surface'; columns: number[]; cell?: BlockCell }
  /**
   * A terrain brush dab: raise, lower, smooth or flatten (to `height`, rows)
   * the column tops under a round brush at `at` (x, z in columns; vertices at
   * whole numbers) of `radius` cells; `strength` is cells at the centre
   * (raise/lower) or the blend toward the target (smooth/flatten, 0-1).
   * Empty columns grow only with `cell`.
   */
  | { kind: 'sculpt'; op: SculptOp; at: number[]; radius: number; strength: number; height?: number; cell?: BlockCell }
  /**
   * A paint brush dab on the layer's surface paint: `channel`
   * 0-3 paints that material layer (its weight grows, the others give way),
   * 4 the wetness; `erase` takes it away. At `at` (x, z in columns;
   * lattice vertices at whole numbers), `radius` cells, `strength` the blend
   * toward the target per dab at the centre (0-1], `falloff` smooth (default),
   * linear or constant. Only chunks holding cells are painted. `target`
   * walls (or both) paints the wall points (`block-wall-paint.ts`) within the
   * radius of the point (`at`, `y` rows) by distance in metres.
   */
  | { kind: 'paint'; at: number[]; radius: number; strength: number; channel: number; falloff?: BrushFalloff; erase?: boolean; target?: PaintTarget; y?: number }
  /** Edge pieces (`block-edges.ts`): set (or remove with null) the edges at `at` (x, y, z, axis, …) or on and inside `box`; `keep`: only where none stands. */
  | EdgesEdit
  /**
   * A scatter brush stroke (`scatter.ts`): put scatter rule `rule`'s copies
   * on the tops under dabs `at` (x, z, x, z, … in columns) of `radius`
   * cells, or take them off (`erase`). Applied with the layer's scatter
   * after the other edits (`block-scatter.ts`).
   */
  | { kind: 'scatter'; rule: string; at: number[]; radius: number; erase?: boolean }
  /** Bake the layer's scatter rules into every chunk again (after a change of the rules). */
  | { kind: 'bakeScatter' };
```

<a id="type-block-kit-swap"></a>
### BlockKitSwap

Declared in `packages/project-model/src/block-kit.ts`.

```ts
/** What a block type shows under one kit. */
interface BlockKitSwap {
  /** The block type drawn instead (the same placement and footprint). */
  block: string;
  /** The look it shows (absent: the cell's own look when the target has it, else one picked by the target's weights). */
  variant?: number;
  /** Per look of this type (index: the cell's variant, or the one its weights pick): the target's look shown. Wins over `variant`. */
  variants?: number[];
}
```

<a id="type-block-placement"></a>
### BlockPlacement

Declared in `packages/project-model/src/block-edges.ts`.

```ts
/** Where a block type goes: in a cell (absent) or on a cell edge. */
type BlockPlacement = 'cell' | 'edge';
```

<a id="type-block-rotation"></a>
### BlockRotation

Declared in `packages/project-model/src/block-grid.ts`.

```ts
type BlockRotation = 0 | 90 | 180 | 270;
```

<a id="type-block-shape"></a>
### BlockShape

Declared in `packages/project-model/src/block-layers.ts`.

```ts
type BlockShape = 'full' | 'half' | 'ramp' | 'stairs' | 'custom' | 'none';
```

<a id="type-block-stamp"></a>
### BlockStamp

Declared in `packages/project-model/src/block-layers.ts`.

```ts
/** A saved pattern of cells (relative to its min corner). */
interface BlockStamp {
  stampId: string;
  name: string;
  size: [number, number, number];
  palette: BlockCell[];
  /** `[x, z, y0, n0, p0, …]` runs, as a chunk's columns (coordinates within `size`). */
  columns: number[][];
  /** Its edge pieces' values (`block-edges.ts`); present with `edges`. */
  edgePalette?: BlockEdge[];
  /** Its edge pieces: `[x, z, y, axis, p]` rows within `size` (its outline included); absent: none. */
  edges?: number[][];
}
```

<a id="type-block-type"></a>
### BlockType

Declared in `packages/project-model/src/block-layers.ts`.

```ts
interface BlockType {
  blockId: string;
  name: string;
  variants: BlockVariant[];
  /** The collision shape (and the stand-in's shape). */
  shape: BlockShape;
  /** `custom`: boxes in footprint units `[x0, y0, z0, x1, y1, z1]` within [0, 1]. */
  boxes?: number[][];
  /** Fills its cell and hides the faces of neighbours touching it (absent: shape is `full`). */
  solid?: boolean;
  /** Cells along x, y, z (absent: [1, 1, 1]). */
  footprint?: [number, number, number];
  /** Allowed rotations in degrees (absent: all four). */
  rotations?: number[];
  /** Default cell metadata. */
  metadata?: Record<string, CellMetaValue>;
  /** Model material mapping (source material name or "*" → materialId). */
  materials?: Record<string, string>;
  /** Its looks' texture coordinates (absent: `model`; stored only when `world`); a variant may set its own. */
  uv?: BlockUvMode;
  /**
   * Its prefab looks spawn the prefab as a live entity per cell while the
   * game runs (`block-live.ts`); absent: the prefab's model is drawn only.
   * Stored only when true.
   */
  live?: boolean;
  /** `edge`: it stands on cell edges (walls, doors, fences; `block-edges.ts`); absent: it fills cells. Stored only when `edge`. */
  placement?: BlockPlacement;
  /** An edge piece blocks passage across its edge (absent: true; stored only when false). An open edge never does. */
  blocking?: boolean;
  /** Connection rules: the look follows the neighbours (straight, corner, T, cross, end, base, cap; `block-connect.ts`); absent: none. */
  connect?: BlockConnect;
  /** What it shows under each kit (kit name → the block type drawn instead, and the look; `block-kit.ts`); absent: none. */
  kits?: Record<string, BlockKitSwap>;
}
```

<a id="type-block-uv-mode"></a>
### BlockUvMode

Declared in `packages/project-model/src/block-layers.ts`.

```ts
/**
 * Where a block look's texture coordinates come from: `model`, the look's
 * own (a stand-in, or a model piece without any, takes world ones); `world`,
 * generated from the cell's position in the layer, in metres, so a texture
 * runs on across cells without a seam (box mapping: one planar projection
 * per face).
 */
type BlockUvMode = 'model' | 'world';
```

<a id="type-block-variant"></a>
### BlockVariant

Declared in `packages/project-model/src/block-layers.ts`.

```ts
/** One look of a block: a model (asset, optional piece), a prefab's model, or a coloured stand-in shaped like the collision shape. */
interface BlockVariant {
  model?: { assetId: string; piece?: string };
  prefab?: string;
  /** The stand-in's colour (no model/prefab) — "#rrggbb". */
  color?: string;
  /** Relative weight when the cell names no variant (absent: 1). */
  weight?: number;
  /** This look's texture coordinates (absent: the block type's). */
  uv?: BlockUvMode;
}
```

<a id="type-box-args"></a>
### BoxArgs

Declared in `packages/commands/src/entity-types.ts`.

```ts
/** Box args for createEntity: only when `kind` is `"box"`. */
interface BoxArgs {
  size?: readonly number[];
  material?: { color?: string };
}
```

<a id="type-brush-falloff"></a>
### BrushFalloff

Declared in `packages/project-model/src/paint-brush.ts`.

```ts
/**
 * The paint brush — radius, strength, falloff and the target
 * channel — as its own module, so every paint target uses the same brush: a
 * block layer's paint and wetness today (`block-paint.ts`), mesh vertex
 * colours later.
 *
 * A target is a set of points, each holding `channels` bytes (0–255). The
 * first `weights` channels are layer weights that always sum to 255 (painting
 * one moves weight from the others onto it; erasing one gives its weight back
 * to the others); any further channel stands alone (wetness: painting raises
 * it toward 255, erasing lowers it toward 0). A dab changes every point
 * within the radius by `strength × falloff(distance)` of the way to its
 * target.
 *
 * Squared distances only, no trigonometry, results rounded to bytes: the
 * same dabs give the same bytes in every JavaScript engine (the editor's
 * preview and the backend's edit agree).
 */
type BrushFalloff = 'smooth' | 'linear' | 'constant';
```

<a id="type-brush-vec3"></a>
### BrushVec3

Declared in `packages/project-model/src/instance-brush.ts`.

```ts
type BrushVec3 = [number, number, number];
```

<a id="type-cell-field"></a>
### CellField

Declared in `packages/project-model/src/block-layers.ts`.

```ts
interface CellField {
  key: string;
  type: CellFieldType;
  /** Absent: false / the first enum value / 0 / "". */
  default?: CellMetaValue;
  /** enum only: the values. */
  values?: string[];
  /** int/float: the range. */
  min?: number;
  max?: number;
  /** The overlay colour the editor paints the field with ("#rrggbb"). */
  color?: string;
  label?: string;
}
```

<a id="type-cell-field-type"></a>
### CellFieldType

Declared in `packages/project-model/src/block-layers.ts`.

```ts
type CellFieldType = 'bool' | 'enum' | 'int' | 'float' | 'string';
```

<a id="type-cell-meta-value"></a>
### CellMetaValue

Declared in `packages/project-model/src/block-layers.ts`.

```ts
/** A metadata value: bool, number (int/float) or string. */
type CellMetaValue = boolean | number | string;
```

<a id="type-collider-from-model-args"></a>
### ColliderFromModelArgs

Declared in `packages/commands/src/collider-model-ops.ts`.

```ts
/** `colliderFromModel` args: the object and what to make. */
interface ColliderFromModelArgs {
  entityId: string;
  kind: ModelColliderKind;
}
```

<a id="type-converted-from"></a>
### ConvertedFrom

Declared in `packages/project-model/src/types-v2.ts`.

```ts
/** The original a converted asset version was made from. */
type ConvertedFrom =
  | {
      format: 'fbx';
      sourceDigest: string;
      sourceByteLength: number;
      sourcePath?: string;
      converter: { name: 'blender'; version: string };
    }
  | {
      /**
       * A GLB converted at import: its images extracted into texture assets
       * (the model's `textures` names them; the stored GLB has a one-pixel
       * stand-in for each), and/or levels of detail generated (`lods`).
       */
      format: 'glb';
      sourceDigest: string;
      sourceByteLength: number;
      sourcePath?: string;
      converter: { name: 'texture-extract'; version: string };
      /**
       * The triangle shares levels 1… were generated at by the mesh
       * simplifier (the "generate LODs" import setting; absent: none were). A
       * re-import of the file generates them again.
       */
      lods?: number[];
    }
  | {
      /** A PNG, JPEG or WebP texture encoded to KTX2 at import. */
      format: 'png' | 'jpeg' | 'webp';
      sourceDigest: string;
      sourceByteLength: number;
      sourcePath?: string;
      converter: { name: 'ktx2-encoder'; version: string };
      /** color: ETC1S, sRGB; normal: UASTC, linear, normal-map mips; data: UASTC, linear. */
      encoding: 'color' | 'normal' | 'data';
    };
```

<a id="type-create-entity-args"></a>
### CreateEntityArgs

Declared in `packages/commands/src/entity-types.ts`.

```ts
interface CreateEntityArgs {
  /** `folder`: organisation only — no transform, box, model or components. */
  kind: 'group' | 'box' | 'model' | 'folder';
  parentId?: string | null;
  name?: string;
  /** The entity flags and tags, as `updateEntity` sets them (absent: active, visible, unlocked, not static, not kept loaded, no tags). */
  active?: boolean;
  visible?: boolean;
  locked?: boolean;
  static?: boolean;
  keepLoaded?: boolean;
  /** Tag names of the project's registry. */
  tags?: string[];
  transform?: PartialTransformArgs;
  /** Only when `kind` is `"box"`. */
  box?: BoxArgs;
  /** Only when `kind` is `"model"` (required then). */
  model?: ModelArgs;
  /**
   * The add-capable components created in the same transaction:
   * `collider`, `controller`, `playerSpawn`, `light`, `surface`,
   * `modelAnimation`; never `null`.
   */
  components?: Record<string, unknown>;
  /** Copies a built-in preset row onto `components.surface`. */
  surfacePreset?: SurfacePresetName;
  /**
   * `folder` only: objects created inside the new folder in the same
   * transaction (one undo), e.g. every piece of a multi-piece model. Each is
   * a `box`/`model`/`group` create without `parentId` or `children`.
   */
  children?: CreateEntityArgs[];
}
```

<a id="type-create-folder-args"></a>
### CreateFolderArgs

Declared in `packages/commands/src/move-ops.ts`.

```ts
/** `createFolder` args: the folder to make (its parents are made too). */
interface CreateFolderArgs {
  folder: string;
}
```

<a id="type-create-prefab-args"></a>
### CreatePrefabArgs

Declared in `packages/commands/src/types.ts`.

```ts
/** `createPrefab` args. */
interface CreatePrefabArgs {
  /** ID syntax; not already in `content.prefabs`. */
  prefabId: string;
  /** 1–128 chars, no control characters. */
  displayName: string;
  /** Existing entity ID in the current scene. */
  sourceEntityId: string;
}
```

<a id="type-cursor-mode"></a>
### CursorMode

Declared in `packages/project-model/src/input.ts`.

```ts
/** The cursor while a map is active — free (visible, moves) or locked (hidden, held in the view; the movement still counts). */
type CursorMode = 'free' | 'locked';
```

<a id="type-declared-property"></a>
### DeclaredProperty

Declared in `packages/project-model/src/types-v2.ts`.

```ts
interface DeclaredProperty {
  key: string;
  label: string;
  type: PropertyType;
  default: PropertyValue;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  values?: string[];
  bounds?: PropertyBounds;
  /**
   * Who may see and set the property. `public` (the default; the
   * canonical form omits it) is shown in the Inspector of every object
   * carrying the behavior and overridable per object; `private` is neither
   * shown nor overridable — the script always reads `default`.
   */
  visibility?: PropertyVisibility;
  /** The Inspector section the property is listed in (1–64 characters). */
  group?: string;
  /** A heading shown above the property in the Inspector (1–64 characters). */
  header?: string;
  /** The hover help of the property's field (1–256 characters). */
  tooltip?: string;
}
```

<a id="type-delete-entity-args"></a>
### DeleteEntityArgs

Declared in `packages/commands/src/types.ts`.

```ts
interface DeleteEntityArgs {
  entityId: string;
}
```

<a id="type-dialogue-document"></a>
### DialogueDocument

Declared in `packages/project-model/src/dialogue.ts`.

```ts
interface DialogueDocument {
  dialogueId: string;
  name: string;
  graph: GraphData;
}
```
