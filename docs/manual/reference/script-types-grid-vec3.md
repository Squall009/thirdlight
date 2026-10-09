# Script API types (from `GridVec3`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every declaration the script API reaches, as the runtime declares it (doc comments included), in the order the API reaches them.

<a id="script-type-grid-vec3"></a>
## `GridVec3`

```ts
/** A position or direction in world space (metres). */
export interface GridVec3 {
  x: number;
  y: number;
  z: number;
}
```

<a id="script-type-grid-pick"></a>
## `GridPick`

```ts
/** A ray pick's result. */
export interface GridPick {
  readonly layer: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The face the ray entered through (a unit axis vector). */
  readonly normal: GridVec3;
  /** Metres along the ray. */
  readonly distance: number;
  readonly point: GridVec3;
}
```

<a id="script-type-grid-walk-options"></a>
## `GridWalkOptions`

```ts
/** Options of the walk queries; absent fields take the layer's `walk`, then the engine's defaults. */
export interface GridWalkOptions {
  /** How far a step may rise (m). */
  maxStep?: number;
  /** How far a step may drop (m). */
  maxDrop?: number;
  /** The free height a place needs above it (m). */
  headroom?: number;
  /** The steepest top that can be stood on (degrees; absent: the layer's maxSlope, else the project's). */
  maxSlope?: number;
  /** Steps across cell corners too (both ways round the corner walkable). */
  diagonal?: boolean;
  /** A boolean cell field: only tops whose cell has it true are walked (absent: the layer's walk field, else every top). */
  field?: string;
  /** A number cell field: entering a place costs its cell's value per metre (absent: 1 per metre); 0 or less: it cannot be entered. */
  costField?: string;
  /**
   * Cells that cannot be entered (places other units stand on), as [x, y, z] each; a start is never avoided.
   * @graphType list
   */
  avoid?: readonly (readonly number[])[];
}
```

<a id="script-type-grid-walk-place"></a>
## `GridWalkPlace`

```ts
/** A place on a walk: the cell whose top it is, the point on that top at the cell's centre, and the cost to it (m, times any cost field). */
export interface GridWalkPlace {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly point: { readonly x: number; readonly y: number; readonly z: number };
  readonly cost: number;
}
```

<a id="script-type-grid-walk-path-outcome"></a>
## `GridWalkPathOutcome`

```ts
/**
 * Why a walk path query answered as it did: `found`; `none`, no walk joins
 * the two places; `limit`, the search passed its place limit first (a path
 * may still exist: a null path alone cannot tell the two apart); `invalid`,
 * a layer, cell or option that does not fit, or no place at a cell.
 */
export type GridWalkPathOutcome = 'found' | 'none' | 'limit' | 'invalid';
```

<a id="script-type-grid-door-link"></a>
## `GridDoorLink`

```ts
/** A door of a building whose interior is a scene of its own, from one side (`ctx.grid.doorLinks`). */
export interface GridDoorLink extends GridDoorSide {
  /** `<building>/<door>`: the same on both sides. */
  readonly id: string;
  readonly building: string;
  readonly door: string;
  /** The object this side is drawn on, and its scene (null: none known). */
  readonly entity: string;
  readonly scene: string | null;
  readonly side: 'outside' | 'inside';
  /** The other side: the scene it is in, its door and where one arriving through it stands. */
  readonly to: GridDoorSide & { readonly scene: string };
}
```

<a id="script-type-grid-edge"></a>
## `GridEdge`

```ts
/** An edge piece as scripts read it (`ctx.grid.edge`): a wall, door or fence on a cell's side. */
export interface GridEdge {
  readonly block: string;
  /** 0, or 180: it faces the other way (a connected piece: the way its ends resolve). */
  readonly rot: number;
  /** The look shown (an unset one resolved from the weights and the place, or a connected piece). */
  readonly variant: number;
  /** A connected piece's piece (single, end, straight, corner, base, cap); absent: not connected or no rule for it. */
  readonly piece?: string;
  /** The edge piece a kit draws in its place (rot, variant, piece and blocked are that piece's); absent: no kit swaps it. */
  readonly kitBlock?: string;
  /** Open (a door). */
  readonly open: boolean;
  /** Whether it blocks passage across the edge now (its type blocks, and it is not open). */
  readonly blocked: boolean;
}
```

