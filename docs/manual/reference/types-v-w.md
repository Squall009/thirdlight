# Types (V3OwnedComponent to WindConfig)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The declarations the ops' arguments and the JSON-valued fields name, as the source declares them (doc comments included).

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
  | 'decal';
```

<a id="type-vec3"></a>
### Vec3

Declared in `packages/project-model/src/types.ts`.

```ts
/** Three finite numbers (meters), in canonical order. */
type Vec3 = [number, number, number];
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
