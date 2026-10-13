# Types (UiTheme to WindConfig)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The declarations the ops' arguments and the JSON-valued fields name, as the source declares them (doc comments included).

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

<a id="type-v3-owned-component"></a>
### V3OwnedComponent

Declared in `packages/commands/src/types.ts`.

```ts
/**
 * The six v3 add-capable components.
 * `playerSpawn` is a field-less marker; the rest are partial-replaceable.
 */
type V3OwnedComponent =
  | 'playerSpawn'
  | 'light'
  | 'surface'
  | 'modelAnimation'
  /** v4 scenes only: an instance set. */
  | 'instances'
  /** v4 scenes only: the object's material mapping. */
  | 'materials'
  /** v4 scenes only: a fog volume. */
  | 'fogVolume'
  /** v4 scenes only: a grid of blocks. */
  | 'blockLayer'
  /** v4 scenes only: the metadata a prop writes into the block cells beneath it. */
  | 'blockFootprint'
  /** v4 scenes only: an animator controller on a model. */
  | 'animator'
  /** v4 scenes only: gameplay building blocks. */
  | 'mover'
  | 'trigger'
  | 'switch'
  | 'health'
  | 'audioSource'
  | 'faceMovement'
  /** v4 scenes only: overrides of graph-material parameters. */
  | 'materialParams'
  /** v4 scenes only: a visual effect played from the entity. */
  | 'effect'
  /** v4 scenes only: a virtual camera shot and a camera path. */
  | 'virtualCamera'
  | 'cameraPath'
  /** v4 scenes only: rides on a node of another entity's model. */
  | 'socketAttach'
  /** v4 scenes only: the behavior group the entity's behavior belongs to. */
  | 'behaviorGroup'
  /** v4 scenes only: generic primitives. */
  | 'collectible'
  | 'patrol'
  | 'hitbox'
  /** v4 scenes only: a climb volume and a gravity body. */
  | 'climbVolume'
  | 'gravity'
  /** v4 scenes only: a camera region. */
  | 'cameraRegion'
  /** v4 scenes only: a box the probe bake fills with probes. */
  | 'probeVolume'
  /** v4 scenes only: a heightfield of tiles. */
  | 'terrain'
  /** v4 scenes only: a curve through points (roads, rivers, rails). */
  | 'spline'
  /** v4 scenes only: generated architecture (parameters; geometry made at load). */
  | 'architecture'
  /** v4 scenes only: a decal (a projector box; a clipped one's mesh is made at load). */
  | 'decal'
  /** v4 scenes only: vertex paint on a model's meshes or a generated mesh's paths (written by paintVertices). */
  | 'vertexPaint';
```

<a id="type-vec3"></a>
### Vec3

Declared in `packages/project-model/src/types.ts`.

```ts
/** Three finite numbers (meters), in canonical order. */
type Vec3 = [number, number, number];
```

<a id="type-vertex-paint-brush"></a>
### VertexPaintBrush

Declared in `packages/project-model/src/vertex-paint-stroke.ts`.

```ts
interface VertexPaintBrush {
  /** Metres in the world. */
  radius: number;
  /** How far toward full (or, erasing, toward 0) one dab moves a vertex at its centre, (0, 1]. */
  strength: number;
  /** smooth (absent), linear or constant (`paint-brush.ts`). */
  falloff?: BrushFalloff;
  /** 0–3: R, G, B, A. */
  channel: number;
  /**
   * More channels painted alike with `channel` (each moved by the same amount): a layered surface's base is what
   * R, G and B leave, so painting it erases all three at once. Absent: `channel` alone.
   */
  channels?: number[];
  erase?: boolean;
  /** A curve falloff's share of the radius at full strength (0–0.95; absent: 0.5). */
  hardness?: number;
  /** The most of the way one stroke takes a vertex, (0, 1] (strength is one dab's); absent: no ceiling. */
  opacity?: number;
  /** Noise a dab's weight is multiplied by, anchored to the world (seamless across objects and strokes); absent: none. */
  mask?: BrushMask;
}
```

<a id="type-vertex-paint-mesh"></a>
### VertexPaintMesh

Declared in `packages/project-model/src/vertex-paint.ts`.

```ts
/** One painted mesh: its name, what it was painted on, and its paint's blob. */
interface VertexPaintMesh {
  /** The node's path from the model's scene root and the primitive (`Body/Hull#0`). */
  mesh: string;
  /** The mesh's vertex count when painted. */
  vertices: number;
  /** The first {@link PAINT_POSITIONS_HASH_LENGTH} hex of the SHA-256 of its positions as float32 (`paintPositionsHash`). */
  positions: string;
  /** SHA-256 of the paint: 4 bytes a vertex (an instance set's: the slots' runs one after another). */
  paint: string;
}
```

<a id="type-vertex-paint-stroke"></a>
### VertexPaintStroke

Declared in `packages/project-model/src/vertex-paint-stroke.ts`.

```ts
interface VertexPaintStroke {
  dabs: PaintVec3[];
  brush: VertexPaintBrush;
  /** A model: only this mesh (absent: every mesh of the object's model, its piece's when it shows one). */
  mesh?: string;
  /** An instance set: the copy painted (its address: its place in the set's buffer). */
  copy?: number;
  /** A generated mesh: the path painted (`outline:<id>`, `building:<id>`, `element:<id>`, `spline`). */
  path?: string;
  /** With `path`: the faces painted (left or right of travel, or the faces looking up or down). */
  side?: PathPaintSide;
}
```

<a id="type-wind-config"></a>
### WindConfig

Declared in `packages/project-model/src/materials.ts`.

```ts
interface WindConfig {
  /** Horizontal direction [x, z] (normalized by the runtime; not both zero). */
  direction: [number, number];
  /** Base strength (0 = still air). */
  strength: number;
  /** Extra strength of gusts. */
  gust: number;
  /** Gusts per second. */
  gustFrequency: number;
  /** Small-scale variation over space (0-1). */
  turbulence: number;
}
```