<a id="script-type-grid-edge-input"></a>
## `GridEdgeInput`

```ts
/** What `ctx.grid.setEdge` writes. */
export interface GridEdgeInput {
  /** An edge block type id. */
  block: string;
  /** 0, or 180: it faces the other way. */
  rot?: number;
  /** A variant index (absent: picked from the weights by place). */
  variant?: number;
  /** Open (a door: no passage blocked, no collider). */
  open?: boolean;
}
```

<a id="script-type-grid-change"></a>
## `GridChange`

```ts
/** One cell written by a script (`ctx.grid.changes()`). */
export interface GridChange {
  readonly layer: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The block before and after (null: none). */
  readonly before: string | null;
  readonly after: string | null;
  readonly stepIndex: number;
  /** An edge piece written: the side of the cell it stands on (absent: the cell itself). */
  readonly side?: '-x' | '-z';
}
```

<a id="script-type-grid-diff"></a>
## `GridDiff`

```ts
/** The cells scripts changed, as plain data (store it in a save, give it back with `applyDiff`). */
export interface GridDiff {
  readonly version: 1;
  readonly layers: readonly {
    readonly layer: string;
    readonly cells: readonly (readonly [number, number, number, BlockCell | null])[];
    /** Edge pieces changed: [x, y, z, axis (0: the cell's −x side, 1: its −z side), edge | null]; absent: none. */
    readonly edges?: readonly (readonly [number, number, number, number, BlockEdge | null])[];
  }[];
  /** The block types' material swaps (block id → slot → material over the type's own mapping); absent: none. */
  readonly types?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The kits scripts set (`setKit`): [layer, region (null: the whole layer), kit (null: none)]; absent: none. */
  readonly kits?: readonly (readonly [string, string | null, string | null])[];
  /** The architecture presets scripts swapped (`setArchitecturePreset`): [preset, the one shown in its place]; absent: none. */
  readonly architecturePresets?: readonly (readonly [string, string])[];
}
```

<a id="script-type-scatter-copy-info"></a>
## `ScatterCopyInfo`

```ts
/** A copy as scripts see it. */
export interface ScatterCopyInfo {
  /** Its address (what `get`, `hide`, `show` and `remove` take, and what a ray hit names). */
  readonly address: string;
  /** The terrain or block layer it stands on. */
  readonly source: string;
  readonly rule: string;
  /** Its candidate cell [ix, iz] (the rule's grid). */
  readonly cell: readonly [number, number];
  /** Where it stands (world), its turn (quaternion [x, y, z, w]) and its size (the model's times this). */
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: number;
  /** A script hid it (it is not drawn and does not collide). */
  readonly hidden: boolean;
}
```

<a id="script-type-spline-pose"></a>
## `SplinePose`

```ts
/** A place on a spline and its cross-section (world metres, unit vectors). */
export interface SplinePose {
  /** Metres along the curve from its start (wrapped on a closed curve, clamped on an open one). */
  readonly distance: number;
  readonly position: readonly [number, number, number];
  /** Along the curve. */
  readonly tangent: readonly [number, number, number];
  /** Across to the right, turned by the roll. */
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  /** Metres across, and degrees of roll. */
  readonly width: number;
  readonly roll: number;
}
```

<a id="script-type-spline-nearest-info"></a>
## `SplineNearestInfo`

```ts
/** The nearest place on a spline to a point. */
export interface SplineNearestInfo {
  /** Metres along the curve. */
  readonly distance: number;
  readonly position: readonly [number, number, number];
  /** Metres from the point to the curve. */
  readonly offset: number;
}
```

<a id="script-type-surface-info"></a>
## `SurfaceInfo`

