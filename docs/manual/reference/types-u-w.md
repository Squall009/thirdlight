# Types (UpdateEntityArgs to WindConfig)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The declarations the ops' arguments and the JSON-valued fields name, as the source declares them (doc comments included).

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
  erase?: boolean;
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
