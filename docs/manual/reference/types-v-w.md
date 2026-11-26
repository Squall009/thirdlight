# Types (VoxelKitImage to WindOctave)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The declarations the ops' arguments and the JSON-valued fields name, as the source declares them (doc comments included).

<a id="type-voxel-kit-image"></a>
### VoxelKitImage

Declared in `packages/project-model/src/voxel-kit.ts`.

```ts
/** An image asset version: the asset and the SHA-256 of the image bytes it was made from. */
interface VoxelKitImage {
  assetId: string;
  digest: string;
}
```

<a id="type-voxel-kit-json"></a>
### VoxelKitJson

Declared in `packages/project-model/src/voxel-kit.ts`.

```ts
/** A kit's game data (opaque JSON, `game-data.ts`). */
type VoxelKitJson = GameDataJson;
```

<a id="type-voxel-kit-mesh"></a>
### VoxelKitMesh

Declared in `packages/project-model/src/voxel-kit.ts`.

```ts
/** One authored mesh: a model asset, the digest of the GLB version it was made from, optionally one node of it. */
interface VoxelKitMesh {
  assetId: string;
  /** SHA-256 (64 lowercase hex) of the GLB bytes: the asset version's source digest. */
  digest: string;
  /** The node drawn when the file holds several pieces (absent: the whole model). */
  node?: string;
}
```

<a id="type-voxel-kit-sheet-layout"></a>
### VoxelKitSheetLayout

Declared in `packages/project-model/src/voxel-trim-layout.ts`.

```ts
/**
 * A sheet layout a kit declares for its own sheet (kit field `sheetLayout`): the authored sheet's side and density
 * and its regions, as a named layout holds them.
 */
interface VoxelKitSheetLayout {
  /** Authored sheet side, pixels. */
  size: number;
  /** Authored pixels a metre. */
  pxPerMetre: number;
  regions: Array<{ id: string; kind: TrimRegion['kind']; metres: number; y: [number, number]; x?: [number, number] }>;
}
```

<a id="type-voxel-kit-slot"></a>
### VoxelKitSlot

Declared in `packages/project-model/src/voxel-kit.ts`.

```ts
/** One filled slot: its meshes, and the game's data for it. */
interface VoxelKitSlot {
  /** One or more meshes (an empty slot is not stored: leave the slot out). */
  meshes: VoxelKitSlotMesh[];
  /** The game's own data for this slot (break, sound, physics …), never read by the engine. */
  gameData?: VoxelKitJson;
}
```

<a id="type-voxel-kit-slot-mesh"></a>
### VoxelKitSlotMesh

Declared in `packages/project-model/src/voxel-kit.ts`.

```ts
/** One mesh a slot holds: the mesh, the cube rotation that turns it into the slot's case orientation, its weight among the slot's meshes. */
interface VoxelKitSlotMesh {
  mesh: VoxelKitMesh;
  /** One of the 24 cube rotations (voxel `CUBE_ROTATIONS`, a fixed numbering; absent: 0, the identity). */
  rotation?: number;
  /** Relative weight among the slot's meshes (absent: 1). */
  weight?: number;
  /**
   * Draw the mesh mirrored across its case's run (the case's x, after the rotation), winding and normal-map
   * tangents flipped with it: one mesh serves both hands of a handed piece (absent: false).
   */
  mirror?: boolean;
}
```

<a id="type-voxel-material-use"></a>
### VoxelMaterialUse

Declared in `packages/project-model/src/voxel-materials.ts`.

```ts
type VoxelMaterialUse = (typeof VOXEL_MATERIAL_USES)[number];
```

<a id="type-voxel-surface"></a>
### VoxelSurface

Declared in `packages/project-model/src/voxel-materials.ts`.

```ts
type VoxelSurface = (typeof VOXEL_SURFACES)[number];
```

<a id="type-voxel-texture-map"></a>
### VoxelTextureMap

Declared in `packages/project-model/src/voxel-materials.ts`.

```ts
type VoxelTextureMap = (typeof VOXEL_TEXTURE_MAPS)[number];
```

<a id="type-voxel-texture-set"></a>
### VoxelTextureSet

Declared in `packages/project-model/src/voxel-materials.ts`.

```ts
/** One texture set: a texture asset per map (a map left out: the engine's flat stand-in). */
type VoxelTextureSet = Partial<Record<VoxelTextureMap, string>>;
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
  /** The gust pattern: a texture asset read top-down over the world, its red channel 0–1 (absent: the engine's neutral noise). Global only. */
  noise?: string;
  /** Metres per second the gust pattern travels along the direction (absent: `gustFrequency` × `scale`, so as many gusts pass a point a second as before). */
  speed?: number;
  /** Metres the gust pattern spans before it repeats (absent: {@link WIND_DEFAULTS}). */
  scale?: number;
  /** A second, finer layer of the pattern so it does not visibly repeat: its size and speed as shares of the first (absent: {@link WIND_DEFAULTS}). Global only. */
  octave?: WindOctave;
}
```

<a id="type-wind-octave"></a>
### WindOctave

Declared in `packages/project-model/src/materials.ts`.

```ts
interface WindOctave {
  /** Its size as a share of `scale`. */
  scale: number;
  /** Its speed as a share of `speed`. */
  speed: number;
}
```