```ts
/** The ground at a point as scripts see it. */
export interface SurfaceInfo {
  /** What answered: `'blocks'` (a block layer) or `'terrain'`, and that object's id. */
  readonly source: 'blocks' | 'terrain';
  readonly object: string;
  /** World height of the ground (metres), and the point on it. */
  readonly height: number;
  readonly point: readonly [number, number, number];
  /** Unit normal. */
  readonly normal: readonly [number, number, number];
  /** Degrees from level. */
  readonly slope: number;
  /** The material layers showing there, strongest first, and their weights (0–1, summing to 1). */
  readonly layers: readonly number[];
  readonly weights: readonly number[];
  /** Painted wetness 0–1 (block paint; 0 on terrain). */
  readonly wetness: number;
  /** On a block layer: the cell whose top it is (`ctx.grid.get`/`meta` read it) and its block type. */
  readonly cell?: readonly [number, number, number];
  readonly block?: string;
}
```

<a id="script-type-control-move-intent"></a>
## `ControlMoveIntent`

```ts
/**
 * `−1 ≤ value ≤ 1`, quantized at commit.
 * @graphNode Control move
 * @graphPhase intent
 */
export interface ControlMoveIntent {
  kind: 'control_move';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  value: number;
  /**
   * The move vector's second axis (forward, like a stick pushed up;
   * −1..1) — a 3D character walks along (value, y) as along the move input,
   * relative to the camera. Absent: 0.
   * @graphNode skip the node sets the move along one axis (scripts may pass y)
   */
  y?: number;
}
```

<a id="script-type-control-jump-intent"></a>
## `ControlJumpIntent`

```ts
/**
 * One `JumpPhase` value.
 * @graphNode Control jump
 * @graphPhase intent
 */
export interface ControlJumpIntent {
  kind: 'control_jump';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  value: JumpPhase;
}
```

<a id="script-type-transform-intent"></a>
## `TransformIntent`

```ts
/**
 * A position write on ONE owned entity axis set.
 * It may also set the rotation, as a `quaternion` or a `facing`
 * direction (fields in the order kind, entityId, position, quaternion, facing, up).
 * @graphNode Move object
 * @graphPhase transform
 */
export interface TransformIntent {
  kind: 'transform';
  entityId: string;
  position: { x?: number; y?: number; z?: number };
  /**
   * The rotation as a quaternion [x, y, z, w] (normalized when applied; not all zero).
   * One rotation form per intent.
   * @graphNode skip a quaternion is set by scripts; the node takes angles
   */
  quaternion?: readonly [number, number, number, number];
  /**
   * Turn the entity so its forward axis (+Z, the glTF forward) points along
   * this direction [x, y, z] (not all zero), its top towards `up`. One rotation form per intent.
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  facing?: readonly [number, number, number];
  /**
   * With `facing`, the direction the entity's top (+Y) leans towards
   * (default [0, 1, 0]; must not be parallel to `facing`).
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  up?: readonly [number, number, number];
}
```

<a id="script-type-pose-intent"></a>
## `PoseIntent`

```ts
/**
 * An owned entity's rotation (degrees: yaw about +Y,
 * pitch about +X, roll about +Z, applied yaw · pitch · roll; missing axes are
 * 0) and/or scale (one number, or [x, y, z]) — transform phase only, visual
 * (colliders keep their shape). Fields in the order kind, entityId,
 * rotation, scale; at least one of rotation and scale.
 * The rotation may instead be a `quaternion` or a `facing`
 * direction (order kind, entityId, rotation, quaternion, facing, up, scale;
 * exactly one of rotation, quaternion and facing when turning).
 * @graphNode Pose object
 * @graphPhase transform
 */
export interface PoseIntent {
  kind: 'pose';
  entityId: string;
  rotation?: { yaw?: number; pitch?: number; roll?: number };
  /**
   * The rotation as a quaternion [x, y, z, w] (normalized when applied; not all zero).
   * One rotation form per intent.
   * @graphNode skip a quaternion is set by scripts; the node takes angles
   */
  quaternion?: readonly [number, number, number, number];
  /**
   * Turn the entity so its forward axis (+Z, the glTF forward) points along
   * this direction [x, y, z] (not all zero), its top towards `up`. One rotation form per intent.
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  facing?: readonly [number, number, number];
  /**
   * With `facing`, the direction the entity's top (+Y) leans towards
   * (default [0, 1, 0]; must not be parallel to `facing`).
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  up?: readonly [number, number, number];
  scale?: number | [number, number, number];
}
```

<a id="script-type-respawn-intent"></a>
## `RespawnIntent`

