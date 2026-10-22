# Script API types (from `DebugCommandArgType`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.

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
