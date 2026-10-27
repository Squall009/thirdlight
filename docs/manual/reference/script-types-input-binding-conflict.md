# Script API types (from `InputBindingConflict`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.

<a id="script-type-input-binding-conflict"></a>
## `InputBindingConflict`

```ts
/** An action binding that uses the same input as a new binding. */
export interface InputBindingConflict {
  readonly action: string;
  readonly index: number;
  readonly part?: InputBindingPart;
}
```

<a id="script-type-rebind-conflict-policy"></a>
## `RebindConflictPolicy`

```ts
/** What happens when a new binding's input is already used by another action of the same map. */
export type RebindConflictPolicy = 'swap' | 'refuse' | 'allow';
```

<a id="script-type-debug-command-arg-spec"></a>
## `DebugCommandArgSpec`

```ts
/** One declared argument of a debug command. */
export interface DebugCommandArgSpec {
  /** The argument's name (a letter or _, then letters, digits, _ . : -). */
  readonly name: string;
  readonly type: DebugCommandArgType;
  /** May be left out of a call (a call without it has no such key). */
  readonly optional?: boolean;
}
```

<a id="script-type-grid-door-side"></a>
## `GridDoorSide`

```ts
/** One side of a linked door (world metres; `facing`: degrees about +Y turning +Z toward the way out of the door on that side). */
export interface GridDoorSide {
  readonly position: readonly [number, number, number];
  readonly spawn: readonly [number, number, number];
  readonly facing: number;
}
```

<a id="script-type-block-cell"></a>
## `BlockCell`

```ts
/** One cell's value. At least one of `block` / `meta`. */
export interface BlockCell {
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

<a id="script-type-block-edge"></a>
## `BlockEdge`

```ts
/** One edge piece. */
export interface BlockEdge {
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

<a id="script-type-entity-write-code"></a>
## `EntityWriteCode`

```ts
/** Why a write was refused: the descriptor check's codes and the runtime's. */
export type EntityWriteCode =
  | ScriptWriteCode
  | 'entity_unknown'
  | 'component_missing'
  | 'entity_physics'
  | 'entity_camera'
  | 'entity_character'
  | 'entity_static'
  | 'entity_driven'
  | 'material_parameter'
  | 'material_unknown'
  | 'write_limit';
```

<a id="script-type-property-type"></a>
## `PropertyType`

```ts
export type PropertyType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'enum'
  | 'vec3'
  | 'entityRef'
  | 'assetRef';
```

<a id="script-type-property-bounds"></a>
## `PropertyBounds`

```ts
export interface PropertyBounds {
  min: Vec3;
  max: Vec3;
}
```

<a id="script-type-property-visibility"></a>
## `PropertyVisibility`

```ts
/** Declared-property visibility (Unity-like public/private). */
export type PropertyVisibility = 'public' | 'private';
```

<a id="script-type-save-storage-codes"></a>
## `SAVE_STORAGE_CODES`

```ts
/**
 * Why the player's storage refused a write, for the game's own message
 * (the browser's text is the result's `reason`): the disk or the site's
 * quota is full, the page has no storage (IndexedDB off, a private window
 * that refuses it), or any other refusal.
 */
export const SAVE_STORAGE_CODES: readonly ["storage_full", "storage_unavailable", "storage_failed"];
```

<a id="script-type-save-section"></a>
## `SaveSection`

```ts
export type SaveSection = (typeof SAVE_SECTIONS)[number];
```

<a id="script-type-world-save"></a>
## `WorldSave`

```ts
/**
 * Where the play stands in a save — the scenes loaded (in load
 * order), the spawn respawns use, the game shell's scene list entry (-1:
 * none) and the character (the controller's object) with its velocity (m/s)
 * and the way it faces (degrees about +Y, as
 * `characterState().facing` reads it; older saves have none), or null
 * without a character. With several player controllers `character` is the
 * first's and `characters` holds the others by their object (absent: a save
 * of one player, or an older one — the others stay where they are).
 */
export interface WorldSave {
  readonly scenes: readonly string[];
  readonly activeSpawn: string | null;
  readonly listedScene: number;
  readonly character: SavedCharacter | null;
  readonly characters?: Readonly<Record<string, SavedCharacter>>;
}
```

<a id="script-type-plane-axis"></a>
## `PlaneAxis`

```ts
export type PlaneAxis = (typeof PLANE_AXES)[number];
```

<a id="script-type-input-binding-device"></a>
## `InputBindingDevice`

```ts
/** Where a binding comes from. */
export type InputBindingDevice = 'keyboard' | 'mouse' | 'gamepad';
```

<a id="script-type-debug-command-arg-type"></a>
## `DebugCommandArgType`

```ts
/** The type of a debug command argument. */
export type DebugCommandArgType = 'number' | 'string' | 'boolean';
```

<a id="script-type-cell-meta-value"></a>
## `CellMetaValue`

```ts
/** A metadata value: bool, number (int/float) or string. */
export type CellMetaValue = boolean | number | string;
```

<a id="script-type-script-write-code"></a>
## `ScriptWriteCode`

```ts
/** Why a write was refused (the runtime adds its own: see runtime `EntityWriteCode`). */
export type ScriptWriteCode = 'component_unknown' | 'patch_invalid' | 'field_unknown' | 'field_not_writable' | 'field_not_applicable' | 'field_value';
```

<a id="script-type-vec3"></a>
## `Vec3`

```ts
/** Three finite numbers (meters), in canonical order. */
export type Vec3 = [number, number, number];
```

<a id="script-type-save-sections"></a>
## `SAVE_SECTIONS`

```ts
export const SAVE_SECTIONS: readonly ["grid", "materials", "spawned", "storage", "environment", "dialogue", "components", "world"];
```

<a id="script-type-saved-character"></a>
## `SavedCharacter`

```ts
/** A player controller's place in a save: position, velocity (m/s) and, in 3D, its facing (degrees). */
export interface SavedCharacter {
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  readonly facing?: number;
}
```

<a id="script-type-plane-axes"></a>
## `PLANE_AXES`

```ts
/** The world axes a plane's normal may lie along (Y is "up", so a plane through it would be a floor). */
export const PLANE_AXES: readonly ["x", "z"];
```