```ts
/**
 * Kill the player (intent phase; ignored unless the run is playing).
 * @graphNode Respawn player
 * @graphPhase intent
 */
export interface RespawnIntent {
  kind: 'respawn';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
}
```

<a id="script-type-character-move-intent"></a>
## `CharacterMoveIntent`

```ts
/**
 * 3D projects: walk the player character this step along a
 * world direction on the ground (x, z; a length above 1 counts as 1 — its
 * length scales the walk speed), replacing the move input; `run` uses the run
 * speed. Intent phase.
 * @graphNode Walk character
 * @graphPhase intent
 */
export interface CharacterMoveIntent {
  kind: 'character_move';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  x: number;
  z: number;
  run?: boolean;
}
```

<a id="script-type-character-place-intent"></a>
## `CharacterPlaceIntent`

```ts
/**
 * Teleport the player character (its origin) to a point,
 * stopping its motion; it falls from there. Intent phase; it takes effect
 * before the controller runs in the same step. On the 2D plane
 * too (z is ignored there), with the placement of scene arrivals and
 * respawns (from rest: velocity and jump reset).
 * @graphNode Place character
 * @graphPhase intent
 */
export interface CharacterPlaceIntent {
  kind: 'character_place';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  /** Where its origin goes, [x, y, z] (m; on the 2D plane z is ignored). */
  position: readonly [number, number, number];
  /**
   * 3D projects: the way it faces once placed, in degrees about +Y (0 faces
   * +Z) — what `ctx.physics.characterState().facing` reads, so a saved facing
   * restores. Absent: it keeps facing as it was. The 2D plane ignores it.
   */
  facing?: number;
}
```

<a id="script-type-character-enable-intent"></a>
## `CharacterEnableIntent`

```ts
/**
 * 3D projects: switch the character controller off (the
 * character stays where it is: no input, no gravity — a cutscene or a
 * dialogue) or back on. Lasts until changed. Intent phase.
 * @graphNode Enable character
 * @graphPhase intent
 */
export interface CharacterEnableIntent {
  kind: 'character_enable';
  /**
   * The player controller it drives — its object's id (a game with several
   * player controllers; absent: the first, so a one-player game never names it).
   * @graphNode skip the node drives the first player controller (scripts may name another)
   */
  entityId?: string;
  enabled: boolean;
}
```

<a id="script-type-camera-blend-options"></a>
## `CameraBlendOptions`

```ts
/** A blend a script names for the camera change it makes (absent: the camera's own). */
export interface CameraBlendOptions {
  /** `cut`, `linear` or `eased`. */
  blend?: 'cut' | 'linear' | 'eased';
  /** Seconds (0–30). */
  time?: number;
}
```

<a id="script-type-behavior-camera-state"></a>
## `BehaviorCameraState`

```ts
/** A virtual camera's live rig values (`ctx.camera.get`). */
export interface BehaviorCameraState {
  readonly rig: 'follow' | 'orbitPoint' | 'topDown' | 'fixed' | 'rail';
  readonly enabled: boolean;
  readonly priority: number;
  /** It is the live camera. */
  readonly live: boolean;
  /** The target entity ('' for none). */
  readonly target: string;
  readonly distance: number;
  /** Degrees (a snapped rig: the step it turns to). */
  readonly yaw: number;
  readonly pitch: number;
  /** A rail camera's place along its path (0–1). */
  readonly progress: number;
  readonly railSpeed: number;
  readonly fovY: number;
  readonly letterbox: number;
}
```

<a id="script-type-save-meta"></a>
## `SaveMeta`

```ts
/** What a save shows in the slot list (`ctx.saves.save(slot, meta)`). */
export interface SaveMeta {
  /** A title for the slot (up to 128 characters). */
  title?: string;
  /** The chapter (up to 128 characters). */
  chapter?: string;
  /** The location (up to 128 characters). */
  location?: string;
  /** Keep a small picture of the view with the slot. */
  thumbnail?: boolean;
  /** The game's own fields for the slot card (at most 8 names → texts of up to 128 characters), returned by `slots()`. */
  meta?: Readonly<Record<string, string>>;
}
```

<a id="script-type-save-slot-info"></a>
## `SaveSlotInfo`

```ts
/** One used slot as the slot list shows it (`ctx.saves.slots()`). */
export interface SaveSlotInfo {
  /** The slot number (1 – the project's slot count). */
  readonly slot: number;
  /** The texts the game gave when it saved (empty when none). */
  readonly title: string;
  readonly chapter: string;
  readonly location: string;
  /** Play time in seconds when it was saved. */
  readonly playSeconds: number;
  /** When it was saved (ISO 8601, the player's clock). */
  readonly savedAt: string;
  /** The save document's schema version. */
  readonly version: number;
  /** The size of the stored document (bytes of JSON). */
  readonly bytes: number;
  /** Whether the slot has a picture of the view. */
  readonly thumbnail: boolean;
  /** The game's own fields the save gave (`meta`: names → texts within `SAVE_LIMITS.metaBytes`; {} when none). */
  readonly meta: Readonly<Record<string, string>>;
  /** Set when the stored slot cannot be read (it is never loaded). */
  readonly damaged?: string;
}
```

<a id="script-type-save-result"></a>
## `SaveResult`

```ts
/** The outcome of one save, load or delete, or a settings document storage refused (`ctx.saves.results()`). */
export interface SaveResult {
  readonly op: 'save' | 'load' | 'delete' | 'settings';
  /** The slot (0: a document given at the start, e.g. by `tl_play_start`, and the settings document). */
  readonly slot: number;
  readonly ok: boolean;
  /** Why it failed. */
  readonly reason?: string;
  /** Set when the player's storage refused it. */
  readonly code?: SaveStorageCode;
}
```

<a id="script-type-save-storage-info"></a>
## `SaveStorageInfo`

```ts
/**
 * The player's storage as the browser reports it (`ctx.saves.storage()`):
 * whether it keeps the game's data under disk pressure (asked for at the
 * first save), and the site's usage and quota in bytes. Null where unknown
 * (no storage manager, or not answered yet).
 */
export interface SaveStorageInfo {
  readonly persisted: boolean | null;
  readonly usage: number | null;
  readonly quota: number | null;
}
```

<a id="script-type-asset-handle-state"></a>
## `AssetHandleState`

```ts
/** A handle's state as a script reads it. */
export type AssetHandleState = 'loading' | 'ready' | 'failed';
```

<a id="script-type-behavior-ui-view"></a>
## `BehaviorUiView`

```ts
/** `ctx.ui.view()`: the view the UI is drawn over. */
export interface BehaviorUiView {
  /** CSS px. */
  readonly width: number;
  readonly height: number;
  /** width / height. */
  readonly aspect: number;
  /** Device pixels per CSS px. */
  readonly pixelRatio: number;
}
```

<a id="script-type-behavior-ui-event"></a>
## `BehaviorUiEvent`

```ts
/** One UI event of this step (from the input frame). */
export interface BehaviorUiEvent {
  /** click (a button's event action), submit (an input), focus (the focus moved to `widget`), custom, show, hide, toggle; mode (a mode action: `value` is the mode), restart (the engine's restart), scene (the game shell's move along its scene list: `value` is the entry), reload / load / unload (a scene engine action: `value` is the scene), hold (a shell screen holding play). */
  readonly kind: 'click' | 'submit' | 'focus' | 'custom' | 'show' | 'hide' | 'toggle' | 'mode' | 'restart' | 'scene' | 'reload' | 'load' | 'unload' | 'hold';
  /** The UI document it happened in. */
  readonly doc: string;
  /** The widget ('' for none). */
  readonly widget: string;
  /** The event name ('' for focus, show, hide). */
  readonly name: string;
  /** The value the action carried (or the submitted text). */
  readonly value?: number | string | boolean | null;
  /** The list item it came from. */
  readonly index?: number;
}
```

<a id="script-type-behavior-stats-time"></a>
## `BehaviorStatsTime`

```ts
/** A frame time over the stats window: the mean and the slowest frame, in ms. */
export interface BehaviorStatsTime {
  readonly avg: number;
  readonly worst: number;
}
```

<a id="script-type-dialogue-variable-value"></a>
## `DialogueVariableValue`

```ts
/** A value of a dialogue variable or binding. */
export type DialogueVariableValue = number | string | boolean | null;
```

<a id="script-type-behavior-dialogue-state"></a>
## `BehaviorDialogueState`

```ts
/** The conversation now. */
export interface BehaviorDialogueState {
  readonly conversation: number;
  readonly dialogueId: string;
  readonly nodeId: string;
  /** line, choice, signal (waiting for resume), wait. */
  readonly kind: 'line' | 'choice' | 'signal' | 'wait';
  readonly speaker: string;
  /** The line as shown (rich text; '' when not on a line). */
  readonly text: string;
  /** Visible characters of the line so far, and in all. */
  readonly revealed: number;
  readonly total: number;
  /** The options shown, in order (a choice), as their texts. */
  readonly options: readonly string[];
}
```

<a id="script-type-behavior-dialogue-event"></a>
## `BehaviorDialogueEvent`

```ts
/** One dialogue event (seen by scripts in the step after it happened). */
export interface BehaviorDialogueEvent {
  /** start, lineStart, lineEnd, choice (options shown), chosen, signal, end. */
  readonly kind: 'start' | 'lineStart' | 'lineEnd' | 'choice' | 'chosen' | 'signal' | 'end';
  /** The conversation (the number `start` returned). */
  readonly conversation: number;
  readonly dialogueId: string;
  /** The node (a line, a choice, a signal; '' for start/end). */
  readonly nodeId: string;
  /** lineStart: the speaker id ('' for narration). */
  readonly speaker: string;
  /** lineStart: the line as shown (rich text); chosen: the option's text. */
  readonly text: string;
  /** signal: its name; end: why (end, stopped, loop). */
  readonly name: string;
  /** signal: its value. */
  readonly value: string;
  /** chosen: the option's index among those shown; else -1. */
  readonly index: number;
}
```

<a id="script-type-behavior-dialogue-history-entry"></a>
## `BehaviorDialogueHistoryEntry`

```ts
/** One line (or a chosen option) in the backlog. */
export interface BehaviorDialogueHistoryEntry {
  readonly dialogueId: string;
  readonly nodeId: string;
  readonly speaker: string;
  /** The speaker's display name ('' for narration or a chosen option). */
  readonly name: string;
  readonly text: string;
  /** A line, or the option the player picked. */
  readonly choice: boolean;
}
```

<a id="script-type-behavior-mode-transition"></a>
## `BehaviorModeTransition`

```ts
/** How a switch looks (absent fields: the target mode's own transition, then the camera's blend). */
export interface BehaviorModeTransition {
  /** The camera blend into the mode's camera: cut, linear or eased. */
  blend?: 'cut' | 'linear' | 'eased';
  /** Seconds of the camera blend (0–30). */
  blendTime?: number;
  /** A UI document shown from the switch for `fadeTime` seconds (its show/hide tweens make the fade). */
  fade?: string;
  /** Seconds the fade document stays (0.05–10; default 0.5). */
  fadeTime?: number;
}
```

<a id="script-type-behavior-mode-event"></a>
## `BehaviorModeEvent`

```ts
/** One enter or exit of a game mode switch (`ctx.modes.events()`). */
export interface BehaviorModeEvent {
  /** enter (the mode became current) or exit (it ended). */
  readonly kind: 'enter' | 'exit';
  /** The mode entered or left. */
  readonly mode: string;
  /** The mode on the other side of the switch ('' at a run start). */
  readonly other: string;
}
```

<a id="script-type-behavior-timeline-event"></a>
## `BehaviorTimelineEvent`

```ts
/** One timeline event (seen in the step after it happened). */
export interface BehaviorTimelineEvent {
  /** started, ended or marker (a marker of the timeline was reached). */
  readonly kind: 'started' | 'ended' | 'marker';
  readonly handle: number;
  /** The timeline's id. */
  readonly timeline: string;
  /** marker: its name ('' otherwise). */
  readonly name: string;
  /** ended: finished, skipped or stopped ('' otherwise). */
  readonly reason: '' | 'finished' | 'skipped' | 'stopped';
  readonly stepIndex: number;
}
```

<a id="script-type-environment-change-options"></a>
## `EnvironmentChangeOptions`

```ts
/** How a change to an environment preset happens (`ctx.environment.set`). */
export interface EnvironmentChangeOptions {
  /** Seconds the blend takes (0–600; 0 or absent: at once). */
  blend?: number;
  /** How the blend progresses. */
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
  /** Per-field changes over the preset: { sky?, fog?, post?, lights?, lightmap? }, each merged over the preset's (a light list adds entries). */
  override?: { readonly [part: string]: unknown };
}
```

<a id="script-type-entity-write-result"></a>
## `EntityWriteResult`

```ts
/** What `set` answers: queued (`ok`), or refused with the field and why. */
export interface EntityWriteResult {
  readonly ok: boolean;
  /** The refused field (`light.type`), or the component ('' when queued). */
  readonly field: string;
  /** Why it was refused ('' when queued). */
  readonly code: EntityWriteCode | '';
  readonly message: string;
}
```

<a id="script-type-ui-event-kind"></a>
## `UiEventKind`

```ts
/** What a UI event is. */
export type UiEventKind = 'click' | 'submit' | 'focus' | 'custom' | 'show' | 'hide' | 'toggle' | 'mode' | 'restart' | 'scene' | 'reload' | 'load' | 'unload' | 'hold';
```

<a id="script-type-declared-property"></a>
## `DeclaredProperty`

```ts
export interface DeclaredProperty {
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

<a id="script-type-debug-command-arg"></a>
## `DebugCommandArg`

```ts
export type DebugCommandArg = number | string | boolean;
```

<a id="script-type-save-storage-code"></a>
## `SaveStorageCode`

```ts
export type SaveStorageCode = (typeof SAVE_STORAGE_CODES)[number];
```

<a id="script-type-project-save-file"></a>
## `ProjectSaveFile`

```ts
/** A stored save document (the whole body of a slot; also what `tl_play_start` accepts as `save`). */
export interface ProjectSaveFile {
  readonly format: 'thirdlight.save';
  readonly formatVersion?: number;
  /** The project document's schema version. */
  readonly version: number;
  readonly playSeconds?: number;
  /** The project's own document. */
  readonly doc: unknown;
  /** Engine state the schema opts into. */
  readonly sections?: Readonly<Partial<Record<SaveSection, unknown>>>;
  /** Format version 2: where the play stands (absent when the game that saved it does not keep it). */
  readonly world?: WorldSave;
}
```

<a id="script-type-dialogue-input-kind"></a>
## `DialogueInputKind`

```ts
export type DialogueInputKind = 'advance' | 'choose' | 'skip' | 'auto' | 'backlog';
```

<a id="script-type-physics-vec3"></a>
## `PhysicsVec3`

```ts
/** A 3D vector (m). */
export interface PhysicsVec3 {
  x: number;
  y: number;
  z: number;
}
```

<a id="script-type-gamepad-family"></a>
## `GamepadFamily`

```ts
/** The gamepad families glyphs distinguish (from the pad's id; `generic` when unknown). */
export type GamepadFamily = 'xbox' | 'playstation' | 'switch' | 'generic';
```

<a id="script-type-input-binding-status"></a>
## `InputBindingStatus`

```ts
/** One binding of an action as scripts see it (its position in `bindings` is the index rebinding addresses). */
export interface InputBindingStatus extends InputGlyph {
  readonly device: InputBindingDevice;
  /** The binding kind (key, gamepadButton, keys1d, pointerButton, …). */
  readonly kind: string;
  /** Hold instead of tap: seconds the binding must be held. */
  readonly hold?: number;
}
```

<a id="script-type-input-glyph-part"></a>
## `InputGlyphPart`

```ts
/** One part of a composite binding's glyph. */
export interface InputGlyphPart {
  readonly part: InputBindingPart;
  readonly label: string;
  readonly icon: string;
  /** The project's own image (a texture asset id), when it overrides the icon. */
  readonly image?: string;
}
```

<a id="script-type-input-binding-part"></a>
## `InputBindingPart`

```ts
/** A composite binding's part (two keys/buttons: negative, positive; four keys: up, down, left, right). */
export type InputBindingPart = 'negative' | 'positive' | 'up' | 'down' | 'left' | 'right';
```

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
 * none) and the character (the controller's object) with its velocity (m/s;
 * z is 0 on the 2D plane) and, in 3D, the way it faces (degrees about +Y, as
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
